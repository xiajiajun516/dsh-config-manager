/**
 * 拉取预览页（M5，P2b）：消费 SyncApplyPlan，渲染
 *  - 自动已应用列表（autoApplied）—— 绿色状态徽章 + sectionId/description；
 *  - 待审变更列表（review）—— 每项三个按钮（用本地 / 用远端 / 跳过）+ 局部差异 diff；
 *  - 整体 rollback 后「回滚到应用前」按钮（调用 restoreId）；
 *  - 全部 review 解决 → 触发 onAllResolved 回调（sync 完成）。
 *
 * 设计：与 SyncSettingsView 同模式 —— 全部渲染模型来自 ./sync-view.ts 纯函数，
 * 组件只做装配 + 状态；测试在 node --test 跑纯函数部分。
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { SyncApplyPlan } from '../../sync/risk.ts'
import type { MergeConflict, MergeSectionResult } from '../../sync/merge.ts'
import { Badge, Button, Card, SectionTitle } from '../common/ui.tsx'
import { resolveItem } from '../../sync/review-queue.ts'
import type { ReviewQueueItem } from '../../sync/review-queue.ts'
import { projectReviewItems, describeConflicts, formatDiff } from './pull-preview-model.ts'
import type { ReviewDisplayItem } from './pull-preview-model.ts'

// 纯数据投影逻辑放在 ./pull-preview-model.ts（node --test 可测）；本文件仅装配。

export interface SyncPullPreviewViewProps {
  /** SyncApplyPlan（autoApply + review + skipped） */
  applyPlan: SyncApplyPlan
  /** stateDir（用于 resolveItem 写回 sync-review-queue.json） */
  stateDir: string
  /** 失败 ApplyReport（提供 restoreId） */
  restoreId?: string
  /** 已应用的 sectionId 列表（applyMergePlan.ok=true 时显示成功绿条） */
  appliedIds?: readonly string[]
  /** 来自 Importer 的 warning 列表（applyMergePlan.warnings） */
  warnings?: readonly string[]
  /** 全部 review 项解决后回调（让上层触发 sync 完成） */
  onAllResolved?: () => void
  /** 调用 rollback.ts 恢复 backup 的 handler（UI 一键回滚入口） */
  onRollback?: (restoreId: string) => Promise<void> | void
}

interface ItemDecisionState {
  /** 'pending' = 未决；其它 = 用户已决策 */
  status: 'pending' | 'useRemote' | 'keepLocal' | 'skip'
}

export function SyncPullPreviewView(props: SyncPullPreviewViewProps): ReactNode {
  const { applyPlan, stateDir, appliedIds = [], warnings = [], restoreId, onAllResolved, onRollback } = props;
  const items = useMemo(() => projectReviewItems(applyPlan), [applyPlan]);
  const [decisions, setDecisions] = useState<Record<string, ItemDecisionState['status']>>(() => {
    const init: Record<string, ItemDecisionState['status']> = {};
    for (const it of items) init[it.itemId] = it.initial;
    return init;
  });

  const decide = useCallback(async (itemId: string, decision: 'useRemote' | 'keepLocal' | 'skip') => {
    setDecisions((prev) => ({ ...prev, [itemId]: decision }));
    try {
      await resolveItem(stateDir, itemId, decision);
    } catch (err) {
      // 决策持久化失败：UI 层错误处理——此处仅控制台提示，上层可通过 warnings 透传
      console.warn(`resolveItem(${itemId}) 失败：`, err);
    }
  }, [stateDir]);

  // 计算剩余未决项
  const pendingIds = useMemo(() => items.filter((i) => decisions[i.itemId] === 'pending').map((i) => i.itemId), [items, decisions]);
  if (pendingIds.length === 0 && items.length > 0 && onAllResolved) {
    // useEffect 替代：此处直接调用——组件是纯展示
    queueMicrotask(() => onAllResolved());
  }

  return (
    <div className="sync-pull-preview">
      {/* 自动已应用列表 */}
      {appliedIds.length > 0 && (
        <Card>
          <SectionTitle title={`自动已应用（${appliedIds.length}）`} />
          <ul>
            {appliedIds.map((sid) => (
              <li key={sid}>
                <Badge kind="ok">✓</Badge> <code>{sid}</code>
              </li>
            ))}
          </ul>
          {warnings.length > 0 && (
            <ul className="warnings">
              {warnings.map((w, i) => <li key={i} className="warning">{w}</li>)}
            </ul>
          )}
          {restoreId && onRollback && (
            <Button variant="danger" onClick={() => onRollback(restoreId)}>{`回滚到应用前 (${restoreId})`}</Button>
          )}
        </Card>
      )}

      {/* 待审列表 */}
      {items.length > 0 && (
        <Card>
          <SectionTitle title={`待审变更（${items.length}）`} />
          {items.map((it) => (
            <ReviewItemRow
              key={it.itemId}
              item={it}
              state={decisions[it.itemId] ?? 'pending'}
              onDecide={(d) => decide(it.itemId, d)}
            />
          ))}
        </Card>
      )}

      {/* 跳过 */}
      {applyPlan.skipped.length > 0 && (
        <Card>
          <SectionTitle title={`无变化（${applyPlan.skipped.length}）`} />
          <ul>
            {applyPlan.skipped.map((r) => (
              <li key={r.id}><code>{r.id}</code> —— skip（无变化）</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

interface ReviewItemRowProps {
  item: ReviewDisplayItem
  state: ItemDecisionState['status']
  onDecide: (d: 'useRemote' | 'keepLocal' | 'skip') => void
}

function ReviewItemRow({ item, state, onDecide }: ReviewItemRowProps): ReactNode {
  return (
    <div className={`review-item state-${state}`}>
      <div className="review-item-header">
        <code>{item.sectionId}</code> <span>{item.description}</span>
        <Badge kind={state === 'pending' ? 'warn' : 'ok'}>{labelForState(state)}</Badge>
      </div>
      {item.conflicts.length > 0 && (
        <details>
          <summary>差异（{item.conflicts.length}）</summary>
          <pre>
            {item.conflicts.map((c, i) => (
              <div key={i}>{formatDiff(c.local, c.remote)}</div>
            ))}
          </pre>
        </details>
      )}
      <div className="review-item-actions">
        <Button variant="ghost" disabled={state !== 'pending'} onClick={() => onDecide('keepLocal')}>用本地</Button>
        <Button variant="primary" disabled={state !== 'pending'} onClick={() => onDecide('useRemote')}>用远端</Button>
        <Button variant="ghost" disabled={state !== 'pending'} onClick={() => onDecide('skip')}>跳过</Button>
      </div>
    </div>
  );
}

function labelForState(s: ItemDecisionState['status']): string {
  switch (s) {
    case 'pending': return '待决';
    case 'useRemote': return '已选：远端';
    case 'keepLocal': return '已选：本地';
    case 'skip': return '已选：跳过';
  }
}
