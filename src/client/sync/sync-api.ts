/**
 * 远程同步浏览器半 —— `/api/dsh-config-manager/sync/*` 的类型化 fetch 封装。
 *
 * 端点常量与请求封装都是**单一来源**：路由常量见 `common/routes.ts`，
 * `readJson` / `getJson` / `postJson`（统一超时 + 取消 + 错误映射）见 `common/http.ts` ——
 * 本文件不再自定义副本（W4 收敛）。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/sync/status → SyncStatusResponse （配置/凭据/上次同步）
 * POST /api/dsh-config-manager/sync/push    → SyncPushReport    （body: { repoUrl, token?, snapshotId? }）
 * POST /api/dsh-config-manager/sync/pull    → SyncPullReport    （body: { repoUrl, token?, strategy?, snapshotId? }）
 * POST /api/dsh-config-manager/sync/github/start   → GithubDeviceFlowStartResponse（GitHub OAuth 设备码）
 * POST /api/dsh-config-manager/sync/github/poll    → GithubPollResponse（凭 flowId 轮询；成功时 token 已由 Host 写入 credentials）
 * POST /api/dsh-config-manager/sync/github/cancel  → { ok: true }
 * POST /api/dsh-config-manager/sync/github/validate → GithubValidateResponse（token 是否已配置且有效）
 * GET  /api/dsh-config-manager/sync/github/repositories → GithubRepositoriesResponse（选择已有仓库；只读）
 * POST /api/dsh-config-manager/sync/github/repositories → GithubCreateRepositoryResponse（新建仓库；**宿主强制 private**）
 * ```
 *
 * 安全约束：
 *  - token 只存在于请求体内（同源 loopback，与导入 secretInputs 同策略），由 Host 写入
 *    DSH credentials（credentialRef），绝不落同步文件/日志/URL；响应永不回传 token；
 *  - GitHub device flow：浏览器只持有 flowId（随机 id）+ user_code + 授权页 URL；
 *    device_code 与 access token 只存在于宿主（内存 / DSH credentials），永不回传；
 *  - 错误消息由 Host 侧已脱敏（GitTransport 统一 [REDACTED]），UI 侧再经 ErrorBanner redact 兜底；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle；sync-engine 仅作 type-only 引用）。
 */
