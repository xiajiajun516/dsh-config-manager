/**
 * m-sync-flow：三方合并引擎（纯函数）。
 *
 * 输入：local / remote / ancestor 各分区的 SectionData + 分区 hash。
 * 行为（每分区）：
 *   - localHash == remoteHash        → skip（无变化）
 *   - localHash != remoteHash：
 *     - localHash == ancestorHash    → useRemote（远端独有改动）
 *     - remoteHash == ancestorHash   → keepLocal（本地独有改动）
 *     - 其余                          → 进入精细合并：JSON 分区按 top-level key 合并、FilesSection 按 relativePath 合并；
 *                                       仅双侧均改且值不同的键/文件留为 conflict，其余非重叠变更自动合入。
 *
 * 输出：MergePlan（纯数据，不含副作用），由上层（SyncEngine.merge）返回给 UI 决策。
 *
 * 安全约束：ancestor 为 undefined 时退化为两方合并：local != remote 视为整分区 conflict（拒绝猜测共同祖先）。
 */
import type { FilesSection, SectionData, SectionId } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';

export type MergeDecision = 'useRemote' | 'keepLocal' | 'skip';

/** 分区内精细合并产生的单条冲突（JSON key 或 FilesSection 单文件）。 */
export interface MergeConflict {
  /** 冲突位置：JSON 分区是 top-level key；FilesSection 是 relativePath。 */
  path: string;
  kind: 'key' | 'file';
  local?: unknown;
  remote?: unknown;
  ancestor?: unknown;
}

export interface MergeSectionResult {
  id: SectionId;
  /** 分区级决策；'skip' 时无 merged/conflicts；'conflict' 时 merged 为 null（仅 conflicts）。 */
  decision: MergeDecision | 'conflict';
  /** 当 decision 为 'useRemote' / 'keepLocal' 时：合并后的整分区数据（= 胜出方原值）。 */
  merged?: SectionData;
  /** 仅 decision === 'conflict' 时非空：分区级冲突或精细合并后剩余冲突。 */
  conflicts: MergeConflict[];
}

export interface MergePlan {
  /** 每分区的合并结果；仅含 local/remote/ancestor 三者任一出现的分区。 */
  sections: MergeSectionResult[];
}

/** 内部：三态分区 hash（缺则为 undefined）。 */
interface TripleHashes {
  local?: string;
  remote?: string;
  ancestor?: string;
}

/** 收集 local/remote/ancestor 三个快照中出现过的所有分区 id。 */
function unionSectionIds(
  local: Record<string, SectionData>,
  remote: Record<string, SectionData>,
  ancestor: Record<string, SectionData> | undefined,
): SectionId[] {
  const ids = new Set<SectionId>();
  for (const id of Object.keys(local)) ids.add(id as SectionId);
  for (const id of Object.keys(remote)) ids.add(id as SectionId);
  if (ancestor) for (const id of Object.keys(ancestor)) ids.add(id as SectionId);
  return [...ids];
}

function computeHashes(
  local: Record<string, SectionData>,
  remote: Record<string, SectionData>,
  ancestor: Record<string, SectionData> | undefined,
  ids: SectionId[],
): Map<SectionId, TripleHashes> {
  const m = new Map<SectionId, TripleHashes>();
  for (const id of ids) {
    const lh = local[id] !== undefined ? hashSection(local[id]) : undefined;
    const rh = remote[id] !== undefined ? hashSection(remote[id]) : undefined;
    const ah = ancestor && ancestor[id] !== undefined ? hashSection(ancestor[id]) : undefined;
    m.set(id, { local: lh, remote: rh, ancestor: ah });
  }
  return m;
}

/** 顶层 JSON 分区对象：键序无关判等（深度递归，深层数组也判等）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (!deepEqual(aa[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** JSON 分区精细合并：按 top-level key 走三方合并。
 *  - 双侧均未改 → 跳过
 *  - 仅一侧改   → 采纳该侧
 *  - 双侧均改   → 若 deepEqual 自动合并；否则留为冲突 */
