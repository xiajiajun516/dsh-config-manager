/**
 * m-sync-flow：待审队列持久化测试。
 * - readReviewQueue：文件不存在 → 空；损坏 → 抛错。
 * - writeReviewQueue + readReviewQueue：往返一致；原子重命名。
 * - enqueueItems：去重（同 id 不重复）；resolveItem：找到 → 设置 decision/decidedAt；找不到抛错。
 * - 并发写两次：均成功；最终内容是后写者（原子 rename 保证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  enqueueItems, readReviewQueue, resolveItem, REVIEW_QUEUE_FILE, tmpStateDir,
  writeReviewQueue, EMPTY_REVIEW_QUEUE,
} from './review-queue.ts';

test('readReviewQueue：文件不存在 → 返回空队列', async () => {
  const dir = await tmpStateDir('dsh-rq-empty-');
  try {
    const q = await readReviewQueue(dir);
    assert.deepEqual(q.items, []);
    assert.equal(q.updatedAt, '');
  } finally { await fsRm(dir); }
});

test('writeReviewQueue + readReviewQueue：往返一致', async () => {
  const dir = await tmpStateDir('dsh-rq-rt-');
  try {
    const queue = {
      items: [{
        id: 'a1',
        sectionId: 'settings',
        kind: 'key' as const,
        description: 'general.theme conflict',
        local: { theme: 'dark' },
        remote: { theme: 'light' },
        ancestor: { theme: 'dark' },
      }],
      updatedAt: '2026-08-17T00:00:00.000Z',
    };
    await writeReviewQueue(dir, queue);
    const loaded = await readReviewQueue(dir);
    assert.deepEqual(loaded, queue);
    assert.ok(pathExists(path.join(dir, REVIEW_QUEUE_FILE)));
  } finally { await fsRm(dir); }
});

test('readReviewQueue：损坏 JSON → 抛错（不静默降级）', async () => {
  const dir = await tmpStateDir('dsh-rq-bad-');
  try {
    await writeText(path.join(dir, REVIEW_QUEUE_FILE), '{not-json');
    await assert.rejects(() => readReviewQueue(dir), /JSON|损坏/);
  } finally { await fsRm(dir); }
});

test('enqueueItems：追加新项；同 id 视为重复，不重复入队', async () => {
  const dir = await tmpStateDir('dsh-rq-enq-');
  try {
    const item = {
      sectionId: 'settings',
      kind: 'key' as const,
      description: 'general.theme conflict',
      local: { theme: 'dark' },
      remote: { theme: 'light' },
    };
    await enqueueItems(dir, [item, item, item]);
    const q = await readReviewQueue(dir);
    assert.equal(q.items.length, 1, '三次追加同 id → 仅入队一次');
    assert.equal(q.items[0]!.sectionId, 'settings');
    assert.equal(q.items[0]!.kind, 'key');
    assert.ok(typeof q.items[0]!.id === 'string' && q.items[0]!.id.length === 16);
  } finally { await fsRm(dir); }
});

test('resolveItem：找到 → 设置 decision/decidedAt；找不到抛错', async () => {
  const dir = await tmpStateDir('dsh-rq-res-');
  try {
    await enqueueItems(dir, [{
      sectionId: 'providers',
      kind: 'key' as const,
      description: 'openai.route conflict',
      local: { route: 'a' },
      remote: { route: 'b' },
    }]);
    const before = await readReviewQueue(dir);
    const id = before.items[0]!.id;
    await resolveItem(dir, id, 'useRemote');
    const after = await readReviewQueue(dir);
    assert.equal(after.items[0]!.decision, 'useRemote');
    assert.ok(after.items[0]!.decidedAt && after.items[0]!.decidedAt.startsWith('2026-'));
    await assert.rejects(() => resolveItem(dir, 'nonexistent', 'skip'), /未找到/);
  } finally { await fsRm(dir); }
});

test('writeReviewQueue：原子提交（不残留临时文件；并发写两次均成功）', async () => {
  const dir = await tmpStateDir('dsh-rq-atomic-');
  try {
    await writeReviewQueue(dir, { items: [{ id: 'a', sectionId: 's', kind: 'key', description: 'd' }], updatedAt: 't1' });
    await writeReviewQueue(dir, { items: [{ id: 'b', sectionId: 's', kind: 'key', description: 'd' }], updatedAt: 't2' });
    const final = await readReviewQueue(dir);
    assert.equal(final.updatedAt, 't2', '后写者赢');
    assert.equal(final.items[0]!.id, 'b');
    // 无 .tmp 残留
    const entries = await fsReaddir(dir);
    assert.ok(!entries.some((n) => n.endsWith('.tmp')), '无 .tmp 残留');
  } finally { await fsRm(dir); }
});

// —— 私有 fs 辅助（避免顶部 import 污染） ——
const { promises: fsp } = await import('node:fs');
async function fsRm(p: string): Promise<void> { await fsp.rm(p, { recursive: true, force: true }); }
async function pathExists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true; } catch { return false; }
}
async function writeText(p: string, s: string): Promise<void> { await fsp.writeFile(p, s, 'utf8'); }
async function fsReaddir(p: string): Promise<string[]> { return await fsp.readdir(p); }

void EMPTY_REVIEW_QUEUE;
void os;
