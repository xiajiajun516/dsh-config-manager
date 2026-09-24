/**
 * 导入向导步骤条映射测试（node:test，零依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { IMPORT_STAGES, importStepperModel, importStepperSource, stageOf } from './import-stepper.ts'

test('stageOf: 九个 ImportStep + FlowPhase 全部映射到 6 阶段', () => {
  assert.equal(stageOf('select'), 'select')
  assert.equal(stageOf('decrypt-archive'), 'select')
  assert.equal(stageOf('analyzing'), 'analyze')
  assert.equal(stageOf('compatibility'), 'analyze')
  assert.equal(stageOf('preview'), 'decide')
  assert.equal(stageOf('conflicts'), 'decide')
  assert.equal(stageOf('path-mapping'), 'decide')
  assert.equal(stageOf('secrets'), 'decide')
  assert.equal(stageOf('confirm'), 'confirm')
  assert.equal(stageOf('importing'), 'execute')
  assert.equal(stageOf('result'), 'done')
})

test('importStepperModel: select → 第 0 阶段 current，其余 todo', () => {
  const m = importStepperModel('select')
  assert.equal(m.index, 0)
  assert.equal(m.steps.length, 6)
  assert.equal(m.steps[0]!.state, 'current')
  assert.equal(m.steps[0]!.labelKey, 'import.stage.select')
  for (const s of m.steps.slice(1)) assert.equal(s.state, 'todo')
})

test('importStepperModel: preview（决策链中段）→ 之前 done 之后 todo', () => {
  const m = importStepperModel('conflicts')
  assert.equal(m.index, 2)
  assert.equal(m.steps[0]!.state, 'done')
  assert.equal(m.steps[1]!.state, 'done')
  assert.equal(m.steps[2]!.state, 'current')
  assert.equal(m.steps[3]!.state, 'todo')
})

test('importStepperModel: result → 最后一阶段 current（全部走完）', () => {
  const m = importStepperModel('result')
  assert.equal(m.index, IMPORT_STAGES.length - 1)
  for (const s of m.steps.slice(0, 5)) assert.equal(s.state, 'done')
  assert.equal(m.steps[5]!.state, 'current')
})

test('importStepperModel: importing 阶段映射正确（执行中）', () => {
  const m = importStepperModel('importing')
  assert.equal(m.index, 4)
  assert.equal(m.steps[4]!.state, 'current')
})

/**
 * 回归（用户报告）：执行中 / 完成后的步骤条不得停在「确认」。
 * phase 会停在 confirm（向导不回退，且没有「执行/完成」这两个 FlowPhase），
 * 所以这两个阶段必须由 step 决定。
 */
test('importStepperSource: step 进入 importing/result 时压过停在 confirm 的 phase', () => {
  assert.equal(importStepperSource('importing', 'confirm'), 'importing')
  assert.equal(importStepperSource('result', 'confirm'), 'result')
  // 端到端：步骤条索引必须分别落在「执行」「完成」
  assert.equal(importStepperModel(importStepperSource('importing', 'confirm')).index, 4)
  const done = importStepperModel(importStepperSource('result', 'confirm'))
  assert.equal(done.index, 5)
  assert.equal(done.steps[4]!.state, 'done')
  assert.equal(done.steps[5]!.state, 'current')
})

test('importStepperSource: 其余组合保持原判定（preview 看 step，流程阶段看 phase）', () => {
  assert.equal(importStepperSource('select', 'preview'), 'select')
  assert.equal(importStepperSource('preview', 'preview'), 'preview')
  assert.equal(importStepperSource('preview', 'confirm'), 'confirm')
  assert.equal(importStepperSource('preview', 'conflicts'), 'conflicts')
  assert.equal(importStepperSource('select', 'decrypt-archive'), 'decrypt-archive')
})
