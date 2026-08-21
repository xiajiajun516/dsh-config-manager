/**
 * 「我的配置」（一键上传 / 查看 / 更新）浏览器半 —— `/api/dsh-config-manager/me/*` 的类型化 fetch 封装。
 *
 * 仿 `../sync/sync-api.ts` 与 `market-api.ts` 同款模式：自持端点常量与 readJson/postJson
 * 小工具，独立于 `../api.ts` 与 `market-api.ts`，只新增不修改既有面。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按 docs/design/2026-08-20-my-configs-design.md §4.2 实现）：
 * ```
 * POST /api/dsh-config-manager/me/status  → MyMeStatusResponse   （登录态 + 目标仓库状态；401 → 未登录）
 * POST /api/dsh-config-manager/me/upload  → MyUploadResult       （{ zipPath, form } 一键上传全流程）
 * POST /api/dsh-config-manager/me/items   → MyItemsResponse      （读用户仓库 index.json）
 * POST /api/dsh-config-manager/me/update  → MyUploadResult       （{ zipPath, form } 一键更新）
 * ```
 * GitHub 登录（device flow）**复用现有** `/api/dsh-config-manager/sync/github/start|poll|cancel`
 * （见 ../sync/sync-api.ts 的 SyncApi.githubStart/githubPoll/githubCancel，同 token 槽）——
 * 本文件**不新写**登录路由；MyConfigsView 的登录卡直接用 SyncApi 的这三条。
 *
 * 安全约束（设计文档 §4.7 硬不变式，与全站一致）：
 *  - **token 永不回传浏览器**：/me/* 请求体只有 zipPath + 表单（name/description/categories），
 *    凭据全部经 Host 侧 credentials resolve；status 响应只回 login 用户名（非敏感）；
 *  - 错误消息由 Host 侧已脱敏（redact），UI 侧（MyConfigsView）渲染前再过 redact() 兜底；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import type {
  DeleteResult, ListingStatusResponse, MyItemEntry, MyRepoForm, UploadResult,
} from '../../market/my-repo.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

// 便捷重导出：Host 半 my-repo.ts 领域类型（client 消费单一来源，避免漂移）
export type { DeleteResult, ListingStatusResponse, MyItemEntry, MyRepoForm, UploadResult };

/* ---------------------------------------------------------------- 端点常量 */

/** 「我的配置」端点常量（与 Host 半 API 常量保持一致） */
export const MY_CONFIGS_API = {
  base: '/api/dsh-config-manager/me',
  status: '/api/dsh-config-manager/me/status',
  upload: '/api/dsh-config-manager/me/upload',
  items: '/api/dsh-config-manager/me/items',
  update: '/api/dsh-config-manager/me/update',
  listing: '/api/dsh-config-manager/me/listing',
  relist: '/api/dsh-config-manager/me/relist',
  delete: '/api/dsh-config-manager/me/delete',
} as const;

/** 「我的配置」请求超时（ms）：上传/更新含 git clone/push/fork/PR，与 market/sync 对齐量级 */
const MY_CONFIGS_TIMEOUT_MS = 5 * 60 * 1000;

/* ---------------------------------------------------------------- 响应/请求类型 */

/**
 * POST /me/status 响应：登录态 + 用户配置仓库状态（设计文档 §4.2）。
 * 仅非敏感展示位：login 用户名可回显；token 值永不回传浏览器。
 */
export interface MyMeStatusResponse {
  loggedIn: boolean
  /** GitHub 登录名（展示 @login 用） */
  login?: string
  /** 用户自己的配置仓库 URL（无则尚未创建） */
  repoUrl?: string
  /** 配置仓库是否已存在（false = 尚未创建过） */
  repoExists?: boolean
}

/**
 * 一键上传/更新请求体中的表单（设计文档 §2.4 用户输入最小化）：
 * 仅 name（必填，预填 zip 文件名可改）/ description（可选）/ categories（可选）；
 * id / author / version / updatedAt 全部系统自动生成，不在表单里。
 * categories 为数组（UI 层先经 parseCategories 解析逗号分隔文本）。
 * **与 Host 半 my-repo.ts 的 MyRepoForm 同构**（对齐导出，避免漂移）。
 */
export type MyConfigsFormPayload = MyRepoForm;

/**
 * POST /me/upload | /me/update 响应（**对齐 host 半 my-repo.ts 的 UploadResult**）。
 * ok=false 时 itemId/version/sha256 可为空串，warnings/error/errorCode 携带可展示信息（已脱敏）。
 */
export type MyUploadResult = UploadResult;

/** POST /me/items 响应：用户仓库的全部条目（空仓库 → 空数组）。
 *  条目 = Host 侧 MyItemEntry（含收录状态 status + prUrl + repoUrl，§4.5 在 Host 判定）。 */
export interface MyItemsResponse {
  items: MyItemEntry[]
}

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
  const timer = setTimeout(() => controller.abort(), MY_CONFIGS_TIMEOUT_MS);
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
        t('error.syncTimeout', { minutes: String(Math.round(MY_CONFIGS_TIMEOUT_MS / 60000)) }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- MyConfigsApi */

/**
 * 「我的配置」浏览器半数据入口（MarketPanel 的「我的配置」子视图注入业务面）。
 * 登录（GitHub device flow）不在此类 —— 复用 SyncApi.githubStart/githubPoll/githubCancel。
 */
export class MyConfigsApi {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** 读取登录态 + 用户配置仓库状态（token 失效 → Host 返回 401/未登录，UI 引导重新登录） */
  async meStatus(): Promise<MyMeStatusResponse> {
    return postJson<MyMeStatusResponse>(MY_CONFIGS_API.status, {}, this.t);
  }

  /** 一键上传：校验 → 建/复用仓库 → 写入用户仓库 → fork → 改官方 index → 提收录 PR */
  async meUpload(payload: { zipPath: string; form: MyConfigsFormPayload }): Promise<MyUploadResult> {
    return postJson<MyUploadResult>(MY_CONFIGS_API.upload, payload, this.t);
  }

  /** 读取已上传条目列表（用户仓库 index.json；每条目含 Host 侧判定的收录状态） */
  async meItems(): Promise<MyItemsResponse> {
    return postJson<MyItemsResponse>(MY_CONFIGS_API.items, {}, this.t);
  }

  /** 一键更新：version 自动 +1，复用/重开收录 PR */
  async meUpdate(payload: { zipPath: string; form: MyConfigsFormPayload }): Promise<MyUploadResult> {
    return postJson<MyUploadResult>(MY_CONFIGS_API.update, payload, this.t);
  }

  /** 查询收录/下架任务状态（结果卡轮询；任务表未命中时 Host 回退 GitHub 实况推导；无任务无实况 → null） */
  async meListing(itemId: string): Promise<ListingStatusResponse | null> {
    return postJson<ListingStatusResponse | null>(MY_CONFIGS_API.listing, { itemId }, this.t);
  }

  /** 重新提交收录（失败/重启丢失后重试；幂等复用已存在 fork/open PR） */
  async meRelist(itemId: string): Promise<ListingStatusResponse> {
    return postJson<ListingStatusResponse>(MY_CONFIGS_API.relist, { itemId }, this.t);
  }

  /** 删除条目（同步删本地索引+文件；已收录自动后台提下架 PR；待审核自动关闭收录 PR） */
  async meDelete(itemId: string): Promise<DeleteResult> {
    return postJson<DeleteResult>(MY_CONFIGS_API.delete, { itemId }, this.t);
  }
}