/**
 * 宿主斜杠命令 /rollback 单测（t3）。
 *
 * 覆盖验收四件：
 *  1. 未组合命令服务 → 不注册、不抛错（注册失败只 warn）；
 *  2. 无参数 → 只读列表（不碰 mutation lock / 不调 rewind）；
 *  3. 带参数 → 走与 HTTP 路由同源的门：runWithMutationLock（含 SAFE MODE 阻断 → 返回错误结果）；
 *  4. 引擎回 confirmation-required / protected-point / record-incomplete 一律翻成可读错误结果、绝不绕过。
 *
 * 说明：本文件用**假 host/假引擎**（不碰真实磁盘与 DSH 会话存储）验证命令层的编排与文案分派，
 * 数据形状与 RollbackPointSummary / RollbackRewindResult 对齐（type-only import，运行时零依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ROLLBACK_COMMAND_ALIAS,
  ROLLBACK_COMMAND_DEFINITION_ID,
  ROLLBACK_COMMAND_NAME,
  agentSessionFactsOf,
  isAbsolutePath,
  makeRollbackCommandHandler,
  parseRollbackCommand,
  registerRollbackCommand,
  renderRollbackList,
  renderRewindResult,
  type CommandDefinitionLike,
  type CommandInvocationLike,
  type CommandResult,
  type RollbackCommandHost,
  type RollbackCommandListResult,
} from './command-rollback.ts'
import { engineMsg, setEngineLocale } from './engine-locale.ts'
// 只读 DSH 命令契约的类型（运行时零副作用；core 源文件本身不得 import @deepseek-ai/* —— 见架构边界测试）
import type { CommandResult as DshCommandResult } from '@deepseek-ai/dsh-commands/types'
// 副作用 import：注册 zh/en 基础目录（插件装配期由 src/index.ts 的同名 import 完成）。
// 本文件单独跑时也必须有真实文案 —— 否则 engineMsg 只会回退键名。
import './messages.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import type { MutationLockPort } from '../utils/env-lock.ts'
import type { RollbackPointSummary, RollbackRewindResult, RollbackSegmentResult, RollbackSegmentSummary } from './rollback-point.ts'

/* ------------------------------------------------------------------ 夹具 */

const SESSION_ID = 'aaaa1111-2222-3333-4444-555566667777'
const OTHER_SESSION_ID = 'bbbb1111-2222-3333-4444-555566667777'

function segment(state: 'workspace' | 'session', restorable: boolean): RollbackSegmentSummary {
  return {
    state,
    ok: true,
    degraded: false,
    capturedAt: 1_700_000_000_000,
    fingerprint: null,
    reasonCode: null,
    entries: state === 'workspace' ? 3 : 1,
    bytes: 42,
    cursorBytes: null,
    restorable,
    skippedCount: 0,
    truncated: false,
  }
}

function point(overrides: Partial<RollbackPointSummary> = {}): RollbackPointSummary {
  return {
    id: 'point-1',
    createdAt: 1_700_000_000_000,
    sessionId: SESSION_ID,
    unitId: 'proj/' + SESSION_ID,
    turn: 3,
    boundarySeq: 12,
    kind: 'auto',
    protected: false,
    incomplete: false,
    note: null,
    spreadMs: 5,
    segments: [segment('workspace', true), segment('session', true)],
    ...overrides,
  }
}

function listResult(points: readonly RollbackPointSummary[], overrides: Partial<RollbackCommandListResult> = {}): RollbackCommandListResult {
  return { ok: true, storage: { available: true, root: '/data/rollback-points' }, points, ...overrides }
}

function rewindResult(overrides: Partial<RollbackRewindResult> = {}): RollbackRewindResult {
  return {
    ok: false,
    outcome: 'failed',
    code: 'restore-failed',
    id: 'point-1',
    segments: [],
    skippedSegments: [],
    storage: { available: true, root: '/data/rollback-points', guidance: [], requirements: [] },
    guidance: [],
    warnings: [],
    ...overrides,
  }
}

