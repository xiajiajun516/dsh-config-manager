/**
 * 首页（Home，UI v2 §7）—— 从「总览页」演进而来。
 *
 * 布局（564px 画布，纵向流式）：
 *   1. 状态行：健康点 + 指标段 + 右端 **[立即备份]**
 *      （指标段：备份文件 / 安全快照 / 定时备份 / 远程同步；段可点击直达 ——
 *       「定时备份」**不跳页**，直接开设置弹窗，因为设置卡就在下面）
 *   2. 动作工具栏：立即备份 / 手动导出 / 导入 / 从其它 agent 导入 / 一键同步
 *   3. 最近活动表（**首页最后一个数据块**：吃掉剩余高度、列表自身内滚）
 *
 * **v3 移出首页**：分区构成卡（→ 导出流程的「本次将导出」构成卡 + 产物库行展开）；
 * 备份位置与配额（→「定时备份」设置弹窗内的位置小节，2026-10-06 用户要求首页不再常驻这张卡）。
 * 首页只回答「这台机器现在怎么样 + 我下一步做什么」，并由最近活动表填满剩余高度
 * （Canvas 纪律：不留底部空洞）。
 * 状态行**不重复**恢复待处理的提示 —— 全局 SAFE MODE 横幅已经承担（§4.4）。
 *
 * 数据流：挂载/刷新时对 5 个**毫秒级**只读 API 做 Promise.allSettled 并行聚合，首屏不等分区预览；
 * 分区构成（export-preview）单独后发 —— 它要遍历全部默认分区（含本地插件打包、会话扫描），
 * 是最慢的一步，等它会让整页转圈（真机曾达 12~30 s）。全部渲染模型来自 src/ui/overview-view.ts
 * 纯函数（node 单测覆盖），本组件只做装配。
 * 安全：历史摘要渲染前 redact()（宿主侧已脱敏，此处仅做 [REDACTED] 可读化显示）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { BackupScheduleStatus } from '../../ui/backup-schedule.ts'
import { backupRunOutcome, type BackupSkipReason } from '../../ui/backup-schedule.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { SyncApi, SyncStatusResponse } from '../sync/sync-api.ts'
import type { HistoryApi, HistoryListResult } from '../history/history-api.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerKey } from '../locales.ts'
import { redact } from '../../security/redaction.ts'
import { runStore } from '../run-store.ts'
import type { ArtifactKind } from '../../ui/artifact-view.ts'
import { toast } from '../common/toast-store.ts'
import { toRecoveryView } from '../recovery/recovery-view.ts'
import {
  buildOverviewMetrics,
  overviewActivity,
  overviewEmptyState,
  overviewFirstSteps,
  overviewHealth,
  relTime,
  type OverviewMetricKey,
} from '../../ui/overview-view.ts'
import { Badge, Banner, Button, Card, Spinner, StatusDot, Stepper } from '../common/ui.tsx'
import { SkeletonRows } from '../common/Skeleton.tsx'
import { BackupIcon, ExportIcon, ImportIcon, SyncIcon } from '../common/Icon.tsx'
import { CopyButton } from '../common/CopyButton.tsx'
import { Modal } from '../common/Modal.tsx'
import { BackupScheduleCard } from './BackupScheduleCard.tsx'
import css from '../config-manager.module.css'

/** issue #43：立即备份跳过原因 → 文案键（文案统一走 locale 字典；未知 token 走 other）。 */
const BACKUP_SKIP_KEY: Record<BackupSkipReason, ConfigManagerKey> = {
  disabled: 'overview.quick.backupSkippedDisabled',
  running: 'overview.quick.backupSkippedRunning',
  conflict: 'overview.quick.backupSkippedConflict',
  locked: 'overview.quick.backupSkippedLocked',
  other: 'overview.quick.backupSkippedOther',
}

export interface HomePanelProps {
  api: ConfigManagerApi
  syncApi: SyncApi
  historyApi: HistoryApi
  t: TranslateNS<'config-manager'>
  /** 同步命名空间翻译器（透传给自动备份卡：跳过原因文案走 sync 字典；client-F1） */
  syncT: TranslateNS<'config-manager-sync'>
  /** 「活动」入口打开 Shell 的只读面板（完整迁移历史） */
  /**
   * 打开导入面板并**直接停在「从其它 agent 导入」**（t17；由壳层注入）。
   * 不传 → 该按钮不渲染（老调用方零改动）。
   */
  openForeignImport?: () => void
}

