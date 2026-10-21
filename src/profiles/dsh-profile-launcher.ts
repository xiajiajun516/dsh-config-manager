/**
 * DSH profile「启动器」—— 把所选档案作为**独立 DSH 实例**拉起来（引擎层，node）。
 *
 * 为什么必须有这一层（真机复现的根因）：DSH **没有**「默认 / 下次启动 profile」这种状态 ——
 * profile 只由启动参数决定（`dsh <名>` / `--profile <名>`，`dsh web` 是硬编码别名，
 * `apps/cli/src/args.ts` 里 `--profile` 缺省直接报错退出）。所以插件写的
 * `<dataDir>/next-profile` 标记**没有任何消费者**：用户自己敲的 `dsh web` 重启后当然还是 web
 * （真机：设 PROVA 为下次启动 → 重启仍进 web，标记文件里躺着 PROVA）。
 * 生态里的做法同样如此（dsh-profile-manager 的 `dshm start`、DSH Launcher 的桌面启动器），
 * 都是「由启动器 spawn 一个实例」；本模块把这件事做进插件：
 * web 形态档案 → detached 子进程 + 自动挑空闲端口 + 从启动日志里抓认证 URL + HTTP 探活。
 * 子进程必须**直启**（node/Electron-as-node 跑 `bin.js`）：Windows 上经 `.cmd` 包装脚本
 * （`shell: true` 或中间 cmd 层）再 `detached: true` 会丢掉孙进程的 stdout/stderr，
 * 日志文件恒 0 字节 ⇒ 永远抓不到 `dsh web: <带 token 的 URL>`（真机实测，见 findCliEntryForShim）。
 *
 * 设计约束：
 *  - 只消费 DSH 的稳定表面（启动参数 + 启动日志里的 `dsh web:` 行），不 import 任何
 *    @deepseek-ai 内部包；
 *  - 只启动 **web 形态**（bundles 含 `@deepseek-ai/dsh-web-app`）：其余形态没有浏览器 GUI，
 *    擅自 spawn 只会得到一个看不见的进程（base 模板档案即此类）→ 直接以 `notLaunchable` 拒绝，
 *    由 UI 给出终端命令 `dsh --profile <名>`；
 *  - **绝不静默成功**：抓不到 URL / 探活没就绪 / 子进程早退 → warnings 或 launchFailed + 日志路径，
 *    用户永远能顺着日志看到真实原因。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import { resolveDesktopCarrier } from '../utils/desktop-carrier.ts'
import { isRecord } from '../utils/guards.ts'
import { DshProfileError } from './dsh-profile-manager.ts'
import { readTextSafe, sanitizeFilePart } from './dsh-profile-io.ts'
import { profilesMsg } from './messages.ts'
import { resolveProcessControl, stopPid, type ResolvedProcessControl } from './process-control.ts'
import {
  DSH_PROFILE_LAUNCH_TIMEOUT_MS, isLaunchableShape, isManagedProfileName,
  type DshProfileLaunchRecord, type DshProfileLaunchResult, type DshProfileLaunchWarning, type DshProfileShape,
  type DshProfileStopOutcome,
} from './dsh-profile-shared.ts'

/** DSH CLI 的调用形态：node 直启 bin.js，或 PATH 上的 dsh 包装脚本（.cmd 需要 shell）。 */
export interface DshCliCommand {
  /** 可执行文件（node.exe 或 dsh.cmd/dsh） */
  command: string
  /** 固定前置参数（node 形态 = [bin.js 绝对路径]；包装脚本形态 = []） */
  prefixArgs: string[]
  /** 是否经 shell（Windows 的 .cmd/.bat 在 Node ≥ 22 必须经 shell，否则 EINVAL） */
  shell: boolean
  /** 需要额外/覆写的子进程环境（Desktop 载体要 ELECTRON_RUN_AS_NODE=1）；缺省只继承。 */
  env?: Readonly<Record<string, string>>
}

