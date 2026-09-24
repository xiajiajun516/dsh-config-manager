/**
 * workspaces adapter 测试：绝对路径导出、Create/Skip/Conflict + PathMapping 项、
 * applyItem 写 record（PathMapper 先行后的映射数据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacesAdapter, isCreatableWorkspacePath } from './workspaces.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import { applyPrefixMappings } from '../utils/paths.ts';
import { projectKeyOf } from '../core/session-select.ts';
import type { WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
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

test('isCreatableWorkspacePath：完全限定 + 拒绝 .. （路径来自备份，按不可信输入处理）', () => {
  assert.equal(isCreatableWorkspacePath('C:\\Users\\alice\\ops', 'win32'), true);
  assert.equal(isCreatableWorkspacePath('C:/Users/alice/ops', 'win32'), true);
  assert.equal(isCreatableWorkspacePath('C:ops', 'win32'), false, '驱动器相对路径不是完全限定');
  assert.equal(isCreatableWorkspacePath('/home/bob/ops', 'win32'), false);
  assert.equal(isCreatableWorkspacePath('/home/bob/ops', 'linux'), true);
  assert.equal(isCreatableWorkspacePath('C:\\Users\\alice', 'linux'), false);
  assert.equal(isCreatableWorkspacePath('ops', 'linux'), false, '相对路径会跟随进程 cwd');
  assert.equal(isCreatableWorkspacePath('C:\\a\\..\\b', 'win32'), false);
  assert.equal(isCreatableWorkspacePath('/home/bob/../evil', 'linux'), false);
  assert.equal(isCreatableWorkspacePath('', 'linux'), false);
});

/** 用一条指定记录构造导入上下文（绕过导出，便于直接测 applyItem 的边界）。 */
function ctxWithRecord(dst: ReturnType<typeof makeContext>, rec: WorkspaceRecord, sessions?: unknown) {
  const sections = new Map<string, unknown>([['workspaces', { version: 1, workspaces: [rec] }]]);
  // issue #45 ③：可选注入 sessions 分区（测试「本包带了数据的会话」这条兜底）
  if (sessions !== undefined) sections.set('sessions', sessions);
  return { ctx: makeImportContext(dst, sections), sections };
}

/** sessions 分区的会话文件条目（relativePath 是包内相对路径，末两段 = 项目键/会话目录）。 */
function sessionFile(projectKey: string, dirName: string): { relativePath: string } {
  return { relativePath: projectKey + '/' + dirName + '/session.jsonl.zstd' };
}

const REC: WorkspaceRecord = {
  id: 'ws-ops', path: '/home/bob/projects/ops', title: 'OpsFlow', sessionIds: [], createdAt: 'c', updatedAt: 'c',
};

test('issue #45 ①：写记录前建缺失目录（报告实际创建的目录）', async () => {
  const dst = makeContext('linux', '/home/bob');
  const asked: string[] = [];
  dst.fs.ensureDir = async (p: string) => { asked.push(p); return ['/home/bob', '/home/bob/projects', '/home/bob/projects/ops']; };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, REC);
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
  const r = await adapter.applyItem(create, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(asked, ['/home/bob/projects/ops'], '按记录路径请求建目录');
  assert.match(r.message ?? '', /已创建备份里声明/);
  assert.match(r.message ?? '', /\/home\/bob\/projects\/ops/);
  assert.equal(dst.workspace.records.get('ws-ops')?.path, '/home/bob/projects/ops');
});

test('issue #45 ①：建目录失败不致命（写入仍成功，说明如实进报告）', async () => {
  const dst = makeContext('linux', '/home/bob');
  dst.fs.ensureDir = async () => { throw new Error('EACCES: permission denied'); };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, REC);
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
  const r = await adapter.applyItem(create, ctx);
  assert.equal(r.ok, true, '建目录失败不拖垮写入');
  assert.match(r.message ?? '', /创建目录失败/);
  assert.match(r.message ?? '', /EACCES/);
  assert.equal(dst.workspace.records.get('ws-ops')?.id, 'ws-ops');
});

test('issue #45 ①：建目录后写入仍失败 → 非致命警告 + 保留建目录说明', async () => {
  const dst = makeContext('linux', '/home/bob');
  dst.fs.ensureDir = async () => ['/home/bob/projects/ops'];
  dst.workspace.writeRecord = async () => { throw new Error("ENOENT: realpath '/home/bob/projects/ops'"); };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, REC);
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
  const r = await adapter.applyItem(create, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.warning, true);
  assert.match(r.message ?? '', /realpath/);
  assert.match(r.message ?? '', /已创建备份里声明/);
});

