/**
 * 运行中心（Run Center）—— 活动抽屉的「进行中」段。
 *
 * 为什么放在抽屉里而不是新页面：
 *  - 运行任务是**跨页面**的（用户可能在「市场」页时导入还在跑），而 564×720 画布下 7 个英文页签
 *    已经溢出（仓库专门写了 nav-overflow 兜底），第 8 个页签的代价大于收益；
 *  - 「活动」按钮在 navActions 里**任何页面都在**，状态栏那句「N 个任务进行中」现在也是它的入口；
 *  - 抽屉正文已经 `overflow-y:auto; min-height:0`，长卡片列表直接可用。
 *
 * 与「迁移历史」的边界（不合并成一个视图）：
 *  - 本视图 = 宿主 /runs 的**内存瞬时态**（终态 30 分钟后被 prune）；
 *  - 迁移历史 = 已完成操作的**持久审计**。混一页会出现「刷新后历史里少了一半」的认知撕裂。
 *
 * 数据：一次 GET /runs?scope=recent（含 running 与刚结束的），1.5s 轮询；抽屉关闭即卸载即停表。
 */
import { useCallback, useEffect, useState } from 'react'
import type { RunState } from '../../core/run-registry.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { RecoveryApi } from '../recovery/recovery-api.ts'
import type { RecoveryLockStatus } from '../../ui/types.ts'
import { cancelDialogModel, runCards, runSummary } from '../../ui/runs-view.ts'
import type { CancelDecision, CancelDialogModel, RunCardModel } from '../../ui/runs-view.ts'
import { runStateProgress } from '../run-store.ts'
import { Badge, Banner, Button, Card, Empty, Spinner } from './ui.tsx'
import { Modal } from './Modal.tsx'
import { ProgressBar } from './ProgressBar.tsx'
import { toast } from './toast-store.ts'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

/** 轮询间隔：与状态栏的观感一致（比导入向导的 500ms 慢，因为这里不是主工作区）。 */
const POLL_MS = 1500

/** t() 的键类型：动态 key（runs.kind.* / runs.status.*）只能经此断言传入（与壳里 nav 标签同一写法）。 */
type CmKey = Parameters<TranslateNS<'config-manager'>>[0]

export interface RunsCenterProps {
  api: ConfigManagerApi
  /**
   * 事故恢复端口：运行中心用它显示**环境锁**状态并回收残留锁。
   * 为什么运行中心要管锁：用户报告的场景是「导入终止不了 → 锁一直被占据」——
   * 残留锁在运行中心看不见时，用户只会一遍遍点终止；把锁摆在「正在跑的任务」旁边才是它该在的位置。
   */
  recoveryApi: RecoveryApi
  t: TranslateNS<'config-manager'>
  /** 用户此前勾选的「失败不回滚」偏好：决策框默认选项跟随它（不推翻既有心智）。 */
  defaultRollbackOnError: boolean
}

function badgeKind(status: RunCardModel['status']): 'ok' | 'info' | 'error' {
  if (status === 'done') return 'ok'
  if (status === 'failed') return 'error'
  return 'info'
}

