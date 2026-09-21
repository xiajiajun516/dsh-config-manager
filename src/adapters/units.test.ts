/**
 * 条目级导出选择（Phase 1）—— 契约与回归。
 *
 * 覆盖四件必须成立的事：
 *  1. **单元粒度**：文件类分区的「最小可拆单元」不能被拆散（技能目录 bundle / 一次会话），
 *     也不能粗到无法使用（整目录一锅端）；
 *  2. **listUnits 与 export 自洽**：listUnits 产出的每个 id 都能被 export(includeItems) 接受，
 *     且选它必定带出至少一个文件（否则 UI 会出现「勾了却什么都没导出」）；
 *  3. **原子组**：pnpm-workspace.yaml ↔ patch 文件必须同进同出（issue #35）——
 *     只搬声明会让目标机 pnpm 拒绝一切 add；
 *  4. **空白名单 = 整分区剔除**：不能静默产出「导出成功但内容为空」的分区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../core/exporter.ts';
import { createAdapters } from './index.ts';
import { PluginsAdapter, PNPM_PROFILE_DIR, PNPM_WORKSPACE_REL } from './plugins.ts';
import { SessionsAdapter } from './sessions.ts';
import { SkillsAdapter } from './skills.ts';
import { PluginFilesAdapter } from './plugin-files.ts';
import { WorkspacesAdapter } from './workspaces.ts';
import { defaultUnitId, toPosixRel } from './units.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { ExportSection, HostContext, ExportUnit } from '../core/types.ts';
import type { PluginsSection } from '../schema/types.ts';

const HOME = 'C:\\Users\\alice';
const write = (ctx: HostContext, rel: string, text: string): Promise<void> =>
  ctx.fs.writeFile(rel, Buffer.from(text, 'utf8'));

/** 断言：单元清单与过滤口径自洽（每个单元都能被导出接受，且带出至少一个文件）。 */
async function assertUnitsSelfConsistent(
  adapter: { export: (c: HostContext, o: { includeSecrets: boolean; includeItems?: Record<string, string[]> }) => Promise<ExportSection<unknown>> },
  ctx: HostContext,
  units: ExportUnit[],
): Promise<void> {
  for (const unit of units) {
    const only = await adapter.export(ctx, { includeSecrets: false, includeItems: { [units.length > 0 ? (unit.id.split(':')[0] as string) : 'skills']: [unit.id] } });
    const data = only.data as { files?: unknown[] };
    assert.ok((data.files?.length ?? 0) > 0, `单元 ${unit.id} 被 listUnits 列出，选中后却没有任何文件`);
  }
}

test('skills：目录 bundle 是一个单元（不可拆），平铺文件各是一个单元', async () => {
  const ctx = makeContext('win32', HOME);
  await write(ctx, 'skills/alpha.md', 'a');
  await write(ctx, 'skills/bundle-one/SKILL.md', 'b1');
  await write(ctx, 'skills/bundle-one/ref.md', 'b2');
  const adapter = new SkillsAdapter();

  const full = await adapter.export(ctx, { includeSecrets: false });
  const units = adapter.listUnits(full);
  assert.deepEqual(units.map((u) => u.id).sort(), ['skills:alpha.md', 'skills:bundle-one']);
  assert.equal(units.find((u) => u.id === 'skills:bundle-one')?.fileCount, 2, '目录 bundle 的成员文件必须计入同一单元');

  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { skills: ['skills:bundle-one'] } });
  assert.deepEqual(
    filtered.data.files.map((f) => f.relativePath).sort(),
    ['bundle-one/SKILL.md', 'bundle-one/ref.md'],
    '只勾选 bundle 时不得带出 bundle 之外的技能文件',
  );
  assert.equal(filtered.counts['files'], 2);

  await assertUnitsSelfConsistent(adapter, ctx, units);
});

