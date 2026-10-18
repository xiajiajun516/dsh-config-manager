/**
 * m-sync-flow：三方合并引擎（纯函数）。
 *
 * 输入：local / remote / ancestor 各分区的 SectionData + 分区 hash。
 * 输出：MergePlan（纯数据，不含副作用），由上层（SyncEngine.merge / previewMerge）交给 UI 决策。
 *
 * 每分区的决策链（顺序即优先级，与 git 的三方合并口径一致）：
 *   1. localHash == remoteHash    → skip（无变化，绝不产生多余写入）
 *   2. 仅一侧存在该分区           → 单边存在：不构成删除语义（见 §边界），按变化与否取舍
 *   3. ancestor 缺失              → conflict(reason='no-ancestor')：拒绝猜测共同祖先
 *   4. localHash == ancestorHash  → useRemote（仅远端改）
 *   5. remoteHash == ancestorHash → keepLocal（仅本地改）
 *   6. 双侧相对祖先都改           → 精细合并：
 *        - JSON 分区：递归对象合并（mergeJsonValues），冲突路径精确到叶子（'namespaces.general.value.theme'）
 *        - FilesSection：逐 relativePath 合并，两侧都改的文本文件再走行级三方合并（mergeBytesThreeWay）
 *        - 无残留冲突 → decision='merge'（merged + autoMerged 计数）
 *        - 有残留冲突 → decision='conflict'（merged 为 undefined：绝不把半成品当结果）
 *
 * 安全约束（改这里前先读）：
 *  - 数组**绝不**按索引合并：双侧都改且不逐字相等 → 冲突（reason='array'）。语义不明的合并比冲突更危险。
 *  - 二进制 / 超大文件不做文本合并（mergeBytesThreeWay 会如实拒绝）→ 保留冲突交用户裁决。
 *  - 绝不静默丢弃任一侧的未知字段 / 插件配置 / 用户数据：递归合并只对「双侧都改同一处」报冲突，
 *    单侧新增/修改的键一律保留。
 *  - ancestor 缺失时退化为两方：差异一律整分区 conflict（拒绝猜测共同祖先）。
 *
 * 边界（有意如此，勿“修复”）：分区在某侧**缺失**不等于「该侧删了这个分区」—— 同步只搬本轮
 * 勾选的分区，可选分区（sessions/mcp）未勾选时为缺失。因此分区级缺失不判删除冲突；
 * 文件级（FilesSection 内的 relativePath）才是真正的删除语义，那里按 modify/delete 判冲突。
 */
import type { FilesSection, SectionData, SectionId } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';
import { mergeBytesThreeWay, mergeJsonValues, type TextMergeConflict } from './text-merge.ts';

/**
 * 分区级决胜结果（三方合并，2026-10 收口）：
 *  - 'skip'      ：双侧相对祖先都未改（或本就无变化）—— 不产生任何写入；
 *  - 'useRemote' ：仅远端相对祖先改了（本地未改）→ 远端整分区原值胜出；
 *  - 'keepLocal' ：仅本地相对祖先改了（远端未改）→ 本地整分区原值胜出；
 *  - 'merge'     ：双侧都改，但**精细合并成功**（无残留冲突）→ merged 为合并结果。
 *    'merge' 绝不等于 'useRemote'：把自动合并读成「用了远端」会让 UI/日志谎报数据来源。
 *  - 'conflict'  ：双侧都改且无法安全自动合并 → merged 为 undefined，仅 conflicts 有值。
 */
export type MergeDecision = 'useRemote' | 'keepLocal' | 'merge' | 'skip';

/** 冲突成因（可选字段：旧调用方/旧数据没有它，UI 缺省按 'both-modified' 措辞）。 */
export type MergeConflictReason =
  | 'both-modified'
  | 'modify-delete'
  | 'delete-modify'
  | 'no-ancestor'
  | 'binary'
  | 'too-large'
  | 'overlap'
  | 'array'
  | 'format'
  | 'section';

/** 分区内精细合并产生的单条冲突（JSON 叶子 / FilesSection 单文件）。 */
export interface MergeConflict {
  /** 冲突位置：JSON 分区是**点号路径**（'a.b.c'，整分区为 '$'）；FilesSection 是 relativePath。 */
  path: string;
  kind: 'key' | 'file';
  /** 冲突成因（可选：旧数据没有该字段；UI 缺省按 'both-modified' 措辞） */
  reason?: MergeConflictReason;
  /** 是否已尝试自动合并（true + reason='binary'/'too-large'/'array' = 试过但不安全，故留冲突） */
  autoMergeAttempted?: boolean;
  local?: unknown;
  remote?: unknown;
  ancestor?: unknown;
}

