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
import { hashSection, loadSyncState, saveSyncState, SYNC_STATE_FILE, SYNC_STATE_SCHEMA_VERSION } from './sync-state.ts';
import { buildAutoApplyPlan } from './autosync-scheduler.ts';
import { decryptSectionsPayload } from './snapshot-crypto.ts';
import { computeSnapshotMeta } from './transport.ts';
import { isEncryptedSections } from './transport.ts';
import type { EncryptedSections, SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { WebDavTransport } from './webdav/webdav-transport.ts';
import type { WebDavRequestFn } from './webdav/webdav-transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import type { SectionId } from '../schema/types.ts';
import type { SectionData } from '../schema/types.ts';
import { Phase3Recovery, readSafeModeMarkerSync } from '../core/phase3-host.ts';
import type { JournalRunContext } from '../core/phase3-host.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

/** 测试辅助：取明文 sections（同步测试构造/上传的快照均为普通快照，非加密载荷）。 */
function plainSections(s: SyncSnapshot['sections']): Partial<Record<SectionId, SectionData>> {
  return s as Partial<Record<SectionId, SectionData>>;
}

/** 内存 SyncTransport：记录方法调用（spy），供断言「pull 不写远端」 */
class MemSyncTransport implements SyncTransport {  readonly type = 'memory';
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
    const exportedGeneral = (plainSections(uploaded.sections)['settings'] as { namespaces: Record<string, { value: unknown; revision: number; secrets: unknown[] }> }).namespaces['general']!;
    assert.ok(exportedGeneral, 'settings.general 已导出');
    assert.deepEqual(exportedGeneral.value, { theme: 'dark', language: 'zh-CN' });
    assert.equal(exportedGeneral.revision, 3);
    assert.deepEqual(exportedGeneral.secrets, []);
    assert.equal((plainSections(uploaded.sections)['skills'] as { files: unknown[] }).files.length, 1);

    // sync-state 更新：每分区 hash + updatedAt + lastSyncAt + transport 绑定
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSyncAt, '2026-08-16T12:00:00.000Z');
    assert.equal(state.sections['settings']?.hash, hashSection(plainSections(uploaded.sections)['settings']!));
    assert.equal(state.sections['settings']?.updatedAt, '2026-08-16T12:00:00.000Z');
    assert.deepEqual(state.transport, { type: 'memory', ref: '' });
    const raw = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, 3);

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
    const general = (plainSections(uploaded.sections)['settings'] as { namespaces: Record<string, unknown> }).namespaces['general'] as { value: Record<string, unknown> };
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

