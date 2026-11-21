/**
 * P3 单测：会话逐条比对的纯函数层（不碰 fs、不碰 zstd）。
 *
 * 这些用例钉住的是「用户在确认页看到的那句话能不能被代码证明」：
 *  - 跨机 cwd 不同 **不是** 差异（否则每次跨机恢复都误报 diverged）；
 *  - 本机多出内容必须说成 localAhead 并给出条数（导入会覆盖掉这些）；
 *  - bookkeeping 噪声不许冒充「本机更新」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateSessionRows,
  canonicalEventLine,
  canonicalEventLines,
  compareEventStreams,
  countSessionVerdicts,
  overwriteExposure,
} from './session-compare.ts';
import type { SessionCompareRow } from './types.ts';

function row(partial: Partial<SessionCompareRow> & Pick<SessionCompareRow, 'verdict'>): SessionCompareRow {
  return { unitId: partial.unitId ?? 'proj/sess-1', packEvents: 1, localEvents: 1, ...partial };
}

test('P3-1 cwd 归一：导出机与本机路径不同不算差异', () => {
  const pack = '{"type":"session/header","cwd":"/Users/a/work/proj","id":"s1"}';
  const local = '{"id":"s1","cwd":"D:\\\\work\\\\proj","type":"session/header"}';
  // 键顺序与 cwd 值都不同 → 规范化后必须相等
  assert.equal(canonicalEventLine(pack), canonicalEventLine(local));
  assert.equal(compareEventStreams(canonicalEventLines(pack), canonicalEventLines(local)).verdict, 'identical');
});

test('P3-2 规范化保留嵌套结构差异，且空行被丢弃', () => {
  const lines = canonicalEventLines('\n{"a":{"b":1,"c":2}}\n\n');
  assert.deepEqual(lines, ['{"a":{"b":1,"c":2}}']);
  assert.equal(canonicalEventLine('{"a":{"b":1,"c":3}}') === lines[0], false);
});

test('P3-3 不可解析的行按原文保留（宁可判分叉也不假装一致）', () => {
  assert.equal(canonicalEventLine('  不是 JSON  '), '不是 JSON');
  const diff = compareEventStreams(['{"a":1}'], ['{"a":2}']);
  assert.equal(diff.verdict, 'diverged');
  assert.equal(diff.divergedAt, 0);
});

test('P3-4 逐条一致 → identical，无 ahead 计数', () => {
  const diff = compareEventStreams(['{"a":1}', '{"b":2}'], ['{"a":1}', '{"b":2}']);
  assert.equal(diff.verdict, 'identical');
  assert.equal(diff.packEvents, 2);
  assert.equal(diff.localEvents, 2);
  assert.equal(diff.packAheadBy, 0);
  assert.equal(diff.localAheadBy, 0);
});

test('P3-5 包是本机前缀 → 本机更新（导入会覆盖掉多出的条数）', () => {
  const diff = compareEventStreams(['{"a":1}'], ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(diff.verdict, 'localAhead');
  assert.equal(diff.localAheadBy, 2);
  assert.equal(diff.packAheadBy, 0);
});

test('P3-6 本机是包前缀 → 包更新（导入后多出条数）', () => {
  const diff = compareEventStreams(['{"a":1}', '{"b":2}'], ['{"a":1}']);
  assert.equal(diff.verdict, 'packAhead');
  assert.equal(diff.packAheadBy, 1);
  assert.equal(diff.localAheadBy, 0);
});

test('P3-7 前缀之后两边都有内容 → diverged 且记录首个不一致位置', () => {
  const diff = compareEventStreams(['{"a":1}', '{"b":2}'], ['{"a":1}', '{"z":9}']);
  assert.equal(diff.verdict, 'diverged');
  assert.equal(diff.divergedAt, 1);
  assert.equal(diff.packAheadBy, 1);
  assert.equal(diff.localAheadBy, 1);
});

test('P3-8 bookkeeping 噪声不冒充差异（尾部只有 session-log-* / session/end-seed）', () => {
  const localOnly = compareEventStreams(
    ['{"type":"turn/start"}'],
    ['{"type":"turn/start"}', '{"type":"session-log-marker"}', '{"type":"session/end-seed"}'],
  );
  assert.equal(localOnly.verdict, 'identical');
  assert.equal(localOnly.localAheadBy, 0);
  const packOnly = compareEventStreams(
    ['{"type":"turn/start"}', '{"type":"session-log-marker"}'],
    ['{"type":"turn/start"}'],
  );
  assert.equal(packOnly.verdict, 'identical');
  assert.equal(packOnly.packAheadBy, 0);
});

test('P3-9 同单元多份日志取最严重，并汇总条数', () => {
  const a = compareEventStreams(['{"a":1}'], ['{"a":1}', '{"b":2}']); // localAhead
  const b = compareEventStreams(['{"a":1}'], ['{"z":9}']); // diverged
  const worst = aggregateSessionRows('proj/sess-1', [a, b]);
  assert.equal(worst.verdict, 'diverged');
  assert.equal(worst.packEvents, 2);
  assert.equal(worst.localEvents, 3);
  assert.equal(worst.localAheadBy, 2);
  assert.equal(worst.divergedAt, 0);
  // 空 diffs = 没有任何可比数据（≠ 本机没有该会话：那种情况由适配器直接产出 'new'）
  assert.equal(aggregateSessionRows('proj/sess-2', []).verdict, 'unreadable');
});

test('P3-10 汇总计数与「会覆盖掉多少」只算 localAhead + diverged', () => {
  const rows: SessionCompareRow[] = [
    row({ unitId: 'p/s1', verdict: 'identical' }),
    row({ unitId: 'p/s2', verdict: 'packAhead', packAheadBy: 3 }),
    row({ unitId: 'p/s3', verdict: 'localAhead', localAheadBy: 5 }),
    row({ unitId: 'p/s4', verdict: 'diverged', localAheadBy: 2, packAheadBy: 1 }),
    row({ unitId: 'p/s5', verdict: 'new', packEvents: 4, localEvents: 0 }),
    row({ unitId: 'p/s6', verdict: 'unreadable', packEvents: 0, localEvents: 0 }),
  ];
  const counts = countSessionVerdicts(rows);
  assert.deepEqual(counts, { new: 1, identical: 1, packAhead: 1, localAhead: 1, diverged: 1, unreadable: 1 });
  assert.deepEqual(overwriteExposure(rows), { units: 2, events: 7 });
  assert.deepEqual(overwriteExposure([]), { units: 0, events: 0 });
});
