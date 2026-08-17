/**
 * m-sync-transport：sync-state.json 模型。
 * 记录上次同步时间与各分区内容 hash，供变更检测（与远端快照对比决定是否重传）。
 * 纯逻辑 + 可注入 fs；不触碰真实 ~/.dsh。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection, SectionData, SectionId } from '../schema/types.ts';
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';

export const SYNC_STATE_SCHEMA_VERSION = 2;
/** 历史可读取版本：v1 缺 lastSnapshotId 时做内存迁移到 v2（lastSnapshotId=''）。 */
export const SYNC_STATE_SUPPORTED_VERSIONS: readonly number[] = [1, 2];
export const SYNC_STATE_FILE = 'sync-state.json';

/** 单个分区的同步状态：内容 hash + 最近变更时间 */
export interface SyncSectionState {
  hash: string;
  updatedAt: string; // ISO-8601 UTC
}

/** sync-state.json 结构 */
export interface SyncState {
  schemaVersion: number;
  lastSyncAt: string; // ISO-8601 UTC；'' = 从未同步
  sections: Partial<Record<SectionId, SyncSectionState>>;
  /** 当前绑定的传输通道（type = SyncTransport.type，ref = 通道内引用，如 git 分支） */
  transport?: { type: string; ref: string };
  /** 最近一次同步的快照 ID（= 共同祖先指针）；'' = 从未同步或无祖先 */
  lastSnapshotId: string;
}

/** 文件类分区判定：{ version: 1, files: [...] }（duck-typing，与 JSON 分区区分） */
function isFilesSection(data: SectionData): data is FilesSection {
  const obj = data as { version?: unknown; files?: unknown };
  return data !== null && typeof data === 'object' && obj.version === 1 && Array.isArray(obj.files);
}

/** 键序规范化的 JSON 序列化（跨机器/跨解析稳定，用于内容 hash） */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null'; // 防御：不产生 undefined 字面量
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // 与 JSON.stringify 一致：跳过 undefined 键
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 分区内容 hash：
 * - JSON 分区：键序规范化的 JSON 序列化 → SHA-256（同一内容不同键序 → 相同 hash）
 * - 文件类分区：文件相对路径 + 文件字节 SHA-256 的有序清单 → SHA-256
 *   （文件数组顺序无关；contentHash 字段不参与，以字节为准）
 */
export function hashSection(data: SectionData): string {
  if (isFilesSection(data)) {
    const files = [...data.files]
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
      .map((f) => `${f.relativePath}\u0000${sha256Hex(f.data)}`)
      .join('\u0001');
    return sha256Hex(`files:v1\u0000${files}`);
  }
  return sha256Hex(canonicalJson(data));
}

/** 读取同步状态；文件不存在 → 返回缺省空状态（从未同步）。
 * v1 文件 → 内存迁移到 v2（lastSnapshotId=''），不在磁盘上就地升级。 */
export async function loadSyncState(dir: string, fsx: SnapshotFs = createSnapshotFs(), msg: MsgFunc = zhMsg): Promise<SyncState> {
  const file = joinFs(dir, SYNC_STATE_FILE);
  if (!(await fsx.exists(file))) {
    return { schemaVersion: SYNC_STATE_SCHEMA_VERSION, lastSyncAt: '', sections: {}, lastSnapshotId: '' };
  }
  const raw = Buffer.from(await fsx.readFile(file)).toString('utf8');
  const parsed = parseJsonSafe(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(msg('sync.state.notObject'));
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['schemaVersion'] !== 'number' || !SYNC_STATE_SUPPORTED_VERSIONS.includes(obj['schemaVersion'])) {
    throw new Error(msg('sync.state.schemaUnsupported', { version: String(obj['schemaVersion']), expected: String(SYNC_STATE_SUPPORTED_VERSIONS.join('/')) }));
  }
  if (typeof obj['lastSyncAt'] !== 'string') {
    throw new Error(msg('sync.state.lastSyncAt'));
  }
  if (obj['sections'] === null || typeof obj['sections'] !== 'object' || Array.isArray(obj['sections'])) {
    throw new Error(msg('sync.state.sections'));
  }
  const sections: SyncState['sections'] = {};
  for (const [sid, rec] of Object.entries(obj['sections'] as Record<string, unknown>)) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error(msg('sync.state.sectionRecord', { section: sid }));
    }
    const r = rec as Record<string, unknown>;
    if (typeof r['hash'] !== 'string' || typeof r['updatedAt'] !== 'string') {
      throw new Error(msg('sync.state.sectionFields', { section: sid }));
    }
    sections[sid as SectionId] = { hash: r['hash'], updatedAt: r['updatedAt'] };
  }
  const state: SyncState = {
    schemaVersion: SYNC_STATE_SCHEMA_VERSION,
    lastSyncAt: obj['lastSyncAt'],
    sections,
    lastSnapshotId: typeof obj['lastSnapshotId'] === 'string' ? obj['lastSnapshotId'] : '',
  };
  const t = obj['transport'];
  if (t !== undefined) {
    if (t === null || typeof t !== 'object' || typeof (t as Record<string, unknown>)['type'] !== 'string' || typeof (t as Record<string, unknown>)['ref'] !== 'string') {
      throw new Error(msg('sync.state.transport'));
    }
    state.transport = { type: (t as { type: string }).type, ref: (t as { ref: string }).ref };
  }
  return state;
}

/** 保存同步状态（自动创建目录） */
export async function saveSyncState(dir: string, state: SyncState, fsx: SnapshotFs = createSnapshotFs()): Promise<void> {
  await fsx.mkdir(dir);
  await fsx.writeFile(joinFs(dir, SYNC_STATE_FILE), new TextEncoder().encode(stringifyJsonSafe(state, { space: 2 })));
}
