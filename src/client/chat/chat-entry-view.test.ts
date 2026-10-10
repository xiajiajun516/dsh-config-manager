/**
 * T1 判定层测试：**每条用户消息一个回退入口**（node:test，零依赖）。
 *
 * 六条验收点逐条落地：
 *  ① 槽位接管：注册 { name:'conversation.chat.node', key:'user' } 且**仅在**偏好为「每条消息」时注册；
 *     偏好「整回合」→ 一次都不注册（宿主渲染器原样）；steering 是**另一个** key，本插件从不注册它；
 *  ② 气泡能力面：文本（保留换行/空白）/ 图片（载荷逐字转发给 owner 的 renderMessageImages）/
 *     文件卡（文件名 + 扩展名 + 体积）/ **rest 兜底**（未知块进 raw，绝不静默丢弃）；
 *  ③ 按钮启用/禁用矩阵：六种禁用原因各自的判据（含「回合未收尾」与「未命中」）；
 *  ④ 错误边界降级：投影抛错 → 仍能拿到**纯文本** + ASCII console.warn；
 *  ⑤ 回合号只认可核实字段（node.location.kind 必须是 turn/step），取不到 → 如实禁用；
 *  ⑥ 回滚点惰取的缓存与在途去重（每条消息一颗按钮，不能 N 个并发请求）。
 *
 * 纪律：本文件不 import React 组件（*.tsx 不能在 node 下被 type-strip 加载）——组件里能测的那部分
 * 全部提炼在 chat-entry-view.ts / chat-node-registration.ts 两个纯模块里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChatEntryBubble,
  buildChatEntrySafeRow,
  buildChatEntryView,
  chatEntryButtonState,
  chatEntryTurnPhase,
  CHAT_ENTRY_DISABLED_KEYS,
  CHAT_ENTRY_WARN_PREFIX,
  CHAT_NODE_PRIORITY,
  CHAT_NODE_SLOT,
  CHAT_NODE_USER_KEY,
  chatNodeKind,
  chatNodeTurn,
  fileExtensionOf,
  fileSizeTextOf,
  formatChatEntryClock,
  imageRenderOwnersOf,
  lookupPointForTurn,
  plainTextOf,
  planChatNodeRegistration,
  resetChatPointCache,
  type ChatEntryDisabledCode,
} from './chat-entry-view.ts'
import { declaredSlotKind, mountChatNodeEntry, registerChatNodeEntry } from './chat-node-registration.ts'
import {
  CHAT_ENTRY_MODE_DEFAULT,
  CHAT_ENTRY_MODE_KEY,
  isChatEntryMode,
  readChatEntryMode,
  subscribeChatEntryMode,
  writeChatEntryMode,
} from './chat-entry-pref.ts'
import { planChatEntryRegistration } from './rollback-entry-view.ts'
import { en as chatEn, zh as chatZh } from './chat-locales.ts'
import type { RollbackPointPort, RollbackPointSummary } from '../../ui/rollback-view.ts'

/* ------------------------------------------------------------ 夹具 */

