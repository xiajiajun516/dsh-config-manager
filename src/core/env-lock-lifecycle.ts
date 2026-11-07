/**
 * 环境锁的**生命周期自愈**（与 acquire/release 语义分开，避免污染 env-lock.ts 的核心不变量）。
 *
 * 三件事：
 *  ① 启动时回收「结构性可证」的 stale 残留锁（owner 确证死亡 / PID 复用），并把交给 SAFE MODE 判定的
 *    锁状态按回收结果修正；
 *  ② 启动时清掉孤儿心跳 sidecar（已不是持有者、心跳也早已停更的垃圾）；
 *  ③ 进程退出时**同步**释放本实例持有的锁（'exit' 里不能 await，所以必须同步 fs）；
 *  ④ 装配宿主用的 manager 实例，并把「心跳写失败 / 释放失败」接到日志（以前全静默）。
 *
 * 为什么只在分类 NORMAL 时做 ①②：RECOVERY_REQUIRED / NEEDS_ATTENTION 意味着有未决事务，此时删掉
 * ownership 等于替用户抹掉事故现场（journal↔ownership binding 也会失去对照证据）——那类必须显式恢复。
 * 为什么不碰 corrupt 残留与「心跳长过期」启发式：`reclaimProvableStaleLock` 只认结构性可证；
 * 其余留给显式回收（`--recover-stale-lock` / GUI 事故恢复），否则在拿不到 OS identity 的机器上会误删活锁。
 *
 * 真机成因与量化数据 → `docs/evidence/recovery-console.md`；规则 → `AGENTS.md`「备份 / 恢复 / 回滚点」。
 */
import { EnvironmentLockManager } from '../utils/env-lock.ts'
import type { LockState } from '../utils/env-lock.ts'
import { mapLockStateForStartup } from './phase3-host.ts'
import { utilsMsg } from '../utils/messages-utils.ts'

/** 交给 `resolveStartupSafeMode` 的锁状态口径（与 `mapLockStateForStartup` 同一来源，不另立枚举）。 */
export type StartupLockState = ReturnType<typeof mapLockStateForStartup>

/** 只要求 info/warn（宿主 logger 结构兼容；测试用假 logger 即可）。 */
export interface LockLifecycleLog {
  info(message: string): void
  warn(message: string): void
}

/** 自愈只碰这三个动作，不把整个 manager 传进来（也就无法顺手 acquire/validate）。 */
type LockLifecyclePort = Pick<EnvironmentLockManager, 'reclaimProvableStaleLock' | 'cleanupOrphanHeartbeats' | 'releaseOnExitSync'>

/**
 * 启动自愈：回收可证 stale 残留锁 + 清孤儿心跳，返回应当交给 SAFE MODE 判定的锁状态。
 *
 * 回收成功后返回 `'FREE'`：否则「无活锁者」的陈旧标记不会被一并复位，本会话的写操作会继续被 423 挡着
 * （界面却说没有待处理事项）。回收被拒（证明不出已死）时原样返回，只记一条 warn。
 */
export async function reclaimStaleLockAtStartup(input: {
  kind: string
  inspected: LockState
  lock: LockLifecyclePort
  log: LockLifecycleLog
}): Promise<StartupLockState> {
  let lockState = mapLockStateForStartup(input.inspected)
  if (input.kind === 'NORMAL' && input.inspected === 'STALE_LOCK_DETECTED') {
    const reclaimed = await input.lock.reclaimProvableStaleLock().catch(() => null)
    if (reclaimed !== null && reclaimed.ok) {
      lockState = 'FREE'
      input.log.info(utilsMsg('utils.envLock.autoReclaimedStale', {
        op: reclaimed.removedOwner?.op ?? 'unknown',
        pid: reclaimed.removedOwner?.pid ?? 0,
      }))
    } else if (reclaimed !== null) {
      input.log.warn(`残留锁自动回收被拒（保留现场，走显式回收）：${reclaimed.detail ?? ''}`)
    }
  }
  if (input.kind === 'NORMAL') {
    const orphaned = await input.lock.cleanupOrphanHeartbeats().catch(() => 0)
    if (orphaned > 0) input.log.info(utilsMsg('utils.envLock.orphanHeartbeatsRemoved', { count: orphaned }))
  }
  return lockState
}

/**
 * 建宿主用的 mutation lock 实例，并给两类**以前全静默**的失败接上日志：
 * 心跳写失败落到 noop、释放失败被调用方 `release().catch(() => {})` 吞掉 ——
 * 真机表现就是「锁留在盘上、没有任何人知道为什么」，直到所有 destructive 操作恒被 423 挡住
 * （2026-11-07 档案删除卡在「另一个任务正在运行」即此形状）。
 * 这里只留痕，不做恢复动作：恢复一律走显式入口（事故恢复 / CLI），与 ①② 同一口径。
 */
export function createHostMutationLock(input: {
  dataDir: string
  lockVersion: string
  log: Pick<LockLifecycleLog, 'warn'>
}): EnvironmentLockManager {
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  return new EnvironmentLockManager({
    dataDir: input.dataDir,
    op: 'config-manager',
    target: 'global-mutation',
    lockVersion: input.lockVersion,
    onHeartbeatWriteFailure: (err) => input.log.warn(utilsMsg('utils.envLock.heartbeatWriteFailed', { reason: reason(err) })),
    onReleaseFailure: ({ err, quarantined }) =>
      input.log.warn(
        quarantined
          ? utilsMsg('utils.envLock.releaseFailedQuarantined', { reason: reason(err) })
          : utilsMsg('utils.envLock.releaseFailedStuck', { reason: reason(err) }),
      ),
  })
}

/**
 * 生成退出释放钩子：只删**本实例 instanceId** 的 ownership 与心跳（与 `release()` 同一不变量），永不抛。
 * 调用方负责 `process.once('exit', fn)` 与 dispose 时摘钩。
 */
export function createExitLockReleaser(lock: Pick<EnvironmentLockManager, 'releaseOnExitSync'>): () => void {
  return () => {
    try { lock.releaseOnExitSync() } catch { /* 退出路径不许抛 */ }
  }
}
