/**
 * 核心引擎冒烟测试（m3 验收）：真实运行 导出 → ZIP → 导入 往返。
 * 使用内存 mock 的 HostContext 与 ConfigAdapter（引擎与 DSH 运行时解耦的可测性证明）。
 *
 * 覆盖：往返 / Secret 不泄值 / Dry Run 零写入 / 未确认拒绝 / 冲突不覆盖 /
 *       幂等重复导入 / 整体回滚 / checksum 篡改拒绝 / schema 版本拒绝 / ZIP 安全。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { parseZip, zipToBuffer, crc32, ZipSafetyError, type ZipWriteEntry } from '../utils/zip.ts';
import { parseManifest } from '../schema/manifest.ts';
import { computeCompatibility } from './validator.ts';
import { createLogger, type Logger } from '../utils/logger.ts';
import { isPathSafe, normalizePath } from '../utils/paths.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { UnsupportedSchemaError } from '../schema/versions.ts';
import { ImportNotConfirmedError } from './types.ts';
import type {
  FilesSection, NamespaceRecord, SettingsSection, WorkspaceRecord, WorkspacesSection,
} from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, CredentialsFacade, ExportSection, FileSystemFacade,
  HostContext, ImportContext, NamespaceInfo, PatchFileFacade,
  PlanItem, PluginsFacade, SettingsFacade, Snapshot,
  SnapshotEntry, SnapshotStore, SnapshotTarget, ValidationResult,
  WorkspaceFacade,
} from './types.ts';

/* ================= Mock 基础设施 ================= */

