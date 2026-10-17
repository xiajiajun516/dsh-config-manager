/**
 * 导出内容选择模型（Phase 1）—— 契约与回归。
 *
 * 断言的核心是三条**用户可见**的语义：
 *  1. 稀疏表示等价于全选（默认什么都不排除 → 一个单元都不少）；
 *  2. 「分区勾选但单元全被排除」= 该分区不导出（绝不产出空载荷分区）；
 *  3. lockedWith 原子组同步（issue #35：pnpm-workspace ↔ patch 文件拆开会让目标机 pnpm 全灭）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPluginPendingChecks, buildExportRequest, buildSelectedPlan, defaultSelection,
  defaultSelectionFromPlan, effectiveImportPlan, effectiveImportSelection, filterSections,
  filterPluginTree, groupPickState, groupSelectedCount, groupUnits, HIGH_RISK_ADAPTERS, isHighRiskAdapter,
  isPlanItemExcluded, isPluginTreeSection, isUnitSelected, PLUGIN_TREE_SECTIONS,
  pluginEntryLeaves, pluginEntryPickState, pluginEntrySelectedCount, pluginEntryUnreadSections, pluginTree,
  pluginEntryTotalCount, pluginTreeLeafCount, pluginTreePickState, pluginTreeSelectedCount, pluginTreeTotalCount,
  pluginTreeUnreadSections,
  togglePluginEntry, togglePluginTree,
  planWriteSections,
  tailWeightedEllipsis, pickerSummary,
  sectionCountState, sectionExpandable, sectionPickState, sectionsFromPlan, sectionsFromPreview, selectedUnitCount, selectAll,
  selectionHasItems, toggleSection, toggleUnit, toggleUnitGroup, unitChecked, unitLabel,
  visibleUnits, UNIT_RENDER_LIMIT,
  type ImportSelectionState, type Selection, type SelectionSection,
} from './selection-model.ts'
import { makePlan, makePlanItem } from './test-helpers.ts'
import type { SectionId } from '../schema/types.ts'
import type { ImportPlan, PlanItem } from '../core/types.ts'

function node(section: SectionId, units: { id: string; label?: string; sizeBytes?: number; lockedWith?: string[] }[], sizeBytes = 100): SelectionSection {
  return {
    section,
    count: units.length,
    sizeBytes,
    units: units.map((u) => ({ id: u.id, label: u.label ?? u.id, sizeBytes: u.sizeBytes ?? 10, ...(u.lockedWith !== undefined ? { lockedWith: u.lockedWith } : {}) })),
  }
}

const NODES: SelectionSection[] = [
  node('skills', [{ id: 'skills:a' }, { id: 'skills:b' }, { id: 'skills:c' }], 300),
  node('plugins', [{ id: 'plugin:x' }, { id: 'plugin:y' }], 200),
  node('settings', [], 50),
]
const ALL: SectionId[] = ['skills', 'plugins', 'settings']

test('默认全选：excluded 为空表示没有任何例外，每个单元都是勾选的', () => {
  const sel = defaultSelection(ALL)
  assert.deepEqual(sel, { sections: ALL, excluded: [] })
  for (const n of NODES) for (const u of n.units) assert.equal(isUnitSelected(sel, u.id), true)
  assert.equal(sectionPickState(sel, NODES[0]!), 'all')
  assert.equal(sectionPickState(sel, NODES[2]!), 'all')
})

test('全选状态的请求参数不下发 includeItems（保持「缺省 = 全量」的向后兼容语义）', () => {
  const req = buildExportRequest(defaultSelection(ALL), NODES)
  assert.deepEqual(req, { only: ALL })
  assert.equal('includeItems' in req, false)
})

test('部分勾选：只对部分勾选的分区下发白名单，其余分区不下发', () => {
  let sel = defaultSelection(ALL)
  sel = toggleUnit(sel, NODES, 'skills:b', false)
  const req = buildExportRequest(sel, NODES)
  assert.deepEqual(req.only, ALL)
  assert.deepEqual(req.includeItems, { skills: ['skills:a', 'skills:c'] })
  assert.equal(sectionPickState(sel, NODES[0]!), 'partial')
})

test('分区勾选但单元全被排除 → 该分区不导出（绝不产出空载荷分区）', () => {
  let sel = defaultSelection(ALL)
  sel = toggleSection(sel, NODES[0]!, false)
  sel = toggleSection(sel, NODES[0]!, true)      // 重新勾选分区，但单元仍是「无」
  sel = toggleUnit(sel, NODES, 'skills:a', false)
  sel = toggleUnit(sel, NODES, 'skills:b', false)
  sel = toggleUnit(sel, NODES, 'skills:c', false)
  assert.equal(sectionPickState(sel, NODES[0]!), 'none')
  const req = buildExportRequest(sel, NODES)
  assert.equal(req.only.includes('skills'), false, '一个单元都没勾的分区不得出现在 only 里')
  assert.deepEqual(req.only, ['plugins', 'settings'])
})

test('取消整个分区：分区移出 only，且单元例外被清理（重新勾选时是干净的「全选」）', () => {
  let sel = defaultSelection(ALL)
  sel = toggleUnit(sel, NODES, 'plugin:x', false)
  sel = toggleSection(sel, NODES[1]!, false)
  assert.deepEqual([...sel.excluded].sort(), ['plugin:x', 'plugin:y'])
  sel = toggleSection(sel, NODES[1]!, true)
  assert.equal(sectionPickState(sel, NODES[1]!), 'all', '重新勾选分区后不得残留旧的单元排除')
  assert.deepEqual(sel.excluded, [])
})

test('lockedWith 原子组：勾选/取消任一成员，全组同步', () => {
  const nodes: SelectionSection[] = [node('plugins', [
    { id: 'plugins:pnpm-workspace', lockedWith: ['plugins:pnpm-workspace', 'plugins:patch:p'] },
    { id: 'plugins:patch:p', lockedWith: ['plugins:pnpm-workspace', 'plugins:patch:p'] },
    { id: 'plugin:z' },
  ])]
  let sel = defaultSelection(['plugins'])
  sel = toggleUnit(sel, nodes, 'plugins:patch:p', false)
  assert.deepEqual(sel.excluded.sort(), ['plugins:patch:p', 'plugins:pnpm-workspace'])
  sel = toggleUnit(sel, nodes, 'plugins:pnpm-workspace', true)
  assert.deepEqual(sel.excluded, [], '勾选组内任一成员必须把整组带回')
  assert.equal(isUnitSelected(sel, 'plugins:patch:p'), true)
})

test('勾选单元时自动勾选所属分区（不产生「勾了条目却没选分区」的空转状态）', () => {
  const sel = defaultSelection([])
  const next = toggleUnit(sel, NODES, 'skills:a', true)
  assert.deepEqual(next.sections, ['skills'])
})

test('不可细分分区（units 为空）退化为整体开关，且不污染 excluded', () => {
  const sel = toggleSection(defaultSelection([]), NODES[2]!, true)
  assert.deepEqual(sel, { sections: ['settings'], excluded: [] })
  const req = buildExportRequest(sel, NODES)
  assert.deepEqual(req, { only: ['settings'] })
})

test('selectAll(true) 等价于默认全选；selectAll(false) 清空一切', () => {
  const on = selectAll(NODES, true)
  assert.deepEqual(buildExportRequest(on, NODES), { only: ALL })
  const off = selectAll(NODES, false)
  assert.deepEqual(buildExportRequest(off, NODES), { only: [] })
})

test('回归：全不选之后**渲染层**也必须全部未勾选（含清单已加载的分区）', () => {
  const off = selectAll(NODES, false)
  for (const n of NODES) {
    assert.equal(sectionPickState(off, n), 'none', `${n.section} 应显示为未勾选`)
    assert.equal(selectedUnitCount(off, n), 0, `${n.section} 的已选计数应为 0`)
  }
  assert.equal(pickerSummary(off, NODES).sections, 0)
  assert.equal(pickerSummary(off, NODES).units, 0)
  const on = selectAll(NODES, true)
  for (const n of NODES) {
    assert.equal(sectionPickState(on, n), 'all')
    if (n.units.length > 0) assert.equal(selectedUnitCount(on, n), n.units.length)
  }
})

test('回归：分区被整体取消后，其**已加载清单**的子单元不得仍显示为勾选', () => {
  const withUnits = node('skills', [{ id: 'skills:a' }, { id: 'skills:b' }])
  const off = selectAll([withUnits], false)
  assert.equal(sectionPickState(off, withUnits), 'none')
  assert.equal(selectedUnitCount(off, withUnits), 0)
  const partial = toggleUnit({ sections: ['skills'], excluded: [] }, [withUnits], 'skills:a', false)
  assert.equal(sectionPickState(partial, withUnits), 'partial')
  assert.equal(selectedUnitCount(partial, withUnits), 1)
})

test('回归：单元级勾选态必须看所属分区 —— 全不选后子项一律未勾选（unitChecked）', () => {
  const withUnits = node('settings', [{ id: 'settings:a' }, { id: 'settings:b' }])
  // 稀疏表示 {sections:[], excluded:[]}：只看 excluded 会误判成「全勾」——
  // 用户实测到的「点全不选后分区已是 0/13、13 个子项却还勾着」正是这个
  assert.equal(unitChecked({ sections: [], excluded: [] }, 'settings', 'settings:a'), false)
  assert.equal(unitChecked(selectAll([withUnits], false), 'settings', 'settings:a'), false)
  // 分区勾上才是「未显式排除 = 勾选」
  const on = defaultSelection(['settings'])
  assert.equal(unitChecked(on, 'settings', 'settings:a'), true)
  const oneOff = toggleUnit(on, [withUnits], 'settings:a', false)
  assert.equal(unitChecked(oneOff, 'settings', 'settings:a'), false)
  assert.equal(unitChecked(oneOff, 'settings', 'settings:b'), true)
  // 二级分组同口径：分区没勾时分组既不是 all 也不报已选数
  const units = [
    { id: 'sessions:p/1', label: 't1', sizeBytes: 1, group: 'ws-a' },
    { id: 'sessions:p/2', label: 't2', sizeBytes: 1, group: 'ws-a' },
  ]
  const group = groupUnits(units)[0]!
  assert.equal(groupPickState({ sections: [], excluded: [] }, group, 'sessions'), 'none')
  assert.equal(groupSelectedCount({ sections: [], excluded: [] }, group, 'sessions'), 0)
  assert.equal(groupSelectedCount({ sections: ['sessions'], excluded: [] }, group, 'sessions'), 2)
})

test('planWriteSections：只有本次真的会写盘的分区才需要路径映射', () => {
  const plan: ImportPlan = makePlan({
    items: [
      makePlanItem({ id: 'workspace:w1', adapter: 'workspaces', kind: 'Create' }),
      makePlanItem({ id: 'plugin:x', adapter: 'plugins', kind: 'Skip' }),
      makePlanItem({ id: 'mcp:s1', adapter: 'mcp', kind: 'Update' }),
      makePlanItem({ id: 'settings:note', adapter: 'settings', kind: 'Warning' }),
    ],
    missingSecrets: [],
    needsRestart: false,
  })
  assert.deepEqual([...planWriteSections(plan)].sort(), ['mcp', 'workspaces'], 'Skip / Warning 不算写盘')
  // 取消勾选后传**裁剪后的计划**：该分区不再要求映射
  const cropped = buildSelectedPlan(plan, { sections: ['mcp'], excluded: [] })
  assert.deepEqual([...planWriteSections(cropped)], ['mcp'])
})

test('pickerSummary：计数与体积随勾选变化，且不会超出实际导出范围', () => {
  const full = pickerSummary(defaultSelection(ALL), NODES)
  assert.equal(full.sections, 3)
  assert.equal(full.units, 5 + 1)
  assert.equal(full.totalUnits, 6)
  assert.equal(full.sizeBytes, 300 + 200 + 50)

  let sel = defaultSelection(ALL)
  sel = toggleUnit(sel, NODES, 'skills:b', false)
  const partial = pickerSummary(sel, NODES)
  assert.equal(partial.units, full.units - 1)
  assert.equal(partial.sizeBytes, 200 + 50 + Math.round(300 * (2 / 3)))
})

test('selectedUnitCount：不可细分分区退回宿主的 count', () => {
  const nodeCount: SelectionSection = { section: 'settings', count: 7, sizeBytes: 10, units: [] }
  assert.equal(selectedUnitCount({ sections: [], excluded: [] }, nodeCount), 0)
  assert.equal(selectedUnitCount({ sections: ['settings'], excluded: [] }, nodeCount), 7)
})

test('filterSections：按分区名或单元名/副标题过滤；命中分区时保留其全部单元', () => {
  assert.equal(filterSections(NODES, '').length, 3)
  const bySection = filterSections(NODES, 'SKILL')
  assert.deepEqual(bySection.map((n) => n.section), ['skills'])
  assert.equal(bySection[0]?.units.length, 3, '按分区名命中时应保留全部单元')

  const nodesWithDetail: SelectionSection[] = [node('workspaces', [{ id: 'workspace:w1', label: 'OpsFlow' }]), node('skills', [{ id: 'skills:a' }])]
  const byDetail = filterSections(nodesWithDetail, 'opsflow')
  assert.deepEqual(byDetail.map((n) => n.section), ['workspaces'])
  assert.deepEqual(byDetail[0]?.units.map((u) => u.id), ['workspace:w1'])
})

test('sectionsFromPreview：宿主响应 → 选择模型（items 缺省 = 不可细分）', () => {
  const nodes = sectionsFromPreview([
    { section: 'skills', count: 2, sizeBytes: 20, items: [{ id: 'skills:a', label: 'a', sizeBytes: 10 }] },
    { section: 'settings', count: 5, sizeBytes: 50 },
  ])
  assert.deepEqual(nodes[0]?.units.map((u) => u.id), ['skills:a'])
  assert.deepEqual(nodes[1]?.units, [])
})

/* ==================================================================================
   导入侧（Phase 2）
   ================================================================================== */

