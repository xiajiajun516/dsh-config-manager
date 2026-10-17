/**
 * 「每条用户消息一个回退入口」的**登记外壳**（探测 + 失败软化）。
 *
 * 为什么单独一个模块：`register` 的编译期校验依赖组件与 `ctx`（`src/client/index.ts` 装配），
 * 而「该不该注册 / 探测到什么形态」是纯逻辑 —— 抽出来才能在 node 单测里逐条断言
 * （形态不是 keyed → 跳过；register 抛错 → 只丢这一个入口）。
 *
 * 2026-10-12（用户要求「聊天内回退入口只有每条用户消息」）：旧的「整回合」档连同它的偏好模块
 * （`chat-entry-pref` / `chat-entry-mount`）与回合尾入口（`conversation.chat.turnTail`）一并删除 ——
 * 入口恒为每条用户消息气泡里的那一颗，于是这里不再有偏好门，也不再需要「切档时重新评估」的订阅。
 *
 * 2026-10-17（用户要求）：开关**关闭时不得再接管用户消息气泡**。原实现是「登记常驻、只收起按钮」——
 * 功能关掉之后那条气泡仍由我们代画（即使正文已委托宿主 factory，外层壳与动作行仍是我们的）。
 * 现在登记本身随开关出现 / 撤销（`registerChatNodeEntryWhenEnabled`）：关掉即让出 user cell，
 * 宿主 `UserMessageNodeView` 原样接管回来。
 */
import {
  CHAT_NODE_SLOT,
  CHAT_NODE_YIELD_WARN_PREFIX,
  chatNodeUserOccupant,
  planChatNodeRegistration,
  type ChatNodeOccupant,
} from './chat-entry-view.ts'

/** 槽位探测面（`ctx.slots`）：读声明的 kind，以及该 cell 当前会被渲染的那一条。 */
export interface ChatNodeSlotProbe {
  /** 只读 spec（宽类型读回 kind）。 */
  spec: (key: string) => unknown
  /**
   * 每个 cell 当前会被渲染的那一条（SlotRegistry.entriesOfSlot）。
   * **可选**：老宿主没有这个方法（那时不做占用探测，照常注册）。
   */
  entriesOfSlot?: (key: string) => unknown
}

/** 诊断（ASCII，与界面文案无关；console.* 实参不触发 i18n 守卫）。 */
function warnChatNode(message: string): void {
  console.warn(message)
}

/** 探测到的声明形态（读不到回 null）。 */
export function declaredSlotKind(probe: ChatNodeSlotProbe | undefined | null): string | null {
  if (probe === undefined || probe === null || typeof probe.spec !== 'function') return null
  try {
    const spec = probe.spec(CHAT_NODE_SLOT)
    const record = typeof spec === 'object' && spec !== null ? (spec as { kind?: unknown }) : null
    return typeof record?.kind === 'string' ? record.kind : null
  } catch {
    return null
  }
}

/** user cell 的当前赢家（没有探测面 / 形状不符 / 探测抛错都回 null —— 探测失败不当成「有人占」）。 */
export function chatNodeOccupantOf(probe: ChatNodeSlotProbe | undefined | null): ChatNodeOccupant | null {
  if (probe === undefined || probe === null || typeof probe.entriesOfSlot !== 'function') return null
  try {
    return chatNodeUserOccupant(probe.entriesOfSlot(CHAT_NODE_SLOT))
  } catch {
    return null
  }
}

/**
 * 登记「接管 conversation.chat.node / user」的渲染器。
 *
 * 三道门（顺序即优先级）：
 *  ① 声明形态不是 `keyed`（0.1.x 的 ui-chat 契约不同）→ 跳过（按 keyed 参数注册会抛）；
 *  ② **user cell 已被更低优先级占住**（别的插件也在接管用户消息，2026-10-15）→ 让位并如实告警：
 *     注册也永远轮不到渲染（keyed cell「最低的渲染」），不抢别人的格子、也不静默；
 *  ③ 注册本身抛错 → 吞掉并告警（只丢这一个入口）。
 *
 * @returns disposer；跳过 / 失败时是 no-op。
 */
