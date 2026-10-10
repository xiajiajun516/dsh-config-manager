/**
 * 复核对话框：只读预览 → 三选一 → 二次确认 → 逐段结果（聊天内入口点开的那一个）。
 *
 * 为什么不用 common/Modal.tsx 或 ConfirmDialog：
 *  · `Modal` 的 Radix Portal 容器被**硬钉**在 `#dsh-config-manager-root`（插件设置页根节点，
 *    见 common/Modal.tsx 的长注释）—— 聊天里那个节点不存在，Modal 会**什么都不渲染**
 *    （container === null 时直接 return null，这是它刻意的行为，不是 bug）。
 *  · 因此这里直接用同一个 Radix Dialog 依赖 + **同一套 CSS 类**（dialogMask/dialogCard/...），
 *    视觉与设置页一致、零新增样式；Portal 走 Radix 缺省（document.body）—— 聊天区没有设置面板
 *    那层 fixed overlay，不存在 Modal 注释里那个层级冲突。
 *
 * 安全链（与宿主侧逐条对应，界面只做诚实呈现）：
 *  ① 打开即读台账 + `<id>/preview`（**零写入**）；读不出来按 code 出文案，绝不假装有内容；
 *  ② 三选一 mode 只在**可达**时可选（段不全的档位 disabled）；两态不全时另给显式放行勾选；
 *  ③ 二次确认勾选**必须打勾**才允许提交（`canSubmitRewind`）；未打勾时连请求体都不成形；
 *  ④ 提交只走 `requestRewind`（唯一写出口，见 rollback-entry-view.ts）；
 *  ⑤ 结果逐段如实呈现（恢复/失败/未删的新建内容），会话段的 fork 子会话 id 如实展示并尝试自动打开；
 *     打不开就如实降级（小字说明），**绝不假装已打开**。
 */
