/**
 * 远程合并裁决视图（T-ui-merge）—— **纯展示组件**：
 *   - 列表投影 / 决策标签 / 计数 / 待裁决提示 → `./merge-view.ts` 纯函数（node 单测覆盖）；
 *   - 状态（预览 / 裁决草稿 / 执行结果 / 进行中标志）与请求由 `MergeModal.tsx` 持有：
 *     弹窗把「执行合并」放进 Modal.Footer（DESIGN UI-23），因此这里不自持任何写状态。
 *
 * 交互契约（Lead 2026-10-18 冻结）：**裁决粒度 = 分区**。
 *   分区卡承载动作按钮（采用本地 / 采用远端 / 采用自动合并），冲突明细只做展示；
 *   因此界面常驻写明「冲突按分区整体裁决（本版不做逐条裁决）」—— 走 ⓘ，不占正文。
 *
 * 两个按钮口径（2026-10-21 用户裁决后）：
 *   - **「采用自动合并」只在真有自动合并结果时才出现**（decision === 'merge'）；
 *     以前常驻一个永远灰着的按钮，用户分不清「没有结果」还是「坏了」；
 *   - **没有「跳过」按钮**：它既不是解决、又与「什么都不点」等价（未点名的分区引擎不会应用），
 *     留着只会让人以为已经处理过。
 *
 * 诚实性三条（都由本组件兑现）：
 *   ① 待裁决的分区本次不会被应用，且下次同步仍会出现 —— 用一行常驻提示说明；
 *   ② 执行结果里的 pendingConflicts 必须显示出来，不得把「还有冲突」说成「已解决」；
 *   ③ 所有展示文本（含引擎回传的三列预览）渲染前过 redact（merge-view.ts 已做一次，
 *      这里对原始错误/告警再过一次）。
 */
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, SectionTitle } from '../common/ui.tsx'
import { CheckIcon, RefreshIcon } from '../common/Icon.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { redact } from '../../security/redaction.ts'
import type { MergeApplyResponse, MergePreviewResponse, SyncApi } from './sync-api.ts'
import {
  hasApplicableSections, mergeDecisionCounts, mergeResultView, mergeSectionRows, mergeSummaryItems,
  needsNoAncestorNotice,
} from './merge-view.ts'
import type { MergeBulkAction, MergeResolutionAction, MergeResolutionDraft } from './merge-view.ts'
import css from '../config-manager.module.css'

export interface MergePreviewViewProps {
  /** 展示层翻译器（`config-manager-sync` 字典） */
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 预览结果（null = 还没取到；父级持有点位） */
  preview: MergePreviewResponse | null
  /** 裁决草稿（分区 id → 动作；缺省 = 本次不动，由父级初始化） */
  draft: MergeResolutionDraft
  /** 执行结果（null = 本次还没执行过） */
  result: MergeApplyResponse | null
  /** 预览请求在途 */
  loading: boolean
  /** 回滚在途 */
  rollingBack: boolean
  /** 预览/执行错误（原文，渲染前 redact） */
  error: string | null
  /** 父级忙碌（其它同步操作进行中）→ 禁用裁决与批量按钮 */
  busy?: boolean
  /** 分区 id → 本地化名称（父级用 sectionLabeler(cmT) 提供，与同步页其它位置同源） */
  sectionName: (id: string) => string
  /** 重新拉取只读预览（父级负责请求，本组件只发信号） */
  onReload: () => void
  /** 分区级裁决 */
  onAction: (sectionId: string, action: MergeResolutionAction) => void
  /** 批量裁决（对全部分区生效） */
  onBulk: (action: MergeBulkAction) => void
  /** 一键回滚（restoreId 取自本次执行结果） */
  onRollback: () => void
  /** 是否渲染自带标题（默认 true；放进弹窗时由 Modal 提供标题，避免同一个标题出现两次） */
  showTitle?: boolean
}

