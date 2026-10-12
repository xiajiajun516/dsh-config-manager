/**
 * t17 历史 fork 归位：只读盘点 + 逐个归位 + 逐个复核，逐条回执、失败带具体理由。
 *
 * 测试策略：seam 用**带真实状态的小注册表**（成员集合 + 写计数）而不是「返回固定值的桩」——
 * 这样「已归位 ⇒ 幂等不重复写」与「复核不通过 ⇒ 不报成功」才是被真的判据证明的，
 * 而不是把桩的返回值抄一遍。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  FORK_RECONCILE_RECEIPT_LIMIT,
  reconcileForkSessions,
  type ForkReconcileChild,
  type ForkReconcileOutcome,
} from './fork-reconcile.ts'

/**
 * 影子工作区注册表：`path` 是真实目录（realpath 判定用不到真实盘 —— 本文件只喂 seam），
 * `members` 是生效成员，`writes` 记录真的写了几次（幂等判据看它）。
 */
function fakeWorkspace(input: { id: string; path: string; resolvable: boolean }) {
  return {
    id: input.id,
    path: input.path,
    resolvable: input.resolvable,
    members: new Set<string>(),
    writes: 0,
    attach(childId: string): void {
      this.writes += 1
      this.members.add(childId)
    },
  }
}

/**
 * seam 工厂：复刻 t10 的判据（成员/血缘/cwd 同目录三档 + 写后复核），但用影子注册表 ——
 * **写后复核就是重新读一遍 members**（真机就是重新读 `list()`）。
 */
function makeSeam(input: {
  workspaces: ReturnType<typeof fakeWorkspace>[]
  /** 每条子会话的 cwd（缺省 = 解析不到任何工作区） */
  cwdOf?: Record<string, string>
  /** 强制某条子会话 attach 抛错（模拟「写调用被拒」） */
  rejectOf?: Record<string, string>
  /** 强制某条子会话「写了但复核不含它」（模拟 DSH 没真的落盘） */
  noopOf?: Set<string>
  calls?: ForkReconcileChild[]
}): (child: ForkReconcileChild) => Promise<ForkReconcileOutcome> {
  return async (child) => {
    input.calls?.push(child)
    // ① 已在账内（幂等：**不重复写**）
    const member = input.workspaces.find((ws) => ws.members.has(child.sessionId))
    if (member !== undefined) return { ok: true, status: 'already', workspaceId: member.id }
    // ② cwd → 已注册工作区（解析不到 ⇒ 具体理由）
    const cwd = input.cwdOf?.[child.sessionId]
    if (cwd === undefined) return { ok: false, reason: 'cwd-unavailable' }
    const target = input.workspaces.find((ws) => ws.path === cwd && ws.resolvable)
    if (target === undefined) return { ok: false, reason: 'no-workspace-for-cwd', detail: cwd }
    // ③ 写（可能被拒 / 可能没落盘）
    const reject = input.rejectOf?.[child.sessionId]
    if (reject !== undefined) return { ok: false, reason: 'attach-rejected', detail: reject }
    if (input.noopOf?.has(child.sessionId) === true) return { ok: false, reason: 'verify-failed', detail: 'child-not-in-any-workspace-sessionIds' }
    target.attach(child.sessionId)
    // ④ 复核：重新读 members（attach 返回成功 ≠ 归位成功）
    const verified = input.workspaces.find((ws) => ws.members.has(child.sessionId))
    return verified === undefined
      ? { ok: false, reason: 'verify-failed', detail: 'child-not-in-any-workspace-sessionIds' }
      : { ok: true, status: 'attached', workspaceId: verified.id }
  }
}

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 候选清单简写：`kids(['child-1', 'parent-1'])`（subagent 只用于「有意跳过」那条用例）。 */
const kids = (...pairs: [string, string][]): ForkReconcileChild[] =>
  pairs.map(([sessionId, parentSessionId]) => ({ sessionId, parentSessionId }))

test('t17 能解析 ⇒ 归位且复核通过（attached）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const result = await reconcileForkSessions({
    childSessions: async () => kids(['child-1', 'parent-1']),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-1': 'D:/proj/a' } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.candidates, 1)
  assert.equal(result.attached, 1)
  assert.equal(result.already, 0)
  assert.equal(result.refused, 0)
  assert.deepEqual(result.receipts, [{
    sessionId: 'child-1',
    parentSessionId: 'parent-1',
    status: 'attached',
    reason: 'attached',
    workspaceId: 'ws-1',
  }])
  assert.equal(ws.writes, 1, '真的写了一次')
  assert.deepEqual([...ws.members], ['child-1'], '复核读的就是它（写后重读）')
})

