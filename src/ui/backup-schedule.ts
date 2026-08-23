/**
 * 定时全量备份设置 —— 框架无关纯函数层（node 可测）。
 *
 * 职责：设置草稿校验 / 运行状态映射 / 类型定义（BackupScheduleStatus 等）。
 * 不产出任何用户可见文案（文案由 React 壳走 locale 字典 t()），不 import node 模块。
 *
 * 安全：定时备份恒不含 secret、不加密（加密密码仅内存且不能持久化）——
 * 本层无任何敏感字段，随 runStore 切片持久化亦安全。
 */
import type { BackupInterval, BackupRunStatus } from '../sync/backup-schedule-config.ts'
import type { BackupRunResult } from '../sync/backup-scheduler.ts'

export type { BackupInterval, BackupRunStatus, BackupRunResult }

/** 设置草稿（表单编辑态：总开关 + 间隔档位）。 */
export interface BackupScheduleDraft {
  enabled: boolean
  interval: BackupInterval
}

/** 可选的间隔档位（UI 展示顺序 = 由短到长）。 */
export const BACKUP_INTERVAL_OPTIONS: readonly BackupInterval[] = ['6h', '12h', '24h', '7d']

/** 定时备份配置的浏览器侧视图（与 sync/backup-schedule-config.ts 的持久化面一致；无敏感字段）。 */
export interface BackupScheduleStatus {
  enabled: boolean
  interval: BackupInterval
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
    return { ok: false, error: 'interval must be one of 6h/12h/24h/7d' }
  }
  return { ok: true, value: { enabled: d['enabled'], interval: d['interval'] as BackupInterval } }
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
  return draft.enabled !== saved.enabled || draft.interval !== saved.interval
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