function mergeJsonSectionGranular(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  ancestor: Record<string, unknown> | undefined,
): { merged: Record<string, unknown>; conflicts: MergeConflict[] } {
  const merged: Record<string, unknown> = {};
  const conflicts: MergeConflict[] = [];
  const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote), ...(ancestor ? Object.keys(ancestor) : [])]);
  for (const k of keys) {
    const lHas = Object.prototype.hasOwnProperty.call(local, k);
    const rHas = Object.prototype.hasOwnProperty.call(remote, k);
    const aHas = ancestor ? Object.prototype.hasOwnProperty.call(ancestor, k) : false;
    const lv = lHas ? local[k] : undefined;
    const rv = rHas ? remote[k] : undefined;
    const av = aHas ? ancestor![k] : undefined;
    if (lHas && rHas) {
      if (deepEqual(lv, rv)) {
        merged[k] = lv;
        continue;
      }
      // 双侧都有该 key 但值不同 → 看是否都改过
      const lChanged = !aHas || !deepEqual(lv, av);
      const rChanged = !aHas || !deepEqual(rv, av);
      if (lChanged && rChanged) {
        if (deepEqual(lv, rv)) {
          merged[k] = lv; // 两侧改后恰好相同
        } else {
          conflicts.push({ path: k, kind: 'key', local: lv, remote: rv, ancestor: av });
        }
      } else if (lChanged) {
        merged[k] = lv;
      } else if (rChanged) {
        merged[k] = rv;
      } else {
        merged[k] = lv; // 双侧都未相对祖先改但 deepEqual 已失败——保持一致
      }
    } else if (lHas && !rHas) {
      // 仅本地有：删/改/增？
      const lChanged = !aHas || !deepEqual(lv, av);
      if (lChanged) {
        // 本地增/改，远程删 → 冲突
        conflicts.push({ path: k, kind: 'key', local: lv, remote: undefined, ancestor: av });
      } else {
        // 本地等于祖先、远程缺：远程删 → 跟随删除
      }
    } else if (!lHas && rHas) {
      const rChanged = !aHas || !deepEqual(rv, av);
      if (rChanged) {
        // 本地删、远程增 → 冲突
        conflicts.push({ path: k, kind: 'key', local: undefined, remote: rv, ancestor: av });
      } else {
        // 远程等于祖先、本地缺：本地删 → 跟随删除
      }
    } else {
      // 仅祖先有：双侧都删 → 跟随删除
    }
  }
  return { merged, conflicts };
}

