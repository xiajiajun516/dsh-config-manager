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
 *   - 秘密补录值仅内存（secretInputs），经 HTTPS 请求体传给 Host，绝不落日志/落盘；
 *   - 默认整体回滚（rollbackOnError=true），用户在 Confirm 步可切换。
 *
 * 数据流：本地文件 → api.upload → zipPath → wizard.selectZip/confirmCompatibility/
 *   setResolutions/setPathMappings/setSecretInputs → wizard.execute。
 * 中间阶段（conflicts/path-mapping/secrets）是 UI 层流程页，wizard 的 decisions 由
 * 对应组件收集后写入。
 */
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ImportWizard } from '../../ui/import-wizard.ts'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import { nextFlowPhase, type FlowPhase } from '../../ui/flow.ts'
import type { ImportPreviewSummary, ProgressEvent, WizardSnapshot } from '../../ui/types.ts'
import type { PathMapping } from '../../core/types.ts'
import type { ConfigManagerApi, UploadResponse } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner, ErrorList } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import { ConflictList } from './ConflictList.tsx'
import { PathMappingForm } from './PathMappingForm.tsx'
import css from '../config-manager.module.css'

export interface ImportWizardViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

/** 中间流程阶段（wizard.step 之外的 UI 层页面）——定义见 src/ui/flow.ts */

const SCORE_LABEL: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  partial: 'Partial',
  unsupported: 'Unsupported',
}

/** 密钥补录表单（仅内存收集，值不外泄） */
function SecretsForm({
  missing,
  t,
  onChange,
}: {
  missing: { ref: string; required: boolean }[]
  t: TranslateNS<'config-manager'>
  onChange: (inputs: Record<string, string>) => void
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const setRef = (ref: string, value: string): void => {
    const next = { ...inputs, [ref]: value }
    setInputs(next)
    onChange(next)
  }
  return (
    <div className={css.secretsList}>
      <div className={css.hint}>{t('import.secrets.hint')}</div>
      {missing.length === 0 && <Empty>No secrets required</Empty>}
      {missing.map((s) => (
        <label key={s.ref} className={css.field}>
          <span className={css.fieldLabel}>
            {s.ref} {s.required ? t('import.secrets.required') : t('import.secrets.optional')}
          </span>
          <input
            type="password"
            className={css.input}
            autoComplete="off"
            value={inputs[s.ref] ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setRef(s.ref, e.target.value) }}
          />
        </label>
      ))}
    </div>
  )
}

/**
 * 导入向导主视图。
 */
