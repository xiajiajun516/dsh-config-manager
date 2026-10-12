/**
 * 聊天内「↺ 回退」入口的判定层测试（node:test，零依赖）。
 *
 * 四条验收点逐条落地：
 *  ① mode 映射（三选一 ↔ 段集合，复用 src/ui/rollback-view.ts 的唯一实现）；
 *  ② **未二次确认绝不发写请求**（端口零调用；这是 fail-closed 的客户端一半）；
 *  ③ code → 文案键映射（白名单内的码逐条对得上）；
 *  ④ 未知 code 回落 `rollback.code.unknown`（绝不把机器码原文上屏）。
 *
 * 另外钉住三件容易腐烂的事：
 *  · 组件里出现的每个 `t('chat.*')` / `rt('rollback.*')` 键都必须在字典里存在（zh/en 成对非空）；
 *  · 两态纪律（S2）：判定层不出现 `config` 第三态、也没有「同点」键；
 *  · 客户端铁律：判定层不得 import node 模块 / src/core，也不得直接 fetch。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_REWIND_MODE,
  ROLLBACK_NOTHING_TO_RESTORE_KEY,
  ROLLBACK_NO_RECORDED_FILES_CODE,
  archiveHintKey,
  archiveParentSession,
  startFreshSession,
  buildRewindOptions,
  buildSessionNavigator,
  CHAT_SESSION_ACTIVE_DENIED_KEY,
  CHAT_SESSION_ACTIVE_NOTE_KEY,
  canSubmitRewind,
  chatFileChangeAvailable,
  chatRewindFailed,
  chatRewindFailure,
  canRevertFiles,
  chatRewindNotices,
  chatRewindSummary,
  childOpenHintKey,
  codeKeyOfError,
  confirmOnSubmit,
  createInFlightLock,
  defaultDraft,
  errorDetail,
  findPointForTurn,
  isSessionActive,
  navigationSourcesOf,
  openChildSession,
  previewFileStatusKnown,
  readRollbackPreviewFiles,
  readRollbackPreviewRemovals,
  requestRewind,
  revertFilesOn,
  setRevertFiles,
  rewindSubmittable,
  rollbackChildSession,
  rollbackPreviewNote,
  rollbackPreviewVerdict,
  segmentsForMode,
  submitButtonEnabled,
  type RewindDraft,
  type SessionNavigator,
} from './rollback-entry-view.ts'
import { en as chatEn, zh as chatZh } from './chat-locales.ts'
import { ROLLBACK_CODES, ROLLBACK_CODE_UNKNOWN_KEY, type RollbackPointPort, type RollbackPreviewResult, type RollbackRewindResult } from '../../ui/rollback-view.ts'
import { en as recoveryEn, zh as recoveryZh } from '../recovery/recovery-locales.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 当前草稿（确认由 confirmOnSubmit 在提交那一刻置位，与对话框一致）。 */
const confirmedDraft = (patch: Partial<RewindDraft> = {}): RewindDraft =>
  confirmOnSubmit({ ...defaultDraft(null), ...patch }) as RewindDraft

/** 假端口：记录 restoreRollbackPoint 的调用次数与请求体（其余成员本次不用）。 */
function fakePort(): { port: RollbackPointPort; calls: { id: string; options: unknown }[] } {
  const calls: { id: string; options: unknown }[] = []
  const notUsed = async (): Promise<never> => { throw new Error('本用例不应调用该端口方法') }
  const port: RollbackPointPort = {
    rollbackPoints: notUsed as RollbackPointPort['rollbackPoints'],
    rollbackPointStorage: notUsed as RollbackPointPort['rollbackPointStorage'],
    rollbackPoint: notUsed as RollbackPointPort['rollbackPoint'],
    rollbackPointPreview: notUsed as RollbackPointPort['rollbackPointPreview'],
    restoreRollbackPoint: async (id, options) => {
      calls.push({ id, options })
      return { ok: true, outcome: 'restored', code: 'ok', childSessionId: 'child-1' } as RollbackRewindResult
    },
    removeRollbackPoint: notUsed as RollbackPointPort['removeRollbackPoint'],
  }
  return { port, calls }
}

/* ------------------------------------------------------------ ① mode 映射（固定 files+session） */

test('mode 映射：段集合与 wire contract 逐条对齐（复用唯一实现）', () => {
  assert.deepEqual(segmentsForMode('files+session'), ['workspace', 'session'])
  assert.deepEqual(segmentsForMode('files'), ['workspace'])
  assert.deepEqual(segmentsForMode('session'), ['session'])
  assert.deepEqual(segmentsForMode('unknown-mode'), [], '未知 mode 不得被当成任一已知范围')
  assert.deepEqual(segmentsForMode(null), [])
})

