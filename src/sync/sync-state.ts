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

export const SYNC_STATE_SCHEMA_VERSION = 3;
/**
 * 历史可读取版本（均在内存中迁移到当前版本，不就地改写磁盘）：
 * - v1：缺 lastSnapshotId → lastSnapshotId=''（无祖先指针）；
 * - v2：lastSnapshotId **混用**了「远端快照 id」与「本地祖先副本目录名」两种语义（P0-7）→
 *   原值同时补进 ancestorId，两边都不丢（v2 无法事后区分该值来自 push 还是 merge/apply）；
 * - v3：lastSnapshotId 只表示远端快照 id，ancestorId 只表示本地祖先副本目录名。
 */
export const SYNC_STATE_SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3];
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
  /** 最近一次同步对应的**远端**快照 id（= 共同祖先在远端的指针）；'' = 从未同步 / 远端 id 未知 */
  lastSnapshotId: string;
  /**
   * 本地祖先副本目录名（localSnapshotsDir 下的目录名）；'' = 无本地祖先副本。
   *
   * 与 lastSnapshotId 是**两种不同语义**（P0-7），不可混用：混用会让三方合并去 load 一个并不
   * 存在的目录（加密快照 push 不落明文副本、副本还会被 pruneAncestors 裁剪），从而把整轮自动
   * 同步打成 failed 并每轮复现。可选字段：旧调用点/旧文件缺省视为 ''（loadSyncState 恒填充）。
   */
  ancestorId?: string;
  /**
   * P1-5：上一次成功推送**实际带走**的会话单元 id。
   *
   * 与「本机现存集合」相减 = 用户删掉的对话（详见 sync/session-tombstones.ts）。
   * 缺省/空数组 = 无记录 → 本轮不做删除检测（**绝不**把「没记录」当成「全删了」）。
   */
  sessionUnits?: string[];
  /**
   * P1-5：累积的会话删除墓碑（随每次 push 的 manifest 传播；上限见 MAX_SESSION_TOMBSTONES）。
   * 本机若又出现该会话的实体，对应墓碑会被撤销（有实体 = 没删）。
   */
  deletedSessions?: string[];
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

/** P1-5：读取「字符串数组」字段（非数组/元素非字符串一律丢弃；空数组视为无记录）。 */
function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 读取同步状态；文件不存在 → 返回缺省空状态（从未同步）。
 * 旧版本文件（v1/v2）→ 在内存中迁移到当前版本（见 SYNC_STATE_SUPPORTED_VERSIONS），
 * 不在磁盘上就地升级（首次 saveSyncState 时才写回新版本）。 */
export async function loadSyncState(dir: string, fsx: SnapshotFs = createSnapshotFs(), msg: MsgFunc = zhMsg): Promise<SyncState> {
  const file = joinFs(dir, SYNC_STATE_FILE);
  if (!(await fsx.exists(file))) {
    return { schemaVersion: SYNC_STATE_SCHEMA_VERSION, lastSyncAt: '', sections: {}, lastSnapshotId: '', ancestorId: '' };
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
  const fileVersion = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : SYNC_STATE_SCHEMA_VERSION;
  const rawLastSnapshotId = typeof obj['lastSnapshotId'] === 'string' ? obj['lastSnapshotId'] : '';
  const rawAncestorId = typeof obj['ancestorId'] === 'string' ? obj['ancestorId'] : undefined;
  const state: SyncState = {
    schemaVersion: SYNC_STATE_SCHEMA_VERSION,
    lastSyncAt: obj['lastSyncAt'],
    // P1-5：只有文件里确实写过才回填 —— 缺席 = 「从未跟踪」（区别于「跟踪了但为空」），
    // 也让既有 v3 文件的读回形状逐键不变（旧调用方/旧测试零感知）。
    ...(Array.isArray(obj['sessionUnits']) ? { sessionUnits: readStringArray(obj['sessionUnits']) } : {}),
    ...(Array.isArray(obj['deletedSessions']) ? { deletedSessions: readStringArray(obj['deletedSessions']) } : {}),
    sections,
    // v2 及更早：lastSnapshotId 混用两种语义 → 原值同时当作本地祖先副本目录名（迁移不丢既有基线）。
    // 非字符串的 ancestorId（损坏/被篡改）按「无本地祖先副本」处理：merge 退化为两方合并（安全侧），
    // 绝不采用一个来路不明的目录名。
    ancestorId: rawAncestorId ?? (fileVersion < SYNC_STATE_SCHEMA_VERSION ? rawLastSnapshotId : ''),
    lastSnapshotId: rawLastSnapshotId,
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
