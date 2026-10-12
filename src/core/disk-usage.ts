/**
 * 磁盘占用体检（disk-usage）—— 只读扫描 + 与清理同源的「已超保留期」判定。
 *
 * 为什么需要它：本插件的备份产物（exports）、临时暂存（tmp）、市场缓存（market）、
 * 快照安全网（snapshots）与同步工作副本（sync）全在 `$DSH_HOME/dsh-config-manager` 下，
 * 后台有自动清理（cache-cleaner 每日一次 + 备份保留策略），但界面上**没有任何数字**——
 * 用户无法回答「我的备份到底占了多少盘」「哪些是能删的」。本模块只做两件事：
 *   ① 按分区/子区递归统计字节数与文件数（**符号链接不跟随、不展开**，避免重复计数或成环）；
 *   ② 对「可回收」子区按各自保留期算出**已超期**的字节数与条目数（与 host 侧清理逻辑同口径，
 *      保留期由调用方注入 —— 本模块不读配置、不猜默认值）。
 *
 * 硬约束：**只读**。任何子路径缺失/不可读都不抛错，如实降级为该子区 0 字节、并把
 * `unreadable` 置真（界面显示「未统计」而不是 0）；扫描期间出现的竞态删除（readdir/stat
 * 失败）只终止那一支，不影响其余统计。
 *
 * 已补齐两块此前不可见的占用（都**只报告、绝不提供清理**）：
 *  - 回滚点库 `dataDir/rollback-points`：并进 `DISK_USAGE_AREAS`，`policy: 'protected'`；
 *  - 「遗留数据」`LEGACY_DATA_DIRS`（当前一条：旧检查点库 `dataDir/checkpoints`）：
 *    插件**已不再读取**该目录，也**不代删**（删除不可逆，需用户单独授权）。
 * 本模块与清理动作完全解耦：`IMMEDIATE_CLEAN_CATEGORIES` 只有可重建区，
 * `POST /disk-usage/cleanup` 的候选白名单也只有 'tmp' | 'expired-exports'。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'

/**
 * 回滚点库目录名（`dataDir/rollback-points`）。
 *
 * 为什么不直接 import 引擎的 `ROLLBACK_POINTS_DIR_NAME`：本模块是**只读体检**，也是离线
 * 救急台（`dcm web` 的磁盘页）的依赖 —— 不该把整个回滚引擎（crypto / zlib / atomic-write /
 * 会话索引…）拉进它的运行时依赖图；引擎文件一旦有问题，救急台恰恰是最不该跟着挂的那个页面。
 * 「单一事实源」在这里靠**源码级守卫**而不是 import：`disk-usage.test.ts` 直接读
 * `src/core/rollback-point.ts` 的声明并与本常量逐字比对（改了那边、或改了这边，测试即红）
 * —— 与 `tests/packaging-contract.test.ts` 的 V-1（源码级读 `PLUGIN_VERSION`，不 import 宿主入口）
 * 同一种姿势。
 */
const ROLLBACK_POINTS_DIR = 'rollback-points'

/**
 * 只报告、**不提供清理**的子区（当前一条：回滚点库 = `dataDir/rollback-points`）。
 * 它只是「口径清单」：报告/展示一律用完备的 `DISK_USAGE_AREAS`，清理候选另有白名单
 * （`IMMEDIATE_CLEAN_CATEGORIES` / 清理入口 categories），两者不得混用。
 */
export const DISK_USAGE_EXTRA_AREAS = ['rollback-points'] as const

/** 体检子区（顺序即报告/展示顺序：先备份产物，再缓存/暂存，末位为只读保护的附加区） */
export const DISK_USAGE_AREAS = [
  'exports',
  'snapshots',
  'sync',
  'marketCache',
  'marketWork',
  'tmp',
  'logs',
  'bootState',
  'migrationHistory',
  'transactions',
  'locks',
  'vault',
  ...DISK_USAGE_EXTRA_AREAS,
] as const

/** 全部体检子区 id（= `DISK_USAGE_AREAS` 的元素类型） */
export type DiskUsageScanArea = typeof DISK_USAGE_AREAS[number]

