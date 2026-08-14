/**
 * manifest.json 的类型、解析、序列化与结构校验。
 * 类型本体在 types.ts（§13.1）；本文件负责 manifest 的读写与结构完整性。
 */
import { parseJsonSafe } from '../utils/json.ts';
import { CURRENT_SCHEMA_VERSION } from './versions.ts';
import type { Manifest, Platform, SectionId } from './types.ts';
import { SECTION_IDS } from './config.ts';

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
    throw new Error(`manifest.json 无效: ${errors.map((e) => e.message).join('; ')}`);
  }
  return parsed as Manifest;
}

export interface ManifestIssue { path: string; message: string; severity: 'error' | 'warning'; }

/** 结构校验：字段类型 / sections 键集合 / security 形状 */
export function validateManifest(m: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (m === null || typeof m !== 'object') {
    return [{ path: '$', message: 'manifest 必须是对象', severity: 'error' }];
  }
  const obj = m as Record<string, unknown>;

  if (typeof obj['schemaVersion'] !== 'number') {
    issues.push({ path: 'schemaVersion', message: 'schemaVersion 必须是数字', severity: 'error' });
  }

  const exporter = obj['exporter'] as Record<string, unknown> | undefined;
  if (!exporter || typeof exporter !== 'object') {
    issues.push({ path: 'exporter', message: 'exporter 缺失', severity: 'error' });
  } else {
    if (typeof exporter['name'] !== 'string') issues.push({ path: 'exporter.name', message: 'exporter.name 必须是字符串', severity: 'error' });
    if (typeof exporter['version'] !== 'string') issues.push({ path: 'exporter.version', message: 'exporter.version 必须是字符串', severity: 'error' });
  }

  const source = obj['source'] as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    issues.push({ path: 'source', message: 'source 缺失', severity: 'error' });
  } else {
    if (typeof source['dshVersion'] !== 'string') issues.push({ path: 'source.dshVersion', message: 'source.dshVersion 必须是字符串', severity: 'error' });
    if (typeof source['platform'] !== 'string') issues.push({ path: 'source.platform', message: 'source.platform 必须是字符串', severity: 'error' });
    if (typeof source['arch'] !== 'string') issues.push({ path: 'source.arch', message: 'source.arch 必须是字符串', severity: 'error' });
  }

  if (typeof obj['exportedAt'] !== 'string' || Number.isNaN(Date.parse(obj['exportedAt']))) {
    issues.push({ path: 'exportedAt', message: 'exportedAt 必须是合法 ISO-8601 时间', severity: 'error' });
  }

  const sections = obj['sections'] as Record<string, unknown> | undefined;
  if (!sections || typeof sections !== 'object') {
    issues.push({ path: 'sections', message: 'sections 缺失', severity: 'error' });
  } else {
    for (const key of Object.keys(sections)) {
      if (!(SECTION_IDS as readonly string[]).includes(key)) {
        issues.push({ path: `sections.${key}`, message: `未知分区 "${key}"`, severity: 'warning' });
      }
      if (typeof sections[key] !== 'boolean') {
        issues.push({ path: `sections.${key}`, message: `sections.${key} 必须是布尔`, severity: 'error' });
      }
    }
  }

  const security = obj['security'] as Record<string, unknown> | undefined;
  if (!security || typeof security !== 'object') {
    issues.push({ path: 'security', message: 'security 缺失', severity: 'error' });
  } else {
    if (typeof security['containsSecrets'] !== 'boolean') issues.push({ path: 'security.containsSecrets', message: 'containsSecrets 必须是布尔', severity: 'error' });
    if (typeof security['encrypted'] !== 'boolean') issues.push({ path: 'security.encrypted', message: 'encrypted 必须是布尔', severity: 'error' });
    const enc = security['encryption'];
    if (enc !== null && (typeof enc !== 'object' || enc === undefined)) {
      issues.push({ path: 'security.encryption', message: 'encryption 必须是对象或 null', severity: 'error' });
    }
  }

  return issues;
}
