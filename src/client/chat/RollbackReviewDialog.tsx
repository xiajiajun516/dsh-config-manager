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
  chatRewindFailed,
  chatRewindFailure,
  chatRewindSummary,
  codeKeyOfError,
  confirmOnSubmit,
  archiveHintKey,
  createInFlightLock,
  defaultDraft,
  errorDetail,
  findPointForTurn,
  readRollbackPreviewFiles,
  requestRewind,
  rollbackChildSession,
  rollbackOutcome,
  rollbackPreviewNote,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  submitButtonEnabled,
  type ArchiveOutcome,
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
  /** A（无感替换）：回退后把**原会话**收进「已归档」；失败一律结构化返回，由本组件如实呈现。 */
  archiveParentSession: (sessionId: string) => Promise<ArchiveOutcome>
  onClose: () => void
}

/**
 * 回退后是否把原会话自动收进「已归档」。
 *
 * **默认 false**：归档当前会话会让 DSH 客户端换绑新会话，而它复用的 prepared id（`session-1` 这类
 * 由 `SessionStore.prepare()` 铸的计数 id）在宿主里已不存在 ⇒ 真机报
 * 「新建会话失败: gateway/internal: failed to create session "session-1": SessionPersistenceNotFoundError」。
 * 这是「列表里少一条」的观感收益 vs 「回退后整页会话打不开」的风险，选择后者不换。
 */
