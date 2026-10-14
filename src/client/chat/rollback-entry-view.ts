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
 *  ⑥ **「能不能提交」与「是否已确认」是两个判据**（R1 修复）：`rewindSubmittable` 只回答
 *     「这次提交本身是否成立」（固定段集合非空 + 宿主允许回退），**绝不看 `confirmed`**；
 *     `canSubmitRewind` 在它之上再加「恰好 confirmed === true」。把 confirmed 当**按钮可用性**
 *     的前置会造成循环依赖 —— 确认只在 `confirmOnSubmit`（点按钮那一刻）置位，而按钮又被
 *     未确认禁用 ⇒ 主按钮永久禁用、整个回退功能不可用（真机截图实证）。确认门本身一字未松。
 */
import { redact } from '../../security/redaction.ts'
import {
  ROLLBACK_CODE_UNKNOWN_KEY,
  rollbackChildSession,
  rollbackCodeKey,
  rollbackGuidanceRows,
  rollbackModeSegments,
  rollbackOutcome,
  rollbackPreviewNote,
  rollbackPreviewVerdict,
  rollbackRewindCounts,
  rollbackStateKey,
  type RollbackMode,
  type RollbackPointPort,
  type RollbackPointSummary,
  type RollbackPreviewFile,
  type RollbackPreviewFileStatus,
  type RollbackPreviewResult,
  type RollbackRewindOptions,
  type RollbackGuidanceRowView,
  type RollbackRewindResult,
  type RollbackState,
} from '../../ui/rollback-view.ts'

/* ------------------------------------------------------------ 回合 ↔ 回滚点 */

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
 * 形状 = `src/ui/rollback-view.ts` 的 `RollbackPreviewFile`（**唯一一份形状**，本类型只是给它补上
 * 运行时兜底态：读不出的 status 归 `'unknown'`，而不是编一个引擎取值）。三条不可越过的事实：
 *  · **只列会被改动的文件**（内容已一致的一个都不列 ⇒ 工作区与该回退点一致时是**空数组**）；
 *  · `added` / `removed` 可能是 **null**：单文件超上限 / 累计超限 / 步骤超限 / 非文本 / 对象仓读不出
 *    ⇒ 界面说「行数未统计」，**绝不写成 0**（0 是一个可被证伪的具体断言）；
 *  · `status` 目前只会是 `overwrite` / `create`：整文件删除走**另一条**清单
 *    （`preview.workspace.removals` / `createdSkipped`），不进这份逐文件行级统计；
 *    `delete` 保留在取值集合里只为形状完整 —— 我们不解释它、也不为它编文案。
 */
export type ChatPreviewFileRow = Omit<RollbackPreviewFile, 'status'> & { status: RollbackPreviewFileStatus | 'unknown' }

/**
 * `preview.workspace.files` 的取值域 —— 与 ui 层 `RollbackPreviewFileStatus` 用映射类型**绑定**：
 * 枚举一变（加/删取值）本常量即编译期报错，不存在「两处各写一份、悄悄漂移」。
 */
const PREVIEW_FILE_STATUSES: readonly RollbackPreviewFileStatus[] =
  (['overwrite', 'create', 'delete'] satisfies readonly RollbackPreviewFileStatus[])

function previewCountOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 引擎取值白名单判定（枚举名 —— 类型层已由映射类型绑定，这里只做运行期判定）。 */
function isPreviewFileStatus(value: unknown): value is RollbackPreviewFileStatus {
  return typeof value === 'string' && (PREVIEW_FILE_STATUSES as readonly string[]).includes(value)
}

/**
 * 读 `preview.workspace.files` —— **宽度接收 + 逐字段判定**（与 chat-entry-view 的节点读法同纪律）。
 *
 * 形状已在类型层补齐（`RollbackWorkspacePreview.files`），但**运行期仍必须逐字段判**：
 * 这里吃的是宿主 JSON 响应（老宿主没有该字段，怪形状也可能出现），静态类型管不了线上的字节。
 * 判据：路径读不出就跳过这一条（不编「未知文件」占位）；数字非有限数一律 null（**不谎报 0**）；
 * status 只认引擎枚举，其余归 `'unknown'`（原样透传机器码没有意义）。
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
    const added = previewCountOf(record['added'])
    const removed = previewCountOf(record['removed'])
    rows.push({
      path,
      status: isPreviewFileStatus(record['status']) ? record['status'] : 'unknown',
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

/* ------------------------------------------------------------ 预览：「该点未记录、回退会删掉」的文件 */

