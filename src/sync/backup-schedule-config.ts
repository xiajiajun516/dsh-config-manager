/**
 * m-backup-schedule：定时全量备份配置持久化（sync/backup-schedule.json）。
 *
 * 与 sync-autosync.json 并列独立文件：语义清楚（自动同步 vs 定时备份）、schema 演进独立。
 * schemaVersion:1 —— 单任务（无通道概念）：
 * ```
 * { "schemaVersion": 1,
 *   "enabled": false,
 *   "interval": "24h",
 *   "startupMinIntervalMs": 3600000,
 *   "consecutiveFailures": 0,
 *   "lastRunAt": "...", "lastRunStatus": "success|failed", "lastRunMessage": "..." }
 * ```
 *
 * 安全不变量：定时备份恒「不含 secret、不加密」——加密密码仅内存且不能持久化，
 * 与自动同步恒 includeSecrets=false 同语义；要加密备份请手动操作。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（enabled=false, interval='24h'）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const BACKUP_SCHEDULE_FILE = 'backup-schedule.json';
export const BACKUP_SCHEDULE_SCHEMA_VERSION = 1;

/** 定时备份间隔档位（全量备份无需太频繁；默认 24h）。
 *  - '6h' | '12h' | '24h' | '7d'：固定间隔；
 *  - 'custom'：每周固定时刻（见 customSchedule）。 */
export type BackupInterval = '6h' | '12h' | '24h' | '7d' | 'custom';

/**
 * 自定义（每周固定时刻）档配置：
 * - dayOfWeek：0-6（0 = 周日，1 = 周一 … 6 = 周六）；
 * - hour：0-23；
 * - minute：0-59。
 * 语义 = 每周该时刻触发一次全量备份（错过的时间点不补跑——下次排期自然对齐）。
 */
export interface BackupWeeklySchedule {
  dayOfWeek: number;
  hour: number;
  minute: number;
}

/** 缺省间隔 */
export const DEFAULT_BACKUP_INTERVAL: BackupInterval = '24h';

/** 缺省启动触发最小间隔阈值（1 小时，防频繁重启反复备份） */
export const DEFAULT_STARTUP_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** 最近一次定时备份执行状态 */
export type BackupRunStatus = 'success' | 'skipped' | 'failed';

/** 定时备份配置（持久化面） */
export interface BackupScheduleConfig {
  /** 总开关 */
  enabled: boolean;
  /** 备份间隔档位 */
  interval: BackupInterval;
  /** custom 档的每周固定时刻（仅 interval='custom' 时有意义；写入/读取宽容：其他档位忽略） */
  customSchedule?: BackupWeeklySchedule;
  /** 重启触发的「启动备份」最小间隔阈值（ms） */
  startupMinIntervalMs: number;
  /** 连续失败计数（用于通知判定） */
  consecutiveFailures: number;
  /** 最近一次执行时间（ISO-8601 UTC）；''/undefined = 从未执行 */
  lastRunAt?: string;
  /** 最近一次执行状态 */
  lastRunStatus?: BackupRunStatus;
  lastRunMessage?: string;
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultBackupSchedule(): BackupScheduleConfig {
  return {
    enabled: false,
    interval: DEFAULT_BACKUP_INTERVAL,
    startupMinIntervalMs: DEFAULT_STARTUP_MIN_INTERVAL_MS,
    consecutiveFailures: 0,
  };
}

/** 间隔 → ms 换算（固定间隔档；'custom' 无固定周期 → NaN，调用方改用 nextBackupDelayMs） */
export function backupIntervalToMs(interval: BackupInterval): number {
  const table: Record<Exclude<BackupInterval, 'custom'>, number> = {
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  if (interval === 'custom') return Number.NaN;
  return table[interval];
}

function isBackupInterval(v: unknown): v is BackupInterval {
  return v === '6h' || v === '12h' || v === '24h' || v === '7d' || v === 'custom';
}

/** 校验自定义周档（0-6 周几 / 0-23 时 / 0-59 分）；非法返回 null。 */
export function parseWeeklySchedule(v: unknown): BackupWeeklySchedule | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const dayOfWeek = o['dayOfWeek'];
  const hour = o['hour'];
  const minute = o['minute'];
  if (!Number.isInteger(dayOfWeek) || (dayOfWeek as number) < 0 || (dayOfWeek as number) > 6) return null;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) return null;
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) return null;
  return { dayOfWeek: dayOfWeek as number, hour: hour as number, minute: minute as number };
}

