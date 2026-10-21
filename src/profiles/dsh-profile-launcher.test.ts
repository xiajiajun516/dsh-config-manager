/**
 * 档案启动器单测：**不真的 spawn / 不真的杀进程**（全部副作用注入），钉住四件事 ——
 *  ① 命令行形状（`--profile <名> --port <端口>`、DSH_HOME 显式继承、日志重定向）；
 *  ② 「真正可用的切换」判据：探活就绪 + 从日志抓到带 token 的 URL；
 *  ③ 绝不静默：非 web 形态 / 定位不到 CLI / 子进程早退 / 同名已在跑 各自带码，早退消息附日志尾部；
 *  ④ 实例台账：启动即登记（就绪与否都登记）、列表按 pid 存活过滤并清死记录、停止三态如实区分。
 *
 * 背景（真机复现的根因）：DSH 没有「默认/下次启动 profile」状态 —— 任何「下次启动」标记都没有
 * 消费者。故「切换档案」= 另起一个独立实例，而「哪个档案在跑」只能由启动方自己记账。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DshProfileLauncher, buildLaunchArgs, findCliEntryForShim, logTail, parseLaunchUrl, parseLaunches,
  pickFreePortCandidates, resolveDirectCliRunner, serializeLaunches,
  type DshCliCommand, type DshProfileLauncherDeps,
} from './dsh-profile-launcher.ts'
import { DshProfileError } from './dsh-profile-manager.ts'
import type { DshProfileLaunchRecord } from './dsh-profile-shared.ts'

const NODE_CLI: DshCliCommand = { command: 'C:/node/node.exe', prefixArgs: ['C:/dsh/lib/bin.js'], shell: false }

/**
 * 注入全套副作用：spawn 只记录调用并返回给定 pid，探活/日志/时间/进程存活/台账全部由用例决定。
 * 台账用内存字符串模拟（真实实现落 <dataDir>/launches.json）——用例可断言「写了什么」。
 */
function makeHarness(overrides: {
  cli?: DshCliCommand | null
  pid?: number | null
  probe?: boolean | (() => boolean)
  log?: string | (() => string)
  exitCode?: number | null
  args?: string[][]
  envs?: NodeJS.ProcessEnv[]
  logFiles?: string[]
  /** 台账初始内容（JSON 文本） */
  state?: string
  /** spawn 那一刻往台账里塞的内容（模拟并发启动抢在同一次检查之后写入） */
  onSpawnState?: string
  /**
   * 进程存活剧本（决定 stop 的三态与列表过滤）：
   *  graceful = 一收到优雅信号就退出；forced = 只有强杀才退；survives = 怎么都杀不掉；
   *  dead = 早就没了；缺省 = 一律视为不存在。
   */
  aliveMode?: 'graceful' | 'forced' | 'survives' | 'dead'
  /** 心跳判据：该档案是否**在别处**已经在跑（宿主注入运行注册表；缺省不拦） */
  externalRunning?: (name: string) => boolean
} = {}): { launcher: DshProfileLauncher; home: string; state: () => string; killed: string[]; args: string[][]; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-launch-'))
  let clock = 0
  let state = overrides.state ?? ''
  const args = overrides.args ?? []
  const envs = overrides.envs ?? []
  const logFiles = overrides.logFiles ?? []
  const killed: string[] = []
  const deps: DshProfileLauncherDeps = {
    resolveCli: () => (overrides.cli === undefined ? NODE_CLI : overrides.cli),
    spawnDetached: (command, spawnArgs, opts) => {
      void command
      args.push(spawnArgs)
      envs.push(opts.env)
      logFiles.push(opts.logFile)
      if (overrides.onSpawnState !== undefined) state = overrides.onSpawnState
      if (overrides.exitCode !== undefined) return { pid: overrides.pid ?? 4242, onExit: (cb) => { cb(overrides.exitCode ?? null) } }
      return { pid: overrides.pid === undefined ? 4242 : overrides.pid, onExit: () => { /* 常驻 */ } }
    },
    findFreePort: () => Promise.resolve(3099),
    probe: () => Promise.resolve(typeof overrides.probe === 'function' ? overrides.probe() : overrides.probe ?? true),
    sleep: (ms) => { clock += ms; return Promise.resolve() },
    readLog: () => (typeof overrides.log === 'function' ? overrides.log() : overrides.log ?? ''),
    now: () => clock,
    isAlivePid: (pid) => {
      void pid
      if (overrides.aliveMode === 'survives') return true
      if (overrides.aliveMode === 'dead') return false
      if (overrides.aliveMode === 'forced') return !killed.some((k) => k.endsWith(':force'))
      if (overrides.aliveMode === 'graceful') return killed.length === 0
      return false
    },
    killPid: (pid, mode) => { killed.push(`${String(pid)}:${mode}`) },
    isProfileRunning: (name) => overrides.externalRunning?.(name) === true,
    readState: () => state,
    writeState: (text) => { state = text },
  }
  return {
    launcher: new DshProfileLauncher({ homeDir: home, dataDir: join(home, 'dsh-config-manager'), deps }),
    home,
    state: () => state,
    killed,
    args,
    cleanup: () => { rmSync(home, { recursive: true, force: true }) },
  }
}

