/**
 * 「每条用户消息一个回退入口」的**登记外壳**（探测 + 失败软化），与 turnTail 的
 * `registerChatEntry` 同构、同纪律：**任何跳过或异常都只丢这一个入口**，
 * 绝不影响本插件其余槽位与宿主启动。
 *
 * 为什么单独一个模块：`register` 的编译期校验依赖组件与 `ctx`（`src/client/index.ts` 装配），
 * 而「该不该注册 / 探测到什么形态」是纯逻辑 —— 抽出来才能在 node 单测里逐条断言
 * （pref 为「整回合」→ 完全不注册；形态不是 keyed → 跳过）。
 */
import { CHAT_NODE_SLOT, planChatNodeRegistration } from './chat-entry-view.ts'
import { readChatEntryMode, subscribeChatEntryMode, type ChatEntryMode } from './chat-entry-pref.ts'

/** 槽位声明形态探测面（`ctx.slots`）：只读 spec，宽类型读回 kind。 */
export interface ChatNodeSlotProbe {
  spec: (key: string) => unknown
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

/**
 * 登记「接管 conversation.chat.node / user」的渲染器。
 *
 * 三道门（顺序即优先级）：
 *  ① 偏好不是「每条消息」→ **一次都不注册**（宿主 UserMessageNodeView 原样渲染，入口退回回合尾）；
 *  ② 声明形态不是 `keyed`（0.1.x 的 ui-chat 契约不同）→ 跳过（按 keyed 参数注册会抛）；
 *  ③ 注册本身抛错 → 吞掉并告警（只丢这一个入口）。
 *
 * @returns disposer；跳过 / 失败时是 no-op。
 */
export function registerChatNodeEntry(options: {
  probe: ChatNodeSlotProbe | undefined | null
  /** 偏好读取器（缺省读 localStorage；单测注入）。 */
  readMode?: () => ChatEntryMode
  /** 真正的注册调用（组件与 inject 面由调用点给出，保持 register 的编译期校验）。 */
  register: () => () => void
  /** 诊断回调（缺省 `console.warn`；单测注入以免污染输出）。 */
  warn?: (message: string) => void
}): () => void {
  const warn = options.warn ?? warnChatNode
  const readMode = options.readMode ?? readChatEntryMode
  const mode = readMode()
  if (mode !== 'per-message') {
    warn('[config-manager] chat user node entry skipped: preference is "turn" (per-turn entry only; the host user renderer stays untouched)')
    return () => {}
  }
  const declared = declaredSlotKind(options.probe)
  if (planChatNodeRegistration(declared, mode).kind === 'skip') {
    warn('[config-manager] chat user node entry skipped: slot declaration is ' + (declared === null ? 'missing' : '"' + declared + '"') + ' (expected "keyed")')
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
 * 把登记接成「装配期一次 + 偏好变化时重新评估」的**常驻挂载**（`ctx.slots.inject` 的回调体）。
 *
 * 为什么不是直接调 `registerChatNodeEntry`：那样偏好只在装配期读一次，用户在面板上切到
 * 「整回合」后当前页面里**没有任何反应**（要刷新）。这里在每次形态变化时先退订旧的登记、
 * 再按新档位重新评估 —— 切换是**即时**的，且两种档位的行为与「刷新后」逐字一致
 * （因为走的都是同一个 `registerChatNodeEntry`）。
 *
 * 顺序纪律：`register → dispose → register` 必须在**退掉旧的之后**再登记 —— ui-slots 对
 * 同一 cell 的同一 priority 第二次注册会抛（naming the occupant）。
 *
 * @returns disposer：退订偏好订阅 + 退掉当前登记（框架在声明塌缩时调用）。
 */
export function mountChatNodeEntry(options: {
  probe: ChatNodeSlotProbe | undefined | null
  register: () => () => void
  readMode?: () => ChatEntryMode
  subscribe?: (listener: (mode: ChatEntryMode) => void) => () => void
  warn?: (message: string) => void
}): () => void {
  let dispose = (): void => {}
  const apply = (): void => {
    dispose()
    dispose = registerChatNodeEntry({
      probe: options.probe,
      register: options.register,
      ...(options.readMode === undefined ? {} : { readMode: options.readMode }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    })
  }
  apply()
  const off = (options.subscribe ?? subscribeChatEntryMode)(() => { apply() })
  return () => {
    off()
    dispose()
  }
}
