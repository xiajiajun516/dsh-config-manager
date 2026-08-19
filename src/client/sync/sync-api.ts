/**
 * 远程同步浏览器半 —— `/api/dsh-config-manager/sync/*` 的类型化 fetch 封装。
 *
 * 独立于 `../api.ts`（ConfigManagerApi 为并行会话已改文件，禁碰）：本文件自持
 * 端点常量与 readJson/postJson 小工具（与 api.ts 同款模式），只新增不修改。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/sync/status → SyncStatusResponse （配置/凭据/上次同步）
 * POST /api/dsh-config-manager/sync/push    → SyncPushReport    （body: { repoUrl, token?, snapshotId? }）
 * POST /api/dsh-config-manager/sync/pull    → SyncPullReport    （body: { repoUrl, token?, strategy?, snapshotId? }）
 * POST /api/dsh-config-manager/sync/github/start   → GithubDeviceFlowStartResponse（GitHub OAuth 设备码）
 * POST /api/dsh-config-manager/sync/github/poll    → GithubPollResponse（凭 flowId 轮询；成功时 token 已由 Host 写入 credentials）
 * POST /api/dsh-config-manager/sync/github/cancel  → { ok: true }
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
import type { SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts';
import type { PlanItemKind } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/** 同步端点常量（与 Host 半 src/index.ts API 常量保持一致） */
export const SYNC_API = {
  base: '/api/dsh-config-manager/sync',
  status: '/api/dsh-config-manager/sync/status',
  push: '/api/dsh-config-manager/sync/push',
  pull: '/api/dsh-config-manager/sync/pull',
  githubStart: '/api/dsh-config-manager/sync/github/start',
  githubPoll: '/api/dsh-config-manager/sync/github/poll',
  githubCancel: '/api/dsh-config-manager/sync/github/cancel',
  history: '/api/dsh-config-manager/sync/history',
  snapshotsList: '/api/dsh-config-manager/sync/snapshots-list',
  sync: '/api/dsh-config-manager/sync/sync',
  applyItems: '/api/dsh-config-manager/sync/apply-items',
  cancel: '/api/dsh-config-manager/sync/cancel',
  autosync: '/api/dsh-config-manager/sync/autosync',
  selection: '/api/dsh-config-manager/sync/selection',
  config: '/api/dsh-config-manager/sync/config',
  uiPrefs: '/api/dsh-config-manager/sync/ui-prefs',
  rollback: '/api/dsh-config-manager/sync/rollback',
} as const;

/** DSH credentials 中的同步 token 引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN';

/** WebDAV 通道密码在 DSH credentials 中的引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD';

/** 远程同步通道类型：git（默认）或 webdav */
export type SyncTransportType = 'git' | 'webdav';

