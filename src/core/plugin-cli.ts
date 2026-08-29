/**
 * dsh plugin CLI 通道（方案A 主机侧实现，M1）。
 *
 * 本模块是唯一的子进程启动点：把「安装 / 更新 profile 插件」转成官方
 * `dsh plugin --profile <name> <args…>` 调用（dsh CLI 内部转发 pnpm，并在
 * 成功后 reconcile dsh.profile.bundles），以及从 profile 文件实时读取已装
 * 插件清单（不依赖 web 专用 pluginMarketplace / pluginInventory 服务）。
 *
 * 设计对齐：
 *  - dsh 官方实现 @deepseek-ai/dsh/lib/plugin-*.js（runPlugin / reconcilePlugins /
 *    exportsPatch 的 bundle 判定语义）；
 *  - dshmarket src/dsh-cli.ts（dshArgv / spawnShim / killTree / spawnEnv）与
 *    src/profile.ts（readInstalled / readInstalledVersion / hasDshManifest）。
 *
 * 只依赖 node 内置模块，零 DSH 运行时依赖（M5 的 TDD 可直接单测本模块）。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import type { PluginInfo } from './types.ts'

/* ------------------------------------------------------------ profile 文件 */

/**
 * dsh 出厂自带的 in-box bundle（profile 模板自身安装的层）：唯一从「已装
 * 插件清单」中隐藏的名字。社区插件可以合法地发布在官方 scope 下，因此不能
 * 按 scope 整段过滤（dshmarket #28 的结论）。
 */
export const INBOX_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/**
 * profile 名合法性校验，与 dsh-app-boot 的 resolveProfileDir 一致：拒绝空名、
 * 路径分隔符与保留名，防止 join(home, 'profiles', name) 越界。
 */
export function validateProfileName(profile: string): string {
  if (
    profile === ''
    || profile.includes('/') || profile.includes('\\')
    || profile === '.' || profile === '..' || profile === 'node_modules'
  ) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
  return profile
}

/** Profile 目录：$DSH_HOME/profiles/<name>（homeDir 由宿主 resolveDshHome() 解析）。 */
export function resolveProfileDir(homeDir: string, profile: string): string {
  return join(homeDir, 'profiles', validateProfileName(profile))
}

/**
 * 从启动参数解析 profile 名：`--profile <name>` → 缺省 'web'。与宿主 apply 时的
 * resolveProfileName 同源（config 覆盖仅 apply 处有；报告/适配器场景用本函数即可）。
 * argv 参数化便于测试；缺省读当前进程 argv。
 * 宽容语义：缺值 / 值以 '-' 开头 / 校验非法 → 一律回退 'web'。消息构建路径
 * （applyItem 失败分支、补行等）绝不允许因 profile 名抛错破坏非致命 warning；
 * 且 launcher 在启动时已拒绝非法 profile，此分支实际不可达。
 */
export function resolveProfileNameFromArgv(argv: readonly string[] = process.argv.slice(2)): string {
  const at = argv.indexOf('--profile')
  if (at === -1) return 'web'
  const value = argv[at + 1]
  if (value === undefined || value === '' || value.startsWith('-')) return 'web'
  try {
    return validateProfileName(value)
  } catch {
    return 'web'
  }
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** 读 profile package.json；不可读（未初始化 / 损坏）返回 null。 */
export function readProfileManifest(profileDir: string): ProfileManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProfileManifest : null
  } catch {
    return null
  }
}

/** 写回 profile package.json（2 空格缩进 + 尾换行，与 dsh-app-boot 一致；原子写防半装损坏）。 */
export function writeProfileManifest(profileDir: string, manifest: ProfileManifest): void {
  atomicWriteFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
}

/** 真实已装的依赖（in-box bundles 过滤掉）：name → 声明的版本 spec。 */
export function readInstalled(profileDir: string): Record<string, string> {
  const manifest = readProfileManifest(profileDir)
  const installed: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest?.dependencies ?? {})) {
    if (!INBOX_BUNDLES.has(name)) installed[name] = spec
  }
  return installed
}

/** node_modules/<name>/package.json 里实际落盘的版本；未装 / 不可读为 null。 */
export function readInstalledVersion(profileDir: string, name: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  }
}

