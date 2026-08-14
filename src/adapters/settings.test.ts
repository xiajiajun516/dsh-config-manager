/**
 * settings adapter 测试：非 UI namespace 导出（redact+revision）/ Create·Skip·Conflict 分析 /
 * applyItem 乐观锁写回 / validate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsAdapter } from './settings.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

const NS = ['general', 'theme', 'llm-deepseek'];

test('settings: 导出只含非 UI namespace（redacted + revision + secrets 标记）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] }); // UI 类 → 排除
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });

  const adapter = new SettingsAdapter(NS);
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.ok(out.data.namespaces['general']);
  assert.ok(out.data.namespaces['llm-deepseek']);
  assert.ok(!out.data.namespaces['theme'], 'theme 属 UI 类，应被 settings 排除');
  assert.equal(out.data.namespaces['llm-deepseek']?.revision, 5);
  assert.deepEqual(out.data.namespaces['llm-deepseek']?.secrets, [{ path: ['apiKey'], set: true }]);
  assert.equal(out.counts.namespaces, 2);

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('settings: analyzeImport Create/Skip/Conflict + applyItem 写回（幂等）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  const adapter = new SettingsAdapter(NS);
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['settings', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  // 目标无 → Create 并写入
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.target?.ref, 'general');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' });

  // 重复导入 → Skip（幂等）
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 目标不同 → Conflict；useImported（Update）后覆盖
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
  const useItem: PlanItem = { ...items[0]!, kind: 'Update' };
  await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' });
});

test('settings: applyItem 读时锁 — 目标 revision 不同时仍按当前值提交（不覆盖并发修改）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  const adapter = new SettingsAdapter(NS);
  const exported = await adapter.export(src, { includeSecrets: false });

  const dst = makeContext('linux', '/home/bob');
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
  const sections = new Map([['settings', exported.data]]);
  const item: PlanItem = {
    id: 'settings:general', kind: 'Update', adapter: 'settings',
    description: '更新 general', severity: 'info',
    target: { adapter: 'settings', ref: 'general' },
  };
  const r = await adapter.applyItem(item, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' }, 'useImported 应覆盖目标');
  assert.equal(dst.settings.ns.get('general')?.revision, 10, '提交后 revision 递增');
});

test('settings: validate 拒绝非法结构', async () => {
  const adapter = new SettingsAdapter(NS);
  const bad = await adapter.validate({ version: 2, namespaces: {} } as never);
  assert.equal(bad.valid, false);
  const noNs = await adapter.validate({ version: 1, namespaces: null as never });
  assert.equal(noNs.valid, false);
});
