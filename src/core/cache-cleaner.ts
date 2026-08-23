/**
 * 缓存自动清理（cache-cleaner）
 *
 * 只清理「可重建 / 一次性」的缓存与临时文件，绝不触碰用户数据与安全网：
 *   - tmpDir 下过期的 `.zip`（upload-* / market-* / publish-* / decrypted-* /
 *     export-plain-* 等导入/导出/市场暂存，以及 SyncEngine 遗留的临时目录
 *     dsh-sync-pull-*）——保留期内文件不删（供「刷新恢复导入」等跨请求流程继续消费）；
 *   - exportsDir 下过期的导出产物 `.zip`（导出时用户已通过浏览器下载/另存到本地，
 *     host 端只是暂存副本，按保留期回收）；
 *   - market/cache/<url-hash>/（市场 index 缓存与条目缓存，refresh/download 可重建）；
 *   - market/work/<url-hash>/（市场 git 只读工作副本，readIndex 时自动重新 clone）。
 *
 * 保留不动（属用户数据/安全网，由各自 UI 或业务逻辑管理）：
 *   - snapshots/（导入前强制快照）、sync/（同步配置/历史/git 工作副本）。
 *
 * 实现：与 DSH 运行时解耦的纯函数（node:fs/promises），保留期与时间源参数化，
 * 任何单项失败均不阻断其余清理（尽力而为），返回清理报告供宿主日志。
 * 健康性：删除前按 mtime 判定超期（now - mtime > retention），stat 失败保守不删。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 临时文件缺省保留期：24 小时（覆盖跨会话「刷新恢复导入」窗口，昨天的残留自动清） */
export const TMP_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000

/** 导出产物缺省保留期：7 天（导出时用户已通过浏览器下载/另存到本地，host 端副本按周回收） */
export const EXPORTS_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/** 市场缓存/工作副本缺省保留期：7 天（重建成本 = 一次网络拉取） */
export const MARKET_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/** SyncEngine 在 zipDir（即 tmpDir）下 mkdtemp 的目录前缀（用完即删，崩溃残留由清理兜底） */
const SYNC_TMP_DIR_PREFIX = 'dsh-sync-pull-'

export interface CacheCleanupOptions {
  /** 临时目录（$DSH_HOME/dsh-config-manager/tmp） */
  tmpDir: string
  /** 导出产物目录（$DSH_HOME/dsh-config-manager/exports） */
  exportsDir: string
  /** 市场缓存根（$DSH_HOME/dsh-config-manager/market/cache） */
  marketCacheRoot: string
  /** 市场工作副本根（$DSH_HOME/dsh-config-manager/market/work） */
  marketWorkRoot: string
  /** 临时文件保留期（缺省 24h） */
  tmpRetentionMs?: number
  /** 导出产物保留期（缺省 7 天） */
  exportsRetentionMs?: number
  /**
   * exports 清理豁免的文件名前缀（如定时备份的 dsh-config-auto-）：
   * 匹配该前缀的 ZIP 不按保留期回收 —— 其生命周期由业务保留策略管理
   * （BackupScheduler.pruneAutoBackups「保留最近 N 个」）。缺省不豁免。
   */
  exportsExemptPrefix?: string
  /** 市场缓存/工作副本保留期（缺省 7 天） */
  marketRetentionMs?: number
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number
}

export interface CacheCleanupResult {
  /** 删除条目数（文件 + 目录） */
  removed: number
  /** 释放字节数（仅被删文件的 size 累计；目录删除统计为 0） */
  freedBytes: number
  /** 单项失败数（不影响主流程） */
  errors: number
  /** 每条删除记录（相对 dataDir 的描述 + 字节数），供日志/审计 */
  detail: string[]
}

/** 目录是否超期（stat 失败保守视为未超期 → 不删） */
async function isExpired(target: string, retentionMs: number, nowMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(target)
    return nowMs - st.mtimeMs > retentionMs
  } catch {
    return false
  }
}

/** 删除一个文件/目录并计入报告；目录的 freedBytes 统计为 0（递归统计不划算，用途仅是日志） */
async function removeEntry(target: string, label: string, result: CacheCleanupResult): Promise<void> {
  try {
    let size = 0
    try {
      const st = await fs.stat(target)
      size = st.isFile() ? st.size : 0
    } catch {
      /* stat 失败仍尝试删除（rm 自己会兜底不存在） */
    }
    await fs.rm(target, { recursive: true, force: true })
    result.removed += 1
    result.freedBytes += size
    result.detail.push(`${label} (${size} bytes)`)
  } catch {
    result.errors += 1
  }
}

