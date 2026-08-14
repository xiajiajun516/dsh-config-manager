/**
 * Profiles 模块测试（m8，规范 §20）：
 * 保存 / 列表 / 复制 / 重命名 / 删除 / Preview / 切换（confirm 安全阀 + 快照 + 回滚）/
 * 冲突决策 / 文件类 base64 往返 / 导出导入往返 / 名称校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProfileManager, isValidProfileName } from './profile-manager.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { ImportNotConfirmedError } from '../core/types.ts';
import type { ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext, ImportContext, PlanItem, Portability, ValidationResult } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';

const NS = ['general', 'theme', 'llm-deepseek'];

/** 装饰器：对指定 item id 的 applyItem 抛错（回滚测试用），其余委托内部 adapter */
class FailOnItemAdapter implements ConfigAdapter {
  readonly id: SectionId;
  readonly displayName: string;
  readonly defaultIncluded: boolean;
  readonly portability: Portability;
  private readonly inner: ConfigAdapter;
  private readonly failItemId: string;
  constructor(inner: ConfigAdapter, failItemId: string) {
    this.inner = inner;
    this.failItemId = failItemId;
    this.id = inner.id;
    this.displayName = inner.displayName;
    this.defaultIncluded = inner.defaultIncluded;
    this.portability = inner.portability;
  }
  export(ctx: HostContext, opts: ExportOptions): Promise<ExportSection<unknown>> { return this.inner.export(ctx, opts); }
  validate(data: unknown): Promise<ValidationResult> { return this.inner.validate(data); }
  analyzeImport(data: unknown, ctx: ImportContext): Promise<PlanItem[]> { return this.inner.analyzeImport(data, ctx); }
  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (item.id === this.failItemId) throw new Error(`模拟失败: ${item.id}`);
    return this.inner.applyItem(item, ctx);
  }
}

async function seedSource(ctx: ReturnType<typeof makeContext>): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\n', 'utf8'));
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-secret');
}

test('isValidProfileName: 拒绝路径穿越与非法字符', () => {
  assert.equal(isValidProfileName('work'), true);
  assert.equal(isValidProfileName('Work Personal-2'), true);
  assert.equal(isValidProfileName('../evil'), false);
  assert.equal(isValidProfileName('a/b'), false);
  assert.equal(isValidProfileName('a\\b'), false);
  assert.equal(isValidProfileName(''), false);
  assert.equal(isValidProfileName('..'), false);
});