export interface MergeSectionResult {
  id: SectionId;
  /** 分区级决策；'skip' 时无 merged/conflicts；'conflict' 时 merged 为 undefined（仅 conflicts）。 */
  decision: MergeDecision | 'conflict';
  /** decision 为 'useRemote' / 'keepLocal' / 'merge' 时为整分区数据（原值或合并结果）。 */
  merged?: SectionData;
  /** 仅 decision === 'conflict' 时非空：分区级冲突或精细合并后剩余冲突。 */
  conflicts: MergeConflict[];
  /**
   * 自动合并并入的变更点数量（仅 decision === 'merge' 时有意义；缺省 undefined = 未统计）。
   * UI 用它区分「远端整分区覆盖」与「双方改动都保住了」。
   */
  autoMerged?: number;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 与 sync-state 的判定保持一致（鸭子类型）：{ version: 1, files: [...] }。 */
function isFilesSectionData(data: SectionData): data is FilesSection {
  if (data === null || typeof data !== 'object') return false;
  const obj = data as { version?: unknown; files?: unknown };
  return obj.version === 1 && Array.isArray(obj.files);
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 文本/字节级合并产出的冲突成因 → 统一冲突成因。 */
function mapConflictReason(reason: TextMergeConflict['reason']): MergeConflictReason {
  switch (reason) {
    case 'array': return 'array';
    case 'format': return 'format';
    case 'binary': return 'binary';
    case 'too-large': return 'too-large';
    default: return 'both-modified'; // 'overlap'（文本行重叠）= 双侧改同一处，统一口径
  }
}

function fromTextConflicts(list: TextMergeConflict[]): MergeConflict[] {
  return list.map((c) => ({
    path: c.path === '' ? '$' : c.path,
    kind: 'key' as const,
    reason: mapConflictReason(c.reason),
    autoMergeAttempted: true,
    ...(c.local !== undefined ? { local: c.local } : {}),
    ...(c.remote !== undefined ? { remote: c.remote } : {}),
    ...(c.ancestor !== undefined ? { ancestor: c.ancestor } : {}),
  }));
}

/**
 * 统计「自动合并并入了几个变更点」：叶子级比较，双侧值不同且合并结果取到一侧即计 1。
 * 只统计对象叶子（数组按整体 1 个点），口径 = 用户能感知的「两边各自的改动都保住了」处数。
 */
function countMergePoints(local: unknown, remote: unknown, merged: unknown): number {
  if (isPlainObject(local) && isPlainObject(remote) && isPlainObject(merged)) {
    const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote), ...Object.keys(merged)]);
    let n = 0;
    for (const k of keys) n += countMergePoints(local[k], remote[k], merged[k]);
    return n;
  }
  if (Array.isArray(local) || Array.isArray(remote) || Array.isArray(merged)) {
    return deepEqual(local, remote) ? 0 : 1;
  }
  return deepEqual(local, remote) ? 0 : 1;
}

/**
 * FilesSection 精细合并：按 relativePath 逐文件三方合并。
 *  - 双侧都改且内容不同 → 先尝试行级三方合并（文本/JSON）；成功并入，失败留冲突（reason 如实）；
 *  - 只有一侧改 → 采纳改动侧；
 *  - 一侧删、另一侧改/新增 → modify-delete / delete-modify 冲突（绝不直接删数据）；
 *  - 一侧删、另一侧未改 → 跟随删除。
 */
