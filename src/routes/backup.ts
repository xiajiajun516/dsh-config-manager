/**
 * 路由组：定时全量备份与导出产物管理（backup-schedule / run / backup-files / delete）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { deleteBackupFile, isValidBackupFileName, listBackupFiles } from '../sync/backup-files.ts'
import { readBackupSchedule, writeBackupSchedule } from '../sync/backup-schedule-config.ts'
import type { BackupScheduleConfig } from '../sync/backup-schedule-config.ts'
import { DEFAULT_RETENTION_POLICY } from '../sync/retention-policy.ts'
import { validateBackupScheduleDraft } from '../ui/backup-schedule.ts'

export function backupRoutes(env: RoutesEnv): WebRoute[] {
  const {
    backupScheduler,
    exportsDir,
    syncDir,
    withMutationGate,
  } = env
  return [
    // 定时全量备份设置（GET 读 / PUT 存 sync/backup-schedule.json；无敏感字段）：
    // 保存后重排调度器（reload）；恒不含 secret、不加密（与自动同步同语义）。
    // 与全仓一致：每个方法分支都过 loopback fence（guard）——其他 /api/dsh-config-manager/*
    // 路由全部首行 guard，新增路由不得遗漏（安全不变量：仅 loopback + 同源可访问）。
    endpoint({ path: '/api/dsh-config-manager/backup-schedule', methods: ['GET', 'PUT'] }, async (req, res) => {
      if (req.method === 'GET') {
        try {
          writeJson(res, 200, { schedule: await readBackupSchedule(syncDir) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (req.method === 'PUT') {
        try {
          const body = await readJsonBody(req)
          const parsed = validateBackupScheduleDraft(body)
          if (!parsed.ok) {
            writeJson(res, 400, { error: parsed.error })
            return
          }
          const current = await readBackupSchedule(syncDir)
          const next: BackupScheduleConfig = { ...current, ...parsed.value }
          // m-retention：保留策略保存（草稿给了就用草稿值，否则保留既有；缺省由读取层补齐）
          next.retention = parsed.value.retention ?? current.retention ?? { ...DEFAULT_RETENTION_POLICY }
          await writeBackupSchedule(syncDir, next)
          await backupScheduler.reload()
          writeJson(res, 200, { ok: true, schedule: next })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      writeJson(res, 405, { error: `method ${req.method} not allowed` })
    }),
    // ------------------------------------------------- backup-schedule/run
    // 立即执行一次全量备份（复用 BackupScheduler.runOnce，同一时刻防重）：
    // 返回执行结果（status/zip/skipReason/error）+ 最新配置（含 lastRun 状态）。
    // issue #43：这是**用户手动**触发（概览「立即备份」/ 快照空态 CTA），故 manual: true 绕过
    // 自动调度开关 enabled —— 缺省 enabled:false 时旧行为是按钮静默空转；自动/启动路径不受影响。
    // 同全仓：loopback fence（guard）——远程调用方不得触发宿主写盘操作。
    endpoint({ path: '/api/dsh-config-manager/backup-schedule/run', methods: ['POST'] }, async (req, res) => {
      try {
        const run = await backupScheduler.runOnce({ manual: true })
        const schedule = await readBackupSchedule(syncDir)
        writeJson(res, 200, { ok: true, run, schedule })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ backup-files
    // 导出产物管理（m-backup-files）：列出 exports/*.zip（名称/大小/时间/来源，
    // 时间倒序）+ 删除单个备份文件。下载复用 /download（roots 已含 exportsDir）。
    // 安全：删除只接受文件名（服务端 basename 校验防路径穿越）；恒 loopback guard。
    endpoint({ path: '/api/dsh-config-manager/backup-files', methods: ['GET'] }, async (req, res) => {
      try {
        writeJson(res, 200, { ok: true, files: await listBackupFiles(exportsDir) })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    endpoint({ path: '/api/dsh-config-manager/backup-files/delete', methods: ['POST'] }, withMutationGate('backup-file-delete', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const name = typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['name']
          : undefined
        if (!isValidBackupFileName(name)) {
          writeJson(res, 400, { error: 'name must be a .zip file name (no path separators)' })
          return
        }
        const removed = await deleteBackupFile(exportsDir, name)
        writeJson(res, 200, { ok: true, removed })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })),
  ]
}
