/**
 * 检查点卡（环境 → 维护与诊断 → 「检查点」）—— G-30 的界面接线。
 *
 * 它做什么：把宿主已交付的 checkpoint 能力（会话 / 工作区 / 插件配置「三态同点」捕获 + 单命令回滚）
 * 变成用户点得到的东西。此前宿主侧完整可用（引擎 + 7 条子路径 + 23 条测试），但 `src/client/**` 零消费者 ——
 * 能力对用户**不存在**。
 *
 * 三条不假装：
 *  ① 端口是 Partial：宿主版本旧 / 方法缺失时如实说「当前宿主没有 checkpoint 能力」，不渲染假按钮；
 *  ② 存储栈不可用（storage.available=false）时按结构化 guidance 如实说明，列表仍可看（宿主侧只有
 *     rewind/delete 被拦，列表/预览只读）；
 *  ③ 回滚必须**显式确认**（ConfirmDialog danger → `confirm: true`），三态不全的记录默认禁用回滚，
 *     要显式勾「允许部分」才放行 —— 与宿主侧 fail-closed 确认门一一对应。
 *
 * 业务判定全在 `src/ui/checkpoint-view.ts`（node 可测）；本组件只做装配与交互状态。
 */
import { useEffect, useRef, useState } from 'react'
import type { RecoveryPort } from '../../ui/types.ts'
import type { TranslateNS } from '../client-types.ts'
import type { SessionHealthResponse } from '../../ui/session-inventory-view.ts'
import {
  checkpointChunksFromText,
  checkpointCodeKey,
  checkpointDefaultSegments,
  checkpointGuidanceRows,
  checkpointOutcome,
  checkpointPreviewRows,
  checkpointRewindRows,
  checkpointRows,
  checkpointSamePoint,
  checkpointSessionCwd,
  checkpointSessionOptions,
} from '../../ui/checkpoint-view.ts'
import type {
  CheckpointListResult,
  CheckpointPort,
  CheckpointPreviewResult,
  CheckpointRewindResult,
  CheckpointRowView,
  CheckpointState,
} from '../../ui/checkpoint-view.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import css from '../config-manager.module.css'

export interface CheckpointCardProps {
  /** recovery 端口（checkpoint 方法为 Partial：宿主旧版可能没有这一族）。 */
  recoveryApi: RecoveryPort & Partial<CheckpointPort>
  t: TranslateNS<'config-manager-recovery'>
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function CheckpointCard({ recoveryApi, t }: CheckpointCardProps) {
  /**
   * 动态字典键（机器码 / 段名拼出来的 key）在这里**集中收窄一次** —— 视图模型已保证
   * 未知码回落 unknown 键（不会是裸枚举），因此这一次断言不会渲染出机器码。
   */
  const dyn = (key: string): Parameters<typeof t>[0] => key as Parameters<typeof t>[0]

  const hasApi = recoveryApi.checkpoints !== undefined
    && recoveryApi.checkpointStorage !== undefined
    && recoveryApi.captureCheckpoint !== undefined
    && recoveryApi.previewCheckpoint !== undefined
    && recoveryApi.rewindCheckpoint !== undefined
    && recoveryApi.removeCheckpoint !== undefined

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<CheckpointListResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [chunksText, setChunksText] = useState('')
  const [unitId, setUnitId] = useState('')
  const [note, setNote] = useState('')
  const [protect, setProtect] = useState(false)
  const [sessions, setSessions] = useState<SessionHealthResponse | null>(null)
  const [sessionsState, setSessionsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [target, setTarget] = useState<CheckpointRowView | null>(null)
  const [preview, setPreview] = useState<CheckpointPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [selected, setSelected] = useState<CheckpointState[]>([])
  const [allowPartial, setAllowPartial] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState<CheckpointRewindResult | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CheckpointRowView | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = (): void => {
    if (recoveryApi.checkpoints === undefined) { setStatus('error'); setError(null); return }
    setStatus('loading')
    setError(null)
    recoveryApi.checkpoints().then(
      (res) => { if (mounted.current) { setList(res); setStatus('ready') } },
      (err: unknown) => { if (mounted.current) { setStatus('error'); setError(errText(err)) } },
    )
  }
  // 挂载即拉一次台账（只读）。
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 会话候选**懒加载**：会话体检要扫会话根，不在卡片打开时白扫一遍。 */
  const loadSessions = (): void => {
    if (recoveryApi.sessions === undefined || sessionsState === 'loading') return
    setSessionsState('loading')
    recoveryApi.sessions(200).then(
      (res) => { if (mounted.current) { setSessions(res); setSessionsState('ready') } },
      () => { if (mounted.current) setSessionsState('error') },
    )
  }

  const openCapture = (): void => {
    setActionError(null)
    setCaptureOpen(true)
    if (sessionsState === 'idle') loadSessions()
  }

  const submitCapture = (): void => {
    if (recoveryApi.captureCheckpoint === undefined) return
    setBusy(true)
    setActionError(null)
    recoveryApi.captureCheckpoint({
      chunks: checkpointChunksFromText(chunksText),
      unitId,
      note,
      protect,
    }).then(
      (res) => {
        if (!mounted.current) return
        setBusy(false)
        if (res.ok) {
          toast.ok(t('checkpoint.capture.done'))
          setCaptureOpen(false); setChunksText(''); setUnitId(''); setNote(''); setProtect(false)
          load()
          return
        }
        // 捕获失败：按机器码给本地化原因（未知码回落 unknown），技术细节另起一行
        setActionError(t(dyn(checkpointCodeKey(res.code))) + (res.detail !== undefined && res.detail !== '' ? ' — ' + redact(res.detail) : ''))
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); setActionError(redact(errText(err))) } },
    )
  }

