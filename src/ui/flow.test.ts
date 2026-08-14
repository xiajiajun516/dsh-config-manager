import test from 'node:test'
import assert from 'node:assert/strict'
import { nextFlowPhase, type FlowPhase } from './flow.ts'

const ALL: FlowPhase[] = ['conflicts', 'path-mapping', 'secrets', 'confirm']

test('来自 preview（不在列表中）→ 取第一项', () => {
  assert.equal(nextFlowPhase(['conflicts', 'path-mapping', 'confirm'], 'preview'), 'conflicts')
  assert.equal(nextFlowPhase(['secrets', 'confirm'], 'preview'), 'secrets')
  assert.equal(nextFlowPhase(['confirm'], 'preview'), 'confirm')
})

test('顺序前进：conflicts → path-mapping → secrets → confirm', () => {
  assert.equal(nextFlowPhase(ALL, 'conflicts'), 'path-mapping')
  assert.equal(nextFlowPhase(ALL, 'path-mapping'), 'secrets')
  assert.equal(nextFlowPhase(ALL, 'secrets'), 'confirm')
})

test('回归：path-mapping 完成后即使 conflicts 仍适用（hasX 不变）也只前进，不回跳', () => {
  // 模拟“既有冲突又有路径问题”：list 含 conflicts，但从 path-mapping 出发必须到 secrets/confirm
  const list: FlowPhase[] = ['conflicts', 'path-mapping', 'confirm']
  assert.equal(nextFlowPhase(list, 'path-mapping'), 'confirm')
  assert.equal(nextFlowPhase(list, 'conflicts'), 'path-mapping')
})

test('跳过不适用的阶段', () => {
  assert.equal(nextFlowPhase(['path-mapping', 'confirm'], 'preview'), 'path-mapping')
  assert.equal(nextFlowPhase(['confirm'], 'conflicts'), 'confirm')
})

test('最后一项原地返回（confirm 无下一步）', () => {
  assert.equal(nextFlowPhase(ALL, 'confirm'), 'confirm')
})

test('空列表兜底返回 confirm', () => {
  assert.equal(nextFlowPhase([], 'preview'), 'confirm')
})
