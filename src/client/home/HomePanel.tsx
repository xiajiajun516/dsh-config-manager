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
 * 数据流：挂载/刷新时 4 个**毫秒级**只读 API 逐个 settle 逐个渲染（骨架只等它们）；/sync/status
 * 独立加载、绝不参与骨架（它碰 DSH 凭据服务与 git 工作副本自检，真机出现过 300 s 不返回）；首屏不等分区预览；
 * 分区构成（export-preview）单独后发 —— 它要遍历全部默认分区（含本地插件打包、会话扫描），
 * 是最慢的一步，等它会让整页转圈（真机曾达 12~30 s）。全部渲染模型来自 src/ui/overview-view.ts
 * 纯函数（node 单测覆盖），本组件只做装配。
 * 安全：历史摘要渲染前 redact()（宿主侧已脱敏，此处仅做 [REDACTED] 可读化显示）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotMeta } from '../../core/restore.ts'
import { midEllipsis } from '../../ui/mid-ellipsis.ts'
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
import { Badge, Banner, Button, Card, StatusDot, Stepper } from '../common/ui.tsx'
import { SkeletonActivityRows } from '../common/Skeleton.tsx'
import { BackupIcon, ExportIcon, ImportIcon } from '../common/Icon.tsx'
import { CopyButton } from '../common/CopyButton.tsx'
import { Modal } from '../common/Modal.tsx'
import { BackupScheduleCard } from './BackupScheduleCard.tsx'
import css from '../config-manager.module.css'

/** 首页同步状态请求超时（ms）：它只填一个指标段，超时走默认 30 秒文案档（时长与文案一致）。 */
const HOME_SYNC_TIMEOUT_MS = 30_000
/** 首页活动表所需的最近条数（表里只显示 30 条，多取一段留作「同秒多条」时的余量）。
 *  服务端按文件名尾部只读最近 N 个文件 —— 不再把 2360 条历史全量读出来返给首屏。 */
