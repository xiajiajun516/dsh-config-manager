/**
 * M1 快照增强测试（criterion m1-snapshot-fields）：
 *  - Snapshot 契约含 status(pending|done|rolled-back) / beforePlugins / hostFileBackups；
 *  - createSnapshot 整文件备份 settings.yaml（或 settings.json）与用户/ profile 层 cordis.patch.yml 到 blobs；
 *  - 无新字段的旧快照可兼容加载（FileSnapshotStore.load + updateStatus）；
 *  - executeImportPlan 成功→done / 失败回滚→rolled-back 状态标记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createSnapshot, FileSnapshotStore } from '../../src/core/backup.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../../src/core/types.ts';

const NS = ['general', 'llm-deepseek'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-snapshot-m1-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 构造一个含可执行项的最小计划（settings:general Update → 引擎通用快照兜底） */
function minPlan(): PlanItem[] {
  return [{
    id: 'settings:general',
    kind: 'Update',
    adapter: 'settings',
    description: 'update general',
    severity: 'info',
    target: { adapter: 'settings', ref: 'general' },
  }];
}

/** S-01a createSnapshot：新契约字段 + 宿主整文件备份（settings.yaml 存在 → settings.json 不再登记） */
test('S-01 createSnapshot 生成 status=pending / beforePlugins / hostFileBackups 并落盘 blobs', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\bob', 'web');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.plugins.installed.set('dsh-ssh', { name: 'dsh-ssh', version: '0.1.12', enabled: true });
  await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));
  await ctx.fs.writeFile('cordis.patch.yml', Buffer.from('- id: user-line\n', 'utf8'));
  await ctx.fs.writeFile('profiles/web/cordis.patch.yml', Buffer.from('- id: profile-line\n', 'utf8'));

  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({
    ctx, plan: { items: minPlan(), globalStrategy: 'replace', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} },
    sourceZip: 'C:\\backup\\dsh-config.zip',
    store,
    adapters: [],
  });

  assert.equal(snapshot.status, 'pending', '新快照 status 默认 pending');
  assert.deepEqual(snapshot.beforePlugins, [{ name: 'dsh-ssh', version: '0.1.12', enabled: true }], 'beforePlugins = 导入前插件清单');

  const byRel = new Map((snapshot.hostFileBackups ?? []).map((b) => [b.relPath, b]));
  const settings = byRel.get('settings.yaml');
  assert.ok(settings && settings.existed && settings.blobPath !== '', 'settings.yaml 应登记 existed=true 与 blob 路径');
  const userPatch = byRel.get('cordis.patch.yml');
  assert.ok(userPatch && userPatch.existed && userPatch.blobPath !== '', '用户层 cordis.patch.yml 应整文件备份');
  const profilePatch = byRel.get('profiles/web/cordis.patch.yml');
  assert.ok(profilePatch && profilePatch.existed && profilePatch.blobPath !== '', 'profile 层 cordis.patch.yml 应整文件备份');
  assert.equal(byRel.has('settings.json'), false, 'settings.yaml 存在时 settings.json 不登记');

  // blob 字节真实落盘（store.save 经 blobs Map 写入，readBlob 可还原原内容）
  for (const relPath of ['settings.yaml', 'cordis.patch.yml', 'profiles/web/cordis.patch.yml']) {
    const backup = byRel.get(relPath)!;
    const restored = Buffer.from(await store.readBlob(snapshot.id, backup.blobPath)).toString('utf8');
    assert.equal(restored, Buffer.from(await ctx.fs.readFile(relPath)).toString('utf8'), `${relPath} blob 内容应等于原文件`);
  }
});

/** S-01b settings.json 兜底：settings.yaml 缺失时探测并备份 settings.json */
test('S-01b settings.yaml 缺失 → 探测并整文件备份 settings.json（existed 如实登记）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\carol');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  await ctx.fs.writeFile('settings.json', Buffer.from('{"general":{"theme":"dark"}}', 'utf8'));

  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({
    ctx, plan: { items: minPlan(), globalStrategy: 'replace', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} },
    sourceZip: 'x.zip', store, adapters: [],
  });

  const byRel = new Map((snapshot.hostFileBackups ?? []).map((b) => [b.relPath, b]));
  assert.ok(byRel.get('settings.yaml') && byRel.get('settings.yaml')!.existed === false, 'settings.yaml 缺失应登记 existed=false');
  const json = byRel.get('settings.json');
  assert.ok(json && json.existed && json.blobPath !== '', 'settings.json 应整文件备份');
  assert.equal(byRel.has('profiles/'), false, '未提供 profile 时不登记 profile 层');
});

/** S-01c 无 profile 的宿主：只登记 settings + 用户层 patch，不出现 profiles/ 条目 */
test('S-01c ctx.profile 缺省 → hostFileBackups 不含 profiles/ 路径', async () => {
  const ctx = makeContext('linux', '/home/dan');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));

  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({
    ctx, plan: { items: minPlan(), globalStrategy: 'replace', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} },
    sourceZip: 'x.zip', store, adapters: [],
  });
  assert.ok(!(snapshot.hostFileBackups ?? []).some((b) => b.relPath.startsWith('profiles/')), '无 profile 时不应登记 profile patch');
});

