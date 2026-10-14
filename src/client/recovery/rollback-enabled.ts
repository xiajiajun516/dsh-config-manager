/**
 * 聊天内「↺ 回退」入口的**可见性信号**（issue #88）。
 *
 * 为什么需要这个模块：入口注册（`conversation.chat.node` 的 user key 遮蔽）必须在挂载时就发生，
 * 但「功能开着没有」要到拿到宿主状态才知道；而开关可以在不重载插件的前提下改变。
 * 所以注册本身就是无常的，可见性由这个**进程内信号**驱动：读一次状态 → 写进信号 → 组件订阅重渲染。
 *
 * 约定：
 *  · **缺省 = 关闭**（`false`）：与宿主侧「缺省不启用」同一条口径，绝不因为「还没读到」就把入口画出来；
 *  · 读失败**不改信号**（保持上一次已知值）：一次网络抖动不该让入口闪没；
 *  · 只存一个布尔，不落 storage（不涉及敏感值，也没有跨会话保留的必要）。
 */

let enabled = false
const listeners = new Set<() => void>()

export function isRollbackEntryEnabled(): boolean {
  return enabled
}

/** 设置可见性并通知订阅者；值未变时不通知（避免无意义的重渲染）。 */
export function setRollbackEntryEnabled(value: boolean): void {
  const next = value === true
  if (next === enabled) return
  enabled = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* 单个订阅者自己的问题不影响信号 */
    }
  }
}

/** 订阅可见性变化（React 组件用；返回解绑函数）。 */
export function subscribeRollbackEntryEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
