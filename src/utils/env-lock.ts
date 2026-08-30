/**
 * 跨进程环境锁 primitive（Phase 2：Cross-process Lock）。
 *
 * 目标：防止多个 DSH 实例 / Web Host / CLI / AutoSync / Backup Scheduler / Model Tools
 * 同时执行 destructive mutation。提供 **GLOBAL EXCLUSIVE MUTATION LOCK**。
 *
 * 设计基线：CROSS_PROCESS_LOCK_DESIGN.md Rev 3（BLOCKER 1–4 全部 CLOSED）。
 * 关键不变量（NON-NEGOTIABLE，违反即破坏正确性）：
 *  - 所有权获取 **必须** `open(lockPath, 'wx')` 独占创建语义；**禁止** exists→write、rm→recreate、
 *    用 Phase 1 `atomicWriteFile(environment.lock)` 获取所有权。
 *  - `environment.lock` 是 **immutable ownership record**：创建后直到 release 不被 rename/replace。
 *  - heartbeat 走 **独立 sidecar** `environment.heartbeat.<instanceId>`，可安全用 Phase 1 `atomicWriteFile` 更新。
 *  - **operation-scoped** `MutationLockToken`：禁止 process-level reentrant（instanceId/handle/reenterCount 判嵌套）。
 *  - stale 检测只分类（LOCKED / STALE_LOCK_DETECTED / UNKNOWN_STATE），**绝不自动 unlink/takeover**。
 *  - recover 是独立显式动作（CLI `--recover-stale-lock`），用原子 rename 捕获 + 二次验证，二次验证失败不覆盖 successor。
 *  - destructive mutation 无 `--force`：必须成功 acquire，否则不得执行。
 *  - release 前校验 owner.instanceId === token.instanceId，不匹配不 unlink（ownership-lost）。
 *
 * 零 DSH 依赖（仅 node:fs / node:path / node:os / node:crypto + 复用 atomic-write.ts 的 atomicWriteFile）。
 * CLI 离线引擎可复用。io / 时钟 / 进程身份探测可注入（对齐 Phase 1 AtomicIo 模式）。
 */
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { atomicWriteFile } from './atomic-write.ts'

// ---------- 常量 ----------

const WINDOWS = process.platform === 'win32'
/** 锁目录相对 dataDir */
export const LOCKS_DIR = 'locks'
/** 所有权记录文件名（immutable） */
export const OWNERSHIP_FILE = 'environment.lock'
/** heartbeat sidecar 前缀 + 文件名模板：environment.heartbeat.<instanceId> */
export const HEARTBEAT_PREFIX = 'environment.heartbeat.'
/** recovery 捕获文件名临时前缀 + 模板：environment.recovering.<recoveryInstanceId> */
export const RECOVERING_PREFIX = 'environment.recovering.'
/** lock schema 版本 */
export const LOCK_SCHEMA_VERSION = 1
/** 默认心跳间隔 ms */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000
/** 默认 stale 阈值 ms（≥ 10 × heartbeatInterval） */
export const DEFAULT_STALE_AFTER_MS = 10_000
/** 默认 acquire 等待超时（等待活跃锁释放）ms；0 = 不等待直接返回 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 0

// ---------- 类型 ----------

/** 进程身份（可注入探测；OS 可验证的 process creation identity 才用于 PID reuse） */
export interface ProcessIdentity {
  /** OS 可验证的进程创建身份串（Linux /proc/<pid>/stat starttime、macOS ps、Windows Get-Process）；null = 无法可靠取得 */
  osProcessStartIdentity: string | null
  /** 进程是否存活（best-effort） */
  alive: boolean
}

/** 可注入的进程身份探测门面（默认实现跨平台；测试可注入）。
 * 契约：`alive:false` 只表示 **确证不存在**（ESRCH）；探测失败/不确定必须 **抛错**，
 * 由上层归为 UNKNOWN_STATE —— 绝不把失败误报为「确证死亡」（否则会成为误删许可）。 */
export interface ProcessIdentityProbe {
  /** 探测某 pid 的存活与 OS 身份；确证不存在返回 alive:false；不确定/失败抛错 */
  probe(pid: number): Promise<ProcessIdentity>
  /** 是否能够可靠取得 OS process creation identity（该平台上实现能力） */
  canGetOsIdentity(): boolean
}

/** 可注入 IO 门面（对齐 Phase 1 AtomicIo；默认包 node:fs/promises） */
export interface EnvLockIo {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<void>
  /** open；flag 含 'x'（wx/wx+）用于独占创建 */
  open(p: string, flag: string, mode?: number): Promise<EnvLockHandle>
  rename(src: string, dst: string): Promise<void>
  unlink(p: string): Promise<void>
  stat(p: string): Promise<{ isFile(): boolean } | null>
  readFileText(p: string): Promise<string>
  lstat?(p: string): Promise<{ isSymbolicLink(): boolean } | null>
  /** 列出目录条目名（诊断；不存在 → 空） */
  listLocksDir?(dir: string): Promise<string[]>
}

