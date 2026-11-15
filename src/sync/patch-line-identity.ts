/**
 * patch 行的「内容身份」（issue #145 门②）。
 *
 * 问题：导出侧 SecretScanner 会把命中字段名/值形状的叶子剥成空串并在行上记 `redactedPaths`；
 * 同一行在另一台机器（或祖先副本）上是明文、且没有这个字段。于是「同一行」的 JSON 逐字比较
 * 恒不相等 —— 合并钩子拿它当「两侧都改过」，每次同步都报冲突，patch 行永远合不进去（门②）。
 *
 * 解法：**只用于身份比较**的归一化 —— 取同一行三侧 redactedPaths 的并集，在副本上把这些叶子
 * 置为 null，再按键序稳定序列化。被剥空的值与远端明文因此落在同一身份上。产物本身绝不改写：
 * 合并输出仍取原对象（redactedPaths 原样保留），写回侧的 patch-secret-guard 才据此决定
 * 「这一行哪些叶子不许被空串覆盖」。
 *
 * 纯函数、零 I/O。
 */
import { parsePath } from '../core/patch-secret-guard.ts';
import type { PatchLine } from '../schema/types.ts';

type Segment = string | number;

/** 深拷贝并把路径上的叶子置为 null；路径不存在就原样返回（不猜形状）。 */
function blankAt(value: unknown, segs: readonly Segment[]): unknown {
  const [head, ...rest] = segs;
  if (head === undefined) return null;
  if (typeof head === 'number') {
    if (!Array.isArray(value)) return value;
    const copy = value.slice();
    copy[head] = blankAt(copy[head], rest);
    return copy;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(copy, head)) return copy;
  copy[head] = blankAt(copy[head], rest);
  return copy;
}

/** 键序稳定序列化（两侧对象字面量顺序不同不算改动）。 */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sort(obj[key]);
    return out;
  };
  return JSON.stringify(sort(value)) ?? '';
}

/** 同一行三侧声明的剥空路径并集（行内相对，带 `raw` 前缀）。 */
export function redactedUnion(lines: readonly (PatchLine | undefined)[]): string[] {
  const set = new Set<string>();
  for (const line of lines) for (const path of line?.redactedPaths ?? []) set.add(path);
  return [...set];
}

/**
 * 路径解析缓存：路径串来自载荷（不可信、可能每行都不同），所以按条数封顶、满即整体清空
 * —— 命中率靠「多数同步轮次里路径集合稳定」，不靠无限增长。纯函数，缓存不改结果。
 */
const PARSE_CACHE_LIMIT = 512;
const parsedPaths = new Map<string, readonly Segment[] | null>();

function segmentsOf(path: string): readonly Segment[] | null {
  if (parsedPaths.has(path)) return parsedPaths.get(path) ?? null;
  const segs = parsePath(path);
  if (parsedPaths.size >= PARSE_CACHE_LIMIT) parsedPaths.clear();
  parsedPaths.set(path, segs);
  return segs;
}

/** 一次合并里三侧共用的身份上下文：并集路径只解析一次。 */
export interface PatchIdentityContext {
  /** 已解析的路径段（`raw` 前缀已剥掉，可直接作用在 `line.raw` 上）。 */
  readonly segments: readonly (readonly Segment[])[];
}

/** 为同一键的三侧行准备上下文；由 `mergeKeyedList` 的 `identityContextOf` 每键调一次。 */
export function patchIdentityContext(peers: readonly (PatchLine | undefined)[]): PatchIdentityContext {
  const segments: (readonly Segment[])[] = [];
  for (const path of redactedUnion(peers)) {
    const segs = segmentsOf(path);
    if (segs === null) continue;
    // 载荷路径相对整行对象（`{ file, lineId, raw }`），行内相对只需 `raw` 之后的部分。
    segments.push(segs[0] === 'raw' ? segs.slice(1) : segs);
  }
  return { segments };
}

/**
 * 一行的内容身份：file + lineId + 归一化后的 raw。
 *
 * 归一化只抹「三侧里有人声明过被剥空」的叶子 → 声明过的空串与明文视为同一内容；
 * 两侧真写了不同的值（都不在声明里）仍然不同 —— 那才是需要人裁决的改动。
 */
export function patchLineIdentity(
  line: PatchLine,
  peers: readonly PatchLine[],
  context?: PatchIdentityContext,
): string {
  const segments = context?.segments ?? patchIdentityContext([line, ...peers]).segments;
  let normalized: unknown = line.raw;
  for (const segs of segments) normalized = blankAt(normalized, segs);
  return [line.file ?? '', line.lineId ?? '', stableJson(normalized)].join('\u0000');
}
