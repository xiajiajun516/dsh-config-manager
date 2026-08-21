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
import { BUILTIN_MARKET_URL } from '../../market/builtin.ts'
import type { MarketApi } from './market-api.ts'
import type { MyConfigsApi } from './my-configs-api.ts'
import type { SyncApi } from '../sync/sync-api.ts'
import { MyConfigsView } from './MyConfigsView.tsx'
import type { MyItemEntry } from './my-configs-api.ts'
import type {
  MarketBrowseResponse, MarketDownloadResult, MarketListItem, MarketStatusResponse,
} from '../../market/types.ts'
import {
  approvalRows, approvedAdapterSummary, buildApprovedPlan, collectCategories, defaultApprovals,
  filterBySource, filterMarketItems, marketDetailView, marketListSummary, sortMarketItems, sourceBadgeKind,
} from './market-view.ts'
import type { MarketApprovals } from './market-view.ts'
import type { MyInstallSlice, MyWizardSlice } from './my-configs-view.ts'
import { readDisclaimerDismissed, writeDisclaimerDismissed } from './disclaimer.ts'
import type { DisclaimerKey } from './disclaimer.ts'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { redact } from '../../security/redaction.ts'
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
  /** 我的配置：上传/更新向导持久化切片（非敏感；null = 未开始；镜像 runStore，切 tab/刷新不丢） */
  myWizard: MyWizardSlice | null
  /** 我的配置：装回本地（下载+逐分区批准+导入结果）持久化切片（非敏感；null = 未开始/已关闭） */
  myInstall: MyInstallSlice | null
  /** 我的配置：删除确认弹窗目标条目 id（非敏感；镜像 runStore，切 tab/刷新不丢） */
  myConfirmDeleteId: string | null
  loading: boolean
  loadError: string | null
  refreshing: boolean
  browsing: boolean
  items: MarketListItem[]
  search: string
  category: string
  /** 来源筛选（2026-08-21：全部 / 官方 / 个人；镜像 runStore，切 tab/刷新不丢） */
  source: 'all' | 'official' | 'personal'
  /** 排序键（2026-08-21：默认 / 最新更新 / ⭐ 最多 / 名称；镜像 runStore，切 tab/刷新不丢） */
  sortKey: 'default' | 'updatedAt' | 'stars' | 'name'
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
  myWizard: null,
  myInstall: null,
  myConfirmDeleteId: null,
  loading: true,
  loadError: null,
  refreshing: false,
  browsing: false,
  items: [],
  search: '',
  category: '',
  source: 'all',
  sortKey: 'default',
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
    myWizard: s.myWizard,
    myInstall: s.myInstall,
    myConfirmDeleteId: s.myConfirmDeleteId,
    search: s.search,
    category: s.category,
    // 旧持久化数据缺 source/sortKey（undefined）→ 兜底默认值（'all'/'default'），防 undefined 进筛选链
    source: s.source ?? 'all',
    sortKey: s.sortKey ?? 'default',
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

  /* ---------------- 下载弹窗 + 免责前置（2026-08-21） ---------------- */
  /** 下载详情弹窗开关（瞬态 UI，不持久化） */
  const [downloadOpen, setDownloadOpen] = useState(false)
  /** 当前展示的免责弹窗操作（null = 无） */
  const [disclaimerKey, setDisclaimerKey] = useState<DisclaimerKey | null>(null)
  /** 免责弹窗「不再提示」勾选（每次打开重置） */
  const [dontAsk, setDontAsk] = useState(false)
  /** localStorage（浏览器环境；免责「不再提示」跨会话持久化） */
  const storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage

  /** 待下载条目（免责确认后取用；避免免责流程中闭包过期） */
  const pendingDownloadItem = useRef<MarketListItem | null>(null)
  /** 点条目「查看详情」：未勾「不再提示」→ 先弹免责，确认后下载并打开详情弹窗 */
  const openDownload = (item: MarketListItem): void => {
    pendingDownloadItem.current = item
    if (readDisclaimerDismissed('download', storage)) {
      setDownloadOpen(true)
      void runDownload(item)
      return
    }
    setDontAsk(false)
    setDisclaimerKey('download')
  }
  /** 免责弹窗确认：勾选则记录「不再提示」→ 关闭免责 → 打开下载详情弹窗并启动下载 */
  const confirmDownloadDisclaimer = (): void => {
    if (disclaimerKey !== 'download') return
    if (dontAsk) writeDisclaimerDismissed('download', storage)
    setDisclaimerKey(null)
    const item = pendingDownloadItem.current
    setDownloadOpen(true)
    if (item !== null) void runDownload(item)
  }
  /** 关闭下载详情弹窗：清 detail（弹窗即会话，关闭即放弃） */
  const closeDownload = (): void => {
    setDownloadOpen(false)
    patch({ detail: null, importResult: null, error: null, approvals: {} })
  }

  /** 卸载时置挂载守卫 + 最后镜像一次（防止「最后一次改动后立即切 tab」时丢状态）。 */
  useEffect(() => () => {
    mountedRef.current = false
    runStore.patch({ market: toMarketStoreSlice(stateRef.current) })
  }, [])

  /** 内置市场 URL（单一权威；来自 Host 内置常量；用于条目来源判定与详情供应链警示） */
  const marketUrl: string = BUILTIN_MARKET_URL

  /** 挂载时读取内置市场状态；返回响应供「首次打开自动更新」判据（bootAutoRefreshed） */
  const loadStatus = useCallback(async (): Promise<MarketStatusResponse | null> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      patch({ loading: false })
      return info
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
      return null
    }
  }, [api])

  /**
   * 启动后首次打开市场页 → 自动拉取一次最新 index（需求：dsh 启动后第一次打开市场页面自动更新一次市场）。
   * 判据是 Host 侧进程内存标记 bootAutoRefreshed（dsh 重启后归零；refresh 成功后置位），
   * 因此「每次打开都刷新」/「刷新失败后下次打开重试」都自然成立；无需客户端持久化。
   * bootAutoChecked 同步置位防 StrictMode 双执行/竞态重复触发（同一组件实例只自动刷一次）。
   */
  const bootAutoChecked = useRef(false)
  useEffect(() => {
    if (bootAutoChecked.current) return
    bootAutoChecked.current = true
    void (async () => {
      const info = await loadStatus()
      if (info !== null && info.bootAutoRefreshed !== true) {
        await runRefresh()
      }
    })()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时执行一次
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
  // 过滤链：搜索 + 类别 → 来源筛选（官方/个人）→ 排序（默认/最新/⭐/名称）
  const filtered = sortMarketItems(
    filterBySource(filterMarketItems(state.items, state.search, state.category), state.source, marketUrl),
    state.sortKey,
  )
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
          myWizard={state.myWizard}
          onMyWizardChange={(wizard) => { patch({ myWizard: wizard }) }}
          myInstall={state.myInstall}
          onMyInstallChange={(install) => { patch({ myInstall: install }) }}
          myConfirmDeleteId={state.myConfirmDeleteId}
          onMyConfirmDeleteChange={(id) => { patch({ myConfirmDeleteId: id }) }}
        />
      ) : (
        <>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

      {/* 内置市场操作卡：保留面板标题；移除 URL / 官方徽章 / 名称 / 条目数 / 状态行等文字展示 */}
      <Card>
        <span className={css.groupLabel}>{t('config.title')}</span>
        <div className={css.actionRow}>
          <Button variant="primary" disabled={state.refreshing || state.importing} onClick={() => { void runRefresh() }}>
            {state.refreshing ? <Spinner label={t('config.refreshing')} /> : t('config.refresh')}
          </Button>
          <Button disabled={state.browsing} onClick={() => { void runBrowse() }}>
            {state.browsing ? <Spinner label={t('list.loading')} /> : t('list.browse')}
          </Button>
        </div>
      </Card>

      {state.error !== null && <Banner kind="error">{state.error}</Banner>}

      {/* 条目详情弹窗（下载 + 校验 + dry-run 预览；点「查看详情」→ 免责 → 弹窗；
          下载完成前 detail 为 null → 显示 loading） */}
      {downloadOpen && (
        <div
          className={css.dialogMask}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !state.importing) closeDownload() }}
        >
          <div className={`${css.dialogCard} ${css.dialogWide}`} role="dialog" aria-modal="true" aria-label={t('detail.title')}>
            <div className={css.dialogHeaderRow}>
              <span className={css.dialogHeader}>{t('detail.title')}：{state.detail !== null ? state.detail.name : (state.downloadingId ?? '')}</span>
              <button
                type="button"
                className={css.dialogClose}
                aria-label={t('common.close')}
                disabled={state.importing}
                onClick={closeDownload}
              >
                ×
              </button>
            </div>
            <div className={css.dialogBodyScroll}>
          {state.error !== null && <Banner kind="error">{redact(state.error)}</Banner>}
          {state.detail === null && (
            <div className={css.statRow}><Spinner label={t('common.loading')} /></div>
          )}
          {state.detail !== null && detailView !== null && (<>
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
          </>)}
            </div>
          </div>
        </div>
      )}

      {/* 条目列表（浏览） */}
      {!downloadOpen && (
        <Card>
          {state.loadError !== null && <Empty>{t('list.empty')}</Empty>}
          {state.loadError === null && (
            <div className={css.statRow}>
              {/* 搜索 + 类别过滤 + 来源筛选 + 排序（2026-08-21 新增；状态镜像 runStore） */}
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
              <select
                className={css.select}
                value={state.source}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  patch({ source: e.target.value as 'all' | 'official' | 'personal' })
                }}
              >
                <option value="all">{t('list.sourceAll')}</option>
                <option value="official">{t('list.sourceOfficial')}</option>
                <option value="personal">{t('list.sourcePersonal')}</option>
              </select>
              <select
                className={css.select}
                value={state.sortKey}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  patch({ sortKey: e.target.value as 'default' | 'updatedAt' | 'stars' | 'name' })
                }}
              >
                <option value="default">{t('list.sortDefault')}</option>
                <option value="updatedAt">{t('list.sortUpdated')}</option>
                <option value="stars">{t('list.sortStars')}</option>
                <option value="name">{t('list.sortName')}</option>
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
                          {sourceKind === 'ok' ? t('list.sourceOfficial') : t('list.sourcePersonal')}
                        </Badge>
                        {(it.categories ?? []).map((c) => <Badge key={c} kind="info">{c}</Badge>)}
                        <Badge kind={it.cacheState === 'cached' ? 'ok' : it.cacheState === 'fresh' ? 'info' : 'warn'}>
                          {cacheLabel(it.cacheState)}
                        </Badge>
                        {it.stars !== undefined && (
                          <Badge kind="info" title={t('list.starsHint')}>{t('list.stars', { count: String(it.stars) })}</Badge>
                        )}
                      </div>
                    </div>
                    <Button disabled={state.downloadingId === it.id} onClick={() => { openDownload(it) }}>
                      {state.downloadingId === it.id ? <Spinner label={t('common.loading')} /> : t('list.download')}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      )}
      {/* 免责弹窗（复用 ConfirmDialog + 「不再提示」勾选；download 操作） */}
      <ConfirmDialog
        open={disclaimerKey === 'download'}
        title={t('disclaimer.title')}
        message={t('disclaimer.download.text')}
        confirmLabel={t('disclaimer.confirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmDownloadDisclaimer}
        onCancel={() => { setDisclaimerKey(null) }}
      >
        <label className={css.checkboxRow}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setDontAsk(e.target.checked) }}
          />
          <span>{t('disclaimer.dontAsk')}</span>
        </label>
      </ConfirmDialog>
      </>
    )}
    </div>
  )
}
