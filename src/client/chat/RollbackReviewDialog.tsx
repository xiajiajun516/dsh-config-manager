/**
 * 回退预览对话框 —— **简洁版**（用户 2026-10-10 第三条要求逐字落地）。
 *
 * 页面只做三件事：
 *  ① 标题固定「回退预览」（`rollback.preview.title`）；
 *  ② 正文只有**会被回退的文件**（路径 + 新增行数 + 删除行数，取自 E1 的
 *     `preview.workspace.files`；内容已一致的文件一项都不列；空列表 ⇒ 一行
 *     「工作区与该回退点一致，无需恢复」）；行数可能是 `null`（E1：超限 / 非文本 / 读不出），
 *     那时该文件那格显示「行数未统计」而**不是 0**；
 *  ③ 底部只有主按钮「回退」与「取消」。
 * 唯一允许的额外一行：**不可回退的原因**（宿主拒绝了这次回退时，主按钮是禁用的，一行字说清
 * 「为什么点不了」；引擎恒会给出原因键，回落「原因未知」只是防御）。
 *
 * 有意**删除**的东西（不在这里 = 不再渲染，键值仍留在字典里供设置页回滚卡使用）：
 * 三选一 mode 单选、两态不全放行勾选、二次确认勾选、工作区/会话计数面板、救援点说明段、
 * 逐段结果详情面板、留点期 notice 面板。**结果改为一行摘要 + 失败原因文案**（失败时仍如实
 * 显示 code 与 detail，绝不裸渲染机器码）。
 * **描述性文案清零（2026-10-12 用户第 8 条）**：说明行「这次回退会做以下改动：」与
 * 「这些文件的行数没有统计出来…」整段一并删除 —— 弹窗只留能改变决定的信息（DESIGN §7）；
 * 两个键仍留在字典里（删渲染不删键，与上面那批同一个先例）。
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
import { rollbackPreviewScope, rollbackSkippedSegments } from '../../ui/rollback-view.ts'
import type {
  RollbackPointPort,
  RollbackPreviewResult,
  RollbackRewindResult,
} from '../../ui/rollback-view.ts'
import { Badge, Banner, Button, Checkbox, Empty } from '../common/ui.tsx'
import { SkeletonList } from '../common/Skeleton.tsx'
import type { RollbackFileIconRenderer } from './RollbackFileIcon.tsx'
import { RollbackDiffPane, type RollbackDiffState } from '../recovery/RollbackDiffPane.tsx'
import { RollbackFileChanges } from '../recovery/RollbackFileChanges.tsx'
import type { RollbackDiffOpenResult } from './rollback-diff-tab.ts'
import { CloseIcon } from '../common/Icon.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'
import {
  CHAT_SESSION_ACTIVE_NOTE_KEY,
  canRevertFiles,
  canSubmitRewind,
  chatRewindFailed,
  chatRewindFailure,
  chatRewindNotices,
  chatRewindSummary,
  codeKeyOfError,
  confirmOnSubmit,
  archiveHintKey,
  createInFlightLock,
  defaultDraft,
  errorDetail,
  findPointForTurn,
  isSessionActive,
  readRollbackPreviewFiles,
  readRollbackPreviewRemovals,
  requestRewind,
  rollbackChildSession,
  rollbackOutcome,
  rollbackPreviewNote,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  revertFilesOn,
  setRevertFiles,
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
  /** 第一条消息之前没有可 fork 的边界：开一条全新会话（失败结构化返回，绝不抛）。 */
  startFreshSession: () => Promise<{ ok: true } | { ok: false; code: string }>
  /**
   * 「查看」：把该文件的差异开进 DSH 右侧栏（由装配点注入；侧栏不可用时返回 no-sidebar，
   * 本组件据此**如实降级**为弹窗内展示，绝不假装打开过）。
   */
  openDiff: (pointId: string, filePath: string) => RollbackDiffOpenResult
  /**
   * 文件类型图标的外部来源（可选，装配点注入）：装了 dsh-better-sidebar 时用它发布的
   * `betterSidebar.fileIcon(path, 14)`，否则组件回落到 DSH 自带的 `FileTypeIcon`（见 RollbackFileIcon.tsx）。
   */
  renderFileIcon?: RollbackFileIconRenderer
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

/* 一行文件统计（`+N` / `−M` / 「删除」/「行数未统计」）与整个文件清单都搬进了共享组件
 * `src/client/recovery/RollbackFileChanges.tsx` —— 设置页回滚卡的预览弹窗要用**同一份渲染**
 * （2026-10-12 用户要求「环境页的回退预览也要一眼看清被改动的文件」）。对话框这边只负责：
 * 读行数据（readRollbackPreviewFiles / readRollbackPreviewRemovals）、算汇总口径
 * （rollbackPreviewScope）与给出逐行「查看差异」通道。 */

