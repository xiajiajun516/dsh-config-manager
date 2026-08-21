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
import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from '../../market/github-repos.ts'
import type { MarketApi } from './market-api.ts'
import type { MyConfigsApi, MyItemEntry } from './my-configs-api.ts'
import type { ListingStatusResponse } from '../../market/my-repo.ts'
import type { SyncApi, GithubPollResponse } from '../sync/sync-api.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
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
  approvalRows, approvedAdapterSummary, buildApprovedPlan, defaultApprovals, marketDetailView,
} from './market-view.ts'
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
  meApi, api, importApi, syncApi, t, myItems, myItemsError, onMyItemsChange, myWizard, onMyWizardChange,
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

  /* ---------------- 弹窗交互（2026-08-21：上传/装回本地搬进弹窗 + 免责前置） ---------------- */
  /** 上传/更新向导弹窗开关（瞬态 UI，不持久化：切 tab 弹窗关闭，数据仍在 runStore） */
  const [uploadOpen, setUploadOpen] = useState(false)
  /** 装回本地弹窗开关（同上） */
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
  /** 打开装回本地弹窗：未勾「不再提示」→ 先弹免责，确认后开弹窗并启动下载 */
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
  /** 关闭装回本地弹窗：清 install 会话 */
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

  /** 选 zip → upload 受控临时区；upload 模式预填 name 为 zip 文件名（可改）；
   *  update 模式（更新直达表单页）留在 form 步骤并自动跑校验 */
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
        patchWizard({
          ...base,
          step: 'validate',
          /* 预填 zip 文件名（去 .zip 后缀，可改） */
          form: { ...wizardRef.current.form, name: file.name.replace(/\.zip$/i, '') },
        })
      }
    } catch (err) {
      patchWizard({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 步骤 2：analyzeImport dry-run（零写入）—— 无密钥 + 内容合法才放行；通过后进表单 */
  const runValidate = async (): Promise<void> => {
    if (wizard.zipPath === null) return
    await runValidateWith(wizard.zipPath)
  }

  /** 校验指定 zipPath（update 模式选新 zip 后自动调用；任何异常都落到 validationError 展示，不静默） */
  const runValidateWith = async (zipPath: string): Promise<void> => {
    try {
      patchWizard({ validating: true, validationError: null })
    } catch (err) {
      // 进入校验态失败（极端情况）：仍展示错误而不是无反应
      setWizard((w) => ({ ...w, validationError: err instanceof Error ? err.message : String(err) }))
      return
    }
    try {
      const analysis = await importApi.analyzeImport(zipPath)
      if (analysis.secretCount > 0) {
        patchWizard({ validating: false, validated: false, validationError: t('myconfigs.upload.validateSecrets') })
      } else if (!analysis.valid) {
        patchWizard({ validating: false, validated: false, validationError: t('myconfigs.upload.validateInvalid') })
      } else {
        // 校验通过 → 自动进入表单步骤（upload 模式从 validate 进 form；update 模式本就是 form，值相同无害）
        patchWizard({ validating: false, validated: true, validationError: null, step: 'form' })
      }
    } catch (err) {
      patchWizard({
        validating: false, validated: false,
        validationError: err instanceof Error ? err.message : String(err),
      })
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
    }
    patchWizard({ running: true, error: null, result: null })
    try {
      const result = w.mode === 'update'
        ? await meApi.meUpdate({ zipPath, form })
        : await meApi.meUpload({ zipPath, form })
      commitWizard({ ...wizardRef.current, running: false, result })
      // 上传/更新成功后：清空旧收录状态 + 若收录后台进行中则轮询状态 + 刷新列表
      setListingStatus(null)
      if (result.ok && result.listing === 'pending') startListingPoll(result.itemId)
      void loadItems({ silent: true })
    } catch (err) {
      patchWizard({ running: false, error: err instanceof Error ? err.message : String(err) })
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
      },
    })
    setListingStatus(null)
  }

  /* ------------------------------------------------ 收录/下架任务状态轮询 */

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
      startListingPoll(itemId)
    } catch (err) {
      patchWizard({ error: err instanceof Error ? err.message : String(err) })
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
        if (result.delisted) {
          patchWizard({ error: t('myconfigs.delete.delistStarted') })
        } else if (result.prNumber !== null) {
          patchWizard({ error: t('myconfigs.delete.prClosed') })
        }
        void loadItems({ silent: true })
      } else {
        patchWizard({ error: result.error ?? t('common.unknownError') })
      }
    } catch (err) {
      patchWizard({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setDeletingId(null)
    }
  }

  /* ------------------------------------------------ 装回本地（复用市场下载 + 逐分区批准链路） */

  /** 装回本地（复用市场下载 + 逐分区批准链路；条目内容在用户自己的公开仓库，必须带 repo 来源） */
  const runDownload = async (entry: MyItemEntry): Promise<void> => {
    commitInstall({ itemId: entry.id, detail: null, approvals: {}, importing: false, importResult: null, error: null })
    try {
      const detail = await api.download(entry.id, entry.repoUrl)
      if (installRef.current !== null) {
        commitInstall({ ...installRef.current, detail, approvals: defaultApprovals(detail.plan) })
      }
    } catch (err) {
      if (installRef.current !== null) {
        patchInstall({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const runImport = async (): Promise<void> => {
    if (install === null || install.detail === null) return
    const approvedPlan = buildApprovedPlan(install.detail.plan, install.approvals)
    if (approvedPlan.items.length === 0) {
      patchInstall({ error: t('detail.noApproval') })
      return
    }
    patchInstall({ importing: true, error: null })
    try {
      const executed = await importApi.executeImportPlan(
        install.detail.zipPath,
        approvedPlan,
        { confirm: true, rollbackOnError: true },
      )
      patchInstall({ importing: false, importResult: executed })
    } catch (err) {
      patchInstall({ importing: false, error: err instanceof Error ? err.message : String(err) })
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
      <div
        className={css.dialogMask}
        onMouseDown={(e) => { if (e.target === e.currentTarget && !wizard.running && !wizard.validating) closeUpload() }}
      >
        <div className={`${css.dialogCard} ${css.dialogWide}`} role="dialog" aria-modal="true" aria-label={wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}>
          <div className={css.dialogHeaderRow}>
            <span className={css.dialogHeader}>
              {wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
              {wizard.mode === 'update' && <Badge kind="info">{t('myconfigs.update.hint')}</Badge>}
            </span>
            <button
              type="button"
              className={css.dialogClose}
              aria-label={t('common.close')}
              disabled={wizard.running || wizard.validating}
              onClick={closeUpload}
            >
              ×
            </button>
          </div>
          <div className={css.dialogBodyScroll}>

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

        {/* 步骤 3：精简表单（仅 name/description/categories；其余系统自动） → 上传/更新 */}
        {wizard.step === 'form' && (
          <div>
            {/* update 模式：表单页内嵌「选择新 ZIP」入口（选中自动校验，通过后才可一键更新） */}
            {wizard.mode === 'update' && (
              <div>
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
              </div>
            )}
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
          </div>
        )}

        {wizard.error !== null && <Banner kind="error">{redact(wizard.error)}</Banner>}

        {/* 结果卡：收录状态（异步）/ PR 链接 / 仓库链接 / sha256 / 分区 */}
        {wizard.result !== null && (
          wizard.result.ok ? (
            <div>
              <span className={css.groupLabel}>{t('myconfigs.result.title')}</span>
              <div className={css.statRow}>
                <Badge kind="ok">{t('myconfigs.result.version', { version: wizard.result.version })}</Badge>
                <Badge kind="info">{t('myconfigs.result.sha256', { hash: wizard.result.sha256 })}</Badge>
                <Badge kind="info">{t('myconfigs.result.sections', { sections: wizard.result.sections.join(', ') })}</Badge>
              </div>
              {/* 收录状态：pending=后台处理中（轮询中）；failed=失败可重试；done=已提交（PR 链接） */}
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
              {listingStatus !== null && listingStatus.listing === 'failed' && (
                <Banner kind="error">{redact(listingStatus.error ?? t('common.unknownError'))}</Banner>
              )}
              <div className={css.actionRow}>
                <Badge kind="info">{t('myconfigs.result.repo')}</Badge>
                <Button href={wizard.result.repoUrl}>{t('myconfigs.result.openRepo')}</Button>
                {(prLink !== null) && (
                  <Button href={prLink.url}>{prLink.label}</Button>
                )}
              </div>
            </div>
          ) : (
            <Banner kind="error">
              {redact(wizard.result.error ?? ((wizard.result.warnings ?? []).join(' · ') || t('common.unknownError')))}
            </Banner>
          )
        )}
          </div>
        </div>
      </div>
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
                    disabled={install !== null && install.itemId === view.id && install.detail === null}
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

  /** 装回本地：下载 + 逐分区批准 + 执行导入（复用市场安全管道 + market-view 纯模型） */
  const renderInstall = (): ReactNode => {
    if (install === null) return null
    const { detail } = install
    const approvalList = detail !== null ? approvalRows(detail.plan, install.approvals) : []
    const approvalSummary = detail !== null ? approvedAdapterSummary(detail.plan, install.approvals) : null
    const detailView = detail !== null ? marketDetailView(detail, detail.repo ?? entryRepoUrl(install.itemId), true, uiT) : null
    return (
      <div
        className={css.dialogMask}
        onMouseDown={(e) => { if (e.target === e.currentTarget && !install.importing) closeInstall() }}
      >
        <div className={`${css.dialogCard} ${css.dialogWide}`} role="dialog" aria-modal="true" aria-label={t('detail.title')}>
          <div className={css.dialogHeaderRow}>
            <span className={css.dialogHeader}>{t('detail.title')}：{install.itemId}</span>
            <button
              type="button"
              className={css.dialogClose}
              aria-label={t('common.close')}
              disabled={install.importing}
              onClick={closeInstall}
            >
              ×
            </button>
          </div>
          <div className={css.dialogBodyScroll}>
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
                        if (installRef.current !== null) {
                          patchInstall({ approvals: { ...installRef.current.approvals, [row.adapter]: checked } })
                        }
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
          </div>
        </div>
      </div>
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
          {/* 一键上传入口：点按钮 → 免责（首次）→ 弹窗向导 */}
          <Card>
            <div className={css.actionRow}>
              <span className={css.groupLabel}>{t('myconfigs.upload.title')}</span>
              <Button variant="primary" onClick={openUpload}>{t('myconfigs.upload.run')}</Button>
            </div>
            <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
          </Card>
          {renderList()}
          {/* 弹窗：上传/更新向导（uploadOpen）与装回本地（installOpen），条件渲染 */}
          {uploadOpen && renderWizard()}
          {installOpen && renderInstall()}
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