/**
 * 回滚卡（环境 → 维护与诊断 → 「工作区 + 会话回滚」）—— S1–S7 的界面接线。
 *
 * 它做什么：把宿主已交付的 rollback-points 能力（**每个回合结束自动留点** = 工作区快照 + 会话游标，
 * 回退 = 只覆盖记录在案的工作区路径 + 在目标回合之前的稳定边界 fork 新子会话）变成用户点得到的东西。
 *
 * 四条不假装（与旧检查点卡同源，口径随 S1–S7 改写）：
 *  ① 端口是 Partial：宿主版本旧 / 方法缺失时如实说「当前宿主没有回滚点能力」，不渲染假按钮；
 *  ② 存储栈不可用（storage.available=false）时按结构化 guidance 如实说明，列表仍可看（只读）；
 *  ③ 回退必须**显式二次确认**（ConfirmDialog danger → userConfirmed:true），两态不全的记录默认禁用回退，
 *     要显式勾「允许部分回退」才放行 —— 与宿主侧 fail-closed 确认门一一对应；
 *  ④ 时间线如实展示「文件数 / 是否有会话游标」：没有会话游标的点**只能回退工作区**，
 *     界面绝不暗示它会 fork 一个子会话。
 *
 * 业务判定全在 \`src/ui/rollback-view.ts\`（框架无关、node 可测）；本组件只做装配与交互状态。
 * 禁止组件直接 fetch：一律走 \`RecoveryApi\`（\`RecoveryPort & Partial<RollbackPointPort>\`）。
 */
import { useEffect, useRef, useState } from 'react'
import type { RecoveryPort } from '../../ui/types.ts'
import type { TranslateNS } from '../client-types.ts'
import {
  ROLLBACK_MAX_POINTS_PER_SESSION,
  ROLLBACK_MAX_POINTS_TOTAL,
  ROLLBACK_MODES,
  rollbackChildSession,
  rollbackCodeKey,
  rollbackGuidanceRows,
  rollbackModeAvailable,
  rollbackModeKey,
  rollbackModeSegments,
  rollbackOutcome,
  rollbackPointGroups,
  rollbackPreviewGuidance,
  rollbackPreviewRows,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  rollbackRewindCounts,
  rollbackRewindRows,
  rollbackRowFileCount,
  rollbackRowHasSessionCursor,
  rollbackSkippedSegments,
} from '../../ui/rollback-view.ts'
import type {
  RollbackListResult,
  RollbackMode,
  RollbackPointPort,
  RollbackPointRowView,
  RollbackPreviewResult,
  RollbackRewindResult,
} from '../../ui/rollback-view.ts'
import { redact } from '../../security/redaction.ts'
// T2：聊天内回退入口形态的偏好（**唯一来源** = T1 的 chat-entry-pref）。
// 本组件只调用它的读/写函数：写入走 writeChatEntryMode 才会触发 T1 的热切换（值真变 → dispose → register），
// 因此切换**无需重启、无需刷新**；绝不在此处直接读写 localStorage（那会绕过热切换、并造出第二套通道）。
import {
  CHAT_ENTRY_MODES,
  isChatEntryMode,
  readChatEntryMode,
  writeChatEntryMode,
  type ChatEntryMode,
} from '../chat/chat-entry-pref.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Segmented, Spinner } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import css from '../config-manager.module.css'

export interface RollbackCardProps {
  /** recovery 端口（rollback-points 方法为 Partial：宿主旧版可能没有这一族）。 */
  recoveryApi: RecoveryPort & Partial<RollbackPointPort>
  t: TranslateNS<'config-manager-recovery'>
}

/** 宿主错误文本渲染前统一过 redact（AGENTS.md UI 硬性规则 7）。 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/**
 * T2：两档形态 → 面板文案键（**穷尽映射**：`Record<ChatEntryMode, string>` 让「新增一档却忘了文案」
 * 变成编译错误）。选项本身由偏好模块的 `CHAT_ENTRY_MODES` 派生，本组件不写形态字面量。
 */
const CHAT_ENTRY_LABEL_KEYS: Record<ChatEntryMode, string> = {
  'per-message': 'rollback.chatEntry.perMessage',
  'turn': 'rollback.chatEntry.turn',
}

/** \`ConfigManagerApiError\` 的机器码（宿主在 409/423/404 上回传；缺失即 null）。 */
function apiCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : null
}

