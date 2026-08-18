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
