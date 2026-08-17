/**
 * 远程同步浏览器半 —— `/api/dsh-config-manager/sync/*` 的类型化 fetch 封装。
 *
 * 独立于 `../api.ts`（ConfigManagerApi 为并行会话已改文件，禁碰）：本文件自持
 * 端点常量与 readJson/postJson 小工具（与 api.ts 同款模式），只新增不修改。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/sync/status → SyncStatusResponse （配置/凭据/上次同步）
 * POST /api/dsh-config-manager/sync/push    → SyncPushReport    （body: { repoUrl, gitBin?, token?, snapshotId? }）
 * POST /api/dsh-config-manager/sync/pull    → SyncPullReport    （body: { repoUrl, gitBin?, token?, strategy?, snapshotId? }）
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
  rollback: '/api/dsh-config-manager/sync/rollback',
} as const;

/** DSH credentials 中的同步 token 引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN';

/** GET /sync/status 响应：配置/凭据/上次同步的只读事实（无任何 secret 值） */
export interface SyncStatusResponse {
  ok: boolean;
  /** 是否已保存过仓库配置（sync-config.json） */
  configured: boolean;
  /** 上次使用的仓库地址（不含 token，可回显） */
  repoUrl?: string;
  gitBin?: string;
  /** DSH credentials 中是否已存在 token（describe 只报状态，值永不返回） */
  credentialConfigured: boolean;
  credentialWritable: boolean;
  /** sync-state.lastSyncAt；'' = 从未同步 */
  lastSyncAt?: string;
  /** sync-state.sections 条目数 */
  sectionCount: number;
  transport?: { type: string; ref: string };
  /** 自动同步当前状态（供 UI 顶部开关回填；§3.9） */
  autosync?: AutosyncStatusResponse;
}

/** push 请求体（token 可选：非空则 Host 先写入 DSH credentials 再使用） */
export interface SyncPushPayload {
  repoUrl: string;
  gitBin?: string;
  token?: string;
}

/** pull 请求体（strategy 缺省 merge：冲突保留待决策；snapshotId 缺省 = 最新） */
export interface SyncPullPayload extends SyncPushPayload {
  strategy?: 'merge' | 'replace' | 'skipExisting';
  snapshotId?: string;
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
export interface SyncStartPayload {
  repoUrl: string;
  gitBin?: string;
  token?: string;
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
  /** 冲突项解决方案（仅当该项是 Conflict 且 adopt=true 时必须） */
  resolution?: 'useRemote' | 'keepLocal' | 'skip';
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

/** POST /sync/autosync 请求体。 */
export interface AutosyncUpdatePayload {
  enabled: boolean;
  interval?: AutosyncInterval;
  startupMinIntervalMs?: number;
}

/* ---------------------------------------------------------------- 同步历史 */

/** 自动同步执行记录（§3.7 AutosyncHistoryEntry）。 */
export interface AutosyncHistoryEntry {
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

  /** 自动同步状态（GET /sync/autosync）。 */
  async autosyncStatus(): Promise<AutosyncStatusResponse> {
    const response = await fetch(SYNC_API.autosync);
    return readJson<AutosyncStatusResponse>(response, this.t);
  }

  /** 自动同步配置更新（POST /sync/autosync）。 */
  async autosyncUpdate(payload: AutosyncUpdatePayload): Promise<AutosyncStatusResponse> {
    return postJson<AutosyncStatusResponse>(SYNC_API.autosync, payload, this.t);
  }

  /** 一键回滚：按 restoreId 调用 backup→rollback */
  async rollback(payload: { restoreId: string }): Promise<{ ok: boolean; full: boolean }> {
    return postJson<{ ok: boolean; full: boolean }>(SYNC_API.rollback, payload, this.t);
  }
}
