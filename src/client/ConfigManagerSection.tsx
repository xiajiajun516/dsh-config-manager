/**
 * Config Manager 设置页（settings.section 入口）—— Workbench Shell（2026-09 Full UI Rebuild）。
 *
 * 结构（画布 ≈ 564 × 720，800px 设置弹窗内）：
 *   ┌ navStrip：总览 / 备份 / 导出 / 导入 / 同步 / 市场 / 档案 + 右侧图标动作（活动/关于）
 *   ├ (SAFE MODE 横幅：仅恢复待处理时出现)
 *   ├ shellMain：当前页面（pagePad 内边距，独立滚动）
 *   └ statusBar：运行状态点 + 进行中任务数 + 版本信息
 * 另有「活动与关于」右侧抽屉（活动记录 / 关于 两个子视图，moreSub 持久化）。
 *
 * IA（Workbench Rebuild）：export/import 升为一级页面；旧「更多」面板由抽屉取代
 * （run-store parsePersistedState 将旧 panel 值迁移，moreSub 保留）。
 *
 * 业务面（api/syncApi/marketApi）由注册时的 inject face 注入；t 由 locale seat 注入。
 * 关闭按钮由 settings shell 自带，本页不再渲染。
 *
 * m2：主视图（panel/view）与全部子视图状态统一由模块级 runStore 持有
 * （sessionStorage 持久化 + 切页/关面板不重建控制器实例）；挂载时
 * 经 GET /runs + 轮询 /progress 恢复进行中的 run（刷新/重开面板后）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import type { ServiceStatus } from './api.ts'
import { runStore, type PanelId } from './run-store.ts'
import { OverviewPanel } from './overview/OverviewPanel.tsx'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import { SnapshotsPanel } from './snapshots/SnapshotsPanel.tsx'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { MarketPanel } from './market/MarketPanel.tsx'
import { AboutPanel } from './about/AboutPanel.tsx'
import { ProfilesPanel } from './profiles/ProfilesPanel.tsx'
import { RecoveryPanel } from './recovery/RecoveryPanel.tsx'
import { HistoryPanel } from './history/HistoryPanel.tsx'
import { LifecyclePanel } from './lifecycle/LifecyclePanel.tsx'
import { toRecoveryView } from './recovery/recovery-view.ts'
import { ConfirmDialog } from './common/ConfirmDialog.tsx'
import { MODAL_ROOT_ID } from './common/Modal.tsx'
import { Banner, IconButton, Segmented, StatusDot } from './common/ui.tsx'
import { ActivityIcon, AboutIcon, CloseIcon } from './common/Icon.tsx'
import { navOverflowAttr, navOverflowState } from '../ui/nav-overflow.ts'
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
 * 灾备页（Phase 1 灾备基线，`panel='lifecycle'`）导航入口开关。
 *
 * 暂时置 `false` **隐藏入口**（待相关 bug 修复后再放出）。只隐藏导航入口：
 * `case 'lifecycle'` 渲染分支、`LifecyclePanel` 组件与宿主 `/lifecycle|/crash|/rescue`
 * 路由均保持原样，改回 `true` 即可恢复入口。
 */
const SHOW_LIFECYCLE_NAV = false

/** 灾备页导航项（仅当 `SHOW_LIFECYCLE_NAV` 为真时挂上导航条）。 */
const LIFECYCLE_NAV_ITEM: NavItem = { id: 'lifecycle', label: 'nav.recovery' }

/** 一级导航（Workbench IA：7 页签；export/import 为独立页面）。 */
const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'nav.overview' },
  { id: 'snapshots', label: 'nav.backups' },
  ...(SHOW_LIFECYCLE_NAV ? [LIFECYCLE_NAV_ITEM] : []),
  { id: 'export', label: 'nav.export' },
  { id: 'import', label: 'nav.import' },
  { id: 'sync', label: 'nav.sync' },
  { id: 'market', label: 'nav.market' },
  { id: 'profiles', label: 'nav.profiles' },
]

/**
 * Workbench Shell：导航条 + 页面内容 + 状态栏 + 活动抽屉。
 */
