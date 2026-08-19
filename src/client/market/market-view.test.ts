/**
 * m-market-ui：配置市场区块客户端渲染装配层单测（纯函数，node 可测，无需 DOM）。
 *
 * 共享渲染模型函数（marketStatusText / marketListSummary / computeItemBadge /
 * marketItemWarnings / needsReview / toMarketListItem）由本文件 **re-export** 自 Host 权威
 * src/market/view.ts —— 这里验证 re-export 可用 + 硬不变式；客户端专属辅助
 * （filterMarketItems / collectCategories / marketDetailView / marketWarningsLines / formatMarketTime）
 * 在此覆盖其逻辑。
 *
 * 硬约束（设计文档 §1 / §7.2）：供应链警示恒生成、needsReview 恒 true、canImport=valid 且 sections 非空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { MarketItemDetail, MarketListItem } from '../../market/types.ts'
import { zhUiT } from '../../ui/i18n.ts'
import type { ImportPlan, PlanItem } from '../../core/types.ts'
import {
  approvalRows, approvedAdapterSummary, buildApprovedPlan, collectCategories, computeItemBadge,
  defaultApprovals, filterMarketItems, formatMarketTime, isHighRiskAdapter, marketDetailView,
  marketListSummary, marketStatusText, marketWarningsLines, marketItemWarnings, needsReview,
  sourceBadgeKind, isThirdPartyItem, toMarketListItem,
} from './market-view.ts'

/* ---------------------------------------------------------------- 共享渲染模型（re-export 权威） */

function item(overrides: Partial<MarketListItem> & { id: string }): MarketListItem {
  return { name: overrides.id, cacheState: 'none', ...overrides }
}

test('market-view: marketStatusText（共享权威）→ 未配置 / 已添加 N 个', () => {
  assert.match(marketStatusText({ count: 0 }, zhUiT), /尚未添加市场/)
  assert.match(marketStatusText({ count: 2 }, zhUiT), /已添加 2 个市场/)
  // 传入 MarketSummary[] 数组形态也能计数
  assert.match(marketStatusText([{ url: 'u', addedAt: '' }], zhUiT), /已添加 1 个市场/)
})

test('market-view: marketListSummary（共享权威）→ 总数 + 缓存计数', () => {
  const s = marketListSummary(
    [
      item({ id: 'a', cacheState: 'cached' }),
      item({ id: 'b', cacheState: 'fresh' }),
      item({ id: 'c', cacheState: 'none' }),
    ],
    zhUiT,
  )
  assert.equal(s.total, 3)
  assert.equal(s.cached, 1)
  assert.equal(s.fresh, 1)
  assert.equal(s.none, 1)
})

test('market-view: computeItemBadge（共享权威）→ valid/invalid + 分区文本', () => {
  const ok = computeItemBadge(detail({ status: 'valid', sections: ['settings', 'plugins'] }), zhUiT)
  assert.equal(ok.valid, true)
  assert.match(ok.statusText, /校验通过/)
  assert.match(ok.sectionsText, /settings/)
  const bad = computeItemBadge(detail({ status: 'invalid', sections: [] }), zhUiT)
  assert.equal(bad.valid, false)
  assert.match(bad.sectionsText, /未声明分区/)
})

test('market-view: marketItemWarnings（共享权威）恒生成「非官方审核」警示（无论 status）', () => {
  const valid = marketItemWarnings(undefined, 'https://github.com/u/m', '2026-08-16T10:30:00.000Z', zhUiT)
  assert.ok(valid.some((w) => w.includes('非官方审核')))
  const invalid = marketItemWarnings(
    { name: 'x', author: 'alice', provenance: { source: 'https://gh.com', note: '自述' } },
    'https://github.com/u/m',
    '2026-08-16T10:30:00.000Z',
    zhUiT,
  )
  assert.ok(invalid.some((w) => w.includes('非官方审核')))
  assert.ok(invalid.some((w) => w.includes('https://github.com/u/m')))
  assert.ok(invalid.some((w) => w.includes('alice')))
})

