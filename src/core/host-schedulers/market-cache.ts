/**
 * 市场缓存目录布局与暂存 zip 懒 GC（tech-debt #23 下沉）。
 *
 * 这些逻辑原本长在 src/index.ts 的 makeRoutes() 里，只有「装上宿主 + 真的拉过一次市场」
 * 才能验证；抽出来之后目录哈希、条目完整性判定、保留期回收都是可单测的纯行为。
 *
 * 边界：src/core/host-schedulers/* 只能 import 'node:' 与同目录（core 层是 allow 白名单、
 * 按**原始 spec 前缀**判定，'../../utils/hash.ts' 不在白名单里）——
 * 所以 sha256 在这里用 node:crypto 本地算，别去 import utils。
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 暂存 zip 的保留期：market/download 每次暂存新 zip 前做懒 GC，
 * 保留这段时间内的（供刚下载后立即执行的 /execute 消费），更旧的清掉。
 */
export const MARKET_TMP_RETENTION_MS = 10 * 60 * 1000

export interface MarketCacheLayout {
  /** <marketDir>/cache */
  cacheRoot: string
  /** <marketDir>/work */
  workRoot: string
  /** 缓存的 index.json（结构校验由调用方做，这里只给路径） */
  cacheIndex(url: string): string
  /** 条目缓存目录（manifest.json + config.zip） */
  itemDir(url: string): string
  /** 该仓库的只读 git 工作副本目录（--depth 1，无凭据） */
  workDir(url: string): string
}

/** 仓库 URL → 32 hex 稳定哈希（只作目录名，不作安全边界）。 */
function urlHash(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32)
}

export function createMarketCacheLayout(marketDir: string): MarketCacheLayout {
  const cacheRoot = join(marketDir, 'cache')
  const workRoot = join(marketDir, 'work')
  return {
    cacheRoot,
    workRoot,
    cacheIndex: (url: string) => join(cacheRoot, urlHash(url), 'index.json'),
    itemDir: (url: string) => join(cacheRoot, urlHash(url), 'items'),
    workDir: (url: string) => join(workRoot, urlHash(url)),
  }
}

/** 读缓存的 index.json 原始文本（不存在/读不出 → null；解析与结构校验归调用方）。 */
export async function readMarketCacheIndexText(layout: MarketCacheLayout, url: string): Promise<string | null> {
  try {
    return await readFile(layout.cacheIndex(url), 'utf8')
  } catch {
    return null
  }
}

/** 条目是否已有完整缓存（manifest.json + config.zip 都在才算）。 */
export async function marketItemCached(layout: MarketCacheLayout, url: string, itemId: string): Promise<boolean> {
  try {
    await access(join(layout.itemDir(url), itemId, 'config.zip'))
    await access(join(layout.itemDir(url), itemId, 'manifest.json'))
    return true
  } catch {
    return false
  }
}

/** 写条目缓存（manifest + config.zip）供离线重复查看。内容始终视为不可信。 */
export async function writeMarketItemCache(
  layout: MarketCacheLayout,
  url: string,
  itemId: string,
  manifestRaw: string,
  zipBytes: Uint8Array,
): Promise<void> {
  const dir = join(layout.itemDir(url), itemId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), manifestRaw, 'utf8')
  await writeFile(join(dir, 'config.zip'), zipBytes)
}

/**
 * 清理滞留在 tmpDir 的过期市场暂存 zip（market-*.zip 与发布向导的 publish-*.zip）。
 * 一次性尽力而为：任何读取/删除失败都只跳过，不影响主流程。
 * 返回被删掉的文件名（便于单测与诊断；生产调用方可忽略）。
 */
export async function pruneStagedMarketZips(
  tmpDir: string,
  retentionMs: number = MARKET_TMP_RETENTION_MS,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = []
  let names: string[]
  try {
    names = await readdir(tmpDir)
  } catch {
    return removed // tmpDir 读不出 → 跳过
  }
  for (const name of names) {
    if ((!name.startsWith('market-') && !name.startsWith('publish-')) || !name.endsWith('.zip')) continue
    const p = join(tmpDir, name)
    try {
      const st = await stat(p)
      if (now - st.mtimeMs <= retentionMs) continue
      await rm(p, { force: true, recursive: true })
      removed.push(name)
    } catch {
      // 单文件 stat/删除失败 → 跳过（尽力而为）
    }
  }
  return removed
}
