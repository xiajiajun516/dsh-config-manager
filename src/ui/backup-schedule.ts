/**
 * 定时全量备份设置 —— 框架无关纯函数层（node 可测）。
 *
 * 职责：设置草稿校验 / 运行状态映射 / 类型定义（BackupScheduleStatus 等）。
 * 不产出任何用户可见文案（文案由 React 壳走 locale 字典 t()），不 import node 模块。
 *
 * P0-⑤：新增「自定义（每周固定时刻）」档（interval='custom' + customSchedule），
 * 校验层与草稿类型同步扩展；host 保存路由、BackupScheduleCard 共用本层校验。
 *
 * 安全：定时备份恒不含 secret、不加密（加密密码仅内存且不能持久化）——
 * 本层无任何敏感字段，随 runStore 切片持久化亦安全。
 */
import type { BackupInterval, BackupRunStatus, BackupWeeklySchedule } from '../sync/backup-schedule-config.ts'
import type { BackupRunResult } from '../sync/backup-scheduler.ts'

export type { BackupInterval, BackupRunStatus, BackupRunResult, BackupWeeklySchedule }

/** 设置草稿（表单编辑态：总开关 + 间隔档位 + 自定义周档）。 */
export interface BackupScheduleDraft {
  enabled: boolean
  interval: BackupInterval
  /** custom 档的每周固定时刻（仅 interval='custom' 时校验；其他档位忽略） */
  customSchedule?: BackupWeeklySchedule
}

/** 可选的间隔档位（UI 展示顺序 = 由短到长）。 */
export const BACKUP_INTERVAL_OPTIONS: readonly BackupInterval[] = ['6h', '12h', '24h', '7d', 'custom']

/** 每周星期选项（0-6 → 展示文案由 locale 提供；本层只给值域） */
export const WEEKDAY_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'sunday' },
  { value: 1, label: 'monday' },
  { value: 2, label: 'tuesday' },
  { value: 3, label: 'wednesday' },
  { value: 4, label: 'thursday' },
  { value: 5, label: 'friday' },
  { value: 6, label: 'saturday' },
]

/** 定时备份配置的浏览器侧视图（与 sync/backup-schedule-config.ts 的持久化面一致；无敏感字段）。 */
export interface BackupScheduleStatus {
  enabled: boolean
  interval: BackupInterval
  customSchedule?: BackupWeeklySchedule
  startupMinIntervalMs: number
  consecutiveFailures: number
  lastRunAt?: string
  lastRunStatus?: BackupRunStatus
  lastRunMessage?: string
}

/** 校验设置输入（host 侧保存路由与组件提交共用；接受 unknown 防御畸形/空 body）。 */
export function validateBackupScheduleDraft(
  draft: unknown,
): { ok: true; value: BackupScheduleDraft } | { ok: false; error: string } {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'body must be an object with enabled (boolean) and interval' }
  }
  const d = draft as Record<string, unknown>
  if (typeof d['enabled'] !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' }
  }
  if (!BACKUP_INTERVAL_OPTIONS.includes(d['interval'] as BackupInterval)) {
    return { ok: false, error: 'interval must be one of 6h/12h/24h/7d/custom' }
  }
  const interval = d['interval'] as BackupInterval
  const value: BackupScheduleDraft = { enabled: d['enabled'], interval }
  if (interval === 'custom') {
    const weekly = typeof d['customSchedule'] === 'object' && d['customSchedule'] !== null && !Array.isArray(d['customSchedule'])
      ? d['customSchedule'] as Record<string, unknown>
      : undefined
    const dayOfWeek = weekly?.['dayOfWeek']
    const hour = weekly?.['hour']
    const minute = weekly?.['minute']
    if (
      !Number.isInteger(dayOfWeek) || (dayOfWeek as number) < 0 || (dayOfWeek as number) > 6
      || !Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23
      || !Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59
    ) {
      return { ok: false, error: 'customSchedule must include dayOfWeek (0-6), hour (0-23), minute (0-59)' }
    }
    value.customSchedule = { dayOfWeek: dayOfWeek as number, hour: hour as number, minute: minute as number }
  }
  return { ok: true, value }
}

/** 上次运行状态 → Badge kind（success→ok / skipped→info / failed→error / 未知→info）。 */
export function backupRunBadgeKind(status: BackupRunStatus | undefined): 'info' | 'ok' | 'warn' | 'error' {
  switch (status) {
    case 'success': return 'ok'
    case 'failed': return 'error'
    case 'skipped': return 'info'
    default: return 'info'
  }
}

/** 判断草稿相对已保存配置是否有未保存修改（决定「保存设置」按钮可用性）。 */
export function backupDraftDirty(draft: BackupScheduleDraft, saved: BackupScheduleStatus | null): boolean {
  if (saved === null) return true
  if (draft.enabled !== saved.enabled || draft.interval !== saved.interval) return true
  if (draft.interval === 'custom') {
    const a = draft.customSchedule
    const b = saved.customSchedule
    if (a === undefined || b === undefined) return a !== b
    return a.dayOfWeek !== b.dayOfWeek || a.hour !== b.hour || a.minute !== b.minute
  }
  return false
}

/** 立即备份结果摘要（供 UI 展示；不含 secret）。 */
export function backupRunSummary(run: BackupRunResult): {
  status: BackupRunStatus
  zip: string | null
  sizeBytes: number | null
  skipReason: string | null
  error: string | null
} {
  return {
    status: run.status,
    zip: run.zip ?? null,
    sizeBytes: run.sizeBytes ?? null,
    skipReason: run.skipReason ?? null,
    error: run.error ?? null,
  }
}
