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
 * 字段 { schemaVersion, lastSyncChannel?: 'git' | 'webdav',
 *         starPromptFirstSeenAt?: number, starPromptDismissed?: boolean,
 *         starPromptClicked?: boolean }：
 * - 缺省/未配置 = undefined（UI 回退到 sync-config.transport / 首次进入页面）；
 * - 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省；
 * - 多端点共写同一文件：一律经 updateUiPrefs（read → merge → write）原子更新，
 *   避免「sync/ui-prefs 写 lastSyncChannel」与「star-prompt 写弹窗状态」互相覆盖。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

export const UI_PREFS_FILE = 'ui-prefs.json';
export const UI_PREFS_SCHEMA_VERSION = 1;

/** 同步通道类型（与 sync-selection / sync-config 共享语义；避免循环 import 自行声明） */
export type UiPrefsChannel = 'git' | 'webdav';

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
  if (obj['lastSyncChannel'] === 'git' || obj['lastSyncChannel'] === 'webdav') {
    prefs.lastSyncChannel = obj['lastSyncChannel'];
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
  return prefs;
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
  };
  const target = path.join(dir, UI_PREFS_FILE);
  const tmp = path.join(
    dir,
    `.${UI_PREFS_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
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
