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
import { schemaMsg } from './messages.ts';
import { sectionMetaOf, type SectionMeta } from './section-registry.ts';
import { sectionDataVersionIssue } from './versions.ts';
import type { SectionData, SectionId } from './types.ts';

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

/**
 * 拿不到元数据就**显式失败**（绝不让未注册分区按其它分区语义继续）。
 * core 侧修正「未知分区静默记成 settingsNamespace」时用它替代 default 分支。
 *
 * t7：本函数原在 `section-registry.ts`；该模块受「只 import 一个类型」的零依赖铁律约束
 * （client bundle 侧 `ui/export-flow.ts` 也在用它），故把唯一的用户可见文案抛出点迁到本文件
 * （已持有本域消息目录）。public surface 不变：`config.ts` 与 `schema/index.ts` 仍照旧导出它。
 */
export function requireSectionMeta(id: string): SectionMeta {
  const meta = sectionMetaOf(id);
  if (meta === null) {
    throw new Error(schemaMsg('schema.sectionNotRegistered', { section: id }));
  }
  return meta;
}

/** 从 ZIP 内 JSON 解析分区数据（深度保护 + 结构校验） */
export function parseSectionJson<T extends SectionData>(sectionId: SectionId, raw: string): T {
  const parsed = parseJsonSafe(raw) as T;
  const issues = validateSectionData(sectionId, parsed);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(schemaMsg('schema.sectionDataInvalid', { section: sectionId, issues: errors.map((e) => e.message).join('; ') }));
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
    return [{ path: '$', message: schemaMsg('schema.sectionDataMustBeObject', { section: sectionId }), severity: 'error' }];
  }
  const meta = sectionMetaOf(sectionId);
  if (meta === null) {
    return [{ path: '$', message: schemaMsg('schema.sectionUnregistered', { section: String(sectionId) }), severity: 'error' }];
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
        issues.push({ path: 'namespaces', message: schemaMsg('schema.namespacesMissing', { section: meta.id }), severity: 'error' });
      } else {
        for (const [name, rec] of Object.entries(ns as Record<string, unknown>)) {
          if (rec === null || typeof rec !== 'object') {
            issues.push({ path: `namespaces.${name}`, message: schemaMsg('schema.namespaceRecordMustBeObject'), severity: 'error' });
            continue;
          }
          const r = rec as Record<string, unknown>;
          if (typeof r['revision'] !== 'number') issues.push({ path: `namespaces.${name}.revision`, message: schemaMsg('schema.revisionMustBeNumber'), severity: 'error' });
          if (!('value' in r)) issues.push({ path: `namespaces.${name}.value`, message: schemaMsg('schema.valueMissing'), severity: 'error' });
          const secrets = r['secrets'];
          if (secrets !== undefined && !Array.isArray(secrets)) issues.push({ path: `namespaces.${name}.secrets`, message: schemaMsg('schema.secretsMustBeArray'), severity: 'error' });
        }
      }
      break;
    }
    case 'object': {
      const value = obj[payload.key];
      if (value === null || typeof value !== 'object') issues.push({ path: payload.key, message: schemaMsg('schema.objectMissing', { key: payload.key }), severity: 'error' });
      break;
    }
    case 'array': {
      if (!Array.isArray(obj[payload.key])) issues.push({ path: payload.key, message: schemaMsg('schema.keyMustBeArray', { key: payload.key }), severity: 'error' });
      for (const extra of payload.extraArrayKeys ?? []) {
        if (obj[extra] !== undefined && !Array.isArray(obj[extra])) {
          issues.push({ path: extra, message: schemaMsg('schema.keyMustBeArray', { key: extra }), severity: 'error' });
        }
      }
      if (payload.validatePatchFiles === true) {
        // issue #35：patchFiles 会被写到 <home>/profiles/<profile>/<relativePath>，必须逐项校验
        // （不可信 bundle 的路径穿越向量——与 file 类分区同级的防线）。
        const patchFiles = obj['patchFiles'];
        if (patchFiles !== undefined) {
          if (!Array.isArray(patchFiles)) {
            issues.push({ path: 'patchFiles', message: schemaMsg('schema.keyMustBeArray', { key: 'patchFiles' }), severity: 'error' });
          } else {
            patchFiles.forEach((pf, i) => {
              const rec = (pf !== null && typeof pf === 'object') ? pf as Record<string, unknown> : null;
              if (rec === null) {
                issues.push({ path: `patchFiles[${i}]`, message: schemaMsg('schema.patchFileEntryMustBeObject'), severity: 'error' });
                return;
              }
              const rel = rec['relativePath'];
              if (typeof rel !== 'string' || rel === '' || !isPathSafe(rel)) {
                issues.push({ path: `patchFiles[${i}].relativePath`, message: schemaMsg('schema.patchFilePathUnsafe'), severity: 'error' });
              }
              if (typeof rec['base64'] !== 'string') {
                issues.push({ path: `patchFiles[${i}].base64`, message: schemaMsg('schema.patchFileContentMustBeBase64'), severity: 'error' });
              }
            });
          }
        }
      }
      break;
    }
    case 'files': {
      const files = obj['files'];
      if (!Array.isArray(files)) {
        issues.push({ path: 'files', message: schemaMsg('schema.keyMustBeArray', { key: 'files' }), severity: 'error' });
        break;
      }
      // 与 patchFiles 同级的防线（此前只判了 Array.isArray）：relativePath 会被写到 <home> 之下，
      // 不可信 bundle 的路径穿越向量必须逐项过 isPathSafe（不得为绝对路径 / 含 ..）。
      files.forEach((entry, i) => {
        const rec = (entry !== null && typeof entry === 'object') ? entry as Record<string, unknown> : null;
        if (rec === null) {
          issues.push({ path: `files[${i}]`, message: schemaMsg('schema.fileEntryMustBeObject'), severity: 'error' });
          return;
        }
        const rel = rec['relativePath'];
        if (typeof rel !== 'string' || rel === '' || !isPathSafe(rel)) {
          issues.push({ path: `files[${i}].relativePath`, message: schemaMsg('schema.filePathUnsafe'), severity: 'error' });
        }
      });
      break;
    }
    case 'none': {
      // secrets：凭据值走独立加密容器（.credentials.yaml / secrets.enc），没有分区 JSON 可校验
      issues.push({
        path: '$',
        message: schemaMsg('schema.sectionNoJsonPayload', { section: meta.id }),
        severity: 'error',
      });
      break;
    }
    default: {
      // 判别联合已穷尽：新增 payload.kind 时此赋值会编译失败（提醒补校验分支）
      const exhaustive: never = payload;
      issues.push({ path: '$', message: schemaMsg('schema.unhandledPayloadKind', { payload: JSON.stringify(exhaustive) }), severity: 'error' });
    }
  }
  return issues;
}

