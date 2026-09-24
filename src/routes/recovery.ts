/**
 * 路由组：Phase 5 recovery 编排（prefix 路由，内部按 path 分发）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isValidOperationId } from '../core/journal.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'

export function recoveryRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    makeRecoveryExecutors,
    recoveryOrchestrator,
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
        writeJson(res, r.status, r.body)
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
            summary: '恢复操作 recover-stale-lock',
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
              summary: `恢复操作 ${action}`,
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
