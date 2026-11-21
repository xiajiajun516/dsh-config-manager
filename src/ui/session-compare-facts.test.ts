/** P3 单测：UI 事实层（框架无关，node 可测）。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sessionCompareAttentionRows,
  sessionCompareFactsFromAnalysis,
  sessionCompareFactsFromPlan,
  sessionCompareVerdictKey,
} from './session-compare-facts.ts';
import type { ImportAnalysis, PlanItem, SessionCompareRow } from '../core/types.ts';

function analysisWith(rows: SessionCompareRow[], extra: Partial<NonNullable<ImportAnalysis['sessionCompare']>> = {}): Pick<ImportAnalysis, 'sessionCompare'> {
  return {
    sessionCompare: { rows, skipped: 0, attachmentsReferenced: 0, attachmentsMissing: [], ...extra },
  };
}

const ROWS: SessionCompareRow[] = [
  { unitId: 'p/a', verdict: 'identical', packEvents: 3, localEvents: 3 },
  { unitId: 'p/b', verdict: 'localAhead', packEvents: 3, localEvents: 9, localAheadBy: 6 },
  { unitId: 'p/c', verdict: 'diverged', packEvents: 4, localEvents: 5, localAheadBy: 2, packAheadBy: 1 },
  { unitId: 'p/d', verdict: 'new', packEvents: 2, localEvents: 0 },
];

test('P3-UI-1 分析结果 → 五态计数与覆盖量（new 映射成 fresh）', () => {
  const facts = sessionCompareFactsFromAnalysis(analysisWith(ROWS));
  assert.ok(facts !== null);
  assert.equal(facts.compared, 4);
  assert.deepEqual(facts.counts, { identical: 1, packAhead: 0, localAhead: 1, diverged: 1, fresh: 1, unreadable: 0 });
  assert.deepEqual(facts.overwrite, { units: 2, events: 8 });
  assert.equal(facts.lossy, true);
});

test('P3-UI-2 缺省 ≠ 一致：没有比对结果返回 null，绝不返回全零事实', () => {
  assert.equal(sessionCompareFactsFromAnalysis(null), null);
  assert.equal(sessionCompareFactsFromAnalysis({}), null);
  assert.equal(sessionCompareFactsFromAnalysis({ sessionCompare: undefined }), null);
});

test('P3-UI-3 只有一致项时 lossy=false；附件缺失单独也能让它为真', () => {
  const clean = sessionCompareFactsFromAnalysis(analysisWith([ROWS[0] as SessionCompareRow]));
  assert.equal(clean?.lossy, false);
  const missing = sessionCompareFactsFromAnalysis(
    analysisWith([ROWS[0] as SessionCompareRow], { attachmentsReferenced: 3, attachmentsMissing: ['sha256:aa'] }),
  );
  assert.equal(missing?.lossy, true);
  assert.equal(missing?.attachmentsReferenced, 3);
  assert.deepEqual(missing?.attachmentsMissing, ['sha256:aa']);
});

test('P3-UI-4 计划项 → 同一口径；没有 sessionVerdict 的项不算已比对', () => {
  const items = [
    { id: 'sessions:p/b', kind: 'Update', adapter: 'sessions', target: '', sessionVerdict: { verdict: 'localAhead', packEvents: 3, localEvents: 9, localAheadBy: 6 } },
    { id: 'sessions:p/a', kind: 'Update', adapter: 'sessions', target: '' },
  ] as unknown as PlanItem[];
  const facts = sessionCompareFactsFromPlan(items);
  assert.equal(facts?.compared, 1);
  assert.deepEqual(facts?.overwrite, { units: 1, events: 6 });
  assert.equal(sessionCompareFactsFromPlan([]), null);
});

test('P3-UI-5 关注行只列覆盖/分叉，按会被覆盖的条数降序', () => {
  const rows = sessionCompareAttentionRows(analysisWith(ROWS));
  assert.deepEqual(rows.map((r) => r.unitId), ['p/b', 'p/c']);
  assert.equal(sessionCompareVerdictKey('fresh'), 'import.sessionCompare.verdict.fresh');
});
