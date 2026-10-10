/**
 * Config Manager 设置页（settings.section 入口）—— Workbench Shell（2026-09 Full UI Rebuild）。
 *
 * 结构（画布 ≈ 564 × 720，800px 设置弹窗内）：
 *   ├ shellNav：图标 + 短标签页签（放不下的自动进「更多 ▾」，判定见 ui/nav-model.ts）
 *   │          + 右侧三个图标动作（⌘K / 活动 / 关于）
 *   ├ (SAFE MODE 横幅：仅恢复待处理时出现)
 *   ├ shellContent：页面（shellMain）与流程面板（taskPanel）共用这一块
 *   └ statusBar：运行状态点 + 进行中任务数 + 版本信息
 *
 * 流程任务层（UI v2 §5.8 / §5.9）：导出/导入/逛市场/发布市场是**多阶段流程**，
 * 活动/历史/关于是**只读视图**，它们统一由内容区上的全宽侧滑面板承载（runStore.task，不持久化）。
 * 面板只在 `panel === task.origin` 时渲染 —— 切走收起、切回续做。
 * **右侧抽屉已整体删除**（它带遮罩却只占画布 71%，三个表格都拿不到全宽）。
 *
 * 业务面（api/syncApi/marketApi）由注册时的 inject face 注入；t 由 locale seat 注入。
 * 关闭按钮由 settings shell 自带，本页不再渲染。
 *
 * m2：主视图（panel/view）与全部子视图状态统一由模块级 runStore 持有
 * （sessionStorage 持久化 + 切页/关面板不重建控制器实例）；挂载时
 * 经 GET /runs + 轮询 /progress 恢复进行中的 run（刷新/重开面板后）。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import type { ServiceStatus } from './api.ts'
import { runStore, type LibraryStoreSlice, type PanelId, type TaskState } from './run-store.ts'
import { navLayout } from '../ui/nav-model.ts'
import { toast } from './common/toast-store.ts'
import { COMMANDS, type CommandContext } from '../ui/commands.ts'
import { MoreMenu } from './common/MoreMenu.tsx'
import { CommandPalette } from './common/CommandPalette.tsx'
import { TaskShell } from './task/TaskShell.tsx'
import { LibraryPanel } from './library/LibraryPanel.tsx'
import { LibraryActions } from './library/LibraryActions.tsx'
import type { ArtifactCapability, ArtifactRow } from '../ui/artifact-view.ts'
import { HomePanel } from './home/HomePanel.tsx'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import { ForeignImportView } from './import/ForeignImportView.tsx'
import { SyncPanel } from './sync/SyncPanel.tsx'
import { MarketPanel } from './market/MarketPanel.tsx'
import { AboutPanel } from './about/AboutPanel.tsx'
import { EnvironmentPanel } from './environment/EnvironmentPanel.tsx'
import { HistoryPanel } from './history/HistoryPanel.tsx'
import { RunsCenter } from './common/RunsCenter.tsx'
import { toRecoveryView } from './recovery/recovery-view.ts'
import { ConfirmDialog } from './common/ConfirmDialog.tsx'
import { MODAL_ROOT_ID } from './common/Modal.tsx'
import { Banner, IconButton, StatusDot } from './common/ui.tsx'
import { ActivityIcon, AboutIcon, ChevronDownIcon, HistoryIcon, Icon } from './common/Icon.tsx'
import { evaluateStarPrompt } from '../ui/star-prompt.ts'
import { evaluateReleaseNotesPrompt } from '../ui/release-notes-prompt.ts'
import { ReleaseNotesDialog } from './about/ReleaseNotesDialog.tsx'
import { ToastViewport } from './common/ToastViewport.tsx'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'settings.section'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

/** 导航页定义。 */
interface NavItem {
  id: PanelId
  label: string
}

/**
 * 一级导航（UI v3 §3.1）：首页 / 产物库 / 同步 / 环境。
 *
 * v3 把**市场**移出一级导航（回到 v2 的定案）：它由 Task 面板承载，
 * 入口是产物库底栏「逛市场 / 发布到市场」与 ⌘K 的两条命令。
 * 于是导航容量从「5 项 + 4 图标」降到「4 项 + 4 图标」，中英双语都留有余量。
 */
const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'nav.home' },
  { id: 'library', label: 'library.title' },
  { id: 'sync', label: 'nav.sync' },
  { id: 'environment', label: 'environment.title' },
]

/** 与 CSS `.navStrip { gap: 2px }` 必须一致（导航布局判定要用真实间距）。 */
const NAV_GAP = 2

