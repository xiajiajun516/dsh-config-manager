/**
 * 路由组：Phase 5 recovery 编排（prefix 路由，内部按 path 分发）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
// t6：「英文界面零中文」——迁移历史 summary 一律由目录键产生；engineMsg 与宿主 makeRouteEnv 的
// `msg` 同源（t2 起 this.msg = engineMsg），但它是**活翻译器**，不依赖 env 是否注入取词器。
import { engineMsg } from './messages.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isValidOperationId } from '../core/journal.ts'
import { RollbackLedgerRefusedError, RollbackPointEngine } from '../core/rollback-point.ts'
import { isRollbackEnabled, setRollbackEnabled } from '../core/rollback-gate.ts'
import { readRollbackEnabledSync, updateUiPrefs } from '../sync/ui-prefs.ts'
import type { RollbackForkSeam, RollbackPreviewResult, RollbackRewindInput, RollbackRewindResult } from '../core/rollback-point.ts'
import { reconcileForkSessions, type ForkReconcileChild, type ForkReconcileOutcome } from '../core/fork-reconcile.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import { scanSessionHealth } from '../utils/session-health-scan.ts'
import { applySessionTitles } from '../core/session-meta.ts'
import { applySessionLogTitles } from '../core/session-title.ts'
import { join } from 'node:path'
import {
  applySessionRepair,
  listSessionRepairs,
  previewSessionRepair,
  rollbackSessionRepair,
} from '../utils/session-repair-service.ts'
import { applySessionLayoutRepair, planSessionLayoutRepair } from '../utils/session-layout-repair-service.ts'
import { sessionHealthNextSteps } from '../index.ts'

/**
 * 回滚点的机器可读结果 → HTTP 状态码。
 * 界面按 body.code / body.outcome 出文案（**不靠状态码猜原因**）：这里只做粗分类，
 * 让调用方能用 HTTP 语义区分「要用户确认（409）/ 目标不存在（404）/ 存储栈不可用（503）/ 真失败（500）」。
 *
 * 完整 code → HTTP 表（t1 冻结，T3/I1 对账用）：
 *   storage-unavailable                                  → 503
 *   record-not-found                                     → 404
 *   invalid-input / created-removals-limit               → 400
 *     （created-removals-limit：待删的「该点未记录」路径超上限 ⇒ 整套拒绝、零写入；是**请求级**拒绝，
 *      不是 500 —— 用户要看到的是「一条都没动」，而不是泛化的「回退失败」）
 *   confirmation-required / protected-point / record-incomplete → 409（denied 也是 409）
 *   session-active                                       → 409
 *     （t8：对话**正在运行**时，任何**带工作区段**的回退一律在路由层与执行层两处被拒、零写入 ——
 *      避免与运行中的工具写盘抢文件。只回溯消息（mode=session）不受影响，照常 fork。）
 *   mutation-locked                                      → 423
 *   method-not-allowed                                   → 405
 *   outcome=partial                                      → 200
 *   outcome=failed / restore-failed / guard-failed / ledger-write-failed → 500（ledger-write-failed 在路由上的可达点只有 delete：引擎 remove 写台账失败时直接回它；rewind 路径**不可达** —— 引擎 capturePoint 写失败在 rewind 里一律转成 guard-failed，见 T10）
 *   nothing-to-restore                                   → 200
 *     （E1：它表示「没有可恢复的内容」= 成功、0 变更（工作区已与该点一致，或该态没有记录任何文件），
 *      整体 outcome 仍是 'restored'。旧版把它与真失败同级映射成 500，用户看到「回滚失败并提示错误500」
 *      —— 语义错位，不是真失败。code 仍在 body 里，界面照常出「该回滚点没有可恢复的内容」。）
 *   其余（ok / deleted / 其它内部分级码出现在 segments[].reasonCode）→ 200
 */
function rollbackHttpStatus(value: { ok?: boolean; code?: string; outcome?: string }): number {
  if (value.code === 'storage-unavailable') return 503
  if (value.code === 'record-not-found') return 404
  if (value.code === 'invalid-input') return 400
  // 待删路径超上限 = 请求级拒绝（零写入），与 invalid-input 同档；界面按 code 出专门文案
  if (value.code === 'created-removals-limit') return 400
  if (value.code === 'confirmation-required' || value.code === 'protected-point' || value.code === 'record-incomplete') return 409
  // t8：运行中对话 + 带工作区段 = 请求级拒绝（与确认门同档的 409，界面按 code 出专门文案）
  if (value.code === 'session-active') return 409
  if (value.code === 'mutation-locked') return 423
  if (value.code === 'method-not-allowed') return 405
  if (value.outcome === 'denied') return 409
  if (value.outcome === 'partial') return 200
  if (value.outcome === 'failed') return 500
  // E1：nothing-to-restore **不在**这一行 —— 「没有可恢复的内容」是成功、0 变更，走 200（见上表）
  if (value.code === 'restore-failed' || value.code === 'guard-failed' || value.code === 'ledger-write-failed') return 500
  return 200
}

/* ------------------------------------------------- t8：运行中对话的写入门 */

/** t8 的机器码（与引擎 `RollbackCode` 里既有的 `session-active` 同一个码；界面按码出字典文案）。 */
const SESSION_ACTIVE_CODE = 'session-active'

/** t8 的 detail（英文机器细节，与其它路由 detail 同档；用户可见文案一律由界面字典给）。 */
const SESSION_ACTIVE_DETAIL = 'conversation is running: wait for the current turn to finish, or rewind session only'

/**
 * 这次回退请求是否**要动工作区**（t8）：显式 `segments` 优先（与引擎 `rewind` 的优先级逐条一致），
 * 否则看 `mode` —— **缺省也是要动的**（`statesForMode(undefined) = ['workspace','session']`）。
 * 所以「UI 默认档」与「显式 mode=files+session / mode=files」都会被这条判据挡住。
 */
function rewindTouchesWorkspace(input: { mode?: string; segments?: readonly string[] }): boolean {
  if (Array.isArray(input.segments)) return input.segments.includes('workspace')
  return input.mode !== 'session'
}