/**
 * 体检子区 id（**与 `DiskUsageScanArea` 同一集合**，13 键完备）。
 *
 * 2026-10-13 收口：文案登记（t6）落地后不再分叉 —— 按本类型写 `Record<DiskUsageArea, …>`
 * 时漏掉任一子区（含 rollback-points）都会在编译期报错，而不是静默缺项。
 */
export type DiskUsageArea = DiskUsageScanArea

/** 子区回收策略语义（决定界面文案，不由界面自行判断） */
export type DiskUsagePolicy =
  /** 可随时重建/可重新下载：现在就能整块清掉（tmp、market/cache、market/work） */
  | 'regenerable'
  /** 有自动保留期（导出产物 7 天 / 定时备份保留最近 N 个） */
  | 'retained'
  /** 用户数据/安全网（导入前快照、同步配置与工作副本）——只报告，不提供清理 */
  | 'protected'

/** 单个子区的体检结果 */
export interface DiskUsageAreaReport {
  /** 字节数（目录不可读/不存在 → 0） */
  sizeBytes: number
  /** 文件数（目录不可读/不存在 → 0） */
  fileCount: number
  /** 目录本身读不到（不存在或权限不足）：界面必须说明「未统计」而不是显示 0 字节 */
  unreadable: boolean
  /** 可回收策略 */
  policy: DiskUsagePolicy
  /** 自动回收的保留期（毫秒；仅 retained 语义有值） */
  retentionMs?: number
  /** 已超过保留期、下次自动清理会删掉的字节数（仅 retained） */
  expiredBytes?: number
  /** 已超过保留期的条目数（仅 retained） */
  expiredCount?: number
}

/**
 * 已知的**遗留数据**目录（插件已不再读取、也绝不自动清理）。
 *
 * 为什么单列而不并进 `DISK_USAGE_AREAS`：它们不是「本插件的现役数据区」——不再被任何代码
 * 读取、也不参与清理；报告只用**相对 dataDir 的路径**把它们指认清楚，
 * 且结构必须能容纳未来更多条（数组，不是单条 object）。
 */
export interface LegacyDataDir {
  /** 稳定 id（界面/接口引用） */
  id: string
  /** 相对 dataDir 的 POSIX 风格相对路径（如 `checkpoints`） */
  relPath: string
}

/**
 * 遗留数据目录清单（当前一条：旧检查点库）。
 *
 * `checkpoints/` 是回滚点库改名（`rollback-points/`）之前的旧目录：新代码**不再读取**它，
 * 本插件也**不去删**它（删除是不可逆动作，需用户单独授权）。
 */
export const LEGACY_DATA_DIRS: readonly LegacyDataDir[] = [
  { id: 'legacy-checkpoints', relPath: 'checkpoints' },
]

/** 单条遗留数据的体检结果（只报告；`policy` 恒为 protected） */
export interface DiskUsageLegacyEntry {
  /** 稳定 id（与 `LEGACY_DATA_DIRS` 逐条对应） */
  id: string
  /** 相对 dataDir 的路径（如 `checkpoints`） */
  relPath: string
  /** 绝对路径（界面「在哪儿」展示） */
  path: string
  /** 字节数（不存在/不可读 → 0，必须与 unreadable 一起看） */
  sizeBytes: number
  /** 文件数（不存在/不可读 → 0） */
  fileCount: number
  /** 读不到/不存在/被非目录占住 → true（界面必须显示「未统计」，绝不伪报 0 字节） */
  unreadable: boolean
  /** 恒为 `protected`：只报告，绝不提供自动清理 */
  policy: 'protected'
}

/** 子区明细记录：`DISK_USAGE_AREAS` 的**每个**子区（含回滚点库等附加子区）逐键必填 ——
 *  报告运行时恒为完整结构，索引访问不可能拿到 undefined（`noUncheckedIndexedAccess` 下也成立，
 *  故只读消费者如离线救急台可直接 `report.areas[area]`，不需要缺失回退）。 */
export type DiskUsageAreasReport = Record<DiskUsageScanArea, DiskUsageAreaReport>

