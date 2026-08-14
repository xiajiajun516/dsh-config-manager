/**
 * Rollback 测试（m7-tests-docs；规范 §33 Rollback 组 / §36 场景 E）。
 *
 * 场景 E 端到端：多 adapter 混合（settings + skills 文件 + workspaces + MCP patch 行）
 * 中途失败 → 验证整体回滚（settings 原值 / 文件 blob 恢复 / workspace 原值 / patch 原行）；
 * 以及 rollbackOnError=false 对照（单项失败如实记录、其余继续）。
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
import type { ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext, ImportContext, PlanItem, ValidationResult } from '../../src/core/types.ts';

const NS = ['general', 'llm-deepseek'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 失败注入包装：代理真实 adapter，命中指定 itemId 的 applyItem 时抛错 */
class FlakyAdapter implements ConfigAdapter {
  private readonly inner: ConfigAdapter;
  private failItemId: string;
  private readonly failOnce: boolean;
  constructor(inner: ConfigAdapter, failItemId: string, failOnce = true) {
    this.inner = inner;
    this.failItemId = failItemId;
    this.failOnce = failOnce;
  }
  get id() { return this.inner.id; }
  get displayName() { return this.inner.displayName; }
  get defaultIncluded() { return this.inner.defaultIncluded; }
  get portability() { return this.inner.portability; }
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection> { return this.inner.export(ctx, options); }
  analyzeImport(data: unknown, ctx: ImportContext): Promise<PlanItem[]> { return this.inner.analyzeImport(data, ctx); }
  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (item.id === this.failItemId) {
      if (this.failOnce) this.failItemId = '__none__'; // 仅失败一次（保底防循环）
      throw new Error(`模拟写入失败: ${item.id}`);
    }
    return this.inner.applyItem(item, ctx);
  }
  validate(data: unknown): Promise<ValidationResult> { return this.inner.validate(data); }
}

/** 完整源：settings（general/llm-deepseek）+ skills 文件 + workspace + MCP patch 行 */
async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
    revision: 5,
    secrets: [{ path: ['apiKeyEnv'], set: true }],
  });
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
  ctx.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [] });
  ctx.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
  });
}

/** 目标初始状态：所有将被修改项均已存在（不同值）→ 快照全部 existed=true → 可完整回滚 */
async function seedTargetExisting(dst: MockHostContext): Promise<void> {
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
  dst.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://old.example.com', model: 'old-model' },
    revision: 2,
    secrets: [{ path: ['apiKeyEnv'], set: true }],
  });
  await dst.fs.writeFile('skills/coding.md', Buffer.from('# OLD skill content\n', 'utf8'));
  dst.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\bob\\projects\\old', title: 'OldTitle', sessionIds: [] });
  dst.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'node', args: ['old.js'] } },
  });
}

async function exportFixture(src: MockHostContext, outPath: string): Promise<void> {
  const adapters = createAdapters({ namespaces: NS });
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath });
}

test('E-01 场景 E 端到端：多 adapter 中途失败（workspaces）→ 整体回滚，settings/文件/workspace/patch 全部恢复', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'e01.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    await seedTargetExisting(dst);

    const adapters = createAdapters({ namespaces: NS });
    // 在 workspaces adapter 上注入失败（settings/skills 已先写入，mcp 尚未执行）
    const flaky = adapters.map((a) => (a.id === 'workspaces' ? new FlakyAdapter(a, 'workspace:ws-ops') : a));
    const importer = new Importer({ ctx: dst, adapters: flaky, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] }],
    });
    assert.ok(plan.items.some((i) => i.id === 'settings:general' && i.kind === 'Update'), 'general 应为 Update');
    assert.ok(plan.items.some((i) => i.id === 'skills:coding.md'), '技能文件应有计划项');
    assert.ok(plan.items.some((i) => i.id === 'workspace:ws-ops'), 'workspace 应有计划项');
    assert.ok(plan.items.some((i) => i.id === 'mcp:filesystem'), 'MCP 应有计划项');

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: true });
    assert.equal(result.ok, false, '失败应整体回滚并返回 ok=false');
    assert.ok(result.rollback, '应有回滚报告');
    assert.equal(result.rollback.full, true, '所有条目 existed=true → 应完整回滚');

    // —— 验证原配置全部恢复 ——
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light', 'general 恢复原值');
    assert.equal((dst.settings.ns.get('llm-deepseek')?.value as { baseURL: string }).baseURL, 'https://old.example.com', 'llm-deepseek 恢复原值');
    const skill = Buffer.from(await dst.fs.readFile('skills/coding.md')).toString('utf8');
    assert.equal(skill, '# OLD skill content\n', '技能文件 blob 恢复原内容');
    assert.equal(dst.workspace.records.get('ws-ops')?.path, 'C:\\Users\\bob\\projects\\old', 'workspace 恢复原 path');
    const mcp = dst.patchFile.lines.get('mcp-fs')?.raw as { config: { command: string } };
    assert.equal(mcp.config.command, 'node', 'MCP patch 行恢复原值');
  });
});