/** 选择字面量助手（避免 TS 把 sections 推成 string[]）。 */
function selOf(sections: SectionId[], excluded: string[] = []): Selection {
  return { sections, excluded }
}

function item(partial: Partial<PlanItem> & { id: string; adapter: SectionId }): PlanItem {
  return { kind: 'Create', description: partial.id, severity: 'info', ...partial } as PlanItem
}

/** 一个技能 bundle = 两个逐文件计划项共用同一 unitId（这就是必须有 unitId 的原因）。 */
const PLAN: ImportPlan = {
  items: [
    item({ id: 'skills:bar/SKILL.md', unitId: 'skills:bar', adapter: 'skills' }),
    item({ id: 'skills:bar/ref.md', unitId: 'skills:bar', adapter: 'skills' }),
    item({ id: 'skills:flat.md', unitId: 'skills:flat.md', adapter: 'skills' }),
    item({ id: 'plugin:dsh-x', adapter: 'plugins', kind: 'Install' }),
    item({ id: 'secret:API_KEY', adapter: 'credentialsStatus', kind: 'MissingSecret', severity: 'warning' }),
    item({ id: 'secret:OTHER', adapter: 'credentialsStatus', kind: 'MissingSecret', severity: 'warning' }),
    item({ id: 'warn:diag', adapter: 'plugins', kind: 'Warning', severity: 'warning' }),
    item({ id: 'err:bad', adapter: 'skills', kind: 'Error', severity: 'error' }),
  ],
  globalStrategy: 'merge',
  pathMappings: [],
  missingSecrets: [{ ref: 'API_KEY', required: true }, { ref: 'OTHER', required: true }],
  needsRestart: true,
  estimatedActions: { skills: 3, plugins: 1, credentialsStatus: 2 } as ImportPlan['estimatedActions'],
}

test('sectionsFromPlan：逐文件计划项按 unitId 归并成一个技能单元；诊断项不进树', () => {
  const nodes = sectionsFromPlan(PLAN)
  const skills = nodes.find((n) => n.section === 'skills')
  assert.deepEqual(skills?.units.map((u) => u.id), ['skills:bar', 'skills:flat.md'], '两个文件必须合成一个 bundle 单元')
  assert.equal(skills?.units[0]?.label, 'bar', '单元展示名剥掉分区前缀')
  assert.equal(nodes.some((n) => n.units.some((u) => u.id === 'warn:diag')), false, 'Warning 是诊断项，不该可勾选')
  assert.equal(nodes.some((n) => n.units.some((u) => u.id === 'err:bad')), false, 'Error 是诊断项，不该可勾选')
  assert.deepEqual(nodes.map((n) => n.section), ['skills', 'plugins', 'credentialsStatus'])
})

test('sectionsFromPlan：宿主给的展示名/分组优先（sessions 显示会话标题而不是目录名）', () => {
  const plan: ImportPlan = {
    items: [
      {
        id: 'sessions:--D-P--/u1/session.jsonl.zstd',
        unitId: 'sessions:--D-P--/u1',
        adapter: 'sessions',
        kind: 'Create',
        description: 'x',
        severity: 'info',
        label: '讨论备份导入导出优化方案',
        group: 'dsh-config-manager',
      },
      {
        id: 'sessions:--D-P--/u2/session.jsonl.zstd',
        unitId: 'sessions:--D-P--/u2',
        adapter: 'sessions',
        kind: 'Create',
        description: 'x',
        severity: 'info',
        // 无 label（缓存里没有标题）→ 退回目录名，不编造
        group: 'dsh-config-manager',
      },
    ],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: {} as ImportPlan['estimatedActions'],
  };
  const units = sectionsFromPlan(plan)[0]!.units;
  assert.equal(units[0]!.label, '讨论备份导入导出优化方案', '有宿主展示名就用它，而不是会话目录名');
  assert.equal(units[0]!.group, 'dsh-config-manager');
  assert.equal(units[0]!.id, 'sessions:--D-P--/u1', 'id 不变（勾选契约只认 id）');
  assert.equal(units[1]!.label, '--D-P--/u2', '缺 label → 退回 unitLabel，不编造');
  assert.equal(units[1]!.group, 'dsh-config-manager');
})
test('defaultSelectionFromPlan：本地导入默认全勾；市场口径（highRiskDefaultOff）高风险不勾', () => {
  assert.deepEqual(defaultSelectionFromPlan(PLAN).sections, ['skills', 'plugins', 'credentialsStatus'])
  const market = defaultSelectionFromPlan(PLAN, { highRiskDefaultOff: true })
  assert.deepEqual(market.sections, ['skills', 'credentialsStatus'], 'plugins 属高风险，默认不勾')
})

