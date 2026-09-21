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
import { useEffect } from 'react'

import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Spinner } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { ConsultCard } from '../consult/ConsultCard.tsx'
import type { ConsultReport } from '../../core/migration-consult.ts'
import type { SyncApi, SyncConfirmItem } from './sync-api.ts'
import {
  buildAdoptions, keepLocalAll, kindLabel, reviewItems, severityLabel,
  summarizeConfirmItems, useRemoteAll, type SyncConflictResolution,
} from './sync-view.ts'
import type { ApplyItemsResponse } from './sync-api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { SyncConfirmDecisions } from '../run-store.ts'
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
  /** 逐项决策（受控：来自 runStore.sync.confirmDecisions；null = 无持久化决策，按 defaultAdopt 初始化） */
  decisions: SyncConfirmDecisions | null
  /** 决策变更上抛（SyncSettingsView patch 镜像 runStore，切 tab/刷新不丢） */
  onDecisionsChange: (decisions: SyncConfirmDecisions) => void
  /** 用户取消确认后回调（复位到空闲态）。 */
  onCancel: () => void
  /** 回滚成功后回调（清空 lastRestoreId）。 */
  onRollbackDone?: () => void
}

/** 冲突解决方式：与导入恢复向导一致的两项（保留当前 / 使用备份）。 */
type ConflictResolution = SyncConflictResolution

/** 单条差异项的可变决策状态。 */
interface ItemState {
  adopted: boolean
  resolution?: ConflictResolution
}

