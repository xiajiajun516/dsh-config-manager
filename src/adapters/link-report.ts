/**
 * 文件类分区的「链接目录」报告（issue #37）。
 *
 * 背景：备份静默跳过 junction/符号链接，用户拿到的仍是「成功」，却少了整块内容。
 * 修复分两步：① `utils/recursive-walk.ts` 跟随链接收集内容；② 本模块把「跟随了什么、
 * 跳过了什么、为什么跳过」变成备份报告里可见的告警 —— 缺了 ②，用户依然无从察觉缺失。
 *
 * 纯函数（除 listFilesDetailed 的 IO 委托外），两个 adapter 共用，避免文案再次漂移。
 */
import type { FileSystemFacade } from '../core/types.ts';
import type { MsgFunc } from '../core/messages.ts';
// t6：注册 adapters 域追加目录（本模块只消费注入的 msg，故只引它的注册副作用）。
import './messages.ts';
import type { RecursiveListing, SkippedDepDir, SkippedLink } from '../utils/recursive-walk.ts';

/** 跳过原因 → 消息 key（与 SkippedLink.reason 一一对应，穷尽映射） */
const REASON_KEY: Record<SkippedLink['reason'], string> = {
  loop: 'adapter.linkReason.loop',
  'outside-home': 'adapter.linkReason.outsideHome',
  broken: 'adapter.linkReason.broken',
  unreadable: 'adapter.linkReason.unreadable',
  'too-deep': 'adapter.linkReason.tooDeep',
}

/** 单条原因下最多列出的路径数（其余折叠为计数，避免把报告撑爆） */
const MAX_PATHS_PER_REASON = 5

/**
 * 被跳过的依赖目录 → 详情片段（路径 + 文件数，issue #76）。
 *
 * 文件数是**量级说明**而非完整性判据：计数预算耗尽时如实写「未统计」，绝不猜一个数
 * （把未知写成 0 会被读成「这个目录是空的」）。
 */
function depDirDetail(msg: MsgFunc, dirs: SkippedDepDir[]): string {
  const shown = dirs.slice(0, MAX_PATHS_PER_REASON).map((dir) => {
    const files = dir.files === null
      ? msg('adapter.depsDirFilesUnknown')
      : msg('adapter.depsDirFiles', { count: String(dir.files) })
    return msg('adapter.linkDirEntry', { path: dir.path, files })
  })
  const more = dirs.length - shown.length
  return (more > 0 ? [...shown, `(+ ${more})`] : shown).join(', ')
}

/** 取遍历结果：宿主未实现 listRecursiveDetailed（旧版/测试 mock）时回退，行为与旧版一致。 */
export async function listFilesDetailed(fs: FileSystemFacade, dir: string): Promise<RecursiveListing> {
  if (fs.listRecursiveDetailed !== undefined) return fs.listRecursiveDetailed(dir)
  return { paths: await fs.listRecursive(dir), skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] }
}

/** 把遍历结果转成告警行（无链接时返回空数组 —— 不制造噪音）。 */
export function linkWarnings(msg: MsgFunc, type: string, listing: RecursiveListing): string[] {
  const out: string[] = []
  if (listing.followedLinks > 0) {
    out.push(msg('adapter.linksFollowed', { type, count: String(listing.followedLinks) }))
  }
  if (listing.skippedLinks.length > 0) {
    const byReason = new Map<SkippedLink['reason'], string[]>()
    for (const s of listing.skippedLinks) {
      const arr = byReason.get(s.reason) ?? []
      arr.push(s.path)
      byReason.set(s.reason, arr)
    }
    const detail = [...byReason.entries()].map(([reason, paths]) => {
      const shown = paths.slice(0, MAX_PATHS_PER_REASON).join(', ')
      const more = paths.length > MAX_PATHS_PER_REASON ? ` (+ ${paths.length - MAX_PATHS_PER_REASON})` : ''
      return msg('adapter.linkSkipLine', { reason: msg(REASON_KEY[reason]), count: paths.length, paths: shown, more })
    }).join(msg('adapter.listSeparator'))
    out.push(msg('adapter.linksSkipped', { type, count: String(listing.skippedLinks.length), detail }))
  }
  if (listing.unreadableDirs.length > 0) {
    const shown = listing.unreadableDirs.slice(0, MAX_PATHS_PER_REASON).join(', ')
    const more = listing.unreadableDirs.length > MAX_PATHS_PER_REASON
      ? ` (+ ${listing.unreadableDirs.length - MAX_PATHS_PER_REASON})` : ''
    out.push(msg('adapter.dirsUnreadable', {
      type, count: String(listing.unreadableDirs.length), detail: `${shown}${more}`,
    }))
  }
  // issue #76：运行时依赖目录整棵跳过（内容未进备份）——与链接/不可读目录同等对待：必须可见，绝不静默。
  if (listing.skippedDepDirs.length > 0) {
    out.push(msg('adapter.depsDirsSkipped', {
      type, count: String(listing.skippedDepDirs.length), detail: depDirDetail(msg, listing.skippedDepDirs),
    }))
  }
  return out
}