/**
 * Workbench Shell：导航条 + 内容区（页面 / 流程面板）+ 状态栏。
 */
export function ConfigManagerSection({ api, syncApi, syncT, marketApi, myConfigsApi, marketT, recoveryApi, recoveryT, historyApi, historyT, incidentApi, uiT, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const panel: PanelId = state.panel
  const task = state.task

  /* ---------------- 活动 / 历史 / 关于：三种只读 task（§5.9） -------------
     它们原是右侧 400px 抽屉（带遮罩、占画布 71%、表格挤在 400px 里）。
     并入侧滑面板后，全站只剩「页面 / 面板」两个容器概念，两张表也拿到内容区全宽。 */
  /* ---------------- 顶部页签条自适应布局（UI v2 §5.2） ---------------- */
  /**
   * v1 把「放不下」当成可发现性问题（隐藏滚动条 + 两侧渐隐遮罩），用户得按住 shift 才滚得动。
   * v2 承认它是**容量问题**：放不下就从末项开始移进「更多 ▾」，绝不把页签藏在视口外。
   *
   * 判定在 `ui/nav-model.ts`（纯函数 + 单测）；这里只负责**实测**宽度 —— 标签文案随语言变化，
   * 按字数估算必然失准（中英混排、字号、系统缩放都会影响）。
   */
  const navRef = useRef<HTMLDivElement | null>(null)
  const navMeasureRef = useRef<HTMLDivElement | null>(null)
  const [navWidths, setNavWidths] = useState<{ avail: number; items: number[]; more: number } | null>(null)
  useLayoutEffect(() => {
    const strip = navRef.current
    const box = navMeasureRef.current
    if (strip === null || box === null) return
    const measure = (): void => {
      const cs = getComputedStyle(strip)
      const avail = strip.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight)
      const kids = Array.from(box.children)
      const moreEl = kids[0]
      const more = moreEl instanceof HTMLElement ? moreEl.getBoundingClientRect().width : 0
      const items = kids.slice(1).map((el) => el.getBoundingClientRect().width)
      // 只在数值真的变了才 setState，避免 ResizeObserver 自激
      setNavWidths((prev) => (
        prev !== null && prev.avail === avail && prev.more === more
        && prev.items.length === items.length && prev.items.every((w, i) => w === items[i])
      ) ? prev : { avail, items, more })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(strip)
    // 字体就绪后字宽会变（首帧可能用的还是回退字体）
    void document.fonts?.ready.then(measure, () => {})
    return () => { observer?.disconnect() }
  }, [t])

  /**
 * ARIA tabs 模式的 DOM id：tab ↔ tabpanel 必须互相指认（此前只有 role=tab，读屏听到「标签页 2/4」
 * 却找不到对应面板）。常量放在装配层，id 只在本组件内使用。
 */
const NAV_TAB_ID = (id: PanelId): string => 'cm-nav-tab-' + id
const PAGE_PANEL_ID = 'cm-page-panel'

const navLayoutResult = navWidths === null
    // 未测量 = **全部可见**：宁可横向溢出（视觉瑕疵），也不能因为量不出来而藏页签（功能丢失）
    ? { visible: NAV_ITEMS.map((_, i) => i), overflow: [] as number[] }
    : navLayout(navWidths.items, navWidths.avail, navWidths.more, NAV_GAP)
  const visibleNav = navLayoutResult.visible.flatMap((i) => (NAV_ITEMS[i] === undefined ? [] : [NAV_ITEMS[i]!]))
  const overflowNav = navLayoutResult.overflow.flatMap((i) => (NAV_ITEMS[i] === undefined ? [] : [NAV_ITEMS[i]!]))

  /* ---------------- 命令面板（⌘K，§5.3） ---------------- */
  const [paletteOpen, setPaletteOpen] = useState(false)

  /**
   * 产物库的行内动作：交给**面板之外**的 LibraryActions 渲染（§6.5）。
   * 必须放在壳层而不是 LibraryPanel 内部 —— 动作要开的 Modal 若渲染在 task 面板里，
   * 定位基准会变成那块侧滑区域而不是插件根节点。
   */
  const [libraryAction, setLibraryAction] = useState<{ capability: ArtifactCapability; row: ArtifactRow } | null>(null)
  /** 产物列表刷新信号：恢复 / 删除 / 置顶完成后递增，让面板重拉四份清单 */
  const [libraryTick, setLibraryTick] = useState(0)

  /**
   * 导入面板当前是否停在「从其它 agent 导入」这一页（t17）。
   *
   * 为什么是壳层 state 而不是 runStore：它与「导入面板」同生命周期，且**不该被持久化** ——
   * 刷新后重放一个「正在选来源」的界面只会骗人（来源检测结果要重新拉）。
   * 关面板 / 切走即随组件卸载归零，与 libraryAction 同一档语义。
   */
  const [foreignImportOpen, setForeignImportOpen] = useState(false)

  /* ---------------- 状态栏版本（挂载时取一次；失败隐藏） ---------------- */
  const [version, setVersion] = useState<ServiceStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    api.status().then(
      (s) => { if (!cancelled) setVersion(s) },
      () => { /* 版本信息失败不影响功能 */ },
    )
    return () => { cancelled = true }
  }, [api])

  /* ---------------- m-star-prompt：Star 引导弹窗（保持既有能力） ---------------- */
  const [starPromptOpen, setStarPromptOpen] = useState(false)
  /** 弹窗展示的 GitHub 仓库地址（GET /star-prompt 返回；不落 store） */
  const starRepoUrl = useRef('')
  /** 本次挂载只判定一次（防止 StrictMode/重挂载重复弹） */
  const starPromptChecked = useRef(false)

  useEffect(() => {
    if (starPromptChecked.current) return
    starPromptChecked.current = true
    void (async () => {
      try {
        const status = await api.starPromptStatus()
        const ev = evaluateStarPrompt(
          { firstSeenAt: status.firstSeenAt, dismissed: status.dismissed, clicked: status.clicked },
          Date.now(),
        )
        // 首次进入：补记首次使用时间（失败静默，下次进入再记）
        if (ev.shouldRecordFirstSeen) {
          void api.saveStarPrompt({ firstSeenAt: Date.now() }).catch(() => {})
        }
        // 满 3 天且未表态：展示弹窗
        if (ev.shouldShow) {
          starRepoUrl.current = status.repoUrl
          setStarPromptOpen(true)
        }
      } catch {
        // 服务未就绪 / 挂载异常：不弹，静默（下次进入再判）
      }
    })()
  }, [api])

  /** 去点 Star：打开仓库页 + 记 clicked（此后不再弹）。 */
  const handleStar = (): void => {
    setStarPromptOpen(false)
    const url = starRepoUrl.current
    if (url !== '') {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      anchor.click()
    }
    void api.saveStarPrompt({ clicked: true }).catch(() => {})
  }

  /** 不再提示：关闭弹窗 + 记 dismissed（永久不再弹）。 */
  const handleDismiss = (): void => {
    setStarPromptOpen(false)
    void api.saveStarPrompt({ dismissed: true }).catch(() => {})
  }

  /** 遮罩点击 / Esc：只是暂时关闭，不记表态（下次进入再判）。 */
  const handleBackdropClose = (): void => {
    setStarPromptOpen(false)
  }

  /* ---------------- 版本更新内容弹窗（保持既有能力） ---------------- */
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  /** 当前运行的插件版本号（GET /release-notes-prompt 返回） */
  const releaseNotesCurrentVersion = useRef('')
  /** 本次挂载只判定一次（防止 StrictMode/重挂载重复弹） */
  const releaseNotesChecked = useRef(false)

  useEffect(() => {
    if (releaseNotesChecked.current) return
    releaseNotesChecked.current = true
    void (async () => {
      try {
        const status = await api.releaseNotesPromptStatus()
        const currentVer = status.currentVersion ?? ''
        releaseNotesCurrentVersion.current = currentVer
        const ev = evaluateReleaseNotesPrompt(
          { lastSeenVersion: status.lastSeenVersion, dismissed: status.dismissed },
          currentVer,
        )
        if (ev.shouldShow) {
          setReleaseNotesOpen(true)
        }
      } catch {
        // 服务未就绪 / 网络异常：不弹，静默
      }
    })()
  }, [api])

  /** 确认：关闭弹窗 + 记录当前版本已读（下次更新到新版本时仍会提示）。 */
  const handleReleaseNotesConfirm = (): void => {
    setReleaseNotesOpen(false)
    const ver = releaseNotesCurrentVersion.current
    void api.saveReleaseNotesPrompt({ lastSeenVersion: ver !== '' ? ver : undefined }).catch(() => {})
  }

  /** 永不提示：关闭弹窗 + 记录 dismissed（后续版本更新不再自动提示）。 */
  const handleReleaseNotesNeverShow = (): void => {
    setReleaseNotesOpen(false)
    const ver = releaseNotesCurrentVersion.current
    void api.saveReleaseNotesPrompt({ dismissed: true, lastSeenVersion: ver !== '' ? ver : undefined }).catch(() => {})
  }

  /** 遮罩 / Esc / 标题栏关闭：按确认关闭，记录当前版本已读（防刷新重复弹同一版本）。 */
  const handleReleaseNotesClose = (): void => {
    handleReleaseNotesConfirm()
  }

  /* ---------------- m2-resume：挂载时重新订阅进行中的 run ---------------- */
  useEffect(() => {
    void runStore.resume(api)
    return () => {
      runStore.stopResume()
    }
  }, [api])

  /* ---------------- 落盘失败的可见通道（sessionStorage 配额满时刷新即丢） ----------------
     store 不持有词典，提示文案由壳层给；只提示一次（配额满时 patch 很频繁，逐次弹会刷屏）。 */
  useEffect(() => {
    runStore.setSaveErrorNotifier(() => { toast.warn(t('common.saveFailed')) })
    return () => { runStore.setSaveErrorNotifier(null) }
  }, [t])

  /* ---------------- 全局 SAFE MODE 状态（跨页面可见兜底） ---------------- */
  const recoveryStatus = state.recovery.status
  useEffect(() => {
    if (recoveryStatus !== null) return
    let cancelled = false
    recoveryApi.status().then(
      (s) => { if (!cancelled) runStore.patch({ recovery: { status: s } }) },
      () => { /* 拉取失败静默：不弹横幅，用户进恢复面板自己会看到 */ },
    )
    return () => { cancelled = true }
  }, [recoveryStatus, recoveryApi])
  const recoveryRequired = recoveryStatus !== null
    ? (toRecoveryView(recoveryStatus).recoveryRequired === true)
    : false

  /* ---------------- 导航 ---------------- */
  /** 切页（v3：4 个一级页面；流程一律由 Task 面板承载，不再有「导入页」这种中间态）。 */
  const goto = (id: PanelId): void => {
    runStore.patch({ panel: id })
  }

  /**
   * 打开流程面板（Task Mode，§5.8）。origin 记发起页：面板只在 `panel === origin` 时渲染，
   * 于是「切走收起、切回续做」不需要额外的状态。
   *
   * v3 起 origin 恒为当前页 —— 四个页面都是真实存在的 PanelId，
   * 不再有 v1/v2 那种「origin 被记成已不存在的中间页」的成因。
   */
  const openTask = (kind: TaskState['kind'], payload?: unknown): void => {
    const origin: PanelId = panel
    runStore.patch({ panel: origin, task: { kind, origin, ...(payload === undefined ? {} : { payload }) } })
  }

  const closeTask = (): void => { runStore.patch({ task: null }) }

  /**
   * 命令面板专用：切到产物库并**落定来源筛选**。
   * 筛选状态只有一个事实源（`runStore.library.sourceFilter`，列表本体读它），
   * 所以命令不复制一份筛选判定，只写同一个字段。
   */
  const openLibrarySource = (sourceFilter: LibraryStoreSlice['sourceFilter']): void => {
    runStore.patch({ panel: 'library', library: { sourceFilter } })
  }

  /**
   * 维护与诊断（事故恢复也在其中）在环境页里是**全屏子视图**，不是独立页面。
   * 子视图状态住在 runStore 的 profiles 切片里 —— 正因为命令面板与 SAFE MODE 横幅都要能直达它
   * （§4.4：急救入口不是「把用户送到某个页面」），只 patch `panel` 会落在「档案」列表上，等于没送到。
   */
  const openMaintenance = (): void => {
    runStore.patch({ panel: 'environment', profiles: { subView: 'maintenance' } })
  }

  /** tablist 方向键导航（ARIA tabs，manual activation）：←/→ 移动焦点，Enter/Space 原生激活。 */
  const onTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const container = event.currentTarget
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    if (buttons.length === 0) return
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (currentIndex < 0) return
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = buttons[(currentIndex + delta + buttons.length) % buttons.length]
    if (next !== undefined) {
      event.preventDefault()
      next.focus()
    }
  }

  /**
   * 进行中任务的**名字**（v3 §3.1：状态栏兑现「任务名 + 细进度条」）。
   *
   * 为什么进度条是**不定态**：本层只有「在跑 / 没跑」的布尔，真实百分比住在宿主
   * /progress 的轮询结果里；编一个百分比、或把结束态画成静止满格，都是在撒谎
   * （与「未知不显示 0」同一条原则）。
   */
  const runningLabel = state.export.running
    ? t('task.title.export')
    : state.import.running
      ? t('task.title.import')
      : state.sync.busy !== null
        ? t('nav.sync')
        : state.snapshots.running
          ? t('shell.running.restore')
          : state.recovery.running
            ? t('palette.rescue.recovery')
            : null

  /* ---------------- 状态栏数据 ---------------- */
  const runningCount =
    (state.export.running ? 1 : 0)
    + (state.import.running ? 1 : 0)
    + (state.sync.busy !== null ? 1 : 0)
    + (state.snapshots.running ? 1 : 0)
    + (state.recovery.running ? 1 : 0)
  const statusKind: 'ok' | 'info' | 'error' = recoveryRequired
    ? 'error'
    : runningCount > 0 ? 'info' : 'ok'
  const statusText = recoveryRequired
    ? t('shell.status.recovery')
    : runningCount > 0 ? t('shell.status.running', { count: String(runningCount) }) : t('shell.status.idle')

  /* ---------------- 命令面板：快捷键与命令分发 ---------------- */
  /**
   * ⌘/Ctrl+K 唤起。挂 window 是为了焦点在任何位置都能打开；但**不抢输入框里的这个组合**
   * —— 宿主别处也可能用它，抢掉会让用户在文本框里打不出字。
   * 面板本身是 Radix 弹窗，focus trap / Esc / 遮罩都由它管，这里不管。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      const target = event.target
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      event.preventDefault()
      setPaletteOpen((prev) => !prev)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  /** 命令面板的可用性上下文（每次渲染现算；判定全在 ui/commands.ts）。 */
  const commandCtx: CommandContext = { recoveryRequired, runningCount }

  /**
   * 命令分发：命令表是纯数据（ui/commands.ts），执行落在这里 —— 只有壳层认识 store 与 api。
   * **命令表里的每个 id 这里都必须有一条**（认不出的 id 会静默什么都不做），反之亦然。
   */
  const runCommand = (id: string): void => {
    switch (id) {
      case 'go.home': goto('home'); return
      case 'go.library': goto('library'); return
      case 'go.sync': goto('sync'); return
      case 'go.environment': goto('environment'); return
      // 产物库来源筛选：切页 + 落定筛选（列表本体读 runStore.library.sourceFilter）
      case 'library.source.all': openLibrarySource(null); return
      case 'library.source.snapshot': openLibrarySource('snapshot'); return
      case 'library.source.backupFile': openLibrarySource('backup-file'); return
      case 'library.source.remote': openLibrarySource('remote-snapshot'); return
      case 'library.source.market': openLibrarySource('market'); return
      case 'export.open': openTask('export'); return
      case 'import.open': openTask('import'); return
      // 市场不再是页面（v3）：逛市场 / 发布到市场各开一个 Task 面板
      case 'market.open': openTask('market'); return
      // 发布 = 市场面板的「我的配置」子视图：payload 让面板直开那一页（M4 接线）
      case 'market.publish.open': openTask('market', { subView: 'myconfigs' }); return
      // 维护与诊断是全屏子视图：命令直达它，而不是只把用户送到环境页
      // 从其它 agent 导入：开导入面板并停在来源选择（与首页工具栏同一路径）
      case 'import.foreign': openTask('import'); setForeignImportOpen(true); return
      case 'maintenance.open': openMaintenance(); return
      case 'activity.open': openTask('runs'); return
      case 'history.open': openTask('history'); return
      case 'about.open': openTask('about'); return
      // 急救入口直达**环境 → 维护与诊断**（§4.4 第三条：不是只把用户送到某个页面）
      case 'recovery.open': openMaintenance(); return
      // 救援模式：与事故恢复同一子视图（救援卡在其中）；两条命令都必须存在（§3.6）
      case 'rescue.open': openMaintenance(); return
      // S7：回滚点卡也在维护与诊断里（紧跟会话体检），命令直达同一落点
      case 'rollback.open': openMaintenance(); return
      default: return
    }
  }

    /** 当前页面内容（pagePad 统一内边距）。 */
  let page: ReactNode
  switch (panel) {
    case 'home':
      page = (
        <HomePanel
          api={api}
          syncApi={syncApi}
          historyApi={historyApi}
          t={t}
          syncT={syncT}
          // 直达来源选择：开导入面板 + 把面板切到「从其它 agent 导入」那一步
          openForeignImport={() => {
            openTask('import')
            setForeignImportOpen(true)
          }}
        />
      )
      break
    case 'library':
      page = (
        <LibraryPanel
          api={api}
          syncApi={syncApi}
          marketApi={marketApi}
          t={t}
          uiT={uiT}
          onAction={(capability, row) => { setLibraryAction({ capability, row }) }}
          onOpenTask={(kind, marketId) => { openTask(kind, marketId === undefined ? undefined : { marketId }) }}
          onOpenExport={() => { openTask('export') }}
          onOpenPublish={() => { openTask('market', { subView: 'myconfigs' }) }}
          refreshTick={libraryTick}
        />
      )
      break
    case 'sync':
      page = <SyncPanel api={syncApi} t={syncT} cmT={t} />
      break
    case 'environment':
      page = (
        <EnvironmentPanel
          api={api}
          t={t}
          recoveryApi={recoveryApi}
          recoveryT={recoveryT}
          incidentApi={incidentApi}
        />
      )
      break
  }

  /** 当前生效的流程面板：**只在发起它的页面上渲染** —— 切走收起、切回续做（§5.8）。 */
  const activeTask = task !== null && task.origin === panel ? task : null
  const taskOriginNav = activeTask === null ? undefined : NAV_ITEMS.find((item) => item.id === activeTask.origin)
  const taskOriginLabel = taskOriginNav === undefined
    ? t('section.label')
    : t(taskOriginNav.label as Parameters<TranslateNS<'config-manager'>>[0])

  return (
    // id 同时作为 Radix Modal 的 Portal 容器（见 common/Modal.tsx 的 MODAL_ROOT_ID 说明）：
    // 弹窗必须留在宿主设置弹窗的层叠上下文内，否则会被宿主 overlay(z-index:1000) 盖住而「隐形」。
    <div className={css.section} id={MODAL_ROOT_ID}>
      {/* 顶部导航条：页签 + 图标动作 */}
      <nav className={css.shellNav} aria-label={t('section.label')}>
        <div className={css.navStrip} role="tablist" ref={navRef} onKeyDown={onTablistKeyDown}>
          {visibleNav.map((item) => (
            <button
              key={item.id}
              id={NAV_TAB_ID(item.id)}
              type="button"
              role="tab"
              aria-selected={panel === item.id}
              // ARIA tabs 模式：tab 必须指认它控制的面板（此前只有 role=tab，读屏找不到对应面板）
              aria-controls={PAGE_PANEL_ID}
              data-active={panel === item.id ? '' : undefined}
              className={css.navTab}
              onClick={() => { goto(item.id) }}
            >
              {item.id === 'environment' && recoveryRequired && <span className={css.navDot} aria-hidden="true" />}
              {t(item.label as Parameters<TranslateNS<'config-manager'>>[0])}
            </button>
          ))}
          {/* 放不下的项进「更多 ▾」—— 判定在 ui/nav-model.ts；放得下时这里什么都不渲染 */}
          {overflowNav.length > 0 && (
            <MoreMenu
              items={overflowNav.map((item) => ({
                id: item.id,
                label: t(item.label as Parameters<TranslateNS<'config-manager'>>[0]),
              }))}
              activeId={panel}
              onSelect={(id) => { goto(id as PanelId) }}
              label={t('nav.more')}
            />
          )}
        </div>
        <div className={css.navActions}>
          <IconButton
            icon={<Icon name="inspect" size={14} />}
            label={t('palette.label')}
            title={t('palette.hint')}
            onClick={() => { setPaletteOpen(true) }}
          />
          <IconButton
            icon={<ActivityIcon size={14} />}
            label={t('overview.nav.activity')}
            active={activeTask?.kind === 'runs'}
            onClick={() => { openTask('runs') }}
          />
          <IconButton
            icon={<HistoryIcon size={14} />}
            label={t('task.title.history')}
            active={activeTask?.kind === 'history'}
            onClick={() => { openTask('history') }}
          />
          <IconButton
            icon={<AboutIcon size={14} />}
            label={t('overview.nav.about')}
            active={activeTask?.kind === 'about'}
            onClick={() => { openTask('about') }}
          />
        </div>
      </nav>

      {/* 全局 SAFE MODE 横幅：有未解决恢复事项时，无论当前页面都提示并引导去处理 */}
      {recoveryRequired && (
        <div className={css.bannerSlot}>
          <Banner kind="error">
            {recoveryT('recovery.banner')}
            <button
              type="button"
              className={css.ghostButton}
              data-size="sm"
              onClick={openMaintenance}
            >
              {recoveryT('recovery.bannerAction')}
            </button>
          </Banner>
        </div>
      )}

      {/* 内容区（页面与流程面板共用这一块）。
          面板是 absolute 覆盖层（§5.8），所以底下的页面**保持挂载** —— 关闭是瞬时的，
          滚动位置、展开的那一行、已拉到的数据都还在。
          key={panel}：换页时重建本节点，让 pageEnter 动画重放一次（CSS 动画只在元素创建时播放）。 */}
      <div className={css.shellContent}>
        {/* ARIA tabs 模式的面板侧：id 与 nav tab 的 aria-controls 配对，aria-labelledby 指回当前页签。
            tabIndex=-1 让「切页签后把焦点送进内容」这条键盘路径可达（不改变既有 tab 顺序）。 */}
        <main
          className={css.shellMain}
          id={PAGE_PANEL_ID}
          role="tabpanel"
          aria-labelledby={NAV_TAB_ID(panel)}
          tabIndex={-1}
        >
          <div className={css.pagePad} key={panel}>{page}</div>
        </main>
        {/** 产物库的行内动作：**在 task 面板之外**渲染（它的 Modal 不能被面板的定位上下文吃掉） */}
        <LibraryActions
          api={api}
          syncApi={syncApi}
          t={t}
          target={libraryAction}
          onDone={() => { setLibraryAction(null) }}
          onChanged={() => { setLibraryTick((n) => n + 1) }}
          onOpenTask={(kind, marketId) => { openTask(kind, marketId === undefined ? undefined : { marketId }) }}
        />
        {activeTask !== null && (
          <TaskShell
            title={t(`task.title.${activeTask.kind}`)}
            backLabel={t('task.back', { page: taskOriginLabel })}
            onBack={closeTask}
            // Esc 关闭只给只读视图：多阶段流程里可能有未保存的计划或已输入的密码
            escToClose={activeTask.kind === 'runs' || activeTask.kind === 'history' || activeTask.kind === 'about'}
            // 外壳不重挂，所以滚动归零交给它（否则两个长列表之间切换会从中段开始）
            resetKey={activeTask.kind}
          >
            {activeTask.kind === 'export' && <ExportView api={api} t={t} />}
            {/* 导入与逛市场都是多阶段流程（§1），同样由本面板承载。
                此前只渲染了 export / runs / history / about —— 从产物库点「导入」会开到**一个空面板**，
                而导入其实在页面那条路径里跑（返回后正好看到它），两处状态分叉。 */}
            {activeTask.kind === 'import' && (foreignImportOpen ? (
              /* 「从其它 agent 导入」（t17）：页面级步骤，复用同一块面板 ——
                 与既有导入向导并列，避免「弹窗套向导」。产包成功后把 zipPath 写进
                 runStore.library.pendingZip（产物库「一键导入」那条已验证的通道），
                 关掉本页即回到向导，由它消费该请求开始分析。 */
              <ForeignImportView
                api={api}
                t={t}
                uiT={uiT}
                onReady={(result) => {
                  setForeignImportOpen(false)
                  runStore.patch({
                    library: {
                      pendingZip: { zipPath: result.zipPath, name: result.name },
                    },
                  })
                }}
              />
            ) : (
              <ImportWizardView
                api={api}
                t={t}
                uiT={uiT}
                onOpenForeignImport={() => { setForeignImportOpen(true) }}
              />
            ))}
            {activeTask.kind === 'market' && (
              <MarketPanel
                api={marketApi}
                myConfigsApi={myConfigsApi}
                syncApi={syncApi}
                importApi={api}
                t={marketT}
                cmT={t}
                /* 产物库「安装」把要装的条目 id 经 Task 入参带进来 → 面板直开该条目 */
                openItemId={marketTaskItemId(activeTask.payload)}
                initialSubView={marketTaskSubView(activeTask.payload)}
              />
            )}
            {/* 三种只读视图（原抽屉内容，§5.9）。三者各有独立入口、面板内不再放切换控件：
                导航「活动」图标 = 活动记录（运行）、「关于」图标 = 关于、首页的「迁移历史」按钮 = 本视图。
                **外壳不随 kind 重挂**：按 kind 重挂 = 旧面板卸载 + 新面板从 opacity:0 入场，
                中间会露出一帧底下的页面（用户报告的「切换侧拉页面时闪烁」）；现在换视图 = 原地换内容。 */}
            {activeTask.kind === 'runs' && (
              <RunsCenter
                api={api}
                // 事故恢复端口：运行中心用它显示/回收环境锁（残留锁的可见入口）
                recoveryApi={recoveryApi}
                t={t}
                // 决策框默认选项跟随用户既有的「失败不回滚」偏好（不推翻他的心智）
                defaultRollbackOnError={state.import.rollbackOnError}
              />
            )}
            {activeTask.kind === 'history' && <HistoryPanel historyApi={historyApi} t={historyT} />}
            {activeTask.kind === 'about' && <AboutPanel api={api} t={t} />}
          </TaskShell>
        )}
      </div>

      {/* 底部状态栏：运行状态 + 版本 */}
      <footer className={css.statusBar}>
        <StatusDot kind={statusKind} pulse={runningCount > 0} />
        {/* 状态栏 = 运行中心的入口：有任务在跑时必须可点。
            此前这里是**死文本** —— 关掉设置弹窗后，正在跑的导入在界面上再无任何入口。 */}
        {runningCount > 0 ? (
          <button
            type="button"
            className={`${css.statusText} ${css.statusAction}`}
            title={t('shell.status.runningAction')}
            aria-label={t('shell.status.runningAction')}
            onClick={() => { openTask('runs') }}
          >
            {statusText}
            {runningLabel !== null && <span className={css.statusTask}>{runningLabel}</span>}
            <span className={css.statusProgress} aria-hidden="true" />
          </button>
        ) : (
          <span className={css.statusText}>{statusText}</span>
        )}
        <span className={css.statusSpacer} />
        {version !== null && (
          <span className={css.statusMeta}>
            {t('shell.version', { plugin: version.pluginVersion, dsh: version.dshVersion })}
          </span>
        )}
      </footer>

      {/* 宽度实测容器：结构与真实页签**逐字节同构**（同一批 class、同一段文案、同样的告警点），
          否则量出来的宽度不是真实宽度 —— 布局判定就建立在假数据上。
          absolute + 移出视口，完全不参与布局。 */}
      <div ref={navMeasureRef} className={css.navMeasure} aria-hidden="true">
        <button type="button" className={css.navMore} tabIndex={-1}>
          {t('nav.more')}
          <ChevronDownIcon size={12} className={css.selectChevron} />
        </button>
        {NAV_ITEMS.map((item) => (
          <button key={item.id} type="button" className={css.navTab} tabIndex={-1}>
            {item.id === 'environment' && recoveryRequired && <span className={css.navDot} aria-hidden="true" />}
            {t(item.label as Parameters<TranslateNS<'config-manager'>>[0])}
          </button>
        ))}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false) }}
        commands={COMMANDS}
        ctx={commandCtx}
        onRun={runCommand}
        t={t}
      />

      {/* 全局通知视口（右下角堆叠；绝对定位贴合本根节点，见 §6 Overlays） */}
      <ToastViewport t={t} />

      {/* Star 引导弹窗（「去点 Star」= primary 主操作，「不再提示」= 次按钮） */}
      <ConfirmDialog
        open={starPromptOpen}
        title={t('starPrompt.title')}
        message={t('starPrompt.body')}
        confirmLabel={t('starPrompt.star')}
        cancelLabel={t('starPrompt.dismiss')}
        onConfirm={handleStar}
        onCancel={handleDismiss}
        backdropClose={handleBackdropClose}
      />
      {/* 版本更新内容弹窗（检测到更新后自动跳出，支持「确认」与「永不提示」） */}
      <ReleaseNotesDialog
        open={releaseNotesOpen}
        onClose={handleReleaseNotesClose}
        onConfirm={handleReleaseNotesConfirm}
        onNeverShow={handleReleaseNotesNeverShow}
        t={t}
      />
    </div>
  )
}

/**
 * Task 入参里取「市场条目 id」（产物库的「安装」用；Task 面板只渲染在来源页上）。
 * 入参是 unknown（可扩展、可序列化），此处只认形如 `{ marketId: string }` 的载荷，
 * 缺字段 / 类型不对一律 undefined（= 打开市场列表，绝不猜）。
 */
/** Task 入参里取「市场子视图」（⌘K 的「发布到市场」直达「我的配置」）。 */
function marketTaskSubView(payload: unknown): 'browse' | 'myconfigs' | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const v: unknown = (payload as { subView?: unknown }).subView
  return v === 'myconfigs' || v === 'browse' ? v : undefined
}

function marketTaskItemId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const id: unknown = (payload as { marketId?: unknown }).marketId
  return typeof id === 'string' && id !== '' ? id : undefined
}
