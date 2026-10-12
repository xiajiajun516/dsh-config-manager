/**
 * 导入九步向导（规范 §9 / §10 / §28，绑 src/ui/import-wizard.ts 的 ImportWizard 控制器）。
 *
 * 步骤（对齐 ui/types.ts 的 ImportStep）：
 *   Select ZIP → Analyzing → Compatibility → Preview
 *   → Resolve Conflicts（若有）→ Path Mapping（若有）→ Secrets 补录（若有）
 *   → Confirm → Importing → Result
 *
 * 安全/正确性约束（来自 ImportWizard 与 core）：
 *   - analyzeImport / createImportPlan 零写入（Dry Run 复用）；
 *   - executeImportPlan 必须 confirm=true（core 安全阀）；
 *   - 秘密补录值仅内存（secretInputs），经 HTTPS 请求体传给 Host，绝不落日志/落盘，
 *     **也绝不进入 sessionStorage**（m2 白名单剔除，刷新后 secrets 阶段要求重输）；
 *   - 默认整体回滚（rollbackOnError=true），用户在 Confirm 步可切换；
 *   - 整体加密容器（DCA1）密码只输入一次：选完 ZIP 即进入「解锁加密备份」
 *     （decrypt-archive）输入密码，Host 解锁时顺带解出内部凭据覆盖清单（refs）；
 *     该密码同时作为解密密码交给向导，无第二个密码校验页面（decrypt-archive 回归）。
 *
 * 数据流：本地文件 → api.upload → zipPath → wizard.selectZip/confirmCompatibility/
 *   setResolutions/setPathMappings/setSecretInputs → wizard.execute。
 * 中间阶段（conflicts/path-mapping/secrets）是 UI 层流程页，wizard 的 decisions 由
 * 对应组件收集后写入。
 *
 * m2：全部 UI 状态由模块级 runStore 持有（切 tab/关面板不重建、刷新恢复），
 * 控制器实例（ImportWizard）由 store 缓存复用；每次 wizard 动作后 syncWizard()
 * 把控制器快照镜像进 store（非敏感字段持久化）。
 */
import { useSyncExternalStore } from 'react'
import { importStepperModel, importStepperSource, type ImportStageKey } from '../../ui/import-stepper.ts'
import { importNextSteps } from '../../ui/next-steps.ts'
import {
  compatibilityBadgeKind, compatibilityLevel, compatibilityNotes, importBasePathNotices, importPreviewStageAfter,
  isSkippablePluginInstall, pendingSecretRequests,
} from '../../ui/import-wizard.ts'
import { compatibilityScoreKey } from '../common/compat-label.ts'
import { pickerSummary, sectionsFromPlan, type Selection } from '../../ui/selection-model.ts'
import {
  sessionFormatSkippedItems,
  type SessionFormatDisposition,
  type SessionFormatFacts,
} from '../../ui/session-format-disposition.ts'
import type { ImportPreviewSummary } from '../../ui/types.ts'
import type { ImportAnalysis, ImportPlan, ImportResult } from '../../core/types.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore } from '../run-store.ts'
import {
  Badge, Banner, Button, Card, SectionTitle, Stepper,
} from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ErrorBanner, ErrorList } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import type { RunProgress } from '../common/progress-view.ts'
import { ReportView } from '../common/ReportView.tsx'
import { ContentPicker } from '../common/ContentPicker.tsx'
import { sectionLabel, sectionLabeler } from '../common/section-labels.ts'
import { redact } from '../../security/redaction.ts'
import { fileSelectModel, shouldRenderSelect } from './import-file-select.ts'
import {
  AnalyzingStep, ConflictsStage, ConfirmStage, ConsultStage, DecryptArchiveStep,
  PathMappingStage, SecretsStage, SelectStep, SessionFormatDispositionField,
} from './import-wizard-steps.tsx'
import { useImportWizardController } from './use-import-wizard-controller.ts'
import { ImportLogPanel } from './ImportLogPanel.tsx'
import css from '../config-manager.module.css'
export interface ImportWizardViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  uiT?: UiT; onOpenForeignImport?: () => void // 可选：外部来源入口（见 SelectStep.foreignEntry）
}