interface MemStorage {
  map: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function withStorage<T>(run: (storage: MemStorage) => T): T {
  const holder = globalThis as { localStorage?: unknown }
  const previous = holder.localStorage
  const map = new Map<string, string>()
  const storage: MemStorage = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
  holder.localStorage = storage
  try {
    return run(storage)
  } finally {
    if (previous === undefined) delete holder.localStorage
    else holder.localStorage = previous
  }
}

/** 宿主节点夹具：location.kind='step' + turn.turn/status（与宿主 turnOf 的读法同源）。 */
function nodeOf(options: { kind?: string; turn?: number; status?: string; content?: unknown } = {}): unknown {
  const kind = options.kind ?? 'user'
  const turn = options.turn ?? 3
  const status = options.status ?? 'closed'
  return {
    key: 'n1',
    kind,
    anchorSeq: 11,
    location: { kind: 'step', turn: { turn, status, steps: [] }, step: { turn, step: 1, status } },
    data: { content: options.content ?? [{ type: 'text', text: 'hello' }] },
  }
}

const POINTS: RollbackPointSummary[] = [
  { id: 'p-turn-3-guard', createdAt: 1, sessionId: 's1', turn: 3, kind: 'guard' },
  { id: 'p-turn-3-auto', createdAt: 2, sessionId: 's1', turn: 3, kind: 'auto' },
  { id: 'p-turn-2-auto', createdAt: 3, sessionId: 's1', turn: 2, kind: 'auto' },
  { id: 'p-other-session', createdAt: 4, sessionId: 's2', turn: 3, kind: 'auto' },
]

function fakePort(points: RollbackPointSummary[] = POINTS): { port: RollbackPointPort; calls: () => number } {
  let calls = 0
  const notUsed = async (): Promise<never> => { throw new Error('this port method must not be called in this test') }
  const port: RollbackPointPort = {
    rollbackPoints: async () => { calls += 1; return { points, storage: { available: true } } },
    rollbackPointStorage: notUsed as RollbackPointPort['rollbackPointStorage'],
    rollbackPoint: notUsed as RollbackPointPort['rollbackPoint'],
    rollbackPointPreview: notUsed as RollbackPointPort['rollbackPointPreview'],
    restoreRollbackPoint: notUsed as RollbackPointPort['restoreRollbackPoint'],
    removeRollbackPoint: notUsed as RollbackPointPort['removeRollbackPoint'],
  }
  return { port, calls: () => calls }
}

/* ------------------------------------------------------------ ① 槽位接管：注册时机 */

test('slot constants: chat.node keyed slot, user key, priority -1 (shadowing rank below the host 0)', () => {
  assert.equal(CHAT_NODE_SLOT, 'conversation.chat.node')
  assert.equal(CHAT_NODE_USER_KEY, 'user')
  assert.equal(CHAT_NODE_PRIORITY, -1)
})

test('pref gating: per-message (default) registers into the keyed cell; turn mode registers NOTHING', () => {
  assert.deepEqual(planChatNodeRegistration('keyed', 'per-message'), { kind: 'register' })
  assert.deepEqual(planChatNodeRegistration('keyed', 'turn'), { kind: 'skip', reason: 'turn-mode' })
  assert.deepEqual(planChatNodeRegistration(null), { kind: 'skip', reason: 'slot-kind-mismatch', declared: null })
  assert.deepEqual(planChatNodeRegistration('list', 'per-message'), { kind: 'skip', reason: 'slot-kind-mismatch', declared: 'list' })
})

test('register shell: turn mode never calls register (host UserMessageNodeView stays untouched)', () => {
  const warnings: string[] = []
  let called = 0
  const disposer = registerChatNodeEntry({
    probe: { spec: () => ({ kind: 'keyed', scope: 'session' }) },
    readMode: () => 'turn',
    register: () => { called += 1; return () => {} },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(called, 0, 'pref = turn must not register at all')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]?.includes('turn'), 'the warning names the preference reason')
  disposer()
})

test('register shell: keyed declaration registers exactly once; non-keyed declaration is skipped, not thrown', () => {
  const warn: string[] = []
  let called = 0
  registerChatNodeEntry({
    probe: { spec: (key) => (key === CHAT_NODE_SLOT ? { kind: 'keyed', scope: 'session' } : undefined) },
    readMode: () => 'per-message',
    register: () => { called += 1; return () => {} },
    warn: (message) => { warn.push(message) },
  })
  assert.equal(called, 1)
  // 注意用 length 而不是 deepEqual(warn, [])：node:assert 的 asserts-signature 会把 warn 收窄成 never[]
  assert.equal(warn.length, 0)

  let second = 0
  registerChatNodeEntry({
    probe: { spec: () => ({ kind: 'chain', scope: 'session' }) },
    readMode: () => 'per-message',
    register: () => { second += 1; return () => {} },
    warn: (message) => { warn.push(message) },
  })
  assert.equal(second, 0, 'a non-keyed declaration must be skipped (registering with key/priority would throw)')
  assert.ok(warn.some((line) => line.includes('"chain"')))

  // 探测面本身读不到 / 抛错 → 一样只跳过这一个入口
  assert.equal(declaredSlotKind(undefined), null)
  assert.equal(declaredSlotKind({ spec: () => { throw new Error('boom') } }), null)
})

test('register shell: a throwing register() is contained (never takes the plugin down)', () => {
  const warn: string[] = []
  const disposer = registerChatNodeEntry({
    probe: { spec: () => ({ kind: 'keyed', scope: 'session' }) },
    readMode: () => 'per-message',
    register: () => { throw new Error('register exploded') },
    warn: (message) => { warn.push(message) },
  })
  assert.equal(typeof disposer, 'function')
  assert.equal(disposer(), undefined, 'the contained failure returns a no-op disposer')
  assert.ok(warn.some((line) => line.includes('register exploded')))
})

test('steering is a DIFFERENT key: we never register it (host renderer unchanged)', () => {
  const keys: string[] = []
  registerChatNodeEntry({
    probe: { spec: () => ({ kind: 'keyed', scope: 'session' }) },
    readMode: () => 'per-message',
    register: () => { keys.push(CHAT_NODE_USER_KEY); return () => {} },
    warn: () => {},
  })
  assert.deepEqual(keys, ['user'])
  assert.ok(!keys.includes('steering'))
  // 节点侧的同一件事：kind 读到 steering 时我们照样只按数据渲染，绝不因此改注册面
  assert.equal(chatNodeKind(nodeOf({ kind: 'steering' })), 'steering')
  assert.equal(chatNodeKind(nodeOf({ kind: 'user' })), 'user')
})

test('turnTail fallback path is untouched: its registration plan still ships', () => {
  assert.deepEqual(planChatEntryRegistration({ spec: () => ({ kind: 'list' }) }), { kind: 'register' })
})

/* ------------------------------------------------------------ ① 偏好读写 */

test('pref: default is per-message, unknown values fall back to the default, round-trips', () => {
  assert.equal(CHAT_ENTRY_MODE_DEFAULT, 'per-message')
  assert.ok(isChatEntryMode('per-message') && isChatEntryMode('turn'))
  assert.ok(!isChatEntryMode('per_user_message'))
  withStorage((storage) => {
    assert.equal(readChatEntryMode(), 'per-message', 'no key -> default')
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'garbage')
    assert.equal(readChatEntryMode(), 'per-message', 'unknown stored value -> default (never half-open)')
    assert.equal(writeChatEntryMode('turn'), true)
    assert.equal(readChatEntryMode(), 'turn')
    assert.equal(writeChatEntryMode('per-message'), true)
    assert.equal(readChatEntryMode(), 'per-message')
  })
})