/**
 * 计算下一次「定时备份」触发的 delay ms（相对 now；至少 >0）。
 * - 固定间隔档：直接返回 interval ms（与旧行为一致——从上次排期算固定周期）；
 * - 'custom'：计算从 now 到下一个匹配「周几 时:分」时刻的毫秒数（跨周自动对齐；
 *   若今天正好是该时刻且已过 → 排到下周同刻；未过 → 今天同刻）。
 * 配置非法（custom 无 valid customSchedule）→ 返回 null（调用方不排期）。
 */
export function nextBackupDelayMs(
  cfg: Pick<BackupScheduleConfig, 'interval' | 'customSchedule'>,
  now: Date = new Date(),
): number | null {
  if (cfg.interval !== 'custom') {
    const ms = backupIntervalToMs(cfg.interval);
    return Number.isNaN(ms) ? null : ms;
  }
  const sched = cfg.customSchedule;
  if (sched === null || sched === undefined) return null;
  // 距目标周几的天数（0-6）：目标周几 - 当前周几，模 7 归一
  const days = (sched.dayOfWeek - now.getDay() + 7) % 7;
  const target = new Date(now);
  target.setDate(now.getDate() + days);
  target.setHours(sched.hour, sched.minute, 0, 0);
  let delay = target.getTime() - now.getTime();
  if (delay <= 0) delay += 7 * 24 * 60 * 60 * 1000; // 同刻已过 → 下周同刻
  return delay;
}

/** 从文件载荷解析（非法字段回退缺省） */
function parsePayload(obj: Record<string, unknown>): BackupScheduleConfig {
  const cfg = defaultBackupSchedule();
  if (typeof obj['enabled'] === 'boolean') cfg.enabled = obj['enabled'];
  if (isBackupInterval(obj['interval'])) cfg.interval = obj['interval'];
  const weekly = parseWeeklySchedule(obj['customSchedule']);
  if (weekly !== null) cfg.customSchedule = weekly;
  if (typeof obj['startupMinIntervalMs'] === 'number' && Number.isFinite(obj['startupMinIntervalMs']) && obj['startupMinIntervalMs'] > 0) {
    cfg.startupMinIntervalMs = obj['startupMinIntervalMs'];
  }
  if (typeof obj['consecutiveFailures'] === 'number' && Number.isFinite(obj['consecutiveFailures']) && obj['consecutiveFailures'] >= 0) {
    cfg.consecutiveFailures = obj['consecutiveFailures'];
  }
  if (typeof obj['lastRunAt'] === 'string' && obj['lastRunAt'] !== '') cfg.lastRunAt = obj['lastRunAt'];
  if (obj['lastRunStatus'] === 'success' || obj['lastRunStatus'] === 'skipped' || obj['lastRunStatus'] === 'failed') {
    cfg.lastRunStatus = obj['lastRunStatus'];
  }
  if (typeof obj['lastRunMessage'] === 'string') cfg.lastRunMessage = obj['lastRunMessage'];
  return cfg;
}

/** 读取定时备份配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readBackupSchedule(dir: string): Promise<BackupScheduleConfig> {
  const file = path.join(dir, BACKUP_SCHEDULE_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return defaultBackupSchedule();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return defaultBackupSchedule();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultBackupSchedule();
  }
  const obj = parsed as Record<string, unknown>;
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (ver !== BACKUP_SCHEDULE_SCHEMA_VERSION) return defaultBackupSchedule();
  return parsePayload(obj);
}

/** 写入定时备份配置（原子写：临时文件 + rename；自动创建目录）。 */
export async function writeBackupSchedule(dir: string, cfg: BackupScheduleConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: BACKUP_SCHEDULE_SCHEMA_VERSION,
    enabled: cfg.enabled,
    interval: cfg.interval,
    startupMinIntervalMs: cfg.startupMinIntervalMs,
    consecutiveFailures: cfg.consecutiveFailures,
  };
  if (cfg.customSchedule !== undefined) payload['customSchedule'] = cfg.customSchedule;
  if (cfg.lastRunAt !== undefined && cfg.lastRunAt !== '') payload['lastRunAt'] = cfg.lastRunAt;
  if (cfg.lastRunStatus !== undefined) payload['lastRunStatus'] = cfg.lastRunStatus;
  if (cfg.lastRunMessage !== undefined && cfg.lastRunMessage !== '') payload['lastRunMessage'] = cfg.lastRunMessage;
  const target = path.join(dir, BACKUP_SCHEDULE_FILE);
  const data = stringifyJsonSafe(payload, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}