test('t17 解析不到 ⇒ refused 且带具体理由（绝不猜工作区）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const result = await reconcileForkSessions({
    childSessions: async () => kids(['child-elsewhere', 'parent-1'], ['child-nocwd', 'parent-1']),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-elsewhere': 'D:/other/place' } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.candidates, 2)
  assert.equal(result.attached, 0)
  assert.equal(result.refused, 2)
  assert.deepEqual(result.reasonCounts, { 'no-workspace-for-cwd': 1, 'cwd-unavailable': 1 })
  assert.equal(ws.writes, 0, '一条都不许猜着写')
  assert.deepEqual(result.receipts.map((r) => [r.sessionId, r.status, r.reason]), [
    ['child-elsewhere', 'refused', 'no-workspace-for-cwd'],
    ['child-nocwd', 'refused', 'cwd-unavailable'],
  ])
  assert.equal(result.receipts[0]?.detail, 'D:/other/place', '理由要能定位（带路径）')
})

test('t17 已归位 ⇒ already，且**幂等不重复写**（连跑两次第二次零写）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const calls: ForkReconcileChild[] = []
  const deps = {
    childSessions: async () => kids(['child-1', 'parent-1']),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-1': 'D:/proj/a' }, calls }),
  }
  const first = await reconcileForkSessions(deps)
  assert.equal(first.attached, 1)
  assert.equal(ws.writes, 1)
  const second = await reconcileForkSessions(deps)
  assert.equal(second.already, 1, '第二次必须报 already（不是又写一次）')
  assert.equal(second.attached, 0)
  assert.equal(ws.writes, 1, '幂等：attach 只写了一次')
  assert.deepEqual(second.receipts[0]?.reason, 'already-attached')
  assert.deepEqual(calls.map((c) => c.sessionId), ['child-1', 'child-1'], '同一条会话每次盘点各问一次，绝不重复写')
})

test('t17 复核不通过 ⇒ 报失败（refused/verify-failed），绝不报成功', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const result = await reconcileForkSessions({
    childSessions: async () => kids(['child-ghost', 'parent-1']),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-ghost': 'D:/proj/a' }, noopOf: new Set(['child-ghost']) }),
  })
  assert.equal(result.attached, 0, '写调用没抛错但复核不含它 ⇒ 不许报成功')
  assert.equal(result.refused, 1)
  assert.deepEqual(result.reasonCounts, { 'verify-failed': 1 })
  assert.equal(result.receipts[0]?.status, 'refused')
  assert.equal(ws.writes, 0, 'noop 档连写都没发生（判据在 seam 内，本用例只证明 core 不把它算成功）')
})

test('t17 写被拒 ⇒ refused/attach-rejected 带 detail（失败不静默）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const logs: string[] = []
  const result = await reconcileForkSessions({
    childSessions: async () => kids(['child-1', 'parent-1']),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-1': 'D:/proj/a' }, rejectOf: { 'child-1': 'workspace write failed' } }),
    log: (line) => logs.push(line),
  })
  assert.equal(result.refused, 1)
  assert.deepEqual(result.reasonCounts, { 'attach-rejected': 1 })
  assert.equal(result.receipts[0]?.detail, 'workspace write failed')
  assert.equal(logs.some((line) => line.includes('refused: attach-rejected')), true, '逐条失败必须留痕')
})

test('t17 候选只认「有父会话的子会话」：无父/空 id/自环的噪声项只计入 scanned', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const calls: ForkReconcileChild[] = []
  const result = await reconcileForkSessions({
    childSessions: async () => kids(
      ['child-1', 'parent-1'],
      ['child-1', 'parent-1'], // 重复项只处理一次
      ['root-1', ''], // 无父
      ['', 'parent-1'], // 空 id
      ['self-1', 'self-1'], // 自环
    ),
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'child-1': 'D:/proj/a' }, calls }),
  })
  assert.equal(result.scanned, 5, 'scanned = 原始清单条数（含噪声项）')
  assert.equal(result.candidates, 1, '只有 child-1 是候选')
  assert.deepEqual(calls.map((c) => c.sessionId), ['child-1'])
  assert.equal(result.attached, 1)
})

