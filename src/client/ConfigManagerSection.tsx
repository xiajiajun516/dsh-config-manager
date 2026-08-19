/**
 * Config Manager 设置页（settings.section 入口的主页面容器）。
 *
 * 业务面（api/syncApi/marketApi）由注册时的 inject face 注入；t 由 locale seat 注入。
 * 关闭按钮由 settings shell 自带，本页不再渲染。内部主视图：
 * Export（Quick/Custom）与 Import（九步向导），以及快照/远程同步/配置市场/关于四块低频面板。
 *
 * m2：主视图 tab（view）与全部子视图状态统一由模块级 runStore 持有
 * （sessionStorage 持久化 + 切 tab/关面板不重建控制器实例）；挂载时
 * 经 GET /runs + 轮询 /progress 恢复进行中的 run（刷新/重开面板后）。
 * 低频面板的「当前打开面板」（panel）同样存于 runStore：切 tab 不丢、
 * 刷新后回到原 tab；面板内部状态由各自视图镜像进 store（见各视图头部注释）。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import { runStore, type MainView, type PanelId } from './run-store.ts'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import { SnapshotsPanel } from './snapshots/SnapshotsPanel.tsx'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { MarketPanel } from './market/MarketPanel.tsx'
import { AboutPanel } from './about/AboutPanel.tsx'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'settings.section'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

/**
 * 设置页容器：Export / Import / Snapshots / Sync / Market / About 六视图切换。
 * 所有 tab（主视图 view + 低频面板 panel）状态都在模块级 store（切 tab/刷新不丢）；
 * 面板内部状态由各视图镜像进 store（Sync/Market/Snapshots），敏感字段白名单剔除。
 */
export function ConfigManagerSection({ api, syncApi, syncT, marketApi, marketT, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const view = state.view
  const panel = state.panel

  // m2-resume：挂载时重新订阅进行中的 run（刷新 / 重开面板后服务端继续执行，
  // 这里经 /runs 找回活跃 runId 再轮询 /progress）；卸载时停止轮询，重开再订阅。
  useEffect(() => {
    void runStore.resume(api)
    return () => {
      runStore.stopResume()
    }
  }, [api])

  /** 切到主视图（export/import）：清空低频面板，记录到 store（刷新恢复）。 */
  const setView = (next: MainView): void => {
    runStore.patch({ view: next, panel: null })
  }

  /** 打开低频面板（snapshots/sync/market/about）：记录到 store（刷新恢复）。 */
  const openPanel = (next: PanelId): void => {
    runStore.patch({ panel: next })
  }

  const activeTab: MainView | PanelId = panel ?? view

  return (
    <div className={css.section}>
      <div className={css.sectionHeader}>
        <div className={css.viewTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'export'}
            data-active={activeTab === 'export' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { setView('export') }}
          >
            {t('view.export')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'import'}
            data-active={activeTab === 'import' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { setView('import') }}
          >
            {t('view.import')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'snapshots'}
            data-active={panel === 'snapshots' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('snapshots') }}
          >
            {t('view.snapshots')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sync'}
            data-active={panel === 'sync' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('sync') }}
          >
            {t('view.sync')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'market'}
            data-active={panel === 'market' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('market') }}
          >
            {t('view.market')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'about'}
            data-active={panel === 'about' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { openPanel('about') }}
          >
            {t('view.about')}
          </button>
        </div>
      </div>
      <div className={css.sectionBody}>
        {panel === 'about'
          ? <AboutPanel api={api} t={t} />
          : panel === 'market'
            ? <MarketPanel api={marketApi} importApi={api} t={marketT} />
            : panel === 'sync'
              ? <SyncSettingsView api={syncApi} t={syncT} />
              : panel === 'snapshots'
                ? <SnapshotsPanel api={api} t={t} />
                : view === 'export' ? <ExportView api={api} t={t} /> : <ImportWizardView api={api} t={t} />}
      </div>
    </div>
  )
}
