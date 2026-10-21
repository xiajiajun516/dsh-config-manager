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
  ROLLBACK_MAX_POINTS_GUARDS_PER_SESSION,
  ROLLBACK_MAX_POINTS_GUARDS_TOTAL,
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
  rollbackPreviewScope,
  rollbackDefaultSelection,
  rollbackOnlyPaths,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  rollbackSelectionBlocksSubmit,
  rollbackSelectionRows,
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
import { SkeletonList } from '../common/Skeleton.tsx'
import { Icon } from '../common/Icon.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Modal } from '../common/Modal.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
// C7：删除 / 清理后要让聊天入口的列表缓存失效（否则 30 s 内按钮仍按旧列表判「可点」）
import { resetChatPointCache } from '../chat/chat-entry-view.ts'
import { readRollbackPreviewFiles, readRollbackPreviewRemovals } from '../chat/rollback-entry-view.ts'
import { formatSessionBytes } from '../../ui/session-inventory-view.ts'
import { rollbackEntryVisible } from '../../ui/rollback-view.ts'
import { setRollbackEntryEnabled } from './rollback-enabled.ts'
import { RollbackDiffPane, type RollbackDiffState } from './RollbackDiffPane.tsx'
import { RollbackFileChanges, type RollbackFileViewEntry } from './RollbackFileChanges.tsx'
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
  /**
   * issue #88：开关（读 + 写）两条都在才画开关；缺任一条**不画**（绝不给一个点了没反应的入口）。
   * issue #89：清理入口同理 —— 端口缺失就不显示（老宿主没有这条能力）。
   */
  const hasPrefsApi = typeof recoveryApi.rollbackPrefs === 'function' && typeof recoveryApi.setRollbackEnabled === 'function'
  const hasPurgeApi = typeof recoveryApi.purgeRollbackPoints === 'function'

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
  /** 逐个文件的「当前 → 回退后」差异（就地展示：设置页没有 DSH 右侧栏，那是聊天区的容器）。 */
  const [inlineDiff, setInlineDiff] = useState<{ path: string; state: RollbackDiffState } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    // StrictMode / 开发构建会 `effect → cleanup → effect` 双调用：cleanup 把标记置 false 之后
    // **必须由 setup 还原**，否则整张卡片在双调用后永久早退（Spinner 不停、台账永不出现、
    // 错误被吞、开关点了没反应）。
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** 台账弹窗的开关（2026-10-12：本卡退出折叠，台账整块进弹窗，且只在打开时挂载） */
  const [open, setOpen] = useState(false)
  /**
   * 弹窗左侧选中的对话（键 = sessionId；缺 id 的记录归入 `__unknown__` 组）。
   * 存**键**而不是对象：刷新后台账会换一批对象，键仍能对上；键失效时自动回落到第一条
   * （= 最新那条对话，见下方 activeGroup 的推导）。
   */
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  /**
   * 路径级勾选（2026-10-17 定案 A）：这次回退要恢复哪些文件。
   * 初值在**每次打开预览**时按引擎的归属标记重置（别的对话改过的默认不勾，见 rollbackSelectionRows）。
   */
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  /** 「刷新」在途：**保留旧内容**，只把刷新按钮置为在途（见 load 的 keep 语义） */
  const [refreshing, setRefreshing] = useState(false)
  /** 开关（issue #88）在途：置灰防重复点击，但不改开关的显示值（值只在宿主确认后变） */
  const [prefsBusy, setPrefsBusy] = useState(false)
  /** 清理台账（issue #89）：确认弹窗 / 勾选 / 结果文案 */
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupGuards, setCleanupGuards] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupNote, setCleanupNote] = useState<string | null>(null)

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
      (res) => {
        if (!mounted.current) return
        setList(res)
        setStatus('ready')
        setRefreshing(false)
        // issue #88：列表响应带回开关（storage.rollbackEnabled）。入口是**遮蔽宿主渲染器**注册的
        // （无常），只有这条信号能让聊天区那颗按钮跟着开 / 关。老宿主没有该字段 ⇒ 判据回落「默认开」。
        setRollbackEntryEnabled(rollbackEntryVisible(res.storage))
      },
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

  /**
   * 预览请求序号：只有「仍是最新一次请求」的响应才允许写状态。
   * 没有它就会出现「弹窗列的是 A 的文件、提交时用的却是 B 的 target」—— 关闭弹窗只清 target，
   * 在途的 A 响应后到照样 setPreview / setMode，而 rewind() 用 target.id 发请求、用 A 的 canRestore
   * 决定按钮可用性（removeCreated 缺省开启 ⇒ 会按一份不相关的清单真删 B 之后新建的文件）。
   */
  const previewSeq = useRef(0)

  const openPreview = (row: RollbackPointRowView): void => {
    if (recoveryApi.rollbackPointPreview === undefined) return
    const seq = previewSeq.current + 1
    previewSeq.current = seq
    setTarget(row); setPreview(null); setResult(null); setAllowPartial(false); setActionError(null)
    setInlineDiff(null)
    setPreviewLoading(true)
    recoveryApi.rollbackPointPreview(row.id).then(
      (res) => {
        if (!mounted.current || previewSeq.current !== seq) return
        setPreviewLoading(false)
        setPreview(res)
        // 默认勾选 = 非 foreign 的行（= B 的自动隔离口径），用户在清单里可以逐条改回去
        setSelectedPaths(rollbackDefaultSelection(rollbackSelectionRows(res)))
        // 默认 mode = 按可用段推导（判定在 ui 层，这里只取结果）
        setMode(rollbackPreviewVerdict(res).mode)
        if (!res.ok) setActionError(t(dyn(rollbackCodeKey(res.code))))
      },
      (err: unknown) => {
        if (!mounted.current || previewSeq.current !== seq) return
        setPreviewLoading(false)
        fail(err)
      },
    )
  }

  const closePreview = (): void => {
    // 作废在途响应：否则「关掉 A 再开 B」时 A 的清单会盖到 B 的目标上；顺带清掉在途态
    previewSeq.current += 1
    setPreviewLoading(false)
    setTarget(null); setPreview(null); setResult(null); setActionError(null); setInlineDiff(null)
  }

  /**
   * 逐行「查看差异」：把该文件的「当前 → 回退后」就地画在预览弹窗里（与聊天对话框的降级通道
   * **同一个** RollbackDiffPane 渲染）。读法判据只有一条：宿主真的给了 file-diff 能力、且这条记录
   * 真有 id —— 否则入口根本不出现（不给假入口、不假装打开过）。
   */
  const viewDiff = (filePath: string): void => {
    const read = recoveryApi.rollbackPointFileDiff
    const id = target?.id
    if (typeof read !== 'function' || id === undefined) return
    setInlineDiff({ path: filePath, state: { status: 'loading' } })
    read.call(recoveryApi, id, filePath).then(
      (diff) => { if (mounted.current) setInlineDiff({ path: filePath, state: { status: 'ready', diff } }) },
      (err: unknown) => { if (mounted.current) setInlineDiff({ path: filePath, state: { status: 'error', message: redactErrorText(err) } }) },
    )
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
      // 全选（或清单为空）⇒ onlyPaths 为 null ⇒ 不传字段，走既有全量口径
      ...(onlyPaths === null ? {} : { onlyPaths }),
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
        if (res.ok) {
          toast.ok(t('rollback.delete.done'))
          // C7：删掉的点可能正是聊天入口缓存里那条 → 清掉，否则 30 s 内入口仍按旧列表判「可点」，
          // 点开对话框直读端口才说「这个回合还没有回滚点」（按钮承诺了做不到的事）。
          resetChatPointCache()
          load()
          return
        }
        setActionError(t(dyn(rollbackCodeKey(res.code))))
      },
      (err: unknown) => { if (mounted.current) { setBusy(false); fail(err) } },
    )
  }

  /**
   * 开关（issue #88）：**写盘成功才改显示值** —— 写失败却把界面翻过去，等于「界面说开着、实际不留点」。
   * 显示值仍以宿主回传的磁盘真值为准（不是把我们传下去的那个值当真）。
   */
  const togglePrefs = (next: boolean): void => {
    if (typeof recoveryApi.setRollbackEnabled !== 'function') return
    setPrefsBusy(true)
    setActionError(null)
    recoveryApi.setRollbackEnabled(next).then(
      (res) => {
        if (!mounted.current) return
        setPrefsBusy(false)
        setList((prev) => (prev === null ? prev : {
          ...prev,
          storage: { ...prev.storage, rollbackEnabled: res.rollbackEnabled, rollbackActive: res.rollbackActive },
        }))
        setRollbackEntryEnabled(res.rollbackEnabled === true)
      },
      (err: unknown) => { if (mounted.current) { setPrefsBusy(false); fail(err) } },
    )
  }

  /**
   * 清理台账（issue #89）：删自动点（可选连救援点），然后**重新拉一次**列表 ——
   * 界面上的条数与占用必须来自真实读数，绝不用「删了多少」自己减（推算迟早漂移）。
   * 删了 0 个 = 「没有可删的」，不是失败：三态如实分派。
   */
  const purge = (): void => {
    if (typeof recoveryApi.purgeRollbackPoints !== 'function') return
    setCleanupBusy(true)
    setActionError(null)
    recoveryApi.purgeRollbackPoints({ includeGuards: cleanupGuards }).then(
      (res) => {
        if (!mounted.current) return
        setCleanupBusy(false)
        setCleanupOpen(false)
        const removed = res.removedRecords ?? 0
        setCleanupNote(removed === 0
          ? t('rollback.cleanup.none')
          : t('rollback.cleanup.done', { records: removed, size: formatSessionBytes(res.bytes ?? 0) }))
        // C7：清理同样会让聊天入口的缓存失真（同删除路径的理由）
        if (removed > 0) resetChatPointCache()
        load({ keep: true })
      },
      (err: unknown) => { if (mounted.current) { setCleanupBusy(false); setCleanupOpen(false); fail(err) } },
    )
  }

  const groups = rollbackPointGroups(list)
  const storage = list?.storage ?? null
  /** 开关当前值（issue #88）：只认宿主回传的布尔；缺字段（老宿主）显示为关闭，但那种宿主也不画开关 */
  /**
   * 开关当前值。**三态**：`null` = 台账还没读到（loading / 读失败）—— 那时**不能**显示成「关」：
   * 磁盘偏好可能是开（每回合仍在留点、占盘），显示成关会让用户点一下把 true 再写一遍（静默 no-op），
   * 并误以为功能本来就是关的。判据与聊天入口**同源**（rollbackEntryVisible）。
   */
  const prefsEnabled: boolean | null = storage === null ? null : rollbackEntryVisible(storage)
  /**
   * 偏好与**本进程实际状态**不一致（H7）：另一个实例改过 ui-prefs.json 时，本进程 gate=false
   * （真不订阅、不留点）而磁盘偏好仍是 true。这里如实说出分歧，别让界面替磁盘打包票。
   */
  const prefsDiverged = storage !== null && storage.rollbackActive === false && rollbackEntryVisible(storage)
  /** 台账占用（issue #89）；老宿主没有这个字段 ⇒ 这一行整个不渲染 */
  const ledger = storage?.ledger
  const storageGuidance = rollbackGuidanceRows(storage?.guidance)
  const verdict = rollbackPreviewVerdict(preview)
  // 点级告警 / 指引：引擎不给「属于哪一段」的键，故在面板级渲染一次（绝不猜归属）
  const previewWarnings = rollbackPreviewWarnings(preview)
  const previewGuidance = rollbackPreviewGuidance(preview)
  /** 会被**改动** / 会被**删除**的文件：与聊天里的回退预览同一对读法（引擎 preview.workspace 的同一份数据）。 */
  const previewFiles = readRollbackPreviewFiles(preview?.workspace)
  /** 可勾选行 / 勾选结果（判定全在 src/ui/rollback-view.ts） */
  const selectionRows = rollbackSelectionRows(preview)
  const selectionBlocked = rollbackSelectionBlocksSubmit(selectionRows, selectedPaths)
  const selectionForeign = selectionRows.filter((row) => row.foreign).map((row) => row.path)
  const onlyPaths = rollbackOnlyPaths(selectionRows, selectedPaths)
  const previewRemovals = readRollbackPreviewRemovals(preview?.workspace)
  /** 三个数字的口径与「文件行」同源（rollbackPreviewScope：行数只累加两侧都可信的那部分）。 */
  const previewScope = rollbackPreviewScope(previewFiles, previewRemovals)
  /** 逐行「查看差异」入口：宿主给不了 file-diff、或还没拿到预览时**不给**（那时路径只是文字）。 */
  const fileView: RollbackFileViewEntry | undefined =
    typeof recoveryApi.rollbackPointFileDiff === 'function' && preview !== null
      ? { hint: (path: string) => t('rollback.diff.viewHint', { path }), disabled: busy, onView: viewDiff }
      : undefined
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
  /**
   * 左栏条目的悬停全文：**标题 · 会话 id · 工作区路径**（三者有几个给几个，一个都不丢）。
   * 屏上优先显示标题（2026-10-12 用户要求「会话显示标题而不是 id」），id 退到悬停提示里。
   */
  const sessionHoverText = (group: RollbackPointGroupView): string =>
    [group.title, group.sessionId, group.unitId]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' · ')

  return (
    <>
      <Card>
        {/* 卡头：标题 + ⓘ 说明（2026-10-12 用户要求说明性文案进 ⓘ：原来的常驻副标题正是被它替代的那一行）。
            2026-10-12 同一轮用户要求：本卡**退出折叠** —— 摘要与入口常驻可见，台账整块搬进弹窗。 */}
        <SectionTitle title={t('rollback.title')} info={<InfoHint text={t('rollback.desc')} label={t('common.infoHint')} />} />

        {!hasApi && <Banner kind="warn">{t('rollback.apiMissing')}</Banner>}

        {/* issue #88：总开关。它**必须常驻可见** —— 关掉之后，用户还得有地方能把它打开。
            关闭语义 = 不订阅会话事件、不写台账、聊天入口收起（文案逐条对应代码，不含糊）。 */}
        {hasPrefsApi && (
          <div className={css.actionRowTop}>
            <Checkbox
              // 三态：`null`（还没读到）显示为未勾选且**禁用** —— 绝不替磁盘猜一个值
              checked={prefsEnabled === true}
              disabled={prefsBusy || busy || prefsEnabled === null}
              onChange={togglePrefs}
              label={t('rollback.switch.label')}
            />
            <InfoHint text={t('rollback.switch.hint')} label={t('common.infoHint')} />
          </div>
        )}
        {/* 还没读到偏好：说「正在读」而不是画成「关」（三处判据同一份：磁盘 / 本进程 / 未知） */}
        {hasPrefsApi && prefsEnabled === null && (
          <div className={css.hint}>{t('rollback.switch.unknown')}</div>
        )}
        {/* H7：偏好与本进程实际状态分歧（另一个实例写过 ui-prefs.json）—— 如实说，不替磁盘打包票 */}
        {prefsDiverged && <div className={css.hint}>{t('rollback.switch.diverged')}</div>}

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

        {status === 'loading' && <SkeletonList count={3} label={t('recovery.loading')} />}
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
              {/* issue #89 P2：台账占用（记录数 · 字节）。老宿主没有这个字段 ⇒ 这一行不渲染。 */}
              {ledger !== undefined && (
                <span className={css.rollbackSummary}>
                  {t('rollback.ledger.summary', {
                    records: ledger.records,
                    size: formatSessionBytes(ledger.bytes),
                  })}
                </span>
              )}
              {/* issue #89：清理入口（只删自动点；救援点由弹窗里的勾选决定） */}
              {hasPurgeApi && (
                <Button size="sm" variant="ghost" disabled={busy || cleanupBusy} onClick={() => { setCleanupOpen(true); setCleanupGuards(false) }}>
                  {t('rollback.cleanup')}
                </Button>
              )}
              {/* 台账入口：按会话分组的时间线整块进弹窗（列表再长也不撑长这一页） */}
              <Button size="sm" variant="primary" onClick={() => { setOpen(true) }}>
                {t('rollback.dialog.open')}
              </Button>
            </div>
            {/* 预算真的淘汰过东西时才说（没发生过就不占屏）：字节预算与已淘汰数都来自宿主读数 */}
            {ledger !== undefined && ledger.evicted > 0 && (
              <div className={css.hint}>
                {t('rollback.ledger.budget', {
                  budget: formatSessionBytes(ledger.budgetBytes),
                  evicted: ledger.evicted,
                })}
              </div>
            )}
            {/* 预算**兜不住**时如实说（典型：单条点本身就大于预算）—— 静默会让「预算生效」变成假象 */}
            {ledger !== undefined && ledger.overBudget === true && (
              <div className={css.hint}>
                {t('rollback.ledger.overBudget', {
                  size: formatSessionBytes(ledger.bytes),
                  budget: formatSessionBytes(ledger.budgetBytes),
                })}
              </div>
            )}
            {cleanupNote !== null && <div className={css.hint}>{cleanupNote}</div>}
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
                  text={t('rollback.retention.hint', {
                    perSession: ROLLBACK_MAX_POINTS_PER_SESSION,
                    total: ROLLBACK_MAX_POINTS_TOTAL,
                    guardsPerSession: ROLLBACK_MAX_POINTS_GUARDS_PER_SESSION,
                    guards: ROLLBACK_MAX_POINTS_GUARDS_TOTAL,
                  })}
                  label={t('common.infoHint')}
                />
                <Button size="sm" variant="ghost" disabled={busy || refreshing} loading={refreshing} onClick={() => { load({ keep: true }) }}>{t('rollback.refresh')}</Button>
              </span>
            )}
          />
          <Modal.Body scroll>
            {status === 'loading' && <SkeletonList count={3} label={t('recovery.loading')} />}
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
                              title={sessionHoverText(group) || t('rollback.group.unknownSession')}
                              onClick={() => { setSelectedSession(key) }}
                            >
                              {/* 有标题显示标题（人话），没有才回落会话 id（等宽，认得出是 id） */}
                              <span className={group.title === null ? css.rollbackSessionId + ' ' + css.mono : css.rollbackSessionId}>
                                {group.title ?? group.sessionId ?? t('rollback.group.unknownSession')}
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
                                <span
                                  className={activeGroup.title === null ? css.rollbackGroupTitle + ' ' + css.mono : css.rollbackGroupTitle}
                                  title={activeGroup.sessionId ?? undefined}
                                >
                                  {t('rollback.group.label', { session: activeGroup.title ?? activeGroup.sessionId ?? t('rollback.group.unknownSession') })}
                                </span>
                                <Badge kind="info">{t('rollback.group.count', { n: activeGroup.rows.length })}</Badge>
                                {/* 工作区路径：右对齐单行省略，全文进 title（不把组头撑成多行） */}
                                {activeGroup.unitId !== null && (
                                  <span className={css.rollbackGroupUnit} title={activeGroup.unitId}>{activeGroup.unitId}</span>
                                )}
                              </div>
                              <div className={css.rollbackPointsScroll + ' ' + css.rollbackPoints}>
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
            {/* 2026-10-13 用户要求「移除这个面板」：**工作区 / 会话计数面板整体删除** —— 与聊天里的
                回退预览同一屏（那边同样没有计数面板）。逐行清单 + 顶部汇总（N 个文件 · +A · −D · 删除 K）
                已经说清「这次回退会动什么」；计数散文会把决策信息埋掉（DESIGN.md §7 文案克制）。
                键值仍留在字典里（删渲染不删键，本仓既有先例）；真出事时的告警 / 指引照旧渲染（见下）。 */}
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

            {/* 会被**改动**的文件（引擎 preview.workspace.files）+ 会被**删除**的文件（引擎的删除集，
                与执行阶段同一份规划 planCreatedRemovals ⇒ 逐条 = 实际会删的，清单全量）。
                与聊天里的回退预览**共用一份渲染**（RollbackFileChanges）：图标 | 目录弱化 + 基名 |
                右对齐的 ±行数（整文件删除写「删除」、行数不可信写「行数未统计」）。
                清单限高内滚（.planScroll）：几百个文件也不把弹窗撑长。 */}
            {previewFiles.length + previewRemovals.length > 0 && (
              <>
                <div className={css.previewChoiceRow}>
                  <span className={css.groupLabel}>{t('rollback.preview.files.title')}</span>
                  <span className={css.previewScope}>
                    <span>{t('rollback.row.files', { n: previewScope.files })}</span>
                    <span className={css.previewScopeStats}>
                      <span className={css.rollbackAdded}>{t('rollback.preview.file.added', { n: String(previewScope.added) })}</span>
                      <span className={css.rollbackRemoved}>{t('rollback.preview.file.removed', { n: String(previewScope.removed) })}</span>
                      {previewScope.removals > 0 && (
                        <span className={css.rollbackDeleted}>{t('rollback.preview.file.deleted')} {String(previewScope.removals)}</span>
                      )}
                    </span>
                  </span>
                </div>
                <div className={css.planScroll}>
                  <RollbackFileChanges
                    files={previewFiles}
                    removals={previewRemovals}
                    rt={t}
                    view={fileView}
                    selection={{
                      selected: selectedPaths,
                      foreign: selectionForeign,
                      foreignLabel: t('rollback.preview.select.foreign'),
                      toggleLabel: (path: string) => t('rollback.preview.select.toggle', { path }),
                      disabled: busy,
                      onToggle: (path: string) => {
                        setSelectedPaths((prev) => (prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]))
                      },
                    }}
                  />
                </div>
                {/* 「查看差异」的就地展示：放在清单**外面**（列表自己有内滚，放里面会滚出视野）。
                    弹窗内只有这一条通道（设置页没有 DSH 右侧栏），渲染与聊天侧降级通道同一个面板。 */}
                {inlineDiff !== null && (
                  <div className={css.inlineDiffBox}>
                    {/* 路径由差异表的文件头承载（.diffFileHead）：这里不再画第二遍 */}
                    <RollbackDiffPane state={inlineDiff.state} rt={t} title={inlineDiff.path} />
                  </div>
                )}
              </>
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
              <Button variant="danger" disabled={busy || !canRewind || selectionBlocked} loading={busy} onClick={() => { setConfirmOpen(true) }}>{t('rollback.rewind')}</Button>
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
                      {/* 归属隔离与路径选择的**如实**回传：跳过了就要说，不能只报「恢复 N 项」 */}
                      {segment.foreignSkipped > 0 && (
                        <span>{t('rollback.result.foreignSkipped', { n: segment.foreignSkipped })}</span>
                      )}
                      {segment.selectionSkipped > 0 && (
                        <span>{t('rollback.result.selectionSkipped', { n: segment.selectionSkipped })}</span>
                      )}
                      {/* 三方合并的四态（2026-10-17）：合并成功 / 冲突 / 无法安全撤销 / 并发变化 —— 一条都不能省 */}
                      {segment.mergedCount > 0 && (
                        <span>{t('rollback.result.merged', { n: segment.mergedCount })}</span>
                      )}
                      {segment.conflictCount > 0 && (
                        <span>{t('rollback.result.conflict', { n: segment.conflictCount })}</span>
                      )}
                      {segment.unavailableCount > 0 && (
                        <span>{t('rollback.result.unavailable', { n: segment.unavailableCount })}</span>
                      )}
                      {segment.unclaimedCount > 0 && (
                        <span>{t('rollback.result.unclaimed', { n: segment.unclaimedCount })}</span>
                      )}
                      {segment.unclaimedPaths.map((line) => <span key={'unclaimed:' + line}>{line}</span>)}
                      {segment.concurrentCount > 0 && (
                        <span>{t('rollback.result.concurrent', { n: segment.concurrentCount })}</span>
                      )}
                      {segment.conflictPaths.map((line) => <span key={'conflict:' + line}>{line}</span>)}
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

      {/* 清理确认（issue #89）：删的是台账与内容副本，**不动工作区 / 会话**。
          默认只删自动点；救援点要靠勾选显式同意（它们的语义是「回退前的安全网」）。 */}
      <ConfirmDialog
        open={cleanupOpen}
        title={t('rollback.cleanup.confirmTitle')}
        message={t('rollback.cleanup.confirmMessage')}
        confirmLabel={t('rollback.cleanup')}
        cancelLabel={t('common.cancel')}
        danger
        busy={cleanupBusy}
        onConfirm={purge}
        onCancel={() => { setCleanupOpen(false) }}
      >
        <Checkbox
          checked={cleanupGuards}
          disabled={cleanupBusy}
          onChange={setCleanupGuards}
          label={t('rollback.cleanup.includeGuards')}
        />
      </ConfirmDialog>

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
