/**
 * 历史 fork 归位（t17）—— 把「有父会话、但**账内不含它**」的旧子会话收回到它该在的工作区。
 *
 * 背景（t10 真机复核）：本机 887 条有父会话的子会话里 58 条是回退 fork，其中能解析到已注册工作区的
 * 是 **58/58**，但只有 3 条在账内 —— 其余全部停在侧栏「未分组」。t10 的修复只管**新建** fork，
 * 历史遗留不会自动回收；本模块提供一次**显式触发**的归位动作（不是后台自动跑）。
 *
 * 三条纪律（逐条对应验收）：
 *  ① **判据只有一份**：cwd 解析 / 成员判定 / attach / 复核全部由宿主注入的 seam 提供 ——
 *     就是 t10 已落地的 `DshSessionStoreFacade.attachChildToParentWorkspace`（成员 / 血缘 / cwd 同目录三档
 *     + 写后 `list()` 复核）。core **不 import 宿主入口**（架构守卫），也不另写第二套 attach：
 *     第二套判据迟早与第一套漂移。
 *  ② **只读盘点 + 逐个归位 + 逐个复核**，逐条回执（attached / already / refused + **具体**理由）；
 *     任何一条失败都不静默 —— 异常也收成一条 refused（reason=`unexpected-error`）。
 *  ③ **绝不猜、绝不删、绝不动会话日志字节**：本模块自己不碰文件系统（IO 全在 seam 里），
 *     候选只认「有 `parentSession` 的子会话」；能不能归位由 seam 按 cwd/成员事实判定。
 *
 * 为什么收成「一次动作」而不是后台自动跑：归位是**写**（改工作区成员），必须由用户显式触发；
 * 而且它只影响侧栏分组观感，不该在后台悄悄改用户数据。
 */

/** 一个候选子会话（只读事实；cwd 不在这里 —— 它属于 seam 的判定面）。 */
export interface ForkReconcileChild {
  sessionId: string
  parentSessionId: string
  /**
   * 该会话自己是不是**子代理会话**（`header.origin === 'subagent'`；宿主经
   * `sessions.parentRelations()` 的 `SessionParentRelation.subagent` 给）。
   *
   * ⚠️ **它不能用来区分「回退 fork 子会话」**（t17 真机实测，务必别顺手加过滤）：
   * 本机 887 条有父会话的子会话里 58 条是回退 fork（`isSeeded:true`），而这 58 条里
   * **50 条同样带 `origin='subagent'`**（DSH 的 fork 就是用 `agents.create` 造的，标记就是 subagent）。
   * 所以「跳过 subagent」会把**目标本身**（50/58）一起跳掉 ⇒ 该口径默认**关闭**，
   * 只在调用方显式传 {@link ForkReconcileOptions.skipSubagentSessions} 时才生效。
   */
  subagent?: boolean
}

/** 归位动作的可选口径（默认 = 合同字面：**全部**有父会话的子会话）。 */
export interface ForkReconcileOptions {
  /**
   * 跳过 `origin='subagent'` 的子会话（默认 false）。
   *
   * 为什么默认**关**：真机上 50/58 条回退 fork 自己就带这个标记（见 {@link ForkReconcileChild.subagent}），
   * 开了它等于把要修的东西跳掉。给这个开关只为让「窄化」这一选择可被显式表达与复核，
   * 不是默认行为。跳过条数一律记进 {@link ForkReconcileResult.skipped}（不静默）。
   */
  skipSubagentSessions?: boolean
}

/** 逐条回执的状态（三态，互斥）。 */
export type ForkReconcileStatus =
  /** 本次真的写成功且复核通过（seam 给的 `attached`）。 */
  | 'attached'
  /** 已经在账内（seam 给的 `already-attached`）——**幂等：不重复写**。 */
  | 'already'
  /** 没能归位；`reason` 是具体理由码（见 seam 的 WorkspaceAttachFailureReason 同名同义）。 */
  | 'refused'

/** seam 对**一条**子会话的归位结果（与 index.ts 的 `WorkspaceAttachOutcome` 同形同义）。 */
export type ForkReconcileOutcome =
  | { ok: true; status: 'attached' | 'already'; workspaceId?: string }
  | { ok: false; reason: string; detail?: string }

/** 归位动作的注入面（全部只读或由宿主实现；core 只编排）。 */
export interface ForkReconcileDeps {
  /**
   * 只读：本机**有父会话的子会话**清单。宿主用 `sessions.parentRelations()`（DSH 存储列举，
   * 解析成本在 DSH 侧已付）；**读不到必须抛错**，绝不用空表冒充「本机没有子会话」。
   */
  childSessions: () => Promise<readonly ForkReconcileChild[]>
  /** 一条子会话的归位动作（t10 的同一份实现；逐条调用，互不影响）。 */
  reconcileOne: (child: ForkReconcileChild) => Promise<ForkReconcileOutcome>
  /** 逐条留痕（可选；失败必须能被日志看到）。 */
  log?: (line: string) => void
}

/** 一条回执。 */
export interface ForkReconcileReceipt {
  sessionId: string
  parentSessionId: string
  status: ForkReconcileStatus
  /** 机器码：attached/already 时是 seam 的 reason；refused 时是**具体**失败理由。 */
  reason: string
  /** 归位到的工作区 id（拿不到就是 null；只作诊断，不参与判定）。 */
  workspaceId: string | null
  /** 技术细节（errno / 路径 / 形状码）——不是用户文案。 */
  detail?: string
}

