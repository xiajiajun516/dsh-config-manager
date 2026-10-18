/**
 * 外部 agent 导入（v1 / Claude Code）的回归护栏。
 *
 * 三层各测一层：
 *  ① 纯翻译（映射口径、路径安全、frontmatter 判定）
 *  ② 凭据不变量（结果对象与**整份 ZIP 字节**里都不得出现凭据明文）
 *  ③ 端到端（转换产物是合法 bundle v1，既有 Importer 能正常分析 —— 这条才证明「复用既有管道」成立）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import type { McpSection, SectionId } from '../schema/types.ts';
import { Importer } from '../core/importer.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode, frontmatterProblem, splitFrontmatter, stripUserInfo } from './claude-code.ts';

const NL = String.fromCharCode(10);
const enc = new TextEncoder();

const NL2 = String.fromCharCode(10);
const CC_ID = '22222222-2222-4222-8222-222222222222';
const CC_CWD = 'D:/proj/cc';
function ccSession(): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'bbbbbbbb-0000-4000-8000-000000000001', timestamp: '2026-10-02T09:00:00.000Z', cwd: CC_CWD, message: { role: 'user', content: '导入一条对话' } }),
    JSON.stringify({ type: 'assistant', uuid: 'bbbbbbbb-0000-4000-8000-000000000002', timestamp: '2026-10-02T09:00:03.000Z', cwd: CC_CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: '好的' }] } }),
  ].join(NL2) + NL2;
}


function skillMd(name: string, description: string, body = '# body'): Uint8Array {
  return enc.encode(['---', 'name: ' + name, 'description: ' + description, '---', '', body].join(NL));
}

function frontmatterOnly(line: string): Uint8Array {
  return enc.encode(['---', line, '---', '', 'body'].join(NL));
}

function claudeJsonWith(servers: Record<string, unknown>): unknown {
  return { mcpServers: servers };
}

test('t0 frontmatter 切分与 URL userinfo 剥离的边界', () => {
  const fm = splitFrontmatter(['---', 'name: a', '---', 'body'].join(NL));
  assert.equal(fm?.raw, 'name: a');
  assert.equal(splitFrontmatter('no frontmatter'), null);
  assert.equal(frontmatterProblem('no frontmatter'), 'no-frontmatter');
  assert.equal(frontmatterProblem(['---', 'description: x', '---', 'body'].join(NL)), 'no-name');
  assert.equal(frontmatterProblem(['---', 'name: a', '---', 'body'].join(NL)), 'no-description');
  assert.equal(frontmatterProblem(['---', 'name: a', 'description: ok', '---', 'body'].join(NL)), null);
  assert.deepEqual(stripUserInfo('https://u:p@h/mcp'), { url: 'https://h/mcp', stripped: true });
  assert.deepEqual(stripUserInfo('https://h/path@x'), { url: 'https://h/path@x', stripped: false });
  assert.deepEqual(stripUserInfo('npx'), { url: 'npx', stripped: false });
});

test('t1 MCP：stdio 与 url 两种形态按 extractMcpServers 同口径映射', () => {
  const result = convertClaudeCode({
    claudeJson: claudeJsonWith({
      gitnexus: { command: 'npx', args: ['-y', 'gitnexus'], cwd: '/repo' },
      remote: { url: 'https://mcp.example.com/mcp', headers: { 'X-Trace': 'on' }, type: 'sse' },
      empty: { note: 'no command' },
    }),
  });
  const mcp = result.sections.find((s) => s.sectionId === 'mcp');
  assert.ok(mcp, '应产出 mcp 分区');
  const section = mcp.data as McpSection;
  assert.equal(section.servers.length, 2, '既无 command 也无 url 的条目不带进包');

  const stdio = section.servers.find((s) => s.serverName === 'gitnexus');
  assert.equal(stdio?.type, 'stdio');
  assert.equal(stdio?.command, 'npx');
  assert.deepEqual(stdio?.args, ['-y', 'gitnexus']);
  assert.equal(stdio?.cwd, '/repo');
  // 刻意不写 sourceLineId：交给 adapter 的 newLineId(serverName) 兜底，避免撞上目标机既有行 id
  assert.equal(Object.prototype.hasOwnProperty.call(stdio ?? {}, 'sourceLineId'), false);

  const remote = section.servers.find((s) => s.serverName === 'remote');
  assert.equal(remote?.type, 'streamable-http');
  assert.equal(remote?.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(remote?.headers, { 'X-Trace': 'on' });

  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'remote'));
});

test('t2 凭据值绝不进包：env 与 URL userinfo 都被剥离，只留字段名与引用名', async () => {
  const SECRET = 'sk-ant-SUPERSECRET-TOKEN-1234567890';
  const result = convertClaudeCode({
    claudeJson: claudeJsonWith({
      svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: SECRET, PLAIN: 'ok' } },
      web: { url: 'https://user:pw@mcp.example.com/mcp' },
    }),
    settings: { env: { ANTHROPIC_AUTH_TOKEN: SECRET }, hooks: { PreToolUse: [] } },
  });

  assert.ok(!JSON.stringify(result).includes(SECRET), '结果对象里不得出现凭据明文');
  assert.ok(!JSON.stringify(result).includes('pw@'), 'URL userinfo 也必须剥离');

  const section = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  const svc = section.servers.find((s) => s.serverName === 'svc');
  assert.equal(svc?.env?.['GITHUB_TOKEN'], '', '命中凭据的字段值被剥离为空串，字段名保留');
  assert.equal(svc?.env?.['PLAIN'], 'ok');
  assert.equal(section.servers.find((s) => s.serverName === 'web')?.url, 'https://mcp.example.com/mcp');

  assert.ok(result.credentialRefs.includes('mcp:svc:GITHUB_TOKEN'));
  assert.ok(result.credentialRefs.includes('mcp:web:url'));
  assert.ok(result.credentialRefs.includes('settings.env:ANTHROPIC_AUTH_TOKEN'));
  assert.ok(result.skipped.some((s) => s.code === 'credentials-not-migrated'));
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-hooks'));
  // settings 本身**不产生**任何分区（env 是凭据、hooks 无对等结构）
  assert.ok(!result.sections.some((s) => s.sectionId === 'settings'));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-secret-'));
  try {
    const zipPath = path.join(tmp, 'b.zip');
    await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-test', dshVersion: '0.1.0' });
    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from(SECRET, 'utf8')), 'ZIP 字节里不得出现凭据明文');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t3 skill：非法 frontmatter 整体跳过并报码（DSH 会静默丢弃，所以这里必须报）', () => {
  // 这条 description 是本仓实测过的「静默杀手」：plain scalar 里出现冒号加空格
  const broken = frontmatterOnly('description: great DX: intuitive');
  const result = convertClaudeCode({
    skills: [
      {
        name: 'good',
        files: [
          { relativePath: 'SKILL.md', data: skillMd('good', 'ok') },
          { relativePath: 'ref.md', data: enc.encode('ref') },
        ],
      },
      { name: 'broken', files: [{ relativePath: 'SKILL.md', data: broken }] },
      { name: 'no-md', files: [{ relativePath: 'readme.md', data: enc.encode('x') }] },
      { name: 'bad/name', files: [{ relativePath: 'SKILL.md', data: skillMd('x', 'y') }] },
    ],
  });
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath).sort(), ['good/SKILL.md', 'good/ref.md']);
  assert.ok(result.skipped.some((s) => s.code === 'skill-invalid-frontmatter' && s.origin === 'broken'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-missing-file' && s.origin === 'no-md'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-invalid-name' && s.origin === 'bad/name'));
});

test('t4 端到端：产物是合法 v1 bundle，既有 Importer 能分析出来', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-e2e-'));
  try {
    const result = convertClaudeCode({
      claudeJson: claudeJsonWith({ svc: { command: 'npx', args: ['-y', 'svc'] } }),
      skills: [{ name: 'alpha', files: [{ relativePath: 'SKILL.md', data: skillMd('alpha', 'A skill') }] }],
      memory: '# 我的全局指令' + NL,
    });
    const zipPath = path.join(tmp, 'foreign.zip');
    const written = await writeForeignBundle({
      result,
      outPath: zipPath,
      exporterVersion: '0.0.0-test',
      dshVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      exportedAt: '2026-10-04T00:00:00.000Z',
    });
    assert.deepEqual([...written.sections].sort(), ['agentInstructions', 'mcp', 'skills']);
    assert.deepEqual([...written.entryNames].sort(), [
      'custom/agent-instructions/AGENTS.md',
      'custom/skills/alpha/SKILL.md',
      'mcp/servers.json',
    ]);

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters(), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '产物必须是合法 bundle：' + JSON.stringify(analysis.errors));
    for (const sid of ['mcp', 'skills', 'agentInstructions'] as SectionId[]) {
      assert.ok(analysis.sectionsInZip.includes(sid), '缺少分区 ' + sid);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 空来源不产出任何分区（不生成空载荷分区）', () => {
  const result = convertClaudeCode({});
  assert.deepEqual(result.sections, []);
  assert.deepEqual(result.credentialRefs, []);
});

test('t6 会话转码接入：sessions 与 workspaces 同时进包，既有 Importer 能分析', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-session-'));
  try {
    const result = convertClaudeCode({
      claudeJson: claudeJsonWith({ svc: { command: 'npx', args: ['-y', 'svc'] } }),
      sessions: [{ id: CC_ID, text: ccSession() }],
      targetSessionFormatVersion: 3,
    });
    assert.deepEqual([...result.sections.map((s) => s.sectionId)].sort(), ['mcp', 'sessions', 'workspaces']);
    const workspaces = result.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string; sessionIds: string[] }[] };
    assert.equal(workspaces.workspaces.length, 1);
    assert.equal(workspaces.workspaces[0]?.path, CC_CWD);
    assert.deepEqual(workspaces.workspaces[0]?.sessionIds, [CC_ID]);

    const zipPath = path.join(tmp, 'sessions.zip');
    const written = await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-test', dshVersion: '0.1.0' });
    assert.deepEqual([...written.sections].sort(), ['mcp', 'sessions', 'workspaces']);
    assert.ok(
      written.entryNames.includes('sessions/--D-proj-cc--/' + CC_ID + '/session.v3.jsonl.zstd'),
      '会话日志必须落在 sessions/<projectKey>/<id>/ 下：' + JSON.stringify(written.entryNames),
    );

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters({ includeSessions: true }), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '含会话的包必须合法：' + JSON.stringify(analysis.errors));
    assert.ok(analysis.sectionsInZip.includes('sessions'));
    assert.ok(analysis.sectionsInZip.includes('workspaces'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 未提供目标机会话格式版本时不转码任何会话（只报码，绝不猜版本）', () => {
  const result = convertClaudeCode({ sessions: [{ id: CC_ID, text: ccSession() }] });
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'));
  const skip = result.skipped.find((s) => s.code === 'session-format-version-unknown');
  assert.equal(skip?.count, 1);
});

test('t13 会话 findings 必须由翻译层带出到 skipped（接线回归：内核只读 skip/ignored，不读 findings）', () => {
  // 会话 id 仍以**文件名 stem**为准（DSH 按目录/文件名定位会话），但绝不静默：
  // TranscodeResult.findings 由 transcode 包装器并入顶层 skipped。
  const session = { id: CC_ID, text: ccSession(), recordSessionId: '99999999-9999-4999-8999-999999999999' };
  const result = convertClaudeCode({ sessions: [session], targetSessionFormatVersion: 3 });
  const found = result.skipped.find((s) => s.code === 'session-id-mismatch');
  assert.ok(found, '不一致必须报码：' + JSON.stringify(result.skipped));
  assert.equal(found.origin, CC_ID);

  const bytesOf = (r: typeof result): number[] => {
    const s = r.sections.find((x) => x.sectionId === 'sessions');
    return [...(s?.files?.[0]?.data ?? new Uint8Array())];
  };
  // 幂等：记录里没有时间戳、只靠确定性 createdAtMs 回落时，两次转码字节必须逐字相同
  // （否则 DSH 侧的「同内容 → Skip」永不成立，重复导入恒判 Conflict）
  const noTs = [JSON.stringify({ type: 'user', cwd: CC_CWD, message: { role: 'user', content: 'hi' } })].join(NL2) + NL2;
  const withFallback = { id: CC_ID, text: noTs, createdAtMs: 1750000000000 };
  const first = convertClaudeCode({ sessions: [withFallback], targetSessionFormatVersion: 3 });
  const second = convertClaudeCode({ sessions: [withFallback], targetSessionFormatVersion: 3 });
  assert.deepEqual(bytesOf(second), bytesOf(first), '同一输入（含确定性回落）的会话字节必须逐字相同');
  assert.ok(bytesOf(first).length > 0, '幂等断言必须真的比对了非空字节');
});

/* ---------------- t8..t12：项目级 / 插件 / 冲突 / 凭据 / 溯源（2026-10-18 补齐） ---------------- */