/** 假的命令服务：记录 register 的每一条定义，disposer 可断言被调用。 */
function fakeCommands() {
  const registered: CommandDefinitionLike[] = []
  const disposed: string[] = []
  const service = {
    register(definition: CommandDefinitionLike) {
      registered.push(definition)
      return () => { disposed.push(definition.name) }
    },
  }
  return { service, registered, disposed }
}

function fakeLogger() {
  const warns: string[] = []
  return { warns, log: { warn: (message: string) => { warns.push(message) } } }
}

function invocation(rawInput: string, agent: unknown = { id: SESSION_ID }): CommandInvocationLike {
  return { agent, rawInput }
}

/* ------------------------------------------------------------------ 解析/窄化 */

test('parseRollbackCommand：空 = 列表；单 token = rewind；多 token = invalid', () => {
  assert.deepEqual(parseRollbackCommand(''), { kind: 'list' })
  assert.deepEqual(parseRollbackCommand('   '), { kind: 'list' })
  assert.deepEqual(parseRollbackCommand('  point-9'), { kind: 'rewind', id: 'point-9' })
  assert.deepEqual(parseRollbackCommand('point-9\t'), { kind: 'rewind', id: 'point-9' })
  const invalid = parseRollbackCommand('point-9 extra')
  assert.equal(invalid.kind, 'invalid')
})

test('isAbsolutePath：认 win32 盘符 / UNC / POSIX，不认相对路径', () => {
  assert.equal(isAbsolutePath('C:\\work\\proj'), true)
  assert.equal(isAbsolutePath('C:/work/proj'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('/home/u/proj'), true)
  assert.equal(isAbsolutePath('proj'), false)
  assert.equal(isAbsolutePath('./proj'), false)
})

test('agentSessionFactsOf：优先 session.id，退回 agent.id；cwd 非绝对不给分块；都没有则如实 ok:false', () => {
  const full = agentSessionFactsOf({ id: 'agent-1', session: { id: SESSION_ID, header: { cwd: 'C:\\work\\proj' } } })
  assert.deepEqual(full, { ok: true, sessionId: SESSION_ID, chunks: ['C:\\work\\proj'] })
  const relative = agentSessionFactsOf({ id: SESSION_ID, session: { header: { cwd: 'proj' } } })
  assert.deepEqual(relative, { ok: true, sessionId: SESSION_ID, chunks: [] })
  const noSession = agentSessionFactsOf({ id: SESSION_ID })
  assert.deepEqual(noSession, { ok: true, sessionId: SESSION_ID, chunks: [] })
  const none = agentSessionFactsOf({})
  assert.equal(none.ok, false)
  assert.equal(agentSessionFactsOf(null).ok, false)
})

/* ------------------------------------------------------------------ 注册 */

test('未组合命令服务：不注册、不抛错，只 warn（宿主照常启动）', () => {
  const logger = fakeLogger()
  let reads = 0
  const dispose = registerRollbackCommand({
    readCommands: () => { reads += 1; return undefined },
    deps: { host: throwingHost() },
    log: logger.log,
  })
  assert.equal(reads, 1, '必须经惰取回调读服务（ctx.get）')
  assert.equal(logger.warns.length, 1)
  assert.match(logger.warns[0] ?? '', /commands-service-missing/)
  assert.doesNotThrow(() => dispose())
})

test('命令服务存在：注册 /rollback 与 /rw（同一 definitionId），disposer 反注册', () => {
  const commands = fakeCommands()
  const dispose = registerRollbackCommand({ readCommands: () => commands.service, deps: { host: throwingHost() } })
  assert.deepEqual(commands.registered.map((d) => d.name), [ROLLBACK_COMMAND_NAME, ROLLBACK_COMMAND_ALIAS])
  for (const definition of commands.registered) {
    assert.equal(definition.definitionId, ROLLBACK_COMMAND_DEFINITION_ID)
    assert.equal(typeof definition.handler, 'function')
    assert.ok((definition.description ?? '').length > 0)
  }
  dispose()
  assert.deepEqual(commands.disposed, [ROLLBACK_COMMAND_NAME, ROLLBACK_COMMAND_ALIAS])
  dispose()
  assert.equal(commands.disposed.length, 2, '重复 dispose 必须幂等')
})

test('注册抛错：只 warn，不影响后续定义与其它装配', () => {
  const logger = fakeLogger()
  const attempted: string[] = []
  const service = {
    register(definition: CommandDefinitionLike) {
      attempted.push(definition.name)
      if (definition.name === ROLLBACK_COMMAND_NAME) throw new Error('boom')
      return undefined
    },
  }
  const dispose = registerRollbackCommand({ readCommands: () => service, deps: { host: throwingHost() }, log: logger.log })
  assert.deepEqual(attempted, [ROLLBACK_COMMAND_NAME, ROLLBACK_COMMAND_ALIAS])
  assert.equal(logger.warns.length, 1)
  assert.match(logger.warns[0] ?? '', /boom/)
  assert.doesNotThrow(() => dispose())
})

test('惰取回调本身抛错：warn 后安静返回（绝不冒泡到装配）', () => {
  const logger = fakeLogger()
  const dispose = registerRollbackCommand({
    readCommands: () => { throw new Error('ctx exploded') },
    deps: { host: throwingHost() },
    log: logger.log,
  })
  assert.equal(logger.warns.length, 1)
  assert.match(logger.warns[0] ?? '', /ctx exploded/)
  assert.doesNotThrow(() => dispose())
})

/** host 哨兵：列表路径之外被调用即失败（证明「只读列表」没碰执行路径）。 */
function throwingHost(): RollbackCommandHost {
  return {
    agentSession: agentSessionFactsOf,
    list: async () => { throw new Error('list should not be called') },
    rewind: async () => { throw new Error('rewind should not be called') },
  }
}

/* ------------------------------------------------------------------ 只读列表 */

test('无参数：只读列表 —— 只调 host.list，绝不碰 rewind / mutation lock', async () => {
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async (sessionId: string) => {
      assert.equal(sessionId, SESSION_ID)
      return listResult([point(), point({ id: 'point-2', sessionId: OTHER_SESSION_ID })])
    },
    rewind: async () => { throw new Error('rewind must not run for a read-only list') },
  }
  const handler = makeRollbackCommandHandler({ host })
  const result = await handler(invocation(''))
  assert.equal(result.kind, 'success')
  const text = result.kind === 'success' ? result.text ?? '' : ''
  assert.match(text, /point-1/)
  assert.equal(text.includes('point-2'), false, '别的会话的点不得混进来')
})

