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
import type { RecoveryPreview, RecoveryStatus, RecoveryVerifyResult } from '../../ui/types.ts'
import type { TranslateNS } from '../client-types.ts'
import {
  Badge, Banner, Button, Card, FoldToggle, SectionTitle, Spinner, StatusDot,
} from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Collapse } from '../common/Motion.tsx'
import { DiskUsageCard } from '../environment/maintenance/DiskUsageCard.tsx'
import { RollbackCard } from './RollbackCard.tsx'
import { SkeletonList } from '../common/Skeleton.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import { runStore, type RecoveryStoreSlice } from '../run-store.ts'
import type { CrashReport, IncidentApi, RescueStatus } from './incident-api.ts'
import { IncompleteCopiesSection } from './IncompleteCopiesSection.tsx'
import { SessionHealthCard } from './SessionHealthCard.tsx'
import type { LayoutRecoveryApi } from './recovery-api.ts'
import { WRITE_KEY, useRecoveryWriteKey, withRecoveryWrite } from './use-recovery-write.ts'
import {
  crashAdviceKey,
  crashReasonKey,
  formatRecoveryTime,
  isSnapshotTrusted,
  isVerdictAttention,
  isVerdictSuccess,
  recoveryBlockReason,
  rescueHintKey,
  toRecoveryPreviewView,
  toRecoveryView,
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

/* E2：`LayoutRecoveryApi`（RecoveryPort + 可选布局归位 / 回滚点）已随拆分搬到 `recovery-api.ts`，
 * 体检卡 / 体检弹窗 / 布局归位 / 本面板共用同一份定义 —— 端口形状只留一处。 */

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
    // 写盘瞬态不进面板 state（只对具体动作的按钮有意义，由 `use-recovery-write.ts` 直接读）：
    // 原值透传，patch 合并时才不会把别处刚登记的进行中态抹成 null。
    write: runStore.getSnapshot().recovery.write,
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
  /** issue #31：残留锁回收确认弹窗开关（与 incident 流程独立） */
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false)
  /** issue #56：解除 SAFE MODE 的确认弹窗（与残留锁同规：危险动作要显式确认） */
  const [safeModeConfirmOpen, setSafeModeConfirmOpen] = useState(false)
  /**
   * 事故处置（crash / rescue）：查询结果。
   *
   * 为什么不进 runStore：两者都是**查询结果**（宿主持久化），切页签回来重拉即可，不必为此扩大 store 契约。
   * 而**写盘动作的进行中态**（锁回收 / SAFE MODE 解除 / 救援开关）住 runStore 的 recovery.write 切片：
   * 它们同样是本地文件改写，但「切页回来还知道自己在写、不会重复点」是用户可见的行为（tech-debt #7）。
   */
  const [crash, setCrash] = useState<CrashReport | null>(null)
  const [rescue, setRescue] = useState<RescueStatus | null>(null)
  /**
   * 进行中的写盘动作（一个动作一个 key，见 `use-recovery-write.ts`）。
   * 本面板有 4 个：锁回收、SAFE MODE 解除、进救援、退救援 —— 四者互斥，单槽即可。
   */
  const writeKey = useRecoveryWriteKey()
  const lockBusy = writeKey === WRITE_KEY.lockRecover
  const safeModeBusy = writeKey === WRITE_KEY.safeModeClear
  const rescueOn = writeKey === WRITE_KEY.rescueOn
  const rescueOff = writeKey === WRITE_KEY.rescueOff
  const rescueBusy = rescueOn || rescueOff
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
    void withRecoveryWrite(WRITE_KEY.rescueOn, async () => {
      try {
        const res = await incidentApi.rescueOn()
        if (!res.ok) { toast.error(redact(res.message ?? t('common.unknownError'))); return }
        toast.ok(t('recovery.rescue.on'))
        loadIncident()
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
  }

  /** 退出救援模式（从进入时的备份逐字节还原）。 */
  const exitRescue = (): void => {
    void withRecoveryWrite(WRITE_KEY.rescueOff, async () => {
      try {
        const res = await incidentApi.rescueOff()
        if (!res.ok) { toast.error(redact(res.message ?? t('common.unknownError'))); return }
        toast.ok(t('recovery.rescue.off'))
        loadIncident()
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
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
    void withRecoveryWrite(WRITE_KEY.lockRecover, async () => {
      try {
        const res = await recoveryApi.recoverStaleLock(true)
        if (res.ok) toast.ok(t('recovery.lock.done'))
        else toast.error(t('recovery.lock.refused'))
        load()
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
  }

  /**
   * issue #56：显式解除仍然生效的 SAFE MODE（确认弹窗后）。
   * 成功/被拒都靠 status 重拉刷新（绝不乐观地点掉横幅）：宿主仍有未解决事项时会拒绝，
   * 此时界面给出「先处理下面的恢复事项」而不是假装成功（`cleared=false` 也算成功响应）。
   */
  const clearSafeMode = (): void => {
    if (safeModeBusy) return
    setSafeModeConfirmOpen(false)
    void withRecoveryWrite(WRITE_KEY.safeModeClear, async () => {
      try {
        const res = await recoveryApi.clearSafeMode(true)
        if (res.cleared) toast.ok(t('recovery.safeMode.done'))
        else toast.error(t('recovery.safeMode.refused'))
        load()
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
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
          {crashAdviceKey(crash.advice) !== 'recovery.crash.advice.none' && <div className={css.hint}>{t(crashAdviceKey(crash.advice))}</div>}
          {crash.lastGoodAt !== null && (
            <div className={css.hint}>{t('recovery.crash.lastGood', { time: formatRecoveryTime(crash.lastGoodAt) })}</div>
          )}
          {rescue?.active !== true && (
            <div className={css.actionRow}>
              <Button variant="danger" disabled={rescueBusy} loading={rescueOn} onClick={() => { setRescueConfirmOpen(true) }}>{t('recovery.rescue.enter')}</Button>
            </div>
          )}
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

      {/* 空态只在**确知没有事项**时出现（口径见 recovery-view.ts）；「枚举失败」是不知道、
          不是没有（t89），那时由上面的告警条解释。2026-11-04：原 92px 虚线空框改一行状态行 ——
          它白占的高度把磁盘 / 体检 / 回滚整块推到首屏之外。 */}
      {state.status === 'ready' && view?.recoveryRequired !== true && view?.incompleteCopiesNotice !== 'unreadable' && (
        <div className={css.statusLine} role="status"><StatusDot kind="ok" /><span>{t('recovery.empty')}</span></div>
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
              <div className={css.kvRow}>
                <span className={css.kvKey}>{t('recovery.incident.operationId')}</span>
                <span className={`${css.kvValue} ${css.mono}`} title={selected.operationId}>{selected.operationId}</span>
              </div>
              {selected.reason !== '' && (
                <div className={css.kvRow}>
                  <span className={css.kvKey}>{t('recovery.incident.reason')}</span>
                  <span className={css.kvValue}>{selected.reason}</span>
                </div>
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
                <div className={css.kvRow}>
                  <span className={css.kvKey}>{t('recovery.environment.title')}</span>
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
                    <div className={css.kvRow}>
                      <span className={css.kvKey}>{t('recovery.snapshot.verdict')}</span>
                      <Badge kind={isSnapshotTrusted(previewView.snapshotVerdict) ? 'ok' : 'warn'}>
                        {snapshotVerdictLabel(t, previewView.snapshotVerdict)}
                      </Badge>
                    </div>
                  )}
                  {previewView.snapshotMeta !== null && (
                    <div className={css.kvRow}>
                      <span className={css.kvKey}>{t('recovery.snapshot.createdAt')}</span>
                      <span className={css.kvValue}>{new Date(previewView.snapshotMeta.createdAt).toLocaleString()}</span>
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
              ? <Button variant="danger" disabled={rescueBusy} loading={rescueOff} onClick={exitRescue}>{t('recovery.rescue.exit')}</Button>
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
          {rescue.active && rescue.applied && <div className={css.hint}>{t(rescueHintKey(rescue))}</div>}
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
