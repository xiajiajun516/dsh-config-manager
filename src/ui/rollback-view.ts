/**
 * rollback-point（**工作区 + 会话回滚**）的**展示模型**（框架无关纯函数，node 可测）。
 *
 * 数据来自宿主 /recovery/rollback-points 族的 6 条子路径（list / storage / <id> / <id>/preview /
 * <id>/rewind / <id>/delete；第 3 条 <id> 单条详情同样进端口 —— 面板要能深链到某个点）。
 * 宿主把它挂在既有 recovery **prefix 路由**内部按 path 分发，因此不新增注册路由条目。
 *
 * 三条纪律（与旧检查点展示模型同源，改名不改口径）：
 *  ① **不 import src/core/rollback-point.ts（或任何 core 模块）** —— 那条链经 node:fs 依赖宿主运行时，
 *     一旦进 client bundle，DSH loader 会报 missed the module table（AGENTS.md 的 client bundle 铁律）。
 *     因此这里按「线协议结构子集」重新声明类型（字段只取展示所需，缺字段一律回落安全值）。
 *  ② **本模块不产出任何用户可见文案**：只回传字典键（rollback.*），zh/en 在 recovery-locales.ts。
 *  ③ **未知码 / 未知态 / 未知来源一律回落 unknown 键，绝不裸渲染机器码**；用户自由文本（note）与
 *     宿主技术细节（detail / guidance.detail / 路径清单）一律先过 redact()（AGENTS.md UI 硬性规则 7）。
 *
 * 两态纪律（S2）：只有 `workspace` 与 `session`。第三态 `config` 与「同点判定」已随检查点一起删除：
 * 任何非两态的 state 字符串都回落 rollback.state.unknown，本模块**不出现** config 态。
 *
 * 线协议形状（与 T1 宿主侧 src/core/rollback-point.ts 逐字段对齐，2026-10-10 双人确认）：
 *  - points[] = { id, createdAt, sessionId, turn, kind, protected, incomplete, note, spreadMs, segments:[…] }，
 *    segments **恒为 [workspace, session] 两项**；
 *  - preview.workspace = { overwrite, different, missing, createdAfter(数), leftovers(路径清单,≤20), leftoversTruncated }，
 *    preview.session = { from, to, turns, cursorNow, cursorTarget, restorable, active, reasonCode }
 *    （from = 目标回合开始前最后一个事件的 seq，即 fork 的 inclusive 边界；turns = 回合号）；
 *  - rewind.segments[] = { state, status, reasonCode?, detail[], restored, failed, leftovers[], leftoversTruncated, childSessionId?, guidance? }。
 */
import { redact } from '../security/redaction.ts'
import type { DiffHunk } from '../utils/line-diff.ts'

/* ------------------------------------------------------------ 两态 / 三选一 mode */

/** 只保留两态（S2）：工作区 + 会话。 */
export const ROLLBACK_STATES = ['workspace', 'session'] as const
export type RollbackState = (typeof ROLLBACK_STATES)[number]

/** 段名 → 是否为受支持的段（出现别的段一律按未知处理，绝不假设它是第三态）。 */
export function isRollbackState(value: unknown): value is RollbackState {
  return value === 'workspace' || value === 'session'
}

/**
 * 回退范围三选一（冻结 wire contract 的 `mode`）：
 *  - `files+session`：工作区文件 + 会话（新子会话）一起回退；
 *  - `files`：只回退工作区文件；
 *  - `session`：只回退会话（fork 子会话）。
 */
export const ROLLBACK_MODES = ['files+session', 'files', 'session'] as const
export type RollbackMode = (typeof ROLLBACK_MODES)[number]

export function isRollbackMode(value: unknown): value is RollbackMode {
  return value === 'files+session' || value === 'files' || value === 'session'
}

/** mode → 段集合（workspace 段 = 工作区文件；session 段 = 会话）。 */
export function rollbackModeSegments(mode: string | null | undefined): RollbackState[] {
  if (mode === 'files') return ['workspace']
  if (mode === 'session') return ['session']
  if (mode === 'files+session') return ['workspace', 'session']
  return []
}

/**
 * 该 mode 在当前可回退段集合下**是否可选**（界面据此禁用注定失败的选项）。
 *
 * 例：某点没有稳定边界（session 段 restorable=false）时，`session` 与 `files+session` 都不可选 ——
 * 绝不发一个宿主一定会拒绝的请求。
 */
export function rollbackModeAvailable(mode: string | null | undefined, availableSegments: readonly string[]): boolean {
  const needed = rollbackModeSegments(mode)
  return needed.length > 0 && needed.every((state) => availableSegments.includes(state))
}

/** 段集合 → mode（三选一；空集合回落 `files+session`，因为那正是自动点缺省该回退的两态）。 */
export function rollbackModeFromSegments(segments: readonly string[]): RollbackMode {
  const hasWorkspace = segments.includes('workspace')
  const hasSession = segments.includes('session')
  if (hasWorkspace && !hasSession) return 'files'
  if (hasSession && !hasWorkspace) return 'session'
  return 'files+session'
}

/* ------------------------------------------------------------ 字典键映射（绝不裸渲染） */

export const ROLLBACK_STATE_UNKNOWN_KEY = 'rollback.state.unknown'
export const ROLLBACK_MODE_UNKNOWN_KEY = 'rollback.mode.unknown'
export const ROLLBACK_CODE_UNKNOWN_KEY = 'rollback.code.unknown'
export const ROLLBACK_GUIDANCE_UNKNOWN_KEY = 'rollback.guidance.unknown'
export const ROLLBACK_KIND_UNKNOWN_KEY = 'rollback.kind.unknown'

const STATE_KEYS: Record<RollbackState, string> = {
  workspace: 'rollback.state.workspace',
  session: 'rollback.state.session',
}

const MODE_KEYS: Record<RollbackMode, string> = {
  'files+session': 'rollback.mode.filesAndSession',
  files: 'rollback.mode.filesOnly',
  session: 'rollback.mode.sessionOnly',
}

/**
 * code 白名单：**只有这些码进字典**，其余一律回落 unknown ——
 * 宿主若新增码而字典没跟上，界面显示「未识别的错误码」而不是把机器码拼上屏。
 *
 * 与宿主引擎 `src/core/rollback-point.ts` 的 `RollbackCode` 联合**逐条对应**（core 不能进
 * client bundle，所以只能在这里镜像一份；t3 已按 T1 的最终码表补齐 31 条，t10 补
 * `no-recorded-files` ⇒ 32 条）。顶层 code 与 segments[].reasonCode / warnings 共用同一枚举，
 * 所以一份白名单同时服务三处渲染。
 *
 * ⚠️ **这份镜像与引擎码表的等价性有守卫**：`rollback-view.test.ts` 的「码表镜像 != 引擎码表即红」
 * 用例从 `src/core/rollback-point.ts` 源码级读出 `RollbackCode` union，双向断言集合相等
 * （引擎新增码忘了补这里、或这里多写了引擎没有的码，都会立刻变红 —— 本次 t10 的
 * `no-recorded-files` 就是因为缺这条对照而静默漂移过一轮）。
 */
export const ROLLBACK_CODES: readonly string[] = [
  'ok',
  'deleted',
  // 冻结契约的 9 条
  'confirmation-required',
  'protected-point',
  'record-not-found',
  'record-incomplete',
  'invalid-input',
  // 待删的「该点未记录」路径超上限 ⇒ 整套拒绝、零写入（绝不删一半；顶层 code，不是泛化的 invalid-input）
  'created-removals-limit',
  'no-boundary',
  'storage-unavailable',
  'mutation-locked',
  'method-not-allowed',
  // 台账 / 存储
  'ledger-unreadable',
  'ledger-write-failed',
  // 工作区写回（记录校验 / 对象仓 / 写后复验 / 无事可做）
  'invalid-path',
  'object-missing',
  'object-hash-mismatch',
  'restore-failed',
  'verify-failed',
  'nothing-to-restore',
  // T10：该态**没有记录任何文件**（工作区段 files=0）—— 与「记录了但全部已一致」严格分开，
  // 只出现在 segments[].reasonCode（不是顶层 code）；界面据此说两句不同的话（t11）。
  'no-recorded-files',
  // 救援点（S5 guard）
  'guard-failed',
  // 会话（fork 子会话；原会话日志只读）
  'session-missing',
  'session-out-of-root',
  'session-too-large',
  'session-active',
  // 子代理会话（origin=subagent）：**不自动留点** —— 出现即代表该会话被有意跳过（宿主日志留痕）
  'subagent-session',
  'session-fork-unavailable',
  'fork-failed',
  // 自动留点（工作区快照）
  'capture-failed',
  'capture-truncated',
  'capture-degraded',
  'no-chunks',
  'chunk-not-absolute',
  'chunk-not-found',
  // 单文件差异（「查看」的数据源）：该路径**不在**这个回滚点的记录里
  'file-not-recorded',
]

/**
 * 已知指引码后缀（T1 引擎实际产出；白名单外回落 unknown）。
 *
 * 引擎回传的是**完整字典键**（rollback.guidance.workspaceRolledBack），旧检查点引擎回传的是
 * **裸后缀**（workspacePartial）—— 映射两种形态都认，避免把已知指引误判成 unknown
 * （那会让「工作区已回滚 / 已 fork 子会话」这类关键事实消失）。
 */
export const ROLLBACK_GUIDANCE_CODES: readonly string[] = [
  'mountStorage', 'fixDataDir', 'readOnlyFallback', 'probeDetail',
  'workspaceRolledBack', 'forkUnavailable', 'sessionForked', 'sessionNotAttached',
]