test('buildLaunchArgs：--profile / --port / --no-open / extraArgs 的顺序与形状', () => {
  assert.deepEqual(buildLaunchArgs(NODE_CLI, { name: 'work', port: 3099 }), [
    'C:/dsh/lib/bin.js', '--profile', 'work', '--port', '3099',
  ])
  assert.deepEqual(buildLaunchArgs(NODE_CLI, { name: 'work', port: 3099, openBrowser: false, extraArgs: ['--trusted-host', 'x'] }), [
    'C:/dsh/lib/bin.js', '--profile', 'work', '--port', '3099', '--no-open', '--trusted-host', 'x',
  ])
  // 包装脚本形态（Windows 上的 dsh.cmd）：没有前置参数
  assert.deepEqual(buildLaunchArgs({ prefixArgs: [] }, { name: 'work' }), ['--profile', 'work'])
})

test('parseLaunchUrl：只认带 token 的 URL，并优先匹配本次端口', () => {
  const log = [
    'dsh web: http://127.0.0.1:3099/?token=abc123',
    'dsh web: http://127.0.0.1:3099/?token=abc123 (LAN: http://192.168.1.9:3099/?token=abc123)',
    'noise',
  ].join('\n')
  assert.equal(parseLaunchUrl(log), 'http://127.0.0.1:3099/?token=abc123')
  assert.equal(parseLaunchUrl(log, 3099), 'http://127.0.0.1:3099/?token=abc123')
  // 端口不匹配时回退到任意 token URL（绝不返回裸 URL —— 打开只会 401）
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:3080/?token=zz', 3099), 'http://127.0.0.1:3080/?token=zz')
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:3099/'), null, '无 token 的裸 URL 不得当作可用地址')
  assert.equal(parseLaunchUrl('nothing here'), null)
})

test('pickFreePortCandidates / logTail：端口候选段与日志尾部', () => {
  assert.deepEqual(pickFreePortCandidates(3080, 3), [3081, 3082, 3083])
  // 行尾空白不裁（多行堆栈缩进是排障信息）；只丢掉空行与超出条数的前缀
  assert.equal(logTail('a\n\n b \nc\n', 2), ' b \nc')
})

test('launch：非 web 形态直接 notLaunchable（不 spawn 隐形进程）', async () => {
  const h = makeHarness()
  try {
    for (const shape of ['headless', 'generic'] as const) {
      await assert.rejects(
        () => h.launcher.launch({ name: 'base-only', shape }),
        (e: unknown) => e instanceof DshProfileError && e.code === 'notLaunchable',
      )
    }
  } finally { h.cleanup() }
})


