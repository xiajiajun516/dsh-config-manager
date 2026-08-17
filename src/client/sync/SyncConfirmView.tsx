/**
 * 一键同步差异确认视图（方案 A §5 差异确认数据流）。
 *
 * 消费 POST /sync/sync 返回的 items[]，渲染逐项确认列表：
 * - 每项：kindTag + description + severity + 「采用远端」复选框（默认勾选，可取消）；
 * - Conflict 项：内联弹窗（用本地 / 用远端 / 跳过）；
 * - 底部：「确认导入」（apply-items）+「取消」（cancel）。
 *
 * 全部渲染模型来自 ./sync-view.ts 纯函数（node 单测覆盖），组件只做装配 + 交互状态。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Badge, Banner, Button, Card, Spinner } from '../common/ui.tsx'
import type { SyncApi, SyncConfirmItem } from './sync-api.ts'
import { kindLabel, severityLabel, summarizeConfirmItems } from './sync-view.ts'
import type { ApplyItemsResponse } from './sync-api.ts'
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

export interface SyncConfirmViewProps {
  api: SyncApi
  /** 差异确认会话 id（apply-items / cancel 引用）。 */
  syncSessionId: string
  /** 被拉取的远端快照 id。 */
  snapshotId: string
  items: SyncConfirmItem[]
  needsReview: boolean
  /** 兼容性评级（可选展示）。 */
  compatibility?: 'excellent' | 'good' | 'partial' | 'unsupported'
  /** 翻译器。 */
  t: TranslateNS<'config-manager-sync'>
  /** 用户取消确认后回调（复位到空闲态）。 */
  onCancel: () => void
  /** 回滚成功后回调（清空 lastRestoreId）。 */
  onRollbackDone?: () => void
}

type ConflictResolution = 'useRemote' | 'keepLocal' | 'skip'

/** 单条差异项的可变决策状态。 */
interface ItemState {
  adopted: boolean
  resolution?: ConflictResolution
}