test('buildSelectedPlan：排除一个 bundle 单元 → 其**全部**成员项一并消失', () => {
  const sub = buildSelectedPlan(PLAN, selOf(defaultSelectionFromPlan(PLAN).sections, ['skills:bar']))
  const ids = sub.items.map((i) => i.id)
  assert.equal(ids.includes('skills:bar/SKILL.md'), false)
  assert.equal(ids.includes('skills:bar/ref.md'), false, '单元内两个文件必须同时被排除（不可拆散）')
  assert.ok(ids.includes('skills:flat.md'))
})

test('buildSelectedPlan：needsRestart / estimatedActions 必须随选择重算（不能沿用整份计划）', () => {
  const all = buildSelectedPlan(PLAN, defaultSelectionFromPlan(PLAN))
  assert.equal(all.needsRestart, true, '含 Install → 需要重启')

  const noPlugins = buildSelectedPlan(PLAN, selOf(['skills', 'credentialsStatus']))
  assert.equal(noPlugins.needsRestart, false, '取消插件后不得再提示「需重启」')
  // 口径与 analyzer 完全一致：只跳过 Skip/Warning（Error 项同样计入 —— 宁可高估也不与预览口径分叉）
  assert.deepEqual(noPlugins.estimatedActions, { skills: 4, credentialsStatus: 2 }, 'estimatedActions 只统计仍在计划里的项（跳过 Warning）')
})

test('buildSelectedPlan：missingSecrets 跟随选择（取消的凭据不再索要密钥）', () => {
  const sub = buildSelectedPlan(PLAN, selOf(['skills', 'plugins', 'credentialsStatus'], ['secret:API_KEY']))
  assert.deepEqual(sub.missingSecrets.map((s) => s.ref), ['OTHER'])
  assert.equal(sub.items.some((i) => i.id === 'secret:API_KEY'), false)
})

test('isPlanItemExcluded：未勾选整个分区 = 该分区所有项被排除', () => {
  const sel = selOf(['skills'])
  assert.equal(isPlanItemExcluded(item({ id: 'plugin:x', adapter: 'plugins' }), sel), true)
  assert.equal(isPlanItemExcluded(item({ id: 'skills:a', unitId: 'skills:a', adapter: 'skills' }), sel), false)
})

test('effectiveImportSelection：换了 ZIP 的陈旧选择必须失效（否则导入会静默变成什么都没做）', () => {
  const stale: ImportSelectionState = { zipPath: 'old.zip', selection: { sections: ['settings'], excluded: [] } }
  // 陈旧：新计划的 adapter 都不在 sections 里 → 若沿用就什么都不导
  const reused = effectiveImportPlan(PLAN, 'new.zip', stale)
  assert.equal(reused?.items.length, PLAN.items.length, '陈旧选择必须回落到默认全选')
  assert.deepEqual(effectiveImportSelection(PLAN, 'new.zip', stale)?.sections, ['skills', 'plugins', 'credentialsStatus'])

  // 同一个 ZIP：用户的选择必须生效
  const fresh: ImportSelectionState = { zipPath: 'new.zip', selection: { sections: ['skills'], excluded: [] } }
  assert.deepEqual(effectiveImportSelection(PLAN, 'new.zip', fresh)?.sections, ['skills'])
  assert.equal(effectiveImportPlan(PLAN, 'new.zip', fresh)?.items.some((i) => i.adapter === 'plugins'), false)

  // 未选择 → 默认全选
  assert.equal(effectiveImportPlan(PLAN, 'new.zip', null)?.items.length, PLAN.items.length)
})

test('visibleUnits：真实规模展开即全量（UI-15 修正后）；只有超大分区才折叠', () => {
  // 真实会话库实测口径：sessions ≈ 660 个单元 → 必须一次全渲染
  const units = Array.from({ length: 631 }, (_, i) => ({ id: `s:${i}`, label: `session-${i}`, sizeBytes: 1 }))
  const real = visibleUnits(units, false)
  assert.equal(real.shown.length, 631, '真实规模不该被「显示全部」挡一次（用户会误读成只有这些）')
  assert.equal(real.hidden, 0)
  assert.equal(UNIT_RENDER_LIMIT, 1000)

  // 超过上限：才折叠到上限 + 提供入口
  const huge = Array.from({ length: UNIT_RENDER_LIMIT + 20 }, (_, i) => ({ id: `s:${i}`, label: `session-${i}`, sizeBytes: 1 }))
  const first = visibleUnits(huge, false)
  assert.equal(first.shown.length, UNIT_RENDER_LIMIT)
  assert.equal(first.hidden, 20)
  assert.equal(first.shown[0]?.id, 's:0', '从头部开始渲染（顺序不变）')
  const all = visibleUnits(huge, true)
  assert.equal(all.shown.length, UNIT_RENDER_LIMIT + 20)
  assert.equal(all.hidden, 0)
  assert.equal(visibleUnits([], false).shown.length, 0)
  // 恰好等于上限：不折叠（边界）
  assert.equal(visibleUnits(huge.slice(0, UNIT_RENDER_LIMIT), false).hidden, 0)
})

test('groupUnits：按分组名切块；无分组时退化为单块（其它分区渲染路径不变）', () => {
  const flat = [{ id: 'skills:a', label: 'a', sizeBytes: 1 }]
  const flatGroups = groupUnits(flat)
  assert.equal(flatGroups.length, 1)
  assert.equal(flatGroups[0]!.label, null)
  assert.deepEqual(flatGroups[0]!.units, flat)

  const grouped = [
    { id: 'sessions:p/1', label: 't1', sizeBytes: 1, group: 'ws-a' },
    { id: 'sessions:p/2', label: 't2', sizeBytes: 1, group: 'ws-b' },
    { id: 'sessions:p/3', label: 't3', sizeBytes: 1, group: 'ws-a' },
  ]
  const groups = groupUnits(grouped)
  assert.deepEqual(groups.map((g) => g.label), ['ws-a', 'ws-b'], '组顺序 = 首次出现顺序（宿主已排好，UI 不重排）')
  assert.deepEqual(groups[0]!.units.map((u) => u.id), ['sessions:p/1', 'sessions:p/3'])
})

test('分组级勾选：点一个分组 = 只勾这一组（不得静默变成整个分区全选）', () => {
  const units = [
    { id: 'sessions:p/1', label: 't1', sizeBytes: 1, group: 'ws-a' },
    { id: 'sessions:p/2', label: 't2', sizeBytes: 1, group: 'ws-a' },
    { id: 'sessions:p/3', label: 't3', sizeBytes: 1, group: 'ws-b' },
  ]
  const section: SelectionSection = { section: 'sessions', count: 3, sizeBytes: 3, units }
  const [groupA, groupB] = groupUnits(units)

  // ① 分区未勾选时点 A 组：只勾 A（稀疏表示要求把 B 显式排除），分区随之勾上
  let sel: Selection = toggleUnitGroup({ sections: [], excluded: [] }, section, groupA!, true)
  assert.deepEqual(sel.sections, ['sessions'])
  assert.equal(groupPickState(sel, groupA!, section.section), 'all')
  assert.equal(groupPickState(sel, groupB!, section.section), 'none')
  assert.equal(sectionPickState(sel, section), 'partial', '只选了 A 组 → 分区三态为部分选')
  assert.deepEqual(
    buildExportRequest(sel, [section]).includeItems?.sessions,
    ['sessions:p/1', 'sessions:p/2'],
    '导出白名单只含 A 组 —— 「勾一个工作区」绝不能变成「660 个会话全带上」',
  )

  // ② 再勾 B 组：分区全选 → 不再下发白名单（缺省 = 全量）
  sel = toggleUnitGroup(sel, section, groupB!, true)
  assert.equal(sectionPickState(sel, section), 'all')
  assert.equal(buildExportRequest(sel, [section]).includeItems, undefined)

  // ③ 取消 A 组：只剩 B（稀疏表示只记被排除的两条）
  sel = toggleUnitGroup(sel, section, groupA!, false)
  assert.equal(groupPickState(sel, groupA!, section.section), 'none')
  assert.deepEqual(sel.excluded, ['sessions:p/1', 'sessions:p/2'])
  assert.deepEqual(buildExportRequest(sel, [section]).includeItems?.sessions, ['sessions:p/3'])

  // ④ 取消 B 组：分区整体不导出（与「取消勾选整个分区」等价，不产出空载荷分区）
  sel = toggleUnitGroup(sel, section, groupB!, false)
  assert.deepEqual(sel.sections, ['sessions'])
  assert.deepEqual(buildExportRequest(sel, [section]), { only: [] })
})

