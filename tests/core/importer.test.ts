/**
 * Import 矩阵测试（m7-tests-docs；规范 §33 Import 组 / §36 场景 C/D、§32 删除策略）。
 *
 * 覆盖：正常导入 / Merge / Replace / Skip（不删目标独有）/ Conflict /
 *       Missing plugin / Missing dependency / Missing secret。
 * 全部基于内存 mock HostContext + 真实 adapter（createAdapters），同平台导入避免路径映射干扰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import type { ImportPlan } from '../../src/core/types.ts';

const NS = ['general', 'llm-deepseek'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-import-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 源配置：general + llm-deepseek + 插件 + MCP + 技能 + 工作区 */
async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-value-123' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true });
  ctx.plugins.installed.set('@linxin666/dsh-task-board', { name: '@linxin666/dsh-task-board', version: '0.1.0', enabled: true });
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\n', 'utf8'));
  ctx.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [] });
  ctx.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
  });
}

/** 导出 → 返回 ZIP 路径 */
async function exportFixture(src: MockHostContext, outPath: string): Promise<void> {
  const adapters = createAdapters({ namespaces: NS });
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath });
}

function makeImporter(dst: MockHostContext) {
  const adapters = createAdapters({ namespaces: NS });
  return new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
}

test('I-01 正常导入：同平台全流程 analyze → plan → execute 成功', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'i01.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    // 目标已装同插件（general/llm-deepseek 注册但为空 → Create 初始化）
    dst.settings.registered.add('general');
    dst.settings.registered.add('llm-deepseek');
    const importer = makeImporter(dst);

    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true);
    assert.equal(analysis.compatibility, 'excellent', '同平台同版本应 excellent');
    assert.equal(analysis.secretCount, 1, '1 个已配置凭据需补录');
    assert.ok(analysis.pathIssues.some((p) => p.kind === 'missing'), '目标机器路径不存在 → missing 需映射');

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.ok(plan.items.some((i) => i.kind === 'Create'), '应有新建项');
    assert.ok(plan.items.some((i) => i.kind === 'MissingSecret'), '应有补录占位');
    assert.equal(plan.needsRestart, true, 'MCP/插件写入需重启');

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, secretInputs: { DEEPSEEK_API_KEY: 'sk-reentered' } });
    assert.equal(result.ok, true);
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' });
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-reentered', '补录值应写入');
    assert.ok(dst.workspace.records.has('ws-ops'));
    assert.ok(dst.patchFile.lines.has('mcp-fs'), 'MCP patch 行应写入');
  });
});

test('I-02 Merge：目标已有同名配置 → Conflict 保留，无决策不覆盖', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const zipPath = path.join(dir, 'i02.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    const importer = makeImporter(dst);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const conflict = plan.items.find((i) => i.id === 'settings:general');
    assert.equal(conflict?.kind, 'Conflict', 'merge + 无决策 → Conflict 项');
    const r = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', '冲突未解决不覆盖');
    assert.ok(r.executed.find((e) => e.itemId === 'settings:general')?.status === 'skipped');
  });
});

test('I-03 Replace：全局 replace 策略 → 冲突项覆盖为导入值', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const zipPath = path.join(dir, 'i03.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    const importer = makeImporter(dst);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'replace', resolutions: {}, pathMappings: [] });
    assert.equal(plan.items.find((i) => i.id === 'settings:general')?.kind, 'Update', 'replace 策略 → Conflict 变 Update');
    const r = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'dark', 'replace 覆盖为导入值');
    assert.ok(r.executed.find((e) => e.itemId === 'settings:general')?.status === 'ok');
  });
});

test('I-04 Skip：skipExisting 策略 + §32 不删除目标独有配置', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.plugins.installed.set('plugin-a', { name: 'plugin-a', version: '1.0.0', enabled: true });
    src.plugins.installed.set('plugin-b', { name: 'plugin-b', version: '1.0.0', enabled: true });
    const zipPath = path.join(dir, 'i04.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    // 目标已有：plugin-a（同版本）、plugin-b（同版本）、plugin-c（ZIP 没有 → 目标独有）
    dst.plugins.installed.set('plugin-a', { name: 'plugin-a', version: '1.0.0', enabled: true });
    dst.plugins.installed.set('plugin-b', { name: 'plugin-b', version: '1.0.0', enabled: true });
    dst.plugins.installed.set('plugin-c', { name: 'plugin-c', version: '2.0.0', enabled: true });
    const importer = makeImporter(dst);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'skipExisting', resolutions: {}, pathMappings: [] });
    assert.ok(
      plan.items.filter((i) => i.adapter === 'plugins').every((i) => i.kind === 'Skip'),
      '同版本插件应为 Skip',
    );
    const r = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.ok(r.ok);

    // §32：ZIP 没有的 plugin-c 必须保留（导入默认不删除目标独有）
    const after = new Set((await dst.plugins.listInstalled()).map((p) => p.name));
    assert.ok(after.has('plugin-c'), '目标独有插件不得被删除');
    assert.ok(after.has('plugin-a') && after.has('plugin-b'));
    assert.equal(after.size, 3, '导入后目标插件集合 = 源 + 目标独有');
  });
});