/** S-02 旧快照兼容：无新字段的 snapshot.json 可加载，updateStatus 正常并保留其余字段 */
test('S-02 FileSnapshotStore 旧快照兼容加载 + updateStatus', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir });
    const id = 'legacy-snapshot-1';
    await fs.mkdir(path.join(dir, id), { recursive: true });
    const legacy = {
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceZip: 'legacy.zip',
      entries: [{ kind: 'settingsNamespace', adapter: 'settings', ref: 'general', before: { a: 1 }, revision: 3, existed: true }],
    };
    await fs.writeFile(path.join(dir, id, 'snapshot.json'), JSON.stringify(legacy, null, 2));

    const loaded = await store.load(id);
    assert.equal(loaded.status, undefined, '旧快照无 status 字段 → 兼容为 undefined');
    assert.equal(loaded.beforePlugins, undefined, '旧快照无 beforePlugins → 兼容为 undefined');
    assert.equal(loaded.hostFileBackups, undefined, '旧快照无 hostFileBackups → 兼容为 undefined');
    assert.equal(loaded.entries.length, 1, '旧快照 entries 完整保留');

    await store.updateStatus(id, 'done');
    const after = await store.load(id);
    assert.equal(after.status, 'done', 'updateStatus 标记后重读可见');
    assert.equal(after.entries.length, 1, 'updateStatus 不丢其余字段');
    assert.equal(after.sourceZip, 'legacy.zip', 'updateStatus 保留 sourceZip');
  });
});

/* -------------------- e2e：executeImportPlan 状态标记 -------------------- */

async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
    revision: 5,
    secrets: [{ path: ['apiKeyEnv'], set: true }],
  });
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
  ctx.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [] });
  ctx.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
  });
}

async function seedTarget(dst: MockHostContext): Promise<void> {
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
  dst.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://old.example.com', model: 'old-model' },
    revision: 2,
    secrets: [{ path: ['apiKeyEnv'], set: true }],
  });
  await dst.fs.writeFile('skills/coding.md', Buffer.from('# OLD skill content\n', 'utf8'));
  dst.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\bob\\projects\\old', title: 'OldTitle', sessionIds: [] });
  dst.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'node', args: ['old.js'] } },
  });
  // 宿主整文件（M1 备份目标）
  await dst.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: light\n', 'utf8'));
  await dst.fs.writeFile('cordis.patch.yml', Buffer.from('- id: dst-user-line\n', 'utf8'));
  await dst.fs.writeFile('profiles/web/cordis.patch.yml', Buffer.from('- id: dst-profile-line\n', 'utf8'));
  dst.plugins.installed.set('dsh-ssh', { name: 'dsh-ssh', version: '0.1.12', enabled: true });
}

async function exportFixture(src: MockHostContext, outPath: string): Promise<void> {
  const adapters = createAdapters({ namespaces: NS });
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath });
}

/** S-03 导入成功：快照标记 done，且快照携带 beforePlugins/hostFileBackups */
test('S-03 executeImportPlan 成功 → 快照 status=done（含 M1 字段）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 's03.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob', 'web');
    await seedTarget(dst);

    const store = new MemSnapshotStore();
    const importer = new Importer({ ctx: dst, adapters: createAdapters({ namespaces: NS }), snapshotStore: store });
    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] }],
    });

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: false });
    assert.equal(result.ok, true);
    assert.ok(result.snapshotId, '成功导入应返回 snapshotId');

    const snapshot = await store.load(result.snapshotId!);
    assert.equal(snapshot.status, 'done', '导入成功 → 快照标记 done');
    assert.deepEqual(snapshot.beforePlugins, [{ name: 'dsh-ssh', version: '0.1.12', enabled: true }], 'beforePlugins 已登记');
    const byRel = new Map((snapshot.hostFileBackups ?? []).map((b) => [b.relPath, b]));
    for (const rel of ['settings.yaml', 'cordis.patch.yml', 'profiles/web/cordis.patch.yml']) {
      const backup = byRel.get(rel);
      assert.ok(backup && backup.existed && backup.blobPath !== '', `${rel} 应整文件备份`);
    }
  });
});

/** 失败注入包装：命中指定 itemId 时 applyItem 抛错 */
class FlakyAdapter implements ConfigAdapter {
  private readonly inner: ConfigAdapter;
  private failItemId: string;
  constructor(inner: ConfigAdapter, failItemId: string) {
    this.inner = inner;
    this.failItemId = failItemId;
  }
  get id() { return this.inner.id; }
  get displayName() { return this.inner.displayName; }
  get defaultIncluded() { return this.inner.defaultIncluded; }
  get portability() { return this.inner.portability; }
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection> { return this.inner.export(ctx, options); }
  analyzeImport(data: unknown, ctx: ImportContext): Promise<PlanItem[]> { return this.inner.analyzeImport(data, ctx); }
  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (item.id === this.failItemId) throw new Error(`模拟写入失败: ${item.id}`);
    return this.inner.applyItem(item, ctx);
  }
  validate(data: unknown): Promise<ValidationResult> { return this.inner.validate(data); }
}

/** S-04 失败整体回滚：快照标记 rolled-back */
test('S-04 executeImportPlan 失败回滚 → 快照 status=rolled-back', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 's04.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob', 'web');
    await seedTarget(dst);

    const adapters = createAdapters({ namespaces: NS });
    const flaky = adapters.map((a) => (a.id === 'workspaces' ? new FlakyAdapter(a, 'workspace:ws-ops') : a));
    const store = new MemSnapshotStore();
    const importer = new Importer({ ctx: dst, adapters: flaky, snapshotStore: store });
    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] }],
    });

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: true });
    assert.equal(result.ok, false);
    assert.ok(result.rollback, '失败应触发回滚');
    assert.equal(result.rollback.full, true);

    const snapshot = await store.load(result.snapshotId!);
    assert.equal(snapshot.status, 'rolled-back', '失败回滚 → 快照标记 rolled-back');
  });
});
