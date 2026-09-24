/**
 * 配置市场区块的客户端渲染装配层（m-market-ui，node 可测）。
 *
 * 设计纪律（市场设计上游依据 = docs/design/2026-08-19-market-publish-design.md：
 * 旧的市场设计文档已在 2026-08-19 大写 Docs/ 清理中删除，其章节号在新文档中不存在，
 * 故只引用该文件、不再引用 § 号）：
 *  - **共享渲染模型唯一权威 = Host 侧 `src/market/view.ts`**（marketStatusText /
 *    marketListSummary / computeItemBadge / marketItemWarnings / needsReview / toMarketListItem）。
 *    本文件原样 **re-export** 这些函数（单一来源，消重，避免与后端漂移）；
 *  - 本文件只保留**客户端专属**的 UI 装配函数（搜索/类别过滤、详情聚合、时间格式化、
 *    供应链警示的 warn/info 着色行、条目来源徽章）——这些不属共享模型，属前端薄层。
 *
 * 安全硬约束（见上：供应链警示恒生成、needsReview 恒 true —— re-export 自后端权威）。
 */

// —— 共享渲染模型：原样 re-export Host 权威（src/market/view.ts），不重复实现 ——
// import 供本地助手委托；export 供调用方（MarketPanel / 测试）使用，单一来源。
import {
  computeItemBadge, marketItemWarnings, marketListSummary, marketStatusText, needsReview, toMarketListItem,
} from '../../market/view.ts';
export {
  computeItemBadge, marketItemWarnings, marketListSummary, marketStatusText, needsReview, toMarketListItem,
};

/* ---------------------------------------------------------------- 客户端专属：搜索 / 类别 */

import type { MarketItemDetail, MarketListItem } from '../../market/types.ts';
import type { ImportAnalysis, ImportPlan, PlanItemKind } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';
import { isOfficialMarket } from '../../market/builtin.ts';

/* ---------------------------------------------------------------- 客户端专属：来源徽章 */

/**
 * 条目来源徽章 kind（阶段 1：条目级来源仓库，docs/design/2026-08-19-market-publish-design.md §3.3）：
 * - `'ok'`（官方）：`item.repo` 缺省（条目与市场仓库同仓）或 `item.repo` 为官方默认地址；
 * - `'warn'`（第三方）：`item.repo` 存在且非官方默认地址（条目由作者自托管仓库发布）。
 * 判定基准复用 `builtin.ts` 的 `isOfficialMarket`（固定官方地址比较）：env 覆盖为预览仓库时，
 * 无 repo 条目随市场头部一并显示第三方徽章，语义自洽。纯函数、node 可测；MarketPanel 只装配。
 */
export function sourceBadgeKind(item: { repo?: string }, builtinUrl: string): 'ok' | 'warn' {
  return isOfficialMarket(item.repo ?? builtinUrl) ? 'ok' : 'warn';
}

/** 条目是否为第三方来源（有 repo 且非官方默认地址；无 repo 条目视为官方/市场同仓）。 */
export function isThirdPartyItem(item: { repo?: string }, builtinUrl: string): boolean {
  return sourceBadgeKind(item, builtinUrl) === 'warn';
}

/** 类别过滤：从条目收集全部出现过的类别（用于「全部类别」下拉）。 */
export function collectCategories(items: readonly MarketListItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    for (const c of it.categories ?? []) set.add(c);
  }
  return [...set];
}

/* ---------------------------------------------------------------- 客户端专属：来源筛选 / 排序 */

/**
 * 来源筛选值（docs/design/2026-08-21-market-star-filter-sort-design.md §3.3.1）：
 * - 'all'      全部来源；
 * - 'official' 官方配置：条目无 repo（= 官方市场仓库自身）或 repo 为官方地址；
 * - 'personal' 个人配置：条目带非官方 repo（作者自托管仓库）。
 * 判定复用 isThirdPartyItem（与来源徽章同一事实源）。
 */
export type MarketSourceFilter = 'all' | 'official' | 'personal'

/** 排序键（下拉框选项）：default = 保持 index 原始顺序。 */
export type MarketSortKey = 'default' | 'updatedAt' | 'stars' | 'name'

/**
 * 来源过滤：'official' 只保留官方条目（非第三方），'personal' 只保留个人条目（第三方），
 * 'all' 不过滤。缺省 'all'（向后兼容旧调用方）。
 */
export function filterBySource(items: readonly MarketListItem[], source: MarketSourceFilter, builtinUrl: string): MarketListItem[] {
  if (source === 'all') return [...items];
  const wantOfficial = source === 'official';
  return items.filter((it) => isThirdPartyItem(it, builtinUrl) !== wantOfficial);
}