/** 启动器可注入的副作用（测试 / 隔离验证用；缺省即真实实现）。 */
export interface DshProfileLauncherDeps {
  /** 定位 dsh CLI（缺省：按本进程 argv/进程树推断，见 defaultResolveCli） */
  resolveCli?: () => DshCliCommand | null
  /** detached spawn + 输出重定向到日志文件；返回 pid 与「退出通知」注册口 */
  spawnDetached?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; shell: boolean }) => { pid: number | null; onExit: (cb: (code: number | null) => void) => void }
  /** 挑一个空闲端口（缺省：先试候选段，全占用则用系统临时端口） */
  findFreePort?: (candidates: number[]) => Promise<number>
  /** HTTP 探活（任何 HTTP 响应都算「起来了」，含 401） */
  probe?: (port: number, timeoutMs: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  readLog?: (file: string) => string
  now?: () => number
  /** pid 是否存活（缺省 process.kill(pid, 0)；EPERM 视为存活） */
  isAlivePid?: (pid: number) => boolean
  /** 终止进程（缺省：Windows 用 taskkill /T [/F]，其余平台 SIGTERM/SIGKILL） */
  killPid?: (pid: number, mode: 'graceful' | 'force') => void
  /** 写 / 读实例记录（缺省落 <dataDir>/launches.json；测试注入内存实现） */
  readState?: () => string
  writeState?: (text: string) => void
  /**
   * 该档案是否**在别处**已经在跑（宿主注入运行注册表的心跳判据）。
   * 为什么必须有：只认台账时，手动 `dsh web` 起来的实例对插件不可见 → 同一个 profile 会被反复拉起。
   */
  isProfileRunning?: (name: string) => boolean
}


/** 实例记录文件名（`<dataDir>/launches.json`；机器本地状态，**不进备份/同步**）。 */
export const LAUNCHES_FILENAME = 'launches.json'

/** 停止结果（UI 只做展示差异；三种都算「已经不在了」）。 */
export interface DshProfileStopResult {
  name: string
  /** graceful = 自己退了 / killed = 强制杀掉 / already-stopped = 早就没了（残留记录已清） */
  result: DshProfileStopOutcome
  /** 当时的端口（记录里有才有，仅用于回执文案） */
  port?: number
}

export interface DshProfileLauncherOptions {
  /** DSH home（`$DSH_HOME`；子进程显式继承同一 home） */
  homeDir: string
  /** 插件 dataDir（日志落在 <dataDir>/logs/） */
  dataDir: string
  /** 子进程工作目录（缺省 = 宿主进程 cwd，即用户启动 DSH 时所在的 workspace 根） */
  cwd?: string
  deps?: DshProfileLauncherDeps
}

export interface DshProfileLaunchInput {
  name: string
  shape: DshProfileShape
  /** 显式端口（缺省自动挑空闲端口） */
  port?: number
  /** 追加给应用的参数（如 --no-open；验证脚本会用） */
  extraArgs?: string[]
  /** 是否让新实例自己拉起默认浏览器（缺省 true —— 用户点「启动」就应看到新 GUI） */
  openBrowser?: boolean
  /** 等待就绪的上限（缺省 20s） */
  readyTimeoutMs?: number
}

/** 端口候选段：默认端口 3080 之后依次试（当前实例通常占着 3080）。 */
export function pickFreePortCandidates(base = 3080, count = 40): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i += 1) out.push(base + i)
  return out
}

/** 拼启动参数（纯函数）：`--profile <名> [--port <端口>] [--no-open] [extra]`。 */
export function buildLaunchArgs(cli: Pick<DshCliCommand, 'prefixArgs'>, input: { name: string; port?: number; extraArgs?: string[]; openBrowser?: boolean }): string[] {
  const args = [...cli.prefixArgs, '--profile', input.name]
  if (input.port !== undefined) args.push('--port', String(input.port))
  if (input.openBrowser === false) args.push('--no-open')
  if (input.extraArgs !== undefined) args.push(...input.extraArgs)
  return args
}

/**
 * 从子进程日志里抓认证 URL（`dsh web: http://127.0.0.1:<port>/?token=...`）。
 * 只认带 token 的根 URL：无 token 的裸 URL 打开会 401，报给用户等于给了一条坏链接。
 */
