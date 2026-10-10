/**
 * 聊天内「↺ 回退」入口的**判定与请求装配**（框架无关纯函数，node 可测）。
 *
 * 职责边界：
 *  - 这里只做「判定 / 键映射 / 请求体成形 / 子会话导航」四件事，**不产出任何用户可见文案**
 *    （键在字典里：聊天独有 → `chat-locales.ts`；回退词汇 → recovery 字典的 `rollback.*`）。
 *  - 展示行的计算**复用** `src/ui/rollback-view.ts` 的既有实现（T2 产出，单一真相）：
 *    预览计数 / mode ↔ 段映射 / code 白名单 / outcome / 逐段结果 / fork 子会话行。
 *    本模块只在上面加「聊天入口特有」的两块：回合 ↔ 回滚点的匹配，以及子会话打开与降级。
 *
 * 五条纪律：
 *  ① `src/client/**` 不得 import 任何 node 模块，也不得 import `src/core/**`
 *     （client bundle 铁律）；本文件只 import `src/ui/**`、`src/security/**` 的零依赖模块。
 *  ② **未确认绝不构造写请求**：`buildRewindOptions` 在 `confirmed !== true` 时返回 null，
 *     唯一的写出口 `requestRewind` 拿到 null 就直接返回 blocked —— 宿主侧的 409
 *     `confirmation-required` 只是兜底，客户端先拦。
 *  ③ 未知码 / 未知态一律回落 unknown 键（`rollbackCodeKey`），**绝不把机器码原文上屏**。
 *  ④ 子会话打开失败**如实降级**（`degraded` / `unavailable`），绝不假装已打开。
 *  ⑤ **简洁预览对话框是「预览 + 确认」两步**（用户 2026-10-10 第三条要求：「弹窗里只有被回退的
 *     文件 + 删/增行数」）：对话框里只有文件列表与两个按钮，**没有**二次确认勾选 —— 点「回退」
 *     那一刻本身就是确认，`requestRewind` 收到 `confirmed: true` 才成形。这是对上一版
 *     「勾选二次确认」的**有意替换**：确认门从「勾选框」挪到「对话框本身」（见 `RewindDraft`
 *     与 `TOMBSTONE` 注释），宿主侧的 fail-closed 确认门（userConfirmed 恰好 true）一个字没动。
 */
import { redact } from '../../security/redaction.ts'
import { readChatEntryMode, type ChatEntryMode } from './chat-entry-pref.ts'
import {
  ROLLBACK_CODE_UNKNOWN_KEY,
  rollbackChildSession,
  rollbackCodeKey,
  rollbackModeSegments,
  rollbackOutcome,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  rollbackStateKey,
  type RollbackMode,
  type RollbackPointPort,
  type RollbackPointSummary,
  type RollbackPreviewResult,
  type RollbackRewindOptions,
  type RollbackRewindResult,
  type RollbackState,
} from '../../ui/rollback-view.ts'

/* ------------------------------------------------------------ 槽位常量（注册点与断言共用） */

/** 槽位名（ui-chat 声明的回合尾 list 位；选型依据见 src/client/chat/chat-slots.ts 与本文件头注释）。 */
export const CHAT_ENTRY_SLOT = 'conversation.chat.turnTail'
/** 本插件在该槽位里的 cell id（新 id = 追加一个条目，不占用任何既有 cell）。 */
export const CHAT_ENTRY_ID = 'config-manager-rollback-entry'
/** 位置：排在 shipped 条目之间靠前一点（deliverables 缺省 0 / schedule 20）。 */
export const CHAT_ENTRY_ORDER = 15

/* ------------------------------------------------------------ 回合 ↔ 回滚点 */

/**
 * 回合尾按钮是否出现在这个回合：**只有已收尾的回合**才有回滚点
 * （S1：留点发生在回合结束时；正在跑的回合还没有点，显示入口会撒谎）。
 */
export function entryVisibleForTurn(turn: { status?: string } | null | undefined): boolean {
  return turn?.status === 'closed'
}

/**
 * 该（会话 + 回合号）对应的回滚点。
 *
 * 匹配口径：`sessionId` 与 `turn` **同时**相等；同一回合里有多个点时优先取 `kind === 'auto'`
 * 的自动点（guard 救援点属于「回退前那一刻」，不该成为回合尾入口的默认目标）。
 * 找不到返回 null —— 界面如实说「这个回合还没有回滚点」，**不猜**最近的一个。
 */