/** 体检报告（路径字段供界面「在哪儿」展示；均为本机绝对路径，无敏感内容） */
export interface DiskUsageReport {
  /** dataDir（`$DSH_HOME/dsh-config-manager`） */
  dataDir: string
  /** 全部**子区**合计字节数（含回滚点库等附加子区；**不含**遗留数据 —— 见 legacy） */
  totalBytes: number
  /** 全部子区合计文件数（口径同 totalBytes） */
  totalFiles: number
  /** 可立即清理（regenerable）子区合计字节数 */
  reclaimableBytes: number
  /** 到达自动回收期的字节数（retained 子区） */
  expiredBytes: number
  /** 各子区明细（恒含 `DISK_USAGE_AREAS` 的全部子区，逐键必填） */
  areas: DiskUsageAreasReport
  /**
   * 遗留数据明细（插件**已不再读取**、也**不代删**；只报告）。
   * 结构可容纳多条（见 `LEGACY_DATA_DIRS`）；**不计入 totalBytes**（子区合计与遗留数据
   * 分开列，界面才不会把「能解释来源的占用」和「遗留占用」混成一个数）。
   * 类型上可选只是为了让既有报告字面量（测试/旧调用方）继续成立 —— 宿主
   * `GET /disk-usage` 恒回传本字段（无遗留目录时为空数组）。
   */
  legacy?: readonly DiskUsageLegacyEntry[]
  /** 定时备份产物的保留口径（「保留最近 N 个」；界面用它解释为什么有的备份不会自动回收） */
  backupRetention: {
    keepLast: number
    /** 最新一个备份产物的字节数（无备份 → 0） */
    latestBackupBytes: number
    /** 最新一个备份产物的时间（ISO-8601；无备份 → null） */
    latestBackupAt: string | null
  }
}

/** 子区物理目录（市场缓存/工作副本各占一脚；其余为 dataDir 下的同名目录） */
export interface DiskUsageDirs {
  dataDir: string
  exportsDir: string
  snapshotsDir: string
  syncDir: string
  marketCacheDir: string
  marketWorkDir: string
  tmpDir: string
  logsDir: string
  bootStateDir: string
  migrationHistoryDir: string
  transactionsDir: string
  locksDir: string
  vaultDir: string
}

/** 可立即整块清理的子区（转成磁盘使用分区 id；供清理路由映射回结果） */
export const IMMEDIATE_CLEAN_CATEGORIES = ['tmp', 'marketCache', 'marketWork'] as const
/** 可立即清理的子区 id */
export type ImmediateCleanCategory = typeof IMMEDIATE_CLEAN_CATEGORIES[number]
/** 缓存清理结果里与子区对应的键（老字段快照/临时/市场沿用原语义） */
export type CleanupResultCategory = ImmediateCleanCategory | 'exports'

/** 子区 → 物理目录（单一映射点；展示与统计都不再重复挑目录）。
 *  回滚点库不在 `DiskUsageDirs` 里显式传：它的位置 = `dataDir` + `ROLLBACK_POINTS_DIR`
 *  （与引擎常量逐字一致，有源码级守卫），宿主路由与离线 CLI 两条构造路径因此不可能漂移。 */
export function diskUsageDirOf(dirs: DiskUsageDirs, area: DiskUsageScanArea): string {
  switch (area) {
    case 'exports': return dirs.exportsDir
    case 'snapshots': return dirs.snapshotsDir
    case 'sync': return dirs.syncDir
    case 'marketCache': return dirs.marketCacheDir
    case 'marketWork': return dirs.marketWorkDir
    case 'tmp': return dirs.tmpDir
    case 'logs': return dirs.logsDir
    case 'bootState': return dirs.bootStateDir
    case 'migrationHistory': return dirs.migrationHistoryDir
    case 'transactions': return dirs.transactionsDir
    case 'locks': return dirs.locksDir
    case 'vault': return dirs.vaultDir
    case 'rollback-points': return path.join(dirs.dataDir, ROLLBACK_POINTS_DIR)
  }
}

/** 子区语义与保留期（界面据此选文案；retained 子区必带 retentionMs） */
export interface DiskUsagePolicyInput {
  /** 导出产物保留期（cache-cleaner 的 exportsRetentionMs） */
  exportsRetentionMs: number
  /** 市场缓存/工作副本保留期 */
  marketRetentionMs: number
  /** 临时暂存保留期（只用于报告展示；这些子区可随时手工整块清） */
  tmpRetentionMs: number
  /**
   * 定时备份产物前缀（cache-cleaner 的 exportsExemptPrefix）：
   * 这批文件**不**按天回收，由备份保留策略管理 —— 计入「已超期」必须排除它们，
   * 否则界面会告诉用户可以回收一个其实不会被自动删的文件。
   */
  exportsExemptPrefix?: string
}