export interface EnvLockHandle {
  writeFile(data: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export type LockState =
  /** 成功获得所有权 */
  | 'ACQUIRED'
  /** 锁被活跃 owner 持有 */
  | 'LOCKED'
  /** 检测到确定 stale（heartbeat 超时 + 进程确证死亡 或 PID reuse）—— 只报告，不自动删除 */
  | 'STALE_LOCK_DETECTED'
  /** 无法可靠判定（探测失败 / OS identity 缺失）—— 不删除、不 recover、destructive 不执行 */
  | 'UNKNOWN_STATE'
  /** lock 目录 / 文件 IO 错误（非占用） */
  | 'LOCK_IO_ERROR'
  /** 权限错误（EPERM/EACCES 且无法确认 lock 存在） */
  | 'PERMISSION_ERROR'

/** 所有权记录（immutable）：写入后直到 release 不再改名/替换 */
export interface LockOwnershipRecord {
  schemaVersion: number
  owner: {
    instanceId: string
    /** 本实例启动时刻（Date.now()，应用层时间戳；PID reuse 判断不使用它） */
    instanceStartedAt: number
    pid: number
    hostname: string
    /** OS 可验证的进程创建身份（写入方 acquire 时探测自身）；可能为 null */
    osProcessStartIdentity: string | null
  }
  op: string
  target: string
  acquiredAt: number
  lockVersion: string
  /** 预留 Phase 3 journal id；本阶段恒 null，不实现 */
  journalId: string | null
}

/** heartbeat sidecar 内容（atomicWriteFile 更新；文件名含 instanceId） */
export interface HeartbeatRecord {
  ownerInstanceId: string
  heartbeatAt: number
  seq: number
}

/** 一次 acquire 的返回 */
export interface AcquireResult {
  state: LockState
  /** state === 'ACQUIRED' 时非 null */
  token: MutationLockToken | null
  /** 诊断信息（非敏感）：占用方 op/hostname、或错误描述 */
  detail?: string
}

/** operation-scoped lock token：accepted 后只属于当前 mutation 调用链 */
export interface MutationLockToken {
  /** 本 token 唯一的不可伪造 id */
  readonly tokenId: string
  /** 所属 manager 身份（防止 foreign token） */
  readonly managerId: string
  /** owner instanceId（release 校验用） */
  readonly instanceId: string
  /** acquire 时刻 */
  readonly acquiredAt: number
}

/** nested operation 显式传递的 lock context */
export interface MutationLockContext {
  readonly token: MutationLockToken
}

/**
 * core/CLI/ModelTools 依赖的最小锁契约（与具体 EnvironmentLockManager 解耦，便于 mock 测试）。
 * 满足：acquire → 无 token 时获取全局锁；reuseLock → nested 复用（不 reacquire）。
 */
export interface MutationLockPort {
  /**
   * 尝试获取 GLOBAL mutation lock。
   * @param parentContext 若提供且有效（validate=true），表示调用链已持锁 → 复用，不 reacquire，恒返回 {state:'ACQUIRED', token: parentContext.token}
   * @returns 未持锁时走完整 acquire；被占 → LOCKED；stale/unknown → 对应状态（不自动删）
   */
  acquire(opts: {
    op: string
    target?: string
    /** nested：若有效父 token → 复用（不 reacquire），否则正常 acquire */
    parentContext?: MutationLockContext
  }): Promise<AcquireResult>

  /** 校验 token 是否有效且属于当前持有（nested reuse 判断用） */
  validate(token: unknown): token is MutationLockToken

  /** release（release 前校验 instanceId；mismatch 抛 EnvironmentLockOwnedByAnotherError） */
  release(token: MutationLockToken): Promise<void>
}

/**
 * 便捷包装：核心引擎「无父 token → acquire；有有效父 token → reuse（不 reacquire）」。
 * 返回 { token, context, release }：调用方在 finally 中调用 release（仅当本次真正 acquire 才 release）。
 * 若未提供 port（测试/无锁环境）→ 恒成功、不锁定（token=null、release = no-op）。
 *
 * @example
 * const { context, release } = await withMutationLock(ctx.mutationLock, { op: 'import', target })
 * if (!context) throw new Error('环境锁被占用')   // token===null 且真正需要锁 → 被挡
 * try { ...mutation...; await rollback(..., { lockContext: context }) } finally { await release() }
 */
/**
 * 便捷包装：核心/宿主「无父 token → acquire；有有效父 token → reuse（不 reacquire）」。
 * 返回 { context, release }：
 *  - context 非 null = 有锁（或已传入有效父 token 复用）；release 仅当**本次真正 acquire**才实际释放；
 *  - context null = 锁不可得（被挡）或未配置锁环境。
 * 调用方必须区分：port 未配置（无锁环境）→ context null 且可放行；port 已配置但 context null → 被挡必须拒绝。
 */
export async function withMutationLock(
  port: MutationLockPort | undefined,
  opts: { op: string; target?: string; parentContext?: MutationLockContext; isBlocked?: () => boolean },
): Promise<{ context: MutationLockContext | null; release(): Promise<void>; reason?: LockBlockReason }> {
  // Phase 3 SAFE MODE：注入谓词被挡 → 拒绝（generic blocked?，不识 policy/why）
  if (opts.isBlocked?.() === true) {
    return { context: null, release: async () => {}, reason: 'blocked' }
  }
  if (port === undefined) {
    // 无锁环境（mock/测试）：不锁定，调用方自行保证（返回 null + no-op release）
    return { context: null, release: async () => {} }
  }
  // —— 若已持有有效父 token：复用，不 reacquire，且 release = no-op（父负责最终释放）——
  if (opts.parentContext !== undefined && port.validate(opts.parentContext.token)) {
    return { context: opts.parentContext, release: async () => {} }
  }
  const res = await port.acquire({ op: opts.op, target: opts.target })
  if (res.state !== 'ACQUIRED' || res.token === null) {
    // 锁不可得：不放行。区分「被活跃任务占用」（LOCKED）与「锁不可用」（STALE/UNKNOWN/IO/PERM）
    // —— 只在 LOCKED 时向用户说「另一个任务在运行」，其余诚实说「暂无法执行」（不谎称在运行）。
    const reason: LockBlockReason = res.state === 'LOCKED' ? 'locked' : 'unavailable'
    return { context: null, release: async () => {}, reason }
  }
  const context: MutationLockContext = { token: res.token }
  let released = false
  return {
    context,
    release: async () => {
      if (released) return
      released = true
      await port.release(res.token!).catch(() => {})
    },
  }
}

/**
 * 直接执行式的 mutation 守卫：acquire（或复用父 token）→ 执行 → 释放。
 * - port 未配置（无锁环境/测试）→ 直接执行 fn(null)，不锁定。
 * - port 已配置但 acquire 失败 → **抛 EnvironmentLockUnavailableError**（destructive 不得执行）。
 * - 复用父 token 时（parentContext 有效）→ 不 reacquire、不释放父 token，fn 收到父 context。
 */
export async function runWithMutationLock<T>(
  port: MutationLockPort | undefined,
  opts: { op: string; target?: string; parentContext?: MutationLockContext; isBlocked?: () => boolean },
  fn: (ctx: MutationLockContext | null) => Promise<T>,
): Promise<T> {
  if (port === undefined) return fn(null)
  const { context, release, reason } = await withMutationLock(port, opts)
  if (context === null) {
    throw new EnvironmentLockUnavailableError(opts.op, reason ?? 'locked')
  }
  try {
    return await fn(context)
  } finally {
    await release()
  }
}

/** 判断某 state 是否意味着「未获得锁（被挡）」；ACQUIRED 才放行 destructive */
export function isAcquired(state: LockState): boolean {
  return state === 'ACQUIRED'
}

/** 一次 recover 的返回 */
export interface RecoverResult {
  ok: boolean
  /** 是否实际移除了 stale inode（ok=true 时为 true） */
  removed: boolean
  /** 判定：STALE_LOCK_DETECTED / UNKNOWN_STATE（拒绝）/ LOCKED（拒绝，owner healthy）/ LOCK_IO_ERROR / PERMISSION_ERROR */
  state: LockState
  /** 诊断 */
  detail?: string
}

export interface EnvLockManagerOptions {
  /** dataDir（缺省 ~/.dsh/dsh-config-manager）—— 锁在 <dataDir>/locks */
  dataDir?: string
  /** 覆盖绝对 locks 目录（测试/CLI 注入） */
  locksDir?: string
  /** 可注入 io */
  io?: EnvLockIo
  /** 可注入进程探测 */
  probe?: ProcessIdentityProbe
  /** 时钟（测试注入） */
  now?: () => number
  /** 心跳间隔 ms（缺省 1000） */
  heartbeatIntervalMs?: number
  /** stale 阈值 ms（缺省 10000） */
  staleAfterMs?: number
  /** acquire 等待活跃锁释放的超时 ms（缺省 0=不等待） */
  acquireTimeoutMs?: number
  /** 诊断用的当前 operation 描述（写入 ownership.op） */
  op?: string
  /** 诊断用的 target 描述 */
  target?: string
  /** 插件版本（写入 ownership.lockVersion） */
  lockVersion?: string
  /** heartbeat 续期写失败回调（留痕；不中断 mutation） */
  onHeartbeatWriteFailure?: (err: unknown) => void
}

/** 默认 io 实现 */
function defaultIo(): EnvLockIo {
  return {
    async mkdir(d, o) { await fs.mkdir(d, o) },
    async open(p, flag, mode) { return fs.open(p, flag as Parameters<typeof fs.open>[1], mode) as Promise<EnvLockHandle> },
    async rename(a, b) { return fs.rename(a, b) },
    async unlink(p) { return fs.unlink(p) },
    async stat(p) { try { return await fs.stat(p) } catch (e) { if (isENOENT(e)) return null; throw e } },
    async readFileText(p) { return (await fs.readFile(p, 'utf8')).toString() },
    async lstat(p) { try { return await fs.lstat(p) } catch (e) { if (isENOENT(e)) return null; throw e } },
  }
}

/** 默认进程探测（跨平台 best-effort；OS identity 能力由平台决定） */
function defaultProbe(): ProcessIdentityProbe {
  const selfOsIdentity = (() => {
    try {
      if (process.platform === 'linux') {
        // /proc/<pid>/stat 第 22 字段 = starttime（tick 数）
        const l = fssync.readFileSync(`/proc/${process.pid}/stat`, 'utf8').toString()
        const afterComm = l.slice(l.lastIndexOf(')') + 1).trim().split(/\s+/)
        // 格式: state ppid ... starttime：comm 后第一字段是 state，starttime 是第 22 个（index 21 起）
        return `linux:${afterComm[21] ?? 'unknown'}`
      }
      if (process.platform === 'darwin') return `darwin:${process.pid}:${Date.now()}` // 不可靠 → 保守返回占位
      if (process.platform === 'win32') {
        // Windows 无简单 /proc；best-effort 用 process 自身属性（不真验 PID reuse，交给 probe 标记能力）
        return null
      }
      return null
    } catch { return null }
  })()

  const canGetOsIdentity = (): boolean => {
    // Linux /proc 可靠；Windows/macOS 由 probe 运行时二次探测决定，这里保守：仅声明 Linux 能力
    return process.platform === 'linux'
  }

  const probe = async (pid: number): Promise<ProcessIdentity> => {
    let alive = false
    let aliveConfirmed = false
    try {
      process.kill(pid, 0)
      alive = true // 存在（或 EPERM 权限不足同样表示存在）
      aliveConfirmed = true
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ESRCH') {
        alive = false // 确证不存在
        aliveConfirmed = true
      } else if (code === 'EPERM') {
        alive = true // 存在但无信号权限 → 视为 alive
        aliveConfirmed = true
      } else {
        // 平台不支持 / 其它错误 → 探测失败（不确定），抛错由上层归为 UNKNOWN_STATE；
        // **绝不要**伪装成「确证死亡」——否则会把失败的探测当成 stale 删除许可。
        throw new Error(`进程探测失败 pid=${pid}: ${(e as Error)?.message ?? String(e)}`)
      }
    }
    if (!aliveConfirmed) {
      // 防御：理论上到不了这里
      throw new Error(`进程探测未确定 pid=${pid}`)
    }
    let osIdentity: string | null = null
    if (alive) {
      if (process.platform === 'linux') {
        try {
          const l = fssync.readFileSync(`/proc/${pid}/stat`, 'utf8').toString()
          const afterComm = l.slice(l.lastIndexOf(')') + 1).trim().split(/\s+/)
          osIdentity = `linux:${afterComm[21] ?? 'unknown'}`
        } catch { osIdentity = null }
      } else if (process.platform === 'win32') {
        // best-effort：Node 无法直接读其它进程 creation time；留给注入实现。这里返回 null = 无法验证。
        osIdentity = null
      } else if (process.platform === 'darwin') {
        osIdentity = null // 依赖 ps 的实现应由宿主注入；默认保守
      } else {
        osIdentity = null
      }
    }
    return { alive, osProcessStartIdentity: osIdentity }
  }

  return { probe, canGetOsIdentity }
}

function isENOENT(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
}

/** 解析 lock 文件 JSON，损坏/非法 → null */
function parseJsonSafe(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return null }
}