test('聊天入口的 mode 是**固定** files+session（「回到这条消息之前」），没有三选一', () => {
  assert.equal(CHAT_REWIND_MODE, 'files+session')
  assert.equal(defaultDraft(null).mode, CHAT_REWIND_MODE)
  // 预览里的可用段（哪怕只有会话可退）都不改变这个固定档位
  const sessionOnly = {
    ok: true, id: 'p', storage: { available: true }, canRestore: true,
    workspace: { available: false, reasonCode: 'nothing-to-restore' },
    session: { available: true, restorable: true },
  } as never
  assert.equal(defaultDraft(sessionOnly).mode, 'files+session', '固定档位与预览里的可用段无关')
  assert.deepEqual(segmentsForMode(defaultDraft(sessionOnly).mode), ['workspace', 'session'])
  // 请求体里段集合必须恒为两态全集
  assert.deepEqual(buildRewindOptions({ ...defaultDraft(null), confirmed: true }), { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
})

/* ------------------------------------------------------------ ② 未二次确认绝不发写请求 */

test('未二次确认：requestRewind 一律 blocked 且端口零调用', async () => {
  const { port, calls } = fakePort()
  const attempt = await requestRewind(port, 'point-1', { ...defaultDraft(null), confirmed: false })
  assert.equal(attempt.kind, 'blocked')
  assert.equal(calls.length, 0, '未确认时不得发出任何写请求')
  assert.equal(buildRewindOptions({ ...defaultDraft(null), confirmed: false }), null, '未确认时请求体都不成形')
  assert.equal(buildRewindOptions(null), null)
})

test('未二次确认：非布尔 true（缺省 / 假值）同样 blocked', async () => {
  const { port, calls } = fakePort()
  for (const bogus of [undefined, 0, 1, 'true', null]) {
    const draft = { ...defaultDraft(null), confirmed: bogus as unknown as boolean }
    assert.equal(buildRewindOptions(draft), null, 'userConfirmed 必须恰好 true：' + String(bogus))
    const attempt = await requestRewind(port, 'point-1', draft)
    assert.equal(attempt.kind, 'blocked')
  }
  assert.equal(calls.length, 0)
})

test('确认后：请求体逐字段成形（userConfirmed 恰好 true + 固定 mode + guard=require）', async () => {
  const { port, calls } = fakePort()
  const draft = confirmedDraft()
  // F5：这条断言测的是 **wire 侧提交判据**（canSubmitRewind），不是「按钮可用性」——
  // 按钮可用性一律由 enablement 判据（rewindSubmittable / submitButtonEnabled）负责。
  assert.equal(canSubmitRewind(draft, null), false, '没有预览判定时 wire 侧提交判据为 false（但已确认的请求体仍可成形）')
  const options = buildRewindOptions(draft)
  assert.deepEqual(options, { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
  const attempt = await requestRewind(port, 'point-1', draft)
  assert.equal(attempt.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.id, 'point-1')
  assert.deepEqual(calls[0]?.options, { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
})

test('点「回退」即确认：confirmOnSubmit 是**唯一**置位入口，且不就地改写传入的草稿', () => {
  const base = defaultDraft(null)
  assert.equal(base.confirmed, false, '默认草稿绝不自动确认')
  const confirmed = confirmOnSubmit(base)
  assert.equal(confirmed?.confirmed, true)
  assert.equal(base.confirmed, false, '原对象不被改写（React 状态更新语义）')
  assert.equal(confirmOnSubmit(null), null)
  // 非布尔真值一律不成形（fail-closed 一个字没动）
  for (const bogus of [undefined, 0, 1, 'true', null]) {
    const draft = { ...defaultDraft(null), confirmed: bogus as unknown as boolean }
    assert.equal(buildRewindOptions(draft), null, 'userConfirmed 必须恰好 true：' + String(bogus))
  }
})

test('确认 + 未知 mode：仍不发请求（段集合为空 = 请求体不成形）', async () => {
  const { port, calls } = fakePort()
  const draft = confirmedDraft({ mode: 'nope' as never })
  assert.equal(buildRewindOptions(draft), null)
  assert.equal((await requestRewind(port, 'point-1', draft)).kind, 'blocked')
  assert.equal(calls.length, 0)
})

/* ------------------------------------------------------------ ③④ code → 文案键 */

test('code → 文案键映射：白名单内的码逐条对上', () => {
  for (const code of ROLLBACK_CODES) {
    const key = codeKeyOfError({ code })
    assert.equal(key, 'rollback.code.' + code)
    assert.ok(zhHas(key), '恢复字典 zh 必须有该键：' + key)
    assert.ok(enHas(key), '恢复字典 en 必须有该键：' + key)
  }
})

test('未知 code 回落 unknown（绝不裸渲染机器码）', () => {
  assert.equal(codeKeyOfError({ code: 'brand-new-code' }), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(codeKeyOfError({ code: '' }), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(codeKeyOfError({ code: 500 }), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(codeKeyOfError(new Error('boom')), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(codeKeyOfError(null), ROLLBACK_CODE_UNKNOWN_KEY)
})

test('错误详情渲染前过 redact（宿主技术细节不上明文）', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz'
  const masked = errorDetail(new Error('request failed with key ' + key))
  assert.ok(masked !== null && !masked.includes(key), '厂商前缀密钥必须被掩码：' + String(masked))
  assert.ok(masked.includes('***REDACTED***'), '掩码产物形态：' + String(masked))
  const bearer = errorDetail(new Error('Authorization failed: Bearer abcdefghijklmnopqrst'))
  assert.ok(bearer !== null && !bearer.includes('abcdefghijklmnopqrst'), 'Bearer 令牌必须被掩码：' + String(bearer))
  assert.equal(errorDetail({}), null)
  assert.equal(errorDetail(new Error('')), null)
  assert.equal(errorDetail('plain text'), 'plain text')
})

function zhHas(key: string): boolean { return Object.prototype.hasOwnProperty.call(recoveryZh, key) }
function enHas(key: string): boolean { return Object.prototype.hasOwnProperty.call(recoveryEn, key) }

/* ------------------------------------------------------------ 回合 ↔ 回滚点 */

test('回滚点匹配：sessionId + 回合号同时相等，优先自动点', () => {
  const points = [
    { id: 'guard-3', createdAt: 1, sessionId: 's1', turn: 3, kind: 'guard' },
    { id: 'auto-3', createdAt: 2, sessionId: 's1', turn: 3, kind: 'auto' },
    { id: 'auto-4', createdAt: 3, sessionId: 's1', turn: 4, kind: 'auto' },
    { id: 'other-session', createdAt: 4, sessionId: 's2', turn: 3, kind: 'auto' },
  ]
  assert.equal(findPointForTurn(points, 's1', 3)?.id, 'auto-3')
  assert.equal(findPointForTurn(points, 's1', 4)?.id, 'auto-4')
  assert.equal(findPointForTurn(points, 's2', 3)?.id, 'other-session')
  assert.equal(findPointForTurn(points, 's1', 9), null, '找不到就如实说没有，不猜最近的一个')
  assert.equal(findPointForTurn(points, '', 3), null)
  assert.equal(findPointForTurn(points, 's1', null), null)
  assert.equal(findPointForTurn(undefined, 's1', 3), null)
  // 同一回合只有 guard 点时仍可用（回退前救援点也是可回退的点），但自动点优先
  assert.equal(findPointForTurn([{ id: 'guard-9', createdAt: 1, sessionId: 's1', turn: 9, kind: 'guard' }], 's1', 9)?.id, 'guard-9')
})

/* ------------------------------------------------------------ 子会话打开（S3 / T9-F1） */

/** 假导航面：opened = 被打开的 id；refreshes = refresh 次数。 */
function fakeNavigator(opts: {
  listed?: string[]
  refreshAdds?: string[]
  refreshThrows?: boolean
  openThrows?: boolean
  listThrows?: boolean
} = {}): { navigator: SessionNavigator; opened: string[]; refreshCount: () => number } {
  const listed = [...(opts.listed ?? [])]
  const state = { opened: [] as string[], refreshes: 0 }
  const navigator: SessionNavigator = {
    openSession: (id: string) => {
      if (opts.openThrows === true) throw new Error('navigation failed')
      state.opened.push(id)
    },
    listedIds: () => {
      if (opts.listThrows === true) throw new Error('list unreadable')
      return [...listed]
    },
  }
  if (opts.refreshAdds !== undefined || opts.refreshThrows === true) {
    navigator.refresh = async () => {
      state.refreshes += 1
      if (opts.refreshThrows === true) throw new Error('refresh failed')
      for (const id of opts.refreshAdds ?? []) if (!listed.includes(id)) listed.push(id)
    }
  }
  return { navigator, opened: state.opened, refreshCount: () => state.refreshes }
}

/** `ctx.sessions` 假对象（真机形状：list/refresh，**没有 open**）。 */
function fakeSessions(opts: { listed?: string[]; refresh?: boolean } = {}): Record<string, unknown> {
  const source: Record<string, unknown> = {
    list: { getSnapshot: () => ({ byId: Object.fromEntries((opts.listed ?? []).map((id) => [id, { id }])) }) },
  }
  if (opts.refresh === true) source['refresh'] = async () => {}
  return source
}

/** `ctx.uiWorkspace` 假对象（真机导航面）。 */
function fakeWorkspace(): { openSession: (id: string) => void; opened: string[] } {
  const opened: string[] = []
  return { opened, openSession: (id: string) => { opened.push(id) } }
}

test('导航面探测（真机）：uiWorkspace.openSession 是入口，优先于 0.1.x 的 sessions.open', () => {
  const workspace = fakeWorkspace()
  const navigator = buildSessionNavigator({ workspace, sessions: fakeSessions({ listed: ['c1'] }) })
  assert.ok(navigator !== undefined)
  assert.equal(typeof navigator.openSession, 'function', '真机入口来自 uiWorkspace')
  navigator.openSession?.('c1')
  assert.deepEqual(workspace.opened, ['c1'])
  assert.deepEqual(navigator.listedIds?.(), ['c1'])
  // 两者都在时优先 uiWorkspace（0.2 的真相），不重复走旧分支
  const legacyOpened: string[] = []
  const both = buildSessionNavigator({
    workspace,
    sessions: { ...fakeSessions({ listed: ['c1'] }), open: (id: string) => { legacyOpened.push(id) } },
  })
  both?.openSession?.('c2')
  assert.deepEqual(workspace.opened, ['c1', 'c2'], '优先走 uiWorkspace')
  assert.deepEqual(legacyOpened, [], '不重复走旧分支')
})

test('导航面探测（旧版）：只有 sessions.open 时才用它（存在才用）', () => {
  const opened: string[] = []
  const navigator = buildSessionNavigator({ sessions: { open: (id: string) => { opened.push(id) }, list: { getSnapshot: () => ({ byId: {} }) } } })
  assert.equal(typeof navigator?.openSession, 'function')
  navigator?.openSession?.('c9')
  assert.deepEqual(opened, ['c9'])
})

test('导航面探测：有 list/refresh 但没有 open（真机 sessions 形状）→ 绝不编出 open', () => {
  const navigator = buildSessionNavigator(fakeSessions({ listed: ['c1'], refresh: true }))
  assert.ok(navigator !== undefined, '列表仍可读')
  assert.equal(navigator.openSession, undefined, 'T9-F1：sessions 形状里没有 open 就不许包一个必然抛的包装')
})

test('真机形状回归：有 list/refresh、无 open → unavailable（绝不是 degraded）', async () => {
  assert.equal(await openChildSession(buildSessionNavigator(fakeSessions({ listed: ['c1'], refresh: true })), 'c1'), 'unavailable', '没有导航入口就是没有入口，哪怕它已在列表里')
  assert.equal(await openChildSession(undefined, 'c1'), 'unavailable')
  assert.equal(await openChildSession({}, 'c1'), 'unavailable')
})

test('真机形状回归：uiWorkspace 在 + 子会话已在列表 → opened（真机成功路径）', async () => {
  const workspace = fakeWorkspace()
  const navigator = buildSessionNavigator({ workspace, sessions: fakeSessions({ listed: ['c1'] }) })
  assert.equal(await openChildSession(navigator, 'c1'), 'opened')
  assert.deepEqual(workspace.opened, ['c1'])
})

test('真机回归（2026-10-11）：uiWorkspace.openSession 依赖 this —— 抽方法时不 bind 就必然抛，子会话永远打不开', async () => {
  const opened: string[] = []
  // 复刻 uiWorkspace 的真形状：实现体是 `openSession(target) { this.replaceMain(target, this.lifetime.signal, 'reveal') }`
  // ⇒ 只有 receiver 是服务对象本身时 this.lifetime 才存在。
  const service = {
    lifetime: { signal: 'sig' },
    openSession(this: { lifetime: { signal: string } }, id: string) { opened.push(id + ':' + this.lifetime.signal) },
  }
  const navigator = buildSessionNavigator(navigationSourcesOf({ get: (key: string) => (key === 'uiWorkspace' ? service : undefined) }))
  assert.equal(await openChildSession(navigator, 'c1'), 'opened', 'receiver 必须跟着方法一起走')
  assert.deepEqual(opened, ['c1:sig'])
})

test('真机回归：sessions.refresh 同样依赖 this（丢 receiver 会让基线拉取静默失败）', async () => {
  let calls = 0
  const sessions = {
    manager: { refreshList: async () => { calls += 1 } },
    async refresh(this: { manager: { refreshList: () => Promise<void> } }) { await this.manager.refreshList() },
    list: { getSnapshot: () => ({ byId: { c1: { id: 'c1' } } }) },
  }
  const navigator = buildSessionNavigator(navigationSourcesOf({ get: (key: string) => (key === 'sessions' ? sessions : undefined) }))
  await navigator?.refresh?.()
  assert.equal(calls, 1)
})

test('遗留形状容错：直接给 open 的旧形态导航面也能识别（但不许没有入口顶上假函数）', async () => {
  const opened: string[] = []
  const legacy: SessionNavigator = { open: (id: string) => { opened.push(id) }, listedIds: () => ['c1'] }
  assert.equal(await openChildSession(legacy, 'c1'), 'opened')
  assert.deepEqual(opened, ['c1'])
  const noOpener: SessionNavigator = { listedIds: () => ['c1'], refresh: async () => {} }
  assert.equal(await openChildSession(noOpener, 'c1'), 'unavailable', '没有入口仍然只能是 unavailable')
  // 两者都给时以 openSession（规范入口）为准
  const both: string[] = []
  const bothNav: SessionNavigator = {
    openSession: (id: string) => { both.push('openSession:' + id) },
    open: (id: string) => { both.push('open:' + id) },
    listedIds: () => ['c1'],
  }
  assert.equal(await openChildSession(bothNav, 'c1'), 'opened')
  assert.deepEqual(both, ['openSession:c1'])
})

test('子会话打开：列表未命中 → 先 refresh 再判（fork 由宿主侧执行，客户端可能还没收到增量）', async () => {
  const { navigator, opened } = fakeNavigator({ listed: [], refreshAdds: ['child-2'] })
  assert.equal(await openChildSession(navigator, 'child-2'), 'opened')
  assert.deepEqual(opened, ['child-2'])
})

test('子会话打开：refresh 后仍没有 / 没有 refresh / 刷新抛错 → degraded（此陈述已被证实）', async () => {
  const refreshed = fakeNavigator({ listed: [], refreshAdds: [] })
  assert.equal(await openChildSession(refreshed.navigator, 'child-3'), 'degraded')
  assert.equal(refreshed.refreshCount(), 1, '恰好重拉一次基线')
  assert.deepEqual(refreshed.opened, [], '确认没有它就不调用导航')
  const noRefresh = fakeNavigator({ listed: [] })
  assert.equal(await openChildSession(noRefresh.navigator, 'child-3'), 'degraded')
  assert.equal(noRefresh.refreshCount(), 0)
  const refreshThrows = fakeNavigator({ listed: [], refreshAdds: [], refreshThrows: true })
  assert.equal(await openChildSession(refreshThrows.navigator, 'child-3'), 'degraded', '刷新失败不改变判据口径')
})

test('A 无感替换：归档原会话 —— 成功 / 缺入口 / 空 id / 有界重试 / 持续失败 全部结构化，绝不抛', async () => {
  const calls: string[] = []
  const ok = { archiveSession: async (id: string): Promise<unknown> => { calls.push(id); return { ok: true, value: { archivedSessionIds: [id] } } } }
  assert.deepEqual(await archiveParentSession(ok, 's1'), { ok: true })
  assert.deepEqual(calls, ['s1'], '成功一次即可，不重试')

  assert.deepEqual(await archiveParentSession(undefined, 's1'), { ok: false, code: 'archive-unavailable' })
  assert.deepEqual(await archiveParentSession({}, 's1'), { ok: false, code: 'archive-unavailable' })
  assert.deepEqual(await archiveParentSession(ok, ''), { ok: false, code: 'archive-no-session' })

  // 真机唯一失败面：刚导航走时原会话还被判「活动中」→ 重试一次即成功
  let attempts = 0
  const flaky = { archiveSession: async (id: string): Promise<unknown> => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('session is active'), { code: 'session/active' })
    return { ok: true, value: { archivedSessionIds: [id] } }
  } }
  assert.deepEqual(await archiveParentSession(flaky, 's2', { delay: async () => {} }), { ok: true })
  assert.equal(attempts, 2, '有界重试恰好一次')

  // RPC 形状的失败结果（ok:false + error.code）与持续异常都不能逃出去
  let refusals = 0
  const refused = { archiveSession: async (): Promise<unknown> => { refusals += 1; return { ok: false, error: { code: 'session/active' } } } }
  assert.deepEqual(await archiveParentSession(refused, 's3', { delay: async () => {} }), { ok: false, code: 'session/active' })
  assert.equal(refusals, 2)
  const boom = { archiveSession: async (): Promise<unknown> => { throw new Error('boom') } }
  assert.deepEqual(await archiveParentSession(boom, 's4', { delay: async () => {} }), { ok: false, code: 'archive-failed' })
})

test('A：第一条消息之前的回退 —— 开一条全新会话（缺入口/抛错都结构化，绝不抛）', async () => {
  let calls = 0
  assert.deepEqual(await startFreshSession({ startSession: async () => { calls += 1 } }), { ok: true })
  assert.equal(calls, 1)
  assert.deepEqual(await startFreshSession(undefined), { ok: false, code: 'start-session-unavailable' })
  assert.deepEqual(await startFreshSession({}), { ok: false, code: 'start-session-unavailable' })
  const boom = { startSession: async (): Promise<void> => { throw new Error('nope') } }
  assert.deepEqual(await startFreshSession(boom), { ok: false, code: 'start-session-failed' })
})

test('A 真机回归：uiWorkspace.startSession 依赖 this —— 抽方法时同样必须 bind 回服务对象', async () => {
  const service = {
    started: 0,
    async startSession(this: { started: number }): Promise<void> { this.started += 1 },
  }
  const sources = navigationSourcesOf({ get: (key: string) => (key === 'uiWorkspace' ? service : undefined) })
  assert.deepEqual(await startFreshSession(sources.workspace), { ok: true })
  assert.equal(service.started, 1)
})

test('A 真机回归：workspaces.archiveSession 依赖 this —— 抽方法时必须 bind 回服务对象', async () => {
  const service = {
    archived: [] as string[],
    async archiveSession(this: { archived: string[] }, id: string): Promise<unknown> {
      this.archived.push(id)
      return { ok: true, value: { archivedSessionIds: [id] } }
    },
  }
  const sources = navigationSourcesOf({ get: (key: string) => (key === 'workspaces' ? service : undefined) })
  assert.deepEqual(await archiveParentSession(sources.workspaces, 'c1'), { ok: true })
  assert.deepEqual(service.archived, ['c1'])
})

test('A：归档失败码 → 文案键（子串映射；成功不提示；界面绝不裸渲染机器码）', () => {
  assert.equal(archiveHintKey({ ok: true }), null)
  assert.equal(archiveHintKey({ ok: false, code: 'archive-unavailable' }), 'rollback.rewind.archive.unavailable')
  assert.equal(archiveHintKey({ ok: false, code: 'session/active' }), 'rollback.rewind.archive.active')
  assert.equal(archiveHintKey({ ok: false, code: 'boom' }), 'rollback.rewind.archive.failed')
})

test('子会话打开：列表读不出来（判据未知）→ 仍尝试导航，不把未知说成「还没有」', async () => {
  const { navigator, opened } = fakeNavigator({ listThrows: true })
  assert.equal(await openChildSession(navigator, 'child-6'), 'opened')
  assert.deepEqual(opened, ['child-6'])
})

test('子会话打开：导航调用失败 → failed（有入口但没成功，与 degraded 是两个原因）', async () => {
  assert.equal(await openChildSession(fakeNavigator({ listed: ['child-5'], openThrows: true }).navigator, 'child-5'), 'failed')
  const unreadable = fakeNavigator({ listThrows: true, openThrows: true })
  assert.equal(await openChildSession(unreadable.navigator, 'child-5'), 'failed')
})

test('子会话打开：空 childId → degraded（防御；宿主给了 id 才调用本函数）', async () => {
  const { navigator, opened } = fakeNavigator({ listed: ['c1'] })
  assert.equal(await openChildSession(navigator, ''), 'degraded')
  assert.equal(await openChildSession(navigator, null), 'degraded')
  assert.deepEqual(opened, [])
})

test('降级键：三档各自一个键（不共用文案）', () => {
  assert.equal(childOpenHintKey('opened'), null, '打开了就不提示降级')
  const degraded = childOpenHintKey('degraded')
  const failed = childOpenHintKey('failed')
  const unavailable = childOpenHintKey('unavailable')
  assert.equal(degraded, 'chat.open.degraded')
  assert.equal(failed, 'chat.open.failed')
  assert.equal(unavailable, 'chat.open.unavailable')
  assert.equal(new Set([degraded, failed, unavailable]).size, 3, '三档不得共用一个键')
})

test('降级文案诚实（T9-F1）：没有导航入口 / 还没进列表 / 导航失败各自只说自己能证明的', () => {
  const zhUnavailable = chatZh['chat.open.unavailable']
  const zhDegraded = chatZh['chat.open.degraded']
  const zhFailed = chatZh['chat.open.failed']
  assert.ok(!zhUnavailable.includes('还没有出现在会话列表里'), '没有导航入口不得用「还没进列表」解释')
  assert.ok(!zhUnavailable.includes('会话列表'), 'no-API 文案不得谈会话列表')
  assert.ok(zhUnavailable.includes('没有可用的会话导航入口'), '必须点名真实原因')
  assert.ok(zhDegraded.includes('还没有出现在会话列表里'), '这一档只在被证实后才用，措辞要准')
  assert.ok(zhFailed.includes('失败'))
  assert.ok(!zhFailed.includes('还没有出现在会话列表里'))
  assert.notEqual(zhFailed, zhDegraded)
  const enUnavailable = chatEn['chat.open.unavailable']
  const enDegraded = chatEn['chat.open.degraded']
  assert.ok(!enUnavailable.includes('is not in the session list'), 'en：no-API 不得用 not-in-list 措辞')
  assert.ok(enDegraded.includes('is not in the session list'))
  assert.notEqual(chatEn['chat.open.failed'], enDegraded)
})

test('组件降级提示用字面量键，且与 childOpenHintKey 的映射一致（防漂移）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  for (const state of ['degraded', 'failed', 'unavailable'] as const) {
    const key = childOpenHintKey(state)
    assert.ok(key !== null)
    assert.match(dialog, new RegExp("t\\('" + key.replace(/\./g, '\\.') + "'"), '对话框必须用字面量渲染该键：' + key)
  }
})

test('服务惰取：navigationSourcesOf 只经 get()，异常/非对象一律按缺失处理', () => {
  const workspace = fakeWorkspace()
  const sessions = fakeSessions({ listed: ['c1'], refresh: true })
  const sources = navigationSourcesOf({ get: (key: string) => (key === 'uiWorkspace' ? workspace : sessions) })
  assert.equal(typeof sources.workspace?.openSession, 'function')
  assert.deepEqual(sources.sessions?.list?.getSnapshot().byId['c1'], { id: 'c1' })
  assert.equal(typeof sources.sessions?.refresh, 'function')
  assert.equal(navigationSourcesOf(undefined).workspace, undefined)
  assert.equal(navigationSourcesOf({}).workspace, undefined)
  assert.deepEqual(navigationSourcesOf({ get: () => { throw new Error('no such service') } }), { workspace: null, sessions: null, workspaces: null })
  assert.equal(navigationSourcesOf({ get: () => 42 }).workspace, null, '非对象服务按缺失处理')
  assert.equal(navigationSourcesOf({ get: () => ({}) }).sessions?.open, undefined, '没有 open 就不编一个')
  assert.equal(navigationSourcesOf({ get: () => ({}) }).workspaces, null, '没有 archiveSession 就不编一个（A 的归档能力据此降级）')
})

/* ------------------------------------------------------------ 字典 / 纪律 / 铁律 */

/** 组件 + 判定层里出现的文案键（源码级枚举，防止「用了没登记的键」）。 */
function emittedKeys(): { chat: string[]; rollback: string[] } {
  const files = readdirSync(HERE).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && f !== 'chat-locales.ts')
  const chat: string[] = []
  const rollback: string[] = []
  for (const file of files) {
    const src = readFileSync(join(HERE, file), 'utf8')
    for (const m of src.matchAll(/\bt\('(chat\.[A-Za-z0-9._]+)'/g)) chat.push(m[1] as string)
    for (const m of src.matchAll(/\brt\('(rollback\.[A-Za-z0-9._-]+)'/g)) rollback.push(m[1] as string)
  }
  return { chat: [...new Set(chat)], rollback: [...new Set(rollback)] }
}

test('聊天字典：组件发出的 chat.* 键一个不缺（zh/en 成对非空）', () => {
  const { chat } = emittedKeys()
  for (const key of chat) {
    const zhText = (chatZh as Record<string, string>)[key]
    const enText = (chatEn as Record<string, string>)[key]
    assert.ok(zhText !== undefined && zhText !== '', 'chat 字典 zh 缺键：' + key)
    assert.ok(enText !== undefined && enText !== '', 'chat 字典 en 缺键：' + key)
  }
  // 判定层会发出的三个降级键也必须在字典里（opened 无需提示）
  for (const state of ['degraded', 'failed', 'unavailable'] as const) {
    const key = childOpenHintKey(state)
    assert.ok(key !== null && key in chatZh, '降级键必须在字典 zh 里：' + String(key))
    assert.ok(key !== null && key in chatEn, '降级键必须在字典 en 里：' + String(key))
  }
  // zh/en 键集合必须完全一致（en 是镜像）
  assert.deepEqual(Object.keys(chatZh).sort(), Object.keys(chatEn).sort())
})

test('回退词汇复用 recovery 字典：组件里的 rollback.* 键必须已存在（不复制键值）', () => {
  const { rollback } = emittedKeys()
  for (const key of rollback) {
    assert.ok(zhHas(key), 'recovery 字典 zh 缺键：' + key)
    assert.ok(enHas(key), 'recovery 字典 en 缺键：' + key)
  }
  assert.ok(rollback.length > 0, '本入口必须复用回退词汇（否则就是两处真相）')
})

test('T9-F3：不可回退但没给原因键时，不得渲染成「没有可回退的内容」', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.doesNotMatch(dialog, /reasonKey \?\? 'rollback\.preview\.none'/, '不得回落成「该点没有可回退的内容」')
  assert.ok(dialog.includes("t('chat.preview.reasonUnknown')"), '必须给真实表述的「原因未知」')
  assert.ok(zhHas('chat.preview.reasonUnknown') === false, '「原因未知」属于聊天字典，不进 recovery 字典')
  assert.ok((chatZh as Record<string, string>)['chat.preview.reasonUnknown']?.includes('原因未知') === true)
  // T18 的根因修复已落在 src/ui/rollback-view.ts：canRestore=false 时 reasonKey 必有值（受保护点 → protected-point）
  const protectedVerdict = rollbackPreviewVerdict({
    ok: true, id: 'p', storage: { available: true }, canRestore: false,
    point: { id: 'p', createdAt: 1, protected: true },
  } as never)
  assert.equal(protectedVerdict.canRestore, false)
  assert.equal(protectedVerdict.reasonKey, 'rollback.code.protected-point', '受保护点的原因键由判定层给出，聊天侧自动受益')
  // 判定层的既有分派（protected / incomplete 两条）在聊天侧直接可用 —— 这里只钉「聊天不掩盖」，
  // 其余分支（guard / hostRefused / 段原因码）属于 src/ui/rollback-view.ts 自己的覆盖面，不在本文件重复断言。
  const base = { ok: true, id: 'p', storage: { available: true }, canRestore: false } as const
  const incompleteVerdict = rollbackPreviewVerdict({ ...base, point: { id: 'p', createdAt: 1, incomplete: true } } as never)
  assert.equal(incompleteVerdict.reasonKey, 'rollback.preview.reason.incomplete', '两态不全的原因键由判定层给出')
  assert.ok(zhHas(incompleteVerdict.reasonKey ?? ''), '该键必须在 recovery 字典里（聊天侧照直渲染）')
})

/**
 * 2026-10-10 用户第三条「回退预览页面我不喜欢，我希望一个简洁的页面」——
 * 源级钉住「**只**有文件列表 + 两个按钮」，同时钉住删掉的那些块**真的**不在渲染路径上
 * （键值仍留在字典里给设置页回滚卡用，所以这里断言的是**对话框源码**不引用它们）。
 */
test('简洁版：对话框只渲染文件列表 + 两个按钮，被删的块一个都不在（源级）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  // 保留：文件列表与行数、空列表那一行、结果一行摘要、失败原因 code 行
  // 2026-10-12（用户第二条要求）：这一行小节标题**去掉**了 —— 文件行自身（文件名 + 行数）已经说明一切，
  // 弹窗要的是 Cursor「Confirm Undo」那种一眼看完的观感；字典键保留（本仓既有先例：删渲染不删键）。
  assert.doesNotMatch(dialog, /rollback\.preview\.files\.title/, '「将被回退的文件」小节标题不得回到对话框')
  // 空列表那一行自 T15 起由 ui 层判定函数给出（四态：不可用 / 没记录文件 / 一致但会话回退 / 一致无事可做），
  // 所以这里钉的是**接线**（对话框调 rollbackPreviewNote 并把 noteText 上屏），键值本身钉在 ui 层与 T15 用例里。
  assert.match(dialog, /rollbackPreviewNote\(\{/, '空列表文案必须走 ui 层的四态判定（一处实现）')
  assert.match(dialog, /noteText !== null \? <div className=\{css\.hint\}>\{noteText\}<\/div> : null/, '空列表必须把判定结果上屏（key=null 时才不说话）')
  assert.match(dialog, /readRollbackPreviewFiles\(/, '文件列表必须取自 E1 的 preview.workspace.files')
  assert.match(dialog, /chatRewindSummary\(/, '结果必须走一行摘要')
  assert.match(dialog, /chatRewindFailure\(/, '失败原因必须走同一个判定点')
  assert.match(dialog, /rollback\.preview\.result\.code/, 'code 必须如实显示（不裸渲染机器码）')
  assert.match(dialog, /chat\.rewind\.submit/, '主按钮文案必须是简洁版那一句')
  // 删除：三选一 mode 单选 / 两态不全放行勾选 / 二次确认勾选 / 工作区·会话计数面板 /
  //       救援点说明段 / 逐段结果详情面板（失败时只留一行摘要 + 原因）
  // 2026-10-12 用户第 1 条**有意加回一颗**选择框：「回退文件的更改」（勾 = 文件与对话一起退、
  // 取消 = 只退对话）。它只置 `mode`，**不是**二次确认勾选 —— 确认仍只由点主按钮那一刻置位。
  // 因此这里不再用「/Checkbox/ 一律不得出现」的粗判，改为**点名禁掉那三样旧控件**，
  // 并把「恰好一颗、且只画那一句文案」作为正向断言（见下面第 1 条那组）。
  for (const gone of [
    /modeOptions/, /modeReachable/, /radioLabel/, /type="radio"/,
    /rollback\.rewind\.allowPartial/, /rollback\.rewind\.confirm/, /rollback\.guard\.require/,
    /rollbackPreviewRows\(/, /rollbackRewindRows\(/, /noticeKeys/, /rollbackPreviewGuidance\(/,
    /rollback\.preview\.hint/, /rollback\.preview\.warningsTitle/,
  ]) {
    assert.doesNotMatch(dialog, gone, '已删除的块不得回到对话框：' + String(gone))
  }
  // 2026-10-12 用户第 1/2/6/7 条的接线（源级；行为级在各自单测里）
  assert.equal([...dialog.matchAll(/<Checkbox\b/g)].length, 1, '顶部必须**恰好一颗**选择框（回退文件的更改）')
  assert.match(dialog, /t\('chat\.preview\.revertFiles'\)/, '选择框文案必须走字典（不得硬编码）')
  assert.match(dialog, /setRevertFiles\(previous, next\)/, '选择框只置 mode（唯一的 mode 置位入口）')
  // 2026-10-12：清单的**渲染**搬进了共享组件 src/client/recovery/RollbackFileChanges.tsx（聊天预览与
  // 设置页回滚卡的预览共用同一份）。结构 / 诚实边界 / 点文件名跳转的源码守卫随之落到那里
  // （src/client/recovery/rollback-file-changes.test.ts）；这里只留「对话框把数据与查看通道交下去」。
  assert.match(dialog, /<RollbackFileChanges/, '清单必须走共享组件（两处预览同一份渲染）')
  assert.match(dialog, /renderFileIcon=\{renderFileIcon\}/, '外部图标来源必须交给共享组件')
  assert.match(dialog, /onView: view,/, '点文件名必须走同一个 view()（唯一打开入口）')
  assert.match(dialog, /readRollbackPreviewRemovals\(/, '删除行必须取自引擎的删除集 removals（与执行阶段同一份规划）')
  // 底部只有两个按钮：主按钮（回退）+ 取消/关闭（T13 非回归项：底部**恰好 2 个**）
  const footer = dialog.slice(dialog.indexOf('css.dialogFooter'))
  assert.equal([...footer.matchAll(/<Button\b/g)].length, 2, '弹窗底部必须恰好 2 个按钮（回退 + 取消/关闭）')
  const buttons = [...dialog.matchAll(/<Button\b/g)].length
  assert.equal(buttons, 3, '全弹窗 3 个按钮 = 底部 2 个 + 子会话「打开」（有 fork 时才有）')
})

/**
 * 2026-10-12 用户第 8 条「移除回退弹窗中的所有描述」（例：这些文件的行数没有统计出来…）——
 * 源级钉住两处描述性文案**真的**不在渲染路径上；键值仍留在字典里（删渲染不删键，本仓既有先例）。
 */
test('描述清零：说明行与「行数未统计」说明段不再渲染，键值照旧保留（源级）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.doesNotMatch(dialog, /chat\.preview\.summary/, '「这次回退会做以下改动：」说明行不得回到对话框')
  assert.doesNotMatch(dialog, /rollback\.preview\.file\.unknownHint/, '「这些文件的行数没有统计出来…」整段不得回到对话框')
  assert.doesNotMatch(dialog, /chatFileChangeAvailable/, '没有任何可信行数时不再另加一句说明（该函数在对话框里已无用途）')
  // 删渲染不删键：两键仍须 zh / en 成对存在（页面别处要拿还能拿）
  assert.equal(typeof (chatZh as Record<string, string>)['chat.preview.summary'], 'string', '聊天字典 zh 必须保留 chat.preview.summary')
  assert.equal(typeof (chatEn as Record<string, string>)['chat.preview.summary'], 'string', '聊天字典 en 必须保留 chat.preview.summary')
  assert.equal(typeof (recoveryZh as Record<string, string>)['rollback.preview.file.unknownHint'], 'string', 'recovery 字典 zh 必须保留 unknownHint')
  assert.equal(typeof (recoveryEn as Record<string, string>)['rollback.preview.file.unknownHint'], 'string', 'recovery 字典 en 必须保留 unknownHint')
})

/**
 * 2026-10-12 第二轮（用户「弹窗 UI 太丑」）：这一屏补三件事 ——
 *  ① 汇总条（数字，不是描述句）；② 文件行三列对齐（grid）+ 目录弱化前缀；③ 取消勾选不再把整份清单变半透明。
 * 这里钉**接线**（判据在 src/ui/rollback-view.ts 与 css-scale-guard 各自的单测里）；文案逐字钉在本文件
 * 已有的「聊天字典：组件发出的 chat.* 键一个不缺」那条（emittedKeys 会扫到新键，zh/en 缺一即红）。
 */
test('第二轮版式：汇总条 + 三列对齐 + 目录前缀 + 取消勾选不再整块变暗（源级）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  // ① 汇总：三个数字同一份口径（rollbackPreviewScope），且挂在被它管辖的选择框那一行
  assert.match(dialog, /rollbackPreviewScope\(files, removals\)/, '汇总必须走 ui 层唯一实现（口径与文件行同源）')
  assert.match(dialog, /t\('chat\.preview\.scope\.files', \{ n: String\(scope\.files\) \}\)/, '汇总里「几个文件」必须走字典')
  assert.match(dialog, /chat\.preview\.scope\.off/, '取消勾选时必须改写那句话（而不是整块变暗）')
  assert.match(dialog, /className=\{css\.previewScope\}/, '汇总必须是 .previewScope（选择框同行的右对齐块）')
  // ② 三列对齐 + 容器（散行贴在一起时读不出「这是一份清单」）：结构在共享组件里，断言也落在
  // 共享组件那份守卫上（src/client/recovery/rollback-file-changes.test.ts）。
  assert.match(dialog, /<RollbackFileChanges/, '清单容器 / 行结构必须来自共享组件')
  // ③ 取消勾选：唯一的 data-off 挂在汇总条上 —— 清单**不得**再有 [data-off] 整块降透明
  assert.equal([...dialog.matchAll(/data-off/g)].length, 1, 'data-off 只允许出现在汇总条上一处（清单不再整块变暗）')
  assert.doesNotMatch(dialog, /reasonList\[data-off/, '旧做法（清单降透明度）不得回来')
})

test('结果一行摘要：nothing-to-restore 是**成功**（不是失败），其余走既有 outcome 徽章', () => {
  assert.equal(ROLLBACK_NOTHING_TO_RESTORE_KEY, 'rollback.preview.result.noop')
  const noop = chatRewindSummary({ ok: true, outcome: 'restored', code: 'nothing-to-restore' } as never)
  assert.deepEqual(noop, { kind: 'noop', key: ROLLBACK_NOTHING_TO_RESTORE_KEY })
  assert.equal(chatRewindSummary({ ok: true, outcome: 'restored', code: 'ok' } as never).kind, 'plain')
  assert.equal(chatRewindSummary({ ok: false, outcome: 'failed', code: 'restore-failed' } as never).kind, 'plain', '真失败走 outcome 徽章，不冒充 noop')
  assert.deepEqual(chatRewindSummary(null), { kind: 'plain', key: null })
  assert.ok(zhHas(ROLLBACK_NOTHING_TO_RESTORE_KEY) && enHas(ROLLBACK_NOTHING_TO_RESTORE_KEY), 'noop 文案键必须在 recovery 字典 zh/en 里')
  assert.ok((recoveryZh as Record<string, string>)[ROLLBACK_NOTHING_TO_RESTORE_KEY]?.includes('无需恢复') === true, 'zh 逐字：工作区与该回退点一致，无需恢复')
})

/* ------------------------------------------------------------ T13/F2：只有真失败才渲染失败原因盒 */

test('T13/F2 结果种类 → 是否渲染失败原因盒（判据只看 outcome/status/code，不解析 detail）', () => {
  const cases: { name: string; result: unknown; expect: boolean }[] = [
    { name: 'null（还没提交）', result: null, expect: false },
    // —— 成功 / 无需恢复：一律不渲染（F2 的缺陷就是这几种也弹了失败盒）——
    { name: '③ restored + nothing-to-restore（全部一致）', result: { ok: true, outcome: 'restored', code: 'nothing-to-restore', segments: [{ state: 'workspace', status: 'restored', reasonCode: 'nothing-to-restore', restored: 0 }] }, expect: false },
    { name: '② restored + nothing-to-restore（no-recorded-files）', result: { ok: true, outcome: 'restored', code: 'nothing-to-restore', segments: [{ state: 'workspace', status: 'restored', reasonCode: ROLLBACK_NO_RECORDED_FILES_CODE, restored: 0 }] }, expect: false },
    // ① 被跳过的段（含 capture-failed 这类 reasonCode）是「该态没有可用捕获」，不是回退失败
    { name: '① restored + nothing-to-restore（skipped 段 reasonCode=capture-failed）', result: { ok: true, outcome: 'restored', code: 'nothing-to-restore', segments: [{ state: 'workspace', status: 'skipped', reasonCode: 'capture-failed' }] }, expect: false },
    { name: 'restored + ok（真的恢复了）', result: { ok: true, outcome: 'restored', code: 'ok', segments: [{ state: 'workspace', status: 'restored', restored: 3 }] }, expect: false },
    { name: 'partial + ok（只有 skipped，没有 failed）', result: { ok: true, outcome: 'partial', code: 'ok', segments: [{ state: 'workspace', status: 'restored', restored: 2 }, { state: 'session', status: 'skipped', reasonCode: 'session-missing' }] }, expect: false },
    { name: '未知 outcome 且无失败证据（不猜）', result: { ok: true, outcome: 'weird', code: 'weird-code', segments: [{ state: 'workspace', status: 'restored', restored: 1 }] }, expect: false },
    // —— 真失败：渲染原因行 ——
    { name: 'failed + restore-failed', result: { ok: false, outcome: 'failed', code: 'restore-failed', detail: 'boom', segments: [{ state: 'workspace', status: 'failed', reasonCode: 'restore-failed' }] }, expect: true },
    { name: 'denied（零写入拒绝）', result: { ok: false, outcome: 'denied', code: 'protected-point' }, expect: true },
    { name: 'partial + 段级 failed', result: { ok: true, outcome: 'partial', code: 'ok', segments: [{ state: 'workspace', status: 'restored', restored: 2 }, { state: 'session', status: 'failed', reasonCode: 'fork-failed' }] }, expect: true },
    { name: 'restored 但顶层是 guard-failed（*-failed 码）', result: { ok: false, outcome: 'restored', code: 'guard-failed' }, expect: true },
    { name: 'failed + ledger-write-failed', result: { ok: false, outcome: 'failed', code: 'ledger-write-failed' }, expect: true },
  ]
  for (const item of cases) {
    assert.equal(chatRewindFailed(item.result as never), item.expect, item.name)
  }
})

test('T13/F2 对话框接线：失败原因盒必须由 chatRewindFailed 门控（不得无条件渲染）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /const failed = chatRewindFailed\(result\)/, '对话框必须先算 failed')
  assert.match(dialog, /\{failed && \(failure\.keys\.length > 0 \|\| failure\.detail !== null\)/, '失败盒必须带 failed 门控')
  assert.doesNotMatch(dialog, /\{failure\.keys\.length > 0 && \(/, '不得再出现无门控的失败盒（F2 的根因）')
})

/* ------------------------------------------------------------ T11：三情形纯分派（①②③） */

const summaryKeys = (): { noop: string; noRecord: string; noFiles: string } => ({
  noop: 'rollback.preview.result.noop',
  noRecord: 'rollback.preview.result.noRecord',
  noFiles: 'rollback.preview.result.noFiles',
})

test('T11 ① 存在 status===skipped 的段 ⇒ 「没有可用的记录（原因：该段 code 键）」，绝不说成「一致」', () => {
  const keys = summaryKeys()
  const skipped = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [
      { state: 'workspace', status: 'restored', reasonCode: 'nothing-to-restore', restored: 0 },
      { state: 'session', status: 'skipped', reasonCode: 'session-missing' },
    ],
  } as never)
  assert.deepEqual(skipped, { kind: 'no-record', key: keys.noRecord, reasonKey: 'rollback.code.session-missing' })
  assert.notEqual((skipped as { key: string }).key, keys.noop, '① 不得渲染成「与该点一致」')
  // 原因键必须走字典映射：未知码回落 unknown（不裸渲染机器码）
  const unknown = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'skipped', reasonCode: 'brand-new-code' }],
  } as never)
  assert.equal((unknown as { reasonKey: string }).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY)
  // 段没给 reasonCode（怪形状）同样回落 unknown，而不是编一个原因
  const noCode = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'skipped' }],
  } as never)
  assert.equal((noCode as { reasonKey: string }).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY)
  // 多个 skipped 段 ⇒ 取**第一个**（顺序确定，不猜归属）
  const first = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [
      { state: 'workspace', status: 'skipped', reasonCode: 'no-chunks' },
      { state: 'session', status: 'skipped', reasonCode: 'session-missing' },
    ],
  } as never)
  assert.equal((first as { reasonKey: string }).reasonKey, 'rollback.code.no-chunks')
})

test('T11 ② 存在 reasonCode===no-recorded-files 的段 ⇒ 「没有记录任何文件」（与 ③ 分开）', () => {
  const keys = summaryKeys()
  const noFiles = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'restored', reasonCode: ROLLBACK_NO_RECORDED_FILES_CODE, restored: 0 }],
  } as never)
  assert.deepEqual(noFiles, { kind: 'no-files', key: keys.noFiles })
  assert.equal(ROLLBACK_NO_RECORDED_FILES_CODE, 'no-recorded-files', '引擎码名必须逐字（改名即红）')
  // ③ 记录了条目且全部已一致（reasonCode=nothing-to-restore）⇒ 仍是「与该点一致」
  const consistent = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [
      { state: 'workspace', status: 'restored', reasonCode: 'nothing-to-restore', restored: 0 },
      { state: 'session', status: 'restored', reasonCode: 'nothing-to-restore', restored: 0 },
    ],
  } as never)
  assert.deepEqual(consistent, { kind: 'noop', key: keys.noop })
  // 优先级：① 先于 ②（同时存在 skipped 段与 no-recorded-files 段 ⇒ 说「没有可用的记录」）
  const both = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [
      { state: 'workspace', status: 'restored', reasonCode: ROLLBACK_NO_RECORDED_FILES_CODE, restored: 0 },
      { state: 'session', status: 'skipped', reasonCode: 'no-boundary' },
    ],
  } as never)
  assert.equal(both.kind, 'no-record')
  assert.equal((both as { reasonKey: string }).reasonKey, 'rollback.code.no-boundary')
})