/** 包的 package.json 是否声明 dsh.bundle.patch（即它是一个 bundle / profile 层）。 */
export function hasDshBundlePatch(pkgDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * 维护 dsh.profile.bundles 与已装依赖一致（语义对齐官方 plugin 命令的
 * reconcilePlugins，按「已装状态」而非依赖 diff 判定）：
 *  - 声明 dsh.bundle.patch 的依赖必须出现在 bundles（追加在依赖顺序尾部）；
 *  - bundles 中「曾是依赖、但不再是（移除或版本不再声明 patch）」的条目移出；
 *  - in-box bundles 不是依赖，永远不碰。
 * 仅在确有变化时写回 package.json。返回是否写回。
 */
export function reconcileBundles(profileDir: string): boolean {
  const manifest = readProfileManifest(profileDir)
  if (manifest === null) return false
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const dependencySet = new Set(dependencies)
  const bundles = manifest.dsh?.profile?.bundles
  const plugins = Array.isArray(bundles) ? [...bundles] : []
  let changed = false

  for (const name of dependencies) {
    if (INBOX_BUNDLES.has(name)) continue
    const isBundle = hasDshBundlePatch(join(profileDir, 'node_modules', name))
    if (isBundle && !plugins.includes(name)) {
      plugins.push(name)
      changed = true
    }
  }
  for (const name of [...plugins]) {
    const wasDependency = dependencySet.has(name)
    const stillBundle = dependencySet.has(name) && hasDshBundlePatch(join(profileDir, 'node_modules', name))
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(name), 1)
      changed = true
    }
  }
  if (!changed) return false
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: plugins },
  }
  writeProfileManifest(profileDir, manifest)
  return true
}

/**
 * 中止安装后清理半装状态（用户「跳过当前插件」）：移除 profile package.json 中的
 * 依赖行 + reconcile bundles + 删 node_modules/<pkg>。
 *
 * 目的：pnpm add 被中途 kill 后，package.json 可能已声明依赖但 node_modules 不完整，
 * 直接启动 DSH 会因缺包而失败。本函数把 manifest 恢复为「该插件未安装」的一致状态，
 * 消除「声明了依赖但没装全」的启动风险。pnpm-lock.yaml 不触碰（运行时不被读取，
 * 下次安装 pnpm 自行对齐）。尽力而为：任何失败不抛错，由调用方记录告警。
 */
export function cleanupAbortedInstall(profileDir: string, pkg: string): void {
  const manifest = readProfileManifest(profileDir)
  if (manifest !== null) {
    const deps = manifest.dependencies ?? {}
    if (Object.prototype.hasOwnProperty.call(deps, pkg)) {
      delete deps[pkg]
      manifest.dependencies = deps
      writeProfileManifest(profileDir, manifest)
    }
    // 若 pkg 曾是 bundle 成员且已非依赖 → 从 bundles 移除
    reconcileBundles(profileDir)
  }
  try {
    rmSync(join(profileDir, 'node_modules', pkg), { recursive: true, force: true })
  } catch {
    // 尽力而为：目录可能不存在或正被占用，忽略
  }
}

/** 实时读 profile 已装插件清单（先 reconcile bundles，再逐依赖取版本/bundle 属性）。 */
export function listInstalledPlugins(homeDir: string, profile: string): PluginInfo[] {
  const dir = resolveProfileDir(homeDir, profile)
  reconcileBundles(dir)
  const out: PluginInfo[] = []
  const installed = readInstalled(dir)
  for (const name of Object.keys(installed)) {
    const isBundle = hasDshBundlePatch(join(dir, 'node_modules', name))
    out.push({
      name,
      version: readInstalledVersion(dir, name) ?? '',
      // 文件视图无法区分 patch 行禁用：依赖即视为启用（与旧 marketplace 视图一致）。
      enabled: true,
      isBundle,
      // 直接依赖的 bundle 自己就是 profile 层；普通依赖不属于任何聚合 bundle。
      inBundles: isBundle ? [name] : [],
      // 声明依赖 spec 原样保留：github:/file:/link: 等非 registry 来源导入时按此安装。
      spec: installed[name],
    })
  }
  return out
}

