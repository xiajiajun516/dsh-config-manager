/**
 * 各分区数据结构：ZIP 内 JSON 分区文件 → 解析/校验。
 * 类型本体在 types.ts；分区集合与 ZIP 内布局由 section-registry.ts **派生**（本文件不再保留副本）。
 *
 * 派生关系（历史上一份事实抄写多份，t29 起收敛）：
 *   SECTION_IDS / SECTION_JSON_PATHS / SECTION_FILE_PREFIXES / isFileSection ← SECTION_REGISTRY
 *   分区载荷版本校验 ← versions.ts 的 sectionDataVersionIssue（注册表 dataVersion 是唯一来源）
 */
import { parseJsonSafe } from '../utils/json.ts';
import { isPathSafe } from '../utils/paths.ts';
import { sectionMetaOf } from './section-registry.ts';
import { sectionDataVersionIssue } from './versions.ts';
import type {
  CredentialsSection, FilesSection, McpSection, PluginsSection,
  PromptsSection, ProvidersSection, SectionData, SectionId,
  SettingsSection, UiSection, WorkspacesSection,
} from './types.ts';

/* —— 分区集合与 ZIP 布局：单一来源是 section-registry.ts，此处仅原样再导出（保持既有 import 路径可用） —— */
export {
  SECTION_IDS,
  SECTION_JSON_PATHS,
  SECTION_FILE_PREFIXES,
  isFileSection,
  SECTION_REGISTRY,
  SECTION_DATA_VERSION,
  sectionMeta,
  sectionMetaOf,
  requireSectionMeta,
  isSectionId,
  jsonPathOf,
  filePrefixOf,
  PORTABLE_SECTION_IDS,
  OPT_IN_SYNC_SECTION_IDS,
  DEFAULT_INCLUDED_SECTION_IDS,
} from './section-registry.ts';
export type {
  SectionMeta,
  SectionPayload,
  SectionPortability,
} from './section-registry.ts';

/** 从 ZIP 内 JSON 解析分区数据（深度保护 + 结构校验） */
export function parseSectionJson<T extends SectionData>(sectionId: SectionId, raw: string): T {
  const parsed = parseJsonSafe(raw) as T;
  const issues = validateSectionData(sectionId, parsed);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`分区 ${sectionId} 数据无效: ${errors.map((e) => e.message).join('; ')}`);
  }
  return parsed;
}

export interface SectionIssue { path: string; message: string; severity: 'error' | 'warning'; }

/**
 * 分区数据结构基础校验（载荷版本 + 顶层形状）—— **由注册表驱动**：
 *  - 版本轴 → `versions.ts` 的 `sectionDataVersionIssue`（注册表 dataVersion 唯一来源）；
 *  - 形状 → `SECTION_REGISTRY[id].payload.kind` 判别联合穷尽 switch（新增载荷形态编译期可见）；
 *  - 未注册 id（只可能来自运行期强转）→ **显式报错**，绝不落到按其它分区语义处理的 default
 *    （历史缺陷在 `core/backup.ts` 的 `engineSnapshotEntry` default 分支：曾把未知分区静默记成
 *    settingsNamespace，导致该分区写入无法回滚；core/config-snapshot.ts:430 附近有对应修复注释）。
 */