/**
 * `preview.workspace.removals` 的读法 —— 回退**会删掉**的文件（该点**未记录**、且过了安全判据的路径）。
 *
 * 为什么「删除」只能从这里读、**不得**从 `files[].added/removed` 或 `leftovers` 反推：
 *  · `preview.workspace.files` 只列**记录在案**的文件（回退只覆盖它们 / 重新创建它们），
 *    引擎的 `files[].status` 不产出 `delete`（整文件删除走**另一条**清单）；
 *  · `leftovers` 是「该点未记录」的**全部**路径 —— 里面混着**永不删除**的拒删项
 *    （`.git`/`node_modules` 段、插件数据区、越界、单文件超上限），且旧宿主只按前 20 条列。
 *    拿它当删除清单**正是**用户 2026-10-12 报的「预览与实际对不上」：预览里混进不会删的、
 *    又会漏掉第 21 条之后真的会删的。
 *  · 真正会被删的是引擎 `planCreatedRemovals` 的产物 —— 预览与执行**共用同一个函数**，
 *    所以这里读到的逐条与 `segments[].removedPaths` 一致。
 * 宿主侧 `POST /recovery/rollback-points/:id/rewind` 的 `removeCreated` **缺省为真**
 * （src/routes/recovery.ts:459：`body['removeCreated'] !== false`），本插件的请求体从不带它
 * ⇒ 点「回退」时它们真的会被删。故界面必须把这件事**说出来**（用户 2026-10-12 第 6 条：
 * 整文件删除写「删除」，不写「+0 -N」）。
 *
 * **不回落 `leftovers`**：那份清单语义不同（含拒删项），回落等于把刚修好的缺陷重新引回来。
 *
 * **全量**：引擎给的就是完整删除集（不再切 20 条），界面直接把这份清单渲染成「删除」行 ——
 * 于是「预览列出的 = 实际删的」逐条成立，不需要任何说明句（用户 2026-10-12：弹窗只要清单）。
 */
export function readRollbackPreviewRemovals(workspace: unknown): string[] {
  const removals = (workspace as { removals?: unknown } | null | undefined)?.removals
  if (!Array.isArray(removals)) return []
  const out: string[] = []
  for (const item of removals) {
    if (typeof item !== 'string' || item === '' || out.includes(item)) continue
    out.push(item)
  }
  return out
}


/**
 * 状态白名单（只用于**断言**：引擎当前只会产出 overwrite / create；delete 保留在取值集合里）。
 * 界面**不**按它分派文案 —— 用户要的是「有哪些文件、增删多少行」，不是变更类型分类。
 */
export function previewFileStatusKnown(status: string): boolean {
  return isPreviewFileStatus(status)
}

/**
 * 文件行的 React key —— **路径 + 行数 + 视图序号**。
 *
 * 为什么不能只用 path（2026-10-12 第二轮）：同一屏里路径可以合法地重复 ——
 * 一个文件既在「会被改动」清单里、又出现在删除清单里（引擎两条清单各自成立），
 * 只用 path 会让 React 报 duplicate key 并可能错挂 DOM。序号把顺序也钉进 key，
 * 于是列表重排时不会出现「行内容与位置错配」的观感。
 */
export function rollbackPreviewFileKey(path: string, added: number | null, removed: number | null, index: number): string {
  return path + '|' + String(added) + '|' + String(removed) + '|' + String(index)
}

/* ------------------------------------------------------------ 回退结果一句话 + 失败原因 */

/** T10 新增的内部码：该态**没有记录任何文件**（工作区段 files=0）；只出现在 segments[].reasonCode。 */
export const ROLLBACK_NO_RECORDED_FILES_CODE = 'no-recorded-files'

