/**
 * 恢复计划预览的展示模型（框架无关纯函数，node 可测）。
 *
 * 输入：RestorePlan（动作清单）+ RestoreChangeSummary（宿主附带的变更状态/行数统计，可为空）
 * 输出：git 风格的分组视图 ——
 *   「将被还原/修改」→「将被删除」→「卸载插件」→「需人工处理」→「无动作（跳过）」
 * 每组带行数合计，供顶部摘要条渲染成「N 个文件 · +X −Y · M 项无动作」。
 *
 * 本层不产出文案；不安全文本（description/detail）的脱敏由渲染层负责（redact）。
 */
import type { RestoreActionKind, RestorePlan } from '../core/restore.ts';
import type { ChangeStatSkipReason, RestoreChangeSummary, SnapshotChangeStatus } from '../core/snapshot-diff.ts';

/** 分组键（渲染顺序 = 变更 → 删除 → 插件 → 人工 → 跳过）。 */
export type RestoreGroupKey = 'changes' | 'deletes' | 'plugins' | 'hints' | 'skips';

/** 组内条目（合并 plan.actions 与 changeSummary；summary 缺失时按 kind 推断）。 */
export interface RestorePlanRow {
  /** plan.actions 下标（打开逐行 diff 时回传给宿主） */
  index: number;
  kind: RestoreActionKind;
  status: SnapshotChangeStatus;
  target?: string;
  blobPath?: string;
  description: string;
  detail?: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeBytes?: number;
  afterBytes?: number;
  added?: number;
  removed?: number;
  statSkipped?: ChangeStatSkipReason;
  /** 该行是否可展开逐行对照 */
  diffable: boolean;
  /** 统计是否来自宿主（false = 旧宿主或未统计） */
  summarized: boolean;
}

export interface RestorePlanGroup {
  key: RestoreGroupKey;
  statuses: readonly SnapshotChangeStatus[];
  rows: RestorePlanRow[];
  added: number;
  removed: number;
  /** 组内已统计行数的条目数（0 = 无可显示的行数） */
  counted: number;
}

export interface RestorePlanStats {
  /** 将被还原 / 新增的文件数（git 语义的 changed） */
  changed: number;
  added: number;
  modified: number;
  deleted: number;
  plugins: number;
  hints: number;
  skips: number;
  /** 所有分组的行数合计 */
  addedLines: number;
  removedLines: number;
  /** 因体积 / 二进制 / 预算未统计行数的条目数 */
  unstatted: number;
}

export interface RestorePlanView {
  groups: RestorePlanGroup[];
  stats: RestorePlanStats;
  /** 宿主是否提供了统计（旧宿主 = false，UI 需要弱化行数展示） */
  summarized: boolean;
  /** 统计因预算触顶被截断 */
  budgetExhausted: boolean;
}

/** 组定义（顺序即渲染顺序）。 */
const GROUP_DEFS: ReadonlyArray<{ key: RestoreGroupKey; statuses: readonly SnapshotChangeStatus[] }> = [
  { key: 'changes', statuses: ['modified', 'added'] },
  { key: 'deletes', statuses: ['deleted'] },
  { key: 'plugins', statuses: ['plugin'] },
  { key: 'hints', statuses: ['hint'] },
  { key: 'skips', statuses: ['skip'] },
];

/** 文件内容类动作（可展开逐行对照）。 */
export function isDiffableKind(kind: RestoreActionKind): boolean {
  return kind === 'hostFileRestore' || kind === 'fileRestore' || kind === 'hostFileRemove' || kind === 'fileRemove';
}

/** 无统计时的状态推断（旧宿主：还原类按「修改」展示，真实状态在打开 diff 后以宿主返回为准）。 */
function statusOfKind(kind: RestoreActionKind): SnapshotChangeStatus {
  switch (kind) {
    case 'hostFileRestore':
    case 'fileRestore':
      return 'modified';
    case 'hostFileRemove':
    case 'fileRemove':
      return 'deleted';
    case 'pluginRemove':
      return 'plugin';
    case 'credentialHint':
      return 'hint';
    default:
      return 'skip';
  }
}

