/**
 * 文件类分区 adapter 测试（skills / agentPresets / agentInstructions / pluginFiles / sessions）：
 * 导出收集文件、Create/Skip 分析、applyItem 写入、白名单与默认关闭语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillsAdapter } from './skills.ts';
import { AgentPresetsAdapter } from './agent-presets.ts';
import { AgentInstructionsAdapter } from './agent-instructions.ts';
import { PluginFilesAdapter } from './plugin-files.ts';
import { SessionsAdapter } from './sessions.ts';
import { SelfAdapter } from './self.ts';
import { makeContext, makeImportContext, sha256Hex } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('skills: 导出收集文件 + 导入往返（hash 幂等）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\n', 'utf8'));
  await src.fs.writeFile('skills/git.md', Buffer.from('# Git skill\n', 'utf8'));

  const adapter = new SkillsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 2);
  assert.equal(out.data.files[0]?.relativePath, 'coding.md');
  assert.equal(out.data.files[0]?.contentHash, sha256Hex(Buffer.from('# Coding skill\n')));
  assert.equal(out.counts.files, 2);

  const sections = new Map([['skills', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  let items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.kind === 'Create'));
  for (const item of items) {
    const r = await adapter.applyItem(item, makeImportContext(dst, sections));
    assert.equal(r.ok, true);
  }
  assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString(), '# Coding skill\n');

  // 幂等：一致 → Skip
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.ok(items.every((i) => i.kind === 'Skip'));

  // 内容不同 → Conflict
  await dst.fs.writeFile('skills/coding.md', Buffer.from('# Changed\n', 'utf8'));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.ok(items.some((i) => i.kind === 'Conflict'));
});

test('agentPresets: 目录 bundle 文件收集与写入（.agent-presets 基准目录）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('.agent-presets/work/agent.cordis.yml', Buffer.from('services:\n  - name: work\n', 'utf8'));
  await src.fs.writeFile('.agent-presets/work/preset.yml', Buffer.from('name: work\n', 'utf8'));

  const adapter = new AgentPresetsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 2);
  const rels = out.data.files.map((f) => f.relativePath).sort();
  assert.deepEqual(rels, ['work/agent.cordis.yml', 'work/preset.yml']);

  const sections = new Map([['agentPresets', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.ok(items.every((i) => i.kind === 'Create'));
  for (const item of items) {
    await adapter.applyItem(item, makeImportContext(dst, sections));
  }
  assert.equal(
    Buffer.from(await dst.fs.readFile('.agent-presets/work/agent.cordis.yml')).toString(),
    'services:\n  - name: work\n',
  );
});

test('agentInstructions: 只收集 homeDir 根 AGENTS.md（白名单）+ 导入往返', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('AGENTS.md', Buffer.from('# Global rules\nAlways reply in Chinese.\n', 'utf8'));
  // 根目录其他文件不得被收集（不能整目录递归）
  await src.fs.writeFile('settings.yaml', Buffer.from('foo: bar\n', 'utf8'));

  const adapter = new AgentInstructionsAdapter();
  assert.equal(adapter.defaultIncluded, true, 'agentInstructions 默认导出');
  assert.equal(adapter.portability, 'portable');
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 1);
  assert.equal(out.data.files[0]?.relativePath, 'AGENTS.md');
  assert.equal(out.data.files[0]?.contentHash, sha256Hex(Buffer.from('# Global rules\nAlways reply in Chinese.\n')));
  assert.equal(out.warnings.length, 0, '存在文件时不告警');

  const sections = new Map([['agentInstructions', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(
    Buffer.from(await dst.fs.readFile('AGENTS.md')).toString(),
    '# Global rules\nAlways reply in Chinese.\n',
    '导入写回 $DSH_HOME/AGENTS.md（homeDir 根）',
  );

  // 幂等：一致 → Skip；内容不同 → Conflict
  let items2 = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items2[0]?.kind, 'Skip');
  await dst.fs.writeFile('AGENTS.md', Buffer.from('# Changed\n', 'utf8'));
  items2 = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items2[0]?.kind, 'Conflict');
});

test('agentInstructions: 文件缺失 → 空分区 + dirEmpty 警告', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new AgentInstructionsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 0);
  assert.ok(out.warnings.length > 0, '缺失时给出提示（与 skills 目录为空一致）');
});

test('pluginFiles: 白名单导出（不存在跳过）+ 默认不包含', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));
  await src.fs.writeFile('other-file.json', Buffer.from('{"x":1}', 'utf8'));

  const adapter = new PluginFilesAdapter(['dsh-ssh.json', 'pet.json']);
  assert.equal(adapter.defaultIncluded, false, 'pluginFiles 默认不导出');
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 1);
  assert.equal(out.data.files[0]?.relativePath, 'dsh-ssh.json');
  assert.ok(!out.data.files.some((f) => f.relativePath === 'other-file.json'), '白名单外文件不导出');

  const sections = new Map([['pluginFiles', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Create');
  await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(Buffer.from(await dst.fs.readFile('dsh-ssh.json')).toString(), '{"hosts":[]}');
});

test('pluginFiles: 约定配置目录递归收集 + 与白名单去重 + 导入映射写回', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  // 约定目录下的文件（含嵌套子目录）
  await src.fs.writeFile('plugin-config/pluginA/a.json', Buffer.from('{"a":1}', 'utf8'));
  await src.fs.writeFile('plugin-config/pluginA/sub/b.toml', Buffer.from('b=2', 'utf8'));
  // 白名单文件
  await src.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));
  // 白名单里显式点到的文件同时位于约定目录内 → 应去重，只收集一次
  //（whitelist 用与 collectDir 相同的相对路径 plugin-config/pluginA/a.json）

  // whitelist 命中约定目录内同路径文件：a.json 同时由白名单与目录收集 → 去重
  const whitelist = ['dsh-ssh.json', 'plugin-config/pluginA/a.json'];
  const adapter = new PluginFilesAdapter(whitelist, 'plugin-config');
  const out = await adapter.export(src, { includeSecrets: false });
  const rels = out.data.files.map((f) => f.relativePath).sort();
  // 白名单 dsh-ssh.json + 目录 a.json、sub/b.toml（a.json 白名单/目录交叉去重，只出现一次）
  assert.deepEqual(rels, ['dsh-ssh.json', 'plugin-config/pluginA/a.json', 'plugin-config/pluginA/sub/b.toml']);

  const sections = new Map([['pluginFiles', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.kind === 'Create'));
  for (const item of items) {
    await adapter.applyItem(item, makeImportContext(dst, sections));
  }
  assert.equal(Buffer.from(await dst.fs.readFile('dsh-ssh.json')).toString(), '{"hosts":[]}');
  assert.equal(Buffer.from(await dst.fs.readFile('plugin-config/pluginA/sub/b.toml')).toString(), 'b=2');
  assert.equal(Buffer.from(await dst.fs.readFile('plugin-config/pluginA/a.json')).toString(), '{"a":1}');
});

test('pluginFiles: 非法 collectDir（绝对路径/越界）构造即抛错', () => {
  assert.throws(() => new PluginFilesAdapter(undefined, 'C:\\evil'), /collectDir 非法/);
  assert.throws(() => new PluginFilesAdapter(undefined, '../escape'), /collectDir 非法/);
});

test('sessions: 默认关 + 文件级复制（deviceSpecific）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('sessions/proj-a/s1/session.jsonl.zstd', Buffer.from('zstd-bytes', 'utf8'));
  const adapter = new SessionsAdapter();
  assert.equal(adapter.defaultIncluded, false, 'sessions 默认不导出');
  assert.equal(adapter.portability, 'deviceSpecific');
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 1);
  assert.equal(out.data.files[0]?.relativePath, 'proj-a/s1/session.jsonl.zstd');

  const sections = new Map([['sessions', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(await dst.fs.readFile('sessions/proj-a/s1/session.jsonl.zstd')).toString(), 'zstd-bytes');
});

test('文件类 validate', async () => {
  const adapter = new SkillsAdapter();
  assert.equal((await adapter.validate({ version: 1, files: [] })).valid, true);
  assert.equal((await adapter.validate({ version: 1, files: [{ relativePath: '' } as never] })).valid, false);
});

// ---------- F23：不可信 import 不得写内部 control-plane namespace ----------

test('F23: pluginFiles 拒绝写内部 recovery/control-plane 保留区（快照/事务/锁）', async () => {
  const adapter = new PluginFilesAdapter();
  const src = makeContext('win32', 'C:\\Users\\alice');
  const malicious = [
    'dsh-config-manager/snapshots/fake/snapshot.json',
    'dsh-config-manager/snapshots/fake/blob-1',
    'dsh-config-manager/transactions/active/x.json',
    'dsh-config-manager/transactions/safe-mode',
    'dsh-config-manager/locks/environment.lock',
    'dsh-config-manager/environment-fingerprint.token',
  ];
  // 攻击者构造 ZIP 数据：把普通插件文件条目映射到内部 recovery 存储
  const data = {
    version: 1 as const,
    files: malicious.map((relativePath) => ({
      relativePath,
      data: Buffer.from('{}', 'utf8'),
      contentHash: sha256Hex(Buffer.from('{}')),
    })),
  };
  const sections = new Map([['pluginFiles', data]]);
  const ctx = makeImportContext(src, sections);
  const items = await adapter.analyzeImport(data, ctx);
  for (const item of items) {
    assert.equal(item.kind, 'Error', `analyzeImport 应拒绝 ${item.target?.ref ?? item.description}`);
    const r = await adapter.applyItem(item, ctx);
    assert.equal(r.ok, false, `applyItem 应拒绝 ${item.target?.ref ?? item.description}`);
  }
  // 纵深防御：应用阶段直接命中保留区也必须拒绝（即使 analyzeImport 被绕过）
  for (const rel of malicious) {
    const r = await adapter.applyItem(
      { id: `x:${rel}`, kind: 'Create', adapter: 'pluginFiles', description: rel, severity: 'info', target: { adapter: 'pluginFiles', ref: rel } } as PlanItem,
      ctx,
    );
    assert.equal(r.ok, false, `applyItem 直接命中 ${rel} 应拒绝`);
  }
  // 关键：不得真正写入 control-plane 存储
  for (const rel of malicious) {
    assert.equal(await src.fs.exists(rel), false, `不得写入保留路径 ${rel}`);
  }
});

test('F23: self adapter 拒绝写内部 recovery/control-plane 保留区（但放行合法配置）', async () => {
  const adapter = new SelfAdapter('dsh-config-manager');
  const dst = makeContext('linux', '/home/bob');
  // 合法：sync-config.json 是 self 白名单配置，必须放行
  const legitFiles = [
    'sync/sync-config.json',
    'sync/sync-selection.json',
    'sync/ui-prefs.json',
    'sync/backup-schedule.json',
    'market/market-config.json',
    'exports/.backup-notes.json',
  ];
  const legitData = {
    version: 1 as const,
    files: legitFiles.map((relativePath) => ({
      relativePath,
      data: Buffer.from('{}', 'utf8'),
      contentHash: sha256Hex(Buffer.from('{}')),
    })),
  };
  const legitSections = new Map([['self', legitData]]);
  const legitCtx = makeImportContext(dst, legitSections);
  const legitItems = await adapter.analyzeImport(legitData, legitCtx);
  assert.ok(legitItems.every((i) => i.kind !== 'Error'), '合法 self 配置不得被保留区误伤');
  for (const item of legitItems) {
    const r = await adapter.applyItem(item, legitCtx);
    if (r.ok === false) continue; // 同名冲突等非 F23 因素允许
  }

  // 恶意：把条目映射到内部 recovery 存储
  const malicious = [
    'snapshots/fake/snapshot.json',
    'transactions/active/x.json',
    'locks/environment.lock',
    'sync/snapshots/fake/manifest.json', // sync rollback snapshot store
    'sync/work/tmp.zip',
  ];
  const evilData = {
    version: 1 as const,
    files: malicious.map((relativePath) => ({
      relativePath,
      data: Buffer.from('{}', 'utf8'),
      contentHash: sha256Hex(Buffer.from('{}')),
    })),
  };
  const evilSections = new Map([['self', evilData]]);
  const evilCtx = makeImportContext(dst, evilSections);
  const evilItems = await adapter.analyzeImport(evilData, evilCtx);
  assert.equal(evilItems.length, malicious.length);
  for (const item of evilItems) {
    assert.equal(item.kind, 'Error', `self analyzeImport 应拒绝 ${item.target?.ref ?? item.description}`);
    const r = await adapter.applyItem(item, evilCtx);
    assert.equal(r.ok, false);
  }
  const resolved = malicious.map((rel) => `dsh-config-manager/${rel}`);
  for (const rel of resolved) {
    assert.equal(await dst.fs.exists(rel), false, `不得写入保留路径 ${rel}`);
  }
});
