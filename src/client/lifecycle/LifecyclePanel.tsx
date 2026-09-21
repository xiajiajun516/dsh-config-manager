/**
 * 灾备 / Recovery Lifecycle 面板（Phase 1 能力面向用户的入口）。
 *
 * 为什么是这个 IA（不是单页一锅端）：本面板把四件事按「风险从低到高」纵向排开 ——
 * 只读状态 → 撤销/重做 → 快照列表 → 救援模式。用户从 DSH 起不来（崩溃横幅）进入时，
 * 最需要的「回退到最后正常状态」排在最上面，救援模式作为最后手段沉底。
 *
 * 数据流：挂载时并行拉 status() + crash()（互不阻塞：崩溃归因失败不该拖垮快照列表）；
 * 每次变更动作（undo/redo/snapshot/remove/rescue）成功后统一 refresh() 重拉，
 * 绝不在本地推算引擎状态 —— 快照的 stepped/consumed 标记只有 Host 是权威。
 *
 * 安全约束（§9.4 / §11）：
 *  - undo / rescue-on / remove 都是 dеstruсtivе-ish 动作，必须经 ConfirmDialog 显式确认；
 *    本组件绝不自动调用。
 *  - 「回退到最后正常状态」复用 undo()（引擎按内容差异挑选目标快照），界面上如实
 *    标注它走的是撤销通道，不假装是另一条独立的恢复路径。
 *  - 错误文本先经 redact() 再进 ErrorBanner（双保险）。
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type {
  CrashReport, LifecycleApi, LifecycleOutcome, LifecycleSnapshotMeta, LifecycleStatus, RescueStatus,
} from './lifecycle-api.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Card, Empty, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { DeleteIcon, SnapshotIcon, WarnIcon } from '../common/Icon.tsx'
import { toast } from '../common/toast-store.ts'
import css from '../config-manager.module.css'

export interface LifecyclePanelProps {
  lifecycleApi: LifecycleApi
  t: TranslateNS<'config-manager'>
  /**
   * 跳转到「备份」页的引导式恢复向导（Phase 5）。
   * 本页只做一键回退；崩溃后需要「预览 → 确认 → 执行 → 校验」的完整流程时走那条通道。
   * 由 ConfigManagerSection 注入（面板自身不依赖 runStore，保持可独立测试）。
   */
  openRecoveryWizard?: () => void
}

/** 面板内部状态（一次挂载内的瞬态；低频页不持久化）。 */
interface PanelState {
  /** status / crash 两条链各自成败，避免一条失败把整页判成错误 */
  loading: boolean
  status: LifecycleStatus | null
  crash: CrashReport | null
  rescue: RescueStatus | null
  /** status 链的错误（crash 链失败仅静默降级，不打断主流程） */
  error: string | null
  /** 进行中的动作（禁用按钮，防重复提交） */
  busy: 'undo' | 'redo' | 'snapshot' | 'remove' | 'rescue' | null
}

/**
 * 快照 kind → 字典键。
 * 注意：locales.ts 里**没有** lifecycle.kind.unknown 键（字典由其它线持有，不得新增），
 * 因此未知 kind 一律回落到 lifecycle.kind.manual —— 未知 kind 只可能来自手动/旧版本快照，
 * 语义上最接近，且保证界面永不出现空徽章。
 */
function kindLabelKey(kind: string): 'lifecycle.kind.auto' | 'lifecycle.kind.manual' | 'lifecycle.kind.undo' | 'lifecycle.kind.baseline' | 'lifecycle.kind.pre-restore' {
  switch (kind) {
    case 'auto': return 'lifecycle.kind.auto'
    case 'manual': return 'lifecycle.kind.manual'
    case 'undo': return 'lifecycle.kind.undo'
    case 'baseline': return 'lifecycle.kind.baseline'
    case 'pre-restore': return 'lifecycle.kind.pre-restore'
    default: return 'lifecycle.kind.manual'
  }
}

/** 崩溃归因 → 字典键（null 走 unknown，绝不显示空白）。 */
function crashReasonKey(reason: string | null): 'lifecycle.crash.reason.session-corrupt' | 'lifecycle.crash.reason.bundle-check' | 'lifecycle.crash.reason.patch-tree' | 'lifecycle.crash.reason.unknown' {
  switch (reason) {
    case 'session-corrupt': return 'lifecycle.crash.reason.session-corrupt'
    case 'bundle-check': return 'lifecycle.crash.reason.bundle-check'
    case 'patch-tree': return 'lifecycle.crash.reason.patch-tree'
    default: return 'lifecycle.crash.reason.unknown'
  }
}