/* --------------------------------------------------------------- CLI 通道 */

/** 15 分钟默认上限（慢网络 + git 安装），可用环境变量覆盖（CI/测试）。 */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_CONFIG_MANAGER_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * 非 registry 来源的依赖 spec 前缀：这些来源必须把 spec 原样交给 pnpm add，
 * 裸包名在 registry 上查不到（fetch-404 → 幽灵依赖拖垮整个 profile 的安装）。
 * 版本区间（^x / x.y.z）与裸包名走默认语义：npm 最新版（官方机制，见 §34.17 设计决策）。
 */
const NON_REGISTRY_SPEC = /^(github:|gitlab:|bitbucket:|git\+|file:|link:|workspace:|https?:)/i

/** 安装目标：非 registry spec 按 spec 安装；其余按裸包名（npm 最新版）。 */
export function installSpecFor(pkg: string, spec?: string): string {
  if (spec !== undefined && spec !== '' && NON_REGISTRY_SPEC.test(spec)) return spec
  return pkg
}

/** Windows 的 npm/corepack/pnpm/dsh 都是 .cmd 垫片：Node 直接 spawn 无法启动（ENOENT/EINVAL）。 */
const winCmdShim = process.platform === 'win32'

/**
 * 子进程环境：CI=true 让 pnpm v10+ 在无 TTY 时立即行动或失败，而不是卡在
 * 静默交互提示；macOS GUI 启动不继承 shell PATH，补上常见 bin 目录（dshmarket #32）。
 */
function spawnEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...process.env, CI: 'true' }
  const parts = (process.env.PATH ?? '').split(':').filter((part) => part !== '')
  for (const bin of ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`]) {
    if (bin !== '' && !parts.includes(bin)) parts.push(bin)
  }
  return { ...process.env, CI: 'true', PATH: parts.join(':') }
}

/**
 * 重放启动当前宿主进程的 dsh CLI：
 *  - process.argv[1] 是 dsh 入口（全局 bin / 源码启动的 bin.ts / bin.js）→ 用
 *    当前 Node 重新执行该入口（execArgv 原样保留，cwd 靠近入口保持相对导入可解析）；
 *  - 否则退回 PATH 上的 `dsh`（Windows 是 .cmd，需经 shell）。
 */
export function dshArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/** cmd.exe 视为语法字符（即使在一个 token 内）。 */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/** 为一个 argv token 构造 cmd.exe 命令行引用（需要引用的 token 用双引号包裹并加倍内部引号）。 */
export function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** 由 argv 构造 cmd.exe 命令行（仅 Windows 垫片路径使用）。 */
export function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** cmd.exe 解析结果（仅 Windows 垫片路径使用）。 */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'

type SpawnShimOptions = SpawnOptions & { viaShell?: boolean }

/**
 * 启动命令：Windows .cmd 垫片经 cmd.exe /d /s /c 显式构造的命令行（避开 Node
 * 弃用的 shell:true + argv 组合，DEP0190）；其余直接 shell:false 启动。
 */
function spawnShim(file: string, args: readonly string[], options: SpawnShimOptions): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell || process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

/**
 * 杀掉子进程整棵进程树：Windows 的 kill() 只终止包装进程、pnpm 子进程还活着，
 * 用 taskkill /T /F；POSIX 子进程独立进程组启动（detached），先 SIGTERM 组、
 * 5 秒后 SIGKILL 兜底。
 */
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      /* fall through to plain kill */
    }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/** 一次 dsh plugin 子进程调用的原始结果（M2 失败分类器的输入）。 */
export interface DshPluginResult {
  exitCode: number | null
  timedOut: boolean
  /** 经 AbortSignal 中止（用户跳过/取消）：进程树被 kill，非失败语义 */
  aborted?: boolean
  stdout: string
  stderr: string
  /** spawn 自身失败（如 ENOENT）；此时 exitCode 固定为 127。 */
  spawnError?: string
}

/**
 * 运行 `dsh plugin --profile <profile> <pluginArgs…>`：
 * cwd=profile 目录、CI 环境、windowsHide、pipe 输出、15 分钟超时杀进程树。
 * 永远 resolve（不 throw），由调用方判定成败。
 *
 * signal：可选 AbortSignal。中止时立即 killTree 杀掉整棵进程树（dsh 包装 + pnpm 孙进程），
 * 结果标记 aborted=true（调用方据此判定「用户跳过/取消」，而非失败）。
 */
export function runDshPlugin(
  profileDir: string,
  profile: string,
  pluginArgs: readonly string[],
  timeoutMs: number = INSTALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DshPluginResult> {
  const { file, args, viaShell } = dshArgv()
  return new Promise((resolvePromise) => {
    const child = spawnShim(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd: profileDir,
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      viaShell,
      // POSIX 下独立进程组，超时/取消可一次杀掉 dsh 包装进程 + pnpm 孙进程。
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      clearTimeout(timer)
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-256 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ exitCode: 127, timedOut: false, aborted, stdout, stderr, spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ exitCode: code, timedOut, aborted, stdout, stderr })
    })
  })
}

/* ------------------------------------------------------------ 失败分类（M2） */

/**
 * 已识别的 pnpm/dsh CLI 失败模式（纯函数，可独立单测）。
 * 识别语义对齐 dshmarket src/pnpm-compat.ts：dsh 的包装行不提供原因，必须
 * 从 pnpm 的真实诊断文本里认。
 */
export type DshPluginFailureCode =
  | 'hoist-pattern-diff'      // node_modules 由不同 pnpm major 创建，默认配置漂移
  | 'adding-to-root'          // pnpm 拒绝在 workspace 根直接 add（缺 -w）
  | 'not-a-workspace'         // 传了 -w 但目录不是 workspace
  | 'release-age-violation'   // 刚发布版本触发 pnpm 的成熟度等待期
  | 'git-build-blocked'       // git 插件构建脚本被 allowBuilds 白名单拦截
  | 'fetch-404'               // 依赖在 registry 不存在（幽灵依赖 / 私有包）
  | 'transient-network'       // 瞬时网络故障（直接重试通常即可）
  | 'pnpm-missing'            // pnpm 不在 PATH（dsh 转发层报错）

export interface DshPluginFailure {
  code: DshPluginFailureCode
  /** 双语可操作消息（同一字符串内 zh / en）。 */
  message: string
  /** true = 按消息指示重跑（重建 / 直接重试）通常即可恢复；false = 需要人工动作。 */
  recoverable: boolean
}

/**
 * 瞬时网络故障判定：pnpm 的 5xx 拉取码、meta 拉取放弃、以及穿透 dsh 包装的
 * 原始 socket 错误。永久的形态（404、鉴权）刻意排除——重试只会加倍等坏消息。
 */
export function isTransientDshPluginFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_5\d\d|ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout/i.test(output)
}

/**
 * 把一次失败的 dsh plugin 调用的合并输出映射到已知失败模式。
 * @param output - stdout+stderr 合并文本。
 * @returns 分类结果；未识别返回 null（调用方展示原始摘要）。
 */
export function classifyDshPluginFailure(output: string): DshPluginFailure | null {
  if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
    return {
      code: 'hoist-pattern-diff',
      recoverable: true,
      message: 'profile 的 node_modules 由旧版 pnpm 创建，与当前 pnpm 的默认配置不兼容；在 profile 目录执行一次 pnpm install 重建后重试 / this profile\'s node_modules was created by a different pnpm major; rebuild it (pnpm install) before retrying',
    }
  }
  if (output.includes('ERR_PNPM_ADDING_TO_ROOT')) {
    return {
      code: 'adding-to-root',
      recoverable: true,
      message: 'profile 是 pnpm workspace，当前 dsh CLI 转发未带 -w 被 pnpm 拒绝；可手动执行 dsh plugin --profile <name> add -w <pkg> / pnpm refused to add at a workspace root (missing -w); run dsh plugin --profile <name> add -w <pkg> by hand',
    }
  }
  if (/--workspace-root may only be used inside a workspace/i.test(output)) {
    return {
      code: 'not-a-workspace',
      recoverable: false,
      message: 'profile 目录不是 pnpm workspace，却传入了 -w，因此被 pnpm 拒绝 / -w was passed but the profile is not a pnpm workspace, so pnpm refused the operation',
    }
  }
  if (output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') || output.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) {
    return {
      code: 'release-age-violation',
      recoverable: true,
      message: 'profile 里有刚发布不久的插件版本，pnpm 的安全等待期检查拒绝了本次改动（即使改的是别的插件）；等待发布期满，或临时以 --config.minimumReleaseAge=0 重试 / a recently-published plugin version in this profile trips pnpm\'s fresh-release safety check, blocking any change (even to other plugins); wait for the release to mature, or retry once with --config.minimumReleaseAge=0',
    }
  }
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED') || /git-hosted package "[^"]+" needs to execute build scripts/i.test(output)) {
    return {
      code: 'git-build-blocked',
      recoverable: false,
      message: '该 git 插件需要在安装时执行构建脚本，被 pnpm 的 allowBuilds 白名单拦截；把 pnpm 提示的包名加入 profile 的 pnpm-workspace.yaml 的 allowBuilds 后重试 / this git-hosted plugin needs to run its build script at install time, which pnpm blocks until allowed — add the exact package pnpm printed to allowBuilds in the profile\'s pnpm-workspace.yaml, then re-run',
    }
  }
  if (output.includes('ERR_PNPM_FETCH_404')) {
    const pkg = /GET\s+\S*\/([^/\s]+):/.exec(output)?.[1]?.replace(/%2[Ff]/g, '/')
    const zh = pkg === undefined ? '' : `（${pkg}）`
    const en = pkg === undefined ? '' : ` (${pkg})`
    return {
      code: 'fetch-404',
      recoverable: false,
      message: `有一个依赖在 registry 上不存在${zh}，pnpm 拒绝任何安装操作；它可能是之前失败操作残留在 profile package.json 里的幽灵依赖（手动删除该行），也可能是需要登录的私有包 / a dependency cannot be resolved from the registry${en}; pnpm refuses every install while it is present — it may be a ghost entry left in the profile's package.json by an earlier failed operation (remove that line by hand), or a private package needing registry credentials`,
    }
  }
  if (isTransientDshPluginFailure(output)) {
    return {
      code: 'transient-network',
      recoverable: true,
      message: '拉取依赖时网络临时失败（安装会重放整个依赖树，任何一个既有依赖抖动都会中断本次操作）；稍后直接重试通常即可 / a transient network failure while fetching dependencies (installs replay the whole dependency tree, so any existing dependency can hiccup); a plain retry usually succeeds',
    }
  }
  if (output.includes('pnpm not found on PATH')) {
    return {
      code: 'pnpm-missing',
      recoverable: false,
      message: '找不到 pnpm（dsh 转发 pnpm 失败）：请先安装 pnpm（npm install -g pnpm 或 corepack enable pnpm），然后重试 / pnpm is not on PATH (dsh forwards to pnpm): install pnpm (npm install -g pnpm or corepack enable pnpm) and retry',
    }
  }
  return null
}

