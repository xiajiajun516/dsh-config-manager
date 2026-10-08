/**
 * 外部来源的转换结果 → 标准 bundle v1 ZIP。
 *
 * 为什么复用标准 bundle 而不是自造形态：导入侧只需要实现一次「读 bundle」——
 * Importer/analyzer 的全部门禁（checksums 逐条 SHA-256、schema 版本协商、Zip Slip 拒绝、
 * 冲突判定、导入前强制快照、dry-run）自动生效，不需要为外部来源另开一条写入通道。
 *
 * 两个刻意为之的决定：
 *  ① manifest 里**不写**外来源标记：schema v1 没有这个字段，硬塞未知字段会被
 *     「已知分区内未知字段」的容忍边界吞掉（读侧不保证保留）。来源由 CLI/UI 文案告知用户。
 *  ② source.dshVersion 填**导入目标机**的版本：包内容是为「现在导入」合成的；
 *     填外部工具的版本会让兼容性评分走上一条没有意义的分支。
 */
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import type { Platform, SectionId } from '../schema/types.ts';
import type { ForeignImportResult, ForeignSkip } from './types.ts';
import { engineMsg } from './messages.ts';

export interface ForeignBundleOptions {
  result: ForeignImportResult;
  /** 目标 ZIP 绝对路径 */
  outPath: string;
  /** 写入 manifest.exporter.version（用本插件版本） */
  exporterVersion: string;
  /** 导入目标机的 DSH 版本（本层不读磁盘，由调用方传入） */
  dshVersion: string;
  platform?: Platform;
  arch?: string;
  /** 测试可注入固定时间 */
  exportedAt?: string;
}

export interface ForeignBundleWritten {
  outPath: string;
  /** 包内条目名（不含 manifest.json / checksums.json），按写入顺序 */
  entryNames: string[];
  /** 实际写入的分区（空分区不会被写入，也不进 manifest.sections） */
  sections: SectionId[];
  skipped: ForeignSkip[];
  credentialRefs: string[];
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function writeForeignBundle(opts: ForeignBundleOptions): Promise<ForeignBundleWritten> {
  const entries: ZipWriteEntry[] = [];
  const flags = {} as Record<SectionId, boolean>;
  const written: SectionId[] = [];

  for (const s of opts.result.sections) {
    if (isFileSection(s.sectionId)) {
      const prefix = SECTION_FILE_PREFIXES[s.sectionId];
      if (prefix === undefined) {
        throw new Error(engineMsg('foreign.bundleFileSectionPrefixMissing', { section: s.sectionId }));
      }
      const files = s.files ?? [];
      if (files.length === 0) continue;
      flags[s.sectionId] = true;
      written.push(s.sectionId);
      for (const f of files) entries.push({ name: prefix + f.relativePath, data: f.data });
    } else {
      const jsonPath = SECTION_JSON_PATHS[s.sectionId];
      if (jsonPath === undefined) {
        throw new Error(engineMsg('foreign.bundleJsonSectionPathMissing', { section: s.sectionId }));
      }
      if (s.data === undefined) continue;
      flags[s.sectionId] = true;
      written.push(s.sectionId);
      entries.push({ name: jsonPath, data: utf8(stringifyJsonSafe(s.data, { space: 2 })) });
    }
  }

  const manifest = buildManifest({
    exporterVersion: opts.exporterVersion,
    dshVersion: opts.dshVersion,
    platform: opts.platform ?? 'linux',
    arch: opts.arch ?? 'unknown',
    sections: flags,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: opts.exportedAt,
  });

  // checksums 覆盖除 manifest/checksums 自身以外的全部条目（与 exporter 一致）
  const contentEntries = entries.filter((e) => e.name !== MANIFEST_FILE && e.name !== CHECKSUMS_FILE);
  entries.push({
    name: CHECKSUMS_FILE,
    data: utf8(stringifyJsonSafe(buildChecksums(contentEntries), { space: 2 })),
  });
  entries.push({ name: MANIFEST_FILE, data: utf8(stringifyJsonSafe(manifest, { space: 2 })) });

  await writeZip(opts.outPath, entries);

  return {
    outPath: opts.outPath,
    entryNames: entries.map((e) => e.name).filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE),
    sections: written,
    skipped: opts.result.skipped,
    credentialRefs: opts.result.credentialRefs,
  };
}
