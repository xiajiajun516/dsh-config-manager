import { isRecord } from '../utils/guards.ts'
/**
 * 宿主会话存储 / 工作区绑定服务的**形状工具**（从 src/index.ts 下沉，体量棘轮）。
 *
 * 这些定义是 DshSessionStoreFacade 与其诊断链的支撑类型与纯函数：判服务形状、
 * 归一化列表项、把 attachSession 结果折成可报告的结构。它们不读宿主服务、不 import
 * `@deepseek-ai/*`（边界见 tests/architecture-boundaries.test.ts），因此可独立成模块。
 */


// 字节级工具（projectKey 形状 / 首帧 cwd 读写 / 多 generation 改写）已抽到 utils/session-log.ts：
// 宿主在线路径与 CLI 离线修复共用同一份实现（避免两处口径漂移）。

/* --------------------------------------------- 会话存储读侧兼容（F-1） */

/**
 * 宿主 `sessionPersistence` 的 API 形状（**按 API 形状探测，绝不按 DSH 版本号猜**）。
 *
 * 为什么必须探测：DSH 的会话存储换过基线 —— 新基线有 `open()`（handle 形态，`list()` 的元素是
 * 带 `header` 的 snapshot 对象），旧基线只有服务级的 `readFrom()` / `append()`（header 字段
 * **平铺在元素上**）。本插件只读 `list()` 的结果，而两种形状里 header 的位置不同。
 *
 * 真机事故级的后果（F-1）：按写死的形状读，在另一种宿主上「一个都匹配不上」——
 * `reindexSessionHeader` 恒 false、`parentRelations` 退化成**空 Map**（而空 Map 还会进 5 s 的
 * TTL 缓存），于是「导出子代理会话时连带父对话」这条已经修好的能力在旧宿主上**静默失效**。
 * 参照竞品 dsh-claude-move 的 isSessionHandle / storedSessionIdOf（index.mjs:88-154）。
 */
export type SessionPersistenceShape = 'handle' | 'legacy' | 'unknown'

/** 会话存储**列举**接口的最小形状（两种基线都有 `list()`；本插件只读它，不写会话）。 */
export interface SessionListService {
  list(): Promise<readonly unknown[]>
}

/** 按 API 形状探测会话存储基线：有 `open` → handle；只有 `readFrom`/`append` → legacy；都没有 → unknown。 */
export function sessionPersistenceShapeOf(service: unknown): SessionPersistenceShape {
  if (!isRecord(service)) return 'unknown'
  if (typeof service['open'] === 'function') return 'handle'
  if (typeof service['readFrom'] === 'function' || typeof service['append'] === 'function') return 'legacy'
  return 'unknown'
}

/** 归一后的列举元素 header 视图（只含本插件用到的字段）。 */
export interface ListedSessionView {
  id: string
  /** 父会话 id（磁盘 header 名 `parentSession`；DSH 的 RPC 投影名 `parentSessionId` 一并认） */
  parent?: string
  /** header.origin（'subagent' = 子代理会话）——原样保留，不在这里做筛选 */
  origin: unknown
  /**
   * **原样的 header 对象**（handle 形态 = `element.header`；legacy 形态 = 元素自身）。
   * 回传给 DSH `WorkspaceRegistry.indexHeader()` 时必须用它 —— 绝不自己造一个 header。
   */
  raw: unknown
}

/**
 * 把一个列举元素归一成 header 视图（**两种基线形状都认**）。
 *
 * 认不出 id → undefined：这是「读侧兼容失败」的唯一信号，调用方必须**响亮处理**
 * （记日志 / 抛错），绝不当成「本机没有会话」。
 */