test('tailWeightedEllipsis：中段省略且保留尾部（时间戳/版本等区分信息，UI-16）', () => {
  const long = '2026-09-20T10-00-00-backup-session-name-with-a-very-long-tail-2026-09-20.zip'
  const cut = tailWeightedEllipsis(long, 44)
  assert.ok(cut.length <= 44, `截断后不得超长（实际 ${cut.length}）`)
  assert.ok(cut.includes('…'), '中段用 … 收掉')
  assert.ok(cut.endsWith(long.slice(-8)), '尾部（区分信息所在）必须保留')
  assert.ok(cut.startsWith(long.slice(0, 4)), '头部保留')

  // 短文本原样（不动数据）
  assert.equal(tailWeightedEllipsis('short', 44), 'short')
  assert.equal(tailWeightedEllipsis('exactly-eleven', 14), 'exactly-eleven')
  // 极端 max 不产生 NaN / 空串
  assert.equal(tailWeightedEllipsis('abcdef', 1), 'abcdef')
  assert.ok(tailWeightedEllipsis('abcdef', 4).length <= 4)
})

test('selectionHasItems：「全不选」= 计划里一项都没留下（UI-05 的执行守卫）', () => {
  // 默认全选：有可执行项
  assert.equal(selectionHasItems(PLAN, defaultSelectionFromPlan(PLAN)), true)
  // 全不选（sections 空）：一项都不留 —— 这次导入不会写入任何东西，
  // 向导必须据此提示 + 禁用「下一步」（否则引擎仍建快照并报成功）
  assert.equal(selectionHasItems(PLAN, { sections: [], excluded: [] }), false)
  // 只勾了一个含项的分区：仍有项
  assert.equal(selectionHasItems(PLAN, { sections: ['plugins'], excluded: [] }), true)
  // 分区勾着但该分区所有单元都被排除 = 与不勾等价（导出侧同款语义）
  const allExcluded = PLAN.items.map((i) => i.unitId ?? i.id)
  assert.equal(selectionHasItems(PLAN, { sections: ['skills'], excluded: allExcluded }), false)
})

test('items 级排除：selectionHasItems 与 buildSelectedPlan 的空/非空判定一致', () => {
  const iter = [
    { sections: [], excluded: [] } as Selection,
    { sections: ['skills'], excluded: [] } as Selection,
    { sections: ['plugins', 'credentialsStatus'], excluded: ['plugin:x'] } as Selection,
  ]
  for (const sel of iter) {
    assert.equal(
      selectionHasItems(PLAN, sel),
      buildSelectedPlan(PLAN, sel).items.length > 0,
      JSON.stringify(sel),
    )
  }
})

/* ----------------------------------------------------------------------------------
   2026-09 修复：分区「未勾选 → 勾其中某一个单元」曾静默把整分区一起勾上
   ----------------------------------------------------------------------------------
   稀疏表示下「分区在 sections 里 + 没有任何排除」= 全选，所以 toggleUnit 必须先显式排除
   同分区的兄弟单元（与 toggleUnitGroup 同一套语义）。市场通道（与导入页同一套选择语义）
   在「用户只想要其中一个插件/技能」时正是这条路径。
   ---------------------------------------------------------------------------------- */

test('回归：分区未勾选时勾一个单元 → 只勾这一个，兄弟单元不得被静默带上', () => {
  const sel: Selection = { sections: [], excluded: [] }
  const next = toggleUnit(sel, NODES, 'plugin:x', true)
  assert.deepEqual(next.sections, ['plugins'])
  assert.deepEqual(next.excluded, ['plugin:y'], '同分区兄弟单元必须显式排除')
  // 执行口径同源：子计划只含被勾的那一项
  const plan: ImportPlan = { ...PLAN, items: [item({ id: 'plugin:x', adapter: 'plugins' }), item({ id: 'plugin:y', adapter: 'plugins' })] }
  assert.deepEqual(buildSelectedPlan(plan, next).items.map((i) => i.id), ['plugin:x'])
})

test('回归：lockedWith 原子组在「分区未勾选」路径同样整组带回', () => {
  const nodes: SelectionSection[] = [node('plugins', [
    { id: 'plugins:pnpm-workspace', lockedWith: ['plugins:pnpm-workspace', 'plugins:patch:p'] },
    { id: 'plugins:patch:p', lockedWith: ['plugins:pnpm-workspace', 'plugins:patch:p'] },
    { id: 'plugin:z' },
  ])]
  const next = toggleUnit({ sections: [], excluded: [] }, nodes, 'plugins:patch:p', true)
  assert.equal(isUnitSelected(next, 'plugins:pnpm-workspace'), true, '原子组成员必须一起进来')
  assert.equal(isUnitSelected(next, 'plugin:z'), false, '组外单元不得被带上')
})

test('回归：取消勾选后本分区一个单元都不剩 → 分区随之移出 sections（与执行口径一致）', () => {
  let sel = defaultSelection(ALL)
  sel = toggleUnit(sel, NODES, 'plugin:x', false)
  assert.deepEqual(sel.sections, ALL, '还剩一个单元 → 分区仍在')
  sel = toggleUnit(sel, NODES, 'plugin:y', false)
  assert.deepEqual(sel.sections, ['skills', 'settings'], '一个都不剩 → 分区移出（不出现「已选 0/n」的分区）')
  assert.equal(pickerSummary(sel, NODES).sections, 2, '分区计数不得把空分区算进去')
  assert.equal(sectionPickState(sel, NODES[1]!), 'none', '该分区渲染为未勾选')
  assert.equal(isUnitSelected(sel, 'skills:a'), true, '其它分区的勾选不受影响')
  // 执行口径同源：被清空的分区不产出任何计划项（但其它分区照常）
  const plan: ImportPlan = {
    ...PLAN,
    items: [
      item({ id: 'plugin:x', adapter: 'plugins' }),
      item({ id: 'plugin:y', adapter: 'plugins' }),
      item({ id: 'settings:root', adapter: 'settings' }),
    ],
  }
  assert.deepEqual(buildSelectedPlan(plan, sel).items.map((i) => i.id), ['settings:root'])
})

test('高风险分区定义（市场就地警示与导入共用同一份 HIGH_RISK_ADAPTERS）', () => {
  for (const a of ['pluginFiles', 'agentInstructions', 'agentPresets', 'sessions', 'mcp', 'plugins']) {
    assert.equal(HIGH_RISK_ADAPTERS.has(a as SectionId), true, `${a} 应为高风险`)
  }
  assert.equal(isHighRiskAdapter('settings'), false)
  assert.equal(isHighRiskAdapter('skills'), false)
  assert.equal(isHighRiskAdapter('providers'), false)
})

test('unitLabel：剥掉分区/实体前缀（市场逐项摘要与级联树同一套命名口径）', () => {
  assert.equal(unitLabel('skills:bar/SKILL.md', 'skills'), 'bar/SKILL.md')
  assert.equal(unitLabel('plugin:alpha', 'plugins'), 'alpha')
  assert.equal(unitLabel('mcp:server-a', 'mcp'), 'server-a')
})


/* ---------------- issue #45：会话 ↔ 工作区联动勾选 ---------------- */

import { applySessionWorkspaceCoupling, couplingInventorySections, sameSelection, sessionIdOfUnit } from './selection-model.ts';

/** 两个分区的联动夹具：会话 s1/s2/s3 分属工作区 w1（s1）/ w2（s2,s3）。 */
function linkedNodes(): SelectionSection[] {
  return [
    {
      section: 'sessions',
      count: 3,
      sizeBytes: 0,
      units: [
        { id: 'sessions:--p--/s1', label: 's1', sizeBytes: 0 },
        { id: 'sessions:--p--/s2', label: 's2', sizeBytes: 0 },
        { id: 'sessions:--p--/s3', label: 's3', sizeBytes: 0 },
      ],
    },
    {
      section: 'workspaces',
      count: 2,
      sizeBytes: 0,
      units: [
        { id: 'workspace:w1', label: 'w1', sizeBytes: 0, sessionIds: ['s1'] },
        { id: 'workspace:w2', label: 'w2', sizeBytes: 0, sessionIds: ['s2', 's3'] },
      ],
    },
    { section: 'settings', count: 1, sizeBytes: 0, units: [{ id: 'settings:x', label: 'x', sizeBytes: 0 }] },
  ]
}