export function RunsCenter({ api, recoveryApi, t, defaultRollbackOnError }: RunsCenterProps) {
  /** null = 首次加载中（与「空列表」区分：空列表不该闪 loading）。 */
  const [runs, setRuns] = useState<RunState[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 环境锁状态（null = 无锁事项；undefined = 还读不到）。 */
  const [lock, setLock] = useState<RecoveryLockStatus | null>(null)
  /** 读锁状态失败的原因（fail-soft：不阻断任务列表，但必须如实说一句）。 */
  const [lockError, setLockError] = useState<string | null>(null)
  /** 正在发请求的 runId（按钮 loading/防重）。 */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 决策框当前针对的 run（null = 未打开）。 */
  const [dialogRun, setDialogRun] = useState<RunState | null>(null)
  const [decision, setDecision] = useState<CancelDecision>('rollback')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.runsRecent()
      setRuns(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // 锁状态单独取：它读不到不该拖垮任务列表（但也不能静默 —— 见 lockError 的渲染）
    try {
      const status = await recoveryApi.status()
      setLock(status.lock ?? null)
      setLockError(null)
    } catch (err) {
      setLockError(err instanceof Error ? err.message : String(err))
    }
  }, [api, recoveryApi])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  // now 每轮渲染取一次：轮询本身就每 1.5s 触发一次重渲染，相对时间因此自然更新
  const cards = runs === null ? [] : runCards(runs, { now: Date.now() })
  const summary = runs === null ? { running: 0, awaiting: 0, total: 0 } : runSummary(runs)

  /** 待决策的 run 自动弹框：终止已到达安全点，界面必须马上要一个回答。 */
  useEffect(() => {
    if (dialogRun !== null) return
    const waiting = (runs ?? []).find((r) => r.status === 'running' && r.pendingDecision === 'cancel')
    if (waiting === undefined) return
    setDialogRun(waiting)
    setDecision(cancelDialogModel(waiting, { defaultRollbackOnError }).defaultDecision)
  }, [runs, dialogRun, defaultRollbackOnError])

  const fail = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    toast.error(t('runs.actionFailed', { message: message === '' ? t('runs.unsupported') : message }))
  }

  const requestCancel = async (runId: string): Promise<void> => {
    setBusyId(runId)
    try {
      await api.cancelRun(runId)
      toast.info(t('runs.cancelRequestedToast'))
      await refresh()
    } catch (err) { fail(err) } finally { setBusyId(null) }
  }

  const skipCurrent = async (runId: string): Promise<void> => {
    setBusyId(runId)
    try {
      await api.skipExecute(runId)
      toast.info(t('runs.skipRequestedToast'))
      await refresh()
    } catch (err) { fail(err) } finally { setBusyId(null) }
  }

  const submitDecision = async (): Promise<void> => {
    const run = dialogRun
    if (run === null) return
    setBusyId(run.runId)
    try {
      const res = await api.decideRunCancel(run.runId, decision)
      if (res.accepted) toast.info(t('runs.decisionAcceptedToast'))
      else toast.warn(t('runs.decisionTooLateToast'))
      setDialogRun(null)
      await refresh()
    } catch (err) { fail(err) } finally { setBusyId(null) }
  }

  /** 回收残留锁（stale/corrupt 才允许；活锁由宿主按设计拒绝）。 */
  const [lockBusy, setLockBusy] = useState(false)
  const recoverLock = async (): Promise<void> => {
    setLockBusy(true)
    try {
      const res = await recoveryApi.recoverStaleLock(true)
      if (res.ok) toast.ok(t('runs.lock.recoverOk'))
      else toast.warn(t('runs.lock.recoverRefused', { state: res.state }))
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('runs.lock.recoverFailed', { message }))
    } finally { setLockBusy(false) }
  }

  const openDialog = (run: RunState): void => {
    setDialogRun(run)
    setDecision(cancelDialogModel(run, { defaultRollbackOnError }).defaultDecision)
  }

  const dialogModel: CancelDialogModel | null = dialogRun === null
    ? null
    : cancelDialogModel(dialogRun, { defaultRollbackOnError })

  return (
    <div className={css.runsCenter}>
      <div className={css.runsSummary}>
        <span className={css.runsSummaryTitle}>{t('shell.drawer.runs')}</span>
        {summary.running > 0 && <Badge kind="info">{t('runs.runningBadge', { count: String(summary.running) })}</Badge>}
        {summary.awaiting > 0 && <Badge kind="warn">{t('runs.awaitingBadge', { count: String(summary.awaiting) })}</Badge>}
      </div>
      {lockError !== null && <Banner kind="warn">{t('runs.lock.readFailed', { message: redact(lockError) })}</Banner>}
      {/* 环境锁卡片：FREE 不显示（绝大多数时候是空闲，别占地方）；
          LOCKED（活锁）只在本面板确实有任务在跑时显示 —— 那正是「它在挡着我」的场景现场。 */}
      {lock !== null && lockKind(lock.state) !== 'free' && (lockKind(lock.state) !== 'held' || summary.running > 0) && (
        <LockCard state={lock.state} busy={lockBusy} onRecover={() => { void recoverLock() }} t={t} />
      )}
      {error !== null && <Banner kind="error">{t('runs.loadFailed', { message: redact(error) })}</Banner>}
      {runs === null && error === null && <Spinner label={t('runs.loading')} />}
      {runs !== null && cards.length === 0 && <Empty>{t('runs.empty')}</Empty>}
      {cards.map((card) => {
        const run = (runs ?? []).find((r) => r.runId === card.runId)
        if (run === undefined) return null
        return (
          <Card key={card.runId}>
            <div className={css.runsCardHead}>
              <span className={css.runsCardTitle}>{t(card.kindLabelKey as CmKey)}</span>
              <Badge kind={badgeKind(card.status)}>{t(card.statusLabelKey as CmKey)}</Badge>
              {card.awaitingDecision && <Badge kind="warn">{t('runs.awaitingDecision')}</Badge>}
              {/* 相对时间：没有它，「正在跑」和「几小时前就结束的僵尸卡片」长得一模一样 */}
              <span className={css.runsCardTime}>{t(card.time.key as CmKey, card.time.params)}</span>
            </div>
            <ProgressBar
              event={runStateProgress(run)}
              active={card.status === 'running'}
              // 失败的任务绝不能渲染成「成功绿」（结束态的默认色是 success）
              failed={card.status === 'failed'}
            />
            {card.counts !== null && (
              <div className={css.runsCounts}>
                {t('runs.counts', {
                  ok: String(card.counts.ok),
                  warn: String(card.counts.warn),
                  fail: String(card.counts.fail),
                  skip: String(card.counts.skip),
                })}
              </div>
            )}
            {card.logTail.length > 0 && (
              <div className={css.runsLogTail}>
                {card.logTail.map((line, i) => (
                  <div key={`${card.runId}:${i}`} className={css.runsLogLine}>{redact(line)}</div>
                ))}
              </div>
            )}
            {/* 终止请求已到、还没到安全点：把「等了多久」写出来，并在等太久时给出出路。
                没有这一行，用户只能看到按钮点了没反应。 */}
            {card.cancelWait !== null && (
              <div className={card.cancelWait.stuck ? css.runsWarnNote : css.hint}>
                {card.cancelWait.minutes > 0
                  ? t('runs.cancelWaiting', { minutes: String(card.cancelWait.minutes) })
                  : t('runs.cancelWaitingJustNow')}
                {card.cancelWait.stuck && (
                  <div className={css.runsWarnNoteDetail}>{t('runs.cancelStuck')}</div>
                )}
              </div>
            )}
            {(card.canCancel || card.canSkip || card.awaitingDecision) && (
              <div className={css.runsCardActions}>
                {card.canSkip && (
                  <Button size="sm" disabled={busyId === card.runId} onClick={() => { void skipCurrent(card.runId) }}>
                    {t('import.skipCurrent')}
                  </Button>
                )}
                {card.awaitingDecision && (
                  <Button size="sm" variant="primary" onClick={() => { openDialog(run) }}>{t('runs.decideNow')}</Button>
                )}
                {card.canCancel && (
                  // 先发终止请求（引擎在**下一个计划项边界**暂停并把 run 置为待决策），
                  // 决策框由「发现 pendingDecision」自动弹出 —— 那时进度计数才是最终值，
                  // 用户看到的代价数字不会在等待期间继续变。
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === card.runId}
                    loading={busyId === card.runId}
                    onClick={() => { void requestCancel(card.runId) }}
                  >
                    {t('runs.cancelAction')}
                  </Button>
                )}
              </div>
            )}
          </Card>
        )
      })}
      {/* 保留期说明始终显示：空列表时它解释「为什么这里什么都没有」，有列表时它解释「为什么只有这些」 */}
      <div className={css.hint}>{t('runs.retentionHint')}</div>
      {dialogModel !== null && (
        <RunCancelDialog
          model={dialogModel}
          decision={decision}
          busy={busyId === dialogModel.runId}
          onChange={setDecision}
          onConfirm={() => { void submitDecision() }}
          onCancel={() => { setDialogRun(null) }}
          t={t}
        />
      )}
    </div>
  )
}

