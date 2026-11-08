/**
 * FileSystemFacade.remove（home 内递归删除）的**真机级**语义。
 *
 * 为什么必须用真实文件系统：这是「恢复计划删文件」与「回滚补偿删目录」唯一的删除通道，
 * 而 `fs.rm(dir, { recursive: true, force: true })` 在目录含**悬空链接**（junction 的重指向
 * 目标已被删掉）时会静默空转——不抛错、一个字节都不删。报告于是写「已还原 / 已删除」，
 * 磁盘上原样存在（用户报的「删除不生效」就是同一形状）。内存 MemFs 验不出这条，
 * 所以这里钉真机行为：悬空链接树能删净、有效链接只删链接本身（绝不跟出 home）、缺失即成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DshFileSystemFacade } from '../../src/index.ts';

/** Windows 上跨盘/不存在目标只能建 junction；其它平台用目录链接。 */
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

test('remove：目录里有悬空 junction 也能真的删净（fs.rm 静默空转的回归）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-fsremove-'));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    const modules = path.join(profileDir, 'node_modules');
    await fs.mkdir(path.join(modules, 'real-pkg'), { recursive: true });
    await fs.writeFile(path.join(modules, 'real-pkg', 'index.js'), 'x');
    const fallback = path.join(profileDir, '.dsh-module-fallback', 'node_modules', 'immer');
    await fs.symlink(fallback, path.join(modules, 'immer'), linkType);
    // 悬空链接：existsSync 跟着链接看目标 → false；判「链接条目在」必须用 lstat。
    assert.equal(fsSync.lstatSync(path.join(modules, 'immer')).isSymbolicLink(), true, '链接条目本身在');
    assert.equal(fsSync.existsSync(fallback), false, '但它的重指向目标不存在（悬空）');

    const facade = new DshFileSystemFacade(home);
    await facade.remove(path.join(home, 'profiles', 'web'));
    assert.equal(fsSync.existsSync(profileDir), false, '含悬空链接的目录必须真的消失');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('remove：有效链接只删链接本身，绝不跟出 home 删目标', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-fsremove-ext-'));
  const home = path.join(base, 'home');
  const outside = path.join(base, 'outside');
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
    await fs.symlink(outside, path.join(home, 'linked'), linkType);

    const facade = new DshFileSystemFacade(home);
    await facade.remove(path.join(home, 'linked'));
    assert.equal(fsSync.existsSync(path.join(home, 'linked')), false, '链接被删掉');
    assert.equal(fsSync.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'home 外的目标目录内容必须完好');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('remove：目标不存在视为成功（与 force 语义一致），越界仍拒绝', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-fsremove-miss-'));
  try {
    const facade = new DshFileSystemFacade(home);
    await facade.remove(path.join(home, 'never-existed', 'deep'));
    await assert.rejects(
      () => facade.remove(path.join(home, '..', 'escape')),
      /越界|fsPathEscape/i,
      'home 之外的路径仍然拒绝（删除不能变成任意路径删除）',
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
