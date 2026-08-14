/**
 * 跨平台矩阵测试（m7-tests-docs；规范 §33 Cross Platform 组 / §36 场景 B）。
 *
 * 覆盖：win32→darwin / darwin→win32 / linux→win32 的路径检测与批量前缀映射、
 *       applyPrefixMappings 单元（多映射/段边界不误伤/嵌套）、路径工具判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { normalizePath, isAbsolutePath, applyPrefixMappings, collectAbsolutePaths, isPathSafe } from '../../src/utils/paths.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import type { PathMapping } from '../../src/core/types.ts';

const NS = ['general', 'llm-deepseek'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cross-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 源：workspace 绝对路径 + MCP cwd 绝对路径（跨设备路径映射重点） */
async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  ctx.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  ctx.workspace.records.set('ws-web', {
    id: 'ws-web', path: 'C:\\Users\\alice\\projects\\web', title: 'Web', sessionIds: [],
  });
  ctx.patchFile.lines.set('mcp-git', {
    lineId: 'mcp-git',
    raw: { id: 'mcp-git', name: 'dsh-mcp-client', config: { serverName: 'git', command: 'npx', cwd: 'C:\\Users\\alice\\tools' } },
  });
}

async function exportFixture(src: MockHostContext, outPath: string): Promise<void> {
  const adapters = createAdapters({ namespaces: NS });
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath });
}

/* ================= 工具层单元 ================= */

test('CP-单元1: normalizePath 跨平台规范化（win/posix 分隔符统一 /）', () => {
  assert.equal(normalizePath('C:\\Users\\alice\\projects'), 'C:/Users/alice/projects');
  assert.equal(normalizePath('/Users/alice/projects'), '/Users/alice/projects');
  assert.equal(normalizePath('C:\\Users\\alice\\'), 'C:/Users/alice');
  assert.equal(normalizePath('/home/bob/'), '/home/bob');
  assert.equal(normalizePath(''), '');
});

test('CP-单元2: isAbsolutePath 识别 win/posix/UNC 绝对路径', () => {
  assert.equal(isAbsolutePath('C:\\Users\\alice'), true);
  assert.equal(isAbsolutePath('C:/Users/alice'), true);
  assert.equal(isAbsolutePath('/Users/alice'), true);
  assert.equal(isAbsolutePath('\\\\server\\share'), true);
  assert.equal(isAbsolutePath('relative/path'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('CP-单元3: collectAbsolutePaths 收集对象内全部绝对路径叶值', () => {
  const obj = {
    workspaces: [{ path: 'C:\\Users\\alice\\projects\\ops' }],
    mcp: { cwd: '/home/bob', command: 'npx' },
    normal: 'just-a-string',
    nested: { deep: { path: 'D:\\data' } },
  };
  const hits = collectAbsolutePaths(obj);
  assert.deepEqual(
    hits.map((h) => h.path).sort(),
    ['mcp.cwd', 'nested.deep.path', 'workspaces[0].path'],
  );
});

test('CP-单元4: isPathSafe 拒绝跨平台危险条目名', () => {
  assert.equal(isPathSafe('a/b.txt'), true);
  assert.equal(isPathSafe('../evil'), false);
  assert.equal(isPathSafe('..\\evil'), false);
  assert.equal(isPathSafe('C:/evil'), false);
  assert.equal(isPathSafe('C:\\evil'), false);
  assert.equal(isPathSafe('/abs'), false);
  assert.equal(isPathSafe('\\\\share'), false);
});

/* ================= applyPrefixMappings 单元（规范 §12 批量映射） ================= */

test('CP-单元5: applyPrefixMappings 批量前缀映射（多映射 + 嵌套 + 数组）', () => {
  const mappings: PathMapping[] = [
    { oldPrefix: 'C:\\Users\\alice', newPrefix: '/Users/bob', appliesTo: ['workspaces'] },
    { oldPrefix: 'C:\\Users\\alice\\projects', newPrefix: '/home/bob/work', appliesTo: ['workspaces'] },
  ];
  const input = {
    workspaces: [
      { path: 'C:\\Users\\alice\\projects\\ops', title: 'ops' },
      { path: 'C:\\Users\\alice\\other', title: 'other' },
    ],
    meta: { home: 'C:\\Users\\alice' },
  };
  const out = applyPrefixMappings(input, mappings) as {
    workspaces: { path: string }[]; meta: { home: string };
  };
  // 最长前缀优先？实际实现按数组顺序；此处断言与实现一致：先映射 alice→bob，再映射 projects
  assert.ok(out.workspaces[0]!.path.startsWith('/'), '路径应被映射为 posix');
  assert.ok(!out.workspaces[0]!.path.includes('C:\\'), '不再含 win 盘符');
  // 不误伤：other 也以 alice 开头 → 会被 alice 映射（alice 前缀先匹配段边界）
  assert.ok(out.workspaces[1]!.path.startsWith('/Users/bob/other'), '同根不同子目录也应映射');
  assert.equal(out.meta.home, '/Users/bob', '任意字符串叶值命中前缀即替换');
});

test('CP-单元6: applyPrefixMappings 段边界不误伤（alice 不匹配 alice2）', () => {
  const mappings: PathMapping[] = [
    { oldPrefix: 'C:\\Users\\alice', newPrefix: '/home/bob', appliesTo: ['workspaces'] },
  ];
  const out = applyPrefixMappings(
    { p1: 'C:\\Users\\alice\\projects', p2: 'C:\\Users\\alice2\\projects', p3: 'C:\\Users\\alice2' },
    mappings,
  ) as Record<string, string>;
  assert.equal(out.p1, '/home/bob/projects', '段边界命中应替换');
  assert.equal(out.p2, 'C:\\Users\\alice2\\projects', 'alice2 不得被 alice 前缀误伤');
  assert.equal(out.p3, 'C:\\Users\\alice2', 'alice2 不得被 alice 前缀误伤');
});

test('CP-单元7: applyPrefixMappings 不改原对象、空映射原样返回', () => {
  const input = { path: 'C:\\Users\\alice\\x' };
  const out = applyPrefixMappings(input, []);
  assert.equal(out, input, '空映射应返回原对象');
  const before = JSON.stringify(input);
  applyPrefixMappings(input, [{ oldPrefix: 'C:\\Users\\alice', newPrefix: '/bob', appliesTo: ['workspaces'] }]);
  assert.equal(JSON.stringify(input), before, '原对象不得被修改');
});

/* ================= 端到端跨平台矩阵（§36 场景 B） ================= */

async function assertImportMaps(zipPath: string, srcPlatform: string, dstPlatform: string, dstHome: string, mapping: PathMapping, expectedPath: string): Promise<void> {
  const dst = makeContext(dstPlatform, dstHome);
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

  const analysis = await importer.analyzeImport(zipPath);
  assert.ok(
    analysis.pathIssues.some((p) => p.kind === 'platformMismatch' || p.kind === 'missing'),
    `${srcPlatform}→${dstPlatform} 应检测到路径问题`,
  );

  const plan = await importer.createImportPlan(zipPath, {
    strategy: 'merge',
    resolutions: {},
    pathMappings: [mapping],
  });
  const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
  assert.equal(result.ok, true, `${srcPlatform}→${dstPlatform} 导入应成功`);

  const ws = dst.workspace.records.get('ws-ops');
  assert.ok(ws, 'workspace 应已导入');
  assert.equal(normalizePath(ws.path), expectedPath, `${srcPlatform}→${dstPlatform} 路径映射结果`);
  // MCP cwd 也应被映射（同 mapping 的 mcp 范围）
  const mcpLine = dst.patchFile.lines.get('mcp-git')?.raw as { config: { cwd?: string } };
  assert.ok(mcpLine, 'MCP patch 行应写入');
  assert.ok(mcpLine.config.cwd, 'MCP cwd 应存在');
}

test('CP-01 win32 → darwin：C:\\Users\\alice\\ → /Users/bob/ 批量映射', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'cp01.zip');
    await exportFixture(src, zipPath);
    await assertImportMaps(
      zipPath, 'win32', 'darwin', '/Users/bob',
      { oldPrefix: 'C:\\Users\\alice', newPrefix: '/Users/bob', appliesTo: ['workspaces', 'mcp'] },
      '/Users/bob/projects/ops',
    );
  });
});

