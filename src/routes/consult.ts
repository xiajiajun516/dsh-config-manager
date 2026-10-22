/**
 * 路由组：迁移前咨询（只读健康评分 + 建议）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import { isENOENT } from '../utils/guards.ts'
import { redact } from '../security/redaction.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isControlledPath } from './route-support.ts'
import { buildLocalSnapshotSource, readExportZipSource } from '../core/consult-source.ts'
import { FileSnapshotStore, verifySnapshot } from '../core/index.ts'
import { computeConsultReport } from '../core/migration-consult.ts'
import type { ConsultSourceData, ConsultSourceRef, MigratabilityResult } from '../core/migration-consult.ts'
import { isValidSnapshotId, planRestore } from '../core/restore.ts'
import type { SectionId } from '../schema/types.ts'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 受控区内「存在但读不了」的 fs 错误码（→ 400）。 */
const CONSULT_UNREADABLE_CODES: readonly string[] = ['EACCES', 'EPERM', 'EISDIR', 'EBADF', 'EINVAL']

/**
 * routes-R1（t47）：受控区**内**的读失败也必须结构化 —— 此前 fs 原文会原样回给浏览器
 * （`ENOENT: no such file or directory, open 'C:\…\staging\staged.zip '`），既泄漏服务端绝对路径，
 * 又把「路径不可用」误报成 5xx。与 /snapshots/pin（e2e-F4）同一口径：**机器可读码 + 固定文案**，
 * 永不回显原始 message（含目录自身 → EISDIR 这类「存在但读不了」）。
 *
 * 覆盖 t30 登记的 5 种形态：尾随空格 / 尾随点 / ADS `x.zip:evil` / 区内不存在的文件 → 404；
 * 目录自身 → 400。
 */
function consultSourceFailure(error: unknown): { status: number; body: { error: string; code: string } } {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (isENOENT(error) || code === 'ENOTDIR') {
    return { status: 404, body: { error: 'consult source not found', code: 'consult-source-not-found' } }
  }
  if (typeof code === 'string' && CONSULT_UNREADABLE_CODES.includes(code)) {
    return { status: 400, body: { error: 'consult source is not readable', code: 'consult-source-unreadable' } }
  }
  return { status: 500, body: { error: 'consult failed', code: 'consult-failed' } }
}