/**
 * t8 的硬拒**什么时候该生效**（判定链里的位置，t8 实现说明的选项 ②）。
 *
 * 既有护栏**优先**：确认门没开（`userConfirmed !== true`）、该点本来就不可回退
 * （`preview.ok !== true || preview.canRestore !== true`：protected / record-incomplete /
 * 记录不存在 / 存储不可用）、或 SAFE MODE 正拦着（由锁门给 423）时，**把结论让给引擎自己的
 * 结构化拒绝** —— 那些情形下说「对话正在运行」是误导：用户等多久都退不了。
 * 只有「这次本来能退、只是因为它正在运行而不能动工作区」时，才用 `session-active`。
 *
 * 两道门（R1 预检 / R2 锁内二道保险）共用这一份判据，绝不各写一套。
 */
export function sessionActiveGateApplies(
  preview: RollbackPreviewResult,
  userConfirmed: boolean,
  safeModeBlocked: boolean,
): boolean {
  if (safeModeBlocked) return false
  if (!userConfirmed) return false
  return preview.ok === true && preview.canRestore === true
}

/**
 * 运行中对话的拒绝结果（t8）：**形状与引擎的 rewind 结果同构**，两处（路由预检 / 锁内二道保险）
 * 共用一份，界面照常走「结果 → 文案」那条链。`segments` 恒为空 = 一段都没动（零写入）。
 *
 * 判据来源只有一个：**preview 已算出的 `session.active`**（引擎按会话日志 mtime 静默窗算）——
 * 路由**绝不自己 stat 会话日志**（那会变成第二份判据，两处迟早漂移）。
 */
export function sessionActiveDenied(id: string, preview: RollbackPreviewResult): RollbackRewindResult {
  return {
    ok: false,
    outcome: 'denied',
    code: SESSION_ACTIVE_CODE,
    id,
    detail: SESSION_ACTIVE_DETAIL,
    segments: [],
    skippedSegments: [],
    storage: preview.storage,
    guidance: [],
    warnings: [],
  }
}

/* ------------------------------------------------- t17：历史 fork 归位（显式触发的一次性动作） */

/**
 * t17：本机**有父会话的子会话**清单（只读）。宿主用 `sessions.parentRelations()`（DSH 存储列举，
 * 解析成本在 DSH 侧已付 —— 路由不自己读盘，与 sessionHealth 同一条纪律）。
 *
 * 拿不到这个方法 / 形状不符 ⇒ **抛错**：绝不用空表冒充「本机没有子会话」——
 * 那会让「归位 0 条」看起来像「本来就没有」，正是本仓反复踩过的「未知当成确知为空」。
 *
 * `subagent` 标记一并带过去（`SessionParentRelation.subagent` = `header.origin === 'subagent'`）：
 * **默认口径会归位全部有父会话的子会话（含 subagent）** —— 这是 captain 2026-10-13 定下的口径：
 * 归位对 subagent 是幂等的（写后逐条复核）、由用户显式触发、逐条回执可审计，而 subagent 在侧栏
 * 本就嵌套在父对话下，归位不改变用户可见结构。`origin='subagent'` **不得**被当成「回退 fork」的
 * 筛选器：真机 58 条 fork 里 50 条自己就带这个标记（core 的 `skipSubagentSessions` 因此默认关）。
 * 调用方据此可预期写量（真机实测：887 条候选 → 877 次归位）。
 */
async function readChildSessions(host: { sessions?: unknown }): Promise<readonly ForkReconcileChild[]> {
  const sessions = host.sessions
  const relations = (sessions as { parentRelations?: unknown } | null | undefined)?.parentRelations
  if (typeof relations !== 'function') throw new Error('session-store-has-no-parentRelations')
  const listed = await (relations as (this: unknown) => Promise<unknown>).call(sessions)
  if (!(listed instanceof Map)) throw new Error('parentRelations-returned-non-map')
  const out: ForkReconcileChild[] = []
  for (const [child, relation] of listed as Map<unknown, unknown>) {
    if (typeof child !== 'string' || child === '') continue
    if (relation === null || typeof relation !== 'object') continue
    const record = relation as { parent?: unknown; subagent?: unknown }
    if (typeof record.parent !== 'string' || record.parent === '') continue
    out.push(record.subagent === true
      ? { sessionId: child, parentSessionId: record.parent, subagent: true }
      : { sessionId: child, parentSessionId: record.parent })
  }
  return out
}