test('会话单元 id → sessionId 解析（只认 sessions: 前缀与最后一段）', () => {
  assert.equal(sessionIdOfUnit('sessions:--p--/session-a'), 'session-a');
  assert.equal(sessionIdOfUnit('workspace:w1'), undefined);
  assert.equal(sessionIdOfUnit('sessions:noslash'), undefined);
});

test('勾了会话 → 自动勾上拥有它的工作区（导出/导入同一套规则）', () => {
  const nodes = linkedNodes();
  const onlyS1 = toggleUnit({ sections: [], excluded: [] }, nodes, 'sessions:--p--/s1', true);
  const coupled = applySessionWorkspaceCoupling(onlyS1, nodes, 'sessions');
  assert.equal(isUnitSelected(coupled, 'workspace:w1'), true, 'w1 拥有 s1 → 自动勾上');
  assert.equal(isUnitSelected(coupled, 'workspace:w2'), false, 'w2 没被牵动');
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s1'), true);
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s2'), false, '没勾的会话不受影响');
});

test('取消工作区 → 它的会话一起取消（其余工作区的会话不动）', () => {
  const nodes = linkedNodes();
  const all = selectAll(nodes, true);
  const off = toggleUnit(all, nodes, 'workspace:w1', false);
  const coupled = applySessionWorkspaceCoupling(off, nodes, 'workspaces');
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s1'), false, 'w1 的会话被取消');
  assert.equal(isUnitSelected(coupled, 'workspace:w1'), false);
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s2'), true, 'w2 的会话保持勾选');
  assert.equal(isUnitSelected(coupled, 'workspace:w2'), true);
});

test('取消整个工作区分区 → 它的会话也全部取消；没有 sessionIds 的工作区不参与联动', () => {
  const nodes = linkedNodes();
  const all = selectAll(nodes, true);
  const wsNode = nodes.find((n) => n.section === 'workspaces')!;
  const coupled = applySessionWorkspaceCoupling(toggleSection(all, wsNode, false), nodes, 'workspaces');
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s1'), false);
  assert.equal(isUnitSelected(coupled, 'sessions:--p--/s3'), false);
  assert.equal(isUnitSelected(coupled, 'settings:x'), true, '无关分区不受影响');
  const noOwners: SelectionSection[] = [
    { section: 'sessions', count: 1, sizeBytes: 0, units: [{ id: 'sessions:--p--/s1', label: 's1', sizeBytes: 0 }] },
    { section: 'workspaces', count: 1, sizeBytes: 0, units: [{ id: 'workspace:w9', label: 'w9', sizeBytes: 0 }] },
  ];
  const untouched = applySessionWorkspaceCoupling(toggleUnit({ sections: [], excluded: [] }, noOwners, 'sessions:--p--/s1', true), noOwners);
  assert.equal(untouched.sections.includes('workspaces'), false, '没有 sessionIds 的工作区不被猜着勾上（workspaces 分区仍未选）');
});
test('couplingInventorySections：勾了会话就必须把工作区清单一起读（否则联动没有数据可依）', () => {
  assert.deepEqual(couplingInventorySections([]), []);
  assert.deepEqual(couplingInventorySections(['settings']), ['settings']);
  assert.deepEqual(couplingInventorySections(['sessions']), ['sessions', 'workspaces']);
  assert.deepEqual(couplingInventorySections(['sessions', 'workspaces']), ['sessions', 'workspaces'], '已有就不重复加');
  assert.deepEqual(couplingInventorySections(['workspaces']), ['workspaces'], '反向不加：没勾会话时不需要会话清单');
});

test('sameSelection：集合等价即视为相同（清单到货补联动时用它避免自激写库）', () => {
  assert.equal(sameSelection({ sections: ['settings'], excluded: ['x'] }, { sections: ['settings'], excluded: ['x'] }), true);
  assert.equal(sameSelection({ sections: [], excluded: [] }, { sections: [], excluded: ['x'] }), false);
  assert.equal(sameSelection({ sections: ['settings'], excluded: [] }, { sections: ['settings', 'plugins'], excluded: [] }), false);
});

test('链式选择（用户真机场景）：勾了一个对话，工作区清单到货后它自动回来', () => {
  const nodes = linkedNodes();
  const wsNode = nodes.find((n) => n.section === 'workspaces')!;
  // 起点：默认勾选（工作区在、会话不在）→ 用户取消整个工作区分区
  const off = applySessionWorkspaceCoupling(toggleSection({ sections: ['workspaces', 'settings'], excluded: [] }, wsNode, false), nodes, 'workspaces');
  assert.equal(off.sections.includes('workspaces'), false, '工作区被取消');
  // 用户勾一个对话：此刻工作区清单还没读到（units 为空）
  const noInv: SelectionSection[] = nodes.map((n) => (n.section === 'workspaces' ? { ...n, units: [] } : n));
  const clicked = applySessionWorkspaceCoupling(toggleUnit(off, noInv, 'sessions:--p--/s1', true), noInv, 'sessions');
  assert.equal(clicked.sections.includes('sessions'), true, '会话分区被带进选择');
  assert.equal(clicked.sections.includes('workspaces'), false, '清单缺失时联动只能空转（这就是用户看到的 bug）');
  // 清单到货 → 导出页的补联动 effect 做同一件事（方向固定 sessions）
  const synced = applySessionWorkspaceCoupling(clicked, nodes, 'sessions');
  assert.equal(synced.sections.includes('workspaces'), true, '工作区分区回到勾选状态');
  assert.equal(isUnitSelected(synced, 'workspace:w1'), true, '拥有 s1 的工作区被自动勾上');
  assert.equal(isUnitSelected(synced, 'workspace:w2'), false, '其它工作区保持排除（不会顺带把 660 个会话带进来）');
  assert.equal(isUnitSelected(synced, 'sessions:--p--/s1'), true, '用户勾的对话保持勾选');
});
test('链式选择：会话目录名两种形态（裸 uuid / session-<uuid>）必须都能配上工作区', () => {
  // 真机实测：同一台机器上 806 个会话目录里 158 个是 session-<uuid>、648 个是裸 <uuid>，
  // 而工作区注册表一律写 session-<uuid>。会话单元的末段是**目录名**，两种形态必须归一化后配对。
  const bare = '2b549283-846a-47ab-a438-d69d977d48e3';
  const ids = ['session-' + bare, 'session-80cede7e-7543-4a3a-a927-4465ba9791f8'];
  const both: SelectionSection[] = [
    { section: 'sessions', count: 2, sizeBytes: 0, units: [
      { id: 'sessions:--p--/' + bare, label: bare, sizeBytes: 0 },
      { id: 'sessions:--p--/session-80cede7e-7543-4a3a-a927-4465ba9791f8', label: 'old', sizeBytes: 0 },
    ] },
    { section: 'workspaces', count: 2, sizeBytes: 0, units: [
      { id: 'workspace:ws-new', label: 'new', sizeBytes: 0, sessionIds: [ids[0]!] },
      { id: 'workspace:ws-old', label: 'old', sizeBytes: 0, sessionIds: [ids[1]!] },
    ] },
  ];
  // ① 勾「裸 uuid」形态的对话 → 对应工作区（登记的是 session-<uuid>）必须自动勾上
  const picked = applySessionWorkspaceCoupling(toggleUnit({ sections: [], excluded: [] }, both, 'sessions:--p--/' + bare, true), both, 'sessions');
  assert.equal(isUnitSelected(picked, 'workspace:ws-new'), true, '裸 uuid 对话 → 拥有它的工作区自动勾上');
  assert.equal(isUnitSelected(picked, 'workspace:ws-old'), false, '另一个工作区不受影响');
  // ② 反向：取消该工作区 → 裸 uuid 形态的对话一起取消
  const off = applySessionWorkspaceCoupling(toggleUnit(selectAll(both, true), both, 'workspace:ws-new', false), both, 'workspaces');
  assert.equal(isUnitSelected(off, 'sessions:--p--/' + bare), false, '取消工作区 → 裸 uuid 会话一起取消');
  assert.equal(isUnitSelected(off, 'sessions:--p--/session-80cede7e-7543-4a3a-a927-4465ba9791f8'), true, '别的会话不动');
});
test('链式选择：工作区没有 sessionIds（DSH 只登记了一部分会话）→ 按 cwd 目录键认领', () => {
  // 真机实测：一次可选择的 570 条会话里只有 23 条落在工作区 sessionIds 内 —— 只认 sessionIds 的联动
  // 对绝大多数对话「点了没反应」，而界面又明明把它们挂在该工作区下（DSH 按 cwd 目录键分组）。
  const repo = '--D-Projects-personal-dsh-config-manager--';
  const tools = '--D-Tools--';
  const nodes: SelectionSection[] = [
    { section: 'sessions', count: 2, sizeBytes: 0, units: [
      { id: 'sessions:' + repo + '/2b549283-846a-47ab-a438-d69d977d48e3', label: 'a', sizeBytes: 0 },
      { id: 'sessions:' + tools + '/a2830ada-f421-4f9a-9172-1acdfab978fe', label: 'b', sizeBytes: 0 },
    ] },
    { section: 'workspaces', count: 2, sizeBytes: 0, units: [
      { id: 'workspace:ws-repo', label: 'repo', sizeBytes: 0, sessionIds: ['session-someone-else'], projectKey: repo },
      { id: 'workspace:ws-tools', label: 'tools', sizeBytes: 0, projectKey: tools },
    ] },
  ];
  const picked = applySessionWorkspaceCoupling(toggleUnit({ sections: [], excluded: [] }, nodes, 'sessions:' + repo + '/2b549283-846a-47ab-a438-d69d977d48e3', true), nodes, 'sessions');
  assert.equal(isUnitSelected(picked, 'workspace:ws-repo'), true, '靠 cwd 目录键认领（sessionIds 里没有它）');
  assert.equal(isUnitSelected(picked, 'workspace:ws-tools'), false, '别的目录键的工作区不动');
  const off = applySessionWorkspaceCoupling(toggleUnit(selectAll(nodes, true), nodes, 'workspace:ws-repo', false), nodes, 'workspaces');
  assert.equal(isUnitSelected(off, 'sessions:' + repo + '/2b549283-846a-47ab-a438-d69d977d48e3'), false, '取消工作区 → 该目录下的会话一起取消');
  assert.equal(isUnitSelected(off, 'sessions:' + tools + '/a2830ada-f421-4f9a-9172-1acdfab978fe'), true, '别的目录的会话不动');
});