test('launch：desktop 独占档案一律 managedProfile（桌面端 profile 形态就是 web，光看形态会误放行）', async () => {
  const h = makeHarness()
  try {
    // 真机上 desktop 的 bundles 里确实有 @deepseek-ai/dsh-web-app → 形态是 web，
    // 但普通 dsh CLI 对 --profile desktop 硬性拒绝：必须以 managedProfile 挡在 spawn 之前，
    // 否则用户只会拿到一句 'profile "desktop" is managed exclusively by the Electron application'。
    await assert.rejects(
      () => h.launcher.launch({ name: 'desktop', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile',
    )
    await assert.rejects(
      () => h.launcher.launch({ name: 'DESKTOP', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile',
    )
    assert.deepEqual(h.args, [], '被拒时绝不 spawn 任何进程')
  } finally { h.cleanup() }
})

test('launch：定位不到 dsh CLI → launcherUnavailable（给出可行动的失败，而不是假装启动）', async () => {
  const h = makeHarness({ cli: null })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'work', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'launcherUnavailable',
    )
  } finally { h.cleanup() }
})

test('launch：web 形态 → 独立实例 + 端口 + DSH_HOME + 认证 URL 回执', async () => {
  const args: string[][] = []
  const envs: NodeJS.ProcessEnv[] = []
  const logFiles: string[] = []
  const h = makeHarness({
    args, envs, logFiles,
    log: 'dsh web: http://127.0.0.1:3099/?token=tk',
    probe: true,
  })
  try {
    const result = await h.launcher.launch({ name: 'work', shape: 'web' })
    assert.deepEqual(args[0], ['C:/dsh/lib/bin.js', '--profile', 'work', '--port', '3099'])
    assert.equal(envs[0]?.['DSH_HOME'], h.home, '子进程必须显式继承同一 home（否则会跑到默认 ~/.dsh）')
    assert.equal(logFiles[0], join(h.home, 'dsh-config-manager', 'logs', 'launch-work-3099.log'))
    assert.equal(result.ready, true)
    assert.equal(result.port, 3099)
    assert.equal(result.pid, 4242)
    assert.equal(result.url, 'http://127.0.0.1:3099/?token=tk')
    assert.deepEqual(result.warnings, [])
  } finally { h.cleanup() }
})

test('launch：没探通 / 没抓到 URL → ready=false 且逐条告警（绝不谎报成功）', async () => {
  const h = makeHarness({ probe: false, log: 'starting…' })
  try {
    const result = await h.launcher.launch({ name: 'work', shape: 'web' })
    assert.equal(result.ready, false)
    assert.equal(result.url, null)
    assert.deepEqual(result.warnings, ['notReady', 'urlNotFound'])
  } finally { h.cleanup() }
})

test('launch：探通但没抓到 URL → 只报 urlNotFound（不臆造裸 URL）', async () => {
  const h = makeHarness({ probe: true, log: 'dsh web: http://127.0.0.1:3099/' })
  try {
    const result = await h.launcher.launch({ name: 'work', shape: 'web' })
    assert.equal(result.ready, true)
    assert.equal(result.url, null)
    assert.deepEqual(result.warnings, ['urlNotFound'])
  } finally { h.cleanup() }
})

test('launch：子进程早退 → launchFailed 且消息里带日志尾部（排障唯一线索不得吞掉）', async () => {
  const h = makeHarness({ exitCode: 1, probe: false, log: 'Error: profile web is broken\n  at boot' })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'work', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'launchFailed' && e.message.includes('profile web is broken'),
    )
  } finally { h.cleanup() }
})

test('launch：拿不到 pid → launchFailed', async () => {
  const h = makeHarness({ pid: null, probe: false })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'work', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'launchFailed',
    )
  } finally { h.cleanup() }
})

test('launch：openBrowser=false 会带上 --no-open（自动化/验证用）', async () => {
  const args: string[][] = []
  const h = makeHarness({ args, probe: true })
  try {
    await h.launcher.launch({ name: 'work', shape: 'web', openBrowser: false })
    assert.ok(args[0]?.includes('--no-open'))
  } finally { h.cleanup() }
})

const RECORD: DshProfileLaunchRecord = {
  name: 'work', port: 3099, pid: 4242, url: 'http://127.0.0.1:3099/?token=t',
  logFile: '/tmp/launch-work-3099.log', startedAt: '2026-09-26T00:00:00.000Z',
}

test('launch：心跳说「别处在跑」→ alreadyRunning（用户实测：从 web 启动 cmtest 后还能再启动 web）', async () => {
  const h = makeHarness({ externalRunning: (name) => name === 'web' })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'web', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'alreadyRunning',
    )
    assert.equal(h.args.length, 0, '被心跳挡住时绝不能真的起进程')
    // 别的档案不受影响
    await h.launcher.launch({ name: 'cmtest', shape: 'web' }).then(
      () => { assert.equal(h.args.length, 1, '没在跑的档案照常可启动') },
      (err: unknown) => { assert.fail('不该失败：' + String(err)) },
    )
  } finally { h.cleanup() }
})

