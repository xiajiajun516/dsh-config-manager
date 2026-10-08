/**
 * 文件类分区 adapter 测试（skills / agentPresets / agentInstructions / pluginFiles / sessions）：
 * 导出收集文件、Create/Skip 分析、applyItem 写入、白名单与默认关闭语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
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

test('issue #71: skills 合并技能服务（外壳技能不在 $DSH_HOME/skills 里）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  // 真机形态：$DSH_HOME/skills 不存在，技能全在服务里（profile 插件包 / customSkillDirs / 内置目录）
  src.skills = {
    list: async () => [
      { name: 'reverse-skill', description: '逆向工程技能', whenToUse: '分析二进制时', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'browser-skill', description: '浏览器操作' },
    ],
    // 真机上 get() 返回的是完整定义（元数据与 list() 的摘要同源，外加 content）
    get: async (name) => ({
      name,
      description: name === 'reverse-skill' ? '逆向工程技能' : '浏览器操作',
      whenToUse: name === 'reverse-skill' ? '分析二进制时' : undefined,
      content: `# ${name} body\n`,
    }),
  };
  const adapter = new SkillsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.deepEqual(
    out.data.files.map((f) => f.relativePath).sort(),
    ['browser-skill/SKILL.md', 'reverse-skill/SKILL.md'],
    '服务技能必须映射成 <name>/SKILL.md 虚拟路径进备份',
  );
  const text = Buffer.from(out.data.files.find((f) => f.relativePath === 'reverse-skill/SKILL.md')!.data).toString();
  assert.ok(text.startsWith("---\nname: 'reverse-skill'\n"), `frontmatter 头不对: ${text.slice(0, 60)}`);
  assert.ok(text.includes("description: '逆向工程技能'"));
  assert.ok(text.includes("whenToUse: '分析二进制时'"));
  assert.ok(text.includes('\n---\n\n# reverse-skill body\n'), '正文必须原样保留');
  assert.equal(out.data.files[0]?.contentHash, sha256Hex(out.data.files[0]!.data), 'content 模式必须带哈希');

  // 单元 id = 技能名（选择器上「一个技能一个勾选项」）
  const units = adapter.listUnits(out);
  assert.deepEqual(units.map((u) => u.id).sort(), ['skills:browser-skill', 'skills:reverse-skill']);

  // 预览与导出的体积口径一致（size 模式走同一条重建逻辑）
  const previewed = await adapter.preview(src, { includeSecrets: false });
  const previewUnit = previewed.items.find((u) => u.id === 'skills:reverse-skill');
  assert.equal(previewUnit?.sizeBytes, Buffer.from(out.data.files.find((f) => f.relativePath === 'reverse-skill/SKILL.md')!.data).byteLength);

  // 导入往返：Create → 写到目标机的 skills/<name>/SKILL.md
  const sections = new Map([['skills', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.ok(items.every((i) => i.kind === 'Create'));
  for (const item of items) assert.equal((await adapter.applyItem(item, makeImportContext(dst, sections))).ok, true);
  assert.ok(Buffer.from(await dst.fs.readFile('skills/reverse-skill/SKILL.md')).toString().includes('name: \'reverse-skill\''));
});

test('issue #71: 技能服务与磁盘同路径 → 磁盘原文优先；调用策略只写 DSH 认的键', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('skills/reverse-skill/SKILL.md', Buffer.from('---\nname: \'reverse-skill\'\ndescription: \'disk\'\n---\n\ndisk body\n', 'utf8'));
  src.skills = {
    list: async () => [{ name: 'reverse-skill', description: 'service' }],
    get: async (name) => ({ name, description: 'service', content: 'service body', invocation: { modelInvocable: false, userInvocable: false } }),
  };
  const out = await new SkillsAdapter().export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 1);
  assert.equal(out.data.files[0]?.relativePath, 'reverse-skill/SKILL.md');
  assert.ok(Buffer.from(out.data.files[0]!.data).toString().includes('disk body'), '磁盘原文是事实源，服务不得覆盖它');

  // 服务独有的技能：调用策略必须写成 disable-model-invocation / user-invocable（legacy 键会被 DSH 拒绝）
  const only = makeContext('win32', 'C:\\Users\\alice');
  only.skills = {
    list: async () => [{ name: 'hidden', description: 'd' }],
    get: async (name) => ({ name, description: 'd', content: 'body', invocation: { modelInvocable: false, userInvocable: false } }),
  };
  const out2 = await new SkillsAdapter().export(only, { includeSecrets: false });
  const text = Buffer.from(out2.data.files[0]!.data).toString();
  assert.ok(text.includes('disable-model-invocation: true'), text);
  assert.ok(text.includes('user-invocable: false'), text);
  assert.ok(!text.includes('modelInvocable'), 'legacy 键会让 DSH 忽略整个技能');
});

test('issue #71: 技能服务缺失/抛错不影响目录扫描，也不编造告警', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
  // ① 宿主没提供技能服务（旧宿主）→ 纯目录扫描，行为与改造前一致
  const plain = await new SkillsAdapter().export(src, { includeSecrets: false });
  assert.deepEqual(plain.data.files.map((f) => f.relativePath), ['coding.md']);
  assert.deepEqual(plain.warnings, []);

  // ② 服务列举抛错 → 如实告警到日志，备份不因此失败（技能分区仍带目录内容）
  const broken = makeContext('win32', 'C:\\Users\\alice');
  await broken.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
  const warned: string[] = [];
  broken.log.warn = (m: unknown) => { warned.push(String(m)); };
  broken.skills = { list: async () => { throw new Error('registry down'); }, get: async () => undefined };
  const out = await new SkillsAdapter().export(broken, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath), ['coding.md']);
  assert.equal(warned.some((w) => w.includes('registry down')), true, `服务失败必须留痕: ${warned.join(' | ')}`);

  // ③ 单个技能 get 失败/返回 undefined → 跳过该技能，其余照常
  const partial = makeContext('win32', 'C:\\Users\\alice');
  partial.skills = {
    list: async () => [{ name: 'good', description: 'd' }, { name: 'bad', description: 'd' }, { name: 'weird', description: 'd' }],
    get: async (name) => {
      if (name === 'bad') throw new Error('broken provider');
      if (name === 'weird') return undefined;
      return { name, description: 'd', content: 'body' };
    },
  };
  const out3 = await new SkillsAdapter().export(partial, { includeSecrets: false });
  assert.deepEqual(out3.data.files.map((f) => f.relativePath), ['good/SKILL.md']);
});

test('issue #71: 技能服务里的非法技能名不得逃出 skills/ 目录（路径安全）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.skills = {
    list: async () => [{ name: '../escape', description: 'd' }, { name: 'a/b', description: 'd' }, { name: 'ok', description: 'd' }],
    get: async (name) => ({ name, description: 'd', content: 'body' }),
  };
  const out = await new SkillsAdapter().export(src, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath), ['ok/SKILL.md'], '越界技能名一律跳过');
});

test('issue #71: 多行技能字段必须编码成合法 YAML（真机 binary-diff 形态）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  // 真机 dsh-reverse-skill 的 binary-diff：description 是块标量，解析后含换行（211 字符 / 5 行）
  const description = '跨版本符号迁移与二进制差分。\n适用场景：内核缺 PDB 用旧版符号推导。\n核心方法：用 LLM 做结构化差异比对。\n';
  const whenToUse = '旧版本符号迁移到新版本时\n内核缺 PDB 时\n';
  src.skills = {
    list: async () => [{ name: 'binary-diff', description }],
    get: async (name) => ({ name, description, whenToUse, content: '# body\n' }),
  };
  const out = await new SkillsAdapter().export(src, { includeSecrets: false });
  const text = Buffer.from(out.data.files[0]!.data).toString();
  // 回归点：单引号标量一旦跨行，js-yaml 抛「deficient indentation」→ 外壳判 invalid YAML frontmatter
  // 并**丢掉整个技能**（比不备份更糟）。这里用 js-yaml 逐字符验证编码结果。
  const frontmatter = text.slice(text.indexOf('\n') + 1, text.indexOf('\n---\n', 4));
  const parsed = yaml.load(frontmatter) as Record<string, string>;
  assert.equal(parsed.name, 'binary-diff');
  assert.equal(parsed.description, description, '多行 description 必须逐字符还原');
  assert.equal(parsed.whenToUse, whenToUse, '多行 whenToUse 必须逐字符还原');
  assert.ok(text.includes('description: |'), `多行值应写成块标量: ${text.slice(0, 80)}`);

  // 单行值仍是单引号（与改造前逐字节一致，老包/老快照的 diff 不会平白变大）
  const plain = makeContext('win32', 'C:\\Users\\alice');
  plain.skills = {
    list: async () => [{ name: 'plain', description: "it's fine" }],
    get: async (name) => ({ name, description: "it's fine", content: 'body' }),
  };
  const plainOut = await new SkillsAdapter().export(plain, { includeSecrets: false });
  const plainText = Buffer.from(plainOut.data.files[0]!.data).toString();
  assert.ok(plainText.includes("description: 'it''s fine'"), plainText);
  assert.equal((yaml.load(plainText.slice(4, plainText.indexOf('\n---\n', 4))) as Record<string, string>).description, "it's fine");

  // 回车 / 控制字符（YAML 里不能出现在块标量或单引号标量中）→ 双引号 + 转义，仍逐字符还原
  const weird = makeContext('win32', 'C:\\Users\\alice');
  const weirdValue = 'a\rb\tc\u0001d';
  weird.skills = {
    list: async () => [{ name: 'weird', description: weirdValue }],
    get: async (name) => ({ name, description: weirdValue, content: 'body' }),
  };
  const weirdOut = await new SkillsAdapter().export(weird, { includeSecrets: false });
  const weirdText = Buffer.from(weirdOut.data.files[0]!.data).toString();
  assert.ok(weirdText.includes('description: "a\\rb\\tc\\x01d"'), weirdText);
  assert.equal((yaml.load(weirdText.slice(4, weirdText.indexOf('\n---\n', 4))) as Record<string, string>).description, weirdValue);
});

test('issue #37: skills 导出把「跟随/跳过的链接」写进 warnings（不再静默缺失）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
  // 链接目录下的真实内容（链接已跟随 → 内容确实可读）
  await src.fs.writeFile('skills/shared/inner.md', Buffer.from('# Shared\n', 'utf8'));
  // 宿主实现 listRecursiveDetailed（真实 FileSystemFacade 的形态）：链接内容已收集，且带诊断
  src.fs.listRecursiveDetailed = async () => ({
    paths: ['skills/coding.md', 'skills/shared/inner.md'],
    skippedLinks: [{ path: 'skills/broken', reason: 'broken' }],
    skippedDepDirs: [],
    followedLinks: 1,
    unreadableDirs: [],
  });
  const out = await new SkillsAdapter().export(src, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath).sort(), ['coding.md', 'shared/inner.md']);
  assert.equal(out.warnings.some((w) => w.includes('链接目录')), true, `缺「已跟随链接」告警: ${out.warnings.join(' | ')}`);
  assert.equal(out.warnings.some((w) => w.includes('未进备份')), true, `缺「跳过链接」告警: ${out.warnings.join(' | ')}`);
  assert.equal(out.warnings.some((w) => w.includes('skills/broken')), true, '必须点名被跳过的链接');
});

test('issue #76: skills 导出跳过 node_modules 依赖目录，并在导出报告里说明（不静默）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('skills/md2pdf/SKILL.md', Buffer.from('# md2pdf\n', 'utf8'));
  await src.fs.writeFile('skills/md2pdf/package.json', Buffer.from('{"name":"md2pdf"}\n', 'utf8'));
  // 宿主枚举已按 issue #76 排除依赖树，并把它带回来（真实 walk 的形态）
  src.fs.listRecursiveDetailed = async () => ({
    paths: ['skills/md2pdf/SKILL.md', 'skills/md2pdf/package.json'],
    skippedLinks: [],
    skippedDepDirs: [{ path: 'skills/md2pdf/node_modules', files: 11625 }],
    followedLinks: 0,
    unreadableDirs: [],
  });

  const out = await new SkillsAdapter().export(src, { includeSecrets: false });
  assert.deepEqual(
    out.data.files.map((f) => f.relativePath).sort(),
    ['md2pdf/SKILL.md', 'md2pdf/package.json'],
    '依赖树不得进包，技能本体与 package.json 必须进',
  );
  const line = out.warnings.find((w) => w.includes('运行时依赖目录')) ?? '';
  assert.ok(line.length > 0, '缺依赖目录告警: ' + out.warnings.join(' | '));
  assert.match(line, /11625 个文件/);
  assert.match(line, /未进备份/);
  assert.doesNotMatch(line, /链接/, '依赖目录不是链接问题，措辞不得混淆');
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

test('F23: pluginFiles 拒绝 `..` 路径穿越变体写入保留区（Reviewer B P0）', async () => {
  const adapter = new PluginFilesAdapter();
  const dst = makeContext('linux', '/home/bob');
  // 宿主 fs 会 resolve/join 折叠 `..` → 这些路径落到保留区，必须在 adapter 层拒绝
  const malicious = [
    'dsh-config-manager/../dsh-config-manager/snapshots/fake/snapshot.json',
    'dsh-config-manager/../dsh-config-manager/transactions/active/x.json',
    'x/../../dsh-config-manager/locks/environment.lock',
    'dsh-config-manager/./snapshots/fake/blob-1',
  ];
  const data = {
    version: 1 as const,
    files: malicious.map((relativePath) => ({
      relativePath,
      data: Buffer.from('{}', 'utf8'),
      contentHash: sha256Hex(Buffer.from('{}')),
    })),
  };
  const ctx = makeImportContext(dst, new Map([['pluginFiles', data]]));
  const items = await adapter.analyzeImport(data, ctx);
  for (const item of items) {
    assert.equal(item.kind, 'Error', `analyzeImport 应拒绝 ${item.target?.ref ?? item.description}`);
    const r = await adapter.applyItem(item, ctx);
    assert.equal(r.ok, false);
  }
  // 纵深防御：apply 阶段直接命中也必须拒绝
  for (const rel of malicious) {
    const r = await adapter.applyItem(
      { id: `x:${rel}`, kind: 'Create', adapter: 'pluginFiles', description: rel, severity: 'info', target: { adapter: 'pluginFiles', ref: rel } } as PlanItem,
      ctx,
    );
    assert.equal(r.ok, false, `applyItem 拒绝 .. 变体 ${rel}`);
  }
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

/* ---------------- ui-F2 / ui-F5 / ui-F3（t23 回归） ---------------- */