function mergeFilesSectionGranular(
  local: FilesSection,
  remote: FilesSection,
  ancestor: FilesSection | undefined,
): { merged: FilesSection; conflicts: MergeConflict[]; mergePoints: number } {
  const lMap = new Map<string, Uint8Array>();
  for (const f of local.files) lMap.set(f.relativePath, f.data);
  const rMap = new Map<string, Uint8Array>();
  for (const f of remote.files) rMap.set(f.relativePath, f.data);
  const aMap = new Map<string, Uint8Array>();
  if (ancestor) for (const f of ancestor.files) aMap.set(f.relativePath, f.data);

  const paths = new Set<string>([...lMap.keys(), ...rMap.keys(), ...aMap.keys()]);
  const mergedFiles: FilesSection['files'] = [];
  const conflicts: MergeConflict[] = [];
  let mergePoints = 0;
  const push = (relativePath: string, data: Uint8Array): void => {
    mergedFiles.push({ relativePath, data, contentHash: '' });
  };
  for (const path of [...paths].sort()) {
    const l = lMap.get(path);
    const r = rMap.get(path);
    const a = aMap.get(path);
    if (l !== undefined && r !== undefined) {
      if (bytesEqual(l, r)) { push(path, l); continue; }
      const lChanged = a === undefined || !bytesEqual(l, a);
      const rChanged = a === undefined || !bytesEqual(r, a);
      if (lChanged && rChanged) {
        const attempt = mergeBytesThreeWay(a, l, r);
        if (attempt.ok && attempt.merged !== undefined) {
          push(path, attempt.merged);
          mergePoints += 1;
          continue;
        }
        conflicts.push({
          path,
          kind: 'file',
          reason: attempt.kind === 'binary' || attempt.kind === 'too-large'
            ? (attempt.kind === 'binary' ? 'binary' : 'too-large')
            : 'both-modified',
          autoMergeAttempted: true,
          local: l,
          remote: r,
          ancestor: a,
        });
        continue;
      }
      if (lChanged) { push(path, l); mergePoints += 1; continue; }
      if (rChanged) { push(path, r); mergePoints += 1; continue; }
      push(path, l);
      continue;
    }
    if (l !== undefined && r === undefined) {
      const aExists = a !== undefined;
      if (aExists && bytesEqual(l, a)) continue; // 本地未改、远端删 → 跟随删除
      if (!aExists) { push(path, l); mergePoints += 1; continue; } // 纯本地新增
      conflicts.push({ path, kind: 'file', reason: 'modify-delete', local: l, remote: undefined, ancestor: a });
      continue;
    }
    if (l === undefined && r !== undefined) {
      const aExists = a !== undefined;
      if (aExists && bytesEqual(r, a)) continue; // 远端未改、本地删 → 跟随删除
      if (!aExists) { push(path, r); mergePoints += 1; continue; } // 纯远端新增
      conflicts.push({ path, kind: 'file', reason: 'delete-modify', local: undefined, remote: r, ancestor: a });
      continue;
    }
    // 双侧都删（或仅祖先有）：跟随删除，不产生动作。
  }
  return { merged: { version: 1, files: mergedFiles }, conflicts, mergePoints };
}

