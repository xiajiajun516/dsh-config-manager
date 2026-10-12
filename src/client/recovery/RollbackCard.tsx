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
  RollbackPointGroupView,
  RollbackPointPort,
  RollbackPointRowView,
  RollbackPreviewResult,
  RollbackRewindResult,
} from '../../ui/rollback-view.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, IconButton, SectionTitle, Spinner } from '../common/ui.tsx'
import { Icon } from '../common/Icon.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
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
 * 行内告警徽章的**短标签 → 完整句**映射（2026-10-11 布局重构）：
 * 徽章只放短标签（如「跳过 2 项」），完整句进 \`title\` —— 事实一个字都不少，但不再逐行重复整句。
 * 未登记的键**回落完整句**（绝不因为缺映射就静默丢掉告警）。
 */
const NOTICE_SHORT_KEYS: Record<string, string> = {
  'rollback.row.notice.skipped': 'rollback.row.notice.skippedShort',
  'rollback.row.notice.truncated': 'rollback.row.notice.truncatedShort',
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

  /** 台账弹窗的开关（2026-10-12：本卡退出折叠，台账整块进弹窗，且只在打开时挂载） */
  const [open, setOpen] = useState(false)
  /**
   * 弹窗左侧选中的对话（键 = sessionId；缺 id 的记录归入 `__unknown__` 组）。
   * 存**键**而不是对象：刷新后台账会换一批对象，键仍能对上；键失效时自动回落到第一条
   * （= 最新那条对话，见下方 activeGroup 的推导）。
   */
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  /** 「刷新」在途：**保留旧内容**，只把刷新按钮置为在途（见 load 的 keep 语义） */
  const [refreshing, setRefreshing] = useState(false)

  const fail = (err: unknown): void => {
    if (!mounted.current) return
    const code = apiCodeOf(err)
    const message = redactErrorText(err)
    setActionError(code === null ? message : t(dyn(rollbackCodeKey(code))) + ' — ' + message)
  }

  /**
   * 拉台账（只读）。
   *
   * `keep` = **刷新语义**：已有内容时保留内容，只把刷新按钮置为在途 —— 2026-10-12 用户反馈
   * 「点刷新整个页面都会抖动」：旧实现每次都 `setStatus('loading')`，弹窗正文从整张台账塌成一行
   * Spinner（弹窗高度骤变、背后的卡片也跟着换形态），视觉上就是整页跳一下。
   */
  const load = (options?: { keep?: boolean }): void => {
    if (recoveryApi.rollbackPoints === undefined) { setStatus('error'); setError(null); return }
    const keep = options?.keep === true && list !== null
    if (keep) setRefreshing(true)
    else setStatus('loading')
    setError(null)
    recoveryApi.rollbackPoints().then(
      (res) => { if (mounted.current) { setList(res); setStatus('ready'); setRefreshing(false) } },
      (err: unknown) => {
        if (!mounted.current) return
        setRefreshing(false)
        // 刷新失败**不清空**已有台账：在正文里如实报错，旧内容仍在（绝不假装刷新成功）
        if (keep) { setActionError(redactErrorText(err)); return }
        setStatus('error'); setError(redactErrorText(err))
      },
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
  /** 分组键：会话 id；缺 id 的记录归入「未知会话」组（与 rollbackPointGroups 同一口径）。 */
  const groupKeyOf = (group: RollbackPointGroupView): string => group.sessionId ?? '__unknown__'
  /**
   * 当前展示的对话：左侧选中的那条；**选中的键在刷新后失效**（该会话的点被淘汰 / 删光）时
   * 回落到第一条 —— 绝不显示空右栏。组间顺序由 `rollbackPointGroups` 定死：按各组**最新时间倒序**
   * （= 用户要的「从新对话到旧对话」）。
   */
  const activeGroup = groups.find((group) => groupKeyOf(group) === selectedSession) ?? groups[0] ?? null

  return (
    <>
      <Card>
        {/* 卡头：标题 + ⓘ 说明（2026-10-12 用户要求说明性文案进 ⓘ：原来的常驻副标题正是被它替代的那一行）。
            2026-10-12 同一轮用户要求：本卡**退出折叠** —— 摘要与入口常驻可见，台账整块搬进弹窗。 */}
        <SectionTitle title={t('rollback.title')} info={<InfoHint text={t('rollback.desc')} label={t('common.infoHint')} />} />

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
            <div className={css.rollbackToolbar}>
              <span className={css.rollbackSummary}>
                {t('rollback.summary', { points: total, sessions: groups.length })}
              </span>
              <span className={css.statusSpacer} />
              {/* 台账入口：按会话分组的时间线整块进弹窗（列表再长也不撑长这一页） */}
              <Button size="sm" variant="primary" onClick={() => { setOpen(true) }}>
                {t('rollback.dialog.open')}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* 台账弹窗（按会话分组：每条对话一块；条目再多也只在弹窗内滚，卡片不再被撑长）。
          与体检弹窗同一条挂载纪律：**只在打开时挂载** —— 关闭即卸载，卡片重渲染不再带着整屏内容走。 */}
      {open && (
        <Modal open onClose={() => { setOpen(false) }} title={t('rollback.dialog.title')} wide busy={busy}>
          <Modal.Header
            title={t('rollback.dialog.title')}
            onClose={() => { setOpen(false) }}
            closeLabel={t('common.close')}
            trailing={(
              <span className={css.shHeaderTrailing}>
                {/* 留存/淘汰口径属机制说明 → 收进 ⓘ（DESIGN.md §7「说明性文案分层」）：屏上只留数字摘要，
                    20/50/救援点上限这些细节一个字不改，仍在同一条字典键里。 */}
                <InfoHint
                  text={t('rollback.retention.hint', { perSession: ROLLBACK_MAX_POINTS_PER_SESSION, total: ROLLBACK_MAX_POINTS_TOTAL })}
                  label={t('common.infoHint')}
                />
                <Button size="sm" variant="ghost" disabled={busy || refreshing} loading={refreshing} onClick={() => { load({ keep: true }) }}>{t('rollback.refresh')}</Button>
              </span>
            )}
          />
          <Modal.Body scroll>
            {status === 'loading' && <Spinner label={t('recovery.loading')} />}
            {status === 'error' && (
              <div className={css.actionRow}>
                <Banner kind="error">{error !== null ? error : t('rollback.apiMissing')}</Banner>
                <Button onClick={load}>{t('common.retry')}</Button>
              </div>
            )}

            {actionError !== null && <Banner kind="error">{actionError}</Banner>}

            {status === 'ready' && (
              <>
                {total === 0
                  ? <Empty>{t('rollback.list.empty')}</Empty>
                  : (
                    <div className={css.rollbackLedger}>
                      {/* 左：**拥有回滚点的对话**（默认新 → 旧：组间顺序由 rollbackPointGroups 按各组最新时间倒序定死）。
                          条目多时左侧自己内滚，右侧那一条对话的回滚点跟着换。 */}
                      <div className={css.rollbackSessions} aria-label={t('rollback.sessions.title')}>
                        {groups.map((group) => {
                          const key = groupKeyOf(group)
                          const current = activeGroup !== null && groupKeyOf(activeGroup) === key
                          return (
                            <button
                              key={key}
                              type="button"
                              className={css.rollbackSessionItem}
                              data-active={current ? '' : undefined}
                              aria-current={current ? 'true' : undefined}
                              title={group.unitId ?? group.sessionId ?? t('rollback.group.unknownSession')}
                              onClick={() => { setSelectedSession(key) }}
                            >
                              <span className={css.rollbackSessionId + ' ' + css.mono}>
                                {group.sessionId ?? t('rollback.group.unknownSession')}
                              </span>
                              <span className={css.rollbackSessionMeta}>
                                {t('rollback.group.count', { n: group.rows.length })}
                                {group.latestAtMs !== null && (
                                  <>
                                    <span className={css.rollbackMetaDot} aria-hidden="true"> · </span>
                                    <span className={css.mono}>{new Date(group.latestAtMs).toLocaleString()}</span>
                                  </>
                                )}
                              </span>
                            </button>
                          )
                        })}
                      </div>

                      {/* 右：该对话自己的回滚点（组头 = 会话 id + 计数 + 工作区路径；列表限高内滚） */}
                      <div className={css.rollbackLedgerMain}>
                        {activeGroup === null
                          ? <Empty>{t('rollback.list.empty')}</Empty>
                          : (
                            <div className={css.rollbackGroup}>
                              <div className={css.rollbackGroupHead}>
                                <span className={css.rollbackGroupTitle + ' ' + css.mono}>
                                  {t('rollback.group.label', { session: activeGroup.sessionId ?? t('rollback.group.unknownSession') })}
                                </span>
                                <Badge kind="info">{t('rollback.group.count', { n: activeGroup.rows.length })}</Badge>
                                {/* 工作区路径：右对齐单行省略，全文进 title（不把组头撑成多行） */}
                                {activeGroup.unitId !== null && (
                                  <span className={css.rollbackGroupUnit} title={activeGroup.unitId}>{activeGroup.unitId}</span>
                                )}
                              </div>
                              <div className={css.planScroll + ' ' + css.rollbackScroll + ' ' + css.rollbackPoints}>
                                {activeGroup.rows.map((row) => {
                                  const hasCursor = rollbackRowHasSessionCursor(row)
                                  return (
                                    <div key={row.id} className={css.rollbackPoint} data-kind={row.kind}>
                                      <div className={css.rollbackPointTop}>
                                        <span className={css.rollbackPointTurn}>
                                          {row.turn === null ? t('rollback.turnUnknown') : t('rollback.turn', { n: row.turn })}
                                        </span>
                                        {/* 来源徽章只放短标签（「救援点」），完整语义（含「可回退、不可删」）进 title */}
                                        <Badge kind={row.kind === 'guard' ? 'info' : 'ok'} title={t(dyn(row.kindKey))}>
                                          {row.kind === 'guard' ? t('rollback.kind.guardShort') : t(dyn(row.kindKey))}
                                        </Badge>
                                        {row.protected && <Badge kind="warn" title={t('rollback.badge.protected')}>{t('rollback.badge.protected')}</Badge>}
                                        {row.incomplete && <Badge kind="warn" title={t('rollback.badge.incomplete')}>{t('rollback.badge.incomplete')}</Badge>}
                                        {/* S4：留点时「有文件被跳过 / 被截断」必须看得见（宿主已如实回传，界面不得静默）。
                                            徽章只放短标签，完整句进 title；未登记的键回落完整句（绝不静默丢告警）。 */}
                                        {row.segments.flatMap((segment) => segment.noticeKeys.map((key) => {
                                          const full = t(dyn(key), { n: segment.skippedCount })
                                          const shortKey = NOTICE_SHORT_KEYS[key]
                                          const text = shortKey === undefined ? full : t(dyn(shortKey), { n: segment.skippedCount })
                                          return <Badge key={segment.state + key} kind="warn" title={full}>{text}</Badge>
                                        }))}
                                        <div className={css.rollbackPointActions}>
                                          <Button size="sm" disabled={busy} onClick={() => { openPreview(row) }}>{t('rollback.preview')}</Button>
                                          {/* 删除是不可逆的表账操作：图标按钮 + danger（视觉隔离），禁用原因进 title */}
                                          <IconButton
                                            icon={<Icon name="delete" />}
                                            label={t('rollback.delete')}
                                            title={row.removable ? t('rollback.delete') : (row.protected ? t('rollback.badge.protected') : t('rollback.kind.guard'))}
                                            disabled={busy || !row.removable}
                                            danger
                                            onClick={() => { setDeleteTarget(row) }}
                                          />
                                        </div>
                                      </div>
                                      <div className={css.rollbackPointMeta}>
                                        <span className={css.mono}>{new Date(row.createdAtMs).toLocaleString()}</span>
                                        <span className={css.rollbackMetaDot} aria-hidden="true">·</span>
                                        <span>{t('rollback.row.files', { n: rollbackRowFileCount(row) })}</span>
                                        <span className={css.rollbackMetaDot} aria-hidden="true">·</span>
                                        {/* 短标签进屏、完整句进 title：「无会话游标（只能回退工作区）」不再逐行重复整句 */}
                                        <span title={hasCursor ? t('rollback.row.sessionCursor') : t('rollback.row.noSessionCursor')}>
                                          {hasCursor ? t('rollback.row.sessionShort') : t('rollback.row.workspaceShort')}
                                        </span>
                                        {row.note !== null && (
                                          <span className={css.rollbackPointNote} title={row.note}>{row.note}</span>
                                        )}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                      </div>
                    </div>
                  )}
              </>
            )}
          </Modal.Body>
        </Modal>
      )}

      {/* 预览 / 回退（同一弹窗：先只读预览 + 三选一范围，执行后就地显示逐段结果） */}
      <Modal open={target !== null} onClose={closePreview} title={t('rollback.preview')} wide busy={busy}>
        <Modal.Header
          title={t('rollback.preview.title')}
          onClose={closePreview}
          closeLabel={t('common.close')}
          trailing={<InfoHint text={t('rollback.preview.hint')} label={t('common.infoHint')} />}
        />
        <Modal.Body scroll>
        {previewLoading && <Spinner label={t('rollback.preview.loading')} />}

        {result === null && preview !== null && (
          <>
            <div className={css.reportScroll + ' ' + css.rollbackScroll}>
              <div className={css.rollbackPoints}>
                {previewRows.map((row) => (
                  <div key={row.state} className={css.rollbackPoint} data-kind="unknown">
                    <div className={css.rollbackPointTop}>
                      <Badge kind={row.available ? 'ok' : 'warn'}>{t(dyn(row.labelKey))}</Badge>
                      {row.available && row.active && <span className={css.hint}>{t('rollback.preview.active')}</span>}
                      {!row.available && (
                        <span className={css.hint}>{t(dyn(row.reasonKey ?? rollbackCodeKey(null)))}</span>
                      )}
                    </div>
                    {row.available && (
                      <div className={css.rollbackPointMeta}>
                        {row.counts.map((count) => (
                          <span key={count.key}>{t(dyn(count.key), { n: count.n })}</span>
                        ))}
                        {row.cursor !== null && (
                          <span>
                            {t('rollback.preview.cursor', { from: row.cursor.from ?? '—', to: row.cursor.to ?? '—' })}
                          </span>
                        )}
                        {row.cursorBytes !== null && (row.cursorBytes.now !== null || row.cursorBytes.target !== null) && (
                          <span>
                            {t('rollback.preview.cursorBytes', { now: row.cursorBytes.now ?? '—', target: row.cursorBytes.target ?? '—' })}
                          </span>
                        )}
                        {row.turns !== null && <span>{t('rollback.preview.turns', { n: row.turns })}</span>}
                        {/* S4：跳过 / 截断计数如实上屏（不因告警就禁用回退 —— 规格允许部分覆盖） */}
                        {row.noticeKeys.map((key) => (
                          <span key={key}>{t(dyn(key), { n: row.skippedCount })}</span>
                        ))}
                        {row.guidance.map((guide) => (
                          <span key={guide.key + (guide.detail ?? '')}>
                            {t(dyn(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 点级告警（宿主 preview.warnings：trackMissing / trackDegraded / protected…）：此前只渲染 result.warnings，导致「留点被跳过 / 被截断」在预览里完全不可见。 */}
            {previewWarnings.length > 0 && (
              <div className={css.rollbackWarnings}>
                <div className={css.groupLabel}>{t('rollback.preview.warningsTitle')}</div>
                {previewWarnings.map((warning) => (
                  <div key={warning.key + (warning.detail ?? '')} className={css.hint}>
                    {t(dyn(warning.key))}{warning.detail !== null ? ' — ' + warning.detail : ''}
                  </div>
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
              {t('rollback.rewind.result.counts', { restored: rewindCounts.restored, removed: rewindCounts.removed, failed: rewindCounts.failed, leftovers: rewindCounts.leftovers })}
            </div>
            {childSession !== null && <div className={css.hint}>{t(dyn(childSession.key), { id: childSession.id })}</div>}
            {result.guardPointId !== undefined && <div className={css.hint}>{t('rollback.rewind.result.guard', { id: result.guardPointId })}</div>}
            <div className={css.reportScroll + ' ' + css.rollbackScroll}>
              <div className={css.rollbackPoints}>
                {rewindRows.map((segment) => (
                  <div key={segment.state} className={css.rollbackPoint} data-kind="unknown">
                    <div className={css.rollbackPointTop}>
                      <Badge kind={segment.badgeKind}>{t(dyn(segment.labelKey))}</Badge>
                      <span className={css.hint}>{t(dyn(segment.statusKey))}</span>
                    </div>
                    <div className={css.rollbackPointMeta}>
                      <span>{t('rollback.rewind.result.counts', { restored: segment.restored, removed: segment.removedCount, failed: segment.failed, leftovers: segment.leftoversCount })}</span>
                      {segment.childSessionId !== null && <span>{t('rollback.rewind.result.child', { id: segment.childSessionId })}</span>}
                      {segment.detail.map((line) => <span key={line}>{line}</span>)}
                      {segment.guidance.map((row) => (
                        <span key={row.key + (row.detail ?? '')}>{t(dyn(row.key))}{row.detail !== null ? ' — ' + row.detail : ''}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
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
        </Modal.Body>
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
