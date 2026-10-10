/**
 * m-sync-ui (方案 A)：同步历史投影（含自动同步记录）纯函数测试。
 * TDD：先写失败测试，再实现 history-model.ts 对应函数。
 *
 * client-F1 回归（2026-10-05）：投影出的**用户可见标签必须来自字典** —— 传 en 翻译器时
 * 不得再出现任何中文（此前 direction/status/skipReason 硬编码中文，英文界面恒为中文）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import type { TranslateNS } from '../client-types.ts';
import type { SyncHistoryEntry } from './sync-api.ts';
import { en as syncEn, zh as syncZh } from './sync-locales.ts';
import {
  autosyncBadgeKind, autosyncStatusLabel, describeSkipReason, directionLabel, formatDateTime,
  formatDateTimeFull, midEllipsis, projectAutosyncEntry, projectSyncHistoryEntries, skipReasonKey,
  summarizeSyncHistory,
} from './history-model.ts';
import type { AutosyncHistoryEntry } from './sync-api.ts';

/**
 * 字典对象 → TranslateNS（支持 {name} 占位符；缺键回退键本身，与运行时同口径）。
 * 用**真字典**而不是假字符串：断言才能钉住「文案确实取自字典」而不是「恰好等于某串」。
 */
function mkSyncT(dict: Record<string, string>): TranslateNS<'config-manager-sync'> {
  return ((key: string, params?: Record<string, unknown>): string => {
    const raw = dict[key] ?? key;
    return params === undefined
      ? raw
      : raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  }) as unknown as TranslateNS<'config-manager-sync'>;
}

const zhT = mkSyncT(syncZh);
const enT = mkSyncT(syncEn);

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

test('directionLabel / autosyncStatusLabel：方向与状态映射（走字典，不再硬编码）', () => {
  // zh：与字典逐字相等（而不是与某个字面量相等）
  assert.equal(directionLabel('pull', zhT), syncZh['history.autosyncPull']);
  assert.equal(directionLabel('push', zhT), syncZh['history.autosyncPush']);
  assert.equal(directionLabel('both', zhT), syncZh['history.autosyncBoth']);
  assert.equal(autosyncStatusLabel('success', zhT), syncZh['autosync.success']);
  assert.equal(autosyncStatusLabel('skipped', zhT), syncZh['autosync.skipped']);
  assert.equal(autosyncStatusLabel('failed', zhT), syncZh['autosync.failed']);
  assert.equal(autosyncStatusLabel('partial', zhT), syncZh['autosync.partial']);
  // en：client-F1 的核心回归 —— 英文界面下这三个标签不得再是中文
  assert.equal(directionLabel('pull', enT), 'Pull');
  assert.equal(directionLabel('push', enT), 'Push');
  assert.equal(directionLabel('both', enT), 'Both');
  assert.equal(autosyncStatusLabel('success', enT), 'Success');
  assert.equal(autosyncStatusLabel('skipped', enT), 'Skipped');
  assert.equal(autosyncStatusLabel('failed', enT), 'Failed');
  assert.equal(autosyncStatusLabel('partial', enT), 'Partial');
});

test('describeSkipReason：七类已知原因全部走字典（F1 收口：不再有硬编码中文）', () => {
  assert.equal(describeSkipReason('conflict', zhT), syncZh['history.autosyncReasonConflict']);
  assert.equal(describeSkipReason('no-remote', zhT), syncZh['history.autosyncReasonNoRemote']);
  assert.equal(describeSkipReason('not-configured', zhT), syncZh['history.autosyncReasonNotConfigured']);
  assert.equal(describeSkipReason('network', zhT), syncZh['history.autosyncReasonNetwork']);
  assert.equal(describeSkipReason('conflict', enT), syncEn['history.autosyncReasonConflict']);
  // F1 收口（t3）：encrypted / mutation-locked / 未知 三类也已补键，en 界面下不再透出中文
  assert.equal(describeSkipReason('encrypted', zhT), syncZh['history.autosyncReasonEncrypted']);
  assert.equal(describeSkipReason('encrypted', enT), syncEn['history.autosyncReasonEncrypted']);
  assert.equal(describeSkipReason('mutation-locked', zhT), syncZh['history.autosyncReasonMutationLocked']);
  assert.equal(describeSkipReason(undefined, zhT), syncZh['history.autosyncReasonUnknown']);
  assert.equal(describeSkipReason(undefined, enT), syncEn['history.autosyncReasonUnknown']);
  // 未知原因仍原样透出宿主回传的串（不吞信息）
  assert.equal(describeSkipReason('weird', zhT), 'weird');
});

// issue #31：宿主统一以 'mutation-locked' 落历史（不细分 LOCKED/STALE）→ 界面不得透出裸 token。
test('describeSkipReason：mutation-locked 必须有可读中文且不再回退原串', () => {
  const text = describeSkipReason('mutation-locked', zhT);
  assert.notEqual(text, 'mutation-locked', '绝不透出裸机器 token');
  assert.match(text, /环境锁/);
  assert.match(text, /残留锁/);
  assert.match(text, /另一项任务/);
});

