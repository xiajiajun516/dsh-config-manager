/**
 * 工作区 + 会话回滚点引擎（t1：把「三态同点检查点」改写为「工作区 + 会话回滚」）。
 *
 * ## 口径（S1–S8）
 * - **S1 自动留点**：不再有手动「拍点」表单，也没有 capture 子路径。宿主订阅
 *   `session/event`，每见到一个 `turn/end` 就为**当前会话**留一个回滚点 =
 *   工作区快照（内容寻址入对象仓）+ 会话游标（事件数 / 字节长度 / fork 边界）。
 * - **S2 两态**：只有 `workspace` 与 `session`。**没有** config 第三态，**没有**
 *   `samePointVerdictOf`（两态之间没有「同点」可判；`spreadMs` 只作为诚实事实回传）。
 * - **S3 会话回退 = fork 子会话**：在**目标回合开始前的稳定边界**（boundarySeq =
 *   该回合 `turn/start` 事件的 seq − 1）用 `ctx.sessions.fork(source, boundary, childId?)`
 *   切一个子会话；**原会话日志只读、绝不改写**（这与旧版「逐字节写回日志」相反，
 *   旧版的静止期门 / 分叉门 / 字节副本写回因此全部下线）。结果回传 `childSessionId`。
 *   fork 由宿主注入的 seam 提供（core 不 import @deepseek-ai/* —— 架构边界）。
 * - **S4 工作区恢复 = 只覆盖记录在案的路径**：写回前先做**只读校验**（路径必须落在
 *   记录里的分块内 + 对象仓内容 SHA-256 必须与记录一致），任何一条不合格 →
 *   **零写入**整体失败。**绝不删除**未记录文件、也绝不删除回滚点之后新建的文件
 *   （它们只进 leftovers 报告）。
 *   **捕获边界口径（t13 冻结）**：单文件上限 `maxFileBytes`（缺省 = 总量预算 `maxBytes`）**先 stat 判大小**，
 *   超限就跳过、绝不整份读进内存；文件数预算（maxFiles）与字节预算（maxBytes）耗尽时其后**每一条**都进
 *   `skipped` 并带原因（`too-large` / `budget-bytes` / `budget-files`）；`skipped` 列表记录上限
 *   `maxSkippedEntries`（缺省 5000）只影响**记录条数**，超出只计数 + 置 `skippedTruncated`，
 *   `skippedCount` 仍是跳过事件总数、如实回传 —— **绝不静默丢弃，也不整点丢弃**。
 * - **S5 安全链**：只读预览（零写入）→ 二次确认（`userConfirmed` 必须**恰好** true，
 *   否则 `confirmation-required`）→ 恢复前自动留**救援点**（guard）→ 写回 →
 *   **T10：救援点的成败判据是「台账真的写进去了」（`appendRecord` 成功）**，不是「拿到了内存 record」：
 *   写失败时 `require` 档整体中止（`guard-failed`、零写入），`warn` 档只告警继续且**不报** `guardPointId`。
 *   **逐文件重新读回并核对 SHA-256**；任一不符或任一写失败 → **整体回滚到恢复前状态**
 *   （把每个被触碰文件写回前像；本来不存在的就删掉我们刚创建的那个）→ 结构化失败。
 *   写路径由路由层过 withMutationLock + SAFE MODE（引擎不持锁）。
 *   **准入判定只有一份口径（t22）**：回退只拒 `protected`（不可回退）与 `incomplete`（需显式
 *   `allowPartial`）；`kind:'guard'` 的救援点**可以**作为回退目标 —— 它是「回到回退前那一刻」的
 *   唯一路径。`canRestore`（能否回退）与 `canRemove`（能否删除，排除 guard）**互相独立**。
 * - **S6 留存（t14 冻结口径）**：自动点每会话最多 `maxRecordsPerSession`（缺省 20）、全局最多
 *   `maxRecords`（缺省 50），**只删最旧的自动点**。`kind:'guard'` 的救援点（回退前自动留）
 *   **不占**自动点预算、**不受** 20/50 淘汰，也**不被用户删除**（`remove` 一律 `protected-point`）
 *   —— 因此它有**自己的**上限 `maxGuardsPerSession`（`ROLLBACK_MAX_GUARDS_PER_SESSION`，缺省 20，
 *   每会话只保留最近 N 个、超出淘汰最旧的 guard），否则反复回退会无界增长。
 *   `protected:true` 的点仍「只进不出」（生产路径造不出来：capture 端点已下线、tracker 不设 protect）。
 *
 * ## 机器可读、零用户可见文案
 * 本模块只回 code / reasonCode（枚举）与技术细节（路径、errno、计数）；用户可见文案一律
 * 由界面层按字典键映射。code → HTTP 的映射在路由层 `rollbackHttpStatus`。
 *
 * ## 会话日志是不透明字节流
 * 本模块不解析会话日志格式（不读首帧、不做 generation 归位）：会话态只记录
 * sessionId / 事件游标 / 字节数 / 内容指纹，**且只在容量允许时**把字节副本放进对象仓
 * （仅为审计证据；回退不依赖它）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { atomicWriteFile } from '../utils/atomic-write.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { isRecord } from '../utils/guards.ts'
import { EXCLUDED_DEP_DIR_NAMES } from '../utils/recursive-walk.ts'
import { diffLines, type DiffHunk } from '../utils/line-diff.ts'
import { projectKeyOf } from './session-select.ts'

/* ------------------------------------------------------------------ 常量 */

export const ROLLBACK_SCHEMA_VERSION = 2
/** 回滚点库目录名（dataDir/rollback-points）——路由族 /recovery/rollback-points/* 同源 */
export const ROLLBACK_POINTS_DIR_NAME = 'rollback-points'
export const ROLLBACK_LEDGER_NAME = 'index.json'
export const ROLLBACK_OBJECTS_DIR_NAME = 'objects'
/** 全局自动点上限（S6）；protected / guard 点不占预算、只进不出 */
export const ROLLBACK_MAX_RECORDS = 50
/** 每会话自动点上限（S6） */
export const ROLLBACK_MAX_RECORDS_PER_SESSION = 20
/**
 * 每会话 **guard 点**上限（S6 的显式例外，t14 冻结）：guard 是「回退前自动救援点」，
 * 用户无法手动删除（remove 一律回 protected-point），所以**必须**有自己的上限，
 * 否则反复回退会让台账无界增长。超过上限时只淘汰**最旧的 guard**（每会话各自计）。
 *
 * 与 20/50 的关系：guard **不占**自动点预算、也**不**被自动点的 20/50 淘汰；
 * 反过来自动点也不会因 guard 的淘汰而受影响。protected 点（只有测试能造出来 ——
 * capture 端点已下线、tracker 从不设 protect）仍保持「只进不出」。
 */
export const ROLLBACK_MAX_GUARDS_PER_SESSION = 20
export const ROLLBACK_DEFAULT_MAX_FILES = 2000
export const ROLLBACK_DEFAULT_MAX_BYTES = 64 * 1024 * 1024
/** 单文件上限（缺省 = 总量预算）：超限文件**先 stat 判大小后跳过**，绝不整份读进内存 */
export const ROLLBACK_DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
/** skipped / excludedDirs 列表的**记录条数**上限：超出只计数 + 置 skippedTruncated（计数仍如实回传） */
export const ROLLBACK_SKIPPED_LIST_LIMIT = 5000
/** 会话日志超过此大小则只记游标 + 弱指纹（字节副本不进对象仓） */
export const ROLLBACK_DEFAULT_SESSION_MAX_BYTES = 32 * 1024 * 1024
/** 预览里「该会话日志刚被写过」的窗口（仅供提示；fork 只读，不再据此拒绝） */
export const ROLLBACK_DEFAULT_SESSION_QUIESCENT_MS = 30_000
/** 轮询回退的间隔上界（S1：会话日志 mtime ≤5 s 轮询） */
export const ROLLBACK_DEFAULT_POLL_INTERVAL_MS = 5_000
export const ROLLBACK_LEFTOVER_LIST_LIMIT = 20

/**
 * 「删除回退点之后新建的路径」的**整套上限**（用户 2026-10-11 定案 A）。
 * 超过就整套拒绝（fail-closed），绝不删一半 —— 半套删除既没有可解释的状态，也无法整体回滚。
 */
export const ROLLBACK_MAX_CREATED_REMOVALS = 5000
export const ROLLBACK_DETAIL_LIMIT = 50

/**
 * E1：预览里「逐文件行级统计」的规模上限。四条**只影响** `workspace.files[].added/removed`：
 * 触到任一条的条目仍然照给 status，但 added/removed 置 null 且 truncated=true ——
 * **宁可说「不知道」，也绝不谎报行数**。
 *
 * 为什么需要：预览要读「快照对象 + 当前文件」两份内容再做行级 diff，而一个点的记录可能有上千条目；
 * 没有上限时一次预览就能把宿主的 I/O 与 CPU 拖住。
 * - 单文件 1 MiB：单条目的读写/解码都钉在一个小上限内（绝大多数源码文件远小于它）；
 * - 单张预览累计 32 MiB：与捕获期字节预算（`ROLLBACK_DEFAULT_MAX_BYTES`）同量级；
 * - 单文件 8e6 步 / 单张预览 32e6 步：行级 diff 是 Myers O((N+M)·D)，步数上限就是时间上限
 *   （32e6 步在毫秒~百毫秒量级），避免「大文件被整篇改写」这种最坏情形把请求拖死。
 */
export const ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES = 1024 * 1024
export const ROLLBACK_PREVIEW_DIFF_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const ROLLBACK_PREVIEW_DIFF_MAX_WORK = 8_000_000
export const ROLLBACK_PREVIEW_DIFF_TOTAL_WORK = 32_000_000
/**
 * 单文件前后对照（fileDiff）的展示上限：
 *  · maxFileBytes 与预览行数统计**同一档**（同一份数据不该有两个口径）；
 *  · context = 变更块外保留的上下文行数（3，与 git unified diff 一致）。
 * 超限时的行为是**说「看不了」**（结构化 reason + 空 hunks），绝不截半截差异。
 */
export const ROLLBACK_FILE_DIFF_LIMITS = {
  maxFileBytes: ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES,
  context: 3,
} as const

/** 恢复顺序（工作区在前；工作区失败即中止后面的会话段） */
export const ROLLBACK_REWIND_ORDER = ['workspace', 'session'] as const

/** 存储栈缺失时给出的组合指引（技术标识；界面按 code 映射字典键） */
export const ROLLBACK_STORAGE_REQUIREMENTS: readonly string[] = [
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
]

const MAX_WALK_DEPTH = 64
const OBJECT_KEY_RE = /^[0-9a-f]{64}$/

/* ------------------------------------------------------------------ 类型 */

export type RollbackStateKind = 'workspace' | 'session'
/**
 * auto = 回合自动留点；guard = 恢复前自动救援点（用户不可删、不占自动点的 20/50 预算，
 * 但受 `maxGuardsPerSession` 自身上限约束、可作为回退目标 —— 见 ROLLBACK_MAX_GUARDS_PER_SESSION）。
 */
export type RollbackPointKind = 'auto' | 'guard'
export type RollbackOutcome = 'restored' | 'partial' | 'failed' | 'denied'
export type RollbackSegmentStatus = 'restored' | 'skipped' | 'failed'
export type RollbackGuardPolicy = 'require' | 'warn' | 'off'
/** mode 三选一（S5/S7）；显式 segments 优先于 mode */
export type RollbackMode = 'files+session' | 'files' | 'session'

/**
 * 机器可读结果码。**冻结集**（wire contract，必须严格保用）：
 * ok / deleted / confirmation-required / protected-point / record-not-found /
 * record-incomplete / invalid-input / no-boundary / storage-unavailable /
 * mutation-locked / method-not-allowed。
 * 其余为**内部分级码**：只出现在 segments[].reasonCode / warnings / detail，
 * 顶层 code 只用冻结集（例外：`restore-failed`、`guard-failed`、`ledger-write-failed`，
 * 前端按「未知码回落 unknown」处理）。
 */
export type RollbackCode =
  | 'ok'
  | 'deleted'
  | 'storage-unavailable'
  | 'ledger-unreadable'
  | 'ledger-write-failed'
  | 'confirmation-required'
  | 'record-not-found'
  | 'protected-point'
  | 'record-incomplete'
  | 'invalid-input'
  | 'no-boundary'
  | 'guard-failed'
  | 'invalid-path'
  | 'object-missing'
  | 'object-hash-mismatch'
  | 'restore-failed'
  | 'verify-failed'
  | 'nothing-to-restore'
  /**
   * T10：该态**没有记录任何文件**（工作区段 files=0）—— 与「有记录但全部已一致」严格分开：
   * 界面必须说两句不同的话（「这点没记录文件」vs「工作区已与该点一致」），
   * 而 `detail` 是技术细节、**不能**当用户可见分派依据。只出现在 segments[].reasonCode。
   */
  | 'no-recorded-files'
  | 'mutation-locked'
  | 'method-not-allowed'
  | 'session-missing'
  | 'session-out-of-root'
  | 'session-too-large'
  | 'session-active'
  | 'session-fork-unavailable'
  | 'fork-failed'
  | 'capture-failed'
  | 'capture-truncated'
  | 'capture-degraded'
  | 'no-chunks'
  | 'chunk-not-absolute'
  | 'chunk-not-found'
  /** 单文件差异：该路径**不在**这个回滚点的记录里（收窄：绝不把本端点做成任意路径读取器）。 */
  | 'file-not-recorded'

/** 结构化指引 / 告警：code 供界面映射字典键，detail 是技术标识（路径 / errno / 计数）。 */
export interface RollbackGuidance {
  code: string
  detail?: string
}

