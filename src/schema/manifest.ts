/**
 * manifest.json 的类型、解析、序列化与结构校验。
 * 类型本体在 types.ts（§13.1）；本文件负责 manifest 的读写与结构完整性。
 */
import { parseJsonSafe } from '../utils/json.ts';
import { CURRENT_SCHEMA_VERSION } from './versions.ts';
import type { Manifest, ManifestForeignOrigin, Platform, SectionId } from './types.ts';
import { SECTION_IDS } from './config.ts';
import { schemaMsg } from './messages.ts';

export const MANIFEST_FILE = 'manifest.json';
export const CHECKSUMS_FILE = 'integrity/checksums.json';
export const EXPORTER_NAME = 'DSH Config Manager';

export interface BuildManifestInput {
  exporterVersion: string;
  dshVersion: string;
  platform: Platform;
  arch: string;
  sections: Record<SectionId, boolean>;
  containsSecrets: boolean;
  encrypted: boolean;
  encryption: Manifest['security']['encryption'];
  exportedAt?: string; // 测试可注入固定时间
  /** 导出机的 DSH home（可选；见 Manifest.sourceHome，用于跨机基础路径重定基） */
  sourceHome?: string;
  /**
   * 外部来源包的溯源块（可选；见 Manifest.foreign）。
   * **只有显式传入时才写入** —— 缺省不产生该键，DSH 自产备份与旧包逐字不变。
   */
  foreign?: ManifestForeignOrigin;
}

/** 构造 manifest（schemaVersion 恒为当前版本，集中于此） */
export function buildManifest(input: BuildManifestInput): Manifest {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exporter: { name: EXPORTER_NAME, version: input.exporterVersion },
    source: {
      dshVersion: input.dshVersion,
      platform: input.platform,
      arch: input.arch,
    },
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    ...(input.sourceHome !== undefined && input.sourceHome !== '' ? { sourceHome: input.sourceHome } : {}),
    ...(input.foreign !== undefined ? { foreign: input.foreign } : {}),
    sections: input.sections,
    security: {
      containsSecrets: input.containsSecrets,
      encrypted: input.encrypted,
      encryption: input.encryption,
    },
  };
}

/** 序列化（pretty JSON，供 ZIP 内 manifest.json） */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}

/** 解析 + 结构校验；非法输入抛错（导入第一道闸之一） */
export function parseManifest(raw: string): Manifest {
  const parsed = parseJsonSafe(raw);
  const issues = validateManifest(parsed);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(schemaMsg('schema.manifestInvalid', { issues: errors.map((e) => e.message).join('; ') }));
  }
  return parsed as Manifest;
}

export interface ManifestIssue { path: string; message: string; severity: 'error' | 'warning'; }

/**
 * `manifest.foreign`（外部来源溯源块）的**宽容校验**。
 *
 * 铁律：本字段**绝不允许**成为拒绝一个包的理由 —— 旧包没有它、新包可能带畸形值，
 * 两者都必须能继续导入。因此这里只产出 `warning`，且**只落一条**汇总（路径恒为 `foreign`），
 * 出错字段名以机器码形式列在文案参数里（不逐字段刷屏、不新增用户可见文案）。
 */
function validateForeignOrigin(value: unknown): ManifestIssue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{
      path: 'foreign',
      message: schemaMsg('schema.sectionDataInvalid', { section: 'manifest.foreign', issues: 'not-an-object' }),
      severity: 'warning',
    }];
  }
  const f = value as Record<string, unknown>;
  const bad: string[] = [];
  if (typeof f['agent'] !== 'string') bad.push('agent');
  if (f['locations'] !== undefined && !isStringArray(f['locations'])) bad.push('locations');
  if (f['sourceVersion'] !== undefined && typeof f['sourceVersion'] !== 'string') bad.push('sourceVersion');
  if (f['projects'] !== undefined && !isStringArray(f['projects'])) bad.push('projects');
  if (f['credentialRefs'] !== undefined && !isStringArray(f['credentialRefs'])) bad.push('credentialRefs');
  if (f['skipped'] !== undefined && !isSkippedAggregates(f['skipped'])) bad.push('skipped');
  if (f['plugins'] !== undefined && !isPluginSummaries(f['plugins'])) bad.push('plugins');
  if (bad.length === 0) return [];
  return [{
    path: 'foreign',
    message: schemaMsg('schema.sectionDataInvalid', { section: 'manifest.foreign', issues: bad.join(',') }),
    severity: 'warning',
  }];
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isSkippedAggregates(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object'
    && typeof (v as Record<string, unknown>)['code'] === 'string'
    && typeof (v as Record<string, unknown>)['count'] === 'number');
}

