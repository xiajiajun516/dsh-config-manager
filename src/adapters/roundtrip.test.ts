/**
 * 适配器集成往返测试：真实 adapter 列表（createAdapters）+ 核心引擎
 * Exporter → ZIP → Importer（win32 → linux），验证：
 *  - 全分区导出、Secret 值不进入 ZIP、路径映射、凭据补录报告、
 *  - MCP/插件写 patch 的 needsRestart、重复导入幂等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../core/exporter.ts';
import { Importer } from '../core/importer.ts';
import { parseZip } from '../utils/zip.ts';
import { normalizePath } from '../utils/paths.ts';
import { createAdapters } from './index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from './test-helpers.ts';

const NS = ['general', 'theme', 'llm-deepseek', 'llm-pi-ai'];

async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-value-123' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.settings.ns.set('llm-pi-ai', {
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com', models: ['gpt-4o'] } } },
    revision: 2,
    secrets: [],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
  ctx.credentials.values.set('OPENAI_API_KEY', 'sk-openai-456');

  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
  await ctx.fs.writeFile('.agent-presets/work/agent.cordis.yml', Buffer.from('services:\n  - name: work\n', 'utf8'));
  await ctx.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));

  ctx.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  ctx.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], cwd: 'C:\\Users\\alice\\projects' } },
  });
  ctx.patchFile.lines.set('persona-line', {
    lineId: 'persona-line',
    raw: { id: 'persona-line', name: '@deepseek-ai/dsh-web', config: { systemPrompt: { persona: 'You are a helpful assistant.' } } },
  });
}

test('集成往返：win32 → linux（路径映射 + Secret 不泄 + 补录报告 + needsRestart + 幂等）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-adapters-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const adapters = createAdapters({ namespaces: NS });
    const zipPath = path.join(tmp, 'dsh-config-roundtrip.zip');
    const exporter = new Exporter({
      ctx: src, adapters, exporterVersion: '0.1.0',
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    });
    const result = await exporter.export({ includeSecrets: false, outPath: zipPath });
    assert.equal(result.manifest.schemaVersion, 1);
    assert.equal(result.manifest.security.containsSecrets, false);
    assert.equal(result.report.security.redactedHits >= 1, true, 'apiKey 字段应被 scanner 剥离计数');

    // ZIP 内容检查：secret 值绝不出现；插件二进制未打包
    const archive = parseZip(await fs.readFile(zipPath));
    const allText = archive.names()
      .filter((n) => n !== 'integrity/checksums.json')
      .map((n) => Buffer.from(archive.readEntry(n)).toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('sk-super-secret-value-123'), 'secret 值不得写入导出');
    assert.ok(archive.has('config/settings.json'));
    assert.ok(archive.has('config/ui.json'));
    assert.ok(archive.has('ai/providers.json'));
    assert.ok(archive.has('plugins/plugins.json'));
    assert.ok(archive.has('mcp/servers.json'));
    assert.ok(archive.has('custom/prompts.json'));
    assert.ok(archive.has('custom/skills/coding.md'));
    assert.ok(archive.has('agents/presets/work/agent.cordis.yml'));
    assert.ok(archive.has('workspaces/workspaces.json'));
    assert.ok(archive.has('security/credentials.json'));

    // —— 目标机器（linux）导入 ——
    const dst = makeContext('linux', '/home/bob');
    // 目标已装相同插件（命名空间已注册但为空）→ 导入走 Create 初始化；未注册的命名空间会按 MissingDependency 跳过
    for (const n of NS) dst.settings.registered.add(n);
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true);
    assert.equal(analysis.secretCount, 2, '两个已配置凭据（DEEPSEEK/OPENAI）需补录');
    assert.equal(analysis.compatibility, 'partial'); // 跨平台
    assert.ok(analysis.pathIssues.some((p) => p.kind === 'platformMismatch' && p.value.includes('C:\\Users\\alice')), '跨平台路径检测');

    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'merge',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces', 'mcp', 'pluginConfig', 'skills'] }],
    });
    assert.ok(plan.pathMappings.length >= 1);
    assert.equal(plan.needsRestart, true, 'MCP/patch 行写入需要重启');

    // Dry Run 零写入
    assert.equal(dst.settings.ns.size, 0);
    assert.equal(dst.patchFile.lines.size, 0);

    const r = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      secretInputs: { DEEPSEEK_API_KEY: 'sk-reentered' },
    });
    assert.equal(r.ok, true);

    // settings/ui/providers 写回
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    assert.deepEqual(dst.settings.ns.get('theme')?.value, { mode: 'dark' });
    const llm = dst.settings.ns.get('llm-deepseek')?.value as Record<string, unknown>;
    assert.equal(llm.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(llm.apiKey, '', 'secret 字段剥离为空串');

    // 文件类写回
    assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString(), '# Coding skill\nUse deepseek.\n');
    assert.equal(Buffer.from(await dst.fs.readFile('.agent-presets/work/agent.cordis.yml')).toString(), 'services:\n  - name: work\n');

    // workspaces 路径映射
    const ws = dst.workspace.records.get('ws-ops');
    assert.ok(ws);
    assert.equal(normalizePath(ws.path), '/home/bob/projects/ops', '绝对路径被映射');

    // MCP / prompt patch 行写入（needsRestart 语义）
    assert.ok(dst.patchFile.lines.has('mcp-fs'), 'MCP patch 行写入');
    const mcpLine = dst.patchFile.lines.get('mcp-fs')?.raw as Record<string, unknown>;
    assert.equal((mcpLine['config'] as Record<string, unknown>)['cwd'], '/home/bob/projects', 'MCP cwd 被映射');
    const persona = dst.patchFile.lines.get('persona-line')?.raw as Record<string, unknown>;
    assert.equal(((persona['config'] as Record<string, unknown>)['systemPrompt'] as Record<string, unknown>)['persona'], 'You are a helpful assistant.');

    // 凭据：补录写入 + 未补录如实报告
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-reentered');
    assert.ok(r.missingSecrets.includes('OPENAI_API_KEY'), '未补录的凭据进入报告');
    assert.ok(!dst.credentials.values.has('OPENAI_API_KEY'), '未提供值不得写入');

    // 幂等：再次导入 → 无新写入项（除 MissingSecret 占位）
    const plan2 = await importer.createImportPlan(zipPath, {
      strategy: 'merge',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces', 'mcp', 'pluginConfig', 'skills'] }],
    });
    assert.ok(
      !plan2.items.some((i) => i.kind === 'Create' || i.kind === 'Update' || i.kind === 'Install'),
      '重复导入不产生新写入项',
    );
    const r2 = await importer.executeImportPlan(zipPath, plan2, { confirm: true, secretInputs: {} });
    assert.ok(r2.executed.every((e) => e.status !== 'failed'), '第二次导入无失败项');
    assert.equal(dst.patchFile.lines.size, 2, 'patch 行未被重复插入');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('集成：pluginFiles 默认不导出 / sessions 默认不导出（manifest 标记 false）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-adapters-opt-'));
  try {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await src.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));
    await src.fs.writeFile('sessions/p/s/s.jsonl.zstd', Buffer.from('x', 'utf8'));
    const adapters = createAdapters({ namespaces: NS, includeSessions: true });
    const zipPath = path.join(tmp, 'opt.zip');
    const exporter = new Exporter({ ctx: src, adapters, exporterVersion: '0.1.0' });
    const result = await exporter.export({ includeSecrets: false, outPath: zipPath });
    assert.equal(result.manifest.sections.pluginFiles, false, 'pluginFiles 默认不导出');
    assert.equal(result.manifest.sections.sessions, false, 'sessions 默认不导出');
    const archive = parseZip(await fs.readFile(zipPath));
    assert.ok(!archive.has('plugin-files/dsh-ssh.json'));
    assert.ok(!archive.has('sessions/p/s/s.jsonl.zstd'));

    // 显式勾选后导出
    const zipPath2 = path.join(tmp, 'opt2.zip');
    await exporter.export({ includeSecrets: false, only: ['pluginFiles', 'sessions'], outPath: zipPath2 });
    const archive2 = parseZip(await fs.readFile(zipPath2));
    assert.ok(archive2.has('plugin-files/dsh-ssh.json'));
    assert.ok(archive2.has('sessions/p/s/s.jsonl.zstd'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