/** 预览对话框主体（挂载即打开；关闭由父级卸载）。 */
export function RollbackReviewDialog({ sessionId, turn, port, rt, t, openChildSession, archiveParentSession, startFreshSession, openDiff, renderFileIcon, onClose }: RollbackReviewDialogProps) {
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
  /** 第一条消息之前：新建空会话的结果（null = 这次没有走这条路径）。 */
  const [freshSession, setFreshSession] = useState<{ ok: true } | { ok: false; code: string } | null>(null)
  /**
   * 「查看」的**降级通道**（null = 这次把它开进了右侧栏）：
   * 只有本客户端没有侧栏能力 / 打开动作抛错时才启动，并在弹窗内如实说清为什么在这里看。
   */
  const [inlineDiff, setInlineDiff] = useState<{ path: string; state: RollbackDiffState } | null>(null)
  const [inlineNotice, setInlineNotice] = useState<string | null>(null)
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
    setFreshSession(null)
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
    } else if ((attempt.result.segments ?? []).some((s) => s.state === 'session' && s.reasonCode === 'no-boundary')) {
      // **第一条用户消息之前没有上一个回合** ⇒ 没有可 fork 的边界（会话段结构化 no-boundary）。
      // 参照实现（Anionex/dsh-turn-rewind）在这种情形建一条同目录**空会话**，而不是硬造空子会话；
      // 我们走客户端同一条入口（uiWorkspace.startSession =「新会话」按钮那条路，id 由 DSH 自己铸）。
      const fresh = await startFreshSession()
      if (alive.current) setFreshSession(fresh)
    }
  })

  /**
   * 「查看」：把该文件的差异开到 DSH 右侧栏（**只读**，不做任何写操作）。
   *
   * 侧栏不可用 / 打开动作抛错时**绝不假装成功**：改用弹窗内展示同一份差异，
   * 并把「为什么在这里看」如实说一句（`no-sidebar` 与「调用失败」两句不同的话）。
   */
  const view = (filePath: string): void => {
    if (pointId === null) return
    const opened = openDiff(pointId, filePath)
    if (opened.ok) {
      // 第 5 条（用户 2026-10-12）：开进右侧栏之后**顺手关掉弹窗** —— 否则这块模态盖在新开的侧栏上，
      // 用户还得再点一次「取消」才能看差异。**只有真的开成功才关**：降级通道（下面那两支）必须留着，
      // 它正是「没侧栏时把同一份差异画在弹窗里」的地方。
      setInlineNotice(null)
      setInlineDiff(null)
      onClose()
      return
    }
    setInlineNotice(
      opened.reason === 'no-sidebar'
        ? t('chat.preview.viewInline')
        : t('chat.preview.viewFailed', { detail: redact(opened.detail ?? '') }),
    )
    setInlineDiff({ path: filePath, state: { status: 'loading' } })
    const read = port.rollbackPointFileDiff
    if (typeof read !== 'function') {
      setInlineDiff({ path: filePath, state: { status: 'error', message: null } })
      return
    }
    read.call(port, pointId, filePath).then(
      (diff) => { if (alive.current) setInlineDiff({ path: filePath, state: { status: 'ready', diff } }) },
      (error: unknown) => { if (alive.current) setInlineDiff({ path: filePath, state: { status: 'error', message: errorDetail(error) } }) },
    )
  }

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
  /**
   * 会被**删掉**的文件（第 6 条）：`preview.workspace.removals` —— 引擎 `planCreatedRemovals` 的产物，
   * 与执行阶段**同一个函数**（所以逐条 = 实际删的）。宿主 rewind 的 `removeCreated` 缺省为真，
   * 点「回退」真的会删它们（读法与诚实边界见 `readRollbackPreviewRemovals` 的注释）。
   */
  const removals = readRollbackPreviewRemovals(preview?.workspace)
  /** 选择框（第 1 条）当前是否「连文件一起退」以及它能不能被点。 */
  const revertFiles = revertFilesOn(draft)
  const revertFilesEnabled = canRevertFiles(preview)
  /**
   * 被跳过的段（C3）：工作区段不可用时引擎会跳过它、结果为 partial —— 同一份事实在设置页会
   * 渲染（RollbackCard 的 `rollback.rewind.result.skipped`），聊天侧此前只说「部分恢复 / 恢复 0 项」，
   * 没人告诉用户**文件一个都没退、以及为什么**。判据与设置页同源（rollbackSkippedSegments）。
   */
  const skippedSegments = rollbackSkippedSegments(result)
  /**
   * t8：这条对话此刻正在运行（引擎 preview 的 `session.active`）。运行中时：
   *  · 默认档 = 只回溯消息（`defaultDraft`）；· 文件开关禁用（`canRevertFiles`）；
   *  · 带工作区段的提交不可行（`canSubmitRewind`）—— 路由层对同一信号还有一道硬拒（409）。
   */
  const sessionActive = isSessionActive(preview)
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
  /** 结果里「与预期不同」的指引（没能挂回工作区等）；成功回退时为**空数组**，不占版面。 */
  const notices = chatRewindNotices(result)
  const counts = rollbackRewindCounts(result)
  const outcome = result === null ? null : rollbackOutcome(result.outcome)
  // R1：enablement 用「这次提交可行」判据（不含 confirmed）；确认只由 submit() 里
  // confirmOnSubmit 置位，绝不能反过来当前置 —— 否则按钮因未确认禁用、确认又只能靠点按钮（死锁）。
  // R2/F3：判据维度必须与 submit() 的执行体同宽（含「已有可写目标 pointId」与忙态）。
  const submitEnabled = submitButtonEnabled({ draft, preview, pointId, busy })
  const warnings = preview?.warnings ?? []
  /**
   * 顶部**汇总**（2026-10-12 第二轮）：一次回退动多少东西 —— 用户先判规模、再逐行核文件。
   * 数字口径在 `rollbackPreviewScope`（| 文件数 · +A / −D · 将删除 K |，行数只累加可信的那部分）。
   */
  const scope = rollbackPreviewScope(files, removals)

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
            {state === 'loading' && <SkeletonList count={3} label={t('chat.entry.loading')} />}

            {state === 'nopoint' && <Empty>{t('chat.entry.noPoint')}</Empty>}

            {state === 'error' && (
              <Banner kind="error">
                {rt(rk(loadKey ?? 'rollback.code.unknown'))}{loadDetail !== null ? ' — ' + loadDetail : ''}
              </Banner>
            )}

            {state === 'ready' && result === null && (
              <>
                {/* 2026-10-12 用户第 8 条「移除回退弹窗中的所有描述」：说明行「这次回退会做以下改动：」
                    整体删除 —— 它不改任何决定（DESIGN §7）。该键仍保留在字典里（删渲染不删键）。 */}
                {/* 选择框（第 1 条，用户 2026-10-12）：要不要**连文件一起**退回去。
                    勾 = files+session（默认，= 「回到这条消息之前」的文件也退）；
                    取消 = session（只退对话，工作区一个字节都不动）。
                    工作区态没有可用记录时**禁用**（那时没有文件可退，开关点了也没有区别）。 */}
                <div className={css.previewChoiceRow}>
                  <Checkbox
                    // 工作区段不可用时显示为**未勾选**（C4）：勾着却禁用会让人以为「文件会退、只是改不了」，
                    // 而实际提交的 workspace 段会被引擎跳过 —— 勾选态必须与真的会发生的事一致。
                    checked={revertFiles && revertFilesEnabled}
                    disabled={busy || !revertFilesEnabled}
                    onChange={(next) => { setDraft((previous) => setRevertFiles(previous, next) ?? previous) }}
                    label={t('chat.preview.revertFiles')}
                  />
                  {/* 汇总：**紧挨着那颗选择框**（同一行、右对齐）—— 它管的正是这份清单的规模。
                      取消勾选时不显示数字，改写一句「文件不改动」：那时数字与用户无关，
                      而清单仍在下面（保持满不透明度 —— 旧做法整块 opacity 会读成「弹窗坏了」）。 */}
                  {files.length + removals.length > 0 && (
                    <span className={css.previewScope} data-off={revertFiles ? undefined : 'true'}>
                      {revertFiles ? (
                        <>
                          <span>{t('chat.preview.scope.files', { n: String(scope.files) })}</span>
                          <span className={css.previewScopeStats}>
                            <span className={css.rollbackAdded}>{rt(rk('rollback.preview.file.added'), { n: String(scope.added) })}</span>
                            <span className={css.rollbackRemoved}>{rt(rk('rollback.preview.file.removed'), { n: String(scope.removed) })}</span>
                            {scope.removals > 0 && (
                              <span className={css.rollbackDeleted}>{rt(rk('rollback.preview.file.deleted'))} {String(scope.removals)}</span>
                            )}
                          </span>
                        </>
                      ) : (
                        <span className={css.previewScopeOff}>{t('chat.preview.scope.off')}</span>
                      )}
                    </span>
                  )}
                </div>

                {/* t8：对话正在运行 ⇒ 一句明确说明（默认档已改成「只回溯消息」、文件开关被禁用，
                    这句解释的正是「为什么这次不能连文件一起退」）。只留能改变决定的信息（DESIGN §7）。 */}
                {sessionActive && (
                  <div className={css.hint} data-cm-session-active="">{rt(rk(CHAT_SESSION_ACTIVE_NOTE_KEY))}</div>
                )}

                {/* ① 会被改动的文件 + 会被**删除**的文件（第 6 条：删除写「删除」，不写 +0 −N）。
                    两段都空 ⇒ 只剩四态句。**取消勾选时清单不再降透明度**（2026-10-12 第二轮：
                    半透明的整块清单会被读成「弹窗坏了」）—— 改成汇总行改写「文件不改动」+ 统计转弱化色，
                    仍然不把「不会发生的事」画得像会发生的事；行序、图标、路径一律保持满可读。 */}
                {files.length === 0 && removals.length === 0 ? (
                  // 预览态四态句：由 rollbackPreviewNote 决定（key=null 时本情形没有该类句子可说，
                  // 宁可不说话，也不上一句不实的「一致」）
                  noteText !== null ? <div className={css.hint}>{noteText}</div> : null
                ) : (
                  <>
                    <RollbackFileChanges
                      files={files}
                      removals={removals}
                      rt={rt}
                      renderFileIcon={renderFileIcon}
                      view={{
                        // 「查看差异：{path}」由字典给（chat 侧文案）；行内名字/目录就是那颗按钮。
                        hint: (path: string) => t('chat.preview.viewHint', { path }),
                        disabled: busy || pointId === null,
                        onView: view,
                      }}
                    />
                    {/* 2026-10-12 用户第 8 条：整段「行数没有统计出来…」说明删除 —— 逐文件那格的
                        「行数未统计」已经说明一切。该键仍保留在字典里（删渲染不删键）。 */}
                    {/* 「查看」的降级通道：没有右侧栏（或打开失败）时在弹窗内展示同一份差异 */}
                    {inlineDiff !== null && (
                      <div className={css.inlineDiffBox}>
                        {inlineNotice !== null && <div className={css.hint}>{inlineNotice}</div>}
                        {/* 路径由差异表的文件头承载（.diffFileHead）：这里不再画第二遍 */}
                        <RollbackDiffPane state={inlineDiff.state} rt={rt} title={inlineDiff.path} />
                      </div>
                    )}
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

                {/* ⑤b 被跳过的段（C3）：**部分恢复时最该说的一句** —— 哪一段没做。
                    键与设置页共用（同一条事实只有一处文案）。 */}
                {skippedSegments.length > 0 && (
                  <div className={css.hint}>
                    {rt('rollback.rewind.result.skipped', { list: skippedSegments.map((row) => rt(rk(row.key))).join(' / ') })}
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
                {/* ⑥b 结果级 / 段级指引里「与预期不同」的事实（**没能挂回原工作区**等）。
                    成功回退时为空 ⇒ 一个字都不多说；有则如实说 —— 绝不静默让用户以为
                    「对话被回退弄丢了」（真机 2026-10-11/12 反馈：子会话落到侧栏「未分组」）。 */}
                {notices.length > 0 && (
                  <div className={css.rollbackBox}>
                    {notices.map((notice) => (
                      <div key={notice.key + (notice.detail ?? '')} className={css.warnText}>
                        {rt(rk(notice.key))}{notice.detail !== null ? ' — ' + notice.detail : ''}
                      </div>
                    ))}
                  </div>
                )}
                {/* A：原会话的归档结果 —— 成功一句话（列表里只剩这一条），失败如实说并在哪能看到它 */}
                {archive !== null && archive.ok && (
                  <div className={css.hint} data-dcm-archived="">{rt('rollback.rewind.archive.done')}</div>
                )}
                {archive !== null && !archive.ok && (
                  <div className={css.warnText}>{rt(archiveHintKey(archive) ?? 'rollback.rewind.archive.failed')}</div>
                )}
                {/* 第一条消息之前：会话段没有边界 ⇒ 已按参照实现开一条全新会话（失败如实说） */}
                {freshSession !== null && freshSession.ok && (
                  <div className={css.hint}>{rt('rollback.rewind.freshSession')}</div>
                )}
                {freshSession !== null && !freshSession.ok && (
                  <div className={css.warnText}>{rt('rollback.rewind.freshSessionFailed')}</div>
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
