/**
 * T13/F1 护栏：**两个回退入口 = 一次同源挂载**，切档后两档必须仍然互斥。
 *
 * 复现 t5 复核的缺陷形态（真模块 + 只替 ui-slots/localStorage），并钉住修复后的不变量：
 *  · 任意时刻**至多一个**入口活着（同屏永不出现两个回退按钮）；
 *  · 切档过程**不出现 0**（dispose 与 register 在同一个同步回调里完成）；
 *  · 反复切档 trace 恒为 [1,1,1,1]（旧实现是 [0,1,0,1] 与 [2,1,2,1]）；
 *  · 切档后的状态与「以该档冷启动」逐字一致（同一个 register 函数、同一份探测面）；
 *  · 顺序固定：每次切档都先把两个入口退干净，再注册当前档的那一个；
 *  · 偏好订阅只有**一次**（两个入口由同一次订阅驱动，不再是一侧订阅、另一侧装配期读一次）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { mountChatEntries } from './chat-entry-mount.ts'
import { CHAT_ENTRY_ID, CHAT_ENTRY_SLOT } from './rollback-entry-view.ts'
import { CHAT_NODE_SLOT } from './chat-entry-view.ts'
import { CHAT_ENTRY_MODE_KEY, subscribeChatEntryMode, writeChatEntryMode, type ChatEntryMode } from './chat-entry-pref.ts'

/* ------------------------------------------------------------ 夹具（真模块 + 只替边界） */

interface MemStorage {
  map: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 装一个内存 localStorage（真偏好模块会读它）。 */
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

const NODE_CELL = CHAT_NODE_SLOT + '#user'
const TAIL_CELL = CHAT_ENTRY_SLOT + '#' + CHAT_ENTRY_ID

interface Harness {
  /** 当前活着的 cell（= 同屏的回退入口集合）。 */
  live: Set<string>
  /** 事件序列（register/dispose 逐条），用于断言顺序与「永不出现两个」。 */
  events: string[]
  /** 装配（与 src/client/index.ts 的挂载同形：两个探测面 + 两个注册器）。 */
  mount: () => () => void
  /** 退掉挂载。 */
  unmount: () => void
  /** 订阅调用次数（必须恰好 1：同一次订阅驱动两个入口）。 */
  subscriptions: () => number
  /** 每次事件后的活 cell 峰值（>1 即「同屏两个回退按钮」）。 */
  peak: () => number
  /** 诊断输出（注入 warn，避免污染测试输出；同时断言跳过/失败都留痕）。 */
  warnings: string[]
}

function harness(options: { registerNodeThrows?: boolean; registerTailThrows?: boolean } = {}): Harness {
  const live = new Set<string>()
  const events: string[] = []
  const warnings: string[] = []
  let subscriptions = 0
  let peak = 0
  const declare = (cell: string, label: string): (() => void) => {
    live.add(cell)
    events.push('register:' + label)
    peak = Math.max(peak, live.size)
    return () => { live.delete(cell); events.push('dispose:' + label) }
  }
  const registerNode = (): (() => void) => {
    if (options.registerNodeThrows === true) throw new Error('node register exploded')
    return declare(NODE_CELL, 'node')
  }
  const registerTurnTail = (): (() => void) => {
    if (options.registerTailThrows === true) throw new Error('tail register exploded')
    return declare(TAIL_CELL, 'tail')
  }
  const probes = {
    nodeProbe: { spec: () => ({ kind: 'keyed', scope: 'session' }) },
    tailProbe: { spec: () => ({ kind: 'list', scope: 'session' }) },
  }
  let dispose = (): void => {}
  return {
    live,
    events,
    subscriptions: () => subscriptions,
    peak: () => peak,
    warnings,
    mount: () => {
      dispose = mountChatEntries({
        ...probes,
        registerNode,
        registerTurnTail,
        warn: (message) => { warnings.push(message) },
        // 订阅计数：真模块只订阅一次（两个入口由它驱动）
        subscribe: (listener) => {
          subscriptions += 1
          return subscribeSpy(listener)
        },
      })
      return dispose
    },
    unmount: () => { dispose() },
  }
}

/** 真订阅（用真偏好模块的通知链），只做一次计数包装。 */
function subscribeSpy(listener: (mode: ChatEntryMode) => void): () => void {
  return subscribeChatEntryMode((mode) => { listener(mode) })
}

/* ------------------------------------------------------------ ① 装配期：两档各自只注册一处 */

test('T13 装配期：per-message 只注册 chat.node；turn 只注册 turnTail（两档互斥）', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'per-message')
    const perMessage = harness()
    perMessage.mount()
    assert.deepEqual([...perMessage.live], [NODE_CELL], '每条用户消息档：只有 chat.node/user 一个入口')