/** GET /sync/status 响应：配置/凭据/上次同步的只读事实（无任何 secret 值） */
export interface SyncStatusResponse {
  ok: boolean;
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
  /** sync-state.lastSyncAt；'' = 从未同步 */
  lastSyncAt?: string;
  /** sync-state.sections 条目数 */
  sectionCount: number;
  transport?: { type: string; ref: string };
  /** 上次选择的同步通道（磁盘 ui-prefs.json；UI 回填优先于此，localStorage 仅兜底） */
  lastSyncChannel?: 'git' | 'webdav';
  /** 可同步分区目录（「高级/自定义导出」勾选列表；host adapters 唯一事实源，只含 portable） */
  syncSections?: SyncSectionInfo[];
  /** 当前分区选择（当前激活通道；UI 回填用，自动同步与手动 push 共用） */
  syncSelection?: SyncSelectionPayload;
  /** 全部通道的分区选择（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  syncSelectionByChannel?: Record<SyncTransportType, SyncSelectionPayload>;
  /** 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9） */
  autosync?: AutosyncStatusResponse;
  /** 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  autosyncByChannel?: Record<SyncTransportType, AutosyncStatusResponse>;
}

/** 同步分区选择（POST /sync/selection 请求体 + status.syncSelection 响应；持久化于 Host）。
 *  git/webdav 通道各自独立（transport 缺省 git）。 */
export interface SyncSelectionPayload {
  /** 目标通道（git/webdav 各自独立的模式与勾选；缺省 git） */
  transport?: SyncTransportType;
  mode: 'default' | 'advanced';
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
  /** 手动推送默认加密快照（密码每次推送输入，不持久化） */
  encrypt?: boolean;
  /** 手动推送默认导出真实凭据值（必须同时 encrypt） */
  includeSecrets?: boolean;
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
  /** 仅同步指定分区（缺省 = 全部 portable 推荐分区；即「默认/快速导出」vs「高级/自定义导出」） */
  sections?: SectionId[];
  /** 加密快照（sections 载荷整体加密；开启时必须提供 encryptPassword） */
  encrypt?: boolean;
  /** 加密密码（仅本次请求体内存传输，Host 绝不落盘/落日志；encrypt=true 时必填） */
  encryptPassword?: string;
  /** 导出真实凭据值（必须同时 encrypt=true，否则 Host 拒绝：密钥绝不明文进同步通道） */
  includeSecrets?: boolean;
}

/** pull 请求体（strategy 缺省 merge：冲突保留待决策；snapshotId 缺省 = 最新；
 *  decryptPassword 可选：拉取加密快照时提供，仅内存传输）。 */
export interface SyncPullPayload extends SyncPushPayload {
  strategy?: 'merge' | 'replace' | 'skipExisting';
  snapshotId?: string;
  /** 解密密码（拉取/一键同步遇到加密快照时提供；仅内存传输，绝不落盘） */
  decryptPassword?: string;
}

/* ---------------------------------------------------------------- 一键同步（方案 A） */

/** GET /sync/snapshots-list 响应：远端历史快照列表（按 createdAt 倒序）。 */
export interface SyncSnapshotsListResponse {
  ok: boolean;
  /** 按 createdAt 倒序（最新在前） */
  snapshots: SyncSnapshotLite[];
  /** 当前本地祖先指针（sync-state.lastSnapshotId），用于高亮当前基线 */
  currentSnapshotId?: string;
}

/** 远端快照摘要（「选择历史快照」下拉项）。 */
export interface SyncSnapshotLite {
  id: string;
  createdAt: string;
  sectionCount: number;
  platform: string;
  dshVersion: string;
}

/** POST /sync/sync 请求体（一键同步第一步：拉取 → 差异确认会话）。 */
export interface SyncStartPayload extends SyncPushPayload {
  /** 缺省 = 最新快照；传入则对该历史快照拉取 */
  snapshotId?: string;
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
  result: unknown;
}

/* ---------------------------------------------------------------- 自动同步 */

/** 统一间隔类型。 */
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';

/** 最近一次自动同步执行状态。 */
export type AutosyncRunStatus = 'success' | 'skipped' | 'failed' | 'partial';

/** GET/POST /sync/autosync 响应：自动同步状态。 */
export interface AutosyncStatusResponse {
  enabled: boolean;
  interval: AutosyncInterval;
  lastRunAt?: string;
  lastRunStatus?: AutosyncRunStatus;
  lastRunMessage?: string;
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

/** 同步请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐（git 网络操作可能较慢） */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError（与 api.ts 同款） */
async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }));
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.status === 404
          ? notMountedMessage
          : `HTTP ${response.status}`;
    throw new ConfigManagerApiError(message);
  }
  return body as T;
}