import type { SyncPullReport, SyncPushPreview, SyncPushReport } from '../../sync/sync-engine.ts';
import type { SyncTransportType as HostSyncTransportType } from '../../sync/sync-config.ts';
// 云端点通道的**回传视图**（只带 secretStored 布尔，绝无密钥值）：类型直接取宿主声明处，
// type-only 引用打包时被擦除，不会把 sync-config.ts 的 node:fs 带进浏览器产物。
import type { CloudGistChannelView, CloudS3ChannelView } from '../../sync/sync-config.ts';
import type { PathMapping, PlanItemKind, SessionFormatDisposition } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import type { ConsultReport } from '../../core/migration-consult.ts';
import { getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts';
import { CONFIG_MANAGER_API, SYNC_API } from '../common/routes.ts';
import type { ExportPreviewResponse } from '../api.ts';
import type { UiT } from '../../ui/i18n.ts';
import { repoCreateBody } from '../../ui/sync-repository-picker.ts';

/** 同步端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持既有导入面。 */
export { SYNC_API };

/** DSH credentials 中的同步 token 引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN';

/** WebDAV 通道密码在 DSH credentials 中的引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD';

/**
 * 远程同步通道类型：git（默认）或 webdav。
 * **唯一来源** = 宿主 src/sync/sync-config.ts 的 SYNC_CHANNELS（此处仅 type-only 别名：
 * 客户端 bundle 必须自包含，type-only 引用会被完全擦除，不会把宿主的 node:fs 带进浏览器产物）。
 */
export type SyncTransportType = HostSyncTransportType;

/** GET /sync/status 响应：配置/凭据/上次同步的只读事实（无任何 secret 值） */
export interface SyncStatusResponse {
  ok: boolean;
  /**
   * 方案 A：是否存在同步基线（本地祖先指针；宿主只回布尔，绝不回快照 id）。
   * **缺省 undefined = 未知 → 一律按「无基准」处理**，走老导入确认路径（fail-safe）。
   */
  hasBaseline?: boolean;
  /** 是否已保存过仓库/通道配置（sync-config.json；任一通道配置过即为 true） */
  configured: boolean;
  /** git 通道：已配置的仓库地址（不含 token，可回显；与当前通道无关，配置过即返回） */
  repoUrl?: string;
  /** git 通道：DSH credentials 中是否已存在 token（describe 只报状态，值永不返回） */
  credentialConfigured: boolean;
  credentialWritable: boolean;
  /** webdav 通道：配置状态（url 可回显，username 非敏感；password 值永不返回；
   *  与当前通道无关，配置过即返回，供 git ↔ webdav 切换时回填表单） */
  webdav?: WebDavStatusResponse;
  /**
   * 云端点通道 s3 的非密配置视图（**只有 secretStored 布尔，绝无 AccessKey Secret 值**）。
   * 配置过即返回（与当前活动通道无关），供表单在各通道间切换时回填。
   */
  s3?: CloudS3ChannelView;
  /** 云端点通道 gist 的非密配置视图（**只有 secretStored 布尔，绝无 token 值**）。 */
  gist?: CloudGistChannelView;
  /** 已保存的云端点 provider 清单（只有名字；切换 provider 时回填用） */
  cloudSavedProviders?: string[];
  /** sync-state.lastSyncAt；'' = 从未同步 */
  lastSyncAt?: string;
  /** sync-state.sections 条目数 */
  sectionCount: number;
  transport?: { type: string; ref: string };
  /** 上次选择的同步通道（磁盘 ui-prefs.json；UI 回填优先于此，localStorage 仅兜底） */
  lastSyncChannel?: SyncTransportType;
  /** 可同步分区目录（「高级/自定义导出」勾选列表；host adapters 唯一事实源，只含 portable） */
  syncSections?: SyncSectionInfo[];
  /** 当前分区选择（当前激活通道；UI 回填用，自动同步与手动 push 共用） */
  syncSelection?: SyncSelectionPayload;
  /** 全部通道的分区选择（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  syncSelectionByChannel?: Record<SyncTransportType, SyncSelectionPayload>;
  /** 全部通道的「同步密码是否已保存」状态（只回布尔，密码值永不回传浏览器） */
  syncCredentialsByChannel?: Record<SyncTransportType, SyncPasswordState>;
  /** 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9） */
  autosync?: AutosyncStatusResponse;
  /** 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  autosyncByChannel?: Record<SyncTransportType, AutosyncStatusResponse>;
  /**
   * issue #79：git 工作副本与配置地址的关系（host 只读自检）。
   *  - `{ facts }` = 自检成功（origin 是否已跟随 repoUrl）
   *  - `{ error }` = 自检读不出来（git 不可用 / 工作副本异常）——**如实回传**，不伪装成「不存在」
   */
  workDir?: { facts: SyncWorkDirFacts } | { error: string };
}

/** git 工作副本自检事实（与宿主 GitWorkDirFacts 同形；无任何敏感值）。 */
export interface SyncWorkDirFacts {
  /** 工作副本路径 */
  path: string;
  /** `.git` 是否存在 */
  exists: boolean;
  /** 当前 origin（读不出 → null） */
  origin: string | null;
  /** 单独配置的 push URL（未单独配置 → null） */
  pushUrl: string | null;
  /** fetch / push 地址是否都已跟随 repoUrl */
  match: boolean;
  /** 未上行的本地提交数（仅 detail 自检时给出，否则 null） */
  ahead: number | null;
  /** 工作树是否有未提交改动（仅 detail 自检时给出，否则 null） */
  dirty: boolean | null;
  /** 远端分支上的快照数（仅 detail 自检时给出，否则 null；issue #104 建议 3） */
  remoteSnapshots: number | null;
}

/** 同步密码的保存状态（只回布尔；密码值永不回传浏览器）。 */
export interface SyncPasswordState {
  /** 加密备份密码是否已保存到本机凭据库（DSH credentials） */
  encryptPasswordConfigured: boolean;
  /** 解密密码是否已保存到本机凭据库 */
  decryptPasswordConfigured: boolean;
}

/** 同步分区选择（POST /sync/selection 请求体 + status.syncSelection 响应；持久化于 Host）。
 *  git/webdav 通道各自独立（transport 缺省 git）。 */
export interface SyncSelectionPayload {
  /** 目标通道（git/webdav 各自独立的模式与勾选；缺省 git） */
  transport?: SyncTransportType;
  mode: 'default' | 'advanced';
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
  /** sessions（历史会话）分区同步「最新 N 个会话」上限；缺省 5 */
  sessionsLimit?: number;
  /**
   * 显式点名的会话单元 id（非空时优先于 sessionsLimit；空数组 = 回到「最新 N 个」模式）。
   * 与导出选择器的单元 id 同一命名空间（sessions:<projectKey>/<sessionId>）。
   */
  sessionsInclude?: string[];
  /** 手动推送默认加密快照（开关持久化；密码存 DSH credentials，见下） */
  encrypt?: boolean;
  /** 手动推送默认导出真实凭据值（必须同时 encrypt） */
  includeSecrets?: boolean;
  /**
   * 加密备份密码（可选）：非空 → 写入本机凭据库（DSH credentials）后长期复用。
   * 只走请求体内存传输，绝不写入同步文件 / 日志 / 响应。
   */
  encryptPassword?: string;
  /** 解密密码（可选）：非空 → 写入本机凭据库，拉取加密快照时自动使用 */
  decryptPassword?: string;
  /** 主动删除已保存的加密密码（用户取消勾选「加密备份」时） */
  clearEncryptPassword?: boolean;
  /** 主动删除已保存的解密密码（用户点「删除已保存密码」时） */
  clearDecryptPassword?: boolean;
  /** 响应/状态回填：密码是否已保存在本机凭据库（只回布尔，绝不回值） */
  encryptPasswordConfigured?: boolean;
  decryptPasswordConfigured?: boolean;
}

/** webdav 通道状态字段（无任何 secret 值；password 只报 passwordConfigured 布尔） */
export interface WebDavStatusResponse {
  /** 上次使用的服务器地址（可回显；不含 userinfo） */
  url?: string;
  /** 上次使用的用户名（非敏感，可回显；供表单回填） */
  username?: string;
  /** 是否已填过用户名（布尔；便于 UI 提示徽章） */
  usernameConfigured: boolean;
  /** DSH credentials 中是否已存在密码（值永不返回） */
  passwordConfigured: boolean;
}

/** POST /sync/config 响应：保存成功后的轻量凭据状态（无 secret 值；UI 直接合并刷新徽章）。 */
export interface SyncConfigSaveResponse {
  ok: boolean;
  configured: boolean;
  transport: SyncTransportType;
  /** git 通道：token 是否已配置（值永不返回） */
  credentialConfigured: boolean;
  /** webdav 通道：username/password 是否已配置（值永不返回；git 通道为 undefined） */
  webdav?: {
    usernameConfigured: boolean;
    passwordConfigured: boolean;
  };
  /** 云端点通道保存后的非密视图（只带 secretStored 布尔，绝无密钥值） */
  s3?: CloudS3ChannelView;
  gist?: CloudGistChannelView;
}

/** POST /sync/config 且 clear:true 的响应：断开一条通道配置后的轻量事实（无任何 secret 值）。 */
export interface SyncChannelClearResponse {
  ok: boolean;
  /** 被断开的通道 */
  cleared: SyncTransportType;
  /** 该通道之前是否有配置（false = 本来就没配；幂等成功，不算失败） */
  removed: boolean;
  /** 断开后是否**还有**别的通道配置（false = 已无任何通道，页面应显示「未配置」） */
  configured: boolean;
  /** 断开后的活动通道（被删的是活动通道时已自动切到剩下的那条） */
  transport: SyncTransportType;
}

/** 可同步分区条目（status.syncSections 项）。只含 portable —— 与 SyncEngine 同步通道一致。 */
export interface SyncSectionInfo {
  id: SectionId;
  /** 展示名（host adapter displayName） */
  displayName: string;
  portability: 'portable' | 'deviceSpecific' | 'platformSpecific';
  defaultIncluded: boolean;
}

/** push 请求体（token 可选：非空则 Host 先写入 DSH credentials 再使用）。
 *  扁平形状与 Host parseSyncBody 一致：git 携带 repoUrl/token；
 *  webdav 携带 url/username/password（顶层，不嵌套 webdav 对象）。
 *  git 可执行文件固定使用系统 PATH 中的 git，不再接受自定义路径。
 *  sections 可选（高级/自定义导出模式）：只推送勾选分区；缺省 = 默认模式全部推荐分区。
 *  encrypt/encryptPassword/includeSecrets：加密快照（含可选密钥导出；密码仅内存传输，绝不落盘）。 */
export interface SyncPushPayload {
  /** 通道类型；缺省 'git' */
  transport?: SyncTransportType;
  repoUrl?: string;
  token?: string;
  /** webdav 通道字段（transport='webdav' 时使用；扁平顶层） */
  url?: string;
  username?: string;
  password?: string;
  /** 仅同步指定分区（缺省 = 全部 portable 推荐分区；即「默认/快速导出」vs「自定义导出」） */
  sections?: SectionId[];
  /**
   * sessions（历史会话）分区选项。**只有显式提供它**，sessions 才被允许进入同步通道；
   * limit = 只带「最新 N 个会话」（缺省 5；0 = 不带）。未提供 → 会话分区按普通
   * 非 portable 分区跳过并告警（安全默认：内容敏感的会话绝不悄悄随同步上行）。
   *
   * include（显式点名的会话单元 id，形如 sessions:<projectKey>/<sessionId>）非空时
   * **优先于 limit** —— 用户点名的对话必须赢（宿主侧见 SyncEngineOptions 的说明）。
   */
  sessions?: { limit?: number; include?: string[] };
  /** 加密快照（sections 载荷整体加密；开启时必须提供 encryptPassword） */
  encrypt?: boolean;
  /** 加密密码（仅本次请求体内存传输，Host 绝不落盘/落日志；encrypt=true 时必填） */
  encryptPassword?: string;
  /** 导出真实凭据值（必须同时 encrypt=true，否则 Host 拒绝：密钥绝不明文进同步通道） */
  includeSecrets?: boolean;
  /* ---------------- 云端点通道（s3 / gist）字段：与宿主 parseSyncBody 的扁平形状一致 ---------------- */
  /** s3：具体兼容商（s3 / oss / cos / minio / kodo） */
  provider?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  /** 对象键前缀（缺省 = 根前缀） */
  prefix?: string;
  /** AccessKey ID（标识符，可回显；不是密钥） */
  accessKeyId?: string;
  /** path-style 寻址（缺省跟随兼容商变体） */
  pathStyle?: boolean;
  /** 显式覆盖签名方言（高级覆盖；宿主忽略非法值） */
  dialectId?: 'aws4' | 'oss4';
  /** gist：目标 gist id */
  gistId?: string;
  /** gist：GitHub API 根（缺省 https://api.github.com） */
  apiBaseUrl?: string;
  /** gist：文件名前缀（缺省 dsh-sync） */
  filePrefix?: string;
  /**
   * 云端点密钥（s3 的 AccessKey Secret / gist 的 token）：**只写**。
   * 仅请求体内存传输；宿主写入 DSH credentials 槽位（cloudSecretRef）后即丢弃。
   * 响应、配置文件与日志里永远只有 `secretStored` 布尔。
   */
  secret?: string;
}

/** pull 请求体（strategy 缺省 merge：冲突保留待决策；snapshotId 缺省 = 最新；
 *  decryptPassword 可选：拉取加密快照时提供，仅内存传输）。 */
export interface SyncPullPayload extends SyncPushPayload {
  strategy?: 'merge' | 'replace' | 'skipExisting';
  snapshotId?: string;
  /** 解密密码（拉取/一键同步遇到加密快照时提供；仅内存传输，绝不落盘） */
  decryptPassword?: string;
}

/* ---------------------------------------------------------------- 连通性自检（cloud-sync 借鉴项 ②） */

/**
 * POST /sync/probe 结果。
 *
 * **失败也是正常返回**（HTTP 200 + \`ok:false\`）：测试连接是**预期会失败**的诊断动作，
 * 用 5xx 表达会被界面当成基础设施崩溃。\`message\` / \`hint\` 由通道层本地化并脱敏后原样带回。
 */
export interface SyncProbeSuccess {
  ok: true
  transport: string
  /** 结论（可直接展示的成功文案） */
  message: string
  /** 附加提醒（例如「该 S3 兼容端点应把 region 填成 xxx」），有值时界面按 warn 级展示 */
  hint?: string
  /** 远端已有快照数（取得时回传） */
  snapshotCount?: number
  /** 自检过程中**自动创建**的远端目录（webdav 幂等 MKCOL；界面须逐条说明，绝不静默写远端） */
  createdCollections?: string[]
}

/** 自检失败（诊断动作的预期结果，不是异常） */
export interface SyncProbeFailure {
  ok: false
  error: string
  /**
   * **能力边界标记**：该通道不提供连通性自检（传输层未实现 probe）。
   *
   * 与故障**严格区分**：true = 这个通道没有这项能力（中性提示，同步功能不受影响）；
   * 缺省/undefined = 真的没连通（按故障展示）。界面据此选 info 而不是「操作失败」。
   */
  unsupported?: boolean
}

export type SyncProbeResult = SyncProbeSuccess | SyncProbeFailure

/* ---------------------------------------------------------------- 一键同步（方案 A） */

/** GET /sync/snapshots-list 响应：远端历史快照列表（按 createdAt 倒序）。 */
export interface SyncSnapshotsListResponse {
  ok: boolean;
  /** 按 createdAt 倒序（最新在前） */
  snapshots: SyncSnapshotLite[];
  /** 当前本地祖先指针（sync-state.lastSnapshotId），用于高亮当前基线 */
  currentSnapshotId?: string;
  /**
   * 远端**存在但读不出来**的快照（issue #59）。
   *
   * 为什么必须回传：列表跳过坏文件是必要防御，但静默跳过会让「推送成功 + 列表为空」
   * 变成自相矛盾且无从自查的状态。有值即代表「远端列表不完整」，界面须如实告知。
   */
  unreadable?: { file: string; reason: string }[];
}

/** 远端快照摘要（「选择历史快照」下拉项）。 */
export interface SyncSnapshotLite {
  id: string;
  createdAt: string;
  sectionCount: number;
  platform: string;
  dshVersion: string;
  /**
   * cloud-sync 借鉴项 ⑥：推送方设备身份（宿主从快照 manifest 读出）。
   * **旧快照没有这两个字段** —— 界面必须据此不显示设备行，绝不把 undefined 渲染成文案、
   * 也不显示空串占位。
   */
  deviceName?: string;
  /** 稳定设备 id（换主机名/改机器名都不变；用于认出「同一台设备」）。 */
  deviceId?: string;
}

/** POST /sync/sync 请求体（一键同步第一步：拉取 → 差异确认会话）。 */
export interface SyncStartPayload extends SyncPushPayload {
  /** 缺省 = 最新快照；传入则对该历史快照拉取 */
  snapshotId?: string;
  /**
   * 会话格式处置（T1）。**一键同步显式传 `guide`**：差异确认弹窗是本流程唯一的决策界面，
   * 而预览发生在它出现之前 —— 用缺省 abort 会让用户什么都看不到就被拒。真正的阻断语义
   * 由 apply-items 上同名字段承担（此刻已有决策界面），服务端两处都会校验。
   */
  sessionFormatDisposition?: SessionFormatDisposition;
}

/** POST /sync/sync 响应：差异确认会话（items 供 UI 逐项确认）。 */
export interface SyncStartResponse {
  ok: boolean;
  /** 差异确认会话 id：后续 apply-items / cancel 引用 */
  syncSessionId: string;
  /** 被拉取的远端快照 id */
  snapshotId: string;
  items: SyncConfirmItem[];
  /** 是否包含任何需人工决策项 */
  needsReview: boolean;
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  message?: string;
}

/** 单条可确认的差异项（由 ImportPlan.item 投影 + 冲突详情）。 */
export interface SyncConfirmItem {
  itemId: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  /** 变更详情（如插件「当前 1.1 vs 导入 1.6」），与导入恢复向导展示一致 */
  detail?: string;
  severity: 'info' | 'warning' | 'error';
  /** 默认采纳方向；Conflict/MissingSecret 等人工项默认 false */
  defaultAdopt: boolean;
  /** 用户最终决策（缺省 = defaultAdopt） */
  adopt: boolean;
  /** 冲突项内联解决所需详情（仅 Conflict 项非空） */
  conflict?: SyncConflictDetail;
  /** 该项若采用将写入的目标摘要 */
  target?: { adapter: SectionId; ref: string };
}

/** 冲突项内联解决详情（来源 MergeConflict + 可读 diff）。 */
export interface SyncConflictDetail {
  path: string;
  kind: 'key' | 'file' | 'section';
  local?: unknown;
  remote?: unknown;
  ancestor?: unknown;
  diff?: string;
}

/** POST /sync/apply-items 请求体（一键同步第二步：按逐项决策执行导入）。 */
export interface ApplyItemsPayload {
  syncSessionId: string;
  /** 每项的最终采纳决策（未列出项视为 adopt=false） */
  adoptions: SyncItemAdoption[];
  /**
   * 会话格式处置（T1）。一键同步当前恒传 `guide`（确认页尚无三选一控件；服务端已按
   * `abort`/`skip`/`guide` 三态校验）。缺省（不传）由宿主按插件配置项 → abort 决定。
   */
  sessionFormatDisposition?: SessionFormatDisposition;
}

/** 单条采纳决策。 */
export interface SyncItemAdoption {
  itemId: string;
  adopt: boolean;
  /** 冲突项解决方案（仅当该项是 Conflict 且 adopt=true 时必须）。
   *  与导入恢复向导一致：keepLocal=保留当前 / useRemote=使用导入；跳过 = adopt=false。 */
  resolution?: 'useRemote' | 'keepLocal';
}

/** POST /sync/apply-items 响应。 */
export interface ApplyItemsResponse {
  ok: boolean;
  applied: string[];
  skipped: string[];
  needsRestart: boolean;
  warnings: string[];
  /** 应用前快照 id（UI 一键回滚用） */
  restoreId: string;
  /** 任一失败是否整体回滚 */
  rolledBack: boolean;
  failed: { itemId: string; message?: string }[];
  /**
   * 未生效项（issue #56）：`status='warning'` 的计划项 —— 非致命但确实没写进去
   * （典型：插件安装失败，而排在它后面的步骤因此不会执行）。
   * `ok` 不会因它变 false，所以界面必须单独拿这个字段把「部分成功」讲出来。
   * 旧宿主不返回 → undefined（按「无未生效项」处理，不误报）。
   */
  ineffective?: { itemId: string; adapter: string; message?: string }[];
  /**
   * 「整体回滚是否完整」（诚实性，2026-10）。`rolledBack=true` 只说「触发了整体回滚」，
   * 不代表每一项都补偿成功（典型：原本已存在的凭据值 DSH 不可回读 → 无法自动恢复）。
   * 此时引擎把失败项并入 `warnings`，并置 `rollbackFull=false`；界面据此**不得**
   * 显示成「已整体回滚」，必须列出未恢复项。
   * 旧宿主不返回 → undefined（按旧的「已整体回滚」文案处理，不误报）。
   */
  rollbackFull?: boolean;
  result: unknown;
}

/** POST /sync/rollback 响应：一键回滚的诚实结果（full=false 时 failed 列出未回滚项）。 */
export interface SyncRollbackResponse {
  ok: boolean;
  /** 是否**每一项**都补偿成功（false = 部分回滚，配置可能停留在中间状态） */
  full: boolean;
  /**
   * 未回滚项（full=false 时非空）。`reason` = 为什么没能恢复；`manualHint` = 人工怎么补
   * （如「请重新补录该凭据」）。旧宿主不返回 → undefined（按「无未回滚项」处理）。
   */
  failed?: SyncRollbackFailedItem[];
  /** 同步历史写入失败（回滚本身已完成；仅提示） */
  historyWriteError?: string;
}

/** 单条未回滚项。 */
export interface SyncRollbackFailedItem {
  /** 形如 `<adapter>:<ref>` */
  item: string;
  reason: string;
  manualHint?: string;
}

/* ---------------------------------------------------------------- 远程合并裁决（T-ui-merge） */

/**
 * 合并冲突成因（对齐宿主 src/sync/merge.ts 的 MergeConflictReason）。
 * 未在本联合里的字符串照样可能从宿主回传 —— 界面侧一律经 merge-view.ts 的
 * mergeReasonKey() 映射，未知值按 both-modified 措辞，**绝不渲染裸枚举**。
 */
export type MergeConflictReason =
  | 'both-modified'
  | 'modify-delete'
  | 'delete-modify'
  | 'no-ancestor'
  | 'binary'
  | 'format'
  | 'array'
  | 'section';

/** 分区级合并决策（'conflict' = 双侧改动重叠，必须由用户裁决）。 */
export type MergeSectionDecision = 'useRemote' | 'keepLocal' | 'merge' | 'skip' | 'conflict';

/** 单条冲突的三列预览（已由宿主脱敏/序列化，界面负责截断）。 */
export interface MergePreviewConflict {
  /** 冲突位置：JSON 分区是 top-level key；FilesSection 是 relativePath。 */
  path: string;
  kind: 'key' | 'file';
  reason?: MergeConflictReason;
  localPreview: string;
  remotePreview: string;
  ancestorPreview: string;
}

/** 单个分区的合并预览。 */
export interface MergePreviewSection {
  id: SectionId;
  decision: MergeSectionDecision;
  /** 自动合并并入的变更点数量（仅自动合并成功时有意义） */
  autoMerged?: number;
  conflictCount: number;
  conflicts: MergePreviewConflict[];
}

/** 预览摘要（可自动应用 / 待裁决 / 冲突条目 / 无变化）。 */
export interface MergePreviewSummary {
  auto: number;
  review: number;
  conflicts: number;
  skipped: number;
}

/** POST /sync/merge-preview 请求体（只读；密码仅内存传输，绝不落盘/落日志）。 */
export interface MergePreviewPayload {
  /** 远端快照 id；缺省 = 最新 */
  snapshotId?: string;
  /** 解密密码（仅当远端快照加密时使用；缺省 = 已保存的 DECRYPT 凭据） */
  decryptPassword?: string;
  /** 跨机路径映射（与一键同步同一口径） */
  pathMappings?: PathMapping[];
}

/** POST /sync/merge-preview 响应（只读三方合并结果）。 */
export interface MergePreviewResponse {
  ok: boolean;
  snapshotId: string;
  /** 是否存在共同基准快照（false = 退化为两方比较，双侧不一致一律按冲突） */
  hasAncestor: boolean;
  sections: MergePreviewSection[];
  summary: MergePreviewSummary;
  /** 失败/降级原因（仅在 ok=false 等场景出现） */
  message?: string;
}

/** 单条裁决动作。 */
export type MergeResolutionActionWire = 'keepLocal' | 'useRemote' | 'useMerged' | 'skip';

/** 单条裁决：id = 分区 id（分区级）或 `分区id::冲突路径`（冲突级，见 merge-view.ts）。 */
export interface MergeResolution {
  id: string;
  action: MergeResolutionActionWire;
}

/** POST /sync/apply-merge 请求体（写动作；过 mutation gate）。 */
export interface MergeApplyPayload extends MergePreviewPayload {
  resolutions: MergeResolution[];
}

/** POST /sync/apply-merge 响应（字段与 /sync/apply-items 同风格 + pendingConflicts）。 */
export interface MergeApplyResponse {
  ok: boolean;
  applied: string[];
  skipped: string[];
  needsRestart?: boolean;
  warnings: string[];
  /** 执行前快照 id（界面一键回滚用） */
  restoreId?: string;
  /** 任一失败是否整体回滚 */
  rolledBack?: boolean;
  /** 整体回滚是否完整（false = 有项未恢复，见 warnings；缺省 = 旧宿主未回传） */
  rollbackFull?: boolean;
  /** 执行后仍待裁决的分区（下次同步仍会出现） */
  pendingConflicts: SectionId[];
  failed?: { itemId: string; message?: string }[];
  ineffective?: { itemId: string; adapter: string; message?: string }[];
  historyWriteError?: string;
}

/* ---------------------------------------------------------------- 自动同步 */

/** 统一间隔类型。 */
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';

/** 最近一次自动同步执行状态。 */
export type AutosyncRunStatus = 'success' | 'skipped' | 'failed' | 'partial';

/** 自动应用的最高风险等级（low = 只自动落低风险分区；medium = plugins/mcp 也自动落盘）。 */
export type AutosyncAutoApplyTier = 'low' | 'medium';

/** 双侧都改（真冲突）时的策略（ask = 保留冲突待人工裁决；local = 保留本机并推上去）。 */
export type AutosyncConflictPolicy = 'ask' | 'local';

/** GET/POST /sync/autosync 响应：自动同步状态。 */
export interface AutosyncStatusResponse {
  enabled: boolean;
  interval: AutosyncInterval;
  /** 真·自动同步：本地改动即时触发（缺省 true；host 读取层已补缺省） */
  realtime?: boolean;
  /** realtime 下的远端轮询间隔（ms；缺省 60000） */
  remoteCheckMs?: number;
  /** 自动应用的最高风险等级（缺省 medium：plugins/mcp 也自动落盘） */
  autoApplyTier?: AutosyncAutoApplyTier;
  /** 双侧都改时的策略（缺省 local：保留本机并推上去） */
  conflictPolicy?: AutosyncConflictPolicy;
  lastRunAt?: string;
  lastRunStatus?: AutosyncRunStatus;
  lastRunMessage?: string;
  /**
   * issue #79：本轮跳过的**结构化原因码**（界面按码取字典，绝不渲染裸枚举）。
   * 取值与同步历史的 skipReason 同一套：conflict / mutation-locked / encrypted /
   * unconfigured / upToDate / unchanged。
   */
  lastRunSkipReason?: string;
  /** 跳过涉及的分区数（当前仅 conflict：远端另有 N 个分区待确认） */
  lastRunSkipCount?: number;
  consecutiveFailures: number;
  /** 距上次自动同步已过 ms（host 计算，供 UI 倒计时/立即触发判断） */
  elapsedMs: number;
  lastRunHistoryId?: string;
}

/** POST /sync/autosync 请求体（transport 指定目标通道；git/webdav 各自独立）。 */
export interface AutosyncUpdatePayload {
  /** 目标通道（git/webdav 各自独立的开关/间隔/状态；缺省 git） */
  transport?: SyncTransportType;
  enabled: boolean;
  interval?: AutosyncInterval;
  startupMinIntervalMs?: number;
  /** 本地改动即时触发（缺省 true） */
  realtime?: boolean;
  /** realtime 下的远端轮询间隔（ms；宿主 clamp 到 15s–1h） */
  remoteCheckMs?: number;
  /** 自动应用等级（缺省 medium） */
  autoApplyTier?: AutosyncAutoApplyTier;
  /** 冲突策略（缺省 local） */
  conflictPolicy?: AutosyncConflictPolicy;
}

/* ---------------------------------------------------------------- 同步历史 */

/** 自动同步执行记录（§3.7 AutosyncHistoryEntry）。 */
export interface AutosyncHistoryEntry {
  /** 触发该次运行的同步通道（git / webdav；旧记录缺省 undefined） */
  transport?: SyncTransportType;
  direction: 'pull' | 'push' | 'both';
  status: 'success' | 'skipped' | 'failed' | 'partial';
  /** 跳过原因（冲突项 / 缺失依赖 / Install / 错误 / 无远端 / 网络） */
  skipReason?: string;
  /** 被跳过的冲突分区 id（冲突跳过时列出） */
  conflictedSections?: string[];
  /** 本次自动合并实际写入的分区 */
  appliedSections?: string[];
  /** 本次 push 产生的快照 id */
  pushedSnapshotId?: string;
  /** 本次 pull 来源快照 id */
  pulledSnapshotId?: string;
  error?: string;
  notifiedAt?: string;
  /** 本次触发时的连续失败计数 */
  failureCountAtRun: number;
  createdAt: string;
}

/** 同步历史条目（Host 端返回；kind='autosync' 时 autosync 非空）。 */
export interface SyncHistoryEntry {
  id: string;
  createdAt: string;
  kind: 'push' | 'pull' | 'apply' | 'autosync' | 'rollback';
  sectionCount?: number;
  reviewCount?: number;
  /** 快照类条目的触发通道（git / webdav；旧快照缺省 undefined） */
  transport?: string;
  autosync?: AutosyncHistoryEntry;
}

/** GET /sync/history 响应：{ entries }。 */
export interface SyncHistoryResponse {
  entries: SyncHistoryEntry[];
}

/* ---------------------------------------------------------------- GitHub OAuth device flow */

/** POST /sync/github/start 响应：UI 展示用（device_code 只存宿主，绝不回传） */
export interface GithubDeviceFlowStartResponse {
  /** 随机 flowId：后续 poll/cancel 凭它引用宿主侧登记的 device_code */
  flowId: string;
  /** 一次性用户码（用户在 GitHub 授权页输入） */
  userCode: string;
  /** GitHub 授权页 URL（用户浏览器打开） */
  verificationUri: string;
  /** 设备码过期秒数 */
  expiresIn: number;
  /** GitHub 建议轮询间隔秒数 */
  interval: number;
}

/** POST /sync/github/poll 响应状态 */
export type GithubPollStatus = 'pending' | 'success' | 'denied' | 'expired' | 'error';

/** POST /sync/github/poll 响应：成功时 token 已由 Host 写入 DSH credentials（值永不回传） */
export interface GithubPollResponse {
  status: GithubPollStatus;
  /** pending：下次轮询前应等待的毫秒数 */
  pollDelayMs?: number;
  /** 终止态错误码（GitHub error code） */
  errorCode?: string;
  /** 终止态可展示消息（来自 GitHub error_description / 宿主文案，不含秘密） */
  message?: string;
  /** success 时恒 true（凭据已配置）；便于 UI 直接刷新状态 */
  credentialConfigured?: boolean;
}

/** POST /sync/github/validate 响应：token 是否已配置 + 是否有效（GET /user；
 *  401 → 无效）。只回布尔 + 登录名（非敏感），token 值永不回传浏览器。 */
export interface GithubValidateResponse {
  ok: boolean;
  /** token 是否存在于 DSH credentials */
  configured: boolean;
  /** token 是否有效（GitHub GET /user 成功；configured=false 时恒 false） */
  valid: boolean;
  /** GitHub 登录名（valid=true 时；非敏感展示位） */
  login?: string;
}

/** 仓库列表条目（宿主 `GitHubRepoSummary` 的投影；token 等秘密永不在此出现）。 */
export interface GithubRepositorySummary {
  /** owner/name */
  fullName: string;
  /** 仓库主页（展示用） */
  htmlUrl: string;
  /** 提交值：clone URL（https 形态，不含凭据） */
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  /** 最近一次 push（ISO 8601；空仓库 → 空串） */
  pushedAt: string;
  /** 最近一次更新（ISO 8601；缺字段 → 空串） */
  updatedAt: string;
}

/** GET /sync/github/repositories 响应：当前 GitHub 用户可见的仓库（按最近更新排序）。 */
export interface GithubRepositoriesResponse {
  ok: boolean;
  repos: GithubRepositorySummary[];
}

/** POST /sync/github/repositories 响应：新建的仓库。
 *  **恒定私有** —— 宿主强制 private:true，客户端无法请求公开仓库。 */
export interface GithubCreateRepositoryResponse {
  ok: boolean;
  repo: GithubRepositorySummary;
}

/** 同步请求选项（长操作 5 分钟；超时文案沿用 `error.syncTimeout`，分钟插值）。 */
const SYNC_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.syncTimeout' };

/** 远程同步浏览器半数据入口（备份与迁移页第 4 个 tab 的注入业务面） */
export class SyncApi {
  readonly t: UiT
  constructor(t: UiT) {
    this.t = t
  }

  /** 读取同步状态（配置 / 凭据 / 上次同步时间 / 分区数 / 工作副本自检） */
  async status(): Promise<SyncStatusResponse> {
    return getJson<SyncStatusResponse>(SYNC_API.status, this.t, SYNC_OPTS);
  }

  /**
   * 重建 git 工作副本（issue #79 的自救入口）。
   *
   * - `relink`：只把 origin / push URL 重指向当前配置地址（非破坏性，不碰工作树与本地提交）；
   * - `adopt`：把当前地址的远端历史合并进工作副本（issue #104：换仓库 / 远端历史被重写后两条历史
   *   不相交，pull --ff-only 永远失败）。不改写本地提交、可 `git revert`，冲突由 host 自动 `merge --abort`；
   * - `reclone`：删除工作副本后重新 clone（**丢弃未上行的本地提交**）→ 必须带 `confirm: true`。
   *
   * 写动作：host 侧过 mutation gate（SAFE MODE / 环境锁）。
   */
  async workdirReset(payload: { mode: 'relink' | 'adopt' | 'reclone'; confirm?: boolean }): Promise<{ ok: boolean; mode: string; workDir: { facts: SyncWorkDirFacts } }> {
    return postJson<{ ok: boolean; mode: string; workDir: { facts: SyncWorkDirFacts } }>(SYNC_API.workdirReset, payload, this.t, SYNC_OPTS);
  }

  /**
   * cloud-sync 借鉴项 ②：连通性自检（**只读**）。
   *
   * 失败回 \`ok:false\` 而非抛错 —— 调用方必须按 \`result.ok\` 分流，把失败当**结论**展示，
   * 不要落进 catch（否则「连不上」会被渲染成崩溃）。
   */
  async probe(payload: SyncPushPayload): Promise<SyncProbeResult> {
    return postJson<SyncProbeResult>(SYNC_API.probe, payload, this.t, SYNC_OPTS);
  }

  /**
   * 分区条目清单（复用 /export-preview；**只读**，不写任何内容）。
   *
   * 用途：同步页的「逐会话勾选」需要单元清单（sessions 的每个会话目录 + 其所属工作区），
   * 而清单的权威来源就是导出预览那条路由（adapter.listUnits()）。类型用 type-only 引入 ——
   * 不会把 api.ts 的运行时依赖带进 bundle，也不会与之形成运行时循环。
   */
  async exportPreview(only?: SectionId[]): Promise<ExportPreviewResponse> {
    return postJson<ExportPreviewResponse>(CONFIG_MANAGER_API.exportPreview, { only }, this.t, SYNC_OPTS);
  }

  /** 推送：导出 portable 分区 → 提交到私有 Git 仓库 → 更新 sync-state */
  async push(payload: SyncPushPayload): Promise<SyncPushReport> {
    return postJson<SyncPushReport>(SYNC_API.push, payload, this.t, SYNC_OPTS);
  }

  /** P0-②：push 前只读预览（「将推送什么」，零写入远端）——body.preview=true 触发 */
  async pushPreview(payload: SyncPushPayload): Promise<SyncPushPreview> {
    return postJson<SyncPushPreview>(SYNC_API.push, { ...payload, preview: true }, this.t, SYNC_OPTS);
  }

  /** 拉取差异预览：拉取远端最新快照 → 只读分析（绝不执行导入） */
  async pull(payload: SyncPullPayload): Promise<SyncPullReport> {
    return postJson<SyncPullReport>(SYNC_API.pull, payload, this.t, SYNC_OPTS);
  }

  /**
   * 「拉取即导入」：把远端快照**落地成本机 ZIP**，返回它的路径。
   * 拿到路径后交给导入向导 —— 与从备份文件导入**同一条路径**（可解锁、可选内容、可回滚），
   * 而不是另造一套"直接写配置"的通道。
   * 与 pull 的区别：pull 只回差异预览（临时 ZIP 用完即删）；本方法真的留下一个文件。
   */
  async download(payload: SyncPullPayload & { name?: string }): Promise<{ ok: boolean; zipPath: string; snapshotId: string }> {
    return postJson<{ ok: boolean; zipPath: string; snapshotId: string }>(SYNC_API.download, payload, this.t, SYNC_OPTS);
  }

  /**
   * 删除**远端**的一份快照（产物库「远端快照 → 删除」，不可恢复）。
   *
   * 只动远端：本机配置与同步基线都不变（宿主 `SyncEngine.deleteSnapshot`）；
   * 远端不存在时同样返回成功（transport 契约：不存在视为成功）。
   */
  async deleteSnapshot(payload: SyncPushPayload & { snapshotId: string }): Promise<{ ok: boolean; snapshotId: string }> {
    return postJson<{ ok: boolean; snapshotId: string }>(SYNC_API.snapshotDelete, payload, this.t, SYNC_OPTS);
  }

  /** GitHub OAuth device flow：发起登录，返回一次性用户码 + 授权页 URL + flowId */
  async githubStart(): Promise<GithubDeviceFlowStartResponse> {
    return postJson<GithubDeviceFlowStartResponse>(SYNC_API.githubStart, {}, this.t, SYNC_OPTS);
  }

  /** GitHub OAuth device flow：凭 flowId 轮询授权结果（成功时 token 已由 Host 写入 credentials） */
  async githubPoll(flowId: string): Promise<GithubPollResponse> {
    return postJson<GithubPollResponse>(SYNC_API.githubPoll, { flowId }, this.t, SYNC_OPTS);
  }

  /** GitHub OAuth device flow：取消（丢弃宿主侧登记，零副作用） */
  async githubCancel(flowId: string): Promise<{ ok: boolean }> {
    return postJson<{ ok: boolean }>(SYNC_API.githubCancel, { flowId }, this.t, SYNC_OPTS);
  }

  /** GitHub token 有效性校验（判定「是否已登录」：token 存在且 GitHub API 接受；
   *  401 → valid:false 引导重新登录；非 401 错误向上抛，UI 兜底不误判登出） */
  async githubValidate(): Promise<GithubValidateResponse> {
    return postJson<GithubValidateResponse>(SYNC_API.githubValidate, {}, this.t, SYNC_OPTS);
  }

  /** 列出当前 GitHub 用户可见的仓库（供「选择已有仓库」下拉；只读，不改任何状态）。
   *  未登录 / token 失效 → 401，由调用方按「先登录」引导处理。 */
  async githubListRepositories(): Promise<GithubRepositoriesResponse> {
    return getJson<GithubRepositoriesResponse>(SYNC_API.githubRepositories, this.t, SYNC_OPTS);
  }

  /** 新建仓库并返回其信息（供「新建仓库」表单；**宿主强制私有**，
   *  描述为空则不传该字段）。名称非法 / 已存在 → 422，由调用方展示原因。 */
  async githubCreateRepository(name: string, description = ''): Promise<GithubCreateRepositoryResponse> {
    return postJson<GithubCreateRepositoryResponse>(
      SYNC_API.githubRepositories,
      repoCreateBody(name, description),
      this.t,
      SYNC_OPTS,
    );
  }

  /** 同步历史：列出本地祖先快照 + 自动同步执行记录（按 createdAt 倒序合并）。 */
  async history(): Promise<SyncHistoryResponse> {
    return getJson<SyncHistoryResponse>(SYNC_API.history, this.t, SYNC_OPTS);
  }

  /** 远端历史快照列表（供「选择历史快照」下拉）。 */
  async snapshotsList(payload: SyncPushPayload): Promise<SyncSnapshotsListResponse> {
    return postJson<SyncSnapshotsListResponse>(SYNC_API.snapshotsList, payload, this.t, SYNC_OPTS);
  }

  /** 一键同步第一步：拉取 → 差异确认会话（items 逐项确认，暂不导入）。 */
  async sync(payload: SyncStartPayload): Promise<SyncStartResponse> {
    return postJson<SyncStartResponse>(SYNC_API.sync, payload, this.t, SYNC_OPTS);
  }

  /** 一键同步第二步：按用户对差异项的逐项决策执行导入。 */
  async applyItems(payload: ApplyItemsPayload): Promise<ApplyItemsResponse> {
    return postJson<ApplyItemsResponse>(SYNC_API.applyItems, payload, this.t, SYNC_OPTS);
  }

  /** 取消/清理差异确认会话（丢弃临时 ZIP，零副作用）。 */
  async cancel(syncSessionId: string): Promise<{ ok: boolean }> {
    return postJson<{ ok: boolean }>(SYNC_API.cancel, { syncSessionId }, this.t, SYNC_OPTS);
  }

  /** 自动同步状态（GET /sync/autosync 返回全部通道的 { git, webdav }，各自独立）。 */
  async autosyncStatusAll(): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
    return getJson<Record<SyncTransportType, AutosyncStatusResponse>>(SYNC_API.autosync, this.t, SYNC_OPTS);
  }

  /** 自动同步状态（指定通道；从全部通道状态中取）。 */
  async autosyncStatus(transport: SyncTransportType = 'git'): Promise<AutosyncStatusResponse> {
    const all = await this.autosyncStatusAll();
    return all[transport];
  }

  /** 自动同步配置更新（POST /sync/autosync；payload.transport 指定目标通道）。 */
  async autosyncUpdate(payload: AutosyncUpdatePayload): Promise<AutosyncStatusResponse> {
    return postJson<AutosyncStatusResponse>(SYNC_API.autosync, payload, this.t, SYNC_OPTS);
  }

  /** 保存同步分区选择（POST /sync/selection）：模式 + 勾选分区持久化到 Host。
   *  自动同步调度器与手动 push 共用此配置（刷新/重启后仍然生效）。 */
  async saveSelection(payload: SyncSelectionPayload): Promise<SyncSelectionPayload> {
    return postJson<SyncSelectionPayload>(SYNC_API.selection, payload, this.t, SYNC_OPTS);
  }

  /** 保存同步通道配置（POST /sync/config）：url/username/password（git: repoUrl/token）持久化。
   *  password/token 经 Host 写入 DSH credentials（值永不回传）；返回凭据布尔供 UI 刷新徽章。 */
  async saveConfig(payload: SyncPushPayload): Promise<SyncConfigSaveResponse> {
    return postJson<SyncConfigSaveResponse>(SYNC_API.config, payload, this.t, SYNC_OPTS);
  }

  /** 断开同步通道配置（POST /sync/config 带 clear:true）：删除该通道的配置、凭据（token / 口令 /
   *  加密·解密密码）与自动同步开关。用户要求：配置过的通道必须能删掉，否则一条打不通的通道
   *  会永久占位，产物库远端源与自动同步只能一直报读取失败。**只解除本机绑定**，远端数据不动。 */
  async clearChannel(channel: SyncTransportType): Promise<SyncChannelClearResponse> {
    return postJson<SyncChannelClearResponse>(SYNC_API.config, { transport: channel, clear: true }, this.t, SYNC_OPTS)
  }

  /** 保存插件 UI 偏好（POST /sync/ui-prefs）：当前为上次选择的同步通道（ui-prefs.json，
   *  随 self 分区进导出备份）。纯偏好无 secret；失败由调用方静默降级（localStorage 兜底）。 */
  async saveUiPrefs(payload: { lastSyncChannel?: SyncTransportType }): Promise<{ ok: boolean; lastSyncChannel?: SyncTransportType }> {
    return postJson<{ ok: boolean; lastSyncChannel?: SyncTransportType }>(SYNC_API.uiPrefs, payload, this.t, SYNC_OPTS);
  }

  /** 一键回滚：按 restoreId 调用 backup→rollback（full=false 时 failed 列出未回滚项与人工提示） */
  async rollback(payload: { restoreId: string }): Promise<SyncRollbackResponse> {
    return postJson<SyncRollbackResponse>(SYNC_API.rollback, payload, this.t, SYNC_OPTS);
  }

  /**
   * T-ui-merge：远程合并**只读**预览（三方合并 + 冲突清单 + 摘要），零写入。
   *
   * 与 /sync/sync 的区别：这里不做导入计划、不登记同步会话，只回答「远端与本地差在哪、
   * 哪些分区需要我裁决」；密码只在请求体内传输（宿主绝不回传/落日志）。
   */
  async mergePreview(payload: MergePreviewPayload = {}): Promise<MergePreviewResponse> {
    return postJson<MergePreviewResponse>(SYNC_API.mergePreview, payload, this.t, SYNC_OPTS);
  }

  /**
   * T-ui-merge：按逐项裁决执行合并（写动作，宿主侧过 mutation gate）。
   *
   * 返回 pendingConflicts = 执行后**仍**待裁决的分区：界面据此告诉用户
   * 「跳过 ≠ 已解决，下次同步仍会出现」，而不是把一次带 skip 的执行报成「已解决」。
   */
  async applyMerge(payload: MergeApplyPayload): Promise<MergeApplyResponse> {
    return postJson<MergeApplyResponse>(SYNC_API.applyMerge, payload, this.t, SYNC_OPTS);
  }

  /** Phase 7 迁移前咨询（只读健康评分 + 建议）：对远端快照生成咨询报告。 */
  async consult(input: { type: 'remote-snapshot'; id: string; snapshotId?: string }): Promise<ConsultReport> {
    return postJson<ConsultReport>(CONFIG_MANAGER_API.consult, input, this.t, SYNC_OPTS);
  }
}
