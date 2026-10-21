/**
 * m2: 模块级 run/UI store —— dsh-config-manager 浏览器半的状态中枢。
 *
 * 解决的问题（验收 m2-state / m2-refresh / m2-resume）：
 *  - 切 tab / 关面板重开：模块级单例存活于当前 JS 上下文，ExportFlow /
 *    ImportWizard 控制器实例与 UI 状态**不重建**（m2-state）；
 *  - 页面刷新：非敏感状态经 sessionStorage（键 dsh.cfgMgr.state.v1）
 *    序列化/反序列化恢复（m2-refresh）；敏感字段
 *    password / passwordConfirm / secretInputs **只存在内存**，序列化白名单
 *    显式剔除 —— 刷新后自动清空，secrets 阶段要求重输；
 *  - 进行中 run：视图挂载时经 GET /runs 找回活跃 runId，轮询 GET /progress
 *    直到完成/失败，把 RunState.result 回填到 store（m2-resume）。服务端在
 *    刷新/关面板期间继续执行，本 store 只负责重新订阅进度。
 *
 * 低频面板（Snapshots / Sync / Market / About）同样把非敏感 UI 状态镜像进这里：
 *  - ConfigManagerSection 的「当前打开面板」（panel）持久化，刷新后回到原 tab；
 *  - SyncSettingsView / MarketPanel / SnapshotsPanel 把自身状态切片（toXxxStoreSlice）
 *    镜像进 store —— 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证
 *    「刷新恢复」；同步凭据（token / webdav 密码 / 加密与解密密码）仅内存，
 *    由 toPersistedState 硬性剔除，刷新后清空要求重输。
 *
 * 控制器 rehydrate 说明：ImportWizard 没有公开的 hydrate 入口（m2 约束为只改
 * src/client/、不动 src/ui/），刷新恢复需要把持久化的非敏感快照写回控制器
 * 私有字段。writeWizardSnapshot() 是唯一的受控访问点：类型层 private 只是
 * 编译期约束（运行时是普通属性），所有写入值都来自序列化白名单（已剔除
 * 密码/密钥/secretInputs），且只在 load / hydrate / resume-settle 时调用。
 *
 * 安全约束：
 *  - toPersistedState() 用解构白名单剔除敏感字段，即使未来往 LiveState 加字段，
 *    未显式放行也不会落入 sessionStorage；
 *  - runId 为 32-hex 不可猜标识，可安全持久化（/runs + /progress 的查询键）。
 */
import { ConflictCollector } from '../ui/conflict-view.ts'
import { effectiveImportPlan, type ImportSelectionState } from '../ui/selection-model.ts'
import { DEFAULT_CATEGORIES, ExportFlow } from '../ui/export-flow.ts'
import type { ExportRunResult } from '../ui/export-flow.ts'
import { ImportWizard } from '../ui/import-wizard.ts'
import {
  DEFAULT_SESSION_FORMAT_DISPOSITION,
  parseSessionFormatDisposition,
  type SessionFormatDisposition,
} from '../ui/session-format-disposition.ts'
import { renderExportReport } from '../ui/report.ts'
// 模块级单例没有「调用方」可以传 UiT：直接用**活**翻译器（随 DSH 语言变化，非 zh 一律 en）。
// 此前这里的提示文案是硬编码中文，英文界面下原样透出。
import { liveUiT } from '../ui/i18n.ts'
import type { FlowPhase } from '../ui/flow.ts'
import type { ImportStep } from '../ui/types.ts'
import { isQuickRecommended } from '../ui/types.ts'
import type { RunProgress } from './common/progress-view.ts'
import type { BackupScheduleDraft } from '../ui/backup-schedule.ts'
import type {
  GlobalConflictStrategy, ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  ItemResolution, PathMapping,
} from '../core/types.ts'
import type { RunKind, RunState } from '../core/run-registry.ts'
import type { Manifest, SectionId } from '../schema/types.ts'
import type { ConfigManagerApi } from './api.ts'
import type { RestorePlan, RestoreReport } from '../core/restore.ts'
import type { RestoreChangeSummary } from '../core/snapshot-diff.ts'
import type {
  DshProfileCopyResult, DshProfileLaunchResult, DshProfileMeta, DshProfileRunningView, DshProfileTemplate,
} from '../profiles/dsh-profile-shared.ts'
import type { MarketListItem, MarketDownloadResult } from '../market/types.ts'
import type { SyncPushReport, SyncPullReport, SyncPushPreview } from '../sync/sync-engine.ts'
import type { SyncStartResponse } from './sync/sync-api.ts'
import type { ChannelSyncState, SyncChannel } from './sync/sync-view.ts'
import { channelMapOf, DEFAULT_SYNC_SESSIONS_LIMIT, defaultChannelSyncState } from './sync/sync-view.ts'
import { REDACTED, redact } from '../security/redaction.ts'
import { isRecord } from '../utils/guards.ts'

import type { MyItemEntry } from './market/my-configs-api.ts'
import type { MyInstallSlice, MyWizardSlice } from './market/my-configs-view.ts'
import type { SyncConflictResolution } from './sync/sync-view.ts'
import type { RecoveryPreview, RecoveryStatus, RecoveryVerifyResult } from '../ui/types.ts'

/* ---------------------------------------------------------------- 基础类型 */

/**
 * 一级页面（UI v3 §3.1）：首页 / 产物库 / 同步 / 环境。
 *
 * v3 删掉了三个化石值：`import`（导入是流程不是页面）、`market`（市场退出导航、只由 Task 承载），
 * 并把 v1 的 `overview`/`profiles` 改名为 `home`/`environment`。
 * 旧载荷一律由 parsePersistedState 的映射表迁到新值（docs/design/2026-10-05-ui-redesign-v3.md §5.1）。
 */
export type PanelId = 'home' | 'library' | 'sync' | 'environment'

/**
 * 流程任务层（UI v2 §5.8）：导出/导入/逛市场/发布市场这些**多阶段向导**不再占二级页签，
 * 由内容区上的侧滑面板承载；活动/历史/关于三种只读视图也并入同一个面板（§5.9）。
 *
 * 判据：多阶段向导 → Task；单次决策 + 报告 → Modal（恢复/咨询/查看对比仍是弹窗）。
 */
export type TaskKind = 'export' | 'import' | 'market' | 'runs' | 'history' | 'about'

export interface TaskState {
  kind: TaskKind
  /** 发起它的页面：面板只在 `panel === origin` 时渲染（切走收起、切回续做） */
  origin: PanelId
  /** 可选入参（如「从某个备份文件导入」的 zipPath） */
  payload?: unknown
}

/** 存储抽象（浏览器 sessionStorage / 测试 mock / 无存储）。 */
export interface StoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** sessionStorage 键。 */
export const STATE_KEY = 'dsh.cfgMgr.state.v1'

/** 高频进度 patch 的落盘合并窗口（ms）：轮询每 500ms 一次，合并到 1s 一次。 */
const SAVE_DEBOUNCE_MS = 1000

/**
 * 导出页的初始勾选 = **推荐分区**（可迁移、非设备专属），之后由内容选择器调整。
 * 判据与 ExportFlow.quickSelection() 共用同一个 isQuickRecommended —— 一处规则，两个调用点。
 */
export function defaultExportSelection(): SectionId[] {
  return DEFAULT_CATEGORIES
    .filter(isQuickRecommended)
    .map((c) => c.id)
}

/* -------------------------------------------- 低频面板切片（Sync/Market/Snapshots） */

/**
 * 同步面板的运行时切片 = 非敏感 UI 状态 + 仅内存的敏感字段。
 * 组件（SyncSettingsView）把自身状态镜像进这里：模块级单例保证「切 tab 不丢」，
 * sessionStorage 白名单保证「刷新恢复」；敏感字段（token/webdav 密码/加密与解密密码）
 * 由 toPersistedState 硬性剔除，刷新后清空、要求重输。
 *
 * git/webdav 通道各自独立的设置（自动同步、同步模式、加密、快照）放在 byChannel 内，
 * 两通道互不干扰；push/pull 报告与差异确认会话等瞬态结果保持全局（作用于当前操作通道）。
 */
export interface SyncStoreSlice {
  channel: SyncChannel
  repoUrl: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化/回显 */
  token: string
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空，绝不持久化/回显 */
  webdavPassword: string
  /**
   * **每条通道**各自独立的设置状态（自动同步、同步模式、加密、快照）。
   *
   * 键集合从 `SYNC_CHANNELS` 派生（`SyncChannel` 类型 + `channelMapOf` 构造）—— 这里曾是全仓
   * 最后一处手维护的通道清单；手写 `{ git, webdav }` 的表现是加通道时**静默漏一项**，
   * 而漏掉的那一项要等到某人索引它时才会炸，离现场往往很远。
   */
  byChannel: Record<SyncChannel, ChannelSyncState>
  /**
   * 进行中的同步操作（瞬态：切 tab 由模块级单例保留 → 切回仍显示进行中；
   * 刷新时被白名单剔除 → 回复空闲，异步请求结果经 /runs 等宿主侧恢复）。
   */
  busy: SyncBusyState
  /** 「保存配置」进行中（瞬态；同 busy 语义） */
  savingConfig: boolean
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
  /** P0-②：push 前只读预览弹窗（preview 结果 + 打开状态；非敏感，切 tab/刷新不丢） */
  pushPreview: { preview: SyncPushPreview | null; open: boolean }
  /** 一键同步差异确认会话（items 供 UI 逐项确认；宿主侧 30 分钟 TTL 内存登记） */
  confirmSession: SyncStartResponse | null
  /** 一键同步差异确认的逐项决策（adopted/resolution；非敏感，与 confirmSession 生命周期绑定——切 tab/刷新不丢，刷新后会话仍在可恢复决策） */
  confirmDecisions: SyncConfirmDecisions | null
  /** 最近一次一键同步执行结果（回滚入口） */
  lastRestoreId: string | null
  /** 已 redact 的错误文本 */
  error: string | null
  loadError: string | null
}

/** 同步视图的进行中操作标记（与 SyncUiState.busy 同形状；无 busy 时为空闲）。 */
export type SyncBusyState = 'sync' | 'push' | 'pull' | 'rollback' | null

/**
 * 一键同步差异确认的单条决策（非敏感；resolution 仅在 Conflict 项已解决时存在）。
 * 与 SyncConfirmView 的 ItemState 同构（resolution 序列化为 SyncConflictResolution 字符串）。
 */
export type SyncConfirmDecision = { adopted: boolean; resolution?: SyncConflictResolution }

/** 一键同步差异确认的逐项决策表（itemId → 决策；null = 无进行中的确认会话决策）。 */
export type SyncConfirmDecisions = Record<string, SyncConfirmDecision>

/**
 * 单通道状态的持久化切片 = 运行时剔除密码类敏感字段（安全关键，白名单单一出口）。
 *
 * encryptPasswordSaved / decryptPasswordSaved 同样剔除：它们是**宿主凭据库的投影**，
 * 只由 /sync/status 回填。落盘会在用户从别处删除密码后留下一个「已保存」的假象。
 */
export type PersistedChannelSyncState = Omit<
  ChannelSyncState,
  | 'encryptPassword' | 'encryptPasswordConfirm' | 'decryptPassword' | 'encryptPasswordSaved' | 'decryptPasswordSaved'
  // issue #59：读失败诊断是远端**当下**的状态，不是用户配置 —— 不落盘（下次 list 重新得到）
  | 'unreadableSnapshots'
>

/** 同步面板的持久化切片 = 运行时切片剔除敏感字段（顶层凭据 + byChannel 密码类）与瞬态字段。 */
export type PersistedSyncState = Omit<SyncStoreSlice, 'token' | 'webdavPassword' | 'busy' | 'savingConfig' | 'byChannel'> & {
  /** 每条通道的持久化状态（键集合同样从 `SyncChannel` 派生 = `SYNC_CHANNELS`） */
  byChannel: Record<SyncChannel, PersistedChannelSyncState>
}

