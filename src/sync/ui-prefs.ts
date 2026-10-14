/**
 * m-self：插件自身 UI 偏好持久化（ui-prefs.json）。
 *
 * 与 sync-config.json / sync-selection.json 并列独立文件：语义清楚、schema 演进独立。
 * 当前存 lastSyncChannel（用户上次选择的同步通道 git/webdav）+ Star 引导弹窗状态
 * （starPromptFirstSeenAt / starPromptDismissed / starPromptClicked，见 src/ui/star-prompt.ts）。
 *
 * 背景（self 分区设计）：此前该偏好只存浏览器 localStorage（键
 * dsh.configManager.syncChannel），换浏览器/换机器即丢失，且 Host 进程读不到
 * （自动同步在浏览器关闭时也运行）。迁移到磁盘后：
 *  - Host 侧可读可写（status 响应回填、POST /sync/ui-prefs 保存）；
 *  - 随 self 分区进入导出备份，迁移到新机器时恢复；
 *  - localStorage 仅保留为前端同步读取的降级通道（status 未带回填时的兜底）。
 *
 * 字段 { schemaVersion, lastSyncChannel?: SyncTransportType（git / webdav）,
 *         starPromptFirstSeenAt?: number, starPromptDismissed?: boolean,
 *         starPromptClicked?: boolean }：
 * - 缺省/未配置 = undefined（UI 回退到 sync-config.transport / 首次进入页面）；
 * - 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省；
 * - 多端点共写同一文件：一律经 updateUiPrefs（read → merge → write）原子更新，
 *   避免「sync/ui-prefs 写 lastSyncChannel」与「star-prompt 写弹窗状态」互相覆盖。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { parseSyncChannel } from './sync-config.ts';
import type { SyncTransportType } from './sync-config.ts';
import type { SessionFormatDisposition } from '../core/types.ts';

export const UI_PREFS_FILE = 'ui-prefs.json';
export const UI_PREFS_SCHEMA_VERSION = 1;

/** 同步通道类型：**唯一来源** = sync-config 的 SYNC_CHANNELS（type-only 引用，无运行期耦合，
 *  也不会与 sync-config 形成循环 import）。 */
export type UiPrefsChannel = SyncTransportType;

