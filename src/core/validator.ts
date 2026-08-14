/**
 * 整体校验与兼容性评分（规范 §18 完整性 / §30 兼容性评分 / 导入后校验）。
 */
import { validateManifest } from '../schema/manifest.ts';
import { validateSectionData } from '../schema/config.ts';
import { canImport, describeVersion } from '../schema/versions.ts';
import type { SectionId } from '../schema/types.ts';
import type { CompatibilityInput, CompatibilityScore, ValidationResult } from './types.ts';

export { validateManifest } from '../schema/manifest.ts';
export { validateSectionData } from '../schema/config.ts';

/** 校验 ZIP 内分区数据集合（空对象=合法）；返回合并的校验结果 */
export function validateSections(
  sections: ReadonlyMap<SectionId, unknown>,
): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  for (const [sectionId, data] of sections) {
    const sectionIssues = validateSectionData(sectionId, data);
    for (const issue of sectionIssues) {
      issues.push({ ...issue, path: `${sectionId}:${issue.path}` });
    }
  }
  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

function parseVersion(v: string): { major: number; minor: number; patch: number; pre: number } {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(?:rc\.?)?(\d+))?/i.exec(v);
  if (!m) return { major: 0, minor: 0, patch: 0, pre: 0 };
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), pre: Number(m[4] ?? Infinity) };
}

/** 版本比较：-1=a<b，0=相等，1=a>b（预发布 < 正式版） */
function compareVersions(a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): -1 | 0 | 1 {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (a.pre !== b.pre) return a.pre < b.pre ? -1 : 1;
  return 0;
}

/**
 * 兼容性评分（规则驱动，不凭感觉）：
 *  unsupported — schema 超出本插件支持范围（过高/过低）
 *  partial     — 跨平台、分区缺失、或备份 DSH 比目标新
 *  good        — 备份 DSH 比目标旧（向后兼容）且其余正常
 *  excellent   — 同平台、无缺失、schema 支持
 */
export function computeCompatibility(input: CompatibilityInput): CompatibilityScore {
  if (!canImport(input.schemaVersion)) return 'unsupported';

  let score: CompatibilityScore = 'excellent';

  if (input.sourcePlatform !== input.targetPlatform) score = 'partial';
  if (input.missingSections.length > 0) score = 'partial';

  const src = parseVersion(input.sourceDsh);
  const tgt = parseVersion(input.targetDsh);
  const cmp = compareVersions(src, tgt);
  if (cmp > 0) {
    // 备份来自更新的 DSH → 可能有目标版本不认识的配置
    score = 'partial';
  } else if (cmp < 0) {
    // 备份来自更旧的 DSH → 目标向后兼容
    score = 'good';
  }

  return score;
}

/** 兼容性得分的可读描述（UI 报告用） */
export function describeCompatibility(score: CompatibilityScore): string {
  switch (score) {
    case 'excellent': return 'Excellent — 完美兼容（同平台、无缺失、schema 支持）';
    case 'good': return 'Good — 兼容（旧版备份导入新版 DSH）';
    case 'partial': return 'Partial — 部分兼容（跨平台/分区缺失/版本超前，需人工确认）';
    case 'unsupported': return 'Unsupported — 不受支持（schema 超出范围）';
  }
}

/** 用 describeVersion 生成 schema 状态的用户可读说明 */
export function describeSchemaStatus(schemaVersion: number): string {
  return describeVersion(schemaVersion);
}
