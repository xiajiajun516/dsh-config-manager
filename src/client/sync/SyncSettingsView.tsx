/**
 * 远程同步面板（备份与迁移页的第 4 个 tab 内容）。
 *
 * 独立设置页壳（sectionHeader/close/自身 tab）已移除 —— tab 容器由
 * ConfigManagerSection 统一渲染，本组件只输出内容体：
 * - **同步通道入口卡**：展示当前通道 + 配置状态 + 凭据徽章；点「配置同步通道」
 *   → 弹出**通道配置弹窗**（弹窗体系与市场操作弹窗一致，DESIGN.md §8.12：
 *   dialogMask + dialogCard dialogWide + dialogHeaderRow + dialogClose +
 *   dialogBodyScroll，零新增样式）；
 * - **通道配置弹窗**：通道子 tab（GitHub（git）/ WebDAV）切换，两个通道的
 *   配置表单、自动同步、同步模式、是否加密、远端快照**各自独立**；关闭弹窗
 *   = 放弃本次操作（GitHub 登录流程进行中则一并取消，§8.12 约定）；
 * - GitHub 子 tab：repoUrl（必填）+ 认证 token（可选，写入 DSH credentials 的提示）
 *   + **GitHub OAuth device flow 登录**（登录块跟随 git 通道配置放在弹窗内：
 *   未登录/失效时显示；git 可执行文件固定使用系统 PATH 中的 git）；
 * - WebDAV 子 tab：url + username + password（密码写入 DSH credentials）+ 常见服务器预设；
 * - 私有仓库强制提示横幅（仅 git 子 tab 常驻）；
 * - 推送按钮 → SyncPushReport；拉取按钮 → SyncPullReport.changes 差异摘要；
 * - 一键同步主按钮：拉取 → 差异确认会话（SyncConfirmView 逐项确认）→ 确认导入
 *   （apply-items）→ 执行结果 + 一键回滚（restoreId）；「选择历史快照」下拉；
 * - 自动同步设置（按通道）：总开关 + 间隔下拉 + 状态（上次运行 / 下次倒计时）；
 * - 状态行：凭据配置 + 上次同步时间 + 通道（来自 GET /sync/status，组件挂载时加载）。
 *
 * 全部渲染模型来自 ./sync-view.ts 纯函数（node 单测覆盖），组件只做装配；
 * 状态组件内自持（useState），同时经 toSyncStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」；
 * token/webdav 密码/加密与解密密码仅内存（state），成功后清空（已写入 DSH
 * credentials），持久化白名单硬性剔除（含 byChannel 内密码类字段），刷新后
 * 清空、需要时重新输入。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncPullReport, SyncPushPreview, SyncPushReport } from '../../sync/sync-engine.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, Checkbox, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import { Modal } from '../common/Modal.tsx'
import { sectionLabeler } from '../common/section-labels.ts'
import { RefreshIcon } from '../common/Icon.tsx'
import { runStore, toSyncStoreSlice, type SyncConfirmDecisions, type SyncStoreSlice } from '../run-store.ts'
import { SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF } from './sync-api.ts'
import type {
  AutosyncInterval, AutosyncStatusResponse, SyncApi, SyncPushPayload, SyncSectionInfo, SyncSnapshotLite,
  SyncStartResponse, SyncStatusResponse,
} from './sync-api.ts'
import {
  autosyncIntervalMs, autosyncStatusText, channelTabModels, computeAutosyncCountdown,
  computeGithubLoginView, computeRemoteReady, computeSyncButtons,
  defaultChannelSyncState, formatIntervalDuration, githubPollMessage, kindLabel, presetById,
  presetIdForUrl, privateRepoHint, pullReportView, pushPreviewView, pushReportView, readStoredChannel,
  DEFAULT_SYNC_SESSIONS_LIMIT, initialSyncSections, normalizeSessionsLimit, severityLabel,
  syncSectionGroups, syncSectionOptions,
  WEBDAV_PRESETS, writeStoredChannel,
} from './sync-view.ts'
import type {
  ChannelSyncState, GithubLoginPhase, SyncChannel, SyncSectionOption,
} from './sync-view.ts'
import { SyncHistoryView } from './SyncHistoryView.tsx'
import { SyncConfirmView } from './SyncConfirmView.tsx'
import css from '../config-manager.module.css'

export interface SyncSettingsViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /**
   * config-manager 命名空间的翻译器：仅用于**分区显示名**（section-labels 的 sectionLabeler）。
   * 分区名只经 common/section-labels.ts 的单一映射，禁止在本文件里另建一套（术语漂移）。
   */
  cmT: TranslateNS<'config-manager'>
}

/** P0-②：push 前预览弹窗的视图数据（持久化切片；非敏感，刷新后可恢复确认态） */
export interface PushPreviewSlice {
  /** 预览结果（null = 尚未取到 */ 
  preview: SyncPushPreview | null
  /** 弹窗是否打开（预览完成后自动打开；确认/关闭后关闭） */
  open: boolean
}

/**
 * 分区选择保存的部分更新：未给出的字段沿用当前通道的既有值（saveSelection 内部合并）。
 * 密码字段单独成组 —— 它们是**唯一**会写进本机凭据库（DSH credentials）的载荷。
 */
interface SelectionPatch {
  sections?: SectionId[]
  sessionsLimit?: number
  encrypt?: boolean
  includeSecrets?: boolean
  /** 非空 = 写入本机凭据库（长期复用） */
  encryptPassword?: string
  decryptPassword?: string
  /** 主动删除已保存的密码（优先级高于同字段的写入） */
  clearEncryptPassword?: boolean
  clearDecryptPassword?: boolean
}

interface SyncUiState {
  loading: boolean
  loadError: string | null
  statusInfo: SyncStatusResponse | null
  /** 当前激活通道子 tab（git 默认；webdav 切换显示 WebDAV 表单） */
  channel: SyncChannel
  /** git 通道表单 */
  repoUrl: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化 */
  token: string
  /** webdav 通道表单 */
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化/回显 */
  webdavPassword: string
  /** git/webdav 各自独立的设置状态（自动同步 / 同步模式 / 加密 / 快照） */
  byChannel: {
    git: ChannelSyncState
    webdav: ChannelSyncState
  }
  /** 可同步分区目录（status.syncSections 回填；高级模式勾选列表数据源；两通道共用目录） */
  catalog: SyncSectionOption[]
  /** 通道配置保存中（「保存配置」按钮 spinner；自动保存同用） */
  savingConfig: boolean
  busy: 'sync' | 'push' | 'pull' | 'rollback' | null
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
  /** P0-②：push 前只读预览弹窗（preview 结果 + 打开状态；非敏感，切 tab/刷新不丢） */
  pushPreview: PushPreviewSlice
  /** 一键同步差异确认会话（POST /sync/sync 结果；非空时渲染 SyncConfirmView） */
  confirmSession: SyncStartResponse | null
  /** 一键同步差异确认的逐项决策（adopted/resolution；与 confirmSession 生命周期绑定，切 tab/刷新不丢） */
  confirmDecisions: SyncConfirmDecisions | null
  /** 最近一次一键同步执行结果（回滚入口） */
  lastRestoreId: string | null
  /**
   * 动作失败文案（R-20 后**不再作为展示通道**）。
   * 保留该字段仅因 run-store 的 SyncStoreSlice 结构契约要求（toSyncStoreSlice 读取它，
   * 而 run-store.ts 不在本任务改动范围）；失败反馈已全部改走 Toast（见下方各 catch 分支），
   * 因此不再写入消息，页面也没有对应渲染点。
   */
  error: string | null
  /** GitHub OAuth device flow 状态（flowId/userCode 仅内存，token 只存宿主） */
  github: GithubUiState
  /**
   * GitHub token 是否有效（「已登录」判定：token 存在且 GitHub API 接受）。
   * null = 尚未校验（不显示登录块，避免已登录用户看到闪烁）；true = 已登录
   * （隐藏 GitHub 登录块）；false = 未配置或已失效（显示登录块）。
   * 仅内存瞬态（不进 store 切片）：切 tab/刷新后重新校验，保证新鲜。
   */
  githubSignedIn: boolean | null
}

interface GithubUiState {
  phase: GithubLoginPhase
  flowId: string
  userCode: string
  verificationUri: string
  /** GitHub 建议轮询间隔秒数（pending 重排时兜底用） */
  interval: number
  error: string | null
}

const initialGithub: GithubUiState = {
  phase: 'idle', flowId: '', userCode: '', verificationUri: '', interval: 5, error: null,
}

const AUTOSYNC_INTERVAL_OPTIONS: AutosyncInterval[] = ['5m', '15m', '30m', '60m', '6h', '12h', '24h'];

const initial: SyncUiState = {
  loading: true,
  loadError: null,
  statusInfo: null,
  // 用户最近选择的通道优先（localStorage 记住）；无则缺省 git，由 loadStatus 按配置回填
  channel: readStoredChannel() ?? 'git',
  repoUrl: '',
  token: '',
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  byChannel: {
    git: defaultChannelSyncState(),
    webdav: defaultChannelSyncState(),
  },
  catalog: [],
  savingConfig: false,
  busy: null,
  pushReport: null,
  pullReport: null,
  pushPreview: { preview: null, open: false },
  confirmSession: null,
  confirmDecisions: null,
  lastRestoreId: null,
  error: null,
  github: initialGithub,
  githubSignedIn: null,
}

