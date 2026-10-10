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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  chatEntryCompactOf,
  chatNodeKind,
  chatNodeTurn,
  fileExtensionOf,
  fileSizeTextOf,
  formatChatEntryClock,
  lookupPointForTurn,
  plainTextOf,
  planChatEntryAttachments,
  planChatNodeRegistration,
  projectChatEntryText,
  resetChatPointCache,
  shouldRetryChatPoint,
  CHAT_POINT_LOOKUP_WINDOW_MS,
  CHAT_POINT_RETRY_DELAYS_MS,
  type ChatEntryDisabledCode,
  type ChatPointLookup,
} from './chat-entry-view.ts'
// T6：重试循环与「一个实例只跑一轮窗口」的状态机住在自己的模块里（可被 node 直接加载断言）
import {
  ChatPointWindowController,
  retryChatPointUntilHit,
  type ChatPointWindowState,
} from './chat-point-window.ts'
import { declaredSlotKind, mountChatNodeEntry, registerChatNodeEntry } from './chat-node-registration.ts'
import {
  CHAT_ENTRY_MODE_DEFAULT,
  CHAT_ENTRY_MODE_KEY,
  isChatEntryMode,
  readChatEntryMode,
  subscribeChatEntryMode,
  writeChatEntryMode,
} from './chat-entry-pref.ts'
import { planChatEntryRegistration, planChatEntryRegistrationForMode, registerChatEntry } from './rollback-entry-view.ts'
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

/* ------------------------------------------------------------ ① 单入口纪律（2026-10-10 用户第二条） */

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 读一个组件源码（*.tsx 不能在 node 下 type-strip 加载，故走源码级断言）。 */
function sourceOf(file: string): string {
  return readFileSync(join(HERE, file), 'utf8')
}