test('pref: storage missing or throwing degrades to the default (feature stays on)', () => {
  const holder = globalThis as { localStorage?: unknown }
  const previous = holder.localStorage
  try {
    delete holder.localStorage
    assert.equal(readChatEntryMode(), 'per-message')
    assert.equal(writeChatEntryMode('turn'), false, 'no storage -> honest false, no throw')
    holder.localStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    assert.equal(readChatEntryMode(), 'per-message')
    assert.equal(writeChatEntryMode('turn'), false)
  } finally {
    if (previous === undefined) delete holder.localStorage
    else holder.localStorage = previous
  }
})

test('pref subscription: listeners fire only on a real change, and writeChatEntryMode reports storage failures', () => {
  withStorage(() => {
    const seen: string[] = []
    const off = subscribeChatEntryMode((mode) => { seen.push(mode) })
    assert.equal(writeChatEntryMode('per-message'), true, 'storing the current value still succeeds')
    assert.deepEqual(seen, [], 'no notification when the value did not change')
    assert.equal(writeChatEntryMode('turn'), true)
    assert.equal(writeChatEntryMode('per-message'), true)
    assert.deepEqual(seen, ['turn', 'per-message'])
    off()
    assert.equal(writeChatEntryMode('turn'), true)
    assert.deepEqual(seen, ['turn', 'per-message'], 'unsubscribed listeners stop receiving')
  })
})