  const openPreview = (row: CheckpointRowView): void => {
    if (recoveryApi.previewCheckpoint === undefined) return
    setTarget(row); setPreview(null); setResult(null); setAllowPartial(false); setSelected([])
    setActionError(null); setPreviewLoading(true)
    recoveryApi.previewCheckpoint(row.id).then(
      (res) => {
        if (!mounted.current) return
        setPreviewLoading(false)
        setPreview(res)
        setSelected(checkpointDefaultSegments(res))
        if (!res.ok) setActionError(t(dyn(checkpointCodeKey(res.code))))
      },
      (err: unknown) => { if (mounted.current) { setPreviewLoading(false); setActionError(redact(errText(err))) } },
    )
  }

  const closePreview = (): void => {
    setTarget(null); setPreview(null); setResult(null); setActionError(null)
  }

  const toggleSegment = (state: CheckpointState): void => {
    setSelected((prev) => (prev.includes(state) ? prev.filter((item) => item !== state) : [...prev, state]))
  }

  const rewind = (): void => {
    if (recoveryApi.rewindCheckpoint === undefined || target === null) return
    setConfirmOpen(false)
    setBusy(true)
    setActionError(null)
    recoveryApi.rewindCheckpoint(target.id, { confirm: true, segments: selected, allowPartial }).then(
      (res) => {
        if (!mounted.current) return
        setBusy(false)
        setResult(res)
        const outcome = checkpointOutcome(res.outcome)
        if (outcome.badgeKind === 'ok') toast.ok(t(dyn(outcome.key)))
        else toast.warn(t(dyn(outcome.key)))
        load()
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); setActionError(redact(errText(err))) } },
    )
  }

  const remove = (): void => {
    if (recoveryApi.removeCheckpoint === undefined || deleteTarget === null) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    setBusy(true)
    setActionError(null)
    recoveryApi.removeCheckpoint(id).then(
      (res) => {
        if (!mounted.current) return
        setBusy(false)
        if (res.ok) { toast.ok(t('checkpoint.delete.done')); load(); return }
        setActionError(t(dyn(checkpointCodeKey(res.code))))
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); setActionError(redact(errText(err))) } },
    )
  }

  const rows = checkpointRows(list)
  const storage = list?.storage ?? null
  const storageGuidance = checkpointGuidanceRows(storage?.guidance)
  const previewRows = checkpointPreviewRows(preview)
  const samePoint = checkpointSamePoint(preview)
  const rewindRows = checkpointRewindRows(result)
  const outcome = result === null ? null : checkpointOutcome(result.outcome)
  const incomplete = preview?.summary?.incomplete === true
  const sessionOptions = checkpointSessionOptions(sessions)
  const cwd = checkpointSessionCwd(sessionOptions, unitId)
  const canRewind = selected.length > 0 && (incomplete !== true || allowPartial)

  return (
    <>
      <Card>
        <SectionTitle title={t('checkpoint.title')} subtitle={t('checkpoint.desc')} />

        {!hasApi && <Banner kind="warn">{t('checkpoint.apiMissing')}</Banner>}

        {/* 存储栈不可用：如实说「现在不能用」，并给出可行动的指引（列表仍可看） */}
        {storage !== null && !storage.available && (
          <>
            <Banner kind="warn">{t('checkpoint.code.storage-unavailable')}</Banner>
            {storageGuidance.map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            <div className={css.hint}>{t('checkpoint.guidance.readOnlyFallback')}</div>
          </>
        )}

        {status === 'loading' && <Spinner label={t('recovery.loading')} />}
        {status === 'error' && (
          <div className={css.actionRow}>
            <Banner kind="error">{error !== null ? redact(error) : t('checkpoint.apiMissing')}</Banner>
            <Button onClick={load}>{t('common.retry')}</Button>
          </div>
        )}

        {status === 'ready' && (
          <>
            <div className={css.actionRow}>
              <Button variant="primary" disabled={!hasApi || busy} onClick={openCapture}>{t('checkpoint.capture')}</Button>
              <span className={css.statusSpacer} />
              <Button disabled={busy} onClick={load}>{t('common.retry')}</Button>
            </div>

            {actionError !== null && <Banner kind="error">{actionError}</Banner>}

            {captureOpen && (
              <div className={css.card}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('checkpoint.capture.chunks')}</span>
                  <textarea
                    className={css.input}
                    value={chunksText}
                    rows={3}
                    disabled={busy}
                    onChange={(e) => { setChunksText(e.target.value) }}
                  />
                </label>
                <div className={css.hint}>{t('checkpoint.capture.hint')}</div>

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('checkpoint.capture.session')}</span>
                  <select
                    className={css.input}
                    value={unitId}
                    disabled={busy || sessionsState === 'loading'}
                    onChange={(e) => { setUnitId(e.target.value) }}
                  >
                    <option value="">{t('checkpoint.capture.sessionNone')}</option>
                    {sessionOptions.map((option) => (
                      <option key={option.unitId} value={option.unitId}>{option.sessionId}</option>
                    ))}
                  </select>
                </label>
                {sessionsState === 'loading' && <div className={css.hint}>{t('checkpoint.sessions.loading')}</div>}
                {sessionsState === 'error' && <div className={css.hint}>{t('checkpoint.sessions.error')}</div>}
                {sessionsState === 'ready' && sessionOptions.length === 0 && <div className={css.hint}>{t('checkpoint.sessions.empty')}</div>}
                {cwd !== null && (
                  <div className={css.actionRow}>
                    <Button disabled={busy} onClick={() => {
                      const current = checkpointChunksFromText(chunksText)
                      setChunksText([...current, cwd].join('\n'))
                    }}>{t('checkpoint.capture.fillCwd')}</Button>
                    <span className={css.hint}>{cwd}</span>
                  </div>
                )}

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('checkpoint.capture.note')}</span>
                  <input className={css.input} type="text" value={note} disabled={busy} onChange={(e) => { setNote(e.target.value) }} />
                </label>
                <Checkbox checked={protect} disabled={busy} onChange={setProtect} label={t('checkpoint.capture.protect')} />

                <div className={css.actionRow}>
                  <Button variant="primary" disabled={busy} loading={busy} onClick={submitCapture}>{t('checkpoint.capture.submit')}</Button>
                  <Button disabled={busy} onClick={() => { setCaptureOpen(false); setActionError(null) }}>{t('common.cancel')}</Button>
                </div>
              </div>
            )}

            {rows.length === 0
              ? <Empty>{t('checkpoint.list.empty')}</Empty>
              : rows.map((row) => (
                <div key={row.id} className={css.actionRow} data-inline>
                  <span className={css.hint}>{new Date(row.createdAtMs).toLocaleString()}</span>
                  <Badge kind={row.kind === 'guard' ? 'info' : 'ok'}>{t(dyn(row.kindKey))}</Badge>
                  {row.tracks.map((track) => (
                    <Badge key={track.state} kind={track.badgeKind}>{t(dyn(track.labelKey))}</Badge>
                  ))}
                  {row.protected && <Badge kind="warn">{t('checkpoint.warn.protected')}</Badge>}
                  {row.incomplete && <Badge kind="warn">{t('checkpoint.badge.incomplete')}</Badge>}
                  <span className={css.hint}>{t('checkpoint.col.spread') + ' ' + String(row.spreadMs) + ' ms'}</span>
                  {row.note !== null && <span className={css.hint} title={row.note}>{row.note}</span>}
                  <span className={css.statusSpacer} />
                  <Button disabled={busy} onClick={() => { openPreview(row) }}>{t('checkpoint.preview')}</Button>
                  <Button variant="danger" disabled={busy || !row.removable} onClick={() => { setDeleteTarget(row) }}>{t('checkpoint.delete')}</Button>
                </div>
              ))}
          </>
        )}
      </Card>

      {/* 预览 / 回滚（同一弹窗：先预览，执行后就地显示逐段结果） */}
      <Modal open={target !== null} onClose={closePreview} title={t('checkpoint.preview')} wide busy={busy}>
        <Modal.Header title={t('checkpoint.preview')} onClose={closePreview} closeLabel={t('common.close')} />
        {previewLoading && <Spinner label={t('recovery.loading')} />}

        {result === null && preview !== null && (
          <>
            {samePoint !== null && (
              <div className={css.actionRow} data-inline>
                <Badge kind={samePoint.key === 'checkpoint.samePoint.yes' ? 'ok' : 'warn'}>
                  {t(dyn(samePoint.key), { ms: samePoint.ms })}
                </Badge>
                <span className={css.hint}>{t(dyn(samePoint.reasonKey))}</span>
              </div>
            )}
            <div className={css.groupLabel}>{t('checkpoint.preview.segments')}</div>
            <div className={css.planScroll}>
              {previewRows.map((segment) => (
                <div key={segment.state} className={css.actionRow} data-inline>
                  <Checkbox
                    checked={selected.includes(segment.state)}
                    disabled={busy || !segment.available}
                    onChange={() => { toggleSegment(segment.state) }}
                    label={t(dyn(segment.labelKey))}
                  />
                  {segment.available ? (
                    <>
                      <span className={css.hint}>{t('checkpoint.preview.planned', { n: segment.planned })}</span>
                      {segment.changed > 0 && <span className={css.hint}>{t('checkpoint.preview.changed', { n: segment.changed })}</span>}
                      {segment.missing > 0 && <span className={css.hint}>{t('checkpoint.preview.missing', { n: segment.missing })}</span>}
                      {segment.leftovers > 0 && (
                        <span className={css.hint}>
                          {t('checkpoint.preview.leftovers', { n: segment.leftovers })}
                          {segment.leftoversTruncated ? ' ' + t('checkpoint.preview.leftoversTruncated') : ''}
                        </span>
                      )}
                      {segment.cursorNow !== null && segment.cursorTarget !== null && (
                        <span className={css.hint}>{t('checkpoint.preview.cursor', { now: segment.cursorNow, target: segment.cursorTarget })}</span>
                      )}
                      {segment.active && <span className={css.hint}>{t('checkpoint.preview.active')}</span>}
                    </>
                  ) : (
                    <span className={css.hint}>{t(dyn(segment.reasonKey ?? ''))}</span>
                  )}
                </div>
              ))}
            </div>
            {incomplete && <Checkbox checked={allowPartial} disabled={busy} onChange={setAllowPartial} label={t('checkpoint.rewind.allowPartial')} />}
            <div className={css.actionRow}>
              <Button variant="danger" disabled={busy || !canRewind} loading={busy} onClick={() => { setConfirmOpen(true) }}>{t('checkpoint.rewind')}</Button>
              <span className={css.statusSpacer} />
              <Button disabled={busy} onClick={closePreview}>{t('common.cancel')}</Button>
            </div>
          </>
        )}

        {result !== null && (
          <>
            <div className={css.groupLabel}>{t('checkpoint.rewind.result.title')}</div>
            {outcome !== null && <Badge kind={outcome.badgeKind}>{t(dyn(outcome.key))}</Badge>}
            {result.guardCheckpointId !== undefined && (
              <div className={css.hint}>{t('checkpoint.rewind.result.guard', { id: result.guardCheckpointId })}</div>
            )}
            <div className={css.reportScroll}>
              {rewindRows.map((segment) => (
                <div key={segment.state} className={css.actionRow} data-inline>
                  <Badge kind={segment.badgeKind}>{t(dyn(segment.labelKey))}</Badge>
                  <span className={css.hint}>{t(dyn(segment.statusKey))}</span>
                  <span className={css.hint}>{t('checkpoint.rewind.result.counts', { restored: segment.restored, failed: segment.failed, leftovers: segment.leftovers })}</span>
                </div>
              ))}
            </div>
            {result.skippedSegments.length > 0 && (
              <div className={css.hint}>{t('checkpoint.rewind.result.skipped', { list: result.skippedSegments.map((state) => t(dyn('checkpoint.state.' + state))).join(' / ') })}</div>
            )}
            {checkpointGuidanceRows(result.warnings).map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            {checkpointGuidanceRows(result.guidance).map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            {actionError !== null && <Banner kind="error">{actionError}</Banner>}
            <div className={css.actionRow}>
              <Button onClick={closePreview}>{t('common.close')}</Button>
            </div>
          </>
        )}
      </Modal>

      {/* 回滚二次确认（破坏性：覆盖工作区 / 配置 / 会话字节） */}
      <ConfirmDialog
        open={confirmOpen}
        title={t('checkpoint.rewind')}
        message={t('checkpoint.rewind.confirm')}
        confirmLabel={t('checkpoint.rewind')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onConfirm={rewind}
        onCancel={() => { setConfirmOpen(false) }}
      />

      {/* 删除确认（只删台账与内容副本，不动工作区 / 会话 / 配置） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('checkpoint.delete.confirmTitle')}
        message={t('checkpoint.delete.confirmMessage')}
        confirmLabel={t('checkpoint.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => { setDeleteTarget(null) }}
      />
    </>
  )
}