/* 兼容性等级 → 字典键的映射统一在 ../common/compat-label.ts（同步确认页共用同一份，
 *  此前同步页直接渲染裸枚举 partial/excellent —— 那是给开发者看的机器 token）。 */


/**
 * 导入/同步后收尾清单（P0-① / P2-⑪，绑 src/ui/next-steps.ts 的 importNextSteps 纯函数）。
 * - 待重启项（Install 插件 / mcp 变更 → 重启 DSH 生效，逐项列出 id + 摘要）；
 * - 补录凭据（ref 名清单，非值；无值展示，安全不变量不破）；
 * - 失败/跳过项（count 传达「可重试」，明细仍在 ReportView 内联报告里）。
 * 三组均无内容 → 显示「全部完成」ok Banner（替代旧版单行 needsRestart 提示）。
 */
function NextStepsCard({ plan, result, t }: {
  plan: ImportPlan | null
  result: ImportResult
  t: TranslateNS<'config-manager'>
}) {
  if (plan === null) {
    return result.needsRestart
      ? <Banner kind="warn">{t('report.needsRestart')}</Banner>
      : null
  }
  const steps = importNextSteps(plan, result)
  if (!steps.hasNextSteps) {
    return <Banner kind="ok">{t('nextSteps.done')}</Banner>
  }
  return (
    <Card className={css.card}>
      <div className={css.groupLabel}>{t('nextSteps.title')}</div>
      {steps.restartItems.length > 0 && (
        <div className={css.nextStepsGroup}>
          <div className={css.groupLabel}>{t('nextSteps.restart.title', { count: String(steps.restartItems.length) })}</div>
          <div className={css.hint}>{t('nextSteps.restart.hint')}</div>
          <ul className={`${css.reportList} ${css.nextStepsList}`}>
            {steps.restartItems.map((item) => (
              // description 由宿主按计划项拼装（可能含 MCP env/headers 等本地配置片段）→ 渲染前过 redact
              <li key={item.id}>{item.adapter}: {redact(item.description)}</li>
            ))}
          </ul>
        </div>
      )}
      {steps.sessionsRestart !== null && (
        <div className={css.nextStepsGroup}>
          <div className={css.groupLabel}>{t('nextSteps.sessionsRestart.title')}</div>
          <div className={css.hint}>{t('nextSteps.sessionsRestart.hint', { count: String(steps.sessionsRestart.count) })}</div>
        </div>
      )}
      {steps.missingSecrets.length > 0 && (
        <div className={css.nextStepsGroup}>
          <div className={css.groupLabel}>{t('nextSteps.secrets.title', { count: String(steps.missingSecrets.length) })}</div>
          <div className={css.hint}>{t('nextSteps.secrets.hint')}</div>
          <ul className={`${css.reportList} ${css.nextStepsList}`}>
            {steps.missingSecrets.map((ref) => <li key={ref}>{ref}</li>)}
          </ul>
        </div>
      )}
      {steps.unresolved.length > 0 && (
        <div className={css.nextStepsGroup}>
          <div className={css.groupLabel}>{t('nextSteps.unresolved.title', { count: String(steps.unresolved.length) })}</div>
          <div className={css.hint}>{t('nextSteps.unresolved.hint')}</div>
        </div>
      )}
    </Card>
  )
}

/* ---------------- 步骤视图（t45：从 ImportWizardBody 抽出；JSX 逐字保留，仅参数化） ---------------- */

