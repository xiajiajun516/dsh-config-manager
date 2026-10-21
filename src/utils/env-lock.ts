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
 *  - PID 复用判据**优先**用 OS process creation identity（linux `/proc`、win32 `Get-Process` StartTime、
 *    macOS `ps`）；拿不到才退回「心跳长过期」启发式（issue #36）。
 *  - recover 是独立显式动作（CLI `--recover-stale-lock`），用原子 rename 捕获 + 二次验证，二次验证失败不覆盖 successor。
 *  - destructive mutation 无 `--force`：必须成功 acquire，否则不得执行。
 *  - release 前校验 owner.instanceId === token.instanceId，不匹配不 unlink（ownership-lost）。
 *
 * 零 DSH 依赖（仅 node:fs / node:path / node:os / node:crypto + 复用 atomic-write.ts 的 atomicWriteFile）。
 * CLI 离线引擎可复用。io / 时钟 / 进程身份探测可注入（对齐 Phase 1 AtomicIo 模式）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { atomicWriteFile } from './atomic-write.ts'
import { isENOENT } from './guards.ts'
import { utilsMsg } from './messages-utils.ts'

// ---------- 常量 ----------

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
/** 「心跳长过期」下限 ms（issue #36）。实际阈值 = max(30 × staleAfterMs, 本值)。
 *  用途：Windows/macOS 默认拿不到 OS process identity，Windows 又会复用 PID，于是
 *  「心跳过期 + pid 存活」永远停在 UNKNOWN_STATE，用户只能手工删锁文件（issue #36 实测）。
 *  心跳长过期说明写方早已停摆 → 允许**显式**回收判为残留锁；acquire 侧仍绝不自动摘锁。 */
export const DEFAULT_LONG_EXPIRED_AFTER_MS = 30 * 60_000
/** acquire 中「EEXIST 但 ownership 读不到」的竞态重试上限（issue #79）：文件在两次读取之间
 *  被释放时重试 open('wx') 即可拿到锁，不在锁间隙里空等 acquireTimeoutMs。 */
const MAX_FREE_RETRIES = 5

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
  /**
   * 无锁：ownership 文件确实不存在（issue #79）。
   *
   * 此前这一态被保守归入 LOCKED（「可能在创建中」），于是 recovery/status 会在**根本没有锁**时
   * 回报 LOCKED —— 用户照着面板去找一个不存在的锁（真机反馈：自测 acquire/release 都正常，
   * 面板却一直显示 LOCKED）。真正需要保守的是 **acquire**（见 acquire 的 FREE 重试分支），
   * 而不是对用户的**报告**：「没看到锁」就如实说没有。
   */
  | 'FREE'
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
): Promise<{ context: MutationLockContext | null; release(): Promise<void>; reason?: LockBlockReason; detail?: string }> {
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
    // stale 单独成类（issue #27）：残留锁「重试/重启都不会好」，必须显式回收——
    // 若与别的不可用原因共用「请稍后重试」文案，用户会一直等到放弃（实测反馈即如此）。
    const reason: LockBlockReason = res.state === 'LOCKED'
      ? 'locked'
      : res.state === 'STALE_LOCK_DETECTED'
        ? 'stale'
        : 'unavailable'
    return { context: null, release: async () => {}, reason, detail: res.detail }
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
  // t69：判定一律走 withMutationLock（它**第一步**就问 isBlocked?.()），不再对 port===undefined 短路。
  // 修前那一行 `if (port === undefined) return fn(null)` 让「未注入锁端口」直接绕过 SAFE MODE 判定 ⇒
  // 阻断态下仍放行写操作（fail-open）：生产恒注入端口（src/index.ts:3680）故当前不可达，但语义必须与
  // 「阻断态 fail-closed、动态探测」的既有口径一致 —— **未注入端口 ≠ 允许在阻断态下写**。
  const { context, release, reason, detail } = await withMutationLock(port, opts)
  if (context === null) {
    // 无锁环境（未注入端口）且**未阻断**：照旧不锁定、直接执行（无端口不是「不得执行」）。
    if (port === undefined && reason === undefined) return fn(null)
    throw new EnvironmentLockUnavailableError(opts.op, reason ?? 'locked', detail)
  }
  try {
    return await fn(context)
  } finally {
    await release()
  }
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

/**
 * heartbeat 定时器注入面（缺省 = 全局 setInterval/clearInterval）。
 * 测试注入手动 tick 的假定时器后，心跳推进**完全确定**（不依赖墙钟/事件循环负载），
 * 断言可写成「tick 后读到的值」而不是「等 N 毫秒后猜测」。
 */
export interface LockTimerApi {
  /** 返回值即句柄（真实实现是 Timeout；测试实现可是任意对象） */
  setInterval(fn: () => void | Promise<void>, ms: number): unknown
  clearInterval(handle: unknown): void
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
  /** 「心跳长过期」阈值 ms（issue #36；缺省 max(30 × staleAfterMs, 30 分钟)）。
   *  只影响「pid 存活但进程身份不可验证」这一类锁的**显式**回收与状态分类，不放松自动侧。 */
  longExpiredAfterMs?: number
  /** 诊断用的当前 operation 描述（写入 ownership.op） */
  op?: string
  /** 诊断用的 target 描述 */
  target?: string
  /** 插件版本（写入 ownership.lockVersion） */
  lockVersion?: string
  /** heartbeat 续期写失败回调（留痕；不中断 mutation） */
  onHeartbeatWriteFailure?: (err: unknown) => void
  /** heartbeat 定时器（测试可注入手动 tick 的假定时器；缺省用全局定时器） */
  timers?: LockTimerApi
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

/** 默认 heartbeat 定时器实现（全局定时器；unref 由调用方按句柄能力决定） */
const defaultTimers: LockTimerApi = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>) },
}

