/**
 * Recovery 面板（Phase 5 §10.2）：引导式恢复工作流。
 *
 * 数据流：recoveryApi.status() 加载未解决 incident → 选择 incident → preview（只读）
 * → 显式确认（ConfirmDialog，danger）→ execute（NEEDS_ATTENTION → RECOVERING）
 * → verify（post-recovery verification）→ 最终状态（MATCH/PARTIAL_MATCH → 完成；
 * MISMATCH/VERIFICATION_ERROR → 需人工处理，可 retry / dismiss）。
 *
 * 状态组件内自持（useState），同时经 toRecoveryStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」。
 * running 为「内存切片瞬态」：切 tab 由模块级单例保留、刷新时被 toPersistedState
 * 白名单剔除 —— 恢复是否仍在执行以宿主 RunRegistry（/runs + /progress）为权威，
 * 刷新后经 resume() 重新发现；浏览器持久化绝不作为 destructive operation 的状态源。
 *
 * UI HARD RULES（§10.4）：绝不自动 execute/rollback、绝不隐藏确认、绝不把
 * PARTIAL_MATCH 显示为完全成功、绝不把 NEEDS_ATTENTION 显示为 recovered、
 * 绝不在 snapshot 不可信时显示可恢复。流程 = 发生了什么 → 使用哪个 snapshot →
 * 将执行什么 → 用户确认 → 执行 → 验证 → 最终状态。
 */
import { useEffect, useRef, useState } from 'react'
import type { RecoveryPort } from '../../ui/types.ts'
import type { RollbackPointPort } from '../../ui/rollback-view.ts'
import type { RecoveryPreview, RecoveryStatus, RecoveryVerifyResult } from '../../ui/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Empty, FoldToggle, IconButton, SectionTitle, Spinner, StatusDot } from '../common/ui.tsx'
import { DiskUsageCard } from '../environment/maintenance/DiskUsageCard.tsx'
import { RollbackCard } from './RollbackCard.tsx'
import { SkeletonList, SkeletonTable } from '../common/Skeleton.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { Icon } from '../common/Icon.tsx'
import { toast } from '../common/toast-store.ts'
import { CopyButton } from '../common/CopyButton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Collapse } from '../common/Motion.tsx'
import {
  formatSessionBytes,
  sessionHealthEmpty,
  sessionHealthPhase,
  sessionHealthRows,
  sessionHealthSummaryView,
  sessionHealthTruncated,
  sessionIssueChips,
  sessionSeverityChips,
  sessionRepairBatchEntry,
  sessionRepairCommands,
  sessionRepairEntries,
  sessionRepairReasonKey,
  sessionRepairVerifyKey,
  type SessionHealthResponse,
  type SessionRepairBatchEntryView,
  type SessionRepairEntryView,
  type SessionRepairResult,
} from '../../ui/session-inventory-view.ts'
import {
  sessionLayoutApplyItems,
  sessionLayoutCandidates,
  sessionLayoutKeepState,
  sessionLayoutOverallReasonKey,
  sessionLayoutPlanDisplayRows,
  sessionLayoutPlanSkippedCount,
  sessionLayoutPlanSubmittable,
  sessionLayoutResultCounts,
  sessionLayoutSectionState,
  type SessionLayoutApplyView,
  type SessionLayoutPlanView,
  type SessionLayoutPort,
} from '../../ui/session-layout-view.ts'
import { sessionIssueKey, sessionIssuesText } from '../../ui/session-issue-labels.ts'
import {
  sessionExportEntryState,
  sessionExportReasonText,
  type SessionExportProbe,
} from '../session-export/session-export-view.ts'
import { runStore, type RecoveryStoreSlice } from '../run-store.ts'
import type { CrashReport, IncidentApi, RescueStatus } from './incident-api.ts'
import { IncompleteCopiesSection } from './IncompleteCopiesSection.tsx'
import {
  isSnapshotTrusted, isVerdictAttention, isVerdictSuccess, recoveryBlockReason, toRecoveryPreviewView,
  toRecoveryView,
  crashAdviceKey,
  crashReasonKey,
  formatRecoveryTime,
  rescueHintKey,
} from './recovery-view.ts'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

/**
 * 宿主/错误文本渲染前统一过 redact（AGENTS.md §UI 硬性规则 7；client-F4）。
 * 单列成一行：plan-text-redaction.test.ts 的「按渲染点」登记表需要一个唯一锚点。
 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/**
 * 维护与诊断「折叠卡」的折叠体 id（aria-controls 恒有值 —— Collapse 容器始终存在）。
 * 一块一个常量：id 字面量散在 JSX 里最容易复制粘贴出重复 id，aria-controls 就指错了。
 * 2026-10-12：会话体检与回滚卡退出折叠，折叠只剩**救援模式**一块（且只在真有明细时渲染开关）。
 */
const RESCUE_BODY_ID = 'dcm-rescue-mode-body'

/**
 * E2：布局归位端口 = `RecoveryPort` 的**可选**扩展（面板只用 `layoutRepairSessions`）。
 *
 * 为什么是 Partial：`src/ui/types.ts` 的 RecoveryPort 契约文件不在本次改动范围内，而注入的实现
 * （`src/client/recovery/recovery-api.ts` 的 `RecoveryApi`）一定带这个方法。可选形态让所有既有
 * 调用点（按 RecoveryPort 传值）原样可编译；运行时若真缺失，面板走 `sessions.layout.apiMissing`
 * 如实提示并且**一条也不执行**，绝不假装有能力。
 */
type LayoutRecoveryApi = RecoveryPort & Partial<SessionLayoutPort> & Partial<RollbackPointPort>

export interface RecoveryPanelProps {
  /** 事故处置（崩溃归因 + 救援模式）API；与 recoveryApi 同属「事故恢复」子 tab */
  incidentApi: IncidentApi
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  /**
   * **主字典**（config-manager）翻译器 —— 仅供 CopyButton 这类「共用原语」使用：
   * 它们的内置文案（剪贴板 Toast）住在主字典里，而本面板的 `t` 是 recovery 命名空间。
   * 两个字典的键集不通用，因此显式分开传，不做类型强转。
   */
  copyT?: TranslateNS<'config-manager'>
  /**
   * 磁盘体检卡的 ⓘ 可访问名（第 2 块「磁盘占用与清理」）。
   * 与 copyT 同一条理由：DiskUsageCard 的文案走 **UiT** 字典，它的 ⓘ 可访问名却住在主字典里
   * （`common.infoHint`），本面板手上只有 recovery 字典 —— 所以由调用方显式传。
   */
  infoHintLabel?: string
  /**
   * 磁盘体检端口（第 2 块）。
   * 直接传 ConfigManagerApi 而不是收窄成两个方法：DiskUsageCard 的 props 就是 `api`，
   * 收窄反而要在中间加一层适配（且下游一改就要跟着改）。类型收窄的收益在这里是假的。
   */
  diskApi: import('../api.ts').ConfigManagerApi
}

interface PanelState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  recovery: RecoveryStatus | null
  selectedOperationId: string | null
  preview: RecoveryPreview | null
  previewLoading: boolean
  verifyResult: RecoveryVerifyResult | null
  running: boolean
  actionError: string | null
}

const initial: PanelState = {
  status: 'loading',
  error: null,
  recovery: null,
  selectedOperationId: null,
  preview: null,
  previewLoading: false,
  verifyResult: null,
  running: false,
  actionError: null,
}

/** 从 runStore 恢复上次的 recovery 面板状态（切 tab 回 / 刷新后挂载）。 */
function initFromStore(): PanelState {
  const s: RecoveryStoreSlice = runStore.getSnapshot().recovery
  return {
    ...initial,
    recovery: s.status,
    selectedOperationId: s.selectedOperationId,
    preview: s.preview,
    verifyResult: s.verifyResult,
    running: s.running,
    error: s.error,
    actionError: s.actionError,
  }
}

/** PanelState → RecoveryStoreSlice（镜像进 runStore；status 字段语义不同，需显式映射）。 */
function toSlice(s: PanelState): RecoveryStoreSlice {
  return {
    status: s.recovery,
    selectedOperationId: s.selectedOperationId,
    preview: s.preview,
    verifyResult: s.verifyResult,
    running: s.running,
    error: s.error,
    actionError: s.actionError,
  }
}

/** decision → 徽章语义。 */
function decisionBadgeKind(decision: string): 'info' | 'ok' | 'warn' | 'error' {
  switch (decision) {
    case 'rollback-recommended': return 'warn'
    case 'rollback-continue': return 'warn'
    case 'needs-attention': return 'error'
    default: return 'info'
  }
}

/** decision → 文案键。 */
function decisionLabel(t: TranslateNS<'config-manager-recovery'>, decision: string): string {
  switch (decision) {
    case 'rollback-recommended': return t('recovery.rollbackRecommended')
    case 'rollback-continue': return t('recovery.rollbackContinue')
    case 'needs-attention': return t('recovery.needsAttention')
    default: return t('recovery.decision.unknown')
  }
}

/** verdict → 文案键。 */
function verdictLabel(t: TranslateNS<'config-manager-recovery'>, verdict: string): string {
  switch (verdict) {
    case 'MATCH': return t('recovery.verified')
    case 'PARTIAL_MATCH': return t('recovery.partialMatch')
    case 'MISMATCH': return t('recovery.mismatch')
    case 'VERIFICATION_ERROR': return t('recovery.verificationError')
    default: return t('recovery.verify.verdict.unknown')
  }
}

/** verdict → 徽章语义。 */
function verdictBadgeKind(verdict: string): 'info' | 'ok' | 'warn' | 'error' {
  switch (verdict) {
    case 'MATCH': return 'ok'
    case 'PARTIAL_MATCH': return 'warn'
    case 'MISMATCH': return 'error'
    case 'VERIFICATION_ERROR': return 'error'
    default: return 'info'
  }
}

/** snapshot verdict → 文案键。 */
function snapshotVerdictLabel(t: TranslateNS<'config-manager-recovery'>, verdict: string | null): string {
  switch (verdict) {
    case 'TRUSTED_OPERATION_SNAPSHOT': return t('recovery.snapshot.verdict.trusted')
    case 'TRUSTED_MANUAL_LOCAL': return t('recovery.snapshot.verdict.manual')
    case 'LEGACY_REQUIRES_CONFIRMATION': return t('recovery.snapshot.verdict.legacy')
    case 'WRONG_ENVIRONMENT': return t('recovery.snapshot.verdict.wrongEnv')
    case 'CORRUPT': return t('recovery.snapshot.verdict.corrupt')
    case 'INVALID': return t('recovery.snapshot.verdict.invalid')
    case 'UNSAFE_PATH': return t('recovery.snapshot.verdict.unsafe')
    default: return t('recovery.snapshot.verdict.unknown')
  }
}

