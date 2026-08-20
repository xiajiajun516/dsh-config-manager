/**
 * 配置市场面板（备份与迁移页的第 5 个 tab 内容）。
 *
 * 产品决策：**内置单市场、只读、不可编辑** —— 市场绑定内置公开仓库
 * `src/market/builtin.ts` 的 BUILTIN_MARKET_URL（创建者维护），无添加/移除/多市场 UI。
 * 独立设置页壳已移除 —— tab 容器由 ConfigManagerSection 统一渲染，本组件只输出内容体：
 * - 市场头部卡片：内置市场 URL + 官方徽章（不可编辑）+「拉取最新」；
 * - 条目列表：搜索框 + 类别过滤 + 缓存状态徽章；
 * - 条目详情：点「查看详情」→ POST /market/download（拉取 + §6 校验 + dry-run 预览）；
 *   - **供应链警示恒展示**（来源 URL + 非官方审核 + 下载时间；确认导入前必经）；
 *   - **逐分区批准**（安全不变式 (c)）：高风险分区默认不勾选、须逐项显式批准；
 *   - 「确认导入」→ 只把已批准分区子计划交给 executeImportPlan（confirm:true 安全阀 + 回滚）。
 *
 * 全部渲染模型来自 ./market-view.ts 纯函数（node 单测覆盖），本组件只做装配；
 * 状态组件内自持（useState），同时经 toMarketStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」
 * （搜索词/类别筛选/条目列表/详情与逐分区批准/导入结果）。
 * 安全：市场端点无任何 secret 输入（内置 URL 已由 validateRepoUrl 拒绝 userinfo）；downloaded
 * 内容一律视为不可信，确认导入前 supply-chain 警示可见 & needsReview 恒 true（不允许默认信任）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { ImportResult, ImportPlan } from '../../core/types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { BUILTIN_MARKET_URL, isOfficialMarket } from '../../market/builtin.ts'
import type { MarketApi } from './market-api.ts'
import type { MyConfigsApi } from './my-configs-api.ts'
import type { SyncApi } from '../sync/sync-api.ts'
import { MyConfigsView } from './MyConfigsView.tsx'
import type { MyItemEntry } from './my-configs-api.ts'
import type {
  MarketBrowseResponse, MarketDownloadResult, MarketListItem, MarketSummary,
} from '../../market/types.ts'
import {
  approvalRows, approvedAdapterSummary, buildApprovedPlan, collectCategories, defaultApprovals,
  filterMarketItems, marketDetailView, marketListSummary, marketStatusText, sourceBadgeKind,
} from './market-view.ts'
import type { MarketApprovals } from './market-view.ts'
import { runStore, toMarketStoreSlice, type MarketStoreSlice } from '../run-store.ts'
import css from '../config-manager.module.css'

export interface MarketPanelProps {
  api: MarketApi
  /** 「我的配置」API（/me/* 端点：登录态/一键上传/查看已上传/一键更新；登录复用 SyncApi.github*） */
  myConfigsApi: MyConfigsApi
  /** 确认导入复用的主 ConfigManagerApi（executeImportPlan：安全阀 + 回滚） */
  importApi: ConfigManagerApi
  /** GitHub 登录 API（「我的配置」登录卡复用 sync github device flow，同 token 槽） */
  syncApi: SyncApi
  t: TranslateNS<'config-manager-market'>
}

interface MarketUiState {
  /** 市场面板子视图（§4.6：「浏览市场 / 我的配置」；切 tab/刷新不丢） */
  subView: 'browse' | 'myconfigs'
  /** 我的配置：已上传条目（null = 尚未加载；「我的配置」子视图镜像，切 tab 不丢） */
  myItems: MyItemEntry[] | null
  /** 我的配置：列表加载错误（已 redact；null = 无） */
  myItemsError: string | null
  loading: boolean
  loadError: string | null
  /** 内置市场摘要（status 返回；条目数 / 名称 / 最近拉取） */
  market: MarketSummary | null
  refreshing: boolean
  browsing: boolean
  items: MarketListItem[]
  search: string
  category: string
  /** 正在下载/浏览的条目 id（spinner） */
  downloadingId: string | null
  /** 条目详情（下载+校验+dry-run 预览，含 zipPath/plan 供确认导入）；非空时渲染详情视图 */
  detail: MarketDownloadResult | null
  /** 逐分区批准表（安全不变式 (c)：高风险分区默认不勾选，须逐项显式批准） */
  approvals: MarketApprovals
  /** 确认导入执行中 */
  importing: boolean
  /** 导入结果（executeImportPlan 返回） */
  importResult: ImportResult | null
  /** 已 redact 的错误文本 */
  error: string | null
}