/**
 * 配置市场面板的切片（无敏感字段：市场端点无任何 secret 输入；detail.zipPath 为宿主
 * 受控临时文件路径，非密钥）。持久化形状与运行时形状一致。
 */
export interface MarketStoreSlice {
  /** 市场面板子视图（设计 §4.6：「浏览市场 / 我的配置」；低频面板镜像，切 tab/刷新不丢） */
  subView: 'browse' | 'myconfigs'
  search: string
  category: string
  /** 分区筛选（P2-⑭：按包含的分区过滤已缓存条目；空 = 不限；切 tab/刷新不丢） */
  sectionFilter: string
  /** 来源筛选（2026-08-21：全部 / 官方 / 个人；切 tab/刷新不丢） */
  source: 'all' | 'official' | 'personal'
  /** 排序键（2026-08-21：默认 / 最新更新 / ⭐ 最多 / 名称；切 tab/刷新不丢） */
  sortKey: 'default' | 'updatedAt' | 'stars' | 'name'
  /** 最近一次 browse 的条目列表（切 tab/刷新后免重拉；host 缓存状态下次 browse 时合并） */
  items: MarketListItem[]
  /** 条目详情（下载 + 校验 + dry-run 预览；zipPath 指向宿主 tmpDir，懒 GC 10 分钟） */
  detail: MarketDownloadResult | null
  /**
   * 条目级勾选（与导入页同一个 Selection；绑 zipPath 失效 —— 换条目回落默认全选）。
   * 原「逐分区批准表」approvals 已删除（市场通道与导入页同一套语义）。
   */
  selectionState: ImportSelectionState | null
  /** 逐项冲突决策（keepCurrent / useImported；市场条目覆盖本机已有内容时用） */
  conflictResolutions: Record<string, ItemResolution>
  importResult: ImportResult | null
  error: string | null
  loadError: string | null
  /** 我的配置子视图：已上传条目（null = 尚未加载；切 tab/刷新后免重拉） */
  myItems: MyItemEntry[] | null
  /** 我的配置子视图：列表加载错误（已 redact 文本；null = 无） */
  myItemsError: string | null
  /** 我的配置子视图：上传/更新向导持久化切片（仅非敏感字段；null = 未开始或已完成，见 my-configs-view.ts MyWizardSlice） */
  myWizard: MyWizardSlice | null
  /** 我的配置子视图：装回本地（下载+逐分区批准+导入结果）持久化切片（仅非敏感；null = 未开始或已关闭） */
  myInstall: MyInstallSlice | null
  /** 我的配置子视图：删除确认弹窗的目标条目 id（非敏感；切 tab/刷新不丢，用户可见的确认态） */
  myConfirmDeleteId: string | null
}

/** 快照恢复面板的切片（无敏感字段；快照列表本身可随时重载，不持久化）。
 *  running 为「内存切片瞬态」：切 tab 由模块级单例保留、刷新时被 toPersistedState
 *  白名单剔除 —— 恢复是否仍在执行以宿主 RunRegistry（/runs + /progress）为权威，
 *  刷新后经 resume() 重新发现；浏览器持久化绝不作为 destructive operation 的状态源。 */
/**
 * 档案面板的运行时切片。**面板组件自持的状态必须是这里的子集**（PanelState = 本切片）——
 * 每条字段都随模块级单例跨挂载存活，这就是「切页签不丢」的全部机制；组件里另起 useState
 * 的字段一律会在切页签时归零（真机 bug：启动/停止的 loading 一卸载就没了，用户以为没点上而重复点）。
 *
 * 两层语义（与 run-store 其余切片一致）：
 *  - **可持久化**（非敏感 + 刷新后仍有意义）：列表视图与新建表单草稿；
 *  - **内存瞬态**（`toPersistedState` 显式剔除）：进行中的操作、弹窗目标、启动回执。
 *    为什么不落 sessionStorage：发起请求的那个页面已随刷新销毁，重放一个永远等不到回执的
 *    spinner 只会骗人（列表/运行态刷新后由 `GET /profiles` 重取，宿主才是权威）。
 */
export interface ProfilesStoreSlice {
  /** 档案列表（null = 尚未加载） */
  profiles: DshProfileMeta[] | null
  /** 在跑的实例（台账 ∪ 心跳；UI 据此把「启动」换成「停止」/禁用为「当前运行」） */
  running: DshProfileRunningView[]
  /** 当前运行中的档案名（null = 尚未加载） */
  current: string | null
  /** 新建可用的起步模板（宿主数据，随 `GET /profiles` 重取；不落盘） */
  templates: DshProfileTemplate[]
  /** 详情目标档案名（弹窗展开项；原文不在这里 —— 挂载后按名重取） */
  selectedName: string | null
  /** 已 redact 的错误文本（面板级 actionError） */
  error: string | null
  loadError: string | null
  /** 新建表单草稿（切页签保留；非敏感可持久化） */
  createName: string
  createTemplate: string
  /** 新建进行中（内存瞬态） */
  creating: boolean
  /** 重命名会话：目标档案名 + 输入草稿 + 进行中（内存瞬态） */
  renameTargetName: string | null
  renameValue: string
  renaming: boolean
  /** 删除会话：目标档案名 + 「当前档案已确认」勾选 + 进行中（内存瞬态） */
  deleteTargetName: string | null
  deleteCurrentConfirmed: boolean
  deleting: boolean
  /** 「启动该档案」进行中的档案名（null = 空闲；内存瞬态） */
  launching: string | null
  /** 「停止该档案」进行中的档案名（null = 空闲；内存瞬态） */
  stopping: string | null
  /** 待确认停止的实例档案名（null = 未打开确认框；内存瞬态） */
  stopTargetName: string | null
  /** 最近一次启动回执（内存瞬态：`url` 带认证 token，绝不落盘） */
  launchResult: DshProfileLaunchResult | null
  /** 非 Web 形态被点「启动」→ 就地给终端命令的档案名（内存瞬态） */
  launchBlocked: string | null
  /** 复制会话：源档案名 + 副本名草稿 + 是否连 node_modules 一起拷 + 进行中（内存瞬态） */
  copyTargetName: string | null
  copyValue: string
  copyIncludeModules: boolean
  copying: boolean
  /** 最近一次复制回执（内存瞬态：带 warnings，UI 据此给出安装命令；不落盘） */
  copyResult: DshProfileCopyResult | null
  /**
   * 环境页子视图：档案列表（主视图）/ 维护与诊断（全屏）。
   * 它是**切片字段而不是组件私有 state**：命令面板（`maintenance.open` / `recovery.open`）
   * 与 SAFE MODE 横幅只能写 store，却都要**直达**维护与诊断（§4.4）。
   */
  subView: 'list' | 'maintenance'
}

export interface SnapshotsStoreSlice {
  selectedId: string | null
  plan: RestorePlan | null
  /** git 风格预览的变更统计（与 plan 同源；切 tab/刷新后仍能显示行数，null = 旧宿主未返回） */
  changeSummary: RestoreChangeSummary | null
  /** 真实恢复执行中（瞬态；宿主 /runs 是权威来源，本字段只是镜像） */
  running: boolean
  report: RestoreReport | null
  actionError: string | null
  error: string | null
  /** 定时备份设置草稿（未保存修改切 tab / 刷新保留；null = 无草稿，以宿主配置为准） */
  backupDraft: BackupScheduleDraft | null
}

/**
 * Recovery 面板的运行时切片（Phase 5 §10.4）。
 * status/preview/verifyResult 为非敏感可持久化（切 tab/刷新恢复）；running 为
 * 「内存切片瞬态」：切 tab 由模块级单例保留、刷新时被 toPersistedState 白名单剔除
 * —— 恢复是否仍在执行以宿主 RunRegistry（/runs + /progress）为权威，刷新后经
 * resume() 重新发现；浏览器持久化绝不作为 destructive operation 的状态源。
 */
/**
 * 产物库切片（UI v2 §6）：来源筛选 / 搜索词 / 排序 / 展开的行。
 *
 * **四项全部非敏感**（都是界面偏好，不含任何路径以外的用户数据），所以整体可持久化。
 * 展开的是哪一行也要留住 —— 用户切到同步页看一眼再回来，不该发现自己展开的行又合上了。
 */
import type { ArtifactKind } from '../ui/artifact-view.ts'

export interface LibraryStoreSlice {
  /** 来源筛选；null = 全部。**值域用「行 kind」而不是 '_all' 这类合成值** —— 少一套映射 */
  sourceFilter: ArtifactKind | null
  query: string
  sort: 'time' | 'name'
  /** 当前展开的行 key（`<kind>:<id>`）；null = 全合上 */
  expandedKey: string | null
  /**
   * 「一键导入」请求（v3 从 `snapshots.importBackup` 迁来，属产物库而非快照面板）：
   * 产物库行点「导入」→ 开导入 Task，向导挂载时消费。**一次性内存瞬态，不落盘。**
   *  `containerType` 来自备份文件列表（issue #55）：加密容器必须先解锁再分析。
   */
  pendingZip: { zipPath: string; name: string; containerType?: 'zip' | 'encrypted' } | null
}

export interface RecoveryStoreSlice {
  /** GET /recovery/status 结果（incidents + running；非敏感可持久化） */
  status: RecoveryStatus | null
  /** 当前选中 incident 的 operationId（非敏感可持久化） */
  selectedOperationId: string | null
  /** 当前选中 incident 的只读 preview（非敏感可持久化） */
  preview: RecoveryPreview | null
  /** 最近一次 verify 结果（非敏感可持久化） */
  verifyResult: RecoveryVerifyResult | null
  /** 恢复执行中（内存切片瞬态：切 tab 保留、刷新清空；宿主 /runs 是权威） */
  running: boolean
  /** 已 redact 的错误文本 */
  error: string | null
  actionError: string | null
}

/* ------------------------------------------------- 持久化（非敏感）状态形状 */

/**
 * 导出视图的持久化切片 = 仅「表单配置类」非敏感字段（模式/勾选/安全选项/错误）。
 *
 * 导出结果（result / downloaded）与进行中/进度（running / progress / runId）是
 * **内存切片瞬态**：切 tab / 关面板由模块级单例保留，刷新 / 关闭 DSH 重开后自动
 * 清空 —— 旧导出报告与「已保存到下载目录」提示不残留展示（与 sync 面板 busy 同级）。
 * 不含 password/passwordConfirm（仅内存）。
 */
export interface PersistedExportState {
  /** 勾选的分区（唯一来源；条目级例外见 excludedUnits） */
  selection: SectionId[]
  /**
   * 被排除的**最小可拆单元** id（Phase 1 条目级导出选择）。
   * 稀疏表示：默认全选、只记例外 —— sessions 上千条也不会把 sessionStorage 撑大。
   * 非敏感（只有条目名/包名，不含任何配置值）。
   */
  excludedUnits: string[]
  /** 是否导出真实密钥（凭据值）；勾选时默认联动勾选 encrypt（密钥绝不明文） */
  includeSecrets: boolean
  /** 是否加密备份（独立选项；不导出密钥也可单独加密） */
  encrypt: boolean
  /** 自定义导出文件名（.zip；空 = 宿主自动命名；非敏感表单字段） */
  fileName: string
  /** 导出备注（写入备份列表显示；非敏感） */
  note: string
  /** 错误消息（已 redact 的文本；Error 对象不可 JSON 序列化，统一转字符串） */
  error: string | null
}

