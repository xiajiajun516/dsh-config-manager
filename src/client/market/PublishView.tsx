/**
 * 配置市场「发布到市场」发布向导（阶段 2，docs/design/2026-08-19-market-publish-design.md §3.4）。
 *
 * 5 步流程（全部渲染/校验模型来自 src/ui/market-publish.ts 纯函数，node 已测；本组件只装配）：
 * ①选择配置包 —— 复用导出 zip（本地文件选择 → upload 受控临时区，零新增导入逻辑）；
 * ②本地校验 —— analyzeImport dry-run（零写入）：内容合法且不含密钥（secretCount===0）；
 * ③生成条目包 —— 表单（name/description/author/categories/id/repoUrl 可选）+ POST /market/prepare
 *   → 展示 manifest 文本 / SHA-256 / sections（可复制）；
 * ④推送作者仓库 —— t4 控制器生成的 git 命令模板（可复制）；插件不做任何 git 写操作、不持有凭据；
 * ⑤提交收录申请 —— index.json 追加片段（可复制）+ fork 官方仓库提 PR 指引。
 *
 * 状态策略：组件内自持（useState，不进 sessionStorage —— 发布为一次性低频率流程，同 MarketPanel 的低频面板策略）。
 * 安全：市场通道永不携带秘密（步骤 2 拒绝含密钥 zip，prepare 亦双保险拒绝 containsSecrets）；
 * 展示文本渲染前过 redact() 兜底；repoUrl 已由 validatePublishRepoUrl 拒绝 userinfo，凭据绝不拼入命令/片段。
 */
import { useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { MarketApi } from './market-api.ts'
import type { MarketPrepareResponse } from '../../market/types.ts'
import { Badge, Banner, Button, Card, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { redact } from '../../security/redaction.ts'
import {
  buildGitPushCommands, buildIndexEntrySnippet, canProceed, EMPTY_PUBLISH_FORM,
  PUBLISH_STEP_IDS, publishFormValid, publishSteps, validatePublishForm,
} from '../../ui/market-publish.ts'
import type { PublishFieldErrors, PublishFormFields } from '../../ui/market-publish.ts'
import css from '../config-manager.module.css'

export interface PublishViewProps {
  /** 市场 API（prepare：生成条目包） */
  api: MarketApi
  /** 主 ConfigManagerApi（upload / analyzeImport：文件上传与本地 dry-run 校验） */
  importApi: ConfigManagerApi
  t: TranslateNS<'config-manager-market'>
  /** 返回市场面板（关闭发布向导） */
  onBack: () => void
}

/** 最近一次复制操作的标识（成功态提示用；'<key>-fail' 表示失败） */
type CopiedState = string | null

/**
 * 发布向导（React 壳，只装配）：
 * - 步骤门控用 t4 控制器 canProceed（zipSelected / validated / prepared）；
 * - 表单校验用 validatePublishForm / publishFormValid（行内 formError）；
 * - git 命令 / index 片段文本来自 buildGitPushCommands / buildIndexEntrySnippet。
 */
export function PublishView({ api, importApi, t, onBack }: PublishViewProps) {
  const uiT = api.t // 纯渲染模型翻译器（marketPublish.* 键，src/ui/i18n.ts）
  const [stepIndex, setStepIndex] = useState(0)
  // 步骤 1：配置包（上传结果）
  const [fileName, setFileName] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [zipPath, setZipPath] = useState<string | null>(null)
  // 步骤 2：本地校验
  const [validating, setValidating] = useState(false)
  const [validated, setValidated] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  // 步骤 3：表单 + 生成
  const [form, setForm] = useState<PublishFormFields>(EMPTY_PUBLISH_FORM)
  const [formErrors, setFormErrors] = useState<PublishFieldErrors>({ itemId: null, name: null, repoUrl: null })
  const [generating, setGenerating] = useState(false)
  const [prepareResult, setPrepareResult] = useState<MarketPrepareResponse | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  // 全局错误（已 redact）
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopiedState>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const steps = publishSteps(uiT)
  const currentStep = PUBLISH_STEP_IDS[stepIndex]!
  /** t4 状态机：zipSelected / validated / prepared 推导当前步可否前进 */
  const canNext = canProceed({
    step: currentStep,
    zipSelected: zipPath !== null,
    validated,
    prepared: prepareResult !== null,
    pushAcknowledged: false,
  })

  /** 解析逗号分隔类别 → 去空白数组（空结果省略）。 */
  const parseCategories = (): string[] => form.categories.split(',').map((c) => c.trim()).filter((c) => c !== '')

  /** 步骤 1：选择 zip → upload 受控临时区（换选以最新文件为准，恒清空 input value）。 */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setUploading(true)
    setError(null)
    setValidated(false)
    setPrepareResult(null)
    try {
      const uploaded = await importApi.upload(file)
      setZipPath(uploaded.zipPath)
      setFileName(file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  /** 步骤 2：analyzeImport dry-run（零写入）—— 无密钥 + 内容合法才放行。 */
  const runValidate = async (): Promise<void> => {
    if (zipPath === null) return
    setValidating(true)
    setValidationError(null)
    try {
      const analysis = await importApi.analyzeImport(zipPath)
      if (analysis.secretCount > 0) {
        setValidated(false)
        setValidationError(t('publish.validate.secrets'))
      } else if (!analysis.valid) {
        setValidated(false)
        setValidationError(t('publish.validate.invalid'))
      } else {
        setValidated(true)
      }
    } catch (err) {
      setValidated(false)
      setValidationError(err instanceof Error ? err.message : String(err))
    } finally {
      setValidating(false)
    }
  }

  /** 步骤 3：表单字段更新 + 实时校验（t4 控制器）。 */
  const onFormField = (field: keyof PublishFormFields, value: string): void => {
    const next = { ...form, [field]: value }
    setForm(next)
    setFormErrors(validatePublishForm(next))
  }

  /** 步骤 3：POST /market/prepare 生成条目包（manifest + SHA-256 + sections）。 */
  const runGenerate = async (): Promise<void> => {
    if (zipPath === null) return
    const errs = validatePublishForm(form)
    setFormErrors(errs)
    if (!publishFormValid(errs)) return
    const categories = parseCategories()
    setGenerating(true)
    setPrepareError(null)
    try {
      const result = await api.prepare({
        zipPath,
        itemId: form.itemId,
        name: form.name,
        ...(form.version !== '' ? { version: form.version } : {}),
        ...(form.description !== '' ? { description: form.description } : {}),
        ...(form.author !== '' ? { author: form.author } : {}),
        ...(form.repoUrl !== '' ? { repoUrl: form.repoUrl } : {}),
        ...(categories.length > 0 ? { categories } : {}),
      })
      setPrepareResult(result)
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  /** 复制文本到剪贴板（失败降级提示手动选择）。 */
  const copyText = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
    } catch {
      setCopied(`${label}-fail`)
    }
  }

  /** 复制反馈徽章：成功 → ok「已复制」；失败 → warn「复制失败」。 */
  const copyBadge = (label: string) => (
    copied === label
      ? <Badge kind="ok">{t('publish.copied')}</Badge>
      : copied === `${label}-fail`
        ? <Badge kind="warn">{t('publish.copyFailed')}</Badge>
        : null
  )

  /* ------------------------------------------------ 各步骤渲染（只装配） */

  const renderSelect = () => (
    <Card>
      <span className={css.hint}>{t('publish.select.hint')}</span>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        className={css.hiddenFile}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = e.target.files?.[0]
          e.target.value = '' // 恒清空 → 同一文件可再次选择（同 import 向导）
          void onPickFile(picked)
        }}
      />
      {fileName !== null && (
        <div className={css.statRow}>
          <Badge kind="info">{t('publish.select.file', { name: fileName })}</Badge>
        </div>
      )}
      <div className={css.actionRow}>
        <Button variant="primary" disabled={uploading} onClick={() => { fileInput.current?.click() }}>
          {uploading ? <Spinner label={t('publish.select.uploading')} /> : t(fileName !== null ? 'publish.select.reselect' : 'publish.select.browse')}
        </Button>
      </div>
    </Card>
  )

  const renderValidate = () => (
    <Card>
      <span className={css.hint}>{t('publish.validate.hint')}</span>
      <div className={css.actionRow}>
        <Button variant="primary" disabled={zipPath === null || validating} onClick={() => { void runValidate() }}>
          {validating ? <Spinner label={t('publish.validate.running')} /> : (validated ? t('publish.validate.retry') : t('publish.validate.run'))}
        </Button>
      </div>
      {validated && <Badge kind="ok">{t('publish.validate.ok')}</Badge>}
      {validationError !== null && <Banner kind="error">{redact(validationError)}</Banner>}
    </Card>
  )

  const renderForm = () => (
    <Card>
      <span className={css.groupLabel}>{t('publish.form.title')}</span>
      <Field label={t('publish.form.id')} hint={t('publish.form.idHint')}>
        <input className={css.input} value={form.itemId} onChange={(e) => { onFormField('itemId', e.target.value) }} />
        {formErrors.itemId !== null && <span className={css.formError}>{redact(formErrors.itemId)}</span>}
      </Field>
      <Field label={t('publish.form.name')}>
        <input className={css.input} value={form.name} onChange={(e) => { onFormField('name', e.target.value) }} />
        {formErrors.name !== null && <span className={css.formError}>{redact(formErrors.name)}</span>}
      </Field>
      <Field label={t('publish.form.description')}>
        <textarea className={css.input} value={form.description} onChange={(e) => { onFormField('description', e.target.value) }} />
      </Field>
      <Field label={t('publish.form.author')}>
        <input className={css.input} value={form.author} onChange={(e) => { onFormField('author', e.target.value) }} />
      </Field>
      <Field label={t('publish.form.version')}>
        <input className={css.input} value={form.version} onChange={(e) => { onFormField('version', e.target.value) }} />
      </Field>
      <Field label={t('publish.form.categories')}>
        <input className={css.input} value={form.categories} onChange={(e) => { onFormField('categories', e.target.value) }} />
      </Field>
      <Field label={t('publish.form.repoUrl')} hint={t('publish.form.repoUrlHint')}>
        <input className={css.input} value={form.repoUrl} onChange={(e) => { onFormField('repoUrl', e.target.value) }} />
        {formErrors.repoUrl !== null && <span className={css.formError}>{redact(formErrors.repoUrl)}</span>}
      </Field>
      <div className={css.actionRow}>
        <Button variant="primary" disabled={generating || !publishFormValid(formErrors)} onClick={() => { void runGenerate() }}>
          {generating ? <Spinner label={t('publish.form.generating')} /> : t('publish.form.generate')}
        </Button>
      </div>
      {prepareError !== null && <Banner kind="error">{redact(prepareError)}</Banner>}
      {prepareResult !== null && (
        <div>
          <span className={css.groupLabel}>{t('publish.prepare.title')}</span>
          <Banner kind="warn">{t('publish.prepare.warnings')}</Banner>
          <div className={css.statRow}>
            <Badge kind="info">{t('publish.prepare.sha256', { hash: prepareResult.sha256 })}</Badge>
            <Badge kind="info">{t('publish.prepare.sections', { sections: prepareResult.sections.join(', ') })}</Badge>
          </div>
          <span className={css.fieldLabel}>{t('publish.prepare.manifest')}</span>
          <div className={css.actionRow}>
            <Button onClick={() => { void copyText('manifest', prepareResult.manifestText) }}>
              {t('publish.prepare.copyManifest')}
            </Button>
            {copyBadge('manifest')}
          </div>
          <pre className={css.reportText}>{redact(prepareResult.manifestText)}</pre>
          <span className={css.hint}>{t('publish.prepare.dirHint', { dir: prepareResult.dir })}</span>
        </div>
      )}
    </Card>
  )

  const renderPush = () => {
    const repoUrl = form.repoUrl.trim()
    const zipPath = prepareResult?.zipPath
    const downloadBtn = zipPath !== undefined && (
      <Button onClick={() => { window.open(api.downloadPublishUrl(zipPath), '_blank') }}>
        {t('publish.push.download')}
      </Button>
    )
    if (repoUrl === '') {
      return (
        <Card>
          <Banner kind="warn">{t('publish.push.repoMissing', { id: form.itemId })}</Banner>
          {downloadBtn !== false && <div className={css.actionRow}>{downloadBtn}</div>}
        </Card>
      )
    }
    const commands = buildGitPushCommands({ repoUrl, itemId: form.itemId, dir: 'market-items' })
    return (
      <Card>
        <span className={css.hint}>{t('publish.push.hint')}</span>
        <div className={css.actionRow}>
          {downloadBtn !== false && downloadBtn}
          <Button onClick={() => { void copyText('commands', commands.join('\n')) }}>{t('publish.push.copy')}</Button>
          {copyBadge('commands')}
        </div>
        <pre className={css.reportText}>{redact(commands.join('\n'))}</pre>
      </Card>
    )
  }

  const renderSubmit = () => {
    const repoUrl = form.repoUrl.trim()
    if (repoUrl === '') {
      return (
        <Card>
          <Banner kind="warn">{t('publish.submit.repoMissing')}</Banner>
        </Card>
      )
    }
    const categories = parseCategories()
    const snippet = buildIndexEntrySnippet({
      id: form.itemId,
      name: form.name,
      ...(form.description !== '' ? { description: form.description } : {}),
      ...(form.author !== '' ? { author: form.author } : {}),
      ...(form.version !== '' ? { version: form.version } : {}),
      updatedAt: new Date().toISOString(),
      ...(categories.length > 0 ? { categories } : {}),
      repo: repoUrl,
    })
    return (
      <Card>
        <span className={css.hint}>{t('publish.submit.hint')}</span>
        <div className={css.actionRow}>
          <Button onClick={() => { void copyText('snippet', snippet) }}>{t('publish.submit.copy')}</Button>
          {copyBadge('snippet')}
        </div>
        <span className={css.fieldLabel}>{t('publish.submit.snippet')}</span>
        <pre className={css.reportText}>{redact(snippet)}</pre>
        <span className={css.hint}>{t('publish.submit.fork', { url: 'https://github.com/xiajiajun516/dsh-config-market' })}</span>
        <span className={css.hint}>{t('publish.submit.manual')}</span>
      </Card>
    )
  }

  /* ------------------------------------------------ 装配 */

  const renderStep = (): ReactNode => {
    switch (currentStep) {
      case 'select': return renderSelect()
      case 'validate': return renderValidate()
      case 'prepare': return renderForm()
      case 'push': return renderPush()
      case 'submit': return renderSubmit()
    }
  }

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('publish.title')} subtitle={t('publish.subtitle')} />
      <div className={css.actionRow}>
        <Button onClick={onBack}>{t('publish.back')}</Button>
      </div>
      {/* 步骤指示：当前步 + 总进度（t4 控制器模型） */}
      <div className={css.statRow}>
        {steps.map((s, i) => (
          <Badge key={s.id} kind={i === stepIndex ? 'ok' : 'info'}>{`${i + 1}. ${s.title}`}</Badge>
        ))}
      </div>
      <div className={css.statRow}>
        <Badge kind="info">
          {t('publish.stepIndicator', { current: String(stepIndex + 1), total: String(PUBLISH_STEP_IDS.length), label: steps[stepIndex]?.title ?? '' })}
        </Badge>
      </div>
      {error !== null && <Banner kind="error">{redact(error)}</Banner>}
      {renderStep()}
      {/* 底部导航：上一步 / 下一步（门控 = canProceed 推导） */}
      <div className={css.actionRow}>
        {stepIndex > 0 && (
          <Button onClick={() => { setStepIndex((i) => i - 1) }}>{t('publish.prev')}</Button>
        )}
        {stepIndex < PUBLISH_STEP_IDS.length - 1 && (
          <Button variant="primary" disabled={!canNext} onClick={() => { setStepIndex((i) => i + 1) }}>
            {t('publish.next')}
          </Button>
        )}
      </div>
    </div>
  )
}