/**
 * 排序（纯函数）：按键排序，undefined 值（无 updatedAt / stars）排最后。
 * - updatedAt：降序（最新在前）；无 updatedAt 排最后；
 * - stars：降序（多在前）；无 stars 排最后；
 * - name：升序 A–Z（localeCompare）；
 * - default：保持原顺序。
 * 稳定性：同值保持原相对顺序（Array.prototype.sort 现代引擎稳定）。
 */
export function sortMarketItems(items: readonly MarketListItem[], sortKey: MarketSortKey): MarketListItem[] {
  if (sortKey === 'default') return [...items];
  const copy = [...items];
  copy.sort((a, b) => {
    if (sortKey === 'name') return a.name.localeCompare(b.name);
    if (sortKey === 'stars') {
      const sa = a.stars;
      const sb = b.stars;
      if (sa === undefined && sb === undefined) return 0;
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      return sb - sa;
    }
    // updatedAt
    const ta = a.updatedAt ?? '';
    const tb = b.updatedAt ?? '';
    if (ta === '' && tb === '') return 0;
    if (ta === '') return 1;
    if (tb === '') return -1;
    return tb.localeCompare(ta); // ISO-8601 字符串比较即时间序
  });
  return copy;
}

/**
 * 搜索 + 类别过滤（纯函数，客户端专属）。
 * - query：对 name / author / description / **categories** 做大小写不敏感子串匹配
 *   （空白 query 不过滤；P2-⑭ 增强：类别标签也参与搜索命中——搜「模型」能命中
 *   带 providers 类别标签的条目，不必精确知道字段名）；
 * - category：空串表示不限类别；否则要求 categories 含该值。
 * 返回筛选后的条目（保持原始顺序）。
 */
export function filterMarketItems(
  items: readonly MarketListItem[],
  query: string,
  category: string,
): MarketListItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (category !== '' && !(it.categories ?? []).includes(category)) return false;
    if (q === '') return true;
    if (it.name.toLowerCase().includes(q)) return true;
    if ((it.author ?? '').toLowerCase().includes(q)) return true;
    if ((it.description ?? '').toLowerCase().includes(q)) return true;
    if ((it.categories ?? []).some((c) => c.toLowerCase().includes(q))) return true;
    return false;
  });
}

/** P2-⑭：按分区筛选列表（对已缓存条目生效；未缓存条目 sections 未知 → 在筛选时排除）。
 *  section 传 '' = 不限分区。返回 { matched, unknown }：unknown 为因「未下载、分区未知」
 *  被排除的条目数（UI 提示用）。 */
export function filterMarketBySection(
  items: readonly MarketListItem[],
  section: SectionId | '',
): { matched: MarketListItem[]; unknown: number } {
  if (section === '') return { matched: [...items], unknown: 0 };
  const matched: MarketListItem[] = [];
  let unknown = 0;
  for (const it of items) {
    if (it.sections === undefined) {
      unknown += 1;
      continue;
    }
    if (it.sections.includes(section)) matched.push(it);
  }
  return { matched, unknown };
}

/** 收集列表内已缓存条目的分区并集（分区筛选取值候选；未缓存条目贡献不了分区信息）。 */
export function collectCachedSections(items: readonly MarketListItem[]): SectionId[] {
  const set = new Set<SectionId>();
  for (const it of items) {
    for (const s of it.sections ?? []) set.add(s);
  }
  return [...set];
}

/* ---------------------------------------------------------------- 客户端专属：时间格式化 */