export interface RollbackWorkspaceFile {
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

export interface RollbackSkippedEntry {
  path: string
  /**
   * link（符号链接/junction，不跟随）/ missing / not-a-file / self-store /
   * dep-dir（运行时依赖目录，整棵忽略）/ too-large（超单文件上限）/
   * budget-bytes（加它会超总量预算）/ budget-files（文件数预算用尽）
   */
  reason: string
}

export interface RollbackWorkspacePayload {
  /** 显式路径分块：恢复只在这些分块内覆盖 */
  chunks: string[]
  files: RollbackWorkspaceFile[]
  skipped: RollbackSkippedEntry[]
  /**
   * 整棵跳过的「运行时依赖目录」（忽略规则 = 全仓唯一来源 EXCLUDED_DEP_DIR_NAMES，当前 node_modules）。
   * 与 skipped 分开：这是**预期的忽略**（不是降级），所以不计入 degraded，但必须留痕。
   */
  excludedDirs: RollbackSkippedEntry[]
  unreadableDirs: string[]
  unreadableFiles: RollbackSkippedEntry[]
  /**
   * `skipped` 桶的跳过事件**总数**（含超出 maxSkippedEntries 只计数的那部分）。
   * 不含 excludedDirs —— 那是预期内的忽略（如 node_modules），逐条记在 `excludedDirs` 里、
   * 不使该点降级。语义：逐条列表 + 本计数都必须实话实说，谁也不许静默。
   */
  skippedCount: number
  /** `skipped` 逐条列表到达记录上限（skippedCount 仍然如实） */
  skippedTruncated: boolean
  /** 命中文件数 / 字节上限（内容未全部进来，已如实留痕） */
  truncated: boolean
  bytes: number
}

export interface RollbackSessionPayload {
  sessionId: string | null
  /** 会话日志绝对路径（宿主能给就给；缺失 = null —— 本引擎不做字节写回，路径只作审计） */
  logPath: string | null
  /** 会话游标（**事件数** = session.seq）：fork 的语义位置 */
  cursorSeq: number | null
  /** 会话日志字节数（能 stat 到才有；审计证据） */
  cursorBytes: number | null
  mtimeMs: number | null
  /** content = 内容 SHA-256；size = 只认字节数（超上限）；cursor = 只有事件游标 */
  fingerprintKind: 'content' | 'size' | 'cursor'
  fingerprint: string
  /** 内容副本的对象仓键；null = 没有副本（回退不依赖它，fork 走 sessionId + boundarySeq） */
  object: string | null
  bytes: number
  /** 目标回合（1 基）；未知 = null */
  turnSeq: number | null
  /** 目标回合开始前最后一个事件 seq（fork 的 inclusive 稳定边界）；null = 无前置边界 */
  boundarySeq: number | null
  /** 目标回合 turn/end 事件的 seq（inclusive）；未知 = null */
  boundaryEndSeq: number | null
}

export interface RollbackTrack<TPayload> {
  kind: RollbackStateKind
  /** 捕获时刻（单调非回退） */
  capturedAt: number
  ok: boolean
  /** 捕获成功但**不完整**（截断 / 链接跳过 / 内容副本缺失）—— 不静默 */
  degraded: boolean
  /** 该态的内容指纹；null = 没有可指纹的内容 */
  fingerprint: string | null
  reasonCode: RollbackCode | null
  reasonDetail: string | null
  payload: TPayload | null
}

export interface RollbackPointRecord {
  schemaVersion: number
  id: string
  kind: RollbackPointKind
  createdAt: number
  /** 两态 capturedAt 的跨度（诚实事实；两态之间没有「同点」判定） */
  spreadMs: number
  /** 用户显式保护：不可回退、不可删除、不被自动清理 */
  protected: boolean
  /** 有态捕获失败的（回退缺省拒绝，需显式 allowPartial） */
  incomplete: boolean
  note: string | null
  /** 归属会话（自动留点必有；无会话信息 = null） */
  sessionId: string | null
  /** 会话单元键 <projectKey>/<sessionId>（界面展示 / 归属） */
  unitId: string | null
  /** 目标回合（1 基） */
  turnSeq: number | null
  /** 目标回合开始前最后一个事件 seq（fork 边界） */
  boundarySeq: number | null
  workspace: RollbackTrack<RollbackWorkspacePayload>
  session: RollbackTrack<RollbackSessionPayload>
}

export interface RollbackSegmentSummary {
  state: RollbackStateKind
  ok: boolean
  degraded: boolean
  capturedAt: number
  fingerprint: string | null
  reasonCode: RollbackCode | null
  /** 该态捕获的条目数（工作区文件数 / 会话 0|1） */
  entries: number
  bytes: number
  /** 会话态：事件游标；其它态 null */
  cursorBytes: number | null
  /** 该态是否**可回退**（工作区有可写回条目 / 会话有 sessionId + 边界） */
  restorable: boolean
  /** 跳过事件总数（工作区态：skipped + excludedDirs；会话态恒 0） */
  skippedCount: number
  /** 该态捕获是否被上限截断（工作区态 = payload.truncated） */
  truncated: boolean
}

export interface RollbackPointSummary {
  id: string
  createdAt: number
  sessionId: string | null
  unitId: string | null
  /** 1 基回合号；无法判定 = null */
  turn: number | null
  /** fork 的 inclusive 边界 seq；null = 无前置边界 */
  boundarySeq: number | null
  kind: RollbackPointKind
  protected: boolean
  incomplete: boolean
  note: string | null
  spreadMs: number
  /** 恒为 [workspace, session] 两项 */
  segments: RollbackSegmentSummary[]
}

export interface RollbackStorageStatus {
  available: boolean
  root: string
  detail?: string
  guidance: RollbackGuidance[]
  requirements: readonly string[]
}

/** 捕获一个回滚点的输入（宿主/测试构造；无 HTTP capture 端点） */
export interface RollbackPointInput {
  kind?: RollbackPointKind
  sessionId?: string | null
  unitId?: string | null
  sessionLogPath?: string | null
  /** 会话事件游标（session.seq） */
  cursorSeq?: number | null
  /** 目标回合（1 基） */
  turnSeq?: number | null
  /** 目标回合开始前最后一个事件 seq */
  boundarySeq?: number | null
  /** 目标回合 turn/end 的 seq */
  boundaryEndSeq?: number | null
  /** 工作区显式路径分块（绝对路径） */
  chunks?: readonly string[]
  note?: string | null
  protect?: boolean
}

export interface RollbackCaptureResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  point?: RollbackPointRecord
  guidance: RollbackGuidance[]
  storage: RollbackStorageStatus
}

/** 会话 fork seam（宿主注入；core 不 import @deepseek-ai/*） */
export interface RollbackForkInput {
  sessionId: string
  /** inclusive 边界 seq */
  boundarySeq: number
}
export type RollbackForkOutcome =
  /**
   * 成功 fork。`warning` 非空 = 子会话**没能挂回原工作区**（宿主侧三档匹配全落空），
   * 它会出现在侧栏「未分组」—— 回退本身仍然成功，但必须如实告诉用户（绝不假装已归位）。
   */
  | { ok: true; childSessionId: string; warning?: string }
  | { ok: false; code: RollbackCode; detail?: string }
export type RollbackForkSeam = (input: RollbackForkInput) => Promise<RollbackForkOutcome>
/** 宿主侧的 fork 载体（DshSessionStoreFacade 结构性实现；路由侧只做窄化读取） */
export interface RollbackForkCarrier {
  forkSession?: (sessionId: string, boundarySeq: number) => Promise<{ childSessionId: string; warning?: string } | { error: string }>
}

/** 预览里「回退会改动的一个文件」的动作。 */
export type RollbackPreviewFileStatus = 'overwrite' | 'create' | 'delete'

/**
 * E1：逐文件的行级统计（简洁版预览弹窗的数据源）。
 * **只列真的会被改动的文件** —— 已与快照一致的条目一个都不列（353 项里 0 项不同 ⇒ 空数组）。
 */
export interface RollbackPreviewFile {
  path: string
  /**
   * overwrite = 覆盖已有文件；create = 当前不存在（回退会重新创建）。
   * `delete` **当前永远不会出现**：回退只覆盖记录在案的路径，绝不删除任何文件
   * （未记录与该点之后新建的文件只进 leftovers 报告）—— 保留该取值只为契约形状向前兼容。
   */
  status: RollbackPreviewFileStatus
  /** 回退会让该文件**新增**的行数；null = 本次不给数字（见 truncated） */
  added: number | null
  /** 回退会从该文件**删除**的行数；null = 本次不给数字（见 truncated） */
  removed: number | null
  /**
   * true = 本次没有可信行数（added/removed 均为 null）：任一侧超过单文件上限、单张预览累计上限、
   * 行级比对步数上限，或内容不是文本，或对象仓读不出，或**当前文件 stat 失败但不是 ENOENT**
   * （存在性未知 —— 这种条目 status 仍给 'overwrite'，绝不谎报成 create）。
   * **宁可说「不知道」，也绝不谎报行数。**
   */
  truncated: boolean
}

/** 单文件差异里一侧（当前磁盘 / 回退点快照）的展示信息。 */
export interface RollbackFileDiffSide {
  /** 该侧当前存在吗（快照侧 false = 对象仓里那份读不出来，**不是**「空文件」） */
  exists: boolean
  bytes: number
  /** 行数；null = 未读取（二进制 / 超限 / 不可读）—— 只有真读到文本才有数字 */
  lines: number | null
  binary: boolean
  oversized: boolean
  unreadable: boolean
}

/**
 * 单文件差异**无法逐行对比**的原因。有值时 hunks 恒为空数组 ——
 * 「不知道」与「没有差异」是两件事，界面必须分开说。
 */
export type RollbackFileDiffReason = 'missing-blob' | 'binary' | 'too-large' | 'unreadable'

/**
 * fileDiff 的返回：**一个记录在案的文件**的前后逐行对照。
 *
 * 方向（与预览行数统计同一口径，别读反）：before = **当前磁盘**，after = **回退点快照**
 * —— 也就是「点下回退之后该文件会变成的样子」。界面左右双栏与之一致。
 */
export interface RollbackFileDiffResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  id: string
  /** 记录里的绝对路径（收窄后 = 请求路径逐字命中记录的那一条） */
  path: string
  status: RollbackPreviewFileStatus
  before: RollbackFileDiffSide
  after: RollbackFileDiffSide
  hunks: DiffHunk[]
  added: number
  removed: number
  identical: boolean
  /** 规模超限 → 结果仍是完整替换，只是不是最小编辑脚本 */
  degraded: boolean
  /** 无法逐行对比的原因（有值时 hunks 为空） */
  reason?: RollbackFileDiffReason
  limits: typeof ROLLBACK_FILE_DIFF_LIMITS
}

export interface RollbackPreviewWorkspace {
  /** 记录在案、会被覆盖的条目数 */
  overwrite: number
  /** 与当前内容不同、确实会被改动 */
  different: number
  /** 记录里的文件当前已不存在（恢复会重新创建） */
  missing: number
  /** 回滚点之后新建、**绝不删除**的条目数 */
  createdAfter: number
  /** E1：逐文件行级统计；**只含会被改动的文件**（内容已一致的一个都不列） */
  files: RollbackPreviewFile[]
  leftovers: string[]
  leftoversTruncated: boolean
  chunks: string[]
  available: boolean
  reasonCode: RollbackCode | null
  /** 捕获时被跳过的条目总数（skipped + excludedDirs；上限截断只影响逐条列表，不影响本计数） */
  skippedCount: number
  /** 捕获是否被上限截断（超单文件上限 / 字节预算 / 文件数预算任一命中即为 true） */
  truncated: boolean
}

export interface RollbackPreviewSession {
  /** fork 的 inclusive 边界 seq（目标回合开始前最后一个事件）；null = 无边界 */
  from: number | null
  /** 目标回合 turn/end 的 seq；null = 未知 */
  to: number | null
  /** 目标回合号（1 基） */
  turns: number | null
  cursorSeq: number | null
  cursorNowBytes: number | null
  cursorTargetBytes: number | null
  restorable: boolean
  /** 会话日志刚被写过（仅供参考：fork 只读，不会覆盖日志） */
  active: boolean
  reasonCode: RollbackCode | null
}

export interface RollbackPreviewResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  id: string
  point?: RollbackPointSummary
  workspace: RollbackPreviewWorkspace
  session: RollbackPreviewSession
  /**
   * 能否作为**回退目标**（t22 冻结口径）：`!protected && !incomplete && 至少一个段可恢复`。
   * **不**包含 `kind !== 'guard'` —— 救援点正是「回到回退前」的唯一路径，必须可回退。
   * 与 rewind() 的准入判定**逐条一致**（preview 说能恢复，rewind 就必须真能成功）。
   */
  canRestore: boolean
  /**
   * 能否**删除**：`!protected && kind !== 'guard'`。
   * 与 canRestore **互相独立**（t22）：guard 用户删不掉（自动淘汰见 ROLLBACK_MAX_GUARDS_PER_SESSION），
   * 但它照样可以回退 —— 把「不可删除」当成「不可恢复」是曾经的缺陷。
   */
  canRemove: boolean
  storage: RollbackStorageStatus
  guidance: RollbackGuidance[]
  warnings: RollbackGuidance[]
}

export interface RollbackListResult {
  ok: boolean
  storage: RollbackStorageStatus
  points: RollbackPointSummary[]
  maxRecords: number
  maxRecordsPerSession: number
  error?: string
}

export interface RollbackRemoveResult {
  ok: boolean
  code: RollbackCode
  id: string
  detail?: string
}

export interface RollbackSegmentResult {
  state: RollbackStateKind
  status: RollbackSegmentStatus
  reasonCode?: RollbackCode
  /** 逐条事实（技术细节，非用户可见文案） */
  detail: string[]
  restored: number
  failed: number
  /** 回滚点之后**新建**的内容：缺省只报告；开 `removeCreated` 时它们就是「已删除 / 想删但拒删」的候选 */
  leftovers: string[]
  leftoversTruncated: boolean
  /** 本次真的**删除**的「回退点之后新建」路径数（用户 2026-10-11 定案 A） */
  removed?: number
  /** 已删除路径（有界清单，供界面逐条说明「删了什么」） */
  removedPaths?: string[]
  /** 按安全判据**拒删**的路径（越界 / 落在插件数据区 / .git / node_modules / 单文件过大）：如实报告 */
  createdSkipped?: string[]
  writtenBytes?: number
  /** 会话段：fork 出来的子会话 id */
  childSessionId?: string
  guidance?: RollbackGuidance[]
}

export interface RollbackRewindInput {
  id: string
  /** fail-closed 确认门：必须**恰好** true */
  userConfirmed: boolean
  mode?: RollbackMode
  segments?: readonly RollbackStateKind[]
  allowPartial?: boolean
  guardPolicy?: RollbackGuardPolicy
  /**
   * 是否**删除**「回退点之后新建」的路径（用户 2026-10-11 定案 A：回退要连文件一起退回去）。
   *
   * 缺省 false = 老口径（只报告 leftovers）。开启后：先读前像 → 删 → 任一失败就**整体回滚**
   * （把已写回的文件还原、把已删的文件写回）。拒删判据见 createdRemovalRefusal。
   */
  removeCreated?: boolean
}

export interface RollbackRewindResult {
  ok: boolean
  outcome: RollbackOutcome
  code: RollbackCode
  detail?: string
  id: string
  segments: RollbackSegmentResult[]
  skippedSegments: RollbackStateKind[]
  /** S3：会话段的 fork 产物 */
  childSessionId?: string
  /** S5：恢复前自动救援点 */
  guardPointId?: string
  storage: RollbackStorageStatus
  guidance: RollbackGuidance[]
  warnings: RollbackGuidance[]
}

export type RollbackStorageProbe = () => Promise<{ ok: true } | { ok: false; detail: string }>

