/**
 * 迁移前咨询的源读取（Phase 7，只读分析层）。
 *
 * 把 4 种可迁移源（export-zip / local-snapshot / remote-snapshot / profile）归一化为
 * `ConsultSourceData`，供 `computeConsultReport` 评分。本模块**只读**：
 *  - 读 ZIP / 快照 / profile 文件；
 *  - 复用安全/schema 工具（parseZipHardened / parseManifest / verifyChecksumsJson /
 *    validateSectionData / scanAndRedact / scanText）；
 *  - 可迁移性经宿主注入的 `computeMigratability`（analyzeImport / createImportPlan，零写入）。
 *
 * READ-ONLY 磁盘边界：临时 ZIP 可写但必须净空（调用方负责 try/finally 清理）；
 * 配置 / 快照存储 / journal 零写。
 */
import fs from 'node:fs/promises';
import { parseZipHardened } from '../security/zip-security.ts';
import { MANIFEST_FILE, CHECKSUMS_FILE, parseManifest, validateManifest, type ManifestIssue } from '../schema/manifest.ts';
import { verifyChecksumsJson } from '../security/integrity.ts';
import { SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts';
import { scanAndRedact, scanText } from '../security/secret-scanner.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type { ConsultSourceData, ConsultSourceRef, MigratabilityResult } from './migration-consult.ts';

export interface ConsultSourceReaderOptions {
  /** 计算可迁移性（宿主注入；缺省 null = 不评估） */
  computeMigratability?: (zipPath: string) => Promise<MigratabilityResult>;
  /** 高熵扫描开关（固定 true 保证确定性；缺省 true） */
  highEntropy?: boolean;
}

/** 从导出 ZIP 读取并归一化源数据（只读） */
export async function readExportZipSource(
  ref: ConsultSourceRef,
  zipPath: string,
  opts: ConsultSourceReaderOptions = {},
): Promise<ConsultSourceData> {
  const highEntropy = opts.highEntropy ?? true;
  const raw = await fs.readFile(zipPath);

  // 1. 安全解析 ZIP（捕获 Zip Slip / 结构问题）
  const zipSlipIssues: string[] = [];
  let archive;
  try {
    archive = parseZipHardened(raw);
  } catch (err) {
    zipSlipIssues.push(err instanceof Error ? err.message : String(err));
    return {
      source: ref,
      manifest: null,
      manifestIssues: [],
      sections: new Map(),
      sectionFiles: new Map(),
      checksums: null,
      checksumIssues: [],
      zipSlipIssues,
      encrypted: false,
      containsSecrets: false,
      sourceDsh: '',
      sourcePlatform: '',
      schemaVersion: 0,
      missingSections: [],
      sensitiveHits: [],
      migratability: null,
    };
  }

  // 2. manifest（捕获结构问题，不抛错）
  let manifest: Manifest | null = null;
  let manifestIssues: ManifestIssue[] = [];
  if (archive.has(MANIFEST_FILE)) {
    try {
      manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    } catch {
      // parseManifest 抛错 → 用 validateManifest 捕获具体问题
      try {
        const parsed = JSON.parse(archive.readEntryText(MANIFEST_FILE));
        manifestIssues = validateManifest(parsed);
      } catch {
        manifestIssues = [{ path: '$', message: 'manifest 无法解析', severity: 'error' }];
      }
    }
  } else {
    manifestIssues = [{ path: '$', message: 'manifest 缺失', severity: 'error' }];
  }

  // 3. checksums（捕获不匹配，不抛错）
  const checksumIssues: string[] = [];
  let checksums: Record<string, string> | null = null;
  if (archive.has(CHECKSUMS_FILE)) {
    try {
      const entries = new Map<string, Uint8Array>();
      for (const name of archive.names()) {
        if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
        try { entries.set(name, archive.readEntry(name)); } catch { /* 损坏条目计入 checksumIssues */ }
      }
      const result = verifyChecksumsJson(entries, archive.readEntryText(CHECKSUMS_FILE));
      checksums = result.ok ? {} : null;
      for (const m of result.mismatches) checksumIssues.push(`"${m}" (hash 不符)`);
      for (const m of result.missing) checksumIssues.push(`"${m}" (缺失)`);
    } catch (err) {
      checksumIssues.push(err instanceof Error ? err.message : String(err));
    }
  }

  // 4. 提取分区（捕获缺失/不可解析）
  const sections = new Map<SectionId, unknown>();
  const sectionFiles = new Map<string, Uint8Array>();
  const missingSections: SectionId[] = [];
  if (manifest !== null) {
    for (const [sid, enabled] of Object.entries(manifest.sections) as [SectionId, boolean][]) {
      if (!enabled) continue;
      if (isFileSection(sid)) {
        const prefix = SECTION_FILE_PREFIXES[sid]!;
        for (const name of archive.names()) {
          if (!name.startsWith(prefix) || name === prefix) continue;
          const rel = name.slice(prefix.length);
          if (rel === '' || rel.endsWith('/')) continue;
          sectionFiles.set(`${sid}/${rel}`, archive.readEntry(name));
        }
        sections.set(sid, { version: 1, files: [] });
        continue;
      }
      const jsonPath = SECTION_JSON_PATHS[sid];
      if (jsonPath === undefined) continue;
      if (!archive.has(jsonPath)) {
        missingSections.push(sid);
        continue;
      }
      try {
        sections.set(sid, archive.readEntryJson(jsonPath));
      } catch {
        missingSections.push(sid);
      }
    }
  }

  // 5. 敏感暴露面（scanAndRedact 结构化 + scanText 文件类）
  const sensitiveHits = [];
  for (const [sid, data] of sections) {
    const { hits } = scanAndRedact(data, { highEntropy });
    for (const h of hits) sensitiveHits.push({ path: `${sid}:${h.path}`, field: h.field });
  }
  for (const [key, bytes] of sectionFiles) {
    const text = Buffer.from(bytes).toString('utf8');
    for (const h of scanText(text, { highEntropy })) {
      sensitiveHits.push({ path: `${key}:${h.path}`, field: h.field });
    }
  }

  // 6. 可迁移性（宿主注入；零写入）
  const migratability = opts.computeMigratability !== undefined
    ? await opts.computeMigratability(zipPath)
    : null;

  return {
    source: ref,
    manifest,
    manifestIssues,
    sections,
    sectionFiles,
    checksums,
    checksumIssues,
    zipSlipIssues,
    encrypted: manifest?.security.encrypted ?? false,
    containsSecrets: manifest?.security.containsSecrets ?? false,
    sourceDsh: manifest?.source.dshVersion ?? '',
    sourcePlatform: manifest?.source.platform ?? '',
    schemaVersion: manifest?.schemaVersion ?? 0,
    missingSections,
    sensitiveHits,
    migratability,
  };
}

/* ---------------- 非 ZIP 源（local-snapshot / profile） ---------------- */

export interface LocalSnapshotSourceInput {
  /** 快照捕获的分区数据（按 adapter 分组；best-effort） */
  sections: Map<SectionId, unknown>;
  /** 快照完整性校验结果（verifySnapshot） */
  verify: { ok: boolean; reason?: string };
  /** 恢复计划（planRestore）→ 可迁移性 */
  restorePlan: { itemCount: number; conflicts: number; warnings: number; sections: SectionId[]; errors: string[] };
  /** 合成 manifest 的源信息（宿主 dshVersion/platform） */
  sourceDsh: string;
  sourcePlatform: string;
}

/**
 * 从本地快照（rollback 点）构建 ConsultSourceData。
 * 快照无导出 manifest → 用合成 manifest（schemaVersion=1，sections 来自捕获分区），
 * 避免「无导出 manifest」被误判为 compatibility/integrity critical。
 * 完整性 = verifySnapshot（blob hashes / metadataHash）；可迁移性 = planRestore。
 */
export function buildLocalSnapshotSource(
  ref: ConsultSourceRef,
  input: LocalSnapshotSourceInput,
): ConsultSourceData {
  const sectionFlags = {} as Record<SectionId, boolean>;
  for (const sid of input.sections.keys()) sectionFlags[sid] = true;
  const manifest: Manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'snapshot' },
    source: { dshVersion: input.sourceDsh, platform: input.sourcePlatform as Manifest['source']['platform'], arch: 'unknown' },
    exportedAt: new Date().toISOString(),
    sections: sectionFlags,
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  const manifestIssues = input.verify.ok ? [] : [{ path: '$', message: input.verify.reason ?? '快照完整性校验失败', severity: 'error' as const }];
  const checksumIssues = input.verify.ok ? [] : [input.verify.reason ?? '快照完整性校验失败'];
  const migratability: MigratabilityResult = {
    ok: input.restorePlan.errors.length === 0,
    itemCount: input.restorePlan.itemCount,
    fatalConflicts: input.restorePlan.conflicts,
    warnings: input.restorePlan.warnings,
    sections: input.restorePlan.sections,
    errors: input.restorePlan.errors,
  };
  return {
    source: ref,
    manifest,
    manifestIssues,
    sections: input.sections,
    sectionFiles: new Map(),
    checksums: input.verify.ok ? {} : null,
    checksumIssues,
    zipSlipIssues: [],
    encrypted: false,
    containsSecrets: false,
    sourceDsh: input.sourceDsh,
    sourcePlatform: input.sourcePlatform,
    schemaVersion: 1,
    missingSections: [],
    sensitiveHits: [],
    migratability,
  };
}

