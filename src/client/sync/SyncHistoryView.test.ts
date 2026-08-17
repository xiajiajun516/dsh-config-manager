/**
 * P2b SyncHistoryView 纯函数测试：projectHistoryRows / formatDateTime。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectHistoryRows, formatDateTime } from './history-model.ts';
import type { SnapshotHistoryEntry } from './history-model.ts';

const e = (id: string, createdAt: string, sectionCount = 1, reviewCount = 0): SnapshotHistoryEntry => ({
  id, createdAt, sectionCount, reviewCount,
});

test('projectHistoryRows：按 createdAt 倒序', () => {
  const rows = projectHistoryRows([
    e('a', '2026-08-17T10:00:00.000Z'),
    e('b', '2026-08-17T12:00:00.000Z'),
    e('c', '2026-08-17T11:00:00.000Z'),
  ]);
  assert.equal(rows[0]!.id, 'b');
  assert.equal(rows[1]!.id, 'c');
  assert.equal(rows[2]!.id, 'a');
});

test('projectHistoryRows：空集合 → 空', () => {
  assert.deepEqual(projectHistoryRows([]), []);
});

test('formatDateTime：合法 ISO → 本地可读格式', () => {
  const s = formatDateTime('2026-08-17T10:30:00.000Z');
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('formatDateTime：空串 → 「—」', () => {
  assert.equal(formatDateTime(''), '—');
});

test('formatDateTime：非法 ISO → 原样返回', () => {
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});
