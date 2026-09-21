/**
 * Migration History 纯渲染模型（Phase 6，Step 7）：框架无关，node 可测。
 *
 * 职责：把 `MigrationHistoryEntry[]` + 过滤条件映射为 UI 展示所需的纯数据——
 * 结果徽章语义（ok/error/warn）、kind 分类标签、统计、过滤选项、空态判定。
 * **非控制器**：不持有状态、不发起请求；HistoryPanel 只做装配（渲染 + 交互状态），
 * 把本模块纯函数输出绑定到 React 组件。
 *
 * 安全（UI HARD RULES）：本模块绝不把 failed 显示为成功；所有自由文本（summary/error）
 * 由上层在渲染前过 redact()。kind / result / sections 均为枚举常量，无 secret 承载面。
 */
import type { MigrationKind, MigrationResult, StoredMigrationHistoryEntry } from '../core/migration-history.ts';

/** 结果徽章语义（Badge kind 四态中的三态；skipped 归 warn）。 */
export function resultBadgeKind(result: MigrationResult): 'ok' | 'error' | 'warn' | 'info' {
  if (result === 'success') return 'ok';
  if (result === 'failed') return 'error';
  return 'warn'; // skipped
}

/** kind 标签（本地化 key 基名；i18n 字典用 `history.kind.<kind>` 渲染）。 */
export type HistoryKindLabelKey = `history.kind.${MigrationKind}`;

export function kindLabelKey(kind: MigrationKind): HistoryKindLabelKey {
  return `history.kind.${kind}` as HistoryKindLabelKey;
}

/** 全量 kind 枚举（UI 过滤下拉用；顺序 = §5 清单顺序）。 */
export const HISTORY_KIND_OPTIONS: readonly MigrationKind[] = [
  'import', 'restore', 'rollback',
  'profile-create', 'profile-select', 'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
  'sync-apply', 'autosync', 'recovery',
  'backup', 'backup-manual', 'snapshot-delete', 'snapshot-prune',
] as const;

/** 结果过滤选项。 */
export const HISTORY_RESULT_OPTIONS: readonly MigrationResult[] = ['success', 'failed', 'skipped'] as const;

/** 过滤模型（UI 状态；空 = 不过滤）。 */
export interface HistoryFilter {
  kind?: MigrationKind;
  result?: MigrationResult;
  /** 时间范围：最近 N 条（0 = 全部）。 */
  recent?: number;
  query: string;
}

/** 把 UI 过滤模型转为后端 query 参数（kind/recent 转 kinds/recent 语义）。 */
export function filterToQuery(f: HistoryFilter): Record<string, string | undefined> {
  const q: Record<string, string | undefined> = {};
  if (f.kind !== undefined) q['kind'] = f.kind;
  if (f.result !== undefined) q['result'] = f.result;
  return q;
}

/**
 * 客户端侧 kind/result 过滤（与后端 query 的关系）：
 * `filterToQuery` 描述的是**后端** `/history?kind=…&result=…` 的查询契约；HistoryPanel 目前
 * 一次性拉取全量条目（`historyApi.list()` 不带参数），因此分类筛选改由本纯函数在前端收敛。
 * 两者语义一致（kind / result 各自为空即不约束，同时给出时取交集），后端 query 保持可用，
 * 后续若改为服务端过滤可无缝切回 `filterToQuery`。
 *
 * 规则：`undefined` 或 `''` 视为「不过滤」；保持输入顺序（不做排序）。
 */
export function filterByKindResult(
  entries: StoredMigrationHistoryEntry[],
  kind?: MigrationKind,
  result?: MigrationResult,
): StoredMigrationHistoryEntry[] {
  // 归一为 string 比较：运行时 select 的 value 可能是 ''（空 = 全部），类型上不会出现但需兜底
  const wantKind: string = kind ?? '';
  const wantResult: string = result ?? '';
  if (wantKind === '' && wantResult === '') return entries;
  return entries.filter((e) => {
    if (wantKind !== '' && e.kind !== wantKind) return false;
    if (wantResult !== '' && e.result !== wantResult) return false;
    return true;
  });
}

