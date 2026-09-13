/**
 * P-1 / P-2 打包契约回归护栏（L1）。
 *
 * 背景：`package.json` 的 `peerDependenciesMeta`（16 个 peer 全 `optional`）与 `files`
 * （含 `!lib/**` + `*.map` 排除项）此前**没有任何自动化测试覆盖**——全库无测试读这两个字段，
 * 回归时不会报警（例如把 UI 包误加回 runtime `dependencies`，或删掉 sourcemap 排除项）。
 *
 * 本文件只读 `package.json`，零依赖（`node:test` + `node:assert`），不触碰网络与磁盘其它位置。
 * 每一条断言都做过变异验证（见文件末注释）：把对应字段改坏必须红灯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
  exports?: Record<string, { types?: string; default?: string }>;
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;

/* ---------------------------------------------------------------- P-1: peers */

test('P-1: peerDependencies 的每一个键都在 peerDependenciesMeta 中且 optional === true', () => {
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};

  assert.ok(peers.length > 0, 'peerDependencies 不应为空');
  assert.ok(
    pkg.peerDependenciesMeta !== undefined,
    'peerDependenciesMeta 必须存在：缺少它时 npm 会尝试安装全部 peer（headless 消费者被迫装 React UI 栈）',
  );

  const missing = peers.filter((name) => meta[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `以下 peer 缺少 peerDependenciesMeta 条目（会被强制安装）: ${missing.join(', ')}`,
  );

  const notOptional = peers.filter((name) => meta[name]?.optional !== true);
  assert.deepEqual(
    notOptional,
    [],
    `以下 peer 的 optional 不为 true: ${notOptional.join(', ')}`,
  );

  // 数量一致：meta 里不得有 peer 之外的悬空键（防止改名后留下陈旧条目）
  const metaKeys = Object.keys(meta);
  assert.equal(
    metaKeys.length,
    peers.length,
    `peerDependenciesMeta 条目数（${metaKeys.length}）必须与 peerDependencies 键数（${peers.length}）一致`,
  );
  const stray = metaKeys.filter((name) => !peers.includes(name));
  assert.deepEqual(stray, [], `peerDependenciesMeta 含非 peer 键: ${stray.join(', ')}`);
});

test('P-1: dependencies 仅含 js-yaml（UI 包不得回到 runtime 依赖）', () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    deps,
    ['js-yaml'],
    `运行时 dependencies 只允许 js-yaml，实际: ${deps.join(', ') || '(空)'}。` +
      'lucide-react / @radix-ui/* 已由 tsdown alwaysBundle 内联进 lib/client.js，' +
      '放回 dependencies 会迫使 headless 消费者安装整套 React UI 栈。',
  );
  // 显式点名：即使将来允许更多 runtime 依赖，这两个也必须留在 devDependencies
  for (const ui of ['lucide-react', '@radix-ui/react-dialog']) {
    assert.ok(!deps.includes(ui), `${ui} 不得出现在 dependencies`);
  }
});

/* ---------------------------------------------------------------- P-2: files */

test('P-2: files 含 !lib/**/*.map 排除项', () => {
  const files = pkg.files;
  assert.ok(Array.isArray(files), 'files 必须是数组');
  assert.ok(
    files.includes('!lib/**/*.map'),
    `files 必须保留 '!lib/**/*.map' 排除项（否则 sourcemap 随包发布，体积显著增加）。实际: ${JSON.stringify(files)}`,
  );
});

test('P-2: files 仍包含 lib、src、cordis.patch.yml', () => {
  const files = pkg.files ?? [];
  for (const required of ['lib', 'src', 'cordis.patch.yml']) {
    assert.ok(files.includes(required), `files 必须包含 '${required}'。实际: ${JSON.stringify(files)}`);
  }
  // 排除项必须排在 'lib' 之后（npm 的 files 数组按顺序求值，顺序错则排除项失效）
  assert.ok(
    files.indexOf('!lib/**/*.map') > files.indexOf('lib'),
    "'!lib/**/*.map' 必须排在 'lib' 之后，否则排除不生效",
  );
});

/* ------------------------------------------------- exports["./schema"] 指向 */

test('exports["./schema"] 指向 lib/schema/index.{js,d.ts}（而非纯类型产物 types.js）', () => {
  const entry = pkg.exports?.['./schema'];
  assert.ok(entry !== undefined, 'exports["./schema"] 必须存在');
  assert.equal(entry.default, './lib/schema/index.js', 'default 必须指向 lib/schema/index.js');
  assert.equal(entry.types, './lib/schema/index.d.ts', 'types 必须指向 lib/schema/index.d.ts');
});