import { useEffect, useId, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { TranslateNS } from '../client-types.ts'
import type {
  RollbackPointPort,
  RollbackPointRowView,
  RollbackPointSummary,
  RollbackPreviewResult,
  RollbackRewindResult,
} from '../../ui/rollback-view.ts'
import { Badge, Banner, Button, Checkbox, Empty, Spinner } from '../common/ui.tsx'
import { CloseIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'
import {
  canSubmitRewind,
  codeKeyOfError,
  defaultDraft,
  errorDetail,
  findPointForTurn,
  modeOptions,
  modeReachable,
  requestRewind,
  rollbackChildSession,
  rollbackOutcome,
  rollbackPointRows,
  rollbackPreviewGuidance,
  rollbackPreviewRows,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  rollbackRewindCounts,
  rollbackRewindRows,
  type ChildOpenState,
  type RewindDraft,
} from './rollback-entry-view.ts'

/** recovery 字典键的动态取键助手（键值来自判定层常量，形状已由 T2 冻结）。 */
type RKey = Parameters<TranslateNS<'config-manager-recovery'>>[0]
const rk = (key: string): RKey => key as RKey

export interface RollbackReviewDialogProps {
  /** 触发入口所属会话（session scope 标准 props）。 */
  sessionId: string
  /** 触发入口所在回合（回合尾按钮就在这个回合的尾部）。 */
  turn: number
  /** 回退端口（T2 的 RecoveryApi 实现了 RollbackPointPort）。 */
  port: RollbackPointPort
  /** recovery 字典翻译器（回退词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** chat 字典翻译器（聊天入口独有文案）。 */
  t: TranslateNS<'config-manager-chat'>
  /** 打开 fork 出来的子会话（降级态由本组件如实呈现）。 */
  openChildSession: (childId: string) => Promise<ChildOpenState>
  onClose: () => void
}

type LoadState = 'loading' | 'ready' | 'nopoint' | 'error'

/** 复核对话框主体（挂载即打开；关闭由父级卸载）。 */
export function RollbackReviewDialog({ sessionId, turn, port, rt, t, openChildSession, onClose }: RollbackReviewDialogProps) {
  const [state, setState] = useState<LoadState>('loading')
  const [loadKey, setLoadKey] = useState<string | null>(null)
  const [loadDetail, setLoadDetail] = useState<string | null>(null)
  const [point, setPoint] = useState<RollbackPointSummary | null>(null)
  /** 该点的展示行（只为取留点期告警键 `segment.noticeKeys`；判定仍走 preview） */
  const [pointRow, setPointRow] = useState<RollbackPointRowView | null>(null)
  const [preview, setPreview] = useState<RollbackPreviewResult | null>(null)
  const [draft, setDraft] = useState<RewindDraft>(() => defaultDraft(null))
  const [busy, setBusy] = useState(false)
  const [writeKey, setWriteKey] = useState<string | null>(null)
  const [writeDetail, setWriteDetail] = useState<string | null>(null)
  const [result, setResult] = useState<RollbackRewindResult | null>(null)
  const [childId, setChildId] = useState<string | null>(null)
  const [childState, setChildState] = useState<ChildOpenState | 'opening' | null>(null)
  const alive = useRef(true)
  const radioName = useId()

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * 打开即读：台账列表 → 匹配（会话 + 回合号）→ 只读预览。
   * 找不到该回合的点就停在 `nopoint`（如实说「还没有」，绝不自动挑一个别的点）。
   */
  const load = async (): Promise<void> => {
    setState('loading')
    setLoadKey(null)
    setLoadDetail(null)
    setResult(null)
    setChildId(null)
    setChildState(null)
    setWriteKey(null)
    setWriteDetail(null)
    setPreview(null)
    setPoint(null)
    setPointRow(null)
    try {
      const list = await port.rollbackPoints()
      const match = findPointForTurn(list.points, sessionId, turn)
      if (match === null) {
        setState('nopoint')
        return
      }
      setPoint(match)
      // 该点的**留点期**事实（跳过的超大文件 / 被上限截断）：「同尺子补齐」——面板列表行渲染的
      // `segment.noticeKeys` 在这里同样必须上屏，否则 S4 的「跳过必须可见」在聊天入口缺席（T19 复核项）。
      setPointRow(rollbackPointRows(list).find((row) => row.id === match.id) ?? null)
      const pre = await port.rollbackPointPreview(match.id)
      if (!alive.current) return
      setPreview(pre)
      setDraft(defaultDraft(pre))
      setState('ready')
    } catch (error) {
      if (!alive.current) return
      setLoadKey(codeKeyOfError(error))
      setLoadDetail(errorDetail(error))
      setState('error')
    }
  }

  useEffect(() => { void load() /* 打开一次读一次；重开由父级卸载重挂保证 */ }, [sessionId, turn])

  const tryOpenChild = async (id: string): Promise<void> => {
    setChildState('opening')
    const opened = await openChildSession(id)
    if (alive.current) setChildState(opened)
  }

  /** 提交（唯一写路径）：先过 `canSubmitRewind`，再交给 `requestRewind` 的 fail-closed 判定。 */
  const submit = async (): Promise<void> => {
    if (point === null || busy || !canSubmitRewind(draft, preview)) return
    setBusy(true)
    setWriteKey(null)
    setWriteDetail(null)
    const attempt = await requestRewind(port, point.id, draft)
    if (!alive.current) return
    setBusy(false)
    if (attempt.kind === 'blocked') { setWriteKey(attempt.key); return }
    if (attempt.kind === 'error') { setWriteKey(attempt.key); setWriteDetail(attempt.detail); return }
    setResult(attempt.result)
    const child = rollbackChildSession(attempt.result)
    if (child !== null) {
      setChildId(child.id)
      await tryOpenChild(child.id)
    }
  }

  const verdict = rollbackPreviewVerdict(preview)
  const previewRows = rollbackPreviewRows(preview)
  // 点级告警 / 指引（引擎不给「属于哪一段」的键，故整点在对话框里渲染一次，绝不猜归属）——
  // 与面板 RollbackCard 同一把尺子；**有告警不禁用回退**（S4 允许部分覆盖）。
  const previewWarnings = rollbackPreviewWarnings(preview)
  const previewGuidance = rollbackPreviewGuidance(preview)
  const pointNotices = (pointRow?.segments ?? []).flatMap((segment) => segment.noticeKeys.map((key) => ({ key, n: segment.skippedCount, state: segment.labelKey })))
  const rewindRows = rollbackRewindRows(result)
  const counts = rollbackRewindCounts(result)
  const outcome = result === null ? null : rollbackOutcome(result.outcome)
  const submitEnabled = canSubmitRewind(draft, preview) && !busy
  const allowPartialVisible = !verdict.canRestore && verdict.segments.length > 0

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={css.dialogMask} />
        <Dialog.Content
          className={`${css.dialogContentCenter} ${css.dialogCard} ${css.dialogWide}`}
          aria-label={rt('rollback.preview.title')}
          data-cm-dialog=""
          onEscapeKeyDown={(e) => { if (busy) e.preventDefault() }}
          onPointerDownOutside={(e) => { if (busy) e.preventDefault() }}
        >
          <div className={css.dialogHeaderRow}>
            <span className={css.dialogHeader}>{rt('rollback.preview.title')}</span>
            <Dialog.Close asChild>
              <button type="button" className={`${css.iconBtn} ${css.dialogClose}`} aria-label={t('chat.close')} disabled={busy}>
                <CloseIcon size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className={`${css.dialogBody} ${css.dialogBodyScroll}`}>
            <div className={css.hint}>{rt('rollback.preview.hint')}</div>

            {state === 'loading' && <Spinner label={t('chat.entry.loading')} />}

            {state === 'nopoint' && <Empty>{t('chat.entry.noPoint')}</Empty>}

            {state === 'error' && (
              <Banner kind="error">
                {rt(rk(loadKey ?? 'rollback.code.unknown'))}{loadDetail !== null ? ' — ' + loadDetail : ''}
              </Banner>
            )}

            {state === 'ready' && result === null && (
              <>
                <div className={css.statRow}>
                  <Badge kind="info">{rt('rollback.col.turn')}</Badge>
                  <span className={css.hint}>{rt('rollback.preview.turns', { n: turn })}</span>
                  {point?.createdAt !== undefined && <span className={css.hint}>{new Date(point.createdAt).toLocaleString()}</span>}
                </div>

                {previewRows.map((row) => (
                  <div key={row.state} className={css.rollbackBox}>
                    <div className={css.statRow}>
                      <Badge kind={row.available ? 'info' : 'warn'}>{rt(rk(row.labelKey))}</Badge>
                      {row.reasonKey !== null && <span className={css.warnText}>{rt(rk(row.reasonKey))}</span>}
                      {row.cursor !== null && row.cursor.from !== null && row.cursor.to !== null && (
                        <span className={css.hint}>
                          {rt('rollback.preview.cursor', { from: String(row.cursor.from), to: String(row.cursor.to) })}
                        </span>
                      )}
                      {row.turns !== null && <span className={css.hint}>{rt('rollback.preview.turns', { n: row.turns })}</span>}
                    </div>
                    {row.counts.map((count) => (
                      <div key={count.key} className={css.hint}>{rt(rk(count.key), { n: count.n })}</div>
                    ))}
                    {/* S4「跳过 / 截断必须可见」：宿主已如实回传，界面不静默；**有告警不禁用回退** */}
                    {row.noticeKeys.map((key) => (
                      <div key={row.state + '-' + key} className={css.warnText}>{rt(rk(key), { n: row.skippedCount })}</div>
                    ))}
                    {row.leftovers.length > 0 && (
                      <>
                        <div className={css.hint}>{rt('rollback.preview.leftoversTitle')}</div>
                        <ul className={css.reasonList}>
                          {row.leftovers.map((path) => <li key={path} className={css.reasonLine}>{path}</li>)}
                        </ul>
                        {row.leftoversTruncated && <div className={css.hint}>{rt('rollback.preview.createdAfterTruncated')}</div>}
                      </>
                    )}
                    {row.guidance.map((guide, index) => (
                      <div key={row.state + '-guide-' + String(index)} className={css.hint}>
                        {rt(rk(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
                      </div>
                    ))}
                    {row.active && <div className={css.warnText}>{rt('rollback.preview.active')}</div>}
                  </div>
                ))}

                {/* 留点期的「跳过 / 截断」（面板列表行的 segment.noticeKeys 同一份事实）：超大文件被跳过时如实报告 */}
                {pointNotices.length > 0 && (
                  <div className={css.rollbackBox}>
                    {pointNotices.map((notice) => (
                      <div key={notice.state + '-' + notice.key} className={css.warnText}>
                        {rt(rk(notice.state))} — {rt(rk(notice.key), { n: notice.n })}
                      </div>
                    ))}
                  </div>
                )}

                {/* 点级告警（宿主 preview.warnings：trackMissing / trackDegraded / protected…）*/}
                {previewWarnings.length > 0 && (
                  <div className={css.rollbackBox}>
                    <div className={css.hint}>{rt('rollback.preview.warningsTitle')}</div>
                    {previewWarnings.map((warning) => (
                      <div key={warning.key + (warning.detail ?? '')} className={css.warnText}>
                        {rt(rk(warning.key))}{warning.detail !== null ? ' — ' + warning.detail : ''}
                      </div>
                    ))}
                  </div>
                )}

                {/* 点级指引（preview.guidance）：与面板同一把尺子 */}
                {previewGuidance.map((guide) => (
                  <div key={guide.key + (guide.detail ?? '')} className={css.hint}>
                    {rt(rk(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
                  </div>
                ))}

                <div className={css.hint}>{rt('rollback.mode.label')}</div>
                {modeOptions().map((option) => {
                  const reachable = modeReachable(option.mode, verdict.segments)
                  return (
                    <label key={option.mode} className={css.radioLabel}>
                      <input
                        type="radio"
                        name={radioName}
                        checked={draft.mode === option.mode}
                        disabled={!reachable || busy}
                        onChange={() => { setDraft((current) => ({ ...current, mode: option.mode })) }}
                      />
                      <span>{rt(rk(option.key))}</span>
                    </label>
                  )
                })}
                {!verdict.canRestore && (
                  // 原因键由 src/ui/rollback-view.ts 的 rollbackPreviewVerdict 给出（T18 已按宿主真值分派
                  // protected / guard / incomplete / 段原因 / hostRefused）。**只有它一个都没给时**才回落，
                  // 而且绝不回落成「没有可回退的内容」—— 那是另一件事（T9-F3）。
                  <div className={css.warnText}>
                    {verdict.reasonKey !== null ? rt(rk(verdict.reasonKey)) : t('chat.preview.reasonUnknown')}
                  </div>
                )}
                {allowPartialVisible && (
                  <Checkbox
                    checked={draft.allowPartial}
                    disabled={busy}
                    onChange={(checked) => { setDraft((current) => ({ ...current, allowPartial: checked })) }}
                    label={rt('rollback.rewind.allowPartial')}
                  />
                )}
                <div className={css.hint}>{rt('rollback.guard.require')}</div>
                <Checkbox
                  checked={draft.confirmed}
                  disabled={busy}
                  onChange={(checked) => { setDraft((current) => ({ ...current, confirmed: checked })) }}
                  label={rt('rollback.rewind.confirm')}
                />

                {writeKey !== null && (
                  <Banner kind="error">
                    {rt(rk(writeKey))}{writeDetail !== null ? ' — ' + writeDetail : ''}
                  </Banner>
                )}
              </>
            )}

            {result !== null && (
              <>
                <div className={css.statRow}>
                  {outcome !== null && <Badge kind={outcome.badgeKind}>{rt(rk(outcome.key))}</Badge>}
                  <span className={css.hint}>
                    {rt('rollback.rewind.result.counts', { restored: counts.restored, failed: counts.failed, leftovers: counts.leftovers })}
                  </span>
                </div>
                {rewindRows.map((row) => (
                  <div key={row.state} className={css.rollbackBox}>
                    <div className={css.statRow}>
                      <Badge kind={row.badgeKind}>{rt(rk(row.statusKey))}</Badge>
                      <span className={css.hint}>{rt(rk(row.labelKey))}</span>
                      <span className={css.hint}>{row.restored} / {row.failed}</span>
                    </div>
                    {row.leftovers.length > 0 && (
                      <ul className={css.reasonList}>
                        {row.leftovers.map((path) => <li key={path} className={css.reasonLine}>{path}</li>)}
                      </ul>
                    )}
                    {row.detail.map((line, index) => (
                      <div key={row.state + '-detail-' + String(index)} className={css.hint}>{line}</div>
                    ))}
                    {row.guidance.map((guide, index) => (
                      <div key={row.state + '-guide-' + String(index)} className={css.hint}>
                        {rt(rk(guide.key))}{guide.detail !== null ? ' — ' + guide.detail : ''}
                      </div>
                    ))}
                  </div>
                ))}
                {childId !== null && (
                  <div className={css.statRow}>
                    <span className={css.hint}>{rt('rollback.rewind.result.child', { id: childId })}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={childState === 'opening'}
                      onClick={() => { void tryOpenChild(childId) }}
                    >
                      {childState === 'opening' ? t('chat.open.opening') : t('chat.open.child')}
                    </Button>
                  </div>
                )}
                {/* 三个降级态各自只说自己能证明的那件事（T9-F1）：没有导航入口 / 列表里还没有它 / 导航调用失败。
                    键是字面量（静态可扫、与 childOpenHintKey 的映射由测试对齐），'opening' 期间一律不显示。 */}
                {childState === 'unavailable' && (
                  <div className={css.warnText}>{t('chat.open.unavailable', { id: childId ?? '' })}</div>
                )}
                {childState === 'degraded' && (
                  <div className={css.warnText}>{t('chat.open.degraded', { id: childId ?? '' })}</div>
                )}
                {childState === 'failed' && (
                  <div className={css.warnText}>{t('chat.open.failed', { id: childId ?? '' })}</div>
                )}
              </>
            )}
          </div>

          <div className={`${css.actionRow} ${css.dialogFooter}`}>
            {result === null && state === 'ready' && (
              <Button variant="primary" disabled={!submitEnabled} loading={busy} onClick={() => { void submit() }}>
                {busy ? t('chat.rewind.running') : rt('rollback.rewind')}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>{result === null ? rt('common.cancel') : t('chat.close')}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
