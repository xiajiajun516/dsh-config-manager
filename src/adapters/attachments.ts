/**
 * attachments 分区 adapter（P1，默认关）：只带走**被对话真正引用过**的附件。
 *
 * 为什么不整目录搬：本机实测 `$DSH_HOME/attachments` 233 MB / 1374 个对象，其中 68 MB 是
 * 没有任何会话引用的**孤儿**（删除会话后留下的对象）。整库备份会把孤儿一起搬去新机，
 * 用户付出体积与拷贝时间却得不到任何可看的东西。
 *
 * 判据来源：会话日志里的 `"attachmentId":"sha256:<64hex>"`（见 `utils/attachment-refs.ts`）。
 * 只看**日志文本**，不看文件时间、不看最近使用 —— 「用过」是唯一可复现的口径。
 *
 * 收窄范围：`options.includeItems.sessions`（与 sessions adapter 同一份单元 id
 * `<projectKey>/<sessionId>`）：
 *  - 空数组（用户把会话分区清空）⇒ 本分区一条都不带并告警（与基类 allow 语义一致）；
 *  - 键缺省（没指定会话范围）⇒ 按**全部会话**算引用面，并如实告警，
 *    既不能静默当成「只用了选中会话」，也不能当成「没有附件」。
 * `export.sessions.limit`（最新 N 个）**不重复实现**：那是按 mtime 排序的选择，本分区
 * 不复刻排序规则，而是如实告警「按全部会话收集，未按最新 N 个收窄」——宁可多带。
 *
 * 失败方向：会话日志读不出来 / zstd 解不开 ⇒ **退回整库 + 明确告警**（keep=null）。
 * 宁可多带 233 MB，也不静默交出一个「备份成功但图片全丢」的包。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { listFilesDetailed } from './link-report.ts';
import { msgOf } from '../core/messages.ts';
import './messages.ts';
import { isSessionLogFileName, normalizeSessionLimit, sessionIdKey } from '../core/session-select.ts';
import { attachmentIdOfRelPath, extractAttachmentRefs, type AttachmentRefMeta } from '../utils/attachment-refs.ts';
import { decodeZstdFrame, scanZstdFrames, zstdAvailable } from '../utils/zstd-frame.ts';
import {
  loadAttachmentRefCache,
  saveAttachmentRefCache,
  type AttachmentRefCache,
} from './attachment-index-cache.ts';
import type { ExportOptions, ExportUnit, HostContext } from '../core/types.ts';
import { toPosixRel } from './units.ts';

/** 逐批并发读日志的批大小：会话库可能有上千个日志，一次性开满会打爆 libuv 线程池。 */
const READ_BATCH = 8;

/**
 * 附件单元的短展示名：`sha256:abcd1234…`。
 *
 * 64 位 hex 对用户没有信息量，但完全省略又会让「这张图和那张图」无法区分，
 * 所以只保留前 8 位 —— 足够在同一会话内分辨，又不至于把哈希塞满整行。
 */
function shortAttachmentId(ref: string): string {
  const hex = ref.startsWith('sha256:') ? ref.slice('sha256:'.length) : ref;
  return hex.length <= 8 ? ref : `sha256:${hex.slice(0, 8)}…`;
}

/** 前 4 字节是否为 zstd 帧魔数（小端 0x28 0xb5 0x2f 0xfd）。 */
function hasZstdMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

/**
 * 引用面扫描的短 TTL 缓存：导出预览与真实导出对同一批日志各扫一遍（本机实测 336 个日志 / 225 MB）。
 * 键 = 每个日志的「路径:mtime」；任何一条拿不到 mtime（宿主没暴露 mtimeMs / stat 失败）就整批不缓存 ——
 * 缓存必须能被证伪，宁可多读一遍，也不交出过期的引用面。
 */
/**
 * 引用面索引：attachmentId → 谁用过它（以及日志里声明的类型/字节数）。
 *
 * 为什么记「谁」而不只是「有没有」：导出选择器要把附件挂在**使用它的那条会话**下面（G5），
 * 归属关系只有读会话日志才算得出来；而适配器的 `listUnits()` 是零 I/O 纯函数，拿不到这份关系。
 */
export interface AttachmentRefEntry {
  /** 引用它的会话单元裸键（`<projectKey>/<sessionDir>`，与 sessions 单元 id 同构） */
  units: string[]
  mediaType?: string
  bytes?: number
}
export type AttachmentRefIndex = Map<string, AttachmentRefEntry>;

const SCAN_CACHE_TTL_MS = 60_000;
interface ScanCache {
  key: string;
  at: number;
  index: AttachmentRefIndex;
}
let scanCache: ScanCache | null = null;