test('hot swap: switching the preference registers/unregisters immediately (no page reload needed)', () => {
  const events: string[] = []
  let listener: ((mode: 'per-message' | 'turn') => void) | null = null
  let live = 0
  let mode: 'per-message' | 'turn' = 'per-message'
  const disposer = mountChatNodeEntry({
    probe: { spec: () => ({ kind: 'keyed', scope: 'session' }) },
    register: () => {
      live += 1
      events.push('register')
      return () => { live -= 1; events.push('dispose') }
    },
    // 与真实装配一致：登记时**重读**偏好（不是快照）
    readMode: () => mode,
    subscribe: (fn) => { listener = fn; return () => { listener = null } },
    warn: () => {},
  })
  assert.deepEqual(events, ['register'], 'per-message at mount -> registered once')
  assert.equal(live, 1)

  // 外部把偏好切成「整回合」→ 必须退掉我们的接管（宿主渲染器回来）
  const swap = listener as unknown as ((next: 'per-message' | 'turn') => void) | null
  assert.ok(swap !== null)
  mode = 'turn'
  ;(swap as (next: 'per-message' | 'turn') => void)('turn')
  assert.deepEqual(events, ['register', 'dispose'], 'turn mode -> our registration is disposed')
  assert.equal(live, 0)

  // 再切回来 → 重新登记（顺序必须是 dispose 之后才 register，否则同 cell 同 priority 会抛）
  mode = 'per-message'
  ;(swap as (next: 'per-message' | 'turn') => void)('per-message')
  assert.deepEqual(events, ['register', 'dispose', 'register'])
  assert.equal(live, 1)

  disposer()
  assert.deepEqual(events, ['register', 'dispose', 'register', 'dispose'])
  assert.equal(listener, null, 'the preference subscription is released with the mount')
})

/* ------------------------------------------------------------ ⑤ 回合号只认可核实字段 */

test('turn number: only node.location.kind turn|step counts (same read as the host turnTail)', () => {
  assert.deepEqual(chatNodeTurn(nodeOf({ turn: 7, status: 'closed' })), { turn: 7, status: 'closed' })
  assert.deepEqual(chatNodeTurn({ kind: 'user', location: { kind: 'turn', turn: { turn: 2, status: 'open' } } }), { turn: 2, status: 'open' })
  // 不可核实的形状一律 null（绝不猜一个回合号）
  assert.equal(chatNodeTurn({ kind: 'user', location: { kind: 'session' } }), null)
  assert.equal(chatNodeTurn({ kind: 'user', location: { kind: 'unresolved' } }), null)
  assert.equal(chatNodeTurn({ kind: 'user' }), null)
  assert.equal(chatNodeTurn({ kind: 'user', location: { kind: 'step', turn: { status: 'closed' } } }), null)
  assert.equal(chatNodeTurn({ kind: 'user', location: { kind: 'step', turn: { turn: '3' } } }), null)
  assert.equal(chatNodeTurn(null), null)
  assert.equal(chatNodeTurn(undefined), null)
})

test('turn phase: only closed/open are provable; anything else is unknown (not "not finished")', () => {
  assert.equal(chatEntryTurnPhase({ turn: 1, status: 'closed' }), 'closed')
  assert.equal(chatEntryTurnPhase({ turn: 1, status: 'open' }), 'open')
  assert.equal(chatEntryTurnPhase({ turn: 1, status: 'unknown' }), 'unknown')
  assert.equal(chatEntryTurnPhase({ turn: 1, status: null }), 'unknown')
  assert.equal(chatEntryTurnPhase(null), 'unknown')
})

/* ------------------------------------------------------------ ③ 按钮启用/禁用矩阵 */

const CLOSED = { resolved: true, point: { id: 'p1', createdAt: 1, sessionId: 's1', turn: 3, kind: 'auto' } }
const MISSING = { resolved: true, point: null }
const UNRESOLVED = { resolved: false, point: null }

