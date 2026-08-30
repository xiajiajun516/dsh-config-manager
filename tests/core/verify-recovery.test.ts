/**
 * Phase 5 Post-Recovery Verification 测试（§6）。
 * 覆盖：MATCH / PARTIAL_MATCH / MISMATCH / VERIFICATION_ERROR 四 verdict；
 * snapshot trust（corrupted / substitution / unsafe path / wrong env / wrong op）；
 * target mismatch（host file 内容/缺失 / 应删仍存在 / plugin / settings）；
 * security（blob / manifest 篡改）。
 * 使用真实 snapshot fixture（FileSnapshotStore.save 全链路：manifest + READY），
 * 不 mock 掉核心 trust validation。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FileSnapshotStore } from '../../src/core/backup.ts';
import { verifyRecovery, recoveryTerminalState } from '../../src/core/verify-recovery.ts';
import { makeContext } from '../../src/adapters/test-helpers.ts';
import type { HostFileBackup, PluginInfo, Snapshot, SnapshotEntry } from '../../src/core/types.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-verify-rec-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 构造 op-bound READY 快照（save 全链路：manifest + READY）。blobs 为 blobPath → 字节。 */
async function seedSnapshot(
  snapDir: string,
  opts: {
    hostFileBackups?: HostFileBackup[];
    entries?: SnapshotEntry[];
    beforePlugins?: PluginInfo[];
    blobs?: Map<string, Uint8Array>;
    environmentFingerprint?: string;
    operationId?: string;
  } = {},
): Promise<Snapshot> {
  const store = new FileSnapshotStore({ dir: snapDir });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip: 'x.zip',
    entries: opts.entries ?? [],
    status: 'pending',
    // 保留 undefined（无 beforePlugins 基线 → 插件不可验证 → PARTIAL_MATCH）
    ...(opts.beforePlugins !== undefined ? { beforePlugins: opts.beforePlugins } : {}),
    hostFileBackups: opts.hostFileBackups ?? [],
    operationId: opts.operationId ?? 'op-1',
    operationType: 'import-apply',
    environmentFingerprint: opts.environmentFingerprint ?? 'fp',
    ownerInstanceId: 'owner',
  };
  await store.save(snapshot, opts.blobs ?? new Map());
  return snapshot;
}

const FP = 'fp';

test('MATCH：host files + plugin + settings 全部匹配 → MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    // settings 基线
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    // host file 基线
    const settingsContent = Buffer.from('general:\n  theme: dark\n', 'utf8');
    await ctx.fs.writeFile('settings.yaml', settingsContent);
    const blobPath = 'blobs/settings.yaml';
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
      entries: [{ kind: 'settingsNamespace', adapter: 'settings', ref: 'general', before: { theme: 'dark' }, revision: 1, existed: true }],
      beforePlugins: [{ name: 'pkg-a', version: '1.0.0', enabled: true }],
      blobs: new Map([[blobPath, settingsContent]]),
      environmentFingerprint: FP,
    });
    // 当前状态与快照一致
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MATCH');
  });
});

test('PARTIAL_MATCH：无 beforePlugins 基线（插件不可验证）→ PARTIAL_MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const settingsContent = Buffer.from('general:\n  theme: dark\n', 'utf8');
    await ctx.fs.writeFile('settings.yaml', settingsContent);
    const blobPath = 'blobs/settings.yaml';
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
      beforePlugins: undefined, // 无基线 → 插件不可验证
      blobs: new Map([[blobPath, settingsContent]]),
      environmentFingerprint: FP,
    });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'PARTIAL_MATCH');
    assert.ok(v.manualHints.length > 0, '不可验证项应带 manualHint');
  });
});

test('MISMATCH：host file 内容被修改 → MISMATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const original = Buffer.from('general:\n  theme: dark\n', 'utf8');
    await ctx.fs.writeFile('settings.yaml', original);
    const blobPath = 'blobs/settings.yaml';
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
      blobs: new Map([[blobPath, original]]),
      environmentFingerprint: FP,
    });
    // 恢复后文件被外部修改
    await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: light\n', 'utf8'));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MISMATCH');
  });
});

test('MISMATCH：host file 缺失 → MISMATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const original = Buffer.from('general:\n  theme: dark\n', 'utf8');
    await ctx.fs.writeFile('settings.yaml', original);
    const blobPath = 'blobs/settings.yaml';
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
      blobs: new Map([[blobPath, original]]),
      environmentFingerprint: FP,
    });
    // 恢复后文件被删除
    await ctx.fs.remove('settings.yaml');
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MISMATCH');
  });
});

test('MISMATCH：应删除目标仍存在（existed=false 但文件残留）→ MISMATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    // 快照记录 settings.yaml 当时不存在（existed=false）→ 恢复后应不存在
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath: '', existed: false }],
      environmentFingerprint: FP,
    });
    // 但文件残留
    await ctx.fs.writeFile('settings.yaml', Buffer.from('residue', 'utf8'));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MISMATCH');
  });
});

