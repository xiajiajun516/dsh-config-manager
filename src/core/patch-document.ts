/**
 * patch 文档的**结构重建**（issue #133）。
 *
 * 为什么需要独立一层：`cordis.patch.yml` 的两种形态语义**不等价**（宿主 dsh-app-boot 的
 * readProfilePatches 合并循环）：
 *   - 顶层 `- id: X` → 按 id **覆盖**已存在的条目；id 查不到时打 `patch: entry "X" not found` 丢弃；
 *   - `- insert:` 块成员 → **新增**条目（`data.push(...clone)`，唯一的新增路径）。
 * 此前重建时把所有行（含 insert 成员）统一输出成顶层行，于是「只能靠 insert 新增」的条目
 * （典型是 MCP server）在 DSH 侧全部失效 —— 一条 update 就够触发。
 *
 * 本模块只做**结构**：不读文件、不碰 YAML（core 层零依赖），输入是已解析的文档 + 变更清单，
 * 输出是重建后的条目数组与两套 id。序列化与自检在宿主门面（DshPatchFileFacade）里做。
 *
 * 三条不变量：
 *  ① 原本是 insert 成员的 id，重建后仍在 insert 块里（update 不改变归属）；
 *  ② 新增条目（`action:'insert'` 且文档里没有）落进 insert 块，而不是顶层行；
 *  ③ 任一 id 不得同时出现在顶层与 insert 两处 —— 计划阶段就抛错（防御性，正常路径不可达）。
 */
export interface PatchLineChange {
  lineId: string;
  raw: unknown;
  action: 'insert' | 'update' | 'remove';
}

export interface PatchDocumentPlan {
  /** 重建后的文档条目（顺序尽量贴原文档：顶层行原位、insert 块原位、新增项追加在尾部） */
  items: unknown[];
  /** 落在 insert 块里的 id（按输出顺序） */
  insertIds: string[];
  /** 落在顶层行里的 id（按输出顺序） */
  topLevelIds: string[];
}

/** 计划会把 insert 成员提升成顶层行：调用方必须放弃这次写入（零写入）。 */
export class PatchPromoteRefusedError extends Error {
  readonly ids: string[];
  constructor(ids: string[]) {
    super('patch rebuild would promote insert members to top-level rows: ' + ids.join(', '));
    this.name = 'PatchPromoteRefusedError';
    this.ids = ids;
  }
}

interface SlotState {
  raw: unknown;
  inInsert: boolean;
}

type Slot = { kind: 'row'; id: string } | { kind: 'block'; ids: string[] };

function entryId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : null;
}

function blockMembers(value: unknown): Record<string, unknown>[] | null {
  if (value === null || typeof value !== 'object') return null;
  const insert = (value as Record<string, unknown>)['insert'];
  if (!Array.isArray(insert)) return null;
  return insert.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object');
}

/** 读出文档里的 insert 成员 id 与顶层行 id（自检与测试共用；不判重、保持文档顺序）。 */
export function describePatchDocument(doc: unknown): { insertIds: string[]; topLevelIds: string[] } {
  const insertIds: string[] = [];
  const topLevelIds: string[] = [];
  if (!Array.isArray(doc)) return { insertIds, topLevelIds };
  for (const item of doc) {
    const members = blockMembers(item);
    if (members !== null) {
      for (const member of members) {
        const id = entryId(member);
        if (id !== null) insertIds.push(id);
      }
      continue;
    }
    const id = entryId(item);
    if (id !== null) topLevelIds.push(id);
  }
  return { insertIds, topLevelIds };
}

/**
 * 重建成 patch 文档条目。
 *
 * `doc` 是已解析的原文档（非数组视为空文档）；顺序按原布局保留，新增项追加在尾部。
 */
