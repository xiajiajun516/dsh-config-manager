/**
 * Claude Code **读盘层**的回归护栏（2026-10-18 审计缺陷 1/2/3 + 项目级 / CLAUDE_CONFIG_DIR）。
 *
 * 夹具形态一律取自本机真实布局（只复制键名与结构，**绝不含真凭据**）；假 token 用 sk-ant- 形状，
 * 断言它**不出现在任何返回值里**（返回的 JSON 里出现即泄露）。
 *
 * 三个缺陷各自钉一条：会话条数触顶报 max-sessions-reached（1）、技能目录符号链接报 symlink-skipped（2）、
 * CLAUDE_CONFIG_DIR 覆盖报 source-location-overridden 且只读覆盖目录（3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readClaudeCode } from './read-claude-code.ts';

const NL = String.fromCharCode(10);
/** 合法的 SKILL.md（frontmatter 校验在翻译层，读盘层只看字节） */
const SKILL_MD = ['---', 'name: demo', 'description: fixture skill', '---', '', '# body', ''].join(NL);
/** 假凭据（形状像真 token，但绝不是真的；只用于「绝不泄露」断言） */
const FAKE_TOKEN = 'sk-ant-FAKE-0123456789abcdef';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-read-'));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** 目录链接：win32 用 junction（不需要管理员/开发者模式），其它平台用 dir 符号链接 */
async function linkDir(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('用户级 + 项目级完整读取：结构 / 计数 / 项目级 mcpServers 都对得上', async () => {
  await withHome(async (home) => {
    const projA = path.join(home, 'proj-a');
    const projB = path.join(home, 'proj-b');
    const gone = path.join(home, 'proj-gone'); // 已删除的项目：绝不产出 finding

    /* 用户级 */
    await write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }));
    await write(path.join(home, '.claude', 'CLAUDE.md'), '# global memory');
    await write(path.join(home, '.claude', 'skills', 'user-skill', 'SKILL.md'), SKILL_MD);
    await write(path.join(home, '.claude', 'commands', 'one.md'), 'ONE');
    await write(path.join(home, '.claude', 'commands', 'nested', 'two.md'), 'TWO');
    await write(path.join(home, '.claude', 'projects', 'slug-a', 'sess-1.jsonl'), JSON.stringify({ type: 'user' }) + NL);
    await write(path.join(home, '.claude.json'), JSON.stringify({
      lastVersionBase: '2.1.0',
      projects: {
        [projA]: { mcpServers: { 'proj-a-server': { command: 'node' } } },
        [projB]: { mcpServers: { 'proj-b-server': { command: 'node' } } },
        [gone]: {},
      },
    }));

    /* 项目 A：完整项目级布局 */
    await write(path.join(projA, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch'] } }));
    await write(path.join(projA, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
    await write(path.join(projA, 'CLAUDE.md'), '# project memory');
    await write(path.join(projA, 'CLAUDE.local.md'), '# local memory');
    await write(path.join(projA, '.claude', 'rules', 'rule-one.md'), ['---', 'scope: src/**', '---', 'rule body'].join(NL));
    await write(path.join(projA, '.claude', 'skills', 'proj-skill', 'SKILL.md'), SKILL_MD);
    await write(path.join(projA, '.claude', 'agents', 'reviewer.md'), 'agent body');
    await write(path.join(projA, '.claude', 'commands', 'c1.md'), 'C1');
    await write(path.join(projA, '.claude', 'commands', 'deep', 'c2.md'), 'C2');
    await write(path.join(projA, '.mcp.json'), JSON.stringify({ 'local-server': { command: 'npx' } }));
    /* 项目 B：存在但**没有** .claude */
    await fs.mkdir(projB, { recursive: true });

    const read = await readClaudeCode({ homeDir: home });

    assert.equal(read.found, true);
    assert.equal(read.input.configDir, path.join(home, '.claude'));
    assert.equal(read.input.configDirOverridden, undefined, '没有 CLAUDE_CONFIG_DIR 时不得写成「已覆盖」');
    assert.deepEqual(read.input.settings, { theme: 'dark', permissions: { allow: ['Bash'] } });
    assert.equal(read.input.memory, '# global memory');
    assert.equal(read.input.sourceVersion, '2.1.0');
    assert.equal(read.input.commandCount, 2, '全局 commands 必须**递归**计数（含 nested/）');
    assert.deepEqual(read.input.skills?.map((s) => s.name), ['user-skill']);
    assert.deepEqual(read.input.sessions?.map((s) => s.id), ['sess-1']);
    assert.equal(
      read.skipped.some((s) => s.origin === 'projects'),
      false,
      '没有触顶就不得报项目级码：' + JSON.stringify(read.skipped),
    );

    const projects = read.input.projects ?? [];
    assert.deepEqual(projects.map((p) => p.root), [projA, projB], '已删除的项目必须安静跳过；其余按字典序');

    const a = projects[0];
    assert.ok(a !== undefined);
    assert.equal(a.hasClaudeDir, true);
    assert.deepEqual(a.settings, { permissions: { deny: ['WebFetch'] } });
    assert.deepEqual(a.settingsLocal, { permissions: { allow: ['Read'] } });
    assert.equal(a.memory, '# project memory');
    assert.equal(a.memoryLocal, '# local memory');
    assert.deepEqual(a.rules?.map((r) => r.name), ['rule-one.md']);
    assert.deepEqual(a.skills?.map((s) => s.name), ['proj-skill']);
    assert.deepEqual(a.agents, [{ name: 'reviewer', file: 'reviewer.md' }]);
    assert.equal(a.commandCount, 2, '项目级 commands 必须**递归**计数');
    assert.deepEqual(a.mcpJson, { 'local-server': { command: 'npx' } });
    assert.deepEqual(a.projectMcp, { 'proj-a-server': { command: 'node' } }, '~/.claude.json 里该项目的 mcpServers 必须带出');
    assert.equal(a.readFindings, undefined, '完整项目不得产出 finding');

    const b = projects[1];
    assert.deepEqual(b, { root: projB, hasClaudeDir: false }, '没有 .claude 的项目只留 root + hasClaudeDir，绝不产空 finding');
  });
});

test('CLAUDE_CONFIG_DIR 覆盖：报 source-location-overridden，且**只读**覆盖后的目录（缺陷 3）', async () => {
  await withHome(async (home) => {
    const overrideDir = path.join(home, 'cc-config');
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'ORIGIN');
    await write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'origin' }));
    await write(path.join(overrideDir, 'CLAUDE.md'), 'OVERRIDDEN');
    await write(path.join(overrideDir, 'settings.json'), JSON.stringify({ theme: 'override' }));

    const read = await readClaudeCode({ homeDir: home, env: { CLAUDE_CONFIG_DIR: overrideDir } });
    assert.equal(read.found, true);
    assert.equal(read.input.configDir, path.resolve(overrideDir));
    assert.equal(read.input.configDirOverridden, true);
    assert.equal(read.input.memory, 'OVERRIDDEN', '必须读覆盖目录，绝不回落到 ~/.claude');
    assert.deepEqual(read.input.settings, { theme: 'override' });
    assert.ok(
      read.skipped.some((s) => s.code === 'source-location-overridden' && s.origin === 'settings'),
      '命中覆盖必须报码：' + JSON.stringify(read.skipped),
    );
  });
});