test('MISMATCH：导入期间新增插件未移除 → MISMATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, {
      beforePlugins: [{ name: 'pkg-a', version: '1.0.0', enabled: true }],
      environmentFingerprint: FP,
    });
    // 当前多装了 pkg-b（导入期间新增未移除）
    ctx.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.0.0', enabled: true });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MISMATCH');
  });
});

test('MISMATCH：settings 明确不同 → MISMATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const snap = await seedSnapshot(snapDir, {
      entries: [{ kind: 'settingsNamespace', adapter: 'settings', ref: 'general', before: { theme: 'dark' }, revision: 1, existed: true }],
      environmentFingerprint: FP,
    });
    // 当前 settings 被改成 light
    ctx.settings.ns.set('general', { value: { theme: 'light' }, revision: 2, secrets: [] });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'MISMATCH');
  });
});

// ---------- Snapshot trust ----------

test('VERIFICATION_ERROR：blob 篡改（substitution）→ 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const original = Buffer.from('general:\n  theme: dark\n', 'utf8');
    await ctx.fs.writeFile('settings.yaml', original);
    const blobPath = 'blobs/settings.yaml';
    const snap = await seedSnapshot(snapDir, {
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
      blobs: new Map([[blobPath, original]]),
      environmentFingerprint: FP,
    });
    // 篡改 blob
    await fs.writeFile(path.join(snapDir, snap.id, blobPath), Buffer.from('HACKED'));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR');
  });
});

test('VERIFICATION_ERROR：manifest 篡改 → 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: FP });
    const mp = path.join(snapDir, snap.id, 'manifest.json');
    const m = JSON.parse(await fs.readFile(mp, 'utf8'));
    m.entryCount = 999;
    await fs.writeFile(mp, JSON.stringify(m));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR');
  });
});

test('VERIFICATION_ERROR：snapshot substitution（替换为另一快照）→ 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: FP });
    // 用另一个快照替换（不同 id / 不同 binding）
    const other = await seedSnapshot(snapDir, { environmentFingerprint: 'OTHER-FP', operationId: 'op-other' });
    // 把 snap 目录内容替换为 other 的内容（模拟 substitution）
    await fs.rm(path.join(snapDir, snap.id), { recursive: true, force: true });
    await fs.cp(path.join(snapDir, other.id), path.join(snapDir, snap.id), { recursive: true });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR', '替换快照（env/op 不匹配）必须拒绝');
  });
});

test('VERIFICATION_ERROR：unsafe path（symlink 化 snapshot.json）→ 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: FP });
    const outside = path.join(dir, 'evil.json');
    await fs.writeFile(outside, JSON.stringify(snap));
    await fs.rm(path.join(snapDir, snap.id, 'snapshot.json'));
    await fs.symlink(outside, path.join(snapDir, snap.id, 'snapshot.json'));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR');
  });
});

test('VERIFICATION_ERROR：wrong environment → 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: 'FP-A' });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: 'FP-B', expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR');
  });
});

test('VERIFICATION_ERROR：wrong operation → 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: FP, operationId: 'op-1' });
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-2' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR');
  });
});

test('VERIFICATION_ERROR：非 operation-bound 快照（TRUSTED_MANUAL_LOCAL）→ 拒绝 MATCH', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    const homeDir = path.join(dir, 'home');
    await fs.mkdir(snapDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    const ctx = makeContext('win32', homeDir, 'web');
    const snap = await seedSnapshot(snapDir, { environmentFingerprint: FP });
    // 移除 binding 字段 → TRUSTED_MANUAL_LOCAL（非 operation-bound 不可作 recovery 目标）
    const sp = path.join(snapDir, snap.id, 'snapshot.json');
    const s = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
    delete s.operationId; delete s.operationType; delete s.ownerInstanceId; delete s.environmentFingerprint;
    await fs.writeFile(sp, JSON.stringify(s));
    const v = await verifyRecovery(snap, ctx, { snapshotsRoot: snapDir, environmentFingerprint: FP, expectedOperationId: 'op-1' });
    assert.equal(v.verdict, 'VERIFICATION_ERROR', '非 operation-bound 快照不得当作 MATCH');
  });
});

// ---------- recoveryTerminalState 映射 ----------

test('recoveryTerminalState：MATCH/PARTIAL_MATCH → ROLLED_BACK；MISMATCH/VERIFICATION_ERROR → NEEDS_ATTENTION', () => {
  assert.equal(recoveryTerminalState('MATCH'), 'ROLLED_BACK');
  assert.equal(recoveryTerminalState('PARTIAL_MATCH'), 'ROLLED_BACK');
  assert.equal(recoveryTerminalState('MISMATCH'), 'NEEDS_ATTENTION');
  assert.equal(recoveryTerminalState('VERIFICATION_ERROR'), 'NEEDS_ATTENTION');
});
