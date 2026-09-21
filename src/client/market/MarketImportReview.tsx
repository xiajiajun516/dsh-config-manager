/**
 * 市场条目导入审阅面板（MarketImportReview）—— 浏览条目详情 与 我的配置→装回本地 **共用同一个组件**。
 *
 * 为什么存在：市场通道此前两处（MarketPanel / MyConfigsView）各写一套「平铺分区批准表 + 导入执行
 * + Toast」，与导入页的级联树是两套勾选语义。现在市场通道与导入页共用 `ContentPicker` +
 * `src/ui/selection-model.ts` 的 Selection 内核（默认全选、全选含高风险分区）。
 *
 * P1 + P2（2026-09，用户要求）：**页面级分步向导** —— 预览 → 选择内容 →（冲突）→ 确认 → 结果。
 * 起因是实测的 3 分区 / 61 个计划项：「供应链警示 + 级联树 + 逐项摘要 + 冲突 + 按钮」同屏
 * 会产生**三重滚动**（弹窗自身 + 树内滚 320px + 摘要内滚 380px）。
 *
 *   P1 = 把内容拆成分步，逐项摘要降维成**分区级小结**（一行一个分区），逐项信息回到树上
 *        （`ContentPicker.unitBadge`）—— 同一批条目只渲染一遍；
 *   P2 = 载体从「列表上的弹窗」改为**页面**：本组件吃满 `.viewBody` 的剩余高度
 *        （`.marketReviewPage`，min-height 320px 防塌陷），由父页给出「标题 + 返回列表」页头，
 *        列表视图整块让位。滚动只发生在步内那一个区域（`.marketReviewScroll`）或选择步的树列表里。
 *
 * 状态归属：本组件**受控**（selection / resolutions / result 全由父组件持有并持久化进 runStore
 * 切片），因为这两个父页面都要求「切 tab / 刷新后勾选不丢」。步骤与筛选是纯瞬态（组件自持）。
 *
 * 冲突决策走**宿主重算**（`createImportPlan`，与导入向导 execute() 同一路径），不在前端手改
 * planItem.kind —— 那等于把 analyzer.applyItemResolution 抄一份到 UI，两处必然漂移。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImportPlan, ImportResult, ItemResolution } from '../../core/types.ts'
import type { RestoreReport } from '../../core/restore.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { SectionId } from '../../schema/types.ts'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import { buildSelectedPlan, isHighRiskAdapter, type Selection } from '../../ui/selection-model.ts'
import {
  filterPickerNodes, marketChangeRows, marketConflictItems, marketDecisions, marketPickerNodes,
  marketReviewSteps, marketSectionSummaries, marketSelectionSummary, marketUnitIndex,
  nextMarketStep, prevMarketStep, selectedHighRiskSections,
  type MarketPickerFilter, type MarketReviewStep,
} from '../../ui/market-import.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Segmented, Spinner, Stepper } from '../common/ui.tsx'
import { ContentPicker } from '../common/ContentPicker.tsx'
import { ConflictList } from '../import/ConflictList.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { sectionLabeler } from '../common/section-labels.ts'
import { toast } from '../common/toast-store.ts'
import { runStore } from '../run-store.ts'
import css from '../config-manager.module.css'

/** 步骤标签用到的 market 字典键（窄联合：拼错或漏配会在编译期报错）。 */
type MarketStepLabelKey =
  | 'review.step.preview' | 'review.step.select' | 'review.step.conflicts'
  | 'review.step.confirm' | 'review.step.result'

/** 步骤 id → market 字典键（渲染处不写 switch）。 */
const STEP_LABEL: Record<MarketReviewStep, MarketStepLabelKey> = {
  preview: 'review.step.preview',
  select: 'review.step.select',
  conflicts: 'review.step.conflicts',
  confirm: 'review.step.confirm',
  result: 'review.step.result',
}