export interface RollbackEngineOptions {
  /** 插件数据目录（= $DSH_HOME/dsh-config-manager）；回滚点库在 dataDir/rollback-points */
  dataDir: string
  /** DSH home（会话根 = homeDir/sessions） */
  homeDir: string
  now?: () => number
  maxFiles?: number
  maxBytes?: number
  /** 单文件上限（缺省 = maxBytes）：超限文件先 stat 判大小后跳过，绝不整份读进内存 */
  maxFileBytes?: number
  /** skipped / excludedDirs 的逐条记录上限（缺省 5000）；超出只计数 + 置 skippedTruncated */
  maxSkippedEntries?: number
  sessionMaxBytes?: number
  sessionQuiescentMs?: number
  maxRecords?: number
  maxRecordsPerSession?: number
  /** 每会话 guard 点上限（缺省 20，见 ROLLBACK_MAX_GUARDS_PER_SESSION） */
  maxGuardsPerSession?: number
  guardPolicy?: RollbackGuardPolicy
  /** 存储栈探针（缺省 = 真实磁盘探测）；注入失败探针可测「缺失时仍可挂载」 */
  storage?: RollbackStorageProbe
  /** 会话 fork seam（宿主注入 ctx.get('sessions').fork） */
  fork?: RollbackForkSeam
  /** 写回 seam（缺省 = atomicWriteFile + symlink:'reject'）；测试可注入以验证「校验失败整体回滚」 */
  writeFile?: (target: string, bytes: Uint8Array) => Promise<void>
  /** E1：预览行级统计的规模上限（缺省见 ROLLBACK_PREVIEW_DIFF_*）；注入小值即可确定性地覆盖 truncated 分支 */
  previewDiffMaxFileBytes?: number
  previewDiffMaxTotalBytes?: number
  previewDiffMaxWork?: number
  previewDiffTotalWork?: number
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
  if (list.length < ROLLBACK_DETAIL_LIMIT) list.push(line)
}

/* ------------------------------------------------ E1：行级统计（纯函数） */

const DIFF_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })

/** 二进制判据：前 8 KiB 出现 NUL 字节 → 不是文本，「行数」没有意义（**不猜、不谎报**）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192)
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true
  }
  return false
}

/**
 * 行切分口径（**空文件边界的唯一事实源**）：
 * - 0 字节 = 0 行；
 * - `'\n'` = 1 行（一个空行）；
 * - 末尾换行不产生多余的一行（`'a\nb\n'` 与 `'a\nb'` 都是 2 行）；
 * - CRLF / CR / LF 都算行分隔符 ⇒「只有换行风格不同」不会被谎报成行增减。
 */
function splitDiffLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/)
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Myers 最短编辑脚本长度 D（O((N+M)·D) 步）。**只在需要长度时**如此实现：
 * 典型编辑（局部小改）D 很小 ⇒ 快；整篇改写时步数会爆炸 ⇒ 由 `limit` 截断并如实返回未完成。
 * `used` 是真实消耗的步数（中止时也要把预算扣掉，避免总预算被绕过）。
 */
function cappedEditDistance(
  a: readonly string[],
  b: readonly string[],
  limit: number,
): { ok: true; distance: number; used: number } | { ok: false; used: number } {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return { ok: true, distance: n + m, used: 0 }
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  let used = 0
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      used += 1
      if (used > limit) return { ok: false, used: used - 1 }
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        used += 1
        if (used > limit) return { ok: false, used: used - 1 }
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) return { ok: true, distance: d, used }
    }
  }
  return { ok: true, distance: max, used }
}

/**
 * 行级 diff 计数：把「before → after 的最短编辑脚本」拆成 added / removed。
 * 由 `added - removed = m - n` 与 `added + removed = D` 解出：
 *   added = (D + m - n) / 2、removed = (D - m + n) / 2（与 LCS 口径等价：added = after 独有行数）。
 *
 * 先折掉公共前后缀（典型编辑只动一小段 ⇒ 内存与步数都随之变小），再对中间段跑 Myers；
 * 步数超过 `maxWork` 或单张预览的总预算（`budget.work`）时返回 null ——
 * 调用方如实置 added/removed = null + truncated，**绝不用近似值糊过去**。
 */
function lineDiffCounts(
  before: readonly string[],
  after: readonly string[],
  maxWork: number,
  totalWork: number,
  budget: { work: number },
): { added: number; removed: number } | null {
  let head = 0
  const maxHead = Math.min(before.length, after.length)
  while (head < maxHead && before[head] === after[head]) head += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > head && endAfter > head && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  const n = endBefore - head
  const m = endAfter - head
  if (n === 0 || m === 0) return { added: m, removed: n }
  const limit = Math.min(maxWork, Math.max(0, totalWork - budget.work))
  const outcome = cappedEditDistance(before.slice(head, endBefore), after.slice(head, endAfter), limit)
  budget.work += outcome.used
  if (!outcome.ok) return null
  const d = outcome.distance
  return { added: (d + m - n) / 2, removed: (d - m + n) / 2 }
}

/**
 * T10：`preview` 里 `fs.stat` 失败的**唯一**分类口径。
 * **只有 ENOENT** 才表示「当前确实不存在」→ 回退会重新创建它（create + 快照行数）；
 * 其余一切（EACCES / EPERM / ELOOP / ENOTDIR / ERR_INVALID_ARG_VALUE / 拿不到 errno）
 * 都是「存在性与可读性**未知**」⇒ 绝不报成 create +N/-0，必须 status 照给 + added/removed=null + truncated=true。
 * 判据只看 errno **code**，不看 message（message 里出现 ENOENT 不算数）。
 */
export function classifyPreviewStatFailure(error: unknown): 'missing' | 'unavailable' {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ENOENT' ? 'missing' : 'unavailable'
}

/** 「本次没有可信行数」的统一返回值（超限 / 非文本 / 对象读不出 / stat 失败但不是 ENOENT）。 */
function previewCountsUnavailable(): { added: number | null; removed: number | null; truncated: boolean } {
  return { added: null, removed: null, truncated: true }
}