/**
 * 从 runStore 恢复上次的同步 UI 状态（切 tab 回 / 刷新后挂载）。
 * 敏感字段（token/webdav 密码/加密与解密密码）只在内存切片里保留：切 tab 保留；
 * 刷新后已被持久化白名单清空（applyPersisted 强制归零）→ 需要时重新输入。
 * busy/savingConfig 为瞬态：切 tab 由模块级单例保留（切回仍显示进行中）；
 * 刷新后白名单剔除 → 回复空闲。
 */
function initFromStore(): SyncUiState {
  const s: SyncStoreSlice = runStore.getSnapshot().sync
  return {
    ...initial,
    // 通道：store 切片缺省为 'git'，无法区分「持久化过 git」与「从未持久化」；
    // 无明确记录（== 'git'）时回退 localStorage 记住的选择（initial.channel），
    // 避免升级后把用户此前记住的 webdav 通道冲掉
    channel: s.channel !== 'git' ? s.channel : initial.channel,
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    byChannel: {
      git: { ...defaultChannelSyncState(), ...s.byChannel.git },
      webdav: { ...defaultChannelSyncState(), ...s.byChannel.webdav },
    },
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
    pullReport: s.pullReport,
    pushPreview: s.pushPreview ?? { preview: null, open: false },
    confirmSession: s.confirmSession,
    confirmDecisions: s.confirmDecisions,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export function SyncSettingsView({ api, t, cmT }: SyncSettingsViewProps) {
  const [state, setState] = useState<SyncUiState>(initFromStore)
  const uiT = api.t // 客户端展示层翻译器（zh/en，见 ui/i18n.ts）
  /** 分区显示名（section-labels 的单一映射；与导出选择器显示同一个中文名，见 §7「分区显示名」） */
  const sectionName = sectionLabeler(cmT)
  /** 最新 state 镜像（commit/自动保存 flush 读取，避免闭包过期值） */
  const stateRef = useRef<SyncUiState>(state)
  /** 挂载守卫：卸载后不再 setState（store 镜像仍执行，异步结果照常落库） */
  const mountedRef = useRef(true)
  /** 通道配置弹窗开关（瞬态 UI：切 tab/刷新不持久化，弹窗不自动重开；DESIGN.md §8.12 约定） */
  const [channelOpen, setChannelOpen] = useState(false)
  /** 同步分区选择弹窗开关（瞬态 UI：模式与勾选在弹窗内即时生效并持久化，关闭即完成） */
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false)

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（push/pull/sync）完成回调在组件
   * 已卸载（切走 tab）时也能把结果写进 store，切回 tab 时 initFromStore 恢复。
   */
  const commit = (next: SyncUiState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({ sync: toSyncStoreSlice(next) })
  }
  const patch = (p: Partial<SyncUiState>): void => commit({ ...stateRef.current, ...p })
  /** 更新指定通道的 byChannel 状态（子 tab 切换后 loadSnapshots 等场景用）。 */
  const patchChannelState = (ch: SyncChannel, p: Partial<ChannelSyncState>): void => commit({
    ...stateRef.current,
    byChannel: {
      ...stateRef.current.byChannel,
      [ch]: { ...stateRef.current.byChannel[ch], ...p },
    },
  })
  /** 更新当前激活通道的 byChannel 状态。 */
  const patchChannel = (p: Partial<ChannelSyncState>): void => patchChannelState(state.channel, p)
  /** 当前激活通道的设置状态（自动同步/模式/加密/快照）。 */
  const chState: ChannelSyncState = state.byChannel[state.channel]
  /** GitHub 流程态（不进 store 切片；commit 的镜像写幂等无害）。 */
  const patchGithub = (p: Partial<GithubUiState>): void => commit({
    ...stateRef.current,
    github: { ...stateRef.current.github, ...p },
  })
  /** GitHub 轮询定时器（卸载/取消时清理，防止泄漏与跨流程串扰） */
  const githubPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 通道配置自动保存：防抖 timer + 待发 payload（关闭设置页前 flush，不丢输入） */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<SyncPushPayload | null>(null)
  /** 保存请求在途（防重入：保存中又排入新改动 → 完成后补发最新 payload） */
  const savingRef = useRef(false)
  /** 正在拉取远端快照列表（按通道独立防抖/防并发） */
  const loadingSnapshotsRef = useRef<Record<SyncChannel, boolean>>({ git: false, webdav: false })

  /** 挂载时读取同步状态（配置回填 + 上次同步时间 + 凭据状态 + 两通道 autosync/selection） */
  const loadStatus = async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      // 通道回填：优先磁盘持久化的选择（status.lastSyncChannel，ui-prefs.json）；未记录过则
      // 回退 localStorage 记忆（升级前遗留）→ 最后按配置（sync-config.transport）
      const savedChannel: SyncChannel = info.transport?.type === 'webdav' ? 'webdav' : 'git'
      const remembered = info.lastSyncChannel ?? readStoredChannel()
      // 可同步分区目录回填（host adapters 唯一事实源；仅 portable；两通道共用）
      const catalog = info.syncSections !== undefined ? syncSectionOptions(info.syncSections) : []
      // 每通道回填：优先该通道的持久化配置（syncSelectionByChannel / autosyncByChannel）；
      // 无持久化 → 默认模式 + 推荐分区
      const selByCh = info.syncSelectionByChannel
      const autoByCh = info.autosyncByChannel
      const credByCh = info.syncCredentialsByChannel
      const backfill = (ch: SyncChannel, cur: ChannelSyncState): Partial<ChannelSyncState> => {
        const sel = selByCh?.[ch]
        const auto = autoByCh?.[ch]
        const cred = credByCh?.[ch]
        // 模式概念已从 UI 移除：分区恒由用户手动勾选（落盘 mode 恒为 advanced）。
        // 初始值 = initialSyncSections（首次 / 旧 default 模式 → 预勾选推荐分区；
        // 用户主动清空 → 保持为空，绝不悄悄填回来）
        const persistedSections = initialSyncSections(sel, info.syncSections ?? [])
        return {
          syncMode: 'advanced',
          syncSections: persistedSections,
          sessionsLimit: normalizeSessionsLimit(sel?.sessionsLimit),
          encrypt: sel?.encrypt ?? false,
          includeSecrets: sel?.includeSecrets ?? false,
          // 「密码已保存」来自本机凭据库（只回布尔）；凭据库里没有 → 复位
          encryptPasswordSaved: cred?.encryptPasswordConfigured ?? false,
          decryptPasswordSaved: cred?.decryptPasswordConfigured ?? false,
          autosyncEnabled: auto?.enabled ?? false,
          autosyncInterval: auto?.interval ?? '30m',
        }
      }
      patch({
        loading: false,
        statusInfo: info,
        channel: remembered ?? savedChannel,
        repoUrl: info.repoUrl ?? '',
        webdavUrl: info.webdav?.url ?? '',
        webdavUsername: info.webdav?.username ?? '',
        catalog,
        byChannel: {
          git: { ...stateRef.current.byChannel.git, ...backfill('git', stateRef.current.byChannel.git) },
          webdav: { ...stateRef.current.byChannel.webdav, ...backfill('webdav', stateRef.current.byChannel.webdav) },
        },
      })
      // 独立拉取 autosync（若 status 未带按通道状态则补一次）
      if (autoByCh === undefined) {
        void loadAutosync()
      }
      // 当前激活通道已配置且远端地址就绪时，自动拉取远端快照填充下拉（无需先点一键同步）；
      // 直接传 info 的地址（state.patch 尚未生效），避免竞态
      const activeCh = remembered ?? savedChannel
      const preset = activeCh === 'webdav' ? (info.webdav?.url ?? '') : (info.repoUrl ?? '')
      if (info.configured && preset.trim() !== '') {
        void loadSnapshots(preset, activeCh)
      }
      // 校验 GitHub token 有效性：已登录（有效）→ 隐藏 GitHub 登录块；未配置/失效 → 显示
      void validateGithub()
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 读取全部通道的自动同步状态（GET /sync/autosync 返回 { git, webdav }）。 */
  const loadAutosync = async (): Promise<void> => {
    try {
      const all = await api.autosyncStatusAll()
      patchChannelState('git', {
        autosync: all.git, autosyncEnabled: all.git.enabled, autosyncInterval: all.git.interval,
      })
      patchChannelState('webdav', {
        autosync: all.webdav, autosyncEnabled: all.webdav.enabled, autosyncInterval: all.webdav.interval,
      })
    } catch (err) {
      // R-20：读取自动同步状态失败（此前写入页面最底部的共享 error Banner，常滚出视野）
      toast.error(`${t('toast.autosyncLoadFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /**
   * 读取指定通道的远端历史快照列表（「选择历史快照」下拉数据源）。
   * urlOverride / channelOverride：挂载时地址刚从 status 回填、state.patch 尚未生效，
   * 直接传 info 的地址与通道避免竞态读旧值；缺省读当前 state。
   * 无远端地址时静默跳过（不发无效请求，下拉留空）。
   * announce：仅用户主动点「刷新快照」时为 true —— 成功给出回执，避免用户
   * 在「远端确实没有快照」与「刷新没生效」之间无从判断（M-18）。 */
  const loadSnapshots = async (urlOverride?: string, channelOverride?: SyncChannel, announce = false): Promise<void> => {
    const ch = channelOverride ?? stateRef.current.channel
    if (loadingSnapshotsRef.current[ch]) return
    loadingSnapshotsRef.current[ch] = true
    patchChannelState(ch, { loadingSnapshots: true })
    try {
      const s = stateRef.current
      if (ch === 'webdav') {
        const url = urlOverride ?? s.webdavUrl
        if (url.trim() === '') return
        // 带 username/password（非空时）：挂载早期 state 未回填 → undefined，Host 端回退持久化配置补 username
        const res = await api.snapshotsList({
          transport: 'webdav',
          url: url.trim(),
          username: s.webdavUsername.trim() !== '' ? s.webdavUsername.trim() : undefined,
          password: s.webdavPassword !== '' ? s.webdavPassword : undefined,
        })
        patchChannelState('webdav', { snapshots: res.snapshots })
      } else {
        const repo = urlOverride ?? s.repoUrl
        if (repo.trim() === '') return
        const res = await api.snapshotsList({
          transport: 'git',
          repoUrl: repo.trim(),
          token: s.token.trim() !== '' ? s.token.trim() : undefined,
        })
        patchChannelState('git', { snapshots: res.snapshots })
      }
      // M-18：用户主动点「刷新快照」成功后的回执（自动拉取/切换通道时不打扰）
      if (announce) toast.ok(t('toast.snapshotsRefreshed'))
    } catch (err) {
      // M-18/M-21：拉取远端快照失败原先完全静默（下拉留空），用户无法区分
      // 「远端确实没有快照」与「读取失败」。不阻断主流程，仅以 Toast 如实告知。
      toast.error(`${t('toast.snapshotsLoadFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    } finally {
      loadingSnapshotsRef.current[ch] = false
      patchChannelState(ch, { loadingSnapshots: false })
    }
  }

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 卸载时置挂载守卫 + 清理轮询定时器 + 补发未落盘的通道配置改动 + 最后镜像一次状态
   *  （组件销毁后不得再 setState/发请求；store 镜像为纯内存/白名单写，安全）。
   *  异步操作完成回调仍会走 commit 写 store（见 commit 注释），结果不丢。 */
  useEffect(() => () => {
    mountedRef.current = false
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // 关闭设置页前若还有未保存的改动：立即补发（host 侧落盘；此路径只发请求不 setState）
    const pending = pendingSave.current
    if (pending !== null) {
      void api.saveConfig(pending).catch(() => { /* 已卸载：静默，不打扰用户 */ })
    }
    // 最后镜像一次（防止「最后一次改动后立即切 tab」时 commit 之前的瞬态丢失）
    runStore.patch({ sync: toSyncStoreSlice(stateRef.current) })
  }, [])

  /** 表单快照 → 请求体（按当前通道构建；空串不携带；password 仅内存不发回显） */
  const payload = (): SyncPushPayload => {
    if (state.channel === 'webdav') {
      return {
        transport: 'webdav',
        url: state.webdavUrl.trim() !== '' ? state.webdavUrl.trim() : undefined,
        username: state.webdavUsername.trim() !== '' ? state.webdavUsername.trim() : undefined,
        password: state.webdavPassword !== '' ? state.webdavPassword : undefined,
      }
    }
    return {
      transport: 'git',
      repoUrl: state.repoUrl.trim(),
      token: state.token.trim() !== '' ? state.token : undefined,
    }
  }

  /* ------------------------------------------------ 通道配置持久化（自动保存 + 显式保存） */

  /** 按给定 state 构建「保存配置」请求体；当前通道远端地址未就绪（webdav url / git repoUrl 为空）
   *  → 返回 null（无可保存内容，自动保存跳过）。password/token 仅非空携带（空 = 沿用已保存凭据）。 */
  const buildConfigPayload = (s: SyncUiState): SyncPushPayload | null => {
    if (s.channel === 'webdav') {
      const url = s.webdavUrl.trim()
      if (url === '') return null
      return {
        transport: 'webdav',
        url,
        username: s.webdavUsername.trim() !== '' ? s.webdavUsername.trim() : undefined,
        password: s.webdavPassword !== '' ? s.webdavPassword : undefined,
      }
    }
    const repoUrl = s.repoUrl.trim()
    if (repoUrl === '') return null
    return {
      transport: 'git',
      repoUrl,
      token: s.token.trim() !== '' ? s.token.trim() : undefined,
    }
  }

  /** 实际发送保存请求：成功清空已入库的 password/token（与 push 一致）并刷新凭据徽章；
   *  失败保留表单值以便重试。防重入：保存中又排入新改动 → 完成后自动补发最新 payload。
   *  announce：仅「手动点保存」为 true —— 自动保存（输入防抖）成功时不弹 Toast，
   *  否则每次停顿改字段都会刷一条通知；但**失败必须始终提示**（用户的改动没落盘）。 */
  const doSaveConfig = async (payloadToSave: SyncPushPayload, announce = false): Promise<void> => {
    if (savingRef.current) {
      pendingSave.current = payloadToSave
      return
    }
    savingRef.current = true
    patch({ savingConfig: true })
    try {
      const saved = await api.saveConfig(payloadToSave)
      // 基于 stateRef 计算（同步权威），经 commit 落库：即使保存完成时组件已卸载
      // （切走 tab），savingConfig 复位与凭据清空仍会镜像进 store，切回后一致
      const s = stateRef.current
      const next: SyncUiState = { ...s, savingConfig: false }
      // 只清空「本次已写入的」password/token：若保存期间用户已改输入则保留新值
      next.webdavPassword = s.webdavPassword !== '' && s.webdavPassword !== payloadToSave.password
        ? s.webdavPassword
        : ''
      next.token = s.token !== '' && s.token !== payloadToSave.token ? s.token : ''
      // 凭据徽章合并（响应只含布尔，无 secret 值）
      if (s.statusInfo !== null) {
        const info: SyncStatusResponse = {
          ...s.statusInfo,
          configured: true,
          credentialConfigured: saved.credentialConfigured,
        }
        if (saved.webdav !== undefined) {
          info.webdav = {
            url: s.statusInfo.webdav?.url,
            username: s.statusInfo.webdav?.username,
            usernameConfigured: saved.webdav.usernameConfigured,
            passwordConfigured: saved.webdav.passwordConfigured,
          }
        }
        next.statusInfo = info
      }
      commit(next)
      // M-17：手动保存成功给出回执（自动保存静默，避免输入防抖刷屏）
      if (announce) toast.ok(t('toast.configSaved'))
      // 手动填入的 git token 保存成功 → 校验有效性（有效则隐藏 GitHub 登录块）
      if (payloadToSave.transport !== 'webdav' && saved.credentialConfigured) {
        void validateGithub()
      }
    } catch (err) {
      // R-20：保存失败**始终**提示（无论手动还是自动）——用户的改动没有落盘
      toast.error(`${t('toast.configSaveFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
      patch({ savingConfig: false })
    } finally {
      savingRef.current = false
      // 保存期间又排入的新改动 → 立即补发（保底，不丢输入）
      if (pendingSave.current !== null) {
        const p = pendingSave.current
        pendingSave.current = null
        void doSaveConfig(p, announce)
      }
    }
  }

  /** 表单改动 → 防抖 600ms 自动保存（取最新 state；地址未就绪时跳过）。 */
  const scheduleConfigSave = (): void => {
    const payloadToSave = buildConfigPayload(stateRef.current)
    pendingSave.current = payloadToSave
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    if (payloadToSave === null) {
      saveTimer.current = null
      return
    }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushConfigSave()
    }, 600)
  }

  /** 立即保存（「保存配置」按钮 / 防抖到点）：优先待发改动，否则按当前表单值。
   *  announce：仅手动点按钮为 true —— 自动保存成功不弹回执（见 doSaveConfig）。 */
  const flushConfigSave = (announce = false): void => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    pendingSave.current = null
    const payloadToSave = pending ?? buildConfigPayload(stateRef.current)
    if (payloadToSave === null) {
      // M-17：手动点保存但地址未填写 → 此前直接 return（按钮看起来无反应），现给出明确提示
      if (announce) toast.info(t('toast.configNothingToSave'))
      return
    }
    void doSaveConfig(payloadToSave, announce)
  }

  /* ------------------------------------------------ GitHub OAuth device flow */

  /** 发起 GitHub 登录：取设备码 → 展示一次性用户码 + 授权页 → 开始轮询 */
  const runGithubStart = async (): Promise<void> => {
    patchGithub({ phase: 'starting', error: null })
    try {
      const info = await api.githubStart()
      patchGithub({
        phase: 'waiting',
        flowId: info.flowId,
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        interval: info.interval,
      })
      scheduleGithubPoll(info.flowId, Math.max(info.interval, 1) * 1000)
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 排定一次 GitHub 轮询（先清旧定时器，避免重复轮询） */
  const scheduleGithubPoll = (flowId: string, delayMs: number): void => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    githubPollTimer.current = setTimeout(() => { void runGithubPoll(flowId) }, delayMs)
  }

  /** 轮询 GitHub 授权结果：pending 继续等；success 刷新凭据状态；终止态展示结果 */
  const runGithubPoll = async (flowId: string): Promise<void> => {
    patchGithub({ phase: 'polling' })
    try {
      const poll = await api.githubPoll(flowId)
      if (poll.status === 'pending') {
        patchGithub({ phase: 'waiting' })
        scheduleGithubPoll(flowId, poll.pollDelayMs ?? Math.max(state.github.interval, 1) * 1000)
        return
      }
      const message = githubPollMessage(poll, uiT)
      if (poll.status === 'success') {
        // token 已由宿主写入 DSH credentials：标记已登录（隐藏登录块）+ 刷新状态/凭据徽章
        patch({ githubSignedIn: true, github: { ...stateRef.current.github, phase: 'success', error: null } })
        void loadStatus()
      } else {
        patchGithub({ phase: 'error', error: message })
      }
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 取消登录：停轮询 + 通知宿主丢弃设备码登记 + 复位 UI */
  const runGithubCancel = async (): Promise<void> => {
    if (githubPollTimer.current !== null) {
      clearTimeout(githubPollTimer.current)
      githubPollTimer.current = null
    }
    const flowId = state.github.flowId
    patchGithub(initialGithub)
    if (flowId !== '') {
      try { await api.githubCancel(flowId) } catch { /* 取消失败无需打扰用户 */ }
    }
  }

  /**
   * 校验 GitHub token 是否有效（「已登录」判定 → 决定登录块显隐）。
   * 挂载 / 登录成功 / 保存凭据后调用；已确认登录（githubSignedIn===true）时跳过
   * （避免反复网络调用）。401 → 未登录：显示登录块并提示重新登录；网络等其余
   * 错误 → 保持现状（不误判登出，已登录用户不被打扰；下次进入页面会再校验）。
   */
  const validateGithub = async (): Promise<void> => {
    if (stateRef.current.githubSignedIn === true) return
    try {
      const res = await api.githubValidate()
      patch({ githubSignedIn: res.configured && res.valid })
    } catch {
      // 校验失败（网络/限流等）：不可知 → 维持现状（null 隐藏 / 既有值不变）
    }
  }

  /* ------------------------------------------------ 通道配置弹窗（弹窗驱动，DESIGN.md §8.12 同体系） */

  /** 打开通道配置弹窗：登录态尚未校验时补一次校验（决定 Git 子 tab 登录块显隐）。 */
  const openChannelDialog = (): void => {
    setChannelOpen(true)
    if (stateRef.current.githubSignedIn === null) void validateGithub()
  }

  /**
   * 关闭通道配置弹窗 = 放弃本次操作（§8.12 约定）：GitHub 登录流程进行中则取消
   * （停轮询 + 通知宿主丢弃设备码登记），保存中（savingConfig）时禁止关闭。
   */
  const closeChannelDialog = (): void => {
    if (stateRef.current.savingConfig) return
    const phase = stateRef.current.github.phase
    if (phase === 'starting' || phase === 'waiting' || phase === 'polling') {
      void runGithubCancel()
    }
    setChannelOpen(false)
  }

  /** 组装 push/preview 的公共载荷（分区选择 + 加密选项；密码仅内存） */
  const buildPushPayload = (): SyncPushPayload & { encryptPassword?: string } => {
    // 默认模式：不传 sections（= 全部 portable 推荐分区）；自定义模式：传勾选分区
    const selection = chState.syncSections.length > 0 ? { sections: chState.syncSections } : {}
    // 历史会话（可选分区）：只有真的勾选了 sessions 才携带选项 —— Host 侧没有该选项时
    // 会把会话分区当普通非 portable 分区跳过（安全默认，绝不悄悄上行）。
    const sessionsOpt = chState.syncSections.includes('sessions')
      ? { sessions: { limit: chState.sessionsLimit } }
      : {}
    // 加密快照：勾选加密 → 携带密码（请求体内存传输；留空时 Host 用本机凭据库里的已保存密码）；
    // includeSecrets 必须伴随 encrypt（Host 安全断言兜底）
    const cryptoOpts =
      chState.encrypt || chState.includeSecrets
        ? { encrypt: true, encryptPassword: chState.encryptPassword, includeSecrets: chState.includeSecrets }
        : {}
    return { ...payload(), ...selection, ...sessionsOpt, ...cryptoOpts }
  }

  /** P0-②：push 前只读预览（弹窗确认流程第一步）——不写远端，只展示「将推送什么」。 */
  const runPushPreview = async (): Promise<void> => {
    patch({ busy: 'push', pushReport: null, pullReport: null })
    try {
      // 预览前先把加密密码落库（用户不必手动保存；失败只提示，不阻断预览）
      await persistEncryptPassword()
      const preview = await api.pushPreview(buildPushPayload())
      patch({ busy: null, pushPreview: { preview, open: true } })
    } catch (err) {
      // R-20：预览失败（此前写共享 error Banner，渲染在页面最底部而按钮在中部）
      patch({ busy: null })
      toast.error(`${t('toast.pushPreviewFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** P0-②：确认弹窗里点「确认推送」→ 真正推送（复用既有 push 语义）。 */
  const runPush = async (): Promise<void> => {
    patch({ busy: 'push', pushReport: null, pullReport: null })
    try {
      // 推送前先把加密密码落库（下次推送不必重输）
      await persistEncryptPassword()
      const report = await api.push(buildPushPayload())
      // 成功即清空 token/webdavPassword/加密密码输入框；失败保留以便重试
      patch({
        busy: null, pushReport: report, pushPreview: { preview: null, open: false },
        ...(report.ok
          ? { token: '', webdavPassword: '' }
          : {}),
      })
      if (report.ok) {
        // 输入框清空，但「已保存」标记保留 —— 密码在本机凭据库里，下次留空即用
        patchChannel({ encryptPassword: '', encryptPasswordConfirm: '' })
        // M-19：推送终局回执（结果弹窗关闭后不再有任何痕迹）
        toast.ok(t('toast.pushDone'))
        void loadSnapshots()
      } else {
        // 失败保留结果弹窗（K-15，含告警明细）；同时给出不依赖弹窗的回执
        toast.error(t('toast.pushFailed'))
      }
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.pushFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  const runPull = async (): Promise<void> => {
    patch({ busy: 'pull', pullReport: null, pushReport: null })
    try {
      // 解密密码（可选）：先落库再拉取，下次不必重输。留空时由 Host 用本机凭据库里
      // 已保存的密码 —— 且只在远端快照确实加密时才会被使用（engine.prepareSnapshot 判定）。
      await persistDecryptPassword()
      const decrypt =
        chState.decryptPassword !== '' ? { decryptPassword: chState.decryptPassword } : {}
      const report = await api.pull({ ...payload(), ...decrypt })
      patch({ busy: null, pullReport: report, token: '', webdavPassword: '' })
      patchChannel({ decryptPassword: '' })
      // M-19：拉取终局回执（弹窗关闭后无痕迹）
      toast.ok(t('toast.pullDone'))
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.pullFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /* ------------------------------------------------ 同步模式（默认/自定义） */

  /**
   * 保存当前通道的分区选择 + 加密选项到 Host（持久化；自动同步与手动 push 共用）。
   *
   * 同时是**同步密码的唯一落库入口**：带 encryptPassword / decryptPassword 时写入本机
   * 凭据库（DSH credentials，值永不进 sync-selection.json / 日志 / 响应）；带 clear* 时
   * 主动删除（用户取消勾选加密、或点「删除已保存密码」）。
   * 失败只提示不阻断本地 UI（选择已即时生效；下次改动会重新落盘）。
   */
  const saveSelection = async (p: SelectionPatch = {}): Promise<void> => {
    const ch = stateRef.current.channel
    const cur = stateRef.current.byChannel[ch]
    try {
      const res = await api.saveSelection({
        transport: ch,
        // 恒 advanced：勾选集合就是同步范围（UI 已无模式概念）
        mode: 'advanced',
        sections: p.sections ?? cur.syncSections,
        sessionsLimit: p.sessionsLimit ?? cur.sessionsLimit,
        encrypt: p.encrypt ?? cur.encrypt,
        includeSecrets: p.includeSecrets ?? cur.includeSecrets,
        ...(p.encryptPassword !== undefined && p.encryptPassword !== '' ? { encryptPassword: p.encryptPassword } : {}),
        ...(p.decryptPassword !== undefined && p.decryptPassword !== '' ? { decryptPassword: p.decryptPassword } : {}),
        ...(p.clearEncryptPassword === true ? { clearEncryptPassword: true } : {}),
        ...(p.clearDecryptPassword === true ? { clearDecryptPassword: true } : {}),
      })
      // 回填「已保存」布尔（Host 只回状态，永不回值）
      patchChannelState(ch, {
        encryptPasswordSaved: res.encryptPasswordConfigured === true,
        decryptPasswordSaved: res.decryptPasswordConfigured === true,
      })
    } catch (err) {
      // R-20/M-22：同步设置持久化失败（此前写共享 error Banner，与刚点的按钮相距整屏）
      toast.error(t('toast.selectionSaveFailed') + '：' + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 当前通道同步分区勾选开关（增删 byChannel 勾选并立即持久化）。 */
  const toggleSyncSection = (id: SectionId, checked: boolean): void => {
    const cur = stateRef.current.byChannel[stateRef.current.channel].syncSections
    const next = checked
      ? (cur.includes(id) ? cur : [...cur, id])
      : cur.filter((s) => s !== id)
    patchChannel({ syncSections: next })
    void saveSelection({ sections: next })
  }

  /** 历史会话（sessions）「最新 N 个」上限（弹窗内数字输入；即时持久化）。 */
  const setSessionsLimit = (value: number): void => {
    const next = normalizeSessionsLimit(value)
    patchChannel({ sessionsLimit: next })
    void saveSelection({ sessionsLimit: next })
  }

  /**
   * 当前通道加密备份开关（持久化）。取消时：一并取消导出密钥 + **删除已保存的加密密码**
   * （用户要求：手动取消勾选即清除保存的密码），并清空输入框（密钥必须加密，安全底线）。
   */
  const setEncrypt = (next: boolean): void => {
    patchChannel({
      encrypt: next,
      includeSecrets: next ? chState.includeSecrets : false,
      ...(next ? {} : { encryptPassword: '', encryptPasswordConfirm: '', encryptPasswordSaved: false }),
    })
    void saveSelection({
      encrypt: next,
      includeSecrets: next ? chState.includeSecrets : false,
      ...(next ? {} : { clearEncryptPassword: true }),
    })
  }

  /** 当前通道导出密钥开关（持久化）。勾选时自动联动选中加密（密钥绝不明文进同步通道）。 */
  const setIncludeSecrets = (next: boolean): void => {
    patchChannel({ includeSecrets: next, encrypt: next ? true : chState.encrypt })
    void saveSelection({ includeSecrets: next, encrypt: next ? true : chState.encrypt })
  }

  /**
   * 加密密码落库（输入框失焦 / 推送前触发）。两个输入框都有值且一致才写 ——
   * 半截密码绝不入库（否则下次会拿一个错误密码去加密备份）。
   */
  const persistEncryptPassword = async (): Promise<void> => {
    const cs = stateRef.current.byChannel[stateRef.current.channel]
    if (cs.encryptPassword === '' || cs.encryptPassword !== cs.encryptPasswordConfirm) return
    await saveSelection({ encryptPassword: cs.encryptPassword })
  }

  /** 解密密码落库（输入框失焦 / 拉取前触发）。空串不写（删除请用「删除已保存密码」）。 */
  const persistDecryptPassword = async (): Promise<void> => {
    const cs = stateRef.current.byChannel[stateRef.current.channel]
    if (cs.decryptPassword === '') return
    await saveSelection({ decryptPassword: cs.decryptPassword })
  }

  /** 删除已保存的解密密码（用户主动删除；输入框内容一并清空）。 */
  const clearSavedDecryptPassword = (): void => {
    patchChannel({ decryptPassword: '', decryptPasswordSaved: false })
    void saveSelection({ clearDecryptPassword: true })
  }

  /* ------------------------------------------------ 一键同步（方案 A） */

  /** 一键同步：拉取 → 差异确认会话（先取消旧会话，再发起新会话）。 */
  const runSync = async (snapshotId?: string): Promise<void> => {
    // 清理旧的差异确认会话（避免残留临时 ZIP / 同 key 冲突）
    if (state.confirmSession !== null) {
      try { await api.cancel(state.confirmSession.syncSessionId) } catch { /* 尽力清理 */ }
    }
    patch({ busy: 'sync', confirmSession: null, confirmDecisions: null, lastRestoreId: null })
    try {
      // 解密密码（可选）：先落库再同步；留空时 Host 用本机凭据库里已保存的密码
      await persistDecryptPassword()
      const decrypt =
        chState.decryptPassword !== '' ? { decryptPassword: chState.decryptPassword } : {}
      const session = await api.sync({
        ...payload(),
        ...(snapshotId !== undefined && snapshotId !== '' ? { snapshotId } : {}),
        ...decrypt,
      })
      if (!session.ok) {
        // R-20：一键同步启动失败（宿主明确回报 message，无异常抛出）
        patch({ busy: null })
        toast.error(`${t('toast.syncStartFailed')}：${redact(session.message ?? t('syncflow.syncFailed'))}`)
        return
      }
      patch({ busy: null, confirmSession: session, confirmDecisions: null, token: '', webdavPassword: '' })
      patchChannel({ decryptPassword: '' })
      void loadSnapshots()
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.syncStartFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** 用户取消差异确认：清除会话，复位到空闲。 */
  const cancelConfirm = (): void => {
    patch({ confirmSession: null, confirmDecisions: null })
  }

  /** 从 SyncConfirmView 透传的一键回滚完成信号。 */
  const onRollbackApplied = (): void => {
    patch({ lastRestoreId: null })
  }

  /* ------------------------------------------------ 通道子 tab 切换 */

  /** 切换通道子 tab：记录偏好 + 拉取目标通道远端快照。busy 时禁用切换（防并发操作）。 */
  const switchChannel = (ch: SyncChannel): void => {
    if (ch === state.channel || state.busy !== null) return
    patch({ channel: ch })
    writeStoredChannel(ch) // 同步写 localStorage 立即生效（status 未带回填时的兜底）
    // 异步持久化到磁盘（ui-prefs.json，随 self 分区进导出备份）；失败静默降级
    void api.saveUiPrefs({ lastSyncChannel: ch }).catch(() => { /* 保存失败不阻断切换 */ })
    void loadSnapshots(undefined, ch)
  }

  /* ------------------------------------------------ 自动同步（按通道） */

  const toggleAutosync = async (enabled: boolean): Promise<void> => {
    patchChannel({ autosyncEnabled: enabled })
    try {
      const updated = await api.autosyncUpdate({ transport: state.channel, enabled, interval: chState.autosyncInterval })
      patchChannel({ autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
      // M-20：乐观更新已生效，补一条终局回执确认宿主已受理
      toast.ok(t('toast.autosyncUpdated'))
    } catch (err) {
      // R-20/M-20：失败必须提示 —— 界面是乐观更新，用户会以为开关已生效
      toast.error(`${t('toast.autosyncUpdateFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  const updateAutosyncInterval = async (interval: AutosyncInterval): Promise<void> => {
    patchChannel({ autosyncInterval: interval })
    try {
      const updated = await api.autosyncUpdate({ transport: state.channel, enabled: chState.autosyncEnabled, interval })
      patchChannel({ autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
      toast.ok(t('toast.autosyncUpdated'))
    } catch (err) {
      toast.error(`${t('toast.autosyncUpdateFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** 活动通道的远端地址是否就绪（git=repoUrl 非空；webdav=webdavUrl 非空） */
  const remoteReady = computeRemoteReady(state.channel, state.repoUrl, state.webdavUrl)
  const buttons = computeSyncButtons(state.busy, remoteReady, uiT)
  const pushView = pushReportView(state.pushReport, uiT)
  const pullView = pullReportView(state.pullReport, uiT)
  const githubView = computeGithubLoginView(
    state.github.phase, state.github.userCode, state.github.verificationUri, state.github.error, uiT,
  )
  /** GitHub 流程进行中（请求设备码 / 等待授权 / 轮询）：禁用 push/pull，避免无凭据操作 */
  const githubBusy =
    state.github.phase === 'starting' || state.github.phase === 'waiting' || state.github.phase === 'polling'

  /** 勾选为空 → 禁止推送（勾选集合就是同步范围）。 */
  const pushSelectionReady = chState.syncSections.length > 0

  /**
   * 加密推送校验：勾选加密时，要么本机凭据库里已有密码（输入框留空即沿用），
   * 要么两个输入框都填了且一致。密码本身只在内存 / 凭据库中出现。
   */
  const encryptInvalid =
    (chState.encrypt || chState.includeSecrets) &&
    (
      // 输入框填了 → 必须与确认框一致
      (chState.encryptPassword !== '' && chState.encryptPassword !== chState.encryptPasswordConfirm) ||
      // 输入框留空 → 必须已经有保存好的密码
      (chState.encryptPassword === '' && !chState.encryptPasswordSaved)
    )

  const autosyncText = chState.autosync !== null ? autosyncStatusText(chState.autosync, uiT) : t('autosync.statusNever')
  /** 距下次自动同步剩余 ms（null = 从未运行；0 = 已到期） */
  const autosyncCountdownMs = chState.autosync !== null && chState.autosync.elapsedMs >= 0
    ? computeAutosyncCountdown(chState.autosync.elapsedMs, autosyncIntervalMs(chState.autosync.interval))
    : null

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

          {/* M-16：页面级加载失败就地提示（此前 loadError 只写不读，宿主不可达时整页显示
              「未配置」假象）。此处保留可就地重试的 ErrorBanner —— 它是**页面是否可用**
              的前提条件，必须常驻到用户重试成功，不能交给会自动消失的 Toast。 */}
          {state.loadError !== null && (
            <ErrorBanner
              error={`${t('load.failed')}：${redact(state.loadError)}`}
              onRetry={() => { void loadStatus() }}
              retrying={state.loading}
              t={api.t}
            />
          )}

          {/* 同步通道入口卡：通道配置改为弹窗驱动（点按钮 → 弹窗内配置 Git/WebDAV 通道；
              弹窗样式复用市场操作弹窗体系，DESIGN.md §8.12） */}
          <Card>
            <span className={css.groupLabel}>{t('channel.title')}</span>
            <span className={css.hint}>{t('channel.openHint')}</span>
            <div className={css.statRow}>
              <Badge kind="info">{state.channel === 'webdav' ? t('channel.webdav') : t('channel.git')}</Badge>
              <Badge kind={remoteReady ? 'ok' : 'warn'}>
                {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
              </Badge>
              {state.channel === 'git' && state.statusInfo?.credentialConfigured === true && (
                <Badge kind="ok">{t('config.tokenSaved')}</Badge>
              )}
              {state.channel === 'webdav' && state.statusInfo?.webdav?.passwordConfigured === true && (
                <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>
              )}
            </div>
            {/* 状态事实行（Workbench：配置状态/上次同步/可同步分区——未配置时也要给硬事实） */}
            <div className={css.factGrid} style={{ marginTop: 8 }}>
              <div className={css.factCell}>
                <span className={css.factLabel}>{t('syncStatus.state')}</span>
                <span className={css.factValue}>
                  {state.statusInfo?.configured === true ? t('channel.configured') : t('channel.notConfigured')}
                </span>
              </div>
              <div className={css.factCell}>
                <span className={css.factLabel}>{t('syncStatus.lastSync')}</span>
                <span className={css.factValue}>
                  {state.statusInfo?.lastSyncAt !== undefined
                    ? new Date(state.statusInfo.lastSyncAt).toLocaleString()
                    : '—'}
                </span>
              </div>
              {state.statusInfo?.sectionCount !== undefined && (
                <div className={css.factCell}>
                  <span className={css.factLabel}>{t('syncStatus.sections')}</span>
                  <span className={`${css.factValue} ${css.mono}`}>{String(state.statusInfo.sectionCount)}</span>
                </div>
              )}
              {remoteReady && (
                <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.factLabel}>{t('channel.currentUrl')}</span>
                  <span className={css.factValue}>
                    <span className={css.mono}>
                      {(state.channel === 'webdav' ? state.webdavUrl : state.repoUrl).slice(0, 60)}
                    </span>
                  </span>
                </div>
              )}
            </div>
            <div className={css.actionRowTop}>
              <Button variant="primary" onClick={openChannelDialog}>
                {t('channel.open')}
              </Button>
            </div>
          </Card>

          {/* 通道配置弹窗（Radix Modal 统一 a11y：focus-trap / Esc / 焦点还原 / 滚动锁；
              内含推送预览/推送结果/拉取结果/一键同步确认四个嵌套 Modal，Radix 支持嵌套弹窗） */}
          <Modal
            open={channelOpen}
            onClose={closeChannelDialog}
            title={t('channel.title')}
            wide
            busy={state.savingConfig}
          >
            <Modal.Header
              title={t('channel.title')}
              closeLabel={t('common.close')}
              onClose={closeChannelDialog}
              closeDisabled={state.savingConfig}
            />
            <Modal.Body scroll>

          {/* 通道子 tab：GitHub / WebDAV（modeTabs 样式；两通道设置各自独立） */}
          <div className={css.modeTabs} role="tablist">
            {channelTabModels(state.channel, state.busy !== null || state.savingConfig).map((tab) => (
              <button
                key={tab.channel}
                type="button"
                role="tab"
                aria-selected={tab.active}
                data-active={tab.active ? '' : undefined}
                className={css.modeTab}
                disabled={tab.disabled}
                onClick={() => { switchChannel(tab.channel) }}
              >
                {tab.channel === 'webdav' ? t('channel.webdav') : t('channel.git')}
              </button>
            ))}
          </div>
          <div className={css.modeHint}>{t('channel.perChannelHint')}</div>

          {/* 私有仓库强制提示：仅 git 通道适用 */}
          {state.channel === 'git' && <Banner kind="warn">{privateRepoHint(uiT)}</Banner>}

            {/* git 通道分支 */}
            {state.channel === 'git' && (
              <>
                <span className={css.groupLabel}>{t('config.title')}</span>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('config.repoUrl')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.repoUrl}
                    placeholder="https://github.com/user/private-repo.git"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ repoUrl: e.target.value })
                      scheduleConfigSave() // 改动自动保存（防抖；关闭设置页不丢输入）
                    }}
                  />
                  <span className={css.hint}>{t('config.repoUrlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('config.token')}
                    {' '}
                    {state.statusInfo?.credentialConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.token}
                    autoComplete="off"
                    placeholder={t('config.tokenPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ token: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                </label>

                {/* GitHub OAuth 登录（device flow）：弹窗内仅 git 通道显示；已登录（token 有效）时整块隐藏 */}
                {state.githubSignedIn === false && (
                  <>
                    {state.statusInfo?.credentialConfigured === true && (
                      <Banner kind="warn">{t('github.tokenInvalid')}</Banner>
                    )}
                    <span className={css.groupLabel}>{t('github.title')}</span>
                    <span className={css.hint}>{t('github.description')}</span>
                    {githubView.showCode && (
                      <div className={css.statRow}>
                        <Badge kind="info">{t('github.userCode')}：<strong>{githubView.userCode}</strong></Badge>
                        <a
                          className={css.ghostButton}
                          href={githubView.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: 'none' }}
                        >
                          {t('github.openAuth')}
                        </a>
                      </div>
                    )}
                    <div className={css.actionRow}>
                      <Button
                        variant="primary"
                        disabled={!githubView.canStart || state.busy !== null}
                        onClick={() => { void runGithubStart() }}
                      >
                        {githubView.startLabel}
                      </Button>
                      {githubView.canCancel && (
                        <Button disabled={state.busy !== null} onClick={() => { void runGithubCancel() }}>
                          {t('github.cancel')}
                        </Button>
                      )}
                    </div>
                    <div className={css.statRow}>
                      <Badge kind={githubView.phase === 'success' ? 'ok' : githubView.phase === 'error' ? 'error' : 'warn'}>
                        {githubView.statusText}
                      </Badge>
                    </div>
                    {githubView.phase === 'error' && (
                      <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                    )}
                  </>
                )}
              </>
            )}

            {/* webdav 通道分支 */}
            {state.channel === 'webdav' && (
              <>
                <span className={css.groupLabel}>{t('webdav.title')}</span>
                {/* 常见 WebDAV 服务器预设：选择后填充 url 模板（含占位符待替换） */}
                <span className={css.hint}>{t('webdav.presetHint')}</span>
                <select
                  className={css.select}
                  value={presetIdForUrl(state.webdavUrl)}
                  disabled={state.busy !== null}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const p = presetById(e.target.value)
                    patch({ webdavUrl: p.url })
                    scheduleConfigSave()
                  }}
                >
                  {WEBDAV_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('webdav.url')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUrl}
                    placeholder="https://dav.example.com/dav/config"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavUrl: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.urlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.username')}
                    {' '}
                    {state.statusInfo?.webdav?.usernameConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUsername}
                    autoComplete="off"
                    placeholder="alice"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavUsername: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.usernameHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.password')}
                    {' '}
                    {state.statusInfo?.webdav?.passwordConfigured === true && <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.webdavPassword}
                    autoComplete="off"
                    placeholder={t('webdav.passwordPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavPassword: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.passwordHint', { ref: SYNC_WEBDAV_CREDENTIAL_REF })}</span>
                </label>
              </>
            )}

            {/* 配置保存：改动自动保存（防抖，静默）；按钮立即保存并给出 Toast 回执（announce=true） */}
            <div className={css.actionRow}>
              <Button
                variant="primary"
                disabled={state.busy !== null || state.savingConfig || !remoteReady}
                onClick={() => { flushConfigSave(true) }}
              >
                {state.savingConfig ? <Spinner label={t('config.saving')} /> : t('config.save')}
              </Button>
            </div>
            <span className={css.hint}>{t('config.saveHint')}</span>
            </Modal.Body>
          </Modal>

          {/* 同步分区（当前通道）：全部选择收敛进「选择同步分区」弹窗（点按钮打开）。
              **没有「快速导出 / 自定义导出」之分** —— 勾选集合就是同步范围。 */}
          <Card>
            <span className={css.groupLabel}>{t('mode.title')}</span>
            <span className={css.hint}>{t('mode.hint')}</span>
            <span className={css.categoryDesc}>
              {state.catalog.length === 0
                ? t('common.loading')
                : t('mode.selectedCount', { n: String(chState.syncSections.length) })}
            </span>
            {/* .actionRowTop = 上方紧跟说明文案的操作行（自带 10px 上边距）：
                普通 .actionRow 没有上边距，按钮会与上面的计数文字贴在一起。 */}
            <div className={css.actionRowTop}>
              <Button onClick={() => { setSectionPickerOpen(true) }} disabled={state.busy !== null}>
                {t('mode.choose')}
              </Button>
            </div>
            {chState.syncSections.length === 0 && <Banner kind="warn">{t('mode.atLeastOne')}</Banner>}
            <span className={css.hint}>{t('mode.persistHint')}</span>
          </Card>

          {/* 同步分区弹窗（Radix Modal，与通道配置弹窗同一体系）：分组勾选 + 「最新 N 个会话」。
              分区一律由用户手动勾选（没有模式分段）。改动**即时生效并持久化**
              （与导出选择器一致的弹窗语义），因此底部只有「完成」——没有「取消」
              （取消会让用户以为改动被丢弃）。 */}
          <Modal
            open={sectionPickerOpen}
            onClose={() => { setSectionPickerOpen(false) }}
            title={t('mode.pickerTitle')}
            wide
          >
            <Modal.Header
              title={t('mode.pickerTitle')}
              closeLabel={t('common.close')}
              onClose={() => { setSectionPickerOpen(false) }}
            />
            <Modal.Body scroll style={{ maxHeight: '66vh' }}>
              <span className={css.hint}>{t('mode.pickerHint')}</span>
              {state.catalog.length === 0 ? (
                <span className={css.hint}>{t('common.loading')}</span>
              ) : (
                /* 分组勾选目录：与「导出备份·自定义模式」同构（分组 Card + 名称/描述/徽章），
                   分区名走 section-labels 单一映射 —— 与导出选择器显示**同一个中文名**。 */
                <div className={css.groupList}>
                  {syncSectionGroups(state.catalog).map((g) => (
                    <Card key={g.group} className={css.groupCard}>
                      <div className={css.groupHeader}>
                        <span className={css.groupLabel}>{g.label}</span>
                        {g.note !== undefined && <span className={css.groupNote}>{g.note}</span>}
                      </div>
                      <div className={css.groupItems}>
                        {g.items.map((s) => (
                          <div key={s.id} className={css.sectionOptionRow}>
                            <Checkbox
                              checked={chState.syncSections.includes(s.id)}
                              onChange={(checked) => { toggleSyncSection(s.id, checked) }}
                              label={
                                <span className={css.categoryItem}>
                                  {/* 分区显示名只经 sectionLabeler（禁止在本文件另建一套名字） */}
                                  <span className={css.categoryName}>{sectionName(s.id)}</span>
                                  <span className={css.categoryDesc}>{s.description}</span>
                                  {s.portability === 'portable' && <Badge kind="info">{t('mode.sectionPortable')}</Badge>}
                                  {s.portability === 'deviceSpecific' && (
                                    <Badge kind="warn">{t('mode.sectionDeviceSpecific')}</Badge>
                                  )}
                                  {s.defaultIncluded && <Badge kind="ok">{t('mode.sectionRecommended')}</Badge>}
                                </span>
                              }
                            />
                            {/* 历史会话专属参数：只带「最新 N 个」（默认 5），避免整棵会话树上行。
                                必须放在 Checkbox **之外** —— Checkbox 内部是 label 元素，
                                把输入控件放进去会让点输入框也切换勾选。 */}
                            {s.id === 'sessions' && chState.syncSections.includes('sessions') && (
                              <label className={css.field}>
                                <span className={css.fieldLabel}>{t('mode.sessionsLimit')}</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={10000}
                                  className={css.input}
                                  value={String(chState.sessionsLimit)}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                    setSessionsLimit(e.target.value === '' ? DEFAULT_SYNC_SESSIONS_LIMIT : Number(e.target.value))
                                  }}
                                />
                                <span className={css.hint}>{t('mode.sessionsLimitHint')}</span>
                              </label>
                            )}
                          </div>
                        ))}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
              <span className={css.hint}>{t('mode.sectionsHint')}</span>
              {chState.syncSections.length === 0 && <Banner kind="warn">{t('mode.atLeastOne')}</Banner>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" onClick={() => { setSectionPickerOpen(false) }}>{t('mode.pickerDone')}</Button>
            </Modal.Footer>
          </Modal>

          {/* 加密与密钥导出（当前通道手动推送；仿「导出备份·自定义模式」安全选项） */}
          <Card>
            <span className={css.groupLabel}>{t('mode.security')}</span>
            <Checkbox
              checked={chState.encrypt}
              onChange={setEncrypt}
              label={<span className={css.categoryName}>{t('mode.encrypt')}</span>}
            />
            <div className={css.hint}>{t('mode.encryptHint')}</div>
            {chState.encrypt && chState.encryptPasswordSaved && (
              <div className={css.hint}>{t('mode.passwordSavedHint')}</div>
            )}
            {chState.encrypt && (
              <div className={css.secretFields}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('mode.password')}</span>
                  <input
                    type="password"
                    className={css.input}
                    value={chState.encryptPassword}
                    autoComplete="new-password"
                    placeholder={chState.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patchChannel({ encryptPassword: e.target.value }) }}
                    // 失焦即落库（两个框一致才写）——用户不必手动保存，下次留空即沿用
                    onBlur={() => { void persistEncryptPassword() }}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('mode.passwordConfirm')}</span>
                  <input
                    type="password"
                    className={css.input}
                    value={chState.encryptPasswordConfirm}
                    autoComplete="new-password"
                    placeholder={chState.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patchChannel({ encryptPasswordConfirm: e.target.value }) }}
                    onBlur={() => { void persistEncryptPassword() }}
                  />
                </label>
                {chState.encryptPassword !== '' && chState.encryptPassword !== chState.encryptPasswordConfirm && (
                  <span className={css.formError}>{t('mode.passwordMismatch')}</span>
                )}
                {chState.encryptPassword === '' && !chState.encryptPasswordSaved && (
                  <span className={css.formError}>{t('mode.passwordRequired')}</span>
                )}
                <span className={css.hint}>{t('mode.passwordClearNotice')}</span>
              </div>
            )}
            <Checkbox
              checked={chState.includeSecrets}
              onChange={setIncludeSecrets}
              label={<span className={css.categoryName}>{t('mode.includeSecrets')}</span>}
            />
            <div className={css.hint}>{t('mode.includeSecretsHint')}</div>
            <span className={css.hint}>{t('mode.encryptAutosyncNotice')}</span>
          </Card>

          {/* 解密密码（当前通道拉取/一键同步加密快照用；输入即保存到本机凭据库） */}
          <Card>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('mode.decryptPassword')}</span>
              <input
                type="password"
                className={css.input}
                value={chState.decryptPassword}
                autoComplete="off"
                placeholder={chState.decryptPasswordSaved ? t('mode.decryptPasswordPlaceholder') : undefined}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { patchChannel({ decryptPassword: e.target.value }) }}
                onBlur={() => { void persistDecryptPassword() }}
              />
              <span className={css.hint}>{t('mode.decryptPasswordHint')}</span>
            </label>
            {chState.decryptPasswordSaved && (
              <div className={css.actionRow}>
                <span className={css.hint}>{t('mode.decryptPasswordSaved')}</span>
                {/* 危险语义：删除本机已保存的密码（不可逆，用户主动操作） */}
                <Button size="sm" variant="danger" onClick={clearSavedDecryptPassword}>
                  {t('mode.clearSavedPassword')}
                </Button>
              </div>
            )}
          </Card>

          {/* 一键同步 + 手动推送/拉取（当前通道） */}
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={state.busy !== null || !remoteReady}
              onClick={() => { void runSync() }}
            >
              {state.busy === 'sync' ? <Spinner label={t('syncflow.syncing')} /> : t('syncflow.button')}
            </Button>
            <Button disabled={!buttons.canPush || githubBusy || !pushSelectionReady || encryptInvalid} onClick={() => { void runPushPreview() }}>
              {state.busy === 'push' ? <Spinner label={buttons.pushLabel} /> : buttons.pushLabel}
            </Button>
            <Button disabled={!buttons.canPull || githubBusy} onClick={() => { void runPull() }}>
              {state.busy === 'pull' ? <Spinner label={buttons.pullLabel} /> : buttons.pullLabel}
            </Button>
          </div>

          {/* 选择历史快照下拉（当前通道远端快照，支持点击/展开即刷新与主动刷新按钮）
              —— 下拉与刷新按钮强制同一行：容器 nowrap + label 可收缩（minWidth:0），
              按钮包 flex:none 的 pickerAction 保宽度，窄画布下不再换行。
              行距归属：空态 hint 存在时由它承担底部 10px，不存在时由本行承担，
              保证与下一张卡片的间距在任何状态下都不丢 */}
          <div
            className={css.snapshotPickerRow}
            style={{ marginBottom: chState.snapshots.length === 0 && !chState.loadingSnapshots ? 0 : 10 }}
          >
            {/* 同基线依赖两点，缺一仍差 10px（实测）：
                ① 空态 hint 移出本 label（见下方独立一行），否则 label 高 = fieldLabel
                   + select + hint，按钮底部对齐到含 hint 的 label 底；
                ② 清掉 label 自带的 margin:0 0 10px —— 容器是 align-items:flex-end，
                   按 margin box 对齐，该 margin 会把按钮再压低 10px。
                两点均由 CSS 承担：label 的归零见 styles 里 `.snapshotPickerRow .field`，
                本行底部 10px 间距由 `.snapshotPickerHint` 或下方容器的条件 marginBottom 提供。 */}
            <label className={css.field} style={{ flex: '1 1 auto', minWidth: 0 }}>
              <span className={css.fieldLabel}>{t('syncflow.selectSnapshot')}</span>
              <select
                className={css.select}
                value={chState.selectedSnapshotId}
                disabled={state.busy !== null}
                onFocus={() => { void loadSnapshots() }}
                onMouseDown={() => { void loadSnapshots() }}
                onClick={() => { void loadSnapshots() }}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const id = e.target.value
                  patchChannel({ selectedSnapshotId: id })
                  void runSync(id === '' ? undefined : id)
                }}
              >
                <option value="">{t('syncflow.latestSnapshot')}</option>
                {chState.snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}{t('syncflow.snapshotOption', { date: s.createdAt.slice(0, 10), count: String(s.sectionCount) })}
                  </option>
                ))}
              </select>
            </label>
            <span className={css.pickerAction}>
              <Button
                disabled={state.busy !== null || chState.loadingSnapshots || !remoteReady}
                onClick={() => { void loadSnapshots(undefined, undefined, true) }}
                title={t('syncflow.refreshSnapshots')}
              >
                {chState.loadingSnapshots ? (
                  <Spinner label={t('syncflow.refreshingSnapshots')} />
                ) : (
                  <><RefreshIcon size={14} /> {t('syncflow.refreshSnapshots')}</>
                )}
              </Button>
            </span>
          </div>
          {/* 空态提示独立成行（移出 label）：label 高度 = fieldLabel + select，
              刷新按钮与之底部对齐即真正同一行，不再被 hint 顶高错位。
              底部 10px 间距由本行承担，故上方容器的 marginBottom 归零 */}
          {chState.snapshots.length === 0 && !chState.loadingSnapshots && (
            <div className={`${css.hint} ${css.snapshotPickerHint}`}>{t('syncflow.noSnapshots')}</div>
          )}

          {/* R-20：原 `{state.error !== null && <ErrorBanner error={state.error} />}` 已移除 ——
              该字段承载 10+ 个动作的失败、渲染在全部卡片之后（用户触发点常在其上方视野外），
              且同文案会被 Toast 去重合并。现按动作分文案走右下角 Toast（见上方各 catch 分支）。 */}

          {/* 自动同步设置（当前通道） */}
          <Card>
            <span className={css.groupLabel}>{t('autosync.title')}</span>
            <span className={css.hint}>{t('autosync.description')}</span>
            <label className={css.checkboxRow}>
              <input
                type="checkbox"
                checked={chState.autosyncEnabled}
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { void toggleAutosync(e.target.checked) }}
              />
              <span>{t('autosync.enable')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('autosync.interval')}</span>
              <select
                className={css.input}
                value={chState.autosyncInterval}
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  void updateAutosyncInterval(e.target.value as AutosyncInterval)
                }}
              >
                {AUTOSYNC_INTERVAL_OPTIONS.map((iv) => (
                  <option key={iv} value={iv}>{intervalLabel(iv, t)}</option>
                ))}
              </select>
              <span className={css.hint}>{t('autosync.intervalHint')}</span>
            </label>
            <div className={css.statRow}>
              <Badge kind={chState.autosync?.lastRunStatus === 'failed' ? 'error' : chState.autosync?.lastRunStatus === 'skipped' ? 'warn' : 'info'}>
                {autosyncText}
              </Badge>
              {autosyncCountdownMs !== null && chState.autosyncEnabled && (
                <Badge kind="info">
                  {autosyncCountdownMs <= 0
                    ? t('autosync.due')
                    : t('autosync.nextRun', { time: formatIntervalDuration(autosyncCountdownMs, uiT) })}
                </Badge>
              )}
            </div>
          </Card>

          {/* P2：同步历史视图（Host /sync/history 端点；全局，含两通道记录） */}
          <SyncHistoryView api={api} t={t} />

          {/* P0-②：push 前只读预览确认弹窗（「将推送什么」→ 确认后才真正上传；Radix Modal） */}
          <Modal
            open={state.pushPreview.open}
            onClose={() => { patch({ pushPreview: { preview: null, open: false } }) }}
            title={t('syncflow.pushPreviewTitle')}
            wide
            busy={state.busy === 'push'}
          >
            <Modal.Header
              title={t('syncflow.pushPreviewTitle')}
              closeLabel={t('common.close')}
              onClose={() => { patch({ pushPreview: { preview: null, open: false } }) }}
              closeDisabled={state.busy === 'push'}
            />
            <Modal.Body scroll>
              <PushPreviewCard preview={state.pushPreview.preview} t={t} uiT={uiT} />
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="ghost"
                disabled={state.busy === 'push'}
                onClick={() => { patch({ pushPreview: { preview: null, open: false } }) }}
              >
                {t('syncflow.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={state.busy === 'push'}
                onClick={() => { void runPush() }}
              >
                {state.busy === 'push' ? <Spinner label={t('syncflow.pushing')} /> : t('syncflow.pushConfirm')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 推送结果弹窗（Radix Modal） */}
          <Modal
            open={state.pushReport !== null && pushView !== null}
            onClose={() => { patch({ pushReport: null }) }}
            title={t('push.title')}
            cardStyle={{ width: 'min(640px, 100%)', maxHeight: '85vh' }}
          >
            <Modal.Header
              title={t('push.title')}
              closeLabel={t('common.close')}
              onClose={() => { patch({ pushReport: null }) }}
            />
            <Modal.Body scroll style={{ maxHeight: '70vh' }}>
              {pushView !== null && (<>
                <Banner kind={pushView.kind === 'ok' ? 'ok' : 'error'}>{pushView.headline}</Banner>
                {pushView.sections.length > 0 && (
                  <div>
                    <span className={css.fieldLabel}>{t('sections.title')}</span>
                    <div className={css.statRow}>
                      {pushView.sections.map((s) => <Badge key={s} kind="info">{s}</Badge>)}
                    </div>
                  </div>
                )}
                {pushView.warnings.length > 0 && (
                  <div>
                    <span className={css.fieldLabel}>{t('warnings.title')}</span>
                    <ul className={css.warnList}>
                      {pushView.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </>)}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" onClick={() => { patch({ pushReport: null }) }}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 拉取差异预览弹窗（Radix Modal） */}
          <Modal
            open={state.pullReport !== null && pullView !== null}
            onClose={() => { patch({ pullReport: null }) }}
            title={t('pull.title')}
            cardStyle={{ width: 'min(720px, 100%)', maxHeight: '85vh' }}
          >
            <Modal.Header
              title={t('pull.title')}
              closeLabel={t('common.close')}
              onClose={() => { patch({ pullReport: null }) }}
            />
            <Modal.Body scroll style={{ maxHeight: '70vh' }}>
              {pullView !== null && (<>
                <Banner kind={pullView.kind === 'ok' ? 'info' : pullView.kind === 'empty' ? 'ok' : 'error'}>
                  {pullView.headline}
                </Banner>
                {pullView.summary !== null && (
                  <>
                    <div className={css.statRow}>
                      <Badge kind="info">{t('change.total', { total: pullView.summary.total })}</Badge>
                      {pullView.summary.error > 0 && <Badge kind="error">{severityLabel('error', uiT)} × {pullView.summary.error}</Badge>}
                      {pullView.summary.warning > 0 && <Badge kind="warn">{severityLabel('warning', uiT)} × {pullView.summary.warning}</Badge>}
                      {pullView.summary.info > 0 && <Badge kind="info">{severityLabel('info', uiT)} × {pullView.summary.info}</Badge>}
                    </div>
                    {pullView.summary.needsReview && <Banner kind="warn">{t('pull.needsReview')}</Banner>}
                    <div className={css.pullScroll}>
                      <div className={css.reportList}>
                        {pullView.summary.items.map((c) => (
                          <div key={c.id} className={css.statRow}>
                            <span className={css.kindTag}>{kindLabel(c.kind, uiT)}</span>
                            <Badge kind={c.severity === 'error' ? 'error' : c.severity === 'warning' ? 'warn' : 'info'}>
                              {severityLabel(c.severity, uiT)}
                            </Badge>
                            <span>{c.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {pullView.previewHint !== '' && <Banner kind="info">{pullView.previewHint}</Banner>}
              </>)}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" onClick={() => { patch({ pullReport: null }) }}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 一键同步差异确认弹窗（Radix Modal；SyncConfirmView 内含取消/确认按钮） */}
          <Modal
            open={state.confirmSession !== null}
            onClose={cancelConfirm}
            title={t('syncflow.title')}
            cardStyle={{ width: 'min(820px, 100%)', maxHeight: '85vh' }}
            busy={state.busy === 'sync'}
          >
            <Modal.Header
              title={t('syncflow.title')}
              closeLabel={t('common.close')}
              onClose={cancelConfirm}
              closeDisabled={state.busy === 'sync'}
            />
            <Modal.Body scroll style={{ maxHeight: '72vh' }}>
              {state.confirmSession !== null && (
                <SyncConfirmView
                  api={api}
                  syncSessionId={state.confirmSession.syncSessionId}
                  snapshotId={state.confirmSession.snapshotId}
                  items={state.confirmSession.items}
                  needsReview={state.confirmSession.needsReview}
                  compatibility={state.confirmSession.compatibility}
                  t={t}
                  decisions={state.confirmDecisions}
                  onDecisionsChange={(d) => { patch({ confirmDecisions: d }) }}
                  onCancel={cancelConfirm}
                  onRollbackDone={onRollbackApplied}
                />
              )}
            </Modal.Body>
          </Modal>
    </div>
  )
}

/** P0-②：push 预览内容（绑 src/ui/i18n.ts 的 UiT 文案；纯展示，无敏感字段）。 */
function PushPreviewCard({ preview, t, uiT }: {
  preview: SyncPushPreview | null
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
}) {
  const view = pushPreviewView(preview, uiT)
  if (view === null) return null
  if (view.error !== null) return <Banner kind="error">{view.error}</Banner>
  return (
    <div>
      <Banner kind="info">{view.headline}</Banner>
      {view.previewHint !== '' && <div className={css.hint}>{view.previewHint}</div>}
      {view.remoteSnapshotCount === 0 && (
        <Banner kind="warn">{t('syncflow.pushFirstBaseline')}</Banner>
      )}
      {view.encryptedHint !== '' && <Banner kind="warn">{view.encryptedHint}</Banner>}
      {view.credentialsHint !== '' && <Banner kind="warn">{view.credentialsHint}</Banner>}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('syncflow.pushPreviewSections')}</div>
        <div className={css.planScroll}>
          <ul className={css.reportList}>
            {view.rows.map((row) => (
              <li key={row.section}>
                <span className={css.kindTag}>{row.changed ? 'changed' : 'unchanged'}</span>
                {' '}{row.section} · {row.count}
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  )
}

/** AutosyncInterval → 可读标签（复用 i18n interval 键）。 */
function intervalLabel(iv: AutosyncInterval, t: TranslateNS<'config-manager-sync'>): string {
  switch (iv) {
    case '5m': return t('autosync.interval5m');
    case '15m': return t('autosync.interval15m');
    case '30m': return t('autosync.interval30m');
    case '60m': return t('autosync.interval60m');
    case '6h': return t('autosync.interval6h');
    case '12h': return t('autosync.interval12h');
    case '24h': return t('autosync.interval24h');
    default: return iv;
  }
}
