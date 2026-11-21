/**
 * 附件引用面的**持久化**索引缓存：每条会话日志一条 `mtime + size → 它引用了哪些 attachmentId`。
 *
 * 为什么需要落盘：抽出引用面必须把日志整份解压。本机实测 339 份日志 / 230 MB，
 * 108517 个 zstd 帧逐个解压要 6.96 s（解压 6.96 s、抽正则 0.27 s、切帧 0.01 s —— 成本
 * 全在逐帧调用开销上），且并发无法改善（纯 CPU）。而导出与预览富化都要这份引用面，
 * 每次导出都重扫 7 s 不可接受。按 `mtime + size` 增量命中后，稳态只剩 stat（339 个约 50 ms）。
 *
 * 三条硬口径：
 * 1. 缓存只是**加速**，不是事实来源：条目必须与当前文件的 `mtime + size` 同时相等才采信，
 *    任一读不到就当没有缓存（重扫），绝不拿旧结果冒充当前。
 * 2. 读写失败一律**静默降级**（返回空表 / 放弃写入）：缓存不可用不该让导出失败，
 *    但也不许因此少带附件 —— 失败时调用方照常整份扫描。
 * 3. 文件内容是不可信输入：版本号、形状逐项校验，超量整份丢弃，不做部分采信。
 */
import type { HostContext } from '../core/types.ts';
import type { AttachmentRefMeta } from '../utils/attachment-refs.ts';

/** 缓存文件位置（DSH home 相对）。放在插件自己的数据目录下，不占宿主的 cache/。 */
export const ATTACHMENT_CACHE_REL = 'dsh-config-manager/cache/attachment-refs.v1.json';

/**
 * v2 = 条目里带附件真名（`name`）。
 *
 * 为什么不就地兼容 v1：v1 缓存条目只有 mediaType/bytes，命中后附件行会继续显示
 * `image/png`，看起来像「新功能没生效」。升版本让旧缓存整份失效、重扫一次（本机约 7 s），
 * 比重建时逐条补字段更简单，也不会出现「一半真名一半 MIME」的混合状态。
 */
const CACHE_VERSION = 2;
/** 条目上限：超出说明文件被写坏或被别的程序塞了东西，整份丢弃后重建。 */
const MAX_ENTRIES = 20_000;
const MAX_META_KEYS = 5_000;

export interface CachedLogRefs {
  mtimeMs: number;
  size: number;
  refs: Record<string, AttachmentRefMeta>;
}

export type AttachmentRefCache = Map<string, CachedLogRefs>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 缓存里的附件真名：与抽取侧同一形状限制（会直接渲染成行标题，拒绝控制字符与路径分隔符）。 */
const SAFE_NAME = /^[^"\\/\u0000-\u001f]{1,200}$/;

/** 单条引用元数据：只认 `mediaType: string`、`bytes: 非负整数` 与 `name: 安全文件名`，别的键一律不采信。 */
function metaOf(value: unknown): AttachmentRefMeta {
  if (!isRecord(value)) return {};
  const out: AttachmentRefMeta = {};
  if (typeof value['mediaType'] === 'string') out.mediaType = value['mediaType'];
  const bytes = value['bytes'];
  if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) out.bytes = bytes;
  const name = value['name'];
  if (typeof name === 'string' && SAFE_NAME.test(name)) out.name = name;
  return out;
}

function entryOf(value: unknown): CachedLogRefs | null {
  if (!isRecord(value)) return null;
  const mtimeMs = value['mtimeMs'];
  const size = value['size'];
  const refs = value['refs'];
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  if (!isRecord(refs)) return null;
  const keys = Object.keys(refs);
  if (keys.length > MAX_META_KEYS) return null;
  const parsed: Record<string, AttachmentRefMeta> = {};
  for (const key of keys) parsed[key] = metaOf(refs[key]);
  return { mtimeMs, size, refs: parsed };
}

/** 读缓存（读不到 / 形状不对 / 版本不符 → 空表，让调用方整份重扫）。 */
export async function loadAttachmentRefCache(ctx: HostContext): Promise<AttachmentRefCache> {
  const out: AttachmentRefCache = new Map();
  let raw: Uint8Array;
  try {
    raw = await ctx.fs.readFile(ATTACHMENT_CACHE_REL);
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    return out;
  }
  if (!isRecord(parsed) || parsed['version'] !== CACHE_VERSION) return out;
  const logs = parsed['logs'];
  if (!isRecord(logs)) return out;
  const keys = Object.keys(logs);
  if (keys.length > MAX_ENTRIES) return out;
  for (const key of keys) {
    const entry = entryOf(logs[key]);
    if (entry !== null) out.set(key, entry);
  }
  return out;
}

/**
 * 写缓存（best-effort）。只做「合并」不做「裁剪」：
 * 一次导出可能只扫被勾选的那几条会话，此时删掉没扫到的条目会让下次导出重新解压整库。
 * 失效靠 `mtime + size` 比对，过期条目最多占几十 KB。
 */
export async function saveAttachmentRefCache(
  ctx: HostContext,
  merged: ReadonlyMap<string, CachedLogRefs>,
): Promise<void> {
  // 一条都没学到（mtime 读不到 / 全扫失败）就别落一个空文件：空缓存对下次毫无用处，
  // 却会让「这台机器上有没有 cache 文件」变成误导性的观测点。
  if (merged.size === 0) return;
  const logs: Record<string, CachedLogRefs> = {};
  let count = 0;
  for (const [key, entry] of merged) {
    if (count >= MAX_ENTRIES) break;
    logs[key] = entry;
    count += 1;
  }
  const payload = Buffer.from(JSON.stringify({ version: CACHE_VERSION, logs }), 'utf8');
  try {
    if (ctx.fs.ensureDir !== undefined) await ctx.fs.ensureDir.call(ctx.fs, 'dsh-config-manager/cache');
    await ctx.fs.writeFile(ATTACHMENT_CACHE_REL, payload);
  } catch {
    // 缓存写不进去只影响下一次的速度，不影响本次结果的正确性。
  }
}
