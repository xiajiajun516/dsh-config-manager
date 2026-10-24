/**
 * 定时全量备份设置卡（m-backup / m-retention）—— t43 从 SnapshotsPanel.tsx 物理拆出。
 *
 * 边界：本文件只做装配与副作用编排（加载/保存/立即备份/草稿镜像 runStore）；
 * 校验与派生逻辑在 `../../ui/backup-schedule.ts`（草稿校验/脏判定/运行状态）与
 * `../../ui/snapshots-view.ts`（间隔事实行形状与字典键）；**不新增任何用户可见文案**。
 *
 * 状态自持；草稿镜像 runStore.snapshots.backupDraft（未保存修改切页/刷新保留），
 * 保存成功清草稿（宿主配置为权威）。
 *
 * 本文件是**从构建产物（lib/client.js，2026-10-02T23:33Z）还原**的：一次误用的通配删除
 * 把它删掉了，而 git 里那份是**更早的修订**（还没有 InfoHint 迁移），没有可直接恢复的源。
 * 逻辑、文案键、CSS 类与调用顺序按编译产物逐段翻译，**排版与注释措辞是重建的**。
 * 教训见 AGENTS.md「常见坑」。
 */
import { useEffect, useRef, useState } from 'react'
import {
  BACKUP_INTERVAL_OPTIONS, DEFAULT_RETENTION_POLICY, RETENTION_FIELDS, RETENTION_FIELD_LIMITS,
  backupDraftDirty, backupRunBadgeKind, hasRetentionTiers, normalizeRetentionPolicy,
  validateBackupScheduleDraft,
  type BackupScheduleDraft, type BackupScheduleStatus, type RetentionPolicy,
} from '../../ui/backup-schedule.ts'
// 展示层映射（字典键 / 时间格式化 / 间隔事实行）住在 snapshots-view.ts —— 与 v1 同源
import {
  backupIntervalLabelKey, backupRunStatusLabelKey, formatRunTime,
  scheduleIntervalFact, weekdayLabelKey,
} from '../../ui/snapshots-view.ts'
/**
 * 跳过原因 → 可读文本。实现住在 `client/sync/history-model.ts`（仓里唯一一份），
 * 语义是通用的「原因 token → 人话」（running / conflict / locked / network…）——
 * 备份与同步的跳过原因同域，所以这里直接复用，**不另建第二份**。
 */
import { describeSkipReason } from '../sync/history-model.ts'
import { runStore } from '../run-store.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Checkbox, StatusDot } from '../common/ui.tsx'
import { Select } from '../common/Select.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

/**
 * 宿主/错误文本渲染前统一过 redact（AGENTS.md §UI 硬性规则 7；client-F4）。
 * 单列成一行：plan-text-redaction.test.ts 的「按渲染点」登记表需要一个唯一锚点。
 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/** 自定义档的星期选项（1=周一 … 7=周日，与 DSH 的 dayOfWeek 值域一致） */
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7]
/** 自定义档的分钟选项（15 分钟粒度足够；再细对「定时备份」没有意义） */
const MINUTE_OPTIONS = [0, 15, 30, 45]

export interface BackupScheduleCardProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 同步命名空间翻译器（跳过原因文案走 sync 字典；client-F1） */
  syncT: TranslateNS<'config-manager-sync'>
  /** 「立即备份」完成后通知外层（首页刷新状态行、产物库重拉备份文件列表） */
  onBackupDone?: () => void
}

