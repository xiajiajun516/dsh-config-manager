/**
 * ZIP 读写封装：node:zlib（deflate raw）+ 自实现 CRC32，零依赖。
 * **ZIP 安全的第一道防线，且默认为最严版本**（规范 §19）：
 *   - 条目名 isPathSafe（拒绝 ../、绝对路径、盘符、UNC、NUL）
 *   - 重复条目名拒绝（防读取歧义）、symlink 条目拒绝（external attrs 的 S_IFLNK）
 *   - 本地文件头越界检查（localOffset + 30 必须落在 ZIP 内）
 *   - 条目数 / 压缩体积 / 解压体积 / 单条 / 压缩比（zip bomb）上限（唯一来源 DEFAULT_ZIP_SAFETY_LIMITS）
 *   - 写出侧条目数上限与读侧同源（assertZipEntryCount），杜绝「导出成功却导不回」
 *   - 解压时逐条 CRC32 与尺寸校验，损坏即整体拒绝
 * 解压只允许写入受控目标目录（safeExtract），绝不落任意路径。
 * security/zip-security.ts 只在其上做解压落盘强化（lstat 复查 + 失败清理）与可执行名告警，
 * 不再复制解析器 —— 默认值（未注入 parseZipOverride）即具备上述全部强化检查。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseJsonSafe } from './json.ts';
import { isPathSafe, isSameOrChild } from './paths.ts';

export interface ZipEntryMeta {
  name: string;
  method: number; // 0=store, 8=deflate
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  isDirectory: boolean;
  /** 本地文件头在 ZIP 字节流中的偏移 */
  localOffset: number;
}

export interface ZipSafetyLimits {
  maxEntries?: number;
  maxTotalBytes?: number;      // 解压后累计字节上限
  maxCompressedBytes?: number; // ZIP 内压缩数据累计上限
  maxSingleBytes?: number;     // 单条目解压后上限
  maxRatio?: number;           // 单条目解压/压缩比上限（zip bomb 检测）
}

export const DEFAULT_ZIP_SAFETY_LIMITS: Required<ZipSafetyLimits> = {
  maxEntries: 10_000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCompressedBytes: 200 * 1024 * 1024,
  maxSingleBytes: 100 * 1024 * 1024,
  maxRatio: 200,
};

export class ZipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipSafetyError';
  }
}

/* ---------------- CRC32（表驱动） ---------------- */

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------- 写入 ---------------- */

function dosDateTime(): { time: number; date: number } {
  const now = new Date();
  const time = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const date = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  return { time, date };
}

export interface ZipWriteEntry { name: string; data: Uint8Array; }

/**
 * 写出前校验条目数（导出侧上限）。
 * - **写侧上限恒不高于读侧默认上限**（t36）：`limits.maxEntries` 只允许**收紧**，传入更大的值会被
 *   钳到 `DEFAULT_ZIP_SAFETY_LIMITS.maxEntries`。改动前只与 UInt16 物理上限取 min，于是显式传
 *   `maxEntries: 20_000` 的调用方能写出 10001 条的 ZIP —— 而默认读侧解析器（10_000）必然拒绝它，
 *   即「导出成功却导不回」（市场通道的测试此前正是靠这个不对称缺口构造样本）。
 * - 再与 UInt16 物理上限取 min：EOCD 的条目数字段只有 16 位，越过它会落到
 *   `Buffer.writeUInt16LE` 的裸 RangeError（无上下文、非 ZipSafetyError）。当前 10_000 < 0xFFFF，
 *   故该项**恒由读侧上限先行决定** —— 但它**不是死代码，勿删**：保留为防御性第二因子，万一读侧
 *   默认上限被调高到 16 位之上，仍不会写出物理上非法的 ZIP（该大小关系由 zip.test.ts 的
 *   `ZIP_MAX_WRITABLE_ENTRIES > DEFAULT_ZIP_SAFETY_LIMITS.maxEntries` 断言钉住）。
 * - 超限抛 ZipSafetyError（可读文案，含实际条目数与上限）。
 */
