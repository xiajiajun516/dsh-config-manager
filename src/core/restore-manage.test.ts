/**
 * restore.ts 快照管理纯函数测试（P1-⑧）：
 * isValidSnapshotId 防穿越校验、deleteSnapshot（合法删除/幂等/越界拒绝）、
 * setSnapshotPinned（置顶标记读写/越界拒绝）。
 * 使用真实临时目录（与 backup 测试同模式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deleteSnapshot,
  isValidSnapshotId,
  setSnapshotPinned,
} from './restore.ts';

/** 建临时快照根目录 + 一个样例快照目录，返回 { dir, id, cleanup } */
async function makeSnapshot(): Promise<{ dir: string; id: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-restore-'));
  const dir = path.join(root, 'snapshots');
  await fs.mkdir(path.join(dir, 'snap-1'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'snap-1', 'snapshot.json'),
    JSON.stringify({ id: 'snap-1', createdAt: '2026-08-24T00:00:00.000Z', sourceZip: 'x.zip', entries: [], status: 'done' }),
  );
  return { dir, id: 'snap-1', cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('isValidSnapshotId：合法 id 通过，路径穿越/非法字符拒绝（P1-⑧）', () => {
  assert.equal(isValidSnapshotId('snap-1'), true);
  assert.equal(isValidSnapshotId('abc_123'), true);
  assert.equal(isValidSnapshotId('../evil'), false, '../ 穿越拒绝');
  assert.equal(isValidSnapshotId('a/b'), false, '斜杠拒绝');
  assert.equal(isValidSnapshotId('a\\b'), false, '反斜杠拒绝');
  assert.equal(isValidSnapshotId('.hidden'), false, '点开头拒绝');
  assert.equal(isValidSnapshotId(''), false);
  assert.equal(isValidSnapshotId(undefined), false);
  assert.equal(isValidSnapshotId('a'.repeat(100)), false, '超长拒绝');
});

test('deleteSnapshot：删除存在快照目录；不存在幂等；越界拒绝（P1-⑧）', async () => {
  const { dir, id, cleanup } = await makeSnapshot();
  try {
    assert.equal(await deleteSnapshot(dir, id), true, '删除成功');
    await assert.rejects(() => fs.stat(path.join(dir, id)), '目录已删除');
    assert.equal(await deleteSnapshot(dir, id), false, '不存在幂等返回 false');
  } finally {
    await cleanup();
  }
});

test('deleteSnapshot：非法 id 抛错（防目录穿越），不触碰外部目录（P1-⑧）', async () => {
  const { dir, cleanup } = await makeSnapshot();
  try {
    // 在快照根外放置哨兵文件，确认穿越删除被拒绝
    const sentinel = path.join(path.dirname(dir), 'outside-marker');
    await fs.writeFile(sentinel, 'keep');
    await assert.rejects(() => deleteSnapshot(dir, '../outside-marker'), /非法快照 id/);
    await assert.rejects(() => deleteSnapshot(dir, 'a/b'), /非法快照 id/);
    const stillThere = await fs.readFile(sentinel, 'utf8');
    assert.equal(stillThere, 'keep', '外部目录未被误删');
  } finally {
    await cleanup();
  }
});

test('setSnapshotPinned：写 pinned 标记并读回（P1-⑧）', async () => {
  const { dir, id, cleanup } = await makeSnapshot();
  try {
    await setSnapshotPinned(dir, id, true);
    const raw1 = JSON.parse(await fs.readFile(path.join(dir, id, 'snapshot.json'), 'utf8'));
    assert.equal(raw1.pinned, true, '置顶标记写入');
    await setSnapshotPinned(dir, id, false);
    const raw2 = JSON.parse(await fs.readFile(path.join(dir, id, 'snapshot.json'), 'utf8'));
    assert.equal(raw2.pinned, false, '取消置顶覆盖');
    // 保留其余字段
    assert.equal(raw2.id, id);
    assert.equal(raw2.status, 'done');
  } finally {
    await cleanup();
  }
});

test('setSnapshotPinned：非法 id 抛错（P1-⑧）', async () => {
  const { dir, cleanup } = await makeSnapshot();
  try {
    await assert.rejects(() => setSnapshotPinned(dir, '../x', true), /非法快照 id/);
    await assert.rejects(() => setSnapshotPinned(dir, 'no-such-snapshot', true), /ENOENT|快照/, '不存在的快照抛错');
  } finally {
    await cleanup();
  }
});