/** 导入向导的持久化切片（不含 secretInputs）。 */
export interface PersistedImportState {
  step: ImportStep
  zipPath: string | null
  /** select 步骤已选备份文件名（换选/取消选择的 UI 状态；非敏感） */
  selectedFileName: string | null
  /** 上传文件是否为整体加密备份容器（非敏感；UI 据此先进入解密容器阶段再分析） */
  containerEncrypted: boolean
  analysis: ImportAnalysis | null
  plan: ImportPlan | null
  result: ImportResult | null
  rollbackOnError: boolean
  errors: string[]
  /** UI 层流程阶段（wizard.step 之外的页面；见 src/ui/flow.ts） */
  phase: FlowPhase
  conflictStrategy: GlobalConflictStrategy
  conflictResolutions: Record<string, ItemResolution>
  pathMappings: PathMapping[]
  /**
   * 导入侧内容选择（Phase 2）。null = 尚未选择 → 默认全选（与改造前行为一致）。
   * 结构里带 zipPath：换一份备份后旧选择自动失效（见 ui/selection-model 的键控说明）。
   */
  importSelection: ImportSelectionState | null
  /**
   * 会话格式处置开关（T1）：'abort'（缺省，计划阶段阻断）/ 'skip'（这些会话默认不勾选）/
   * 'guide'（不改行为，只给指引）。非敏感的用户决策，跟着导入流程一起持久化 ——
   * 组件卸载（切页签）后必须保留，否则用户回到确认页会看到与选择模型不一致的处置。
   */
  sessionFormatDisposition: SessionFormatDisposition
  uploading: boolean
  running: boolean
  progress: RunProgress | null
  error: string | null
  runId: string | null
}

/** 刷新恢复的顶层持久化状态（v1 结构版本；旧载荷缺新字段时回退默认）。 */
export interface PersistedState {
  v: 1
  /** 当前页面（旧载荷可能为 null 或旧值，parse 一律迁移到 v3 的 4 个页面之一） */
  panel: PanelId | null
  export: PersistedExportState
  import: PersistedImportState
  sync: PersistedSyncState
  market: MarketStoreSlice
  snapshots: SnapshotsStoreSlice
  profiles: ProfilesStoreSlice
  recovery: RecoveryStoreSlice
  library: LibraryStoreSlice
}

/* --------------------------------------- 运行时状态（含仅内存的敏感字段） */

/**
 * 导出运行时状态 = 持久化字段 + 密码字段（仅内存）+ 导出结果/进度瞬态。
 *
 * result / downloaded / running / progress / runId 为「内存切片」：toPersistedState
 * 白名单剔除、applyPersisted 硬性清空 —— 刷新 / 关闭 DSH 重开后不残留；
 * 进行中导出由 m2-resume 从宿主 /runs 重新发现并恢复轮询。
 */
export interface ExportLiveState extends PersistedExportState {
  /** 加密密码（仅内存，绝不写入 sessionStorage；刷新后清空） */
  password: string
  passwordConfirm: string
  /** 导出进行中（内存切片瞬态：切 tab 保留、刷新清空） */
  running: boolean
  /** 导出进度（内存切片瞬态；进行中由 m2-resume 重回填，否则清空） */
  progress: RunProgress | null
  /** 导出结果报告（内存切片瞬态；刷新/关闭 DSH 后清空，不残留展示） */
  result: ExportRunResult | null
  /** 「已保存到下载目录」提示（内存切片瞬态；刷新后清空） */
  downloaded: boolean
  /** 最近一次导出 run id（/runs + /progress 重新订阅用；resume 自 /runs 发现，纯瞬态） */
  runId: string | null
}

/** 导入运行时状态 = 持久化字段 + 仅内存的敏感/实例字段。 */
export interface ImportLiveState extends PersistedImportState {
  /** 秘密补录值（仅内存，绝不写入 sessionStorage；刷新后清空、secrets 阶段重输） */
  secretInputs: Record<string, string>
  /** 加密备份的解密密码（仅内存，绝不写入 sessionStorage；刷新后清空、decrypt 阶段重输） */
  decryptPassword: string
  /** 解密验证成功后覆盖的凭据 ref 名（仅内存、非值）；secrets 阶段据此剔除已恢复项 */
  decryptRefs: string[]
  /** 整体加密备份容器已解锁（仅内存；刷新后要求重输密码重新解锁） */
  archiveUnlocked: boolean
  /** 冲突决策收集器实例（仅内存；刷新后由 plan + conflictResolutions 重建） */
  conflictCollector: ConflictCollector | null
  /** 导入中「跳过当前插件」已发送（内存瞬态；runId 变化时清除；UI 据此禁用跳过按钮） */
  skipRequested: boolean
}

/** store 的完整运行时快照（getSnapshot 返回；含敏感字段，仅供组件读取）。 */
export interface StoreState {
  v: 1
  /** 当前页面（v3：home / library / sync / environment；非 null） */
  panel: PanelId
  export: ExportLiveState
  import: ImportLiveState
  sync: SyncStoreSlice
  market: MarketStoreSlice
  snapshots: SnapshotsStoreSlice
  profiles: ProfilesStoreSlice
  recovery: RecoveryStoreSlice
  library: LibraryStoreSlice
  /**
   * 流程任务层（UI v2 §5.8）：**不持久化**。
   * 发起它的页面已随刷新销毁，重放一个空白向导只会骗人（与档案面板「进行中态不落 sessionStorage」同一条理由）。
   */
  task: TaskState | null
}

/** patch 的输入形状（浅合并对应切片）。 */
export interface StorePatch {
  panel?: PanelId
  export?: Partial<ExportLiveState>
  import?: Partial<ImportLiveState>
  sync?: Partial<SyncStoreSlice>
  market?: Partial<MarketStoreSlice>
  snapshots?: Partial<SnapshotsStoreSlice>
  profiles?: Partial<ProfilesStoreSlice>
  recovery?: Partial<RecoveryStoreSlice>
  library?: Partial<LibraryStoreSlice>
  /** 整块替换（`null` 表示关闭面板）；不做 Partial 合并 —— 任务没有「改一半」的语义 */
  task?: TaskState | null
}

/** 向导 step 的类型别名（与 src/ui/types.ts 的 ImportStep 保持一致）。 */
type ImportWizardStep = ImportStep

/* ------------------------------------------------------------- 默认值 */

function defaultExportState(): ExportLiveState {
  return {
    selection: defaultExportSelection(),
    excludedUnits: [],
    includeSecrets: false,
    encrypt: false,
    password: '',
    passwordConfirm: '',
    fileName: '',
    note: '',
    running: false,
    progress: null,
    result: null,
    error: null,
    downloaded: false,
    runId: null,
  }
}

function defaultImportState(): ImportLiveState {
  return {
    step: 'select',
    zipPath: null,
    selectedFileName: null,
    containerEncrypted: false,
    analysis: null,
    plan: null,
    result: null,
    rollbackOnError: true,
    errors: [],
    phase: 'preview',
    conflictStrategy: 'merge',
    conflictResolutions: {},
    pathMappings: [],
    importSelection: null,
    sessionFormatDisposition: DEFAULT_SESSION_FORMAT_DISPOSITION,
    secretInputs: {},
    decryptPassword: '',
    decryptRefs: [],
    archiveUnlocked: false,
    uploading: false,
    running: false,
    progress: null,
    error: null,
    runId: null,
    conflictCollector: null,
    skipRequested: false,
  }
}

function defaultSyncState(): SyncStoreSlice {
  return {
    channel: 'git',
    repoUrl: '',
    token: '',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    byChannel: channelMapOf(() => defaultChannelSyncState()),
    busy: null,
    savingConfig: false,
    pushReport: null,
    pullReport: null,
    pushPreview: { preview: null, open: false },
    confirmSession: null,
    confirmDecisions: null,
    lastRestoreId: null,
    error: null,
    loadError: null,
  }
}

function defaultMarketState(): MarketStoreSlice {
  return {
    subView: 'browse',
    search: '',
    category: '',
    sectionFilter: '',
    source: 'all',
    sortKey: 'default',
    items: [],
    detail: null,
    selectionState: null,
    conflictResolutions: {},
    importResult: null,
    error: null,
    loadError: null,
    myItems: null,
    myItemsError: null,
    myWizard: null,
    myInstall: null,
    myConfirmDeleteId: null,
  }
}

function defaultSnapshotsState(): SnapshotsStoreSlice {
  return {
    selectedId: null,
    plan: null,
    changeSummary: null,
    running: false,
    report: null,
    actionError: null,
    error: null,
    backupDraft: null,
  }
}

function defaultProfilesState(): ProfilesStoreSlice {
  return {
    profiles: null,
    running: [],
    current: null,
    templates: [],
    selectedName: null,
    error: null,
    loadError: null,
    createName: '',
    createTemplate: 'base',
    creating: false,
    renameTargetName: null,
    renameValue: '',
    renaming: false,
    deleteTargetName: null,
    deleteCurrentConfirmed: false,
    deleting: false,
    launching: null,
    stopping: null,
    stopTargetName: null,
    launchResult: null,
    launchBlocked: null,
    copyTargetName: null,
    copyValue: '',
    copyIncludeModules: true,
    copying: false,
    copyResult: null,
    subView: 'list',
  }
}

/** 档案条目形状守卫（旧「配置档案」载荷的 ProfileMeta 结构不同，必须丢弃而不是照单渲染）。 */
function isDshProfileMetaLite(value: unknown): value is DshProfileMeta {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['name'] === 'string' && typeof v['dir'] === 'string' && Array.isArray(v['bundles'])
}

/** 持久化载荷归一：只接受新形态字段，缺失/旧形态一律回默认值。 */
export function normalizeProfilesSlice(raw: unknown): ProfilesStoreSlice {
  const base = defaultProfilesState()
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  const list = Array.isArray(r['profiles']) ? (r['profiles'] as unknown[]).filter(isDshProfileMetaLite) : null
  // running 是**机器本地瞬态**（pid 只在本次开机有意义）：不从持久化载荷恢复，刷新后由 /profiles 重取。
  // 进行中的操作 / 弹窗目标 / 启动回执同样是瞬态（发起请求的页面已随刷新销毁）：只恢复
  // 「磁盘上仍有意义」的列表视图与表单草稿，其余一律回默认（`...base` 已给出默认值）。
  return {
    ...base,
    profiles: list,
    running: [],
    // templates 是宿主侧数据（每次 load 重取），不进持久化载荷
    templates: [],
    current: typeof r['current'] === 'string' ? r['current'] : null,
    selectedName: typeof r['selectedName'] === 'string' ? r['selectedName'] : null,
    error: typeof r['error'] === 'string' ? r['error'] : null,
    loadError: typeof r['loadError'] === 'string' ? r['loadError'] : null,
    createName: typeof r['createName'] === 'string' ? r['createName'] : '',
    createTemplate: typeof r['createTemplate'] === 'string' && r['createTemplate'] !== ''
      ? r['createTemplate']
      : base.createTemplate,
    // 只接受两个已知取值（旧载荷 / 脏数据一律回主视图，绝不把未校验的字符串当子视图用）
    subView: r['subView'] === 'maintenance' ? 'maintenance' : 'list',
  }
}

function defaultRecoveryState(): RecoveryStoreSlice {
  return {
    status: null,
    selectedOperationId: null,
    preview: null,
    verifyResult: null,
    running: false,
    error: null,
    actionError: null,
  }
}

function defaultLibraryState(): LibraryStoreSlice {
  return { sourceFilter: null, query: '', sort: 'time', expandedKey: null, pendingZip: null }
}

function defaultState(): StoreState {
  return {
    v: 1,
    // 流程任务层默认关闭（不持久化，见 StoreState.task）
    task: null,
    // v3：默认打开首页
    panel: 'home',
    export: defaultExportState(),
    import: defaultImportState(),
    sync: defaultSyncState(),
    market: defaultMarketState(),
    snapshots: defaultSnapshotsState(),
    profiles: defaultProfilesState(),
    recovery: defaultRecoveryState(),
    library: defaultLibraryState(),
  }
}

/* ------------------------------------------------- 序列化白名单（安全关键） */

/**
 * 从视图状态提取同步切片（结构兼容：传入 SyncUiState 亦可；只保留切片字段，
 * github 流程态/loading 等瞬态不进入切片；busy/savingConfig 为「内存切片」瞬态——
 * 切 tab 由模块级单例保留，刷新时被 toPersistedState 白名单剔除）。组件每次状态
 * 变化后（含异步回调）调用，把非敏感 + 仅内存字段镜像进 store。
 * byChannel 的快照数组复制引用（避免跨切片共享可变数组）。
 */