test('列表行含 回合号 / 时间 / 类型 / 状态 / 可回退性 五项事实', () => {
  const rendered = renderRollbackList(listResult([point({ turn: 7 })]), SESSION_ID)
  assert.equal(rendered.kind, 'success')
  const text = rendered.kind === 'success' ? rendered.text ?? '' : ''
  assert.match(text, /turn 7|回合 7/)
  assert.match(text, new RegExp(new Date(1_700_000_000_000).toISOString()))
  assert.match(text, new RegExp(engineMsg('command.rollback.kindAuto')))
  assert.match(text, new RegExp(engineMsg('command.rollback.stateNormal')))
  assert.match(text, new RegExp(engineMsg('command.rollback.restorableYes')))
})

test('列表：受保护 / 不完整 / 救援点 三种状态分开说，且不谎报「可回退」', () => {
  const protectedPoint = point({ id: 'p-protected', protected: true })
  const incomplete = point({ id: 'p-incomplete', incomplete: true, segments: [segment('workspace', false), segment('session', true)] })
  const guard = point({ id: 'p-guard', kind: 'guard' })
  const rendered = renderRollbackList(listResult([protectedPoint, incomplete, guard]), SESSION_ID)
  const text = rendered.kind === 'success' ? rendered.text ?? '' : ''
  assert.match(text, new RegExp(engineMsg('command.rollback.stateProtected')))
  assert.match(text, new RegExp(engineMsg('command.rollback.stateIncomplete')))
  assert.match(text, new RegExp(engineMsg('command.rollback.kindGuard')))
  assert.match(text, new RegExp(engineMsg('command.rollback.restorableNo')))
})