test('saveCurrent + list: 保存 profile.json（文件类 base64 编码，settings 不含秘密值）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-save-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(ctx);
    const adapters = createAdapters({ namespaces: NS });
    const mgr = new ProfileManager({ dataDir: path.join(tmp, 'data'), ctx, adapters, snapshotStore: new MemSnapshotStore() });

    const meta = await mgr.saveCurrent('work');
    assert.equal(meta.name, 'work');
    assert.ok(meta.sections.includes('settings'));
    assert.ok(meta.sections.includes('skills'));

    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'profiles', 'work', 'profile.json'), 'utf8'));
    assert.equal(raw.version, 1);
    const skillFile = raw.sections.skills.files.find((f: { relativePath: string }) => f.relativePath === 'coding.md');
    assert.ok(skillFile, 'skills 文件进入 profile');
    assert.equal(typeof skillFile.data, 'string', '文件类 data 以 base64 内嵌');
    // 秘密值绝不进入 profile
    const serialized = JSON.stringify(raw);
    assert.ok(!serialized.includes('sk-secret'), 'Profile 不得包含凭据值');

    const list = await mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'work');
    assert.ok(list[0]?.sections.includes('skills'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('duplicate / rename / delete: 基础管理操作', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-mgmt-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(ctx);
    const adapters = createAdapters({ namespaces: NS });
    const mgr = new ProfileManager({ dataDir: path.join(tmp, 'data'), ctx, adapters, snapshotStore: new MemSnapshotStore() });

    await mgr.saveCurrent('work');
    const dup = await mgr.duplicate('work', 'personal');
    assert.equal(dup.name, 'personal');
    assert.equal((await mgr.list()).length, 2);

    const renamed = await mgr.rename('personal', 'personal-2');
    assert.equal(renamed.name, 'personal-2');
    assert.equal((await mgr.list()).map((m) => m.name).sort().join(','), 'personal-2,work');

    await mgr.delete('personal-2');
    assert.equal((await mgr.list()).length, 1);

    await assert.rejects(() => mgr.delete('not-exists'), /不存在/);
    await assert.rejects(() => mgr.duplicate('work', '../evil'), /非法/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('analyzeSwitch Preview + executeSwitch（confirm 安全阀 + Create 应用 + 幂等）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-switch-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const adapters = createAdapters({ namespaces: NS });
    const dataDir = path.join(tmp, 'data');
    const srcMgr = new ProfileManager({ dataDir, ctx: src, adapters, snapshotStore: new MemSnapshotStore() });
    await srcMgr.saveCurrent('work');

    const dst = makeContext('linux', '/home/bob');
    const dstMgr = new ProfileManager({ dataDir, ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    // 未确认 → 拒绝且零写入
    await assert.rejects(() => dstMgr.executeSwitch('work', {}), ImportNotConfirmedError);
    assert.equal(dst.settings.ns.size, 0);

    // Preview（纯读）
    const preview = await dstMgr.analyzeSwitch('work');
    assert.ok(preview.items.some((i) => i.id === 'settings:general' && i.kind === 'Create'), 'Preview 含 Create 项');
    assert.ok(preview.items.some((i) => i.id === 'skills:coding.md' && i.kind === 'Create'));
    assert.ok(preview.sectionsInProfile.includes('settings'));

    // 确认执行
    const r = await dstMgr.executeSwitch('work', { confirm: true });
    assert.equal(r.ok, true);
    assert.ok(r.snapshotId, '切换必须产生快照');
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    assert.deepEqual(dst.settings.ns.get('theme')?.value, { mode: 'dark' });
    assert.equal((dst.settings.ns.get('llm-deepseek')?.value as Record<string, unknown>).apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString(), '# Coding skill\n', '文件类分区恢复');

    // 幂等：再切 → Skip
    const preview2 = await dstMgr.analyzeSwitch('work');
    assert.equal(preview2.items.find((i) => i.id === 'settings:general')?.kind, 'Skip');
    assert.equal(preview2.items.find((i) => i.id === 'skills:coding.md')?.kind, 'Skip');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('executeSwitch: 冲突 merge 不覆盖 / useImported 覆盖', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-conflict-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const adapters = createAdapters({ namespaces: NS });
    const dataDir = path.join(tmp, 'data');
    const srcMgr = new ProfileManager({ dataDir, ctx: src, adapters, snapshotStore: new MemSnapshotStore() });
    await srcMgr.saveCurrent('work');

    const dst = makeContext('linux', '/home/bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
    const dstMgr = new ProfileManager({ dataDir, ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    // merge + 无决策 → Conflict 保留，不覆盖
    const r1 = await dstMgr.executeSwitch('work', { confirm: true, strategy: 'merge' });
    assert.equal(r1.ok, true);
    assert.equal(r1.executed.find((e) => e.itemId === 'settings:general')?.status, 'skipped', '冲突未解决时跳过');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', '不覆盖目标');

    // useImported → Update 覆盖
    const r2 = await dstMgr.executeSwitch('work', { confirm: true, resolutions: { 'settings:general': 'useImported' } });
    assert.equal(r2.executed.find((e) => e.itemId === 'settings:general')?.status, 'ok');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'dark', 'useImported 覆盖');

    // skipExisting 全局策略 → Conflict 自动 Skip
    dst.settings.ns.set('general', { value: { theme: 'purple' }, revision: 10, secrets: [] });
    const r3 = await dstMgr.executeSwitch('work', { confirm: true, strategy: 'skipExisting' });
    assert.equal(r3.executed.find((e) => e.itemId === 'settings:general')?.status, 'skipped');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'purple');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('executeSwitch: 中途失败 + rollbackOnError → 恢复切换前状态', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-rollback-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    await src.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\n', 'utf8'));
    const adapters = createAdapters({ namespaces: NS });
    const dataDir = path.join(tmp, 'data');
    const srcMgr = new ProfileManager({ dataDir, ctx: src, adapters, snapshotStore: new MemSnapshotStore() });
    await srcMgr.saveCurrent('work');

    const dst = makeContext('linux', '/home/bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    const failingAdapters = adapters.map((a) => new FailOnItemAdapter(a, 'skills:coding.md'));
    const dstMgr = new ProfileManager({ dataDir, ctx: dst, adapters: failingAdapters, snapshotStore: new MemSnapshotStore() });

    const r = await dstMgr.executeSwitch('work', { confirm: true, strategy: 'replace', rollbackOnError: true });
    assert.equal(r.ok, false, '失败项 → ok=false');
    assert.ok(r.rollback, '失败应有回滚报告');
    assert.equal(r.rollback.full, true, '快照覆盖目标应能完整回滚');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', '回滚后 general 恢复');
    // 原目标无 skills/coding.md → 回滚应删除导入写入的文件
    await assert.rejects(() => dst.fs.readFile('skills/coding.md'), /ENOENT/, '回滚删除导入创建的文件');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('exportProfile / importProfile 往返（完整验证）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-xport2-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(ctx);
    const adapters = createAdapters({ namespaces: NS });
    const dataDir = path.join(tmp, 'data');
    const mgr = new ProfileManager({ dataDir, ctx, adapters, snapshotStore: new MemSnapshotStore() });
    await mgr.saveCurrent('work');

    const outPath = path.join(tmp, 'dsh-profile-work.json');
    await mgr.exportProfile('work', outPath);

    // 同名导入冲突
    await assert.rejects(() => mgr.importProfile(outPath), /已存在/);

    // asName 导入
    const imported = await mgr.importProfile(outPath, { asName: 'work-copy' });
    assert.equal(imported.name, 'work-copy');
    assert.ok(imported.sections.includes('skills'), '文件类分区随导入保留');

    // 导入后的 profile 可切换到空目标
    const dst = makeContext('linux', '/home/bob');
    const dstMgr = new ProfileManager({ dataDir, ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
    const r = await dstMgr.executeSwitch('work-copy', { confirm: true });
    assert.equal(r.ok, true);
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString(), '# Coding skill\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('importProfile: 拒绝非法文件与非法名', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profiles-bad-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    const adapters = createAdapters({ namespaces: NS });
    const mgr = new ProfileManager({ dataDir: path.join(tmp, 'data'), ctx, adapters, snapshotStore: new MemSnapshotStore() });

    const badPath = path.join(tmp, 'bad.json');
    await fs.writeFile(badPath, '{"version":999,"sections":{}}', 'utf8');
    await assert.rejects(() => mgr.importProfile(badPath), /无效/);

    const evilPath = path.join(tmp, 'evil.json');
    await fs.writeFile(evilPath, '{"name":"../evil","version":1,"sections":{}}', 'utf8');
    await assert.rejects(() => mgr.importProfile(evilPath), /非法/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
