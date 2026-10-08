/**
 * checkpoint（会话 / 工作区 / 插件配置「三态同点」检查点）的**展示模型**（框架无关纯函数，node 可测）。
 *
 * 数据来自宿主 /recovery/checkpoints 族的 6 条只读/写入子路径（list / storage / capture / <id>/preview /
 * <id>/rewind / <id>/delete；第 7 条 <id> 单条详情本轮没有消费者，故不进端口 —— 预览已带回 summary 与同点判定）。
 *
 * 三条纪律：
 *  ① **不 import src/core/checkpoint.ts** —— 那个模块经 node:fs 依赖宿主运行时，一旦进 client bundle，
 *     DSH loader 会报 missed the module table（见 AGENTS.md 的 client bundle 铁律）。因此这里按「线协议
 *     结构子集」重新声明类型（与 core 的 CheckpointSummary / Preview / RewindResult 结构兼容，字段只取展示所需）。
 *  ② **本模块不产出任何用户可见文案**：只回传字典键（checkpoint.*，zh/en 已齐 + 本轮补界面特有键）。
 *  ③ **未知码/未知态回落 unknown 键，绝不裸渲染机器码**；用户自由文本（note）与宿主技术细节（detail）
 *     一律先过 redact()（AGENTS.md UI 硬性规则 7）。
 */
import { redact } from '../security/redaction.ts'
import type { SessionHealthResponse } from './session-inventory-view.ts'

/* ------------------------------------------------------------ 线协议类型（结构子集） */

export type CheckpointState = 'workspace' | 'session' | 'config'
export type CheckpointKind = 'manual' | 'guard'
export type CheckpointOutcome = 'restored' | 'partial' | 'failed' | 'denied'
export type CheckpointSegmentStatus = 'restored' | 'skipped' | 'failed'

/** 结构化指引 / 告警：code → 字典键，detail 是技术标识（路径 / errno / 计数）。 */
export interface CheckpointGuidance { code: string; detail?: string }

export interface CheckpointTrackSummary {
  state: CheckpointState
  ok: boolean
  degraded: boolean
  capturedAt: number
  reasonCode: string | null
  entries: number
  bytes: number
  cursorBytes: number | null
  restorable: boolean
}

export interface CheckpointSummary {
  id: string
  kind: string
  createdAt: number
  spreadMs: number
  protected: boolean
  incomplete: boolean
  note: string | null
  tracks: CheckpointTrackSummary[]
}

export interface CheckpointStorageStatus {
  available: boolean
  root: string
  detail?: string
  guidance: CheckpointGuidance[]
  requirements: readonly string[]
}

export interface CheckpointListResult {
  storage: CheckpointStorageStatus
  records: CheckpointSummary[]
  error?: string
  maxRecords: number
}

export interface CheckpointCaptureInput {
  /** 工作区显式路径分块（绝对路径；每行一个由界面拆分） */
  chunks?: readonly string[]
  /** 关联会话（unitId；路由会解析成会话根内的真实日志，解析不出来一律 400 不猜） */
  unitId?: string
  note?: string
  protect?: boolean
}

export interface CheckpointCaptureResult {
  ok: boolean
  code: string
  detail?: string
  spreadMs?: number
  guidance: CheckpointGuidance[]
  storage: CheckpointStorageStatus
}

export interface CheckpointPreviewSegment {
  state: CheckpointState
  available: boolean
  reasonCode: string | null
  detail: string[]
  planned: number
  changed: number
  missing: number
  leftovers: string[]
  leftoversTruncated: boolean
  cursorNow?: number
  cursorTarget?: number
  mtimeAgoMs?: number
  active?: boolean
  guidance?: CheckpointGuidance[]
}

export interface CheckpointSamePointVerdict {
  samePoint: boolean
  spreadMs: number
  toleranceMs: number
  reason: string
}

export interface CheckpointPreviewResult {
  ok: boolean
  code: string
  detail?: string
  id: string
  summary?: CheckpointSummary
  samePoint?: CheckpointSamePointVerdict
  segments: CheckpointPreviewSegment[]
  storage: CheckpointStorageStatus
  guidance: CheckpointGuidance[]
  warnings: CheckpointGuidance[]
}

export interface CheckpointSegmentResult {
  state: CheckpointState
  status: string
  reasonCode?: string
  detail: string[]
  restored: number
  failed: number
  leftovers: string[]
  leftoversTruncated: boolean
  writtenBytes?: number
  guidance?: CheckpointGuidance[]
}

export interface CheckpointRewindResult {
  ok: boolean
  outcome: string
  code: string
  detail?: string
  id: string
  segments: CheckpointSegmentResult[]
  skippedSegments: CheckpointState[]
  guardCheckpointId?: string
  storage: CheckpointStorageStatus
  guidance: CheckpointGuidance[]
  warnings: CheckpointGuidance[]
}

export interface CheckpointRemoveResult { ok: boolean; code: string; detail?: string; id: string }

