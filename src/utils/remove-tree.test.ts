/**
 * remove-tree 测试：复现并覆盖 `fs.rmSync(recursive, force)` 的静默失效。
 * - 基线（win32）：目录里一个悬空 junction ⇒ rmSync 不抛错也不删（回归判据）
 * - removeTreeSync / removeTree：普通嵌套、悬空链接、有效 junction（只删链接）、只读文件、深树
 * - 目标本身是链接 ⇒ 只删链接，指向的真实目录保留
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTree, removeTreeSync } from './remove-tree.ts';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function sandbox(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-'));
  t.after(() => { try { removeTreeSync(dir); } catch { /* 已删净 */ } });
  return dir;
}

function write(file: string, text = 'x'): void {
  fssync.mkdirSync(path.dirname(file), { recursive: true });
  fssync.writeFileSync(file, text);
}

test('removeTreeSync：普通嵌套目录整棵删掉', (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'profile');
  write(path.join(target, 'a', 'b', 'deep.txt'));
  write(path.join(target, 'top.txt'));
  write(path.join(target, '.dsh', 'config.yml'));
  removeTreeSync(target);
  assert.equal(fssync.existsSync(target), false);
});

test('removeTreeSync：悬空 junction 不再卡住删除（rm 静默失效的根因）', (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'profile');
  write(path.join(target, 'package.json'));
  write(path.join(target, 'node_modules', 'real-dep', 'index.js'));
  // DSH 的真实形态：node_modules/<pkg> -> 已消失的 .dsh-module-fallback/node_modules/<pkg>
  const danglingPkgs = ['immer', 'react', 'react-dom', 'scheduler'];
  for (const pkg of danglingPkgs) {
    fssync.symlinkSync(
      path.join(target, '.dsh-module-fallback', 'node_modules', pkg),
      path.join(target, 'node_modules', pkg),
      linkType,
    );
  }
  removeTreeSync(target);
  assert.equal(fssync.existsSync(target), false);
});

test('基线：fs.rmSync 遇到悬空 junction 会静默留下条目（按环境观察，不作强断言）', (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'profile');
  write(path.join(target, 'keep.txt'));
  write(path.join(target, 'node_modules', 'real', 'index.js'));
  fssync.symlinkSync(path.join(target, '.dsh-module-fallback', 'node_modules', 'immer'), path.join(target, 'node_modules', 'immer'), linkType);
  fssync.rmSync(target, { recursive: true, force: true });
  // 实测（D: 卷）：不抛错、留下 node_modules；同一形状在 C: temp 上却被删干净 ——
  // 所以这里只记录观察值，真正的判据是「移除器一定收干净」，而不是 rmSync 一定失败。
  t.diagnostic(`fs.rmSync left target behind: ${fssync.existsSync(target)}`);
  removeTreeSync(target);
  assert.equal(fssync.existsSync(target), false);
});

test('removeTreeSync：有效 junction 只删链接，绝不跟进目标目录', (t) => {
  const root = sandbox(t);
  const outside = path.join(root, 'pnpm-store', 'pkg');
  write(path.join(outside, 'index.js'), 'outside');
  const target = path.join(root, 'profile');
  fssync.mkdirSync(path.join(target, 'node_modules'), { recursive: true });
  fssync.symlinkSync(outside, path.join(target, 'node_modules', 'pkg'), linkType);
  removeTreeSync(target);
  assert.equal(fssync.existsSync(target), false);
  assert.equal(fssync.readFileSync(path.join(outside, 'index.js'), 'utf8'), 'outside');
});

test('removeTreeSync：只读文件 / 只读目录照样删掉', (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'profile');
  const readonly = path.join(target, 'ro', 'file.txt');
  write(readonly);
  fssync.chmodSync(readonly, 0o444);
  removeTreeSync(target);
  assert.equal(fssync.existsSync(target), false);
});

test('removeTreeSync：目标本身是链接时只删链接', (t) => {
  const root = sandbox(t);
  const real = path.join(root, 'real');
  write(path.join(real, 'index.js'), 'real');
  const link = path.join(root, 'link');
  fssync.symlinkSync(real, link, linkType);
  removeTreeSync(link);
  assert.equal(fssync.existsSync(link), false);
  assert.equal(fssync.readFileSync(path.join(real, 'index.js'), 'utf8'), 'real');
});

test('removeTreeSync：深树 + 不存在路径（不抛错）', (t) => {
  const root = sandbox(t);
  let deep = path.join(root, 'profile');
  for (let i = 0; i < 12; i++) deep = path.join(deep, `d${i}`);
  write(path.join(deep, 'leaf.txt'));
  removeTreeSync(path.join(root, 'profile'));
  assert.equal(fssync.existsSync(path.join(root, 'profile')), false);
  removeTreeSync(path.join(root, 'never-existed'));
});

test('removeTree（异步版）与同步版语义一致', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'profile');
  write(path.join(target, 'node_modules', 'real', 'index.js'));
  fssync.symlinkSync(path.join(target, 'gone'), path.join(target, 'node_modules', 'ghost'), linkType);
  await removeTree(target);
  assert.equal(fssync.existsSync(target), false);
  await removeTree(path.join(root, 'never-existed'));
});
