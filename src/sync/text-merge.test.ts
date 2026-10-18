/**
 * m-sync-flow：text-merge（行级文本三方合并 + 递归 JSON 结构化合并）单元测试。
 *
 * 覆盖：形态判定 / 首次同步（缺祖先）/ 单边 / 双边不同行 / 双边同行冲突 / 两侧改成相同结果 /
 * 空文件 / 缺失文件 / 纯二进制 / 超大 / 非法 JSON / 深层嵌套 / 数组单边 / 数组双改冲突 /
 * JSON 文本成功合并 / CRLF 与 LF 混用 / 末尾无换行 / 重复行不错位 /
 * 键删除语义与「未知键绝不静默丢弃」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeBytesThreeWay,
  mergeJsonValues,
  mergeTextThreeWay,
  looksLikeText,
  tryParseJson,
  TEXT_MERGE_MAX_BYTES,
  type TextMergeConflict,
} from './text-merge.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** 断言无冲突并返回合并结果（失败信息带 conflicts，便于定位）。 */
function mergedOrThrow(result: { ok: boolean; merged?: string; conflicts: TextMergeConflict[] }): string {
  assert.equal(result.ok, true, '期望合并没有冲突，实际 conflicts=' + JSON.stringify(result.conflicts));
  assert.ok(result.merged !== undefined, '期望有 merged');
  return result.merged;
}

// ---------------------------------------------------------------------------
// 形态判定
// ---------------------------------------------------------------------------

test('looksLikeText: 合法 UTF-8 文本 → true', () => {
  assert.equal(looksLikeText(enc('hello 世界\n')), true);
  assert.equal(looksLikeText(new Uint8Array(0)), true);
});

test('looksLikeText: 含 NUL 字节 → false', () => {
  assert.equal(looksLikeText(new Uint8Array([0x61, 0x00, 0x62])), false);
});

test('looksLikeText: 非法 UTF-8 → false', () => {
  assert.equal(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41])), false);
});

test('looksLikeText: 超过 maxBytes → false（含显式传入的上限）', () => {
  assert.equal(looksLikeText(enc('hello'), 3), false);
  const big = new Uint8Array(TEXT_MERGE_MAX_BYTES + 1).fill(0x61);
  assert.equal(looksLikeText(big), false);
  assert.equal(looksLikeText(new Uint8Array(TEXT_MERGE_MAX_BYTES).fill(0x61)), true);
});

test('tryParseJson: 合法 JSON 返回 value，非法返回 ok:false', () => {
  const ok = tryParseJson('{"a":[1,2]}');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { a: [1, 2] });
  assert.equal(tryParseJson('{"a":1').ok, false);
  assert.equal(tryParseJson('').ok, false);
  assert.equal(tryParseJson('{a:1}').ok, false);
});

// ---------------------------------------------------------------------------
// JSON 结构化合并
// ---------------------------------------------------------------------------

test('mergeJsonValues: 单侧改动 → 采纳该侧，另一侧未改的键原样保留', () => {
  const ancestor = { a: 1, keep: 'x' };
  const local = { a: 2, keep: 'x' };
  const remote = { a: 1, keep: 'x' };
  const r = mergeJsonValues(ancestor, local, remote);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { a: 2, keep: 'x' });
});

test('mergeJsonValues: 深层嵌套（3 层以上）双侧改不同叶子 → 全部保住', () => {
  const ancestor = { a: { b: { c: { d: 1, e: 2 }, f: [1, 2] } }, top: true };
  const local = { a: { b: { c: { d: 10, e: 2 }, f: [1, 2] } }, top: true };
  const remote = { a: { b: { c: { d: 1, e: 20 }, f: [1, 2] } }, top: true };
  const r = mergeJsonValues(ancestor, local, remote);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { a: { b: { c: { d: 10, e: 20 }, f: [1, 2] } }, top: true });
});