test('ui-F2：白名单文件「存在但读不到」必须显式失败，绝不静默丢内容', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));
  const realRead = src.fs.readFile.bind(src.fs);
  src.fs.readFile = async (p: string) => {
    if (String(p).endsWith('dsh-ssh.json')) {
      const e = new Error('EACCES: permission denied, open dsh-ssh.json');
      (e as { code?: string }).code = 'EACCES';
      throw e;
    }
    return realRead(p);
  };
  const adapter = new PluginFilesAdapter(['dsh-ssh.json']);
  // base：export 静默成功且该文件凭空消失（warnings 为空）→ 本断言在 base 上失败
  await assert.rejects(() => adapter.export(src, { includeSecrets: false }), /EACCES/);
});

test('ui-F2：约定配置目录里「存在但读不到」的文件同样必须显式失败', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('plugin-config/locked.json', Buffer.from('{}', 'utf8'));
  const realRead = src.fs.readFile.bind(src.fs);
  src.fs.readFile = async (p: string) => {
    if (String(p).endsWith('locked.json')) {
      const e = new Error('EACCES: permission denied, open plugin-config/locked.json');
      (e as { code?: string }).code = 'EACCES';
      throw e;
    }
    return realRead(p);
  };
  const adapter = new PluginFilesAdapter([], 'plugin-config');
  await assert.rejects(() => adapter.export(src, { includeSecrets: false }), /EACCES/);
});