/** 已知告警码后缀（warnings 走独立一族 rollback.warn.*；白名单外回落 rollback.warn.unknown）。 */
export const ROLLBACK_WARN_CODES: readonly string[] = [
  'ledgerUnreadable', 'trackMissing', 'trackDegraded', 'protected', 'guardFailed',
  // t2：删除集被整体拒绝的**成因**（忽略目录 / 路径索引缺失 / 目录读不出）—— 必须能说清为什么没删
  'createdRefused',
]

export const ROLLBACK_WARN_UNKNOWN_KEY = 'rollback.warn.unknown'

/**
 * 指引 / 告警码 → 字典键。三种形态都认：
 *  - 完整键 `rollback.guidance.X` / `rollback.warn.X`（T1 引擎）；
 *  - 裸后缀 `X`（旧检查点引擎）。
 * 未知一律回落 unknown 键，**绝不裸渲染机器码**。
 */
function rollbackNoticeKey(code: unknown): string {
  if (typeof code !== 'string' || code === '') return ROLLBACK_GUIDANCE_UNKNOWN_KEY
  if (code.startsWith('rollback.warn.')) {
    const bare = code.slice('rollback.warn.'.length)
    return ROLLBACK_WARN_CODES.includes(bare) ? 'rollback.warn.' + bare : ROLLBACK_WARN_UNKNOWN_KEY
  }
  const bare = code.startsWith('rollback.guidance.') ? code.slice('rollback.guidance.'.length) : code
  return ROLLBACK_GUIDANCE_CODES.includes(bare) ? 'rollback.guidance.' + bare : ROLLBACK_GUIDANCE_UNKNOWN_KEY
}

/** 段名 → 字典键（非两态回落 unknown，绝不裸渲染）。 */
export function rollbackStateKey(state: string | null | undefined): string {
  return isRollbackState(state) ? STATE_KEYS[state] : ROLLBACK_STATE_UNKNOWN_KEY
}

/** mode → 字典键（三选一；其它回落 unknown）。 */
export function rollbackModeKey(mode: string | null | undefined): string {
  return isRollbackMode(mode) ? MODE_KEYS[mode] : ROLLBACK_MODE_UNKNOWN_KEY
}

const GUARD_KEYS: Record<RollbackGuardPolicy, string> = {
  require: 'rollback.guard.require',
  warn: 'rollback.guard.warn',
  off: 'rollback.guard.off',
}

/** 救援点策略（S5 guard）→ 字典键（未知回落 unknown）。 */
export function rollbackGuardPolicyKey(policy: string | null | undefined): string {
  return policy === 'require' || policy === 'warn' || policy === 'off' ? GUARD_KEYS[policy] : 'rollback.guard.unknown'
}

/** 机器码 → 字典键（白名单外回落 unknown）。 */
export function rollbackCodeKey(code: string | null | undefined): string {
  if (typeof code !== 'string' || code === '') return ROLLBACK_CODE_UNKNOWN_KEY
  return ROLLBACK_CODES.includes(code) ? 'rollback.code.' + code : ROLLBACK_CODE_UNKNOWN_KEY
}

export interface RollbackGuidance { code: string; detail?: string }
export interface RollbackGuidanceRowView { key: string; detail: string | null }

/** 指引 / 告警：code → rollback.guidance.* / rollback.warn.*（三种形态都认），detail 过 redact。 */
export function rollbackGuidanceRows(items: readonly RollbackGuidance[] | undefined): RollbackGuidanceRowView[] {
  return (items ?? []).map((item) => ({
    key: rollbackNoticeKey(item.code),
    detail: item.detail !== undefined && item.detail !== '' ? redact(item.detail) : null,
  }))
}

/* ------------------------------------------------------------ 留存口径（S6） */

/**
 * 每会话最多保留的**自动点**（超出只淘汰最旧的自动点 —— 引擎 selectPrune 的自动点桶）。
 * 救援点（guard）不占这个额度、也不被它淘汰，但有自己的**两道**上限
 * （每会话引擎 ROLLBACK_MAX_GUARDS_PER_SESSION / 全局 ROLLBACK_MAX_GUARDS）。
 */
export const ROLLBACK_MAX_POINTS_PER_SESSION = 20
/** 全局最多保留的**自动点**（同上，只淘汰最旧的自动点）。 */
export const ROLLBACK_MAX_POINTS_TOTAL = 50
/** 每会话最多保留的**救援点**（guard）：超出只淘汰最旧的救援点；数值 = 引擎 ROLLBACK_MAX_GUARDS_PER_SESSION。 */
export const ROLLBACK_MAX_POINTS_GUARDS_PER_SESSION = 20
/**
 * **全局**最多保留的**救援点**（guard）：与 ROLLBACK_MAX_POINTS_TOTAL **互相独立**
 * （两类各计预算，谁也不吃谁额度；数值相同不是耦合），超出只淘汰最旧的救援点。
 * 数值 = 引擎 ROLLBACK_MAX_GUARDS（两侧必须同步，T17 用例逐句钉住）。
 */
export const ROLLBACK_MAX_POINTS_GUARDS_TOTAL = 50

/**
 * 预览不可回退时的原因键（按宿主真实形状分派；**绝不回落 rollback.code.unknown**）。
 *
 * 注意（t22 冻结口径）：救援点**可以**作为回退目标 —— 引擎 canRestore = !protected && !incomplete &&
 * 至少一段可恢复（**不含** kind!=='guard'，见 src/core/rollback-point.ts:1531）。所以这个键**只在
 * 宿主真的拒绝了一个看起来可恢复的救援点**（canRestore=false 且不是 protected/incomplete/无可用段）时使用，
 * 不是「救援点一律不可回退」。
 */
export const ROLLBACK_PREVIEW_REASON_GUARD_KEY = 'rollback.preview.reason.guard'
export const ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY = 'rollback.preview.reason.incomplete'
export const ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY = 'rollback.preview.reason.hostRefused'

/* ------------------------------------------------------------ 线协议类型（结构子集） */

export type RollbackPointKind = 'auto' | 'guard'
export type RollbackOutcome = 'restored' | 'partial' | 'failed' | 'denied'
export type RollbackSegmentStatus = 'restored' | 'skipped' | 'failed'
export type RollbackGuardPolicy = 'require' | 'warn' | 'off'

/** 单段摘要（恒为 workspace / session 两项；state 用 string 以便未知值也能被映射成 unknown 键）。 */
export interface RollbackSegmentSummary {
  state: string
  ok?: boolean
  degraded?: boolean
  capturedAt?: number
  reasonCode?: string | null
  /** 该段捕获的条目数（工作区文件数 / 会话 0|1） */
  entries?: number
  bytes?: number
  /** 会话段：游标（seq） */
  cursorBytes?: number | null
  /** 该段**可回退**（有内容副本 / 有可写回条目） */
  restorable?: boolean
  /** 留点时的**跳过条目总数**（工作区态：skipped + excludedDirs；会话态恒 0）—— S4「跳过并如实报告」 */
  skippedCount?: number
  /** 该段捕获是否被上限截断（工作区态 = 单文件上限 / 字节预算 / 文件数预算任一命中） */
  truncated?: boolean
}

export interface RollbackPointSummary {
  id: string
  createdAt: number
  /** 自动留点归属的会话（自动点必有；无会话的旧记录为 null） */
  sessionId?: string | null
  /** 会话单元 id（宿主回传的 <projectKey>/<sessionId>；用于分组表头） */
  unitId?: string | null
  /**
   * 对话标题：宿主从 DSH 会话缓存补的**只读装饰**（与 /recovery/sessions 同一份索引）。
   * 读不到就**不带该字段** —— 界面回落显示 `sessionId`，绝不编造标题。
   */
  title?: string | null
  /** 该点对应的回合号（1-based；无法判定为 null） */
  turn?: number | null
  /** fork 的 inclusive 边界 seq（null = 无前置边界） */
  boundarySeq?: number | null
  /** auto = 回合结束自动留点；guard = 回退前救援点 */
  kind?: string
  protected?: boolean
  /** 两态缺一（缺省不允许回退） */
  incomplete?: boolean
  note?: string | null
  /** 两态 capturedAt 的跨度（诚实事实，无同点判定） */
  spreadMs?: number
  segments?: RollbackSegmentSummary[]
}

/**
 * 台账占用（issue #89 P2：可观测）。
 * `bytes` = records/ + payloads/ 的实际字节数；`budgetBytes` = 触发淘汰的字节预算；
 * `evicted` = 本进程内被预算淘汰的自动点累计数。缺省（老宿主没这个字段）= 界面不渲染这一行。
 */
export interface RollbackLedgerStatus {
  records: number
  bytes: number
  budgetBytes: number
  evicted: number
  /**
   * 已超预算且**无处可淘汰**（典型：单条点本身就大于预算）。
   * 老宿主没有这个字段 ⇒ `undefined` 与 `false` 同义，绝不因为读不到就报警。
   */
  overBudget?: boolean
}

export interface RollbackStorageStatus {
  available: boolean
  root?: string
  detail?: string
  guidance?: RollbackGuidance[]
  requirements?: readonly string[]
  /** 磁盘偏好：回合自动留点开关（缺省 / false = 关闭） */
  rollbackEnabled?: boolean
  /** 本进程此刻是否真的在留点（关闭后订阅已解绑）。与 rollbackEnabled 正常一致 */
  rollbackActive?: boolean
  /** 台账占用（老宿主没有这个字段） */
  ledger?: RollbackLedgerStatus
}

/** 开关读 / 写的结果（POST 成功才会改进程 gate）。 */
export interface RollbackPrefsResult {
  ok: boolean
  rollbackEnabled: boolean
  rollbackActive?: boolean
}

/** 台账清理结果（只删自动点；guard 与 protected 保留）。 */
export interface RollbackPurgeResult {
  ok: boolean
  code?: string
  detail?: string
  removedRecords?: number
  removedPayloads?: number
  removedObjects?: number
  bytes?: number
}

