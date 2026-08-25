/**
 * 配置档案（Profiles）—— 框架无关纯函数层（node 可测）。
 *
 * 职责：Profile 名输入校验（复用 core ProfileManager.isValidProfileName 同规则）、
 * 切换预览汇总（复用 import 预览统计口径）、视图辅助（结果语义 kind）。
 * 不产出用户可见文案（文案走 locale 字典 t()），不 import node 模块。
 *
 * 安全：Profile 天然不含秘密值（Save 走 adapter.export 脱敏）；本层无敏感字段。
 */
import type { SwitchPreview, ProfileSwitchResult } from '../profiles/profile-manager.ts'

/** 切换结果语义 kind（ok / failed / rolledBack；与同步 applyItems 报告语义一致）。 */
export type ProfileSwitchKind = 'ok' | 'failed' | 'rolledBack'

/** 校验 Profile 名输入（与 host/ProfileManager 同规则：拒绝路径穿越/非法字符；空提示）。 */
export function validateProfileNameInput(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'name is required'
  if (trimmed.length > 64) return 'name must be ≤ 64 characters'
  if (trimmed === '.' || trimmed === '..') return 'illegal name'
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return 'illegal characters'
  if (trimmed.includes('..')) return 'illegal characters'
  return null
}

/** 切换预览摘要（统计口径与导入预览一致：willChange/unchanged/conflicts/needsRestart）。 */
export interface SwitchPreviewSummary {
  willChange: number
  unchanged: number
  conflicts: number
  secretsNeeded: number
  needsRestart: boolean
  sectionsInProfile: string[]
}

export function summarizeSwitchPreview(preview: SwitchPreview): SwitchPreviewSummary {
  const items = preview.items
  const count = (kinds: readonly string[]): number => items.filter((i) => kinds.includes(i.kind)).length
  return {
    willChange: count(['Create', 'Update', 'Install', 'Conflict']),
    unchanged: count(['Skip']),
    conflicts: count(['Conflict']),
    secretsNeeded: preview.missingSecrets.length,
    needsRestart: preview.needsRestart,
    sectionsInProfile: preview.sectionsInProfile,
  }
}

/** 切换结果 → 语义 kind（ok / failed / rolledBack；与同步 applyItemsReportView 语义一致）。 */
export function profileSwitchKind(result: ProfileSwitchResult | null): ProfileSwitchKind {
  if (result === null) return 'ok'
  if (!result.ok && result.rollback !== null) return 'rolledBack'
  if (!result.ok) return 'failed'
  return 'ok'
}