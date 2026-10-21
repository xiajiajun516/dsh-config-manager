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

import { channelMap } from './sync-config.ts';
import type { SyncTransportType } from './sync-config.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const AUTOSYNC_CONFIG_FILE = 'sync-autosync.json';
export const AUTOSYNC_CONFIG_SCHEMA_VERSION = 2;

/** 统一间隔类型 */
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';

/** 缺省间隔 */
export const DEFAULT_AUTOSYNC_INTERVAL: AutosyncInterval = '30m';

/** 缺省启动触发最小间隔阈值（5 分钟，防频繁重启反复同步） */
export const DEFAULT_STARTUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 缺省开启「本地改动即时触发」（真·自动同步；关闭后退回纯定时器） */
export const DEFAULT_AUTOSYNC_REALTIME = true;

/** 缺省远端轮询间隔（realtime 开启时与本地监听并行：本地改动即时上行，远端改动最迟 1 分钟内下行） */
export const DEFAULT_AUTOSYNC_REMOTE_CHECK_MS = 60 * 1000;

/** 远端轮询间隔下限（15 s）：再短只是空转 fetch，收益为零 */
export const MIN_AUTOSYNC_REMOTE_CHECK_MS = 15 * 1000;

/** 远端轮询间隔上限（60 min）：比这更慢就不该叫「实时」了 */
export const MAX_AUTOSYNC_REMOTE_CHECK_MS = 60 * 60 * 1000;

/** 自动应用的最高风险等级（low = 只有低风险分区自动落盘；medium = 中风险 plugins/mcp 也自动落盘） */
export type AutosyncAutoApplyTier = 'low' | 'medium';

/** 缺省自动应用等级：medium（用户拍板：plugins/mcp 的中风险改动也要真自动，否则「同步所有改动」是假的） */
export const DEFAULT_AUTOSYNC_AUTO_APPLY_TIER: AutosyncAutoApplyTier = 'medium';

/**
 * 双侧都改（真冲突）时的自动裁决策略：
 *  - 'ask'   ：保留冲突待人工裁决（改造前的唯一行为）；
 *  - 'local' ：缺省 —— **保留本机并推上去**（VS Code 风格）：本机版本成为新的远端最新，
 *              被覆盖的远端版本仍留在远端历史快照里，随时可回滚。
 *
 * 刻意**不提供** 'remote'：采用远端需要走 applyMergeResolutions，那条路径会整体应用所有
 * 可决断分区、绕过 risk.ts 的风险分级（audit-sync sync-F5），与「分区逐档放行」冲突。
 */
export type AutosyncConflictPolicy = 'ask' | 'local';

/** 缺省冲突策略：local（保留本机并推上去） */
export const DEFAULT_AUTOSYNC_CONFLICT_POLICY: AutosyncConflictPolicy = 'local';

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
  /**
   * 真·自动同步：本地文件改动后即时触发一次（缺省 true）。
   *
   * false = 退回改造前的纯定时器语义（等 interval 到点）；保留这个开关是因为
   * 「监听整棵配置目录」在某些环境（网络盘、超大 skills 树）可能带来额外 I/O。
   *
   * 可选：**读取层（parseV1Channel）恒补缺省值**，旧文件/旧夹具不需要带这个字段。
   */
  realtime?: boolean;
  /** realtime 开启时的远端轮询间隔（ms；下限 15 s、上限 60 min，缺省 60 s） */
  remoteCheckMs?: number;
  /** 自动应用的最高风险等级（缺省 medium） */
  autoApplyTier?: AutosyncAutoApplyTier;
  /** 双侧都改时的自动裁决策略（缺省 local：保留本机并推上去） */
  conflictPolicy?: AutosyncConflictPolicy;
  /** 连续失败计数（用于通知判定） */
  consecutiveFailures: number;
  /** 最近一次自动同步执行时间（ISO-8601 UTC）；''/undefined = 从未执行 */
  lastRunAt?: string;
  /** 最近一次自动同步执行状态 */
  lastRunStatus?: AutosyncRunStatus;
  lastRunMessage?: string;
  /**
   * 最近一次**跳过**的结构化原因码（issue #79）。
   *
   * 为什么是码而不是文案：语言在「取文案那一刻」解析（AGENTS.md i18n 铁律），状态行由界面
   * 按码取自己的字典；存一句当时语言的中文，用户切到英文界面后会看到中英混排。
   * 已知值见 `svc.autosyncSkip.*` 的字典键（'conflict'/'mutation-locked'/'upToDate'…），
   * **未知码一律渲染兜底文案，绝不渲染裸枚举**。
   */
  lastRunSkipReason?: string;
  /** 最近一次跳过涉及的分区数（当前仅 conflict：远端另有 N 个分区待确认） */
  lastRunSkipCount?: number;
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
    realtime: DEFAULT_AUTOSYNC_REALTIME,
    remoteCheckMs: DEFAULT_AUTOSYNC_REMOTE_CHECK_MS,
    autoApplyTier: DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
    conflictPolicy: DEFAULT_AUTOSYNC_CONFLICT_POLICY,
  };
}