test('market-view: needsReview（共享权威）恒 true（供应链警示不让默认信任）', () => {
  assert.equal(needsReview(detail({ status: 'valid' })), true)
  assert.equal(needsReview(detail({ status: 'invalid' })), true)
})

test('market-view: toMarketListItem（共享权威）投影 MarketIndexItem → MarketListItem（带 cacheState）', () => {
  const out = toMarketListItem({ id: 'a', name: 'x', author: 'b', categories: ['c'] }, 'cached')
  assert.equal(out.id, 'a')
  assert.equal(out.name, 'x')
  assert.equal(out.cacheState, 'cached')
  assert.deepEqual(out.categories, ['c'])
})

/* ---------------------------------------------------------------- 客户端专属：来源徽章（阶段 1 条目级来源仓库） */

const OFFICIAL_URL = 'https://github.com/xiajiajun516/dsh-config-market.git'
const THIRD_PARTY_URL = 'https://github.com/alice/dsh-config-market-items.git'

test('market-view: sourceBadgeKind 无 repo（与市场同仓）→ 官方 ok', () => {
  assert.equal(sourceBadgeKind({}, OFFICIAL_URL), 'ok')
  assert.equal(sourceBadgeKind({ repo: undefined }, OFFICIAL_URL), 'ok')
  assert.equal(isThirdPartyItem({}, OFFICIAL_URL), false)
})

test('market-view: sourceBadgeKind repo 为官方默认地址 → 官方 ok', () => {
  assert.equal(sourceBadgeKind({ repo: OFFICIAL_URL }, OFFICIAL_URL), 'ok')
  assert.equal(isThirdPartyItem({ repo: OFFICIAL_URL }, OFFICIAL_URL), false)
})

test('market-view: sourceBadgeKind repo 为第三方仓库 → 第三方 warn', () => {
  assert.equal(sourceBadgeKind({ repo: THIRD_PARTY_URL }, OFFICIAL_URL), 'warn')
  assert.equal(isThirdPartyItem({ repo: THIRD_PARTY_URL }, OFFICIAL_URL), true)
})

test('market-view: sourceBadgeKind 市场被 env 覆盖为预览仓库时，无 repo 条目随市场显示第三方 warn（语义自洽）', () => {
  // 非官方默认地址的 builtinUrl（维护者预览仓库）：无 repo 条目与市场同仓 → 非官方
  assert.equal(sourceBadgeKind({}, THIRD_PARTY_URL), 'warn')
  assert.equal(isThirdPartyItem({}, THIRD_PARTY_URL), true)
})

test('market-view: sourceBadgeKind 有 repo 时 builtinUrl 不参与判定（repo 非官方即 warn）', () => {
  // 即便传入的 builtinUrl 与该 repo 相同，只要 repo 非官方默认地址 → 第三方 warn
  assert.equal(sourceBadgeKind({ repo: THIRD_PARTY_URL }, THIRD_PARTY_URL), 'warn')
})

/* ---------------------------------------------------------------- 客户端专属：搜索 / 类别 */

function detail(overrides: Partial<MarketItemDetail>): MarketItemDetail {
  return {
    id: 'i1', name: 'n', version: '1.0', status: 'valid',
    sections: ['settings'], downloadedAt: '2026-08-16T10:30:00.000Z', warnings: [],
    ...overrides,
  }
}

test('market-view: collectCategories 收集去重类别（含无类别条目）', () => {
  const cats = collectCategories([
    item({ id: 'a', categories: ['插件', '代理'] }),
    item({ id: 'b', categories: ['插件'] }),
    item({ id: 'c' }),
  ])
  assert.deepEqual([...cats].sort(), ['代理', '插件'])
})

test('market-view: filterMarketItems 按名称/作者/描述大小写不敏感匹配', () => {
  const items = [
    item({ id: 'a', name: 'My Plugin', author: 'alice', description: 'cool' }),
    item({ id: 'b', name: 'other', author: 'Bob', description: 'nope' }),
  ]
  assert.equal(filterMarketItems(items, 'plugin', '').length, 1)
  assert.equal(filterMarketItems(items, 'ALice', '').length, 1)
  assert.equal(filterMarketItems(items, 'cooL', '').length, 1)
  assert.equal(filterMarketItems(items, 'zzz', '').length, 0)
})

