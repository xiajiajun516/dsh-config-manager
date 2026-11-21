/**
 * 会话逐条比对（P3）—— **纯函数，零 I/O**。
 *
 * 为什么需要它：导入是把包内会话**覆盖**到本机（备份恢复口径，不是增量追加 —— 见 K1：
 * 双机日常同步走远程同步通道）。于是「本机这条对话在导出之后又聊了 40 轮」这件事，
 * 用户在导入前必须看得见：导入会以包为准，那 40 轮会被覆盖掉。此前插件只能告诉用户
 * 「这个文件 Conflict」（文件级 SHA 不同），无法说清**差在哪、会丢多少**。
 *
 * 判据只有「事件序列前缀」这一条（不猜时间、不猜 tokens）：
 *  - identical：逐条一致（只差 bookkeeping 事件也算一致）；
 *  - packAhead：本机是包的前缀 → 包里多出 N 条（导入后多 N 条）；
 *  - localAhead：包是本机的前缀 → 本机多出 N 条（**导入会覆盖掉这 N 条**）；
 *  - diverged：前缀之后两边都有内容 → 分叉（导入按包为准）。
 *
 * 反序列化口径：事件行按 JSON 规范化后比对（键排序 + `cwd` 归一为 `<cwd>`）。为什么必须
 * 归一 cwd：包内首帧 cwd 是**导出机**的路径，导入时会按映射改写（只改首帧，C1），
 * 不归一会让任何跨机恢复都被判成 diverged —— 那是误报，不是差异。
 */
import type { SessionCompareRow, SessionVerdict } from './types.ts';

/** bookkeeping 事件：不含对话内容，只记录日志自身形态（发种子结束、日志维护）。 */
const BOOKKEEPING_TYPES = new Set(['session/end-seed']);
const BOOKKEEPING_PREFIX = 'session-log-';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = key === 'cwd' ? '<cwd>' : canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** 一行事件 → 比对用的规范形态；空行返回空串（调用方过滤）。 */
export function canonicalEventLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 解析不了就按原文比对：宁可判 diverged（保守），也不假装一致
    return trimmed;
  }
  return JSON.stringify(canonicalize(parsed));
}

/** 文本（解码后的日志）→ 规范事件行。空行与非对象行照样保留原文，绝不静默丢条。 */
export function canonicalEventLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const canonical = canonicalEventLine(line);
    if (canonical !== '') out.push(canonical);
  }
  return out;
}

function isBookkeepingLine(canonical: string): boolean {
  let type: unknown;
  try {
    type = (JSON.parse(canonical) as { type?: unknown }).type;
  } catch {
    return false;
  }
  if (typeof type !== 'string') return false;
  return BOOKKEEPING_TYPES.has(type) || type.startsWith(BOOKKEEPING_PREFIX);
}

/** 两条事件序列的比对结论（不含 unit 信息；聚合见 {@link aggregateSessionRows}）。 */
export interface EventStreamDiff {
  verdict: 'identical' | 'packAhead' | 'localAhead' | 'diverged';
  /** 包内事件条数 */
  packEvents: number;
  /** 本机事件条数 */
  localEvents: number;
  /** 包比本机多出的事件条数（prefix 之后） */
  packAheadBy: number;
  /** 本机比包多出的事件条数（prefix 之后）—— diverged 时 = 会被覆盖掉的条数 */
  localAheadBy: number;
  /** 首个不一致位置（0 起）；无差异时缺省 */
  divergedAt?: number;
}