/** 由 changeSummary 建索引（按 plan.actions 下标关联）。 */
function summaryByIndex(summary?: RestoreChangeSummary): Map<number, RestoreChangeSummary['entries'][number]> {
  const map = new Map<number, RestoreChangeSummary['entries'][number]>();
  for (const entry of summary?.entries ?? []) map.set(entry.index, entry);
  return map;
}

/** 恢复计划 → 分组视图 + 统计。 */
export function toRestorePlanView(plan: RestorePlan, summary?: RestoreChangeSummary): RestorePlanView {
  const byIndex = summaryByIndex(summary);
  const rows: RestorePlanRow[] = plan.actions.map((action, index) => {
    const entry = byIndex.get(index);
    return {
      index,
      kind: action.kind,
      status: entry?.status ?? statusOfKind(action.kind),
      target: action.target,
      blobPath: action.blobPath,
      description: action.description,
      detail: action.detail,
      beforeExists: entry?.beforeExists ?? false,
      afterExists: entry?.afterExists ?? false,
      beforeBytes: entry?.beforeBytes,
      afterBytes: entry?.afterBytes,
      added: entry?.added,
      removed: entry?.removed,
      statSkipped: entry?.statSkipped,
      diffable: isDiffableKind(action.kind) && action.target !== undefined,
      summarized: entry !== undefined,
    };
  });
  const groups: RestorePlanGroup[] = [];
  for (const def of GROUP_DEFS) {
    const items = rows.filter((row) => def.statuses.includes(row.status));
    if (items.length === 0) continue;
    let added = 0;
    let removed = 0;
    let counted = 0;
    for (const item of items) {
      if (item.added !== undefined || item.removed !== undefined) {
        added += item.added ?? 0;
        removed += item.removed ?? 0;
        counted += 1;
      }
    }
    groups.push({ key: def.key, statuses: def.statuses, rows: items, added, removed, counted });
  }
  let modified = 0;
  let addedFiles = 0;
  let deleted = 0;
  let plugins = 0;
  let hints = 0;
  let skips = 0;
  let unstatted = 0;
  for (const row of rows) {
    if (row.status === 'modified') modified += 1;
    else if (row.status === 'added') addedFiles += 1;
    else if (row.status === 'deleted') deleted += 1;
    else if (row.status === 'plugin') plugins += 1;
    else if (row.status === 'hint') hints += 1;
    else skips += 1;
    if (row.diffable && row.added === undefined && row.removed === undefined) unstatted += 1;
  }
  return {
    groups,
    summarized: summary !== undefined,
    budgetExhausted: summary?.budgetExhausted ?? false,
    stats: {
      changed: modified + addedFiles,
      added: addedFiles,
      modified,
      deleted,
      plugins,
      hints,
      skips,
      addedLines: groups.reduce((sum, group) => sum + group.added, 0),
      removedLines: groups.reduce((sum, group) => sum + group.removed, 0),
      unstatted,
    },
  };
}

/** 打开某个文件后，用宿主返回的真实状态覆盖推断状态（返回新分组，便于 React 直接替换）。 */
export function withLoadedStatus(view: RestorePlanView, index: number, status: SnapshotChangeStatus, added: number, removed: number): RestorePlanView {
  const rows = view.groups.flatMap((group) => group.rows);
  const target = rows.find((row) => row.index === index);
  if (target === undefined || target.status === status) {
    if (target === undefined) return view;
    return {
      ...view,
      groups: view.groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => (row.index === index ? { ...row, added, removed } : row)),
      })),
    };
  }
  // 状态变化（例如推断为 modified、实际是 added）→ 重新分组
  const patched: RestorePlanRow[] = rows.map((row) => (row.index === index ? { ...row, status, added, removed } : row));
  const groups: RestorePlanGroup[] = [];
  for (const def of GROUP_DEFS) {
    const items = patched.filter((row) => def.statuses.includes(row.status));
    if (items.length === 0) continue;
    let addedSum = 0;
    let removedSum = 0;
    let counted = 0;
    for (const item of items) {
      if (item.added !== undefined || item.removed !== undefined) {
        addedSum += item.added ?? 0;
        removedSum += item.removed ?? 0;
        counted += 1;
      }
    }
    groups.push({ key: def.key, statuses: def.statuses, rows: items, added: addedSum, removed: removedSum, counted });
  }
  return { ...view, groups };
}
