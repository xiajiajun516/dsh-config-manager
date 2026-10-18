/**
 * 硬约束证据（Lead 指派，agent-verify）：只拿**磁盘上的原始字节**说话，不信「实现声明」。
 *
 *  ① apply-merge 存在 skip/未裁决分区时，真实 sync-state.json 的 lastSnapshotId **不得推进**；
 *  ② previewMerge 是零写入：调用前后 sync-state.json 与本地祖先目录**逐字节相同**。
 *
 * 两份证据都按「目录树摘要」比对（相对路径 + 文件字节 sha256），不是只看某个字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  createSharedDevices, makeRoot, readSkill, readStateJson, readStateText,
  setNamespace, writeSkill,
} from './helpers.ts';

/** 目录树摘要：相对路径 + 文件字节 sha256（目录自身也登记，空目录也能被发现）。 */
async function treeDigest(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const e of entries) {
      const childRel = rel === '' ? e.name : path.join(rel, e.name);
      if (e.isDirectory()) {
        out.push('d\u0000' + childRel);
        await walk(childRel);
      } else {
        const bytes = await fs.readFile(path.join(dir, childRel));
        out.push('f\u0000' + childRel + '\u0000' + crypto.createHash('sha256').update(bytes).digest('hex'));
      }
    }
  };
  await walk('');
  return out.sort();
}

/** 造「同分区真冲突 + 另一分区可自动合并」的双设备现场（与 merge-resolution.test.ts 同构）。 */
async function setupConflict(root: string) {
  const { devices } = await createSharedDevices(root, ['a', 'b']);
  const a = devices['a']!;
  const b = devices['b']!;
  await writeSkill(a, 'coding.md', '# Coding\n');
  await writeSkill(b, 'coding.md', '# Coding\n');
  setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  setNamespace(b, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  await a.engine.push({ snapshotId: 'a-1' });
  setNamespace(a, 'general', { theme: 'blue', language: 'zh-CN' }, 4);
  await writeSkill(a, 'coding.md', '# Coding by A\n');
  setNamespace(b, 'general', { theme: 'red', language: 'zh-CN' }, 4);
  await writeSkill(b, 'writing.md', '# Writing by B\n');
  await b.engine.push({ snapshotId: 'b-1' });
  return a;
}

test('硬约束 ①：apply-merge 有 skip → 真实 sync-state.json 的 lastSnapshotId 不推进（祖先指针也不动）', async () => {
  const root = await makeRoot('evidence-baseline-freeze');
  try {
    const a = await setupConflict(root);
    const before = (await readStateJson(a))!;
    const ancestorBefore = await treeDigest(a.localSnapshotsDir);
    assert.equal(before['lastSnapshotId'], 'a-1');

    /** 直接从 sync-state.json **原文**截出 lastSnapshotId 字段的字节片段（不解析后再比）。 */
    const lastSnapshotBytes = (text: string | null): string => {
      assert.notEqual(text, null);
      const m = /"lastSnapshotId":\s*"[^"]*"/.exec(text as string);
      assert.ok(m !== null, 'sync-state.json 原文里必须存在 lastSnapshotId 字段');
      return m![0];
    };
    const stateBytesBefore = await readStateText(a);
    const lastSnapshotBefore = lastSnapshotBytes(stateBytesBefore);

    const report = await a.engine.applyMergeResolutions([{ id: 'settings', action: 'skip' }]);
    assert.equal(report.ok, true);
    assert.ok(report.pendingConflicts.includes('settings'));

    const after = (await readStateJson(a))!;
    const stateBytesAfter = await readStateText(a);
    assert.equal(after['lastSnapshotId'], 'a-1', 'sync-state.json 原文里的 lastSnapshotId 必须保持 a-1');
    assert.equal(
      lastSnapshotBytes(stateBytesAfter),
      lastSnapshotBefore,
      'lastSnapshotId 字段的原文片段必须逐字节相同（"lastSnapshotId": "a-1"）',
    );
    assert.equal(after['ancestorId'], before['ancestorId'], '祖先目录名不得改动（preserveAncestor）');
    const pending = after['pendingMerge'] as { remoteSnapshotId?: string; sections?: string[] } | undefined;
    assert.equal(pending?.remoteSnapshotId, 'b-1', '待裁决记录指向本次远端快照');
    assert.deepEqual(pending?.sections, ['settings']);

    // 「哪些顶层字段变了」必须只有预期的那几个；lastSnapshotId 不在其中
    const changed = Object.keys({ ...before, ...after }).filter(
      (k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]),
    ).sort();
    assert.ok(!changed.includes('lastSnapshotId'), '被拒/未裁决路径绝不改远端指针（实际变化字段: ' + changed.join(',') + '）');
    for (const k of changed) {
      assert.ok(['sections', 'pendingMerge', 'lastSyncAt'].includes(k), '出现预期之外的状态变化字段: ' + k);
    }
    assert.deepEqual(await treeDigest(a.localSnapshotsDir), ancestorBefore, '祖先副本目录逐字节未变');
    assert.equal(await readSkill(a, 'writing.md'), '# Writing by B\n', '可裁决分区照常落盘');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('硬约束 ②：previewMerge 零写入 —— sync-state.json 与祖先目录逐字节相同', async () => {
  const root = await makeRoot('evidence-preview-readonly');
  try {
    const a = await setupConflict(root);
    const stateBefore = await readStateText(a);
    const ancestorBefore = await treeDigest(a.localSnapshotsDir);
    const stateDirBefore = await treeDigest(a.stateDir);
    assert.notEqual(stateBefore, null);
    assert.ok(ancestorBefore.length > 0, '夹具应已有祖先副本（否则「未变」可能只是「没有」）');

    const preview = await a.engine.previewMerge();
    assert.equal(preview.ok, true, '预览必须真的执行成功（否则「零写入」可能是没跑）');
    assert.ok(preview.sections.length > 0);

    assert.equal(await readStateText(a), stateBefore, 'sync-state.json 逐字节相同');
    assert.deepEqual(await treeDigest(a.localSnapshotsDir), ancestorBefore, '祖先目录逐字节相同');
    assert.deepEqual(await treeDigest(a.stateDir), stateDirBefore, 'stateDir 内不得新增/修改任何文件');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
