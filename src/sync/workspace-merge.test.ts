/**
 * issue #127：workspaces 分区的记录级合并（`workspace-merge.ts`）单测。
 *
 * 覆盖「为什么不能走通用 JSON 合并」这件事本身：sessionIds 必须取并集（两侧各自挂过会话不该冲突），
 * 其余字段按三方取舍、双侧都改才冲突，单侧删除只在「另一侧未改」时生效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeWorkspacesSection } from './workspace-merge.ts';
import { merge as mergeSections } from './merge.ts';
import type { SectionData, WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';

function ws(records: WorkspaceRecord[]): WorkspacesSection {
  return { version: 1, workspaces: records };
}

function rec(id: string, path: string, sessionIds: string[], extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return { id, path, sessionIds, ...extra };
}

function asWs(data: SectionData | undefined): WorkspacesSection {
  assert.ok(data !== undefined, '合并结果必须有载荷');
  return data as WorkspacesSection;
}

test('#127 记录级合并：两侧各自新增的 sessionIds 取并集 → decision=merge（不冲突、不丢归属）', () => {
  const local = ws([rec('w1', 'C:/proj', ['s-local'])]);
  const remote = ws([rec('w1', 'C:/proj', ['s-remote'])]);
  const plan = mergeSections({ workspaces: local }, { workspaces: remote });
  const section = plan.sections[0];
  assert.ok(section !== undefined);
  assert.equal(section.decision, 'merge', '并集必须能自动合并（通用 JSON 合并这里会判 array 冲突）');
  assert.deepEqual(asWs(section.merged).workspaces[0]?.sessionIds, ['s-local', 's-remote'], '本地在前、远端追加');
  assert.ok((section.autoMerged ?? 0) > 0, '自动并入的变更点必须被计数（UI 据此区分「整分区覆盖」）');
});

test('#127 记录级合并：sessionIds 按裸键去重（大小写不同算同一条会话）', () => {
  const out = mergeWorkspacesSection(
    ws([rec('w1', 'C:/proj', ['S1'])]),
    ws([rec('w1', 'C:/proj', ['s1', 's2'])]),
    undefined,
  );
  assert.ok(out !== undefined);
  assert.deepEqual(out.conflicts, []);
  assert.deepEqual(asWs(out.merged).workspaces[0]?.sessionIds, ['S1', 's2']);
});

test('#127 记录级合并：无祖先时只有 sessionIds 不同也能并集（首轮同步不该整分区冲突）', () => {
  const out = mergeWorkspacesSection(
    ws([rec('w1', 'C:/proj', ['s1'])]),
    ws([rec('w1', 'C:/proj', ['s1', 's2'])]),
    undefined,
  );
  assert.ok(out !== undefined);
  assert.deepEqual(out.conflicts, [], '并集不是冲突：两侧都没删没改别人的数据');
  assert.deepEqual(asWs(out.merged).workspaces[0]?.sessionIds, ['s1', 's2']);
});

test('#127 记录级合并：单侧改标题取变更侧；双侧改同一字段 → conflict（点号路径到记录字段）', () => {
  const onlyRemote = mergeWorkspacesSection(
    ws([rec('w1', 'C:/proj', [], { title: 'T' })]),
    ws([rec('w1', 'C:/proj', [], { title: 'T2' })]),
    ws([rec('w1', 'C:/proj', [], { title: 'T' })]),
  );
  assert.ok(onlyRemote !== undefined);
  assert.deepEqual(onlyRemote.conflicts, []);
  assert.equal(asWs(onlyRemote.merged).workspaces[0]?.title, 'T2', '仅远端改了 → 取远端');

  const both = mergeWorkspacesSection(
    ws([rec('w1', 'C:/proj', [], { title: 'mine' })]),
    ws([rec('w1', 'C:/proj', [], { title: 'theirs' })]),
    ws([rec('w1', 'C:/proj', [], { title: 'base' })]),
  );
  assert.ok(both !== undefined);
  assert.equal(both.conflicts.length, 1);
  assert.equal(both.conflicts[0]?.path, 'workspaces.w1.title');
  assert.equal(both.conflicts[0]?.reason, 'both-modified');
});

test('#127 记录级合并：删除语义 —— 一侧删了且另一侧未改才真删；另一侧改过 → modify-delete 冲突', () => {
  const base = rec('w1', 'C:/proj', ['s1'], { title: 'base' });
  const untouched = mergeWorkspacesSection(ws([base]), ws([]), ws([base]));
  assert.ok(untouched !== undefined);
  assert.deepEqual(untouched.conflicts, []);
  assert.deepEqual(asWs(untouched.merged).workspaces, [], '本地未改 → 跟随远端的删除');

  const modified = mergeWorkspacesSection(
    ws([{ ...base, title: 'renamed' }]),
    ws([]),
    ws([base]),
  );
  assert.ok(modified !== undefined);
  assert.equal(modified.conflicts.length, 1);
  assert.equal(modified.conflicts[0]?.path, 'workspaces.w1');
  assert.equal(modified.conflicts[0]?.reason, 'modify-delete');
  assert.equal(asWs(modified.merged).workspaces.length, 1, '有冲突时也不丢记录（交用户裁决）');
});

test('#127 记录级合并：无祖先且只在单侧存在 → 保留（不猜「对方删了」）', () => {
  const out = mergeWorkspacesSection(ws([rec('w1', 'C:/proj', ['s1'])]), ws([]), undefined);
  assert.ok(out !== undefined);
  assert.deepEqual(out.conflicts, []);
  assert.equal(asWs(out.merged).workspaces.length, 1);
});

test('#127 记录级合并：形状不认识 → 返回 undefined（交回通用路径，不另造一套判定）', () => {
  assert.equal(mergeWorkspacesSection({ version: 2 } as unknown as SectionData, ws([]), undefined), undefined);
  assert.equal(mergeWorkspacesSection(ws([]), null as unknown as SectionData, undefined), undefined);
});