export function consultRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    makeImporter,
    makeSyncEngine,
    prepareSync,
    roots,
    snapshotsDir,
  } = env
  return [
    // ------------------------------------------------------ consult
    // Phase 7：迁移前咨询（只读健康评分 + 建议）。POST，loopback fence。
    // 对 4 种可迁移源（export-zip / local-snapshot / remote-snapshot / profile）生成
    // 统一咨询报告。**只读**：不写配置/快照/journal；临时 ZIP 用 try/finally 立即清理。
    endpoint({ path: '/api/dsh-config-manager/consult', methods: ['POST'] }, async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const type = body?.['type']
        const id = body?.['id']
        const snapshotId = body?.['snapshotId']
        if (typeof type !== 'string' || typeof id !== 'string' || id === '') {
          writeJson(res, 400, { error: 'type and id are required' })
          return
        }
        if (!['export-zip', 'local-snapshot', 'remote-snapshot', 'profile'].includes(type)) {
          writeJson(res, 400, { error: `unknown consult type: ${type}` })
          return
        }
        const ref: ConsultSourceRef = {
          type: type as ConsultSourceRef['type'],
          id,
          snapshotId: typeof snapshotId === 'string' ? snapshotId : undefined,
        }
        const target = { targetDsh: host.dshVersion, targetPlatform: host.platform }
        const computeMigratability = async (zipPath: string): Promise<MigratabilityResult> => {
          try {
            const importer = makeImporter()
            const analysis = await importer.analyzeImport(zipPath)
            const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })
            return {
              ok: analysis.valid,
              itemCount: plan.items.length,
              fatalConflicts: plan.items.filter((i) => i.kind === 'Conflict').length,
              warnings: plan.items.filter((i) => i.severity === 'warning').length,
              sections: analysis.sectionsInZip,
              errors: analysis.errors,
            }
          } catch (err) {
            // t53：这批文本会进 200 报告的诊断项（用户据此知道「为什么不能迁移」）—— 保留可读性，
            // 但**出响应体前必须过 redact()**（与 UI 展示层同一道，不落 secret）。
            return { ok: false, itemCount: 0, fatalConflicts: 0, warnings: 0, sections: [], errors: [redact(err instanceof Error ? err.message : String(err))] }
          }
        }

        let data: ConsultSourceData
        if (type === 'export-zip') {
          // routes-F3：与 /analyze、/plan、/execute、/decrypt-archive、/market/prepare、/me/upload、/me/update、
          // /download 同一口径 —— 请求里的路径必须落在受控暂存区（roots = [exportsDir, tmpDir]）。
          // 此前这里把请求体里的 id 直接当路径交给 fs.readFile，任意绝对路径都会被打开。
          if (!isControlledPath(id, roots)) {
            writeJson(res, 400, { error: 'id must reference a staged archive (export dir or upload staging area)' })
            return
          }
          data = await readExportZipSource(ref, id, { computeMigratability })
        } else if (type === 'remote-snapshot') {
          // 用持久化 sync 配置构建引擎，下载快照 → 临时 ZIP → 读取（try/finally 清理）。
          //
          // ⚠️ 必须把**请求体**转交给 prepareSync：它解析的是 body（transport + 地址），
          // 传 {} 会以 `repoUrl is required` 失败（真机反馈：远端快照的「迁移前咨询」不能用）。
          // 客户端为此带上 transport 与 repoUrl/url（与 /sync/snapshots-list 同一份payload来源）。
          const syncCfg = await prepareSync({
            ...(typeof body?.['transport'] === 'string' ? { transport: body['transport'] } : {}),
            ...(typeof body?.['repoUrl'] === 'string' ? { repoUrl: body['repoUrl'] } : {}),
            ...(typeof body?.['url'] === 'string' ? { url: body['url'] } : {}),
          })
          const engine = makeSyncEngine(syncCfg)
          const preview = await engine.preview({ snapshotId: ref.snapshotId ?? id })
          if (!preview.ok || preview.zipPath === '') {
            // t53：上游（git/webdav）失败文本可能含**远端 URL / 路径** —— 与 t47 的 consultSourceFailure
            // 同一口径：响应体只给结构化码 + 固定文案，**绝不回显原始 message**；细节只进日志（过 redact）。
            const detail = typeof preview.message === 'string' ? preview.message : ''
            if (detail !== '') {
              console.warn('[dsh-config-manager] consult remote-snapshot preview failed: ' + redact(detail))
            }
            writeJson(res, 400, { error: 'remote snapshot unavailable', code: 'consult-remote-unavailable' })
            return
          }
          try {
            data = await readExportZipSource(ref, preview.zipPath, { computeMigratability })
          } finally {
            await fs.rm(dirname(preview.zipPath), { recursive: true, force: true }).catch(() => undefined)
          }
        } else if (type === 'local-snapshot') {
          if (!isValidSnapshotId(id)) {
            writeJson(res, 400, { error: 'invalid snapshot id' })
            return
          }
          const verify = await verifySnapshot(snapshotsDir, id)
          const snapshotDir = join(snapshotsDir, id)
          // 从快照条目推导将恢复的分区（entries[].adapter）
          const snapshot = await new FileSnapshotStore({ dir: snapshotsDir }).load(id).catch(() => null)
          const snapshotSections = new Map<SectionId, unknown>()
          for (const e of snapshot?.entries ?? []) {
            if (e.adapter !== undefined) snapshotSections.set(e.adapter, {})
          }
          let restorePlan = { itemCount: 0, conflicts: 0, warnings: 0, sections: [] as SectionId[], errors: [] as string[] }
          try {
            const plan = await planRestore({
              snapshotDir,
              homeDir: host.homeDir,
              profile: host.profile ?? 'web',
              snapshotsRoot: snapshotsDir,
              // T20（收口 T8-F3）：本路径也在**宿主内**运行 → 传宿主权威版本（桌面端 = installAnchor
              // 那份运行时），与 routes/snapshots.ts、core/model-tools.ts、cli/actions.ts(具名函数) 同口径。
              // 只有离线 CLI 才退化成 profile 依赖树兜底；这里不得退化成兜底，否则又变成「3 处权威 + 1 处兜底」。
              currentDshVersion: host.dshVersion,
            })
            restorePlan = {
              itemCount: plan.actions.length,
              conflicts: plan.actions.filter((a) => a.kind === 'skip').length,
              warnings: plan.actions.filter((a) => a.kind === 'skip').length,
              sections: [...snapshotSections.keys()],
              errors: [],
            }
          } catch (err) {
            // t53：同 computeMigratability —— 进 200 报告的诊断文本，出响应体前过 redact()。
            restorePlan.errors = [redact(err instanceof Error ? err.message : String(err))]
          }
          data = buildLocalSnapshotSource(ref, {
            sections: snapshotSections,
            verify,
            restorePlan,
            sourceDsh: host.dshVersion,
            sourcePlatform: host.platform,
          })
        } else {
          // 旧「配置档案」（profile.json 快照）源已随该功能一并移除：该类型不再有生产者。
          writeJson(res, 400, { error: `unsupported consult source type: ${type}` })
          return
        }

        const report = computeConsultReport(data, target, { allowBlock: true })
        writeJson(res, 200, report)
      } catch (error) {
        // routes-R1（t47）：只回结构化码，绝不回显 fs 原文/绝对路径（见 consultSourceFailure）。
        const failure = consultSourceFailure(error)
        writeJson(res, failure.status, failure.body)
      }
    }),
  ]
}