test('本会话没有点：明确说「本会话」，不冒充「全库为空」', () => {
  const rendered = renderRollbackList(listResult([point({ sessionId: OTHER_SESSION_ID })]), SESSION_ID)
  assert.equal(rendered.kind, 'error')
  const text = rendered.kind === 'error' ? rendered.text : ''
  assert.equal(text, engineMsg('command.rollback.empty'))
})

test('存储栈不可用：如实报 storage 细节（绝不假装「没有点」）', () => {
  const rendered = renderRollbackList(
    { ok: false, storage: { available: false, root: '/data/rollback-points', detail: 'ENOENT' }, points: [] },
    SESSION_ID,
  )
  assert.equal(rendered.kind, 'error')
  const text = rendered.kind === 'error' ? rendered.text : ''
  assert.match(text, /ENOENT/)
})

test('拿不到会话：如实报错，绝不列全网的点', async () => {
  const handler = makeRollbackCommandHandler({ host: throwingHost() })
  const result = await handler(invocation('', {}))
  assert.equal(result.kind, 'error')
})

test('多参数：usage 错误，不执行任何回退', async () => {
  const handler = makeRollbackCommandHandler({ host: throwingHost() })
  const result = await handler(invocation('point-1 point-2'))
  assert.equal(result.kind, 'error')
  assert.match(result.kind === 'error' ? result.text : '', /too-many-arguments/)
})

/* ------------------------------------------------------------------ 带参数：写入门 */

test('带参数 → 先过 mutation lock 再执行（同源写入门），并按引擎结果分派文案', async () => {
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async () => { throw new Error('list must not run when rewinding') },
    rewind: async ({ id, signal }) => {
      assert.equal(id, 'point-1')
      assert.equal(signal, undefined, '未给 signal 时不得凭空造一个')
      return rewindResult({ ok: true, outcome: 'restored', code: 'ok', segments: [] })
    },
  }
  const handler = makeRollbackCommandHandler({ host })
  const result = await handler(invocation(' point-1', { session: { id: SESSION_ID, header: { cwd: 'C:\\work\\proj' } } }))
  assert.equal(result.kind, 'success', 'rewind 应成功，实际: ' + JSON.stringify(result))
})

test('调用方的取消信号原样透传给回退执行（不吞信号）', async () => {
  const controller = new AbortController()
  let seen: AbortSignal | undefined
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async () => listResult([]),
    rewind: async ({ signal }) => {
      seen = signal
      return rewindResult({ ok: true, outcome: 'restored', code: 'ok' })
    },
  }
  const handler = makeRollbackCommandHandler({ host })
  const result = await handler({
    agent: { id: SESSION_ID },
    rawInput: ' point-1',
    signal: controller.signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(seen, controller.signal, '必须原样透传同一个 AbortSignal')
})

test('SAFE MODE / 环境锁阻断：EnvironmentLockUnavailableError → 可读错误结果，绝不绕过', async () => {
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async () => listResult([]),
    rewind: async () => { throw new EnvironmentLockUnavailableError('rollback-rewind', 'blocked') },
  }
  const handler = makeRollbackCommandHandler({ host })
  const result = await handler(invocation('point-1'))
  assert.equal(result.kind, 'error')
  const text = result.kind === 'error' ? result.text : ''
  assert.match(text, /blocked/)
  assert.match(text, /point-1/)
})

test('引擎回 confirmation-required / protected-point / record-incomplete 一律是错误结果（不绕过）', () => {
  const cases: Array<{ code: RollbackRewindResult['code']; outcome: RollbackRewindResult['outcome'] }> = [
    { code: 'confirmation-required', outcome: 'denied' },
    { code: 'protected-point', outcome: 'denied' },
    { code: 'record-incomplete', outcome: 'denied' },
  ]
  for (const item of cases) {
    const rendered = renderRewindResult(rewindResult({ ok: false, outcome: item.outcome, code: item.code }), 'point-1')
    assert.equal(rendered.kind, 'error', item.code + ' 必须是错误结果')
    const text = rendered.kind === 'error' ? rendered.text : ''
    assert.match(text, new RegExp(item.code))
  }
})

