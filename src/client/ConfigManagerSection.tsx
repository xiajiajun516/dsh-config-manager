/**
 * Config Manager 设置页（settings.section 入口的主页面容器）。
 *
 * owner props 由 settings shell 传入（close）；业务面（api）由注册时的
 * inject face 注入；t 由 locale seat 注入。内部两个主视图：
 * Export（Quick/Custom）与 Import（九步向导）。
 */
import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import { ExportView } from './export/ExportView.tsx'
import { ImportWizardView } from './import/ImportWizardView.tsx'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'settings.section'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

type MainView = 'export' | 'import'

/**
 * 设置页容器：Export / Import 双视图切换。
 */
export function ConfigManagerSection({ close, api, t }: ConfigManagerSectionProps) {
  const [view, setView] = useState<MainView>('export')

  return (
    <div className={css.section}>
      <div className={css.sectionHeader}>
        <div className={css.viewTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'export'}
            data-active={view === 'export' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { setView('export') }}
          >
            {t('view.export')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'import'}
            data-active={view === 'import' ? '' : undefined}
            className={css.viewTab}
            onClick={() => { setView('import') }}
          >
            {t('view.import')}
          </button>
        </div>
        <button type="button" className={css.iconButton} title={t('common.close')} aria-label={t('common.close')} onClick={close}>×</button>
      </div>
      <div className={css.sectionBody}>
        {view === 'export' ? <ExportView api={api} t={t} /> : <ImportWizardView api={api} t={t} />}
      </div>
    </div>
  )
}
