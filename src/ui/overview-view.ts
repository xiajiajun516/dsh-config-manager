/**
 * Overview 总览页纯渲染模型（2026-09 UX 重构）：框架无关，node 可测。
 *
 * 职责：把各只读 API 的响应（备份文件 / 快照 / 定时备份 / 同步状态 / 迁移历史 /
 * 恢复模式 / 活跃 run）映射为 UI 展示所需的纯数据——指标卡、健康状态、建议、
 * 最近活动。**非控制器**：不持有状态、不发起请求；OverviewPanel 只做装配
 * （渲染 + 交互状态 + 导航），把本模块纯函数输出绑定到 React 组件。
 *
 * 数据形状说明：输入全部是最小结构类型（结构兼容各 API 响应的字段子集），
 * null/undefined = 该数据源尚未加载或加载失败（UI 显示占位，不阻塞整页）。
 *
 * 安全（UI HARD RULES）：所有自由文本（history.summary）由上层在渲染前过
 * redact()；kind / result 均为枚举常量，无 secret 承载面；本模块不输出任何文案，
 * 只输出 i18n key 基名与纯数据（与 history-model.ts 同模式）。
 */

/** 备份文件最小形状（结构兼容 sync/backup-files.ts BackupFileMeta 子集）。 */
export interface OverviewBackupLite {
  name: string
  sizeBytes: number
  mtimeMs: number
  source: 'auto' | 'manual'
}

/** 快照最小形状（结构兼容 core/restore.ts SnapshotMeta 子集）。 */
export interface OverviewSnapshotLite {
  createdAt: string
  entryCount: number
}

/** 定时备份状态最小形状（结构兼容 ui/backup-schedule.ts BackupScheduleStatus 子集）。 */
export interface OverviewScheduleLite {
  enabled: boolean
  lastRunAt?: string
  lastRunStatus?: string
}

/** 同步状态最小形状（结构兼容 client/sync-api.ts SyncStatusResponse 子集）。 */
export interface OverviewSyncLite {
  configured: boolean
  lastSyncAt?: string
}

/** 迁移历史条目最小形状（结构兼容 core/migration-history.ts StoredMigrationHistoryEntry 子集）。 */
export interface OverviewHistoryLite {
  at: string
  kind: string
  result: 'success' | 'failed' | 'skipped'
  summary: string
}

/** Overview 数据输入（null = 未加载/加载失败；组件逐项就绪逐项传入）。 */
export interface OverviewInputs {
  /** 当前时间（ms；相对时间计算基准，注入便于测试）。 */
  now: number
  backups: OverviewBackupLite[] | null
  snapshots: OverviewSnapshotLite[] | null
  schedule: OverviewScheduleLite | null
  sync: OverviewSyncLite | null
  history: OverviewHistoryLite[] | null
  /** SAFE MODE：有未解决恢复事项（null = 恢复状态未加载）。 */
  recoveryRequired: boolean | null
  /** 进行中任务数（run 列表长度）。 */
  runningCount: number
}

/* ---------------- 指标卡 ---------------- */

/** 指标卡 key（UI 用 `overview.metric.<key>` 渲染标签）。 */
export type OverviewMetricKey = 'backups' | 'snapshots' | 'schedule' | 'sync'

/** 指标卡附注 key（UI 用 `overview.meta.*` 渲染）。 */
export type OverviewMetaKey =
  | 'meta.lastBackup'
  | 'meta.noBackup'
  | 'meta.scheduleOn'
  | 'meta.scheduleOff'
  | 'meta.scheduleFail'
  | 'meta.syncOn'
  | 'meta.syncOff'
  | 'meta.never'

export interface OverviewMetric {
  key: OverviewMetricKey
  /** 指标类型：count=数量（value 为数字）/ state=开关状态（valueKey 为 i18n key）。 */
  kind: 'count' | 'state'
  /** 主数字（kind='count'；'—' = 未加载）。 */
  value: string
  /** 状态文案 key（kind='state' 时必有；UI 用 `overview.state.*` 渲染）。 */
  valueKey?: 'state.on' | 'state.off'
  metaKey: OverviewMetaKey | null
  /** 附注插值参数（metaParams.time 是 ms 数字字符串，组件层渲染为相对时间）。 */
  metaParams: Record<string, string>
  /** 附注语义（warn = 需要注意的附注，如定时备份上次失败）。 */
  metaTone: 'neutral' | 'warn'
}

/** 时间相对量（unit 渲染 key：`overview.time.<unit>`；null = 超出 7 天，显示绝对日期）。 */
export interface RelTimeParts {
  unit: 'now' | 'min' | 'hour' | 'day'
  n: number
}