/**
 * 执行一次缓存清理（幂等；可重复调用）。
 * 只清理超期（超过保留期）的缓存/临时条目，其余一律保留。
 */
export async function cleanupCaches(opts: CacheCleanupOptions): Promise<CacheCleanupResult> {
  const nowMs = (opts.now ?? Date.now)()
  const tmpRetentionMs = opts.tmpRetentionMs ?? TMP_RETENTION_DEFAULT_MS
  const exportsRetentionMs = opts.exportsRetentionMs ?? EXPORTS_RETENTION_DEFAULT_MS
  const marketRetentionMs = opts.marketRetentionMs ?? MARKET_RETENTION_DEFAULT_MS
  const result: CacheCleanupResult = { removed: 0, freedBytes: 0, errors: 0, detail: [] }

  // 1) tmpDir：过期 .zip（导入/导出/市场/解密暂存）与 SyncEngine 遗留的 dsh-sync-pull-* 目录
  try {
    const entries = await fs.readdir(opts.tmpDir, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(opts.tmpDir, entry.name)
      const isTmpish =
        (entry.isFile() && entry.name.endsWith('.zip')) ||
        (entry.isDirectory() && entry.name.startsWith(SYNC_TMP_DIR_PREFIX))
      if (!isTmpish) continue
      if (await isExpired(target, tmpRetentionMs, nowMs)) {
        await removeEntry(target, `tmp/${entry.name}`, result)
      }
    }
  } catch {
    // tmpDir 不存在/不可读 → 跳过（尽力而为）
    result.errors += 1
  }

  // 2) exportsDir：过期的导出产物 .zip（导出时已下载/另存到本地，host 端副本按保留期回收）。
  //    豁免前缀（定时备份产物）跳过 —— 由备份保留策略管理，不按天回收。
  const exemptPrefix = opts.exportsExemptPrefix
  try {
    const entries = await fs.readdir(opts.exportsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
      if (exemptPrefix !== undefined && entry.name.startsWith(exemptPrefix)) continue
      const target = path.join(opts.exportsDir, entry.name)
      if (await isExpired(target, exportsRetentionMs, nowMs)) {
        await removeEntry(target, `exports/${entry.name}`, result)
      }
    }
  } catch {
    // exportsDir 不存在/不可读 → 跳过
    result.errors += 1
  }

  // 3) market/cache：过期 index.json 与 items/<itemId> 条目缓存；删空后回收 hash 目录
  try {
    const hashes = await fs.readdir(opts.marketCacheRoot)
    for (const hash of hashes) {
      const hashDir = path.join(opts.marketCacheRoot, hash)
      let st
      try {
        st = await fs.stat(hashDir)
      } catch {
        continue // 竞态删除/不可读 → 跳过该 hash
      }
      if (!st.isDirectory()) continue

      const indexFile = path.join(hashDir, 'index.json')
      if (await isExpired(indexFile, marketRetentionMs, nowMs)) {
        await removeEntry(indexFile, `market/cache/${hash}/index.json`, result)
      }

      const itemsDir = path.join(hashDir, 'items')
      const itemDirs = await fs.readdir(itemsDir).catch(() => [] as string[])
      for (const itemId of itemDirs) {
        const itemDir = path.join(itemsDir, itemId)
        if (await isExpired(itemDir, marketRetentionMs, nowMs)) {
          await removeEntry(itemDir, `market/cache/${hash}/items/${itemId}`, result)
        }
      }
      // items 子目录删空后回收；hash 目录删空后回收
      const itemsLeft = await fs.readdir(itemsDir).catch(() => [] as string[])
      if (itemsLeft.length === 0) {
        await removeEntry(itemsDir, `market/cache/${hash}/items`, result)
      }
      const remaining = await fs.readdir(hashDir).catch(() => [] as string[])
      if (remaining.length === 0) {
        await removeEntry(hashDir, `market/cache/${hash}`, result)
      }
    }
  } catch {
    // marketCacheRoot 不存在/不可读 → 跳过
    result.errors += 1
  }

  // 3) market/work：过期 git 只读工作副本（readIndex 时会按需重新 clone）
  try {
    const hashes = await fs.readdir(opts.marketWorkRoot)
    for (const hash of hashes) {
      const workDir = path.join(opts.marketWorkRoot, hash)
      const st = await fs.stat(workDir).catch(() => null)
      if (st === null || !st.isDirectory()) continue
      if (await isExpired(workDir, marketRetentionMs, nowMs)) {
        await removeEntry(workDir, `market/work/${hash}`, result)
      }
    }
  } catch {
    // marketWorkRoot 不存在/不可读 → 跳过
    result.errors += 1
  }

  return result
}