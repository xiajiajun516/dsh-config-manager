/**
 * 回合自动留点（回滚点）的**进程内开关**。
 *
 * 为什么需要它（issue #88 / #89）：
 *  · #88：回滚点与插件主旨（配置备份 / 同步）无关，却随 bundle 默认启用、没有任何关闭入口；
 *  · #89：默认启用时，每个 `turn/start` 都要留点，而台账写入是「整份读改写」——
 *    真机 `index.json` 涨到 451 MiB 后宿主反复 V8 heap OOM（exit 134）。
 *
 * 设计（三条，别简化）：
 *  1. **缺省关闭**：`readRollbackEnabledSync()` 读不到 / 形状不符一律 false —— fail-closed，
 *     绝不因为「文件没写成功」就把功能打开。
 *  2. **不订阅 = 真的不订阅**：宿主订阅 `session/event` 的那条链由这里驱动 attach / detach。
 *     关闭时**必须解绑**，而不是「订阅了但回调里 return」（后者仍然吃事件分发路径）。
 *  3. **活切换**：开关可以在不重载插件的前提下改变 —— 写偏好的一方调 `setRollbackEnabled`，
 *     订阅方通过 `onRollbackEnabledChange` 收到通知。事件回调**不读文件**（每回合读一次磁盘
 *     正是本 issue 要消灭的开销形态）。
 */

let enabled = false

type RollbackEnabledListener = (enabled: boolean) => void
const listeners = new Set<RollbackEnabledListener>()

/** 当前是否启用（同步、零 I/O —— 事件回调用它做第一道门）。 */
export function isRollbackEnabled(): boolean {
  return enabled
}

/**
 * 设置开关并通知订阅方。值未变化时**不通知**（避免每次保存偏好都触发一次 attach/detach 抖动）。
 * 监听器里的异常一律吞掉：一个监听器写坏了不能影响开关本身，更不能影响宿主启动。
 */
export function setRollbackEnabled(value: boolean): void {
  const next = value === true
  if (next === enabled) return
  enabled = next
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch {
      /* 监听器自己的问题；开关状态已生效 */
    }
  }
}

/** 注册开关变化监听；返回解绑函数（解绑幂等）。 */
export function onRollbackEnabledChange(listener: RollbackEnabledListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 测试专用：把开关与监听器一并复位。
 * 生产路径**绝不**调用它 —— 重置监听器会让宿主那条订阅链永远收不到后续切换。
 */
export function resetRollbackGateForTest(): void {
  enabled = false
  listeners.clear()
}