export function findPointForTurn(
  points: readonly RollbackPointSummary[] | undefined,
  sessionId: string | null | undefined,
  turn: number | null | undefined,
): RollbackPointSummary | null {
  if (!Array.isArray(points) || typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return null
  const candidates = points.filter((point) => point.sessionId === sessionId && point.turn === turn)
  return candidates.find((point) => point.kind === 'auto') ?? candidates[0] ?? null
}

/* ------------------------------------------------------------ mode → 段集合 */

/**
 * mode → 请求体段集合（复用 `src/ui/rollback-view.ts` 的唯一映射实现）。
 *
 * 聊天入口**不再提供**三选一：对话框固定 `files+session`（=「回到这条消息之前」）。
 * 设置页的回滚卡仍走同一个 `rollbackModeSegments`（那是一份真相，不是两份）。
 */
export function segmentsForMode(mode: string | null | undefined): RollbackState[] {
  return rollbackModeSegments(mode)
}

/* ------------------------------------------------------------ 回退预览：逐文件行级统计（E1 冻结形状） */

/**
 * 一张预览里「会被改动」的文件（E1 引擎 `preview.workspace.files` 的**逐条对齐**读法）。
 *
 * 形状（E1 冻结）：`{ path, status: 'overwrite'|'create'|'delete', added, removed, truncated }`
 * ——**只列会被改动的文件**（内容已一致的一个都不列 ⇒ 工作区与该回退点一致时是**空数组**）。
 * 三条不可越过的事实：
 *  · `added` / `removed` 可能是 **null**：单文件超上限 / 非文本 / 对象仓读不出 ⇒ 界面说
 *    「行数未统计」，**绝不写成 0**（0 是一个可被证伪的具体断言）；
 *  · `status` 目前只会是 `overwrite` / `create`：回退只覆盖、**绝不删除**文件（引擎 R-28）；
 *    `delete` 保留在取值集合里只为形状完整 —— 我们不解释它、也不为它编文案；
 *  · 未知 status / 缺字段一律按「行数未知」处理，但**这一行仍然要上屏**（路径是已知事实）。
 */
export interface ChatPreviewFileRow {
  /** 绝对路径（界面原样显示；`whitespace: pre-wrap` + `break-all` 承接长路径）。 */
  path: string
  /** 'overwrite' | 'create' | 引擎将来可能新增的取值（原样透传，不猜语义）。 */
  status: string
  /** 回退会新增的行数；null = 本次没有可信数字（见 truncated）。 */
  added: number | null
  /** 回退会删除的行数；null = 同上。 */
  removed: number | null
  /** true = 这一条本次没有可信行数（界面显示「行数未统计」，不是 0）。 */
  truncated: boolean
}

/** `preview.workspace.files` 的取值域（类型未收录时的静态兜底）。 */
const PREVIEW_FILE_STATUSES: readonly string[] = ['overwrite', 'create', 'delete']

function previewCountOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 读 `preview.workspace.files` —— **宽度接收 + 逐字段判定**（与 chat-entry-view 的节点读法同纪律）。
 *
 * 为什么不用静态类型：`src/ui/rollback-view.ts` 的 `RollbackWorkspacePreview` 目前没有收这个
 * 字段（E1 在引擎侧先行落地），这里按结构读、逐字段判，缺什么降级什么；等类型补上之后
 * 本函数仍是唯一读点，把手改回去只改这一处。
 */
export function readRollbackPreviewFiles(workspace: unknown): ChatPreviewFileRow[] {
  const files = (workspace as { files?: unknown } | null | undefined)?.files
  if (!Array.isArray(files)) return []
  const rows: ChatPreviewFileRow[] = []
  for (const item of files) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const path = record['path']
    // 路径读不出 ⇒ 这一条对用户没有任何信息量，跳过（不编一条「未知文件」占位）
    if (typeof path !== 'string' || path === '') continue
    const status = record['status']
    const added = previewCountOf(record['added'])
    const removed = previewCountOf(record['removed'])
    rows.push({
      path,
      status: typeof status === 'string' && status !== '' ? status : 'unknown',
      added,
      removed,
      // 引擎给了 truncated=true 一律照收；两个数字缺一个也一样（界面口径与之一致：null ⇒ 未统计）
      truncated: record['truncated'] === true || added === null || removed === null,
    })
  }
  return rows
}