test('ui-F5：技能名等于 baseDir（skills）时，服务侧虚拟路径不得被二次剥前缀', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.skills = {
    async list() {
      return [{ name: 'skills', description: '外壳技能' }];
    },
    async get(name: string) {
      return { name, description: name, content: 'body of ' + name };
    },
  };
  const adapter = new SkillsAdapter();
  // base：虚拟路径 skills/SKILL.md 被 relPathOf 二次剥成 SKILL.md → 回落磁盘读 → ENOENT（整分区失败）
  const preview = await adapter.preview(src, { includeSecrets: false });
  assert.deepEqual(preview.items?.map((u) => u.id), ['skills:skills']);
  const out = await adapter.export(src, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath), ['skills/SKILL.md']);
  assert.match(Buffer.from(out.data.files[0]!.data).toString(), /name: 'skills'/);
});

test('ui-F3：pluginFiles 的 files 条目级形状校验（validate 不得放过 null / 非字符串 relativePath）', async () => {
  const adapter = new PluginFilesAdapter();
  assert.equal((await adapter.validate({ version: 1, files: [] })).valid, true);
  assert.equal(((await adapter.validate({ version: 1, files: [null] } as never)).valid), false);
  assert.equal((await adapter.validate({ version: 1, files: [{ relativePath: 42 }] } as never)).valid, false);
  assert.equal((await adapter.validate({ version: 1, files: [{ relativePath: '' }] } as never)).valid, false);
});