test('CLAUDE_CONFIG_DIR 空串 / 纯空白 = 未设置（不报覆盖码，照旧读 ~/.claude）', async () => {
  await withHome(async (home) => {
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'ORIGIN');
    for (const value of ['', '   ']) {
      const read = await readClaudeCode({ homeDir: home, env: { CLAUDE_CONFIG_DIR: value } });
      assert.equal(read.input.configDir, path.join(home, '.claude'));
      assert.equal(read.input.configDirOverridden, undefined);
      assert.equal(read.input.memory, 'ORIGIN');
      assert.equal(read.skipped.some((s) => s.code === 'source-location-overridden'), false);
    }
  });
});

test('CLAUDE_CONFIG_DIR 指向「存在但读不出来」的位置：照旧报 source-unreadable', async () => {
  await withHome(async (home) => {
    const overrideDir = path.join(home, 'cc-broken');
    await write(path.join(overrideDir, 'settings.json'), '{ this is not json');
    const read = await readClaudeCode({ homeDir: home, env: { CLAUDE_CONFIG_DIR: overrideDir } });
    assert.equal(read.found, true);
    assert.ok(
      read.skipped.some((s) => s.code === 'source-unreadable' && s.origin === '.claude/settings.json'),
      '存在但读不出来必须报 source-unreadable：' + JSON.stringify(read.skipped),
    );
  });
});

