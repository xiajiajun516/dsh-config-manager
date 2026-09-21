/**
 * 恢复计划展示模型单测：分组顺序、状态合并、行数合计、旧宿主回退、状态回填重分组。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { RestorePlan } from '../core/restore.ts';
import type { RestoreChangeSummary, SnapshotChangeEntry } from '../core/snapshot-diff.ts';
import { isDiffableKind, toRestorePlanView, withLoadedStatus } from './restore-plan-view.ts';

function plan(): RestorePlan {
  return {
    snapshotId: 'snap-1',
    createdAt: '2026-09-21T00:00:00.000Z',
    sourceZip: 'x.zip',
    pluginBaselineConfirmed: true,
    summary: { hostFileRestores: 1, hostFileRemoves: 1, pluginRemoves: 1, fileRestores: 1, fileRemoves: 0, credentialHints: 1, skips: 3 },
    actions: [
      { kind: 'hostFileRestore', description: '整文件还原 settings.yaml', target: 'settings.yaml', blobPath: 'blobs/a', detail: '会先备份' },
      { kind: 'fileRestore', description: '还原文件 skills/x.md', target: 'skills/x.md', blobPath: 'blobs/b' },
      { kind: 'hostFileRemove', description: '整文件删除 new.yaml', target: 'new.yaml' },
      { kind: 'pluginRemove', description: '卸载插件 foo', target: 'foo', pluginName: 'foo' },
      { kind: 'credentialHint', description: '凭据需人工补录' },
      { kind: 'skip', description: '跳过：技能不存在', target: 'skills/y.md' },
      { kind: 'skip', description: '跳过：无新增插件' },
      { kind: 'skip', description: '跳过：settings 未备份' },
    ],
  };
}

function summary(entries: Partial<SnapshotChangeEntry>[]): RestoreChangeSummary {
  const full: SnapshotChangeEntry[] = entries.map((entry, index) => ({
    index: entry.index ?? index,
    kind: entry.kind ?? 'hostFileRestore',
    status: entry.status ?? 'modified',
    description: entry.description ?? 'd',
    beforeExists: entry.beforeExists ?? true,
    afterExists: entry.afterExists ?? true,
    ...entry,
  }));
  return { entries: full, computed: full.length, skipped: 0, totalBytes: 0, budgetExhausted: false, limits: {} as RestoreChangeSummary['limits'] };
}

test('R-01 分组顺序与统计：变更→删除→插件→人工→跳过', () => {
  const view = toRestorePlanView(plan(), summary([
    { index: 0, status: 'modified', added: 5, removed: 2 },
    { index: 1, status: 'added', added: 9, removed: 0 },
    { index: 2, status: 'deleted', added: 0, removed: 4 },
    { index: 3, status: 'plugin' },
    { index: 4, status: 'hint' },
    { index: 5, status: 'skip' },
    { index: 6, status: 'skip' },
    { index: 7, status: 'skip' },
  ]));
  assert.deepEqual(view.groups.map((group) => group.key), ['changes', 'deletes', 'plugins', 'hints', 'skips']);
  assert.equal(view.groups[0]?.rows.length, 2);
  assert.equal(view.groups[4]?.rows.length, 3);
  assert.equal(view.stats.changed, 2);
  assert.equal(view.stats.modified, 1);
  assert.equal(view.stats.added, 1);
  assert.equal(view.stats.deleted, 1);
  assert.equal(view.stats.plugins, 1);
  assert.equal(view.stats.skips, 3);
  assert.equal(view.stats.addedLines, 14);
  assert.equal(view.stats.removedLines, 6);
  assert.equal(view.summarized, true);
});

test('R-02 旧宿主（无 changeSummary）：按 kind 推断状态，summarized=false', () => {
  const view = toRestorePlanView(plan());
  assert.equal(view.summarized, false);
  assert.deepEqual(view.groups.map((group) => group.key), ['changes', 'deletes', 'plugins', 'hints', 'skips']);
  const changes = view.groups[0];
  assert.equal(changes?.rows.every((row) => row.status === 'modified'), true);
  assert.equal(view.stats.changed, 2, '两个还原动作都推断为修改');
  assert.equal(view.stats.unstatted, 3, '可 diff 的文件类动作未统计行数');
});

test('R-03 未统计行数（大文件/二进制/预算）：计入 unstatted，不计入行数合计', () => {
  const view = toRestorePlanView(plan(), summary([
    { index: 0, status: 'modified', added: 5, removed: 2 },
    { index: 1, status: 'added', statSkipped: 'too-large' },
    { index: 2, status: 'deleted', statSkipped: 'binary' },
  ]));
  assert.equal(view.stats.unstatted, 2);
  assert.equal(view.stats.addedLines, 5);
  assert.equal(view.stats.removedLines, 2);
  assert.equal(view.groups[0]?.counted, 1);
});

test('R-04 diffable：只有文件内容类动作可展开（且必须有 target）', () => {
  assert.equal(isDiffableKind('hostFileRestore'), true);
  assert.equal(isDiffableKind('fileRemove'), true);
  assert.equal(isDiffableKind('pluginRemove'), false);
  assert.equal(isDiffableKind('skip'), false);
  const view = toRestorePlanView(plan());
  const flat = view.groups.flatMap((group) => group.rows);
  assert.equal(flat.find((row) => row.kind === 'pluginRemove')?.diffable, false);
  assert.equal(flat.find((row) => row.kind === 'hostFileRestore')?.diffable, true);
});

test('R-05 withLoadedStatus：状态修正后重新分组（推断 modified → 实际 added）', () => {
  const view = toRestorePlanView(plan());
  const patched = withLoadedStatus(view, 1, 'added', 7, 0);
  const changes = patched.groups[0];
  assert.ok(changes !== undefined);
  assert.equal(changes.rows.find((row) => row.index === 1)?.status, 'added');
  assert.equal(changes.added, 7);
  assert.equal(patched.groups.map((group) => group.key).includes('deletes'), true, '其他组不受影响');
});

test('R-06 withLoadedStatus：未知下标原样返回（不抛错）', () => {
  const view = toRestorePlanView(plan());
  assert.equal(withLoadedStatus(view, 99, 'added', 1, 1), view);
});

test('R-07 budgetExhausted 透传（UI 需提示「统计已截断」）', () => {
  const s = summary([{ index: 0, status: 'modified', added: 1, removed: 1 }]);
  const view = toRestorePlanView(plan(), { ...s, budgetExhausted: true });
  assert.equal(view.budgetExhausted, true);
});