/**
 * 结果摘要 —— **一行**说清这次回退到底发生了什么（用户 2026-10-10 第三条要求：结果不再逐段铺开）。
 *
 * `nothing-to-restore` 是**成功**（引擎 E1/T10 语义：outcome='restored'、restored=0，HTTP **200**），
 * 不是失败。但「成功、0 变更」底下有**三件不同的事**（T11 起分开说；旧行为把三种都渲染成
 * 「工作区与该回退点一致」，那是把「没有记录」说成「一致」，违背本仓「两侧诚实」）：
 *  · `noop`      = ③ 记录了条目、且全部已与快照一致（该段 reasonCode='nothing-to-restore'）；
 *  · `no-record` = ① **存在 status==='skipped' 的段**（该态没有可用捕获 / 没有稳定边界 / fork 不可用…）
 *                   ⇒ 说「没有可用的记录（原因：{该段 reasonCode 键}）」；
 *  · `no-files`  = ② **存在 reasonCode==='no-recorded-files' 的段**（该点压根没记录任何文件）。
 *
 * 分派依据**只有** `segments[].status` / `segments[].reasonCode`：
 *  · **禁止解析 `detail`** —— 它的契约是「逐条事实（技术细节，非用户可见文案）」，拿它当分派依据
 *    等于把内部字符串当接口（T10 之前 files=0 与 unchanged 只能靠 detail 区分，所以才新增了码）；
 *  · **禁止自造客户端原因键** —— 原因键一律走 `rollbackCodeKey`（白名单外回落 `rollback.code.unknown`）。
 * 顺序即优先级（与验收逐字一致）：① skipped → ② no-recorded-files → ③ 其余。
 * 只有**顶层 code === 'nothing-to-restore'** 时才走这套分派：outcome=partial 等情形说明真的动了东西，
 * 那时说「无需恢复」才是撒谎（回落 `plain`，由 outcome 徽章 + 计数如实呈现）。
 */
export type ChatRewindSummary =
  | { kind: 'plain'; key: null }
  | { kind: 'noop'; key: string }
  | { kind: 'no-record'; key: string; reasonKey: string }
  | { kind: 'no-files'; key: string }

export function chatRewindSummary(result: RollbackRewindResult | null): ChatRewindSummary {
  if (result === null) return { kind: 'plain', key: null }
  if (result.code !== 'nothing-to-restore') return { kind: 'plain', key: null }
  const segments = Array.isArray(result.segments) ? result.segments : []
  // ① 段被跳过（该态没有可用捕获）—— 取**第一个**被跳过的段作为原因来源（顺序确定，不猜归属）
  const skipped = segments.find((segment) => segment.status === 'skipped')
  if (skipped !== undefined) {
    const code = typeof skipped.reasonCode === 'string' && skipped.reasonCode !== '' ? skipped.reasonCode : null
    return {
      kind: 'no-record',
      key: 'rollback.preview.result.noRecord',
      reasonKey: code === null ? ROLLBACK_CODE_UNKNOWN_KEY : rollbackCodeKey(code),
    }
  }
  // ② 该点没有记录任何文件（T10 的独立码）
  if (segments.some((segment) => segment.reasonCode === ROLLBACK_NO_RECORDED_FILES_CODE)) {
    return { kind: 'no-files', key: 'rollback.preview.result.noFiles' }
  }
  // ③ 其余：记录了条目且全部已一致
  return { kind: 'noop', key: 'rollback.preview.result.noop' }
}

/**
 * 这次回退**真的失败了吗**（T13/F2：只有真失败才渲染「失败原因」盒）。
 *
 * 判据（与验收逐字一致，且**只看结果里的 outcome/status/code**，不解析 detail）：
 *  · `outcome === 'failed' | 'denied'` → 真失败；
 *  · 任一段 `status === 'failed'` → 真失败（partial 里也可能有段级失败）；
 *  · 顶层 code 以 `-failed` 结尾（`restore-failed` / `guard-failed` / `ledger-write-failed`）→ 真失败。
 *
 * **明确不算失败的**（它们不是「回退失败」，各有自己的诚实说法）：
 *  · `restored` + `nothing-to-restore`（成功、0 变更）—— 三种情形由 `chatRewindSummary` 说三句不同的话；
 *  · 被**跳过**的段（`status==='skipped'`）及其 reasonCode（含 `capture-failed`）—— 那是「该态没有可用
 *    捕获」（**为什么**跳过），不是「这次回退失败」；把它当失败就会让成功结果也弹失败盒（正是 F2 的缺陷）。
 * 未知 outcome 且没有任何失败证据时**不渲染**（宁可不猜：outcome 徽章已如实显示 unknown）。
 */