export function toSyncStoreSlice(s: SyncStoreSlice): SyncStoreSlice {
  return {
    channel: s.channel,
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    // 每条通道都要复制快照数组引用（避免跨切片共享可变数组）；键集合由枚举遍历得来，
    // 加通道时自动覆盖，不需要在这里再补一行。
    byChannel: channelMapOf((ch) => ({ ...s.byChannel[ch], snapshots: [...s.byChannel[ch].snapshots] })),
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
    pullReport: s.pullReport,
    pushPreview: s.pushPreview,
    confirmSession: s.confirmSession,
    confirmDecisions: s.confirmDecisions,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

/** 从市场视图状态提取切片（结构兼容：传入 MarketUiState 亦可）。 */
export function toMarketStoreSlice(s: MarketStoreSlice): MarketStoreSlice {
  return {
    subView: s.subView,
    search: s.search,
    category: s.category,
    sectionFilter: s.sectionFilter,
    source: s.source,
    sortKey: s.sortKey,
    items: s.items,
    detail: s.detail,
    selectionState: s.selectionState,
    conflictResolutions: s.conflictResolutions,
    importResult: s.importResult,
    error: s.error,
    loadError: s.loadError,
    myItems: s.myItems,
    myItemsError: s.myItemsError,
    myWizard: s.myWizard,
    myInstall: s.myInstall,
    myConfirmDeleteId: s.myConfirmDeleteId,
  }
}

/** 从快照面板状态提取切片（结构兼容：传入 PanelState 亦可）。 */
export function toSnapshotsStoreSlice(s: SnapshotsStoreSlice): SnapshotsStoreSlice {
  return {
    selectedId: s.selectedId,
    plan: s.plan,
    changeSummary: s.changeSummary,
    running: s.running,
    report: s.report,
    actionError: s.actionError,
    error: s.error,
    backupDraft: s.backupDraft,
  }
}

/**
 * 从档案面板状态提取切片（**结构完全一致**：PanelState = ProfilesStoreSlice）。
 * 逐字段显式列出而不是 `{...s}`：任何新增字段若漏在这里，切页签就会丢它 ——
 * `run-store.test.ts` 的键集合断言会钉住这一点。
 */
export function toProfilesStoreSlice(s: ProfilesStoreSlice): ProfilesStoreSlice {
  return {
    profiles: s.profiles,
    running: s.running,
    current: s.current,
    templates: s.templates,
    selectedName: s.selectedName,
    error: s.error,
    loadError: s.loadError,
    createName: s.createName,
    createTemplate: s.createTemplate,
    creating: s.creating,
    renameTargetName: s.renameTargetName,
    renameValue: s.renameValue,
    renaming: s.renaming,
    deleteTargetName: s.deleteTargetName,
    deleteCurrentConfirmed: s.deleteCurrentConfirmed,
    deleting: s.deleting,
    launching: s.launching,
    stopping: s.stopping,
    stopTargetName: s.stopTargetName,
    launchResult: s.launchResult,
    launchBlocked: s.launchBlocked,
    copyTargetName: s.copyTargetName,
    copyValue: s.copyValue,
    copyIncludeModules: s.copyIncludeModules,
    copying: s.copying,
    copyResult: s.copyResult,
    subView: s.subView,
  }
}

/** 从 recovery 面板状态提取切片（结构兼容：传入 PanelState 亦可）。 */
export function toRecoveryStoreSlice(s: RecoveryStoreSlice): RecoveryStoreSlice {
  return {
    status: s.status,
    selectedOperationId: s.selectedOperationId,
    preview: s.preview,
    verifyResult: s.verifyResult,
    running: s.running,
    error: s.error,
    actionError: s.actionError,
  }
}

/* --------------------------------- 落盘投影：默认拒绝 + 显式放行 + 值级脱敏 */

/**
 * 深度脱敏时**必须原样保留**的功能字段名（宿主按它们执行 / 快照登记 / 逐项决策）。
 *
 * 为什么需要例外：`redact()` 的结构化模式会把 `secret:K1` 这类**标识符**当成
 * `field: value` 形态脱敏（字段名 `secret` 命中敏感名单）。这类值既是 plan item 的 id、
 * 也是宿主执行时对项的键，改写会让导入对不上项；而它们本身不是配置内容、不含秘密。
 */
const PERSIST_FUNCTIONAL_KEYS: ReadonlySet<string> = new Set([
  'id', 'itemId', 'unitId', 'ref', 'adapter', 'kind',
])

/**
 * 深脱敏的递归深度上限（防御病态/循环结构；宿主载荷来自 JSON.parse，实际远不及此）。
 *
 * t38：到达上限时**整棵子树替换为占位**（不再是「原样返回」），于是
 * ① 深层明文不可能借上限穿透到 sessionStorage；
 * ② 同一节点的脱敏结果与「从哪个深度进入」有关（浅处是脱敏投影、超限处是占位）
 *    —— 缓存键必须带上深度，见下。
 */
const REDACT_MAX_DEPTH = 32

/**
 * 超深子树的占位值（t38）：复用渲染路径同一个脱敏标记（security/redaction.ts 的
 * `REDACTED`）—— **不新增用户可见文案**（AGENTS.md §i18n：文案进字典；这里刻意复用
 * 已有常量，既不改 locales 也不新造中/英文字符串）。
 *
 * 可读性语义：刷新后若真有超深分支被替换，界面与持久化载荷里显示的就是用户已经熟悉的
 * `***REDACTED***`，语义 =「这里原本有内容，按安全策略整棵屏蔽」，而不是「数据丢失」。
 * 真实宿主载荷（plan → items[] → conflict → local/remote …）深度约 4~5 层，远不及上限，
 * 所以这是纯防御路径；一旦命中，宁可牺牲这部分可读性也不让明文落盘。
 */
const REDACT_DEPTH_PLACEHOLDER: string = REDACTED

/**
 * 深脱敏结果缓存（t27：回收 P0-9 引入的重复计算）。
 *
 * **键 = 对象引用（WeakMap）+ 递归深度**，值是节点 → 已脱敏投影：
 * - 用 WeakMap 而不是序列化指纹：序列化本身就是要省掉的开销；引用比较是 O(1)，
 *   且键随载荷一起被 GC（不会拖住配置体量的大对象）；
 * - 深度一起进键：超限子树被替换为占位（t38）、浅处是脱敏投影，跨深度复用会让输出与「直接脱敏」不一致
 *   —— 缓存**只允许省计算，不允许改变结果**。每个节点按其实际出现的每个深度各留一份
 *   （通常 1~2 个），因此共享子对象（如 market.detail.analysis 与 import.analysis 是
 *   同一对象）不会互相覆盖、也不会互相污染；
 * - **不可变前提**：这些宿主载荷在 store 里只被**整体替换**、从不原地修改
 *   （证据：ui/import-wizard.ts 只有 `this.plan = ...` 赋值；ui/conflict-view.ts 的
 *   ConflictCollector 对 plan 只读、决策另存 Map）。所以「同一引用 = 同一内容」成立。
 *   若将来有代码**原地改载荷内容**，必须改成替换新对象，否则缓存会返回陈旧结果。
 *
 * 命中粒度 = 每个载荷节点：热路径（导入/恢复轮询每 500ms 一次 patch）只替换切片里的
 * progress/runId，载荷根引用不变 → 根节点直接命中，整棵子树零重算。
 */
const redactCache = new WeakMap<object, Map<number, unknown>>()

/** 取缓存（按引用 + 深度）。 */
function readRedactCache(value: object, depth: number): { hit: true; value: unknown } | { hit: false } {
  const byDepth = redactCache.get(value)
  if (byDepth === undefined) return { hit: false }
  if (!byDepth.has(depth)) return { hit: false }
  return { hit: true, value: byDepth.get(depth) }
}

/** 写缓存（按引用 + 深度）。 */
function writeRedactCache(value: object, depth: number, out: unknown): void {
  const byDepth = redactCache.get(value)
  if (byDepth === undefined) {
    redactCache.set(value, new Map([[depth, out]]))
    return
  }
  byDepth.set(depth, out)
}

/**
 * 落盘前的**值级脱敏**（P0-9）：递归遍历宿主下发的载荷（plan / analysis / result /
 * confirmSession / snapshots.plan / market.detail 等），把每个字符串过一遍 `redact()`
 * —— 命中「敏感字段名（JSON / kv / colon 形态）」或「密钥值形状（sk- / JWT / AKIA /
 * PEM / Bearer / URL query）」的值替换为 `***REDACTED***`。
 *
 * 为什么落盘也要做：`redact()` 此前只守渲染路径（组件渲染前才调用），而 sessionStorage
 * 是同一份文本的**第二条出口** —— 落盘后刷新又会被 applyPersisted 读回内存。
 *
 * - 只递归普通对象/数组/字符串；深度在上限内时 Date / Uint8Array / 类实例原样返回（不重建）；
 * - 功能字段（PERSIST_FUNCTIONAL_KEYS）整棵子树跳过，保证 id/ref 不被改写；
 * - **超过 REDACT_MAX_DEPTH 的子树整棵替换为 REDACT_DEPTH_PLACEHOLDER**（t38）：既不下钻
 *   也不原样返回 —— 深层明文绝不落盘（代价是该分支不可读，语义见占位常量注释）；
 * - 幂等：`***REDACTED***` 不匹配任何模式（见 security/redaction.ts）；
 * - 结果按「引用 + 深度」缓存（t27），未变化的载荷不重复深脱敏。
 */
export function redactPersistedValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const cached = readRedactCache(value, depth)
  if (cached.hit) return cached.value as T
  if (depth >= REDACT_MAX_DEPTH) {
    // t38：超深子树**整棵替换为占位** —— 数组与非普通对象一视同仁，此前是「原样返回」。
    // 注：字符串不会走到这里（其父对象在 depth == 上限-1 时才递归下来，字符串按常规规则
    // 脱敏），所以「超限即占位」不会让任何**可达**字符串逃过脱敏。
    writeRedactCache(value, depth, REDACT_DEPTH_PLACEHOLDER)
    return REDACT_DEPTH_PLACEHOLDER as unknown as T
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => redactPersistedValue(item, depth + 1))
    writeRedactCache(value, depth, out)
    return out as unknown as T
  }
  const proto: object | null = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = PERSIST_FUNCTIONAL_KEYS.has(key) ? item : redactPersistedValue(item, depth + 1)
  }
  writeRedactCache(value, depth, out)
  return out as unknown as T
}

/**
 * 持久化投影（**默认拒绝、显式放行**）：只有下面**逐字段列出**的字段会落入 sessionStorage。
 *
 * 为什么改成显式清单（P0-9）：旧实现是「解构剔除已知敏感字段 + 其余 `...rest` 原样落盘」
 * —— 默认放行。任何人往 LiveState/切片加一个敏感字段都会静默落盘，而注释与 AGENTS.md
 * 却写着「未显式放行不会落盘」，评审时不会有人看这里。现在新增字段**默认不落盘**，
 * 要落盘必须在这张清单里显式加一行（run-store.test.ts 有清单断言兜底）。
 *
 * 同时：宿主下发的载荷（import 的 plan/analysis/result、snapshots.plan、sync.confirmSession、
 * market.detail）在落盘前统一过 `redactPersistedValue()` —— 脱敏不再只是渲染路径的事。
 *
 * 仅内存、绝不落盘：密码类（password/passwordConfirm/secretInputs/decryptPassword/
 * decryptRefs/archiveUnlocked/conflictCollector；同步 token/webdavPassword/加密与解密密码，
 * 以及宿主凭据库的「已保存」布尔投影）；导出结果与进度瞬态（result/downloaded/running/
 * progress/runId）；导入中的「跳过当前」标记；快照/恢复的 running 与「一键导入」请求。
 */
