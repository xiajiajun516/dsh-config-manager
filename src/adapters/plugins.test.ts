/**
 * plugins adapter 测试：插件清单 + 用户 patch 行导出、
 * 已装同版本 Skip / 未装 Install / patch 行 Create，applyItem（install → needsRestart；patch 写回）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginsAdapter, USER_PATCH_FILE } from './plugins.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('plugins: 导出剔除插件自身（默认 dsh-config-manager，可配置）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.plugins.installed.set('dsh-config-manager', { name: 'dsh-config-manager', version: '0.1.28', enabled: true });
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true });
  ctx.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true });

  // 默认 selfName = dsh-config-manager → 从导出清单剔除
  const adapter = new PluginsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.plugins.length, 2, '自身应被剔除');
  assert.ok(!out.data.plugins.some((p) => p.name === 'dsh-config-manager'), '导出清单不应包含自身');
  assert.ok(out.data.plugins.some((p) => p.name === '@linxin666/dsh-ssh'));
  assert.ok(out.data.plugins.some((p) => p.name === 'dsh-memory-evolve'));

  // 空 selfName 表示不过滤（保留全部）
  const adapterAll = new PluginsAdapter('');
  const outAll = await adapterAll.export(ctx, { includeSecrets: false });
  assert.equal(outAll.data.plugins.length, 3, 'selfName="" 不过滤');

  // 可配置成任意包名（如 scope 化安装名）
  const adapterScoped = new PluginsAdapter('@scope/dsh-config-manager');
  const outScoped = await adapterScoped.export(ctx, { includeSecrets: false });
  assert.equal(outScoped.data.plugins.length, 3, '不同包名不匹配 → 不过滤');
});

test('plugins: 导出清单与 patch 行', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true, isBundle: true, inBundles: ['@linxin666/dsh-web-ui-all'] });
  ctx.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true, spec: 'github:csyangwen/dsh-memory-evolve' });
  ctx.plugins.installed.set('@deepseek-ai/dsh-base', { name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.6', enabled: true });
  ctx.patchFile.lines.set('skill-badge', { lineId: 'skill-badge', raw: { id: 'skill-badge', disabled: true } });

  const adapter = new PluginsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.equal(out.data.plugins.length, 3);
  assert.equal(out.data.patch.length, 1);
  assert.equal(out.data.patch[0]?.lineId, 'skill-badge');
  const ssh = out.data.plugins.find((p) => p.name === '@linxin666/dsh-ssh');
  assert.equal(ssh?.isBundle, true);
  assert.deepEqual(ssh?.inBundles, ['@linxin666/dsh-web-ui-all']);
  // 非 registry spec 必须随导出保留（导入时按此重装）
  const mem = out.data.plugins.find((p) => p.name === 'dsh-memory-evolve');
  assert.equal(mem?.spec, 'github:csyangwen/dsh-memory-evolve');
  assert.equal(out.data.pnpmWorkspace, null, '目标无 pnpm-workspace.yaml → null');

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('plugins: 导出携带 pnpm-workspace.yaml；analyze 目标无文件 → Create', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode('allowBuilds:\n  ssh2: true\n'));
  const adapter = new PluginsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.pnpmWorkspace, 'allowBuilds:\n  ssh2: true\n');

  // 目标机没有该文件 → Create；有相同内容 → Skip；有不同内容 → Update
  const dst = makeContext('linux', '/home/bob', 'web');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  const wsItem = items.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.equal(wsItem?.kind, 'Create');
  assert.deepEqual(wsItem?.target, { adapter: 'plugins', ref: 'pnpm-workspace.yaml' });
  assert.equal(items[0]?.id, 'plugins:pnpm-workspace', 'pnpm-workspace 项必须先于插件安装项');

  // applyItem 写入目标 fs
  const r = await adapter.applyItem(wsItem!, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  const written = new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/pnpm-workspace.yaml')!);
  assert.equal(written, 'allowBuilds:\n  ssh2: true\n');

  // 内容一致 → Skip；不同 → Update
  const same = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(same.some((i) => i.id === 'plugins:pnpm-workspace'), false, '内容一致 → 不生成项');
  const other = makeContext('linux', '/home/bob', 'web');
  await other.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode('nodeLinker: isolated\n'));
  const diff = await adapter.analyzeImport(out.data, makeImportContext(other, new Map([['plugins', out.data]])));
  const diffItem = diff.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.equal(diffItem?.kind, 'Update');
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

test('plugins: 非 registry spec（github:）随导入传给 install，registry 包不传 spec', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true, spec: 'github:csyangwen/dsh-memory-evolve' });
  src.plugins.installed.set('dshmarket', { name: 'dshmarket', version: '1.0.3', enabled: true, spec: '^1.0.3' });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  await adapter.applyItem(items.find((i) => i.id === 'plugin:dsh-memory-evolve')!, makeImportContext(dst, sections));
  assert.equal(dst.plugins.lastSpec, 'github:csyangwen/dsh-memory-evolve', 'github: spec 必须原样传给安装通道');

  await adapter.applyItem(items.find((i) => i.id === 'plugin:dshmarket')!, makeImportContext(dst, sections));
  assert.equal(dst.plugins.lastSpec, '^1.0.3', 'registry 版本区间也透传（由门面决定按裸名装最新）');
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
  assert.match(r.message ?? '', /dsh plugin --profile web add broken-pkg/, '失败报告必须给可复制的手动安装命令');
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
