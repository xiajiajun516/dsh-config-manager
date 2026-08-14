/**
 * workspaces adapter 测试：绝对路径导出、Create/Skip/Conflict + PathMapping 项、
 * applyItem 写 record（PathMapper 先行后的映射数据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacesAdapter } from './workspaces.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import { applyPrefixMappings } from '../utils/paths.ts';
import type { WorkspacesSection } from '../schema/types.ts';
import type { PlanItem } from '../core/types.ts';

test('workspaces: 导出 records（含绝对路径）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  const adapter = new WorkspacesAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.workspaces.length, 1);
  assert.equal(out.data.workspaces[0]?.path, 'C:\\Users\\alice\\projects\\ops');
  assert.equal(out.counts.workspaces, 1);
  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('workspaces: analyzeImport 生成 Create + PathMapping（绝对路径）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  const adapter = new WorkspacesAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['workspaces', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 2);
  const create = items.find((i) => i.id === 'workspace:ws-ops');
  const pathItem = items.find((i) => i.id === 'workspace:ws-ops:path');
  assert.equal(create?.kind, 'Create');
  assert.equal(pathItem?.kind, 'PathMapping');
  assert.deepEqual(pathItem?.pathMapping?.appliesTo, ['workspaces']);
  assert.equal(pathItem?.pathMapping?.oldPrefix, 'C:\\Users\\alice\\projects\\ops');
});

test('workspaces: applyItem 写入映射后数据（PathMapper 先行）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  const adapter = new WorkspacesAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });

  // 模拟 PathMapper：把映射应用到 sections
  const mappedData = applyPrefixMappings(exported.data, [
    { oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces'] },
  ]) as WorkspacesSection;
  assert.equal(mappedData.workspaces[0]?.path, '/home/bob/projects/ops');

  const sections = new Map([['workspaces', mappedData]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(mappedData, makeImportContext(dst, sections));
  const create = items.find((i) => i.id === 'workspace:ws-ops') as PlanItem;
  const r = await adapter.applyItem(create, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  const rec = dst.workspace.records.get('ws-ops');
  assert.ok(rec);
  assert.equal(rec.path, '/home/bob/projects/ops', '写入的是映射后路径');

  // PathMapping 项 applyItem 无副作用
  const pathItem = items.find((i) => i.id === 'workspace:ws-ops:path') as PlanItem;
  const r2 = await adapter.applyItem(pathItem, makeImportContext(dst, sections));
  assert.equal(r2.ok, true);

  // 幂等
  const items2 = await adapter.analyzeImport(mappedData, makeImportContext(dst, sections));
  assert.equal(items2.find((i) => i.id === 'workspace:ws-ops')?.kind, 'Skip');
});

test('workspaces: applyItem 写入失败（路径 realpath ENOENT）→ warning 非致命，不抛错', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  const adapter = new WorkspacesAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['workspaces', exported.data]]);
  const dst = makeContext('linux', '/home/bob');
  // 模拟目标端工作区服务对不存在路径 realpath 失败（dsh-workspace 真实行为）
  const original = dst.workspace.writeRecord.bind(dst.workspace);
  dst.workspace.writeRecord = async () => {
    throw new Error("ENOENT: no such file or directory, realpath '/home/bob/projects/ops'");
  };
  try {
    const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
    const create = items.find((i) => i.id === 'workspace:ws-ops') as PlanItem;
    const r = await adapter.applyItem(create, makeImportContext(dst, sections));
    assert.equal(r.ok, false, '写入失败');
    assert.equal(r.warning, true, '应为非致命警告（§34.17：不拖垮整体导入）');
    assert.match(r.message ?? '', /未能写入|realpath/);
  } finally {
    dst.workspace.writeRecord = original;
  }
});