export interface RollbackListResult {
  ok?: boolean
  points: RollbackPointSummary[]
  storage: RollbackStorageStatus
  error?: string
  /** 全局留存上限（S6：50） */
  maxRecords?: number
  /** 每会话留存上限（S6：20） */
  maxRecordsPerSession?: number
  /** **全局**救援点留存上限（S6 第二道 guard 预算：50） */
  maxGuards?: number
}

export interface RollbackDetailResult {
  ok: boolean
  id: string
  point: RollbackPointSummary
  storage: RollbackStorageStatus
}

/** 计数或清单：宿主回传数字就取数字，回传清单就取长度（两者都是「有多少项」）。 */
export type RollbackCount = number | readonly string[]

/**
 * 预览里「回退会改动的一个文件」的动作。
 *
 * 与引擎（`src/core/rollback-point.ts` 的 `RollbackPreviewFileStatus`）**逐字同形**：
 *  · `overwrite` = 覆盖已有文件；`create` = 当前不存在（回退会重新创建）；
 *  · `delete` **不由 `files[]` 产出**：整文件删除走**另一条**清单
 *    （`RollbackWorkspacePreview.removals` = 会删的，`createdSkipped` = 拒删的）——
 *    那些路径不在该点的记录里，所以既不进这份逐文件统计、也读不出前后对照。
 *    保留该取值只为契约形状向前兼容 —— 界面不得为它编文案。
 */
export type RollbackPreviewFileStatus = 'overwrite' | 'create' | 'delete'

/**
 * E1：逐文件的行级统计（简洁版预览弹窗 `preview.workspace.files` 的元素形状）。
 *
 * **只列真的会被改动的文件** —— 已与快照一致的条目一个都不列（「353 项里 0 项不同」⇒ 空数组）。
 * `added` / `removed` 可能是 `null`（单文件超上限 / 单张预览累计超限 / Myers 步数超限 /
 * 非文本 / 对象仓读不出），此时 `truncated` 为 true：界面说「行数未统计」，
 * **绝不写成 0**（0 是一个会被证伪的具体数字，而「不知道」不是）。
 */
export interface RollbackPreviewFile {
  /** 绝对路径（界面只做展示）。 */
  path: string
  status: RollbackPreviewFileStatus
  /** 回退会让该文件**新增**的行数；null = 本次不给数字（见 truncated）。 */
  added: number | null
  /** 回退会从该文件**删除**的行数；null = 同上。 */
  removed: number | null
  /** true = 本次没有可信行数（added/removed 均为 null）。**宁可说「不知道」，也绝不谎报行数。** */
  truncated: boolean
  /**
   * true = 该文件在留点**之后**是**别的会话**写的（写入归属台账证明；见 core/rollback-attribution.ts）。
   * 界面据此默认不勾选它（用户仍可勾上）。缺字段 / false = **没有归属证据**，
   * 而不是「本会话写的」——「未判定」与「确知是本会话」必须分开。
   */
  foreign?: boolean
  /** 那些「别的会话」的会话 id（仅当 foreign 为 true） */
  foreignSessionId?: string
  /** 那次写入的时间（毫秒；仅当 foreign 为 true） */
  foreignAt?: number
  /**
   * true = 这次回退**不会改动它**（与其它对话的改动冲突 / 无法安全合并）。行级统计为 null ——
   * 「不改动」不是「0 行变化」，界面必须分开说。
   */
  skipped?: boolean
  /** 不改动的机器原因（界面映射成字典键，绝不裸渲染） */
  mergeReason?: string
}

export interface RollbackWorkspacePreview {
  /** 将被写回（覆盖）的条目数 */
  overwrite?: RollbackCount
  /** 与当前内容不同、确实会被改动 */
  different?: RollbackCount
  /** 记录里的文件当前已不存在（回退会重新创建） */
  missing?: RollbackCount
  /**
   * 该点**未记录**的条目总数。**不是**「之后新建」，也**不是**「会被删除」——
   * 会被删的是 {@link removals} / {@link removalsCount}。
   */
  createdAfter?: RollbackCount
  /** 该点**未记录**的路径清单（含被拒删的；宿主上限 20 条）—— **不是**删除清单 */
  leftovers?: string[]
  leftoversTruncated?: boolean
  /** **会被删除**的路径（= 未记录 + 过了安全判据；宿主上限 20 条） */
  removals?: string[]
  /** 会被删除的**真实总数**（不受清单上限影响） */
  removalsCount?: RollbackCount
  /** 删除逐条清单不完整（条数超上限 / 遍历被截断） */
  removalsTruncated?: boolean
  /** 按安全判据**拒删**的路径（.git / node_modules / 数据区 / 越界 / 过大 / 捕获不完整时的全部候选） */
  createdSkipped?: string[]
  /** 拒删路径的**真实总数** */
  createdSkippedCount?: RollbackCount
  createdSkippedTruncated?: boolean
  /**
   * 非 null = 该点捕获**不完整** ⇒ **一条都没删**（安全拒删：绝不误删既有文件）。
   * 界面必须如实说，绝不把它渲染成「无事可做 / 已一致」。
   */
  createdRefusedReason?: string | null
  /** 记录在案的分块（绝对路径；界面只做展示，不做判定） */
  chunks?: string[]
  /**
   * E1：逐文件的行级统计 —— **只含会被改动的文件**（内容已一致的条目一个都不列）。
   *
   * 可选（`?`）是**刻意的向后兼容**：老响应 / 老宿主不认识这个字段，缺省必须回落
   * 「没有这条信息」，而不是被当成「空数组＝全部一致」或抛错 —— 界面据「字段是否存在」
   * 决定是否显示文件列表，绝不把「缺字段」与「确知为空」混成同一件事。
   */
  files?: RollbackPreviewFile[]
  /** 捕获时被跳过的条目总数（skipped + excludedDirs；逐条列表的上限截断不影响本计数） */
  skippedCount?: RollbackCount
  /** 捕获是否被上限截断（超单文件上限 / 字节预算 / 文件数预算任一命中即为 true） */
  truncated?: boolean
  available?: boolean
  reasonCode?: string | null
  guidance?: RollbackGuidance[]
}

export interface RollbackSessionPreview {
  /** 回退目标边界：目标回合开始前最后一个事件的 seq（fork 的 inclusive 边界；无边界为 null） */
  from?: number | null
  /** 该回合 turn/end 的 seq（无边界为 null） */
  to?: number | null
  /** 该点对应的回合号 */
  turns?: number
  /** 当前事件游标（seq） */
  cursorSeq?: number | null
  /** 当前日志字节数 */
  cursorNowBytes?: number | null
  /** 目标边界的字节数 */
  cursorTargetBytes?: number | null
  /** 该段是否可回退（无边界 / 副本缺失 → false） */
  restorable?: boolean
  /** 日志刚被写过（仅供参考：fork 只读，不会覆盖日志） */
  active?: boolean
  reasonCode?: string | null
  available?: boolean
  guidance?: RollbackGuidance[]
}

export interface RollbackPreviewResult {
  ok: boolean
  code?: string
  detail?: string
  id: string
  storage: RollbackStorageStatus
  workspace?: RollbackWorkspacePreview | null
  session?: RollbackSessionPreview | null
  /** 该点的两态摘要（宿主回传；缺失时界面用列表行里的同一份摘要） */
  point?: RollbackPointSummary | null
  /** 宿主给出的权威判定（本层在此基础上再要求「至少有一段可回退」） */
  canRestore?: boolean
  canRemove?: boolean
  summary?: RollbackPointSummary
  guidance?: RollbackGuidance[]
  warnings?: RollbackGuidance[]
}

/** 单文件差异里一侧（与引擎 `RollbackFileDiffSide` 逐字同形：字段名/含义都一致）。 */
export interface RollbackFileDiffSide {
  exists: boolean
  bytes: number
  /** 行数；null = 未读取（二进制 / 超限 / 不可读） */
  lines: number | null
  binary: boolean
  oversized: boolean
  unreadable: boolean
}

/** 无法逐行对比的原因（有值时 hunks 恒为空数组 —— 「不知道」不是「没有差异」）。 */
export type RollbackFileDiffReason = 'missing-blob' | 'binary' | 'too-large' | 'unreadable'

/**
 * 单文件前后对照（引擎 `fileDiff` 的镜像；只列一条记录）。
 *
 * 方向：`before` = **当前磁盘**，`after` = **回退点快照**（点下回退之后该文件的样子）——
 * 与预览行数统计同一口径，界面左右双栏与之一致，别读反。
 */
export interface RollbackFileDiffResult {
  ok: boolean
  code?: string
  detail?: string
  id: string
  path: string
  status: RollbackPreviewFileStatus
  before: RollbackFileDiffSide
  after: RollbackFileDiffSide
  hunks: DiffHunk[]
  added: number
  removed: number
  identical: boolean
  degraded: boolean
  reason?: RollbackFileDiffReason
  /** true = 「回退后」一侧显示的是三方合并的结果（不是记录里的原文） */
  merged?: boolean
  /** true = 这次回退不会改动它（冲突 / 无法安全合并）——此时两侧相同 */
  mergeSkipped?: boolean
  /** 不改动的机器原因（界面映射成字典键） */
  mergeReason?: string
}

