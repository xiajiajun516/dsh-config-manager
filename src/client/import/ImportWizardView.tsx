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
 *   - 默认整体回滚（rollbackOnError=true），用户在 Confirm 步可切换。
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
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useSyncExternalStore } from 'react'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import { nextFlowPhase, type FlowPhase } from '../../ui/flow.ts'
import type { ImportPreviewSummary } from '../../ui/types.ts'
import type { ConfigManagerApi, UploadResponse } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore } from '../run-store.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner, ErrorList } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import { ConflictList } from './ConflictList.tsx'
import { PathMappingForm } from './PathMappingForm.tsx'
import {
  applyPickedFile, browseLabelKey, cancelSelection, consumePickedFile, fileSelectModel,
} from './import-file-select.ts'
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

/** 密钥补录表单（仅内存收集，值不外泄；onChange 写入 store 的仅内存字段） */
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
  // m2：状态统一来自模块级 store；控制器实例由 store 缓存复用（不重建）
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const imp = state.import
  const wizard = runStore.importWizard(api)

  const step = imp.step
  const phase = imp.phase
  const progress = imp.progress
  const error = imp.error
  const uploading = imp.uploading
  const running = imp.running
  const rollbackOnError = imp.rollbackOnError
  const conflictCollector = imp.conflictCollector
  const pathMappings = imp.pathMappings
  const secretInputs = imp.secretInputs
  const decryptPassword = imp.decryptPassword
  const decryptRefs = imp.decryptRefs
  const isEncrypted = imp.analysis?.encrypted === true
  const fileInput = useRef<HTMLInputElement | null>(null)
  /**
   * 选择代数（取消选择时递增）：作废在途的选择上传/分析，
   * 防止「取消后旧请求仍把向导推进/写错误」的竞态。
   */
  const pickGeneration = useRef(0)
  /** decrypt 阶段的本地交互状态（不持久化；密码变动即失效重验） */
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const setPhase = (next: FlowPhase): void => {
    runStore.patch({ import: { phase: next } })
  }

  /* ---------- 阶段判定 ---------- */

  const hasConflicts = (imp.plan?.items ?? []).some((i) => i.kind === 'Conflict')
  const hasPathIssues = (imp.analysis?.pathIssues.length ?? 0) > 0
  // 加密备份：解密已覆盖的凭据（decryptRefs）不需用户补录，仅剩余项进入 secrets 阶段
  const hasSecrets = (imp.plan?.missingSecrets ?? []).some((s) => !decryptRefs.includes(s.ref))

  /**
   * 适用阶段的有序列表（仅含需要用户处理 + 确认页）。
   * hasConflicts/hasPathIssues/hasSecrets 基于原始 analysis/plan（Dry Run 产物），
   * 在流程中不会因已解决而重算——所以导航必须只前进（见 nextFlowPhase），
   * 而不是靠"当前阶段 != X"判定（那会让已完成阶段被重新命中、跳回上一步）。
   * 加密备份（analysis.encrypted）恒先插入 decrypt 阶段：不解锁不得继续。
   */
  const applicablePhases = (): FlowPhase[] => {
    const list: FlowPhase[] = []
    if (isEncrypted) list.push('decrypt')
    if (hasConflicts) list.push('conflicts')
    if (hasPathIssues) list.push('path-mapping')
    if (hasSecrets) list.push('secrets')
    list.push('confirm')
    return list
  }

  /** 从某阶段完成后进入的下一个阶段：只前进（from 不在列表时取第一项） */
  const nextPhase = (from: FlowPhase): FlowPhase => nextFlowPhase(applicablePhases(), from)

  /* ---------- 动作 ---------- */

  /** 选择并上传 ZIP → wizard.selectZip（analyzing → compatibility）。
   * 换选不变式：每次选择都以最新文件为准（applyPickedFile 替换旧选择）；
   * pickGeneration 守卫作废取消后在途的旧请求。 */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const generation = pickGeneration.current
    const next = applyPickedFile(fileSelectModel(imp.selectedFileName, uploading), file)
    // 换文件：清空上一份备份的仅内存解密状态（密码/凭据覆盖清单）
    runStore.patch({
      import: {
        uploading: next.busy,
        error: null,
        selectedFileName: next.selectedName,
        decryptPassword: '',
        decryptRefs: [],
      },
    })
    try {
      const uploaded: UploadResponse = await api.upload(file)
      if (generation !== pickGeneration.current) return // 用户已取消本次选择
      const analysis = await wizard.selectZip(uploaded.zipPath)
      void analysis
      if (generation !== pickGeneration.current) return
      runStore.syncWizard()
    } catch (err) {
      if (generation !== pickGeneration.current) return
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    } finally {
      if (generation === pickGeneration.current) {
        runStore.patch({ import: { uploading: false } })
      }
    }
  }

  /** 取消当前选择：回 idle 并清空 input value（同一文件可再次选择触发 onChange）。 */
  const cancelPick = (): void => {
    pickGeneration.current += 1
    const idle = cancelSelection(fileSelectModel(imp.selectedFileName, uploading))
    runStore.patch({ import: { selectedFileName: idle.selectedName, uploading: idle.busy, error: null } })
    if (fileInput.current !== null) fileInput.current.value = ''
  }

  /** Compatibility → Preview */
  const goPreview = async (): Promise<void> => {
    runStore.patch({ import: { error: null } })
    try {
      await wizard.confirmCompatibility()
      runStore.syncWizard()
    } catch (err) {
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    }
  }

  /** 进入 conflicts 阶段（先创建 collector） */
  const enterConflicts = (): void => {
    const plan = imp.plan
    if (plan !== null && imp.conflictCollector === null) {
      runStore.patch({ import: { conflictCollector: new ConflictCollector(plan) } })
    }
    setPhase('conflicts')
  }

  /** Conflicts 完成：写入决策 → 下一阶段（决策同时持久化，切 tab/刷新可恢复） */
  const finishConflicts = (): void => {
    if (imp.conflictCollector !== null) {
      const resolutions = imp.conflictCollector.toResolutions()
      wizard.setResolutions(resolutions)
      runStore.patch({ import: { conflictResolutions: resolutions } })
    }
    setPhase(nextPhase('conflicts'))
  }

  /** Path Mapping 完成：写入映射 → 下一阶段 */
  const finishPathMapping = (): void => {
    wizard.setPathMappings(pathMappings)
    setPhase(nextPhase('path-mapping'))
  }

  /** Secrets 完成：写入补录值（仅内存）→ Confirm */
  const finishSecrets = (): void => {
    wizard.setSecretInputs(secretInputs)
    setPhase('confirm')
  }

  /** 解密阶段：验证加密备份密码（只读零写入）；成功记录解密覆盖的凭据 refs */
  const onVerifyDecrypt = async (): Promise<void> => {
    if (imp.zipPath === null) return
    setVerifying(true)
    setVerifyError(null)
    try {
      const res = await api.verifyDecrypt(imp.zipPath, decryptPassword)
      runStore.patch({ import: { decryptRefs: res.refs } })
      setVerified(true)
    } catch (err) {
      setVerified(false)
      runStore.patch({ import: { decryptRefs: [] } })
      setVerifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(false)
    }
  }

  /** 解密密码输入变化：写 store（仅内存）并使验证失效（需重新验证） */
  const onDecryptPasswordChange = (value: string): void => {
    runStore.patch({ import: { decryptPassword: value } })
    setVerified(false)
    setVerifyError(null)
  }

  /** Decrypt 完成：把密码交给向导（仅内存）→ 下一阶段（按 applicablePhases 顺序） */
  const finishDecrypt = (): void => {
    wizard.setDecryptPassword(decryptPassword)
    setPhase(nextPhase('decrypt'))
  }

  /** Confirm 执行：confirm=true（安全阀）+ 用户回滚策略 */
  const execute = async (): Promise<void> => {
    runStore.patch({ import: { error: null, running: true } })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('import', 500)
    try {
      const promise = wizard.execute({ confirm: true, rollbackOnError })
      // execute() 已同步置 step='importing'：立即镜像，保证执行期间刷新时持久化的是 importing
      runStore.syncWizard()
      const result = await promise
      // 响应含 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (result as { runId?: unknown }).runId
      runStore.patch({ import: { runId: typeof runId === 'string' ? runId : null } })
      runStore.syncWizard()
    } catch (err) {
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    } finally {
      runStore.stopRunWatch('import')
      runStore.patch({ import: { running: false } })
    }
  }

  /** 重置向导（重新导入） */
  const resetWizard = (): void => {
    pickGeneration.current += 1
    wizard.reset()
    runStore.syncWizard()
    runStore.patch({
      import: {
        phase: 'preview',
        uploading: false,
        running: false,
        progress: null,
        error: null,
        runId: null,
        selectedFileName: null,
        conflictCollector: null,
        conflictStrategy: 'merge',
        conflictResolutions: {},
        pathMappings: [],
        secretInputs: {},
        decryptPassword: '',
        decryptRefs: [],
      },
    })
  }

  /* ---------- 各步骤渲染 ---------- */

  if (step === 'select') {
    // 换选模型：由 store 的 selectedFileName/uploading 推导（import-file-reselection）
    const selectModel = fileSelectModel(imp.selectedFileName, uploading)
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.select.title')} subtitle={t('import.select.hint')} />
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className={css.hiddenFile}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            // 恒清空 input value → 同一文件再次选择也会触发 onChange（同文件换选）
            const file = consumePickedFile(e.target.files?.[0], e.target)
            void onPickFile(file)
          }}
        />
        {selectModel.selectedName !== null && (
          <div className={css.hint} data-testid="import-selected-file">
            {t('import.select.file', { name: selectModel.selectedName })}
          </div>
        )}
        <div className={css.actionRow}>
          {selectModel.selectedName !== null && (
            <Button variant="ghost" onClick={cancelPick}>
              {t('import.select.cancel')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={uploading}
            onClick={() => { fileInput.current?.click() }}
          >
            {uploading ? <Spinner label={t('import.analyzing')} /> : t(browseLabelKey(selectModel.selectedName !== null))}
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
        <ErrorList errors={imp.errors} />
      </div>
    )
  }

  if (step === 'compatibility') {
    const analysis = imp.analysis
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
          {analysis.encrypted && <Badge kind="error">🔒 {t('import.decrypt.badge')}</Badge>}
        </div>
        {analysis.warnings.length > 0 && (
          <Banner kind="warn">
            {analysis.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </Banner>
        )}
        {error !== null && <ErrorBanner error={error} onRetry={() => { void goPreview() }} />}
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={resetWizard}>{t('import.select.reselect')}</Button>
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
          {summary.secretsNeeded > 0 && !isEncrypted && <Badge kind="warn">{t('import.preview.secrets', { count: String(summary.secretsNeeded) })}</Badge>}
          {summary.conflicts > 0 && <Badge kind="error">{t('import.preview.conflicts', { count: String(summary.conflicts) })}</Badge>}
          {isEncrypted && <Badge kind="error">🔒 {t('import.decrypt.badge')}</Badge>}
        </div>
        {isEncrypted && <Banner kind="warn">{t('import.decrypt.previewHint')}</Banner>}
        {summary.needsRestart && <Banner kind="warn">{t('import.preview.restart')}</Banner>}
        {error !== null && <ErrorBanner error={error} onRetry={() => { void goPreview() }} />}
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={resetWizard}>{t('import.select.reselect')}</Button>
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

  // 流程阶段页只在 wizard.step === 'preview' 时渲染：execute 开始后 step 变
  // importing/result，若 phase 仍是 confirm，必须让位给导入中/结果页（否则点「导入」
  // 无反应——confirm 页一直挡着，要回退一步才露出结果）。
  if (phase === 'decrypt' && step === 'preview') {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.decrypt.title')} subtitle={t('import.decrypt.hint')} />
        <input
          type="password"
          className={css.input}
          autoComplete="off"
          placeholder={t('import.decrypt.passwordPlaceholder')}
          value={decryptPassword}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onDecryptPasswordChange(e.target.value) }}
        />
        {verifyError !== null && <ErrorBanner error={verifyError} />}
        {verified && (
          <Banner kind="ok">
            {t(decryptRefs.length > 0 ? 'import.decrypt.verified' : 'import.decrypt.verifiedEmpty', { count: String(decryptRefs.length) })}
          </Banner>
        )}
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          {/* 验证密码：只读零写入；密码为空或验证中不可点 */}
          <Button
            variant="ghost"
            disabled={decryptPassword === '' || verifying}
            onClick={() => { void onVerifyDecrypt() }}
          >
            {verifying ? <Spinner label={t('import.decrypt.verifying')} /> : t('import.decrypt.verify')}
          </Button>
          {/* 只有验证通过的密码才能进入后续阶段（core 同样拒绝无密码执行） */}
          <Button variant="primary" disabled={!verified || verifying} onClick={finishDecrypt}>
            {t('common.next')}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'conflicts' && step === 'preview') {
    if (conflictCollector === null || imp.plan === null) return null
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.conflicts.title')} subtitle={t('import.conflicts.hint')} />
        <ConflictList
          collector={conflictCollector}
          t={t}
          onChanged={() => {
            // 逐项决策实时持久化（非敏感），切 tab/刷新后可由 plan + 决策重建 collector
            if (imp.conflictCollector !== null) {
              runStore.patch({ import: { conflictResolutions: imp.conflictCollector.toResolutions() } })
            }
          }}
        />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" disabled={conflictCollector.hasUnresolved} onClick={finishConflicts}>
            {t('common.next')}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'path-mapping' && step === 'preview') {
    const issues = imp.analysis?.pathIssues ?? []
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.paths.title')} subtitle={t('import.paths.hint')} />
        <PathMappingForm issues={issues} initial={pathMappings} t={t} onChange={(mappings) => { runStore.patch({ import: { pathMappings: mappings } }) }} />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" onClick={finishPathMapping}>{t('common.next')}</Button>
        </div>
      </div>
    )
  }

  if (phase === 'secrets' && step === 'preview') {
    // 加密备份：解密已覆盖的凭据（decryptRefs）由备份密码恢复，不再要求补录
    const missing = (imp.plan?.missingSecrets ?? []).filter((s) => !decryptRefs.includes(s.ref))
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('import.secrets.title')} />
        <SecretsForm missing={missing} t={t} onChange={(inputs) => { runStore.patch({ import: { secretInputs: inputs } }) }} />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
          <Button variant="primary" onClick={finishSecrets}>{t('common.next')}</Button>
        </div>
      </div>
    )
  }

  if (phase === 'confirm' && step === 'preview') {
    return (
      <div className={css.viewBody}>
        <Card className={css.optionsCard}>
          <Banner kind="info">{t('import.confirm.warning')}</Banner>
          {isEncrypted && decryptRefs.length > 0 && (
            <Banner kind="ok">{t('import.confirm.encrypted', { count: String(decryptRefs.length) })}</Banner>
          )}
          <Checkbox
            checked={rollbackOnError}
            onChange={(v) => {
              wizard.setRollbackOnError(v)
              runStore.patch({ import: { rollbackOnError: v } })
            }}
            label={t('import.rollbackOnError')}
          />
          <div className={css.actionRow}>
            <Button variant="ghost" onClick={() => { setPhase('preview') }}>{t('common.back')}</Button>
            {/* m3-lock：进行中禁用「确认导入」，防止重复启动 */}
            <Button variant="primary" disabled={running} onClick={() => { void execute() }}>
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
        <ErrorList errors={imp.errors} />
      </div>
    )
  }

  if (step === 'result') {
    const result = imp.result
    if (result === null) return null
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('report.import.title')} />
        <ReportView
          kind="import"
          importResult={result}
          onAction={(action) => {
            if (action === 'done') resetWizard()
            // 报告已内联展示全部失败/警告项与回滚详情（§22/§23），无额外动作页
          }}
        />
        {result.needsRestart && <Banner kind="warn">{t('report.needsRestart')}</Banner>}
        {error !== null && <ErrorBanner error={error} />}
      </div>
    )
  }

  return null
}
