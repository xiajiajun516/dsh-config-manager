/**
 * 定时全量备份设置卡（m-backup / m-retention）—— t43 从 SnapshotsPanel.tsx 物理拆出。
 *
 * 边界：本文件只做装配与副作用编排（加载/保存/立即备份/草稿镜像 runStore）；
 * 校验与派生逻辑在 `../../ui/backup-schedule.ts`（草稿校验/脏判定/运行状态）与
 * `../../ui/snapshots-view.ts`（间隔事实行形状与字典键）；**不新增任何用户可见文案**。
 *
 * 状态自持；草稿镜像 runStore.snapshots.backupDraft（未保存修改切页/刷新保留），
 * 保存成功清草稿（宿主配置为权威）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Checkbox, Spinner, StatusDot } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { runStore } from '../run-store.ts'
// issue #31：宿主回传的 skipReason 是机器 token（如 'mutation-locked'），必须经统一映射
// 再展示——否则备份卡「上次运行」直接显示英文裸 token。
import { describeSkipReason } from '../sync/history-model.ts'
import {
  BACKUP_INTERVAL_OPTIONS,
  DEFAULT_RETENTION_POLICY,
  RETENTION_FIELDS,
  RETENTION_FIELD_LIMITS,
  WEEKDAY_OPTIONS,
  backupDraftDirty,
  backupRunBadgeKind,
  hasRetentionTiers,
  normalizeRetentionPolicy,
  validateBackupScheduleDraft,
  type BackupInterval,
  type BackupRunStatus,
  type BackupScheduleDraft,
  type BackupScheduleStatus,
  type RetentionPolicy,
} from '../../ui/backup-schedule.ts'
import {
  backupIntervalLabelKey,
  backupRunStatusLabelKey,
  formatRunTime,
  scheduleIntervalFact,
  weekdayLabelKey,
} from '../../ui/snapshots-view.ts'
import css from '../config-manager.module.css'
export function BackupScheduleCard({ api, t, onBackupDone }: {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 「立即备份」成功完成后回调（父组件据此刷新备份文件列表） */
  onBackupDone?: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BackupScheduleDraft>({ enabled: false, interval: '24h' })
  const [saved, setSaved] = useState<BackupScheduleStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<BackupRunStatus | undefined>(undefined)
  const [lastRunDetail, setLastRunDetail] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  /** m-retention：保留策略草稿（三层；与 interval/customSchedule 同属草稿，随保存一起提交） */
  const [retentionDraft, setRetentionDraft] = useState<RetentionPolicy>(DEFAULT_RETENTION_POLICY)
  /** 挂载守卫：切页卸载后异步回调只更新 store（草稿），不再 setState */
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    api.backupSchedule().then(
      (schedule) => {
        if (!mountedRef.current) return
        setSaved(schedule)
        // 有未保存草稿（切页回来）则保留，否则以宿主配置为权威
        setDraft(runStore.getSnapshot().snapshots.backupDraft ?? {
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        // m-retention：未保存草稿里的策略优先（切页回来不丢），否则取宿主真值（缺省补齐）
        setRetentionDraft(
          normalizeRetentionPolicy(runStore.getSnapshot().snapshots.backupDraft?.retention ?? schedule.retention),
        )
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
        setStatus('ready')
      },
      (err) => {
        if (!mountedRef.current) return
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  useEffect(load, [api])

  const updateDraft = (next: BackupScheduleDraft): void => {
    setDraft(next)
    runStore.patch({ snapshots: { backupDraft: next } })
  }

  /** m-retention：更新保留策略草稿（随 enabled/interval 一起提交；同时镜像 runStore 防切页丢失） */
  const updateRetention = (next: RetentionPolicy): void => {
    setRetentionDraft(next)
    updateDraft({ ...draft, retention: next })
  }

  const save = (): void => {
    if (saving || running) return
    // m-retention：策略草稿合并进提交体（单入口校验：非法整数/超范围在此被拦下）
    const parsed = validateBackupScheduleDraft({ ...draft, retention: retentionDraft })
    if (!parsed.ok) {
      // 表单内联校验：位置有语义（紧邻被校验的控件），保留就地提示而非 Toast
      setDraftError(parsed.error)
      return
    }
    setSaving(true)
    setDraftError(null)
    api.saveBackupSchedule(parsed.value).then(
      (schedule) => {
        // 宿主已保存：无论面板是否仍挂载都清 store 草稿（否则切回会显示陈旧未保存态）
        runStore.patch({ snapshots: { backupDraft: null } })
        if (!mountedRef.current) return
        setSaved(schedule)
        setDraft({
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        // 以宿主回传为权威回填策略草稿（宿主持久化后的真值）
        setRetentionDraft(normalizeRetentionPolicy(schedule.retention))
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
        setSaving(false)
        toast.ok(t('backupSchedule.saved'))
      },
      (err) => {
        if (!mountedRef.current) return
        setSaving(false)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const runNow = (): void => {
    if (running || saving) return
    setRunning(true)
    setDraftError(null)
    api.runBackupNow().then(
      (res) => {
        if (mountedRef.current) {
          setSaved(res.schedule)
          // 运行结果不回写策略草稿（用户可能正在编辑；宿主配置已是权威，保存时以草稿为准）
          setLastRun(res.run.status)
          setLastRunDetail(res.run.zip !== undefined && res.run.zip !== ''
            ? res.run.zip
            : (res.run.skipReason !== undefined ? describeSkipReason(res.run.skipReason) : formatRunTime(res.schedule.lastRunAt)))
          setRunning(false)
        }
        // 无论面板是否仍挂载都通知父组件刷新备份文件列表（新 ZIP 已落盘）
        onBackupDone?.()
      },
      (err) => {
        if (!mountedRef.current) return
        setRunning(false)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  // m-retention：脏判定同时看策略草稿（策略改动也要让「保存设置」可点）
  const dirty = backupDraftDirty({ ...draft, retention: retentionDraft }, saved)
  const busy = saving || running
  /**
   * 事实行「备份间隔」文案：整行事实统一取宿主权威值 saved（与事实行语义一致，
   * 也与 SyncSettingsView 的状态事实行同源——草稿编辑只在下方设置行体现，
   * 未保存前不改写事实行，避免把未生效的档位显示成已生效）。
   * custom 档在窄格内显示具体时刻（如「周一 03:00」），其余档位用档位文案；
   * 均由既有 locale 键拼出，不新增文案键（结构化事实来自 ui/snapshots-view.ts）。
   */
  const intervalFactText = (): string => {
    const fact = scheduleIntervalFact(saved)
    if (fact.kind === 'none') return '—'
    if (fact.kind === 'interval') return t(backupIntervalLabelKey(fact.interval))
    const dayKey = weekdayLabelKey(fact.dayOfWeek)
    const day = dayKey === null ? String(fact.dayOfWeek) : t(dayKey)
    return `${day} ${String(fact.hour).padStart(2, '0')}:${String(fact.minute).padStart(2, '0')}`
  }
  /** 上次运行状态文案（未知 → '—'）。 */
  const runStatusText = (value: BackupRunStatus | undefined): string => {
    const key = backupRunStatusLabelKey(value)
    return key === null ? '—' : t(key)
  }
  /** 星期文案（值域外回退原始数字，绝不吞掉取值）。 */
  const weekdayText = (day: number): string => {
    const key = weekdayLabelKey(day)
    return key === null ? String(day) : t(key)
  }

  return (
    <Card>
      {/* 头部：标题 + 上次运行结果徽章 + 右侧动作（时间已下移到事实行，头部不再重复） */}
      <div className={css.groupHeader}>
        <span className={css.groupLabel}>{t('backupSchedule.title')}</span>
        {lastRun !== undefined && (
          <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusText(lastRun)}</Badge>
        )}
        <span className={css.statusSpacer} />
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !dirty}
          onClick={save}
          title={dirty ? undefined : t('backupSchedule.saved')}
        >
          {saving ? <Spinner /> : t('backupSchedule.save')}
        </Button>
        <Button size="sm" disabled={busy || !(saved?.enabled ?? false)} onClick={runNow}>
          {running ? <Spinner /> : t('backupSchedule.runNow')}
        </Button>
      </div>

      {status === 'loading' && <Spinner label={t('backupSchedule.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {t('backupSchedule.error')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && (
        <>
          {/* 事实行：开关状态 / 备份间隔（各占半行）+ 上次运行（独占整行）。
              整行统一取宿主权威值 saved（未保存的草稿编辑不改写事实行，避免把未生效的
              档位显示成已生效）；时间已从头部移到这里，头部不再重复展示。
              .factGrid 是 4 列网格，前两格各 span 2 → 上半行两等分、无空列留白。 */}
          <div className={css.factGrid} style={{ marginTop: 8 }}>
            <div className={css.factCell} style={{ gridColumn: 'span 2' }}>
              <span className={css.factLabel}>{t('snapshots.status')}</span>
              <span className={css.factValue}>
                {/* 复用既有 .infoValue（inline-flex + 居中 + gap，且不覆盖字号/颜色）做图标文字对齐 */}
                <span className={css.infoValue}>
                  <StatusDot kind={(saved?.enabled ?? false) ? 'ok' : 'idle'} />
                  {(saved?.enabled ?? false) ? t('overview.state.on') : t('overview.state.off')}
                </span>
              </span>
            </div>
            <div className={css.factCell} style={{ gridColumn: 'span 2' }}>
              <span className={css.factLabel}>{t('backupSchedule.interval')}</span>
              <span className={css.factValue}>{intervalFactText()}</span>
            </div>
            {/* 上次运行独占整行（grid-column:1/-1）：lastRunDetail 在「立即备份」成功后
                是 ZIP 相对路径（可较长），四列窄格会被 text-overflow 截断成「…」。 */}
            <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
              <span className={css.factLabel}>{t('backupSchedule.lastRun')}</span>
              <span className={css.factValue}>
                {lastRun === undefined
                  /* 从未运行：只给一句事实，不补「—」占位（避免「从未运行 —」的双重否定感） */
                  ? <span className={css.hint}>{t('backupSchedule.never')}</span>
                  : (
                    <span className={css.infoValue}>
                      <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusText(lastRun)}</Badge>
                      <span className={css.mono}>
                        {lastRunDetail !== null && lastRunDetail !== '' ? lastRunDetail : '—'}
                      </span>
                    </span>
                  )}
              </span>
            </div>
          </div>
          {/* 卡片级说明（小字）：保留在事实行下方、设置行上方 —— 信息分层依次是
              头部（标题/徽章/动作）→ 事实行 → 说明 → 设置 */}
          <div className={css.hint} style={{ marginTop: 8 }}>{t('backupSchedule.hint')}</div>

          {/* 设置行：开关（短标签）+（已开启时）间隔 / 周几 / 时刻 */}
          <div className={css.actionRow} style={{ marginTop: 10, marginBottom: 0 }}>
            <Checkbox
              checked={draft.enabled}
              onChange={(checked) => { updateDraft({ ...draft, enabled: checked }) }}
              label={t('backupSchedule.enabled')}
              disabled={busy}
            />
            {draft.enabled && (
              <select
                className={css.select}
                value={draft.interval}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => { updateDraft({ ...draft, interval: event.target.value as BackupInterval }) }}
              >
                {BACKUP_INTERVAL_OPTIONS.map((interval) => (
                  <option key={interval} value={interval}>{t(backupIntervalLabelKey(interval))}</option>
                ))}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.dayOfWeek ?? 1}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: Number(event.target.value),
                      hour: draft.customSchedule?.hour ?? 3,
                      minute: draft.customSchedule?.minute ?? 0,
                    },
                  })
                }}
              >
                {WEEKDAY_OPTIONS.map((w) => (
                  <option key={w.value} value={w.value}>{weekdayText(w.value)}</option>
                ))}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.hour ?? 3}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1,
                      hour: Number(event.target.value),
                      minute: draft.customSchedule?.minute ?? 0,
                    },
                  })
                }}
              >
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.minute ?? 0}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1,
                      hour: draft.customSchedule?.hour ?? 3,
                      minute: Number(event.target.value),
                    },
                  })
                }}
              >
                {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
              </select>
            )}
          </div>
          {/* 设置行说明：勾选启用后启动即执行一次（行为说明；卡片级 hint 只讲「备什么」，
              此处讲「何时跑」，两者语义不重复，故仅在已开启时出现，避免未开启时的说明噪音） */}
          {draft.enabled && <div className={css.hint} style={{ marginTop: 6 }}>{t('backupSchedule.enabledHint')}</div>}
          {/* custom 档专属说明：仅在已开启且选中自定义档时出现，紧贴上面的三个时刻下拉 */}
          {draft.enabled && draft.interval === 'custom' && <div className={css.hint} style={{ marginTop: 6 }}>{t('backupSchedule.customHint')}</div>}

          {/* m-retention：保留策略（GFS 分层；快照 + 定时备份共用）——无常量硬编码，值全来自本卡片状态 */}
          <div className={css.groupHeader} style={{ marginTop: 12 }}>
            <span className={css.groupLabel}>{t('retention.title')}</span>
            <span className={css.statusSpacer} />
            <span className={css.hint}>
              {!hasRetentionTiers(retentionDraft) && t('retention.tiersOff')}
            </span>
          </div>
          <div className={css.hint} style={{ marginBottom: 8 }}>{t('retention.hint')}</div>
          <div className={css.actionRow} style={{ marginBottom: 0 }}>
            {RETENTION_FIELDS.map((field) => {
              const limits = RETENTION_FIELD_LIMITS[field]
              const unit = field === 'keepLast'
                ? t('retention.unit')
                : field === 'keepMonthly' ? t('retention.months') : t('retention.years')
              return (
                <label key={field} className={css.field} style={{ margin: 0 }}>
                  <span className={css.fieldLabel}>
                    {field === 'keepLast'
                      ? t('retention.keepLast')
                      : field === 'keepMonthly' ? t('retention.keepMonthly') : t('retention.keepYearly')}
                  </span>
                  <input
                    className={css.input}
                    type="number"
                    min={limits.min}
                    max={limits.max}
                    step={1}
                    value={retentionDraft[field]}
                    disabled={busy}
                    style={{ width: 88 }}
                    aria-label={t('retention.title')}
                    onChange={(event) => {
                      // 空输入/非法文本 → 视为 0（受控 input 不吞掉用户输入，保存时再由校验层把关）
                      const raw = event.target.value
                      const parsed = raw === '' ? 0 : Number(raw)
                      updateRetention({
                        ...retentionDraft,
                        [field]: Number.isFinite(parsed) ? parsed : 0,
                      })
                    }}
                  />
                  <span className={css.hint}>{unit}</span>
                </label>
              )
            })}
          </div>
          {/* 三层字段各自的行为说明（紧贴对应输入；仅在有分层时才需要，未启用时是噪音） */}
          {hasRetentionTiers(retentionDraft) && (
            <div className={css.hint} style={{ marginTop: 6 }}>
              {t('retention.keepLastHint')} · {t('retention.keepMonthlyHint')} · {t('retention.keepYearlyHint')}
            </div>
          )}
          <div className={css.hint} style={{ marginTop: 6 }}>{t('retention.appliesTo')}</div>
          {/* P1-⑨：连续失败主动标红（≥1 次失败即在设置卡内醒目提示，恒在卡片底部、成块不被拆散） */}
          {(saved?.consecutiveFailures ?? 0) > 0 && (
            <div style={{ marginTop: 8 }}>
              <Banner kind="error" >
                {t('backupSchedule.consecutiveFailures', { count: String(saved!.consecutiveFailures) })}
              </Banner>
            </div>
          )}
        </>
      )}

      {draftError !== null && <Banner kind="error">{draftError}</Banner>}
    </Card>
  )
}
