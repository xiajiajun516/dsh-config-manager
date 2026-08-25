/**
 * 备份内容查看 / 差异对比 —— 框架无关纯函数层（P1-⑦ / P2-⑬，node 可测）。
 *
 * 输入：analyzeImport 产物（ImportAnalysis）+ createImportPlan 产物（ImportPlan，
 * 零写入 merge 策略）→ 输出只读展示模型：
 *  - 分区清单（含徽章计数：插件安装/一致/路径/密钥）；
 *  - 差异摘要（将变更 / 已一致 / 冲突 / 需补录密钥 / 路径映射 / 需要重启）；
 *  - 「与此备份 diff」的逐项列表（kind + description，非敏感）。
 *
 * 安全：简洁内容全部来自 analyzer/plan 的 description（引擎已脱敏）；
 * 不携带任何凭据值（missingSecrets 仅 ref 名）。组件只做装配；本层不产出文案。
 */
import type { ImportAnalysis, ImportPlan, PlanItem } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';

/** 分区级摘要（列表行）。 */
export interface BackupInspectSection {
  section: SectionId;
  /** 分区内条目计数（estimatedActions；0 = 无） */
  count: number;
}

/** 差异摘要（“导这个备份会动你什么”）。 */
export interface BackupInspectSummary {
  willChange: number;
  unchanged: number;
  conflicts: number;
  secretsNeeded: number;
  pathMappingsNeeded: number;
  needsRestart: boolean;
  changes: PlanItem[];
}

/** 从分析 + 计划构建分区清单（sectionsInZip ↔ estimatedActions 对齐）。 */
export function inspectSections(analysis: ImportAnalysis, plan: ImportPlan): BackupInspectSection[] {
  return analysis.sectionsInZip.map((section) => ({ section, count: plan.estimatedActions[section] ?? 0 }));
}

/** 从计划构建差异摘要（与导入预览统计口径一致）。 */
export function inspectSummary(analysis: ImportAnalysis, plan: ImportPlan): BackupInspectSummary {
  const items = plan.items;
  const kind = (kinds: PlanItem['kind'][]): number => items.filter((i) => kinds.includes(i.kind)).length;
  return {
    willChange: kind(['Create', 'Update', 'Install', 'Conflict']),
    unchanged: kind(['Skip']),
    conflicts: kind(['Conflict']),
    secretsNeeded: plan.missingSecrets.length,
    pathMappingsNeeded: analysis.pathIssues.length,
    needsRestart: plan.needsRestart,
    changes: [...items],
  };
}

/* ---------------- 变更明细分组（P2-⑬ 优化：冲突/变更/路径映射优先 + 颜色区分） ---------------- */

/** 变更明细分组键（渲染顺序 = 冲突 → 变更 → 路径映射 → 一致跳过 → 其他）。 */
export type InspectGroupKey = 'conflicts' | 'changes' | 'paths' | 'skipped' | 'others';

/** 单分组：key（语义）+ kind（Badge/kindTag 颜色语义）+ 组内条目。 */
export interface InspectChangeGroup {
  key: InspectGroupKey;
  /** 颜色语义：error=冲突 / info=变更 / warn=路径映射与其它 / ok=一致跳过 */
  kind: 'error' | 'info' | 'warn' | 'ok';
  items: PlanItem[];
}

/** 判断 PlanItem 是否属于「变更」组（Create/Update/Install —— 将实际写入的项）。 */
function isChangeKind(kind: PlanItem['kind']): boolean {
  return kind === 'Create' || kind === 'Update' || kind === 'Install';
}

/**
 * 把逐项变更列表按用户视角分组并排序（纯函数，接受任意 PlanItem 数组——
 * 备份 diff、配置档案切换预览共用同一分组语义）：
 * 冲突（需决策，error）→ 变更（将写入，info）→ 路径映射（需处理，warn）
 * → 一致跳过（无需处理，ok）→ 其余（MissingSecret/MissingDependency/
 * Warning/Error 等，warn）。空组不返回；非冲突类条目全部保留（不丢信息）。
 */
export function groupPlanItems(items: readonly PlanItem[]): InspectChangeGroup[] {
  const by = (pred: (i: PlanItem) => boolean): PlanItem[] => items.filter(pred);
  const groups: InspectChangeGroup[] = [];
  const conflicts = by((i) => i.kind === 'Conflict');
  if (conflicts.length > 0) groups.push({ key: 'conflicts', kind: 'error', items: conflicts });
  const changes = by((i) => isChangeKind(i.kind));
  if (changes.length > 0) groups.push({ key: 'changes', kind: 'info', items: changes });
  const paths = by((i) => i.kind === 'PathMapping');
  if (paths.length > 0) groups.push({ key: 'paths', kind: 'warn', items: paths });
  const skipped = by((i) => i.kind === 'Skip');
  if (skipped.length > 0) groups.push({ key: 'skipped', kind: 'ok', items: skipped });
  const others = items.filter((i) => (
    i.kind !== 'Conflict' && !isChangeKind(i.kind) && i.kind !== 'PathMapping' && i.kind !== 'Skip'
  ));
  if (others.length > 0) groups.push({ key: 'others', kind: 'warn', items: others });
  return groups;
}

/** 备份 diff 分组入口：从差异摘要取 changes 数组分组（与配置档案预览共用语义）。 */
export function inspectGroupedChanges(summary: BackupInspectSummary): InspectChangeGroup[] {
  return groupPlanItems(summary.changes);
}