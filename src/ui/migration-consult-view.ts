/**
 * 迁移前咨询的纯渲染模型（Phase 7，m6-ui）。
 *
 * 把 core 的 ConsultReport 转成 React 可直接绑定的视图数据：
 *  - 健康评分徽章（verdict → Badge kind）
 *  - 维度明细（每维度：label / score / verdict / issues）
 *  - 建议（proceed / review / block + 触发项）
 *  - 将应用摘要（willApply）
 *
 * 安全：所有展示文本渲染前由 UI 层 redact() 兜底；本模型只做结构转换，不引入敏感值。
 * 文案走 UiT（zh 源 / en 镜像，见 src/ui/i18n.ts）。
 */
import type { UiT } from './i18n.ts';
import type {
  ConsultReport, ConsultDimensionId, HealthVerdict, Recommendation,
} from '../core/migration-consult.ts';

/** Badge kind（与 DESIGN.md 四态语义一一对应） */
export type ConsultBadgeKind = 'ok' | 'info' | 'warn' | 'error';

/** 维度视图数据 */
export interface ConsultDimensionView {
  id: ConsultDimensionId;
  label: string;
  score: number;
  verdict: HealthVerdict;
  badgeKind: ConsultBadgeKind;
  issues: { severity: 'info' | 'warning' | 'error'; message: string }[];
}

/** 咨询卡视图数据 */
export interface ConsultView {
  healthScore: number;
  verdict: HealthVerdict;
  verdictBadgeKind: ConsultBadgeKind;
  recommendation: Recommendation;
  recommendationBadgeKind: ConsultBadgeKind;
  recommendationLabel: string;
  /** 硬阻断项数（>0 才可能是 block）+ 需处理项数（warning/error 但非阻断） */
  blockerCount: number;
  attentionCount: number;
  reasons: string[];
  dimensions: ConsultDimensionView[];
  willApply: {
    sections: string[];
    itemCount: number;
    conflicts: number;
    risks: number;
    overwritten: number;
    dryRun: boolean;
  };
}

/* ---------------- 建议依据（reasons）去重与分组 ---------------- */

/** 建议依据分组条目（去重后的 message + 在原始数组中的出现次数） */
export interface ConsultReasonGroup {
  message: string;
  /** 该 message 在原始 reasons 数组中的出现次数（≥1；仅用于 UI 展示「×N」） */
  count: number;
}

/**
 * 「建议依据」去重（纯函数）。
 *
 * 背景：core 的 `recommendationReasons` 是各维度 error/warning issue message 的
 * 直接拼接，同一句话可能被 push 多次（如 migratability 维度按 `m.warnings` 逐条 push
 * 「存在需注意的迁移项」），同一句也可能既出现在维度 issue 又出现在 reasons 中。
 *
 * 去重规则（严格按此实现，勿擅自放宽）：
 *  1. **按原文去重**：只有完全相同的字符串才算重复——不做 trim 后合并、不做大小写
 *     折叠、不做前缀/子串归并。因此 `'A'`、`' A'`、`'A '` 是三个不同条目。
 *  2. **保持首次出现顺序**：稳定去重，输出顺序 = 各条目在输入中首次出现的顺序。
 *  3. **丢弃空串与纯空白字符串**（`trim() === ''`），它们不参与展示。
 *
 * 不修改入参，返回新数组。
 */
export function dedupeConsultReasons(reasons: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reason of reasons) {
    if (reason.trim() === '') continue; // 空串/纯空白：直接丢弃
    if (seen.has(reason)) continue; // 原文去重：仅完全相同才视为重复
    seen.add(reason);
    out.push(reason);
  }
  return out;
}

/**
 * 「建议依据」分组（纯函数）：去重后给出每个条目的重复次数，供 UI 渲染「×N」。
 *
 * 规则：
 *  1. 先经 `dedupeConsultReasons` 去重（原文去重、丢弃空串/纯空白、保持首现顺序）；
 *  2. `count` = 该 message 在**原始数组**（未去重）中的出现次数，按原文精确匹配统计，
 *     因此 count ≥ 1；count 仅用于展示「×N」，不代表任何业务优先级或权重；
 *  3. 输出顺序 = 去重后的顺序（即各条目首次出现的顺序）。
 *
 * 不修改入参，返回新数组。
 */
export function consultReasonGroups(reasons: string[]): ConsultReasonGroup[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return dedupeConsultReasons(reasons).map((message) => ({
    message,
    // 去重结果必来自入参，故此处理论上不会取到兜底值
    count: counts.get(message) ?? 0,
  }));
}

/** verdict → Badge kind（语义映射） */
export function consultVerdictBadgeKind(v: HealthVerdict): ConsultBadgeKind {
  switch (v) {
    case 'healthy': return 'ok';
    case 'needs-attention': return 'warn';
    case 'critical': return 'error';
  }
}

/** recommendation → Badge kind */
export function consultRecommendationBadgeKind(r: Recommendation): ConsultBadgeKind {
  switch (r) {
    case 'proceed': return 'ok';
    case 'review': return 'warn';
    case 'block': return 'error';
  }
}

/** 维度 label（i18n key 后缀） */
export function consultDimensionLabel(id: ConsultDimensionId, t: UiT): string {
  switch (id) {
    case 'compatibility': return t('consult.dim.compatibility');
    case 'integrity': return t('consult.dim.integrity');
    case 'sections': return t('consult.dim.sections');
    case 'consistency': return t('consult.dim.consistency');
    case 'sensitive': return t('consult.dim.sensitive');
    case 'migratability': return t('consult.dim.migratability');
  }
}

/** 把 ConsultReport 转成视图数据（纯函数） */
export function consultView(report: ConsultReport, t: UiT): ConsultView {
  const dimensions: ConsultDimensionView[] = report.dimensions.map((d) => ({
    id: d.id,
    label: consultDimensionLabel(d.id, t),
    score: d.score,
    verdict: d.verdict,
    badgeKind: consultVerdictBadgeKind(d.verdict),
    issues: d.issues.map((i) => ({ severity: i.severity, message: i.message })),
  }));

  return {
    healthScore: report.healthScore,
    verdict: report.verdict,
    verdictBadgeKind: consultVerdictBadgeKind(report.verdict),
    recommendation: report.recommendation,
    recommendationBadgeKind: consultRecommendationBadgeKind(report.recommendation),
    recommendationLabel: consultRecommendationLabel(report.recommendation, t),
    blockerCount: report.blockerCount,
    attentionCount: report.attentionCount,
    reasons: report.recommendationReasons,
    dimensions,
    willApply: {
      sections: report.willApply.sections,
      itemCount: report.willApply.itemCount,
      conflicts: report.willApply.conflicts,
      risks: report.willApply.risks,
      overwritten: report.willApply.overwritten,
      dryRun: report.willApply.dryRun,
    },
  };
}

/** recommendation 的可读标签 */
export function consultRecommendationLabel(r: Recommendation, t: UiT): string {
  switch (r) {
    case 'proceed': return t('consult.recommendation.proceed');
    case 'review': return t('consult.recommendation.review');
    case 'block': return t('consult.recommendation.block');
  }
}
