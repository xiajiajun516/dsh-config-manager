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
 * 结构（t49 物理拆分，主文件 1151 → 823 行）：本文件只做状态编排 + 装配，四个 render 段各一个
 * 平铺子组件（不新增子目录）：MyConfigsLoginCard.tsx（登录卡 + 设备码）/ MyConfigsWizard.tsx
 * （上传·更新弹窗）/ MyConfigsList.tsx（已上传列表）/ MyConfigsInstall.tsx（装回本地向导页）；
 * 可测纯逻辑在 ../../ui/my-configs-view.ts（t44 下沉），拆分结构由 my-configs-split.test.ts 守护。
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
import { Button, Card, SectionTitle } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import { githubPollMessage } from '../sync/sync-view.ts'
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
import type { Selection } from '../../ui/selection-model.ts'
import {
  INITIAL_MY_GITHUB_FLOW, MY_LISTING_POLL_INTERVAL_MS, myEntryRepoUrl, myGithubFlowAfterCancel,
  myGithubFlowAfterFailure, myGithubFlowAfterPoll, myGithubFlowFromStart, myGithubFlowPolling,
  myGithubFlowStarting, myGithubStartDelayMs, myListingPollStep, myPickerSelection,
  myShouldResetWizardOnDisclaimerCancel,
} from '../../ui/my-configs-view.ts'
import type { MyGithubFlowState } from '../../ui/my-configs-view.ts'
import { MyConfigsInstall } from './MyConfigsInstall.tsx'
import { MyConfigsList } from './MyConfigsList.tsx'
import { MyConfigsLoginCard } from './MyConfigsLoginCard.tsx'
import { MyConfigsWizard } from './MyConfigsWizard.tsx'
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

