/**
 * C-1 Q4：会话 + 工作区 + 配置「三态同点」检查点与单命令回滚（最小可用版）。
 *
 * ## 口径（依据 outputs/competitor-recon-2026-10-05/read-checkpoint.md）
 * 竞品 dsh-checkpoint-rewind 的「三态」= **工作区文件 + 会话事件游标 + 插件自身 Config**
 * （不是 DSH 全局设置分区）；它在同一个 captureCheckpoint 内**顺序读取、非原子、无跨态锁**
 * （index.mjs:628 → :636 → :670）。**竞品自己都没做到「同点」。**
 * 因此本模块把「同点」做成**可核验的事实**：三态各自记录
 *   - capturedAt（捕获时刻，非回退的单调时间戳）
 *   - fingerprint（内容指纹）
 *   - spreadMs（三者 capturedAt 的最大跨度）
 * 并导出 samePointVerdictOf()：同一调用内顺序捕获 + 跨度 ≤ 容差 + 三态都可指纹 ⇒ samePoint=true。
 * 这比「喊同点」可验证，且不假装原子（DSH 不提供跨态原子性）。
 *
 * ## 三态各自的抓取点（严格照搬调研 W5 建议的捕获顺序）
 * 1. **会话游标**：会话日志的字节长度（游标）+ mtime + 内容指纹；≤ sessionMaxBytes 时把
 *    **字节副本**进对象仓（这才让「回滚到该游标」可用）。
 * 2. **工作区**：调用方显式给出的**路径分块**内的文件（内容寻址入仓）。本版不做全工作区
 *    字节镜像（下一轮），只做「显式路径分块」的最小可用版本。
 * 3. **本插件配置**：dataDir 下 self 分区白名单文件（sync-*.json / ui-prefs.json /
 *    market-config.json 等；清单见 CHECKPOINT_DEFAULT_CONFIG_FILES，与
 *    src/adapters/self.ts 的 SELF_CONFIG_FILES 对齐，由单测钉住不漏项）。
 *
 * ## 单命令回滚（rewind）与安全门（照搬竞品 index.mjs:1374-1627 的清单）
 * - **fail-closed 确认门**：confirm 必须**恰好** true；缺省 / 假值 / 字符串一律 denied，零写入。
 * - **记录可回滚性门**：protected: true（用户显式保护）→ 拒绝回滚；incomplete（三态有缺失）
 *   → 缺省拒绝（allowPartial: true 才放行）。
 * - **回滚前保护点（guard）**：先按同一分块拍一份当前状态（kind:'guard'），
 *   guardPolicy = require（拍不到就整体中止，零写入）/ warn（缺省，记 warning 继续）/ off。
 * - **覆盖恢复、绝不删除**：只写回捕获到的文件；检查点之后**新建**的文件只进 leftovers 报告，
 *   一个字节都不删（对称竞品「不用 git clean」）。捕获时**不存在**的配置项也绝不删除。
 * - **记录不可成为写原语**：写回前逐条校验「记录里的路径确实落在记录里的分块内」+ 对象仓内
 *   内容 SHA-256 必须与记录一致；路径越界 / 哈希不符一律拒绝该条（不写）。
 * - **逐段失败语义明确**（照搬竞品）：工作区**失败即中止**（不写配置、不动会话，
 *   并给「工作区可能已部分恢复」指引）；配置失败 → partial 但仍继续会话段；会话失败 → partial
 *   （工作区/配置已落）；全部成功 → restored；请求的段全部无事可做 → failed + nothing-to-restore。
 * - **会话侧两道门（都 fail-closed，都必给原因）**：① 静止期（日志在 sessionQuiescentMs 内被
 *   写过 → session-active，绝不覆盖正在追加的会话；<=0 表示关闭该门）；② 分叉（当前字节数
 *   小于捕获游标 → session-diverged，说明日志被别的路径改写/截断过，不是「捕获点之后的追加」）。
 *   写回对象是**逐字节原样**的捕获副本（不解析、不改写日志格式），且写回前把当前字节另存一份
 *   进对象仓 —— 既有内容绝不消失。
 * - **Windows 覆盖安全**：所有写回走 atomicWriteFile（临时文件 + rename 重试），
 *   且 symlink: 'reject'（目标被换成符号链接时响亮拒绝，不写到链接目标去）。
 *
 * ## 边界（会话日志 = 不透明字节流；本模块没有 DSH 存储格式知识）
 * 本模块把会话日志只当作**不透明字节流**：不解析多帧 zstd、不读首帧 cwd、不做 generation 归位，
 * 因此**不 import** utils/session-log.ts 与 utils/zstd-frame.ts（工具链纪律见 AGENTS.md：会话
 * 字节改写只允许在宿主侧的唯一实现里发生，core 不得把 DSH 存储格式带进引擎）。
 * 它做的事只有：记录字节长度（游标）+ 内容指纹，并把捕获副本原样写回。
 * 若将来需要任何**格式感知**（首帧 cwd 改写 / generation 归位 / 合成收尾块 / fork 或 seed 重放
 * 新子会话），**必须**把该段写路径挪到宿主注入的 seam 上（随 DSH sessions API 落地一并做，
 * 见调研 W4；本仓目前没有 sessions.fork / create({seed}) 调用面），core 只保留游标与指纹。
 * captain 裁决（2026-10-05）：本版「core 内写回字节副本」为**可接受的过渡**，待下一轮挪 seam。
 *
 * ## 降级纪律（照搬竞品 index.mjs:434-467，与本仓 Cordis 铁律同源）
 * 存储栈（对象仓 / 台账目录）不可用时**不抛错、不崩溃**：storageStatus() 返回
 * available:false + guidance[]（机器可读 code + 技术细节），捕获/回滚一律返回结构化失败。
 * 「保护检查点」有两个口径，都实现且都有单测：
 *   - protected: true（用户显式保护）：**不可回滚**、不可删除、不被自动清理。
 *   - kind: 'guard'（回滚前自动拍点）：不被自动清理、不可删除，但**可以**作为回滚目标
 *     —— 那正是「撤销一次回滚」的手段。
 *
 * ## i18n
 * 本模块**不产出任何用户可见文案**：一律返回机器可读 code / reasonCode（枚举）
 * 与**技术细节**（路径、errno、计数），由界面层映射字典键。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { atomicWriteFile } from '../utils/atomic-write.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { isRecord } from '../utils/guards.ts'
import { engineMsg } from './messages-core.ts'

/* ------------------------------------------------------------------ 常量 */

export const CHECKPOINT_SCHEMA_VERSION = 1
export const CHECKPOINTS_DIR_NAME = 'checkpoints'
export const CHECKPOINT_LEDGER_NAME = 'index.json'
export const CHECKPOINT_OBJECTS_DIR_NAME = 'objects'
/** 台账最多保留多少条（保护点 / guard 点不受此限，只进不出） */
export const CHECKPOINT_MAX_RECORDS = 50
export const CHECKPOINT_DEFAULT_MAX_FILES = 2000
export const CHECKPOINT_DEFAULT_MAX_BYTES = 64 * 1024 * 1024
/** 会话日志超过此大小则只记游标 + 弱指纹（内容副本进不了对象仓 ⇒ 该态不可回滚，给指引） */
export const CHECKPOINT_DEFAULT_SESSION_MAX_BYTES = 32 * 1024 * 1024
/** 会话静止期：日志在该窗口内被写过 → 拒绝写回（避免覆盖正在追加的会话） */
export const CHECKPOINT_DEFAULT_SESSION_QUIESCENT_MS = 30_000
/** 「同点」判定的缺省容差 */
export const CHECKPOINT_DEFAULT_SAME_POINT_TOLERANCE_MS = 5_000
export const CHECKPOINT_LEFTOVER_LIST_LIMIT = 20
export const CHECKPOINT_DETAIL_LIMIT = 50

/** 捕获顺序（W5：先固定会话游标 → 再拍工作区 → 最后落配置） */
export const CHECKPOINT_CAPTURE_ORDER = ['session', 'workspace', 'config'] as const
/** 回滚顺序（照搬竞品：工作区 → 配置 → 会话；前段失败即中止后续段） */
export const CHECKPOINT_REWIND_ORDER = ['workspace', 'config', 'session'] as const