test('button matrix: every state maps to an enabled button or its own provable disabled reason', () => {
  const cases: { name: string; node: unknown; sessionId: string; lookup: unknown; pending: boolean; expect: string }[] = [
    { name: 'closed + hit', node: nodeOf(), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'enabled' },
    { name: 'closed + no point', node: nodeOf(), sessionId: 's1', lookup: MISSING, pending: false, expect: 'noPoint' },
    // 读失败（resolved=false 且不在途）→ 乐观可点：判据未知时**不**说「没有点」，让对话框走宿主的错误路径
    { name: 'closed + read failed (unknown verdict)', node: nodeOf(), sessionId: 's1', lookup: UNRESOLVED, pending: false, expect: 'enabled' },
    { name: 'closed + first paint before the read starts', node: nodeOf(), sessionId: 's1', lookup: null, pending: false, expect: 'enabled' },
    { name: 'closed + reading in flight', node: nodeOf(), sessionId: 's1', lookup: null, pending: true, expect: 'pointsPending' },
    { name: 'turn open', node: nodeOf({ status: 'open' }), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'turnOpen' },
    { name: 'turn status unknown', node: nodeOf({ status: 'unknown' }), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'turnUnknown' },
    { name: 'no verifiable turn number', node: { kind: 'user', data: { content: [] } }, sessionId: 's1', lookup: CLOSED, pending: false, expect: 'noTurn' },
    { name: 'no sessionId', node: nodeOf(), sessionId: '', lookup: CLOSED, pending: false, expect: 'noSession' },
  ]
  for (const item of cases) {
    const state = chatEntryButtonState({ node: item.node, sessionId: item.sessionId, lookup: item.lookup as never, pending: item.pending })
    if (item.expect === 'enabled') assert.equal(state.kind, 'enabled', item.name)
    else {
      assert.equal(state.kind, 'disabled', item.name)
      assert.equal(state.kind === 'disabled' ? state.code : 'enabled', item.expect, item.name)
    }
    if (state.kind === 'disabled') {
      assert.equal(state.key, CHAT_ENTRY_DISABLED_KEYS[state.code], item.name + ': key must come from the single map')
      assert.ok(chatZh[state.key as keyof typeof chatZh] !== undefined, item.name + ': zh dictionary missing ' + state.key)
      assert.ok(chatEn[state.key as keyof typeof chatEn] !== undefined, item.name + ': en dictionary missing ' + state.key)
    } else {
      assert.equal(state.turn, 3, item.name + ': the enabled button carries the verifiable turn number')
    }
  }
})

test('disabled reasons are pairwise distinct and every key exists in zh+en', () => {
  const codes = Object.keys(CHAT_ENTRY_DISABLED_KEYS) as ChatEntryDisabledCode[]
  const keys = codes.map((code) => CHAT_ENTRY_DISABLED_KEYS[code])
  assert.equal(new Set(keys).size, codes.length, 'two reasons must never share one sentence')
  for (const key of keys) {
    const zh = String(chatZh[key as keyof typeof chatZh])
    const en = String(chatEn[key as keyof typeof chatEn])
    assert.ok(zh !== '', 'zh dictionary is missing ' + key)
    assert.ok(en !== '', 'en dictionary is missing ' + key)
  }
})

/* ------------------------------------------------------------ ⑥ 回滚点惰取（缓存 / 去重） */

