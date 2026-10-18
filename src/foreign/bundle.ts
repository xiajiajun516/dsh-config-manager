/**
 * 外部来源的转换结果 → 标准 bundle v1 ZIP。
 *
 * 为什么复用标准 bundle 而不是自造形态：导入侧只需要实现一次「读 bundle」——
 * Importer/analyzer 的全部门禁（checksums 逐条 SHA-256、schema 版本协商、Zip Slip 拒绝、
 * 冲突判定、导入前强制快照、dry-run）自动生效，不需要为外部来源另开一条写入通道。
 *
 * 两个刻意为之的决定：
 *  ① manifest 的**来源标记**只在翻译层给出 `result.origin` 时写入 `manifest.foreign`
 *     （字段形状见 src/schema/types.ts 的 ManifestForeignOrigin；只有标识与计数，绝不含值）。
 *     origin 缺省 = **不写该键**，DSH 自产备份与旧包逐字不变（additive）。
 *     审计结论：标准 bundle v1 原本没有任何「这包从哪来」的字段，外部来源包落盘后与自产备份
 *     逐字同构 ⇒ 用户无法复核来源。本块就是补上这一位（读侧宽容，见 manifest.ts）。
 *  ② source.dshVersion 填**导入目标机**的版本：包内容是为「现在导入」合成的；
 *     填外部工具的版本会让兼容性评分走上一条没有意义的分支（**已知缺陷**：这让评分被
 *     构造性拉满 —— 真实来源事实由 `foreign` 承载，评分口径本身不在本文件范围内）。
 */
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import type { ManifestForeignOrigin, Platform, SectionId } from '../schema/types.ts';
import type { ForeignImportResult, ForeignOrigin, ForeignSkip } from './types.ts';
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

/**
 * ForeignOrigin（翻译层的溯源块）→ ManifestForeignOrigin（manifest 字段形状）。
 *
 * 唯一的形状差异是 **source → agent**（对外契约用 agent 表达「来源是谁」）；其余字段逐字搬运。
 * 两个方向都只带**标识与计数**：凭据只有引用名、诊断只有机器码 —— 这里不做任何裁剪，
 * 因为裁剪会悄悄改写来源事实；不变量由上游 ForeignOrigin 的装配侧保证（本层只搬运）。
 */
function toManifestForeignOrigin(origin: ForeignOrigin): ManifestForeignOrigin {
  return {
    agent: origin.source,
    locations: [...origin.locations],
    ...(origin.sourceVersion !== undefined ? { sourceVersion: origin.sourceVersion } : {}),
    ...(origin.projects !== undefined ? { projects: [...origin.projects] } : {}),
    ...(origin.plugins !== undefined
      ? {
          plugins: origin.plugins.map((p) => ({
            name: p.name,
            ...(p.version !== undefined ? { version: p.version } : {}),
            ...(p.marketplace !== undefined ? { marketplace: p.marketplace } : {}),
            ...(p.repo !== undefined ? { repo: p.repo } : {}),
            ...(p.ref !== undefined ? { ref: p.ref } : {}),
            ...(p.components !== undefined ? { components: [...p.components] } : {}),
          })),
        }
      : {}),
    ...(origin.skipped !== undefined
      ? { skipped: origin.skipped.map((s) => ({ code: s.code, count: s.count })) }
      : {}),
    ...(origin.credentialRefs !== undefined ? { credentialRefs: [...origin.credentialRefs] } : {}),
  };
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
    // origin 缺省 = 不传 ⇒ manifest 里不产生 foreign 键（旧行为逐字不变）
    ...(opts.result.origin !== undefined ? { foreign: toManifestForeignOrigin(opts.result.origin) } : {}),
  });

  // checksums 覆盖除 manifest/checksums 自身以外的全部条目（与 exporter 一致）
  // 注意：foreign 只进 manifest.json，既不是 ZIP 条目、也不参与任何条目摘要 ⇒
  // 同一份内容在「有/无 origin」两种包里的 integrity/checksums.json **逐字相同**。
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
