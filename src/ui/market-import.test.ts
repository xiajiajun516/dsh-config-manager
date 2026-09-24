/**
 * 市场通道导入审阅模型测试（node:test，零依赖）。
 *
 * 关注两件事，都是市场特有、导入页没有的：
 *  1. 默认选择**与导入页一致**（全选，含高风险分区）—— 2026-09 用户决定取消
 *     「高风险默认不勾」的严格分层信任默认；
 *  2. 逐项摘要 / 已勾选高风险清单随勾选实时变化（就地警示的输入）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterPickerNodes, marketChangeRows, marketConflictItems, marketDecisions,
  marketPickerNodes, marketReviewSteps, marketSectionSummaries, marketSelectionSummary,
  marketUnitIndex, nextMarketStep, prevMarketStep, selectedHighRiskSections,
} from './market-import.ts'
import { effectiveImportSelection, planAdapters, type Selection } from './selection-model.ts'

/** 组件真正走的入口：市场通道没有自己的默认态（null 态 → 与导入页同一个默认全选）。 */
function defaultMarketSelection(plan: ImportPlan): Selection {
  const sel = effectiveImportSelection(plan, 'market-item.zip', null)
  assert.ok(sel !== null)
  return sel
}
import type { ImportPlan, PlanItem } from '../core/types.ts'
import type { SectionId } from '../schema/types.ts'

function item(partial: Partial<PlanItem> & { id: string; adapter: SectionId }): PlanItem {
  return { kind: 'Create', description: partial.id, severity: 'info', ...partial } as PlanItem
}

const PLAN: ImportPlan = {
  items: [
    item({ id: 'settings:root', adapter: 'settings' }),
    item({ id: 'skills:bar/SKILL.md', unitId: 'skills:bar', adapter: 'skills' }),
    item({ id: 'skills:bar/ref.md', unitId: 'skills:bar', adapter: 'skills' }),
    item({ id: 'skills:flat.md', unitId: 'skills:flat.md', adapter: 'skills' }),
    item({ id: 'plugin:alpha', adapter: 'plugins', kind: 'Install' }),
    item({ id: 'mcp:server-a', adapter: 'mcp' }),
    item({ id: 'prompt:p', adapter: 'prompts', kind: 'Conflict' }),
    item({ id: 'x:warn', adapter: 'settings', kind: 'Warning' }),
    item({ id: 'x:err', adapter: 'settings', kind: 'Error' }),
  ],
  globalStrategy: 'merge',
  pathMappings: [],
  missingSecrets: [],
  needsRestart: true,
  estimatedActions: {} as ImportPlan['estimatedActions'],
}

test('marketPickerNodes：与导入页同一个 sectionsFromPlan（技能 bundle 归并为一个单元）', () => {
  const nodes = marketPickerNodes(PLAN)
  assert.deepEqual(nodes.map((n) => n.section), ['settings', 'skills', 'plugins', 'mcp', 'prompts'])
  const skills = nodes.find((n) => n.section === 'skills')
  assert.deepEqual(skills?.units.map((u) => u.id), ['skills:bar', 'skills:flat.md'], '两个逐文件计划项归并成一个技能单元')
  assert.deepEqual(marketPickerNodes(null), [], '无计划 → 空树（不抛错）')
})

test('defaultMarketSelection：与导入页一致 —— 全选，高风险分区同样默认勾选（2026-09 决策）', () => {
  const sel = defaultMarketSelection(PLAN)
  assert.deepEqual(sel.sections, planAdapters(PLAN), '含 plugins / mcp 等高风险分区')
  assert.deepEqual(sel.excluded, [], '默认没有任何排除')
  const summary = marketSelectionSummary(PLAN, sel)
  assert.equal(summary.canImport, true)
  assert.equal(summary.selected, 7, '9 项计划里 2 项是纯诊断，其余 7 项默认全部勾选')
})

