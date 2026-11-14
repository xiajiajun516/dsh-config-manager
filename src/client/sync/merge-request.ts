/**
 * 首页「待裁决」活动行 → 同步页裁决视图的一次性信号。
 *
 * 为什么不做进 run-store：它跨越的是「首页 → 同步页」这一个动作，不是需要渲染或落盘的 UI 状态。
 * 放进 store 就得同时处理持久化白名单、旧存档迁移与刷新重放 —— 而一个过期的请求会在用户
 * 根本没点的情况下自己弹出合并裁决弹窗。模块级一个数字足够：写入一次、取走即清空。
 */
let pending = 0

/** 记下一次「去打开裁决」的请求（重复点击以最后一次为准）。 */
export function requestMergeDecision(): void {
  pending = Date.now()
}

/** 取走待处理请求：返回毫秒戳（> 0）表示确有请求，取走后不再重放；0 = 没有请求。 */
export function consumeMergeDecision(): number {
  const request = pending
  pending = 0
  return request
}