export function assertZipEntryCount(count: number, limits: ZipSafetyLimits = {}): void {
  const readSideMax = DEFAULT_ZIP_SAFETY_LIMITS.maxEntries;
  const max = Math.min(limits.maxEntries ?? readSideMax, readSideMax, ZIP_MAX_WRITABLE_ENTRIES);
  if (count > max) {
    throw new ZipSafetyError(
      `ZIP 条目数 ${count} 超过上限 ${max}（导出上限与读取上限一致；请缩小导出分区范围后重试）`,
    );
  }
}

/* ---------------- 写出侧布局片段（zipToBuffer 与 writeZip 共用，避免两份布局漂移） ----------------
 * 三条 helper 的字段写入顺序与取值**必须与历史 zipToBuffer 逐字一致** —— 产物格式是对外契约
 * （docs/spec/bundle-format-v1.md），zip.test.ts 有一条「zipToBuffer 与 writeZip 产物等价」的用例钉住。 */

/** 本地文件头（30 字节；不含紧随其后的文件名与压缩数据）。 */
function buildLocalHeader(nameLen: number, crc: number, compressedSize: number, size: number, time: number, date: number): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(8, 8);     // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameLen, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

/** 中央目录记录（46 字节；不含紧随其后的文件名）。 */
function buildCentralHeader(nameLen: number, crc: number, compressedSize: number, size: number, offset: number, time: number, date: number): Buffer {
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt16LE(time, 12);
  cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(compressedSize, 20);
  cen.writeUInt32LE(size, 24);
  cen.writeUInt16LE(nameLen, 28);
  cen.writeUInt16LE(0, 30);
  cen.writeUInt16LE(0, 32);
  cen.writeUInt16LE(0, 34);
  cen.writeUInt16LE(0, 36);
  cen.writeUInt32LE(0, 38);
  cen.writeUInt32LE(offset, 42);
  return cen;
}

/** 中央目录结束记录 EOCD（22 字节）。 */
function buildEocd(entryCount: number, cdSize: number, cdOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/**
 * 异步 deflate（t46）：交给 libuv 线程池，**不阻塞事件循环**。
 * 与 `zlib.deflateRawSync` 是同一 zlib 实现、同一默认参数（level/chunkSize 等均取缺省），
 * 因此对同一输入产出**逐字节相同**的压缩流 —— 这是「格式不变」的前提，由 zip.test.ts 的等价用例钉住。
 */
function deflateRawAsync(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(data, (err, out) => { if (err) reject(err); else resolve(out); });
  });
}

/** 组装 ZIP 字节（全部条目 method=8 deflate，UTF-8 文件名，含中央目录与 EOCD）。
 *  `limits.maxEntries` 缺省 = 读侧默认上限（10_000），且**只允许收紧**：传入更大值会被钳到该上限，
 *  确保产物恒能被默认解析器读回（t36）。 */