function randomHex(nBytes: number): string {
  return crypto.randomBytes(nBytes).toString('hex')
}

/**
 * EnvironmentLockManager：跨进程环境锁管理器。
 *
 * 用法：
 *   const mgr = new EnvironmentLockManager({ locksDir })
 *   const { state, token } = await mgr.acquire({ op: 'import' })
 *   if (state !== 'ACQUIRED') throw ...            // destructive 必须成功 acquire
 *   try { ...mutation... } finally { await mgr.release(token) }
 *   // nested rollback：mutation 内 rollback(..., { lockContext: { token } }) → reuse，不 reacquire
 */
export class EnvironmentLockManager {
  private readonly locksDir: string
  private readonly io: EnvLockIo
  private readonly probe: ProcessIdentityProbe
  private readonly now: () => number
  private readonly heartbeatIntervalMs: number
  private readonly staleAfterMs: number
  private readonly acquireTimeoutMs: number
  private readonly lockVersion: string
  private readonly onHeartbeatWriteFailure: (err: unknown) => void
  /** 诊断用（acquire 时写 ownership.op/target） */
  private readonly defaultOp: string
  private readonly defaultTarget: string
  /** 本 manager 唯一 id（forever token 校验用） */
  private readonly managerId: string
  /** 本 manager 持有的当前活跃 token（单锁单持有者） */
  private activeToken: MutationLockToken | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatSeq = 0
  private readonly activeInstanceId: string
  private heartbeatDegraded = false
  /** 瞬时错误（EBUSY 等）有界重试计数 */
  private transientRetries = 0
  private readonly maxTransientRetries = 5

