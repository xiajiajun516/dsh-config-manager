/**
 * sessions 分区 adapter（默认关，设计 §3.3/§15）：
 * 数据源 = ~/.dsh/sessions/<projectKey>/<sessionId>/…（zstd jsonl，含敏感信息）。
 * defaultIncluded=false：Quick Export 不包含，用户显式勾选才导出（v1 文件级复制）。
 * 研究报告 §4.9：DSH 无会话批量导出 API，逐会话文件复制是唯一通道。
 *
 * issue #39 Feature 1：支持按数量筛选（`ExportOptions.sessions.limit`），挑选规则与排序在
 * core/session-select.ts（单位 = 会话目录、文件名判据不写死、按日志最新 mtime 倒序）。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { msgOf } from '../core/messages.ts';
import { groupSessionUnits, isSessionLogFileName, normalizeSessionLimit, pickLatestSessionUnits } from '../core/session-select.ts';
import type { ExportOptions, HostContext } from '../core/types.ts';
import { toPosixRel } from './units.ts';

/** 逐批并发 stat 的批大小：会话树可能有上千个日志文件，一次性开满 Promise 会打爆 libuv 线程池 */
const MTIME_BATCH = 16;

export class SessionsAdapter extends FileCollectionAdapter {
  readonly id = 'sessions' as const;
  readonly displayName = 'Sessions';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  readonly baseDir = 'sessions';

  /**
   * 单元 = `<projectKey>/<sessionId>`。
   *
   * 不能用基类默认的「首个路径段」——那会把**整个项目的所有会话**捆成一个单元，
   * 粒度粗到用户无法只挑几次会话；也不能取全部路径段，那会把一次会话的文件拆散
   * （jsonl / 附件 / 索引必须同进同出）。
   */
  protected override unitIdOf(relativePath: string): string {
    const parts = toPosixRel(relativePath).split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : toPosixRel(relativePath);
  }

  /**
   * 「最新 N 个会话」预筛选（issue #39 Feature 1）。
   *
   * 语义与 `ExportOptions.sessions.limit` 一致：缺省 / 负数 = 不筛选；0 = 一个都不带；
   * 正数 = 最新 N 个（按会话目录下最新一份会话日志的 mtime 倒序）。
   * 宿主门面不提供 `mtimeMs`（或整棵树的日志都读不到时间）时**退回全量 + 告警** ——
   * 绝不把「时间未知」当成「最旧」，那会静默丢掉最近的会话。
   */
  protected override async restrictUnits(
    ctx: HostContext,
    rels: readonly string[],
    options: ExportOptions,
  ): Promise<{ keep: Set<string> | null; warnings: string[] } | null> {
    const limit = normalizeSessionLimit(options.sessions?.limit);
    if (limit === undefined || limit < 0) return null;
    const msg = msgOf(ctx);
    // baseDir 相对路径 → homeDir 相对路径（FileSystemFacade 只认后者）
    const homeRelOf = new Map<string, string>();
    const relPaths: string[] = [];
    for (const rel of rels) {
      const relPath = toPosixRel(this.relPathOf(rel));
      homeRelOf.set(relPath, rel);
      relPaths.push(relPath);
    }
    const logRels = relPaths.filter((p) => isSessionLogFileName(p.split('/').pop() ?? ''));
    const mtimeMs = ctx.fs.mtimeMs;
    if (mtimeMs === undefined) {
      return { keep: null, warnings: [msg('export.sessionsLimitNoMtime')] };
    }
    const mtimes = new Map<string, number | null>();
    for (let i = 0; i < logRels.length; i += MTIME_BATCH) {
      const batch = logRels.slice(i, i + MTIME_BATCH);
      const read = await Promise.all(batch.map(async (rel): Promise<number | null> => {
        try {
          return await mtimeMs.call(ctx.fs, homeRelOf.get(rel) ?? rel);
        } catch {
          return null;
        }
      }));
      batch.forEach((rel, idx) => mtimes.set(rel, read[idx] ?? null));
    }
    const units = groupSessionUnits(relPaths, (rel) => mtimes.get(rel) ?? null);
    // 一个会话的日志时间都读不到 → 排序无意义，退回全量（宁可多带，不可静默少带）
    if (units.length > 0 && units.every((u) => u.latestMtimeMs === null)) {
      return { keep: null, warnings: [msg('export.sessionsLimitNoMtime')] };
    }
    const keep = pickLatestSessionUnits(units, limit);
    const warnings = limit === 0
      ? [msg('export.sessionsNone')]
      : [msg('export.sessionsLimited', { count: String(keep.size), total: String(units.length) })];
    return { keep, warnings };
  }
}