export interface RollbackSegmentResult {
  state: string
  status: string
  reasonCode?: string
  /** 逐条事实（技术细节，非用户可见文案） */
  detail?: string[]
  restored?: number
  failed?: number
  /** 该点**未记录**的路径（含被拒删的；宿主上限 20 条）。**不是**删除清单 —— 那一份是 removedPaths */
  leftovers?: string[]
  leftoversTruncated?: boolean
  /** 本次真的删掉的「该点未记录」路径数（用户 2026-10-11 定案 A） */
  removed?: number
  /** 已删除路径（有界清单；与预览的 workspace.removals 同源同序） */
  removedPaths?: string[]
  /** 想删但按安全判据拒删的路径（越界 / 数据区 / .git / node_modules / 过大 / 捕获不完整），如实报告 */
  createdSkipped?: string[]
  /** 拒删路径的**真实总数**（不受清单上限影响） */
  createdSkippedCount?: RollbackCount
  createdSkippedTruncated?: boolean
  /** 非 null = 该点捕获**不完整** ⇒ 一条都没删（安全拒删） */
  createdRefusedReason?: string | null
  /** 工作区段：实际写回的字节数（宿主回传才有） */
  writtenBytes?: number
  /** 因归属隔离（B）跳过的记录条目数：该文件在留点后被**别的会话**写过（宿主回传才有） */
  foreignSkipped?: number
  /** 因路径选择（A）跳过的记录条目数（宿主回传才有） */
  selectionSkipped?: number
  /** 三方合并成功、写回「撤销本会话 + 保留对方改动」的条目数（宿主回传才有） */
  mergedCount?: number
  mergedPaths?: string[]
  /** 冲突：两侧改到同一处 ⇒ 未写（宿主回传才有） */
  conflictCount?: number
  conflictPaths?: string[]
  /** 无法安全撤销 ⇒ 未写（宿主回传才有） */
  unavailableCount?: number
  unavailablePaths?: string[]
  /**
   * **落点无人认领**（时间窗证据表明那一刻没有任何会话活跃：手改 / 外部工具 / 另一个进程）
   * ⇒ 未写（宿主回传才有）。与 unavailableCount 分开：成因不同，用户要做的事也不同。
   */
  externalCount?: number
  externalPaths?: string[]
  /** 写入前发现又被改过（并发）⇒ 未写（宿主回传才有） */
  concurrentCount?: number
  concurrentPaths?: string[]
  /** 兼容形态：宿主只回传计数时也算得出来 */
  createdAfter?: RollbackCount
  createdAfterTruncated?: boolean
  /** 会话段：回退产生的 fork 子会话 id */
  childSessionId?: string
  guidance?: RollbackGuidance[]
}

export interface RollbackRewindResult {
  ok: boolean
  outcome: string
  code: string
  detail?: string
  id?: string
  segments?: RollbackSegmentResult[]
  /** 因前段失败 / 未请求而未执行的段（只可能是两态） */
  skippedSegments?: string[]
  /** 会话回退结果：fork 出来的子会话 id（S3；原会话日志只读，绝不改写） */
  childSessionId?: string
  /** 回退前自动留的救援点 id（S5 guard） */
  guardPointId?: string
  storage?: RollbackStorageStatus
  guidance?: RollbackGuidance[]
  warnings?: RollbackGuidance[]
}

export interface RollbackRemoveResult { ok: boolean; code: string; detail?: string; id: string }

/** 回退输入（冻结 wire contract 的 rewind body）。 */
export interface RollbackRewindOptions {
  /** fail-closed 确认门：必须**恰好** true（宿主缺省/假值一律 409 confirmation-required） */
  userConfirmed: boolean
  mode?: RollbackMode
  segments?: readonly RollbackState[]
  allowPartial?: boolean
  preRewindGuard?: RollbackGuardPolicy
  /**
   * 路径级选择性恢复（2026-10-17 定案 A）：只恢复这些路径。
   *
   * 缺省 = 全量口径（一字不变）。**空数组是无效输入**（宿主 400）—— 「一个都没勾」由界面拦住，
   * 绝不让它变成「整次回退静默 noop」。
   */
  onlyPaths?: readonly string[]
}

/** 端口：由 src/client/recovery/recovery-api.ts 实现（Partial 消费，缺失时界面如实说能力缺失）。 */
export interface RollbackPointPort {
  rollbackPoints(): Promise<RollbackListResult>
  rollbackPointStorage(): Promise<RollbackStorageStatus>
  rollbackPoint(id: string): Promise<RollbackDetailResult>
  rollbackPointPreview(id: string): Promise<RollbackPreviewResult>
  /**
   * 只读：该点里**一个记录在案文件**的前后逐行对照（预览弹窗按需拉取；未命中记录一律拒绝）。
   * 可选实现：端口缺失该方法时，界面**不显示**「查看」（绝不给一个点了没反应的入口）。
   */
  rollbackPointFileDiff?(id: string, path: string): Promise<RollbackFileDiffResult>
  restoreRollbackPoint(id: string, opts: RollbackRewindOptions): Promise<RollbackRewindResult>
  removeRollbackPoint(id: string, userConfirmed: boolean): Promise<RollbackRemoveResult>
  /**
   * 回合自动留点开关（issue #88：它跟配置备份/同步是两件事，必须能关）。
   * 可选实现：端口缺失时界面**不渲染**开关（绝不给一个点了没反应的入口）。
   */
  rollbackPrefs?(): Promise<RollbackPrefsResult>
  setRollbackEnabled?(enabled: boolean): Promise<RollbackPrefsResult>
  /**
   * 清理台账（issue #89 P1/P2：把已经涨上去的占用收回来）。
   * **只删自动点**；`includeGuards` 为 true 时连 guard 也删，protected 永不删。
   */
  purgeRollbackPoints?(opts: { includeGuards: boolean }): Promise<RollbackPurgeResult>
}

/**
 * 聊天内「↺ 回退」入口是否可见（issue #88：关闭后**收起**入口，不是置灰）。
 *
 * 判据只有一条：**宿主回传的开关**。老宿主（storage 响应里没有 `rollbackEnabled` 字段）按
 * 「未提供 = 功能默认开」处理 —— 那一版的语义就是默认启用，此时把入口藏起来会让用户
 * 「有点但没有入口」。形状不符（不是布尔）同样按「未提供」处理，绝不因为一个坏字段藏掉入口。
 */
export function rollbackEntryVisible(storage: RollbackStorageStatus | null | undefined): boolean {
  if (storage === undefined || storage === null) return false
  return storage.rollbackEnabled !== false
}

/* ------------------------------------------------------------ 内部小工具 */