/** 聚合数据（null = 未加载/加载失败 → UI 占位）。 */
interface OverviewData {
  backups: BackupFileMeta[] | null
  snapshots: SnapshotMeta[] | null
  schedule: BackupScheduleStatus | null
  sync: SyncStatusResponse | null
  history: HistoryListResult | null
}

const initialData: OverviewData = {
  backups: null,
  snapshots: null,
  schedule: null,
  sync: null,
  history: null,
}

/**
 * 指标段点击直达页（UI v2 §7 按新 IA 重写）。
 *
 * v2 里「备份文件 / 安全快照」都住在**产物库**，用**来源筛选**定位而不是子页签
 * （`library.sourceFilter` 的取值就是行 kind，见 run-store 的 LibraryStoreSlice）。
 * 「定时备份」不在这里跳页 —— 由 navMetric 特判为「开设置弹窗」。
 */
const METRIC_TARGET: Record<OverviewMetricKey, { panel: 'library' | 'sync'; sourceFilter?: ArtifactKind }> = {
  backups: { panel: 'library', sourceFilter: 'backup-file' },
  snapshots: { panel: 'library', sourceFilter: 'snapshot' },
  // schedule 走特判，这里的值只是类型完备性占位
  schedule: { panel: 'library' },
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



/** [REDACTED] 可读化：宿主侧强脱敏 token → 用户可理解的文案（历史条目不可变，仅展示层替换）。 */
function displaySummary(summary: string, t: TranslateNS<'config-manager'>): string {
  const r = redact(summary)
  if (!r.includes('[REDACTED]')) return r
  const redactedName = t('overview.activity.redacted')
  return r.replaceAll('[REDACTED].zip', redactedName).replaceAll('[REDACTED]', '…')
}


/**
 * 总览页（控制中心）：状态条 + 动作工具栏 + 最近活动（最后一个数据块，吃掉剩余高度）。
 */
export function HomePanel({ api, syncApi, historyApi, t, syncT, openForeignImport }: HomePanelProps) {
  /**
   * 「定时备份」不再是独立页签 —— 设置卡并进本页（§7）。
   * 状态行的「定时备份」段点击**开这个弹窗**，而不是跳页：
   * 看见「每 24h · 下次 03:00」的人，下一步想看的就是那张设置卡。
   */
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const store = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const [data, setData] = useState<OverviewData>(initialData)
  const [loading, setLoading] = useState(true)
  /** 首屏 5 个只读请求的失败情况（null = 全部成功 / 还没跑过）。
   *  为什么必须有它：此前 allSettled 把失败一律吞成 null，而健康判定对 null 不降级 ——
   *  宿主接口整体不可达时，用户看到的是绿色「配置健康」+「暂无操作记录」，
   *  读起来像「一切正常只是没操作过」，真实原因与重试入口都不可见。 */
  const [loadError, setLoadError] = useState<{ count: number; message: string } | null>(null)
  const [backupRunning, setBackupRunning] = useState(false)
  /** 卸载后不再 setState（异步回调竞态防护） */
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  /** 首屏：5 个毫秒级只读接口；settle 即渲染（不 await 分区预览） */
  const loadFast = useCallback(async (): Promise<void> => {
    const results = await Promise.allSettled([
      api.listBackupFiles(),
      api.snapshots(),
      api.backupSchedule(),
      syncApi.status(),
      historyApi.list({}),
    ])
    if (!aliveRef.current) return
    // 失败必须留痕（数量 + 第一条原因）；成功时清掉上一轮的错误。
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    const first = failures[0]
    setLoadError(failures.length === 0 ? null : {
      count: failures.length,
      message: first instanceof Error ? first.message : String(first),
    })
    setData((prev) => ({
      ...prev,
      backups: results[0].status === 'fulfilled' ? results[0].value : null,
      snapshots: results[1].status === 'fulfilled' ? results[1].value : null,
      schedule: results[2].status === 'fulfilled' ? results[2].value : null,
      sync: results[3].status === 'fulfilled' ? results[3].value : null,
      history: results[4].status === 'fulfilled' ? results[4].value : null,
    }))
    setLoading(false)
  }, [api, syncApi, historyApi])

  /**
   * 全量刷新（挂载、立即备份后、定时备份弹窗关闭后）。
   *
   * v3：首页不再触发 export-preview —— 它是**最慢的一步**（真机 12~30s，要遍历全部默认分区
   * 含本地插件打包与会话扫描），而唯一的消费者「分区构成卡」已按 §7 移出首页。
   * 去掉它同时修掉「首屏被最慢请求拖住」的结构性隐患。
   */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    await loadFast()
  }, [loadFast])

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
  // v2：本页不再有「备份页」这个去处（定时备份就在本页，产物在产物库）
  const navPanel = (panel: 'sync'): void => { runStore.patch({ panel }) }

  /**
   * 导入是**流程**不是页面（与导出同一条容器判据）：开侧滑面板，不切页。
   *
   * 此前这里写的是 `patch({ view: 'import', panel: 'import' })` —— 切到一个**页面**，
   * 而导入页面又已并入面板 ⇒ 结果是「页面闪一下（pagePad 以新 key 重建）但面板没开」。
   * 一次 patch 直接把面板打开，页面不动，所以也不会闪。
   */
  const openImportTask = (): void => {
    runStore.patch({ task: { kind: 'import', origin: 'home' } })
  }

  /**
   * 「从其它 agent 导入」（t17）：与导入同一条通道，只是**先落在来源选择那一步**。
   *
   * 为什么有用例入口：用户装了 Claude Code / Cursor 这类工具时，「把我的 agent 配置搬过来」
   * 是他最想做的事 —— 让他先点「导入」再在向导里找另一个按钮，是把一行可达的路径变成两步。
   * 复用同一个 task（不新增 kind）：面板仍是导入面板，只是初始停在来源选择页。
   */
  const openForeignImportTask = (): void => {
    runStore.patch({ task: { kind: 'import', origin: 'home' } })
    openForeignImport?.()
  }

  /**
   * 导出是**流程**不是页面（v2 的 Task Mode 侧滑面板）：发起一次任务，而不是切页签。
   * origin 记当前页 —— 面板只在 origin 上渲染，于是「切走收起、切回续做」不需要额外状态。
   */
  const openExportTask = (): void => {
    runStore.patch({ task: { kind: 'export', origin: 'home' } })
  }

  /** 指标段跳转：一次 patch 同时写入 page 与目标子视图（备份页 restore/files/schedule，同步页直达）。 */
  const navMetric = (key: OverviewMetricKey): void => {
    // 「定时备份」就在本页 ⇒ 不跳页，直接开设置弹窗（§7 的定案）
    if (key === 'schedule') { setScheduleOpen(true); return }
    const target = METRIC_TARGET[key]
    runStore.patch(target.sourceFilter !== undefined
      ? { panel: target.panel, library: { sourceFilter: target.sourceFilter } }
      : { panel: target.panel })
  }

  /**
   * 健康段落点：有待处理恢复事项时直达**环境 → 维护与诊断**（§4.4 第二条：急救可达性）。
   * v1 跳到备份页的恢复子视图 —— 那条路在第 3 步之后已不存在。
   */
  const navRecovery = (): void => {
    runStore.patch({ panel: 'environment' })
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
      {/* 0. 读取失败横幅：必须排在状态条之前 —— 数据没拿到时，绿色健康点是假的。
          重试复用同一条 load()（不新增刷新路径）。 */}
      {loadError !== null && (
        <Banner kind="error">
          {t('overview.loadFailed', { count: String(loadError.count), message: redact(loadError.message) })}
          {' '}
          <Button size="sm" loading={loading} onClick={() => { void load() }}>{t('common.retry')}</Button>
        </Banner>
      )}
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
            {/* 首屏数值未到货时用骨架占位（不再在整条右端挂一颗转圈）：
                段本身的位置与宽度保持不变，数据到货只换「值」这一块。 */}
            {loading
              ? <span className={css.skeletonBar + ' ' + css.statValueSkeleton} aria-hidden="true" />
              : <b>{seg.value}</b>}
            {!loading && seg.dim !== null && <span className={css.statSegDim}>· {seg.dim}</span>}
          </button>
        ))}
      </div>

      {/* 2. 动作工具栏：立即备份 + 三张「任务域」入口（带走 / 装进 / 回去）。
           「立即备份」按用户要求放在**最左**（导出 ZIP 的左边）：它与「导出」是同一件事的
           两种强度 —— 先备份、再带走 —— 相邻放置比放在状态行右端更符合作业顺序。 */}
      <div className={css.toolRow}>
        <Button
          variant="primary"
          disabled={backupRunning}
          title={t('overview.quick.backupTitle')}
          onClick={() => { void runBackupNow() }}
        >
          {backupRunning ? <Spinner /> : <BackupIcon size={14} />} {t('overview.quick.backup')}
        </Button>
        <Button title={t('overview.quick.exportTitle')} onClick={openExportTask}>
          <ExportIcon size={14} /> {t('nav.export')} ZIP
        </Button>
        <Button title={t('overview.quick.importTitle')} onClick={openImportTask}>
          <ImportIcon size={14} /> {t('nav.import')}
        </Button>
        {/* 外部 agent 入口（t17）：与「导入」并列但**直达来源选择** ——
            装了 Claude Code / Cursor 的用户要找的就是这条路，而不是先进向导再找按钮。 */}
        {openForeignImport !== undefined && (
          <Button title={t('foreign.source.hint')} onClick={openForeignImportTask}>
            <ImportIcon size={14} /> {t('foreign.source.title')}
          </Button>
        )}
        <Button title={t('overview.quick.syncTitle')} onClick={() => { navPanel('sync') }}>
          <SyncIcon size={14} /> {t('overview.quick.sync')}
        </Button>
      </div>

      {emptyState ? (
        /* 首用空态：引导创建第一个备份（填充剩余高度） */
        <Card className={`${css.activityCard} ${css.fillCard}`}>
          <span className={css.groupLabel}>{t('overview.empty.title')}</span>
          <span className={css.hint} style={{ display: 'block', marginBottom: 10 }}>{t('overview.empty.body')}</span>
          {/* 三步主线（备份 → 导出 → 导入）：顺序来自 overviewFirstSteps()，组件不写死 */}
          <div className={css.emptySteps}>
            <Stepper
              steps={overviewFirstSteps().map((s, i) => ({
                key: s.key,
                label: t(`overview.empty.${s.key}`),
                state: i === 0 ? 'current' : 'todo',
              }))}
            />
          </div>
          <div className={css.toolRow}>
            <Button variant="primary" disabled={backupRunning} onClick={() => { void runBackupNow() }}>
              {t('overview.quick.backup')}
            </Button>
            <Button onClick={() => { navPanel('sync') }}>{t('overview.quick.sync')}</Button>
          </div>
        </Card>
      ) : (
        <>
          {/* 3. 最近活动表（**首页最后一个数据块**：吃掉剩余高度，列表自身内滚） */}
          <Card className={`${css.activityCard} ${css.fillCard}`}>
            <div className={css.activityHeader}>
              <span className={css.activityTitle}>{t('overview.activity.title')}</span>
            </div>
            {/* 首屏未完成时**不写空态**：以前这里直接渲染「暂无操作记录」，
                数据没到就说「没有」，与真实情况相反。改为按行列表形状铺骨架。 */}
            {loading
              ? <SkeletonRows count={5} label={t('common.loading')} />
              : activity.length === 0
                ? <div className={css.activityEmpty}>{data.history === null ? t('overview.activity.unavailable') : t('overview.activity.empty')}</div>
                : (
                <div className={css.activityRows}>
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
                          <CopyButton text={item.summary} label={t('overview.activity.copy')} t={t} />
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

      {/* 自动备份设置：v1 是独立页签，v2 并进首页（§12 第 4 步）。
          用 Modal 而不是内联卡片：它的表单很长（间隔 / 保留策略 / 自定义 cron），
          内联会把首页撑成一条长卷轴，而首页的职责是「一眼看清机器状态」。 */}
      <Modal
        open={scheduleOpen}
        onClose={() => { setScheduleOpen(false) }}
        title={t('home.schedule.title')}
        wide
      >
        <Modal.Header
          title={t('home.schedule.title')}
          closeLabel={t('common.close')}
          onClose={() => { setScheduleOpen(false) }}
        />
        <Modal.Body scroll>
          <BackupScheduleCard
            api={api}
            t={t}
            syncT={syncT}
            onBackupDone={() => {
              // 备份完成后刷新状态行与最近活动（它们都在本页的数据里）
              setScheduleOpen(false)
              void load()
            }}
          />
        </Modal.Body>
      </Modal>
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
