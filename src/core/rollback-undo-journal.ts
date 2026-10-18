/**
 * 回退前像 journal：**崩溃可检测、可证明安全重放**的前像日志。
 *
 * 背景（已确认缺陷）：`rollback-point.ts` 的 UndoStager 把前像写成 `<dir>/N.bin`，既没有「路径 → 前像」
 * 索引，也没有完成标记。进程崩溃后 `rollback-ledger.ts` 的 cleanupOrphanTempFiles 只按「pid 已死」
 * 把整个 undo 目录删掉 ⇒ 工作区被留在半回退状态：**无人知晓、也无法恢复**。本模块提供修复所需的原语。
 *
 * 提供的原语（纯模块，不接触引擎；零运行时依赖：node: 内置 + 仓内 utils）：
 *  - `UndoJournalWriter`：先落前像 bin、再 append 一行 JSON 索引并 fsync（顺序不可交换）；
 *    条目全部落盘后写 `done` 完成标记（原子 rename）。目录形态沿用既有实现
 *    `<root>/undo/<pid>-<ts36>-<8hex>/`。
 *  - `readUndoJournal`：读回快照；**尾行被截断**（崩在 append 中途）绝不抛异常，只置 `truncatedTail`。
 *  - `findInterruptedUndos`：只认「目录名形态 + 有 journal + 无 done + pid 已死」的中断残留。
 *  - `replayUndoJournal`：**逆序**写回，且只有当目标**当前内容确实等于**该条记录记录的 after 镜像时
 *    才写（删除动作 ⇒ 当前必须不存在）；否则计入 `skipped` —— 崩溃期间被用户/别的进程改过的文件
 *    **绝不覆盖**。
 *
 * 崩溃安全为什么成立（写入协议的排序理由）：
 *  1) 先写 bin、再记索引 ⇒ 崩在两者之间只留一个**未被任何索引引用**的 bin，重放按索引工作，不受影响；
 *  2) 每条索引 = 一次 append + fsync ⇒ 崩在写行中途只可能伤到最后一行，前面的行逐字完整；
 *  3) 完成后写 done ⇒「有 journal 无 done + pid 已死」就是「被中断」的信号。
 *
 * 所有返回给调用方的失败/跳过都是**逐条**文本 `<path>: <reason>`，绝不静默丢弃。
 */
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile } from '../utils/atomic-write.ts'
import { isENOENT, isRecord } from '../utils/guards.ts'
import { sha256Hex } from '../utils/hashing.ts'

/* ---------------------------------------------------------------------- 常量 */

/** 索引文件名：JSONL，一行一条记录 */
export const UNDO_JOURNAL_FILE_NAME = 'journal.jsonl'
/** 完成标记文件名（原子写入）；存在 = 这次回退的前像已**完整**落盘 */
export const UNDO_DONE_FILE_NAME = 'done'

/**
 * 前像暂存子目录名（与 `rollback-ledger.ts` 的 `ROLLBACK_UNDO_DIR_NAME` 同值）。
 * 刻意**不 import**：ledger 将来很可能反过来 import 本模块（清理前先查 journal），互相 import 会成环。
 */
const UNDO_SUBDIR_NAME = 'undo'
/**
 * 目录名形态 `<pid>-<ts36>-<8hex>`（与 rollback-ledger.ts 的 UNDO_DIR_RE 同源，**改动必须两处同步**）。
 * pid 必须在最前：中断判定要读它。
 */
const UNDO_DIR_RE = /^(\d+)-[0-9a-z]+-[0-9a-f]{8}$/
/** 前像文件名形态：只允许 `<seq>.bin`（防篡改 journal 把读引到目录外） */
const UNDO_BIN_RE = /^\d+\.bin$/
/** 找最后一个换行符时的反向分块大小（截断残缺尾行用；内存有界） */
const SCAN_CHUNK_BYTES = 64 * 1024

/* ---------------------------------------------------------------------- 类型 */

/** journal 里一条记录：索引（path/after 镜像）+ 前像引用（bin/bytes/sha256） */
export interface UndoJournalEntry {
  /** 本进程内的记录序号（0 起，一次 record 一条；bin 名 = `<seq>.bin`） */
  seq: number
  /** 回退动作作用的**绝对**路径 */
  path: string
  /** 前像文件名（相对 undo 目录）；null = 回退前该路径不存在 */
  bin: string | null
  /** 前像字节数 */
  bytes: number
  /** 前像 sha256；bin === null 时恒 null */
  sha256: string | null
  /**
   * **回退动作写入**的内容 sha256（删除动作为 null）。
   * 重放的唯一安全判据：当前内容 sha256 === 该值才敢写回。
   */
  afterSha256: string | null
  /** true = 该路径被回退动作删除（重放要求「当前仍不存在」） */
  afterDeleted: boolean
  /** 记录时间戳（注入的 now()） */
  at: number
}

