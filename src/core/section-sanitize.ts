/**
 * 分区载荷脱敏的**唯一入口**（issue #136 C）。
 *
 * 为什么必须只有一处：同一分区数据有五个出口 —— 导出、push 载荷、push 预览、
 * `hasLocalChanges` 的基线比对、合并落地的本地侧与「落地后重新导出记基线」。
 * 这些字节必须**逐字相同**（参见 AGENTS.md「本地有改动与导出载荷必须同一份字节」）：
 * 任何一处只做 `scanAndRedact` 而不做归属标注，就会让「被剥空路径」在那一侧消失，
 * 与另一侧算出的 hash 分叉，表现为每轮同步都真推一次 / 合并判冲突。
 *
 * 归属标注钩子见 `ConfigAdapter.annotateRedactions`（只有 plugins 分区实现：把 hit 的
 * `patch[i].raw.x` 归属回第 i 行的 `redactedPaths`）。
 */
import type { ConfigAdapter, SensitiveHit } from './types.ts';

/** 扫描器最小契约（`SecretScanner` 结构性满足；此处只依赖用到的那一个方法）。 */
export interface SectionScanner {
  scanAndRedact(data: unknown): { sanitized: unknown; hits: SensitiveHit[] };
}

/** 可参与脱敏归属标注的适配器（只要求用到的那部分形状）。 */
type AnnotatingAdapter = Pick<ConfigAdapter, 'annotateRedactions'>;

/**
 * 扫描 + 剥离 + （如实现）归属标注。
 *
 * @param adapter 分区适配器；未实现 `annotateRedactions` 时行为与直接 `scanAndRedact` 逐字相同。
 */
export function sanitizeSectionData(
  adapter: AnnotatingAdapter | undefined,
  scanner: SectionScanner,
  data: unknown,
): { sanitized: unknown; hits: SensitiveHit[] } {
  const scanned = scanner.scanAndRedact(data);
  const annotate = adapter?.annotateRedactions;
  if (annotate === undefined) return { sanitized: scanned.sanitized, hits: scanned.hits };
  return { sanitized: annotate.call(adapter, scanned.sanitized, scanned.hits), hits: scanned.hits };
}