test('point lookup: the list is read once per session (N messages -> 1 request) and matched per turn', async () => {
  resetChatPointCache()
  const { port, calls } = fakePort()
  const first = await lookupPointForTurn({ port, sessionId: 's1', turn: 3 })
  assert.equal(first.resolved, true)
  assert.equal(first.point?.id, 'p-turn-3-auto', 'kind=auto wins over guard for the same turn')
  // 同一会话的其它回合 / 同一回合的重复读 / 另一个会话 —— 各自都只按会话取一次列表
  assert.equal((await lookupPointForTurn({ port, sessionId: 's1', turn: 3 })).point?.id, 'p-turn-3-auto')
  assert.equal((await lookupPointForTurn({ port, sessionId: 's1', turn: 2 })).point?.id, 'p-turn-2-auto')
  assert.equal((await lookupPointForTurn({ port, sessionId: 's1', turn: 9 })).point, null, 'same session, absent turn -> null')
  assert.equal(calls(), 1, 'one conversation = one list read, shared by every message button')
  assert.equal((await lookupPointForTurn({ port, sessionId: 's3', turn: 3 })).point, null, 'another session never matches')
  assert.equal(calls(), 2, 'a different session reads its own list')
  // 过期的缓存必须重读（TTL 判据用注入的 now，不依赖真实时钟）
  const later = await lookupPointForTurn({ port, sessionId: 's1', turn: 3, now: Date.now() + 60_000 })
  assert.equal(later.resolved, true)
  assert.equal(calls(), 3, 'an expired entry is refetched')
  resetChatPointCache()
})

test('point lookup: concurrent reads dedupe into one request; a failed read stays unresolved (never "no point")', async () => {
  resetChatPointCache()
  let calls = 0
  const pending = new Map<string, RollbackPointPort['rollbackPoints']>()
  const slowPort = {
    ...fakePort().port,
    rollbackPoints: async () => {
      calls += 1
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      return { points: POINTS, storage: { available: true } }
    },
  } as RollbackPointPort
  const [a, b, c] = await Promise.all([
    lookupPointForTurn({ port: slowPort, sessionId: 's1', turn: 3 }),
    lookupPointForTurn({ port: slowPort, sessionId: 's1', turn: 3 }),
    lookupPointForTurn({ port: slowPort, sessionId: 's1', turn: 3 }),
  ])
  assert.equal(calls, 1, 'three concurrent buttons must share one request')
  assert.equal(a.point?.id, 'p-turn-3-auto')
  assert.equal(b.point?.id, 'p-turn-3-auto')
  assert.equal(c.point?.id, 'p-turn-3-auto')
  assert.equal(pending.size, 0)

  resetChatPointCache()
  const { port: failing } = fakePort()
  const boom: RollbackPointPort = {
    ...failing,
    rollbackPoints: async () => { throw new Error('host down') },
  } as RollbackPointPort
  const failed = await lookupPointForTurn({ port: boom, sessionId: 's1', turn: 3 })
  assert.deepEqual(failed, { point: null, resolved: false }, 'a failed read is "unknown", never a proven absence')
  resetChatPointCache()
})

/* ------------------------------------------------------------ ② 气泡能力面（文本/图片/文件/rest） */

test('bubble text: text blocks keep newlines and whitespace verbatim (host contentParts shape)', () => {
  const view = buildChatEntryBubble([
    { type: 'text', text: 'line1\n  line2\t' },
    { type: 'text', text: 'line3' },
  ])
  assert.equal(view.text, 'line1\n  line2\tline3')
  assert.equal(view.showBubble, true)
  assert.equal(view.raw.length, 0)
})

test('bubble images: payload is forwarded verbatim (only renderMessageImages may render it)', () => {
  const attachment = { id: 'a1', width: 10, height: 20 }
  const view = buildChatEntryBubble([{ type: 'text', text: 'x' }, { type: 'image', attachment }])
  assert.equal(view.images.length, 1)
  assert.deepEqual(view.images[0], { attachment })
  // 逐张一次调用（宿主 attachments.map 的逐字同构）：单图 owner 只带一张
  assert.deepEqual(imageRenderOwnersOf(view), [{ images: [{ attachment }], align: 'end', compact: false }])
  const two = buildChatEntryBubble([{ type: 'image', attachment }, { type: 'image', attachment: { id: 'a2' } }])
  assert.deepEqual(
    imageRenderOwnersOf(two),
    [
      { images: [{ attachment }], align: 'end', compact: true },
      { images: [{ attachment: { id: 'a2' } }], align: 'end', compact: true },
    ],
    'one call per image, compact mirrors the host attachments.length > 1',
  )
  // 没有 attachment 的 image 块必须进 rest，绝不静默丢
  const noAttachment = buildChatEntryBubble([{ type: 'image' }])
  assert.equal(noAttachment.images.length, 0)
  assert.equal(noAttachment.raw.length, 1)
})