test('T11 分派只读 status/reasonCode：**绝不解析 detail**（同 detail 不同 status ⇒ 不同结论）', () => {
  const keys = summaryKeys()
  // 两条结果的 detail 完全一样、只有 status 不同 ⇒ 结论必须不同（若实现偷看 detail 就会同形）
  const detail = ['unchanged=353 nothingToDo=true']
  const asSkipped = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'skipped', reasonCode: 'capture-failed', detail }],
  } as never)
  const asConsistent = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'restored', reasonCode: 'nothing-to-restore', restored: 0, detail }],
  } as never)
  assert.equal(asSkipped.kind, 'no-record')
  assert.deepEqual(asConsistent, { kind: 'noop', key: keys.noop })
  // 反过来：detail 不同、status/reasonCode 相同 ⇒ 结论必须相同
  const a = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'restored', reasonCode: ROLLBACK_NO_RECORDED_FILES_CODE, restored: 0, detail: ['files=0 nothingToDo=true'] }],
  } as never)
  const b = chatRewindSummary({
    ok: true, outcome: 'restored', code: 'nothing-to-restore',
    segments: [{ state: 'workspace', status: 'restored', reasonCode: ROLLBACK_NO_RECORDED_FILES_CODE, restored: 0, detail: ['随便什么技术细节'] }],
  } as never)
  assert.deepEqual(a, b)
  // 只有顶层 code === 'nothing-to-restore' 才走这套：partial（真的动了东西）不得说「无需恢复」
  assert.equal(chatRewindSummary({
    ok: true, outcome: 'partial', code: 'ok',
    segments: [{ state: 'workspace', status: 'restored', restored: 2 }, { state: 'session', status: 'skipped', reasonCode: 'session-missing' }],
  } as never).kind, 'plain')
})