const HOME_ACTIVITY_LIMIT = 100

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
  /** 首屏 3 个毫秒级只读接口（backups/snapshots/schedule）是否仍在飞（决定状态条骨架）。 */
  const [loading, setLoading] = useState(true)
  /** 最近活动的独立加载态：/history 是**目录全量扫描**（真机冷 9.7s / 2360 条），
   *  绝不能再参与首屏骨架 —— 它没到之前活动卡自己铺骨架，其余页面照常可用。 */
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'failed'>('loading')
  /** 同步状态的独立加载态：'failed' 时指标段显示「读取超时」（绝不冒充「未配置」）。 */
  const [syncState, setSyncState] = useState<'loading' | 'ready' | 'failed'>('loading')
  /** 首屏 5 个只读请求（3 个快请求 + 同步状态 + 最近活动）的失败情况（null = 全部成功 / 还没跑过）。
   *  为什么必须有它：此前 allSettled 把失败一律吞成 null，而健康判定对 null 不降级 ——
   *  宿主接口整体不可达时，用户看到的是绿色「配置健康」+「暂无操作记录」，
   *  读起来像「一切正常只是没操作过」，真实原因与重试入口都不可见。 */
  const [loadError, setLoadError] = useState<{ count: number; message: string } | null>(null)
  const [backupRunning, setBackupRunning] = useState(false)
  /** 卸载后不再 setState（异步回调竞态防护） */
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])
  /** 本轮首屏的失败集合（3 个快请求 + 同步状态 + 最近活动共享）：横幅的计数与首条原因都出自这里。 */
  const failuresRef = useRef<unknown[]>([])
  const publishFailures = useCallback((): void => {
    if (!aliveRef.current) return
    const list = failuresRef.current
    const first = list[0]
    setLoadError(list.length === 0 ? null : {
      count: list.length,
      message: first instanceof Error ? first.message : String(first),
    })
  }, [])

  /** 首屏 3 个毫秒级只读接口（backups/snapshots/schedule）：**逐个 settle 逐个渲染**，
   *  凑齐才撤骨架；「首屏好了没」只看它们 —— 同步状态与最近活动各走一条独立通道（见下方注释）。 */
  const loadFast = useCallback(async (): Promise<void> => {
    failuresRef.current = []
    let remaining = 3
    /** 单个快请求：成功就写自己那块数据，失败只记账（不牵连其它块，也不延长骨架）。 */
    const runFast = <T,>(promise: Promise<T>, apply: (value: T) => void): void => {
      void promise.then(
        (value) => { if (aliveRef.current) apply(value) },
        (reason) => { failuresRef.current.push(reason) },
      ).finally(() => {
        remaining -= 1
        if (remaining > 0) return
        publishFailures()
        if (aliveRef.current) setLoading(false)
      })
    }
    runFast(api.listBackupFiles(), (value) => { setData((prev) => ({ ...prev, backups: value })) })
    runFast(api.snapshots(), (value) => { setData((prev) => ({ ...prev, snapshots: value })) })
    runFast(api.backupSchedule(), (value) => { setData((prev) => ({ ...prev, schedule: value })) })
    // 最近活动**独立通道**：/history 要按文件名扫历史目录，条目多时是秒级（真机冷 9.7s / 2360 条）。
    // 同桶时它把整页按在骨架上 —— 首页只会用到最近 30 条，所以按 limit 只读尾部，且绝不参与首屏骨架。
    setHistoryState('loading')
    void historyApi.list({ limit: HOME_ACTIVITY_LIMIT }).then(
      (value) => {
        if (!aliveRef.current) return
        setData((prev) => ({ ...prev, history: value }))
        setHistoryState('ready')
        publishFailures()
      },
      (reason) => {
        failuresRef.current.push(reason)
        if (!aliveRef.current) return
        setHistoryState('failed')
        publishFailures()
      },
    )
    // 同步状态**独立加载、绝不参与首屏骨架**：/sync/status 会碰 DSH credentials 服务与 git 工作副本
    // 自检，真机出现过 300 秒不返回。此前它与其余 4 个请求同桶 allSettled，一个挂住就把整页按在骨架上。
    // 超时取 30 秒档（客户端超时文案按时长插值，读作「30 秒」，与实测一致）。
    setSyncState('loading')
    // workDirDetail: false —— 首页只用这一份填指标段，不渲染 WorkDirCard；关掉 ahead/dirty/
    // 远端快照数可省 5 次 git 子进程启动（Windows 每次约 80 ms，实测 730 ms → 170 ms）。
    void syncApi.status({ timeoutMs: HOME_SYNC_TIMEOUT_MS, workDirDetail: false }).then(
      (value) => {
        if (!aliveRef.current) return
        setData((prev) => ({ ...prev, sync: value }))
        setSyncState('ready')
        publishFailures()
      },
      (reason) => {
        failuresRef.current.push(reason)
        if (!aliveRef.current) return
        setSyncState('failed')
        publishFailures()
      },
    )
  }, [api, syncApi, historyApi, publishFailures])

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
    // 同步状态读取失败（超时/不可用）：值留空、附注如实写「读取超时」——
    // 落到 sync=null 的「无值」上会读成「没配置」，与真实原因相反。
    if (m.key === 'sync' && syncState === 'failed') {
      return { key: m.key, label: t(METRIC_LABEL[m.key]), value: '—', dim: t('overview.meta.syncUnavailable') }
    }
    return { key: m.key, label: t(METRIC_LABEL[m.key]), value, dim }
  })

  /** 某指标段是否仍在等数据：同步段只看自己的加载态，其余三段/四段看首屏快请求。 */
  const segLoading = (key: OverviewMetricKey): boolean => (key === 'sync' ? syncState === 'loading' : loading)

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
            {segLoading(seg.key)
              ? <span className={css.skeletonBar + ' ' + css.statValueSkeleton} aria-hidden="true" />
              : <b>{seg.value}</b>}
            {!segLoading(seg.key) && seg.dim !== null && <span className={css.statSegDim}>· {seg.dim}</span>}
          </button>
        ))}
      </div>

      {/* 2. 动作工具栏：立即备份 + 三张「任务域」入口（带走 / 装进 / 回去）。
           「立即备份」按用户要求放在**最左**（导出 ZIP 的左边）：它与「导出」是同一件事的
           两种强度 —— 先备份、再带走 —— 相邻放置比放在状态行右端更符合作业顺序。 */}
      <div className={css.toolRow}>
        <Button
          variant="primary"
          loading={backupRunning}
          onClick={() => { void runBackupNow() }}
        >
          {backupRunning ? null : <BackupIcon size={14} />} {t('overview.quick.backup')}
        </Button>
        <Button onClick={openExportTask}>
          <ExportIcon size={14} /> {t('nav.export')} ZIP
        </Button>
        <Button onClick={openImportTask}>
          <ImportIcon size={14} /> {t('nav.import')}
        </Button>
        {/* 外部 agent 入口（t17）：与「导入」并列但**直达来源选择** ——
            装了 Claude Code / Cursor 的用户要找的就是这条路，而不是先进向导再找按钮。 */}
        {openForeignImport !== undefined && (
          <Button onClick={openForeignImportTask}>
            <ImportIcon size={14} /> {t('foreign.source.title')}
          </Button>
        )}
      </div>

      {emptyState ? (
        /* 首用空态：只交代顺序（备份 → 导出 → 导入），动作全交给上方工具栏 ——
           此前这里又放了一遍「立即备份 / 远程同步」，等于同一屏两个入口。 */
        <Card className={css.activityCard}>
          <span className={css.groupLabel}>{t('overview.empty.title')}</span>
          <div className={css.emptySteps}>
            <Stepper
              steps={overviewFirstSteps().map((s, i) => ({
                key: s.key,
                label: t(`overview.empty.${s.key}`),
                state: i === 0 ? 'current' : 'todo',
              }))}
            />
          </div>
        </Card>
      ) : (
        <>
          {/* 3. 最近活动表（**首页最后一个数据块**）。2026-11-01：不再用 .fillCard 撑满视口 ——
              8 行记录撑到 400px 后，卡内下方留出约 150px 纯空区，被读成「表格还没加载完」
              （app-screens §4.2：卡内 >40px 空带读作未完成）。现在卡片高度随内容，
              行数多时由 .activityRows 的 max-height 内滚；页底留白属于页面层级，读起来是完整的。 */}
          <Card className={css.activityCard}>
            <div className={css.activityHeader}>
              <span className={css.activityTitle}>{t('overview.activity.title')}</span>
              {/* 加载说明放列头右侧（2026-11-04）：旧骨架把「加载中…」渲在占位块**下面**，
                  数据到达时那行说明消失 ⇒ 整块再跳一次。放这里与真实态的空白位同一行同一处。 */}
              {historyState === 'loading' && <span className={css.activityLoadingNote}>{t('common.loading')}</span>}
            </div>
            {/* 列头提到三元之外（2026-11-04）：加载态与完成态共用同一行表头 ⇒ 列位、行高、
                滚动条槽全部一致；数据到达时是「占位条原位换成文字」，不是整块重排。
                空态/失败态不渲染表头（没有列可对，留着只会多一条空行）。 */}
            {(historyState === 'loading' || activity.length > 0) && (
              <div className={css.activityHead}>
                <span>{t('overview.activity.colTime')}</span>
                <span>{t('overview.activity.colEvent')}</span>
                <span>{t('overview.activity.colDetail')}</span>
                <span>{t('overview.activity.colResult')}</span>
              </div>
            )}
            {/* 首屏未完成时**不写空态**：以前这里直接渲染「暂无操作记录」，数据没到就说
                「没有」，与真实情况相反。加载态铺的是与真实表同几何的骨架行。 */}
            {historyState === 'loading'
              ? (
                <div className={css.activityRows}>
                  {/* 骨架行与真实行同一 grid / 行高 / 分隔线，装在同一个滚动容器里 */}
                  <SkeletonActivityRows count={5} label={t('common.loading')} />
                </div>
              )
              : activity.length === 0
                ? <div className={css.activityEmpty}>{historyState === 'failed' || data.history === null ? t('overview.activity.unavailable') : t('overview.activity.empty')}</div>
                : (
                /* 列头（含「时间 / 事件 / 详情 / 结果」四列，app-screens §7.2：有表头才读得懂列）
                   已在三元之外渲染，这里只剩数据行。 */
                <div className={css.activityRows}>
                  {activity.map((item, i) => {
                    const atMs = Date.parse(item.at) || 0
                    const kindText = kindLabel(item.kindKey, t)
                    return (
                      <div className={css.activityRow} key={`${item.at}-${i}`}>
                        <span className={css.activityTime} title={atMs > 0 ? new Date(atMs).toLocaleString() : undefined}>
                          {renderRelTime(atMs, t)}
                        </span>
                        {/* kind 独立成列（2026-11-01）：原先它挤在摘要行里，「Import · 」的
                            长前缀把真正的区分信息（文件名尾部时间戳）挤出可视宽度，
                            中段省略再准也被前缀吃掉。 */}
                        <span className={css.activityKind} title={kindText}>{kindText}</span>
                        <span className={css.activitySummary}>
                          {/* 中段省略而不是尾部（DESIGN.md §9-5）：摘要里的区分信息在尾部
                              —— 文件名时间戳后缀、项数 —— 尾部截断会让两条记录看起来一样。
                              52 是 HomePanel 历史上的取值，换实现不改观感。title 保留全文。 */}
                          <span className={css.activitySummaryText} title={displaySummary(item.summary, t)}>
                            {midEllipsis(displaySummary(item.summary, t), 34)}
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
