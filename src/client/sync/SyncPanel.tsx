/**
 * 同步页（UI v2 §8）。
 *
 * 与 v1 的结构差异只有一条，但它决定了整页的容量：**两个通道卡恒显示**，
 * 不再「选一个通道再看它的设置」。理由（§8 定案）：`autosync` 与 `sync-selection`
 * 本来就**按通道独立**，做成「当前通道」会让用户以为两个通道共用一份选择；
 * 而且配完 Git 回来后发现 WebDAV 的卡消失了，只会被当成 bug。
 * 未配置的通道走**矮态**（≈56px，只有名称 + 未配置徽章 + [配置]），
 * 所以 56 + 176 之后日志仍有 300px 以上，不必做手动折叠。
 *
 * v1 的三处搬移（同一次落地）：
 *  - 同步分区从**页面级一段**移进通道卡（它本就是该通道的设置）；
 *  - 加密 / 解密两张卡收进**通道配置弹窗**（页面高度才装得下两张卡 + 日志）；
 *  - 远端快照行移到**产物库**，本页只留操作日志（SyncLogList）。
 *
 * 其余（通道配置弹窗、GitHub 设备流、一键同步差异确认、回滚、拉取报告）全部保留：
 * - **同步通道卡**：配置状态 + 凭据徽章 + 事实行 + 自动同步行 + 同步内容行 + 动作行；点「配置」
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
import type { ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncPullReport, SyncPushPreview, SyncPushReport } from '../../sync/sync-engine.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Select } from '../common/Select.tsx'
import { RefreshIcon } from '../common/Icon.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import { Modal } from '../common/Modal.tsx'
import { copyTextToClipboard } from '../common/clipboard.ts'
import { sectionLabeler } from '../common/section-labels.ts'
import { runStore, toSyncStoreSlice, type SyncConfirmDecisions, type SyncStoreSlice } from '../run-store.ts'
import type {
  AutosyncAutoApplyTier, AutosyncConflictPolicy, AutosyncInterval, MergePreviewResponse, SyncApi,
  SyncPushPayload, SyncStartResponse, SyncStatusResponse,
} from './sync-api.ts'
import { resolveSmartSync } from './sync-entry.ts'
import {
  channelMapOf, channelStateMap, computeGithubLoginView, computeSyncButtons, defaultChannelSyncState,
  githubPollMessage, isClientChannel, pushReportView, readStoredChannel,
  gistSessionsRiskKey,
  initialSyncSections, normalizeSessionsLimit, syncSectionOptions, writeStoredChannel,
} from './sync-view.ts'
import type {
  ChannelSyncState, GithubLoginPhase, SyncChannel, SyncSectionOption,
} from './sync-view.ts'
// t42：可测纯逻辑下沉到 src/ui（框架无关、node 可测）；本组件只做装配。
import {
  buildSelectionRequest, buildSyncChannelBody, buildSyncConfigBody, buildSyncPushBody,
  channelBackfillFromStatus, channelRemoteReady, cloudFormFromStatus, computeEncryptInvalid, encryptToggle,
  githubPollDecision, hasSelectedSections, includeSecretsToggle, isGithubFlowInFlight, resolveInitialChannel,
  needsSessionInventory, saveQueueOnFlush, saveQueueOnRequest, saveQueueOnSettled, toggleSectionSelection,
  validateCloudForm, DEFAULT_S3_PROVIDER,
  SYNC_CONFIG_SAVE_DEBOUNCE_MS,
} from '../../ui/sync-settings-view.ts'
import type { CloudFormIssue, SaveQueueState, SyncFormSnapshot } from '../../ui/sync-settings-view.ts'
// t42 物理拆分：渲染段各自成文件（本领域目录平铺，不新增子目录），主文件只做装配
import { SyncChannelEntryCard } from './SyncChannelEntryCard.tsx'
import { ChannelConfigDialog } from './ChannelConfigDialog.tsx'
import { ChannelClearConfirmDialog } from './ChannelClearConfirmDialog.tsx'
import { SyncSectionPickerDialog } from './SyncSectionPickerDialog.tsx'
import type { SelectionSection } from '../../ui/selection-model.ts'
import type { ExportPreviewResponse } from '../api.ts'
import { SecurityOptionsCard } from './SecurityOptionsCard.tsx'
import { DecryptPasswordCard } from './DecryptPasswordCard.tsx'
import { AutosyncCard } from './AutosyncCard.tsx'
import { WorkDirCard } from './WorkDirCard.tsx'
import { Collapse } from '../common/Motion.tsx'
import { SyncLogList } from './SyncLogList.tsx'
import { UnreadableSnapshotsBanner } from './UnreadableSnapshotsBanner.tsx'
import { SyncProbeRow } from './SyncProbeRow.tsx'
import { deviceLabel } from './remote-device-view.ts'
import { PushPreviewCard } from './PushPreviewCard.tsx'
import { MergeModal } from './MergeModal.tsx'
import { SyncActivityBar } from './SyncActivityBar.tsx'
import { SyncConfirmView } from './SyncConfirmView.tsx'
import css from '../config-manager.module.css'

export interface SyncPanelProps {
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
  /** 会话点名清单（空数组 = 回到「最新 N 个」模式） */
  sessionsInclude?: string[]
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
  /* ---- s3 通道表单（S3 兼容系五家） ---- */
  s3Provider: string
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3Prefix: string
  s3AccessKeyId: string
  s3PathStyle: boolean
  /** 仅内存：成功后清空（已写入 DSH credentials 的 cloudSecretRef 槽位） */
  s3Secret: string
  /* ---- gist 通道表单 ---- */
  gistId: string
  gistApiBaseUrl: string
  gistFilePrefix: string
  /** 仅内存：成功后清空（已写入 DSH credentials 的 gist token 槽位） */
  gistToken: string
  /** 每条通道各自独立的设置状态（自动同步 / 同步模式 / 加密 / 快照）；四通道由枚举构造 */
  byChannel: Record<SyncChannel, ChannelSyncState>
  /** 可同步分区目录（status.syncSections 回填；高级模式勾选列表数据源；两通道共用目录） */
  catalog: SyncSectionOption[]
  /** 通道配置保存中（「保存配置」按钮 spinner；自动保存同用） */
  savingConfig: boolean
  busy: 'sync' | 'push' | 'pull' | 'rollback' | null
  pushReport: SyncPushReport | null
  /** P0-②：push 前只读预览弹窗（preview 结果 + 打开状态；非敏感，切 tab/刷新不丢） */
  pushPreview: PushPreviewSlice
  /**
   * 拉取报告（**仅作 run-store 切片的镜像字段**保留）：拉取的 UI 路径已整体移除
   * （按钮 / runPull / pullView / 报告弹窗 / pullReportView import 全部删除），
   * 此字段只为满足 SyncStoreSlice 的结构契约；彻底删除需同步改 run-store.ts（已报 lead）。
   */
  pullReport: SyncPullReport | null
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
  s3Provider: DEFAULT_S3_PROVIDER,
  s3Endpoint: '',
  s3Region: '',
  s3Bucket: '',
  s3Prefix: '',
  s3AccessKeyId: '',
  s3PathStyle: false,
  s3Secret: '',
  gistId: '',
  gistApiBaseUrl: '',
  gistFilePrefix: '',
  gistToken: '',
  byChannel: channelStateMap(),
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
/**
 * 从 store 切片取某通道的持久化状态。
 * 切片类型只声明 git / webdav（run-store 的持久化白名单），其余通道返回 undefined = 用缺省，
 * 由 /sync/status 回填 —— 这里**不做** `as any`，用 Partial 显式表达「可能没有」。
 */