test('projectAutosyncEntry：摘要行 + 可展开明细（冲突分区 / 应用分区 / 错误）', () => {
  const row = projectAutosyncEntry(autosyncEntry({}), zhT);
  assert.equal(row.direction, syncZh['history.autosyncBoth']);
  assert.equal(row.status, syncZh['autosync.skipped']);
  assert.match(row.summary, new RegExp(syncZh['history.autosyncBoth']!));
  assert.match(row.summary, new RegExp(syncZh['autosync.skipped']!));
  assert.match(row.summary, new RegExp(syncZh['history.autosyncReasonConflict']!));
  assert.deepEqual(row.conflictedSections, ['settings', 'plugins']);
  assert.equal(row.hasDetail, true);
});

test('projectAutosyncEntry：无冲突/无应用/无错误 → hasDetail=false', () => {
  const row = projectAutosyncEntry(autosyncEntry({
    conflictedSections: undefined, appliedSections: undefined, error: undefined,
  }), zhT);
  assert.equal(row.hasDetail, false);
});

test('formatDateTime：合法 ISO → 本地格式；空/非法回退', () => {
  assert.match(formatDateTime('2026-08-17T10:30:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});

test('formatDateTimeFull：合法 ISO → 含秒的本地时间串；空/非法 → 空串（不渲染 title）', () => {
  const full = formatDateTimeFull('2026-08-17T10:30:45.000Z');
  assert.notEqual(full, '');
  assert.match(full, /2026/);
  assert.equal(formatDateTimeFull(''), '');
  assert.equal(formatDateTimeFull('not-a-date'), '');
  assert.match(formatDateTime('2026-08-17T10:30:45.000Z'), /^2026-08-17 \d{2}:30$/);
});

test('midEllipsis：短串原样返回（未超上限不截断）', () => {
  assert.equal(midEllipsis('short'), 'short');
  assert.equal(midEllipsis(''), '');
  assert.equal(midEllipsis('a'.repeat(26)), 'a'.repeat(26));
});

test('midEllipsis：长串保留头尾且中段以 … 替代', () => {
  const uuid = 'sync-930ceecc-d5cd-4daa-9231-5b837149f527';
  const out = midEllipsis(uuid, 26);
  assert.ok(out.includes('…'), '应含中段省略号');
  assert.equal(out.length, 26, '长度应等于 max');
  assert.ok(uuid.endsWith(out.slice(out.indexOf('…') + 1)), '尾部应原样保留');
  assert.ok(uuid.startsWith(out.slice(0, out.indexOf('…'))), '头部应原样保留');
});

test('midEllipsis：长度上限正确（含省略号在内恰好 max 字符；默认上限 26）', () => {
  const long = 'x'.repeat(100);
  assert.equal(midEllipsis(long).length, 26);
  assert.equal(midEllipsis(long, 10).length, 10);
  assert.equal(midEllipsis(long, 40).length, 40);
  const s = '0123456789ABCDEFGHIJ';
  assert.equal(midEllipsis(s, 11), '01234…FGHIJ');
});

test('autosyncBadgeKind：四种状态 → 语义色全覆盖', () => {
  assert.equal(autosyncBadgeKind('success'), 'ok');
  assert.equal(autosyncBadgeKind('skipped'), 'warn');
  assert.equal(autosyncBadgeKind('failed'), 'error');
  assert.equal(autosyncBadgeKind('partial'), 'warn');
});

test('projectAutosyncEntry：badgeKind + skipReasonText（需求 D/E 的第二行小字）', () => {
  const row = projectAutosyncEntry(autosyncEntry({ status: 'skipped', skipReason: 'conflict' }), zhT);
  assert.equal(row.badgeKind, 'warn');
  assert.equal(row.skipReasonText, syncZh['history.autosyncReasonConflict']);
  assert.match(row.summary, new RegExp(syncZh['history.autosyncReasonConflict']!));

  const noReason = projectAutosyncEntry(autosyncEntry({ status: 'success', skipReason: undefined }), zhT);
  assert.equal(noReason.badgeKind, 'ok');
  assert.equal(noReason.skipReasonText, undefined);

  assert.equal(projectAutosyncEntry(autosyncEntry({ status: 'failed' }), zhT).badgeKind, 'error');
  assert.equal(projectAutosyncEntry(autosyncEntry({ status: 'partial' }), zhT).badgeKind, 'warn');
});

test('summarizeSyncHistory：总数/快照数/自动同步数/失败数/跳过数', () => {
  const rows: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    { id: 'b', createdAt: '2026-08-17T11:00:00.000Z', kind: 'push', sectionCount: 1, reviewCount: 0 },
    { id: 'c', createdAt: '2026-08-17T12:00:00.000Z', kind: 'rollback', sectionCount: 2, reviewCount: 0 },
    { id: 'd', createdAt: '2026-08-17T13:00:00.000Z', kind: 'autosync', autosync: autosyncEntry({ status: 'success', createdAt: '2026-08-17T13:00:00.000Z' }) },
    { id: 'e', createdAt: '2026-08-17T14:00:00.000Z', kind: 'autosync', autosync: autosyncEntry({ status: 'skipped', createdAt: '2026-08-17T14:00:00.000Z' }) },
    { id: 'f', createdAt: '2026-08-17T15:00:00.000Z', kind: 'autosync', autosync: autosyncEntry({ status: 'failed', error: 'boom', createdAt: '2026-08-17T15:00:00.000Z' }) },
    { id: 'g', createdAt: '2026-08-17T16:00:00.000Z', kind: 'autosync', autosync: autosyncEntry({ status: 'partial', createdAt: '2026-08-17T16:00:00.000Z' }) },
  ];
  assert.deepEqual(summarizeSyncHistory(rows), {
    total: 7, snapshots: 3, autosync: 4, failed: 1, skipped: 2,
  });
});

test('summarizeSyncHistory：空列表 → 全零', () => {
  assert.deepEqual(summarizeSyncHistory([]), {
    total: 0, snapshots: 0, autosync: 0, failed: 0, skipped: 0,
  });
});

test('summarizeSyncHistory：autosync 缺 autosync 子对象 → 计入 autosync 但不计入 failed/skipped（防御）', () => {
  const rows: SyncHistoryEntry[] = [{ id: 'x', createdAt: '2026-08-17T10:00:00.000Z', kind: 'autosync' }];
  assert.deepEqual(summarizeSyncHistory(rows), {
    total: 1, snapshots: 0, autosync: 1, failed: 0, skipped: 0,
  });
});

/* ================================================================ client-F1 回归 */

test('client-F1：en 界面下自动同步行的三个标签必须全是英文（不得含中文）', () => {
  const row = projectAutosyncEntry(autosyncEntry({ status: 'skipped', skipReason: 'conflict' }), enT);
  const joined = [row.direction, row.status, row.skipReasonText, row.summary].join(' | ');
  assert.doesNotMatch(joined, /[\u4e00-\u9fff]/, 'en 界面下不得出现中文：' + joined);
  assert.equal(row.direction, 'Both');
  assert.equal(row.status, 'Skipped');
});

test('client-F1 源码守卫：标签函数体不得含中文字面量；跳过原因一律经 skipReasonKey 取字典键', () => {
  const src = fs.readFileSync(new URL('./history-model.ts', import.meta.url), 'utf8');
  for (const fn of ['directionLabel', 'autosyncStatusLabel', 'describeSkipReason']) {
    const start = src.indexOf('export function ' + fn);
    assert.ok(start >= 0, fn + ' 必须存在（守卫需同步更新）');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end < 0 ? src.length : end);
    assert.doesNotMatch(body, /[\u4e00-\u9fff]/, fn + ' 函数体内不得含中文字面量');
  }
  // issue #79：映射抽到 skipReasonKey（历史行与自动同步状态行共用一份），守卫落点随之挪到它，
  // 但硬约束不变：**文案只许来自字典**，且 describeSkipReason 不得再自带第二份 switch。
  const mapStart = src.indexOf('export function skipReasonKey');
  assert.ok(mapStart >= 0, 'skipReasonKey 必须存在（守卫需同步更新）');
  const mapEnd = src.indexOf('\n}', mapStart);
  const mapBody = src.slice(mapStart, mapEnd < 0 ? src.length : mapEnd);
  for (const key of ['history.autosyncReasonConflict', 'history.autosyncReasonNoRemote', 'history.autosyncReasonNotConfigured', 'history.autosyncReasonNetwork']) {
    assert.ok(mapBody.includes("'" + key + "'"), 'skipReasonKey 必须映射字典键 ' + key);
  }
  const reasonStart = src.indexOf('export function describeSkipReason');
  const reasonEnd = src.indexOf('\n}', reasonStart);
  const reasonBody = src.slice(reasonStart, reasonEnd < 0 ? src.length : reasonEnd);
  assert.ok(reasonBody.includes('skipReasonKey('), 'describeSkipReason 必须经 skipReasonKey 取键');
});

/* ================================================================ issue #79 */

test('issue #79：skipReasonKey —— 新旧码都映射到字典键，未知码返回 null（不猜）', () => {
  assert.equal(skipReasonKey('conflict'), 'history.autosyncReasonConflict');
  assert.equal(skipReasonKey('not-configured'), 'history.autosyncReasonNotConfigured');
  // 宿主同一语义两处命名：历史写 'unconfigured'，两处必须同一文案
  assert.equal(skipReasonKey('unconfigured'), 'history.autosyncReasonNotConfigured');
  assert.equal(skipReasonKey('upToDate'), 'history.autosyncReasonUpToDate');
  assert.equal(skipReasonKey('unchanged'), 'history.autosyncReasonUnchanged');
  assert.equal(skipReasonKey('mutation-locked'), 'history.autosyncReasonMutationLocked');
  assert.equal(skipReasonKey('future-code-from-newer-host'), null, '未知码不猜');
  assert.equal(skipReasonKey(undefined), null);
});

test('issue #79：describeSkipReason 未知码保留宿主原串（不吞信息）', () => {
  assert.equal(describeSkipReason('brand-new-reason', zhT), 'brand-new-reason');
  assert.equal(describeSkipReason(undefined, zhT), syncZh['history.autosyncReasonUnknown']);
});
