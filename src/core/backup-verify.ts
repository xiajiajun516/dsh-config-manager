/**
 * 备份 ZIP 只读自检（T2）：回答「三个月前那个导出备份，现在还能不能用」。
 *
 * 动机：`verifySnapshot` 只在**创建快照时**（core/backup.ts）与**恢复时**（core/restore.ts）
 * 被调用；`exports/` 目录里躺着的导出 ZIP 在此之前**没有任何只读校验入口**。本模块补上这一环：
 * 不改一个字节、不依赖 DSH 运行时，只做「结构与完整性」判定，供 CLI `verify` 与 GUI 复用。
 *
 * 判定顺序（任一阶段失败即定 verdict，不继续往下跑）：
 *   1. 文件存在 / 可读            → 否则 `MISSING`（存在但读失败 → `VERIFY_ERROR`）
 *   2. 能作为 ZIP 打开、条目数合理 → 否则 `CORRUPT`
 *   3. 含 `manifest.json` 且过 `parseManifest`；schema 版本在支持范围内
 *                                → 缺/非法 `CORRUPT`；版本超范围 `UNSUPPORTED`
 *   4. 含 `integrity/checksums.json`；逐条目重算 SHA-256 与表比对
 *                                → 任何不符/缺失/损坏 `CORRUPT`，并列出**具体条目名**
 *   5. 自检过程自身异常（磁盘 IO 错等）→ `VERIFY_ERROR`，**绝不降级为 OK**
 *
 * 安全与资源约束：
 *  - 解压一律经 `security/zip-security.ts` 的 `createHardenedZipParser()`（Zip Slip /
 *    压缩炸弹 / symlink 条目 / 重复条目名防护），绝不自己写解压；也**不做落盘解压**
 *    （不使用 `safeExtractHardened`：只读自检不应带写副作用）。
 *  - 完整性比对**复用官方 `verifyChecksums()`**（`utils/hashing.ts`），与导出侧
 *    `buildChecksums()` 同源同口径，避免自写比对造成口径漂移。
 *  - **内存边界（如实说明）**：强化解析器按设计需要完整的 ZIP buffer
 *    （`readEntry` 需随机访问本地文件头），因此本函数持有「1 份原始 ZIP 缓冲」；
 *    条目内容则是**逐条目惰性解压**（`ZipArchive.readEntry` 只解压被请求的那一条，
 *    内部对缓冲做 subarray + CRC32/尺寸/预算校验），故解压峰值 ≈ 原始 ZIP + 当前单条目，
 *    **不会**把全部条目累积在内存里。这里用一个惰性 `ReadonlyMap` 适配器桥接二者
 *    （实测 `verifyChecksums` 只调用 `map.get()`，不会整体物化 Map）。
 *    对 MB 级的 DSH 配置备份完全可接受。
 */
