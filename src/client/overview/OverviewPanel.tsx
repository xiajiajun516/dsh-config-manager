/**
 * 总览页（Overview —— Workbench 控制中心 v3，2026-09 Full UI Rebuild）。
 *
 * 布局（564px 画布，纵向流式，无空容器）：
 *   1. 状态条（32px）：健康点 + 指标段（名词在前：备份文件 6 / 安全快照 0 /
 *      定时备份 已开启 · 下次 03:00 / 远程同步 未配置；段可点击直达对应页）
 *   2. 动作工具栏：立即备份（primary）+ 导出/导入 ghost + 右侧「活动 →」入口
 *   3. 备份位置卡：路径（mono+copy）/ 体积 / 快照配额 / 间隔·上次 四列网格
 *   4. 分区构成卡：export-preview 只读预览的 13 分区条目数+体积（两列网格）
 *   5. 最近活动表（fit-content，上限 8 行内滚；类型并入内容列、
 *      中段省略保留尾部时间戳、成功=绿点、失败/跳过=徽章）
 *
 * 数据流：挂载/刷新时对 6 个只读 API 做 Promise.allSettled 并行聚合；全部渲染模型
 * 来自 src/ui/overview-view.ts 纯函数（node 单测覆盖），本组件只做装配。
 * 安全：历史摘要渲染前 redact()（宿主侧已脱敏，此处仅做 [REDACTED] 可读化显示）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { BackupScheduleStatus } from '../../ui/backup-schedule.ts'
import { backupRunOutcome, normalizeRetentionPolicy, type BackupSkipReason } from '../../ui/backup-schedule.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { SyncApi, SyncStatusResponse } from '../sync/sync-api.ts'
import type { HistoryApi, HistoryListResult } from '../history/history-api.ts'
import type { ConfigManagerApi, ExportPreviewResponse } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerKey } from '../locales.ts'
import { redact } from '../../security/redaction.ts'
import { runStore, type SnapshotsSubTab } from '../run-store.ts'
import { toast } from '../common/toast-store.ts'
import { toRecoveryView } from '../recovery/recovery-view.ts'
import { formatBytes } from '../../ui/report.ts'
import {
  buildOverviewMetrics,
  overviewActivity,
  overviewEmptyState,
  overviewHealth,
  relTime,
  type OverviewMetricKey,
} from '../../ui/overview-view.ts'
import { Badge, Button, Card, Spinner, StatusDot } from '../common/ui.tsx'
import { SectionComposition } from '../common/SectionComposition.tsx'
import { sectionLabeler } from '../common/section-labels.ts'
import { BackupIcon, ExportIcon, ImportIcon, SyncIcon, ArrowRightIcon, CopyIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'

/** issue #43：立即备份跳过原因 → 文案键（文案统一走 locale 字典；未知 token 走 other）。 */
const BACKUP_SKIP_KEY: Record<BackupSkipReason, ConfigManagerKey> = {
  disabled: 'overview.quick.backupSkippedDisabled',
  running: 'overview.quick.backupSkippedRunning',
  conflict: 'overview.quick.backupSkippedConflict',
  locked: 'overview.quick.backupSkippedLocked',
  other: 'overview.quick.backupSkippedOther',
}

export interface OverviewPanelProps {
  api: ConfigManagerApi
  syncApi: SyncApi
  historyApi: HistoryApi
  t: TranslateNS<'config-manager'>
  /** 「活动」入口打开 Shell 的活动抽屉（完整迁移历史） */
  openActivity?: () => void
}

/** 聚合数据（null = 未加载/加载失败 → UI 占位）。 */
interface OverviewData {
  backups: BackupFileMeta[] | null
  snapshots: SnapshotMeta[] | null
  schedule: BackupScheduleStatus | null
  sync: SyncStatusResponse | null
  history: HistoryListResult | null
  /** 分区构成（export-preview 只读预览；null = 未加载/失败 → 不显示该卡） */
  sections: ExportPreviewResponse | null
}

const initialData: OverviewData = {
  backups: null,
  snapshots: null,
  schedule: null,
  sync: null,
  history: null,
  sections: null,
}