export function compareEventStreams(pack: readonly string[], local: readonly string[]): EventStreamDiff {
  let i = 0;
  while (i < pack.length && i < local.length && pack[i] === local[i]) i += 1;
  const packRest = pack.slice(i);
  const localRest = local.slice(i);
  const base = { packEvents: pack.length, localEvents: local.length };
  if (packRest.length === 0 && localRest.length === 0) {
    return { verdict: 'identical', ...base, packAheadBy: 0, localAheadBy: 0 };
  }
  if (packRest.length === 0) {
    // 本机多出来的全是 bookkeeping → 内容其实一致，别用噪声报「本机更新」
    if (localRest.every(isBookkeepingLine)) {
      return { verdict: 'identical', ...base, packAheadBy: 0, localAheadBy: 0 };
    }
    return { verdict: 'localAhead', ...base, packAheadBy: 0, localAheadBy: localRest.length };
  }
  if (localRest.length === 0) {
    if (packRest.every(isBookkeepingLine)) {
      return { verdict: 'identical', ...base, packAheadBy: 0, localAheadBy: 0 };
    }
    return { verdict: 'packAhead', ...base, packAheadBy: packRest.length, localAheadBy: 0 };
  }
  return {
    verdict: 'diverged',
    ...base,
    packAheadBy: packRest.length,
    localAheadBy: localRest.length,
    divergedAt: i,
  };
}

/** 同一单元内多份日志的严重度顺序：分叉 > 本机更新 > 包更新 > 一致。 */
const VERDICT_RANK: Record<SessionVerdict, number> = {
  unreadable: 5,
  diverged: 4,
  localAhead: 3,
  packAhead: 2,
  identical: 1,
  new: 0,
};

/**
 * 同一会话单元可能有多份日志（不同 generation）。按文件相对路径逐一比，再取**最严重**的那条：
 * 用户关心的是「这一条导入会不会丢东西」，任一份分叉就必须说成会丢。
 */
export function aggregateSessionRows(unitId: string, diffs: readonly EventStreamDiff[], title?: string): SessionCompareRow {
  if (diffs.length === 0) return { unitId, verdict: 'new', packEvents: 0, localEvents: 0 };
  let worst = diffs[0] as EventStreamDiff;
  let packEvents = 0;
  let localEvents = 0;
  let packAheadBy = 0;
  let localAheadBy = 0;
  let divergedAt: number | undefined;
  for (const diff of diffs) {
    packEvents += diff.packEvents;
    localEvents += diff.localEvents;
    packAheadBy += diff.packAheadBy;
    localAheadBy += diff.localAheadBy;
    if (divergedAt === undefined && diff.divergedAt !== undefined) divergedAt = diff.divergedAt;
    if (VERDICT_RANK[diff.verdict] > VERDICT_RANK[worst.verdict]) worst = diff;
  }
  return {
    unitId,
    verdict: worst.verdict,
    packEvents,
    localEvents,
    ...(packAheadBy > 0 ? { packAheadBy } : {}),
    ...(localAheadBy > 0 ? { localAheadBy } : {}),
    ...(divergedAt !== undefined ? { divergedAt } : {}),
    ...(title !== undefined && title !== '' ? { title } : {}),
  };
}

/** 汇总计数（UI/报告只看这几个数字，逐条明细在 rows 里）。 */
export function countSessionVerdicts(rows: readonly SessionCompareRow[]): Record<SessionVerdict, number> {
  const out: Record<SessionVerdict, number> = {
    new: 0, identical: 0, packAhead: 0, localAhead: 0, diverged: 0, unreadable: 0,
  };
  for (const row of rows) out[row.verdict] += 1;
  return out;
}

/**
 * 「导入会覆盖掉本机会话内容」的条数与事件总数（确认页必须把它说出来的那句数字）。
 *
 * 口径：localAhead + diverged 两类 —— 它们的共同点就是**本机有包内没有的内容**。
 */
export function overwriteExposure(rows: readonly SessionCompareRow[]): { units: number; events: number } {
  let units = 0;
  let events = 0;
  for (const row of rows) {
    if (row.verdict !== 'localAhead' && row.verdict !== 'diverged') continue;
    units += 1;
    events += row.localAheadBy ?? 0;
  }
  return { units, events };
}