export function BackupScheduleCard({ api, t, syncT, onBackupDone }: BackupScheduleCardProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BackupScheduleDraft>({ enabled: false, interval: '24h' })
  const [saved, setSaved] = useState<BackupScheduleStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<BackupScheduleStatus['lastRunStatus'] | undefined>(undefined)
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
        // 草稿优先取 runStore 里的未保存修改（切页回来接着编辑）
        setDraft(runStore.getSnapshot().snapshots.backupDraft ?? {
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        setRetentionDraft(normalizeRetentionPolicy(runStore.getSnapshot().snapshots.backupDraft?.retention ?? schedule.retention))
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
    // 镜像进 runStore：未保存的修改切页签/刷新后仍在（保存成功会清空）
    runStore.patch({ snapshots: { backupDraft: next } })
  }

  /** m-retention：更新保留策略草稿（随 enabled/interval 一起提交；同时镜像 runStore 防切页丢失） */
  const updateRetention = (next: RetentionPolicy): void => {
    setRetentionDraft(next)
    updateDraft({ ...draft, retention: next })
  }

  const save = (): void => {
    if (saving || running) return
    const parsed = validateBackupScheduleDraft({ ...draft, retention: retentionDraft })
    if (!parsed.ok) {
      setDraftError(parsed.error)
      return
    }
    setSaving(true)
    setDraftError(null)
    api.saveBackupSchedule(parsed.value).then(
      (schedule) => {
        runStore.patch({ snapshots: { backupDraft: null } })
        if (!mountedRef.current) return
        setSaved(schedule)
        setDraft({
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        setRetentionDraft(normalizeRetentionPolicy(schedule.retention))
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
        setSaving(false)
        toast.ok(t('backupSchedule.saved'))
      },
      (err) => {
        if (!mountedRef.current) return
        setSaving(false)
        toast.error(redactErrorText(err))
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
          setLastRun(res.run.status)
          setLastRunDetail(
            res.run.zip !== undefined && res.run.zip !== ''
              ? res.run.zip
              : res.run.skipReason !== undefined
                ? describeSkipReason(res.run.skipReason, syncT)
                : formatRunTime(res.schedule.lastRunAt),
          )
          setRunning(false)
        }
        onBackupDone?.()
      },
      (err) => {
        if (!mountedRef.current) return
        setRunning(false)
        toast.error(redactErrorText(err))
      },
    )
  }

  const dirty = backupDraftDirty({ ...draft, retention: retentionDraft }, saved)
  const busy = saving || running

  /**
   * 事实行「备份间隔」文案：整行事实统一取宿主权威值 saved（与事实行语义一致，
   * 也与 SyncSettingsView 的状态事实行同源 —— 草稿编辑只在下方设置行体现，
   * 未保存前不改写事实行，避免把未生效的档位显示成已生效）。
   * custom 档在窄格内显示具体时刻（如「周一 03:00」），其余档位用档位文案。
   */
  const intervalFactText = (): string => {
    const fact = scheduleIntervalFact(saved)
    if (fact.kind === 'none') return '—'
    if (fact.kind === 'interval') return t(backupIntervalLabelKey(fact.interval))
    const dayKey = weekdayLabelKey(fact.dayOfWeek)
    const day = dayKey === null ? String(fact.dayOfWeek) : t(dayKey)
    return day + ' ' + String(fact.hour).padStart(2, '0') + ':' + String(fact.minute).padStart(2, '0')
  }

  /** 上次运行状态文案（未知 → '—'）。 */
  const runStatusText = (value: BackupScheduleStatus['lastRunStatus']): string => {
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
      <div className={css.groupHeader}>
        <span className={css.groupLabel}>{t('backupSchedule.title')}</span>
        {lastRun !== undefined && <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusText(lastRun)}</Badge>}
        <InfoHint text={t('backupSchedule.hint')} label={t('common.infoHint')} />
        <span className={css.statusSpacer} />
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={running || !dirty}
          onClick={save}
          title={dirty ? undefined : t('backupSchedule.saved')}
        >
          {t('backupSchedule.save')}
        </Button>
        <Button size="sm" loading={running} disabled={saving || !(saved?.enabled ?? false)} onClick={runNow}>
          {t('backupSchedule.runNow')}
        </Button>
      </div>

      {status === 'loading' && <Skeleton count={2} label={t('backupSchedule.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {t('backupSchedule.error')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && (
        <>
          {/* 事实行：状态 / 间隔 / 上次运行（全部取宿主权威值，不受草稿影响） */}
          <div className={css.factGrid} style={{ marginTop: 8 }}>
            <div className={css.factCell} style={{ gridColumn: 'span 2' }}>
              <span className={css.factLabel}>{t('snapshots.status')}</span>
              <span className={css.factValue}>
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
            <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
              <span className={css.factLabel}>{t('backupSchedule.lastRun')}</span>
              <span className={css.factValue}>
                {lastRun === undefined
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

          {/* 设置行：开关 + 间隔（+ 自定义档的星期/时/分） */}
          <div className={css.actionRow} style={{ marginTop: 10, marginBottom: 0 }}>
            <Checkbox
              checked={draft.enabled}
              onChange={(checked: boolean) => { updateDraft({ ...draft, enabled: checked }) }}
              label={t('backupSchedule.enabled')}
              disabled={busy}
            />
            {draft.enabled && <InfoHint text={t('backupSchedule.enabledHint')} label={t('common.infoHint')} />}
            {draft.enabled && (
              <Select
                value={draft.interval}
                disabled={busy}
                style={{ width: 'auto' }}
                ariaLabel={t('backupSchedule.interval')}
                onChange={(next) => { updateDraft({ ...draft, interval: next as BackupScheduleDraft['interval'] }) }}
                options={BACKUP_INTERVAL_OPTIONS.map((interval) => ({
                  value: interval,
                  label: t(backupIntervalLabelKey(interval)),
                }))}
              />
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <Select
                value={String(draft.customSchedule?.dayOfWeek ?? 1)}
                disabled={busy}
                style={{ width: 'auto' }}
                ariaLabel={t('backupSchedule.weekday')}
                onChange={(next) => {
                  updateDraft({
                    ...draft,
                    customSchedule: { dayOfWeek: Number(next), hour: draft.customSchedule?.hour ?? 3, minute: draft.customSchedule?.minute ?? 0 },
                  })
                }}
                options={WEEKDAY_OPTIONS.map((w) => ({ value: String(w), label: weekdayText(w) }))}
              />
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <Select
                value={String(draft.customSchedule?.hour ?? 3)}
                disabled={busy}
                style={{ width: 'auto' }}
                ariaLabel={t('backupSchedule.hour')}
                onChange={(next) => {
                  updateDraft({
                    ...draft,
                    customSchedule: { dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1, hour: Number(next), minute: draft.customSchedule?.minute ?? 0 },
                  })
                }}
                options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: String(h).padStart(2, '0') + ':00' }))}
              />
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <Select
                value={String(draft.customSchedule?.minute ?? 0)}
                disabled={busy}
                style={{ width: 'auto' }}
                ariaLabel={t('backupSchedule.minute')}
                onChange={(next) => {
                  updateDraft({
                    ...draft,
                    customSchedule: { dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1, hour: draft.customSchedule?.hour ?? 3, minute: Number(next) },
                  })
                }}
                options={MINUTE_OPTIONS.map((m) => ({ value: String(m), label: String(m).padStart(2, '0') }))}
              />
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <InfoHint text={t('backupSchedule.customHint')} label={t('common.infoHint')} />
            )}
          </div>

          {/* 保留策略（三层）：与间隔同属草稿，随「保存」一起提交 */}
          <div className={css.groupHeader} style={{ marginTop: 12 }}>
            <span className={css.groupLabel}>{t('retention.title')}</span>
            <InfoHint text={t('retention.hint')} label={t('common.infoHint')} />
            <span className={css.statusSpacer} />
            <span className={css.hint}>{!hasRetentionTiers(retentionDraft) && t('retention.tiersOff')}</span>
          </div>
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
                      const raw = event.target.value
                      const parsed = raw === '' ? 0 : Number(raw)
                      updateRetention({ ...retentionDraft, [field]: Number.isFinite(parsed) ? parsed : 0 })
                    }}
                  />
                  <span className={css.hint}>{unit}</span>
                </label>
              )
            })}
            {hasRetentionTiers(retentionDraft) && (
              <InfoHint
                text={t('retention.keepLastHint') + ' · ' + t('retention.keepMonthlyHint') + ' · ' + t('retention.keepYearlyHint')}
                label={t('common.infoHint')}
              />
            )}
            <InfoHint text={t('retention.appliesTo')} label={t('common.infoHint')} />
          </div>

          {(saved?.consecutiveFailures ?? 0) > 0 && (
            <div style={{ marginTop: 8 }}>
              <Banner kind="error">
                {t('backupSchedule.consecutiveFailures', { count: String(saved?.consecutiveFailures ?? 0) })}
              </Banner>
            </div>
          )}
        </>
      )}

      {draftError !== null && <Banner kind="error">{draftError}</Banner>}
    </Card>
  )
}