/** ISO-8601 → 本地可读时间（YYYY-MM-DD HH:mm；非法/空输入原样返回）。 */
export function formatMarketTime(iso: string): string {
  if (iso === '') return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------------------------------------------------------- 客户端专属：供应链警示着色行 */

export interface SupplyChainLine {
  kind: 'warn' | 'info';
  text: string;
}

/**
 * 供应链警示 → warn/info 着色行（客户端专属）。**逻辑委托** Host 权威 `marketItemWarnings`
 * （恒生成非官方审核 + 来源 URL + 下载时间 + 作者/来源自述），本层只负责给「非官方审核」标 warn、
 * 其余标 info，供 UI 列表着色。硬不变式：返回恒非空（至少一条），确认导入前必经。
 */
export function marketWarningsLines(
  detail: MarketItemDetail,
  url: string,
  t: UiT = zhUiT,
): SupplyChainLine[] {
  const raw = marketItemWarnings(
    detail.provenance !== undefined || detail.author !== undefined ? { name: detail.name, author: detail.author, provenance: detail.provenance } : undefined,
    url,
    detail.downloadedAt,
    t,
  );
  return raw.map((text, i) => ({ kind: i === 0 ? 'warn' : 'info', text }));
}

/* ---------------------------------------------------------------- 客户端专属：详情聚合视图 */

/** 详情徽章的数据源（由共享 computeItemBadge 的 { statusText, sectionsText, valid } 装配） */
export interface ItemBadge {
  statusKind: 'ok' | 'error' | 'warn';
  statusText: string;
  sectionsText: string;
  valid: boolean;
}

/** 聚合详情视图：徽章 + 供应链警示 + 校验错误 + 可否导入。 */
export interface MarketDetailView {
  badge: ItemBadge;
  warnings: SupplyChainLine[];
  /** 校验错误列表（status=invalid 时非空，脱敏后文本） */
  errors: string[];
  /** 条目是否可直接进入导入预览（valid 且 sections 非空） */
  canImport: boolean;
  /** 返回列表按钮是否可见 */
  showBack: boolean;
}

/**
 * 聚合详情视图（客户端专属）：徽章（委托共享 computeItemBadge）+ 供应链警示着色行
 * （委托共享 marketItemWarnings）+ 校验错误 + 可否导入。
 */
export function marketDetailView(
  detail: MarketItemDetail,
  url: string,
  showBack: boolean,
  t: UiT = zhUiT,
): MarketDetailView {
  const badge = computeItemBadge(detail, t);
  return {
    badge: {
      statusKind: badge.valid ? 'ok' : 'error',
      statusText: badge.statusText,
      sectionsText: badge.sectionsText,
      valid: badge.valid,
    },
    warnings: marketWarningsLines(detail, url, t),
    errors: detail.errors ?? [],
    canImport: detail.status === 'valid' && detail.sections.length > 0,
    showBack,
  };
}

/* ----------------------------------------------------------------------------
 * 市场通道的导入选择（2026-09 起）
 *
 * 已删除「分区级布尔批准表」（MarketApprovals / defaultApprovals / buildApprovedPlan /
 * approvalRows）与「高风险分区默认不勾」的严格分层信任默认：市场通道现在与导入页**完全同一套**
 * 选择语义（`src/ui/selection-model.ts` 的 Selection：默认全选、「全选」含高风险分区），
 * 由 `MarketImportReview` + 级联树承载，风险改由「就地高风险警示 + 免责声明 + 导入前快照 +
 * 导入后一键回滚」承担。市场特有的展示关切（逐项摘要 / 已勾选高风险分区）在
 * `src/ui/market-import.ts`，选择逻辑本身不在这里再实现一遍。
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------- P1-⑥ 市场条目「装后会动什么」摘要 */

/**
 * 市场条目「装了这个会动你哪些东西」的一行式/徽章式摘要（P1-⑥）。
 * 从 /market/download 的 dry-run plan + analysis 派生（与导入预览统计口径一致）：
 * - willChange：将更新的项数（Create/Update/Install/Conflict 合计）；
 * - unchanged：已一致项（Skip）；
 * - conflicts / secretsNeeded / pathMappingsNeeded（analysis.pathIssues）/ needsRestart 透传。
 * 纯函数、node 可测；组件在详情弹窗顶部展示。
 */
export interface MarketImpactSummary {
  willChange: number;
  unchanged: number;
  conflicts: number;
  secretsNeeded: number;
  pathMappingsNeeded: number;
  needsRestart: boolean;
  /** 分区清单（含条目数），供「包含哪些内容」徽章流 */
  sections: { section: SectionId; count: number }[];
}

export function marketImpactSummary(plan: ImportPlan, analysis?: ImportAnalysis): MarketImpactSummary {
  const items = plan.items;
  const count = (kinds: PlanItemKind[]): number => items.filter((i) => kinds.includes(i.kind)).length;
  const byAdapter = new Map<SectionId, number>();
  for (const item of items) {
    byAdapter.set(item.adapter, (byAdapter.get(item.adapter) ?? 0) + 1);
  }
  return {
    willChange: count(['Create', 'Update', 'Install', 'Conflict']),
    unchanged: count(['Skip']),
    conflicts: count(['Conflict']),
    secretsNeeded: plan.missingSecrets.length,
    pathMappingsNeeded: analysis?.pathIssues?.length ?? 0,
    needsRestart: plan.needsRestart,
    sections: [...byAdapter.entries()].map(([section, c]) => ({ section, count: c })),
  };
}