test('mergeJsonValues: 同一叶子双侧改成不同值 → 冲突（点号路径），ok=false 且无 merged', () => {
  const ancestor = { a: { b: { c: 1 } } };
  const local = { a: { b: { c: 2 } } };
  const remote = { a: { b: { c: 3 } } };
  const r = mergeJsonValues(ancestor, local, remote);
  assert.equal(r.ok, false);
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.path, 'a.b.c');
  assert.equal(r.conflicts[0]!.reason, 'overlap');
  assert.equal(r.conflicts[0]!.local, 2);
  assert.equal(r.conflicts[0]!.remote, 3);
  assert.equal(r.conflicts[0]!.ancestor, 1);
});

test('mergeJsonValues: 数组单侧改动 → 采纳改动侧', () => {
  const ancestor = { list: [1, 2] };
  const local = { list: [1, 2, 3] };
  const remote = { list: [1, 2] };
  const r = mergeJsonValues(ancestor, local, remote);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { list: [1, 2, 3] });
});

test('mergeJsonValues: 数组双侧都改且不 deepEqual → conflict(reason=array)，绝不按索引合并', () => {
  const ancestor = { list: [1, 2] };
  const local = { list: [1, 3] };
  const remote = { list: [1, 2, 9] };
  const r = mergeJsonValues(ancestor, local, remote);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.path, 'list');
  assert.equal(r.conflicts[0]!.reason, 'array');
  assert.deepEqual(r.conflicts[0]!.local, [1, 3]);
  assert.deepEqual(r.conflicts[0]!.remote, [1, 2, 9]);
});

test('mergeJsonValues: 双侧数组改成逐字相同 → 收敛，不报冲突', () => {
  const r = mergeJsonValues({ list: [1] }, { list: [1, 2] }, { list: [1, 2] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { list: [1, 2] });
});

test('mergeJsonValues: 单侧新增键（祖先没有）→ 采纳；双侧新增不同值 → 冲突', () => {
  const single = mergeJsonValues({ a: 1 }, { a: 1, added: 'l' }, { a: 1 });
  assert.equal(single.ok, true);
  assert.deepEqual(single.merged, { a: 1, added: 'l' });

  const both = mergeJsonValues({ a: 1 }, { a: 1, added: 1 }, { a: 1, added: 2 });
  assert.equal(both.ok, false);
  assert.equal(both.conflicts[0]!.path, 'added');
  assert.equal(both.conflicts[0]!.ancestor, undefined);
});

test('mergeJsonValues: 缺失键 = 删除语义（一侧删、另一侧没改 → 删除胜出）', () => {
  const r = mergeJsonValues({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { a: 1 });
});

test('mergeJsonValues: 一侧删除、另一侧修改同一键 → 冲突（不静默丢改动）', () => {
  const r = mergeJsonValues({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.path, 'b');
  assert.equal(r.conflicts[0]!.local, undefined);
  assert.equal(r.conflicts[0]!.remote, 99);
  assert.equal(r.conflicts[0]!.ancestor, 2);
});

test('mergeJsonValues: 类型互换（对象 ↔ 标量）→ 冲突，绝不猜', () => {
  const r = mergeJsonValues({ a: { x: 1 } }, { a: [{ x: 1 }] }, { a: { x: 2 } });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0]!.path, 'a');
});

test('mergeJsonValues: 未知键绝不静默丢弃（双侧各自新增不同键）', () => {
  const r = mergeJsonValues({}, { fromLocal: 1 }, { fromRemote: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, { fromLocal: 1, fromRemote: 2 });
});

test('mergeJsonValues: 根值（非对象）单侧改动 → 采纳该侧', () => {
  assert.deepEqual(mergeJsonValues(undefined, undefined, 5), { ok: true, merged: 5, conflicts: [] });
  const conflict = mergeJsonValues(1, 2, 3);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflicts[0]!.path, '');
});

// ---------------------------------------------------------------------------
// 文本三方合并
// ---------------------------------------------------------------------------

test('mergeTextThreeWay: 仅本地改动 → 本地胜出', () => {
  const r = mergeTextThreeWay('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n');
  assert.equal(r.kind, 'text');
  assert.equal(mergedOrThrow(r), 'a\nB\nc\n');
});

test('mergeTextThreeWay: 仅远端改动 → 远端胜出', () => {
  const r = mergeTextThreeWay('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n');
  assert.equal(mergedOrThrow(r), 'a\nb\nC\n');
});

test('mergeTextThreeWay: 双侧改不同行 → 两侧改动都保住', () => {
  const r = mergeTextThreeWay('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nc\nD\n');
  assert.equal(mergedOrThrow(r), 'a\nB\nc\nD\n');
});

test('mergeTextThreeWay: 双侧改同一行且结果不同 → 冲突，path 形如 line 12-14', () => {
  const r = mergeTextThreeWay('a\nb\nc\n', 'a\nL\nc\n', 'a\nR\nc\n');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'text');
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.path, 'line 2');
  assert.equal(r.conflicts[0]!.reason, 'overlap');
  assert.equal(r.conflicts[0]!.local, 'L');
  assert.equal(r.conflicts[0]!.remote, 'R');
  assert.equal(r.conflicts[0]!.ancestor, 'b');
});