test('T11 对话框接线：no-record 摘要必须把**原因键的文本**插进 {reason}（不是键名、不是机器码）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /summary\.kind === 'no-record'/, '对话框必须按 no-record 分支走带原因的渲染')
  assert.match(dialog, /reason: rt\(rk\(summary\.reasonKey\)\)/, '插值必须是该原因键**翻译后**的文本')
  assert.doesNotMatch(dialog, /reason: summary\.reasonKey/, '不得把字典键名（或机器码）当文案插进去')
  assert.doesNotMatch(dialog, /reason: code\b/, '不得把裸机器码当文案插进去')
})

/* ------------------------------------------------------------ T15：预览态四句（实测渲染句）+ 假尾句禁令 */

/** 与对话框同一渲染规则：把 rollbackPreviewNote 的结果渲染成**实测句**（含 {reason} 插值）。 */
function renderPreviewNote(note: { key: string | null; reasonKey: string | null }): string | null {
  if (note.key === null) return null
  const dict = recoveryZh as Record<string, string>
  const sentence = dict[note.key] ?? ''
  if (note.reasonKey === null) return sentence
  return sentence.replace('{reason}', dict[note.reasonKey] ?? '')
}

test('T15 预览态四态：四种 preview 形状渲染出四句互不相同的话（集合 size=4）', () => {
  const shapes = {
    // (a) 工作区态不可用
    a: { workspace: { available: false, reasonCode: 'chunk-not-found' }, session: { restorable: false } },
    // (b) available 且 overwrite===0（该点没记录任何文件）
    b: { workspace: { available: true, overwrite: 0, different: 0 }, session: { restorable: false } },
    // (c) 工作区一致但会话仍会回退 ⇒ 不得出现「无需恢复」
    c: { workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: true } },
    // (d) 工作区一致且会话也不可回退
    d: { workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: false } },
  }
  const rendered = {
    a: renderPreviewNote(rollbackPreviewNote(shapes.a as never)),
    b: renderPreviewNote(rollbackPreviewNote(shapes.b as never)),
    c: renderPreviewNote(rollbackPreviewNote(shapes.c as never)),
    d: renderPreviewNote(rollbackPreviewNote(shapes.d as never)),
  }
  for (const [name, sentence] of Object.entries(rendered)) assert.ok(sentence !== null && sentence !== '', name + ' 必须有可上屏的句子')
  assert.equal(new Set(Object.values(rendered)).size, 4, '四种情形的实测句必须两两不同：' + JSON.stringify(rendered))
  // (b) 与结果态的「没有记录任何文件」共用同一句（同字典键）
  assert.equal(rendered.b, (recoveryZh as Record<string, string>)['rollback.preview.result.noFiles'])
  // (c) 只说工作区 + 会话仍会回退；**不含**「无需恢复」
  assert.ok(rendered.c !== null && !rendered.c.includes('无需恢复'), '(c) 是假尾句的典型：不得含「无需恢复」')
  assert.ok(rendered.c !== null && rendered.c.includes('会话仍会回退到该点之前'))
  // (d) 才说「无需恢复」
  assert.ok(rendered.d !== null && rendered.d.includes('无需恢复'))
})