test('marketSelectionSummary：诊断项不进列表（Warning/Error 既不计数也不写入）', () => {
  const sel = defaultMarketSelection(PLAN)
  const s = marketSelectionSummary(PLAN, sel)
  assert.equal(s.total, 7, '9 项计划里 2 项是纯诊断')
  assert.equal(s.selected, 7)
  assert.equal(s.willChange, 7, '本计划没有 Skip 项 → 全部计入「将改动」')
  assert.equal(s.unchanged, 0)
  assert.equal(s.conflicts, 1)
  assert.equal(s.highRiskSelected, 2, 'plugins + mcp')
})

test('marketSelectionSummary：取消勾选后计数与 canImport 同步（K-07「全不选」守卫的输入）', () => {
  const sel = { sections: [] as SectionId[], excluded: [] as string[] }
  const s = marketSelectionSummary(PLAN, sel)
  assert.equal(s.selected, 0)
  assert.equal(s.canImport, false)
  assert.equal(s.highRiskSelected, 0)
})

test('selectedHighRiskSections：只报告「确有勾选项」的高风险分区（未勾不警示）', () => {
  const all = defaultMarketSelection(PLAN)
  assert.deepEqual(selectedHighRiskSections(PLAN, all), ['plugins', 'mcp'])
  const none = { sections: [] as SectionId[], excluded: [] as string[] }
  assert.deepEqual(selectedHighRiskSections(PLAN, none), [], '高风险分区未勾选 → 不触发就地警示')
  // 只勾 plugins（单元级）：mcp 不再出现在警示里
  const onlyPlugins = { sections: ['plugins'] as SectionId[], excluded: [] }
  assert.deepEqual(selectedHighRiskSections(PLAN, onlyPlugins), ['plugins'])
})

test('marketChangeRows：逐项摘要 —— 名称剥前缀、诊断项剔除、未勾选标 selected=false', () => {
  const sel = { sections: ['plugins'] as SectionId[], excluded: [] }
  const rows = marketChangeRows(PLAN, sel)
  assert.equal(rows.length, 7, '不含 Warning/Error')
  const plugins = rows.find((r) => r.adapter === 'plugins')
  assert.equal(plugins?.label, 'alpha', 'plugin:<name> → 剥前缀显示（与级联树同一口径）')
  assert.equal(plugins?.selected, true)
  assert.equal(plugins?.highRisk, true)
  const settings = rows.find((r) => r.adapter === 'settings')
  assert.equal(settings?.selected, false, '未勾选分区 → 该行标记为「不导入」')
  const skill = rows.find((r) => r.label === 'bar')
  assert.equal(skill?.selected, false)
})

test('marketConflictItems / marketDecisions：冲突决策交给宿主重算计划（不在前端改 kind）', () => {
  const conflicts = marketConflictItems(PLAN)
  assert.deepEqual(conflicts.map((c) => c.id), ['prompt:p'])
  assert.deepEqual(marketDecisions({ 'prompt:p': 'useImported' }), {
    strategy: 'merge', resolutions: { 'prompt:p': 'useImported' }, pathMappings: [],
  })
  assert.deepEqual(marketConflictItems(null), [])
})

/* ----------------------------------------------------------------------------------
   P1（2026-09）：弹窗内分步 + 逐项摘要降维 + 选择器筛选
   ---------------------------------------------------------------------------------- */

test('marketReviewSteps：有冲突才有「冲突」步；next/prev 在首尾夹紧不越界', () => {
  assert.deepEqual(marketReviewSteps(false), ['preview', 'select', 'confirm', 'result'])
  assert.deepEqual(marketReviewSteps(true), ['preview', 'select', 'conflicts', 'confirm', 'result'])

  assert.equal(nextMarketStep('preview', false), 'select')
  assert.equal(nextMarketStep('select', true), 'conflicts', '有冲突时选完内容先解决冲突')
  assert.equal(nextMarketStep('select', false), 'confirm', '无冲突时直接确认')
  assert.equal(nextMarketStep('result', true), 'result', '末步不再前进')
  assert.equal(prevMarketStep('preview', true), 'preview', '首步不再后退')
  assert.equal(prevMarketStep('confirm', true), 'conflicts')
  assert.equal(prevMarketStep('confirm', false), 'select')
})