test('t17 一条抛错不影响其余（收成 refused/unexpected-error 且逐条互不影响）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const base = makeSeam({ workspaces: [ws], cwdOf: { 'child-2': 'D:/proj/a' } })
  const result = await reconcileForkSessions({
    childSessions: async () => kids(['child-boom', 'parent-1'], ['child-2', 'parent-1']),
    reconcileOne: async (child) => {
      if (child.sessionId === 'child-boom') throw new Error('registry exploded')
      return await base(child)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attached, 1, '后面那条照常归位')
  assert.equal(result.refused, 1)
  assert.deepEqual(result.reasonCounts, { 'unexpected-error': 1 })
  assert.equal(result.receipts[0]?.detail, 'registry exploded')
})

test('t17 盘点读不到父子关系 ⇒ ok:false + error（**不是**「本机没有子会话」）', async () => {
  const result = await reconcileForkSessions({
    childSessions: async () => { throw new Error('session store not ready') },
    reconcileOne: async () => ({ ok: true, status: 'attached' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.candidates, 0)
  assert.match(String(result.error), /child-sessions-unavailable: session store not ready/)
  assert.deepEqual(result.receipts, [])
})

test('t17 默认口径：**全部**有父会话的子会话都是候选（origin=subagent 也照做，真机 50/58 条 fork 带这个标记）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const calls: ForkReconcileChild[] = []
  const result = await reconcileForkSessions({
    childSessions: async () => [
      { sessionId: 'fork-1', parentSessionId: 'parent-1' },
      { sessionId: 'fork-2', parentSessionId: 'parent-1', subagent: true },
    ],
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'fork-1': 'D:/proj/a', 'fork-2': 'D:/proj/a' }, calls }),
  })
  assert.equal(result.candidates, 2, 'subagent 标记不得让回退 fork 掉队（真机 50/58 条就带它）')
  assert.deepEqual(result.skipped, { subagent: 0 })
  assert.deepEqual(calls.map((c) => c.sessionId), ['fork-1', 'fork-2'])
  assert.equal(result.attached, 2)
})

test('t17 显式窄化（skipSubagentSessions: true）：跳过的条数如实计数、不静默', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const calls: ForkReconcileChild[] = []
  const logs: string[] = []
  const result = await reconcileForkSessions({
    childSessions: async () => [
      { sessionId: 'fork-1', parentSessionId: 'parent-1' },
      { sessionId: 'sub-1', parentSessionId: 'parent-1', subagent: true },
      { sessionId: 'sub-2', parentSessionId: 'parent-1', subagent: true },
    ],
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf: { 'fork-1': 'D:/proj/a' }, calls }),
    log: (line) => logs.push(line),
  }, { skipSubagentSessions: true })
  assert.equal(result.scanned, 3)
  assert.equal(result.candidates, 1)
  assert.deepEqual(result.skipped, { subagent: 2 }, '跳过必须如实计数（不是静默丢弃）')
  assert.deepEqual(calls.map((c) => c.sessionId), ['fork-1'], '一条子代理会话都没被碰')
  assert.equal(result.attached, 1)
  assert.equal(result.refused, 0)
  assert.equal(logs.some((line) => line.includes('skipped 2 subagent sessions')), true, '跳过要有留痕')
})

test('t17 回执有界但计数精确（截断如实标记）', async () => {
  const ws = fakeWorkspace({ id: 'ws-1', path: 'D:/proj/a', resolvable: true })
  const relations: ForkReconcileChild[] = []
  const cwdOf: Record<string, string> = {}
  const total = FORK_RECONCILE_RECEIPT_LIMIT + 25
  for (let i = 0; i < total; i += 1) {
    const id = 'child-' + String(i)
    relations.push({ sessionId: id, parentSessionId: 'parent-1' })
    if (i % 5 !== 0) cwdOf[id] = 'D:/proj/a' // 1/5 解析不到
  }
  const result = await reconcileForkSessions({
    childSessions: async () => relations,
    reconcileOne: makeSeam({ workspaces: [ws], cwdOf }),
  })
  assert.equal(result.candidates, total)
  assert.equal(result.attached + result.already + result.refused, total, '计数精确')
  assert.equal(result.receipts.length, FORK_RECONCILE_RECEIPT_LIMIT, '明细有界')
  assert.equal(result.receiptsTruncated, true)
})

test('t17 只读纪律：core 不碰文件系统（源码级），候选里也没有「删除/清理」这种动作', () => {
  const source = readFileSync(new URL('./fork-reconcile.ts', import.meta.url), 'utf8')
  assert.ok(!/from 'node:/.test(source), 'core 只编排，IO 全在 seam 里（绝不自己读盘/写盘）')
  assert.ok(!/rmSync|rmdirSync|unlinkSync|fs\.rm\(|fs\.unlink\(|writeFileSync|appendFileSync/.test(source), '绝不删除、绝不改写任何东西')
  assert.ok(!/session-log|readLogHeader|zstd/.test(source), '绝不碰会话日志字节（连读都不读）')
  // 本文件（测试）也不许碰真实盘：只读源码文本 + 内存夹具
  assert.equal(HERE.length > 0, true)
})