/** 建议动作 → 字典键。 */
function crashAdviceKey(advice: string): 'lifecycle.crash.advice.restore-last-good' | 'lifecycle.crash.advice.repair-session' | 'lifecycle.crash.advice.check-bundles' | 'lifecycle.crash.advice.check-patch-tree' {
  switch (advice) {
    case 'restore-last-good': return 'lifecycle.crash.advice.restore-last-good'
    case 'repair-session': return 'lifecycle.crash.advice.repair-session'
    case 'check-bundles': return 'lifecycle.crash.advice.check-bundles'
    case 'check-patch-tree': return 'lifecycle.crash.advice.check-patch-tree'
    default: return 'lifecycle.crash.advice.restore-last-good'
  }
}

/**
 * 字节数 → 人类可读。刻意手写而非 Intl.NumberFormat：只需 3 档且要稳定
 * （locale 差异会让快照体积在 zh/en 间跳变，列表里看起来像数据变了）。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 时间戳 → 本地可读；非法/缺失时回落到原串（绝不抛错，快照时间可能来自损坏文件）。 */
function formatTime(value: string | null): string {
  if (value === null || value === '') return '-'
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  return new Date(ms).toLocaleString()
}

export function LifecyclePanel({ lifecycleApi, t, openRecoveryWizard }: LifecyclePanelProps) {
  const [state, setState] = useState<PanelState>({
    loading: true,
    status: null,
    crash: null,
    rescue: null,
    error: null,
    busy: null,
  })
  /** 手动快照的原因输入（受控；随快照提交后清空） */
  const [reason, setReason] = useState('')
  /** 各确认弹窗开关 */
  const [undoOpen, setUndoOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<LifecycleSnapshotMeta | null>(null)
  const [rescueOpen, setRescueOpen] = useState(false)

  /** 卸载后不再 setState（避免 React 警告与竞态覆盖） */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /**
   * 重拉全部只读状态。crash / rescue 失败静默降级为 null：
   * 它们服务于「异常路径」，其失败不应让正常的快照列表也看不见。
   */
  const load = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const status = await lifecycleApi.status()
      if (!mounted.current) return
      setState((s) => ({ ...s, loading: false, status, error: null }))
    } catch (error) {
      if (!mounted.current) return
      setState((s) => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      return
    }
    // 次级只读链（崩溃归因 / 救援状态）：并行且各自吞错
    const [crash, rescue] = await Promise.all([
      lifecycleApi.crash().catch(() => null),
      lifecycleApi.rescueStatus().catch(() => null),
    ])
    if (!mounted.current) return
    setState((s) => ({ ...s, crash, rescue }))
  }, [lifecycleApi])

  useEffect(() => { void load() }, [load])

  /**
   * 执行一次变更动作并刷新：错误统一走 toast（不占用页内空间），
   * 成功与否以 Host 返回为准 —— 绝不在本地假设成功。
   */
  const runAction = useCallback(async (
    kind: NonNullable<PanelState['busy']>,
    action: () => Promise<void>,
  ): Promise<void> => {
    setState((s) => ({ ...s, busy: kind }))
    try {
      await action()
    } catch (error) {
      toast.error(redact(error instanceof Error ? error.message : String(error)))
    } finally {
      if (mounted.current) setState((s) => ({ ...s, busy: null }))
      await load()
    }
  }, [load])

  /** 撤销/重做共用：把 outcome 如实翻译成提示（失败原因直接展示枚举码，不粉饰）。 */
  const reportOutcome = useCallback((
    outcome: LifecycleOutcome,
    okKey: 'lifecycle.undoOk' | 'lifecycle.redoOk',
    noneKey: 'lifecycle.undoNone' | 'lifecycle.redoNone',
  ): void => {
    if (outcome.ok) {
      toast.ok(t(okKey, { id: outcome.targetId ?? '' }))
      return
    }
    // reason 为引擎给出的稳定枚举码（如 already-at-state）；缺失则退回「无可撤销」
    if (outcome.reason !== null && outcome.reason !== '') toast.warn(redact(outcome.reason))
    else toast.info(t(noneKey))
  }, [t])

  const handleUndo = useCallback(async (): Promise<void> => {
    setUndoOpen(false)
    await runAction('undo', async () => {
      reportOutcome(await lifecycleApi.undo(), 'lifecycle.undoOk', 'lifecycle.undoNone')
    })
  }, [lifecycleApi, reportOutcome, runAction])

  const handleRedo = useCallback(async (): Promise<void> => {
    await runAction('redo', async () => {
      reportOutcome(await lifecycleApi.redo(), 'lifecycle.redoOk', 'lifecycle.redoNone')
    })
  }, [lifecycleApi, reportOutcome, runAction])

  const handleSnapshot = useCallback(async (): Promise<void> => {
    const trimmed = reason.trim()
    await runAction('snapshot', async () => {
      const res = await lifecycleApi.snapshot(trimmed !== '' ? { reason: trimmed } : {})
      toast.ok(t('lifecycle.snapshotCreated', { id: res.id }))
      if (mounted.current) setReason('')
    })
  }, [lifecycleApi, reason, runAction, t])

  const handleRemove = useCallback(async (): Promise<void> => {
    const target = removeTarget
    setRemoveTarget(null)
    if (target === null) return
    await runAction('remove', async () => {
      await lifecycleApi.remove(target.id)
      toast.ok(t('lifecycle.delete'))
    })
  }, [lifecycleApi, removeTarget, runAction, t])

  const handleRescueOn = useCallback(async (): Promise<void> => {
    setRescueOpen(false)
    await runAction('rescue', async () => {
      const res = await lifecycleApi.rescueOn()
      if (res.ok) toast.ok(t('lifecycle.rescue.on'))
      else toast.error(redact(res.message ?? t('lifecycle.rescue.title')))
    })
  }, [lifecycleApi, runAction, t])

  const handleRescueOff = useCallback(async (): Promise<void> => {
    await runAction('rescue', async () => {
      const res = await lifecycleApi.rescueOff()
      if (res.ok) toast.ok(t('lifecycle.rescue.off'))
      else toast.error(redact(res.message ?? t('lifecycle.rescue.title')))
    })
  }, [lifecycleApi, runAction, t])

  /** 「回退到最后正常状态」：引擎侧就是 undo（按内容差异挑目标），界面如实标注。 */
  const handleRestoreLastGood = useCallback(async (): Promise<void> => {
    await runAction('undo', async () => {
      reportOutcome(await lifecycleApi.undo(), 'lifecycle.undoOk', 'lifecycle.undoNone')
    })
  }, [lifecycleApi, reportOutcome, runAction])

  const status = state.status
  const busy = state.busy !== null

  // 首屏加载态：保留标题，避免布局跳动
  if (state.loading && status === null) {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('lifecycle.snapshots')} subtitle={t('lifecycle.crash.title')} />
        <div className={css.statRow}><Spinner label={t('common.loading')} /></div>
      </div>
    )
  }

  // 主链失败：给出可重试的错误横幅（次级链失败不影响这里）
  if (state.error !== null && status === null) {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('lifecycle.snapshots')} />
        {/* F-02：t 必传 —— 否则英文界面下错误标题/建议动作恒中文 */}
        <ErrorBanner error={new Error(redact(state.error))} onRetry={() => void load()} retrying={state.loading} t={lifecycleApi.t} />
      </div>
    )
  }

  const snapshots = status?.snapshots ?? []
  const crash = state.crash
  const rescue = state.rescue
  const rescueActive = rescue?.active === true
  // 崩溃横幅仅在真的崩溃时显示（crashed=false 时 crashReason 恒为 null，不得据此渲染）
  const showCrash = crash !== null && crash.crashed
  const canRestoreLastGood = showCrash && crash.lastGoodSnapshotId !== null

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('lifecycle.snapshots')} />

      {/* 崩溃横幅：只有 crashed=true 才渲染；归因 + 建议 + 回退入口 */}
      {showCrash && (
        <Banner kind="error">
          <div className={css.statRow}>
            <WarnIcon size={14} />
            <strong>{t('lifecycle.crash.title')}</strong>
            <Badge kind="error">{t(crashReasonKey(crash.crashReason))}</Badge>
          </div>
          <div className={css.hint}>{t(crashAdviceKey(crash.advice))}</div>
          {crash.lastGoodAt !== null && (
            <div className={css.hint}>{t('lifecycle.crash.lastGood', { time: formatTime(crash.lastGoodAt) })}</div>
          )}
          <div className={css.actionRow}>
            <Button
              variant="danger"
              disabled={busy || !canRestoreLastGood}
              loading={state.busy === 'undo'}
              onClick={() => void handleRestoreLastGood()}
              title={t('lifecycle.undoTitle')}
            >
              {t('lifecycle.crash.restoreLastGood')}
            </Button>
          </div>
          {/* 如实说明：界面上没有第二条恢复通道，这里走的就是撤销引擎 */}
          {canRestoreLastGood && (
            <div className={css.hint}>
              {t('lifecycle.undo')} · {t('lifecycle.undoTitle')}
            </div>
          )}
        </Banner>
      )}

      {/* 救援模式已开启：必须足够醒目 —— 此时插件集是残缺的 */}
      {rescueActive && (
        <Banner kind="warn">
          <div className={css.statRow}>
            <WarnIcon size={14} />
            <strong>{t('lifecycle.rescue.active', { time: formatTime(rescue?.enteredAt ?? null) })}</strong>
          </div>
          <div className={css.hint}>{t('lifecycle.rescue.restartHint')}</div>
        </Banner>
      )}

      {/*
        交叉指引：本页 = 一键回退（撤销/重做）；崩溃后的完整恢复需要在另一条通道完成。
        两者语义不同故不合并入口，但用户必须知道另一条通道在哪 —— 否则会误以为
        「没有可撤销的变化」就等于「没救了」。
      */}
      {openRecoveryWizard !== undefined && (
        <Card>
          <div className={css.groupLabel}>{t('lifecycle.guided.title')}</div>
          <div className={css.hint}>{t('lifecycle.guided.desc')}</div>
          <div className={css.actionRow}>
            <Button variant="ghost" onClick={() => { openRecoveryWizard() }}>
              {t('lifecycle.guided.action')}
            </Button>
          </div>
        </Card>
      )}

      {/* 撤销 / 重做 —— 本页的头号能力 */}
      <Card>
        <div className={css.groupLabel}>{t('lifecycle.undo')} / {t('lifecycle.redo')}</div>
        <div className={css.actionRow}>
          <Button
            variant="primary"
            disabled={busy || status?.canUndo !== true}
            loading={state.busy === 'undo'}
            onClick={() => { setUndoOpen(true) }}
            title={t('lifecycle.undoTitle')}
          >
            {t('lifecycle.undo')}
          </Button>
          <Button
            disabled={busy || status?.canRedo !== true}
            loading={state.busy === 'redo'}
            onClick={() => void handleRedo()}
            title={t('lifecycle.redoTitle')}
          >
            {t('lifecycle.redo')}
          </Button>
          {status?.canUndo !== true && <span className={css.hint}>{t('lifecycle.undoNone')}</span>}
        </div>
      </Card>

      {/* 救援模式 */}
      <Card>
        <div className={css.groupLabel}>{t('lifecycle.rescue.title')}</div>
        <div className={css.hint}>{t('lifecycle.rescue.desc')}</div>
        <div className={css.statRow}>
          <Badge kind={rescueActive ? 'warn' : 'ok'}>
            {rescueActive ? t('lifecycle.rescue.title') : t('lifecycle.rescue.inactive')}
          </Badge>
          {/* stale：换机 / 重建 home 后家目录指纹不匹配，救援标记已自动降级（不生效） */}
          {rescue?.stale === true && <Badge kind="warn">{t('lifecycle.rescue.stale')}</Badge>}
        </div>
        <div className={css.actionRow}>
          {rescueActive
            ? (
              <Button variant="danger" disabled={busy} loading={state.busy === 'rescue'} onClick={() => void handleRescueOff()}>
                {t('lifecycle.rescue.exit')}
              </Button>
            )
            : (
              <Button variant="danger" disabled={busy} onClick={() => { setRescueOpen(true) }}>
                {t('lifecycle.rescue.enter')}
              </Button>
            )}
        </div>
      </Card>

      {/* 自动快照指示灯 + 立即快照 */}
      <Card>
        <div className={css.groupLabel}>{t('lifecycle.snapshots')}</div>
        <div className={css.statRow}>
          <Badge kind={status?.watching === true ? 'ok' : 'warn'}>
            {status?.watching === true ? t('lifecycle.autoOn') : t('lifecycle.autoOff')}
          </Badge>
          <span className={css.hint}>
            {t('lifecycle.lastAuto')}: {status?.lastAutoAt != null ? formatTime(status.lastAutoAt) : t('lifecycle.never')}
          </span>
          <span className={css.hint}>
            {t('lifecycle.sections', { count: String(status?.total ?? 0) })}
          </span>
        </div>
        <Field label={t('lifecycle.snapshotReason')}>
          <input
            className={css.input}
            type="text"
            value={reason}
            placeholder={t('lifecycle.snapshotReason')}
            disabled={busy}
            onChange={(e) => { setReason(e.target.value) }}
          />
        </Field>
        <div className={css.actionRow}>
          <Button
            variant="primary"
            disabled={busy}
            loading={state.busy === 'snapshot'}
            onClick={() => void handleSnapshot()}
          >
            <SnapshotIcon size={13} /> {t('lifecycle.snapshotNow')}
          </Button>
          <Button disabled={busy} onClick={() => void load()}>{t('nav.refresh')}</Button>
        </div>
      </Card>

      {/* 快照列表 */}
      {snapshots.length === 0 ? (
        <Empty>{t('lifecycle.empty')}</Empty>
      ) : (
        <Card>
          <div className={css.snapshotList}>
            {snapshots.map((snap) => (
              <div key={snap.id} className={css.snapshotRow}>
                <div className={css.snapshotRowHeader}>
                  <span className={css.snapshotRowMain} title={snap.id}>{snap.id}</span>
                  <Badge kind="info">
                    {t(kindLabelKey(snap.kind))}
                  </Badge>
                  {snap.pinned && <Badge kind="ok">{t('snapshots.pin')}</Badge>}
                  <span className={css.hint}>{formatTime(snap.createdAt)}</span>
                  <span className={css.hint}>{t('lifecycle.sections', { count: String(snap.sections.length) })}</span>
                  <span className={css.hint}>{formatBytes(snap.totalBytes)}</span>
                  <button
                    type="button"
                    className={css.iconBtn}
                    aria-label={t('lifecycle.delete')}
                    title={t('lifecycle.delete')}
                    disabled={busy}
                    onClick={() => { setRemoveTarget(snap) }}
                  >
                    <DeleteIcon size={13} />
                  </button>
                </div>
                {/* reason 为引擎枚举码（manual / plugin-change / before-restore:<id>），如实展示 */}
                {snap.reason !== '' && <div className={css.hint}>{redact(snap.reason)}</div>}
                {snap.note !== null && snap.note !== '' && (
                  <div className={css.hint}>{redact(snap.note)}</div>
                )}
                {snap.tags.length > 0 && (
                  <div className={css.statRow}>
                    {snap.tags.map((tag) => <Badge key={tag} kind="info">{redact(tag)}</Badge>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 撤销二次确认（dеstruсtivе-ish：会改写当前配置） */}
      <ConfirmDialog
        open={undoOpen}
        title={t('lifecycle.undo')}
        message={t('lifecycle.undoConfirm')}
        confirmLabel={t('lifecycle.undo')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.busy === 'undo'}
        onConfirm={handleUndo}
        onCancel={() => { setUndoOpen(false) }}
      />

      {/* 删除快照二次确认 */}
      <ConfirmDialog
        open={removeTarget !== null}
        title={t('lifecycle.delete')}
        message={t('lifecycle.deleteConfirm', { id: removeTarget?.id ?? '' })}
        confirmLabel={t('lifecycle.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.busy === 'remove'}
        onConfirm={handleRemove}
        onCancel={() => { setRemoveTarget(null) }}
      />

      {/* 进入救援模式二次确认（强警告：需重启 DSH） */}
      <ConfirmDialog
        open={rescueOpen}
        title={t('lifecycle.rescue.enter')}
        message={t('lifecycle.rescue.confirm')}
        confirmLabel={t('lifecycle.rescue.enter')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.busy === 'rescue'}
        onConfirm={handleRescueOn}
        onCancel={() => { setRescueOpen(false) }}
      />
    </div>
  )
}
