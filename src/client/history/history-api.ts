/**
 * Migration History 浏览器半 —— `/api/dsh-config-manager/history*` 的类型化 fetch 封装。
 *
 * 端点契约（Host 半 src/index.ts makeRoutes 按此实现）：
 * ```
 * GET /api/dsh-config-manager/history?kind=…&result=…&from=…&to=…&sections=…&limit=N
 *     → { ok:true, entries: StoredMigrationHistoryEntry[], stats, corrupted, total, scanned, limit }
 *     limit = 只读最近 N 条（尾部窗口；缺省全量）。total = 目录内合法文件总数。
 * GET /api/dsh-config-manager/history/export?format=markdown|json&…（同过滤）
 *     → markdown：下载附件；json：{ ok, generatedAt, text }
 * GET  /api/dsh-config-manager/history/retention
 *     → { ok, maxEntries, total, defaultMaxEntries, allowedMin, allowedMax }
 * POST /api/dsh-config-manager/history/retention { maxEntries }
 *     → { ok, maxEntries, removed, total }（改策略并立即清理一次；0 = 不限制）
 * ```
 *
 * 安全约束：
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）；
 *  - 返回的 entries 已由 Host 侧脱敏（sanitizeEntry），UI 侧渲染前再过 redact() 兜底；
 *  - kind/result/sections 均为枚举常量，无 secret 承载面。
 */
import type { StoredMigrationHistoryEntry, MigrationKind, MigrationResult } from '../../core/migration-history.ts';
import type { MigrationHistoryStats } from '../../core/migration-history.ts';
import { getJson, openStream, postJson, readJson, type RequestOptions } from '../common/http.ts';
import type { UiT } from '../../ui/i18n.ts';
import { HISTORY_API } from '../common/routes.ts';

/** 迁移历史端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持导入面。 */
export { HISTORY_API };

/** 历史请求选项（60 秒：列表读取可能较大；导出走流式下载）。 */
const HISTORY_OPTS: RequestOptions = { timeoutMs: 60_000 };

/* 请求封装（readJson / getJson / openStream：统一超时 + 取消 + 错误映射）见 common/http.ts。 */

/** 列表查询返回体。 */
export interface HistoryListResult {
  ok: boolean;
  entries: StoredMigrationHistoryEntry[];
  stats: MigrationHistoryStats;
  corrupted: string[];
  /** 目录内合法历史文件总数（含被 limit 窗口挡在外的旧条目；老宿主可能不返回）。 */
  total?: number;
  /** 本次实际读取条数（= 窗口大小；用于「仅显示最近 N 条」提示）。 */
  scanned?: number;
  /** 本次生效的 limit（0 = 全量）。 */
  limit?: number;
}

/** 自动清理策略现状（GET /history/retention）。 */
export interface HistoryRetentionState {
  ok: boolean;
  /** 当前保留上限；0 = 不限制。 */
  maxEntries: number;
  /** 目录内当前条数。 */
  total: number;
  /** 缺省上限（UI「恢复默认」用）。 */
  defaultMaxEntries: number;
  allowedMin: number;
  allowedMax: number;
}

/** 保存策略后的结果（POST /history/retention）。 */
export interface HistoryRetentionResult {
  ok: boolean;
  maxEntries: number;
  /** 本次立即清理删除的条数。 */
  removed: number;
  total: number;
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
  constructor(t: UiT) {
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
    /** 只读最近 N 条（缺省/0 = 全量；首页只取几十条避免全量读+回传）。 */
    limit?: number;
  } = {}): Promise<HistoryListResult> {
    const query: Record<string, string | undefined> = {};
    if (params.kind !== undefined) query['kind'] = Array.isArray(params.kind) ? params.kind.join(',') : params.kind;
    if (params.result !== undefined) query['result'] = Array.isArray(params.result) ? params.result.join(',') : params.result;
    if (params.from !== undefined) query['from'] = String(params.from);
    if (params.to !== undefined) query['to'] = String(params.to);
    if (params.sections !== undefined && params.sections.length > 0) query['sections'] = params.sections.join(',');
    if (params.limit !== undefined && params.limit > 0) query['limit'] = String(params.limit);
    return getJson<HistoryListResult>(this.buildListUrl(query), this.t, HISTORY_OPTS);
  }

  /** GET /history/retention：当前自动清理策略 + 目录现状。 */
  async getRetention(): Promise<HistoryRetentionState> {
    return getJson<HistoryRetentionState>(HISTORY_API.retention, this.t, HISTORY_OPTS);
  }

  /** POST /history/retention：改保留上限并立即清理一次（0 = 不限制）。 */
  async setRetention(maxEntries: number): Promise<HistoryRetentionResult> {
    return postJson<HistoryRetentionResult>(HISTORY_API.retention, { maxEntries }, this.t, HISTORY_OPTS);
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
      // 附件下载：走流式句柄（headers 超时 + 正文空闲超时），非 2xx 交给统一错误映射。
      const stream = await openStream(url, this.t, HISTORY_OPTS);
      try {
        const response = stream.response;
        if (!response.ok) await readJson<never>(response, this.t);
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
      } catch (err) {
        throw stream.mapTimeout(err);
      } finally {
        stream.close();
      }
    }
    return getJson<HistoryExportJsonResult>(url, this.t, HISTORY_OPTS);
  }

  private buildExportUrl(params: Record<string, string | undefined>): string {
    const url = new URL(HISTORY_API.export, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    return url.toString();
  }
}