function countOf(value: RollbackCount | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.length
  return 0
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 路径/事实清单：逐条脱敏（宿主技术细节不得明文上屏）。 */
function redactLines(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((line) => redact(line))
}

/** 段可用性：显式 available/restorable 为 false 才算不可用（缺字段 = 宿主没给否定信号）。 */
function segmentAvailable(segment: { available?: boolean; restorable?: boolean }): boolean {
  return segment.available !== false && segment.restorable !== false
}

/* ------------------------------------------------------------ 列表 → 展示行 */

export interface RollbackSegmentView {
  state: string
  labelKey: string
  restorable: boolean
  /** ok = 正常；warn = 捕获不完整（degraded）；error = 没捕到 / 失败 */
  badgeKind: 'ok' | 'warn' | 'error'
  entries: number
  cursorBytes: number | null
  reasonKey: string | null
  /** 留点时被跳过的条目总数（S4：跳过必须可见，绝不静默） */
  skippedCount: number
  /** 该段捕获被上限截断 */
  truncated: boolean
  /** 该段要显示的告警键（有序；空数组 = 没有需要说的）—— 文案在字典里，本层只回键 */
  noticeKeys: string[]
}

/** 段级 / 点级「跳过 · 截断」告警键（S4：宿主已如实回传，界面必须说出来）。 */
export const ROLLBACK_NOTICE_SKIPPED_KEY = 'rollback.row.notice.skipped'
export const ROLLBACK_NOTICE_TRUNCATED_KEY = 'rollback.row.notice.truncated'
export const ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY = 'rollback.preview.notice.skipped'
export const ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY = 'rollback.preview.notice.truncated'

/** 跳过 / 截断事实 → 告警键（顺序固定：先「跳过多少」，再「被截断」）。 */
function noticeKeysOf(skippedCount: number, truncated: boolean, skippedKey: string, truncatedKey: string): string[] {
  const keys: string[] = []
  if (skippedCount > 0) keys.push(skippedKey)
  if (truncated) keys.push(truncatedKey)
  return keys
}

export interface RollbackPointRowView {
  id: string
  /** 来源：auto（回合结束自动留点）/ guard（回退前救援点）/ unknown */
  kind: RollbackPointKind | 'unknown'
  kindKey: string
  createdAtMs: number
  sessionId: string | null
  /** 会话单元 id（宿主回传才有；分组表头显示用） */
  unitId: string | null
  /** 对话标题（宿主补的只读装饰，**渲染前已过 redact**；null = 缓存里没有，界面回落显示 sessionId） */
  title: string | null
  /** 该点对应的回合号（null = 未知，界面渲染 rollback.turnUnknown） */
  turn: number | null
  protected: boolean
  incomplete: boolean
  badgeKind: 'ok' | 'warn' | 'error'
  spreadMs: number
  segments: RollbackSegmentView[]
  /**
   * 至少有一段可回退、未保护、且两态齐全 —— 界面据此决定「回退」按钮可用性。
   * **救援点可以为 true**（t22：回退准入只拒 protected / incomplete；救援点正是「回到回退前」的唯一路径）。
   */
  rewindable: boolean
  /**
   * 可删：受保护点与**救援点**都不可删（宿主 remove 一律 protected-point）。
   * 与 rewindable **互相独立**（引擎 canRemove / canRestore 两门，src/core/rollback-point.ts:1530-1531）。
   */
  removable: boolean
  /** 用户自由文本：**渲染前已过 redact** */
  note: string | null
}

function segmentView(segment: RollbackSegmentSummary): RollbackSegmentView {
  const ok = segment.ok !== false
  const degraded = segment.degraded === true
  const badgeKind: 'ok' | 'warn' | 'error' = ok ? (degraded ? 'warn' : 'ok') : 'error'
  const skippedCount = numberOrNull(segment.skippedCount) ?? 0
  const truncated = segment.truncated === true
  return {
    state: segment.state,
    labelKey: rollbackStateKey(segment.state),
    restorable: segment.restorable === true,
    badgeKind,
    entries: numberOrNull(segment.entries) ?? 0,
    cursorBytes: numberOrNull(segment.cursorBytes),
    reasonKey: ok ? null : rollbackCodeKey(segment.reasonCode),
    skippedCount,
    truncated,
    noticeKeys: noticeKeysOf(skippedCount, truncated, ROLLBACK_NOTICE_SKIPPED_KEY, ROLLBACK_NOTICE_TRUNCATED_KEY),
  }
}

/** 列表 → 展示行（台账已按时间倒序；本函数只做映射与判定，不重排）。 */
export function rollbackPointRows(list: RollbackListResult | null): RollbackPointRowView[] {
  if (list === null) return []
  const points = Array.isArray(list.points) ? list.points : []
  return points.map((point) => {
    const segments = (Array.isArray(point.segments) ? point.segments : []).map(segmentView)
    const kind: RollbackPointKind | 'unknown' = point.kind === 'guard' ? 'guard' : point.kind === 'auto' ? 'auto' : 'unknown'
    const kindKey = kind === 'guard' ? 'rollback.kind.guard' : kind === 'auto' ? 'rollback.kind.auto' : ROLLBACK_KIND_UNKNOWN_KEY
    return {
      id: point.id,
      kind,
      kindKey,
      createdAtMs: point.createdAt,
      sessionId: typeof point.sessionId === 'string' && point.sessionId !== '' ? point.sessionId : null,
      unitId: typeof point.unitId === 'string' && point.unitId !== '' ? point.unitId : null,
      title: typeof point.title === 'string' && point.title.trim() !== '' ? redact(point.title) : null,
      turn: numberOrNull(point.turn),
      protected: point.protected === true,
      incomplete: point.incomplete === true,
      badgeKind: point.incomplete === true ? 'warn' : 'ok',
      spreadMs: numberOrNull(point.spreadMs) ?? 0,
      segments,
      rewindable: point.protected !== true && point.incomplete !== true && segments.some((segment) => segment.restorable),
      // 宿主真值（引擎 preview/remove 同一判据）：protected 与 **guard** 一律不可删 ——
      // 只看 protected 会把救援点的「删除」按钮点亮，点了必得 protected-point（按钮与文案自相矛盾）。
      removable: point.protected !== true && kind !== 'guard',
      note: point.note !== null && point.note !== undefined && point.note !== '' ? redact(point.note) : null,
    }
  })
}

/* ------------------------------------------------------------ 按会话分组（时间线） */

export interface RollbackPointGroupView {
  /** 会话 id（宿主未回传则为 null —— 界面渲染 rollback.group.unknownSession，绝不猜归属） */
  sessionId: string | null
  /** 会话单元 id（宿主回传才有） */
  unitId: string | null
  /** 对话标题（组内任一记录带标题即取之；null = 无标题，界面回落显示 sessionId） */
  title: string | null
  /** 组内最新时间（空组为 null；组间排序键） */
  latestAtMs: number | null
  rows: RollbackPointRowView[]
}

/**
 * 台账 → **按会话分组**的时间线（组内保持台账顺序 = 时间倒序；组间按各组最新时间倒序）。
 *
 * 分组键 = sessionId；缺 sessionId 的记录归入「未知会话」组并排在最后 —— 绝不猜它属于哪个会话。
 */
export function rollbackPointGroups(list: RollbackListResult | null): RollbackPointGroupView[] {
  const groups: RollbackPointGroupView[] = []
  const index = new Map<string, number>()
  for (const row of rollbackPointRows(list)) {
    const key = row.sessionId ?? '\u0000unknown'
    let at = index.get(key)
    if (at === undefined) {
      at = groups.length
      index.set(key, at)
      groups.push({ sessionId: row.sessionId, unitId: row.unitId, title: row.title, latestAtMs: null, rows: [] })
    }
    const group = groups[at] as RollbackPointGroupView
    group.rows.push(row)
    if (group.unitId === null && row.unitId !== null) group.unitId = row.unitId
    if (group.title === null && row.title !== null) group.title = row.title
    if (group.latestAtMs === null || row.createdAtMs > group.latestAtMs) group.latestAtMs = row.createdAtMs
  }
  return groups.sort((a, b) => {
    if (a.sessionId === null && b.sessionId !== null) return 1
    if (b.sessionId === null && a.sessionId !== null) return -1
    return (b.latestAtMs ?? 0) - (a.latestAtMs ?? 0)
  })
}

/** 该回滚点记下了多少个工作区文件（时间线上的「文件数」）。 */
export function rollbackRowFileCount(row: RollbackPointRowView): number {
  let total = 0
  for (const segment of row.segments) if (segment.state === 'workspace') total += segment.entries
  return total
}

/** 该回滚点是否有会话游标（时间线上的「是否有会话游标」—— 没有就只回退工作区）。 */
export function rollbackRowHasSessionCursor(row: RollbackPointRowView): boolean {
  return row.segments.some((segment) => segment.state === 'session' && segment.cursorBytes !== null)
}

/* ------------------------------------------------------------ 预览 → 展示行 */

export interface RollbackCountRowView { key: string; n: number }

export interface RollbackPreviewRowView {
  state: string
  labelKey: string
  available: boolean
  /** 宿主给出的原因码键（null = 没给；不可用时至少回落到 unknown，绝不裸渲染） */
  reasonKey: string | null
  /** 有序计数文案：overwrite / different / missing / createdAfter（工作区段才有计数） */
  counts: RollbackCountRowView[]
  /** 该点**未记录**的路径清单（含被拒删的；已脱敏；宿主上限 20 条）—— **不是**删除清单 */
  leftovers: string[]
  leftoversTruncated: boolean
  /**
   * **会被删除**的路径（已脱敏）—— **全量**（引擎不再切 20 条），与执行阶段同一份规划 ⇒ 逐条一致。
   * 界面直接把它渲染成「删除」行，**不需要**任何「清单可能不完整」的说明句。
   */
  removals: string[]
  /** 会被删除的条数（= {@link removals}.length） */
  removalsCount: number
  removalsTruncated: boolean
  /**
   * 按安全判据**拒删**的路径与条数、以及「**证明名单不完整** ⇒ 一条都没删」的原因。
   * **正文不渲染**（用户 2026-10-12：弹窗只要清单，不要说明句；文案克制 → DESIGN.md §7）——
   * 字段保留是引擎事实的投影，将来若放进 ⓘ / 工具提示可直接用。
   */
  createdSkipped: string[]
  createdSkippedCount: number
  createdSkippedTruncated: boolean
  createdRefusedReason: string | null
  /** 留点时被跳过的条目总数（S4：跳过必须可见） */
  skippedCount: number
  /** 捕获被上限截断 */
  truncated: boolean
  /** 该行要显示的「跳过 · 截断」告警键（有序；空数组 = 没有要说的） */
  noticeKeys: string[]
  /**
   * **点级**告警（宿主 preview.warnings；走 rollback.warn.* 映射、未知码回落 unknown）。
   *
   * 引擎不给「告警属于哪一段」的键（detail 是自由文本，解析它等于猜），所以点级告警**两行都带同一份**，
   * 由界面在面板级渲染一次（rollbackPreviewWarnings()）—— 本层绝不猜归属。
   */
  warnings: RollbackGuidanceRowView[]
  /** 会话段：边界游标 from → to（seq；缺失为 null） */
  cursor: { from: number | null; to: number | null } | null
  /** 会话段：日志字节数 now → target（宿主给得出才有；界面据此显示「会话 now→target」） */
  cursorBytes: { now: number | null; target: number | null } | null
  /** 会话段：该点对应的回合号（null = 未知，界面渲染 rollback.turnUnknown 口径） */
  turns: number | null
  /** 会话段：日志刚被写过（仅供参考：fork 只读，不会覆盖日志） */
  active: boolean
  guidance: RollbackGuidanceRowView[]
}

/**
 * 预览 → 展示行（<id>/preview 的只读结果）。
 *
 * 计数口径逐条对应「界面能看到什么」：覆盖多少项、其中多少项内容不同、多少项当前已不存在
 * （会被重新创建）、多少项是该点**未记录**的（引擎只统计「不在记录里」的文件，留点时被跳过的
 * 既有文件同样落在这里，所以不得声称「之后新建」）。
 *
 * 「未记录」与「会被删除」是**两件事**：会被删的只有过了安全判据的那一份
 * （`workspace.removals` / `removalsCount`），未记录清单里混着永不删除的 `.git` 等拒删项。
 */
/**
 * 文件行的**主标签** = 文件名（Cursor「Confirm Undo」式：一眼看是哪几个文件，而不是一屏绝对路径）。
 * 完整路径由组件放进 `title`（悬停可见），**信息一个都不丢**。
 */
export function rollbackPreviewFileLabel(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/**
 * 文件行的**目录前缀**（弱化色那一段）+ 基名。
 *
 * 为什么必须有它（2026-10-12 用户截图实测）：只显示基名时 `.git/index` / `.git/HEAD` /
 * `.git/COMMIT_EDITMSG` 在屏幕上就是三个孤零零的英文单词，用户第一眼读不出「这是什么、在哪」；
 * 而完整路径又太长会把 ±行数推走。折中 = **目录弱化 + 基名主色 + 完整路径仍在 title**（信息不丢）。
 *
 * 语义（两边界都是刻意的）：
 *  · 路径里没有分隔符（`AGENTS.md` 也在根目录）⇒ `dir === ''` —— 调用方**不画**那一段，
 *    不会出现一颗孤零零的 `/`；
 *  · 尾分隔符一律剥掉（`src/a/` ⇒ dir `src`、base `a`），与 rollbackPreviewFileLabel 同一口径；
 *  · 只在**最后一个**分隔符处切（Windows 盘符 `C:\\a\\b` ⇒ dir `C:\\a`）。
 */
export interface RollbackPathParts {
  /** 目录（含尾随分隔符）；根目录文件是空串 */
  dir: string
  /** 基名 */
  base: string
}

export function splitRollbackPath(filePath: string): RollbackPathParts {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (at < 0) return { dir: '', base: trimmed }
  return { dir: trimmed.slice(0, at + 1), base: trimmed.slice(at + 1) }
}

/**
 * 预览**汇总**（弹窗顶部那一条）：这次回退到底动多少东西。
 *
 * 为什么这是这一屏最该先看的信息：用户点「↺ 回退」后来到弹窗，先要判断「规模」再逐行核文件；
 * 没有汇总就得爬到第 8 行才知道「原来是 8 个文件」。所以它不是装饰，是**决策信息**
 * （DESIGN §7：只留能改变决定的信息 —— 数字留，描述性句子不留）。
 *
 * 口径三条（逐条可证伪，界面不得超出这里说的）：
 *  · `files` = **会被改动**的文件数（= 传进来的行数本身，不减去任何东西）；
 *  · `added` / `removed` **只累加可信行数**：任一侧是 null（超限 / 非文本 / 读不出）的文件两列都不计，
 *    否则「行数未统计」的文件会被当成 0 行 —— 那是一个会被证伪的具体断言（见 ChatPreviewFileRow 注释）；
 *  · 删除集是另一条清单（`removals`，与执行阶段同一份规划），**单独计数**，不与上方混加。
 */
export interface RollbackPreviewScope {
  files: number
  /** 新增行数合计（只含两侧都可信的行） */
  added: number
  /** 删除行数合计（同上） */
  removed: number
  /** 整文件删除条数（引擎 removals，真的会删） */
  removals: number
}

export function rollbackPreviewScope(
  files: readonly { added: number | null; removed: number | null }[],
  removals: readonly unknown[],
): RollbackPreviewScope {
  let added = 0
  let removed = 0
  for (const file of files) {
    if (file.added === null || file.removed === null) continue
    added += file.added
    removed += file.removed
  }
  return { files: files.length, added, removed, removals: removals.length }
}

/**
 * 预览里「能被单独勾选」的一行 —— `workspace.files` 的逐条映射（**只含会被改动的文件**）。
 *
 * 为什么要有这一层（2026-10-17 定案 A+B）：A 要求用户能**逐文件**决定这次动哪些；
 * B（写入归属）给出「哪几个文件在留点之后是别的会话写的」，用来决定**默认**勾不勾。
 * 两件事都收敛在这里、只在这一处（框架无关、node 可测），组件只负责渲染与点击。
 */
export interface RollbackSelectionRow {
  path: string
  /** 目录前缀 + 基名（与文件行同口径；展示用） */
  parts: RollbackPathParts
  /** true = 该文件在留点**之后**是别的会话写的（引擎 foreign 标记；缺字段 = 没有归属证据） */
  foreign: boolean
  /** 那些会话的 id（仅 foreign 时给得出） */
  foreignSessionId?: string
}

/** 从预览推出可勾选行（只读；绝不改任何判定） */
export function rollbackSelectionRows(preview: RollbackPreviewResult | null): RollbackSelectionRow[] {
  const files = preview?.workspace?.files
  if (!Array.isArray(files)) return []
  const out: RollbackSelectionRow[] = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    if (path === '') continue
    const row: RollbackSelectionRow = { path, parts: splitRollbackPath(path), foreign: file.foreign === true }
    if (row.foreign && typeof file.foreignSessionId === 'string' && file.foreignSessionId !== '') {
      row.foreignSessionId = file.foreignSessionId
    }
    out.push(row)
  }
  return out
}

/**
 * 默认勾选 = **非 foreign** 的行（B 的自动隔离口径）。用户可在弹窗里逐个改回去。
 *
 * 为什么要在这里定而不在组件里：同一条默认值要在面板与聊天两个入口一致，
 * 且「默认排除别的会话的改动」是产品决定，必须可测。
 */
export function rollbackDefaultSelection(rows: readonly RollbackSelectionRow[]): string[] {
  return rows.filter((row) => !row.foreign).map((row) => row.path)
}

/**
 * 勾选集 → `onlyPaths`：
 *  · **全选**（含空清单）⇒ `null`（不传字段 = 走既有全量口径，老宿主也照样工作）；
 *  · 真的少勾 ⇒ 把选中的清单原样传给宿主（空数组由调用方拦：宿主侧它是 400）。
 */
export function rollbackOnlyPaths(
  rows: readonly RollbackSelectionRow[],
  selected: readonly string[],
): string[] | null {
  if (rows.length === 0) return null
  const chosen = new Set(selected)
  const picked = rows.filter((row) => chosen.has(row.path)).map((row) => row.path)
  return picked.length === rows.length ? null : picked
}

/** 该不该拦住提交：清单非空、却一个都没勾（宿主会把空数组当 400） */
export function rollbackSelectionBlocksSubmit(
  rows: readonly RollbackSelectionRow[],
  selected: readonly string[],
): boolean {
  if (rows.length === 0) return false
  const chosen = new Set(selected)
  return !rows.some((row) => chosen.has(row.path))
}

/**
 * 差异无法逐行展示时的字典键（本层**只回键**，文案在字典里）。
 * 未知 / 缺失原因回落 null —— 调用方按「未知原因」出话，绝不回落成「没有差异」（那是另一件事）。
 */
export function rollbackFileDiffReasonKey(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'missing-blob': return 'rollback.diff.reason.missingBlob'
    case 'binary': return 'rollback.diff.reason.binary'
    case 'too-large': return 'rollback.diff.reason.tooLarge'
    case 'unreadable': return 'rollback.diff.reason.unreadable'
    default: return null
  }
}