function storageGuidance(root: string, detail: string): RollbackGuidance[] {
  return [
    { code: 'rollback.guidance.mountStorage', detail: ROLLBACK_STORAGE_REQUIREMENTS.join(' ') },
    { code: 'rollback.guidance.fixDataDir', detail: root },
    { code: 'rollback.guidance.readOnlyFallback' },
    { code: 'rollback.guidance.probeDetail', detail },
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

function newPointId(createdAt: number): string {
  return 'rb-' + createdAt.toString(36) + '-' + crypto.randomUUID().slice(0, 8)
}

/* ------------------------------------------------------- 回合边界的纯函数 */

/** 会话事件的最小形状（宿主把 session/event 的载荷窄化后喂进来；core 不认识 DSH 事件类型）。 */
export interface RollbackEventLike {
  seq: number
  type: string
  data?: unknown
}

export interface RollbackTurnBoundary {
  turn: number
  /** turn/start 的 seq */
  startSeq: number
  /** turn/end 的 seq；回合还没结束 = null */
  endSeq: number | null
  /**
   * **稳定边界** = 该回合开始前最后一个事件的 seq（startSeq − 1）。
   * startSeq === 0（本会话第一条事件就是 turn/start，首回合）→ null = 无前置边界。
   */
  boundarySeq: number | null
}

function turnOfData(data: unknown): number | null {
  if (!isRecord(data)) return null
  const turn = data['turn']
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null
}

/**
 * 从事件流里抽出回合边界（只认 turn/start 与 turn/end 的 seq；不解析日志字节）。
 */
export function turnBoundariesOf(events: readonly RollbackEventLike[]): RollbackTurnBoundary[] {
  const out: RollbackTurnBoundary[] = []
  for (const event of events) {
    if (!Number.isFinite(event.seq)) continue
    if (event.type === 'turn/start') {
      out.push({
        turn: turnOfData(event.data) ?? out.length + 1,
        startSeq: event.seq,
        endSeq: null,
        boundarySeq: event.seq > 0 ? event.seq - 1 : null,
      })
      continue
    }
    if (event.type === 'turn/end') {
      const turn = turnOfData(event.data)
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const item = out[i]
        if (item === undefined) continue
        if (item.endSeq === null && (turn === null || item.turn === turn)) {
          item.endSeq = event.seq
          break
        }
      }
    }
  }
  return out
}

/**
 * 求「回退到第 turnSeq 回合末」所需的 fork 边界。
 * 首回合无前置边界（turn/start 在 seq 0）→ **结构化 no-boundary**（绝不猜一个不存在的 seq）。
 */
export function resolveTurnBoundary(
  events: readonly RollbackEventLike[],
  turnSeq: number,
): { ok: true; boundarySeq: number; endSeq: number | null } | { ok: false; code: 'no-boundary'; detail: string } {
  const boundary = turnBoundariesOf(events).find((item) => item.turn === turnSeq)
  if (boundary === undefined) {
    return { ok: false, code: 'no-boundary', detail: 'turn=' + String(turnSeq) + ' not-found' }
  }
  if (boundary.boundarySeq === null) {
    return { ok: false, code: 'no-boundary', detail: 'turn=' + String(turnSeq) + ' startSeq=0' }
  }
  return { ok: true, boundarySeq: boundary.boundarySeq, endSeq: boundary.endSeq }
}

export function summarizeRollbackPoint(record: RollbackPointRecord): RollbackPointSummary {
  const workspace = record.workspace.payload
  const session = record.session.payload
  const segment = (
    state: RollbackStateKind,
    track: RollbackTrack<unknown>,
    entries: number,
    bytes: number,
    cursorBytes: number | null,
    restorable: boolean,
    skippedCount: number,
    truncated: boolean,
  ): RollbackSegmentSummary => ({
    state,
    ok: track.ok,
    degraded: track.degraded,
    capturedAt: track.capturedAt,
    fingerprint: track.fingerprint,
    reasonCode: track.reasonCode,
    entries,
    bytes,
    cursorBytes,
    restorable,
    skippedCount,
    truncated,
  })
  return {
    id: record.id,
    createdAt: record.createdAt,
    sessionId: record.sessionId,
    unitId: record.unitId,
    turn: record.turnSeq,
    boundarySeq: record.boundarySeq,
    kind: record.kind,
    protected: record.protected,
    incomplete: record.incomplete,
    note: record.note,
    spreadMs: record.spreadMs,
    segments: [
      segment('workspace', record.workspace, workspace?.files.length ?? 0, workspace?.bytes ?? 0, null, (workspace?.files.length ?? 0) > 0, workspace?.skippedCount ?? 0, workspace?.truncated ?? false),
      segment(
        'session',
        record.session,
        session === null ? 0 : 1,
        session?.bytes ?? 0,
        session?.cursorBytes ?? null,
        session !== null && session.sessionId !== null && session.boundarySeq !== null,
        0,
        false,
      ),
    ],
  }
}

/* ------------------------------------------------------------ 记录校验 */

function isTrack(value: unknown, kind: RollbackStateKind): boolean {
  if (!isRecord(value)) return false
  if (value['kind'] !== kind) return false
  if (typeof value['capturedAt'] !== 'number' || !Number.isFinite(value['capturedAt'])) return false
  if (typeof value['ok'] !== 'boolean') return false
  return true
}

/** 浅层形状校验：台账被篡改 / 半写时不把它当记录用（宁可当「读不到」）。 */
export function isRollbackPointRecord(value: unknown): value is RollbackPointRecord {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'] === '') return false
  if (typeof value['createdAt'] !== 'number' || !Number.isFinite(value['createdAt'])) return false
  if (value['kind'] !== 'auto' && value['kind'] !== 'guard') return false
  if (typeof value['spreadMs'] !== 'number') return false
  return isTrack(value['workspace'], 'workspace') && isTrack(value['session'], 'session')
}

/** mode → 要恢复的段（显式 segments 优先，路由层负责优先级） */
export function statesForMode(mode: RollbackMode | undefined): RollbackStateKind[] {
  if (mode === 'files') return ['workspace']
  if (mode === 'session') return ['session']
  return ['workspace', 'session']
}

/* ------------------------------------------------- 台账写序列化（F-1）

/**
 * 进程内台账写互斥：key = 台账文件**绝对路径**。
 *
 * 为什么必须有：同一 dataDir 下**同时存在多个引擎实例** —— 宿主自动留点器（src/index.ts 的
 * `ctx.on('session/event')` 那条链）持一个，recovery 路由**每个请求新建**一个；两者都对
 * index.json 做「读全文 → 改 → 原子写」。没有互斥就会丢更新（评审实测 20 轮并发
 * capture vs remove：12 轮「删除后点复活」、5 轮「新点丢失」；15 轮 capture vs rewind：
 * 2 轮「响应回了 guardPointId 但台账里已被覆盖」）。
 *
 * 覆盖范围（**所有**台账变更入口，只此一份序列化实现）：
 *   - `capturePoint` → `appendRecord`（合并 + S6 淘汰/prune + 原子写 + 对象回收）
 *   - `remove`（读 → 过滤 → 原子写 + 对象回收）
 *   - `rewind` 的 guard 救援点（内部走 `capturePoint` → `appendRecord`，同一条队列）
 * 读路径（list / read / preview）**不进队列**：纯读，最多读到稍旧的快照，不会破坏台账。
 *
 * 边界（**不可混淆**）：本队列只保证**单进程内**的读-改-写原子。跨进程（另一个 DSH 实例、
 * 离线 CLI）仍由路由层的 runWithMutationLock（EnvironmentLockManager，
 * `<dataDir>/locks/environment.lock`）负责 —— 进程内队列**不能**替代它：env 锁管「谁能写」，
 * 本队列管「进程内多个写者别互相踩」。两者都必须在。
 */
const ledgerWriteChain = new Map<string, Promise<void>>()

function withLedgerWriteLock<T>(ledgerPath: string, task: () => Promise<T>): Promise<T> {
  const previous = ledgerWriteChain.get(ledgerPath) ?? Promise.resolve()
  // 前一个写者失败不能阻断后一个（`then(task, task)` 两个分支都跑 task）
  const run = previous.then(task, task)
  // 队列尾巴只保留「完成信号」并吞掉异常：调用方拿到的仍是 run（异常照原样抛给它）
  const tail: Promise<void> = run.then(() => undefined, () => undefined)
  ledgerWriteChain.set(ledgerPath, tail)
  void tail.then(() => {
    if (ledgerWriteChain.get(ledgerPath) === tail) ledgerWriteChain.delete(ledgerPath)
  })
  return run
}

/* ------------------------------------------------------------------ 引擎 */

/** 目录遍历的留痕槽（跳过 / 整棵忽略 / 读不到）——绝不静默：任何被跳过的路径都必须出现在结果里。 */
interface ChunkWalkSink {
  skipped: RollbackSkippedEntry[]
  excludedDirs: RollbackSkippedEntry[]
  unreadableDirs: string[]
  /** 跳过事件**总数**（含超出记录上限只计数的那部分） */
  skippedCount: number
  /** 逐条列表到达记录上限（skippedCount 仍如实计数） */
  skippedTruncated: boolean
}

interface RewindDraft {
  outcome: RollbackOutcome
  code: RollbackCode
  detail?: string
  id: string
  segments?: RollbackSegmentResult[]
  skippedSegments?: RollbackStateKind[]
  guardPointId?: string
  childSessionId?: string
  storage: RollbackStorageStatus
  guidance?: RollbackGuidance[]
  warnings?: RollbackGuidance[]
}

export class RollbackPointEngine {
  private readonly dataDir: string
  private readonly homeDir: string
  private readonly sessionsRoot: string
  private readonly root: string
  private readonly objectsDir: string
  private readonly ledgerPath: string
  private readonly nowFn: () => number
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly maxFileBytes: number
  private readonly maxSkippedEntries: number
  private readonly sessionMaxBytes: number
  private readonly sessionQuiescentMs: number
  private readonly maxRecords: number
  private readonly maxRecordsPerSession: number
  private readonly maxGuardsPerSession: number
  private readonly guardPolicy: RollbackGuardPolicy
  private readonly probe: RollbackStorageProbe | undefined
  private readonly forkSeam: RollbackForkSeam | undefined
  private readonly writeSeam: ((target: string, bytes: Uint8Array) => Promise<void>) | undefined
  private readonly previewDiffMaxFileBytes: number
  private readonly previewDiffMaxTotalBytes: number
  private readonly previewDiffMaxWork: number
  private readonly previewDiffTotalWork: number
  private readonly log: ((line: string) => void) | undefined

  private lastStamp = 0

  constructor(options: RollbackEngineOptions) {
    this.dataDir = path.resolve(options.dataDir)
    this.homeDir = path.resolve(options.homeDir)
    this.sessionsRoot = path.join(this.homeDir, 'sessions')
    this.root = path.join(this.dataDir, ROLLBACK_POINTS_DIR_NAME)
    this.objectsDir = path.join(this.root, ROLLBACK_OBJECTS_DIR_NAME)
    this.ledgerPath = path.join(this.root, ROLLBACK_LEDGER_NAME)
    this.nowFn = options.now ?? (() => Date.now())
    this.maxFiles = options.maxFiles ?? ROLLBACK_DEFAULT_MAX_FILES
    this.maxBytes = options.maxBytes ?? ROLLBACK_DEFAULT_MAX_BYTES
    // 单文件上限缺省 = 总量预算（一个文件不可能比整个点的预算更大）
    this.maxFileBytes = options.maxFileBytes ?? this.maxBytes
    this.maxSkippedEntries = options.maxSkippedEntries ?? ROLLBACK_SKIPPED_LIST_LIMIT
    this.sessionMaxBytes = options.sessionMaxBytes ?? ROLLBACK_DEFAULT_SESSION_MAX_BYTES
    this.sessionQuiescentMs = options.sessionQuiescentMs ?? ROLLBACK_DEFAULT_SESSION_QUIESCENT_MS
    this.maxRecords = options.maxRecords ?? ROLLBACK_MAX_RECORDS
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? ROLLBACK_MAX_RECORDS_PER_SESSION
    this.maxGuardsPerSession = options.maxGuardsPerSession ?? ROLLBACK_MAX_GUARDS_PER_SESSION
    this.guardPolicy = options.guardPolicy ?? 'warn'
    this.probe = options.storage
    this.forkSeam = options.fork
    this.writeSeam = options.writeFile
    this.previewDiffMaxFileBytes = options.previewDiffMaxFileBytes ?? ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES
    this.previewDiffMaxTotalBytes = options.previewDiffMaxTotalBytes ?? ROLLBACK_PREVIEW_DIFF_MAX_TOTAL_BYTES
    this.previewDiffMaxWork = options.previewDiffMaxWork ?? ROLLBACK_PREVIEW_DIFF_MAX_WORK
    this.previewDiffTotalWork = options.previewDiffTotalWork ?? ROLLBACK_PREVIEW_DIFF_TOTAL_WORK
    this.log = options.log
  }

  /** 回滚点库根目录（只读侦察用；写路径全部经本类的门） */
  get storeDir(): string {
    return this.root
  }

  get sessionsRootDir(): string {
    return this.sessionsRoot
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

  /**
   * 记一条留痕。`skipped` 桶：列表未满就逐条落盘，满了只计数 + 置 skippedTruncated（上限只影响
   * **记录条数**，不影响 skippedCount —— 绝不静默丢弃）；`excluded` 桶（预期内的忽略目录，如
   * node_modules）逐条记录、**不计入 skippedCount**，因此不会把点判成 degraded。
   */
  private recordSkip(sink: ChunkWalkSink, bucket: 'skipped' | 'excluded', entry: RollbackSkippedEntry): void {
    if (bucket === 'excluded') {
      sink.excludedDirs.push(entry)
      return
    }
    sink.skippedCount += 1
    if (sink.skipped.length < this.maxSkippedEntries) sink.skipped.push(entry)
    else sink.skippedTruncated = true
  }

  private async writeFile(target: string, bytes: Uint8Array): Promise<void> {
    if (this.writeSeam !== undefined) {
      await this.writeSeam(target, bytes)
      return
    }
    await atomicWriteFile(target, bytes, { symlink: 'reject' })
  }

  /* ---------------------------------------------------------- 存储栈探针 */

  async storageStatus(): Promise<RollbackStorageStatus> {
    const base = { root: this.root, requirements: ROLLBACK_STORAGE_REQUIREMENTS }
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
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('rollback object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('rollback object path escapes store')
    await fs.mkdir(this.objectsDir, { recursive: true })
    try {
      await fs.access(target)
      return sha
    } catch { /* 不存在才写（内容寻址天然去重） */ }
    await atomicWriteFile(target, bytes)
    return sha
  }

  private async readObject(sha: string): Promise<Uint8Array> {
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('rollback object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('rollback object path escapes store')
    return await fs.readFile(target)
  }

  /* ------------------------------------------------------------ 捕获：态 */

  private emptyTrack<TPayload = never>(
    kind: RollbackStateKind,
    capturedAt: number,
    code: RollbackCode,
    detail: string | null,
  ): RollbackTrack<TPayload> {
    return { kind, capturedAt, ok: false, degraded: false, fingerprint: null, reasonCode: code, reasonDetail: detail, payload: null }
  }

  /**
   * 会话态捕获：记录 sessionId / 事件游标 / 字节数 / 指纹；容量允许时把**字节副本**放进
   * 对象仓（仅为审计证据 —— 回退走 fork，不依赖它）。
   */
  private async captureSession(input: {
    sessionId: string | null
    logPath: string | null
    cursorSeq: number | null
    turnSeq: number | null
    boundarySeq: number | null
    boundaryEndSeq: number | null
  }): Promise<RollbackTrack<RollbackSessionPayload>> {
    const capturedAt = this.stamp()
    if (input.sessionId === null || input.sessionId === '') {
      return this.emptyTrack('session', capturedAt, 'session-missing', 'sessionId missing')
    }
    const payload: RollbackSessionPayload = {
      sessionId: input.sessionId,
      logPath: input.logPath,
      cursorSeq: input.cursorSeq,
      cursorBytes: null,
      mtimeMs: null,
      fingerprintKind: 'cursor',
      fingerprint: 'cursor:' + String(input.cursorSeq ?? 'unknown'),
      object: null,
      bytes: 0,
      turnSeq: input.turnSeq,
      boundarySeq: input.boundarySeq,
      boundaryEndSeq: input.boundaryEndSeq,
    }
    if (input.logPath === null || input.logPath === '') {
      // 没有日志路径也能回退（fork 只要 sessionId + 边界）；如实标注指纹种类
      return { kind: 'session', capturedAt, ok: true, degraded: false, fingerprint: payload.fingerprint, reasonCode: null, reasonDetail: null, payload }
    }
    try {
      const realRoot = await fs.realpath(this.sessionsRoot).catch(() => undefined)
      const realLog = await fs.realpath(input.logPath).catch(() => undefined)
      if (realLog === undefined) {
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: 'session-log-missing ' + input.logPath, payload }
      }
      if (realRoot === undefined || !isInsidePath(realLog, realRoot)) {
        return this.emptyTrack('session', capturedAt, 'session-out-of-root', realLog)
      }
      const stat = await fs.stat(realLog)
      if (!stat.isFile()) {
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: 'session-log-not-file ' + realLog, payload }
      }
      payload.logPath = realLog
      payload.cursorBytes = stat.size
      payload.mtimeMs = stat.mtimeMs
      payload.bytes = stat.size
      if (stat.size > this.sessionMaxBytes) {
        payload.fingerprintKind = 'size'
        payload.fingerprint = 'size:' + String(stat.size)
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'session-too-large', reasonDetail: realLog, payload }
      }
      const bytes = await fs.readFile(realLog)
      const sha = sha256Hex(bytes)
      await this.writeObjectWithHash(bytes, sha)
      payload.fingerprintKind = 'content'
      payload.fingerprint = sha
      payload.object = sha
      return { kind: 'session', capturedAt, ok: true, degraded: false, fingerprint: sha, reasonCode: null, reasonDetail: null, payload }
    } catch (error) {
      return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: errorDetail(error), payload }
    }
  }

  /**
   * 列出一个显式分块内的候选文件（不跟随符号链接 / junction；跳过与读不到都留痕）。
   * 返回 null = 该分块本身不可用（不存在 / 是链接 / 非常规文件），细节已写进 sink。
   */
  private async listChunkFiles(
    chunk: string,
    sink: ChunkWalkSink,
    limit: number,
  ): Promise<{ files: string[]; truncated: boolean } | null> {
    let stat
    try {
      stat = await fs.lstat(chunk)
    } catch {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'missing' })
      return null
    }
    if (stat.isSymbolicLink()) {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'link' })
      return null
    }
    if (stat.isFile()) return { files: [chunk], truncated: false }
    if (!stat.isDirectory()) {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'not-a-file' })
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
          this.recordSkip(sink, 'skipped', { path: full, reason: 'link' })
          continue
        }
        if (entry.isDirectory()) {
          if (EXCLUDED_DEP_DIR_NAMES.includes(entry.name)) {
            // 忽略规则（S4「沿用现有 IGNORE 规则」）：整棵不进快照，但留痕（不静默）
            this.recordSkip(sink, 'excluded', { path: full, reason: 'dep-dir' })
            continue
          }
          stack.push({ dir: full, depth: item.depth + 1 })
          continue
        }
        if (!entry.isFile()) {
          this.recordSkip(sink, 'skipped', { path: full, reason: 'not-a-file' })
          continue
        }
        if (out.length >= limit) {
          // 文件数预算用尽：**逐条留痕**（不静默截断），但不再收进 files；继续遍历把后面每条也记上
          truncated = true
          this.recordSkip(sink, 'skipped', { path: full, reason: 'budget-files' })
          continue
        }
        out.push(full)
      }
    }
    out.sort()
    return { files: out, truncated }
  }

  private async captureWorkspace(chunks: readonly string[]): Promise<RollbackTrack<RollbackWorkspacePayload>> {
    const capturedAt = this.stamp()
    if (chunks.length === 0) return this.emptyTrack('workspace', capturedAt, 'no-chunks', 'chunks empty')
    const payload: RollbackWorkspacePayload = {
      chunks: [...chunks],
      files: [],
      skipped: [],
      excludedDirs: [],
      unreadableDirs: [],
      unreadableFiles: [],
      skippedCount: 0,
      skippedTruncated: false,
      truncated: false,
      bytes: 0,
    }
    let read = 0
    let sawChunk = false
    for (const chunk of chunks) {
      if (!path.isAbsolute(chunk)) return this.emptyTrack('workspace', capturedAt, 'chunk-not-absolute', chunk)
      const resolved = path.resolve(chunk)
      // 文件数预算还剩多少就收多少；+1 只用于让遍历器发现「还有溢出」——溢出条目逐条记 skipped
      const listed = await this.listChunkFiles(resolved, payload, Math.max(0, this.maxFiles - read) + 1)
      if (listed === null) continue
      sawChunk = true
      if (listed.truncated) payload.truncated = true
      for (const file of listed.files) {
        if (read >= this.maxFiles) {
          // 文件数预算耗尽：其后每一条都如实留痕（不再 break 静默丢弃）
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'budget-files' })
          continue
        }
        if (isInsidePath(file, this.root)) {
          this.recordSkip(payload, 'skipped', { path: file, reason: 'self-store' })
          continue
        }
        // **先 stat 判大小、再决定读不读**：单文件超限或加上它会超总量 → 跳过并如实留痕
        // （旧实现的 `read > 0` 短路让**首个**文件完全不设上限，会被整份读进内存 —— t5-F1）
        let stat
        try {
          stat = await fs.stat(file)
        } catch (error) {
          payload.unreadableFiles.push({ path: file, reason: errorDetail(error) })
          continue
        }
        if (!stat.isFile()) {
          this.recordSkip(payload, 'skipped', { path: file, reason: 'not-a-file' })
          continue
        }
        if (stat.size > this.maxFileBytes) {
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'too-large' })
          continue
        }
        if (payload.bytes + stat.size > this.maxBytes) {
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'budget-bytes' })
          continue
        }
        try {
          const data = await fs.readFile(file)
          // stat 与 read 之间文件可能变化：真读到的字节数仍必须服从总量预算（不猜、不静默）
          if (payload.bytes + data.byteLength > this.maxBytes) {
            payload.truncated = true
            this.recordSkip(payload, 'skipped', { path: file, reason: 'budget-bytes' })
            continue
          }
          const sha = sha256Hex(data)
          await this.writeObjectWithHash(data, sha)
          payload.files.push({ path: file, chunk: resolved, bytes: data.byteLength, sha256: sha, mtimeMs: stat.mtimeMs, object: sha })
          payload.bytes += data.byteLength
          read += 1
        } catch (error) {
          payload.unreadableFiles.push({ path: file, reason: errorDetail(error) })
        }
      }
    }
    if (!sawChunk && payload.files.length === 0) {
      return this.emptyTrack('workspace', capturedAt, 'chunk-not-found', chunks.join(' '))
    }
    // 留痕列表也排序：跨分块 / 依赖 readdir 顺序时输出仍确定（测试与对账都能逐条比）
    payload.skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    payload.excludedDirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const canonical = [...payload.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, f.bytes, f.sha256])
    const fingerprint = sha256Hex(JSON.stringify({ chunks: [...payload.chunks].sort(), files: canonical }))
    const degraded = payload.truncated
      || payload.skippedCount > 0
      || payload.unreadableDirs.length > 0
      || payload.unreadableFiles.length > 0
    return {
      kind: 'workspace', capturedAt, ok: true, degraded, fingerprint,
      reasonCode: payload.truncated ? 'capture-truncated' : degraded ? 'capture-degraded' : null,
      reasonDetail: degraded
        ? 'files=' + String(payload.files.length) + ' skipped=' + String(payload.skippedCount)
          + (payload.skippedTruncated ? '(list-capped)' : '')
          + ' unreadableDirs=' + String(payload.unreadableDirs.length) + ' unreadableFiles=' + String(payload.unreadableFiles.length)
        : null,
      payload,
    }
  }

  /* -------------------------------------------------------------- 台账 */

  private async readLedger(): Promise<{ records: RollbackPointRecord[]; error?: string }> {
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
      const records = list.filter(isRollbackPointRecord)
      const skipped = list.length - records.length
      return skipped > 0 ? { records, error: 'ledger dropped ' + String(skipped) + ' invalid record(s)' } : { records }
    } catch (error) {
      return { records: [], error: 'ledger unreadable: ' + errorDetail(error) }
    }
  }

  /**
   * S6 淘汰（t14 冻结口径）：三类点各按各的预算裁，**只删最旧的**。
   *
   * | 类别 | 预算 | 说明 |
   * |---|---|---|
   * | auto 自动点 | 每会话 `maxRecordsPerSession`（20）→ 全局 `maxRecords`（50） | 两次裁剪都只删最旧 |
   * | guard 救援点 | 每会话 `maxGuardsPerSession`（`ROLLBACK_MAX_GUARDS_PER_SESSION`，20） | **不占**自动点预算、**不受** 20/50 影响；用户删不掉 ⇒ 必须有自己的上限 |
   * | protected 点 | 无上限（只进不出） | 生产路径**造不出来**（capture 端点已下线、tracker 从不设 protect），只有测试能造 |
   */
  private selectPrune(records: readonly RollbackPointRecord[]): { kept: RollbackPointRecord[]; removed: string[] } {
    const kept: RollbackPointRecord[] = []
    const guards: RollbackPointRecord[] = []
    const prunable: RollbackPointRecord[] = []
    for (const record of records) {
      if (record.protected) kept.push(record)
      else if (record.kind === 'guard') guards.push(record)
      else prunable.push(record)
    }
    // 最新在前（下面三类裁剪共用同一排序口径）
    const newestFirst = (a: RollbackPointRecord, b: RollbackPointRecord): number =>
      a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0
    // guard：每会话各自保留最近 maxGuardsPerSession 个
    guards.sort(newestFirst)
    const guardsPerSession = new Map<string, number>()
    for (const record of guards) {
      const key = record.sessionId ?? ''
      const used = guardsPerSession.get(key) ?? 0
      if (used >= this.maxGuardsPerSession) continue
      guardsPerSession.set(key, used + 1)
      kept.push(record)
    }
    // 自动点：先每会话上限，再全局上限
    prunable.sort(newestFirst)
    const perSession = new Map<string, number>()
    const withinSession: RollbackPointRecord[] = []
    for (const record of prunable) {
      const key = record.sessionId ?? ''
      const used = perSession.get(key) ?? 0
      if (used >= this.maxRecordsPerSession) continue
      perSession.set(key, used + 1)
      withinSession.push(record)
    }
    kept.push(...withinSession.slice(0, Math.max(0, this.maxRecords)))
    const keptIds = new Set(kept.map((r) => r.id))
    const removed = records.filter((r) => !keptIds.has(r.id)).map((r) => r.id)
    return { kept, removed }
  }

  private async gcObjects(records: readonly RollbackPointRecord[]): Promise<void> {
    const referenced = new Set<string>()
    for (const record of records) {
      for (const file of record.workspace.payload?.files ?? []) referenced.add(file.object)
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
        this.warn('rollback gc failed: ' + name + ' ' + errorDetail(error))
      }
    }
  }

  /**
   * 把记录写进台账（**留点侧唯一写入口**）：整段「读全文 → 合并 → S6 淘汰 → 原子写 → 回收对象」
   * 都在 {@link withLedgerWriteLock} 的进程内串行队列里 —— 绝不与 tracker / 路由的另一次写交错。
   */
  private async appendRecord(record: RollbackPointRecord): Promise<{ ok: boolean; detail?: string }> {
    return await withLedgerWriteLock(this.ledgerPath, async () => {
      const ledger = await this.readLedger()
      const merged = [record, ...ledger.records.filter((r) => r.id !== record.id)]
      const { kept } = this.selectPrune(merged)
      kept.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
      try {
        await fs.mkdir(this.root, { recursive: true })
        await atomicWriteFile(this.ledgerPath, JSON.stringify({ schemaVersion: ROLLBACK_SCHEMA_VERSION, records: kept }, null, 2))
      } catch (error) {
        return { ok: false, detail: errorDetail(error) }
      }
      await this.gcObjects(kept)
      return { ok: true }
    })
  }

  /* -------------------------------------------------------------- 留点 */

  /**
   * 留一个回滚点（宿主自动留点 / 恢复前救援点 / 测试构造都走这一条）。
   * 没有 HTTP capture 端点 —— 手动「拍点」已随规格 S1 下线。
   */
  async capturePoint(input: RollbackPointInput = {}): Promise<RollbackCaptureResult> {
    const storage = await this.storageStatus()
    if (!storage.available) {
      return { ok: false, code: 'storage-unavailable', detail: storage.detail, guidance: storage.guidance, storage }
    }
    const createdAt = this.stamp()
    const kind: RollbackPointKind = input.kind === 'guard' ? 'guard' : 'auto'
    const chunks = (input.chunks ?? []).filter((c): c is string => typeof c === 'string' && c !== '')
    const session = await this.captureSession({
      sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
      logPath: typeof input.sessionLogPath === 'string' && input.sessionLogPath !== '' ? input.sessionLogPath : null,
      cursorSeq: typeof input.cursorSeq === 'number' && Number.isFinite(input.cursorSeq) ? input.cursorSeq : null,
      turnSeq: typeof input.turnSeq === 'number' && Number.isFinite(input.turnSeq) ? input.turnSeq : null,
      boundarySeq: typeof input.boundarySeq === 'number' && Number.isFinite(input.boundarySeq) ? input.boundarySeq : null,
      boundaryEndSeq: typeof input.boundaryEndSeq === 'number' && Number.isFinite(input.boundaryEndSeq) ? input.boundaryEndSeq : null,
    })
    const workspace = await this.captureWorkspace(chunks)
    const spreadMs = Math.abs(session.capturedAt - workspace.capturedAt)
    const record: RollbackPointRecord = {
      schemaVersion: ROLLBACK_SCHEMA_VERSION,
      id: newPointId(createdAt),
      kind,
      createdAt,
      spreadMs,
      protected: input.protect === true && kind !== 'guard',
      incomplete: !(session.ok && workspace.ok),
      note: typeof input.note === 'string' && input.note !== '' ? input.note : null,
      sessionId: session.payload?.sessionId ?? null,
      unitId: typeof input.unitId === 'string' && input.unitId !== '' ? input.unitId : null,
      turnSeq: session.payload?.turnSeq ?? null,
      boundarySeq: session.payload?.boundarySeq ?? null,
      workspace,
      session,
    }
    const stored = await this.appendRecord(record)
    if (!stored.ok) {
      // T10（S5 安全链）：台账**真的没写进去** ⇒ 不返回这个内存 record。
      // 旧实现把它一起返回，消费方（rewind 的救援点 / tracker）拿 `point.id` 当「留点成功」，
      // 于是对外报出一个台账里根本查不到的**幽灵 id**。判据只有一条：appendRecord 真的成功。
      return { ok: false, code: 'ledger-write-failed', detail: stored.detail, guidance: [], storage }
    }
    return { ok: true, code: 'ok', point: record, guidance: [], storage }
  }

  /* -------------------------------------------------------------- 列 / 读 */

  async list(): Promise<RollbackListResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const points = [...ledger.records]
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
      .map(summarizeRollbackPoint)
    const out: RollbackListResult = {
      ok: storage.available,
      storage,
      points,
      maxRecords: this.maxRecords,
      maxRecordsPerSession: this.maxRecordsPerSession,
    }
    if (ledger.error !== undefined) out.error = ledger.error
    return out
  }

  async read(id: string): Promise<{ point?: RollbackPointRecord; records: RollbackPointRecord[]; error?: string; storage: RollbackStorageStatus }> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const point = ledger.records.find((r) => r.id === id)
    const out: { point?: RollbackPointRecord; records: RollbackPointRecord[]; error?: string; storage: RollbackStorageStatus } = {
      records: ledger.records,
      storage,
    }
    if (point !== undefined) out.point = point
    if (ledger.error !== undefined) out.error = ledger.error
    return out
  }

  /* -------------------------------------------------------------- 预览 */

  private trackWarnings(record: RollbackPointRecord): RollbackGuidance[] {
    const out: RollbackGuidance[] = []
    for (const track of [record.workspace, record.session]) {
      if (!track.ok) {
        out.push({ code: 'rollback.warn.trackMissing', detail: track.kind + ' ' + String(track.reasonCode ?? '') })
        continue
      }
      if (track.degraded && track.reasonCode !== null) {
        out.push({ code: 'rollback.warn.trackDegraded', detail: track.kind + ' ' + track.reasonCode })
      }
    }
    if (record.protected) out.push({ code: 'rollback.warn.protected', detail: record.id })
    return out
  }

  private async scanLeftovers(
    chunks: readonly string[],
    captured: ReadonlySet<string>,
    sink: ChunkWalkSink,
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
        if (leftovers.length < ROLLBACK_LEFTOVER_LIST_LIMIT) leftovers.push(file)
      }
      if (listed.truncated) truncated = true
    }
    return { leftovers, truncated, count }
  }

  /**
   * E1：一个**执行过但无事可做**的段。T10 起按原因分成两个码（界面据此说两句不同的话，
   * **不靠 detail 分派**）：
   * - `'nothing-to-restore'`：记录了条目、但全部已与快照一致（工作区已与该点一致）；
   * - `'no-recorded-files'`：该态**没有记录任何文件**（例如捕获时分块不可用 / 空分块）。
   *
   * status 用 'restored' 而不是 'skipped' —— 它不是「没执行」，而是「执行了、0 变更」（restored=0）；
   * 于是 rewind 能靠它把「无事可做」与「真失败」分开（见 rewind 的 allNoop）。两者都不是错误。
   */
  private noopSegment(
    state: RollbackStateKind,
    reasonCode: 'nothing-to-restore' | 'no-recorded-files',
    detail: string,
  ): RollbackSegmentResult {
    return {
      state, status: 'restored', reasonCode, detail: [detail],
      restored: 0, failed: 0, leftovers: [], leftoversTruncated: false,
    }
  }

  /**
   * E1：单个「会被改动的文件」的行级统计 —— 方向**只有一侧**，别读反：
   * **current → snapshot**（=「这次回退会给该文件新增/删除多少行」），与 `RollbackPreviewFile`
   * 的 `added` / `removed` 字段注释同一口径：
   *  · `added`   = 快照里有、当前**没有**的行 ⇒ 回退会**加进去**的行数；
   *  · `removed` = 当前有、快照里**没有**的行 ⇒ 回退会**删掉**的行数。
   * 对应到实现：`lineDiffCounts(before, after)` 的 **`after` 是快照（回退目标）**、`before` 是当前文件。
   *
   * 任何一条超限、读不出、非文本 ⇒ 返回 null 数字 + truncated（调用方照给 status，但**不给数字**）。
   * `budget` 是**单张预览**共享的累计预算（字节 + 步数），跨条目生效。
   */
  private async previewFileCounts(
    file: RollbackWorkspaceFile,
    current: Uint8Array | null,
    status: RollbackPreviewFileStatus,
    budget: { bytes: number; work: number },
  ): Promise<{ added: number | null; removed: number | null; truncated: boolean }> {
    const currentBytes = current === null ? 0 : current.byteLength
    if (file.bytes > this.previewDiffMaxFileBytes || currentBytes > this.previewDiffMaxFileBytes) {
      return previewCountsUnavailable()
    }
    if (budget.bytes + file.bytes + currentBytes > this.previewDiffMaxTotalBytes) {
      return previewCountsUnavailable()
    }
    budget.bytes += file.bytes + currentBytes
    let snapshot: Uint8Array
    try {
      snapshot = await this.readObject(file.object)
    } catch {
      // 对象仓读不出（缺失 / 越界 / 权限）：status 照给，行数不给
      return previewCountsUnavailable()
    }
    if (looksBinary(snapshot) || (current !== null && looksBinary(current))) {
      return previewCountsUnavailable()
    }
    const target = splitDiffLines(DIFF_TEXT_DECODER.decode(snapshot))
    // 当前不存在 ⇒ 回退只会**新建**该文件：新增 = 快照行数、删除 = 0
    if (status === 'create') return { added: target.length, removed: 0, truncated: false }
    // 存在但读不出（目录 / 权限）⇒ 没有 before 可比，**不给数字**
    if (current === null) return previewCountsUnavailable()
    // 步数预算由 lineDiffCounts 直接记进共享 budget（中止时也扣满 limit，**总预算不可绕过**）
    const counts = lineDiffCounts(
      splitDiffLines(DIFF_TEXT_DECODER.decode(current)),
      target,
      this.previewDiffMaxWork,
      this.previewDiffTotalWork,
      budget,
    )
    if (counts === null) return previewCountsUnavailable()
    return { added: counts.added, removed: counts.removed, truncated: false }
  }

  /** 只读预览：零写入（不过确认门、不拍 guard、不写任何字节）。 */
  async preview(id: string): Promise<RollbackPreviewResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readLedger()
    const warnings: RollbackGuidance[] = []
    if (ledger.error !== undefined) warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail: ledger.error })
    const workspace: RollbackPreviewWorkspace = {
      overwrite: 0, different: 0, missing: 0, createdAfter: 0, files: [],
      leftovers: [], leftoversTruncated: false, chunks: [], available: false, reasonCode: null,
      skippedCount: 0, truncated: false,
    }
    const session: RollbackPreviewSession = {
      from: null, to: null, turns: null, cursorSeq: null, cursorNowBytes: null, cursorTargetBytes: null,
      restorable: false, active: false, reasonCode: null,
    }
    const base: RollbackPreviewResult = {
      ok: false, code: 'ok', id, workspace, session,
      canRestore: false, canRemove: false, storage, guidance: [], warnings,
    }
    if (!storage.available) {
      return { ...base, code: 'storage-unavailable', detail: storage.detail, guidance: storage.guidance }
    }
    const record = ledger.records.find((r) => r.id === id)
    if (record === undefined) return { ...base, code: 'record-not-found' }
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)

    // 工作区态
    const wsTrack = record.workspace
    const wsPayload = wsTrack.payload
    let workspaceRestorable = false
    if (!wsTrack.ok || wsPayload === null) {
      workspace.reasonCode = wsTrack.reasonCode ?? 'capture-failed'
    } else {
      workspace.chunks = [...wsPayload.chunks]
      workspace.available = true
      const captured = new Set(wsPayload.files.map((f) => pathKey(f.path)))
      let different = 0
      let missing = 0
      // E1：逐文件行级统计 —— **只列会被改动的文件**（内容已一致的一个都不列）
      const changedFiles: RollbackPreviewFile[] = []
      // 单张预览共享的比对预算（字节 + 步数）；只有真的会被改动的条目才消耗它
      const diffBudget = { bytes: 0, work: 0 }
      // T10：stat 的三种结局分开表达 —— 「不存在（ENOENT）」与「存在性未知（其它 errno）」绝不混为一谈
      type PreviewStatOutcome =
        | { kind: 'ok'; size: number; regular: boolean }
        | { kind: 'missing' }
        | { kind: 'unavailable' }
      for (const file of wsPayload.files) {
        let outcome: PreviewStatOutcome
        try {
          const stat = await fs.stat(file.path)
          outcome = { kind: 'ok', size: stat.size, regular: stat.isFile() }
        } catch (error) {
          outcome = classifyPreviewStatFailure(error) === 'missing' ? { kind: 'missing' } : { kind: 'unavailable' }
        }
        if (outcome.kind === 'missing') {
          // **只有 ENOENT** 才算「当前确实不存在」⇒ 回退会重新创建它
          missing += 1
          changedFiles.push({
            path: file.path, status: 'create',
            ...(await this.previewFileCounts(file, null, 'create', diffBudget)),
          })
          continue
        }
        if (outcome.kind === 'unavailable') {
          // 存在性未知（EACCES 等）：**不得**报成 create +N/-0，也不给行数 —— 只说「会被尝试写入」。
          // 计入 different 的理由：回退一定会尝试写它（restoreWorkspace 里「已一致」判定失败即视为需要写），
          // 这样 overwrite = 已一致 + different + missing 的算术仍然成立。
          different += 1
          changedFiles.push({ path: file.path, status: 'overwrite', ...previewCountsUnavailable() })
          continue
        }
        const { size, regular } = outcome
        const sizeMatches = regular && size === file.bytes
        const withinCaps = file.bytes <= this.previewDiffMaxFileBytes && size <= this.previewDiffMaxFileBytes
        let current: Uint8Array | null = null
        // 读当前内容的两个理由：① 大小一致时必须比 hash（判「内容真的变了吗」）；
        // ② 大小不一致时也得读一次才能给行级统计（超限的大文件不白读）。
        if (regular && (sizeMatches || withinCaps)) {
          try {
            current = await fs.readFile(file.path)
          } catch {
            current = null
          }
        }
        if (sizeMatches && current !== null && sha256Hex(current) === file.sha256) continue
        different += 1
        changedFiles.push({
          path: file.path, status: 'overwrite',
          ...(await this.previewFileCounts(file, current, 'overwrite', diffBudget)),
        })
      }
      const sink: ChunkWalkSink = { skipped: [], excludedDirs: [], unreadableDirs: [], skippedCount: 0, skippedTruncated: false }
      const leftovers = await this.scanLeftovers(wsPayload.chunks, captured, sink)
      workspace.overwrite = wsPayload.files.length
      workspace.different = different
      workspace.missing = missing
      workspace.createdAfter = leftovers.count
      workspace.files = changedFiles
      workspace.leftovers = leftovers.leftovers
      workspace.leftoversTruncated = leftovers.truncated
      // 捕获期的跳过计数与截断标记如实回传（列表被记录上限截断时 skippedCount 仍是真实总数）
      workspace.skippedCount = wsPayload.skippedCount
      workspace.truncated = wsPayload.truncated
      workspaceRestorable = wsPayload.files.length > 0
    }

    // 会话态
    const sessionTrack = record.session
    const sessionPayload = sessionTrack.payload
    let sessionRestorable = false
    if (!sessionTrack.ok || sessionPayload === null) {
      session.reasonCode = sessionTrack.reasonCode ?? 'capture-failed'
    } else {
      session.from = sessionPayload.boundarySeq
      session.to = sessionPayload.boundaryEndSeq
      session.turns = sessionPayload.turnSeq
      session.cursorSeq = sessionPayload.cursorSeq
      session.cursorTargetBytes = sessionPayload.cursorBytes
      if (sessionPayload.logPath !== null) {
        try {
          const stat = await fs.stat(sessionPayload.logPath)
          session.cursorNowBytes = stat.size
          session.active = this.sessionQuiescentMs > 0 && this.nowFn() - stat.mtimeMs < this.sessionQuiescentMs
        } catch {
          session.cursorNowBytes = null
        }
      }
      if (sessionPayload.sessionId === null) session.reasonCode = 'session-missing'
      else if (sessionPayload.boundarySeq === null) session.reasonCode = 'no-boundary'
      else {
        sessionRestorable = true
        session.reasonCode = null
      }
    }

    session.restorable = sessionRestorable
    // 两个准入门**互相独立**（t22 口径，三处收敛为同一份说法）：
    //   canRemove  = 用户能不能删 —— 排除 guard（救援点是自动产物，删了就丢了「回到回退前」的路径）
    //   canRestore = 能不能作回退目标 —— **不**排除 guard，且与 rewind() 的准入逐条对应：
    //                rewind 只拒 protected / incomplete（+ 存储不可用 / 记录不存在 / 空 segments），
    //                所以这里就是「!protected && !incomplete && 至少一个段可恢复」。
    const canRemove = !record.protected && record.kind !== 'guard'
    const canRestore = !record.protected && !record.incomplete && (workspaceRestorable || sessionRestorable)
    return {
      ok: true, code: 'ok', id,
      point: summarizeRollbackPoint(record),
      workspace, session,
      canRestore, canRemove,
      storage, guidance: [], warnings,
    }
  }

  /* ------------------------------------------------- 单文件前后对照（只读） */

  /**
   * 只读：单个回滚点里**一个记录在案的文件**的逐行前后对照（零写入、不拍 guard、不写字节）。
   *
   * 收窄（安全不变量）：路径必须**逐字命中**记录里的 workspace.files ——
   * 绝不把这条端点做成「任意路径读取器」；未命中 ⇒ file-not-recorded，**一个字节都不读**。
   * 二进制 / 单侧超限 / 对象仓读不出 / 当前读不出都返回结构化 reason（hunks 恒为空数组），
   * 既不抛错，也不把「不知道」谎报成「没有差异」。
   */
  async fileDiff(id: string, filePath: string): Promise<RollbackFileDiffResult> {
    const emptySide = (): RollbackFileDiffSide => ({
      exists: false, bytes: 0, lines: null, binary: false, oversized: false, unreadable: false,
    })
    const base: RollbackFileDiffResult = {
      ok: false, code: 'invalid-input', id, path: filePath, status: 'overwrite',
      before: emptySide(), after: emptySide(),
      hunks: [], added: 0, removed: 0, identical: false, degraded: false,
      limits: ROLLBACK_FILE_DIFF_LIMITS,
    }
    const storage = await this.storageStatus()
    if (!storage.available) return { ...base, code: 'storage-unavailable', detail: storage.detail }
    if (filePath === '') return { ...base, detail: 'empty-path' }
    const ledger = await this.readLedger()
    const record = ledger.records.find((r) => r.id === id)
    if (record === undefined) return { ...base, code: 'record-not-found' }
    const payload = record.workspace.payload
    if (!record.workspace.ok || payload === null) {
      const detail = record.workspace.reasonDetail
      return detail === null ? { ...base, code: 'capture-failed' } : { ...base, code: 'capture-failed', detail }
    }
    const key = pathKey(filePath)
    const file = payload.files.find((entry) => pathKey(entry.path) === key)
    if (file === undefined) return { ...base, code: 'file-not-recorded', detail: filePath }

    // 快照一侧（回退后的样子）：超限**不读进内存**（与捕获期 / 预览行数统计同一口径）
    const snapshotOversized = file.bytes > this.previewDiffMaxFileBytes
    let snapshot: Uint8Array | null = null
    if (!snapshotOversized) {
      try {
        snapshot = await this.readObject(file.object)
      } catch {
        snapshot = null
      }
    }
    // 当前一侧（现在的样子）：**只有 ENOENT** 才算「不存在 ⇒ 回退会新建它」
    let current: Uint8Array | null = null
    let currentExists = false
    let currentBytes = 0
    let currentOversized = false
    let currentUnreadable = false
    try {
      const stat = await fs.stat(file.path)
      currentExists = true
      currentBytes = stat.size
      if (!stat.isFile()) currentUnreadable = true
      else if (stat.size > this.previewDiffMaxFileBytes) currentOversized = true
      else current = await fs.readFile(file.path)
    } catch (error) {
      if (classifyPreviewStatFailure(error) === 'missing') currentExists = false
      else currentUnreadable = true
    }

    const before: RollbackFileDiffSide = {
      exists: currentExists, bytes: currentBytes, lines: null,
      binary: false, oversized: currentOversized, unreadable: currentUnreadable,
    }
    if (current !== null) {
      before.binary = looksBinary(current)
      before.lines = before.binary ? null : splitDiffLines(DIFF_TEXT_DECODER.decode(current)).length
    }
    const after: RollbackFileDiffSide = {
      exists: snapshot !== null, bytes: snapshot?.byteLength ?? file.bytes, lines: null,
      binary: false, oversized: snapshotOversized,
      unreadable: snapshot === null && !snapshotOversized,
    }
    if (snapshot !== null) {
      after.binary = looksBinary(snapshot)
      after.lines = after.binary ? null : splitDiffLines(DIFF_TEXT_DECODER.decode(snapshot)).length
    }
    const view: RollbackFileDiffResult = {
      ...base, ok: true, code: 'ok', path: file.path,
      status: currentExists ? 'overwrite' : 'create', before, after,
    }
    // 结构性不可比对：逐条给出原因（有原因 ⇒ hunks 恒为空，绝不给半截差异）
    if (snapshotOversized) return { ...view, reason: 'too-large' }
    if (snapshot === null) return { ...view, reason: 'missing-blob' }
    if (currentUnreadable) return { ...view, reason: 'unreadable' }
    if (currentOversized) return { ...view, reason: 'too-large' }
    if (before.binary || after.binary) return { ...view, reason: 'binary' }
    const result = diffLines(
      current === null ? '' : DIFF_TEXT_DECODER.decode(current),
      DIFF_TEXT_DECODER.decode(snapshot),
      { context: ROLLBACK_FILE_DIFF_LIMITS.context },
    )
    return {
      ...view,
      hunks: result.hunks, added: result.added, removed: result.removed,
      identical: result.identical, degraded: result.degraded,
    }
  }

  /* -------------------------------------------------------------- 回退 */

  private result(partial: RewindDraft): RollbackRewindResult {
    const out: RollbackRewindResult = {
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
    if (partial.guardPointId !== undefined) out.guardPointId = partial.guardPointId
    if (partial.childSessionId !== undefined) out.childSessionId = partial.childSessionId
    return out
  }

  private emptySegment(state: RollbackStateKind, code: RollbackCode, detail: string): RollbackSegmentResult {
    return { state, status: 'skipped', reasonCode: code, detail: [detail], restored: 0, failed: 0, leftovers: [], leftoversTruncated: false }
  }

  async rewind(input: RollbackRewindInput): Promise<RollbackRewindResult> {
    const warnings: RollbackGuidance[] = []
    const storage = await this.storageStatus()
    if (!storage.available) {
      return this.result({ outcome: 'failed', code: 'storage-unavailable', detail: storage.detail, id: input.id, storage, guidance: storage.guidance })
    }
    const ledger = await this.readLedger()
    if (ledger.error !== undefined) warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail: ledger.error })
    const record = ledger.records.find((r) => r.id === input.id)
    if (record === undefined) {
      return this.result({ outcome: 'failed', code: 'record-not-found', id: input.id, storage, warnings })
    }
    // 门 1（fail-closed 确认门）：必须恰好 true
    if (input.userConfirmed !== true) {
      return this.result({ outcome: 'denied', code: 'confirmation-required', detail: 'userConfirmed!==true', id: input.id, storage, warnings })
    }
    // 门 2：保护点不可回退。**注意：guard 不在此列**（t22 口径）—— 救援点允许作为回退目标，
    // 它是「回到回退前」的唯一路径；这里与 preview().canRestore 是同一份判定（逐条一致）。
    if (record.protected) {
      return this.result({ outcome: 'denied', code: 'protected-point', detail: record.id, id: input.id, storage, warnings })
    }
    // 门 3：两态不全的记录缺省拒绝（allowPartial 才放行）
    if (record.incomplete && input.allowPartial !== true) {
      return this.result({ outcome: 'denied', code: 'record-incomplete', id: input.id, storage, warnings })
    }
    const requested = input.segments !== undefined
      ? uniqueStates(input.segments)
      : statesForMode(input.mode)
    if (requested.length === 0) {
      return this.result({ outcome: 'denied', code: 'invalid-input', detail: 'segments empty', id: input.id, storage, warnings })
    }
    // S5：恢复前自动留救援点（guard）
    const guardPolicy = input.guardPolicy ?? this.guardPolicy
    let guardPointId: string | undefined
    if (guardPolicy !== 'off') {
      const sessionPayload = record.session.payload
      const wsPayload = record.workspace.payload
      const guard = await this.capturePoint({
        kind: 'guard',
        chunks: wsPayload?.chunks ?? [],
        note: 'pre-rewind guard for ' + record.id,
        sessionId: sessionPayload?.sessionId ?? record.sessionId,
        sessionLogPath: sessionPayload?.logPath ?? null,
        cursorSeq: sessionPayload?.cursorSeq ?? null,
        turnSeq: sessionPayload?.turnSeq ?? null,
        boundarySeq: sessionPayload?.boundarySeq ?? null,
        boundaryEndSeq: sessionPayload?.boundaryEndSeq ?? null,
        unitId: record.unitId,
      })
      // T10：成败判据 = **appendRecord 真的成功**（guard.ok），而不是「拿到了内存 record」。
      // 留不下救援点就是 S5 的硬门：require 档**整体中止、零写入、不返回 childSessionId**；
      // warn 档按既有策略只告警继续，但同样**不报** guardPointId（绝不报幽灵点）。
      if (guard.ok === true && guard.point !== undefined && (guardPolicy !== 'require' || !guard.point.incomplete)) {
        guardPointId = guard.point.id
      } else {
        const detail = guard.detail ?? guard.code
        if (guardPolicy === 'require') {
          return this.result({ outcome: 'failed', code: 'guard-failed', detail, id: input.id, storage, warnings })
        }
        warnings.push({ code: 'rollback.warn.guardFailed', detail })
      }
    }
    // 段：工作区失败即中止后面的段
    const segments: RollbackSegmentResult[] = []
    const skippedSegments: RollbackStateKind[] = []
    let aborted = false
    let childSessionId: string | undefined
    for (const state of ROLLBACK_REWIND_ORDER) {
      if (!requested.includes(state) || aborted) {
        skippedSegments.push(state)
        continue
      }
      const segment = state === 'workspace'
        ? await this.restoreWorkspace(record.workspace, { removeCreated: input.removeCreated === true })
        : await this.restoreSession(record.session)
      segments.push(segment)
      if (segment.childSessionId !== undefined) childSessionId = segment.childSessionId
      if (state === 'workspace' && segment.status === 'failed') aborted = true
    }
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)
    const anyFailed = segments.some((s) => s.status === 'failed')
    const workspaceFailed = segments.some((s) => s.state === 'workspace' && s.status === 'failed')
    const anySkipped = segments.some((s) => s.status === 'skipped')
    /**
     * E1：「没有可恢复的内容」不是失败（也**不再是 500**）：
     * - `status='restored' && restored===0`：段**执行过**、0 变更（工作区已与快照一致，
     *   或该态压根没有记录任何文件）；
     * - `status='skipped'`：该态没有可用的捕获 ⇒ 同样无事可做（reasonCode 如实回传）。
     * 只有**所有**被请求的段都无事可做，整体才是「成功、0 变更」= outcome 'restored' +
     * code 'nothing-to-restore'；只要有一段真的动了东西或真的失败，就按原口径判（partial / failed）。
     */
    const allNoop = segments.length > 0
      && segments.every((s) => s.status === 'skipped' || (s.status === 'restored' && s.restored === 0))
    let outcome: RollbackOutcome
    let code: RollbackCode
    if (workspaceFailed) {
      outcome = 'failed'
      code = 'restore-failed'
    } else if (allNoop) {
      outcome = 'restored'
      code = 'nothing-to-restore'
    } else if (anyFailed || anySkipped) {
      outcome = 'partial'
      code = anyFailed ? 'restore-failed' : 'ok'
    } else {
      outcome = 'restored'
      code = 'ok'
    }
    const guidance: RollbackGuidance[] = []
    for (const segment of segments) {
      for (const item of segment.guidance ?? []) guidance.push(item)
    }
    if (workspaceFailed) guidance.push({ code: 'rollback.guidance.workspaceRolledBack' })
    const draft: RewindDraft = { outcome, code, id: input.id, segments, skippedSegments, storage, guidance, warnings }
    if (guardPointId !== undefined) draft.guardPointId = guardPointId
    if (childSessionId !== undefined) draft.childSessionId = childSessionId
    return this.result(draft)
  }

  /**
   * S4/S5：只覆盖记录在案的路径。
   * 阶段 1 只读校验（任何一条不合格 → 零写入整体失败）→ 阶段 2 记前像 + 写 →
   * 阶段 3 逐文件 hash 复核；失败 → **整体回滚到恢复前状态**。
   */
  /**
   * 列出「回退点之后**新建**」且**允许删除**的路径（用户 2026-10-11 定案 A）。
   *
   * 与 scanLeftovers 用**同一次遍历口径**（`listChunkFiles`：同一套 skip 规则），区别只有一个：
   * 这里要的是**全量**清单（删除不能只删前 20 条），且逐条过 {@link createdRemovalRefusal} 安全判据。
   */
  private async planCreatedRemovals(
    chunks: readonly string[],
    captured: ReadonlySet<string>,
    sink: ChunkWalkSink,
  ): Promise<{ paths: string[]; skipped: string[]; truncated: boolean }> {
    const limit = Math.max(this.maxFiles * 4, 2000)
    const paths: string[] = []
    const skipped: string[] = []
    let truncated = false
    for (const chunk of chunks) {
      if (!path.isAbsolute(chunk)) continue
      const listed = await this.listChunkFiles(path.resolve(chunk), sink, limit)
      if (listed === null) continue
      if (listed.truncated) truncated = true
      for (const file of listed.files) {
        if (captured.has(pathKey(file))) continue
        // 拒删的也留在清单里（如实报告），但绝不进删除集合
        if (this.createdRemovalRefusal(file, chunks) !== null) { skipped.push(file); continue }
        paths.push(file)
      }
    }
    return { paths, skipped, truncated }
  }

  /**
   * 「这一条新建路径**不许删**」的判据（命中即拒删；每条都能被逐字解释，绝不靠启发式）。
   *
   * · 不在任何记录在案的分块内（chunk 之外不是我们的地盘）；
   * · 落在插件自己的数据区（`this.root`）内 —— 那是回滚台账/对象仓本身；
   * · 路径里出现 `.git` 或 `node_modules` 段（仓库元数据与依赖树：它们在回退点之后**天天在变**，
   *   按「新建」判据删掉等于毁掉工作副本）；
   * · 不是绝对路径。
   */
  private createdRemovalRefusal(file: string, chunks: readonly string[]): string | null {
    if (!path.isAbsolute(file)) return 'not-absolute'
    if (!chunks.some((chunk) => path.isAbsolute(chunk) && isInsidePath(file, chunk))) return 'outside-chunk'
    if (isInsidePath(file, this.root)) return 'inside-data-dir'
    const segments = path.resolve(file).split(path.sep)
    if (segments.includes('.git')) return 'excluded-dir'
    if (segments.includes('node_modules')) return 'excluded-dir'
    return null
  }

  private async restoreWorkspace(
    track: RollbackTrack<RollbackWorkspacePayload>,
    options: { removeCreated?: boolean } = {},
  ): Promise<RollbackSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('workspace', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    // E1：记录在案的条目数为 0 = 成功、0 变更（不是失败，更不是 500）
    // T10：**没有记录任何文件** 与「记录了但全部已一致」是两件不同的事，给不同的码
    // （界面据此说「该点没记录文件」而不是「工作区已与该点一致」）。
    if (payload.files.length === 0) return this.noopSegment('workspace', 'no-recorded-files', 'files=0 nothingToDo=true')
    const detail: string[] = []
    const writable: { file: RollbackWorkspaceFile; bytes: Uint8Array }[] = []
    let failed = 0
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
        writable.push({ file, bytes })
      } catch (error) {
        failed += 1
        pushDetail(detail, 'object-missing ' + file.path + ' ' + errorDetail(error))
      }
    }
    const captured = new Set(payload.files.map((f) => pathKey(f.path)))
    const sink: ChunkWalkSink = { skipped: [], excludedDirs: [], unreadableDirs: [], skippedCount: 0, skippedTruncated: false }
    const leftovers = await this.scanLeftovers(payload.chunks, captured, sink)
    // 用户 2026-10-11 定案 A：把「回退点之后新建」的路径也退回去（删除）。清单先算全，超上限整套拒绝。
    const removal = options.removeCreated === true
      ? await this.planCreatedRemovals(payload.chunks, captured, sink)
      : { paths: [] as string[], skipped: [] as string[], truncated: false }
    if (removal.paths.length > ROLLBACK_MAX_CREATED_REMOVALS) {
      detail.push('created-removals=' + String(removal.paths.length) + ' limit=' + String(ROLLBACK_MAX_CREATED_REMOVALS) + ' zeroWrites=true')
      return {
        state: 'workspace', status: 'failed', reasonCode: 'invalid-input', detail,
        restored: 0, failed: removal.paths.length,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        createdSkipped: removal.skipped,
      }
    }
    if (failed > 0) {
      // 零写入：一条不合格就不写任何一条
      detail.push('restored=0 failed=' + String(failed) + ' leftovers=' + String(leftovers.count) + ' zeroWrites=true')
      return {
        state: 'workspace', status: 'failed', reasonCode: 'invalid-path', detail,
        restored: 0, failed,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
      }
    }
    // E1：内容已与快照一致的条目**不再写** —— 「0 变更」就要是真的 0 次写入
    // （否则工作区已与该点一致时也会重写全部文件，白耗 I/O 并抖动 mtime）。
    const needed: { file: RollbackWorkspaceFile; bytes: Uint8Array }[] = []
    let unchanged = 0
    for (const item of writable) {
      let identical = false
      try {
        const stat = await fs.stat(item.file.path)
        if (stat.isFile() && stat.size === item.file.bytes) {
          identical = sha256Hex(await fs.readFile(item.file.path)) === item.file.sha256
        }
      } catch {
        identical = false
      }
      if (identical) {
        unchanged += 1
        continue
      }
      needed.push(item)
    }
    if (needed.length === 0 && removal.paths.length === 0) {
      // 记录在案的路径全都已与快照一致、且没有要删的新建路径 ⇒ 该段成功、0 变更（不是失败、也不中止整体）
      const noop = this.noopSegment('workspace', 'nothing-to-restore', 'unchanged=' + String(unchanged) + ' nothingToDo=true')
      noop.leftovers = leftovers.leftovers
      noop.leftoversTruncated = leftovers.truncated
      noop.createdSkipped = removal.skipped
      return noop
    }
    // 前像（内存）：失败时要能整体回到恢复前状态 —— 只覆盖**真会被写**的文件
    const pre: { path: string; existed: boolean; bytes: Uint8Array | null }[] = []
    for (const item of needed) {
      let bytes: Uint8Array | null = null
      try {
        bytes = await fs.readFile(item.file.path)
      } catch {
        bytes = null
      }
      pre.push({ path: item.file.path, existed: bytes !== null, bytes })
    }
    let restored = 0
    let writtenBytes = 0
    for (const item of needed) {
      try {
        await this.writeFile(item.file.path, item.bytes)
        restored += 1
        writtenBytes += item.bytes.byteLength
      } catch (error) {
        failed += 1
        pushDetail(detail, 'restore-failed ' + item.file.path + ' ' + errorDetail(error))
      }
    }
    // 阶段 3：逐文件复核（重新读回并核对 SHA-256）
    const mismatched: string[] = []
    if (failed === 0) {
      for (const item of needed) {
        try {
          const current = await fs.readFile(item.file.path)
          if (sha256Hex(current) !== item.file.sha256) mismatched.push(item.file.path)
        } catch {
          mismatched.push(item.file.path)
        }
      }
    }
    if (failed > 0 || mismatched.length > 0) {
      const rollbackFailed: string[] = []
      for (const item of pre) {
        try {
          if (item.existed && item.bytes !== null) await this.writeFile(item.path, item.bytes)
          else await fs.rm(item.path, { force: true })
        } catch (error) {
          rollbackFailed.push(item.path + ' ' + errorDetail(error))
        }
      }
      for (const target of mismatched) pushDetail(detail, 'verify-mismatch ' + target)
      for (const line of rollbackFailed) pushDetail(detail, 'rolled-back-failed ' + line)
      detail.push('restored=0 failed=' + String(failed + mismatched.length) + ' rolledBack=' + String(pre.length - rollbackFailed.length) + ' unchanged=' + String(unchanged))
      return {
        state: 'workspace', status: 'failed',
        reasonCode: mismatched.length > 0 ? 'verify-failed' : 'restore-failed',
        detail,
        restored: 0,
        failed: failed + mismatched.length,
        leftovers: leftovers.leftovers,
        leftoversTruncated: leftovers.truncated,
        guidance: [{ code: 'rollback.guidance.workspaceRolledBack', detail: rollbackFailed.length > 0 ? rollbackFailed.join(' ') : undefined }],
      }
    }
    // 阶段 4（用户 2026-10-11 定案 A）：删除「回退点之后新建」的路径。
    // 顺序刻死：记录在案的路径**先写并复核通过**，再删新建的 —— 先删后写一旦写失败就回不去了。
    // 删除同样可回滚：先读前像（内存）→ 删；任一失败就把已写的还原、把已删的写回。
    const destroyed: { path: string; bytes: Uint8Array }[] = []
    const removalFailures: string[] = []
    let removed = 0
    for (const target of removal.paths) {
      try {
        const bytes = await fs.readFile(target)
        if (bytes.byteLength > this.maxFileBytes) {
          pushDetail(detail, 'created-too-large ' + target)
          removal.skipped.push(target)
          continue
        }
        destroyed.push({ path: target, bytes })
        await fs.rm(target, { force: true })
        removed += 1
      } catch (error) {
        removalFailures.push(target + ' ' + errorDetail(error))
      }
    }
    if (removalFailures.length > 0) {
      const rollbackFailed: string[] = []
      for (const item of pre) {
        try {
          if (item.existed && item.bytes !== null) await this.writeFile(item.path, item.bytes)
          else await fs.rm(item.path, { force: true })
        } catch (error) {
          rollbackFailed.push(item.path + ' ' + errorDetail(error))
        }
      }
      for (const item of destroyed) {
        try {
          await this.writeFile(item.path, item.bytes)
        } catch (error) {
          rollbackFailed.push(item.path + ' ' + errorDetail(error))
        }
      }
      for (const line of removalFailures) pushDetail(detail, 'created-remove-failed ' + line)
      for (const line of rollbackFailed) pushDetail(detail, 'rolled-back-failed ' + line)
      detail.push(
        'restored=0 removed=0 failed=' + String(removalFailures.length) +
        ' rolledBack=' + String(pre.length + destroyed.length - rollbackFailed.length) +
        ' unchanged=' + String(unchanged),
      )
      return {
        state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail,
        restored: 0, failed: removalFailures.length,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        removed: 0, removedPaths: [], createdSkipped: removal.skipped,
        guidance: [{ code: 'rollback.guidance.workspaceRolledBack', detail: rollbackFailed.length > 0 ? rollbackFailed.join(' ') : undefined }],
      }
    }
    const removedPaths = removal.paths.slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT)
    detail.push(
      'restored=' + String(restored) + ' verified=' + String(needed.length) + ' unchanged=' + String(unchanged) +
      ' leftovers=' + String(leftovers.count) + ' removed=' + String(removed) + ' createdSkipped=' + String(removal.skipped.length),
    )
    return {
      state: 'workspace', status: 'restored', detail,
      restored, failed: 0,
      leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
      removed, removedPaths, createdSkipped: removal.skipped,
      writtenBytes,
    }
  }

  /**
   * S3：会话回退 = 在目标回合前的稳定边界 **fork 子会话**。
   * 原会话日志**只读**：本方法不写任何字节（旧版的静止期门 / 分叉门 / 字节写回全部下线）。
   */
  private async restoreSession(track: RollbackTrack<RollbackSessionPayload>): Promise<RollbackSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('session', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    if (payload.sessionId === null) {
      const segment = this.emptySegment('session', 'session-missing', 'sessionId=null')
      segment.status = 'failed'
      return segment
    }
    if (payload.boundarySeq === null) {
      const segment = this.emptySegment('session', 'no-boundary', 'turn=' + String(payload.turnSeq ?? 'unknown') + ' startSeq=0')
      segment.status = 'failed'
      return segment
    }
    if (this.forkSeam === undefined) {
      const segment = this.emptySegment('session', 'session-fork-unavailable', 'no fork seam injected')
      segment.status = 'failed'
      segment.guidance = [{ code: 'rollback.guidance.forkUnavailable', detail: payload.sessionId }]
      return segment
    }
    try {
      const outcome = await this.forkSeam({ sessionId: payload.sessionId, boundarySeq: payload.boundarySeq })
      if (!outcome.ok) {
        const segment = this.emptySegment('session', outcome.code, outcome.detail ?? outcome.code)
        segment.status = 'failed'
        return segment
      }
      // 归位失败（宿主三档都没命中）**不静默**：会话确实回退了，但它会在侧栏落到
      // 「未分组」——多一条指引如实说明，别让用户以为回退把对话"弄丢了"。
      const notAttached = typeof outcome.warning === 'string' && outcome.warning !== ''
      return {
        state: 'session',
        status: 'restored',
        detail: [
          'forked session=' + payload.sessionId,
          'boundary=' + String(payload.boundarySeq),
          'child=' + outcome.childSessionId,
          'logUnchanged=true',
          'workspaceAttached=' + (notAttached ? 'false' : 'true'),
        ],
        restored: 1,
        failed: 0,
        leftovers: [],
        leftoversTruncated: false,
        childSessionId: outcome.childSessionId,
        guidance: notAttached
          ? [
            { code: 'rollback.guidance.sessionForked', detail: outcome.childSessionId },
            { code: 'rollback.guidance.sessionNotAttached', detail: outcome.childSessionId },
          ]
          : [{ code: 'rollback.guidance.sessionForked', detail: outcome.childSessionId }],
      }
    } catch (error) {
      const segment = this.emptySegment('session', 'fork-failed', errorDetail(error))
      segment.status = 'failed'
      return segment
    }
  }

  /* -------------------------------------------------------------- 删除 */

  /**
   * 删除一个回滚点。保护点与 guard 点**一律拒绝**（「不删被保护点」，用户删不掉 guard；
   * guard 的增长靠 `maxGuardsPerSession` 自动淘汰，见 ROLLBACK_MAX_GUARDS_PER_SESSION），
   * 没有 force 后门。成功后回收无人引用的对象（best-effort）。
   *
   * 整段「读 → 判 → 写 → 回收」都在 {@link withLedgerWriteLock} 队列里：否则并发的自动留点
   * 会在本方法的读与写之间插入一次 append，把刚删掉的点**复活**（评审 20 轮实测 12 轮复现）。
   */
  async remove(id: string): Promise<RollbackRemoveResult> {
    const storage = await this.storageStatus()
    if (!storage.available) return { ok: false, code: 'storage-unavailable', detail: storage.detail, id }
    return await withLedgerWriteLock<RollbackRemoveResult>(this.ledgerPath, async () => {
      const ledger = await this.readLedger()
      const record = ledger.records.find((r) => r.id === id)
      if (record === undefined) return { ok: false, code: 'record-not-found', id }
      if (record.protected || record.kind === 'guard') {
        return { ok: false, code: 'protected-point', detail: record.kind, id }
      }
      const kept = ledger.records.filter((r) => r.id !== id)
      try {
        await atomicWriteFile(this.ledgerPath, JSON.stringify({ schemaVersion: ROLLBACK_SCHEMA_VERSION, records: kept }, null, 2))
      } catch (error) {
        return { ok: false, code: 'ledger-write-failed', detail: errorDetail(error), id }
      }
      await this.gcObjects(kept)
      return { ok: true, code: 'deleted', id }
    })
  }
}