export function chatRewindFailed(result: RollbackRewindResult | null): boolean {
  if (result === null) return false
  const outcome = typeof result.outcome === 'string' ? result.outcome : ''
  if (outcome === 'failed' || outcome === 'denied') return true
  const segments = Array.isArray(result.segments) ? result.segments : []
  if (segments.some((segment) => segment.status === 'failed')) return true
  const code = typeof result.code === 'string' ? result.code : ''
  return code.endsWith('-failed')
}

/**
 * 失败原因行：**可读文案键 + code + detail**（用户要求「失败时仍如实显示 code 与 detail」）。
 *
 * 三件事各司其职：`key` 给人看（用户能读懂的句子）、`code` 给排障（机器码**同时**显示，
 * 但不当成主文案）、`detail` 是宿主的逐条技术细节（渲染前过 redact）。
 * 段级 code 与结果级 code **都收**（真实失败可能只说在某一级）——去重后逐条渲染，绝不静默吞掉。
 * **渲染门在调用点**：只有 `chatRewindFailed(result) === true` 时才把这里的结果上屏（F2）。
 */
export function chatRewindFailure(result: RollbackRewindResult | null): { code: string | null; detail: string | null; keys: string[] } {
  if (result === null) return { code: null, detail: null, keys: [] }
  const keys: string[] = []
  const code = typeof result.code === 'string' && result.code !== '' ? result.code : null
  // t8：`session-active` 作为**结果码**时是「这次带文件段的回退被拒、工作区零改动」——
  // 既有键 `rollback.code.session-active` 描述的是预览里的 reasonCode（仅供参考口径），
  // 所以这里用本轮的专门键（R4：既有键只许追加、不动）。
  //
  // **当前这条分支是防御性的**（2026-10-14 核实）：路由把「运行中回退」以 **409** 返回，而
  // `readJson` 已把响应体里的 code 透传进 `ConfigManagerApiError.code` ⇒ 那条路径走的是
  // `requestRewind` 的 error 分支（键 = `rollback.code.session-active`，文案同样可操作）。
  // 保留的是「结果码直接为 session-active」的口径（2xx 结果或将来别的入口），别删。
  if (code !== null) keys.push(code === 'session-active' ? CHAT_SESSION_ACTIVE_DENIED_KEY : rollbackCodeKey(code))
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

/**
 * 回退结果里**值得单独上屏**的指引行（结果那一屏的「没那么顺」的事实）。
 *
 * `sessionForked` 不在此列 —— 它已经由「子会话 id + 打开按钮」那一行表达；这里只留
 * 「没能挂回原工作区 / 宿主没有 fork 能力 / 工作区已整体回滚」这类**与预期不同**的事实，
 * 否则成功回退会多出一句废话。段级与结果级都收，按 key+detail 去重（同一事实可能两级都在）。
 */
export function chatRewindNotices(result: RollbackRewindResult | null): RollbackGuidanceRowView[] {
  if (result === null) return []
  const rows = [
    ...rollbackGuidanceRows(result.guidance),
    ...(result.segments ?? []).flatMap((segment) => rollbackGuidanceRows(segment.guidance)),
  ]
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (row.key === 'rollback.guidance.sessionForked') return false
    const dedupe = row.key + '|' + (row.detail ?? '')
    if (seen.has(dedupe)) return false
    seen.add(dedupe)
    return true
  })
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
   * 回退范围：由对话框顶部那颗「回退文件的更改」选择框决定（用户 2026-10-12 第 1 条）——
   * 勾选 = `files+session`（默认，= 「回到这条消息之前」：文件与对话一起退），
   * 取消 = `session`（只退对话，工作区一个字节都不动）。
   * 仍然**没有**三选一 mode 单选：取值只有这两档，由 {@link setRevertFiles} 单点置位。
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

/**
 * t8：对话**正在运行**时，预览弹窗里那句说明的字典键（recovery 字典；只追加、不动既有键）。
 * 文案口径：这条对话正在运行 ⇒ 本轮结束前只回溯消息（不动工作区），避免与正在写盘的工具抢文件。
 */
