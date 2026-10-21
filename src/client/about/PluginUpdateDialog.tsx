/**
 * PluginUpdateDialog —— 「检测到新版本 → 立即更新」弹窗。
 *
 * 数据流：
 *  - 打开时拉 GitHub Releases 第一页，取目标版本的 release 正文（纯文本安全渲染，见 ReleaseBody）；
 *  - 「立即更新」调用宿主 POST /update-apply（官方 dsh plugin 通道，**钉住精确版本**）；
 *  - 成功后弹窗**保持打开**并提示「请重启 DSH 生效」—— 更新只换了磁盘上的文件，正在运行的进程
 *    仍是旧版；既不假装已生效，也**绝不自动重启**用户的 DSH。
 *
 * 边界：
 *  - 更新进行中 busy：请求在途时禁用 Esc/遮罩/关闭按钮，避免用户以为没在更新；
 *  - release 拉取失败**不阻塞更新**（GitHub 限流 / 离线时仍可更新）——只影响说明展示；
 *  - 失败码 → 本地化文案（plugin-update-view.ts），未知码回落宿主原始文本，渲染前过 redact()。
 */
import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import { Banner, Button } from '../common/ui.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { Modal } from '../common/Modal.tsx'
import { redact } from '../../security/redaction.ts'
import { ABOUT_META } from './about-view.ts'
import { deriveReleasesUrl, fetchReleases, findReleaseForVersion, type FormattedRelease } from './release-notes-view.ts'
import { ReleaseBody } from './ReleaseBody.tsx'
import { updateFailureKey } from './plugin-update-view.ts'
import css from '../config-manager.module.css'

export interface PluginUpdateDialogProps {
  open: boolean
  /** 当前运行版本 */
  current: string
  /** 目标版本（update-check 的 latest） */
  latest: string
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  onClose: () => void
  /** 安装成功回调（父组件据此展示「已更新到 vX，重启后生效」） */
  onUpdated?: (version: string) => void
  /** release 来源仓库（缺省 = 插件官方仓库；便于测试注入） */
  repoUrl?: string
}

/** 更新说明的拉取状态 */
type NotesState =
  | { kind: 'loading' }
  | { kind: 'loaded'; release: FormattedRelease | null; exact: boolean }
  | { kind: 'failed'; error: string }

/** 「立即更新」的执行状态 */
type ApplyState =
  | { kind: 'idle' }
  | { kind: 'applying' }
  | { kind: 'done'; version: string }
  | { kind: 'failed'; message: string }

const PAGE_SIZE = 10

export function PluginUpdateDialog({
  open,
  current,
  latest,
  api,
  t,
  onClose,
  onUpdated,
  repoUrl = ABOUT_META.repoUrl,
}: PluginUpdateDialogProps) {
  const [notes, setNotes] = useState<NotesState>({ kind: 'loading' })
  const [apply, setApply] = useState<ApplyState>({ kind: 'idle' })

  // 打开（或目标版本变化）时重置状态并拉取该版本的 release 正文
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setNotes({ kind: 'loading' })
    setApply({ kind: 'idle' })
    void (async () => {
      try {
        const result = await fetchReleases(repoUrl, 1, PAGE_SIZE, globalThis.fetch, t)
        if (cancelled) return
        const match = findReleaseForVersion(result.releases, latest)
        setNotes({ kind: 'loaded', release: match.release, exact: match.exact })
      } catch (err) {
        if (cancelled) return
        setNotes({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [open, latest, repoUrl])

  const runApply = useCallback((): void => {
    setApply({ kind: 'applying' })
    api.applyUpdate(latest).then(
      (result) => {
        if (result.ok) {
          setApply({ kind: 'done', version: result.version })
          onUpdated?.(result.version)
          return
        }
        const key = updateFailureKey(result.code)
        setApply({ kind: 'failed', message: key !== null ? t(key, { error: result.error }) : result.error })
      },
      (err) => {
        setApply({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      },
    )
  }, [api, latest, onUpdated, t])

  const applying = apply.kind === 'applying'
  const done = apply.kind === 'done'
  const releasesPageUrl = deriveReleasesUrl(repoUrl)
  const title = t('about.update.dialog.title', { version: latest })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      busy={applying}
      cardStyle={{ width: 'min(640px, 100%)', maxHeight: '85vh' }}
    >
      <Modal.Header title={title} closeLabel={t('common.close')} onClose={onClose} closeDisabled={applying} />

      <Modal.Body scroll style={{ maxHeight: '60vh' }}>
        {/* 版本行：当前 → 目标 */}
        <div className={css.updateVersionRow}>
          <span className={css.hint}>{t('about.update.dialog.from', { current })}</span>
          <span className={css.updateVersionArrow} aria-hidden="true">→</span>
          <span className={css.updateVersionTarget}>{latest}</span>
        </div>

        {notes.kind === 'loading' && (
          <div className={css.updateNotesLoading}>
            {/* 更新说明是**正文块**（多段文字）：按行铺骨架，读完再决定要不要装 */}
            <Skeleton shape="line" count={6} label={t('about.update.dialog.loadingNotes')} />
          </div>
        )}

        {notes.kind === 'failed' && (
          <div>
            <Banner kind="warn">{t('about.update.dialog.notesFailed', { error: redact(notes.error) })}</Banner>
            <div className={css.actionRow}>
              <Button href={releasesPageUrl}>{t('about.update.dialog.viewOnGithub')}</Button>
            </div>
          </div>
        )}

        {notes.kind === 'loaded' && notes.release === null && (
          <Banner kind="info">{t('about.update.dialog.noNotes', { version: latest })}</Banner>
        )}

        {notes.kind === 'loaded' && notes.release !== null && (
          <>
            {!notes.exact && <Banner kind="warn">{t('about.update.dialog.notExact', { version: latest })}</Banner>}
            <ReleaseBody body={notes.release.body} t={t} />
            <div className={css.actionRow}>
              <Button href={notes.release.url}>{t('about.update.dialog.viewReleaseOnGithub')}</Button>
              <Button href={releasesPageUrl}>{t('about.update.dialog.viewOnGithub')}</Button>
            </div>
          </>
        )}

        {apply.kind === 'failed' && <Banner kind="error">{redact(apply.message)}</Banner>}

        {done && (
          <div>
            <Banner kind="ok">{t('about.update.dialog.done', { version: apply.version })}</Banner>
            <div className={css.hint}>{t('about.update.dialog.restart')}</div>
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        {done ? (
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        ) : applying ? (
          <Button variant="primary" loading disabled>{t('about.update.dialog.installing')}</Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={runApply}>{t('about.update.dialog.install')}</Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  )
}
