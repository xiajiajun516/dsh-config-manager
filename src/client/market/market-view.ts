/**
 * 配置市场区块的客户端渲染装配层（m-market-ui，node 可测）。
 *
 * 设计纪律（docs/design/marketplace.md §7.2 / §9 contract 表）：
 *  - **共享渲染模型唯一权威 = Host 侧 `src/market/view.ts`**（marketStatusText /
 *    marketListSummary / computeItemBadge / marketItemWarnings / needsReview / toMarketListItem）。
 *    本文件原样 **re-export** 这些函数（单一来源，消重，避免与后端漂移）；
 *  - 本文件只保留**客户端专属**的 UI 装配函数（搜索/类别过滤、详情聚合、时间格式化、
 *    供应链警示的 warn/info 着色行）——这些不属共享模型，属前端薄层。
 *
 * 安全硬约束（§1 / §7.2）：供应链警示恒生成、needsReview 恒 true（re-export 自后端权威）。
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
import type { ImportPlan, PlanItem, PlanItemKind } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/** 类别过滤：从条目收集全部出现过的类别（用于「全部类别」下拉）。 */
export function collectCategories(items: readonly MarketListItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    for (const c of it.categories ?? []) set.add(c);
  }
  return [...set];
}

/**
 * 搜索 + 类别过滤（纯函数，客户端专属）。
 * - query：对 name / author / description 做大小写不敏感子串匹配（空白 query 不过滤）；
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
    return false;
  });
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
 * 逐分区批准（安全不变式 (c)：插件/AGENTS.md 等高风险分区默认不导入，须逐项显式批准）。
 *
 * 严格分层信任：来自市场的条目任何分区都不自动默认全信任。**安全（低风险，默认勾选）**
 * 分区可随「确认导入」一起走；**高风险**分区（写文件 / 注入全局指令 / 安装插件 / 起 MCP /
 * 恢复会话等）默认不勾选，用户须在详情里逐项显式批准后才进入导入计划。
 * 所有函数无副作用、node 可测。
 * ------------------------------------------------------------------------- */

/**
 * 高风险分区（默认不导入，须逐项显式批准）：
 *  - pluginFiles        ：把远端文件写进 $DSH_HOME（可覆盖本机插件配置文件）
 *  - agentInstructions  ：AGENTS.md 注入每个会话的全局指令（LLM 言行边界）
 *  - agentPresets       ：agent 预设（会话 persona / 行为模板）
 *  - sessions           ：session 文件（可带历史/敏感上下文）
 *  - mcp                ：注册 MCP 服务器（可接入外部工具/执行能力）
 *  - plugins            ：安装/更新插件（ExecutePlugin / Install 项，供应链最高风险）
 * 其余（settings/ui/providers/prompts/skills/workspaces/credentialsStatus…）默认勾选。
 */
export const HIGH_RISK_ADAPTERS: ReadonlySet<SectionId> = new Set<SectionId>([
  'pluginFiles', 'agentInstructions', 'agentPresets', 'sessions', 'mcp', 'plugins',
]);

/** 是否为高风险分区（需逐项显式批准，默认不导入）。 */
export function isHighRiskAdapter(adapter: SectionId): boolean {
  return HIGH_RISK_ADAPTERS.has(adapter);
}

/** PlanItemKind 是否需要重启 DSH 生效（Install 及插件级变更）。 */
export function itemNeedsRestart(adapter: SectionId, kind: PlanItemKind): boolean {
  if (kind === 'Install') return true;
  if (adapter === 'plugins' || adapter === 'mcp' || adapter === 'agentPresets' || adapter === 'agentInstructions') return true;
  return false;
}

/** 审批表：adapter → 是否勾选导入。 */
export type MarketApprovals = Record<string, boolean>;

/** 收集计划中出现过的分区（按 APPLY_ORDER 语义排序不重要，去重即可）。 */
export function planAdapters(plan: ImportPlan): SectionId[] {
  const set = new Set<SectionId>();
  for (const item of plan.items) set.add(item.adapter);
  return [...set];
}

/**
 * 默认批准表：低风险分区默认勾选（true）；高风险分区默认不勾选（false，须逐项显式批准）。
 * 这是严格分层信任的默认 —— 不提供「自动信任高风险来源」的默认。
 */
