/**
 * 严格递归删除 —— 覆盖 `fs.rm(dir, { recursive: true, force: true })` 的**静默失效**。
 *
 * 实测（Node 24 / Windows，本仓 0.5.0）：目录里只要有一个**悬空链接**（junction / 符号链接的
 * 重指向目标已被删掉），`fs.rmSync(dir, { recursive: true, force: true })` 既不抛错、也不删任何东西
 * —— 1 ms 内返回，目录原样留在磁盘上。用户点「删除档案」，插件回「已删除档案 X」，磁盘上一点没动。
 *
 * 悬空链接不是畸形数据，而是 DSH 自己会造出来的形态：档案的 `node_modules/<pkg>` 是指向
 * `.dsh-module-fallback/node_modules/<pkg>` 的 junction，fallback 目录随宿主升级/重建消失后，
 * 这些链接就全部悬空（实测某档案 20 个）。所以删除必须走通这种树，且**删完必须复核**。
 *
 * 本模块的语义：
 *  - 不用 rm 的目录遍历：自己 readdir + lstat 逐条走；**链接只删链接本身**，绝不跟随进 pnpm store；
 *  - 列表里有、lstat 读不到的条目（并发删除 / 悬空链接在个别平台上的形态）→ 直接尝试 unlink；
 *  - 只读文件 / 只读目录 / 被杀软或索引占用的条目 → 改权限 + 有界退避重试；
 *  - 结束后**复核目标不存在**，还在就抛错 —— 绝不把「什么都没删」当成成功。
 */
import { chmodSync, existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync, type Dirent, type Stats } from 'node:fs'
import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 单个条目的删除重试次数（Windows 上半途的 AV 扫描 / 索引句柄会让 unlink 短暂 EBUSY）。 */
const MAX_ATTEMPTS = 4
/** 首次退避毫秒（之后每次翻倍）。 */
const BASE_DELAY_MS = 20
/** 值得重试的错误码：只读属性 / 被占用 / 目录已被别人删空一半。 */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'])

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

/** 同步退避：用 Atomics.wait 而不是忙等自旋（与 utils/atomic-write.ts 同做法）。 */
function busyWait(ms: number): void {
  const ia = new Int32Array(new SharedArrayBuffer(4))
  try {
    Atomics.wait(ia, 0, 0, ms)
  } catch {
    /* SharedArrayBuffer 不可用：退化为不等待（少见） */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** lstat：ENOENT 返回 null（真的没了），其它错误照抛（读不到 ≠ 不存在）。 */
function lstatSyncOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** 删一个**非目录**条目（文件 / 符号链接 / junction）；悬空链接只能走这条路。 */
function unlinkSyncOrRetry(path: string): void {
  let delay = BASE_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      unlinkSync(path)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error
      // EPERM 在 Windows 上多为「只读属性」：先摘掉只读再重试
      if (code === 'EPERM' || code === 'EACCES') {
        try { chmodSync(path, 0o666) } catch { /* 目标已消失 / 无权限：交给下一轮重试 */ }
      }
      busyWait(delay)
      delay *= 2
    }
  }
}

async function unlinkOrRetry(path: string): Promise<void> {
  let delay = BASE_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error
      if (code === 'EPERM' || code === 'EACCES') {
        try { await chmod(path, 0o666) } catch { /* 同上 */ }
      }
      await sleep(delay)
      delay *= 2
    }
  }
}

/** 删空目录（调用前子项已删净）；ENOTEMPTY 说明有人在并发写入 → 有界重试。 */
function rmdirSyncOrRetry(path: string): void {
  let delay = BASE_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      rmdirSync(path)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error
      if (code === 'EPERM' || code === 'EACCES') {
        try { chmodSync(path, 0o777) } catch { /* 同上 */ }
      }
      busyWait(delay)
      delay *= 2
    }
  }
}

async function rmdirOrRetry(path: string): Promise<void> {
  let delay = BASE_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await rmdir(path)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error
      if (code === 'EPERM' || code === 'EACCES') {
        try { await chmod(path, 0o777) } catch { /* 同上 */ }
      }
      await sleep(delay)
      delay *= 2
    }
  }
}

/** 目录在遍历途中消失 → 返回空（随后 rmdir 得到 ENOENT 并被吞掉）。 */
function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

async function readdirSafeAsync(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

/** 无异常版本的「还在不在」：任何 stat 错误都当作还在，交给最终复核报错。 */
function stillExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return existsSync(path)
  }
}

/**
 * 删掉一个节点（文件 / 链接 / 目录，目录连自身一起删）。
 * 判据用 lstat：junction 在 Windows 上 isSymbolicLink()=true → 走 unlink，绝不跟进目标。
 */
function removeNodeSync(target: string): void {
  const stat = lstatSyncOrNull(target)
  if (stat === null) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    unlinkSyncOrRetry(target)
    return
  }
  for (const entry of readdirSafe(target)) removeChildSync(target, entry)
  rmdirSyncOrRetry(target)
}

async function removeNode(target: string): Promise<void> {
  const stat = await lstatOrNull(target)
  if (stat === null) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await unlinkOrRetry(target)
    return
  }
  for (const entry of await readdirSafeAsync(target)) await removeChild(target, entry)
  await rmdirOrRetry(target)
}

function removeChildSync(dir: string, entry: Dirent): void {
  const child = join(dir, entry.name)
  try {
    // dirent 对悬空链接的 isDirectory() 各平台不一致：类型只认 lstat
    lstatSync(child)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    // 读不到类型（锁 / 权限）：按「非目录」尝试删；删不掉就把真实错误抛出去
    unlinkSyncOrRetry(child)
    return
  }
  removeNodeSync(child)
}

async function removeChild(dir: string, entry: Dirent): Promise<void> {
  const child = join(dir, entry.name)
  try {
    await lstat(child)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    await unlinkOrRetry(child)
    return
  }
  await removeNode(child)
}

/**
 * 同步严格删除：目标不存在算成功；链接只删链接本身；删不掉抛底层错误；
 * 结束时目标**仍然存在**也抛错（rm 静默失效的兜底判据）。
 */
export function removeTreeSync(target: string): void {
  removeNodeSync(target)
  if (stillExists(target)) throw new Error(`removeTreeSync: target still exists after removal: ${target}`)
}

/** 异步版本（大批量目录不阻塞事件循环）；语义与 removeTreeSync 完全一致。 */
export async function removeTree(target: string): Promise<void> {
  await removeNode(target)
  if (stillExists(target)) throw new Error(`removeTree: target still exists after removal: ${target}`)
}
