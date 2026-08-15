/**
 * Config Manager 浏览器半 —— `/api/dsh-config-manager/*` 的类型化 fetch 封装。
 *
 * 设计对齐 dsh-ssh 的 `src/client/api.ts` 范式（同源 fetch、readJson、query helper），
 * 但方法签名直接实现 `src/ui/types.ts` 的 `ExportPort` / `ImportPort` 端口契约：
 * 客户端控制器（ExportFlow / ImportWizard）把本类实例当作 port 注入即可，
 * 无需任何额外适配层 —— 这是「直接绑定 src/ui，不重复实现」的关键。
 *
 * 端点契约（Host 半 `src/index.ts` 按此实现，见 CLIENT_DEPENDENCIES.md 的接口说明）：
 * ```
 * GET  /api/dsh-config-manager/status             → ServiceStatus        （健康/版本检查）
 * POST /api/dsh-config-manager/export             → ExportResponse       （body: ExportOptions）
 * GET  /api/dsh-config-manager/download?path=…    → 文件流（content-disposition 文件名）
 * POST /api/dsh-config-manager/upload?name=…      → UploadResponse       （body: 原始字节）
 * POST /api/dsh-config-manager/analyze            → ImportAnalysis       （body: { zipPath }）
 * POST /api/dsh-config-manager/plan               → ImportPlan           （body: { zipPath, decisions }）
 * POST /api/dsh-config-manager/execute            → ImportResult         （body: { zipPath, plan, opts }）
 * ```
 * 安全约束：
 *  - 所有响应/错误文本在进入 UI 前经 `redact()`（见 common/ErrorBanner.tsx）；
 *  - secretInputs 只存在于请求体内，绝不落日志；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */

import type { ImportAnalysis, ImportDecisions, ImportPlan, ImportResult } from '../core/types.ts';
import type { ExportOptions, ExportReport } from '../core/types.ts';
import type { Manifest } from '../schema/types.ts';

/** Host 半健康检查响应（plugin 版本 / DSH 版本 / 平台，用于主页横幅与兼容性说明） */
export interface ServiceStatus {
  ready: boolean;
  pluginVersion: string;
  dshVersion: string;
  platform: string;
  arch: string;
}

/** export 端点响应（对齐 ExportFlow 的 ExportRunResult 前半部分） */
export interface ExportResponse {
  zipPath: string;
  manifest: Manifest;
  report: ExportReport;
}

/** upload 端点响应：Host 把用户上传的 ZIP 存入受控临时目录，返回可被 analyze/plan/execute 引用的路径 */
export interface UploadResponse {
  zipPath: string;
  name: string;
  sizeBytes: number;
}

/** execute 端点请求体（对齐 ImportWizard.execute 的 opts） */
export interface ExecutePayload {
  zipPath: string;
  plan: ImportPlan;
  opts: {
    /** 安全阀：非 true 拒绝执行（core ImportNotConfirmedError） */
    confirm: boolean;
    /** 秘密补录值（仅内存，经 HTTPS 传输，Host 端不落盘） */
    secretInputs: Record<string, string>;
    /** true=任一项失败整体回滚（场景 E）；false=单项失败继续 */
    rollbackOnError: boolean;
  };
}

/** 路由族常量（集中管理，与 Host 半的路由前缀保持一致） */
export const CONFIG_MANAGER_API = {
  base: '/api/dsh-config-manager',
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  download: '/api/dsh-config-manager/download',
  upload: '/api/dsh-config-manager/upload',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  execute: '/api/dsh-config-manager/execute',
} as const;

/** 导出请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐，防止宿主卡死时 UI 无限等待 */
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;

/** 携带路由 JSON error 消息的错误类型 */
export class ConfigManagerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigManagerApiError';
  }
}

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError */
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

/** query-string 辅助（跳过 undefined/空串，与 dsh-ssh 一致） */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : '?' + text;
}

/** 浏览器 File System Access API 的最小表面（非全部 lib.dom 版本都有） */
interface WindowWithFileSystemAccess {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

/** 导出下载结果（流式落盘或内存 Blob 兜底） */
export interface DownloadResult {
  blob?: Blob;
  filename: string;
  streamed: boolean;
  bytes: number;
}

/**
 * Config Manager 浏览器半的唯一数据入口。
 * 同时实现 `ExportPort`（export-flow 用）与 `ImportPort`（import-wizard 用）。
 */
export class ConfigManagerApi {
  /**
   * 加密备份密码（仅内存，默认 null = 普通备份）。
   * ExportView 在 run 前设置；export 请求体携带给 Host 半做 AES-256-GCM 加密。
   * 绝不写入 manifest / 任何 DSH 配置 / localStorage。
   */
  exportPassword: string | null = null