/**
 * 归纳当前数据里**真实出现过**的 kind（按 HISTORY_KIND_OPTIONS 顺序去重）。
 *
 * 用于过滤下拉：全量枚举 14 类中有大量分类（profile-delete/rename/import、snapshot-prune…）
 * 在本机历史里永远不会出现，把它们列进下拉只会让用户选出「永远为空」的结果。
 * 空数据返回空数组。
 *
 * @param keepSelected 当前选中值：即使数据里已不存在也保留在选项里（位置仍按
 *   HISTORY_KIND_OPTIONS 顺序）——否则用户会看到「下拉里没有自己刚选中的项」的怪状态。
 */
export function collectHistoryKinds(
  entries: StoredMigrationHistoryEntry[],
  keepSelected?: MigrationKind,
): MigrationKind[] {
  const present = new Set<MigrationKind>();
  for (const e of entries) present.add(e.kind);
  if (keepSelected !== undefined) present.add(keepSelected);
  return HISTORY_KIND_OPTIONS.filter((k) => present.has(k));
}

/**
 * 归纳当前数据里**真实出现过**的 result（按 HISTORY_RESULT_OPTIONS 顺序去重）。
 * 与 collectHistoryKinds 同语义（「结果」下拉同样不列不存在的项，且保留当前选中值）。
 */
export function collectHistoryResults(
  entries: StoredMigrationHistoryEntry[],
  keepSelected?: MigrationResult,
): MigrationResult[] {
  const present = new Set<MigrationResult>();
  for (const e of entries) present.add(e.result);
  if (keepSelected !== undefined) present.add(keepSelected);
  return HISTORY_RESULT_OPTIONS.filter((r) => present.has(r));
}

/** 按 kind + result 分组的渲染模型（卡片列表直接消费）。 */
export interface HistoryGroup {
  kind: MigrationKind;
  kindLabelKey: HistoryKindLabelKey;
  count: number;
  /** 已按时间倒序（新→旧）。 */
  entries: StoredMigrationHistoryEntry[];
}

/** 统计摘要（纯函数；供统计徽章行）。 */
export interface HistorySummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export function summarize(entries: StoredMigrationHistoryEntry[]): HistorySummary {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const e of entries) {
    if (e.result === 'success') success += 1;
    else if (e.result === 'failed') failed += 1;
    else skipped += 1;
  }
  return { total: entries.length, success, failed, skipped };
}

/**
 * 按 kind 分组（保持 HISTORY_KIND_OPTIONS 顺序），组内按 at 时间倒序。
 * 空组不渲染。纯函数，无 IO。
 */
export function groupByKind(entries: StoredMigrationHistoryEntry[]): HistoryGroup[] {
  const byKind = new Map<MigrationKind, StoredMigrationHistoryEntry[]>();
  for (const e of entries) {
    const list = byKind.get(e.kind);
    if (list === undefined) byKind.set(e.kind, [e]);
    else list.push(e);
  }
  const groups: HistoryGroup[] = [];
  for (const kind of HISTORY_KIND_OPTIONS) {
    const list = byKind.get(kind);
    if (list === undefined) continue;
    list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    groups.push({ kind, kindLabelKey: kindLabelKey(kind), count: list.length, entries: list });
  }
  return groups;
}

/**
 * 最近 N 条过滤（0 = 全部）。按 at 时间倒序取前 N。
 */
export function applyRecent(entries: StoredMigrationHistoryEntry[], recent: number): StoredMigrationHistoryEntry[] {
  if (recent <= 0) return entries;
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return sorted.slice(0, recent);
}

/** 客户端侧文本子串过滤（补充后端过滤；按 summary/error/kind 匹配，大小写不敏感）。 */
export function filterByText(entries: StoredMigrationHistoryEntry[], query: string): StoredMigrationHistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  return entries.filter((e) =>
    e.kind.toLowerCase().includes(q) ||
    e.summary.toLowerCase().includes(q) ||
    (e.error ?? '').toLowerCase().includes(q) ||
    e.sections.some((s) => s.toLowerCase().includes(q)),
  );
}

/** 空态判定。 */
export function isEmpty(entries: StoredMigrationHistoryEntry[]): boolean {
  return entries.length === 0;
}

/**
 * 分区列的紧凑显示：至多 `max` 个，其余折叠为 `+N`；空数组 → null（调用方不渲染占位）。
 * 全量备份条目常带 10+ 个分区，整条铺在窄抽屉的行里会把摘要挤到看不见。
 */
export function formatHistorySections(sections: readonly string[], max = 3): string | null {
  if (sections.length === 0) return null
  if (sections.length <= max) return sections.join(', ')
  return `${sections.slice(0, max).join(', ')} +${sections.length - max}`
}
