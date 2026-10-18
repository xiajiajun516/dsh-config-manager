/**
 * 远程合并裁决视图（T-ui-merge）—— **只做装配**：
 *   - 列表投影 / 决策标签 / 计数 / 裁决草稿状态 → `./merge-view.ts` 纯函数（node 单测覆盖）；
 *   - 通道请求体由父级给（`channelPayload`）—— 组件不读通道状态、不拼 URL、不直接 fetch。
 *
 * 交互契约（Lead 2026-10-18 冻结）：**裁决粒度 = 分区**。
 *   分区行承载动作按钮（采用本地 / 采用远端 / 采用自动合并 / 跳过），冲突明细行只做展示；
 *   因此界面常驻写明「冲突按分区整体裁决（本版不做逐条裁决）」。
 *
 * 诚实性三条（都由本组件兑现）：
 *   ① 「跳过 ≠ 已解决」常驻提示：skip 不推进同步基线，下次同步仍会出现；
 *   ② 执行结果里的 pendingConflicts 必须显示出来，不得把带 skip 的执行说成「已解决」；
 *   ③ 所有展示文本（含引擎回传的三列预览）渲染前过 redact（merge-view.ts 已做一次，
 *      这里对原始错误/告警再过一次）。
 */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, SectionTitle } from '../common/ui.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import type { MergeApplyResponse, MergePreviewResponse, SyncApi, SyncPushPayload } from './sync-api.ts'
import {
  applyBulkResolution, buildMergeResolutions, hasWritableResolution, initialResolutionDraft,
  mergeDecisionCounts, mergeResultView, mergeSectionRows, mergeSummaryItems, needsNoAncestorNotice,
} from './merge-view.ts'
import type { MergeBulkAction, MergeResolutionAction, MergeResolutionDraft } from './merge-view.ts'
import css from '../config-manager.module.css'

export interface MergePreviewViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 通道请求体（含 transport / 地址 / 凭据引用；与 push/pull 同源）。组件不读通道状态。 */
  channelPayload: () => SyncPushPayload
  /** 分区 id → 本地化名称（父级用 sectionLabeler(cmT) 提供，与同步页其它位置同源） */
  sectionName: (id: string) => string
  /** 解密密码（可选，仅内存；与 /sync/sync 同口径，留空用本机已存凭据） */
  decryptPassword?: string
  /** 父级忙碌（其它同步操作进行中）→ 禁用执行，避免并发写 */
  busy?: boolean
  /** 执行成功后通知父级刷新同步状态 */
  onApplied?: () => void
  /** 回滚完成后通知父级刷新同步状态 */
  onRolledBack?: () => void
  /**
   * 预置预览（方案 A：一键同步已用**一次**请求取到 → 直接渲染，绝不再拉一遍远端快照）。
   * 有值 = 打开即展示该结果；null/缺省 = 挂载时自取（保留翻页/重进后的自取路径）。
   */
  initialPreview?: MergePreviewResponse | null
  /**
   * 收起视图（受控入口提供）。方案 A：主行不再有「检查远程合并」按钮，
   * 视图由一键同步自动展开 —— 因此**必须**在视图内留一个收起出口（不提供则不渲染该按钮）。
   */
  onClose?: () => void
}

/**
 * 远程合并预览 + 裁决 + 执行 + 回滚。
 *
 * 组件自持：预览结果 / 裁决草稿 / 执行结果 / 三个进行中标志 / 错误。
 * 草稿**不持久化**（裁决是当次操作的一部分；刷新页面等于放弃本次裁决，不会静默留下半套选择）。
 */