export function SyncConfirmView(props: SyncConfirmViewProps): ReactNode {
  const { api, syncSessionId, snapshotId, items, needsReview, compatibility, t, decisions, onDecisionsChange, onCancel, onRollbackDone } = props;
  // 逐项决策状态（受控：来自 props.decisions；null 时按 defaultAdopt 初始化；持久化决策覆盖同名项）
  const states = useMemo<Record<string, ItemState>>(() => {
    const base: Record<string, ItemState> = {};
    for (const it of items) base[it.itemId] = { adopted: it.defaultAdopt, resolution: undefined };
    if (decisions === null) return base;
    for (const [id, d] of Object.entries(decisions)) {
      if (base[id] !== undefined) base[id] = { adopted: d.adopted, resolution: d.resolution };
    }
    return base;
  }, [items, decisions]);
  // 执行阶段：'idle' | 'applying' | 'done' | 'failed' | 'cancelling'
  const [phase, setPhase] = useState<'idle' | 'applying' | 'done' | 'failed' | 'cancelling'>('idle');
  const [applyResult, setApplyResult] = useState<ApplyItemsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Phase 7 迁移前咨询：远端快照咨询报告（本地 state，非敏感） */
  const [consultReport, setConsultReport] = useState<ConsultReport | null>(null);
  const [consultLoading, setConsultLoading] = useState(false);

  /** Phase 7 迁移前咨询：对远端快照生成咨询报告（只读，零写入）。失败静默。 */
  useEffect(() => {
    let cancelled = false;
    setConsultLoading(true);
    api.consult({ type: 'remote-snapshot', id: snapshotId, snapshotId })
      .then((report) => { if (!cancelled) setConsultReport(report); })
      .catch(() => { if (!cancelled) setConsultReport(null); })
      .finally(() => { if (!cancelled) setConsultLoading(false); });
    return () => { cancelled = true; };
  }, [snapshotId, api]);

  const summary = useMemo(() => summarizeConfirmItems(
    items.map((it) => ({ ...it, adopt: states[it.itemId]?.adopted ?? it.defaultAdopt })),
  ), [items, states]);

  // 仅需人工决策的项进入确认列表；非决策项（Create/Update 等）默认自动采用，不逐项展示
  const displayItems = useMemo(() => reviewItems(items), [items]);

  const setAdopted = (itemId: string, adopted: boolean): void => {
    const existing: ItemState = states[itemId] ?? { adopted: false, resolution: undefined };
    onDecisionsChange({ ...(decisions ?? {}), [itemId]: { adopted, resolution: existing.resolution } });
  };

  const setResolution = (itemId: string, resolution: ConflictResolution): void => {
    const existing: ItemState = states[itemId] ?? { adopted: false, resolution: undefined };
    onDecisionsChange({ ...(decisions ?? {}), [itemId]: { adopted: existing.adopted, resolution } });
  };

  // 批量决策（仅作用于 Conflict 项；非 Conflict 项的 adopt 保持默认）
  const applyBulkDecision = (bulk: readonly { itemId: string; resolution: ConflictResolution; adopt: boolean }[]): void => {
    if (bulk.length === 0) return;
    const next: SyncConfirmDecisions = { ...(decisions ?? {}) };
    for (const d of bulk) {
      const existing: ItemState = states[d.itemId] ?? { adopted: false, resolution: undefined };
      next[d.itemId] = { ...existing, resolution: d.resolution, adopted: d.adopt };
    }
    onDecisionsChange(next);
  };

  const runApply = async (): Promise<void> => {
    // 校验冲突项必须已解决（与 buildAdoptions 的强制先解决一致）
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
      const resolutions = new Map<string, ConflictResolution>();
      for (const it of items) {
        const res = states[it.itemId]?.resolution;
        if (res !== undefined) resolutions.set(it.itemId, res);
      }
      const adoptions = buildAdoptions(items, adoptedMap, resolutions);
      const result = await api.applyItems({ syncSessionId, adoptions });
      setPhase(result.ok ? 'done' : 'failed');
      setApplyResult(result);
      // R-05：导入成功改走 Toast —— 在此处（而非 ApplyResultCard 渲染期）触发，
      // 保证每次 apply 恰好一次、且重渲染不会重复弹。失败分支**不**弹 Toast，
      // 由 ApplyResultCard 的 error Banner 承载（K-06：同卡内还有 warnings 明细与
      // 回滚危险按钮，用户必须停在此处决策）。
      if (result.ok) {
        toast.ok(t('syncflow.importDone', { n: String(result.applied.length) }));
      }
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
      // R-04：回滚成功改走 Toast（原 ok Banner 只在「回滚成功」这一条路径出现；
      // 操作已完成、用户可离开，不需要停留阅读）。下方「关闭」按钮保留。
      toast.ok(t('syncflow.rollbackDone'));
      onRollbackDone?.();
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = phase === 'applying' || phase === 'cancelling';

  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <Banner kind="ok">{t('syncflow.empty')}</Banner>
        <div className={css.actionRow}>
          <Button disabled={busy} onClick={() => { void runCancel() }}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {compatibility !== undefined && (
        <div className={css.statRow}>
          <Badge kind="info">{compatibility}</Badge>
        </div>
      )}
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

      {/* 批量决策（仅作用于 Conflict 项） */}
      <div className={css.actionRow}>
        <Button variant="ghost" disabled={busy || displayItems.filter((it) => it.kind === 'Conflict').length === 0} onClick={() => { applyBulkDecision(keepLocalAll(items)) }}>
          {t('syncflow.keepLocalAll')}
        </Button>
        <Button variant="primary" disabled={busy || displayItems.filter((it) => it.kind === 'Conflict').length === 0} onClick={() => { applyBulkDecision(useRemoteAll(items)) }}>
          {t('syncflow.useRemoteAll')}
        </Button>
        <span className={css.hint}>{t('syncflow.bulkHint')}</span>
      </div>

      {/* 逐项差异列表（仅需人工决策的项）；固定容器限高 + 内部滚动，防止整页被拉长 */}
      <div className={css.confirmScroll}>
        <div className={css.reportList}>
          {displayItems.map((it) => {
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
                {/* 同步差异项描述由宿主/引擎拼装，可能含本地配置值 → 渲染前过 redact（安全自查） */}
                <span>{redact(it.description)}</span>
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
      </div>

      {/* Phase 7 迁移前咨询卡（只读健康评分 + 建议） */}
      {consultLoading && <Spinner label={api.t('consult.loading')} />}
      {consultReport !== null && <ConsultCard report={consultReport} t={api.t} />}

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
        <>
          <ApplyResultCard result={applyResult} busy={busy} t={t} onRollback={runRollback} />
          <div className={css.actionRow} style={{ marginTop: '12px' }}>
            <Button variant="primary" disabled={busy} onClick={() => { onCancel() }}>
              {t('common.close')}
            </Button>
          </div>
        </>
      )}
      {(phase === 'done' || phase === 'failed') && applyResult === null && (
        <>
          {/* R-04：回滚成功的 ok Banner 已改为 Toast（见 runRollback）。此处仅保留收尾「关闭」按钮；
             一并消除了原实现在 runApply 抛错（phase=failed 且 applyResult 仍为 null）时
              误显示「已回滚到应用前」的问题 —— 那种情况下方 error Banner 才是唯一事实。 */}
          <div className={css.actionRow} style={{ marginTop: '12px' }}>
            <Button variant="primary" disabled={busy} onClick={() => { onCancel() }}>
              {t('common.close')}
            </Button>
          </div>
        </>
      )}
    </div>
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
  const options: { value: ConflictResolution; label: string }[] = [
    { value: 'keepLocal', label: t('syncflow.conflictUseLocal') },
    { value: 'useRemote', label: t('syncflow.conflictUseRemote') },
  ];
  return (
    <div className={css.conflictItem}>
      {/* 变更详情（与导入恢复向导一致：如插件「当前 1.1 vs 备份 1.6」） */}
      {item.detail !== undefined && item.detail !== '' && (
        /* 原来是 <pre> + .conflictDetail：overflow-wrap 在 pre 上无效（同 UI-01/F-05），
           长 JSON 会横向溢出被裁 —— 改用普通块元素，脱敏同样在渲染前完成。 */
        <div className={css.conflictDetail}>{redact(item.detail)}</div>
      )}
      {conflict?.diff !== undefined && (
        <details className={css.conflictDetail}>
          <summary>{t('syncflow.diff')}</summary>
          {/* diff 保留 <pre>（对齐语义有价值），容器 .diffScroll 自带横向滚动，不会裁切 */}
          <pre className={css.diffScroll}>{redact(conflict.diff)}</pre>
        </details>
      )}
      {/* 与导入恢复向导 ConflictList 相同的两项单选（保留当前 / 使用备份） */}
      <div className={css.conflictOptions}>
        {options.map((opt) => (
          <label key={opt.value} className={css.radioLabel}>
            <input
              type="radio"
              name={`sync-conflict-${item.itemId}`}
              checked={resolution === opt.value}
              disabled={busy}
              onChange={() => { onResolve(opt.value) }}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </div>
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
      {/* R-05：成功分支已改走 Toast（见 runApply）；此处只保留失败 Banner ——
          K-06 要求失败后用户停留本卡阅读 warnings 明细并决定是否回滚，
          自动消失的 Toast 无法承载这个决策入口。 */}
      {!ok && <Banner kind="error">{t('syncflow.importFailed')}</Banner>}
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