  /** 有界瞬时重试：EBUSY（Windows sharing violation / 杀软）后小退避重试；超限则返回 false（交由 classify） */
  private async tryTransientRetry(kind: 'open' | 'unlink' | 'rename'): Promise<boolean> {
    if (this.transientRetries >= this.maxTransientRetries) {
      this.transientRetries = 0
      return false
    }
    this.transientRetries += 1
    await sleep(Math.max(this.heartbeatIntervalMs / 4, 20))
    return true
  }

  /** 重置瞬时重试计数（每次 acquire 成功/失败收敛时调用） */
  private resetTransientRetries(): void { this.transientRetries = 0 }

  constructor(opts: EnvLockManagerOptions = {}) {
    this.locksDir = opts.locksDir ?? path.join(opts.dataDir ?? path.join(os.homedir(), '.dsh', 'dsh-config-manager'), LOCKS_DIR)
    this.io = opts.io ?? defaultIo()
    this.probe = opts.probe ?? defaultProbe()
    this.now = opts.now ?? (() => Date.now())
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.lockVersion = opts.lockVersion ?? '0.1.0'
    this.onHeartbeatWriteFailure = opts.onHeartbeatWriteFailure ?? (() => {})
    this.defaultOp = opts.op ?? 'mutation'
    this.defaultTarget = opts.target ?? 'unknown'
    this.managerId = randomHex(16)
    this.activeInstanceId = randomHex(16)
  }

  get ownershipPath(): string { return path.join(this.locksDir, OWNERSHIP_FILE) }
  get locksDirectory(): string { return this.locksDir }

  /** 本 manager 是否当前持有锁（诊断用） */
  get isHolding(): boolean { return this.activeToken !== null }

  /* ------------------------------------------------------------ acquire */

