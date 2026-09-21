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
 *   - **逐项内容选择**（安全不变式 (c) 的 2026-09 改版）：默认全选（含高风险分区），风险改由「就地警示 +
 *     免责确认 + 导入前快照 + 导入后一键回滚」承担（此前的「高风险默认不勾」严格分层信任已移除）；
 *   - 「确认导入」→ 只把已勾选单元组成的子计划交给 executeImportPlan（confirm:true 安全阀 + 回滚）。
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
import type { ImportResult, ItemResolution } from '../../core/types.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { effectiveImportSelection, type Selection } from '../../ui/selection-model.ts'
import type { ImportSelectionState } from '../../ui/selection-model.ts'
import { MarketImportReview } from './MarketImportReview.tsx'
import { toast } from '../common/toast-store.ts'
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
  collectCachedSections, collectCategories,
  filterBySource, filterMarketBySection, filterMarketItems, marketDetailView,
  marketImpactSummary, marketListSummary, sortMarketItems, sourceBadgeKind,
} from './market-view.ts'
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
  /**
   * config-manager 字典（级联树 / 分区显示名 / 冲突决策列表 / 报告行）。
   * 市场面板的 `api.t` 是 UiT（另一套键空间），不能顶替它。
   */
  cmT: TranslateNS<'config-manager'>
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
  /** 分区筛选（P2-⑭：按包含的分区过滤已缓存条目；空 = 不限；镜像 runStore） */
  sectionFilter: string
  /** 来源筛选（2026-08-21：全部 / 官方 / 个人；镜像 runStore，切 tab/刷新不丢） */
  source: 'all' | 'official' | 'personal'
  /** 排序键（2026-08-21：默认 / 最新更新 / ⭐ 最多 / 名称；镜像 runStore，切 tab/刷新不丢） */
  sortKey: 'default' | 'updatedAt' | 'stars' | 'name'
  /** 正在下载/浏览的条目 id（spinner） */
  downloadingId: string | null
  /** 条目详情（下载+校验+dry-run 预览，含 zipPath/plan 供确认导入）；非空时渲染详情视图 */
  detail: MarketDownloadResult | null
  /**
   * 条目级勾选（与导入页同一个 Selection；绑 zipPath 失效 —— 换条目回落默认全选）。
   * 2026-09：原「逐分区批准表」approvals 已删除，市场通道与导入页同一套选择语义。
   */
  selectionState: ImportSelectionState | null
  /** 逐项冲突决策（keepCurrent / useImported；重算计划与刷新后重建决策列表都靠它） */
  conflictResolutions: Record<string, ItemResolution>
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
  sectionFilter: '',
  source: 'all',
  sortKey: 'default',
  downloadingId: null,
  detail: null,
  selectionState: null,
  conflictResolutions: {},
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
    sectionFilter: s.sectionFilter ?? '',
    // 旧持久化数据缺 source/sortKey（undefined）→ 兜底默认值（'all'/'default'），防 undefined 进筛选链
    source: s.source ?? 'all',
    sortKey: s.sortKey ?? 'default',
    items: s.items,
    detail: s.detail,
    // 旧持久化数据缺这两个字段（undefined）→ 兜底（null = 默认全选；{} = 无决策）
    selectionState: s.selectionState ?? null,
    conflictResolutions: s.conflictResolutions ?? {},
    importResult: s.importResult,
    error: s.error,
    loadError: s.loadError,
  }
}