/**
 * 远程合并预览 + 裁决 + 结果展示。
 *
 * 版式（2026-10 重做）：概览指标块 → 工具栏（批量 / 重新预览）→ 分区卡（裁决片 + 冲突卡）
 * → 语义提示 → 结果卡。执行按钮在弹窗 Footer，故列表结束后不再堆一排按钮。
 */
export function MergePreviewView({
  api, t, preview, draft, result, loading, rollingBack, error, busy = false,
  sectionName, onReload, onAction, onBulk, onRollback, showTitle = true,
}: MergePreviewViewProps) {
  const rows = mergeSectionRows(preview)
  const summary = mergeSummaryItems(preview)
  const counts = mergeDecisionCounts(preview, draft)
  const applicable = hasApplicableSections(preview)
  const anyMerged = rows.some((row) => row.canUseMerged)
  const resultView = mergeResultView(result)

  return (
    <div className={css.mergeView}>
      {showTitle && (
        <SectionTitle
          title={t('merge.title')}
          info={<InfoHint text={t('merge.subtitle')} label={t('common.infoHint')} />}
        />
      )}

      {/* 概览：四个指标块。色只表达语义（可自动应用 / 待裁决 / 冲突 / 无变化），不做装饰。 */}
      <div className={css.mergeOverview}>
        {summary.map((item) => (
          <div key={item.labelKey} className={css.mergeTile} data-tone={item.tone}>
            <span className={css.mergeTileValue}>{String(item.value)}</span>
            <span className={css.mergeTileLabel}>{t(item.labelKey)}</span>
          </div>
        ))}
      </div>

      {preview !== null && needsNoAncestorNotice(preview) && <Banner kind="warn">{t('merge.noAncestor')}</Banner>}

      {/* 工具栏：批量裁决（一次改全部分区的草稿）+ 重新预览（只读）。
          「全部采用自动合并」「留到下次」只在有意义时出现（见 MERGE_BULK_BUTTONS 的 filter）。 */}
      <div className={css.mergeToolbar}>
        <span className={css.mergeToolbarLabel}>{t('merge.bulk.title')}</span>
        {MERGE_BULK_BUTTONS.filter((btn) => (
          (btn.action !== 'useMerged' || anyMerged) && (btn.action !== 'leavePending' || counts.needsDecision > 0)
        )).map((btn) => (
          <Button
            key={btn.action}
            size="sm"
            disabled={busy || loading || rows.length === 0}
            onClick={() => { onBulk(btn.action) }}
          >
            {t(btn.key)}
          </Button>
        ))}
        <span className={css.statusSpacer} />
        <InfoHint text={t('merge.scopeNotice') + ' ' + t('merge.bulk.hint')} label={t('common.infoHint')} />
        <Button size="sm" disabled={busy || loading} onClick={onReload}>
          <span className={css.mergeIconLabel}>
            <RefreshIcon size={12} />
            {t('merge.reload')}
          </span>
        </Button>
      </div>

      {loading && <Skeleton count={3} label={t('merge.loading')} />}
      {error !== null && (
        <ErrorBanner
          error={t('merge.error.previewFailed') + t('common.labelSeparator') + redact(error)}
          onRetry={onReload}
          retrying={loading}
          t={api.t}
        />
      )}

      {preview !== null && !loading && rows.length === 0 && (
        <div className={css.hint}>
          {t('merge.empty')}
          <br />
          {t('merge.emptyHint')}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <span className={css.groupLabel}>{t('merge.section.title')}</span>
          <div className={css.mergeScroll} data-fit="modal">
            {rows.map((row) => {
              const current = draft[row.id] ?? (row.needsDecision ? 'skip' : null)
              return (
                <div key={row.id} className={css.mergeSection}>
                  <div className={css.mergeSectionHead}>
                    <span className={css.mergeSectionName}>{sectionName(row.id)}</span>
                    <Badge kind={row.tone}>{t(row.decisionKey)}</Badge>
                    <span className={css.statusSpacer} />
                    {row.conflictCount > 0 && (
                      <span className={css.mergeMeta}>{t('merge.conflictCount', { n: String(row.conflictCount) })}</span>
                    )}
                    {row.autoMerged !== null && row.autoMerged > 0 && (
                      <span className={css.mergeMeta}>{t('merge.autoMergedCount', { n: String(row.autoMerged) })}</span>
                    )}
                  </div>

                  <div className={css.mergeActions} role="group" aria-label={sectionName(row.id)}>
                    {MERGE_ACTION_BUTTONS.filter((btn) => btn.action !== 'useMerged' || row.canUseMerged).map((btn) => {
                      const active = current === btn.action
                      return (
                        <Button
                          key={btn.action}
                          size="sm"
                          disabled={busy}
                          className={active ? css.mergeActionActive : undefined}
                          title={active ? t('merge.action.current') : undefined}
                          onClick={() => { onAction(row.id, btn.action) }}
                        >
                          <span className={css.mergeIconLabel}>
                            {active && <CheckIcon size={12} />}
                            {t(btn.key)}
                          </span>
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

          {/* 「待裁决的分区本次不会应用、下次还会出现」是决定性的语义（决定用户敢不敢点执行），压成一行常驻提示。 */}
          {counts.undecided > 0 && (
            <div className={css.hint}>{t('merge.apply.pendingHint', { n: String(counts.undecided) })}</div>
          )}
          {!applicable && <div className={css.hint}>{t('merge.apply.nothingPending')}</div>}
        </>
      )}

      {resultView !== null && (
        <div className={css.mergeResult}>
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
            <Banner kind="info">
              {resultView.rollbackFull === false ? t('merge.result.rollbackIncomplete') : t('merge.result.rolledBack')}
            </Banner>
          )}
          {resultView.hasPendingConflicts && (
            <Banner kind="warn">{t('merge.result.pending', { n: String(resultView.pendingConflicts.length) })}</Banner>
          )}
          {resultView.restoreId !== null && !resultView.rolledBack && (
            <div className={css.actionRow}>
              <Button loading={rollingBack} disabled={busy} onClick={onRollback}>{t('merge.result.rollback')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 分区级动作按钮（顺序即界面顺序）。
 *
 * 「采用自动合并」**只在真有 merged 载荷的分区上渲染**（row.canUseMerged）—— 常驻禁用态
 * 让用户以为功能坏了，而不是「这个分区没东西可自动合成」。
 */
const MERGE_ACTION_BUTTONS: ReadonlyArray<{
  action: MergeResolutionAction
  key: 'merge.action.useLocal' | 'merge.action.useRemote' | 'merge.action.useMerged'
}> = [
  { action: 'keepLocal', key: 'merge.action.useLocal' },
  { action: 'useRemote', key: 'merge.action.useRemote' },
  { action: 'useMerged', key: 'merge.action.useMerged' },
]

/** 批量动作（对全部分区生效；纯函数保证「留到下次」口径不在这里重算）。 */
const MERGE_BULK_BUTTONS: ReadonlyArray<{
  action: MergeBulkAction
  key: 'merge.bulk.keepLocal' | 'merge.bulk.useRemote' | 'merge.bulk.useMerged' | 'merge.bulk.leavePending'
}> = [
  { action: 'keepLocal', key: 'merge.bulk.keepLocal' },
  { action: 'useRemote', key: 'merge.bulk.useRemote' },
  { action: 'useMerged', key: 'merge.bulk.useMerged' },
  { action: 'leavePending', key: 'merge.bulk.leavePending' },
]

/** 三列对照（本地 / 远端 / 基准）。 */
const MERGE_PREVIEW_COLUMNS = [
  { key: 'merge.col.local', of: (c: { localPreview: string }) => c.localPreview },
  { key: 'merge.col.remote', of: (c: { remotePreview: string }) => c.remotePreview },
  { key: 'merge.col.ancestor', of: (c: { ancestorPreview: string }) => c.ancestorPreview },
] as const
