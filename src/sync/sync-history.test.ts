/**
 * sync-history 测试：自动同步执行记录读写（sync-history.json）、append 升序、
 * 读不存在 → 空、损坏拒绝、裁剪 N 条。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSyncHistory, appendAutosyncEntry, SYNC_HISTORY_FILE,
  AUTOSYNC_HISTORY_KEEP,
} from './sync-history.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { SectionId } from '../schema/types.ts';

function makeEntry(seed: number, status: AutosyncHistoryEntry['status']): AutosyncHistoryEntry {
  return {
    direction: 'both',
    status,
    appliedSections: (seed % 2 === 0 ? ['settings'] : []) as SectionId[],
    createdAt: new Date(2026, 7, 16, 12, seed).toISOString(),
    failureCountAtRun: 0,
  };
}

test('appendAutosyncEntry：追加记录 → readSyncHistory 读回升序列表', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-append-'));
  try {
    await appendAutosyncEntry(dir, makeEntry(0, 'success'));
    await appendAutosyncEntry(dir, makeEntry(1, 'skipped'));
    const hist = await readSyncHistory(dir);
    assert.equal(hist.schemaVersion, 1);
    assert.equal(hist.autosyncEntries.length, 2);
    assert.equal(hist.autosyncEntries[0]!.status, 'success');
    assert.equal(hist.autosyncEntries[1]!.status, 'skipped');
    // updatedAt 非空
    assert.ok(hist.updatedAt !== '', 'updatedAt 已写入');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncHistory：文件不存在 → 返回空列表（schemaVersion=1）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-missing-'));
  try {
    const hist = await readSyncHistory(dir);
    assert.equal(hist.schemaVersion, 1);
    assert.deepEqual(hist.autosyncEntries, []);
    assert.equal(hist.updatedAt, '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncHistory：损坏 JSON → 抛错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_HISTORY_FILE), '{not-json', 'utf8');
    await assert.rejects(() => readSyncHistory(dir), /损坏/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('appendAutosyncEntry：记录触发通道（transport git/webdav）→ 读回保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-channel-'));
  try {
    await appendAutosyncEntry(dir, { ...makeEntry(0, 'success'), transport: 'git' });
    await appendAutosyncEntry(dir, { ...makeEntry(1, 'skipped'), transport: 'webdav' });
    const hist = await readSyncHistory(dir);
    assert.equal(hist.autosyncEntries[0]!.transport, 'git');
    assert.equal(hist.autosyncEntries[1]!.transport, 'webdav');
    // 旧记录（无字段）读回 → undefined（向后兼容）
    const raw = await fs.readFile(path.join(dir, SYNC_HISTORY_FILE), 'utf8');
    void raw;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncHistory：旧记录无 transport 字段 → 读回 undefined（向后兼容）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-legacy-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_HISTORY_FILE),
      JSON.stringify({
        schemaVersion: 1,
        autosyncEntries: [{ direction: 'push', status: 'success', createdAt: '2026-08-16T12:00:00.000Z', failureCountAtRun: 0 }],
        updatedAt: '2026-08-16T12:00:00.000Z',
      }),
      'utf8',
    );
    const hist = await readSyncHistory(dir);
    assert.equal(hist.autosyncEntries[0]!.transport, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('appendAutosyncEntry：裁剪到 AUTOSYNC_HISTORY_KEEP 条', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-prune-'));
  try {
    // 预置 250 条
    for (let i = 0; i < AUTOSYNC_HISTORY_KEEP + 50; i++) {
      await appendAutosyncEntry(dir, makeEntry(i, 'success'));
    }
    const hist = await readSyncHistory(dir);
    assert.ok(hist.autosyncEntries.length <= AUTOSYNC_HISTORY_KEEP, `裁剪后不超过 ${AUTOSYNC_HISTORY_KEEP} 条`);
    assert.equal(hist.autosyncEntries.length, AUTOSYNC_HISTORY_KEEP);
    // 保留的是最新的（末尾的 createdAt 最大）
    const first = hist.autosyncEntries[0]!;
    const last = hist.autosyncEntries[hist.autosyncEntries.length - 1]!;
    assert.ok(first.createdAt <= last.createdAt, '升序排列，最新的在末尾');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('appendAutosyncEntry：原子写（不残留 .tmp 文件）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-atomic-'));
  try {
    await appendAutosyncEntry(dir, makeEntry(0, 'failed'));
    const files = await fs.readdir(dir);
    assert.ok(!files.some((f) => f.includes('.tmp')), '不应残留 .tmp 临时文件');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
