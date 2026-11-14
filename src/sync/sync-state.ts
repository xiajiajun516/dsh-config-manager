/**
 * m-sync-transport：sync-state.json 模型。
 * 记录上次同步时间与各分区内容 hash，供变更检测（与远端快照对比决定是否重传）。
 * 纯逻辑 + 可注入 fs；不触碰真实 ~/.dsh。
 */
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../utils/hashing.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection, SectionData, SectionId } from '../schema/types.ts';
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
// 侧效应导入：注册同步域追加消息目录（sync.deviceNameFallback 等 ⑥ 新键必须能解析，绝不露裸键名）
import './messages.ts';

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

/**
 * 分区 id → 内容哈希（= hashSection 的结果）。
 *
 * 同一个形状服务两种**完全不同**的观测，调用方必须分清（G-44：
 * docs/known-issues/known-gaps.md 的「祖先副本与 state.sections 一参两用」）：
 * - `SyncState.sections`：**本机**文件最近一次基线的内容哈希（含本机尚未推送的改动）；
 * - `SyncState.lastRemoteSections`：上一次**远端快照实际携带**的分区哈希（远端观测）；
 * - 推送前刚导出的本地哈希（content-diff.hashSections）。
 * 内容判定（src/sync/content-diff.ts）只接受后两者，绝不拿 state.sections 冒充远端观测。
 */
export type SectionHashes = Partial<Record<SectionId, string>>;

/**
 * 待裁决的合并状态（基线纪律，2026-10）。
 *
 * 非空 = 上一次三方合并**仍有未裁决的冲突**，因此 lastSnapshotId 刻意**不推进**：
 * 远端的最新快照下一轮仍会被当作「比基线新」而重新合并，冲突因此重新出现，直到用户裁决完。
 * 若在冲突未裁决时就推进基线，冲突内容会在下一轮静默消失（远端那一版改动永远不再被讨论）。
 *
 * 纯可选字段：**不提升 SYNC_STATE_SCHEMA_VERSION**（旧文件缺该字段 → 读取形状逐键不变；
 * 旧版本代码读到新文件也只是忽略它）。
 */
export interface PendingMerge {
  /** 冲突所针对的**远端**快照 id（基线指针此刻仍停在更早的那一个）。 */
  remoteSnapshotId: string;
  /** 仍未裁决的分区 id（非空；空 = 没有待裁决内容，调用方应清除该字段）。 */
  sections: SectionId[];
  /** 该待裁决状态**首次**出现的时刻（ISO-8601 UTC；跨轮保留首次时间，便于界面讲「挂了多久」）。 */
  since: string;
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
  /**
   * cloud-sync 借鉴项 ⑥：本设备的**稳定**同步身份（首次推送时生成并持久化）。
   *
   * deviceId = 随机 UUID（换主机名/改机器名都不变，历史列表据此认出「同一台设备」）；
   * deviceName = 人类可读名（缺省取主机名）。缺省 = 旧文件 / 从未推送（不猜）。
   */
  deviceId?: string;
  deviceName?: string;
  /**
   * 基线纪律（2026-10）：未裁决冲突记录。非空 = 基线指针**刻意停在旧值**，
   * 让冲突在下一轮重新出现（详见 PendingMerge）。
   */
  pendingMerge?: PendingMerge;
  /**
   * issue #140：上一次**远端快照实际携带**的分区哈希（远端观测，不是本机观测）。
   *
   * 用途：拉取侧判定「远端最新快照的内容是否真的变了」——只比 id 时，任何一次新推送
   * （哪怕分区逐字相同）都会判成「有新生」，白跑 download + 三方合并。
   *
   * 纪律（G-44）：
   * - 只许由「真的看到了远端快照 sections」的路径写入（推送成功 / 推送跳过收养 / 收养孤儿头 /
   *   合并应用到某个远端快照之后）；
   * - 指针变化但本轮没有远端观测 ⇒ 必须**删除**该字段（未知 ⇒ 调用方回落 id 比较），
   *   绝不保留上一份观测冒充「远端现在也是这样」；
   * - 加密快照的 sections 恒为空（transport.ts）⇒ 该字段保持缺席，判定恒为 unknown。
   *
   * 纯可选字段：**不提升 SYNC_STATE_SCHEMA_VERSION**（旧文件缺它 → 读回形状逐键不变；
   * 旧版本代码读到新文件只是忽略它）。
   */
  lastRemoteSections?: SectionHashes;
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

/**
 * 读取可选 pendingMerge（基线纪律）。
 *
 * 形状不符（损坏/被篡改/分区清单为空）→ undefined = 按「无待裁决冲突」处理：
 * 这里**绝不抛错**（一个诊断字段不该让 loadSyncState 整体失败），也绝不把空清单当成
 * 「所有冲突都解决了」—— 空清单只是没有内容可记录。
 */
function readPendingMerge(raw: unknown): PendingMerge | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o['remoteSnapshotId'] !== 'string' || typeof o['since'] !== 'string') return undefined;
  const sections = readStringArray(o['sections']);
  if (sections.length === 0) return undefined;
  return { remoteSnapshotId: o['remoteSnapshotId'], sections: sections as SectionId[], since: o['since'] };
}