/** incident 原始状态值 → 用户可懂的中文标签（未知名回退 unknown，绝不透出英文原文）。 */
function incidentStateLabel(t: TranslateNS<'config-manager-recovery'>, state: string): string {
  switch (state) {
    case 'RECOVERING': return t('recovery.incident.state.recovering')
    case 'NEEDS_ATTENTION': return t('recovery.incident.state.needsAttention')
    case 'ROLLED_BACK': return t('recovery.incident.state.rolledBack')
    case 'RECOVERED': return t('recovery.incident.state.recovered')
    case 'COMMITTED': return t('recovery.incident.state.committed')
    default: return t('recovery.incident.state.unknown')
  }
}

/**
 * 「会话体检」区块（T5）—— 事故恢复子 tab 的只读扫描。
 *
 * 数据流：`recoveryApi.sessions()`（只读路由）→ `ui/session-inventory-view.ts` 的展示模型 → 渲染。
 * **本组件不做任何业务判断**（严重级/摘要/空态/截断全在纯函数里），只装配 + 交互状态。
 *
 * 硬约束（known-gaps G-24 / T8 / T9）：应用内只做**能从字节证明**的修复 —— 零损失（重放重复行 /
 * 可证明的合成收尾块）与**有损截断**（seq 空洞 / 不可解析行，必须用户显式确认）；
 * 每一条都过服务层的写入门与预览-应用指纹，另有备份可一键回滚。其余类别只提供「复制离线命令」。
 */
/**
 * 缺省剪贴板翻译器：本区块只用到「复制成功/失败」两条通用反馈，且**绝不**编造主字典之外的键。
 * 返回键名本身（与字典缺键时的回退语义一致），保证缺省路径也不会抛错或渲染出空文案。
 */
const EMPTY_COPY_T: TranslateNS<'config-manager'> = ((key: string) => key) as TranslateNS<'config-manager'>

function SessionHealthCard({ recoveryApi, t, copyT, diskApi }: Pick<RecoveryPanelProps, 'recoveryApi' | 't' | 'copyT' | 'diskApi'>) {
  /**
   * 剪贴板反馈的翻译器（config-manager 命名空间）。缺省 = `EMPTY_COPY_T`（**返回键名本身**，
   * 与字典缺键的回退语义一致）—— 不传 copyT 时渲染的是键名，缺省路径不会出现中文。
   */
  const clipboardT = copyT ?? EMPTY_COPY_T
  /** 体检结果住**卡片**里：弹窗每次打开重新扫一遍（scanVersion 变化即重扫），关掉不留一屏陈旧数据。 */
  const [response, setResponse] = useState<SessionHealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [scanVersion, setScanVersion] = useState(0)
  const scan = (): void => { setScanVersion((v) => v + 1) }
  /**
   * F-2：官方 session.export 端的可用性探测（一次；打开弹窗时顺带探）。
   *
   * 为什么**只在打开弹窗时**探：探测要走一次宿主自请求，用户没进这个界面时毫无意义；
   * 而进程内缓存（setState 在卡片上）保证同一次对话里只探一次 —— 后端能力不会中途变化。
   * 探测失败（网络/宿主异常）**不写 error**：它是「下载入口的可用性未知」，不是体检失败。
   */
  const [zipProbe, setZipProbe] = useState<SessionExportProbe | null>(null)
  const zipChecked = useRef(false)
  useEffect(() => {
    if (!open || zipChecked.current) return
    zipChecked.current = true
    let alive = true
    diskApi.sessionExportProbe()
      .then((probe) => { if (alive) setZipProbe(probe) })
      // 探测本身失败（宿主不可达等）→ 落到保守三态：**绝不**改判成不可用而把入口藏掉。
      .catch(() => { if (alive) setZipProbe({ availability: 'unknown', reason: 'network-error', status: 0, path: '', checkedAt: new Date().toISOString() }) })
    return () => { alive = false }
  }, [open, diskApi])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    recoveryApi.sessions()
      .then((next) => { if (alive) { setResponse(next); setLoading(false) } })
      .catch((err) => { if (alive) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) } })
    return () => { alive = false }
  }, [open, scanVersion, recoveryApi])

  const summary = sessionHealthSummaryView(response)
  const repairEntries = sessionRepairEntries(response)

  return (
    <Card className={css.card}>
      <div className={css.statRow}>
        <strong>{t('sessions.title')}</strong>
        {/* 徽章语义：扫描只读；修复是显式动作（预览 → 确认 → 自动备份 → 可回滚） */}
        <Badge kind="info">{t('sessions.readOnly')}</Badge>
        <InfoHint text={t('sessions.desc')} label={t('common.infoHint')} />
        <span className={css.statusSpacer} />
      </div>
      {/* T10：结果全部搬进独立弹窗 —— 卡片只留入口与一行摘要，绝不把上千行塞进设置页。
          2026-10-12 用户要求：本卡**退出折叠**，入口与摘要常驻可见（不再有 chevron）。 */}
      {/* 2026-10-12 用户要求：预扫描说明文案已删（点按钮即扫，屏上只留真正的摘要）。 */}
      {summary !== null && response !== null && (
        <div className={css.hint}>
          {t('sessions.dialog.lastScan', {
            total: String(summary.total),
            issues: String(summary.needsAttention),
            repairs: String(repairEntries.length),
          })}
        </div>
      )}
      <div className={css.actionRow}>
        <Button variant="ghost" loading={loading} onClick={() => { setOpen(true) }}>
          {loading ? t('sessions.scanning') : t('sessions.dialog.open')}
        </Button>
      </div>
      {/*
        弹窗**只在打开时挂载**：它是整屏内容的组件，常驻会让卡片每次重渲染都带着它一起走
        （真机反馈：弹窗加载一会儿后整个设置页变空白）。关闭即卸载，状态随之释放。
      */}
      {open && (
        <SessionHealthDialog
          open={open}
          onClose={() => { setOpen(false) }}
          recoveryApi={recoveryApi}
          t={t}
          clipboardT={clipboardT}
          response={response}
          loading={loading}
          error={error}
          onScan={scan}
          zipProbe={zipProbe}
          api={diskApi}
        />
      )}
    </Card>
  )
}

/**
 * 「会话体检」弹窗（T10）—— 结果与全部动作都在这里：摘要在顶、列表在中（限高内滚）、
 * 修复计划与台账在底部。**本组件不做任何业务判断**（严重级/摘要/可修判定/原因映射全在 ui/ 纯函数里）。
 *
 * 交互约定：打开即扫（scanVersion 变化重扫）；修复一律先 dry-run 预览（零写入），有损计划必须再点
 * 「截断并修复」才执行；回滚走 ConfirmDialog（danger）。
 */
interface SessionHealthDialogProps {
  open: boolean
  onClose: () => void
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  clipboardT: TranslateNS<'config-manager'>
  response: SessionHealthResponse | null
  loading: boolean
  error: string | null
  onScan: () => void
  /** F-2：官方 session.export 的可用性（null = 还没探出来 → 入口显示加载态，不误判禁用）。 */
  zipProbe: SessionExportProbe | null
  /** 供「下载原始日志 (ZIP)」拼下载地址（同一份 api 实例，别新起一个）。 */
  api: import('../api.ts').ConfigManagerApi
}

/**
 * E2：面板「会话布局归位 / 重复 id 隔离」写入口（宿主 E1：`POST /recovery/sessions/layout`）。
 *
 * 与字节级修复（/repair）的分工：那条改日志**字节**，这条改**位置** —— 把会话目录搬回首帧 cwd
 * 对应的 projectKey 段，并把重复 id 的其它副本移进隔离目录（可人工找回）。
 *
 * 安全口径（键 `sessions.layout.runtimeNote`，必须让用户看见）：本入口在 **DSH 运行时**执行，
 * 与离线 CLI `dcm sessions repair --fix` 的「须先停 DSH」不同 —— 靠门前置（SAFE MODE / mutation lock /
 * 逐目标无 session.lock + 不在静止期）+ 索引刷新必须成功 + 失败逐条回滚兜底；宿主没给索引刷新端口时
 * **一条也不执行**（`reindex-unavailable`，绝不显示成成功）。
 *
 * 硬约束：**本组件不做任何业务判断** —— 候选筛选 / keep 完整性 / 可否提交 / 逐条状态与计数全在
 * `ui/session-layout-view.ts`（含「未执行 / 已回滚不得算成功」的判定），组件只装配与渲染。
 */
interface SessionLayoutSectionProps {
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  response: SessionHealthResponse | null
  /** 执行后重扫列表（结果已落盘，列表必须跟着刷新） */
  onScan: () => void
}

