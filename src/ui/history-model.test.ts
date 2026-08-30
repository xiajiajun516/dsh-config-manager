/**
 * Migration History 纯渲染模型单测（node:test，零依赖）。
 * 覆盖：resultBadgeKind 语义、kindLabelKey、分组（空组过滤 / 组内时间倒序）、
 * 统计、最近 N 条过滤、文本子串过滤、filterToQuery。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredMigrationHistoryEntry } from '../core/migration-history.ts';
import {
  resultBadgeKind, kindLabelKey, groupByKind, summarize, applyRecent, filterByText,
  filterToQuery, HISTORY_KIND_OPTIONS, HISTORY_RESULT_OPTIONS,
} from './history-model.ts';

function mkEntry(partial: Partial<StoredMigrationHistoryEntry> & { kind: StoredMigrationHistoryEntry['kind'] }): StoredMigrationHistoryEntry {
  return {
    schemaVersion: 1,
    contentHash: 'x',
    at: '2026-08-30T12:00:00.000Z',
    kind: partial.kind,
    result: 'success',
    sections: [],
    source: 'api',
    summary: 'test',
    ...partial,
  } as StoredMigrationHistoryEntry;
}

test('resultBadgeKind：success→ok / failed→error / skipped→warn', () => {
  assert.equal(resultBadgeKind('success'), 'ok');
  assert.equal(resultBadgeKind('failed'), 'error');
  assert.equal(resultBadgeKind('skipped'), 'warn');
});

test('kindLabelKey：映射为 history.kind.<kind> 键基名', () => {
  assert.equal(kindLabelKey('import'), 'history.kind.import');
  assert.equal(kindLabelKey('snapshot-prune'), 'history.kind.snapshot-prune');
});

test('HISTORY_KIND_OPTIONS：恰为 §5 全清单（含 profile-import）', () => {
  assert.deepEqual(HISTORY_KIND_OPTIONS, [
    'import', 'restore', 'rollback',
    'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
    'sync-apply', 'autosync', 'recovery',
    'backup', 'snapshot-delete', 'snapshot-prune',
  ]);
  assert.deepEqual(HISTORY_RESULT_OPTIONS, ['success', 'failed', 'skipped']);
});

test('groupByKind：空组不渲染、组内按时间倒序、顺序保持清单序', () => {
  const entries = [
    mkEntry({ kind: 'restore', at: '2026-08-30T12:00:00.000Z' }),
    mkEntry({ kind: 'import', at: '2026-08-30T13:00:00.000Z' }),
    mkEntry({ kind: 'import', at: '2026-08-30T12:30:00.000Z' }),
  ];
  const groups = groupByKind(entries);
  // import 在清单序前，restore 在后
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.kind, 'import');
  assert.equal(groups[1]!.kind, 'restore');
  // import 组内倒序
  assert.equal(groups[0]!.entries[0]!.at, '2026-08-30T13:00:00.000Z');
  assert.equal(groups[0]!.entries[1]!.at, '2026-08-30T12:30:00.000Z');
});

test('groupByKind：全部同 kind 时单组，count 正确', () => {
  const groups = groupByKind([mkEntry({ kind: 'backup' }), mkEntry({ kind: 'backup' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.count, 2);
});

test('summarize：总数 + 结果计数', () => {
  const s = summarize([
    mkEntry({ kind: 'import', result: 'success' }),
    mkEntry({ kind: 'restore', result: 'failed' }),
    mkEntry({ kind: 'backup', result: 'skipped' }),
    mkEntry({ kind: 'sync-apply', result: 'success' }),
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.success, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
});

test('applyRecent：0=全部；N=按时间倒序取前 N', () => {
  const entries = [
    mkEntry({ kind: 'import', at: '2026-08-30T12:00:00.000Z' }),
    mkEntry({ kind: 'import', at: '2026-08-30T13:00:00.000Z' }),
    mkEntry({ kind: 'import', at: '2026-08-30T12:30:00.000Z' }),
  ];
  assert.equal(applyRecent(entries, 0).length, 3);
  const recent = applyRecent(entries, 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.at, '2026-08-30T13:00:00.000Z');
  assert.equal(recent[1]!.at, '2026-08-30T12:30:00.000Z');
});

test('filterByText：按 summary/error/kind/sections 子串匹配（大小写不敏感）；空串不过滤', () => {
  const entries = [
    mkEntry({ kind: 'import', summary: '导入 plugins', sections: ['plugins'] }),
    mkEntry({ kind: 'restore', summary: '恢复快照', error: 'CONNECT_FAILED', sections: ['settings'] }),
  ];
  assert.equal(filterByText(entries, '').length, 2);
  assert.equal(filterByText(entries, 'plugins').length, 1);
  assert.equal(filterByText(entries, 'connect_failed').length, 1);
  assert.equal(filterByText(entries, 'restore').length, 1);
  assert.equal(filterByText(entries, '不存在').length, 0);
});

test('filterToQuery：只映射已选过滤器', () => {
  assert.deepEqual(filterToQuery({ query: '' }), {});
  assert.deepEqual(filterToQuery({ query: 'x', kind: 'import', result: 'success' }), { kind: 'import', result: 'success' });
});

test('sensitive：纯模型不泄露 secret（kind/results 为枚举）', () => {
  // 模型只承载枚举/摘要，不引入自由 secret 字段
  const e = mkEntry({ kind: 'import', summary: 'password=secret123' });
  const groups = groupByKind([e]);
  assert.equal(groups[0]!.entries[0]!.kind, 'import');
  // summary 是自由文本，但模型不做任何解密/展开——脱敏由上层负责
  assert.equal(groups[0]!.entries[0]!.summary, 'password=secret123');
});