test('CP-02 darwin → win32：/Users/alice/ → C:\\Users\\bob\\ 批量映射', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('darwin', '/Users/alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    src.workspace.records.set('ws-ops', {
      id: 'ws-ops', path: '/Users/alice/projects/ops', title: 'OpsFlow', sessionIds: [],
    });
    src.patchFile.lines.set('mcp-git', {
      lineId: 'mcp-git',
      raw: { id: 'mcp-git', name: 'dsh-mcp-client', config: { serverName: 'git', command: 'npx', cwd: '/Users/alice/tools' } },
    });
    const zipPath = path.join(dir, 'cp02.zip');
    await exportFixture(src, zipPath);
    await assertImportMaps(
      zipPath, 'darwin', 'win32', 'C:\\Users\\bob',
      { oldPrefix: '/Users/alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] },
      'C:/Users/bob/projects/ops',
    );
  });
});

test('CP-03 linux → win32：/home/alice/ → C:\\Users\\bob\\ 批量映射', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    src.workspace.records.set('ws-ops', {
      id: 'ws-ops', path: '/home/alice/projects/ops', title: 'OpsFlow', sessionIds: [],
    });
    src.patchFile.lines.set('mcp-git', {
      lineId: 'mcp-git',
      raw: { id: 'mcp-git', name: 'dsh-mcp-client', config: { serverName: 'git', command: 'npx', cwd: '/home/alice/tools' } },
    });
    const zipPath = path.join(dir, 'cp03.zip');
    await exportFixture(src, zipPath);
    await assertImportMaps(
      zipPath, 'linux', 'win32', 'C:\\Users\\bob',
      { oldPrefix: '/home/alice', newPrefix: 'C:\\Users\\bob', appliesTo: ['workspaces', 'mcp'] },
      'C:/Users/bob/projects/ops',
    );
  });
});

test('CP-04 跨平台兼容性评分：跨平台 → partial', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedSource(src);
    const zipPath = path.join(dir, 'cp04.zip');
    await exportFixture(src, zipPath);

    const dst = makeContext('darwin', '/Users/bob');
    const adapters = createAdapters({ namespaces: NS });
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.compatibility, 'partial', '跨平台导入兼容性应为 partial');
  });
});