const ARCHIVE_REWOUND_PARENT = false

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
export function RollbackReviewDialog({ sessionId, turn, port, rt, t, openChildSession, archiveParentSession, onClose }: RollbackReviewDialogProps) {
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
  /** A：原会话归档结果（null = 还没走到这一步）。 */
  const [archive, setArchive] = useState<ArchiveOutcome | null>(null)
  const alive = useRef(true)
  /**
   * 同一 tick 的**同步幂等锁**（t3 F4）：`busy` 是异步 setState，挡不住同一 tick 里的第二次派发
   * （双击 / 按键重复 / 程序化 dispatchEvent）—— 那会发出两次写请求。这把锁在第一个 `await` 之前
   * **同步**置位，保证回退写请求恰好一次；`finally` 释放，失败后仍可重试。
   */
  const submitLock = useRef(createInFlightLock()).current

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
    setArchive(null)
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
   * 再交给 `canSubmitRewind` / `requestRewind` 的 fail-closed 判定；整段由同步幂等锁包住（F4）。
   * 返回 200 且 `code='nothing-to-restore'` 时**不是失败**：下面按 noop 摘要如实呈现
   *（E1：工作区与该回退点一致，HTTP 200）。
   */
  const submit = (): Promise<boolean> => submitLock(async () => {
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
      // A（无感替换）里的「把原会话收进已归档」默认**关掉**（2026-10-11 真机定位）：
      // 归档**当前**会话会让 DSH 客户端去换绑一个新会话，而它复用的 prepared id 是宿主
      // `SessionStore.prepare()` 铸的 `session-<counter>`（第一个就是 `session-1`，见 dsh-session 的 prepare）；
      // 那个 id 在宿主侧已不存在 ⇒ 用户看到「新建会话失败: … session \"session-1\" not found」，
      // 回退后连不在回退里的那条对话都打不开了。归档只是列表观感的美化，不值得拿「回退后无法继续」去换。
      // 保留实现与单测备查：真要开启，把 `ARCHIVE_REWOUND_PARENT` 置 true 并重跑本文件所在目录的测试。
      if (ARCHIVE_REWOUND_PARENT) {
        const archived = await archiveParentSession(sessionId)
        if (alive.current) setArchive(archived)
      }
    }
  })

  const verdict = rollbackPreviewVerdict(preview)
  /**
   * 预览态那句「工作区怎样怎样」= **一处实现**（src/ui/rollback-view.ts 的 rollbackPreviewNote）：
   * 判据只来自 preview 字段 + 宿主 canRestore，四种情形说四句不同的话（③a 不含「无需恢复」——
   * 点下去真会 fork 子会话，说「无需恢复」是假尾句）。
   */
  const note = rollbackPreviewNote({
    workspace: preview?.workspace,
    session: preview?.session,
    segments: preview?.point?.segments,
    canRestore: verdict.canRestore,
  })
  const noteText = note.key === null
    ? null
    : note.reasonKey === null
      ? rt(rk(note.key))
      : rt(rk(note.key), { reason: rt(rk(note.reasonKey)) })
  const files = readRollbackPreviewFiles(preview?.workspace)
  const hasCounts = chatFileChangeAvailable(files)
  const summary = chatRewindSummary(result)
  /** F2：只有**真失败**才渲染下面的「失败原因」盒（成功 / 无需恢复的结果不得弹失败信息）。 */
  const failed = chatRewindFailed(result)
  /** 摘要文本：① 需要把「该段 reasonCode 的字典键文本」插进 {reason}（未知码回落 unknown）。 */
  const summaryText = summary.kind === 'plain'
    ? null
    : summary.kind === 'no-record'
      ? rt(rk(summary.key), { reason: rt(rk(summary.reasonKey)) })
      : rt(rk(summary.key))
  const failure = result === null ? { code: null, detail: null, keys: [] } : chatRewindFailure(result)
  const counts = rollbackRewindCounts(result)
  const outcome = result === null ? null : rollbackOutcome(result.outcome)
  // R1：enablement 用「这次提交可行」判据（不含 confirmed）；确认只由 submit() 里
  // confirmOnSubmit 置位，绝不能反过来当前置 —— 否则按钮因未确认禁用、确认又只能靠点按钮（死锁）。
  // R2/F3：判据维度必须与 submit() 的执行体同宽（含「已有可写目标 pointId」与忙态）。
  const submitEnabled = submitButtonEnabled({ draft, preview, pointId, busy })
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
                  // 预览态四态句：由 rollbackPreviewNote 决定（key=null 时本情形没有该类句子可说，
                  // 宁可不说话，也不上一句不实的「一致」）
                  noteText !== null ? <div className={css.hint}>{noteText}</div> : null
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
                {/* ④ 结果：**一行摘要** —— 「成功、0 变更」下三种情形说三句不同的话（T11）：
                       · 与该点一致 / 该点没有记录任何文件 / 该态没有可用记录（原因：{该段 code 键}）。
                       原因键走 rollbackCodeKey（未知码回落 unknown），**不裸渲染机器码**；
                       都不是失败 ⇒ 成功徽章（outcome=failed/partial 时不走这套，由下面 ⑤ 如实呈现）。 */}
                <div className={css.statRow}>
                  {summaryText !== null
                    ? <Badge kind="ok">{summaryText}</Badge>
                    : outcome !== null && <Badge kind={outcome.badgeKind}>{rt(rk(outcome.key))}</Badge>}
                  {summaryText === null && (
                    <span className={css.hint}>
                      {rt('rollback.rewind.result.counts', { restored: counts.restored, removed: counts.removed, failed: counts.failed, leftovers: counts.leftovers })}
                    </span>
                  )}
                </div>

                {/* ⑤ 失败原因：**只有真失败才渲染**（F2）—— 成功 / 无需恢复的结果一个字都不弹。
                      真失败时给：可读文案 + 真实 code + detail（不裸渲染机器码，但也不藏）。 */}
                {failed && (failure.keys.length > 0 || failure.detail !== null) && (
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
                {/* A：原会话的归档结果 —— 成功一句话（列表里只剩这一条），失败如实说并在哪能看到它 */}
                {archive !== null && archive.ok && (
                  <div className={css.hint} data-dcm-archived="">{rt('rollback.rewind.archive.done')}</div>
                )}
                {archive !== null && !archive.ok && (
                  <div className={css.warnText}>{rt(archiveHintKey(archive) ?? 'rollback.rewind.archive.failed')}</div>
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