test('marketUnitIndex：按单元归并「将改动 / 已一致 / 未勾选 / 高风险」', () => {
  const plan: ImportPlan = {
    ...PLAN,
    items: [
      item({ id: 'skills:bar/SKILL.md', unitId: 'skills:bar', adapter: 'skills' }),
      item({ id: 'skills:bar/ref.md', unitId: 'skills:bar', adapter: 'skills', kind: 'Skip' }),
      item({ id: 'skills:solo/x.md', unitId: 'skills:solo', adapter: 'skills' }),
      item({ id: 'plugin:alpha', adapter: 'plugins', kind: 'Install' }),
    ],
  }
  const index = marketUnitIndex(plan, { sections: ['skills'], excluded: ['skills:solo'] })
  assert.equal(index.get('skills:bar')?.willChange, 1, '两文件里一个将改动、一个已一致')
  assert.equal(index.get('skills:bar')?.unchanged, 1)
  assert.equal(index.get('skills:bar')?.selected, true)
  assert.equal(index.get('skills:bar')?.highRisk, false)
  assert.equal(index.get('skills:solo')?.selected, false, '被排除的单元 → 不导入')
  assert.equal(index.get('skills:solo')?.willChange, 0)
  assert.equal(index.get('plugin:alpha')?.selected, false, '未勾选分区 → 不导入')
  assert.equal(index.get('plugin:alpha')?.highRisk, true, '高风险分区照样标记（就地警示要用）')
})

test('filterPickerNodes：四档筛选共用同一份单元判定；不可细分分区不被藏掉', () => {
  const plan: ImportPlan = {
    ...PLAN,
    items: [
      ...PLAN.items,
      item({ id: 'settings:other', adapter: 'settings', kind: 'Skip' }),
    ],
  }
  const ns = marketPickerNodes(plan)
  const index = marketUnitIndex(plan, { sections: ['plugins'], excluded: [] })

  assert.deepEqual(filterPickerNodes(ns, index, 'all').length, ns.length, 'all 原样返回')
  const willChange = filterPickerNodes(ns, index, 'willChange')
  assert.deepEqual(willChange.map((n) => n.section), ['plugins'], '只有被勾选且会写盘的单元才留下')
  assert.equal(
    filterPickerNodes(ns, index, 'willChange').find((n) => n.section === 'skills'),
    undefined,
    '未勾选分区即便内容会变也不在「将改动」里（口径 = 实际会写什么）',
  )
  const highRisk = filterPickerNodes(ns, index, 'highRisk')
  assert.deepEqual(highRisk.map((n) => n.section), ['plugins', 'mcp'])
  const unselected = filterPickerNodes(ns, index, 'unselected')
  assert.ok(unselected.every((n) => n.section !== 'plugins'), '已勾选的 plugins 不在「未勾选」里')
  assert.ok(unselected.some((n) => n.section === 'skills'))

  const flat: Parameters<typeof filterPickerNodes>[0] = [{ section: 'settings', count: 3, sizeBytes: 0, units: [] }]
  assert.equal(filterPickerNodes(flat, index, 'highRisk').length, 1, '不可细分分区在任何筛选下都保留')
})

test('marketSectionSummaries：一行一个分区（逐项摘要降维），高风险分区照样标出', () => {
  const rows = marketSectionSummaries(PLAN, { sections: ['plugins', 'skills'], excluded: [] })
  const plugins = rows.find((r) => r.section === 'plugins')
  assert.equal(plugins?.willChange, 1)
  assert.equal(plugins?.highRisk, true)
  const skills = rows.find((r) => r.section === 'skills')
  assert.equal(skills?.totalUnits, 2, '技能 bundle 归并成 2 个单元')
  assert.equal(skills?.selectedUnits, 2)
  assert.equal(skills?.willChange, 3, '三个逐文件计划项都算「将改动」')
  const mcp = rows.find((r) => r.section === 'mcp')
  assert.equal(mcp?.selectedUnits, 0, '未勾选分区 → 已选 0/1')
  assert.equal(mcp?.highRisk, true)
})

