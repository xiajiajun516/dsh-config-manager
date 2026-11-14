/**
 * runs-center-view 单测：运行中心的时序判定（纯函数，node 可测）。
 *
 * 覆盖 P9-6 的两个现场：
 *  - 慢响应重叠：旧响应晚到不得覆盖新数据（isStaleResponse）；
 *  - 关不掉的决策框：同一个等待事件跨轮询 key 必须不变（dialogKeyOf / pickWaitingRun），
 *    且忽略集合必须随等待事件结束释放（pruneDismissed，有界）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { dialogKeyOf, isDialogStillWaiting, isStaleResponse, pickWaitingRun, pruneDismissed } from './runs-center-view.ts'
import type { RunState } from '../../core/run-registry.ts'

/** 造一条 run（只写测试关心的字段，其余给稳定默认值）。 */
function run(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'r1',
    kind: 'import',
    status: 'running',
    section: null,
    sectionTotal: null,
    item: 0,
    itemTotal: 10,
    detail: null,
    log: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

test('T-01 dialogKeyOf: 同一个等待事件跨轮询不变（updatedAt / log / 计数都在变）', () => {
  const first = run({ pendingDecision: 'cancel', cancelRequestedAt: 1_100, updatedAt: 1_100, item: 3 })
  const second = run({ pendingDecision: 'cancel', cancelRequestedAt: 1_100, updatedAt: 1_600, item: 7 })
  assert.equal(dialogKeyOf(first), dialogKeyOf(second), '轮询回来的新对象必须是同一个 key，否则忽略失效')
  assert.equal(dialogKeyOf(first), 'r1:cancel')
})

test('T-02 dialogKeyOf: 换 run 或换决定种类 → 不同 key', () => {
  assert.notEqual(dialogKeyOf(run({ runId: 'r1', pendingDecision: 'cancel' })), dialogKeyOf(run({ runId: 'r2', pendingDecision: 'cancel' })))
  assert.notEqual(dialogKeyOf(run({ pendingDecision: 'cancel' })), dialogKeyOf(run({ pendingDecision: null })))
})

test('T-03 pickWaitingRun: 只选「running + 等 cancel 决定」的第一条', () => {
  const done = run({ runId: 'done', status: 'done', pendingDecision: 'cancel' })
  const plain = run({ runId: 'plain' })
  const waiting = run({ runId: 'waiting', pendingDecision: 'cancel' })
  assert.equal(pickWaitingRun([done, plain, waiting], new Set()), waiting)
  assert.equal(pickWaitingRun([done, plain], new Set()), null)
  assert.equal(pickWaitingRun(null, new Set()), null)
  assert.equal(pickWaitingRun([], new Set()), null)
})

test('T-04 pickWaitingRun: 被忽略的跳过；全部忽略 → 不弹', () => {
  const waiting = run({ runId: 'waiting', pendingDecision: 'cancel' })
  const dismissed = new Set([dialogKeyOf(waiting)])
  assert.equal(pickWaitingRun([waiting], dismissed), null)
  // 另一条新的等待事件仍然要弹（忽略只对同一个 key 生效）
  const other = run({ runId: 'other', pendingDecision: 'cancel' })
  assert.equal(pickWaitingRun([waiting, other], dismissed), other)
})

test('T-05 现场复现: 关掉后连续三轮轮询（每次都是新对象、新 updatedAt）都不再自动弹', () => {
  const dismissed: Set<string> = new Set()
  let source = run({ pendingDecision: 'cancel', updatedAt: 1_000 })
  dismissed.add(dialogKeyOf(source)) // 用户点了「取消」
  for (const updatedAt of [1_500, 3_000, 4_500]) {
    source = run({ pendingDecision: 'cancel', updatedAt, item: updatedAt / 1_500 })
    // 每轮都按组件里的顺序：先裁剪，再挑
    const pruned = pruneDismissed(dismissed, [source])
    assert.equal(pruned.size, 1, 'run 还在等，忽略键必须保留')
    dismissed.clear()
    for (const key of pruned) dismissed.add(key)
    assert.equal(pickWaitingRun([source], dismissed), null, '同一个等待事件不得再弹回来')
  }
})

test('T-06 pruneDismissed: 等待结束后释放键（集合有界），runs 未知时保留', () => {
  const a = run({ runId: 'a', pendingDecision: 'cancel' })
  const b = run({ runId: 'b', pendingDecision: 'cancel' })
  const dismissed = new Set([dialogKeyOf(a), dialogKeyOf(b)])

  const afterAFinished = pruneDismissed(dismissed, [run({ runId: 'a', status: 'done' }), b])
  assert.deepEqual([...afterAFinished], [dialogKeyOf(b)], '已结束的 run 不再占键')

  assert.deepEqual([...pruneDismissed(dismissed, null)], [...dismissed], '首次加载未落地时不得清空（否则瞬时失败后弹框复现）')
  assert.equal(pruneDismissed(new Set(), [a]).size, 0)

  // 有界性：100 条 run 依次等待并结束，键集合不随之增长
  let live = new Set<string>()
  for (let i = 1; i <= 100; i += 1) {
    const current = run({ runId: `r${i}`, pendingDecision: 'cancel' })
    live.add(dialogKeyOf(current))
    live = pruneDismissed(live, [current])
    assert.equal(live.size, 1)
  }
})

test('T-07 isStaleResponse: 只有比已落地序号更新才允许落地', () => {
  assert.equal(isStaleResponse(0, 1), false, '首条响应必须能落地')
  assert.equal(isStaleResponse(2, 3), false)
  assert.equal(isStaleResponse(2, 2), true, '同序号已写过，重复写会把更新的值压回去')
  assert.equal(isStaleResponse(2, 1), true, '旧响应晚到必须丢弃')
})

test('T-09 isDialogStillWaiting: 已结案的等待必须关框，快照未知不得关', () => {
  const waiting = run({ pendingDecision: 'cancel' })
  const settled = run({ status: 'done', pendingDecision: null })
  assert.equal(isDialogStillWaiting(waiting, [waiting]), true, '仍在等决定时必须保留框')
  assert.equal(isDialogStillWaiting(waiting, [settled]), false, '宿主超时自动裁决后必须关框')
  assert.equal(isDialogStillWaiting(waiting, []), false, 'run 已从最近列表消失也算结案')
  assert.equal(isDialogStillWaiting(waiting, null), true, '快照还没落地时关框等于把问题藏起来')
  assert.equal(isDialogStillWaiting(waiting, [run({ runId: 'r2', pendingDecision: 'cancel' })]), false, '别的 run 在等不算这条还在等')
})

test('T-08 现场复现: 旧响应后到不得覆盖新数据（进度回退）', () => {
  let applied = 0
  let shown = 0
  const land = (seq: number, item: number): void => {
    if (isStaleResponse(applied, seq)) return
    applied = seq
    shown = item
  }
  land(2, 9) // 新一轮先到
  land(1, 3) // 旧一轮后到
  assert.equal(shown, 9, '进度条不得回退')
})
