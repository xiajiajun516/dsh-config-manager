/**
 * ZIP 解压安全（规范 §19 / 设计 §9）—— core utils/zip.ts 之上的**解压落盘**强化层。
 *
 * 分工（解析器单一实现来源，避免两份各自漂移）：
 * - core `utils/zip.ts` 的 `parseZip` **默认即最严**：条目名 isPathSafe、重复条目名、symlink 条目、
 *   本地文件头越界、条目数与压缩体积限额（唯一来源 DEFAULT_ZIP_SAFETY_LIMITS）。
 *   `parseZipHardened` 在此只保留为**兼容别名**（既有调用方与 parseZipOverride 注入点语义不变）。
 * - 本模块只做解析器覆盖不到的落盘侧强化：
 *   1. **安全解压强化**：解压后逐条 lstat 复查「必须是普通文件」，任何异常 → 中止并**完整清理**目标目录；
 *   2. **可执行文件告警**：扩展名黑名单 → warnings（本插件从不执行 ZIP 内文件）。
 *
 * 与 core 注入点对齐：`parseZipHardened` / `createHardenedZipParser` 满足
 * `ImporterOptions.parseZipOverride` 签名 `(buf, limits?) => ZipArchive`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSameOrChild } from '../utils/paths.ts';
import {
  parseZip,
  ZipArchive,
  ZipSafetyError,
  type ZipSafetyLimits,
} from '../utils/zip.ts';

export { isPathSafe } from '../utils/paths.ts';

/** 可执行文件扩展名黑名单（§19.6：只警告，本插件不执行任何脚本） */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.dll', '.so', '.dylib', '.bin', '.jar',
]);

/** 条目名是否疑似可执行文件（按扩展名） */
export function isExecutableName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/* ---------------- 解析器（默认即最严；此处只保留兼容别名与工厂） ---------------- */

/**
 * 兼容别名 —— **强化检查已并入 core `parseZip`（默认解析器）**，本导出仅为兼容既有调用方
 * （src/core/consult-source.ts 等）与 `ImporterOptions.parseZipOverride` 注入点：
 * 注入它 ≡ 注入默认解析器，行为与「不注入」完全一致。
 */
export const parseZipHardened: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive = parseZip;

/** 工厂：带默认限额的解析器（对齐 ImporterOptions.parseZipOverride 签名）。
 *  不传 defaultLimits 时展开等价于 core 默认限额（parseZip 内部再与 DEFAULT_ZIP_SAFETY_LIMITS 合并），
 *  因此与「不注入 parseZipOverride」的默认路径逐项等价。 */
export function createHardenedZipParser(defaultLimits?: ZipSafetyLimits) {
  return (buf: Uint8Array, limits?: ZipSafetyLimits): ZipArchive =>
    parseZip(buf, { ...defaultLimits, ...limits });
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
 *  - 条目名/限额/symlink/重复名/本地文件头检查（parseZipHardened = core 默认 parseZip）；
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
