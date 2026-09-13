/**
 * local-plugin-pack 单测：spec 分类 / 路径解析 / 命名安全 / 打包编排（假 exec，离线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  classifyPluginSpec,
  isLocalPluginSpec,
  safePackageFileFragment,
  tarballNameFor,
  resolveLocalPluginPath,
  rewriteLocalSpec,
  isPackedLocalSpec,
  parsePackOutput,
  packLocalPlugins,
  isBareLocalPath,
  LOCAL_PLUGIN_DIR,
  MAX_LOCAL_TARBALL_BYTES,
} from './local-plugin-pack.ts';
import type { PackExec, PackExecResult } from './local-plugin-pack.ts';

/* ---------------- classifyPluginSpec ---------------- */

test('T1 classify: link/file 本地源', () => {
  assert.equal(classifyPluginSpec('link:D:/Projects/x'), 'link');
  assert.equal(classifyPluginSpec('file:./x.tgz'), 'file');
  assert.equal(classifyPluginSpec('file:/abs/x.tgz'), 'file');
});

test('T1 classify: 大小写不敏感 + 首尾空白容忍', () => {
  assert.equal(classifyPluginSpec('Link:D:/x'), 'link');
  assert.equal(classifyPluginSpec('LINK:D:/x'), 'link');
  assert.equal(classifyPluginSpec('  link:D:/x  '), 'link');
  assert.equal(classifyPluginSpec('FILE:./x.tgz'), 'file');
  assert.equal(isLocalPluginSpec('  LiNk:/x  '), true);
});

test('T1 classify: git 类来源', () => {
  for (const s of [
    'github:user/repo',
    'gitlab:u/r',
    'bitbucket:u/r',
    'git+https://x/y.git',
    'https://example.com/a.tgz',
    'http://example.com/a.tgz',
    'GitHub:User/Repo',
  ]) {
    assert.equal(classifyPluginSpec(s), 'git', s);
  }
});

test('T1 classify: registry 类（版本区间 / workspace / 空）', () => {
  for (const s of ['^1.2.3', '~1.2', '1.2.3', 'latest', '*', 'workspace:*', 'workspace:^', '']) {
    assert.equal(classifyPluginSpec(s), 'registry', s);
  }
  assert.equal(classifyPluginSpec(undefined), 'registry');
});

test('T1 classify: 非本地源一律 isLocalPluginSpec=false', () => {
  for (const s of ['^1.0.0', 'github:u/r', 'workspace:*', '', undefined]) {
    assert.equal(isLocalPluginSpec(s), false, String(s));
  }
});

/* ---------------- 命名安全 ---------------- */

test('T1 tarballNameFor: 含 scope 的包名不含任何路径分隔符', () => {
  const rel = tarballNameFor('@scope/name', '1.2.3');
  assert.ok(!rel.includes('\\'), `不得含反斜杠: ${rel}`);
  // 只允许 local-plugins/ 这一层分隔，文件名部分不得再有斜杠
  const parts = rel.split('/');
  assert.equal(parts.length, 2, `路径层级应恰为 2: ${rel}`);
  assert.equal(parts[0], LOCAL_PLUGIN_DIR);
  assert.ok(!parts[1]!.includes('/'), `文件名不得含斜杠: ${parts[1]}`);
});

test('T1 tarballNameFor: 普通包名与版本拼装', () => {
  assert.equal(tarballNameFor('my-plugin', '0.1.0'), `${LOCAL_PLUGIN_DIR}/my-plugin-0.1.0.tgz`);
});

test('T1 tarballNameFor: 版本含非法字符被折叠', () => {
  const rel = tarballNameFor('pkg', '1.0.0+build/2');
  assert.ok(!rel.includes('/'.repeat(1) + 'b'), rel);
  assert.ok(rel.endsWith('.tgz'), rel);
  assert.equal(rel.split('/').length, 2);
});

test('T1 safePackageFileFragment: 各类危险字符被中和', () => {
  assert.equal(safePackageFileFragment('@scope/name'), '@scope__name');
  assert.equal(safePackageFileFragment('a\\b'), 'a__b');
  assert.ok(!safePackageFileFragment('x y:z').includes(':'));
  assert.ok(!safePackageFileFragment('x y:z').includes(' '));
});

/* ---------------- resolveLocalPluginPath ---------------- */

