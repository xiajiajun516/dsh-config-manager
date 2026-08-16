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
}