/** 归位动作的结果（计数恒为**精确值**；回执列表有界，截断时如实标记）。 */
export interface ForkReconcileResult {
  ok: boolean
  /** 扫描到的父子关系条数（含无父/空 id 的噪声项，只作诊断）。 */
  scanned: number
  /** 真正尝试归位的候选数（有父会话的子会话，去重后）。 */
  candidates: number
  attached: number
  already: number
  refused: number
  /** 失败理由分布（只统计 refused；键 = 理由码）。 */
  reasonCounts: Record<string, number>
  /**
   * **有意跳过**的条数（不是失败，也不是静默丢弃）：只统计「显式窄化」跳过的子代理会话。
   * 默认口径（{@link ForkReconcileOptions.skipSubagentSessions} 未开）下恒为 0。
   */
  skipped: { subagent: number }
  receipts: ForkReconcileReceipt[]
  /** 回执被上限截断（计数仍精确）。 */
  receiptsTruncated: boolean
  /** 盘点阶段就失败（读不到父子关系）时的具体原因；此时 candidates=0 且**不是**「本机没有子会话」。 */
  error?: string
}

/**
 * 回执列表上限。
 *
 * 为什么有界：候选是「本机全部有父会话的子会话」（真机 887 条），逐条回执全量回传会让响应体
 * 无谓地大；计数（attached/already/refused 与理由分布）**恒为精确值**，截断只影响明细列表。
 */
export const FORK_RECONCILE_RECEIPT_LIMIT = 500

/** 一条候选 → 回执（分类只认 seam 给的事实，绝不从「看起来成功」推断）。 */
function receiptOf(child: ForkReconcileChild, outcome: ForkReconcileOutcome): ForkReconcileReceipt {
  if (outcome.ok) {
    return {
      sessionId: child.sessionId,
      parentSessionId: child.parentSessionId,
      status: outcome.status === 'already' ? 'already' : 'attached',
      reason: outcome.status === 'already' ? 'already-attached' : 'attached',
      workspaceId: outcome.workspaceId ?? null,
    }
  }
  const receipt: ForkReconcileReceipt = {
    sessionId: child.sessionId,
    parentSessionId: child.parentSessionId,
    status: 'refused',
    reason: outcome.reason,
    workspaceId: null,
  }
  if (outcome.detail !== undefined) receipt.detail = outcome.detail
  return receipt
}

/**
 * 一次历史 fork 归位：只读盘点 → 逐个归位 → 逐个复核（复核在 seam 内，写后重读 `list()`）。
 *
 * **顺序执行**（不并发）：归位是写动作，且逐条失败理由要能按顺序对上号；候选规模（真机数百条）
 * 与每条的成本（一次 registry 读 + 一次 attach + 一次复核读）都不值得为并发牺牲可读性。
 */
export async function reconcileForkSessions(deps: ForkReconcileDeps, options: ForkReconcileOptions = {}): Promise<ForkReconcileResult> {
  const empty: ForkReconcileResult = {
    ok: false,
    scanned: 0,
    candidates: 0,
    attached: 0,
    already: 0,
    refused: 0,
    reasonCounts: {},
    skipped: { subagent: 0 },
    receipts: [],
    receiptsTruncated: false,
  }
  let listed: readonly ForkReconcileChild[]
  try {
    listed = await deps.childSessions()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.log?.('fork-reconcile: childSessions failed: ' + detail)
    return { ...empty, error: 'child-sessions-unavailable: ' + detail }
  }
  // 候选 = 有父会话的子会话（去重；形状不符的噪声项只计入 scanned）
  const candidates: ForkReconcileChild[] = []
  const seen = new Set<string>()
  let skippedSubagent = 0
  for (const item of listed) {
    const sessionId = item?.sessionId
    const parentSessionId = item?.parentSessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof parentSessionId !== 'string' || parentSessionId === '') continue
    if (sessionId === parentSessionId) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    candidates.push(item.subagent === true
      ? { sessionId, parentSessionId, subagent: true }
      : { sessionId, parentSessionId })
  }
  const attempted = options.skipSubagentSessions === true
    ? candidates.filter((child) => child.subagent !== true)
    : candidates
  skippedSubagent = candidates.length - attempted.length
  if (skippedSubagent > 0) {
    deps.log?.('fork-reconcile: skipped ' + String(skippedSubagent) + ' subagent sessions (explicit narrowing)')
  }
  const receipts: ForkReconcileReceipt[] = []
  const reasonCounts: Record<string, number> = {}
  let attached = 0
  let already = 0
  let refused = 0
  let truncated = false
  for (const child of attempted) {
    let outcome: ForkReconcileOutcome
    try {
      outcome = await deps.reconcileOne(child)
    } catch (error) {
      // 一条失败绝不影响其余（逐条互不影响），且**如实记一条 refused**
      const detail = error instanceof Error ? error.message : String(error)
      deps.log?.('fork-reconcile: ' + child.sessionId + ' threw: ' + detail)
      outcome = { ok: false, reason: 'unexpected-error', detail }
    }
    const receipt = receiptOf(child, outcome)
    if (receipt.status === 'attached') attached += 1
    else if (receipt.status === 'already') already += 1
    else {
      refused += 1
      reasonCounts[receipt.reason] = (reasonCounts[receipt.reason] ?? 0) + 1
      deps.log?.('fork-reconcile: ' + child.sessionId + ' refused: ' + receipt.reason + (receipt.detail !== undefined ? ' ' + receipt.detail : ''))
    }
    if (receipts.length < FORK_RECONCILE_RECEIPT_LIMIT) receipts.push(receipt)
    else truncated = true
  }
  return {
    ok: true,
    scanned: listed.length,
    candidates: attempted.length,
    attached,
    already,
    refused,
    reasonCounts,
    skipped: { subagent: skippedSubagent },
    receipts,
    receiptsTruncated: truncated,
  }
}
