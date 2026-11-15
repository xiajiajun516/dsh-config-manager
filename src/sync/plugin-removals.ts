/**
 * #132 / #145：同步「跟随远端删除插件」的**唯一判据**，以及 plugins 分区的按键三方合并。
 *
 * 为什么必须单独一个模块：
 *  1. 删除判定是纯逻辑（开关 × 祖先 × 远端 × 本机），散进引擎里既测不了也说不清；
 *  2. plugins 分区不能走通用 JSON 合并 —— `merge.ts` 的 `mergeJsonValues` 对数组一律「两侧都改
 *     且不逐字相等 → 冲突」，而本分区的日常形态恰恰是「A 机卸载了 X、B 机新装了 Y」，通用路径
 *     会把它报成整分区冲突，于是删除永远进不了自动应用（issue #132 的行为表 A→B 走不通）。
 *
 * issue #145 把两件事彻底解耦（本条是 #132 的语义修正）：
 *  - **合并恒参与**：开关不再决定钩子是否介入。以前关着开关 = 整个分区交回通用 JSON 合并，
 *    于是与卸载无关的改动（patch 行新增一行）也会因为「数组两侧都改」而整分区冲突；
 *  - **开关只管删除**：`deletePlugins` 只决定「远端删了、本机未改的条目要不要真的删」，关着就
 *    保留本机条目（包还在盘上，删了也只会下一轮复活）。
 *  - 外壳条目（patch 行 / 本地 tarball / patch 文件）同一口径：跟随三方合并，删除也受同一个开关。
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
import type { LocalPluginTarball, PatchLine, PluginEntry, PluginsSection, PnpmPatchFile, SectionData } from '../schema/types.ts';
import type { MergeConflict } from './merge.ts';
import type { GranularMergeHooks, GranularMergeOutcome } from './workspace-merge.ts';
import { isBundlesOnlyEntry } from '../core/plugin-cli.ts';
import { mergeKeyedList } from './merge-keyed.ts';
import { patchLineIdentity } from './patch-line-identity.ts';
import { mergeJsonValues } from './text-merge.ts';

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

/** patch 行的键分隔符：file 与 lineId 各自可能含任意字符，用 NUL 才不会撞键。 */
const PATCH_KEY_SEP = '\u0000';

/** patch 行的身份键 = file + lineId（同一文件里 lineId 才是行身份；issue #145）。 */
function patchLineKey(line: PatchLine): string {
  return [line.file ?? '', line.lineId ?? ''].join(PATCH_KEY_SEP);
}

/** 本地 tarball 的身份（同包名 = 同一条目；内容变了才算改过）。 */
function tarballIdentity(t: LocalPluginTarball): string {
  return JSON.stringify({ version: t.version ?? '', relativePath: t.relativePath ?? '', base64: t.base64 ?? '' });
}

/** patch 文件的身份（同相对路径 = 同一条目）。 */
function patchFileIdentity(f: PnpmPatchFile): string {
  return JSON.stringify({ relativePath: f.relativePath ?? '', base64: f.base64 ?? '' });
}

/**
 * plugins 分区的按键三方合并（`merge.ts` 的 `GRANULAR_MERGES.plugins`）。
 *
 * 逐条规则见 `merge-keyed.ts`；本函数只负责「四条有序集合各用什么键与身份」以及
 * `pnpmWorkspace` 原文的三方（两侧都改且不同 → overlap 交人工，与通用 JSON 合并同口径）。
 *
 * 形状不认识（`version !== 1` 或缺 plugins 数组）时返回 `undefined`：畸形数据交回通用路径的
 * 形状闸门，这里不另造第二套拒绝逻辑。
 */