/** 未选文件 / 已选待分析（step=select）：文件选择页。 */
function CompatibilityStep(props: {
  analysis: ImportAnalysis
  error: string | null
  onNext: () => void
  onReset: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const { analysis, error, onNext, onReset, apiT, t } = props
  const level = compatibilityLevel(analysis.compatibility)
  const scoreKey = compatibilityScoreKey(level)
  /** 结构化原因 → 可渲染解释项（老宿主未回传 reasons → 空数组：不编原因，只显示评分） */
  const notes = compatibilityNotes(analysis.compatibilityReasons)
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.compatibility.title')} />
      <div className={css.statRow}>
        <Badge kind={compatibilityBadgeKind(level)}>
          {t('import.compatibility.score', { score: t(scoreKey) })}
        </Badge>
        <Badge kind="info">{t('import.compatibility.sections', { count: String(analysis.sectionsInZip.length) })}</Badge>
        <Badge kind="info">{t('import.compatibility.plugins', { installed: String(analysis.pluginSummary.installed), toInstall: String(analysis.pluginSummary.toInstall) })}</Badge>
        {analysis.pathIssues.length > 0 && <Badge kind="warn">{t('import.compatibility.paths', { count: String(analysis.pathIssues.length) })}</Badge>}
        {analysis.secretCount > 0 && <Badge kind="warn">{t('import.compatibility.secrets', { count: String(analysis.secretCount) })}</Badge>}
        {analysis.encrypted && <Badge kind="error">🔒 {t('import.decrypt.badge')}</Badge>}
      </div>
      {analysis.warnings.length > 0 && (
        <Banner kind="warn">
          {analysis.warnings.map((w, i) => <div key={i}>{redact(w)}</div>)}
        </Banner>
      )}
      {/* 来源与判定依据（2026-09）：把「为什么是这个评分」摊开 —— 此前只有一档总分，
          用户看到「部分兼容」也不知道该处理什么。source/target 与 reasons 由 core 同源回传；
          reasons 里的平台/版本字符串来自**包内**，渲染前必须过 redact()（B1 教训）。 */}
      {(analysis.source !== undefined || notes.length > 0) && (
        <Card>
          <div className={css.groupHeader}>
            <span className={css.groupLabel}>{t('import.source.title')}</span>
            <span className={css.statusSpacer} />
          </div>
          <div className={css.statRow} style={{ flexWrap: 'wrap', gap: '8px' }}>
            {analysis.source !== undefined && (
              <Badge kind="info">
                {t('import.source.dsh', {
                  source: analysis.source.dshVersion,
                  target: analysis.target?.dshVersion ?? '?',
                })}
              </Badge>
            )}
            {analysis.source !== undefined && analysis.target !== undefined && (
              <Badge kind={analysis.source.platform === analysis.target.platform ? 'info' : 'warn'}>
                {t('import.source.platform', { source: analysis.source.platform, target: analysis.target.platform })}
              </Badge>
            )}
            {analysis.source !== undefined && (
              <Badge kind="info">{t('import.source.schema', { version: String(analysis.source.schemaVersion) })}</Badge>
            )}
          </div>
          {notes.length > 0 && (
            <>
              <div className={css.groupLabel}>{t('import.source.reasons')}</div>
              <ul className={css.reportList}>
                {notes.map((note, i) => (
                  <li key={note.key + '-' + String(i)}>{redact(t(note.key, note.params))}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {/* 备份包含的分区（两列网格；与总览「分区构成」同模式） */}
      <Card>
        <div className={css.groupHeader}>
          <span className={css.groupLabel}>{t('import.compatibility.sectionsTitle')}</span>
          <span className={css.statusSpacer} />
        </div>
        <div className={css.sectionGrid}>
          {analysis.sectionsInZip.map((s) => (
            <div key={s} className={css.sectionRow}>
              <span className={css.sectionName}>{sectionLabel(s, t)}</span>
            </div>
          ))}
        </div>
      </Card>
      {error !== null && <ErrorBanner error={error} onRetry={onNext} t={apiT} />}
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onReset}>{t('import.select.reselect')}</Button>
        <Button variant="primary" onClick={onNext}>{t('common.next')}</Button>
      </div>
    </div>
  )
}


/** 预览步第 1 页：迁移前咨询（只读结论 + 依据）。 */
function ContentSelectStage(props: {
  summary: ImportPreviewSummary
  /** 已自动重定基的基础路径（导出机 → 本机）；空 = 本次没有跨机重定基，不显示提示行 */
  rebaseNotices: { from: string; to: string }[]
  isEncrypted: boolean
  hasPlan: boolean
  nothingSelected: boolean
  selectionNodes: ReturnType<typeof sectionsFromPlan>
  selectionValue: Selection
  onSelectionChange: (next: Selection) => void
  error: string | null
  /** T1：会话格式处置（选择 / 事实 / 是否已被宿主按 abort 拦下 / 实际跳过的会话条数） */
  sessionFormatDisposition: SessionFormatDisposition
  onSessionFormatDispositionChange: (next: SessionFormatDisposition) => void
  sessionFormatFacts: SessionFormatFacts | null
  sessionFormatBlocked: boolean
  sessionFormatSkipped: number
  onNext: () => void
  /** 阻断后重新生成计划（与「下一步」同一个动作，语义不同所以按钮文案不同） */
  onRetryPlan: () => void
  onReset: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const {
    summary, rebaseNotices, isEncrypted, hasPlan, nothingSelected, selectionNodes, selectionValue, onSelectionChange,
    error, onNext, onReset, apiT, t,
    sessionFormatDisposition, onSessionFormatDispositionChange, sessionFormatFacts, sessionFormatBlocked,
    sessionFormatSkipped, onRetryPlan,
  } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.picker.title')} info={<InfoHint text={t('import.picker.hint')} label={t('common.infoHint')} />} />
      <div className={css.statRow}>
        <Badge kind={summary.willChange > 0 ? 'info' : 'ok'}>{t('import.preview.willChange', { count: String(summary.willChange) })}</Badge>
        {summary.unchanged > 0 && <Badge kind="ok">{t('import.preview.unchanged', { count: String(summary.unchanged) })}</Badge>}
        {summary.settingsUpdates > 0 && <Badge kind="info">{t('import.preview.settings', { count: String(summary.settingsUpdates) })}</Badge>}
        {summary.pluginsToInstall > 0 && <Badge kind="info">{t('import.preview.plugins', { count: String(summary.pluginsToInstall) })}</Badge>}
        {summary.mcpAdds > 0 && <Badge kind="info">{t('import.preview.mcp', { count: String(summary.mcpAdds) })}</Badge>}
        {/* UI-25：提示词维度此前漏渲染（模型 ImportPreviewSummary.prompts 与字典 import.preview.prompts 都在） */}
        {summary.prompts > 0 && <Badge kind="info">{t('import.preview.prompts', { count: String(summary.prompts) })}</Badge>}
        {summary.pathMappingsNeeded > 0 && <Badge kind="warn">{t('import.preview.paths', { count: String(summary.pathMappingsNeeded) })}</Badge>}
        {summary.secretsNeeded > 0 && !isEncrypted && <Badge kind="warn">{t('import.preview.secrets', { count: String(summary.secretsNeeded) })}</Badge>}
        {summary.conflicts > 0 && <Badge kind="error">{t('import.preview.conflicts', { count: String(summary.conflicts) })}</Badge>}
        {isEncrypted && <Badge kind="error">🔒 {t('import.decrypt.badge')}</Badge>}
      </div>
      {isEncrypted && <Banner kind="warn">{t('import.decrypt.previewHint')}</Banner>}
      {/* T1：会话格式处置 —— 本机读不了的会话必须由用户显式决定（中止 / 跳过 / 仅提示） */}
      <SessionFormatDispositionField
        disposition={sessionFormatDisposition}
        onDispositionChange={onSessionFormatDispositionChange}
        facts={sessionFormatFacts}
        blocked={sessionFormatBlocked}
        t={t}
      />
      {sessionFormatSkipped > 0 && (
        <Banner kind="info">{t('import.sessionFormat.skipped', { count: String(sessionFormatSkipped) })}</Banner>
      )}
      {/* issue #45：跨机基础路径不同时自动重定基 —— 如实告诉用户「这一步不需要手工映射」 */}
      {rebaseNotices.map((notice) => (
        <Banner key={notice.from} kind="info">
          {t('import.preview.rebase', { from: redact(notice.from), to: redact(notice.to) })}
        </Banner>
      ))}
      {summary.needsRestart && <Banner kind="warn">{t('import.preview.restart')}</Banner>}
      {error !== null && <ErrorBanner error={error} onRetry={onNext} t={apiT} />}
      {hasPlan && (
        <Card className={css.optionsCard}>
          <ContentPicker
            nodes={selectionNodes}
            value={selectionValue}
            onChange={onSelectionChange}
            t={t}
            sectionLabel={sectionLabeler(t)}
            mode="import"
          />
        </Card>
      )}
      {nothingSelected && <Banner kind="warn">{t('import.nothingSelected')}</Banner>}
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onReset}>{t('import.select.reselect')}</Button>
        {/* 阻断态下「下一步」不再是导航，而是「按新处置重新生成计划」——同一个动作，
            但按钮文案必须说清楚，否则用户会以为点了它会带着 abort 继续往下走。 */}
        <Button
          variant="primary"
          disabled={nothingSelected}
          onClick={sessionFormatBlocked ? onRetryPlan : onNext}
        >
          {sessionFormatBlocked ? t('import.sessionFormat.retryPlan') : t('common.next')}
        </Button>
      </div>
    </div>
  )
}

/** 解锁整体加密备份容器（phase=decrypt-archive）。 */
function ImportingStep(props: {
  progress: RunProgress | null
  isPluginInstall: boolean
  skipRequested: boolean
  running: boolean
  error: string | null
  errors: string[]
  onSkip: () => void
  onRetry: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const { progress, isPluginInstall, skipRequested, running, error, errors, onSkip, onRetry, apiT, t } = props
  const logLines = progress?.log ?? []
  return (
    <div className={css.viewBody}>
      <ProgressBar event={progress} active t={apiT} />
      <ImportLogPanel lines={logLines} t={t} />
      {isPluginInstall && (
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={onSkip}>
            {t('import.skipCurrent')}
          </Button>
        </div>
      )}
      {skipRequested && <div className={css.hint}>{t('import.skipPending')}</div>}
      <div className={css.hint}>{t('import.importing')}</div>
      {/* P0-8：失败后（running=false）必须给出重试入口 —— 与 ExportView 的
          ErrorBanner(onRetry) 对齐，并保留执行中不暴露重试（避免重复启动 run）。
          正常路径下向导已把 step 退回确认页（那里也有重试按钮），这里是兜底。 */}
      {error !== null && (
        <ErrorBanner
          error={error}
          onRetry={running ? undefined : onRetry}
          retrying={running}
          t={apiT}
        />
      )}
      <ErrorList errors={errors} />
    </div>
  )
}

/**
 * 结果页（step=result）：固定操作栏（完成 / 重试）+ 可滚动的正文。
 * 正文独占 `.resultScroll`、操作栏 `.resultFooter` 不参与收缩 —— 否则报告卡
 * （`overflow:hidden` 的 flex 项）被挤压后会把「完成」裁掉（用户报告）。详见 CSS 注释。
 */
function ResultStep(props: {
  result: ImportResult
  plan: ImportPlan | null
  retryable: number
  running: boolean
  excludedCount: number
  error: string | null
  onReset: () => void
  onRetry: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const { result, plan, retryable, running, excludedCount, error, onReset, onRetry, apiT, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('report.import.title')} />
      <div className={css.resultScroll}>
        {excludedCount > 0 && (
          <Banner kind="info">{t('import.excludedByUser', { count: String(excludedCount) })}</Banner>
        )}
        <ReportView
          kind="import"
          importResult={result}
          // F-01：必须显式传 t —— ReportView 的 t 是**必传** prop（类型强制；t3 已移除 zhUiT 缺省，
          // 不传即编译失败），英文界面下报告正文才不会恒为中文
          t={apiT}
          // UI-08：分区显示名只经 section-labels 的单一映射（不再让用户看见 pluginFiles 这类适配器 id）
          sectionLabel={sectionLabeler(t)}
        />
        {/* P0-①/P2-⑪：导入后收尾清单（重启生效项 / 补录凭据 / 失败可重试项），替代单行 needsRestart Banner */}
        <NextStepsCard plan={plan} result={result} t={t} />
        {/* P0-8：失败后同样给出重试入口（仅当确有可重试项，避免触发「没有可重试的项」）。
            下方操作栏的「重试」按钮已覆盖同一语义，这里让错误横幅也可直接重试。 */}
        {error !== null && (
          <ErrorBanner
            error={error}
            onRetry={!running && retryable > 0 ? onRetry : undefined}
            retrying={running}
            t={apiT}
          />
        )}
      </div>
      <div className={`${css.actionRow} ${css.resultFooter}`}>
        {retryable > 0 && (
          <Button disabled={running} onClick={onRetry}>
            {t('import.retrySkipped', { count: String(retryable) })}
          </Button>
        )}
        <span className={css.statusSpacer} />
        <Button variant="primary" onClick={onReset}>{t('import.done')}</Button>
      </div>
    </div>
  )
}

function ImportWizardBody({ api, t, uiT, onOpenForeignImport }: ImportWizardViewProps) {
  const {
    imp,
    wizard,
    step,
    phase,
    progress,
    error,
    uploading,
    running,
    rollbackOnError,
    conflictCollector,
    pathMappings,
    secretInputs,
    decryptRefs,
    isEncrypted,
    selectedPlan,
    selectionNodes,
    selectionValue,
    applicableIssues,
    excludedCount,
    nothingSelected,
    applyImportSelection,
    fileInput,
    setPhase,
    nextPhase,
    onPickFile,
    cancelPick,
    goPreview,
    enterConflicts,
    finishConflicts,
    finishPathMapping,
    finishSecrets,
    onUnlockArchive,
    execute,
    skipCurrent,
    resetWizard,
    unlocking,
    archiveUnlockError,
    setArchiveUnlockError,
    archivePassword,
    setArchivePassword,
    consultReport,
    consultLoading,
    previewStage,
    setPreviewStage,
    sessionFormatDisposition,
    setSessionFormatDisposition,
    sessionFormatFacts,
    sessionFormatBlocked,
  } = useImportWizardController(api, t)

  /**
   * T1 的「实际跳过了几条会话」：
   *  - 只认 skip 处置（guide 下用户自己取消勾选不算「被处置跳过」，不能混为一谈）；
   *  - 口径与选择模型**同源**（sessionFormatSkippedItems 逐条筛「读不了 且 被排除」），
   *    所以界面上的数字与真正没导入的条目永远一致。
   */
  const sessionFormatSkipped = sessionFormatDisposition === 'skip'
    ? sessionFormatSkippedItems(imp.plan, selectionValue).length
    : 0

  /* ---------- 各步骤渲染 ---------- */

  // decrypt-archive（解锁整体加密容器）发生在任何分析之前（step 仍可能是 select）：
  // shouldRenderSelect 保证此时渲染解锁页而非文件选择页（import-decrypt-archive-render 回归）。
  if (shouldRenderSelect(step, phase)) {
    // 换选模型：由 store 的 selectedFileName/uploading 推导（import-file-reselection）
    return (
      <SelectStep
        fileInput={fileInput}
        selectModel={fileSelectModel(imp.selectedFileName, uploading)}
        uploading={uploading}
        error={error}
        onCancel={cancelPick}
        onPickFile={(file) => { void onPickFile(file) }}
        onReset={resetWizard}
        apiT={api.t}
        t={t}
        foreignEntry={uiT !== undefined && onOpenForeignImport !== undefined ? { uiT, onOpen: onOpenForeignImport } : undefined}
      />
    )
  }

  if (step === 'analyzing') {
    return (
      <AnalyzingStep
        progress={progress}
        error={error}
        errors={imp.errors}
        onReset={resetWizard}
        apiT={api.t}
      />
    )
  }

  if (step === 'compatibility') {
    const analysis = imp.analysis
    if (analysis === null) return null
    return (
      <CompatibilityStep
        analysis={analysis}
        error={error}
        onNext={() => { void goPreview() }}
        onReset={resetWizard}
        apiT={api.t}
        t={t}
      />
    )
  }

  if (step === 'preview' && phase === 'preview') {
    /**
     * 摘要基于**裁剪后的子计划**（用户本次真的会导入的项）：徽章必须随勾选实时变化，
     * 否则「将变更 N 项」会与选择器 footer 的合计自相矛盾。路径数改用与 path-mapping
     * 阶段同一份数据（applicableIssues），不是整包的探测结果。
     */
    const summary: ImportPreviewSummary = {
      ...wizard.previewSummary(selectedPlan),
      pathMappingsNeeded: applicableIssues.length,
    }
    /**
     * 第 1 页：迁移前咨询（只读）—— 用户要求咨询**单独成页**，看完结论点「下一步」
     * 才进入「选择要导入的内容」。因此这里把咨询卡从内容选择页挪出来。
     */
    if (previewStage === 'consult') {
      return (
        <ConsultStage
          consultLoading={consultLoading}
          consultReport={consultReport}
          error={error}
          onNext={() => { setPreviewStage(importPreviewStageAfter('next', previewStage)) }}
          onReset={resetWizard}
          apiT={api.t}
          t={t}
        />
      )
    }
    return (
      <ContentSelectStage
        summary={summary}
        rebaseNotices={importBasePathNotices(imp.plan)}
        isEncrypted={isEncrypted}
        hasPlan={imp.plan !== null}
        nothingSelected={nothingSelected}
        selectionNodes={selectionNodes}
        selectionValue={selectionValue}
        onSelectionChange={applyImportSelection}
        error={error}
        sessionFormatDisposition={sessionFormatDisposition}
        onSessionFormatDispositionChange={setSessionFormatDisposition}
        sessionFormatFacts={sessionFormatFacts}
        sessionFormatBlocked={sessionFormatBlocked}
        sessionFormatSkipped={sessionFormatSkipped}
        onNext={() => {
          const next = nextPhase('preview')
          setPhase(next)
          if (next === 'conflicts') enterConflicts()
        }}
        onRetryPlan={() => { void goPreview() }}
        onReset={resetWizard}
        apiT={api.t}
        t={t}
      />
    )
  }

  // 流程阶段页只在 wizard.step === 'preview' 时渲染：execute 开始后 step 变
  // importing/result，若 phase 仍是 confirm，必须让位给导入中/结果页（否则点「导入」
  // 无反应——confirm 页一直挡着，要回退一步才露出结果）。
  // 解密容器阶段（decrypt-archive）：发生在任何分析之前（step 可能仍是 select）。
  if (phase === 'decrypt-archive') {
    return (
      <DecryptArchiveStep
        password={archivePassword}
        onPasswordChange={(next) => {
          setArchivePassword(next)
          setArchiveUnlockError(null)
        }}
        unlockError={archiveUnlockError}
        unlocking={unlocking}
        onUnlock={() => { void onUnlockArchive() }}
        onReset={resetWizard}
        apiT={api.t}
        t={t}
      />
    )
  }

  if (phase === 'conflicts' && step === 'preview') {
    if (conflictCollector === null || imp.plan === null) return null
    return (
      <ConflictsStage
        collector={conflictCollector}
        onChanged={() => {
          // 逐项决策实时持久化（非敏感），切 tab/刷新后可由 plan + 决策重建 collector
          if (imp.conflictCollector !== null) {
            runStore.patch({ import: { conflictResolutions: imp.conflictCollector.toResolutions() } })
          }
        }}
        onBack={() => { setPhase('preview') }}
        onNext={finishConflicts}
        t={t}
      />
    )
  }

  if (phase === 'path-mapping' && step === 'preview') {
    return (
      <PathMappingStage
        issues={applicableIssues}
        mappings={pathMappings}
        onMappingsChange={(mappings) => { runStore.patch({ import: { pathMappings: mappings } }) }}
        onBack={() => { setPhase('preview') }}
        onNext={finishPathMapping}
        t={t}
      />
    )
  }

  if (phase === 'secrets' && step === 'preview') {
    // 加密备份：解密已覆盖的凭据（decryptRefs）由备份密码恢复，不再要求补录
    // Phase 2：只补录**仍会导入**的凭据 —— 用户取消的插件不该再索要它的密钥
    return (
      <SecretsStage
        missing={pendingSecretRequests(selectedPlan, decryptRefs)}
        value={secretInputs}
        onValueChange={(inputs) => { runStore.patch({ import: { secretInputs: inputs } }) }}
        onBack={() => { setPhase('preview') }}
        onNext={finishSecrets}
        t={t}
      />
    )
  }

  if (phase === 'confirm' && step === 'preview') {
    /**
     * UI-14：确认页是最后一道闸门，必须能核对「将导入什么」——
     * 口径与选择器 footer **同源**（同一个 pickerSummary + 同一份 selectionNodes/selectionValue）。
     */
    return (
      <ConfirmStage
        rollbackOnError={rollbackOnError}
        onRollbackChange={(v) => {
          wizard.setRollbackOnError(v)
          runStore.patch({ import: { rollbackOnError: v } })
        }}
        isEncrypted={isEncrypted}
        decryptRefs={decryptRefs}
        summary={pickerSummary(selectionValue, selectionNodes)}
        excludedCount={excludedCount}
        running={running}
        nothingSelected={nothingSelected}
        error={error}
        sessionFormatDisposition={sessionFormatDisposition}
        onSessionFormatDispositionChange={setSessionFormatDisposition}
        sessionFormatFacts={sessionFormatFacts}
        sessionFormatBlocked={sessionFormatBlocked}
        sessionFormatSkipped={sessionFormatSkipped}
        onBack={() => { setPhase('preview') }}
        onExecute={() => { void execute() }}
        apiT={api.t}
        t={t}
      />
    )
  }

  if (step === 'importing') {
    // 执行日志与跳过按钮的判定已下沉（ui/import-wizard.ts）：
    // 跳过 = 宿主 kill 该插件子进程 + 清理半装状态 → 该项标记 user-skipped → 继续其余项。
    return (
      <ImportingStep
        progress={progress}
        isPluginInstall={isSkippablePluginInstall(progress?.detail, running, imp.skipRequested)}
        skipRequested={imp.skipRequested}
        running={running}
        error={error}
        errors={imp.errors}
        onSkip={() => { void skipCurrent() }}
        onRetry={() => { void execute() }}
        apiT={api.t}
        t={t}
      />
    )
  }

  if (step === 'result') {
    const result = imp.result
    if (result === null) return null
    // 重试：只重跑「失败 + 用户跳过」的项（ReportView 内联报告已有明细）。
    // plan 传**裁剪后的子计划**：收尾清单（需重启 / 需补录）只列本次真的导入的项 ——
    // 整份计划会让用户看到自己取消掉的分区。
    return (
      <ResultStep
        result={result}
        plan={selectedPlan}
        retryable={wizard.retryableCount()}
        running={running}
        excludedCount={excludedCount}
        error={error}
        onReset={resetWizard}
        onRetry={() => { void execute({ retry: true }) }}
        apiT={api.t}
        t={t}
      />
    )
  }

  return null
}

/* ---------- 外层包装：向导步骤条（2026-09 UX 重构） ---------- */

/** 阶段标签映射（import.stage.* 字典键；key 来自 import-stepper.ts 的 ImportStageKey）。 */
function stageLabels(t: TranslateNS<'config-manager'>): Record<ImportStageKey, string> {
  return {
    select: t('import.stage.select'),
    analyze: t('import.stage.analyze'),
    decide: t('import.stage.decide'),
    confirm: t('import.stage.confirm'),
    execute: t('import.stage.execute'),
    done: t('import.stage.done'),
  }
}

/**
 * 导入向导（外层包装）：顶部步骤条（用户视角 6 阶段：选择→分析→预览与决策→确认→执行→完成）
 * + 原向导体（ImportWizardBody 零改动）。步骤条为只读指示器：跟随 wizard.step/phase
 * 推进（映射纯函数 importStepperModel，node 单测覆盖），不提供点击跳转。
 */
export function ImportWizardView(props: ImportWizardViewProps) {
  const { t } = props
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const imp = state.import
  // 阶段输入的选择规则见 ui/import-stepper.ts（step 进 importing/result 时以 step 为准，
  // 否则执行中与完成后都会卡在「4 确认」——用户报告）
  const model = importStepperModel(importStepperSource(imp.step, imp.phase))
  const labels = stageLabels(t)
  const current = model.steps[model.index]!
  return (
    <>
      <div className={css.wizardStepperRow}>
        <Stepper
          steps={model.steps.map((s) => ({ key: s.key, label: labels[s.key], state: s.state }))}
          ariaLabel={t('import.stepper.label', {
            current: model.index + 1,
            total: model.steps.length,
            label: labels[current.key],
          })}
        />
      </div>
      <ImportWizardBody {...props} />
    </>
  )
}
