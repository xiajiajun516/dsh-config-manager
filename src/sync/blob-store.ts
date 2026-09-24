/**
 * m-blob-store：内容寻址的**大文件外置仓**（P1-4）。
 *
 * 问题：历史会话（sessions）是同步通道里唯一「大且多数 push 不变」的内容。此前每次 push
 * 都把选中的会话**整份字节**写进新快照 —— WebDAV 通道每次复制一遍（10 个快照 = 最多 10 份），
 * git 通道虽按 blob 去重，但工作树每次仍被整份重写。
 *
 * 方案：把这类分区的文件按 **sha256 内容哈希**存进通道根下的共享 blob 仓，快照里只留引用
 * （`<section>.blobs.json` / WebDAV 的 JSON 载荷里的 blobRefs）。内容没变 = 同一个哈希 =
 * 已在仓里 = 不再传输。快照保留策略裁剪快照时，无人引用的 blob 由 GC 回收。
 *
 * 兼容性（**这是对外格式变更**，必须同步 docs/spec）：
 *  - 外置只发生在**通道侧**：只有 transport 传了 BlobSink 才启用；引擎/导出/导入看到的
 *    仍是普通 FilesSection（含 data）。本地散文件副本、加密快照、加密载荷一律不外置。
 *  - 旧版插件读新格式：`<section>.blobs.json` 不是 FilesSection，旧版 layout 会当成
 *    「文件分区目录缺失」—— git 通道 missingFileDir='empty' 会降级为空分区（丢内容但不崩），
 *    WebDAV 通道 blobRefs 也认不出。因此 /sync/status 不下发版本协商，**跨版本混用不被支持**：
 *    两端插件版本应当一致（与既有「同步通道不做协议协商」的定位一致，见 docs/spec）。
 */
import type { FilesSection, SectionId } from '../schema/types.ts';
import { sha256Hex } from '../utils/hashing.ts';

/**
 * 走内容寻址外置的分区。
 *
 * 只放 sessions：它单文件可达数十 MB、且连续两次 push 的绝大多数会话字节完全相同，
 * 去重收益最大。skills / pluginFiles 这类分区的条目小且改动频繁，外置只会增加
 * 往返次数而无实际收益（故**不**放进来自动生效）。
 */
export const BLOB_SECTIONS: readonly SectionId[] = ['sessions'];

/** 单个外置文件的引用。 */
export interface BlobRef {
  /** 分区内的相对路径（与 FilesSection.files[].relativePath 同口径，**身份**不是配置） */
  relativePath: string;
  /** sha256（hex）内容哈希 = blob 仓里的键 */
  blobHash: string;
  /** 字节数（GC/报告用；不参与寻址） */
  sizeBytes: number;
}

/** 外置引用形态：替换 FilesSection 出现在快照载荷里（**没有** data 字段）。 */
export interface BlobRefsSection {
  version: 1;
  blobRefs: BlobRef[];
}

/** duck-typing：是不是外置引用形态（version===1 + blobRefs 数组）。 */
export function isBlobRefsSection(v: unknown): v is BlobRefsSection {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { version?: unknown; blobRefs?: unknown };
  return o.version === 1 && Array.isArray(o.blobRefs);
}

/** duck-typing：普通文件分区（version===1 + files 数组）。 */
export function isFilesSectionLike(v: unknown): v is FilesSection {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { version?: unknown; files?: unknown };
  return o.version === 1 && Array.isArray(o.files);
}

/** blob 仓端口：由各通道按自己的存储实现（本地目录 / WebDAV 集合）。 */
export interface BlobSink {
  /** 写入 blob（已存在则跳过）；实现必须按哈希幂等。 */
  put(hash: string, bytes: Uint8Array): Promise<void>;
  /** 读取 blob；不存在 → null（调用方必须据此**硬失败**，绝不静默降级为空分区）。 */
  get(hash: string): Promise<Uint8Array | null>;
  /** 删除 blob（不存在视为成功）。 */
  delete(hash: string): Promise<void>;
  /** 列出仓内全部 blob（GC 用；含写入时间，供保护窗口判定）。 */
  list(): Promise<{ hash: string; mtimeMs: number }[]>;
}

/** FilesSection → 外置引用形态（逐个写入 sink；内容不变则 sink 内部幂等跳过）。 */
export async function sectionToBlobRefs(section: FilesSection, sink: BlobSink): Promise<BlobRefsSection> {
  const blobRefs: BlobRef[] = [];
  for (const file of section.files) {
    const hash = file.contentHash !== undefined && file.contentHash !== ''
      ? file.contentHash
      : sha256Hex(file.data);
    await sink.put(hash, file.data);
    blobRefs.push({ relativePath: file.relativePath, blobHash: hash, sizeBytes: file.data.byteLength });
  }
  return { version: 1, blobRefs };
}

/**
 * 外置引用形态 → FilesSection（逐个取回字节）。
 *
 * 任一 blob 取不到 → **抛错**：那说明远端仓被清理坏/被手工删过。静默降级成空分区会
 * 让「同步成功但对话没了」重演（issue #45 的老问题形态），必须硬失败。
 */
export async function refsToSection(refs: BlobRefsSection, sink: BlobSink): Promise<FilesSection> {
  const files: FilesSection['files'] = [];
  for (const ref of refs.blobRefs) {
    const data = await sink.get(ref.blobHash);
    if (data === null) {
      throw new Error(`内容的 blob 缺失（${ref.blobHash}，${ref.relativePath}）：远端仓不完整，拒绝降级为空分区`);
    }
    files.push({ relativePath: ref.relativePath, data, contentHash: ref.blobHash });
  }
  return { version: 1, files };
}

/** 从快照载荷收集「被引用的全部 blob 哈希」（GC 用；只认外置形态）。 */
export function referencedBlobHashes(sectionData: unknown): Set<string> {
  const out = new Set<string>();
  if (!isBlobRefsSection(sectionData)) return out;
  for (const ref of sectionData.blobRefs) {
    if (typeof ref.blobHash === 'string' && ref.blobHash !== '') out.add(ref.blobHash);
  }
  return out;
}

/** GC 默认保护窗口：10 分钟内的新 blob 一律不删（避免与并发 push 竞态）。 */
export const BLOB_GC_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * 回收无人引用的 blob（best-effort）：
 *  - 只删「不在 referenced 集合里」且**写入时间早于保护窗口**的 blob；
 *  - 保护窗口是并发安全阀：另一台机器可能正在上传引用该 blob 的快照，删除会让它的下载硬失败；
 *  - 返回被删列表供上层写告警/日志（绝不静默）。
 */
export async function gcBlobs(opts: {
  sink: BlobSink;
  referenced: ReadonlySet<string>;
  nowMs: number;
  minAgeMs?: number;
}): Promise<string[]> {
  const minAgeMs = opts.minAgeMs ?? BLOB_GC_MIN_AGE_MS;
  const deleted: string[] = [];
  for (const { hash, mtimeMs } of await opts.sink.list()) {
    if (opts.referenced.has(hash)) continue;
    if (opts.nowMs - mtimeMs < minAgeMs) continue;
    await opts.sink.delete(hash);
    deleted.push(hash);
  }
  return deleted;
}
