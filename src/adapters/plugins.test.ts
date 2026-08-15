/**
 * plugins adapter 测试：插件清单 + 用户 patch 行导出、
 * 已装同版本 Skip / 未装 Install / patch 行 Create，applyItem（install → needsRestart；patch 写回）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginsAdapter, USER_PATCH_FILE } from './plugins.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('plugins: 导出清单与 patch 行', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true, isBundle: true, inBundles: ['@linxin666/dsh-web-ui-all'] });
  ctx.plugins.installed.set('@deepseek-ai/dsh-base', { name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.6', enabled: true });
  ctx.patchFile.lines.set('skill-badge', { lineId: 'skill-badge', raw: { id: 'skill-badge', disabled: true } });

  const adapter = new PluginsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.equal(out.data.plugins.length, 2);
  assert.equal(out.data.patch.length, 1);
  assert.equal(out.data.patch[0]?.lineId, 'skill-badge');
  const ssh = out.data.plugins.find((p) => p.name === '@linxin666/dsh-ssh');
  assert.equal(ssh?.isBundle, true);
  assert.deepEqual(ssh?.inBundles, ['@linxin666/dsh-web-ui-all']);

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('plugins: 已装同版本 Skip / 未装 Install / 版本不同 Conflict / patch Create', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true });
  src.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '2.0.0', enabled: true });
  src.patchFile.lines.set('my-line', { lineId: 'my-line', raw: { id: 'my-line', name: 'pkg-c', config: { x: 1 } } });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true }); // 同版本
  dst.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.5.0', enabled: true }); // 不同版本
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get('plugin:pkg-a')?.kind, 'Skip');
  assert.equal(byId.get('plugin:pkg-b')?.kind, 'Conflict');
  assert.equal(byId.get('patch:my-line')?.kind, 'Create');
  assert.equal(byId.get('patch:my-line')?.target?.ref, 'my-line');

  // patch 行写入（Create）
  const r = await adapter.applyItem(byId.get('patch:my-line')!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.deepEqual(dst.patchFile.lines.get('my-line')?.raw, { id: 'my-line', name: 'pkg-c', config: { x: 1 } });
});

test('plugins: applyItem Install → needsRestart（官方机制，不打包二进制）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('need-install', { name: 'need-install', version: '3.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const installItem = items.find((i) => i.id === 'plugin:need-install');
  assert.equal(installItem?.kind, 'Install');
  assert.equal(installItem?.target, undefined, 'Install 项不做快照（不可回滚，如实报告）');
  const r = await adapter.applyItem(installItem!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.ok(dst.plugins.installed.has('need-install'), '经 installPlugin 门面写入');
});

test('plugins: 安装失败 → 非致命 warning（§34.17，不触发整体回滚）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('broken-pkg', { name: 'broken-pkg', version: '3.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.plugins.failInstall = true; // 模拟 npm ERESOLVE / 网络不可达
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const installItem = items.find((i) => i.id === 'plugin:broken-pkg');
  assert.equal(installItem?.kind, 'Install');
  const r = await adapter.applyItem(installItem!, makeImportContext(dst, sections));
  assert.equal(r.ok, false);
  assert.equal(r.warning, true, '安装失败必须记为 warning（不计入失败、不触发回滚）');
  assert.match(r.message ?? '', /ERESOLVE/);
  assert.ok(!dst.plugins.installed.has('broken-pkg'), '安装失败不得假装已写入');
});

test('plugins: 版本冲突 useImported → Update 走安装通道，失败同样为 warning', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '2.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.5.0', enabled: true });
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const conflict = items.find((i) => i.id === 'plugin:pkg-b');
  assert.equal(conflict?.kind, 'Conflict');
  // 模拟 analyzer 在 createImportPlan 中对 useImported 的解析结果
  const updateItem: PlanItem = { ...conflict!, kind: 'Update', conflict: { itemId: conflict!.id, resolution: 'useImported' } };

  const rOk = await adapter.applyItem(updateItem, makeImportContext(dst, sections));
  assert.equal(rOk.ok, true, 'Update 应走安装通道，而不是报缺少 target.ref');
  assert.equal(rOk.needsRestart, true);

  dst.plugins.failInstall = true;
  const rFail = await adapter.applyItem(updateItem, makeImportContext(dst, sections));
  assert.equal(rFail.ok, false);
  assert.equal(rFail.warning, true, '更新失败同样为非致命 warning');
});