/**
 * 相对时间：now 与 at（ms）差值 → now/min/hour/day；超出 7 天或 at 无效 → null
 * （上层回退绝对日期）。
 */
export function relTime(now: number, at: number): RelTimeParts | null {
  if (!Number.isFinite(at) || at <= 0 || now < at) return null
  const diffMs = now - at
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  if (diffMs < MIN) return { unit: 'now', n: 0 }
  if (diffMs < HOUR) return { unit: 'min', n: Math.floor(diffMs / MIN) }
  if (diffMs < DAY) return { unit: 'hour', n: Math.floor(diffMs / HOUR) }
  if (diffMs < 7 * DAY) return { unit: 'day', n: Math.floor(diffMs / DAY) }
  return null
}

/** ISO 字符串 → ms（无效返回 null）。 */
export function isoToMs(iso: string | undefined): number | null {
  if (iso === undefined || iso === '') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** 最近一次备份（mtime 最大者；空/未加载 → null）。 */
export function latestBackup(backups: OverviewBackupLite[] | null): OverviewBackupLite | null {
  if (backups === null || backups.length === 0) return null
  let best = backups[0]!
  for (const b of backups) if (b.mtimeMs > best.mtimeMs) best = b
  return best
}

/** 最近一次快照（createdAt 最大者；空/未加载 → null）。 */
export function latestSnapshot(snapshots: OverviewSnapshotLite[] | null): OverviewSnapshotLite | null {
  if (snapshots === null || snapshots.length === 0) return null
  let best = snapshots[0]!
  let bestMs = isoToMs(best.createdAt) ?? 0
  for (const s of snapshots) {
    const ms = isoToMs(s.createdAt) ?? 0
    if (ms > bestMs) {
      best = s
      bestMs = ms
    }
  }
  return best
}

/**
 * 构建四张指标卡（备份文件 / 安全快照 / 定时备份 / 远程同步）。
 * 未加载的数据源 value='—' + metaKey=null；metaParams.time 是 ms 数字字符串，
 * 组件层用 relTime 渲染为相对时间文案。
 */
export function buildOverviewMetrics(inputs: OverviewInputs): OverviewMetric[] {
  const { backups, snapshots, schedule, sync } = inputs

  // 备份文件：数量 + 最近备份相对时间
  const lastBackupAt = latestBackup(backups)?.mtimeMs ?? null
  const backupMetric: OverviewMetric = backups === null
    ? { key: 'backups', kind: 'count', value: '—', metaKey: null, metaParams: {}, metaTone: 'neutral' }
    : {
        key: 'backups',
        kind: 'count',
        value: String(backups.length),
        metaKey: lastBackupAt !== null ? 'meta.lastBackup' : 'meta.noBackup',
        metaParams: lastBackupAt !== null ? { time: String(lastBackupAt) } : {},
        metaTone: 'neutral',
      }

  // 快照：数量 + 最近快照相对时间
  const lastSnapshotMs = isoToMs(latestSnapshot(snapshots)?.createdAt)
  const snapshotMetric: OverviewMetric = snapshots === null
    ? { key: 'snapshots', kind: 'count', value: '—', metaKey: null, metaParams: {}, metaTone: 'neutral' }
    : {
        key: 'snapshots',
        kind: 'count',
        value: String(snapshots.length),
        metaKey: lastSnapshotMs !== null ? 'meta.lastBackup' : 'meta.noBackup',
        metaParams: lastSnapshotMs !== null ? { time: String(lastSnapshotMs) } : {},
        metaTone: 'neutral',
      }

  // 定时备份：开/关状态 + 上次运行（失败 → warn 附注）
  let scheduleMetric: OverviewMetric
  if (schedule === null) {
    scheduleMetric = { key: 'schedule', kind: 'state', value: '', valueKey: undefined, metaKey: null, metaParams: {}, metaTone: 'neutral' }
  } else {
    const lastRunMs = isoToMs(schedule.lastRunAt)
    const failed = schedule.lastRunStatus === 'failed'
    scheduleMetric = {
      key: 'schedule',
      kind: 'state',
      value: '',
      valueKey: schedule.enabled ? 'state.on' : 'state.off',
      metaKey: !schedule.enabled
        ? 'meta.scheduleOff'
        : failed
          ? 'meta.scheduleFail'
          : lastRunMs !== null
            ? 'meta.scheduleOn'
            : 'meta.never',
      metaParams: lastRunMs !== null ? { time: String(lastRunMs) } : {},
      metaTone: schedule.enabled && failed ? 'warn' : 'neutral',
    }
  }

  // 远程同步：已配置/未配置状态 + 上次同步
  let syncMetric: OverviewMetric
  if (sync === null) {
    syncMetric = { key: 'sync', kind: 'state', value: '', valueKey: undefined, metaKey: null, metaParams: {}, metaTone: 'neutral' }
  } else {
    const lastSyncMs = isoToMs(sync.lastSyncAt)
    syncMetric = {
      key: 'sync',
      kind: 'state',
      value: '',
      valueKey: sync.configured ? 'state.on' : 'state.off',
      metaKey: !sync.configured
        ? 'meta.syncOff'
        : lastSyncMs !== null
          ? 'meta.syncOn'
          : 'meta.never',
      metaParams: lastSyncMs !== null ? { time: String(lastSyncMs) } : {},
      metaTone: 'neutral',
    }
  }

  return [backupMetric, snapshotMetric, scheduleMetric, syncMetric]
}

/* ---------------- 健康状态 ---------------- */

export type OverviewHealthKind = 'ok' | 'warn' | 'error'

export interface OverviewHealth {
  kind: OverviewHealthKind
  /** UI 渲染 key（`overview.health.*`）。 */
  textKey: 'health.ok' | 'health.noBackup' | 'health.scheduleFailed' | 'health.recovery'
}

/**
 * 配置健康判定（保守优先级）：
 * 1. SAFE MODE 激活（有未解决恢复事项）→ error（最高优先，需用户处理）；
 * 2. 已加载且备份与快照均为空 → warn「尚无任何备份」（新装机引导场景）；
 * 3. 定时备份开启但上次运行失败 → warn；
 * 4. 其余 → ok。
 * 数据未加载（null）不降级健康状态（避免加载闪红）。
 */
export function overviewHealth(inputs: OverviewInputs): OverviewHealth {
  if (inputs.recoveryRequired === true) {
    return { kind: 'error', textKey: 'health.recovery' }
  }
  if (inputs.backups !== null && inputs.snapshots !== null
    && inputs.backups.length === 0 && inputs.snapshots.length === 0) {
    return { kind: 'warn', textKey: 'health.noBackup' }
  }
  if (inputs.schedule !== null && inputs.schedule.enabled && inputs.schedule.lastRunStatus === 'failed') {
    return { kind: 'warn', textKey: 'health.scheduleFailed' }
  }
  return { kind: 'ok', textKey: 'health.ok' }
}

/* ---------------- 最近活动 ---------------- */

/** 已知迁移操作 kind（与 core/migration-history.ts MIGRATION_KINDS 对齐；仅用于 key 归一）。 */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'import', 'restore', 'rollback',
  'profile-create', 'profile-select', 'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
  'sync-apply', 'autosync', 'recovery',
  'backup', 'backup-manual', 'snapshot-delete', 'snapshot-prune',
])

