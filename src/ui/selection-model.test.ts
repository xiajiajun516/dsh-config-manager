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
  middleEllipsis, pickerSummary,
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

test('middleEllipsis：中段省略且保留尾部（时间戳/版本等区分信息，UI-16）', () => {
  const long = '2026-09-20T10-00-00-backup-session-name-with-a-very-long-tail-2026-09-20.zip'
  const cut = middleEllipsis(long, 44)
  assert.ok(cut.length <= 44, `截断后不得超长（实际 ${cut.length}）`)
  assert.ok(cut.includes('…'), '中段用 … 收掉')
  assert.ok(cut.endsWith(long.slice(-8)), '尾部（区分信息所在）必须保留')
  assert.ok(cut.startsWith(long.slice(0, 4)), '头部保留')

  // 短文本原样（不动数据）
  assert.equal(middleEllipsis('short', 44), 'short')
  assert.equal(middleEllipsis('exactly-eleven', 14), 'exactly-eleven')
  // 极端 max 不产生 NaN / 空串
  assert.equal(middleEllipsis('abcdef', 1), 'abcdef')
  assert.ok(middleEllipsis('abcdef', 4).length <= 4)
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

