/**
 * Phase 4 统一恢复校验测试（F8/F9/F25）：
 *  - validateSnapshotForRestore 各 verdict（TRUSTED_OPERATION_SNAPSHOT / TRUSTED_MANUAL_LOCAL /
 *    LEGACY_REQUIRES_CONFIRMATION / CORRUPT / INVALID / UNSAFE_PATH / WRONG_ENVIRONMENT）
 *  - manifest/blob 篡改 → CORRUPT（恢复前重验，F9 substitution）
 *  - symlink 化 snapshot.json / manifest → UNSAFE_PATH（F25）
 *  - planRestore 在 snapshotsRoot 下拒绝 untrusted 快照（统一三个入口强度）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { planRestore, validateSnapshotForRestore, type RestoreSnapshotVerdict } from '../../src/core/restore.ts';
import { FileSnapshotStore, createSnapshot } from '../../src/core/backup.ts';
import { makeContext } from '../../src/adapters/test-helpers.ts';
import type { Snapshot } from '../../src/core/types.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-restore-trust-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function minPlan() {
  return { items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }], globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as Record<string, never> };
}

/** 构造 op-bound READY 快照（save 全链路：manifest + READY） */
async function seedOpBound(snapDir: string): Promise<Snapshot> {
  const ctx = makeContext('win32', path.join(path.dirname(snapDir), 'home'), 'web');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));
  const store = new FileSnapshotStore({ dir: snapDir });
  return createSnapshot({
    ctx, plan: minPlan(), sourceZip: 'x.zip', store, adapters: [],
    operationId: 'op-1', operationType: 'import-apply', environmentFingerprint: 'fp', ownerInstanceId: 'owner',
  });
}

test('V-01: op-bound READY 快照 → TRUSTED_OPERATION_SNAPSHOT', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir, { environmentFingerprint: 'fp' });
    assert.equal(v.verdict, 'TRUSTED_OPERATION_SNAPSHOT');
  });
});

test('V-02: 完整性通过但无 binding（手动本地）→ TRUSTED_MANUAL_LOCAL', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    // 移除 binding 字段（模拟非 operation-bound 但完整的新快照）→ 仍是 READY+manifest，但无 op binding
    const sp = path.join(snapDir, snap.id, 'snapshot.json');
    const s = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
    delete s.operationId; delete s.operationType; delete s.ownerInstanceId; delete s.environmentFingerprint;
    await fs.writeFile(sp, JSON.stringify(s));
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir);
    assert.equal(v.verdict, 'TRUSTED_MANUAL_LOCAL', '完整但非 op-bound → 手动本地');
  });
});

test('V-03: 旧快照（无 manifest/readiness）→ LEGACY_REQUIRES_CONFIRMATION', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const id = 'legacy-snap';
    const d = path.join(snapDir, id);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'snapshot.json'), JSON.stringify({ id, createdAt: '2026-01-01', sourceZip: 'l.zip', entries: [] }));
    const v = await validateSnapshotForRestore(d, snapDir);
    assert.equal(v.verdict, 'LEGACY_REQUIRES_CONFIRMATION', '旧快照需显式确认');
  });
});

test('V-04: blob 篡改（substitution）→ CORRUPT（恢复前重验，F9）', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    // 从 manifest.blobHashes 取真实 blob 路径（blobs/host/<uuid>）并篡改
    const mp = path.join(snapDir, snap.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(mp, 'utf8'));
    const blobKeys = Object.keys(manifest.blobHashes ?? {});
    assert.ok(blobKeys.length > 0, '快照应有 blob');
    await fs.writeFile(path.join(snapDir, snap.id, blobKeys[0]!), Buffer.from('HACKED'));
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir);
    assert.equal(v.verdict, 'CORRUPT', 'blob hash 不匹配 → 拒绝恢复');
  });
});

test('V-05: manifest 篡改 → CORRUPT', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    const mp = path.join(snapDir, snap.id, 'manifest.json');
    const m = JSON.parse(await fs.readFile(mp, 'utf8'));
    m.entryCount = 999;
    await fs.writeFile(mp, JSON.stringify(m));
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir);
    assert.equal(v.verdict, 'CORRUPT');
  });
});