test('parseLaunches / serializeLaunches：坏 JSON 与残项一律丢弃，序列化稳定有序', () => {
  assert.deepEqual(parseLaunches(''), [])
  assert.deepEqual(parseLaunches('not json'), [])
  assert.deepEqual(parseLaunches('[]'), [])
  assert.deepEqual(parseLaunches(JSON.stringify({ launches: [] })), [])
  // 稳定排序（按档案名）：同一批记录两次序列化结果一致，避免无意义 diff
  const text = serializeLaunches([{ ...RECORD, name: 'beta' }, RECORD])
  assert.deepEqual(parseLaunches(text).map((r) => r.name), ['beta', 'work'])
  assert.equal(serializeLaunches(parseLaunches(text)), text)
  // 残项：缺 name / 缺 port / pid<=0 / 非对象 全部丢弃；缺 url 归 null
  const raw = JSON.stringify({ launches: [{ name: 'a' }, { name: 'b', port: 1, pid: 0 }, { name: '', port: 1, pid: 2 }, 7, { name: 'c', port: 2, pid: 3 }] })
  const kept = parseLaunches(raw)
  assert.deepEqual(kept.map((r) => r.name), ['c'])
  assert.equal(kept[0]?.url, null)
  assert.equal(kept[0]?.logFile, '')
})

test('launch：台账里同名实例还活着 → alreadyRunning（不允许同名多开，且不 spawn）', async () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'survives' })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'work', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'alreadyRunning',
    )
    assert.equal(h.args.length, 0, '拒绝时绝不能真的起进程')
  } finally { h.cleanup() }
})

test('launch：就绪后登记台账（pid / 端口 / URL 都留痕）', async () => {
  const pid = 5150
  const h = makeHarness({ pid, aliveMode: 'survives', log: 'dsh web: http://127.0.0.1:3099/?token=tk' })
  try {
    const result = await h.launcher.launch({ name: 'work', shape: 'web' })
    assert.equal(result.ready, true)
    assert.deepEqual(h.launcher.listRunning().map((r) => r.name), ['work'])
    const recorded = parseLaunches(h.state())[0]
    assert.equal(recorded?.pid, pid)
    assert.equal(recorded?.port, 3099)
    assert.equal(recorded?.url, 'http://127.0.0.1:3099/?token=tk')
  } finally { h.cleanup() }
})

test('launch：并发抢跑时宁可失败——就绪后发现台账已有别的活实例，杀掉自己并报 alreadyRunning', async () => {
  // 模拟：前置检查时台账为空，spawn 之后另一个请求先记了台账（不同 pid）
  const other: DshProfileLaunchRecord = { ...RECORD, name: 'work', pid: 777 }
  const h = makeHarness({ pid: 5150, aliveMode: 'survives', onSpawnState: serializeLaunches([other]) })
  try {
    await assert.rejects(
      () => h.launcher.launch({ name: 'work', shape: 'web' }),
      (e: unknown) => e instanceof DshProfileError && e.code === 'alreadyRunning',
    )
    assert.deepEqual(h.killed, ['5150:force'], '自己刚起的那个必须杀掉，否则会留下没人记录的隐形实例')
    assert.deepEqual(parseLaunches(h.state()).map((r) => r.pid), [777], '台账里保留先到的那个实例')
  } finally { h.cleanup() }
})

test('listRunning：pid 已死的历史记录会被清掉（用户手动关了实例也算）', () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'dead' })
  try {
    assert.deepEqual(h.launcher.listRunning(), [])
    assert.deepEqual(parseLaunches(h.state()), [], '死记录必须从台账里清掉，否则 UI 会一直显示「运行中」')
  } finally { h.cleanup() }
})

test('stop：台账里没有该档案 → notRunning（不瞎杀进程）', async () => {
  const h = makeHarness({ aliveMode: 'survives' })
  try {
    await assert.rejects(
      () => h.launcher.stop('ghost'),
      (e: unknown) => e instanceof DshProfileError && e.code === 'notRunning',
    )
    assert.deepEqual(h.killed, [])
  } finally { h.cleanup() }
})

test('stop：优雅退出 → graceful，记录清空', async () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'graceful' })
  try {
    const stopped = await h.launcher.stop('work')
    assert.deepEqual(stopped, { name: 'work', result: 'graceful', port: 3099 })
    assert.deepEqual(h.killed, ['4242:graceful'])
    assert.deepEqual(parseLaunches(h.state()), [])
  } finally { h.cleanup() }
})

test('stop：优雅期超时 → 强杀，并如实回报 killed（不伪装成优雅退出）', async () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'forced' })
  try {
    const stopped = await h.launcher.stop('work')
    assert.equal(stopped.result, 'killed')
    assert.deepEqual(h.killed, ['4242:graceful', '4242:force'])
    assert.deepEqual(parseLaunches(h.state()), [])
  } finally { h.cleanup() }
})

