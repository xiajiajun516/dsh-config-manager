/**
 * 导入/同步后的「收尾清单」（P0-① / P2-⑪）—— 框架无关纯函数层（node 可测）。
 *
 * 背景：导入完成页（result step）目前只有一行「插件 / MCP 变更将在重启 DSH 后生效」，
 * 用户看不到「具体哪些项要重启」「要补哪些凭据」「哪些项失败/可重试」。本模块把
 * 这些散落在 plan / result 里的信息聚合成一张清单式的「下一步」模型：
 *
 *  ① restartItems  —— 需要重启 DSH 才生效的项（Install 插件 + mcp 变更，与 analyzer
 *                     的 needsRestart 判定同一事实源：plan.needsRestart 由这两类得出）；
 *  ② missingSecrets —— 仍需手动补录的凭据 ref；
 *  ③ unresolved     —— 执行失败 / 用户跳过的项（结果页「重试」按钮的对象）。
 *
 * 用于导入结果页（ImportWizardView result step）与（可选）同步 apply 完成后的提示。
 * 组件只装配渲染；本层不产出文案（文案走 locale 字典 t()），不 import 任何 node 模块。
 *
 * 安全：只读过滤 plan/result；绝不携带任何凭据值（missingSecrets 仅为 ref 名）。
 */
import type { SectionId } from '../schema/types.ts';
import type { ImportPlan, ImportResult } from '../core/types.ts';

/** 收尾清单（导入完成页的「下一步」模型）。 */
export interface ImportNextSteps {
  /** 需要重启 DSH 生效的项（Install 插件 / mcp 变更；description 非敏感计划摘要） */
  restartItems: { id: string; adapter: SectionId; description: string }[];
  /** 仍需手动补录的凭据 ref 名（非值） */
  missingSecrets: string[];
  /** 执行失败 / 用户跳过的项（可重试；含状态与失败原因摘要） */
  unresolved: { id: string; status: 'failed' | 'skipped'; message?: string }[];
  /** 是否有任何需要收尾的动作（无 → UI 可显示「全部完成」） */
  hasNextSteps: boolean;
}

/** 与 analyzer.createImportPlan 的 needsRestart 判定同一事实源（避免两处规则漂移）。
 *  plan.needsRestart 由「存在 Install 项 或 mcp 非 skip/warning 变更」推出；这里
 *  把实际需要重启的**项**列出来，供 UI 逐项展示（而不只是布尔）。 */
export function restartRequiredItems(plan: ImportPlan): { id: string; adapter: SectionId; description: string }[] {
  return plan.items
    .filter((i) => i.kind === 'Install' || (i.adapter === 'mcp' && i.kind !== 'Skip' && i.kind !== 'Warning'))
    .map((i) => ({ id: i.id, adapter: i.adapter, description: i.description }));
}

/** 失败 / 用户跳过的项（结果页「重试失败/跳过的子集」的对象；引擎跳过 Skip 不算）。
 *  skippedByUser=true 或 status='failed' 才进 unresolved —— 与 ImportWizard.retryableCount
 *  的语义一致（failed || skippedByUser），避免 UI 与控制器口径漂移。 */
export function unresolvedItems(result: ImportResult): { id: string; status: 'failed' | 'skipped'; message?: string }[] {
  return result.executed
    .filter((e) => e.status === 'failed' || e.skippedByUser === true)
    .map((e) => ({ id: e.itemId, status: e.status === 'failed' ? 'failed' as const : 'skipped' as const, message: e.message }));
}

/** 聚合收尾清单：plan（待重启项）+ result（补录凭据 / 失败跳过项）。 */
export function importNextSteps(plan: ImportPlan, result: ImportResult): ImportNextSteps {
  const restartItems = restartRequiredItems(plan);
  const missingSecrets = [...result.missingSecrets];
  const unresolved = unresolvedItems(result);
  return {
    restartItems,
    missingSecrets,
    unresolved,
    hasNextSteps: restartItems.length > 0 || missingSecrets.length > 0 || unresolved.length > 0,
  };
}