test('链式选择：旧宿主不回传 projectKey 时用 detail（工作区绝对路径）现算；描述文案不猜', () => {
  const repo = '--D-Projects-personal-dsh-config-manager--';
  const nodes: SelectionSection[] = [
    { section: 'sessions', count: 1, sizeBytes: 0, units: [{ id: 'sessions:' + repo + '/x', label: 'x', sizeBytes: 0 }] },
    { section: 'workspaces', count: 2, sizeBytes: 0, units: [
      { id: 'workspace:ws-by-detail', label: 'by-detail', sizeBytes: 0, detail: 'D:/Projects/personal/dsh-config-manager' },
      { id: 'workspace:ws-desc', label: 'desc', sizeBytes: 0, detail: 'current={"id":"x"} imported={"id":"y"}' },
    ] },
  ];
  const picked = applySessionWorkspaceCoupling(toggleUnit({ sections: [], excluded: [] }, nodes, 'sessions:' + repo + '/x', true), nodes, 'sessions');
  assert.equal(isUnitSelected(picked, 'workspace:ws-by-detail'), true, 'detail 是绝对路径 → 现算目录键并认领');
  assert.equal(isUnitSelected(picked, 'workspace:ws-desc'), false, '非路径的 detail（描述文案）不参与联动（不猜）');
});

/* ---------------- 父对话 ↔ 子代理会话联动（用户需求：勾父自动勾上它的 subagent 会话） ---------------- */

import { applySessionParentCoupling, type SelectionUnit, type SessionParentChange } from './selection-model.ts';

/**
 * 会话族夹具（全部在同一个工作区目录下）：
 *   p1 ─ c1、c9（子代理）、c2（子代理，自己还有子代理 g1）
 *   p3 ─ c3；p2 独立顶层会话。
 * c9 的父 id 刻意写成 `session-p1` 前缀形态（真机：同一台机器上 `session-<uuid>` 与裸 `<uuid>` 并存），
 * 验证「归一化后配对」。
 */
function parentLinkedNodes(): SelectionSection[] {
  const units: SelectionUnit[] = [
    { id: 'sessions:--p--/p1', label: 'p1', sizeBytes: 0 },
    { id: 'sessions:--p--/p2', label: 'p2', sizeBytes: 0 },
    { id: 'sessions:--p--/p3', label: 'p3', sizeBytes: 0 },
    { id: 'sessions:--p--/c1', label: 'c1', sizeBytes: 0, parentSessionId: 'p1' },
    { id: 'sessions:--p--/c2', label: 'c2', sizeBytes: 0, parentSessionId: 'p1' },
    { id: 'sessions:--p--/g1', label: 'g1', sizeBytes: 0, parentSessionId: 'c2' },
    { id: 'sessions:--p--/c3', label: 'c3', sizeBytes: 0, parentSessionId: 'p3' },
    { id: 'sessions:--p--/c9', label: 'c9', sizeBytes: 0, parentSessionId: 'session-p1' },
  ]
  return [{ section: 'sessions', count: units.length, sizeBytes: 0, units }]
}

/** 模拟 ContentPicker 的 commit 顺序：先 toggleUnit，再过父子联动。 */
function click(nodes: SelectionSection[], sel: Selection, unitId: string, checked: boolean): Selection {
  const change: SessionParentChange = { unitId, checked }
  return applySessionParentCoupling(toggleUnit(sel, nodes, unitId, checked), nodes, change)
}

test('勾父对话 → 自动勾上它的子代理会话（含嵌套孙），无关会话不跟着走', () => {
  const nodes = parentLinkedNodes()
  const picked = click(nodes, { sections: [], excluded: [] }, 'sessions:--p--/p1', true)
  assert.equal(isUnitSelected(picked, 'sessions:--p--/c1'), true, '直接子会话自动勾上')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/c2'), true, '另一个直接子会话也勾上')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/g1'), true, '嵌套子代理会话（孙）也一起带')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/c9'), true, '同一父对话的全部子会话都带上')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/p2'), false, '无关的顶层会话不跟着走')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/p3'), false, '别人的父对话不跟着走')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/c3'), false, '别人的子会话不跟着走（绝不顺带兄弟）')
})

test('勾子代理会话 → 自动带上它的父对话（父链向上），不带兄弟', () => {
  const nodes = parentLinkedNodes()
  const picked = click(nodes, { sections: [], excluded: [] }, 'sessions:--p--/c1', true)
  assert.equal(isUnitSelected(picked, 'sessions:--p--/p1'), true, '父对话自动勾上（与引擎的「向上补父」同口径）')
  assert.equal(isUnitSelected(picked, 'sessions:--p--/c2'), false, '兄弟子会话不被带上')
  // 多层：勾孙 → 子与父都要勾上
  const deep = click(nodes, { sections: [], excluded: [] }, 'sessions:--p--/g1', true)
  assert.equal(isUnitSelected(deep, 'sessions:--p--/c2'), true, '中间那层也勾上')
  assert.equal(isUnitSelected(deep, 'sessions:--p--/p1'), true, '一路到顶')
})

test('取消父对话 → 它的子代理会话一起取消；取消子代理会话 → 只取消这一条', () => {
  const nodes = parentLinkedNodes()
  const all = click(nodes, { sections: [], excluded: [] }, 'sessions:--p--/p1', true)
  const offParent = click(nodes, all, 'sessions:--p--/p1', false)
  assert.equal(isUnitSelected(offParent, 'sessions:--p--/p1'), false)
  assert.equal(isUnitSelected(offParent, 'sessions:--p--/c1'), false, '取消父 → 子一起取消（否则界面与包内容不一致）')
  assert.equal(isUnitSelected(offParent, 'sessions:--p--/g1'), false, '整棵子树都取消')
  assert.equal(isUnitSelected(offParent, 'sessions:--p--/p3'), false, '别人的族不受影响（本来就没勾）')

  const offChild = click(nodes, all, 'sessions:--p--/c1', false)
  assert.equal(isUnitSelected(offChild, 'sessions:--p--/c1'), false, '只取消被点的那条子会话')
  assert.equal(isUnitSelected(offChild, 'sessions:--p--/p1'), true, '父对话留着（用户明确排除了这一条）')
  assert.equal(isUnitSelected(offChild, 'sessions:--p--/c2'), true, '兄弟子会话不动')
})

test('批量动作（无动作方向）走正向闭包：只补齐，绝不取消任何已勾选的会话', () => {
  const nodes = parentLinkedNodes()
  // 用户先只勾了子会话（引擎会向上补父），再点「全选」以外的批量路径：这里用「分区勾上」模拟
  const partial: Selection = {
    sections: ['sessions'],
    excluded: ['sessions:--p--/g1', 'sessions:--p--/p1', 'sessions:--p--/p3', 'sessions:--p--/c3'],
  }
  const synced = applySessionParentCoupling(partial, nodes)
  assert.equal(isUnitSelected(synced, 'sessions:--p--/p1'), true, '已勾选的子会话把父补齐')
  assert.equal(isUnitSelected(synced, 'sessions:--p--/g1'), true, '已勾选的父把子补齐')
  assert.equal(isUnitSelected(synced, 'sessions:--p--/p3'), false, '没勾的族不补')
  // 幂等：再跑一次结果等价
  assert.deepEqual(applySessionParentCoupling(synced, nodes), synced)
})

