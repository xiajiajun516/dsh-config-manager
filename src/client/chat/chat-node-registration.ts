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
 */
import { CHAT_NODE_SLOT, planChatNodeRegistration } from './chat-entry-view.ts'

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
 * 两道门（顺序即优先级）：
 *  ① 声明形态不是 `keyed`（0.1.x 的 ui-chat 契约不同）→ 跳过（按 keyed 参数注册会抛）；
 *  ② 注册本身抛错 → 吞掉并告警（只丢这一个入口）。
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
  if (planChatNodeRegistration(declared).kind === 'skip') {
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