/**
 * 读取「远端观测」（分区 id → hash）。
 *
 * 形状不符（损坏/被篡改）或为空对象 → undefined：空集合无法证伪任何内容，
 * 按「没有观测」处理（调用方回落到 id 比较），绝不把空对象当成「远端什么都没有」。
 */
function readSectionHashes(raw: unknown): SectionHashes | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: SectionHashes = {};
  for (const [sid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out[sid as SectionId] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    // ⑥：只有文件里确实写过才回填（缺席 = 从未记录 → 下次推送才生成，绝不在这里凭空造一个 id）
    ...(typeof obj['deviceId'] === 'string' && obj['deviceId'] !== '' ? { deviceId: obj['deviceId'] } : {}),
    ...(typeof obj['deviceName'] === 'string' && obj['deviceName'] !== '' ? { deviceName: obj['deviceName'] } : {}),
    // 基线纪律：同样「写过才回填」—— 缺席 = 无待裁决冲突（旧文件读回形状逐键不变）
    ...(readPendingMerge(obj['pendingMerge']) !== undefined ? { pendingMerge: readPendingMerge(obj['pendingMerge'])! } : {}),
    // issue #140：远端观测同样「写过才回填」—— 缺席/空 = 未知（判定层回落 id 比较）
    ...(readSectionHashes(obj['lastRemoteSections']) !== undefined
      ? { lastRemoteSections: readSectionHashes(obj['lastRemoteSections'])! }
      : {}),
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

/**
 * 解析（必要时生成并持久化）本设备的同步身份（cloud-sync 借鉴项 ⑥）。
 *
 * - deviceId 一旦生成就持久化在 sync-state.json → 历史列表能认出「同一台设备」；
 * - deviceName 缺省取主机名，取不到（容器/无主机名）时用字典里的兜底文案，绝不写空串；
 * - **只在首次生成时写盘**（已有 id → 纯读，不产生额外写）。
 */
export async function resolveDeviceIdentity(
  dir: string,
  hostName: string,
  fsx: SnapshotFs = createSnapshotFs(),
  msg: MsgFunc = zhMsg,
): Promise<{ id: string; name: string }> {
  const state = await loadSyncState(dir, fsx, msg);
  const trimmedHost = typeof hostName === 'string' ? hostName.trim() : '';
  const name = (typeof state.deviceName === 'string' && state.deviceName !== '' ? state.deviceName : '')
    || (trimmedHost !== '' ? trimmedHost : msg('sync.deviceNameFallback'));
  if (typeof state.deviceId === 'string' && state.deviceId !== '') return { id: state.deviceId, name };
  const id = randomUUID();
  await saveSyncState(dir, { ...state, deviceId: id, deviceName: name }, fsx);
  return { id, name };
}

/** 保存同步状态（自动创建目录） */
export async function saveSyncState(dir: string, state: SyncState, fsx: SnapshotFs = createSnapshotFs()): Promise<void> {
  await fsx.mkdir(dir);
  await fsx.writeFile(joinFs(dir, SYNC_STATE_FILE), new TextEncoder().encode(stringifyJsonSafe(state, { space: 2 })));
}