/** 存储栈缺失时给出的组合指引（技术标识，非用户可见文案；界面按 code 映射字典键） */
export const CHECKPOINT_STORAGE_REQUIREMENTS: readonly string[] = [
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
]

/**
 * 本插件自身配置文件的缺省清单（相对 dataDir = $DSH_HOME/dsh-config-manager）。
 * 与 src/adapters/self.ts 的 SELF_CONFIG_FILES 同口径；checkpoint.test.ts 有一条
 * 「白名单不漏项」的断言直接比对两者（core 不反向 import adapters，避免层次倒挂）。
 */
export const CHECKPOINT_DEFAULT_CONFIG_FILES: readonly string[] = [
  'sync/sync-config.json',
  'sync/sync-autosync.json',
  'sync/sync-selection.json',
  'sync/ui-prefs.json',
  'sync/backup-schedule.json',
  'market/market-config.json',
  'exports/.backup-notes.json',
]

const MAX_WALK_DEPTH = 64
const OBJECT_KEY_RE = /^[0-9a-f]{64}$/

/* ------------------------------------------------------------------ 类型 */

export type CheckpointStateKind = 'workspace' | 'session' | 'config'
export type CheckpointKind = 'manual' | 'guard'
export type CheckpointOutcome = 'restored' | 'partial' | 'failed' | 'denied'
export type CheckpointSegmentStatus = 'restored' | 'skipped' | 'failed'
export type CheckpointGuardPolicy = 'require' | 'warn' | 'off'

/** 机器可读结果码（界面按字典键映射；本模块不产出用户可见文案）。 */
export type CheckpointCode =
  | 'ok'
  | 'storage-unavailable'
  | 'ledger-unreadable'
  | 'ledger-write-failed'
  | 'confirmation-required'
  | 'record-not-found'
  | 'protected-checkpoint'
  | 'record-incomplete'
  | 'guard-failed'
  | 'invalid-input'
  | 'no-chunks'
  | 'chunk-not-absolute'
  | 'chunk-not-found'
  | 'no-session-input'
  | 'session-missing'
  | 'session-out-of-root'
  | 'session-too-large'
  | 'session-active'
  | 'session-diverged'
  | 'capture-degraded'
  | 'capture-truncated'
  | 'capture-failed'
  | 'nothing-to-restore'
  | 'invalid-path'
  | 'object-missing'
  | 'object-hash-mismatch'
  | 'restore-failed'

/** 结构化指引 / 告警：code 供界面映射字典键，detail 是技术标识（路径 / errno / 计数）。 */
export interface CheckpointGuidance {
  code: string
  detail?: string
}

export interface CheckpointWorkspaceFile {
  /** 捕获时的绝对路径（恢复目标） */
  path: string
  /** 该文件所属的显式分块（chunks 里的一项） */
  chunk: string
  bytes: number
  sha256: string
  mtimeMs: number
  /** 对象仓键（= 内容 SHA-256） */
  object: string
}

export interface CheckpointSkippedEntry {
  path: string
  /** link（符号链接/junction，不跟随）/ missing / not-a-file / self-store */
  reason: string
}

export interface CheckpointWorkspacePayload {
  /** 显式路径分块：恢复只在这些分块内覆盖 */
  chunks: string[]
  files: CheckpointWorkspaceFile[]
  skipped: CheckpointSkippedEntry[]
  unreadableDirs: string[]
  unreadableFiles: CheckpointSkippedEntry[]
  /** 命中文件数 / 字节上限（内容未全部进来，已如实留痕） */
  truncated: boolean
  bytes: number
}

export interface CheckpointSessionPayload {
  sessionId: string | null
  /** 会话日志绝对路径（捕获时已 realpath，且必须落在 homeDir/sessions 内） */
  logPath: string
  /** 游标 = 捕获时的日志字节长度 */
  cursorBytes: number
  mtimeMs: number
  /** content = 内容 SHA-256（强）；size = 只认字节数（弱，超上限时诚实标注） */
  fingerprintKind: 'content' | 'size'
  fingerprint: string
  /** 内容副本的对象仓键；null = 超上限没进仓（该态不可回滚，给指引） */
  object: string | null
  bytes: number
}

export interface CheckpointConfigFile {
  /** 相对 dataDir 的 POSIX 路径 */
  relPath: string
  /** 捕获时是否存在（false ⇒ 回滚**绝不删除**现在可能存在的同名文件） */
  existed: boolean
  bytes: number
  sha256: string | null
  object: string | null
  mtimeMs: number | null
}

export interface CheckpointConfigPayload {
  baseDir: string
  files: CheckpointConfigFile[]
}

export interface CheckpointTrack<TPayload> {
  kind: CheckpointStateKind
  /** 捕获时刻（单调非回退）；「同点」的可核验依据 */
  capturedAt: number
  /** 该态是否捕获成功（游标 / 清单 / 指纹在） */
  ok: boolean
  /** 捕获成功但**不完整**（截断 / 链接跳过 / 内容副本缺失）—— 不静默 */
  degraded: boolean
  /** 该态的内容指纹；null = 没有可指纹的内容 */
  fingerprint: string | null
  reasonCode: CheckpointCode | null
  reasonDetail: string | null
  payload: TPayload | null
}

export interface CheckpointRecord {
  schemaVersion: number
  id: string
  kind: CheckpointKind
  createdAt: number
  /** 三态 capturedAt 的最大跨度（samePointVerdictOf 的输入之一） */
  spreadMs: number
  /** 用户显式保护：不可回滚、不可删除、不被自动清理 */
  protected: boolean
  /** 三态里有捕获失败的（回滚缺省拒绝，需显式 allowPartial） */
  incomplete: boolean
  note: string | null
  session: CheckpointTrack<CheckpointSessionPayload>
  workspace: CheckpointTrack<CheckpointWorkspacePayload>
  config: CheckpointTrack<CheckpointConfigPayload>
}

export interface CheckpointTrackSummary {
  state: CheckpointStateKind
  ok: boolean
  degraded: boolean
  capturedAt: number
  fingerprint: string | null
  reasonCode: CheckpointCode | null
  /** 该态捕获的条目数（工作区文件数 / 配置文件数 / 会话 0|1） */
  entries: number
  bytes: number
  /** 会话态：游标字节数；其它态 null */
  cursorBytes: number | null
  /** 该态是否**可回滚**（有内容副本 / 有可写回条目） */
  restorable: boolean
}

export interface CheckpointSummary {
  id: string
  kind: CheckpointKind
  createdAt: number
  spreadMs: number
  protected: boolean
  incomplete: boolean
  note: string | null
  tracks: CheckpointTrackSummary[]
}

export interface SamePointVerdict {
  samePoint: boolean
  spreadMs: number
  toleranceMs: number
  /** ok / incomplete（三态没全捕上）/ spread（跨度超容差） */
  reason: 'ok' | 'incomplete' | 'spread'
}

export interface CheckpointStorageStatus {
  available: boolean
  root: string
  detail?: string
  guidance: CheckpointGuidance[]
  requirements: readonly string[]
}

export interface CheckpointCaptureInput {
  /** 显式路径分块（绝对路径）；工作区态只覆盖这些分块 */
  chunks?: readonly string[]
  /** 会话日志绝对路径（必须落在 homeDir/sessions 内） */
  sessionLogPath?: string
  sessionId?: string
  kind?: CheckpointKind
  note?: string
  /** 用户显式保护：不可回滚、不可删除、不被自动清理 */
  protect?: boolean
}

export interface CheckpointCaptureResult {
  ok: boolean
  code: CheckpointCode
  detail?: string
  record?: CheckpointRecord
  spreadMs?: number
  guidance: CheckpointGuidance[]
  storage: CheckpointStorageStatus
}

export interface CheckpointSegmentResult {
  state: CheckpointStateKind
  status: CheckpointSegmentStatus
  reasonCode?: CheckpointCode
  /** 逐条事实（技术细节，非用户可见文案） */
  detail: string[]
  restored: number
  failed: number
  /** 检查点之后**新建**的内容：只报告，绝不删除 */
  leftovers: string[]
  leftoversTruncated: boolean
  writtenBytes?: number
  guidance?: CheckpointGuidance[]
}