export function normalizeListedSession(element: unknown): ListedSessionView | undefined {
  if (!isRecord(element)) return undefined
  const nested = isRecord(element['header']) ? element['header'] : undefined
  // handle 形态 = header 在 element.header；legacy 形态 = header 字段平铺在元素上。
  // header 存在但取不出 id 时回落元素自身（两种都取不到才算解析失败 —— 不猜）。
  const source = nested !== undefined && typeof nested['id'] === 'string' && nested['id'] !== '' ? nested : element
  const id = source['id']
  if (typeof id !== 'string' || id === '') return undefined
  const rawParent = source['parentSession'] ?? source['parentSessionId']
  const parent = typeof rawParent === 'string' && rawParent !== '' ? rawParent : undefined
  return { id, origin: source['origin'], raw: source, ...(parent !== undefined ? { parent } : {}) }
}

/** 会话存储列举的结果（失败必须可区分，绝不与「本机没有会话」混淆）。 */
export type ListedSessions =
  | { ok: true; items: readonly ListedSessionView[] }
  /** unavailable = 服务/接口不可用（list 抛错或返回非数组）；shape-unknown = 元素形状一个都认不出 */
  | { ok: false; reason: 'unavailable' | 'shape-unknown'; detail: string }

/** 列举会话存储的用途（内部枚举；渲染时必须经字典键映射 —— **绝不把裸枚举塞进文案**）。 */
export type SessionStorePurpose = 'reindexSessionHeader' | 'parentRelations' | 'rewindWorkspaceAttach'

/** 用途 → 字典键（本仓纪律：文案只做「原因 → 字典键」映射，禁止渲染裸枚举）。 */
export const SESSION_STORE_PURPOSE_KEY: Record<SessionStorePurpose, string> = {
  reindexSessionHeader: 'host.sessionStorePurposeReindex',
  parentRelations: 'host.sessionStorePurposeParentRelations',
  rewindWorkspaceAttach: 'host.sessionStorePurposeRewindAttach',
}

/**
 * 父子关系缓存的 TTL（毫秒）。
 *
 * 取值依据：`sessionPersistence.list()` 在真机上约 **0.7 s**，而 `/export-preview` 每次都要它；
 * 父子关系只在「有新子代理会话」时变化，几秒陈旧对选择器的「勾父带子 / 勾子带父」联动毫无影响。
 * 取 5 s：连续打开/刷新选择器都在同一窗口内命中，同时保证新会话最多 5 s 后就能被联动识别。
 *
 * F-1：缓存里只放**成功结果** —— 列举失败/形状识别失败走 `parentRelations()` 的抛错路径，
 * 由 ttl-cache 的「失败不缓存」语义保证下一次调用立刻重试；
 * 不再把失败吞成空 Map（那会被缓存整整 5 s，正是「静默失效」的放大器）。
 */
export const PARENT_RELATIONS_CACHE_TTL_MS = 5_000

/**
 * `ancestorSessionIds` 的上溯深度上限。
 *
 * 取 8：DSH 的子代理树实际深度是个位数（`delegationDepth`），8 层足够覆盖「子代理的子代理」；
 * 上限 + 环保护一道，保证异常数据（自指 / 环）不会把回退路径卡死。
 */
export const ANCESTOR_LOOKUP_MAX_DEPTH = 8

/**
 * 宿主会话管理面（`SessionController`）的结构窄化 —— 本仓 core 不 import `@deepseek-ai/*`。
 *
 * `fork(request)` = DSH 自己的「从某条事件前缀分叉」命令（内部 `SessionCommandController.fork`）：
 * 建 agent + 落盘 + 挂回原工作区一次到位，返回新子会话 id。**这是回退唯一可用的 fork 路径**
 * （底层 `SessionStore.fork` 造的会话没有 agent、不落盘，见 forkSession 注释）。
 */
export interface SessionForkController {
  fork?: (request: { sessionId: string; atSeq: number }) => Promise<unknown>
}

/** `ctx.get('workspaceRegistry')` 的结构窄化（本仓 core 不 import @deepseek-ai/*）。 */
export interface WorkspaceRegistryLike {
  list?: () => unknown
  /** DSH 的「按规范目录路径解析工作区」：目录不存在时在 realpath 阶段拒绝；目录存在但无人认领返回 undefined。 */
  resolveByPath?: (path: string) => Promise<unknown>
}