export const CHAT_SESSION_ACTIVE_NOTE_KEY = 'rollback.preview.sessionActive'

/**
 * t8：带工作区段的回退被**拒**（HTTP 409 + code `session-active`）时，结果屏那句话的字典键。
 *
 * 为什么不复用既有的 `rollback.code.session-active`：那个键的文案是「仅供参考：回退只 fork 子会话，
 * 不改写原日志」—— 它描述的是**预览里的 reasonCode**（会话日志刚被写过），
 * 与「这次带文件段的回退被拒、工作区一个字节都没动」是两件事（R4：既有键只许追加，不动）。
 */
export const CHAT_SESSION_ACTIVE_DENIED_KEY = 'rollback.sessionActive.denied'

/**
 * t8：这条对话此刻**正在运行**吗（引擎 preview 已算好的 `session.active`：会话日志 mtime 落在静默窗内）。
 *
 * 判据只有这一处（客户端不自己看 mtime）：它决定默认档位、文件开关的可用性，以及
 * 「带工作区段的提交是否可行」。路由层对同一信号有独立的一道硬拒（409 `session-active`）。
 */
export function isSessionActive(preview: RollbackPreviewResult | null): boolean {
  return preview?.session?.active === true
}

/**
 * 草稿默认值（每次返回**新对象**）：未确认、不请求部分放行、救援点恒 require。
 *
 * 回退范围（t8）：对话**正在运行**时默认 = `session`（**只回溯消息**，工作区一个字节都不动）——
 * 运行中的工具可能正在写盘，默认把文件一起退回去等于和它抢文件；用户要连文件一起退，
 * 得等本轮结束（那时 preview 的 `session.active` 已为 false，重开弹窗即回到 `files+session`）。
 */
export function defaultDraft(preview: RollbackPreviewResult | null): RewindDraft {
  return {
    confirmed: false,
    mode: isSessionActive(preview) ? 'session' : CHAT_REWIND_MODE,
    allowPartial: false,
    preRewindGuard: 'require',
  }
}

/**
 * 「用户点了主按钮」这一刻置位确认 —— 对话框唯一的确认入口（**没有**勾选框）。
 * 未点之前 `confirmed` 恒 false，`buildRewindOptions` 恒 null（端口零调用）。
 */
export function confirmOnSubmit(draft: RewindDraft | null): RewindDraft | null {
  return draft === null ? null : { ...draft, confirmed: true }
}

/* ------------------------------------------------------------ 「回退文件的更改」选择框（第 1 条） */

/**
 * 这颗选择框**能不能**被点，两条判据缺一不可：
 *  · 工作区态**有可用记录**（`preview.workspace.available === true`）—— 没有记录时开关点了也没有
 *    任何区别；
 *  · **对话不在运行中**（t8）—— 运行中带文件段的回退在路由层就被硬拒（409 `session-active`），
 *    所以这里禁用而不是「点得动但必然失败」：按钮可用性不该承诺一件做不到的事（与 F3 同一条纪律）。
 * 只回溯消息（`mode=session`）不受这条限制。
 */
export function canRevertFiles(preview: RollbackPreviewResult | null): boolean {
  return preview?.workspace?.available === true && !isSessionActive(preview)
}

/** 草稿当前是否「连文件一起回退」（选择框的受控值；除 `session` 外都算开）。 */
export function revertFilesOn(draft: RewindDraft | null): boolean {
  return draft !== null && draft.mode !== 'session'
}

/**
 * 选择框 → 草稿：**`mode` 的唯一置位入口**。
 * 开 = `files+session`（文件与对话一起退）；关 = `session`（只退对话）。
 * 不动 `confirmed`：确认仍只由**点主按钮那一刻**的 {@link confirmOnSubmit} 置位（确认门一字未松）。
 */
export function setRevertFiles(draft: RewindDraft | null, on: boolean): RewindDraft | null {
  return draft === null ? null : { ...draft, mode: on ? CHAT_REWIND_MODE : 'session' }
}