function storedChannelState(
  byChannel: SyncStoreSlice['byChannel'],
  channel: SyncChannel,
): Partial<ChannelSyncState> | undefined {
  return (byChannel as Partial<Record<SyncChannel, Partial<ChannelSyncState>>>)[channel]
}

function initFromStore(): SyncUiState {
  const s: SyncStoreSlice = runStore.getSnapshot().sync
  return {
    ...initial,
    // 通道：store 切片缺省为 'git'，无法区分「持久化过 git」与「从未持久化」；
    // 无明确记录（== 'git'）时回退 localStorage 记住的选择（initial.channel），
    // 避免升级后把用户此前记住的 webdav 通道冲掉
    channel: resolveInitialChannel(s.channel, readStoredChannel()),
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    // 持久化切片（run-store）当前只覆盖 git / webdav（run-store.ts 不在本任务 inScope）；
    // 云端点两条通道由 /sync/status 的 s3 / gist 非密视图在 loadStatus 里回填 —— 宿主是它们的事实源。
    byChannel: channelMapOf((ch) => ({ ...defaultChannelSyncState(), ...storedChannelState(s.byChannel, ch) })),
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
      pushPreview: s.pushPreview ?? { preview: null, open: false },
    confirmSession: s.confirmSession,
    confirmDecisions: s.confirmDecisions,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export function SyncPanel({ api, t, cmT }: SyncPanelProps) {
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
  /** 待确认断开的通道（null = 未打开确认弹窗）——用户要求：配置过的通道必须能删掉 */
  const [clearTarget, setClearTarget] = useState<SyncChannel | null>(null)
  /**
   * 方案 A：一键同步自动分派命中合并路径时的**受控展开种子**。
   * preview = 那一次只读请求的结果（视图不再二次拉远端快照）；signal 变化 = 重建视图（旧裁决作废）。
   */
  const [mergeSeed, setMergeSeed] = useState<{ channel: SyncChannel; preview: MergePreviewResponse } | null>(null)
  /** 一键同步阶段（null = 空闲）：'preview' 拉远端快照预览、'sync' 差异确认/导入；只驱动文案 */
  const [syncPhase, setSyncPhase] = useState<'preview' | 'sync' | null>(null)
  /** 同步分区选择弹窗开关（瞬态 UI：模式与勾选在弹窗内即时生效并持久化，关闭即完成） */
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false)
  /**
   * P0-3：会话单元清单（逐会话勾选的数据源）。
   *
   * 惰性拉取（只有勾了 sessions 且打开分区弹窗才读）—— 真机会话库上千条，无条件读会白白
   * 拖慢设置页。清单来自 /export-preview 的 sessions 分区（与导出页同一份 listUnits 口径）。
   * 读取失败/为空 → 记住失败态，回到「最新 N 个」这条既有能力，绝不把弹窗卡在加载中。
   */
  const [sessionInv, setSessionInv] = useState<ExportPreviewResponse['sections'][number] | undefined>(undefined)
  const [sessionInvPending, setSessionInvPending] = useState(false)
  const sessionInvFailedRef = useRef(false)
  const sessionInvInFlightRef = useRef(false)

  /** 按需拉取会话清单（已取到 / 在途 / 已失败 → 不重复请求）。 */
  const fetchSessionInventory = async (): Promise<void> => {
    if (sessionInv !== undefined || sessionInvInFlightRef.current || sessionInvFailedRef.current) return
    sessionInvInFlightRef.current = true
    setSessionInvPending(true)
    try {
      const result = await api.exportPreview(['sessions'])
      const node = result.sections.find((s) => s.section === 'sessions')
      if (node === undefined) sessionInvFailedRef.current = true
      else setSessionInv(node)
    } catch {
      sessionInvFailedRef.current = true
    } finally {
      sessionInvInFlightRef.current = false
      setSessionInvPending(false)
    }
  }

  /** 勾选会话分区 + 打开弹窗时补一次清单（清单未到货则先显示加载态）。 */
  useEffect(() => {
    if (!sectionPickerOpen) return
    if (!needsSessionInventory(state.byChannel[state.channel].syncSections)) return
    void fetchSessionInventory()
    // 只在「弹窗打开」与「是否勾了会话」变化时触发；fetchSessionInventory 自身幂等
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionPickerOpen, state.byChannel[state.channel].syncSections])

  /**
   * 打开同步分区弹窗：同样先切到该通道 —— 弹窗内的勾选/会话点名都写进**该通道**的切片。
   * （§8 的关键修正：分区选择在通道内，不是全局一节。）
   */
  const openSectionPickerFor = (channel: SyncChannel): void => {
    switchChannel(channel)
    setSectionPickerOpen(true)
  }

  /** 会话点名清单（持久化；空数组 = 回到「最新 N 个」模式）。 */
  const setSessionsInclude = (channel: SyncChannel, ids: string[]): void => {
    patchChannelOf(channel, { sessionsInclude: ids })
    void saveSelection(channel, { sessionsInclude: ids })
  }

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（push/pull/sync）完成回调在组件
   * 已卸载（切走 tab）时也能把结果写进 store，切回 tab 时 initFromStore 恢复。
   */
  const commit = (next: SyncUiState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({ sync: toSyncStoreSlice(next) })
    // issue #60：持久化白名单把密码字段写成空串（安全不变量，保留），所以每次 patch 之后
    // 都要把**在途的密码输入**写回内存切片 —— 否则远端快照到货、授权轮询结束这类无关 patch
    // 会把用户正在输入的 webdav 密码/token 清空（输入几个字符就消失、粘贴也消失）。
    // 只写内存，绝不触发持久化（密码不进 sessionStorage/磁盘/日志）。
    runStore.patchSyncPasswords({ token: next.token, webdavPassword: next.webdavPassword })
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
  /**
   * 按通道打分片（UI v2 §8：两个通道卡**恒显示**，各自独立操作）。
   *
   * v1 是「单一激活通道」—— 所有 handler 隐式读 `state.channel`。参数化之后：
   * `channel` 缺省仍取激活通道（弹窗与页面级判断沿用），而**通道卡内一律显式传自己的通道**。
   * 这样两张卡各自跑自己的自动同步 / 分区选择 / 快照列表，不再互相串。
   */
  const channelStateOf = (channel: SyncChannel = state.channel): ChannelSyncState => state.byChannel[channel]
  const patchChannelOf = (channel: SyncChannel, p: Partial<ChannelSyncState>): void => patchChannelState(channel, p)
  /** 更新**激活**通道的 byChannel 状态（弹窗路径）。 */
  const patchChannel = (p: Partial<ChannelSyncState>): void => patchChannelOf(state.channel, p)
  /** 激活通道的设置状态（弹窗 / 页面级判断用；通道卡内请用 channelStateOf(ch)）。 */
  const chState: ChannelSyncState = channelStateOf()
  /**
   * P0-3：交给会话选择器的分区节点（未取到清单 → undefined，弹窗显示加载/失败态）。
   * units 直接复用 /export-preview 的 items（与导出页同构，宿主已按最新活动时间倒序）。
   */
  const sessionPickerNode: SelectionSection | undefined = sessionInv === undefined
    ? undefined
    : {
        section: 'sessions',
        count: sessionInv.count,
        sizeBytes: sessionInv.sizeBytes,
        units: sessionInv.items,
        portability: 'deviceSpecific',
        sensitive: true,
      }
  /** GitHub 流程态（不进 store 切片；commit 的镜像写幂等无害）。 */
  const patchGithub = (p: Partial<GithubUiState>): void => commit({
    ...stateRef.current,
    github: { ...stateRef.current.github, ...p },
  })
  /** GitHub 轮询定时器（卸载/取消时清理，防止泄漏与跨流程串扰） */
  const githubPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 通道配置自动保存：防抖 timer（关闭设置页前 flush，不丢输入） */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 保存防重入状态机的纯数据（在途标记 + 待发改动；t42 起由 ui/sync-settings-view.ts 决策） */
  const saveQueueRef = useRef<SaveQueueState>({ inFlight: false, pending: null })
  /** 正在拉取远端快照列表（按通道独立防抖/防并发） */
  const loadingSnapshotsRef = useRef<Record<SyncChannel, boolean>>(channelMapOf(() => false))

  /** 挂载时读取同步状态（配置回填 + 上次同步时间 + 凭据状态 + 两通道 autosync/selection） */
  const loadStatus = async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      // 通道回填：优先磁盘持久化的选择（status.lastSyncChannel，ui-prefs.json）；未记录过则
      // 回退 localStorage 记忆（升级前遗留）→ 最后按配置（sync-config.transport）
      // 宿主 transport 是四通道枚举（isClientChannel 收窄；未知/缺省回落 git）
      const savedTransport = info.transport?.type
      const savedChannel: SyncChannel = isClientChannel(savedTransport) ? savedTransport : 'git'
      // 宿主 ui-prefs 可能记录**客户端尚未接线**的云端通道（s3/gist）：UI 只认已接线通道，
  // 未接线的值一律按「无记录」处理并回落 localStorage 记忆 —— 不把未接线通道混进 UI 状态机。
  const remembered: SyncChannel | null = isClientChannel(info.lastSyncChannel) ? info.lastSyncChannel : readStoredChannel()
      // 可同步分区目录回填（host adapters 唯一事实源；仅 portable；两通道共用）
      const catalog = info.syncSections !== undefined ? syncSectionOptions(info.syncSections, uiT) : []
      // 每通道回填：优先该通道的持久化配置（syncSelectionByChannel / autosyncByChannel）；
      // 无持久化 → 默认模式 + 推荐分区
      const selByCh = info.syncSelectionByChannel
      const autoByCh = info.autosyncByChannel
      const credByCh = info.syncCredentialsByChannel
      // t42：字段回填（缺省值 / 凭据布尔 / 模式恒 advanced）下沉到 ui/sync-settings-view.ts；
      // 「推荐分区」与「sessions 上限归一化」两条规则仍住在 sync-view.ts，这里算好传进去。
      const backfill = (ch: SyncChannel): Partial<ChannelSyncState> => {
        const sel = selByCh?.[ch]
        return channelBackfillFromStatus({
          selection: sel,
          autosync: autoByCh?.[ch],
          credentials: credByCh?.[ch],
          persistedSections: initialSyncSections(sel, info.syncSections ?? []),
          sessionsLimit: normalizeSessionsLimit(sel?.sessionsLimit),
        })
      }
      patch({
        loading: false,
        statusInfo: info,
        channel: remembered ?? savedChannel,
        repoUrl: info.repoUrl ?? '',
        webdavUrl: info.webdav?.url ?? '',
        webdavUsername: info.webdav?.username ?? '',
        catalog,
        byChannel: channelMapOf((ch) => ({ ...stateRef.current.byChannel[ch], ...backfill(ch) })),
        // 云端点非密字段回填（s3/gist 的密钥值永不回传：只回 secretStored 布尔，供徽章显示）
        ...cloudFormFromStatus(info),
      })
      // 独立拉取 autosync（若 status 未带按通道状态则补一次）
      if (autoByCh === undefined) {
        void loadAutosync()
      }
      // 当前激活通道已配置且远端地址就绪时，自动拉取远端快照填充下拉（无需先点一键同步）；
      // 直接传 info 的地址（state.patch 尚未生效），避免竞态
      const activeCh = remembered ?? savedChannel
      // 就绪判定统一走 channelRemoteReady（git/webdav = 地址非空；s3/gist = 表单校验通过）。
      // patch 已同步更新 stateRef，故 loadSnapshots 内部读到的是刚回填的表单值。
      if (info.configured && channelRemoteReady({ ...formOf(stateRef.current), channel: activeCh })) {
        void loadSnapshots(undefined, activeCh)
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
        autosyncRealtime: all.git.realtime ?? true,
      })
      patchChannelState('webdav', {
        autosync: all.webdav, autosyncEnabled: all.webdav.enabled, autosyncInterval: all.webdav.interval,
        autosyncRealtime: all.webdav.realtime ?? true,
      })
    } catch (err) {
      // R-20：读取自动同步状态失败（此前写入页面最底部的共享 error Banner，常滚出视野）
      toast.error(t('toast.autosyncLoadFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 读取指定通道的远端历史快照列表（「选择历史快照」下拉数据源）。
   * urlOverride / channelOverride：挂载时地址刚从 status 回填、state.patch 尚未生效，
   * 直接传 info 的地址与通道避免竞态读旧值；缺省读当前 state。
   * 无远端地址时静默跳过（不发无效请求，下拉留空）。
   * announce：仅用户主动点「刷新快照」时为 true —— 成功给出回执，避免用户
   * 在「远端确实没有快照」与「刷新没生效」之间无从判断（M-18）。 */
  /**
   * issue #59：远端**有但读不出来**的快照必须可见 —— `list()` 跳过坏快照是防御，但静默跳过会让
   * 「push 报成功 + 列表为空」无从自查。列表接口现已回传条数与文件名，这里给一次即时回执。
   */
  const announceUnreadable = (unreadable: { file: string; reason: string }[] | undefined): void => {
    if (unreadable !== undefined && unreadable.length > 0) {
      toast.error(t('toast.snapshotsUnreadable', { n: String(unreadable.length) }))
    }
  }

  const loadSnapshots = async (urlOverride?: string, channelOverride?: SyncChannel, announce = false): Promise<void> => {
    const ch = channelOverride ?? stateRef.current.channel
    if (loadingSnapshotsRef.current[ch]) return
    loadingSnapshotsRef.current[ch] = true
    patchChannelState(ch, { loadingSnapshots: true })
    try {
      const s = stateRef.current
      // 四通道统一：判据（channelRemoteReady）与载荷组装（buildSyncChannelBody）都在 ui 层。
      // urlOverride 只对 webdav 有意义（预设下拉在 state 回填前就要用新地址去列远端快照）。
      const form: SyncFormSnapshot = ch === 'webdav' && urlOverride !== undefined
        ? { ...formOf(s), channel: 'webdav', webdavUrl: urlOverride }
        : { ...formOf(s), channel: ch }
      if (!channelRemoteReady(form)) return
      const res = await api.snapshotsList(buildSyncChannelBody(form))
      patchChannelState(ch, { snapshots: res.snapshots, unreadableSnapshots: res.unreadable ?? [] })
      announceUnreadable(res.unreadable)
      // M-18：用户主动点「刷新快照」成功后的回执（自动拉取/切换通道时不打扰）
      if (announce) toast.ok(t('toast.snapshotsRefreshed'))
    } catch (err) {
      // M-18/M-21：拉取远端快照失败原先完全静默（下拉留空），用户无法区分
      // 「远端确实没有快照」与「读取失败」。不阻断主流程，仅以 Toast 如实告知。
      toast.error(t('toast.snapshotsLoadFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
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
    const pending = saveQueueRef.current.pending
    if (pending !== null) {
      void api.saveConfig(pending).catch(() => { /* 已卸载：静默，不打扰用户 */ })
    }
    // 最后镜像一次（防止「最后一次改动后立即切 tab」时 commit 之前的瞬态丢失）
    runStore.patch({ sync: toSyncStoreSlice(stateRef.current) })
  }, [])

  /** 组件 state → 纯逻辑模块的入参（只取该模块用到的字段）。 */
  const formOf = (s: SyncUiState): SyncFormSnapshot => ({
    channel: s.channel,
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    s3Provider: s.s3Provider,
    s3Endpoint: s.s3Endpoint,
    s3Region: s.s3Region,
    s3Bucket: s.s3Bucket,
    s3Prefix: s.s3Prefix,
    s3AccessKeyId: s.s3AccessKeyId,
    s3PathStyle: s.s3PathStyle,
    s3Secret: s.s3Secret,
    gistId: s.gistId,
    gistApiBaseUrl: s.gistApiBaseUrl,
    gistFilePrefix: s.gistFilePrefix,
    gistToken: s.gistToken,
  })

  /** 表单快照 → 请求体（t42 起组装逻辑在 ui/sync-settings-view.ts，组件只装配） */
  const payload = (): SyncPushPayload => buildSyncChannelBody(formOf(state))

  /* ------------------------------------------------ 通道配置持久化（自动保存 + 显式保存） */

  /** 按给定 state 构建「保存配置」请求体；当前通道远端地址未就绪（webdav url / git repoUrl 为空）
   *  → 返回 null（无可保存内容，自动保存跳过）。password/token 仅非空携带（空 = 沿用已保存凭据）。 */
  const buildConfigPayload = (s: SyncUiState): SyncPushPayload | null => buildSyncConfigBody(formOf(s))

  /** 实际发送保存请求：成功清空已入库的 password/token（与 push 一致）并刷新凭据徽章；
   *  失败保留表单值以便重试。防重入：保存中又排入新改动 → 完成后自动补发最新 payload。
   *  announce：仅「手动点保存」为 true —— 自动保存（输入防抖）成功时不弹 Toast，
   *  否则每次停顿改字段都会刷一条通知；但**失败必须始终提示**（用户的改动没落盘）。 */
  const doSaveConfig = async (payloadToSave: SyncPushPayload, announce = false): Promise<void> => {
    // t42：防重入状态机（在途 → 记下最新待发改动并返回 'queue'）在 ui/sync-settings-view.ts
    const decision = saveQueueOnRequest(saveQueueRef.current, payloadToSave)
    saveQueueRef.current = decision.state
    if (decision.action === 'queue') return
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
      // 云端点密钥同一口径：只清「本次确实写出去的」那个；保存期间用户又改了输入则保留新值
      next.s3Secret = s.s3Secret !== '' && s.s3Secret !== payloadToSave.secret ? s.s3Secret : ''
      next.gistToken = s.gistToken !== '' && s.gistToken !== payloadToSave.secret ? s.gistToken : ''
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
        // 云端点：响应只回非密视图 + secretStored 布尔（值永不回传），直接合并供徽章刷新
        if (saved.s3 !== undefined) info.s3 = saved.s3
        if (saved.gist !== undefined) info.gist = saved.gist
        next.statusInfo = info
      }
      commit(next)
      // M-17：手动保存成功给出回执（自动保存静默，避免输入防抖刷屏）
      if (announce) toast.ok(t('toast.configSaved'))
      // 手动填入的 git token 保存成功 → 校验有效性（有效则隐藏 GitHub 登录块）。
      // 只有 git 通道用 SYNC_CREDENTIAL_REF：云端点通道的密钥走各自的槽位，与 GitHub 登录无关。
      if (payloadToSave.transport === 'git' && saved.credentialConfigured) {
        void validateGithub()
      }
    } catch (err) {
      // R-20：保存失败**始终**提示（无论手动还是自动）——用户的改动没有落盘
      toast.error(t('toast.configSaveFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
      patch({ savingConfig: false })
    } finally {
      // 保存期间又排入的新改动 → 立即补发（保底，不丢输入）
      const settled = saveQueueOnSettled(saveQueueRef.current)
      saveQueueRef.current = settled.state
      if (settled.next !== null) void doSaveConfig(settled.next, announce)
    }
  }

  /** 表单改动 → 防抖 600ms 自动保存（取最新 state；地址未就绪时跳过）。 */
  const scheduleConfigSave = (): void => {
    const payloadToSave = buildConfigPayload(stateRef.current)
    // 待发改动也会被 null 覆盖（地址被清空 → 不保存），与原实现一致
    saveQueueRef.current = { ...saveQueueRef.current, pending: payloadToSave }
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    if (payloadToSave === null) {
      saveTimer.current = null
      return
    }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushConfigSave()
    }, SYNC_CONFIG_SAVE_DEBOUNCE_MS)
  }

  /** 立即保存（「保存配置」按钮 / 防抖到点）：优先待发改动，否则按当前表单值。
   *  announce：仅手动点按钮为 true —— 自动保存成功不弹回执（见 doSaveConfig）。 */
  const flushConfigSave = (announce = false): void => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // t42：flush 取哪个载荷（优先待发改动，否则按当前表单值重建）由纯函数决策
    const flushed = saveQueueOnFlush(saveQueueRef.current, buildConfigPayload(stateRef.current))
    saveQueueRef.current = flushed.state
    if (flushed.payload === null) {
      // M-17：手动点保存但地址未填写 → 此前直接 return（按钮看起来无反应），现给出明确提示
      if (announce) toast.info(t('toast.configNothingToSave'))
      return
    }
    void doSaveConfig(flushed.payload, announce)
  }

  /* ------------------------------------------------ 断开通道配置（用户要求：配置过必须能删掉） */

  /** 断开成功后的收尾：清该通道的表单残留 + 撤销在途自动保存 + 重拉 status（徽章/配置态/地址重算）。
   *  撤销自动保存是必须的：否则防抖到点的旧 payload 会把刚删掉的配置又写回去。 */
  const onChannelCleared = (channel: SyncChannel): void => {
    setClearTarget(null)
    if (saveTimer.current !== null) { clearTimeout(saveTimer.current); saveTimer.current = null }
    saveQueueRef.current = { inFlight: false, pending: null }
    // 断开 git = 删掉 SYNC_CREDENTIAL_REF（GitHub 登录与手动 token 是**同一个槽位**）→ 登录态必然失效。
    // 不在这里复位的话 githubSignedIn 会一直是 true、登录块恒隐藏：用户以为断开了还能重新登录，
    // 实际要重启 profile 才看得到登录入口（真机用户报告）。进行中的轮询也要一并停掉。
    if (channel === 'git') {
      if (githubPollTimer.current !== null) { clearTimeout(githubPollTimer.current); githubPollTimer.current = null }
    }
    patch({
      ...(channel === 'git' ? { githubSignedIn: false, github: initialGithub } : {}),
      ...(channel === 'webdav'
        ? { webdavUrl: '', webdavUsername: '', webdavPassword: '' }
        : channel === 's3'
          ? {
              s3Endpoint: '', s3Region: '', s3Bucket: '', s3Prefix: '', s3AccessKeyId: '',
              s3Secret: '', s3PathStyle: false, s3Provider: DEFAULT_S3_PROVIDER,
            }
          : channel === 'gist'
            ? { gistId: '', gistApiBaseUrl: '', gistFilePrefix: '', gistToken: '' }
            : { repoUrl: '', token: '' }),
    })
    patchChannelOf(channel, { snapshots: [], selectedSnapshotId: '' })
    void loadStatus()
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
      // 一次性代码要手抄到浏览器，抄错就得重来 —— 发起登录即自动复制；
      // 失败必须如实提示（用户否则会以为代码已在剪贴板里），但绝不打断登录流程。
      void copyTextToClipboard(info.userCode).then((ok) => {
        if (ok) toast.ok(t('toast.githubCodeCopied', { code: info.userCode }))
        else toast.warn(t('toast.githubCodeCopyFailed'))
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
      // t42：下一步决策（pending 的自适应延迟 / interval 兜底 / 终止态）在 ui/sync-settings-view.ts
      const decision = githubPollDecision(poll, state.github.interval)
      if (decision.phase === 'waiting') {
        patchGithub({ phase: 'waiting' })
        scheduleGithubPoll(flowId, decision.delayMs ?? 0)
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
  const validateGithub = async (force = false): Promise<void> => {
    if (force !== true && stateRef.current.githubSignedIn === true) return
    try {
      const res = await api.githubValidate()
      patch({ githubSignedIn: res.configured && res.valid })
    } catch {
      // 校验失败（网络/限流等）：不可知 → 维持现状（null 隐藏 / 既有值不变）
    }
  }

  /* ------------------------------------------------ 通道配置弹窗（弹窗驱动，DESIGN.md §8.12 同体系） */

  /**
   * 打开通道配置弹窗：先切到**该通道**（弹窗作用于激活通道），
   * 再补一次登录态校验（决定 Git 子 tab 登录块显隐）。
   */
  const openChannelDialogFor = (channel: SyncChannel): void => {
    switchChannel(channel)
    setChannelOpen(true)
    // 凭据槽位空着就不该信任内存里的「已登录」（断开过配置 / 在 DSH 凭据管理里删过 token）
    const credMissing = channel === 'git' && stateRef.current.statusInfo?.credentialConfigured !== true
    if (stateRef.current.githubSignedIn === null || credMissing) void validateGithub(credMissing)
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

  /**
   * 组装 push/preview 的公共载荷（分区选择 + 加密选项；密码仅内存）。
   * t42：组装逻辑下沉到 ui/sync-settings-view.ts 的 buildSyncPushBody（node 单测覆盖
   * 「sessions 必须显式放行」「includeSecrets ⇒ encrypt」两条安全默认）。
   */
  const buildPushPayload = (): SyncPushPayload & { encryptPassword?: string } =>
    buildSyncPushBody(formOf(state), chState)

  /** P0-②：push 前只读预览（弹窗确认流程第一步）——不写远端，只展示「将推送什么」。 */
  const runPushPreview = async (): Promise<void> => {
    patch({ busy: 'push', pushReport: null })
    try {
      // 预览前先把加密密码落库（用户不必手动保存；失败只提示，不阻断预览）
      await persistEncryptPassword()
      const preview = await api.pushPreview(buildPushPayload())
      patch({ busy: null, pushPreview: { preview, open: true } })
    } catch (err) {
      // R-20：预览失败（此前写共享 error Banner，渲染在页面最底部而按钮在中部）
      patch({ busy: null })
      toast.error(t('toast.pushPreviewFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** P0-②：确认弹窗里点「确认推送」→ 真正推送（复用既有 push 语义）。 */
  const runPush = async (): Promise<void> => {
    patch({ busy: 'push', pushReport: null })
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
      toast.error(t('toast.pushFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /* ------------------------------------------------ 同步模式（默认/自定义） */

  /**
   * 保存**指定通道**的分区选择 + 加密选项到 Host（持久化；自动同步与手动 push 共用）。
   *
   * 同时是**同步密码的唯一落库入口**：带 encryptPassword / decryptPassword 时写入本机
   * 凭据库（DSH credentials，值永不进 sync-selection.json / 日志 / 响应）；带 clear* 时
   * 主动删除（用户取消勾选加密、或点「删除已保存密码」）。
   * 失败只提示不阻断本地 UI（选择已即时生效；下次改动会重新落盘）。
   */
  const saveSelection = async (channel: SyncChannel = stateRef.current.channel, p: SelectionPatch = {}): Promise<void> => {
    const ch = channel
    const cur = stateRef.current.byChannel[ch]
    try {
      // t42：请求体组装（恒 advanced / 未给出字段沿用当前值 / 空密码不携带）下沉到 ui/sync-settings-view.ts
      const res = await api.saveSelection(buildSelectionRequest(ch, cur, p))
      // 回填「已保存」布尔（Host 只回状态，永不回值）
      patchChannelState(ch, {
        encryptPasswordSaved: res.encryptPasswordConfigured === true,
        decryptPasswordSaved: res.decryptPasswordConfigured === true,
      })
    } catch (err) {
      // R-20/M-22：同步设置持久化失败（此前写共享 error Banner，与刚点的按钮相距整屏）
      toast.error(t('toast.selectionSaveFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 同步分区勾选开关（增删该通道的勾选并立即持久化）。
   * **分区按通道独立**（§8 的关键修正）：所以它必须跟着通道走，不能做成页面级一节。
   */
  const toggleSyncSection = (channel: SyncChannel, id: SectionId, checked: boolean): void => {
    const cur = stateRef.current.byChannel[channel].syncSections
    const next = toggleSectionSelection(cur, id, checked)
    patchChannelOf(channel, { syncSections: next })
    void saveSelection(channel, { sections: next })
  }

  /** 历史会话（sessions）「最新 N 个」上限（弹窗内数字输入；即时持久化；按通道独立）。 */
  const setSessionsLimit = (channel: SyncChannel, value: number): void => {
    const next = normalizeSessionsLimit(value)
    patchChannelOf(channel, { sessionsLimit: next })
    void saveSelection(channel, { sessionsLimit: next })
  }

  /**
   * 当前通道加密备份开关（持久化）。取消时：一并取消导出密钥 + **删除已保存的加密密码**
   * （用户要求：手动取消勾选即清除保存的密码），并清空输入框（密钥必须加密，安全底线）。
   */
  const setEncrypt = (channel: SyncChannel, next: boolean): void => {
    // t42：联动规则（关加密 ⇒ 取消导出密钥 + 清空输入 + 删已保存密码）在 ui/sync-settings-view.ts
    const linked = encryptToggle(next, channelStateOf(channel))
    patchChannelOf(channel, linked.channelPatch)
    void saveSelection(channel, linked.selectionPatch)
  }

  /** 当前通道导出密钥开关（持久化）。勾选时自动联动选中加密（密钥绝不明文进同步通道）。 */
  const setIncludeSecrets = (channel: SyncChannel, next: boolean): void => {
    // t42：勾「导出密钥」自动打开加密（密钥绝不明文上行）——规则在 ui/sync-settings-view.ts
    const linked = includeSecretsToggle(next, channelStateOf(channel))
    patchChannelOf(channel, linked.channelPatch)
    void saveSelection(channel, linked.selectionPatch)
  }

  /**
   * 加密密码落库（输入框失焦 / 推送前触发）。两个输入框都有值且一致才写 ——
   * 半截密码绝不入库（否则下次会拿一个错误密码去加密备份）。
   */
  const persistEncryptPassword = async (channel: SyncChannel = stateRef.current.channel): Promise<void> => {
    const cs = stateRef.current.byChannel[channel]
    if (cs.encryptPassword === '' || cs.encryptPassword !== cs.encryptPasswordConfirm) return
    await saveSelection(channel, { encryptPassword: cs.encryptPassword })
  }

  /** 解密密码落库（输入框失焦 / 拉取前触发）。空串不写（删除请用「删除已保存密码」）。 */
  const persistDecryptPassword = async (channel: SyncChannel = stateRef.current.channel): Promise<void> => {
    const cs = stateRef.current.byChannel[channel]
    if (cs.decryptPassword === '') return
    await saveSelection(channel, { decryptPassword: cs.decryptPassword })
  }

  /** 删除已保存的解密密码（用户主动删除；输入框内容一并清空）。 */
  const clearSavedDecryptPassword = (channel: SyncChannel = stateRef.current.channel): void => {
    patchChannelOf(channel, { decryptPassword: '', decryptPasswordSaved: false })
    void saveSelection(channel, { clearDecryptPassword: true })
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
        // T1：预览阶段显式 `guide`（差异确认弹窗还没来得及出现，不能用缺省 abort 把用户挡在门外）；
        // 该分区的格式告警仍由分析与差异项如实呈现。阻断语义留在 apply 阶段。
        sessionFormatDisposition: 'guide',
      })
      if (!session.ok) {
        // R-20：一键同步启动失败（宿主明确回报 message，无异常抛出）
        patch({ busy: null })
        toast.error(t('toast.syncStartFailed') + t('common.labelSeparator') + redact(session.message ?? t('syncflow.syncFailed')))
        return
      }
      patch({ busy: null, confirmSession: session, confirmDecisions: null, token: '', webdavPassword: '' })
      patchChannel({ decryptPassword: '' })
      void loadSnapshots()
    } catch (err) {
      patch({ busy: null })
      toast.error(t('toast.syncStartFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 方案 A 的入口分派：有基线先做**一次**只读合并预览 —— 有变更直接开裁决视图（复用该次结果）；
   * 全部 skip 提示「已是最新」；无基准 / 请求失败 / ok=false 一律回退老导入确认路径（fail-safe）。
   */
  const runSyncSmart = async (channel: SyncChannel): Promise<void> => {
    // 视觉反馈从**点击那一刻**开始：预览要拉远端快照（整条链最慢的一步），
    // 此前只有回退分支 runSync() 才设 busy ⇒ 点击后数秒界面毫无动静（用户以为没响应）。
    // 这里全程占用 busy（顺带挡住并发的 push/切换），并用 syncPhase 区分阶段文案。
    patch({ busy: 'sync' })
    setSyncPhase('preview')
    try {
      await dispatchSmartSync(channel)
    } finally {
      setSyncPhase(null)
      patch({ busy: null })
    }
  }

  /** 一键同步的实际分派（busy/阶段标志由 runSyncSmart 统一持有）。 */
  const dispatchSmartSync = async (channel: SyncChannel): Promise<void> => {
    switchChannel(channel)
    // 与 runSync() 同处置：先清在途的差异确认会话（否则它持有的临时 ZIP 一直留在宿主 syncSessions 里，
    // 走合并路径时更是没有出口；清掉后 fallback 分支的 runSync() 不会重复 cancel）。
    const staleConfirm = stateRef.current.confirmSession
    if (staleConfirm !== null) { try { await api.cancel(staleConfirm.syncSessionId) } catch { /* 尽力清理 */ } patch({ confirmSession: null, confirmDecisions: null }) }
    const smart = await resolveSmartSync({
      api,
      hasBaseline: stateRef.current.statusInfo?.hasBaseline,
      channelPayload: () => buildSyncChannelBody({ ...formOf(stateRef.current), channel }),
      decryptPassword: stateRef.current.byChannel[channel].decryptPassword,
    })
    if (smart.kind === 'merge') {
      setMergeSeed({ channel, preview: smart.preview })
      return
    }
    if (smart.kind === 'upToDate') { toast.ok(t('syncflow.upToDate')); return }
    if (smart.error !== undefined) toast.error(t('merge.toast.previewFailed') + t('common.labelSeparator') + redact(smart.error))
    setSyncPhase('sync')
    await runSync()
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

  const toggleAutosync = async (channel: SyncChannel, enabled: boolean): Promise<void> => {
    patchChannelOf(channel, { autosyncEnabled: enabled })
    try {
      const updated = await api.autosyncUpdate({ transport: channel, enabled, interval: channelStateOf(channel).autosyncInterval })
      patchChannelOf(channel, { autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
      // M-20：乐观更新已生效，补一条终局回执确认宿主已受理
      toast.ok(t('toast.autosyncUpdated'))
    } catch (err) {
      // R-20/M-20：失败必须提示 —— 界面是乐观更新，用户会以为开关已生效
      toast.error(t('toast.autosyncUpdateFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  const updateAutosyncInterval = async (channel: SyncChannel, interval: AutosyncInterval): Promise<void> => {
    patchChannelOf(channel, { autosyncInterval: interval })
    try {
      const updated = await api.autosyncUpdate({ transport: channel, enabled: channelStateOf(channel).autosyncEnabled, interval })
      patchChannelOf(channel, { autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
      toast.ok(t('toast.autosyncUpdated'))
    } catch (err) {
      toast.error(t('toast.autosyncUpdateFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 更新「真·自动同步」的三个策略项（realtime / autoApplyTier / conflictPolicy）。
   * 只传要改的字段，其余沿用当前通道状态（显式传 enabled+interval，宿主按 read-modify-write 落盘）。
   */
  const updateAutosyncOptions = async (
    channel: SyncChannel,
    patch: { realtime?: boolean; autoApplyTier?: AutosyncAutoApplyTier; conflictPolicy?: AutosyncConflictPolicy },
  ): Promise<void> => {
    const cs = channelStateOf(channel)
    if (patch.realtime !== undefined) patchChannelOf(channel, { autosyncRealtime: patch.realtime })
    try {
      const updated = await api.autosyncUpdate({
        transport: channel,
        enabled: cs.autosyncEnabled,
        interval: cs.autosyncInterval,
        ...patch,
      })
      patchChannelOf(channel, {
        autosync: updated,
        autosyncEnabled: updated.enabled,
        autosyncInterval: updated.interval,
        autosyncRealtime: updated.realtime ?? true,
      })
      toast.ok(t('toast.autosyncUpdated'))
    } catch (err) {
      toast.error(t('toast.autosyncUpdateFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 远端是否就绪（四通道统一判据在 ui 层：git/webdav=地址非空，s3/gist=表单校验通过）。 */
  const remoteReadyOf = (channel: SyncChannel): boolean => channelRemoteReady({ ...formOf(state), channel })
  /** 云端点表单的校验问题（对话框内联提示用；git/webdav 恒为空表）。 */
  const cloudIssues: CloudFormIssue[] = validateCloudForm(formOf(state))
  /** 激活通道的远端就绪态（弹窗 / 页面级判断用） */
  const remoteReady = remoteReadyOf(state.channel)
  const pushView = pushReportView(state.pushReport, uiT)
  const githubView = computeGithubLoginView(
    state.github.phase, state.github.userCode, state.github.verificationUri, state.github.error, uiT,
  )
  /** GitHub 流程进行中（请求设备码 / 等待授权 / 轮询）：禁用 push/pull，避免无凭据操作 */
  const githubBusy = isGithubFlowInFlight(state.github.phase)

  /** 勾选为空 → 禁止推送（勾选集合就是同步范围）。 */

  /**
   * 加密推送校验：勾选加密时，要么本机凭据库里已有密码（输入框留空即沿用），
   * 要么两个输入框都填了且一致。密码本身只在内存 / 凭据库中出现。
   * t42：判定下沉到 ui/sync-settings-view.ts 的 computeEncryptInvalid（四条分支有单测）。
   */

  /**
   * 单个通道卡（UI v2 §8：**两张恒显示**，各自独立操作）。
   *
   * **未配置 → 矮态**：只渲染入口卡（名称 + 未配置徽章 + [配置]），约 56px。
   * 不做手动折叠 —— 少一层用户状态，也少一个「我上次折叠了哪张卡」的持久化字段；
   * 两个通道通常只有一个已配置，56 + 176 之后日志仍有 300px 以上。
   *
   * ⚠️ 必须是**渲染函数**而不是内联组件：组件内定义的组件每次渲染都是新的函数标识，React 按类型
   * 不同**整棵子树重挂** —— Select 的展开态当场清零（真机：打开「选择历史快照」下拉（onOpen 会触发
   * 一次 loadSnapshots → 父组件重渲染）立刻被关掉，根本选不中）。返回 JSX 直接调用即可保持标识稳定。
   */
  /**
   * v3 §2.2-3：通道详情折叠态。缺省（键不存在）=「当前活跃通道展开」——
   * 用户点过哪张卡的按钮，哪张卡就是活跃的。四个通道全部展开会远超 564×720 画布（P-IA-8）。
   * 折叠态**不持久化**：它是瞬态的查看状态，刷新后回到「活跃通道展开」即可。
   */
  const [channelExpanded, setChannelExpanded] = useState<Partial<Record<SyncChannel, boolean>>>({})
  const isChannelExpanded = (c: SyncChannel): boolean => channelExpanded[c] ?? (c === state.channel)
  const toggleChannelExpanded = (c: SyncChannel): void => {
    setChannelExpanded((prev) => ({ ...prev, [c]: !(prev[c] ?? (c === state.channel)) }))
  }
  /** 折叠体 id（与入口卡的 aria-controls 配对；Collapse 的 id 恒有值） */
  const channelContentId = (c: SyncChannel): string => 'sync-channel-' + c

  const renderChannelCard = (channel: SyncChannel): ReactNode => {
    const cs = channelStateOf(channel)
    const ready = remoteReadyOf(channel)
    const busy = state.busy !== null
    return (
      <>
        <SyncChannelEntryCard
          t={t}
          channel={channel}
          statusInfo={state.statusInfo}
          remoteReady={ready}
          repoUrl={state.repoUrl}
          webdavUrl={state.webdavUrl}
          s3Endpoint={state.s3Endpoint}
          gistId={state.gistId}
          onOpen={() => { openChannelDialogFor(channel) }}
          onClear={() => { setClearTarget(channel) }}
          expanded={ready ? isChannelExpanded(channel) : undefined}
          contentId={ready ? channelContentId(channel) : undefined}
          onToggleExpanded={ready ? () => { toggleChannelExpanded(channel) } : undefined}
        />
        <Collapse open={ready && isChannelExpanded(channel)} id={channelContentId(channel)} className={css.syncChannelBody}>
        {ready && (
          <Card>
            {/* 同步内容：**跟着通道卡走** —— autosync 与 sync-selection 都按通道独立，
                做成全局一节会让用户以为两个通道共用一份选择（§8 的关键修正）。 */}
            {/* ⓘ 一律跟在**相关标题/操作的右边**（同一行）：单独成行会让卡片出现「孤零零一个图标」
                的断行。标题内联沿用 AboutPanel / EnvironmentPanel 的既有写法（零新增样式）。 */}
            <span className={css.groupLabel}>{t('mode.title')} <InfoHint text={t('mode.hint')} label={t('common.infoHint')} /></span>
            <span className={css.categoryDesc}>
              {state.loadError !== null ? t('load.failed')
                : state.catalog.length === 0 ? t('common.loading')
                  : t('mode.selectedCount', { n: String(cs.syncSections.length) })}
            </span>
            <div className={css.actionRowTop}>
              <Button onClick={() => { openSectionPickerFor(channel) }} disabled={busy}>
                {t('mode.choose')}
              </Button>
              <InfoHint text={t('mode.persistHint')} label={t('common.infoHint')} />
            </div>
            {cs.syncSections.length === 0 && <Banner kind="warn">{t('mode.atLeastOne')}</Banner>}
            {gistSessionsRiskKey(channel, cs.syncSections) !== null && <Banner kind="warn">{t(gistSessionsRiskKey(channel, cs.syncSections)!)}</Banner>}
          </Card>
        )}
        {ready && (
          <Card>
            {/* 动作行（方案 A 定案）：用户只面对两个方向 —— 下行「一键同步」/ 上行「推送到远端」。
                合并裁决并入一键同步（有基线走三方裁决视图、无基线走老导入确认），不再单独占按钮。 */}
            <div className={css.actionRow}>
              <Button
                variant="primary"
                disabled={busy}
                loading={state.busy === 'sync'}
                onClick={() => { void runSyncSmart(channel) }}
              >
                {state.busy === 'sync'
                  ? (syncPhase === 'preview' ? t('syncflow.checkingRemote') : t('syncflow.syncing'))
                  : t('syncflow.button')}
              </Button>
              <Button disabled={!computeSyncButtons(state.busy, ready, uiT).canPush || githubBusy || !hasSelectedSections(cs) || computeEncryptInvalid(cs)} onClick={() => { switchChannel(channel); void runPushPreview() }}>
                {computeSyncButtons(state.busy, ready, uiT).pushLabel}
              </Button>
              {/* 测试连接（只读自检）：与两个主操作同一行、排在最后；结果走 toast（不再占页面高度） */}
              <SyncProbeRow
                t={t} api={api} presentation="action" remoteReady={ready} busy={busy}
                body={buildSyncChannelBody({ ...formOf(state), channel })}
              />
            </div>
            {/* 同步在途的活动条：按钮 Spinner 只在按钮上，这条横条让「正在拉远端快照」在整张卡上可见 */}
            {syncPhase !== null && <SyncActivityBar phase={syncPhase} t={t} />}
            {/* 选择历史快照（该通道的远端快照；缺省 = 最新）。
                支持点击/展开即刷新，另有主动刷新按钮 —— 两个入口都保留（v1 行为不变）。 */}
            <div className={css.snapshotPickerRow}>
              <label className={css.field} style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span className={css.fieldLabel}>{t('syncflow.selectSnapshot')}</span>
                <Select
                  value={cs.selectedSnapshotId}
                  disabled={busy}
                  ariaLabel={t('syncflow.selectSnapshot')}
                  onOpen={() => { void loadSnapshots(undefined, channel) }}
                  onChange={(next) => {
                    patchChannelOf(channel, { selectedSnapshotId: next })
                    switchChannel(channel)
                    void runSync(next === '' ? undefined : next)
                  }}
                  options={[
                    { value: '', label: t('syncflow.latestSnapshot') },
                    ...cs.snapshots.map((s) => ({
                      value: s.id,
                      label: s.id
                        + t('syncflow.snapshotOption', { date: s.createdAt.slice(0, 10), count: String(s.sectionCount) })
                        // ⑥ 设备身份：只有快照确实带 deviceName 时才追加（旧快照不显示占位空串）
                        + (deviceLabel(s, (device) => t('syncflow.snapshotDevice', { device })) ?? ''),
                    })),
                  ]}
                />
              </label>
              <span className={css.pickerAction}>
                <Button
                  disabled={busy || cs.loadingSnapshots === true}
                  onClick={() => { void loadSnapshots(undefined, channel, true) }}
                  title={t('syncflow.refreshSnapshots')}
                >
                  {cs.loadingSnapshots === true
                    ? <Spinner label={t('syncflow.refreshingSnapshots')} />
                    : <><RefreshIcon size={14} /> {t('syncflow.refreshSnapshots')}</>}
                </Button>
              </span>
            </div>
            {/* 空态独立成行（移出 label）：label 高度 = fieldLabel + select，
                刷新按钮与之底部对齐即真正同一行，不再被 hint 顶高错位 */}
            {cs.snapshots.length === 0 && cs.loadingSnapshots !== true && (
              <div className={css.hint + ' ' + css.snapshotPickerHint}>{t('syncflow.noSnapshots')}</div>
            )}

            {/* 自动同步行（按通道；文案与倒计时在卡内派生） */}
            <AutosyncCard
              t={t}
              uiT={uiT}
              settings={cs}
              busy={busy}
              onToggleAutosync={(enabled) => { void toggleAutosync(channel, enabled) }}
              onUpdateInterval={(interval) => { void updateAutosyncInterval(channel, interval) }}
              onUpdateOptions={(patch) => { void updateAutosyncOptions(channel, patch) }}
            />
          </Card>
        )}
        {/* v3（P-IA-7 / §2.2-6）：加密与解密**属于这一条通道**，因此渲染在它自己的卡里。
            此前这两张卡挂在页面级、绑定一个被「点某张卡的按钮」悄悄切换的隐式当前通道 ——
            用户会以为四个通道共用一份加密设置。现在每张已配置的通道卡各自持有自己的凭据区，
            所有 handler 都显式传 channel（不再读 state.channel）。 */}
        {ready && (
          <SecurityOptionsCard
            t={t}
            settings={cs}
            onToggleEncrypt={(next) => { setEncrypt(channel, next) }}
            onToggleIncludeSecrets={(next) => { setIncludeSecrets(channel, next) }}
            onPatchSettings={(p) => { patchChannelOf(channel, p) }}
            onPersistEncryptPassword={() => { void persistEncryptPassword(channel) }}
          />
        )}
        {ready && (
          <DecryptPasswordCard
            t={t}
            settings={cs}
            onPatchSettings={(p) => { patchChannelOf(channel, p) }}
            onPersistDecryptPassword={() => { void persistDecryptPassword(channel) }}
            onClearSavedPassword={() => { clearSavedDecryptPassword(channel) }}
          />
        )}
        {/* issue #79：工作副本（git 专属；确认弹窗/宿主调用/回执全在 WorkDirCard.tsx） */}
        {ready && channel === 'git' && <WorkDirCard t={t} api={api} workDir={state.statusInfo?.workDir} busy={busy} onChanged={() => { void loadStatus() }} />}
        {/* issue #59：远端快照列表不完整时的常驻告知（push 报成功但列表为空时，这里是唯一线索）。
            v3：跟着**它所属的通道**走（此前挂页面级 = 显示的是隐式当前通道的列表）。 */}
        {ready && <UnreadableSnapshotsBanner items={cs.unreadableSnapshots} t={t} />}
        </Collapse>
      </>
    )
  }

  /* ------------------------------------------------ 渲染 */
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('section.label')} info={<InfoHint text={t('section.description')} label={t('common.infoHint')} />} />

          {/* M-16：页面级加载失败就地提示（此前 loadError 只写不读，宿主不可达时整页显示
              「未配置」假象）。此处保留可就地重试的 ErrorBanner —— 它是**页面是否可用**
              的前提条件，必须常驻到用户重试成功，不能交给会自动消失的 Toast。 */}
          {state.loadError !== null && (
            <ErrorBanner
              error={t('load.failed') + t('common.labelSeparator') + redact(state.loadError)}
              onRetry={() => { void loadStatus() }}
              retrying={state.loading}
              t={api.t}
            />
          )}

          {/* 两个通道卡**恒显示**（§8 定案）：未配置的走矮态。
              一致、可发现，配置入口永远在同一位置 —— 不做「只显示已配置的」那种
              随状态变化的页面结构（配完 Git 回来看不到 WebDAV 只会被当成 bug）。 */}
          {renderChannelCard('git')}
          {renderChannelCard('webdav')}
          {renderChannelCard('s3')}
          {renderChannelCard('gist')}
          {/* 通道配置弹窗（渲染段拆到 ChannelConfigDialog，t42）：只配置**打开它的那条通道**，弹窗内不提供切换 */}
          <ChannelConfigDialog
            open={channelOpen}
            api={api}
            t={t}
            uiT={uiT}
            form={formOf(state)}
            cloudIssues={cloudIssues}
            busy={state.busy !== null}
            savingConfig={state.savingConfig}
            remoteReady={remoteReady}
            statusInfo={state.statusInfo}
            githubSignedIn={state.githubSignedIn}
            githubView={githubView}
            onClose={closeChannelDialog}
            onFormChange={(p) => { patch(p); scheduleConfigSave() }}
            onGithubStart={() => { void runGithubStart() }}
            onGithubCancel={() => { void runGithubCancel() }}
            onSave={() => { flushConfigSave(true) }}
          />
          {/* 断开通道配置的二次确认：**独立于配置弹窗**（不在弹窗里嵌套弹窗 —— Radix 遮罩层
              嵌套会让内层点不动，见 Modal.tsx 的说明）。确认成功后由 onChannelCleared 统一收尾。 */}
          {clearTarget !== null && (
            <ChannelClearConfirmDialog
              open channel={clearTarget} api={api} t={t}
              onCancel={() => { setClearTarget(null) }}
              onCleared={() => { onChannelCleared(clearTarget) }}
            />
          )}

          {/* v3：页面级的「同步分区」卡已删除 —— 同一张卡此前在**每个已配置通道卡内**
             与页面级各渲染一次（重复表达），且页面级那张绑定的是隐式的「当前通道」。
             分区选择现在只存在于它所属的通道卡内（§2.2-6、不变量 §3-19）。 */}

          {/* 同步分区弹窗（渲染段拆到 SyncSectionPickerDialog，t42） */}
          <SyncSectionPickerDialog
            open={sectionPickerOpen}
            t={t}
            cmT={cmT}
            uiT={uiT}
            sectionName={sectionName}
            catalog={state.catalog}
            sections={chState.syncSections}
            sessionsLimit={chState.sessionsLimit}
            sessionsInclude={chState.sessionsInclude}
            sessionNode={sessionPickerNode}
            sessionPending={sessionInvPending}
            sessionFailed={sessionInvFailedRef.current}
            onToggleSection={(id, checked) => { toggleSyncSection(state.channel, id, checked) }}
            onSessionsLimit={(value) => { setSessionsLimit(state.channel, value) }}
            onSessionsInclude={(ids) => { setSessionsInclude(state.channel, ids) }}
            onClose={() => { setSectionPickerOpen(false) }}
          />
          {/* v3：页面级的加密/解密/快照列表卡已移入各自的通道卡（见 renderChannelCard）。 */}
          {/* 同步记录（只留操作日志）：远端快照行已搬进产物库（§8）。
              这条指路行是**必须的** —— 否则用户会以为「远端快照不见了」。 */}
          <div className={css.actionRow}>
            <span className={css.hint}>{t('history.remoteMovedHint')}</span>
            <span className={css.statusSpacer} />
            <Button size="sm" onClick={() => { runStore.patch({ panel: 'library', library: { sourceFilter: 'remote-snapshot' } }) }}>
              {t('history.remoteMovedAction')}
            </Button>
          </div>
          <SyncLogList api={api} t={t} />

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
              <PushPreviewCard preview={state.pushPreview.preview} t={t} uiT={uiT} sectionName={sectionName} />
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

          {/* 方案 A：一键同步命中合并路径 → **弹窗内**裁决（页面不再内联）。
              预览来自那一次 /sync/merge-preview（initialPreview，不二次请求）；
              内容：.mergeScroll 限高内滚 + Modal.Body scroll —— 564×720 画布下不撑出宿主面板滚动条。 */}
          <MergeModal
            seed={mergeSeed}
            onClose={() => { setMergeSeed(null) }}
            api={api} t={t}
            busy={state.busy !== null}
            channelBody={(channel) => buildSyncChannelBody({ ...formOf(stateRef.current), channel })}
            sectionName={(id) => sectionName(id as SectionId)}
            decryptPasswordOf={(channel) => stateRef.current.byChannel[channel].decryptPassword}
            onApplied={() => { void loadStatus() }}
            onRolledBack={() => { void loadStatus() }}
          />
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