export function defaultApprovals(plan: ImportPlan): MarketApprovals {
  const out: MarketApprovals = {};
  for (const adapter of planAdapters(plan)) {
    out[adapter] = !isHighRiskAdapter(adapter);
  }
  return out;
}

/**
 * 按批准表过滤计划 → 仅保留已批准分区的项（供 executeImportPlan 执行的子计划，subPlan）。
 * - items：仅保留 approved[adapter]===true 的项；
 * - needsRestart：按已批准项里是否有需重启者重算（不再沿用整份计划的 needsRestart）；
 * - estimatedActions：仅保留已批准分区的计数；
 * - globalStrategy / missingSecrets / pathMappings：透传（导入的可选分区子集不改变这些）。
 * 返回与入参同形状的 ImportPlan，可直接交 executeImportPlan（analytic 只执行 plan.items）。
 */
export function buildApprovedPlan(plan: ImportPlan, approvals: MarketApprovals): ImportPlan {
  const items = plan.items.filter((it) => approvals[it.adapter] === true);
  let needsRestart = false;
  const estimatedActions: Record<string, number> = {};
  for (const it of items) {
    if (itemNeedsRestart(it.adapter, it.kind)) needsRestart = true;
    estimatedActions[it.adapter] = (estimatedActions[it.adapter] ?? 0) + 1;
  }
  return {
    items,
    globalStrategy: plan.globalStrategy,
    pathMappings: plan.pathMappings,
    missingSecrets: plan.missingSecrets,
    needsRestart,
    // estimatedActions 仅用于进度/预估（不入执行依据==plan.items），部分键即可
    estimatedActions: estimatedActions as ImportPlan['estimatedActions'],
  };
}

export interface ApprovalSummary {
  /** 计划中的分区总数 */
  total: number;
  /** 已批准分区数 */
  selected: number;
  /** 是否有至少一个批准的项（可导入） */
  canImport: boolean;
  /** 高风险分区里已批准的（提示需逐项批准已确认） */
  highRiskSelected: number;
  /** 高风险分区总数 */
  highRiskTotal: number;
}

/** 批准表摘要（确认按钮可用性 + 提示徽章数据源，纯函数）。 */
export function approvedAdapterSummary(plan: ImportPlan, approvals: MarketApprovals): ApprovalSummary {
  const adapters = planAdapters(plan);
  let selected = 0;
  let highRiskSelected = 0;
  let highRiskTotal = 0;
  for (const a of adapters) {
    if (approvals[a] === true) selected += 1;
    if (isHighRiskAdapter(a)) {
      highRiskTotal += 1;
      if (approvals[a] === true) highRiskSelected += 1;
    }
  }
  const hasItems = plan.items.some((it) => approvals[it.adapter] === true);
  return { total: adapters.length, selected, canImport: hasItems, highRiskSelected, highRiskTotal };
}

/** 分区批准列表的渲染行（薄装配：adapter + 是否高风险 + 是否勾选 + 项数描述）。 */
export interface ApprovalRow {
  adapter: SectionId;
  itemCount: number;
  highRisk: boolean;
  approved: boolean;
  /** 该分区第一条项的 description（作分区标签，如「安装插件 ×3」） */
  label: string;
}

/** 计划 → 分区批准列表（供详情视图逐项勾选渲染；纯函数）。 */
export function approvalRows(plan: ImportPlan, approvals: MarketApprovals): ApprovalRow[] {
  const byAdapter = new Map<SectionId, PlanItem[]>();
  for (const item of plan.items) {
    const list = byAdapter.get(item.adapter) ?? [];
    list.push(item);
    byAdapter.set(item.adapter, list);
  }
  const rows: ApprovalRow[] = [];
  for (const adapter of planAdapters(plan)) {
    const items = byAdapter.get(adapter) ?? [];
    const label = items[0]?.description ?? adapter;
    rows.push({
      adapter,
      itemCount: items.length,
      highRisk: isHighRiskAdapter(adapter),
      approved: approvals[adapter] === true,
      label,
    });
  }
  return rows;
}