export function MergePreviewView({
  api, t, channelPayload, sectionName, decryptPassword, busy = false, onApplied, onRolledBack, initialPreview, onClose,
}: MergePreviewViewProps) {
  /** 预置种子（只读：挂载时用它初始化，不在后续渲染里改状态） */
  const seed = initialPreview ?? null
  const [preview, setPreview] = useState<MergePreviewResponse | null>(seed)
  const [draft, setDraft] = useState<MergeResolutionDraft>(() => initialResolutionDraft(seed))
  const [result, setResult] = useState<MergeApplyResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const passwordField = decryptPassword !== undefined && decryptPassword !== '' ? { decryptPassword } : {}

  /** 只读预览：拉取远端快照做三方合并（宿主侧零写入），并按结果重建裁决草稿。 */
  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.mergePreview({ ...channelPayload(), ...passwordField })
      setPreview(next)
      setDraft(initialResolutionDraft(next))
      setResult(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // 有预置种子就不再请求（方案 A 的「只取一次」）；否则挂载时自取一次，
    // 之后由「重新预览」按钮显式刷新（避免与父级轮询叠加）。
    if (seed !== null) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setAction = (sectionId: string, action: MergeResolutionAction): void => {
    setDraft((cur) => ({ ...cur, [sectionId]: action }))
  }

  const bulk = (action: MergeBulkAction): void => {
    setDraft((cur) => applyBulkResolution(preview, cur, action))
  }

  /** 执行合并（写动作，过宿主 mutation gate）；结果如实展示，包括 pendingConflicts。 */
  const apply = async (): Promise<void> => {
    setApplying(true)
    setError(null)
    try {
      const report = await api.applyMerge({
        ...channelPayload(),
        ...passwordField,
        resolutions: buildMergeResolutions(draft),
      })
      setResult(report)
      if (report.ok) toast.ok(t('merge.toast.applied'))
      else toast.error(t('merge.toast.applyFailed'))
      onApplied?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      toast.error(t('merge.toast.applyFailed'))
    } finally {
      setApplying(false)
    }
  }

  /** 一键回滚：复用既有 /sync/rollback 数据流（restoreId 来自本次执行）。 */
  const rollback = async (): Promise<void> => {
    const view = mergeResultView(result)
    if (view === null || view.restoreId === null) return
    setRollingBack(true)
    try {
      const report = await api.rollback({ restoreId: view.restoreId })
      if (report.full) toast.ok(t('merge.result.rolledBackTo', { id: view.restoreId }))
      else toast.error(t('merge.result.rollbackIncomplete'))
      onRolledBack?.()
    } catch (err) {
      toast.error(t('merge.toast.rollbackFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    } finally {
      setRollingBack(false)
    }
  }

  const rows = mergeSectionRows(preview)
  const summary = mergeSummaryItems(preview)
  const counts = mergeDecisionCounts(preview, draft)
  const writable = hasWritableResolution(draft)
  const resultView = mergeResultView(result)

  return (
    <Card>
      <SectionTitle title={t('merge.title')} info={<InfoHint text={t('merge.subtitle')} label={t('common.infoHint')} />} />

      <div className={css.statRow}>
        {summary.map((item) => (
          <span key={item.labelKey} className={css.mergeStat}>
            <Badge kind={item.tone}>{t(item.labelKey)}</Badge>
            <span className={css.mergeStatValue}>{String(item.value)}</span>
          </span>
        ))}
      </div>

      {preview !== null && needsNoAncestorNotice(preview) && <Banner kind="warn">{t('merge.noAncestor')}</Banner>}

      <div className={css.actionRow}>
        <Button size="sm" disabled={busy || loading} onClick={() => { void load() }}>{t('merge.reload')}</Button>
        <InfoHint text={t('merge.scopeNotice')} label={t('common.infoHint')} />
        {onClose !== undefined && <Button size="sm" onClick={onClose}>{t('common.close')}</Button>}
      </div>

      {loading && <Skeleton count={3} label={t('merge.loading')} />}
      {error !== null && (
        <ErrorBanner error={t('merge.error.previewFailed') + t('common.labelSeparator') + redact(error)} onRetry={() => { void load() }} retrying={loading} t={api.t} />
      )}

      {preview !== null && !loading && rows.length === 0 && (
        <div className={css.hint}>
          {t('merge.empty')}
          <br />
          {t('merge.emptyHint')}
        </div>
      )}

      {rows.length > 0 && (
        <div className={css.mergeScroll}>
          {rows.map((row) => {
            const current = draft[row.id] ?? (row.needsDecision ? 'skip' : null)
            return (
              <div key={row.id} className={css.mergeSection}>
                <div className={css.mergeSectionHead}>
                  <span className={css.mergeSectionName}>{sectionName(row.id)}</span>
                  <Badge kind={row.tone}>{t(row.decisionKey)}</Badge>
                  {row.conflictCount > 0 && <span className={css.mergeMeta}>{t('merge.conflictCount', { n: String(row.conflictCount) })}</span>}
                  {row.autoMerged !== null && row.autoMerged > 0 && (
                    <span className={css.mergeMeta}>{t('merge.autoMergedCount', { n: String(row.autoMerged) })}</span>
                  )}
                </div>

                <div className={css.mergeActions}>
                  {MERGE_ACTION_BUTTONS.map((btn) => {
                    const disabled = btn.action === 'useMerged' && !row.canUseMerged
                    return (
                      <Button
                        key={btn.action}
                        size="sm"
                        disabled={busy || disabled}
                        className={current === btn.action ? css.mergeActionActive : undefined}
                        title={disabled ? t('merge.action.useMergedDisabled') : undefined}
                        onClick={() => { setAction(row.id, btn.action) }}
                      >
                        {t(btn.key)}
                      </Button>
                    )
                  })}
                </div>

                {row.conflicts.map((conflict) => (
                  <div key={conflict.path} className={css.mergeConflictRow}>
                    <div className={css.mergeConflictPath}>
                      <span className={css.mergeKind}>{t(conflict.kindKey)}</span>
                      {conflict.path}
                    </div>
                    <div className={css.mergeConflictReason}>{t(conflict.reasonKey)}</div>
                    <div className={css.mergeCols}>
                      {MERGE_PREVIEW_COLUMNS.map((col) => {
                        const value = col.of(conflict)
                        return (
                          <div key={col.key} className={css.mergeCol}>
                            <span className={css.mergeColLabel}>{t(col.key)}</span>
                            <pre className={css.mergeColValue}>{value === '' ? t('merge.preview.empty') : value}</pre>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className={css.actionRow}>
            <Button size="sm" disabled={busy || loading} onClick={() => { bulk('keepLocal') }}>{t('merge.bulk.keepLocal')}</Button>
            <Button size="sm" disabled={busy || loading} onClick={() => { bulk('useRemote') }}>{t('merge.bulk.useRemote')}</Button>
            <Button size="sm" disabled={busy || loading} onClick={() => { bulk('useMerged') }}>{t('merge.bulk.useMerged')}</Button>
            <Button size="sm" disabled={busy || loading} onClick={() => { bulk('autoOnly') }}>{t('merge.bulk.autoOnly')}</Button>
          </div>

          <Banner kind="warn">{t('merge.skipNotice')}</Banner>

          <div className={css.statRow}>
            <span className={css.mergeMeta}>{t('merge.apply.summary', { decided: String(counts.decided), needs: String(counts.needsDecision) })}</span>
            {counts.skipped > 0 && <span className={css.mergeMeta}>{t('merge.apply.skips', { n: String(counts.skipped) })}</span>}
          </div>
          {counts.undecided > 0 && <div className={css.hint}>{t('merge.apply.undecided', { n: String(counts.undecided) })}</div>}

          <div className={css.actionRow}>
            <Button
              variant="primary"
              loading={applying}
              disabled={busy || loading || !writable}
              onClick={() => { void apply() }}
            >
              {t('merge.apply')}
            </Button>
          </div>
          {!writable && <div className={css.hint}>{t('merge.apply.nothing')}</div>}
        </>
      )}

      {resultView !== null && (
        <>
          <span className={css.groupLabel}>{t('merge.result.title')}</span>
          <div className={css.kvRow}>
            <span className={css.kvKey}>{t('merge.result.applied')}</span>
            <span className={css.kvValue}>{String(resultView.applied.length)}</span>
          </div>
          <div className={css.kvRow}>
            <span className={css.kvKey}>{t('merge.result.skipped')}</span>
            <span className={css.kvValue}>{String(resultView.skipped.length)}</span>
          </div>
          {resultView.warnings.length > 0 && (
            <div className={css.kvRow}>
              <span className={css.kvKey}>{t('merge.result.warnings')}</span>
              <span className={css.kvValue}>
                {resultView.warnings.map((w) => <div key={w} className={css.hint}>{redact(w)}</div>)}
              </span>
            </div>
          )}
          {resultView.restoreId !== null && (
            <div className={css.kvRow}>
              <span className={css.kvKey}>{t('merge.result.restoreId')}</span>
              <span className={css.kvValue}><span className={css.mono}>{resultView.restoreId}</span></span>
            </div>
          )}
          {resultView.applied.length === 0 && resultView.skipped.length === 0 && (
            <div className={css.hint}>{t('merge.result.none')}</div>
          )}
          {resultView.failedCount > 0 && <div className={css.hint}>{t('merge.result.failed', { n: String(resultView.failedCount) })}</div>}
          {resultView.ineffectiveCount > 0 && <div className={css.hint}>{t('merge.result.ineffective', { n: String(resultView.ineffectiveCount) })}</div>}
          {resultView.rolledBack && (
            <Banner kind="info">{resultView.rollbackFull === false ? t('merge.result.rollbackIncomplete') : t('merge.result.rolledBack')}</Banner>
          )}
          {resultView.hasPendingConflicts && (
            <Banner kind="warn">{t('merge.result.pending', { n: String(resultView.pendingConflicts.length) })}</Banner>
          )}
          {resultView.restoreId !== null && !resultView.rolledBack && (
            <div className={css.actionRow}>
              <Button loading={rollingBack} disabled={busy} onClick={() => { void rollback() }}>{t('merge.result.rollback')}</Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/** 入口组件的 props = 裁决视图 props + 打开回调（方案 A 后主行不再使用自带按钮）。 */
export interface MergePreviewEntryProps extends MergePreviewViewProps {
  /** 打开前先切到该通道（宿主请求体取自「当前通道」的表单快照，不切换就会拿错通道的地址） */
  onOpen?: () => void
  /**
   * 受控展开信号（方案 A）：值变化即展开一次。一键同步分派命中合并路径时由父级递增值，
   * 于是主行不再需要独立的「检查远程合并」按钮。
   */
  openSignal?: number
  /** 隐藏自带入口按钮（受控模式下由父级按钮触发；按钮样式与提示保持不变时无需隐藏） */
  hideEntryButton?: boolean
}

/**
 * 入口（按钮 + ⓘ）+ 裁决视图（展开时）。
 *
 * 开合状态**自持**：SyncPanel 有行数棘轮（装配层不许膨胀），主文件只留一次调用；
 * 视图本身在展开时才挂载（未展开零请求 —— 预览要拉远端快照，不该由页面渲染顺手触发）。
 * 受控展开（openSignal）与预置预览（initialPreview）组合 = 方案 A 的「一键同步 → 自动进裁决」。
 */
export function MergePreviewEntry({ onOpen, t, openSignal, hideEntryButton = false, ...view }: MergePreviewEntryProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    // 只在**收到有效信号**时展开（不做「值变小即收起」——收起由用户主动点按钮决定）
    if (openSignal !== undefined && openSignal > 0) setOpen(true)
  }, [openSignal])
  return (
    <>
      {!hideEntryButton && (
        <div className={css.actionRow}>
          <Button
            disabled={view.busy === true}
            onClick={() => {
              if (!open) onOpen?.()
              setOpen((cur) => !cur)
            }}
          >
            {t('merge.entry')}
          </Button>
          <InfoHint text={t('merge.entryHint')} label={t('common.infoHint')} />
        </div>
      )}
      {/* key = 信号：新的预览到达时重建视图（旧裁决属于上一份远端快照，必须丢弃）；
          t 单独回传：它是必填 prop，解构后不在 view 里。 */}
      {open && <MergePreviewView key={openSignal ?? 0} t={t} {...view} onClose={() => { setOpen(false) }} />}
    </>
  )
}

/** 分区级动作按钮（顺序即界面顺序；useMerged 无 merged 载荷时禁用并给原因）。 */
const MERGE_ACTION_BUTTONS: ReadonlyArray<{ action: MergeResolutionAction; key: 'merge.action.useLocal' | 'merge.action.useRemote' | 'merge.action.useMerged' | 'merge.action.skip' }> = [
  { action: 'keepLocal', key: 'merge.action.useLocal' },
  { action: 'useRemote', key: 'merge.action.useRemote' },
  { action: 'useMerged', key: 'merge.action.useMerged' },
  { action: 'skip', key: 'merge.action.skip' },
]

/** 三列对照（本地 / 远端 / 基准）。 */
const MERGE_PREVIEW_COLUMNS = [
  { key: 'merge.col.local', of: (c: { localPreview: string }) => c.localPreview },
  { key: 'merge.col.remote', of: (c: { remotePreview: string }) => c.remotePreview },
  { key: 'merge.col.ancestor', of: (c: { ancestorPreview: string }) => c.ancestorPreview },
] as const