/**
 * kind → 概览活动行用的文案键（未知 kind 归一为 `overview.kind.other`）。
 * 独立成函数以便守卫测试枚举全部 MigrationKind 断言字典齐备（新增 kind 忘记配文案时，
 * 界面会直接显示裸 key —— 这正是 backup-manual 引入时的风险点）。
 */
export function overviewKindKey(kind: string): string {
  return KNOWN_KINDS.has(kind) ? `overview.kind.${kind}` : 'overview.kind.other'
}

export interface OverviewActivityItem {
  at: string
  /** 徽章语义（success→ok / failed→error / skipped→warn，与 history-model 同判定）。 */
  badge: 'ok' | 'error' | 'warn'
  /** UI 渲染 key（`overview.kind.<kind>`；未知 kind 归一为 other → `overview.kind.other`）。 */
  kindKey: string
  /** 原始摘要（上层渲染前 redact()）。 */
  summary: string
}

/** 最近活动列表：按时间倒序取前 limit 条（kindKey 归一 + 徽章语义映射）。 */
export function overviewActivity(
  history: OverviewHistoryLite[] | null,
  limit = 5,
): OverviewActivityItem[] {
  if (history === null || history.length === 0) return []
  const sorted = [...history].sort((a, b) => {
    const ma = isoToMs(a.at) ?? 0
    const mb = isoToMs(b.at) ?? 0
    return mb - ma
  })
  return sorted.slice(0, limit).map((e) => ({
    at: e.at,
    badge: e.result === 'success' ? 'ok' : e.result === 'failed' ? 'error' : 'warn',
    kindKey: overviewKindKey(e.kind),
    summary: e.summary,
  }))
}

/** 空态判定：备份与快照均已加载且都为空 → 显示「开始保护你的配置」引导。 */
export function overviewEmptyState(inputs: OverviewInputs): boolean {
  return inputs.backups !== null && inputs.snapshots !== null
    && inputs.backups.length === 0 && inputs.snapshots.length === 0
}
