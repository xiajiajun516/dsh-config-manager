/**
 * Config Manager 设置页（settings.section 入口的主页面容器）。
 *
 * 业务面（api）由注册时的 inject face 注入；t 由 locale seat 注入。
 * 关闭按钮由 settings shell 自带，本页不再渲染。内部两个主视图：
 * Export（Quick/Custom）与 Import（九步向导）。
 *
 * m2：主视图 tab（view）与全部子视图状态统一由模块级 runStore 持有
 * （sessionStorage 持久化 + 切 tab/关面板不重建控制器实例）；挂载时
 * 经 GET /runs + 轮询 /progress 恢复进行中的 run（刷新/重开面板后）。
 */
import { useEffect, useSyncExternalStore, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import { runStore, type MainView } from './run-store.ts'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import { SnapshotsPanel } from './snapshots/SnapshotsPanel.tsx'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'settings.section'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

/**
 * 设置页容器：Export / Import / Snapshots / Sync 四视图切换。
 * Export/Import 状态在模块级 store（切 tab 不丢失）；快照恢复与远程同步为低频显式
 * 操作，其状态组件内自持（local state，不进 sessionStorage）。
 */
export function ConfigManagerSection({ api, syncApi, syncT, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const view = state.view
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)

  // m2-resume：挂载时重新订阅进行中的 run（刷新 / 重开面板后服务端继续执行，
  // 这里经 /runs 找回活跃 runId 再轮询 /progress）；卸载时停止轮询，重开再订阅。
  useEffect(() => {
    void runStore.resume(api)
    return () => {
      runStore.stopResume()
    }
  }, [api])

  const setView = (next: MainView): void => {
    setSnapshotsOpen(false)
    setSyncOpen(false)
    runStore.patch({ view: next })
  }

  const openSnapshots = (): void => {
    setSnapshotsOpen(true)
    setSyncOpen(false)
  }

  const openSync = (): void => {
    setSyncOpen(true)
    setSnapshotsOpen(false)
  }

  const activeTab: MainView | 'snapshots' | 'sync' = syncOpen ? 'sync' : snapshotsOpen ? 'snapshots' : view

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
            data-active={snapshotsOpen ? '' : undefined}
            className={css.viewTab}
            onClick={openSnapshots}
          >
            {t('view.snapshots')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sync'}
            data-active={syncOpen ? '' : undefined}
            className={css.viewTab}
            onClick={openSync}
          >
            {t('view.sync')}
          </button>
        </div>
      </div>
      <div className={css.sectionBody}>
        {syncOpen
          ? <SyncSettingsView api={syncApi} t={syncT} />
          : snapshotsOpen
            ? <SnapshotsPanel api={api} t={t} />
            : view === 'export' ? <ExportView api={api} t={t} /> : <ImportWizardView api={api} t={t} />}
      </div>
    </div>
  )
}