export function toPersistedState(state: StoreState): PersistedState {
  const exp = state.export
  const imp = state.import
  const sync = state.sync
  /**
   * 每通道状态（显式放行）：encryptPasswordSaved / decryptPasswordSaved 是**宿主凭据库的投影**
   * （只由 /sync/status 回填），落盘会在用户从别处删除密码后留下「已保存」的假象 → 不放行。
   */
  const pickChannel = (c: ChannelSyncState): PersistedChannelSyncState => ({
    syncMode: c.syncMode,
    syncSections: [...c.syncSections],
    sessionsLimit: c.sessionsLimit,
    // 历史对话的显式点名清单（非敏感配置；空 = 「最新 N 个」模式）
    sessionsInclude: [...c.sessionsInclude],
    encrypt: c.encrypt,
    includeSecrets: c.includeSecrets,
    selectedSnapshotId: c.selectedSnapshotId,
    // 快照列表按值复制，避免落盘对象与运行时切片共享可变数组
    snapshots: [...c.snapshots],
    // issue #59 的读失败诊断：属于「远端当下的状态」而非用户配置，**不落盘**
    // （刷新/切 tab 后重新 list 会重新得到，落盘只会在远端恢复后留下陈旧告警）
    loadingSnapshots: c.loadingSnapshots === true,
    autosync: c.autosync,
    autosyncEnabled: c.autosyncEnabled,
    autosyncInterval: c.autosyncInterval,
    // 真·自动同步的本地监听开关（用户设置，非敏感；缺省 true）
    autosyncRealtime: c.autosyncRealtime,
  })
  return {
    v: 1,
    panel: state.panel,
    export: {
      selection: [...exp.selection],
      excludedUnits: [...exp.excludedUnits],
      includeSecrets: exp.includeSecrets,
      encrypt: exp.encrypt,
      fileName: exp.fileName,
      note: exp.note,
      error: exp.error,
    },
    import: {
      step: imp.step,
      zipPath: imp.zipPath,
      selectedFileName: imp.selectedFileName,
      containerEncrypted: imp.containerEncrypted,
      analysis: redactPersistedValue(imp.analysis),
      plan: redactPersistedValue(imp.plan),
      result: redactPersistedValue(imp.result),
      rollbackOnError: imp.rollbackOnError,
      errors: redactPersistedValue(imp.errors),
      phase: imp.phase,
      conflictStrategy: imp.conflictStrategy,
      conflictResolutions: { ...imp.conflictResolutions },
      pathMappings: imp.pathMappings.map((m) => ({ ...m, appliesTo: [...m.appliesTo] })),
      importSelection: imp.importSelection,
      sessionFormatDisposition: imp.sessionFormatDisposition,
      uploading: imp.uploading,
      running: imp.running,
      progress: imp.progress,
      error: imp.error,
      runId: imp.runId,
    },
    sync: {
      channel: sync.channel,
      // 同步地址与报告也过值级脱敏：repoUrl/webdavUrl 里若被粘贴进 userinfo 凭据
      // （https://oauth2:<token>@host/…），落 sessionStorage 就等于把凭据写进浏览器。
      // 宿主 validateRepoUrl/validateWebDavUrl 本来就拒绝这种地址，所以这里只影响掩码，不改合法输入。
      // webdavUsername 是**非敏感**字段（保留可读），刻意不掩（掩了会让回填的表单变 ***）。
      repoUrl: redactPersistedValue(sync.repoUrl),
      webdavUrl: redactPersistedValue(sync.webdavUrl),
      webdavUsername: sync.webdavUsername,
      byChannel: channelMapOf((ch) => pickChannel(sync.byChannel[ch])),
      pushReport: redactPersistedValue(sync.pushReport),
      pullReport: redactPersistedValue(sync.pullReport),
      pushPreview: redactPersistedValue(sync.pushPreview),
      confirmSession: redactPersistedValue(sync.confirmSession),
      confirmDecisions: sync.confirmDecisions,
      lastRestoreId: sync.lastRestoreId,
      error: sync.error,
      loadError: sync.loadError,
    },
    market: {
      subView: state.market.subView,
      search: state.market.search,
      category: state.market.category,
      sectionFilter: state.market.sectionFilter,
      source: state.market.source,
      sortKey: state.market.sortKey,
      items: state.market.items,
      detail: redactPersistedValue(state.market.detail),
      selectionState: state.market.selectionState,
      conflictResolutions: state.market.conflictResolutions,
      importResult: redactPersistedValue(state.market.importResult),
      error: state.market.error,
      loadError: state.market.loadError,
      myItems: state.market.myItems,
      myItemsError: state.market.myItemsError,
      myWizard: state.market.myWizard,
      myInstall: state.market.myInstall,
      myConfirmDeleteId: state.market.myConfirmDeleteId,
    },
    snapshots: {
      selectedId: state.snapshots.selectedId,
      plan: redactPersistedValue(state.snapshots.plan),
      changeSummary: state.snapshots.changeSummary,
      // 快照恢复 running 为内存切片瞬态：不落盘 —— 恢复是否仍在执行以宿主
      // RunRegistry（/runs + /progress）为权威，刷新后由 resume() 重新发现；
      // 持久化「running=true」会把浏览器陈旧状态误当成宿主真实状态（P1-1 原则）。
      running: false,
      report: redactPersistedValue(state.snapshots.report),
      actionError: state.snapshots.actionError,
      error: state.snapshots.error,
      backupDraft: state.snapshots.backupDraft,
    },
    // 档案切片：列表视图与表单草稿非敏感（profile 定义本身不含秘密值）→ 显式放行
    profiles: {
      profiles: state.profiles.profiles,
      // running 不落盘：pid 只在本次开机有意义（重放旧 pid 会把「运行中」判成假的）
      running: [],
      current: state.profiles.current,
      // templates 是宿主侧数据（每次 load 重取）：不落盘，刷新后由 GET /profiles 填回
      templates: [],
      selectedName: state.profiles.selectedName,
      error: state.profiles.error,
      loadError: state.profiles.loadError,
      createName: state.profiles.createName,
      createTemplate: state.profiles.createTemplate,
      // 进行中的操作 / 弹窗目标 / 启动回执一律不落盘：发起请求的那个页面已随刷新销毁，
      // 重放一个永远等不到回执的 spinner 只会骗人（切页签不丢由模块级单例承担）；
      // launchResult 还带认证 token —— 落盘等于把该实例的 RPC 交给任意读 sessionStorage 的脚本
      creating: false,
      renameTargetName: null,
      renameValue: '',
      renaming: false,
      deleteTargetName: null,
      deleteCurrentConfirmed: false,
      deleting: false,
      launching: null,
      stopping: null,
      stopTargetName: null,
      launchResult: null,
      launchBlocked: null,
      // 复制会话也是「弹窗目标 + 进行中 + 回执」三件瞬态：不落盘（copyValue 与 renameValue 同性质）
      copyTargetName: null,
      copyValue: '',
      copyIncludeModules: true,
      copying: false,
      copyResult: null,
      // 环境页子视图是**视图状态**（不含秘密值），与 snapshots.subTab 同性质 → 放行：
      // 刷新/重开设置后仍停在用户被命令面板送到的那个子视图
      subView: state.profiles.subView,
    },
    // recovery 切片为非敏感（incidents/preview/verifyResult 无秘密值）；running 为内存
    // 切片瞬态：不落盘（宿主 RunRegistry 为权威，刷新后由 resume() 重新发现）
    recovery: {
      status: state.recovery.status,
      selectedOperationId: state.recovery.selectedOperationId,
      preview: state.recovery.preview,
      verifyResult: state.recovery.verifyResult,
      running: false,
      error: state.recovery.error,
      actionError: state.recovery.actionError,
    },
    // 产物库：界面偏好落盘；pendingZip 是「一键导入」的一次性瞬态 → 不落盘
    library: {
      sourceFilter: state.library.sourceFilter,
      query: state.library.query,
      sort: state.library.sort,
      expandedKey: state.library.expandedKey,
      pendingZip: null,
    },
  }
}

/** 解析 + 轻量校验持久化状态；损坏/版本不符返回 null（调用方回退默认并清键）。 */
export function parsePersistedState(raw: string): PersistedState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p['v'] !== 1) return null
  const exp = p['export']
  const imp = p['import']
  if (typeof exp !== 'object' || exp === null || typeof imp !== 'object' || imp === null) return null
  // panel：UI v3 页面模型 —— home / library / sync / environment。
  // 旧载荷迁移（v3 §5.1）：v1/v2 的一切旧值都在这里收敛；认不出的值一律落首页（绝不丢页面）。
  const rawPanel = p['panel']
  const rawSnapshots = isRecord(p['snapshots']) ? p['snapshots'] : null
  const rawSub = rawSnapshots !== null && typeof rawSnapshots['subTab'] === 'string' ? rawSnapshots['subTab'] : ''
  let panel: PanelId
  let needMaintenance = false
  switch (rawPanel) {
    case 'home':
    case 'library':
    case 'sync':
    case 'environment':
      panel = rawPanel as PanelId
      break
    case 'overview':
      panel = 'home'
      break
    case 'profiles':
      panel = 'environment'
      break
    case 'market':
      // 市场退出导航（v3）：旧「市场页」落到产物库，并预置「市场产物」筛选
      panel = 'library'
      break
    case 'import':
    case 'export':
      // 导入/导出从来都是流程（Task 面板）：旧页面值落到产物库
      panel = 'library'
      break
    case 'snapshots':
      // v1「备份与快照」页已解散：事故恢复 → 环境·维护与诊断；定时备份 → 首页；其余 → 产物库
      if (rawSub === 'recovery' || rawSub === 'maintenance') { panel = 'environment'; needMaintenance = true }
      else if (rawSub === 'schedule') panel = 'home'
      else panel = 'library'
      break
    case 'recovery':
    case 'lifecycle':
      // 旧聚合 tab / 已下线的灾备页 → 环境页的「维护与诊断」子视图
      panel = 'environment'
      needMaintenance = true
      break
    case 'about':
    case 'history':
    case 'more':
      panel = 'home'
      break
    default:
      panel = 'home'
      break
  }
  // sync/market/snapshots：旧载荷可能缺失 → 默认切片（字段级缺失由 applyPersisted 兜底）
  const sync = isRecord(p['sync']) ? p['sync'] as unknown as PersistedSyncState : defaultSyncState()
  const market = isRecord(p['market']) ? p['market'] as unknown as MarketStoreSlice : defaultMarketState()
  // snapshots：v1 的 subTab / importBackup 两个已废字段在这里剥离（类型里也已删除）
  const snapshots: SnapshotsStoreSlice = rawSnapshots !== null
    ? (() => {
        const s = { ...rawSnapshots }
        delete s['subTab']
        delete s['importBackup']
        return s as unknown as SnapshotsStoreSlice
      })()
    : defaultSnapshotsState()
  // 环境页子视图：v3 把 v1 的 'profiles' 改名为 'list'（档案列表）；旧值在此迁移
  const profilesRaw = isRecord(p['profiles']) ? p['profiles'] as unknown as ProfilesStoreSlice : defaultProfilesState()
  const profiles: ProfilesStoreSlice = {
    ...profilesRaw,
    // 旧值 'profiles' → 'list'；维护视图仍按持久化值恢复（命令面板直达时由 needMaintenance 强制）
    subView: needMaintenance || profilesRaw.subView === 'maintenance' ? 'maintenance' : 'list',
  }
  const recovery = isRecord(p['recovery']) ? p['recovery'] as unknown as RecoveryStoreSlice : defaultRecoveryState()
  const libraryRaw = isRecord(p['library']) ? p['library'] as unknown as LibraryStoreSlice : defaultLibraryState()
  // 旧 `snapshots.importBackup`（一键导入请求）→ library.pendingZip；该字段从不落盘，仅防御性迁移。
  // 旧 `panel:'market'` → 产物库并预置「市场产物」筛选（与上面 switch 的分派一致）。
  const legacyZip = rawSnapshots !== null && isRecord(rawSnapshots['importBackup']) ? rawSnapshots['importBackup'] : null
  const library: LibraryStoreSlice = {
    ...libraryRaw,
    pendingZip: legacyZip !== null ? legacyZip as LibraryStoreSlice['pendingZip'] : null,
    ...(rawPanel === 'market' ? { sourceFilter: 'market' as const } : {}),
  }
  // 旧载荷里的 `more: { moreSub }` 已随抽屉一起废弃：面板是否打开是**瞬态**（v1 也没恢复抽屉），
  // 所以这里只忽略它，不做任何迁移。
  return { v: 1, panel, export: exp as PersistedExportState, import: imp as PersistedImportState, sync, market, snapshots, profiles, recovery, library }
}