const initial: MarketUiState = {
  subView: 'browse',
  myItems: null,
  myItemsError: null,
  loading: true,
  loadError: null,
  market: null,
  refreshing: false,
  browsing: false,
  items: [],
  search: '',
  category: '',
  downloadingId: null,
  detail: null,
  approvals: {},
  importing: false,
  importResult: null,
  error: null,
}

/**
 * 从 runStore 恢复上次的市场 UI 状态（切 tab 回 / 刷新后挂载）。
 * 无敏感字段；detail.zipPath 为宿主受控临时文件（懒 GC 10 分钟），
 * 若已过期，确认导入会得到明确错误 → 重新下载即可。
 */
function initFromStore(): MarketUiState {
  const s: MarketStoreSlice = runStore.getSnapshot().market
  return {
    ...initial,
    subView: s.subView,
    myItems: s.myItems,
    myItemsError: s.myItemsError,
    search: s.search,
    category: s.category,
    items: s.items,
    detail: s.detail,
    approvals: s.approvals,
    importResult: s.importResult,
    error: s.error,
    loadError: s.loadError,
  }
}

export function MarketPanel({ api, myConfigsApi, importApi, syncApi, t }: MarketPanelProps) {
  const uiT = api.t // 展示层翻译器（zh/en）：供应链警示 / 状态行 / 徽章文本走 UiT（market.* 键）
  const [state, setState] = useState<MarketUiState>(initFromStore)
  /** 最新 state 镜像（commit/卸载 flush 读取，避免闭包过期值） */
  const stateRef = useRef<MarketUiState>(state)
  /** 挂载守卫：卸载后不再 setState（store 镜像仍执行，异步结果照常落库） */
  const mountedRef = useRef(true)

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（下载/确认导入）完成回调在组件
   * 已卸载（切走 tab）时也能把结果（detail/importResult）写进 store，切回恢复。
   */
  const commit = (next: MarketUiState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({ market: toMarketStoreSlice(next) })
  }
  const patch = (p: Partial<MarketUiState>): void => commit({ ...stateRef.current, ...p })

  /** 卸载时置挂载守卫 + 最后镜像一次（防止「最后一次改动后立即切 tab」时丢状态）。 */
  useEffect(() => () => {
    mountedRef.current = false
    runStore.patch({ market: toMarketStoreSlice(stateRef.current) })
  }, [])

  /** 内置市场 URL（单一权威；来自 Host 内置常量） */
  const marketUrl: string = BUILTIN_MARKET_URL
  const official: boolean = isOfficialMarket(marketUrl)

  /** 挂载时读取内置市场状态 */
  const loadStatus = useCallback(async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      patch({ loading: false, market: info.markets[0] ?? null })
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  }, [api])

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 拉取内置市场最新 index.json → 重新浏览（缓存状态由 Host 合并） */
  const runRefresh = async (): Promise<void> => {
    patch({ refreshing: true, error: null, detail: null })
    try {
      // 先强制 re-pull index（refresh 返回目录条目），再用 browse 取缓存状态合并的展示列表。
      await api.refresh()
      const res: MarketBrowseResponse = await api.browse()
      patch({ refreshing: false, browsing: false, items: res.items, search: '', category: '' })
      void loadStatus()
    } catch (err) {
      patch({ refreshing: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 浏览（不重新拉取）：POST /market/browse 合并 index + 缓存 */
  const runBrowse = async (): Promise<void> => {
    patch({ browsing: true, error: null })
    try {
      const res: MarketBrowseResponse = await api.browse()
      patch({ browsing: false, items: res.items, search: '', category: '' })
    } catch (err) {
      patch({ browsing: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 下载 + 校验单条目 → dry-run 详情预览（零写入）。自托管条目（带 repo）必须携带来源仓库。 */
  const runDownload = async (item: MarketListItem): Promise<void> => {
    patch({ downloadingId: item.id, error: null })
    try {
      const detail = await api.download(item.id, item.repo)
      // 初始化逐分区批准表：低风险默认勾选，高风险默认不勾选（须逐项显式批准）
      patch({ downloadingId: null, detail, approvals: defaultApprovals(detail.plan) })
    } catch (err) {
      patch({ downloadingId: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 确认导入：只导入用户显式批准的逐分区子集（subPlan 模式，与 sync-engine 同款） */
  const runImport = async (): Promise<void> => {
    const detail = state.detail
    if (detail === null) return
    const approvedPlan: ImportPlan = buildApprovedPlan(detail.plan, state.approvals)
    if (approvedPlan.items.length === 0) {
      patch({ error: t('detail.noApproval') })
      return
    }
    // plan 由 Host /market/download 的 dry-run 生成，确认时按已批准子集带回（安全不变式 (c)）
    patch({ importing: true, error: null })
    try {
      const executed = await importApi.executeImportPlan(
        detail.zipPath,
        approvedPlan,
        { confirm: true, rollbackOnError: true },
      )
      patch({ importing: false, importResult: executed })
    } catch (err) {
      patch({ importing: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---- 渲染模型装配（全部纯函数，node 已测） ----
  // 状态行（共享 marketStatusText：恒 configured 单市场）；loading/error 由 spinner/banner 单独呈现
  const statusText = marketStatusText({ count: 1 }, uiT)
  const filtered = filterMarketItems(state.items, state.search, state.category)
  const summary = marketListSummary(state.items, uiT)
  const categories = collectCategories(state.items)
  const detailView = state.detail !== null
    ? marketDetailView(state.detail, state.detail.repo ?? marketUrl, state.items.length > 0 || state.detail.status !== 'valid', uiT)
    : null
  // 逐分区批准（安全不变式 (c)）：详情里列出 plan 分区，高风险默认不勾选、须逐项批准
  const approvalList = state.detail !== null ? approvalRows(state.detail.plan, state.approvals) : []
  const approvalSummary = state.detail !== null ? approvedAdapterSummary(state.detail.plan, state.approvals) : null
  const cacheLabel = (cacheState: MarketListItem['cacheState']): string => {
    if (cacheState === 'cached') return t('list.cacheCached')
    if (cacheState === 'fresh') return t('list.cacheFresh')
    return t('list.cacheNone')
  }

  return (
    <div className={css.viewBody}>
      {/* 子视图切换（§4.6）：浏览市场 / 我的配置（低频面板状态镜像 runStore，切 tab/刷新不丢） */}
      <div className={css.modeTabs} role="tablist">
        <button
          type="button" role="tab"
          aria-selected={state.subView === 'browse'}
          data-active={state.subView === 'browse' ? '' : undefined}
          className={css.modeTab}
          onClick={() => { patch({ subView: 'browse' }) }}
        >
          {t('myconfigs.tab.browse')}
        </button>
        <button
          type="button" role="tab"
          aria-selected={state.subView === 'myconfigs'}
          data-active={state.subView === 'myconfigs' ? '' : undefined}
          className={css.modeTab}
          onClick={() => { patch({ subView: 'myconfigs' }) }}
        >
          {t('myconfigs.tab.myconfigs')}
        </button>
      </div>

      {/* 「我的配置」子视图（登录卡 / 上传向导 / 已上传列表 / 装回本地） */}
      {state.subView === 'myconfigs' ? (
        <MyConfigsView
          meApi={myConfigsApi}
          api={api}
          importApi={importApi}
          syncApi={syncApi}
          t={t}
          myItems={state.myItems}
          myItemsError={state.myItemsError}
          onMyItemsChange={(items, error) => { patch({ myItems: items, myItemsError: error }) }}
          onBack={() => { patch({ subView: 'browse' }) }}
        />
      ) : (
        <>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

      {/* 内置市场头部：固定 URL + 官方徽章 + 拉取最新（不可编辑） */}
      <Card>
        <span className={css.groupLabel}>{t('config.title')}</span>
        <span className={css.hint}>{t('config.builtinHint')}</span>
        <div className={css.statRow} style={{ paddingTop: 4 }}>
          <Badge kind="info">{marketUrl}</Badge>
          {official && <Badge kind="ok">{t('config.official')}</Badge>}
          {!official && <Badge kind="warn">{t('config.custom')}</Badge>}
        </div>
        {state.market !== null && (state.market.name || state.market.itemCount !== undefined) && (
          <div className={css.statRow}>
            {state.market.name !== undefined && <Badge kind="info">{state.market.name}</Badge>}
            {state.market.itemCount !== undefined && (
              <Badge kind="info">{t('list.count', { count: String(state.market.itemCount) })}</Badge>
            )}
          </div>
        )}
        <div className={css.actionRow}>
          <Button variant="primary" disabled={state.refreshing || state.importing} onClick={() => { void runRefresh() }}>
            {state.refreshing ? <Spinner label={t('config.refreshing')} /> : t('config.refresh')}
          </Button>
          <Button disabled={state.browsing} onClick={() => { void runBrowse() }}>
            {state.browsing ? <Spinner label={t('list.loading')} /> : t('list.browse')}
          </Button>
        </div>
        <div className={css.statRow}>
          <Badge kind={state.loadError !== null ? 'error' : 'ok'}>{statusText}</Badge>
        </div>
      </Card>

      {state.error !== null && <Banner kind="error">{state.error}</Banner>}

      {/* 条目详情（下载 + 校验 + dry-run 预览） */}
      {state.detail !== null && detailView !== null && (
        <Card>
          <div className={css.actionRow}>
            <span className={css.groupLabel}>{t('detail.title')}：{state.detail.name}</span>
            <Button onClick={() => { patch({ detail: null }) }}>{t('detail.back')}</Button>
          </div>

          {/* 供应链警示：恒展示（硬约束），确认导入前必经 */}
          <Banner kind="warn">
            <strong>{t('detail.needReview')}</strong>
          </Banner>
          <div className={css.warnList}>
            {detailView.warnings.map((w, i) => (
              <li key={i} style={{ color: w.kind === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : undefined }}>
                {w.text}
              </li>
            ))}
          </div>

          <div className={css.statRow}>
            <Badge kind={detailView.badge.statusKind === 'ok' ? 'ok' : 'error'}>{detailView.badge.statusText}</Badge>
            <Badge kind="info">{detailView.badge.sectionsText}</Badge>
            {state.detail.version !== undefined && <Badge kind="info">{t('detail.version', { version: state.detail.version })}</Badge>}
          </div>

          {detailView.errors.length > 0 && (
            <div>
              <span className={css.fieldLabel}>{t('detail.errors')}</span>
              <div className={css.reportScroll}>
                <ul className={css.warnList}>
                  {detailView.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            </div>
          )}

          <Banner kind="info">{t('detail.previewHint')}</Banner>

          {/* 逐分区批准（安全不变式 (c)：高风险分区默认不导入、须逐项显式批准） */}
          {detailView.canImport && approvalList.length > 0 && (
            <div>
              <span className={css.groupLabel}>{t('detail.approval.title')}</span>
              {approvalSummary !== null && approvalSummary.highRiskTotal > 0 && (
                <Banner kind="warn">{t('detail.approval.highRiskHint')}</Banner>
              )}
              <div className={css.conflictList}>
                {approvalList.map((row) => (
                  <label key={row.adapter} className={css.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={row.approved}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        patch({ approvals: { ...state.approvals, [row.adapter]: e.target.checked } })
                      }}
                    />
                    <span>
                      <span className={css.conflictId}>{row.adapter}</span>
                      {' '}
                      <Badge kind={row.highRisk ? 'warn' : 'info'}>
                        {row.highRisk ? t('detail.approval.requiresApproval') : t('detail.approval.safe')}
                      </Badge>
                      {' '}
                      <Badge kind="info">{row.label}</Badge>
                    </span>
                  </label>
                ))}
              </div>
              <div className={css.statRow}>
                <Badge kind={approvalSummary !== null && approvalSummary.canImport ? 'ok' : 'warn'}>
                  {approvalSummary !== null
                    ? t('detail.approval.count', { selected: String(approvalSummary.selected), total: String(approvalSummary.total) })
                    : ''}
                </Badge>
              </div>
            </div>
          )}

          {detailView.canImport ? (
            <div className={css.actionRow}>
              <Button
                variant="primary"
                disabled={state.importing || (approvalSummary !== null && !approvalSummary.canImport)}
                onClick={() => { void runImport() }}
              >
                {state.importing ? <Spinner label={t('common.loading')} /> : t('detail.import')}
              </Button>
            </div>
          ) : (
            <Banner kind="error">{t('detail.emptySections')}</Banner>
          )}

          {state.importResult !== null && (
            <Banner kind={state.importResult.ok ? 'ok' : 'error'}>
              {state.importResult.ok
                ? `导入完成：${state.importResult.executed.filter((e) => e.status === 'ok').length} 项写入`
                : `导入失败（${state.importResult.executed.filter((e) => e.status === 'failed').length} 项失败）`}
              {state.importResult.needsRestart && ' · 部分改动需重启 DSH 后生效'}
            </Banner>
          )}
        </Card>
      )}

      {/* 条目列表（浏览） */}
      {state.detail === null && (
        <Card>
          {state.loadError !== null && <Empty>{t('list.empty')}</Empty>}
          {state.loadError === null && (
            <div className={css.statRow}>
              {/* 搜索 + 类别过滤 */}
              <input
                type="text"
                className={css.input}
                value={state.search}
                placeholder={t('list.searchPlaceholder')}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ search: e.target.value }) }}
              />
              <select
                className={css.select}
                value={state.category}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => { patch({ category: e.target.value }) }}
              >
                <option value="">{t('list.categoriesAll')}</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <Badge kind="info">
                {filtered.length > 0
                  ? (filtered.length < summary.total
                      ? `${t('list.count', { count: String(summary.total) })}${t('list.filtered', { count: String(filtered.length) })}`
                      : t('list.count', { count: String(summary.total) }))
                  : t('list.count', { count: String(summary.total) })}
              </Badge>
            </div>
          )}
          {state.browsing && <div className={css.statRow}>{<Spinner label={t('list.loading')} />}</div>}
          {!state.browsing && state.loadError === null && state.items.length === 0 && <Empty>{t('list.noItems')}</Empty>}
          {/* 条目卡片列表 */}
          {!state.browsing && state.loadError === null && filtered.length > 0 && (
            <div className={css.snapshotList}>
              {filtered.map((it) => {
                // 来源徽章（阶段 1：条目级来源仓库）：官方 ok / 第三方 warn，文案走字典
                const sourceKind = sourceBadgeKind(it, marketUrl)
                return (
                  <div key={it.id} className={css.statRow} style={{ paddingTop: 4 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={css.conflictHead}>
                        <span className={css.conflictId}>{it.name}</span>
                        {it.version !== undefined && <Badge kind="info">{it.version}</Badge>}
                      </div>
                      {(it.author !== undefined || it.description !== undefined) && (
                        <span className={css.hint}>
                          {it.author !== undefined ? `${it.author}` : ''}
                          {it.author !== undefined && it.description !== undefined ? ' · ' : ''}
                          {it.description ?? ''}
                        </span>
                      )}
                      <div className={css.statRow}>
                        <Badge kind={sourceKind}>
                          {sourceKind === 'ok' ? t('list.sourceOfficial') : t('list.sourceThirdParty')}
                        </Badge>
                        {(it.categories ?? []).map((c) => <Badge key={c} kind="info">{c}</Badge>)}
                        <Badge kind={it.cacheState === 'cached' ? 'ok' : it.cacheState === 'fresh' ? 'info' : 'warn'}>
                          {cacheLabel(it.cacheState)}
                        </Badge>
                      </div>
                    </div>
                    <Button disabled={state.downloadingId === it.id} onClick={() => { void runDownload(it) }}>
                      {state.downloadingId === it.id ? <Spinner label={t('common.loading')} /> : t('list.download')}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      )}
      </>
    )}
    </div>
  )
}