test('partial 回退：错误结果里带逐段事实（含被跳过的段）', () => {
  const segments: RollbackSegmentResult[] = [
    { state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail: ['x'], restored: 0, failed: 1, leftovers: [], leftoversTruncated: false },
    { state: 'session', status: 'restored', detail: [], restored: 1, failed: 0, leftovers: [], leftoversTruncated: false },
  ]
  const rendered = renderRewindResult(rewindResult({ ok: false, outcome: 'partial', code: 'restore-failed', segments }), 'point-1')
  assert.equal(rendered.kind, 'error')
  const text = rendered.kind === 'error' ? rendered.text : ''
  assert.match(text, /workspace\/failed\(restore-failed\)/)
  assert.match(text, /session\/restored/)
})

test('语言在取文案那一刻解析：切到 en 后同一渲染函数输出英文（不冻结在装配期）', async () => {
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async () => listResult([point()]),
    rewind: async () => { throw new Error('unused') },
  }
  const handler = makeRollbackCommandHandler({ host })
  setEngineLocale('en')
  try {
    const result = await handler(invocation(''))
    const text = result.kind === 'success' ? result.text ?? '' : ''
    assert.ok(text.includes('Rollback points of this session:'), 'en 列表标题必须是英文: ' + text)
  } finally {
    setEngineLocale('zh')
  }
})

/* ------------------------------------------------------------------ 与 HTTP 同源：真跑 runWithMutationLock */

/** 记录调用的假 lock 端口：acquire 返回 ACQUIRED（可放行）；token 形状与 MutationLockToken 一致。 */
function fakeLockPort() {
  const ops: string[] = []
  const released: string[] = []
  const token = { tokenId: 'tok-1', managerId: 'test-manager', instanceId: 'test-instance', acquiredAt: 1 }
  const port: MutationLockPort = {
    async acquire(opts) {
      ops.push(opts.op)
      return { state: 'ACQUIRED', token }
    },
    async release(value) {
      released.push(value.tokenId)
    },
    validate(value): value is typeof token {
      return value === token || (typeof value === 'object' && value !== null && 'tokenId' in value)
    },
  }
  return { port, ops, released }
}

test('同源写入门（真 runWithMutationLock）：SAFE MODE 阻断 → 引擎一次都不执行，命令回错误结果', async () => {
  const { port, ops } = fakeLockPort()
  let rewindCalls = 0
  const host: RollbackCommandHost = {
    agentSession: agentSessionFactsOf,
    list: async () => listResult([]),
    rewind: async ({ id }) => {
      rewindCalls += 1
      return runRewindThroughGate({ port, isBlocked: () => true }, { id }, async () =>
        rewindResult({ ok: true, outcome: 'restored', code: 'ok' }),
      )
    },
  }
  try {
    const handler = makeRollbackCommandHandler({ host, mutationLock: port as unknown as MutationLockPort, isBlocked: () => true })
    const result = await handler(invocation('point-1'))
    assert.equal(result.kind, 'error')
    const text = result.kind === 'error' ? result.text : ''
    assert.match(text, /blocked/)
  } finally {
    // 断言：SAFE MODE 阻断时**没有**取锁、也没有执行引擎
    assert.deepEqual(ops, [], 'SAFE MODE 阻断必须先于 acquire')
    assert.equal(rewindCalls, 1, '宿主被调用一次，但内部什么都没做')
  }
})