export interface UndoJournalSnapshot {
  entries: UndoJournalEntry[]
  /** true = 文件最后一段是崩溃写了一半的行（已丢弃，绝不因此抛错） */
  truncatedTail: boolean
}

export interface InterruptedUndo {
  dir: string
  pid: number
  entries: UndoJournalEntry[]
  truncatedTail: boolean
}

/** 回退动作的 after 镜像：写入了某内容 / 删除了该路径 */
export type UndoAfter = { sha256: string } | { deleted: true }

export interface ReplayHooks {
  /** 读当前内容；返回 null = 该路径当前不存在（缺省用 fs.readFile，ENOENT 视为 null） */
  readCurrent?: (target: string) => Promise<Uint8Array | null>
  /** 写回前像 */
  write: (target: string, bytes: Uint8Array) => Promise<void>
}

export interface UndoJournalWriterOptions {
  /** 时间戳来源（测试可注入；缺省 Date.now） */
  now?: () => number
}

/* --------------------------------------------------------------- 写入端 */

/**
 * 前像 journal 写入端。
 *
 * 生命周期：`create()` → 逐条 `record()` →（全部落盘）`finish()` 写完成标记 → `dispose()` 关句柄。
 * 中断（未 finish）留在盘上的目录就是崩溃证据；调用方用 `findInterruptedUndos` + `replayUndoJournal` 收尾。
 */
export class UndoJournalWriter {
  /** 前像目录（`<root>/undo/<pid>-<ts36>-<8hex>`） */
  readonly dir: string
  private readonly journalPath: string
  private readonly now: () => number
  private handle: FileHandle | null
  private seq = 0
  /** 已成功 fsync 的 journal 字节数：写失败时回截到这里，保证不留半行 */
  private committedBytes = 0
  private disposed = false

  private constructor(
    dir: string,
    journalPath: string,
    handle: FileHandle,
    committedBytes: number,
    seq: number,
    now: () => number,
  ) {
    this.dir = dir
    this.journalPath = journalPath
    this.handle = handle
    this.committedBytes = committedBytes
    this.seq = seq
    this.now = now
  }

  /**
   * 打开（或续写）一个前像目录。目录建不出来 / journal 打不开 ⇒ 抛错，调用方必须**零写入失败**。
   */
  static async create(dir: string, options: UndoJournalWriterOptions = {}): Promise<UndoJournalWriter> {
    await fs.mkdir(dir, { recursive: true })
    const journalPath = path.join(dir, UNDO_JOURNAL_FILE_NAME)
    // 续写前先截掉上次崩溃留下的半行：否则新行会接在残句后面，把「残句 + 新行」粘成一行垃圾
    await trimTornJournalTail(journalPath)
    // 续写时序号必须接在已有条目之后，否则 bin 名会重号、覆盖上一条前像
    let seq = 0
    const existing = await readUndoJournal(dir)
    if (existing !== null) {
      for (const entry of existing.entries) seq = Math.max(seq, entry.seq + 1)
    }
    let committedBytes = 0
    try {
      committedBytes = (await fs.stat(journalPath)).size
    } catch {
      committedBytes = 0
    }
    const handle = await fs.open(journalPath, 'a+')
    return new UndoJournalWriter(dir, journalPath, handle, committedBytes, seq, options.now ?? Date.now)
  }