/* ----------------------------------------------------- 控制器 rehydrate */

/** ImportWizard 私有字段的镜像形状（仅供 writeWizardSnapshot 受控写入）。 */
interface WizardInternals {
  step: ImportWizardStep
  zipPath: string | null
  analysis: ImportAnalysis | null
  plan: ImportPlan | null
  result: ImportResult | null
  rollbackOnError: boolean
  errors: string[]
  decisions: ImportDecisions
  secretInputs: Record<string, string>
  decryptPassword: string
  archiveUnlocked: boolean
  unlockedZipPath: string | null
}

/**
 * 把 store 的导入快照写回 ImportWizard 控制器私有字段（受控 rehydrate）。
 * - 只写非敏感字段；secretInputs / decryptPassword / archiveUnlocked / unlockedZipPath
 *   恒置空 —— 刷新后要求重输密码重新解锁容器；
 * - 仅在 load / hydrate / resume-settle 时调用，不参与正常交互路径。
 */
function writeWizardSnapshot(wizard: ImportWizard, imp: ImportLiveState): void {
  const internals = wizard as unknown as WizardInternals
  internals.step = imp.step
  internals.zipPath = imp.zipPath
  internals.analysis = imp.analysis
  internals.plan = imp.plan
  internals.result = imp.result
  internals.rollbackOnError = imp.rollbackOnError
  internals.errors = [...imp.errors]
  internals.decisions = {
    strategy: imp.conflictStrategy,
    resolutions: { ...imp.conflictResolutions },
    pathMappings: imp.pathMappings.map((m) => ({ ...m, appliesTo: [...m.appliesTo] })),
  }
  internals.secretInputs = {}
  internals.decryptPassword = ''
  internals.archiveUnlocked = false
  internals.unlockedZipPath = null
}

/** 由 plan + 已持久化的决策重建 ConflictCollector（刷新恢复用）。 */
export function rebuildConflictCollector(
  plan: ImportPlan,
  resolutions: Record<string, ItemResolution>,
): ConflictCollector {
  const collector = new ConflictCollector(plan)
  for (const [id, resolution] of Object.entries(resolutions)) {
    collector.resolve(id, resolution)
  }
  return collector
}

/**
 * RunState → RunProgress（m3 轮询进度回填）。
 * - step/total = 内部计数（百分比条按 item/itemTotal 推进）；
 * - section/sectionTotal 与 item/itemTotal 单独保留给分区徽章/内部计数徽章；
 * - detail = 当前项名（导出时恒为分区名，ProgressBar 侧会去冗余）。
 */
/**
 * 运行中心也用它：进度条/分区徽章/内部计数徽章的口径与导入向导页必须**完全一致**
 * （两处各自手写一份映射，迟早会出现「同一 run 两个页面显示不同百分比」）。
 */
export function runStateProgress(state: RunState): RunProgress {
  return mapRunProgress(state.kind, state)
}

/**
 * run 类型 → 运行中的阶段文案 id（阶段表见 `src/ui/progress.ts` 的 STAGE_KEYS）。
 *
 * 为什么必须按类型分开：原先「非导出」一律映射成 `executing`，于是**定时备份 / 自动同步 /
 * 快照恢复**在运行中心里全都显示「正在应用配置（插件安装可能需要较长时间）…」—— 那是导入的文案，
 * 与用户正在做的事无关，观感上就是「一直卡在同一句话」（用户报告）。
 */
const RUN_STAGE: Record<RunKind, string> = {
  export: 'exporting',
  import: 'executing',
  autosync: 'syncing',
  'sync-apply': 'syncing',
  'backup-schedule': 'backing-up',
  restore: 'restoring',
  'profile-switch': 'switching-profile',
  recovery: 'recovering',
}

function mapRunProgress(kind: RunKind, state: RunState): RunProgress {
  return {
    // 已结束的 run 不再显示「正在进行」的文案：结论由状态徽章承担，进度行只描述结果
    stage: state.status === 'running'
      ? (RUN_STAGE[kind] ?? 'executing')
      : state.status === 'done' ? 'done' : 'failed',
    detail: state.detail ?? undefined,
    step: state.item ?? undefined,
    total: state.itemTotal ?? undefined,
    section: state.section,
    sectionTotal: state.sectionTotal,
    item: state.item,
    itemTotal: state.itemTotal,
    log: state.log ?? [],
  }
}

/* ------------------------------------------------------------------- store */

export interface RunStoreOptions {
  /** 存储提供者；缺省 = window.sessionStorage（Node/无 window 时为 null） */
  storage?: StoreStorage | null
  /** 进度轮询间隔（测试注入小值；缺省 1000ms） */
  pollIntervalMs?: number
}

function defaultStorage(): StoreStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * 模块级单例 store：控制器实例 + React UI 状态 + sessionStorage 恢复。
 * 最小接口：subscribe / getSnapshot / load / save / patch / syncWizard /
 * exportFlow / importWizard / resume / stopResume。
 */
export class RunStore {
  private readonly storage: StoreStorage | null
  private readonly pollIntervalMs: number
  private readonly listeners = new Set<() => void>()
  private state: StoreState
  private exportFlowInst: ExportFlow | null = null
  private importWizardInst: ImportWizard | null = null
  private apiRef: ConfigManagerApi | null = null
  /** 正在轮询的 runId 集合（stopResume 清空；防重复订阅） */
  private readonly polling = new Set<string>()
  /** 每个 runId 至多一个挂起的轮询定时器（fire 后由下一次调度覆盖） */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 正在「发现进行中 run」的 kind 集合（watchRunning 活动标记；stopRunWatch/stopResume 清空） */
  private readonly watchActive = new Set<RunKind>()

  constructor(opts: RunStoreOptions = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage()
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000
    this.state = defaultState()
    this.load()
  }

  /* ------------------------------------------------------------- 订阅 */

  /**
   * 订阅 store 变化（useSyncExternalStore 的 subscribe）。
   *
   * 必须为箭头函数类字段：React 以裸引用（`runStore.subscribe`）调用它，
   * 无接收者，若为原型方法则 `this` 为 undefined，`this.listeners` 直接崩溃。
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 当前完整快照（引用稳定：仅在 patch 后替换，适合 useSyncExternalStore）。
   *
   * 必须为箭头函数类字段：React 以裸引用（`runStore.getSnapshot`）调用它，
   * 无接收者，若为原型方法则 `this` 为 undefined，`this.state` 抛 TypeError，
   * 导致整个 settings.section 槽位渲染崩溃（备份与迁移页空白）。
   */
  getSnapshot = (): StoreState => this.state

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /* ------------------------------------------------------- 状态更新 */

  /**
   * issue #60：把「**在途的密码输入**」回填进内存切片。
   *
   * 为什么需要单开一个入口：`save()` 每次 patch 都会跑持久化白名单，而白名单把密码字段
   * **写成空串**（这是安全不变量，必须保留）—— 于是每次 patch 之后都得把密码重新写回内存，
   * 否则一次无关的 patch（例如远端快照列表到货）就会把用户正在输入的 webdav 密码清空，
   * 表现就是「密码框输入几个字符就被自动清空、粘贴也清空、保存按钮闪一下」。
   *
   * 只写**内存**（绝不触发持久化）：密码永远不进 sessionStorage/磁盘/日志。
   */
  patchSyncPasswords(passwords: { token?: string; webdavPassword?: string }): void {
    const sync = { ...this.state.sync }
    if (passwords.token !== undefined) sync.token = passwords.token
    if (passwords.webdavPassword !== undefined) sync.webdavPassword = passwords.webdavPassword
    this.state = { ...this.state, sync }
    this.notify()
  }

  /**
   * 落盘节流（默认 ~1s 合并）：导入/同步期间 watchRunning 每 500ms 一次 patch，每次都
   * `JSON.stringify(toPersistedState(state))` 整份序列化 + 写 sessionStorage —— 大 plan 下这是
   * 可观测的开销。合并窗口内的多次 patch 只落盘一次；`pagehide` 前强制 flush（见 saveSoon）。
   */
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** 是否已就落盘失败提示过一次（配额满时只提示一次，绝不每 patch 弹）。 */
  private saveFailureNotified = false
  /** 落盘失败的可见通道（壳层注入本地化文案；缺省 null = 与改造前一致：静默）。 */
  private saveErrorNotifier: (() => void) | null = null
  /** pagehide 只绑一次。 */
  private flushBound = false

  /** 壳层注入「落盘失败」的提示通道（本地化文案由壳层给，store 不持有词典）。 */
  setSaveErrorNotifier(fn: (() => void) | null): void {
    this.saveErrorNotifier = fn
  }

  /** 合并窗口内的落盘请求（首次调用排定一次）。 */
  private saveSoon(): void {
    this.bindFlushOnHide()
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  /** 立即落盘（pagehide / 需要确定性写盘时调用）。 */
  flushSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
  }

  private bindFlushOnHide(): void {
    if (this.flushBound || typeof window === 'undefined') return
    this.flushBound = true
    // 关页/切后台前把合并窗口内的改动落盘（否则节流窗口里的最后一次改动会丢）
    window.addEventListener('pagehide', () => { this.flushSave() })
  }

  /** 浅合并补丁并立即持久化（保存走白名单，敏感字段不落盘）。 */
  patch(patchObj: StorePatch): void {
    this.state = {
      ...this.state,
      panel: patchObj.panel !== undefined ? patchObj.panel : this.state.panel,
      export: { ...this.state.export, ...patchObj.export },
      import: { ...this.state.import, ...patchObj.import },
      sync: { ...this.state.sync, ...patchObj.sync },
      market: { ...this.state.market, ...patchObj.market },
      snapshots: { ...this.state.snapshots, ...patchObj.snapshots },
      profiles: { ...this.state.profiles, ...patchObj.profiles },
      recovery: { ...this.state.recovery, ...patchObj.recovery },
      library: { ...this.state.library, ...patchObj.library },
      // task 是整块替换：undefined = 不动，null = 关闭面板
      task: patchObj.task !== undefined ? patchObj.task : this.state.task,
    }
    this.notify()
    // **只合并导入进度**（轮询每 500ms 一次，载荷含最多 500 行日志 —— 这才是真正的开销）。
    // 其余 patch（含 export.progress）一律立即落盘：既有语义与既有测试都按「patch 后已同步持久化」断言，
    // 扩大合并范围会静默改变那些行为。
    if (patchObj.import?.progress !== undefined) this.saveSoon()
    else this.save()
  }

  /** 把 ImportWizard 控制器的 snapshot() 镜像进 store（wizard 动作后调用）。 */
  syncWizard(): void {
    const wizard = this.importWizardInst
    if (wizard === null) return
    const snap = wizard.snapshot()
    this.patch({
      import: {
        step: snap.step,
        zipPath: snap.zipPath,
        analysis: snap.analysis,
        plan: snap.plan,
        result: snap.result,
        rollbackOnError: snap.rollbackOnError,
        errors: snap.errors,
      },
    })
  }

  /* ------------------------------------------------------ 持久化 load/save */

  /** 从存储恢复非敏感状态（构造时调用一次；损坏数据回退默认并清键）。 */
  load(): void {
    if (this.storage === null) return
    let raw: string | null = null
    try {
      raw = this.storage.getItem(STATE_KEY)
    } catch {
      return
    }
    if (raw === null || raw === '') {
      this.state = defaultState()
      return
    }
    const parsed = parsePersistedState(raw)
    if (parsed === null) {
      // 损坏/版本不符：清掉脏键，回退默认
      try {
        this.storage.removeItem(STATE_KEY)
      } catch {
        // 忽略存储错误
      }
      this.state = defaultState()
      return
    }
    this.applyPersisted(parsed)
  }

