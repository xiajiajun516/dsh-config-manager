/**
 * 导出视图（规范 §1 / §21，绑 src/ui/export-flow.ts 的 ExportFlow 控制器）。
 *
 * - Quick：一键导出推荐分区（ExportFlow.quickSelection()）；
 * - Custom：按 §1 分组目录（EXPORT_GROUPS × DEFAULT_CATEGORIES）逐项勾选，
 *   ExportFlow.validateSelection() 给出设备相关分区警告；
 * - 安全选项（两个独立选项）：
 *   - 加密备份：勾选后设置加密密码（AES-256-GCM），备份标记 encrypted、导入需密码；
 *     密码仅本次内存使用，经 api.exportPassword 随请求体传给 Host 半，绝不落盘/入
 *     manifest，**也绝不进入 sessionStorage** —— m2 白名单剔除，刷新后要求重输；
 *   - 导出密钥：把真实凭据值写入备份；勾选时自动联动选中加密（密钥绝不明文存储），
 *     取消加密会一并取消导出密钥（core 安全不变量 includeSecrets ⇒ encryption）。
 * - 进度：ExportFlow.run 发出 ProgressEvent → ProgressBar；
 * - 结果：ReportView(export) + 下载按钮（File System Access API 流式落盘）。
 *
 * m2：全部 UI 状态由模块级 runStore 持有（切 tab/关面板不重建、刷新恢复），
 * 控制器实例（ExportFlow）由 store 缓存复用。
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { EXPORT_GROUPS } from '../../ui/types.ts'
import { normalizeExportFileName } from '../../ui/export-flow.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi, ExportPreviewResponse } from '../api.ts'
import { runStore, type ExportMode } from '../run-store.ts'
import { formatBytes } from '../../ui/report.ts'
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
  const encrypt = exp.encrypt
  /** P0-④：自定义导出文件名（.zip；空 = 宿主自动命名；仅表单非敏感字段） */
  const fileName = exp.fileName
  /** P0-④：导出备注（写入备份列表显示；非敏感） */
  const note = exp.note
  // 密码字段仅内存（store 的敏感字段，绝不序列化进 sessionStorage）
  const password = exp.password
  const passwordConfirm = exp.passwordConfirm
  const running = exp.running
  const progress = exp.progress
  const result = exp.result
  const error = exp.error
  const downloaded = exp.downloaded
  /** 下载进行中（瞬态 UI：下载通常数秒，切 tab 后由 api 层继续，切回显示完成态） */
  const [downloading, setDownloading] = useState(false)
  /** 下载防重入 ref（导出完成自动下载 + 用户手动下载共享；避免双击并发下载同一文件） */
  const downloadingRef = useRef(false)
  /** P2-⑫：导出前预览（null = 未请求；进行中/结果/错误） */
  const [preview, setPreview] = useState<{
    loading: boolean
    result: ExportPreviewResponse | null
    error: string | null
  } | null>(null)

  /** P2-⑫：请求导出前预览（不落盘；按当前模式的分区选择） */
  const runPreview = async (): Promise<void> => {
    if (running) return
    setPreview({ loading: true, result: null, error: null })
    try {
      const only = mode === 'quick' ? flow.quickSelection() : [...selection]
      const result = await api.exportPreview(only)
      setPreview({ loading: false, result, error: null })
    } catch (err) {
      setPreview({ loading: false, result: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const setMode = (next: ExportMode): void => {
    runStore.patch({ export: { mode: next } })
  }
  const setIncludeSecrets = (next: boolean): void => {
    // 导出密钥联动加密：勾选导出密钥时默认同时选中加密（密钥绝不明文存储）
    runStore.patch({ export: { includeSecrets: next, encrypt: next ? true : exp.encrypt } })
  }
  const setEncrypt = (next: boolean): void => {
    // 取消加密时若仍勾选着导出密钥 → 一并取消（密钥必须以加密形式备份，安全底线）
    runStore.patch({ export: { encrypt: next, includeSecrets: next ? includeSecrets : false } })
  }
  const setPassword = (value: string): void => {
    runStore.patch({ export: { password: value } })
  }
  const setPasswordConfirm = (value: string): void => {
    runStore.patch({ export: { passwordConfirm: value } })
  }
  const setFileName = (value: string): void => {
    runStore.patch({ export: { fileName: value } })
  }
  const setNote = (value: string): void => {
    runStore.patch({ export: { note: value } })
  }

  const toggleSection = useCallback((id: SectionId, checked: boolean): void => {
    const has = selection.includes(id)
    if (checked && !has) runStore.patch({ export: { selection: [...selection, id] } })
    if (!checked && has) runStore.patch({ export: { selection: selection.filter((s) => s !== id) } })
  }, [selection])

  const passwordInvalid =
    encrypt && (password === '' || password !== passwordConfirm)

  /** 自定义文件名合法性（P0-④）：留空合法（自动命名）；非空必须合法文件名。
   *  无需手动输入 .zip 后缀 —— 校验只针对「去 .zip 后缀后的基础名」，
   *  提交时经 normalizeExportFileName 自动补全 .zip（host 端 isValidExportFileName 仍兜底）。 */
  const trimmedName = fileName.trim()
  const baseName = trimmedName.replace(/\.zip$/i, '')
  const fileNameInvalid = trimmedName !== '' && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(baseName)

  /** 执行导出（Quick 或 Custom）；成功后自动下载到浏览器「下载」目录 */
  const runExport = async (): Promise<void> => {
    if (passwordInvalid || fileNameInvalid) return
    runStore.patch({
      export: { running: true, error: null, result: null, downloaded: false, progress: null, runId: null },
    })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('export', 500)
    try {
      // 加密密码随本次导出请求体传给 Host 半（仅内存）
      api.exportPassword = encrypt ? password : null
      // includeSecrets 只表示「导出密钥」；安全上密钥必须以加密形式备份，
      // UI 联动保证 includeSecrets ⇒ encrypt，这里再兜底一次
      const run = await flow.run(mode, selection, {
        includeSecrets: includeSecrets && encrypt,
        // P0-④：自定义文件名（trim 后为空 = 自动命名；自动补全 .zip 后缀）+ 备注
        fileName: normalizeExportFileName(fileName),
        note: note.trim(),
      })
      // ExportResponse 携带 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (run as { runId?: unknown }).runId
      runStore.patch({
        export: {
          result: run,
          runId: typeof runId === 'string' ? runId : null,
          progress: { stage: 'done', step: 1, total: 1 },
        },
      })
      // 导出完成即自动下载到浏览器「下载」目录，无需用户再点 Download 按钮
      await download(run.zipPath)
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
    } finally {
      runStore.stopRunWatch('export')
      runStore.patch({ export: { running: false } })
    }
  }

  /** 把导出的 ZIP 下载到浏览器「下载」目录（默认静默下载，不弹另存为对话框）。
   *  防重入：downloadingRef 作锁，进行中忽略重复点击/自动触发；失败后恢复可重试。 */
  const download = async (zipPath: string): Promise<void> => {
    if (zipPath === '' || downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)
    try {
      runStore.patch({ export: { error: null } })
      const outcome = await api.download(zipPath)
      runStore.patch({ export: { downloaded: true } })
      void outcome // blob/streamed 由 api 处理；此处仅确认成功
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
    } finally {
      downloadingRef.current = false
      setDownloading(false)
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

      {/* 安全选项：加密备份 / 导出密钥（两个独立选项） */}
      <Card className={css.optionsCard}>
        <span className={css.optionsHeader}>{t('export.security')}</span>
        <Checkbox
          checked={encrypt}
          onChange={setEncrypt}
          label={<span className={css.categoryName}>{t('export.encrypt')}</span>}
        />
        <div className={css.hint}>{t('export.encryptHint')}</div>
        {encrypt && (
          <div className={css.secretFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('export.password')}</span>
              <input type="password" className={css.input} value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value) }} autoComplete="new-password" />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('export.passwordConfirm')}</span>
              <input type="password" className={css.input} value={passwordConfirm} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPasswordConfirm(e.target.value) }} autoComplete="new-password" />
            </label>
            {password !== '' && password !== passwordConfirm && (
              <span className={css.formError}>{t('export.passwordMismatch')}</span>
            )}
            {password === '' && encrypt && (
              <span className={css.formError}>{t('export.passwordRequired')}</span>
            )}
          </div>
        )}
        <Checkbox
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          label={<span className={css.categoryName}>{t('export.includeSecrets')}</span>}
        />
        <div className={css.hint}>{t('export.includeSecretsHint')}</div>
      </Card>

      {/* P0-④：自定义文件名 + 备注（可选）—— 缺省自动命名；文件名安全校验与 host 一致 */}
      <Card className={css.optionsCard}>
        <span className={css.optionsHeader}>{t('export.naming')}</span>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('export.fileName')}</span>
          <input
            type="text"
            className={css.input}
            value={fileName}
            placeholder="dsh-config-2026-08-24"
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setFileName(e.target.value) }}
            onBlur={() => {
              // 失焦自动补全 .zip 后缀（无需用户手动输入）——空值保持空（宿主自动命名）
              if (fileName.trim() !== '') setFileName(normalizeExportFileName(fileName))
            }}
          />
          <span className={css.hint}>{t('export.fileNameHint')}</span>
          {fileNameInvalid && <span className={css.formError}>{t('export.fileNameInvalid')}</span>}
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('export.note')}</span>
          <input
            type="text"
            className={css.input}
            value={note}
            placeholder={t('export.notePlaceholder')}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setNote(e.target.value) }}
          />
          <span className={css.hint}>{t('export.noteHint')}</span>
        </label>
      </Card>

      {/* 执行 */}
      <div className={css.actionRow}>
        <Button variant="ghost" disabled={running} onClick={() => { void runPreview() }}>
          {preview?.loading === true ? <Spinner label={t('export.previewing')} /> : t('export.preview')}
        </Button>
        <Button variant="primary" disabled={running || passwordInvalid || fileNameInvalid} onClick={() => { void runExport() }}>
          {running ? <Spinner label={t('export.running')} /> : t('export.run')}
        </Button>
      </div>

      {/* P2-⑫：导出前预览结果（「将打包 X 分区 / Y 条目 / 约 Z 大小」；零写入） */}
      {preview !== null && !preview.loading && (
        <Banner kind={preview.error !== null ? 'error' : 'info'}>
          {preview.error !== null
            ? preview.error
            : preview.result !== null && (
              <span>
                {t('export.previewSummary', {
                  sections: String(preview.result.totalSections),
                  size: formatBytes(preview.result.totalSizeBytes),
                })}
                {preview.result.sectionsFailed > 0 && ` · ${t('export.previewSkipped', { count: String(preview.result.sectionsFailed) })}`}
              </span>
            )}
        </Banner>
      )}

      {running && <ProgressBar event={progress} active />}

      {error !== null && (
        <ErrorBanner error={error} onRetry={() => { void runExport() }} retrying={running} t={api.t} />
      )}

      {result !== null && !running && (
        <>
          <ReportView kind="export" exportReport={result.report} onDownload={() => { void download(result.zipPath) }} downloadBusy={downloading} t={api.t} />
          {downloaded && <Banner kind="ok">{t('export.saved', { name: result.report.file.name })}</Banner>}
        </>
      )}
    </div>
  )
}
