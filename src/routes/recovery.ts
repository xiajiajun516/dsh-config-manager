/**
 * 路由组：Phase 5 recovery 编排（prefix 路由，内部按 path 分发）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { join } from 'node:path'

import { endpoint, readJsonBody, writeJson } from './kit.ts'
// t6：「英文界面零中文」——迁移历史 summary 一律由目录键产生；engineMsg 与宿主 makeRouteEnv 的
// `msg` 同源（t2 起 this.msg = engineMsg），但它是**活翻译器**，不依赖 env 是否注入取词器。
import { engineMsg } from './messages.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isValidOperationId } from '../core/journal.ts'
import { CheckpointEngine, samePointVerdictOf } from '../core/checkpoint.ts'
import type { CheckpointCaptureInput, CheckpointRewindInput } from '../core/checkpoint.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import { scanSessionHealth } from '../utils/session-health-scan.ts'
import {
  applySessionRepair,
  listSessionRepairs,
  previewSessionRepair,
  resolveSessionUnit,
  rollbackSessionRepair,
} from '../utils/session-repair-service.ts'
import { applySessionLayoutRepair, planSessionLayoutRepair } from '../utils/session-layout-repair-service.ts'
import { sessionHealthNextSteps } from '../index.ts'

/**
 * 检查点的机器可读结果 → HTTP 状态码。
 * 界面按 body.code / body.outcome 出文案（**不靠状态码猜原因**）：这里只做粗分类，
 * 让调用方能用 HTTP 语义区分「要用户确认（409）/ 目标不存在（404）/ 存储栈不可用（503）/ 真失败（500）」。
 */
