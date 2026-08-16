/**
 * 导出视图（规范 §1 / §21，绑 src/ui/export-flow.ts 的 ExportFlow 控制器）。
 *
 * - Quick：一键导出推荐分区（ExportFlow.quickSelection()）；
 * - Custom：按 §1 分组目录（EXPORT_GROUPS × DEFAULT_CATEGORIES）逐项勾选，
 *   ExportFlow.validateSelection() 给出设备相关分区警告；
 * - Include secrets：可选加密备份（需设置加密密码，密码仅本次内存使用，
 *   经 api.exportPassword 随请求体传给 Host 半，绝不落盘/入 manifest，
 *   **也绝不进入 sessionStorage** —— m2 白名单剔除，刷新后要求重输）；
 * - 进度：ExportFlow.run 发出 ProgressEvent → ProgressBar；
 * - 结果：ReportView(export) + 下载按钮（File System Access API 流式落盘）。
 *
 * m2：全部 UI 状态由模块级 runStore 持有（切 tab/关面板不重建、刷新恢复），
 * 控制器实例（ExportFlow）由 store 缓存复用。
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { EXPORT_GROUPS } from '../../ui/types.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import { runStore, type ExportMode } from '../run-store.ts'
import { Badge, Banner, Button, Card, Checkbox, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import css from '../config-manager.module.css'

export interface ExportViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

/**
 * 导出主视图：Quick/Custom 切换 → 勾选/密码 → 执行 → 进度 → 报告 → 下载。
 */
export function ExportView({ api, t }: ExportViewProps) {
  // m2：状态统一来自模块级 store（sessionStorage 持久化；切 tab 不重建）
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const exp = state.export
  // 控制器实例由 store 缓存复用（切 tab / 关面板不重建）
  const flow = runStore.exportFlow(api)

  const mode = exp.mode
  const selection = exp.selection
  const includeSecrets = exp.includeSecrets
  // 密码字段仅内存（store 的敏感字段，绝不序列化进 sessionStorage）
  const password = exp.password
  const passwordConfirm = exp.passwordConfirm
  const running = exp.running
  const progress = exp.progress
  const result = exp.result
  const error = exp.error
  const downloaded = exp.downloaded

  const setMode = (next: ExportMode): void => {
    runStore.patch({ export: { mode: next } })
  }
  const setIncludeSecrets = (next: boolean): void => {
    runStore.patch({ export: { includeSecrets: next } })
  }
  const setPassword = (value: string): void => {
    runStore.patch({ export: { password: value } })
  }
  const setPasswordConfirm = (value: string): void => {
    runStore.patch({ export: { passwordConfirm: value } })
  }

  const toggleSection = useCallback((id: SectionId, checked: boolean): void => {
    const has = selection.includes(id)
    if (checked && !has) runStore.patch({ export: { selection: [...selection, id] } })
    if (!checked && has) runStore.patch({ export: { selection: selection.filter((s) => s !== id) } })
  }, [selection])

  const passwordInvalid =
    includeSecrets && (password === '' || password !== passwordConfirm)

  /** 执行导出（Quick 或 Custom） */
  const runExport = async (): Promise<void> => {
    if (passwordInvalid) return
    runStore.patch({
      export: { running: true, error: null, result: null, downloaded: false, progress: null, runId: null },
    })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('export', 500)
    try {
      // 加密密码随本次导出请求体传给 Host 半（仅内存）
      api.exportPassword = includeSecrets ? password : null
      const run = await flow.run(mode, selection, { includeSecrets })
      // ExportResponse 携带 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (run as { runId?: unknown }).runId
      runStore.patch({
        export: {
          result: run,
          runId: typeof runId === 'string' ? runId : null,
          progress: { stage: 'done', step: 1, total: 1 },
        },
      })
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
    } finally {
      runStore.stopRunWatch('export')
      runStore.patch({ export: { running: false } })
    }
  }

  /** 下载导出的 ZIP 到本机 */
  const download = async (): Promise<void> => {
    if (result === null) return
    try {
      runStore.patch({ export: { error: null } })
      const outcome = await api.download(result.zipPath)
      runStore.patch({ export: { downloaded: true } })
      void outcome // blob/streamed 由 api 处理；此处仅确认成功
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
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
