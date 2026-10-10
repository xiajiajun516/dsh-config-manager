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
  CHAT_ENTRY_ID,
  CHAT_ENTRY_ORDER,
  CHAT_ENTRY_SLOT,
  buildRewindOptions,
  buildSessionNavigator,
  canSubmitRewind,
  childOpenHintKey,
  codeKeyOfError,
  defaultDraft,
  entryVisibleForTurn,
  errorDetail,
  findPointForTurn,
  modeOptions,
  modeReachable,
  navigationSourcesOf,
  openChildSession,
  planChatEntryRegistration,
  registerChatEntry,
  requestRewind,
  rollbackPointRows,
  rollbackPreviewGuidance,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  segmentsForMode,
  type ChatSlotProbe,
  type RewindDraft,
  type SessionNavigator,
} from './rollback-entry-view.ts'
import { en as chatEn, zh as chatZh } from './chat-locales.ts'
import { ROLLBACK_CODES, ROLLBACK_CODE_UNKNOWN_KEY, type RollbackPointPort, type RollbackRewindResult } from '../../ui/rollback-view.ts'
import { en as recoveryEn, zh as recoveryZh } from '../recovery/recovery-locales.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

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

const confirmedDraft = (patch: Partial<RewindDraft> = {}): RewindDraft => ({ ...defaultDraft(null), confirmed: true, ...patch })

/* ------------------------------------------------------------ ① mode 映射 */

test('mode 映射：三选一 → 段集合（与冻结 wire contract 逐条对齐）', () => {
  assert.deepEqual(segmentsForMode('files+session'), ['workspace', 'session'])
  assert.deepEqual(segmentsForMode('files'), ['workspace'])
  assert.deepEqual(segmentsForMode('session'), ['session'])
  assert.deepEqual(segmentsForMode('unknown-mode'), [], '未知 mode 不得被当成任一已知范围')
  assert.deepEqual(segmentsForMode(null), [])
  // 键顺序与 wire 的三选一顺序一致（界面按此渲染），且键值都不重复
  assert.deepEqual(modeOptions().map((o) => o.mode), ['files+session', 'files', 'session'])
  assert.deepEqual(modeOptions().map((o) => o.key), ['rollback.mode.filesAndSession', 'rollback.mode.filesOnly', 'rollback.mode.sessionOnly'])
  assert.equal(new Set(modeOptions().map((o) => o.key)).size, 3)
})

