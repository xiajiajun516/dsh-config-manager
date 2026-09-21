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
import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from '../../market/upstream.ts'
import type { MarketApi } from './market-api.ts'
import type { MyConfigsApi, MyItemEntry } from './my-configs-api.ts'
import type { ListingStatusResponse } from '../../market/my-repo.ts'
import type { SyncApi, GithubPollResponse } from '../sync/sync-api.ts'
import { Badge, Banner, Button, Card, Empty, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import { computeGithubLoginView, githubPollMessage } from '../sync/sync-view.ts'
import type { GithubLoginPhase } from '../sync/sync-view.ts'
import { readDisclaimerDismissed, writeDisclaimerDismissed } from './disclaimer.ts'
import type { DisclaimerKey } from './disclaimer.ts'
import {
  autoFieldBadges, deriveLoginState, initialWizard, itemStatusFromHost,
  myConfigFormValid, parseCategories, restoreMyInstall, restoreMyWizard, summarizeMyItems,
  toMyInstallSlice, toMyItemView, toMyWizardSlice, validateMyConfigForm,
} from './my-configs-view.ts'
import type {
  LoginView, MyConfigForm, MeStatusData, MyInstallSlice, MyInstallState, MyWizardSlice, MyWizardState,
} from './my-configs-view.ts'
import {
  marketDetailView,
} from './market-view.ts'
import { effectiveImportSelection, type Selection } from '../../ui/selection-model.ts'
import { MarketImportReview } from './MarketImportReview.tsx'
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
  /** config-manager 字典（级联树 / 分区显示名 / 冲突决策列表；与 MarketPanel 同一份） */
  cmT: TranslateNS<'config-manager'>
  /** 已上传条目（受控：MarketPanel 经 runStore 持有；null = 尚未加载） */
  myItems: MyItemEntry[] | null
  /** 列表加载错误（已 redact；null = 无） */
  myItemsError: string | null
  /** 列表状态上抛（MarketPanel 统一 commit/patch 镜像 runStore，切 tab 不丢） */
  onMyItemsChange: (items: MyItemEntry[] | null, error: string | null) => void
  /** 上传/更新向导持久化切片（受控：MarketPanel 经 runStore 持有；null = 未开始） */
  myWizard: MyWizardSlice | null
  /** 向导切片上抛（MarketPanel 统一 commit/patch 镜像 runStore，切 tab/刷新不丢） */
  onMyWizardChange: (wizard: MyWizardSlice | null) => void
  /** 装回本地（下载+逐分区批准+导入结果）持久化切片（受控：MarketPanel 经 runStore 持有；null = 未开始/已关闭） */
  myInstall: MyInstallSlice | null
  /** 装回本地切片上抛（MarketPanel 统一 commit/patch 镜像 runStore，切 tab/刷新不丢） */
  onMyInstallChange: (install: MyInstallSlice | null) => void
  /** 删除确认弹窗目标条目 id（受控：MarketPanel 经 runStore 持有；null = 无确认中的删除） */
  myConfirmDeleteId: string | null
  /** 删除确认态上抛（MarketPanel 统一 commit/patch 镜像 runStore，切 tab/刷新不丢） */
  onMyConfirmDeleteChange: (id: string | null) => void
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

/**
 * 上传/更新向导状态（全量模型在 my-configs-view.ts 的 MyWizardState；本组件持有的是
 * 持久化切片 myWizard（受控 props），经 restoreMyWizard 恢复全量、toMyWizardSlice 上抛镜像。
 * 瞬态（validating/running/formErrors）由 restore 重建，切 tab/刷新恢复后为初始态。
 * 装回本地状态（MyInstallState）同模式：持久化切片 myInstall（受控 props），
 * 经 restoreMyInstall 恢复全量（importing 瞬态归零）、toMyInstallSlice 上抛镜像。
 */

export function MyConfigsView({
  meApi, api, importApi, syncApi, t, cmT, myItems, myItemsError, onMyItemsChange, myWizard, onMyWizardChange,
  myInstall, onMyInstallChange, myConfirmDeleteId, onMyConfirmDeleteChange,
}: MyConfigsViewProps) {
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

  /* ---------------- 向导（受控：切片来自 runStore；瞬态本地重建）/ 装回本地 / 删除 ---------------- */
  const [wizard, setWizard] = useState<MyWizardState>(() => restoreMyWizard(myWizard))
  /** 最近一次 wizard 全量（commitWizard 读最新值，避免闭包过期） */
  const wizardRef = useRef<MyWizardState>(wizard)
  /** 收录/下架任务状态（结果卡轮询 /me/listing 的实时结果） */
  const [listingStatus, setListingStatus] = useState<ListingStatusResponse | null>(null)
  /** 收录/下架任务轮询定时器 */
  const listingPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 删除确认弹窗目标条目 id（受控：MarketPanel 经 runStore 持有，切 tab/刷新不丢；null = 无确认中的删除） */
  const confirmDeleteId = myConfirmDeleteId
  /** 正在删除的条目 id（行级 spinner + 防重复点击） */
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /** 装回本地状态（受控：切片来自 runStore；瞬态 importing 本地重建） */
  const [install, setInstall] = useState<MyInstallState | null>(() => restoreMyInstall(myInstall))
  /** 最近一次 install 全量（commitInstall 读最新值，避免闭包过期） */
  const installRef = useRef<MyInstallState | null>(install)
  const fileInput = useRef<HTMLInputElement>(null)

  /* ---------------- 交互：上传向导弹窗 + 装回本地向导页 + 免责前置 ---------------- */
  /** 上传/更新向导弹窗开关（瞬态 UI，不持久化：切 tab 弹窗关闭，数据仍在 runStore） */
  const [uploadOpen, setUploadOpen] = useState(false)
  /** 是否在「装回本地向导页」（瞬态 UI；P2 起它是**页面**，不再是弹窗） */
  const [installOpen, setInstallOpen] = useState(false)
  /** 当前展示的免责弹窗操作（null = 无；upload/download/install 三操作分开记「不再提示」） */
  const [disclaimerKey, setDisclaimerKey] = useState<DisclaimerKey | null>(null)
  /** 免责弹窗「不再提示」勾选（每次打开重置） */
  const [dontAsk, setDontAsk] = useState(false)
  /** localStorage（浏览器环境；免责「不再提示」跨会话持久化） */
  const storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage

  /** 打开上传/更新弹窗（更新模式表单已预填）：未勾「不再提示」→ 先弹免责，确认后开弹窗 */
  const openUpload = (): void => {
    if (readDisclaimerDismissed('upload', storage)) {
      setUploadOpen(true)
      return
    }
    setDontAsk(false)
    setDisclaimerKey('upload')
  }
  /** 待装回本地的目标条目（免责确认后取用；避免免责流程中闭包过期） */
  const pendingInstallEntry = useRef<MyItemEntry | null>(null)
  /** 打开装回本地向导页：未勾「不再提示」→ 先弹免责，确认后进入向导页并启动下载 */
  const openInstall = (entry: MyItemEntry): void => {
    pendingInstallEntry.current = entry
    if (readDisclaimerDismissed('install', storage)) {
      setInstallOpen(true)
      void runDownload(entry)
      return
    }
    setDontAsk(false)
    setDisclaimerKey('install')
  }
  /** 关闭上传/更新弹窗：重置向导为初始态（弹窗即会话，关闭即放弃本次操作；
   *  更新模式也切回「一键上传」入口，避免入口按钮残留 update 态） */
  const closeUpload = (): void => {
    setUploadOpen(false)
    commitWizard(initialWizard('upload'))
    setListingStatus(null)
  }
  /** 取消更新：放弃本次更新，向导回到默认「一键上传」初始态（清空预填/暂存/校验态），弹窗保持打开 */
  const cancelUpdate = (): void => {
    commitWizard(initialWizard('upload'))
    setListingStatus(null)
  }
  /** 返回已上传列表：清 install 会话 */
  const closeInstall = (): void => {
    setInstallOpen(false)
    commitInstall(null)
  }
  /** 免责弹窗确认：勾选则记录「不再提示」→ 关闭免责 → 打开对应操作弹窗 */
  const confirmDisclaimer = (): void => {
    const key = disclaimerKey
    if (key === null) return
    if (dontAsk) writeDisclaimerDismissed(key, storage)
    setDisclaimerKey(null)
    if (key === 'upload') {
      setUploadOpen(true)
    } else if (key === 'install') {
      const entry = pendingInstallEntry.current
      setInstallOpen(true)
      if (entry !== null && entry !== undefined) void runDownload(entry)
    }
  }
  /** 取消免责弹窗：关闭，不打开操作弹窗；若向导处于 update 残留态则重置为上传初始态 */
  const cancelDisclaimer = (): void => {
    setDisclaimerKey(null)
    if (disclaimerKey === 'upload' && wizardRef.current.mode === 'update') {
      commitWizard(initialWizard('upload'))
      setListingStatus(null)
    }
  }
  /** 免责弹窗文案（MyConfigsView 只触发 upload / install 两种；default 兜底返回空串防误显） */
  const disclaimerText = (): string => {
    switch (disclaimerKey) {
      case 'upload': return t('disclaimer.upload.text')
      case 'install': return t('disclaimer.install.text')
      default: return ''
    }
  }

  /**
   * 向导状态统一提交：更新 ref → setState → **总是**镜像切片上抛（MarketPanel 落 runStore）。
   * 镜像不依赖 effect flush：异步回调在组件已卸载（切走 tab）时也能落库，切回恢复。
   * 镜像上抛包 try/catch：镜像失败（store 异常）绝不影响本地 UI 更新（防「点击无反应」）。
   */
  const commitWizard = (next: MyWizardState): void => {
    wizardRef.current = next
    setWizard(next)
    try {
      onMyWizardChange(toMyWizardSlice(next))
    } catch {
      // 镜像失败不影响本地状态：下轮 commit 会再尝试
    }
  }
  const patchWizard = (p: Partial<MyWizardState>): void => commitWizard({ ...wizardRef.current, ...p })

  /**
   * 装回本地状态统一提交：更新 ref → setState → **总是**镜像切片上抛（MarketPanel 落 runStore）。
   * 镜像不依赖 effect flush：异步回调在组件已卸载（切走 tab）时也能落库，切回恢复。
   */
  const commitInstall = (next: MyInstallState | null): void => {
    installRef.current = next
    setInstall(next)
    try {
      onMyInstallChange(next === null ? null : toMyInstallSlice(next))
    } catch {
      // 镜像失败不影响本地状态
    }
  }
  const patchInstall = (p: Partial<MyInstallState>): void => {
    if (installRef.current === null) return
    commitInstall({ ...installRef.current, ...p })
  }

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

  /**
   * R-18：GitHub 流程失败统一出口「落状态 + 弹全局 Toast」，取代页内 error Banner。
   * 注意文本**先 redact 再入 state**：状态行 Badge 由 computeGithubLoginView 直接把
   * `github.error` 当 statusText 透出（该纯函数不做脱敏），先脱敏才能让 Badge 与 Toast
   * 都不含敏感原文 —— 保持了原先 Banner 的 redact 安全不变量。
   */
  const failGithub = (message: string): void => {
    const safe = redact(message)
    setGithub((g) => ({ ...g, phase: 'error', error: safe }))
    toast.error(safe)
  }

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
      failGithub(err instanceof Error ? err.message : String(err))
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
        failGithub(message)
      }
    } catch (err) {
      failGithub(err instanceof Error ? err.message : String(err))
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

  /** 选 zip → upload 受控临时区；upload 模式预填 name 为 zip 文件名（可改）。
   *  两种模式选完 zip 均**自动**跑校验（analyzeImport dry-run）——通过即直接进表单，
   *  用户无需再手动点「校验」按钮；失败留在校验步骤展示错误（可重选 zip）。 */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    patchWizard({ fileName: file.name, error: null, validationError: null })
    try {
      const uploaded = await importApi.upload(file)
      const base = { zipPath: uploaded.zipPath, fileName: file.name }
      if (wizardRef.current.mode === 'update') {
        // 更新模式：留在表单页，选完新 zip 自动校验（校验通过才可一键更新）
        patchWizard({ ...base, validated: false })
        await runValidateWith(uploaded.zipPath)
      } else {
        // 上传模式：进入校验步骤后立即自动校验（validating 态短暂展示），
        // 通过后 runValidateWith 内部自动切到表单；失败停在校验步骤展示错误
        patchWizard({
          ...base,
          step: 'validate',
          /* 预填 zip 文件名（去 .zip 后缀，可改） */
          form: { ...wizardRef.current.form, name: file.name.replace(/\.zip$/i, '') },
        })
        await runValidateWith(uploaded.zipPath)
      }
    } catch (err) {
      // R-14：上传/选择失败 → 全局 Toast（原先经 wizard.error 用红色 error Banner 渲染）
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 校验指定 zipPath（选完 zip 自动调用；任何异常都落到 validationError 展示，不静默）
   *  R-15：校验不通过时**除就地 Banner 外再弹一次 Toast** —— 校验由「选完 zip」自动触发，
   *  用户未必正看着校验步骤，Toast 保证送达；位置有语义的就地 Banner 保留（指引重新选择）。 */
  const runValidateWith = async (zipPath: string): Promise<void> => {
    /** 统一出口「落校验错误 + 弹 Toast」（三条失败路径共用，避免文案重复） */
    const failValidation = (message: string): void => {
      patchWizard({ validating: false, validated: false, validationError: message })
      toast.error(redact(message))
    }
    try {
      patchWizard({ validating: true, validationError: null })
    } catch (err) {
      // 进入校验态失败（极端情况）：仍展示错误而不是无反应
      failValidation(err instanceof Error ? err.message : String(err))
      return
    }
    try {
      const analysis = await importApi.analyzeImport(zipPath)
      if (analysis.secretCount > 0) {
        failValidation(t('myconfigs.upload.validateSecrets'))
      } else if (!analysis.valid) {
        failValidation(t('myconfigs.upload.validateInvalid'))
      } else {
        // 校验通过 → 自动进入表单步骤（upload 模式从 validate 进 form；update 模式本就是 form，值相同无害）
        patchWizard({ validating: false, validated: true, validationError: null, step: 'form' })
      }
    } catch (err) {
      failValidation(err instanceof Error ? err.message : String(err))
    }
  }

  /** 表单字段更新 + 实时校验（pure 模型） */
  const onFormField = (field: keyof MyConfigForm, value: string): void => {
    const next = { ...wizardRef.current.form, [field]: value }
    patchWizard({ form: next, formErrors: validateMyConfigForm(next, uiT) })
  }

  /** 「一键上传 / 一键更新」→ meUpload / meUpdate */
  const runUpload = async (): Promise<void> => {
    const w = wizardRef.current
    const zipPath = w.zipPath
    if (zipPath === null) return
    const errs = validateMyConfigForm(w.form, uiT)
    patchWizard({ formErrors: errs })
    if (!myConfigFormValid(errs)) return
    const categories = parseCategories(w.form.categories)
    const form = {
      name: w.form.name.trim(),
      // update 模式携带显式条目 id（后端按 id 更新，避免 name→slug 猜测失配）
      ...(w.mode === 'update' && w.form.id !== '' ? { id: w.form.id } : {}),
      ...(w.form.description.trim() !== '' ? { description: w.form.description.trim() } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      // F6 发布模式：share 时携带 mode（Host prepare 走分享强制拦截）；migrate 缺省不写，向后兼容
      ...(w.form.publishMode === 'share' ? { mode: 'share' as const } : {}),
    }
    patchWizard({ running: true, error: null, result: null })
    try {
      const result = w.mode === 'update'
        ? await meApi.meUpdate({ zipPath, form })
        : await meApi.meUpload({ zipPath, form })
      commitWizard({ ...wizardRef.current, running: false, result })
      // R-19：上传/更新失败由全局 Toast 告知（结果卡的失败分支随之取消页内占位）
      if (!result.ok) {
        toast.error(redact(result.error ?? ((result.warnings ?? []).join(' · ') || t('common.unknownError'))))
      }
      // 上传/更新成功后：清空旧收录状态 + 若收录后台进行中则轮询状态 + 刷新列表
      setListingStatus(null)
      if (result.ok && result.listing === 'pending') startListingPoll(result.itemId)
      void loadItems({ silent: true })
    } catch (err) {
      // R-14：上传/更新请求失败 → 全局 Toast（原先经 wizard.error 用红色 error Banner 渲染）
      patchWizard({ running: false })
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 行操作：更新 → 打开「更新配置」表单页（step='form'，预填条目信息；表单内选新 zip 自动校验） */
  const startUpdate = (entry: MyItemEntry): void => {
    commitWizard({
      ...initialWizard('update'),
      step: 'form',
      form: {
        id: entry.id,
        name: entry.name,
        description: entry.description ?? '',
        categories: (entry.categories ?? []).join(', '),
        publishMode: 'migrate', // 更新默认迁移模式（与表单初始态一致，用户可在表单页切换）
      },
    })
    setListingStatus(null)
  }

  /* ------------------------------------------------ 收录/下架任务状态轮询 */

  /** R-16：收录任务失败 → 常驻 Toast（durationMs=0，须手动关闭）。
   *  收录是后台 fork + PR 异步任务（可能耗时约 2 分钟），用户多已离开结果卡，
   *  只能靠全局 Toast 可靠送达；轮询与「重新提交」两条路径共用。 */
  const notifyListingFailure = (s: ListingStatusResponse): void => {
    if (s.listing !== 'failed') return
    toast.error(redact(s.error ?? t('common.unknownError')), 0)
  }

  /** 轮询 /me/listing 直到任务终态（done/failed/null）；间隔 3s、最多 40 次（≈2 分钟），
   *  后台 fork 更久时超时停止，用户可稍后手动刷新列表/点「重新收录」 */
  const startListingPoll = (itemId: string): void => {
    if (listingPollTimer.current !== null) clearTimeout(listingPollTimer.current)
    let count = 0
    const tick = (): void => {
      void (async () => {
        try {
          const s = await meApi.meListing(itemId)
          if (s === null) {
            // 任务表未命中且实况也无（重启丢失/从未提交）→ 停止轮询，状态由列表徽章体现
            setListingStatus({ itemId, listing: 'done', prNumber: null, prUrl: null })
            return
          }
          setListingStatus(s)
          notifyListingFailure(s)
          if (s.listing !== 'pending') return // done/failed → 停止轮询
        } catch {
          // 轮询失败不打断：下一轮继续
        }
        count += 1
        if (count >= 40) {
          listingPollTimer.current = null
          return
        }
        listingPollTimer.current = setTimeout(tick, 3000)
      })()
    }
    tick()
  }

  /** 挂载恢复：若持久化的向导结果仍是「收录处理中」（pending），继续轮询（仿 resume 模式，避免刷新后永久 pending 卡死） */
  useEffect(() => {
    const w = wizardRef.current
    if (w.result !== null && w.result.ok && w.result.listing === 'pending') {
      startListingPoll(w.result.itemId)
    }
    return () => {
      if (listingPollTimer.current !== null) clearTimeout(listingPollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------------------------ 删除条目（行内两步确认） */

  /** 重新提交收录（收录失败 / 进程重启丢失后的一键重试）→ 重新轮询状态 */
  const runRelist = async (itemId: string): Promise<void> => {
    try {
      const s = await meApi.meRelist(itemId)
      setListingStatus(s)
      notifyListingFailure(s)
      startListingPoll(itemId)
    } catch (err) {
      // R-14：重新提交收录失败 → 全局 Toast
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 删除：调 /me/delete（同步删本地索引+文件；已收录自动后台提下架 PR）→ 刷新列表 */
  const runDelete = async (entry: MyItemEntry): Promise<void> => {
    if (deletingId !== null) return
    setDeletingId(entry.id)
    onMyConfirmDeleteChange(null)
    try {
      const result = await meApi.meDelete(entry.id)
      if (result.ok) {
        // R-14 既有缺陷修复：这两条本是**成功**文案，此前被塞进 error 字段、经红色 error Banner 渲染
        // （「删除成功」显示成报错）。现按语义分流：成功 → toast.ok，失败 → toast.error，不再混用字段。
        if (result.delisted) {
          toast.ok(t('myconfigs.delete.delistStarted'))
        } else if (result.prNumber !== null) {
          toast.ok(t('myconfigs.delete.prClosed'))
        }
        void loadItems({ silent: true })
      } else {
        toast.error(redact(result.error ?? t('common.unknownError')))
      }
    } catch (err) {
      // R-14：删除请求失败 → 全局 Toast
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    } finally {
      setDeletingId(null)
    }
  }

  /* ------------------------------------------------ 装回本地（复用市场下载 + 逐分区批准链路） */

  /** 装回本地（复用市场下载 + 逐分区批准链路；条目内容在用户自己的公开仓库，必须带 repo 来源）
   *  竞态守卫：下载期间用户可切换装回另一条目（install.itemId 已变），晚到响应一律丢弃，
   *  防止「会话标题是 B、详情是 A」的串扰。 */
  const runDownload = async (entry: MyItemEntry): Promise<void> => {
    commitInstall({
      itemId: entry.id, detail: null, selectionState: null, conflictResolutions: {},
      importing: false, importResult: null, error: null,
    })
    try {
      const detail = await api.download(entry.id, entry.repoUrl)
      if (installRef.current === null || installRef.current.itemId !== entry.id) return
      // 选择态归零 = 默认全选（与导入页一致）；换条目后陈旧选择自动失效
      commitInstall({ ...installRef.current, detail, selectionState: null, conflictResolutions: {} })
    } catch (err) {
      if (installRef.current === null || installRef.current.itemId !== entry.id) return
      // R-17：下载失败 → 全局 Toast。install.error 仍落一次，仅作「失败标记」用于停掉
      // 向导页内的加载 Spinner（detail 恒为 null，否则会一直转 = 用户误以为仍在加载）；不再页内渲染。
      patchInstall({ error: err instanceof Error ? err.message : String(err) })
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 编辑中的勾选（绑 zipPath：换条目后旧选择自动失效 → 默认全选）。
   * 与 MarketPanel / 导入向导同一套 effectiveImportSelection —— 不另写「陈旧选择」判定。
   */
  const pickerSelection: Selection | null = install?.detail === undefined || install.detail === null
    ? null
    : effectiveImportSelection(install.detail.plan, install.detail.zipPath, install.selectionState)

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
          {/* R-18：失败详情已由 failGithub() 走全局 Toast；此处保留状态行 Badge（持续状态展示，非回执） */}
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
    /** PR 链接（优先实时任务状态；收录完成后由轮询补上，或直接取同步结果） */
    const prLink = ((): { url: string; label: string } | null => {
      const live = listingStatus
      const url = (live !== null && live.prUrl !== null && live.prUrl !== '')
        ? live.prUrl
        : (wizardRef.current.result?.prUrl ?? null)
      if (url === null || url === '') return null
      const number = live !== null && live.prNumber !== null ? live.prNumber : wizardRef.current.result?.prNumber
      return {
        url,
        label: number !== null && number !== undefined
          ? t('myconfigs.result.pr', { number: String(number) })
          : t('myconfigs.result.openPr'),
      }
    })()
    /** 重置：update 模式轻量重置（只清 zip/校验，**保留预填表单**）；upload 模式完全重置 */
    const reset = (): void => {
      const w = wizardRef.current
      if (w.mode === 'update') {
        commitWizard({
          ...initialWizard('update'),
          step: 'form',
          form: { ...w.form },
        })
      } else {
        commitWizard(initialWizard('upload'))
      }
      setListingStatus(null)
    }
    return (
      <Modal
        open
        onClose={closeUpload}
        title={wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
        wide
        busy={wizard.running || wizard.validating}
      >
        <Modal.Header
          title={wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
          closeLabel={t('common.close')}
          onClose={closeUpload}
          closeDisabled={wizard.running || wizard.validating}
          trailing={wizard.mode === 'update' ? <Badge kind="info">{t('myconfigs.update.hint')}</Badge> : undefined}
        />
        <Modal.Body scroll>

        {/* 步骤 1：选配置包 */}
        {wizard.step === 'select' && (<>
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
        </>)}

        {/* 步骤 2：本地校验（dry-run 零写入；选完 zip 自动执行，通过即自动进表单，
            本步骤仅短暂展示「校验中」；失败时展示错误 + 重新选择） */}
        {wizard.step === 'validate' && (<>
          <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
          {wizard.fileName !== null && (
            <div className={css.statRow}>
              <Badge kind="info">{t('myconfigs.upload.selected', { name: wizard.fileName })}</Badge>
            </div>
          )}
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={wizard.validating}
              onClick={reset}
            >
              {wizard.validating ? <Spinner label={t('myconfigs.upload.validating')} /> : t('myconfigs.upload.reselect')}
            </Button>
          </div>
          {wizard.validationError !== null && <Banner kind="error">{redact(wizard.validationError)}</Banner>}
        </>)}

        {/* 步骤 3：精简表单（仅 name/description/categories；其余系统自动） → 上传/更新 */}
        {wizard.step === 'form' && (<>
          {/* update 模式：表单页内嵌「选择新 ZIP」入口（选中自动校验，通过后才可一键更新） */}
          {wizard.mode === 'update' && (<>
            <span className={css.hint}>{t('myconfigs.update.zipHint')}</span>
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
              <Button variant="primary" disabled={wizard.validating || wizard.running} onClick={() => { fileInput.current?.click() }}>
                {wizard.fileName !== null && wizard.zipPath !== null
                  ? t('myconfigs.upload.selected', { name: wizard.fileName })
                  : t('myconfigs.update.selectZip')}
              </Button>
              {wizard.zipPath !== null && (
                <Button disabled={wizard.validating || wizard.running} onClick={reset}>{t('myconfigs.upload.reselect')}</Button>
              )}
            </div>
            {wizard.validationError !== null && <Banner kind="error">{redact(wizard.validationError)}</Banner>}
          </>)}
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
          {/* F6 发布模式：迁移（全带）/ 分享（自动排除敏感分区 + 强制隐私拦截）—— 复用既有 conflictOptions/radioLabel 单选样式 */}
          <Field label={t('myconfigs.upload.mode.title')}>
            <div className={css.conflictOptions}>
              {([
                ['migrate', t('myconfigs.upload.mode.migrate')],
                ['share', t('myconfigs.upload.mode.share')],
              ] as const).map(([value, label]) => (
                <label key={value} className={css.radioLabel}>
                  <input
                    type="radio"
                    name="my-config-publish-mode"
                    checked={wizard.form.publishMode === value}
                    disabled={wizard.running || wizard.validating}
                    onChange={() => { onFormField('publishMode', value) }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {wizard.form.publishMode === 'share' && (
              <span className={css.hint}>{t('myconfigs.upload.mode.shareHint')}</span>
            )}
          </Field>
          {/* 系统自动字段（id/author/version/updatedAt 徽章，无需填写） */}
          <span className={css.hint}>{t('myconfigs.upload.form.autoHint')}</span>
          <div className={css.statRow}>
            {autoBadges.map((b) => (
              <Badge key={b.field} kind="info">{b.label}：{b.autoText}</Badge>
            ))}
          </div>
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={
                wizard.validated !== true || wizard.running || wizard.zipPath === null
                || !myConfigFormValid(wizard.formErrors)
              }
              onClick={() => { void runUpload() }}
            >
              {wizard.running
                ? <Spinner label={wizard.mode === 'update' ? t('myconfigs.update.running') : t('myconfigs.upload.running')} />
                : (wizard.mode === 'update' ? t('myconfigs.update.run') : t('myconfigs.upload.run'))}
            </Button>
            {wizard.mode === 'update' && (
              <Button disabled={wizard.running || wizard.validating} onClick={cancelUpdate}>{t('common.cancel')}</Button>
            )}
            {wizard.mode === 'upload' && <Button disabled={wizard.running} onClick={reset}>{t('myconfigs.upload.reselect')}</Button>}
          </div>
        </>)}

        {/* R-14：向导失败提示已由全局 Toast 送达（原 wizard.error Banner 移除） */}

        {/* 结果卡：收录状态（异步）/ PR 链接 / 仓库链接 / sha256 / 分区。
            R-19：上传/更新**失败**分支已由 runUpload 的全局 Toast 告知，此处只渲染成功结果卡
            （失败分支本无其他可展示内容，故整块以 ok 守卫）。 */}
        {wizard.result !== null && wizard.result.ok && (<>
            <span className={css.groupLabel}>{t('myconfigs.result.title')}</span>
            <div className={css.statRow}>
              <Badge kind="ok">{t('myconfigs.result.version', { version: wizard.result.version })}</Badge>
              <Badge kind="info">{t('myconfigs.result.sha256', { hash: wizard.result.sha256 })}</Badge>
              <Badge kind="info">{t('myconfigs.result.sections', { sections: wizard.result.sections.join(', ') })}</Badge>
            </div>
            {/* 收录状态：pending=后台处理中（轮询中）；failed=失败可重试；done=已提交（PR 链接）。
                R-16：失败**原因**改由常驻 Toast 送达（见 notifyListingFailure），此处保留徽章 + 重试按钮 */}
            {wizard.result.listing === 'pending' && (
              <div className={css.statRow}>
                {listingStatus !== null && listingStatus.listing === 'failed' ? (
                  <>
                    <Badge kind="error">{t('myconfigs.result.listingFailed')}</Badge>
                    <Button variant="danger" onClick={() => { void runRelist(wizard.result!.itemId) }}>
                      {t('myconfigs.result.relist')}
                    </Button>
                  </>
                ) : (
                  <Badge kind="info">{t('myconfigs.result.listingPending')}</Badge>
                )}
              </div>
            )}
            <div className={css.actionRow}>
              <Badge kind="info">{t('myconfigs.result.repo')}</Badge>
              <Button href={wizard.result.repoUrl}>{t('myconfigs.result.openRepo')}</Button>
              {(prLink !== null) && (
                <Button href={prLink.url}>{prLink.label}</Button>
              )}
            </div>
        </>)}
        </Modal.Body>
      </Modal>
    )
  }

  /** 已上传列表（条目卡片 + 状态徽章 + 行操作） */
  const renderList = (): ReactNode => {
    return (
      <Card>
        <div className={css.headRow}>
          <span className={css.groupLabel}>{t('myconfigs.list.title')}</span>
          {/* 撑开剩余空间：Badge 与刷新按钮成组贴右，刷新按钮为该行最右元素 */}
          <span className={css.statusSpacer} />
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
          <Button disabled={listLoading} onClick={() => { void loadItems() }}>
            {listLoading ? <Spinner label={t('myconfigs.list.loading')} /> : t('myconfigs.list.refresh')}
          </Button>
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
                    {view.stars !== undefined && (
                      <Badge kind="info" title={t('list.starsHint')}>{t('list.stars', { count: String(view.stars) })}</Badge>
                    )}
                    {view.author !== '' && <Badge kind="info">{view.author}</Badge>}
                    {view.updatedAt !== '' && <Badge kind="info">{view.updatedAt}</Badge>}
                    {view.categories.map((c) => <Badge key={c} kind="info">{c}</Badge>)}
                  </div>
                </div>
                <div className={css.rowActions}>
                  <Button onClick={() => { startUpdate(entry); openUpload() }}>{t('myconfigs.item.update')}</Button>
                  <Button
                    disabled={install !== null && install.detail === null}
                    onClick={() => { openInstall(entry) }}
                  >
                    {t('myconfigs.item.install')}
                  </Button>
                  {entry.repoUrl !== '' && <Button href={entry.repoUrl}>{t('myconfigs.list.openRepo')}</Button>}
                  {badge.kind === 'warn' && badge.prUrl !== undefined && badge.prUrl !== '' && (
                    <Button href={badge.prUrl}>{t('myconfigs.item.openPr')}</Button>
                  )}
                  {/* 删除：danger 按钮 → 弹窗二次确认（ConfirmDialog；不可恢复，已收录自动提交下架 PR） */}
                  <Button
                    variant="danger"
                    disabled={deletingId !== null}
                    onClick={() => { onMyConfirmDeleteChange(view.id) }}
                  >
                    {t('myconfigs.delete.run')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    )
  }

  /** 装回本地：下载 + 级联树勾选 + 执行导入（复用市场安全管道 + market-view 纯模型） */
  const renderInstall = (): ReactNode => {
    if (install === null) return null
    const { detail } = install
    const detailView = detail !== null ? marketDetailView(detail, detail.repo ?? entryRepoUrl(install.itemId), true, uiT) : null
    return (
      <>
        {/* R-17：下载/导入失败已由全局 Toast 告知（原 install.error Banner 移除）。
            下方 Spinner 以 install.error 为「失败标记」守卫：失败时 detail 恒为 null，
            若不守卫会一直旋转，让用户误以为仍在加载。 */}
        {detail === null && install.error === null && <div className={css.statRow}><Spinner label={t('list.loading')} /></div>}
        {detail === null && install.error !== null && (
          <div className={css.statRow}><span className={css.hint}>{t('myconfigs.install.failed')}</span></div>
        )}
        {detail !== null && detailView !== null && (<>
          <Banner kind="warn"><strong>{t('detail.needReview')}</strong></Banner>
          <div className={css.statRow}>
            <Badge kind={detailView.badge.valid ? 'ok' : 'error'}>{detailView.badge.statusText}</Badge>
            <Badge kind="info">{detailView.badge.sectionsText}</Badge>
          </div>
          {/* 导入审阅（2026-09）：与「浏览条目详情」共用同一个组件（R4d）—— 级联树勾选 +
              就地高风险警示 + 逐项摘要 + 冲突决策 + 导入 + 导入后一键回滚。 */}
          {detailView.canImport && pickerSelection !== null && (
            <MarketImportReview
              importApi={importApi}
              t={t}
              cmT={cmT}
              zipPath={detail.zipPath}
              plan={detail.plan}
              selection={pickerSelection}
              onSelectionChange={(next) => {
                const zipPath = installRef.current?.detail?.zipPath
                if (zipPath === undefined) return
                patchInstall({ selectionState: { zipPath, selection: next } })
              }}
              resolutions={install.conflictResolutions}
              onResolutionsChange={(next) => { patchInstall({ conflictResolutions: next }) }}
              onPlanChange={(plan) => {
                const cur = installRef.current
                if (cur === null || cur.detail === null) return
                patchInstall({ detail: { ...cur.detail, plan } })
              }}
              importing={install.importing}
              onImportingChange={(value) => { patchInstall({ importing: value }) }}
              result={install.importResult}
              onResultChange={(result) => { patchInstall({ importResult: result }) }}
              onErrorChange={(message) => { patchInstall({ error: message }) }}
              itemName={detail.name}
            />
          )}
        </>)}
        {/* R-07：装回本地导入结果已由全局 Toast 送达（原 importResult Banner 移除） */}
      </>
    )
  }

  /** 装回本地详情展示用的仓库 URL（供应链警示来源行；取条目 repoUrl 兜底固定目标仓库） */
  function entryRepoUrl(itemId: string): string {
    const entry = (myItems ?? []).find((e) => e.id === itemId)
    return entry?.repoUrl ?? `https://github.com/${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}`
  }

  /**
   * 装回本地 = **页面级向导**（P2 2026-09）：它整块取代「我的配置」列表视图（不再是弹窗叠加），
   * 与市场浏览侧的条目向导、以及导入页同构。所有 hooks 都在本行之前声明，故此处提前 return 合法。
   */
  if (installOpen && install !== null) {
    return (
      <div className={css.viewBody}>
        <div className={css.headRow}>
          <SectionTitle title={t('detail.title')} subtitle={install.itemId} />
          <span className={css.statusSpacer} />
          <Button disabled={install.importing} onClick={closeInstall}>{t('detail.back')}</Button>
        </div>
        {renderInstall()}
      </div>
    )
  }

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('myconfigs.tab.myconfigs')} subtitle={t('myconfigs.login.hint')} />
      {renderLoginCard()}
      {/* 已登录才允许上传 / 查看列表 / 装回本地 */}
      {loginView.kind === 'logged-in' && (
        <>
          {/* 一键上传入口：点按钮 → 免责（首次）→ 弹窗向导 */}
          <Card>
            <div className={css.headRow}>
              <span className={css.groupLabel}>{t('myconfigs.upload.title')}</span>
              {/* 撑开剩余空间，「一键上传」按钮贴右 */}
              <span className={css.statusSpacer} />
              <Button variant="primary" onClick={openUpload}>{t('myconfigs.upload.run')}</Button>
            </div>
            <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
          </Card>
          {renderList()}
          {/* 弹窗：上传/更新向导（uploadOpen）—— 装回本地已改为页面级向导（见上方提前 return） */}
          {uploadOpen && renderWizard()}
        </>
      )}
      {/* 免责弹窗（复用 ConfirmDialog + 「不再提示」勾选；三操作分开记） */}
      <ConfirmDialog
        open={disclaimerKey !== null}
        title={t('disclaimer.title')}
        message={disclaimerText()}
        confirmLabel={t('disclaimer.confirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmDisclaimer}
        onCancel={cancelDisclaimer}
      >
        <label className={css.checkboxRow}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setDontAsk(e.target.checked) }}
          />
          <span>{t('disclaimer.dontAsk')}</span>
        </label>
      </ConfirmDialog>
      {/* 删除确认弹窗（二次确认；不可恢复；确认执行中 busy 防重复提交） */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t('myconfigs.delete.confirmTitle')}
        message={t('myconfigs.delete.confirmText')}
        confirmLabel={t('myconfigs.delete.confirm')}
        cancelLabel={t('common.cancel')}
        danger
        busy={deletingId !== null}
        onConfirm={async () => {
          const entry = (myItems ?? []).find((it) => it.id === confirmDeleteId)
          if (entry !== undefined) await runDelete(entry)
        }}
        onCancel={() => { onMyConfirmDeleteChange(null) }}
      />
    </div>
  )
}