export function parseLaunchUrl(logText: string, port?: number): string | null {
  const candidates = [...logText.matchAll(/dsh web:\s+(https?:\/\/[^\s]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((u) => u.includes('token='))
  if (candidates.length === 0) return null
  if (port !== undefined) {
    const forPort = candidates.find((u) => u.includes(`://127.0.0.1:${String(port)}/`) || u.includes(`://localhost:${String(port)}/`))
    if (forPort !== undefined) return forPort
  }
  return candidates[0] ?? null
}

/** 日志尾部（失败时回传给用户，避免「启动失败」四个字之外什么都没有）。 */
export function logTail(logText: string, lines = 12): string {
  return logText.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines).join('\n')
}

/**
 * 缺省 CLI 定位：宿主进程就是 dsh 启动的，`process.argv[1]` 即 `.../@deepseek-ai/dsh/lib/bin.js`。
 * 校验同目录两级上的 package.json 名字，避免把任意 bin.js 当成 dsh。
 * 推断不出来（如源码树 tsx 直启 / Electron）时回退 PATH 上的 dsh（.cmd 走 shell）。
 */
export function defaultResolveCli(): DshCliCommand | null {
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.endsWith('bin.js') && isDshBinPath(argv1)) {
    return { command: process.execPath, prefixArgs: [argv1], shell: false }
  }
  const fromPath = findOnPath(['dsh.cmd', 'dsh.exe', 'dsh'])
  if (fromPath === null) {
    // Desktop 兜底：**只装了桌面端**的机器 PATH 上没有 dsh，此前一律 launcherUnavailable
    // （功能直接不可用）。桌面端自带的 @deepseek-ai/dsh-desktop-host/lib/cli.js 本身就是一条
    // 完整的普通 CLI（用桌面端内置 runtime + 内置 pnpm），可以拉起任意档案。
    // 顺序说明：PATH 上的 dsh 仍然优先 —— 各档案的 node_modules 就是那份 dsh 装的，
    // 用同一份启动最不容易踩版本混用。
    const carrier = resolveDesktopCarrier()
    if (carrier !== null) {
      return { command: carrier.execPath, prefixArgs: [carrier.cliPath], shell: false, env: carrier.env }
    }
    return null
  }
  const needsShell = /\.(cmd|bat)$/i.test(fromPath)
  // Windows 的 .cmd/.bat 只能经 shell 起，而「中间 cmd 层 + detached」会吞掉孙进程的
  // stdio（日志恒 0 字节 ⇒ 永远抓不到带 token 的 URL）。能反解出真入口就直接跑，
  // 只有反解不出来时才退回包装脚本（那时日志里没有 URL，UI 会如实报 urlNotFound）。
  if (needsShell) {
    const entry = findCliEntryForShim(fromPath)
    if (entry !== null) {
      const runner = resolveDirectCliRunner()
      return { command: runner.command, prefixArgs: [entry], shell: false, env: runner.env }
    }
  }
  return { command: fromPath, prefixArgs: [], shell: needsShell }
}

/** bin.js 是否属于 @deepseek-ai/dsh（读上一级的 package.json.name）。 */
function isDshBinPath(binPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(binPath)), 'package.json'), 'utf8')) as { name?: unknown }
    return manifest.name === '@deepseek-ai/dsh'
  } catch {
    return false
  }
}

