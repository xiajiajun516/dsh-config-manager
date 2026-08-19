/**
 * 导入向导的 UI 流程阶段（覆盖在 wizard.step === 'preview' 之上）与导航。
 *
 * 注意：hasConflicts / hasPathIssues / hasSecrets 来自 Dry Run 的原始
 * analysis/plan，流程中不会因用户已解决而重算——因此导航必须是「只前进」
 * （按适用阶段有序列表推进），绝不能靠“当前阶段 != X 且 hasX”判定：
 * 那会让已经过的阶段被重新命中，点「下一步」反而跳回上一步。
 *
 * 没有独立的 decrypt 阶段：加密备份的解密密码只在「解锁加密备份」
 * （decrypt-archive）时输入一次（导出时容器密码与内部 secrets.enc 密码同源），
 * Host 解锁请求顺带返回凭据覆盖清单，不再要求第二次密码校验。
 */

/** 中间流程阶段（wizard.step 之外的 UI 层页面） */
export type FlowPhase = 'preview' | 'decrypt-archive' | 'conflicts' | 'path-mapping' | 'secrets' | 'confirm'

/**
 * 计算下一阶段：在 `list`（适用阶段的有序列表）中取 `from` 的下一项。
 * - `from` 不在列表中（如来自 preview 页）→ 取第一项；
 * - `from` 已是最后一项（confirm）→ 原地返回；
 * - 绝不回退：已完成阶段不会因仍适用而被再次命中。
 */
export function nextFlowPhase(list: FlowPhase[], from: FlowPhase): FlowPhase {
  if (list.length === 0) return 'confirm'
  const idx = list.indexOf(from)
  const next = list[Math.min(idx + 1, list.length - 1)]
  return next ?? 'confirm'
}
