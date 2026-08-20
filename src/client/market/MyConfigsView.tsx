/**
 * 「我的配置」视图（设计文档 docs/design/2026-08-20-my-configs-design.md §4.6）。
 *
 * 组装「一键上传 / 查看已上传 / 一键更新 / 装回本地」：
 * - **登录卡**：未登录 → GitHub device flow 登录（复用 SyncApi.githubStart/Poll/Cancel，
 *   交互与 SyncSettingsView 一致：一次性用户码 + 授权页链接 + 轮询 + 取消，定时器卸载清理）；
 *   已登录 → @login + 固定目标仓库（xiajiajun516/dsh-config-market，只读展示，无编辑入口）；
 *   token 失效（/me/status 401）→ 引导重新登录；
 * - **上传向导**：选 zip（复用 ConfigManagerApi.upload 受控临时区）→ analyzeImport 校验
 *   （内容合法 + 无密钥，零写入）→ 精简表单（仅 name/description/categories；
 *   id/author/version/updatedAt 显示「系统自动」徽章）→ meUpload 一键上传 → 结果卡
 *   （PR 链接 / 仓库链接 / sha256 / 分区）；
 * - **已上传列表**：条目卡片（字段 + 收录状态徽章：未收录 / PR 待审核[带 PR 链接] / 已收录，
 *   状态由 Host 侧判定经 itemStatusFromHost 桥接）+ 行操作：更新（预填信息进向导）/
 *   装回本地（复用市场下载 + 逐分区批准 + executeImportPlan 安全管道）/ 打开仓库。
 *
 * 渲染/校验模型全部来自 my-configs-view.ts + market-view.ts 纯函数（node 已测），本组件只装配；
 * 状态组件内自持（useState），非敏感切片（已上传列表 myItems + 错误）为**受控 props**：
 * 经 MarketPanel 的 commit/patch 统一镜像进模块级 runStore（market.myItems / myItemsError），
 * 切 tab 不丢；刷新后免重拉（与 MarketPanel 浏览态同单店镜像策略）。
 * 安全：token 只存宿主凭据槽；密码/表单无敏感字段；所有展示文本渲染前过 redact() 兜底；
 * 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { ImportResult } from '../../core/types.ts'
import type { MarketDownloadResult } from '../../market/types.ts'
import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from '../../market/github-repos.ts'
import type { MarketApi } from './market-api.ts'
import type { MyConfigsApi, MyItemEntry, MyUploadResult } from './my-configs-api.ts'
import type { SyncApi, GithubPollResponse } from '../sync/sync-api.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { redact } from '../../security/redaction.ts'
import { computeGithubLoginView, githubPollMessage } from '../sync/sync-view.ts'
import type { GithubLoginPhase } from '../sync/sync-view.ts'
import {
  autoFieldBadges, deriveLoginState, EMPTY_MY_CONFIG_FORM, itemStatusFromHost,
  myConfigFormValid, parseCategories, summarizeMyItems, toMyItemView, validateMyConfigForm,
} from './my-configs-view.ts'
import type { LoginView, MyConfigForm, MyConfigFormErrors, MeStatusData } from './my-configs-view.ts'
import {
  approvalRows, approvedAdapterSummary, buildApprovedPlan, defaultApprovals, marketDetailView,
} from './market-view.ts'
import type { MarketApprovals } from './market-view.ts'
import css from '../config-manager.module.css'

export interface MyConfigsViewProps {
  /** 我的配置 API（/me/* 端点） */
  meApi: MyConfigsApi
  /** 市场 API（装回本地：download + 校验 + dry-run） */
  api: MarketApi
  /** 主 ConfigManagerApi（upload / analyzeImport / executeImportPlan） */
  importApi: ConfigManagerApi
  /** GitHub 登录（复用 sync github device flow，同 token 槽） */
  syncApi: SyncApi
  t: TranslateNS<'config-manager-market'>
  /** 已上传条目（受控：MarketPanel 经 runStore 持有；null = 尚未加载） */
  myItems: MyItemEntry[] | null
  /** 列表加载错误（已 redact；null = 无） */
  myItemsError: string | null
  /** 列表状态上抛（MarketPanel 统一 commit/patch 镜像 runStore，切 tab 不丢） */
  onMyItemsChange: (items: MyItemEntry[] | null, error: string | null) => void
}