/** 一次遍历的聚合结果 */
interface WalkResult {
  sizeBytes: number
  fileCount: number
  /** 扫描期间是否出现读取失败（含根目录不存在） */
  unreadable: boolean
  /** 全部文件里最新的 mtime（无文件 → null） */
  newestMtimeMs: number | null
  /** 已超期的文件字节/条目（retentionMs 省略或 null → 恒 0） */
  expiredBytes: number
  expiredCount: number
}

/**
 * 递归统计一个目录：字节数 / 文件数 / 最新 mtime / 已超期文件。
 *
 * 规则：
 *  - **不跟随符号链接**（lstat 判型、目录链接不展开）——避免 junction 成环与重复计数；
 *  - 缺 `stat` 信息的条目按 0 字节计（但计入文件数，宁可多算条目也不少算文件）；
 *  - 子项 readdir/stat 失败只跳过该子项；根目录失败**或根本不是目录**才标 unreadable
 *    （非目录 = 未统计，不是 0 字节；验收 F4）。
 */
async function walkDirectory(root: string, retentionMs: number | null, nowMs: number): Promise<WalkResult> {
  const result: WalkResult = { sizeBytes: 0, fileCount: 0, unreadable: false, newestMtimeMs: null, expiredBytes: 0, expiredCount: 0 }
  let rootStat: Stats
  try {
    rootStat = await fs.lstat(root)
  } catch {
    // 目录不存在（首次启动前）或读不到 → 未统计，不是「0 字节」
    result.unreadable = true
    return result
  }
  // 路径存在但不是目录（被普通文件/其它东西占住）：这不是「0 字节」，而是**未统计**
  // —— 验收 F4：真不存在的子区显示「未统计（读不到）」，被占住的却显示 0，属自相矛盾的谎报。
  if (!rootStat.isDirectory()) {
    result.unreadable = true
    return result
  }

  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      result.unreadable = true
      continue
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      // 符号链接/junction：只计链接本身（lstat 的 size 是链接长度，可忽略），绝不展开
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(target)
        continue
      }
      let st: Stats
      try {
        st = await fs.lstat(target)
      } catch {
        continue // 竞态删除/不可读：跳过该条目
      }
      if (!st.isFile()) continue
      result.sizeBytes += st.size
      result.fileCount += 1
      if (result.newestMtimeMs === null || st.mtimeMs > result.newestMtimeMs) result.newestMtimeMs = st.mtimeMs
      if (retentionMs !== null && nowMs - st.mtimeMs > retentionMs) {
        result.expiredBytes += st.size
        result.expiredCount += 1
      }
    }
  }
  return result
}

/**
 * 单文件体积（读不到 → 0）。清理模块复用 —— 与 walkDirectory 共用「lstat 判文件」口径，
 * 避免两处各写一份 stat 包装后对「目录同名」等边界给出不同结果。
 */
export async function fileSize(file: string): Promise<number> {
  try {
    const st: Stats = await fs.lstat(file)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/**
 * 导出产物的「已超期」统计：只认 `*.zip` 且**排除豁免前缀**（定时备份），
 * 与 cache-cleaner 的回收口径逐条一致（否则界面会给出用户照做也回收不到的数字）。
 */
async function expiredExports(dir: string, retentionMs: number, exemptPrefix: string | undefined, nowMs: number): Promise<{ bytes: number; count: number }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, count: 0 }
  }
  let bytes = 0
  let count = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
    if (exemptPrefix !== undefined && entry.name.startsWith(exemptPrefix)) continue
    const target = path.join(dir, entry.name)
    try {
      const st = await fs.lstat(target)
      if (nowMs - st.mtimeMs > retentionMs) {
        bytes += st.size
        count += 1
      }
    } catch {
      continue
    }
  }
  return { bytes, count }
}