export function zipToBuffer(entries: ZipWriteEntry[], limits: ZipSafetyLimits = {}): Uint8Array {
  assertZipEntryCount(entries.length, limits);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const entry of entries) {
    if (!isPathSafe(entry.name)) {
      throw new ZipSafetyError(`拒绝写入不安全的条目名: ${entry.name}`);
    }
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = buildLocalHeader(nameBuf.length, crc, compressed.length, data.length, time, date);
    chunks.push(local, nameBuf, compressed);
    central.push(buildCentralHeader(nameBuf.length, crc, compressed.length, data.length, offset, time, date), nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const cd = Buffer.concat(central);
  return Buffer.concat([...chunks, cd, buildEocd(entries.length, cd.length, offset)]);
}

/**
 * 写出 ZIP 文件（t46：**流式 + 异步压缩**）。
 *
 * 改动前是 `zipToBuffer(entries) → atomicWriteFile(zipPath, buf)`，两个已复核的问题：
 *  1. **整块驻留**：整个 ZIP（本地头 + 压缩数据 + 中央目录）先拼进内存再落盘 —— 输入 N 字节时
 *     峰值约 3N（entries 本身 + chunks 数组 + Buffer.concat 的成品），大 home 下即「整块载荷同时驻留」；
 *  2. **阻塞事件循环**：deflateRawSync 是全仓唯一的同步压缩点（本机 32MB 夹具实测阻塞 583ms）。
 * 现在：逐条 `await deflateRaw`（libuv 线程池）→ 顺序写入**目标同目录的 tmp 文件**，内存里只留中央目录
 * 与当前这一条；全部写完 fsync 后 rename 原子发布。
 *
 * 原子性与权限语义与改动前的 atomicWriteFile 一致：同目录 tmp → fsync → rename（带重试）→
 * 父目录 best-effort fsync；目标已存在则继承其权限位，并跟随符号链接（等价 symlink:'follow'）。
 * 未直接复用 atomic-write.ts：它不在 t46 inScope，且只接受「整块字节」、不支持流式写入。
 *
 * 限额口径与 zipToBuffer 完全相同（assertZipEntryCount：写侧上限恒 ≤ 读侧上限）。
 */
export async function writeZip(zipPath: string, entries: ZipWriteEntry[], limits: ZipSafetyLimits = {}): Promise<void> {
  assertZipEntryCount(entries.length, limits);
  // 先全量校验条目名：不安全的名字在**落任何字节之前**拒绝（与 zipToBuffer 的拒绝顺序一致）
  const prepared = entries.map((entry) => {
    if (!isPathSafe(entry.name)) throw new ZipSafetyError(`拒绝写入不安全的条目名: ${entry.name}`);
    return {
      nameBuf: Buffer.from(entry.name, 'utf8'),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
    };
  });

  const { time, date } = dosDateTime();
  // 跟随符号链接（等价 atomic-write 的 symlink:'follow'）：已有链接指向哪就写哪
  let target = zipPath;
  try { target = await fs.realpath(zipPath); } catch { /* 目标尚不存在 → 用原路径 */ }
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.stat(target).catch(() => null);
  const tmp = path.join(dir, path.basename(target) + '.tmp-' + process.pid.toString(36) + '-' + randomBytes(6).toString('hex'));

  const central: Buffer[] = [];
  let offset = 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tmp, 'wx', existing?.mode ?? 0o666);
    for (const item of prepared) {
      // 异步压缩：不阻塞事件循环；与 deflateRawSync 同参数同输出
      const compressed = await deflateRawAsync(item.data);
      const crc = crc32(item.data);
      const local = buildLocalHeader(item.nameBuf.length, crc, compressed.length, item.data.length, time, date);
      // FileHandle.writeFile 从当前位置顺序写入（多次调用即追加），无需自己处理部分写
      await handle.writeFile(local);
      await handle.writeFile(item.nameBuf);
      await handle.writeFile(compressed);
      central.push(buildCentralHeader(item.nameBuf.length, crc, compressed.length, item.data.length, offset, time, date), item.nameBuf);
      offset += local.length + item.nameBuf.length + compressed.length;
    }
    const cd = Buffer.concat(central);
    await handle.writeFile(cd);
    await handle.writeFile(buildEocd(prepared.length, cd.length, offset));
    await handle.sync();
    await handle.close();
    handle = null;
    await publishTmp(tmp, target);
  } catch (err) {
    if (handle !== null) { try { await handle.close(); } catch { /* 关闭失败不掩盖原始错误 */ } }
    try { await fs.rm(tmp, { force: true }); } catch { /* 尽力清理；原错误优先 */ }
    throw err;
  }
  // 父目录 fsync（POSIX 强持久化；Windows 上打开目录句柄会失败 → 直接跳过）
  try {
    const dh = await fs.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* best-effort，与 atomic-write 的 fsyncDir 同姿态 */ }
}