/**
 * 这次提交**本身**是否成立（= 固定段集合非空 + **宿主允许回退**）—— enablement 与提交共用的那一半。
 *
 * **绝不看 `confirmed`**：确认是「点击那一刻」的事（`confirmOnSubmit`），只属于写请求门，
 * 不属于「这次提交是否可行」的判据。
 */
function rewindViable(draft: RewindDraft | null, preview: RollbackPreviewResult | null): boolean {
  if (draft === null) return false
  const segments = segmentsForMode(draft.mode)
  if (segments.length === 0) return false
  // t8：对话正在运行时，**带工作区段**的提交不可行（路由层同样硬拒 409）—— 判据与默认档、开关可用性同源。
  if (isSessionActive(preview) && segments.includes('workspace')) return false
  return rollbackPreviewVerdict(preview).canRestore
}

/**
 * 主按钮**是否可点**（enablement 判据）：与「点下去会不会真的提交」同口径 —— 只要这次提交
 * 本身成立（`rewindViable`），按钮就可点，**与 `confirmed` 无关**。
 *
 * R1 的根因（真机截图实证：主按钮永久灰色）：确认只可能由**点击那个按钮**置位
 * （`confirmOnSubmit` 在 `submit()` 里调用），旧实现却把 `draft.confirmed` 当成按钮可用性的前置
 * ⇒ 按钮因未确认而禁用、确认又只能靠点这个按钮 ⇒ 循环依赖，整个回退功能不可用。
 * 因此可点性必须与确认彻底分开：按钮可点 = 这次提交可行。**这不放宽任何门** ——
 * `canRestore === false`（受保护点 / 两态不全 / 没有可用段 …）时本判据照旧返回 false，按钮仍禁用。
 */
export function rewindSubmittable(draft: RewindDraft | null, preview: RollbackPreviewResult | null): boolean {
  return rewindViable(draft, preview)
}

/**
 * 主按钮的**完整 enablement**（对话框接线实际用的那一份）：可提交 + **已命中回滚点** + 不在忙。
 *
 * F3：`submit()` 自己要求 `pointId !== null`（没有可写目标就没有请求体），enablement 必须与它同宽 ——
 * 否则「按钮亮着但点下去静默无反应」就是新的不实（按钮可用性承诺了这次点击会做点什么）。
 * `pointId === null` 在对话框里只存在于「列表已读、预览未到」的窗口，原子置位下当前不可达；
 * 这里纳入它是为了让**判据的维度与执行体一致**，而不是依赖「当前不可达」这种会腐烂的推理。
 */
export function submitButtonEnabled(input: {
  draft: RewindDraft | null
  preview: RollbackPreviewResult | null
  /** 命中的回滚点 id（唯一写路径的目标）；null = 还没有可写目标。 */
  pointId: string | null
  /** 是否已有一次提交在途（写入过程中的 UI 锁；**不是**同一 tick 的幂等锁）。 */
  busy: boolean
}): boolean {
  if (input.pointId === null) return false
  if (input.busy) return false
  return rewindSubmittable(input.draft, input.preview)
}

/**
 * **提交**（写请求成形）的门：`rewindSubmittable` 的全部条件 + 用户已确认（点按钮那一刻置位）
 * + 固定段集合非空 + **宿主允许回退**。确认门一字未松。
 *
 * 与旧版的口径差异（有意）：旧版在「两态不全」时允许勾选 `allowPartial` 后放行；简洁版没有
 * 这个勾选，两态不全的点在界面上如实说不可回退（按钮禁用），**不假装能退**。
 */