/** FilesSection 精细合并：按 relativePath 走三方合并（按文件字节 deepEqual）。 */
function mergeFilesSectionGranular(
  local: FilesSection,
  remote: FilesSection,
  ancestor: FilesSection | undefined,
): { merged: FilesSection; conflicts: MergeConflict[] } {
  const lMap = new Map<string, Uint8Array>();
  for (const f of local.files) lMap.set(f.relativePath, f.data);
  const rMap = new Map<string, Uint8Array>();
  for (const f of remote.files) rMap.set(f.relativePath, f.data);
  const aMap = new Map<string, Uint8Array>();
  if (ancestor) for (const f of ancestor.files) aMap.set(f.relativePath, f.data);

  const paths = new Set<string>([...lMap.keys(), ...rMap.keys(), ...aMap.keys()]);
  const mergedFiles: FilesSection['files'] = [];
  const conflicts: MergeConflict[] = [];
  for (const p of paths) {
    const l = lMap.get(p);
    const r = rMap.get(p);
    const a = aMap.get(p);
    const eq = (x: Uint8Array | undefined, y: Uint8Array | undefined) => {
      if (x === undefined || y === undefined) return x === y;
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    };
    if (l && r) {
      if (eq(l, r)) {
        mergedFiles.push({ relativePath: p, data: l, contentHash: '' });
        continue;
      }
      const lChanged = !a || !eq(l, a);
      const rChanged = !a || !eq(r, a);
      if (lChanged && rChanged) {
        conflicts.push({ path: p, kind: 'file', local: l, remote: r, ancestor: a });
      } else if (lChanged) {
        mergedFiles.push({ relativePath: p, data: l, contentHash: '' });
      } else if (rChanged) {
        mergedFiles.push({ relativePath: p, data: r, contentHash: '' });
      } else {
        mergedFiles.push({ relativePath: p, data: l, contentHash: '' });
      }
    } else if (l && !r) {
      const aExists = a !== undefined;
      const lChanged = aExists ? !eq(l, a) : true;
      if (lChanged) {
        if (!aExists) {
          // 纯本地新增（祖先里也没有）→ keepLocal
          mergedFiles.push({ relativePath: p, data: l, contentHash: '' });
        } else {
          // 本地改/增 vs 远程删 → 冲突
          conflicts.push({ path: p, kind: 'file', local: l, remote: undefined, ancestor: a });
        }
      }
    } else if (!l && r) {
      const aExists = a !== undefined;
      const rChanged = aExists ? !eq(r, a) : true;
      if (rChanged) {
        if (!aExists) {
          // 纯远程新增（祖先里也没有）→ useRemote
          mergedFiles.push({ relativePath: p, data: r, contentHash: '' });
        } else {
          // 本地删 vs 远程改/增 → 冲突
          conflicts.push({ path: p, kind: 'file', local: undefined, remote: r, ancestor: a });
        }
      }
    }
  }
  return { merged: { version: 1, files: mergedFiles }, conflicts };
}

/** 识别 JSON 分区的「键级合并」键值映射（如 settings/ui 的 namespaces、providers 的 providers）。
 * 返回 undefined → 该分区无法做键级合并，调用方应退化为整分区冲突。 */
function keyMapOf(data: SectionData): Record<string, unknown> | undefined {
  const obj = data as unknown as Record<string, unknown>;
  if (obj && typeof obj === 'object' && obj['version'] === 1) {
    const ns = obj['namespaces'];
    if (ns && typeof ns === 'object' && !Array.isArray(ns)) return ns as Record<string, unknown>;
    const prov = obj['providers'];
    if (prov && typeof prov === 'object' && !Array.isArray(prov)) return prov as Record<string, unknown>;
  }
  return undefined;
}

