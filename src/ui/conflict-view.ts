/**
 * 冲突决策收集（规范 §11，m6-ui）。
 *
 * 输入：ImportPlan.items 中的 Conflict 项（目标存在且不同）。
 * 输出：逐项决策 Keep Current / Use Imported / Review，转为 core ImportDecisions.resolutions。
 *
 * 纯逻辑：只收集用户选择，不触碰 core；未决（review/未选）项在预览时如实展示。
 */
import type { ImportPlan, ItemResolution, PlanItem } from '../core/types.ts';
import type { ConflictViewItem } from './types.ts';

export class ConflictCollector {
  private readonly plan: ImportPlan;
  private readonly decisions = new Map<string, ItemResolution>();

  constructor(plan: ImportPlan) {
    this.plan = plan;
  }

  /** 需要用户决策的冲突项（kind === 'Conflict'） */
  get conflicts(): PlanItem[] {
    return this.plan.items.filter((i) => i.kind === 'Conflict');
  }

  /** 设置某项决策；未出现在冲突列表中的 id 忽略并返回 false */
  resolve(itemId: string, resolution: ItemResolution): boolean {
    if (!this.conflicts.some((i) => i.id === itemId)) return false;
    this.decisions.set(itemId, resolution);
    return true;
  }

  /** 单项当前决策（未决策返回 null） */
  decisionOf(itemId: string): ItemResolution | null {
    return this.decisions.get(itemId) ?? null;
  }

  /** 仍未解决（review 或未决策）的冲突项 */
  unresolved(): PlanItem[] {
    return this.conflicts.filter((i) => {
      const d = this.decisions.get(i.id);
      return d === undefined || d === 'review';
    });
  }

  get hasUnresolved(): boolean {
    return this.unresolved().length > 0;
  }

  /** 转 core 决策表（供 createImportPlan / executeImportPlan 使用） */
  toResolutions(): Record<string, ItemResolution> {
    const out: Record<string, ItemResolution> = {};
    for (const [id, res] of this.decisions) out[id] = res;
    return out;
  }

  /** 构造视图项列表（React 绑定用）：含当前/导入摘要占位 */
  viewItems(): ConflictViewItem[] {
    return this.conflicts.map((item) => ({
      item,
      currentSummary: item.detail?.split('\n')[0],
      importedSummary: undefined,
      resolution: this.decisionOf(item.id),
    }));
  }
}
