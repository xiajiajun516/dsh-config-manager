/**
 * backup-inspect 测试（P1-⑦ / P2-⑬）：分区清单 + 差异摘要纯函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImportAnalysis, ImportPlan, PlanItem } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';
import { groupPlanItems, inspectGroupedChanges, inspectSections, inspectSummary } from './backup-inspect.ts';

const ALL_SECTIONS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts',
  'skills', 'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles',
  'credentialsStatus', 'secrets', 'sessions', 'self',
];

function emptyEstimatedActions(): Record<SectionId, number> {
  const out = {} as Record<SectionId, number>;
  for (const id of ALL_SECTIONS) out[id] = 0;
  return out;
}

function analysis(partial: Partial<ImportAnalysis> = {}): ImportAnalysis {
  return {
    valid: true,
    errors: [],
    warnings: [],
    compatibility: 'excellent',
    sectionsInZip: ['settings', 'plugins'],
    pluginSummary: { installed: 1, toInstall: 1 },
    pathIssues: [],
    secretCount: 2,
    dependencyIssues: [],
    encrypted: false,
    ...partial,
  };
}

function plan(items: PlanItem[] = [], missingSecrets: { ref: string; required: boolean }[] = []): ImportPlan {
  const estimatedActions = emptyEstimatedActions();
  for (const i of items) estimatedActions[i.adapter] = (estimatedActions[i.adapter] ?? 0) + 1;
  return {
    items,
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets,
    needsRestart: items.some((i) => i.kind === 'Install'),
    estimatedActions,
  };
}

test('inspectSections: 分区清单与 estimatedActions 对齐', () => {
  const p = plan([
    { id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a', severity: 'info' },
    { id: 'settings:x', kind: 'Update', adapter: 'settings', description: '更新设置 x', severity: 'info' },
  ]);
  const sections = inspectSections(analysis(), p);
  assert.deepEqual(
    sections.map((s) => ({ ...s })),
    [
      { section: 'settings', count: 1 },
      { section: 'plugins', count: 1 },
    ],
  );
});

test('inspectSections: 无 estimatedActions 的分区 count=0', () => {
  const p = plan([]);
  const sections = inspectSections(analysis({ sectionsInZip: ['settings', 'mcp'] }), p);
  assert.deepEqual(sections, [
    { section: 'settings', count: 0 },
    { section: 'mcp', count: 0 },
  ]);
});

test('inspectSummary: 统计口径与导入预览一致（P2-⑬ diff 摘要）', () => {
  const p = plan([
    { id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a', severity: 'info' },
    { id: 'settings:x', kind: 'Update', adapter: 'settings', description: '更新设置 x', severity: 'info' },
    { id: 'settings:y', kind: 'Conflict', adapter: 'settings', description: '冲突 y', severity: 'warning' },
    { id: 'prompt:z', kind: 'Skip', adapter: 'prompts', description: '一致跳过 z', severity: 'info' },
  ], [{ ref: 'SECRET_1', required: true }]);
  const s = inspectSummary(analysis({ pathIssues: [{ kind: 'missing', value: '/old/path' }] }), p);
  assert.equal(s.willChange, 3, 'Create+Update+Install+Conflict 计为将变更');
  assert.equal(s.unchanged, 1);
  assert.equal(s.conflicts, 1);
  assert.equal(s.secretsNeeded, 1);
  assert.equal(s.pathMappingsNeeded, 1);
  assert.equal(s.needsRestart, true, '有 Install → 需重启');
  assert.equal(s.changes.length, 4, '逐项列表透传全部计划项');
});

test('inspectGroupedChanges: 冲突/变更/路径映射优先分组且带颜色语义（P2-⑬ 变更明细）', () => {
  const p = plan([
    { id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a', severity: 'info' },
    { id: 'settings:x', kind: 'Update', adapter: 'settings', description: '更新设置 x', severity: 'info' },
    { id: 'settings:y', kind: 'Conflict', adapter: 'settings', description: '冲突 y', severity: 'warning' },
    { id: 'prompt:z', kind: 'Skip', adapter: 'prompts', description: '一致跳过 z', severity: 'info' },
    { id: 'ws:home', kind: 'PathMapping', adapter: 'workspaces', description: '路径映射 p', severity: 'warning' },
    { id: 'sec:1', kind: 'MissingSecret', adapter: 'secrets', description: '缺密钥 s', severity: 'warning' },
  ], []);
  const groups = inspectGroupedChanges(inspectSummary(analysis(), p));
  // 顺序：冲突 → 变更 → 路径映射 → 一致跳过 → 其他
  assert.deepEqual(groups.map((g) => g.key), ['conflicts', 'changes', 'paths', 'skipped', 'others']);
  assert.deepEqual(groups.map((g) => g.kind), ['error', 'info', 'warn', 'ok', 'warn'], '颜色语义映射');
  assert.equal(groups[0]!.items.length, 1, '冲突 1 项');
  assert.equal(groups[1]!.items.length, 2, 'Install + Update 归变更');
  assert.equal(groups[2]!.items.length, 1, '路径映射 1 项');
  assert.equal(groups[3]!.items.length, 1, '一致跳过 1 项');
  assert.equal(groups[4]!.items.length, 1, 'MissingSecret 归其他');
});

test('inspectGroupedChanges: 无某种类条目时跳过该组（空组不渲染）', () => {
  const p = plan([
    { id: 'settings:x', kind: 'Update', adapter: 'settings', description: '更新设置 x', severity: 'info' },
    { id: 'prompt:z', kind: 'Skip', adapter: 'prompts', description: '一致跳过 z', severity: 'info' },
  ], []);
  const groups = inspectGroupedChanges(inspectSummary(analysis(), p));
  assert.deepEqual(groups.map((g) => g.key), ['changes', 'skipped'], '无冲突/路径/其他 → 只返变更与跳过');
});

test('inspectGroupedChanges: 条目总数不丢（分组只是视图，不裁剪计划项）', () => {
  const items: PlanItem[] = [
    { id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a', severity: 'info' },
    { id: 'settings:x', kind: 'Update', adapter: 'settings', description: '更新设置 x', severity: 'info' },
    { id: 'settings:y', kind: 'Conflict', adapter: 'settings', description: '冲突 y', severity: 'warning' },
  ];
  const groups = inspectGroupedChanges(inspectSummary(analysis(), plan(items)));
  const total = groups.reduce((acc, g) => acc + g.items.length, 0);
  assert.equal(total, items.length, '分组后条目总数与全量一致');
});

test('groupPlanItems: 直接接受 PlanItem[]（配置档案预览与备份 diff 共用语义）', () => {
  const items: PlanItem[] = [
    { id: 'settings:y', kind: 'Conflict', adapter: 'settings', description: '冲突 y', severity: 'warning' },
    { id: 'ws:home', kind: 'PathMapping', adapter: 'workspaces', description: '路径映射 p', severity: 'warning' },
    { id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a', severity: 'info' },
  ];
  const groups = groupPlanItems(items);
  assert.deepEqual(groups.map((g) => g.key), ['conflicts', 'changes', 'paths'], '与 inspectGroupedChanges 同序');
  assert.deepEqual(groups.map((g) => g.kind), ['error', 'info', 'warn'], '颜色语义一致');
  assert.equal(groups.reduce((acc, g) => acc + g.items.length, 0), items.length, '不裁剪条目');
});