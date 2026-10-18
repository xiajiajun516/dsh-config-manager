/**
 * m-sync-flow：三方合并引擎测试。
 * 覆盖：
 *  - 分区级四象限（useRemote / keepLocal / skip / conflict）+ 精细合并成功的 'merge' 决策
 *  - JSON 分区递归合并（嵌套对象/未知字段保留/数组保守冲突/冲突路径到叶子）
 *  - FilesSection 逐文件合并（文本行级三方合并 / 二进制保留冲突 / 删除-修改冲突）
 *  - MergePlan 输出形状与 MergeConflict.reason
 *  - 无祖先退化为整分区冲突
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { merge } from './merge.ts';
import type { FilesSection, SectionData, SettingsSection } from '../schema/types.ts';

const settings = (ns: Record<string, { value: unknown; revision: number }>): SettingsSection => ({
  version: 1,
  namespaces: Object.fromEntries(
    Object.entries(ns).map(([k, v]) => [k, { value: v.value, revision: v.revision, secrets: [] }]),
  ),
});

const files = (entries: Array<[string, string]>): FilesSection => ({
  version: 1,
  files: entries.map(([pth, c]) => ({ relativePath: pth, data: new TextEncoder().encode(c), contentHash: '' })),
});

const binFiles = (entries: Array<[string, Uint8Array]>): FilesSection => ({
  version: 1,
  files: entries.map(([pth, data]) => ({ relativePath: pth, data, contentHash: '' })),
});

const decode = (s: FilesSection, path: string): string | undefined => {
  const f = s.files.find((x) => x.relativePath === path);
  return f === undefined ? undefined : new TextDecoder().decode(f.data);
};

test('merge: 本地==远端 → skip', () => {
  const s = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const plan = merge({ settings: s as SectionData }, { settings: s as SectionData }, { settings: s as SectionData });
  assert.equal(plan.sections.length, 1);
  assert.equal(plan.sections[0]!.decision, 'skip');
  assert.equal(plan.sections[0]!.conflicts.length, 0);
});

test('merge: 本地==祖先 & 远端!=祖先 → useRemote', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const rem = settings({ general: { value: { theme: 'light' }, revision: 2 } });
  const plan = merge(
    { settings: anc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'useRemote');
  assert.deepEqual((plan.sections[0]!.merged as SettingsSection).namespaces.general!.value, { theme: 'light' });
});

test('merge: 本地!=祖先 & 远端==祖先 → keepLocal', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'custom' }, revision: 2 } });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: anc as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'keepLocal');
  assert.deepEqual((plan.sections[0]!.merged as SettingsSection).namespaces.general!.value, { theme: 'custom' });
});

test('merge: 双侧相对祖先都改且同处不同值 → conflict（路径精确到叶子）', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'blue' }, revision: 2 } });
  const rem = settings({ general: { value: { theme: 'red' }, revision: 2 } });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.equal(plan.sections[0]!.merged, undefined, '冲突时绝不回传半成品 merged');
  assert.equal(plan.sections[0]!.conflicts.length, 1);
  assert.equal(plan.sections[0]!.conflicts[0]!.path, 'namespaces.general.value.theme');
  assert.equal(plan.sections[0]!.conflicts[0]!.kind, 'key');
  assert.equal(plan.sections[0]!.conflicts[0]!.reason, 'both-modified');
});

test('merge: 无 ancestor → 整分区 conflict（不猜测）', () => {
  const loc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const rem = settings({ general: { value: { theme: 'light' }, revision: 2 } });
  const plan = merge({ settings: loc as SectionData }, { settings: rem as SectionData });
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.equal(plan.sections[0]!.conflicts[0]!.reason, 'no-ancestor');
});

test('merge: JSON 非重叠键各自变更 → decision=merge + autoMerged 计数（不再谎报 useRemote）', () => {
  const anc = settings({
    general: { value: { theme: 'dark' }, revision: 1 },
    editor: { value: { fontSize: 12 }, revision: 1 },
  });
  const loc = settings({
    general: { value: { theme: 'dark' }, revision: 1 },
    editor: { value: { fontSize: 14 }, revision: 2 },
  });
  const rem = settings({
    general: { value: { theme: 'light' }, revision: 2 },
    editor: { value: { fontSize: 12 }, revision: 1 },
  });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge');
  assert.equal(r.conflicts.length, 0);
  assert.ok((r.autoMerged ?? 0) > 0, 'autoMerged 必须如实统计并入的变更点');
  const merged = r.merged as SettingsSection;
  assert.deepEqual(merged.namespaces.general!.value, { theme: 'light' });
  assert.deepEqual(merged.namespaces.editor!.value, { fontSize: 14 });
});

test('merge: 深层嵌套 JSON 合并（不同叶子自动合，未知字段两侧都保留）', () => {
  const anc: SectionData = { version: 1, ui: { theme: { color: 'dark', size: 12 }, extra: { a: 1 } } } as unknown as SectionData;
  const loc: SectionData = { version: 1, ui: { theme: { color: 'blue', size: 12 }, extra: { a: 1 }, localOnly: true } } as unknown as SectionData;
  const rem: SectionData = { version: 1, ui: { theme: { color: 'dark', size: 16 }, extra: { a: 1 }, remoteOnly: true } } as unknown as SectionData;
  const plan = merge({ settings: loc }, { settings: rem }, { settings: anc });
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge');
  const merged = r.merged as unknown as { ui: Record<string, unknown> };
  assert.deepEqual(merged.ui['theme'], { color: 'blue', size: 16 });
  assert.equal(merged.ui['localOnly'], true, '本地新增的未知字段不得被静默丢弃');
  assert.equal(merged.ui['remoteOnly'], true, '远端新增的未知字段不得被静默丢弃');
});

test('merge: 数组双侧都改且不同 → conflict(reason=array)，不按索引猜', () => {
  const anc: SectionData = { version: 1, plugins: [{ spec: 'a' }] } as unknown as SectionData;
  const loc: SectionData = { version: 1, plugins: [{ spec: 'a' }, { spec: 'b' }] } as unknown as SectionData;
  const rem: SectionData = { version: 1, plugins: [{ spec: 'c' }] } as unknown as SectionData;
  const plan = merge({ plugins: loc }, { plugins: rem }, { plugins: anc });
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.path, 'plugins');
  assert.equal(r.conflicts[0]!.reason, 'array');
});

test('merge: 数组仅一侧改 → 采纳该侧（另一侧键的改动同时保住）', () => {
  const anc: SectionData = { version: 1, plugins: [{ spec: 'a' }], note: 'x' } as unknown as SectionData;
  const loc: SectionData = { version: 1, plugins: [{ spec: 'a' }, { spec: 'b' }], note: 'x' } as unknown as SectionData;
  const rem: SectionData = { version: 1, plugins: [{ spec: 'a' }], note: 'y' } as unknown as SectionData;
  const plan = merge({ plugins: loc }, { plugins: rem }, { plugins: anc });
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge');
  const merged = r.merged as unknown as { plugins: unknown[]; note: string };
  assert.equal(merged.plugins.length, 2);
  assert.equal(merged.note, 'y');
});

test('merge: 数组双侧改成相同结果 → 收敛为一份（不算冲突）', () => {
  const anc: SectionData = { version: 1, plugins: [{ spec: 'a' }] } as unknown as SectionData;
  const loc: SectionData = { version: 1, plugins: [{ spec: 'a' }, { spec: 'b' }] } as unknown as SectionData;
  const rem: SectionData = { version: 1, plugins: [{ spec: 'a' }, { spec: 'b' }] } as unknown as SectionData;
  const plan = merge({ plugins: loc }, { plugins: rem }, { plugins: anc });
  assert.equal(plan.sections[0]!.decision, 'skip');
});

test('merge: FilesSection 非重叠文件自动合 → decision=merge', () => {
  const anc = files([['a.md', '# A old\n'], ['b.md', '# B\n']]);
  const loc = files([['a.md', '# A new local\n'], ['b.md', '# B\n']]);
  const rem = files([['a.md', '# A old\n'], ['b.md', '# B remote\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge');
  const merged = r.merged as FilesSection;
  assert.equal(decode(merged, 'a.md'), '# A new local\n');
  assert.equal(decode(merged, 'b.md'), '# B remote\n');
});

test('merge: 同一文本文件两侧改不同行 → 行级三方合并成功', () => {
  const anc = files([['a.md', 'line1\nline2\nline3\n']]);
  const loc = files([['a.md', 'LINE1\nline2\nline3\n']]);
  const rem = files([['a.md', 'line1\nline2\nLINE3\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge', '不同行的改动必须能自动合并');
  assert.equal(decode(r.merged as FilesSection, 'a.md'), 'LINE1\nline2\nLINE3\n');
});

test('merge: 同一文本文件两侧改同一行 → 冲突（不静默覆盖任何一侧）', () => {
  const anc = files([['a.md', 'line1\nline2\n']]);
  const loc = files([['a.md', 'line1\nLOCAL\n']]);
  const rem = files([['a.md', 'line1\nREMOTE\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.kind, 'file');
  assert.equal(r.conflicts[0]!.path, 'a.md');
  assert.equal(r.conflicts[0]!.reason, 'both-modified');
});

test('merge: 二进制文件两侧都改 → 冲突 reason=binary（不做文本合并）', () => {
  const anc = binFiles([['blob.bin', new Uint8Array([0, 1, 2])]]);
  const loc = binFiles([['blob.bin', new Uint8Array([0, 9, 2])]]);
  const rem = binFiles([['blob.bin', new Uint8Array([0, 7, 2])]]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.reason, 'binary');
  assert.equal(r.conflicts[0]!.autoMergeAttempted, true);
});

test('merge: 文件级 本地改 / 远端删 → modify-delete 冲突（不直接删数据）', () => {
  const anc = files([['a.md', '# A\n'], ['b.md', '# B\n']]);
  const loc = files([['a.md', '# A local edit\n'], ['b.md', '# B\n']]);
  const rem = files([['b.md', '# B\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.path, 'a.md');
  assert.equal(r.conflicts[0]!.reason, 'modify-delete');
});

test('merge: 文件级 本地删 / 远端改 → delete-modify 冲突', () => {
  const anc = files([['a.md', '# A\n'], ['b.md', '# B\n']]);
  const loc = files([['b.md', '# B\n']]);
  const rem = files([['a.md', '# A remote edit\n'], ['b.md', '# B\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.path, 'a.md');
  assert.equal(r.conflicts[0]!.reason, 'delete-modify');
});

test('merge: 文件级 本地删 / 远端未改 → 跟随删除（无冲突）', () => {
  const anc = files([['a.md', '# A\n'], ['b.md', '# B\n']]);
  const loc = files([['b.md', '# B\n']]);
  const rem = files([['a.md', '# A\n'], ['b.md', '# B changed\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'merge');
  const merged = r.merged as FilesSection;
  assert.equal(decode(merged, 'a.md'), undefined, '本地已删且远端未改 → 跟随删除');
  assert.equal(decode(merged, 'b.md'), '# B changed\n');
});

test('merge: 远端缺 + 本地等于祖先 → skip', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const plan = merge({ settings: anc as SectionData }, {}, { settings: anc as SectionData });
  assert.equal(plan.sections[0]!.decision, 'skip');
});

test('merge: 远端缺 + 本地改了 → 冲突且不得丢弃本地改动', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'blue' }, revision: 2 } });
  const plan = merge({ settings: loc as SectionData }, {}, { settings: anc as SectionData });
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.equal(plan.sections[0]!.conflicts[0]!.reason, 'modify-delete');
  assert.ok(plan.sections[0]!.conflicts[0]!.local !== undefined);
});

test('merge: MergePlan 输出形状符合 contract', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const plan = merge({ settings: anc as SectionData }, { settings: anc as SectionData }, { settings: anc as SectionData });
  assert.ok(Array.isArray(plan.sections));
  const r = plan.sections[0]!;
  assert.equal(typeof r.id, 'string');
  assert.ok(['useRemote', 'keepLocal', 'merge', 'skip', 'conflict'].includes(r.decision));
  assert.ok(Array.isArray(r.conflicts));
});

test('merge: 多分区混合场景（settings skip / providers keepLocal / skills useRemote）', () => {
  const sA = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const pA: SectionData = { version: 1, providers: { openai: { route: 'https://api.openai.com/v1' } } };
  const fA = files([['a.md', '# A\n']]);
  const plan = merge(
    {
      settings: sA as SectionData,
      providers: { version: 1, providers: { openai: { route: 'https://changed.com' } } } as SectionData,
      skills: fA as SectionData,
    },
    {
      settings: sA as SectionData,
      providers: pA,
      skills: files([['a.md', '# A\n'], ['b.md', '# B\n']]) as SectionData,
    },
    {
      settings: sA as SectionData,
      providers: pA,
      skills: fA as SectionData,
    },
  );
  const byId = new Map(plan.sections.map((s) => [s.id, s]));
  assert.equal(byId.get('settings')!.decision, 'skip');
  assert.equal(byId.get('providers')!.decision, 'keepLocal');
  assert.equal(byId.get('skills')!.decision, 'useRemote');
});

test('merge: 类型不一致（一侧文件类 / 一侧 JSON）→ 整分区冲突 reason=section', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = files([['a.md', '# A\n']]);
  const rem = settings({ general: { value: { theme: 'light' }, revision: 2 } });
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  const r = plan.sections[0]!;
  assert.equal(r.decision, 'conflict');
  assert.equal(r.conflicts[0]!.reason, 'section');
});