export interface ProfileSourceInput {
  /** profile 的分区数据（decodeSections） */
  sections: Map<SectionId, unknown>;
  /** 切换预览（analyzeSwitch）→ 可迁移性 */
  switchPreview: { itemCount: number; conflicts: number; warnings: number; sections: SectionId[]; errors: string[] };
  /** 合成 manifest 的源信息（宿主 dshVersion/platform） */
  sourceDsh: string;
  sourcePlatform: string;
}

/**
 * 从配置档案（profile.json）构建 ConsultSourceData。
 * profile 无导出 manifest → 用合成 manifest（sections 来自 profile 分区）。
 * 可迁移性 = analyzeSwitch（切换预览计划项）。
 */
export function buildProfileSource(
  ref: ConsultSourceRef,
  input: ProfileSourceInput,
): ConsultSourceData {
  const sectionFlags = {} as Record<SectionId, boolean>;
  for (const sid of input.sections.keys()) sectionFlags[sid] = true;
  const manifest: Manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'profile' },
    source: { dshVersion: input.sourceDsh, platform: input.sourcePlatform as Manifest['source']['platform'], arch: 'unknown' },
    exportedAt: new Date().toISOString(),
    sections: sectionFlags,
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  const migratability: MigratabilityResult = {
    ok: input.switchPreview.errors.length === 0,
    itemCount: input.switchPreview.itemCount,
    fatalConflicts: input.switchPreview.conflicts,
    warnings: input.switchPreview.warnings,
    sections: input.switchPreview.sections,
    errors: input.switchPreview.errors,
  };
  return {
    source: ref,
    manifest,
    manifestIssues: [],
    sections: input.sections,
    sectionFiles: new Map(),
    checksums: {},
    checksumIssues: [],
    zipSlipIssues: [],
    encrypted: false,
    containsSecrets: false,
    sourceDsh: input.sourceDsh,
    sourcePlatform: input.sourcePlatform,
    schemaVersion: 1,
    missingSections: [],
    sensitiveHits: [],
    migratability,
  };
}