test('无 parentSessionId（旧宿主 / 非 sessions 分区 / 导入页）→ 原样返回，不猜', () => {
  const plain: SelectionSection[] = [{ section: 'sessions', count: 2, sizeBytes: 0, units: [
    { id: 'sessions:--p--/a', label: 'a', sizeBytes: 0 },
    { id: 'sessions:--p--/b', label: 'b', sizeBytes: 0 },
  ] }]
  const sel = click(plain, { sections: [], excluded: [] }, 'sessions:--p--/a', true)
  assert.deepEqual(sel.sections, ['sessions'])
  assert.equal(isUnitSelected(sel, 'sessions:--p--/b'), false, '没有任何父子关系 → 联动整段不生效')
  const other: SelectionSection[] = [{ section: 'skills', count: 1, sizeBytes: 0, units: [{ id: 'skills:s', label: 's', sizeBytes: 0 }] }]
  assert.deepEqual(applySessionParentCoupling({ sections: ['skills'], excluded: [] }, other), { sections: ['skills'], excluded: [] })
})

/**
 * 惰性清单（2026-10-12 用户反馈）：清单只对**已勾选分区**预取，于是未勾选的分区此前既没有展开控件、
 * 也没有条目可选 —— 用户必须先勾上整个分区，才能展开与逐项挑选。两条判定必须挡在 ui 层。
 */
test('惰性清单：未读分区仍渲染展开控件；计数区不得把「未读」渲染成「已选 0/0」', () => {
  const unread: SelectionSection = { section: 'pluginFiles', count: 0, sizeBytes: 0, units: [], unitsUnread: true };
  const readEmpty: SelectionSection = { section: 'ui', count: 3, sizeBytes: 100, units: [] };
  const readUnits = node('skills', [{ id: 'skills:a' }]);

  assert.equal(sectionExpandable(unread), true, '未读 → 必须可展开（展开就是触发读取的入口）');
  assert.equal(sectionExpandable(readUnits), true, '有清单 → 可展开');
  assert.equal(sectionExpandable(readEmpty), false, '读过且没有可拆单元 = 整体开关，不渲染展开控件');

  assert.equal(sectionCountState(unread, { pending: false, failed: false }), 'unread');
  assert.equal(sectionCountState(unread, { pending: true, failed: false }), 'pending', '有「读取中」结论时不说「未读」');
  assert.equal(sectionCountState(unread, { pending: false, failed: true }), 'failed', '有「读取失败」结论时不说「未读」');
  assert.equal(sectionCountState(readEmpty, { pending: false, failed: false }), 'count', '已读分区仍按 n/m 计数');

  // 纯展示标记：勾选 / 导出契约一律不看它（未读时仍是整体开关）
  const sel: Selection = { sections: ['pluginFiles'], excluded: [] };
  assert.equal(sectionPickState(sel, unread), 'all');
  assert.deepEqual(buildExportRequest(sel, [unread]), { only: ['pluginFiles'] });
});
test('选择模型：sectionsFromPreview 透传 blank 事实（ContentPicker 据此显示「新会话」）', () => {
  const nodes = sectionsFromPreview([
    { section: 'sessions', count: 1, sizeBytes: 10, items: [{ id: 'sessions:--p--/a', label: 'a', sizeBytes: 10, blank: true }] },
    { section: 'skills', count: 1, sizeBytes: 10, items: [{ id: 'skills:x', label: 'x', sizeBytes: 10 }] },
  ]);
  assert.equal(nodes[0]?.units[0]?.blank, true);
  assert.equal(nodes[1]?.units[0]?.blank, undefined, '非会话单元不得凭空带 blank');
});

/* ----------------------------------------------------------------------------------
   「按插件看」：树模型 / 三态 / 一键勾选（用户需求：勾一个插件 = 带走它四处的东西）
   ---------------------------------------------------------------------------------- */

function treeNodes(): SelectionSection[] {
  return [
    {
      section: 'plugins', count: 2, sizeBytes: 120, group: 'extensions',
      units: [
        {
          id: 'plugin:alpha', label: 'alpha', detail: '1.0.0', sizeBytes: 10,
          relatedAreas: [{ section: 'pluginData', relPath: '.alpha/runtime', role: 'config' }],
        },
        { id: 'plugin:beta', label: 'beta', sizeBytes: 10 },
        { id: 'plugins:pnpm-workspace', label: 'pnpm-workspace.yaml', sizeBytes: 5 },
      ],
    },
    {
      section: 'pluginData', count: 2, sizeBytes: 30,

      units: [
        { id: 'pluginData:.alpha/runtime', label: '.alpha/runtime', sizeBytes: 20 },
        { id: 'pluginData:.gone/state', label: '.gone/state', sizeBytes: 10 },
      ],
    },
    // 大文件分区还没读：区域叶子只能是 unread（不可勾），绝不当成「没有内容」
    { section: 'pluginAssets', count: 0, sizeBytes: 0, units: [], unitsUnread: true },
    {
      section: 'pluginFiles', count: 1, sizeBytes: 4,
      units: [{ id: 'pluginFiles:dsh-ssh.json', label: 'dsh-ssh.json', sizeBytes: 4 }],
    },
  ]
}

const TREE_SECTIONS: SectionId[] = ['plugins']

test('合并进插件树的分区只有那四项（配置管理器设置不是插件，仍按普通分区行渲染）', () => {
  assert.deepEqual([...PLUGIN_TREE_SECTIONS].sort(), ['pluginAssets', 'pluginData', 'pluginFiles', 'plugins'])
  for (const id of PLUGIN_TREE_SECTIONS) assert.equal(isPluginTreeSection(id), true)
  assert.equal(isPluginTreeSection('self'), false, '配置管理器设置不得被吸收进树')
  assert.equal(isPluginTreeSection('sessions'), false)
})

test('按插件看：插件清单条目与它声明的数据区域收在同一个节点下（未读分区不可勾）', () => {
  const tree = pluginTree(treeNodes())
  assert.equal(tree.pluginsLoaded, true)
  const alpha = tree.entries.find((e) => e.name === 'alpha')
  assert.ok(alpha !== undefined)
  assert.deepEqual(alpha!.leaves.map((l) => l.state), ['present', 'present'])
  assert.deepEqual(alpha!.leaves.map((l) => l.unitId), ['plugin:alpha', 'pluginData:.alpha/runtime'])
  // beta 没有任何声明 → 只有清单条目，绝不凭空造出数据区域
  const beta = tree.entries.find((e) => e.name === 'beta')
  assert.deepEqual(beta!.areas, [])
  // 声明了 pluginAssets 的区域？alpha 只声明了 config 区域，故不存在 assets 叶子
  assert.equal(alpha!.leaves.some((l) => l.section === 'pluginAssets'), false)
})

test('按插件看：注册表说有、磁盘上没有 = absent；分区没读 = unread（两者都不可勾）', () => {
  const nodes = treeNodes()
  // 让 alpha 声明一个大文件区域（该分区还没读）
  nodes[0]!.units[0] = {
    ...nodes[0]!.units[0]!,
    relatedAreas: [
      { section: 'pluginData', relPath: '.alpha/runtime', role: 'config' },
      { section: 'pluginAssets', relPath: '.alpha/uploads', role: 'assets' },
      { section: 'pluginData', relPath: '.alpha/nonexistent', role: 'config' },
    ],
  }
  const tree = pluginTree(nodes)
  const alpha = tree.entries.find((e) => e.name === 'alpha')!
  // 顺序 = 清单条目在前，随后按宿主声明顺序：[runtime(已读)、uploads(未读)、nonexistent(已读但没内容)]
  assert.deepEqual(alpha.leaves.map((l) => l.state), ['present', 'present', 'unread', 'absent'])
  assert.deepEqual(pluginEntryLeaves(alpha).map((l) => l.unitId), ['plugin:alpha', 'pluginData:.alpha/runtime'])
  assert.deepEqual(pluginEntryUnreadSections(alpha), ['pluginAssets'])
})

test('按插件看不猜归属：只有 pluginFiles（无包名信息）与补丁行进桶；遗留数据不单列（用户要求不看）', () => {
  const tree = pluginTree(treeNodes())
  const bySection = new Map(tree.buckets.map((b) => [b.section, b]))
  assert.deepEqual([...bySection.keys()].sort(), ['pluginFiles', 'plugins'],
    '桶只有两个：pluginFiles 与「插件分区的其他条目」')
  assert.deepEqual(bySection.get('pluginFiles')?.units.map((u) => u.id), ['pluginFiles:dsh-ssh.json'])
  assert.deepEqual(bySection.get('plugins')?.units.map((u) => u.id), ['plugins:pnpm-workspace'])
  assert.equal(bySection.get('pluginData'), undefined, '未被认领的数据单元不再单列「遗留数据」桶')
  assert.equal(bySection.get('pluginAssets'), undefined)
})