/** 远端轮询间隔夹取（非数字 / 越界一律回落到边界值，绝不写入 NaN）。 */
export function clampRemoteCheckMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTOSYNC_REMOTE_CHECK_MS;
  return Math.min(MAX_AUTOSYNC_REMOTE_CHECK_MS, Math.max(MIN_AUTOSYNC_REMOTE_CHECK_MS, Math.round(value)));
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
  // 真·自动同步的三个新字段：缺失（旧文件）→ 缺省值，等于升级后立刻自动生效（用户已拍板）
  if (typeof obj['realtime'] === 'boolean') cfg.realtime = obj['realtime'];
  if (typeof obj['remoteCheckMs'] === 'number') cfg.remoteCheckMs = clampRemoteCheckMs(obj['remoteCheckMs']);
  if (obj['autoApplyTier'] === 'low' || obj['autoApplyTier'] === 'medium') cfg.autoApplyTier = obj['autoApplyTier'];
  if (obj['conflictPolicy'] === 'ask' || obj['conflictPolicy'] === 'local') {
    cfg.conflictPolicy = obj['conflictPolicy'];
  }
  if (typeof obj['lastRunAt'] === 'string' && obj['lastRunAt'] !== '') cfg.lastRunAt = obj['lastRunAt'];
  if (typeof obj['lastRunStatus'] === 'string' && (obj['lastRunStatus'] === 'success' || obj['lastRunStatus'] === 'skipped' || obj['lastRunStatus'] === 'failed' || obj['lastRunStatus'] === 'partial')) {
    cfg.lastRunStatus = obj['lastRunStatus'];
  }
  if (typeof obj['lastRunMessage'] === 'string') cfg.lastRunMessage = obj['lastRunMessage'];
  // issue #79：状态行的结构化跳过原因（旧文件没有这两个字段 → undefined，行为不变）
  if (typeof obj['lastRunSkipReason'] === 'string' && obj['lastRunSkipReason'] !== '') {
    cfg.lastRunSkipReason = obj['lastRunSkipReason'];
  }
  if (typeof obj['lastRunSkipCount'] === 'number' && Number.isFinite(obj['lastRunSkipCount']) && obj['lastRunSkipCount'] >= 0) {
    cfg.lastRunSkipCount = obj['lastRunSkipCount'];
  }
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
    return channelMap(() => defaultAutosyncConfig());
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return channelMap(() => defaultAutosyncConfig());
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return channelMap(() => defaultAutosyncConfig());
  }
  const obj = parsed as Record<string, unknown>;
  // schemaVersion：缺省视为 v1；非缺省但 != 2 → 回退缺省
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (ver !== 1 && ver !== AUTOSYNC_CONFIG_SCHEMA_VERSION) {
    return channelMap(() => defaultAutosyncConfig());
  }
  if (ver === 1) {
    // v1 迁移：顶层字段 → git 通道（webdav 缺省；首次按 v2 写回时持久化）
    return channelMap((ch) => (ch === 'git' ? parseV1Channel(obj) : defaultAutosyncConfig()));
  }
  const channels = obj['channels'];
  const ch = channels !== null && typeof channels === 'object' && !Array.isArray(channels)
    ? channels as Record<string, unknown>
    : {};
  return channelMap((channel) => parseV2Channel(ch[channel]));
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
  const channels = channelMap((ch) => (ch === channel ? cfg : existing[ch]));
  const payload: Record<string, unknown> = {
    schemaVersion: AUTOSYNC_CONFIG_SCHEMA_VERSION,
    channels: channelMap((ch) => toChannelPayload(channels[ch])),
  };
  const target = path.join(dir, AUTOSYNC_CONFIG_FILE);
  const data = stringifyJsonSafe(payload, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}

/**
 * 可展示的「本轮失败原因」（issue #105）。
 *
 * 判据只有一条：**本轮状态真的是 failed**，才允许把 lastRunMessage 当成错误文案回传。
 * 此前状态路由无条件回传 lastRunMessage，而 POST /sync/autosync 又会把读到的旧配置原样
 * 写回 —— 于是「十天前那次失败的错误原文」会被一次纯粹改间隔的保存坐实，卡片上继续挂着
 * 早已不成立的错误，用户据此去查一个不存在的故障（真机现场：认证已修好，界面仍报认证失败）。
 *
 * 返回 undefined = 界面不得渲染任何 lastRunMessage 单元格。
 */