/** 预览里是否有**任何**可信行数（没有 ⇒ 一行小字说明「行数未统计」，不逐行重复同一句）。 */
export function chatFileChangeAvailable(files: readonly ChatPreviewFileRow[]): boolean {
  return files.some((file) => file.added !== null && file.removed !== null)
}

/**
 * 状态白名单（只用于**断言**：引擎当前只会产出 overwrite / create；delete 保留在取值集合里）。
 * 界面**不**按它分派文案 —— 用户要的是「有哪些文件、增删多少行」，不是变更类型分类。
 */
export function previewFileStatusKnown(status: string): boolean {
  return PREVIEW_FILE_STATUSES.includes(status)
}

/* ------------------------------------------------------------ 回退结果一句话 + 失败原因 */

/**
 * 结果摘要 —— **一行**说清这次回退到底发生了什么（用户 2026-10-10 第三条要求：结果不再逐段铺开）。
 *
 * `nothing-to-restore` 的**唯一**落点：工作区与该回退点一致（引擎 E1 语义：outcome='restored'、
 * restored=0、code='nothing-to-restore'，HTTP **200**）。它不是失败：说「无需恢复」，
 * 绝不当成错误弹给用户。
 */
export function chatRewindSummary(result: RollbackRewindResult | null): { kind: 'noop' | 'plain'; key: string | null } {
  if (result === null) return { kind: 'plain', key: null }
  if (result.code === 'nothing-to-restore') return { kind: 'noop', key: 'rollback.preview.result.noop' }
  return { kind: 'plain', key: null }
}

/**
 * 失败原因行：**可读文案键 + code + detail**（用户要求「失败时仍如实显示 code 与 detail」）。
 *
 * 三件事各司其职：`key` 给人看（用户能读懂的句子）、`code` 给排障（机器码**同时**显示，
 * 但不当成主文案）、`detail` 是宿主的逐条技术细节（渲染前过 redact）。
 * 段级 code 与结果级 code **都收**（真实失败可能只说在某一级）——去重后逐条渲染，绝不静默吞掉。
 */
export function chatRewindFailure(result: RollbackRewindResult | null): { code: string | null; detail: string | null; keys: string[] } {
  if (result === null) return { code: null, detail: null, keys: [] }
  const keys: string[] = []
  const code = typeof result.code === 'string' && result.code !== '' ? result.code : null
  if (code !== null) keys.push(rollbackCodeKey(code))
  for (const segment of result.segments ?? []) {
    if (segment.status !== 'failed') continue
    const segmentCode = typeof segment.reasonCode === 'string' && segment.reasonCode !== '' ? segment.reasonCode : null
    if (segmentCode === null) continue
    const key = rollbackCodeKey(segmentCode)
    if (!keys.includes(key)) keys.push(key)
  }
  const detail = typeof result.detail === 'string' && result.detail !== '' ? redact(result.detail) : null
  return { code, detail, keys }
}

/** `nothing-to-restore` 的字典键（对话框与测试共用一份字面量）。 */
export const ROLLBACK_NOTHING_TO_RESTORE_KEY = 'rollback.preview.result.noop'

/* ------------------------------------------------------------ 复核对话框草稿 */

/**
 * 复核对话框的交互状态（纯数据；组件只做 setState）。
 *
 * ⚠️ **确认语义已从「勾选框」换成「对话框本身」**（2026-10-10 用户第三条要求：简洁弹窗只有
 * 文件列表 + 两个按钮）：`confirmed` 现在是「用户点了主按钮」的**运行期置位**，由对话框在
 * `submit()` 里显式置 true（`confirmOnSubmit`），**不再有** UI 上的二次确认勾选。
 * 边界与旧版一致的两点：① 默认值仍是 `false`（`defaultDraft` 绝不自动置 true）；
 * ② 唯一的写出口 `buildRewindOptions` 仍然要求**恰好** `true`，缺省/假值一律不成形。
 */
