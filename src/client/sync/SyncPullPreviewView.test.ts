/**
 * P2b SyncPullPreviewView 纯函数测试：projectReviewItems / describeConflicts / formatDiff。
 * 组件挂载 + 交互通过 React 渲染测试覆盖（node --test 不跑 React 渲染；本文件
 * 覆盖核心数据投影逻辑——这是组件层以下的可测部分）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectReviewItems, describeConflicts, formatDiff } from './pull-preview-model.ts';
import type { SyncApplyPlan } from '../../sync/risk.ts';
import type { MergeSectionResult } from '../../sync/merge.ts';
import type { SectionId } from '../../schema/types.ts';

const rev = (id: SectionId, conflicts: MergeSectionResult['conflicts']): MergeSectionResult => ({
  id, decision: 'conflict', conflicts,
});

test('projectReviewItems：review → ReviewDisplayItem，sectionId 与 description 正确', () => {
  const apply: SyncApplyPlan = {
    autoApply: [],
    review: [rev('settings', [{ path: 'general', kind: 'key' }]), rev('workspaces', [])],
    skipped: [],
  };
  const out = projectReviewItems(apply);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.sectionId, 'settings');
  assert.equal(out[0]!.description, '冲突：general');
  assert.equal(out[0]!.initial, 'pending');
  assert.equal(out[1]!.sectionId, 'workspaces');
  assert.equal(out[1]!.description, '分区 workspaces 待审');
});

test('describeConflicts：空 → 「无变更描述」；多条 → 逗号分隔 + +N', () => {
  assert.equal(describeConflicts([]), '无变更描述');
  assert.equal(describeConflicts([{ path: 'a', kind: 'key' }]), '冲突：a');
  assert.equal(describeConflicts([
    { path: 'a', kind: 'key' },
    { path: 'b', kind: 'key' },
  ]), '冲突：a, b');
  assert.equal(describeConflicts([
    { path: 'a', kind: 'key' },
    { path: 'b', kind: 'key' },
    { path: 'c', kind: 'key' },
  ]), '冲突：a, b +1');
});

test('formatDiff：local==remote → 「（值相同）」；否则显示 JSON 文本', () => {
  assert.equal(formatDiff({ a: 1 }, { a: 1 }), '（值相同）');
  const out = formatDiff({ a: 1 }, { a: 2 });
  assert.ok(out.includes('local:'));
  assert.ok(out.includes('remote:'));
  assert.ok(out.includes('"a":1'));
  assert.ok(out.includes('"a":2'));
});