test('T15 假尾句禁令（句子层面）：凡 changesSomething=true，实测句一律不含「无需恢复」', () => {
  const shapes = [
    { workspace: { available: false, reasonCode: 'chunk-not-found' }, session: { restorable: true } },
    { workspace: { available: true, overwrite: 0, different: 0 }, session: { restorable: true } },
    { workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: true } },
    { workspace: { available: true, overwrite: 5, different: 2 }, session: { restorable: true } },
    { workspace: null, session: { restorable: true } },
  ]
  for (const shape of shapes) {
    const note = rollbackPreviewNote(shape as never)
    assert.equal(note.changesSomething, true, '这些形状点下去都会改动什么：' + JSON.stringify(shape))
    const sentence = renderPreviewNote(note)
    if (sentence === null) continue
    assert.ok(!sentence.includes('无需恢复'), '假尾句禁令：' + JSON.stringify(shape) + ' → ' + sentence)
  }
})

test('T15 形状 (d) 断言：workspace 一致 + session.restorable=true → 句不含「无需恢复」，且已确认草稿的 wire 侧提交判据为 true', () => {
  const preview: RollbackPreviewResult = {
    ok: true, id: 'p', storage: { available: true }, canRestore: true,
    workspace: { available: true, overwrite: 5, different: 0 },
    session: { restorable: true },
  }
  const verdict = rollbackPreviewVerdict(preview)
  assert.equal(verdict.canRestore, true)
  const note = rollbackPreviewNote({ workspace: preview.workspace, session: preview.session, canRestore: verdict.canRestore })
  const sentence = renderPreviewNote(note)
  assert.ok(sentence !== null && !sentence.includes('无需恢复'), '(d) 形状不得含「无需恢复」：' + String(sentence))
  // F1/F5：这里断言的是 **wire 侧提交判据**（canSubmitRewind 要求恰好 confirmed），**不是**「按钮可点」。
  // `confirmedDraft()` 是真实 UI **永远到不了**的状态（初始草稿恒未确认、确认只在点击那一刻置位），
  // 拿它主张可点性正是 R1 缺陷被夹具掩盖的方式。可点性一律由 enablement 判据断言（见下面的 R1/R2 用例）。
  assert.equal(canSubmitRewind(confirmedDraft(), preview), true, '已确认草稿下 wire 侧提交判据为 true')
})

/* ---------------------------------------------- R1：enablement 与确认判据分离（主按钮永久禁用的根因） */

/**
 * 用户截图那一屏（preview 四态里的 ③a）：工作区与该回退点一致（**无文件变更** —— `files` 为空、
 * `different` / `missing` 为 0）+ 会话仍可回退（`session.restorable === true`）。
 * 真机缺陷现场就是这一屏：文案正常、主按钮却灰色不可点。
 */
const screenshotPreview = (): RollbackPreviewResult => ({
  ok: true, id: 'p', storage: { available: true }, canRestore: true,
  workspace: { available: true, overwrite: 5, different: 0, missing: 0, createdAfter: 0, skippedCount: 0, truncated: false, files: [] },
  session: { available: true, restorable: true },
} as RollbackPreviewResult)

/** 工作区**真会写文件**的一屏（文件列表非空 + 会话可回退）。 */
const filesPreview = (): RollbackPreviewResult => ({
  ok: true, id: 'p', storage: { available: true }, canRestore: true,
  workspace: { available: true, overwrite: 2, different: 1, missing: 0 },
  session: { available: true, restorable: true },
} as RollbackPreviewResult)

/** 只有会话段可回退的一屏（工作区态没有可用记录）。 */
const sessionOnlyPreview = (): RollbackPreviewResult => ({
  ok: true, id: 'p', storage: { available: true }, canRestore: true,
  workspace: { available: false, reasonCode: 'nothing-to-restore' },
  session: { available: true, restorable: true },
} as RollbackPreviewResult)

test('R1 可点性回归（**真实初始态**）：defaultDraft(preview)（confirmed:false）+ canRestore ⇒ 主按钮可点', () => {
  for (const build of [screenshotPreview, filesPreview, sessionOnlyPreview]) {
    const preview = build()
    // 真实初始态 = defaultDraft（未确认）。断言**不得**再用 confirmedDraft() 夹具 —— 那正是掩盖本缺陷的原因。
    const draft = defaultDraft(preview)
    assert.equal(draft.confirmed, false, '对话框初始草稿必须未确认')
    assert.equal(rollbackPreviewVerdict(preview).canRestore, true, '前提：这些预览宿主允许回退')
    assert.equal(rewindSubmittable(draft, preview), true, '真实初始态下主按钮必须可点（旧实现恒为 false）')
    // enablement 与确认彻底无关：confirmed 取任何值都不改变可点性
    for (const bogus of [undefined, false, 0, 1, 'true', null]) {
      const weird = { ...draft, confirmed: bogus as unknown as boolean }
      assert.equal(rewindSubmittable(weird, preview), true, 'enablement 不得看 confirmed：' + String(bogus))
    }
    assert.equal(confirmOnSubmit(draft)?.confirmed, true, '确认仍只能由 confirmOnSubmit 置位')
  }
})

test('R1 源级：对话框的 submitEnabled 走 enablement 判据，不依赖 draft.confirmed（绑定细节见 R2/F2）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /const submitEnabled = submitButtonEnabled\(\{[^}]*pointId[^}]*\}\)/, 'enablement 必须走 submitButtonEnabled（不含确认、含 pointId）')
  assert.doesNotMatch(dialog, /submitEnabled = canSubmitRewind\(/, 'submitEnabled 不得再用「要求 confirmed」的提交判据（循环依赖的根因）')
  assert.doesNotMatch(dialog, /submitEnabled = [^\n]*draft\.confirmed/, 'submitEnabled 不得直接读 draft.confirmed')
})

