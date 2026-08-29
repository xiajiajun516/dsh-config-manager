/**
 * ZIP 读写封装：node:zlib（deflate raw）+ 自实现 CRC32，零依赖。
 * 同时是 ZIP 安全的第一道防线（规范 §19，m4 的 zip-security 可在此基础上强化）：
 *   - 条目名 isPathSafe（拒绝 ../、绝对路径、盘符、UNC、NUL）
 *   - 条目数 / 压缩体积 / 解压体积 / 单条 / 压缩比（zip bomb）上限
 *   - 解压时逐条 CRC32 与尺寸校验，损坏即整体拒绝
 * 解压只允许写入受控目标目录（safeExtract），绝不落任意路径。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseJsonSafe } from './json.ts';
import { isPathSafe, isSameOrChild } from './paths.ts';
import { atomicWriteFile } from './atomic-write.ts';

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

/** 组装 ZIP 字节（全部条目 method=8 deflate，UTF-8 文件名，含中央目录与 EOCD） */
export function zipToBuffer(entries: ZipWriteEntry[]): Uint8Array {
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

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8);     // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cd, eocd]);
}

/** 写出 ZIP 文件（原子写，避免半写 zip） */
export async function writeZip(zipPath: string, entries: ZipWriteEntry[]): Promise<void> {
  const buf = zipToBuffer(entries);
  await atomicWriteFile(zipPath, buf);
}

/* ---------------- 读取 ---------------- */

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

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

/** 解析 ZIP（含安全校验：条目名 / 条目数 / 压缩体积） */
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
    const localOffset = b.readUInt32LE(pos + 42);
    const name = b.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (!isPathSafe(name)) throw new ZipSafetyError(`ZIP 条目名不安全: ${name}`);
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