export interface CheckpointRewindInput {
  id: string
  /** fail-closed 确认门：必须**恰好** true */
  confirm: boolean
  segments?: readonly CheckpointStateKind[]
  allowPartial?: boolean
  guardPolicy?: CheckpointGuardPolicy
}

export interface CheckpointRewindResult {
  ok: boolean
  outcome: CheckpointOutcome
  code: CheckpointCode
  detail?: string
  id: string
  segments: CheckpointSegmentResult[]
  /** 因前段失败 / 未请求而未执行的段 */
  skippedSegments: CheckpointStateKind[]
  guardCheckpointId?: string
  storage: CheckpointStorageStatus
  guidance: CheckpointGuidance[]
  warnings: CheckpointGuidance[]
}

export interface CheckpointPreviewSegment {
  state: CheckpointStateKind
  available: boolean
  reasonCode: CheckpointCode | null
  detail: string[]
  /** 将被写回（覆盖）的条目数 */
  planned: number
  /** 与当前内容不同、确实会被改动 */
  changed: number
  /** 记录里的文件当前已不存在（回滚会重新创建） */
  missing: number
  leftovers: string[]
  leftoversTruncated: boolean
  cursorNow?: number
  cursorTarget?: number
  mtimeAgoMs?: number
  active?: boolean
  guidance?: CheckpointGuidance[]
}

export interface CheckpointPreviewResult {
  ok: boolean
  code: CheckpointCode
  detail?: string
  id: string
  summary?: CheckpointSummary
  samePoint?: SamePointVerdict
  segments: CheckpointPreviewSegment[]
  storage: CheckpointStorageStatus
  guidance: CheckpointGuidance[]
  warnings: CheckpointGuidance[]
}

export interface CheckpointListResult {
  storage: CheckpointStorageStatus
  records: CheckpointSummary[]
  error?: string
  maxRecords: number
}

export interface CheckpointRemoveResult {
  ok: boolean
  code: CheckpointCode
  detail?: string
  id: string
}

export type CheckpointStorageProbe = () => Promise<{ ok: true } | { ok: false; detail: string }>

export interface CheckpointEngineOptions {
  /** 插件数据目录（= $DSH_HOME/dsh-config-manager）；检查点库在 dataDir/checkpoints */
  dataDir: string
  /** DSH home（会话根 = homeDir/sessions） */
  homeDir: string
  now?: () => number
  maxFiles?: number
  maxBytes?: number
  sessionMaxBytes?: number
  sessionQuiescentMs?: number
  samePointToleranceMs?: number
  maxRecords?: number
  configFiles?: readonly string[]
  guardPolicy?: CheckpointGuardPolicy
  /** 存储栈探针（缺省 = 真实磁盘探测）；注入失败探针可测「缺失时仍可挂载」 */
  storage?: CheckpointStorageProbe
  /** best-effort 日志（清理失败等；绝不抛给调用方） */
  log?: (line: string) => void
}

/* ------------------------------------------------------------ 纯函数/工具 */

function win32Fold(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** child 是否等于 parent 或位于其下（win32 折叠大小写；段边界判定） */
export function isInsidePath(child: string, parent: string): boolean {
  const c = win32Fold(path.resolve(child))
  const p = win32Fold(path.resolve(parent))
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** 路径比较键（win32 折叠大小写） */
function pathKey(value: string): string {
  return win32Fold(path.resolve(value))
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code + ': ' + error.message
    return error.message
  }
  return String(error)
}

function pushDetail(list: string[], line: string): void {
  if (list.length < CHECKPOINT_DETAIL_LIMIT) list.push(line)
}

function storageGuidance(root: string, detail: string): CheckpointGuidance[] {
  return [
    { code: 'checkpoint.guidance.mountStorage', detail: CHECKPOINT_STORAGE_REQUIREMENTS.join(' ') },
    { code: 'checkpoint.guidance.fixDataDir', detail: root },
    { code: 'checkpoint.guidance.readOnlyFallback' },
    { code: 'checkpoint.guidance.probeDetail', detail },
  ]
}

async function defaultStorageProbe(root: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await fs.mkdir(root, { recursive: true })
    const probe = path.join(root, '.dshcm-probe-' + String(process.pid) + '-' + Date.now().toString(36))
    await atomicWriteFile(probe, 'ok')
    await fs.readFile(probe, 'utf8')
    await fs.rm(probe, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: errorDetail(error) }
  }
}

function newCheckpointId(createdAt: number): string {
  return 'cp-' + createdAt.toString(36) + '-' + crypto.randomUUID().slice(0, 8)
}

export function samePointVerdictOf(
  record: CheckpointRecord,
  toleranceMs: number = CHECKPOINT_DEFAULT_SAME_POINT_TOLERANCE_MS,
): SamePointVerdict {
  const tracks = [record.session, record.workspace, record.config]
  const spreadMs = Math.max(...tracks.map((t) => t.capturedAt)) - Math.min(...tracks.map((t) => t.capturedAt))
  if (tracks.some((t) => !t.ok || t.fingerprint === null)) return { samePoint: false, spreadMs, toleranceMs, reason: 'incomplete' }
  if (spreadMs > toleranceMs) return { samePoint: false, spreadMs, toleranceMs, reason: 'spread' }
  return { samePoint: true, spreadMs, toleranceMs, reason: 'ok' }
}

export function summarizeCheckpoint(record: CheckpointRecord): CheckpointSummary {
  const track = <TPayload>(
    state: CheckpointStateKind,
    t: CheckpointTrack<TPayload>,
    entries: number,
    bytes: number,
    cursorBytes: number | null,
    restorable: boolean,
  ): CheckpointTrackSummary => ({
    state,
    ok: t.ok,
    degraded: t.degraded,
    capturedAt: t.capturedAt,
    fingerprint: t.fingerprint,
    reasonCode: t.reasonCode,
    entries,
    bytes,
    cursorBytes,
    restorable,
  })
  const workspace = record.workspace.payload
  const session = record.session.payload
  const config = record.config.payload
  const configFiles = config?.files ?? []
  return {
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    spreadMs: record.spreadMs,
    protected: record.protected,
    incomplete: record.incomplete,
    note: record.note,
    tracks: [
      track('workspace', record.workspace, workspace?.files.length ?? 0, workspace?.bytes ?? 0, null, (workspace?.files.length ?? 0) > 0),
      track('config', record.config, configFiles.filter((f) => f.existed).length, configFiles.reduce((sum, f) => sum + f.bytes, 0), null, configFiles.some((f) => f.existed)),
      track('session', record.session, session === null ? 0 : 1, session?.bytes ?? 0, session?.cursorBytes ?? null, session !== null && session.object !== null),
    ],
  }
}

/* ------------------------------------------------------------ 记录校验 */

function isTrack(value: unknown, kind: CheckpointStateKind): boolean {
  if (!isRecord(value)) return false
  if (value['kind'] !== kind) return false
  if (typeof value['capturedAt'] !== 'number' || !Number.isFinite(value['capturedAt'])) return false
  if (typeof value['ok'] !== 'boolean') return false
  return true
}

/** 浅层形状校验：台账被篡改 / 半写时不把它当记录用（宁可当「读不到」）。 */
export function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'] === '') return false
  if (typeof value['createdAt'] !== 'number' || !Number.isFinite(value['createdAt'])) return false
  if (value['kind'] !== 'manual' && value['kind'] !== 'guard') return false
  if (typeof value['spreadMs'] !== 'number') return false
  return isTrack(value['workspace'], 'workspace') && isTrack(value['session'], 'session') && isTrack(value['config'], 'config')
}

/* ------------------------------------------------------------------ 引擎 */

/** rewind 结果草稿（只在本文件内用于拼装结构化结果） */
interface CheckpointRewindDraft {
  outcome: CheckpointOutcome
  code: CheckpointCode
  detail?: string
  id: string
  segments?: CheckpointSegmentResult[]
  skippedSegments?: CheckpointStateKind[]
  guardCheckpointId?: string
  storage: CheckpointStorageStatus
  guidance?: CheckpointGuidance[]
  warnings?: CheckpointGuidance[]
}

