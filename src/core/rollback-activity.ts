/**
 * 会话**活跃时间窗**台账 —— 「某个时刻有哪些会话正在活着」。
 *
 * 为什么需要（2026-10-17 用户反馈 + 真机复盘）：写入归属（`rollback-attribution.ts`）只能从
 * `tool/call` 的 arguments 里抽 `file_path`；`pwsh` / `run_code` / 脚本 / 外部编辑器写文件时
 * **没有可解析的路径参数** ⇒ 这些写入完全没有归属，回退时识别不出「别的对话刚写过」，
 * 于是把它一起抹掉（真机：B 对话给 README 加了一行，回退 A 时那一行也没了）。
 *
 * 这里补的是**时间维度**：文件 mtime 若落在某个会话的活跃窗口内，该会话就是候选写入者 ——
 * 与工具参数完全无关，对 bash / 脚本 / 外部编辑器同样有效。
 *
 * ⚠️ 边界（不得越界解读）：时间窗只能证明「该会话在那时候有活动」，**不能单独证明「就是它写的」**。
 * 它是旁证，不是判决；引擎必须把它与归属台账合起来用（见 rollback-point.ts 的判定）。
 *
 * 三条不变量（不得放宽）：
 *  ① 采集**尽力而为**：只记「会话 id + 时间」，任何读写失败只 warn，绝不参与留点 / 回退的成败判定。
 *  ② 窗口只增不减：同一会话的多次活动按 gapMs 合并；落盘前先读旧文件做**并集**，
 *     两个 DSH 进程同写一个文件时绝不互相抹掉（落盘纪律照抄 `rollback-attribution.ts`）。
 *  ③ 形状不符 = 空表：读不出来时宁可少一个窗口，也绝不猜字段含义（猜错会让回退误判归属）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 台账文件名（与回滚点库同目录：dataDir/rollback-points/activity.json） */
export const ROLLBACK_ACTIVITY_FILE_NAME = 'activity.json'
/** 同一会话两条活动的间隔 <= 该值就并成一个窗口（缺省 10 分钟） */
export const ROLLBACK_ACTIVITY_DEFAULT_GAP_MS = 10 * 60 * 1000
/** 窗口条目上限（超出按 to 淘汰最旧）—— 无界增长会把宿主拖垮（见 issue #89 的教训） */
export const ROLLBACK_ACTIVITY_MAX_INTERVALS = 20000

/** 一条会话活跃窗口：会话 sessionId 在 [from, to] 之间有过活动 */
export interface RollbackActivityInterval {
  sessionId: string
  from: number
  to: number
}

/** 落盘载荷形状（形状不符一律当空表：读不出 ≠ 某会话活跃） */
interface ActivityFileV1 {
  version: 1
  intervals: RollbackActivityInterval[]
}

export interface RollbackActivityOptions {
  /** 台账文件绝对路径（引擎传 dataDir/rollback-points/activity.json） */
  file: string
  /** 缺省时钟；`noteActivity` 不传 at 时用它（事件时间优先，取数时刻只是兜底） */
  now?: () => number
  /** 同一会话两条活动间隔 <= gapMs 就合并（缺省 ROLLBACK_ACTIVITY_DEFAULT_GAP_MS） */
  gapMs?: number
  /** 窗口总条数上限（缺省 ROLLBACK_ACTIVITY_MAX_INTERVALS），超出淘汰最旧的 */
  maxIntervals?: number
  /** 落盘延迟（毫秒）；<= 0 表示不自动落盘（测试用） */
  flushDelayMs?: number
  /** 读写失败只 warn，绝不抛 */
  warn?: (line: string) => void
}

/** 按会话分组的窗口表（key = sessionId；value 按 from 升序、**互不相接**：任意两条的缝 > gapMs） */
type ActivityTable = Map<string, RollbackActivityInterval[]>

/** 读一条窗口；形状不符返回 null（跳过，不猜） */
function readInterval(value: unknown): RollbackActivityInterval | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const sessionId = record.sessionId
  const from = record.from
  const to = record.to
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof from !== 'number' || !Number.isFinite(from) || from < 0) return null
  if (typeof to !== 'number' || !Number.isFinite(to) || to < 0) return null
  if (to < from) return null
  return { sessionId, from, to }
}

