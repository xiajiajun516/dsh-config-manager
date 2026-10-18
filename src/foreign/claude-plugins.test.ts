/**
 * Claude Code **插件读盘层**的回归护栏（2026-10-18）。
 *
 * 夹具形态取自本机真实布局（known_marketplaces.json / marketplace.json / plugins|external_plugins /
 * .claude-plugin/plugin.json / skills / commands / agents / hooks / .mcp.json），**绝不含真凭据**：
 * 假 token 只放在两个「绝不该被读进返回值」的地方（hooks 代码内容、仓库 URL 的 userinfo）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readClaudePlugins } from './read-claude-plugins.ts';
import type { ClaudePluginReadResult } from './read-claude-plugins.ts';
import type { ClaudePluginInput } from './types.ts';

const NL = String.fromCharCode(10);
const SKILL_MD = ['---', 'name: demo', 'description: fixture skill', '---', '', '# body', ''].join(NL);
/** 假凭据：只用于「绝不泄露」断言（hooks 内容与 repo userinfo） */
const FAKE_TOKEN = 'sk-ant-FAKE-0123456789abcdef';

async function withClaudeDir(fn: (claudeDir: string) => Promise<void>): Promise<void> {
  const claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-claude-plugins-'));
  try {
    await fn(claudeDir);
  } finally {
    await fs.rm(claudeDir, { recursive: true, force: true });
  }
}

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

function pluginOf(result: ClaudePluginReadResult, name: string): ClaudePluginInput | undefined {
  return result.plugins.find((plugin) => plugin.name === name);
}