  /**
   * 尝试获取 GLOBAL mutation lock。
   * - 成功 → state=ACQUIRED，返回 token（token 只属于当前调用链）。
   * - 被活跃 owner 持有 → LOCKED（可选等待 acquireTimeoutMs 后仍失败）。
   * - 确定 stale → STALE_LOCK_DETECTED（**不自动删除**；destructive 不得执行）。
   * - 其它 → UNKNOWN_STATE / LOCK_IO_ERROR / PERMISSION_ERROR。
   *
   * 所有权用 `open(ownershipPath, 'wx')` 独占创建；**绝不用 atomicWriteFile 获取所有权**。
   */
  async acquire(opts: { op?: string; target?: string } = {}): Promise<AcquireResult> {
    const op = opts.op ?? this.defaultOp
    const target = opts.target ?? this.defaultTarget
    const started = this.now()
    // 预取自身 OS identity（F3 修复）：在 open('wx') 之前完成异步探测，避免 open→writeFile 间隙内 await
    // （否则该间隙被杀会留下 0 字节 environment.lock → 永久 LOCKED）。探测失败降级为 null（不废掉合法 acquire）。
    const selfOsIdentity = this.probe.canGetOsIdentity()
      ? await this.probe.probe(process.pid).then((p) => p.osProcessStartIdentity).catch(() => null)
      : null
    for (;;) {
      // —— 先确保 locks 目录存在（mkdir 递归；EPERM 在下面归类为 PERMISSION_ERROR）——
      try {
        await this.io.mkdir(this.locksDir, { recursive: true })
      } catch (e) {
        return classifyIoError(e, `创建锁目录 ${this.locksDir}`, this.io)
      }

      // —— 独占创建所有权文件（唯一所有权获取原语）——
      let handle: EnvLockHandle | null = null
      try {
        handle = await this.io.open(this.ownershipPath, 'wx', 0o600)
      } catch (e) {
        const code = (e as { code?: string }).code
        // EBUSY：Windows sharing violation / 杀软 / 索引器瞬时占用 → 有界重试（Windows P2-3）
        if (code === 'EBUSY') {
          const transient = await this.tryTransientRetry('open')
          if (transient) continue
          return classifyIoError(e, `open('wx') ${this.ownershipPath}`, this.io)
        }
        if (code === 'EEXIST') {
          // 已存在 → inspect owner
          const inspect = await this.inspectLockState()
          if (inspect.state === 'LOCKED') {
            // 等 acquireTimeoutMs 后重试；超时则返回 LOCKED
            if (this.acquireTimeoutMs > 0 && this.now() - started < this.acquireTimeoutMs) {
              await sleep(this.heartbeatIntervalMs / 2)
              continue
            }
            return { state: 'LOCKED', token: null, detail: inspect.detail }
          }
          // STALE/UNKNOWN/IO 直接返回（不自动删除；destructive 不执行）
          return { state: inspect.state, token: null, detail: inspect.detail }
        }
        // EPERM/EACCES 等（Windows open('wx') 对存在文件常抛 EPERM 而非 EEXIST）：
        // 按 §8.1 分类 —— 先检查 environment.lock 是否确实存在且可读取；
        // 存在 → 按 existing lock inspect（可能正是活跃锁被 Windows 以 EPERM 拒绝）；
        // 不存在/无法确认 → LOCK_IO_ERROR / PERMISSION_ERROR（绝不误报「Locked/另一任务在运行」）。
        if (code === 'EPERM' || code === 'EACCES') {
          const exists = await this.statLockExists()
          if (exists === true) {
            const inspect = await this.inspectLockState()
            if (inspect.state === 'LOCKED' && this.acquireTimeoutMs > 0 && this.now() - started < this.acquireTimeoutMs) {
              await sleep(this.heartbeatIntervalMs / 2)
              continue
            }
            return { state: inspect.state, token: null, detail: inspect.detail }
          }
          // 无既有锁 → 权限/ACL/文件系统错误（可能目录不可写 / ACL 拒绝），非锁占用
          return exists === false
            ? { state: 'PERMISSION_ERROR', token: null, detail: `open('wx') ${this.ownershipPath}: 权限/ACL 错误 (${code})，且未发现既有锁文件` }
            : classifyIoError(e, `open('wx') ${this.ownershipPath}`, this.io)
        }
        return classifyIoError(e, `open('wx') ${this.ownershipPath}`, this.io)
      }

      // —— 独占创建成功：写入 immutable owner（一次性，之后不再替换）——
      try {
        const ownerRecord: LockOwnershipRecord = {
          schemaVersion: LOCK_SCHEMA_VERSION,
          owner: {
            instanceId: this.activeInstanceId,
            instanceStartedAt: Date.now(),
            pid: process.pid,
            hostname: os.hostname(),
            osProcessStartIdentity: selfOsIdentity,
          },
          op,
          target,
          acquiredAt: this.now(),
          lockVersion: this.lockVersion,
          journalId: null,
        }
        await handle.writeFile(encode(ownerRecord))
        await handle.sync()
        await handle.close()
        handle = null
      } catch (e) {
        // 写入 owner 失败：必须回滚 —— 关闭句柄 + 尽力删除刚创建的 lock（此刻所有权尚未确立，删除自己是安全的）
        if (handle) try { await handle.close() } catch { /* ignore */ }
        this.activeToken = null
        try { await this.io.unlink(this.ownershipPath) } catch { /* 清理失败留痕由上层 */ }
        return classifyIoError(e, `写入 owner ${this.ownershipPath}`, this.io)
      }

      // —— 确立 token + 启动 heartbeat ——
      const token: MutationLockToken = {
        tokenId: randomHex(16),
        managerId: this.managerId,
        instanceId: this.activeInstanceId,
        acquiredAt: this.now(),
      }
      this.activeToken = token
      this.heartbeatSeq = 0
      this.heartbeatDegraded = false
      this.startHeartbeat()
      return { state: 'ACQUIRED', token, detail: `op=${op}` }
    }
  }

  /* ------------------------------------------------------------ validate / release */

  /**
   * 校验 token 是否有效且属于当前持有（供 nested operation 判断能否 reuse）。
   * 返回 true = 该 token 授权本调用链 reuse 当前持有。
   */
  validate(token: unknown): token is MutationLockToken {
    const t = token as MutationLockToken | null | undefined
    if (t === null || t === undefined) return false
    if (this.activeToken === null) return false // 未持有
    if (t.managerId !== this.managerId) return false // foreign token
    if (t.tokenId !== this.activeToken.tokenId) return false // 非当前 token / 已 release
    // 显式 instanceId 三重匹配（P2-1 纵深防御：tokenId 唯一绑定 instanceId，此处显式断言防未来拆解）
    if (t.instanceId !== this.activeInstanceId) return false
    return true
  }

