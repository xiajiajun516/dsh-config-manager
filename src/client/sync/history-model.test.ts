/**
 * m-sync-ui (方案 A)：同步历史投影（含自动同步记录）纯函数测试。
 * TDD：先写失败测试，再实现 history-model.ts 对应函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SyncHistoryEntry } from './sync-api.ts';
import {
  autosyncStatusLabel, describeSkipReason, directionLabel, formatDateTime,
  projectAutosyncEntry, projectSyncHistoryEntries,
} from './history-model.ts';
import type { AutosyncHistoryEntry } from './sync-api.ts';

const autosyncEntry = (overrides: Partial<AutosyncHistoryEntry>): AutosyncHistoryEntry => ({
  direction: 'both',
  status: 'skipped',
  skipReason: 'conflict',
  conflictedSections: ['settings', 'plugins'],
  appliedSections: [],
  failureCountAtRun: 0,
  createdAt: '2026-08-17T10:00:00.000Z',
  ...overrides,
});

test('projectSyncHistoryEntries：快照 + 自动同步 按 createdAt 倒序合并', () => {
  const entries: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    {
      id: 'b', createdAt: '2026-08-17T12:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ createdAt: '2026-08-17T12:00:00.000Z' }),
    },
    { id: 'c', createdAt: '2026-08-17T11:00:00.000Z', kind: 'apply', sectionCount: 2, reviewCount: 0 },
  ];
  const sorted = projectSyncHistoryEntries(entries);
  assert.equal(sorted[0]!.id, 'b');
  assert.equal(sorted[1]!.id, 'c');
  assert.equal(sorted[2]!.id, 'a');
});

test('directionLabel / autosyncStatusLabel：方向与状态映射', () => {
  assert.equal(directionLabel('pull'), '下载');
  assert.equal(directionLabel('push'), '上传');
  assert.equal(directionLabel('both'), '双向');
  assert.equal(autosyncStatusLabel('success'), '成功');
  assert.equal(autosyncStatusLabel('skipped'), '已跳过');
  assert.equal(autosyncStatusLabel('failed'), '失败');
  assert.equal(autosyncStatusLabel('partial'), '部分成功');
});

test('describeSkipReason：已知原因映射，未知回退原串', () => {
  assert.equal(describeSkipReason('conflict'), '冲突项被跳过');
  assert.equal(describeSkipReason('no-remote'), '远端无快照');
  assert.equal(describeSkipReason('not-configured'), '未配置仓库');
  assert.equal(describeSkipReason('network'), '网络问题');
  assert.equal(describeSkipReason('encrypted'), '远端快照已加密，自动同步跳过（请手动同步）');
  assert.equal(describeSkipReason('weird'), 'weird');
  assert.equal(describeSkipReason(undefined), '未知');
});

test('projectAutosyncEntry：摘要行 + 可展开明细（冲突分区 / 应用分区 / 错误）', () => {
  const row = projectAutosyncEntry(autosyncEntry({}));
  assert.equal(row.direction, '双向');
  assert.equal(row.status, '已跳过');
  assert.match(row.summary, /双向/);
  assert.match(row.summary, /已跳过/);
  assert.match(row.summary, /冲突项被跳过/);
  assert.deepEqual(row.conflictedSections, ['settings', 'plugins']);
  assert.equal(row.hasDetail, true);
});

test('projectAutosyncEntry：无冲突/无应用/无错误 → hasDetail=false', () => {
  const row = projectAutosyncEntry(autosyncEntry({
    conflictedSections: undefined, appliedSections: undefined, error: undefined,
  }));
  assert.equal(row.hasDetail, false);
});

test('formatDateTime：合法 ISO → 本地格式；空/非法回退', () => {
  assert.match(formatDateTime('2026-08-17T10:30:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});
