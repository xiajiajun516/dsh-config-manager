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
  filterToQuery, collectHistoryKinds, collectHistoryResults, filterByKindResult,
  formatHistorySections,
  HISTORY_KIND_OPTIONS, HISTORY_RESULT_OPTIONS,
} from './history-model.ts';

function mkEntry(partial: Partial<StoredMigrationHistoryEntry> & { kind: StoredMigrationHistoryEntry['kind'] }): StoredMigrationHistoryEntry {
  return {
    schemaVersion: 1,
    contentHash: 'x',
    at: '2026-08-30T12:00:00.000Z',
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

test('formatHistorySections：空 → null；≤max 全列；>max 折叠为 +N', () => {
  assert.equal(formatHistorySections([]), null, '无分区不渲染占位');
  assert.equal(formatHistorySections(['settings']), 'settings');
  assert.equal(formatHistorySections(['settings', 'skills', 'ui']), 'settings, skills, ui');
  assert.equal(
    formatHistorySections(['settings', 'skills', 'ui', 'mcp', 'plugins']),
    'settings, skills, ui +2',
    '超出上限折叠计数，避免整条铺满窄抽屉',
  );
  assert.equal(formatHistorySections(['a', 'b', 'c', 'd'], 2), 'a, b +2', 'max 可调');
});

test('HISTORY_KIND_OPTIONS：恰为 §5 全清单（含 profile-import）', () => {
  assert.deepEqual(HISTORY_KIND_OPTIONS, [
    'import', 'restore', 'rollback',
    'profile-create', 'profile-select', 'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
    'sync-apply', 'autosync', 'recovery',
    'backup', 'backup-manual', 'snapshot-delete', 'snapshot-prune',
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

/* ---------------- 需求 10：分类筛选真正生效 + 只列真实分类 ---------------- */

test('filterByKindResult：空/undefined = 不过滤（且原样返回，零分配）', () => {
  const entries = [
    mkEntry({ kind: 'import', result: 'success' }),
    mkEntry({ kind: 'backup', result: 'failed' }),
  ];
  assert.equal(filterByKindResult(entries), entries);
  assert.equal(filterByKindResult(entries, undefined, undefined), entries);
  // select 的 value='' 语义（运行时兜底）
  assert.equal(filterByKindResult(entries, '' as never, '' as never), entries);
});

test('filterByKindResult：单条件过滤 + 双条件取交集 + 保持输入顺序', () => {
  const entries = [
    mkEntry({ kind: 'import', result: 'success', summary: 'a' }),
    mkEntry({ kind: 'import', result: 'failed', summary: 'b' }),
    mkEntry({ kind: 'backup', result: 'success', summary: 'c' }),
  ];
  const onlyImport = filterByKindResult(entries, 'import', undefined);
  assert.deepEqual(onlyImport.map((e) => e.summary), ['a', 'b']); // 顺序保持
  const onlyFailed = filterByKindResult(entries, undefined, 'failed');
  assert.equal(onlyFailed.length, 1);
  assert.equal(onlyFailed[0]!.summary, 'b');
  // 交集：import ∩ success = 1（import ∩ skipped = 0，不回落为并集）
  assert.deepEqual(filterByKindResult(entries, 'import', 'success').map((e) => e.summary), ['a']);
  assert.equal(filterByKindResult(entries, 'import', 'skipped').length, 0);
});

test('filterByKindResult：过滤后 summarize 随之变化（统计徽章反映筛选结果）', () => {
  const entries = [
    mkEntry({ kind: 'import', result: 'success' }),
    mkEntry({ kind: 'backup', result: 'success' }),
    mkEntry({ kind: 'backup', result: 'failed' }),
  ];
  assert.equal(summarize(entries).total, 3);
  const s = summarize(filterByKindResult(entries, 'backup'));
  assert.equal(s.total, 2);
  assert.equal(s.success, 1);
  assert.equal(s.failed, 1);
});

test('collectHistoryKinds：只返回数据里真实存在的 kind，去重且保持清单顺序', () => {
  const entries = [
    mkEntry({ kind: 'backup' }),
    mkEntry({ kind: 'import' }),
    mkEntry({ kind: 'backup' }),
  ];
  // 去重 + 按 HISTORY_KIND_OPTIONS 顺序（import 在 backup 之前）
  assert.deepEqual(collectHistoryKinds(entries), ['import', 'backup']);
  assert.deepEqual(collectHistoryKinds([]), []);
});

test('collectHistoryKinds：keepSelected 让「选中但数据里已不存在」的项保留在选项里', () => {
  const entries = [mkEntry({ kind: 'backup' })];
  assert.deepEqual(collectHistoryKinds(entries), ['backup']);
  // 选中 profile-save（数据里没有）→ 仍出现在选项里，位置按清单顺序（profile-save 在 backup 之前）
  assert.deepEqual(collectHistoryKinds(entries, 'profile-save'), ['profile-save', 'backup']);
  // 选中值已存在时不重复
  assert.deepEqual(collectHistoryKinds(entries, 'backup'), ['backup']);
});

test('collectHistoryResults：只返回数据里真实出现过的 result（含 keepSelected）', () => {
  const entries = [mkEntry({ kind: 'import', result: 'success' }), mkEntry({ kind: 'import', result: 'success' })];
  assert.deepEqual(collectHistoryResults(entries), ['success']);
  assert.deepEqual(collectHistoryResults(entries, 'failed'), ['success', 'failed']);
  assert.deepEqual(collectHistoryResults([], 'skipped'), ['skipped']);
  // 顺序恒为 HISTORY_RESULT_OPTIONS（success → failed → skipped）
  assert.deepEqual(
    collectHistoryResults([mkEntry({ kind: 'import', result: 'skipped' }), mkEntry({ kind: 'import', result: 'success' })]),
    ['success', 'skipped'],
  );
});