test('mergeTextThreeWay: 多行相邻区间双侧冲突 → path 覆盖并集（line 2-3）', () => {
  const r = mergeTextThreeWay('a\nb\nc\nd\n', 'a\nL1\nL2\nd\n', 'a\nR1\nR2\nd\n');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0]!.path, 'line 2-3');
});

test('mergeTextThreeWay: 双侧改成逐字相同的结果 → 收敛为一份，不报冲突', () => {
  const r = mergeTextThreeWay('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n');
  assert.equal(r.ok, true);
  assert.equal(mergedOrThrow(r), 'a\nX\nc\n');
});

test('mergeTextThreeWay: 空文件（双侧新增不同内容）→ 冲突，不把两份内容拼起来', () => {
  const r = mergeTextThreeWay('', 'A\n', 'B\n');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.local, 'A');
  assert.equal(r.conflicts[0]!.remote, 'B');
});

test('mergeTextThreeWay: 空文件（仅一侧新增）→ 采纳；三段全空 → 空结果', () => {
  assert.equal(mergedOrThrow(mergeTextThreeWay('', '', 'B\n')), 'B\n');
  assert.equal(mergedOrThrow(mergeTextThreeWay('', '', '')), '');
});

test('mergeTextThreeWay: 一侧清空文件、另一侧未改 → 空结果（删除胜出）', () => {
  assert.equal(mergedOrThrow(mergeTextThreeWay('a\nb\n', '', 'a\nb\n')), '');
});

test('mergeTextThreeWay: 非法 JSON 回落到行级合并（kind=text，不因解析失败而冲突）', () => {
  const r = mergeTextThreeWay('// 注释\n{\n  "a": 1\n}\n', '// 注释\n{\n  "a": 1\n}\n', '// 注释\n{\n  "a": 2\n}\n');
  assert.equal(r.kind, 'text');
  assert.equal(mergedOrThrow(r), '// 注释\n{\n  "a": 2\n}\n');
});

test('mergeTextThreeWay: 三段都是合法 JSON → 走结构化合并（kind=json）', () => {
  const ancestor = '{\n  "a": 1,\n  "b": 2\n}\n';
  const local = '{\n  "a": 1,\n  "b": 3\n}\n';
  const remote = '{\n  "a": 5,\n  "b": 2\n}\n';
  const r = mergeTextThreeWay(ancestor, local, remote);
  assert.equal(r.kind, 'json');
  assert.equal(r.ok, true);
  assert.equal(r.merged, JSON.stringify({ a: 5, b: 3 }, null, 2) + '\n');
});

test('mergeTextThreeWay: 合法 JSON 但结构化合并有冲突 → ok=false, kind=json，冲突精确到叶子', () => {
  const r = mergeTextThreeWay('{"a":1}', '{"a":2}', '{"a":3}');
  assert.equal(r.kind, 'json');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.path, 'a');
});

test('mergeTextThreeWay: CRLF 与 LF 混用不误报冲突，且保留各自行尾', () => {
  const ancestor = 'a\r\nb\r\nc\r\n';
  const local = 'a\nB\nc\n';
  const remote = 'a\r\nb\r\nC\r\n';
  const r = mergeTextThreeWay(ancestor, local, remote);
  assert.equal(mergedOrThrow(r), 'a\r\nB\nC\r\n');
});