/** PATH 查找（Windows 补 PATHEXT 形态）。 */
function findOnPath(names: readonly string[]): string | null {
  const raw = process.env['PATH'] ?? ''
  for (const dir of raw.split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.trim() === '') continue
    for (const name of names) {
      const candidate = join(dir.trim(), name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 直启 bin.js 用的运行时：宿主是 Electron 时必须以 `ELECTRON_RUN_AS_NODE=1` 当 node 用
 * （桌面端宿主 `process.execPath` 是 DeepSeek Harness.exe，真机实测可正常跑 CLI）。
 */
export function resolveDirectCliRunner(versions: Readonly<Record<string, string | undefined>> = process.versions): { command: string; env?: Readonly<Record<string, string>> } {
  if (versions['electron'] !== undefined) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { command: process.execPath }
}

/**
 * 从 PATH 上的 dsh 包装脚本反解真正的 CLI 入口（`.../@deepseek-ai/dsh/lib/bin.js`）。
 *
 * 为什么必须反解（真机实测根因）：Windows 上 `.cmd/.bat` 只能经 shell 起，而
 * **中间 cmd 层 + `detached: true` 会丢掉孙进程的 stdout/stderr** ——
 * `dsh.cmd --version` 经 detached 起时日志恒 0 字节（非 detached 正常），
 * 于是启动器永远读不到 `dsh web: <带 token 的 URL>` 那行，用户只看到
 * 「20 秒内未确认就绪 / 没能抓到带 token 的 URL」。直启 bin.js 则正常（约 8 秒出 URL）。
 *
 * 先按 npm/pnpm 的常见布局找同目录 `node_modules`，再退回脚本内嵌的入口路径。
 */
export function findCliEntryForShim(shimPath: string): string | null {
  const dir = dirname(shimPath)
  const candidates = [
    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),      // npm 全局前缀（dsh.cmd 同目录）
    join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), // <prefix>/bin/dsh.cmd
    join(dir, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),                // pnpm <store>/.bin/dsh.cmd
  ]
  for (const candidate of candidates) {
    if (isDshBinPath(candidate)) return candidate
  }
  const text = readTextSafe(shimPath)
  if (text === null) return null
  // 脚本内嵌路径可能是相对当前目录的（`%dp0%\node_modules\…`）也可能是 `..\node_modules\…`，
  // 故把可选的前导相对段一起抓下来，再按 shim 所在目录解析。
  const embedded = /(?:\.\.[\\/]|[.][\\/])?node_modules[\\/]+@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js/iu.exec(text)
  if (embedded === null) return null
  const resolved = join(dir, embedded[0])
  return isDshBinPath(resolved) ? resolved : null
}

/** 档案 → 是否可启动（唯一判据在 shared，UI 与本模块共用）。 */
export { isLaunchableShape }

/** 档案启动器（每个实例无状态，可直接复用）。 */
export class DshProfileLauncher {
  private readonly homeDir: string
  private readonly dataDir: string
  private readonly cwd: string
  private readonly proc: ResolvedProcessControl
  private readonly deps: Required<DshProfileLauncherDeps>

  constructor(options: DshProfileLauncherOptions) {
    this.homeDir = options.homeDir
    this.dataDir = options.dataDir
    this.cwd = options.cwd ?? process.cwd()
    const deps = options.deps ?? {}
    // 进程控制走共享内核（存活判定/终止/优雅期只有一份实现，见 process-control.ts）
    this.proc = resolveProcessControl(deps)
    this.deps = {
      resolveCli: deps.resolveCli ?? defaultResolveCli,
      spawnDetached: deps.spawnDetached ?? defaultSpawnDetached,
      findFreePort: deps.findFreePort ?? defaultFindFreePort,
      probe: deps.probe ?? defaultProbe,
      sleep: deps.sleep ?? ((ms) => delay(ms)),
      readLog: deps.readLog ?? ((file) => readTextSafe(file) ?? ''),
      now: deps.now ?? (() => Date.now()),
      isAlivePid: this.proc.isAlivePid,
      killPid: this.proc.killPid,
      readState: deps.readState ?? (() => readTextSafe(this.stateFile()) ?? ''),
      writeState: deps.writeState ?? ((text) => { saveStateFile(this.stateFile(), text) }),
      isProfileRunning: deps.isProfileRunning ?? (() => false),
    }
  }

  /** 实例记录文件绝对路径（`<dataDir>/launches.json`） */
  stateFile(): string {
    return join(this.dataDir, LAUNCHES_FILENAME)
  }

  /**
   * 本插件启动且**仍在运行**的实例（同步；死记录顺手清掉）。
   * 判据只认「记录里的 pid 还活着」——记录本身就是启动方写下的权威事实，不猜别的进程。
   */
  listRunning(): DshProfileLaunchRecord[] {
    const records = parseLaunches(this.deps.readState())
    const alive = records.filter((r) => this.deps.isAlivePid(r.pid))
    if (alive.length !== records.length) this.deps.writeState(serializeLaunches(alive))
    return alive
  }

  /**
   * 停止某个档案的实例：先请它自己退出（优雅期 PROFILE_STOP_GRACE_MS），超时再强制杀进程树。
   * 记录在结束后一律清掉（无论 graceful/killed/already-stopped）——「已经不在了」是唯一终态。
   */
  async stop(name: string): Promise<DshProfileStopResult> {
    const records = parseLaunches(this.deps.readState())
    const record = records.find((r) => r.name === name)
    if (record === undefined) throw new DshProfileError('notRunning')
    const rest = records.filter((r) => r.name !== name)
    const outcome = await stopPid(record.pid, this.proc)
    if (outcome === 'failed') {
      throw new DshProfileError('stopFailed', profilesMsg('profiles.stopFailed', { pid: record.pid }))
    }
    this.deps.writeState(serializeLaunches(rest))
    return { name, result: outcome, port: record.port }
  }

  /** 子进程日志目录（`<dataDir>/logs`） */
  logsDir(): string {
    return join(this.dataDir, 'logs')
  }

  /** 能否定位 dsh CLI（UI 可据此提前给出「手动启动」提示）。 */
  resolveCli(): DshCliCommand | null {
    return this.deps.resolveCli()
  }

  /**
   * 启动所选档案的独立实例。
   *
   * 失败语义（都带码，UI 映射本地化文案）：
   *  - `notLaunchable`：非 web 形态（没有浏览器 GUI 的档案 spawn 出来只会是隐形进程）；
   *  - `launcherUnavailable`：定位不到 dsh CLI（源码树/Electron 等非标准启动）；
   *  - `launchFailed`：子进程早退或没拿到 pid（消息里附日志尾部，绝不只说「失败」）；
   *  - `alreadyRunning`：同名实例还活着（台账里有，**或心跳表明别处/手动启动的实例在跑**）——
    不允许同名多开，否则 UI 的「停止」指向哪一个都说不清，浏览器里也会出现两个同 home 的实例。
   */
  async launch(input: DshProfileLaunchInput): Promise<DshProfileLaunchResult> {
    // Desktop 独占档案：普通 dsh CLI 对它直接报 'profile "desktop" is managed
    // exclusively by the Electron application' 并退出 —— 走 launchFailed 只会把用户
    // 推给一条看不懂的错误。这里直接以 managedProfile 拒绝，并说明该去哪开。
    if (isManagedProfileName(input.name)) throw new DshProfileError('managedProfile')
    if (!isLaunchableShape(input.shape)) throw new DshProfileError('notLaunchable')
    if (this.listRunning().some((r) => r.name === input.name)) throw new DshProfileError('alreadyRunning')
    if (this.deps.isProfileRunning(input.name)) throw new DshProfileError('alreadyRunning')
    const cli = this.deps.resolveCli()
    if (cli === null) throw new DshProfileError('launcherUnavailable')

    const port = input.port ?? await this.deps.findFreePort(pickFreePortCandidates())
    mkdirSync(this.logsDir(), { recursive: true })
    const logFile = join(this.logsDir(), `launch-${sanitizeFilePart(input.name)}-${String(port)}.log`)
    const args = buildLaunchArgs(cli, {
      name: input.name,
      port,
      openBrowser: input.openBrowser,
      extraArgs: input.extraArgs,
    })

    let exited: number | null | undefined
    const child = this.deps.spawnDetached(cli.command, args, {
      cwd: this.cwd,
      // cli.env 必须能覆写（Desktop 载体：ELECTRON_RUN_AS_NODE=1）；DSH_HOME 恒为最后一项
      env: { ...process.env, ...cli.env, DSH_HOME: this.homeDir },
      logFile,
      shell: cli.shell,
    })
    if (child.pid === null) {
      const tail = logTail(this.deps.readLog(logFile))
      throw new DshProfileError('launchFailed', tail === '' ? 'launchFailed' : `launchFailed: ${tail}`)
    }
    child.onExit((code) => { exited = code })

    const timeoutMs = input.readyTimeoutMs ?? DSH_PROFILE_LAUNCH_TIMEOUT_MS
    const deadline = this.deps.now() + timeoutMs
    let url: string | null = null
    let ready = false
    while (this.deps.now() < deadline) {
      url ??= parseLaunchUrl(this.deps.readLog(logFile), port)
      if (!ready) ready = await this.deps.probe(port, 1_500)
      if (ready && url !== null) break
      if (exited !== undefined) break
      await this.deps.sleep(250)
    }

    if (!ready && exited !== undefined) {
      const tail = logTail(this.deps.readLog(logFile))
      throw new DshProfileError('launchFailed', tail === '' ? 'launchFailed' : `launchFailed: ${tail}`)
    }

    const warnings: DshProfileLaunchWarning[] = []
    if (!ready) warnings.push('notReady')
    if (url === null) warnings.push('urlNotFound')
    // 无 mutation gate 后，双击/并发请求可能越过上面的前置检查（两个都看到「没在跑」）。
    // 就绪后再查一次：若台账里已有**另一个活实例**，把自己这个刚起的杀掉并如实报 alreadyRunning——
    // 宁可失败也不要留下一个没人记录的隐形实例。
    const duplicate = this.listRunning().find((r) => r.name === input.name && r.pid !== child.pid)
    if (duplicate !== undefined) {
      this.deps.killPid(child.pid, 'force')
      throw new DshProfileError('alreadyRunning')
    }
    // 就绪与否都登记：进程已经起来了，用户必须能在 UI 里看到并停止它（绝不留下「看不见的实例」）
    this.recordRunning({
      name: input.name, port, pid: child.pid, url, logFile,
      startedAt: new Date(this.deps.now()).toISOString(),
    })
    return { name: input.name, mode: 'web', port, url, pid: child.pid, logFile, ready, warnings }
  }

  /** 写入 / 覆盖一个实例记录（同名先移除旧的）。 */
  private recordRunning(record: DshProfileLaunchRecord): void {
    const rest = parseLaunches(this.deps.readState()).filter((r) => r.name !== record.name)
    this.deps.writeState(serializeLaunches([...rest, record]))
  }
}

/** 容错解析实例记录（坏 JSON / 非数组 / 字段缺失 → 只保留可信条目，绝不抛）。 */
export function parseLaunches(text: string): DshProfileLaunchRecord[] {
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed['launches']) ? parsed['launches'] : null)
  if (rows === null) return []
  const out: DshProfileLaunchRecord[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const { name, port, pid, url, logFile, startedAt } = row
    if (typeof name !== 'string' || name === '') continue
    if (typeof port !== 'number' || !Number.isInteger(port)) continue
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    out.push({
      name,
      port,
      pid,
      url: typeof url === 'string' ? url : null,
      logFile: typeof logFile === 'string' ? logFile : '',
      startedAt: typeof startedAt === 'string' ? startedAt : '',
    })
  }
  return out
}