export interface RewindDraft {
  /** 用户确认（点主按钮那一刻置 true）。**必须恰好 true** 才允许发写请求（宿主侧 fail-closed 同规）。 */
  confirmed: boolean
  /**
   * 回退范围：**恒为 `files+session`**（= 用户说的「回到这条消息之前」）。
   * 不再有三选一 mode 单选 —— 固定带上会话段，工作区无变更时会话段照常回退（E1 语义）。
   */
  mode: RollbackMode
  /**
   * 两态不全时的显式放行（wire 字段 `allowPartial`）。**恒为 false**：对话框不再给这个勾选，
   * 两态不全的点在界面上如实说不可回退（`canSubmitRewind` 因此为 false）。
   * 保留字段只为请求体形状完整（`allowPartial` 是冻结 wire contract 的一部分）。
   */
  allowPartial: boolean
  /**
   * 救援点策略：**恒为 require**（回退前必须留救援点，留不下就整体中止、零写入）。
   * 不提供 off/warn 的入口 —— 用户不该在聊天里一键关掉自己的退路（S5）。
   */
  preRewindGuard: 'require'
}

/** 对话框固定的回退范围（= 「回到这条消息之前」：工作区文件 + 会话一起）。 */
export const CHAT_REWIND_MODE: RollbackMode = 'files+session'

/** 草稿默认值（每次返回**新对象**）：未确认、固定 files+session、不请求部分放行、救援点恒 require。 */
export function defaultDraft(_preview: RollbackPreviewResult | null): RewindDraft {
  return { confirmed: false, mode: CHAT_REWIND_MODE, allowPartial: false, preRewindGuard: 'require' }
}

/**
 * 「用户点了主按钮」这一刻置位确认 —— 对话框唯一的确认入口（**没有**勾选框）。
 * 未点之前 `confirmed` 恒 false，`buildRewindOptions` 恒 null（端口零调用）。
 */
export function confirmOnSubmit(draft: RewindDraft | null): RewindDraft | null {
  return draft === null ? null : { ...draft, confirmed: true }
}

/**
 * 主按钮是否可用：用户已确认（点按钮那一刻置位）+ 固定段集合非空 + **宿主允许回退**。
 *
 * 与旧版的口径差异（有意）：旧版在「两态不全」时允许勾选 `allowPartial` 后放行；简洁版没有
 * 这个勾选，两态不全的点在界面上如实说不可回退（按钮禁用），**不假装能退**。
 */
export function canSubmitRewind(draft: RewindDraft | null, preview: RollbackPreviewResult | null): boolean {
  if (draft === null) return false
  if (draft.confirmed !== true) return false
  const segments = segmentsForMode(draft.mode)
  if (segments.length === 0) return false
  // 点「回退」即 userConfirmed=true：确认门由对话框本身承担（预览 → 点按钮 两步）。
  return rollbackPreviewVerdict(preview).canRestore
}

/**
 * 草稿 → 请求体。**未二次确认时返回 null**（连 body 都不成形）。
 * 这是「绝不自动置 true」的落点：userConfirmed 只可能来自这里的 `confirmed === true`。
 */
export function buildRewindOptions(draft: RewindDraft | null): RollbackRewindOptions | null {
  if (draft === null || draft.confirmed !== true) return null
  const segments = segmentsForMode(draft.mode)
  if (segments.length === 0) return null
  const options: RollbackRewindOptions = { userConfirmed: true, mode: draft.mode }
  if (draft.allowPartial) options.allowPartial = true
  options.preRewindGuard = draft.preRewindGuard
  return options
}

/** 一次回退尝试的结果（blocked = 客户端拦下，端口一次都没被调用）。 */
export type RewindAttempt =
  | { kind: 'blocked'; key: string }
  | { kind: 'ok'; result: RollbackRewindResult }
  | { kind: 'error'; key: string; detail: string | null }

/** 宿主侧错误码 → 字典键（白名单外回落 `rollback.code.unknown`）。 */
export function codeKeyOfError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string') return ROLLBACK_CODE_UNKNOWN_KEY
  return rollbackCodeKey(code)
}

/** 错误消息（渲染前过 redact；宿主侧已脱敏，这里兜底）。 */
export function errorDetail(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message === '' ? null : redact(message)
}