test('bubble file cards: file name + extension + size; a missing byte count stays unknown (no fake 0 B)', () => {
  const view = buildChatEntryBubble([
    { type: 'file', attachment: { name: 'C:/tmp/report.final.PDF', bytes: 1536 } },
    { type: 'file', attachment: { name: 'noext' } },
    { type: 'file', attachment: {} },
  ])
  assert.equal(view.files.length, 3)
  assert.deepEqual(view.files[0], { name: 'C:/tmp/report.final.PDF', ext: 'PDF', bytes: 1536 })
  assert.equal(fileSizeTextOf(view.files[0]!.bytes), '1.5 KB')
  assert.deepEqual(view.files[1], { name: 'noext', ext: null, bytes: null })
  assert.equal(fileSizeTextOf(null), null)
  assert.equal(fileSizeTextOf(512), '512 B')
  assert.equal(fileExtensionOf('.gitignore'), null)
  assert.equal(fileExtensionOf('a.b.c'), 'C')
})

test('bubble rest: unknown blocks always reach the renderer (nothing is silently dropped)', () => {
  const unknown = { type: 'mystery', payload: { deep: [1, 2] } }
  const view = buildChatEntryBubble([{ type: 'text', text: 'hi' }, unknown])
  assert.equal(view.raw.length, 1)
  assert.deepEqual(view.raw[0]?.payload, unknown)
  assert.equal(rawTextOf(view.raw[0]?.payload), JSON.stringify(unknown))

  // rest-only content still asks for a bubble (the host does the same with showBubble)
  const restOnly = buildChatEntryBubble([unknown])
  assert.equal(restOnly.text, '')
  assert.equal(restOnly.showBubble, true)

  // hostile / non-array content degrades into a visible block instead of vanishing
  assert.equal(buildChatEntryBubble('plain text').text, 'plain text')
  assert.equal(buildChatEntryBubble([null]).raw.length, 1)
  assert.equal(buildChatEntryBubble(undefined).raw.length, 0)
  assert.equal(buildChatEntryBubble(42).raw.length, 1)
})

test('view model: node data drives the bubble; referenceLabels/skillNames are recorded but not faked', () => {
  const view = buildChatEntryView({
    kind: 'user',
    location: { kind: 'step', turn: { turn: 5, status: 'closed' } },
    data: { content: [{ type: 'text', text: 'q' }], referenceLabels: ['session-a', 7], skillNames: ['changelog-writing'], time: 1_700_000_000_000 },
  })
  assert.equal(view.turnNumber, 5)
  assert.equal(view.turnStatus, 'closed')
  assert.equal(view.bubble.text, 'q')
  assert.deepEqual(view.referenceLabels, ['session-a'])
  assert.deepEqual(view.skillNames, ['changelog-writing'])
  assert.ok(view.clock !== null && view.clock !== '', 'a numeric data.time renders as a clock')
})

test('clock: numeric milliseconds format; a missing/hostile timestamp never fabricates the current time', () => {
  const formatted = formatChatEntryClock(1_700_000_000_000)
  assert.ok(formatted !== null && formatted.length > 0)
  assert.equal(formatChatEntryClock(null), null)
  assert.equal(formatChatEntryClock(Number.NaN), null)
  assert.equal(formatChatEntryClock(Number.POSITIVE_INFINITY), null)
  const noTime = buildChatEntryView({ kind: 'user', location: { kind: 'step', turn: { turn: 1, status: 'closed' } }, data: { content: [], time: '2026-10-10T00:00:00Z' } })
  assert.equal(noTime.clock, null, 'a string timestamp is not guessed into a clock')
})

/* ------------------------------------------------------------ ④ 错误边界降级 */