export function planPatchDocument(doc: unknown, changes: readonly PatchLineChange[]): PatchDocumentPlan {
  const state = new Map<string, SlotState>();
  const layout: Slot[] = [];

  if (Array.isArray(doc)) {
    for (const item of doc) {
      const members = blockMembers(item);
      if (members !== null) {
        const ids: string[] = [];
        for (const member of members) {
          const id = entryId(member);
          if (id === null) continue;
          ids.push(id);
          if (!state.has(id)) state.set(id, { raw: member, inInsert: true });
        }
        if (ids.length > 0) layout.push({ kind: 'block', ids });
        continue;
      }
      const id = entryId(item);
      if (id === null) continue;
      layout.push({ kind: 'row', id });
      if (!state.has(id)) state.set(id, { raw: item, inInsert: false });
    }
  }

  for (const change of changes) {
    if (change.action === 'remove') {
      state.delete(change.lineId);
      continue;
    }
    const previous = state.get(change.lineId);
    // 归属只由**原文档**决定：更新一条既有 insert 成员不会把它搬到顶层；新增才按动作分流
    const inInsert = previous !== undefined ? previous.inInsert : change.action === 'insert';
    state.set(change.lineId, { raw: change.raw, inInsert });
  }

  const items: unknown[] = [];
  const insertIds: string[] = [];
  const topLevelIds: string[] = [];
  const emitted = new Set<string>();

  const emitRow = (id: string): void => {
    const slot = state.get(id);
    if (slot === undefined || emitted.has(id)) return;
    emitted.add(id);
    items.push(slot.raw);
    topLevelIds.push(id);
  };
  const emitBlock = (ids: string[]): void => {
    const members = ids.filter((id) => {
      const slot = state.get(id);
      return slot !== undefined && slot.inInsert && !emitted.has(id);
    });
    if (members.length === 0) return;
    for (const id of members) emitted.add(id);
    items.push({ insert: members.map((id) => state.get(id)!.raw) });
    insertIds.push(...members);
  };

  for (const slot of layout) {
    if (slot.kind === 'row') emitRow(slot.id);
    else emitBlock(slot.ids);
  }

  // 新写入、且原文档布局里没有的 id：insert 动作进块，update 动作保持旧的 upsert 语义（顶层行）
  for (const [id, slot] of state) {
    if (emitted.has(id)) continue;
    if (slot.inInsert) continue;
    emitRow(id);
  }
  emitBlock([...state.keys()].filter((id) => !emitted.has(id)));

  // 不变量③：同一 id 不得两种身份并存（正常路径不可达；坏了就拒写，别写出一份语义分裂的文件）
  const promoted = insertIds.filter((id) => topLevelIds.includes(id));
  if (promoted.length > 0) throw new PatchPromoteRefusedError(promoted);

  return { items, insertIds, topLevelIds };
}
/**
 * 计划布局与观察到的布局是否一致（写后自检用，issue #133）。
 * 一致返回 `null`；不一致返回一句可直接进错误文案的差异说明（只含 id，不含值）。
 */
export function describePatchLayoutDrift(
  planned: { insertIds: readonly string[]; topLevelIds: readonly string[] },
  observed: { insertIds: readonly string[]; topLevelIds: readonly string[] },
): string | null {
  const same = planned.insertIds.length === observed.insertIds.length
    && planned.topLevelIds.length === observed.topLevelIds.length
    && planned.insertIds.every((id, i) => id === observed.insertIds[i])
    && planned.topLevelIds.every((id, i) => id === observed.topLevelIds[i]);
  if (same) return null;
  const fmt = (label: string, ids: readonly string[]): string => label + '=[' + ids.join(', ') + ']';
  return 'planned ' + fmt('insert', planned.insertIds) + ' ' + fmt('top-level', planned.topLevelIds)
    + '; got ' + fmt('insert', observed.insertIds) + ' ' + fmt('top-level', observed.topLevelIds);
}
/**
 * 跨层提升检查（issue #133）：`topLevelIds` 里哪些是**另一层文档**的 `- insert:` 成员。
 *
 * 命中就意味着「把新增改写成覆盖」——目标作用域里那条通常不存在，宿主会 `not found` 丢弃。
 * `otherDoc` 读不到或解析不了时调用方传 `undefined`，本函数返回空（守卫只做加强）。
 */
export function promotedTopLevelIds(otherDoc: unknown, topLevelIds: readonly string[]): string[] {
  if (topLevelIds.length === 0) return [];
  const insertMembers = new Set(describePatchDocument(otherDoc).insertIds);
  return topLevelIds.filter((id) => insertMembers.has(id));
}
