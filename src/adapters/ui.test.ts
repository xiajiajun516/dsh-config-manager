/**
 * ui adapter 测试：UI namespace 名单切分（与 settings 互斥）、uiMigrationNotes 说明导出、写回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UiAdapter, isUiNamespace, UI_MIGRATION_NOTES } from './ui.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';

const NS = ['general', 'theme', 'pet', 'dsh-better-sidebar', 'llm-deepseek'];

test('ui: 名单识别与 settings 互斥切分', () => {
  assert.equal(isUiNamespace('theme'), true);
  assert.equal(isUiNamespace('pet'), true);
  assert.equal(isUiNamespace('dsh-better-sidebar'), true);
  assert.equal(isUiNamespace('ui-onboarding'), true);
  assert.equal(isUiNamespace('general'), false);
  assert.equal(isUiNamespace('llm-deepseek'), false);
});

test('ui: 导出只含 UI namespace + uiMigrationNotes（纯说明）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.settings.ns.set('pet', { value: { position: 'bottom-right' }, revision: 2, secrets: [] });

  const adapter = new UiAdapter(NS);
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.ok(out.data.namespaces['theme']);
  assert.ok(out.data.namespaces['pet']);
  assert.ok(!out.data.namespaces['general'], 'general 非 UI 类，应被 ui 排除');
  assert.equal(out.counts.namespaces, 2);
  assert.ok(out.data.uiMigrationNotes.length >= 1);
  assert.equal(out.data.uiMigrationNotes[0]?.migratable, false);
  assert.equal(UI_MIGRATION_NOTES.length, out.data.uiMigrationNotes.length);

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('ui: analyzeImport 与 applyItem 写回', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  const adapter = new UiAdapter(NS);
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['ui', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.settings.registered.add('theme'); // 目标已注册该 UI 命名空间（空值 → Create）
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.adapter, 'ui');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('theme')?.value, { mode: 'dark' });
});