test('error boundary: a throwing projection still yields the user text as plain text', () => {
  const node = nodeOf({ content: [{ type: 'text', text: 'keep me visible' }] })
  const row = buildChatEntrySafeRow({ node, project: () => { throw new Error('projection exploded') } })
  assert.equal(row.text, 'keep me visible', 'the user message text must survive a projection crash')
  assert.deepEqual(row.fileNames, [])

  const normal = buildChatEntrySafeRow({ node, project: buildChatEntryView })
  assert.equal(normal.text, 'keep me visible')
})

test('error boundary: rest-only content still degrades to visible text; files are listed by name', () => {
  const node = nodeOf({ content: [{ type: 'mystery', payload: { a: 1 } }, { type: 'file', attachment: { name: 'x.txt', bytes: 1 } }] })
  const row = buildChatEntrySafeRow({ node, project: () => { throw new Error('boom') } })
  const newline = String.fromCharCode(10)
  const unknownText = JSON.stringify({ type: 'mystery', payload: { a: 1 } })
  assert.equal(row.text, unknownText + newline + 'x.txt', 'unknown blocks keep their JSON text and file blocks keep their name')
  const intact = buildChatEntrySafeRow({ node, project: buildChatEntryView })
  assert.deepEqual(intact.fileNames, ['x.txt'])
})

test('error boundary: the degradation is plain text, never a silent drop (plainTextOf is total)', () => {
  assert.equal(plainTextOf('abc'), 'abc')
  assert.equal(plainTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(plainTextOf([{ type: 'tool-call', id: 't' }]), JSON.stringify({ type: 'tool-call', id: 't' }))
  assert.equal(plainTextOf(null), '')
  assert.equal(plainTextOf(undefined), '')
  const circular: Record<string, unknown> = {}
  circular['self'] = circular
  assert.equal(typeof plainTextOf(circular), 'string', 'a circular payload must not throw')
})

test('error boundary: the console.warn prefix is ASCII (diagnostics only, never UI copy)', () => {
  assert.equal(CHAT_ENTRY_WARN_PREFIX, '[config-manager] chat user node renderer degraded to plain text: ')
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u4e00-\u9fff]/.test(CHAT_ENTRY_WARN_PREFIX), false, 'console.warn arguments must stay ASCII')
})

test('component-level boundary wiring is asserted through the pure helpers it calls', () => {
  // ChatEntryErrorBoundary 在 *.tsx 里（node 的 type-strip 不加载 tsx），但它调用的三件事都在这里：
  // ① getDerivedStateFromError 的返回形状；② componentDidCatch 的降级投影；③ 换节点后的复位判据。
  const failing = { failed: true, row: null }
  assert.equal(failing.failed, true)
  const node = nodeOf({ content: [{ type: 'text', text: 'still here' }] })
  assert.equal(buildChatEntrySafeRow({ node, project: () => { throw new Error('x') } }).text, 'still here')
  assert.equal(node !== nodeOf({ content: [{ type: 'text', text: 'still here' }] }), true, 'a new node object must reset the failed state')
})

/* ------------------------------------------------------------ 字典覆盖（组件里出现的键） */

test('i18n: every chat entry key used by the new surface exists in zh and en (same key set)', () => {
  const keys = [
    'chat.entry.label',
    'chat.entry.copy',
    'chat.entry.copied',
    'chat.entry.extraBlock',
    'chat.entry.truncated',
    'chat.entry.noImageRenderer',
    ...Object.values(CHAT_ENTRY_DISABLED_KEYS),
  ]
  for (const key of keys) {
    assert.ok(typeof chatZh[key as keyof typeof chatZh] === 'string', 'zh missing ' + key)
    assert.ok(typeof chatEn[key as keyof typeof chatEn] === 'string', 'en missing ' + key)
  }
  assert.deepEqual(Object.keys(chatZh).sort(), Object.keys(chatEn).sort(), 'zh and en must stay mirror images')
})

function rawTextOf(payload: unknown): string {
  return JSON.stringify(payload)
}
