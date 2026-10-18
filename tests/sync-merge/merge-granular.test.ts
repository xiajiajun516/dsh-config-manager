/**
 * 场景 4–8 的精细合并层：同一文件的行级三方合并 / 二进制 / 数组 / 类型互换。
 *
 * 这里直接调用**真实 merge()**（上层 SyncEngine.merge 的唯一合并实现），
 * 断言 merged 里的**实际字节**与冲突定位，不看任何文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { merge } from '../../src/sync/merge.ts';
import type { FilesSection, SectionData } from '../../src/schema/types.ts';
import { filesSection, fileTexts, settingsSection } from './helpers.ts';

/** 取单分区合并结果。 */
function one(plan: ReturnType<typeof merge>) {
  assert.equal(plan.sections.length, 1);
  return plan.sections[0]!;
}

const textFile = (path: string, text: string): FilesSection => ({
  version: 1,
  files: [{ relativePath: path, data: new TextEncoder().encode(text), contentHash: '' }],
});

test('场景 5b 两端改同一文本文件的不同行：行级合并成功，两侧改动都保留', () => {
  const anc = textFile('a.md', '# Title\nline1\nline2\nline3\nline4\n');
  const loc = textFile('a.md', '# Title\nline1\nLOCAL\nline3\nline4\n');
  const rem = textFile('a.md', '# Title\nline1\nline2\nline3\nREMOTE\n');
  const r = one(merge(
    { skills: loc as unknown as SectionData },
    { skills: rem as unknown as SectionData },
    { skills: anc as unknown as SectionData },
  ));
  assert.equal(r.conflicts.length, 0, '不同行的双侧改动不得判成冲突');
  assert.equal(r.decision, 'merge');
  assert.ok((r.autoMerged ?? 0) >= 1, 'autoMerged 必须反映自动并入的变更点');
  assert.equal(
    fileTexts(r.merged as unknown as SectionData).get('a.md'),
    '# Title\nline1\nLOCAL\nline3\nREMOTE\n',
    '合并结果 = 两侧改动都在',
  );
});

test('场景 6b 两端改同一文本文件的同一行：冲突（行号定位），不产出 merged', () => {
  const anc = textFile('a.md', 'a\nb\nc\n');
  const loc = textFile('a.md', 'a\nLOCAL\nc\n');
  const rem = textFile('a.md', 'a\nREMOTE\nc\n');
  const r = one(merge(
    { skills: loc as unknown as SectionData },
    { skills: rem as unknown as SectionData },
    { skills: anc as unknown as SectionData },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.merged, undefined, '真冲突不得返回半成品 merged');
  assert.equal(r.conflicts[0]!.kind, 'file');
  assert.equal(r.conflicts[0]!.path, 'a.md');
  assert.equal(r.conflicts[0]!.reason, 'both-modified', '文本行重叠的成因口径 = both-modified（不是 overlap）');
  assert.equal(r.conflicts[0]!.autoMergeAttempted, true);
});

test('场景 6f 一侧 FilesSection、一侧 JSON 分区：类型互换 → conflict(reason=section)', () => {
  const r = one(merge(
    { skills: filesSection([['a.md', '# A local\n']]) },
    { skills: settingsSection({ general: { x: 1 } }) },
    { skills: filesSection([['a.md', '# A\n']]) },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts[0]!.reason, 'section');
  assert.equal(r.conflicts[0]!.path, '$');
});

test('场景 6g 非普通对象的分区值（字符串）→ conflict(reason=format)，绝不采用', () => {
  const r = one(merge(
    { settings: settingsSection({ general: { theme: 'dark' } }) },
    { settings: 'garbage' as unknown as SectionData },
    { settings: settingsSection({ general: { theme: 'dark' } }) },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts[0]!.reason, 'format');
  assert.equal(r.conflicts[0]!.remote, 'garbage');
});

test('场景 6c 二进制文件双侧改动：拒绝文本合并（reason=binary），交用户裁决', () => {
  const bin = (bytes: number[]): SectionData => ({
    version: 1,
    files: [{ relativePath: 'blob.bin', data: new Uint8Array(bytes), contentHash: '' }],
  }) as unknown as SectionData;
  const r = one(merge(
    { skills: bin([0, 1, 2, 3]) },
    { skills: bin([0, 9, 9, 3]) },
    { skills: bin([0, 1, 2, 0]) },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.merged, undefined);
  assert.equal(r.conflicts[0]!.reason, 'binary', '二进制必须如实说明「没做文本合并」');
  assert.equal(r.conflicts[0]!.autoMergeAttempted, true);
});

test('场景 6d JSON 数组双侧都改：绝不按索引合并（reason=array），冲突定位到路径', () => {
  const anc = settingsSection({ general: { list: [1, 2, 3], other: 'same' } });
  const loc = settingsSection({ general: { list: [1, 2, 4], other: 'same' } });
  const rem = settingsSection({ general: { list: [1, 2, 5], other: 'same' } });
  const r = one(merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.reason, 'array');
  assert.ok(r.conflicts[0]!.path.endsWith('list'), '冲突定位到数组所在的点号路径（实际: ' + r.conflicts[0]!.path + '）');
});

test('场景 5c 同一 JSON 文件（FilesSection 内的 .json）双侧重排/改不同键：结构化合并保留双方键', () => {
  const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
  const anc = textFile('settings.json', json({ a: 1, b: 2, c: 3 }));
  const loc = textFile('settings.json', json({ a: 10, b: 2, c: 3 }));
  const rem = textFile('settings.json', json({ a: 1, b: 2, c: 30 }));
  const r = one(merge(
    { skills: loc as unknown as SectionData },
    { skills: rem as unknown as SectionData },
    { skills: anc as unknown as SectionData },
  ));
  assert.equal(r.conflicts.length, 0, 'JSON 文件不同键的双侧改动不该冲突');
  const text = fileTexts(r.merged as unknown as SectionData).get('settings.json')!;
  assert.deepEqual(JSON.parse(text), { a: 10, b: 2, c: 30 }, '两侧键都保留');
});

test('场景 5d CRLF/LF 混用不得误报冲突，输出保留行尾风格', () => {
  const anc = textFile('w.md', 'a\r\nb\r\nc\r\n');
  const loc = textFile('w.md', 'a\r\nLOCAL\r\nc\r\n');
  const rem = textFile('w.md', 'a\r\nb\r\nREMOTE\r\n');
  const r = one(merge(
    { skills: loc as unknown as SectionData },
    { skills: rem as unknown as SectionData },
    { skills: anc as unknown as SectionData },
  ));
  assert.equal(r.conflicts.length, 0, '行尾风格不同不是内容冲突');
  const text = fileTexts(r.merged as unknown as SectionData).get('w.md')!;
  assert.equal(text, 'a\r\nLOCAL\r\nREMOTE\r\n', '合并结果保留 CRLF 且两侧改动都在');
});

test('场景 6e 一侧改成对象、一侧改成标量：类型互换 → 冲突（不猜测）', () => {
  const anc = settingsSection({ general: { editor: { size: 12 } } });
  const loc = settingsSection({ general: { editor: { size: 14 } } });
  const rem = settingsSection({ general: { editor: 'broken' } });
  const r = one(merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  ));
  assert.equal(r.decision, 'conflict');
  assert.equal(r.merged, undefined);
});