/** 取 agentInstructions 的正文（解码一次，避免每个断言重复写 decode） */
function instructionsText(result: { sections: readonly { sectionId: string; files?: readonly { data: Uint8Array }[] }[] }): string {
  const section = result.sections.find((s) => s.sectionId === 'agentInstructions');
  assert.ok(section !== undefined, '必须产出 agentInstructions 分区');
  const file = section.files?.[0];
  assert.ok(file !== undefined, 'agentInstructions 必须带一个文件');
  return new TextDecoder().decode(file.data);
}

/** 取 skills 分区的包内相对路径清单 */
function skillPathsOf(result: { sections: readonly { sectionId: string; files?: readonly { relativePath: string }[] }[] }): string[] {
  const section = result.sections.find((s) => s.sectionId === 'skills');
  if (section?.files === undefined) return [];
  return section.files.map((f) => f.relativePath);
}

/** 取 mcp 分区载荷 */
function mcpOf(result: { sections: readonly { sectionId: string; data?: unknown }[] }): McpSection {
  const section = result.sections.find((s) => s.sectionId === 'mcp');
  assert.ok(section !== undefined, '必须产出 mcp 分区');
  return section.data as McpSection;
}

test('t8 项目级：指令合并 + permissions/agents/rules 报码 + 项目 skills 与 MCP 进包', () => {
  const result = convertClaudeCode({
    claudeJson: { mcpServers: { globalSrv: { command: 'npx', args: ['-y', 'globalSrv'] } } },
    memory: '# 全局指令' + NL,
    projects: [
      {
        root: 'D:/proj/one',
        hasClaudeDir: true,
        memory: '# 项目一' + NL,
        settings: {
          permissions: { allow: ['Bash(git:*)', 'Read'], ask: ['Write'], deny: [] },
          hooks: { PreToolUse: [{ matcher: 'Bash' }] },
          statusLine: { type: 'command' },
        },
        mcpJson: { mcpServers: { projSrv: { command: 'npx', args: ['-y', 'projSrv'] } } },
        skills: [{ name: 'proj-skill', files: [{ relativePath: 'SKILL.md', data: skillMd('proj-skill', 'from project') }] }],
        agents: [{ name: 'reviewer', file: 'reviewer.md' }],
        rules: [
          { name: 'plain.md', text: '# 规则正文' + NL },
          { name: 'scoped.md', text: ['---', 'description: scoped', '---', '', 'SCOPED-BODY'].join(NL) },
        ],
      },
      { root: 'D:/proj/two', hasClaudeDir: true, memoryLocal: '# 项目二本地覆盖' + NL },
    ],
  });

  /* ① 指令合并：全局 + 项目 memory + 项目 memoryLocal + 不带 frontmatter 的 rule 合成一份 */
  const text = instructionsText(result);
  for (const part of ['# 全局指令', '# 项目一', '# 规则正文', '# 项目二本地覆盖']) {
    assert.ok(text.includes(part), '合并正文必须含：' + part);
  }
  assert.ok(!text.includes('SCOPED-BODY'), '带 frontmatter 的 rule 绝不进合并正文');
  const merged = result.skipped.find((s) => s.code === 'instructions-merged');
  assert.equal(merged?.detail, 'claude-md+project:1+rule:1:plain.md+project-local:2');
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-rules' && s.origin === 'scoped.md'));

  /* ② permissions：只数条数（值一律不读） */
  const perms = result.skipped.find((s) => s.code === 'unsupported-permissions');
  assert.equal(perms?.detail, 'project:1 allow=2,ask=1,deny=0');
  assert.equal(perms?.origin, 'project:1/settings.json');
  assert.equal(result.counts['permissions'], 3);

  /* ③ hooks：事件名 + 条目数明细 */
  const hooks = result.skipped.find((s) => s.code === 'unsupported-hooks' && s.origin === 'project:1/settings.json');
  assert.equal(hooks?.detail, 'project:1 PreToolUse=1');
  assert.equal(result.counts['hooks'], 1);

  /* ④ 其余顶层键：只记键名 */
  const other = result.skipped.find((s) => s.code === 'unsupported-settings-keys');
  assert.equal(other?.detail, 'project:1 statusLine');

  /* ⑤ agents 逐条报码 */
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-agents' && s.origin === 'reviewer'));
  assert.equal(result.counts['agents'], 1);

  /* ⑥ 项目 skills 与项目 MCP 进包 */
  assert.deepEqual(skillPathsOf(result), ['proj-skill/SKILL.md']);
  assert.deepEqual(mcpOf(result).servers.map((s) => s.serverName).sort(), ['globalSrv', 'projSrv']);
  assert.equal(result.counts['projects'], 2);
});

