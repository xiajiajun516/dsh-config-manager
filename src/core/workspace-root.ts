/**
 * P4：把「导入到 <目录>」推导成每个源工作区的目标路径（跨机迁移的落地位置）。
 *
 * 为什么单独成模块：这一步是**纯函数**（源路径 + 标题 + 目标平台 + 目标根目录 → 目标路径），
 * 不碰文件系统、不碰 DSH 服务，因此能在 createImportPlan 里安全地预先算好，也能被单测钉死。
 *
 * 与既有机制的关系（不改契约，只产出规则）：
 *  - 产物是 {@link PathMapping} 形态（appliesTo: ['workspaces']），与 workspaces 适配器
 *    现有的「空目标 PathMapping」项、以及 issue #45 的自动重定基规则**同一条通道**，
 *    最终由 createImportPlan 并入 plan.automaticMappings / plan.pathMappings 生效。
 *  - 因此这里不做任何写盘、不判冲突、不裁决策略：决策仍由用户在计划页确认。
 *
 * 边界（都是有意为之）：
 *  - 目标根目录必须是绝对路径；空/相对一律返回空数组（= 不推导，行为与改造前逐字节一致）。
 *  - 只有**绝对路径**的源工作区参与推导：相对/空源路径无法确定落点，宁可不猜。
 *  - 名称清洗只按**目标平台**判定（名字会变成那一侧的目录名），而非当前运行平台。
 *  - 重名一律 `-2`、`-3` 顺延（Windows 折叠大小写比较，避免只差大小写的两个目录）。
 */
import { isAbsolutePath, normalizePath } from '../utils/paths.ts';
import type { PathMapping } from './types.ts';

/** Windows 非法文件名字符（含控制字符）——与宿主/资源管理器口径一致 */
const WIN_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows 保留设备名：作为目录名会被系统拒绝 */
const WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** 目录名长度上限（留出扩展名/后缀余量，Windows 单段建议 ≤ 127） */
const MAX_NAME_LENGTH = 80;

/** 目标平台是否 Windows 家族（只看目标侧：决定目录名清洗强度与大小写折叠） */
export function isWindowsPlatform(platform: string): boolean {
  return /^win/i.test(platform);
}

/**
 * 把任意标题/目录名清洗成目标平台上合法的单段目录名。
 *
 * @param raw 原始名称（可能是空串、带路径分隔符、带非法字符）
 * @param platform 目标平台（`win32` / `darwin` / `linux` …）
 * @returns 非空、且在该平台上可安全作为目录名的单段名称
 */
export function sanitizeWorkspaceName(raw: string, platform: string): string {
  let name = raw.trim();
  if (isWindowsPlatform(platform)) {
    name = name.replace(WIN_BAD_CHARS, '_').replace(/[. ]+$/, '');
  } else {
    name = name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '_');
    if (name === '.' || name === '..') name = '_';
  }
  if (name === '') name = '_';
  if (WIN_RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, '');
  }
  return name === '' ? '_' : name;
}

/** 取路径末段（`D:\\work\\proj` → `proj`；`/a/b/` → `b`） */
function leafOf(value: string): string {
  const segs = value.split(/[\\/]+/).filter((seg) => seg !== '');
  return segs.length > 0 ? segs[segs.length - 1]! : '';
}

/** 目标根目录用哪种分隔符（跟随用户填的那一侧，别把 `D:\\work` 拼成 `D:\\work/子目录`） */
function separatorOf(rootDir: string): string {
  return rootDir.includes('\\') && !rootDir.includes('/') ? '\\' : '/';
}

export interface WorkspaceTargetInput {
  /** 包内记录的源工作区绝对路径（导出机视角） */
  path: string;
  /** 包内记录的工作区标题（优先作为目标目录名） */
  title?: string;
}

export interface DerivedWorkspaceTarget {
  /** 源工作区路径（映射的 from） */
  sourcePath: string;
  /** 推导出的目标路径（映射的 to） */
  targetPath: string;
  /** 目标目录名（已清洗 + 去重） */
  name: string;
}

/**
 * 推导每个源工作区的目标路径。
 *
 * @param inputs 包内工作区（按导出顺序；顺序决定重名时的后缀先后）
 * @param rootDir 用户填的「导入到」目录；空/相对 → 返回空数组（不推导）
 * @param opts.platform 目标平台（缺省沿用 process.platform）
 * @param opts.isClaimed 已被显式映射（用户手填 / 基础路径重定基）命中的源路径回调；
 *   命中则跳过 —— **显式映射优先**
 */
export function deriveWorkspaceTargets(
  inputs: readonly WorkspaceTargetInput[],
  rootDir: string,
  opts: { platform?: string; isClaimed?: (sourcePath: string) => boolean } = {},
): DerivedWorkspaceTarget[] {
  const dir = rootDir.trim().replace(/[\\/]+$/, '');
  if (dir === '' || !isAbsolutePath(dir)) return [];
  const platform = opts.platform ?? process.platform;
  const windows = isWindowsPlatform(platform);
  const sep = separatorOf(dir);
  const fold = (value: string): string => (windows ? value.toLowerCase() : value);
  const usedNames = new Set<string>();
  const usedSources = new Set<string>();
  const targets: DerivedWorkspaceTarget[] = [];

  for (const input of inputs) {
    const source = input.path.trim();
    if (source === '' || !isAbsolutePath(source)) continue;
    const sourceKey = fold(normalizePath(source));
    if (usedSources.has(sourceKey)) continue;
    if (opts.isClaimed?.(source) === true) continue;
    usedSources.add(sourceKey);

    const rawName = input.title?.trim() !== undefined && input.title?.trim() !== ''
      ? input.title!.trim()
      : leafOf(source);
    const base = sanitizeWorkspaceName(rawName === '' ? 'workspace' : rawName, platform);
    let name = base;
    for (let n = 2; usedNames.has(fold(name)); n += 1) name = `${base}-${n}`;
    usedNames.add(fold(name));
    targets.push({ sourcePath: source, targetPath: `${dir}${sep}${name}`, name });
  }
  return targets;
}

/**
 * 同上，但直接产出走既有通道的 {@link PathMapping}（appliesTo 固定 `['workspaces']`）。
 * 只有工作区路径该被重定位；会话首帧 cwd 等仍由基础路径重定基 / 用户映射负责。
 */
export function deriveWorkspaceMappings(
  inputs: readonly WorkspaceTargetInput[],
  rootDir: string,
  opts: { platform?: string; isClaimed?: (sourcePath: string) => boolean } = {},
): PathMapping[] {
  return deriveWorkspaceTargets(inputs, rootDir, opts).map((target) => ({
    oldPrefix: target.sourcePath,
    newPrefix: target.targetPath,
    appliesTo: ['workspaces'] as PathMapping['appliesTo'],
  }));
}