test('按插件看：插件节点三态与一键勾选（逐个走 toggleUnit，不静默全选整个分区）', () => {
  const nodes = treeNodes()
  const alpha = pluginTree(nodes).entries.find((e) => e.name === 'alpha')!
  let sel = defaultSelection(TREE_SECTIONS)
  // 只有清单条目被勾上 → 部分选中（数据区域属于未勾选的分区）
  assert.equal(pluginEntrySelectedCount(sel, alpha), 1)
  assert.equal(pluginEntryPickState(sel, alpha), 'partial')
  sel = togglePluginEntry(sel, nodes, alpha, true)
  assert.deepEqual(sel.sections, ['plugins', 'pluginData'])
  // 只勾该插件的区域：同分区里未被认领的遗留数据（.gone/state）不得被一起带上
  assert.deepEqual(buildExportRequest(sel, nodes), {
    only: ['plugins', 'pluginData'],
    includeItems: { pluginData: ['pluginData:.alpha/runtime'] },
  })
  // 反向：取消该插件 → 它的清单条目与数据区域一起取消，其余插件不动
  sel = togglePluginEntry(sel, nodes, alpha, false)
  assert.deepEqual(sel.sections, ['plugins'], '数据区域被取消后，pluginData 随之移出勾选')
  assert.equal(sel.excluded.includes('plugin:alpha'), true)
  assert.equal(sel.excluded.includes('pluginData:.alpha/runtime'), true)
})

test('「插件」一级区块：三态只算插件名下存在的叶子，未归属桶不参与', () => {
  const nodes = treeNodes()
  const tree = pluginTree(nodes)
  let sel = defaultSelection(TREE_SECTIONS)
  // 叶子 = alpha 的清单条目 + 它的数据区域 + beta 的清单条目（未归属的 .gone/state 与 pluginFiles 不计）
  assert.equal(pluginTreeLeafCount(tree), 3)
  assert.equal(pluginTreeSelectedCount(sel, tree), 2, '两个插件的清单条目默认已勾：alpha + beta')
  assert.equal(pluginTreePickState(sel, tree), 'partial')
  sel = togglePluginTree(sel, nodes, tree, true)
  assert.equal(pluginTreePickState(sel, tree), 'all')
  assert.deepEqual(buildExportRequest(sel, nodes), {
    only: ['plugins', 'pluginData'],
    includeItems: { pluginData: ['pluginData:.alpha/runtime'] },
  })
  // 未归属 / 遗留数据没有任何文档说过要一起带上：它们的单元不得因一级区块被勾选
  assert.equal(sel.excluded.includes('pluginData:.gone/state'), true)
  assert.equal(sel.sections.includes('pluginFiles'), false)
})

test('「插件」一级区块：取消勾选后所有插件单元都不再导出（桶里的补丁行不受影响）', () => {
  const nodes = treeNodes()
  const tree = pluginTree(nodes)
  const sel = togglePluginTree(defaultSelection(TREE_SECTIONS), nodes, tree, false)
  assert.equal(pluginTreePickState(sel, tree), 'none')
  // 插件分区仍被勾着 —— 因为 **桶里** 的 pnpm-workspace.yaml / 补丁行不属于任何插件，
  // 一级区块的勾选框不碰它们（「全选所有插件」不该顺手动没人认领的东西）
  assert.deepEqual(sel.sections, ['plugins'])
  assert.equal(sel.excluded.includes('plugin:alpha'), true)
  assert.equal(sel.excluded.includes('plugin:beta'), true)
  assert.equal(sel.excluded.includes('plugins:pnpm-workspace'), false)
})

test('计数不随清单到货跳动：「已选 n/m」的分母用「已知」叶子（含未读取的区域）', () => {
  const nodes = treeNodes()
  nodes[0]!.units[0] = {
    ...nodes[0]!.units[0]!,
    relatedAreas: [
      { section: 'pluginData', relPath: '.alpha/runtime', role: 'config' },
      { section: 'pluginAssets', relPath: '.alpha/uploads', role: 'assets' },
    ],
  }
  const before = pluginTree(nodes)
  const alphaBefore = before.entries.find((e) => e.name === 'alpha')!
  assert.equal(pluginEntryTotalCount(alphaBefore), 3, '清单条目 + 已读到区域 + 未读取区域')
  assert.equal(pluginTreeTotalCount(before), 4, 'alpha 3 项 + beta 1 项')
  // 模拟清单到货：同一个声明区域从 unread 变成 present —— 分母必须**不变**
  nodes[2] = {
    section: 'pluginAssets', count: 1, sizeBytes: 9,
    units: [{ id: 'pluginAssets:.alpha/uploads', label: '.alpha/uploads', sizeBytes: 9 }],
  }
  const after = pluginTree(nodes)
  const alphaAfter = after.entries.find((e) => e.name === 'alpha')!
  assert.equal(pluginEntryTotalCount(alphaAfter), 3)
  assert.equal(pluginTreeTotalCount(after), 4)
  assert.deepEqual(alphaAfter.leaves.map((l) => l.state), ['present', 'present', 'present'])
})

test('待补勾：清单没到齐时留在队列（绝不假装已勾），到货后补齐并出队', () => {
  const nodes = treeNodes()
  nodes[0]!.units[0] = {
    ...nodes[0]!.units[0]!,
    relatedAreas: [
      { section: 'pluginData', relPath: '.alpha/runtime', role: 'config' },
      { section: 'pluginAssets', relPath: '.alpha/uploads', role: 'assets' },
    ],
  }
  const pending = [{ key: 'alpha', kind: 'entry' as const }]
  const waiting = applyPluginPendingChecks(defaultSelection(TREE_SECTIONS), nodes, pluginTree(nodes), pending)
  assert.deepEqual(waiting.remaining, pending, '大文件分区还没读 → 继续等')
  // 到货
  nodes[2] = {
    section: 'pluginAssets', count: 1, sizeBytes: 9,
    units: [{ id: 'pluginAssets:.alpha/uploads', label: '.alpha/uploads', sizeBytes: 9 }],
  }
  const tree2 = pluginTree(nodes)
  const done = applyPluginPendingChecks(defaultSelection(TREE_SECTIONS), nodes, tree2, pending)
  assert.deepEqual(done.remaining, [])
  const alpha = tree2.entries.find((e) => e.name === 'alpha')!
  assert.equal(pluginEntrySelectedCount(done.selection, alpha), 3, '补齐后 = 该插件名下全部叶子')
  assert.equal(pluginEntryPickState(done.selection, alpha), 'all')
})

test('「插件」一级区块展开前要读的分区：插件清单自己没读到也要报（否则展开后没有读取入口）', () => {
  const nodes = treeNodes()
  // alpha 声明了一个大文件区域（该分区清单还没读）
  nodes[0]!.units[0] = {
    ...nodes[0]!.units[0]!,
    relatedAreas: [
      { section: 'pluginData', relPath: '.alpha/runtime', role: 'config' },
      { section: 'pluginAssets', relPath: '.alpha/uploads', role: 'assets' },
    ],
  }
  assert.deepEqual(pluginTreeUnreadSections(pluginTree(nodes)), ['pluginAssets'])
  const unreadPlugins: SelectionSection[] = [
    { section: 'plugins', count: 0, sizeBytes: 0, units: [], unitsUnread: true },
    { section: 'pluginData', count: 0, sizeBytes: 0, units: [], unitsUnread: true },
  ]
  assert.deepEqual(pluginTreeUnreadSections(pluginTree(unreadPlugins)), ['plugins'])
})

test('按插件看：搜索命中插件名保留它全部叶子；只命中叶子时保留该叶子', () => {
  const tree = pluginTree(treeNodes())
  const byName = filterPluginTree(tree, 'ALPHA')
  assert.deepEqual(byName.entries.map((e) => e.name), ['alpha'])
  assert.equal(byName.entries[0]?.leaves.length, 2, '插件名命中时保留全部叶子')
  const byLeaf = filterPluginTree(tree, 'dsh-ssh')
  assert.deepEqual(byLeaf.entries.map((e) => e.name), [])
  assert.deepEqual(byLeaf.buckets.map((b) => b.section), ['pluginFiles'])
})

test('选择模型：sectionsFromPreview 透传 group 与 relatedAreas（按插件看的两个输入）', () => {
  const nodes = sectionsFromPreview([
    {
      section: 'plugins', count: 1, sizeBytes: 10,
      items: [{
        id: 'plugin:alpha', label: 'alpha', sizeBytes: 10,
        relatedAreas: [{ section: 'pluginData', relPath: '.alpha/runtime', role: 'config' }],
      }],
    },
    { section: 'skills', count: 1, sizeBytes: 10, items: [{ id: 'skills:x', label: 'x', sizeBytes: 10 }] },
  ])
  assert.deepEqual(nodes[0]?.units[0]?.relatedAreas, [{ section: 'pluginData', relPath: '.alpha/runtime', role: 'config' }])
  assert.equal(nodes[1]?.units[0]?.relatedAreas, undefined, '没有声明的单元不得凭空带 relatedAreas')
});
