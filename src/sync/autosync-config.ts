/**
 * m-autosync：自动同步配置持久化（sync-autosync.json）。
 *
 * 与 sync-config.json 并列独立文件：语义清楚、schema 演进独立。
 * schemaVersion:2 —— 按同步通道拆分（git / webdav 各自独立的自动同步配置与运行状态）：
 * ```
 * { "schemaVersion": 2,
 *   "channels": {
 *     "git":    { enabled, interval, startupMinIntervalMs, consecutiveFailures, lastRunAt, ... },
 *     "webdav": { ... } } }
 * ```
 * v1（顶层单通道）→ 读取时归一为 v2 的 git 通道（webdav 回退缺省）。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（enabled=false,
 * interval='30m', startupMinIntervalMs=5*60*1000）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type { SyncTransportType } from './sync-config.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

export const AUTOSYNC_CONFIG_FILE = 'sync-autosync.json';
export const AUTOSYNC_CONFIG_SCHEMA_VERSION = 2;

/** 统一间隔类型 */
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';

/** 缺省间隔 */
export const DEFAULT_AUTOSYNC_INTERVAL: AutosyncInterval = '30m';

/** 缺省启动触发最小间隔阈值（5 分钟，防频繁重启反复同步） */
export const DEFAULT_STARTUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 最近一次自动同步执行状态 */
export type AutosyncRunStatus = 'success' | 'skipped' | 'failed' | 'partial';

/** 自动同步配置（持久化面；单通道） */
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

/** 全通道配置视图（v2 文件直接读取；status 路由一次返回两个通道的状态）。 */
export type AutosyncConfigByChannel = Record<SyncTransportType, AutosyncConfig>;

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultAutosyncConfig(): AutosyncConfig {
  return {
    enabled: false,
    interval: DEFAULT_AUTOSYNC_INTERVAL,
    startupMinIntervalMs: DEFAULT_STARTUP_MIN_INTERVAL_MS,
    consecutiveFailures: 0,
  };
}

/** 从 v1 顶层字段（缺 schemaVersion 或 schemaVersion=1）解析单通道配置；非法字段回退缺省。 */
function parseV1Channel(obj: Record<string, unknown>): AutosyncConfig {
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

/** 从 v2 channels 命名空间解析单通道配置；缺失/非法 → 缺省。 */
function parseV2Channel(ns: unknown): AutosyncConfig {
  if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) return defaultAutosyncConfig();
  return parseV1Channel(ns as Record<string, unknown>);
}

/** 读取全部通道的自动同步配置（v2 文件；v1 迁移为 git；webdav 缺省）。 */
export async function readAllAutosyncConfigs(dir: string): Promise<AutosyncConfigByChannel> {
  const file = path.join(dir, AUTOSYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { git: defaultAutosyncConfig(), webdav: defaultAutosyncConfig() };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return { git: defaultAutosyncConfig(), webdav: defaultAutosyncConfig() };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { git: defaultAutosyncConfig(), webdav: defaultAutosyncConfig() };
  }
  const obj = parsed as Record<string, unknown>;
  // schemaVersion：缺省视为 v1；非缺省但 != 2 → 回退缺省
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (ver !== 1 && ver !== AUTOSYNC_CONFIG_SCHEMA_VERSION) {
    return { git: defaultAutosyncConfig(), webdav: defaultAutosyncConfig() };
  }
  if (ver === 1) {
    // v1 迁移：顶层字段 → git 通道（webdav 缺省；首次按 v2 写回时持久化）
    return { git: parseV1Channel(obj), webdav: defaultAutosyncConfig() };
  }
  const channels = obj['channels'];
  const ch = channels !== null && typeof channels === 'object' && !Array.isArray(channels)
    ? channels as Record<string, unknown>
    : {};
  return {
    git: parseV2Channel(ch['git']),
    webdav: parseV2Channel(ch['webdav']),
  };
}

/** 读取指定通道的自动同步配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readAutosyncConfig(dir: string, channel: SyncTransportType): Promise<AutosyncConfig> {
  const all = await readAllAutosyncConfigs(dir);
  return all[channel];
}

/** 写入指定通道的自动同步配置（原子写：临时文件 + rename；保留另一通道；自动创建目录）。 */
export async function writeAutosyncConfig(dir: string, channel: SyncTransportType, cfg: AutosyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await readAllAutosyncConfigs(dir);
  const channels: Record<SyncTransportType, AutosyncConfig> = {
    git: channel === 'git' ? cfg : existing.git,
    webdav: channel === 'webdav' ? cfg : existing.webdav,
  };
  const payload: Record<string, unknown> = {
    schemaVersion: AUTOSYNC_CONFIG_SCHEMA_VERSION,
    channels: {
      git: toChannelPayload(channels.git),
      webdav: toChannelPayload(channels.webdav),
    },
  };
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

/** AutosyncConfig → 文件载荷（可选运行字段仅在非空时写入，保持文件干净）。 */
function toChannelPayload(cfg: AutosyncConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    enabled: cfg.enabled,
    interval: cfg.interval,
    startupMinIntervalMs: cfg.startupMinIntervalMs,
    consecutiveFailures: cfg.consecutiveFailures,
  };
  if (cfg.lastRunAt !== undefined && cfg.lastRunAt !== '') payload['lastRunAt'] = cfg.lastRunAt;
  if (cfg.lastRunStatus !== undefined) payload['lastRunStatus'] = cfg.lastRunStatus;
  if (cfg.lastRunMessage !== undefined && cfg.lastRunMessage !== '') payload['lastRunMessage'] = cfg.lastRunMessage;
  if (cfg.lastRunHistoryId !== undefined && cfg.lastRunHistoryId !== '') payload['lastRunHistoryId'] = cfg.lastRunHistoryId;
  return payload;
}

function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h';
}
