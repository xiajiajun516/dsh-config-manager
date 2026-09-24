/**
 * m-sync-selection：远程同步分区选择持久化（sync-selection.json）。
 *
 * 与 sync-config.json / sync-autosync.json 并列独立文件：语义清楚、schema 演进独立。
 * schemaVersion:2 —— 按同步通道拆分（git / webdav 各自独立的模式与分区勾选）：
 * ```
 * { "schemaVersion": 2,
 *   "channels": {
 *     "git":    { mode: 'default'|'advanced', sections: SectionId[], sessionsLimit, encrypt, includeSecrets },
 *     "webdav": { ... } } }
 * ```
 * - mode='default'（快速导出）：推送/自动同步使用全部 portable 推荐分区（sections 可空）；
 * - mode='advanced'（自定义导出）：推送/自动同步只处理勾选的 sections（非 portable 由
 *   SyncEngine portableAdapters 过滤兜底；空 sections 回退全量，避免自动同步卡死）。
 * v1（顶层单通道）→ 读取时归一为 v2 的 git 通道（webdav 回退缺省）。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（mode='default', sections=[]）。
 * 持久化原因：自动同步调度器运行于 Host 进程（浏览器关闭也在跑），必须从磁盘读
 * 用户选择，而不是依赖浏览器 localStorage。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SectionId } from '../schema/types.ts';
import { channelMap } from './sync-config.ts';
import type { SyncTransportType } from './sync-config.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const SYNC_SELECTION_FILE = 'sync-selection.json';
export const SYNC_SELECTION_SCHEMA_VERSION = 2;

/** 远程同步分区选择模式：default = 快速导出（全量推荐分区）；advanced = 自定义勾选。 */
export type SyncSelectionMode = 'default' | 'advanced';

/** 远程同步分区选择（持久化面；单通道）。 */
export interface SyncSelection {
  schemaVersion: number;
  mode: SyncSelectionMode;
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
  /**
   * sessions（历史会话）分区同步的「最新 N 个会话」上限。
   * 仅在 sections 里显式勾选 sessions 时生效；缺省 5（见 DEFAULT_SYNC_SESSIONS_LIMIT）。
   * 0 = 勾了但不带任何会话；负数非法（读盘时按缺省处理）。
   */
  sessionsLimit: number;
  /**
   * 显式勾选的会话单元 id（形如 sessions:<projectKey>/<sessionId>；空数组 = 用
   * sessionsLimit 的「最新 N 个」）。
   *
   * 为什么必须有它：sessionsLimit 只能说「最新几条」，用户无法点名要哪几次对话，也无法
   * 把某次敏感对话排除在外（同步页补齐导出页早已有的逐会话勾选）。**非空时优先于
   * sessionsLimit** —— 见 SyncPushOptions.sessions.include 的语义说明。
   */
  sessionsInclude: string[];
  /** 手动推送默认加密快照（开关持久化；密码本体存 DSH credentials，见 sync/selection 路由） */
  encrypt: boolean;
  /** 手动推送默认导出真实凭据值（安全：必须同时 encrypt；自动同步恒 false） */
  includeSecrets: boolean;
}

/** 全通道选择视图（v2 文件直接读取；status 路由一次返回两个通道的选择）。 */
export type SyncSelectionByChannel = Record<SyncTransportType, SyncSelection>;

/**
 * 显式勾选才允许进入同步通道的「可选分区」（缺省全为 deviceSpecific，不在推荐分区里）。
 *
 * 目前只有 sessions（历史会话）：内容敏感 + 设备相关，**绝不默认进入同步通道**，
 * 只有用户在同步分区弹窗里显式勾选才纳入；且必须带数量上限（见 DEFAULT_SYNC_SESSIONS_LIMIT），
 * 避免一次把整棵会话树推上远端。凭据 / 密钥分区不在此列（结构性拒绝，永不进同步）。
 */
export const OPT_IN_SYNC_SECTIONS: readonly SectionId[] = ['sessions'];

/** sessions 分区默认同步「最新 N 个会话」（用户可在弹窗里改；0 = 不带）。 */
export const DEFAULT_SYNC_SESSIONS_LIMIT = 5;

/** sessionsLimit 归一化：非整数 / 缺失 / 负数 → 默认值；超大 → 上限钳制。 */
export function normalizeSessionsLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return DEFAULT_SYNC_SESSIONS_LIMIT;
  return Math.min(value, 10000);
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultSyncSelection(): SyncSelection {
  return {
    schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
    mode: 'default',
    sections: [],
    sessionsLimit: DEFAULT_SYNC_SESSIONS_LIMIT,
    sessionsInclude: [],
    encrypt: false,
    includeSecrets: false,
  };
}