function SessionLayoutSection({ recoveryApi, t, response, onScan }: SessionLayoutSectionProps) {
  const [plan, setPlan] = useState<SessionLayoutPlanView | null>(null)
  const [applied, setApplied] = useState<SessionLayoutApplyView | null>(null)
  /** sessionId → 用户选定保留的副本 unitId（提交判定在 sessionLayoutKeepState） */
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  /** 客户端/传输层失败（宿主的拒绝走结果里的机器码，不进这里） */
  const [failure, setFailure] = useState<string | null>(null)

  const candidates = sessionLayoutCandidates(response)
  const keepState = sessionLayoutKeepState(plan, keep)
  const submittable = sessionLayoutPlanSubmittable(plan, keepState)
  const planRows = sessionLayoutPlanDisplayRows(plan)
  const skippedCount = sessionLayoutPlanSkippedCount(plan)
  const planReasonKey = sessionLayoutOverallReasonKey(plan?.reason)
  const appliedReasonKey = sessionLayoutOverallReasonKey(applied?.reason)
  const appliedItems = sessionLayoutApplyItems(applied)
  const counts = sessionLayoutResultCounts(appliedItems)

  const preview = (): void => {
    if (busy !== null) return
    setBusy('preview')
    setFailure(null)
    const request = recoveryApi.layoutRepairSessions?.(false)
    if (request === undefined) {
      setFailure(t('sessions.layout.apiMissing'))
      setBusy(null)
      return
    }
    request
      .then((next) => {
        if ('results' in next) { setApplied(next); return }
        setPlan(next)
        setKeep({})
        setApplied(null)
      })
      .catch((err) => { setFailure(redactErrorText(err)) })
      .finally(() => { setBusy(null) })
  }

  const apply = (): void => {
    if (busy !== null || !submittable) return
    setBusy('apply')
    setFailure(null)
    const request = recoveryApi.layoutRepairSessions?.(true, keep)
    if (request === undefined) {
      setFailure(t('sessions.layout.apiMissing'))
      setBusy(null)
      return
    }
    request
      .then((next) => {
        if ('results' in next) {
          setApplied(next)
          // 结果已落盘（含逐条回滚）：重扫列表是唯一权威，结果视图保留到用户关闭
          onScan()
          return
        }
        setPlan(next)
        setKeep({})
        setApplied(null)
      })
      .catch((err) => { setFailure(redactErrorText(err)) })
      .finally(() => { setBusy(null) })
  }

  // 扫过之后入口**始终可见**（否则本机没有这一档的用户根本找不到它）；只有「还没扫过且手上没计划/结果」才隐藏。
  const sectionState = sessionLayoutSectionState({ response, plan, applied })
  if (sectionState === 'hidden') return null

  /**
   * 本档是否**真的有可执行的动作**。
   *
   * 空档（empty）时三段机制散文（desc / runtimeNote / quarantineNote）整段不渲染 ——
   * 旧实现把它们无条件铺满：本机没有这一档的用户要先读 6 行灰字，才能读到「没有候选」这一句。
   * 机制说明（怎么归位 / 为什么会不一致）改走 ⓘ；安全口径（运行时写入门 / 隔离目录不删会话）
   * **只在真有动作要执行时**常驻 —— DESIGN.md §7「说明性文案分层」。
   */
  const actionable = sectionState !== 'empty'

  return (
    <div className={css.card}>
      <div className={css.shSectionHead}>
        <span className={css.groupLabel}>{t('sessions.layout.title')}</span>
        <InfoHint text={t('sessions.layout.desc')} label={t('common.infoHint')} />
      </div>
      {/* 与离线 CLI 的差异（它要求先停 DSH）：真会写盘时才占据屏幕（安全告警类，必须可见） */}
      {actionable && <Banner kind="warn">{t('sessions.layout.runtimeNote')}</Banner>}
      {sectionState === 'empty' && <div className={css.hint}>{t('sessions.layout.noCandidates')}</div>}
      {candidates.length > 0 && (
        <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
          {candidates.map((candidate) => (
            <div key={candidate.unitId} className={css.shRow}>
              <div className={css.shRowTop}>
                <span className={`${css.shRowId} ${css.mono}`} title={candidate.unitId}>{candidate.sessionId}</span>
              </div>
              <div className={css.shRowMeta}>
                <span>{sessionIssuesText(candidate.issueCodes, t)}</span>
                <span className={css.shMetaDot} aria-hidden="true">·</span>
                <span className={css.mono}>{candidate.projectKey}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={css.actionRow}>
        <Button variant={actionable ? 'primary' : 'ghost'} loading={busy === 'preview'} disabled={busy !== null} onClick={preview}>
          {busy === 'preview' ? t('sessions.layout.previewing') : t('sessions.layout.preview')}
        </Button>
      </div>
      {failure !== null && <Banner kind="error">{failure}</Banner>}
      {applied === null && plan !== null && (
        <div className={css.shPanel}>
          <div className={css.shPanelHead}>
            <span className={css.shPanelTitle}>{t('sessions.layout.planTitle')}</span>
            <InfoHint text={t('sessions.layout.planReadOnly')} label={t('common.infoHint')} />
          </div>
          <div className={css.hint}>
            {t('sessions.layout.summary', { move: String(plan.summary.move), quarantine: String(plan.summary.quarantine) })}
          </div>
          {planReasonKey !== null && <Banner kind="warn">{t(planReasonKey)}</Banner>}
          {planRows.length === 0 && <div className={css.hint}>{t('sessions.layout.planEmpty')}</div>}
          {planRows.length > 0 && (
            <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
              {planRows.map((row) => (
                <div key={row.unitId} className={css.shRow}>
                  <div className={css.shRowTop}>
                    <Badge kind="info">{t(row.kindKey)}</Badge>
                    {row.kind === 'skip' && <Badge kind="warn">{t('sessions.layout.onlyReported')}</Badge>}
                    <span className={`${css.shRowId} ${css.mono}`} title={row.unitId}>{row.sessionId}</span>
                  </div>
                  <div className={css.shRowMeta}>
                    <span>{row.toProjectKey !== null ? row.fromProjectKey + ' → ' + row.toProjectKey : row.fromProjectKey}</span>
                    <span className={css.shMetaDot} aria-hidden="true">·</span>
                    <span>{t(row.reasonKey)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {skippedCount > 0 && (
            <div className={css.hint}>{t('sessions.layout.planSkipped', { count: String(skippedCount) })}</div>
          )}
          {/* 重复 id：必须选定保留哪一份才可提交（判定在 ui 纯函数层） */}
          {plan.needsKeep.length > 0 && (
            <>
              <div className={css.groupLabel}>{t('sessions.layout.keepTitle')}</div>
              <div className={css.hint}>{t('sessions.layout.keepHint')}</div>
              {/* 隔离目录口径（会搬走用户的会话文件 ⇒ 安全类，必须可见）：只在真要处理重复 id 时出现 */}
              <div className={css.hint}>{t('sessions.layout.quarantineNote')}</div>
              {plan.needsKeep.map((sessionId) => (
                <div key={sessionId} className={css.conflictChoices} role="radiogroup" aria-label={sessionId}>
                  {(keepState.candidates[sessionId] ?? []).map((unitId) => {
                    const selected = keep[sessionId] === unitId
                    return (
                      <label key={unitId} className={css.choiceCard} data-selected={selected ? '' : undefined}>
                        <input
                          type="radio"
                          name={'layout-keep-' + sessionId}
                          checked={selected}
                          onChange={() => { setKeep((prev) => ({ ...prev, [sessionId]: unitId })) }}
                        />
                        <span className={css.choiceTitle}>{unitId}</span>
                      </label>
                    )
                  })}
                </div>
              ))}
              {!keepState.complete && (
                <div className={css.hint}>{t('sessions.layout.keepMissing', { count: String(keepState.missing.length) })}</div>
              )}
            </>
          )}
          <div className={css.actionRow}>
            {/* 未选定 keep / 计划不可用 ⇒ 不可提交（判定在 ui 纯函数层） */}
            <Button variant="primary" loading={busy === 'apply'} disabled={busy !== null || !submittable} onClick={apply}>
              {busy === 'apply' ? t('sessions.layout.applying') : t('sessions.layout.apply')}
            </Button>
          </div>
        </div>
      )}
      {applied !== null && (
        <div className={css.shPanel}>
          <div className={css.shPanelHead}>
            <span className={css.shPanelTitle}>{t('sessions.layout.resultTitle')}</span>
          </div>
          {/* 整体未执行（如 reindex-unavailable）**不是**成功：单独说明，且下面不会有任何成功条目 */}
          {appliedReasonKey !== null && <Banner kind="warn">{t(appliedReasonKey)}</Banner>}
          {appliedItems.length > 0 && (
            <div className={css.hint}>
              {t('sessions.layout.done', {
                moved: String(counts.moved),
                quarantined: String(counts.quarantined),
                failed: String(counts.failedTotal),
                skipped: String(counts.skipped),
              })}
            </div>
          )}
          {appliedItems.length > 0 && (
            <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
              {appliedItems.map((item, index) => (
                <div key={item.unitId + '#' + String(index)} className={css.shRow}>
                  <div className={css.shRowTop}>
                    <Badge kind={item.badgeKind}>{t(item.statusKey)}</Badge>
                    <span className={`${css.shRowId} ${css.mono}`} title={item.unitId}>{item.sessionId}</span>
                  </div>
                  <div className={css.shRowMeta}>
                    <span>{item.reasonKey !== null ? t(item.reasonKey) : ''}</span>
                    <span>{item.movedUnitId !== null ? ' → ' + item.movedUnitId : ''}</span>
                    <span>{item.quarantineDir !== null ? ' → ' + item.quarantineDir : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={css.hint}>{t('sessions.layout.refreshHint')}</div>
          <div className={css.actionRow}>
            <Button variant="ghost" onClick={() => { setApplied(null); setPlan(null); setKeep({}) }}>
              {t('sessions.layout.close')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
function SessionHealthDialog(props: SessionHealthDialogProps) {
  const { open, onClose, recoveryApi, t, clipboardT, response, loading, error, onScan, zipProbe, api } = props
  /**
   * F-2：「下载原始日志 (ZIP)」入口的三态判定（**唯一**判定点在 ui/ 纯函数里，组件只映射）。
   *
   * 为什么不在组件里判 `status !== 501`（竞品做法）：那条判据在本机 DSH 上**已过时** ——
   * 服务缺失返的是 500 而不是 501，照抄会让入口几乎恒显示。判定与理由见 session-export-view.ts。
   */
  const zipState = sessionExportEntryState(zipProbe)
  const zipHint = sessionExportReasonText(zipState, t)
  const phase = sessionHealthPhase({ loading, error, response })
  /**
   * 本地的「已修复」行集合：批量/单条修复成功后**就地更新界面**，不再整屏重扫。
   *
   * 为什么：重扫要重新遍历整个会话库（真机 1024 条、行档 200 条），用户点完「一键修复」
   * 会被迫再等一次全量扫描、列表还会整屏重排。这里只把受影响的行标成「已修复并移出列表」，
   * 需要最新全貌时用户自己点「开始体检」。
   *
   * **声明必须在使用它的 `rows` 之前** —— 后置声明会触发 TDZ 的
   * `ReferenceError: Cannot access 'repairedUnits' before initialization`，
   * 而插槽异常会把整个插件面板（settings.section）整块打掉（真机白屏）。
   */
  const [repairedUnits, setRepairedUnits] = useState<ReadonlySet<string>>(new Set())
  // 已修复的行就地移出列表（不需要重扫：宿主那边确实改了文件，这里只是不再显示）
  const rows = sessionHealthRows(response).filter((row) => !repairedUnits.has(row.unitId))
  const summary = sessionHealthSummaryView(response)
  const truncated = sessionHealthTruncated(response)
  const repairEntries = sessionRepairEntries(response)
  /** 严重级 chips（只留 count>0 的档，短标签进屏 / 完整句进 title）—— 判定与顺序全在 ui 纯函数层 */
  const severityChips = sessionSeverityChips(summary)
  /** 正在预览 / 应用 / 回滚的 unitId（进行中态住组件内；弹窗不跨页签） */
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * F-2：正在下载原始日志的会话 id（进行中态住组件内 —— 弹窗不跨页签，无需进 runStore）。
   *
   * 为什么必须有：ZIP 可达数百 MB，点下去到浏览器开始落盘之间可能好几秒，
   * 没有任何反馈会被当成「点了没反应」而反复点击。
   */
  const [zipBusy, setZipBusy] = useState<string | null>(null)
  /** 触发一次 ZIP 下载；**失败必须显式报告**（绝不静默）。 */
  const downloadZip = (sessionId: string): void => {
    if (zipBusy !== null) return
    setZipBusy(sessionId)
    api.downloadSessionExport(sessionId)
      .then((result) => { toast.ok(t('sessions.zip.done', { name: result.filename })) })
      // 错误文本走 toast（与本节其它动作同一口径；http 层已脱敏）。
      .catch((err) => { toast.error(t('sessions.zip.failed') + ': ' + redactErrorText(err)) })
      .finally(() => { setZipBusy(null) })
  }
  /** 预览得到的修复计划（应用前必须显式确认；ok=false 时也在这里显示拒绝原因） */
  const [plan, setPlan] = useState<{ unitId: string; result: SessionRepairResult } | null>(null)
  /**
   * 应用成功后的结果（含写后真 codec 复验结论）。
   *
   * 为什么必须有：修复「写完了」与「DSH 现在能读它」是两件事 —— 没有复验结论时（如 unavailable）
   * 把这次修复当成普通成功呈现，正是本轮要消灭的谎报。行已从列表移出，所以结果留在这里。
   */
  const [applied, setApplied] = useState<{ unitId: string; result: SessionRepairResult } | null>(null)
  /**
   * 复验三态 / 危险态的字典键（**判定全部在 ui 纯函数层**，组件只装配 —— 见 sessionRepairVerifyKey）。
   * null = 没有复验结论（预览路径）⇒ 不渲染这一行，绝不臆造「已验证」。
   */
  const planVerifyKey = plan !== null ? sessionRepairVerifyKey(plan.result.verify, plan.result.rolledBack) : null
  const appliedVerifyKey = applied !== null ? sessionRepairVerifyKey(applied.result.verify, applied.result.rolledBack) : null
  /** 待确认的回滚目标（ConfirmDialog，danger） */
  const [rollbackTarget, setRollbackTarget] = useState<SessionRepairEntryView | null>(null)
  /**
   * 一键修复全部：进行中 + 本轮结果。
   *
   * `results` 逐条留痕（单位 id / 备份名 / 成功或被拒的**机器可读原因**）——用户点完必须看得见
   * 「哪几条成了、哪几条为什么没成」，绝不只给一个计数。
   */
  const [batchBusy, setBatchBusy] = useState(false)
  const [batch, setBatch] = useState<{ ok: number; failed: number; results: SessionRepairBatchEntryView[] } | null>(null)

  const startRepair = (unitId: string): void => {
    setBusy(unitId)
    setPlan(null)
    setApplied(null)
    recoveryApi.repairSession(unitId, false)
      .then((result) => { setPlan({ unitId, result }); setBusy(null) })
      .catch((err) => { toast.error(redactErrorText(err)); setBusy(null) })
  }

  /**
   * 一键修复全部：对**当前列表里可修的行**逐条走完整安全序列（预览 → 应用）。
   *
   * 三条纪律：① **逐条独立** —— 一条被拒（指纹变化 / 校验不过 / 有损未确认）不影响其余；
   * ② **有损不批量** —— 需要截断（lossy）的计划跳过并计入 failed，绝不代替用户做有损决定；
   * ③ 结果如实计数（成功/被拒），做完重新扫描（台账与列表随之刷新）。
   */
  const repairAll = async (): Promise<void> => {
    const targets = rows.filter((row) => row.repairable).map((row) => row.unitId)
    if (targets.length === 0) return
    setBatchBusy(true)
    setBatch(null)
    let ok = 0
    let failed = 0
    const results: SessionRepairBatchEntryView[] = []
    const done: string[] = []
    for (const unitId of targets) {
      setBusy(unitId)
      try {
        const plan = await recoveryApi.repairSession(unitId, false)
        if (!plan.ok) {
          failed += 1
          results.push(sessionRepairBatchEntry({
            unitId,
            sessionId: plan.sessionId ?? unitId,
            ok: false,
            ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
          }))
          continue
        }
        if (plan.lossy === true) {
          // 有损（截断）绝不批量代做 —— 逐条确认是硬约束，这里如实说明「需要你逐条确认」
          failed += 1
          results.push(sessionRepairBatchEntry({ unitId, sessionId: plan.sessionId ?? unitId, ok: false, reason: 'lossy-required', lossy: true }))
          continue
        }
        const applied = await recoveryApi.repairSession(unitId, true, plan.expect)
        if (applied.ok) {
          ok += 1
          done.push(unitId)
          results.push(sessionRepairBatchEntry({
            unitId,
            sessionId: applied.sessionId ?? unitId,
            ok: true,
            droppedRows: applied.droppedRows ?? 0,
            ...(applied.verify !== undefined ? { verify: applied.verify } : {}),
            ...(applied.rolledBack !== undefined ? { rolledBack: applied.rolledBack } : {}),
          }))
        } else {
          failed += 1
          // A2-F1：失败分支与成功分支**同源**搬运 —— verify-failed 必带 verify，
          // rolledBack===false（自动回滚未成功）是危险态，必须在批量视图里可见。
          results.push(sessionRepairBatchEntry({
            unitId,
            sessionId: applied.sessionId ?? unitId,
            ok: false,
            ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
            ...(applied.verify !== undefined ? { verify: applied.verify } : {}),
            ...(applied.rolledBack !== undefined ? { rolledBack: applied.rolledBack } : {}),
          }))
        }
      } catch (err) {
        failed += 1
        results.push(sessionRepairBatchEntry({
          unitId,
          sessionId: unitId,
          ok: false,
          transportError: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    setBusy(null)
    setBatchBusy(false)
    setBatch({ ok, failed, results })
    // **就地更新**：把修好的行标成「已修复」并从列表移除，不再整屏重扫（用户要最新全貌时自己点体检）
    if (done.length > 0) setRepairedUnits((prev) => new Set([...prev, ...done]))
    if (ok > 0) toast.ok(t('sessions.repair.applied', { rows: String(results.filter((r) => r.ok).reduce((n, r) => n + (r.droppedRows ?? 0), 0)) }))
  }

  /** 确认应用：带上预览指纹（TOCTOU）；有损计划必须显式放行（applyLossy）。 */
  const applyRepair = (): void => {
    if (plan === null) return
    const { unitId, result } = plan
    setBusy(unitId)
    recoveryApi.repairSession(unitId, true, result.expect, result.lossy === true)
      .then((next) => {
        if (next.ok) {
          toast.ok(t('sessions.repair.applied', { rows: String(next.droppedRows ?? 0) }))
          setPlan(null)
          // 结果（含复验三态）留在面板上：绝不把「写完了」说成「已可加载」
          setApplied({ unitId, result: next })
          setRepairedUnits((prev) => new Set([...prev, unitId]))
        } else {
          // 应用期被拒（指纹变化 / 校验不过 / 写失败）：**就地给出真实原因**，不假装成功
          setPlan({ unitId, result: next })
        }
        setBusy(null)
      })
      .catch((err) => { toast.error(redactErrorText(err)); setBusy(null) })
  }

  const doRollback = async (): Promise<void> => {
    const target = rollbackTarget
    if (target === null) return
    setBusy(target.unitId)
    try {
      const result = await recoveryApi.rollbackSessionRepair(target.repairId)
      if (result.ok) {
        toast.ok(t('sessions.repair.rolledBack'))
        setRollbackTarget(null)
        onScan()
      } else {
        toast.error(t(sessionRepairReasonKey(result.reason)))
        setRollbackTarget(null)
      }
    } catch (err) {
      toast.error(redactErrorText(err))
      setRollbackTarget(null)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={t('sessions.title')} wide busy={busy !== null}>
        <Modal.Header
          title={t('sessions.title')}
          onClose={onClose}
          closeLabel={t('common.close')}
          trailing={(
            <span className={css.shHeaderTrailing}>
              {/* 机制说明（扫什么 / 四档严重级 / 哪些能在应用内修）—— 与入口卡片上那颗 ⓘ 同一条键 */}
              <InfoHint text={t('sessions.desc')} label={t('common.infoHint')} />
              {/* 主操作搬进标题行：旧实现是正文左上角孤零零一颗按钮（要先滚过摘要才找得到） */}
              <Button
                size="sm"
                variant={response === null ? 'primary' : 'ghost'}
                loading={loading}
                disabled={loading}
                onClick={onScan}
              >
                {loading ? t('sessions.scanning') : response === null ? t('sessions.scan') : t('sessions.rescan')}
              </Button>
            </span>
          )}
        />
        <Modal.Body scroll>
          {zipHint !== null && <Banner kind="warn">{zipHint}</Banner>}

          {phase === 'error' && <Banner kind="error">{error ?? t('common.unknownError')}</Banner>}

          {/* 首次扫描（还没有任何结果）：给出进行中反馈 —— 旧实现在这里只留一片空白 */}
          {/* 首次扫描：按会话表的形状铺骨架（表格行），扫描结果到货时表格原地长出来 */}
          {phase === 'loading' && response === null && <SkeletonTable rows={6} label={t('sessions.scanning')} />}

          {phase === 'ready' && response !== null && (
            <>
              {!response.sessionsDirExists && <Banner kind="warn">{t('sessions.noRoot')}</Banner>}
              {response.sessionsDirExists && sessionHealthEmpty(response) && <Empty>{t('sessions.empty')}</Empty>}
              {summary !== null && summary.total > 0 && (
                <>
                  {/* ① 概览：先把数字给出来（旧实现是一串同款徽章，看不出哪个数是重点） */}
                  <div className={css.shSummary}>
                    <div className={css.shMetrics}>
                      <div className={css.shMetric}>
                        <span className={css.shMetricValue}>{String(summary.total)}</span>
                        <span className={css.shMetricLabel}>{t('sessions.metric.total')}</span>
                      </div>
                      <div className={css.shMetric} data-tone={summary.needsAttention > 0 ? 'warn' : 'ok'}>
                        <span className={css.shMetricValue}>{String(summary.needsAttention)}</span>
                        <span className={css.shMetricLabel}>{t('sessions.metric.attention')}</span>
                      </div>
                      {summary.targetFormatVersion !== null && (
                        <div className={css.shMetric}>
                          <span className={css.shMetricValue}>{'v' + String(summary.targetFormatVersion)}</span>
                          <span className={css.shMetricLabel}>{t('sessions.metric.format')}</span>
                        </div>
                      )}
                    </div>
                    {severityChips.length > 0 && (
                      <div className={css.shSeverities}>
                        {severityChips.map((chip) => (
                          <span key={chip.severity} className={css.shSeverity} data-severity={chip.severity} title={t(chip.fullKey)}>
                            <StatusDot kind={chip.badgeKind} />
                            <span>{t(chip.shortKey)}</span>
                            <span className={css.shSeverityCount}>{String(chip.count)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* 数据口径：这次统计覆盖了多少（未深度校验 / 被隐藏的正常会话 / 超上限 / 读不出条目）。
                        全部常驻可见 —— 「未验证 ≠ 没问题」「绝不静默少显示」是本面板的既定口径。 */}
                    <div className={css.shNotes}>
                      {summary.deepUnverified > 0 && (
                        <div className={css.hint}>
                          {t('sessions.unverified', { count: String(summary.deepUnverified), verified: String(summary.deepVerified) })}
                        </div>
                      )}
                      {summary.hiddenHealthy > 0 && (
                        <div className={css.hint} title={t('sessions.hidden.healthy', { count: String(summary.hiddenHealthy) })}>
                          {t('sessions.hidden.healthyShort', { count: String(summary.hiddenHealthy) })}
                        </div>
                      )}
                      {summary.untested > 0 && <div className={css.hint}>{t('sessions.untested', { count: String(summary.untested) })}</div>}
                      {summary.unreadableEntries > 0 && (
                        <div className={css.hint}>{t('sessions.unreadableEntries', { count: String(summary.unreadableEntries) })}</div>
                      )}
                    </div>
                  </div>

                  {/* E2：本档（blocksStartup 的 location-mismatch / duplicate-id）的**应用内写入口**。
                      只在有候选行或手上有计划/结果时渲染；判定与键映射全在 ui/session-layout-view.ts。 */}
                  <SessionLayoutSection
                    recoveryApi={recoveryApi}
                    t={t}
                    response={response}
                    onScan={onScan}
                  />

                  {/* ② 需要处理的会话：列表与「一键修复全部」同屏，动作恒在区块头右侧 */}
                  <div className={css.shSectionHead}>
                    <span className={css.shSectionTitle}>{t('sessions.section.attention')}</span>
                    <Badge kind={rows.length > 0 ? 'warn' : 'ok'}>{String(rows.length)}</Badge>
                    {summary.repairable > 0 && (
                      <>
                        <span className={css.statusSpacer} />
                        <Button
                          size="sm"
                          variant="primary"
                          loading={batchBusy}
                          disabled={busy !== null || batchBusy}
                          onClick={repairAll}
                        >
                          {t('sessions.repair.repairAll', { count: String(summary.repairable) })}
                        </Button>
                      </>
                    )}
                  </div>
                  <div className={css.hint}>
                    {summary.repairable > 0
                      ? t('sessions.repair.availableShort', { count: String(summary.repairable) })
                      : t('sessions.repair.noneShort')}
                    {' '}
                    {/* 操作说明（怎么点、先看什么）属说明性文案 → 完整句进 ⓘ（DESIGN §7） */}
                    <InfoHint
                      text={summary.repairable > 0
                        ? t('sessions.repair.available', { count: String(summary.repairable) })
                        : t('sessions.repair.none')}
                      label={t('common.infoHint')}
                    />
                  </div>

                  {/* 一键修复的全部结果（逐条留痕 + 复验结论）：绝不只给一个计数 */}
                  {batch !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle}>
                          {t('sessions.repair.allDone', { ok: String(batch.ok), failed: String(batch.failed) })}
                        </span>
                      </div>
                      <div className={css.snapshotList}>
                        {batch.results.map((item) => {
                          // 一键修复的成功项同样要说出复验结论（三态判定在 ui 纯函数层，组件只查字典），
                          // 与单条修复路径同一个纯函数、同一套 locale 键（失败项也必须给出复验结论）
                          const verifyKey = sessionRepairVerifyKey(item.verify, item.rolledBack)
                          return (
                            <div key={item.unitId} className={css.shRow}>
                              <div className={css.shRowTop}>
                                <Badge kind={item.ok ? 'ok' : 'warn'}>
                                  {item.ok ? t('sessions.repair.batch.ok') : t('sessions.repair.batch.failed')}
                                </Badge>
                                <span className={`${css.shRowId} ${css.mono}`} title={item.unitId}>{item.sessionId}</span>
                              </div>
                              <div className={css.shRowMeta}>
                                <span>
                                  {item.ok
                                    ? t('sessions.repair.batch.dropped', { rows: String(item.droppedRows ?? 0) })
                                    : item.transportError !== undefined
                                      ? t('sessions.repair.batch.transportError', { message: item.transportError })
                                      : item.lossy === true
                                        ? t('sessions.repair.reason.lossyRequired')
                                        : t(sessionRepairReasonKey(item.reason))}
                                </span>
                                {verifyKey !== null && (
                                  <>
                                    <span className={css.shMetaDot} aria-hidden="true">·</span>
                                    <span className={css.mono}>{t(verifyKey)}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* ③ 需要处理的会话列表：两行式行卡 + 限高内滚（DESIGN §8 硬性规则） */}
                  {rows.length === 0
                    ? <div className={css.hint}>{t('sessions.section.attentionNone')}</div>
                    : (
                      <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
                        {rows.map((row) => {
                          /** 问题 chip：最多 2 条进屏、其余折叠（条数如实给出，全文进 title） */
                          const issueChips = sessionIssueChips(row.issueCodes)
                          const facts = [
                            row.versionText,
                            row.sizeText,
                            row.mtimeMs !== null ? formatRecoveryTime(String(row.mtimeMs)) : null,
                          ].filter((value): value is string => value !== null).join(' · ')
                          return (
                            <div key={row.unitId} className={css.shRow} data-severity={row.severity}>
                              <div className={css.shRowTop}>
                                {/* 徽章只放短标签（「阻断启动」），完整句（「会让 DSH 起不来」）进 title */}
                                <Badge kind={row.badgeKind} title={t(row.severityKey)}>{t(row.severityShortKey)}</Badge>
                                {row.subagent && <Badge kind="info">{t('sessions.subagent')}</Badge>}
                                {/* 行首最宽的位置给**对话标题**：用户要认的是「哪条是我的对话」，不是 uuid。
                                    宿主没给标题时回落目录名（绝不编造）；全文进 title，脱敏已在 ui 展示模型里做过。 */}
                                <span className={css.shRowId} title={row.title ?? row.unitId}>
                                  {row.title ?? (row.blank ? t('sessions.blank') : row.sessionId)}
                                </span>
                                <div className={css.shRowActions}>
                                  {/* 可应用内修复的类别（与体检的 repairable 同源判定）；点开先 dry-run，绝不直接写 */}
                                  {row.repairable && (
                                    <Button
                                      size="sm"
                                      loading={busy === row.unitId}
                                      disabled={busy !== null && busy !== row.unitId}
                                      onClick={() => { startRepair(row.unitId) }}
                                    >
                                      {t('sessions.repair.action')}
                                    </Button>
                                  )}
                                  {/* F-2：下载该会话的原始日志 ZIP（**只读**；由 DSH 自己打包，含子会话与附件）。
                                      不可用时**禁用并给出原因**（不静默消失）—— 三态判定在 session-export-view.ts。 */}
                                  <IconButton
                                    icon={zipBusy === row.sessionId ? <Spinner /> : <Icon name="download" />}
                                    label={t('sessions.zip.action')}
                                    title={zipHint ?? t('sessions.zip.hint')}
                                    disabled={!zipState.enabled || zipBusy !== null}
                                    onClick={() => { downloadZip(row.sessionId) }}
                                  />
                                </div>
                              </div>
                              <div className={css.shRowMeta}>
                                {/* 目录名常驻可见（等宽）：它是修复 / 下载要核对的主键，也是「没有标题」时的唯一标识 */}
                                <span className={css.mono} title={row.unitId}>{row.sessionId}</span>
                                {issueChips.codes.map((code) => (
                                  <span key={code} className={css.shIssue} title={row.issueDetailText ?? undefined}>
                                    {t(sessionIssueKey(code))}
                                  </span>
                                ))}
                                {issueChips.hidden > 0 && (
                                  <span className={css.shIssue} title={sessionIssuesText(row.issueCodes, t)}>
                                    {t('sessions.issues.more', { count: String(issueChips.hidden) })}
                                  </span>
                                )}
                                {facts !== '' && <span className={css.shRowFacts}>{facts}</span>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  {truncated > 0 && <div className={css.hint}>{t('sessions.truncated', { count: String(truncated) })}</div>}

                  {/* 修复计划（dry-run 结果）。ok=false 时显示**真实拒绝原因**，不给假成功 */}
                  {plan !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle} title={plan.unitId}>
                          {t('sessions.repair.plan.title', { session: plan.result.sessionId ?? plan.unitId })}
                        </span>
                      </div>
                      {plan.result.ok ? (
                        <>
                          <div className={css.hint}>
                            {t('sessions.repair.plan.summary', {
                              rows: String(plan.result.droppedRows ?? 0),
                              before: formatSessionBytes(plan.result.bytesBefore ?? 0),
                              after: formatSessionBytes(plan.result.bytesAfter ?? 0),
                            })}
                          </div>
                          <div className={css.shLines}>
                            {(plan.result.actions ?? []).map((action) => (
                              <div key={action.code} className={css.hint}>
                                <Badge kind={action.lossy ? 'warn' : 'ok'}>
                                  {action.lossy ? t('sessions.repair.actionLossy') : t('sessions.repair.actionLossless')}
                                </Badge>
                                {' '}{action.detail}
                              </div>
                            ))}
                          </div>
                          <div className={css.hint}>{t('sessions.repair.plan.backup')}</div>
                          {plan.result.lossy === true && (
                            <div className={css.hint}>{t('sessions.repair.plan.lossy')}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className={css.hint}>{t(sessionRepairReasonKey(plan.result.reason))}</div>
                          {/* 被拒不是「没反应」：告诉用户下一步能做什么（重扫 / 稍后再试 / 用离线命令） */}
                          <div className={css.hint}>{t('sessions.repair.rejectedNext')}</div>
                        </>
                      )}
                      {/* 写后真 codec 复验结论（现役读盘可读 / 迁移链可还原 / 未验证 / 回滚失败）——
                          key 由 ui 纯函数判定，组件不写三态逻辑 */}
                      {planVerifyKey !== null && <div className={css.hint}>{t(planVerifyKey)}</div>}
                      <div className={css.actionRow}>
                        {plan.result.ok && (
                          <Button variant="primary" loading={busy !== null} onClick={applyRepair}>
                            {plan.result.lossy === true ? t('sessions.repair.applyLossy') : t('sessions.repair.apply')}
                          </Button>
                        )}
                        <Button variant="ghost" disabled={busy !== null} onClick={() => { setPlan(null) }}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* 应用成功后的结果（含真 codec 复验结论）：绝不把「写完了」说成「已可加载」 */}
                  {applied !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle} title={applied.unitId}>
                          {applied.result.sessionId ?? applied.unitId}
                        </span>
                      </div>
                      <div className={css.hint}>
                        {t('sessions.repair.applied', { rows: String(applied.result.droppedRows ?? 0) })}
                      </div>
                      {appliedVerifyKey !== null && <div className={css.hint}>{t(appliedVerifyKey)}</div>}
                      <div className={css.actionRow}>
                        <Button variant="ghost" onClick={() => { setApplied(null) }}>
                          {t('common.close')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* 应用内不动的问题类别：离线出路（命令逐条可复制） */}
                  <div className={css.shSectionHead}>
                    <span className={css.shSectionTitle}>{t('sessions.repair.title')} <InfoHint text={t('sessions.repair.desc')} label={t('common.infoHint')} /></span>
                  </div>
                  <ul className={css.shCommands}>
                    {sessionRepairCommands().map((entry) => (
                      <li key={entry.command} className={css.shCommand}>
                        <code className={css.mono}>{entry.command}</code>
                        <CopyButton text={entry.command} label={t('sessions.repair.copy')} t={clipboardT} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* 本机修复台账（可回滚）。回滚只认 repairId —— 界面拿不到也传不了路径 */}
              {repairEntries.length > 0 && (
                <>
                  <div className={css.shSectionHead}>
                    <span className={css.shSectionTitle}>{t('sessions.repair.history.title')}</span>
                    <Badge kind="info">{String(repairEntries.length)}</Badge>
                  </div>
                  <div className={css.snapshotList}>
                    {repairEntries.map((entry) => (
                      <div key={entry.repairId} className={css.shRow}>
                        <div className={css.shRowTop}>
                          <Badge kind={entry.rolledBack ? 'info' : 'ok'}>
                            {entry.rolledBack ? t('sessions.repair.history.rolledBack') : t('sessions.repair.history.applied')}
                          </Badge>
                          <span className={`${css.shRowId} ${css.mono}`} title={entry.unitId}>{entry.sessionId}</span>
                          {!entry.rolledBack && (
                            <div className={css.shRowActions}>
                              <Button size="sm" disabled={busy !== null} onClick={() => { setRollbackTarget(entry) }}>
                                {t('sessions.repair.rollback')}
                              </Button>
                            </div>
                          )}
                        </div>
                        <div className={css.shRowMeta}>
                          <span>{t('sessions.repair.history.dropped', { rows: String(entry.droppedRows) })}</span>
                          {entry.at !== null && (
                            <>
                              <span className={css.shMetaDot} aria-hidden="true">·</span>
                              <span className={css.mono}>{formatRecoveryTime(String(entry.at))}</span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {response.repairsError !== undefined && (
                <div className={css.hint}>{t('sessions.repair.history.unreadable')}</div>
              )}
            </>
          )}
        </Modal.Body>
      </Modal>
      {/*
        回滚确认（danger）：会把日志换回修复前的备份内容 —— 与其它危险动作同规，
        必须走显式确认弹窗（Radix Dialog 承载 a11y），绝不内联一键回滚。
      */}
      <ConfirmDialog
        open={rollbackTarget !== null}
        title={t('sessions.repair.rollbackConfirmTitle')}
        message={t('sessions.repair.rollbackConfirmMessage', { session: rollbackTarget?.sessionId ?? '' })}
        confirmLabel={t('sessions.repair.rollbackConfirm')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={doRollback}
        onCancel={() => { setRollbackTarget(null) }}
      />
    </>
  )
}

export function RecoveryPanel(props: RecoveryPanelProps) {
  const { recoveryApi, incidentApi, t } = props
  const [state, setState] = useState<PanelState>(initFromStore)
  const stateRef = useRef<PanelState>(state)
  const mountedRef = useRef(true)
  /** 预览请求代数：快速切换 incident 时作废在途旧请求（防晚到响应覆盖新选择） */
  const previewGeneration = useRef(0)
  /** 执行恢复的二次确认弹窗开关（危险操作） */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 放弃恢复（dismiss）确认弹窗开关 */
  const [dismissOpen, setDismissOpen] = useState(false)
  /** 重试确认弹窗开关 */
  const [retryOpen, setRetryOpen] = useState(false)
  /** issue #31：残留锁回收确认弹窗开关 + 进行中标志（与 incident 流程独立的瞬态） */
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  /** issue #56：解除 SAFE MODE 的进行中态与确认弹窗（与残留锁同规：危险动作要显式确认） */
  const [safeModeConfirmOpen, setSafeModeConfirmOpen] = useState(false)
  const [safeModeBusy, setSafeModeBusy] = useState(false)
  /**
   * 事故处置（crash / rescue）：查询结果 + 救援写盘动作的进行中态。
   *
   * 为什么不进 runStore：两者都是**查询结果**（宿主持久化），切页签回来重拉即可，
   * 不必为此扩大 store 契约；救援动作是本地文件改写（毫秒级），没有长驻进行中态。
   */
  const [crash, setCrash] = useState<CrashReport | null>(null)
  const [rescue, setRescue] = useState<RescueStatus | null>(null)
  const [rescueBusy, setRescueBusy] = useState(false)
  /** 救援模式说明的折叠态（缺省收起：紧急功能不占常驻高度，主操作在标题行恒可达） */
  const [rescueOpen, setRescueOpen] = useState(false)
  const [rescueConfirmOpen, setRescueConfirmOpen] = useState(false)

  /** 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。 */
  const commit = (next: PanelState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({ recovery: toSlice(next) })
  }
  const patch = (p: Partial<PanelState>): void => commit({ ...stateRef.current, ...p })

  /** 卸载时置挂载守卫 + 最后镜像一次。 */
  useEffect(() => () => {
    mountedRef.current = false
    runStore.patch({ recovery: toSlice(stateRef.current) })
  }, [])

  const load = (): void => {
    patch({ status: 'loading', error: null })
    recoveryApi.status().then(
      (recovery) => { patch({ status: 'ready', recovery }) },
      (err) => {
        patch({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  useEffect(load, [recoveryApi])

  /** 事故处置数据加载（崩溃归因 + 救援状态）：失败静默 —— 不干扰恢复主流程。 */
  const loadIncident = (): void => {
    incidentApi.crash().then(setCrash, () => { /* 归因不可用不影响恢复 */ })
    incidentApi.rescueStatus().then(setRescue, () => { /* 同上 */ })
  }

  useEffect(loadIncident, [incidentApi])

  /** 进入救援模式（高风险写盘：改写两层 cordis.patch.yml + 收窄 dsh.profile.bundles）。 */
  const enterRescue = (): void => {
    setRescueConfirmOpen(false)
    setRescueBusy(true)
    incidentApi.rescueOn().then(
      (res) => {
        setRescueBusy(false)
        if (!res.ok) { toast.error(redact(res.message ?? t('common.unknownError'))); return }
        toast.ok(t('recovery.rescue.on'))
        loadIncident()
      },
      (err) => {
        setRescueBusy(false)
        toast.error(redactErrorText(err))
      },
    )
  }

  /** 退出救援模式（从进入时的备份逐字节还原）。 */
  const exitRescue = (): void => {
    setRescueBusy(true)
    incidentApi.rescueOff().then(
      (res) => {
        setRescueBusy(false)
        if (!res.ok) { toast.error(redact(res.message ?? t('common.unknownError'))); return }
        toast.ok(t('recovery.rescue.off'))
        loadIncident()
      },
      (err) => {
        setRescueBusy(false)
        toast.error(redactErrorText(err))
      },
    )
  }

  /** 选择 incident → 加载只读 preview。 */
  const select = (operationId: string): void => {
    const generation = previewGeneration.current + 1
    previewGeneration.current = generation
    patch({ selectedOperationId: operationId, preview: null, previewLoading: true, verifyResult: null, actionError: null })
    recoveryApi.preview(operationId).then(
      (preview) => {
        if (generation !== previewGeneration.current) return
        patch({ previewLoading: false, preview })
      },
      (err) => {
        if (generation !== previewGeneration.current) return
        patch({
          previewLoading: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  /** 执行恢复（confirm 弹窗确认后）。 */
  const execute = (): void => {
    const operationId = state.selectedOperationId
    if (operationId === null || state.running) return
    patch({ running: true, actionError: null, verifyResult: null })
    setConfirmOpen(false)
    runStore.watchRunning('recovery', 500)
    recoveryApi.execute(operationId, true).then(
      () => {
        // execute 完成 → 立即 verify（同一持锁事务窗口内，减少外部修改窗口）
        return recoveryApi.verify(operationId)
      },
      (err) => {
        patch({ running: false })
        runStore.stopRunWatch('recovery')
        // 确认弹窗已关闭 → 用 Toast 送达（写 panel state 将无渲染点）
        toast.error(redactErrorText(err))
        return null
      },
    ).then((verifyResult) => {
      if (verifyResult === null) return
      patch({ running: false, verifyResult })
      runStore.stopRunWatch('recovery')
      // 刷新 status（SAFE MODE 可能已清除）
      void recoveryApi.status().then(
        (recovery) => { patch({ status: 'ready', recovery }) },
        () => { /* 状态刷新失败静默 */ },
      )
    })
  }

  /** 重试（验证失败后；再次确认）。 */
  const retry = (): void => {
    const operationId = state.selectedOperationId
    if (operationId === null || state.running) return
    patch({ running: true, actionError: null, verifyResult: null })
    setRetryOpen(false)
    runStore.watchRunning('recovery', 500)
    recoveryApi.retry(operationId, true).then(
      () => recoveryApi.verify(operationId),
      (err) => {
        patch({ running: false })
        runStore.stopRunWatch('recovery')
        toast.error(redactErrorText(err))
        return null
      },
    ).then((verifyResult) => {
      if (verifyResult === null) return
      patch({ running: false, verifyResult })
      runStore.stopRunWatch('recovery')
      void recoveryApi.status().then(
        (recovery) => { patch({ status: 'ready', recovery }) },
        () => { /* 静默 */ },
      )
    })
  }

  /** 放弃恢复（dismiss；quarantine，不销毁证据）。 */
  const dismiss = (): void => {
    const operationId = state.selectedOperationId
    if (operationId === null || state.running) return
    patch({ running: true, actionError: null })
    setDismissOpen(false)
    recoveryApi.dismiss(operationId, true).then(
      () => {
        patch({ running: false, selectedOperationId: null, preview: null, verifyResult: null })
        load()
      },
      (err) => {
        patch({ running: false })
        toast.error(redactErrorText(err))
      },
    )
  }

  /** issue #31：显式回收 stale 残留锁（确认弹窗后）。成功/拒绝都靠 status 重拉刷新锁态——
   *  拒绝时保留卡片并给出原因（绝不假装成功）。 */
  const recoverLock = (): void => {
    if (lockBusy) return
    setLockConfirmOpen(false)
    setLockBusy(true)
    recoveryApi.recoverStaleLock(true).then(
      (res) => {
        setLockBusy(false)
        if (res.ok) toast.ok(t('recovery.lock.done'))
        else toast.error(t('recovery.lock.refused'))
        load()
      },
      (err) => {
        setLockBusy(false)
        toast.error(redactErrorText(err))
      },
    )
  }

  /**
   * issue #56：显式解除仍然生效的 SAFE MODE（确认弹窗后）。
   * 成功/被拒都靠 status 重拉刷新（绝不乐观地点掉横幅）：宿主仍有未解决事项时会拒绝，
   * 此时界面给出「先处理下面的恢复事项」而不是假装成功（`cleared=false` 也算成功响应）。
   */
  const clearSafeMode = (): void => {
    if (safeModeBusy) return
    setSafeModeConfirmOpen(false)
    setSafeModeBusy(true)
    recoveryApi.clearSafeMode(true).then(
      (res) => {
        setSafeModeBusy(false)
        if (res.cleared) toast.ok(t('recovery.safeMode.done'))
        else toast.error(t('recovery.safeMode.refused'))
        load()
      },
      (err) => {
        setSafeModeBusy(false)
        toast.error(redactErrorText(err))
      },
    )
  }

  const view = state.recovery !== null ? toRecoveryView(state.recovery) : null
  const selected = state.selectedOperationId !== null && state.recovery !== null
    ? state.recovery.incidents.find((i) => i.operationId === state.selectedOperationId)
    : undefined
  const previewView = state.preview !== null ? toRecoveryPreviewView(state.preview) : null
  /** 真有待处理事项（口径唯一来源 = 纯函数 recovery-view.ts 的 recoveryRequired）：决定副标题与空态 */
  const needsAttention = view?.recoveryRequired === true
  /**
   * 选中项是否属于「正在正常执行中」的操作。是 ⇒ 恢复/放弃都不该点：它还在跑，
   * quarantine 会把在跑的 journal 从 active/ 抽走。据此给出**原因**而不是灰按钮。
   */
  const selectedLive = selected !== undefined
    && (view?.activeOperations.some((op) => op.operationId === selected.operationId) ?? false)
  /** 选中项「执行恢复」不可用的原因（null = 可用）——见 recovery-view.ts recoveryBlockReason */
  const selectedBlockReason = selected !== undefined ? recoveryBlockReason(selected) : null

  return (
    <div className={css.viewBody}>
      {/* 副标题只在**真有待处理事项**时出现：本机健康时那句「检测到一次操作未正常完成…」是假警报
          （此前无条件常驻）；空态解释由下方的 Empty 承担，§7 的 KEEP-5 不变。 */}
      <SectionTitle
        title={t('view.recovery')}
        subtitle={needsAttention ? t('recovery.requiredHint') : undefined}
      />

      {/* 事故处置：崩溃归因（上次启动没起来）+ 救援模式（先让 DSH 起得来）。
          灾备快照线（自动快照 / 撤销重做）已下线，恢复到某个历史点改由「备份文件」承担，
          本页不自建第二条恢复通道。 */}
      {crash?.crashed === true && (
        <Banner kind="error">
          <div className={css.statRow}>
            <strong>{t('recovery.crash.title')}</strong>
            <Badge kind="error">{t(crashReasonKey(crash.crashReason))}</Badge>
          </div>
          <div className={css.hint}>{t(crashAdviceKey(crash.advice))}</div>
          {crash.lastGoodAt !== null && (
            <div className={css.hint}>{t('recovery.crash.lastGood', { time: formatRecoveryTime(crash.lastGoodAt) })}</div>
          )}
          <div className={css.hint}>{t('recovery.crash.guidance')}</div>
        </Banner>
      )}

      {/* —— 状态与待处理事项（先异常、后诊断）：三块诊断卡在下方，缺省只展开磁盘占用 —— */}
      {/* SAFE MODE / recovery-required 状态提示（正常态不渲染任何横幅——无事项即静默）。
          **文案必须与真实阻断态同源**：recoveryRequired 只是「有待处理事项」，不等于写操作已被
          暂停（残留锁 / 中断的档案复制都不会让 safeMode.blocked 为 true）。此前这里无条件说
          「已进入安全模式（会修改配置的操作已暂停）」⇒ 用户看到保护提示，实际上许多写操作照常
          成功，属于假警报（也让真正被阻断的场景失去可信度）。 */}
      {view?.recoveryRequired === true && (
        <Banner kind="error">
          {view.safeModeBlocked ? t('recovery.currentState.safeMode') : t('recovery.currentState.itemsOnly')}
        </Banner>
      )}

      {state.status === 'loading' && <SkeletonList label={t('recovery.loading')} />}

      {state.status === 'error' && (
        <Banner kind="error">
          {state.error ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {/* issue #56：「保护开着但已无待处理事项」——这正是 423 与空面板同时出现的死结态。
          必须给出**可执行**的解除入口，否则用户只能去磁盘上删 transactions/safe-mode。 */}
      {state.status === 'ready' && view?.safeModeStuck === true && (
        <Card className={css.card}>
          <div className={css.groupLabel}>{t('recovery.safeMode.title')} <InfoHint text={t('recovery.safeMode.detail')} label={t('common.infoHint')} /></div>
          <div className={css.actionRow}>
            <Button variant="danger" disabled={safeModeBusy} loading={safeModeBusy} onClick={() => { setSafeModeConfirmOpen(true) }}>
              {safeModeBusy ? t('recovery.safeMode.busy') : t('recovery.safeMode.action')}
            </Button>
          </div>
        </Card>
      )}

      {/* 空态：只在**确知没有事项**时出现（recoveryRequired 的口径见 recovery-view.ts）。
          「枚举失败」是不知道、不是没有（t89）—— 那时由上面的告警条承担解释，不在这里说「暂无」。 */}
      {state.status === 'ready' && view?.recoveryRequired !== true && view?.incompleteCopiesNotice !== 'unreadable' && (
        <Empty>{t('recovery.empty')}</Empty>
      )}

      {/* issue #31：残留配置锁（非 journal 事项）——纯锁残留时 incidents 恒为空，
          这里必须给出**可执行**的回收入口，否则 423 文案指的入口永远是空面板。 */}
      {state.status === 'ready' && view?.lock != null && (
        <Card className={css.card}>
          <div className={css.groupLabel}>{t('recovery.lock.title')}</div>
          <div className={css.hint}>
            {view.lock.state === 'STALE_LOCK_DETECTED' ? t('recovery.lock.detailStale') : t('recovery.lock.detailUnknown')}
          </div>
          <div className={css.actionRow}>
            {/* 加载图标由 Button 原语按 loading 自动渲染（此前只换文案 = 没有任何进行中反馈） */}
            <Button variant="danger" disabled={lockBusy} loading={lockBusy} onClick={() => { setLockConfirmOpen(true) }}>
              {lockBusy ? t('recovery.lock.busy') : t('recovery.lock.action')}
            </Button>
          </div>
        </Card>
      )}

      {/* 正在正常执行的操作（不是 incident）：给一句「会自行结束」，避免用户以为面板出了故障。
          这一块存在的理由：此前 autosync push 在跑的 12 秒里，它被当成了待处理事故。 */}
      {state.status === 'ready' && (view?.activeOperations.length ?? 0) > 0 && (
        <Card className={css.card}>
          <div className={css.groupLabel}>{t('recovery.live.title')}</div>
          <div className={css.hint}>{t('recovery.live.hint')}</div>
          <div className={css.snapshotList}>
            {view!.activeOperations.map((op) => (
              <div key={op.operationId} className={css.snapshotRow}>
                <span className={css.snapshotRowMain} title={op.operationId}>
                  <span>{op.operationType}</span>
                  <span>{new Date(op.startedAt).toLocaleString()}</span>
                  <span><Badge kind="info">{incidentStateLabel(t, op.state)}</Badge></span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {state.status === 'ready' && (view?.incidents.length ?? 0) > 0 && (
        <>
          {/* 进行中 recovery run 提示 */}
          {(view?.running.length ?? 0) > 0 && (
            <Banner kind="info">{t('recovery.runningHint')}</Banner>
          )}

          {/* incident 列表 */}
          <Card className={css.card}>
            <div className={css.groupLabel}>{t('recovery.incident.title')}</div>
            <div className={css.snapshotList} role="listbox" aria-label={t('recovery.incident.title')}>
              <div className={css.snapshotRowHeader}>
                <span>{t('recovery.incident.operationType')}</span>
                <span>{t('recovery.incident.createdAt')}</span>
                <span>{t('recovery.incident.decision')}</span>
                <span>{t('recovery.incident.state')}</span>
              </div>
              {view!.incidents.map((incident) => {
                const selectedRow = incident.operationId === state.selectedOperationId
                return (
                  <div key={incident.operationId} className={css.snapshotRow} role="option" aria-selected={selectedRow} data-active={selectedRow ? '' : undefined}>
                    <button
                      type="button"
                      className={css.snapshotRowMain}
                      disabled={state.running}
                      onClick={() => { select(incident.operationId) }}
                    >
                      <span title={incident.operationId}>{incident.operationType}</span>
                      <span>{new Date(incident.createdAt).toLocaleString()}</span>
                      <span><Badge kind={decisionBadgeKind(incident.decision)}>{decisionLabel(t, incident.decision)}</Badge></span>
                      <span>{incidentStateLabel(t, incident.state)}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* 选中 incident 的详情 + 预览 + 执行 */}
          {selected !== undefined && (
            <Card className={css.card}>
              <div className={css.groupLabel}>{t('recovery.incident.operationId')}: {selected.operationId}</div>
              {selected.reason !== '' && (
                <div className={css.hint}>{t('recovery.incident.reason')}: {selected.reason}</div>
              )}

              {/* 快照信息 */}
              <div className={css.groupLabel}>{t('recovery.snapshot.title')}</div>
              {selected.snapshotId !== null && selected.snapshotId !== '' ? (
                <div className={css.statRow}>
                  <Badge kind="info">{t('recovery.currentState.hasSnapshot')}</Badge>
                  <span className={css.hint} title={selected.snapshotId}>{selected.snapshotId}</span>
                </div>
              ) : (
                <div className={css.statRow}>
                  <Badge kind="error">{t('recovery.currentState.noSnapshot')}</Badge>
                </div>
              )}

              {/* 环境 */}
              {previewView !== null && (
                <div className={css.statRow}>
                  <span className={css.groupLabel}>{t('recovery.environment.title')}</span>
                  <Badge kind={previewView.environmentCompatible ? 'ok' : 'error'}>
                    {previewView.environmentCompatible ? t('recovery.environment.compatible') : t('recovery.environment.incompatible')}
                  </Badge>
                </div>
              )}

              {/* 预览加载 */}
              {state.previewLoading && <Spinner label={t('recovery.preview.loading')} />}

              {/* 预览内容 */}
              {previewView !== null && (
                <>
                  <div className={css.statRow}>
                    <span className={css.groupLabel}>{t('recovery.preview.title')}</span>
                    {/* recovery.preview.hint 属「预览为什么只读 / 什么时候才真执行」（MOVE 类）：收进 ⓘ。
                        危险动作的完整说明仍在确认弹窗（ConfirmDialog）里常驻。 */}
                    <InfoHint text={t('recovery.preview.hint')} label={t('common.infoHint')} />
                  </div>
                  {previewView.snapshotVerdict !== null && (
                    <div className={css.statRow}>
                      <span className={css.hint}>{t('recovery.snapshot.verdict')}</span>
                      <Badge kind={isSnapshotTrusted(previewView.snapshotVerdict) ? 'ok' : 'warn'}>
                        {snapshotVerdictLabel(t, previewView.snapshotVerdict)}
                      </Badge>
                    </div>
                  )}
                  {previewView.snapshotMeta !== null && (
                    <div className={css.hint}>
                      {t('recovery.snapshot.createdAt')}: {new Date(previewView.snapshotMeta.createdAt).toLocaleString()}
                    </div>
                  )}
                </>
              )}

              {/* 验证结果 */}
              {state.verifyResult !== null && (
                <>
                  <div className={css.groupLabel}>{t('recovery.verify.title')}</div>
                  <div className={css.statRow}>
                    <Badge kind={verdictBadgeKind(state.verifyResult.verdict)}>
                      {verdictLabel(t, state.verifyResult.verdict)}
                    </Badge>
                    <span className={css.hint}>{t(`recovery.verify.terminal.${state.verifyResult.terminal === 'ROLLED_BACK' ? 'rolledBack' : state.verifyResult.terminal === 'RECOVERED' ? 'recovered' : 'needsAttention'}`)}</span>
                  </div>
                  {state.verifyResult.details.length > 0 && (
                    <div className={css.reportScroll}>
                      <ul className={css.reportList}>
                        {state.verifyResult.details.map((d, i) => <li key={`detail-${i}`}>{d}</li>)}
                      </ul>
                    </div>
                  )}
                  {state.verifyResult.manualHints.length > 0 && (
                    <Banner kind="warn">
                      <strong>{t('recovery.verify.manualHints')}</strong>
                      <ul className={css.reportList}>
                        {state.verifyResult.manualHints.map((h, i) => <li key={`hint-${i}`}>{h}</li>)}
                      </ul>
                    </Banner>
                  )}
                </>
              )}

              {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}

              {/* 「执行恢复」不可用的原因：灰按钮不带解释 = 用户只能盲猜（这正是事故里的体验）。
                  三种原因互斥且都能被代码逐条证明：操作仍在跑 / 无绑定快照 / 决策为需人工处理。 */}
              {selectedLive ? (
                <Banner kind="info">{t('recovery.incident.liveBlocked')}</Banner>
              ) : state.verifyResult === null && selectedBlockReason !== null ? (
                <div className={css.hint}>
                  {selectedBlockReason === 'noSnapshot'
                    ? t('recovery.incident.blockReason.noSnapshot')
                    : t('recovery.incident.blockReason.needsAttention')}
                </div>
              ) : null}

              {/* 动作区 */}
              <div className={css.actionRow}>
                {state.verifyResult === null && (
                  <>
                    <Button
                      variant="danger"
                      disabled={state.running || selectedLive || !(previewView?.actionable ?? false)}
                      loading={state.running}
                      onClick={() => { setConfirmOpen(true) }}
                    >
                      {state.running ? t('recovery.executing') : t('recovery.execute')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={state.running || selectedLive}
                      onClick={() => { setDismissOpen(true) }}
                    >
                      {t('recovery.dismiss')}
                    </Button>
                  </>
                )}
                {state.verifyResult !== null && isVerdictAttention(state.verifyResult.verdict) && (
                  <>
                    <Button
                      variant="danger"
                      disabled={state.running}
                      onClick={() => { setRetryOpen(true) }}
                    >
                      {t('recovery.retry')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={state.running}
                      onClick={() => { setDismissOpen(true) }}
                    >
                      {t('recovery.dismiss')}
                    </Button>
                  </>
                )}
                {state.verifyResult !== null && isVerdictSuccess(state.verifyResult.verdict) && (
                  <Banner kind="ok">{t('recovery.completed')}</Banner>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      {rescue !== null && (
        <Card>
          <div className={css.statRow}>
            <strong>{t('recovery.rescue.title')}</strong>
            <InfoHint text={t('recovery.rescue.desc')} label={t('common.infoHint')} />
            <Badge kind={rescue.active ? 'warn' : 'ok'}>
              {rescue.active ? t('recovery.rescue.activeBadge') : t('recovery.rescue.inactive')}
            </Badge>
            {rescue.stale && <Badge kind="warn">{t('recovery.rescue.stale')}</Badge>}
            <span className={css.statusSpacer} />
            {/* 危险动作留在**标题行**：折叠只收起「这个功能做什么」的说明，主操作与状态徽章永远可达
                （紧急功能不该藏在一次点击后面）；不可逆改写的完整说明在确认弹窗里逐条给出。 */}
            {rescue.active
              ? <Button variant="danger" disabled={rescueBusy} loading={rescueBusy} onClick={exitRescue}>{t('recovery.rescue.exit')}</Button>
              : <Button variant="danger" disabled={rescueBusy} onClick={() => { setRescueConfirmOpen(true) }}>{t('recovery.rescue.enter')}</Button>}
            {/* 折叠开关只在**真有明细**（已开启 → 生效状态与提示）时渲染：空折叠体是纯噪音 */}
            {rescue.active && (
              <FoldToggle
                open={rescueOpen}
                controls={RESCUE_BODY_ID}
                onToggle={() => { setRescueOpen((v) => !v) }}
                expandLabel={t('common.expand')}
                collapseLabel={t('common.collapse')}
              />
            )}
          </div>
          {/* 机制与安全说明收进标题行的 ⓘ（2026-10-12 用户要求说明性文案一律进 ⓘ）：
              危险动作按钮仍在标题行永远可达，折叠体只收「已开启时的生效状态与提示」这类明细。 */}
          <Collapse open={rescueOpen} id={RESCUE_BODY_ID}>
          {rescue.active && (
            <div className={css.hint}>
              {t(rescue.applied ? 'recovery.rescue.applied' : 'recovery.rescue.active', { time: formatRecoveryTime(rescue.enteredAt) })}
            </div>
          )}
          {rescue.active && <div className={css.hint}>{t(rescueHintKey(rescue))}</div>}
          </Collapse>
        </Card>
      )}

      {/* t54：中断的档案复制残留（cross-F3）—— 独立形态 + 只给删除；删除走既有 POST /profiles/delete，
          被 SAFE MODE 拦下（423 mutation-locked）时给原因与本页出口（safe-mode/clear）。 */}
      {view !== null && view.incompleteCopies.length > 0 && (
        <IncompleteCopiesSection
          rows={view.incompleteCopies}
          t={t}
          diskApi={props.diskApi}
          recoveryApi={props.recoveryApi}
          onChanged={load}
        />
      )}

      {/* t89：残留**枚举失败** —— 与上面「有残留」和「暂无残留」都不同形：显式告知「读不到 ≠ 没有」，
          并给唯一的可行动作（重试 = 重拉 /recovery/status）。判定在 recovery-view.ts 的纯函数里，这里只装配。 */}
      {view !== null && view.incompleteCopiesNotice === 'unreadable' && (
        <Card>
          <SectionTitle title={t('recovery.incomplete.unreadable.title')} />
          <Banner kind="warn">{t('recovery.incomplete.unreadable.hint')}</Banner>
          <div className={css.actionRow}>
            <Button onClick={load}>{t('common.retry')}</Button>
          </div>
        </Card>
      )}

      {/* —— 诊断三块（缺省只展开磁盘占用；另两块缺省收起，摘要与开关留在标题行）——
           磁盘占用与清理（m-disk-usage）：三条硬边界一字不动（候选集只有可重建区 + 显式勾选的过期导出；snapshots/sync 永不在候选集；
           界面数字由渲染行现算）—— 实现全在 DiskUsageCard 与 ui/disk-usage-view.ts 里。 */}
      <DiskUsageCard api={props.diskApi} infoHintLabel={props.infoHintLabel ?? props.t('common.infoHint')} />

      {/* T5：会话体检（只读）—— 与「我的对话去哪了」是同一件事，故与事故恢复同屏（卡内缺省收起） */}
      <SessionHealthCard recoveryApi={recoveryApi} t={t} copyT={props.copyT} diskApi={props.diskApi} />

      {/* S7：工作区 + 会话回滚（每个回合结束自动留点）—— 紧跟在会话体检之后：
          它要解决的正是同一件事（事故后把工作区与会话退回某个时刻），且时间线按会话分组，
          与会话体检的分组口径一致；会话回退只 fork 子会话，原会话日志只读。
           卡内缺省收起：这是维护页最长的一块（台账 + 预览），入口与摘要留在标题行。 */}
      <RollbackCard recoveryApi={recoveryApi} t={t} />

      {/* 执行恢复二次确认（破坏性操作） */}
      <ConfirmDialog
        open={confirmOpen}
        title={t('recovery.confirm.title')}
        message={selected?.decision === 'rollback-continue'
          ? t('recovery.confirm.rollbackContinue')
          : t('recovery.confirm.message')}
        confirmLabel={t('recovery.execute')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.running}
        onConfirm={execute}
        onCancel={() => { setConfirmOpen(false) }}
      />

      {/* 重试二次确认 */}
      <ConfirmDialog
        open={retryOpen}
        title={t('recovery.confirm.title')}
        message={t('recovery.confirm.retry')}
        confirmLabel={t('recovery.retry')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.running}
        onConfirm={retry}
        onCancel={() => { setRetryOpen(false) }}
      />

      {/* 放弃恢复二次确认 */}
      <ConfirmDialog
        open={dismissOpen}
        title={t('recovery.confirm.dismissTitle')}
        message={t('recovery.confirm.dismiss')}
        confirmLabel={t('recovery.dismiss')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.running}
        onConfirm={dismiss}
        onCancel={() => { setDismissOpen(false) }}
      />

      {/* issue #31：残留锁回收二次确认（危险：改动控制面锁文件） */}

      {/* 进入救援模式二次确认（危险：改写两层 cordis.patch.yml + 收窄 bundles） */}
      <ConfirmDialog
        open={rescueConfirmOpen}
        title={t('recovery.rescue.confirmTitle')}
        message={t('recovery.rescue.confirm')}
        confirmLabel={t('recovery.rescue.enter')}
        cancelLabel={t('common.cancel')}
        danger
        busy={rescueBusy}
        onConfirm={enterRescue}
        onCancel={() => { setRescueConfirmOpen(false) }}
      />
      {/* issue #56：解除 SAFE MODE 的二次确认（危险：解除后写操作立即恢复） */}
      <ConfirmDialog
        open={safeModeConfirmOpen}
        title={t('recovery.safeMode.confirmTitle')}
        message={t('recovery.safeMode.confirmMessage')}
        confirmLabel={t('recovery.safeMode.action')}
        cancelLabel={t('common.cancel')}
        danger
        busy={safeModeBusy}
        onConfirm={clearSafeMode}
        onCancel={() => { setSafeModeConfirmOpen(false) }}
      />
      <ConfirmDialog
        open={lockConfirmOpen}
        title={t('recovery.lock.confirmTitle')}
        message={t('recovery.lock.confirmMessage')}
        confirmLabel={t('recovery.lock.action')}
        cancelLabel={t('common.cancel')}
        danger
        busy={lockBusy}
        onConfirm={recoverLock}
        onCancel={() => { setLockConfirmOpen(false) }}
      />
    </div>
  )
}