/** 指标段点击直达页 —— 落到备份页时必须同时带上精确子视图，
 *  否则「备份文件 / 安全快照 / 定时备份」三个指标会全部停在备份页默认子页上。 */
const METRIC_TARGET: Record<OverviewMetricKey, { panel: 'snapshots' | 'sync'; subTab?: SnapshotsSubTab }> = {
  backups: { panel: 'snapshots', subTab: 'files' },
  snapshots: { panel: 'snapshots', subTab: 'restore' },
  schedule: { panel: 'snapshots', subTab: 'schedule' },
  sync: { panel: 'sync' },
}

/** 相对时间渲染（超 7 天回退绝对日期）。 */
function renderRelTime(ms: number, t: TranslateNS<'config-manager'>): string {
  const rt = relTime(Date.now(), ms)
  if (rt === null) return new Date(ms).toLocaleDateString()
  if (rt.unit === 'now') return t('overview.time.now')
  if (rt.unit === 'min') return t('overview.time.min', { n: rt.n })
  if (rt.unit === 'hour') return t('overview.time.hour', { n: rt.n })
  return t('overview.time.day', { n: rt.n })
}

/** 定时间隔 → 字典文案（与 backupSchedule.interval.* 同源）。 */
function intervalText(interval: BackupScheduleStatus['interval'], t: TranslateNS<'config-manager'>): string {
  switch (interval) {
    case '6h': return t('backupSchedule.interval.6h')
    case '12h': return t('backupSchedule.interval.12h')
    case '24h': return t('backupSchedule.interval.24h')
    case '7d': return t('backupSchedule.interval.7d')
    case 'custom': return t('backupSchedule.interval.custom')
    default: return String(interval)
  }
}

/** 下次定时备份估算（固定间隔 = 上次 + 间隔；custom = 下个周一时刻近似）。 */
function nextRunText(schedule: BackupScheduleStatus, t: TranslateNS<'config-manager'>): string | null {
  if (!schedule.enabled) return null
  const last = schedule.lastRunAt !== undefined ? Date.parse(schedule.lastRunAt) : Number.NaN
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fmt = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const intervalMs: Record<Exclude<BackupScheduleStatus['interval'], 'custom'>, number> = {
    '6h': 6 * 3_600_000,
    '12h': 12 * 3_600_000,
    '24h': 24 * 3_600_000,
    '7d': 7 * 24 * 3_600_000,
  }
  if (schedule.interval !== 'custom' && Number.isFinite(last)) {
    return fmt(new Date(last + intervalMs[schedule.interval]))
  }
  if (schedule.interval === 'custom' && schedule.customSchedule !== undefined) {
    // 每周固定时刻：取「从现在起下一个匹配的周几」
    const target = schedule.customSchedule.dayOfWeek
    const now = new Date()
    const delta = (target - now.getDay() + 7) % 7 || 7
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, schedule.customSchedule.hour, schedule.customSchedule.minute)
    return fmt(next)
  }
  return null
}

/** [REDACTED] 可读化：宿主侧强脱敏 token → 用户可理解的文案（历史条目不可变，仅展示层替换）。 */
function displaySummary(summary: string, t: TranslateNS<'config-manager'>): string {
  const r = redact(summary)
  if (!r.includes('[REDACTED]')) return r
  const redactedName = t('overview.activity.redacted')
  return r.replaceAll('[REDACTED].zip', redactedName).replaceAll('[REDACTED]', '…')
}

