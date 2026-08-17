/**
 * conflict-view 测试（m6-ui，规范 §11）：
 * Keep Current / Use Imported / Review 决策收集与 core 决策表转换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictCollector } from './conflict-view.ts';
import { makePlan, makePlanItem } from './test-helpers.ts';

function conflictPlan() {
  return makePlan({
    items: [
      makePlanItem({ id: 'settings:a', kind: 'Conflict', description: '设置 a 与目标不同', detail: 'current={x:1} imported={x:2}' }),
      makePlanItem({ id: 'settings:b', kind: 'Conflict', description: '设置 b 与目标不同' }),
      makePlanItem({ id: 'plugin:c', kind: 'Conflict', adapter: 'plugins', description: '插件 c 版本不同' }),
      makePlanItem({ id: 'prompt:d', kind: 'Create', adapter: 'prompts', description: '创建提示 d' }),
    ],
  });
}

test('conflict-view: 只收集 Conflict 项', () => {
  const c = new ConflictCollector(conflictPlan());
  assert.equal(c.conflicts.length, 3);
  assert.equal(c.hasUnresolved, true);
});

test('conflict-view: resolve 设置决策；未知 id 忽略', () => {
  const c = new ConflictCollector(conflictPlan());
  assert.equal(c.resolve('settings:a', 'useImported'), true);
  assert.equal(c.resolve('nope', 'review'), false);
  assert.equal(c.decisionOf('settings:a'), 'useImported');
});

test('conflict-view: unresolved 只含未决/ review 项', () => {
  const c = new ConflictCollector(conflictPlan());
  c.resolve('settings:a', 'keepCurrent');
  c.resolve('plugin:c', 'review');
  const unresolved = c.unresolved();
  assert.deepEqual(unresolved.map((i) => i.id), ['settings:b', 'plugin:c']);
  assert.equal(c.hasUnresolved, true);
  c.resolve('settings:b', 'useImported');
  c.resolve('plugin:c', 'useImported');
  assert.equal(c.hasUnresolved, false);
});

test('conflict-view: toResolutions 输出 core 决策表', () => {
  const c = new ConflictCollector(conflictPlan());
  c.resolve('settings:a', 'keepCurrent');
  c.resolve('settings:b', 'useImported');
  const resolutions = c.toResolutions();
  assert.deepEqual(resolutions, { 'settings:a': 'keepCurrent', 'settings:b': 'useImported' });
});

test('conflict-view: viewItems 提供视图数据（React 绑定）', () => {
  const c = new ConflictCollector(conflictPlan());
  c.resolve('settings:a', 'useImported');
  const views = c.viewItems();
  assert.equal(views.length, 3);
  const first = views.find((v) => v.item.id === 'settings:a')!;
  assert.equal(first.resolution, 'useImported');
  assert.ok(first.currentSummary !== undefined);
});

test('conflict-view: 批量决策（ConflictList 按钮语义）遍历所有冲突并清空未决', () => {
  // 「全部保留当前配置」
  const keepAll = new ConflictCollector(conflictPlan());
  for (const item of keepAll.conflicts) keepAll.resolve(item.id, 'keepCurrent');
  assert.equal(keepAll.hasUnresolved, false);
  assert.equal(keepAll.toResolutions()['settings:a'], 'keepCurrent');
  assert.equal(keepAll.toResolutions()['plugin:c'], 'keepCurrent');

  // 「全部使用备份配置」
  const useAll = new ConflictCollector(conflictPlan());
  for (const item of useAll.conflicts) useAll.resolve(item.id, 'useImported');
  assert.equal(useAll.hasUnresolved, false);
  assert.equal(useAll.toResolutions()['settings:a'], 'useImported');
  assert.equal(useAll.toResolutions()['plugin:c'], 'useImported');
});
