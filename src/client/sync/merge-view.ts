/**
 * 远程合并裁决（T-ui-merge）—— **纯渲染/裁决模型**。
 *
 * 为什么单独一个文件：仓库纪律要求「React 无组件框架 ⇒ 逻辑提炼到可 node 测的纯函数」，
 * 组件（MergePreviewView.tsx）只做装配。本文件除 type-only 引用与 redact 外零依赖：
 * 既能直接在 node:test 里跑，也不会把宿主 node 模块带进浏览器 bundle。
 *
 * 契约来源（两条新路由，见 src/routes/sync.ts）：
 *   POST /sync/merge-preview → MergePreviewResponse（只读三方合并预览）
 *   POST /sync/apply-merge   → MergeApplyResponse  （按逐项裁决执行）
 *
 * **裁决粒度 = 分区 id**（Lead 2026-10-18 冻结，不做 'id::path' 复合 id）：
 *   resolutions: Array<{ id: SectionId; action: 'keepLocal' | 'useRemote' | 'useMerged' | 'skip' }>
 *   - 'useMerged' 只对引擎回传 decision === 'merge' 的分区有效；conflict 分区必须禁用并写明原因；
 *   - 'skip' = **未解决**：引擎不推进远端基线，该分区进 pendingConflicts，界面必须如实说。
 *   冲突明细行只做展示（path + reason + 三列预览），动作按钮挂在分区行上。
 */
import { redact } from '../../security/redaction.ts'
import type { SyncKey } from './sync-locales.ts'
import type { MergeApplyResponse, MergePreviewResponse, MergePreviewSection } from './sync-api.ts'

/** 分区级合并决策（与 src/sync/merge.ts 的 MergeDecision + 'conflict' 同口径）。 */
export type MergeDecision = 'useRemote' | 'keepLocal' | 'merge' | 'skip' | 'conflict'

/** 单条裁决动作（与 /sync/apply-merge 的 body.resolutions[].action 同口径）。 */
export type MergeResolutionAction = 'keepLocal' | 'useRemote' | 'useMerged' | 'skip'

/** 徽章色调（对齐 common/ui.tsx 的 BadgeKind，避免为纯函数引入 .tsx 类型）。 */
export type MergeTone = 'ok' | 'info' | 'warn' | 'error'

/** 三列预览的截断长度（界面是 564px 画布里的三列，超长内容只会挤爆单元格）。 */
export const MERGE_PREVIEW_MAX_CHARS = 160

/** 决策 → 字典键（**禁止渲染裸枚举**：界面一律走这三个映射函数）。 */
const DECISION_KEY: Record<MergeDecision, SyncKey> = {
  useRemote: 'merge.decision.useRemote',
  keepLocal: 'merge.decision.keepLocal',
  merge: 'merge.decision.merge',
  skip: 'merge.decision.skip',
  conflict: 'merge.decision.conflict',
}

const DECISION_TONE: Record<MergeDecision, MergeTone> = {
  useRemote: 'info',
  keepLocal: 'info',
  merge: 'ok',
  skip: 'info',
  conflict: 'warn',
}

/** 冲突成因 → 字典键（缺省/未知一律按 both-modified 措辞，不渲染原值）。 */
const REASON_KEY: Record<string, SyncKey> = {
  'both-modified': 'merge.reason.bothModified',
  'modify-delete': 'merge.reason.modifyDelete',
  'delete-modify': 'merge.reason.deleteModify',
  'no-ancestor': 'merge.reason.noAncestor',
  'binary': 'merge.reason.binary',
  'format': 'merge.reason.format',
  'array': 'merge.reason.array',
  'section': 'merge.reason.section',
}

/**
 * 归一化分区决策：宿主回传的字符串可能是未来版本的新值，未知值一律按
 * **需要用户裁决**（conflict）处理 —— fail-closed，绝不把未知状态静默当「无变化」。
 */
export function normalizeDecision(value: unknown): MergeDecision {
  if (value === 'useRemote' || value === 'keepLocal' || value === 'merge' || value === 'skip' || value === 'conflict') return value
  return 'conflict'
}

/** 决策字典键。 */
export function mergeDecisionKey(decision: unknown): SyncKey {
  return DECISION_KEY[normalizeDecision(decision)]
}

/** 决策色调。 */
export function mergeDecisionTone(decision: unknown): MergeTone {
  return DECISION_TONE[normalizeDecision(decision)]
}

/** 冲突成因字典键（未知值 → both-modified 措辞）。 */
export function mergeReasonKey(reason: unknown): SyncKey {
  const key = typeof reason === 'string' ? REASON_KEY[reason] : undefined
  return key ?? 'merge.reason.bothModified'
}

/** 冲突位置类型字典键（key / file）。 */
export function mergeKindKey(kind: unknown): SyncKey {
  return kind === 'file' ? 'merge.kind.file' : 'merge.kind.key'
}

/**
 * 预览文本：先过 redact（仓库铁律：展示文本渲染前必须再脱敏一次），再截断。
 * 引擎已做过一次 redact + 2 KiB 截断，这里是**渲染侧**的第二次保险。
 */