  /**
   * 记一条：先落前像 bin、再 append 索引行并 fsync。
   *
   * @param before 前像字节；null = 回退前该路径**不存在**
   * @param after  回退动作的 after 镜像（写入了什么 / 删除了）
   */
  async record(targetPath: string, before: Uint8Array | null, after: UndoAfter): Promise<void> {
    const handle = this.requireHandle()
    // 路径在**记录那一刻**就必须绝对可解析：宁可当场失败，也不写入一条重放时无法安全落地的索引
    if (!isJournalablePath(targetPath)) {
      throw new Error('undo journal path must be absolute and non-empty: ' + JSON.stringify(targetPath))
    }
    const mirror = normalizeAfter(after)
    const seq = this.seq
    let bin: string | null = null
    let bytes = 0
    let sha256: string | null = null
    if (before !== null) {
      bin = String(seq) + '.bin'
      bytes = before.byteLength
      sha256 = sha256Hex(before)
      // 顺序不可交换：bin 失败 ⇒ 一行索引都不写（journal 仍是此前完整的旧内容）
      await fs.writeFile(path.join(this.dir, bin), before)
    }
    const line = JSON.stringify({
      seq,
      path: targetPath,
      bin,
      bytes,
      sha256,
      afterSha256: mirror.afterSha256,
      afterDeleted: mirror.afterDeleted,
      at: this.now(),
    }) + '\n'
    const prior = this.committedBytes
    try {
      await handle.write(line)
      await handle.sync()
    } catch (error) {
      // 写盘失败（磁盘满 / 句柄坏）⇒ 回截到写入前长度，**绝不留半行 JSON**；回截失败也不掩盖原始错误
      await this.truncateTo(prior)
      throw error
    }
    this.committedBytes = prior + Buffer.byteLength(line, 'utf8')
    this.seq = seq + 1
  }

  /** 条目全部落盘后写 done 标记（原子 rename）：标记存在 = 这份前像完整，崩溃清理不得当残留删掉。 */
  async finish(): Promise<void> {
    this.requireHandle()
    const marker = JSON.stringify({ pid: process.pid, finishedAt: this.now() }) + '\n'
    await atomicWriteFile(path.join(this.dir, UNDO_DONE_FILE_NAME), marker)
  }

  /** 关句柄（幂等 + best-effort）；**不删目录** —— 删不删由调用方按 done/重放结果决定。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const handle = this.handle
    this.handle = null
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        /* best-effort：句柄已经坏了也不该把调用方带崩 */
      }
    }
  }

  private requireHandle(): FileHandle {
    if (this.disposed || this.handle === null) {
      throw new Error('undo journal writer already disposed: ' + this.journalPath)
    }
    return this.handle
  }

  /** 回截到 length（best-effort）：只用于「append + fsync 失败」后的自愈，绝不掩盖原始写错误。 */
  private async truncateTo(length: number): Promise<void> {
    const handle = this.handle
    if (handle === null) return
    try {
      await handle.truncate(length)
      await handle.sync()
    } catch {
      /* best-effort */
    }
  }
}

/* --------------------------------------------------------------- 读取端 */

/**
 * 读回 journal 快照。`null` = 该目录**本来就没有** journal（ENOENT）。
 *
 * 崩溃容忍：文件最后一段（可能是写了一半的行）解析失败 ⇒ 丢弃它、`truncatedTail = true`，
 * **绝不抛异常**。中间段坏掉不是 append 能造成的形状（篡改/损坏）⇒ 跳过且不算截断。
 */
export async function readUndoJournal(dir: string): Promise<UndoJournalSnapshot | null> {
  const journalPath = path.join(dir, UNDO_JOURNAL_FILE_NAME)
  let text: string
  try {
    text = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    // 只有「本来就没有 journal」才是 null；读不出来（EACCES/EISDIR…）如实抛，绝不假装「没有中断回退」
    if (isENOENT(error)) return null
    throw error
  }
  const segments = text.split('\n')
  const entries: UndoJournalEntry[] = []
  let truncatedTail = false
  for (let i = 0; i < segments.length; i += 1) {
    const raw = segments[i] ?? ''
    if (raw === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      if (i === segments.length - 1) truncatedTail = true
      continue
    }
    const entry = asJournalEntry(parsed)
    if (entry !== null) entries.push(entry)
  }
  return { entries, truncatedTail }
}

/**
 * 找中断的回退前像目录。
 *
 * @param root 既可以是**暂存根目录**（其直接子目录就是 `<pid>-<ts36>-<8hex>`），
 *             也可以是上层 dataRoot（此时会自动再看 `<root>/undo`）；两种调用口径都支持。
 * @param isAlive 进程存活探测（可注入，便于测试）；缺省 `process.kill(pid, 0)`。
 *
 * 判据（严格）：目录名形态匹配 + **有 journal** + **无 done** + **pid 已死**。
 * 读不出 journal 的目录跳过（判不准就不报，绝不猜）；结果按 dir 升序稳定排序。
 */
