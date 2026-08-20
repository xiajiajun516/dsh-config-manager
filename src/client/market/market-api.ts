/**
 * 配置市场（Config Marketplace）浏览器半 —— `/api/dsh-config-manager/market/*` 的类型化 fetch 封装。
 *
 * 仿 `../sync/sync-api.ts` 同款模式：自持端点常量与 readJson/postJson 小工具，
 * 独立于 `../api.ts`，只新增不修改既有面。
 *
 * 响应类型**只引用** Host 半 `src/market/types.ts` 的类型（type-only），不重复定义 ——
 * 保证 client 与 Host 请求/响应契约单一来源，避免漂移（与 sync-api.ts 引用 sync-engine.ts 同构）。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按 docs/design/marketplace.md §4.2 实现；
 * 内置单市场、只读不可编辑，无 add/remove）：
 * ```
 * GET  /api/dsh-config-manager/market/status    → MarketStatusResponse
 * POST /api/dsh-config-manager/market/refresh   → MarketRefreshResponse （拉取最新 index.json）
 * POST /api/dsh-config-manager/market/browse    → MarketBrowseResponse  （合并 index + 缓存状态）
 * POST /api/dsh-config-manager/market/download  → MarketDownloadResult  （{ itemId } 拉取+校验+dry-run 预览）
 * POST /api/dsh-config-manager/market/prepare   → MarketPrepareResponse （发布向导：上传 zip + 元数据 → 条目包）
 * ```
 * 确认导入（apply）**复用现有** `POST /api/dsh-config-manager/execute`（见 ../api.ts executeImportPlan），
 * 不新增第二条导入路径 —— 保证安全校验/回滚/凭据补录全部走既有管道。
 *
 * 安全约束（设计文档 §1 / §2.2 硬不变式）：
 *  - **无 secret 硬不变式**：market 端点不接收/不回传任何 token；repoUrl 拒绝 userinfo（Host 侧校验）。
 *    本文件没有任何秘密字段，也无 password/token 输入；请求体只有 url / itemId。
 *  - **下载即不可信输入**：download 响应带 status 'valid' | 'invalid' 与供应链警示 warnings 恒展示；
 *    确认导入前 UI 恒展示来源 URL + 非官方审核警示（needsReview 恒 true）。
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import type {
  MarketBrowseResponse, MarketDownloadResult, MarketItemDetail, MarketListItem,
  MarketPreparePayload, MarketPrepareResponse, MarketRefreshResponse, MarketStatusResponse,
} from '../../market/types.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/* ---------------------------------------------------------------- 端点常量 */

/** 市场端点常量（与 Host 半 API 常量保持一致；内置单市场，无 add/remove） */
export const MARKET_API = {
  base: '/api/dsh-config-manager/market',
  status: '/api/dsh-config-manager/market/status',
  refresh: '/api/dsh-config-manager/market/refresh',
  browse: '/api/dsh-config-manager/market/browse',
  download: '/api/dsh-config-manager/market/download',
  prepare: '/api/dsh-config-manager/market/prepare',
  /** 受控临时区文件下载端点（发布包 zip 下载复用；GET ?path=，无凭据） */
  fileDownload: '/api/dsh-config-manager/download',
} as const;

/** 市场请求超时（ms）：git 拉取可能较慢，与 Host 半 ROUTE_TIMEOUT_MS 对齐量级 */
const MARKET_TIMEOUT_MS = 5 * 60 * 1000;

/* 便捷重导出：宿主/客户端共享的市场响应契约（供 UI 组件的纯渲染模型引用，避免散落） */
export type { MarketItemDetail, MarketListItem };

/* ---------------------------------------------------------------- fetch 工具 */

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
  const timer = setTimeout(() => controller.abort(), MARKET_TIMEOUT_MS);
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
        t('error.syncTimeout', { minutes: String(Math.round(MARKET_TIMEOUT_MS / 60000)) }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- MarketApi */

/** 配置市场浏览器半数据入口（备份与迁移页第 5 个 tab 的注入业务面） */
export class MarketApi {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** 读取内置市场摘要（条目数 / 最近拉取时间；无任何凭据） */
  async status(): Promise<MarketStatusResponse> {
    const response = await fetch(MARKET_API.status);
    return readJson<MarketStatusResponse>(response, this.t);
  }

  /** 拉取市场最新 index.json（内置单市场；返回目录条目 + 市场缓存摘要） */
  async refresh(): Promise<MarketRefreshResponse> {
    return postJson<MarketRefreshResponse>(MARKET_API.refresh, {}, this.t);
  }

  /** 浏览内置市场（合并 index + 本地缓存状态 → 条目列表带 cacheState） */
  async browse(): Promise<MarketBrowseResponse> {
    return postJson<MarketBrowseResponse>(MARKET_API.browse, {}, this.t);
  }

  /** 下载 + 校验单条目（dry-run 预览：拉取 → §6 校验 → analyzeImport → createImportPlan）。
   *  repo 可选：条目来源仓库（作者自托管）。自托管条目（官方 index 带 repo 引用、或「我的配置」
   *  未收录条目）内容文件在作者自己的公开仓库，必须显式传 repo 才能从正确来源拉取；
   *  缺省 = 市场仓库（官方同仓条目）。
   *  真正落盘由用户对预览确认后走现有 executeImportPlan（confirm:true 安全阀 + 回滚）。 */
  async download(itemId: string, repo?: string): Promise<MarketDownloadResult> {
    return postJson<MarketDownloadResult>(MARKET_API.download, { itemId, ...(repo !== undefined && repo !== '' ? { repo } : {}) }, this.t);
  }

  /** 发布向导：由「上传 zip + 用户填写元数据」生成市场条目包（L2 manifest + SHA-256 + sections），
   *  供 UI 展示/复制与引导推送。零写入配置（发布目录在受控临时区）；不含任何凭据字段。 */
  async prepare(payload: MarketPreparePayload): Promise<MarketPrepareResponse> {
    return postJson<MarketPrepareResponse>(MARKET_API.prepare, payload, this.t);
  }

  /** 发布包下载 URL（受控临时区 zip；经宿主 /download 端点，无凭据、无写操作） */
  downloadPublishUrl(zipPath: string): string {
    return `${MARKET_API.fileDownload}?path=${encodeURIComponent(zipPath)}`;
  }
}
