/**
 * #132：同步「跟随远端删除插件」的**唯一判据**与 plugins 分区的按名三方合并。
 *
 * 为什么必须单独一个模块：
 *  1. 删除判定是纯逻辑（开关 × 祖先 × 远端 × 本机），散进引擎里既测不了也说不清；
 *  2. plugins 分区不能走通用 JSON 合并 —— `merge.ts` 的 `mergeJsonValues` 对数组一律「两侧都改
 *     且不逐字相等 → 冲突」，而本分区的日常形态恰恰是「A 机卸载了 X、B 机新装了 Y」，通用路径
 *     会把它报成整分区冲突，于是删除永远进不了自动应用（issue #132 的行为表 A→B 走不通）。
 *
 * 删除判据（缺一不可，全部满足才删）：
 *  - 开关打开（`SyncSelection.deletePlugins`，缺省关）；
 *  - **祖先**里有它（A 机那轮同步见过的状态）——没有祖先就没有「谁删了它」的证据；
 *  - **远端**没有它（= 有人在另一台机器上卸载了）；
 *  - **本机装着**（卸载才有意义）；
 *  - 本机版本**仍等于祖先版本**（本地改过 = 用户在自己这台机器上动过它，绝不替用户做决定，
 *    报 `version-changed` 冲突交人裁决）；
 *  - 不是本插件自己、不是 bundlesOnly 条目（后者由 DSH 自身安装位置解析，`dsh plugin remove`
 *    对它无意义，见 `core/plugin-cli.ts` 的 `isBundlesOnlyEntry`）。
 *
 * 纯函数、零 I/O：引擎调用它拿计划，UI 调用它拿「将删除」清单。
 */
import type { PluginEntry, PluginsSection, SectionData } from '../schema/types.ts';
import type { MergeConflict } from './merge.ts';
import type { GranularMergeOutcome } from './workspace-merge.ts';
import { isBundlesOnlyEntry } from '../core/plugin-cli.ts';

/** 一条「该卸载」的结论（version = 祖先/本机一致的版本，用于报告与回滚重装目标）。 */
export interface PluginRemoval {
  name: string;
  version: string;
  /** 祖先条目里的安装源（github:/git+/file:/link: 等）；重装目标要用它，否则装不回同一来源 */
  spec?: string;
}

/** 未删的原因：每一条都要能对用户解释（报告里逐项列出，绝不静默跳过）。 */
export type PluginRemovalKeptReason = 'still-in-remote' | 'self' | 'bundles-only' | 'not-installed' | 'switch-off';

export interface PluginRemovalConflict {
  name: string;
  reason: 'version-changed';
  ancestorVersion: string;
  localVersion: string;
}

export interface PluginRemovalPlan {
  /** 该执行 `dsh plugin remove` 的插件（顺序 = 祖先顺序，便于报告比对） */
  removals: PluginRemoval[];
  /** 本机改过、远端删了 → 交人裁决（不删也不静默保留） */
  conflicts: PluginRemovalConflict[];
  /** 考察过但不删的条目及原因 */
  kept: { name: string; reason: PluginRemovalKeptReason }[];
}

/**
 * 判据只需要这几个字段：`PluginEntry` 与宿主的 `PluginInfo`（listInstalled 的返回值）都能直接传入，
 * 不必为了调用它先拼一个完整的分区条目。
 */
export interface PluginRemovalEntry {
  name: string;
  version: string;
  spec?: string;
  bundlesOnly?: boolean;
}

export interface PluginRemovalInput {
  /** 同步选择里的开关（缺省关）；关 = 一个都不删 */
  enabled: boolean;
  /** 共同祖先快照里的插件清单（undefined = 没有祖先副本） */
  ancestor: readonly PluginRemovalEntry[] | undefined;
  /** 远端快照里的插件清单（undefined = 远端没有该分区） */
  remote: readonly PluginRemovalEntry[] | undefined;
  /** 本机当前已装（plugins 分区导出的口径） */
  local: readonly PluginRemovalEntry[];
  /** 本插件自己的包名（永不删） */
  selfName: string | undefined;
}

function byName<T extends { name: string }>(list: readonly T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const p of list ?? []) {
    if (p !== null && typeof p === 'object' && typeof p.name === 'string' && p.name !== '') map.set(p.name, p);
  }
  return map;
}

/** 判定「该不该删」。调用方只在 `applied` 含 plugins 时才真正执行。 */
export function planPluginRemovals(input: PluginRemovalInput): PluginRemovalPlan {
  const plan: PluginRemovalPlan = { removals: [], conflicts: [], kept: [] };
  if (input.ancestor === undefined) return plan; // 没有祖先：无删除语义（无法区分「对方删了」与「本机独有」）
  const remote = byName(input.remote);
  const local = byName(input.local);
  for (const a of input.ancestor) {
    const name = a.name;
    if (typeof name !== 'string' || name === '') continue;
    if (remote.has(name)) { plan.kept.push({ name, reason: 'still-in-remote' }); continue; }
    if (input.selfName !== undefined && name === input.selfName) { plan.kept.push({ name, reason: 'self' }); continue; }
    const l = local.get(name);
    if (isBundlesOnlyEntry(a) || (l !== undefined && isBundlesOnlyEntry(l))) {
      plan.kept.push({ name, reason: 'bundles-only' });
      continue;
    }
    if (l === undefined) { plan.kept.push({ name, reason: 'not-installed' }); continue; }
    if (!input.enabled) { plan.kept.push({ name, reason: 'switch-off' }); continue; }
    if (l.version !== a.version) {
      plan.conflicts.push({ name, reason: 'version-changed', ancestorVersion: a.version, localVersion: l.version });
      continue;
    }
    plan.removals.push({ name, version: a.version, ...(a.spec === undefined ? {} : { spec: a.spec }) });
  }
  return plan;
}