/**
 * 把一条窗口 [from, to] 并进窗口表（**纯函数**；落盘的「写前先读」也复用它）。
 *
 * 合并口径：与已有窗口的距离 <= gapMs 就并成一条（含重叠、相接）；
 * 表内窗口按 from 升序且互不相接，所以「向后找不到可并的」即可停 —— 更早的窗口 to 只会更小。
 */
function mergeRangeInto(table: ActivityTable, gapMs: number, sessionId: string, from: number, to: number): void {
  let list = table.get(sessionId)
  if (list === undefined) {
    list = []
    table.set(sessionId, list)
  }
  let hit = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const iv = list[i]
    if (iv === undefined) continue
    if (from <= iv.to + gapMs && to >= iv.from - gapMs) {
      hit = i
      break
    }
    if (from > iv.to + gapMs) break
  }
  if (hit === -1) {
    // 新开一条，按 from 升序插入（时钟回拨 / 乱序事件也不能让表失序）
    let pos = list.length
    while (pos > 0) {
      const prev = list[pos - 1]
      if (prev === undefined || prev.from <= from) break
      pos -= 1
    }
    list.splice(pos, 0, { sessionId, from, to })
    return
  }
  const target = list[hit]
  if (target === undefined) return
  target.from = Math.min(target.from, from)
  target.to = Math.max(target.to, to)
  // 扩张后可能把左右邻居也拉进 gapMs 内 ⇒ 一并吸收，维持「互不相接」不变量
  let index = hit
  while (index > 0) {
    const left = list[index - 1]
    const right = list[index]
    if (left === undefined || right === undefined || right.from - left.to > gapMs) break
    left.from = Math.min(left.from, right.from)
    left.to = Math.max(left.to, right.to)
    list.splice(index, 1)
    index -= 1
  }
  while (index + 1 < list.length) {
    const left = list[index]
    const right = list[index + 1]
    if (left === undefined || right === undefined || right.from - left.to > gapMs) break
    left.to = Math.max(left.to, right.to)
    list.splice(index + 1, 1)
  }
}

/** 窗口表 → 有稳定顺序的数组（先按会话 id，再按 from/to；落盘内容不随 Map 顺序抖动） */
function flattenIntervals(table: ActivityTable): RollbackActivityInterval[] {
  const out: RollbackActivityInterval[] = []
  for (const list of table.values()) {
    for (const iv of list) out.push({ sessionId: iv.sessionId, from: iv.from, to: iv.to })
  }
  out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.from - b.from || a.to - b.to))
  return out
}

/**
 * 内存窗口表 + best-effort 落盘。
 *
 * 落盘的作用只有一个：**进程重启后**给旧会话回退时，活跃窗口还在（否则新进程只有本次启动后看到的窗口）。
 * 因此写入是延迟合并的（一次会话事件一行，立即落盘会把 I/O 打成筛子）。
 */
export class RollbackSessionActivity {
  private readonly table: ActivityTable = new Map()
  private readonly file: string
  private readonly now: () => number
  private readonly gapMs: number
  private readonly maxIntervals: number
  private readonly flushDelayMs: number
  private readonly warn: (line: string) => void
  private loadPromise: Promise<void> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null
  /** 内存变更计数：与 lastFlushedRevision 相等 ⇒ 没有未落盘数据（flush 幂等靠它，不靠时间戳） */
  private revision = 0
  private lastFlushedRevision = 0

  constructor(options: RollbackActivityOptions) {
    this.file = path.resolve(options.file)
    this.now = options.now ?? (() => Date.now())
    const gap = options.gapMs ?? ROLLBACK_ACTIVITY_DEFAULT_GAP_MS
    this.gapMs = Number.isFinite(gap) && gap >= 0 ? gap : ROLLBACK_ACTIVITY_DEFAULT_GAP_MS
    const max = options.maxIntervals ?? ROLLBACK_ACTIVITY_MAX_INTERVALS
    this.maxIntervals = Number.isFinite(max) && max >= 1 ? Math.floor(max) : ROLLBACK_ACTIVITY_MAX_INTERVALS
    const delay = options.flushDelayMs ?? 1000
    this.flushDelayMs = Number.isFinite(delay) ? delay : 1000
    this.warn = options.warn ?? (() => {})
  }