test('issue #45 ①：不可安全创建的路径不建目录（含说明，不静默）', async () => {
  const dst = makeContext('linux', '/home/bob');
  let called = false;
  dst.fs.ensureDir = async () => { called = true; return []; };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, { ...REC, path: 'projects/ops' });
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
  const r = await adapter.applyItem(create, ctx);
  assert.equal(called, false, '相对路径不得触发建目录');
  assert.match(r.message ?? '', /不是可安全创建的绝对路径/);
});

const CREATE_WS: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
/** 包内会话 uuid（目录名形态）与注册表口径（session-<uuid>） */
const IN_BUNDLE_DIR = '11111111-2222-3333-4444-555555555555';
const IN_BUNDLE_ID = 'session-' + IN_BUNDLE_DIR;
const OUT_BUNDLE_ID = 'session-99999999-8888-7777-6666-555555555555';
const OUT_BUNDLE_BARE = '99999999-8888-7777-6666-555555555555';

test('issue #45 ②：导入收尾时把备份记录声明的会话登记进目标工作区（失败如实计数）', async () => {
  const dst = makeContext('linux', '/home/bob');
  const calls: [string, string][] = [];
  dst.workspace.attachSession = async (workspaceId: string, sessionId: string) => {
    calls.push([workspaceId, sessionId]);
    // 两种命名形态都失败（目标机根本没有这条会话）
    if (sessionId.includes(OUT_BUNDLE_BARE)) throw new Error('cwd does not resolve');
  };
  const adapter = new WorkspacesAdapter();
  // 本包带了 IN_BUNDLE_ID 的数据；OUT_BUNDLE_ID 只是备份记录里声明的包外会话
  const { ctx } = ctxWithRecord(
    dst,
    { ...REC, sessionIds: [IN_BUNDLE_ID, OUT_BUNDLE_ID] },
    { version: 1, files: [sessionFile(projectKeyOf(REC.path), IN_BUNDLE_DIR)] },
  );
  await adapter.applyItem(CREATE_WS, ctx);
  const results = await adapter.finalizeImport(ctx);
  // 包内那条：声明的 id 就成功 → 只试一次；包外那条：两种命名形态都失败（真机里那些会话在目标机根本不存在）
  assert.deepEqual(calls, [['ws-ops', IN_BUNDLE_ID], ['ws-ops', OUT_BUNDLE_ID], ['ws-ops', OUT_BUNDLE_BARE]], '登记发生在收尾阶段（会话写完 + 首帧改写之后），包内 id 不重复登记');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, true, '带数据的会话全部登记成功 → 成功（包外会话失败不算导入失败）');
  assert.match(results[0]?.message ?? '', /已把 1 个会话登记进该工作区/);
  assert.match(results[0]?.message ?? '', /不在此备份包内/, '包外会话单独说明，不再误导用户去改路径映射');
});

test('issue #45 ③：包内带数据的会话**即使备份记录没声明**也要登记进工作区（旧包/第三方导出器兜底）', async () => {
  const dst = makeContext('linux', '/home/bob');
  const calls: string[] = [];
  dst.workspace.attachSession = async (_workspaceId: string, sessionId: string) => { calls.push(sessionId); };
  const adapter = new WorkspacesAdapter();
  // 真机事故现场：用户勾了对话导出，但这些 id **不在**工作区记录的 sessionIds 里（DSH 覆盖率极低）
  const { ctx } = ctxWithRecord(
    dst,
    { ...REC, sessionIds: [] },
    { version: 1, files: [sessionFile(projectKeyOf(REC.path), IN_BUNDLE_DIR)] },
  );
  await adapter.applyItem(CREATE_WS, ctx);
  const results = await adapter.finalizeImport(ctx);
  assert.deepEqual(calls, [IN_BUNDLE_DIR], '按「包内实际带数据的会话」登记，写日志侧原名（= header id，注册表认的那个）');
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]?.message ?? '', /已把 1 个会话登记进该工作区/);
});