/* -------------------------------- GitHub device flow 状态（仅内存，token 只存宿主） */

interface GithubFlowState {
  phase: GithubLoginPhase
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  error: string | null
}

const initialGithubFlow: GithubFlowState = {
  phase: 'idle', flowId: '', userCode: '', verificationUri: '', interval: 5, error: null,
}

/** 上传/更新向导状态（一次性低频率流程，不进 sessionStorage —— 与 PublishView 同策略） */
interface WizardState {
  mode: 'upload' | 'update'
  step: 'select' | 'validate' | 'form'
  zipPath: string | null
  fileName: string | null
  validating: boolean
  validated: boolean
  validationError: string | null
  form: MyConfigForm
  formErrors: MyConfigFormErrors
  running: boolean
  result: MyUploadResult | null
  error: string | null
}

function initialWizard(mode: 'upload' | 'update'): WizardState {
  return {
    mode,
    step: 'select',
    zipPath: null,
    fileName: null,
    validating: false,
    validated: false,
    validationError: null,
    form: { ...EMPTY_MY_CONFIG_FORM },
    formErrors: { name: null },
    running: false,
    result: null,
    error: null,
  }
}

/** 装回本地（下载 + 逐分区批准 + 执行导入）状态 */
interface InstallState {
  itemId: string
  detail: MarketDownloadResult | null
  approvals: MarketApprovals
  importing: boolean
  importResult: ImportResult | null
  error: string | null
}

