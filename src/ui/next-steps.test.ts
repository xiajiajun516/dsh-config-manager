/**
 * next-steps 测试：导入/同步后收尾清单纯函数（P0-① / P2-⑪）。
 * 覆盖：待重启项的判定（Install / mcp 变更 vs 其他）、可重试项的过滤
 * （failed / skippedByUser，引擎 Skip 不算）、聚合清单的 hasNextSteps。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImportPlan, ImportResult, PlanItem } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';
import { importNextSteps, restartRequiredItems, unresolvedItems } from './next-steps.ts';

/** 全分区 0 计数的 estimatedActions（类型要求完整 Record<SectionId, number>） */
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

function plan(items: PlanItem[]): ImportPlan {
  return {
    items,
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: emptyEstimatedActions(),
  };
}

function planItem(partial: Partial<PlanItem> & { id: string; kind: PlanItem['kind'] }): PlanItem {
  return {
    adapter: 'settings',
    description: '',
    severity: 'info',
    ...partial,
  };
}

function result(executed: ImportResult['executed'], missingSecrets: string[] = []): ImportResult {
  return {
    ok: true,
    executed,
    needsRestart: false,
    missingSecrets,
    warnings: [],
    rollback: null,
    snapshotId: null,
  };
}

test('next-steps: restartRequiredItems 只列出 Install 插件与 mcp 变更', () => {
  const p = plan([
    planItem({ id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a' }),
    planItem({ id: 'mcp:b', kind: 'Create', adapter: 'mcp', description: '新增 MCP b' }),
    planItem({ id: 'settings:c', kind: 'Update', adapter: 'settings', description: '更新设置 c' }),
    planItem({ id: 'mcp:d', kind: 'Skip', adapter: 'mcp', description: 'MCP d 已存在' }),
    planItem({ id: 'prompt:e', kind: 'Create', adapter: 'prompts', description: '新增提示 e' }),
  ]);
  const restart = restartRequiredItems(p);
  assert.deepEqual(restart.map((r) => r.id), ['plugin:a', 'mcp:b'], '只列出 Install 与 mcp 非 skip 变更');
  assert.deepEqual(restart.map((r) => r.adapter), ['plugins', 'mcp']);
});

test('next-steps: unresolvedItems 只含 failed 与 skippedByUser（引擎 Skip 不算）', () => {
  const r = result([
    { itemId: 'plugin:fail', status: 'failed', message: '安装失败' },
    { itemId: 'plugin:user-skip', status: 'skipped', skippedByUser: true },
    { itemId: 'plugin:engine-skip', status: 'skipped' },
    { itemId: 'settings:ok', status: 'ok' },
    { itemId: 'mcp:warn', status: 'warning' },
  ]);
  const unresolved = unresolvedItems(r);
  assert.deepEqual(
    unresolved.map((u) => u.id),
    ['plugin:fail', 'plugin:user-skip'],
    '只统计 failed 与 skippedByUser',
  );
  assert.equal(unresolved.find((u) => u.id === 'plugin:fail')?.status, 'failed');
  assert.equal(unresolved.find((u) => u.id === 'plugin:user-skip')?.status, 'skipped');
  assert.equal(unresolved.find((u) => u.id === 'plugin:fail')?.message, '安装失败');
});

test('next-steps: importNextSteps 聚合 restartItems + missingSecrets + unresolved', () => {
  const p = plan([
    planItem({ id: 'plugin:a', kind: 'Install', adapter: 'plugins', description: '安装插件 a' }),
  ]);
  const r = result(
    [
      { itemId: 'plugin:a', status: 'ok' },
      { itemId: 'plugin:b', status: 'failed', message: '失败' },
    ],
    ['API_KEY_1', 'API_KEY_2'],
  );
  const steps = importNextSteps(p, r);
  assert.equal(steps.restartItems.length, 1);
  assert.deepEqual(steps.missingSecrets, ['API_KEY_1', 'API_KEY_2']);
  assert.equal(steps.unresolved.length, 1);
  assert.equal(steps.hasNextSteps, true, '有任何收尾动作 → hasNextSteps=true');
});

test('next-steps: 无收尾动作时 hasNextSteps=false（导入完成且无重启/补录/失败）', () => {
  const p = plan([
    planItem({ id: 'settings:c', kind: 'Update', adapter: 'settings', description: '更新设置 c' }),
  ]);
  const r = result([{ itemId: 'settings:c', status: 'ok' }]);
  const steps = importNextSteps(p, r);
  assert.equal(steps.restartItems.length, 0);
  assert.equal(steps.missingSecrets.length, 0);
  assert.equal(steps.unresolved.length, 0);
  assert.equal(steps.hasNextSteps, false, '全部完成 → 无需收尾');
});