function isPluginSummaries(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object'
    && typeof (v as Record<string, unknown>)['name'] === 'string');
}

/** 结构校验：字段类型 / sections 键集合 / security 形状 */
export function validateManifest(m: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (m === null || typeof m !== 'object') {
    return [{ path: '$', message: schemaMsg('schema.manifestMustBeObject'), severity: 'error' }];
  }
  const obj = m as Record<string, unknown>;

  if (typeof obj['schemaVersion'] !== 'number') {
    issues.push({ path: 'schemaVersion', message: schemaMsg('schema.schemaVersionMustBeNumber'), severity: 'error' });
  }

  const exporter = obj['exporter'] as Record<string, unknown> | undefined;
  if (!exporter || typeof exporter !== 'object') {
    issues.push({ path: 'exporter', message: schemaMsg('schema.exporterMissing'), severity: 'error' });
  } else {
    if (typeof exporter['name'] !== 'string') issues.push({ path: 'exporter.name', message: schemaMsg('schema.exporterNameMustBeString'), severity: 'error' });
    if (typeof exporter['version'] !== 'string') issues.push({ path: 'exporter.version', message: schemaMsg('schema.exporterVersionMustBeString'), severity: 'error' });
  }

  const source = obj['source'] as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    issues.push({ path: 'source', message: schemaMsg('schema.sourceMissing'), severity: 'error' });
  } else {
    if (typeof source['dshVersion'] !== 'string') issues.push({ path: 'source.dshVersion', message: schemaMsg('schema.sourceDshVersionMustBeString'), severity: 'error' });
    if (typeof source['platform'] !== 'string') issues.push({ path: 'source.platform', message: schemaMsg('schema.sourcePlatformMustBeString'), severity: 'error' });
    if (typeof source['arch'] !== 'string') issues.push({ path: 'source.arch', message: schemaMsg('schema.sourceArchMustBeString'), severity: 'error' });
  }

  if (typeof obj['exportedAt'] !== 'string' || Number.isNaN(Date.parse(obj['exportedAt']))) {
    issues.push({ path: 'exportedAt', message: schemaMsg('schema.exportedAtInvalid'), severity: 'error' });
  }

  const sections = obj['sections'] as Record<string, unknown> | undefined;
  if (!sections || typeof sections !== 'object') {
    issues.push({ path: 'sections', message: schemaMsg('schema.sectionsMissing'), severity: 'error' });
  } else {
    for (const key of Object.keys(sections)) {
      if (!(SECTION_IDS as readonly string[]).includes(key)) {
        issues.push({ path: `sections.${key}`, message: schemaMsg('schema.unknownSection', { section: key }), severity: 'warning' });
      }
      if (typeof sections[key] !== 'boolean') {
        issues.push({ path: `sections.${key}`, message: schemaMsg('schema.sectionFlagMustBeBoolean', { section: key }), severity: 'error' });
      }
    }
  }

  const security = obj['security'] as Record<string, unknown> | undefined;
  if (!security || typeof security !== 'object') {
    issues.push({ path: 'security', message: schemaMsg('schema.securityMissing'), severity: 'error' });
  } else {
    if (typeof security['containsSecrets'] !== 'boolean') issues.push({ path: 'security.containsSecrets', message: schemaMsg('schema.containsSecretsMustBeBoolean'), severity: 'error' });
    if (typeof security['encrypted'] !== 'boolean') issues.push({ path: 'security.encrypted', message: schemaMsg('schema.encryptedMustBeBoolean'), severity: 'error' });
    const enc = security['encryption'];
    if (enc !== null && (typeof enc !== 'object' || enc === undefined)) {
      issues.push({ path: 'security.encryption', message: schemaMsg('schema.encryptionMustBeObjectOrNull'), severity: 'error' });
    }
  }

  // foreign 是**外部来源包**的溯源块：缺省 = 旧包（合法）；形状/字段类型不对 = 仅 warning（绝不拒绝）。
  if (obj['foreign'] !== undefined) issues.push(...validateForeignOrigin(obj['foreign']));

  return issues;
}
