/**
 * m-sync-ui (方案 A)：一键同步差异确认 + 自动同步 渲染模型纯函数测试。
 * TDD：先写失败测试，再实现 sync-view.ts 对应函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { ApplyItemsResponse, AutosyncStatusResponse, SyncConfirmItem } from './sync-api.ts'
import {
  applyItemsReportView, autosyncIntervalMs, autosyncStatusText, buildAdoptions, confirmListSummary,
  computeAutosyncCountdown, GIST_LARGE_SECTION_HINT_KEY, gistSessionsRiskKey, hasBulkDecidable,
  isBulkDecidable, isReviewItem, isToolchainChangeItem,
  keepLocalAll, needsGitToken, reviewItems, summarizeConfirmItems, useRemoteAll,
} from './sync-view.ts'
import { zhUiT } from '../../ui/i18n.ts'

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
  const out = buildAdoptions(items, adopted, resolutions, zhUiT)
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
  assert.throws(() => buildAdoptions(items, adopted, resolutions, zhUiT), /解决/)
})

test('sync-view: applyItemsReportView 成功 → ok 头部含 applied 计数与 restoreId', () => {
  const report: ApplyItemsResponse = {
    ok: true, applied: ['settings', 'plugins'], skipped: [], needsRestart: false,
    warnings: [], restoreId: 'rest-1', rolledBack: false, failed: [], result: {},
  }
  const view = applyItemsReportView(report, zhUiT)
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
  const view = applyItemsReportView(report, zhUiT)
  assert.equal(view?.kind, 'rolledBack')
  assert.equal(view?.restoreId, 'rest-2')
})

test('sync-view: applyItemsReportView null → null', () => {
  assert.equal(applyItemsReportView(null, zhUiT), null)
})

/* ---------- issue #56：ok=true 但有未生效项（warning）必须呈现为「部分成功」 ---------- */

test('issue#56：有未生效项时 kind=partial（不得显示为成功）', () => {
  const report: ApplyItemsResponse = {
    ok: true, applied: ['settings', 'providers'], skipped: [], needsRestart: false,
    warnings: ['插件 some-plugin 安装失败：…'],
    restoreId: 'rest-3', rolledBack: false, failed: [],
    // 真机形态：插件安装失败排在凭据写入之前，密钥因此没导进来
    ineffective: [{ itemId: 'plugins:some-plugin', adapter: 'plugins', message: '插件 some-plugin 安装失败：release-age-violation' }],
    result: {},
  }
  const view = applyItemsReportView(report, zhUiT)
  assert.equal(view?.kind, 'partial', 'ok=true 但有未生效项 ⇒ partial，绝不是 ok')
  assert.match(view?.headline ?? '', /1/, '头部要给出未生效条数')
  assert.deepEqual(view?.ineffective.map((i) => i.itemId), ['plugins:some-plugin'])
  // 语义边界：没有回滚、也没判成失败
  assert.equal(view?.restoreId, 'rest-3')
})

test('issue#56：未生效项不影响「全部成功」判定（空/缺字段 → ok）', () => {
  const base = {
    ok: true, applied: ['settings'], skipped: [], needsRestart: false,
    warnings: [], restoreId: 'r', rolledBack: false, failed: [], result: {},
  } as ApplyItemsResponse
  // 空数组（新宿主明确回报「没有未生效项」）
  assert.equal(applyItemsReportView({ ...base, ineffective: [] }, zhUiT)?.kind, 'ok')
  // 缺字段（旧宿主）→ 按无未生效项处理，绝不误报部分成功
  assert.equal(applyItemsReportView(base, zhUiT)?.kind, 'ok')
})

/* ---------------------------------------------------------------- 自动同步 */

test('sync-view: needsGitToken 只对 http(s) 远端为真（本地路径 / ssh 走 git 原生认证）', () => {
  assert.equal(needsGitToken('https://github.com/u/r.git'), true)
  assert.equal(needsGitToken('HTTP://gitlab.example.com/u/r.git'), true)
  assert.equal(needsGitToken('  https://gitee.com/u/r.git  '), true)
  assert.equal(needsGitToken('git@github.com:u/r.git'), false)
  assert.equal(needsGitToken('D:/repos/config.git'), false)
  assert.equal(needsGitToken(''), false)
})