test('t9 插件：skills 与 .mcp.json 进包（Authorization 值剥离）、unsupported-plugins 一条、origin.plugins 元数据', () => {
  const SECRET = 'sk-ant-PLUGIN-SECRET-0987654321';
  const result = convertClaudeCode({
    plugins: [
      {
        name: 'demo-plugin',
        version: '1.2.3',
        marketplace: 'official',
        repo: 'https://github.com/owner/repo',
        ref: 'abc123',
        installRel: 'marketplaces/official/plugins/demo-plugin',
        components: ['skills', 'mcp', 'commands', 'agents', 'hooks'],
        skills: [{ name: 'plug-skill', files: [{ relativePath: 'SKILL.md', data: skillMd('plug-skill', 'from plugin') }] }],
        mcpJson: { mcpServers: { plug: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ' + SECRET } } } },
        commandCount: 2,
        agents: ['planner.md'],
        hookFiles: 3,
      },
    ],
  });

  assert.deepEqual(skillPathsOf(result), ['plug-skill/SKILL.md']);

  const plug = mcpOf(result).servers.find((s) => s.serverName === 'plug');
  assert.equal(plug?.headers?.['Authorization'], '', 'Authorization 的值必须被剥成空串（字段名保留）');
  assert.ok(result.credentialRefs.includes('mcp:plug:Authorization'));

  const pluginSkips = result.skipped.filter((s) => s.code === 'unsupported-plugins');
  assert.equal(pluginSkips.length, 1, '每个插件恰好一条 unsupported-plugins');
  assert.equal(pluginSkips[0]?.origin, 'demo-plugin');
  assert.equal(pluginSkips[0]?.detail, 'skills,mcp,commands,agents,hooks');
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-agents' && s.origin === 'planner.md'));
  assert.equal(result.counts['plugins'], 1);
  assert.equal(result.counts['agents'], 1);
  assert.equal(result.counts['commands'], 2);
  assert.equal(result.counts['hooks'], 3);

  const origin = result.origin;
  assert.ok(origin, '有插件时必须产出溯源块');
  assert.deepEqual(origin.plugins, [{
    name: 'demo-plugin',
    version: '1.2.3',
    marketplace: 'official',
    repo: 'https://github.com/owner/repo',
    ref: 'abc123',
    components: ['skills', 'mcp', 'commands', 'agents', 'hooks'],
  }]);
  assert.ok(!JSON.stringify(origin).includes(SECRET), 'origin 里不得出现凭据明文');
});

test('t10 冲突：同名 MCP / 同名 skill 先到先得 + 报码', () => {
  const result = convertClaudeCode({
    claudeJson: { mcpServers: { dup: { command: 'npx', args: ['-y', 'global-dup'] } } },
    skills: [{ name: 'same', files: [{ relativePath: 'SKILL.md', data: skillMd('same', 'global-copy') }] }],
    projects: [
      {
        root: 'D:/proj/dup',
        hasClaudeDir: true,
        mcpJson: { mcpServers: { dup: { command: 'npx', args: ['-y', 'project-dup'] } } },
        projectMcp: { dup: { command: 'npx', args: ['-y', 'claudejson-dup'] }, onlyInProject: { command: 'npx' } },
        skills: [{ name: 'same', files: [{ relativePath: 'SKILL.md', data: skillMd('same', 'project-copy') }] }],
      },
    ],
  });

  const dup = mcpOf(result).servers.filter((s) => s.serverName === 'dup');
  assert.equal(dup.length, 1, '同名 MCP 只允许第一条进包');
  assert.deepEqual(dup[0]?.args, ['-y', 'global-dup']);
  assert.equal(result.skipped.filter((s) => s.code === 'mcp-server-id-conflict' && s.origin === 'dup').length, 2);
  assert.ok(mcpOf(result).servers.some((s) => s.serverName === 'onlyInProject'), '非重名的项目级 MCP 照常进包');

  assert.deepEqual(skillPathsOf(result), ['same/SKILL.md'], '同名 skill 不产生重复包内路径');
  assert.equal(result.skipped.filter((s) => s.code === 'skill-id-conflict' && s.origin === 'same').length, 1);
  const skillSection = result.sections.find((s) => s.sectionId === 'skills');
  const first = skillSection?.files?.[0];
  assert.ok(first !== undefined);
  assert.ok(new TextDecoder().decode(first.data).includes('description: global-copy'), '先到先得的应当是全局那一份');
});

test('t11 凭据：项目/插件夹具里的假 token 不进结果对象，也不进产出的 ZIP 字节', async () => {
  // 刻意避开「示例/占位词」降噪名单（secret/test/example/…）：那些词会让值形状判定按示例放行
  const MCP_SECRET = 'sk-ant-Ab3XyZ7890QqWwEeRrTt';
  const HEADER_SECRET = 'sk-ant-Hd7MnB2Vc4Kp9Ls1Qw8Z';
  const ENV_SECRET = 'sk-ant-Ev5RtYuIoPaSdFgHjKlZ';
  const result = convertClaudeCode({
    claudeJson: { mcpServers: { g: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ' + HEADER_SECRET } } } },
    projects: [
      {
        root: 'D:/proj/sec',
        hasClaudeDir: true,
        memory: '# 项目指令' + NL,
        settings: { env: { ANTHROPIC_AUTH_TOKEN: ENV_SECRET } },
        mcpJson: { mcpServers: { p: { command: 'npx', args: ['--token', MCP_SECRET] } } },
      },
    ],
    plugins: [
      {
        name: 'sec-plugin',
        components: ['mcp'],
        mcpJson: { mcpServers: { pl: { command: 'npx', env: { GITHUB_TOKEN: MCP_SECRET } } } },
      },
    ],
  });

  const json = JSON.stringify(result);
  for (const secret of [MCP_SECRET, HEADER_SECRET, ENV_SECRET]) {
    assert.ok(!json.includes(secret), '结果对象里不得出现凭据明文：' + secret);
  }
  assert.ok(result.credentialRefs.includes('mcp:g:Authorization'));
  assert.ok(result.credentialRefs.includes('mcp:p:args'));
  assert.ok(result.credentialRefs.includes('project:1:settings.env:ANTHROPIC_AUTH_TOKEN'));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-cc-secret-'));
  try {
    const zipPath = path.join(tmp, 'b.zip');
    await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-test', dshVersion: '0.1.0' });
    const buf = await fs.readFile(zipPath);
    for (const secret of [MCP_SECRET, HEADER_SECRET, ENV_SECRET]) {
      assert.ok(!buf.includes(Buffer.from(secret, 'utf8')), 'ZIP 字节里不得出现凭据明文：' + secret);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t12 origin：只含标识与计数（locations/projects/plugins 不含任何值）', () => {
  const SECRET = 'sk-ant-ORIGIN-SECRET-5566778899';
  const result = convertClaudeCode({
    claudeJson: { mcpServers: { g: { command: 'npx' } } },
    settings: { env: { GITHUB_TOKEN: SECRET } },
    sourceVersion: '1.2.3',
    configDir: 'D:/home/.claude',
    projects: [{ root: 'D:/proj/x', hasClaudeDir: true, memory: '# x' + NL }],
    plugins: [{ name: 'p1', version: '2.0.0', marketplace: 'm', repo: 'https://github.com/o/r', ref: 'deadbeef', components: ['skills'] }],
    marketplaces: [{ name: 'm', repo: 'https://github.com/o/r' }],
    skills: [{ name: 'g-skill', files: [{ relativePath: 'SKILL.md', data: skillMd('g-skill', 'global') }] }],
  });
  const origin = result.origin;
  assert.ok(origin, '有实际读取面时必须产出溯源块');
  assert.equal(origin.source, 'claude-code');
  assert.equal(origin.sourceVersion, '1.2.3');
  assert.deepEqual(origin.projects, ['D:/proj/x']);
  assert.deepEqual(origin.plugins, [{
    name: 'p1',
    version: '2.0.0',
    marketplace: 'm',
    repo: 'https://github.com/o/r',
    ref: 'deadbeef',
    components: ['skills'],
  }]);
  for (const loc of ['.claude.json', '.claude', '.claude/settings.json', '.claude/skills', '.claude/plugins', '.claude/plugins/known_marketplaces.json']) {
    assert.ok(origin.locations.includes(loc), 'locations 必须含实际读到的位置：' + loc);
  }
  assert.ok(!origin.locations.some((loc) => loc.includes('sk-ant')), 'locations 只允许标识，绝不含任何值');
  assert.ok(origin.skipped?.some((s) => s.code === 'credentials-not-migrated' && s.count === 1));
  assert.deepEqual(origin.credentialRefs, result.credentialRefs);
  assert.ok(!JSON.stringify(origin).includes(SECRET), 'origin 里不得出现凭据明文');
});