function uniqueStates(states: readonly RollbackStateKind[]): RollbackStateKind[] {
  const out: RollbackStateKind[] = []
  for (const state of states) {
    if ((state === 'workspace' || state === 'session') && !out.includes(state)) out.push(state)
  }
  return out
}

/* ---------------------------------------------------------------- 自动留点 */

/** 会话登记（宿主订阅 session/event 时按会话登记一次）。 */
export interface RollbackSessionBinding {
  sessionId: string
  /** 会话单元键 <projectKey>/<sessionId>（界面展示 / 归属） */
  unitId?: string | null
  /** 会话日志绝对路径（能拿到就给；只作审计，回退走 fork） */
  logPath?: string | null
  /** 工作区快照分块（通常 = 会话 cwd）；缺省 = 只留会话态（该点 incomplete） */
  chunks?: readonly string[]
}

export interface RollbackTrackedEvent {
  sessionId: string
  seq: number
  type: string
  data?: unknown
  /**
   * 事件的写入面（DSH 的顶层 `surfaceOp`；`'append'` = 用户新发的一条消息）。
   *
   * 为什么留点器需要它：**排队中的用户消息**（上一回合还在跑时发出的那条）会先落成
   * `user/message(surfaceOp='append')` / `agent/inbox/spliced`，**再**出现下一个 `turn/start`。
   * 若边界直接取 `startSeq - 1`，这些「还没被消费的输入」会被切进子会话 ——
   * 真机表现就是「回退后的对话变成排队发送里的一条消息」（2026-10-11 用户反馈）。
   */
  surfaceOp?: string
}

