/**
 * 路径前缀映射的应用口径（唯一实现）。
 *
 * 与导入侧 utils/paths.ts 的 applyPrefixMappings **完全同源**：按 mappings 顺序依次应用、
 * 先规范化（反斜杠 → 斜杠）、命中必须落在段边界。两份口径必须一致的地方很关键：
 *  - 会话日志首帧的 cwd 与写进工作区记录的 path 必须逐字一致（否则 DSH 的
 *    realpath(cwd) === workspace.path 校验不过，或把混用分隔符的路径写进会话日志）；
 *  - 因此「同一条映射同时作用于 workspace.path 与会话首帧 cwd」必须走同一个函数。
 *
 * 为什么不自己写前缀替换：映射规则是**有序**的，自创「最长前缀」之类规则会在多规则重叠时算出另一个结果。
 */
import { applyPrefixMappings, normalizePath } from '../utils/paths.ts';
import type { PathMapping } from './types.ts';

/** 可选的路径映射（oldPrefix → newPrefix；appliesTo 由导入侧决定，这里不需要）。 */
export interface PathMappingRule {
  oldPrefix: string;
  newPrefix: string;
}

/**
 * 应用路径映射。
 *
 * @returns 映射后的路径（已规范化）；没有命中或与原文等价 → null（调用方按「不需要改写」处理）。
 */
export function applyPathMapping(path: string, mappings: readonly PathMappingRule[]): string | null {
  if (mappings.length === 0) return null;
  const before = normalizePath(path);
  const mapped = applyPrefixMappings(path, mappings.map((rule) => rule as PathMapping));
  if (typeof mapped !== 'string') return null;
  const after = normalizePath(mapped);
  return after === before ? null : after;
}