/**
 * **唯一的写出口**：未二次确认一律 blocked（端口零调用）。
 *
 * 为什么把这条守在这里而不是组件里：组件会被重渲染、会被 HMR 重挂，
 * 把 fail-closed 判定放在能单元测试的纯函数边缘，才是可被断言的不变量。
 */
export async function requestRewind(
  port: RollbackPointPort,
  id: string,
  draft: RewindDraft | null,
): Promise<RewindAttempt> {
  const options = buildRewindOptions(draft)
  if (options === null) return { kind: 'blocked', key: 'rollback.code.confirmation-required' }
  try {
    return { kind: 'ok', result: await port.restoreRollbackPoint(id, options) }
  } catch (error) {
    return { kind: 'error', key: codeKeyOfError(error), detail: errorDetail(error) }
  }
}

/* ------------------------------------------------------------ 结果 → 渲染数据（薄封装，单一真相在 rollback-view.ts） */

export {
  rollbackChildSession,
  rollbackOutcome,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  rollbackStateKey,
}

/* ------------------------------------------------------------ 子会话导航（S3；T9-F1：改走真机 API） */

/**
 * 子会话打开结果 —— **每个降级态各自只对应一个可证的真实原因**（T9-F1 文案诚实要求）：
 *  - `opened`      = 已用本客户端的会话导航打开；
 *  - `degraded`    = **有**导航入口，但子会话确实还没出现在会话列表里（重拉一次基线后仍没有）；
 *  - `failed`      = **有**导航入口、列表里也有它（或列表读不出来），但这次导航调用失败；
 *  - `unavailable` = 本客户端**根本没有可用的会话导航入口**（childSessionId 可能已在列表里）。
 *
 * 为什么必须有 `unavailable` 这一档（T9-F1 的根因）：真机 0.2.0-rc.2 的 `ctx.sessions` 面
 * **没有 open**（只有 retain/using/retainInfo/refresh/search/create/fork/scope…），旧
 * `ctx.sessions.open` 只存在于 dsh-client-runtime@0.1.0 的 ISessions。把不存在的函数包一层
 * 只会抛 TypeError ⇒ 恒判「子会话还没出现在会话列表里」，而那是不实陈述。
 */
export type ChildOpenState = 'opened' | 'degraded' | 'failed' | 'unavailable'

/**
 * 会话服务面（`ctx.sessions` 的结构子集，**两种版本都能套**）：
 *  · 0.2 真机：有 `list` / `refresh`，**没有 open**；
 *  · 0.1.x：ISessions 有 `open`（列表读取面是否存在另说）。
 * 三个成员都可选 —— 缺哪个就少哪份能力，绝不用假函数顶上。
 */
export interface SessionListSource {
  /** 只读列表快照（真机与旧版都有的那一半）。 */
  list?: { getSnapshot: () => { byId: Record<string, unknown> } }
  /** 重拉列表基线（0.2 有；0.1 的 ISessions 没有）。 */
  refresh?: () => Promise<void>
  /** **旧版兼容**：0.1.x ISessions.open —— 只在它确实是函数时使用（0.2 真机没有）。 */
  open?: (id: string) => void
}

/** 真机导航面：`ctx.uiWorkspace`（0.2 的 `openSession(id)`；ui-chat 自己的 fork 流程就用它）。 */
export interface WorkspaceNavigationSource {
  openSession?: (id: string) => void
}

/** 两个可选客户端服务的结构面（都惰取；缺谁少谁的能力）。 */
export interface NavigationSources {
  workspace?: WorkspaceNavigationSource | null
  sessions?: SessionListSource | null
}

/**
 * 组件实际用的导航面。
 * `openSession` 缺省 = 本客户端没有导航入口 ⇒ `openChildSession` 返回 `unavailable`；
 * `listedIds` / `refresh` 只用于区分「没有入口」与「子会话还没进列表」。
 */
