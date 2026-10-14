/**
 * 回合自动留点开关的**进程内**语义（issue #88 / #89，src/core/rollback-gate.ts）。
 *
 * 钉住四条：① 缺省关闭；② 变化才通知（同值不通知，避免写偏好时抖动 attach/detach）；
 * ③ 监听器抛错不影响开关本身与其它监听器；④ 解绑幂等。
 *
 * 为什么值得单测：宿主那条 `session/event` 订阅链的 attach/detach 完全由这里驱动 ——
 * 一旦「关了还通知」或「通知丢了」，就是「界面说关了、宿主还在每回合写台账」这类静默故障。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isRollbackEnabled,
  onRollbackEnabledChange,
  resetRollbackGateForTest,
  setRollbackEnabled,
} from './rollback-gate.ts'

test('G-01 缺省关闭 + 置真置假都生效', () => {
  resetRollbackGateForTest()
  assert.equal(isRollbackEnabled(), false, '缺省必须是关闭（fail-closed）')
  setRollbackEnabled(true)
  assert.equal(isRollbackEnabled(), true)
  setRollbackEnabled(false)
  assert.equal(isRollbackEnabled(), false)
  resetRollbackGateForTest()
})

test('G-02 同值不通知；变化按顺序通知一次', () => {
  resetRollbackGateForTest()
  const seen: boolean[] = []
  const off = onRollbackEnabledChange((value) => { seen.push(value) })
  setRollbackEnabled(false) // 与缺省同值 → 不通知
  assert.deepEqual(seen, [], '同值不得通知')
  setRollbackEnabled(true)
  setRollbackEnabled(true) // 重复同值
  setRollbackEnabled(false)
  assert.deepEqual(seen, [true, false], '只在真实变化时通知一次')
  off()
  resetRollbackGateForTest()
})

test('G-03 监听器抛错不影响开关与其它监听器', () => {
  resetRollbackGateForTest()
  const seen: boolean[] = []
  const offBad = onRollbackEnabledChange(() => { throw new Error('boom') })
  const offGood = onRollbackEnabledChange((value) => { seen.push(value) })
  setRollbackEnabled(true)
  assert.equal(isRollbackEnabled(), true, '坏监听器不得拦住状态切换')
  assert.deepEqual(seen, [true], '坏监听器不得吃掉后面监听器的通知')
  offBad()
  offGood()
  resetRollbackGateForTest()
})

test('G-04 解绑幂等：解绑后再改状态不通知已解绑者', () => {
  resetRollbackGateForTest()
  const seen: boolean[] = []
  const off = onRollbackEnabledChange((value) => { seen.push(value) })
  off()
  off() // 幂等
  setRollbackEnabled(true)
  assert.deepEqual(seen, [])
  resetRollbackGateForTest()
})
