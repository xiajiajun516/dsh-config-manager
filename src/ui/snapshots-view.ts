/**
 * 备份页（Backups：快照恢复 / 备份文件 / 定时备份设置）—— 框架无关纯函数层（node 可测）。
 *
 * t43 从 `src/client/snapshots/SnapshotsPanel.tsx` 下沉（该组件原先把这些逻辑私有在函数体内，
 * 违反仓库铁律「逻辑放 src/ui」——node 无法测试）。本层职责：
 *  - 面板状态切片 ← runStore 快照切片 的投影（切页/刷新恢复的判定）；
 *  - 状态/档位 → **字典键**（本层不产出任何用户可见文案，由 React 壳 t() 渲染，见 backup-schedule.ts 同款约定）；
 *  - 时间与文件名的展示格式化；
 *  - 备份文件列表的搜索过滤、备注可读性判定；
 *  - 恢复计划是否含可执行动作（执行按钮的 disabled 判据）。
 *
 * 约束：不 import node 模块、不 import `../client/*`（架构边界 tests/architecture-boundaries.test.ts）、
 * 无 React 依赖；类型仅从 `../core/*` / `../sync/*` 以 type-only 方式取（运行时不加载）。
 */
import type { RestorePlan, RestoreReport, SnapshotMeta } from '../core/restore.ts'
import type { RestoreChangeSummary } from '../core/snapshot-diff.ts'
import type { BackupFileMeta } from '../sync/backup-files.ts'
import type { BackupInterval, BackupRunStatus, BackupScheduleStatus } from './backup-schedule.ts'

/* ------------------------------------------------ 面板状态（切页 / 刷新恢复） */

export interface SnapshotsPanelState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  metas: SnapshotMeta[]
  selectedId: string | null
  planning: boolean
  plan: RestorePlan | null
  /** git 风格预览：宿主返回的逐动作变更状态 + 行数统计（null = 旧宿主未返回） */
  changeSummary: RestoreChangeSummary | null
  running: boolean
  report: RestoreReport | null
  /**
   * 仅承载「恢复计划（dry-run）加载失败」——渲染点在计划预览弹窗内。
   * 其余动作失败（执行恢复/置顶/删除）走全局 Toast，绝不写这里：
   * 那些动作发生时弹窗已关闭，写进来等于没有任何渲染点（曾经就是这样静默丢失的）。
   */
  actionError: string | null
}

export const INITIAL_SNAPSHOTS_PANEL_STATE: SnapshotsPanelState = {
  status: 'loading',
  error: null,
  metas: [],
  selectedId: null,
  planning: false,
  plan: null,
  changeSummary: null,
  running: false,
  report: null,
  actionError: null,
}

/**
 * runStore 快照切片里承载「面板可见状态」的字段子集。
 * 用结构类型声明（而非 import `SnapshotsStoreSlice`）：src/ui 不得依赖 `../client/*`，
 * 同时让本投影函数可以脱离模块级单例被单测直接喂入。
 */
export interface SnapshotsPanelStoreSlice {
  selectedId: string | null
  running: boolean
  plan: RestorePlan | null
  changeSummary: RestoreChangeSummary | null
  report: RestoreReport | null
  actionError: string | null
  error: string | null
}

/**
 * 从 store 切片恢复上次的面板状态（切页回 / 刷新后挂载）。
 * 无敏感字段；plan/report 为纯数据，可安全序列化恢复。
 * running 来自 store 镜像（刷新后经 runStore.resume() 以宿主 /runs 为权威重新置位）。
 */
export function snapshotsPanelStateFromStore(slice: SnapshotsPanelStoreSlice): SnapshotsPanelState {
  return {
    ...INITIAL_SNAPSHOTS_PANEL_STATE,
    selectedId: slice.selectedId,
    running: slice.running,
    plan: slice.plan,
    changeSummary: slice.changeSummary,
    report: slice.report,
    actionError: slice.actionError,
    error: slice.error,
  }
}

/* ------------------------------------------------------------ 展示派生（键） */

/**
 * 中段省略：唯一实现在 `./mid-ellipsis.ts`（t6 去重，默认 `max = 26`，语义与退化区说明见该模块）。
 * 此处保留同名再导出，让既有调用点（`src/client/snapshots/SnapshotsPanel.tsx` 与本目录单测）
 * 继续按原路径引用——改它们的 import 属跨任务文件，越界。
 */
export { midEllipsis } from './mid-ellipsis.ts'

export type SnapshotStatusLabelKey =
  | 'snapshots.status.pending' | 'snapshots.status.done' | 'snapshots.status.rolled-back' | 'snapshots.status.unknown'

/** 快照状态 → 字典键（未知/缺省值 → unknown，不显示裸英文 token）。 */
export function snapshotStatusLabelKey(status: SnapshotMeta['status']): SnapshotStatusLabelKey {
  switch (status) {
    case 'pending': return 'snapshots.status.pending'
    case 'done': return 'snapshots.status.done'
    case 'rolled-back': return 'snapshots.status.rolled-back'
    default: return 'snapshots.status.unknown'
  }
}

/** 快照状态 → Badge 语义（与 common/ui.tsx 的 Badge kind 一一对应）。 */
export function snapshotStatusBadgeKind(status: SnapshotMeta['status']): 'info' | 'ok' | 'warn' | 'error' {
  switch (status) {
    case 'pending': return 'info'
    case 'done': return 'ok'
    case 'rolled-back': return 'warn'
    default: return 'error'
  }
}

