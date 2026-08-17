/**
 * m-sync-ui (P2b)：SyncPullPreviewView 的纯数据投影逻辑（无副作用、无 React 依赖）。
 * 与 sync-view.ts 同模式：纯函数 → node --test 覆盖；React 组件只做装配。
 */
import type { SyncApplyPlan } from '../../sync/risk.ts';
import type { MergeConflict } from '../../sync/merge.ts';

export interface ReviewDisplayItem {
  itemId: string;
  sectionId: string;
  description: string;
  conflicts: MergeConflict[];
  initial: 'pending' | 'useRemote' | 'keepLocal' | 'skip';
}

/** 把 SyncApplyPlan.review 拆成 UI 可显示形态（同步函数，无副作用） */
export function projectReviewItems(applyPlan: SyncApplyPlan): ReviewDisplayItem[] {
  const out: ReviewDisplayItem[] = [];
  for (const r of applyPlan.review) {
    out.push({
      itemId: `${r.id}`,
      sectionId: r.id,
      description: r.conflicts.length > 0 ? describeConflicts(r.conflicts) : `分区 ${r.id} 待审`,
      conflicts: r.conflicts,
      initial: 'pending',
    });
  }
  return out;
}

/** 简短描述 conflicts（最多 2 条；超出显示 +N） */
export function describeConflicts(conflicts: readonly MergeConflict[]): string {
  if (conflicts.length === 0) return '无变更描述';
  const sample = conflicts.slice(0, 2).map((c) => `${c.path || '$'}`).join(', ');
  return conflicts.length <= 2 ? `冲突：${sample}` : `冲突：${sample} +${conflicts.length - 2}`;
}

/** 渲染差异（local vs remote）的紧凑 JSON 视图（纯字符串） */
export function formatDiff(local: unknown, remote: unknown): string {
  const L = JSON.stringify(local, null, 0);
  const R = JSON.stringify(remote, null, 0);
  if (L === R) return '（值相同）';
  return `local: ${L}\nremote: ${R}`;
}