export function SyncConfirmView(props: SyncConfirmViewProps): ReactNode {
  const { api, syncSessionId, snapshotId, items, needsReview, compatibility, t, onCancel, onRollbackDone } = props;
  // 逐项决策状态（初始 = defaultAdopt）
  const [states, setStates] = useState<Record<string, ItemState>>(() => {
    const init: Record<string, ItemState> = {};
    for (const it of items) init[it.itemId] = { adopted: it.defaultAdopt, resolution: undefined };
    return init;
  });
  // 执行阶段：'idle' | 'applying' | 'done' | 'failed' | 'cancelling'
  const [phase, setPhase] = useState<'idle' | 'applying' | 'done' | 'failed' | 'cancelling'>('idle');
  const [applyResult, setApplyResult] = useState<ApplyItemsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeConfirmItems(
    items.map((it) => ({ ...it, adopt: states[it.itemId]?.adopted ?? it.defaultAdopt })),
  ), [items, states]);

  const setAdopted = (itemId: string, adopted: boolean): void => {
    setStates((prev) => ({ ...prev, [itemId]: { ...prev[itemId], adopted } }));
  };

  const setResolution = (itemId: string, resolution: ConflictResolution): void => {
    setStates((prev) => {
      const existing: ItemState = prev[itemId] ?? { adopted: false, resolution: undefined };
      return { ...prev, [itemId]: { ...existing, resolution } };
    });
  };

  const runApply = async (): Promise<void> => {
    // 校验冲突项必须已解决
    const unresolved = items.find(
      (it) => it.kind === 'Conflict' && (states[it.itemId]?.adopted === true) && states[it.itemId]?.resolution === undefined,
    );
    if (unresolved !== undefined) {
      setError(t('syncflow.conflictUnresolved', { itemId: unresolved.itemId }));
      return;
    }
    setPhase('applying');
    setError(null);
    try {
      const adoptedMap = new Map<string, boolean>();
      for (const it of items) {
        adoptedMap.set(it.itemId, states[it.itemId]?.adopted ?? false);
      }
      const adoptions = items
        .filter((it) => adoptedMap.get(it.itemId) === true)
        .map((it) => {
          const adoption: { itemId: string; adopt: boolean; resolution?: ConflictResolution } = { itemId: it.itemId, adopt: true };
          const res = states[it.itemId]?.resolution;
          if (it.kind === 'Conflict' && res !== undefined && res !== 'skip') adoption.resolution = res;
          return adoption;
        });
      const result = await api.applyItems({ syncSessionId, adoptions });
      setPhase(result.ok ? 'done' : 'failed');
      setApplyResult(result);
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runCancel = async (): Promise<void> => {
    setPhase('cancelling');
    setError(null);
    try {
      await api.cancel(syncSessionId);
    } catch { /* 取消失败无需打扰 */ }
    onCancel();
  };

  const runRollback = async (restoreId: string): Promise<void> => {
    setPhase('applying');
    setError(null);
    try {
      await api.rollback({ restoreId });
      setPhase('done');
      setApplyResult(null);
      onRollbackDone?.();
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = phase === 'applying' || phase === 'cancelling';

  if (items.length === 0) {
    return (
      <Card>
        <span className={css.groupLabel}>{t('syncflow.title')}</span>
        <Banner kind="ok">{t('syncflow.empty')}</Banner>
        <div className={css.actionRow}>
          <Button disabled={busy} onClick={() => { void runCancel() }}>
            {t('syncflow.cancel')}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <span className={css.groupLabel}>
        {t('syncflow.title')}
        {compatibility !== undefined && <Badge kind="info">{compatibility}</Badge>}
      </span>
      <Banner kind={needsReview ? 'warn' : 'info'}>
        {needsReview ? t('syncflow.needsReviewBadge') : t('syncflow.diffCount', { count: String(summary.total) })}
      </Banner>
      <div className={css.statRow}>
        <Badge kind="info">{t('syncflow.diffCount', { count: String(summary.total) })}</Badge>
        <Badge kind="ok">{t('syncflow.adoptRemote')} {summary.adopted}</Badge>
        {summary.error > 0 && <Badge kind="error">{severityLabel('error', api.t)} × {summary.error}</Badge>}
        {summary.warning > 0 && <Badge kind="warn">{severityLabel('warning', api.t)} × {summary.warning}</Badge>}
      </div>
      <span className={css.hint}>{t('syncflow.adoptHint')}</span>

      {/* 逐项差异列表 */}
      <div className={css.reportList}>
        {items.map((it) => {
          const st = states[it.itemId] ?? { adopted: it.defaultAdopt };
          const isConflict = it.kind === 'Conflict';
          return (
            <div key={it.itemId} className={css.statRow}>
              <label className={css.checkboxRow}>
                <input
                  type="checkbox"
                  checked={st.adopted}
                  disabled={busy}
                  onChange={(e) => { setAdopted(it.itemId, e.target.checked) }}
                />
                <span>{kindLabel(it.kind, api.t)}</span>
              </label>
              <Badge kind={it.severity === 'error' ? 'error' : it.severity === 'warning' ? 'warn' : 'info'}>
                {severityLabel(it.severity, api.t)}
              </Badge>
              <span>{it.description}</span>
              {isConflict && (
                <ConflictResolver
                  item={it}
                  resolution={st.resolution}
                  busy={busy}
                  t={t}
                  onResolve={(r) => { setResolution(it.itemId, r) }}
                />
              )}
            </div>
          );
        })}
      </div>

      {error !== null && <Banner kind="error">{error}</Banner>}

      {/* 确认导入 / 取消 */}
      {phase === 'idle' && (
        <div className={css.actionRow}>
          <Button variant="primary" disabled={busy || summary.adopted === 0} onClick={() => { void runApply() }}>
            {t('syncflow.confirmImport')}
          </Button>
          <Button disabled={busy} onClick={() => { void runCancel() }}>
            {t('syncflow.cancel')}
          </Button>
        </div>
      )}

      {/* 执行结果 */}
      {(phase === 'done' || phase === 'failed') && applyResult !== null && (
        <ApplyResultCard result={applyResult} busy={busy} t={t} onRollback={runRollback} />
      )}
      {(phase === 'done' || phase === 'failed') && applyResult === null && (
        <Banner kind="ok">{t('syncflow.rollbackDone')}</Banner>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- 冲突内联解决 */

interface ConflictResolverProps {
  item: SyncConfirmItem
  resolution?: ConflictResolution
  busy: boolean
  t: TranslateNS<'config-manager-sync'>
  onResolve: (r: ConflictResolution) => void
}

function ConflictResolver({ item, resolution, busy, t, onResolve }: ConflictResolverProps): ReactNode {
  const conflict = item.conflict;
  return (
    <span className={css.rowActions}>
      <span className={css.fieldLabel}>{t('syncflow.conflictTitle')}</span>
      <Button variant="ghost" disabled={busy || resolution === 'keepLocal'} onClick={() => { onResolve('keepLocal') }}>
        {resolution === 'keepLocal' ? `✓ ${t('syncflow.conflictUseLocal')}` : t('syncflow.conflictUseLocal')}
      </Button>
      <Button variant="primary" disabled={busy || resolution === 'useRemote'} onClick={() => { onResolve('useRemote') }}>
        {resolution === 'useRemote' ? `✓ ${t('syncflow.conflictUseRemote')}` : t('syncflow.conflictUseRemote')}
      </Button>
      <Button variant="ghost" disabled={busy || resolution === 'skip'} onClick={() => { onResolve('skip') }}>
        {resolution === 'skip' ? `✓ ${t('syncflow.conflictSkip')}` : t('syncflow.conflictSkip')}
      </Button>
      {conflict?.diff !== undefined && (
        <details className={css.conflictDetail}>
          <summary>{t('syncflow.diff')}</summary>
          <pre className={css.diffScroll}>{conflict.diff}</pre>
        </details>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- 执行结果 */

interface ApplyResultCardProps {
  result: ApplyItemsResponse
  busy: boolean
  t: TranslateNS<'config-manager-sync'>
  onRollback: (restoreId: string) => Promise<void>
}

function ApplyResultCard({ result, busy, t, onRollback }: ApplyResultCardProps): ReactNode {
  const ok = result.ok;
  return (
    <>
      <Banner kind={ok ? 'ok' : 'error'}>
        {ok ? t('syncflow.importDone', { n: String(result.applied.length) }) : t('syncflow.importFailed')}
      </Banner>
      {result.needsRestart && <Banner kind="warn">{t('syncflow.needsRestart')}</Banner>}
      {result.applied.length > 0 && (
        <div>
          <span className={css.fieldLabel}>{t('syncflow.importedSections')}</span>
          <div className={css.statRow}>
            {result.applied.map((sid) => <Badge key={sid} kind="ok">{sid}</Badge>)}
          </div>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div>
          <span className={css.fieldLabel}>{t('syncflow.importWarnings')}</span>
          <ul className={css.warnList}>
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {result.restoreId !== '' && (
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => { void onRollback(result.restoreId) }}
        >
          {busy ? <Spinner label={t('syncflow.rollingBack')} /> : t('syncflow.rollback')}
        </Button>
      )}
    </>
  );
}
