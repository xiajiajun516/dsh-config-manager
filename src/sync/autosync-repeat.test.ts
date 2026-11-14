/**
 * autosync-repeat：自动同步历史的「同一结论」签名（2026-11-14 真机事故 P1）。
 *
 * 现场：远端工作副本被别的设备推进后，每 60s 的 remote-poll 轮都会走一遍「合并 → 推送被挡 →
 * 记一条 partial|conflict」，sync-history 的 200 条上限里 196 条是同一句话、间隔精确 60s。
 * 签名 = 「这一轮说的还是不是同一件事」；返回 null 表示「必须记」（真推进 / 成败都要留痕）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { repeatHistorySignature } from './autosync-repeat.ts';
import type { RepeatSignatureEntry } from './autosync-repeat.ts';

function entry(patch: Partial<RepeatSignatureEntry> = {}): RepeatSignatureEntry {
  return {
    status: 'partial',
    direction: 'push',
    skipReason: 'conflict',
    conflictedSections: ['plugins'],
    appliedSections: [],
    error: '远端最新快照 sync-remote 与本地基线 sync-base 不一致：本次推送未执行',
    ...patch,
  } as RepeatSignatureEntry;
}

test('同一结论（同一远端快照 / 同一冲突分区）→ 同一个签名', () => {
  const a = repeatHistorySignature('git', entry());
  const b = repeatHistorySignature('git', entry());
  assert.notEqual(a, null);
  assert.equal(a, b);
});

test('分区顺序与空值形态不影响签名（同一结论就是同一结论）', () => {
  const a = repeatHistorySignature('git', entry({ conflictedSections: ['plugins', 'settings'] }));
  const b = repeatHistorySignature('git', entry({ conflictedSections: ['settings', 'plugins'] }));
  assert.equal(a, b);

  const c = repeatHistorySignature('git', entry({ conflictedSections: undefined, skipReason: undefined }));
  const d = repeatHistorySignature('git', entry({ conflictedSections: [] as never, skipReason: undefined }));
  assert.equal(c, d, '缺席与空数组同义（都是「没有分区」）');
});

test('结论变化 → 签名必须变（新事实要留新记录）', () => {
  const base = repeatHistorySignature('git', entry());
  assert.notEqual(base, repeatHistorySignature('git', entry({ error: '远端最新快照 sync-newer 与本地基线 sync-base 不一致' })));
  assert.notEqual(base, repeatHistorySignature('git', entry({ conflictedSections: ['settings'] })));
  assert.notEqual(base, repeatHistorySignature('git', entry({ skipReason: 'conflict-kept-local' })));
  assert.notEqual(base, repeatHistorySignature('git', entry({ appliedSections: ['settings'] })));
  assert.notEqual(base, repeatHistorySignature('git', entry({ status: 'skipped' })));
  assert.notEqual(base, repeatHistorySignature('webdav', entry()), '通道不同不是同一件事');
});

test('成功 / 失败 / 真推进的轮次恒返回 null（这些必须逐条可见）', () => {
  assert.equal(repeatHistorySignature('git', entry({ status: 'success' })), null);
  assert.equal(repeatHistorySignature('git', entry({ status: 'failed' })), null);
  assert.equal(repeatHistorySignature('git', entry({ pushedSnapshotId: 'sync-pushed' })), null);
  assert.equal(repeatHistorySignature('git', entry({ pulledSnapshotId: 'sync-pulled' })), null);
});