  // ------------------------------------------------------------- status
  /** 健康/版本检查（主页横幅：插件版本 / DSH 版本 / 平台） */
  async status(): Promise<ServiceStatus> {
    const response = await fetch(CONFIG_MANAGER_API.status);
    return readJson<ServiceStatus>(response);
  }

  // ------------------------------------------------------------- export
  /** ExportPort.export：调用 Host 侧导出编排（core Exporter）。加密密码随请求体传输（仅内存）。
   * 带 AbortController 超时：宿主若卡死，客户端得到明确错误而不是永远停在进度条。 */
  async export(options: ExportOptions): Promise<ExportResponse> {
    const body: ExportOptions & { password?: string } = {
      ...options,
      password: this.exportPassword ?? undefined,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG_MANAGER_API.export, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await readJson<ExportResponse>(response);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ConfigManagerApiError(`导出超时（${Math.round(EXPORT_TIMEOUT_MS / 60000)} 分钟）：导出过程未完成，请重试；若反复超时请检查 DSH 状态`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 把导出的 ZIP 下载到本机。优先 File System Access API 流式落盘
   * （不占整文件内存），不可用时回退内存 Blob（dsh-ssh downloadFile 同款策略）。
   */
  async download(
    zipPath: string,
    onProgress?: (received: number, total: number) => void,
  ): Promise<DownloadResult> {
    const response = await fetch(CONFIG_MANAGER_API.download + query({ path: zipPath }));
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '');
      throw new ConfigManagerApiError(text !== '' ? text : `download failed: HTTP ${response.status}`);
    }
    const total = Number(response.headers.get('content-length') ?? '0');
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? zipPath.split(/[\\/]/).pop() ?? 'dsh-config.zip';
    const reader = response.body.getReader();
    const picker =
      typeof window !== 'undefined'
        ? (window as WindowWithFileSystemAccess).showSaveFilePicker
        : undefined;
    let streamed = false;
    let writable: { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> } | undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      if (picker !== undefined) {
        const handle = await picker.call(window, { suggestedName: filename });
        writable = await handle.createWritable();
        streamed = true;
      }
    } catch {
      // 用户取消保存对话框或 API 不可用：回退内存 Blob。
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writable !== undefined) {
        await writable.write(value as Uint8Array);
      } else {
        chunks.push(value as Uint8Array<ArrayBuffer>);
      }
      received += value.length;
      onProgress?.(received, total);
    }
    if (writable !== undefined) await writable.close();
    return {
      blob: streamed ? undefined : new Blob(chunks),
      filename,
      streamed,
      bytes: received,
    };
  }

  // ------------------------------------------------------------- import
  /** 上传用户选择的 ZIP 到 Host 受控临时目录，返回可引用的 zipPath（dsh-ssh 同款原始字节上传） */
  async upload(file: File): Promise<UploadResponse> {
    const response = await fetch(CONFIG_MANAGER_API.upload + query({ name: file.name }), {
      method: 'POST',
      body: file,
    });
    return readJson<UploadResponse>(response);
  }

  /** ImportPort.analyzeImport：零写入分析（校验/兼容性/差异/路径/秘密检测） */
  async analyzeImport(zipPath: string): Promise<ImportAnalysis> {
    const response = await fetch(CONFIG_MANAGER_API.analyze, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zipPath }),
    });
    return readJson<ImportAnalysis>(response);
  }

  /** ImportPort.createImportPlan：用用户决策（冲突/路径映射/策略）生成最终计划（Dry Run 零写入） */
  async createImportPlan(zipPath: string, decisions: ImportDecisions): Promise<ImportPlan> {
    const response = await fetch(CONFIG_MANAGER_API.plan, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zipPath, decisions }),
    });
    return readJson<ImportPlan>(response);
  }

  /** ImportPort.executeImportPlan：快照→分阶段 apply→validate→commit/rollback */
  async executeImportPlan(
    zipPath: string,
    plan: ImportPlan,
    opts: { confirm: boolean; secretInputs?: Record<string, string>; rollbackOnError: boolean },
  ): Promise<ImportResult> {
    const payload: ExecutePayload = {
      zipPath,
      plan,
      opts: {
        confirm: opts.confirm,
        secretInputs: opts.secretInputs ?? {},
        rollbackOnError: opts.rollbackOnError,
      },
    };
    const response = await fetch(CONFIG_MANAGER_API.execute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return readJson<ImportResult>(response);
  }
}