export function MarketPanel({ api, myConfigsApi, importApi, syncApi, t, cmT }: MarketPanelProps) {
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

  /* ---------------- 条目向导页 + 免责前置（2026-08-21 引入，P2 2026-09 改为页面） ---------------- */
  /** 是否在「条目导入向导页」（瞬态 UI，不持久化；P2 起它是**页面**，不再是弹窗） */
  const [downloadOpen, setDownloadOpen] = useState(false)
  /** 当前展示的免责弹窗操作（null = 无） */
  const [disclaimerKey, setDisclaimerKey] = useState<DisclaimerKey | null>(null)
  /** 免责弹窗「不再提示」勾选（每次打开重置） */
  const [dontAsk, setDontAsk] = useState(false)
  /** localStorage（浏览器环境；免责「不再提示」跨会话持久化） */
  const storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage

  /** 待下载条目（免责确认后取用；避免免责流程中闭包过期） */
  const pendingDownloadItem = useRef<MarketListItem | null>(null)
  /** 点条目「查看详情」：未勾「不再提示」→ 先弹免责，确认后进入条目向导页 */
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
  /** 免责弹窗确认：勾选则记录「不再提示」→ 关闭免责 → 进入条目向导页并启动下载 */
  const confirmDownloadDisclaimer = (): void => {
    if (disclaimerKey !== 'download') return
    if (dontAsk) writeDisclaimerDismissed('download', storage)
    setDisclaimerKey(null)
    const item = pendingDownloadItem.current
    setDownloadOpen(true)
    if (item !== null) void runDownload(item)
  }
  /** 返回市场列表：清 detail（向导页即会话，返回即放弃） */
  const closeDownload = (): void => {
    setDownloadOpen(false)
    patch({ detail: null, importResult: null, error: null, selectionState: null, conflictResolutions: {} })
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
        await runRefresh(false)
      }
    })()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 拉取内置市场最新 index.json → 重新浏览（缓存状态由 Host 合并）。
   *  `announce`：仅手动点击才给成功回执 —— 启动时的自动刷新静默，
   *  否则每次打开市场页都会弹一条用户没主动触发的通知。 */
  const runRefresh = async (announce = true): Promise<void> => {
    patch({ refreshing: true, error: null, detail: null })
    try {
      // 先强制 re-pull index（refresh 返回目录条目），再用 browse 取缓存状态合并的展示列表。
      await api.refresh()
      const res: MarketBrowseResponse = await api.browse()
      patch({ refreshing: false, browsing: false, items: res.items, search: '', category: '' })
      // M-25：刷新会清空搜索词与类别筛选，必须告知，否则用户以为列表内容丢了
      if (announce) toast.ok(t('config.refreshed'))
      void loadStatus()
    } catch (err) {
      // R-21：动作失败 → 全局 Toast（原页面 Banner 移除；error 仍落一次作失败标记）
      patch({ refreshing: false, error: err instanceof Error ? err.message : String(err) })
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 浏览（不重新拉取）：POST /market/browse 合并 index + 缓存 */
  const runBrowse = async (announce = true): Promise<void> => {
    patch({ browsing: true, error: null })
    try {
      const res: MarketBrowseResponse = await api.browse()
      patch({ browsing: false, items: res.items, search: '', category: '' })
      if (announce) toast.ok(t('list.browsed'))
    } catch (err) {
      // R-21：动作失败 → 全局 Toast
      patch({ browsing: false, error: err instanceof Error ? err.message : String(err) })
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 下载 + 校验单条目 → dry-run 详情预览（零写入）。自托管条目（带 repo）必须携带来源仓库。
   *  竞态守卫：下载期间用户可发起另一条目下载（downloadingId 已变），晚到响应一律丢弃，
   *  防止「页头标题是 B、详情是 A」的串扰。 */
  const runDownload = async (item: MarketListItem): Promise<void> => {
    patch({ downloadingId: item.id, error: null })
    try {
      const detail = await api.download(item.id, item.repo)
      if (stateRef.current.downloadingId !== item.id) return
      // 选择态归零 = 默认全选（与导入页一致，含高风险分区）；换条目后陈旧选择自动失效
      patch({ downloadingId: null, detail, selectionState: null, conflictResolutions: {} })
    } catch (err) {
      if (stateRef.current.downloadingId !== item.id) return
      // R-21：下载失败 → 全局 Toast。error 仍落一次：向导页以它判断「下载已失败」
      // （detail 恒为 null），否则页内会一直显示加载 Spinner。
      patch({ downloadingId: null, error: err instanceof Error ? err.message : String(err) })
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    }
  }

  /**
   * 编辑中的勾选（绑 zipPath：换条目后旧选择自动失效 → 默认全选）。
   * 与导入向导同一套 effectiveImportSelection，不另写「陈旧选择」判定。
   */
  const pickerSelection: Selection | null = state.detail === null
    ? null
    : effectiveImportSelection(state.detail.plan, state.detail.zipPath, state.selectionState)

  // ---- 渲染模型装配（全部纯函数，node 已测） ----
  // 过滤链：搜索 + 类别 → 分区筛选（已缓存条目）→ 来源筛选（官方/个人）→ 排序
  // sectionFilter 为 ''（不限）或索引条目分区 id（string 形态；断言为 SectionId | '' 交给纯函数）
  const sectionFiltered = filterMarketBySection(
    filterMarketItems(state.items, state.search, state.category),
    state.sectionFilter as SectionId | '',
  )
  const filtered = sortMarketItems(
    filterBySource(sectionFiltered.matched, state.source, marketUrl),
    state.sortKey,
  )
  const sectionFilterUnknown = sectionFiltered.unknown
  const summary = marketListSummary(state.items, uiT)
  const categories = collectCategories(state.items)
  // P2-⑭：分区筛选取值（已缓存条目的分区并集）
  const sectionOptions = collectCachedSections(state.items)
  /** 详情（当前向导页会话的条目；null = 未下载/已返回列表）。局部常量让 JSX 里能安全收窄。 */
  const detail = state.detail
  const detailView = detail !== null
    ? marketDetailView(detail, detail.repo ?? marketUrl, state.items.length > 0 || detail.status !== 'valid', uiT)
    : null
  // P1-⑥：装了这个会动你哪些东西（dry-run plan + analysis 摘要）
  const impact = detail !== null
    ? marketImpactSummary(detail.plan, detail.analysis)
    : null
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
          cmT={cmT}
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
      {/* 列表视图的表头与市场操作卡：进入条目向导页时整块让位（P2 起向导是**页面**，
          不再在列表之上叠弹窗） */}
      {!downloadOpen && (<>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

      {/* 内置市场操作卡：保留面板标题；移除 URL / 官方徽章 / 名称 / 条目数 / 状态行等文字展示 */}
      <Card>
        <span className={css.groupLabel}>{t('config.title')}</span>
        <div className={css.actionRow}>
          <Button variant="primary" disabled={state.refreshing || state.importing || state.browsing} onClick={() => { void runRefresh() }}>
            {state.refreshing ? <Spinner label={t('config.refreshing')} /> : t('config.refresh')}
          </Button>
          <Button disabled={state.browsing || state.refreshing || state.importing} onClick={() => { void runBrowse() }}>
            {state.browsing ? <Spinner label={t('list.loading')} /> : t('list.browse')}
          </Button>
        </div>
      </Card>
      </>)}

      {/* R-21：动作失败（拉取最新 / 浏览 / 下载 / 导入）已全部改由全局 Toast 送达，
          此处的页面级 error Banner 与弹窗内那份是**同一字段的双渲染点**，会与 Toast 重复告知，
          故两处一并移除（state.error 仅保留作失败标记，见 runDownload / runImport）。 */}

      {/* 条目导入向导页（P2 2026-09）：点「查看详情」→ 免责 → **进入本页**（不再是弹窗）。
          与导入页同构：页头（标题 + 返回列表）→ 供应链警示（恒展示，硬约束）→
          校验状态 / 错误 / 影响摘要 → 分步审阅（预览 → 选择 →（冲突）→ 确认 → 结果）。
          下载完成前 detail 为 null → 页内显示 loading。 */}
      {downloadOpen && (
        <>
          <div className={css.headRow}>
            <SectionTitle
              title={t('detail.title')}
              subtitle={state.detail !== null ? state.detail.name : (state.downloadingId ?? '')}
            />
            <span className={css.statusSpacer} />
            <Button disabled={state.importing} onClick={closeDownload}>{t('detail.back')}</Button>
          </div>
          {/* R-21：失败详情走全局 Toast（原弹窗内 error Banner 移除）。
              下方 Spinner 以 state.error 为「失败标记」守卫：下载失败时 detail 恒为 null，
              若不守卫会一直旋转，让用户误以为仍在加载（与 MyConfigsView R-17 同款处理）。 */}
          {state.detail === null && state.error === null && (
            <div className={css.statRow}><Spinner label={t('common.loading')} /></div>
          )}
          {state.detail === null && state.error !== null && (
            <div className={css.statRow}><span className={css.hint}>{t('detail.failed')}</span></div>
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

          {detailView.errors.length > 0 && (<>
            <span className={css.fieldLabel}>{t('detail.errors')}</span>
            <div className={css.reportScroll}>
              <ul className={css.warnList}>
                {detailView.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          </>)}

          <Banner kind="info">{t('detail.previewHint')}</Banner>

          {/* P1-⑥：装了这个会动你哪些东西（基于 dry-run plan 的只读摘要） */}
          {impact !== null && (
            <div className={css.statRow}>
              <Badge kind="info">{t('detail.impact.willChange', { count: String(impact.willChange) })}</Badge>
              {impact.unchanged > 0 && <Badge kind="ok">{t('detail.impact.unchanged', { count: String(impact.unchanged) })}</Badge>}
              {impact.conflicts > 0 && <Badge kind="error">{t('detail.impact.conflicts', { count: String(impact.conflicts) })}</Badge>}
              {impact.secretsNeeded > 0 && <Badge kind="warn">{t('detail.impact.secrets', { count: String(impact.secretsNeeded) })}</Badge>}
              {impact.pathMappingsNeeded > 0 && <Badge kind="warn">{t('detail.impact.paths', { count: String(impact.pathMappingsNeeded) })}</Badge>}
              {impact.needsRestart && <Badge kind="warn">{t('detail.impact.restart')}</Badge>}
            </div>
          )}

          {/* 导入审阅（2026-09）：级联树勾选 + 就地高风险警示 + 逐项摘要 + 冲突决策 + 导入
              + 导入后一键回滚。与「我的配置→装回本地」共用同一个组件（R4d：消灭两套勾选语义）。 */}
          {detailView.canImport && detail !== null && pickerSelection !== null ? (
            <MarketImportReview
              importApi={importApi}
              t={t}
              cmT={cmT}
              zipPath={detail.zipPath}
              plan={detail.plan}
              selection={pickerSelection}
              onSelectionChange={(next) => {
                const zipPath = stateRef.current.detail?.zipPath
                if (zipPath === undefined) return
                patch({ selectionState: { zipPath, selection: next } })
              }}
              resolutions={state.conflictResolutions}
              onResolutionsChange={(next) => { patch({ conflictResolutions: next }) }}
              onPlanChange={(plan) => {
                const detail = stateRef.current.detail
                if (detail === null) return
                patch({ detail: { ...detail, plan } })
              }}
              importing={state.importing}
              onImportingChange={(value) => { patch({ importing: value }) }}
              result={state.importResult}
              onResultChange={(result) => { patch({ importResult: result }) }}
              onErrorChange={(message) => { patch({ error: message }) }}
              itemName={detail.name}
            />
          ) : (
            <Banner kind="error">{t('detail.emptySections')}</Banner>
          )}

          {/* R-06：导入结果已由全局 Toast 送达（原 importResult Banner 移除） */}
          </>)}
        </>
      )}

      {/* 条目列表（浏览） */}
      {!downloadOpen && (
        <Card>
          {state.loadError !== null && <Empty>{t('list.empty')}</Empty>}
          {state.loadError === null && (<>
            {/* 筛选控件 2×2 网格（搜索框跨两列 + 4 个 select 两两一行）：
                上一轮全局 .input/.select 的 width:100% 已移除，靠本网格类承担排布，
                窄画布（宿主设置弹窗 564px）下 2 列优于 4 列。 */}
            <div className={css.marketFilterGrid}>
              {/* 搜索 + 类别过滤 + 来源筛选 + 排序（2026-08-21 新增；状态镜像 runStore） */}
              <input
                type="text"
                className={`${css.input} ${css.marketFilterSearch}`}
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
              {/* P2-⑭：分区筛选（已缓存条目的分区并集；未缓存条目分区未知不参与匹配） */}
              <select
                className={css.select}
                value={state.sectionFilter}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => { patch({ sectionFilter: e.target.value }) }}
              >
                <option value="">{t('list.sectionsAll')}</option>
                {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
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
            </div>
            <div className={css.marketFilterMeta}>
              {/* P2-⑭ 提示行（分区筛选生效且存在分区未知条目）：原夹在下拉之间，随网格重构移到计数行 */}
              {state.sectionFilter !== '' && sectionFilterUnknown > 0 && (
                <span className={css.hint}>{t('list.sectionsUnknown', { count: String(sectionFilterUnknown) })}</span>
              )}
              <Badge kind="info">
                {filtered.length > 0
                  ? (filtered.length < summary.total
                      ? `${t('list.count', { count: String(summary.total) })}${t('list.filtered', { count: String(filtered.length) })}`
                      : t('list.count', { count: String(summary.total) }))
                  : t('list.count', { count: String(summary.total) })}
              </Badge>
            </div>
          </>)}
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
                    {/* 下载按钮：任一下载进行中全部禁用（防止并发下载详情串扰 + 防重复点击） */}
                    <Button disabled={state.downloadingId !== null} onClick={() => { openDownload(it) }}>
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