export interface MarketImportReviewProps {
  /** 主 ConfigManagerApi（createImportPlan / executeImportPlan / restoreSnapshot） */
  importApi: ConfigManagerApi
  /** 市场文案字典（本组件自己的文案） */
  t: TranslateNS<'config-manager-market'>
  /**
   * config-manager 字典（级联树文案 + 分区显示名 + 冲突决策列表）。
   * 必须是这个命名空间的翻译器：`picker.*` / `section.*` / `import.conflicts.*` 键都在它里面
   * —— 市场面板的 `api.t` 是框架无关 UiT（另一套键空间），传错会渲染成裸 key。
   */
  cmT: TranslateNS<'config-manager'>
  /** 宿主受控临时 ZIP 路径（market/download 落盘的那份） */
  zipPath: string
  plan: ImportPlan
  selection: Selection
  onSelectionChange: (next: Selection) => void
  /** 逐项冲突决策（持久化；重算计划与刷新后重建决策列表都靠它） */
  resolutions: Record<string, ItemResolution>
  onResolutionsChange: (next: Record<string, ItemResolution>) => void
  /** 宿主重算后的计划回写（父组件持久化 detail.plan） */
  onPlanChange: (plan: ImportPlan) => void
  importing: boolean
  onImportingChange: (value: boolean) => void
  result: ImportResult | null
  onResultChange: (result: ImportResult) => void
  /** 错误文本回写（父组件仅作失败标记；Toast 已另行送达） */
  onErrorChange: (message: string | null) => void
  /** 条目展示名（回滚确认文案用） */
  itemName: string
}