export function MyConfigsView({ meApi, api, importApi, syncApi, t, myItems, myItemsError, onMyItemsChange }: MyConfigsViewProps) {
  const uiT = meApi.t // 展示层翻译器（myConfigs.* 键经 UiT；同 MarketPanel 用 api.t）

  /* ---------------- 登录状态（/me/status；statusFailed=401 → token 失效） ---------------- */
  const [status, setStatus] = useState<MeStatusData | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusFailed, setStatusFailed] = useState(false)
  /* GitHub device flow（复用 sync 路由） */
  const [github, setGithub] = useState<GithubFlowState>(initialGithubFlow)
  const githubPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---------------- 已上传列表（受控：MarketPanel 持有并镜像 runStore market.myItems） ---------------- */
  const [listLoading, setListLoading] = useState(false)

  /* ---------------- 向导 / 装回本地 ---------------- */
  const [wizard, setWizard] = useState<WizardState>(() => initialWizard('upload'))
  const [install, setInstall] = useState<InstallState | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /** 读取登录态（挂载 / 登录成功 / 状态刷新），返回 status 供后续判断 */
  const loadStatus = async (): Promise<MeStatusData | null> => {
    setStatusLoading(true)
    setStatusFailed(false)
    try {
      const s = await meApi.meStatus()
      setStatus(s)
      return s
    } catch {
      setStatusFailed(true)
      return null
    } finally {
      setStatusLoading(false)
    }
  }

  /** 加载已上传列表（状态上抛 MarketPanel 镜像 runStore：切 tab 不丢 / 刷新免重拉） */
  const loadItems = async (opts: { silent?: boolean } = {}): Promise<void> => {
    if (!opts.silent) setListLoading(true)
    try {
      const res = await meApi.meItems()
      onMyItemsChange(res.items, null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onMyItemsChange(myItems, message)
    } finally {
      if (!opts.silent) setListLoading(false)
    }
  }

  // 挂载：加载登录态；已登录则顺带拉列表。卸载：清理轮询定时器。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const s = await loadStatus()
      if (!cancelled && s !== null && s.loggedIn) void loadItems({ silent: true })
    })()
    return () => {
      cancelled = true
      if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------------------------ GitHub device flow（复用 sync-view 模型） */

  const runGithubStart = async (): Promise<void> => {
    setGithub((g) => ({ ...g, phase: 'starting', error: null }))
    try {
      const info = await syncApi.githubStart()
      setGithub({
        phase: 'waiting',
        flowId: info.flowId,
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        interval: info.interval,
        error: null,
      })
      scheduleGithubPoll(info.flowId, Math.max(info.interval, 1) * 1000)
    } catch (err) {
      setGithub((g) => ({ ...g, phase: 'error', error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const scheduleGithubPoll = (flowId: string, delayMs: number): void => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    githubPollTimer.current = setTimeout(() => { void runGithubPoll(flowId) }, delayMs)
  }

  const runGithubPoll = async (flowId: string): Promise<void> => {
    setGithub((g) => ({ ...g, phase: 'polling' }))
    try {
      const poll: GithubPollResponse = await syncApi.githubPoll(flowId)
      if (poll.status === 'pending') {
        setGithub((g) => ({ ...g, phase: 'waiting' }))
        scheduleGithubPoll(flowId, poll.pollDelayMs ?? Math.max(github.interval, 1) * 1000)
        return
      }
      const message = githubPollMessage(poll, uiT)
      if (poll.status === 'success') {
        setGithub(initialGithubFlow)
        // token 已由宿主写入 credentials：刷新登录态 + 列表
        const s = await loadStatus()
        if (s !== null && s.loggedIn) void loadItems({ silent: true })
      } else {
        setGithub((g) => ({ ...g, phase: 'error', error: message }))
      }
    } catch (err) {
      setGithub((g) => ({ ...g, phase: 'error', error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const runGithubCancel = async (): Promise<void> => {
    if (githubPollTimer.current !== null) {
      clearTimeout(githubPollTimer.current)
      githubPollTimer.current = null
    }
    const flowId = github.flowId
    setGithub(initialGithubFlow)
    if (flowId !== '') {
      try { await syncApi.githubCancel(flowId) } catch { /* 取消失败无需打扰用户 */ }
    }
  }

  /* ------------------------------------------------ 上传 / 更新向导 */

  /** 步骤 1：选 zip → upload 受控临时区；upload 模式预填 name 为 zip 文件名（可改） */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setWizard((w) => ({ ...w, fileName: file.name, error: null }))
    try {
      const uploaded = await importApi.upload(file)
      setWizard((w) => ({
        ...w,
        zipPath: uploaded.zipPath,
        step: 'validate',
        /* 预填 zip 文件名（去 .zip 后缀，可改）；update 模式保留条目预填的 name */
        form: w.mode === 'upload'
          ? { ...w.form, name: file.name.replace(/\.zip$/i, '') }
          : w.form,
      }))
    } catch (err) {
      setWizard((w) => ({ ...w, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** 步骤 2：analyzeImport dry-run（零写入）—— 无密钥 + 内容合法才放行；通过后进表单 */
  const runValidate = async (): Promise<void> => {
    if (wizard.zipPath === null) return
    setWizard((w) => ({ ...w, validating: true, validationError: null }))
    try {
      const analysis = await importApi.analyzeImport(wizard.zipPath)
      if (analysis.secretCount > 0) {
        setWizard((w) => ({ ...w, validating: false, validated: false, validationError: t('myconfigs.upload.validateSecrets') }))
      } else if (!analysis.valid) {
        setWizard((w) => ({ ...w, validating: false, validated: false, validationError: t('myconfigs.upload.validateInvalid') }))
      } else {
        setWizard((w) => ({ ...w, validating: false, validated: true, step: 'form' }))
      }
    } catch (err) {
      setWizard((w) => ({
        ...w, validating: false, validated: false,
        validationError: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  /** 表单字段更新 + 实时校验（pure 模型） */
  const onFormField = (field: keyof MyConfigForm, value: string): void => {
    const next = { ...wizard.form, [field]: value }
    setWizard((w) => ({ ...w, form: next, formErrors: validateMyConfigForm(next, uiT) }))
  }

  /** 「一键上传 / 一键更新」→ meUpload / meUpdate */
  const runUpload = async (): Promise<void> => {
    if (wizard.zipPath === null) return
    const errs = validateMyConfigForm(wizard.form, uiT)
    setWizard((w) => ({ ...w, formErrors: errs }))
    if (!myConfigFormValid(errs)) return
    const categories = parseCategories(wizard.form.categories)
    const form = {
      name: wizard.form.name.trim(),
      // update 模式携带显式条目 id（后端按 id 更新，避免 name→slug 猜测失配）
      ...(wizard.mode === 'update' && wizard.form.id !== '' ? { id: wizard.form.id } : {}),
      ...(wizard.form.description.trim() !== '' ? { description: wizard.form.description.trim() } : {}),
      ...(categories.length > 0 ? { categories } : {}),
    }
    setWizard((w) => ({ ...w, running: true, error: null, result: null }))
    try {
      const result = wizard.mode === 'update'
        ? await meApi.meUpdate({ zipPath: wizard.zipPath, form })
        : await meApi.meUpload({ zipPath: wizard.zipPath, form })
      setWizard((w) => ({ ...w, running: false, result }))
      // 上传/更新成功后刷新已上传列表
      void loadItems({ silent: true })
    } catch (err) {
      setWizard((w) => ({ ...w, running: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** 行操作：更新 → 打开向导，预填条目信息（id/name/description/categories；id 供后端精确定位） */
  const startUpdate = (entry: MyItemEntry): void => {
    setWizard({
      ...initialWizard('update'),
      form: {
        id: entry.id,
        name: entry.name,
        description: entry.description ?? '',
        categories: (entry.categories ?? []).join(', '),
      },
    })
  }

  /* ------------------------------------------------ 装回本地（复用市场下载 + 逐分区批准链路） */

  /** 装回本地（复用市场下载 + 逐分区批准链路；条目内容在用户自己的公开仓库，必须带 repo 来源） */
  const runDownload = async (entry: MyItemEntry): Promise<void> => {
    setInstall({ itemId: entry.id, detail: null, approvals: {}, importing: false, importResult: null, error: null })
    try {
      const detail = await api.download(entry.id, entry.repoUrl)
      setInstall((i) => (i !== null ? { ...i, detail, approvals: defaultApprovals(detail.plan) } : i))
    } catch (err) {
      setInstall((i) => (i !== null ? { ...i, error: err instanceof Error ? err.message : String(err) } : i))
    }
  }

  const runImport = async (): Promise<void> => {
    if (install === null || install.detail === null) return
    const approvedPlan = buildApprovedPlan(install.detail.plan, install.approvals)
    if (approvedPlan.items.length === 0) {
      setInstall((i) => (i !== null ? { ...i, error: t('detail.noApproval') } : i))
      return
    }
    setInstall((i) => (i !== null ? { ...i, importing: true, error: null } : i))
    try {
      const executed = await importApi.executeImportPlan(
        install.detail.zipPath,
        approvedPlan,
        { confirm: true, rollbackOnError: true },
      )
      setInstall((i) => (i !== null ? { ...i, importing: false, importResult: executed } : i))
    } catch (err) {
      setInstall((i) => (i !== null ? { ...i, importing: false, error: err instanceof Error ? err.message : String(err) } : i))
    }
  }

  /* ------------------------------------------------ 渲染模型装配（全部纯函数） */

  /** 登录视图（loading / logged-out / logged-in / token-invalid） */
  const loginView: LoginView = deriveLoginState({
    loading: statusLoading,
    status,
    authFailed: statusFailed,
  })

  /** GitHub 登录卡渲染模型（复用 sync-view 纯函数：状态行 / 按钮态 / 展示设备码） */
  const githubView = computeGithubLoginView(github.phase, github.userCode, github.verificationUri, github.error, uiT)

  /** 已上传条目投影（Host 状态 → 徽章模型） */
  const itemViews = (myItems ?? []).map((entry) => {
    const status = itemStatusFromHost(entry)
    const view = toMyItemView(entry, status, uiT)
    return { entry, view, badge: view.badge }
  })
  const summary = summarizeMyItems(itemViews.map((v) => v.view))
  const autoBadges = autoFieldBadges(uiT)
  const targetRepo = `${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}`

  /** 设备码 + 授权页链接展示（waiting/polling 时） */
  const renderDeviceCode = (): ReactNode => (
    <div className={css.statRow}>
      <Badge kind="info">{t('myconfigs.login.userCode', { code: githubView.userCode })}</Badge>
      <a className={css.ghostButton} href={githubView.verificationUri} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
        {t('myconfigs.login.openAuth')}
      </a>
    </div>
  )

  /** 登录卡（未登录 / token 失效 → device flow；已登录 → @login + 固定目标仓库只读展示） */
  const renderLoginCard = (): ReactNode => {
    if (loginView.kind === 'loading') {
      return (
        <Card>
          <div className={css.statRow}>
            <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
            <Spinner label={t('myconfigs.login.checking')} />
          </div>
        </Card>
      )
    }
    if (loginView.kind === 'logged-out' || loginView.kind === 'token-invalid') {
      return (
        <Card>
          <div className={css.actionRow}>
            <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
            <Button variant="primary" disabled={!githubView.canStart} onClick={() => { void runGithubStart() }}>
              {githubView.startLabel}
            </Button>
            {githubView.canCancel && (
              <Button disabled={github.phase === 'starting'} onClick={() => { void runGithubCancel() }}>
                {t('myconfigs.login.cancel')}
              </Button>
            )}
          </div>
          <span className={css.hint}>{t('myconfigs.login.hint')}</span>
          {loginView.kind === 'token-invalid' && <Banner kind="warn">{t('myconfigs.error.loadStatus')}</Banner>}
          {githubView.showCode && renderDeviceCode()}
          <div className={css.statRow}>
            <Badge kind={githubView.phase === 'error' ? 'error' : 'warn'}>{githubView.statusText}</Badge>
          </div>
          {github.error !== null && <Banner kind="error">{redact(github.error)}</Banner>}
        </Card>
      )
    }
    // logged-in：@login + 固定目标仓库（只读）+ 配置仓库状态
    return (
      <Card>
        <div className={css.actionRow}>
          <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
          <Badge kind="ok">{t('myconfigs.login.loggedInAs', { login: loginView.login })}</Badge>
        </div>
        <div className={css.statRow}>
          <Badge kind="info">{t('myconfigs.login.targetRepo', { repo: targetRepo })}</Badge>
        </div>
        <div className={css.statRow}>
          {loginView.repoExists
            ? <Badge kind="ok">{t('myconfigs.login.repoReady', { repo: loginView.repoUrl })}</Badge>
            : <Badge kind="warn">{t('myconfigs.login.repoMissing')}</Badge>}
        </div>
      </Card>
    )
  }

  /** 上传 / 更新向导卡片（选 zip → 校验 → 表单 → 结果） */
  const renderWizard = (): ReactNode => {
    const reset = (): void => setWizard(initialWizard(wizard.mode))
    return (
      <Card>
        <div className={css.actionRow}>
          <span className={css.groupLabel}>
            {wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
          </span>
          {wizard.mode === 'update' && <Badge kind="info">{t('myconfigs.update.hint')}</Badge>}
        </div>

        {/* 步骤 1：选配置包 */}
        {wizard.step === 'select' && (
          <div>
            <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className={css.hiddenFile}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const picked = e.target.files?.[0]
                e.target.value = ''
                void onPickFile(picked)
              }}
            />
            <div className={css.actionRow}>
              <Button variant="primary" disabled={wizard.running} onClick={() => { fileInput.current?.click() }}>
                {t('myconfigs.upload.select')}
              </Button>
            </div>
          </div>
        )}

        {/* 步骤 2：本地校验（dry-run 零写入） */}
        {wizard.step === 'validate' && (
          <div>
            <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
            {wizard.fileName !== null && (
              <div className={css.statRow}>
                <Badge kind="info">{t('myconfigs.upload.selected', { name: wizard.fileName })}</Badge>
              </div>
            )}
            <div className={css.actionRow}>
              <Button variant="primary" disabled={wizard.zipPath === null || wizard.validating} onClick={() => { void runValidate() }}>
                {wizard.validating ? <Spinner label={t('myconfigs.upload.validating')} /> : t('myconfigs.upload.validate')}
              </Button>
              <Button disabled={wizard.validating} onClick={reset}>{t('myconfigs.upload.reselect')}</Button>
            </div>
            {wizard.validationError !== null && <Banner kind="error">{redact(wizard.validationError)}</Banner>}
          </div>
        )}

        {/* 步骤 3：精简表单（仅 name/description/categories；其余系统自动） → 上传 */}
        {wizard.step === 'form' && (
          <div>
            {wizard.validated && (
              <div className={css.statRow}>
                <Badge kind="ok">{t('myconfigs.upload.validateOk')}</Badge>
              </div>
            )}
            <Field label={t('myconfigs.upload.form.name')} hint={t('myconfigs.upload.form.nameHint')}>
              <input className={css.input} value={wizard.form.name} onChange={(e) => { onFormField('name', e.target.value) }} />
              {wizard.formErrors.name !== null && <span className={css.formError}>{redact(wizard.formErrors.name)}</span>}
            </Field>
            <Field label={t('myconfigs.upload.form.description')}>
              <textarea className={css.input} value={wizard.form.description} onChange={(e) => { onFormField('description', e.target.value) }} />
            </Field>
            <Field label={t('myconfigs.upload.form.categories')}>
              <input className={css.input} value={wizard.form.categories} onChange={(e) => { onFormField('categories', e.target.value) }} />
            </Field>
            {/* 系统自动字段（id/author/version/updatedAt 徽章，无需填写） */}
            <span className={css.hint}>{t('myconfigs.upload.form.autoHint')}</span>
            <div className={css.statRow}>
              {autoBadges.map((b) => (
                <Badge key={b.field} kind="info">{b.label}：{b.autoText}</Badge>
              ))}
            </div>
            <div className={css.actionRow}>
              <Button variant="primary" disabled={wizard.validated !== true || wizard.running || !myConfigFormValid(wizard.formErrors)} onClick={() => { void runUpload() }}>
                {wizard.running
                  ? <Spinner label={wizard.mode === 'update' ? t('myconfigs.update.running') : t('myconfigs.upload.running')} />
                  : (wizard.mode === 'update' ? t('myconfigs.update.run') : t('myconfigs.upload.run'))}
              </Button>
              <Button disabled={wizard.running} onClick={reset}>{t('myconfigs.upload.reselect')}</Button>
            </div>
          </div>
        )}

        {wizard.error !== null && <Banner kind="error">{redact(wizard.error)}</Banner>}

        {/* 结果卡：PR 链接 / 仓库链接 / sha256 / 分区 */}
        {wizard.result !== null && (
          wizard.result.ok ? (
            <div>
              <span className={css.groupLabel}>{t('myconfigs.result.title')}</span>
              <div className={css.statRow}>
                <Badge kind="ok">{t('myconfigs.result.version', { version: wizard.result.version })}</Badge>
                <Badge kind="info">{t('myconfigs.result.sha256', { hash: wizard.result.sha256 })}</Badge>
                <Badge kind="info">{t('myconfigs.result.sections', { sections: wizard.result.sections.join(', ') })}</Badge>
              </div>
              <div className={css.actionRow}>
                <Badge kind="info">{t('myconfigs.result.repo')}</Badge>
                <Button href={wizard.result.repoUrl}>{t('myconfigs.result.openRepo')}</Button>
                {wizard.result.prUrl !== null && wizard.result.prUrl !== '' && (
                  <Button href={wizard.result.prUrl}>
                    {wizard.result.prNumber !== null
                      ? t('myconfigs.result.pr', { number: String(wizard.result.prNumber) })
                      : t('myconfigs.result.openPr')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <Banner kind="error">
              {redact(wizard.result.error ?? ((wizard.result.warnings ?? []).join(' · ') || t('common.unknownError')))}
            </Banner>
          )
        )}
      </Card>
    )
  }

  /** 已上传列表（条目卡片 + 状态徽章 + 行操作） */
  const renderList = (): ReactNode => {
    return (
      <Card>
        <div className={css.actionRow}>
          <span className={css.groupLabel}>{t('myconfigs.list.title')}</span>
          <Button disabled={listLoading} onClick={() => { void loadItems() }}>
            {listLoading ? <Spinner label={t('myconfigs.list.loading')} /> : t('myconfigs.list.refresh')}
          </Button>
          {myItems !== null && (
            <Badge kind="info">
              {t('myconfigs.list.summary', {
                total: String(summary.total),
                listed: String(summary.listed),
                pending: String(summary.pendingPr),
                none: String(summary.notListed),
              })}
            </Badge>
          )}
        </div>
        {myItemsError !== null && <Banner kind="error">{redact(myItemsError)}</Banner>}
        {listLoading && myItems === null && <div className={css.statRow}><Spinner label={t('myconfigs.list.loading')} /></div>}
        {!listLoading && myItems !== null && myItems.length === 0 && <Empty>{t('myconfigs.list.empty')}</Empty>}
        {!listLoading && itemViews.length > 0 && (
          <div className={css.snapshotList}>
            {itemViews.map(({ entry, view, badge }) => (
              <div key={view.id} className={css.statRow} style={{ paddingTop: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={css.conflictHead}>
                    <span className={css.conflictId}>{view.name}</span>
                    {view.version !== '' && <Badge kind="info">{view.version}</Badge>}
                  </div>
                  <div className={css.statRow}>
                    <Badge kind={badge.kind}>{badge.text}</Badge>
                    {view.author !== '' && <Badge kind="info">{view.author}</Badge>}
                    {view.updatedAt !== '' && <Badge kind="info">{view.updatedAt}</Badge>}
                    {view.categories.map((c) => <Badge key={c} kind="info">{c}</Badge>)}
                  </div>
                </div>
                <div className={css.rowActions}>
                  <Button onClick={() => { startUpdate(entry) }}>{t('myconfigs.item.update')}</Button>
                  <Button
                    disabled={install !== null && install.itemId === view.id && install.detail === null}
                    onClick={() => { void runDownload(entry) }}
                  >
                    {t('myconfigs.item.install')}
                  </Button>
                  {entry.repoUrl !== '' && <Button href={entry.repoUrl}>{t('myconfigs.list.openRepo')}</Button>}
                  {badge.kind === 'warn' && badge.prUrl !== undefined && badge.prUrl !== '' && (
                    <Button href={badge.prUrl}>{t('myconfigs.item.openPr')}</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    )
  }

  /** 装回本地：下载 + 逐分区批准 + 执行导入（复用市场安全管道 + market-view 纯模型） */
  const renderInstall = (): ReactNode => {
    if (install === null) return null
    const { detail } = install
    const approvalList = detail !== null ? approvalRows(detail.plan, install.approvals) : []
    const approvalSummary = detail !== null ? approvedAdapterSummary(detail.plan, install.approvals) : null
    const detailView = detail !== null ? marketDetailView(detail, detail.repo ?? entryRepoUrl(install.itemId), true, uiT) : null
    return (
      <Card>
        <div className={css.actionRow}>
          <span className={css.groupLabel}>{t('detail.title')}：{install.itemId}</span>
          <Button onClick={() => { setInstall(null) }}>{t('detail.back')}</Button>
        </div>
        {install.error !== null && <Banner kind="error">{redact(install.error)}</Banner>}
        {detail === null && <div className={css.statRow}><Spinner label={t('list.loading')} /></div>}
        {detail !== null && detailView !== null && (
          <div>
            <Banner kind="warn"><strong>{t('detail.needReview')}</strong></Banner>
            <div className={css.statRow}>
              <Badge kind={detailView.badge.valid ? 'ok' : 'error'}>{detailView.badge.statusText}</Badge>
              <Badge kind="info">{detailView.badge.sectionsText}</Badge>
            </div>
            {approvalList.length > 0 && (
              <div>
                <span className={css.groupLabel}>{t('detail.approval.title')}</span>
                {approvalSummary !== null && approvalSummary.highRiskTotal > 0 && (
                  <Banner kind="warn">{t('detail.approval.highRiskHint')}</Banner>
                )}
                <div className={css.conflictList}>
                  {approvalList.map((row) => (
                    <Checkbox
                      key={row.adapter}
                      checked={row.approved}
                      onChange={(checked) => {
                        setInstall((i) => (i !== null ? { ...i, approvals: { ...i.approvals, [row.adapter]: checked } } : i))
                      }}
                      label={
                        <span>
                          <span className={css.conflictId}>{row.adapter}</span>
                          {' '}
                          <Badge kind={row.highRisk ? 'warn' : 'info'}>
                            {row.highRisk ? t('detail.approval.requiresApproval') : t('detail.approval.safe')}
                          </Badge>
                          {' '}
                          <Badge kind="info">{row.label}</Badge>
                        </span>
                      }
                    />
                  ))}
                </div>
                <div className={css.statRow}>
                  <Badge kind={approvalSummary !== null && approvalSummary.canImport ? 'ok' : 'warn'}>
                    {approvalSummary !== null
                      ? t('detail.approval.count', { selected: String(approvalSummary.selected), total: String(approvalSummary.total) })
                      : ''}
                  </Badge>
                </div>
              </div>
            )}
            <div className={css.actionRow}>
              <Button
                variant="primary"
                disabled={install.importing || (approvalSummary !== null && !approvalSummary.canImport)}
                onClick={() => { void runImport() }}
              >
                {install.importing ? <Spinner label={t('common.loading')} /> : t('detail.import')}
              </Button>
            </div>
          </div>
        )}
        {install.importResult !== null && (
          <Banner kind={install.importResult.ok ? 'ok' : 'error'}>
            {install.importResult.ok
              ? `导入完成：${install.importResult.executed.filter((e) => e.status === 'ok').length} 项写入`
              : `导入失败（${install.importResult.executed.filter((e) => e.status === 'failed').length} 项失败）`}
            {install.importResult.needsRestart && ' · 部分改动需重启 DSH 后生效'}
          </Banner>
        )}
      </Card>
    )
  }

  /** 装回本地详情展示用的仓库 URL（供应链警示来源行；取条目 repoUrl 兜底固定目标仓库） */
  function entryRepoUrl(itemId: string): string {
    const entry = (myItems ?? []).find((e) => e.id === itemId)
    return entry?.repoUrl ?? `https://github.com/${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}`
  }

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('myconfigs.tab.myconfigs')} subtitle={t('myconfigs.login.hint')} />
      {renderLoginCard()}
      {/* 已登录才允许上传 / 查看列表 / 装回本地 */}
      {loginView.kind === 'logged-in' && (
        <>
          {renderWizard()}
          {renderList()}
          {renderInstall()}
        </>
      )}
    </div>
  )
}