test('T1 resolveLocalPluginPath: 绝对路径三种前缀形态', () => {
  const opts = { homeDir: '/home/u', profileDir: '/home/u/.dsh/profiles/web' };
  assert.equal(resolveLocalPluginPath('link:/abs/plugin', opts), path.normalize('/abs/plugin'));
  assert.equal(resolveLocalPluginPath('file:/abs/x.tgz', opts), path.normalize('/abs/x.tgz'));
  // 裸绝对路径（无前缀）
  assert.equal(resolveLocalPluginPath('/abs/bare', opts), path.normalize('/abs/bare'));
});

test('T1 resolveLocalPluginPath: 相对路径以 profileDir 为基准', () => {
  const opts = { homeDir: '/home/u', profileDir: '/home/u/.dsh/profiles/web' };
  assert.equal(
    resolveLocalPluginPath('link:./sub/plugin', opts),
    path.resolve('/home/u/.dsh/profiles/web', './sub/plugin'),
  );
  assert.equal(
    resolveLocalPluginPath('link:../up', opts),
    path.resolve('/home/u/.dsh/profiles/web', '../up'),
  );
});

test('T1 resolveLocalPluginPath: ~ 按 homeDir 展开', () => {
  const opts = { homeDir: '/home/u', profileDir: '/x' };
  assert.equal(resolveLocalPluginPath('link:~', opts), '/home/u');
  assert.equal(resolveLocalPluginPath('link:~/plugins/a', opts), path.resolve('/home/u', 'plugins/a'));
});

test('T1 resolveLocalPluginPath: 首尾空白被容忍', () => {
  const opts = { homeDir: '/home/u', profileDir: '/p' };
  assert.equal(resolveLocalPluginPath('  link:./a  ', opts), path.resolve('/p', './a'));
});

/* ---------------- rewriteLocalSpec / isPackedLocalSpec ---------------- */

test('T1 rewriteLocalSpec: 产出 file: 前缀且幂等', () => {
  const once = rewriteLocalSpec('link:D:/x', { tarballRel: `${LOCAL_PLUGIN_DIR}/a-1.0.0.tgz` });
  assert.equal(once, `file:${LOCAL_PLUGIN_DIR}/a-1.0.0.tgz`);
  const twice = rewriteLocalSpec(once, { tarballRel: `${LOCAL_PLUGIN_DIR}/a-1.0.0.tgz` });
  assert.equal(twice, once, '幂等：再次重写不改变结果');
});

test('T1 rewriteLocalSpec: 反斜杠归一为正斜杠', () => {
  const out = rewriteLocalSpec('link:x', { tarballRel: 'local-plugins\\a.tgz' });
  assert.ok(!out.includes('\\'), out);
  assert.equal(out, 'file:local-plugins/a.tgz');
});

test('T1 isPackedLocalSpec: 只认 local-plugins 下的 file: 形式', () => {
  assert.equal(isPackedLocalSpec('file:local-plugins/a.tgz'), true);
  assert.equal(isPackedLocalSpec('File:local-plugins/a.tgz'), true);
  assert.equal(isPackedLocalSpec('file:local-plugins\\a.tgz'), true);
  assert.equal(isPackedLocalSpec('file:/abs/elsewhere.tgz'), false);
  assert.equal(isPackedLocalSpec('link:local-plugins/a.tgz'), false);
  assert.equal(isPackedLocalSpec('^1.0.0'), false);
  assert.equal(isPackedLocalSpec(undefined), false);
});

/* ---------------- parsePackOutput ---------------- */

test('T1 parsePackOutput: --json 数组形态', () => {
  const out = JSON.stringify([{ filename: 'pkg-1.0.0.tgz', size: 10, entryCount: 3 }]);
  assert.equal(parsePackOutput(out, 'pkg', '1.0.0'), 'pkg-1.0.0.tgz');
});

test('T1 parsePackOutput: 单对象形态', () => {
  assert.equal(parsePackOutput(JSON.stringify({ filename: 'x.tgz' }), 'x', '1'), 'x.tgz');
});

test('T1 parsePackOutput: JSON 前有 npm 进度日志仍可解析', () => {
  const mixed = `npm notice something\n${JSON.stringify([{ filename: 'y-2.0.0.tgz' }])}`;
  assert.equal(parsePackOutput(mixed, 'y', '2.0.0'), 'y-2.0.0.tgz');
});