test('issue #45 ③：声明 id 与日志 header 形态不同（session-x ↔ x）→ 自动兜底登记成功', async () => {
  const dst = makeContext('linux', '/home/bob');
  const calls: string[] = [];
  dst.workspace.attachSession = async (_workspaceId: string, sessionId: string) => {
    calls.push(sessionId);
    // 真机复现：DSH 只认会话日志首帧 header 里的 id（这里是裸 uuid），注册表写 session-<uuid>
    if (sessionId !== IN_BUNDLE_DIR) {
      throw new Error(`cannot validate session '${sessionId}': session persistence holds no such session`);
    }
  };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(
    dst,
    { ...REC, sessionIds: [IN_BUNDLE_ID] },
    { version: 1, files: [sessionFile(projectKeyOf(REC.path), IN_BUNDLE_DIR)] },
  );
  await adapter.applyItem(CREATE_WS, ctx);
  const results = await adapter.finalizeImport(ctx);
  assert.deepEqual(calls, [IN_BUNDLE_ID, IN_BUNDLE_DIR], '先试声明形态，被拒后自动试另一种命名形态');
  assert.equal(results[0]?.ok, true, '兜底成功不得报成失败');
  assert.match(results[0]?.message ?? '', /已把 1 个会话登记进该工作区/);
});

test('issue #45 ③：带数据的会话登记失败 → 报真实原因（不再吞掉错误、不再猜路径）', async () => {
  const dst = makeContext('linux', '/home/bob');
  dst.workspace.attachSession = async () => {
    throw new Error("cannot attach session 'x': its cwd '/opt/old' does not resolve, so it cannot be validated");
  };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(
    dst,
    { ...REC, sessionIds: [] },
    { version: 1, files: [sessionFile(projectKeyOf(REC.path), IN_BUNDLE_DIR)] },
  );
  await adapter.applyItem(CREATE_WS, ctx);
  const results = await adapter.finalizeImport(ctx);
  assert.equal(results[0]?.ok, false, '带数据的会话没登记上 → 不能报成功');
  assert.equal(results[0]?.warning, true, '非致命：不动整体导入的回滚');
  assert.match(results[0]?.message ?? '', /1 个本次导入的会话未能登记/);
  assert.match(results[0]?.message ?? '', /does not resolve/, '必须把真实失败原因带出来');
  assert.match(results[0]?.message ?? '', /路径映射|sessions repair/);
});

test('issue #45 ③：sessions 分区缺席（纯工作区包）→ 行为与改造前一致（只按记录声明登记）', async () => {
  const dst = makeContext('linux', '/home/bob');
  const calls: string[] = [];
  dst.workspace.attachSession = async (_workspaceId: string, sessionId: string) => { calls.push(sessionId); };
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, { ...REC, sessionIds: [IN_BUNDLE_ID] });
  await adapter.applyItem(CREATE_WS, ctx);
  const results = await adapter.finalizeImport(ctx);
  assert.deepEqual(calls, [IN_BUNDLE_ID]);
  assert.equal(results[0]?.ok, true);
});

test('issue #45 ②：全部登记成功 → 说明如实回报；无 sessionIds → 不产生多余文案', async () => {
  const dst = makeContext('linux', '/home/bob');
  let count = 0;
  dst.workspace.attachSession = async () => { count += 1; };
  const adapter = new WorkspacesAdapter();
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };

  const withSessions = ctxWithRecord(dst, { ...REC, sessionIds: ['s1', 's2'] });
  await adapter.applyItem(create, withSessions.ctx);
  const r1 = await adapter.finalizeImport(withSessions.ctx);
  assert.equal(count, 2);
  assert.equal(r1[0]?.ok, true);
  assert.match(r1[0]?.message ?? '', /已把 2 个会话登记进该工作区/);

  const dst2 = makeContext('linux', '/home/bob');
  const plain = ctxWithRecord(dst2, REC);
  await adapter.applyItem(create, plain.ctx);
  const r2 = await adapter.finalizeImport(plain.ctx);
  assert.deepEqual(r2, [], '无 sessionIds → 不产生多余结果（保持既有行为）');
});

test('issue #45 ②：宿主不支持会话登记 → 明确提示并可执行，不静默', async () => {
  const dst = makeContext('linux', '/home/bob');
  const adapter = new WorkspacesAdapter();
  const { ctx } = ctxWithRecord(dst, { ...REC, sessionIds: ['s1'] });
  const create: PlanItem = { id: 'workspace:ws-ops', kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info', target: { adapter: 'workspaces', ref: 'ws-ops' } };
  await adapter.applyItem(create, ctx);
  const results = await adapter.finalizeImport(ctx);
  assert.equal(results[0]?.ok, false, '没登记成功就不能报成功');
  assert.equal(results[0]?.warning, true);
  assert.match(results[0]?.message ?? '', /不支持会话登记/);
  assert.match(results[0]?.message ?? '', /sessions repair/);
});

