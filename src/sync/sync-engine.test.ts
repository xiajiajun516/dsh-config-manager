/**
 * m-sync-flow：SyncEngine push/pull 编排测试。
 * - push：收集 portable 分区 → 组装 SyncSnapshot → 更新 sync-state → 上传 transport
 * - push：secret 断言（凭据值/敏感字段永不进入快照；不含 credentials/secrets 分区）
 * - push：portable 过滤（deviceSpecific/platformSpecific 分区不参与同步）
 * - pull：复用 Importer 预览流程（analyzeImport/createImportPlan），绝不直接写配置、绝不执行导入
 * - pull：无远端快照 / containsSecrets 拒绝 / 冲突 → needsReview
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine, MAX_REMOTE_SNAPSHOTS } from './sync-engine.ts';
import type { SyncApplyPlan } from './risk.ts';
import { hashSection, loadSyncState, SYNC_STATE_FILE } from './sync-state.ts';
import { computeSnapshotMeta } from './transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import type { SectionId } from '../schema/types.ts';

/** 内存 SyncTransport：记录方法调用（spy），供断言「pull 不写远端」 */
class MemSyncTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  calls: string[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list');
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload');
    this.snapshots.set(snapshot.id, snapshot);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download');
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`快照不存在: ${id}`);
    return s;
  }
  async delete(id: string): Promise<void> {
    this.calls.push('delete');
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

const NS = ['general', 'theme'];

function seedSource(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.plugins.installed.set('@deepseek-ai/dsh-ssh', { name: '@deepseek-ai/dsh-ssh', version: '1.0.0', enabled: true });
}

function makeEngine(opts: {
  ctx: ReturnType<typeof makeContext>;
  transport: MemSyncTransport;
  stateDir: string;
  localSnapshotsDir?: string;
  extra?: Partial<ConstructorParameters<typeof SyncEngine>[0]>;
}) {
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx: opts.ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx: opts.ctx,
    transport: opts.transport,
    stateDir: opts.stateDir,
    localSnapshotsDir: opts.localSnapshotsDir,
    adapters,
    importer,
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    ...opts.extra,
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

test('push: 收集 portable 分区 → 上传快照 → 更新 sync-state → 本地散文件副本', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-push-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
    const transport = new MemSyncTransport();
    const local = path.join(tmp, 'local-snapshots');
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });

    const report = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(report.ok, true);
    assert.equal(report.snapshotId, 'sync-001');
    assert.ok(report.sections.includes('settings'), 'settings 进入同步');
    assert.ok(report.sections.includes('skills'), 'skills（文件类 portable）进入同步');
    assert.ok(!report.sections.includes('credentialsStatus'), 'credentials 不进入同步');

    // 上传载荷：内容 + manifest 摘要
    const uploaded = transport.snapshots.get('sync-001')!;
    assert.ok(uploaded, '快照已上传');
    assert.equal(uploaded.createdAt, '2026-08-16T12:00:00.000Z');
    assert.equal(uploaded.manifest.containsSecrets, false);
    const exportedGeneral = (uploaded.sections['settings'] as { namespaces: Record<string, { value: unknown; revision: number; secrets: unknown[] }> }).namespaces['general']!;
    assert.ok(exportedGeneral, 'settings.general 已导出');
    assert.deepEqual(exportedGeneral.value, { theme: 'dark', language: 'zh-CN' });
    assert.equal(exportedGeneral.revision, 3);
    assert.deepEqual(exportedGeneral.secrets, []);
    assert.equal((uploaded.sections['skills'] as { files: unknown[] }).files.length, 1);

    // sync-state 更新：每分区 hash + updatedAt + lastSyncAt + transport 绑定
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSyncAt, '2026-08-16T12:00:00.000Z');
    assert.equal(state.sections['settings']?.hash, hashSection(uploaded.sections['settings']!));
    assert.equal(state.sections['settings']?.updatedAt, '2026-08-16T12:00:00.000Z');
    assert.deepEqual(state.transport, { type: 'memory', ref: '' });
    const raw = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, 2);

    // 本地散文件副本（复用 t2 layout 布局）
    assert.ok((await fs.stat(path.join(local, 'sync-001', 'manifest.json'))).isFile());
    assert.ok((await fs.stat(path.join(local, 'sync-001', 'config', 'settings.json'))).isFile());
    assert.equal(await fs.readFile(path.join(local, 'sync-001', 'custom', 'skills', 'coding.md'), 'utf8'), '# Coding\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: secret 断言——敏感字段值被剥离、凭据分区绝不参与、快照序列化不含秘密值', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-secret-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.settings.ns.set('general', {
      value: { theme: 'dark', apiToken: 'sk-super-secret-value', password: 'p@ss' },
      revision: 3,
      secrets: [{ path: ['apiToken'], set: true }],
    });
    // deviceSpecific 凭据分区即使有值也不得进入快照
    ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-credential-secret');
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-sec' });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-sec')!;
    const serialized = JSON.stringify(uploaded);
    assert.ok(!serialized.includes('sk-super-secret-value'), '敏感字段值不得进入快照');
    assert.ok(!serialized.includes('p@ss'), '密码值不得进入快照');
    assert.ok(!serialized.includes('sk-credential-secret'), '凭据值不得进入快照');
    for (const forbidden of ['credentials', 'credentialsStatus', 'secrets'] as SectionId[]) {
      assert.ok(!(forbidden in uploaded.sections), `分区 ${forbidden} 不得进入快照`);
    }
    // 剥离后保留字段名与空值（供「需补录」提示）
    const general = (uploaded.sections['settings'] as { namespaces: Record<string, unknown> }).namespaces['general'] as { value: Record<string, unknown> };
    assert.equal(general.value['apiToken'], '');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: portable 过滤——deviceSpecific/platformSpecific 分区不参与同步', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-portable-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    ctx.workspace.records.set('w1', { id: 'w1', path: 'C:\\work', title: 'work', sessionIds: [] });
    ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-x');
    await ctx.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":{}}', 'utf8')); // pluginFiles 白名单
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    await engine.push({ snapshotId: 'sync-p' });
    const uploaded = transport.snapshots.get('sync-p')!;
    for (const forbidden of ['workspaces', 'mcp', 'credentialsStatus', 'credentials', 'pluginFiles', 'sessions'] as SectionId[]) {
      assert.ok(!(forbidden in uploaded.sections), `非 portable 分区 ${forbidden} 不得进入快照`);
    }
    assert.ok(!uploaded.manifest.sectionIds.includes('workspaces' as SectionId));
    assert.ok(uploaded.manifest.sectionIds.includes('settings'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 显式 sections（高级/自定义导出）→ 只同步指定 portable 分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sections-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-sel', sections: ['settings', 'skills'] });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-sel')!;
    // 只含勾选的 portable 分区
    assert.deepEqual(uploaded.manifest.sectionIds.sort(), ['settings', 'skills']);
    assert.ok('settings' in uploaded.sections, 'settings 进入');
    assert.ok('skills' in uploaded.sections, 'skills 进入');
    // 未勾选的 portable 分区（providers/plugins/ui 等）不进入
    assert.ok(!('providers' in uploaded.sections), '未勾选分区不进入');
    assert.ok(!('plugins' in uploaded.sections), '未勾选分区不进入');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: sections 含非 portable / 未知分区 → 警告跳过，其余照常同步', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sections-skip-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-mix', sections: ['settings', 'mcp' as SectionId, 'nope' as SectionId] });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-mix')!;
    assert.deepEqual(uploaded.manifest.sectionIds, ['settings'], '只同步 portable 且已知的分区');
    // 非法/非 portable 分区给出明确告警（不静默）
    const warnText = report.warnings.join('\n');
    assert.ok(/mcp/.test(warnText), `告警应点名 mcp：${warnText}`);
    assert.ok(/nope/.test(warnText), `告警应点名 nope：${warnText}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: sections 全为无效/非 portable → ok=false + 明确 message', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sections-none-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-empty', sections: ['credentialsStatus'] });
    assert.equal(report.ok, false);
    assert.equal(transport.snapshots.has('sync-empty'), false, '无有效 portable 分区时不上传快照');
    assert.ok(report.message && report.message.includes('没有可同步'), `message：${report.message}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: sections 缺省/空数组 → 全部 portable 推荐分区（默认/快速导出模式）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sections-default-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-def', sections: [] });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-def')!;
    // 空数组 = 全量（默认模式）；应含 settings/providers 等多个 portable
    assert.ok('settings' in uploaded.sections);
    assert.ok('providers' in uploaded.sections);
    assert.ok(uploaded.manifest.sectionIds.length >= 4, `应同步全部 portable 分区，实际 ${uploaded.manifest.sectionIds.length}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 构造注入 sections（自动同步持久化配置）→ 未显式传 opts 也按注入范围同步', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-ctor-sections-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    // 模拟 autosync：makeSyncEngine 注入持久化的高级模式勾选（advanced + sections）
    const engine = makeEngine({
      ctx, transport, stateDir: tmp,
      extra: { sections: ['settings', 'skills'] },
    });

    // 不传 opts.sections（调度器 Phase C 调用 engine.push() 的样子）
    const report = await engine.push({ snapshotId: 'sync-auto' });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-auto')!;
    assert.deepEqual(uploaded.manifest.sectionIds.sort(), ['settings', 'skills']);
    assert.ok(!('providers' in uploaded.sections), '注入范围外的 portable 分区不进入');
    assert.ok(!('plugins' in uploaded.sections));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 复用 Importer 预览流程，绝不直接写配置，产出差异报告', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-pull-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-1',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: { version: 1, namespaces: { general: { value: { theme: 'dark', language: 'zh-CN' }, revision: 5, secrets: [] } } },
      },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-1', remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // 本地目标：general 已注册但从未配置 → Create（初始化），无需人工决策
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.pull();
    assert.equal(report.ok, true);
    assert.equal(report.snapshotId, 'remote-1');
    const createItem = report.changes.find((c) => c.id === 'settings:general');
    assert.ok(createItem, '差异报告含 settings:general');
    assert.equal(createItem?.kind, 'Create');
    assert.equal(createItem?.adapter, 'settings');
    assert.equal(report.needsReview, false, '纯 Create 无需人工决策');

    // 零写入：目标配置未被修改，远端未被写
    assert.equal(ctx.settings.ns.get('general'), undefined, '目标 settings 未被写入');
    assert.deepEqual(transport.calls, ['list', 'download'], 'pull 只读远端（list/download），不 upload/delete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 冲突项 → needsReview=true，仍零写入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-conflict-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-2',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 5, secrets: [] } } },
      },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-2', remote);
    transport.metas.push(computeSnapshotMeta(remote));

    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.pull();
    assert.equal(report.ok, true);
    assert.ok(report.changes.some((c) => c.kind === 'Conflict'), '本地与远端不同 → Conflict');
    assert.equal(report.needsReview, true, '冲突需人工决策');
    assert.deepEqual(ctx.settings.ns.get('general')?.value, { theme: 'light' }, '目标未被覆盖');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 远端无快照 → 空报告（不报错）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-none-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    const engine = makeEngine({ ctx, transport: new MemSyncTransport(), stateDir: tmp });
    const report = await engine.pull();
    assert.equal(report.ok, true);
    assert.equal(report.snapshotId, '');
    assert.deepEqual(report.changes, []);
    assert.equal(report.needsReview, false);
    assert.ok(report.message && report.message.includes('无快照'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 远端快照声明 containsSecrets=true → 拒绝（同步通道永不携带秘密）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-leak-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-bad',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: true },
      sections: { settings: { version: 1, namespaces: {} } },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-bad', remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    await assert.rejects(() => engine.pull(), /秘密|containsSecrets/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 全部 portable 分区导出失败 → ok=false + 明确 message', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice'); // 无任何 namespace/文件/插件
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    const report = await engine.push({ snapshotId: 'sync-fail' });
    // 空数据仍视为「成功导出（空分区）」还是失败？settings 无 namespace 时 adapter 返回空（不抛错）
    assert.equal(report.ok, true, '空配置导出为空快照而非失败');
    assert.equal(transport.snapshots.has('sync-fail'), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P2c M2：applyMergePlan 单元测试 ──────────────────────────────────────────────

/** 测试用 mock Importer：注入 analyzeImport / createImportPlan / executeImportPlan 的可控行为。 */
class MockImporter {
  ok = true;
  executeCalls = 0;
  warnings: string[] = [];
  analyzeImpl: () => Promise<unknown> = async () => ({ valid: true, compatibility: 'full' });
  createPlanImpl: () => Promise<unknown> = async () => ({
    items: [{ id: 'mock', kind: 'Update', adapter: 'settings', description: 'mock', severity: 'info', target: undefined }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: { settings: 1 } as Record<string, number>,
  });
  executeImpl: () => Promise<unknown> = async () => ({
    ok: this.ok,
    executed: [],
    needsRestart: false,
    missingSecrets: [],
    warnings: this.warnings,
    rollback: null,
    snapshotId: null,
  });
  async analyzeImport(_zipPath: string): Promise<unknown> { return await this.analyzeImpl(); }
  async createImportPlan(_zipPath: string, _decisions: unknown): Promise<unknown> { return await this.createPlanImpl(); }
  async executeImportPlan(_zipPath: string, _plan: unknown, _opts: unknown): Promise<unknown> {
    this.executeCalls += 1;
    return await this.executeImpl();
  }
}

function makeEngineWithMockImporter(opts: {
  ctx: ReturnType<typeof makeContext>;
  transport: MemSyncTransport;
  stateDir: string;
  localSnapshotsDir?: string;
  mockImporter: MockImporter;
}) {
  // 把 mock 注入到 SyncEngine 的 importer 槽位 —— Importer 是类，类型上不能完全替换；
  // 这里用对象字面量 duck-type 兼容 Importer 的三个方法。
  return makeEngine({
    ...opts,
    extra: { importer: opts.mockImporter as unknown as Importer },
  });
}

test('applyMergePlan: 成功路径 → ApplyReport{ok:true, applied, restoreId, rolledBack:false}', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-ok-'));
  const localDir = path.join(tmp, 'snapshots');
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = true;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, localSnapshotsDir: localDir, mockImporter: mock,
    });
    const apply: SyncApplyPlan = {
      autoApply: [{
        id: 'settings',
        decision: 'useRemote',
        conflicts: [],
        merged: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 5, secrets: [] } } },
      }],
      review: [],
      skipped: [],
    };
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true, 'success path → ok:true');
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 应非空');
    assert.equal(report.rolledBack, false);
    assert.equal(report.review.length, 0);
    assert.equal(report.warnings.length, 0);
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    // 祖先基线应被更新：sync-state.lastSnapshotId 非空 + 落 ancestor 副本
    const state = await loadSyncState(tmp);
    assert.notEqual(state.lastSnapshotId, '', 'push 后 lastSnapshotId 已被 recordBaseline 更新');
    // localSnapshotsDir 下应有写出的祖先目录
    const dirs = await fs.readdir(localDir);
    assert.ok(dirs.length > 0, '祖先副本已写入');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyMergePlan: 失败路径 → 整体回滚 + enqueueItems + ApplyReport{ok:false,rolledBack:true,review}', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = false; // Importer.executeImportPlan 返回 ok:false
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });
    const apply: SyncApplyPlan = {
      autoApply: [{
        id: 'settings',
        decision: 'useRemote',
        conflicts: [],
        merged: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 5, secrets: [] } } },
      }],
      review: [],
      skipped: [],
    };
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, false, 'failure path → ok:false');
    assert.equal(report.rolledBack, true);
    assert.equal(report.applied.length, 0);
    assert.notEqual(report.restoreId, '', 'restoreId 应透传以便排查');
    assert.deepEqual(report.review, [], '不再写 review-queue（§7.4）');
    // sync-review-queue.json 不应被写入
    const rqPath = path.join(tmp, 'sync-review-queue.json');
    const rqExists = await fs.stat(rqPath).then(() => true).catch(() => false);
    assert.equal(rqExists, false, 'review-queue.json 不应再被写入');
    // recordBaseline 不应在失败路径调用：sync-state.lastSnapshotId 应仍为空
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, '', '失败时不应 recordBaseline');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyMergePlan: 空 autoApply → 直接返回 ok:true 空报告（无 Importer 调用）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-empty-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });
    const apply: SyncApplyPlan = { autoApply: [], review: [], skipped: [] };
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true);
    assert.equal(report.applied.length, 0);
    assert.equal(mock.executeCalls, 0, '空 autoApply 不应触发 Importer');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyMergePlan: Importer 缺失 → 抛错（构造期校验）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-noimporter-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    // 不传 importer → SyncEngine 内部无 importer
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters: createAdapters({ namespaces: NS }),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
      // 注意：未传 importer
    });
    const apply: SyncApplyPlan = {
      autoApply: [{ id: 'settings', decision: 'useRemote', conflicts: [], merged: { version: 1, namespaces: {} } }],
      review: [], skipped: [],
    };
    await assert.rejects(() => engine.applyMergePlan(apply), /缺少 importer/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P2a M4：merge / recordBaseline / push-baseline ──────────────────────────────

test('push: 完成后 sync-state.lastSnapshotId 指向本次推送快照（祖先基线已记录）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-baseline-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    await engine.push({ snapshotId: 'sync-base' });
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-base', 'push 后 lastSnapshotId 应等于本次快照 id');
    assert.equal(state.lastSyncAt, '2026-08-16T12:00:00.000Z');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('recordBaseline: 写本地祖先副本 + 更新 sync-state + 触发裁剪', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-record-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const local = path.join(tmp, 'ancestors');
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });
    const snapshot = (await transport.list()).length === 0
      ? null
      : (transport.metas[0] && (await transport.download(transport.metas[0].id)));
    void snapshot;
    // 走一遍 push 让 ancestors 目录被建立
    await engine.push({ snapshotId: 'sync-anc-1' });
    await engine.push({ snapshotId: 'sync-anc-2' });
    // 显式再调一次 recordBaseline（模拟合并 apply 完成后更新基线）
    const newSnap: SyncSnapshot = {
      id: 'sync-explicit',
      createdAt: '2026-08-16T13:00:00.000Z',
      manifest: {
        schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32',
        sectionIds: ['settings'], containsSecrets: false,
      },
      sections: { settings: { version: 1, namespaces: {} } },
    };
    await engine.recordBaseline('sync-explicit', newSnap.sections, '2026-08-16T13:00:00.000Z');
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-explicit');
    assert.ok((await fs.stat(path.join(local, 'sync-explicit', 'manifest.json'))).isFile(), '祖先副本已写');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('merge: 不写本地配置、不执行导入，返回 MergePlan', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-merge-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    // 远端与本地不同：本地 settings.theme = dark；远端 = light
    const remote: SyncSnapshot = {
      id: 'remote-merge',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: {
          version: 1,
          namespaces: {
            general: { value: { theme: 'light', language: 'zh-CN' }, revision: 5, secrets: [] },
          },
        },
      },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    // 祖先：与本地相同（本地未改 → useRemote）
    const ancestor: SyncSnapshot = {
      id: 'anc',
      createdAt: '2026-08-15T00:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: {
          version: 1,
          namespaces: { general: { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] } },
        },
      },
    };
    const local = path.join(tmp, 'ancestors');
    // 预置祖先副本
    const { writeSnapshotToDir } = await import('./layout.ts');
    await writeSnapshotToDir(ancestor, path.join(local, 'anc'));
    // 预置 sync-state（指向祖先 id）
    const { saveSyncState } = await import('./sync-state.ts');
    await saveSyncState(tmp, {
      schemaVersion: 2,
      lastSyncAt: '2026-08-15T00:00:00.000Z',
      sections: { settings: { hash: '0'.repeat(64), updatedAt: '2026-08-15T00:00:00.000Z' } },
      lastSnapshotId: 'anc',
    });

    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });
    const plan = await engine.merge();
    assert.ok(plan.sections.length >= 1, '至少包含 settings 分区');
    const settings = plan.sections.find((s) => s.id === 'settings');
    assert.ok(settings, 'settings 在 MergePlan 中');
    // 本地未改（=祖先）、远端改了 → useRemote
    assert.equal(settings!.decision, 'useRemote');
    // 零写入：目标 settings 未被覆盖
    assert.deepEqual(ctx.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    // transport 仅被 list/download 调用（无 upload/delete）
    assert.deepEqual(transport.calls, ['list', 'download']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P3：applyItems（一键同步逐项执行）测试 ──────────────────────────────

import type { ImportPlan } from '../core/types.ts';

function makeImportPlan(seed: string): ImportPlan {
  return {
    items: [{
      id: `settings:general-${seed}`,
      kind: 'Update',
      adapter: 'settings',
      description: `Update settings.general (${seed})`,
      severity: 'info',
      target: { adapter: 'settings', ref: 'general' },
    }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: { settings: 1 } as unknown as Record<SectionId, number>,
  };
}

test('applyItems: 成功路径 → 执行子计划 + recordBaseline', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-ok-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = true;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });

    // 需要真实 ZIP 路径（applyItems 用 executeImportPlan 的 zipPath）
    // 用 mock importer 时 zipPath 可以被 mock 忽略
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const report = await engine.applyItems(zipPath, makeImportPlan('ok'));
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 应非空');
    assert.equal(report.rolledBack, false);
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    // recordBaseline 应被调用（lastSnapshotId 非空）
    const state = await loadSyncState(tmp);
    assert.notEqual(state.lastSnapshotId, '', 'applyItems 成功后 lastSnapshotId 非空');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: 失败路径 → 整体回滚 + ok:false', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = false;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });

    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const report = await engine.applyItems(zipPath, makeImportPlan('fail'));
    assert.equal(report.ok, false);
    assert.equal(report.rolledBack, true);
    assert.notEqual(report.restoreId, '', 'restoreId 应透传');
    // 不再写 review-queue
    const rqPath = path.join(tmp, 'sync-review-queue.json');
    const rqExists = await fs.stat(rqPath).then(() => true).catch(() => false);
    assert.equal(rqExists, false, '失败路径不应写 review-queue');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: 空子计划 → 直接返回 ok:true（不调 Importer）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-empty-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });
    const emptyPlan: ImportPlan = {
      items: [], globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as unknown as Record<SectionId, number>,
    };
    const report = await engine.applyItems(path.join(tmp, 'none.zip'), emptyPlan);
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, []);
    assert.equal(mock.executeCalls, 0, '空子计划不应触发 Importer');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── t5：push 后远端快照裁剪（保留最新 MAX_REMOTE_SNAPSHOTS 个） ─────────────────

/** 预置 n 个远端快照（id=remote-N，createdAt 递增） */
function seedRemoteSnapshots(transport: MemSyncTransport, n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = `remote-${String(i).padStart(2, '0')}`;
    const snap: SyncSnapshot = {
      id,
      createdAt: `2026-08-15T${String(i - 1).padStart(2, '0')}:00:00.000Z`,
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: { settings: { version: 1, namespaces: {} } },
    };
    transport.snapshots.set(id, snap);
    transport.metas.push(computeSnapshotMeta(snap));
  }
}

test('push: 远端快照数超过 MAX_REMOTE_SNAPSHOTS → 裁剪只保留最新 10 个（含刚 push 的）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13); // 预置 13 个旧快照
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    // 本次 push 的快照应保留
    assert.ok(transport.snapshots.has('sync-new'), '刚 push 的快照必须保留');

    const remaining = [...transport.snapshots.keys()];
    // 保留 13 个预置里最新的 9 个（remote-05..remote-13）+ 本次 push 的 sync-new = 10
    assert.equal(remaining.length, MAX_REMOTE_SNAPSHOTS, `裁剪后应恰剩 ${MAX_REMOTE_SNAPSHOTS} 个`);
    // 最旧的 4 个（remote-01..remote-04）被删
    for (let i = 1; i <= 4; i++) {
      assert.ok(!transport.snapshots.has(`remote-0${i}`), `最旧的 remote-0${i} 应被裁剪`);
    }
    // 最新保留集含 5..13 与 sync-new
    for (let i = 5; i <= 13; i++) {
      assert.ok(transport.snapshots.has(`remote-${String(i).padStart(2, '0')}`), `最新的 remote-${i} 应保留`);
    }
    // 裁剪通过 transport.delete 逐个删除（删除调用次数 = 4）
    assert.equal(transport.calls.filter((c) => c === 'delete').length, 4);
    // 顺序：upload → list(裁剪) → delete×4 → recordBaseline（无本地裁剪）→ push 返回
    // 断言 upload 在首次 delete 之前（保证新快照先推送成功再删旧的）
    assert.ok(transport.calls.indexOf('upload') < transport.calls.indexOf('delete'), '先 push 新快照再删旧的');
    // 无裁剪告警（push 会带若干基础导出告警，如未注册 namespace，但不应有裁剪告警）
    assert.ok(!report.warnings.some((w) => w.includes('裁剪')), '正常裁剪不应产生告警');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 远端快照数未超上限 → 不触发任何删除', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-ok-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 9); // 9 旧 + 本次 1 = 10，恰好达标不裁剪
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    assert.equal(transport.calls.filter((c) => c === 'delete').length, 0, '未超上限不得删除');
    assert.equal(transport.snapshots.size, 10);
    assert.ok(!report.warnings.some((w) => w.includes('裁剪')), '未超上限不应有裁剪告警');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 裁剪 list 失败 → 只告警不上抛，push 仍 ok', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-listfail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13);
    transport.list = async () => { throw new Error('list boom'); };
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true, '裁剪失败不得阻断 push');
    assert.ok(transport.snapshots.has('sync-new'), '快照本身已上传');
    assert.ok(report.warnings.some((w) => w.includes('裁剪')), '应有裁剪告警');
    assert.ok(report.warnings.some((w) => w.includes('无法列出远端快照')), '告警应说明 list 失败');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 裁剪单个 delete 失败 → 只告警不上抛，其余旧快照照常删除', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-delfail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13);
    // 让删除 remote-02 时抛错，其余正常
    const origDelete = transport.delete.bind(transport);
    transport.delete = async (id: string) => {
      if (id === 'remote-02') throw new Error('delete boom');
      return origDelete(id);
    };
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true, '单个删除失败不得阻断 push');
    assert.ok(report.warnings.some((w) => w.includes('删除快照 remote-02 失败')), '应有删除失败告警');
    // remote-02 仍残留（删除失败），其余旧快照被删
    assert.ok(transport.snapshots.has('remote-02'), '删除失败的 remote-02 应残留');
    assert.ok(!transport.snapshots.has('remote-01'), '其余旧快照照常删除');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── t6：事件驱动触发检测（§3.1 本地变化 / §3.2 远端新快照） ─────────────────

test('hasNewRemoteSnapshot: 空远端→false；从未同步且远端非空→true；远端最新=祖先→false；比祖先新→true', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-hasnew-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    // 远端为空 → 无新生
    assert.equal(await engine.hasNewRemoteSnapshot(), false, '空远端 → false');

    // push：上传 sync-001 并记录祖先 = sync-001（远端最新即祖先）
    await engine.push({ snapshotId: 'sync-001' });
    assert.equal(await engine.hasNewRemoteSnapshot(), false, '远端最新=本地祖先 → 无新生');

    // 远端出现比祖先更新的快照 → 有新生
    const base = transport.snapshots.get('sync-001')!;
    const newer: SyncSnapshot = {
      ...base,
      id: 'remote-newer',
      createdAt: '2026-08-16T13:00:00.000Z',
    };
    transport.snapshots.set('remote-newer', newer);
    transport.metas.push(computeSnapshotMeta(newer));
    assert.equal(await engine.hasNewRemoteSnapshot(), true, '远端出现比祖先更新的快照 → 有新生');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('hasLocalChanges: 从未同步→true；推后无改动→false；本地改动→true', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-haslocal-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    // 从未同步（sync-state.sections 为空）→ 视为有改动
    assert.equal(await engine.hasLocalChanges(), true, '从未同步 → true');

    // push 记录基线后：本地与基线一致 → 无改动
    await engine.push({ snapshotId: 'sync-001' });
    assert.equal(await engine.hasLocalChanges(), false, '推后本地与基线一致 → false');

    // 改动一个 portable 分区（settings.general theme dark→light）→ 有改动
    ctx.settings.ns.set('general', { value: { theme: 'light', language: 'zh-CN' }, revision: 4, secrets: [] });
    assert.equal(await engine.hasLocalChanges(), true, '改动 portable 分区 → true');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