/* -------------------------------- GitHub device flow 状态（仅内存，token 只存宿主）
 * 状态与迁移判定（starting/polling/waiting/error、轮询延时、取消）已下沉到
 * src/ui/my-configs-view.ts（t44；框架无关、node 可测）。本组件只持定时器与请求编排。 */

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
  const [github, setGithub] = useState<MyGithubFlowState>(INITIAL_MY_GITHUB_FLOW)
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
  /** 取消免责弹窗：关闭，不打开操作弹窗；若向导处于 update 残留态则重置为上传初始态
   *  （「是否重置」判定在 ui/my-configs-view.ts 的 myShouldResetWizardOnDisclaimerCancel，node 可测） */
  const cancelDisclaimer = (): void => {
    setDisclaimerKey(null)
    if (myShouldResetWizardOnDisclaimerCancel(disclaimerKey, wizardRef.current.mode)) {
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
    setGithub((g) => myGithubFlowAfterFailure(g, safe))
    toast.error(safe)
  }

  const runGithubStart = async (): Promise<void> => {
    setGithub((g) => myGithubFlowStarting(g))
    try {
      const info = await syncApi.githubStart()
      setGithub(myGithubFlowFromStart(info))
      scheduleGithubPoll(info.flowId, myGithubStartDelayMs(info.interval))
    } catch (err) {
      failGithub(err instanceof Error ? err.message : String(err))
    }
  }

  const scheduleGithubPoll = (flowId: string, delayMs: number): void => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    githubPollTimer.current = setTimeout(() => { void runGithubPoll(flowId) }, delayMs)
  }

  const runGithubPoll = async (flowId: string): Promise<void> => {
    setGithub((g) => myGithubFlowPolling(g))
    try {
      const poll: GithubPollResponse = await syncApi.githubPoll(flowId)
      // 失败文案只在非 pending 时取（与原先「pending 先 return」逐字等价）；文案同样先 redact 再入状态
      const step = myGithubFlowAfterPoll(
        github, poll, poll.status === 'pending' ? '' : redact(githubPollMessage(poll, uiT)),
      )
      if (step.outcome === 'pending') {
        setGithub(step.next)
        scheduleGithubPoll(flowId, step.delayMs ?? myGithubStartDelayMs(github.interval))
        return
      }
      setGithub(step.next)
      if (step.outcome === 'success') {
        // token 已由宿主写入 credentials：刷新登录态 + 列表
        const s = await loadStatus()
        if (s !== null && s.loggedIn) void loadItems({ silent: true })
        return
      }
      // failed：与原 failGithub 同路（状态已落 error，这里只补常驻 Toast）
      toast.error(step.next.error ?? '')
    } catch (err) {
      failGithub(err instanceof Error ? err.message : String(err))
    }
  }

  const runGithubCancel = async (): Promise<void> => {
    if (githubPollTimer.current !== null) {
      clearTimeout(githubPollTimer.current)
      githubPollTimer.current = null
    }
    const { flowId, next } = myGithubFlowAfterCancel(github)
    setGithub(next)
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
    /** 远端明确回答「没有该任务」（重启丢失/从未提交）时的收尾状态：由列表徽章体现，不再轮询 */
    const doneFallback: ListingStatusResponse = { itemId, listing: 'done', prNumber: null, prUrl: null }
    const tick = (): void => {
      void (async () => {
        // 步进判定在 src/ui/my-configs-view.ts（t44 下沉；node 可测）：「请求抛错」与「远端明确回答
        // null」是两条不同分支，靠 networkFailed 区分（前者继续轮询，后者用 doneFallback 收尾）。
        let response: ListingStatusResponse | null = null
        let networkFailed = false
        try {
          response = await meApi.meListing(itemId)
        } catch {
          networkFailed = true
        }
        const step = myListingPollStep<ListingStatusResponse>({ response, networkFailed, doneFallback, count })
        if (step.status !== null) {
          setListingStatus(step.status)
          if (step.notifyFailure) notifyListingFailure(step.status)
        }
        count = step.count
        if (step.stop) {
          listingPollTimer.current = null
          return
        }
        listingPollTimer.current = setTimeout(tick, MY_LISTING_POLL_INTERVAL_MS)
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
   * 判定在 src/ui/my-configs-view.ts 的 myPickerSelection（内部走与 MarketPanel / 导入向导同一套
   * effectiveImportSelection）—— 组件侧不另写「陈旧选择」判定。
   */
  const pickerSelection: Selection | null = myPickerSelection(install)

  /* ------------------------------------------------ 渲染模型装配（全部纯函数） */

  /** 登录视图（loading / logged-out / logged-in / token-invalid） */
  const loginView: LoginView = deriveLoginState({
    loading: statusLoading,
    status,
    authFailed: statusFailed,
  })

  /** 已上传条目投影（Host 状态 → 徽章模型） */
  const itemViews = (myItems ?? []).map((entry) => {
    const status = itemStatusFromHost(entry)
    const view = toMyItemView(entry, status, uiT)
    return { entry, view, badge: view.badge }
  })
  const summary = summarizeMyItems(itemViews.map((v) => v.view))
  const autoBadges = autoFieldBadges(uiT)

  /* -------------------------------- 渲染分区（t49 已物理拆分）：本组件只做「编排 + 装配」
   *  每段一个平铺子组件文件（不新增子目录），下方 render 函数只是各自的 props 适配：
   *  renderLoginCard（登录卡 + 设备码片段）→ ./MyConfigsLoginCard.tsx
   *  renderWizard（上传·更新向导弹窗）      → ./MyConfigsWizard.tsx
   *  renderList（已上传条目列表）           → ./MyConfigsList.tsx
   *  renderInstall（装回本地向导页；installOpen 时整块取代列表，见文件末尾提前 return）→ ./MyConfigsInstall.tsx
   *  判定逻辑归 ../../ui/my-configs-view.ts（t44 下沉，node 可测）与 ./my-configs-view.ts（客户端装配模型），
   *  展示原语归 ../common/ui.tsx —— 新增逻辑先归位到模型层，别再写进组件体。 */

  /** 登录卡（未登录 / token 失效 → device flow；已登录 → @login + 固定目标仓库只读展示）
   *  渲染与设备码片段已拆到 ./MyConfigsLoginCard.tsx（t49）；这里只装配状态与回调。 */
  const renderLoginCard = (): ReactNode => (
    <MyConfigsLoginCard
      loginView={loginView}
      github={github}
      t={t}
      uiT={uiT}
      onStart={() => { void runGithubStart() }}
      onCancel={() => { void runGithubCancel() }}
    />
  )

  /** 重置向导：update 模式轻量重置（只清 zip/校验，**保留预填表单**）；upload 模式完全重置
   *  （原先内联在 renderWizard 里；弹窗迁到 ./MyConfigsWizard.tsx 后由容器持有，语义不变） */
  const resetWizard = (): void => {
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

  /** 上传 / 更新向导卡片（选 zip → 校验 → 表单 → 结果）
   *  弹窗渲染已拆到 ./MyConfigsWizard.tsx（t49）；这里只装配状态与回调（PR 链接来源判定也在子组件内
   *  复用 ui/my-configs-view.ts 的 myPrLinkSource）。 */
  const renderWizard = (): ReactNode => (
    <MyConfigsWizard
      wizard={wizard}
      listingStatus={listingStatus}
      t={t}
      fileInput={fileInput}
      autoBadges={autoBadges}
      onClose={closeUpload}
      onPickFile={(file) => { void onPickFile(file) }}
      onFormField={onFormField}
      onRunUpload={() => { void runUpload() }}
      onCancelUpdate={cancelUpdate}
      onRelist={(itemId) => { void runRelist(itemId) }}
      onReset={resetWizard}
    />
  )

  /** 已上传列表（条目卡片 + 状态徽章 + 行操作）
   *  列表渲染已拆到 ./MyConfigsList.tsx（t49）；这里只装配投影行（itemViews/summary）与行操作回调。 */
  const renderList = (): ReactNode => (
    <MyConfigsList
      t={t}
      myItems={myItems}
      myItemsError={myItemsError}
      listLoading={listLoading}
      itemViews={itemViews}
      summary={summary}
      install={install}
      deletingId={deletingId}
      onRefresh={() => { void loadItems() }}
      onChangeDeleteConfirm={onMyConfirmDeleteChange}
      onOpenUpdate={(entry) => { startUpdate(entry); openUpload() }}
      onOpenInstall={(entry) => { openInstall(entry) }}
    />
  )

  /** 装回本地：下载 + 级联树勾选 + 执行导入（复用市场安全管道 + market-view 纯模型）
   *  块内渲染已拆到 ./MyConfigsInstall.tsx（t49）；这里只装配状态、勾选与仓库 URL。 */
  const renderInstall = (): ReactNode => {
    if (install === null) return null
    return (
      <MyConfigsInstall
        install={install}
        installRef={installRef}
        pickerSelection={pickerSelection}
        repoUrl={entryRepoUrl(install.itemId)}
        importApi={importApi}
        t={t}
        cmT={cmT}
        uiT={uiT}
        patchInstall={patchInstall}
      />
    )
  }

  /** 装回本地详情展示用的仓库 URL（取条目 repoUrl 兜底固定目标仓库）；规则见 ui/my-configs-view.ts
   *  的 myEntryRepoUrl：空串同样回落（原先 `??` 对空串不回落 → href="" 死链），唯一一处有意收紧。 */
  function entryRepoUrl(itemId: string): string {
    return myEntryRepoUrl(myItems ?? [], itemId, `https://github.com/${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}`)
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