export function ConfigManagerSection({ api, syncApi, syncT, marketApi, myConfigsApi, marketT, recoveryApi, recoveryT, historyApi, historyT, lifecycleApi, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  // 入口隐藏期间，把持久化（sessionStorage）里的 panel='lifecycle' 回落到「备份」页：
  // 否则此前切到过灾备页的会话刷新后会停在一个已无导航入口的页面上。
  // 渲染期即回落（不闪一帧），effect 再把 store 自身归一化，避免反复回落。
  const panel: PanelId = !SHOW_LIFECYCLE_NAV && state.panel === 'lifecycle' ? 'snapshots' : state.panel
  useEffect(() => {
    if (!SHOW_LIFECYCLE_NAV && runStore.getSnapshot().panel === 'lifecycle') {
      runStore.patch({ panel: 'snapshots' })
    }
  }, [panel])

  /* ---------------- 活动与关于抽屉（drawerOpen 本地瞬态；子视图 moreSub 持久化） ---------------- */
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openDrawer = (sub: 'history' | 'about'): void => {
    runStore.patch({ more: { moreSub: sub } })
    setDrawerOpen(true)
  }
  const closeDrawer = (): void => { setDrawerOpen(false) }
  /* ---------------- 顶部页签条溢出可发现性（UI-19） ---------------- */
  /**
   * 页签条滚动条被隐藏（scrollbar-width: none）：英文界面（7 个英文页签 + 2 个文字动作按钮）
   * 在 564px 画布下会溢出，而界面上没有任何「右边还有内容」的提示。
   * 这里把溢出状态写进 `data-overflow`，由 CSS 在对应一侧画渐隐遮罩（判定见 src/ui/nav-overflow.ts）。
   */
  const navRef = useRef<HTMLDivElement | null>(null)
  const [navOverflow, setNavOverflow] = useState<'none' | 'start' | 'end' | 'both'>('none')
  useEffect(() => {
    const el = navRef.current
    if (el === null) return
    const sync = (): void => { setNavOverflow(navOverflowAttr(navOverflowState(el))) }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    // 字号/语言（页签文案长度）变化同样会改变是否溢出：容器尺寸观察作双保险
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      observer?.disconnect()
    }
  }, [t])

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
  /** 切页（export/import 时同步 view 镜像字段，保持旧持久化语义）。 */
  const goto = (id: PanelId): void => {
    if (id === 'export') runStore.patch({ view: 'export', panel: 'export' })
    else if (id === 'import') runStore.patch({ view: 'import', panel: 'import' })
    else runStore.patch({ panel: id })
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

  /** 当前页面内容（pagePad 统一内边距）。 */
  let page: ReactNode
  switch (panel) {
    case 'overview':
      page = <OverviewPanel api={api} syncApi={syncApi} historyApi={historyApi} t={t} openActivity={() => { openDrawer('history') }} />
      break
    case 'export':
      page = <ExportView api={api} t={t} />
      break
    case 'import':
      page = <ImportWizardView api={api} t={t} />
      break
    case 'snapshots':
      page = <SnapshotsPanel api={api} t={t} recoveryApi={recoveryApi} recoveryT={recoveryT} />
      break
    case 'sync':
      page = <SyncSettingsView api={syncApi} t={syncT} cmT={t} />
      break
    case 'market':
      page = <MarketPanel api={marketApi} myConfigsApi={myConfigsApi} syncApi={syncApi} importApi={api} t={marketT} cmT={t} />
      break
    case 'profiles':
      page = <ProfilesPanel api={api} t={t} />
      break
    case 'lifecycle':
      // 交叉指引：跳转到「备份」页的恢复子 tab（Phase-5 引导式恢复工作流）。
      // 与全局 SAFE MODE 横幅用的是同一个导航写法，保证行为一致。
      page = (
        <LifecyclePanel
          lifecycleApi={lifecycleApi}
          t={t}
          openRecoveryWizard={() => {
            runStore.patch({ panel: 'snapshots', snapshots: { subTab: 'recovery' } })
          }}
        />
      )
      break
  }

  return (
    // id 同时作为 Radix Modal 的 Portal 容器（见 common/Modal.tsx 的 MODAL_ROOT_ID 说明）：
    // 弹窗必须留在宿主设置弹窗的层叠上下文内，否则会被宿主 overlay(z-index:1000) 盖住而「隐形」。
    <div className={css.section} id={MODAL_ROOT_ID}>
      {/* 顶部导航条：页签 + 图标动作 */}
      <nav className={css.shellNav} aria-label={t('section.label')}>
        <div
          className={css.navStrip}
          role="tablist"
          ref={navRef}
          data-overflow={navOverflow}
          onKeyDown={onTablistKeyDown}
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={panel === item.id}
              data-active={panel === item.id ? '' : undefined}
              className={css.navTab}
              onClick={() => { goto(item.id) }}
            >
              {item.id === 'snapshots' && recoveryRequired && <span className={css.navDot} aria-hidden="true" />}
              {t(item.label as Parameters<TranslateNS<'config-manager'>>[0])}
            </button>
          ))}
        </div>
        <div className={css.navActions}>
          <button
            type="button"
            className={css.ghostButton}
            data-size="sm"
            data-active={drawerOpen && state.more.moreSub === 'history' ? '' : undefined}
            onClick={() => { openDrawer('history') }}
          >
            <ActivityIcon size={13} /> {t('overview.nav.activity')}
          </button>
          <button
            type="button"
            className={css.ghostButton}
            data-size="sm"
            data-active={drawerOpen && state.more.moreSub === 'about' ? '' : undefined}
            onClick={() => { openDrawer('about') }}
          >
            <AboutIcon size={13} /> {t('overview.nav.about')}
          </button>
        </div>
      </nav>

      {/* 全局 SAFE MODE 横幅：有未解决恢复事项时，无论当前页面都提示并引导去处理 */}
      {recoveryRequired && (
        <div style={{ padding: '8px 12px 0' }}>
          <Banner kind="error">
            {recoveryT('recovery.banner')}
            <button
              type="button"
              className={css.ghostButton}
              data-size="sm"
              onClick={() => {
                runStore.patch({ panel: 'snapshots', snapshots: { subTab: 'recovery' } })
              }}
            >
              {recoveryT('recovery.bannerAction')}
            </button>
          </Banner>
        </div>
      )}

      {/* 页面主体（独立滚动） */}
      <main className={css.shellMain}>
        <div className={css.pagePad}>{page}</div>
      </main>

      {/* 底部状态栏：运行状态 + 版本 */}
      <footer className={css.statusBar}>
        <StatusDot kind={statusKind} pulse={runningCount > 0} />
        <span className={css.statusText}>{statusText}</span>
        <span className={css.statusSpacer} />
        {version !== null && (
          <span className={css.statusMeta}>
            {t('shell.version', { plugin: version.pluginVersion, dsh: version.dshVersion })}
          </span>
        )}
      </footer>

      {/* 活动与关于抽屉（右侧滑出；活动记录 / 关于 两个子视图） */}
      {drawerOpen && (
        <>
          <div className={css.drawerMask} onClick={closeDrawer} aria-hidden="true" />
          <aside
            className={css.drawerPanel}
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.drawer.title')}
            onKeyDown={(e) => {
              // Esc 仅在抽屉内消费（阻止冒泡，避免关闭宿主设置弹窗）
              if (e.key === 'Escape') {
                e.stopPropagation()
                closeDrawer()
              }
            }}
          >
            <div className={css.drawerHeader}>
              <span className={css.drawerTitle}>{t('shell.drawer.title')}</span>
              <IconButton icon={<CloseIcon size={14} />} label={t('common.close')} onClick={closeDrawer} />
            </div>
            <div style={{ padding: '10px 14px 0' }}>
              <Segmented
                items={[
                  { id: 'history', label: historyT('view.history') },
                  { id: 'about', label: t('view.about') },
                ]}
                active={state.more.moreSub}
                onChange={(id) => { runStore.patch({ more: { moreSub: id === 'about' ? 'about' : 'history' } }) }}
                ariaLabel={t('shell.drawer.title')}
              />
            </div>
            <div className={css.drawerBody}>
              {state.more.moreSub === 'history'
                ? <HistoryPanel historyApi={historyApi} t={historyT} />
                : <AboutPanel api={api} t={t} />}
            </div>
          </aside>
        </>
      )}

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