/** 真机布局夹具：两个市场（其中一个 repo 带 userinfo）、启用/未启用/缺目录三种插件 */
async function buildFixture(claudeDir: string): Promise<{ demoDir: string; extDir: string }> {
  const pluginsDir = path.join(claudeDir, 'plugins');
  const marketDir = path.join(pluginsDir, 'marketplaces', 'demo-market');
  await write(path.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({
    'token-market': {
      source: { source: 'git', url: 'https://user:' + FAKE_TOKEN + '@github.com/acme/secret-plugins.git' },
      lastUpdated: '2026-10-01T00:00:00Z',
    },
    'demo-market': {
      source: { source: 'github', repo: 'acme/claude-plugins' },
      installLocation: marketDir,
      lastUpdated: '2026-10-02T00:00:00Z',
    },
  }));
  await write(path.join(marketDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'demo-market',
    description: 'fixture marketplace',
    owner: { name: 'acme' },
    plugins: [{ name: 'demo', description: 'demo plugin', author: 'acme', category: 'dev', source: { source: 'github', repo: 'acme/demo', ref: 'main' } }],
  }));

  const demoDir = path.join(marketDir, 'plugins', 'demo');
  await write(path.join(demoDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3', description: 'demo plugin' }));
  await write(path.join(demoDir, 'skills', 'hello', 'SKILL.md'), SKILL_MD);
  await write(path.join(demoDir, 'commands', 'one.md'), 'cmd one');
  await write(path.join(demoDir, 'commands', 'nested', 'two.md'), 'cmd two');
  await write(path.join(demoDir, 'agents', 'reviewer.md'), 'agent body');
  await write(path.join(demoDir, 'hooks', 'hook.js'), 'console.log(' + JSON.stringify(FAKE_TOKEN) + ')');
  await write(path.join(demoDir, 'hooks.json'), JSON.stringify({ hooks: {} }));
  await write(path.join(demoDir, '.mcp.json'), JSON.stringify({ 'demo-server': { type: 'http', url: 'https://mcp.example.com' } }));

  const extDir = path.join(marketDir, 'external_plugins', 'ext');
  await write(path.join(extDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ext' }));
  await write(path.join(extDir, 'skills', 'ext-skill', 'SKILL.md'), SKILL_MD);

  /* 未启用插件：安装在、但值不是真值 → 绝不产出 */
  await write(path.join(marketDir, 'plugins', 'off', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'off' }));

  return { demoDir, extDir };
}

const ENABLED_BOTH = {
  enabledPlugins: {
    'demo@demo-market': true,
    'ext@demo-market': true,
    'off@demo-market': false,
    'ghost@demo-market': true,
  },
};

test('市场与启用插件：名字/repo 正确、userinfo 被剥离、组件与计数都对得上', async () => {
  await withClaudeDir(async (claudeDir) => {
    await buildFixture(claudeDir);
    const result = await readClaudePlugins({ claudeDir, settings: ENABLED_BOTH });

    assert.deepEqual(result.marketplaces, [
      { name: 'demo-market', repo: 'acme/claude-plugins' },
      { name: 'token-market', repo: 'https://github.com/acme/secret-plugins.git' },
    ], 'repo 必须来自 source.repo 或 source.url，且 URL 的 userinfo 被剥离');

    assert.deepEqual(result.plugins.map((p) => p.name), ['demo', 'ext'], '未启用(false)与找不到安装目录的插件不得产出');

    const demo = pluginOf(result, 'demo');
    assert.ok(demo !== undefined);
    assert.equal(demo.version, '1.2.3');
    assert.equal(demo.marketplace, 'demo-market');
    assert.equal(demo.repo, 'acme/claude-plugins');
    assert.equal(demo.installRel, 'marketplaces/demo-market/plugins/demo');
    assert.deepEqual(demo.components, ['skills', 'mcp', 'commands', 'agents', 'hooks']);
    assert.deepEqual(demo.skills?.map((s) => s.name), ['hello']);
    assert.deepEqual(demo.mcpJson, { 'demo-server': { type: 'http', url: 'https://mcp.example.com' } }, '.mcp.json 必须被读到（原样交翻译层）');
    assert.equal(demo.commandCount, 2, 'commands 递归计数（含 nested/）');
    assert.deepEqual(demo.agents, ['reviewer.md'], 'agents 只取文件名');
    assert.equal(demo.hookFiles, 2, 'hooks/ 下的文件数 + hooks.json 各算 1');
    assert.equal(demo.readFindings, undefined, '完整插件不得产出 finding');

    const ext = pluginOf(result, 'ext');
    assert.ok(ext !== undefined);
    assert.equal(ext.installRel, 'marketplaces/demo-market/external_plugins/ext', 'external_plugins/ 布局必须能找到');
    assert.deepEqual(ext.components, ['skills']);

    assert.deepEqual(result.counts, {
      marketplaces: 2,
      // 真值才算启用：demo / ext / ghost 三条（off 的值是 false）
      enabledPlugins: 3,
      plugins: 2,
      pluginSkills: 2,
      pluginCommands: 2,
      pluginAgents: 1,
      pluginHooks: 2,
    });
    assert.deepEqual(
      result.skipped.map((s) => [s.code, s.origin]),
      [['source-unreadable', 'plugin:ghost']],
      '有启用记录但没有安装目录：如实报码（不产出半成品条目）',
    );

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(FAKE_TOKEN), false, '假 token（URL userinfo / hooks 内容）绝不允许出现在返回值里');
    assert.equal(serialized.includes('sk-ant-'), false, '任何 token 形状都不得出现在返回值里');
  });
});

test('plugins/config.json 形状认不出来：报 plugins-config-unknown-shape，绝不瞎猜', async () => {
  await withClaudeDir(async (claudeDir) => {
    await write(path.join(claudeDir, 'plugins', 'config.json'), JSON.stringify({ version: 2, unknown: ['demo'] }));
    const result = await readClaudePlugins({ claudeDir, settings: {} });
    assert.deepEqual(result.plugins, [], '认不出来的形状绝不能被当成插件清单');
    const skip = result.skipped.find((s) => s.detail === 'plugins-config-unknown-shape');
    assert.ok(skip !== undefined, '必须报码：' + JSON.stringify(result.skipped));
    assert.equal(skip.code, 'source-unreadable');
    assert.equal(skip.origin, 'plugins/config.json');
  });
});

test('plugins/config.json 形状可自证（{ plugins: { "name@market": true } }）：认出来就用', async () => {
  await withClaudeDir(async (claudeDir) => {
    await buildFixture(claudeDir);
    await write(path.join(claudeDir, 'plugins', 'config.json'), JSON.stringify({ plugins: { 'demo@demo-market': true } }));
    const result = await readClaudePlugins({ claudeDir, settings: {} });
    assert.deepEqual(result.plugins.map((p) => p.name), ['demo']);
    assert.equal(result.skipped.some((s) => s.detail === 'plugins-config-unknown-shape'), false);
  });
});

test('既无 enabledPlugins 也无 config.json：plugins 为空且不报码（诚实：没有启用的插件）', async () => {
  await withClaudeDir(async (claudeDir) => {
    const result = await readClaudePlugins({ claudeDir, settings: {} });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.marketplaces, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.counts['plugins'], 0);
  });
});