test('T1 parsePackOutput: 纯文本兜底取末行', () => {
  assert.equal(parsePackOutput('npm notice\nfoo-1.0.0.tgz\n', 'foo', '1.0.0'), 'foo-1.0.0.tgz');
});

test('T1 parsePackOutput: 空输出返回 null（不可判定，交由调用方告警）', () => {
  // 设计：stdout 为空说明 npm 什么都没产出 → 不猜文件名，返回 null
  // （猜一个不存在的文件名只会在 readFile 阶段变成更难懂的 ENOENT）
  assert.equal(parsePackOutput('', 'my-pkg', '3.1.0'), null);
});

test('T1 parsePackOutput: 非空但无可用信息时按约定推导', () => {
  // 非 JSON、末行不以 .tgz 结尾 → 退化为按包名+版本约定推导（含 scope 折叠）
  assert.equal(parsePackOutput('garbage', '@s/n', '1.0.0'), 's-n-1.0.0.tgz');
});

/* ---------------- packLocalPlugins（假 exec，离线） ---------------- */

/** 记录调用并返回预设结果的假 exec */
function makeExec(handler: (file: string, args: string[], cwd: string) => PackExecResult): {
  exec: PackExec;
  calls: { file: string; args: string[]; cwd: string }[];
} {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const exec: PackExec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    return handler(file, args, opts.cwd);
  };
  return { exec, calls };
}

const okResult = (filename: string): PackExecResult => ({ stdout: JSON.stringify([{ filename }]), stderr: '', code: 0 });

test('T1 packLocalPlugins: 成功产出 entries 与 rewritten 映射', async () => {
  const { exec, calls } = makeExec(() => okResult('my-plugin-1.0.0.tgz'));
  const res = await packLocalPlugins({
    plugins: [{ name: 'my-plugin', version: '1.0.0', spec: 'link:D:/dev/my-plugin' }],
    homeDir: '/home/u',
    profileDir: '/home/u/.dsh/profiles/web',
    packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array([1, 2, 3]),
    mkdir: async () => undefined,
  });

  assert.equal(res.warnings.length, 0, res.warnings.join('; '));
  assert.equal(res.packed.length, 1);
  assert.equal(res.packed[0]!.relativePath, `${LOCAL_PLUGIN_DIR}/my-plugin-1.0.0.tgz`);
  assert.equal(res.packed[0]!.rewrittenSpec, `file:${LOCAL_PLUGIN_DIR}/my-plugin-1.0.0.tgz`);
  assert.equal(res.rewritten['my-plugin'], `file:${LOCAL_PLUGIN_DIR}/my-plugin-1.0.0.tgz`);
  // 断言调用形状：cwd = 插件目录，args = ['pack','.','--pack-destination',packDir]
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'npm');
  assert.deepEqual(calls[0]!.args, ['pack', '.', '--pack-destination', '/tmp/pack']);
});

test('T1 packLocalPlugins: 非本地源被跳过且不产生告警', async () => {
  const { exec, calls } = makeExec(() => okResult('x.tgz'));
  const res = await packLocalPlugins({
    plugins: [
      { name: 'reg', version: '1.0.0', spec: '^1.0.0' },
      { name: 'gitp', version: '1.0.0', spec: 'github:u/r' },
      { name: 'ws', version: '1.0.0', spec: 'workspace:*' },
    ],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array(),
    mkdir: async () => undefined,
  });
  assert.equal(res.packed.length, 0);
  assert.equal(res.warnings.length, 0);
  assert.equal(calls.length, 0, '非本地源不得调用 npm pack');
});

test('T1 packLocalPlugins: 单个失败进 warnings 但不抛错，其余继续', async () => {
  // 假 exec 按 cwd 区分：bad 失败、good 成功（各返回自己的文件名，避免撞名掩盖行为）
  const { exec } = makeExec((_f, _a, cwd) => {
    if (cwd.endsWith('bad')) return { stdout: '', stderr: 'npm ERR! not found', code: 1 };
    return okResult(`${path.basename(cwd)}-1.0.0.tgz`);
  });
  const res = await packLocalPlugins({
    plugins: [
      { name: 'bad', version: '1.0.0', spec: 'link:/dev/bad' },
      { name: 'good', version: '1.0.0', spec: 'link:/dev/good' },
    ],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array([9]),
    mkdir: async () => undefined,
  });
  assert.equal(res.packed.length, 1);
  assert.equal(res.packed[0]!.packageName, 'good');
  assert.equal(res.warnings.length, 1, res.warnings.join('; '));
  assert.ok(res.warnings[0]!.includes('bad'), String(res.warnings[0]));
});