/** 中段省略（路径/文件名：保留头尾，中段 …——尾部时间戳是唯一区分信息）。 */
function midEllipsis(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** 从文件路径取目录（纯字符串；win32 反斜杠与 posix 斜杠都认）。 */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

/**
 * 复制文本到剪贴板，并以 Toast 反馈结果。
 * （原先完全静默：用户无法确认是否复制成功——被复制的内容在界面上往往只显示截断形态。）
 */
function copyText(text: string, t: TranslateNS<'config-manager'>): void {
  try {
    const pending = navigator.clipboard?.writeText(text)
    if (pending === undefined) {
      toast.warn(t('toast.copyFailed'))
      return
    }
    void pending.then(
      () => { toast.ok(t('toast.copied')) },
      () => { toast.warn(t('toast.copyFailed')) },
    )
  } catch {
    toast.warn(t('toast.copyFailed'))
  }
}

/**
 * 总览页（控制中心）：状态条 + 动作工具栏 + 备份位置 + 分区构成 + 最近活动。
 */
export function OverviewPanel({ api, syncApi, historyApi, t, openActivity }: OverviewPanelProps) {
  const store = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const [data, setData] = useState<OverviewData>(initialData)
  const [loading, setLoading] = useState(true)
  const [backupRunning, setBackupRunning] = useState(false)
  /** 卸载后不再 setState（异步回调竞态防护） */
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [backups, snapshots, schedule, sync, history, sections] = await Promise.allSettled([
      api.listBackupFiles(),
      api.snapshots(),
      api.backupSchedule(),
      syncApi.status(),
      historyApi.list({}),
      // 分区构成（只读预览；失败不阻塞整页，仅隐藏该卡）
      api.exportPreview(undefined),
    ])
    if (!aliveRef.current) return
    setData({
      backups: backups.status === 'fulfilled' ? backups.value : null,
      snapshots: snapshots.status === 'fulfilled' ? snapshots.value : null,
      schedule: schedule.status === 'fulfilled' ? schedule.value : null,
      sync: sync.status === 'fulfilled' ? sync.value : null,
      history: history.status === 'fulfilled' ? history.value : null,
      sections: sections.status === 'fulfilled' ? sections.value : null,
    })
    setLoading(false)
  }, [api, syncApi, historyApi])

  useEffect(() => {
    void load()
  }, [load])

  /** 立即备份（宿主 RunRegistry 防重；反馈后刷新指标）。
   *  反馈走全局 Toast：备份耗时较长，用户点完很可能已切到别的页面，
   *  写入本组件 state 会随卸载一起丢失（以前就是被 aliveRef 竞态静默吞掉的）。
   *  issue #43：宿主对 skipped / failed 也回 200 + ok:true，凭「有没有抛异常」判成败会把
   *  「定时备份未启用 → 一个备份文件都没产出」读成「备份完成」——提示通道一律由 run.status 决定。 */
  const runBackupNow = async (): Promise<void> => {
    if (backupRunning) return
    setBackupRunning(true)
    try {
      const { run } = await api.runBackupNow()
      const outcome = backupRunOutcome(run)
      if (outcome.kind === 'ok') {
        toast.ok(t('overview.quick.backupDone'))
      } else if (outcome.kind === 'skipped') {
        toast.warn(t(BACKUP_SKIP_KEY[outcome.reason]))
      } else {
        toast.error(t('overview.quick.backupFailed', { message: redact(outcome.message ?? t('common.unknownError')) }))
      }
      if (aliveRef.current) void load()
    } catch (err) {
      toast.error(redact(err instanceof Error ? err.message : String(err)))
    } finally {
      if (aliveRef.current) setBackupRunning(false)
    }
  }

  // 纯导航（与 nav 页签同语义；状态入 runStore，切页/刷新不丢）
  const navPanel = (panel: 'snapshots' | 'sync' | 'export' | 'import'): void => {
    if (panel === 'export') runStore.patch({ view: 'export', panel: 'export' })
    else if (panel === 'import') runStore.patch({ view: 'import', panel: 'import' })
    else runStore.patch({ panel })
  }

  /** 指标段跳转：一次 patch 同时写入 page 与目标子视图（备份页 restore/files/schedule，同步页直达）。 */
  const navMetric = (key: OverviewMetricKey): void => {
    const target = METRIC_TARGET[key]
    runStore.patch(target.subTab !== undefined
      ? { panel: target.panel, snapshots: { subTab: target.subTab } }
      : { panel: target.panel })
  }

  /** 健康段落点：有待处理恢复事项时直达备份页「事故恢复」子视图。 */
  const navRecovery = (): void => {
    runStore.patch({ panel: 'snapshots', snapshots: { subTab: 'recovery' } })
  }

  /** 是否存在待处理恢复事项（null = 状态未知；决定健康段是否作为「事故恢复」入口）。 */
  const recoveryRequired = store.recovery.status !== null
    ? toRecoveryView(store.recovery.status).recoveryRequired === true
    : null

  const inputs = {
    now: Date.now(),
    backups: data.backups,
    snapshots: data.snapshots,
    schedule: data.schedule,
    sync: data.sync,
    history: data.history?.entries ?? null,
    recoveryRequired,
    runningCount: 0,
  }

  const metrics = buildOverviewMetrics(inputs)
  const health = overviewHealth(inputs)
  const activity = overviewActivity(inputs.history, 30)
  const emptyState = overviewEmptyState(inputs)

  /* —— 备份位置数据（全部来自已加载的只读列表） —— */
  const firstBackup = data.backups !== null && data.backups.length > 0 ? data.backups[0]! : null
  const backupDir = firstBackup !== null ? dirOf(firstBackup.path) : null
  const totalSize = data.backups !== null ? data.backups.reduce((n, b) => n + b.sizeBytes, 0) : null
  const scheduleStatus = data.schedule
  const nextRun = scheduleStatus !== null ? nextRunText(scheduleStatus, t) : null

  /** 指标段渲染模型（名词在前：label dim + 值 bold；附注仅时间/告警）。 */
  const segModels = metrics.map((m) => {
    const value = m.kind === 'state'
      ? (m.valueKey === 'state.on' ? t('overview.state.on') : t('overview.state.off'))
      : m.value
    let dim: string | null = null
    if (m.metaKey === 'meta.scheduleFail') {
      dim = renderMetaShort(m.metaKey, m.metaParams['time'] !== undefined ? Number(m.metaParams['time']) : null, t)
    } else if (m.key === 'backups' && m.metaParams['time'] !== undefined) {
      dim = renderRelTime(Number(m.metaParams['time']), t)
    }
    return { key: m.key, label: t(METRIC_LABEL[m.key]), value, dim }
  })

  /** 结果渲染：ok = 绿点（降噪）；failed/skipped = 徽章（需要被看见）。 */
  const resultNode = (badge: 'ok' | 'error' | 'warn'): ReactNode =>
    badge === 'ok'
      ? <span className={css.activityResultOk}><StatusDot kind="ok" />{t('overview.result.success')}</span>
      : <Badge kind={badge}>{badge === 'error' ? t('overview.result.failed') : t('overview.result.skipped')}</Badge>

  return (
    <div className={css.viewBody}>
      {/* 1. 状态条：健康点 + 指标段（可点击，名词在前） */}
      <div className={css.statStrip} data-tone={health.kind === 'ok' ? undefined : health.kind}>
        {recoveryRequired ? (
          /* 有待处理恢复事项：健康段本身即入口，直达备份页「事故恢复」 */
          <button
            type="button"
            className={`${css.statHealth} ${css.statHealthAction}`}
            title={t('overview.health.recoveryAction')}
            onClick={navRecovery}
          >
            <StatusDot kind="error" />
            {t(`overview.${health.textKey}`)}
          </button>
        ) : (
          <span className={css.statHealth}>
            <StatusDot kind={health.kind === 'ok' ? 'ok' : health.kind === 'warn' ? 'warn' : 'error'} />
            {t(`overview.${health.textKey}`)}
          </span>
        )}
        {segModels.map((seg) => (
          <button
            key={seg.key}
            type="button"
            className={css.statSeg}
            onClick={() => { navMetric(seg.key) }}
          >
            <span>{seg.label}</span>
            <b>{seg.value}</b>
            {seg.dim !== null && <span className={css.statSegDim}>· {seg.dim}</span>}
          </button>
        ))}
        {loading && <span className={css.statSeg}><Spinner /></span>}
      </div>

      {/* 2. 动作工具栏：立即备份（primary 执行）+ 导航 ghost + 右侧活动入口 */}
      <div className={css.toolRow}>
        <Button variant="primary" disabled={backupRunning} title={t('overview.quick.backupTitle')} onClick={() => { void runBackupNow() }}>
          {backupRunning ? <Spinner /> : <BackupIcon size={14} />} {t('overview.quick.backup')}
        </Button>
        <Button title={t('overview.quick.exportTitle')} onClick={() => { navPanel('export') }}>
          <ExportIcon size={14} /> {t('nav.export')} ZIP
        </Button>
        <Button title={t('overview.quick.importTitle')} onClick={() => { navPanel('import') }}>
          <ImportIcon size={14} /> {t('nav.import')}
        </Button>
        <Button title={t('overview.quick.syncTitle')} onClick={() => { navPanel('sync') }}>
          <SyncIcon size={14} /> {t('overview.quick.sync')}
        </Button>
        <span className={css.statusSpacer} />
        <Button size="sm" onClick={() => { openActivity?.() }}>
          {t('overview.nav.activity')} <ArrowRightIcon size={13} />
        </Button>
      </div>

      {emptyState ? (
        /* 首用空态：引导创建第一个备份（填充剩余高度） */
        <Card className={`${css.activityCard} ${css.fillCard}`}>
          <span className={css.groupLabel}>{t('overview.empty.title')}</span>
          <span className={css.hint} style={{ display: 'block', marginBottom: 10 }}>{t('overview.empty.body')}</span>
          <div className={css.toolRow}>
            <Button variant="primary" disabled={backupRunning} onClick={() => { void runBackupNow() }}>
              {t('overview.quick.backup')}
            </Button>
            <Button onClick={() => { navPanel('sync') }}>{t('overview.quick.sync')}</Button>
          </div>
        </Card>
      ) : (
        <>
          {/* 3. 备份位置卡：路径行 + 四列网格（体积/配额/间隔/上次） */}
          {(backupDir !== null || scheduleStatus !== null) && (
            <Card>
              <div className={css.groupHeader}>
                <span className={css.groupLabel}>{t('overview.location.title')}</span>
              </div>
              {backupDir !== null && (
                <div className={css.infoRow} style={{ marginBottom: 4 }}>
                  <span className={css.infoKey}>{t('overview.location.dir')}</span>
                  <span className={css.infoValue}>
                    <span className={css.mono} title={backupDir}>{midEllipsis(backupDir, 52)}</span>
                    <button
                      type="button"
                      className={css.copyBtn}
                      aria-label={t('overview.activity.copy')}
                      title={t('overview.activity.copy')}
                      onClick={() => { copyText(backupDir, t) }}
                    >
                      <CopyIcon size={12} />
                    </button>
                  </span>
                </div>
              )}
              <div className={css.factGrid}>
                {totalSize !== null && (
                  <div className={css.factCell}>
                    <span className={css.factLabel}>{t('overview.location.totalSize')}</span>
                    <span className={`${css.factValue} ${css.mono}`}>{formatBytes(totalSize)}</span>
                  </div>
                )}
                <div className={css.factCell}>
                  <span className={css.factLabel}>{t('overview.location.retention')}</span>
                  <span className={`${css.factValue} ${css.mono}`}>
                    {t('overview.location.retentionValue', {
                      used: String(data.snapshots?.length ?? 0),
                      // m-retention：分母取宿主真实策略（用户可配置），不再硬编码 '10'；
                      // 宿主未返回 retention（旧版宿主/请求失败）→ 回退 DEFAULT_RETENTION_POLICY
                      limit: String(normalizeRetentionPolicy(scheduleStatus?.retention).keepLast),
                    })}
                  </span>
                </div>
                <div className={css.factCell}>
                  <span className={css.factLabel}>{t('overview.location.schedule')}</span>
                  <span className={css.factValue}>
                    {scheduleStatus !== null && scheduleStatus.enabled ? intervalText(scheduleStatus.interval, t) : t('overview.location.scheduleOff')}
                  </span>
                </div>
                <div className={css.factCell}>
                  <span className={css.factLabel}>{scheduleStatus !== null && scheduleStatus.enabled && nextRun !== null ? t('overview.location.nextRun') : t('overview.location.lastRun')}</span>
                  <span className={`${css.factValue} ${css.mono}`}>
                    {scheduleStatus !== null && scheduleStatus.enabled && nextRun !== null
                      ? nextRun
                      : (scheduleStatus?.lastRunAt !== undefined
                        ? renderRelTime(Date.parse(scheduleStatus.lastRunAt) || 0, t)
                        : '—')}
                  </span>
                </div>
              </div>
            </Card>
          )}

          {/* 4. 分区构成卡（export-preview 只读；两列网格 + 合计行） */}
          {data.sections !== null && data.sections.sections.length > 0 && (
            <Card>
              <div className={css.groupHeader}>
                <span className={css.groupLabel}>{t('overview.sections.title')}</span>
                <span className={css.groupNote}>{t('overview.sections.hint')}</span>
                <span className={css.statusSpacer} />
                <span className={css.hint}>
                  {t('overview.sections.total')} {formatBytes(data.sections.totalSizeBytes)}
                  {data.sections.sectionsFailed > 0 && ` · ${t('export.previewSkipped', { count: String(data.sections.sectionsFailed) })}`}
                </span>
              </div>
              <SectionComposition sections={data.sections.sections} t={t} sectionLabel={sectionLabeler(t)} />
            </Card>
          )}

          {/* 5. 最近活动表（fit-content；类型并入内容列；成功=绿点） */}
          <Card className={css.activityCard}>
            <div className={css.activityHeader}>
              <span className={css.activityTitle}>{t('overview.activity.title')}</span>
            </div>
            {activity.length === 0
              ? <div className={css.activityEmpty}>{t('overview.activity.empty')}</div>
              : (
                <div className={`${css.activityRows} ${css.activityFit}`}>
                  {activity.map((item, i) => {
                    const atMs = Date.parse(item.at) || 0
                    const kindText = kindLabel(item.kindKey, t)
                    return (
                      <div className={css.activityRow} key={`${item.at}-${i}`}>
                        <span className={css.activityTime} title={atMs > 0 ? new Date(atMs).toLocaleString() : undefined}>
                          {renderRelTime(atMs, t)}
                        </span>
                        <span className={css.activitySummary}>
                          <span className={css.activityKind}>{kindText} ·</span>
                          <span className={css.activitySummaryText} title={displaySummary(item.summary, t)}>
                            {displaySummary(item.summary, t)}
                          </span>
                          <button
                            type="button"
                            className={css.copyBtn}
                            aria-label={t('overview.activity.copy')}
                            title={t('overview.activity.copy')}
                            onClick={() => { copyText(item.summary, t) }}
                          >
                            <CopyIcon size={12} />
                          </button>
                        </span>
                        <span className={css.activityBadge}>{resultNode(item.badge)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
          </Card>
        </>
      )}
    </div>
  )
}

/* ---- 局部辅助（展示层映射；逻辑在 overview-view.ts，键映射在组件内） ---- */

/** 指标段附注完整文案（告警语义保留前缀）。 */
function renderMetaShort(
  metaKey: 'meta.lastBackup' | 'meta.noBackup' | 'meta.scheduleOn' | 'meta.scheduleOff' | 'meta.scheduleFail' | 'meta.syncOn' | 'meta.syncOff' | 'meta.never',
  timeMs: number | null,
  t: TranslateNS<'config-manager'>,
): string {
  const time = timeMs !== null ? renderRelTime(timeMs, t) : ''
  switch (metaKey) {
    case 'meta.lastBackup': return t('overview.meta.lastBackup', { time })
    case 'meta.noBackup': return t('overview.meta.noBackup')
    case 'meta.scheduleOn': return t('overview.meta.scheduleOn', { time })
    case 'meta.scheduleOff': return t('overview.meta.scheduleOff')
    case 'meta.scheduleFail': return t('overview.meta.scheduleFail')
    case 'meta.syncOn': return t('overview.meta.syncOn', { time })
    case 'meta.syncOff': return t('overview.meta.syncOff')
    case 'meta.never': return t('overview.meta.never')
  }
}

/** 指标段标签 key 映射（overview-view 的 key → locale key）。 */
const METRIC_LABEL: Record<OverviewMetricKey, `overview.metric.${OverviewMetricKey}`> = {
  backups: 'overview.metric.backups',
  snapshots: 'overview.metric.snapshots',
  schedule: 'overview.metric.schedule',
  sync: 'overview.metric.sync',
}

/** 活动行 kind key → locale 文案（kindKey 由 overview-view.ts 归一，全部键在字典登记）。 */
function kindLabel(kindKey: string, t: TranslateNS<'config-manager'>): string {
  return t(kindKey as Parameters<TranslateNS<'config-manager'>>[0])
}