/**
 * 归属扫描的日志条数上限（预览富化用）。
 *
 * 富化必须**有界**：它挂在只读预览端点上，超出上限就放弃归属（界面退回扁平渲染），
 * 绝不让一次预览因为几千个会话日志卡住。真实导出不受这条限制 —— 那里按用户勾选收窄。
 */
const ENRICH_MAX_LOGS = 2000;

async function scanKeyOf(ctx: HostContext, logs: readonly string[]): Promise<string | null> {
  const mtime = ctx.fs.mtimeMs;
  if (mtime === undefined) return null;
  const parts: string[] = [];
  for (let i = 0; i < logs.length; i += READ_BATCH) {
    const batch = logs.slice(i, i + READ_BATCH);
    const times = await Promise.all(batch.map(async (rel) => {
      const posix = toPosixRel(rel);
      try {
        return `${posix}:${String(await mtime.call(ctx.fs, posix))}`;
      } catch {
        return null;
      }
    }));
    for (const part of times) {
      if (part === null) return null;
      parts.push(part);
    }
  }
  return parts.join('|');
}

/** 测试用：清空引用面缓存。生产失效只靠 mtime 键与 TTL，不靠这里。 */
export function resetAttachmentsScanCache(): void {
  scanCache = null;
}

/** 日志文件 → 该文件引用的附件（读不出 / 解不开返回 null，由调用方降级）。 */
async function refsOfLog(ctx: HostContext, homeRel: string): Promise<Map<string, AttachmentRefMeta> | null> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.readFile(homeRel);
  } catch {
    return null;
  }
  const out = new Map<string, AttachmentRefMeta>();
  let scan: ReturnType<typeof scanZstdFrames>;
  try {
    scan = scanZstdFrames(bytes);
  } catch {
    return null; // 帧头损坏：该文件判为不可读，交由调用方降级（绝不当成「零引用」）
  }
  const frames = scan.frames;
  if (frames.length === 0) {
    // 有 zstd 魔数却一帧都切不出来 = 日志损坏。**不能**当成「零引用」：
    // 那会让一次坏日志静默缩小备份范围（用户看到「成功」而图片没进包）。
    if (hasZstdMagic(bytes)) return null;
    // 非 zstd 会话日志（历史明文层级）：直接按文本抽，不用解压。
    for (const [id, meta] of extractAttachmentRefs(Buffer.from(bytes).toString('utf8'))) {
      out.set(id, { ...meta });
    }
    return out;
  }
  for (const frame of frames) {
    try {
      const text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
      for (const [id, meta] of extractAttachmentRefs(text)) {
        // 同一日志多帧可能重复引用同一附件：保留首个非空声明（后写的重试不该覆盖首次声明）
        const prev = out.get(id);
        out.set(id, {
          ...(prev?.mediaType !== undefined ? { mediaType: prev.mediaType } : meta.mediaType !== undefined ? { mediaType: meta.mediaType } : {}),
          ...(prev?.bytes !== undefined ? { bytes: prev.bytes } : meta.bytes !== undefined ? { bytes: meta.bytes } : {}),
        });
      }
    } catch {
      // 单帧解不开：该文件整体判为不可读（不拿半份引用当「完整」）
      return null;
    }
  }
  return out;
}

/** 日志的相对路径 → 会话单元裸键（`<projectKey>/<sessionDir>`，与 sessions 单元的 id 同构）。 */
function unitKeyOfLog(rel: string): string | null {
  const parts = toPosixRel(rel).split('/');
  return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : null;
}

/** 把一份日志的引用并进索引（同一附件被多条会话引用时记多个 owner）。 */
function addRefs(index: AttachmentRefIndex, unitKey: string, refs: Map<string, AttachmentRefMeta>): void {
  for (const [id, meta] of refs) {
    const prev = index.get(id);
    if (prev === undefined) {
      index.set(id, { units: [unitKey], ...meta });
      continue;
    }
    if (!prev.units.includes(unitKey)) prev.units.push(unitKey);
    if (prev.mediaType === undefined && meta.mediaType !== undefined) prev.mediaType = meta.mediaType;
    if (prev.bytes === undefined && meta.bytes !== undefined) prev.bytes = meta.bytes;
  }
}

/** 日志文件的 `mtime + size`（缓存失效键）；读不到任一项返回 null = 该条不缓存。 */
async function statOfLog(ctx: HostContext, posix: string): Promise<{ mtimeMs: number; size: number } | null> {
  const info = ctx.fs.statInfo;
  if (info !== undefined) {
    try {
      const got = await info.call(ctx.fs, posix);
      return got === null ? null : { mtimeMs: got.mtimeMs, size: got.size };
    } catch {
      return null;
    }
  }
  const mtimeMs = ctx.fs.mtimeMs;
  const statSize = ctx.fs.statSize;
  if (mtimeMs === undefined || statSize === undefined) return null;
  try {
    const time = await mtimeMs.call(ctx.fs, posix);
    const size = await statSize.call(ctx.fs, posix);
    if (time === null || size === null) return null;
    return { mtimeMs: time, size };
  } catch {
    return null;
  }
}