test('导入计划项：文件类 adapter 必须按 unitIdOf 声明单元（Phase 2 的选择器靠它归并）', async () => {
  const ctx = makeContext('win32', HOME);
  await write(ctx, 'skills/alpha.md', 'a');
  await write(ctx, 'skills/bundle-one/SKILL.md', 'b1');
  await write(ctx, 'skills/bundle-one/ref.md', 'b2');
  const adapter = new SkillsAdapter();
  const section = await adapter.export(ctx, { includeSecrets: false });
  const items = await adapter.analyzeImport(section.data, makeImportContext(ctx, new Map([['skills', section.data]])));
  const byId = new Map(items.map((i) => [i.id, i.unitId]));
  assert.equal(byId.get('skills:bundle-one/SKILL.md'), 'skills:bundle-one');
  assert.equal(byId.get('skills:bundle-one/ref.md'), 'skills:bundle-one', '同一 bundle 的两个文件必须共用 unitId（否则用户会被迫拆散技能）');
  assert.equal(byId.get('skills:alpha.md'), 'skills:alpha.md');
});

test('sessions：单元 = <projectKey>/<sessionId>（既不能捆整个项目，也不能拆散一次会话）', async () => {
  const ctx = makeContext('win32', HOME);
  await write(ctx, 'sessions/projA/s1/log.jsonl', 'x');
  await write(ctx, 'sessions/projA/s1/meta.json', 'y');
  await write(ctx, 'sessions/projA/s2/log.jsonl', 'z');
  await write(ctx, 'sessions/projB/s3/log.jsonl', 'w');
  const adapter = new SessionsAdapter();

  const full = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(adapter.listUnits(full).map((u) => u.id).sort(), [
    'sessions:projA/s1', 'sessions:projA/s2', 'sessions:projB/s3',
  ]);

  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:projA/s2'] } });
  assert.deepEqual(filtered.data.files.map((f) => f.relativePath), ['projA/s2/log.jsonl']);
});

test('pluginFiles：逐文件单元（collectDir 下每个配置文件可单独带走）', async () => {
  const ctx = makeContext('win32', HOME);
  await write(ctx, 'dsh-ssh.json', '{"hosts":[]}');
  await write(ctx, 'plugin-config/foo/config.json', '{"a":1}');
  await write(ctx, 'plugin-config/bar/config.json', '{"b":2}');
  const adapter = new PluginFilesAdapter(undefined, 'plugin-config');

  const full = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(adapter.listUnits(full).map((u) => u.id).sort(), [
    'pluginFiles:dsh-ssh.json', 'pluginFiles:plugin-config/bar/config.json', 'pluginFiles:plugin-config/foo/config.json',
  ]);

  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { pluginFiles: ['pluginFiles:dsh-ssh.json'] } });
  assert.deepEqual(filtered.data.files.map((f) => f.relativePath), ['dsh-ssh.json']);
});

test('workspaces：一条记录一个单元，过滤只保留勾选的记录', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.workspace.records.set('ws-1', { id: 'ws-1', path: 'C:\\a', title: 'A', sessionIds: [] });
  ctx.workspace.records.set('ws-2', { id: 'ws-2', path: 'C:\\b', sessionIds: [] });
  const adapter = new WorkspacesAdapter();

  const full = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(adapter.listUnits(full).map((u) => u.id), ['workspace:ws-1', 'workspace:ws-2']);
  assert.equal(adapter.listUnits(full)[0]?.label, 'A', '有标题时用标题作展示名');

  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { workspaces: ['workspace:ws-2'] } });
  assert.deepEqual(filtered.data.workspaces.map((w) => w.id), ['ws-2']);
});

test('plugins：按包名过滤，cordis 补丁行独立成单元', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true });
  ctx.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '2.0.0', enabled: true });
  ctx.patchFile.lines.set('line-1', { lineId: 'line-1', raw: { id: 'line-1' } });
  const adapter = new PluginsAdapter();

  const full = await adapter.export(ctx, { includeSecrets: false });
  const ids = adapter.listUnits(full).map((u) => u.id);
  assert.ok(ids.includes('plugin:pkg-a'), `缺少 plugin:pkg-a（实际：${ids.join(',')}）`);
  assert.ok(ids.includes('plugin:pkg-b'));
  assert.ok(ids.includes('patch:line-1'));

  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { plugins: ['plugin:pkg-a'] } });
  assert.deepEqual(filtered.data.plugins.map((p) => p.name), ['pkg-a']);
  assert.deepEqual(filtered.data.patch, [], '未勾选的补丁行不得被带出');
});