test('E-02 部分回滚：新建项无法删除 → full=false + manualHint（诚实报告）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'e02.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    // 目标 general/skills/workspace/mcp 已存在，但 llm-deepseek 不存在（将 Create）
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] });
    await dst.fs.writeFile('skills/coding.md', Buffer.from('# OLD skill content\n', 'utf8'));
    dst.workspace.records.set('ws-ops', { id: 'ws-ops', path: 'C:\\Users\\bob\\projects\\old', title: 'OldTitle', sessionIds: [] });
    dst.patchFile.lines.set('mcp-fs', {
      lineId: 'mcp-fs',
      raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'node', args: ['old.js'] } },
    });

    const adapters = createAdapters({ namespaces: NS });
    const flaky = adapters.map((a) => (a.id === 'workspaces' ? new FlakyAdapter(a, 'workspace:ws-ops') : a));
    const importer = new Importer({ ctx: dst, adapters: flaky, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] }],
    });
    assert.ok(plan.items.some((i) => i.id === 'settings:llm-deepseek' && i.kind === 'Create'), 'llm-deepseek 应为 Create');

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: true });
    assert.equal(result.ok, false);
    assert.ok(result.rollback);
    assert.equal(result.rollback.full, false, '新建项无法回滚 → 应如实报告部分回滚');
    assert.ok(
      result.rollback.failed.some((f) => f.item.includes('llm-deepseek') && f.manualHint),
      '失败清单应含 manualHint 提示人工处理',
    );
    // 其余可恢复项仍恢复
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'light');
    assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString('utf8'), '# OLD skill content\n');
    assert.equal(dst.workspace.records.get('ws-ops')?.path, 'C:\\Users\\bob\\projects\\old');
  });
});

test('E-03 对照：rollbackOnError=false → 单项失败如实记录，其余继续，不整体回滚', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'e03.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('win32', 'C:\\Users\\bob');
    await seedTargetExisting(dst);

    const adapters = createAdapters({ namespaces: NS });
    const flaky = adapters.map((a) => (a.id === 'workspaces' ? new FlakyAdapter(a, 'workspace:ws-ops') : a));
    const importer = new Importer({ ctx: dst, adapters: flaky, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, {
      strategy: 'replace',
      resolutions: {},
      pathMappings: [{ oldPrefix: 'C:\\Users\\alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] }],
    });

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, rollbackOnError: false });
    assert.equal(result.ok, true, '未开启整体回滚时单项失败不使整体失败');
    assert.equal(result.rollback, null, '不应触发回滚');
    const failed = result.executed.find((e) => e.itemId === 'workspace:ws-ops');
    assert.ok(failed && failed.status === 'failed', '失败项应如实记录 status=failed');
    // 其余项成功写入（未回滚）
    assert.equal((dst.settings.ns.get('general')?.value as { theme: string }).theme, 'dark', 'settings 已导入');
    assert.equal(Buffer.from(await dst.fs.readFile('skills/coding.md')).toString('utf8'), '# Coding skill\nUse deepseek.\n', '技能文件已导入');
    assert.equal(dst.workspace.records.get('ws-ops')?.path, 'C:\\Users\\bob\\projects\\old', 'workspace 失败项保持原值');
  });
});