/**
 * 终止决策框：让用户选「回滚」还是「保留已应用项」，并把代价讲清楚。
 *
 * 为什么不复用 ConfirmDialog：确认框只有一个「确认」出口，而这里必须表达两个**语义不同**的处置
 * （回滚 = 撤销；保留 = 留下一笔未完成的导入 + 触发启动安全审计），且默认项要跟随用户偏好。
 */
function RunCancelDialog(props: {
  model: CancelDialogModel
  decision: CancelDecision
  busy: boolean
  onChange: (d: CancelDecision) => void
  onConfirm: () => void
  onCancel: () => void
  t: TranslateNS<'config-manager'>
}) {
  const { model, decision, busy, onChange, onConfirm, onCancel, t } = props
  const cost = model.appliedCount === null || model.pendingCount === null
    ? t('runs.cancelCostUnknown')
    : t('runs.cancelCost', { applied: String(model.appliedCount), pending: String(model.pendingCount) })
  return (
    <Modal open onClose={onCancel} title={t('runs.cancelTitle')} busy={busy}>
      <Modal.Header title={t('runs.cancelTitle')} onClose={onCancel} closeLabel={t('common.close')} closeDisabled={busy} />
      <Modal.Body scroll>
        <p className={css.hint}>{cost}</p>
        {model.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={css.runsOption}
            data-active={decision === option.id ? '' : undefined}
            aria-pressed={decision === option.id}
            disabled={busy}
            onClick={() => { onChange(option.id) }}
          >
            <span className={css.runsOptionTitle}>
              {t(option.labelKey as CmKey)}
              {option.id === model.defaultDecision && <span className={css.runsOptionTag}>{t('runs.recommended')}</span>}
            </span>
            <span className={css.runsOptionDesc}>{t(option.descKey as CmKey)}</span>
          </button>
        ))}
        {/* 「保留」的诚实边界：审计只能压低概率，不能承诺 DSH 一定能起来 */}
        <Banner kind="warn">{t('runs.cancelKeepWarn')}</Banner>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onCancel} disabled={busy}>{t('runs.cancelAbort')}</Button>
        <span className={css.statusSpacer} />
        <Button variant="danger" onClick={onConfirm} disabled={busy} loading={busy}>{t('runs.cancelConfirm')}</Button>
      </Modal.Footer>
    </Modal>
  )
}
/**
 * 环境锁分类（宿主只给 state 字符串；这里把它翻成三种展示语义）。
 *  - free：空闲（不显示卡片）
 *  - held：被活着的持有者占用（会自行释放；**不可**回收）
 *  - attention：需用户显式处理（残留锁 / 无法判定）→ 给「回收残留锁」按钮
 */
