/**
 * 进程控制内核单测：终止结果的三态（graceful / killed / failed）与**强杀后的有限等待**。
 *
 * 钉住审计 P11-3：Windows 上 `taskkill /F` 返回 ≠ 进程已消失（TerminateProcess 只投递请求），
 * 旧实现在强杀后**立刻**回查一次，把「正在消失」误判成 failed —— 调用方（launcher / runtime）
 * 据此抛 stopFailed 并保留心跳，UI 说「停不掉」，而进程其实已经没了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_FORCE_EXIT_WAIT_MS, resolveProcessControl, stopPid,
} from './process-control.ts'

/** 虚拟时钟 + 可编排存活的进程控制器（sleep 只推进时钟，不真等待） */
function fixture(opts: {
  graceMs?: number
  forceWaitMs?: number
  /** 收到 force 后经过多少毫秒才消失（null = 永远不死） */
  diesAfterForceMs?: number | null
  /** 优雅期是否自己退出 */
  diesOnGraceful?: boolean
}) {
  let clock = 1_000_000
  let forceAt: number | null = null
  let gracefulKilled = false
  const killed: string[] = []
  const deps = resolveProcessControl({
    graceMs: opts.graceMs ?? 20,
    ...(opts.forceWaitMs === undefined ? {} : { forceWaitMs: opts.forceWaitMs }),
    sleep: (ms) => { clock += ms; return Promise.resolve() },
    now: () => clock,
    isAlivePid: () => {
      if (opts.diesOnGraceful === true && gracefulKilled) return false
      if (forceAt === null) return true
      const diesAfter = opts.diesAfterForceMs ?? null
      if (diesAfter === null) return true
      return clock - forceAt < diesAfter
    },
    killPid: (_pid, mode) => {
      killed.push(mode)
      if (mode === 'graceful') gracefulKilled = true
      if (mode === 'force') forceAt = clock
    },
  })
  return { deps, killed, clock: () => clock }
}

test('P11-3 回归：强杀后 40ms 才消失 → killed（不再误判 failed）', async () => {
  // 旧行为：killPid('force') 后立刻 isAlivePid → true → 'failed'（而进程 40ms 后确实没了）
  const fx = fixture({ diesAfterForceMs: 40 })
  const outcome = await stopPid(4242, fx.deps)
  assert.equal(outcome, 'killed')
  assert.deepEqual(fx.killed, ['graceful', 'force'], '优雅 → 强杀，各一次')
  // 强杀后至少轮询了一次（时钟被 sleep 推着走，说明等待是「查询 + 短睡」而非一次死判）
  assert.ok(fx.clock() > 1_000_200, '强杀后必须实际等待/轮询过，而不是立刻回查一次')
})

test('P11-3：等待窗口是有限的 —— 怎么都杀不掉 → failed（不死循环）', async () => {
  const fx = fixture({ graceMs: 20, forceWaitMs: 120, diesAfterForceMs: null })
  const outcome = await stopPid(4242, fx.deps)
  assert.equal(outcome, 'failed')
  const waited = fx.clock() - 1_000_000
  assert.ok(waited >= 20 + 120, '至少等满 优雅期 + 强杀等待窗口，实际 ' + String(waited) + 'ms')
  assert.ok(waited < 20 + 120 + 1_000, '不得无限等：' + String(waited) + 'ms')
})

test('P11-3：forceWaitMs=0 时退回「杀完立刻判定」的旧口径（显式关闭等待）', async () => {
  const alive = fixture({ forceWaitMs: 0, diesAfterForceMs: null })
  assert.equal(await stopPid(1, alive.deps), 'failed')
  const dying = fixture({ forceWaitMs: 0, diesAfterForceMs: 0 })
  assert.equal(await stopPid(1, dying.deps), 'killed')
})

test('优雅期生效：自己退出 → graceful，绝不强杀', async () => {
  const fx = fixture({ diesOnGraceful: true })
  assert.equal(await stopPid(7, fx.deps), 'graceful')
  assert.deepEqual(fx.killed, ['graceful'])
})

test('已经不在 → already-stopped，不发任何终止', async () => {
  const killed: string[] = []
  const deps = resolveProcessControl({
    isAlivePid: () => false,
    killPid: (_pid, mode) => { killed.push(mode) },
    sleep: () => Promise.resolve(),
    now: () => 0,
  })
  assert.equal(await stopPid(9, deps), 'already-stopped')
  assert.deepEqual(killed, [])
})

test('缺省强杀等待窗口是有限正数（POSIX/Windows 共用）', () => {
  assert.equal(Number.isFinite(PROFILE_FORCE_EXIT_WAIT_MS), true)
  assert.ok(PROFILE_FORCE_EXIT_WAIT_MS > 0)
  assert.equal(resolveProcessControl().forceWaitMs, PROFILE_FORCE_EXIT_WAIT_MS)
})
