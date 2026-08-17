/**
 * m-sync-ui (方案 A)：一键同步差异确认 + 自动同步 渲染模型纯函数测试。
 * TDD：先写失败测试，再实现 sync-view.ts 对应函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { ApplyItemsResponse, AutosyncStatusResponse, SyncConfirmItem } from './sync-api.ts'
import {
  applyItemsReportView, autosyncIntervalMs, autosyncStatusText, buildAdoptions,
  computeAutosyncCountdown, summarizeConfirmItems,
} from './sync-view.ts'

/* ---------------------------------------------------------------- 一键同步差异确认 */

function confirmItem(overrides: Partial<SyncConfirmItem>): SyncConfirmItem {
  return {
    itemId: 'a', adapter: 'settings', kind: 'Update', description: 'd', severity: 'info',
    defaultAdopt: true, adopt: true, ...overrides,
  }
}

test('sync-view: summarizeConfirmItems 统计 severity + 采用数 + needsReview', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', severity: 'info', kind: 'Update' }),
    confirmItem({ itemId: 'b', severity: 'warning', kind: 'MissingDependency', defaultAdopt: false, adopt: false }),
    confirmItem({ itemId: 'c', severity: 'error', kind: 'Error', defaultAdopt: false, adopt: false }),
    confirmItem({ itemId: 'd', severity: 'info', kind: 'Conflict', defaultAdopt: false, adopt: false }),
  ]
  const s = summarizeConfirmItems(items)
  assert.equal(s.total, 4)
  assert.equal(s.info, 2)
  assert.equal(s.warning, 1)
  assert.equal(s.error, 1)
  assert.equal(s.adopted, 1)
  assert.equal(s.needsReview, true)
})

test('sync-view: summarizeConfirmItems 空数组 → 全零 + 不需决策', () => {
  const s = summarizeConfirmItems([])
  assert.equal(s.total, 0)
  assert.equal(s.adopted, 0)
  assert.equal(s.needsReview, false)
})

test('sync-view: buildAdoptions 收集用户决策；未列出项视为 adopt=false', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', kind: 'Update' }),
    confirmItem({ itemId: 'b', kind: 'Create' }),
    confirmItem({ itemId: 'c', kind: 'Conflict', defaultAdopt: false }),
  ]
  const adopted = new Map<string, boolean>([
    ['a', true],
    ['b', false],
    ['c', true],
  ])
  const resolutions = new Map<string, 'useRemote' | 'keepLocal' | 'skip'>([['c', 'useRemote']])
  const out = buildAdoptions(items, adopted, resolutions)
  // 只有 adopt=true 的项进列表（a、c）；b 未采纳剔除
  const ids = out.map((o) => o.itemId)
  assert.deepEqual(ids, ['a', 'c'])
  assert.equal(out[1]?.resolution, 'useRemote')
})

test('sync-view: buildAdoptions Conflict 项未给 resolution → 抛错（强制先解决）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'c', kind: 'Conflict', defaultAdopt: false }),
  ]
  const adopted = new Map<string, boolean>([['c', true]])
  const resolutions = new Map<string, 'useRemote' | 'keepLocal' | 'skip'>()
  assert.throws(() => buildAdoptions(items, adopted, resolutions), /解决/)
})

test('sync-view: applyItemsReportView 成功 → ok 头部含 applied 计数与 restoreId', () => {
  const report: ApplyItemsResponse = {
    ok: true, applied: ['settings', 'plugins'], skipped: [], needsRestart: false,
    warnings: [], restoreId: 'rest-1', rolledBack: false, failed: [], result: {},
  }
  const view = applyItemsReportView(report)
  assert.notEqual(view, null)
  assert.equal(view?.kind, 'ok')
  assert.match(view?.headline ?? '', /2/)
  assert.equal(view?.restoreId, 'rest-1')
})

test('sync-view: applyItemsReportView 失败且整体回滚 → rolledBack 渲染', () => {
  const report: ApplyItemsResponse = {
    ok: false, applied: [], skipped: [], needsRestart: false,
    warnings: [], restoreId: 'rest-2', rolledBack: true,
    failed: [{ itemId: 'x', message: '导入失败' }], result: {},
  }
  const view = applyItemsReportView(report)
  assert.equal(view?.kind, 'rolledBack')
  assert.equal(view?.restoreId, 'rest-2')
})

test('sync-view: applyItemsReportView null → null', () => {
  assert.equal(applyItemsReportView(null), null)
})

/* ---------------------------------------------------------------- 自动同步 */

test('sync-view: autosyncIntervalMs 换算正确', () => {
  assert.equal(autosyncIntervalMs('5m'), 5 * 60 * 1000)
  assert.equal(autosyncIntervalMs('30m'), 30 * 60 * 1000)
  assert.equal(autosyncIntervalMs('24h'), 24 * 60 * 60 * 1000)
})

test('sync-view: computeAutosyncCountdown 距上次已过超过间隔 → 0（到期立即）', () => {
  assert.equal(computeAutosyncCountdown(30 * 60 * 1000, 30 * 60 * 1000), 0)
  assert.equal(computeAutosyncCountdown(31 * 60 * 1000, 30 * 60 * 1000), 0)
  assert.equal(computeAutosyncCountdown(10 * 60 * 1000, 30 * 60 * 1000), 20 * 60 * 1000)
})

test('sync-view: autosyncStatusText 覆盖未运行 / 各状态', () => {
  const status: AutosyncStatusResponse = {
    enabled: true, interval: '30m', consecutiveFailures: 0, elapsedMs: -1,
  }
  assert.match(autosyncStatusText(status), /从未运行/)
  const ran: AutosyncStatusResponse = {
    enabled: true, interval: '30m', consecutiveFailures: 0, elapsedMs: 0,
    lastRunAt: '2026-08-17T10:00:00.000Z', lastRunStatus: 'success',
  }
  assert.match(autosyncStatusText(ran), /成功/)
  const failed: AutosyncStatusResponse = {
    enabled: true, interval: '30m', consecutiveFailures: 3, elapsedMs: 0,
    lastRunAt: '2026-08-17T10:00:00.000Z', lastRunStatus: 'failed', lastRunMessage: '认证失败',
  }
  assert.match(autosyncStatusText(failed), /失败/)
  assert.match(autosyncStatusText(failed), /连续失败 3 次/)
})
