/**
 * 回退预览对话框 —— **简洁版**（用户 2026-10-10 第三条要求逐字落地）。
 *
 * 页面只做三件事：
 *  ① 标题固定「回退预览」（`rollback.preview.title`）；
 *  ② 正文只有**会被回退的文件**（路径 + 新增行数 + 删除行数，取自 E1 的
 *     `preview.workspace.files`；内容已一致的文件一项都不列；空列表 ⇒ 一行
 *     「工作区与该回退点一致，无需恢复」）；行数可能是 `null`（E1：超限 / 非文本 / 读不出），
 *     那时显示「行数未统计」而**不是 0**；
 *  ③ 底部只有主按钮「回退」与「取消」。
 * 唯一允许的额外一行：**不可回退的原因**（宿主拒绝了这次回退时，主按钮是禁用的，一行字说清
 * 「为什么点不了」；引擎恒会给出原因键，回落「原因未知」只是防御）。
 *
 * 有意**删除**的东西（不在这里 = 不再渲染，键值仍留在字典里供设置页回滚卡使用）：
 * 三选一 mode 单选、两态不全放行勾选、二次确认勾选、工作区/会话计数面板、救援点说明段、
 * 逐段结果详情面板、留点期 notice 面板。**结果改为一行摘要 + 失败原因文案**（失败时仍如实
 * 显示 code 与 detail，绝不裸渲染机器码）。
 *
 * 确认语义（对上一版的有意替换）：**点「回退」即视为 `userConfirmed=true`**。
 * 对话框本身就是「预览 + 确认」两步，所以不再需要勾选框；未点之前 `confirmed` 恒 false，
 * 连请求体都不成形（`buildRewindOptions` 的 fail-closed 一个字没动）。
 *
 * 为什么不用 common/Modal.tsx 或 ConfirmDialog：
 *  · `Modal` 的 Radix Portal 容器被**硬钉**在 `#dsh-config-manager-root`（插件设置页根节点，
 *    见 common/Modal.tsx 的长注释）—— 聊天里那个节点不存在，Modal 会**什么都不渲染**
 *    （container === null 时直接 return null，这是它刻意的行为，不是 bug）。
 *  · 因此这里直接用同一个 Radix Dialog 依赖 + **同一套 CSS 类**（dialogMask/dialogCard/...），
 *    视觉与设置页一致、零新增样式档位；Portal 走 Radix 缺省（document.body）—— 聊天区没有设置
 *    面板那层 fixed overlay，不存在 Modal 注释里那个层级冲突。
 */
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { TranslateNS } from '../client-types.ts'
import type {
  RollbackPointPort,
  RollbackPreviewResult,
  RollbackRewindResult,
} from '../../ui/rollback-view.ts'
import { Badge, Banner, Button, Empty, Spinner } from '../common/ui.tsx'
import { CloseIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'
import {
  canSubmitRewind,
  chatFileChangeAvailable,
  chatRewindFailure,
  chatRewindSummary,
  codeKeyOfError,
  confirmOnSubmit,
  defaultDraft,
  errorDetail,
  findPointForTurn,
  readRollbackPreviewFiles,
  requestRewind,
  rollbackChildSession,
  rollbackOutcome,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  type ChildOpenState,
  type RewindDraft,
} from './rollback-entry-view.ts'

/** recovery 字典键的动态取键助手（键值来自判定层常量，形状已冻结）。 */
type RKey = Parameters<TranslateNS<'config-manager-recovery'>>[0]
const rk = (key: string): RKey => key as RKey

export interface RollbackReviewDialogProps {
  /** 触发入口所属会话（session scope 标准 props）。 */
  sessionId: string
  /** 触发入口所在回合（回合尾按钮就在这个回合的尾部）。 */
  turn: number
  /** 回退端口（RecoveryApi 实现了 RollbackPointPort）。 */
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

/**
 * 一行文件统计：`+N` / `−M`；任一侧是 null ⇒ 「行数未统计」整句替换（绝不打 0）。
 * 两侧都可信时**两个数字都给**（新增与删除是两件事，用户两个都要看）。
 */
function FileStat({ added, removed, unknown, rt }: {
  added: number | null
  removed: number | null
  unknown: string
  rt: TranslateNS<'config-manager-recovery'>
}) {
  if (added === null || removed === null) return <span className={css.hint}>{unknown}</span>
  return (
    <>
      <span className={css.rollbackAdded}>{rt(rk('rollback.preview.file.added'), { n: String(added) })}</span>
      <span className={css.rollbackRemoved}>{rt(rk('rollback.preview.file.removed'), { n: String(removed) })}</span>
    </>
  )
}

/** 预览对话框主体（挂载即打开；关闭由父级卸载）。 */
export function RollbackReviewDialog({ sessionId, turn, port, rt, t, openChildSession, onClose }: RollbackReviewDialogProps) {
  const [state, setState] = useState<LoadState>('loading')
  const [loadKey, setLoadKey] = useState<string | null>(null)
  const [loadDetail, setLoadDetail] = useState<string | null>(null)
  /** 命中回滚点的 id（唯一写路径要它；其余字段界面不再渲染） */
  const [pointId, setPointId] = useState<string | null>(null)
  const [preview, setPreview] = useState<RollbackPreviewResult | null>(null)
  const [draft, setDraft] = useState<RewindDraft>(() => defaultDraft(null))
  const [busy, setBusy] = useState(false)
  const [writeKey, setWriteKey] = useState<string | null>(null)
  const [writeDetail, setWriteDetail] = useState<string | null>(null)
  const [result, setResult] = useState<RollbackRewindResult | null>(null)
  const [childId, setChildId] = useState<string | null>(null)
  const [childState, setChildState] = useState<ChildOpenState | 'opening' | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * 打开即读：台账列表 → 匹配（会话 + 回合号）→ 只读预览（**零写入**）。
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
    setPointId(null)
    try {
      const list = await port.rollbackPoints()
      const match = findPointForTurn(list.points, sessionId, turn)
      if (match === null) {
        setState('nopoint')
        return
      }
      const pre = await port.rollbackPointPreview(match.id)
      if (!alive.current) return
      setPointId(match.id)
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

  /**
   * 提交（唯一写路径）：**点主按钮 = 用户确认**（`confirmOnSubmit` 置 confirmed），
   * 再交给 `canSubmitRewind` / `requestRewind` 的 fail-closed 判定。
   * 返回 200 且 `code='nothing-to-restore'` 时**不是失败**：下面按 noop 摘要如实呈现
   *（E1：工作区与该回退点一致，HTTP 200）。
   */
  const submit = async (): Promise<void> => {
    if (pointId === null || busy) return
    const confirmedDraft = confirmOnSubmit(draft)
    if (!canSubmitRewind(confirmedDraft, preview)) return
    setDraft(confirmedDraft as RewindDraft)
    setBusy(true)
    setWriteKey(null)
    setWriteDetail(null)
    const attempt = await requestRewind(port, pointId, confirmedDraft)
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
  const files = readRollbackPreviewFiles(preview?.workspace)
  const hasCounts = chatFileChangeAvailable(files)
  const summary = chatRewindSummary(result)
  const failure = result === null ? { code: null, detail: null, keys: [] } : chatRewindFailure(result)
  const counts = rollbackRewindCounts(result)
  const outcome = result === null ? null : rollbackOutcome(result.outcome)
  const submitEnabled = canSubmitRewind(draft, preview) && !busy
  const warnings = preview?.warnings ?? []

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
            {state === 'loading' && <Spinner label={t('chat.entry.loading')} />}

            {state === 'nopoint' && <Empty>{t('chat.entry.noPoint')}</Empty>}

            {state === 'error' && (
              <Banner kind="error">
                {rt(rk(loadKey ?? 'rollback.code.unknown'))}{loadDetail !== null ? ' — ' + loadDetail : ''}
              </Banner>
            )}

            {state === 'ready' && result === null && (
              <>
                {/* ① 被回退的文件（只列会被改动的；空列表 ⇒ 一行「无需恢复」） */}
                {files.length === 0 ? (
                  <div className={css.hint}>{rt('rollback.preview.files.empty')}</div>
                ) : (
                  <>
                    <div className={css.hint}>{rt('rollback.preview.files.title')}</div>
                    <ul className={css.reasonList}>
                      {files.map((file) => (
                        <li key={file.path} className={css.rollbackFileRow}>
                          <span className={`${css.rollbackFilePath} ${css.mono}`}>{file.path}</span>
                          <FileStat
                            added={file.added}
                            removed={file.removed}
                            unknown={rt('rollback.preview.file.unknown')}
                            rt={rt}
                          />
                        </li>
                      ))}
                    </ul>
                    {/* 一条都没统计出来时，说清为什么（宁说「不知道」，不谎报行数） */}
                    {!hasCounts && <div className={css.hint}>{rt('rollback.preview.file.unknownHint')}</div>}
                  </>
                )}

                {/* ② 不可回退的原因：主按钮因此禁用 —— 一行字说清「为什么点不了」。
                    原因键由 src/ui/rollback-view.ts 分派（protected / guard / incomplete / 段原因 /
                    hostRefused）；**只有它一个都没给时**才回落「原因未知」，绝不回落成
                    「没有可回退的内容」（那是另一件事，T9-F3）。 */}
                {!verdict.canRestore && (
                  <div className={css.warnText}>
                    {verdict.reasonKey !== null ? rt(rk(verdict.reasonKey)) : t('chat.preview.reasonUnknown')}
                  </div>
                )}

                {/* ③ 点级告警：宿主在**真的出事**时才给（正常结果恒为空 ⇒ 不占版面） */}
                {warnings.length > 0 && (
                  <Banner kind="warn">
                    {warnings.map((warning) => (
                      <div key={warning.code + (warning.detail ?? '')} className={css.warnText}>
                        {rt(rk(warning.code))}{warning.detail !== undefined && warning.detail !== '' ? ' — ' + warning.detail : ''}
                      </div>
                    ))}
                  </Banner>
                )}
              </>
            )}

            {state === 'ready' && result !== null && (
              <>
                {/* ④ 结果：**一行摘要**（nothing-to-restore ⇒ 「工作区与该回退点一致，无需恢复」） */}
                <div className={css.statRow}>
                  {summary.key !== null
                    ? <Badge kind="ok">{rt(rk(summary.key))}</Badge>
                    : outcome !== null && <Badge kind={outcome.badgeKind}>{rt(rk(outcome.key))}</Badge>}
                  {summary.key === null && (
                    <span className={css.hint}>
                      {rt('rollback.rewind.result.counts', { restored: counts.restored, failed: counts.failed, leftovers: counts.leftovers })}
                    </span>
                  )}
                </div>

                {/* ⑤ 失败原因：可读文案 + 真实 code + detail（不裸渲染机器码，但也不藏） */}
                {failure.keys.length > 0 && (
                  <div className={css.rollbackBox}>
                    {failure.keys.map((key) => (
                      <div key={key} className={css.warnText}>{rt(rk(key))}</div>
                    ))}
                    {failure.code !== null && (
                      <div className={`${css.hint} ${css.mono}`}>{rt('rollback.preview.result.code', { code: failure.code })}</div>
                    )}
                    {failure.detail !== null && <div className={css.hint}>{failure.detail}</div>}
                  </div>
                )}

                {/* ⑥ fork 出来的子会话（有才显示；自动打开失败如实降级） */}
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

            {/* 写请求本身失败（端口抛错 / 客户端拦下）：文案 + code + detail */}
            {writeKey !== null && (
              <Banner kind="error">
                {rt(rk(writeKey))}{writeDetail !== null ? ' — ' + writeDetail : ''}
              </Banner>
            )}
          </div>

          <div className={`${css.actionRow} ${css.dialogFooter}`}>
            {result === null && state === 'ready' && (
              <Button variant="primary" disabled={!submitEnabled} loading={busy} onClick={() => { void submit() }}>
                {busy ? t('chat.rewind.running') : t('chat.rewind.submit')}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>{result === null ? rt('common.cancel') : t('chat.close')}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
