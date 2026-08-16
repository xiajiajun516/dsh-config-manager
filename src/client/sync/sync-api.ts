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
 * ```
 *
 * 安全约束：
 *  - token 只存在于请求体内（同源 loopback，与导入 secretInputs 同策略），由 Host 写入
 *    DSH credentials（credentialRef），绝不落同步文件/日志/URL；响应永不回传 token；
 *  - 错误消息由 Host 侧已脱敏（GitTransport 统一 [REDACTED]），UI 侧再经 ErrorBanner redact 兜底；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle；sync-engine 仅作 type-only 引用）。
 */
import type { SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts';
import { ConfigManagerApiError } from '../api.ts';

/** 同步端点常量（与 Host 半 src/index.ts API 常量保持一致） */
export const SYNC_API = {
  base: '/api/dsh-config-manager/sync',
  status: '/api/dsh-config-manager/sync/status',
  push: '/api/dsh-config-manager/sync/push',
  pull: '/api/dsh-config-manager/sync/pull',
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

/** 同步请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐（git 网络操作可能较慢） */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError（与 api.ts 同款） */
async function readJson<T>(response: Response): Promise<T> {
  const notMountedMessage =
    'config-manager 服务未挂载（插件未加载）：请确认 profile 中已安装 dsh-config-manager 并重启 DSH';
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(`HTTP ${response.status}: invalid JSON response`);
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
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readJson<T>(response);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ConfigManagerApiError(
        `同步请求超时（${Math.round(SYNC_TIMEOUT_MS / 60000)} 分钟）：请检查网络与仓库可达性后重试`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 远程同步浏览器半数据入口（备份与迁移页第 4 个 tab 的注入业务面） */
export class SyncApi {
  /** 读取同步状态（配置 / 凭据 / 上次同步时间 / 分区数） */
  async status(): Promise<SyncStatusResponse> {
    const response = await fetch(SYNC_API.status);
    return readJson<SyncStatusResponse>(response);
  }

  /** 推送：导出 portable 分区 → 提交到私有 Git 仓库 → 更新 sync-state */
  async push(payload: SyncPushPayload): Promise<SyncPushReport> {
    return postJson<SyncPushReport>(SYNC_API.push, payload);
  }

  /** 拉取差异预览：拉取远端最新快照 → 只读分析（绝不执行导入） */
  async pull(payload: SyncPullPayload): Promise<SyncPullReport> {
    return postJson<SyncPullReport>(SYNC_API.pull, payload);
  }
}
