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
import { DEFAULT_CATEGORIES, ExportFlow } from '../ui/export-flow.ts'
import type { ExportRunResult } from '../ui/export-flow.ts'
import { ImportWizard } from '../ui/import-wizard.ts'
import { renderExportReport } from '../ui/report.ts'
import type { FlowPhase } from '../ui/flow.ts'
import type { ImportStep } from '../ui/types.ts'
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
import type { ProfileMeta, ProfileSwitchResult, SwitchPreview } from '../profiles/profile-manager.ts'
import type { MarketListItem, MarketDownloadResult } from '../market/types.ts'
import type { SyncPushReport, SyncPullReport, SyncPushPreview } from '../sync/sync-engine.ts'
import type { SyncStartResponse } from './sync/sync-api.ts'
import type { ChannelSyncState, SyncChannel } from './sync/sync-view.ts'
import { defaultChannelSyncState } from './sync/sync-view.ts'
import type { MarketApprovals } from './market/market-view.ts'
import type { MyItemEntry } from './market/my-configs-api.ts'
import type { MyInstallSlice, MyWizardSlice } from './market/my-configs-view.ts'
import type { SyncConflictResolution } from './sync/sync-view.ts'
import type { RecoveryPreview, RecoveryStatus, RecoveryVerifyResult } from '../ui/types.ts'

/* ---------------------------------------------------------------- 基础类型 */

/** 主视图（ConfigManagerSection 的「导出与导入」tab 内部子视图：导出备份 / 导入恢复）。 */
export type MainView = 'export' | 'import'

/**
 * 设置页低频面板（ConfigManagerSection 的 tab；panel 非空时覆盖主视图）。
 * 聚合优化（UX 2026-08）：把「关于」与「迁移历史」收进「更多」作为子 tab，
 * 「恢复」并入「备份与快照」作为子 tab —— 一级 tab 从 8 收敛为 6。
 * 旧持久化值（about/history/recovery）由 parsePersistedState 迁移到新结构。
 */
export type PanelId = 'snapshots' | 'sync' | 'market' | 'profiles' | 'more'

/** 导出模式。 */
export type ExportMode = 'quick' | 'custom'

/** 存储抽象（浏览器 sessionStorage / 测试 mock / 无存储）。 */
export interface StoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** sessionStorage 键。 */
export const STATE_KEY = 'dsh.cfgMgr.state.v1'

