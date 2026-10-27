// [doc-index] 守卫单测：直接跑 scripts/doc-index-coverage.mjs 的真实实现（不复制正则）。
// 覆盖：表格行/列表项收录、相对链接、漏收录、正文提到路径不算收录、排除目录、豁免表、真实仓库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = (await import(new URL('../scripts/doc-index-coverage.mjs', import.meta.url).href)) as {
  INDEX_COVERAGE_DIRS: string[];
  INDEX_COVERAGE_EXEMPT: Map<string, string>;
  isIndexed: (indexText: string, rel: string) => boolean;
  walkMarkdown: (dir: string) => string[];
  collectIndexCoverage: (args: {
    root: string;
    indexText: string;
    docDirs?: string[];
    exempt?: Map<string, string>;
  }) => { living: string[]; unlisted: string[]; exempted: string[] };
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

test('索引表格行收录 → 不报', () => {
  withFixture({ 'docs/spec/a.md': '# a\n' }, (root) => {
    const r = mod.collectIndexCoverage({ root, indexText: '| 契约 | `docs/spec/a.md` | 说明 |\n' });
    assert.deepEqual(r.living, ['docs/spec/a.md']);
    assert.deepEqual(r.unlisted, []);
  });
});

test('索引列表项收录（ADR 形态）→ 不报', () => {
  withFixture({ 'docs/decisions/0001-x.md': '# 1\n' }, (root) => {
    const r = mod.collectIndexCoverage({ root, indexText: '- `docs/decisions/0001-x.md` — 路由围栏\n' });
    assert.deepEqual(r.unlisted, []);
  });
});

test('相对 Markdown 链接（含 <> 包裹）也算收录', () => {
  withFixture({ 'docs/modules/m.md': '# m\n' }, (root) => {
    const a = mod.collectIndexCoverage({ root, indexText: '| 模块 | [m](docs/modules/m.md) |\n' });
    assert.deepEqual(a.unlisted, []);
    const b = mod.collectIndexCoverage({ root, indexText: '| 模块 | [m](<docs/modules/m.md>) |\n' });
    assert.deepEqual(b.unlisted, []);
  });
});

test('漏收录 → 报一份', () => {
  withFixture({ 'docs/spec/a.md': '# a\n' }, (root) => {
    const r = mod.collectIndexCoverage({ root, indexText: '| 别的 | `docs/spec/b.md` |\n' });
    assert.deepEqual(r.unlisted, ['docs/spec/a.md']);
  });
});

test('正文顺带提到路径不算收录（只有索引条目行才算）', () => {
  withFixture({ 'docs/spec/a.md': '# a\n' }, (root) => {
    const prose = mod.collectIndexCoverage({ root, indexText: '详细说明见 `docs/spec/a.md`。\n' });
    assert.deepEqual(prose.unlisted, ['docs/spec/a.md']);
    const prefixTrap = mod.collectIndexCoverage({ root, indexText: '| x | `docs/spec/a.md.bak` |\n' });
    assert.deepEqual(prefixTrap.unlisted, ['docs/spec/a.md']);
    assert.equal(mod.isIndexed('详细说明见 `docs/spec/a.md`。', 'docs/spec/a.md'), false);
  });
});

test('排除目录不被扫描（lessons / design / 冻结存档）', () => {
  withFixture(
    {
      'docs/spec/a.md': '# a\n',
      'docs/lessons/l.md': '# l\n',
      'docs/design/d.md': '# d\n',
      'docs/lessons/known-pitfalls.md': '# p\n',
    },
    (root) => {
      const r = mod.collectIndexCoverage({ root, indexText: '| 契约 | `docs/spec/a.md` |\n' });
      assert.deepEqual(r.living, ['docs/spec/a.md']);
      assert.deepEqual(r.unlisted, []);
    },
  );
});

test('豁免表生效：登记即不报，理由随表保存', () => {
  withFixture({ 'docs/spec/a.md': '# a\n' }, (root) => {
    const exempt = new Map([['docs/spec/a.md', '私有备注，故意不进索引']]);
    const r = mod.collectIndexCoverage({ root, indexText: '', exempt });
    assert.deepEqual(r.unlisted, []);
    assert.deepEqual(r.exempted, ['docs/spec/a.md']);
    assert.equal(exempt.get('docs/spec/a.md'), '私有备注，故意不进索引');
  });
});

test('非法/空目录输入不炸（缺目录 → living 为空）', () => {
  withFixture({ 'docs/spec/a.md': '# a\n' }, (root) => {
    const r = mod.collectIndexCoverage({ root, indexText: '', docDirs: ['docs/not-exist'] });
    assert.deepEqual(r.living, []);
    assert.deepEqual(r.unlisted, []);
  });
});

test('真实仓库：五目录每份活文档都在 docs/index.md 有条目行', () => {
  const indexText = readFileSync(join(REPO_ROOT, 'docs/index.md'), 'utf8');
  const r = mod.collectIndexCoverage({ root: REPO_ROOT, indexText });
  assert.deepEqual(r.unlisted, [], '未收录：' + r.unlisted.join(', '));
  assert.ok(r.living.length >= 19, 'living=' + r.living.length);
  assert.deepEqual([...r.living].sort(), [...new Set(r.living)].sort());
  assert.ok(mod.INDEX_COVERAGE_DIRS.every((d) => r.living.some((p) => p.startsWith(d + '/'))), '五目录应各自至少一份');
});