/**
 * sessionsInclude 归一化：非数组 → []；元素必须是非空字符串；按首次出现去重保序；
 * 上限 5000 条（防止被篡改的持久化文件把 UI/请求体撑爆）。
 *
 * 只做形状归一化，不校验单元是否真实存在 —— 清单是执行期的输入，勾选是计划期的意图，
 * 会话可能在两次同步之间被本机删掉（此时 adapter 的 includeItems 白名单自然匹配不到它，
 * 结果是「少带一次对话」而不是报错）。
 */
export function normalizeSessionsInclude(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item === '') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= 5000) break;
  }
  return out;
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

/** 从单通道对象解析（v1 顶层或 v2 channels 命名空间共用；非法字段回退缺省）。 */
function parseChannelSelection(obj: Record<string, unknown>): SyncSelection {
  const sel = defaultSyncSelection();
  if (obj['mode'] === 'advanced' || obj['mode'] === 'default') sel.mode = obj['mode'];
  if (Array.isArray(obj['sections'])) {
    sel.sections = obj['sections'].filter(
      (s): s is SectionId => typeof s === 'string' && s !== '',
    );
  }
  sel.sessionsLimit = normalizeSessionsLimit(obj['sessionsLimit']);
  sel.sessionsInclude = normalizeSessionsInclude(obj['sessionsInclude']);
  if (typeof obj['encrypt'] === 'boolean') sel.encrypt = obj['encrypt'];
  if (typeof obj['includeSecrets'] === 'boolean') sel.includeSecrets = obj['includeSecrets'];
  // 安全兜底：持久化数据被篡改导致 includeSecrets 但未 encrypt → 强制关掉导出密钥
  if (sel.includeSecrets && !sel.encrypt) sel.includeSecrets = false;
  return sel;
}

/** 读取全部通道的分区选择配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readAllSyncSelections(dir: string): Promise<SyncSelectionByChannel> {
  const file = path.join(dir, SYNC_SELECTION_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return channelMap(() => defaultSyncSelection());
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return channelMap(() => defaultSyncSelection());
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return channelMap(() => defaultSyncSelection());
  }
  const obj = parsed as Record<string, unknown>;
  // schemaVersion：缺省视为 v1；非缺省但 != 2 → 回退缺省
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (ver !== 1 && ver !== SYNC_SELECTION_SCHEMA_VERSION) {
    return channelMap(() => defaultSyncSelection());
  }
  if (ver === 1) {
    // v1 迁移：顶层字段 → git 通道（webdav 缺省；首次按 v2 写回时持久化）
    return channelMap((ch) => (ch === 'git' ? parseChannelSelection(obj) : defaultSyncSelection()));
  }
  const channels = obj['channels'];
  const ch = channels !== null && typeof channels === 'object' && !Array.isArray(channels)
    ? channels as Record<string, unknown>
    : {};
  return channelMap((channel) => {
    const ns = ch[channel];
    return ns !== null && typeof ns === 'object' && !Array.isArray(ns)
      ? parseChannelSelection(ns as Record<string, unknown>)
      : defaultSyncSelection();
  });
}

/** 读取指定通道的分区选择配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readSyncSelection(dir: string, channel: SyncTransportType): Promise<SyncSelection> {
  const all = await readAllSyncSelections(dir);
  return all[channel];
}

/** 写入指定通道的分区选择配置（原子写：临时文件 + rename；保留另一通道；自动创建目录）。 */
export async function writeSyncSelection(dir: string, channel: SyncTransportType, sel: SyncSelection): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await readAllSyncSelections(dir);
  const channels = channelMap((ch) => (ch === channel ? sel : existing[ch]));
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
    channels: channelMap((ch) => ({
      mode: channels[ch].mode,
      sections: channels[ch].sections,
      sessionsLimit: channels[ch].sessionsLimit,
      // P0-3：显式点名的会话单元（空数组 = 「最新 N 个」模式）—— 落盘白名单必须含它，
      // 否则写回时被静默丢掉（读回永远是空 = 用户点名白点了）
      sessionsInclude: channels[ch].sessionsInclude,
      encrypt: channels[ch].encrypt,
      includeSecrets: channels[ch].includeSecrets,
    })),
  };
  const target = path.join(dir, SYNC_SELECTION_FILE);
  const data = stringifyJsonSafe(payload, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}