  /**
   * 释放锁：release 前**校验 ownership record 的 instanceId === token.instanceId**（以及 manager/tokenId）。
   * 匹配 → 清理 heartbeat + unlink ownership；不匹配 → **不 unlink**，记录 ownership-lost violation。
   *
   * 错误语义（F2 修复）：仅当磁盘 ownership 被确认成功删除后才清空 activeToken；unlink 失败/异常时
   * **保留 activeToken**（本调用链仍持有该 inode），允许调用方重试 release，绝不留下"令牌已失效但锁在磁盘上"的卡死态。
   */
  async release(token: MutationLockToken): Promise<void> {
    if (!this.validate(token)) {
      // 可能已 release 或 foreign：幂等返回（已 release 再次 release 无害）
      if (this.activeToken === null) return
      throw new EnvironmentLockOwnedByAnotherError('release: token 不匹配当前持有（foreign/已被接管），拒绝 unlink')
    }
    const instanceId = this.activeInstanceId
    this.stopHeartbeat()
    // —— release 前校验磁盘 ownership record 仍属于自己（防异常恢复/人工修改）——
    const st = await this.readOwnershipState()
    if (st.kind === 'missing') {
      // ownership 文件不存在：已被清除/尚未落盘 → 视为已释放；清 token + 尽力清 heartbeat
      this.heartbeatDegraded = false
      this.activeToken = null
      await this.cleanupHeartbeat(instanceId).catch(() => {})
      return
    }
    if (st.kind === 'corrupt') {
      // ownership 存在但损坏/不可读：无法确证属于自己 → ownership-lost，不 unlink（防误删他人/异常文件）
      this.heartbeatDegraded = false
      this.activeToken = null
      throw new EnvironmentLockOwnedByAnotherError(
        `release: 磁盘 ownership 无法读取/损坏（可能被异常恢复或人工修改），拒绝 unlink（ownership-lost）`,
      )
    }
    if (st.rec.owner.instanceId !== instanceId) {
      throw new EnvironmentLockOwnedByAnotherError(
        `release: 磁盘 ownership.instanceId=${st.rec.owner.instanceId} !== 本 token ${instanceId}（ownership-lost）`,
      )
    }
    // —— matching：unlink ——（acquire 成功后句柄已 close，此处只有 unlink）
    try {
      await this.io.unlink(this.ownershipPath)
    } catch (e) {
      // unlink 失败：**保留 activeToken**（仍持有该磁盘 inode），调用方可重试 release；
      // 绝不在此清空 token（否则锁卡死在磁盘而令牌失效）。
      throw new EnvironmentLockIOError(`release: unlink ${this.ownershipPath} 失败: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    // unlink 成功 → 释放完成：清 token + 清自己的 heartbeat sidecar
    this.heartbeatDegraded = false
    this.activeToken = null
    await this.cleanupHeartbeat(instanceId).catch(() => {})
  }

  /* ------------------------------------------------------------ heartbeat */

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => { void this.writeHeartbeat() }, Math.max(this.heartbeatIntervalMs, 50))
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
    // 立即写一次，确立初始 heartbeat（stale 窗口从此刻起）
    void this.writeHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 写 heartbeat sidecar（atomicWriteFile 更新 sidecar，不影响 ownership；失败 → degraded，不中断 mutation） */
  private async writeHeartbeat(): Promise<void> {
    if (this.activeToken === null) return
    const rec: HeartbeatRecord = {
      ownerInstanceId: this.activeInstanceId,
      heartbeatAt: this.now(),
      seq: ++this.heartbeatSeq,
    }
    const sbPath = path.join(this.locksDir, `${HEARTBEAT_PREFIX}${this.activeInstanceId}`)
    try {
      await atomicWriteFile(sbPath, encode(rec), { mode: 0o600 })
      this.heartbeatDegraded = false
    } catch (e) {
      this.heartbeatDegraded = true
      this.onHeartbeatWriteFailure(e)
    }
  }

  /** 删除指定 instanceId 的 heartbeat sidecar（不受 activeToken 状态影响——F1 修复；调用方传自己的 instanceId）。 */
  private async cleanupHeartbeat(instanceId: string): Promise<void> {
    const sbPath = path.join(this.locksDir, `${HEARTBEAT_PREFIX}${instanceId}`)
    try { await this.io.unlink(sbPath) } catch (e) { if (!isENOENT(e)) this.onHeartbeatWriteFailure(e) }
  }

  /* ------------------------------------------------------------ inspect / stale */

  /** 检查 environment.lock 是否确实存在（§8.1 分类用；stat 失败/无法确认 → null） */
  private async statLockExists(): Promise<boolean | null> {
    try {
      const st = await this.io.stat(this.ownershipPath)
      return st !== null
    } catch (e) {
      if (isENOENT(e)) return false
      return null // IO error 无法确认
    }
  }

  /** ownership 三态读取：missing（缺失）/ corrupt（存在但空或非法）/ ok（有效 owner）。
   *  用于区分「无锁」与「崩溃残留的 0 字节/损坏锁」——后者可被显式 recovery 安全回收（无有效 owner 无从误删）。 */
  private async readOwnershipState(): Promise<
    { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; rec: LockOwnershipRecord }
  > {
    let text: string
    try {
      text = await this.io.readFileText(this.ownershipPath)
    } catch (e) {
      if (isENOENT(e)) return { kind: 'missing' }
      // ACL 不可读（EACCES 等）→ 视为 corrupt-unknown（无法确证 owner），安全侧
      return { kind: 'corrupt' }
    }
    const parsed = parseJsonSafe(text) as LockOwnershipRecord | null
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== LOCK_SCHEMA_VERSION
      || typeof parsed.owner?.instanceId !== 'string') {
      return { kind: 'corrupt' }
    }
    return { kind: 'ok', rec: parsed }
  }

  /** 读取 owner instanceId 的 heartbeat sidecar（无 → null） */
  private async readHeartbeat(instanceId: string): Promise<HeartbeatRecord | null> {
    const sbPath = path.join(this.locksDir, `${HEARTBEAT_PREFIX}${instanceId}`)
    let text: string
    try { text = await this.io.readFileText(sbPath) } catch (e) { if (isENOENT(e)) return null; throw e }
    const parsed = parseJsonSafe(text) as HeartbeatRecord | null
    if (parsed === null || typeof parsed !== 'object' || parsed.ownerInstanceId !== instanceId) return null
    return parsed
  }

  /**
   * 判定锁状态（只分类）。按 Design §6.3 正式状态表：
   *  heartbeat fresh                    → LOCKED
   *  heartbeat expired + PID dead       → STALE_LOCK_DETECTED
   *  heartbeat expired + PID alive + identity 不同 → STALE_LOCK_DETECTED (PID reuse)
   *  heartbeat expired + PID alive + identity 相同 → LOCKED (owner alive / heartbeat degraded)
   *  probe 无法可靠确定                 → UNKNOWN_STATE
   */
  async inspectLockState(): Promise<{ state: LockState; detail?: string }> {
    const st = await this.readOwnershipState()
    if (st.kind === 'missing') {
      // 无所有权文件：可能在创建中，或已被清除 → 保守按"非空闲"处理
      return { state: 'LOCKED', detail: 'ownership file 不存在（可能正被创建中）' }
    }
    if (st.kind === 'corrupt') {
      // 存在但空/损坏/ACL 不可读：崩溃窗口残留（open('wx') 后未写完 owner 即死），无有效 owner
      // 无从误删；acquire 侧不执行（UNKNOWN_STATE），但显式 recovery 可安全回收（见 recoverStaleLock）
      return { state: 'UNKNOWN_STATE', detail: 'ownership 存在但无有效 owner（可能崩溃残留空/损坏文件），不删除、不执行；可用 --recover-stale-lock 回收' }
    }
    const rec = st.rec
    // heartbeat 读取失败（EACCES）→ 无法确认 fresh → 保守不判 stale（避免误删）
    let heartbeat: HeartbeatRecord | null = null
    try {
      heartbeat = await this.readHeartbeat(rec.owner.instanceId)
    } catch (e) {
      const code = (e as { code?: string }).code
      return code === 'EACCES' || code === 'EPERM'
        ? { state: 'UNKNOWN_STATE', detail: '无法读取 heartbeat（权限/ACL），保守拒绝' }
        : { state: 'UNKNOWN_STATE', detail: 'heartbeat 读取失败，保守拒绝' }
    }
    const now = this.now()
    const heartbeatFresh = heartbeat !== null && (now - heartbeat.heartbeatAt) <= this.staleAfterMs

    if (heartbeatFresh) {
      return { state: 'LOCKED', detail: `owner op=${rec.op} pid=${rec.owner.pid} (heartbeat fresh)` }
    }

    // heartbeat 已过期：先探测 PID liveness（kill(pid,0) 跨平台可靠；ESRCH = 确证不存在）
    let ident: ProcessIdentity
    try {
      ident = await this.probe.probe(rec.owner.pid)
    } catch {
      return { state: 'UNKNOWN_STATE', detail: `进程探测失败 pid=${rec.owner.pid}` }
    }
    // 确证死亡（ESRCH）→ STALE（不依赖 OS identity 能力）
    if (!ident.alive) {
      return { state: 'STALE_LOCK_DETECTED', detail: `owner pid=${rec.owner.pid} 确证不存在 (heartbeat expired)` }
    }
    // PID 存活：需 OS identity 区分「reuse」与「同一进程 alive（heartbeat degraded）」
    // —— capability/值缺失 → 无法可靠确定 → UNKNOWN_STATE（保守拒删）
    if (!this.probe.canGetOsIdentity() || rec.owner.osProcessStartIdentity === null || ident.osProcessStartIdentity === null) {
      return {
        state: 'UNKNOWN_STATE',
        detail: `heartbeat 过期且 pid=${rec.owner.pid} 存活，但无法可靠取得 OS process identity，保守拒绝删除`,
      }
    }
    if (rec.owner.osProcessStartIdentity !== ident.osProcessStartIdentity) {
      return { state: 'STALE_LOCK_DETECTED', detail: `pid reuse：pid=${rec.owner.pid} identity 与 recorded 不同` }
    }
    // alive 且 identity 相同 → owner alive（heartbeat degraded 保护）
    return { state: 'LOCKED', detail: 'owner 进程存活（heartbeat 可能 degraded），非 stale' }
  }

  /* ------------------------------------------------------------ recover (explicit) */

  /**
   * 显式 stale recovery（独立动作；对应 CLI `--recover-stale-lock`）。
   * 只执行：inspect → prove definitely stale → 原子 rename 捕获 → 二次验证 → unlink。
   * **不自动触发**；仅当检测为 STALE_LOCK_DETECTED 才允许 capture。
   * 二次验证失败 → quarantine（保留 recovering 文件，不 rename 回环境锁，不覆盖 successor）。
   */
  async recoverStaleLock(): Promise<RecoverResult> {
    // 1. inspect：必须 definitely stale 或 corrupt（崩溃残留无有效 owner）
    const insp = await this.inspectLockState()
    const isCorruptReclaim = insp.state === 'UNKNOWN_STATE' && insp.detail?.includes('无有效 owner')
    if (insp.state !== 'STALE_LOCK_DETECTED' && !isCorruptReclaim) {
      return { ok: false, removed: false, state: insp.state, detail: insp.detail ?? '非 stale，拒绝 recovery' }
    }
    const st = await this.readOwnershipState()
    const rec = st.kind === 'ok' ? st.rec : null
    if (st.kind === 'missing') {
      return { ok: false, removed: false, state: 'LOCKED', detail: 'ownership 已消失（被他人接管/清除），停止 recovery' }
    }
    // 2. 原子 rename 捕获当前 inode
    const recoveringPath = path.join(this.locksDir, `${RECOVERING_PREFIX}${randomHex(8)}`)
    try {
      await this.io.rename(this.ownershipPath, recoveringPath)
    } catch (e) {
      return { ok: false, removed: false, state: classifyIoError(e, `rename ${this.ownershipPath} → ${recoveringPath}`, this.io).state, detail: '捕获 rename 失败（可能被他人接管），停止' }
    }
    // 3. 二次验证：captured 内容仍是被判 stale 的那个 owner
    let capturedText: string
    try {
      capturedText = await this.io.readFileText(recoveringPath)
    } catch (e) {
      // 读不到 captured（异常）→ quarantine，不 rename 回
      return { ok: false, removed: false, state: 'LOCK_IO_ERROR', detail: '捕获文件读取失败，保留 recovering 供诊断' }
    }
    const captured = parseJsonSafe(capturedText) as LockOwnershipRecord | null
    if (isCorruptReclaim) {
      // corrupt 回收：captured 无有效 owner（无 instanceId 可校验）→ 只确认它仍是非缺省非法内容 → unlink
      // （captured 若已变成有效 owner，即 successor 在 rename 后才出现于 ownershipPath，与此 recovering 无涉）
      if (captured !== null && typeof captured === 'object' && typeof captured.owner?.instanceId === 'string') {
        // captured 突然变得有效（异常：rename 后被人写入）→ 保守 quarantine，不删
        return {
          ok: false, removed: false, state: 'UNKNOWN_STATE',
          detail: `corrupt 回收二次验证异常：captured 具有效 owner，保留 ${path.basename(recoveringPath)} quarantine；不覆盖当前 environment.lock`,
        }
      }
    } else {
      // 有效 owner 的 stale 回收：校验 captured.instanceId 与 rec.instanceId 一致 + 二次 prove dead
      const reProbeDead = await this.reProveStale(rec as LockOwnershipRecord)
      if (captured === null || typeof captured !== 'object'
        || captured.owner?.instanceId !== (rec as LockOwnershipRecord).owner.instanceId || !reProbeDead) {
        // 二次验证失败 → quarantine：不 rename 回 environment.lock（防覆盖 successor），保留 recovering 文件
        return {
          ok: false, removed: false, state: 'UNKNOWN_STATE',
          detail: `二次验证失败：保留 ${path.basename(recoveringPath)} quarantine；不覆盖当前 environment.lock（若有 successor）`,
        }
      }
    }
    // 4. 验证通过 → unlink captured
    try {
      await this.io.unlink(recoveringPath)
    } catch (e) {
      return { ok: false, removed: false, state: classifyIoError(e, `unlink ${recoveringPath}`, this.io).state, detail: '删除 captured 失败' }
    }
    // 5. 清理该 owner 的 heartbeat sidecar（按 stale instanceId 匹配；corrupt 时 rec=null 跳过）
    if (rec !== null) {
      try {
        const sbPath = path.join(this.locksDir, `${HEARTBEAT_PREFIX}${(rec as LockOwnershipRecord).owner.instanceId}`)
        await this.io.unlink(sbPath).catch(() => {})
      } catch { /* 尽力 */ }
    }
    return {
      ok: true, removed: true, state: 'STALE_LOCK_DETECTED',
      detail: rec !== null ? `已移除 stale ownership (op=${(rec as LockOwnershipRecord).op}, pid=${(rec as LockOwnershipRecord).owner.pid})` : '已移除 corrupt/崩溃残留所有权文件',
    }
  }

  /** recovery 二次验证：重新探测 recorded pid 是否确证死亡（保守——任何不确定性 → 失败）。
   *  与 inspectLockState 同一套语义：alive:false 仅确证死亡 → stale 成立；
   *  alive 则需 OS identity 判断是否 reuse；无法确定 → 保守失败（不删除）。 */
  private async reProveStale(rec: LockOwnershipRecord): Promise<boolean> {
    let ident: ProcessIdentity
    try { ident = await this.probe.probe(rec.owner.pid) } catch { return false }
    // 确证死亡（ESRCH，alive:false 仅此语义）→ stale 成立
    if (!ident.alive) return true
    // 存活：需 identity 判断 reuse；无法可靠取得 → 保守失败
    if (!this.probe.canGetOsIdentity() || rec.owner.osProcessStartIdentity === null || ident.osProcessStartIdentity === null) return false
    // recorded identity 与探测不同 → PID reuse → 原 owner 已死 → stale 成立
    if (rec.owner.osProcessStartIdentity !== ident.osProcessStartIdentity) return true
    // 同一进程仍存活 → 非 stale
    return false
  }

  /* ------------------------------------------------------------ diag */

  /** 列出 locks 目录内容（诊断；不存在 → 空） */
  async listLockFiles(): Promise<string[]> {
    try {
      const dirs = await (this.io.listLocksDir ? this.io.listLocksDir(this.locksDir) : Promise.resolve([]))
      return dirs
    } catch { return [] }
  }
}

// listLocksDir 可选增强：listLockFiles 使用 io.listLocksDir（若未提供 → 空数组）

function encode(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 按 §8.1 把 open/io 错误分类为 LockState（EEXIST 已在 acquire 单独处理） */
function classifyIoError(e: unknown, what: string, io: EnvLockIo): { state: LockState; token: null; detail: string } {
  const code = (e as { code?: string }).code
  if (code === 'EACCES' || code === 'EPERM') {
    return { state: 'PERMISSION_ERROR', token: null, detail: `${what}: 权限/ACL 错误 (${code})，非锁占用` }
  }
  return { state: 'LOCK_IO_ERROR', token: null, detail: `${what}: ${e instanceof Error ? e.message : String(e)}` }
}

/** 当 release/recover 发现 ownership 已不属于本 token（异常恢复/人工修改）时抛出 */
export class EnvironmentLockOwnedByAnotherError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'EnvironmentLockOwnedByAnotherError'
  }
}

/** release 时 IO 失败（unlink/读 ownership）抛出；保留 activeToken 以便调用方重试 release */
export class EnvironmentLockIOError extends Error {
  readonly underlyingCause: unknown
  constructor(msg: string, underlying?: unknown) {
    super(msg)
    this.name = 'EnvironmentLockIOError'
    this.underlyingCause = underlying
  }
}

/** 锁被挡时向用户呈现的分类（用户可读文案据此选择，绝不暴露环境锁/op/路径等内部细节）。 */
export type LockBlockReason =
  /** 被另一进程/任务活跃持有（LOCKED → 「另一个任务正在运行，请稍后重试」） */
  | 'locked'
  /** Phase 3 SAFE MODE 注入谓词阻断（isBlocked → 「配置修改已被保护，请先处理恢复事项」） */
  | 'blocked'
  /** 锁不可用/IO/权限/UNKNOWN/STALE（→ 「操作暂时无法执行，请稍后重试」） */
  | 'unavailable'

/** 按分类生成用户可读的友好文案（内部诊断不进入此文案；op/reason 作为字段供日志使用）。 */
const LOCK_BLOCK_MESSAGE: Record<LockBlockReason, string> = {
  locked: '另一个任务正在运行，请稍后重试。',
  blocked: '配置修改已被保护，请先处理恢复事项后再继续。',
  unavailable: '操作暂时无法执行，请稍后重试；若持续失败请查看日志。',
}

/** destructive 必须成功获取 Environment Lock；否则抛此错（被另一进程/操作持有，或锁不可用）。
 *  携带 op 与 reason 供内部日志诊断；.message 恒为用户可读的友好文案（不暴露锁/op/路径）。 */
export class EnvironmentLockUnavailableError extends Error {
  readonly reason: LockBlockReason
  readonly op: string
  constructor(op: string, reason: LockBlockReason = 'locked') {
    super(LOCK_BLOCK_MESSAGE[reason])
    this.name = 'EnvironmentLockUnavailableError'
    this.reason = reason
    this.op = op
  }
}

/** 便捷：以 token 授权当前持有（供 nested operation 判断复用）—— 等价于 manager.validate 的纯函数形态 */
export function isTokenValid(manager: EnvironmentLockManager, ctx: MutationLockContext | undefined): ctx is MutationLockContext {
  return ctx !== undefined && typeof ctx === 'object' && manager.validate(ctx.token)
}
