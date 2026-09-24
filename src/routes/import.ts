/**
 * 路由组：导入/导出流水线的传输与运行阶段（download / upload / decrypt-archive / execute / execute-skip / progress / runs）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, readJsonBody, writeJson, queryParam } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import type { RunState } from '../core/run-registry.ts'
import type { ImportPlan } from '../core/types.ts'
import { decryptErrorText, isControlledPath, tryDecryptCredentials, writeRequestBodyToFile } from '../index.ts'
import { SecurityError, decryptArchive, isArchiveBlob, verifyEncryptedBlob } from '../security/index.ts'
import { redact } from '../security/redaction.ts'
import { atomicWriteFile } from '../utils/atomic-write.ts'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** Cap on raw upload bodies (staged to the controlled tmp dir). 原先在 index.ts，随路由一起迁入本组。 */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

export function importRoutes(env: RoutesEnv): WebRoute[] {
  const {
    bootSafetyAudit,
    cancelDecisionTimeoutMs,
    host,
    makeImporter,
    msg,
    roots,
    runAbortControllers,
    runCancels,
    runs,
    tmpDir,
    tryAppendHistory,
    withMutationGate,
  } = env
  return [
    // ------------------------------------------------------------ download
    endpoint({ path: '/api/dsh-config-manager/download', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const p = queryParam(url, 'path')
      if (p === undefined || p === '') {
        writeJson(res, 400, { error: 'path query parameter is required' })
        return
      }
      const target = resolve(p)
      if (!isControlledPath(target, roots)) {
        writeJson(res, 403, { error: 'path outside controlled staging area' })
        return
      }
      let stat
      try {
        stat = await fs.stat(target)
      } catch {
        writeJson(res, 404, { error: 'file not found' })
        return
      }
      if (!stat.isFile()) {
        writeJson(res, 400, { error: 'not a file' })
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        'content-disposition': `attachment; filename="${basename(target).replace(/"/g, '')}"`,
        'referrer-policy': 'no-referrer',
      })
      await new Promise<void>((resolvePromise, reject) => {
        const source = createReadStream(target)
        source.on('error', reject)
        res.on('error', reject)
        source.pipe(res)
        source.on('end', resolvePromise)
      })
    }),
    // -------------------------------------------------------------- upload
    endpoint({ path: '/api/dsh-config-manager/upload', methods: ['POST'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const name = queryParam(url, 'name') ?? 'backup.zip'
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        writeJson(res, 413, { error: 'upload body too large' })
        return
      }
      const tmp = join(tmpDir, `upload-${randomBytes(6).toString('hex')}.zip`)
      try {
        const sizeBytes = await writeRequestBodyToFile(req, tmp, MAX_UPLOAD_BYTES)
        // 探测上传文件是否为整体加密备份容器（DCA1 magic）：加密容器不能直接当作 ZIP 解析，
        // UI 据此插入「解锁加密备份」阶段（decrypt-archive），解出明文 ZIP 后再走导入。
        let containerType: 'zip' | 'encrypted' = 'zip'
        try {
          const first = await fs.readFile(tmp)
          containerType = isArchiveBlob(first) ? 'encrypted' : 'zip'
        } catch {
          containerType = 'zip'
        }
        writeJson(res, 200, { zipPath: tmp, name, sizeBytes, containerType })
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        if (!res.headersSent) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        } else {
          res.destroy()
        }
      }
    }),
    // ------------------------------------------------------ decrypt-archive
    // 整体加密备份容器的解锁（只读，零写入到任何配置）：用备份密码解密上传的加密容器，
    // 得到明文 ZIP 写入受控临时目录并返回新 zipPath，供 analyze/plan/execute 引用。
    // 导出时容器密码与内部 secrets.enc 密码同源（同一 password 派生两层加密），
    // 因此顺带在明文 ZIP 上解出内部凭据覆盖清单（refs，非值）一并返回——
    // 导入全程只需输入这一次密码，无需第二个密码校验页面。
    // 密码仅内存随请求体传入，绝不落盘/落日志；解出的明文 ZIP 亦为临时文件，导入结束后清理。
    endpoint({ path: '/api/dsh-config-manager/decrypt-archive', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const encryptedPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
      if (encryptedPath === '' || !isControlledPath(encryptedPath, roots)) {
        writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
        return
      }
      const password =
        typeof body?.['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
      if (password === undefined) {
        writeJson(res, 400, { error: msg('import.encryptedPasswordRequired') })
        return
      }
      let plainZipPath: string | null = null
      try {
        const container = await fs.readFile(encryptedPath)
        if (!isArchiveBlob(container)) {
          writeJson(res, 400, { error: msg('import.notEncryptedContainer') })
          return
        }
        // 校验密码（只读）+ 取真实解密参数
        const verified = await verifyEncryptedBlob(container, password)
        if (!verified.valid) {
          writeJson(res, 400, { error: msg('import.notEncryptedContainer') })
          return
        }
        if (!verified.ok || verified.info === null || verified.kdf === null) {
          writeJson(res, 400, { error: decryptErrorText(new SecurityError('BAD_PASSWORD', '解密认证失败'), msg) })
          return
        }
        // 解密得到明文 ZIP（Security-sensitive transient：随机独占名 + 0600 + 先权限后写，用后即删）
        const plain = await decryptArchive(container, verified.info, verified.kdf, password)
        plainZipPath = join(tmpDir, `decrypted-${randomBytes(6).toString('hex')}.zip`)
        await atomicWriteFile(plainZipPath, plain, { mode: 0o600, symlink: 'reject' })
        // 顺带解出内部凭据覆盖清单（同一密码；旧版 DSC1-only 备份无 secrets.enc → 空）
        let refs: string[] = []
        try {
          const decrypted = await tryDecryptCredentials(plainZipPath, password)
          if (decrypted !== undefined) refs = [...decrypted.keys()]
        } catch {
          // 内部凭据解密失败不影响容器解锁结果（密码已通过容器 GCM 认证）
        }
        writeJson(res, 200, { zipPath: plainZipPath, refs })
      } catch (error) {
        if (plainZipPath !== null) await fs.rm(plainZipPath, { force: true }).catch(() => undefined)
        writeJson(res, 400, { error: decryptErrorText(error, msg) })
      }
    }),
    // ------------------------------------------------------------- execute
    endpoint({ path: '/api/dsh-config-manager/execute', methods: ['POST'] }, withMutationGate('import-apply', async (req, res, lockCtx, journalCtx) => {
      const body = await readJsonBody(req)
      const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
      if (zipPath === '' || !isControlledPath(zipPath, roots)) {
        writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
        return
      }
      const plan = body?.['plan'] as ImportPlan | undefined
      if (plan === undefined || typeof plan !== 'object' || !Array.isArray(plan['items'])) {
        writeJson(res, 400, { error: 'plan is required and must be an ImportPlan' })
        return
      }
      const opts = (body?.['opts'] ?? {}) as Record<string, unknown>
      // 加密备份的解密密码（仅内存，来自导入向导 decrypt 阶段；绝不落盘/落日志）。
      // core 层强制：加密备份必须成功解密后才允许执行（import.encryptedPasswordRequired）。
      const decryptPassword =
        typeof opts['decryptPassword'] === 'string' && opts['decryptPassword'] !== ''
          ? opts['decryptPassword']
          : undefined
      // m1：执行开始注册 run（同 kind 已有进行中任务 → 409 拒绝，防止重复导入）
      let run: RunState
      try {
        run = runs.register('import')
      } catch (error) {
        writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const runId = run.runId
      // 用户「跳过当前插件」通道：登记本 run 的当前项中止控制器（/execute/skip abort 它）
      const abortController = new AbortController()
      runAbortControllers.set(runId, abortController)
      // 运行中心「终止」通道：run 级中止信号（/runs/cancel abort 它）+ 用户选择回传面
      // （/runs/cancel/decision settle 它）。decided 保证「用户选择」与「等待超时」只有一方生效。
      const cancelEntry: { signal: AbortController; settle: (d: 'rollback' | 'keep') => void; decided: boolean } = {
        signal: new AbortController(),
        settle: () => { /* 由下方覆盖：先登记再赋值，避免 settle 引用未初始化 */ },
        decided: false,
      }
      let settleCancel: ((d: 'rollback' | 'keep') => void) | null = null
      const cancelDecision = new Promise<'rollback' | 'keep'>((resolveFn) => { settleCancel = resolveFn })
      cancelEntry.settle = (decision) => {
        if (cancelEntry.decided) return
        cancelEntry.decided = true
        settleCancel?.(decision)
      }
      runCancels.set(runId, cancelEntry)
      try {
        let decryptedCredentials: Map<string, string> | undefined
        try {
          decryptedCredentials = await tryDecryptCredentials(zipPath, decryptPassword)
        } catch (error) {
          // 解密失败（密码错误/篡改）：转用户可读错误，不落 run 账（未开始执行）
          throw new Error(decryptErrorText(error, msg))
        }
        const result = await makeImporter().executeImportPlan(zipPath, plan, {
          confirm: opts['confirm'] === true,
          secretInputs:
            opts['secretInputs'] !== null && typeof opts['secretInputs'] === 'object'
              ? opts['secretInputs'] as Record<string, string>
              : {},
          rollbackOnError: opts['rollbackOnError'] === true,
          decryptedCredentials,
          // Phase 4 生产 snapshot 接线：deferred journal 绑定的 ctx 透传给引擎，
          // 使快照创建后立即 bindSnapshot（SNAPSHOT_CREATED）→ markApplying（APPLYING）再执行。
          snapshotBinding: journalCtx,
          // 运行中心：安全点取消 + 用户决策（引擎只在计划项边界读 cancelSignal）
          cancelSignal: cancelEntry.signal.signal,
          onCancelDecision: async () => {
            runs.setPendingDecision(runId, 'cancel')
            runs.appendLog(runId, msg('import.cancelAwaitingDecision'))
            // 超时兜底：用户迟迟不选不能让 run 永久停在安全点（安全侧默认 = 回滚）
            const timer = setTimeout(() => {
              if (cancelEntry.decided) return
              cancelEntry.decided = true
              runs.appendLog(runId, msg('import.cancelDecisionTimeout'))
              settleCancel?.('rollback')
            }, cancelDecisionTimeoutMs)
            try {
              return await cancelDecision
            } finally {
              clearTimeout(timer)
              runs.setPendingDecision(runId, null)
            }
          },
          bootSafetyAudit,
          // m1 埋点：每开始一个计划项实时更新 run 状态（detail=当前执行项，
          // 供 UI 显示「正在安装插件 X」/ 判定跳过按钮；/progress 轮询可见）
          onItemStart: (info) => {
            runs.update(runId, {
              section: info.adapter,
              item: info.index,
              itemTotal: info.total,
              detail: info.detail,
            })
          },
          // m1 埋点：每完成一个计划项实时更新 run 状态（/progress 轮询可见）
          onItem: (info) => {
            runs.update(runId, {
              section: info.adapter,
              item: info.index,
              itemTotal: info.total,
              detail: info.detail ?? info.adapter,
            })
          },
          // 执行日志：逐计划项操作 + 子进程命令行。宿主侧先 redact 再落账，
          // 保证 RunState.log 恒为非敏感（/progress 轮询回传浏览器）。
          onLog: (line) => {
            runs.appendLog(runId, redact(line))
          },
        })
        // 结束写结果：导入结果落账（供 /progress 查询与刷新恢复）
        runs.finish(runId, result)
        // Phase 6：迁移历史（best-effort）。sections 从导入计划的 items[].adapter 去重派生。
        const importSections = Array.from(
          new Set(plan.items.map((i) => (i as { adapter?: string }).adapter).filter((s): s is string => typeof s === 'string' && s !== '')),
        )
        const historyError = await tryAppendHistory({
          kind: 'import',
          result: result.ok ? 'success' : 'failed',
          sections: importSections,
          operationId: journalCtx?.operationId,
          snapshotId: result.snapshotId ?? undefined,
          runId,
          source: 'api',
          summary: `导入完成：${importSections.join(', ') || '无分区'}（执行 ${result.executed.length} 项）`,
          error: result.ok ? undefined : '导入未完全成功',
        })
        writeJson(res, 200, historyError === undefined ? { ...result, runId } : { ...result, runId, historyWriteError: historyError })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        runs.fail(runId, message)
        host.log.error('导入执行失败', { error: message })
        writeJson(res, 400, { error: message, runId })
      } finally {
        runAbortControllers.delete(runId)
        runCancels.delete(runId)
      }
    }, { deferredSnapshot: true })),
    // ------------------------------------------------------------ progress
    // m1：查询单个 run 的实时状态（轮询 / 刷新恢复用；runId 不可猜，走 loopback-only 守卫）
    endpoint({ path: '/api/dsh-config-manager/progress', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const runId = queryParam(url, 'runId')
      if (runId === undefined || runId === '') {
        writeJson(res, 400, { error: 'runId query parameter is required' })
        return
      }
      const state = runs.get(runId)
      if (state === undefined) {
        writeJson(res, 404, { error: msg('run.notFound', { runId }) })
        return
      }
      writeJson(res, 200, state)
    }),
    // ----------------------------------------------------------------- runs
    // m1：列出 run（刷新恢复时重新订阅进度用）。
    // scope=recent 供「运行中心」一次拿全 running + 刚结束的 run（终态受保留期约束，非持久审计）。
    endpoint({ path: '/api/dsh-config-manager/runs', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const scope = queryParam(url, 'scope')
      writeJson(res, 200, scope === 'recent' ? runs.listRecent(50) : runs.listActive())
    }),
    // ------------------------------------------------------- runs/cancel
    // 运行中心「终止」：只在**计划项边界**生效的协作式取消（abort run 级信号）。
    // 故意**不经 withMutationGate**：调用时 /execute 正持 GLOBAL 环境锁，走 gate 必然 423
    // mutation-locked（与 /execute/skip 同一处置）。决策由 /runs/cancel/decision 回传。
    endpoint({ path: '/api/dsh-config-manager/runs/cancel', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const runId = typeof body?.['runId'] === 'string' ? body['runId'] : ''
      if (runId === '') {
        writeJson(res, 400, { error: 'runId is required' })
        return
      }
      const entry = runCancels.get(runId)
      if (entry === undefined) {
        // 区分「没有这个 run」与「这个 run 不支持协作式取消」——后者是能力边界，不是 404
        writeJson(res, runs.get(runId) === undefined ? 404 : 409, {
          error: runs.get(runId) === undefined
            ? 'no task found for this runId'
            : msg('runs.cancelUnsupported'),
        })
        return
      }
      entry.signal.abort()
      // 顺手 abort「当前计划项」：run 级取消只在**项边界**生效，而插件安装可以跑几十分钟 ——
      // 不 kill 当前项，用户就得干等它装完才轮得到决策框。per-item signal 只对会起子进程的项
      // 有意义（插件安装 → killTree 整棵进程树），其余项忽略它（无害 no-op）。
      runAbortControllers.get(runId)?.abort()
      // 记录请求时刻：界面据此显示「已等待 X 分钟」，让用户能判断「在装插件」还是「卡死了」。
      runs.requestCancel(runId)
      runs.appendLog(runId, msg('runs.cancelWaitingSafePoint'))
      writeJson(res, 200, { requested: true })
    }),
    // 用户选择：回滚 / 保留已应用项（安全点上的引擎正在等这个回答；超时由 /execute 侧兜底）
    endpoint({ path: '/api/dsh-config-manager/runs/cancel/decision', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const runId = typeof body?.['runId'] === 'string' ? body['runId'] : ''
      const raw = body?.['decision']
      const decision = raw === 'rollback' || raw === 'keep' ? raw : null
      if (runId === '' || decision === null) {
        writeJson(res, 400, { error: 'runId and decision (rollback|keep) are required' })
        return
      }
      const entry = runCancels.get(runId)
      if (entry === undefined) {
        writeJson(res, 404, { error: 'this task is not waiting for a decision' })
        return
      }
      // 诚实回报「这一票算不算数」：等待超时后引擎已按安全侧默认（回滚）继续，
      // 此时晚到的选择不能再改变结果 —— accepted:false 让 UI 如实告诉用户，而不是假装成功。
      const accepted = !entry.decided
      entry.settle(decision)
      writeJson(res, 200, { accepted, decision })
    }),
    // -------------------------------------------------- execute/skip
    // 用户跳过当前计划项（导入中，目前仅插件安装）：abort 当前项的中止控制器 → 引擎
    // 捕获 ImportUserSkippedError 记为 user-skipped，导入继续执行其余项。
    endpoint({ path: '/api/dsh-config-manager/execute/skip', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const runId = typeof body?.['runId'] === 'string' ? body['runId'] : ''
      if (runId === '') {
        writeJson(res, 400, { error: 'runId is required' })
        return
      }
      const controller = runAbortControllers.get(runId)
      if (controller === undefined) {
        writeJson(res, 404, { error: 'no running import found for this runId' })
        return
      }
      controller.abort()
      writeJson(res, 200, { skipped: true })
    }),
  ]
}
