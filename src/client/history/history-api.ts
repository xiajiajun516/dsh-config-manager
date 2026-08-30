/**
 * Migration History 浏览器半 —— `/api/dsh-config-manager/history*` 的类型化 fetch 封装。
 *
 * 端点契约（Host 半 src/index.ts makeRoutes 按此实现）：
 * ```
 * GET /api/dsh-config-manager/history?kind=…&result=…&from=…&to=…&sections=…
 *     → { ok:true, entries: StoredMigrationHistoryEntry[], stats, corrupted }
 * GET /api/dsh-config-manager/history/export?format=markdown|json&…（同过滤）
 *     → markdown：下载附件；json：{ ok, generatedAt, text }
 * ```
 *
 * 安全约束：
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）；
 *  - 返回的 entries 已由 Host 侧脱敏（sanitizeEntry），UI 侧渲染前再过 redact() 兜底；
 *  - kind/result/sections 均为枚举常量，无 secret 承载面。
 */
import type { StoredMigrationHistoryEntry, MigrationKind, MigrationResult } from '../../core/migration-history.ts';
import type { MigrationHistoryStats } from '../../core/migration-history.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

export const HISTORY_API = {
  list: '/api/dsh-config-manager/history',
  export: '/api/dsh-config-manager/history/export',
} as const;

/** GET 请求超时（历史读取可能较大；导出走下载）。 */
const HISTORY_TIMEOUT_MS = 60_000;

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

/** 列表查询返回体。 */
export interface HistoryListResult {
  ok: boolean;
  entries: StoredMigrationHistoryEntry[];
  stats: MigrationHistoryStats;
  corrupted: string[];
}

/** 导出 JSON 返回体（markdown 走附件下载，不返回 JSON body）。 */
export interface HistoryExportJsonResult {
  ok: boolean;
  generatedAt: string;
  text: string;
}

export type HistoryExportFormat = 'json' | 'markdown';

/** History 浏览器半数据入口。 */
export class HistoryApi {
  readonly t: UiT;
  constructor(t: UiT = zhUiT) {
    this.t = t;
  }

  private buildListUrl(params: Record<string, string | undefined>): string {
    const url = new URL(HISTORY_API.list, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /** GET /history：按 kind/result/时间/分区 过滤读取历史。 */
  async list(params: {
    kind?: MigrationKind | MigrationKind[];
    result?: MigrationResult | MigrationResult[];
    from?: number;
    to?: number;
    sections?: string[];
  } = {}): Promise<HistoryListResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
    try {
      const query: Record<string, string | undefined> = {};
      if (params.kind !== undefined) query['kind'] = Array.isArray(params.kind) ? params.kind.join(',') : params.kind;
      if (params.result !== undefined) query['result'] = Array.isArray(params.result) ? params.result.join(',') : params.result;
      if (params.from !== undefined) query['from'] = String(params.from);
      if (params.to !== undefined) query['to'] = String(params.to);
      if (params.sections !== undefined && params.sections.length > 0) query['sections'] = params.sections.join(',');
      const response = await fetch(this.buildListUrl(query), { signal: controller.signal });
      return await readJson<HistoryListResult>(response, this.t);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 导出历史报告（markdown → 下载附件；json → { text }）。
   * 过滤参数与 list 相同。
   */
  async exportReport(format: HistoryExportFormat, params: {
    kind?: MigrationKind | MigrationKind[];
    result?: MigrationResult | MigrationResult[];
  } = {}): Promise<HistoryExportJsonResult | { downloaded: true }> {
    const query: Record<string, string | undefined> = { format };
    if (params.kind !== undefined) query['kind'] = Array.isArray(params.kind) ? params.kind.join(',') : params.kind;
    if (params.result !== undefined) query['result'] = Array.isArray(params.result) ? params.result.join(',') : params.result;
    const url = this.buildExportUrl(query);
    if (format === 'markdown') {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : `HTTP ${response.status}`;
        throw new ConfigManagerApiError(message);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'migration-history.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      return { downloaded: true };
    }
    const response = await fetch(url);
    return readJson<HistoryExportJsonResult>(response, this.t);
  }

  private buildExportUrl(params: Record<string, string | undefined>): string {
    const url = new URL(HISTORY_API.export, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    return url.toString();
  }
}
