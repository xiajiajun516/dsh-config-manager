/**
 * P3 计划期标记的守卫：比对结论只改展示字段，不能把「已被阻断的项」降级。
 *
 * 背景（审查第 4 条）：这里曾经无条件写 severity='warning'，而 SEC-05 在 analyzeBundle
 * 期已把表外条目设成 kind='Error' + severity='error'——那正是「为什么不导」的红色原因，
 * 被降成普通警告后用户会以为只是提醒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { markSessionVerdicts } from './session-verdict-plan.ts';
import type { PlanItem, SessionCompareRow } from './types.ts';

function planItem(patch: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    kind: 'Create',
    adapter: 'sessions',
    description: 'desc',
    severity: 'info',
    ...patch,
  } as PlanItem;
}

const ROW: SessionCompareRow = {
  unitId: 'proj-1/sess-1',
  verdict: 'localAhead',
  packEvents: 4,
  localEvents: 7,
  localAheadBy: 3,
};

test('P3-P1 已被阻断的项（kind=Error / severity=error）不得被降级', () => {
  const item = planItem({ id: 'sessions:proj-1/sess-1', kind: 'Error', severity: 'error' });
  markSessionVerdicts([item], [ROW]);
  assert.equal(item.severity, 'error', '「为什么不导」的红标必须留着');
  assert.equal(item.kind, 'Error');
  assert.equal(item.sessionVerdict?.verdict, 'localAhead', '结论本身仍要标出来');
});

test('P3-P2 普通项遇到 localAhead / diverged ⇒ 升为 warning 并带覆盖条数', () => {
  const item = planItem({ id: 'sessions:proj-1/sess-1', unitId: 'proj-1/sess-1' });
  markSessionVerdicts([item], [ROW]);
  assert.equal(item.severity, 'warning');
  assert.deepEqual(item.sessionVerdict, {
    verdict: 'localAhead', packEvents: 4, localEvents: 7, localAheadBy: 3,
  });
});

test('P3-P3 一致 / 包内更新的项不改 severity，只带结论', () => {
  const item = planItem({ id: 'sessions:proj-1/sess-1', severity: 'info' });
  markSessionVerdicts([item], [{ ...ROW, verdict: 'identical', localAheadBy: undefined }]);
  assert.equal(item.severity, 'info');
  assert.equal(item.sessionVerdict?.verdict, 'identical');
});

test('P3-P4 没有对应结论的项原样不动；结论为空时整轮 no-op', () => {
  const other = planItem({ id: 'sessions:proj-1/sess-9' });
  markSessionVerdicts([other], [ROW]);
  assert.equal(other.sessionVerdict, undefined);
  assert.equal(other.severity, 'info');

  const untouched = planItem({ id: 'sessions:proj-1/sess-1' });
  markSessionVerdicts([untouched], []);
  assert.equal(untouched.sessionVerdict, undefined);
});

test('P3-P5 键空间两侧都认：包内单元 id 与计划项 unitId 前缀不一致也能对上', () => {
  const item = planItem({ id: 'sessions:proj-1/sess-1', unitId: 'sessions:proj-1/sess-1' });
  markSessionVerdicts([item], [ROW]);
  assert.equal(item.sessionVerdict?.verdict, 'localAhead');
});