/**
 * 「还没被任何回合消费的输入」的判据（与 DSH 的 latestCompletedPrefixBoundary 同口径）：
 *  · `user/message` 且 `surfaceOp === 'append'`（用户新发的一条）；
 *  · `agent/inbox/spliced`（排队输入被并入）。
 * 只在**没有未收尾回合**时才当成待消费输入（回合内的同类事件属于当前回合）。
 */
function isPendingInputEvent(event: RollbackTrackedEvent): boolean {
  if (event.type === 'agent/inbox/spliced') return true
  return event.type === 'user/message' && event.surfaceOp === 'append'
}

export interface RollbackTrackerOptions {
  engine: RollbackPointEngine
  now?: () => number
  /** 轮询回退间隔（≤5 s） */
  pollIntervalMs?: number
  log?: (line: string) => void
  /** 会话日志 stat 探针（轮询回退用） */
  statSessionLog?: (logPath: string) => Promise<{ size: number; mtimeMs: number } | undefined>
}

export interface RollbackTrackerResult {
  captured: boolean
  pointId?: string
  code?: RollbackCode
  detail?: string
}

/**
 * session/event 载荷的窄化结果（F-2）：形状不符走**显式机器码**，绝不静默回落到「什么都不做」。
 * 宿主拿到 ok:false 必须记日志/上报，而不是当成「这个事件不需要留点」。
 */