test('market-view: filterMarketItems 类别过滤 + 组合查询', () => {
  const items = [
    item({ id: 'a', name: 'x', categories: ['插件'] }),
    item({ id: 'b', name: 'x', categories: ['代理'] }),
  ]
  assert.equal(filterMarketItems(items, '', '插件').length, 1)
  assert.equal(filterMarketItems(items, '', '代理').length, 1)
  assert.equal(filterMarketItems(items, '', '不存在').length, 0)
  assert.equal(filterMarketItems(items, 'x', '插件').length, 1)
})

/* ---------------------------------------------------------------- 客户端专属：供应链警示着色 + 详情聚合 */

test('market-view: marketWarningsLines 恒非空且首条为 warn（非官方审核）', () => {
  const valid = marketWarningsLines(detail({ status: 'valid' }), 'https://github.com/u/m')
  const invalid = marketWarningsLines(detail({ status: 'invalid', errors: ['x'] }), 'https://github.com/u/m')
  assert.ok(valid.length > 0)
  assert.equal(valid[0]?.kind, 'warn')
  assert.equal(invalid[0]?.kind, 'warn')
  assert.ok(valid.some((l) => l.text.includes('非官方审核')))
})

test('market-view: marketWarningsLines 含来源 URL / 作者 / provenance（着色 info）', () => {
  const lines = marketWarningsLines(
    detail({ author: 'alice', provenance: { source: 'https://gh.com/alice', note: '自述' } }),
    'https://github.com/u/m',
  )
  const text = lines.map((l) => l.text).join('\n')
  assert.match(text, /https:\/\/github\.com\/u\/m/)
  assert.match(text, /alice/)
  assert.match(text, /https:\/\/gh\.com\/alice/)
  assert.ok(lines.some((l) => l.kind === 'info'))
})

test('market-view: marketDetailView valid + 有分区 → canImport 且带警示/空错误', () => {
  const v = marketDetailView(detail({ status: 'valid', sections: ['settings'] }), 'https://x', true)
  assert.equal(v.canImport, true)
  assert.deepEqual(v.errors, [])
  assert.ok(v.warnings.length > 0)
  assert.equal(v.badge.statusKind, 'ok')
  assert.equal(v.showBack, true)
})

test('market-view: marketDetailView invalid → canImport=false 且 errors 透传、badge error', () => {
  const v = marketDetailView(detail({ status: 'invalid', errors: ['zip 越界', 'checksum 不符'] }), 'https://x', false)
  assert.equal(v.canImport, false)
  assert.deepEqual(v.errors, ['zip 越界', 'checksum 不符'])
  assert.equal(v.badge.statusKind, 'error')
  assert.equal(v.showBack, false)
})

test('market-view: marketDetailView valid 但空分区 → 不可导入（无从导入）', () => {
  const v = marketDetailView(detail({ status: 'valid', sections: [] }), 'https://x', true)
  assert.equal(v.canImport, false)
})

/* ---------------------------------------------------------------- 时间格式化 */