/**
 * 逐批读日志建索引；failed = 读不出/解不开的日志条数（>0 时调用方不许当成完整引用面）。
 *
 * 每条日志先看持久化缓存（`mtime + size` 都相等才采信），命中就不解压 —— 本机冷启 7 s、
 * 命中后 0.05 s。缓存与本次结果合并后 best-effort 写回（写失败不影响正确性）。
 */
async function scanRefIndex(ctx: HostContext, logs: readonly string[]): Promise<{ index: AttachmentRefIndex; failed: number }> {
  const index: AttachmentRefIndex = new Map();
  const cached = await loadAttachmentRefCache(ctx);
  const merged: AttachmentRefCache = new Map(cached);
  let failed = 0;
  for (let i = 0; i < logs.length; i += READ_BATCH) {
    const batch = logs.slice(i, i + READ_BATCH);
    const results = await Promise.all(batch.map(async (rel) => {
      const posix = toPosixRel(rel);
      const key = unitKeyOfLog(posix);
      if (key === null) return { key, refs: null, posix: null, stat: null };
      const stat = await statOfLog(ctx, posix);
      const prev = cached.get(posix);
      if (stat !== null && prev !== undefined && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
        return { key, refs: new Map(Object.entries(prev.refs)), posix, stat };
      }
      return { key, refs: await refsOfLog(ctx, posix), posix, stat };
    }));
    for (const result of results) {
      if (result.refs === null || result.key === null) {
        failed += 1;
        continue;
      }
      addRefs(index, result.key, result.refs);
      if (result.posix !== null && result.stat !== null) {
        merged.set(result.posix, { ...result.stat, refs: Object.fromEntries(result.refs) });
      }
    }
  }
  await saveAttachmentRefCache(ctx, merged);
  return { index, failed };
}

/** 扫描结果：成功给索引，失败给告警文案（调用方据此降级到整库 / 退回扁平）。 */
type RefIndexResult = { ok: true; index: AttachmentRefIndex } | { ok: false; warning: string };

/** 取引用面索引（命中缓存就不重读）。导出与预览富化共用这一条路径，口径不会分叉。 */
async function loadRefIndex(ctx: HostContext, logs: readonly string[]): Promise<RefIndexResult> {
  const msg = msgOf(ctx);
  if (!zstdAvailable() && logs.length > 0) return { ok: false, warning: msg('export.attachmentsNoZstd') };
  const cacheKey = await scanKeyOf(ctx, logs);
  const hit = cacheKey !== null && scanCache !== null
    && scanCache.key === cacheKey && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS ? scanCache : null;
  if (hit !== null) return { ok: true, index: hit.index };
  const { index, failed } = await scanRefIndex(ctx, logs);
  if (failed > 0) return { ok: false, warning: msg('export.attachmentsScanFailed', { count: String(failed) }) };
  if (cacheKey !== null) scanCache = { key: cacheKey, at: Date.now(), index };
  return { ok: true, index };
}

export class AttachmentsAdapter extends FileCollectionAdapter {
  readonly id = 'attachments' as const;
  readonly displayName = 'Attachments';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  readonly baseDir = 'attachments';

  /** 单元 = 一个附件对象（路径里那段 64 位 hex 反推出的 attachmentId）。 */
  protected override unitIdOf(relativePath: string): string {
    return attachmentIdOfRelPath(toPosixRel(relativePath)) ?? toPosixRel(relativePath);
  }

