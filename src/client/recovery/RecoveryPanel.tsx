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
import type { RecoveryPreview, RecoveryStatus, RecoveryVerifyResult } from '../../ui/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { runStore, type RecoveryStoreSlice } from '../run-store.ts'
import {
  isSnapshotTrusted, isVerdictAttention, isVerdictSuccess, toRecoveryPreviewView,
  toRecoveryView, verdictToUiState, type RecoveryUiState,
} from './recovery-view.ts'
import css from '../config-manager.module.css'

export interface RecoveryPanelProps {
  recoveryApi: RecoveryPort
  t: TranslateNS<'config-manager-recovery'>
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
    default: return decision
  }
}

/** verdict → 文案键。 */
function verdictLabel(t: TranslateNS<'config-manager-recovery'>, verdict: string): string {
  switch (verdict) {
    case 'MATCH': return t('recovery.verified')
    case 'PARTIAL_MATCH': return t('recovery.partialMatch')
    case 'MISMATCH': return t('recovery.mismatch')
    case 'VERIFICATION_ERROR': return t('recovery.verificationError')
    default: return verdict
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

export function RecoveryPanel({ recoveryApi, t }: RecoveryPanelProps) {
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
        patch({
          running: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
        runStore.stopRunWatch('recovery')
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
        patch({
          running: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
        runStore.stopRunWatch('recovery')
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
        patch({
          running: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  const view = state.recovery !== null ? toRecoveryView(state.recovery) : null
  const selected = state.selectedOperationId !== null && state.recovery !== null
    ? state.recovery.incidents.find((i) => i.operationId === state.selectedOperationId)
    : undefined
  const previewView = state.preview !== null ? toRecoveryPreviewView(state.preview) : null
  const uiState: RecoveryUiState = view?.state ?? 'NORMAL'

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('view.recovery')} subtitle={t('recovery.requiredHint')} />

      {/* SAFE MODE / recovery-required 状态提示 */}
      {view?.recoveryRequired === true && (
        <Banner kind="error">{t('recovery.currentState.safeMode')}</Banner>
      )}
      {view?.recoveryRequired === false && state.status === 'ready' && (
        <Banner kind="ok">{t('recovery.currentState.safeModeCleared')}</Banner>
      )}

      {state.status === 'loading' && <Spinner label={t('recovery.loading')} />}

      {state.status === 'error' && (
        <Banner kind="error">
          {state.error ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {state.status === 'ready' && (view?.incidents.length ?? 0) === 0 && (
        <Empty>{t('recovery.empty')}</Empty>
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
                      <span>{incident.state}</span>
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
                  <div className={css.groupLabel}>{t('recovery.preview.title')}</div>
                  <div className={css.hint}>{t('recovery.preview.hint')}</div>
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

              {/* 动作区 */}
              <div className={css.actionRow}>
                {state.verifyResult === null && (
                  <>
                    <Button
                      variant="danger"
                      disabled={state.running || !(previewView?.actionable ?? false)}
                      onClick={() => { setConfirmOpen(true) }}
                    >
                      {state.running ? t('recovery.executing') : t('recovery.execute')}
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
    </div>
  )
}