export function canSubmitRewind(draft: RewindDraft | null, preview: RollbackPreviewResult | null): boolean {
  if (draft === null || draft.confirmed !== true) return false
  // 点「回退」即 userConfirmed=true：确认门由对话框本身承担（预览 → 点按钮 两步）。
  return rewindViable(draft, preview)
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

/* ------------------------------------------------------------ 同一 tick 的同步幂等锁（F4） */

/**
 * **同步幂等锁**（single-flight）：`run(task)` 同步置位 in-flight 标记后才执行 task；
 * 标记已被占用时的调用**不执行 task**、直接返回 `false`。返回值 = 「这次是否真的执行了」。
 * `finally` 释放 ⇒ 一次失败之后仍可重试（不是永久熔断）。
 *
 * 为什么必须有它（t3 F4）：`busy` 是 React 的**异步** setState —— 同一 tick 里第二次程序化派发
 * （双击、按键重复、程序化 dispatchEvent）看到的仍是 `busy === false`，单靠 busy 闸门会发**两次**
 * 写请求；而回退是写操作（覆盖 + fork 会话），必须恰好一次。锁的置位发生在第一个 `await` 之前，
 * 所以那个窗口根本不存在。它不是 UI 状态，因此也不参与渲染。
 */
export function createInFlightLock(): (task: () => Promise<void>) => Promise<boolean> {
  let locked = false
  return async (task) => {
    if (locked) return false
    locked = true
    try {
      await task()
      return true
    } finally {
      locked = false
    }
  }
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
  rollbackPreviewNote,
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
  /**
   * 「新建一条会话」——真机 = uiWorkspace.startSession（与「新会话」按钮同一条路：
   * DSH 自己铸 UUID id、自己归到当前工作区）。
   *
   * 为什么需要它：**第一条用户消息之前没有上一个回合**，fork 不出任何边界（会话段结构化
   * no-boundary）。参照实现（Anionex/dsh-turn-rewind）在这种情形用 Host `session.create`
   * 建一个同目录空会话，而不是硬 fork 一个空子会话 —— 我们走客户端同一入口。
   */
  startSession?: () => Promise<unknown>
}

/**
 * 会话归档面（A：无感替换）—— 真机 = client `workspaces.archiveSession(id)`。
 *
 * 为什么需要它：DSH 的会话「回到某点之前」只能**新建**会话（官方 fork，日志 append-only）。
 * 要让用户看到的是「这条对话退回去了」，就得把原会话收进「已归档」——否则列表里并排两条，
 * 观感就是「分了叉」。归档是官方 API 且非破坏：用户可以在「已归档」里找回来。
 */
export interface SessionArchiveSource {
  archiveSession?: (id: string) => Promise<unknown>
}

/** 三个可选客户端服务的结构面（都惰取；缺谁少谁的能力）。 */
export interface NavigationSources {
  workspace?: WorkspaceNavigationSource | null
  sessions?: SessionListSource | null
  workspaces?: SessionArchiveSource | null
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

/**
 * 开一条全新会话（首条消息之前的回退用）。**绝不抛**：没有入口 / 调用失败都结构化返回。
 * 与 archiveParentSession 同一套纪律：抽出来的方法一律 bind 回服务对象（丢 receiver 会抛）。
 */
export async function startFreshSession(
  source: WorkspaceNavigationSource | null | undefined,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const start = source?.startSession
  if (typeof start !== 'function') return { ok: false, code: 'start-session-unavailable' }
  try {
    await start()
    return { ok: true }
  } catch (error) {
    return { ok: false, code: error instanceof Error && error.name !== '' && error.name !== 'Error' ? error.name : 'start-session-failed' }
  }
}

function asWorkspaceSource(value: unknown): WorkspaceNavigationSource | null {
  const record = asRecord(value)
  if (record === null) return null
  const openSession = record['openSession']
  // **必须把 receiver 绑回宿主服务对象**（2026-10-11 真机实证）：
  // uiWorkspace.openSession 的实现是 `this.replaceMain(target, this.lifetime.signal, "reveal")`，
  // 把方法抄进一个新字面量对象后 receiver 变成那个字面量 ⇒ `this.lifetime` 为 undefined ⇒
  // TypeError: Cannot read properties of undefined (reading 'signal')。回退本身成功、子会话也已创建，
  // 但**永远打不开**（界面只能说「请手动打开它」）。bind 之后 `open.call(...)` 的 this 不再生效，
  // 这正是我们要的：可见性判据留在调用点，receiver 只认方法自己那一份。
  const startSession = record['startSession']
  const hasOpen = typeof openSession === 'function'
  const hasStart = typeof startSession === 'function'
  if (!hasOpen && !hasStart) return null
  return {
    ...hasOpen ? { openSession: (openSession as (id: string) => void).bind(record) } : {},
    ...hasStart ? { startSession: (startSession as () => Promise<unknown>).bind(record) } : {},
  }
}

/** 归档面的结构收窄；方法一律 bind 回服务对象（丢 receiver 会抛，见 asWorkspaceSource 的注释）。 */
function asArchiveSource(value: unknown): SessionArchiveSource | null {
  const record = asRecord(value)
  if (record === null) return null
  const archiveSession = record['archiveSession']
  return typeof archiveSession === 'function'
    ? { archiveSession: (archiveSession as (id: string) => Promise<unknown>).bind(record) }
    : null
}

function asSessionListSource(value: unknown): SessionListSource | null {
  const record = asRecord(value)
  if (record === null) return null
  const source: SessionListSource = {}
  // 与 asWorkspaceSource 同一条纪律：抽出来的方法一律 bind 回原服务对象（refresh 的实现体读
  // `this.manager.refreshList()`；丢 receiver 会让基线拉取**必然抛**，被 catch 吞成「刷新无效」）。
  const open = record['open']
  if (typeof open === 'function') source.open = (open as (id: string) => void).bind(record)
  const refresh = record['refresh']
  if (typeof refresh === 'function') source.refresh = (refresh as () => Promise<void>).bind(record)
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
    workspaces: asArchiveSource(safeGet('workspaces')),
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

/* ------------------------------------------------------------ A（无感替换）：把原会话收进「已归档」 */

/** 归档尝试的结果（**绝不抛**；`code` 是机器码，界面按 {@link archiveHintKey} 取文案，绝不裸渲染）。 */
export type ArchiveOutcome = { ok: true } | { ok: false; code: string }

/** 归档失败文案键（**闭集**：给 rt() 用，绝不放裸字符串）。 */
export type ArchiveHintKey = 'rollback.rewind.archive.unavailable' | 'rollback.rewind.archive.active' | 'rollback.rewind.archive.failed'

/** 失败码 → 字典键（成功无需提示，返回 null）。按**子串**判定，不猜具体 RPC 码字面量。 */
export function archiveHintKey(outcome: ArchiveOutcome): ArchiveHintKey | null {
  if (outcome.ok) return null
  const code = outcome.code.toLowerCase()
  if (code.includes('unavailable')) return 'rollback.rewind.archive.unavailable'
  if (code.includes('active')) return 'rollback.rewind.archive.active'
  return 'rollback.rewind.archive.failed'
}

/** 远程错误对象里的稳定码（RPC 层的 `error.code`）；读不出就 null。 */
function remoteCode(value: unknown): string | null {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
  const code = record?.['code']
  return typeof code === 'string' && code !== '' ? code : null
}

/** 异常上的稳定码：优先 `error.code`，其次非泛型的 `error.name`。 */
function errorCodeOf(error: unknown): string | null {
  return remoteCode(error) ?? (error instanceof Error && error.name !== '' && error.name !== 'Error' ? error.name : null)
}

/**
 * 归档一个会话（A 的最后一步：让列表里只剩「退回去的那条对话」）。**绝不抛**：
 *  · 本客户端没有归档入口 → `archive-unavailable`；
 *  · 宿主拒绝（会话还有活动中的工作 / 未知会话）→ 原样带回机器码（界面映射成文案）；
 *  · 其它异常 → `archive-failed`。
 *
 * 有界重试**一次**：刚导航到新会话时，原会话的「活动」状态可能还没落定，DSH 会以
 * WorkspaceActiveSessionError 拒绝归档（真机唯一观察到的失败面）；重试一次覆盖，绝不无限轮询。
 * `delay` 可注入（测试不真等待）。
 */
export async function archiveParentSession(
  source: SessionArchiveSource | null | undefined,
  sessionId: string,
  options: { delay?: (ms: number) => Promise<void> } = {},
): Promise<ArchiveOutcome> {
  const archive = source?.archiveSession
  if (typeof archive !== 'function') return { ok: false, code: 'archive-unavailable' }
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'archive-no-session' }
  const wait = options.delay ?? ((ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) }))
  let last = 'archive-failed'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result: unknown = await archive(sessionId)
      const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : null
      if (record !== null && record['ok'] === false) last = remoteCode(record['error']) ?? 'archive-failed'
      else return { ok: true }
    } catch (error) {
      last = errorCodeOf(error) ?? 'archive-failed'
    }
    if (attempt === 0) await wait(400)
  }
  return { ok: false, code: last }
}