test('R1 确认门未松：可点 ≠ 已确认；未确认仍 blocked 且端口零调用，点一次才 userConfirmed=true', async () => {
  const preview = screenshotPreview()
  const { port, calls } = fakePort()
  const draft = defaultDraft(preview)
  assert.equal(rewindSubmittable(draft, preview), true, '按钮可点')
  assert.equal(canSubmitRewind(draft, preview), false, '但提交判据仍要求 confirmed（确认门一字未松）')
  // 同一份判据的不变量：提交 = enablement + 恰好 confirmed
  assert.equal(canSubmitRewind(confirmOnSubmit(draft) as RewindDraft, preview), rewindSubmittable(draft, preview))
  assert.equal(buildRewindOptions(draft), null, '未确认时请求体都不成形')
  const blocked = await requestRewind(port, 'point-1', draft)
  assert.equal(blocked.kind, 'blocked')
  assert.equal(calls.length, 0, '未确认时端口零调用')
  // 点一次 = confirmOnSubmit 置位 ⇒ 请求体 userConfirmed 恰好 true，端口恰好一次
  const clicked = confirmOnSubmit(draft) as RewindDraft
  assert.equal(clicked.confirmed, true)
  assert.equal(draft.confirmed, false, '原草稿不被就地改写（React 状态更新语义）')
  assert.equal(canSubmitRewind(clicked, preview), true)
  assert.deepEqual(buildRewindOptions(clicked), { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
  const attempt = await requestRewind(port, 'point-1', clicked)
  assert.equal(attempt.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.options, { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
})

test('R1 不放宽：canRestore=false 的点（受保护 / 两态不全 / 无可用段）enablement 仍必须 false', () => {
  const base = { ok: true, id: 'p', storage: { available: true } } as const
  const cases: { name: string; preview: RollbackPreviewResult | null }[] = [
    { name: '受保护点', preview: { ...base, canRestore: false, workspace: { available: true }, session: { available: true, restorable: true }, point: { id: 'p', createdAt: 1, protected: true } } as never },
    { name: '两态不全的点', preview: { ...base, canRestore: false, workspace: { available: true }, session: { available: true, restorable: true }, point: { id: 'p', createdAt: 1, incomplete: true } } as never },
    { name: '两段都不可回退', preview: { ...base, canRestore: true, workspace: { available: false }, session: { available: false, restorable: false } } as never },
    { name: 'preview 为 null', preview: null },
  ]
  for (const item of cases) {
    assert.equal(rollbackPreviewVerdict(item.preview).canRestore, false, '前提：该形状不可回退 —— ' + item.name)
    const draft = defaultDraft(item.preview)
    assert.equal(rewindSubmittable(draft, item.preview), false, '不可回退的点主按钮必须仍禁用（' + item.name + '）')
    assert.equal(canSubmitRewind(confirmOnSubmit(draft) as RewindDraft, item.preview), false, '确认之后也仍不可提交（' + item.name + '）')
  }
  assert.equal(rewindSubmittable(null, screenshotPreview()), false, 'draft=null 不可点')
  assert.equal(rewindSubmittable({ ...defaultDraft(null), mode: 'nope' as never }, screenshotPreview()), false, '段集合为空不可点')
})

test('R1 用户截图那一屏（③a）：文件列表为空 + 会话仍可回退 ⇒ 可点，点下去真会 fork 子会话', async () => {
  const preview = screenshotPreview()
  const verdict = rollbackPreviewVerdict(preview)
  assert.equal(verdict.canRestore, true)
  const note = rollbackPreviewNote({ workspace: preview.workspace, session: preview.session, canRestore: verdict.canRestore })
  assert.equal(note.kind, 'workspace-consistent-session', '这就是截图那一屏（工作区一致 + 会话仍会回退）')
  assert.equal(readRollbackPreviewFiles(preview.workspace).length, 0, '工作区无文件变更 ⇒ 文件列表为空')
  const draft = defaultDraft(preview)
  assert.equal(rewindSubmittable(draft, preview), true, '截图那一屏主按钮必须可点')
  assert.equal(submitButtonEnabled({ draft, preview, pointId: 'point-1', busy: false }), true, '对话框主按钮（含 pointId / busy 维度）也必须可点')
  const { port, calls } = fakePort()
  const attempt = await requestRewind(port, 'point-1', confirmOnSubmit(draft) as RewindDraft)
  assert.equal(attempt.kind, 'ok')
  assert.equal(calls.length, 1)
  const child = attempt.kind === 'ok' ? rollbackChildSession(attempt.result) : null
  assert.equal(child?.id, 'child-1', '点下去真会 fork 子会话（结果带回 childSessionId）')
})

/* ------------------------------------- R2：把判据绑到按钮（t3 F2）+ 幂等（F4）+ 维度对齐（F3） */

/**
 * footer 段里的 **Button 元素**（逐个截成独立字符串）。
 *
 * t7 的 R2-F2-01 根因：旧守卫判的是「footer 这段文本里**出现过**该字符串」，不要求它落在
 * **主按钮元素**上 ⇒ 把 `disabled={!submitEnabled}` 挪到取消按钮、主按钮改 `disabled={false}`（M9）
 * 或 `disabled={busy}`（M9b）时仍全绿 —— 主按钮变成无条件可点，正是 t3-F2 的 M2 缺陷原样复活。
 * 所以必须先按元素切分，再在**元素内**判绑定。
 */
function footerButtonElements(source: string): string[] {
  const footer = source.slice(source.indexOf('css.dialogFooter'))
  const elements: string[] = []
  let cursor = 0
  for (;;) {
    const start = footer.indexOf('<Button', cursor)
    if (start === -1) break
    const end = footer.indexOf('</Button>', start)
    if (end === -1) break
    elements.push(footer.slice(start, end + '</Button>'.length))
    cursor = end + '</Button>'.length
  }
  return elements
}

/** 主按钮元素（footer 里带 `variant="primary"` 的那一个）；找不到 ⇒ null（守卫按失败处理）。 */
function primaryButtonElement(source: string): string | null {
  return footerButtonElements(source).find((el) => el.includes('variant="primary"')) ?? null
}

/** 取消/关闭按钮元素（footer 里带 `onClose` 的那一个）。 */
function cancelButtonElement(source: string): string | null {
  return footerButtonElements(source).find((el) => el.includes('onClose')) ?? null
}

/**
 * 「判据 → **主按钮元素**」的绑定判据（对源码文本求值，**位置敏感**）。抽成函数是为了做**反向自检**：
 * 对注入式改坏的源码必须返回 false，否则这条守卫只是「文本存在」式的假绿（t3 F2 的初衷 / t7 R2-F2-01）。
 *
 * 为什么只能源码级：本仓没有 DOM 测试环境（无 jsdom / react-test-renderer，bundle 依赖 DSH 运行时），
 * 组件无法在 node:test 里渲染 ⇒「判据绑到按钮」只能断言源码结构；但断言必须能被变异打红。
 */
function submitButtonBound(source: string): boolean {
  const primary = primaryButtonElement(source)
  if (primary === null) return false
  // 位置敏感：两样都必须落在**主按钮元素内**（M9/M9b 把 disabled 挪到取消按钮 ⇒ 这里不成立）
  if (!/disabled=\{!submitEnabled\}/.test(primary)) return false
  if (!/onClick=\{\(\) => \{ void submit\(\) \}\}/.test(primary)) return false
  // enablement 判据本身必须是含 pointId 的那一份（t3 F3）
  return /const submitEnabled = submitButtonEnabled\(\{[^}]*pointId[^}]*\}\)/.test(source)
}

/** 复刻 t7 探针 `probe-binding-guard.mjs` 的变异写法：先保护取消按钮，只改主按钮那一处，再写回取消按钮文本。 */
const DIALOG_PRIMARY_TEXT = 'disabled={!submitEnabled}'
const DIALOG_CANCEL_TEXT = 'disabled={busy} onClick={onClose}'
function mutateButtons(source: string, primary: string, cancel: string): string {
  return source
    .split(DIALOG_CANCEL_TEXT).join('@@CANCEL@@')
    .replace(DIALOG_PRIMARY_TEXT, primary)
    .split('@@CANCEL@@').join(cancel)
}

test('R2/F2 + R3 判据绑到**主按钮元素**（位置敏感；变异矩阵 M1/M2/M9/M9b/M3/M4 红、M9c 绿）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.equal(submitButtonBound(dialog), true, 'BASE：主按钮元素同时受 enablement 门与 submit 回调约束，且 enablement 走含 pointId 的判据')
  // 反向断言：enablement 门只由**主按钮**承担 —— 取消按钮不得绑定 submit（它只负责关闭）；
  // 且「同一文本**只**出现在取消按钮上」不构成绑定（下面 M9/M9b 两格：守卫必须判失败）。
  // ⚠️ 这里**不能**写成「取消按钮文本上不得出现该串」：那会把 M9c（无害冗余）判红，
  //    与要求的变异矩阵（M9c 必须仍绿）冲突 —— 已实测。位置敏感的正确形态是
  //    「**主按钮元素内必须有**」，而不是「别处不许有」。
  const primary = primaryButtonElement(dialog)
  const cancel = cancelButtonElement(dialog)
  assert.ok(primary !== null, 'footer 必须有主按钮元素')
  assert.ok(cancel !== null, 'footer 必须有取消/关闭按钮元素')
  assert.match(primary, /disabled=\{!submitEnabled\}/)
  assert.match(primary, /onClick=\{\(\) => \{ void submit\(\) \}\}/)
  assert.doesNotMatch(cancel, /void submit\(\)/, '取消按钮不得绑定 submit（它只负责关闭）')
  // —— 变异矩阵（in-memory 副本，不动工作树；RED = 守卫必须 false）——
  const red: [string, string, string][] = [
    ['M1  主按钮 → disabled={busy}（取消按钮不动）', 'disabled={busy}', DIALOG_CANCEL_TEXT],
    ['M2  主按钮 → disabled={false}（取消按钮不动）', 'disabled={false}', DIALOG_CANCEL_TEXT],
    ['M9  主按钮 → disabled={false}，文本挪到取消按钮', 'disabled={false}', 'disabled={!submitEnabled} onClick={onClose}'],
    ['M9b 主按钮 → disabled={busy}，文本挪到取消按钮', 'disabled={busy}', 'disabled={!submitEnabled} onClick={onClose}'],
    ['M1b 主按钮 → disabled={submitEnabled}（门反了）', 'disabled={submitEnabled}', DIALOG_CANCEL_TEXT],
    ['M1c 主按钮 → disabled={!rewindSubmittable(draft, preview)}（丢掉 pointId/busy 维度）', 'disabled={!rewindSubmittable(draft, preview)}', DIALOG_CANCEL_TEXT],
  ]
  for (const [name, primaryText, cancelText] of red) {
    const mutated = mutateButtons(dialog, primaryText, cancelText)
    assert.notEqual(mutated, dialog, '变异必须真的改到源码：' + name)
    assert.equal(submitButtonBound(mutated), false, '变异必须打红：' + name)
  }
  // M9c：主按钮不动、取消按钮**多写一份同样的文本**（纯冗余）⇒ 守卫必须**仍绿**。
  // 注意（与验收措辞的取舍）：因此「取消按钮文本上不得出现该串」**不能**作为守卫条件 —— 那会把
  // 无害冗余判红（t7 记录的 M9c 过敏）。位置敏感的正确形态是「**主按钮元素内必须有**」，
  // 而不是「别处不许有」；反向断言落在 BASE 上（取消按钮本来就不带），不落在变异态上。
  const m9c = mutateButtons(dialog, DIALOG_PRIMARY_TEXT, 'disabled={!submitEnabled} onClick={onClose}')
  // 幂等写法（不给 notEqual 前置）：本用例必须**在 M9c 形态的副本上也成立** —— 那时这次「变异」
  // 是 no-op，要求它「真的改到源码」会把无害冗余判红，正是 t7 记录的 M9c 过敏。这里改为断言
  // 「取消按钮确实带上了该文本」+「守卫仍为 true」。
  assert.match(cancelButtonElement(m9c) ?? '', /disabled=\{!submitEnabled\}/, 'M9c 形态：取消按钮确实带上了该文本')
  assert.equal(submitButtonBound(m9c), true, 'M9c（取消按钮重复同一文本、主按钮不动）必须仍绿')
  // M3：enablement 回退成「要求 confirmed」的提交判据（= R1 缺陷再注入）
  const m3 = dialog.replace(/const submitEnabled = submitButtonEnabled\(\{[^}]*\}\)/, 'const submitEnabled = canSubmitRewind(draft, preview) && !busy')
  assert.notEqual(m3, dialog, 'M3 变异必须真的改到源码')
  assert.equal(submitButtonBound(m3), false, 'M3（enablement 回退成 canSubmitRewind）必须打红')
  // M4：onClick 解绑（F2 的另一半）
  const m4 = dialog.replace('onClick={() => { void submit() }}', 'onClick={() => {}}')
  assert.notEqual(m4, dialog, 'M4 变异必须真的改到源码')
  assert.equal(submitButtonBound(m4), false, 'M4（onClick 解绑）必须打红')
})