/** 外部命令执行器（测试注入用）：只取 stdout；失败/超时抛错。 */
export type IdentityCommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>

/** 平台进程身份探测的可注入依赖（缺省 = 真实平台实现）。 */
export interface ProcessIdentityProbeOptions {
  /** 平台（缺省 process.platform；测试注入以覆盖 win32/darwin 分支） */
  platform?: NodeJS.Platform
  /** 外部命令执行器（缺省 child_process.execFile；仅 win32/darwin 有查询命令） */
  runCommand?: IdentityCommandRunner
  /** 自身进程 pid（缺省 process.pid；测试注入） */
  selfPid?: number
}

/**
 * identity 查询超时（ms）。宁可在超时后**拿不到** identity（自动退回「心跳长过期」启发式判据），
 * 也不能让一次探测拖住 mutation —— 查询只发生在「锁文件已存在且心跳已过期」的少数路径上。
 */
const IDENTITY_QUERY_TIMEOUT_MS = 3_000

/** 缺省命令执行器：execFile + 超时 + windowsHide（避免 Windows 上短暂弹出控制台窗口）。 */
function defaultRunCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (err, stdout) => { if (err) reject(err); else resolve(stdout) },
    )
  })
}

/**
 * win32 进程创建时间查询：`Get-Process` 的 `StartTime.ToFileTimeUtc()`（100ns 精度 FileTime）。
 * 说明：Node 无原生 API 读**其它进程**的创建时间，只能经系统命令；这是本文件唯一的外部命令依赖，
 * 且自身身份被**进程内缓存**（见 createPlatformProcessIdentityProbe）后不再每次 acquire 重复 spawn。
 */