export interface SessionNavigator {
  /** 打开一个已存在的会话（真机 = uiWorkspace.openSession；0.1.x = sessions.open）。 */
  openSession?: (id: string) => void
  /**
   * **遗留形态容错**：0.1.x 风格直接给的 `open`（与 openSession 同义）。
   * 本插件自己的 `buildSessionNavigator` **只产出 openSession**（规范入口），这里额外认它，
   * 是为了让旧形状的调用方/探针不必改就被正确识别 —— 没有入口时**绝不**用假函数顶上（T9-F1 的根因）。
   */
  open?: (id: string) => void
  /** 会话列表里的 id（**读不出来时抛**，由 `readListed` 归一成「判据未知」）。 */
  listedIds?: () => readonly string[]
  /** 重拉一次列表基线。 */
  refresh?: () => Promise<void>
}

/** 判据未知（列表读不出来）—— 与「确知为空」分开，绝不把未知当成「还没有」。 */
type ListedIds = readonly string[] | null

function readListed(navigator: SessionNavigator): ListedIds {
  if (typeof navigator.listedIds !== 'function') return null
  try {
    return navigator.listedIds()
  } catch {
    return null
  }
}

/**
 * 打开 fork 出来的子会话（S3 的客户端一半）。
 *
 * 顺序与理由（每一档都只说自己能证明的那件事）：
 *  ① 没有导航入口 → `unavailable`（**不说**「还没出现在列表里」——那可能是假的）；
 *  ② 有入口 + 列表可读且确实没有它 → 先 `refresh()` 重拉一次基线再判（fork 在宿主侧执行，
 *     客户端列表可能还没收到增量）；重拉后仍没有 → `degraded`（此时「还没出现在列表里」已被证实）；
 *  ③ 列表不可读（无 list / 读抛）→ 直接尝试导航（判据未知不阻止尝试）；
 *  ④ 导航抛错 → `failed`（有入口但调用失败，同样不假装打开）。
 */
export async function openChildSession(
  navigator: SessionNavigator | undefined,
  childId: string | null | undefined,
): Promise<ChildOpenState> {
  // 规范入口 openSession；兼容遗留的 open（两者都给时以 openSession 为准）。
  const open = navigator === undefined
    ? undefined
    : typeof navigator.openSession === 'function'
      ? navigator.openSession
      : typeof navigator.open === 'function' ? navigator.open : undefined
  if (navigator === undefined || open === undefined) return 'unavailable'
  if (typeof childId !== 'string' || childId === '') return 'degraded'
  let listed = readListed(navigator)
  if (listed !== null && !listed.includes(childId)) {
    if (typeof navigator.refresh === 'function') {
      try {
        await navigator.refresh()
      } catch {
        /* 刷新失败不改变判据口径：下面按重读结果如实判 */
      }
      listed = readListed(navigator)
    }
    if (listed !== null && !listed.includes(childId)) return 'degraded'
  }
  try {
    open.call(navigator, childId)
    return 'opened'
  } catch {
    return 'failed'
  }
}

