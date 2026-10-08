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
import { isENOENT } from '../utils/guards.ts'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 恢复计划指纹（预览-执行一致性）：只取「动作类型 + 目标 + blob」三列 —— 描述文案、详情、顺序无关的
 * 易变字段一律不进，保证同一份快照 + 同一磁盘状态下指纹稳定。内容变化不会改变指纹（同 kind/target），
 * 只有**动作集合真的变了**（文件出现/消失、插件增删）才会不同 —— 那正是需要用户重新确认的情况。
 */
function restorePlanFingerprint(plan: Awaited<ReturnType<typeof planRestore>>): string {
  const lines = plan.actions.map((action) => [action.kind, action.target ?? '', action.blobPath ?? ''].join('\u0000'))
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

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
        // 「读不到」与「没有」必须分清（core 的 out.unreadable，验收 F2）：快照目录被权限/占位挡住时
        // 一律回传事实，界面据此渲染告警 —— 此前这个信号在路由层被丢掉，用户看到的是空列表。
        const out: { unreadable?: string } = {}
        const snapshots = await listSnapshots(snapshotsDir, out)
        writeJson(res, 200, { snapshots, unreadable: out.unreadable ?? null })
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
        // T8-F3：注入宿主**权威**的「当前 DSH 版本」（桌面端 = profileContext.installAnchor 那份运行时）。
        // 不传的话 core 只能按磁盘依赖树 best-effort 探测，而桌面端磁盘上那份可能是过期的 hoisted 副本
        // → 会把「版本相同」误报成「版本不同」。只影响这一条可见告警，不阻断恢复。
        currentDshVersion: host.dshVersion,
      }
      try {
        if (dryRun) {
          // dry-run 零写入、只读探测：不登记 run（并发 dry-run 无害）
          const plan = await planRestore(restoreOpts)
          // git 风格恢复预览：逐动作的变更状态 + 行数统计（读取有上限，见 core/snapshot-diff.ts）。
          // summarize 内部逐项兜底、绝不抛错 —— 统计失败不影响计划本身。
          const changeSummary = await summarizeRestoreChanges({ plan, snapshotDir, homeDir: host.homeDir, msg })
          // 指纹随预览一起下发：执行时带回来即可发现「确认后磁盘又变了」
          writeJson(res, 200, { dryRun: true, plan, changeSummary, planFingerprint: restorePlanFingerprint(plan) })
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
              // 预览-执行一致性：客户端带了预览指纹而当前计划与之不符 → 拒绝（409）并让用户重新预览。
              // 为什么必须挡：用户确认的是「还原 A/B」，此刻磁盘已被改动的话，同一份快照可能多出
              // hostFileRemove / fileRemove 这类**破坏性**动作 —— 确认内容与实际执行内容不一致且无人提示。
              const expectedFingerprint = parsed.value.planFingerprint
              if (expectedFingerprint !== undefined && expectedFingerprint !== restorePlanFingerprint(plan)) {
                host.log.warn('恢复被拒：预览后计划已变化', { snapshotId })
                runs.fail(runId, 'plan-changed')
                writeJson(res, 409, { error: 'plan-changed', code: 'plan-changed', runId })
                return
              }
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
                summary: msg('route.snapshotRestoreSummary', {
                  id: snapshotId,
                  count: report.restored.length,
                  suffix: report.removedPlugins.length > 0 ? msg('route.snapshotRestoreRemovedPluginsSuffix', { count: report.removedPlugins.length }) : '',
                }),
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
        // Phase 4 F3 同源：被未收敛 journal 引用的快照是 SAFE MODE 恢复的唯一证据 ——
        // 自动保留清理早已豁免它们，手动删除也必须挡住（此前只校验了 id 形状）。
        // 读不到引用集合时**保守拒绝**（与自动 prune 的 fail-closed 同一条口径），并让原因可辨。
        if (host.phase3Recovery !== undefined) {
          let referenced: Set<string>
          try {
            referenced = await host.phase3Recovery.store.listReferencedSnapshotIds()
          } catch (error) {
            host.log.warn('快照删除被拒：读取 recovery 引用集合失败', { error: error instanceof Error ? error.message : String(error) })
            writeJson(res, 409, { error: 'recovery-reference-unreadable', code: 'recovery-reference-unreadable' })
            return
          }
          if (referenced.has(id)) {
            writeJson(res, 409, { error: 'snapshot-referenced-by-recovery', code: 'snapshot-referenced-by-recovery' })
            return
          }
        }
        const removed = await deleteSnapshot(snapshotsDir, id)
        const historyError = await tryAppendHistory({
          kind: 'snapshot-delete',
          result: 'success',
          sections: [id],
          snapshotId: id,
          source: 'api',
          summary: msg('route.snapshotDeleteSummary', { id }),
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
        // e2e-F4：快照不存在时**不得**把 fs 原始错误（含服务端绝对路径）回给浏览器 ——
        // 结构化 404 + 机器可读码，文案由界面按码映射；其余失败也不再回显原始 message。
        if (isENOENT(error)) {
          writeJson(res, 404, { error: 'snapshot not found', code: 'snapshot-not-found' })
          return
        }
        writeJson(res, 500, { error: 'failed to update snapshot pin' })
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