export function RollbackCard({ recoveryApi, t }: RollbackCardProps) {
  /** 动态字典键（机器码 / 段名拼出来的 key）在这里**集中收窄一次** —— 视图模型已保证未知码回落 unknown 键。 */
  const dyn = (key: string): Parameters<typeof t>[0] => key as Parameters<typeof t>[0]

  const hasApi = recoveryApi.rollbackPoints !== undefined
    && recoveryApi.rollbackPointStorage !== undefined
    && recoveryApi.rollbackPointPreview !== undefined
    && recoveryApi.restoreRollbackPoint !== undefined
    && recoveryApi.removeRollbackPoint !== undefined

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<RollbackListResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<RollbackPointRowView | null>(null)
  const [preview, setPreview] = useState<RollbackPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [mode, setMode] = useState<RollbackMode>('files+session')
  const [allowPartial, setAllowPartial] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState<RollbackRewindResult | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RollbackPointRowView | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  /**
   * T2：聊天内回退入口形态（每条用户消息 / 整回合）。
   *
   * 当前值**从偏好读取**（缺省 = 每条用户消息，见 T1 的 readChatEntryMode）；写入只走
   * `writeChatEntryMode` —— 它值真变才通知订阅者，T1 的 mountChatNodeEntry 收到即
   * dispose → register，所以切换是**即时**的（无需重启、也无需刷新）。
   *
   * 写失败（storage 不可用 / 配额：storage 本身不写、偏好**没有变**）时**回读真实值**再如实说明
   * 「这次切换没有生效」，绝不把界面留在「显示已切换但实际没切换」的假状态。
   */
  const [chatEntryMode, setChatEntryMode] = useState<ChatEntryMode>(() => readChatEntryMode())
  const [chatEntrySaveFailed, setChatEntrySaveFailed] = useState(false)

  const applyChatEntryMode = (next: string): void => {
    if (!isChatEntryMode(next)) return
    if (writeChatEntryMode(next)) { setChatEntryMode(next); setChatEntrySaveFailed(false); return }
    setChatEntryMode(readChatEntryMode())
    setChatEntrySaveFailed(true)
  }

  const fail = (err: unknown): void => {
    if (!mounted.current) return
    const code = apiCodeOf(err)
    const message = redactErrorText(err)
    setActionError(code === null ? message : t(dyn(rollbackCodeKey(code))) + ' — ' + message)
  }

  const load = (): void => {
    if (recoveryApi.rollbackPoints === undefined) { setStatus('error'); setError(null); return }
    setStatus('loading')
    setError(null)
    recoveryApi.rollbackPoints().then(
      (res) => { if (mounted.current) { setList(res); setStatus('ready') } },
      (err: unknown) => { if (mounted.current) { setStatus('error'); setError(redactErrorText(err)) } },
    )
  }
  // 挂载即拉一次台账（只读）。
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openPreview = (row: RollbackPointRowView): void => {
    if (recoveryApi.rollbackPointPreview === undefined) return
    setTarget(row); setPreview(null); setResult(null); setAllowPartial(false); setActionError(null)
    setPreviewLoading(true)
    recoveryApi.rollbackPointPreview(row.id).then(
      (res) => {
        if (!mounted.current) return
        setPreviewLoading(false)
        setPreview(res)
        // 默认 mode = 按可用段推导（判定在 ui 层，这里只取结果）
        setMode(rollbackPreviewVerdict(res).mode)
        if (!res.ok) setActionError(t(dyn(rollbackCodeKey(res.code))))
      },
      (err: unknown) => { if (mounted.current) { setPreviewLoading(false); fail(err) } },
    )
  }

  const closePreview = (): void => {
    setTarget(null); setPreview(null); setResult(null); setActionError(null)
  }

  const rewind = (): void => {
    if (recoveryApi.restoreRollbackPoint === undefined || target === null) return
    setConfirmOpen(false)
    setBusy(true)
    setActionError(null)
    recoveryApi.restoreRollbackPoint(target.id, {
      // fail-closed：这里恒为 true（用户刚在 danger 弹窗里点过确认），API 侧不自动置真
      userConfirmed: true,
      mode,
      segments: rollbackModeSegments(mode),
      allowPartial,
    }).then(
      (res) => {
        if (!mounted.current) return
        setBusy(false)
        setResult(res)
        const outcome = rollbackOutcome(res.outcome)
        if (outcome.badgeKind === 'ok') toast.ok(t(dyn(outcome.key)))
        else toast.warn(t(dyn(outcome.key)))
        load()
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); fail(err) } },
    )
  }

  const remove = (): void => {
    if (recoveryApi.removeRollbackPoint === undefined || deleteTarget === null) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    setBusy(true)
    setActionError(null)
    recoveryApi.removeRollbackPoint(id, true).then(
      (res) => {
        if (!mounted.current) return
        setBusy(false)
        if (res.ok) { toast.ok(t('rollback.delete.done')); load(); return }
        setActionError(t(dyn(rollbackCodeKey(res.code))))
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); fail(err) } },
    )
  }

  const groups = rollbackPointGroups(list)
  const storage = list?.storage ?? null
  const storageGuidance = rollbackGuidanceRows(storage?.guidance)
  const verdict = rollbackPreviewVerdict(preview)
  const previewRows = rollbackPreviewRows(preview)
  // 点级告警 / 指引：引擎不给「属于哪一段」的键，故在面板级渲染一次（绝不猜归属）
  const previewWarnings = rollbackPreviewWarnings(preview)
  const previewGuidance = rollbackPreviewGuidance(preview)
  const rewindRows = rollbackRewindRows(result)
  const rewindCounts = rollbackRewindCounts(result)
  const outcome = result === null ? null : rollbackOutcome(result.outcome)
  const childSession = rollbackChildSession(result)
  const skipped = rollbackSkippedSegments(result)
  const canRewind = verdict.canRestore && (verdict.incomplete !== true || allowPartial)
  const total = list?.points.length ?? 0

  return (
    <>
      <Card>
        <SectionTitle title={t('rollback.title')} subtitle={t('rollback.desc')} />

        {/* T2：聊天内回退入口形态开关。放在台账之前 = 与列表加载状态无关 ——
            它是「本插件接管 user 渲染器出问题时一键退回回合尾」的保险，读不出台账时也必须能用。 */}
        <div className={css.groupLabel}>{t('rollback.chatEntry.label')}</div>
        <div className={css.actionRow}>
          <Segmented
            ariaLabel={t('rollback.chatEntry.label')}
            active={chatEntryMode}
            items={CHAT_ENTRY_MODES.map((entryMode) => ({
              id: entryMode,
              label: t(dyn(CHAT_ENTRY_LABEL_KEYS[entryMode])),
            }))}
            onChange={applyChatEntryMode}
          />
        </div>
        <div className={css.hint}>{t('rollback.chatEntry.hint')}</div>
        {chatEntrySaveFailed && <Banner kind="warn">{t('rollback.chatEntry.saveFailed')}</Banner>}

        {!hasApi && <Banner kind="warn">{t('rollback.apiMissing')}</Banner>}

        {/* 存储栈不可用：如实说「现在不能用」，并给出可行动的指引（列表仍可看） */}
        {storage !== null && !storage.available && (
          <>
            <Banner kind="warn">{t('rollback.code.storage-unavailable')}</Banner>
            {storageGuidance.map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            <div className={css.hint}>{t('rollback.guidance.readOnlyFallback')}</div>
          </>
        )}

        {status === 'loading' && <Spinner label={t('recovery.loading')} />}
        {status === 'error' && (
          <div className={css.actionRow}>
            <Banner kind="error">{error !== null ? error : t('rollback.apiMissing')}</Banner>
            <Button onClick={load}>{t('common.retry')}</Button>
          </div>
        )}

        {status === 'ready' && (
          <>
            <div className={css.hint}>{t('rollback.autopoint.hint')}</div>
            <div className={css.actionRow}>
              <span className={css.hint}>
                {t('rollback.retention.hint', { perSession: ROLLBACK_MAX_POINTS_PER_SESSION, total: ROLLBACK_MAX_POINTS_TOTAL })}
              </span>
              <span className={css.statusSpacer} />
              <Button disabled={busy} onClick={load}>{t('common.retry')}</Button>
            </div>

            {actionError !== null && <Banner kind="error">{actionError}</Banner>}

            {total === 0
              ? <Empty>{t('rollback.list.empty')}</Empty>
              : (
                <div className={css.snapshotList + ' ' + css.planScroll}>
                  {groups.map((group) => (
                    <div key={group.sessionId ?? '__unknown__'}>
                      <div className={css.groupLabel}>
                        {t('rollback.group.label', { session: group.sessionId ?? t('rollback.group.unknownSession') })}
                        {group.unitId !== null ? ' · ' + group.unitId : ''}
                      </div>
                      {group.rows.map((row) => (
                        <div key={row.id} className={css.actionRow} data-inline>
                          <span className={css.hint}>{new Date(row.createdAtMs).toLocaleString()}</span>
                          <span className={css.hint}>{row.turn === null ? t('rollback.turnUnknown') : t('rollback.turn', { n: row.turn })}</span>
                          <Badge kind={row.kind === 'guard' ? 'info' : 'ok'}>{t(dyn(row.kindKey))}</Badge>
                          <span className={css.hint}>{t('rollback.row.files', { n: rollbackRowFileCount(row) })}</span>
                          <span className={css.hint}>
                            {rollbackRowHasSessionCursor(row)
                              ? t('rollback.row.sessionCursor')
                              : t('rollback.row.noSessionCursor')}
                          </span>
                          {row.protected && <Badge kind="warn">{t('rollback.badge.protected')}</Badge>}
                          {row.incomplete && <Badge kind="warn">{t('rollback.badge.incomplete')}</Badge>}
                          {/* S4：留点时「有文件被跳过 / 被截断」必须看得见（宿主已如实回传，界面不得静默） */}
                          {row.segments.flatMap((segment) => segment.noticeKeys.map((key) => (
                            <Badge key={segment.state + key} kind="warn">{t(dyn(key), { n: segment.skippedCount })}</Badge>
                          )))}
                          {row.note !== null && <span className={css.hint} title={row.note}>{row.note}</span>}
                          <span className={css.statusSpacer} />
                          <Button disabled={busy} onClick={() => { openPreview(row) }}>{t('rollback.preview')}</Button>
                          <Button variant="danger" disabled={busy || !row.removable} onClick={() => { setDeleteTarget(row) }}>{t('rollback.delete')}</Button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
          </>
        )}
      </Card>

      {/* 预览 / 回退（同一弹窗：先只读预览 + 三选一范围，执行后就地显示逐段结果） */}
      <Modal open={target !== null} onClose={closePreview} title={t('rollback.preview')} wide busy={busy}>
        <Modal.Header title={t('rollback.preview.title')} onClose={closePreview} closeLabel={t('common.close')} />
        {previewLoading && <Spinner label={t('rollback.preview.loading')} />}

        {result === null && preview !== null && (
          <>
            <div className={css.hint}>{t('rollback.preview.hint')}</div>
            <div className={css.snapshotList + ' ' + css.reportScroll}>
              {previewRows.map((row) => (
                <div key={row.state} className={css.actionRow} data-inline>
                  <Badge kind={row.available ? 'ok' : 'warn'}>{t(dyn(row.labelKey))}</Badge>
                  {row.available ? (
                    <>
                      {row.counts.map((count) => (
                        <span key={count.key} className={css.hint}>{t(dyn(count.key), { n: count.n })}</span>
                      ))}
                      {row.cursor !== null && (
                        <span className={css.hint}>
                          {t('rollback.preview.cursor', { from: row.cursor.from ?? '—', to: row.cursor.to ?? '—' })}
                        </span>
                      )}
                      {row.cursorBytes !== null && (row.cursorBytes.now !== null || row.cursorBytes.target !== null) && (
                        <span className={css.hint}>
                          {t('rollback.preview.cursorBytes', { now: row.cursorBytes.now ?? '—', target: row.cursorBytes.target ?? '—' })}
                        </span>
                      )}
                      {row.turns !== null && <span className={css.hint}>{t('rollback.preview.turns', { n: row.turns })}</span>}
                      {row.active && <span className={css.hint}>{t('rollback.preview.active')}</span>}
                      {/* S4：跳过 / 截断计数如实上屏（不因告警就禁用回退 —— 规格允许部分覆盖） */}
                      {row.noticeKeys.map((key) => (
                        <span key={key} className={css.hint}>{t(dyn(key), { n: row.skippedCount })}</span>
                      ))}
                      {row.guidance.map((guide) => (
                        <span key={guide.key + (guide.detail ?? '')} className={css.hint}>
                          {t(dyn(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className={css.hint}>{t(dyn(row.reasonKey ?? rollbackCodeKey(null)))}</span>
                  )}
                </div>
              ))}
            </div>

            {/* 点级告警（宿主 preview.warnings：trackMissing / trackDegraded / protected…）：此前只渲染 result.warnings，导致「留点被跳过 / 被截断」在预览里完全不可见。 */}
            {previewWarnings.length > 0 && (
              <div className={css.actionRow} data-inline>
                <span className={css.groupLabel}>{t('rollback.preview.warningsTitle')}</span>
                {previewWarnings.map((warning) => (
                  <span key={warning.key + (warning.detail ?? '')} className={css.hint}>
                    {t(dyn(warning.key))}{warning.detail !== null ? ' — ' + warning.detail : ''}
                  </span>
                ))}
              </div>
            )}
            {previewGuidance.map((guide) => (
              <div key={guide.key + (guide.detail ?? '')} className={css.hint}>
                {t(dyn(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
              </div>
            ))}

            {/* 该点**未记录**的文件（含留点时被跳过的既有文件）：只报告，绝不删除（S4） */}
            {previewRows.some((row) => row.leftovers.length > 0) && (
              <div className={css.planScroll}>
                <div className={css.groupLabel}>{t('rollback.preview.leftoversTitle')}</div>
                {previewRows.map((row) => row.leftovers.map((line) => (
                  <div key={row.state + line} className={css.hint}>{line}</div>
                )))}
                {previewRows.some((row) => row.leftoversTruncated) && <div className={css.hint}>{t('rollback.preview.createdAfterTruncated')}</div>}
              </div>
            )}

            {/* 三选一：范围（不可用的组合直接禁用，绝不发一个注定失败的请求） */}
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('rollback.mode.label')}</span>
              <select
                className={css.input}
                value={mode}
                disabled={busy}
                onChange={(e) => { setMode(e.target.value as RollbackMode) }}
              >
                {ROLLBACK_MODES.map((option) => (
                  <option key={option} value={option} disabled={!rollbackModeAvailable(option, verdict.segments)}>
                    {t(dyn(rollbackModeKey(option)))}
                  </option>
                ))}
              </select>
            </label>

            {verdict.incomplete && (
              <Checkbox checked={allowPartial} disabled={busy} onChange={setAllowPartial} label={t('rollback.rewind.allowPartial')} />
            )}
            {!verdict.canRestore && verdict.reasonKey !== null && (
              <div className={css.hint}>{t(dyn(verdict.reasonKey))}</div>
            )}

            <div className={css.actionRow}>
              <Button variant="danger" disabled={busy || !canRewind} loading={busy} onClick={() => { setConfirmOpen(true) }}>{t('rollback.rewind')}</Button>
              <span className={css.statusSpacer} />
              <Button disabled={busy} onClick={closePreview}>{t('common.cancel')}</Button>
            </div>
          </>
        )}

        {result !== null && (
          <>
            <div className={css.groupLabel}>{t('rollback.rewind.result.title')}</div>
            {outcome !== null && <Badge kind={outcome.badgeKind}>{t(dyn(outcome.key))}</Badge>}
            <div className={css.hint}>
              {t('rollback.rewind.result.counts', { restored: rewindCounts.restored, failed: rewindCounts.failed, leftovers: rewindCounts.leftovers })}
            </div>
            {childSession !== null && <div className={css.hint}>{t(dyn(childSession.key), { id: childSession.id })}</div>}
            {result.guardPointId !== undefined && <div className={css.hint}>{t('rollback.rewind.result.guard', { id: result.guardPointId })}</div>}
            <div className={css.snapshotList + ' ' + css.reportScroll}>
              {rewindRows.map((segment) => (
                <div key={segment.state} className={css.actionRow} data-inline>
                  <Badge kind={segment.badgeKind}>{t(dyn(segment.labelKey))}</Badge>
                  <span className={css.hint}>{t(dyn(segment.statusKey))}</span>
                  <span className={css.hint}>{t('rollback.rewind.result.counts', { restored: segment.restored, failed: segment.failed, leftovers: segment.leftoversCount })}</span>
                  {segment.childSessionId !== null && <span className={css.hint}>{t('rollback.rewind.result.child', { id: segment.childSessionId })}</span>}
                  {segment.detail.map((line) => <span key={line} className={css.hint}>{line}</span>)}
                  {segment.guidance.map((row) => (
                    <span key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</span>
                  ))}
                </div>
              ))}
            </div>
            {skipped.length > 0 && (
              <div className={css.hint}>
                {t('rollback.rewind.result.skipped', { list: skipped.map((row) => t(dyn(row.key))).join(' / ') })}
              </div>
            )}
            {rollbackGuidanceRows(result.warnings).map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            {rollbackGuidanceRows(result.guidance).map((row) => (
              <div key={row.key + (row.detail ?? '')} className={css.hint}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</div>
            ))}
            {actionError !== null && <Banner kind="error">{actionError}</Banner>}
            <div className={css.actionRow}>
              <Button onClick={closePreview}>{t('common.close')}</Button>
            </div>
          </>
        )}
      </Modal>

      {/* 回退二次确认（破坏性：覆盖工作区记录在案的路径 + fork 子会话；原会话日志不改写） */}
      <ConfirmDialog
        open={confirmOpen}
        title={t('rollback.rewind')}
        message={t('rollback.rewind.confirm')}
        confirmLabel={t('rollback.rewind')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onConfirm={rewind}
        onCancel={() => { setConfirmOpen(false) }}
      />

      {/* 删除确认（只删台账与内容副本，不动工作区 / 会话） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('rollback.delete.confirmTitle')}
        message={t('rollback.delete.confirmMessage')}
        confirmLabel={t('rollback.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => { setDeleteTarget(null) }}
      />
    </>
  )
}
