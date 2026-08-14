/**
 * 导出视图（规范 §1 / §21，绑 src/ui/export-flow.ts 的 ExportFlow 控制器）。
 *
 * - Quick：一键导出推荐分区（ExportFlow.quickSelection()）；
 * - Custom：按 §1 分组目录（EXPORT_GROUPS × DEFAULT_CATEGORIES）逐项勾选，
 *   ExportFlow.validateSelection() 给出设备相关分区警告；
 * - Include secrets：可选加密备份（需设置加密密码，密码仅本次内存使用，
 *   经 api.exportPassword 随请求体传给 Host 半，绝不落盘/入 manifest）；
 * - 进度：ExportFlow.run 发出 ProgressEvent → ProgressBar；
 * - 结果：ReportView(export) + 下载按钮（File System Access API 流式落盘）。
 */
import { useCallback, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ExportFlow, DEFAULT_CATEGORIES } from '../../ui/export-flow.ts'
import { EXPORT_GROUPS } from '../../ui/types.ts'
import type { ExportRunResult } from '../../ui/export-flow.ts'
import type { ProgressEvent } from '../../ui/types.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import { Badge, Banner, Button, Card, Checkbox, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import css from '../config-manager.module.css'

export interface ExportViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

type ExportMode = 'quick' | 'custom'

/** Custom 模式的初始勾选 = 推荐分区（可再调整） */
function defaultCustomSelection(): SectionId[] {
  return DEFAULT_CATEGORIES.filter((c) => c.defaultIncluded).map((c) => c.id)
}

/**
 * 导出主视图：Quick/Custom 切换 → 勾选/密码 → 执行 → 进度 → 报告 → 下载。
 */
export function ExportView({ api, t }: ExportViewProps) {
  const [mode, setMode] = useState<ExportMode>('quick')
  const [selection, setSelection] = useState<SectionId[]>(defaultCustomSelection)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [result, setResult] = useState<ExportRunResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [downloaded, setDownloaded] = useState(false)

  // ExportFlow 控制器实例（port=api，onProgress 桥到 React state）
  const [flow] = useState(() => new ExportFlow({
    port: api,
    onProgress: (event) => { setProgress(event) },
  }))

  const toggleSection = useCallback((id: SectionId, checked: boolean) => {
    setSelection((prev) => {
      const has = prev.includes(id)
      if (checked && !has) return [...prev, id]
      if (!checked && has) return prev.filter((s) => s !== id)
      return prev
    })
  }, [])

  const passwordInvalid =
    includeSecrets && (password === '' || password !== passwordConfirm)

  /** 执行导出（Quick 或 Custom） */
  const runExport = async (): Promise<void> => {
    if (passwordInvalid) return
    setRunning(true)
    setError(null)
    setResult(null)
    setDownloaded(false)
    setProgress(null)
    try {
      // 加密密码随本次导出请求体传给 Host 半（仅内存）
      api.exportPassword = includeSecrets ? password : null
      const run = await flow.run(mode, selection, { includeSecrets })
      setResult(run)
    } catch (err) {
      setError(err)
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  /** 下载导出的 ZIP 到本机 */
  const download = async (): Promise<void> => {
    if (result === null) return
    try {
      setError(null)
      const outcome = await api.download(result.zipPath)
      setDownloaded(true)
      void outcome // blob/streamed 由 api 处理；此处仅确认成功
    } catch (err) {
      setError(err)
    }
  }

  // Custom 模式下的设备相关分区警告
  const customWarnings = mode === 'custom' ? flow.validateSelection(selection).warnings : []

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('view.export')} subtitle={t('section.description')} />

      {/* 模式切换 */}
      <div className={css.modeTabs} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'quick'} data-active={mode === 'quick' ? '' : undefined} className={css.modeTab} onClick={() => { setMode('quick') }}>
          {t('export.mode.quick')}
        </button>
        <button type="button" role="tab" aria-selected={mode === 'custom'} data-active={mode === 'custom' ? '' : undefined} className={css.modeTab} onClick={() => { setMode('custom') }}>
          {t('export.mode.custom')}
        </button>
      </div>
      <div className={css.modeHint}>
        {mode === 'quick' ? t('export.mode.quickHint') : t('export.mode.customHint')}
      </div>

      {/* Custom：分组勾选目录 */}
      {mode === 'custom' && (
        <div className={css.groupList}>
          {EXPORT_GROUPS.map((group) => {
            const categories = flow.categories.filter((c) => c.group === group.id)
            if (categories.length === 0) return null
            return (
              <Card key={group.id} className={css.groupCard}>
                <div className={css.groupHeader}>
                  <span className={css.groupLabel}>{group.label}</span>
                  {group.note !== undefined && <span className={css.groupNote}>{group.note}</span>}
                </div>
                <div className={css.groupItems}>
                  {categories.map((cat) => (
                    <Checkbox
                      key={cat.id}
                      checked={selection.includes(cat.id)}
                      onChange={(checked) => { toggleSection(cat.id, checked) }}
                      label={
                        <span className={css.categoryItem}>
                          <span className={css.categoryName}>{cat.label}</span>
                          <span className={css.categoryDesc}>{cat.description}</span>
                          {cat.portability !== 'portable' && (
                            <Badge kind={cat.portability === 'deviceSpecific' ? 'warn' : 'info'}>{cat.portability}</Badge>
                          )}
                          {cat.sensitive === true && <Badge kind="warn">secret</Badge>}
                        </span>
                      }
                    />
                  ))}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* 设备相关分区警告 */}
      {customWarnings.length > 0 && (
        <Banner kind="warn">
          {t('export.selectionWarnings')}
          <ul className={css.warnList}>
            {customWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Banner>
      )}

      {/* 加密备份选项 */}
      <Card className={css.optionsCard}>
        <Checkbox
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          label={<span className={css.categoryName}>{t('export.includeSecrets')}</span>}
        />
        <div className={css.hint}>{t('export.includeSecretsHint')}</div>
        {includeSecrets && (
          <div className={css.secretFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('export.password')}</span>
              <input type="password" className={css.input} value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value) }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('export.passwordConfirm')}</span>
              <input type="password" className={css.input} value={passwordConfirm} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPasswordConfirm(e.target.value) }} />
            </label>
            {password !== '' && password !== passwordConfirm && (
              <span className={css.formError}>{t('export.passwordMismatch')}</span>
            )}
            {password === '' && includeSecrets && (
              <span className={css.formError}>{t('export.passwordRequired')}</span>
            )}
          </div>
        )}
      </Card>

      {/* 执行 */}
      <div className={css.actionRow}>
        <Button variant="primary" disabled={running || passwordInvalid} onClick={() => { void runExport() }}>
          {running ? <Spinner label={t('export.running')} /> : t('export.run')}
        </Button>
      </div>

      {running && <ProgressBar event={progress} active />}

      {error !== null && (
        <ErrorBanner error={error} onRetry={() => { void runExport() }} retrying={running} />
      )}

      {result !== null && !running && (
        <>
          <ReportView kind="export" exportReport={result.report} onDownload={() => { void download() }} />
          {downloaded && <Banner kind="ok">Saved: {result.report.file.name}</Banner>}
        </>
      )}
    </div>
  )
}
