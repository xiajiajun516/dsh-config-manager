/**
 * 恢复计划指纹 —— 预览与执行之间的**唯一**一致性判据。
 *
 * 只取「动作类型 + 目标 + blob」三列：描述文案、detail、manualHint 这些展示字段不进指纹
 * （改一句文案不该让用户已经做过的确认失效），动作的**集合**才是实质 —— 多一个
 * hostFileRemove / fileRemove，少一个还原，都说明磁盘在预览之后变了，必须重新确认。
 *
 * 为什么必须只有一处实现：GUI 恢复路由（src/routes/snapshots.ts 的 dry-run 与执行）
 * 与 agent 工具（src/core/model-tools.ts 的 config_restore）算的必须是同一个值。
 * 两处各写一份，只要有一处漏了 blobPath 或换了分隔符，「预览时算的」和「执行时验的」
 * 就不是同一个东西 —— 防呆看着在，实际要么永远不触发，要么永远误触发。
 */
import { createHash } from 'node:crypto'
import type { RestorePlan } from './restore.ts'

export function restorePlanFingerprint(plan: Pick<RestorePlan, 'actions'>): string {
  const lines = plan.actions.map((action) => [action.kind, action.target ?? '', action.blobPath ?? ''].join('\u0000'))
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