function win32IdentityQuery(pid: number): { file: string; args: string[] } {
  return {
    file: 'powershell.exe',
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [string]$p.StartTime.ToFileTimeUtc() }`,
    ],
  }
}

/** darwin 进程创建时间查询：`ps -o lstart=` 给出进程启动的墙钟串。 */
function darwinIdentityQuery(pid: number): { file: string; args: string[] } {
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] }
}

/** 把命令输出规整成 identity 串；空/非法 → null（绝不把垃圾当身份参与比较）。 */
function normaliseIdentityOut(platform: NodeJS.Platform, stdout: string): string | null {
  const t = stdout.trim()
  if (t === '') return null
  if (platform === 'win32') return /^\d+$/.test(t) ? `win32:${t}` : null
  return `posix:${t}`
}

/**
 * 解析 Linux `/proc/<pid>/stat` 的 starttime（进程创建时刻，单位 ticks）。
 *
 * stat 的格式是 `pid (comm) state ppid …`，而 **comm 可以包含空格与括号**（可执行文件名 / 线程名），
 * 所以必须先切掉 `(comm)`：字段 1=pid、2=comm、3=state … 22=starttime。以最后一个 `)` 之后的空白
 * 分隔数组下标 k 对应字段 k+3，因此 starttime = 下标 **19**。
 * （取 21 会拿到 rss —— 那是个随内存占用变化的值，同一个进程两次探测都能不同：CI 上实测因此
 * 把活着的 owner 判成「PID 被复用」的残留锁，见本函数被抽出来的原因。）
 *
 * 取不到（没有括号 / 字段不足 / 非数字）→ null。**绝不**退回一个恒定假身份 —— 那会把不同进程
 * 判成同一个 owner，比拿不到身份危险得多。
 */
export function parseLinuxProcessStarttime(statText: string): string | null {
  const close = statText.lastIndexOf(')')
  if (close < 0) return null
  const fields = statText.slice(close + 1).trim().split(/\s+/)
  const starttime = fields[19]
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : null
}

/**
 * 平台进程身份探测（默认实现；issue #36 的精确判据）：
 *  - linux：读 `/proc/<pid>/stat` 的 starttime（第 22 字段）——不 spawn 任何进程；
 *  - win32：`Get-Process` 的 `StartTime.ToFileTimeUtc()`；
 *  - darwin：`ps -o lstart=`；
 *  - 其它平台：`canGetOsIdentity()` = false（退回「心跳长过期」启发式判据）。
 *
 * 代价（known-gaps G-15 的「代价不可接受」正是要解决的点）：自身进程的创建时间在进程生命周期内
 * **不变** → 命中一次即缓存（成功与失败都缓存：探测能力是环境属性），于是每次 acquire 不再 spawn shell；
 * 对**别的** pid 的探测只发生在「锁文件存在且心跳已过期」的少数路径上（心跳新鲜时先返回 LOCKED，不探测）。
 *
 * 失败语义：查询失败/超时/命令缺失 → **identity = null**，绝不抛错 —— 抛错会把分类推成 UNKNOWN_STATE，
 * 反而让 issue #36 里「长过期可显式回收」这条路径失效。identity = null 时上层自动退回长过期启发式。
 */
export function createPlatformProcessIdentityProbe(opts: ProcessIdentityProbeOptions = {}): ProcessIdentityProbe {
  const platform = opts.platform ?? process.platform
  const selfPid = opts.selfPid ?? process.pid
  const runCommand = opts.runCommand ?? defaultRunCommand
  /** 自身进程身份缓存（见上：成功/失败都缓存，避免每次 acquire spawn 一次 shell） */
  let selfResolved = false
  let selfIdentity: string | null = null

  const queryIdentity = async (pid: number): Promise<string | null> => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const cmd = platform === 'win32'
      ? win32IdentityQuery(pid)
      : platform === 'darwin'
        ? darwinIdentityQuery(pid)
        : null
    if (cmd === null) return null
    try {
      return normaliseIdentityOut(platform, await runCommand(cmd.file, cmd.args, IDENTITY_QUERY_TIMEOUT_MS))
    } catch {
      return null
    }
  }

  const canGetOsIdentity = (): boolean =>
    platform === 'linux' || platform === 'win32' || platform === 'darwin'

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
        throw new Error(utilsMsg('utils.envLock.probeFailed', { pid, reason: (e as Error)?.message ?? String(e) }))
      }
    }
    if (!aliveConfirmed) {
      // 防御：理论上到不了这里
      throw new Error(utilsMsg('utils.envLock.probeUndetermined', { pid }))
    }
    if (!alive) return { alive, osProcessStartIdentity: null }
    if (platform === 'linux') {
      try {
        const starttime = parseLinuxProcessStarttime(fssync.readFileSync(`/proc/${pid}/stat`, 'utf8').toString())
        return { alive, osProcessStartIdentity: starttime === null ? null : `linux:${starttime}` }
      } catch {
        return { alive, osProcessStartIdentity: null }
      }
    }
    if (pid === selfPid) {
      if (!selfResolved) {
        selfIdentity = await queryIdentity(pid)
        selfResolved = true
      }
      return { alive, osProcessStartIdentity: selfIdentity }
    }
    return { alive, osProcessStartIdentity: await queryIdentity(pid) }
  }

  return { probe, canGetOsIdentity }
}

/** 默认进程探测（跨平台 best-effort；OS identity 能力由平台决定） */
function defaultProbe(): ProcessIdentityProbe {
  return createPlatformProcessIdentityProbe()
}

/**
 * 解析 lock 文件 JSON，损坏/非法 → null。
 *
 * 名字里带 lock：它与 `utils/json.ts` 的 `parseJsonSafe`（深度/体积上限、超限抛
 * `JsonDepthError`）**语义不同** —— 这里是「损坏即 null」，不得合并成同一个函数。
 */
function readLockJsonSafe(text: string): unknown {
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
  private readonly longExpiredAfterMs: number
  private readonly acquireTimeoutMs: number
  private readonly lockVersion: string
  private readonly onHeartbeatWriteFailure: (err: unknown) => void
  /** 诊断用（acquire 时写 ownership.op/target） */
  private readonly defaultOp: string
  private readonly defaultTarget: string
  /** 本 manager 唯一 id（forever token 校验用） */
  private readonly managerId: string
  /** heartbeat 定时器注入面（缺省全局定时器） */
  private readonly timers: LockTimerApi
  /** 本 manager 持有的当前活跃 token（单锁单持有者） */
  private activeToken: MutationLockToken | null = null
  /** heartbeat 定时器句柄（注入面返回值，类型未知 → 用 null 判「未启动」） */
  private heartbeatTimer: unknown = null
  private heartbeatSeq = 0
  private readonly activeInstanceId: string
  /** 串行化的 heartbeat 写链（**最后一次写**的 promise）；release 前用于 drain，见 drainHeartbeat */
  private pendingHeartbeat: Promise<void> = Promise.resolve()
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

  constructor(opts: EnvLockManagerOptions = {}) {
    this.locksDir = opts.locksDir ?? path.join(opts.dataDir ?? path.join(os.homedir(), '.dsh', 'dsh-config-manager'), LOCKS_DIR)
    this.io = opts.io ?? defaultIo()
    this.probe = opts.probe ?? defaultProbe()
    this.now = opts.now ?? (() => Date.now())
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    // issue #36：阈值取「30 倍 stale 窗口」与「30 分钟」的较大者——活着的 owner 连续 30 分钟
    // 一次心跳都写不进去只可能是 ACL/磁盘级别的异常；而残留锁的用户等 9 天都等不到自愈。
    this.longExpiredAfterMs = opts.longExpiredAfterMs ?? Math.max(this.staleAfterMs * 30, DEFAULT_LONG_EXPIRED_AFTER_MS)
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.lockVersion = opts.lockVersion ?? '0.1.0'
    this.onHeartbeatWriteFailure = opts.onHeartbeatWriteFailure ?? (() => {})
    this.timers = opts.timers ?? defaultTimers
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
    /** 「EEXIST/EPERM 说文件在，inspect 却读不到」= 文件在两次读取之间被释放的竞态（issue #79） */
    let freeRetries = 0
    for (;;) {
      // —— 先确保 locks 目录存在（mkdir 递归；EPERM 在下面归类为 PERMISSION_ERROR）——
      try {
        await this.io.mkdir(this.locksDir, { recursive: true })
      } catch (e) {
        return classifyIoError(e, utilsMsg('utils.envLock.mkdirLocksDir', { dir: this.locksDir }), this.io)
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
          // issue #79：EEXIST 与「ownership 读不到」同时出现 = 上一次占用的释放竞态。
          // 此前直接判 LOCKED，一次无害的竞态就变成「另一个任务正在运行」并可能被记成
          // mutation-locked（真机：连续 16 次跳过，用户侧看不出原因）。重试 open('wx') 即可。
          if (inspect.state === 'FREE' && freeRetries < MAX_FREE_RETRIES) {
            freeRetries += 1
            continue
          }
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
            // 同 EEXIST 分支：文件刚被释放的竞态 → 重试独占创建（不是「被占用」）
            if (inspect.state === 'FREE' && freeRetries < MAX_FREE_RETRIES) {
              freeRetries += 1
              continue
            }
            if (inspect.state === 'LOCKED' && this.acquireTimeoutMs > 0 && this.now() - started < this.acquireTimeoutMs) {
              await sleep(this.heartbeatIntervalMs / 2)
              continue
            }
            return { state: inspect.state, token: null, detail: inspect.detail }
          }
          // 无既有锁 → 权限/ACL/文件系统错误（可能目录不可写 / ACL 拒绝），非锁占用
          return exists === false
            ? { state: 'PERMISSION_ERROR', token: null, detail: utilsMsg('utils.envLock.openWxPermissionNoExisting', { path: this.ownershipPath, code }) }
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
        return classifyIoError(e, utilsMsg('utils.envLock.writeOwner', { path: this.ownershipPath }), this.io)
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
      throw new EnvironmentLockOwnedByAnotherError(utilsMsg('utils.envLock.releaseForeignToken'))
    }
    const instanceId = this.activeInstanceId
    this.stopHeartbeat()
    // —— release 前校验磁盘 ownership record 仍属于自己（防异常恢复/人工修改）——
    const st = await this.readOwnershipState()
    if (st.kind === 'missing') {
      // ownership 文件不存在：已被清除/尚未落盘 → 视为已释放；清 token + 尽力清 heartbeat
      // 先清 token（writeHeartbeat 的「不再写」闸门）再 drain，最后清理 sidecar（同成功路径的顺序理由）
      this.activeToken = null
      await this.drainHeartbeat()
      await this.cleanupHeartbeat(instanceId).catch(() => {})
      return
    }
    if (st.kind === 'corrupt') {
      // ownership 存在但损坏/不可读：无法确证属于自己 → ownership-lost，不 unlink（防误删他人/异常文件）
      this.activeToken = null
      // 与成功路径同序：先清 token（「不再写」闸门）再 drain，保证在途原子写（tmp→rename）在本方法返回前落地，
      // 不留给调用方的目录清理（Windows 上即 rmSync ENOTEMPTY / .dshcm.*.tmp 残留）。
      await this.drainHeartbeat()
      throw new EnvironmentLockOwnedByAnotherError(utilsMsg('utils.envLock.releaseOwnershipUnreadable'))
    }
    if (st.rec.owner.instanceId !== instanceId) {
      // 保留 activeToken（调用方可能修复 ownership 后重试 release），但**必须 drain 在途写**：
      // 定时器已在方法开头 stopHeartbeat()，故此刻起不会再排入新写，drain 有界且确定。
      // 不 drain 则已启动的 tmp→rename 会在本方法抛出**之后**落盘，与调用方的目录清理竞争
      // （本仓库实测：紧接 release 的 rmSync(dir) 在 200 次循环里约 19% 抛 ENOTEMPTY）。
      await this.drainHeartbeat()
      throw new EnvironmentLockOwnedByAnotherError(
        utilsMsg('utils.envLock.releaseOwnershipMismatch', { diskId: st.rec.owner.instanceId, tokenId: instanceId }),
      )
    }
    // —— matching：unlink ——（acquire 成功后句柄已 close，此处只有 unlink）
    try {
      await this.io.unlink(this.ownershipPath)
    } catch (e) {
      // unlink 失败：**保留 activeToken**（仍持有该磁盘 inode），调用方可重试 release；
      // 绝不在此清空 token（否则锁卡死在磁盘而令牌失效）。
      // 同 ownership-lost 分支：抛错前 drain 在途写（定时器已停 → drain 有界），
      // 否则调用方随后的目录清理会与已启动的 tmp→rename 竞争。
      await this.drainHeartbeat()
      throw new EnvironmentLockIOError(utilsMsg('utils.envLock.releaseUnlinkFailed', { path: this.ownershipPath, reason: e instanceof Error ? e.message : String(e) }), e)
    }
    // unlink 成功 → 释放完成：**先清 token 再 drain**，最后清自己的 heartbeat sidecar。
    // 顺序关键：activeToken=null 必须早于 drain —— 否则 interval 可能在 drain 返回之后、cleanup 之前
    // 再排入一次写并真正落盘，把刚删掉的 sidecar 复活（writeHeartbeat 以 activeToken===null 作为「不再写」的闸门）。
    // 本仓库实测：顺序颠倒时 L3 回归用例可稳定复现 sidecar 复活（该用例正是捕获了这一点）。
    this.activeToken = null
    await this.drainHeartbeat()
    await this.cleanupHeartbeat(instanceId).catch(() => {})
  }

  /* ------------------------------------------------------------ heartbeat */

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return
    // 回调**返回**写链 promise（不再 `void` 吞掉）：注入的假定时器据此 await 一次 tick 的落盘，
    // 使心跳推进在测试里完全确定（全局定时器下返回值被忽略，行为不变）。
    this.heartbeatTimer = this.timers.setInterval(() => this.trackHeartbeat(), Math.max(this.heartbeatIntervalMs, 50))
    const handle = this.heartbeatTimer as { unref?: () => void } | null | undefined
    if (handle !== null && handle !== undefined && typeof handle.unref === 'function') handle.unref()
    // 立即写一次，确立初始 heartbeat（stale 窗口从此刻起）——走 trackHeartbeat 纳入可 drain 的串行链：
    // 否则这个 fire-and-forget 的写可能在 release 清理 sidecar 之后才落盘，把 sidecar 重新创建（或残留 .dshcm.*.tmp），
    // 在 Windows 上即表现为目录清理竞态（after-hook rmSync ENOTEMPTY）。
    this.trackHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 等待**当前在途**的 heartbeat 写完成（不改变持有状态、不停定时器）。
   * 首写在 startHeartbeat() 中**同步**入链，故 acquire() 之后调用本方法必然等到首写落盘。
   *
   * 语义边界（本文件只保留这一套 drain，勿再引入第二套）：
   *  - 本方法 = **只等**：给「某次心跳必须已落盘」当确定性前提（测试的 waitHeartbeat / c6 / c9 / c10）。
   *  - `stopHeartbeatAndDrain()` = **停定时器再等**：收尾静止（测试 after-hook 删目录前）。
   *  - `release()` 内部复用同一个私有 `drainHeartbeat()`，且**每一条**退出路径（含各类抛错分支）都先 drain。
   */
  async flushHeartbeat(): Promise<void> {
    await this.drainHeartbeat()
  }

  /**
   * **收尾静止**：停掉 heartbeat 定时器并等待在途写结束。返回后本 manager 不会再产生任何文件写入，
   * 调用方可安全删除 locks 目录（`rmSync(recursive)` 不会在遍历途中被新写入打断 ——
   * 这正是 Windows 上 after-hook ENOTEMPTY 的根因）。不 unlink ownership/sidecar：
   * 锁的持有状态与磁盘内容由调用方的 release 决定。
   */
  async stopHeartbeatAndDrain(): Promise<void> {
    this.stopHeartbeat()
    await this.drainHeartbeat()
  }

  /**
   * 等待**当前在途**的 heartbeat 写完成（release 清理 sidecar 前必须调用）。
   * 为什么必要：writeHeartbeat 走 atomicWriteFile（tmp 写入 → rename），是异步多步操作。
   * 若 release 只 stopHeartbeat + unlink sidecar 而不等待，一个已启动的写会在 unlink 之后才 rename，
   * 于是把刚删掉的 sidecar **重新创建**（或残留 .dshcm.*.tmp）——Windows 上即 after-hook rmSync ENOTEMPTY。
   * 调用点保证：release 开头**先同步 stopHeartbeat()**，其后任何时候都不会再排入新写，drain 因而有界且确定。
   * 因此 release 的**每一条**退出路径都必须先 drain 再返回/抛出（成功、ownership missing、corrupt、
   * instanceId 不匹配、unlink 失败）—— 漏掉任何一条，已启动的 tmp→rename 都会在 release 返回后落盘，
   * 与调用方的目录清理竞争（Windows 实测：after-hook rmSync ENOTEMPTY / .dshcm.*.tmp 残留；
   * 被漏掉的正是 ownership-lost 分支，200 次循环约 19% 复现）。置 activeToken=null 的路径仍须
   * **先清 token 再 drain**，否则 interval 可在 drain 返回后、cleanup 前再排入一次写，把刚删的 sidecar 复活。
   */
  private async drainHeartbeat(): Promise<void> {
    try { await this.pendingHeartbeat } catch { /* writeHeartbeat 自身已吞错；此处仅防御 */ }
  }

  /** 串行化并追踪一次 heartbeat 写：chain 保证不会有两个写并发 rename 同一个 sidecar */
  private trackHeartbeat(): Promise<void> {
    this.pendingHeartbeat = this.pendingHeartbeat.then(() => this.writeHeartbeat())
    return this.pendingHeartbeat
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
    } catch (e) {
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
    const parsed = readLockJsonSafe(text) as LockOwnershipRecord | null
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
    const parsed = readLockJsonSafe(text) as HeartbeatRecord | null
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
  async inspectLockState(): Promise<{ state: LockState; detail?: string; corruptOwnership?: boolean; ownerInstanceId?: string }> {
    const st = await this.readOwnershipState()
    if (st.kind === 'missing') {
      // 无所有权文件：可能在创建中、也已被清除 —— **报告**层如实说「没有锁」（issue #79）。
      // acquire 侧不据此放行：它会重试 open('wx')（见 acquire 的 FREE 分支），
      // 真正拿到所有权才继续，所以这里放宽不会让任何写动作绕过锁。
      return { state: 'FREE', detail: utilsMsg('utils.envLock.ownershipMissing') }
    }
    if (st.kind === 'corrupt') {
      // 存在但空/损坏/ACL 不可读：崩溃窗口残留（open('wx') 后未写完 owner 即死），无有效 owner
      // 无从误删；acquire 侧不执行（UNKNOWN_STATE），但显式 recovery 可安全回收（见 recoverStaleLock）
      return { state: 'UNKNOWN_STATE', corruptOwnership: true, detail: utilsMsg('utils.envLock.ownershipCorrupt') }
    }
    const rec = st.rec
    // heartbeat 读取失败（EACCES）→ 无法确认 fresh → 保守不判 stale（避免误删）
    let heartbeat: HeartbeatRecord | null = null
    try {
      heartbeat = await this.readHeartbeat(rec.owner.instanceId)
    } catch (e) {
      const code = (e as { code?: string }).code
      return code === 'EACCES' || code === 'EPERM'
        ? { state: 'UNKNOWN_STATE', detail: utilsMsg('utils.envLock.heartbeatPermissionDenied') }
        : { state: 'UNKNOWN_STATE', detail: utilsMsg('utils.envLock.heartbeatReadFailed') }
    }
    const now = this.now()
    const heartbeatFresh = heartbeat !== null && (now - heartbeat.heartbeatAt) <= this.staleAfterMs

    if (heartbeatFresh) {
      // ownerInstanceId 供**宿主内部**做 journal↔锁归属匹配（recovery status 的 in-flight 判定）。
      // 它不是诊断文案：绝不进 HTTP 响应体（编排器只消费，不回传）。
      return { state: 'LOCKED', ownerInstanceId: rec.owner.instanceId, detail: `owner op=${rec.op} pid=${rec.owner.pid} (heartbeat fresh)` }
    }

    // heartbeat 已过期：先探测 PID liveness（kill(pid,0) 跨平台可靠；ESRCH = 确证不存在）
    let ident: ProcessIdentity
    try {
      ident = await this.probe.probe(rec.owner.pid)
    } catch {
      return { state: 'UNKNOWN_STATE', detail: utilsMsg('utils.envLock.probeFailedShort', { pid: rec.owner.pid }) }
    }
    // 确证死亡（ESRCH）→ STALE（不依赖 OS identity 能力）
    if (!ident.alive) {
      return { state: 'STALE_LOCK_DETECTED', ownerInstanceId: rec.owner.instanceId, detail: utilsMsg('utils.envLock.ownerConfirmedDead', { pid: rec.owner.pid }) }
    }
    // PID 存活：需 OS identity 区分「reuse」与「同一进程 alive（heartbeat degraded）」
    // —— capability/值缺失 → 无法可靠确定 → UNKNOWN_STATE（保守拒删）
    if (!this.probe.canGetOsIdentity() || rec.owner.osProcessStartIdentity === null || ident.osProcessStartIdentity === null) {
      // issue #36：Windows 默认无 OS identity 能力 + PID 会被复用 → 该分支此前永远停在
      // UNKNOWN_STATE（连官方 recover-stale-lock 都拒绝），用户只能手工删锁文件。
      // 心跳**长过期**（远超窗口，见 longExpiredAfterMs）说明写方早已停摆，判定为残留锁：
      // 只影响显式回收与状态分类，acquire 侧依旧不自动摘锁。
      const longExpired = this.longExpiredReason(heartbeat, now)
      if (longExpired !== null) {
        return {
          state: 'STALE_LOCK_DETECTED',
          ownerInstanceId: rec.owner.instanceId,
          detail: utilsMsg('utils.envLock.ownerAliveUnverifiable', { pid: rec.owner.pid, longExpired }),
        }
      }
      return {
        state: 'UNKNOWN_STATE',
        detail: utilsMsg('utils.envLock.heartbeatExpiredNoIdentity', { pid: rec.owner.pid }),
      }
    }
    if (rec.owner.osProcessStartIdentity !== ident.osProcessStartIdentity) {
      return { state: 'STALE_LOCK_DETECTED', ownerInstanceId: rec.owner.instanceId, detail: utilsMsg('utils.envLock.pidReuse', { pid: rec.owner.pid }) }
    }
    // alive 且 identity 相同 → owner alive（heartbeat degraded 保护）
    return { state: 'LOCKED', ownerInstanceId: rec.owner.instanceId, detail: utilsMsg('utils.envLock.ownerAliveDegraded') }
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
    const st = await this.readOwnershipState()
    // 「无有效 owner」的崩溃残留（ownership 文件损坏/空）可显式回收。
    // 判据必须是**结构性的**（inspectLockState 的 corruptOwnership / readOwnershipState 的 kind）——
    // **不得**再依赖 detail 文案子串：detail 自 t5 起按界面语言本地化，按子串判定在英文界面下会失效。
    const isCorruptReclaim = insp.state === 'UNKNOWN_STATE' && st.kind === 'corrupt'
    if (insp.state !== 'STALE_LOCK_DETECTED' && !isCorruptReclaim) {
      return { ok: false, removed: false, state: insp.state, detail: insp.detail ?? utilsMsg('utils.envLock.notStaleRefuseRecovery') }
    }
    const rec = st.kind === 'ok' ? st.rec : null
    if (st.kind === 'missing') {
      // 竞态：inspect 之后锁被释放 → 本来就没有可回收对象，如实报 FREE（issue #79；此前报 LOCKED）
      return { ok: false, removed: false, state: 'FREE', detail: utilsMsg('utils.envLock.ownershipGone') }
    }
    // 2. 原子 rename 捕获当前 inode
    const recoveringPath = path.join(this.locksDir, `${RECOVERING_PREFIX}${randomHex(8)}`)
    try {
      await this.io.rename(this.ownershipPath, recoveringPath)
    } catch (e) {
      return { ok: false, removed: false, state: classifyIoError(e, `rename ${this.ownershipPath} → ${recoveringPath}`, this.io).state, detail: utilsMsg('utils.envLock.captureRenameFailed') }
    }
    // 3. 二次验证：captured 内容仍是被判 stale 的那个 owner
    let capturedText: string
    try {
      capturedText = await this.io.readFileText(recoveringPath)
    } catch (e) {
      // 读不到 captured（异常）→ quarantine，不 rename 回
      return { ok: false, removed: false, state: 'LOCK_IO_ERROR', detail: utilsMsg('utils.envLock.captureReadFailed') }
    }
    const captured = readLockJsonSafe(capturedText) as LockOwnershipRecord | null
    if (isCorruptReclaim) {
      // corrupt 回收：captured 无有效 owner（无 instanceId 可校验）→ 只确认它仍是非缺省非法内容 → unlink
      // （captured 若已变成有效 owner，即 successor 在 rename 后才出现于 ownershipPath，与此 recovering 无涉）
      if (captured !== null && typeof captured === 'object' && typeof captured.owner?.instanceId === 'string') {
        // captured 突然变得有效（异常：rename 后被人写入）→ 保守 quarantine，不删
        return {
          ok: false, removed: false, state: 'UNKNOWN_STATE',
          detail: utilsMsg('utils.envLock.corruptReclaimAnomaly', { name: path.basename(recoveringPath) }),
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
          detail: utilsMsg('utils.envLock.reverifyFailed', { name: path.basename(recoveringPath) }),
        }
      }
    }
    // 4. 验证通过 → unlink captured
    try {
      await this.io.unlink(recoveringPath)
    } catch (e) {
      return { ok: false, removed: false, state: classifyIoError(e, `unlink ${recoveringPath}`, this.io).state, detail: utilsMsg('utils.envLock.removeCapturedFailed') }
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
      detail: rec !== null
        ? utilsMsg('utils.envLock.removedStaleOwnership', { op: (rec as LockOwnershipRecord).op, pid: (rec as LockOwnershipRecord).owner.pid })
        : utilsMsg('utils.envLock.removedCorruptOwnership'),
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
    if (!this.probe.canGetOsIdentity() || rec.owner.osProcessStartIdentity === null || ident.osProcessStartIdentity === null) {
      // issue #36：必须与 inspectLockState 用**同一**判据。否则首次判定「可回收」、二次验证却
      // 判「非 stale」→ quarantine，用户拿到的仍是「二次验证失败」，等于没修。
      const hb = await this.readHeartbeat(rec.owner.instanceId).catch(() => null)
      return this.longExpiredReason(hb, this.now()) !== null
    }
    // recorded identity 与探测不同 → PID reuse → 原 owner 已死 → stale 成立
    if (rec.owner.osProcessStartIdentity !== ident.osProcessStartIdentity) return true
    // 同一进程仍存活 → 非 stale
    return false
  }

  /** 心跳「长过期」判据（issue #36）：达到阈值 → 返回可读原因，否则 null。
   *  heartbeat sidecar 缺失时返回 null（无从判断过期时长）——只对「确实读过 heartbeat
   *  且它早已停更」的锁放宽，避免把「sidecar 被清掉」误判成残留。 */
  private longExpiredReason(heartbeat: HeartbeatRecord | null, now: number): string | null {
    if (heartbeat === null) return null
    const age = now - heartbeat.heartbeatAt
    if (!(age >= this.longExpiredAfterMs)) return null // NaN / 负值（时钟回拨）→ 保守
    return utilsMsg('utils.envLock.longExpired', { age: formatDuration(age), threshold: formatDuration(this.longExpiredAfterMs) })
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

/** 毫秒 → 可读时长（诊断文案用；不追求精确，只求用户能一眼判断「多久没心跳了」） */
function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return utilsMsg('utils.envLock.durationDays', { value: (ms / 86_400_000).toFixed(1) })
  if (ms >= 3_600_000) return utilsMsg('utils.envLock.durationHours', { value: (ms / 3_600_000).toFixed(1) })
  if (ms >= 60_000) return utilsMsg('utils.envLock.durationMinutes', { value: Math.round(ms / 60_000) })
  return utilsMsg('utils.envLock.durationSeconds', { value: Math.round(ms / 1000) })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 按 §8.1 把 open/io 错误分类为 LockState（EEXIST 已在 acquire 单独处理） */
function classifyIoError(e: unknown, what: string, io: EnvLockIo): { state: LockState; token: null; detail: string } {
  const code = (e as { code?: string }).code
  if (code === 'EACCES' || code === 'EPERM') {
    return { state: 'PERMISSION_ERROR', token: null, detail: utilsMsg('utils.envLock.ioPermissionNotLock', { what, code }) }
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
  /**
   * 检测到 stale 残留锁（上次进程异常退出，持有者已确证死亡）——**重试不会自愈**，
   * 必须显式回收（GUI「事故恢复」/ CLI `recover-stale-lock`）。见 issue #27。
   */
  | 'stale'
  /** 锁不可用/IO/权限/UNKNOWN（→ 「操作暂时无法执行，请稍后重试」） */
  | 'unavailable'

/** 按分类生成用户可读的友好文案（内部诊断不进入此文案；op/reason 作为字段供日志使用）。
 *  导出：后台调度器（自动同步/定时备份）被挡时用同一份文案写日志，避免两处文案漂移。 */
export const LOCK_BLOCK_MESSAGE: Record<LockBlockReason, string> = {
  // getter 形态：**取文案的那一刻**才解析语言（写成模块级常量会像改造前的宿主 msg 一样，
  // 被冻结在模块加载时那门语言 —— 用户切到 English 后仍是中文）。
  get locked() { return utilsMsg('utils.envLock.block.locked') },
  get blocked() { return utilsMsg('utils.envLock.block.blocked') },
  get unavailable() { return utilsMsg('utils.envLock.block.unavailable') },
  // 必须说清「重试/重启都不会好」并给出可操作路径：否则用户只会一遍遍重试（issue #27 实测如此）。
  // issue #31：文案承诺的「事故恢复」入口必须真的能回收残留锁——GUI 已接线
  // （GET /recovery/status 的 lock 字段 + POST /recovery/lock/recover），两处入口都真实可达。
  get stale() { return utilsMsg('utils.envLock.block.stale') },
}

/** 分类的**简短**文案（单行、可用于表格单元格/迁移历史摘要/日志前缀）。
 *  与 LOCK_BLOCK_MESSAGE 同源同分类：长文案给「需要完整指引」的场景（423 响应/告警日志），
 *  短文案给「一行放不下长句」的场景。分开定义避免任一处再自造文案（issue #31 的漂移根因）。 */
export const LOCK_BLOCK_BRIEF: Record<LockBlockReason, string> = {
  // 同 LOCK_BLOCK_MESSAGE：getter 形态保证「取文案时才解析语言」。
  get locked() { return utilsMsg('utils.envLock.brief.locked') },
  get blocked() { return utilsMsg('utils.envLock.brief.blocked') },
  get unavailable() { return utilsMsg('utils.envLock.brief.unavailable') },
  // stale 必须点出「残留」——否则用户会像 issue #31 那样等 9 天（57 次静默跳过）。
  get stale() { return utilsMsg('utils.envLock.brief.stale') },
}

/** destructive 必须成功获取 Environment Lock；否则抛此错（被另一进程/操作持有，或锁不可用）。
 *  携带 op 与 reason 供内部日志诊断；.message 恒为用户可读的友好文案（不暴露锁/op/路径）。 */
export class EnvironmentLockUnavailableError extends Error {
  readonly reason: LockBlockReason
  readonly op: string
  /**
   * 内部诊断（非敏感）：占用方 op/hostname 或 stale 判定依据。**只进日志**，
   * 绝不进入 .message（用户文案里不含 op/路径/主机名）。
   */
  readonly detail: string | undefined
  constructor(op: string, reason: LockBlockReason = 'locked', detail?: string) {
    super(LOCK_BLOCK_MESSAGE[reason])
    this.name = 'EnvironmentLockUnavailableError'
    this.reason = reason
    this.op = op
    this.detail = detail
  }
}

