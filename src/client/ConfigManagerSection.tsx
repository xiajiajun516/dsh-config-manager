/**
 * Config Manager 设置页（settings.section 入口的主页面容器）。
 *
 * 业务面（api/syncApi/marketApi）由注册时的 inject face 注入；t 由 locale seat 注入。
 * 关闭按钮由 settings shell 自带，本页不再渲染。内部主视图：
 * 「导出与导入」一个顶层 tab（子 tab 切换 Export 导出备份 / Import 导入恢复），
 * 以及备份与快照/远程同步/配置市场/配置文件/关于 低频面板。
 *
 * m2：主视图 tab（view）与全部子视图状态统一由模块级 runStore 持有
 * （sessionStorage 持久化 + 切 tab/关面板不重建控制器实例）；挂载时
 * 经 GET /runs + 轮询 /progress 恢复进行中的 run（刷新/重开面板后）。
 * 低频面板的「当前打开面板」（panel）同样存于 runStore：切 tab 不丢、
 * 刷新后回到原 tab；面板内部状态由各自视图镜像进 store（见各视图头部注释）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import { runStore, type MainView, type PanelId } from './run-store.ts'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import { SnapshotsPanel } from './snapshots/SnapshotsPanel.tsx'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { MarketPanel } from './market/MarketPanel.tsx'
import { AboutPanel } from './about/AboutPanel.tsx'
import { ProfilesPanel } from './profiles/ProfilesPanel.tsx'
import { RecoveryPanel } from './recovery/RecoveryPanel.tsx'
import { HistoryPanel } from './history/HistoryPanel.tsx'
import { ConfirmDialog } from './common/ConfirmDialog.tsx'
import { evaluateStarPrompt } from '../ui/star-prompt.ts'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'settings.section'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

/**
 * 设置页容器：「导出与导入」主视图（子 tab：导出备份 / 导入恢复）+ Snapshots /
 * Sync / Market / Profiles / About 五块低频面板。所有 tab（主视图 view + 低频
 * 面板 panel）状态都在模块级 store（切 tab/刷新不丢）；面板内部状态由各视图
 * 镜像进 store（Sync/Market/Snapshots/Profiles），敏感字段白名单剔除。
 */
export function ConfigManagerSection({ api, syncApi, syncT, marketApi, myConfigsApi, marketT, recoveryApi, recoveryT, historyApi, historyT, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const view = state.view
  const panel = state.panel

  // m-star-prompt：Star 引导弹窗（挂载时判定一次，方案 A：满 3 天 + 未表态才弹；
  // 点过「去点 Star」或「不再提示」后永久不再弹）。状态存 ui-prefs.json（Host 侧）。
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

  /** 去点 Star（方案 A）：打开仓库页 + 记 clicked（此后不再弹）。 */
  const handleStar = (): void => {
    setStarPromptOpen(false)
    const url = starRepoUrl.current
    if (url !== '') {
      // 与 AboutPanel 外链同模式：新标签页打开，noreferrer 不外泄来源
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      anchor.click()
    }
    // 记「引导完成」失败静默：最坏情况下次进入再弹一次
    void api.saveStarPrompt({ clicked: true }).catch(() => {})
  }

  /** 不再提示：关闭弹窗 + 记 dismissed（永久不再弹）。 */
  const handleDismiss = (): void => {
    setStarPromptOpen(false)
    void api.saveStarPrompt({ dismissed: true }).catch(() => {})
  }

  /** 遮罩点击 / Esc：只是暂时关闭，不记「不再提示」表态（下次进入再判）。 */
  const handleBackdropClose = (): void => {
    setStarPromptOpen(false)
  }

  // m2-resume：挂载时重新订阅进行中的 run（刷新 / 重开面板后服务端继续执行，
  // 这里经 /runs 找回活跃 runId 再轮询 /progress）；卸载时停止轮询，重开再订阅。
  useEffect(() => {
    void runStore.resume(api)
    return () => {
      runStore.stopResume()
    }
  }, [api])

  /** 切到主视图（导出与导入）：清空低频面板，记录到 store（刷新恢复）。 */
  const setView = (next: MainView): void => {
    runStore.patch({ view: next, panel: null })
  }

  /** 打开低频面板（snapshots/sync/market/profiles/about）：记录到 store（刷新恢复）。 */
  const openPanel = (next: PanelId): void => {
    runStore.patch({ panel: next })
  }

  /** 顶层 tab：主视图「导出与导入」激活 = panel 为空（view 是内部子 tab 状态） */
  const transferActive = panel === null

  return (
    <div className={css.section}>
      <div className={css.sectionHeader}>
        <div className={css.viewTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={transferActive}
            data-active={transferActive ? '' : undefined}
            className={css.viewTab}
            onClick={() => { setView(view) }}
          >
            {t('view.transfer')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'snapshots'}
            data-active={panel === 'snapshots' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('snapshots') }}
          >
            {t('view.snapshots')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'sync'}
            data-active={panel === 'sync' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('sync') }}
          >
            {t('view.sync')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'market'}
            data-active={panel === 'market' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('market') }}
          >
            {t('view.market')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'profiles'}
            data-active={panel === 'profiles' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('profiles') }}
          >
            {t('view.profiles')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'about'}
            data-active={panel === 'about' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('about') }}
          >
            {t('view.about')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'recovery'}
            data-active={panel === 'recovery' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('recovery') }}
          >
            {recoveryT('view.recovery')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'history'}
            data-active={panel === 'history' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('history') }}
          >
            {historyT('view.history')}
          </button>
        </div>
      </div>
      <div className={css.sectionBody}>
        {panel === 'history'
          ? <HistoryPanel historyApi={historyApi} t={historyT} />
          : panel === 'recovery'
          ? <RecoveryPanel recoveryApi={recoveryApi} t={recoveryT} />
          : panel === 'about'
          ? <AboutPanel api={api} t={t} />
          : panel === 'profiles'
            ? <ProfilesPanel api={api} t={t} />
            : panel === 'market'
              ? <MarketPanel api={marketApi} myConfigsApi={myConfigsApi} syncApi={syncApi} importApi={api} t={marketT} />
            : panel === 'sync'
              ? <SyncSettingsView api={syncApi} t={syncT} />
              : panel === 'snapshots'
                ? <SnapshotsPanel api={api} t={t} />
                : (
                  <>
                    {/* 「导出与导入」内部子 tab：导出备份 / 导入恢复（状态 = view，切 tab/刷新不丢） */}
                    <div className={css.modeTabs} role="tablist">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'export'}
                        data-active={view === 'export' ? '' : undefined}
                        className={css.modeTab}
                        onClick={() => { setView('export') }}
                      >
                        {t('view.export')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'import'}
                        data-active={view === 'import' ? '' : undefined}
                        className={css.modeTab}
                        onClick={() => { setView('import') }}
                      >
                        {t('view.import')}
                      </button>
                    </div>
                    {view === 'export' ? <ExportView api={api} t={t} /> : <ImportWizardView api={api} t={t} />}
                  </>
                )}
      </div>
      {/* Star 引导弹窗（复用 ConfirmDialog；「去点 Star」= primary 主操作，
          「不再提示」= 次按钮；遮罩/Esc 走 backdropClose 只关不算表态） */}
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
    </div>
  )
}
