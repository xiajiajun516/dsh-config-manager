/**
 * 整体校验与兼容性评分（规范 §18 完整性 / §30 兼容性评分 / 导入后校验）。
 */
import { validateSectionData } from '../schema/config.ts';
import { canImport, describeVersion } from '../schema/versions.ts';
import type { SectionId } from '../schema/types.ts';
import { engineMsg } from './messages-core.ts';
import type { CompatibilityInput, CompatibilityReason, CompatibilityScore, ValidationResult } from './types.ts';

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
 * 语义化版本比较（-1 / 0 / 1；预发布版低于同名正式版）。
 *
 * 导出供 `core/update-check.ts` 复用**同一份**解析与比较规则 —— 插件版本比较若另写一套
 * （例如直接字符串比大小），`1.10.0` vs `1.9.0` 这类就会判错。
 */
export function compareVersionStrings(a: string, b: string): -1 | 0 | 1 {
  return compareVersions(parseVersion(a), parseVersion(b));
}

/**
 * semver 形态判定（`1.2.3` / `1.2.3-rc.1` / `1.2.3+build`；区间 `^1.2.3`、dist-tag 与空串一律 false）。
 *
 * 与上面的 `compareVersionStrings` 分工不同：那个是**容错比较**（为了让 `0.2.1` 与 `0.2.1-rc.2`
 * 也能排出大小，解析用宽松正则），这个是**严格形态判定** —— 只有它是具体版本时才允许拿来
 * 拼 `<pkg>@<version>` 精确安装（issue #101）。导出为唯一实现，`self-update.ts`（是否接受目标
 * 版本）与 `update-check.ts`（registry 返回值是否认得）都必须复用它，不许各留一份正则。
 */
export function isConcreteVersion(v: string): boolean {
  return SEMVER_RE.test(v.trim());
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 兼容性判定的**结构化原因**（与 `computeCompatibility` 同源：评分由本函数派生）。
 *
 * 顺序固定为「跨平台 → 分区缺失 → 版本方向」，界面按此顺序逐条解释。
 * 注意：`sourceOlder` 与其它原因可**同时成立**（跨平台 + 备份更旧），
 * 评分口径见 `computeCompatibility` 的注释（历史行为：更旧 → good，覆盖跨平台的 partial）。
 */
export function compatibilityReasons(input: CompatibilityInput): CompatibilityReason[] {
  const reasons: CompatibilityReason[] = [];
  if (!canImport(input.schemaVersion)) {
    // schema 超出支持范围：bundle 整体被拒，其余原因不再有意义
    return [{ kind: 'schemaUnsupported', schemaVersion: input.schemaVersion }];
  }
  if (input.sourcePlatform !== input.targetPlatform) {
    reasons.push({
      kind: 'crossPlatform',
      sourcePlatform: input.sourcePlatform,
      targetPlatform: input.targetPlatform,
    });
  }
  if (input.missingSections.length > 0) {
    reasons.push({ kind: 'missingSections', sections: [...input.missingSections] });
  }
  const cmp = compareVersions(parseVersion(input.sourceDsh), parseVersion(input.targetDsh));
  if (cmp > 0) {
    reasons.push({ kind: 'sourceNewer', sourceDsh: input.sourceDsh, targetDsh: input.targetDsh });
  } else if (cmp < 0) {
    reasons.push({ kind: 'sourceOlder', sourceDsh: input.sourceDsh, targetDsh: input.targetDsh });
  }
  return reasons;
}

/**
 * 兼容性评分（规则驱动，不凭感觉）：
 *  unsupported — schema 超出本插件支持范围（过高/过低）
 *  partial     — 跨平台、分区缺失、或备份 DSH 比目标新
 *  good        — 备份 DSH 比目标旧（向后兼容）
 *  excellent   — 同平台、无缺失、schema 支持
 *
 * 2026-09：实现改为**由 `compatibilityReasons` 派生**（单一事实源 —— 界面解释与评分不可能漂移）。
 * 派生顺序刻意保持改造前的行为：`sourceOlder` 一旦成立即 good，**即使同时跨平台/分区缺失**
 * （旧实现的 `cmp < 0 → score = 'good'` 会覆盖先前的 partial）。这是有意的兼容性冻结：
 * 改它会让既有的导入报告与用户预期一起变脸，需要单独决策。
 */
export function computeCompatibility(input: CompatibilityInput): CompatibilityScore {
  const reasons = compatibilityReasons(input);
  if (reasons.some((r) => r.kind === 'schemaUnsupported')) return 'unsupported';
  if (reasons.some((r) => r.kind === 'sourceOlder')) return 'good';
  return reasons.length > 0 ? 'partial' : 'excellent';
}

/** 兼容性得分的可读描述（UI 报告用） */
export function describeCompatibility(score: CompatibilityScore): string {
  switch (score) {
    case 'excellent': return engineMsg('core.compat.excellent');
    case 'good': return engineMsg('core.compat.good');
    case 'partial': return engineMsg('core.compat.partial');
    case 'unsupported': return engineMsg('core.compat.unsupported');
  }
}

/** 用 describeVersion 生成 schema 状态的用户可读说明 */
export function describeSchemaStatus(schemaVersion: number): string {
  return describeVersion(schemaVersion);
}