class MemFs implements FileSystemFacade {
  files = new Map<string, Uint8Array>();
  private readonly homeDir: string;
  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }
  private key(p: string): string {
    return normalizePath(path.resolve(this.homeDir, p));
  }
  async readFile(relPath: string): Promise<Uint8Array> {
    const v = this.files.get(this.key(relPath));
    if (v === undefined) throw new Error(`ENOENT: ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    this.files.set(this.key(relPath), data);
  }
  async exists(relPath: string): Promise<boolean> {
    return this.files.has(this.key(relPath));
  }
  async copy(from: string, to: string): Promise<void> {
    const v = this.files.get(this.key(from));
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(this.key(to), v);
  }
  async remove(relPath: string): Promise<void> {
    this.files.delete(this.key(relPath));
  }
  async listRecursive(dir: string): Promise<string[]> {
    const prefix = normalizePath(path.resolve(this.homeDir, dir)) + '/';
    const out: string[] = [];
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(this.homeDir.length).replace(/^[\\/]+/, ''));
    }
    return out.sort();
  }
  async mkdir(): Promise<void> { /* 内存实现无需建目录 */ }
}

class MemSettings implements SettingsFacade {
  ns = new Map<string, { value: unknown; revision: number; secrets: { path: string[]; set: boolean }[] }>();
  async describe(namespace: string): Promise<NamespaceInfo> {
    const rec = this.ns.get(namespace);
    if (!rec) throw new Error(`namespace not found: ${namespace}`);
    return { value: rec.value, revision: rec.revision, secrets: rec.secrets };
  }
  async replace(namespace: string, value: unknown, expectedRevision?: number): Promise<void> {
    const rec = this.ns.get(namespace);
    if (expectedRevision !== undefined && rec && rec.revision !== expectedRevision) {
      throw new Error(`SETTINGS_CONFLICT: ${namespace} revision ${rec.revision} !== ${expectedRevision}`);
    }
    this.ns.set(namespace, { value, revision: (rec?.revision ?? 0) + 1, secrets: rec?.secrets ?? [] });
  }
}

class MemCredentials implements CredentialsFacade {
  values = new Map<string, string>();
  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }> {
    const v = this.values.get(ref);
    return { configured: v !== undefined, source: v !== undefined ? 'file' : 'env', writable: true };
  }
  async set(ref: string, value: string): Promise<void> { this.values.set(ref, value); }
  async unset(ref: string): Promise<void> { this.values.delete(ref); }
}

class MemPlugins implements PluginsFacade {
  installed = new Map<string, { name: string; version: string; enabled: boolean }>();
  async listInstalled() { return [...this.installed.values()]; }
  async install(pkg: string) { this.installed.set(pkg, { name: pkg, version: '1.0.0', enabled: true }); return { needsRestart: true }; }
}

class MemWorkspace implements WorkspaceFacade {
  records = new Map<string, WorkspaceRecord>();
  async listRecords(): Promise<WorkspaceRecord[]> { return [...this.records.values()]; }
  async writeRecord(r: WorkspaceRecord): Promise<void> { this.records.set(r.id, r); }
  async removeRecord(id: string): Promise<void> { this.records.delete(id); }
}

class MemPatch implements PatchFileFacade {
  lines = new Map<string, { lineId: string; raw: unknown }>();
  async readPatchLines(): Promise<{ lineId: string; raw: unknown }[]> { return [...this.lines.values()]; }
  async applyPatchChanges(_file: string, changes: { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove' }[]): Promise<void> {
    for (const c of changes) {
      if (c.action === 'remove') this.lines.delete(c.lineId);
      else this.lines.set(c.lineId, { lineId: c.lineId, raw: c.raw });
    }
  }
}

class MemSnapshotStore implements SnapshotStore {
  snapshots = new Map<string, Snapshot>();
  blobs = new Map<string, Uint8Array>();
  async save(snapshot: Snapshot, blobs: Map<string, Uint8Array> = new Map()): Promise<string> {
    this.snapshots.set(snapshot.id, snapshot);
    for (const [k, v] of blobs) this.blobs.set(`${snapshot.id}/${k}`, v);
    return snapshot.id;
  }
  async load(id: string): Promise<Snapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`snapshot not found: ${id}`);
    return s;
  }
  async readBlob(id: string, blobPath: string): Promise<Uint8Array> {
    const v = this.blobs.get(`${id}/${blobPath}`);
    if (!v) throw new Error(`blob not found: ${id}/${blobPath}`);
    return v;
  }
}

class MockHostContext implements HostContext {
  platform: string;
  arch = 'x64';
  homeDir: string;
  dshVersion = '0.1.0-rc.6';
  log: Logger;
  settings = new MemSettings();
  credentials = new MemCredentials();
  plugins = new MemPlugins();
  workspace = new MemWorkspace();
  patchFile = new MemPatch();
  fs: MemFs;
  constructor(platform: string, homeDir: string) {
    this.platform = platform;
    this.homeDir = homeDir;
    this.fs = new MemFs(homeDir);
    this.log = createLogger({ level: 'error', sink: () => {} });
  }
}

/* ================= Mock Adapters（契约样例，m5 实现真实版） ================= */

const KNOWN_NS = ['general', 'llm-deepseek', 'theme'];

class MockSettingsAdapter implements ConfigAdapter<SettingsSection> {
  readonly id = 'settings' as const;
  readonly displayName = 'Settings';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 测试钩子：下一次 applyItem 抛错（回滚测试用） */
  failNext = false;

  async export(ctx: HostContext): Promise<ExportSection<SettingsSection>> {
    const namespaces: Record<string, NamespaceRecord> = {};
    for (const name of KNOWN_NS) {
      try {
        const info = await ctx.settings.describe(name);
        namespaces[name] = { value: info.value, base: info.base, revision: info.revision, applies: info.applies, secrets: info.secrets };
      } catch { /* 不存在则跳过 */ }
    }
    return { sectionId: 'settings', data: { version: 1, namespaces }, counts: { namespaces: Object.keys(namespaces).length }, warnings: [] };
  }

  async analyzeImport(data: SettingsSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    for (const [name, rec] of Object.entries(data.namespaces)) {
      let current: NamespaceInfo | null = null;
      try { current = await ctx.target.settings.describe(name); } catch { current = null; }
      const id = `settings:${name}`;
      if (current === null) {
        items.push({ id, kind: 'Create', adapter: 'settings', description: `创建设置 ${name}`, severity: 'info', target: { adapter: 'settings', ref: name } });
      } else if (isDeepStrictEqual(current.value, rec.value)) {
        items.push({ id, kind: 'Skip', adapter: 'settings', description: `设置 ${name} 已一致`, severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'settings', description: `设置 ${name} 与目标不同`,
          detail: `current=${JSON.stringify(current.value)} imported=${JSON.stringify(rec.value)}`.slice(0, 200),
          severity: 'warning', target: { adapter: 'settings', ref: name },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (this.failNext) { this.failNext = false; throw new Error('模拟写入失败（failNext）'); }
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 target.ref' };
    const data = ctx.sections.get('settings') as SettingsSection;
    const rec = data.namespaces[ref];
    if (!rec) return { ok: false, message: `导入数据缺少 namespace ${ref}` };
    await ctx.target.settings.replace(ref, rec.value);
    return { ok: true };
  }

  async validate(data: SettingsSection): Promise<ValidationResult> {
    return { valid: data.version === 1 && data.namespaces !== null && typeof data.namespaces === 'object', issues: [] };
  }
}

class MockSkillsAdapter implements ConfigAdapter<FilesSection> {
  readonly id = 'skills' as const;
  readonly displayName = 'Skills';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;

  async export(ctx: HostContext): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const rels = await ctx.fs.listRecursive('skills');
    for (const rel of rels) {
      const data = await ctx.fs.readFile(rel);
      files.push({ relativePath: rel.replace(/^skills[\\/]/, ''), data, contentHash: sha256Hex(data) });
    }
    return { sectionId: 'skills', data: { version: 1, files }, counts: { files: files.length }, warnings: [] };
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `skill:${file.relativePath}`;
      let current: Uint8Array | null = null;
      try { current = await ctx.target.fs.readFile(path.join('skills', file.relativePath)); } catch { current = null; }
      if (current === null) {
        items.push({ id, kind: 'Create', adapter: 'skills', description: `创建技能 ${file.relativePath}`, severity: 'info', target: { adapter: 'skills', ref: file.relativePath } });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: 'skills', description: `技能 ${file.relativePath} 已一致`, severity: 'info' });
      } else {
        items.push({ id, kind: 'Conflict', adapter: 'skills', description: `技能 ${file.relativePath} 内容不同`, severity: 'warning', target: { adapter: 'skills', ref: file.relativePath } });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 ref' };
    const data = ctx.sections.get('skills') as FilesSection;
    const file = data.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: `导入数据缺少技能 ${ref}` };
    await ctx.target.fs.writeFile(path.join('skills', ref), file.data);
    return { ok: true };
  }

  async validate(data: FilesSection): Promise<ValidationResult> {
    return { valid: data.version === 1 && Array.isArray(data.files), issues: [] };
  }
}

class MockWorkspacesAdapter implements ConfigAdapter<WorkspacesSection> {
  readonly id = 'workspaces' as const;
  readonly displayName = 'Workspaces';
  readonly defaultIncluded = true;
  readonly portability = 'platformSpecific' as const;

  async export(ctx: HostContext): Promise<ExportSection<WorkspacesSection>> {
    const records = await ctx.workspace.listRecords();
    return { sectionId: 'workspaces', data: { version: 1, workspaces: records }, counts: { workspaces: records.length }, warnings: [] };
  }

  async analyzeImport(data: WorkspacesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    for (const rec of data.workspaces) {
      const id = `workspace:${rec.id}`;
      const existing = (await ctx.target.workspace.listRecords()).find((r) => r.id === rec.id);
      if (!existing) {
        items.push({ id, kind: 'Create', adapter: 'workspaces', description: `创建工作区 ${rec.title ?? rec.id}`, severity: 'info', target: { adapter: 'workspaces', ref: rec.id } });
      } else if (existing.path === rec.path) {
        items.push({ id, kind: 'Skip', adapter: 'workspaces', description: `工作区 ${rec.id} 已一致`, severity: 'info' });
      } else {
        items.push({ id, kind: 'Conflict', adapter: 'workspaces', description: `工作区 ${rec.id} 路径不同`, severity: 'warning', target: { adapter: 'workspaces', ref: rec.id } });
      }
      if (rec.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rec.path)) {
        items.push({
          id: `${id}:path`, kind: 'PathMapping', adapter: 'workspaces',
          description: `路径需映射: ${rec.path}`, severity: 'warning',
          pathMapping: { oldPrefix: rec.path, newPrefix: '', appliesTo: ['workspaces'] },
          target: { adapter: 'workspaces', ref: rec.id },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (item.kind === 'PathMapping') return { ok: true }; // 数据已由 PathMapper 应用到 sections
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 ref' };
    const data = ctx.sections.get('workspaces') as WorkspacesSection;
    const rec = data.workspaces.find((r) => r.id === ref);
    if (!rec) return { ok: false, message: `导入数据缺少工作区 ${ref}` };
    await ctx.target.workspace.writeRecord(rec);
    return { ok: true };
  }

  async validate(data: WorkspacesSection): Promise<ValidationResult> {
    return { valid: data.version === 1 && Array.isArray(data.workspaces), issues: [] };
  }
}

class MockCredentialsAdapter implements ConfigAdapter<import('../schema/types.ts').CredentialsSection> {
  readonly id = 'credentialsStatus' as const;
  readonly displayName = 'Credentials';
  readonly defaultIncluded = true;
  readonly portability = 'deviceSpecific' as const;

  /** 从 settings 分区推断凭据引用（apiKeyEnv / secrets 标记），再查状态 */
  async export(ctx: HostContext): Promise<ExportSection<import('../schema/types.ts').CredentialsSection>> {
    const refs = new Set<string>();
    for (const name of KNOWN_NS) {
      try {
        const info = await ctx.settings.describe(name);
        for (const s of info.secrets) {
          if (s.set && s.path.length > 0 && typeof s.path[0] === 'string') refs.add(s.path[0]);
        }
        if (name === 'llm-deepseek') {
          const v = info.value as { apiKeyEnv?: unknown };
          if (typeof v.apiKeyEnv === 'string') refs.add(v.apiKeyEnv);
        }
      } catch { /* 跳过不存在的 namespace */ }
    }
    const credentials: import('../schema/types.ts').CredentialStatus[] = [];
    for (const ref of refs) {
      const status = await ctx.credentials.describe(ref);
      credentials.push({ ref, required: true, configured: status.configured, source: (status.source ?? 'file') as 'file', hasValue: false });
    }
    return { sectionId: 'credentialsStatus', data: { version: 1, credentials }, counts: { credentials: credentials.length }, warnings: [] };
  }

  async analyzeImport(data: import('../schema/types.ts').CredentialsSection, _ctx: ImportContext): Promise<PlanItem[]> {
    return data.credentials.map((c) => ({
      id: `secret:${c.ref}`,
      kind: 'MissingSecret' as const,
      adapter: 'credentialsStatus' as const,
      description: `凭据 ${c.ref} 需补录`,
      severity: 'warning' as const,
      target: { adapter: 'credentialsStatus' as const, ref: c.ref },
    }));
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 ref' };
    const value = ctx.secretInputs[ref] ?? ctx.decryptedCredentials?.get(ref);
    if (value === undefined || value === '') return { ok: false, message: '凭据值未提供' };
    await ctx.target.credentials.set(ref, value);
    return { ok: true };
  }

  async validate(data: import('../schema/types.ts').CredentialsSection): Promise<ValidationResult> {
    return { valid: data.version === 1 && Array.isArray(data.credentials), issues: [] };
  }
}

/* ================= 测试辅助 ================= */

function makeContext(platform: string, homeDir: string): MockHostContext {
  return new MockHostContext(platform, homeDir);
}

function makeAdapters(): ConfigAdapter[] {
  return [new MockSettingsAdapter(), new MockSkillsAdapter(), new MockWorkspacesAdapter(), new MockCredentialsAdapter()];
}

/** 手工构造原始 ZIP（含任意条目名，绕过写侧校验，用于读侧 Zip Slip 测试） */
function buildRawZip(entryName: string, data: Uint8Array): Uint8Array {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(0, 10);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(30 + nameBuf.length, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, cen, nameBuf, eocd]);
}

/** 导出完整示例备份（win32 源，含 secret 字段、技能文件、workspace 绝对路径） */
async function exportFixture(src: MockHostContext, outPath: string, adapters: ConfigAdapter[]): Promise<void> {
  src.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  src.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.example.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-value-123' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  await src.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
  await src.fs.writeFile('skills/git.md', Buffer.from('# Git skill\n', 'utf8'));
  src.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
  src.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  const exporter = new Exporter({ ctx: src, adapters, exporterVersion: '0.1.0', now: () => new Date('2026-08-14T12:00:00.000Z') });
  const result = await exporter.export({ includeSecrets: false, outPath });
  assert.equal(result.manifest.schemaVersion, 1);
}

/* ================= 测试用例 ================= */

test('ZIP 基础：写读往返 + CRC32 + 目录穿越拒绝', () => {
  const buf = zipToBuffer([
    { name: 'a/b.txt', data: Buffer.from('hello') },
    { name: 'c.json', data: Buffer.from('{"x":1}') },
  ]);
  const archive = parseZip(buf);
  assert.deepEqual(archive.names(), ['a/b.txt', 'c.json']);
  assert.equal(Buffer.from(archive.readEntry('a/b.txt')).toString(), 'hello');
  assert.deepEqual(archive.readEntryJson('c.json'), { x: 1 });
  // 写侧拒绝不安全条目名
  assert.throws(() => zipToBuffer([{ name: '../evil.txt', data: Buffer.from('x') }]), ZipSafetyError);
  assert.equal(isPathSafe('../evil.txt'), false);
  assert.equal(isPathSafe('C:\\evil.txt'), false);
  assert.equal(isPathSafe('/abs/path'), false);
  assert.equal(isPathSafe('a/b.txt'), true);
});

test('ZIP 读侧安全：../ 条目名 → ZipSafetyError（Zip Slip）', () => {
  const malicious = buildRawZip('../evil.txt', Buffer.from('pwned'));
  assert.throws(() => parseZip(malicious), ZipSafetyError);
  const absolute = buildRawZip('C:/evil.txt', Buffer.from('pwned'));
  assert.throws(() => parseZip(absolute), ZipSafetyError);
});

test('导出→导入完整往返（win32 → linux + 路径映射 + Secret 不泄值 + Dry Run 零写入）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-smoke-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    const adapters = makeAdapters();
    const zipPath = path.join(tmp, 'dsh-config-test.zip');
    await exportFixture(src, zipPath, adapters);

    // —— 导出物检查 ——
    const archive = parseZip(await fs.readFile(zipPath));
    const manifest = parseManifest(archive.readEntryText('manifest.json'));
    assert.equal(manifest.security.containsSecrets, false);
    assert.equal(manifest.security.encrypted, false);
    assert.equal(manifest.sections.settings, true);
    assert.equal(manifest.sections.skills, true);
    assert.equal(manifest.sections.workspaces, true);
    // 完整性表存在且可校验
    assert.ok(archive.has('integrity/checksums.json'));
    // Secret 值绝不出现在导出内容（结构化数据被剥离）
    const allText = archive.names()
      .filter((n) => n !== 'integrity/checksums.json')
      .map((n) => Buffer.from(archive.readEntry(n)).toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('sk-super-secret-value-123'), 'secret 值不得写入导出');
    assert.ok(!allText.includes('super-secret'), 'secret 值不得写入导出');

    // —— 目标机器（linux）导入 ——
    const dst = makeContext('linux', '/home/bob');
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.secretCount, 1, '应报告 1 个已配置凭据（DEEPSEEK_API_KEY）');
    assert.equal(analysis.valid, true);
    assert.equal(analysis.compatibility, 'partial'); // 跨平台
    assert.ok(analysis.pathIssues.some((p) => p.kind === 'platformMismatch' && p.value.includes('C:\\Users\\alice')), '应检测到跨平台路径问题');

    // Dry Run：analyze + plan 后目标零变化
    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'merge',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces', 'mcp', 'pluginConfig', 'skills'] }],
    });
    assert.equal(dst.settings.ns.size, 0);
    assert.equal(dst.fs.files.size, 0);
    assert.equal(dst.workspace.records.size, 0);
    assert.ok(plan.pathMappings.some((m) => m.oldPrefix === 'C:\\Users\\alice'), '路径映射应进入计划');
    assert.equal(plan.needsRestart, false);

    // 未确认 → 拒绝执行且零写入
    await assert.rejects(() => importer.executeImportPlan(zipPath, plan, { confirm: false }), ImportNotConfirmedError);
    assert.equal(dst.settings.ns.size, 0);

    // 确认执行
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.ok(result.snapshotId, '应有快照 id');

    // —— 目标已恢复源配置 ——
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    const llm = dst.settings.ns.get('llm-deepseek')?.value as Record<string, unknown>;
    assert.equal(llm.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(llm.apiKey, '', 'secret 字段被剥离为空串');
    assert.ok(await dst.fs.exists(path.join('skills', 'coding.md')), '技能文件应已导入');
    assert.equal(Buffer.from(await dst.fs.readFile(path.join('skills', 'coding.md'))).toString(), '# Coding skill\nUse deepseek.\n');
    const ws = dst.workspace.records.get('ws-ops');
    assert.ok(ws, 'workspace 应已导入');
    assert.equal(normalizePath(ws!.path), '/home/bob/projects/ops', '绝对路径应被映射');

    // 凭据值未随备份 → 结果如实报告需补录（值绝不落盘）
    assert.ok(result.missingSecrets.includes('DEEPSEEK_API_KEY'), '应报告凭据需补录');
    assert.ok(!dst.credentials.values.has('DEEPSEEK_API_KEY'), '未提供值时不得写入凭据');

    // 幂等：再次导入 → 无 Create/Update/Install 新写入项
    const plan2 = await importer.createImportPlan(zipPath, {
      strategy: 'merge',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces', 'mcp', 'pluginConfig', 'skills'] }],
    });
    assert.ok(
      !plan2.items.some((i) => i.kind === 'Create' || i.kind === 'Update' || i.kind === 'Install'),
      '重复导入不应产生新写入项（Create/Update/Install）',
    );
    const result2 = await importer.executeImportPlan(zipPath, plan2, { confirm: true });
    assert.ok(result2.executed.every((e) => e.status !== 'failed'), '第二次导入不应有失败项');
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' }, '第二次导入不应改写已有数据');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('冲突不默认覆盖：merge 无决策 → 跳过；keepCurrent/useImported 决策生效', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-conflict-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const adapters = [new MockSettingsAdapter()];
    const zipPath = path.join(tmp, 'x.zip');
    await new Exporter({ ctx: src, adapters, now: () => new Date() }).export({ includeSecrets: false, outPath: zipPath });

    // 目标已有不同值
    const dst = makeContext('linux', '/home/bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    // merge + 无决策 → Conflict 保留 → 执行跳过，不覆盖
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const conflict = plan.items.find((i) => i.id === 'settings:general');
    assert.equal(conflict?.kind, 'Conflict');
    const r1 = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.ok(r1.executed.find((e) => e.itemId === 'settings:general')?.status === 'skipped');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', '冲突未解决时不得覆盖');

    // keepCurrent → Skip
    const planKeep = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: { 'settings:general': 'keepCurrent' }, pathMappings: [] });
    assert.equal(planKeep.items.find((i) => i.id === 'settings:general')?.kind, 'Skip');
    const r2 = await importer.executeImportPlan(zipPath, planKeep, { confirm: true });
    assert.ok(r2.executed.every((e) => e.status === 'skipped'));

    // useImported → Update 覆盖
    const planUse = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: { 'settings:general': 'useImported' }, pathMappings: [] });
    assert.equal(planUse.items.find((i) => i.id === 'settings:general')?.kind, 'Update');
    const r3 = await importer.executeImportPlan(zipPath, planUse, { confirm: true });
    assert.ok(r3.executed.find((e) => e.itemId === 'settings:general')?.status === 'ok');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'dark', 'useImported 应覆盖');

    // skipExisting 全局策略 → Conflict 自动 Skip
    const planSkip = await importer.createImportPlan(zipPath, { strategy: 'skipExisting', resolutions: {}, pathMappings: [] });
    assert.equal(planSkip.items.find((i) => i.id === 'settings:general')?.kind, 'Skip');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('整体回滚：applyItem 中途失败 + rollbackOnError → 目标恢复导入前状态', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    src.settings.ns.set('llm-deepseek', { value: { model: 'deepseek-chat' }, revision: 2, secrets: [] });
    const settingsAdapter = new MockSettingsAdapter();
    const adapters: ConfigAdapter[] = [settingsAdapter, new MockSkillsAdapter()];
    const zipPath = path.join(tmp, 'x.zip');
    await new Exporter({ ctx: src, adapters, now: () => new Date() }).export({ includeSecrets: false, outPath: zipPath });

    // 目标初始：general=light（将被覆盖），llm-deepseek 不存在（将被创建）
    const dst = makeContext('linux', '/home/bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace', // 覆盖目标
      resolutions: {},
      pathMappings: [],
    });
    settingsAdapter.failNext = true; // 第一次 applyItem 抛错 → general 失败
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: true });

    assert.equal(result.ok, false);
    assert.ok(result.rollback, '失败应有回滚报告');
    assert.equal(result.rollback.full, true, '快照覆盖目标应能完整回滚');
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', '回滚后 general 应恢复 light');
    assert.ok(!dst.settings.ns.has('llm-deepseek'), '回滚后 llm-deepseek 应不存在');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('完整性：篡改 ZIP 内容后 checksum 校验拒绝', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-integrity-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const adapters = [new MockSettingsAdapter()];
    const zipPath = path.join(tmp, 'x.zip');
    await new Exporter({ ctx: src, adapters, now: () => new Date() }).export({ includeSecrets: false, outPath: zipPath });

    // 解包 → 篡改 config/settings.json → 原样重打包（checksums.json 不变）
    const archive = parseZip(await fs.readFile(zipPath));
    const entries: ZipWriteEntry[] = [];
    for (const name of archive.names()) {
      if (name === 'config/settings.json') {
        const data = JSON.parse(archive.readEntryText(name));
        data.namespaces.general.value.theme = 'HACKED';
        entries.push({ name, data: Buffer.from(JSON.stringify(data, null, 2)) });
      } else {
        entries.push({ name, data: archive.readEntry(name) });
      }
    }
    const tampered = path.join(tmp, 'tampered.zip');
    await fs.writeFile(tampered, zipToBuffer(entries));

    const importer = new Importer({ ctx: makeContext('linux', '/home/bob'), adapters, snapshotStore: new MemSnapshotStore() });
    await assert.rejects(() => importer.analyzeImport(tampered), /完整性校验失败/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('版本：过新 schema 拒绝导入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-version-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const adapters = [new MockSettingsAdapter()];
    const zipPath = path.join(tmp, 'x.zip');
    await new Exporter({ ctx: src, adapters, now: () => new Date() }).export({ includeSecrets: false, outPath: zipPath });

    // 篡改 manifest.schemaVersion → 999
    const archive = parseZip(await fs.readFile(zipPath));
    const entries: ZipWriteEntry[] = [];
    for (const name of archive.names()) {
      if (name === 'manifest.json') {
        const m = JSON.parse(archive.readEntryText(name));
        m.schemaVersion = 999;
        entries.push({ name, data: Buffer.from(JSON.stringify(m, null, 2)) });
      } else {
        entries.push({ name, data: archive.readEntry(name) });
      }
    }
    const v999 = path.join(tmp, 'v999.zip');
    await fs.writeFile(v999, zipToBuffer(entries));

    const importer = new Importer({ ctx: makeContext('linux', '/home/bob'), adapters, snapshotStore: new MemSnapshotStore() });
    await assert.rejects(() => importer.analyzeImport(v999), /无法导入/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('兼容性评分规则', () => {
  assert.equal(computeCompatibility({ sourceDsh: '0.1.0-rc.6', targetDsh: '0.1.0-rc.6', sourcePlatform: 'win32', targetPlatform: 'win32', schemaVersion: 1, missingSections: [] }), 'excellent');
  assert.equal(computeCompatibility({ sourceDsh: '0.1.0-rc.4', targetDsh: '0.1.0-rc.6', sourcePlatform: 'win32', targetPlatform: 'win32', schemaVersion: 1, missingSections: [] }), 'good');
  assert.equal(computeCompatibility({ sourceDsh: '0.1.0-rc.6', targetDsh: '0.1.0-rc.6', sourcePlatform: 'win32', targetPlatform: 'darwin', schemaVersion: 1, missingSections: [] }), 'partial');
  assert.equal(computeCompatibility({ sourceDsh: '0.1.0-rc.6', targetDsh: '0.1.0-rc.6', sourcePlatform: 'win32', targetPlatform: 'win32', schemaVersion: 999, missingSections: [] }), 'unsupported');
});

test('包含秘密导出：无加密提供者时拒绝（绝不明文泄密）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sec-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    const exporter = new Exporter({ ctx: src, adapters: makeAdapters(), now: () => new Date() });
    await assert.rejects(
      () => exporter.export({ includeSecrets: true, outPath: path.join(tmp, 'x.zip') }),
      /EncryptionProvider/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