test('sync-view: confirmListSummary 拆出「逐项确认」与「自动采用」两个数字（57 项差异 vs 1 行列表）', () => {
  const items: SyncConfirmItem[] = [
    confirmItem({ itemId: 'a', kind: 'Update' }), // 自动采用
    confirmItem({ itemId: 'b', kind: 'Create' }), // 自动采用
    confirmItem({ itemId: 'c', kind: 'Conflict', defaultAdopt: false }),
    confirmItem({ itemId: 'plugins:pnpm-workspace', kind: 'Update', detail: '移除 1 条 patchedDependencies' }),
  ]
  assert.deepEqual(confirmListSummary(items), { reviewCount: 2, autoCount: 2 })
  // 与 reviewItems 同口径：列表里的项数就是 reviewCount
  assert.equal(reviewItems(items).length, confirmListSummary(items).reviewCount)
  assert.deepEqual(confirmListSummary([]), { reviewCount: 0, autoCount: 0 })
})

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
  assert.match(autosyncStatusText(status, zhUiT), /从未运行/)
  const ran: AutosyncStatusResponse = {
    enabled: true, interval: '30m', consecutiveFailures: 0, elapsedMs: 0,
    lastRunAt: '2026-08-17T10:00:00.000Z', lastRunStatus: 'success',
  }
  assert.match(autosyncStatusText(ran, zhUiT), /成功/)
  const failed: AutosyncStatusResponse = {
    enabled: true, interval: '30m', consecutiveFailures: 3, elapsedMs: 0,
    lastRunAt: '2026-08-17T10:00:00.000Z', lastRunStatus: 'failed', lastRunMessage: '认证失败',
  }
  assert.match(autosyncStatusText(failed, zhUiT), /失败/)
  assert.match(autosyncStatusText(failed, zhUiT), /连续失败 3 次/)
})

/* ---------------------- 诚实性：整体回滚「未完成」必须单独成态 ---------------------- */

test('回滚未完成（rollbackFull=false）：kind=rollbackIncomplete，绝不渲染成「已整体回滚」', () => {
  const report: ApplyItemsResponse = {
    ok: false, applied: [], skipped: [], needsRestart: false,
    warnings: ['回滚未完成：credentialsStatus:K —— DSH 不回读凭据值，无法自动恢复（请重新补录该凭据）'],
    restoreId: 'rest-x', rolledBack: true, rollbackFull: false,
    failed: [{ itemId: 'x', message: '导入失败' }], result: {},
  }
  const view = applyItemsReportView(report, zhUiT)
  assert.equal(view?.kind, 'rollbackIncomplete', '半回滚必须与 rolledBack（整体已回滚）分开')
  assert.equal(view?.rollbackFull, false)
  assert.doesNotMatch(view?.headline ?? '', /已整体回滚/, '不得复用断言「已整体回滚」的失败文案')
  assert.match(view?.headline ?? '', /回滚未完成/)
  // 未恢复项在 warnings 里逐条给出（引擎已并入），界面据此列出
  assert.match(view?.warnings.join(' ') ?? '', /credentialsStatus:K/)
})

test('回滚未完成：headline 走 sync 字典专用键（可注入本地化取词器）', () => {
  const report: ApplyItemsResponse = {
    ok: false, applied: [], skipped: [], needsRestart: false, warnings: [],
    restoreId: 'r', rolledBack: true, rollbackFull: false, failed: [], result: {},
  }
  const view = applyItemsReportView(report, zhUiT, (key) => 'SYNC:' + key)
  assert.equal(view?.headline, 'SYNC:syncflow.importRollbackIncomplete')
})

test('旧宿主不返回 rollbackFull：rolledBack=true 仍按「已整体回滚」处理（不误报半回滚）', () => {
  const report: ApplyItemsResponse = {
    ok: false, applied: [], skipped: [], needsRestart: false, warnings: [],
    restoreId: 'r', rolledBack: true, failed: [{ itemId: 'x' }], result: {},
  }
  assert.equal(applyItemsReportView(report, zhUiT)?.kind, 'rolledBack')
})

/* ---------------------- G-34：gist 通道不适合大分区 ---------------------- */

test('G-34：通道=gist 且勾选 sessions → 风险提示键；其它组合 → null', () => {
  assert.equal(gistSessionsRiskKey('gist', ['sessions']), 'mode.gistSessionsWarn')
  assert.equal(gistSessionsRiskKey('gist', ['skills', 'sessions']), 'mode.gistSessionsWarn', '顺序无关')
  assert.equal(gistSessionsRiskKey('git', ['sessions']), null, '非 gist 通道不提示')
  assert.equal(gistSessionsRiskKey('s3', ['sessions']), null)
  assert.equal(gistSessionsRiskKey('gist', ['skills']), null, '没勾 sessions 不提示')
  assert.equal(gistSessionsRiskKey('gist', []), null)
})

test('G-34：gist 表单常驻提示键指向 sync 字典的专用文案', () => {
  assert.equal(GIST_LARGE_SECTION_HINT_KEY, 'cloud.gistLargeSectionHint')
})