/** 单分区三方合并（决策链见文件头注释）。 */
function mergeSectionTriple(
  id: SectionId,
  lData: SectionData | undefined,
  rData: SectionData | undefined,
  aData: SectionData | undefined,
  h: TripleHashes,
): MergeSectionResult {
  // ⓪ 形状闸门（先于一切取舍）：远端载荷来自不可信输入（解析层只保证整体是合法 JSON，
  //    不保证每个分区的值形状正确）。值形状不对时**绝不原样采用** —— 那等于把畸形数据
  //    写进本机配置；一律按 conflict(reason='format') 交用户裁决。
  if (lData !== undefined && !isPlainObject(lData)) {
    return {
      id,
      decision: 'conflict',
      conflicts: [{ path: '$', kind: 'key', reason: 'format', autoMergeAttempted: false, local: lData, remote: rData, ancestor: aData }],
    };
  }
  if (rData !== undefined && !isPlainObject(rData)) {
    return {
      id,
      decision: 'conflict',
      conflicts: [{ path: '$', kind: 'key', reason: 'format', autoMergeAttempted: false, local: lData, remote: rData, ancestor: aData }],
    };
  }
  // ① 远端无该分区：本地未改 → 无变化；本地改了 → 冲突（不准把本地改动当垃圾丢掉）
  if (rData === undefined && lData !== undefined) {
    const lChanged = h.ancestor === undefined || h.local !== h.ancestor;
    if (!lChanged) return { id, decision: 'skip', conflicts: [] };
    return {
      id,
      decision: 'conflict',
      conflicts: [{
        path: '$',
        kind: 'key',
        reason: h.ancestor === undefined ? 'no-ancestor' : 'modify-delete',
        autoMergeAttempted: false,
        local: lData,
        remote: undefined,
        ancestor: aData,
      }],
    };
  }
  // ② 本地无该分区、远端有：远端未改 → 无变化；远端改了 → 采用远端（分区缺失不是删除语义，见文件头）
  if (lData === undefined && rData !== undefined) {
    const rChanged = h.ancestor === undefined || h.remote !== h.ancestor;
    if (!rChanged) return { id, decision: 'skip', conflicts: [] };
    return { id, decision: 'useRemote', merged: rData, conflicts: [] };
  }
  if (lData === undefined && rData === undefined) return { id, decision: 'skip', conflicts: [] };
  const local = lData as SectionData;
  const remote = rData as SectionData;
  if (h.local === h.remote) return { id, decision: 'skip', conflicts: [] };
  // 分区形态互换（一侧 FilesSection、一侧 JSON 分区）→ 早于 useRemote/keepLocal 判冲突：
  // 「远端改了、本地没改」不足以支撑把另一种形态的数据整分区写进本机（语义不同，采用必错）。
  if (isFilesSectionData(local) !== isFilesSectionData(remote)) {
    return {
      id,
      decision: 'conflict',
      conflicts: [{ path: '$', kind: 'key', reason: 'section', autoMergeAttempted: false, local, remote, ancestor: aData }],
    };
  }
  if (h.ancestor === undefined) {
    return {
      id,
      decision: 'conflict',
      conflicts: [{ path: '$', kind: 'key', reason: 'no-ancestor', autoMergeAttempted: false, local, remote, ancestor: undefined }],
    };
  }
  if (h.local === h.ancestor) return { id, decision: 'useRemote', merged: remote, conflicts: [] };
  if (h.remote === h.ancestor) return { id, decision: 'keepLocal', merged: local, conflicts: [] };

  // ③ 双侧相对祖先都改 → 精细合并（形状与形态闸门已在 ⓪/前段通过）
  if (isFilesSectionData(local) && isFilesSectionData(remote)) {
    const aFiles = aData !== undefined && isFilesSectionData(aData) ? aData : undefined;
    const { merged, conflicts, mergePoints } = mergeFilesSectionGranular(local, remote, aFiles);
    if (conflicts.length === 0 && mergePoints > 0) {
      return { id, decision: 'merge', merged, conflicts: [], autoMerged: mergePoints };
    }
    if (conflicts.length === 0) {
      // 双侧都改但合并结果与某一侧逐字相同 → 如实报是哪一侧赢了（不谎称「合并」）
      const mh = hashSection(merged);
      if (mh === h.remote) return { id, decision: 'useRemote', merged, conflicts: [] };
      if (mh === h.local) return { id, decision: 'keepLocal', merged, conflicts: [] };
      return { id, decision: 'merge', merged, conflicts: [], autoMerged: 0 };
    }
    return { id, decision: 'conflict', conflicts };
  }
  if (isPlainObject(local) && isPlainObject(remote)) {
    const aJson = aData !== undefined && isPlainObject(aData) ? aData : undefined;
    const res = mergeJsonValues(aJson, local, remote);
    if (!res.ok || res.merged === undefined) {
      const conflicts = res.conflicts.length > 0
        ? fromTextConflicts(res.conflicts)
        : [{ path: '$', kind: 'key' as const, reason: 'format' as const, autoMergeAttempted: true, local, remote, ancestor: aData }];
      return { id, decision: 'conflict', conflicts };
    }
    const merged = res.merged as SectionData;
    if (res.conflicts.length === 0) {
      const mh = hashSection(merged);
      if (mh === h.remote) return { id, decision: 'useRemote', merged, conflicts: [] };
      if (mh === h.local) return { id, decision: 'keepLocal', merged, conflicts: [] };
      return { id, decision: 'merge', merged, conflicts: [], autoMerged: countMergePoints(local, remote, merged) };
    }
    return { id, decision: 'conflict', conflicts: fromTextConflicts(res.conflicts) };
  }
  // 类型不一致（一侧 FilesSection、一侧 JSON）或非对象 → 整分区冲突，交用户裁决
  return {
    id,
    decision: 'conflict',
    conflicts: [{ path: '$', kind: 'key', reason: 'section', autoMergeAttempted: false, local, remote, ancestor: aData }],
  };
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
    results.push(mergeSectionTriple(id, l[id], r[id], a ? a[id] : undefined, hashes.get(id)!));
  }
  return { sections: results };
}