/** 端口：由 src/client/recovery/recovery-api.ts 实现（Partial 消费，缺失时界面如实说能力缺失）。 */
export interface CheckpointPort {
  checkpoints(): Promise<CheckpointListResult>
  checkpointStorage(): Promise<CheckpointStorageStatus>
  captureCheckpoint(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult>
  previewCheckpoint(id: string): Promise<CheckpointPreviewResult>
  rewindCheckpoint(id: string, opts: { confirm: boolean; segments?: readonly CheckpointState[]; allowPartial?: boolean }): Promise<CheckpointRewindResult>
  removeCheckpoint(id: string): Promise<CheckpointRemoveResult>
}

/* ------------------------------------------------------------ 字典键映射（绝不裸渲染） */

const STATE_KEYS: Record<CheckpointState, string> = {
  workspace: 'checkpoint.state.workspace',
  session: 'checkpoint.state.session',
  config: 'checkpoint.state.config',
}

export const CHECKPOINT_STATE_UNKNOWN_KEY = 'checkpoint.state.unknown'
export const CHECKPOINT_CODE_UNKNOWN_KEY = 'checkpoint.code.unknown'
export const CHECKPOINT_GUIDANCE_UNKNOWN_KEY = 'checkpoint.guidance.unknown'

/** 段名 → 字典键（未知段回落 unknown，绝不裸渲染）。 */
export function checkpointStateKey(state: string): string {
  return (STATE_KEYS as Record<string, string>)[state] ?? CHECKPOINT_STATE_UNKNOWN_KEY
}

/** 机器码 → 字典键（checkpoint.code.* 已覆盖引擎全部码；未知回落 unknown）。 */
export function checkpointCodeKey(code: string | null | undefined): string {
  if (typeof code !== 'string' || code === '') return CHECKPOINT_CODE_UNKNOWN_KEY
  return 'checkpoint.code.' + code
}

/** 指引 / 告警：code → checkpoint.guidance.*，detail 过 redact。 */
export function checkpointGuidanceRows(items: readonly CheckpointGuidance[] | undefined): { key: string; detail: string | null }[] {
  return (items ?? []).map((item) => ({
    key: typeof item.code === 'string' && item.code !== '' ? 'checkpoint.guidance.' + item.code : CHECKPOINT_GUIDANCE_UNKNOWN_KEY,
    detail: item.detail !== undefined && item.detail !== '' ? redact(item.detail) : null,
  }))
}

/* ------------------------------------------------------------ 列表 → 展示行 */

export interface CheckpointTrackView {
  state: CheckpointState
  labelKey: string
  /** ok = 正常；warn = 捕获不完整（degraded）；error = 没捕到 / 失败 */
  badgeKind: 'ok' | 'warn' | 'error'
  entries: number
  restorable: boolean
  reasonKey: string | null
}

export interface CheckpointRowView {
  id: string
  kind: CheckpointKind
  kindKey: string
  createdAtMs: number
  note: string | null
  protected: boolean
  incomplete: boolean
  spreadMs: number
  tracks: CheckpointTrackView[]
  /** 至少有一段可回滚、且未保护、且三态齐全 —— 界面据此决定「回滚」按钮可用性 */
  rewindable: boolean
  /** 保护点与 guard 点不可删（引擎侧同样拒绝） */
  removable: boolean
}

function trackView(track: CheckpointTrackSummary): CheckpointTrackView {
  const badgeKind: 'ok' | 'warn' | 'error' = track.ok ? (track.degraded ? 'warn' : 'ok') : 'error'
  return {
    state: track.state,
    labelKey: checkpointStateKey(track.state),
    badgeKind,
    entries: track.entries,
    restorable: track.restorable,
    reasonKey: track.ok ? null : checkpointCodeKey(track.reasonCode),
  }
}

/** 列表 → 展示行（台账已按时间倒序；本函数只做映射与判定，不重排）。 */
export function checkpointRows(list: CheckpointListResult | null): CheckpointRowView[] {
  if (list === null) return []
  return list.records.map((record) => {
    const tracks = record.tracks.map(trackView)
    return {
      id: record.id,
      kind: record.kind === 'guard' ? 'guard' : 'manual',
      kindKey: record.kind === 'guard' ? 'checkpoint.kind.guard' : 'checkpoint.kind.manual',
      createdAtMs: record.createdAt,
      note: record.note !== null && record.note !== '' ? redact(record.note) : null,
      protected: record.protected,
      incomplete: record.incomplete,
      spreadMs: record.spreadMs,
      tracks,
      rewindable: record.protected !== true && record.incomplete !== true && tracks.some((track) => track.restorable),
      removable: record.protected !== true,
    }
  })
}

/* ------------------------------------------------------------ 预览 → 展示行 */

export interface CheckpointPreviewRowView {
  state: CheckpointState
  labelKey: string
  available: boolean
  reasonKey: string | null
  planned: number
  changed: number
  missing: number,
  leftovers: number
  leftoversTruncated: boolean
  cursorNow: number | null
  cursorTarget: number | null
  /** 会话段：日志刚被写过（静止期门会拒绝回滚） */
  active: boolean
  guidance: { key: string; detail: string | null }[]
}

export function checkpointPreviewRows(preview: CheckpointPreviewResult | null): CheckpointPreviewRowView[] {
  if (preview === null) return []
  return preview.segments.map((segment) => ({
    state: segment.state,
    labelKey: checkpointStateKey(segment.state),
    available: segment.available === true,
    reasonKey: segment.available === true ? null : checkpointCodeKey(segment.reasonCode),
    planned: segment.planned,
    changed: segment.changed,
    missing: segment.missing,
    leftovers: segment.leftovers.length,
    leftoversTruncated: segment.leftoversTruncated === true,
    cursorNow: segment.cursorNow ?? null,
    cursorTarget: segment.cursorTarget ?? null,
    active: segment.active === true,
    guidance: checkpointGuidanceRows(segment.guidance),
  }))
}

/** 预览里「可回滚」的段（勾选默认值：全选可回滚段）。 */
export function checkpointDefaultSegments(preview: CheckpointPreviewResult | null): CheckpointState[] {
  if (preview === null) return []
  return preview.segments.filter((segment) => segment.available === true).map((segment) => segment.state)
}

/**
 * 同点判定 → 字典键 + 插值（list 不带判定，只有预览/详情带）。
 * reason 也是**机器枚举**（ok / incomplete / spread），因此同样只回传字典键，绝不裸渲染。
 */
export function checkpointSamePoint(preview: CheckpointPreviewResult | null): { key: string; ms: string; reasonKey: string } | null {
  const verdict = preview?.samePoint
  if (verdict === undefined || verdict === null) return null
  const reason = verdict.reason === 'incomplete' ? 'incomplete' : verdict.reason === 'spread' ? 'spread' : 'ok'
  return {
    key: verdict.samePoint === true ? 'checkpoint.samePoint.yes' : 'checkpoint.samePoint.no',
    ms: String(verdict.spreadMs),
    reasonKey: 'checkpoint.samePoint.reason.' + reason,
  }
}

/* ------------------------------------------------------------ 回滚结果 → 展示行 */

export interface CheckpointRewindRowView {
  state: CheckpointState
  labelKey: string
  statusKey: string
  badgeKind: 'ok' | 'warn' | 'error'
  restored: number
  failed: number
  leftovers: number
  leftoversTruncated: boolean
  detail: string[]
  guidance: { key: string; detail: string | null }[]
}

export function checkpointRewindRows(result: CheckpointRewindResult | null): CheckpointRewindRowView[] {
  if (result === null) return []
  return result.segments.map((segment) => {
    const status = segment.status === 'restored' ? 'restored' : segment.status === 'skipped' ? 'skipped' : 'failed'
    return {
      state: segment.state,
      labelKey: checkpointStateKey(segment.state),
      statusKey: 'checkpoint.segment.' + status,
      badgeKind: status === 'restored' ? 'ok' : status === 'skipped' ? 'warn' : 'error',
      restored: segment.restored,
      failed: segment.failed,
      leftovers: segment.leftovers.length,
      leftoversTruncated: segment.leftoversTruncated === true,
      detail: segment.detail.map((line) => redact(line)),
      guidance: checkpointGuidanceRows(segment.guidance),
    }
  })
}

/** 回滚总体结论 → 字典键 + 徽章语义（unknown 回落 unknown）。 */
export function checkpointOutcome(outcome: string | null | undefined): { key: string; badgeKind: 'ok' | 'warn' | 'error' } {
  if (outcome === 'restored') return { key: 'checkpoint.outcome.restored', badgeKind: 'ok' }
  if (outcome === 'partial') return { key: 'checkpoint.outcome.partial', badgeKind: 'warn' }
  if (outcome === 'failed' || outcome === 'denied') return { key: 'checkpoint.outcome.' + outcome, badgeKind: 'error' }
  return { key: 'checkpoint.outcome.unknown', badgeKind: 'error' }
}

/* ------------------------------------------------------------ 会话选择（复用会话体检的 rows） */

export interface CheckpointSessionOption {
  unitId: string
  sessionId: string
  /** 该会话的 cwd（可一键填入工作区分块；缺失则不填，绝不猜） */
  cwd: string | null
  mtimeMs: number | null
}

/** 会话体检响应 → 捕获表单的会话候选项（按最近活动倒序；无 mtime 的排最后）。 */
export function checkpointSessionOptions(response: SessionHealthResponse | null): CheckpointSessionOption[] {
  if (response === null) return []
  return response.rows
    .map((row) => ({
      unitId: row.unitId,
      sessionId: row.sessionId,
      cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null,
      mtimeMs: row.mtimeMs ?? null,
    }))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
}

/** 指定会话的 cwd（找不到 / 没记录 → null，绝不猜）。 */
export function checkpointSessionCwd(options: readonly CheckpointSessionOption[], unitId: string): string | null {
  if (unitId === '') return null
  return options.find((option) => option.unitId === unitId)?.cwd ?? null
}

/* ------------------------------------------------------------ 捕获表单输入 → 引擎输入 */

/** 多行文本 → 绝对路径分块：逐行 trim、去空行、**去重**（同一路径重复只会让引擎白扫一遍）。 */
export function checkpointChunksFromText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

export const CHECKPOINT_MAX_RECORDS_HINT = 50