function lockKind(state: string): 'free' | 'held' | 'attention' {
  if (state === 'FREE') return 'free'
  if (state === 'LOCKED') return 'held'
  return 'attention'
}

/**
 * 环境锁卡片：把「谁在挡着写操作」摆到正在跑的任务旁边，并给出唯一可执行的出路。
 *
 * 为什么必须分清 held / attention：宿主按设计**拒绝回收活锁**（防并发写），所以对活锁
 * 放一个「回收」按钮只会制造「点了没用」的挫败感；活锁的正确出路是「等它自己结束」，
 * 而当它正是那张「长时间等不到安全点」的导入时 —— 只能重启 DSH。
 */
function LockCard(props: {
  state: string
  busy: boolean
  onRecover: () => void
  t: TranslateNS<'config-manager'>
}) {
  const { state, busy, onRecover, t } = props
  const kind = lockKind(state)
  const attention = kind === 'attention'
  return (
    <Card>
      <div className={css.runsCardHead}>
        <span className={css.runsCardTitle}>{t('runs.lock.title')}</span>
        <Badge kind={attention ? 'warn' : 'info'}>
          {attention ? t('runs.lock.needsAction') : t('runs.lock.held')}
        </Badge>
      </div>
      <div className={css.hint}>
        {attention ? t('runs.lock.attentionDesc') : t('runs.lock.heldDesc')}
      </div>
      {attention && (
        <div className={css.runsCardActions}>
          <Button size="sm" variant="primary" loading={busy} disabled={busy} onClick={onRecover}>
            {t('runs.lock.recover')}
          </Button>
        </div>
      )}
    </Card>
  )
}