test('known_marketplaces.json 存在但解析失败：报 source-unreadable（不静默）', async () => {
  await withClaudeDir(async (claudeDir) => {
    await write(path.join(claudeDir, 'plugins', 'known_marketplaces.json'), '{ not json');
    const result = await readClaudePlugins({ claudeDir, settings: {} });
    const skip = result.skipped.find((s) => s.origin === 'plugins/known_marketplaces.json');
    assert.ok(skip !== undefined, '解析失败必须报码：' + JSON.stringify(result.skipped));
    assert.equal(skip.code, 'source-unreadable');
    assert.equal(skip.detail, 'json-error');
    assert.deepEqual(result.marketplaces, []);
  });
});

test('插件数触顶报 max-plugins-reached（不静默）', async () => {
  await withClaudeDir(async (claudeDir) => {
    await buildFixture(claudeDir);
    const result = await readClaudePlugins({ claudeDir, settings: ENABLED_BOTH, limits: { maxPlugins: 1 } });
    assert.equal(result.plugins.length, 1);
    const skip = result.skipped.find((s) => s.detail === 'max-plugins-reached');
    assert.ok(skip !== undefined, '触顶必须报码：' + JSON.stringify(result.skipped));
    assert.equal(skip.origin, 'plugins');
    assert.equal(skip.count, 1);
  });
});

test('单插件文件数触顶报 max-plugin-files-reached，且载荷里不超过上限', async () => {
  await withClaudeDir(async (claudeDir) => {
    const { demoDir } = await buildFixture(claudeDir);
    await write(path.join(demoDir, 'skills', 'hello', 'extra1.md'), 'x');
    await write(path.join(demoDir, 'skills', 'hello', 'extra2.md'), 'y');
    const result = await readClaudePlugins({
      claudeDir,
      settings: { enabledPlugins: { 'demo@demo-market': true } },
      limits: { maxPluginFiles: 2 },
    });
    const demo = pluginOf(result, 'demo');
    assert.ok(demo !== undefined);
    const skip = demo.readFindings?.find((s) => s.detail === 'max-plugin-files-reached');
    assert.ok(skip !== undefined, '单插件触顶必须报码：' + JSON.stringify(demo.readFindings));
    assert.equal(skip.origin, 'plugin:demo');
    assert.equal(skip.count, 2);
    const carried = demo.skills?.reduce((sum, skill) => sum + skill.files.length, 0) ?? 0;
    assert.ok(carried <= 2, '载荷里不得带超过上限的技能文件（实际 ' + String(carried) + '）');
  });
});

test('plugin.json 解析失败：回落目录名并报码（绝不猜字段）', async () => {
  await withClaudeDir(async (claudeDir) => {
    const pluginDir = path.join(claudeDir, 'plugins', 'marketplaces', 'm', 'plugins', 'broken');
    await write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{ oops');
    const result = await readClaudePlugins({ claudeDir, settings: { enabledPlugins: { 'broken@m': true } } });
    const plugin = pluginOf(result, 'broken');
    assert.ok(plugin !== undefined, '安装目录存在就必须产出条目：' + JSON.stringify(result.skipped));
    assert.equal(plugin.version, undefined);
    const skip = plugin.readFindings?.find((s) => s.origin === 'plugin:broken/plugin.json');
    assert.ok(skip !== undefined, '解析失败必须报码：' + JSON.stringify(plugin.readFindings));
    assert.equal(skip.detail, 'json-error');
  });
});