  /** 把解析后的持久化状态合并进运行时状态；敏感字段强制回到默认（清空）。 */
  private applyPersisted(parsed: PersistedState): void {
    this.state = {
      v: 1,
      // 流程面板不持久化：刷新后一律关闭（见 StoreState.task 的注释）
      task: null,
      // parsePersistedState 已把旧 null/非法值迁移为具体页面；这里兜底 'home'
      panel: parsed.panel ?? 'home',
      export: {
        ...defaultExportState(),
        ...parsed.export,
        // 硬性：密码/确认密码绝不从存储恢复
        password: '',
        passwordConfirm: '',
        // 硬性：导出结果/进度/进行中为内存切片瞬态，绝不从存储恢复（即便旧版持久化
        // 载荷携带这些字段也清空）—— 刷新/关闭 DSH 重开后导出页干净，不残留上次结果
        result: null,
        downloaded: false,
        running: false,
        progress: null,
        runId: null,
      },
      import: {
        ...defaultImportState(),
        ...parsed.import,
        // 旧版持久化载荷可能缺 selectedFileName（undefined）→ 归一到 null
        selectedFileName: parsed.import.selectedFileName ?? null,
        // 旧版持久化载荷可能缺 containerEncrypted（undefined）→ 归一到 false
        containerEncrypted: parsed.import.containerEncrypted === true,
        // 旧版持久化载荷可能缺 sessionFormatDisposition（undefined）/ 值非法 → 回到缺省 abort
        // （缺省是**安全侧**：宁可多问一次，也不静默带着「读不了的会话」继续导入）
        sessionFormatDisposition:
          parseSessionFormatDisposition(parsed.import.sessionFormatDisposition) ?? DEFAULT_SESSION_FORMAT_DISPOSITION,
        // 硬性：秘密补录值 / 解密密码 / 解密覆盖清单 / 容器解锁标志绝不从存储恢复；
        // collector 由 plan+决策重建；「跳过当前」为内存瞬态，刷新后复位
        secretInputs: {},
        decryptPassword: '',
        decryptRefs: [],
        archiveUnlocked: false,
        conflictCollector: null,
        skipRequested: false,
      },
      sync: (() => {
        // 旧版持久化载荷（升级前顶层 syncMode 形状）→ 迁移为 git 通道的 byChannel 状态
        const legacySync = parsed.sync as unknown as Record<string, unknown>
        const legacyHasChannelState =
          typeof legacySync['syncMode'] === 'string' || Array.isArray(legacySync['syncSections'])
        const legacyGit: PersistedChannelSyncState | undefined = legacyHasChannelState
          ? {
              syncMode: legacySync['syncMode'] === 'advanced' ? 'advanced' : 'default',
              syncSections: Array.isArray(legacySync['syncSections'])
                ? legacySync['syncSections'] as SectionId[]
                : [],
              sessionsLimit: DEFAULT_SYNC_SESSIONS_LIMIT,
              sessionsInclude: [],
              encrypt: legacySync['encrypt'] === true,
              includeSecrets: legacySync['includeSecrets'] === true,
              selectedSnapshotId: typeof legacySync['selectedSnapshotId'] === 'string'
                ? legacySync['selectedSnapshotId']
                : '',
              snapshots: [],
              autosync: null,
              autosyncEnabled: false,
              autosyncInterval: '30m',
              // 旧版持久化载荷没有这个字段 → 缺省开启（真·自动同步是缺省行为）
              autosyncRealtime: true,
            }
          : undefined
        return {
          ...defaultSyncState(),
          ...parsed.sync,
          // 硬性：同步凭据（git token / webdav 密码 / 加密与解密密码）绝不从存储恢复；
          // 刷新后清空，需要时重新输入（byChannel 内密码类字段同样强制归零）
          token: '',
          webdavPassword: '',
          // 硬性：进行中操作/保存中为瞬态，绝不从存储恢复（刷新后回复空闲；
          // 异步请求进行中由宿主 /runs 等恢复，不依赖 UI 瞬态）
          busy: null,
          savingConfig: false,
          // 每条通道都套同一套恢复规则（枚举遍历 → 加通道自动覆盖）：
          //  · 旧版顶层形状（升级前没有 byChannel）只归到 git 通道；
          //  · 密码类字段一律强制归零（持久化切片本来已剔除，这里是第二道锁）：
          //    同步凭据（含云端点密钥）绝不从 sessionStorage 恢复，刷新后必须重新输入。
          byChannel: channelMapOf((ch): ChannelSyncState => {
            const persisted = ch === 'git'
              ? (legacyGit ?? parsed.sync.byChannel?.[ch])
              : parsed.sync.byChannel?.[ch]
            return {
              ...defaultChannelSyncState(),
              ...persisted,
              encryptPassword: '',
              encryptPasswordConfirm: '',
              decryptPassword: '',
              // 「已保存」只由 /sync/status 回填（持久化切片已剔除）
              encryptPasswordSaved: false,
              decryptPasswordSaved: false,
            }
          }),
        }
      })(),
      market: { ...defaultMarketState(), ...parsed.market },
      snapshots: {
        ...defaultSnapshotsState(),
        ...parsed.snapshots,
        // 硬性：恢复执行中为瞬态，绝不从存储恢复（即使旧载荷携带 running=true 也清空）——
        // 是否仍有恢复在执行以宿主 /runs 为权威，resume() 会重新发现并置 true
        running: false,
      },
      profiles: normalizeProfilesSlice(parsed.profiles),
      recovery: {
        ...defaultRecoveryState(),
        ...parsed.recovery,
        // 硬性：恢复执行中为瞬态，绝不从存储恢复（即使旧载荷携带 running=true 也清空）——
        // 是否仍有恢复在执行以宿主 /runs 为权威，resume() 会重新发现并置 true
        running: false,
      },
      // 产物库：非法值归一（筛选来源 / 排序都是窄值域，坏值一律回默认）
      library: {
        sourceFilter: parsed.library.sourceFilter === 'snapshot' || parsed.library.sourceFilter === 'backup-file'
          || parsed.library.sourceFilter === 'remote-snapshot' || parsed.library.sourceFilter === 'market'
          ? parsed.library.sourceFilter
          : null,
        query: typeof parsed.library.query === 'string' ? parsed.library.query : '',
        sort: parsed.library.sort === 'name' ? 'name' : 'time',
        expandedKey: typeof parsed.library.expandedKey === 'string' ? parsed.library.expandedKey : null,
        // 硬性：「一键导入」请求为一次性瞬态，绝不从存储恢复
        pendingZip: null,
      },
    }
    // 安全兜底：整体加密备份容器已解锁标志绝不从存储恢复（archiveUnlocked 必为 false）→
    // 刷新后只要仍标记为加密容器且已越过 decrypt-archive 阶段，就强制退回重新解锁。
    if (
      this.state.import.containerEncrypted &&
      this.state.import.phase !== 'preview' &&
      this.state.import.phase !== 'decrypt-archive'
    ) {
      this.state.import.phase = 'decrypt-archive'
    }
    // 安全兜底：confirm 阶段若仍缺必填 secret（刷新后 secretInputs 必为空），
    // 强制退回 secrets 阶段要求重输（验收 m2-refresh 的「secrets 阶段要求重输」）。
    // Phase 2：按**用户内容选择裁剪后**的计划判断（用户已取消的插件不该再索要密钥）
    const missing = effectiveImportPlan(
      this.state.import.plan, this.state.import.zipPath, this.state.import.importSelection,
    )?.missingSecrets ?? []
    if (this.state.import.phase === 'confirm' && missing.length > 0) {
      this.state.import.phase = 'secrets'
    }
    // 加密备份（普通 ZIP 内 secrets.enc，非容器）在旧版本中有独立的解密阶段；
    // 现在解密密码只在「解锁加密备份」时输入一次（containerEncrypted 场景已由上面的
    // decrypt-archive 兜底强制退回重新解锁），不再存在 decrypt 阶段，无需此处兜底。
    // 冲突阶段：由恢复后的 plan + 决策重建 collector（刷新后实例必然丢失）
    const imp = this.state.import
    if (imp.phase === 'conflicts' && imp.plan !== null) {
      // Phase 2：冲突收集器必须基于**裁剪后**的计划，否则用户会被迫处理根本不导入的项的冲突
      imp.conflictCollector = rebuildConflictCollector(
        effectiveImportPlan(imp.plan, imp.zipPath, imp.importSelection) ?? imp.plan,
        imp.conflictResolutions,
      )
    }
  }

  /** 把非敏感状态写入 sessionStorage（白名单序列化；无存储时为空操作）。 */
  save(): void {
    if (this.storage === null) return
    try {
      this.storage.setItem(STATE_KEY, JSON.stringify(toPersistedState(this.state)))
    } catch {
      // 存储满/不可用：状态仍完整存在于内存，但**刷新即丢** —— 首次失败时经壳层注入的通道提示一次
      //（未注入则与改造前一致：静默）。绝不每次 patch 都弹（配额满时 patch 很频繁）。
      if (!this.saveFailureNotified) {
        this.saveFailureNotified = true
        try { this.saveErrorNotifier?.() } catch { /* 提示失败不影响主流程 */ }
      }
    }
  }

  /* ---------------------------------------------------- 控制器实例（缓存） */

  /** ExportFlow 控制器实例：懒创建 + 缓存（切 tab/关面板不重建）。 */
  exportFlow(api: ConfigManagerApi): ExportFlow {
    if (this.exportFlowInst === null) {
      if (this.apiRef === null) this.apiRef = api
      this.exportFlowInst = new ExportFlow({
        port: api,
        onProgress: (event) => { this.patch({ export: { progress: event } }) },
      })
    }
    return this.exportFlowInst
  }

  /** ImportWizard 控制器实例：懒创建 + 缓存；首次创建时从持久化快照 rehydrate。 */
  importWizard(api: ConfigManagerApi): ImportWizard {
    if (this.importWizardInst === null) {
      if (this.apiRef === null) this.apiRef = api
      const wizard = new ImportWizard({
        port: api,
        onProgress: (event) => { this.patch({ import: { progress: event } }) },
        defaultRollbackOnError: true,
      })
      // 刷新恢复：把持久化快照写回控制器（仅非敏感字段；secretInputs 置空）
      writeWizardSnapshot(wizard, this.state.import)
      this.importWizardInst = wizard
    }
    return this.importWizardInst
  }

  /* ------------------------------------------------- m2-resume：run 重订阅 */