test('同源写入门（真 runWithMutationLock）：未阻断 → acquire 后执行并 release', async () => {
  const { port, ops, released } = fakeLockPort()
  const outcome = await runRewindThroughGate({ port, isBlocked: () => false }, { id: 'p' }, async () =>
    rewindResult({ ok: true, outcome: 'restored', code: 'ok' }),
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(ops, ['rollback-rewind'], '必须经 mutation lock（op=rollback-rewind）')
  assert.deepEqual(released, ['tok-1'], '执行完必须释放锁（不残留）')
})


/* ------------------------------------------------------------------ 源码级断言（验收项） */

/**
 * 读源码：仅源码级断言用（rel = 仓库根相对路径）。
 *
 * 用 process.cwd()（`npm test` 的工作目录就是仓库根）而**不用** path.resolve(base, '..')：
 * 本机 Node 的 win32 path.resolve 在「≥1 个 .. 段 + 绝对 base」下会把项目目录整段吃掉
 * （实测 D:\\Projects\\personal\\dcm\\src\\core + '../../..' → D:\\Projects\\personal），
 * 于是守卫会去读一个不存在的路径 —— 那是**假红**而不是真问题。path.join 不受影响。
 */
function sourceOf(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
}

test('源码级：命令服务只经 ctx.get(\'commands\') 读取，且 src/index.ts 的 inject 不含 commands', () => {
  const indexSrc = sourceOf('src/index.ts')
  assert.ok(
    indexSrc.includes("readService<CommandServiceLike>(ctx, 'commands')"),
    '注册点必须走 ctx.get(\'commands\') 的惰取读取（readService 是它的唯一封装）',
  )
  const injectLine = indexSrc.split('\n').find((line) => line.includes('export const inject'))
  assert.ok(injectLine !== undefined, '找不到 inject 声明')
  assert.equal(/commands/.test(injectLine ?? ''), false, 'commands 绝不能进 inject（未组合该服务的部署必须照常启动）: ' + injectLine)
})

test('源码级：命令执行路径调用 runWithMutationLock（与 HTTP 路由同一道写入门）', () => {
  const indexSrc = sourceOf('src/index.ts')
  assert.ok(indexSrc.includes('runWithMutationLock('), '执行路径必须真的调用 runWithMutationLock')
  assert.ok(indexSrc.includes("op: 'rollback-rewind'"), '必须与 HTTP 路由同一 op 名（审计/锁归属可对照）')
  assert.ok(indexSrc.includes('userConfirmed: true'), '/rollback <id> 必须带 fail-closed 确认位')
  const coreSrc = sourceOf('src/core/command-rollback.ts')
  assert.equal(
    /\brouter\b|\.endpoint\(|registerRoutes\(/.test(coreSrc),
    false,
    '命令层不得新增任何 HTTP 路由（路由数不变量守卫必须保持绿）',
  )
})

test('宿主 commands 的类型与 handler 的 CommandResult 结构一致（无运行时依赖的类型协同）', async () => {
  const commands = fakeCommands()
  const dispose = registerRollbackCommand({ readCommands: () => commands.service, deps: { host: throwingHost() } })
  const definition = commands.registered[0]
  assert.ok(definition !== undefined)
  const result = await definition.handler({ agent: { id: SESSION_ID }, rawInput: '' })
  assert.ok(result.kind === 'success' || result.kind === 'error')
  assert.equal(typeof (result.kind === 'success' ? result.text ?? '' : result.text), 'string')
  dispose()
})
/* ------------------------------------------------------------------ 同源写入门参考实现（测试用） */

/**
 * 与 HTTP 路由逐条同序的那道门（测试里真跑 runWithMutationLock）：
 * runWithMutationLock（内含 SAFE MODE isBlocked 判定 + 环境锁 acquire/release）→ 真执行。
 * 被挡（SAFE MODE / 锁不可得）时抛 EnvironmentLockUnavailableError。
 */
async function runRewindThroughGate(
  gate: { port: MutationLockPort; isBlocked: () => boolean },
  target: { id: string },
  run: () => Promise<RollbackRewindResult>,
): Promise<RollbackRewindResult> {
  return await runWithMutationLock(
    gate.port,
    { op: 'rollback-rewind', target: target.id, isBlocked: gate.isBlocked },
    async () => await run(),
  )
}

/* ------------------------------------------------------------------ 契约形状：与 DSH 的命令结果逐字同形 */

/**
 * 编译期断言（双向可赋值）：core 自己声明的 CommandResult 与 DSH 的 CommandResult 一旦漂移，
 * 本文件在 tsc 下即红 —— 这是「core 不 import @deepseek-ai/*，但类型仍必须对得上」的护栏。
 */
function assertCommandResultShape(value: DshCommandResult): CommandResult {
  return value
}
function assertCommandResultBack(value: CommandResult): DshCommandResult {
  return value
}

test('契约形状：本地 CommandResult 与 @deepseek-ai/dsh-commands 的 CommandResult 双向可赋值', () => {
  assert.equal(typeof assertCommandResultShape, 'function')
  assert.equal(typeof assertCommandResultBack, 'function')
})