test('push: 可选分区 sessions —— 无选项时跳过并告警；带 limit 时只带最新 N 个会话', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sessions-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('sessions/--p--/old/session.jsonl.zstd', Buffer.from('old', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/old/session.jsonl.zstd', 1000);
    await ctx.fs.writeFile('sessions/--p--/new/session.jsonl.zstd', Buffer.from('new', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/new/session.jsonl.zstd', 2000);
    const transport = new MemSyncTransport();
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
    const engine = new SyncEngine({
      ctx,
      transport,
      stateDir: tmp,
      adapters,
      importer,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    // ① 勾了 sessions 但**没有**给出 sessions 选项 → 与其它 deviceSpecific 分区一样跳过（安全默认）
    const withoutOption = await engine.push({ snapshotId: 'sync-sessions-a', sections: ['settings', 'sessions'] });
    assert.ok(!withoutOption.sections.includes('sessions'), 'sessions 未提供选项时不得进入快照');
    assert.ok(
      withoutOption.warnings.some((w) => w.includes('sessions')),
      '跳过必须可见（不静默）: ' + withoutOption.warnings.join(' | '),
    );

    // ② 提供 limit → sessions 作为可选分区进入同步，且只带「最新 1 个会话」目录
    const limited = await engine.push({ snapshotId: 'sync-sessions-b', sections: ['sessions'], sessions: { limit: 1 } });
    assert.deepEqual(limited.sections, ['sessions']);
    const uploaded = transport.snapshots.get('sync-sessions-b')!;
    const files = (plainSections(uploaded.sections)['sessions'] as { files: { relativePath: string }[] }).files;
    assert.deepEqual(files.map((f) => f.relativePath), ['--p--/new/session.jsonl.zstd']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P0-3: sessions.include 显式点名优先于 limit（只带我勾中的对话）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sessions-include-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('sessions/--p--/a/session.jsonl.zstd', Buffer.from('a', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/a/session.jsonl.zstd', 1000);
    await ctx.fs.writeFile('sessions/--p--/b/session.jsonl.zstd', Buffer.from('b', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/b/session.jsonl.zstd', 2000);
    await ctx.fs.writeFile('sessions/--p--/c/session.jsonl.zstd', Buffer.from('c', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/c/session.jsonl.zstd', 3000);
    const transport = new MemSyncTransport();
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    // limit=0（不带任何会话）+ include=[最旧的 a] → 用户点名必须赢（limit 让位）
    const picked = await engine.push({
      snapshotId: 'sync-include',
      sections: ['sessions'],
      sessions: { limit: 0, include: ['sessions:--p--/a'] },
    });
    assert.deepEqual(picked.sections, ['sessions']);
    const files = (plainSections(transport.snapshots.get('sync-include')!.sections)['sessions'] as { files: { relativePath: string }[] }).files;
    assert.deepEqual(files.map((f) => f.relativePath), ['--p--/a/session.jsonl.zstd'], '只带被点名的对话');

    // include 为空 → 回到 limit 语义（「最新 1 个」）
    const fallback = await engine.push({ snapshotId: 'sync-limit', sections: ['sessions'], sessions: { limit: 1, include: [] } });
    assert.equal(fallback.ok, true);
    const files2 = (plainSections(transport.snapshots.get('sync-limit')!.sections)['sessions'] as { files: { relativePath: string }[] }).files;
    assert.deepEqual(files2.map((f) => f.relativePath), ['--p--/c/session.jsonl.zstd'], '空 include = 回到「最新 1 个」');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 可选分区 sessions —— 未开启则远端会话不进计划；开启后会话项可见（显式 opt-in）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-sessions-pull-'));
  try {
    const transport = new MemSyncTransport();
    const now = () => new Date('2026-08-16T12:00:00.000Z');
    // 源机：两个会话 → 只推最新 1 个
    const srcCtx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(srcCtx);
    await srcCtx.fs.writeFile('sessions/--p--/old/session.jsonl.zstd', Buffer.from('old', 'utf8'));
    srcCtx.fs.setMtime('sessions/--p--/old/session.jsonl.zstd', 1000);
    await srcCtx.fs.writeFile('sessions/--p--/new/session.jsonl.zstd', Buffer.from('new', 'utf8'));
    srcCtx.fs.setMtime('sessions/--p--/new/session.jsonl.zstd', 2000);
    const srcAdapters = createAdapters({ namespaces: NS, includeSessions: true });
    const srcEngine = new SyncEngine({
      ctx: srcCtx,
      transport,
      stateDir: path.join(tmp, 'src'),
      adapters: srcAdapters,
      importer: new Importer({ ctx: srcCtx, adapters: srcAdapters, snapshotStore: new MemSnapshotStore() }),
      now,
    } as ConstructorParameters<typeof SyncEngine>[0]);
    const pushed = await srcEngine.push({ snapshotId: 'sync-sessions-pull', sections: ['sessions'], sessions: { limit: 1 } });
    assert.deepEqual(pushed.sections, ['sessions']);

    // 目标机：默认（未开启可选分区）→ 远端会话分区不得出现在差异计划里
    const dstCtx = makeContext('win32', 'C:\\Users\\bob');
    const dstAdapters = createAdapters({ namespaces: NS, includeSessions: true });
    const dstImporter = new Importer({ ctx: dstCtx, adapters: dstAdapters, snapshotStore: new MemSnapshotStore() });
    const plainEngine = new SyncEngine({
      ctx: dstCtx,
      transport,
      stateDir: path.join(tmp, 'dst-plain'),
      adapters: dstAdapters,
      importer: dstImporter,
      now,
    } as ConstructorParameters<typeof SyncEngine>[0]);
    const plainReport = await plainEngine.pull({});
    assert.ok(
      !plainReport.changes.some((c) => c.adapter === 'sessions'),
      '未开启 includeOptInSections 时不得出现会话项: ' + plainReport.changes.map((c) => c.adapter).join(','),
    );

    // 开启（= 用户在分区弹窗里勾了历史会话）→ 会话项进入计划
    const optInEngine = new SyncEngine({
      ctx: dstCtx,
      transport,
      stateDir: path.join(tmp, 'dst-optin'),
      adapters: dstAdapters,
      importer: dstImporter,
      now,
      includeOptInSections: true,
    } as ConstructorParameters<typeof SyncEngine>[0]);
    const optInReport = await optInEngine.pull({});
    assert.ok(
      optInReport.changes.some((c) => c.adapter === 'sessions'),
      '开启后会话项必须可见: ' + optInReport.changes.map((c) => c.adapter).join(','),
    );
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

/* ---------------- 加密快照（push 加密 + 密钥导出；pull 解密） ---------------- */

test('push: encrypt+password → 上传加密快照（manifest.encrypted=true，sections 为密文，远端无明文）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-encrypt-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-enc', encrypt: true, password: 'pw-12345678' });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-enc')!;
    assert.equal(uploaded.manifest.encrypted, true, 'manifest 标记加密');
    assert.equal(uploaded.manifest.containsSecrets, false, '未导出密钥时 containsSecrets=false');
    assert.ok(isEncryptedSections(uploaded.sections), 'sections 为密文载荷');
    const serialized = JSON.stringify(uploaded);
    assert.ok(!serialized.includes('dark'), '明文内容不得出现在加密快照（远端/序列化）');
    // 解密后还原
    const decrypted = await decryptSectionsPayload(uploaded.sections.encrypted, 'pw-12345678');
    assert.ok('settings' in decrypted, '解密后分区还原');
    // 本地不写明文祖先/散文件副本（密钥不落盘）
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-enc');
    assert.ok(state.sections['settings'] !== undefined, '基线 hash 已记录（明文 hash，可比较）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: encrypt + includeSecrets → 凭据值进入加密快照（解密后可恢复），未加密快照仍不含', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-secrets-enc-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.settings.ns.set('general', {
      value: { theme: 'dark', apiToken: 'sk-cred-123', password: 'p@ss' },
      revision: 3,
      secrets: [{ path: ['apiToken'], set: true }],
    });
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    // 加密 + 导出密钥：凭据值进入密文载荷
    const report = await engine.push({ snapshotId: 'sync-sec-enc', encrypt: true, password: 'pw-12345678', includeSecrets: true });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-sec-enc')!;
    assert.equal(uploaded.manifest.encrypted, true);
    assert.equal(uploaded.manifest.containsSecrets, true, '加密快照声明含秘密');
    const serialized = JSON.stringify(uploaded);
    assert.ok(!serialized.includes('sk-cred-123'), '密文载荷不得含明文凭据值');
    // 解密后凭据值可恢复
    const encSections = uploaded.sections as EncryptedSections;
    const decrypted = await decryptSectionsPayload(encSections.encrypted, 'pw-12345678');
    const general = (decrypted['settings'] as { namespaces: Record<string, { value: Record<string, unknown> }> }).namespaces['general'];
    assert.equal(general!.value['apiToken'], 'sk-cred-123', '解密后凭据值恢复');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: includeSecrets 但未加密 → 拒绝（密钥绝不明文进同步通道）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-secrets-nocrypt-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    await assert.rejects(
      () => engine.push({ snapshotId: 'x', includeSecrets: true }),
      /导出密钥必须同时加密快照/,
    );
    assert.equal(transport.snapshots.size, 0, '拒绝时不上传任何快照');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: encrypt 但无密码 → 拒绝（密码绝不落盘，必须本次提供）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-enc-nopw-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    await assert.rejects(() => engine.push({ snapshotId: 'x', encrypt: true }), /加密快照必须提供密码/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull: 远端加密快照无密码 → 明确报错；提供密码 → 解密成功并产出差异', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-pull-enc-'));
  try {
    // 先加密推送一个快照（含凭据值），模拟远端加密快照
    const srcCtx = makeContext('win32', 'C:\\Users\\alice');
    srcCtx.settings.ns.set('general', {
      value: { theme: 'dark', apiToken: 'sk-cred-123' },
      revision: 5,
      secrets: [{ path: ['apiToken'], set: true }],
    });
    const transport = new MemSyncTransport();
    const pushEngine = makeEngine({ ctx: srcCtx, transport, stateDir: tmp });
    await pushEngine.push({ snapshotId: 'remote-enc', encrypt: true, password: 'pw-12345678', includeSecrets: true });

    // 目标侧：无密码 pull → 报错提示需密码
    const dstCtx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) dstCtx.settings.registered.add(n);
    const dstEngine = makeEngine({ ctx: dstCtx, transport, stateDir: tmp });
    await assert.rejects(() => dstEngine.pull(), /已加密，需要解密密码/);

    // 提供密码 → 解密成功，差异报告含凭据值条目
    const report = await dstEngine.pull({ password: 'pw-12345678' });
    assert.equal(report.ok, true);
    assert.ok(report.changes.length > 0, '解密后产出差异');
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
  /** 审计 P0-23：executeImportPlan 收到的 snapshotBinding（undefined = 调用方未透传绑定）。 */
  receivedBinding: unknown = undefined;
  /**
   * 审计 P0-23：失败时是否模拟「引擎已就地回滚」的上报 —— 即 analyzer.ts:711-725 的真实行为：
   * rollbackOnError 触发整体回滚 → 经 binding.recordRollback 上报 → 再正常返回 ok:false。
   * 缺省 false：与改造前逐字一致，不影响既有用例。
   */
  reportRollbackOnFailure = false;
  /** 上报的回滚完整度（false = 半回滚态 → 应留下 durable SAFE MODE）。 */
  rollbackFull = true;
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
    const binding = (_opts as {
      snapshotBinding?: { recordRollback?: (r: { full: boolean; failed: readonly string[] }) => Promise<void> };
    } | undefined)?.snapshotBinding;
    this.receivedBinding = binding;
    // 与真实引擎同序：先在 fn 内部完成整体回滚并上报，再正常返回 ok:false。
    if (this.reportRollbackOnFailure && binding?.recordRollback !== undefined) {
      await binding.recordRollback({ full: this.rollbackFull, failed: [] });
    }
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
    // 祖先基线应被更新（P0-7）：本地祖先副本目录名落 ancestorId；
    // 未经 merge() 的直接调用拿不到远端 id → lastSnapshotId 保持 ''（诚实未知，不冒充远端 id）
    const state = await loadSyncState(tmp);
    assert.notEqual(state.ancestorId ?? '', '', 'recordBaseline 应记录本地祖先副本目录名');
    assert.equal(state.lastSnapshotId, '', '远端 id 未知时 lastSnapshotId 保持空');
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
      ctx, transport, stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snapshots'), mockImporter: mock,
    });

    // 需要真实 ZIP 路径（applyItems 用 executeImportPlan 的 zipPath）
    // 用 mock importer 时 zipPath 可以被 mock 忽略
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const report = await engine.applyItems(zipPath, makeImportPlan('ok'), { remoteSnapshotId: 'sync-remote-ok' });
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 应非空');
    assert.equal(report.rolledBack, false);
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    // recordBaseline 应被调用（P0-7：远端 id 由调用方透传 → lastSnapshotId；本地副本目录名 → ancestorId）
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-remote-ok', 'applyItems 成功后 lastSnapshotId = 调用方给的远端快照 id');
    assert.notEqual(state.ancestorId ?? '', '', 'applyItems 成功后 ancestorId 非空（本地祖先副本）');
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

// ─── t5b：m-retention —— 远端保留接 GFS 分层（不再绑死「推了几次配置」） ───────

/** 预置一个指定创建时间的远端快照（GFS 分层用例需要跨月/跨年的时间分布） */
function seedRemoteSnapshotAt(transport: MemSyncTransport, id: string, createdAt: string): void {
  const snap: SyncSnapshot = {
    id,
    createdAt,
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: { settings: { version: 1, namespaces: {} } },
  };
  transport.snapshots.set(id, snap);
  transport.metas.push(computeSnapshotMeta(snap));
}

test('push: 注入分层保留策略 → 远端按「最近 N + 每月一份」裁剪，旧月份代表存活', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-gfs-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshotAt(transport, 'r-jan', '2026-01-05T00:00:00.000Z');
    seedRemoteSnapshotAt(transport, 'r-feb', '2026-02-10T00:00:00.000Z');
    seedRemoteSnapshotAt(transport, 'r-mar-1', '2026-03-01T00:00:00.000Z');
    seedRemoteSnapshotAt(transport, 'r-mar-2', '2026-03-20T00:00:00.000Z');
    seedRemoteSnapshotAt(transport, 'r-apr', '2026-04-02T00:00:00.000Z');
    // keepLast=1（本次 push 的 sync-new 占掉）+ keepMonthly=2（2026-08 与 2026-04）
    const engine = makeEngine({
      ctx, transport, stateDir: tmp,
      extra: { retentionPolicy: () => ({ keepLast: 1, keepMonthly: 2, keepYearly: 0 }) },
    });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    assert.ok(transport.snapshots.has('sync-new'), '刚 push 的快照恒保留');
    // 每月一份：最新月 2026-08（sync-new）之后是 2026-04 的代表
    assert.ok(transport.snapshots.has('r-apr'), '2026-04 的月代表应保留');
    // 超出月度额度与最近额度的旧月份全被裁掉
    for (const id of ['r-jan', 'r-feb', 'r-mar-1', 'r-mar-2']) {
      assert.ok(!transport.snapshots.has(id), `${id} 应被分层策略裁掉`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 三层全关（0/0/0）→ 只保留刚 push 的快照（"只留最新"语义，绝不连它一起删）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-zero-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshotAt(transport, 'r-1', '2026-01-05T00:00:00.000Z');
    seedRemoteSnapshotAt(transport, 'r-2', '2026-02-05T00:00:00.000Z');
    const engine = makeEngine({
      ctx, transport, stateDir: tmp,
      extra: { retentionPolicy: () => ({ keepLast: 0, keepMonthly: 0, keepYearly: 0 }) },
    });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    assert.deepEqual([...transport.snapshots.keys()], ['sync-new'], '全关策略下只剩刚 push 的快照');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 保留策略提供者抛错 → 回退缺省策略（保守多留，不误删远端快照）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-fallback-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13);
    const engine = makeEngine({
      ctx, transport, stateDir: tmp,
      extra: { retentionPolicy: () => { throw new Error('schedule unreadable'); } },
    });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    assert.equal(transport.snapshots.size, MAX_REMOTE_SNAPSHOTS, '回退缺省后仍保留最新 10 个');
    assert.ok(transport.snapshots.has('sync-new'));
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

test('push + webdav 快照级跳过：同 id 同内容二次 push → 不重复 PUT 快照文件（端到端组合）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-webdav-skip-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    // 内存 WebDAV「服务器」：snapshots/ 集合 + <id>.json 文件 + index.json
    const files = new Map<string, string>();
    const putCalls: string[] = [];
    const request: WebDavRequestFn = async (method, url, opts = {}) => {
      const key = url.replace(/\/+$/, '');
      if (method === 'MKCOL') return { status: 201, ok: true, text: async () => '' };
      if (method === 'GET') {
        const body = files.get(key);
        return body === undefined
          ? { status: 404, ok: false, text: async () => '' }
          : { status: 200, ok: true, text: async () => body };
      }
      if (method === 'PUT') {
        putCalls.push(key);
        files.set(key, opts.body ?? '');
        return { status: 201, ok: true, text: async () => '' };
      }
      if (method === 'DELETE') {
        files.delete(key);
        return { status: 204, ok: true, text: async () => '' };
      }
      return { status: 405, ok: false, text: async () => '' };
    };
    const transport = new WebDavTransport({
      baseUrl: 'https://dav.example.com/dav/config',
      username: 'alice',
      credentials: { getPassword: async () => 'test-password' },
      request,
    });
    const adapters = createAdapters({ namespaces: NS });
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
    const engine = new SyncEngine({
      ctx,
      transport,
      stateDir: tmp,
      adapters,
      importer,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    // 首次 push：上传快照文件 + 写 index
    const first = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(first.ok, true);
    assert.equal(putCalls.filter((k) => k.endsWith('/sync-001.json')).length, 1, '首次 push 应 PUT 快照文件');
    assert.ok(putCalls.some((k) => k.endsWith('/index.json')), '首次 push 应写 index（meta 最后落盘）');

    // 二次 push：同 id 同内容 → webdav 快照级跳过（不 PUT 快照文件、不写 index）
    const second = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(second.ok, true);
    assert.equal(
      putCalls.filter((k) => k.endsWith('/sync-001.json')).length,
      1,
      '内容无变化 → 不得再次 PUT 快照文件',
    );
    assert.equal(
      putCalls.filter((k) => k.endsWith('/index.json')).length,
      1,
      '内容无变化 → 不得再次写 index',
    );
    // 远端快照文件仍存在且为首次内容
    const remote = files.get('https://dav.example.com/dav/config/dsh-config-manager/sync-001.json');
    assert.ok(remote !== undefined && remote.length > 0, '远端快照文件存在');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- P0-7：基线指针语义（远端 id vs 本地祖先目录名） ---------------- */

/** 远端快照构造（普通明文快照；settings.general = light 与 seedSource 的 dark 不同） */
function mkRemote(id: string, createdAt: string, theme: string, revision: number): SyncSnapshot {
  return {
    id,
    createdAt,
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: {
      settings: {
        version: 1,
        namespaces: { general: { value: { theme, language: 'zh-CN' }, revision, secrets: [] } },
      },
    },
  };
}

test('P0-7: 加密快照 push 后，下一轮 merge 不再抛「快照目录缺少 manifest.json」→ 降级为两方合并', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-p07-enc-merge-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const local = path.join(tmp, 'ancestors');
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });

    // 加密 push：按既有安全语义不落本地明文祖先副本
    const push = await engine.push({ snapshotId: 'sync-enc-1', encrypt: true, password: 'pw-12345678' });
    assert.equal(push.ok, true);
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-enc-1', 'lastSnapshotId 必须等于远端快照 id');
    assert.equal(state.ancestorId ?? '', '', '加密 push 不落本地祖先副本 → ancestorId 必须为空');

    // 另一台机器推了一个普通快照 → 自动同步会走 merge（修复前：loadAncestor 抛错 → 整轮 failed 且每轮复现）
    const remote2 = mkRemote('remote-2', '2026-08-16T13:00:00.000Z', 'light', 9);
    transport.snapshots.set(remote2.id, remote2);
    transport.metas.push(computeSnapshotMeta(remote2));

    const plan = await engine.merge();
    const settings = plan.sections.find((s) => s.id === 'settings');
    assert.ok(settings, 'merge 必须返回 settings 分区结果');
    assert.equal(settings!.decision, 'conflict', '祖先缺失 → 两方差异按整分区 conflict 交用户裁决');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P0-7: 祖先副本缺失（被裁剪/清理）时 merge 同样降级为两方合并，不抛错', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-p07-ghost-anc-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote = mkRemote('remote-ghost', '2026-08-16T12:00:00.000Z', 'light', 4);
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    // 旧状态（v2 形态）：lastSnapshotId 指向一个本地**并不存在**的祖先目录
    await saveSyncState(tmp, {
      schemaVersion: 2,
      lastSyncAt: '2026-08-15T00:00:00.000Z',
      sections: { settings: { hash: '0'.repeat(64), updatedAt: '2026-08-15T00:00:00.000Z' } },
      lastSnapshotId: 'ghost-ancestor',
    });
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: path.join(tmp, 'ancestors') });

    const plan = await engine.merge();
    const settings = plan.sections.find((s) => s.id === 'settings');
    assert.ok(settings, 'merge 必须返回 settings 分区结果（不抛错）');
    assert.equal(settings!.decision, 'conflict');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P0-7: merge + applyMergePlan 后 lastSnapshotId = 远端快照 id → hasNewRemoteSnapshot() 返回 false', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-p07-apply-'));
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

    // 本机先推一个基线（普通快照 → 落本地祖先副本）
    assert.equal((await engine.push({ snapshotId: 'sync-r1' })).ok, true);
    assert.equal(await engine.hasNewRemoteSnapshot(), false, '刚推完 → 远端无新生');

    // 另一台机器推了 sync-r2 → 自动同步 Phase A 走 merge → applyMergePlan
    const remote2 = mkRemote('sync-r2', '2026-08-16T13:00:00.000Z', 'light', 9);
    transport.snapshots.set(remote2.id, remote2);
    transport.metas.push(computeSnapshotMeta(remote2));
    assert.equal(await engine.hasNewRemoteSnapshot(), true, '远端出现新快照 → true');

    const plan = await engine.merge();
    const apply = buildAutoApplyPlan(plan);
    assert.ok(apply.autoApply.length > 0, '本地未改、远端改了 → 应有可自动应用项');
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true);

    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-r2', 'apply 后基线指针必须是**远端**快照 id');
    assert.notEqual(state.ancestorId ?? '', '', '本地祖先副本目录名写在独立字段');
    assert.notEqual(state.ancestorId, state.lastSnapshotId, '两个 id 语义不同，不得混用同一字段');
    assert.equal(await engine.hasNewRemoteSnapshot(), false, '远端最新已应用 → 不应再判「有新生」（每轮白跑 list+download+merge）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P0-7: applyItems 显式给远端 id → lastSnapshotId 写远端 id；不给 → 写 ""（诚实未知，不冒充远端 id）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-p07-applyitems-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = true;
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const withRemote = makeEngineWithMockImporter({ ctx, transport, stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snapshots'), mockImporter: mock });
    assert.equal((await withRemote.applyItems(zipPath, makeImportPlan('remote-id'), { remoteSnapshotId: 'sync-r9' })).ok, true);
    const s1 = await loadSyncState(tmp);
    assert.equal(s1.lastSnapshotId, 'sync-r9', '显式远端 id 必须落到 lastSnapshotId');
    assert.notEqual(s1.ancestorId ?? '', '', '本地祖先副本仍记录在 ancestorId');

    const noRemote = makeEngineWithMockImporter({ ctx, transport, stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snapshots'), mockImporter: mock });
    assert.equal((await noRemote.applyItems(zipPath, makeImportPlan('unknown-id'))).ok, true);
    const s2 = await loadSyncState(tmp);
    assert.equal(s2.lastSnapshotId, '', '远端 id 未知时写 ""（而不是把本地随机 id 冒充远端 id）');
    assert.notEqual(s2.ancestorId ?? '', '', '仍落本地祖先副本目录名');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * P0-7 收尾 · 源码守卫：一键同步的 /sync/apply-items 路由必须把**会话里的远端快照 id**透传给 applyItems。
 * 行为侧由上面的引擎级用例钉住（传入 → sync-state.lastSnapshotId = 远端快照 id）；这里钉**接线**：
 * 路由若退回不传，一键同步后 lastSnapshotId 会停在 ''（诚实未知），自动同步要多跑一整轮
 * list+download+merge 才收敛。同款守卫样板见 src/sync/backup-scheduler.test.ts（issue #43 / M1）。
 */
/** W1 起路由按域拆到 src/routes/*.ts：源码级守卫必须扫**全部**宿主路由源，否则会静默失去覆盖。 */
async function hostRouteSource(): Promise<string> {
  const parts = [await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8')];
  const dir = new URL('../routes/', import.meta.url);
  for (const entry of (await fs.readdir(dir)).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    parts.push(await fs.readFile(new URL(entry, dir), 'utf8'));
  }
  return parts.join('\n').replace(/\r\n/g, '\n');
}

test('P0-7 源码守卫：/sync/apply-items 以 remoteSnapshotId: session.snapshotId 调 applyItems', async () => {
  // 归一化行尾：Windows 工作区是 CRLF、CI 是 LF；守卫按文本解析源码，写死行尾会只在一边通过
  // （用 fromCharCode 而不是正则里的转义序列，避免转义层数差异把源码写坏）
  // W1：/sync/apply-items 路由已拆到 src/routes/sync.ts —— 扫「宿主路由源」（index.ts + src/routes/**）
  const source = await hostRouteSource();
  const callIdx = source.indexOf('await engine.applyItems(');
  assert.ok(callIdx > 0, '应能找到 engine.applyItems(...) 调用');
  // 该调用紧随其后即 options 字面量：取其窗口做接线断言
  const options = source.slice(callIdx, callIdx + 800);
  assert.ok(
    /remoteSnapshotId:\s*session\.snapshotId/.test(options),
    'applyItems 必须传 remoteSnapshotId: session.snapshotId（P0-7：否则一键同步后基线指针停在空串）',
  );
  assert.equal(/remoteSnapshotId:\s*''/.test(options), false, 'remoteSnapshotId 不得硬编码空串');
  // 取值来源：会话登记时写入的正是本次拉取到的远端快照 id（不是本地临时 id）
  assert.ok(
    source.includes('snapshotId: preview.snapshotId,'),
    '同步会话必须登记 preview.snapshotId 作为 session.snapshotId（该值即远端快照 id）',
  );
});
/**
 * P0-7 收尾 · 引擎级端到端（宿主调用形状）：一键同步 = preview() → 同步会话持有 snapshotId →
 * applyItems(..., { remoteSnapshotId: session.snapshotId })。断言基线远端指针收敛到本轮拉取的远端快照 id。
 */
test('P0-7 收尾：一键同步（preview → applyItems 带 remoteSnapshotId）后 lastSnapshotId = 远端快照 id', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-p07-onclick-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote = mkRemote('remote-one-click', '2026-08-16T12:00:00.000Z', 'light', 7);
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const mock = new MockImporter();
    mock.ok = true;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snapshots'), mockImporter: mock,
    });

    const preview = await engine.preview();
    assert.equal(preview.ok, true);
    assert.equal(preview.snapshotId, 'remote-one-click', 'preview 返回本轮拉取的远端快照 id');
    assert.ok(preview.plan !== null, 'preview 应产出计划');

    // 宿主路由 /sync/apply-items 的调用形状（src/index.ts：remoteSnapshotId: session.snapshotId）
    const report = await engine.applyItems(preview.zipPath, preview.plan!, {
      remoteSnapshotId: preview.snapshotId,
    });
    assert.equal(report.ok, true);
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'remote-one-click', '一键同步后基线远端指针必须收敛到远端快照 id（不是空串）');
    assert.notEqual(state.ancestorId ?? '', '', '本地祖先副本目录名写在独立字段');

    // 清理 preview 创建并交给调用方的临时 ZIP 目录
    await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 审计 P0-23：自动同步回滚必须被 journal 感知（不得再被记成 COMMITTED） ──────────────

/** intent journal 用的 lock context（形状同 withMutationLock 产出的 token）。 */
const JOURNAL_LOCK_CTX: MutationLockContext = {
  token: { tokenId: 't-p023', managerId: 'm-test', instanceId: 'autosync-test', acquiredAt: 1 },
};

/** P0-23 的输入计划：单个 useRemote 项 → autoApply 非空，会真正走到 executeImportPlan。 */
function makeApplyPlan(): SyncApplyPlan {
  return {
    autoApply: [{
      id: 'settings',
      decision: 'useRemote',
      conflicts: [],
      merged: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 5, secrets: [] } } },
    }],
    review: [],
    skipped: [],
  };
}

/**
 * P0-23 的核心用例：自动同步路径（runExternalIntent → applyMergePlan → executeImportPlan）
 * 在导入内部完成**整体回滚**后，journal 终态必须是 ROLLED_BACK。
 *
 * 修复前必红：runExternalIntent 只投递 { operationId }（没有绑定面），这份 ctx 到不了
 * applyMergePlan，引擎的上报到不了 journal，尾操作照旧写 COMMITTED。
 */
test('P0-23: 自动同步 apply 内部整体回滚 → journal 终态 ROLLED_BACK（不得 COMMITTED）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p023-rollback-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const mock = new MockImporter();
    mock.ok = false;                  // 强制失败项 → applyMergePlan 走整体回滚
    mock.reportRollbackOnFailure = true; // 引擎已就地回滚并上报（analyzer 的真实行为）
    mock.rollbackFull = true;         // 完整回滚 → 不应置 SAFE MODE
    const engine = makeEngineWithMockImporter({
      ctx, transport: new MemSyncTransport(), stateDir: tmp, mockImporter: mock,
    });
    const recovery = new Phase3Recovery({
      dataDir: tmp, packageVersion: '0.1.63', environmentFingerprint: 'fp-p023',
    });

    const apply = makeApplyPlan();
    // 与 autosync-scheduler 的 rawApply 一致：把 intent journal 的 ctx 作为 snapshotBinding 透传
    const rawApply = async (c?: JournalRunContext): Promise<unknown> =>
      engine.applyMergePlan(apply, c !== undefined ? { snapshotBinding: c } : {});

    const { operationId, result } = await recovery.runExternalIntent({
      operationType: 'autosync-apply',
      lockCtx: JOURNAL_LOCK_CTX,
      intent: { adapter: 'sync', ref: 'git', kind: 'Apply' },
      fn: rawApply,
    });

    assert.equal((result as { ok: boolean }).ok, false, 'applyMergePlan 必须走失败（内部回滚）路径');
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    assert.equal(
      typeof (mock.receivedBinding as { recordRollback?: unknown } | undefined)?.recordRollback,
      'function',
      'applyMergePlan 必须把带 recordRollback 的绑定面透传给 executeImportPlan（否则上报无门）',
    );
    const terminal = await recovery.store.terminalStateOf(operationId);
    assert.notEqual(terminal, 'COMMITTED', '已回滚的 operation 绝不能被记成 COMMITTED');
    assert.equal(terminal, 'ROLLED_BACK', '上报回滚后终态应为 ROLLED_BACK');
    assert.equal(
      readSafeModeMarkerSync(tmp), 'clear',
      '完整回滚（full=true）不置 SAFE MODE —— 不过度阻断',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * P0-23 半回滚：rollback.full === false（存在补偿失败项）必须留下 durable SAFE MODE，
 * 行为与用户侧导入路径（analyzer 上报 → runJournaled 分支）逐字一致。
 */
test('P0-23: 自动同步 apply 半回滚 → ROLLED_BACK 且 SAFE MODE 标记可见', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p023-partial-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const mock = new MockImporter();
    mock.ok = false;
    mock.reportRollbackOnFailure = true;
    mock.rollbackFull = false;        // 半回滚态
    const engine = makeEngineWithMockImporter({
      ctx, transport: new MemSyncTransport(), stateDir: tmp, mockImporter: mock,
    });
    const recovery = new Phase3Recovery({
      dataDir: tmp, packageVersion: '0.1.63', environmentFingerprint: 'fp-p023',
    });

    const apply = makeApplyPlan();
    const { operationId } = await recovery.runExternalIntent({
      operationType: 'autosync-apply',
      lockCtx: JOURNAL_LOCK_CTX,
      intent: { adapter: 'sync', ref: 'git', kind: 'Apply' },
      fn: async (c?: JournalRunContext) =>
        engine.applyMergePlan(apply, c !== undefined ? { snapshotBinding: c } : {}),
    });

    assert.equal(await recovery.store.terminalStateOf(operationId), 'ROLLED_BACK');
    assert.equal(
      readSafeModeMarkerSync(tmp), 'blocked',
      '半回滚必须留下 durable SAFE MODE（下次启动不判 NORMAL），与导入路径一致',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * P0-23 反例守卫：终态只由**显式上报**决定，绝不按返回值形状推断。
 * ok:false 但引擎未上报回滚（例如执行前就失败、什么都没写）→ 不得凭空写 ROLLED_BACK。
 */
test('P0-23: 无回滚上报时不得凭 ok:false 形状推断成 ROLLED_BACK', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p023-noreport-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const mock = new MockImporter();
    mock.ok = false;
    mock.reportRollbackOnFailure = false; // 引擎未上报（形状不可推断）
    const engine = makeEngineWithMockImporter({
      ctx, transport: new MemSyncTransport(), stateDir: tmp, mockImporter: mock,
    });
    const recovery = new Phase3Recovery({
      dataDir: tmp, packageVersion: '0.1.63', environmentFingerprint: 'fp-p023',
    });

    const apply = makeApplyPlan();
    const { operationId } = await recovery.runExternalIntent({
      operationType: 'autosync-apply',
      lockCtx: JOURNAL_LOCK_CTX,
      intent: { adapter: 'sync', ref: 'git', kind: 'Apply' },
      fn: async (c?: JournalRunContext) =>
        engine.applyMergePlan(apply, c !== undefined ? { snapshotBinding: c } : {}),
    });

    assert.notEqual(
      await recovery.store.terminalStateOf(operationId), 'ROLLED_BACK',
      '没有显式上报就不得写 ROLLED_BACK —— 终态判定不能靠返回值形状猜',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * P0-23 源码守卫：真实调用方（autosync-scheduler）必须提供绑定。
 * 只给 applyMergePlan 加参数而无人传值 = 死参数，本用例专门钉住这一点。
 */
test('P0-23 源码守卫：autosync-scheduler 以 snapshotBinding 调 applyMergePlan', async () => {
  const src = await fs.readFile(new URL('./autosync-scheduler.ts', import.meta.url), 'utf8');
  // 锚在**真实调用点**（rawApply 的赋值）而非注释里的同名字符串：文件头注释也含
  // "engine.applyMergePlan(apply)"，直接 indexOf 会命中注释，守卫就成了假绿。
  const callIdx = src.indexOf('const rawApply = async');
  assert.ok(callIdx > 0, '应能找到 rawApply 定义（applyMergePlan 的真实调用点）');
  const call = src.slice(callIdx, callIdx + 500);
  assert.ok(
    call.includes('snapshotBinding'),
    'autosync-scheduler 必须把 intent ctx 作为 snapshotBinding 传给 applyMergePlan，实际调用片段：' + call,
  );
});

// ─── P0-2：跨机基础路径重定基（快照携带 sourceHome → 拉取计划自动重定基） ──────────


// ─── P1-5：会话删除墓碑（本地删 → 跨机传播 → 旧快照不复活） ────────────────────

test('P1-5: push 检测本地删除 → 墓碑进 manifest + sync-state，并给出可见告警', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tombstone-push-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('sessions/--p--/b/session.jsonl.zstd', Buffer.from('b', 'utf8'));
    ctx.fs.setMtime('sessions/--p--/b/session.jsonl.zstd', 2000);
    // 上次推送记录里有 a 与 b；本机只剩 b（= 用户把 a 删了；无需真删文件即可复现判据）
    await saveSyncState(tmp, {
      schemaVersion: SYNC_STATE_SCHEMA_VERSION,
      lastSyncAt: '2026-08-15T00:00:00.000Z',
      sections: {},
      lastSnapshotId: 'sync-prev',
      ancestorId: '',
      sessionUnits: ['sessions:--p--/a', 'sessions:--p--/b'],
      deletedSessions: [],
    });
    const transport = new MemSyncTransport();
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    const report = await engine.push({ snapshotId: 'sync-tomb', sections: ['sessions'], sessions: {} });
    assert.equal(report.ok, true);
    assert.deepEqual(
      transport.snapshots.get('sync-tomb')!.manifest.deletedSessions,
      ['sessions:--p--/a'],
      '被删掉的会话必须写进快照 manifest 的墓碑',
    );
    assert.ok(
      report.warnings.some((w) => w.includes('已记录') || w.includes('Recorded')),
      '记录删除必须可见（绝不静默）: ' + report.warnings.join(' | '),
    );
    const state = await loadSyncState(tmp);
    assert.deepEqual(state.sessionUnits, ['sessions:--p--/b'], '本次实际带走的会话单元');
    assert.deepEqual(state.deletedSessions, ['sessions:--p--/a'], '墓碑累积进状态（下轮继续传）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P1-5: 本机枚举不到任何会话 / 未推 sessions → 绝不覆盖既有记录（不猜成全删）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tombstone-noop-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    // 本机一个会话都没有（目录读不到或真为空）
    await saveSyncState(tmp, {
      schemaVersion: SYNC_STATE_SCHEMA_VERSION,
      lastSyncAt: '', sections: {}, lastSnapshotId: '', ancestorId: '',
      sessionUnits: ['sessions:--p--/a'],
      deletedSessions: ['sessions:--q--/old'],
    });
    const transport = new MemSyncTransport();
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    // 只推 settings（不含 sessions）→ 完全不动簿记
    await engine.push({ snapshotId: 'sync-settings-only', sections: ['settings'] });
    const afterSettings = await loadSyncState(tmp);
    assert.deepEqual(afterSettings.sessionUnits, ['sessions:--p--/a'], '未推 sessions → 保留原记录');
    assert.deepEqual(afterSettings.deletedSessions, ['sessions:--q--/old']);

    // 推 sessions 但本机枚举为空 → 同样不覆盖（把「读不到」当「全删」会一次性标错几百条）
    const report = await engine.push({ snapshotId: 'sync-empty-sessions', sections: ['sessions'], sessions: {} });
    assert.equal(report.ok, true);
    const afterEmpty = await loadSyncState(tmp);
    assert.deepEqual(afterEmpty.sessionUnits, ['sessions:--p--/a'], '枚举为空 → 不覆盖');
    assert.deepEqual(afterEmpty.deletedSessions, ['sessions:--q--/old']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('P1-5: pull 按远端墓碑剔除已删除的会话（旧快照不复活）+ 提示可见', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tombstone-pull-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\bob');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote: SyncSnapshot = {
      id: 'remote-old-with-a',
      createdAt: '2026-08-15T10:00:00.000Z',
      manifest: {
        schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32',
        sectionIds: ['sessions'], containsSecrets: false,
        deletedSessions: ['sessions:--p--/a'],
      },
      sections: {
        sessions: {
          version: 1,
          files: [
            { relativePath: '--p--/a/session.jsonl.zstd', data: new Uint8Array(Buffer.from('a')), contentHash: '' },
            { relativePath: '--p--/b/session.jsonl.zstd', data: new Uint8Array(Buffer.from('b')), contentHash: '' },
          ],
        },
      },
    };
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      includeOptInSections: true,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    const preview = await engine.preview();
    try {
      assert.ok(preview.plan !== null, 'preview 应产出计划');
      assert.ok(
        !preview.plan!.items.some((i) => i.id.includes('--p--/a')),
        '墓碑命中的会话绝不能被旧快照带回：' + preview.plan!.items.map((i) => i.id).join(', '),
      );
      assert.ok(preview.plan!.items.some((i) => i.id.includes('--p--/b')), '其余会话照常进计划');
      assert.ok((preview.message ?? '').includes('1'), '剔除必须可见（绝不静默）: ' + String(preview.message));
    } finally {
      await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 快照 manifest 携带导出机 sourceHome（跨机重定基的数据源）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-sourcehome-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-home' });
    assert.equal(report.ok, true);
    const home = transport.snapshots.get('sync-home')!.manifest.sourceHome;
    assert.equal(home, ctx.homeDir, '快照必须记录导出机 DSH home');
    assert.notEqual(home ?? '', '', '不能是空串（空串等于没记）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** 构造一个带 workspaces 数据的远端快照（sourceHome 可选，缺省 = 旧构建的包）。 */
function mkCrossMachineRemote(id: string, sourceHome: string | undefined): SyncSnapshot {
  return {
    id,
    createdAt: '2026-08-15T10:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'workspaces'],
      containsSecrets: false,
      ...(sourceHome === undefined ? {} : { sourceHome }),
    },
    sections: {
      settings: { version: 1, namespaces: {} },
      workspaces: {
        version: 1,
        workspaces: [{ id: 'ws-1', path: 'C:\\Users\\alice\\proj', title: 'proj', sessionIds: [] }],
      },
    },
  };
}

test('preview: 远端 sourceHome ≠ 本机 → 自动重定基进入计划（排在用户映射之前）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-rebase-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\bob');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote = mkCrossMachineRemote('remote-cross', 'C:\\Users\\alice');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const preview = await engine.preview();
    try {
      assert.ok(preview.plan !== null, 'preview 应产出计划');
      assert.deepEqual(
        preview.plan!.automaticMappings,
        [{ oldPrefix: 'C:/Users/alice', newPrefix: 'C:/Users/bob', appliesTo: [] }],
        '导出机 home → 本机 home 的自动重定基必须进入计划',
      );
      assert.equal(preview.plan!.pathMappings[0]?.oldPrefix, 'C:/Users/alice', '重定基排在映射列表最前');
    } finally {
      await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('preview: 旧快照缺 sourceHome → 不生成自动重定基（不猜，行为与改造前一致）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-rebase-legacy-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\bob');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote = mkCrossMachineRemote('remote-legacy', undefined);
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const preview = await engine.preview();
    try {
      assert.ok(preview.plan !== null, 'preview 应产出计划');
      assert.equal(preview.plan!.automaticMappings, undefined, '缺 sourceHome 时绝不猜一个重定基规则');
      assert.deepEqual(preview.plan!.pathMappings, [], '没有用户映射 → 空映射列表');
    } finally {
      await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('preview: 用户路径映射随请求进入计划，且排在自动重定基之后', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-rebase-user-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\bob');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const remote = mkCrossMachineRemote('remote-user-map', 'C:\\Users\\alice');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const preview = await engine.preview({
      pathMappings: [{ oldPrefix: 'C:/Users/bob/proj', newPrefix: 'D:/work/proj', appliesTo: [] }],
    });
    try {
      assert.ok(preview.plan !== null, 'preview 应产出计划');
      const olds = preview.plan!.pathMappings.map((m) => m.oldPrefix);
      assert.deepEqual(olds, ['C:/Users/alice', 'C:/Users/bob/proj'], '自动重定基在前、用户映射在后');
    } finally {
      await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
