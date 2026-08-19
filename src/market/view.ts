/**
 * m-market：纯渲染模型（docs/design/marketplace.md §7.2）。
 * 仿 src/ui/progress.ts / sync-view.ts 模式：全部无副作用纯函数、node 可测，
 * 供 frontend 的 MarketPanel 直接复用。
 *
 * 硬不变式：供应链警示恒生成（marketItemWarnings 不论 status 都返回警示行，
 * 因为任何市场下载内容都视为不可信）；needsReview 恒 true（不提供「自动信任该来源」的默认）。
 */
import type { UiT } from '../ui/i18n.ts';
import type {
  MarketIndexItem, MarketItemDetail, MarketItemManifest, MarketListItem, MarketSummary,
} from './types.ts';

/** 市场状态行文案（status 区块顶部一行）。count<=0 → 未添加提示 */
export function marketStatusText(config: { count: number } | MarketSummary[], t: UiT): string {
  const count = Array.isArray(config) ? config.length : config.count;
  if (count <= 0) return t('market.statusUnconfigured');
  return t('market.statusConfigured', { count });
}

/** 列表摘要：总条目数 + 缓存徽章计数（供 UI 顶部小结）。无副作用。 */
export function marketListSummary(
  items: MarketListItem[],
  _t: UiT,
): { total: number; fresh: number; cached: number; none: number } {
  const fresh = items.filter((i) => i.cacheState === 'fresh').length;
  const cached = items.filter((i) => i.cacheState === 'cached').length;
  const none = items.filter((i) => i.cacheState === 'none').length;
  return { total: items.length, fresh, cached, none };
}

/** 条目校验徽章：status 文案 + sections 清单文案。返回 { statusText, sectionsText, valid } */
export function computeItemBadge(detail: MarketItemDetail, t: UiT): {
  statusText: string;
  sectionsText: string;
  valid: boolean;
} {
  const statusText = detail.status === 'valid' ? t('market.detail.statusValid') : t('market.detail.statusInvalid');
  const sectionsText = detail.sections.length > 0
    ? t('market.detail.sections', { sections: detail.sections.join(', ') })
    : t('market.detail.sectionsEmpty');
  return { statusText, sectionsText, valid: detail.status === 'valid' };
}

/**
 * 恒生成供应链警示行（硬不变式：任何市场下载条目确认导入前都可见）。
 * 传入 L2 manifest + 市场 URL + 下载时间；不依赖任何“来源可信”判定。
 */
export function marketItemWarnings(
  manifest: Pick<MarketItemManifest, 'name' | 'author' | 'provenance'> | undefined,
  url: string,
  downloadedAt: string,
  t: UiT,
): string[] {
  const warnings: string[] = [];
  warnings.push(t('market.supplyUnofficial'));
  if (url !== '') warnings.push(t('market.supplySource', { url }));
  if (downloadedAt !== '') warnings.push(t('market.supplyDownloadedAt', { time: downloadedAt }));
  if (manifest?.author) warnings.push(t('market.supplyAuthor', { author: manifest.author }));
  if (manifest?.provenance?.source) warnings.push(t('market.supplyProvenanceSource', { source: manifest.provenance.source }));
  if (manifest?.provenance?.note) warnings.push(t('market.supplyProvenanceNote', { note: manifest.provenance.note }));
  return warnings;
}

/**
 * 是否需要人工决策（供应链警示模型层恒 true —— 不让默认信任来源，须逐项确认）。
 */
export function needsReview(_detail: MarketItemDetail): boolean {
  return true;
}

/** 从 MarketIndexItem 投影浏览列表项（cacheState 由调用方按缓存状态计算；repo 透出供来源徽章） */
export function toMarketListItem(item: MarketIndexItem, cacheState: MarketListItem['cacheState']): MarketListItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    author: item.author,
    version: item.version,
    updatedAt: item.updatedAt,
    categories: item.categories,
    ...(item.repo !== undefined ? { repo: item.repo } : {}),
    cacheState,
  };
}