/** Custom 模式的初始勾选 = 推荐分区（可再调整） */
export function defaultCustomSelection(): SectionId[] {
  return DEFAULT_CATEGORIES
    .filter((c) => c.defaultIncluded)
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
  /** git/webdav 通道各自独立的设置状态（自动同步、同步模式、加密、快照） */
  byChannel: {
    git: ChannelSyncState
    webdav: ChannelSyncState
  }
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

/** 单通道状态的持久化切片 = 运行时剔除密码类敏感字段（安全关键，白名单单一出口）。 */
export type PersistedChannelSyncState = Omit<
  ChannelSyncState,
  'encryptPassword' | 'encryptPasswordConfirm' | 'decryptPassword'
>

/** 同步面板的持久化切片 = 运行时切片剔除敏感字段（顶层凭据 + byChannel 密码类）与瞬态字段。 */
export type PersistedSyncState = Omit<SyncStoreSlice, 'token' | 'webdavPassword' | 'busy' | 'savingConfig' | 'byChannel'> & {
  byChannel: {
    git: PersistedChannelSyncState
    webdav: PersistedChannelSyncState
  }
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
  /** 逐分区批准表（安全不变式 (c)：高风险分区默认不勾选） */
  approvals: MarketApprovals
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
 * 快照面板二级 tab：restore = 快照恢复（导入前回滚点）；files = 备份文件管理；
 * recovery = 恢复（Phase 5，事故驱动的回滚/恢复 —— 聚合优化后并入「备份与快照」）。
 * 旧顶级 tab `panel:'recovery'` 在 parsePersistedState 迁移为 `panel:'snapshots'` + `subTab:'recovery'`。
 */
export type SnapshotsSubTab = 'restore' | 'files' | 'recovery'

/** 配置档案面板的运行时切片（无敏感字段：Profile 天然不含秘密值）。 */
export interface ProfilesStoreSlice {
  /** Profile 列表（null = 尚未加载） */
  profiles: ProfileMeta[] | null
  /** 当前选中 Profile 名（切换预览目标） */
  selectedName: string | null
  /** 切换预览（null = 无预览会话；非敏感） */
  preview: SwitchPreview | null
  /** 最近一次切换结果（报告/回滚；非敏感） */
  switchResult: ProfileSwitchResult | null
  /** 已 redact 的错误文本 */
  error: string | null
  loadError: string | null
}

export interface SnapshotsStoreSlice {
  selectedId: string | null
  plan: RestorePlan | null
  /** 真实恢复执行中（瞬态；宿主 /runs 是权威来源，本字段只是镜像） */
  running: boolean
  report: RestoreReport | null
  actionError: string | null
  error: string | null
  /** 定时备份设置草稿（未保存修改切 tab / 刷新保留；null = 无草稿，以宿主配置为准） */
  backupDraft: BackupScheduleDraft | null
  /** 「一键导入」请求（内存瞬态：快照面板点导入 → 切到 Import tab，向导挂载时消费）。
   *  zipPath 指向宿主 exports 目录的备份文件；消费后立即清空，不持久化。 */
  importBackup: { zipPath: string; name: string } | null
  /** 当前二级 tab（restore/files；切 tab / 刷新恢复；非敏感可持久化） */
  subTab: SnapshotsSubTab
}

/**
 * Recovery 面板的运行时切片（Phase 5 §10.4）。
 * status/preview/verifyResult 为非敏感可持久化（切 tab/刷新恢复）；running 为
 * 「内存切片瞬态」：切 tab 由模块级单例保留、刷新时被 toPersistedState 白名单剔除
 * —— 恢复是否仍在执行以宿主 RunRegistry（/runs + /progress）为权威，刷新后经
 * resume() 重新发现；浏览器持久化绝不作为 destructive operation 的状态源。
 */
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

/**
 * 「更多」面板的运行时切片（聚合优化 2026-08：把「关于」与「迁移历史」收进
 * 「更多」作为子 tab，一级 tab 从 8 收敛为 6）。仅记录当前子视图，非敏感可持久化
 * （切 tab/刷新恢复）；关于/历史面板自身的低频状态组件内自持，不关联本切片。
 */
export interface MoreStoreSlice {
  /** 「更多」下的子视图：迁移历史 / 关于 */
  moreSub: 'history' | 'about'
}

/** 「更多」子视图类型。 */
export type MoreSubTab = MoreStoreSlice['moreSub']

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
  mode: ExportMode
  selection: SectionId[]
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
  uploading: boolean
  running: boolean
  progress: RunProgress | null
  error: string | null
  runId: string | null
}

/** 刷新恢复的顶层持久化状态（v1 结构版本；旧载荷缺新字段时回退默认）。 */
export interface PersistedState {
  v: 1
  view: MainView
  /** 当前打开的低频面板（null = 主视图 export/import）；刷新后回到原 tab */
  panel: PanelId | null
  export: PersistedExportState
  import: PersistedImportState
  sync: PersistedSyncState
  market: MarketStoreSlice
  snapshots: SnapshotsStoreSlice
  profiles: ProfilesStoreSlice
  recovery: RecoveryStoreSlice
  more: MoreStoreSlice
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
  view: MainView
  panel: PanelId | null
  export: ExportLiveState
  import: ImportLiveState
  sync: SyncStoreSlice
  market: MarketStoreSlice
  snapshots: SnapshotsStoreSlice
  profiles: ProfilesStoreSlice
  recovery: RecoveryStoreSlice
  more: MoreStoreSlice
}

/** patch 的输入形状（浅合并对应切片）。 */
export interface StorePatch {
  view?: MainView
  /** null = 回到主视图（export/import） */
  panel?: PanelId | null
  export?: Partial<ExportLiveState>
  import?: Partial<ImportLiveState>
  sync?: Partial<SyncStoreSlice>
  market?: Partial<MarketStoreSlice>
  snapshots?: Partial<SnapshotsStoreSlice>
  profiles?: Partial<ProfilesStoreSlice>
  recovery?: Partial<RecoveryStoreSlice>
  more?: Partial<MoreStoreSlice>
}

/** 向导 step 的类型别名（与 src/ui/types.ts 的 ImportStep 保持一致）。 */
type ImportWizardStep = ImportStep

/* ------------------------------------------------------------- 默认值 */

function defaultExportState(): ExportLiveState {
  return {
    mode: 'quick',
    selection: defaultCustomSelection(),
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
    byChannel: {
      git: defaultChannelSyncState(),
      webdav: defaultChannelSyncState(),
    },
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
    approvals: {},
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
    running: false,
    report: null,
    actionError: null,
    error: null,
    backupDraft: null,
    importBackup: null,
    subTab: 'restore',
  }
}

function defaultProfilesState(): ProfilesStoreSlice {
  return {
    profiles: null,
    selectedName: null,
    preview: null,
    switchResult: null,
    error: null,
    loadError: null,
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

function defaultMoreState(): MoreStoreSlice {
  return {
    moreSub: 'about',
  }
}

function defaultState(): StoreState {
  return {
    v: 1,
    view: 'export',
    panel: null,
    export: defaultExportState(),
    import: defaultImportState(),
    sync: defaultSyncState(),
    market: defaultMarketState(),
    snapshots: defaultSnapshotsState(),
    profiles: defaultProfilesState(),
    recovery: defaultRecoveryState(),
    more: defaultMoreState(),
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
    byChannel: {
      git: { ...s.byChannel.git, snapshots: [...s.byChannel.git.snapshots] },
      webdav: { ...s.byChannel.webdav, snapshots: [...s.byChannel.webdav.snapshots] },
    },
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
    approvals: s.approvals,
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
    running: s.running,
    report: s.report,
    actionError: s.actionError,
    error: s.error,
    backupDraft: s.backupDraft,
    importBackup: s.importBackup,
    subTab: s.subTab,
  }
}

/** 从配置档案面板状态提取切片（结构兼容：传入 PanelState 亦可）。 */
export function toProfilesStoreSlice(s: ProfilesStoreSlice): ProfilesStoreSlice {
  return {
    profiles: s.profiles,
    selectedName: s.selectedName,
    preview: s.preview,
    switchResult: s.switchResult,
    error: s.error,
    loadError: s.loadError,
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

/**
 * 持久化白名单：解构剔除敏感字段（password/passwordConfirm/secretInputs/decryptPassword）
 * 与不可序列化的实例字段（conflictCollector），以及同步面板的凭据字段
 * （token/webdavPassword/encryptPassword/encryptPasswordConfirm/decryptPassword ——
 * 含 byChannel 内每通道的加密/解密密码）与瞬态字段（busy/savingConfig —— 刷新后
 * 回复空闲，不把「进行中」状态带到新页面）；导出面板的结果字段（result/downloaded）
 * 与进行中/进度（running/progress/runId）同为内存切片瞬态一并剔除（刷新/关闭 DSH
 * 后不残留上次导出报告），其余原样落入 sessionStorage。
 * 这是 sessionStorage 的唯一写入路径 —— 敏感值在此被硬性隔离。
 */
export function toPersistedState(state: StoreState): PersistedState {
  const {
    password: _password, passwordConfirm: _passwordConfirm,
    // 导出结果/进度为内存切片瞬态（切 tab 由模块级单例保留、刷新/关闭 DSH 清空）：
    // 不落盘，旧导出报告与「已保存」提示不残留展示 —— 与 sync 面板 busy 同级
    result: _result, downloaded: _downloaded, running: _running,
    progress: _progress, runId: _runId,
    ...exportRest
  } = state.export
  const {
    secretInputs: _secretInputs, decryptPassword: _decryptPassword, decryptRefs: _decryptRefs,
    archiveUnlocked: _archiveUnlocked, conflictCollector: _conflictCollector,
    // 导入中「跳过当前」为内存瞬态（刷新后复位，避免遗留禁用态）
    skipRequested: _skipRequested, ...importRest
  } = state.import
  const {
    token: _token, webdavPassword: _webdavPassword, busy: _busy, savingConfig: _savingConfig,
    ...syncRest
  } = state.sync
  // byChannel 内每通道的密码类字段同样硬性剔除（安全不变量：不落盘任何密码）
  const stripChannelSensitive = (c: ChannelSyncState): PersistedChannelSyncState => {
    const { encryptPassword: _ep, encryptPasswordConfirm: _epc, decryptPassword: _dp, ...rest } = c
    return rest
  }
  return {
    v: 1,
    view: state.view,
    panel: state.panel,
    export: exportRest,
    import: importRest,
    sync: {
      ...syncRest,
      byChannel: {
        git: stripChannelSensitive(state.sync.byChannel.git),
        webdav: stripChannelSensitive(state.sync.byChannel.webdav),
      },
    },
    market: state.market,
    snapshots: {
      ...state.snapshots,
      // 快照恢复 running 为内存切片瞬态：不落盘 —— 恢复是否仍在执行以宿主
      // RunRegistry（/runs + /progress）为权威，刷新后由 resume() 重新发现；
      // 持久化「running=true」会把浏览器陈旧状态误当成宿主真实状态（P1-1 原则）。
      running: false,
      // 「一键导入」请求为一次性内存瞬态：不落盘（刷新后回到导入向导 select 步骤）
      importBackup: null,
    },
    // 配置档案切片为非敏感（Profile 天然不含秘密值）：原样持久化（切 tab/刷新不丢列表与预览）
    profiles: {
      profiles: state.profiles.profiles,
      selectedName: state.profiles.selectedName,
      preview: state.profiles.preview,
      switchResult: state.profiles.switchResult,
      error: state.profiles.error,
      loadError: state.profiles.loadError,
    },
    // recovery 切片为非敏感（incidents/preview/verifyResult 无秘密值）：原样持久化；
    // running 为内存切片瞬态：不落盘 —— 恢复是否仍在执行以宿主 RunRegistry
    // （/runs + /progress）为权威，刷新后由 resume() 重新发现（P1-1 原则）。
    recovery: {
      ...state.recovery,
      running: false,
    },
    // 「更多」切片为非敏感（仅记录子视图 history/about）：原样持久化（切 tab/刷新恢复）
    more: state.more,
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
  const view = p['view']
  if (view !== 'export' && view !== 'import') return null
  const exp = p['export']
  const imp = p['import']
  if (typeof exp !== 'object' || exp === null || typeof imp !== 'object' || imp === null) return null
  // panel：旧载荷可能缺失 → null（回到主视图）；非法值 → null。
  // 聚合优化（2026-08）旧值迁移：'about'/'history' → 'more' + 对应 moreSub；
  // 'recovery' → 'snapshots' + snapshots.subTab='recovery'。旧 8 tab 值在新结构下不丢状态。
  const rawPanel = p['panel']
  let panel: PanelId | null = null
  let moreSub: MoreStoreSlice['moreSub'] = 'about'
  let snapshotsSubTab: SnapshotsSubTab = 'restore'
  switch (rawPanel) {
    case 'snapshots':
    case 'sync':
    case 'market':
    case 'profiles':
    case 'more':
      panel = rawPanel
      break
    case 'about':
      panel = 'more'
      moreSub = 'about'
      break
    case 'history':
      panel = 'more'
      moreSub = 'history'
      break
    case 'recovery':
      panel = 'snapshots'
      snapshotsSubTab = 'recovery'
      break
    default:
      panel = null
      break
  }
  // sync/market/snapshots：旧载荷可能缺失 → 默认切片（字段级缺失由 applyPersisted 兜底）
  const sync = isRecord(p['sync']) ? p['sync'] as unknown as PersistedSyncState : defaultSyncState()
  const market = isRecord(p['market']) ? p['market'] as unknown as MarketStoreSlice : defaultMarketState()
  const snapshots = isRecord(p['snapshots']) ? p['snapshots'] as unknown as SnapshotsStoreSlice : defaultSnapshotsState()
  const profiles = isRecord(p['profiles']) ? p['profiles'] as unknown as ProfilesStoreSlice : defaultProfilesState()
  const recovery = isRecord(p['recovery']) ? p['recovery'] as unknown as RecoveryStoreSlice : defaultRecoveryState()
  // 从旧顶级 tab 'recovery' 迁移：快照面板 subTab 强制为 recovery（用户当时在恢复 tab）
  const migratedSnapshots: SnapshotsStoreSlice = rawPanel === 'recovery'
    ? { ...snapshots, subTab: snapshotsSubTab }
    : snapshots
  // 「更多」切片：旧载荷可能缺失 → 默认（about）；若从旧 about/history 迁移，用迁移值覆盖
  const more = isRecord(p['more'])
    ? { ...defaultMoreState(), ...p['more'] as unknown as MoreStoreSlice }
    : { moreSub }
  return { v: 1, view, panel, export: exp as PersistedExportState, import: imp as PersistedImportState, sync, market, snapshots: migratedSnapshots, profiles, recovery, more }
}

/** 运行时不变量小工具：值为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
function mapRunProgress(kind: RunKind, state: RunState): RunProgress {
  return {
    stage: kind === 'export' ? 'exporting' : 'executing',
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

  /** 浅合并补丁并立即持久化（保存走白名单，敏感字段不落盘）。 */
  patch(patchObj: StorePatch): void {
    this.state = {
      ...this.state,
      view: patchObj.view ?? this.state.view,
      // panel 可被显式置回 null（回到主视图），故用 undefined 判断而非 ?? 兜底
      panel: patchObj.panel !== undefined ? patchObj.panel : this.state.panel,
      export: { ...this.state.export, ...patchObj.export },
      import: { ...this.state.import, ...patchObj.import },
      sync: { ...this.state.sync, ...patchObj.sync },
      market: { ...this.state.market, ...patchObj.market },
      snapshots: { ...this.state.snapshots, ...patchObj.snapshots },
      profiles: { ...this.state.profiles, ...patchObj.profiles },
      recovery: { ...this.state.recovery, ...patchObj.recovery },
    }
    this.notify()
    this.save()
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
      view: parsed.view,
      panel: parsed.panel,
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
              encrypt: legacySync['encrypt'] === true,
              includeSecrets: legacySync['includeSecrets'] === true,
              selectedSnapshotId: typeof legacySync['selectedSnapshotId'] === 'string'
                ? legacySync['selectedSnapshotId']
                : '',
              snapshots: [],
              autosync: null,
              autosyncEnabled: false,
              autosyncInterval: '30m',
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
          byChannel: {
            git: {
              ...defaultChannelSyncState(),
              ...(legacyGit ?? parsed.sync.byChannel?.git),
              encryptPassword: '',
              encryptPasswordConfirm: '',
              decryptPassword: '',
            } as ChannelSyncState,
            webdav: {
              ...defaultChannelSyncState(),
              ...parsed.sync.byChannel?.webdav,
              encryptPassword: '',
              encryptPasswordConfirm: '',
              decryptPassword: '',
            } as ChannelSyncState,
          },
        }
      })(),
      market: { ...defaultMarketState(), ...parsed.market },
      snapshots: {
        ...defaultSnapshotsState(),
        ...parsed.snapshots,
        // 硬性：恢复执行中为瞬态，绝不从存储恢复（即使旧载荷携带 running=true 也清空）——
        // 是否仍有恢复在执行以宿主 /runs 为权威，resume() 会重新发现并置 true
        running: false,
        // 硬性：「一键导入」请求为一次性瞬态，绝不从存储恢复
        importBackup: null,
        // 旧载荷可能缺 subTab / 带非法值 → 归一（只认 restore/files/recovery；聚合优化加 recovery）
        subTab: parsed.snapshots.subTab === 'files' ? 'files' : parsed.snapshots.subTab === 'recovery' ? 'recovery' : 'restore',
      },
      profiles: { ...defaultProfilesState(), ...parsed.profiles },
      recovery: {
        ...defaultRecoveryState(),
        ...parsed.recovery,
        // 硬性：恢复执行中为瞬态，绝不从存储恢复（即使旧载荷携带 running=true 也清空）——
        // 是否仍有恢复在执行以宿主 /runs 为权威，resume() 会重新发现并置 true
        running: false,
      },
      // 「更多」切片非敏感（仅子视图 history/about），原样恢复；moreSub 非法值归一为 about
      more: { moreSub: parsed.more.moreSub === 'history' ? 'history' : 'about' },
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
    const missing = this.state.import.plan?.missingSecrets ?? []
    if (this.state.import.phase === 'confirm' && missing.length > 0) {
      this.state.import.phase = 'secrets'
    }
    // 加密备份（普通 ZIP 内 secrets.enc，非容器）在旧版本中有独立的解密阶段；
    // 现在解密密码只在「解锁加密备份」时输入一次（containerEncrypted 场景已由上面的
    // decrypt-archive 兜底强制退回重新解锁），不再存在 decrypt 阶段，无需此处兜底。
    // 冲突阶段：由恢复后的 plan + 决策重建 collector（刷新后实例必然丢失）
    const imp = this.state.import
    if (imp.phase === 'conflicts' && imp.plan !== null) {
      imp.conflictCollector = rebuildConflictCollector(imp.plan, imp.conflictResolutions)
    }
  }

  /** 把非敏感状态写入 sessionStorage（白名单序列化；无存储时为空操作）。 */
  save(): void {
    if (this.storage === null) return
    try {
      this.storage.setItem(STATE_KEY, JSON.stringify(toPersistedState(this.state)))
    } catch {
      // 存储满/不可用：静默降级，状态仍完整存在于内存
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
          error: '上次导出任务已结束但结果无法恢复，请重新导出',
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
          error: '上次导入任务已结束或超过保留期，结果无法恢复，请重新导入',
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
          actionError: '上次恢复任务已结束但结果无法恢复，请重新执行',
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
          actionError: '上次恢复任务已结束但结果无法恢复，请重新执行',
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
            result: { ...result, text: renderExportReport(result.report) },
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
            error: state.error ?? '导出失败（结果不可用）',
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
          snapshots: { running: false, actionError: state.error ?? '恢复失败（结果不可用）' },
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
      if (wizard !== null) {
        const internals = wizard as unknown as WizardInternals
        internals.errors = [...internals.errors, state.error ?? '导入失败']
      }
      this.patch({
        import: {
          running: false,
          progress: null,
          error: state.error ?? '导入失败',
          errors: [...this.state.import.errors, state.error ?? '导入失败'],
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
          error: '任务已结束或超过保留期，进度不可恢复',
        },
      })
    } else if (kind === 'restore') {
      // 恢复 run 被清理/丢失：复位 running（宿主侧恢复动作可能仍在执行——
      // 以 RunRegistry 为准，本提示只说明进度不可恢复，不臆断恢复已停止）
      this.patch({
        snapshots: {
          running: false,
          actionError: '恢复任务已结束或超过保留期，进度不可恢复',
        },
      })
    } else if (kind === 'recovery') {
      // recovery run 被清理/丢失：复位 running（宿主侧恢复动作可能仍在执行——
      // 以 RunRegistry 为准，本提示只说明进度不可恢复，不臆断恢复已停止）
      this.patch({
        recovery: {
          running: false,
          actionError: '恢复任务已结束或超过保留期，进度不可恢复',
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
          error: '任务已结束或超过保留期，进度不可恢复',
        },
      })
    }
  }
}

/** 模块级单例（浏览器半所有视图共享；构造时自动 load()）。 */
export const runStore = new RunStore()