function checkpointHttpStatus(value: { ok?: boolean; code?: string; outcome?: string }): number {
  if (value.code === 'storage-unavailable') return 503
  if (value.code === 'record-not-found') return 404
  if (value.code === 'invalid-input') return 400
  if (value.code === 'confirmation-required' || value.code === 'protected-checkpoint' || value.code === 'record-incomplete') return 409
  if (value.code === 'invalid-path' || value.code === 'object-hash-mismatch' || value.code === 'object-missing') return 409
  if (value.outcome === 'denied') return 409
  if (value.outcome === 'partial') return 200
  if (value.outcome === 'failed') return 500
  if (value.code === 'restore-failed' || value.code === 'guard-failed' || value.code === 'ledger-write-failed' || value.code === 'nothing-to-restore') return 500
  return 200
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
          const sliced = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? rows.slice(0, limit) : rows
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
      // ------------------------------------------------- C-1 Q4：checkpoint 三态同点
      // 会话游标 + 工作区（显式路径分块）+ 本插件配置三态同点检查点与单命令回滚。
      // 挂在既有 recovery prefix 内（与「事故恢复」同一件事，且**不新增路由条目**：本族已是
      // prefix 路由，内部按 path 分发 —— 与 T4/T8 的 sessions 子路径同策略）。
      // 写路径口径：capture / rewind / delete 过 withMutationLock；rewind/delete 另过 SAFE MODE
      // （它们写工作区 / 会话日志 / 插件配置），capture 不过（它是救援点：SAFE MODE 下也要能用）。
      // 响应一律机器可读 code（界面映射字典键），本文件不产出用户可见文案。
      if (segments[0] === 'checkpoints') {
        const engine = new CheckpointEngine({
          dataDir,
          homeDir: sessionHealth.homeDir,
          log: (line) => host.log.warn(line),
        })
        const sub = segments.slice(1)
        const reply = (value: { ok?: boolean; code?: string; outcome?: string }): void => {
          writeJson(res, checkpointHttpStatus(value), value)
        }
        if (sub.length === 0) {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const listed = await engine.list()
          writeJson(res, listed.storage.available ? 200 : 503, listed)
          return
        }
        // 存储栈状态（缺失时给结构化组合指引；**不崩**）
        if (sub.length === 1 && sub[0] === 'storage') {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const status = await engine.storageStatus()
          writeJson(res, status.available ? 200 : 503, status)
          return
        }
        // 捕获三态同点（chunks = 显式路径分块；unitId 或 sessionLogPath 指定会话）
        if (sub.length === 1 && sub[0] === 'capture') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const chunks = Array.isArray(body['chunks'])
              ? body['chunks'].filter((item): item is string => typeof item === 'string')
              : []
            let sessionLogPath = typeof body['sessionLogPath'] === 'string' ? body['sessionLogPath'] : ''
            let sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
            const unitId = typeof body['unitId'] === 'string' ? body['unitId'] : ''
            if (unitId !== '') {
              // unitId（projectKey/会话目录）→ 会话根内的真实日志文件；解析不出来一律 400（绝不猜）
              const target = await resolveSessionUnit(join(sessionHealth.homeDir, 'sessions'), unitId)
              if (target === undefined) {
                writeJson(res, 400, { ok: false, code: 'invalid-input', detail: 'unitId=' + unitId })
                return
              }
              sessionLogPath = target.file
              if (sessionId === '') sessionId = target.sessionId
            }
            const input: CheckpointCaptureInput = { chunks }
            if (sessionLogPath !== '') input.sessionLogPath = sessionLogPath
            if (sessionId !== '') input.sessionId = sessionId
            if (typeof body['note'] === 'string' && body['note'] !== '') input.note = body['note']
            if (body['protect'] === true) input.protect = true
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'checkpoint-capture' },
              async () => await engine.capture(input),
            )
            if (result.ok) {
              await tryAppendHistory({
                kind: 'recovery',
                result: 'success',
                sections: [],
                source: 'recovery',
                summary: engineMsg('route.recoveryCheckpointCapture'),
              })
            }
            reply(result)
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=checkpoint-capture reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // 单条详情（只读：含三态摘要与「同点」判定事实）
        if (sub.length === 1) {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const id = sub[0] ?? ''
          const detail = await engine.read(id)
          if (detail.record === undefined) {
            writeJson(res, 404, { ok: false, code: 'record-not-found', id, storage: detail.storage })
            return
          }
          const payload: Record<string, unknown> = {
            ok: true,
            id,
            record: detail.record,
            samePoint: samePointVerdictOf(detail.record),
            storage: detail.storage,
          }
          if (detail.error !== undefined) payload['error'] = detail.error
          writeJson(res, 200, payload)
          return
        }
        // 只读预览：零写入（不过确认门、不拍保护点、不写任何字节）
        if (sub.length === 2 && sub[1] === 'preview') {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          reply(await engine.preview(sub[0] ?? ''))
          return
        }
        // 单命令回滚：fail-closed 确认门（userConfirmed 必须**恰好** true，引擎内再判一次）
        if (sub.length === 2 && sub[1] === 'rewind') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const id = sub[0] ?? ''
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const requested = Array.isArray(body['segments'])
              ? body['segments'].filter((item): item is 'workspace' | 'session' | 'config' =>
                item === 'workspace' || item === 'session' || item === 'config')
              : undefined
            const rewindInput: CheckpointRewindInput = { id, confirm: body['userConfirmed'] === true }
            if (requested !== undefined) rewindInput.segments = requested
            if (body['allowPartial'] === true) rewindInput.allowPartial = true
            if (body['preRewindGuard'] === 'off' || body['preRewindGuard'] === 'require' || body['preRewindGuard'] === 'warn') {
              rewindInput.guardPolicy = body['preRewindGuard']
            }
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'checkpoint-rewind', target: id, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => await engine.rewind(rewindInput),
            )
            await tryAppendHistory({
              kind: 'recovery',
              result: result.outcome === 'restored' ? 'success' : result.outcome === 'partial' ? 'skipped' : 'failed',
              sections: [],
              source: 'recovery',
              summary: engineMsg('route.recoveryCheckpointRollback', { outcome: String(result.outcome) }),
              error: result.outcome === 'denied' || result.outcome === 'failed'
                ? String(result.code) + (result.detail !== undefined ? ' ' + result.detail : '')
                : undefined,
            })
            reply(result)
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=checkpoint-rewind reason=' + error.reason)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // 删除一条检查点：保护点 / guard 点一律拒绝（「不删被保护点」，无 force 后门）
        if (sub.length === 2 && sub[1] === 'delete') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const id = sub[0] ?? ''
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const confirmed = body['userConfirmed'] === true
            const result = await runWithMutationLock(
              host.mutationLock,
              { op: 'checkpoint-delete', target: id, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => (confirmed ? await engine.remove(id) : { ok: false, code: 'confirmation-required' as const, id }),
            )
            reply(result)
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn('mutation lock blocked: op=checkpoint-delete reason=' + error.reason)
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
