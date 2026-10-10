/**
 * 两个聊天回退入口的**同源挂载**（T13 修 F1：切档后两档必须仍然互斥；T17 硬化：对槽位声明顺序不敏感）。
 *
 * ## T13 修的是什么
 *
 * T2 的「两档互斥」只在**装配期**成立：chat.node 侧由 `mountChatNodeEntry` 订阅偏好、切档即时重评估，
 * 而 turnTail 侧走的是**一次性** `registerChatEntry`（装配期读一次偏好就定终身）。于是真机（t5 复核
 * 用真模块 + 只替 ui-slots/localStorage 实测）出现：
 *  · per-message 起点切「整回合」→ 活 cell = **0**（chat.node 被 dispose，turnTail 装配期已 skip）；
 *  · turn 起点切回「每条消息」→ 活 cell = **2**（turnTail 仍在 + chat.node 新注册）。
 * 两档的互斥关系被切档打破 —— 用户会看到**没有入口**或**同屏两个回退按钮**。
 *
 * 修法：两个入口由**同一次模式订阅**驱动，切档时**先把两个入口都退掉、再按新档注册恰好一个**
 * （顺序固定：dispose → dispose → register；同 cell 同 priority 的重复注册会抛，所以必须退干净再注册）。
 * 恒成立的不变量：
 *  · 任意时刻**至多一个**入口活着（同屏永不出现两个回退按钮），且切档过程中**不会出现 0**
 *    （dispose 与 register 在同一个同步回调里完成）；
 *  · 切档后的状态与「以该档冷启动（刷新）」逐字一致 —— 两侧用的是**同一个** `registerChatNodeEntry` /
 *    `registerChatEntry`，只是由本模块决定这次该调哪一个。
 *
 * ## T17 硬化的是什么（对**槽位声明顺序**不敏感）
 *
 * 装配点（`src/client/index.ts`）用引用计数持有本挂载：**只有第一次 hold 会创建它**，后到的槽位声明
 * 只把计数 +1、不会重新 apply。于是若「当前档要用的那个槽位」声明**晚于**挂载创建
 * （评审探针 I：先给 turnTail、后给 chat.node，而偏好是 per-message），该档会停在 **0 入口**，
 * 要切一次档才恢复 —— 这是 T13 引入的时序依赖（T2 的旧接线对该顺序免疫）。
 *
 * 硬化方式（全部在本模块内，不依赖装配点再调一次）：
 *  · **有界补试**：每次 apply 之后，若当前档需要的声明还**不可用**，就按注入的排程器（缺省
 *    `setTimeout(fn, 0)`，跨任务才够）再试，最多 `maxRetries` 次；声明一到位就**立即停止**
 *    ⇒ 正常路径（声明齐全）**零补试、零 churn**，事件序列与 T13 逐字相同；
 *  · **幂等 re-apply**：返回的句柄带 `reapply()`，**已与当前档一致时什么都不做**（不 churn），
 *    否则按当前档重新评估并重置补试预算 —— 装配点将来若改成「每次 hold 都调一次 reapply」，
 *    就只是一行接线（本任务不动装配点，见任务 output 的 scope 说明）。
 * 补试/重评估都走同一条 `apply()`（先全退再注册一个），所以「同 cell 二次注册会抛」的替身规
 * 永远不会被踩到（`disposeAll()` 先退干净）。
 *
 * ## 为什么保留 `mountChatNodeEntry` / `registerChatEntry`
 *
 * 它们各自仍是「单入口 + 形态探测 + 失败软化」的正确实现（单测与设置页热切换用例都在用），
 * 本模块只做**编排**：把「这次该注册哪一个」与「什么时候重评估」收成一处，避免再出现
 * 「一侧订阅、另一侧只在装配期读」这类不对称。形态探测/偏好门/异常软化仍由它们负责
 * （0.1.x 的 chain 形态、keyed 形态不符、register 抛错都只丢这一个入口，不打挂插件）。
 */
import { type ChatNodeSlotProbe, declaredSlotKind, registerChatNodeEntry } from './chat-node-registration.ts'
import { CHAT_ENTRY_SLOT, type ChatSlotProbe, registerChatEntry } from './rollback-entry-view.ts'
import { readChatEntryMode, subscribeChatEntryMode, type ChatEntryMode } from './chat-entry-pref.ts'

/** 同源挂载的装配面：两侧的探测面 + 注册器（由 src/client/index.ts 给出，保持 register 的编译期校验）。 */
export interface ChatEntryMountOptions {
  /** `conversation.chat.node` 的声明形态探测面。 */
  nodeProbe: ChatNodeSlotProbe | undefined | null
  /** `conversation.chat.turnTail` 的声明形态探测面。 */
  tailProbe: ChatSlotProbe | undefined | null
  /** 注册「接管 chat.node 的 user key」（每条用户消息一颗 icon）。 */
  registerNode: () => () => void
  /** 注册「回合尾 list 条目」。 */
  registerTurnTail: () => () => void
  /** 偏好读取器（缺省读 localStorage；单测注入）。 */
  readMode?: () => ChatEntryMode
  /** 偏好订阅（缺省 `subscribeChatEntryMode`；单测注入）。 */
  subscribe?: (listener: (mode: ChatEntryMode) => void) => () => void
  /** 诊断回调（缺省 `console.warn`；单测注入以免污染输出）。 */
  warn?: (message: string) => void
  /** 补试排程器（缺省 `setTimeout(fn, 0)`；单测注入确定性队列）。 */
  defer?: (fn: () => void) => void
  /** 单次 apply 之后最多补试几次（缺省 4；0 = 关闭补试）。 */
  maxRetries?: number
}

