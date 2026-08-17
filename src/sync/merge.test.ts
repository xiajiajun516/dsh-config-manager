/**
 * m-sync-flow：三方合并引擎测试。
 * 覆盖：
 *  - 分区级四象限（useRemote / keepLocal / skip / conflict）
 *  - JSON 分区键级精细合并（非重叠键自动合、双侧均改且不同留冲突）
 *  - FilesSection 文件级精细合并
 *  - MergePlan 输出形状
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
  files: entries.map(([p, c]) => ({ relativePath: p, data: new TextEncoder().encode(c), contentHash: '' })),
});

test('merge: 本地==远端 → skip', () => {
  const s = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const a = s;
  const plan = merge({ settings: s as SectionData }, { settings: s as SectionData }, { settings: a as SectionData });
  assert.equal(plan.sections.length, 1);
  assert.equal(plan.sections[0]!.decision, 'skip');
  assert.equal(plan.sections[0]!.conflicts.length, 0);
});

test('merge: 本地==祖先 & 远端!=祖先 → useRemote', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = anc;
  const rem = settings({ general: { value: { theme: 'light' }, revision: 2 } });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'useRemote');
  assert.deepEqual((plan.sections[0]!.merged as SettingsSection).namespaces.general!.value, { theme: 'light' });
});

test('merge: 本地!=祖先 & 远端==祖先 → keepLocal', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'custom' }, revision: 2 } });
  const rem = anc;
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'keepLocal');
  assert.deepEqual((plan.sections[0]!.merged as SettingsSection).namespaces.general!.value, { theme: 'custom' });
});

test('merge: 双侧相对祖先都改且分区 hash 不同 → conflict', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'blue' }, revision: 2 } });
  const rem = settings({ general: { value: { theme: 'red' }, revision: 2 } });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.ok(plan.sections[0]!.conflicts.length >= 1);
});

test('merge: 无 ancestor → 整分区 conflict（不猜测）', () => {
  const loc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const rem = settings({ general: { value: { theme: 'light' }, revision: 2 } });
  const plan = merge({ settings: loc as SectionData }, { settings: rem as SectionData });
  assert.equal(plan.sections[0]!.decision, 'conflict');
});

test('merge: JSON 分区键级精细合并 —— 非重叠键各自变更自动合', () => {
  // 祖先：{ general: {theme:'dark'}, editor: {fontSize:12} }
  const anc = settings({
    general: { value: { theme: 'dark' }, revision: 1 },
    editor: { value: { fontSize: 12 }, revision: 1 },
  });
  // 本地：改 editor
  const loc = settings({
    general: { value: { theme: 'dark' }, revision: 1 },
    editor: { value: { fontSize: 14 }, revision: 2 },
  });
  // 远端：改 general
  const rem = settings({
    general: { value: { theme: 'light' }, revision: 2 },
    editor: { value: { fontSize: 12 }, revision: 1 },
  });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'useRemote', '精细合并后无非冲突 → useRemote（承载合并结果）');
  const merged = plan.sections[0]!.merged as SettingsSection;
  assert.deepEqual(merged.namespaces.general!.value, { theme: 'light' });
  assert.deepEqual(merged.namespaces.editor!.value, { fontSize: 14 });
  assert.equal(plan.sections[0]!.conflicts.length, 0);
});

test('merge: JSON 分区键级精细合并 —— 双侧均改同一 key 且值不同 → 冲突', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const loc = settings({ general: { value: { theme: 'blue' }, revision: 2 } });
  const rem = settings({ general: { value: { theme: 'red' }, revision: 2 } });
  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.equal(plan.sections[0]!.conflicts.length, 1);
  assert.equal(plan.sections[0]!.conflicts[0]!.path, 'general');
  assert.equal(plan.sections[0]!.conflicts[0]!.kind, 'key');
});

test('merge: FilesSection 文件级精细合并 —— 非重叠文件自动合', () => {
  const anc = files([['a.md', '# A old\n'], ['b.md', '# B\n']]);
  const loc = files([['a.md', '# A new local\n'], ['b.md', '# B\n']]);
  const rem = files([['a.md', '# A old\n'], ['b.md', '# B remote\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'useRemote');
  const merged = plan.sections[0]!.merged as FilesSection;
  const byPath = new Map(merged.files.map((f) => [f.relativePath, new TextDecoder().decode(f.data)]));
  assert.equal(byPath.get('a.md'), '# A new local\n');
  assert.equal(byPath.get('b.md'), '# B remote\n');
});

test('merge: FilesSection 文件级精细合并 —— 双侧均改同一文件 → 冲突', () => {
  const anc = files([['a.md', '# A old\n']]);
  const loc = files([['a.md', '# A local\n']]);
  const rem = files([['a.md', '# A remote\n']]);
  const plan = merge(
    { skills: loc as SectionData },
    { skills: rem as SectionData },
    { skills: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'conflict');
  assert.equal(plan.sections[0]!.conflicts[0]!.kind, 'file');
  assert.equal(plan.sections[0]!.conflicts[0]!.path, 'a.md');
});

test('merge: 远端缺 + 本地等于祖先 → skip', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const plan = merge(
    { settings: anc as SectionData },
    {}, // 远端无此分区
    { settings: anc as SectionData },
  );
  assert.equal(plan.sections[0]!.decision, 'skip');
});

test('merge: MergePlan 输出形状符合 contract', () => {
  const anc = settings({ general: { value: { theme: 'dark' }, revision: 1 } });
  const plan = merge({ settings: anc as SectionData }, { settings: anc as SectionData }, { settings: anc as SectionData });
  assert.ok(Array.isArray(plan.sections));
  const r = plan.sections[0]!;
  assert.equal(typeof r.id, 'string');
  assert.ok(['useRemote', 'keepLocal', 'skip', 'conflict'].includes(r.decision));
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
  // providers：本地改了 route、远端 == 祖先 → keepLocal
  assert.equal(byId.get('providers')!.decision, 'keepLocal');
  // skills：本地 == 祖先、远端新增 b.md → useRemote
  assert.equal(byId.get('skills')!.decision, 'useRemote');
});