test('V-06: symlink 化 snapshot.json → UNSAFE_PATH（F25）', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    // replace snapshot.json with symlink to an outside file
    const outside = path.join(dir, 'evil.json');
    await fs.writeFile(outside, JSON.stringify(snap));
    await fs.rm(path.join(snapDir, snap.id, 'snapshot.json'));
    await fs.symlink(outside, path.join(snapDir, snap.id, 'snapshot.json'));
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir);
    assert.equal(v.verdict, 'UNSAFE_PATH', 'symlink 化关键 metadata 拒绝');
  });
});

test('V-06b: 真实 Windows junction 化 blobs 目录 → UNSAFE_PATH（F25 Review C 强化）', async (t) => {
  // Node 在 Windows 上 lstat(junction)=isSymbolicLink=true 但 readdir 列出外部目标的普通文件，
  // 故仅查 blob 子项会漏 junction 逃逸。此测试用真实 junction 复现该场景（Phase 5 因环境限制
  // 未能复现，标记 NOT REPRODUCIBLE）。
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    const snapPath = path.join(snapDir, snap.id);
    const blobs = path.join(snapPath, 'blobs');
    // 用 junction 替换 blobs 目录 → 指向外部目录（外部含伪装 blob 文件）
    const external = path.join(dir, 'external-blobs');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, 'fake-blob.bin'), Buffer.from('external'));
    // 移除 seedOpBound 创建的真实 blobs 目录，才能在原位建 junction
    await fs.rm(blobs, { recursive: true, force: true });
    let created = false;
    try {
      await fs.symlink(external, blobs, 'junction');
      created = true;
    } catch {
      try { await fs.symlink(external, blobs, 'dir'); created = true; } catch { /* symlink 不可用 */ }
    }
    if (!created) {
      t.diagnostic('当前环境无法创建 junction/symlink，跳过真实 junction 用例');
      return;
    }
    const v = await validateSnapshotForRestore(snapPath, snapDir, { environmentFingerprint: 'fp' });
    assert.equal(v.verdict, 'UNSAFE_PATH', 'junction 化的 blobs 目录必须拒绝（读取面逃逸）');
  });
});

test('V-07: 越界/非法 id → INVALID', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    // snapshotDir 是 snapshotsRoot 之外（../escape）→ INVALID
    const v = await validateSnapshotForRestore(path.join(snapDir, '..', 'escape'), snapDir);
    assert.equal(v.verdict, 'INVALID');
    // 快照目录非 snapshotsRoot 的直接子目录（嵌套两层）→ INVALID
    await fs.mkdir(path.join(snapDir, 'sub', 'nested'), { recursive: true });
    const v2 = await validateSnapshotForRestore(path.join(snapDir, 'sub', 'nested'), snapDir);
    assert.equal(v2.verdict, 'INVALID');
    // 路径分隔符 id → INVALID
    const v3 = await validateSnapshotForRestore(path.join(snapDir, 'x/y'), snapDir);
    assert.equal(v3.verdict, 'INVALID');
  });
});

test('V-08: env 不匹配 → WRONG_ENVIRONMENT', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    const v = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir, { environmentFingerprint: 'OTHER-FP' });
    assert.equal(v.verdict, 'WRONG_ENVIRONMENT', '跨机快照 → 拒绝');
  });
});

test('V-09: planRestore 在 snapshotsRoot 下拒绝 untrusted（corrupt）快照', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    const snap = await seedOpBound(snapDir);
    // 从 manifest.blobHashes 取真实 blob 路径并篡改 → corrupt → planRestore 拒绝
    const mp = path.join(snapDir, snap.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(mp, 'utf8'));
    const blobKeys = Object.keys(manifest.blobHashes ?? {});
    assert.ok(blobKeys.length > 0);
    await fs.writeFile(path.join(snapDir, snap.id, blobKeys[0]!), Buffer.from('HACKED'));
    await assert.rejects(
      () => planRestore({ snapshotDir: path.join(snapDir, snap.id), homeDir: path.join(dir, 'home'), profile: 'web', snapshotsRoot: snapDir }),
      /不可信|untrusted|snapshot/,
      'untrusted 快照应在计划阶段被拒绝',
    );
  });
});
