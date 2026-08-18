/**
 * m-sync-selection：远程同步分区选择持久化（sync-selection.json）。
 *
 * 与 sync-config.json / sync-autosync.json 并列独立文件：语义清楚、schema 演进独立。
 * 字段 { mode: 'default'|'advanced', sections: SectionId[] }：
 * - mode='default'（快速导出）：推送/自动同步使用全部 portable 推荐分区（sections 可空）；
 * - mode='advanced'（自定义导出）：推送/自动同步只处理勾选的 sections（非 portable 由
 *   SyncEngine portableAdapters 过滤兜底；空 sections 回退全量，避免自动同步卡死）。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（mode='default', sections=[]）。
 * 持久化原因：自动同步调度器运行于 Host 进程（浏览器关闭也在跑），必须从磁盘读
 * 用户选择，而不是依赖浏览器 localStorage。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type { SectionId } from '../schema/types.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

export const SYNC_SELECTION_FILE = 'sync-selection.json';
export const SYNC_SELECTION_SCHEMA_VERSION = 1;

/** 远程同步分区选择模式：default = 快速导出（全量推荐分区）；advanced = 自定义勾选。 */
export type SyncSelectionMode = 'default' | 'advanced';

/** 远程同步分区选择（持久化面）。 */
export interface SyncSelection {
  schemaVersion: number;
  mode: SyncSelectionMode;
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultSyncSelection(): SyncSelection {
  return { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'default', sections: [] };
}

/**
 * 生效的同步分区范围：
 * - mode='advanced' 且 sections 非空 → sections（自定义导出）；
 * - 其余（default / advanced 但未勾选）→ undefined（= 全部 portable 推荐分区）。
 */
export function effectiveSections(sel: SyncSelection): SectionId[] | undefined {
  if (sel.mode === 'advanced' && sel.sections.length > 0) return [...sel.sections];
  return undefined;
}

/** 读取分区选择配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readSyncSelection(dir: string): Promise<SyncSelection> {
  const file = path.join(dir, SYNC_SELECTION_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return defaultSyncSelection();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return defaultSyncSelection();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultSyncSelection();
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== undefined && obj['schemaVersion'] !== SYNC_SELECTION_SCHEMA_VERSION) {
    return defaultSyncSelection();
  }
  if (obj['schemaVersion'] === undefined) {
    return defaultSyncSelection();
  }
  const sel = defaultSyncSelection();
  if (obj['mode'] === 'advanced' || obj['mode'] === 'default') sel.mode = obj['mode'];
  if (Array.isArray(obj['sections'])) {
    sel.sections = obj['sections'].filter(
      (s): s is SectionId => typeof s === 'string' && s !== '',
    );
  }
  return sel;
}

/** 写入分区选择配置（原子写：临时文件 + rename；自动创建目录）。 */
export async function writeSyncSelection(dir: string, sel: SyncSelection): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
    mode: sel.mode,
    sections: sel.sections,
  };
  const target = path.join(dir, SYNC_SELECTION_FILE);
  const tmp = path.join(
    dir,
    `.${SYNC_SELECTION_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const data = stringifyJsonSafe(payload, { space: 2 });
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    try { await fs.rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