    storage.map.set(CHAT_ENTRY_MODE_KEY, 'turn')
    const turn = harness()
    turn.mount()
    assert.deepEqual([...turn.live], [TAIL_CELL], '整回合档：只有 turnTail 一个入口')
  })
})

/* ------------------------------------------------------------ ② 反复切档：trace 恒 [1,1,1,1] */

test('T13 反复切档：trace 交替 [1,1,1,1]（旧实现是 [0,1,0,1] / [2,1,2,1]），且同屏永不超过 1', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'per-message')
    const h = harness()
    h.mount()
    assert.deepEqual([...h.live], [NODE_CELL], '起点 per-message')

    // trace = **每次切档之后**的活 cell 数（验收口径：交替 [1,1,1,1]）
    const trace: number[] = []
    const cells: string[][] = []
    for (const mode of ['turn', 'per-message', 'turn', 'per-message'] as ChatEntryMode[]) {
      assert.equal(writeChatEntryMode(mode), true, '偏好写入必须成功（内存 storage）')
      trace.push(h.live.size)
      cells.push([...h.live])
    }
    assert.deepEqual(trace, [1, 1, 1, 1], '切档 trace 必须是 [1,1,1,1]：不得出现 0（没有入口）或 2（同屏两个）')
    assert.deepEqual(cells, [[TAIL_CELL], [NODE_CELL], [TAIL_CELL], [NODE_CELL]], '两档必须交替，且每次只有一处')
    assert.equal(h.peak(), 1, '事件级峰值也必须 ≤1（同屏永不出现两个回退按钮）')
    assert.equal(h.subscriptions(), 1, '两个入口必须由**同一次**偏好订阅驱动')
  })
})

test('T13 切档后的状态 = 「以该档冷启动」逐字一致（同一套注册器/探测面）', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'per-message')
    const switched = harness()
    switched.mount()
    writeChatEntryMode('turn')
    const afterSwitch = [...switched.live]

    // 冷启动（全新挂载 + 同一份偏好）：活 cell 与「切档后」必须一致，且最后一次事件也是同一个 register
    const fresh = harness()
    fresh.mount()
    assert.deepEqual([...fresh.live], afterSwitch, '切到 turn 后的活 cell 必须与冷启动一致')
    assert.equal(fresh.events.filter((e) => e.startsWith('register:')).length, 1, '冷启动只注册一处')
    assert.deepEqual(switched.events.slice(-1), fresh.events.slice(-1), '切档后的最后一次注册事件必须与冷启动同形')
  })
})

/* ------------------------------------------------------------ ③ 顺序固定：先全退、再注册一个 */

test('T13 顺序固定：每次切档先把两个入口退干净，再注册当前档的那一个', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'per-message')
    const h = harness()
    h.mount()
    const before = h.events.length
    writeChatEntryMode('turn')
    const delta = h.events.slice(before)
    assert.deepEqual(delta, ['dispose:node', 'register:tail'], 'per-message → turn：先退 chat.node，再注册 turnTail')
    const before2 = h.events.length
    writeChatEntryMode('per-message')
    assert.deepEqual(h.events.slice(before2), ['dispose:tail', 'register:node'], 'turn → per-message：先退 turnTail，再注册 chat.node')
  })
})

test('T13 卸载：disposer 退订并退掉当前登记（不留活 cell）', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'turn')
    const h = harness()
    const dispose = h.mount()
    assert.deepEqual([...h.live], [TAIL_CELL])
    dispose()
    assert.deepEqual([...h.live], [], '卸载后不留活 cell')
    // 退订之后切档不得再注册（否则页面卸载后仍在写槽位）
    writeChatEntryMode('per-message')
    assert.deepEqual([...h.live], [], '卸载后切档不得复活入口')
  })
})

/* ------------------------------------------------------------ ④ 失败软化仍然成立 */

test('T13 失败软化：注册抛错只丢这一个入口，不打挂挂载；另一切档仍能注册', () => {
  withStorage((storage) => {
    storage.map.set(CHAT_ENTRY_MODE_KEY, 'per-message')
    const h = harness({ registerNodeThrows: true })
    assert.doesNotThrow(() => { h.mount() }, '注册抛错必须被吞掉（只丢这一个入口）')
    assert.deepEqual([...h.live], [], '抛错时没有活 cell')
    assert.ok(h.warnings.some((line) => line.includes('node register exploded')), '抛错必须留下诊断：' + JSON.stringify(h.warnings))
    writeChatEntryMode('turn')
    assert.deepEqual([...h.live], [TAIL_CELL], '切到另一档后照常注册')
  })
})