test('R2/F1 夹具纪律：不得用「已确认草稿」当 enablement 夹具（真实 UI 永远到不了那个状态）', () => {
  const preview = screenshotPreview()
  const real = defaultDraft(preview)   // 对话框真实初始态
  const afterClick = confirmedDraft()  // 只在点击那一刻之后才存在的状态
  assert.equal(real.confirmed, false, '真实初始态恒未确认')
  assert.equal(confirmOnSubmit(real)?.confirmed, true)
  // 同一份预览下两个夹具在 canSubmitRewind 上正好相反 —— 这正是 R1 缺陷被夹具掩盖的方式：
  assert.equal(canSubmitRewind(afterClick, preview), true, '已确认草稿 → wire 侧提交判据 true')
  assert.equal(canSubmitRewind(real, preview), false, '真实初始态 → wire 侧提交判据 false')
  // 可点性只能用 enablement 判据断言，且它对「确认与否」不敏感（这就是两个判据的分工）
  assert.equal(rewindSubmittable(real, preview), true)
  assert.equal(submitButtonEnabled({ draft: real, preview, pointId: 'p', busy: false }), true)
  assert.equal(submitButtonEnabled({ draft: afterClick, preview, pointId: 'p', busy: false }), true, 'enablement 不得对 confirmed 敏感')
})

test('R2/F3 enablement 维度与执行体同宽：pointId === null 时主按钮必须禁用', () => {
  const preview = screenshotPreview()
  const draft = defaultDraft(preview)
  assert.equal(rewindSubmittable(draft, preview), true, '前提：预览本身可提交')
  assert.equal(submitButtonEnabled({ draft, preview, pointId: null, busy: false }), false, '没有可写目标（pointId=null）⇒ 按钮禁用（submit() 同样会早退）')
  assert.equal(submitButtonEnabled({ draft, preview, pointId: 'p', busy: false }), true, '有目标且不在忙 ⇒ 可点')
  assert.equal(submitButtonEnabled({ draft, preview, pointId: 'p', busy: true }), false, '在途 ⇒ 禁用')
  const blocked = { ok: true, id: 'p', storage: { available: true }, canRestore: false, point: { id: 'p', createdAt: 1, protected: true } } as never
  assert.equal(submitButtonEnabled({ draft: defaultDraft(blocked), preview: blocked, pointId: 'p', busy: false }), false, '不可回退的点即使有 pointId 也仍禁用（不放宽）')
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /const submitEnabled = submitButtonEnabled\(\{[^}]*pointId[^}]*\}\)/, '对话框必须把 pointId 传进 enablement 判据（否则 F3 的维度又脱节）')
})

test('R2/F4 同步幂等锁：同一 tick 的两次提交只发 1 次写请求（busy 是异步 setState，挡不住）', async () => {
  // 这段就是对话框 submit 的执行体（去掉 React setState）：确认 → 成形 → 发请求；
  // 对话框用**同一个** createInFlightLock（源级绑定见下一条用例）。
  const { port, calls } = fakePort()
  const preview = screenshotPreview()
  const draft = defaultDraft(preview)
  const submitLock = createInFlightLock()
  const submit = (): Promise<boolean> => submitLock(async () => {
    const confirmed = confirmOnSubmit(draft) as RewindDraft
    if (!canSubmitRewind(confirmed, preview)) return
    await requestRewind(port, 'point-1', confirmed)
  })
  // 同一 tick 连续两次派发（双击 / 按键重复 / 程序化 dispatchEvent）：此时 busy 还没被 setState 刷新
  const [first, second] = await Promise.all([submit(), submit()])
  assert.equal(first, true, '第一次真的执行了')
  assert.equal(second, false, '第二次被同步锁挡下（task 未执行）')
  assert.equal(calls.length, 1, '端口调用次数恒为 1（busy 单独当锁时会变 2）')
  // finally 释放 ⇒ 结束后仍可重试（不是永久熔断）
  assert.equal(await submit(), true, '锁在结束后释放')
  assert.equal(calls.length, 2)
})

test('R2/F4 源级：对话框写路径由同一把同步幂等锁包住（含反向自检）', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  const writePathLocked = (source: string): boolean =>
    /useRef\(createInFlightLock\(\)\)\.current/.test(source) && /submitLock\(async \(\) => \{/.test(source)
  assert.equal(writePathLocked(dialog), true, 'submit 必须走 submitLock（同一 tick 幂等）')
  assert.equal(writePathLocked(dialog.replace('useRef(createInFlightLock()).current', 'null as never')), false, '拿掉锁必须打红')
  assert.equal(writePathLocked(dialog.replace('submitLock(async () => {', 'void (async () => {')), false, '绕过锁必须打红')
})

test('T15 ① 的 {reason} 插的是**翻译后的文本**（不是键名、不是机器码）', () => {
  const note = rollbackPreviewNote({ workspace: { available: false, reasonCode: 'chunk-not-found' }, session: { restorable: false } })
  const sentence = renderPreviewNote(note)
  const dict = recoveryZh as Record<string, string>
  assert.ok(sentence !== null && sentence.includes(dict['rollback.code.chunk-not-found'] as string), '必须插原因键的字典文本')
  assert.ok(sentence !== null && !sentence.includes('chunk-not-found'), '不得把机器码插进去')
  assert.ok(sentence !== null && !sentence.includes('{reason}'), '占位符必须被替换')
  assert.ok(sentence !== null && !sentence.includes('rollback.code.'), '不得把字典键名插进去')
})

/* ------------------------------------------------------------ t8 运行中的对话：默认只回溯消息 */

/** 运行中的对话（引擎 preview 的 `session.active = true`）：工作区与会话都可回退。 */
const activePreview = (): RollbackPreviewResult => ({
  ok: true, id: 'p', storage: { available: true }, canRestore: true,
  workspace: { available: true, overwrite: 2, different: 1, missing: 0 },
  session: { available: true, restorable: true, active: true },
} as RollbackPreviewResult)

test('t8 运行中：默认档 = **只回溯消息**（session），请求体里只有会话段', () => {
  const preview = activePreview()
  assert.equal(isSessionActive(preview), true)
  const draft = defaultDraft(preview)
  assert.equal(draft.mode, 'session', '运行中的对话默认不连文件一起退（避免与写盘的工具抢文件）')
  assert.deepEqual(segmentsForMode(draft.mode), ['session'])
  // 请求体必须逐字成形（mode=session ⇒ 路由只会 fork 会话，不碰工作区）
  assert.deepEqual(
    buildRewindOptions({ ...draft, confirmed: true }),
    { userConfirmed: true, mode: 'session', preRewindGuard: 'require' },
  )
  // 非运行态**一字不变**：默认仍是 files+session（既有用例的判据不动）
  assert.equal(defaultDraft(filesPreview()).mode, CHAT_REWIND_MODE)
  assert.equal(isSessionActive(filesPreview()), false, '缺 active 字段 = 不是运行中（绝不猜）')
  assert.equal(isSessionActive(null), false)
})

test('t8 运行中：文件档被**禁用**（canRevertFiles=false），硬造 files+session 草稿也不可提交、端口零调用', async () => {
  const preview = activePreview()
  assert.equal(canRevertFiles(preview), false, '运行中禁用「回退文件的更改」（点得动但必然被路由 409 拒绝 = 假承诺）')
  const forced = confirmedDraft({ mode: 'files+session' })
  assert.equal(rewindSubmittable(forced, preview), false)
  assert.equal(canSubmitRewind(forced, preview), false)
  assert.equal(submitButtonEnabled({ draft: forced, preview, pointId: 'p', busy: false }), false, '主按钮必须禁用')
  // 只回溯消息仍可提交（运行中唯一的可用档）
  const sessionOnly = confirmedDraft({ mode: 'session' })
  assert.equal(canSubmitRewind(sessionOnly, preview), true)
  assert.equal(submitButtonEnabled({ draft: sessionOnly, preview, pointId: 'p', busy: false }), true)
  // 非运行态：文件档照旧可用（不放宽也不收紧既有口径）
  const idle = filesPreview()
  assert.equal(canRevertFiles(idle), true)
  assert.equal(canSubmitRewind(confirmedDraft({ mode: 'files+session' }), idle), true)
})

test('t8 文案：预览说明键与拒绝文案键都在 zh/en 字典里，且 session-active 结果码映射到**专门键**', () => {
  const zhDict = recoveryZh as Record<string, string>
  const enDict = recoveryEn as Record<string, string>
  for (const key of [CHAT_SESSION_ACTIVE_NOTE_KEY, CHAT_SESSION_ACTIVE_DENIED_KEY]) {
    assert.ok(typeof zhDict[key] === 'string' && zhDict[key] !== '', 'zh 字典缺键：' + key)
    assert.ok(typeof enDict[key] === 'string' && enDict[key] !== '', 'en 字典缺键：' + key)
  }
  // 弹窗里那句说明：键由常量给出、组件用 rt(rk(...)) 渲染（源码级断言，防「键写了但没渲染」）
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /CHAT_SESSION_ACTIVE_NOTE_KEY/, '弹窗必须渲染运行中说明')
  assert.match(dialog, /isSessionActive\(preview\)/, '弹窗必须按 preview 的 session.active 判定')
  // 结果码 'session-active' ⇒ 专门键（不落既有的「仅供参考」键）
  const failure = chatRewindFailure({
    ok: false, outcome: 'denied', code: 'session-active', id: 'p', detail: 'x',
    segments: [], skippedSegments: [], storage: { available: true }, guidance: [], warnings: [],
  } as RollbackRewindResult)
  assert.deepEqual(failure.keys, [CHAT_SESSION_ACTIVE_DENIED_KEY])
  assert.notEqual(failure.keys[0], 'rollback.code.session-active', '不得复用「仅供参考」口径的既有键')
  assert.equal(chatRewindFailed({ outcome: 'denied', code: 'session-active' } as RollbackRewindResult), true, '被拒要进失败原因盒')
})

test('T15 对话框接线（源级）：预览态句走 rollbackPreviewNote 一处实现 + 原因键插翻译文本', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(dialog, /rollbackPreviewNote\(\{/, '对话框必须调用 ui 层的判定函数（一处实现）')
  assert.match(dialog, /reason: rt\(rk\(note\.reasonKey\)\)/, '原因必须插翻译后的文本')
  assert.match(dialog, /noteText !== null \? <div className=\{css\.hint\}>\{noteText\}<\/div> : null/, 'key=null 时宁可不说话')
  assert.doesNotMatch(dialog, /\{rt\('rollback\.preview\.files\.empty'\)\}/, '预览态句不得再硬编码「一致」那一句')
})

test('T11 三句话的字典键 zh/en 齐备且 zh 逐字（en 是镜像）', () => {
  const keys = summaryKeys()
  for (const key of [...Object.values(keys), 'rollback.code.no-recorded-files']) {
    assert.ok(zhHas(key), 'recovery 字典 zh 缺键：' + key)
    assert.ok(enHas(key), 'recovery 字典 en 缺键：' + key)
  }
  const zhDict = recoveryZh as Record<string, string>
  const enDict = recoveryEn as Record<string, string>
  assert.equal(zhDict[keys.noop], '工作区与该回退点一致，无需恢复')
  assert.equal(zhDict[keys.noFiles], '该回退点没有记录任何文件，无需恢复')
  assert.equal(zhDict[keys.noRecord], '该回退点没有可用的记录（原因：{reason}），无需恢复')
  assert.equal(zhDict['rollback.code.no-recorded-files'], '该回退点没有记录任何文件')
  // 三句必须互不相同（否则「三种情形说三句话」是假的）
  assert.equal(new Set([zhDict[keys.noop], zhDict[keys.noFiles], zhDict[keys.noRecord]]).size, 3)
  // {reason} 占位符只出现在 ①（其余两句没有插值，多写会原样渲染成 {reason}）
  assert.ok(zhDict[keys.noRecord]?.includes('{reason}') === true)
  assert.ok(zhDict[keys.noop]?.includes('{') !== true && zhDict[keys.noFiles]?.includes('{') !== true)
  // en 镜像：非空、无 CJK、语义对应（各含 nothing to restore）
  for (const key of Object.values(keys)) {
    const value = enDict[key] ?? ''
    assert.ok(value !== '', 'en 值不得为空：' + key)
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/, 'en 值不得含中文：' + key)
    assert.match(value, /nothing to restore/i, 'en 三句都要说清「无需恢复」：' + key)
  }
})

