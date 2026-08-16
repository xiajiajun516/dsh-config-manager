/**
 * m3 progress-view 单测：computeProgressView 渲染模型（纯函数，node 可测）。
 *
 * 覆盖（验收 m3-render）：
 *  - 兼容路径：普通 ProgressEvent（无 section/item）→ 阶段文案 + step/total 百分比；
 *  - 分区徽章（导出：settings · 3/12，current=item 序号、total=sectionTotal）；
 *  - 内部计数徽章（导入：plugins · 6/18）；
 *  - 导出冗余：itemTotal === sectionTotal 时内部计数徽章去重；
 *  - detail 与分区 id 相同时去冗余（当前项名）；
 *  - null / 不定态（无 step/total → percent null）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeProgressView } from './progress-view.ts'
import type { RunProgress } from './progress-view.ts'

test('m3-render: null 事件 → 空渲染模型', () => {
  const view = computeProgressView(null)
  assert.equal(view.label, '')
  assert.equal(view.percent, null)
  assert.equal(view.sectionBadge, null)
  assert.equal(view.countBadge, null)
  assert.equal(view.detail, null)
})

test('m3-render: 兼容路径 —— 普通 ProgressEvent 走原逻辑（阶段 + 百分比）', () => {
  const event: RunProgress = { stage: 'validating', step: 2, total: 4 }
  const view = computeProgressView(event)
  assert.equal(view.label, 'Validating backup...')
  assert.equal(view.percent, 50)
  assert.equal(view.sectionBadge, null)
  assert.equal(view.countBadge, null)
  assert.equal(view.detail, null)
})

test('m3-render: 无 step/total → 不定态（percent null）', () => {
  const view = computeProgressView({ stage: 'executing', detail: 'running' })
  assert.equal(view.percent, null)
})

test('m3-render: 导出进度 → 分区徽章 settings · 3/12（内部计数去冗余）', () => {
  // m1 导出埋点：section=分区 id、sectionTotal=分区总数、item=1-based 分区序号、itemTotal=总数
  const event: RunProgress = {
    stage: 'exporting',
    section: 'settings',
    sectionTotal: 12,
    item: 3,
    itemTotal: 12,
    detail: 'settings',
  }
  const view = computeProgressView(event)
  assert.equal(view.percent, 25, '百分比 = item/itemTotal = 3/12')
  assert.deepEqual(view.sectionBadge, { label: 'settings', current: 3, total: 12 })
  assert.equal(view.countBadge, null, '导出内部计数与分区计数同源 → 去冗余')
  assert.equal(view.detail, null, 'detail 与分区 id 相同 → 去冗余')
})

test('m3-render: 导入进度 → 内部计数徽章 plugins · 6/18 + 当前项名', () => {
  // m1 导入埋点：section=当前 adapter、item/itemTotal=计划项进度、detail=计划项 id
  const event: RunProgress = {
    stage: 'executing',
    section: 'plugins',
    sectionTotal: null,
    item: 6,
    itemTotal: 18,
    detail: 'plugin:pkg-a',
  }
  const view = computeProgressView(event)
  assert.equal(view.percent, 33)
  assert.equal(view.sectionBadge, null, '导入无分区总数语义')
  assert.deepEqual(view.countBadge, { label: 'plugins', current: 6, total: 18 })
  assert.equal(view.detail, 'plugin:pkg-a', '当前项名保留')
})

test('m3-render: 未知阶段回退显示 stage id', () => {
  const view = computeProgressView({ stage: 'weird-stage' })
  assert.equal(view.label, 'weird-stage')
})
