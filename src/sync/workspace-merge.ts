/**
 * workspaces 分区的**记录级**三方合并（issue #127）。
 *
 * 为什么不能走通用 JSON 合并：`merge.ts` 的 `mergeJsonValues` 对数组一律「双侧都改且不逐字相等
 * → 冲突」（数组绝不按索引合并，见该文件头）。而 workspaces 的 `sessionIds` 天生两侧都会各自增长
 * ——A 机把会话挂进工作区、B 机也挂，两条记录就永远冲突，用户每轮同步都要手工裁决，且无论选哪
 * 一侧都会**静默丢掉另一侧的会话归属**（丢归属 = 那几次对话在目标机的工作区里看不见）。
 *
 * 因此这里按「记录 id」做并集，规则逐条如下（与 git 的三方口径一致，祖先只用于判断「谁改了这一
 * 字段」，**绝不猜**）：
 *  - `sessionIds`：恒取两侧并集（本地在前、远端新增按原序追加，按裸键去重）。这是本分区唯一的
 *    「合并」语义：挂接只是提示，多余的 id 最多 attach 不到会话，而少了 id 会让本地已有会话直接
 *    从工作区消失；
 *  - 其它字段（path / title / createdAt / updatedAt / 未来新增字段）：两侧相同即取该值；不同时
 *    看祖先 —— 只有一侧相对祖先变了取变更侧；两侧都变了（或没有祖先）→ **冲突**（点号路径
 *    `workspaces.<id>.<field>`，交用户裁决），绝不按「先到者 / 本地优先」静默取舍；
 *  - 只在单侧存在的记录：有祖先且该侧与祖先逐字相同 → 跟随另一侧的删除（真删除）；否则保留它
 *    —— 无祖先时无法区分「对方删了」与「本机独有」，保留是唯一不丢数据的解释；有祖先且该侧
 *    与祖先不同则记冲突（modify-delete），交用户裁决。
 *
 * 纯函数、零 I/O；形状不认识（非 `{version:1, workspaces:[]}`）时返回 undefined，交回通用合并
 * 路径处理（畸形数据由通用路径的形状闸门拒绝，这里不另造一套判定）。
 */
import type { SectionData, WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
import type { MergeConflict } from './merge.ts';

/** 记录级合并结果：`merged` 为整分区数据；`conflicts` 非空时上层按 conflict 处置（不半应用）。 */
export interface GranularMergeOutcome {
  merged: SectionData;
  conflicts: MergeConflict[];
  /** 自动并入的变更点（口径 = 用户能感知的「两侧各自的改动都保住了」处数） */
  mergePoints: number;
}

/**
 * 钩子可读的合并上下文：目前只有 plugins 需要 —— 「跟随远端删除插件」是用户开关，
 * 关着时钩子必须**不参与**（交给通用路径 = 与未引入 #132 前逐字一致），否则会静默丢掉本机条目。
 */
export interface GranularMergeHooks {
  deletePlugins?: boolean;
}

/** 记录级合并钩子签名（`merge.ts` 按分区 id 调用；返回 undefined = 不参与，走通用路径）。 */
export type GranularMerger = (
  local: SectionData,
  remote: SectionData,
  ancestor: SectionData | undefined,
  hooks?: GranularMergeHooks,
) => GranularMergeOutcome | undefined;

function isWorkspaces(data: SectionData | undefined): data is WorkspacesSection {
  if (data === null || typeof data !== 'object') return false;
  const obj = data as { version?: unknown; workspaces?: unknown };
  return obj.version === 1 && Array.isArray(obj.workspaces);
}

function recordsById(list: readonly WorkspaceRecord[]): Map<string, WorkspaceRecord> {
  const map = new Map<string, WorkspaceRecord>();
  for (const rec of list) {
    if (rec !== null && typeof rec === 'object' && typeof rec.id === 'string') map.set(rec.id, rec);
  }
  return map;
}

/** 深度判等（本分区只有标量与字符串数组，够用；不引入通用深比较的第二份实现）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!sameValue(ao[k], bo[k])) return false;
  return true;
}

/** sessionIds 并集：本地在前、远端新增按原序追加，按裸 id 去重。 */
function unionSessionIds(local: readonly string[], remote: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...local, ...remote]) {
    if (typeof id !== 'string') continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * 单个记录合并：字段级三方取舍 + sessionIds 并集。
 * @returns 合并后的记录与「相对本地改动的字段数」（供 autoMerged 计数）。
 */
function mergeRecord(
  id: string,
  local: WorkspaceRecord,
  remote: WorkspaceRecord,
  ancestor: WorkspaceRecord | undefined,
  conflicts: MergeConflict[],
): { rec: WorkspaceRecord; changedFields: number } {
  const out: Record<string, unknown> = {};
  let changedFields = 0;
  const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const lv = (local as unknown as Record<string, unknown>)[key];
    const rv = (remote as unknown as Record<string, unknown>)[key];
    const av = ancestor === undefined ? undefined : (ancestor as unknown as Record<string, unknown>)[key];
    let picked: unknown;
    if (key === 'id') {
      picked = id;
    } else if (key === 'sessionIds') {
      const union = unionSessionIds(
        Array.isArray(lv) ? (lv as string[]) : [],
        Array.isArray(rv) ? (rv as string[]) : [],
      );
      if (!sameValue(union, lv)) changedFields += 1;
      picked = union;
    } else if (sameValue(lv, rv)) {
      picked = lv;
    } else if (ancestor !== undefined && sameValue(lv, av)) {
      picked = rv; // 仅远端改了
      changedFields += 1;
    } else if (ancestor !== undefined && sameValue(rv, av)) {
      picked = lv; // 仅本地改了
    } else {
      // 双侧都改（或无祖先，无从判断谁改）→ 冲突，保留本地值供用户对照，绝不静默取舍
      conflicts.push({
        path: 'workspaces.' + id + '.' + key,
        kind: 'key',
        reason: ancestor === undefined ? 'no-ancestor' : 'both-modified',
        autoMergeAttempted: true,
        local: lv,
        remote: rv,
        ancestor: av,
      });
      picked = lv;
    }
    if (picked !== undefined) out[key] = picked;
  }
  return { rec: out as unknown as WorkspaceRecord, changedFields };
}