test('stop：进程早已不在 → already-stopped（清残留记录，不发信号）', async () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'dead' })
  try {
    const stopped = await h.launcher.stop('work')
    assert.equal(stopped.result, 'already-stopped')
    assert.deepEqual(h.killed, [])
    assert.deepEqual(parseLaunches(h.state()), [])
  } finally { h.cleanup() }
})

test('stop：怎么都杀不掉 → stopFailed（附 pid）且记录保留（用户可以重试）', async () => {
  const h = makeHarness({ state: serializeLaunches([RECORD]), aliveMode: 'survives' })
  try {
    await assert.rejects(
      () => h.launcher.stop('work'),
      (e: unknown) => e instanceof DshProfileError && e.code === 'stopFailed' && e.message.includes('4242'),
    )
    assert.deepEqual(h.killed, ['4242:graceful', '4242:force'])
    assert.deepEqual(parseLaunches(h.state()).map((r) => r.name), ['work'], '杀不掉就不能清记录（否则 UI 显示「已停止」而进程还在）')
  } finally { h.cleanup() }
})

/**
 * 真机根因（Windows）：启动器原先直接跑 PATH 上的 `dsh.cmd`，参数里带 `detached: true` ——
 * 中间多一层 cmd.exe 后，孙进程（真正常驻的 node）的 stdout/stderr **全部丢失**，
 * 日志文件恒 0 字节，于是永远读不到 `dsh web: <带 token 的 URL>`。
 * 修法 = 从 .cmd 反解真正的 bin.js 直启；下面钉住反解的两条真实布局。
 */
function makeShimTree(binLayout: 'sibling' | 'parent' | 'embedded-parent'): { root: string; shim: string; entry: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shim-'))
  const prefix = binLayout === 'sibling' ? root : join(root, 'bin')
  mkdirSync(prefix, { recursive: true })
  const pkgRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkgRoot, 'lib'), { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const entry = join(pkgRoot, 'lib', 'bin.js')
  writeFileSync(entry, '// dsh cli\n')
  const shim = join(prefix, 'dsh.cmd')
  if (binLayout === 'sibling') writeFileSync(shim, '"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
  else writeFileSync(shim, '"%_prog%" "%dp0%\\..\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
  return { root, shim, entry, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

test('findCliEntryForShim：npm 全局布局（node_modules 与 shim 同目录）能反解出 bin.js', () => {
  const tree = makeShimTree('sibling')
  try {
    assert.equal(findCliEntryForShim(tree.shim), tree.entry)
  } finally { tree.cleanup() }
})

test('findCliEntryForShim：shim 在 bin/ 子目录、内嵌路径带 ..\\ → 仍能反解（否则会退回 shell 包装脚本，日志恒空）', () => {
  const tree = makeShimTree('embedded-parent')
  try {
    assert.equal(findCliEntryForShim(tree.shim), tree.entry)
  } finally { tree.cleanup() }
})

test('findCliEntryForShim：找不到 dsh 入口 → null（调用方退回包装脚本，并由 warn urlNotFound 如实告知）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shim-none-'))
  try {
    const shim = join(root, 'dsh.cmd')
    writeFileSync(shim, '"%_prog%" "%dp0%\\somewhere\\else.js" %*\r\n')
    assert.equal(findCliEntryForShim(shim), null)
    assert.equal(findCliEntryForShim(join(root, 'missing.cmd')), null, '脚本读不到也不得抛')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveDirectCliRunner：宿主是 Electron 时以 ELECTRON_RUN_AS_NODE=1 直启 bin.js，普通 node 不带该变量', () => {
  assert.deepEqual(resolveDirectCliRunner({ electron: '30.0.0' }), {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.deepEqual(resolveDirectCliRunner({ node: '24.13.0' }), { command: process.execPath })
})

test('launch：CLI 解析成「直启 bin.js」时，spawn 不得带 shell（中间 cmd 层 + detached 会丢 stdio）', async () => {
  const h = makeHarness({
    cli: { command: 'C:/node/node.exe', prefixArgs: ['C:/dsh/lib/bin.js'], shell: false },
    log: 'dsh web: http://127.0.0.1:3099/?token=abc',
  })
  try {
    const result = await h.launcher.launch({ name: 'work', shape: 'web', openBrowser: false })
    assert.equal(result.url, 'http://127.0.0.1:3099/?token=abc')
    assert.deepEqual(result.warnings, [])
  } finally { h.cleanup() }
})