/** 可渲染的 hunks（缺字段 / 非数组一律当空 —— 渲染层绝不因宿主形态差异崩掉）。 */
export function rollbackFileDiffHunks(result: RollbackFileDiffResult | null): DiffHunk[] {
  const hunks = result?.hunks
  return Array.isArray(hunks) ? hunks : []
}

/** 两侧是否都真的读到了文本（否则说不出「无差异」）。 */
export function rollbackFileDiffComparable(result: RollbackFileDiffResult | null): boolean {
  if (result === null || result.ok !== true) return false
  if (result.reason !== undefined) return false
  return result.before.binary !== true && result.after.binary !== true && result.before.oversized !== true && result.after.oversized !== true
}

export function rollbackPreviewRows(preview: RollbackPreviewResult | null): RollbackPreviewRowView[] {
  if (preview === null) return []
  const rows: RollbackPreviewRowView[] = []
  const pointWarnings = rollbackGuidanceRows(preview.warnings)
  const workspace = preview.workspace
  if (workspace !== undefined && workspace !== null) {
    const skippedCount = countOf(workspace.skippedCount)
    const truncated = workspace.truncated === true
    rows.push({
      state: 'workspace',
      labelKey: rollbackStateKey('workspace'),
      available: segmentAvailable(workspace),
      reasonKey: workspace.reasonCode !== undefined && workspace.reasonCode !== null && workspace.reasonCode !== ''
        ? rollbackCodeKey(workspace.reasonCode)
        : null,
      counts: [
        { key: 'rollback.preview.overwrite', n: countOf(workspace.overwrite) },
        { key: 'rollback.preview.different', n: countOf(workspace.different) },
        { key: 'rollback.preview.missing', n: countOf(workspace.missing) },
        { key: 'rollback.preview.createdAfter', n: Math.max(countOf(workspace.createdAfter), countOf(workspace.leftovers)) },
      ],
      leftovers: redactLines(workspace.leftovers),
      leftoversTruncated: workspace.leftoversTruncated === true,
      removals: redactLines(workspace.removals),
      removalsCount: Math.max(countOf(workspace.removalsCount), Array.isArray(workspace.removals) ? workspace.removals.length : 0),
      removalsTruncated: workspace.removalsTruncated === true,
      createdSkipped: redactLines(workspace.createdSkipped),
      createdSkippedCount: Math.max(countOf(workspace.createdSkippedCount), Array.isArray(workspace.createdSkipped) ? workspace.createdSkipped.length : 0),
      createdSkippedTruncated: workspace.createdSkippedTruncated === true,
      createdRefusedReason: typeof workspace.createdRefusedReason === 'string' && workspace.createdRefusedReason !== '' ? workspace.createdRefusedReason : null,
      skippedCount,
      truncated,
      noticeKeys: noticeKeysOf(skippedCount, truncated, ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY, ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY),
      warnings: pointWarnings,
      cursor: null,
      cursorBytes: null,
      turns: null,
      active: false,
      guidance: rollbackGuidanceRows(workspace.guidance),
    })
  }
  const session = preview.session
  if (session !== undefined && session !== null) {
    rows.push({
      state: 'session',
      labelKey: rollbackStateKey('session'),
      available: segmentAvailable(session),
      reasonKey: session.reasonCode !== undefined && session.reasonCode !== null && session.reasonCode !== ''
        ? rollbackCodeKey(session.reasonCode)
        : null,
      counts: [],
      leftovers: [],
      leftoversTruncated: false,
      removals: [],
      removalsCount: 0,
      removalsTruncated: false,
      createdSkipped: [],
      createdSkippedCount: 0,
      createdSkippedTruncated: false,
      createdRefusedReason: null,
      skippedCount: 0,
      truncated: false,
      noticeKeys: [],
      warnings: pointWarnings,
      cursor: { from: numberOrNull(session.from), to: numberOrNull(session.to) },
      cursorBytes: { now: numberOrNull(session.cursorNowBytes), target: numberOrNull(session.cursorTargetBytes) },
      turns: numberOrNull(session.turns),
      active: session.active === true,
      guidance: rollbackGuidanceRows(session.guidance),
    })
  }
  return rows
}