test('T1 packLocalPlugins: 读文件抛错（tgz 不存在）→ 该项告警，不中断', async () => {
  // 假 exec 按 cwd 返回**各自**的文件名（否则两个插件会撞同一文件名，测不出真实行为）
  const { exec } = makeExec((_f, _a, cwd) => okResult(`${path.basename(cwd)}-1.0.0.tgz`));
  const res = await packLocalPlugins({
    plugins: [
      { name: 'p', version: '1.0.0', spec: 'link:/dev/p' },
      { name: 'q', version: '1.0.0', spec: 'link:/dev/q' },
    ],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async (abs) => {
      if (abs.includes('p-1.0.0')) throw new Error('ENOENT'); // 只有 p 的 tgz 读不到
      return new Uint8Array([7]);
    },
    mkdir: async () => undefined,
  });
  assert.equal(res.packed.length, 1);
  assert.equal(res.packed[0]!.packageName, 'q');
  assert.equal(res.warnings.length, 1, res.warnings.join('; '));
  assert.ok(res.warnings[0]!.includes('p'), String(res.warnings[0]));
});

test('T1 packLocalPlugins: 超过体积上限 → 跳过并告警', async () => {
  const { exec } = makeExec(() => okResult('big-1.0.0.tgz'));
  const res = await packLocalPlugins({
    plugins: [{ name: 'big', version: '1.0.0', spec: 'link:/dev/big' }],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array(MAX_LOCAL_TARBALL_BYTES + 1),
    mkdir: async () => undefined,
  });
  assert.equal(res.packed.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.ok(res.warnings[0]!.includes('上限'), String(res.warnings[0]));
});

test('T1 packLocalPlugins: mkdir 失败 → 全部跳过并告警，不抛错', async () => {
  const { exec } = makeExec(() => okResult('x-1.0.0.tgz'));
  const res = await packLocalPlugins({
    plugins: [{ name: 'x', version: '1.0.0', spec: 'link:/dev/x' }],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array(),
    mkdir: async () => { throw new Error('EACCES'); },
  });
  assert.equal(res.packed.length, 0);
  assert.equal(res.warnings.length, 1);
});

test('T1 packLocalPlugins: 无本地源插件时零开销（不 mkdir、不 exec）', async () => {
  let mkdirCalled = false;
  const { exec, calls } = makeExec(() => okResult('x.tgz'));
  const res = await packLocalPlugins({
    plugins: [{ name: 'a', version: '1', spec: '^1.0.0' }],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array(),
    mkdir: async () => { mkdirCalled = true; },
  });
  assert.equal(mkdirCalled, false, '无本地源时不得创建目录');
  assert.equal(calls.length, 0);
  assert.equal(res.warnings.length, 0);
});

test('T1 packLocalPlugins: 两种多个本地插件全部打包', async () => {
  const { exec } = makeExec((_f, _a, cwd) => okResult(path.basename(cwd) + '-1.0.0.tgz'));
  const res = await packLocalPlugins({
    plugins: [
      { name: 'one', version: '1.0.0', spec: 'link:/dev/one' },
      { name: 'two', version: '1.0.0', spec: 'file:/dev/two' },
    ],
    homeDir: '/h', profileDir: '/p', packDir: '/tmp/pack',
    exec,
    readFile: async () => new Uint8Array([1]),
    mkdir: async () => undefined,
  });
  assert.equal(res.packed.length, 2);
  assert.equal(Object.keys(res.rewritten).length, 2);
  assert.ok(res.rewritten['one']!.startsWith('file:'), String(res.rewritten['one']));
  assert.ok(res.rewritten['two']!.startsWith('file:'), String(res.rewritten['two']));
});

/* ---------------- isBareLocalPath ---------------- */

test('T1 isBareLocalPath: 识别裸本地路径', () => {
  assert.equal(isBareLocalPath('./x'), true);
  assert.equal(isBareLocalPath('../x'), true);
  assert.equal(isBareLocalPath('/abs/x'), true);
  assert.equal(isBareLocalPath('C:\\dev\\x'), true);
  assert.equal(isBareLocalPath('link:x'), false);
  assert.equal(isBareLocalPath('^1.0.0'), false);
  assert.equal(isBareLocalPath(''), false);
  assert.equal(isBareLocalPath(undefined), false);
});
