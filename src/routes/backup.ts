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
import type { RetentionPolicy } from '../sync/retention-policy.ts'
import { AUTO_BACKUP_PREFIX } from '../sync/backup-files.ts'
import {
  MARKET_RETENTION_DEFAULT_MS,
  TMP_RETENTION_DEFAULT_MS,
  EXPORTS_RETENTION_DEFAULT_MS,
  cleanupCaches,
} from '../core/cache-cleaner.ts'
import type { CacheCleanupSection } from '../core/cache-cleaner.ts'
import { scanDiskUsage } from '../core/disk-usage.ts'
import type { DiskUsageArea, DiskUsageDirs, DiskUsagePolicyInput, DiskUsageReport } from '../core/disk-usage.ts'
import type { DiskUsageCleanCategory } from '../ui/types.ts'
import { validateBackupScheduleDraft } from '../ui/backup-schedule.ts'
import { join as joinPath } from 'node:path'


/**
 * 磁盘体检子区 → 物理目录（`$DSH_HOME/dsh-config-manager` 下的固定布局，单一映射点）。
 *
 * 注意这里**没有** `rollback-points`：回滚点库与遗留 `checkpoints/` 的位置由 core 按
 * `dataDir + ROLLBACK_POINTS_DIR`（与引擎常量逐字一致，有源码级守卫）与 `LEGACY_DATA_DIRS`
 * 推导（见 `src/core/disk-usage.ts` 的 `diskUsageDirOf`）——宿主路由与离线 CLI 因此不可能
 * 各写一份目录名而漂移。
 */
function diskUsageDirsOf(env: RoutesEnv): DiskUsageDirs {
  const { dataDir, syncDir, marketDir, tmpDir, snapshotsDir, exportsDir } = env
  return {
    dataDir,
    exportsDir,
    snapshotsDir,
    // 同步历史/快照/工作副本都在 <dataDir>/sync 下（Git 通道另有 .git 工作副本，一并计入）
    syncDir: syncDir ?? joinPath(dataDir, 'sync'),
    marketCacheDir: joinPath(marketDir, 'cache'),
    marketWorkDir: joinPath(marketDir, 'work'),
    tmpDir,
    logsDir: joinPath(dataDir, 'logs'),
    bootStateDir: joinPath(dataDir, 'boot-state'),
    migrationHistoryDir: joinPath(dataDir, 'migration-history'),
    transactionsDir: joinPath(dataDir, 'transactions'),
    locksDir: joinPath(dataDir, 'locks'),
    vaultDir: joinPath(dataDir, 'vault'),
  }
}

/** 体检/清理共用的保留期口径（与 cache-cleaner 缺省逐字一致；定时备份前缀豁免同源） */
async function diskUsagePolicyOf(env: RoutesEnv): Promise<{ policy: DiskUsagePolicyInput; retention: RetentionPolicy }> {
  const schedule = await readBackupSchedule(env.syncDir)
  return {
    policy: {
      tmpRetentionMs: TMP_RETENTION_DEFAULT_MS,
      exportsRetentionMs: EXPORTS_RETENTION_DEFAULT_MS,
      marketRetentionMs: MARKET_RETENTION_DEFAULT_MS,
      // 定时备份产物不按天回收（保留策略归 BackupScheduler）——「已超期」统计必须排除它们
      exportsExemptPrefix: AUTO_BACKUP_PREFIX,
    },
    retention: schedule.retention ?? DEFAULT_RETENTION_POLICY,
  }
}

/** 体检报告（GET /disk-usage 与清理后的刷新共用同一份组装） */
async function diskUsageReportOf(env: RoutesEnv): Promise<DiskUsageReport> {
  const dirs = diskUsageDirsOf(env)
  const { policy, retention } = await diskUsagePolicyOf(env)
  const usage = await scanDiskUsage({ dirs, policy })
  // 定时备份产物的「保留最近 N 个」口径如实回传：界面要解释「为什么有的备份不会被自动回收」
  const backups = await listBackupFiles(env.exportsDir)
  const latest = backups[0]
  return {
    ...usage,
    backupRetention: {
      keepLast: retention.keepLast,
      latestBackupBytes: latest?.sizeBytes ?? 0,
      latestBackupAt: latest === undefined ? null : new Date(latest.mtimeMs).toISOString(),
    },
  }
}

/**
 * 执行一次**手动**清理。缺省只清「可重建的缓存与暂存」（tmp + 市场缓存/工作副本）
 * —— 它们随时可重建，清掉不影响任何用户数据；`categories` 可选加入 `expired-exports`
 * （只删**已超过保留期**的导出产物）。snapshots 与 sync **永不在候选集内**（用户数据/安全网）。
 */