  /** 窗口总条数（诊断与测试用；上限见 maxIntervals。等价于「条目」，不是会话数） */
  get size(): number {
    let total = 0
    for (const list of this.table.values()) total += list.length
    return total
  }

  /** 惰性读盘（幂等；读失败 = 空表，只 warn） */
  async load(): Promise<void> {
    if (this.loadPromise === null) this.loadPromise = this.read()
    return this.loadPromise
  }

  private async read(): Promise<void> {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as { version?: unknown; intervals?: unknown } | null
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.intervals)) {
        this.warn('rollback activity ignored (shape): ' + this.file)
        return
      }
      for (const raw of parsed.intervals) {
        const iv = readInterval(raw)
        if (iv === null) continue
        // 磁盘只是旧快照：**并集合并** ⇒ 读盘不得让本进程刚记的窗口消失（新记录优先）
        mergeRangeInto(this.table, this.gapMs, iv.sessionId, iv.from, iv.to)
      }
      if (this.size > this.maxIntervals) this.evictOldest()
    } catch (error) {
      const code = (error as { code?: unknown }).code
      // ENOENT = 还没写过台账（正常）；其它错误如实留痕但不抛
      if (code !== 'ENOENT') this.warn('rollback activity unreadable: ' + this.file + ' ' + String(code ?? error))
    }
  }

  /**
   * 记一次活动。窗口只增不减：与上一条间隔 <= gapMs 就并入同一条窗口，否则新开一条。
   *
   * `at` 缺省取注入时钟（`options.now`）：引擎把**事件时间**显式传进来时以它为准
   * （事件时间才是那次活动的真实时刻，取数时刻可能晚很多）。
   * 空会话 id、非有限数字、负数一律**忽略**（fail-closed：宁可少一个窗口，绝不记错归属）。
   */
  noteActivity(sessionId: string, at: number = this.clockNow()): void {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return
    mergeRangeInto(this.table, this.gapMs, sessionId, at, at)
    this.revision += 1
    if (this.size > this.maxIntervals) this.evictOldest()
    this.scheduleFlush()
  }

  /** 缺省时钟：注入的 now 抛错或给出非有限值时 fail-closed（返回 NaN，由调用方校验丢弃） */
  private clockNow(): number {
    try {
      return this.now()
    } catch {
      return Number.NaN
    }
  }

  /** 该会话最后一次活动时刻；没记过 = null（**不是 0**，0 会被误当成有效时间戳） */
  lastActivityAt(sessionId: string): number | null {
    const list = this.table.get(sessionId)
    if (list === undefined || list.length === 0) return null
    const last = list[list.length - 1]
    return last === undefined ? null : last.to
  }

  /** 该会话是否有任何窗口（用于区分「确知没活动」与「根本没采到」） */
  hasDataFor(sessionId: string): boolean {
    const list = this.table.get(sessionId)
    return list !== undefined && list.length > 0
  }

  /** 活跃窗口包含 at（可容忍 toleranceMs，缺省 0）的会话 id，按 id 升序、去重 */
  sessionsActiveAt(at: number, toleranceMs = 0): string[] {
    const out: string[] = []
    if (typeof at !== 'number' || !Number.isFinite(at)) return out
    const tolerance = Number.isFinite(toleranceMs) && toleranceMs > 0 ? toleranceMs : 0
    for (const [sessionId, windows] of this.table) {
      for (const iv of windows) {
        if (at >= iv.from - tolerance && at <= iv.to + tolerance) {
          out.push(sessionId)
          break
        }
      }
    }
    return out.sort()
  }

  /** 单个会话是否活跃（与 sessionsActiveAt 同口径，不另写一套判定） */
  isActiveAt(sessionId: string, at: number, toleranceMs = 0): boolean {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    return this.sessionsActiveAt(at, toleranceMs).includes(sessionId)
  }

  /** 延迟落盘（多次调用只落一次） */
  scheduleFlush(): void {
    if (this.flushDelayMs <= 0 || this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.flushDelayMs)
    // 台账不该阻止进程退出
    ;(this.flushTimer as { unref?: () => void }).unref?.()
  }

  /** 内存快照（深拷一层：落盘期间的新活动不得改写正在序列化的数据） */
  private snapshot(): ActivityTable {
    const clone: ActivityTable = new Map()
    for (const [sessionId, list] of this.table) {
      clone.set(
        sessionId,
        list.map((iv) => ({ sessionId: iv.sessionId, from: iv.from, to: iv.to })),
      )
    }
    return clone
  }

  /** 淘汰最旧的窗口（按 to 升序删到上限内；条目 = 窗口，不是会话） */
  private evictOldest(): void {
    const flat: RollbackActivityInterval[] = []
    for (const list of this.table.values()) flat.push(...list)
    const over = flat.length - this.maxIntervals
    if (over <= 0) return
    flat.sort((a, b) => a.to - b.to || a.from - b.from)
    const doomed = new Set<RollbackActivityInterval>(flat.slice(0, over))
    for (const [sessionId, list] of [...this.table]) {
      const kept = list.filter((iv) => !doomed.has(iv))
      if (kept.length === 0) this.table.delete(sessionId)
      else this.table.set(sessionId, kept)
    }
  }

  /**
   * 立刻落盘（原子：同目录临时文件 + rename；失败只 warn，绝不上抛）。
   *
   * 幂等：没有未落盘数据（revision == lastFlushedRevision）时**直接返回、不碰磁盘**；
   * 并发调用共用同一个在飞写入。
   */
  async flush(): Promise<void> {
    if (this.writing !== null) return this.writing
    if (this.revision === this.lastFlushedRevision) return
    this.writing = (async () => {
      const captured = this.revision
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        const merged = this.snapshot()
        // **写前合并**（2026-10-17 修）：本进程内存里只有自己见过的活动，而同一个工作区可能同时被
        // 另一个 DSH 进程写台账 —— 各自「整体覆盖」会把对方的时间窗抹掉。窗口只增不减
        // ⇒ 与磁盘做**并集合并**是唯一不丢信息的口径（同键取较新的那套在这里不适用：
        // 时间窗不是「最后一次是谁」，而是「谁在这段时间活过」，两个进程的窗口都要留）。
        try {
          const existing = JSON.parse(await fs.readFile(this.file, 'utf8')) as { version?: unknown; intervals?: unknown } | null
          if (existing !== null && typeof existing === 'object' && !Array.isArray(existing) && existing.version === 1 && Array.isArray(existing.intervals)) {
            for (const raw of existing.intervals) {
              const iv = readInterval(raw)
              if (iv === null) continue
              mergeRangeInto(merged, this.gapMs, iv.sessionId, iv.from, iv.to)
            }
          }
        } catch {
          /* 读不到就当没有别人的记录：只写自己这份（绝不因为读失败而放弃落盘） */
        }
        const payload: ActivityFileV1 = { version: 1, intervals: flattenIntervals(merged) }
        const tmp = this.file + '.tmp'
        await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
        await fs.rename(tmp, this.file)
        this.lastFlushedRevision = captured
      } catch (error) {
        this.warn('rollback activity write failed: ' + this.file + ' ' + String((error as { code?: unknown }).code ?? error))
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }

  /**
   * 关闭：取消待落盘的定时器，并把还没落盘的活动写下去。
   * 没有未落盘数据时不会重复写（flush 幂等）；写入失败只 warn，不透出（关停路径不得被台账拖垮）。
   */
  async dispose(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
    // 在飞写入期间又记了新活动 ⇒ 再落一次（最多两次，绝不循环重试）
    if (this.revision !== this.lastFlushedRevision) await this.flush()
  }
}
