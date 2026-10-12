/**
 * 「会话标题」的**日志兜底**（2026-10-12 用户要求：缓存里没有这条会话，就自动读这条会话自己的名字）。
 *
 * 两条来源，优先级固定：
 *  ① `storages/session_projcache.json` 的 `rows.title.val`（`core/session-meta.ts` 的索引，快、覆盖常态）；
 *  ② **会话日志里的 `session/title` 事件**（本模块）—— DSH 自己写的标题事件，
 *     `data = { title, messageSeqs, source }`；`source = 'user'` 表示用户显式改过名（它压过自动生成的那条）。
 *     缓存里没有这条会话（旧会话 / 别的档案写的 / 子代理会话）时，这是**唯一不猜**的名字来源。
 *
 * 只读 + 有界 + 诚实：
 *  · 只读日志**前** {@link SESSION_TITLE_SCAN_BYTES}（1 MiB，覆盖「标题在开头几回合内生成」的常态）；
 *    超出这个窗口的标题事件读不到 → 返回 null，界面回落显示会话 id（**绝不从首条消息编造标题**）；
 *  · 同一个会话出现多条标题事件时取**最后一条**（用户改名压过自动标题）；
 *  · 同一条日志按 `mtime + size` 缓存在进程内：日志增长（新标题落盘）后自动重读，不吃陈旧结论；
 *  · 一次请求最多补 {@link SESSION_TITLE_MAX_READS} 个会话（台账里几十条缺标题时不把盘读穿）。
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isSessionLogName } from '../utils/session-log.ts';
import { decodeZstdFrame, scanZstdFrames, zstdAvailable } from '../utils/zstd-frame.ts';

/** 只扫日志前这么多字节（标题通常在开头几回合内写入；更大的日志只扫前缀，读不到就回落 id）。 */
export const SESSION_TITLE_SCAN_BYTES = 1024 * 1024;

/** 一次请求最多为几个会话做日志兜底（按 unitId 去重之后）。 */
export const SESSION_TITLE_MAX_READS = 24;

interface TitleCacheEntry {
  mtimeMs: number;
  size: number;
  title: string | null;
}

/** 进程内缓存：绝对路径 → （mtime + size + 结论）。日志一增长就失效（不吃陈旧结论）。 */
const titleCache = new Map<string, TitleCacheEntry>();

/** 清空缓存（单测用；宿主进程内长期有效是刻意的）。 */
export function clearSessionTitleCache(): void {
  titleCache.clear();
}

/** `session/title` 事件行 → 标题（形状不对 / 空标题一律 null，绝不猜）。 */
function titleOfRow(row: unknown): string | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const rec = row as Record<string, unknown>;
  if (rec['type'] !== 'session/title') return null;
  const data = rec['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const title = (data as Record<string, unknown>)['title'];
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
}

/** 只读日志**前缀**（最多 `max` 字节；读不出回 null，绝不抛）。 */
async function readPrefix(absPath: string, max: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 从会话日志字节里取标题：解出每个**完整**帧，逐行先做 `session/title` 子串预筛（省掉整篇 JSON.parse），
 * 命中才解析该行；多条命中取最后一条。容器损坏 / 无 zstd 能力 → null。
 */
function titleFromBytes(bytes: Uint8Array): string | null {
  let frames: { start: number; end: number }[];
  try {
    frames = scanZstdFrames(bytes).frames;
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const frame of frames) {
    let text: string;
    try {
      text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      return found;
    }
    for (const line of text.split('\n')) {
      if (line === '' || !line.includes('session/title')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const title = titleOfRow(parsed);
      if (title !== null) found = title;
    }
  }
  return found;
}

/** 读单个日志文件的标题（带 mtime+size 缓存）。 */
async function readTitleFromLogFile(absPath: string): Promise<string | null> {
  if (!zstdAvailable()) return null;
  const info = await stat(absPath).catch(() => null);
  if (info === null) return null;
  const cached = titleCache.get(absPath);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.title;
  const prefix = await readPrefix(absPath, SESSION_TITLE_SCAN_BYTES);
  const title = prefix === null ? null : titleFromBytes(prefix);
  titleCache.set(absPath, { mtimeMs: info.mtimeMs, size: info.size, title });
  return title;
}

/** `unitId`（`<projectKey>/<sessionId>`）→ 目录段；越界 / 形状不符一律 null（绝不拼可疑路径）。 */
function unitSegments(unitId: string): string[] | null {
  const parts = unitId.split('/').filter((part) => part !== '');
  if (parts.length < 2) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\\') || part.includes(':')) return null;
  }
  return parts;
}

/**
 * 从会话日志里读这条会话自己的名字（`session/title` 事件）。
 *
 * @param sessionsDir 会话根目录（`<homeDir>/sessions`）。
 * @param unitId 台账里的会话单元 id（`<projectKey>/<sessionId>`；缺了就返回 null）。
 * @returns 标题；读不到 / 没有标题事件 / 形状不符 → null（界面回落显示会话 id）。
 */
export async function readSessionTitleFromLog(sessionsDir: string, unitId: string): Promise<string | null> {
  const parts = unitSegments(unitId);
  if (parts === null) return null;
  const dir = join(sessionsDir, ...parts);
  const names = await readdir(dir).catch(() => [] as string[]);
  const logs = names.filter((name) => isSessionLogName(name)).sort();
  if (logs.length === 0) return null;
  // 与体检同口径：同一会话有多份 generation 时以**最新的一份**（字典序最后）为准
  const picked = logs[logs.length - 1];
  if (picked === undefined) return null;
  return readTitleFromLogFile(join(dir, picked));
}

/**
 * 给一批台账行补标题：**已有标题的不动**，缺标题的按 `unitId` 去重后走日志兜底。
 *
 * 只读、有界（见 {@link SESSION_TITLE_MAX_READS}）、失败一律原样返回（界面回落显示会话 id）。
 */
export async function applySessionLogTitles<
  T extends { sessionId?: string | null; unitId?: string | null; title?: string },
>(
  rows: readonly T[],
  sessionsDir: string,
  options: { maxReads?: number } = {},
): Promise<(T & { title?: string })[]> {
  const maxReads = Math.max(0, options.maxReads ?? SESSION_TITLE_MAX_READS);
  const resolved = new Map<string, string | null>();
  const out: (T & { title?: string })[] = [];
  let reads = 0;
  for (const row of rows) {
    if (typeof row.title === 'string' && row.title.trim() !== '') {
      out.push(row);
      continue;
    }
    const unitId = typeof row.unitId === 'string' && row.unitId !== '' ? row.unitId : null;
    if (unitId === null) {
      out.push(row);
      continue;
    }
    let title = resolved.get(unitId);
    if (title === undefined) {
      if (reads >= maxReads) {
        out.push(row);
        continue;
      }
      reads += 1;
      title = await readSessionTitleFromLog(sessionsDir, unitId);
      resolved.set(unitId, title);
    }
    out.push(title === null || title === '' ? row : { ...row, title });
  }
  return out;
}
