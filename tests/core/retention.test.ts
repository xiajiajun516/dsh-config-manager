/**
 * 快照保留（criterion snapshot-retention-10）：
 *  - SNAPSHOT_RETENTION_LIMIT = 10；
 *  - selectPruneCandidates 纯函数：按 createdAt 升序取最旧，超限返回应删 id（恰好 limit 不删）；
 *  - FileSnapshotStore.save() 落盘后自动清理：第 11 个快照落盘 → 最旧快照目录被删除；
 *  - 边界：恰好 10 个不删 / 损坏目录跳过 / 空目录首写容错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FileSnapshotStore, SNAPSHOT_RETENTION_LIMIT, selectPruneCandidates,
} from '../../src/core/backup.ts';
import { listSnapshots } from '../../src/core/restore.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-retention-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 直接写入一个快照目录（save() 之外的种子方式，同 restore.test.ts R-05） */
async function seedSnapshot(dir: string, id: string, createdAt: string): Promise<void> {
  await fs.mkdir(path.join(dir, id), { recursive: true });
  await fs.writeFile(path.join(dir, id, 'snapshot.json'), JSON.stringify({
    id, createdAt, sourceZip: `${id}.zip`, entries: [],
  }), 'utf8');
}

function minSnapshot(id: string, createdAt: string): {
  id: string; createdAt: string; sourceZip: string; entries: unknown[];
} {
  return { id, createdAt, sourceZip: `${id}.zip`, entries: [] };
}

/** R-01 纯函数：恰好 limit 个 → 空数组（不删） */
test('R-01 selectPruneCandidates：恰好 10 个 → 空数组（不删）', () => {
  const metas = Array.from({ length: 10 }, (_, i) => ({
    id: `s${String(i + 1).padStart(2, '0')}`,
    createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  assert.deepEqual(selectPruneCandidates(metas), []);
  assert.equal(SNAPSHOT_RETENTION_LIMIT, 10, '保留上限常量应为 10');
});

/** R-02 纯函数：第 11 个 → 返回最旧 id */
test('R-02 selectPruneCandidates：11 个 → 返回最旧 1 个', () => {
  const metas = Array.from({ length: 11 }, (_, i) => ({
    id: `s${String(i + 1).padStart(2, '0')}`,
    createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  assert.deepEqual(selectPruneCandidates(metas), ['s01']);
});

/** R-03 纯函数：乱序输入仍按 createdAt 选最旧；空数组容错；自定义 limit */
test('R-03 selectPruneCandidates：乱序输入按 createdAt 选最旧 + 空数组容错 + 自定义 limit', () => {
  const metas = [
    { id: 'mid', createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'newest', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'oldest', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(selectPruneCandidates(metas, 2), ['oldest']);
  assert.deepEqual(selectPruneCandidates([], 10), []);
});

/** R-04 store 集成：第 11 个快照落盘 → 最旧目录被自动清理，恰余 10 个 */
test('R-04 FileSnapshotStore.save：第 11 个落盘后自动删除最旧快照目录', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir });
    for (let i = 1; i <= 10; i++) {
      await seedSnapshot(dir, `s${String(i).padStart(2, '0')}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
    await store.save(minSnapshot('s11', '2026-11-01T00:00:00.000Z'));

    const metas = await listSnapshots(dir);
    assert.equal(metas.length, 10, '清理后应恰好 10 个快照');
    const ids = metas.map((m) => m.id);
    assert.ok(!ids.includes('s01'), '最旧快照 s01 应被清理');
    assert.ok(ids.includes('s11'), '新保存的快照 s11 应保留');
    await assert.rejects(
      fs.access(path.join(dir, 's01', 'snapshot.json')),
      's01 目录应已整体删除',
    );
  });
});

/** R-05 store 集成：恰好 10 个（含本次落盘）不删 */
test('R-05 FileSnapshotStore.save：恰好 10 个 → 不清理任何快照', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir });
    for (let i = 1; i <= 9; i++) {
      await seedSnapshot(dir, `s${String(i).padStart(2, '0')}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
    await store.save(minSnapshot('s10', '2026-10-01T00:00:00.000Z'));

    const metas = await listSnapshots(dir);
    assert.equal(metas.length, 10, '恰好 10 个 → 全部保留');
    assert.deepEqual(
      metas.map((m) => m.id).sort(),
      ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09', 's10'],
    );
  });
});

/** R-06 store 集成：损坏目录跳过（不计数、不删除、不抛错）+ 空目录首写容错 */
test('R-06 FileSnapshotStore.save：损坏目录跳过 + 空目录首写容错', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir });
    // 空目录首写：不抛错，只有 1 个快照
    await store.save(minSnapshot('first', '2026-01-01T00:00:00.000Z'));
    assert.equal((await listSnapshots(dir)).length, 1, '空目录首写后只有 1 个快照');

    // 损坏目录（无合法 snapshot.json）：prune 扫描应跳过
    const broken = path.join(dir, 'broken');
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, 'snapshot.json'), 'not json{{{', 'utf8');

    // first + 9 个种子 = 10 个合法快照；再 save 第 11 个 → 只删最旧 first，损坏目录不动
    for (let i = 1; i <= 9; i++) {
      await seedSnapshot(dir, `s${String(i).padStart(2, '0')}`, `2026-02-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
    await store.save(minSnapshot('s10', '2026-11-01T00:00:00.000Z'));

    const metas = await listSnapshots(dir);
    assert.equal(metas.length, 10, '损坏目录不计数：10 个合法快照保留');
    assert.ok(!metas.some((m) => m.id === 'first'), '最旧 first 应被清理');
    await fs.access(path.join(dir, 'broken', 'snapshot.json')); // 不抛错 = 损坏目录未被动
  });
});