export interface RollbackPreviewVerdict {
  /** 宿主允许回退 **且** 至少有一段可回退 */
  canRestore: boolean
  canRemove: boolean
  /** canRestore=false 时的原因键（null = 可回退） */
  reasonKey: string | null
  /** 三选一 mode（按可用段推导，界面据此作为下拉默认值） */
  mode: RollbackMode
  /** 可回退的段（只可能是 workspace / session） */
  segments: RollbackState[]
  /** 该点两态不全（缺省不允许回退；界面据此要求显式勾「允许部分回退」） */
  incomplete: boolean
}

/** 点级告警（preview.warnings）→ 展示行；界面在面板级渲染一次（点级告警不归属任何段，绝不猜）。 */
export function rollbackPreviewWarnings(preview: RollbackPreviewResult | null): RollbackGuidanceRowView[] {
  return rollbackGuidanceRows(preview?.warnings)
}

/** 点级指引（preview.guidance）→ 展示行（同上，面板级渲染一次）。 */
export function rollbackPreviewGuidance(preview: RollbackPreviewResult | null): RollbackGuidanceRowView[] {
  return rollbackGuidanceRows(preview?.guidance)
}

/* ------------------------------------------------------------ T15：预览态「无事可做」的四态分派 */

/**
 * 预览态那句「工作区怎样怎样」的**四态**判别（T15）。
 *
 * 背景（用户截图抱怨的那一屏就是**预览态**）：点「回退」之前，三种**完全不同**的事实
 * 被同一句「工作区与该回退点一致，无需恢复」概括 —— 其中两种是不实陈述：
 *  · 该点压根没记录任何文件（工作区段 files=0）；
 *  · 工作区态没有可用记录（available=false）；
 *  · 而真正「一致」时，若**会话仍会回退**（fork 子会话），说「无需恢复」也是假尾句。
 *
 * 判据**只来自 preview 的字段**（available / overwrite / different / missing / reasonCode /
 * session.restorable）与宿主给的 canRestore，**禁止解析 detail**（技术细节不是接口）。
 * 优先级（与验收逐字一致）：① 工作区态不可用 → ⓪ 该点**未记录**的新建内容会被删除
 * （`removalsCount` > 0 = 真会删，宿主 removeCreated 缺省为真）→ ② available 且 overwrite===0
 * → ③a 工作区一致但会话仍可回退 → ③b 工作区一致且无事可做。另有前置的一条**不属于四态**：
 * 工作区**真会改动**（different>0 / missing>0 / 会删掉未记录的新建文件）时不上屏任何
 * 「一致/无需恢复」句（由文件列表说话）——
 * 这也是「假尾句禁令」在函数层面的落点：`changesSomething === true` 时，
 * 要么 `key === null`，要么该键的文案**不含**「无需恢复」。
 */
export type RollbackPreviewNoteKind =
  /** 工作区真会改动（写文件**或删掉该点未记录的新建文件**）⇒ 没有「一致」句可说，由文件列表说话。 */
  | 'workspace-changes'
  /** ① 工作区态没有可用记录（available=false）。 */
  | 'workspace-unavailable'
  /** ② 该点没记录任何文件（available=true 且 overwrite===0）。 */
  | 'no-recorded-files'
  /** ③a 工作区与该点一致，但会话仍会回退（fork 子会话）。 */
  | 'workspace-consistent-session'
  /** ③b 工作区与该点一致，且无事可做（会话也不可回退）。 */
  | 'workspace-consistent-noop'

/** 预览态那句文案的判定结果（界面只负责把它翻译上屏，不在界面里重写判据）。 */
export interface RollbackPreviewNote {
  kind: RollbackPreviewNoteKind
  /** 上屏文案键；**null = 本情形没有该类句子**（工作区有变更 ⇒ 由文件列表说话）。 */
  key: string | null
  /** 需要插进 `{reason}` 的**字典键**（只有 ① 用；未知/缺失一律 `rollback.code.unknown`）。 */
  reasonKey: string | null
  /** 点「回退」是否**真会改动什么**（工作区会写文件 or 会话会 fork）—— 假尾句禁令的判据。 */
  changesSomething: boolean
  /** 会话仍会回退（= 会 fork 出新子会话）。 */
  sessionForks: boolean
}

/** ① 的原因键来源：workspace.reasonCode 优先 → 段摘要里的 workspace 段 → 未知（绝不编原因）。 */
function previewNoteReasonKey(
  workspace: RollbackWorkspacePreview | null | undefined,
  segments: readonly { state?: string; reasonCode?: string | null }[] | undefined,
): string {
  const direct = workspace?.reasonCode
  if (typeof direct === 'string' && direct !== '') return rollbackCodeKey(direct)
  const segment = segments?.find((item) => item.state === 'workspace')
  const code = segment?.reasonCode
  if (typeof code === 'string' && code !== '') return rollbackCodeKey(code)
  return ROLLBACK_CODE_UNKNOWN_KEY
}

/**
 * 预览态文案判定（**一处实现**：聊天对话框调用它；将来设置页若要复用同一口径也走这里）。
 *
 * @param input.workspace preview.workspace（缺失按「不可用」处理：没有记录信息 ⇒ 不能说「一致」）
 * @param input.session   preview.session（只有 `restorable === true` 才算「会话仍会回退」）
 * @param input.segments  段摘要（`preview.point.segments`；只用于 ① 的原因键回落，读 reasonCode 字段）
 * @param input.canRestore 宿主/判定层的回退门（缺省按 true；传 false 时不得声称「会话仍会回退」）
 */
export function rollbackPreviewNote(input: {
  workspace?: RollbackWorkspacePreview | null
  session?: RollbackSessionPreview | null
  segments?: readonly { state?: string; reasonCode?: string | null }[] | null
  canRestore?: boolean
}): RollbackPreviewNote {
  const workspace = input.workspace ?? null
  const session = input.session ?? null
  const overwrite = countOf(workspace?.overwrite)
  const different = countOf(workspace?.different)
  const missing = countOf(workspace?.missing)
  /**
   * **会被删除**的条数（= 该点未记录 **且**过了安全判据的那些）。
   *
   * 为什么它必须参与「这句话说得说不说得」：宿主 rewind 的 `removeCreated` **缺省为真**
   * （src/routes/recovery.ts:459），所以「工作区与该点一致，无需恢复」在会删文件的点上同样是**假尾句**
   * —— 点下去真的会删文件（用户 2026-10-12 第 6 条）。
   *
   * 判据**只能**取 `removalsCount` / `removals`（引擎 `planCreatedRemovals` 的同一份规划）：
   * 拿「未记录总数」（`createdAfter` / `leftovers`）当删除数会**双向出错** —— 它把永不删除的
   * `.git` 路径也算进去，又把证明名单不完整时「一条都不删」的情形说成「工作区会变」。
   */
  const removals = Math.max(
    countOf(workspace?.removalsCount),
    Array.isArray(workspace?.removals) ? workspace.removals.length : 0,
  )
  // 「会话仍会回退」两个条件都要：该段可回退 + 该点整体可回退（受保护点/两态不全时按钮本来就点不了，
  // 这时说「会话仍会回退到该点之前」同样是假话）
  const sessionForks = input.canRestore !== false && session?.restorable === true

  // ① 工作区态没有可用记录
  if (workspace?.available !== true) {
    const reasonKey = previewNoteReasonKey(workspace, input.segments ?? undefined)
    return {
      kind: 'workspace-unavailable',
      key: sessionForks ? 'rollback.preview.files.unavailableSession' : 'rollback.preview.files.unavailable',
      reasonKey,
      changesSomething: sessionForks,
      sessionForks,
    }
  }
  // ⓪ 工作区态可用，但该点**未记录**的新建内容会被删掉 ⇒ 工作区真会变，
  //    「一致 / 无需恢复」在这里也是假尾句（宁可不说话：删掉的文件由列表逐条说出来）。
  if (removals > 0) {
    return { kind: 'workspace-changes', key: null, reasonKey: null, changesSomething: true, sessionForks }
  }
  // ② 该点没记录任何文件
  if (overwrite === 0) {
    return {
      kind: 'no-recorded-files',
      key: sessionForks ? 'rollback.preview.files.noFilesSession' : 'rollback.preview.result.noFiles',
      reasonKey: null,
      changesSomething: sessionForks,
      sessionForks,
    }
  }
  // 工作区真会写文件 ⇒ 没有「一致」句（由文件列表说话）；这也是假尾句禁令的前置保护
  if (different > 0 || missing > 0) {
    return { kind: 'workspace-changes', key: null, reasonKey: null, changesSomething: true, sessionForks }
  }
  // ③a 工作区一致，但会话仍会回退 ⇒ 只说工作区（**禁止**「无需恢复」：点下去真会 fork）
  if (sessionForks) {
    return { kind: 'workspace-consistent-session', key: 'rollback.preview.files.consistentSession', reasonKey: null, changesSomething: true, sessionForks: true }
  }
  // ③b 工作区一致且无事可做
  return { kind: 'workspace-consistent-noop', key: 'rollback.preview.files.empty', reasonKey: null, changesSomething: false, sessionForks: false }
}