test('mode 可达性：段不全的 mode 在界面上标为不可达', () => {
  assert.equal(modeReachable('files+session', ['workspace', 'session']), true)
  assert.equal(modeReachable('files', ['workspace', 'session']), true)
  assert.equal(modeReachable('session', ['workspace', 'session']), true)
  assert.equal(modeReachable('files+session', ['workspace']), false, '只有工作区可回退时，「文件 + 会话」不可达')
  assert.equal(modeReachable('session', ['workspace']), false)
  assert.equal(modeReachable('files', []), false)
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

test('确认后：请求体逐字段成形（userConfirmed 恰好 true + mode + allowPartial + guard=require）', async () => {
  const { port, calls } = fakePort()
  const draft = confirmedDraft({ mode: 'files', allowPartial: true })
  assert.equal(canSubmitRewind(draft, null), false, '没有预览判定时提交按钮不可用（但已确认的请求体仍可成形）')
  const options = buildRewindOptions(draft)
  assert.deepEqual(options, { userConfirmed: true, mode: 'files', allowPartial: true, preRewindGuard: 'require' })
  const attempt = await requestRewind(port, 'point-1', draft)
  assert.equal(attempt.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.id, 'point-1')
  assert.deepEqual(calls[0]?.options, { userConfirmed: true, mode: 'files', allowPartial: true, preRewindGuard: 'require' })
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

test('回合尾入口只出现在已收尾的回合', () => {
  assert.equal(entryVisibleForTurn({ status: 'closed' }), true)
  assert.equal(entryVisibleForTurn({ status: 'open' }), false, '正在跑的回合还没有回滚点')
  assert.equal(entryVisibleForTurn({ status: 'unknown' }), false)
  assert.equal(entryVisibleForTurn(null), false)
  assert.equal(entryVisibleForTurn(undefined), false)
})

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

/* ------------------------------------------------------------ 槽位登记（T9-F2：形态探测 + 失败软化） */

/** 假探测面：返回声明的 spec（或抛错）。 */
function fakeProbe(kind: string | undefined | 'THROW'): ChatSlotProbe {
  return {
    spec: () => {
      if (kind === 'THROW') throw new Error('spec unavailable')
      return kind === undefined ? undefined : { kind, scope: 'session' }
    },
  }
}

test('登记计划：只有 list 契约才注册（0.1.x 的 chain 必须跳过）', () => {
  assert.deepEqual(planChatEntryRegistration(fakeProbe('list')), { kind: 'register' })
  assert.deepEqual(planChatEntryRegistration(fakeProbe('chain')), { kind: 'skip', reason: 'slot-kind-mismatch', declared: 'chain' })
  assert.deepEqual(planChatEntryRegistration(fakeProbe('single')), { kind: 'skip', reason: 'slot-kind-mismatch', declared: 'single' })
  assert.deepEqual(planChatEntryRegistration(fakeProbe(undefined)), { kind: 'skip', reason: 'slot-undeclared', declared: null })
  assert.deepEqual(planChatEntryRegistration(fakeProbe('THROW')), { kind: 'skip', reason: 'slot-undeclared', declared: null })
  assert.deepEqual(planChatEntryRegistration(undefined), { kind: 'skip', reason: 'slot-undeclared', declared: null })
})

test('登记失败软化：跳过 / 抛错都只丢这一个入口，绝不影响其它槽位与宿主启动', () => {
  const warnings: string[] = []
  let registered = 0
  const noop = (): void => {}
  const disposer = registerChatEntry({
    probe: fakeProbe('list'),
    register: () => { registered += 1; return noop },
    warn: (m) => { warnings.push(m) },
  })
  assert.equal(registered, 1)
  assert.equal(typeof disposer, 'function')
  assert.equal(warnings.length, 0, '正常注册不打警告')
  const skipped = registerChatEntry({
    probe: fakeProbe('chain'),
    register: () => { registered += 1; return noop },
    warn: (m) => { warnings.push(m) },
  })
  assert.equal(registered, 1, '跳过时不得调用 register')
  assert.equal(typeof skipped, 'function', 'disposer 仍必须是可调用的 no-op')
  skipped()
  assert.ok(warnings.some((m) => m.includes('chain')), '警告要点名真实声明形态：' + JSON.stringify(warnings))
  const failed = registerChatEntry({
    probe: fakeProbe('list'),
    register: () => { throw new Error('slot registry refused') },
    warn: (m) => { warnings.push(m) },
  })
  assert.equal(typeof failed, 'function')
  failed()
  assert.ok(warnings.some((m) => m.includes('slot registry refused')), '注册失败必须留下诊断：' + JSON.stringify(warnings))
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
  assert.deepEqual(navigationSourcesOf({ get: () => { throw new Error('no such service') } }), { workspace: null, sessions: null })
  assert.equal(navigationSourcesOf({ get: () => 42 }).workspace, null, '非对象服务按缺失处理')
  assert.equal(navigationSourcesOf({ get: () => ({}) }).sessions?.open, undefined, '没有 open 就不编一个')
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

test('同尺子补齐（S4 / 队长追加验收）：对话框渲染 noticeKeys 与 previewWarnings/previewGuidance', () => {
  const dialog = readFileSync(join(HERE, 'RollbackReviewDialog.tsx'), 'utf8')
  // t19 的尺子：这三处必须在聊天入口命中（此前零命中）
  assert.match(dialog, /noticeKeys/, 'S4 的「跳过 / 截断」必须上屏')
  assert.match(dialog, /rollbackPreviewWarnings\(/, '点级告警（preview.warnings）必须渲染')
  assert.match(dialog, /rollbackPreviewGuidance\(/, '点级指引（preview.guidance）必须渲染')
  assert.match(dialog, /rollbackPointRows\(/, '留点期的 segment.noticeKeys 必须从台账行取（与面板同一份事实）')
  // 文案走既有映射（不新增键）：未知码回落 unknown 由 src/ui 负责，聊天侧只照键渲染
  const warns = (codes: string[]): { key: string; detail: string | null }[] => rollbackPreviewWarnings({ ok: true, id: 'p', storage: { available: true }, warnings: codes.map((code) => ({ code })) } as never)
  assert.equal(warns(['rollback.warn.trackMissing'])[0]?.key, 'rollback.warn.trackMissing', '已知告警码照映射')
  assert.equal(warns(['rollback.warn.brand-new'])[0]?.key, 'rollback.warn.unknown', '告警族未知码回落 rollback.warn.unknown')
  assert.equal(warns(['brand-new'])[0]?.key, 'rollback.guidance.unknown', '无前缀未知码回落 guidance.unknown（与面板**同一份映射**）')
  const rows = warns(['rollback.warn.trackMissing', 'rollback.warn.brand-new'])
  for (const row of rows) assert.ok(zhHas(row.key) && enHas(row.key), '告警键必须在 recovery 字典 zh/en 里：' + row.key)
  const guided = rollbackPreviewGuidance({ ok: true, id: 'p', storage: { available: true }, guidance: [{ code: 'probeDetail', detail: 'x' }] } as never)
  assert.equal(guided[0]?.key, 'rollback.guidance.probeDetail')
  // 留点期事实：跳过的超大文件 → 行级 noticeKeys 非空（S4「不整点丢弃、如实报告」）
  const pointRows = rollbackPointRows({
    points: [{ id: 'p', createdAt: 1, sessionId: 's1', turn: 1, segments: [{ state: 'workspace', ok: true, skippedCount: 2, truncated: true }] }],
    storage: { available: true },
  } as never)
  assert.deepEqual(pointRows[0]?.segments[0]?.noticeKeys, ['rollback.row.notice.skipped', 'rollback.row.notice.truncated'])
  assert.equal(pointRows[0]?.segments[0]?.skippedCount, 2, '{n} 插值取的就是这个计数')
  for (const key of pointRows[0]?.segments[0]?.noticeKeys ?? []) assert.ok(zhHas(key) && enHas(key), 'noticeKeys 必须在 recovery 字典里：' + key)
})

test('告警不禁用回退（S4：允许部分覆盖 —— 有告警仍可提交）', () => {
  const preview = {
    ok: true, id: 'p', storage: { available: true }, canRestore: true,
    warnings: [{ code: 'rollback.warn.trackDegraded' }],
    guidance: [{ code: 'probeDetail', detail: 'x' }],
    point: { id: 'p', createdAt: 1 },
    workspace: { available: true, overwrite: 1, different: 0, missing: 0, createdAfter: 0, skippedCount: 1, truncated: true },
  } as never
  const draft = { ...defaultDraft(preview), confirmed: true }
  assert.equal(canSubmitRewind(draft, preview), true, '有告警 / 有截断也必须能提交（规格允许部分覆盖）')
  assert.equal(buildRewindOptions(draft)?.mode, 'files', 'mode 由预览可用段推导（本例只有工作区段），与告警无关')
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

test('槽位常量：注册点与断言共用同一份（list 位，追加新 id）', () => {
  assert.equal(CHAT_ENTRY_SLOT, 'conversation.chat.turnTail')
  assert.equal(CHAT_ENTRY_ID, 'config-manager-rollback-entry')
  assert.ok(CHAT_ENTRY_ORDER > 0 && CHAT_ENTRY_ORDER < 20, '插在 shipped 条目（0 / 20）之间')
})