export function ImportWizardView({ api, t }: ImportWizardViewProps) {
  // ImportWizard 控制器（port=api，onProgress 桥到 React state）
  const [wizard] = useState(() => new ImportWizard({
    port: api,
    onProgress: (event) => { setProgress(event) },
    defaultRollbackOnError: true,
  }))
  const [, setTick] = useState(0)
  const refresh = (): void => { setTick((v) => v + 1) }

  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [phase, setPhase] = useState<FlowPhase>('preview')
  const [uploading, setUploading] = useState(false)
  const [rollbackOnError, setRollbackOnError] = useState(true)
  const [conflictCollector, setConflictCollector] = useState<ConflictCollector | null>(null)
  const [pathMappings, setPathMappings] = useState<PathMapping[]>([])
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({})
  const fileInput = useRef<HTMLInputElement | null>(null)

  const snapshot: WizardSnapshot = wizard.snapshot()
  const step = snapshot.step

  /* ---------- 阶段判定 ---------- */

  const hasConflicts = (snapshot.plan?.items ?? []).some((i) => i.kind === 'Conflict')
  const hasPathIssues = (snapshot.analysis?.pathIssues.length ?? 0) > 0
  const hasSecrets = (snapshot.plan?.missingSecrets.length ?? 0) > 0

  /**
   * 适用阶段的有序列表（仅含需要用户处理 + 确认页）。
   * hasConflicts/hasPathIssues/hasSecrets 基于原始 analysis/plan（Dry Run 产物），
   * 在流程中不会因已解决而重算——所以导航必须只前进（见 nextFlowPhase），
   * 而不是靠"当前阶段 != X"判定（那会让已完成阶段被重新命中、跳回上一步）。
   */
  const applicablePhases = (): FlowPhase[] => {
    const list: FlowPhase[] = []
    if (hasConflicts) list.push('conflicts')
    if (hasPathIssues) list.push('path-mapping')
    if (hasSecrets) list.push('secrets')
    list.push('confirm')
    return list
  }

  /** 从某阶段完成后进入的下一个阶段：只前进（from 不在列表时取第一项） */
  const nextPhase = (from: FlowPhase): FlowPhase => nextFlowPhase(applicablePhases(), from)

  /* ---------- 动作 ---------- */

  /** 选择并上传 ZIP → wizard.selectZip（analyzing → compatibility） */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setUploading(true)
    setError(null)
    try {
      const uploaded: UploadResponse = await api.upload(file)
      const analysis = await wizard.selectZip(uploaded.zipPath)
      void analysis
      refresh()
    } catch (err) {
      setError(err)
      refresh()
    } finally {
      setUploading(false)
    }
  }

  /** Compatibility → Preview */
  const goPreview = async (): Promise<void> => {
    setError(null)
    try {
      await wizard.confirmCompatibility()
      refresh()
    } catch (err) {
      setError(err)
      refresh()
    }
  }

  /** 进入 conflicts 阶段（先创建 collector） */
  const enterConflicts = (): void => {
    const plan = snapshot.plan
    if (plan !== null && conflictCollector === null) {
      setConflictCollector(new ConflictCollector(plan))
    }
    setPhase('conflicts')
  }

  /** Conflicts 完成：写入决策 → 下一阶段 */
  const finishConflicts = (): void => {
    if (conflictCollector !== null) wizard.setResolutions(conflictCollector.toResolutions())
    setPhase(nextPhase('conflicts'))
  }

  /** Path Mapping 完成：写入映射 → 下一阶段 */
  const finishPathMapping = (): void => {
    wizard.setPathMappings(pathMappings)
    setPhase(nextPhase('path-mapping'))
  }

  /** Secrets 完成：写入补录值 → Confirm */
  const finishSecrets = (): void => {
    wizard.setSecretInputs(secretInputs)
    setPhase('confirm')
  }

  /** Confirm 执行：confirm=true（安全阀）+ 用户回滚策略 */
  const execute = async (): Promise<void> => {
    setError(null)
    try {
      await wizard.execute({ confirm: true, rollbackOnError })
      refresh()
    } catch (err) {
      setError(err)
      refresh()
    }
  }

  /** 重置向导（重新导入） */
  const resetWizard = (): void => {
    wizard.reset()
    setError(null)
    setPhase('preview')
    setConflictCollector(null)
    setPathMappings([])
    setSecretInputs({})
    refresh()
  }

  /* ---------- 各步骤渲染 ---------- */

  if (step === 'select') {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.select.title')} subtitle={t('import.select.hint')} />
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className={css.hiddenFile}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { void onPickFile(e.target.files?.[0]) }}
        />
        <div className={css.actionRow}>
          <Button variant="primary" disabled={uploading} onClick={() => { fileInput.current?.click() }}>
            {uploading ? <Spinner label={t('import.analyzing')} /> : t('import.select.browse')}
          </Button>
        </div>
        {error !== null && <ErrorBanner error={error} onRetry={resetWizard} />}
      </div>
    )
  }

  if (step === 'analyzing') {
    return (
      <div className={css.viewBody}>
        <ProgressBar event={progress} active />
        {error !== null && <ErrorBanner error={error} onRetry={resetWizard} />}
        <ErrorList errors={snapshot.errors} />
      </div>
    )
  }

  if (step === 'compatibility') {
    const analysis = snapshot.analysis
    if (analysis === null) return null
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.compatibility.title')} />
        <div className={css.statRow}>
          <Badge kind={analysis.compatibility === 'unsupported' ? 'error' : analysis.compatibility === 'partial' ? 'warn' : 'ok'}>
            {t('import.compatibility.score', { score: SCORE_LABEL[analysis.compatibility] ?? analysis.compatibility })}
          </Badge>
          <Badge kind="info">{analysis.sectionsInZip.length} sections</Badge>
          <Badge kind="info">plugins: {analysis.pluginSummary.installed}✓ / {analysis.pluginSummary.toInstall}✗</Badge>
          {analysis.pathIssues.length > 0 && <Badge kind="warn">{analysis.pathIssues.length} paths</Badge>}
          {analysis.secretCount > 0 && <Badge kind="warn">{analysis.secretCount} secrets</Badge>}
        </div>
        {analysis.warnings.length > 0 && (
          <Banner kind="warn">
            {analysis.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </Banner>
        )}
        {error !== null && <ErrorBanner error={error} onRetry={() => { void goPreview() }} />}
        <div className={css.actionRow}>
          <Button variant="primary" onClick={() => { void goPreview() }}>{t('common.next')}</Button>
        </div>
      </div>
    )
  }

  if (step === 'preview' && phase === 'preview') {
    const summary: ImportPreviewSummary = wizard.previewSummary()
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.preview.title')} />
        <div className={css.statRow}>
          <Badge kind={summary.willChange > 0 ? 'info' : 'ok'}>{t('import.preview.willChange', { count: String(summary.willChange) })}</Badge>
          {summary.unchanged > 0 && <Badge kind="ok">{t('import.preview.unchanged', { count: String(summary.unchanged) })}</Badge>}
          {summary.settingsUpdates > 0 && <Badge kind="info">{t('import.preview.settings', { count: String(summary.settingsUpdates) })}</Badge>}
          {summary.pluginsToInstall > 0 && <Badge kind="info">{t('import.preview.plugins', { count: String(summary.pluginsToInstall) })}</Badge>}
          {summary.mcpAdds > 0 && <Badge kind="info">{t('import.preview.mcp', { count: String(summary.mcpAdds) })}</Badge>}
          {summary.pathMappingsNeeded > 0 && <Badge kind="warn">{t('import.preview.paths', { count: String(summary.pathMappingsNeeded) })}</Badge>}
          {summary.secretsNeeded > 0 && <Badge kind="warn">{t('import.preview.secrets', { count: String(summary.secretsNeeded) })}</Badge>}
          {summary.conflicts > 0 && <Badge kind="error">{t('import.preview.conflicts', { count: String(summary.conflicts) })}</Badge>}
        </div>
        {summary.needsRestart && <Banner kind="warn">{t('import.preview.restart')}</Banner>}
        {error !== null && <ErrorBanner error={error} onRetry={() => { void goPreview() }} />}
        <div className={css.actionRow}>
          <Button
            variant="primary"
            onClick={() => {
              const next = nextPhase('preview')
              setPhase(next)
              if (next === 'conflicts') enterConflicts()
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'conflicts') {
    if (conflictCollector === null || snapshot.plan === null) return null
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.conflicts.title')} subtitle={t('import.conflicts.hint')} />
        <ConflictList collector={conflictCollector} t={t} onChanged={refresh} />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" disabled={conflictCollector.hasUnresolved} onClick={finishConflicts}>
            {t('common.next')}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'path-mapping') {
    const issues = snapshot.analysis?.pathIssues ?? []
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.paths.title')} subtitle={t('import.paths.hint')} />
        <PathMappingForm issues={issues} initial={pathMappings} t={t} onChange={setPathMappings} />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" onClick={finishPathMapping}>{t('common.next')}</Button>
        </div>
      </div>
    )
  }

  if (phase === 'secrets') {
    const missing = snapshot.plan?.missingSecrets ?? []
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.secrets.title')} />
        <SecretsForm missing={missing} t={t} onChange={setSecretInputs} />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" onClick={finishSecrets}>{t('common.next')}</Button>
        </div>
      </div>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className={css.viewBody}>
        <Card className={css.optionsCard}>
          <Banner kind="info">{t('import.confirm.warning')}</Banner>
          <Checkbox
            checked={rollbackOnError}
            onChange={setRollbackOnError}
            label={t('import.rollbackOnError')}
          />
          <div className={css.actionRow}>
            <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
            <Button variant="primary" onClick={() => { void execute() }}>
              {t('import.confirm.execute')}
            </Button>
          </div>
        </Card>
        {error !== null && <ErrorBanner error={error} onRetry={() => { void execute() }} />}
      </div>
    )
  }

  if (step === 'importing') {
    return (
      <div className={css.viewBody}>
        <ProgressBar event={progress} active />
        <div className={css.hint}>{t('import.importing')}</div>
        {error !== null && <ErrorBanner error={error} />}
        <ErrorList errors={snapshot.errors} />
      </div>
    )
  }

  if (step === 'result') {
    const result = snapshot.result
    if (result === null) return null
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('report.import.title')} />
        <ReportView
          kind="import"
          importResult={result}
          onAction={(action) => {
            if (action === 'done') resetWizard()
            // fixIssues / viewDetails：报告已展示全部失败项与详情，无需额外页面
          }}
        />
        {result.needsRestart && <Banner kind="warn">{t('report.needsRestart')}</Banner>}
        {error !== null && <ErrorBanner error={error} />}
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={resetWizard}>{t('common.done')}</Button>
        </div>
      </div>
    )
  }

  return null
}