import fs from 'node:fs/promises';
import { verifyChecksums } from '../utils/hashing.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../schema/manifest.ts';
import { describeVersion, isSupported } from '../schema/versions.ts';
import { SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { isArchiveBlob } from '../security/encryption.ts';
import { parseChecksumsTable } from '../security/integrity.ts';
import { createHardenedZipParser } from '../security/zip-security.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type { ZipArchive } from '../utils/zip.ts';

/** 自检裁决（消费方据此决定退出码 / UI 文案；每个值语义互斥） */
export type BackupVerifyVerdict = 'OK' | 'MISSING' | 'CORRUPT' | 'UNSUPPORTED' | 'VERIFY_ERROR';

/** 单次备份自检结果（无敏感字段：不含任何文件内容或凭据） */
export interface BackupVerifyResult {
  /** 被检对象（调用方传入的路径原样回填，便于批量结果对照） */
  file: string;
  verdict: BackupVerifyVerdict;
  sizeBytes?: number;
  entryCount?: number;
  /** manifest.sections 中声明为 true 的分区（按 manifest 顺序） */
  sections?: string[];
  /** manifest.exportedAt（原样透传，不重新格式化） */
  exportedAt?: string;
  /** 致命问题（中文 / English 并列，CLI 直接打印） */
  errors: string[];
  /** 非致命提示（未纳入校验表的条目、声明分区缺条目等） */
  warnings: string[];
}

/** 未纳入 checksums 表参与的条目（这两个是校验表自身的容器，按导出器语义不参与） */
const NON_DATA_ENTRIES = new Set<string>([MANIFEST_FILE, CHECKSUMS_FILE]);

/**
 * 惰性解压的条目视图（`Map<string, Uint8Array>` 子类）。
 *
 * 为什么要它：官方 `verifyChecksums(entries, table)` 需要 `ReadonlyMap`，而若传入一个
 * **真正填满的 Map**，就必须先把**全部条目解压后常驻内存**——与「边读边算」的内存边界要求冲突。
 * 实测 `verifyChecksums` 只调用 `map.get()`（不遍历、不读 size/entries），因此这里按需解压：
 * 每次 `get(name)` 才调用一次 `archive.readEntry(name)`，算完即可被 GC 回收；
 * 底层 super Map 始终为空（不物化任何条目）。
 *
 * 选择 `extends Map` 而非 `implements ReadonlyMap`：继承可自动获得与当前 TS lib 版本
 * 完全一致的迭代器类型（`MapIterator`），无需手工复刻迭代器签名，也不会因 lib 升级而失配。
 *
 * 语义要点：
 *  - 归档中不存在的条目 → 返回 `undefined`，由 `verifyChecksums` 归类为 `missing`；
 *  - 条目存在但解压/CRC 失败（`ZipSafetyError`）→ 记入 `unreadable` 并返回空缓冲，
 *    调用方据此把 verdict 强制为 CORRUPT（空缓冲几乎必然 hash 不符）。
 */
class LazyEntryMap extends Map<string, Uint8Array> {
  private readonly archive: ZipArchive;
  private readonly unreadable: Set<string>;
  private readonly onUnreadable: (name: string, reason: string) => void;

  constructor(archive: ZipArchive, unreadable: Set<string>, onUnreadable: (name: string, reason: string) => void) {
    super(); // 底层 Map 刻意保持为空：条目一律按需解压，绝不物化
    this.archive = archive;
    this.unreadable = unreadable;
    this.onUnreadable = onUnreadable;
  }

  override get(name: string): Uint8Array | undefined {
    if (!this.archive.has(name)) return undefined;
    try {
      return this.archive.readEntry(name);
    } catch (err) {
      // 条目在但读不出来（CRC32 失败 / 尺寸不符 / 预算超限）：如实记录，不中断整体扫描
      this.unreadable.add(name);
      this.onUnreadable(name, err instanceof Error ? err.message : String(err));
      return new Uint8Array(0);
    }
  }

  override has(name: string): boolean {
    return this.archive.has(name);
  }

  /** 归档条目总数（覆盖空 super Map 的 0，语义与「视图」一致） */
  override get size(): number {
    return this.archive.entries().length;
  }

  /** 供调用方从 mismatches 中去重（unreadable 条目返回空缓冲，可能同时命中 hash 不符） */
  isUnreadable(name: string): boolean {
    return this.unreadable.has(name);
  }
}

/** 整体加密容器内的凭据密文条目（导出器写入；用正则匹配以免与分区 id 的字面量耦合） */
const SECRETS_ENC_RE = /^security\/[^/]*\.enc$/;

function msgOfError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** 空结果骨架（各阶段失败时统一构造，避免漏字段） */
function makeResult(file: string, verdict: BackupVerifyVerdict, errors: string[], warnings: string[]): BackupVerifyResult {
  return { file, verdict, errors, warnings };
}

/**
 * 只读自检一个备份 ZIP（或整体加密容器 `.dca1`）。
 * 纯 IO 注入式实现：仅用 `node:fs/promises` + 本仓库零 DSH 依赖模块，CLI 离线可跑。
 * 永不抛错（除自检过程异常归一为 `VERIFY_ERROR`），调用方据 `verdict` 决定行为。
 */
export async function verifyBackupZip(zipPath: string): Promise<BackupVerifyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  /* ---------------- 1. 存在 / 可读 ---------------- */
  let sizeBytes: number;
  let buf: Buffer;
  try {
    const stat = await fs.stat(zipPath);
    if (!stat.isFile()) {
      errors.push(`不是普通文件（目录或特殊文件）/ not a regular file: ${zipPath}`);
      return makeResult(zipPath, 'MISSING', errors, warnings);
    }
    sizeBytes = stat.size;
    buf = await fs.readFile(zipPath);
  } catch (err) {
    if (isENOENT(err)) {
      errors.push(`备份文件不存在 / backup file not found: ${zipPath}`);
      return makeResult(zipPath, 'MISSING', errors, warnings);
    }
    // 文件在但读不动（EACCES / EBUSY / IO 错）：这是自检自身的失败，不是「备份坏了」
    errors.push(`备份文件不可读 / backup file unreadable: ${msgOfError(err)}`);
    return makeResult(zipPath, 'VERIFY_ERROR', errors, warnings);
  }

  /** 已知字节数后的骨架（后续阶段失败时保留体积信息） */
  const withSize = (verdict: BackupVerifyVerdict): BackupVerifyResult => ({
    file: zipPath, verdict, sizeBytes, errors, warnings,
  });

  try {
    /* ---------------- 2. 打开为 ZIP ---------------- */
    // 整体加密容器不是 ZIP（先识别，给出比「ZIP 损坏」准确得多的结论）
    if (isArchiveBlob(buf)) {
      errors.push('整体加密备份容器（DCA1）需先用密码解密为 ZIP 才能自检 / encrypted container must be decrypted first');
      return withSize('UNSUPPORTED');
    }

    let archive: ZipArchive;
    try {
      archive = createHardenedZipParser()(buf);
    } catch (err) {
      errors.push(`ZIP 无法打开 / cannot open as ZIP: ${msgOfError(err)}`);
      return withSize('CORRUPT');
    }
    const metas = archive.entries();
    const entryCount = metas.length;
    const withEntries = (verdict: BackupVerifyVerdict): BackupVerifyResult => ({
      file: zipPath, verdict, sizeBytes, entryCount, errors, warnings,
    });
    if (entryCount === 0) {
      errors.push('空 ZIP（0 条目）/ empty archive');
      return withEntries('CORRUPT');
    }

    /* ---------------- 3. manifest.json ---------------- */
    if (!archive.has(MANIFEST_FILE)) {
      errors.push(`缺少 ${MANIFEST_FILE}（不是本插件导出的备份）/ ${MANIFEST_FILE} missing`);
      return withEntries('CORRUPT');
    }
    let manifestRaw: string;
    try {
      manifestRaw = archive.readEntryText(MANIFEST_FILE);
    } catch (err) {
      // 条目本身读不出来（CRC 失败/解压失败）→ 归档损坏，而非 manifest 语义非法
      errors.push(`${MANIFEST_FILE} 无法读取（归档损坏）/ unreadable entry: ${msgOfError(err)}`);
      return withEntries('CORRUPT');
    }
    let manifest: Manifest;
    try {
      manifest = parseManifest(manifestRaw);
    } catch (err) {
      errors.push(`${MANIFEST_FILE} 非法 / invalid manifest: ${msgOfError(err)}`);
      return withEntries('CORRUPT');
    }
    const sections = Object.entries(manifest.sections ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id);
    const withManifest = (verdict: BackupVerifyVerdict): BackupVerifyResult => ({
      file: zipPath, verdict, sizeBytes, entryCount, sections, exportedAt: manifest.exportedAt, errors, warnings,
    });

    if (!isSupported(manifest.schemaVersion)) {
      // 版本超范围是「本插件读不了」，不是「备份坏了」——明确区分，避免误导用户重导
      errors.push(`schema 版本不受支持 / unsupported schema version: ${describeVersion(manifest.schemaVersion)}`);
      return withManifest('UNSUPPORTED');
    }

    /* ---------------- 4. integrity/checksums.json ---------------- */
    if (!archive.has(CHECKSUMS_FILE)) {
      errors.push(`缺少 ${CHECKSUMS_FILE}（无法做完整性校验）/ ${CHECKSUMS_FILE} missing`);
      return withManifest('CORRUPT');
    }
    let table: Record<string, string>;
    try {
      table = parseChecksumsTable(archive.readEntryText(CHECKSUMS_FILE));
    } catch (err) {
      // readEntryText 的 CRC/解压失败与「表结构非法」都归 CORRUPT（两者都说明备份不可信）
      errors.push(`${CHECKSUMS_FILE} 非法或不可读 / invalid or unreadable checksums table: ${msgOfError(err)}`);
      return withManifest('CORRUPT');
    }

    // 4a. 完整性比对：**复用官方 verifyChecksums**（与导出侧 buildChecksums 同源同口径），
    //     把「逐条目比对」的语义交给它；解压仍走惰性适配器，不整体物化条目。
    const unreadableNames = new Set<string>();
    const unreadable: string[] = [];
    const lazyEntries = new LazyEntryMap(archive, unreadableNames, (name, reason) => {
      unreadable.push(`${name}（${reason}）`);
    });
    const tableKeys = Object.keys(table);
    const check = verifyChecksums(lazyEntries, table);
    // unreadable 条目返回空缓冲，可能同时落入 mismatches → 剔除以免重复报同一问题
    const mismatched = check.mismatches.filter((n) => !lazyEntries.isUnreadable(n));
    const missing = check.missing;

    // 4b. 结构提示：未纳入校验表的条目（导出器只把 manifest 与校验表自身排除在外）
    if (tableKeys.length === 0) {
      if (entryCount > NON_DATA_ENTRIES.size) {
        errors.push('校验表为空但归档含数据条目 / empty checksums table with data entries');
        return withManifest('CORRUPT');
      }
      warnings.push('校验表为空（归档仅含 manifest 与校验表自身）/ empty checksums table');
    }
    const covered = new Set(tableKeys);
    const uncovered = metas
      .filter((m) => !m.isDirectory && !NON_DATA_ENTRIES.has(m.name) && !covered.has(m.name))
      .map((m) => m.name);
    if (uncovered.length > 0) {
      const shown = uncovered.slice(0, 5).join(', ');
      warnings.push(`含未纳入校验表的条目 ${uncovered.length} 个 / entries not covered by checksums: ${shown}${uncovered.length > 5 ? ', …' : ''}`);
    }

    // 4c. 结构提示：manifest 声明包含的分区在归档内应有对应条目
    for (const id of sections) {
      const prefix = SECTION_FILE_PREFIXES[id as SectionId];
      const jsonPath = SECTION_JSON_PATHS[id as SectionId];
      if (prefix !== undefined) {
        if (!metas.some((m) => m.name.startsWith(prefix) && m.name !== prefix)) {
          warnings.push(`manifest 声明分区 ${id} 但归档内无对应文件 / declared section has no entries: ${id}`);
        }
      } else if (jsonPath !== undefined && !archive.has(jsonPath)) {
        warnings.push(`manifest 声明分区 ${id} 但缺少 ${jsonPath} / declared section payload missing: ${id}`);
      }
    }
    if (manifest.security?.encrypted === true && !metas.some((m) => SECRETS_ENC_RE.test(m.name))) {
      warnings.push('manifest 标记加密但归档内无凭据密文条目 / encrypted flag without secrets entry');
    }

    /* ---------------- 裁决 ---------------- */
    if (missing.length > 0) {
      errors.push(`校验表内条目缺失（${missing.length}）/ missing entries: ${missing.join(', ')}`);
    }
    if (mismatched.length > 0) {
      errors.push(`条目 SHA-256 不符（${mismatched.length}）/ hash mismatch: ${mismatched.join(', ')}`);
    }
    if (unreadable.length > 0) {
      errors.push(`条目无法读取（${unreadable.length}）/ unreadable entries: ${unreadable.join(', ')}`);
    }
    return withManifest(missing.length > 0 || mismatched.length > 0 || unreadable.length > 0 ? 'CORRUPT' : 'OK');
  } catch (err) {
    // 5. 自检自身异常：如实报 VERIFY_ERROR，绝不降级成 OK
    errors.push(`自检过程异常 / verification error: ${msgOfError(err)}`);
    return withSize('VERIFY_ERROR');
  }
}
