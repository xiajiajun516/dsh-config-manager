/**
 * m-autosync：自动同步执行记录持久化（sync-history.json）。
 *
 * 与 sync-config/autosync-config 并列独立文件。schemaVersion:1，
 * 结构 { schemaVersion, autosyncEntries: AutosyncHistoryEntry[], updatedAt }。
 *
 * - append 追加（升序）并裁剪保留最近 AUTOSYNC_HISTORY_KEEP 条；
 * - 原子写（临时文件 + rename）；
 * - 损坏 JSON 严格拒绝（不静默降级到空列表）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import type { SectionId } from '../schema/types.ts';

export const SYNC_HISTORY_FILE = 'sync-history.json';
export const SYNC_HISTORY_SCHEMA_VERSION = 1;
/** 自动同步历史保留上限 */
export const AUTOSYNC_HISTORY_KEEP = 200;

/** 自动同步执行记录（§3.7 AutosyncHistoryEntry） */
export interface AutosyncHistoryEntry {
  /** 执行方向 */
  direction: 'pull' | 'push' | 'both';
  status: 'success' | 'skipped' | 'failed' | 'partial';
  /** 跳过原因（冲突项 / 缺失依赖 / Install / 错误 / 无远端 / 网络） */
  skipReason?: string;
  /** 被跳过的冲突分区 id（冲突跳过时列出） */
  conflictedSections?: SectionId[];
  /** 本次自动合并实际写入的分区 */
  appliedSections?: SectionId[];
  /** 本次 push 产生的快照 id（direction 含 push 时） */
  pushedSnapshotId?: string;
  /** 本次 pull 来源快照 id */
  pulledSnapshotId?: string;
  /** failed 时的错误摘要（脱敏） */
  error?: string;
  /** 连续失败 3 次通知时间（ISO-8601 UTC） */
  notifiedAt?: string;
  /** 本次触发时的连续失败计数 */
  failureCountAtRun: number;
  /** 记录创建时间（ISO-8601 UTC） */
  createdAt: string;
}

/** sync-history.json 文件结构 */
export interface SyncHistoryFile {
  schemaVersion: number;
  autosyncEntries: AutosyncHistoryEntry[];
  updatedAt: string;
}

/** 读取同步历史；文件不存在 → 空列表（schemaVersion=1）。损坏 JSON 抛错。 */
export async function readSyncHistory(dir: string): Promise<SyncHistoryFile> {
  const file = path.join(dir, SYNC_HISTORY_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { schemaVersion: SYNC_HISTORY_SCHEMA_VERSION, autosyncEntries: [], updatedAt: '' };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    throw new Error(`${SYNC_HISTORY_FILE} 损坏：JSON 解析失败`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${SYNC_HISTORY_FILE} 损坏：必须是对象`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== SYNC_HISTORY_SCHEMA_VERSION) {
    throw new Error(`${SYNC_HISTORY_FILE} 损坏：schemaVersion 必须是 ${SYNC_HISTORY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(obj['autosyncEntries'])) {
    throw new Error(`${SYNC_HISTORY_FILE} 损坏：autosyncEntries 必须是数组`);
  }
  const entries: AutosyncHistoryEntry[] = [];
  for (const it of obj['autosyncEntries']) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) {
      throw new Error(`${SYNC_HISTORY_FILE} 损坏：每个 entry 必须是对象`);
    }
    const e = it as Record<string, unknown>;
    if (typeof e['direction'] !== 'string' || typeof e['status'] !== 'string' || typeof e['createdAt'] !== 'string') {
      throw new Error(`${SYNC_HISTORY_FILE} 损坏：entry 必须含字符串 direction/status/createdAt`);
    }
    entries.push(it as unknown as AutosyncHistoryEntry);
  }
  return {
    schemaVersion: SYNC_HISTORY_SCHEMA_VERSION,
    autosyncEntries: entries,
    updatedAt: typeof obj['updatedAt'] === 'string' ? obj['updatedAt'] : '',
  };
}

/** 追加一条自动同步执行记录（升序），裁剪到 AUTOSYNC_HISTORY_KEEP 条，原子写。 */
export async function appendAutosyncEntry(
  dir: string,
  entry: AutosyncHistoryEntry,
  now: () => Date = () => new Date(),
): Promise<void> {
  const current = await readSyncHistory(dir);
  current.autosyncEntries.push(entry);
  // 裁剪：保留最近 AUTOSYNC_HISTORY_KEEP 条（升序 → 去掉最前的超限条）
  if (current.autosyncEntries.length > AUTOSYNC_HISTORY_KEEP) {
    current.autosyncEntries = current.autosyncEntries.slice(current.autosyncEntries.length - AUTOSYNC_HISTORY_KEEP);
  }
  current.updatedAt = now().toISOString();

  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, SYNC_HISTORY_FILE);
  const tmp = path.join(
    dir,
    `.${SYNC_HISTORY_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const data = stringifyJsonSafe(current, { space: 2 });
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    try { await fs.rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