/** 挂载句柄：可当 disposer 用（`src/client/index.ts` 现在就是把它当函数调），另带幂等 `reapply`。 */
export interface ChatEntryMountHandle {
  /** 退订 + 退掉当前登记（框架在声明塌缩时调用）。 */
  (): void
  /**
   * 幂等 re-apply：**已与当前档一致时什么都不做**（不 churn）；否则按当前档重新评估
   * （并重置补试预算，让「声明刚到」这类新机会被抓住）。
   */
  reapply: () => void
}

/** 缺省排程：跨任务（`setTimeout 0`）—— 另一个 inject 回调可能在后续任务里才触发。 */
function defaultDefer(fn: () => void): void {
  setTimeout(fn, 0)
}

/** turnTail 的声明形态（`declaredSlotKind` 只服务 chat.node 那个 key，这里补上 list 位）。 */
function tailDeclaredKind(probe: ChatSlotProbe | undefined | null): string | null {
  if (probe === undefined || probe === null || typeof probe.spec !== 'function') return null
  try {
    const spec = probe.spec(CHAT_ENTRY_SLOT)
    const record = typeof spec === 'object' && spec !== null ? (spec as { kind?: unknown }) : null
    return typeof record?.kind === 'string' ? record.kind : null
  } catch {
    return null
  }
}

/**
 * 挂载两个入口（**同一份偏好、同一次订阅**）：初始按当前档注册一个，之后每次偏好真变化就
 * 「全退 → 按新档注册一个」；当前档要用的声明尚未到位时**有界补试**（T17）。
 *
 * @returns 句柄：可当 disposer 调用，另带幂等 `reapply()`。
 */
export function mountChatEntries(options: ChatEntryMountOptions): ChatEntryMountHandle {
  const readMode = options.readMode ?? readChatEntryMode
  const defer = options.defer ?? defaultDefer
  const maxRetries = Math.max(0, options.maxRetries ?? 4)
  const warnOptions = options.warn === undefined ? {} : { warn: options.warn }
  let disposeNode = (): void => {}
  let disposeTail = (): void => {}
  let appliedMode: ChatEntryMode | null = null
  let appliedReady = false
  let retries = 0
  let disposed = false

  /** 退掉两个入口（顺序固定：先退干净，再注册 —— 同 cell 同 priority 重复注册会抛）。 */
  const disposeAll = (): void => {
    disposeNode()
    disposeTail()
    disposeNode = (): void => {}
    disposeTail = (): void => {}
  }

  /** 当前档需要的声明**是否已到位且形态可用**（只读探测，不注册）。 */
  const declarationUsable = (mode: ChatEntryMode): boolean => mode === 'per-message'
    ? declaredSlotKind(options.nodeProbe) === 'keyed'
    : tailDeclaredKind(options.tailProbe) === 'list'

  /** 唯一的落点：全退 → 按当前档注册恰好一个 → 记下「这一档当前是否真的注册上了」。 */
  const apply = (): void => {
    if (disposed) return
    disposeAll()
    // 档位取**一次**快照并交给两侧的偏好门（两侧读到的与本次决策一致，不存在第二处真相）
    const mode = readMode()
    if (mode === 'per-message') {
      disposeNode = registerChatNodeEntry({
        probe: options.nodeProbe,
        readMode: () => mode,
        register: options.registerNode,
        ...warnOptions,
      })
    } else {
      disposeTail = registerChatEntry({
        probe: options.tailProbe,
        readMode: () => mode,
        register: options.registerTurnTail,
        ...warnOptions,
      })
    }
    appliedMode = mode
    appliedReady = declarationUsable(mode)
    if (appliedReady) return
    // 声明还没到位（后到的槽位声明）：有界补试；到位即停 ⇒ 正常路径零补试、零 churn
    if (retries >= maxRetries) return
    retries += 1
    defer(() => { apply() })
  }

  const reapply = (): void => {
    if (disposed) return
    const mode = readMode()
    // 幂等：已与当前档一致 ⇒ 什么都不做（不 churn、不改事件序列）
    if (appliedMode === mode && appliedReady) return
    retries = 0
    apply()
  }

  apply()
  const off = (options.subscribe ?? subscribeChatEntryMode)(() => {
    retries = 0
    apply()
  })

  const handle = ((): void => {
    if (disposed) return
    disposed = true
    off()
    disposeAll()
  }) as ChatEntryMountHandle
  handle.reapply = reapply
  return handle
}