/** 归位成功的两种情形（都经 `list()` 复核过）。 */
export type WorkspaceAttachSuccessReason =
  /** 官方 fork 已经归位（能按成员/血缘解析到工作区）——本兜底只补复核，不重复写。 */
  | 'already-attached'
  /** 本兜底真的写成功且复核通过。 */
  | 'attached'

/**
 * 归位失败的具体理由（机器码）。
 *
 * 为什么必须区分而不是一个笼统的 `false`：真机现场「回退后子会话进未分组」长期不可见，
 * 根因之一就是 attach 失败被吞成布尔（无日志、无理由）。每一档都能单独定位：
 *  · registry-unavailable / registry-list-unavailable / registry-list-failed —— 服务缺失或形状不符；
 *  · attach-session-missing —— 工作区记录上**没有** `attachSession`（形状不符，未发起任何写）；
 *  · attach-rejected —— `attachSession` 真的抛错（目录不存在 / cwd 对不上 / 域未就绪）；
 *  · directory-missing —— `resolveByPath` 在 realpath 阶段拒绝，或回落档 realpath 失败（目录不存在）；
 *  · no-workspace-for-cwd —— 目录存在但不属于任何已注册工作区；
 *  · cwd-unavailable —— 读不到子会话 cwd（绝不猜路径）；
 *  · verify-failed —— 写调用没抛错，但 `list()` 复核不含该子会话（最终判据不通过，**不许报成功**）；
 *  · unexpected-error —— 其它未预期异常。
 */
export type WorkspaceAttachFailureReason =
  | 'registry-unavailable'
  | 'registry-list-unavailable'
  | 'registry-list-failed'
  | 'attach-session-missing'
  | 'attach-rejected'
  | 'directory-missing'
  | 'no-workspace-for-cwd'
  | 'cwd-unavailable'
  | 'verify-failed'
  | 'unexpected-error'

/** 归位失败（`detail` 是技术细节：errno / 路径 / 形状码，供日志与排查，不是用户文案）。 */
export interface WorkspaceAttachFailure {
  ok: false
  reason: WorkspaceAttachFailureReason
  detail?: string
}

/** 一次 `attachSession` 尝试（只表达「写调用是否成功」，最终判据在 {@link DshSessionStoreFacade} 的复核里）。 */
export type AttachAttempt = { ok: true } | { ok: false; reason: 'attach-session-missing' | 'attach-rejected'; detail?: string }

/**
 * 会话 cwd 的读取结果（**多源**：活会话 → 宿主会话存储列举）。
 *
 * `source` 只用于诊断与日志（live = `ctx.get('sessions').get(id).header`；stored = `sessionPersistence.list()`），
 * 调用方**不得**据此改变归位判据 —— 两个来源读的都是 DSH 自己写下的同一个 header.cwd。
 */
export type SessionCwdLookup =
  | { ok: true; cwd: string; source: 'live' | 'stored' }
  | { ok: false; detail: string }

/** 一次工作区归位的结果（成功/失败都带**具体**理由）。 */
export type WorkspaceAttachOutcome =
  | { ok: true; reason: WorkspaceAttachSuccessReason; workspaceId?: string }
  | WorkspaceAttachFailure

/** 归位失败时给调用方的 warning 串（稳定前缀 + 具体理由码）。 */
export const WORKSPACE_ATTACH_FAILED_PREFIX = 'workspace-attach-failed'

/**
 * 归位失败后的重试次数与间隔（毫秒）。
 *
 * 为什么需要（真机 2026-10-17/10-12）：fork 返回时子会话刚由 `agents.create` 建好，
 * DSH 侧的会话索引 / 持久化列举可能还没就绪 —— 与「目录根本不存在」这类终结性失败不同，
 * 这是**时序性**失败。归位本身幂等（`attachSession` 自查成员名单、`mutate` 空操作即不改写），
 * 因此重试零副作用；不重试则子会话永久停在侧栏「未分组」。
 */