/** workspaces 分区记录级合并（`merge.ts` 的分区钩子）。 */
export const mergeWorkspacesSection: GranularMerger = (local, remote, ancestor) => {
  if (!isWorkspaces(local) || !isWorkspaces(remote)) return undefined;
  const a = isWorkspaces(ancestor) ? ancestor : undefined;
  const lMap = recordsById(local.workspaces);
  const rMap = recordsById(remote.workspaces);
  const aMap = a === undefined ? new Map<string, WorkspaceRecord>() : recordsById(a.workspaces);

  // 记录顺序：本地既有顺序（用户看得见的稳定顺序）→ 远端新增 → 仅祖先有（等删除判定）
  const ids: string[] = [...lMap.keys()];
  for (const id of rMap.keys()) if (!lMap.has(id)) ids.push(id);
  for (const id of aMap.keys()) if (!lMap.has(id) && !rMap.has(id)) ids.push(id);

  const conflicts: MergeConflict[] = [];
  const mergedRecords: WorkspaceRecord[] = [];
  let mergePoints = 0;
  for (const id of ids) {
    const l = lMap.get(id);
    const r = rMap.get(id);
    const anc = aMap.get(id);
    if (l !== undefined && r !== undefined) {
      const { rec, changedFields } = mergeRecord(id, l, r, anc, conflicts);
      mergedRecords.push(rec);
      mergePoints += changedFields;
      continue;
    }
    if (l !== undefined) {
      if (anc !== undefined && sameValue(l, anc)) continue; // 远端删了、本地未改 → 跟随删除
      if (anc === undefined) { mergedRecords.push(l); continue; }
      conflicts.push({ path: 'workspaces.' + id, kind: 'key', reason: 'modify-delete', autoMergeAttempted: false, local: l, remote: undefined, ancestor: anc });
      mergedRecords.push(l);
      continue;
    }
    if (r !== undefined) {
      if (anc !== undefined && sameValue(r, anc)) continue; // 本地删了、远端未改 → 跟随删除
      mergedRecords.push(r);
      mergePoints += 1; // 远端新增（或本地已删、远端改过：保留远端记录并记并入）
      continue;
    }
  }
  return { merged: { version: 1, workspaces: mergedRecords }, conflicts, mergePoints };
};