export type BackupIntervalLabelKey =
  | 'backupSchedule.interval.6h' | 'backupSchedule.interval.12h' | 'backupSchedule.interval.24h'
  | 'backupSchedule.interval.7d' | 'backupSchedule.interval.custom'

/** 间隔档位 → 字典键（穷尽 switch：新增档位时编译期报错）。 */
export function backupIntervalLabelKey(interval: BackupInterval): BackupIntervalLabelKey {
  switch (interval) {
    case '6h': return 'backupSchedule.interval.6h'
    case '12h': return 'backupSchedule.interval.12h'
    case '24h': return 'backupSchedule.interval.24h'
    case '7d': return 'backupSchedule.interval.7d'
    case 'custom': return 'backupSchedule.interval.custom'
  }
}

export type WeekdayLabelKey =
  | 'backupSchedule.weekday.sunday' | 'backupSchedule.weekday.monday' | 'backupSchedule.weekday.tuesday'
  | 'backupSchedule.weekday.wednesday' | 'backupSchedule.weekday.thursday' | 'backupSchedule.weekday.friday'
  | 'backupSchedule.weekday.saturday'

/** 星期序号 → 字典键；**值域外返回 null**（调用方回退 `String(dayOfWeek)`，绝不吞掉原始值）。 */
export function weekdayLabelKey(dayOfWeek: number): WeekdayLabelKey | null {
  switch (dayOfWeek) {
    case 0: return 'backupSchedule.weekday.sunday'
    case 1: return 'backupSchedule.weekday.monday'
    case 2: return 'backupSchedule.weekday.tuesday'
    case 3: return 'backupSchedule.weekday.wednesday'
    case 4: return 'backupSchedule.weekday.thursday'
    case 5: return 'backupSchedule.weekday.friday'
    case 6: return 'backupSchedule.weekday.saturday'
    default: return null
  }
}

export type BackupRunStatusLabelKey =
  | 'backupSchedule.status.success' | 'backupSchedule.status.skipped' | 'backupSchedule.status.failed'

/** 上次运行状态 → 字典键；未知/缺省返回 null（调用方渲染 '—'）。 */
export function backupRunStatusLabelKey(status: BackupRunStatus | undefined): BackupRunStatusLabelKey | null {
  switch (status) {
    case 'success': return 'backupSchedule.status.success'
    case 'skipped': return 'backupSchedule.status.skipped'
    case 'failed': return 'backupSchedule.status.failed'
    default: return null
  }
}

/** ISO 时间 → 本地可读时间；空值 → ''；不可解析 → 原样返回（不吞掉宿主原始值）。 */
export function formatRunTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * 「备份间隔」事实行的形状（文案由 React 壳拼，本层只给结构化事实）：
 *  - none：未启用 / 宿主未返回 → 壳渲染 '—'；
 *  - interval：普通档位 → 壳渲染该档位字典文案；
 *  - time：custom 档 → 壳渲染「周一 03:00」（星期键 + 两位时刻）。
 * 事实行统一取宿主权威值 saved（草稿编辑不改写事实行，避免把未生效档位显示成已生效）。
 */
export type ScheduleIntervalFact =
  | { kind: 'none' }
  | { kind: 'interval'; interval: BackupInterval }
  | { kind: 'time'; dayOfWeek: number; hour: number; minute: number }

/** 由宿主配置派生「备份间隔」事实行形状（缺省时刻 周一 03:00，与宿主侧缺省一致）。 */
export function scheduleIntervalFact(saved: BackupScheduleStatus | null): ScheduleIntervalFact {
  if (saved === null || !saved.enabled) return { kind: 'none' }
  if (saved.interval !== 'custom') return { kind: 'interval', interval: saved.interval }
  return {
    kind: 'time',
    dayOfWeek: saved.customSchedule?.dayOfWeek ?? 1,
    hour: saved.customSchedule?.hour ?? 3,
    minute: saved.customSchedule?.minute ?? 0,
  }
}

/* ------------------------------------------------------------ 备份文件列表 */

/**
 * 备份文件名搜索（P0-④）：文件名 + 备注子串匹配（大小写不敏感）；空查询/纯空白不过滤。
 * 返回新数组（不修改入参）。此前该过滤写在组件体内，node 无法测试。
 */
export function filterBackupFiles(files: readonly BackupFileMeta[], query: string): BackupFileMeta[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...files]
  return files.filter((f) => f.name.toLowerCase().includes(q) || (f.note ?? '').toLowerCase().includes(q))
}

/** 修改时间 → 等宽 `YYYY-MM-DD HH:mm`（本地时区）；不可解析 → ''（调用方另有 title 显示完整时间）。 */
export function formatBackupFileTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 备注是否「编码损坏」（全问号/控制符）→ 调用方改渲染 backupFiles.noteUnreadable 文案；
 * 其余备注原样展示（本层不产出文案）。
 */
export function isUnreadableNote(note: string): boolean {
  return /^[?\s]+$/.test(note)
}

/* ------------------------------------------------------------ 恢复计划判据 */

/**
 * 计划是否含可执行动作（全部为 skip / 空计划 → false）。
 * 即执行按钮的可点判据：`disabled = running || !planHasExecutableActions(plan)`。
 */
export function planHasExecutableActions(plan: RestorePlan | null): boolean {
  return plan !== null && plan.actions.some((a) => a.kind !== 'skip')
}