export type RollbackEventNarrowResult =
  | { ok: true; event: RollbackTrackedEvent }
  | { ok: false; code: RollbackCode; detail: string }

/**
 * 把 DSH 的 session/event 载荷窄化成留点器认识的最小形状（seq / type / 透传 data）。
 * core 不认识 DSH 的事件类型：只做**形状**校验，语义判断（turn/end 才留点）在 noteEvent 里。
 */
export function rollbackTrackedEventOf(sessionId: string, event: unknown): RollbackEventNarrowResult {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, code: 'invalid-input', detail: 'session-id-missing' }
  }
  if (event === null || typeof event !== 'object') {
    return { ok: false, code: 'invalid-input', detail: 'event-not-object' }
  }
  const seq = (event as { seq?: unknown }).seq
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return { ok: false, code: 'invalid-input', detail: 'event-seq-missing' }
  }
  const type = (event as { type?: unknown }).type
  if (typeof type !== 'string' || type === '') {
    return { ok: false, code: 'invalid-input', detail: 'event-type-missing' }
  }
  const out: RollbackTrackedEvent = { sessionId, seq, type }
  const data = (event as { data?: unknown }).data
  if (data !== undefined) out.data = data
  const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
  if (typeof surfaceOp === 'string' && surfaceOp !== '') out.surfaceOp = surfaceOp
  return { ok: true, event: out }
}