/** 惰取可选客户端服务的宽读取口：`ctx` 只被当作「有 get(key) 的对象」。 */
export interface OptionalServiceReader {
  get: (key: string) => unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asWorkspaceSource(value: unknown): WorkspaceNavigationSource | null {
  const record = asRecord(value)
  if (record === null) return null
  const openSession = record['openSession']
  return typeof openSession === 'function' ? { openSession: openSession as (id: string) => void } : null
}

function asSessionListSource(value: unknown): SessionListSource | null {
  const record = asRecord(value)
  if (record === null) return null
  const source: SessionListSource = {}
  const open = record['open']
  if (typeof open === 'function') source.open = open as (id: string) => void
  const refresh = record['refresh']
  if (typeof refresh === 'function') source.refresh = refresh as () => Promise<void>
  const list = asRecord(record['list'])
  if (list !== null && typeof list['getSnapshot'] === 'function') {
    source.list = list as unknown as SessionListSource['list']
  }
  return source
}

/**
 * 从一个「有 get(key) 的对象」（真实 `ctx`）惰取两个可选服务。
 *
 * 为什么用 `get` 而不是属性访问：未在 `inject` 里声明的服务做属性访问会抛（AGENTS.md 的 DI 纪律）；
 * `get` 取不到就返回 undefined。任何异常都按「该服务缺失」处理 —— 导航能力缺失必须是**降级**，
 * 不是把插件打挂。
 */
export function navigationSourcesOf(ctx: unknown): NavigationSources {
  const read = ctx as OptionalServiceReader | null | undefined
  if (read === null || read === undefined || typeof read.get !== 'function') return {}
  const safeGet = (key: string): unknown => {
    try {
      return read.get(key)
    } catch {
      return undefined
    }
  }
  return {
    workspace: asWorkspaceSource(safeGet('uiWorkspace')),
    sessions: asSessionListSource(safeGet('sessions')),
  }
}

/**
 * 把服务面收窄成组件用的 `SessionNavigator`（**只在有入口 / 有列表能力时**返回，否则 undefined）。
 *
 * 参数兼容两种形态（都是纯结构收窄，不猜语义）：
 *  · `NavigationSources`（推荐）：`{ workspace, sessions }`；
 *  · 裸 `SessionListSource`：只给会话服务（0.1.x 的 `sessions.open` 分支与单测用）——
 *    等价于 `{ sessions: source }`。
 *
 * 打开入口的优先级：`workspace.openSession`（真机）→ `sessions.open`（0.1.x，**存在才用**）。
 * 二者都没有 ⇒ 不构造 openSession（绝不用假函数顶上，否则必然 TypeError）。
 */
export function buildSessionNavigator(
  sources: NavigationSources | SessionListSource | null | undefined,
): SessionNavigator | undefined {
  const wrapped = sources !== null && sources !== undefined
    && (Object.prototype.hasOwnProperty.call(sources, 'workspace') || Object.prototype.hasOwnProperty.call(sources, 'sessions'))
  const workspace = wrapped ? (sources as NavigationSources).workspace : undefined
  const sessions = wrapped ? (sources as NavigationSources).sessions : (sources as SessionListSource | null | undefined)
  const workspaceOpen = typeof workspace?.openSession === 'function' ? workspace.openSession : undefined
  const legacyOpen = typeof sessions?.open === 'function' ? sessions.open : undefined
  const list = sessions?.list
  const refresh = typeof sessions?.refresh === 'function' ? sessions.refresh : undefined
  if (workspaceOpen === undefined && legacyOpen === undefined && list === undefined && refresh === undefined) return undefined
  const navigator: SessionNavigator = {}
  if (workspaceOpen !== undefined) navigator.openSession = (id: string) => { workspaceOpen.call(workspace, id) }
  else if (legacyOpen !== undefined) navigator.openSession = (id: string) => { legacyOpen.call(sessions, id) }
  if (list !== undefined) navigator.listedIds = () => Object.keys(list.getSnapshot().byId)
  if (refresh !== undefined) navigator.refresh = () => refresh.call(sessions)
  return navigator
}

/** 降级态 → 字典键（`opened` 无需提示，返回 null）；**三档各对应自己的原因**，不共用文案。 */
export function childOpenHintKey(state: ChildOpenState): string | null {
  if (state === 'degraded') return 'chat.open.degraded'
  if (state === 'failed') return 'chat.open.failed'
  if (state === 'unavailable') return 'chat.open.unavailable'
  return null
}

/* ------------------------------------------------------------ 槽位登记（T9-F2：形态探测 + 失败软化） */

/** 槽位声明形态探测面（`ctx.slots`）：只读 spec，宽类型读回 kind（0.2 = list / 0.1.x = chain）。 */
export interface ChatSlotProbe {
  spec: (key: typeof CHAT_ENTRY_SLOT) => unknown
}

/**
 * 登记计划：register = 声明形态是 0.2 的 list 契约；skip 时给出可核验的原因
 * （`per-message-mode` = 偏好已让每条消息各有一颗 icon 入口，回合尾这次**故意不注册**）。
 */
export type ChatEntryPlan =
  | { kind: 'register' }
  | { kind: 'skip'; reason: 'per-message-mode' | 'slot-undeclared' | 'slot-kind-mismatch'; declared: string | null }

/**
 * 回合尾入口（turnTail list 位）的登记门：**偏好为「整回合」时才注册**。
 *
 * 为什么（用户 2026-10-10 第二条要求：「回退按钮只有一个 icon 而不是一个按钮」）：
 * 「每条用户消息」档下，每条消息上已经有那颗 icon 入口；回合尾再追加一个，同一屏就会出现
 * 两颗回退入口（旧行为——用户截图里那颗文字按钮就是它）。两档的分工必须是**互斥**的：
 *  · per-message：只注册 conversation.chat.node/user（每条消息一颗 icon），turnTail **一次都不注册**；
 *  · turn：完全不接管 user（宿主渲染器原样），回合尾那一颗才是入口。
 * 与 `planChatNodeRegistration` 严格互补 —— 两档合起来恒好只有一颗入口。
 */
export function planChatEntryRegistrationForMode(
  mode: ChatEntryMode,
  probe?: ChatSlotProbe | undefined | null,
): ChatEntryPlan {
  if (mode !== 'turn') return { kind: 'skip', reason: 'per-message-mode', declared: null }
  return planChatEntryRegistration(probe)
}

/**
 * 登记计划：**只在声明形态是 `list` 时注册**。
 *
 * 为什么必须探测：0.1.5-rc.2 的 ui-chat 把同一 key 声明成 `chain`（`select` 必填；
 * 0.2 的 ui-slots 契约对 chain 缺 select 会抛）—— 按 list 形态（id/order）注册会抛，
 * 而抛在 `slots.inject` 回调里可能连带打掉入口与宿主启动。探测不到声明（理论不可达：
 * `slots.inject` 保证声明已在）也一律跳过，绝不硬注册。
 */
export function planChatEntryRegistration(probe: ChatSlotProbe | undefined | null): ChatEntryPlan {
  if (probe === undefined || probe === null || typeof probe.spec !== 'function') {
    return { kind: 'skip', reason: 'slot-undeclared', declared: null }
  }
  let spec: unknown
  try {
    spec = probe.spec(CHAT_ENTRY_SLOT)
  } catch {
    return { kind: 'skip', reason: 'slot-undeclared', declared: null }
  }
  const record = typeof spec === 'object' && spec !== null ? spec as { kind?: unknown } : null
  const declared = typeof record?.kind === 'string' ? record.kind : null
  if (declared === 'list') return { kind: 'register' }
  return { kind: 'skip', reason: declared === null ? 'slot-undeclared' : 'slot-kind-mismatch', declared }
}

/** 登记失败 / 跳过的诊断输出（ASCII，与界面文案无关；console.* 实参不触发 i18n 守卫）。 */
function warnChatEntry(message: string): void {
  console.warn(message)
}

/**
 * 槽位登记整体（可测）：偏好门 → 形态探测 → 注册；**任何跳过或异常都只丢这一个入口**，
 * 绝不影响本插件其余槽位与宿主启动（T9-F2 的失败软化 + T2 的单入口纪律）。
 *
 * 偏好门在**最前**：per-message 档下连探测都不做（结果注定是跳过），也让诊断只说一件事。
 * 偏好读取器与 `registerChatNodeEntry` 同形（缺省读 localStorage，单测注入），所以同一份
 * 偏好模块驱动两个入口的互斥关系，不存在第二处真相。
 *
 * @returns disposer；跳过 / 失败时是 no-op。
 */
export function registerChatEntry(options: {
  probe: ChatSlotProbe | undefined | null
  /** 真正的注册调用（组件与 inject 面由调用点给出，保持 register 的编译期校验）。 */
  register: () => () => void
  /** 偏好读取器（缺省读 localStorage；单测注入）。 */
  readMode?: () => ChatEntryMode
  /** 诊断回调（缺省 `console.warn`；单测注入以免污染输出）。 */
  warn?: (message: string) => void
}): () => void {
  const warn = options.warn ?? warnChatEntry
  const mode = (options.readMode ?? readChatEntryMode)()
  const plan = planChatEntryRegistrationForMode(mode, options.probe)
  if (plan.kind === 'skip') {
    if (plan.reason === 'per-message-mode') {
      warn('[config-manager] chat turn tail entry skipped: preference is "per-message" (every user message already carries the one icon entry; the host turn tail stays untouched)')
    } else {
      warn('[config-manager] chat rollback entry skipped: slot "' + CHAT_ENTRY_SLOT + '" declaration is ' + (plan.declared === null ? 'missing' : '"' + plan.declared + '"') + ' (expected "list")')
    }
    return () => {}
  }
  try {
    return options.register()
  } catch (error) {
    warn('[config-manager] chat rollback entry registration failed: ' + (error instanceof Error ? error.message : String(error)))
    return () => {}
  }
}