test('mergeTextThreeWay: 三种输入都是 CRLF → 输出 CRLF', () => {
  const r = mergeTextThreeWay('a\r\nb\r\n', 'a\r\nB\r\n', 'a\r\nb\r\n');
  assert.equal(mergedOrThrow(r), 'a\r\nB\r\n');
});

test('mergeTextThreeWay: 末尾无换行时不得凭空补换行（改动末行）', () => {
  const r = mergeTextThreeWay('a\nb', 'a\nB', 'a\nb');
  assert.equal(mergedOrThrow(r), 'a\nB');
});

test('mergeTextThreeWay: 末尾无换行 + 追加行 → 需要时补出正确行尾（不粘连）', () => {
  const r = mergeTextThreeWay('a', 'a\nnew', 'a');
  assert.equal(mergedOrThrow(r), 'a\nnew');
});

test('mergeTextThreeWay: 含重复行时按 LCS 对齐，不错位到第一个相同行', () => {
  const r = mergeTextThreeWay('x\nx\ny\n', 'x\nX\ny\n', 'x\nx\ny\nz\n');
  assert.equal(mergedOrThrow(r), 'x\nX\ny\nz\n');
});

test('mergeTextThreeWay: 双侧在同一位置插入相同内容 → 收敛一份', () => {
  const r = mergeTextThreeWay('a\n', 'a\nx\n', 'a\nx\n');
  assert.equal(mergedOrThrow(r), 'a\nx\n');
});

test('mergeTextThreeWay: 双侧在同一位置插入不同内容 → 冲突', () => {
  const r = mergeTextThreeWay('a\n', 'a\nx\n', 'a\ny\n');
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0]!.path, 'line 2');
});

test('mergeTextThreeWay: 双侧独立追加内容（不同位置语义同一行尾）→ 不误报', () => {
  const r = mergeTextThreeWay('a\n', 'a\nx\n', 'a\n');
  assert.equal(mergedOrThrow(r), 'a\nx\n');
});

// ---------------------------------------------------------------------------
// 字节三方合并
// ---------------------------------------------------------------------------

test('mergeBytesThreeWay: 缺共同祖先（首次同步）→ ok=false，绝不猜', () => {
  const r = mergeBytesThreeWay(undefined, enc('a\n'), enc('b\n'));
  assert.equal(r.ok, false);
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts.length, 0);
});

test('mergeBytesThreeWay: 缺失文件（ancestor undefined）+ 二进制 → kind=binary', () => {
  const r = mergeBytesThreeWay(undefined, new Uint8Array([0, 1]), new Uint8Array([0, 2]));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'binary');
});

test('mergeBytesThreeWay: 纯二进制 → ok=false, kind=binary, reason=binary', () => {
  const r = mergeBytesThreeWay(enc('a\n'), new Uint8Array([0, 1, 2]), new Uint8Array([0, 3]));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'binary');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.reason, 'binary');
});

test('mergeBytesThreeWay: 超过 1 MiB → ok=false, kind=too-large', () => {
  const big = new Uint8Array(TEXT_MERGE_MAX_BYTES + 1).fill(0x61);
  const r = mergeBytesThreeWay(enc('a\n'), big, enc('a\n'));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'too-large');
  assert.equal(r.conflicts[0]!.reason, 'too-large');
});

test('mergeBytesThreeWay: 正常文本 → 合并后字节内容正确（kind=text）', () => {
  const r = mergeBytesThreeWay(enc('a\nb\n'), enc('a\nB\n'), enc('a\nb\nc\n'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.equal(dec(r.merged!), 'a\nB\nc\n');
});

test('mergeBytesThreeWay: 合法 JSON 文本 → kind=json，字节按 UTF-8 回写', () => {
  const r = mergeBytesThreeWay(enc('{"a":1,"b":2}'), enc('{"a":1,"b":9}'), enc('{"a":7,"b":2}'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'json');
  assert.equal(dec(r.merged!), JSON.stringify({ a: 7, b: 9 }, null, 2) + '\n');
});

test('mergeBytesThreeWay: 文本冲突 → ok=false 且 kind 如实为 text', () => {
  const r = mergeBytesThreeWay(enc('a\nb\n'), enc('a\nL\n'), enc('a\nR\n'));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'text');
  assert.equal(r.conflicts[0]!.path, 'line 2');
});