export function validateSectionData(sectionId: SectionId, data: unknown): SectionIssue[] {
  const issues: SectionIssue[] = [];
  if (data === null || typeof data !== 'object') {
    return [{ path: '$', message: `分区 ${sectionId} 数据必须是对象`, severity: 'error' }];
  }
  const meta = sectionMetaOf(sectionId);
  if (meta === null) {
    return [{ path: '$', message: `未注册分区 ${String(sectionId)}：拒绝校验（新增分区须在 schema/section-registry.ts 注册）`, severity: 'error' }];
  }
  const obj = data as Record<string, unknown>;
  const versionIssue = sectionDataVersionIssue(meta.id, obj['version']);
  if (versionIssue !== null) {
    issues.push({ path: 'version', message: versionIssue, severity: 'error' });
    return issues;
  }
  const payload = meta.payload;
  switch (payload.kind) {
    case 'namespaces': {
      const ns = obj['namespaces'];
      if (ns === null || typeof ns !== 'object') {
        issues.push({ path: 'namespaces', message: `分区 ${meta.id} 缺少 namespaces 对象`, severity: 'error' });
      } else {
        for (const [name, rec] of Object.entries(ns as Record<string, unknown>)) {
          if (rec === null || typeof rec !== 'object') {
            issues.push({ path: `namespaces.${name}`, message: 'namespace 记录必须是对象', severity: 'error' });
            continue;
          }
          const r = rec as Record<string, unknown>;
          if (typeof r['revision'] !== 'number') issues.push({ path: `namespaces.${name}.revision`, message: 'revision 必须是数字', severity: 'error' });
          if (!('value' in r)) issues.push({ path: `namespaces.${name}.value`, message: '缺少 value', severity: 'error' });
          const secrets = r['secrets'];
          if (secrets !== undefined && !Array.isArray(secrets)) issues.push({ path: `namespaces.${name}.secrets`, message: 'secrets 必须是数组', severity: 'error' });
        }
      }
      break;
    }
    case 'object': {
      const value = obj[payload.key];
      if (value === null || typeof value !== 'object') issues.push({ path: payload.key, message: `缺少 ${payload.key} 对象`, severity: 'error' });
      break;
    }
    case 'array': {
      if (!Array.isArray(obj[payload.key])) issues.push({ path: payload.key, message: `${payload.key} 必须是数组`, severity: 'error' });
      for (const extra of payload.extraArrayKeys ?? []) {
        if (obj[extra] !== undefined && !Array.isArray(obj[extra])) {
          issues.push({ path: extra, message: `${extra} 必须是数组`, severity: 'error' });
        }
      }
      if (payload.validatePatchFiles === true) {
        // issue #35：patchFiles 会被写到 <home>/profiles/<profile>/<relativePath>，必须逐项校验
        // （不可信 bundle 的路径穿越向量——与 file 类分区同级的防线）。
        const patchFiles = obj['patchFiles'];
        if (patchFiles !== undefined) {
          if (!Array.isArray(patchFiles)) {
            issues.push({ path: 'patchFiles', message: 'patchFiles 必须是数组', severity: 'error' });
          } else {
            patchFiles.forEach((pf, i) => {
              const rec = (pf !== null && typeof pf === 'object') ? pf as Record<string, unknown> : null;
              if (rec === null) {
                issues.push({ path: `patchFiles[${i}]`, message: 'patch 文件条目必须是对象', severity: 'error' });
                return;
              }
              const rel = rec['relativePath'];
              if (typeof rel !== 'string' || rel === '' || !isPathSafe(rel)) {
                issues.push({ path: `patchFiles[${i}].relativePath`, message: 'patch 文件路径必须是安全的相对路径（不得为绝对路径或含 ..）', severity: 'error' });
              }
              if (typeof rec['base64'] !== 'string') {
                issues.push({ path: `patchFiles[${i}].base64`, message: 'patch 文件内容必须是 base64 字符串', severity: 'error' });
              }
            });
          }
        }
      }
      break;
    }
    case 'files': {
      if (!Array.isArray(obj['files'])) issues.push({ path: 'files', message: 'files 必须是数组', severity: 'error' });
      break;
    }
    case 'none': {
      // secrets：凭据值走独立加密容器（.credentials.yaml / secrets.enc），没有分区 JSON 可校验
      issues.push({
        path: '$',
        message: `分区 ${meta.id} 无 JSON 载荷（凭据值走独立加密容器，不参与分区 JSON 校验）`,
        severity: 'error',
      });
      break;
    }
    default: {
      // 判别联合已穷尽：新增 payload.kind 时此赋值会编译失败（提醒补校验分支）
      const exhaustive: never = payload;
      issues.push({ path: '$', message: `未处理的分区载荷形态 ${JSON.stringify(exhaustive)}`, severity: 'error' });
    }
  }
  return issues;
}

/** 分区 JSON 载荷的类型收窄（供 adapter / analyzer 使用） */
export function asSettingsSection(data: unknown): SettingsSection { return data as SettingsSection; }
export function asUiSection(data: unknown): UiSection { return data as UiSection; }
export function asProvidersSection(data: unknown): ProvidersSection { return data as ProvidersSection; }
export function asPluginsSection(data: unknown): PluginsSection { return data as PluginsSection; }
export function asMcpSection(data: unknown): McpSection { return data as McpSection; }
export function asPromptsSection(data: unknown): PromptsSection { return data as PromptsSection; }
export function asWorkspacesSection(data: unknown): WorkspacesSection { return data as WorkspacesSection; }
export function asCredentialsSection(data: unknown): CredentialsSection { return data as CredentialsSection; }
export function asFilesSection(data: unknown): FilesSection { return data as FilesSection; }