/**
 * 一次 live Session → 留点器的会话登记（F-2）。
 *
 * 工作区快照分块取 `session.header.cwd`（DSH 记录会话创建时的绝对工作目录）；cwd 缺失或
 * 非绝对时**不给分块** —— 那个点只留会话态（`incomplete=true` + workspace.reasonCode
 * `no-chunks`），由界面如实展示，**绝不**拿别的目录凑数；`chunkless` 给出机器码供宿主记录。
 * 会话日志路径不在这里猜：回退走 `fork(sessionId, boundarySeq)`（S3），引擎不依赖日志路径。
 */
export type RollbackBindingNarrowResult =
  | { ok: true; binding: RollbackSessionBinding; chunkless: 'cwd-missing' | 'cwd-not-absolute' | null }
  | { ok: false; code: RollbackCode; detail: string }

export function rollbackSessionBindingOf(session: unknown): RollbackBindingNarrowResult {
  if (session === null || typeof session !== 'object') {
    return { ok: false, code: 'invalid-input', detail: 'session-not-object' }
  }
  const id = (session as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    return { ok: false, code: 'invalid-input', detail: 'session-id-missing' }
  }
  const header = (session as { header?: unknown }).header
  const cwd = header !== null && typeof header === 'object' ? (header as { cwd?: unknown }).cwd : undefined
  if (typeof cwd !== 'string' || cwd === '') return { ok: true, binding: { sessionId: id }, chunkless: 'cwd-missing' }
  if (!path.isAbsolute(cwd)) return { ok: true, binding: { sessionId: id }, chunkless: 'cwd-not-absolute' }
  const binding: RollbackSessionBinding = { sessionId: id, chunks: [cwd], unitId: projectKeyOf(cwd) + '/' + id }
  return { ok: true, binding, chunkless: null }
}

/**
 * 回合自动留点器（S1）。
 *
 * **主路径 = 事件驱动**：宿主订阅 `session/event`，把每个事件交给 `noteEvent`；
 * 见到 `turn/end` 就为当前会话留一个回滚点（工作区快照 + 会话游标 + fork 边界）。
 * 边界来自该回合的 `turn/start`：`boundarySeq = startSeq - 1`（startSeq=0 → 无前置边界）。
 *
 * **回退路径 = mtime 轮询**（宿主拿不到事件订阅时）：`start()` 起 ≤5 s 的定时器，
 * 日志 size/mtime 变了就留一个点。轮询**拿不到回合边界**（core 不解析日志字节），
 * 因此这些点只有工作区态 + 会话游标，`boundarySeq=null` → 会话回退会结构化 `no-boundary`。
 *
 * 幂等：同一会话同一回合只留一次（重复事件 / 重复轮询都不会重复留点）。
 */
export class RollbackAutoTracker {
  private readonly engine: RollbackPointEngine
  private readonly nowFn: () => number
  private readonly pollIntervalMs: number
  private readonly log: ((line: string) => void) | undefined
  private readonly statSessionLog: ((logPath: string) => Promise<{ size: number; mtimeMs: number } | undefined>) | undefined
  private readonly bindings = new Map<string, RollbackSessionBinding>()
  private readonly open = new Map<string, { turn: number | null; startSeq: number; boundarySeq: number | null }>()
  /**
   * 每个会话「尚未被回合消费的输入」的首个 seq（排队发送的用户消息 / inbox 拼接）。
   * 见 {@link RollbackTrackedEvent.surfaceOp} 的说明与 {@link isPendingInputEvent}。
   */
  private readonly pendingInput = new Map<string, number>()
  private readonly lastBoundary = new Map<string, number>()
  private readonly seenTurns = new Map<string, Set<string>>()
  private readonly lastStat = new Map<string, { size: number; mtimeMs: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private mechanism: 'event' | 'poll' = 'event'

  constructor(options: RollbackTrackerOptions) {
    this.engine = options.engine
    this.nowFn = options.now ?? (() => Date.now())
    this.pollIntervalMs = Math.min(
      options.pollIntervalMs ?? ROLLBACK_DEFAULT_POLL_INTERVAL_MS,
      ROLLBACK_DEFAULT_POLL_INTERVAL_MS,
    )
    this.log = options.log
    this.statSessionLog = options.statSessionLog
  }

  /** 实际采用的留点机制（output / 诊断用） */
  get mechanismKind(): 'event' | 'poll' {
    return this.mechanism
  }

  registerSession(binding: RollbackSessionBinding): void {
    this.bindings.set(binding.sessionId, binding)
  }

  unregisterSession(sessionId: string): void {
    this.bindings.delete(sessionId)
    this.open.delete(sessionId)
    this.pendingInput.delete(sessionId)
    this.lastStat.delete(sessionId)
  }

  private warn(line: string): void {
    try { this.log?.(line) } catch { /* 日志失败绝不影响主流程 */ }
  }

  private async captureFor(binding: RollbackSessionBinding, info: {
    turn: number | null
    boundarySeq: number | null
    endSeq: number | null
  }): Promise<RollbackTrackerResult> {
    const result = await this.engine.capturePoint({
      kind: 'auto',
      sessionId: binding.sessionId,
      unitId: binding.unitId ?? null,
      sessionLogPath: binding.logPath ?? null,
      turnSeq: info.turn,
      boundarySeq: info.boundarySeq,
      boundaryEndSeq: info.endSeq,
      chunks: binding.chunks ?? [],
      note: this.mechanism === 'poll' ? 'auto:poll' : 'auto:turn',
    })
    // T10：写台账失败（ok=false）绝不算留点成功 —— 否则 tracker 会记住一个台账里不存在的 pointId，
    // 后续 rewind/详情都查不到它。（capturePoint 失败时也不再回传 point，这条判据是第二道保险。）
    if (result.ok !== true || result.point === undefined) {
      return { captured: false, code: result.code, detail: result.detail }
    }
    if (info.turn !== null) {
      const seen = this.seenTurns.get(binding.sessionId) ?? new Set<string>()
      seen.add(String(info.turn))
      this.seenTurns.set(binding.sessionId, seen)
    }
    if (info.endSeq !== null) this.lastBoundary.set(binding.sessionId, info.endSeq)
    return { captured: true, pointId: result.point.id, code: result.code }
  }

  /**
   * 事件驱动的入口。宿主订阅 session/event 后把事件窄化成 {@link RollbackTrackedEvent} 再喂进来。
   * 绝不对未知事件抛错（宿主回调必须 try/catch 也就够了，但这里也不抛）。
   */
  async noteEvent(event: RollbackTrackedEvent): Promise<RollbackTrackerResult> {
    try {
      this.mechanism = 'event'
      const binding = this.bindings.get(event.sessionId)
      if (binding === undefined) return { captured: false, code: 'invalid-input', detail: 'unknown-session ' + event.sessionId }
      // 未开回合时出现的「待消费输入」属于**下一个**回合：边界必须落在它之前，
      // 否则排队发送的那条消息会被切进子会话（真机 = 回退后停在「排队发送」一条消息上）。
      if (!this.open.has(event.sessionId) && !this.pendingInput.has(event.sessionId) && isPendingInputEvent(event)) {
        this.pendingInput.set(event.sessionId, event.seq)
      }
      if (event.type === 'turn/start') {
        const inputSeq = this.pendingInput.get(event.sessionId)
        const from = inputSeq ?? event.seq
        const turn = turnOfData(event.data)
        this.open.set(event.sessionId, {
          turn,
          startSeq: event.seq,
          boundarySeq: from > 0 ? from - 1 : null,
        })
        this.pendingInput.delete(event.sessionId)
        if (turn !== null) {
          const seen = this.seenTurns.get(event.sessionId)
          if (seen !== undefined && seen.has(String(turn))) return { captured: false, detail: 'already-captured turn=' + String(turn) }
        }
        // **留点发生在回合开始之前**（用户 2026-10-11 定案）：点的「工作区态」必须是**这条消息之前**的样子。
        // 旧口径在 turn/end 才拍工作区 ⇒ 回退时只能把文件写回「这个回合结束后」的状态（真机症状：
        // 预览说「工作区与该回退点一致」，而被这一回合改过的文件一个都没退回去）。
        // 参照实现（dsh-turn-rewind / Change Ledger）也是「先把工作区拍在消息那一刻，再让 agent 去改」。
        return await this.captureFor(binding, {
          turn,
          boundarySeq: from > 0 ? from - 1 : null,
          endSeq: null,
        })
      }
      if (event.type !== 'turn/end') return { captured: false }
      // 回合结束只为「缺省边界」留个记号（轮询/无边界回退用它），不再拍点。
      this.open.delete(event.sessionId)
      this.lastBoundary.set(event.sessionId, event.seq)
      return { captured: false }
    } catch (error) {
      this.warn('rollback tracker noteEvent failed: ' + errorDetail(error))
      return { captured: false, code: 'capture-failed', detail: errorDetail(error) }
    }
  }

  private async defaultStat(logPath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
      const stat = await fs.stat(logPath)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return undefined
    }
  }

  /**
   * 轮询回退：日志 size/mtime 变了就留一个点（**无回合边界**）。
   * 首次见到某会话只记基线（不立刻留点），避免把「历史文件」当成新回合。
   */
  async pollOnce(): Promise<RollbackTrackerResult[]> {
    const out: RollbackTrackerResult[] = []
    for (const binding of this.bindings.values()) {
      const logPath = binding.logPath
      if (logPath === undefined || logPath === null || logPath === '') continue
      let stat: { size: number; mtimeMs: number } | undefined
      try {
        stat = this.statSessionLog !== undefined ? await this.statSessionLog(logPath) : await this.defaultStat(logPath)
      } catch (error) {
        this.warn('rollback tracker stat failed: ' + errorDetail(error))
        continue
      }
      if (stat === undefined) continue
      const prev = this.lastStat.get(binding.sessionId)
      this.lastStat.set(binding.sessionId, stat)
      if (prev === undefined) continue
      if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue
      out.push(await this.captureFor(binding, { turn: null, boundarySeq: null, endSeq: null }))
    }
    return out
  }

  /** 起轮询定时器（≤5 s）。已起则幂等返回。 */
  start(): void {
    if (this.timer !== null) return
    this.mechanism = 'poll'
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => { this.warn('rollback tracker poll failed: ' + errorDetail(error)) })
    }, this.pollIntervalMs)
    const handle = this.timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 当前时钟（测试用；保持与引擎 now 同源语义） */
  now(): number {
    return this.nowFn()
  }
}
