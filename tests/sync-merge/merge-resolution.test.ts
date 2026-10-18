/**
 * 用户可见路径：previewMerge（只读三方预览）+ applyMergeResolutions（逐项裁决 + 基线纪律）。
 *
 * 这里钉死本轮最核心的产品语义：**部分裁决 / 跳过冲突时远端指针绝不推进**，
 * 否则下一轮冲突不再被提出 = 静默丢掉一侧改动。导出数据 + sync-state 原文双重断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  createSharedDevices, getNamespace, makeRoot, readSkill, readStateJson, readStateText,
  setNamespace, writeSkill,
} from './helpers.ts';
import type { Device } from './helpers.ts';

/** 造「同一分区真冲突 + 另一分区可自动合并」的双设备现场。 */
async function setupConflict(root: string): Promise<{ a: Device; b: Device }> {
  const { devices } = await createSharedDevices(root, ['a', 'b']);
  const a = devices['a']!;
  const b = devices['b']!;
  await writeSkill(a, 'coding.md', '# Coding\n');
  await writeSkill(b, 'coding.md', '# Coding\n');
  setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  setNamespace(b, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  await a.engine.push({ snapshotId: 'a-1' });

  // A：改 general + 改 coding.md；B：改 general（真冲突）+ 新增 writing.md（可自动合并）
  setNamespace(a, 'general', { theme: 'blue', language: 'zh-CN' }, 4);
  await writeSkill(a, 'coding.md', '# Coding by A\n');
  setNamespace(b, 'general', { theme: 'red', language: 'zh-CN' }, 4);
  await writeSkill(b, 'writing.md', '# Writing by B\n');
  await b.engine.push({ snapshotId: 'b-1' });
  return { a, b };
}

test('previewMerge 只读：返回冲突视图（三侧预览 + 计数），零写入', async () => {
  const root = await makeRoot('preview-merge');
  try {
    const { a } = await setupConflict(root);
    const rawBefore = await readStateText(a);
    const preview = await a.engine.previewMerge();
    assert.equal(preview.ok, true);
    assert.equal(preview.snapshotId, 'b-1');
    assert.equal(preview.hasAncestor, true, '有祖先副本时必须如实报 true（否则界面会误报「全都是冲突」）');
    const settings = preview.sections.find((s) => s.id === 'settings')!;
    assert.equal(settings.decision, 'conflict');
    assert.ok(settings.conflictCount >= 1);
    assert.ok(settings.conflicts.length >= 1);
    const c = settings.conflicts[0]!;
    assert.equal(typeof c.localPreview, 'string');
    assert.equal(typeof c.remotePreview, 'string');
    assert.equal(typeof c.ancestorPreview, 'string');
    assert.notEqual(c.localPreview, c.remotePreview, '真冲突的两侧预览必须不同');
    assert.ok(c.localPreview.includes('blue') || c.remotePreview.includes('red') || c.localPreview.length > 0);
    const skills = preview.sections.find((s) => s.id === 'skills')!;
    assert.equal(skills.decision, 'merge', '不同文件的改动应自动合并');
    assert.equal(skills.conflicts.length, 0);
    assert.ok((skills.autoMerged ?? 0) >= 1);
    assert.equal(preview.summary.conflicts, 1);
    assert.ok(preview.summary.auto >= 1);
    assert.equal(await readStateText(a), rawBefore, 'previewMerge 是只读路径：sync-state 逐字节不变');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('previewMerge：无祖先副本 → hasAncestor=false（如实降级为两方，不冒充三方结论）', async () => {
  const root = await makeRoot('preview-no-ancestor');
  try {
    const { transport, devices } = await createSharedDevices(root, ['c']);
    const c = devices['c']!;
    setNamespace(c, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
    await writeSkill(c, 'coding.md', '# Coding\n');
    await transport.upload({
      id: 'remote-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '0.1.0-rc.6', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: { settings: { version: 1, namespaces: { general: { value: { theme: 'light', language: 'zh-CN' }, revision: 9, secrets: [] } } } },
    });
    const preview = await c.engine.previewMerge();
    assert.equal(preview.ok, true);
    assert.equal(preview.hasAncestor, false);
    assert.ok(preview.sections.some((s) => s.decision === 'conflict'), '无祖先时差异一律呈现为待裁决');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('previewMerge：远端为空 → ok:false + 说明（不得伪装成「无变化」）', async () => {
  const root = await makeRoot('preview-empty');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    const preview = await a.engine.previewMerge();
    assert.equal(preview.ok, false);
    assert.equal(preview.snapshotId, '');
    assert.deepEqual(preview.sections, []);
    assert.ok((preview.message ?? '').length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('applyMergeResolutions 部分裁决：可自动合并的分区落盘，冲突分区 pending，远端指针不推进', async () => {
  const root = await makeRoot('merge-partial');
  try {
    const { a } = await setupConflict(root);
    const report = await a.engine.applyMergeResolutions([{ id: 'settings', action: 'skip' }]);
    assert.equal(report.ok, true);
    assert.deepEqual(report.pendingConflicts, ['settings'], '未裁决的冲突分区必须如实回报');
    assert.ok(report.warnings.length > 0, '存在未裁决项必须有可见说明');
    assert.ok(report.applied.includes('skills'), '无冲突分区照常落盘');
    assert.equal(await readSkill(a, 'coding.md'), '# Coding by A\n', '本机改动保留');
    assert.equal(await readSkill(a, 'writing.md'), '# Writing by B\n', '远端新增文件已落盘');

    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'a-1', '有未裁决冲突 → 远端指针绝不推进');
    const pending = state['pendingMerge'] as { remoteSnapshotId?: string; sections?: string[] } | undefined;
    assert.equal(pending?.remoteSnapshotId, 'b-1', 'pendingMerge 记录冲突挂在哪一版远端上');
    assert.deepEqual(pending?.sections, ['settings']);

    // 再预览：冲突仍然出现（不得因为「跳过一次」就消失）
    const again = await a.engine.previewMerge();
    assert.ok(again.sections.some((s) => s.id === 'settings' && s.decision === 'conflict'), '跳过 ≠ 解决：冲突下一轮必须重现');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('applyMergeResolutions 全部裁决（useRemote）：两侧改动都落地，指针推进到本次远端快照', async () => {
  const root = await makeRoot('merge-all-resolved');
  try {
    const { a } = await setupConflict(root);
    const report = await a.engine.applyMergeResolutions([{ id: 'settings', action: 'useRemote' }]);
    assert.equal(report.ok, true);
    assert.deepEqual(report.pendingConflicts, [], '全部裁决完 → 无 pending');
    assert.deepEqual(getNamespace(a, 'general'), { theme: 'red', language: 'zh-CN' }, '采用远端整分区值');
    assert.equal(await readSkill(a, 'coding.md'), '# Coding by A\n', '非冲突分区的本机改动保留');
    assert.equal(await readSkill(a, 'writing.md'), '# Writing by B\n');
    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'b-1', '全部裁决完 → 远端指针推进');
    assert.equal(state['pendingMerge'], undefined, '全部裁决完 → 清空 pendingMerge');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('applyMergeResolutions useMerged 打在冲突分区上：无 merged → 计入 pending，不得假成功', async () => {
  const root = await makeRoot('merge-usemerged-conflict');
  try {
    const { a } = await setupConflict(root);
    const report = await a.engine.applyMergeResolutions([{ id: 'settings', action: 'useMerged' }]);
    assert.equal(report.ok, true);
    assert.deepEqual(report.pendingConflicts, ['settings']);
    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'a-1', '没有可用 merged → 指针不推进');
    assert.deepEqual(getNamespace(a, 'general'), { theme: 'blue', language: 'zh-CN' }, '本机值不被改写');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