/** 宿主归位结果 → core 的三态（形状不符一律不猜：`ok:true` 才可能算成功）。 */
function mapHostAttachOutcome(value: unknown): ForkReconcileOutcome {
  if (value === null || typeof value !== 'object') {
    return { ok: false, reason: 'unexpected-error', detail: 'attach-outcome-not-an-object' }
  }
  const record = value as { ok?: unknown; reason?: unknown; workspaceId?: unknown; detail?: unknown }
  if (record.ok === true) {
    // 'already-attached' = 官方 fork 早就归位了 ⇒ 只复核、**不重复写**（core 把它记成 already）
    const status = record.reason === 'already-attached' ? ('already' as const) : ('attached' as const)
    return typeof record.workspaceId === 'string' && record.workspaceId !== ''
      ? { ok: true, status, workspaceId: record.workspaceId }
      : { ok: true, status }
  }
  const reason = typeof record.reason === 'string' && record.reason !== '' ? record.reason : 'unexpected-error'
  const detail = typeof record.detail === 'string' && record.detail !== '' ? record.detail : undefined
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

/**
 * t17：**一条**子会话的归位动作 —— 复用 t10 已落地的那一份实现
 * （`DshSessionStoreFacade.attachChildToParentWorkspace`：成员 / 血缘 / cwd 同目录三档
 * + 写后 `list()` 复核，失败带具体理由码）。
 *
 * 为什么按**结构窄化**取用它而不是在 `src/index.ts` 新开一个公开 seam：index.ts 不在本任务 scope，
 * 而这里要的正是同一份判据 —— 另写第二套 attach 迟早与第一套漂移（本仓的既有教训）。
 * 形状不符（老外壳 / 方法被改名）⇒ 逐条 `refused('reconcile-seam-missing')`，**绝不假装已归位**；
 * 后续若把该方法提升为公开 seam，本函数只需改这一处读取。
 */
async function reconcileChildViaHost(host: { sessions?: unknown }, child: ForkReconcileChild): Promise<ForkReconcileOutcome> {
  const sessions = host.sessions
  const attach = (sessions as { attachChildToParentWorkspace?: unknown } | null | undefined)?.attachChildToParentWorkspace
  if (typeof attach !== 'function') {
    return { ok: false, reason: 'reconcile-seam-missing', detail: 'host-session-store-has-no-attachChildToParentWorkspace' }
  }
  const outcome = await (attach as (this: unknown, parentId: string, childId: string) => Promise<unknown>)
    .call(sessions, child.parentSessionId, child.sessionId)
  return mapHostAttachOutcome(outcome)
}

/**
 * 会话 fork seam（S3）：从宿主会话端口取 `forkSession`（DshSessionStoreFacade 里走
 * `ctx.get('sessions').fork(source, boundary, childId?)`）。
 *
 * 结构性窄化读取：端口没这个方法 → undefined，会话段届时结构化 `session-fork-unavailable`
 * （**绝不静默降级**：调用方能在响应里看见到底有没有真的 fork）。
 */
function forkSeamOf(sessions: unknown): RollbackForkSeam | undefined {
  if (sessions === null || typeof sessions !== 'object') return undefined
  const candidate = (sessions as { forkSession?: unknown }).forkSession
  if (typeof candidate !== 'function') return undefined
  const fork = candidate as (sessionId: string, boundarySeq: number) => Promise<{ childSessionId: string; warning?: string } | { error: string }>
  return async ({ sessionId, boundarySeq }) => {
    try {
      const result = await fork.call(sessions, sessionId, boundarySeq)
      const childId = result !== null && typeof result === 'object' ? (result as { childSessionId?: unknown }).childSessionId : undefined
      if (typeof childId === 'string' && childId !== '') {
        // 归位失败（宿主三档都没命中）必须一路带到结果里：丢掉它就会出现「HTTP 入口说已归位、
        // /rollback 命令说没归位」的矛盾（子会话实际停在侧栏「未分组」）。
        const warning = (result as { warning?: unknown }).warning
        return typeof warning === 'string' && warning !== ''
          ? { ok: true, childSessionId: childId, warning }
          : { ok: true, childSessionId: childId }
      }
      const error = result !== null && typeof result === 'object' ? (result as { error?: unknown }).error : undefined
      return { ok: false, code: 'fork-failed', detail: typeof error === 'string' ? error : 'fork-returned-no-id' }
    } catch (err) {
      return { ok: false, code: 'fork-failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** 预览回传的指纹（大小 + mtime）；形状不对一律 undefined（应用期就不会做 TOCTOU 判定）。 */
function readRepairExpect(value: unknown): { size: number; mtimeMs: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const size = record['size']
  const mtimeMs = record['mtimeMs']
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return undefined
  return { size, mtimeMs }
}

/**
 * E1：`body.keep` = `{ sessionId: '<projectKey>/<sessionId>' }`（要保留的**副本身份**，不是绝对路径）。
 * 形状不对的非字符串条目一律忽略 —— 被忽略的重复 id 在服务层按「未点名 keep」**拒绝执行**（绝不猜）。
 */
function readLayoutKeep(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw !== '') out[key] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** E1：`body.unitIds` = 只处理这些单元（`<projectKey>/<sessionId>`）；缺省 = 计划里全部可执行项。 */
function readLayoutUnitIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return out.length > 0 ? out : undefined
}

/** 残留条目（只回传界面需要的四个字段；内部字段 markerReadable 这类不外泄）。 */
type IncompleteCopyPayload = { name: string; dir: string; sourceName: string | null; startedAt: string | null }

/**
 * t54：中断的档案复制残留（cross-F3）。
 *
 * 数据源**只有** t39 的 `DshProfileManager.listIncompleteCopies*` —— 不在这里重新枚举目录：
 * 「什么算残留」必须保持一份实现（判据 = 我们自己的标记文件；绝不引入「看着像残留就删」的启发式）。
 * 读目录失败时回空数组：恢复面板的首要职责是把 incident 说清楚，
 * 绝不因为残留枚举失败而让 /recovery/status 整页 500。
 *
 * t89（S2-3）：失败**仍不 500**（t54 口径不变），但必须把「这是失败」传给界面 ——
 * 否则「枚举失败」与「确实没有残留」在响应里完全同形（都是 `incompleteCopies: []`）。
 * 因此回传 `unreadable`，由调用方决定是否置 `incompleteCopiesUnreadable`。
 * 优先用新宿主/新引擎的 scan（能给出失败事实）；旧宿主/替身只有 listIncompleteCopies
 * ⇒ 拿不到失败事实，按「读到了」处理（绝不凭空误报失败）。
 */
function incompleteCopiesOf(profiles: {
  listIncompleteCopiesScan?(): { copies: IncompleteCopyPayload[]; unreadable: boolean }
  listIncompleteCopies(): IncompleteCopyPayload[]
}): { copies: IncompleteCopyPayload[]; unreadable: boolean } {
  const pick = (c: IncompleteCopyPayload): IncompleteCopyPayload => ({
    name: c.name,
    dir: c.dir,
    sourceName: c.sourceName,
    startedAt: c.startedAt,
  })
  try {
    const scan = profiles.listIncompleteCopiesScan
    if (typeof scan === 'function') {
      const r = scan.call(profiles)
      return { copies: (Array.isArray(r.copies) ? r.copies : []).map(pick), unreadable: r.unreadable === true }
    }
    return { copies: profiles.listIncompleteCopies().map(pick), unreadable: false }
  } catch {
    return { copies: [], unreadable: true }
  }
}

export function recoveryRoutes(env: RoutesEnv): WebRoute[] {
  const {
    dataDir,
    host,
    makeRecoveryExecutors,
    profiles,
    recoveryOrchestrator,
    sessionHealth,
    tryAppendHistory,
  } = env
  return [
    // ------------------------------------------------------------ recovery
    // Phase 5：recovery 编排（prefix 路由，内部按 path 分发）。
    // 禁用 withMutationGate（避免 double-journal）；mutation 路由经 withMutationLock + loopback fence。
    endpoint({ kind: 'prefix', path: '/api/dsh-config-manager/recovery', methods: ['GET', 'POST'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rel = url.pathname.slice('/api/dsh-config-manager/recovery'.length).replace(/^\/+/, '')
      const segments = rel.split('/').filter(Boolean)
      if (segments.length === 0) { writeJson(res, 404, { error: 'not found' }); return }
      if (segments[0] === 'status') {
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const r = await recoveryOrchestrator.status()
        // t54：把「中断的档案复制残留」（cross-F3）一并回传 —— 它们此前既不在档案列表里、
        // 删除又报 notFound，用户在本页既看不到、也没有出口。只读、只追加一个字段（旧客户端忽略之）。
        const incomplete = incompleteCopiesOf(profiles)
        writeJson(res, r.status, {
          ...r.body,
          incompleteCopies: incomplete.copies,
          // t89：枚举失败时显式可见（缺省不新增键 ⇒ 读到时响应逐字与 t54 相同）
          ...(incomplete.unreadable ? { incompleteCopiesUnreadable: true } : {}),
        })
        return
      }
      // T4：会话体检（**只读**）。GET /recovery/sessions?limit=N
      //
      // 为什么挂在 recovery 前缀下而不是新开一条 exact 路由：它与「事故恢复」是同一件事
      // （「我的对话去哪了」），且本族已经是 prefix 路由，加一条子路径不新增路由条目。
      // 只读保证：整条链路（选择器 → 计划项）不写任何字节；写操作只允许在离线 CLI。
      if (segments[0] === 'sessions') {
        // T8：应用内**直接修复**（写路径）。子路径 POST /recovery/sessions/repair 与 /rollback。
        //
        // 为什么现在敢在应用内写会话字节（此前是硬约束「零写入」）：
        // 执行器照抄离线 CLI 的安全序列（写前自校验 → 时间戳备份 → 临时文件原子换入 → 写后复验）；
        // 服务层再加三道可证明的写入门（路径必须落在会话根内 / 无 session.lock / 不在静止期内）、
        // 预览与应用之间的指纹一致性（TOCTOU 拒绝），且回滚只认台账里的 repairId（客户端不能传路径）。
        // 写操作仍过 withMutationLock（与导入/恢复互斥）+ SAFE MODE 闸门 —— 与其它写路由同一口径。
        if (segments.length === 2 && (segments[1] === 'repair' || segments[1] === 'rollback')) {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const homeDir = sessionHealth.homeDir
            await runWithMutationLock(
              host.mutationLock,
              { op: 'session-repair', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => {
                if (segments[1] === 'rollback') {
                  const repairId = typeof body['repairId'] === 'string' ? body['repairId'] : ''
                  if (repairId === '') { writeJson(res, 400, { error: 'repairId required' }); return }
                  const result = await rollbackSessionRepair({ homeDir, dataDir, repairId })
                  await tryAppendHistory({ kind: 'recovery', result: result.ok ? 'success' : 'skipped', sections: [], source: 'recovery', summary: engineMsg('route.recoverySessionRepairRollback') })
                  writeJson(res, 200, result)
                  return
                }
                const unitId = typeof body['unitId'] === 'string' ? body['unitId'] : ''
                if (unitId === '') { writeJson(res, 400, { error: 'unitId required' }); return }
                if (body['apply'] !== true) {
                  writeJson(res, 200, await previewSessionRepair({ homeDir, unitId }))
                  return
                }
                const expect = readRepairExpect(body['expect'])
                // 有损动作（截断）必须由请求体显式放行；缺省拒绝（服务层与执行器各判一次）
                const result = await applySessionRepair({
                  homeDir,
                  dataDir,
                  unitId,
                  ...(expect !== undefined ? { expect } : {}),
                  allowLossy: body['allowLossy'] === true,
                })
                await tryAppendHistory({
                  kind: 'recovery',
                  result: result.ok ? 'success' : 'skipped',
                  sections: [],
                  source: 'recovery',
                  summary: result.ok
                    ? engineMsg('route.recoverySessionRepairDropped', { count: String(result.droppedRows ?? 0) })
                    : engineMsg('route.recoverySessionRepairRejected', { reason: String(result.reason) }),
                })
                writeJson(res, 200, result)
              },
            )
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn(`mutation lock blocked: op=session-repair reason=${error.reason}`)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // E1：**布局归位 / 重复 id 隔离**（写路径）。POST /recovery/sessions/layout
        //
        // 与字节级修复（/repair）的分工：那条改日志**字节**（丢弃重放重复行），这条改**位置**
        // （header cwd 与目录位置不一致的会话搬回正确 projectKey 段）+ 把重复 id 的副本移进隔离目录。
        // 两者共用同一套门模型（SAFE MODE + mutation lock + 逐目标前置 + 失败逐条回滚）。
        //
        // 安全模型与 CLI 的差异（**必须如实写明**）：CLI `dcm sessions repair --fix` 要求「DSH 已停止」；
        // 面板就跑在 DSH 里，不可能满足 —— 因此改为：下面这条 runWithMutationLock（SAFE MODE + 环境锁）
        // + 服务层**逐目标前置**（无 session.lock / 不在 30s 静止期）+ **每次移动或改写后必须**
        // 用 SessionStoreFacade.reindexSessionHeader 刷新索引（刷新失败 → 该条回滚 + 如实汇报）
        // + 失败逐条回滚。依据：导入链 SessionsAdapter.finalizeApply 本来就在 DSH 运行时做同类
        // 「改写首帧 + 归位 + 刷新」。面板文案由前端负责，这里只保证判定与结果如实。
        if (segments.length === 2 && segments[1] === 'layout') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const homeDir = sessionHealth.homeDir
            const keep = readLayoutKeep(body['keep'])
            if (body['apply'] !== true) {
              // 只读：只给计划，**零写入**（不拿锁、不过门 —— 与 /repair 的预览同口径）
              const plan = await planSessionLayoutRepair({ homeDir, ...(keep !== undefined ? { keep } : {}) })
              writeJson(res, 200, plan)
              return
            }
            const unitIds = readLayoutUnitIds(body['unitIds'])
            await runWithMutationLock(
              host.mutationLock,
              { op: 'session-layout-repair', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => {
                // 索引刷新端口：宿主没给（旧外壳）时**不传** —— 服务层会如实回 reindex-unavailable，绝不假装搬成功
                const reindex = host.sessions?.reindexSessionHeader
                const result = await applySessionLayoutRepair({
                  homeDir,
                  ...(keep !== undefined ? { keep } : {}),
                  ...(unitIds !== undefined ? { unitIds } : {}),
                  ...(typeof reindex === 'function' ? { reindex: (sessionId: string) => reindex.call(host.sessions, sessionId) } : {}),
                })
                await tryAppendHistory({
                  kind: 'recovery',
                  result: result.ok ? 'success' : 'skipped',
                  sections: [],
                  source: 'recovery',
                  summary: result.ok
                    ? engineMsg('route.recoverySessionLayoutApplied', { count: String(result.applied) })
                    : engineMsg('route.recoverySessionLayoutPartial', { applied: String(result.applied), failed: String(result.failed), skipped: String(result.skipped) }),
                })
                writeJson(res, 200, result)
              },
            )
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn(`mutation lock blocked: op=session-layout-repair reason=${error.reason}`)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        // 支持 /recovery/sessions/<unitId> 单条查询（unitId 用 / 分隔，故取剩余全部段）。
        const unitFilter = segments.length > 1 ? segments.slice(1).join('/') : undefined
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw)
        try {
          const result = await scanSessionHealth({
            homeDir: sessionHealth.homeDir,
            ...(sessionHealth.targetFormatVersion() !== undefined
              ? { targetFormatVersion: sessionHealth.targetFormatVersion() }
              : {}),
            workspaceKeys: await sessionHealth.workspaceKeys(),
            knownSessionIds: await sessionHealth.knownSessionIds(),
          })
          const rows = unitFilter === undefined ? result.rows : result.rows.filter((row) => row.unitId === unitFilter)
          const slicedRaw = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? rows.slice(0, limit) : rows
          /**
           * 行上补「对话标题」：用户反馈列表只有 `session-<uuid>`，同屏十几条里认不出哪条是自己的对话。
           * 只在**宿主侧**补 —— 标题来自 DSH 会话存储（core/session-meta：聚合缓存 + 逐会话投影），
           * 扫描器保持「只读字节事实」。读不到标题 → 不加该字段（界面回落显示目录名，绝不编造）。
           * **先切片再补**：逐会话投影是按需读的，只给要返回的这些行补（limit 之外的不读盘）。
           */
          const sliced = applySessionTitles(
            slicedRaw,
            await sessionHealth.sessionMeta(slicedRaw.map((row) => row.sessionId)),
          )
          writeJson(res, 200, {
            ok: true,
            // 本次**扫描**只读（修复是另一条写路由 POST /sessions/repair，需显式确认）
            readOnly: true,
            sessionsDir: result.sessionsDir,
            sessionsDirExists: result.sessionsDirExists,
            targetFormatVersion: sessionHealth.targetFormatVersion() ?? null,
            summary: { ...result.summary, untested: result.untested, unreadableEntries: result.unreadableEntries },
            rows: sliced,
            /** 本次响应被 limit 截断掉的条数（0 = 未截断；界面必须能说清「还有 N 条没显示」） */
            truncated: rows.length - sliced.length,
            /** 给用户的下一步（可复制；其它损坏类别仍走离线 CLI） */
            nextSteps: sessionHealthNextSteps(sliced.length, result.summary),
            /** T8：本机可回滚的修复（台账；**不含任何绝对路径**） */
            repairs: await listSessionRepairs(dataDir).then((r) => r.repairs),
            ...(await listSessionRepairs(dataDir).then((r) => (r.error !== undefined ? { repairsError: r.error } : {}))),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // ---------------------------------------- S1–S8：工作区 + 会话回滚点
      // 回滚点 = 工作区快照 + 会话游标（宿主按回合自动留点）。**没有手动「拍点」表单**，
      // 因此这里没有 capture 子路径 —— 留点由宿主订阅 session/event 后走引擎。
      // 挂在既有 recovery prefix 内（与「事故恢复」同一件事，且**不新增路由条目**：本族已是
      // prefix 路由，内部按 path 分发 —— 与 T4/T8 的 sessions 子路径同策略）。
      // 写路径口径：rewind / delete 过 withMutationLock + SAFE MODE（它们写工作区 / fork 会话）；
      // 只读路径（列表 / storage / 详情 / 预览）零写入。
      // 响应一律机器可读 code（界面映射字典键），本文件不产出用户可见文案。
      if (segments[0] === 'rollback-points') {
        const forkSeam = forkSeamOf(host.sessions)
        const engine = new RollbackPointEngine({
          dataDir,
          homeDir: sessionHealth.homeDir,
          log: (line) => host.log.warn(line),
          ...(forkSeam !== undefined ? { fork: forkSeam } : {}),
        })
        // 插件偏好文件与 /sync/ui-prefs 同一份（dataDir/sync/ui-prefs.json）；回滚点开关存在那里，
        // 所以这里派生同一个目录，绝不另立第二个偏好文件。
        const syncDir = join(dataDir, 'sync')
        const sub = segments.slice(1)
        const methodNotAllowed = (): void => { writeJson(res, 405, { error: 'method not allowed', code: 'method-not-allowed' }) }
        const reply = (value: { ok?: boolean; code?: string; outcome?: string }): void => {
          writeJson(res, rollbackHttpStatus(value), value)
        }
        if (sub.length === 0) {
          if (req.method !== 'GET') { methodNotAllowed(); return }
          const listed = await engine.list()
          /**
           * 行上补「对话标题」：台账只记 `sessionId`（= 会话目录名），界面上 `session-<uuid>` 认不出
           * 是哪条对话（2026-10-12 用户要求「会话显示标题而不是 id」）。与 /recovery/sessions **同一份索引、
           * 同一套 `sessionIdKey` 归一化**（core/session-meta 的 applySessionTitles）—— 不另写查表规则。
           * 只读、**绝不编造**：没有这条会话 / 没有标题就不加该字段，界面回落显示 id。
           */
          const points = applySessionTitles(
            listed.points,
            await sessionHealth.sessionMeta(listed.points.map((point) => point.sessionId ?? '')),
          )
          /**
           * ② **聚合缓存与逐会话投影都没有这条会话**时（子代理会话 / 别的档案写的旧会话），再读一次
           *    **会话日志**里的 `session/title` 事件 —— DSH 自己写进日志的名字，是「这条会话的名字」
           *    的最后一份权威来源。只读日志**前缀 1 MiB**、按 `mtime+size` 缓存、一次请求有上界；
           *    仍读不到就不加该字段（界面回落显示会话 id），**绝不从首条消息编造标题**。
           */
          const titled = await applySessionLogTitles(points, join(sessionHealth.homeDir, 'sessions'))
          // 列表响应里的 storage 也带上开关与台账占用：界面**只读这一个响应**就能画开关、
          // 画占用、并决定聊天入口是否收起（少一次请求，也少一处口径分叉）。
          const storageWithPrefs = {
            ...listed.storage,
            rollbackEnabled: readRollbackEnabledSync(syncDir),
            rollbackActive: isRollbackEnabled(),
          }
          writeJson(res, listed.storage.available ? 200 : 503, { ...listed, storage: storageWithPrefs, points: titled })
          return
        }
        // 存储栈状态（缺失时给结构化组合指引；**不崩**）
        // issue #89 P2：随状态一并回传**台账占用**（记录数 / 字节 / 预算 / 已淘汰数，见 engine.storageStatus 的 ledger）
        // 与开关（rollbackEnabled = 磁盘偏好；rollbackActive = 本进程当前是否真的在留点）。
        if (sub.length === 1 && sub[0] === 'storage') {
          if (req.method !== 'GET') { methodNotAllowed(); return }
          const status = await engine.storageStatus()
          writeJson(res, status.available ? 200 : 503, {
            ok: status.available,
            rollbackEnabled: readRollbackEnabledSync(syncDir),
            rollbackActive: isRollbackEnabled(),
            ...status,
          })
          return
        }
        // 回合自动留点的总开关（issue #88 / #89）。
        //
        // 为什么要读写两个语义：磁盘偏好（rollbackEnabled）是**用户意图**、随 self 分区进备份；
        // 进程 gate（rollbackActive）是**此刻真正生效**的东西（关闭后订阅已解绑）。两者正常一致，
        // 只在「另一进程改了文件」这类边界上短暂分叉 —— 分歧就如实分开报，不合并成一个布尔。
        //
        // 写路径过 mutation gate：它改的是「宿主会不会每回合写盘」的行为语义，与 rewind / delete 同级
        //（都在同一把锁里，拒绝一律发生在写任何字节之前）。
        if (sub.length === 1 && sub[0] === 'prefs') {
          if (req.method === 'GET') {
            writeJson(res, 200, { ok: true, rollbackEnabled: readRollbackEnabledSync(syncDir), rollbackActive: isRollbackEnabled() })
            return
          }
          if (req.method !== 'POST') { methodNotAllowed(); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'invalid JSON body' }); return }
            const wanted = body['rollbackEnabled']
            if (typeof wanted !== 'boolean') {
              writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'rollbackEnabled must be a boolean' })
              return
            }
            await runWithMutationLock(
              host.mutationLock,
              { op: 'rollback-prefs', target: 'rollbackEnabled', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => {
                await updateUiPrefs(syncDir, { rollbackEnabled: wanted })
                // 写盘成功才切进程 gate：写失败却把功能打开，等于「界面说开着、实际不留点」
                setRollbackEnabled(wanted)
              },
            )
            writeJson(res, 200, { ok: true, rollbackEnabled: wanted, rollbackActive: isRollbackEnabled() })
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=rollback-prefs reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // 台账清理（issue #89 P1/P2）：把「已经涨上去的占用」收回来。
        //
        // 为什么单独一条子路径而不是并进「磁盘占用清理」：那条清理的候选集被四条不变量钉死
        // （只有可重建区 + 显式勾选的过期导出；snapshots/sync 永不进候选）。回滚点是**数据**不是
        // 可重建区，用户没显式勾选就不能被任何「一键清理」顺走 —— 所以它是自己这条显式入口，
        // 且默认只删自动点（救援点要显式勾选）。语义与单条 delete 一致，只是作用域是整个台账。
        if (sub.length === 1 && sub[0] === 'cleanup') {
          if (req.method !== 'POST') { methodNotAllowed(); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'invalid JSON body' }); return }
            // 与单条 delete 同一条 fail-closed 确认门：必须**恰好** true，缺省不放行
            if (body['userConfirmed'] !== true) {
              writeJson(res, 409, { ok: false, code: 'confirmation-required' })
              return
            }
            const includeGuards = body['includeGuards'] === true
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'rollback-cleanup', target: includeGuards ? 'auto+guard' : 'auto', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => await engine.purgeLedger({ includeGuards }),
            )
            await tryAppendHistory({
              kind: 'recovery',
              result: 'success',
              sections: [],
              source: 'recovery',
              summary: engineMsg('route.rollbackPointCleanup', { records: String(result.removedRecords) }),
            })
            writeJson(res, 200, { ok: true, ...result })
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=rollback-cleanup reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            // 引擎侧的**显式拒绝**带机器码（存储不可用 / 台账读不出）：按码映射 HTTP，
            // 不回落成泛化 500 —— 界面要能说清「是存储栈缺了」还是「台账真读不出来」。
            if (error instanceof RollbackLedgerRefusedError) {
              host.log.warn('rollback cleanup refused: ' + error.code + ' ' + error.message)
              writeJson(res, error.code === 'storage-unavailable' ? 503 : 500, { ok: false, code: error.code, detail: error.message })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // 单条详情（只读：两态摘要 + 完整记录）
        if (sub.length === 1) {
          if (req.method !== 'GET') { methodNotAllowed(); return }
          const id = sub[0] ?? ''
          const detail = await engine.read(id)
          // 存储栈不可用时读不出台账 → 503（绝不把它伪造成「记录不存在」的 404）
          if (!detail.storage.available) {
            writeJson(res, 503, { ok: false, code: 'storage-unavailable', id, detail: detail.storage.detail, storage: detail.storage })
            return
          }
          if (detail.point === undefined) {
            writeJson(res, 404, { ok: false, code: 'record-not-found', id })
            return
          }
          const payload: Record<string, unknown> = { ok: true, id, point: detail.point, storage: detail.storage }
          if (detail.error !== undefined) payload['error'] = detail.error
          writeJson(res, 200, payload)
          return
        }
        // 只读预览：零写入（不过确认门、不留救援点、不写任何字节）
        if (sub.length === 2 && sub[1] === 'preview') {
          if (req.method !== 'GET') { methodNotAllowed(); return }
          reply(await engine.preview(sub[0] ?? ''))
          return
        }
        // 只读：单个**记录在案**文件的前后逐行对照（零写入）。
        // 收窄：路径必须逐字命中该点的工作区记录（引擎内判，未命中一个字节都不读）；
        // 它是「预览弹窗里点『查看』」的数据源，与 preview 同族、同 prefix，不新增围栏面。
        if (sub.length === 2 && sub[1] === 'file-diff') {
          if (req.method !== 'GET') { methodNotAllowed(); return }
          const filePath = url.searchParams.get('path') ?? ''
          reply(await engine.fileDiff(sub[0] ?? '', filePath))
          return
        }
        // 回退：fail-closed 确认门（userConfirmed 必须**恰好** true，引擎内再判一次）。
        // 准入口径（t22）：**没有**任何 kind 层面的额外门 —— 引擎只拒 protected / incomplete，
        // 所以 `kind:'guard'` 的救援点 route 级同样可回退（与 preview().canRestore 同口径）；
        // 「用户不可删 guard」只体现在 delete 分支（引擎回 protected-point）。
        if (sub.length === 2 && sub[1] === 'rewind') {
          if (req.method !== 'POST') { methodNotAllowed(); return }
          const id = sub[0] ?? ''
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'invalid JSON body' }); return }
            const rewindInput: RollbackRewindInput = { id, userConfirmed: body['userConfirmed'] === true }
            const mode = body['mode']
            if (mode === 'files+session' || mode === 'files' || mode === 'session') rewindInput.mode = mode
            const requested = Array.isArray(body['segments'])
              ? body['segments'].filter((item): item is 'workspace' | 'session' => item === 'workspace' || item === 'session')
              : undefined
            if (requested !== undefined) rewindInput.segments = requested
            if (body['allowPartial'] === true) rewindInput.allowPartial = true
            // A（用户 2026-10-11 定案）：「回到某点之前」要连文件一起退回去 —— 默认把**回退点之后新建**的路径删掉；
            // 调用方显式传 false 才保留老口径（只报告 leftovers，不删任何东西）。
            rewindInput.removeCreated = body['removeCreated'] !== false
            // 路径级选择性恢复（2026-10-17 定案 A）：缺省 = 全量口径（一字不变）。
            // 给了数组就只恢复这些路径；**空数组**视为无效输入（400）—— 「一个都没勾」应当由
            // 界面拦住，而不是让引擎把整次回退悄悄变成 noop。
            if (body['onlyPaths'] !== undefined) {
              const raw = body['onlyPaths']
              if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string' || item === '')) {
                writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'onlyPaths must be a non-empty array of non-empty strings' })
                return
              }
              rewindInput.onlyPaths = raw as string[]
            }
            if (body['preRewindGuard'] === 'off' || body['preRewindGuard'] === 'require' || body['preRewindGuard'] === 'warn') {
              rewindInput.guardPolicy = body['preRewindGuard']
            }
            /**
             * R1（t8）：**预检**（零写入、进锁之前）—— 对话正在运行且这次要动工作区 ⇒ 直接 409。
             *
             * 判据只有一个来源：`engine.preview()` 已算出的 `session.active`（引擎按会话日志 mtime
             * 的静默窗算）；路由**绝不自己 stat 会话日志**（两份判据迟早漂移）。
             * 挡住的面：UI 默认档（不带 mode ⇒ files+session）、显式 `mode=files+session` / `files`、
             * 显式 `segments:['workspace',…]`，以及任何直接打 HTTP API 的调用。
             */
            const workspaceRequested = rewindTouchesWorkspace(rewindInput)
            const safeModeBlocked = host.safeModeIsBlocked?.() ?? false
            if (workspaceRequested) {
              const preview = await engine.preview(id)
              if (preview.session.active === true && sessionActiveGateApplies(preview, rewindInput.userConfirmed === true, safeModeBlocked)) {
                writeJson(res, 409, sessionActiveDenied(id, preview))
                return
              }
            }
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'rollback-rewind', target: id, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => {
                /**
                 * R2（t8）：**执行前的二道保险**（锁内、写任何字节之前）。
                 *
                 * `preview()` 每次都会重新 stat 会话日志的 mtime ⇒ 预检与执行之间「对话又跑起来了」
                 * （TOCTOU）也会在这里被挡住，判据与 R1 逐字相同。只回溯消息（`mode=session`）不受影响：
                 * 它不碰工作区，与运行中的工具写盘没有竞争面。
                 */
                if (workspaceRequested) {
                  const fresh = await engine.preview(id)
                  if (fresh.session.active === true && sessionActiveGateApplies(fresh, rewindInput.userConfirmed === true, safeModeBlocked)) {
                    return sessionActiveDenied(id, fresh)
                  }
                }
                return await engine.rewind(rewindInput)
              },
            )
            await tryAppendHistory({
              kind: 'recovery',
              result: result.outcome === 'restored' ? 'success' : result.outcome === 'partial' ? 'skipped' : 'failed',
              sections: [],
              source: 'recovery',
              summary: engineMsg('route.rollbackPointRewind', { outcome: String(result.outcome) }),
              error: result.outcome === 'denied' || result.outcome === 'failed'
                ? String(result.code) + (result.detail !== undefined ? ' ' + result.detail : '')
                : undefined,
            })
            reply(result)
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=rollback-rewind reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // 删除一个回滚点：保护点 / guard 点一律拒绝（「不删被保护点」，无 force 后门）
        if (sub.length === 2 && sub[1] === 'delete') {
          if (req.method !== 'POST') { methodNotAllowed(); return }
          const id = sub[0] ?? ''
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { ok: false, code: 'invalid-input', error: 'invalid JSON body' }); return }
            const confirmed = body['userConfirmed'] === true
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'rollback-delete', target: id, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => (confirmed ? await engine.remove(id) : { ok: false, code: 'confirmation-required' as const, id }),
            )
            if (result.ok) {
              await tryAppendHistory({
                kind: 'recovery',
                result: 'success',
                sections: [],
                source: 'recovery',
                summary: engineMsg('route.rollbackPointDelete', { id }),
              })
            }
            reply(result)
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=rollback-delete reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 404, { error: 'not found' })
        return
      }
      /**
       * t17：历史 fork 归位（POST /recovery/fork-reconcile）—— **用户显式触发的一次性动作**，
       * 不是后台自动跑（归位是**写**：改工作区成员；而且只影响侧栏分组观感）。
       *
       * 语义（逐条对应验收）：① 只读盘点「有 `parentSession` 的子会话」；② 逐条交给 t10 的同一份
       * 归位实现（cwd 解析不到 ⇒ 它自己回 `no-workspace-for-cwd`，**绝不猜**）；③ 写后复核
       * （同一份实现里的 `list()` 复核）—— 复核不通过一律 refused；④ 逐条回执 + 理由分布；
       * ⑤ **绝不动会话日志字节、绝不删任何东西**（core 只编排，IO 全在 seam 里）。
       *
       * 路由数不变：仍挂在 recovery prefix 这一条 endpoint 下（不新增注册条目）。
       */
      if (segments[0] === 'fork-reconcile') {
        if (segments.length !== 1) { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          const result = await runWithMutationLock(
            host.mutationLock,
            { op: 'fork-reconcile', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
            async () => await reconcileForkSessions({
              childSessions: async () => await readChildSessions(host),
              reconcileOne: async (child) => await reconcileChildViaHost(host, child),
              log: (line) => host.log.warn(line),
            }),
          )
          await tryAppendHistory({
            kind: 'recovery',
            result: result.ok ? 'success' : 'failed',
            sections: [],
            source: 'recovery',
            summary: engineMsg('route.recoveryOperationSummary', { action: 'fork-reconcile' }),
          })
          // 盘点就读不出来（读不到父子关系）⇒ 503：**不是**「本机没有子会话」（core 用 error 区分）
          writeJson(res, result.ok ? 200 : 503, result)
        } catch (error) {
          if (error instanceof EnvironmentLockUnavailableError) {
            host.log.warn(`mutation lock blocked: op=fork-reconcile reason=${error.reason}`)
            writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
            return
          }
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // issue #31：残留锁的显式回收路由（POST /recovery/lock/recover）。
      // 必须放在 :operationId 解析**之前**——'lock' 不是 UUID，落到下面会被
      // 400 invalid operationId 挡掉（那正是「文案指向空面板」的同一类错位）。
      if (segments[0] === 'lock') {
        if (segments.length !== 2 || segments[1] !== 'recover') { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          // ⚠️ 故意**不**经 runWithMutationLock/withMutationGate：要回收的正是那把挡住
          // acquire 的残留锁——先取锁必然拿到 STALE_LOCK_DETECTED 并抛 423，回收将永远
          // 无法执行（与 CLI recover-stale-lock 同策略：只 inspect + prove stale + 原子回收，
          // 判定在 EnvironmentLockManager.recoverStaleLock 内部重做，本路由不做删除决策）。
          const body = await readJsonBody(req)
          const r = await recoveryOrchestrator.recoverStaleLock(body?.['userConfirmed'] === true)
          // Phase 6：审计史（成功与拒绝都记，便于事后追查「谁在什么时候回收了锁」）
          await tryAppendHistory({
            kind: 'recovery',
            result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
            sections: [],
            source: 'recovery',
            summary: engineMsg('route.recoveryOperationSummary', { action: 'recover-stale-lock' }),
          })
          writeJson(res, r.status, r.body)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // issue #56：显式解除 SAFE MODE（POST /recovery/safe-mode/clear）。
      // 与 `lock/recover` 同一处置：**故意不经 withMutationGate** —— gate 是「写配置」的闸门，
      // 要解开的正是挡住一切写操作的保护，走 gate 必然 423（等于死锁）；锁定仍走
      // withMutationLock + loopback 围栏。编排器内部用与 verify/dismiss 同一份判据：
      // 还有未解决 incident → 拒绝，故这不是绕过恢复的后门。
      if (segments[0] === 'safe-mode') {
        if (segments.length !== 2 || segments[1] !== 'clear') { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          const body = await readJsonBody(req)
          const r = await recoveryOrchestrator.clearSafeModeBlock(body?.['userConfirmed'] === true)
          await tryAppendHistory({
            kind: 'recovery',
            result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
            sections: [],
            source: 'recovery',
            summary: engineMsg('route.recoveryOperationSummary', { action: 'clear-safe-mode' }),
          })
          writeJson(res, r.status, r.body)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (segments.length !== 2) { writeJson(res, 404, { error: 'not found' }); return }
      const operationId = segments[0]!
      const action = segments[1]!
      if (!isValidOperationId(operationId)) { writeJson(res, 400, { error: 'invalid operationId' }); return }
      const methodFor: Record<string, 'GET' | 'POST'> = { preview: 'GET', confirm: 'POST', execute: 'POST', verify: 'POST', retry: 'POST', dismiss: 'POST' }
      const expected = methodFor[action]
      if (expected === undefined) { writeJson(res, 404, { error: 'not found' }); return }
      if (req.method !== expected) { writeJson(res, 405, { error: 'method not allowed' }); return }
      try {
        if (action === 'preview') {
          const r = await recoveryOrchestrator.preview(operationId)
          writeJson(res, r.status, r.body)
          return
        }
        // mutation 路由：withMutationLock（Phase 2 GLOBAL 锁）+ loopback fence；不 double-journal。
        // 不传 isBlocked：recovery 是解决 SAFE MODE 的机制，若被 SAFE MODE 阻断会死锁。
        await runWithMutationLock(host.mutationLock, { op: `recovery-${action}`, target: operationId }, async () => {
          const body = await readJsonBody(req)
          const userConfirmed = body?.['userConfirmed'] === true
          let r
          if (action === 'confirm') r = await recoveryOrchestrator.confirm(operationId, userConfirmed)
          else if (action === 'execute') r = await recoveryOrchestrator.execute(operationId, userConfirmed, makeRecoveryExecutors)
          else if (action === 'verify') r = await recoveryOrchestrator.verify(operationId)
          else if (action === 'retry') r = await recoveryOrchestrator.retry(operationId, userConfirmed, makeRecoveryExecutors)
          else if (action === 'dismiss') r = await recoveryOrchestrator.dismiss(operationId, userConfirmed)
          else r = { status: 404, body: { error: 'not found' } } as const
          // Phase 6：recovery 迁移历史（best-effort）。在 mutation 结果（execute/retry/verify/dismiss）后记。
          if (action === 'execute' || action === 'retry' || action === 'verify' || action === 'dismiss') {
            await tryAppendHistory({
              kind: 'recovery',
              result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
              sections: [],
              operationId,
              source: 'recovery',
              summary: engineMsg('route.recoveryOperationSummary', { action }),
              error: r.status >= 400 && typeof r.body?.['error'] === 'string' ? String(r.body['error']) : undefined,
            })
          }
          writeJson(res, r.status, r.body)
        })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          host.log.warn(`mutation lock blocked: op=${error.op} reason=${error.reason}${error.detail !== undefined ? ` detail=${error.detail}` : ''}`)
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          return
        }
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
