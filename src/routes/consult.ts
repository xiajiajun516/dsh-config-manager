/**
 * 路由组：迁移前咨询（只读健康评分 + 建议）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { buildLocalSnapshotSource, readExportZipSource } from '../core/consult-source.ts'
import { FileSnapshotStore, verifySnapshot } from '../core/index.ts'
import { computeConsultReport } from '../core/migration-consult.ts'
import type { ConsultSourceData, ConsultSourceRef, MigratabilityResult } from '../core/migration-consult.ts'
import { isValidSnapshotId, planRestore } from '../core/restore.ts'
import type { SectionId } from '../schema/types.ts'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function consultRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    makeImporter,
    makeSyncEngine,
    prepareSync,
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
            return { ok: false, itemCount: 0, fatalConflicts: 0, warnings: 0, sections: [], errors: [err instanceof Error ? err.message : String(err)] }
          }
        }

        let data: ConsultSourceData
        if (type === 'export-zip') {
          data = await readExportZipSource(ref, id, { computeMigratability })
        } else if (type === 'remote-snapshot') {
          // 用持久化 sync 配置构建引擎，下载快照 → 临时 ZIP → 读取（try/finally 清理）
          const syncCfg = await prepareSync({})
          const engine = makeSyncEngine(syncCfg)
          const preview = await engine.preview({ snapshotId: ref.snapshotId ?? id })
          if (!preview.ok || preview.zipPath === '') {
            writeJson(res, 400, { error: preview.message ?? '远端快照不可用' })
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
            })
            restorePlan = {
              itemCount: plan.actions.length,
              conflicts: plan.actions.filter((a) => a.kind === 'skip').length,
              warnings: plan.actions.filter((a) => a.kind === 'skip').length,
              sections: [...snapshotSections.keys()],
              errors: [],
            }
          } catch (err) {
            restorePlan.errors = [err instanceof Error ? err.message : String(err)]
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
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
