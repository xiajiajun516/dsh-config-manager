/**
 * 中段省略（`…`）——**唯一实现点**（t6：审计 client-views F-04「中段省略 ×4、2 套算法」的收敛）。
 *
 * 收敛前的三份定义点（本次由本文件取代全部三处）：
 *  1. `src/ui/snapshots-view.ts`（t43 从 SnapshotsPanel.tsx 下沉，`max = 26`）
 *  2. `src/client/sync/history-model.ts`（`max = 26`）
 *  3. `src/client/overview/OverviewPanel.tsx`（组件内私有函数，`max` 必填，调用点传 52）
 *
 * 三份差异与取值（逐项，未悄悄选一版）：
 *  - 默认参数：第 1、2 处 `max = 26`，第 3 处无默认（调用点显式传 52）
 *    → **保留 `max = 26`**：两处带默认且既有单测断言默认 26；显式传参的调用点行为不变。
 *  - 函数体：三处逐字相同（`keep = max - 1`，头 `ceil(keep / 2)`、尾 `keep - head`），无算法分歧。
 *  - 语句风格（分号有无）：非语义差异，本文件跟随 src/ui 风格（无分号）。
 *  结论：本次是**纯搬移**，对任何调用点都是零行为变更（OverviewPanel 传 52 亦然）。
 *
 * 语义：保留头尾、中段以 `…` 替代；`max >= 3` 时结果恰为 `max` 个码元。
 * 尾部是唯一区分信息（时间戳 / id 尾段 / 扩展名），尾部截断会让两条记录看起来一模一样
 * （DESIGN.md §9 anti-pattern 5）；CSS `text-overflow: ellipsis` 只兜底容器宽度，不代替本函数。
 *
 * 与 `src/ui/selection-model.ts` 的 `tailWeightedEllipsis`（默认 44、尾部优先 40%）**不是同一算法**：
 * 本次刻意不合并——它有自己的语义与单测（UI-16），合并会变更 ContentPicker 的可见文本，
 * 属行为变更而非去重，需要另立任务（见 t6 交付说明的遗留项）。
 *
 * 已知历史行为（自三份原始实现逐字保留，未顺手改语义）：
 *  - `max <= 2` 时 `tail <= 0`，`slice(-0)` 等于整串，结果会**超过** `max`
 *    （例如 `midEllipsis('abcdef', 2) === 'a…abcdef'`）；正常调用点传 20 / 26 / 52，不触及该退化区。
 *  - 计数按 UTF-16 码元：BMP 中文安全；代理对（emoji 等）在切点可能被切开。
 *
 * 纯函数：不 import node / React / `../client/*`（tests/architecture-boundaries.test.ts 的 ui 层规则）。
 */
export function midEllipsis(s: string, max = 26): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}
