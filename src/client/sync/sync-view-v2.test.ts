/**
 * m-sync-ui (方案 A)：一键同步差异确认 + 自动同步 渲染模型纯函数测试。
 * TDD：先写失败测试，再实现 sync-view.ts 对应函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { ApplyItemsResponse, AutosyncStatusResponse, SyncConfirmItem } from './sync-api.ts'
import {
  applyItemsReportView, autosyncIntervalMs, autosyncStatusText, buildAdoptions,
  computeAutosyncCountdown, hasBulkDecidable, isBulkDecidable, isReviewItem, isToolchainChangeItem,
  keepLocalAll, reviewItems, summarizeConfirmItems, useRemoteAll,
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

/* ---------------------------------------------------------------- 精简显示 + 批量决策 */

test('issue #35: 改变工具链行为的 pnpm-workspace 项进确认列表（可见、可取消），普通内容变更不打扰用户', () => {
  const withDropped = confirmItem({
    itemId: 'plugins:pnpm-workspace', kind: 'Update',
    detail: '导入时会移除 1 条无法满足的 patchedDependencies 声明: x',
  })
  assert.deepEqual(reviewItems([withDropped]).map((i) => i.itemId), ['plugins:pnpm-workspace'])
  assert.equal(isToolchainChangeItem(withDropped), true)
  // 普通内容变更（无剔除 detail）→ 不进列表（不制造噪音）
  const plain = confirmItem({ itemId: 'plugins:pnpm-workspace', kind: 'Update' })
  assert.equal(isToolchainChangeItem(plain), false)
  assert.deepEqual(reviewItems([plain]), [])
  // 同 id 的其它形态（如 Warning 项）走 kind 判定，不受影响
  assert.equal(isToolchainChangeItem(confirmItem({ itemId: 'plugins:pnpm-workspace-dropped', kind: 'Warning' })), false)
})

test('sync-view: isReviewItem 仅需人工决策的类型返回 true', () => {
  assert.equal(isReviewItem('Conflict'), true)
  assert.equal(isReviewItem('MissingSecret'), true)
  assert.equal(isReviewItem('MissingDependency'), true)
  // 插件安装随同步自动采用，不视为需人工决策项（product requirement）
  assert.equal(isReviewItem('Install'), false)
  assert.equal(isReviewItem('Error'), true)
  assert.equal(isReviewItem('PathMapping'), true)
  assert.equal(isReviewItem('Create'), false)
  assert.equal(isReviewItem('Update'), false)
  assert.equal(isReviewItem('Skip'), false)
  // issue #35：Warning 必须可见（承载「本次同步会剔除哪些无法满足的声明」这类语义变更）
  assert.equal(isReviewItem('Warning'), true)
})

test('issue #35: Warning 项进入确认列表（不再静默自动采用）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'plugins:pnpm-workspace', kind: 'Update' }),
    confirmItem({
      itemId: 'plugins:pnpm-workspace-dropped', kind: 'Warning', severity: 'warning',
      description: '已移除 1 条 patchedDependencies 声明',
    }),
  ]
  assert.deepEqual(reviewItems(items).map((i) => i.itemId), ['plugins:pnpm-workspace-dropped'])
})

test('sync-view: reviewItems 只保留需人工决策项（统计仍基于全量）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', kind: 'Update' }),
    confirmItem({ itemId: 'b', kind: 'Create' }),
    confirmItem({ itemId: 'c', kind: 'Conflict', defaultAdopt: false }),
    confirmItem({ itemId: 'd', kind: 'MissingSecret', defaultAdopt: false }),
  ]
  const shown = reviewItems(items)
  assert.deepEqual(shown.map((i) => i.itemId), ['c', 'd'])
  // summarizeConfirmItems 仍统计全量
  assert.equal(summarizeConfirmItems(items).total, 4)
})

test('sync-view: keepLocalAll 覆盖全部待确认项（Conflict 连带 resolution；非决策项不动）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', kind: 'Conflict', defaultAdopt: false }),
    confirmItem({ itemId: 'b', kind: 'Update' }),
    confirmItem({ itemId: 'c', kind: 'Conflict', defaultAdopt: false }),
  ]
  const decisions = keepLocalAll(items)
  assert.deepEqual(decisions, [
    { itemId: 'a', resolution: 'keepLocal', adopt: false },
    { itemId: 'c', resolution: 'keepLocal', adopt: false },
  ])
})

test('sync-view: useRemoteAll 覆盖 MissingSecret 等非冲突项（用户报告：缺密钥只能逐条勾）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', kind: 'Conflict', defaultAdopt: false }),
    confirmItem({ itemId: 'b', kind: 'Update' }),
    confirmItem({ itemId: 'c', kind: 'MissingSecret', defaultAdopt: false }),
    confirmItem({ itemId: 'd', kind: 'MissingSecret', defaultAdopt: false }),
    confirmItem({ itemId: 'e', kind: 'Error', severity: 'error', defaultAdopt: false }),
  ]
  const decisions = useRemoteAll(items)
  assert.deepEqual(decisions, [
    { itemId: 'a', resolution: 'useRemote', adopt: true },
    { itemId: 'c', adopt: true },
    { itemId: 'd', adopt: true },
  ], 'Error 项不进批量（硬失败项必须逐项裁决）；插件 Update 等非决策项保持默认')
  // 反向：全部保留当前配置同样覆盖缺密钥项
  assert.deepEqual(keepLocalAll(items), [
    { itemId: 'a', resolution: 'keepLocal', adopt: false },
    { itemId: 'c', adopt: false },
    { itemId: 'd', adopt: false },
  ])
})

test('sync-view: isBulkDecidable / hasBulkDecidable 与确认列表同口径（Error 除外）', () => {
  assert.equal(isBulkDecidable(confirmItem({ kind: 'MissingSecret' })), true)
  assert.equal(isBulkDecidable(confirmItem({ kind: 'MissingDependency' })), true)
  assert.equal(isBulkDecidable(confirmItem({ kind: 'Warning' })), true)
  assert.equal(isBulkDecidable(confirmItem({ kind: 'PathMapping' })), true)
  assert.equal(isBulkDecidable(confirmItem({ kind: 'Conflict' })), true)
  assert.equal(isBulkDecidable(confirmItem({ kind: 'Error' })), false, 'Error 是硬失败项，需逐项处理')
  assert.equal(isBulkDecidable(confirmItem({ kind: 'Update' })), false, '非决策项不进确认列表')
  // issue #35：改变工具链行为的项（kind 可能是 Update）也进确认列表 → 同样可批量决策
  assert.equal(isBulkDecidable(confirmItem({ itemId: 'plugins:pnpm-workspace', kind: 'Update', detail: '剔除 1 条声明' })), true)

  // 按钮禁用判据：列表里一个可批量决策项都没有 → 禁用（此前只看 Conflict，缺密钥列表里按钮恒灰）
  assert.equal(hasBulkDecidable([confirmItem({ kind: 'Error', defaultAdopt: false })]), false)
  assert.equal(hasBulkDecidable([confirmItem({ kind: 'Error', defaultAdopt: false }), confirmItem({ itemId: 'z', kind: 'MissingSecret', defaultAdopt: false })]), true)
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
  const resolutions = new Map<string, 'useRemote' | 'keepLocal'>([['c', 'useRemote']])
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
  const resolutions = new Map<string, 'useRemote' | 'keepLocal'>()
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