/** 体检选项 */
export interface DiskUsageScanOptions {
  dirs: DiskUsageDirs
  policy: DiskUsagePolicyInput
  /**
   * 定时备份的「保留最近 N 个」（缺省 10，与 backup-files 的 DEFAULT_BACKUP_RETENTION 同源）。
   * 只用于报告展示，不参与任何删除判定。
   */
  backupKeepLast?: number
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number
}

/**
 * 执行一次只读磁盘体检（幂等、零写入）。
 * 任一子区失败不影响其余统计；返回的报告恒为完整结构（缺失子区记 unreadable）。
 */
export async function scanDiskUsage(options: DiskUsageScanOptions): Promise<DiskUsageReport> {
  const nowMs = (options.now ?? Date.now)()
  const { dirs, policy } = options

  /** 子区 → 保留期与豁免（null = 不参与「已超期」判定） */
  const retention: Record<DiskUsageScanArea, number | null> = {
    exports: policy.exportsRetentionMs,
    snapshots: null,
    sync: null,
    marketCache: policy.marketRetentionMs,
    marketWork: policy.marketRetentionMs,
    tmp: policy.tmpRetentionMs,
    logs: null,
    bootState: null,
    migrationHistory: null,
    transactions: null,
    locks: null,
    vault: null,
    // 回滚点库没有「保留期」：只报告，绝不自动清理（工作区 + 会话两态的恢复入口）
    'rollback-points': null,
  }
  const policyOf: Record<DiskUsageScanArea, DiskUsagePolicy> = {
    exports: 'retained',
    snapshots: 'protected',
    sync: 'protected',
    marketCache: 'regenerable',
    marketWork: 'regenerable',
    tmp: 'regenerable',
    logs: 'protected',
    bootState: 'protected',
    migrationHistory: 'protected',
    transactions: 'protected',
    locks: 'protected',
    vault: 'protected',
    // 与 snapshots/sync 同语义：用户数据/恢复入口 —— 只报告，绝不提供清理
    'rollback-points': 'protected',
  }
  const areas = {} as DiskUsageAreasReport
  let totalBytes = 0
  let totalFiles = 0
  let reclaimableBytes = 0
  let expiredBytes = 0

  for (const area of DISK_USAGE_AREAS) {
    const dir = diskUsageDirOf(dirs, area)
    const walk = await walkDirectory(dir, retention[area], nowMs)
    const entry: DiskUsageAreaReport = {
      sizeBytes: walk.sizeBytes,
      fileCount: walk.fileCount,
      unreadable: walk.unreadable,
      policy: policyOf[area],
    }
    const retained = retention[area]
    if (retained !== null) {
      entry.retentionMs = retained
      if (area === 'exports') {
        const ex = await expiredExports(dir, retained, policy.exportsExemptPrefix, nowMs)
        entry.expiredBytes = ex.bytes
        entry.expiredCount = ex.count
      } else {
        entry.expiredBytes = walk.expiredBytes
        entry.expiredCount = walk.expiredCount
      }
    }
    areas[area] = entry
    totalBytes += walk.sizeBytes
    totalFiles += walk.fileCount
    expiredBytes += entry.expiredBytes ?? 0
    if (entry.policy === 'regenerable') reclaimableBytes += walk.sizeBytes
  }

  /**
   * 遗留数据：与子区**同一套**遍历口径（只读、不跟随符号链接、读不到即 unreadable），
   * 但**不计入 totalBytes**（与 areas 分列），且 policy 恒为 protected —— 本模块不提供
   * 任何删除动作，也不把它们的路径交给清理入口。
   */
  const legacy: DiskUsageLegacyEntry[] = []
  for (const item of LEGACY_DATA_DIRS) {
    const dir = path.join(dirs.dataDir, item.relPath)
    const walk = await walkDirectory(dir, null, nowMs)
    legacy.push({
      id: item.id,
      relPath: item.relPath,
      path: dir,
      sizeBytes: walk.sizeBytes,
      fileCount: walk.fileCount,
      unreadable: walk.unreadable,
      policy: 'protected',
    })
  }

  return {
    dataDir: dirs.dataDir,
    totalBytes,
    totalFiles,
    reclaimableBytes,
    expiredBytes,
    areas,
    legacy,
    backupRetention: { keepLast: options.backupKeepLast ?? 10, latestBackupBytes: 0, latestBackupAt: null },
  }
}
