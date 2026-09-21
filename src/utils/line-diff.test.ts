/**
 * 行级 diff 内核单测：正确性（变更定位 / 行号 / 统计）+ 不变量（可回放重建新侧）
 * + 极端输入（空文件 / CRLF / 纯新增 / 纯删除 / 降级路径 / 二进制探测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, looksBinary, splitLines, type DiffResult } from './line-diff.ts';

/** 归一（行语义）：尾换行不算一行 —— 与 diff 的行口径一致。 */
function norm(text: string): string {
  return splitLines(text).join('\n');
}

/** 把 diff 应用到旧文本：hunk 外的旧行原样保留，del 跳过、add 插入、context 保留。 */
function apply(original: string, result: DiffResult): string {
  const src = splitLines(original);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of result.hunks) {
    while (cursor < hunk.oldStart - 1) {
      out.push(src[cursor] ?? '');
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === 'add') out.push(line.text);
      else if (line.kind === 'context') {
        out.push(line.text);
        cursor += 1;
      } else {
        cursor += 1;
      }
    }
  }
  while (cursor < src.length) {
    out.push(src[cursor] ?? '');
    cursor += 1;
  }
  return out.join('\n');
}

test('D-01 完全一致：无 hunk、identical=true、零统计', () => {
  const r = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(r.identical, true);
  assert.deepEqual(r.hunks, []);
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
});

test('D-02 单行修改：定位准确、行号双边正确、统计为 1/1', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
  const after = ['1', '2', '3', '4', 'X', '6', '7', '8', '9'].join('\n');
  const r = diffLines(before, after);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.hunks.length, 1);
  const hunk = r.hunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunk.oldStart, 2, '上下文 3 行 → 从旧侧第 2 行开始');
  const changed = hunk.lines.filter((l) => l.kind !== 'context');
  assert.deepEqual(changed.map((l) => l.kind), ['del', 'add']);
  assert.equal(changed[0]?.oldNo, 5);
  assert.equal(changed[0]?.newNo, null);
  assert.equal(changed[1]?.oldNo, null);
  assert.equal(changed[1]?.newNo, 5);
  assert.equal(apply(before, r), norm(after));
});

test('D-03 多处分散修改：拆成多个 hunk（间隔大于上下文窗口）', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const afterLines = Array.from({ length: 40 }, (_, i) => `line${i}`);
  afterLines[2] = 'CHANGED-2';
  afterLines[30] = 'CHANGED-30';
  const after = afterLines.join('\n');
  const r = diffLines(before, after);
  assert.equal(r.added, 2);
  assert.equal(r.removed, 2);
  assert.equal(r.hunks.length, 2);
  assert.equal(apply(before, r), norm(after));
});

test('D-04 末尾新增行：hunk 尾侧计数正确，旧侧无对应行', () => {
  const before = 'a\nb\n';
  const after = 'a\nb\nc\nd\n';
  const r = diffLines(before, after);
  assert.equal(r.added, 2);
  assert.equal(r.removed, 0);
  assert.equal(apply(before, r), norm(after));
});

test('D-05 纯删除（文件被删）：全 del、after 为空', () => {
  const before = 'a\nb\nc';
  const r = diffLines(before, '');
  assert.equal(r.removed, 3);
  assert.equal(r.added, 0);
  assert.equal(apply(before, r), '');
  assert.equal(r.hunks.length, 1);
  assert.equal(r.hunks[0]?.newCount, 0);
});

test('D-06 纯新增（快照里才有的文件）：oldStart=1、oldCount=0', () => {
  const r = diffLines('', 'x\ny');
  assert.equal(r.added, 2);
  assert.equal(r.removed, 0);
  assert.equal(r.hunks[0]?.oldStart, 1);
  assert.equal(r.hunks[0]?.oldCount, 0);
  assert.equal(apply('', r), norm('x\ny'));
});

test('D-07 CRLF 归一：仅行尾风格差异不产生噪音', () => {
  const r = diffLines('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
  assert.equal(r.identical, true, '行尾 CRLF/LF 差异不算内容变更');
});

test('D-08 splitLines：尾换行不产生空行；空串 = 零行', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n'), ['a']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitLines('a'), ['a']);
});

test('D-09 降级路径：超出 maxD → degraded=true 且内容仍可回放', () => {
  const before = Array.from({ length: 60 }, (_, i) => `b${i}`).join('\n');
  const after = Array.from({ length: 60 }, (_, i) => `a${i}`).join('\n');
  const r = diffLines(before, after, { maxD: 2 });
  assert.equal(r.degraded, true);
  assert.equal(apply(before, r), norm(after));
});

test('D-10 降级路径：超出 maxLines → 整块替换且统计守恒', () => {
  const before = 'a\nb\nc';
  const after = 'x\ny\nz';
  const r = diffLines(before, after, { maxLines: 2 });
  assert.equal(r.degraded, true);
  assert.equal(r.added, 3);
  assert.equal(r.removed, 3);
  assert.equal(apply(before, r), norm(after));
});

test('D-11 上下文行数可配置：context=0 → 只含变更行', () => {
  const r = diffLines('a\nb\nc', 'a\nX\nc', { context: 0 });
  assert.deepEqual(r.hunks[0]?.lines.map((l) => l.kind), ['del', 'add']);
});

test('D-12 重复行不误判（LCS 而非逐行对齐）', () => {
  const before = 'a\na\nb\na';
  const after = 'a\nb\na\na';
  const r = diffLines(before, after);
  assert.equal(apply(before, r), norm(after));
  assert.ok(r.added + r.removed <= 2, '相同行的移动不应产生大量伪变更');
});

test('D-13 looksBinary：NUL 字节判定；纯文本与空串为 false', () => {
  assert.equal(looksBinary('plain text\nwith lines'), false);
  assert.equal(looksBinary(''), false);
  assert.equal(looksBinary('PNG\u0000binary'), true);
});