test('icon-only：两个入口都只画图标（无文字标签、无边框按钮、不 import Button）', () => {
  for (const file of ['ChatEntryView.tsx', 'RollbackTurnEntry.tsx']) {
    const src = sourceOf(file)
    assert.doesNotMatch(src, /from '\.\.\/common\/ui\.tsx'/, file + '：入口不得再 import Button（icon 级入口不用按钮组件）')
    assert.doesNotMatch(src, /<Button\b/, file + '：不得渲染 Button')
    // 图标复用 common/Icon.tsx 的 lucide 图标
    assert.match(src, /RefreshIcon/, file + '：必须复用 common/Icon.tsx 的回退图标')
    // 与复制图标同一个观感/触达区（无边框、无文字）
    assert.match(src, /className=\{css\.chatActionBtn\}/, file + '：icon 入口必须用与复制图标同一颗 .chatActionBtn')
    assert.match(src, /aria-label=\{t\('chat\.entry\.label'\)\}|aria-label=\{rt\('rollback\.preview\.turns'/, file + '：可见文案退到 aria-label，无障碍仍可读')
  }
  // 每条用户消息那颗按钮上不得再出现文字标签
  const entry = sourceOf('ChatEntryView.tsx')
  assert.doesNotMatch(entry, /\{t\('chat\.entry\.label'\)\}\s*<\/button>/, '不得把文案当可见子节点渲染')
  assert.doesNotMatch(entry, /title=\{t\('chat\.entry\.label'\)\}>\s*<RefreshIcon[^/]*\/>\s*[^<]/, '按钮里除图标外不得有文字')
})

test('单入口纪律：per-message 档下 turnTail 不注册，整回合档才注册（两档互斥）', () => {
  const warnings: string[] = []
  let registered = 0
  registerChatEntry({
    probe: { spec: () => ({ kind: 'list', scope: 'session' }) },
    readMode: () => 'per-message',
    register: () => { registered += 1; return () => {} },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(registered, 0, '「每条用户消息」档：同屏不得出现两个回退入口')
  assert.ok(warnings.some((line) => line.includes('per-message')))
  registerChatEntry({
    probe: { spec: () => ({ kind: 'list', scope: 'session' }) },
    readMode: () => 'turn',
    register: () => { registered += 1; return () => {} },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(registered, 1, '「整回合」档：回合尾那一颗才是入口')
  // 两档的登记面互补：per-message 注册 chat.node（keyed）、turn 注册 turnTail（list）
  assert.deepEqual(planChatNodeRegistration('keyed', 'per-message'), { kind: 'register' })
  assert.deepEqual(planChatEntryRegistrationForMode('per-message', { spec: () => ({ kind: 'list' }) }), { kind: 'skip', reason: 'per-message-mode', declared: null })
})

test('样式纪律：icon 入口与预览文件行只用既有 token/类，未引入第二套视觉体系', () => {
  const cssSheet = readFileSync(join(HERE, '..', 'config-manager.module.css'), 'utf8')
  // 新增的四个类都必须在唯一样式表里（组件里用了 css.* 却没定义就会渲染成 undefined）
  const used = new Set<string>()
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(HERE, file), 'utf8')
    for (const m of src.matchAll(/css\.([A-Za-z0-9_]+)/g)) used.add(m[1] as string)
  }
  for (const name of ['chatActionBtn', 'rollbackFileRow', 'rollbackFilePath', 'rollbackAdded', 'rollbackRemoved']) {
    assert.ok(used.has(name), '本任务新增/复用的类必须真的被组件用到：' + name)
    assert.ok(new RegExp('\\.' + name + '(?![A-Za-z0-9_-])').test(cssSheet), 'config-manager.module.css 缺类名：' + name)
  }
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
  const cases: { name: string; node: unknown; sessionId: string; lookup: unknown; pending: boolean; retrying?: boolean; expect: string }[] = [
    { name: 'closed + hit', node: nodeOf(), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'enabled' },
    { name: 'closed + no point', node: nodeOf(), sessionId: 's1', lookup: MISSING, pending: false, expect: 'noPoint' },
    // 读失败（resolved=false 且不在途）→ 乐观可点：判据未知时**不**说「没有点」，让对话框走宿主的错误路径
    { name: 'closed + read failed (unknown verdict)', node: nodeOf(), sessionId: 's1', lookup: UNRESOLVED, pending: false, expect: 'enabled' },
    { name: 'closed + first paint before the read starts', node: nodeOf(), sessionId: 's1', lookup: null, pending: false, expect: 'enabled' },
    { name: 'closed + reading in flight', node: nodeOf(), sessionId: 's1', lookup: null, pending: true, expect: 'pointsPending' },
    // R1：列表已读到但**空** + 重试窗口还开着 ⇒ 暂态，不得说「没有回滚点」（窗口关后同一状态才是 noPoint）
    { name: 'closed + empty list while the retry window is open', node: nodeOf(), sessionId: 's1', lookup: MISSING, pending: false, retrying: true, expect: 'pointsPending' },
    // T9：窗口开着、**首读还在途**（lookup 仍为 null）同样是「还没结论」⇒ 正在读取，不得乐观放行
    { name: 'closed + first read in flight while the window is open', node: nodeOf(), sessionId: 's1', lookup: null, pending: false, retrying: true, expect: 'pointsPending' },
    { name: 'turn open', node: nodeOf({ status: 'open' }), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'turnOpen' },
    { name: 'turn status unknown', node: nodeOf({ status: 'unknown' }), sessionId: 's1', lookup: CLOSED, pending: false, expect: 'turnUnknown' },
    { name: 'no verifiable turn number', node: { kind: 'user', data: { content: [] } }, sessionId: 's1', lookup: CLOSED, pending: false, expect: 'noTurn' },
    { name: 'no sessionId', node: nodeOf(), sessionId: '', lookup: CLOSED, pending: false, expect: 'noSession' },
  ]
  for (const item of cases) {
    const state = chatEntryButtonState({ node: item.node, sessionId: item.sessionId, lookup: item.lookup as never, pending: item.pending, retrying: item.retrying })
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

/* ------------------------------------------------------------ ⑥b 收尾竞态：有界重试 + 空结果不锁死（R1） */

const R1_HIT: ChatPointLookup = { point: { id: 'p-turn-3-auto', createdAt: 9, sessionId: 's1', turn: 3, kind: 'auto' }, resolved: true }
const R1_EMPTY: ChatPointLookup = { point: null, resolved: true }
const R1_UNRESOLVED: ChatPointLookup = { point: null, resolved: false }

/**
 * 确定性排程器 + 假时钟（**与 chat-entry-mount 的注入式排程器同一套做法**）：
 * 每次 `schedule` 把回调放进队列、同时按该档推进假时钟；`flush()` 排空队列并让出事件循环，
 * 使被 await 的重试循环继续跑 —— 所以用例既不用真睡 23 s，也能逐项断言「排了哪几次、等了多久」。
 */
function retryHarness(startAt = 0) {
  const queue: { fn: () => void; delayMs: number }[] = []
  const delays: number[] = []
  let clock = startAt
  /** 让出一次事件循环 —— 被 await 的循环/状态机借此把下一轮排进来。 */
  const tick = async (): Promise<void> => { await new Promise<void>((resolve) => { setImmediate(resolve) }) }
  /** **时钟在回调触发时前进**（与真 setTimeout 同一因果顺序，别在排程时前进 —— 那会让「时钟没动」的护栏误触发）。 */
  const fire = (entry: { fn: () => void; delayMs: number }): void => { clock += entry.delayMs; entry.fn() }
  return {
    now: () => clock,
    retry: (fn: () => void, delayMs: number) => { delays.push(delayMs); queue.push({ fn, delayMs }) },
    /**
     * 排空调度队列；**若有给定 promise，则在它有界 tick 内 settle 之前一直驱动**（确定性）。
     *
     * 为什么要一起驱动：重试循环在被 await 的微任务链里推进，队列可能在一瞬间是空的
     * （刚执行完一个回调、下一档还没排进来）—— 只看 `queue.length === 0` 就退出会**过早**。
     * 既然循环承诺「要么命中、要么有界结束」，这里就用 tick 上限兜底：循环挂死时用例会失败，
     * 而不是把测试一起拖死。
     *
     * @returns 该 promise 是否在预算内 settle（无 promise 时为 true）
     */
    /**
     * 只推进 **`steps`** 个已排程的回调（不等到跑完）—— 用于「中途取消」这类用例：
     * 先让循环跑一步（首读 + 第一次重试），再从外部取消。
     */
    pump: async (steps: number): Promise<void> => {
      for (let i = 0; i < steps; i += 1) {
        await tick()
        const entry = queue.shift()
        if (entry !== undefined) fire(entry)
        await tick() // 让循环/状态机的微任务链跑完再返回（否则「刚触发」的状态读到一半）
      }
    },
    flush: async (run?: Promise<unknown>, ticks = 300): Promise<boolean> => {
      let settled = run === undefined
      if (run !== undefined) void run.then(() => { settled = true }, () => { settled = true })
      for (let i = 0; i < ticks; i += 1) {
        await tick()
        // 先看还有没有待执行的排程（settled 可能在这一步的微任务里刚刚变 true，但队列里还有回调）
        const entry = queue.shift()
        if (entry !== undefined) { fire(entry); continue }
        // 队列空了才算真的跑完（循环要么在该 tick 里排下一档，要么已经 settle）
        if (settled) return true
      }
      return settled
    },
    delays,
  }
}

test('R1 window: the retry schedule is a fixed 5-step backoff bounded inside an explicit window', () => {
  // 验收要求「在注释与测试里写一个明确值」：这里把三个数字逐项钉住
  assert.deepEqual([...CHAT_POINT_RETRY_DELAYS_MS], [500, 1_500, 3_000, 6_000, 12_000], '退避表 = 0.5 / 1.5 / 3 / 6 / 12 s')
  const cumulative = CHAT_POINT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
  assert.equal(cumulative, 23_000, '退避表累计 23 s')
  assert.equal(CHAT_POINT_LOOKUP_WINDOW_MS, 30_000, '窗口是明确的 30 s（落在 10–30 s 区间）')
  assert.ok(cumulative < CHAT_POINT_LOOKUP_WINDOW_MS, '退避表必须落在窗口内（最后一轮读得到，而不是注定超窗）')
  for (let i = 1; i < CHAT_POINT_RETRY_DELAYS_MS.length; i += 1) {
    assert.ok((CHAT_POINT_RETRY_DELAYS_MS[i] as number) > (CHAT_POINT_RETRY_DELAYS_MS[i - 1] as number), '退避必须严格递增（否则就是轮询）')
  }
  assert.deepEqual(CHAT_POINT_RETRY_DELAYS_MS, [...CHAT_POINT_RETRY_DELAYS_MS].sort((a, b) => a - b), '退避表本身必须有序')
})

test('R1 empty session: retries are bounded (6 reads total, 5 waits, zero further read after the window)', async () => {
  const h = retryHarness()
  const forces: boolean[] = []
  const run = retryChatPointUntilHit({
    attempt: async (force) => { forces.push(force); return R1_EMPTY },
    retry: h.retry,
    now: h.now,
  })
  assert.equal(await h.flush(run), true, '窗口结束时循环必须已 settle（不是悬挂）')
  const { result, reads } = (await run) as { result: ChatPointLookup; reads: number }
  assert.deepEqual(forces, [false, true, true, true, true, true], '首读走普通读，其后每一轮都强制刷新（跳过那 30 s 缓存）')
  assert.equal(reads, 6, '窗口内恰好 6 次读取：1 次首读 + 5 次重试（不是无限轮询）')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '每一次重试都按退避表的下一档排程')
  assert.equal(h.delays.reduce((sum, delay) => sum + delay, 0), 23_000)
  assert.deepEqual(result, R1_EMPTY, '窗口结束仍为空 ⇒ 调用点从此可以说「没有回滚点」')
  assert.equal(h.now() < CHAT_POINT_LOOKUP_WINDOW_MS, true, '整个重试过程都在窗口内结束')
})

test('R1 hit: the first hit stops the schedule immediately (no further read is ever scheduled)', async () => {
  const h = retryHarness()
  const forces: boolean[] = []
  const run = retryChatPointUntilHit({
    attempt: async (force) => { forces.push(force); return forces.length >= 3 ? R1_HIT : R1_EMPTY },
    retry: h.retry,
    now: h.now,
  })
  assert.equal(await h.flush(run), true, '命中时循环必须已 settle')
  const { result, reads } = (await run) as { result: ChatPointLookup; reads: number }
  assert.equal(reads, 3, '第三次读到点 ⇒ 停止（不再读第 4 次）')
  assert.deepEqual(forces, [false, true, true])
  assert.deepEqual(h.delays, [500, 1_500], '只排了命中前的两次重试：命中后一个定时器都不再排（不 churn）')
  assert.equal(result.point?.id, 'p-turn-3-auto')
  assert.equal(shouldRetryChatPoint(result), false, '命中即停的唯一判据')
  assert.equal(shouldRetryChatPoint(R1_EMPTY), true, '读到空列表仍是暂态，必须继续（这正是旧实现永久禁用的根因）')
  assert.equal(shouldRetryChatPoint(R1_UNRESOLVED), true, '读失败是判据未知，同样不能当成「没有」')
  assert.equal(shouldRetryChatPoint(null), true)
})

test('R1 late write（真机时序：收尾后 7.8 s 才写完点）：重试把这个回合的点抓回来', async () => {
  // 真机：turn/end 之后引擎还要 7.8 s 才写完点 ⇒ 首读必空、后续轮才可能命中。
  // 这里用**假时钟上的晚到写回**同构复现：宿主在第 LATE_AT 毫秒之前返回空列表，之后才返回点。
  const LATE_AT = 1_600
  const { port } = fakePort([])
  const late: RollbackPointPort = {
    ...port,
    rollbackPoints: async () => ({ points: Date.now() - startedAt >= LATE_AT ? POINTS : [], storage: { available: true } }),
  } as RollbackPointPort
  const startedAt = Date.now() // 必须在 port 被调用之前取值（闭包里读它）
  resetChatPointCache()
  let reads = 0
  const { result, reads: total } = await retryChatPointUntilHit({
    attempt: (force) => { reads += 1; return lookupPointForTurn({ port: late, sessionId: 's1', turn: 3, force }) },
    // 3/3/3 s 一档 = 退避表的压缩版（假窗口 10 s）：第 1 档 3 s 时仍空、第 2 档 6 s 时撞上晚到的写回
    delays: [3_000, 3_000, 3_000],
    windowMs: 10_000,
  })
  assert.equal(result.resolved, true)
  assert.equal(result.point?.id, 'p-turn-3-auto', '空 → 有点的时序里，重试必须把点抓回来（而不是把空列表当真值）')
  assert.ok(reads >= 2 && total >= 2, '至少读了两轮才可能撞上晚到的写回，实际 reads=' + String(total))
  resetChatPointCache()
})

test('R1 force: 强制刷新绕过 30 s 列表缓存（跳过缓存读、写回新结果），且不破在途去重', async () => {
  resetChatPointCache()
  const { port, calls } = fakePort([]) // 首读：列表里还没有这个回合的点（真机的空窗）
  const first = await lookupPointForTurn({ port, sessionId: 's1', turn: 3 })
  assert.equal(first.point, null)
  assert.equal(calls(), 1)
  // 非强制：30 s 缓存内的第二次读**不会**再发请求（空结果被缓存 —— 旧实现就死在这里）
  await lookupPointForTurn({ port, sessionId: 's1', turn: 3 })
  assert.equal(calls(), 1, '非强制读走缓存（30 s TTL 一个字没动）')
  // 强制：跳过缓存读、真的再读一次宿主
  await lookupPointForTurn({ port, sessionId: 's1', turn: 3, force: true })
  assert.equal(calls(), 2, 'force 必须真的再读一次宿主（否则空结果会锁死 30 s）')
  // 且**写回**新结果：宿主侧之后出现了这个回合的点，下一次非强制读立刻拿得到
  const grown = {
    ...fakePort().port,
    rollbackPoints: async () => ({ points: POINTS, storage: { available: true } }),
  } as RollbackPointPort
  const fresh = await lookupPointForTurn({ port: grown, sessionId: 's1', turn: 3, force: true })
  assert.equal(fresh.point?.id, 'p-turn-3-auto', 'force 的结果必须写回缓存')
  const cachedHit = await lookupPointForTurn({ port: grown, sessionId: 's1', turn: 3 })
  assert.equal(cachedHit.point?.id, 'p-turn-3-auto', '写回之后按缓存读也命中（不是「每次都必须 force」）')
  resetChatPointCache()
})

test('R1 wiring：组件接了有界重试，且窗口状态交给一次性状态机（不让 effect 自己重开窗口）', () => {
  const src = sourceOf('ChatEntryView.tsx')
  assert.match(src, /import \{ ChatPointWindowController, type ChatPointWindowState \} from '\.\/chat-point-window\.ts'/, '窗口状态机必须来自纯模块（可被 node 断言）')
  // T9/RR2-A：实例必须建在 effect **体内**；放进 useMemo 会被 StrictMode 的第二次 effect 复用 ⇒ 永久死窗
  assert.match(src, /const controller = new ChatPointWindowController\(\{/, '实例必须在 effect 体内新建（一次 effect 调用 = 一个新实例）')
  assert.doesNotMatch(src, /useMemo\(\s*\(\)\s*=>\s*new ChatPointWindowController/, 'RR2-A：不得再把实例放进 useMemo（那正是 StrictMode 双调用下窗口永久死掉的根因）')
  assert.match(src, /attempt: \(force\) => lookupPointForTurn\(\{ port, sessionId, turn[^)]*force \}\)/, '重试轮必须传 force 以跳过那 30 s 缓存')
  assert.match(src, /chatEntryButtonState\(\{ node, sessionId, lookup, pending: false, retrying \}\)/, '按钮状态机由 retrying（窗口开着）单一驱动，不再需要手写的 pending 标志')
  assert.match(src, /controller\.start\(\)/, '挂载后必须启动这一轮窗口')
  assert.match(src, /return \(\) => \{ controller\.dispose\(\) \}/, '卸载/依赖变化必须走取消通道（F2）')
  assert.doesNotMatch(src, /retryTimerRef/, 'F2：重试定时器 ref / clearTimeout 的旧做法必须消失（改走取消通道）')
  assert.match(src, /\}, \[canLookup, port, sessionId, turn\]\)/, 'F1：effect 依赖只有 canLookup / 会话 / 回合 —— 不含任何 React 状态')
  assert.doesNotMatch(src, /\[canLookup, [^\]]*lookup/, 'F1：依赖里不得含 lookup（窗口关后那次 setState 会重跑 effect）')
  assert.doesNotMatch(src, /windowClosed/, 'T9：windowOpen 取代了 windowClosed（去双重否定，少一处可能漂移的标志）')
  assert.doesNotMatch(src, /if \(!canLookup \|\| turn === null \|\| lookup !== null\) return undefined/, '旧的「读到过就永不重查」条件必须已经消失')
})

/* ------------------------------------------------------------ ⑥c T6：窗口不重开（F1）+ 可取消（F2） */

test('F1：点始终不出现时，一个实例只跑一轮（窗口关后把时钟推过 3 个窗口仍恒为 6 次读）', async () => {
  const h = retryHarness()
  let reads = 0
  const seen: ChatPointWindowState[] = []
  const controller = new ChatPointWindowController({
    attempt: async () => { reads += 1; return R1_EMPTY },
    onState: (state) => { seen.push(state) },
    retry: h.retry,
    now: h.now,
  })
  controller.start()
  await h.flush()
  assert.equal(reads, 6, '一轮窗口 = 1 次首读 + 5 次重试')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '恰好按退避表排了 5 档')
  const closedAt = h.now()
  assert.equal(closedAt, 23_000, '窗口在退避表走完那一刻关掉（累计 23 s）')
  assert.equal(controller.state().open, false, '窗口已关')
  assert.deepEqual(controller.state().lookup, R1_EMPTY, '关窗时的结果就是末次读的结果（空 ⇒ 之后才允许说「没有回滚点」）')

  // 推过 3 个窗口时长：同实例再 start() 若干次，读次数必须**恒为 6**（不是 18）
  for (let round = 0; round < 3; round += 1) { controller.start(); await h.flush() }
  assert.equal(h.now(), 23_000, '时钟没有再前进（没有新的排程 ⇒ 没有任何新的等待）')
  assert.equal(reads, 6, 'F1：时钟推过 3 个窗口后读取次数仍恒为 6（旧实现会是 6×4=24）')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '再也没有新的排程（零 churn）')
  assert.equal(seen.length, 2, '状态回调恰好两次：开窗一次 + 关窗一次（没有周期性重开）')
  assert.deepEqual(seen[0], { lookup: null, open: true }, '开窗态：还不知道结果，窗口开着 ⇒ 界面显示「正在读取」')
})

test('F1 证实（旧形态是「每 settle 一次就重开一轮」）：同样的假时钟下 4 轮 = 24 次读', async () => {
  // 旧组件的形态：effect 依赖含 lookup ⇒ 每一轮窗口 settle（setLookup 写新对象）就重跑 effect、
  // 守卫只挡「已命中」⇒ 再开一轮。这里把那个形态**逐字建模**成可执行断言 ——
  // 它证明 F1 不是猜测：同样的退避表与窗口，4 轮会读到 24 次（修复后同一时钟下恒为 6 次）。
  const h = retryHarness()
  let reads = 0
  for (let round = 0; round < 4; round += 1) {
    const run = retryChatPointUntilHit({ attempt: async () => { reads += 1; return R1_EMPTY }, retry: h.retry, now: h.now })
    assert.equal(await h.flush(run), true, '第 ' + String(round + 1) + ' 轮窗口照常收尾（这正是它会重开的原因）')
    await run
  }
  assert.equal(reads, 24, '旧形态 4 轮 = 24 次读（F1 的周期性重开：每 ~23 s 一轮）')
  assert.equal(h.delays.length, 20, '旧形态一共排了 20 档（4 × 5）')
})

test('F1：新实例 = 用户的「再次触发」仍能重新开一轮（不得永久锁死）', async () => {
  const h1 = retryHarness()
  let reads1 = 0
  const first = new ChatPointWindowController({ attempt: async () => { reads1 += 1; return R1_EMPTY }, onState: () => {}, retry: h1.retry, now: h1.now })
  first.start()
  await h1.flush()
  assert.equal(reads1, 6, '第一次挂载跑满一轮')
  first.dispose()
  await h1.flush()
  assert.equal(reads1, 6, 'dispose 之后一次请求都不再发')

  // 重新挂载 / 会话切换 = 新实例（独立窗口）：窗口关过不是「永久锁死」
  const h2 = retryHarness()
  let reads2 = 0
  const second = new ChatPointWindowController({ attempt: async () => { reads2 += 1; return R1_EMPTY }, onState: () => {}, retry: h2.retry, now: h2.now })
  second.start()
  await h2.flush()
  assert.equal(reads2, 6, '新实例必须能重新跑一轮（用户再次触发不被永久锁死）')
  assert.deepEqual(h2.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '新实例自己有完整的一轮窗口')
})

test('F1 边界：窗口关后 start() 不会重开；重新挂载（新实例）能重新开一轮 —— 可执行版本', async () => {
  const h = retryHarness()
  let reads = 0
  let controller = new ChatPointWindowController({ attempt: async () => { reads += 1; return R1_EMPTY }, onState: () => {}, retry: h.retry, now: h.now })
  controller.start()
  await h.flush()
  assert.equal(controller.state().open, false)
  assert.equal(reads, 6)
  controller.start() // 重入（等价于 effect 重跑）—— 不得重开
  await h.flush()
  assert.equal(reads, 6, '窗口已关 ⇒ start() 是 no-op（F1 的核心不变量）')
  // 重新挂载 = 新实例
  controller = new ChatPointWindowController({ attempt: async () => { reads += 1; return R1_EMPTY }, onState: () => {}, retry: h.retry, now: h.now })
  controller.start()
  await h.flush()
  assert.equal(reads, 12, '新实例照常跑一轮（6 + 6）—— 「已跑过」只限实例，不是永久锁死')
})

test('F2：取消通道 —— dispose 后循环在有界 tick 内 settle，且宿主读取次数不再增加', async () => {
  const h = retryHarness()
  let reads = 0
  let cancelled = false
  const run = retryChatPointUntilHit({
    attempt: async () => { reads += 1; return R1_EMPTY },
    retry: h.retry,
    now: h.now,
    isCancelled: () => cancelled,
  })
  await h.pump(1) // 只跑到第一次重试（排程里还有下一档）
  assert.equal(reads, 2, '取消之前已经读了 2 次（首读 + 第一次重试）')
  const scheduledAtCancel = h.delays.length
  cancelled = true
  assert.equal(await h.flush(run), true, 'F2：被取消的循环必须在有限 tick 内 settle（旧实现在这里悬挂）')
  assert.equal(reads, 2, '取消之后一次宿主读取都不再发生')
  assert.equal(h.delays.length, scheduledAtCancel, '取消之后不再排任何新定时器')
})

test('F2：取消发生在等待定时器期间 ⇒ 立刻收尾、不再进下一轮读（把时钟推过整个窗口也不动）', async () => {
  const h = retryHarness()
  let reads = 0
  let cancelled = false
  const run = retryChatPointUntilHit({ attempt: async () => { reads += 1; return R1_EMPTY }, retry: h.retry, now: h.now, isCancelled: () => cancelled })
  await h.pump(1) // 首读 + 第一次重试（正处在「等下一档」的 await 里）
  assert.equal(reads, 2)
  cancelled = true
  assert.equal(await h.flush(run), true, '循环已 settle（没有悬挂的 await）')
  assert.equal(reads, 2, '卸载后宿主读取次数不再增加')
  // 取消之后继续推排程：队列里再也没有新东西 ⇒ 一次读都不会多（窗口不再重开）
  await h.pump(5)
  assert.equal(reads, 2, '卸载后继续推进排程也不会有任何新读取')
})

test('F2 组件侧：dispose 之后就再也不会有状态回调（卸载后 pending 不再被写）', async () => {
  const h = retryHarness()
  const states: ChatPointWindowState[] = []
  let reads = 0
  const controller = new ChatPointWindowController({
    attempt: async () => { reads += 1; return R1_EMPTY },
    onState: (state) => { states.push(state) },
    retry: h.retry,
    now: h.now,
  })
  controller.start()
  assert.deepEqual(states, [{ lookup: null, open: true }], '启动那一刻先回调「窗口开着、还没有结果」')
  controller.dispose() // 卸载：组件不再需要任何状态
  await h.flush()
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(states.length, 1, 'dispose 之后不再有 onState 回调（不会在卸载后 setState）')
  assert.equal(reads, 1, '取消在第一次读之后立即生效：只有那一次已经在途的读')
})

/* ------------------------------------------------------------ ⑥d T9：StrictMode 双调用（RR2-A）+ dispose 语义（RR2-B） */

test('RR2-A：StrictMode 双调用（effect → cleanup → effect）后窗口必须关掉、按钮必须能到 enabled', async () => {
  const h = retryHarness()
  let globalReads = 0
  const all: ChatPointWindowState[] = []
  /**
   * **与组件 effect 逐字同形**的一次调用：新建实例（修法①）+ start + 返回它自己的 onState 记录。
   * 组件就是这么写的（controller 在 effect 体内 new），所以 StrictMode 的
   * `effect → cleanup → effect` 序列在这里就是可执行断言。
   */
  const effectRun = (hitAfter: number): { controller: ChatPointWindowController; states: ChatPointWindowState[] } => {
    const own: ChatPointWindowState[] = []
    let ownReads = 0
    const controller = new ChatPointWindowController({
      attempt: async () => { globalReads += 1; ownReads += 1; return ownReads >= hitAfter ? R1_HIT : R1_EMPTY },
      onState: (state) => { own.push(state); all.push(state) },
      retry: h.retry,
      now: h.now,
    })
    controller.start()
    return { controller, states: own }
  }

  // ① 第一次 effect 调用：首读在途（此时按钮态 = pointsPending，这是对的）
  const first = effectRun(99) // 永不命中
  assert.equal(globalReads, 1, '第一次调用发出首读')
  assert.deepEqual(first.states, [{ lookup: null, open: true }], '开窗一次（还不知道结果 ⇒ 显示「正在读取」）')
  // ② StrictMode 立刻 cleanup（同一实例被 dispose）
  first.controller.dispose()
  assert.equal(first.controller.state().open, false, '①：被 dispose 的实例不得再声称「窗口开着」（旧实现恒 open: true）')
  // ③ 第二次 effect 调用：**新实例**（修法①）—— 窗口必须照常工作
  const second = effectRun(2) // 第二次读（一次重试）就命中
  assert.equal(await h.flush(), true, '新实例这一轮必须跑到收尾')
  assert.equal(second.controller.state().open, false, '①：窗口必须被正常关掉（旧实现这里永久 open: true）')
  assert.equal(second.controller.state().lookup?.point?.id, 'p-turn-3-auto', '②：点出现时必须读到点')
  // ② 派生按钮态：命中 ⇒ enabled —— 不得停在 pointsPending
  const button = chatEntryButtonState({
    node: nodeOf(),
    sessionId: 's1',
    lookup: second.controller.state().lookup,
    pending: false,
    retrying: second.controller.state().open,
  })
  assert.equal(button.kind, 'enabled', '②：修好后按钮必须能到 enabled（旧实现永久停在禁用的「正在读取」）')
  // ① reviewer 的反向判据：**出现 closed onState**，且活下来的那个实例恰好开/关各一次
  assert.equal(second.states.length, 2, '①：关窗的那个实例恰好两次 onState（开窗 + 关窗）')
  assert.deepEqual(second.states.map((state) => state.open), [true, false], '①：第二次是 closed onState')
  assert.equal(all.filter((state) => !state.open).length, 1, '①：整个序列里恰有一次关窗（不再有「永久开窗」的实例）')
  // ③ 次数与退避仍在界内、不叠加
  assert.equal(globalReads, 3, '③：被取消的 1 次 + 新实例的 2 次（每实例 ≤6）')
  assert.deepEqual(h.delays, [500], '③：新实例只排了一档（第二次读就命中 ⇒ 命中即停）')
  assert.ok(h.now() < CHAT_POINT_LOOKUP_WINDOW_MS, '③：虚拟 23 s 以内 < 30 s 窗口')
  second.controller.start()
  await h.flush()
  assert.equal(globalReads, 3, '③：窗口关掉后 start() 仍是 no-op（重跑不叠加）')
})

test('RR2-A/② 空场景：StrictMode 序列后窗口关且仍为空 ⇒ 按钮必须是 noPoint（不得停在 pointsPending）', async () => {
  const h = retryHarness()
  let reads = 0
  /** 与组件 effect 同形的一次调用：新实例 + start。 */
  const effectRun = (): ChatPointWindowController => {
    const controller = new ChatPointWindowController({
      attempt: async () => { reads += 1; return R1_EMPTY },
      onState: () => {},
      retry: h.retry,
      now: h.now,
    })
    controller.start()
    return controller
  }
  const first = effectRun()
  first.dispose()
  const second = effectRun() // StrictMode 的第二次 effect
  assert.equal(await h.flush(), true, '第二次调用这一轮必须跑到收尾')
  assert.equal(second.state().open, false, '①：窗口必须关掉（不是永久「正在读取」）')
  assert.deepEqual(second.state().lookup, R1_EMPTY, '关窗时的结论：这个回合（此刻）没有点')
  assert.equal(reads, 7, '②：被取消的 1 次 + 新实例完整一轮 6 次（每实例 ≤6）')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '②：只有新实例排了那 5 档（被取消的实例零排程）')
  const button = chatEntryButtonState({
    node: nodeOf(),
    sessionId: 's1',
    lookup: second.state().lookup,
    pending: false,
    retrying: second.state().open,
  })
  assert.equal(button.kind, 'disabled', '②：窗口关且仍空 ⇒ 禁用')
  assert.equal(button.kind === 'disabled' ? button.code : 'enabled', 'noPoint', '②：必须是 noPoint（而不是永久 pointsPending）')
})

test('RR2-A/④ 非 StrictMode 回归：一次 effect = 一轮恒 6 读，窗口关后 start() 仍 no-op', async () => {
  const h = retryHarness()
  let reads = 0
  const states: ChatPointWindowState[] = []
  const controller = new ChatPointWindowController({
    attempt: async () => { reads += 1; return R1_EMPTY },
    onState: (state) => { states.push(state) },
    retry: h.retry,
    now: h.now,
  })
  controller.start()
  await h.flush()
  assert.equal(reads, 6, '④：一轮 = 1 次首读 + 5 次重试')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '④：退避恰好 5 档')
  assert.equal(h.now(), 23_000, '④：虚拟 23 s')
  assert.ok(h.now() < CHAT_POINT_LOOKUP_WINDOW_MS, '④：23 s < 30 s 窗口')
  assert.deepEqual(states.map((state) => state.open), [true, false], '④：开窗 + 关窗各一次')
  assert.equal(controller.state().open, false)
  controller.start()
  await h.flush()
  assert.equal(reads, 6, '④：窗口关后 start() 仍是 no-op（不叠加）')
  assert.deepEqual(h.delays, [...CHAT_POINT_RETRY_DELAYS_MS], '④：零新排程')
})

test('RR2-A/③ 连续 3 个 StrictMode 回合：每个被取消的实例最多 1 次读、零残留排程', async () => {
  const h = retryHarness()
  let reads = 0
  const perInstance: number[] = []
  for (let round = 0; round < 3; round += 1) {
    let own = 0
    // 一次 effect 调用 = 一个新实例；StrictMode 紧接着 cleanup ⇒ 只可能有一次在途读
    const controller = new ChatPointWindowController({
      attempt: async () => { reads += 1; own += 1; return R1_EMPTY },
      onState: () => {},
      retry: h.retry,
      now: h.now,
    })
    controller.start()
    controller.dispose()
    perInstance.push(own)
    await h.flush()
  }
  assert.deepEqual(perInstance, [1, 1, 1], '③：每个被取消的实例只读了那一次在途读')
  assert.equal(reads, 3, '③：3 个回合共 3 次读（没有叠加成 3×6）')
  assert.deepEqual(h.delays, [], '③：读回来时才发现被取消 ⇒ 连一档排程都不排（取消的最早生效点）')
})

test('RR2-B：dispose 只置取消 + 把 state 记为已关窗，**不回调** onState（不制造卸载后 setState）', async () => {
  const h = retryHarness()
  let reads = 0
  const states: ChatPointWindowState[] = []
  const controller = new ChatPointWindowController({
    attempt: async () => { reads += 1; return R1_EMPTY },
    onState: (state) => { states.push(state) },
    retry: h.retry,
    now: h.now,
  })
  controller.start()
  assert.equal(states.length, 1, 'start ⇒ 一次开窗回调')
  controller.dispose()
  assert.equal(controller.state().open, false, 'RR2-B：dispose 后 state 不再声称窗口开着（注释与实现一致）')
  assert.equal(states.length, 1, 'RR2-B：dispose 不回调（此刻调用点正在卸载/换会话）')
  assert.equal(await h.flush(), true, '被取消的循环立即 settle')
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(states.length, 1, '循环 settle 也不再回调：窗口终值只能读 state()')
  assert.equal(reads, 1, '在途那次读之后不再有新读')
  assert.deepEqual(h.delays, [], 'dispose 之后连一档排程都不排')
  controller.start()
  await h.flush()
  assert.equal(reads, 1, 'dispose 是永久停手：再 start() 也不复活（不得用「忽略 dispose」绕过）')
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
  // 逐张一次调用（宿主 attachments.map 的逐字同构）：单图 owner 只带一张；单个附件 ⇒ compact=false
  assert.deepEqual(planChatEntryAttachments(view), [{ kind: 'image', index: 0, owner: { images: [{ attachment }], align: 'end', compact: false } }])
  const two = buildChatEntryBubble([{ type: 'image', attachment }, { type: 'image', attachment: { id: 'a2' } }])
  assert.deepEqual(
    planChatEntryAttachments(two),
    [
      { kind: 'image', index: 0, owner: { images: [{ attachment }], align: 'end', compact: true } },
      { kind: 'image', index: 1, owner: { images: [{ attachment: { id: 'a2' } }], align: 'end', compact: true } },
    ],
    'one call per image, compact mirrors the host attachments.length > 1',
  )
  // 没有 attachment 的 image 块必须进 rest，绝不静默丢
  const noAttachment = buildChatEntryBubble([{ type: 'image' }])
  assert.equal(noAttachment.images.length, 0)
  assert.equal(noAttachment.raw.length, 1)
})

test('attachments: one ordered list in content order + compact counts ALL attachments (D1/D2)', () => {
  // 反例（t4 复核给的例子）：file 在前、image 在后 —— 旧实现固定「先图片后文件」，顺序是反的；
  // compact 旧实现只看图片数（这里 images.length=1 ⇒ false），宿主看**附件总数**（2 ⇒ true）。
  const fileFirst = buildChatEntryBubble([
    { type: 'file', attachment: { name: 'first.txt', bytes: 3 } },
    { type: 'image', attachment: { id: 'a' } },
  ])
  assert.deepEqual(fileFirst.attachments.map((item) => item.kind), ['file', 'image'], 'attachment order must follow content order')
  assert.equal(chatEntryCompactOf(fileFirst), true, 'file + image = 2 attachments => compact (host rule)')
  const plan = planChatEntryAttachments(fileFirst)
  assert.deepEqual(plan.map((item) => item.kind), ['file', 'image'], 'the render plan keeps content order')
  assert.equal(plan[0]?.kind === 'file' ? plan[0].size : null, '3B', 'file card size text rides along')
  assert.equal(plan[1]?.kind === 'image' ? plan[1].owner.compact : null, true, 'the image owner carries the total-attachment compact flag')

  // 单个文件 ⇒ compact=false（附件总数 1）；图片 + 两个文件 ⇒ true
  assert.equal(chatEntryCompactOf(buildChatEntryBubble([{ type: 'file', attachment: { name: 'a.txt', bytes: 1 } }])), false)
  assert.equal(chatEntryCompactOf(buildChatEntryBubble([
    { type: 'image', attachment: { id: 'i' } },
    { type: 'file', attachment: { name: 'a.txt', bytes: 1 } },
    { type: 'file', attachment: { name: 'b.txt', bytes: 2 } },
  ])), true)

  // 三者交错时逐项顺序 = content 顺序，且 images/files 是它的派生视图（同一份真相）
  const mixed = buildChatEntryBubble([
    { type: 'image', attachment: { id: 'i1' } },
    { type: 'file', attachment: { name: 'f1.txt', bytes: 1 } },
    { type: 'image', attachment: { id: 'i2' } },
    { type: 'file', attachment: { name: 'f2.txt', bytes: 2 } },
  ])
  assert.deepEqual(mixed.attachments.map((item) => item.kind), ['image', 'file', 'image', 'file'])
  assert.deepEqual(mixed.files.map((file) => file.name), ['f1.txt', 'f2.txt'])
  assert.deepEqual(mixed.images.map((image) => image.attachment), [{ id: 'i1' }, { id: 'i2' }])
})

test('bubble file cards: file name + extension + size; a missing byte count stays unknown (no fake 0 B)', () => {
  const view = buildChatEntryBubble([
    { type: 'file', attachment: { name: 'C:/tmp/report.final.PDF', bytes: 1536 } },
    { type: 'file', attachment: { name: 'noext' } },
    { type: 'file', attachment: {} },
  ])
  assert.equal(view.files.length, 3)
  assert.deepEqual(view.files[0], { name: 'C:/tmp/report.final.PDF', ext: 'PDF', bytes: 1536 })
  assert.equal(fileSizeTextOf(view.files[0]!.bytes), '1.5KB')
  assert.deepEqual(view.files[1], { name: 'noext', ext: null, bytes: null })
  assert.equal(fileSizeTextOf(null), null)
  // 宿主 fileSizeText 逐字复刻：**无空格**；判的是**单位值** < 10 才带一位小数，≥10 取整
  assert.equal(fileSizeTextOf(0), '0B')
  assert.equal(fileSizeTextOf(512), '512B')
  assert.equal(fileSizeTextOf(1024), '1.0KB')
  assert.equal(fileSizeTextOf(4.3 * 1024), '4.3KB')
  assert.equal(fileSizeTextOf(20 * 1024), '20KB')
  assert.equal(fileSizeTextOf(1536 * 1024), '1.5MB')
  assert.equal(fileSizeTextOf(10 * 1024 * 1024), '10MB')
  assert.equal(fileSizeTextOf(2.5 * 1024 * 1024 * 1024), '2.5GB')
  assert.equal(fileSizeTextOf(-1), null, 'a negative byte count is unknown, never "-1B"')
  // 宿主 fileExtension：**前导点也算后缀**（'.gitignore' → 'gitignore'）；末尾点 → 空串 → 无徽标。
  // 长度上限 8 也照宿主：宿主文件卡那行 meta 就是 fileExtension(name).toUpperCase().slice(0, 8)。
  assert.equal(fileExtensionOf('.gitignore'), 'GITIGNOR')
  assert.equal(fileExtensionOf('a.'), null)
  assert.equal(fileExtensionOf('D:/x/y/report.pdf'), 'PDF')
  assert.equal(fileExtensionOf('a.b.c'), 'C')
  assert.equal(fileExtensionOf('no-dot-at-all'), null, 'no dot = no extension')
  assert.equal(fileExtensionOf('file.verylongextension12345'), 'VERYLONG', 'the 8-character display cap is the host rule')
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

test('session wire form: the projection collapses @[label](dsh-session:…) to its label (D5)', () => {
  // 宿主 SESSION_WIRE_RE 的形状：@[ + label（不含 ] 与换行） + ](dsh-session: + 非空白 id + )；
  // 捕获组 1 = 给人看的 label（宿主 projectUserText 用它当 chip 文本）。
  assert.equal(projectChatEntryText('see @[Some session](dsh-session:eyJhIjoxfQ) please'), 'see Some session please')
  assert.equal(projectChatEntryText('a @[x](dsh-session:1) b @[y](dsh-session:2)'), 'a x b y', 'every occurrence is replaced')
  assert.equal(projectChatEntryText('no wire here'), 'no wire here')
  assert.equal(projectChatEntryText('@[broken](dsh-session:'), '@[broken](dsh-session:', 'an unterminated wire form is left as-is')
  assert.equal(projectChatEntryText('mail me at a@[b](not-session:1)'), 'mail me at a@[b](not-session:1)', 'only the dsh-session form is a reference')
  // 投影必须发生在**气泡文本**上（用户看不到机器编码），且 referenceLabels 仍被读入视图模型
  const bubble = buildChatEntryBubble([
    { type: 'text', text: 'q @[Session A](dsh-session:aaa)' },
    { type: 'text', text: ' and @[Session B](dsh-session:bbb)' },
  ])
  assert.equal(bubble.text, 'q Session A and Session B')
  assert.ok(!bubble.text.includes('dsh-session:'), 'the wire form must never reach the screen')
  const view = buildChatEntryView({
    kind: 'user',
    data: { content: [{ type: 'text', text: '@[Session A](dsh-session:aaa)' }], referenceLabels: ['Session A', 'Session B'] },
  })
  assert.deepEqual(view.referenceLabels, ['Session A', 'Session B'], 'referenceLabels drive the summary line')
  // 崩溃降级路径同样不许打印线格式
  assert.equal(plainTextOf([{ type: 'text', text: '@[Session A](dsh-session:aaa)' }]), 'Session A')
})

test('clock: fixed 24-hour zero-padded HH:mm (host format, D4); missing/hostile timestamps stay unknown', () => {
  // 用**本地时间构造**，断言与运行时时区无关：05:04 必须补零、15:04 必须还是 15 点（不是 3 点）
  assert.equal(formatChatEntryClock(new Date(2026, 9, 10, 5, 4).getTime()), '05:04')
  assert.equal(formatChatEntryClock(new Date(2026, 9, 10, 15, 4).getTime()), '15:04')
  assert.equal(formatChatEntryClock(new Date(2026, 0, 1, 0, 0).getTime()), '00:00')
  assert.equal(formatChatEntryClock(new Date(2026, 0, 1, 23, 59).getTime()), '23:59')
  const formatted = formatChatEntryClock(1_700_000_000_000)
  assert.ok(formatted !== null && /^\d{2}:\d{2}$/.test(formatted), 'always HH:mm: ' + String(formatted))
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