/**
 * 预览里的「可回退 / 可删除」判定。
 *
 * **原因键按宿主真实形状分派**（引擎 preview 恒回 `code:'ok'`，靠 canRestore/canRemove 表达拒绝 ——
 * 见 src/core/rollback-point.ts:1530-1531：`canRemove = !protected && kind!=='guard'`（删除门）与
 * `canRestore = !protected && !incomplete && (workspaceRestorable || sessionRestorable)`（回退门）**互相独立**）：
 *   ① 受保护点 → rollback.code.protected-point（引擎 remove/rewind 都拒）
 *   ② 两态不全 → rollback.preview.reason.incomplete（引擎要 allowPartial 才放行）
 *   ③ 一段都不可回退 → 段自己的 reasonCode；没有就 rollback.preview.none
 *   ④ 宿主给了非 ok 的 code → 该 code 的键
 *   ⑤ 兜底：救援点 → rollback.preview.reason.guard（宿主拒绝了本可回退的救援点）；其余 → rollback.preview.reason.hostRefused
 *      —— **绝不回落 rollback.code.unknown**
 * 救援点（guard）在 ①②③ 之外**是可回退的**（t22）：它只在宿主真的拒绝时落到 ⑤。
 */
export function rollbackPreviewVerdict(preview: RollbackPreviewResult | null): RollbackPreviewVerdict {
  if (preview === null) {
    return { canRestore: false, canRemove: false, reasonKey: ROLLBACK_CODE_UNKNOWN_KEY, mode: 'files+session', segments: [], incomplete: false }
  }
  const segments: RollbackState[] = []
  if (preview.workspace !== undefined && preview.workspace !== null && segmentAvailable(preview.workspace)) segments.push('workspace')
  if (preview.session !== undefined && preview.session !== null && segmentAvailable(preview.session)) segments.push('session')
  const point = preview.point ?? preview.summary ?? null
  const protectedPoint = point?.protected === true
  const guardPoint = point?.kind === 'guard'
  const incomplete = point?.incomplete === true
  const canRestore = preview.canRestore === true && segments.length > 0
  let reasonKey: string | null = null
  if (!canRestore) {
    const segmentReason = preview.session?.reasonCode ?? preview.workspace?.reasonCode
    if (protectedPoint) reasonKey = 'rollback.code.protected-point'
    else if (incomplete) reasonKey = ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY
    else if (segments.length === 0) {
      reasonKey = typeof segmentReason === 'string' && segmentReason !== '' ? rollbackCodeKey(segmentReason) : 'rollback.preview.none'
    } else if (preview.code !== undefined && preview.code !== '' && preview.code !== 'ok') reasonKey = rollbackCodeKey(preview.code)
    // 兜底：宿主拒绝了一个「看起来可恢复」的点。救援点在这里单独说清（它本来是可回退目标，t22）——
    // 绝不把它写成「受保护」或「一律不可回退」。
    else reasonKey = guardPoint ? ROLLBACK_PREVIEW_REASON_GUARD_KEY : ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY
  }
  return {
    canRestore,
    canRemove: preview.canRemove === true,
    reasonKey,
    mode: rollbackModeFromSegments(segments),
    segments,
    incomplete,
  }
}

/* ------------------------------------------------------------ 回退结果 → 展示行 */

export interface RollbackRewindRowView {
  state: string
  labelKey: string
  statusKey: string
  badgeKind: 'ok' | 'warn' | 'error'
  restored: number
  failed: number
  /** 该点**未记录**、**未删除**的内容数（引擎 scanLeftovers 语义，不是「之后新建」） */
  leftoversCount: number
  /** 真的被删掉的「回退点之后新建」条数（段结果里的 removed） */
  removedCount: number
  /** 同上，路径清单（已脱敏；宿主上限 20 条） */
  leftovers: string[]
  leftoversTruncated: boolean
  /** 会话段：fork 出来的子会话 id（无则 null） */
  childSessionId: string | null
  /** 逐条事实：**渲染前已逐条过 redact** */
  detail: string[]
  guidance: RollbackGuidanceRowView[]
  /**
   * 归属隔离（B）跳过的文件数：这些文件在留点之后是**别的会话**写的，回退没动它们。
   * 0 = 没有（或宿主没回传）—— 界面只在 > 0 时说这句话（绝不编造 0 的成就）。
   */
  foreignSkipped: number
  /** 路径选择（A）跳过的文件数（用户自己没勾） */
  selectionSkipped: number
  /** 三方合并成功、写回「撤销本会话 + 保留对方改动」的文件数 */
  mergedCount: number
  /** 冲突（两侧改到同一处）未写的文件数 + 有界清单 */
  conflictCount: number
  conflictPaths: string[]
  /** 无法安全撤销（无中间版本 / 二进制 / 降级 / 对方删了它）未写的文件数 */
  unavailableCount: number
  /** 写入前发现又被改过（并发）未写的文件数 */
  concurrentCount: number
  /**
   * **落点无人认领**未写的文件数 + 有界清单（2026-10-18）：时间窗表明改这条路径的那一刻
   * 没有任何会话活跃 ⇒ 手改 / 外部工具 / 另一个 DSH 进程。0 = 没有（或宿主没回传）。
   */
  unclaimedCount: number
  unclaimedPaths: string[]
}

export function rollbackRewindRows(result: RollbackRewindResult | null): RollbackRewindRowView[] {
  if (result === null) return []
  const segments = Array.isArray(result.segments) ? result.segments : []
  return segments.map((segment) => {
    const status: RollbackSegmentStatus | 'unknown' =
      segment.status === 'restored' ? 'restored' : segment.status === 'skipped' ? 'skipped' : segment.status === 'failed' ? 'failed' : 'unknown'
    const statusKey = status === 'unknown' ? 'rollback.segment.unknown' : 'rollback.segment.' + status
    const badgeKind: 'ok' | 'warn' | 'error' = status === 'restored' ? 'ok' : status === 'skipped' ? 'warn' : 'error'
    const leftovers = redactLines(segment.leftovers)
    const childSessionId = typeof segment.childSessionId === 'string' && segment.childSessionId !== '' ? segment.childSessionId : null
    return {
      state: segment.state,
      labelKey: rollbackStateKey(segment.state),
      statusKey,
      badgeKind,
      restored: numberOrNull(segment.restored) ?? 0,
      failed: numberOrNull(segment.failed) ?? 0,
      leftoversCount: Math.max(leftovers.length, countOf(segment.createdAfter)),
      removedCount: countOf(segment.removed),
      leftovers,
      leftoversTruncated: segment.leftoversTruncated === true || segment.createdAfterTruncated === true,
      childSessionId,
      detail: redactLines(segment.detail),
      guidance: rollbackGuidanceRows(segment.guidance),
      foreignSkipped: numberOrNull(segment.foreignSkipped) ?? 0,
      selectionSkipped: numberOrNull(segment.selectionSkipped) ?? 0,
      mergedCount: numberOrNull(segment.mergedCount) ?? 0,
      conflictCount: numberOrNull(segment.conflictCount) ?? 0,
      conflictPaths: redactLines(segment.conflictPaths),
      unavailableCount: numberOrNull(segment.unavailableCount) ?? 0,
      concurrentCount: numberOrNull(segment.concurrentCount) ?? 0,
      unclaimedCount: numberOrNull(segment.externalCount) ?? 0,
      unclaimedPaths: redactLines(segment.externalPaths),
    }
  })
}

/** 回退总体结论 → 字典键 + 徽章语义（未知回落 unknown，绝不裸渲染 outcome）。 */
export function rollbackOutcome(outcome: string | null | undefined): { key: string; badgeKind: 'ok' | 'warn' | 'error' } {
  if (outcome === 'restored') return { key: 'rollback.outcome.restored', badgeKind: 'ok' }
  if (outcome === 'partial') return { key: 'rollback.outcome.partial', badgeKind: 'warn' }
  if (outcome === 'failed' || outcome === 'denied') return { key: 'rollback.outcome.' + outcome, badgeKind: 'error' }
  return { key: 'rollback.outcome.unknown', badgeKind: 'error' }
}

export interface RollbackRewindCounts {
  restored: number
  failed: number
  leftovers: number
  /** 本次真的删掉的「回退点之后新建」路径数（用户 2026-10-11 定案 A） */
  removed: number
}

/** 回退结果汇总计数（界面一句话说清「恢复多少 / 失败多少 / 没删多少」）。 */
export function rollbackRewindCounts(result: RollbackRewindResult | null): RollbackRewindCounts {
  const rows = rollbackRewindRows(result)
  let restored = 0
  let failed = 0
  let leftovers = 0
  let removed = 0
  for (const row of rows) {
    restored += row.restored
    failed += row.failed
    leftovers += row.leftoversCount
    removed += row.removedCount
  }
  return { restored, failed, leftovers, removed }
}

/**
 * 会话回退的 fork 结果（S3）：原会话日志**只读**，回退产出的是一个新子会话。
 * 返回 null = 本次没有会话回退（界面不渲染这一行，绝不编造子会话 id）。
 */
export function rollbackChildSession(result: RollbackRewindResult | null): { key: string; id: string } | null {
  const direct = result?.childSessionId
  if (typeof direct === 'string' && direct !== '') return { key: 'rollback.rewind.result.child', id: direct }
  for (const segment of result?.segments ?? []) {
    const id = segment.childSessionId
    if (typeof id === 'string' && id !== '') return { key: 'rollback.rewind.result.child', id }
  }
  return null
}

/** 本次因前段失败 / 未请求而未执行的段（只可能是两态；未知段回落 unknown 键）。 */
export function rollbackSkippedSegments(result: RollbackRewindResult | null): { state: string; key: string }[] {
  const segments = Array.isArray(result?.skippedSegments) ? result!.skippedSegments! : []
  return segments.map((state) => ({ state, key: rollbackStateKey(state) }))
}

/* ------------------------------------------------------------ 文案键常量（面板复用） */

/** 删除成功文案键（delete 的 `code:'deleted'`）。 */
export const ROLLBACK_DELETED_KEY = 'rollback.code.deleted'
/** 「没有可回退的内容」文案键（预览判定为否时的兜底原因）。 */
export const ROLLBACK_PREVIEW_NONE_KEY = 'rollback.preview.none'