/** 主入口：三方合并。纯函数，无副作用。 */
export function merge(
  local: Partial<Record<SectionId, SectionData>>,
  remote: Partial<Record<SectionId, SectionData>>,
  ancestor?: Partial<Record<SectionId, SectionData>>,
): MergePlan {
  const l = local as Record<string, SectionData>;
  const r = remote as Record<string, SectionData>;
  const a = ancestor as Record<string, SectionData> | undefined;
  const ids = unionSectionIds(l, r, a);
  const hashes = computeHashes(l, r, a, ids);
  const results: MergeSectionResult[] = [];

  for (const id of ids) {
    const h = hashes.get(id)!;
    const lData = l[id];
    const rData = r[id];
    const aData = a ? a[id] : undefined;

    // 远端无 → skip（不在本轮考虑；本地有但远端没有 = 远端"删了"，视作 useRemote=删除）
    // 本实现按远端视角：远端缺 + 本地存在 + 本地未改祖先 → skip(无变化)；否则冲突。
    if (rData === undefined && lData !== undefined) {
      const lChanged = h.ancestor === undefined || h.local !== h.ancestor;
      if (!lChanged) {
        results.push({ id, decision: 'skip', conflicts: [] });
        continue;
      }
      results.push({ id, decision: 'conflict', conflicts: [{ path: '$', kind: 'key', local: lData, remote: undefined, ancestor: aData }] });
      continue;
    }
    // 本地无、远端有：远端新增；本地删除过（=等于祖先空）+祖先空→skip；否则按 useRemote。
    if (lData === undefined && rData !== undefined) {
      const rChanged = h.ancestor === undefined || h.remote !== h.ancestor;
      if (!rChanged) {
        results.push({ id, decision: 'skip', conflicts: [] });
        continue;
      }
      results.push({ id, decision: 'useRemote', merged: rData, conflicts: [] });
      continue;
    }
    // 双方都没有 → skip
    if (lData === undefined && rData === undefined) {
      results.push({ id, decision: 'skip', conflicts: [] });
      continue;
    }
    // 双方都有
    if (h.local === h.remote) {
      results.push({ id, decision: 'skip', conflicts: [] });
      continue;
    }
    if (h.ancestor === undefined) {
      // 无祖先 → 两方差异视为整分区冲突（不猜测）
      results.push({ id, decision: 'conflict', conflicts: [{ path: '$', kind: 'key', local: lData, remote: rData, ancestor: undefined }] });
      continue;
    }
    if (h.local === h.ancestor) {
      results.push({ id, decision: 'useRemote', merged: rData, conflicts: [] });
      continue;
    }
    if (h.remote === h.ancestor) {
      results.push({ id, decision: 'keepLocal', merged: lData, conflicts: [] });
      continue;
    }
    // 双侧相对祖先都改 → 进入精细合并
    if (isFilesSectionData(lData as SectionData)) {
      const { merged, conflicts } = mergeFilesSectionGranular(lData as FilesSection, rData as FilesSection, aData as FilesSection | undefined);
      if (conflicts.length === 0) {
        results.push({ id, decision: 'useRemote', merged: merged as SectionData, conflicts: [] });
      } else {
        results.push({ id, decision: 'conflict', conflicts, merged: undefined });
      }
      continue;
    }
    // JSON 分区：识别可键级合并的子映射（namespaces / providers）
    const lKeyMap = keyMapOf(lData as unknown as SectionData);
    const rKeyMap = keyMapOf(rData as unknown as SectionData);
    const aKeyMap = aData ? keyMapOf(aData as unknown as SectionData) : undefined;
    if (lKeyMap && rKeyMap) {
      const { merged: mergedKeys, conflicts } = mergeJsonSectionGranular(lKeyMap, rKeyMap, aKeyMap);
      // 重组 SectionData：用 l/r 中较新者保留非键级合并字段（version 等），键级合并字段用 mergedKeys
      const lObj = lData as unknown as Record<string, unknown>;
      const rObj = rData as unknown as Record<string, unknown>;
      const base: Record<string, unknown> = { ...lObj, ...rObj };
      // 找到键级合并字段在 base 中的键名
      const keyFieldName = lKeyMap === lObj['namespaces'] ? 'namespaces'
        : lKeyMap === lObj['providers'] ? 'providers' : undefined;
      if (keyFieldName) base[keyFieldName] = mergedKeys;
      if (conflicts.length === 0) {
        results.push({ id, decision: 'useRemote', merged: base as unknown as SectionData, conflicts: [] });
      } else {
        results.push({ id, decision: 'conflict', conflicts, merged: undefined });
      }
      continue;
    }
    // 非键级合并 JSON 分区（plugins/mcp/prompts/workspaces 等）：退化为整分区冲突
    results.push({ id, decision: 'conflict', conflicts: [{ path: '$', kind: 'key', local: lData, remote: rData, ancestor: aData }] });
  }
  return { sections: results };
}

/** 分区是否为文件类（FilesSection）—— 鸭子类型，复用 sync-state 的判定以保持一致。 */
function isFilesSectionData(data: SectionData): data is FilesSection {
  if (data === null || typeof data !== 'object') return false;
  const obj = data as { version?: unknown; files?: unknown };
  return obj.version === 1 && Array.isArray(obj.files);
}