test('会话条数触顶必须报 max-sessions-reached（缺陷 1：此前直接 break、一个字都不报）', async () => {
  await withHome(async (home) => {
    await write(path.join(home, '.claude', 'projects', 'slug-a', 's1.jsonl'), '{}' + NL);
    await write(path.join(home, '.claude', 'projects', 'slug-a', 's2.jsonl'), '{}' + NL);
    await write(path.join(home, '.claude', 'projects', 'slug-b', 's3.jsonl'), '{}' + NL);

    const read = await readClaudeCode({ homeDir: home, maxSessionFiles: 2 });
    assert.equal(read.input.sessions?.length, 2, '载荷里不得超过上限');
    const skip = read.skipped.find((s) => s.code === 'source-unreadable' && s.detail === 'max-sessions-reached');
    assert.ok(skip !== undefined, '触顶必须报码：' + JSON.stringify(read.skipped));
    assert.equal(skip.origin, 'sessions');
    assert.equal(skip.count, 2, 'count = 上限本身');
  });
});

test('会话数恰好等于上限且没有下一个候选：不得误报 max-sessions-reached', async () => {
  await withHome(async (home) => {
    await write(path.join(home, '.claude', 'projects', 'slug-a', 's1.jsonl'), '{}' + NL);
    await write(path.join(home, '.claude', 'projects', 'slug-a', 's2.jsonl'), '{}' + NL);
    const read = await readClaudeCode({ homeDir: home, maxSessionFiles: 2 });
    assert.equal(read.input.sessions?.length, 2);
    assert.equal(read.skipped.some((s) => s.detail === 'max-sessions-reached'), false);
  });
});

test('会话文件带出记录 sessionId 与确定性 createdAtMs（翻译层的报码与幂等回落靠它）', async () => {
  await withHome(async (home) => {
    const line = JSON.stringify({ type: 'user', sessionId: 'record-id-aaaa', cwd: 'D:/x', message: { role: 'user', content: 'hi' } });
    await write(path.join(home, '.claude', 'projects', 'slug-a', 'file-name.jsonl'), line + NL);
    const read = await readClaudeCode({ homeDir: home });
    const s = read.input.sessions?.[0];
    assert.ok(s !== undefined, '必须读到一条会话');
    assert.equal(s.id, 'file-name', '会话 id 仍以文件名 stem 为准');
    assert.equal(s.recordSessionId, 'record-id-aaaa', '记录里的 sessionId 必须原样带出');
    assert.equal(typeof s.createdAtMs, 'number', 'createdAtMs 必须是数字（文件 mtime 回落）');
    assert.ok(Number.isFinite(s.createdAtMs), 'createdAtMs 必须是有限数');
  });
});

test('会话文件里没有 sessionId 时不伪造该字段（缺字段 = 不知道）', async () => {
  await withHome(async (home) => {
    await write(path.join(home, '.claude', 'projects', 'slug-a', 'no-id.jsonl'), JSON.stringify({ type: 'user', cwd: 'D:/x', message: { role: 'user', content: 'hi' } }) + NL);
    const read = await readClaudeCode({ homeDir: home });
    assert.equal(read.input.sessions?.[0]?.recordSessionId, undefined);
  });
});

test('技能目录是符号链接：跳过并报 symlink-skipped，且绝不跟随（外部 SKILL.md 不进包）（缺陷 2）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-out-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await write(path.join(home, '.claude', 'skills', 'real', 'SKILL.md'), SKILL_MD);
  await write(path.join(outside, 'SKILL.md'), SKILL_MD + NL + FAKE_TOKEN);
  try {
    await linkDir(outside, path.join(home, '.claude', 'skills', 'linked'));
  } catch {
    t.skip('本环境无法创建目录链接（权限受限），跳过符号链接用例');
    return;
  }

  const read = await readClaudeCode({ homeDir: home });
  assert.deepEqual(read.input.skills?.map((s) => s.name), ['real'], '链接目录不得被当作技能读入');
  const skip = read.skipped.find((s) => s.code === 'source-unreadable' && s.detail === 'symlink-skipped');
  assert.ok(skip !== undefined, '链接被跳过必须报码：' + JSON.stringify(read.skipped));
  assert.equal(skip.origin, 'skills/linked', 'origin 只含包内相对标签');
  assert.equal(JSON.stringify(read).includes(FAKE_TOKEN), false, '链接目标的内容绝不允许进返回值');
});