export class CheckpointEngine {
  private readonly dataDir: string
  private readonly homeDir: string
  private readonly sessionsRoot: string
  private readonly root: string
  private readonly objectsDir: string
  private readonly ledgerPath: string
  private readonly nowFn: () => number
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly sessionMaxBytes: number
  private readonly sessionQuiescentMs: number
  private readonly samePointToleranceMs: number
  private readonly maxRecords: number
  private readonly configFiles: readonly string[]
  private readonly guardPolicy: CheckpointGuardPolicy
  private readonly probe: CheckpointStorageProbe | undefined
  private readonly log: ((line: string) => void) | undefined

  private lastStamp = 0

  constructor(options: CheckpointEngineOptions) {
    this.dataDir = path.resolve(options.dataDir)
    this.homeDir = path.resolve(options.homeDir)
    this.sessionsRoot = path.join(this.homeDir, 'sessions')
    this.root = path.join(this.dataDir, CHECKPOINTS_DIR_NAME)
    this.objectsDir = path.join(this.root, CHECKPOINT_OBJECTS_DIR_NAME)
    this.ledgerPath = path.join(this.root, CHECKPOINT_LEDGER_NAME)
    this.nowFn = options.now ?? (() => Date.now())
    this.maxFiles = options.maxFiles ?? CHECKPOINT_DEFAULT_MAX_FILES
    this.maxBytes = options.maxBytes ?? CHECKPOINT_DEFAULT_MAX_BYTES
    this.sessionMaxBytes = options.sessionMaxBytes ?? CHECKPOINT_DEFAULT_SESSION_MAX_BYTES
    this.sessionQuiescentMs = options.sessionQuiescentMs ?? CHECKPOINT_DEFAULT_SESSION_QUIESCENT_MS
    this.samePointToleranceMs = options.samePointToleranceMs ?? CHECKPOINT_DEFAULT_SAME_POINT_TOLERANCE_MS
    this.maxRecords = options.maxRecords ?? CHECKPOINT_MAX_RECORDS
    this.configFiles = options.configFiles ?? CHECKPOINT_DEFAULT_CONFIG_FILES
    this.guardPolicy = options.guardPolicy ?? 'warn'
    this.probe = options.storage
    this.log = options.log
  }

  /** 检查点库根目录（只读侦察用；写路径全部经本类的门） */
  get storeDir(): string {
    return this.root
  }

  private stamp(): number {
    const raw = this.nowFn()
    const value = Number.isFinite(raw) && raw > this.lastStamp ? raw : this.lastStamp
    this.lastStamp = value
    return value
  }

  private warn(line: string): void {
    try { this.log?.(line) } catch { /* 日志失败绝不影响主流程 */ }
  }

  /* ---------------------------------------------------------- 存储栈探针 */

  async storageStatus(): Promise<CheckpointStorageStatus> {
    const base = { root: this.root, requirements: CHECKPOINT_STORAGE_REQUIREMENTS }
    let result: { ok: true } | { ok: false; detail: string }
    if (this.probe !== undefined) {
      try {
        result = await this.probe()
      } catch (error) {
        result = { ok: false, detail: errorDetail(error) }
      }
    } else {
      result = await defaultStorageProbe(this.root)
    }
    if (result.ok) return { ...base, available: true, guidance: [] }
    return { ...base, available: false, detail: result.detail, guidance: storageGuidance(this.root, result.detail) }
  }

  /* -------------------------------------------------------------- 对象仓 */