export const WORKSPACE_ATTACH_ATTEMPTS = 2
export const WORKSPACE_ATTACH_RETRY_DELAY_MS = 200

/** 归位诊断文件的相对路径（相对插件数据根；只在**失败**时追加一行 JSON）。 */
export const WORKSPACE_ATTACH_DIAGNOSTIC_REL = 'logs/rewind-workspace-attach.jsonl'

/**
 * DSH 官方 fork 在「子会话已创建、但 `workspace.attachSession` 失败」时抛的错误码。
 *
 * 依据 DSH 源码：`dsh-api-session-controller/lib/index.js` L829-836 抛
 * `new RemoteError('session/workspace-attach-failed', …, { sessionId: childId, workspaceId })`。
 */
export const WORKSPACE_ATTACH_FAILED_ERROR_CODE = 'session/workspace-attach-failed'

/**
 * 从官方 fork 的 `session/workspace-attach-failed` 错误里取回**已经创建好的子会话 id**。
 *
 * 字段名**不是猜的** —— DSH 自己的客户端就是这么取的（同款姿势）：
 * `dsh-api-session-controller/lib/client.js` L3013-3015 的 `workspaceAttachSessionId(error)`：
 *   `error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined`
 * 错误类是 `dsh-typert-protocol/lib/index.js` L11-28 的 `RemoteError`（`code` + `details`；
 * DSH 明文规定「判别只按 code，never by instanceof」，故这里也只按 `code`，不 import 那门包）。
 *
 * 形状不符（不是对象 / code 不是这个 / 没有 details.sessionId / 空串）一律 undefined ——
 * 调用方据此**保持现状**报 fork-failed，绝不假装成功、也绝不猜别的字段名。
 */
export function workspaceAttachFailureChildId(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (code !== WORKSPACE_ATTACH_FAILED_ERROR_CODE) return undefined
  const details = (error as { details?: unknown }).details
  if (details === null || typeof details !== 'object') return undefined
  const sessionId = (details as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

/**
 * 归位失败 → warning 串；成功 → undefined。
 *
 * 为什么是「前缀:理由码」而不是新字段：`RollbackForkSeam`（core/types.ts，本任务 scope 外）的返回
 * 形状只有 `{ childSessionId, warning? }`，warning 是**唯一**能把具体理由带到调用方的通道；
 * core 只判「非空」并落成 `rollback.guidance.sessionNotAttached`（界面如实上屏），
 * 前缀保持稳定以便既有 grep / 诊断脚本继续命中。
 */
export function workspaceAttachWarningOf(outcome: WorkspaceAttachOutcome): string | undefined {
  return outcome.ok ? undefined : WORKSPACE_ATTACH_FAILED_PREFIX + ':' + outcome.reason
}

/**
 * 目录同一性比较用的折叠（**只在 `resolveByPath` 拿不到时的回落档**使用）。
 *
 * 分隔符统一为 `/`；win32 大小写不敏感（Windows 路径大小写等价）。
 * 注意：本函数只比较**两侧都经 realpath 规范化**过的路径 —— 绝不拿「原样 cwd」与「规范 path」直接比，
 * 那正是真机 2026-10-12 的根因（工作区 path 经 `realpathNormalize`、会话头 cwd 是原样字符串）。
 */
export function foldWorkspacePath(value: string): string {
  const unified = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 工作区记录的稳定 id（形状不符 → undefined；只作诊断/日志，不参与判定）。 */
export function workspaceRecordIdOf(record: Record<string, unknown>): string | undefined {
  const id = record['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 该记录是否把某会话算作成员（`sessionIds` 非数组 = 形状不符，不算成员）。 */
export function recordHasMember(record: Record<string, unknown>, sessionId: string): boolean {
  const sessionIds = record['sessionIds']
  return Array.isArray(sessionIds) && sessionIds.includes(sessionId)
}