  protected override async restrictUnits(
    ctx: HostContext,
    rels: readonly string[],
    options: ExportOptions,
  ): Promise<{ keep: Set<string> | null; warnings: string[] } | null> {
    const msg = msgOf(ctx);
    const present = new Set<string>();
    for (const rel of rels) present.add(this.unitIdOf(this.relPathOf(rel)));

    // ① 选中会话：键缺省 = 全量（如实告警）；空数组 = 该分区一条都不带（与基类 allow 语义一致）。
    const sessionAllow = options.includeItems?.['sessions'];
    if (Array.isArray(sessionAllow) && sessionAllow.length === 0) {
      return { keep: new Set<string>(), warnings: [msg('export.attachmentsNoSessions')] };
    }
    const warnings: string[] = [];
    // 未指定会话范围 = 按**全部会话**算引用面。这条必须连同真实数字一起明说，
    // 所以推迟到 ④ 之后（届时 keep / present / missing 才齐）。
    const allSessions = sessionAllow === undefined;
    const limit = normalizeSessionLimit(options.sessions?.limit);
    if (limit !== undefined && limit >= 0 && !Array.isArray(sessionAllow)) {
      warnings.push(msg('export.attachmentsLimitIgnored'));
    }
    // includeItems 的单元 id 带分区前缀（sessions:<projectKey>/<sessionId>），先剥前缀再归一
    const unitOf = (raw: string): string => {
      const stripped = raw.startsWith('sessions:') ? raw.slice('sessions:'.length) : raw;
      return sessionIdKey(stripped);
    };
    const allowedUnits = Array.isArray(sessionAllow) ? new Set(sessionAllow.map(unitOf)) : null;

    // ② 枚举会话日志（home 相对 'sessions/…'），按会话单元收窄
    let logs: string[];
    try {
      const listing = await listFilesDetailed(ctx.fs, 'sessions');
      logs = listing.paths.filter((rel) => isSessionLogFileName(toPosixRel(rel).split('/').pop() ?? ''));
      if (allowedUnits !== null) {
        logs = logs.filter((rel) => {
          const parts = toPosixRel(rel).split('/');
          return parts.length >= 3 && allowedUnits.has(sessionIdKey(`${parts[1]}/${parts[2]}`));
        });
      }
    } catch {
      return { keep: null, warnings: [msg('export.attachmentsScanUnreadable')] };
    }

    // ③ 读日志抽引用（不可读 / 不可解压 ⇒ 整批退回全库，绝不静默少带）
    const scanned = await loadRefIndex(ctx, logs);
    if (!scanned.ok) return { keep: null, warnings: [scanned.warning] };
    const referenced = new Set<string>(scanned.index.keys());

    // ④ 只留「被引用 且 本机确实存在」的对象
    const keep = new Set<string>();
    let missing = 0;
    for (const id of referenced) {
      if (present.has(id)) keep.add(id);
      else missing += 1;
    }
    warnings.push(msg('export.attachmentsReferenced', {
      count: String(keep.size),
      total: String(present.size),
      missing: String(missing),
    }));
    if (allSessions) {
      warnings.push(msg('export.attachmentsAllSessions', {
        count: String(keep.size),
        total: String(present.size),
        missing: String(missing),
      }));
    }
    return { keep, warnings };
  }

  /**
   * 预览富化（G5）：给附件单元补「哪些会话用过它」，选择器据此把附件挂到会话行下面。
   *
   * 返回 `null` = 这次算不出归属（日志读不出/解不开、条数超上限）—— 界面按扁平渲染，
   * **绝不猜归属**：把附件挂错会话，用户会以为「这个包里有那张图」而实际没有。
   * 未变化的单元原样返回（缺字段 ≠ 空数组：没有归属就是不知道，不是「属于零条会话」）。
   */
  async enrichUnits(ctx: HostContext, units: readonly ExportUnit[]): Promise<ExportUnit[] | null> {
    if (units.length === 0) return [...units];
    let logs: string[];
    try {
      const listing = await listFilesDetailed(ctx.fs, 'sessions');
      logs = listing.paths.filter((rel) => isSessionLogFileName(toPosixRel(rel).split('/').pop() ?? ''));
    } catch {
      return null;
    }
    const keyed = logs.filter((rel) => unitKeyOfLog(toPosixRel(rel)) !== null);
    if (keyed.length === 0) return [...units];
    if (keyed.length > ENRICH_MAX_LOGS) return null;
    const scanned = await loadRefIndex(ctx, keyed);
    if (!scanned.ok) return null;
    return units.map((unit) => {
      // 单元 id = attachments:<attachmentId>；剥前缀查索引（形状不符 = 不是附件对象，原样返回）
      const ref = unit.id.startsWith('attachments:') ? unit.id.slice('attachments:'.length) : unit.id;
      const entry = scanned.index.get(ref);
      if (entry === undefined) return unit;
      const shortId = shortAttachmentId(ref);
      return {
        ...unit,
        // 展示名：有 mediaType 用它（image/jpeg 之类），没有就退到短哈希 —— 绝不编造「附件 1」这类序号，
        // 序号会随勾选范围变化，用户二次打开时对不上号。
        label: entry.mediaType ?? shortId,
        // 有 mediaType 时补一行短哈希作次要信息，否则 label 已经是短哈希、不必重复
        ...(entry.mediaType !== undefined && unit.detail === undefined ? { detail: shortId } : {}),
        ...(entry.units.length > 0 ? { parentUnitIds: entry.units.map((key) => `sessions:${key}`) } : {}),
      };
    });
  }
}