test('market-view: formatMarketTime 合法 ISO → 本地可读；非法/空 → 原样', () => {
  assert.match(formatMarketTime('2026-08-16T10:30:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatMarketTime(''), '')
  assert.equal(formatMarketTime('not-a-date'), 'not-a-date')
})

/* ----------------------------------------------------------------------------
 * 逐分区批准（安全不变式 (c)：高风险分区默认不导入、须逐项显式批准）
 * -------------------------------------------------------------------------- */

function planItem(adapter: string, kind: PlanItem['kind'] = 'Create'): PlanItem {
  return { id: `${adapter}:x`, kind, adapter: adapter as never, description: `分区 ${adapter}`, severity: 'info' }
}

function samplePlan(): ImportPlan {
  return {
    items: [
      planItem('settings'),
      planItem('plugins', 'Install'),
      planItem('agentInstructions'),
      planItem('pluginFiles'),
      planItem('mcp'),
      planItem('skills'),
    ],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: true,
    estimatedActions: { settings: 1, plugins: 1, agentInstructions: 1, pluginFiles: 1, mcp: 1, skills: 1 } as ImportPlan['estimatedActions'],
  }
}

test('market-view: isHighRiskAdapter 覆盖插件/AGENTS.md/预设/会话/MCP/插件文件,其余低风险', () => {
  for (const a of ['pluginFiles', 'agentInstructions', 'agentPresets', 'sessions', 'mcp', 'plugins']) {
    assert.equal(isHighRiskAdapter(a as never), true, `${a} 应为高风险`)
  }
  assert.equal(isHighRiskAdapter('settings'), false)
  assert.equal(isHighRiskAdapter('skills'), false)
  assert.equal(isHighRiskAdapter('providers'), false)
})

test('market-view: defaultApprovals 低风险默认勾选、高风险默认不勾选（严格分层信任）', () => {
  const approvals = defaultApprovals(samplePlan())
  assert.equal(approvals['settings'], true)
  assert.equal(approvals['skills'], true)
  assert.equal(approvals['plugins'], false, 'plugins/Install 默认不导入')
  assert.equal(approvals['agentInstructions'], false, 'AGENTS.md 默认不导入')
  assert.equal(approvals['pluginFiles'], false)
  assert.equal(approvals['mcp'], false)
})

test('market-view: buildApprovedPlan 仅保留已批准分区（subPlan），并重算 needsRestart/estimatedActions', () => {
  const approvals = { settings: true, skills: true, plugins: false, agentInstructions: false, pluginFiles: false, mcp: false }
  const sub = buildApprovedPlan(samplePlan(), approvals)
  const adapters = sub.items.map((i) => i.adapter)
  assert.deepEqual([...adapters].sort(), ['settings', 'skills'].sort())
  assert.equal(sub.needsRestart, false, '已批准项均为低风险 → 不再需要重启')
  assert.deepEqual(sub.estimatedActions, { settings: 1, skills: 1 })
  assert.equal(sub.globalStrategy, 'merge')
  assert.deepEqual(sub.missingSecrets, [])
  assert.deepEqual(sub.pathMappings, [])
})

test('market-view: buildApprovedPlan 批准含 Install 的高风险分区 → needsRestart=true', () => {
  const approvals = { settings: false, skills: true, plugins: true, agentInstructions: false, pluginFiles: false, mcp: false }
  const sub = buildApprovedPlan(samplePlan(), approvals)
  assert.ok(sub.items.some((i) => i.adapter === 'plugins'))
  assert.equal(sub.needsRestart, true, '批准 plugins/Install → needsRestart')
})

test('market-view: buildApprovedPlan 全未批准 → 空 items（无可导入）', () => {
  const sub = buildApprovedPlan(samplePlan(), {})
  assert.equal(sub.items.length, 0)
})

test('market-view: approvedAdapterSummary 统计 selected/canImport/高风险计数', () => {
  const approvals = { settings: true, skills: true, plugins: false, agentInstructions: false, pluginFiles: false, mcp: false }
  const s = approvedAdapterSummary(samplePlan(), approvals)
  assert.equal(s.total, 6)
  assert.equal(s.selected, 2)
  assert.equal(s.canImport, true)
  assert.equal(s.highRiskTotal, 4) // plugins/agentInstructions/pluginFiles/mcp
  assert.equal(s.highRiskSelected, 0)
  const none = approvedAdapterSummary(samplePlan(), {})
  assert.equal(none.canImport, false)
})

test('market-view: approvalRows 逐分区行（adapter + 项数 + 风险 + 勾选态）', () => {
  const approvals = { settings: true, plugins: false }
  const rows = approvalRows(samplePlan(), approvals)
  const settings = rows.find((r) => r.adapter === 'settings')
  assert.ok(settings)
  assert.equal(settings.highRisk, false)
  assert.equal(settings.approved, true)
  assert.equal(settings.itemCount, 1)
  const pluginsR = rows.find((r) => r.adapter === 'plugins')
  assert.ok(pluginsR)
  assert.equal(pluginsR.highRisk, true)
  assert.equal(pluginsR.approved, false)
})
