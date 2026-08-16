/**
 * m4 测试补齐（任务 t4）：computeProgressView 边界补充。
 *
 * m3 主路径已由 progress-view.test.ts 覆盖（null/兼容路径/分区徽章/内部计数徽章/
 * 冗余去重/未知阶段）；本文件补充未覆盖的判定分支：
 *  - step/total 与 item/itemTotal 同时存在时百分比优先 step/total（文档优先级）；
 *  - section 存在但 sectionTotal 为 0 → 无分区徽章（total 必须 >0）；
 *  - itemTotal 为 0 → 无内部计数徽章且百分比回退不定态（除零防御）；
 *  - section 有值但 item 为 null → 分区徽章不渲染（徽章需要 current 计数）；
 *  - 百分比取整（Math.round，非截断）。
 * 全部为纯函数断言，不改动 m3 业务代码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeProgressView } from './progress-view.ts'
import type { RunProgress } from './progress-view.ts'

test('m3-render 边界: step/total 与 item/itemTotal 并存时百分比优先 step/total', () => {
  // 若误用 item/itemTotal 会算出 25%（3/12）；文档行为是优先 step/total → 33%
  const event: RunProgress = {
    stage: 'exporting',
    step: 1,
    total: 3,
    section: 'settings',
    sectionTotal: 12,
    item: 3,
    itemTotal: 12,
    detail: 'settings',
  }
  const view = computeProgressView(event)
  assert.equal(view.percent, 33, '百分比取 step/total（1/3 → 33%）而非 item/itemTotal')
  assert.deepEqual(view.sectionBadge, { label: 'settings', current: 3, total: 12 }, '徽章仍用分区计数')
})

test('m3-render 边界: sectionTotal 为 0 → 无分区徽章（total 必须 >0）', () => {
  const view = computeProgressView({ stage: 'executing', section: 'plugins', sectionTotal: 0, item: 2, itemTotal: 10 })
  assert.equal(view.sectionBadge, null, 'total=0 时不渲染分区徽章')
  assert.deepEqual(view.countBadge, { label: 'plugins', current: 2, total: 10 }, '内部计数徽章不受影响')
})

test('m3-render 边界: itemTotal 为 0 → 无内部计数徽章且百分比不定态（除零防御）', () => {
  const view = computeProgressView({ stage: 'executing', section: 'plugins', item: 0, itemTotal: 0, detail: 'x' })
  assert.equal(view.countBadge, null, 'itemTotal=0 不渲染计数徽章')
  assert.equal(view.percent, null, 'total=0 时百分比不定态（避免除零）')
  assert.equal(view.detail, 'x', 'detail 与 section 不同时保留')
})

test('m3-render 边界: section 有值但 item 为 null → 分区徽章不渲染（徽章需 current）', () => {
  const view = computeProgressView({ stage: 'executing', section: 'settings', sectionTotal: 5, item: null, itemTotal: 5 })
  assert.equal(view.sectionBadge, null)
  assert.equal(view.countBadge, null)
  assert.equal(view.percent, null, '无 step/total 且 item null → 不定态')
})

test('m3-render 边界: 百分比取整（Math.round 而非截断）', () => {
  assert.equal(computeProgressView({ stage: 'exporting', step: 1, total: 3 }).percent, 33)
  assert.equal(computeProgressView({ stage: 'exporting', step: 2, total: 3 }).percent, 67)
  assert.equal(computeProgressView({ stage: 'exporting', step: 1, total: 6 }).percent, 17)
})
