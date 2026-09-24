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
  buildExportRequest, buildSelectedPlan, defaultSelection,
  defaultSelectionFromPlan, effectiveImportPlan, effectiveImportSelection, filterSections,
  groupPickState, groupUnits, HIGH_RISK_ADAPTERS, isHighRiskAdapter, isPlanItemExcluded, isUnitSelected,
  tailWeightedEllipsis, pickerSummary,
  sectionPickState, sectionsFromPlan, sectionsFromPreview, selectedUnitCount, selectAll,
  selectionHasItems, toggleSection, toggleUnit, toggleUnitGroup, unitLabel,
  visibleUnits, UNIT_RENDER_LIMIT,
  type ImportSelectionState, type Selection, type SelectionSection,
} from './selection-model.ts'
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
  assert.equal(groupPickState(sel, groupA!), 'all')
  assert.equal(groupPickState(sel, groupB!), 'none')
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
  assert.equal(groupPickState(sel, groupA!), 'none')
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
