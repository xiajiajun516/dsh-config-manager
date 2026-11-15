import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingMergeFor } from './pending-merge.ts';
import type { SyncState } from './sync-state.ts';
import type { SectionId } from '../schema/types.ts';

const NOW = '2026-11-15T00:00:00.000Z';
const LATER = '2026-11-15T03:00:00.000Z';

function stateWith(sections: SectionId[], remoteSnapshotId: string, since: string): SyncState {
  return { version: 1, sections: {}, pendingMerge: { remoteSnapshotId, sections, since } } as unknown as SyncState;
}

/**
 * issue #146 成因链（follow-up）：pendingMerge 同时是「这轮还要扣下哪些分区」的事实源，
 * 而每轮上报的冲突只是「本轮查出来的那一部分」—— 替换语义会让上一轮的分区凭空消失，
 * 下一轮该分区若判无冲突就整分区上行（正是 #146 的插件列表被覆盖回去）。
 */
test('pendingMergeFor: 同一远端快照上连续上报取并集（不同来源的扣下不得互相抹掉）', () => {
  const first = pendingMergeFor(stateWith(['plugins'], 'sync-r1', NOW), 'sync-r1', ['plugins'], NOW);
  assert.deepEqual(first.sections, ['plugins']);

  const second = pendingMergeFor(stateWith(first.sections, 'sync-r1', first.since), 'sync-r1', ['mcp'], LATER);
  assert.deepEqual(second.sections, ['plugins', 'mcp'], '上一轮的 plugins 必须留下');
  assert.equal(second.since, NOW, '并集不刷新 since（界面上的「等多久」保持首次）');

  const third = pendingMergeFor(stateWith(second.sections, 'sync-r1', second.since), 'sync-r1', ['plugins'], LATER);
  assert.deepEqual(third.sections, ['plugins', 'mcp'], '重复上报不产生重复项');
});

test('pendingMergeFor: 远端换了一版 → 重新计时、重新计集合（旧快照的待裁决已作废）', () => {
  const next = pendingMergeFor(stateWith(['plugins'], 'sync-r1', NOW), 'sync-r2', ['mcp'], LATER);
  assert.deepEqual(next.sections, ['mcp'], '换快照后不继承旧集合');
  assert.equal(next.since, LATER, '换快照要重新计时');
});

test('pendingMergeFor: 没有历史待裁决 → 直接用本轮集合', () => {
  const fresh = pendingMergeFor({ version: 1, sections: {} } as unknown as SyncState, 'sync-r1', ['settings'], NOW);
  assert.deepEqual(fresh, { remoteSnapshotId: 'sync-r1', sections: ['settings'], since: NOW });
});