async function runDiskUsageCleanup(env: RoutesEnv, categories: readonly DiskUsageCleanCategory[]): Promise<Record<string, unknown>> {
  const dirs = diskUsageDirsOf(env)
  const { policy } = await diskUsagePolicyOf(env)
  const before = await scanDiskUsage({ dirs, policy })
  const wantsTmpMarket = categories.includes('tmp')
  const wantsExpiredExports = categories.includes('expired-exports')

  // 分区白名单 = 用户这次**显式**勾选的动作：没勾 exports 就一个导出文件都不碰
  //（即使有过期项 —— 否则界面写着「只清缓存」却删掉用户的备份）
  const sections: CacheCleanupSection[] = wantsTmpMarket ? ['tmp', 'marketCache', 'marketWork'] : []
  if (wantsExpiredExports) sections.push('exports')
  const result = await cleanupCaches({
    tmpDir: dirs.tmpDir,
    exportsDir: dirs.exportsDir,
    exportsExemptPrefix: policy.exportsExemptPrefix,
    marketCacheRoot: dirs.marketCacheDir,
    marketWorkRoot: dirs.marketWorkDir,
    // 立即清理只作用于可重建区；exports 仍按保留期（cleanupCaches 内部即如此实现）
    includeRecent: wantsTmpMarket,
    sections,
    tmpRetentionMs: policy.tmpRetentionMs,
    exportsRetentionMs: policy.exportsRetentionMs,
    marketRetentionMs: policy.marketRetentionMs,
  })

  const sectionToArea: Record<string, DiskUsageArea> = {
    tmp: 'tmp',
    marketCache: 'marketCache',
    marketWork: 'marketWork',
    exports: 'exports',
  }
  // 分区级释放量 = 清理前后该子区体积之差（比 result 的计数更贴用户看到的数字）；
  // 目录删空时 freedBytes（旧语义）恒为 0，所以界面/回执一律用这个差值。
  const after = await scanDiskUsage({ dirs, policy })
  const freedByArea: Partial<Record<DiskUsageArea, number>> = {}
  for (const section of result.sections) {
    const area = sectionToArea[section]
    if (area === undefined) continue
    const delta = (before.areas[area]?.sizeBytes ?? 0) - (after.areas[area]?.sizeBytes ?? 0)
    freedByArea[area] = delta > 0 ? delta : 0
  }

  const report = await diskUsageReportOf(env)
  return {
    ok: true,
    requested: categories,
    excluded: wantsExpiredExports ? [] : ['expired-exports'],
    removed: result.removed,
    freedBytes: result.freedBytesRecursive,
    freedByArea,
    errors: result.errors,
    detail: result.detail,
    report,
  }
}

export function backupRoutes(env: RoutesEnv): WebRoute[] {
  const {
    backupScheduler,
    exportsDir,
    syncDir,
    withMutationGate,
  } = env
  return [
    // ------------------------------------------------------- disk-usage（只读体检）
    // 界面「磁盘占用」卡的数据源：按子区回传字节数/文件数 + 各保留期的「已到期」量。
    // 零写入、零敏感（只有本机目录布局与体积）；子区读不到时如实标 unreadable（绝不显示 0 诱导）。
    //
    // 响应恒含两块**此前不可见**的占用（都是 protected，只报告、绝不进清理候选）：
    //  ① report.areas['rollback-points']   回滚点库（dataDir/rollback-points，工作区+会话两态的恢复入口）；
    //  ② report.legacy[]                   遗留数据（结构可容纳多条；当前一条 legacy-checkpoints =
    //                                      旧 checkpoints/ 目录，插件已不再读取、也不代删）。
    // 已超期/可回收字段只对 retained / regenerable 子区有值，这两块恒为空/undefined。
    endpoint({ path: '/api/dsh-config-manager/disk-usage', methods: ['GET'] }, async (_req, res) => {
      try {
        writeJson(res, 200, { ok: true, report: await diskUsageReportOf(env) })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------- disk-usage/cleanup（手动清理）
    // 缺省只清可重建的缓存/暂存（tmp + 市场缓存 + 市场工作副本，忽略保留期整块清）；
    // categories 可加入 'expired-exports'（只删已超保留期的导出产物，豁免定时备份）。
    // **snapshots / sync 永不在候选集内**（用户数据与安全网）；**回滚点库
    // （report.areas['rollback-points']）与遗留数据（report.legacy[]）同样永不进候选** ——
    // 上面的 categories 白名单就是逐条判据（源级守卫见 src/core/disk-usage.test.ts）。
    // 走 mutation gate：同一时刻只允许一个写操作。
    endpoint({ path: '/api/dsh-config-manager/disk-usage/cleanup', methods: ['POST'] }, withMutationGate('disk-usage-cleanup', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['categories']
          : undefined
        const categories: Array<'tmp' | 'expired-exports'> = []
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (item === 'tmp' || item === 'expired-exports') categories.push(item)
          }
        }
        if (categories.length === 0) {
          writeJson(res, 400, { error: "categories must be a non-empty array of 'tmp' | 'expired-exports'" })
          return
        }
        writeJson(res, 200, await runDiskUsageCleanup(env, categories))
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })),
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
        // 备份文件列表要驱动「导入」的解锁判定（issue #55）→ 逐文件探测容器形态；
        // 其它调用方（磁盘体检 / 保留策略）保持不探测的快速路径。
        writeJson(res, 200, { ok: true, files: await listBackupFiles(exportsDir, { withContainerKind: true }) })
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