/* ------------------------------------------------------------ ⑤ 装配点接线（源码级） */

test('T13 装配点：两个 inject 回调都挂**同一个** mountChatEntries（不再一侧订阅、一侧装配期读一次）', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
  assert.match(src, /import \{ mountChatEntries \} from '\.\/chat\/chat-entry-mount\.ts'/, 'index.ts 必须 import 同源挂载')
  assert.match(src, /ctx\.slots\.inject\(CHAT_NODE_SLOT, \(\) => holdChatEntryMount\(\)\)/, 'chat.node 的 inject 必须走同源挂载')
  assert.match(src, /ctx\.slots\.inject\(CHAT_ENTRY_SLOT, \(\) => holdChatEntryMount\(\)\)/, 'turnTail 的 inject 也必须走同源挂载')
  assert.match(src, /mountChatEntries\(\{/, '挂载点必须真的调用 mountChatEntries')
  assert.doesNotMatch(src, /ctx\.slots\.inject\(CHAT_ENTRY_SLOT, \(\) => registerChatEntry\(/, 'turnTail 不得再走「装配期读一次偏好」的一次性注册')
  assert.doesNotMatch(src, /ctx\.slots\.inject\(CHAT_NODE_SLOT, \(\) => mountChatNodeEntry\(/, 'chat.node 不得再单独挂载（否则又变成两次订阅、两侧各自决策）')
  // 引用计数：两个 inject 只挂一次挂载（同源），不是各挂一份
  assert.match(src, /chatEntryMountRefs \+= 1/)
  assert.match(src, /if \(chatEntryMountRefs === 1\) \{/)
})

/* ------------------------------------------------------------ T17：对槽位声明顺序不敏感（有界补试 + 幂等 reapply） */

/**
 * 顺序敏感场景的夹具：声明表**可变**（模拟「另一个 inject 回调晚到」），排程器注入确定性队列，
 * 假槽位注册表**同 cell 二次注册会抛**（替身规 —— 补试/重评估一旦重复注册就会立刻炸）。
 */
function orderHarness(initialDeclared: Record<string, string>, mode: ChatEntryMode, realScheduler = false) {
  const live = new Set<string>()
  const events: string[] = []
  const pending: (() => void)[] = []
  let declared = { ...initialDeclared }
  const slots = {
    spec: (key: string) => (declared[key] === undefined ? undefined : { kind: declared[key] }),
    register: (spec: { name: string; id?: string; key?: string }) => {
      const cell = spec.name + '#' + String(spec.id ?? spec.key ?? '?')
      if (live.has(cell)) throw new Error('同 cell 二次注册（替身规）：' + cell)
      live.add(cell)
      events.push('register:' + cell)
      return () => { if (live.delete(cell)) events.push('dispose:' + cell) }
    },
  }
  const handle = mountChatEntries({
    nodeProbe: { spec: (key) => slots.spec(key) },
    tailProbe: { spec: (key) => slots.spec(key) },
    registerNode: () => slots.register({ name: CHAT_NODE_SLOT, key: 'user' }),
    registerTurnTail: () => slots.register({ name: CHAT_ENTRY_SLOT, id: CHAT_ENTRY_ID }),
    readMode: () => mode,
    subscribe: () => () => {},
    warn: () => {},
    // realScheduler=true ⇒ 不注入 defer，走**缺省排程器**（真 setTimeout），供「生产路径」用例复跑；
    // 缺省注入确定性队列，flush() 手动排空。
    ...(realScheduler ? {} : { defer: (fn: () => void) => { pending.push(fn) } }),
  })
  const flush = (): void => {
    let guard = 0
    while (pending.length > 0 && guard < 20) {
      guard += 1
      const fn = pending.shift()
      if (fn !== undefined) fn()
    }
  }
  return { handle, live, events, pending, flush, declare: (key: string, kind: string) => { declared = { ...declared, [key]: kind } } }
}

const NODE_DECL = { 'conversation.chat.node': 'keyed' }
const TAIL_DECL = { 'conversation.chat.turnTail': 'list' }

test('T17 顺序无关矩阵：两种声明顺序 × 两种档位，声明齐备后都恰好 1 入口（不得 0）', () => {
  const orders: { name: string; initial: Record<string, string>; laterKey: string; laterKind: string }[] = [
    { name: '先 chat.node 后 turnTail', initial: NODE_DECL, laterKey: 'conversation.chat.turnTail', laterKind: 'list' },
    { name: '先 turnTail 后 chat.node（评审探针 I）', initial: TAIL_DECL, laterKey: 'conversation.chat.node', laterKind: 'keyed' },
  ]
  for (const order of orders) {
    for (const mode of ['per-message', 'turn'] as ChatEntryMode[]) {
      const h = orderHarness(order.initial, mode)
      const expected = mode === 'per-message' ? NODE_CELL : TAIL_CELL
      const label = order.name + ' / ' + mode
      h.declare(order.laterKey, order.laterKind)
      h.flush()
      assert.deepEqual([...h.live], [expected], label + '：声明齐备后必须恰好 1 个入口')
      const before = [...h.events]
      h.flush()
      assert.deepEqual([...h.events], before, label + '：声明齐备后不得再有事件（零 churn）')
      h.handle()
      assert.deepEqual([...h.live], [], label + '：卸载后不留入口')
    }
  }
})

test('T17 探针 I：后到的声明被补试抓住 —— 不再需要「切一次档才恢复」', () => {
  const h = orderHarness(TAIL_DECL, 'per-message')
  assert.deepEqual([...h.live], [], '挂载时 chat.node 声明缺席 ⇒ 如实 0 处（T9-F2 失败软化不变）')
  assert.ok(h.pending.length > 0, '缺席必须排一次补试（而不是就此定终身）')
  h.declare('conversation.chat.node', 'keyed')
  h.flush()
  assert.deepEqual([...h.live], [NODE_CELL], '声明到位后补试立即注册（不需要切档）')
  h.handle()
})

test('T17 幂等：声明齐全时零补试；reapply 已一致时零 churn', () => {
  const h = orderHarness({ ...NODE_DECL, ...TAIL_DECL }, 'per-message')
  assert.deepEqual([...h.live], [NODE_CELL])
  assert.equal(h.pending.length, 0, '声明齐全 ⇒ 一次补试都不排（正常路径零 churn）')
  const before = [...h.events]
  h.handle.reapply()
  h.handle.reapply()
  assert.deepEqual([...h.events], before, '已与当前档一致 ⇒ reapply 什么都不做')
  assert.deepEqual([...h.live], [NODE_CELL])
  h.handle()
})

test('T17 reapply 给「声明刚到」一次新机会（重置补试预算）', () => {
  const h = orderHarness(TAIL_DECL, 'per-message')
  h.flush()
  assert.deepEqual([...h.live], [], '声明缺席且预算耗尽 ⇒ 仍为 0（有界，不无限重试）')
  h.declare('conversation.chat.node', 'keyed')
  h.handle.reapply()
  assert.deepEqual([...h.live], [NODE_CELL], 'reapply 必须按当前档重新评估')
  h.handle()
})

test('T17 补试有界：声明永不到位时最多 maxRetries 次（不无限循环）', () => {
  let calls = 0
  const handle = mountChatEntries({
    nodeProbe: { spec: () => undefined },
    tailProbe: { spec: () => undefined },
    registerNode: () => () => {},
    registerTurnTail: () => () => {},
    readMode: () => 'per-message',
    subscribe: () => () => {},
    warn: () => {},
    defer: (fn) => { calls += 1; if (calls < 50) fn() },
    maxRetries: 3,
  })
  assert.equal(calls, 3, '补试次数必须恰好等于 maxRetries（有界）')
  handle()
})

test('T17 替身规：补试/reapply 都不得触发同 cell 二次注册（重复注册会抛）', () => {
  const h = orderHarness(TAIL_DECL, 'per-message')
  h.declare('conversation.chat.node', 'keyed')
  h.flush()
  h.handle.reapply()
  h.flush()
  assert.deepEqual([...h.live], [NODE_CELL])
  assert.equal(h.events.filter((event) => event === 'register:' + NODE_CELL).length, 1, '同一 cell 只注册一次')
  h.handle()
})

test('T17 缺省排程器（真 setTimeout）同样能抓住后到的声明', async () => {
  const h = orderHarness(TAIL_DECL, 'per-message', true)
  assert.deepEqual([...h.live], [], '声明缺席 ⇒ 如实 0 处')
  h.declare('conversation.chat.node', 'keyed')
  await new Promise((resolve) => { setTimeout(resolve, 15) })
  assert.deepEqual([...h.live], [NODE_CELL], '缺省 setTimeout 补试必须把入口补上')
  h.handle()
  assert.deepEqual([...h.live], [], '卸载后不留入口')
})

test('T17 卸载后补试不得复活入口（disposed 守卫）', () => {
  const h = orderHarness(TAIL_DECL, 'per-message')
  h.handle()
  h.declare('conversation.chat.node', 'keyed')
  h.flush()
  assert.deepEqual([...h.live], [], '卸载后补试必须无效')
  h.handle.reapply()
  assert.deepEqual([...h.live], [], '卸载后 reapply 也必须无效')
})

