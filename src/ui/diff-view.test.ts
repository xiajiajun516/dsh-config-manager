/**
 * 差异视图渲染模型单测：双栏对齐（成对修改 / 单侧增删）、块头文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines } from '../utils/line-diff.ts';
import { countSideRows, hunkHeader, maxLineDigits, toSideBySide } from './diff-view.ts';

test('V-01 成对修改：3 删 1 增 → 1 个 change 行对 + 2 个 del 行对（左有右空）', () => {
  const r = diffLines('a\nX1\nX2\nX3\nb', 'a\nY1\nb', { context: 1 });
  const groups = toSideBySide(r.hunks);
  assert.equal(groups.length, 1);
  const rows = groups[0]?.rows ?? [];
  assert.deepEqual(rows.map((row) => row.kind), ['context', 'change', 'del', 'del', 'context']);
  assert.equal(rows[1]?.left?.text, 'X1');
  assert.equal(rows[1]?.right?.text, 'Y1');
  assert.equal(rows[2]?.left?.text, 'X2');
  assert.equal(rows[2]?.right, null);
});

test('V-02 纯新增：左侧为占位（left=null）', () => {
  const r = diffLines('a\nb', 'a\nNEW\nb');
  const rows = toSideBySide(r.hunks)[0]?.rows ?? [];
  const added = rows.find((row) => row.kind === 'add');
  assert.ok(added !== undefined);
  assert.equal(added.left, null);
  assert.equal(added.right?.text, 'NEW');
});

test('V-03 纯删除：右侧为占位（right=null）', () => {
  const r = diffLines('a\nGONE\nb', 'a\nb');
  const rows = toSideBySide(r.hunks)[0]?.rows ?? [];
  const del = rows.find((row) => row.kind === 'del');
  assert.ok(del !== undefined);
  assert.equal(del.right, null);
  assert.equal(del.left?.text, 'GONE');
});

test('V-04 块头文本与 git unified 一致', () => {
  const r = diffLines('a\nb\nc', 'a\nZ\nc', { context: 1 });
  const hunk = r.hunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunkHeader(hunk), `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
  assert.equal(hunkHeader(hunk), '@@ -1,3 +1,3 @@');
});

test('V-05 无差异：空 hunks → 0 行对', () => {
  const r = diffLines('same', 'same');
  assert.equal(countSideRows(toSideBySide(r.hunks)), 0);
});

test('V-06 行对总数 = 上下文 + 成对/单侧行', () => {
  const r = diffLines('1\n2\n3\n4\n5', '1\n2\nX\n4\n5', { context: 1 });
  const groups = toSideBySide(r.hunks);
  assert.equal(countSideRows(groups), 3, 'context 1 + 1 + context 1');
});

test('V-07 maxLineDigits：按实际出现的最大行号取位数（列宽档位依据）', () => {
  assert.equal(maxLineDigits([]), 1, '空 hunks → 至少 1 位');
  const small = diffLines('a\nb\nc', 'a\nX\nc', { context: 1 });
  assert.equal(maxLineDigits(small.hunks), 1);
  const lines = Array.from({ length: 120 }, (_, i) => 'line' + String(i));
  const big = diffLines(lines.join('\n'), lines.map((l, i) => (i === 118 ? 'changed' : l)).join('\n'), { context: 2 });
  assert.equal(maxLineDigits(big.hunks), 3, '第 119/120 行 → 3 位');
});
