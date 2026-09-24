/**
 * 路由组：快照与恢复（快照列表 / 恢复 / 删除 / 置顶 / 逐文件差异）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { TransactionRecoveryRequiredError } from '../core/phase3-host.ts'
import { deleteSnapshot, isValidSnapshotId, listSnapshots, planRestore, setSnapshotPinned } from '../core/restore.ts'
import type { RunState } from '../core/run-registry.ts'
import { snapshotFileDiff, summarizeRestoreChanges } from '../core/snapshot-diff.ts'
import { buildFileDiffBody, buildRestoreBody, executeRestorePlan, makeRestoreExecutor } from '../index.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import { join } from 'node:path'

export function snapshotRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    msg,
    runs,
    snapshotEntrySections,
    snapshotsDir,
    tryAppendHistory,
    withMutationGate,
  } = env
  return [
    // ---------------------------------------------------------- snapshots
    // M4：列出快照元信息（id/createdAt/sourceZip/status/计数，createdAt 倒序）
    endpoint({ path: '/api/dsh-config-manager/snapshots', methods: ['GET'] }, async (req, res) => {
      try {
        writeJson(res, 200, { snapshots: await listSnapshots(snapshotsDir) })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------------ restore
    // M4：快照恢复。dryRun=true 只返回动作计划（planRestore，零写入）；
    // 真实执行 = 计划 → 宿主执行器（ctx.fs 整文件/文件还原 + runDshPlugin 卸载插件）
    // → 与 CLI 一致的诚实报告 { restored/removedPlugins/manualHints/failed/skipped }。
    //
    // **并发防护（P1-1）**：真实执行（dryRun=false）经 runs.register('restore') 登记——
    // 同 kind 已有 running 时抛 RunConflictError → 409 拒绝。这是宿主侧的权威防重
    // （前端 loading 只是 UX）：即使两个 tab / 刷新后重复点击，同一时刻至多一个
    // restore 在执行（不同快照并发恢复会交错写文件，同快照并发会互相覆盖
    // pre-restore 双保险备份，都是真实数据风险）。进度经 onAction 埋点更新
    // RunRegistry（/progress 轮询 + /runs 刷新恢复可见）；响应含 runId。
    endpoint({ path: '/api/dsh-config-manager/restore', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const parsed = buildRestoreBody(body)
      if (!parsed.ok) {
        writeJson(res, 400, { error: parsed.error })
        return
      }
      const { snapshotId, dryRun } = parsed.value
      const snapshotDir = join(snapshotsDir, snapshotId)
      const restoreOpts = {
        snapshotDir,
        homeDir: host.homeDir,
        profile: host.profile,
        settingsPath: undefined,
        msg,
        // Phase 4 统一恢复校验：所有 restore 入口传 snapshotsRoot → 同一验证强度（存在/READY/manifest/blob-hash/symlink/provenance）
        snapshotsRoot: snapshotsDir,
        environmentFingerprint: host.phase3Recovery?.recoveryEnvFingerprint ?? undefined,
      }
      try {
        if (dryRun) {
          // dry-run 零写入、只读探测：不登记 run（并发 dry-run 无害）
          const plan = await planRestore(restoreOpts)
          // git 风格恢复预览：逐动作的变更状态 + 行数统计（读取有上限，见 core/snapshot-diff.ts）。
          // summarize 内部逐项兜底、绝不抛错 —— 统计失败不影响计划本身。
          const changeSummary = await summarizeRestoreChanges({ plan, snapshotDir, homeDir: host.homeDir, msg })
          writeJson(res, 200, { dryRun: true, plan, changeSummary })
          return
        }
        // 真实执行（Phase 2 锁：destructive 必须先获取 GLOBAL 环境锁；被挡 → 423）
        await runWithMutationLock(host.mutationLock, { op: 'restore', target: snapshotId, isBlocked: () => host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
          const executeRestore = async (): Promise<void> => {
            // 先登记 run（同 kind running → 409 拒绝重复恢复）
            let run: RunState
            try {
              run = runs.register('restore')
            } catch (error) {
              writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
              return
            }
            const runId = run.runId
            try {
              const plan = await planRestore(restoreOpts)
              const report = await executeRestorePlan(
                plan,
                makeRestoreExecutor(snapshotDir, host, host.profile),
                // m1 埋点：每执行一个恢复动作实时更新 run 状态（/progress 轮询可见）
                (info) => {
                  runs.update(runId, {
                    section: 'restore',
                    item: info.index,
                    itemTotal: info.total,
                    detail: info.detail,
                  })
                },
              )
              runs.finish(runId, report)
              // Phase 6：迁移历史（best-effort）。sections 从快照 entries 的 adapter 去重派生。
              const restoreSections = await snapshotEntrySections(snapshotDir)
              const historyError = await tryAppendHistory({
                kind: 'restore',
                result: 'success',
                sections: restoreSections,
                snapshotId: snapshotId,
                runId,
                source: 'api',
                summary: `恢复快照 ${snapshotId}：还原 ${report.restored.length} 项${report.removedPlugins.length > 0 ? `，卸载插件 ${report.removedPlugins.length}` : ''}`,
              })
              writeJson(res, 200, historyError === undefined ? { dryRun: false, report, runId } : { dryRun: false, report, runId, historyWriteError: historyError })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              runs.fail(runId, message)
              writeJson(res, 400, { error: message, runId })
            }
          }
          // Step 3 P0-A：真实 restore 在已持锁下创建 journal（不 double-acquire；release 由本 gate）
          if (host.phase3Recovery !== undefined && lockCtx !== null) {
            await host.phase3Recovery.runJournaled({ operationType: 'restore', lockCtx, fn: executeRestore })
          } else {
            await executeRestore()
          }
        })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          host.log.warn(`mutation lock blocked: op=${error.op} reason=${error.reason}${error.detail !== undefined ? ` detail=${error.detail}` : ''}`)
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
        } else if (error instanceof TransactionRecoveryRequiredError) {
          writeJson(res, 423, { error: error.message, code: 'transaction-recovery-required' })
        } else {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }),
    // ------------------------------------------- snapshots/delete（P1-⑧）
    // 手动删除单个快照（危险操作：该导入前回滚点不可恢复）。loopback fence（guard）；
    // 只接受合法快照 id（deleteSnapshot 内防穿越）。与自动保留清理不同：置顶快照
    // 只能在这里被用户手动删除。
    endpoint({ path: '/api/dsh-config-manager/snapshots/delete', methods: ['POST'] }, withMutationGate('snapshot-delete', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const id = typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['snapshotId']
          : undefined
        if (!isValidSnapshotId(id)) {
          writeJson(res, 400, { error: 'snapshotId is required and must be a valid snapshot id' })
          return
        }
        const removed = await deleteSnapshot(snapshotsDir, id)
        const historyError = await tryAppendHistory({
          kind: 'snapshot-delete',
          result: 'success',
          sections: [id],
          snapshotId: id,
          source: 'api',
          summary: `删除快照 ${id}`,
        })
        writeJson(res, 200, historyError === undefined ? { ok: true, removed } : { ok: true, removed, historyWriteError: historyError })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })),
    // --------------------------------------------- snapshots/pin（P1-⑧）
    // 置顶/取消置顶快照：置顶快照豁免「最多保留 N 个」的自动清理（只能手动删除）。
    // 纯元数据写（重写 snapshot.json 的 pinned 字段）；loopback fence 必备。
    endpoint({ path: '/api/dsh-config-manager/snapshots/pin', methods: ['POST'] }, withMutationGate('snapshot-pin', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const id = typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['snapshotId']
          : undefined
        const pinned = (body as Record<string, unknown> | undefined)?.['pinned'] === true
        if (!isValidSnapshotId(id)) {
          writeJson(res, 400, { error: 'snapshotId is required and must be a valid snapshot id' })
          return
        }
        await setSnapshotPinned(snapshotsDir, id, pinned)
        writeJson(res, 200, { ok: true, pinned })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, 404, { error: message })
      }
    })),
    // --------------------------------------- snapshots/file-diff（git 风格预览）
    // 单个文件的逐行差异（只读）：before = 当前磁盘文件 / after = 快照 blob。
    // 点开某个文件才请求（列表阶段只做轻量统计），避免会话类快照几百个文件时拖死弹窗。
    // 越界（$DSH_HOME / 快照目录之外）、二进制、超限都返回结构化 reason 而非 5xx。
    endpoint({ path: '/api/dsh-config-manager/snapshots/file-diff', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const parsed = buildFileDiffBody(body)
      if (!parsed.ok) {
        writeJson(res, 400, { error: parsed.error })
        return
      }
      const { snapshotId, kind, target, blobPath } = parsed.value
      try {
        const diff = await snapshotFileDiff({
          snapshotDir: join(snapshotsDir, snapshotId),
          homeDir: host.homeDir,
          kind,
          target,
          blobPath,
          msg,
        })
        writeJson(res, 200, { diff })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