export function registerChatNodeEntry(options: {
  probe: ChatNodeSlotProbe | undefined | null
  /** 真正的注册调用（组件与 inject 面由调用点给出，保持 register 的编译期校验）。 */
  register: () => () => void
  /** 诊断回调（缺省 `console.warn`；单测注入以免污染输出）。 */
  warn?: (message: string) => void
}): () => void {
  const warn = options.warn ?? warnChatNode
  const declared = declaredSlotKind(options.probe)
  const plan = planChatNodeRegistration(declared, chatNodeOccupantOf(options.probe))
  if (plan.kind === 'skip') {
    if (plan.reason === 'shadowed') {
      warn(
        CHAT_NODE_YIELD_WARN_PREFIX +
          'priority ' + String(plan.occupant.priority) +
          (plan.occupant.registrant === null ? '' : ' (registered by ' + plan.occupant.registrant + ')') +
          ' — entry not registered',
      )
    } else {
      warn('[config-manager] chat user node entry skipped: slot declaration is ' + (declared === null ? 'missing' : '"' + declared + '"') + ' (expected "keyed")')
    }
    return () => {}
  }
  try {
    return options.register()
  } catch (error) {
    warn('[config-manager] chat user node entry registration failed: ' + (error instanceof Error ? error.message : String(error)))
    return () => {}
  }
}

/**
 * 开关驱动的登记闸门：**只在功能开启时才接管 user cell**。
 *
 * 为什么不是「常驻登记 + 组件里隐藏按钮」：接管 = priority -1 遮蔽宿主 `UserMessageNodeView`，
 * 只要登记还在，那条气泡（含外层壳与动作行）就由我们画 —— 用户 2026-10-17 明确要求关闭后
 * **完全不要接管**，气泡交回宿主原生渲染。反过来，开关打开时**必须**有登记，否则入口无处可放
 * （该 key 没有 children 表，见 `chat-slots.ts`）。
 *
 * 纯逻辑（开关读写与订阅都从外面注进来），便于在 node:test 下逐条断言：
 *  · 关闭 → 一次注册都不发生；
 *  · 开关转开 → 登记一次（重复通知幂等）；
 *  · 开关转关 → **立刻撤销登记**（cell 回到宿主 priority 0）；
 *  · 装配卸载 → 解绑订阅 + 撤销登记，不留悬挂注册。
 *
 * @returns 卸载函数（调用点 = `ctx.slots.inject` 的回调返回值）。
 */
export interface ChatNodeEntryGateOptions {
  /** 槽位探测面（同 {@link registerChatNodeEntry}；探测只在真正注册那一次发生）。 */
  probe: ChatNodeSlotProbe | undefined | null
  /** 真正的注册调用（调用点包 `ctx.slots.register`，保持编译期校验）。 */
  register: () => () => void
  /** 功能此刻是否开启（`rollbackEnabled` 的进程内信号）。 */
  isEnabled: () => boolean
  /** 订阅开关变化（返回解绑函数）。 */
  subscribe: (listener: () => void) => () => void
  /** 诊断回调（缺省 `console.warn`；单测注入以免污染输出）。 */
  warn?: (message: string) => void
}

export function registerChatNodeEntryWhenEnabled(options: ChatNodeEntryGateOptions): () => void {
  /** 当前登记的解绑函数；null = 现在没有登记（= 宿主渲染器在渲染那条 cell）。 */
  let disposeEntry: (() => void) | null = null

  const sync = (): void => {
    if (options.isEnabled() === true) {
      if (disposeEntry === null) {
        disposeEntry = registerChatNodeEntry({
          probe: options.probe,
          register: options.register,
          ...(options.warn === undefined ? {} : { warn: options.warn }),
        })
      }
      return
    }
    if (disposeEntry !== null) {
      const dispose = disposeEntry
      disposeEntry = null
      dispose()
    }
  }

  const unsubscribe = options.subscribe(sync)
  // 订阅**先建后读**：读到与订阅之间没有窗口，开关恰在此刻翻转也不会漏（多跑一次 sync 是幂等的）。
  sync()

  return () => {
    unsubscribe()
    if (disposeEntry !== null) {
      const dispose = disposeEntry
      disposeEntry = null
      dispose()
    }
  }
}