/** tmp → 目标的原子发布（rename）；Windows 上杀毒/索引器短暂占用会 EBUSY/EPERM，故重试几次。 */
async function publishTmp(tmp: string, target: string): Promise<void> {
  let delay = 25;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (attempt >= 2 || !retriable) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/* ---------------- 读取 ---------------- */

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
/** Unix 文件类型掩码（中央目录 external attrs 的高 16 位） */
const S_IFMT = 0xf000;
/** 符号链接（ZIP 内 symlink 条目是逃逸向量：解压后可能指向 destDir 之外） */
const S_IFLNK = 0xa000;
/**
 * 单个 ZIP 的条目数物理上限：EOCD 条目数字段是 UInt16（任何限额都不得越过它）。
 *
 * ⚠ **不要当死代码删除**（t36 复核意见）：读侧默认上限 10_000 < 0xFFFF，故在 assertZipEntryCount
 * 里它当前恒不先于读侧上限生效；它是**防御性第二因子** —— 若将来有人把读侧默认上限调高越过 16 位，
 * 它仍能挡住物理非法的 ZIP。该大小关系由 zip.test.ts 的断言钉住，删它会同时红。
 */
export const ZIP_MAX_WRITABLE_ENTRIES = 0xffff;

/** 内存 ZIP 归档：构造时校验全部条目名与上限；读取时逐条解压 + CRC/尺寸/比预算校验 */
export class ZipArchive {
  private readonly buf: Buffer;
  private readonly metas: ZipEntryMeta[];
  readonly limits: Required<ZipSafetyLimits>;
  private totalUncompressed = 0;

  constructor(buf: Uint8Array, metas: ZipEntryMeta[], limits: Required<ZipSafetyLimits>) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.metas = metas;
    this.limits = limits;
  }

  names(): string[] {
    return this.metas.map((m) => m.name);
  }

  entries(): ZipEntryMeta[] {
    return this.metas.map((m) => ({ ...m }));
  }

  has(name: string): boolean {
    return this.metas.some((m) => m.name === name);
  }

  /** 读取并解压单条目（带 CRC32 / 尺寸 / 体积预算 / 压缩比校验） */
  readEntry(name: string): Uint8Array {
    const meta = this.metas.find((m) => m.name === name);
    if (!meta) throw new ZipSafetyError(`ZIP 中不存在条目: ${name}`);
    if (meta.isDirectory) return Buffer.alloc(0);

    const lhOffset = meta.localOffset;
    const lh = this.buf.subarray(lhOffset, lhOffset + 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== LOCAL_SIG) {
      throw new ZipSafetyError(`条目 "${name}" 的本地文件头损坏`);
    }
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    const dataStart = lhOffset + 30 + nameLen + extraLen;
    if (dataStart + meta.compressedSize > this.buf.length) {
      throw new ZipSafetyError(`条目 "${name}" 数据越界`);
    }
    const raw = this.buf.subarray(dataStart, dataStart + meta.compressedSize);

    let out: Buffer;
    if (meta.method === 0) {
      out = raw;
    } else if (meta.method === 8) {
      try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: this.limits.maxSingleBytes });
      } catch (err) {
        throw new ZipSafetyError(`条目 "${name}" 解压失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new ZipSafetyError(`条目 "${name}" 使用未知压缩方法 ${meta.method}`);
    }

    if (out.length !== meta.uncompressedSize) {
      throw new ZipSafetyError(`条目 "${name}" 解压尺寸不符（${out.length} ≠ ${meta.uncompressedSize}）`);
    }
    if (crc32(out) !== meta.crc32) {
      throw new ZipSafetyError(`条目 "${name}" CRC32 校验失败（ZIP 已损坏）`);
    }

    this.totalUncompressed += out.length;
    if (this.totalUncompressed > this.limits.maxTotalBytes) {
      throw new ZipSafetyError('ZIP 解压总字节数超过上限');
    }
    if (meta.compressedSize > 0) {
      const ratio = out.length / meta.compressedSize;
      if (ratio > this.limits.maxRatio) {
        throw new ZipSafetyError(`条目 "${name}" 压缩比 ${ratio.toFixed(1)} 超过上限（疑似 zip bomb）`);
      }
    }
    return out;
  }

  readEntryText(name: string): string {
    return Buffer.from(this.readEntry(name)).toString('utf8');
  }

  /** 读取并深度保护解析 JSON 条目 */
  readEntryJson(name: string): unknown {
    return parseJsonSafe(this.readEntryText(name));
  }
}

/**
 * 解析 ZIP —— **默认即最严解析器**（无需调用方注入强化版）。
 * 安全校验：条目名 isPathSafe / 重复条目名 / symlink 条目 / 本地文件头越界 /
 * 条目数与压缩体积上限（DEFAULT_ZIP_SAFETY_LIMITS 唯一来源）。
 * 任何一项不满足即 throw ZipSafetyError（整体拒绝，不部分接受）。
 */
export function parseZip(buf: Uint8Array, limits: ZipSafetyLimits = {}): ZipArchive {
  const merged: Required<ZipSafetyLimits> = { ...DEFAULT_ZIP_SAFETY_LIMITS, ...limits };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 22) throw new ZipSafetyError('不是合法的 ZIP 文件（体积过小）');

  const eocdIdx = b.lastIndexOf(EOCD_SIG);
  if (eocdIdx < 0 || eocdIdx + 22 > b.length) {
    throw new ZipSafetyError('不是合法的 ZIP 文件（缺少中央目录结束记录）');
  }
  const totalEntries = b.readUInt16LE(eocdIdx + 10);
  const cdSize = b.readUInt32LE(eocdIdx + 12);
  const cdOffset = b.readUInt32LE(eocdIdx + 16);
  if (cdOffset + cdSize > b.length) {
    throw new ZipSafetyError('中央目录越界（ZIP 损坏）');
  }
  if (totalEntries > merged.maxEntries) {
    throw new ZipSafetyError(`ZIP 条目数 ${totalEntries} 超过上限 ${merged.maxEntries}`);
  }

  const metas: ZipEntryMeta[] = [];
  /** 已见条目名：重复条目会让「按名读取」产生歧义（读取到哪一个取决于遍历顺序） */
  const seenNames = new Set<string>();
  let pos = cdOffset;
  let compressedTotal = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdOffset + cdSize) throw new ZipSafetyError('中央目录条目越界（ZIP 损坏）');
    if (b.readUInt32LE(pos) !== CENTRAL_SIG) throw new ZipSafetyError('中央目录签名损坏');
    const method = b.readUInt16LE(pos + 10);
    const crc = b.readUInt32LE(pos + 16);
    const compSize = b.readUInt32LE(pos + 20);
    const uncompSize = b.readUInt32LE(pos + 24);
    const nameLen = b.readUInt16LE(pos + 28);
    const extraLen = b.readUInt16LE(pos + 30);
    const commentLen = b.readUInt16LE(pos + 32);
    const externalAttrs = b.readUInt32LE(pos + 38);
    const localOffset = b.readUInt32LE(pos + 42);
    const name = b.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (!isPathSafe(name)) throw new ZipSafetyError(`ZIP 条目名不安全: ${name}`);
    // —— 以下三项原属 security/zip-security.ts 的 parseZipHardened，现并入默认解析器 ——
    // （默认值即最严：未注入 parseZipOverride 的调用方不再拿到「弱版」）
    if (seenNames.has(name)) throw new ZipSafetyError(`ZIP 条目名重复: ${name}`);
    seenNames.add(name);
    if (((externalAttrs >>> 16) & S_IFMT) === S_IFLNK) {
      throw new ZipSafetyError(`ZIP 含符号链接条目，已拒绝: ${name}`);
    }
    if (localOffset + 30 > b.length) {
      throw new ZipSafetyError(`条目 "${name}" 本地文件头越界`);
    }

    compressedTotal += compSize;
    if (compressedTotal > merged.maxCompressedBytes) {
      throw new ZipSafetyError('ZIP 压缩数据总量超过上限');
    }
    metas.push({
      name,
      method,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      crc32: crc,
      isDirectory: name.endsWith('/'),
      localOffset,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return new ZipArchive(b, metas, merged);
}

/**
 * 安全解压到受控目录（对齐设计 §13.4 safeExtract 签名）。
 * 返回条目相对路径列表；任何越界/损坏即整体拒绝（不部分落盘）。
 * m4 的 zip-security 可替换/强化本实现。
 */
export async function safeExtract(
  zipPath: string,
  destDir: string,
  limits: ZipSafetyLimits = {},
): Promise<string[]> {
  const data = await fs.readFile(zipPath);
  const archive = parseZip(data, limits);
  const extracted: string[] = [];
  for (const meta of archive.entries()) {
    if (meta.isDirectory) continue;
    const target = path.join(destDir, ...meta.name.split('/'));
    if (!isSameOrChild(target, destDir)) {
      throw new ZipSafetyError(`解压目标越界: ${meta.name}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, archive.readEntry(meta.name));
    extracted.push(meta.name);
  }
  return extracted;
}
