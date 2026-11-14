/**
 * 写动作的三道门（SAFE MODE → 残留环境锁 → DSH 未运行），CLI 与救急台网页共用同一实现。
 *
 * 为什么单独成文件：门的判据必须唯一（网页不许自己重写判定），而它依赖的只读事实在
 * control-state.ts；从 1600 行的 actions.ts 里拆出来后，调用点仍经 actions.ts 的 re-export 取用。
 */
import fssync from 'node:fs'
import path from 'node:path'

import { OWNERSHIP_FILE } from '../utils/env-lock.ts'
import { readLockState, readRunningInstances, readSafeMode } from './control-state.ts'


export type WriteRefusalCode =
  | 'safe-mode'
  | 'stale-lock'
  | 'dsh-running'
  | 'nothing-to-do'
  | 'io-error'

/**
 * SAFE MODE 拒因码的**单点常量**：`src/cli/index.ts` 的源码守卫（P0-11-07）禁止
 * CLI 自带 `'safe-mode'` 字面量，判据必须复用本常量（否则改一处漏一处）。
 */
export const SAFE_MODE_REFUSAL_CODE: WriteRefusalCode = 'safe-mode'

export interface WriteGateRefusal {
  ok: false
  code: WriteRefusalCode
  /** 用户可读原因（页面直接展示） */
  reason: string
  /**
   * 拒因的结构化明细（页面据此给出「怎么解除」的可操作指引，而不是只丢一句 reason）。
   *
   * 为什么要有：`dsh-running` 是最常被撞到的一道门，光给「请先关闭 DSH」用户会问
   * 「关哪个、怎么确认关掉了」。这里把**是谁在跑**（心跳台账里的 profile/pid/端口）
   * 如实带出来 —— 只读事实，不猜、不代关进程。
   */
  detail?: {
    kind: 'dsh-running' | 'stale-lock' | 'safe-mode'
    /** 正在运行的实例（心跳合并视图：本插件启动的 + 手动启动的） */
    instances?: Array<{ name: string; pid: number; port: number | null }>
    /** 环境锁状态（kind = 'stale-lock'） */
    lock?: { state: string; locksDir: string }
    /** SAFE MODE 标记文件（kind = 'safe-mode'） */
    markers?: string[]
    /** 与 CLI 逐字同源的等价命令（可复制去终端跑） */
    commands: string[]
  }
}

export type WriteGateOutcome = { ok: true } | WriteGateRefusal

/**
 * 从控制面候选根派生**环境锁目录**（`<root>/locks`）。
 *
 * 为什么由根派生而不是让每个调用点多传一个参数：`checkWriteGates` 的 `locksDir` 是**可选**的，
 * 「少传一个参数」就静默退化成「不查环境锁」。审计 P11-4 正是这么漏掉的：就地修复（repairSessionLogInline）
 * 不传 locksDir，残留/被持有的环境锁存在时照样改写 `.zstd` 会话字节。
 * 派生顺序与 `resolveControlRoots` 同源：第一个真实持有 `locks/environment.lock` 的候选根；
 * 都没有就退回首个候选的 `locks`（读不到即视为无锁，判据仍只由 readLockState 给）。
 */
export function locksDirFromControlRoots(controlRoots: readonly string[]): string | undefined {
  const first = controlRoots[0]
  if (first === undefined) return undefined
  for (const root of controlRoots) {
    const candidate = path.join(root, 'locks')
    if (fssync.existsSync(path.join(candidate, OWNERSHIP_FILE))) return candidate
  }
  return path.join(first, 'locks')
}

/**
 * 写动作的前置门（与 CLI `sessions repair --fix` 同一判据）。
 *
 * `needsDshStopped`：**改写/搬动会话字节**的动作（会话布局归位 repairSessions、字节级就地修复
 * repairSessionLogInline）与**快照恢复**（runSnapshotRestore 会覆盖/删除 `$DSH_HOME` 下正在使用的文件）
 * 都要「DSH 已停」这一条；磁盘清理不需要（只碰可重建缓存）。
 */
export async function checkWriteGates(
  controlRoots: readonly string[],
  options: { needsDshStopped: boolean; locksDir?: string } = { needsDshStopped: true },
): Promise<WriteGateOutcome> {
  for (const report of readSafeMode(controlRoots)) {
    if (report.state === 'blocked') {
      return {
        ok: false,
        code: 'safe-mode',
        reason: 'SAFE MODE 已激活（存在未结案的配置 transaction）：先处理恢复事项再改磁盘。标记：' + report.marker,
      }
    }
    if (report.state === 'unknown') {
      return {
        ok: false,
        code: 'safe-mode',
        reason: 'SAFE MODE 标记无法判定（按最保守口径处理）：先人工核对标记文件。路径：' + report.marker,
      }
    }
  }
  /**
   * ② 环境锁：**存在锁就必须先处理**。
   *
   * 为什么不能跳过：CLI 侧 destructive 入口（restore/reinstall）都要求成功获取 GLOBAL 环境锁，
   * 而残留锁（STALE_LOCK_DETECTED）正是「上次异常退出、别的操作也被挡着」的状态；
   * 这时改磁盘等于在一个已知不一致的状态上继续写。判据与 `recover-stale-lock` 同源（inspectLockState），
   * 所以**不给自动回收**，只如实拒绝并把出口指出来。
   */
  // 环境锁目录**不再由调用点决定是否检查**（审计 P11-10）：locksDir 曾经是可选参数，
  // 「少传一个」就静默退化成「不查环境锁」——5 个调用点因此排出 3 种组合、实漏 2 处。
  // 现在缺省一律由控制面根派生（与 locksDirFromControlRoots 同源），调用点只在
  // 「锁目录确实不在 <root>/locks」时才需要显式覆盖。
  const locksDir = options.locksDir ?? locksDirFromControlRoots(controlRoots)
  if (locksDir !== undefined) {
    const lock = await readLockState(locksDir)
    if (lock.present) {
      const stale = lock.state === 'STALE_LOCK_DETECTED'
      return {
        ok: false,
        code: 'stale-lock',
        reason: (stale
          ? '检测到残留的环境锁（持有进程已被确证不存在）：先回收它再执行写动作。'
          : '环境锁被持有或状态无法判定（' + lock.state + '）：先确认没有其它操作在跑，再执行写动作。')
          + '锁目录：' + lock.locksDir + '；出口：dsh-config-manager recover-stale-lock（本机救急台的「环境锁」页也可回收）。',
      }
    }
  }
  if (options.needsDshStopped) {
    const running = await readRunningInstances(controlRoots)
    if (running.length > 0) {
      return {
        ok: false,
        code: 'dsh-running',
        reason: '检测到 DSH 正在运行（' + running.map((i) => i.name + ' pid=' + String(i.pid)).join('、')
          + '）：请先关闭 DSH 再改写会话字节。',
        detail: {
          kind: 'dsh-running',
          instances: running.map((i) => ({ name: i.name, pid: i.pid, port: i.port })),
          commands: [
            // 桌面端独占档案不让普通 CLI 停，如实给出「关窗口」这条唯一通道（见 AGENTS.md 的 desktop 条）
            ...running.filter((i) => i.name === 'desktop').map(() => '桌面端（desktop）：直接关闭 DSH 桌面窗口；它不接受命令行停止'),
            ...running.filter((i) => i.name !== 'desktop').map((i) => 'dsh-config-manager stop ' + i.name + '  # 或在「档案与实例」页点「停止 ' + i.name + '」'),
            'dsh-config-manager web  # 停完再回本页点「重新检查」',
          ],
        },
      }
    }
  }
  return { ok: true }
}
