// [doc-index] 守卫单测：直接跑 scripts/doc-index-coverage.mjs 的真实实现（不复制正则）。
// 覆盖两跳模型：docs/index.md → 分区 README → 分区内每份文档。
// 用例：条目行收录、相对链接、漏收录、正文提到不算、裸文件名命中、缺分区 README、真实仓库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = (await import(new URL('../scripts/doc-index-coverage.mjs', import.meta.url).href)) as {
  PARTITIONS: string[];
  isIndexed: (indexText: string, needle: string) => boolean;
  walkMarkdown: (dir: string) => string[];
  collectIndexCoverage: (args: { root: string; indexText: string; partitions?: string[] }) => {
    living: string[];
    unlisted: string[];
  };
  collectPartitionCoverage: (args: { root: string; partitions?: string[] }) => {
    living: string[];
    unlisted: string[];
    missingIndex: string[];
  };
};

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 临时仓库骨架：files 的 key 是仓库相对路径。 */
function withFixture<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'dcm-doc-index-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------- 第一跳：docs/index.md → 分区 README ----------------

test('第一跳：分区 README 在 index 表格行里 → 不报', () => {
  withFixture({ 'docs/contracts/README.md': '# contracts\n' }, (root) => {
    const r = mod.collectIndexCoverage({
      root,
      partitions: ['docs/contracts'],
      indexText: '| 契约 | `docs/contracts/README.md` | 仓外实现 |\n',
    });
    assert.deepEqual(r.living, ['docs/contracts/README.md']);
    assert.deepEqual(r.unlisted, []);
  });
});

test('第一跳：相对链接（含 <> 包裹）也算收录', () => {
  withFixture({ 'docs/architecture/README.md': '# arch\n' }, (root) => {
    const a = mod.collectIndexCoverage({
      root,
      partitions: ['docs/architecture'],
      indexText: '| 架构 | [架构](docs/architecture/README.md) |\n',
    });
    assert.deepEqual(a.unlisted, []);
    const b = mod.collectIndexCoverage({
      root,
      partitions: ['docs/architecture'],
      indexText: '- [架构](<docs/architecture/README.md>) — 分层与目录\n',
    });
    assert.deepEqual(b.unlisted, []);
  });
});

test('第一跳：漏收录 → 报一份；正文顺带提到不算', () => {
  withFixture({ 'docs/adr/README.md': '# adr\n' }, (root) => {
    const prose = mod.collectIndexCoverage({
      root,
      partitions: ['docs/adr'],
      indexText: '详见 `docs/adr/README.md`。\n',
    });
    assert.deepEqual(prose.unlisted, ['docs/adr/README.md']);
    assert.equal(mod.isIndexed('详见 `docs/adr/README.md`。', 'docs/adr/README.md'), false);
  });
});

test('第一跳：分区缺 README → 不计入 living（分区的第二跳会报 missingIndex）', () => {
  withFixture({ 'docs/agents/issue-tracker.md': '# t\n' }, (root) => {
    const r = mod.collectIndexCoverage({ root, partitions: ['docs/agents'], indexText: '' });
    assert.deepEqual(r.living, []);
    assert.deepEqual(r.unlisted, []);
  });
});

// ---------------- 第二跳：分区 README → 分区内文档 ----------------

test('第二跳：裸文件名在分区 README 列表项里 → 不报', () => {
  withFixture(
    {
      'docs/evidence/README.md': '# 证据\n\n- `sync-channel.md` — 同步通道实测\n',
      'docs/evidence/sync-channel.md': '# s\n',
    },
    (root) => {
      const r = mod.collectPartitionCoverage({ root, partitions: ['docs/evidence'] });
      assert.deepEqual(r.living, ['docs/evidence/sync-channel.md']);
      assert.deepEqual(r.unlisted, []);
      assert.deepEqual(r.missingIndex, []);
    },
  );
});

test('第二跳：只写路径前缀或漏写 → 报', () => {
  withFixture(
    {
      'docs/known-issues/README.md': '| 文档 | 用途 |\n|---|---|\n| `known-limits.md` | 限制 |\n',
      'docs/known-issues/known-limits.md': '# l\n',
      'docs/known-issues/tech-debt.md': '# t\n',
    },
    (root) => {
      const r = mod.collectPartitionCoverage({ root, partitions: ['docs/known-issues'] });
      assert.deepEqual(r.living, ['docs/known-issues/known-limits.md', 'docs/known-issues/tech-debt.md']);
      assert.deepEqual(r.unlisted, ['docs/known-issues/tech-debt.md']);
    },
  );
});

test('第二跳：分区 README 自身不计入成员；缺 README → missingIndex', () => {
  withFixture(
    {
      'docs/contributing/README.md': '# c\n',
      'docs/contracts/sync-channel-v1.md': '# v1\n',
    },
    (root) => {
      const r = mod.collectPartitionCoverage({ root, partitions: ['docs/contributing', 'docs/contracts'] });
      assert.deepEqual(r.living, []);
      assert.deepEqual(r.missingIndex, ['docs/contracts/README.md']);
    },
  );
});

test('walkMarkdown 递归收集且跳过不存在目录', () => {
  withFixture({ 'docs/archive/2026-10/a.md': '# a\n', 'docs/archive/b.md': '# b\n' }, (root) => {
    const files = mod.walkMarkdown(join(root, 'docs/archive')).map((f) => f.slice(root.length + 1));
    assert.deepEqual(files.sort(), ['docs\\archive\\2026-10\\a.md', 'docs\\archive\\b.md']);
    assert.deepEqual(mod.walkMarkdown(join(root, 'docs/nope')), []);
  });
});

// ---------------- 真实仓库 ----------------

test('真实仓库：八个分区 README 都在 docs/index.md 有条目行', () => {
  const indexText = readFileSync(join(REPO_ROOT, 'docs/index.md'), 'utf8');
  const r = mod.collectIndexCoverage({ root: REPO_ROOT, indexText });
  assert.deepEqual(r.unlisted, [], '未收录：' + r.unlisted.join(', '));
  assert.equal(r.living.length, mod.PARTITIONS.length);
  assert.deepEqual([...r.living].sort(), [...new Set(r.living)].sort());
});

test('真实仓库：分区内每份文档都在所属分区 README 有条目行（archive 除外）', () => {
  const partitions = mod.PARTITIONS.filter((d) => d !== 'docs/archive');
  const r = mod.collectPartitionCoverage({ root: REPO_ROOT, partitions });
  assert.deepEqual(r.missingIndex, [], '缺 README：' + r.missingIndex.join(', '));
  assert.deepEqual(r.unlisted, [], '未收录：' + r.unlisted.join(', '));
  assert.ok(r.living.length >= 35, 'living=' + r.living.length);
});