/* --------------------------------------------------------------- 分区级三方合并 */

/** 形状闸门：不认识就交回通用路径（畸形数据由通用路径拒绝，这里不另造一套判定）。 */
function asPlugins(data: SectionData | undefined): PluginsSection | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const obj = data as { version?: unknown; plugins?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.plugins)) return undefined;
  return data as PluginsSection;
}

/** 决定「同一个插件是否还是同一个东西」的身份字段（version + 来源 spec + bundlesOnly 形态）。 */
function entryKey(e: PluginEntry): string {
  return [e.version ?? '', e.spec ?? '', e.bundlesOnly === true ? '1' : '0'].join('\u0000');
}

/** 插件列表以外的字段（patch 行 / pnpm-workspace 原文 / 本地 tarball / patch 文件）必须两侧相等才介入。 */
function sameShell(l: PluginsSection, r: PluginsSection): boolean {
  const pick = (s: PluginsSection): string => JSON.stringify({
    patch: s.patch ?? [],
    pnpmWorkspace: s.pnpmWorkspace ?? null,
    localTarballs: s.localTarballs ?? [],
    patchFiles: s.patchFiles ?? [],
  });
  return pick(l) === pick(r);
}

/**
 * plugins 分区的按名三方合并（`merge.ts` 的 `GRANULAR_MERGES.plugins`）。
 *
 * 逐名规则与 git 同口径，祖先只用于判断「谁动了它」，绝不猜：
 *  - 两侧都有：身份相同 → 保留；某一侧与祖先相同 → 取另一侧；两侧都变（或没有祖先）→ both-modified 冲突；
 *  - 只有本机：有祖先且与祖先相同 → 跟随远端删除（真删除）；无祖先 → 本机独有，保留；有祖先且不同 →
 *    modify-delete 冲突（用户在 A 机卸载、B 机却升级过它，不能替用户选）；
 *  - 只有远端：有祖先且与祖先相同 → 本机删除，跟随（不复活）；无祖先 → 远端独有，采纳；有祖先且不同 →
 *    delete-modify 冲突；
 *  - 两侧都没有：消失。
 *
 * 插件列表以外的字段不一致时返回 `undefined`：patch 行/pnpm-workspace 有各自的既有口径，
 * 在这里再造一套合并只会和通用路径打架（通用路径会整分区处理，其中包含 plugins 数组的旧行为）。
 */
export function mergePluginsSection(
  local: SectionData,
  remote: SectionData,
  ancestor: SectionData | undefined,
  hooks: { deletePlugins?: boolean } = {},
): GranularMergeOutcome | undefined {
  // 开关关着 → 钩子不参与（交回通用合并 = 与 #132 之前逐字一致）。若照常「跟随远端删除」，
  // 合并结果会丢掉本机条目：插件包还在盘上，下一轮导出会把它当「本机独有」推回远端 = 复活。
  if (hooks.deletePlugins !== true) return undefined;
  const l = asPlugins(local);
  const r = asPlugins(remote);
  if (l === undefined || r === undefined) return undefined;
  const a = ancestor === undefined ? undefined : asPlugins(ancestor);
  if (ancestor !== undefined && a === undefined) return undefined;
  if (!sameShell(l, r)) return undefined;

  const aMap = byName(a?.plugins);
  const rMap = byName(r.plugins);
  const merged: PluginEntry[] = [];
  const conflicts: MergeConflict[] = [];
  let mergePoints = 0;
  const conflict = (path: string, reason: 'both-modified' | 'modify-delete' | 'delete-modify', lp: PluginEntry | undefined, rp: PluginEntry | undefined, ap: PluginEntry | undefined): void => {
    conflicts.push({ path, kind: 'key', reason, autoMergeAttempted: false, local: lp, remote: rp, ancestor: ap });
  };

  for (const lp of l.plugins) {
    const name = lp.name;
    const rp = rMap.get(name);
    const ap = aMap.get(name);
    if (rp !== undefined) {
      if (entryKey(lp) === entryKey(rp)) { merged.push(lp); continue; }
      const lChanged = ap === undefined || entryKey(lp) !== entryKey(ap);
      const rChanged = ap === undefined || entryKey(rp) !== entryKey(ap);
      if (lChanged && rChanged) { conflict(`plugins.${name}`, 'both-modified', lp, rp, ap); continue; }
      if (lChanged) { merged.push(lp); mergePoints += 1; continue; }
      merged.push(rp);
      mergePoints += 1;
      continue;
    }
    // 只有本机有
    if (ap === undefined) { merged.push(lp); mergePoints += 1; continue; } // 本机独有
    if (entryKey(lp) === entryKey(ap)) { mergePoints += 1; continue; } // 本机未改、远端删 → 跟随删除
    conflict(`plugins.${name}`, 'modify-delete', lp, undefined, ap);
  }
  // 只有远端有的
  for (const rp of r.plugins) {
    const name = rp.name;
    if (l.plugins.some((p) => p.name === name)) continue;
    const ap = aMap.get(name);
    if (ap === undefined) { merged.push(rp); mergePoints += 1; continue; } // 远端独有
    if (entryKey(rp) === entryKey(ap)) { mergePoints += 1; continue; } // 远端未改、本机删 → 跟随删除
    conflict(`plugins.${name}`, 'delete-modify', undefined, rp, ap);
  }
  if (conflicts.length > 0) return { merged: l as SectionData, conflicts, mergePoints };
  return { merged: { ...l, plugins: merged } as SectionData, conflicts: [], mergePoints };
}