test('plugins：pnpm-workspace.yaml ↔ patch 文件是原子组（lockedWith 双向声明）', () => {
  const adapter = new PluginsAdapter();
  const section: ExportSection<PluginsSection> = {
    sectionId: 'plugins',
    data: {
      version: 1,
      plugins: [],
      patch: [],
      pnpmWorkspace: 'patchedDependencies:\n  foo@1.0.0: patches/foo.patch\n',
      patchFiles: [{ relativePath: 'patches/foo.patch', base64: 'AAAA' }],
    },
    counts: {},
    warnings: [],
  };
  const units = adapter.listUnits(section);
  const ws = units.find((u) => u.id === 'plugins:pnpm-workspace');
  const pf = units.find((u) => u.id === 'plugins:patch:patches/foo.patch');
  assert.deepEqual(ws?.lockedWith, ['plugins:pnpm-workspace', 'plugins:patch:patches/foo.patch']);
  assert.deepEqual(pf?.lockedWith, ['plugins:pnpm-workspace', 'plugins:patch:patches/foo.patch']);
});

test('plugins：取消勾选 pnpm-workspace 时 patch 文件一并剔除（全或无，绝不产出半套）', async () => {
  const ctx = makeContext('win32', HOME, 'web');
  ctx.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true });
  await write(ctx, PNPM_WORKSPACE_REL('web'), 'patchedDependencies:\n  foo@1.0.0: patches/foo.patch\n');
  await write(ctx, `${PNPM_PROFILE_DIR('web')}/patches/foo.patch`, 'diff --git a/x b/x\n');
  const adapter = new PluginsAdapter();

  const full = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(full.data.patchFiles?.length, 1, '前置条件：patch 文件已被收集');
  assert.equal(typeof full.data.pnpmWorkspace, 'string');

  // 只勾插件、不勾 workspace（UI 的 lockedWith 若失效，这里是最后一道防线）
  const filtered = await adapter.export(ctx, { includeSecrets: false, includeItems: { plugins: ['plugin:pkg-a'] } });
  assert.equal(filtered.data.pnpmWorkspace, null, '未勾选时不得搬运 pnpm-workspace.yaml');
  assert.equal(filtered.data.patchFiles, undefined, '声明被剔除后 patch 文件不得被孤立带走');
  assert.deepEqual(filtered.data.plugins.map((p) => p.name), ['pkg-a']);
});

test('Exporter：空白名单 = 整分区剔除，manifest/report 如实反映（不产出空载荷分区）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-units-'));
  try {
    const ctx = makeContext('win32', HOME);
    await write(ctx, 'skills/alpha.md', 'a');
    ctx.workspace.records.set('ws-1', { id: 'ws-1', path: 'C:\\a', sessionIds: [] });
    const exporter = new Exporter({
      ctx, adapters: createAdapters({ namespaces: [] }), exporterVersion: '0.0.0-test',
      now: () => new Date('2026-09-20T00:00:00.000Z'),
    });
    const zipPath = path.join(tmp, 'units.zip');
    const result = await exporter.export({
      includeSecrets: false, only: ['skills', 'workspaces'],
      includeItems: { skills: [] },
      outPath: zipPath,
    });
    assert.equal(result.manifest.sections['skills'], false, '空白名单分区必须为 false');
    assert.equal(result.manifest.sections['workspaces'], true);
    assert.ok(result.report.excluded.includes('skills'));
    assert.equal(result.report.included.some((s) => s.section === 'skills'), false);

    // 反向：非空白名单 → 分区在，且只含勾选单元
    const zip2 = path.join(tmp, 'units2.zip');
    const r2 = await exporter.export({
      includeSecrets: false, only: ['skills', 'workspaces'],
      includeItems: { skills: ['skills:alpha.md'], workspaces: [] },
      outPath: zip2,
    });
    assert.equal(r2.manifest.sections['skills'], true);
    assert.equal(r2.manifest.sections['workspaces'], false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('units：单元 id 归一化（Windows 反斜杠不得造成同一单元分裂成两个 id）', () => {
  assert.equal(toPosixRel('skills\\bundle\\SKILL.md'), 'skills/bundle/SKILL.md');
  assert.equal(defaultUnitId('bundle\\SKILL.md'), 'bundle');
  assert.equal(defaultUnitId('flat.md'), 'flat.md');
});
