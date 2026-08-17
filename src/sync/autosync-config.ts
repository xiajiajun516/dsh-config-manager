/**
 * m-autosync：自动同步配置持久化（sync-autosync.json）。
 *
 * 与 sync-config.json 并列独立文件：语义清楚、schema 演进独立。
 * schemaVersion:1，字段 { enabled, interval, startupMinIntervalMs, consecutiveFailures,
 * lastRunAt, lastRunStatus, lastRunMessage, lastRunHistoryId }。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（enabled=false,
 * interval='30m', startupMinIntervalMs=5*60*1000）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

export const AUTOSYNC_CONFIG_FILE = 'sync-autosync.json';
export const AUTOSYNC_CONFIG_SCHEMA_VERSION = 1;

/** 统一间隔类型 */
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';

/** 缺省间隔 */
export const DEFAULT_AUTOSYNC_INTERVAL: AutosyncInterval = '30m';

/** 缺省启动触发最小间隔阈值（5 分钟，防频繁重启反复同步） */
export const DEFAULT_STARTUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 最近一次自动同步执行状态 */
export type AutosyncRunStatus = 'success' | 'skipped' | 'failed' | 'partial';

/** 自动同步配置（持久化面） */
export interface AutosyncConfig {
  /** 总开关（同时控制上传 + 下载） */
  enabled: boolean;
  /** 统一间隔 */
  interval: AutosyncInterval;
  /** 重启触发的「自动下载合并」最小间隔阈值（ms） */
  startupMinIntervalMs: number;
  /** 连续失败计数（用于通知判定） */
  consecutiveFailures: number;
  /** 最近一次自动同步执行时间（ISO-8601 UTC）；''/undefined = 从未执行 */
  lastRunAt?: string;
  /** 最近一次自动同步执行状态 */
  lastRunStatus?: AutosyncRunStatus;
  lastRunMessage?: string;
  /** 最近一次自动同步触发的同步历史条目 id */
  lastRunHistoryId?: string;
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultAutosyncConfig(): AutosyncConfig {
  return {
    enabled: false,
    interval: DEFAULT_AUTOSYNC_INTERVAL,
    startupMinIntervalMs: DEFAULT_STARTUP_MIN_INTERVAL_MS,
    consecutiveFailures: 0,
  };
}

/** 读取自动同步配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readAutosyncConfig(dir: string): Promise<AutosyncConfig> {
  const file = path.join(dir, AUTOSYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return defaultAutosyncConfig();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return defaultAutosyncConfig();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultAutosyncConfig();
  }
  const obj = parsed as Record<string, unknown>;
  // schemaVersion 必须为 1（不支持其他版本）
  if (obj['schemaVersion'] !== undefined && obj['schemaVersion'] !== AUTOSYNC_CONFIG_SCHEMA_VERSION) {
    return defaultAutosyncConfig();
  }
  if (obj['schemaVersion'] === undefined) {
    return defaultAutosyncConfig();
  }
  const cfg = defaultAutosyncConfig();
  if (typeof obj['enabled'] === 'boolean') cfg.enabled = obj['enabled'];
  if (isAutosyncInterval(obj['interval'])) cfg.interval = obj['interval'];
  if (typeof obj['startupMinIntervalMs'] === 'number' && Number.isFinite(obj['startupMinIntervalMs']) && obj['startupMinIntervalMs'] > 0) {
    cfg.startupMinIntervalMs = obj['startupMinIntervalMs'];
  }
  if (typeof obj['consecutiveFailures'] === 'number' && Number.isFinite(obj['consecutiveFailures']) && obj['consecutiveFailures'] >= 0) {
    cfg.consecutiveFailures = obj['consecutiveFailures'];
  }
  if (typeof obj['lastRunAt'] === 'string' && obj['lastRunAt'] !== '') cfg.lastRunAt = obj['lastRunAt'];
  if (typeof obj['lastRunStatus'] === 'string' && (obj['lastRunStatus'] === 'success' || obj['lastRunStatus'] === 'skipped' || obj['lastRunStatus'] === 'failed' || obj['lastRunStatus'] === 'partial')) {
    cfg.lastRunStatus = obj['lastRunStatus'];
  }
  if (typeof obj['lastRunMessage'] === 'string') cfg.lastRunMessage = obj['lastRunMessage'];
  if (typeof obj['lastRunHistoryId'] === 'string') cfg.lastRunHistoryId = obj['lastRunHistoryId'];
  return cfg;
}

/** 写入自动同步配置（原子写：临时文件 + rename；自动创建目录）。 */
export async function writeAutosyncConfig(dir: string, cfg: AutosyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: AUTOSYNC_CONFIG_SCHEMA_VERSION,
    enabled: cfg.enabled,
    interval: cfg.interval,
    startupMinIntervalMs: cfg.startupMinIntervalMs,
    consecutiveFailures: cfg.consecutiveFailures,
  };
  if (cfg.lastRunAt !== undefined && cfg.lastRunAt !== '') payload['lastRunAt'] = cfg.lastRunAt;
  if (cfg.lastRunStatus !== undefined) payload['lastRunStatus'] = cfg.lastRunStatus;
  if (cfg.lastRunMessage !== undefined && cfg.lastRunMessage !== '') payload['lastRunMessage'] = cfg.lastRunMessage;
  if (cfg.lastRunHistoryId !== undefined && cfg.lastRunHistoryId !== '') payload['lastRunHistoryId'] = cfg.lastRunHistoryId;

  const target = path.join(dir, AUTOSYNC_CONFIG_FILE);
  const tmp = path.join(
    dir,
    `.${AUTOSYNC_CONFIG_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
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

function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h';
}