export function truncatePreview(value: unknown, max: number = MERGE_PREVIEW_MAX_CHARS): string {
  if (value === undefined || value === null) return ''
  const text = redact(typeof value === 'string' ? value : String(value))
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/** 单条冲突的渲染行（**只读展示**：动作按钮在分区行上）。 */
export interface MergeConflictRow {
  path: string
  kindKey: SyncKey
  reasonKey: SyncKey
  localPreview: string
  remotePreview: string
  ancestorPreview: string
}

/** 单个分区的渲染行。 */
export interface MergeSectionRow {
  id: string
  decision: MergeDecision
  decisionKey: SyncKey
  tone: MergeTone
  /** 该分区是否需要用户裁决（decision === 'conflict'） */
  needsDecision: boolean
  conflictCount: number
  /** 自动合并并入的变更点数量（无统计 = null） */
  autoMerged: number | null
  /** 是否存在可用的自动合并结果（**只有 decision === 'merge' 才算**，Lead 冻结口径） */
  canUseMerged: boolean
  conflicts: MergeConflictRow[]
  /** 裁决单 id = 分区 id（分区级裁决，无复合 id） */
  resolutionId: string
}

/**
 * 分区是否存在可用的自动合并结果。
 *
 * **冻结判据**：只有引擎回传 decision === 'merge' 的分区有 merged 载荷；
 * conflict 分区一律 false —— 界面据此禁用「采用自动合并」并给出原因，
 * 而不是让用户点了才发现无效。
 */
function sectionCanUseMerged(decision: MergeDecision): boolean {
  return decision === 'merge'
}

/** 分区列表 → 渲染行（含冲突行）。sections 为 host 回传原样，顺序保持不变。 */
export function mergeSectionRows(preview: Pick<MergePreviewResponse, 'sections'> | null | undefined): MergeSectionRow[] {
  const sections = preview?.sections ?? []
  return sections.map((section: MergePreviewSection) => {
    const decision = normalizeDecision(section.decision)
    const conflicts = (section.conflicts ?? []).map((c) => ({
      path: c.path,
      kindKey: mergeKindKey(c.kind),
      reasonKey: mergeReasonKey(c.reason),
      localPreview: truncatePreview(c.localPreview),
      remotePreview: truncatePreview(c.remotePreview),
      ancestorPreview: truncatePreview(c.ancestorPreview),
    }))
    return {
      id: section.id,
      decision,
      decisionKey: DECISION_KEY[decision],
      tone: DECISION_TONE[decision],
      needsDecision: decision === 'conflict',
      conflictCount: typeof section.conflictCount === 'number' ? section.conflictCount : conflicts.length,
      autoMerged: typeof section.autoMerged === 'number' ? section.autoMerged : null,
      canUseMerged: sectionCanUseMerged(decision),
      conflicts,
      resolutionId: section.id,
    }
  })
}

/** 摘要项（可自动应用 / 待裁决 / 冲突 / 无变化）。 */
export interface MergeSummaryItem {
  labelKey: SyncKey
  value: number
  tone: MergeTone
}

/** 摘要 → 界面项（缺字段按 0，绝不显示 undefined）。 */
export function mergeSummaryItems(preview: MergePreviewResponse | null | undefined): MergeSummaryItem[] {
  const s = preview?.summary
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return [
    { labelKey: 'merge.summary.auto', value: num(s?.auto), tone: 'ok' },
    { labelKey: 'merge.summary.review', value: num(s?.review), tone: 'warn' },
    { labelKey: 'merge.summary.conflicts', value: num(s?.conflicts), tone: 'warn' },
    { labelKey: 'merge.summary.skipped', value: num(s?.skipped), tone: 'info' },
  ]
}

/** 裁决草稿：分区 id → 动作（缺省 = 未裁决）。 */
export type MergeResolutionDraft = Record<string, MergeResolutionAction>

/**
 * 初始草稿：**需要裁决的分区一律预置 skip（不动）**。
 *
 * 这是刻意的保守缺省：预览是只读的，用户不点任何东西时执行合并不得写坏任何分区；
 * 「跳过 ≠ 已解决」的常驻提示同时告诉用户 skip 不会推进同步基线。
 */
export function initialResolutionDraft(preview: Pick<MergePreviewResponse, 'sections'> | null | undefined): MergeResolutionDraft {
  const draft: MergeResolutionDraft = {}
  for (const row of mergeSectionRows(preview)) {
    if (row.needsDecision) draft[row.resolutionId] = 'skip'
  }
  return draft
}

/** 设置**分区级**裁决（分区 id 就是裁决单 id）。 */
export function setSectionAction(draft: MergeResolutionDraft, sectionId: string, action: MergeResolutionAction): MergeResolutionDraft {
  return { ...draft, [sectionId]: action }
}

/** 批量类型。 */
export type MergeBulkAction = MergeResolutionAction | 'autoOnly'

/**
 * 批量裁决：
 *  - keepLocal / useRemote：对**每个需要裁决的分区**写它的分区级动作；
 *  - useMerged：只对**存在可用自动合并结果**的分区写（其余保持原样，不静默改成别的动作）；
 *  - autoOnly（仅处理无冲突项）：把所有需要裁决的分区显式置 skip，交给引擎只应用无冲突分区。
 */
export function applyBulkResolution(
  preview: Pick<MergePreviewResponse, 'sections'> | null | undefined,
  draft: MergeResolutionDraft,
  bulk: MergeBulkAction,
): MergeResolutionDraft {
  let next: MergeResolutionDraft = { ...draft }
  for (const row of mergeSectionRows(preview)) {
    if (bulk === 'autoOnly') {
      // 只把**需要裁决**的分区置 skip；无冲突分区交给引擎自动应用（不写多余裁决单）
      if (row.needsDecision) next = setSectionAction(next, row.id, 'skip')
      continue
    }
    if (bulk === 'useMerged') {
      // 冻结口径：只有 decision === 'merge' 的分区有 merged 载荷，其余不因批量操作被改写
      if (!row.canUseMerged) continue
      next = setSectionAction(next, row.id, 'useMerged')
      continue
    }
    // keepLocal / useRemote：批量语义就是「所有分区都按这一侧」，覆盖含自动决策在内的全部分区
    next = setSectionAction(next, row.id, bulk)
  }
  return next
}

/** 裁决 → 请求体（排序保证同输入同请求，便于日志与测试比对）。 */
export function buildMergeResolutions(draft: MergeResolutionDraft): Array<{ id: string; action: MergeResolutionAction }> {
  return Object.entries(draft)
    .map(([id, action]) => ({ id, action }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 裁决计数（执行前确认摘要用）。 */
export interface MergeDecisionCounts {
  /** 需要裁决的分区数 */
  needsDecision: number
  /** 已给出显式裁决的分区数（含 skip） */
  decided: number
  /** 尚未出现在草稿里的分区数 */
  undecided: number
  /** 被判为 skip 的分区数（**未解决**，不会推进同步基线） */
  skipped: number
  /** 待裁决分区里的冲突条目总数 */
  conflictItems: number
}

/** 统计草稿覆盖面：把「已裁决 / 未裁决 / 跳过」讲清楚（诚实性：skip 不算解决）。 */
export function mergeDecisionCounts(
  preview: Pick<MergePreviewResponse, 'sections'> | null | undefined,
  draft: MergeResolutionDraft,
): MergeDecisionCounts {
  let needsDecision = 0
  let decided = 0
  let skipped = 0
  let conflictItems = 0
  for (const row of mergeSectionRows(preview)) {
    if (!row.needsDecision) continue
    needsDecision++
    conflictItems += row.conflicts.length > 0 ? row.conflicts.length : row.conflictCount
    const own = draft[row.resolutionId]
    if (own === undefined) continue
    decided++
    if (own === 'skip') skipped++
  }
  return { needsDecision, decided, undecided: needsDecision - decided, skipped, conflictItems }
}

/** 是否至少有一条**会产生写入**的裁决（全 skip = 无事可做，主按钮应禁用并说明）。 */
export function hasWritableResolution(draft: MergeResolutionDraft): boolean {
  return Object.values(draft).some((action) => action !== 'skip')
}

/** 合并执行结果 → 渲染视图。 */
export interface MergeResultView {
  ok: boolean
  applied: string[]
  skipped: string[]
  warnings: string[]
  restoreId: string | null
  rolledBack: boolean
  /** 整体回滚是否完整（null = 旧宿主未回传，不得当成「完整」） */
  rollbackFull: boolean | null
  pendingConflicts: string[]
  failedCount: number
  ineffectiveCount: number
  /** 执行后**仍有**待裁决冲突分区（下次同步仍会出现） */
  hasPendingConflicts: boolean
}

/** 结果归一化（字段缺失按 0 / 空数组处理，绝不显示 undefined）。 */
export function mergeResultView(result: MergeApplyResponse | null | undefined): MergeResultView | null {
  if (result === null || result === undefined) return null
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const pending = list(result.pendingConflicts)
  return {
    ok: result.ok === true,
    applied: list(result.applied),
    skipped: list(result.skipped),
    warnings: list(result.warnings),
    restoreId: typeof result.restoreId === 'string' && result.restoreId !== '' ? result.restoreId : null,
    rolledBack: result.rolledBack === true,
    rollbackFull: result.rollbackFull === undefined ? null : result.rollbackFull === true,
    pendingConflicts: pending,
    failedCount: Array.isArray(result.failed) ? result.failed.length : 0,
    ineffectiveCount: Array.isArray(result.ineffective) ? result.ineffective.length : 0,
    hasPendingConflicts: pending.length > 0,
  }
}

/** 无共同基准时的降级提示是否需要显示（只读判断，不猜）。 */
export function needsNoAncestorNotice(preview: MergePreviewResponse | null | undefined): boolean {
  return preview !== null && preview !== undefined && preview.hasAncestor === false
}