export function lastRunFailureMessage(cfg: Pick<AutosyncConfig, 'lastRunStatus' | 'lastRunMessage'>): string | undefined {
  if (cfg.lastRunStatus !== 'failed') return undefined;
  const message = cfg.lastRunMessage;
  return message === undefined || message === '' ? undefined : message;
}

/**
 * 清空「上一轮运行结果」三字段（issue #105：配置变更 ≠ 一轮运行结果）。
 *
 * POST /sync/autosync 是**配置**写入而不是运行，写完必须把上一轮的结论清掉，否则旧结论
 * 会被当成当前结论继续展示。保留 lastRunAt/lastRunStatus 与连续失败计数：它们描述的是
 * 「上一次真的跑过什么」，不会因为改了间隔就变成假话。
 */
export function clearLastRunResult(cfg: AutosyncConfig): AutosyncConfig {
  const next: AutosyncConfig = { ...cfg };
  delete next.lastRunMessage;
  delete next.lastRunSkipReason;
  delete next.lastRunSkipCount;
  return next;
}

/**
 * 勾选「自动同步」后是否该立刻跑一轮（issue #105 建议 4）。
 *
 * 三种情况返回 false：
 *  - 本来就已经开着：这次 POST 只是改间隔 / 调阈值，不是「打开」动作；
 *  - 打开后仍在 startupMinIntervalMs 冷却窗口内：刚跑过，别连点把通道打爆；
 *  - 这次是把开关关掉：关掉当然不跑。
 * `lastRunAt` 缺失或读不出（NaN）→ 当作「很久没跑过」，该跑。
 *
 * 判据与 `autosync-scheduler.ts` 的 `shouldTriggerStartupRun` 一致；这里不能直接 import 它
 * —— 调度器依赖本模块，反向引用会成环。
 */
export function shouldRunOnEnable(
  prev: Pick<AutosyncConfig, 'enabled'>,
  next: Pick<AutosyncConfig, 'enabled' | 'lastRunAt' | 'startupMinIntervalMs'>,
  nowMs: number = Date.now(),
): boolean {
  if (!next.enabled || prev.enabled) return false
  const lastRunAt = next.lastRunAt
  if (lastRunAt === undefined || lastRunAt === '') return true
  const lastMs = Date.parse(lastRunAt)
  if (Number.isNaN(lastMs)) return true
  return nowMs - lastMs >= next.startupMinIntervalMs
}

/** AutosyncConfig → 文件载荷（可选运行字段仅在非空时写入，保持文件干净）。 */
function toChannelPayload(cfg: AutosyncConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    enabled: cfg.enabled,
    interval: cfg.interval,
    startupMinIntervalMs: cfg.startupMinIntervalMs,
    consecutiveFailures: cfg.consecutiveFailures,
    realtime: cfg.realtime ?? DEFAULT_AUTOSYNC_REALTIME,
    remoteCheckMs: clampRemoteCheckMs(cfg.remoteCheckMs ?? DEFAULT_AUTOSYNC_REMOTE_CHECK_MS),
    autoApplyTier: cfg.autoApplyTier ?? DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
    conflictPolicy: cfg.conflictPolicy ?? DEFAULT_AUTOSYNC_CONFLICT_POLICY,
  };
  if (cfg.lastRunAt !== undefined && cfg.lastRunAt !== '') payload['lastRunAt'] = cfg.lastRunAt;
  if (cfg.lastRunStatus !== undefined) payload['lastRunStatus'] = cfg.lastRunStatus;
  if (cfg.lastRunMessage !== undefined && cfg.lastRunMessage !== '') payload['lastRunMessage'] = cfg.lastRunMessage;
  // 空串/undefined 一律不写 → 本轮成功时，上一轮的跳过码/旧消息在文件里被真正清掉（issue #79）
  if (cfg.lastRunSkipReason !== undefined && cfg.lastRunSkipReason !== '') payload['lastRunSkipReason'] = cfg.lastRunSkipReason;
  if (cfg.lastRunSkipCount !== undefined) payload['lastRunSkipCount'] = cfg.lastRunSkipCount;
  if (cfg.lastRunHistoryId !== undefined && cfg.lastRunHistoryId !== '') payload['lastRunHistoryId'] = cfg.lastRunHistoryId;
  return payload;
}

function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h';
}
