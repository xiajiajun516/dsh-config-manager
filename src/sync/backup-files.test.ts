/**
 * backup-files 纯函数测试：列表（排序/来源判定/忽略非 zip）、删除（防穿越/幂等）、
 * 保留策略（pruneAutoBackups 只保留最近 N 个 auto 前缀产物，不动手动导出）。
 * 使用真实临时目录（与 backup-scheduler.test.ts 同模式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AUTO_BACKUP_PREFIX,
  DEFAULT_BACKUP_RETENTION,
  backupFileSource,
  deleteBackupFile,
  isValidBackupFileName,
  listBackupFiles,
  pruneAutoBackups,
} from './backup-files.ts';

/** 建独立临时 exports 目录，返回 { dir, cleanup } */
async function makeExportsDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-backup-files-'));
  const dir = path.join(root, 'exports');
  await fs.mkdir(dir, { recursive: true });
  return { dir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('AUTO_BACKUP_PREFIX / DEFAULT_BACKUP_RETENTION：常量符合设计', () => {
  assert.equal(AUTO_BACKUP_PREFIX, 'dsh-config-auto-');
  assert.equal(DEFAULT_BACKUP_RETENTION, 10);
});

test('backupFileSource：auto 前缀 → auto；其余 → manual', () => {
  assert.equal(backupFileSource('dsh-config-auto-20260824-120000-abc.zip'), 'auto');
  assert.equal(backupFileSource('dsh-config-20260824-120000-abc.zip'), 'manual');
  assert.equal(backupFileSource('anything.zip'), 'manual');
});

test('isValidBackupFileName：仅文件名 + .zip；拒绝路径穿越与非法形态', () => {
  assert.equal(isValidBackupFileName('dsh-config-a.zip'), true);
  assert.equal(isValidBackupFileName('dsh-config-auto-20260824-120000-abc.zip'), true);
  assert.equal(isValidBackupFileName('../evil.zip'), false, '目录穿越拒绝');
  assert.equal(isValidBackupFileName('sub/evil.zip'), false, '子路径拒绝');
  assert.equal(isValidBackupFileName('a\\evil.zip'), false, '反斜杠路径拒绝');
  assert.equal(isValidBackupFileName('no-ext'), false, '非 zip 拒绝');
  assert.equal(isValidBackupFileName(''), false, '空名拒绝');
  assert.equal(isValidBackupFileName(undefined), false, '非字符串拒绝');
  assert.equal(isValidBackupFileName(42), false, '非字符串拒绝');
});

test('listBackupFiles：只列 .zip、时间倒序、来源判定正确、缺失目录返回空', async () => {
  const { dir, cleanup } = await makeExportsDir();
  try {
    const now = Date.now();
    const names = [
      'dsh-config-auto-20260824-120000-aaa.zip',
      'dsh-config-20260823-090000-bbb.zip',
      'notes.txt',
      'dsh-config-auto-20260824-130000-ccc.zip',
    ];
    for (let i = 0; i < names.length; i++) {
      const p = path.join(dir, names[i]!);
      await fs.writeFile(p, `content-${i}`);
      await fs.utimes(p, new Date(now + i * 1000), new Date(now + i * 1000));
    }

    const metas = await listBackupFiles(dir);
    assert.equal(metas.length, 3, '非 zip 文件被忽略');
    assert.deepEqual(metas.map((m) => m.name), [
      'dsh-config-auto-20260824-130000-ccc.zip',
      'dsh-config-20260823-090000-bbb.zip',
      'dsh-config-auto-20260824-120000-aaa.zip',
    ], '按 mtime 倒序');
    assert.equal(metas[0]!.source, 'auto', 'auto 前缀 → 定时备份来源');
    assert.equal(metas[1]!.source, 'manual', '普通前缀 → 手动导出来源');
    assert.ok(metas[0]!.path.startsWith(dir), 'path 为绝对路径（供 /download 与导入引用）');
    assert.equal(metas[0]!.sizeBytes, Buffer.byteLength('content-2'), 'sizeBytes 正确');

    assert.deepEqual(await listBackupFiles(path.join(dir, 'no-such')), [], '缺失目录 → 空数组不抛错');
  } finally {
    await cleanup();
  }
});

test('deleteBackupFile：成功删除 / 不存在幂等 / 非法名抛错 / 目录穿越拒绝', async () => {
  const { dir, cleanup } = await makeExportsDir();
  try {
    const target = path.join(dir, 'dsh-config-auto-x.zip');
    await fs.writeFile(target, 'x');

    assert.equal(await deleteBackupFile(dir, 'dsh-config-auto-x.zip'), true, '删除成功');
    await assert.rejects(() => fs.stat(target), '文件已删除');
    assert.equal(await deleteBackupFile(dir, 'dsh-config-auto-x.zip'), false, '不存在幂等返回 false');

    await assert.rejects(() => deleteBackupFile(dir, '../outside.zip'), /非法备份文件名/, '目录穿越拒绝');
    await assert.rejects(() => deleteBackupFile(dir, 'sub/x.zip'), /非法备份文件名/, '子路径拒绝');
    await assert.rejects(() => deleteBackupFile(dir, 'x.txt'), /非法备份文件名/, '非 zip 拒绝');
    await assert.rejects(() => deleteBackupFile(dir, ''), /非法备份文件名/, '空名拒绝');
  } finally {
    await cleanup();
  }
});

test('pruneAutoBackups：只保留最近 keep 个 auto 前缀，手动导出与不足 keep 不受影响', async () => {
  const { dir, cleanup } = await makeExportsDir();
  try {
    const now = Date.now();
    const autoNames: string[] = [];
    for (let i = 0; i < 13; i++) {
      const name = `${AUTO_BACKUP_PREFIX}20260824-${String(i).padStart(6, '0')}-${String(i).padStart(3, '0')}.zip`;
      autoNames.push(name);
      const p = path.join(dir, name);
      await fs.writeFile(p, `auto-${i}`);
      await fs.utimes(p, new Date(now + i * 1000), new Date(now + i * 1000));
    }
    const manualName = 'dsh-config-20260823-000000-manual.zip';
    await fs.writeFile(path.join(dir, manualName), 'manual');

    // 不足 keep 时：不删任何文件
    const removedNone = await pruneAutoBackups(dir, 100);
    assert.deepEqual(removedNone, [], '不足 keep 不删');

    // keep=10：13 个 auto → 删最旧的 3 个；手动导出永不删
    const removed = await pruneAutoBackups(dir, 10);
    assert.equal(removed.length, 3, '只删超出 keep 的数量');
    assert.deepEqual(
      [...removed].sort(),
      autoNames.slice(0, 3).sort(),
      '删除的是最旧的 3 个（按 mtime）',
    );
    assert.ok(!removed.includes(manualName), '手动导出不在清理名单');

    const remaining = await fs.readdir(dir);
    assert.equal(remaining.length, 11, '13 auto - 3 删 + 1 手动 = 11 个');
    assert.ok(remaining.includes(manualName), '手动导出保留');
    assert.ok(remaining.includes(autoNames[12]!), '最新的保留');
    assert.ok(!remaining.includes(autoNames[0]!), '最旧的已删');
    assert.ok(!remaining.includes(autoNames[2]!), '第三旧的已删');
    assert.ok(remaining.includes(autoNames[3]!), '第 4 旧（保留线）保留');
  } finally {
    await cleanup();
  }
});

test('pruneAutoBackups：缺失目录 → 空结果不抛错', async () => {
  const { dir, cleanup } = await makeExportsDir();
  try {
    assert.deepEqual(await pruneAutoBackups(path.join(dir, 'no-such'), 10), []);
  } finally {
    await cleanup();
  }
});