/** 序列化实例记录（稳定顺序：按档案名，避免无意义 diff）。 */
export function serializeLaunches(records: readonly DshProfileLaunchRecord[]): string {
  const sorted = [...records].sort((a, b) => a.name.localeCompare(b.name))
  return `${JSON.stringify({ schemaVersion: 1, launches: sorted }, null, 2)}\n`
}

/** 原子落盘（先写临时文件再 rename；半截 JSON 会让「运行中」判定失真）。 */
function saveStateFile(file: string, text: string): void {
  atomicWriteFileSync(file, text, { mode: 0o644 })
}

/** 真实 spawn：detached + stdout/stderr 全进日志文件（与 dshm/DSHgo 同一做法）。 */
function defaultSpawnDetached(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; shell: boolean }): { pid: number | null; onExit: (cb: (code: number | null) => void) => void } {
  mkdirSync(dirname(opts.logFile), { recursive: true })
  const fd = openSync(opts.logFile, 'a')
  try {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      windowsHide: true,
      shell: opts.shell,
      stdio: ['ignore', fd, fd],
    })
    child.on('error', () => { /* 早退由 onExit/pid 缺失路径统一处理 */ })
    child.unref()
    const pid = typeof child.pid === 'number' ? child.pid : null
    return {
      pid,
      onExit: (cb) => { child.on('exit', (code) => { cb(code) }) },
    }
  } finally {
    // 子进程已持有自己的 fd 副本；父进程必须关掉自己的，否则 detached 子进程会让文件句柄悬着
    closeSync(fd)
  }
}

/** 真实探活：任何 HTTP 响应（含 401）都算「Web 服务在听」。 */
async function defaultProbe(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => { resolve(false) })
  })
}

/** 真实挑端口：先试候选段（好看 + 稳定），全被占则交给系统分配临时端口。 */
async function defaultFindFreePort(candidates: readonly number[]): Promise<number> {
  for (const candidate of candidates) {
    if (await canBind(candidate)) return candidate
  }
  const ephemeral = await bindEphemeral()
  if (ephemeral !== null) return ephemeral
  throw new DshProfileError('launchFailed', 'launchFailed: no free port')
}

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => { resolve(true) })
    })
  })
}

async function bindEphemeral(): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(null) })
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => { resolve(port) })
    })
  })
}