/** POST JSON 请求（带超时：宿主卡死时 UI 拿到明确错误而不是永远转圈） */
async function postJson<T>(path: string, body: unknown, t: UiT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readJson<T>(response, t);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ConfigManagerApiError(
        t('error.syncTimeout', { minutes: String(Math.round(SYNC_TIMEOUT_MS / 60000)) }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 远程同步浏览器半数据入口（备份与迁移页第 4 个 tab 的注入业务面） */
export class SyncApi {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** 读取同步状态（配置 / 凭据 / 上次同步时间 / 分区数） */
  async status(): Promise<SyncStatusResponse> {
    const response = await fetch(SYNC_API.status);
    return readJson<SyncStatusResponse>(response, this.t);
  }

  /** 推送：导出 portable 分区 → 提交到私有 Git 仓库 → 更新 sync-state */
  async push(payload: SyncPushPayload): Promise<SyncPushReport> {
    return postJson<SyncPushReport>(SYNC_API.push, payload, this.t);
  }

  /** 拉取差异预览：拉取远端最新快照 → 只读分析（绝不执行导入） */
  async pull(payload: SyncPullPayload): Promise<SyncPullReport> {
    return postJson<SyncPullReport>(SYNC_API.pull, payload, this.t);
  }

  /** GitHub OAuth device flow：发起登录，返回一次性用户码 + 授权页 URL + flowId */
  async githubStart(): Promise<GithubDeviceFlowStartResponse> {
    return postJson<GithubDeviceFlowStartResponse>(SYNC_API.githubStart, {}, this.t);
  }

  /** GitHub OAuth device flow：凭 flowId 轮询授权结果（成功时 token 已由 Host 写入 credentials） */
  async githubPoll(flowId: string): Promise<GithubPollResponse> {
    return postJson<GithubPollResponse>(SYNC_API.githubPoll, { flowId }, this.t);
  }

  /** GitHub OAuth device flow：取消（丢弃宿主侧登记，零副作用） */
  async githubCancel(flowId: string): Promise<{ ok: boolean }> {
    return postJson<{ ok: boolean }>(SYNC_API.githubCancel, { flowId }, this.t);
  }

  /** 同步历史：列出本地祖先快照 + 自动同步执行记录（按 createdAt 倒序合并）。 */
  async history(): Promise<SyncHistoryResponse> {
    const response = await fetch(SYNC_API.history);
    return readJson<SyncHistoryResponse>(response, this.t);
  }

  /** 远端历史快照列表（供「选择历史快照」下拉）。 */
  async snapshotsList(payload: SyncPushPayload): Promise<SyncSnapshotsListResponse> {
    return postJson<SyncSnapshotsListResponse>(SYNC_API.snapshotsList, payload, this.t);
  }

  /** 一键同步第一步：拉取 → 差异确认会话（items 逐项确认，暂不导入）。 */
  async sync(payload: SyncStartPayload): Promise<SyncStartResponse> {
    return postJson<SyncStartResponse>(SYNC_API.sync, payload, this.t);
  }

  /** 一键同步第二步：按用户对差异项的逐项决策执行导入。 */
  async applyItems(payload: ApplyItemsPayload): Promise<ApplyItemsResponse> {
    return postJson<ApplyItemsResponse>(SYNC_API.applyItems, payload, this.t);
  }

  /** 取消/清理差异确认会话（丢弃临时 ZIP，零副作用）。 */
  async cancel(syncSessionId: string): Promise<{ ok: boolean }> {
    return postJson<{ ok: boolean }>(SYNC_API.cancel, { syncSessionId }, this.t);
  }

  /** 自动同步状态（GET /sync/autosync 返回全部通道的 { git, webdav }，各自独立）。 */
  async autosyncStatusAll(): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
    const response = await fetch(SYNC_API.autosync);
    return readJson<Record<SyncTransportType, AutosyncStatusResponse>>(response, this.t);
  }

  /** 自动同步状态（指定通道；从全部通道状态中取）。 */
  async autosyncStatus(transport: SyncTransportType = 'git'): Promise<AutosyncStatusResponse> {
    const all = await this.autosyncStatusAll();
    return all[transport];
  }

  /** 自动同步配置更新（POST /sync/autosync；payload.transport 指定目标通道）。 */
  async autosyncUpdate(payload: AutosyncUpdatePayload): Promise<AutosyncStatusResponse> {
    return postJson<AutosyncStatusResponse>(SYNC_API.autosync, payload, this.t);
  }

  /** 保存同步分区选择（POST /sync/selection）：模式 + 勾选分区持久化到 Host。
   *  自动同步调度器与手动 push 共用此配置（刷新/重启后仍然生效）。 */
  async saveSelection(payload: SyncSelectionPayload): Promise<SyncSelectionPayload> {
    return postJson<SyncSelectionPayload>(SYNC_API.selection, payload, this.t);
  }

  /** 保存同步通道配置（POST /sync/config）：url/username/password（git: repoUrl/token）持久化。
   *  password/token 经 Host 写入 DSH credentials（值永不回传）；返回凭据布尔供 UI 刷新徽章。 */
  async saveConfig(payload: SyncPushPayload): Promise<SyncConfigSaveResponse> {
    return postJson<SyncConfigSaveResponse>(SYNC_API.config, payload, this.t);
  }

  /** 保存插件 UI 偏好（POST /sync/ui-prefs）：当前为上次选择的同步通道（ui-prefs.json，
   *  随 self 分区进导出备份）。纯偏好无 secret；失败由调用方静默降级（localStorage 兜底）。 */
  async saveUiPrefs(payload: { lastSyncChannel?: 'git' | 'webdav' }): Promise<{ ok: boolean; lastSyncChannel?: 'git' | 'webdav' }> {
    return postJson<{ ok: boolean; lastSyncChannel?: 'git' | 'webdav' }>(SYNC_API.uiPrefs, payload, this.t);
  }

  /** 一键回滚：按 restoreId 调用 backup→rollback */
  async rollback(payload: { restoreId: string }): Promise<{ ok: boolean; full: boolean }> {
    return postJson<{ ok: boolean; full: boolean }>(SYNC_API.rollback, payload, this.t);
  }
}
