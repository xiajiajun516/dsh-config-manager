/**
 * 运行中心（Run Center）的时序纯逻辑：轮询序号守卫 + 「待决策」弹框的忽略记忆。
 *
 * 为什么单独一层：这两件事都是**时序判定**（谁的数据能落地、哪个框该弹），出错时表现为
 * 「进度无故回退」「决策框关不掉」——都必须可单测，React 壳只装配（与 ui/runs-view.ts 同一分层理由）。
 *
 * 两条判据（读码得出，不是偏好）：
 *  1. **旧响应不得覆盖新数据**：/runs 与 /recovery/status 是两次独立请求，1.5s 轮询在慢响应时
 *     必然重叠；没有序号守卫时，先发的旧响应后落地会把进度条/状态改回旧值。
 *  2. **「忽略」只对同一个等待事件生效**：用户关掉决策框后，1.5s 后轮询回来的同一条 waiting run
 *     又满足弹框条件。按对象引用或 updatedAt 记「已忽略」必然失效（每轮都是新对象、新时间戳），
 *     框就会自己弹回来 —— 所以 key 只能由「run 身份 + 它等的那个决定」构成。
 */
import type { RunState } from '../../core/run-registry.ts'

/** 一次「等待用户决定」事件的稳定身份：同一 run 的同一等待状态跨轮询不变，忽略按它生效。 */
export type DialogKey = string

/**
 * 一条 run 的等待事件键。
 *
 * 只取 runId 与 pendingDecision：`updatedAt` 每轮都可能变（任何进度更新都会重写它），
 * 用时间戳当 key 等于「每轮都是新事件」，用户永远关不掉弹框；`cancelRequestedAt` 虽然
 * 幂等（宿主保留首个时刻），但一个 run 只会进入一次 cancel 等待，带上它不增加区分度。
 */
export function dialogKeyOf(run: RunState): DialogKey {
  return `${run.runId}:${run.pendingDecision ?? 'none'}`
}

/**
 * 框里那条 run 是否仍在等决定。
 *
 * 用途是**关掉过时的提问**：宿主对「等决定」有 5 分钟超时（超时按默认策略自动裁决），
 * 期间界面若一直把框开着，它问的就是一个已经被回答的问题；更糟的是 dialogRun !== null
 * 会让自动弹框 effect 永久早退 —— 后面任何 run 的等待都不会再弹出来。
 * runs === null（快照还没落地）时返回 true：那一刻没有「已结案」的证据，关掉等于把问题藏起来。
 */
export function isDialogStillWaiting(dialogRun: RunState, runs: readonly RunState[] | null): boolean {
  if (runs === null) return true
  return runs.some((run) => run.runId === dialogRun.runId && isAwaitingCancelDecision(run))
}

/** 正在等「回滚 / 保留」决定的 run（沿用组件里原自动弹框的筛选语义，一字不改地搬进纯函数）。 */
function isAwaitingCancelDecision(run: RunState): boolean {
  return run.status === 'running' && run.pendingDecision === 'cancel'
}

/**
 * 序号守卫：incomingSeq ≤ 已落地序号 ⇒ 这条响应已过时，调用方整份丢弃（连 setError 都不覆盖）。
 *
 * 为什么是「≤」而不是「<」：同一次 refresh 的两个通道（runs / lock）各记一个已落地序号，
 * 同序号再次落地说明这个通道已经写过，重复写只会把更新的值压回去（比如把 lockError 重新抹成旧值）。
 */
export function isStaleResponse(appliedSeq: number, incomingSeq: number): boolean {
  return incomingSeq <= appliedSeq
}

/**
 * 自动弹框该弹哪一条：第一条「在等决定」且未被忽略的 run；null = 不该弹。
 * 顺序确定（数组首条；宿主按 updatedAt 倒序给，= 最近更新的那条），不依赖 Set 迭代顺序。
 */
export function pickWaitingRun(
  runs: readonly RunState[] | null,
  dismissed: ReadonlySet<DialogKey>,
): RunState | null {
  if (runs === null) return null
  for (const run of runs) {
    if (!isAwaitingCancelDecision(run)) continue
    if (dismissed.has(dialogKeyOf(run))) continue
    return run
  }
  return null
}

/**
 * 裁掉「已经不在等待」的键：忽略集合必须随等待事件结束释放，否则一次会话里出现过的每条 run
 * 都会留一个键（无界增长 —— 这是资源有界性要求，不是审美）。
 *
 * runs === null（首次加载还没落地）时**原样保留**：那一刻没有「谁还在等」的信息，
 * 拿空集裁剪等于把用户刚关掉的框在一次瞬时失败后又放回来。
 */
export function pruneDismissed(
  dismissed: ReadonlySet<DialogKey>,
  runs: readonly RunState[] | null,
): Set<DialogKey> {
  if (runs === null) return new Set(dismissed)
  const waiting = new Set<DialogKey>()
  for (const run of runs) {
    if (isAwaitingCancelDecision(run)) waiting.add(dialogKeyOf(run))
  }
  const kept = new Set<DialogKey>()
  for (const key of dismissed) {
    if (waiting.has(key)) kept.add(key)
  }
  return kept
}