  private async writeObjectWithHash(bytes: Uint8Array, sha: string): Promise<string> {
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('checkpoint object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('checkpoint object path escapes store')
    await fs.mkdir(this.objectsDir, { recursive: true })
    try {
      await fs.access(target)
      return sha
    } catch { /* 不存在才写（内容寻址天然去重） */ }
    await atomicWriteFile(target, bytes)
    return sha
  }

  private async writeObject(bytes: Uint8Array): Promise<string> {
    return await this.writeObjectWithHash(bytes, sha256Hex(bytes))
  }

  private async readObject(sha: string): Promise<Uint8Array> {
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('checkpoint object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('checkpoint object path escapes store')
    return await fs.readFile(target)
  }

  /* ------------------------------------------------------------ 捕获：态 */

  private emptyTrack<TPayload = never>(
    kind: CheckpointStateKind,
    capturedAt: number,
    code: CheckpointCode,
    detail: string | null,
  ): CheckpointTrack<TPayload> {
    return { kind, capturedAt, ok: false, degraded: false, fingerprint: null, reasonCode: code, reasonDetail: detail, payload: null }
  }

  private async captureSession(logPath: string | undefined, sessionId: string | null): Promise<CheckpointTrack<CheckpointSessionPayload>> {
    const capturedAt = this.stamp()
    if (typeof logPath !== 'string' || logPath === '') {
      return this.emptyTrack('session', capturedAt, 'no-session-input', engineMsg('core.checkpoint.sessionLogPathMissing'))
    }
    try {
      const realRoot = await fs.realpath(this.sessionsRoot).catch(() => undefined)
      const realLog = await fs.realpath(logPath).catch(() => undefined)
      if (realLog === undefined) return this.emptyTrack('session', capturedAt, 'session-missing', logPath)
      if (realRoot === undefined || !isInsidePath(realLog, realRoot)) {
        return this.emptyTrack('session', capturedAt, 'session-out-of-root', realLog)
      }
      const stat = await fs.stat(realLog)
      if (!stat.isFile()) return this.emptyTrack('session', capturedAt, 'session-missing', realLog)
      const cursorBytes = stat.size
      const mtimeMs = stat.mtimeMs
      if (cursorBytes > this.sessionMaxBytes) {
        const payload: CheckpointSessionPayload = {
          sessionId,
          logPath: realLog,
          cursorBytes,
          mtimeMs,
          fingerprintKind: 'size',
          fingerprint: 'size:' + String(cursorBytes),
          object: null,
          bytes: cursorBytes,
        }
        return {
          kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint,
          reasonCode: 'session-too-large', reasonDetail: realLog, payload,
        }
      }
      const bytes = await fs.readFile(realLog)
      const sha = sha256Hex(bytes)
      await this.writeObjectWithHash(bytes, sha)
      const payload: CheckpointSessionPayload = {
        sessionId, logPath: realLog, cursorBytes, mtimeMs,
        fingerprintKind: 'content', fingerprint: sha, object: sha, bytes: cursorBytes,
      }
      return { kind: 'session', capturedAt, ok: true, degraded: false, fingerprint: sha, reasonCode: null, reasonDetail: null, payload }
    } catch (error) {
      return this.emptyTrack('session', capturedAt, 'capture-failed', errorDetail(error))
    }
  }

  /**
   * 列出一个显式分块内的候选文件（不跟随符号链接 / junction；跳过与读不到都留痕）。
   * 返回 null = 该分块本身不可用（不存在 / 是链接 / 非常规文件），细节已写进 sink。
   */
  private async listChunkFiles(
    chunk: string,
    sink: { skipped: CheckpointSkippedEntry[]; unreadableDirs: string[] },
    limit: number,
  ): Promise<{ files: string[]; truncated: boolean } | null> {
    let stat
    try {
      stat = await fs.lstat(chunk)
    } catch {
      sink.skipped.push({ path: chunk, reason: 'missing' })
      return null
    }
    if (stat.isSymbolicLink()) {
      sink.skipped.push({ path: chunk, reason: 'link' })
      return null
    }
    if (stat.isFile()) return { files: [chunk], truncated: false }
    if (!stat.isDirectory()) {
      sink.skipped.push({ path: chunk, reason: 'not-a-file' })
      return null
    }
    const out: string[] = []
    let truncated = false
    const stack: { dir: string; depth: number }[] = [{ dir: chunk, depth: 0 }]
    while (stack.length > 0) {
      const item = stack.pop()
      if (item === undefined) break
      if (item.depth >= MAX_WALK_DEPTH) {
        sink.unreadableDirs.push(item.dir)
        continue
      }
      let entries
      try {
        entries = await fs.readdir(item.dir, { withFileTypes: true })
      } catch {
        sink.unreadableDirs.push(item.dir)
        continue
      }
      for (const entry of entries) {
        const full = path.join(item.dir, entry.name)
        if (entry.isSymbolicLink()) {
          sink.skipped.push({ path: full, reason: 'link' })
          continue
        }
        if (entry.isDirectory()) {
          stack.push({ dir: full, depth: item.depth + 1 })
          continue
        }
        if (!entry.isFile()) {
          sink.skipped.push({ path: full, reason: 'not-a-file' })
          continue
        }
        if (out.length >= limit) {
          truncated = true
          break
        }
        out.push(full)
      }
      if (truncated) break
    }
    out.sort()
    return { files: out, truncated }
  }

  private async captureWorkspace(chunks: readonly string[]): Promise<CheckpointTrack<CheckpointWorkspacePayload>> {
    const capturedAt = this.stamp()
    if (chunks.length === 0) return this.emptyTrack('workspace', capturedAt, 'no-chunks', engineMsg('core.checkpoint.chunksEmpty'))
    const payload: CheckpointWorkspacePayload = {
      chunks: [...chunks],
      files: [],
      skipped: [],
      unreadableDirs: [],
      unreadableFiles: [],
      truncated: false,
      bytes: 0,
    }
    let read = 0
    let sawChunk = false
    for (const chunk of chunks) {
      if (!path.isAbsolute(chunk)) return this.emptyTrack('workspace', capturedAt, 'chunk-not-absolute', chunk)
      const resolved = path.resolve(chunk)
      const listed = await this.listChunkFiles(resolved, payload, this.maxFiles - read + 1)
      if (listed === null) continue
      sawChunk = true
      if (listed.truncated) payload.truncated = true
      for (const file of listed.files) {
        if (read >= this.maxFiles || payload.bytes >= this.maxBytes) {
          payload.truncated = true
          break
        }
        if (isInsidePath(file, this.root)) {
          payload.skipped.push({ path: file, reason: 'self-store' })
          continue
        }
        try {
          const data = await fs.readFile(file)
          if (payload.bytes + data.byteLength > this.maxBytes && read > 0) {
            payload.truncated = true
            break
          }
          const sha = sha256Hex(data)
          await this.writeObjectWithHash(data, sha)
          const stat = await fs.stat(file)
          payload.files.push({ path: file, chunk: resolved, bytes: data.byteLength, sha256: sha, mtimeMs: stat.mtimeMs, object: sha })
          payload.bytes += data.byteLength
          read += 1
        } catch (error) {
          payload.unreadableFiles.push({ path: file, reason: errorDetail(error) })
        }
      }
      if (payload.truncated) break
    }
    if (!sawChunk && payload.files.length === 0) {
      return this.emptyTrack('workspace', capturedAt, 'chunk-not-found', chunks.join(' '))
    }
    const canonical = [...payload.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, f.bytes, f.sha256])
    const fingerprint = sha256Hex(JSON.stringify({ chunks: [...payload.chunks].sort(), files: canonical }))
    const degraded = payload.truncated
      || payload.skipped.length > 0
      || payload.unreadableDirs.length > 0
      || payload.unreadableFiles.length > 0
    return {
      kind: 'workspace', capturedAt, ok: true, degraded, fingerprint,
      reasonCode: payload.truncated ? 'capture-truncated' : degraded ? 'capture-degraded' : null,
      reasonDetail: degraded
        ? 'files=' + String(payload.files.length) + ' skipped=' + String(payload.skipped.length)
          + ' unreadableDirs=' + String(payload.unreadableDirs.length) + ' unreadableFiles=' + String(payload.unreadableFiles.length)
        : null,
      payload,
    }
  }

  private async captureConfig(): Promise<CheckpointTrack<CheckpointConfigPayload>> {
    const capturedAt = this.stamp()
    const payload: CheckpointConfigPayload = { baseDir: this.dataDir, files: [] }
    for (const raw of this.configFiles) {
      const rel = raw.replace(/\\/g, '/')
      const missing: CheckpointConfigFile = { relPath: rel, existed: false, bytes: 0, sha256: null, object: null, mtimeMs: null }
      if (rel.startsWith('/') || rel.split('/').includes('..')) {
        payload.files.push(missing)
        continue
      }
      const full = path.join(this.dataDir, rel)
      if (!isInsidePath(full, this.dataDir)) {
        payload.files.push(missing)
        continue
      }
      try {
        const stat = await fs.lstat(full)
        if (stat.isSymbolicLink() || !stat.isFile()) {
          payload.files.push(missing)
          continue
        }
        const data = await fs.readFile(full)
        const sha = sha256Hex(data)
        await this.writeObjectWithHash(data, sha)
        payload.files.push({ relPath: rel, existed: true, bytes: data.byteLength, sha256: sha, object: sha, mtimeMs: stat.mtimeMs })
      } catch {
        payload.files.push(missing)
      }
    }
    const canonical = [...payload.files]
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
      .map((f) => [f.relPath, f.existed, f.sha256])
    const fingerprint = sha256Hex(JSON.stringify({ baseDir: payload.baseDir, files: canonical }))
    return { kind: 'config', capturedAt, ok: true, degraded: false, fingerprint, reasonCode: null, reasonDetail: null, payload }
  }

  /* -------------------------------------------------------------- 台账 */

  private async readLedger(): Promise<{ records: CheckpointRecord[]; error?: string }> {
    let raw: string
    try {
      raw = await fs.readFile(this.ledgerPath, 'utf8')
    } catch (error) {
      // 不存在 = 首次使用（不是错误）；其它读失败如实回报
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return { records: [] }
      return { records: [], error: errorDetail(error) }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return { records: [], error: 'ledger shape invalid' }
      const list = parsed['records']
      if (!Array.isArray(list)) return { records: [], error: 'ledger.records invalid' }
      const records = list.filter(isCheckpointRecord)
      const skipped = list.length - records.length
      return skipped > 0 ? { records, error: 'ledger dropped ' + String(skipped) + ' invalid record(s)' } : { records }
    } catch (error) {
      return { records: [], error: 'ledger unreadable: ' + errorDetail(error) }
    }
  }

  private selectPrune(records: readonly CheckpointRecord[]): { kept: CheckpointRecord[]; removed: string[] } {
    const kept: CheckpointRecord[] = []
    for (const record of records) {
      // 保护点与 guard 点只进不出
      if (record.protected || record.kind === 'guard') kept.push(record)
    }
    const prunable = records
      .filter((r) => !r.protected && r.kind !== 'guard')
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
    const budget = Math.max(0, this.maxRecords - kept.length)
    kept.push(...prunable.slice(0, budget))
    const removed = prunable.slice(budget).map((r) => r.id)
    return { kept, removed }
  }

  private async gcObjects(records: readonly CheckpointRecord[]): Promise<void> {
    const referenced = new Set<string>()
    for (const record of records) {
      for (const file of record.workspace.payload?.files ?? []) referenced.add(file.object)
      for (const file of record.config.payload?.files ?? []) {
        if (file.object !== null) referenced.add(file.object)
      }
      const sessionObject = record.session.payload?.object
      if (sessionObject !== null && sessionObject !== undefined) referenced.add(sessionObject)
    }
    let names: string[]
    try {
      names = await fs.readdir(this.objectsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!OBJECT_KEY_RE.test(name) || referenced.has(name)) continue
      try {
        await fs.rm(path.join(this.objectsDir, name), { force: true })
      } catch (error) {
        this.warn('checkpoint gc failed: ' + name + ' ' + errorDetail(error))
      }
    }
  }

  private async appendRecord(record: CheckpointRecord): Promise<{ ok: boolean; detail?: string }> {
    const ledger = await this.readLedger()
    const merged = [record, ...ledger.records.filter((r) => r.id !== record.id)]
    const { kept } = this.selectPrune(merged)
    kept.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
    try {
      await fs.mkdir(this.root, { recursive: true })
      await atomicWriteFile(this.ledgerPath, JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, records: kept }, null, 2))
    } catch (error) {
      return { ok: false, detail: errorDetail(error) }
    }
    await this.gcObjects(kept)
    return { ok: true }
  }

  /* -------------------------------------------------------------- 捕获 */

  async capture(input: CheckpointCaptureInput = {}): Promise<CheckpointCaptureResult> {
    const storage = await this.storageStatus()
    if (!storage.available) {
      return { ok: false, code: 'storage-unavailable', detail: storage.detail, guidance: storage.guidance, storage }
    }
    const createdAt = this.stamp()
    const kind: CheckpointKind = input.kind === 'guard' ? 'guard' : 'manual'
    const chunks = (input.chunks ?? []).filter((c): c is string => typeof c === 'string' && c !== '')
    const session = await this.captureSession(input.sessionLogPath, input.sessionId ?? null)
    const workspace = await this.captureWorkspace(chunks)
    const config = await this.captureConfig()
    const stamps = [session.capturedAt, workspace.capturedAt, config.capturedAt]
    const spreadMs = Math.max(...stamps) - Math.min(...stamps)
    const record: CheckpointRecord = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      id: newCheckpointId(createdAt),
      kind,
      createdAt,
      spreadMs,
      protected: input.protect === true && kind !== 'guard',
      incomplete: !(session.ok && workspace.ok && config.ok),
      note: typeof input.note === 'string' && input.note !== '' ? input.note : null,
      session,
      workspace,
      config,
    }
    const stored = await this.appendRecord(record)
    if (!stored.ok) {
      return { ok: false, code: 'ledger-write-failed', detail: stored.detail, record, guidance: [], storage }
    }
    return { ok: true, code: 'ok', record, spreadMs, guidance: [], storage }
  }

  /* -------------------------------------------------------------- 列 / 读 */

  async list(): Promise<CheckpointListResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const records = [...ledger.records]
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
      .map(summarizeCheckpoint)
    const out: CheckpointListResult = { storage, records, maxRecords: this.maxRecords }
    if (ledger.error !== undefined) out.error = ledger.error
    return out
  }

  async read(id: string): Promise<{ record?: CheckpointRecord; records: CheckpointRecord[]; error?: string; storage: CheckpointStorageStatus }> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const record = ledger.records.find((r) => r.id === id)
    const out: { record?: CheckpointRecord; records: CheckpointRecord[]; error?: string; storage: CheckpointStorageStatus } = {
      records: ledger.records,
      storage,
    }
    if (record !== undefined) out.record = record
    if (ledger.error !== undefined) out.error = ledger.error
    return out
  }

  /* -------------------------------------------------------------- 预览 */

  /** 只读预览：零写入（不过确认门、不拍 guard、不写任何字节）。 */
  async preview(id: string): Promise<CheckpointPreviewResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const warnings: CheckpointGuidance[] = []
    if (ledger.error !== undefined) warnings.push({ code: 'checkpoint.warn.ledgerUnreadable', detail: ledger.error })
    const record = ledger.records.find((r) => r.id === id)
    if (!storage.available) {
      return { ok: false, code: 'storage-unavailable', detail: storage.detail, id, segments: [], storage, guidance: storage.guidance, warnings }
    }
    if (record === undefined) {
      return { ok: false, code: 'record-not-found', id, segments: [], storage, guidance: [], warnings }
    }
    const segments: CheckpointPreviewSegment[] = []
    for (const state of CHECKPOINT_REWIND_ORDER) {
      segments.push(await this.previewState(state, record))
    }
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)
    return {
      ok: true,
      code: 'ok',
      id,
      summary: summarizeCheckpoint(record),
      samePoint: samePointVerdictOf(record, this.samePointToleranceMs),
      segments,
      storage,
      guidance: [],
      warnings,
    }
  }

  private trackWarnings(record: CheckpointRecord): CheckpointGuidance[] {
    const out: CheckpointGuidance[] = []
    for (const track of [record.session, record.workspace, record.config]) {
      if (!track.ok) {
        out.push({ code: 'checkpoint.warn.trackMissing', detail: track.kind + ' ' + String(track.reasonCode ?? '') })
        continue
      }
      if (track.degraded && track.reasonCode !== null) {
        out.push({ code: 'checkpoint.warn.trackDegraded', detail: track.kind + ' ' + track.reasonCode })
      }
    }
    if (record.protected) out.push({ code: 'checkpoint.warn.protected', detail: record.id })
    return out
  }

  private async scanLeftovers(
    chunks: readonly string[],
    captured: ReadonlySet<string>,
    sink: { skipped: CheckpointSkippedEntry[]; unreadableDirs: string[] },
  ): Promise<{ leftovers: string[]; truncated: boolean; count: number }> {
    const limit = Math.max(this.maxFiles * 4, 2000)
    const leftovers: string[] = []
    let count = 0
    let truncated = false
    for (const chunk of chunks) {
      if (!path.isAbsolute(chunk)) continue
      const listed = await this.listChunkFiles(path.resolve(chunk), sink, limit)
      if (listed === null) continue
      for (const file of listed.files) {
        if (captured.has(pathKey(file))) continue
        count += 1
        if (leftovers.length < CHECKPOINT_LEFTOVER_LIST_LIMIT) leftovers.push(file)
      }
      if (listed.truncated) truncated = true
    }
    return { leftovers, truncated, count }
  }

  private async previewState(state: CheckpointStateKind, record: CheckpointRecord): Promise<CheckpointPreviewSegment> {
    const base: CheckpointPreviewSegment = {
      state,
      available: false,
      reasonCode: null,
      detail: [],
      planned: 0,
      changed: 0,
      missing: 0,
      leftovers: [],
      leftoversTruncated: false,
    }
    const sink = { skipped: [] as CheckpointSkippedEntry[], unreadableDirs: [] as string[] }
    if (state === 'workspace') {
      const track = record.workspace
      const payload = track.payload
      if (!track.ok || payload === null) return { ...base, reasonCode: track.reasonCode ?? 'capture-failed' }
      const captured = new Set(payload.files.map((f) => pathKey(f.path)))
      let changed = 0
      let missing = 0
      for (const file of payload.files) {
        let stat
        try {
          stat = await fs.stat(file.path)
        } catch {
          missing += 1
          continue
        }
        if (!stat.isFile() || stat.size !== file.bytes) {
          changed += 1
          continue
        }
        try {
          const current = await fs.readFile(file.path)
          if (sha256Hex(current) !== file.sha256) changed += 1
        } catch {
          changed += 1
        }
      }
      const leftovers = await this.scanLeftovers(payload.chunks, captured, sink)
      return {
        ...base,
        available: true,
        planned: payload.files.length,
        changed,
        missing,
        leftovers: leftovers.leftovers,
        leftoversTruncated: leftovers.truncated,
        detail: [
          'planned=' + String(payload.files.length),
          'changed=' + String(changed),
          'missing=' + String(missing),
          'leftovers=' + String(leftovers.count),
        ],
      }
    }
    if (state === 'config') {
      const track = record.config
      const payload = track.payload
      if (!track.ok || payload === null) return { ...base, reasonCode: track.reasonCode ?? 'capture-failed' }
      let changed = 0
      let missing = 0
      const leftovers: string[] = []
      for (const file of payload.files) {
        const full = path.join(payload.baseDir, file.relPath)
        let stat
        try {
          stat = await fs.stat(full)
        } catch {
          if (file.existed) missing += 1
          continue
        }
        if (!file.existed) {
          // 捕获时不存在、现在存在 ⇒ 只报告（回滚绝不删除）
          if (leftovers.length < CHECKPOINT_LEFTOVER_LIST_LIMIT) leftovers.push(file.relPath)
          continue
        }
        if (stat.size !== file.bytes) {
          changed += 1
          continue
        }
        try {
          const current = await fs.readFile(full)
          if (sha256Hex(current) !== (file.sha256 ?? '')) changed += 1
        } catch {
          changed += 1
        }
      }
      const planned = payload.files.filter((f) => f.existed).length
      return {
        ...base,
        available: true,
        planned,
        changed,
        missing,
        leftovers,
        detail: ['planned=' + String(planned), 'changed=' + String(changed), 'missing=' + String(missing), 'leftovers=' + String(leftovers.length)],
      }
    }
    const track = record.session
    const payload = track.payload
    if (!track.ok || payload === null) return { ...base, reasonCode: track.reasonCode ?? 'capture-failed' }
    let cursorNow: number
    let mtimeAgoMs: number
    try {
      const stat = await fs.stat(payload.logPath)
      cursorNow = stat.size
      mtimeAgoMs = this.nowFn() - stat.mtimeMs
    } catch {
      return { ...base, available: false, reasonCode: 'session-missing', detail: ['logPath=' + payload.logPath] }
    }
    const restorable = payload.object !== null
    const active = this.sessionQuiescentMs > 0 && mtimeAgoMs < this.sessionQuiescentMs
    const detail = [
      'cursorTarget=' + String(payload.cursorBytes),
      'cursorNow=' + String(cursorNow),
      'fingerprintKind=' + payload.fingerprintKind,
      'restorable=' + String(restorable),
      'active=' + String(active),
    ]
    const segment: CheckpointPreviewSegment = {
      ...base,
      available: true,
      reasonCode: restorable ? (active ? 'session-active' : null) : 'session-too-large',
      planned: restorable ? 1 : 0,
      changed: restorable && cursorNow !== payload.cursorBytes ? 1 : 0,
      cursorNow,
      cursorTarget: payload.cursorBytes,
      mtimeAgoMs,
      active,
      detail,
    }
    if (!restorable) segment.guidance = [{ code: 'checkpoint.guidance.sessionOffline', detail: payload.logPath }]
    return segment
  }

  /* -------------------------------------------------------------- 回滚 */

  private result(partial: CheckpointRewindDraft): CheckpointRewindResult {
    const out: CheckpointRewindResult = {
      ok: partial.outcome === 'restored',
      outcome: partial.outcome,
      code: partial.code,
      id: partial.id,
      segments: partial.segments ?? [],
      skippedSegments: partial.skippedSegments ?? [],
      storage: partial.storage,
      guidance: partial.guidance ?? [],
      warnings: partial.warnings ?? [],
    }
    if (partial.detail !== undefined) out.detail = partial.detail
    if (partial.guardCheckpointId !== undefined) out.guardCheckpointId = partial.guardCheckpointId
    return out
  }

  async rewind(input: CheckpointRewindInput): Promise<CheckpointRewindResult> {
    const warnings: CheckpointGuidance[] = []
    const storage = await this.storageStatus()
    if (!storage.available) {
      return this.result({ outcome: 'failed', code: 'storage-unavailable', detail: storage.detail, id: input.id, storage, guidance: storage.guidance })
    }
    const ledger = await this.readLedger()
    if (ledger.error !== undefined) warnings.push({ code: 'checkpoint.warn.ledgerUnreadable', detail: ledger.error })
    const record = ledger.records.find((r) => r.id === input.id)
    if (record === undefined) {
      return this.result({ outcome: 'failed', code: 'record-not-found', id: input.id, storage, warnings })
    }
    // 门 1（fail-closed 确认门）：必须恰好 true
    if (input.confirm !== true) {
      return this.result({ outcome: 'denied', code: 'confirmation-required', detail: 'confirm!==true', id: input.id, storage, warnings })
    }
    // 门 2：保护检查点不可回滚
    if (record.protected) {
      return this.result({ outcome: 'denied', code: 'protected-checkpoint', detail: record.id, id: input.id, storage, warnings })
    }
    // 门 3：三态不完整的记录缺省拒绝（allowPartial 才放行）
    if (record.incomplete && input.allowPartial !== true) {
      return this.result({ outcome: 'denied', code: 'record-incomplete', id: input.id, storage, warnings })
    }
    const requested = uniqueStates(input.segments ?? CHECKPOINT_REWIND_ORDER)
    if (requested.length === 0) {
      return this.result({ outcome: 'denied', code: 'invalid-input', detail: engineMsg('core.checkpoint.segmentsEmpty'), id: input.id, storage, warnings })
    }
    // 回滚前保护点（照搬竞品：先拍当前状态）
    const guardPolicy = input.guardPolicy ?? this.guardPolicy
    let guardCheckpointId: string | undefined
    if (guardPolicy !== 'off') {
      const sessionPayload = record.session.payload
      const guardInput: CheckpointCaptureInput = {
        kind: 'guard',
        chunks: record.workspace.payload?.chunks ?? [],
        note: 'pre-rewind guard for ' + record.id,
      }
      if (sessionPayload !== null) {
        guardInput.sessionLogPath = sessionPayload.logPath
        if (sessionPayload.sessionId !== null) guardInput.sessionId = sessionPayload.sessionId
      }
      const guard = await this.capture(guardInput)
      if (guard.record !== undefined && (guardPolicy !== 'require' || !guard.record.incomplete)) {
        guardCheckpointId = guard.record.id
      } else {
        const detail = guard.detail ?? guard.code
        if (guardPolicy === 'require') {
          return this.result({ outcome: 'failed', code: 'guard-failed', detail, id: input.id, storage, warnings })
        }
        warnings.push({ code: 'checkpoint.warn.guardFailed', detail })
      }
    }
    // 段：照搬顺序 + 工作区失败即中止
    const segments: CheckpointSegmentResult[] = []
    const skippedSegments: CheckpointStateKind[] = []
    let aborted = false
    for (const state of CHECKPOINT_REWIND_ORDER) {
      if (!requested.includes(state)) {
        skippedSegments.push(state)
        continue
      }
      if (aborted) {
        skippedSegments.push(state)
        continue
      }
      const segment = await this.restoreState(state, record)
      segments.push(segment)
      if (state === 'workspace' && segment.status === 'failed') aborted = true
    }
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)
    const anyFailed = segments.some((s) => s.status === 'failed')
    const workspaceFailed = segments.some((s) => s.state === 'workspace' && s.status === 'failed')
    const allSkipped = segments.length > 0 && segments.every((s) => s.status === 'skipped')
    let outcome: CheckpointOutcome
    let code: CheckpointCode
    if (workspaceFailed) {
      outcome = 'failed'
      code = 'restore-failed'
    } else if (allSkipped) {
      outcome = 'failed'
      code = 'nothing-to-restore'
    } else if (anyFailed || segments.some((s) => s.status === 'skipped')) {
      // 只按**本次请求并尝试过**的段判定：显式只请求一个段（或按 allowPartial 收窄范围）不算 partial，
      // 未请求 / 因前段失败而中止的段只在 skippedSegments 里如实列出。
      outcome = 'partial'
      code = anyFailed ? 'restore-failed' : 'ok'
    } else {
      outcome = 'restored'
      code = 'ok'
    }
    const guidance: CheckpointGuidance[] = []
    for (const segment of segments) {
      for (const item of segment.guidance ?? []) guidance.push(item)
    }
    if (workspaceFailed) guidance.push({ code: 'checkpoint.guidance.workspacePartial' })
    const payload: CheckpointRewindDraft = {
      outcome,
      code,
      id: input.id,
      segments,
      skippedSegments,
      storage,
      guidance,
      warnings,
    }
    if (guardCheckpointId !== undefined) payload.guardCheckpointId = guardCheckpointId
    return this.result(payload)
  }

  private async restoreState(state: CheckpointStateKind, record: CheckpointRecord): Promise<CheckpointSegmentResult> {
    if (state === 'workspace') return await this.restoreWorkspace(record.workspace)
    if (state === 'config') return await this.restoreConfig(record.config)
    return await this.restoreSession(record.session)
  }

  private emptySegment(state: CheckpointStateKind, code: CheckpointCode, detail: string): CheckpointSegmentResult {
    return { state, status: 'skipped', reasonCode: code, detail: [detail], restored: 0, failed: 0, leftovers: [], leftoversTruncated: false }
  }

  private async restoreWorkspace(track: CheckpointTrack<CheckpointWorkspacePayload>): Promise<CheckpointSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('workspace', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    if (payload.files.length === 0) return this.emptySegment('workspace', 'nothing-to-restore', 'files=0')
    const detail: string[] = []
    let restored = 0
    let failed = 0
    const captured = new Set(payload.files.map((f) => pathKey(f.path)))
    for (const file of payload.files) {
      // 门：记录里的路径必须落在记录里的分块内（记录不可成为写原语）
      const inChunk = payload.chunks.some((chunk) => path.isAbsolute(chunk) && isInsidePath(file.path, chunk))
      if (!path.isAbsolute(file.path) || !inChunk || isInsidePath(file.path, this.root)) {
        failed += 1
        pushDetail(detail, 'invalid-path ' + file.path)
        continue
      }
      try {
        const bytes = await this.readObject(file.object)
        if (sha256Hex(bytes) !== file.sha256) {
          failed += 1
          pushDetail(detail, 'object-hash-mismatch ' + file.path)
          continue
        }
        await atomicWriteFile(file.path, bytes, { symlink: 'reject' })
        restored += 1
      } catch (error) {
        failed += 1
        pushDetail(detail, 'restore-failed ' + file.path + ' ' + errorDetail(error))
      }
    }
    const sink = { skipped: [] as CheckpointSkippedEntry[], unreadableDirs: [] as string[] }
    const leftovers = await this.scanLeftovers(payload.chunks, captured, sink)
    detail.push('restored=' + String(restored) + ' failed=' + String(failed) + ' leftovers=' + String(leftovers.count))
    const segment: CheckpointSegmentResult = {
      state: 'workspace',
      status: failed > 0 ? 'failed' : 'restored',
      detail,
      restored,
      failed,
      leftovers: leftovers.leftovers,
      leftoversTruncated: leftovers.truncated,
    }
    if (failed > 0) segment.reasonCode = 'restore-failed'
    return segment
  }

  private normalizeRelPath(rel: string): string | null {
    const posix = rel.replace(/\\/g, '/')
    if (posix === '' || posix.startsWith('/') || posix.includes(':') || posix.split('/').includes('..')) return null
    return posix
  }

  private async restoreConfig(track: CheckpointTrack<CheckpointConfigPayload>): Promise<CheckpointSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('config', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    const planned = payload.files.filter((f) => f.existed)
    if (planned.length === 0) return this.emptySegment('config', 'nothing-to-restore', 'existed=0')
    const detail: string[] = []
    let restored = 0
    let failed = 0
    let writtenBytes = 0
    const leftovers: string[] = []
    let leftoversTruncated = false
    for (const file of payload.files) {
      const rel = this.normalizeRelPath(file.relPath)
      if (rel === null) {
        failed += 1
        pushDetail(detail, 'invalid-path ' + file.relPath)
        continue
      }
      const full = path.join(payload.baseDir, rel)
      if (!isInsidePath(full, payload.baseDir)) {
        failed += 1
        pushDetail(detail, 'invalid-path ' + file.relPath)
        continue
      }
      if (!file.existed) {
        // 捕获时不存在：**绝不删除**现在可能存在的文件，只报告
        try {
          await fs.lstat(full)
          if (leftovers.length < CHECKPOINT_LEFTOVER_LIST_LIMIT) leftovers.push(rel)
          else leftoversTruncated = true
        } catch { /* 仍然不存在 = 与捕获时一致，无需留痕 */ }
        continue
      }
      if (file.object === null || file.sha256 === null) {
        failed += 1
        pushDetail(detail, 'object-missing ' + file.relPath)
        continue
      }
      try {
        const bytes = await this.readObject(file.object)
        if (sha256Hex(bytes) !== file.sha256) {
          failed += 1
          pushDetail(detail, 'object-hash-mismatch ' + file.relPath)
          continue
        }
        await atomicWriteFile(full, bytes, { symlink: 'reject' })
        restored += 1
        writtenBytes += bytes.byteLength
      } catch (error) {
        failed += 1
        pushDetail(detail, 'restore-failed ' + file.relPath + ' ' + errorDetail(error))
      }
    }
    detail.push('restored=' + String(restored) + ' failed=' + String(failed) + ' leftovers=' + String(leftovers.length))
    const segment: CheckpointSegmentResult = {
      state: 'config',
      status: failed > 0 ? 'failed' : 'restored',
      detail,
      restored,
      failed,
      leftovers,
      leftoversTruncated,
      writtenBytes,
    }
    if (failed > 0) segment.reasonCode = 'restore-failed'
    return segment
  }

  private async restoreSession(track: CheckpointTrack<CheckpointSessionPayload>): Promise<CheckpointSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('session', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    if (payload.object === null) {
      const segment = this.emptySegment('session', 'session-too-large', 'object=null cursor=' + String(payload.cursorBytes))
      segment.guidance = [{ code: 'checkpoint.guidance.sessionOffline', detail: payload.logPath }]
      return segment
    }
    const realRoot = await fs.realpath(this.sessionsRoot).catch(() => undefined)
    const realLog = await fs.realpath(payload.logPath).catch(() => undefined)
    if (realLog === undefined) return this.emptySegment('session', 'session-missing', payload.logPath)
    if (realRoot === undefined || !isInsidePath(realLog, realRoot)) return this.emptySegment('session', 'session-out-of-root', realLog)
    const detail: string[] = []
    try {
      const stat = await fs.stat(realLog)
      const agoMs = this.nowFn() - stat.mtimeMs
      if (this.sessionQuiescentMs > 0 && agoMs < this.sessionQuiescentMs) {
        // 静止期门（fail-closed）：正在写的会话绝不覆盖（sessionQuiescentMs<=0 = 关闭该门）
        const segment = this.emptySegment('session', 'session-active', 'mtimeAgoMs=' + String(Math.round(agoMs)))
        segment.status = 'failed'
        return segment
      }
      if (stat.size < payload.cursorBytes) {
        // 分叉门（fail-closed）：当前日志比捕获游标还短 —— 说明它被别的路径改写 / 截断过，
        // 不是「捕获点之后的简单追加」。此时覆盖写回会抹掉一段来历不明的历史，一律拒绝。
        const segment = this.emptySegment('session', 'session-diverged', 'size=' + String(stat.size) + ' cursor=' + String(payload.cursorBytes))
        segment.status = 'failed'
        return segment
      }
      const bytes = await this.readObject(payload.object)
      if (payload.fingerprintKind === 'content' && sha256Hex(bytes) !== payload.fingerprint) {
        const segment = this.emptySegment('session', 'object-hash-mismatch', payload.logPath)
        segment.status = 'failed'
        return segment
      }
      // 回滚前把**当前**字节留一份进对象仓（零丢失：既有内容绝不消失）
      const current = await fs.readFile(realLog)
      const preserved = await this.writeObject(current)
      pushDetail(detail, 'preserved=' + preserved)
      await atomicWriteFile(realLog, bytes, { symlink: 'reject' })
      detail.push('cursorRestored=' + String(payload.cursorBytes) + ' bytes=' + String(bytes.byteLength))
      return {
        state: 'session',
        status: 'restored',
        detail,
        restored: 1,
        failed: 0,
        leftovers: [],
        leftoversTruncated: false,
        writtenBytes: bytes.byteLength,
        guidance: [{ code: 'checkpoint.guidance.sessionRewritten', detail: realLog }],
      }
    } catch (error) {
      const segment = this.emptySegment('session', 'restore-failed', errorDetail(error))
      segment.status = 'failed'
      return segment
    }
  }

  /* -------------------------------------------------------------- 删除 */

  /**
   * 删除一条检查点。保护点（protected）与 guard 点**一律拒绝**（「不删被保护点」），
   * 没有 force 后门。删除后会回收无人引用的对象（best-effort）。
   */
  async remove(id: string): Promise<CheckpointRemoveResult> {
    const storage = await this.storageStatus()
    if (!storage.available) return { ok: false, code: 'storage-unavailable', detail: storage.detail, id }
    const ledger = await this.readLedger()
    const record = ledger.records.find((r) => r.id === id)
    if (record === undefined) return { ok: false, code: 'record-not-found', id }
    if (record.protected || record.kind === 'guard') {
      return { ok: false, code: 'protected-checkpoint', detail: record.kind, id }
    }
    const kept = ledger.records.filter((r) => r.id !== id)
    try {
      await atomicWriteFile(this.ledgerPath, JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, records: kept }, null, 2))
    } catch (error) {
      return { ok: false, code: 'ledger-write-failed', detail: errorDetail(error), id }
    }
    await this.gcObjects(kept)
    return { ok: true, code: 'ok', id }
  }
}

function uniqueStates(states: readonly CheckpointStateKind[]): CheckpointStateKind[] {
  const out: CheckpointStateKind[] = []
  for (const state of states) {
    if ((state === 'workspace' || state === 'config' || state === 'session') && !out.includes(state)) out.push(state)
  }
  return out
}