test('失败原因：可读文案 + 真实 code + detail（段级失败同样收），detail 渲染前过 redact', () => {
  const failed = chatRewindFailure({
    ok: false, outcome: 'failed', code: 'restore-failed', detail: 'boom',
    segments: [{ state: 'workspace', status: 'failed', reasonCode: 'nothing-to-restore' }],
  } as never)
  assert.deepEqual(failed.keys, ['rollback.code.restore-failed', 'rollback.code.nothing-to-restore'], '结果级与段级 code 都要收，且都映射成可读键')
  assert.equal(failed.code, 'restore-failed', 'code 如实回传（渲染时走 rollback.preview.result.code）')
  assert.equal(failed.detail, 'boom')
  const withSecret = chatRewindFailure({ ok: false, outcome: 'failed', code: 'restore-failed', detail: 'key sk-abcdefghijklmnopqrstuvwxyz' } as never)
  assert.ok(withSecret.detail !== null && !withSecret.detail.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'detail 必须已脱敏')
  assert.equal(withSecret.code, 'restore-failed', 'code 不是秘密，原样显示（用户要求如实显示）')
  assert.deepEqual(chatRewindFailure(null).keys, [])
  // 未知 code 仍回落 unknown 键（绝不把机器码当主文案）
  assert.deepEqual(chatRewindFailure({ ok: false, outcome: 'failed', code: 'brand-new' } as never).keys, ['rollback.code.unknown'])
})

test('告警不禁用回退（S4：允许部分覆盖 —— 已确认草稿的 wire 侧提交判据仍为 true）', () => {
  const preview = {
    ok: true, id: 'p', storage: { available: true }, canRestore: true,
    warnings: [{ code: 'rollback.warn.trackDegraded' }],
    point: { id: 'p', createdAt: 1 },
    workspace: { available: true, overwrite: 1, different: 0, missing: 0, createdAfter: 0, skippedCount: 1, truncated: true },
  } as never
  const draft = confirmedDraft()
  assert.equal(canSubmitRewind(draft, preview), true, '有告警 / 有截断时 wire 侧提交判据仍为 true（规格允许部分覆盖）')
  assert.equal(buildRewindOptions(draft)?.mode, 'files+session', 'mode 恒为固定档位，与告警无关')
})

/* ------------------------------------------------------------ 简洁版预览：逐文件行级统计（E1） */

test('预览文件读法：逐字段判定，只列会被改动的文件，null 行数不当 0（E1 形状）', () => {
  // 空数组 = 工作区与该回退点一致（E1：只列会被改动的文件）
  assert.deepEqual(readRollbackPreviewFiles({ files: [] }), [])
  assert.deepEqual(readRollbackPreviewFiles({}), [])
  assert.deepEqual(readRollbackPreviewFiles(null), [])
  assert.deepEqual(readRollbackPreviewFiles({ files: 'nope' }), [])
  // 正常两条：overwrite（有可信行数）+ create（新增 = 快照行数、删除 0）
  const rows = readRollbackPreviewFiles({
    files: [
      { path: 'C:/p/a.ts', status: 'overwrite', added: 12, removed: 3, truncated: false },
      { path: 'C:/p/b.ts', status: 'create', added: 7, removed: 0, truncated: false },
    ],
  })
  assert.deepEqual(rows, [
    { path: 'C:/p/a.ts', status: 'overwrite', added: 12, removed: 3, truncated: false },
    { path: 'C:/p/b.ts', status: 'create', added: 7, removed: 0, truncated: false },
  ])
  assert.equal(chatFileChangeAvailable(rows), true)
})

test('预览文件读法：null / 缺字段 / 非数字一律「行数未统计」，行仍然上屏（绝不谎报 0）', () => {
  const rows = readRollbackPreviewFiles({
    files: [
      { path: 'C:/p/big.bin', status: 'overwrite', added: null, removed: null, truncated: true },
      { path: 'C:/p/half.ts', status: 'overwrite', added: 5, truncated: false },
      { path: 'C:/p/weird.ts', status: 'overwrite', added: '5', removed: '2' },
      { path: '', status: 'overwrite', added: 1, removed: 1 },
      'not-an-object',
    ],
  })
  assert.equal(rows.length, 3, '路径读不出的条目跳过，其余一律上屏')
  assert.deepEqual(rows[0], { path: 'C:/p/big.bin', status: 'overwrite', added: null, removed: null, truncated: true })
  assert.deepEqual(rows[1], { path: 'C:/p/half.ts', status: 'overwrite', added: 5, removed: null, truncated: true }, '缺一侧 ⇒ 整条「未统计」')
  assert.deepEqual(rows[2], { path: 'C:/p/weird.ts', status: 'overwrite', added: null, removed: null, truncated: true }, '字符串数字不猜')
  assert.equal(chatFileChangeAvailable(rows), false, '一条可信行数都没有 ⇒ 显示一句「行数未统计」说明')
  // 未知 status 收敛成 'unknown'（只认引擎枚举名；**不改变渲染** —— 界面不按变更类型分派文案，
  // 用户看到的始终是「路径 + 增删行数」，因此这条收敛对任何对外行为都是零影响）
  assert.equal(readRollbackPreviewFiles({ files: [{ path: 'x', status: 'rename' }] })[0]?.status, 'unknown')
  assert.equal(readRollbackPreviewFiles({ files: [{ path: 'x', status: 42 }] })[0]?.status, 'unknown')
  assert.equal(readRollbackPreviewFiles({ files: [{ path: 'x', status: 'create' }] })[0]?.status, 'create', '引擎枚举名原样保留')
  assert.equal(previewFileStatusKnown('overwrite') && previewFileStatusKnown('create') && previewFileStatusKnown('delete'), true)
  assert.equal(previewFileStatusKnown('rename'), false, '白名单只用于断言：delete 保留在取值集合里（引擎当前永不产出）')
})

test('两态纪律（S2）：判定层不出现 config 第三态，也没有「同点」键', () => {
  const src = readFileSync(join(HERE, 'rollback-entry-view.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /'config'/, '两态之外不得出现 config')
  assert.doesNotMatch(code, /samePoint|同点/, '同点判定已随检查点删除')
})

test('客户端铁律：判定层不 import node 模块 / src/core，也不直接 fetch', () => {
  const src = readFileSync(join(HERE, 'rollback-entry-view.ts'), 'utf8')
  assert.doesNotMatch(src, /from 'node:/, 'client 侧不得 import node 模块')
  assert.doesNotMatch(src, /from '\.\.\/\.\.\/core\//, 'client bundle 不得拉 src/core（会带进 node:fs）')
  assert.doesNotMatch(src, /await fetch\(|new AbortController\(/, '一律走 RecoveryApi，组件层不直接 fetch')
})

test('组件用的每个 css.* 类都真实存在于唯一样式表（否则渲染成 undefined）', () => {
  const sheet = readFileSync(join(HERE, '..', 'config-manager.module.css'), 'utf8')
  const used = new Set<string>()
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(HERE, file), 'utf8')
    for (const m of src.matchAll(/css\.([A-Za-z0-9_]+)/g)) used.add(m[1] as string)
  }
  assert.ok(used.size > 0, '至少要用到一个样式类（本入口不新增样式，只复用既有类）')
  const missing = [...used].filter((name) => !new RegExp('\\.' + name + '(?![A-Za-z0-9_-])').test(sheet))
  assert.deepEqual(missing, [], 'config-manager.module.css 里没有这些类名：' + missing.join(', '))
})

test('结果指引：只上屏「与预期不同」的事实 —— sessionForked 不重复，段级/结果级去重（真机 2026-10-12）', () => {
  // 成功回退：只有「已 fork」一条 ⇒ 上屏列表必须为空（子会话行已表达过，别再说一遍）
  assert.deepEqual(chatRewindNotices({
    ok: true, outcome: 'restored', code: 'ok',
    segments: [{ state: 'session', status: 'restored', guidance: [{ code: 'rollback.guidance.sessionForked', detail: 'child-1' }] }],
  } as never), [])

  // 归位失败：段级给「已 fork + 未归位」，结果级再给一条重复的 ⇒ 去重后只留未归位那条
  const rows = chatRewindNotices({
    ok: true, outcome: 'restored', code: 'ok',
    guidance: [{ code: 'rollback.guidance.sessionNotAttached', detail: 'child-2' }],
    segments: [{
      state: 'session', status: 'restored',
      guidance: [
        { code: 'rollback.guidance.sessionForked', detail: 'child-2' },
        { code: 'rollback.guidance.sessionNotAttached', detail: 'child-2' },
      ],
    }],
  } as never)
  assert.deepEqual(rows, [
    { key: 'rollback.guidance.sessionNotAttached', detail: 'child-2' },
  ], '同一事实（同 key + 同 detail）只留一行，且绝不裸渲染其它码')

  assert.deepEqual(chatRewindNotices(null), [], '没有结果就没有指引行（绝不编造）')
})

/* ============================================================ 2026-10-12 用户七条（第 1/2/5/6/7 条） */

test('第 1 条：选择框 → mode 只有两档，且与 wire 请求体逐字对齐（session = 只退对话）', () => {
  const preview = filesPreview()
  const draft = defaultDraft(preview)
  assert.equal(revertFilesOn(draft), true, '默认勾选 = 文件与对话一起退')
  assert.equal(canRevertFiles(preview), true, '工作区态有可用记录 ⇒ 开关可点')

  const off = setRevertFiles(draft, false)
  assert.equal(off?.mode, 'session', '取消勾选 = 只退对话')
  assert.equal(revertFilesOn(off), false)
  assert.equal(off?.confirmed, false, '选择框**不**动确认位（确认只在点主按钮那一刻）')

  // 关档的请求体：segments = ['session']，userConfirmed 仍恰好 true（确认门一字未松）
  assert.deepEqual(buildRewindOptions(confirmOnSubmit(off)), { userConfirmed: true, mode: 'session', preRewindGuard: 'require' })
  // 开档的请求体：仍是 files+session
  assert.deepEqual(buildRewindOptions(confirmOnSubmit(draft)), { userConfirmed: true, mode: 'files+session', preRewindGuard: 'require' })
  // 原草稿不被就地改写（React 状态语义）
  assert.equal(draft.mode, 'files+session')

  // 工作区态没有可用记录 ⇒ 开关禁用（没有文件可退，开关点了也没有区别）
  assert.equal(canRevertFiles(sessionOnlyPreview()), false)
  assert.equal(canRevertFiles(null), false)
  assert.equal(setRevertFiles(null, true), null, '没有草稿就不造一个')
})

test('第 6 条：删除清单读法（removals，不是 leftovers；引擎给的是**全量**删除集）', () => {
  assert.deepEqual(readRollbackPreviewRemovals({ removals: ['C:/p/a.md', 'C:/p/b.md'] }), ['C:/p/a.md', 'C:/p/b.md'])
  assert.deepEqual(readRollbackPreviewRemovals({ removals: ['C:/p/a.md', 'C:/p/a.md', '', 42, null] }), ['C:/p/a.md'], '去重 + 只认非空字符串')
  assert.deepEqual(readRollbackPreviewRemovals({}), [])
  assert.deepEqual(readRollbackPreviewRemovals(null), [])
  assert.deepEqual(readRollbackPreviewRemovals({ removals: 'nope' }), [])
  // **不回落 leftovers**：那份清单含永不删除的拒删项（.git 等）—— 回落等于把
  // 「预览说会删的 ≠ 实际删的」重新引回来（用户 2026-10-12 实测的缺陷）
  assert.deepEqual(readRollbackPreviewRemovals({ leftovers: ['C:/p/a.md'] }), [], 'leftovers 不是删除清单')
  // **全量**：引擎不再切 20 条，界面直接渲染这份清单 ⇒ 不需要任何「清单可能不完整」的说明句
  // （用户 2026-10-12：弹窗只要清单；文案克制 → DESIGN.md §7）
  const many = Array.from({ length: 120 }, (_, i) => 'C:/p/del-' + String(i) + '.txt')
  assert.deepEqual(readRollbackPreviewRemovals({ removals: many }), many, '120 条一条都不能丢')
})

test('第 5 条（源级）：「查看」开进右侧栏成功后必须顺手关掉弹窗；降级通道不得被删', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  assert.match(
    dialog,
    /if \(opened\.ok\) \{[\s\S]{0,600}?onClose\(\)/,
    '打开成功必须关弹窗（否则模态盖在新开的右侧栏上，用户还得再点一次取消）',
  )
  // 降级通道（无侧栏 / 打开失败 ⇒ 弹窗内展示同一份差异）仍在，且**不**关弹窗
  assert.match(dialog, /setInlineDiff\(\{ path: filePath, state: \{ status: 'loading' \} \}\)/, '降级为弹窗内展示的通道不得被删')
  assert.match(dialog, /chat\.preview\.viewFailed|t\('chat\.preview\.viewInline'\)/, '降级原因必须如实说（两种原因两句话）')
})