export function MarketImportReview({
  importApi, t, cmT, zipPath, plan, selection, onSelectionChange, resolutions,
  onResolutionsChange, onPlanChange, importing, onImportingChange, result, onResultChange,
  onErrorChange, itemName,
}: MarketImportReviewProps) {
  /** 当前步骤（瞬态：不进持久化，刷新回到第一步 —— 勾选与决策本身不丢） */
  const [step, setStep] = useState<MarketReviewStep>('preview')
  /** 选择步的筛选档（只影响渲染） */
  const [filter, setFilter] = useState<MarketPickerFilter>('all')
  const [noSelectionHint, setNoSelectionHint] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [rollbackReport, setRollbackReport] = useState<RestoreReport | null>(null)

  /** 分区显示名（与导入页同一个装配器；市场字典没有 section.* 键，显示名走 config-manager 字典） */
  const labelOf = sectionLabeler(cmT)
  const nodes = useMemo(() => marketPickerNodes(plan), [plan])
  const summary = marketSelectionSummary(plan, selection)
  const rows = marketChangeRows(plan, selection)
  const unitIndex = useMemo(() => marketUnitIndex(plan, selection), [plan, selection])
  const sectionSummaries = marketSectionSummaries(plan, selection)
  const riskSections = selectedHighRiskSections(plan, selection)
  const conflictItems = marketConflictItems(plan)
  const hasConflicts = conflictItems.length > 0
  const excludedCount = rows.filter((r) => !r.selected).length

  /**
   * 冲突决策收集器：从持久化的决策表重建（刷新后勾选与决策都不丢）。
   * 与导入向导共用 `src/ui/conflict-view.ts`，不另写一份决策模型。
   */
  const collector = useMemo(() => {
    const c = new ConflictCollector(plan)
    for (const [id, resolution] of Object.entries(resolutions)) c.resolve(id, resolution)
    return c
  }, [plan, resolutions])

  /** 有效步骤：重算计划后冲突可能消失（steps 变短），此时回落到第一步而不是渲染空白。 */
  const steps = marketReviewSteps(hasConflicts)
  const active: MarketReviewStep = steps.includes(step) ? step : 'preview'
  const stepIndex = steps.indexOf(active)
  const stepperSteps = steps.map((s, i) => ({
    key: s,
    label: t(STEP_LABEL[s]),
    state: (i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo') as 'done' | 'current' | 'todo',
  }))
  const visibleNodes = useMemo(
    () => filterPickerNodes(nodes, unitIndex, filter),
    [nodes, unitIndex, filter],
  )
  const filterItems = [
    { id: 'all', label: t('review.filter.all'), count: nodes.reduce((n, node) => n + node.units.length, 0) },
    { id: 'willChange', label: t('review.filter.willChange'), count: filterPickerNodes(nodes, unitIndex, 'willChange').reduce((n, node) => n + node.units.length, 0) },
    { id: 'highRisk', label: t('review.filter.highRisk'), count: filterPickerNodes(nodes, unitIndex, 'highRisk').reduce((n, node) => n + node.units.length, 0) },
    { id: 'unselected', label: t('review.filter.unselected'), count: filterPickerNodes(nodes, unitIndex, 'unselected').reduce((n, node) => n + node.units.length, 0) },
  ]

  const go = (next: MarketReviewStep): void => {
    setNoSelectionHint(false)
    setStep(next)
  }

  const applyResolutions = (): void => {
    onResolutionsChange(collector.toResolutions())
  }

  /** 执行导入：用最终决策重算计划（与 Dry Run 同一路径）→ 按当前勾选裁剪 → 执行。 */
  const runImport = async (): Promise<void> => {
    if (!summary.canImport) {
      setNoSelectionHint(true)
      return
    }
    setNoSelectionHint(false)
    onErrorChange(null)
    onImportingChange(true)
    try {
      const fresh = await importApi.createImportPlan(zipPath, marketDecisions(resolutions))
      onPlanChange(fresh)
      const sub = buildSelectedPlan(fresh, selection)
      const executed = await importApi.executeImportPlan(zipPath, sub, { confirm: true, rollbackOnError: true })
      onResultChange(executed)
      setStep('result')
      const okCount = executed.executed.filter((e) => e.status === 'ok').length
      const failedCount = executed.executed.filter((e) => e.status === 'failed').length
      const restartSuffix = executed.needsRestart ? ' · ' + t('import.needsRestart') : ''
      if (executed.ok) toast.ok(t('import.done', { count: String(okCount) }) + restartSuffix)
      else toast.error(t('import.failed', { count: String(failedCount) }) + restartSuffix)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onErrorChange(message)
      toast.error(redact(message))
    } finally {
      onImportingChange(false)
    }
  }

  /** 回滚到本次导入前的快照（引擎在 executeImportPlan 第一步创建，id 随结果回传）。 */
  const runRollback = async (snapshotId: string): Promise<void> => {
    setRollbackOpen(false)
    runStore.watchRunning('restore', 500)
    try {
      const res = await importApi.restoreSnapshot(snapshotId, false)
      setRollbackReport(res.report ?? null)
      toast.ok(t('review.rollbackDone'))
    } catch (err) {
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    } finally {
      runStore.stopRunWatch('restore')
    }
  }

  /** 计数徽章行（预览步与确认步共用同一份口径）。 */
  const countBadges = (
    <div className={css.statRow}>
      <Badge kind="info">{t('review.changeCount', { selected: String(summary.selected), total: String(summary.total) })}</Badge>
      {summary.willChange > 0 && <Badge kind="info">{t('review.changeWillChange', { count: String(summary.willChange) })}</Badge>}
      {summary.unchanged > 0 && <Badge kind="ok">{t('review.changeUnchanged', { count: String(summary.unchanged) })}</Badge>}
      {summary.conflicts > 0 && <Badge kind="error">{t('detail.impact.conflicts', { count: String(summary.conflicts) })}</Badge>}
      {excludedCount > 0 && <Badge kind="info">{t('review.excludedCount', { count: String(excludedCount) })}</Badge>}
      {plan.needsRestart && <Badge kind="warn">{t('import.needsRestart')}</Badge>}
    </div>
  )

  /**
   * 分区级小结（逐项摘要降维；确认步只列还有勾选项的分区）。
   *
   * 卡片之间的间距由容器 `.conflictList` 的 `gap: 8px` 提供 —— 直接并排 `.conflictItem`
   * 是没有间距的（`.conflictItem` 自己不带上外边距），与冲突卡保持同一套行间节奏。
   */
  const renderSectionRows = (onlySelected: boolean): ReactNode => (
    <div className={css.conflictList}>
      {sectionSummaries
        .filter((s) => !onlySelected || s.selectedUnits > 0 || s.totalUnits === 0)
        .map((s) => (
          <div key={s.section} className={css.conflictItem}>
            <div className={css.conflictHead}>
              <span className={css.kindTag}>{labelOf(s.section)}</span>
              <span className={css.pickerCount}>
                {t('review.sectionUnits', { selected: String(s.selectedUnits), total: String(s.totalUnits) })}
              </span>
              {s.willChange > 0 && <Badge kind="info">{t('review.changeWillChange', { count: String(s.willChange) })}</Badge>}
              {s.unchanged > 0 && <Badge kind="ok">{t('review.changeUnchanged', { count: String(s.unchanged) })}</Badge>}
              {s.highRisk && <Badge kind="warn">{cmT('picker.highRisk')}</Badge>}
            </div>
          </div>
        ))}
    </div>
  )

  /** 单元行徽章（树内表达「会不会写盘」；与筛选共用同一份 unitIndex 判定）。 */
  const unitBadge = (section: SectionId, unitId: string): ReactNode => {
    const info = unitIndex.get(unitId)
    if (info === undefined) return null
    if (!info.selected) return <Badge kind="info">{t('review.rowExcluded')}</Badge>
    if (info.willChange > 0) return <Badge kind="info">{t('review.rowWillChange')}</Badge>
    return <Badge kind="ok">{t('review.rowUnchanged')}</Badge>
  }

  return (
    <div className={css.marketReviewPage}>
      <div className={css.wizardStepperRow}>
        <Stepper
          steps={stepperSteps}
          ariaLabel={t('review.stepAria', { current: String(stepIndex + 1), total: String(steps.length) })}
        />
      </div>

      {active === 'preview' && (
        <>
          <div className={css.marketReviewScroll}>
            {riskSections.length > 0 && (
              <Banner kind="warn">
                {t('review.highRiskHint', { sections: riskSections.map(labelOf).join(' / ') })}
              </Banner>
            )}
            {countBadges}
            <span className={css.groupLabel}>{t('review.changeTitle')}</span>
            {sectionSummaries.length === 0
              ? <div className={css.hint}>{t('review.changeEmpty')}</div>
              : renderSectionRows(false)}
          </div>
          <div className={css.actionRow}>
            <Button onClick={() => { go('select') }}>{t('review.nextSelect')}</Button>
          </div>
        </>
      )}

      {active === 'select' && (
        <>
          <Segmented
            items={filterItems}
            active={filter}
            onChange={(id) => { setFilter(id as MarketPickerFilter) }}
            ariaLabel={t('review.filterAria')}
          />
          {visibleNodes.length === 0
            ? <div className={css.hint}>{t('review.filterEmpty')}</div>
            : (
              <ContentPicker
                nodes={visibleNodes}
                value={selection}
                onChange={onSelectionChange}
                t={cmT}
                sectionLabel={labelOf}
                mode="import"
                highRisk={isHighRiskAdapter}
                unitBadge={unitBadge}
              />
            )}
          <div className={css.actionRow}>
            <Button onClick={() => { go(prevMarketStep(active, hasConflicts)) }}>{t('review.back')}</Button>
            <Button variant="primary" onClick={() => { go(nextMarketStep(active, hasConflicts)) }}>{t('review.next')}</Button>
          </div>
        </>
      )}

      {active === 'conflicts' && (
        <>
          <div className={css.marketReviewScroll}>
            <Banner kind="warn">{t('review.conflictHint', { count: String(conflictItems.length) })}</Banner>
            <ConflictList collector={collector} t={cmT} onChanged={applyResolutions} />
          </div>
          <div className={css.actionRow}>
            <Button onClick={() => { go(prevMarketStep(active, hasConflicts)) }}>{t('review.back')}</Button>
            <Button variant="primary" onClick={() => { go(nextMarketStep(active, hasConflicts)) }}>{t('review.next')}</Button>
          </div>
        </>
      )}

      {active === 'confirm' && (
        <>
          <div className={css.marketReviewScroll}>
            <span className={css.groupLabel}>{t('review.confirmTitle')}</span>
            {countBadges}
            {renderSectionRows(true)}
            <Banner kind="info">{t('review.confirmHint')}</Banner>
          </div>
          {noSelectionHint && !summary.canImport && <Banner kind="error">{t('review.nothingSelected')}</Banner>}
          <div className={css.actionRow}>
            <Button onClick={() => { go(prevMarketStep(active, hasConflicts)) }}>{t('review.back')}</Button>
            <Button
              variant="primary"
              disabled={importing || !summary.canImport}
              onClick={() => { void runImport() }}
            >
              {importing ? <Spinner label={t('common.loading')} /> : t('detail.import')}
            </Button>
          </div>
        </>
      )}

      {active === 'result' && (
        <>
          <div className={css.marketReviewScroll}>
            <span className={css.groupLabel}>{t('review.resultTitle')}</span>
            {result === null
              ? <div className={css.hint}>{t('review.changeEmpty')}</div>
              : (
                <>
                  {(() => {
                    const okCount = result.executed.filter((e) => e.status === 'ok').length
                    const failedCount = result.executed.filter((e) => e.status === 'failed').length
                    return (
                      <div className={css.statRow}>
                        <Badge kind={result.ok ? 'ok' : 'error'}>
                          {result.ok
                            ? t('review.resultOk', { count: String(okCount) })
                            : t('review.resultFailed', { count: String(failedCount) })}
                        </Badge>
                        {result.needsRestart && <Badge kind="warn">{t('import.needsRestart')}</Badge>}
                      </div>
                    )
                  })()}
                  {/* 回滚入口（R4b）：快照 id 随结果回传；没有快照就如实说明，不给假入口 */}
                  <div className={css.rollbackBox}>
                    {result.snapshotId !== null ? (
                      <>
                        <Button variant="danger" size="sm" disabled={importing} onClick={() => { setRollbackOpen(true) }}>
                          {t('review.rollback')}
                        </Button>
                        <span className={css.hint}>{t('review.rollbackHint')}</span>
                      </>
                    ) : (
                      <span className={css.hint}>{t('review.snapshotMissing')}</span>
                    )}
                  </div>
                  {rollbackReport !== null && (
                    <>
                      <div className={css.groupLabel}>{t('review.rollbackReport')}</div>
                      <ul className={css.warnList}>
                        <li>{t('review.rollbackRestored', { count: String(rollbackReport.restored.length) })}</li>
                        <li>{t('review.rollbackRemovedPlugins', { count: String(rollbackReport.removedPlugins.length) })}</li>
                        {rollbackReport.failed.length > 0 && (
                          <li className={css.warnText}>{t('review.rollbackFailed', { count: String(rollbackReport.failed.length) })}</li>
                        )}
                        {rollbackReport.manualHints.length > 0 && (
                          <li className={css.warnText}>{t('review.rollbackManual', { count: String(rollbackReport.manualHints.length) })}</li>
                        )}
                      </ul>
                    </>
                  )}
                </>
              )}
          </div>
          <div className={css.actionRow}>
            <Button onClick={() => { go('select') }}>{t('review.reviewAgain')}</Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={rollbackOpen}
        danger
        title={t('review.rollbackConfirmTitle')}
        // itemName 来自市场条目 manifest（外部文本）→ 渲染前过 redact（§7 安全不变量）
        message={t('review.rollbackConfirmMessage', { item: redact(itemName), id: result?.snapshotId ?? '' })}
        confirmLabel={t('review.rollbackConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => { const id = result?.snapshotId; if (id !== undefined && id !== null) return runRollback(id) }}
        onCancel={() => { setRollbackOpen(false) }}
      />
    </div>
  )
}
