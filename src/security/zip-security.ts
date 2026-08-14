/**
 * ZIP 解压安全（规范 §19 / 设计 §9 / core utils/zip.ts 的强化层）。
 *
 * 分工（避免与 core 重复）：
 * - core `utils/zip.ts` 已实现：条目名 isPathSafe、条目数/压缩体积/解压体积/单条/压缩比限额、
 *   CRC32 与尺寸校验、ZipArchive.readEntry 预算、safeExtract 基础解压。
 * - 本模块在其上强化 core 未覆盖的攻击面：
 *   1. **symlink 条目拒绝**：解析中央目录 external attrs 的 Unix mode（S_IFLNK 0xA000）→ 拒绝；
 *   2. **重复条目名拒绝**：同名条目（含目录/文件互撞）→ 拒绝（防读取歧义攻击）；
 *   3. **安全解压强化**：解压后逐条 lstat 复查「必须是普通文件」，任何异常 → 中止并**完整清理**目标目录；
 *   4. **可执行文件告警**：扩展名黑名单 → warnings（本插件从不执行 ZIP 内文件）。
 *
 * 与 core 注入点对齐：`parseZipHardened` / `createHardenedZipParser` 满足
 * `ImporterOptions.parseZipOverride` 签名 `(buf, limits?) => ZipArchive`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathSafe, isSameOrChild } from '../utils/paths.ts';
import {
  DEFAULT_ZIP_SAFETY_LIMITS,
  ZipArchive,
  ZipSafetyError,
  type ZipEntryMeta,
  type ZipSafetyLimits,
} from '../utils/zip.ts';

export { isPathSafe } from '../utils/paths.ts';

/* ---------------- 常量 ---------------- */

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_SIG = 0x02014b50;
/** Unix 文件类型掩码（external attrs 高 16 位） */
const S_IFMT = 0xf000;
/** 符号链接 */
const S_IFLNK = 0xa000;

/** 可执行文件扩展名黑名单（§19.6：只警告，本插件不执行任何脚本） */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.dll', '.so', '.dylib', '.bin', '.jar',
]);

/** 条目名是否疑似可执行文件（按扩展名） */
export function isExecutableName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/* ---------------- 强化解析（parseZipOverride 注入点） ---------------- */

/**
 * 强化版 ZIP 解析：在 core 全部安全校验（条目名/条目数/压缩体积）之上，
 * 增加 symlink 拒绝与重复条目名拒绝。返回 core `ZipArchive`（解压校验完全复用）。
 */
export function parseZipHardened(buf: Uint8Array, limits: ZipSafetyLimits = {}): ZipArchive {
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
  if (cdOffset + cdSize > b.length) throw new ZipSafetyError('中央目录越界（ZIP 损坏）');
  if (totalEntries > merged.maxEntries) {
    throw new ZipSafetyError(`ZIP 条目数 ${totalEntries} 超过上限 ${merged.maxEntries}`);
  }

  const metas: ZipEntryMeta[] = [];
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

    // —— 强化检查 ——
    if (!isPathSafe(name)) throw new ZipSafetyError(`ZIP 条目名不安全: ${name}`);
    if (seenNames.has(name)) throw new ZipSafetyError(`ZIP 条目名重复: ${name}`);
    seenNames.add(name);
    const mode = (externalAttrs >>> 16) & S_IFMT;
    if (mode === S_IFLNK) {
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

/** 工厂：带默认限额的强化解析器（对齐 ImporterOptions.parseZipOverride 签名） */
export function createHardenedZipParser(defaultLimits?: ZipSafetyLimits) {
  return (buf: Uint8Array, limits?: ZipSafetyLimits): ZipArchive =>
    parseZipHardened(buf, { ...defaultLimits, ...limits });
}

/* ---------------- 强化安全解压（m5 导入文件类分区用） ---------------- */

export interface SafeExtractResult {
  /** 已解压条目的 ZIP 相对路径（正斜杠） */
  files: string[];
  /** 非阻塞告警（可执行文件条目等） */
  warnings: string[];
}

/**
 * 安全解压到受控目录（对齐 core safeExtract 语义 + 强化）：
 *  - 条目名/限额/symlink/重复名检查（parseZipHardened）；
 *  - 逐条 CRC32/尺寸/预算校验（ZipArchive.readEntry）；
 *  - 解压后 lstat 复查「全部产物必须是普通文件」（防符号链接/非常规写入）；
 *  - 任何异常 → 中止并**完整清理** destDir 后抛出（不残留部分落盘）。
 */
export async function safeExtractHardened(
  zipPath: string,
  destDir: string,
  limits: ZipSafetyLimits = {},
): Promise<SafeExtractResult> {
  const data = await fs.readFile(zipPath);
  const archive = parseZipHardened(data, limits);
  const extracted: string[] = [];
  const warnings: string[] = [];

  try {
    for (const meta of archive.entries()) {
      if (meta.isDirectory) continue;
      const target = path.join(destDir, ...meta.name.split('/'));
      if (!isSameOrChild(target, destDir)) {
        throw new ZipSafetyError(`解压目标越界: ${meta.name}`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, archive.readEntry(meta.name));
      extracted.push(meta.name);
      if (isExecutableName(meta.name)) {
        warnings.push(`条目 "${meta.name}" 是潜在可执行文件，本插件不会执行它`);
      }
    }
    // 解压后复查：全部产物必须是普通文件（防 symlink 逃逸 / 非常规写入）
    for (const rel of extracted) {
      const p = path.join(destDir, ...rel.split('/'));
      const st = await fs.lstat(p);
      if (!st.isFile()) {
        throw new ZipSafetyError(`解压产物不是普通文件: ${rel}`);
      }
    }
    return { files: extracted, warnings };
  } catch (err) {
    await fs.rm(destDir, { recursive: true, force: true });
    throw err;
  }
}