/** 安装失败 → 分类后的双语可读 Error；未识别则保留 stderr 尾部摘要。 */
export function installErrorFor(pkg: string, result: DshPluginResult): Error {
  if (result.spawnError !== undefined && /ENOENT|EINVAL/.test(result.spawnError)) {
    return new Error(`无法启动 dsh CLI（${result.spawnError}）：请确认 dsh 已安装且在 PATH 上，然后重试安装 ${pkg} / cannot start dsh CLI (${result.spawnError}): make sure dsh is installed and on PATH, then retry installing ${pkg}`)
  }
  if (result.timedOut) {
    return new Error(`安装 ${pkg} 超时（进程已终止，默认 15 分钟）：请检查网络或稍后重试 / install ${pkg} timed out (process killed, default 15 min): check your network and retry later`)
  }
  const output = `${result.stderr}\n${result.stdout}`
  const failure = classifyDshPluginFailure(output)
  if (failure !== null) {
    return new Error(`安装 ${pkg} 失败（${failure.code}）：${failure.message}`)
  }
  const tail = (result.stderr.trim().split('\n').slice(-8).join('\n')
    || result.stdout.trim().split('\n').slice(-8).join('\n')
    || '无输出')
  return new Error(`dsh plugin 安装 ${pkg} 失败（exit ${String(result.exitCode)}）：${tail}`)
}