/** 插件自身 UI 偏好（持久化面）。 */
export interface UiPrefs {
  schemaVersion: number;
  /** 用户上次选择的同步通道；未配置为 undefined */
  lastSyncChannel?: UiPrefsChannel;
  /** Star 引导弹窗：首次进入页面时间（ms 时间戳）；未配置 = 尚未进入过页面 */
  starPromptFirstSeenAt?: number;
  /** Star 引导弹窗：用户点过「不再提示」（永久不再弹） */
  starPromptDismissed?: boolean;
  /** Star 引导弹窗：用户点过「去点 Star」（方案 A：引导完成，不再弹） */
  starPromptClicked?: boolean;
  /** 更新内容弹窗：上次已记录/展示过的插件版本号（如 '0.1.54'） */
  releaseNotesLastSeenVersion?: string;
  /** 更新内容弹窗：用户点过「永不提示」（永久不再自动弹出） */
  releaseNotesDismissed?: boolean;
  /**
   * 会话格式处置的**插件级缺省**（T1；缺省值见 ui/session-format-disposition.ts 的
   * DEFAULT_SESSION_FORMAT_DISPOSITION = 'abort'）。
   *
   * 语义：请求体没带 `sessionFormatDisposition` 时（第三方客户端 / 老客户端 / 脚本）
   * 宿主按这里的值处置；本插件自己的向导**总是**显式下发用户当前选择，所以这里只在
   * 「用户主动改配置」或「非本插件客户端」时起作用。
   */
  sessionFormatDisposition?: SessionFormatDisposition;
  /**
   * 回合自动留点（回滚点）总开关。**缺省 / 任何非 true 值 = 关闭**（issue #88 / #89：
   * 该功能与「配置备份 / 同步」是两件事，却随 bundle 默认启用且没有关闭入口；
   * 默认启用时账本每回合整份读改写，真机上把宿主拖到 V8 heap OOM）。
   *
   * 关闭语义（宿主侧 gate，见 src/core/rollback-gate.ts）：
   *  · 不订阅 `session/event`（不是「订阅了什么都不做」）；
   *  · 不留点、不写台账；
   *  · 聊天内的「↺ 回退」入口收起（不是置灰）。
   * 台账 / 回退路由本身仍可用：已有回滚点仍能查看、回退、删除、清理 —— 关的是「自动留点」。
   */
  rollbackEnabled?: boolean;
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultUiPrefs(): UiPrefs {
  return { schemaVersion: UI_PREFS_SCHEMA_VERSION };
}

/** 读取 UI 偏好；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readUiPrefs(dir: string): Promise<UiPrefs> {
  const file = path.join(dir, UI_PREFS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return defaultUiPrefs();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return defaultUiPrefs();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultUiPrefs();
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== undefined && obj['schemaVersion'] !== UI_PREFS_SCHEMA_VERSION) {
    return defaultUiPrefs();
  }
  if (obj['schemaVersion'] === undefined) {
    return defaultUiPrefs();
  }
  const prefs = defaultUiPrefs();
  // 通道合法性只认唯一枚举（SYNC_CHANNELS）：新增通道无需在此补字面量
  const lastChannel = parseSyncChannel(obj['lastSyncChannel']);
  if (lastChannel !== undefined) {
    prefs.lastSyncChannel = lastChannel;
  }
  if (typeof obj['starPromptFirstSeenAt'] === 'number' && Number.isFinite(obj['starPromptFirstSeenAt'])) {
    prefs.starPromptFirstSeenAt = obj['starPromptFirstSeenAt'];
  }
  if (obj['starPromptDismissed'] === true) {
    prefs.starPromptDismissed = true;
  }
  if (obj['starPromptClicked'] === true) {
    prefs.starPromptClicked = true;
  }
  if (typeof obj['releaseNotesLastSeenVersion'] === 'string' && obj['releaseNotesLastSeenVersion'].trim().length > 0) {
    prefs.releaseNotesLastSeenVersion = obj['releaseNotesLastSeenVersion'].trim();
  }
  if (obj['releaseNotesDismissed'] === true) {
    prefs.releaseNotesDismissed = true;
  }
  // 处置值只认三个字面量（与其他字段同姿态：非法值一律丢，绝不猜）
  const disposition = obj['sessionFormatDisposition'];
  if (disposition === 'abort' || disposition === 'skip' || disposition === 'guide') {
    prefs.sessionFormatDisposition = disposition;
  }
  // 开关只认字面 true：false / 缺省 / 形状不符一律 = 关闭（fail-closed，绝不猜用户想开）
  if (obj['rollbackEnabled'] === true) {
    prefs.rollbackEnabled = true;
  }
  return prefs;
}

/**
 * 同步读取「回滚点开关」（启动期专用）。
 *
 * 为什么必须有同步版本：宿主 `apply()` 是同步函数（`src/index.ts`），而开关必须在
 * **注册订阅之前**就定下来 —— 否则「关闭」只等于「订阅了什么都不做」，与 issue 要求的
 * 「关闭后不再订阅 `session/event`」不符。读一个几百字节的小文件，启动期一次，代价可忽略。
 *
 * 任何异常（不存在 / 损坏 / 形状不符）一律回 false = 关闭。
 */
export function readRollbackEnabledSync(dir: string): boolean {
  try {
    const raw = fsSync.readFileSync(path.join(dir, UI_PREFS_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    return obj['schemaVersion'] === UI_PREFS_SCHEMA_VERSION && obj['rollbackEnabled'] === true;
  } catch {
    return false;
  }
}

/** 写入 UI 偏好（原子写：临时文件 + rename；自动创建目录）。 */
export async function writeUiPrefs(dir: string, prefs: UiPrefs): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: UI_PREFS_SCHEMA_VERSION,
    ...(prefs.lastSyncChannel !== undefined ? { lastSyncChannel: prefs.lastSyncChannel } : {}),
    ...(prefs.starPromptFirstSeenAt !== undefined ? { starPromptFirstSeenAt: prefs.starPromptFirstSeenAt } : {}),
    ...(prefs.starPromptDismissed === true ? { starPromptDismissed: true } : {}),
    ...(prefs.starPromptClicked === true ? { starPromptClicked: true } : {}),
    ...(prefs.releaseNotesLastSeenVersion !== undefined ? { releaseNotesLastSeenVersion: prefs.releaseNotesLastSeenVersion } : {}),
    ...(prefs.releaseNotesDismissed === true ? { releaseNotesDismissed: true } : {}),
    ...(prefs.sessionFormatDisposition !== undefined ? { sessionFormatDisposition: prefs.sessionFormatDisposition } : {}),
    ...(prefs.rollbackEnabled === true ? { rollbackEnabled: true } : {}),
  };
  const target = path.join(dir, UI_PREFS_FILE);
  const data = stringifyJsonSafe(payload, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}

/**
 * 局部原子更新：read → merge → write。
 * 多端点共写 ui-prefs.json 时（sync/ui-prefs 与 star-prompt），任一端点写全量对象
 * 都会丢掉另一端点刚写入的字段；统一走本函数按补丁合并，杜绝互相覆盖。
 */
export async function updateUiPrefs(dir: string, patch: UiPrefsPatch): Promise<UiPrefs> {
  const current = await readUiPrefs(dir);
  const next: UiPrefs = { ...current, ...patch };
  await writeUiPrefs(dir, next);
  return next;
}

/** updateUiPrefs 的补丁类型（UiPrefs 全部可选字段，schemaVersion 不可补丁）。 */
export type UiPrefsPatch = Partial<Omit<UiPrefs, 'schemaVersion'>>;
