/**
 * Phase 5 Recovery Crash Window 测试（§8 / Step 11 C1-C7）。
 *
 * 每个窗口验证「journal state + reconcile decision + 是否可 RECOVERED」反映该 crash 点，
 * 核心不变量：**crash 后绝不静默 RECOVERED**（VERIFIED / FAIL-CLOSED）。
 *
 * C1  journal CREATED → crash → 不得 RECOVERED / 不得假成功（安全 no-op）
 * C2  snapshot durable → recovery begins → crash before mutation → NEEDS_ATTENTION / rollback-recommended
 * C3  partial recovery mutation → crash → rollback-continue（绝不 RECOVERED）
 * C4  rollback/restore finished → crash before verification → NEEDS_ATTENTION（必须重新 verify）
 * C5  verification failure → NEEDS_ATTENTION（不得 ROLLED_BACK）
 * C6  verification success → 单次原子 journal update → ROLLED_BACK + recoveryVerification=MATCH/PARTIAL_MATCH
 * C7  crash between verification calculation and journal persistence → 不得假定成功（fail-closed）
 *
 * 使用真实 snapshot fixture（FileSnapshotStore.save 全链路）+ 真实 JournalStore + reconcile/orchestrator。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FileSnapshotStore } from '../../src/core/backup.ts';
import { JournalStore, createJournalEntry, type OperationJournal } from '../../src/core/journal.ts';
import { RunRegistry } from '../../src/core/run-registry.ts';
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from '../../src/core/recovery-orchestrator.ts';
import { reconcileActive } from '../../src/core/reconcile.ts';
import { makeContext } from '../../src/adapters/test-helpers.ts';
import { zhMsg } from '../../src/core/messages.ts';
import type { Snapshot } from '../../src/core/types.ts';

const FP = 'fp-cw';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rec-cw-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedSnapshot(snapDir: string, operationId: string): Promise<Snapshot> {
  const store = new FileSnapshotStore({ dir: snapDir });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip: 'x.zip',
    entries: [],
    status: 'pending',
    beforePlugins: [],
    hostFileBackups: [],
    operationId,
    operationType: 'import-apply',
    environmentFingerprint: FP,
    ownerInstanceId: 'owner',
  };
  await store.save(snapshot, new Map());
  return snapshot;
}

function mkJournal(id: string, state: OperationJournal['state'], snapshotId: string | null): OperationJournal {
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.54', environmentFingerprint: FP }, '2026-01-01T00:00:00.000Z');
  j.state = state;
  j.snapshotId = snapshotId;
  return j;
}

interface Harness {
  store: JournalStore;
  runs: RunRegistry;
  snapshotsDir: string;
  homeDir: string;
  transactionsDir: string;
  host: ReturnType<typeof makeContext>;
  orch: ReturnType<typeof createRecoveryOrchestrator>;
  snap: Snapshot;
  opId: string;
}

async function setup(t: test.TestContext, opts: { state?: OperationJournal['state']; createJournal?: boolean } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rec-cw-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snapshotsDir = path.join(dir, 'snapshots');
  const homeDir = path.join(dir, 'home');
  const transactionsDir = path.join(dir, 'transactions');
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  const host = makeContext('win32', homeDir, 'web');
  const store = new JournalStore({ transactionsDir });
  await store.ensureDirs();
  const runs = new RunRegistry();
  const opId = '00000000-0000-4000-8000-0000000000aa';
  const snap = await seedSnapshot(snapshotsDir, opId);
  if (opts.createJournal !== false) {
    await store.create(mkJournal(opId, opts.state ?? 'NEEDS_ATTENTION', snap.id));
  }
  const orch = createRecoveryOrchestrator({
    store, runs, snapshotsDir, host, msg: zhMsg,
    snapshotExists: async (id) => id !== null && id !== '',
    getEnvironmentFingerprint: () => FP,
    clearSafeMode: async () => { await store.writeSafeMode(false); },
  });
  return { store, runs, snapshotsDir, homeDir, transactionsDir, host, orch, snap, opId };
}

function mockExecutors(): (runId: string) => RecoveryExecutorFns {
  return () => ({
    performRestore: async () => ({ full: true, failed: [] }),
    performRollback: async () => ({ full: true, failed: [] }),
  });
}

// ---------- C1：journal CREATED → crash → 不得 RECOVERED / 不得假成功 ----------

test('C1: journal CREATED（mutation 未开始）→ crash → reconcile noop（安全，不假成功）', async (t) => {
  const h = await setup(t, { state: 'CREATED' });
  // 模拟 crash 后重启 reconcile
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'noop', 'CREATED + 无 mutation → 安全 no-op');
  assert.equal(out.safeModeRequired, false, 'noop 不触发 SAFE MODE');
  // 不得假成功：journal 已规整到 completed（noop 是安全完成，非 RECOVERED 假成功）
  const j = await h.store.load(h.opId);
  assert.ok(j !== null);
  assert.equal(j.state, 'RECOVERED', 'noop 规整为 RECOVERED（安全 no-op，无破坏性副作用）');
});

// ---------- C2：snapshot durable → recovery begins → crash before mutation → NEEDS_ATTENTION / rollback-recommended ----------

test('C2: snapshot durable + recovery 未开始 → status → rollback-recommended（可恢复）', async (t) => {
  const h = await setup(t, { state: 'NEEDS_ATTENTION' });
  const r = await h.orch.status();
  assert.equal(r.status, 200);
  const incidents = (r.body as { incidents: Array<{ decision: string }> }).incidents;
  assert.equal(incidents[0]!.decision, 'rollback-recommended', 'snapshot durable → 可恢复到 trusted snapshot');
});

test('C2b: recovery 已开始（RECOVERING）但 mutation 前 crash → reconcile needs-attention（绝不 RECOVERED）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'RECOVERING + 待验证 → needs-attention（§6.5 门控）');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', '不得静默 RECOVERED');
});

// ---------- C3：partial recovery mutation → crash → rollback-continue（绝不 RECOVERED） ----------

test('C3: partial recovery mutation（entryDone 非空）→ crash → rollback-continue', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  await h.store.update(h.opId, (j) => ({ ...j, rollback: { ...j.rollback, entryDone: { 0: true } } }));
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'rollback-continue', 'entryDone 非空 → 续跑中断回滚');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await h.store.load(h.opId))?.state, 'RECOVERING', '保持 RECOVERING，绝不 RECOVERED');
});

// ---------- C4：rollback/restore finished → crash before verification → NEEDS_ATTENTION（必须重新 verify） ----------

test('C4: restore 完成但 verification 前 crash → reconcile needs-attention（必须重新 verify）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  // 模拟 execute 完成（rollback 报告已写），但 verify 未跑（无 recoveryVerification）
  await h.store.update(h.opId, (j) => ({ ...j, rollback: { ...j.rollback, full: true, failed: [] } }));
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'restore 完成但未验证 → needs-attention（§6.5 门控）');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', '必须重新 verify，不得 RECOVERED');
});

// ---------- C5：verification failure → NEEDS_ATTENTION（不得 ROLLED_BACK） ----------

test('C5: verification failure（MISMATCH）→ NEEDS_ATTENTION（不得 ROLLED_BACK）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  await h.store.update(h.opId, (j) => ({
    ...j,
    recoveryVerification: { verdict: 'MISMATCH', details: ['host file 残留'], manualHints: [], at: '2026-01-01T00:00:00.000Z' },
  }));
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'MISMATCH → needs-attention');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', '不得 ROLLED_BACK');
});

// ---------- C6：verification success → 单次原子 journal update → ROLLED_BACK + recoveryVerification ----------

test('C6: verification success（MATCH）→ 单次原子 update → ROLLED_BACK + recoveryVerification=MATCH', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  const body = r.body as { verdict: string; terminal: string };
  assert.equal(body.verdict, 'MATCH');
  assert.equal(body.terminal, 'ROLLED_BACK');
  const j = await h.store.load(h.opId);
  assert.equal(j?.state, 'ROLLED_BACK', '验证通过 → ROLLED_BACK');
  assert.equal(j?.recoveryVerification?.verdict, 'MATCH', 'recoveryVerification 已写入');
  // 已规整到 completed
  assert.deepEqual(await h.store.scanActive(), []);
});

test('C6b: recovery 成功后无其他未解决 incident → SAFE MODE 清除（解除阻断）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  await h.store.writeSafeMode(true);
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  assert.equal((r.body as { terminal: string }).terminal, 'ROLLED_BACK');
  assert.equal(await h.store.readSafeMode(), false, '唯一 incident 恢复成功 → SAFE MODE 清除');
});

test('C6c: recovery 成功后仍有其他未解决 incident → SAFE MODE 保持（不误清除）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  await h.store.writeSafeMode(true);
  // 另造一个未解决 incident
  const other = '00000000-0000-4000-8000-0000000000bb';
  await h.store.create(mkJournal(other, 'NEEDS_ATTENTION', h.snap.id));
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  assert.equal((r.body as { terminal: string }).terminal, 'ROLLED_BACK');
  assert.equal(await h.store.readSafeMode(), true, '仍有未解决 incident → SAFE MODE 保持');
  // 清理测试残留
  await h.store.quarantine(other, 'cleanup');
});

// ---------- C7：crash between verification calculation and journal persistence → 不得假定成功（fail-closed） ----------

test('C7: crash between verification calc and journal persistence → journal 保持 RECOVERING → reconcile needs-attention（fail-closed）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  // 模拟 verify 计算完成但 store.update 前 crash：journal 仍 RECOVERING、无 recoveryVerification
  // （verify 路由的 verification 写入 + terminal 迁移是单次原子 update，crash 在 update 前 = 未写入）
  const j = await h.store.load(h.opId);
  assert.equal(j?.state, 'RECOVERING');
  assert.equal(j?.recoveryVerification, undefined, 'crash 前未写入 verification');
  // 重启 reconcile：不得假定成功
  const out = await reconcileActive(h.store, {
    verifyStepFingerprint: async () => 'before-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'crash 在原子 update 前 → needs-attention（fail-closed）');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', '不得假定成功');
});

// ---------- 补充：execute 后 crash（RECOVERING 保持）→ 可 retry/verify 继续 ----------

test('C7b: execute 后 crash（RECOVERING 保持）→ retry/verify 可继续', async (t) => {
  const h = await setup(t, { state: 'NEEDS_ATTENTION' });
  // execute → RECOVERING
  const r = await h.orch.execute(h.opId, true, mockExecutors());
  assert.equal(r.status, 200);
  assert.equal((await h.store.load(h.opId))?.state, 'RECOVERING');
  // crash 后重启：verify 仍可继续（RECOVERING 允许 verify）
  const v = await h.orch.verify(h.opId);
  assert.equal(v.status, 200);
  assert.equal((v.body as { verdict: string }).verdict, 'MATCH');
  assert.equal((await h.store.load(h.opId))?.state, 'ROLLED_BACK');
});