  /**
   * 重新订阅进行中的 run：GET /runs 找回活跃 runId → 轮询 /progress 直到
   * 完成/失败，把 RunState.result 回填 store（导出结果 / 导入结果均可恢复）。
   * 返回是否有 run 被恢复。幂等：同一 runId 不会重复轮询。
   */
  async resume(api: ConfigManagerApi): Promise<boolean> {
    if (this.apiRef === null) this.apiRef = api
    let active: RunState[]
    try {
      active = await api.runs()
    } catch {
      // host 不可达：保持现状，不做破坏性重置
      return false
    }
    let resumed = false
    const exportRun = active.find((r) => r.kind === 'export')
    if (exportRun !== undefined) {
      resumed = true
      this.patch({
        export: {
          running: true,
          runId: exportRun.runId,
          progress: mapRunProgress('export', exportRun),
        },
      })
      this.pollRun(exportRun.runId, 'export')
    } else if (this.state.export.running) {
      // 持久化显示导出中，但 host 无活跃导出 run：请求已结束且响应丢失，不可恢复
      this.patch({
        export: {
          running: false,
          progress: null,
          runId: null,
          error: liveUiT('run.exportResultLost'),
        },
      })
    }

    const importRun = active.find((r) => r.kind === 'import')
    if (importRun !== undefined) {
      resumed = true
      this.patch({
        import: {
          running: true,
          runId: importRun.runId,
          step: 'importing',
          progress: mapRunProgress('import', importRun),
        },
      })
      this.pollRun(importRun.runId, 'import')
    } else if (this.state.import.step === 'importing') {
      // 持久化显示导入中，但 host 无活跃导入 run：任务已结束/被清理，结果不可恢复
      this.importWizardInst?.reset()
      this.patch({
        import: {
          step: 'select',
          phase: 'preview',
          runId: null,
          running: false,
          progress: null,
          conflictCollector: null,
          selectedFileName: null,
          errors: [],
          error: liveUiT('run.importResultLost'),
        },
      })
    }

    // 快照恢复（P1-1）：宿主 /runs 是「恢复是否仍在执行」的权威来源。
    // 刷新/重开面板后若存在活跃 restore run → 恢复 running 并轮询 /progress
    // （结果经 applySettled 回填 report）；持久化的 running 恒为 false（白名单
    // 剔除），绝不把浏览器陈旧状态当成宿主真实状态。
    const restoreRun = active.find((r) => r.kind === 'restore')
    if (restoreRun !== undefined) {
      resumed = true
      this.patch({ snapshots: { running: true, actionError: null } })
      this.pollRun(restoreRun.runId, 'restore')
    } else if (this.state.snapshots.running) {
      // 面板镜像显示恢复中，但 host 无活跃 restore run：请求已结束且响应丢失
      this.patch({
        snapshots: {
          running: false,
          actionError: liveUiT('run.restoreResultLost'),
        },
      })
    }

    // recovery（Phase 5）：宿主 /runs 是「恢复是否仍在执行」的权威来源。
    // 刷新/重开面板后若存在活跃 recovery run → 恢复 running 并轮询 /progress
    // （结果经 applySettled 回填 verifyResult）；持久化的 running 恒为 false（白名单
    // 剔除），绝不把浏览器陈旧状态当成宿主真实状态。
    const recoveryRun = active.find((r) => r.kind === 'recovery')
    if (recoveryRun !== undefined) {
      resumed = true
      this.patch({ recovery: { running: true, actionError: null } })
      this.pollRun(recoveryRun.runId, 'recovery')
    } else if (this.state.recovery.running) {
      // 面板镜像显示恢复中，但 host 无活跃 recovery run：请求已结束且响应丢失
      this.patch({
        recovery: {
          running: false,
          actionError: liveUiT('run.restoreResultLost'),
        },
      })
    }
    return resumed
  }

  /** 停止全部轮询（视图卸载时调用；服务端执行不受影响，重开面板再 resume）。 */
  stopResume(): void {
    this.polling.clear()
    this.watchActive.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /* ------------------------------------- m3：本次会话内启动 run 的实时轮询 */

  /**
   * 本次会话内启动的 run（POST /export 或 /execute 请求进行期间）的实时进度订阅。
   * 请求是同步的、响应到达才知 runId，所以先经 GET /runs 发现进行中的 run（500ms），
   * 发现后转入 /progress 轮询（同一间隔），done/failed 自动停止。
   *
   * 与 m2 resume 的收敛：两者共用 pollRun / polling / timers 同一套轮询器，
   * 只是间隔不同（resume 恢复 1s、本方法实时 500ms）且发现阶段不同
   * （resume 用 /runs 一次性找回 runId；本方法持续 /runs 直到出现活跃 run）。
   * 同一 runId 不会重复轮询（polling 集合防重）。
   */
  watchRunning(kind: RunKind, intervalMs?: number): void {
    if (this.watchActive.has(kind)) return
    this.watchActive.add(kind)
    const api = this.apiRef
    if (api === null) {
      this.watchActive.delete(kind)
      return
    }
    const interval = intervalMs ?? this.pollIntervalMs
    const tick = (): void => {
      if (!this.watchActive.has(kind)) return
      void api.runs().then(
        (active) => {
          if (!this.watchActive.has(kind)) return
          const run = active.find((r) => r.kind === kind && r.status === 'running')
          if (run === undefined) {
            // 请求尚未注册 run / 已瞬间结束：继续发现，直到视图 stop 或转入 /progress
            this.scheduleWatch(kind, tick, interval)
            return
          }
          // 发现进行中 run：停止发现，交给 /progress 轮询器（同一间隔）
          this.watchActive.delete(kind)
          this.patchProgress(kind, run)
          this.pollRun(run.runId, kind, interval)
        },
        () => {
          if (this.watchActive.has(kind)) this.scheduleWatch(kind, tick, interval)
        },
      )
    }
    this.scheduleWatch(kind, tick, interval)
  }

  /** 停止某 kind 的「发现进行中 run」轮询（视图请求结束后调用；/progress 轮询自行结束）。 */
  stopRunWatch(kind: RunKind): void {
    this.watchActive.delete(kind)
  }

  /** 调度下一轮发现；每 kind 只保留一个挂起定时器。 */
  private scheduleWatch(kind: RunKind, tick: () => void, intervalMs: number): void {
    const timer = setTimeout(tick, intervalMs)
    this.timers.set(`watch:${kind}`, timer)
  }

  private pollRun(runId: string, kind: RunKind, intervalMs?: number): void {
    if (this.polling.has(runId)) return
    this.polling.add(runId)
    const api = this.apiRef
    if (api === null) return
    const interval = intervalMs ?? this.pollIntervalMs
    const tick = (): void => {
      if (!this.polling.has(runId)) return
      void api.progress(runId).then(
        (state) => {
          if (!this.polling.has(runId)) return
          if (state.status === 'running') {
            this.patchProgress(kind, state)
            this.scheduleTick(runId, tick, interval)
          } else {
            this.polling.delete(runId)
            this.applySettled(kind, state)
          }
        },
        () => {
          // 404（过保留期）/网络错误：run 不可恢复，停止轮询并如实提示
          this.polling.delete(runId)
          this.applyGone(kind)
        },
      )
    }
    this.scheduleTick(runId, tick, interval)
  }

  /** 调度下一轮询；每 runId 只保留一个挂起定时器（fire 后由下一次调度覆盖）。 */
  private scheduleTick(runId: string, tick: () => void, intervalMs: number): void {
    const timer = setTimeout(tick, intervalMs)
    this.timers.set(runId, timer)
  }

  private patchProgress(kind: RunKind, state: RunState): void {
    const event = mapRunProgress(kind, state)
    if (kind === 'export') this.patch({ export: { progress: event } })
    else if (kind === 'restore') this.patch({ snapshots: { running: true } })
    else if (kind === 'recovery') this.patch({ recovery: { running: true } })
    else {
      // 同步写入 runId：watchRunning 发现活跃 import run 时立即填充——
      // 否则 fresh run（非刷新恢复）期间 store.runId 仍是上一次导入的陈旧值
      // （/execute 响应在整段导入完成后才带 runId），「跳过当前插件」会打到旧 run。
      this.patch({ import: { progress: event, runId: state.runId } })
    }
  }

  /** run 完成/失败：把 RunState.result 回填 store（并镜像回控制器）。 */
  private applySettled(kind: RunKind, state: RunState): void {
    if (kind === 'export') {
      const result = state.result as
        | { zipPath: string; manifest: Manifest; report: ExportRunResult['report'] }
        | undefined
      if (state.status === 'done' && result !== undefined && typeof result.zipPath === 'string') {
        this.patch({
          export: {
            running: false,
            progress: { stage: 'done', step: 1, total: 1 },
            result: { ...result, text: renderExportReport(result.report, liveUiT) },
            downloaded: false,
          },
        })
      } else {
        this.patch({
          export: {
            running: false,
            progress: null,
            result: null,
            downloaded: false,
            error: state.error ?? liveUiT('run.exportUnavailable'),
          },
        })
      }
      return
    }
    // restore（P1-1）：完成/失败回填快照面板切片（running 复位 + report/actionError）。
    // 刷新恢复路径与面板本地状态收敛：applySettled 写入 store，面板挂载时经
    // initFromStore 读取（切 tab 后回来也能看到结果）。
    if (kind === 'restore') {
      const result = state.result as RestoreReport | undefined
      if (state.status === 'done' && result !== undefined && typeof result === 'object') {
        this.patch({
          snapshots: { running: false, report: result, actionError: null },
        })
      } else {
        this.patch({
          snapshots: { running: false, actionError: state.error ?? liveUiT('run.restoreUnavailable') },
        })
      }
      return
    }
    // recovery（Phase 5）：完成/失败复位 running（verifyResult 由 RecoveryPanel 的
    // execute→verify 链回填；此处只复位瞬态，不臆断验证结果）
    if (kind === 'recovery') {
      this.patch({
        recovery: { running: false, actionError: state.error ?? null },
      })
      return
    }
    // import
    const result = state.result as ImportResult | undefined
    if (state.status === 'done' && result !== undefined && typeof result === 'object') {
      const wizard = this.importWizardInst
      if (wizard !== null) {
        const imp: ImportLiveState = {
          ...this.state.import,
          step: 'result',
          result,
          secretInputs: {},
          decryptPassword: '',
          decryptRefs: [],
          conflictCollector: null,
        }
        writeWizardSnapshot(wizard, imp)
      }
      this.patch({
        import: {
          step: 'result',
          result,
          running: false,
          progress: { stage: 'done', step: 1, total: 1 },
          error: null,
        },
      })
    } else {
      const wizard = this.importWizardInst
      // P0-8：失败后必须回到「可重试」的步骤 —— 不能停在 'importing'（视图按 step 分支
      // 渲染，只剩错误横幅、没有出口，用户只能刷新页面）。控制器是 step 的权威来源：
      // 它自己的 catch 已把 step 退回执行前步骤（正常是确认页 'preview'，结果页重试失败
      // 则回 'result'），这里镜像它；控制器尚未回退（轮询先于响应到达）或实例缺失时，
      // 兜底退回确认页（那里有「确认导入」与 ErrorBanner 的重试入口）。
      let stepAfterFailure: ImportWizardStep = 'preview'
      if (wizard !== null) {
        const restored = wizard.snapshot().step
        if (restored !== 'importing') stepAfterFailure = restored
        const internals = wizard as unknown as WizardInternals
        internals.errors = [...internals.errors, state.error ?? liveUiT('report.importFailed')]
      }
      this.patch({
        import: {
          step: stepAfterFailure,
          running: false,
          progress: null,
          error: state.error ?? liveUiT('report.importFailed'),
          errors: [...this.state.import.errors, state.error ?? liveUiT('report.importFailed')],
        },
      })
    }
  }

  /** run 消失（404/网络错误）：停止轮询并提示不可恢复。 */
  private applyGone(kind: RunKind): void {
    if (kind === 'export') {
      this.patch({
        export: {
          running: false,
          progress: null,
          runId: null,
          error: liveUiT('run.progressLost'),
        },
      })
    } else if (kind === 'restore') {
      // 恢复 run 被清理/丢失：复位 running（宿主侧恢复动作可能仍在执行——
      // 以 RunRegistry 为准，本提示只说明进度不可恢复，不臆断恢复已停止）
      this.patch({
        snapshots: {
          running: false,
          actionError: liveUiT('run.restoreProgressLost'),
        },
      })
    } else if (kind === 'recovery') {
      // recovery run 被清理/丢失：复位 running（宿主侧恢复动作可能仍在执行——
      // 以 RunRegistry 为准，本提示只说明进度不可恢复，不臆断恢复已停止）
      this.patch({
        recovery: {
          running: false,
          actionError: liveUiT('run.restoreProgressLost'),
        },
      })
    } else {
      this.importWizardInst?.reset()
      this.patch({
        import: {
          running: false,
          progress: null,
          runId: null,
          step: 'select',
          phase: 'preview',
          conflictCollector: null,
          selectedFileName: null,
          errors: [],
          error: liveUiT('run.progressLost'),
        },
      })
    }
  }
}

/** 模块级单例（浏览器半所有视图共享；构造时自动 load()）。 */
export const runStore = new RunStore()