export async function findInterruptedUndos(
  root: string,
  isAlive: (pid: number) => boolean = defaultIsProcessAlive,
): Promise<InterruptedUndo[]> {
  const bases: string[] = [root]
  const nested = path.join(root, UNDO_SUBDIR_NAME)
  if (path.resolve(nested) !== path.resolve(root)) bases.push(nested)
  const seen = new Set<string>()
  const out: InterruptedUndo[] = []
  for (const base of bases) {
    let names: string[]
    try {
      names = await fs.readdir(base)
    } catch {
      continue
    }
    for (const name of names) {
      const m = UNDO_DIR_RE.exec(name)
      if (m === null) continue
      const pid = Number(m[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      if (isAlive(pid)) continue
      const dir = path.join(base, name)
      if (seen.has(dir)) continue
      const snapshot = await readJournalSafe(dir)
      if (snapshot === null) continue
      if (await pathExists(path.join(dir, UNDO_DONE_FILE_NAME))) continue
      seen.add(dir)
      out.push({ dir, pid, entries: snapshot.entries, truncatedTail: snapshot.truncatedTail })
    }
  }
  out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  return out
}

/* --------------------------------------------------------------- 重放端 */

/**
 * 重放一份中断的前像（**逆序**：同一路径被记两次时，最后写的是最早状态）。
 *
 * 安全判据（**没有证明就绝不写盘**）：
 *  - `afterDeleted` ⇒ 目标当前必须不存在（`readCurrent` 返回 null），否则 skipped；
 *  - 否则 `sha256(current)` 必须 === `afterSha256`，否则 skipped；
 *  - after 信息缺失/不可判（老行/损坏行，`afterSha256 === null`）⇒ skipped。
 *
 * 失败一律逐条进 `failed`（绝不静默）：`unsafe-path` / `unsafe-bin` / `before-checksum-mismatch` /
 * `read-current-failed: …` / 写入或删除的真实错误。读当前态失败属**保守失败**（该条不写）。
 */
export async function replayUndoJournal(
  undo: InterruptedUndo,
  hooks: ReplayHooks,
): Promise<{ restored: number; skipped: string[]; failed: string[] }> {
  let restored = 0
  const skipped: string[] = []
  const failed: string[] = []
  const readCurrent = hooks.readCurrent ?? readCurrentDefault
  for (const entry of [...undo.entries].reverse()) {
    const target = safeReplayTarget(entry.path)
    if (target === null) {
      failed.push(entry.path + ': unsafe-path')
      continue
    }
    let current: Uint8Array | null
    try {
      current = await readCurrent(target)
    } catch (error) {
      failed.push(target + ': read-current-failed: ' + errorMessage(error))
      continue
    }
    const blocked = afterStateMismatch(entry, current)
    if (blocked !== null) {
      skipped.push(target + ': ' + blocked)
      continue
    }
    try {
      if (entry.bin === null) {
        // 前像 = 「回退前不存在」⇒ 回退动作就是把它删掉（force：已经不在了也算成功）
        await fs.rm(target, { force: true })
        restored += 1
        continue
      }
      const binPath = safeBinPath(undo.dir, entry.bin)
      if (binPath === null) {
        failed.push(target + ': unsafe-bin')
        continue
      }
      const bytes = await fs.readFile(binPath)
      if (entry.sha256 !== null && sha256Hex(bytes) !== entry.sha256) {
        failed.push(target + ': before-checksum-mismatch')
        continue
      }
      await hooks.write(target, bytes)
      restored += 1
    } catch (error) {
      failed.push(target + ': ' + errorMessage(error))
    }
  }
  return { restored, skipped, failed }
}

/* --------------------------------------------------------------- 内部 */

/** 与记录的 after 镜像比对：返回 null = 当前状态一致，可以安全写回；否则返回跳过原因。 */
function afterStateMismatch(entry: UndoJournalEntry, current: Uint8Array | null): string | null {
  if (entry.afterDeleted) {
    return current === null ? null : 'after-state-changed: expected-absent'
  }
  if (entry.afterSha256 === null) {
    // 无证明（老行/损坏行）：宁可留下可人工处理的中断，也不覆盖用户后来的修改
    return 'after-state-unknown'
  }
  if (current === null) return 'after-state-changed: missing'
  if (sha256Hex(current) !== entry.afterSha256) return 'after-state-changed: sha256-mismatch'
  return null
}

function asJournalEntry(value: unknown): UndoJournalEntry | null {
  if (!isRecord(value)) return null
  const seq = value['seq']
  const target = value['path']
  const bin = value['bin']
  const bytes = value['bytes']
  const sha = value['sha256']
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
  if (typeof target !== 'string' || target === '') return null
  if (bin !== null && typeof bin !== 'string') return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (sha !== null && typeof sha !== 'string') return null
  const afterDeleted = value['afterDeleted'] === true
  const afterRaw = value['afterSha256']
  const afterSha256 = !afterDeleted && typeof afterRaw === 'string' && afterRaw !== '' ? afterRaw : null
  const at = value['at']
  return {
    seq,
    path: target,
    bin,
    bytes,
    sha256: sha,
    afterSha256,
    afterDeleted,
    // 缺/坏时间戳归一为 0：**不影响安全判据**（重放只看 after 镜像），只作诊断
    at: typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : 0,
  }
}

/** 记录期路径校验：绝对 + 非空 + 无 NUL（否则重放时无法安全落地） */
function isJournalablePath(raw: string): boolean {
  return raw !== '' && !raw.includes('\0') && path.isAbsolute(raw)
}

/**
 * 重放期路径校验：必须绝对且可解析。相对路径会落到进程 CWD（越权）⇒ 拒绝；
 * 归一化后的绝对路径（`path.resolve`）是实际写入目标。
 */
function safeReplayTarget(raw: string): string | null {
  if (raw === '' || raw.includes('\0')) return null
  if (!path.isAbsolute(raw)) return null
  return path.resolve(raw)
}

/** 前像文件名必须在 undo 目录内且形态为 `<seq>.bin`（防篡改 journal 读目录外文件） */
function safeBinPath(dir: string, bin: string): string | null {
  if (!UNDO_BIN_RE.test(bin)) return null
  const base = path.resolve(dir)
  const resolved = path.resolve(base, bin)
  return resolved.startsWith(base + path.sep) ? resolved : null
}

function isDeletedAfter(after: UndoAfter): after is { deleted: true } {
  return (after as { deleted?: unknown }).deleted === true
}

function normalizeAfter(after: UndoAfter): { afterDeleted: boolean; afterSha256: string | null } {
  if (isDeletedAfter(after)) return { afterDeleted: true, afterSha256: null }
  const digest: unknown = (after as { sha256?: unknown }).sha256
  if (typeof digest !== 'string' || digest === '') {
    throw new Error('undo journal after image must be { sha256 } or { deleted: true }')
  }
  return { afterDeleted: false, afterSha256: digest }
}

function defaultIsProcessAlive(pid: number): boolean {
  // 判不出来一律当「活着」：宁可留垃圾，也绝不删除/覆盖用户数据
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限发信号（Windows 上很常见）⇒ 仍然算活着
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readJournalSafe(dir: string): Promise<UndoJournalSnapshot | null> {
  try {
    return await readUndoJournal(dir)
  } catch {
    return null
  }
}

async function readCurrentDefault(target: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(target)
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 截掉 journal 末尾**不完整的那一行**（上次崩溃残留）。
 * 末尾是完整行（以 '\n' 收尾）/ 文件不存在 ⇒ 零写入；找不到任何换行 ⇒ 清零。
 */
async function trimTornJournalTail(file: string): Promise<void> {
  let size = 0
  try {
    size = (await fs.stat(file)).size
  } catch {
    return
  }
  if (size === 0) return
  const handle = await fs.open(file, 'r+')
  try {
    if (await endsWithNewline(handle, size)) return
    const cut = await lastNewlineOffset(handle, size)
    await handle.truncate(cut)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function endsWithNewline(handle: FileHandle, size: number): Promise<boolean> {
  const last = Buffer.alloc(1)
  await handle.read(last, 0, 1, size - 1)
  return last[0] === 0x0a
}

/** 反向分块找最后一个 '\n'，返回其**之后**的偏移（无换行则 0）；内存与文件大小无关 */
async function lastNewlineOffset(handle: FileHandle, size: number): Promise<number> {
  let end = size
  while (end > 0) {
    const start = Math.max(0, end - SCAN_CHUNK_BYTES)
    const buf = Buffer.allocUnsafe(end - start)
    await handle.read(buf, 0, buf.length, start)
    const idx = buf.lastIndexOf(0x0a)
    if (idx >= 0) return start + idx + 1
    end = start
  }
  return 0
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return typeof code === 'string' && code !== '' ? code + ' ' + error.message : error.message
  }
  return String(error)
}
