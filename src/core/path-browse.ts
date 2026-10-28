/**
 * 本机目录列举（宿主半）—— 「路径映射 → 选择本机路径」弹窗的唯一数据源。
 *
 * 为什么要有它
 * ------------
 * 导入向导的路径映射要求用户为一堆**绝对路径**指定本机新位置，而此前只能凭记忆手打
 * （浏览器拿不到真实路径：File System Access API 只给 handle，`<input type="file">` 只给文件名）。
 * 于是「路径选不对 = 导不进」全落在用户的打字准确性上。这里把「列目录」做成宿主能力，
 * 浏览器只负责画界面。
 *
 * 边界
 * ----
 * - **只读**：只 readdir/stat，绝不创建、改写、删除任何东西；
 * - **不产出文案**：`error` 是枚举码（not-found / denied / failed / not-absolute），
 *   用户可见句子由客户端按字典解析（i18n 硬规则：引擎不写中文）；
 * - 有界：单次列举最多 {@link BROWSE_ENTRY_LIMIT} 条并回报 `truncated`，盘符探测逐根带硬超时
 *   （离线光驱/断开的网络盘 stat 会挂住，路由不许被一个 panic 盘符拖死）。
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { homedir } from 'node:os'

/** 单次列举上限：够翻一个源码目录，又不至于把响应体撑成几 MB。 */
export const BROWSE_ENTRY_LIMIT = 500

/** 盘符/根探测的单项硬超时（ms）：断开的网络盘 stat 会长时间不返回。 */
export const ROOT_PROBE_TIMEOUT_MS = 400

/** 列举失败的原因码（客户端按它选字典键）。 */
export type BrowseErrorCode = 'not-found' | 'denied' | 'failed' | 'not-absolute'

/** 一条条目：目录（可进入）或文件（可选中）。 */
export interface BrowseEntry {
  /** 末段名字（驱动器根即盘符本身，如 `D:\\`）。 */
  name: string
  /** 绝对路径（客户端原样回填输入框）。 */
  path: string
  kind: 'dir' | 'file'
}

/** 列举结果。 */
export interface BrowseResult {
  /** 当前列出的目录；空串 = 「此电脑」（Windows 的盘符根列表）。 */
  path: string
  /** 上一级；已是根时为 null。 */
  parent: string | null
  /** 用户主目录（界面上的快捷入口；不随 path 变化）。 */
  home: string
  entries: BrowseEntry[]
  /** 命中 {@link BROWSE_ENTRY_LIMIT} 被截断。 */
  truncated: boolean
  /** 失败原因码；成功为 null。 */
  error: BrowseErrorCode | null
}

/** 带硬超时的 Promise（只为本模块的盘符探测服务；超时后原 promise 的迟到结果被丢弃）。 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timeout')) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** 一个路径是不是「根」（Windows 盘符根 / POSIX 的 `/`）。 */
function isRoot(target: string): boolean {
  return parse(target).root === target
}

/**
 * 本机根列表：Windows 上是**探测得到的**盘符根（不硬编码 C:），其余平台是 `/`。
 * 探测逐根 400ms 超时；全部失败时至少给出 `parse(process.cwd()).root`，界面不至于空成白板。
 */
export async function listRoots(): Promise<BrowseEntry[]> {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', kind: 'dir' }]
  }
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('')
  const probed = await Promise.all(letters.map(async (letter) => {
    const root = `${letter}:\\`
    try {
      const info = await withDeadline(stat(root), ROOT_PROBE_TIMEOUT_MS)
      return info.isDirectory() ? root : null
    } catch {
      return null
    }
  }))
  const roots = probed.filter((root): root is string => root !== null)
  const fallback = parse(process.cwd()).root
  const ordered = roots.length > 0 ? roots : (fallback === '' ? [] : [fallback])
  return ordered.map((root) => ({ name: root, path: root, kind: 'dir' }))
}

/** 文件系统错误 → 原因码（只有 ENOENT 才叫「不存在」）。 */
function errorCodeOf(error: unknown): BrowseErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'failed'
}

/** 名字排序：目录在前、同类按名字字典序（不依赖 locale，测试可复现）。 */
function compareEntries(a: BrowseEntry, b: BrowseEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * 列出一个目录（缺省 = 根列表）。
 *
 * `target` 缺省或空串 = 根列表；凡不是绝对路径一律 `not-absolute`（不猜基准目录 —— 猜错就列出别人的东西）。
 * @param options.limit 覆盖 {@link BROWSE_ENTRY_LIMIT}。
 */
export async function browseDirectory(
  target: string | undefined,
  options?: { limit?: number },
): Promise<BrowseResult> {
  const limit = Math.max(1, Math.trunc(options?.limit ?? BROWSE_ENTRY_LIMIT))
  const home = homedir()
  const wanted = (target ?? '').trim()
  if (wanted === '') {
    const roots = await listRoots()
    return { path: '', parent: null, home, entries: roots.slice(0, limit), truncated: roots.length > limit, error: null }
  }
  if (!parse(wanted).root) {
    return { path: wanted, parent: null, home, entries: [], truncated: false, error: 'not-absolute' }
  }
  const current = parse(wanted).root === wanted ? wanted : wanted.replace(/[\\/]+$/, '')
  let dirents
  try {
    dirents = await readdir(current, { withFileTypes: true })
  } catch (error) {
    return { path: current, parent: isRoot(current) ? null : dirname(current), home, entries: [], truncated: false, error: errorCodeOf(error) }
  }
  const entries: BrowseEntry[] = []
  for (const dirent of dirents) {
    const entryPath = join(current, dirent.name)
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: entryPath, kind: 'dir' })
      continue
    }
    if (dirent.isFile()) {
      entries.push({ name: dirent.name, path: entryPath, kind: 'file' })
      continue
    }
    // 符号链接 / junction / 其它特殊项：跟随一次（读不到就整条丢掉，绝不猜类型）
    try {
      const info = await stat(entryPath)
      if (info.isDirectory()) entries.push({ name: dirent.name, path: entryPath, kind: 'dir' })
      else if (info.isFile()) entries.push({ name: dirent.name, path: entryPath, kind: 'file' })
    } catch {
      // 断链：不展示（点了也进不去）
    }
  }
  entries.sort(compareEntries)
  return {
    path: current,
    parent: isRoot(current) ? null : dirname(current),
    home,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    error: null,
  }
}