export function mergePluginsSection(
  local: SectionData,
  remote: SectionData,
  ancestor: SectionData | undefined,
  hooks: GranularMergeHooks = {},
): GranularMergeOutcome | undefined {
  const l = asPlugins(local);
  const r = asPlugins(remote);
  if (l === undefined || r === undefined) return undefined;
  const a = ancestor === undefined ? undefined : asPlugins(ancestor);
  if (ancestor !== undefined && a === undefined) return undefined;

  // 开关只决定「远端删了要不要真删」，不再决定钩子是否介入（issue #145 解耦）。
  const followDelete = hooks.deletePlugins === true;
  const selfName = hooks.selfPluginName ?? '';

  const plugins = mergeKeyedList<PluginEntry>({
    local: l.plugins,
    remote: r.plugins,
    ancestor: a?.plugins,
    spec: {
      keyOf: (p) => (typeof p.name === 'string' ? p.name : ''),
      identityOf: (p) => entryKey(p),
      pathOf: (name) => `plugins.${name}`,
      followDelete,
      // 自身条目永不删、永不报冲突：删了等于把正在跑的宿主插件卸掉。
      keepLocal: (p) => selfName !== '' && p.name === selfName,
    },
  });
  const patch = mergeKeyedList<PatchLine>({
    local: l.patch ?? [],
    remote: r.patch ?? [],
    ancestor: a?.patch,
    spec: {
      keyOf: patchLineKey,
      // 身份按三侧 redactedPaths 并集归一化：本机被剥空、远端明文的同一行算「没改过」（门②）。
      identityOf: (line, peers) => patchLineIdentity(line, peers),
      pathOf: (key) => `patch.${key.split(PATCH_KEY_SEP)[0] ?? ''}`,
      followDelete,
    },
  });
  const tarballs = mergeKeyedList<LocalPluginTarball>({
    local: l.localTarballs ?? [],
    remote: r.localTarballs ?? [],
    ancestor: a?.localTarballs,
    spec: {
      keyOf: (t) => (typeof t.packageName === 'string' ? t.packageName : ''),
      identityOf: (t) => tarballIdentity(t),
      pathOf: (key) => `localTarballs.${key}`,
      followDelete,
    },
  });
  const files = mergeKeyedList<PnpmPatchFile>({
    local: l.patchFiles ?? [],
    remote: r.patchFiles ?? [],
    ancestor: a?.patchFiles,
    spec: {
      keyOf: (f) => (typeof f.relativePath === 'string' ? f.relativePath : ''),
      identityOf: (f) => patchFileIdentity(f),
      pathOf: (key) => `patchFiles.${key}`,
      followDelete,
    },
  });

  const conflicts: MergeConflict[] = [
    ...plugins.conflicts,
    ...patch.conflicts,
    ...tarballs.conflicts,
    ...files.conflicts,
  ];
  let mergePoints = plugins.mergePoints + patch.mergePoints + tarballs.mergePoints + files.mergePoints;

  // pnpm-workspace 原文：标量/对象三方。两侧都改且不同 → overlap（不猜用哪一份）。
  const wsLocal = l.pnpmWorkspace ?? undefined;
  const wsRemote = r.pnpmWorkspace ?? undefined;
  const wsAncestor = a?.pnpmWorkspace ?? undefined;
  const ws = mergeJsonValues(wsAncestor, wsLocal, wsRemote, 'pnpmWorkspace');
  const wsMerged = ws.ok ? (ws.merged as string | null | undefined) : undefined;
  if (!ws.ok) {
    for (const _ of ws.conflicts) {
      conflicts.push({
        path: 'pnpmWorkspace',
        kind: 'key',
        reason: 'overlap',
        autoMergeAttempted: true,
        local: wsLocal ?? null,
        remote: wsRemote ?? null,
        ancestor: wsAncestor ?? null,
      });
    }
  } else if (wsMerged !== wsLocal) {
    mergePoints += 1;
  }

  if (conflicts.length > 0) return { merged: l as SectionData, conflicts, mergePoints };

  const next: Record<string, unknown> = { ...l };
  next.plugins = plugins.merged;
  next.patch = patch.merged;
  // 可选字段只在「本机或合并结果里确实有」时写回：不擅自在载荷里新增空字段。
  if (l.localTarballs !== undefined || tarballs.merged.length > 0) next.localTarballs = tarballs.merged;
  else delete next.localTarballs;
  if (l.patchFiles !== undefined || files.merged.length > 0) next.patchFiles = files.merged;
  else delete next.patchFiles;
  if (wsMerged === undefined || wsMerged === null) delete next.pnpmWorkspace;
  else next.pnpmWorkspace = wsMerged;
  return { merged: next as unknown as SectionData, conflicts: [], mergePoints };
}