test('I-05 Conflict：MCP serverName 冲突 → Conflict 项 + useImported 决策覆盖', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.patchFile.lines.set('mcp-fs', {
      lineId: 'mcp-fs',
      raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
    });
    const zipPath = path.join(dir, 'i05.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    // 目标已有同名 serverName 但不同参数
    dst.patchFile.lines.set('mcp-fs', {
      lineId: 'mcp-fs',
      raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'node', args: ['old.js'] } },
    });
    const importer = makeImporter(dst);

    // 无决策 → Conflict
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const conflict = plan.items.find((i) => i.id === 'mcp:filesystem');
    assert.equal(conflict?.kind, 'Conflict', 'MCP 同名不同参 → Conflict');

    // useImported 决策 → Update 覆盖
    const plan2 = await importer.createImportPlan(zipPath, {
      strategy: 'merge', resolutions: { 'mcp:filesystem': 'useImported' }, pathMappings: [],
    });
    assert.equal(plan2.items.find((i) => i.id === 'mcp:filesystem')?.kind, 'Update');
    const r = await importer.executeImportPlan(zipPath, plan2, { confirm: true });
    assert.equal(r.ok, true);
    const line = dst.patchFile.lines.get('mcp-fs')?.raw as { config: { command?: string } };
    assert.equal(line.config.command, 'npx', 'useImported 后 MCP command 应为导入值');
  });
});

test('I-06 Missing plugin：未安装插件 → Install 计划项 + 执行安装 + needsRestart', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.plugins.installed.set('plugin-new', { name: 'plugin-new', version: '3.0.0', enabled: true });
    const zipPath = path.join(dir, 'i06.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const importer = makeImporter(dst);

    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.pluginSummary.toInstall, 1, '应报告 1 个插件需安装');

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const install = plan.items.find((i) => i.kind === 'Install');
    assert.ok(install, '应有 Install 计划项');
    assert.equal(plan.needsRestart, true, '安装插件需重启');

    const r = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.ok(r.ok);
    assert.ok((await dst.plugins.listInstalled()).some((p) => p.name === 'plugin-new'), '插件应被安装');
  });
});

test('I-07 Missing dependency：MCP 依赖缺失 → 报告但不阻塞整体导入', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.patchFile.lines.set('mcp-fs', {
      lineId: 'mcp-fs',
      raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
    });
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const zipPath = path.join(dir, 'i07.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const adapters = createAdapters({ namespaces: NS });
    // npx 缺失
    const importer = new Importer({
      ctx: dst, adapters, snapshotStore: new MemSnapshotStore(),
      dependencyChecker: async (cmd) => cmd !== 'npx',
    });

    const analysis = await importer.analyzeImport(zipPath);
    assert.ok(
      analysis.dependencyIssues.some((d) => d.item === 'filesystem' && d.dependency === 'npx'),
      '应报告 MCP filesystem 缺 npx',
    );
    assert.equal(analysis.valid, true, '依赖缺失不使整体分析失败');

    // 导入本身仍成功（依赖缺失标记 Requires Attention，不阻塞 §15）
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const r = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(r.ok, true, '缺依赖时其他配置仍可导入');
  });
});

test('I-08 Missing secret：补录值写入；未提供值如实报告且不落盘', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('llm-deepseek', {
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
      revision: 5,
      secrets: [{ path: ['apiKeyEnv'], set: true }],
    });
    src.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
    const zipPath = path.join(dir, 'i08.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const importer = makeImporter(dst);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.ok(plan.missingSecrets.some((s) => s.ref === 'DEEPSEEK_API_KEY'), '计划应列出待补录凭据');

    // 不提供值 → skipped + missingSecrets 报告 + 不写入
    const r1 = await importer.executeImportPlan(zipPath, plan, { confirm: true, secretInputs: {} });
    assert.ok(r1.missingSecrets.includes('DEEPSEEK_API_KEY'), '未补录凭据进入结果报告');
    assert.ok(!dst.credentials.values.has('DEEPSEEK_API_KEY'), '未提供值不得写入');

    // 提供值 → 写入
    const r2 = await importer.executeImportPlan(zipPath, plan, { confirm: true, secretInputs: { DEEPSEEK_API_KEY: 'sk-reentered' } });
    assert.ok(!r2.missingSecrets.includes('DEEPSEEK_API_KEY'), '补录后不再缺失');
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-reentered');
  });
});

test('I-09 未确认 → ImportNotConfirmedError 且零写入（安全阀）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const zipPath = path.join(dir, 'i09.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const importer = makeImporter(dst);
    const plan: ImportPlan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });

    await assert.rejects(
      () => importer.executeImportPlan(zipPath, plan, { confirm: false }),
      /导入未确认/,
    );
    assert.equal(dst.settings.ns.size, 0, '未确认不得写任何数据');
    assert.equal(dst.fs.files.size, 0);
  });
});