test('项目级不跟随符号链接：settings.json 指向外部文件时不读、报 symlink-skipped', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-projlink-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-outs-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const proj = path.join(home, 'proj-linked');
  await fs.mkdir(path.join(proj, '.claude'), { recursive: true });
  const secretFile = path.join(outside, 'settings.json');
  await write(secretFile, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN } }));
  try {
    await fs.symlink(secretFile, path.join(proj, '.claude', 'settings.json'), 'file');
  } catch {
    t.skip('本环境无法创建文件符号链接，跳过该用例');
    return;
  }

  const read = await readClaudeCode({ homeDir: home, projectPaths: [proj] });
  const project = read.input.projects?.[0];
  assert.ok(project !== undefined);
  assert.equal(project.settings, undefined, '符号链接指向的文件绝不能被读成项目 settings');
  const skip = project.readFindings?.find((s) => s.detail === 'symlink-skipped');
  assert.ok(skip !== undefined, '跳过必须留码：' + JSON.stringify(project.readFindings));
  assert.equal(skip.origin, '.claude/settings.json');
  assert.equal(JSON.stringify(read).includes(FAKE_TOKEN), false, '链接目标里的 token 绝不允许进返回值');
});

test('项目数触顶报 max-projects-reached（不静默）；不存在的项目不占额度', async () => {
  await withHome(async (home) => {
    const roots = [path.join(home, 'p1'), path.join(home, 'p2'), path.join(home, 'p3')];
    for (const root of roots) await fs.mkdir(root, { recursive: true });
    const gone = path.join(home, 'p-gone');
    await write(path.join(home, '.claude.json'), JSON.stringify({
      projects: {
        [roots[0] as string]: {},
        [roots[1] as string]: {},
        [roots[2] as string]: {},
        [gone]: {},
      },
    }));

    const capped = await readClaudeCode({ homeDir: home, maxProjects: 2 });
    assert.equal(capped.input.projects?.length, 2);
    const skip = capped.skipped.find((s) => s.code === 'source-unreadable' && s.detail === 'max-projects-reached');
    assert.ok(skip !== undefined, '项目触顶必须报码：' + JSON.stringify(capped.skipped));
    assert.equal(skip.origin, 'projects');
    assert.equal(skip.count, 2);

    const fits = await readClaudeCode({ homeDir: home, maxProjects: 3 });
    assert.equal(fits.input.projects?.length, 3, '已删除的项目不占项目额度');
    assert.equal(fits.skipped.some((s) => s.detail === 'max-projects-reached'), false);
  });
});

test('显式 projectPaths 优先于 ~/.claude.json 的 projects 键', async () => {
  await withHome(async (home) => {
    const fromJson = path.join(home, 'from-json');
    const explicit = path.join(home, 'explicit');
    await fs.mkdir(fromJson, { recursive: true });
    await fs.mkdir(explicit, { recursive: true });
    await write(path.join(home, '.claude.json'), JSON.stringify({ projects: { [fromJson]: {} } }));

    const read = await readClaudeCode({ homeDir: home, projectPaths: [explicit] });
    assert.deepEqual(read.input.projects?.map((p) => p.root), [explicit, fromJson]);
  });
});

test('假 token 绝不出现在返回值里（commands / hooks 只计数不读内容）', async () => {
  await withHome(async (home) => {
    await write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'p@m': true } }));
    await write(path.join(home, '.claude', 'commands', 'secret.md'), 'curl -H "Authorization: Bearer ' + FAKE_TOKEN + '"');
    const pluginDir = path.join(home, '.claude', 'plugins', 'marketplaces', 'm', 'plugins', 'p');
    await write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p' }));
    await write(path.join(pluginDir, 'hooks', 'hook.js'), 'console.log(' + JSON.stringify(FAKE_TOKEN) + ')');
    await write(path.join(pluginDir, 'commands', 'run.md'), 'echo ' + FAKE_TOKEN);

    const read = await readClaudeCode({ homeDir: home });
    assert.equal(JSON.stringify(read).includes(FAKE_TOKEN), false, '返回的整份结果里不得出现 token 形状');
    assert.equal(read.input.commandCount, 1, '全局 commands 只计数');
    assert.equal(read.input.plugins?.[0]?.hookFiles, 1, 'hooks 只数文件数');
    assert.equal(read.input.plugins?.[0]?.commandCount, 1);
  });
});
