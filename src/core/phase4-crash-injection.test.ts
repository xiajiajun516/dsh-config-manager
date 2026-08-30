/**
 * Phase 4 真实 child-process crash 注入（C1-C10）。
 * 每个窗口用独立子进程执行 phase4-crash-child.ts（真实 runJournaled deferred + 真实 FileSnapshotStore），
 * 在指定点 SIGKILL，父进程随后用真实 JournalStore/reconcile 判定：
 *  - C1/C2：快照未 READY+绑定前 crash → 无 trusted bound snapshot，recovery required / 保守
 *  - C3：READY snapshot 已绑定（SNAPSHOT_CREATED）但未 APPLYING → 无 destructive mutation，安全
 *  - C5/C6/C7：partial/local file mutation 已发生 + trusted snapshot 绑定 → 绝不可静默 RECOVERED
 *  - C8/C9/C10：业务成功/COMMITTED 后 → 不 rollback
 * 这是 process.kill(SIGKILL) 真实注入，非 throw 替代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JournalStore } from './journal.ts';
import { Phase3Recovery } from './phase3-host.ts';
import { reconcileActive } from './reconcile.ts';
import { verifySnapshot } from './backup.ts';

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const childPath = path.join(here, 'phase4-crash-child.ts');

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-phase4-crash-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 跑一个 crash 窗口的子进程；返回 { workdir, store, dataDir }（事务可能已完成或残留 active） */
async function runCrashPoint(t: test.TestContext, point: string): Promise<{ workDir: string; dataDir: string }> {
  const workDir = workdir(t);
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [childPath, workDir, point], { stdio: 'ignore' });
    child.on('close', () => resolve());
  });
  return { workDir, dataDir: path.join(workDir, 'data') };
}

async function readJournal(dataDir: string): Promise<import('./journal.ts').OperationJournal | null> {
  const store = new JournalStore({ transactionsDir: path.join(dataDir, 'transactions') });
  await store.ensureDirs();
  const active = await store.scanActive();
  for (const id of active) {
    const j = await store.loadActive(id);
    if (j) return j;
  }
  // 已规整到 completed 的（如 C8-C10 COMMITTED）
  return null;
}

/** 断言某个 crash 窗口后：journal 状态 + snapshot 完整性 + safe mode */
async function assertRecovery(
  t: test.TestContext,
  point: string,
  expect: { journalState?: string[]; snapshotReady?: boolean; expectRecovered?: boolean },
): Promise<void> {
  const { workDir, dataDir } = await runCrashPoint(t, point);
  const snapDir = path.join(dataDir, 'snapshots');
  const j = await readJournal(dataDir);
  const txnDir = path.join(dataDir, 'transactions');

  if (expect.journalState !== undefined) {
    assert.ok(j, `${point}: 应有 journal`);
    assert.ok(
      expect.journalState.includes(j!.state),
      `${point}: journal state=${j!.state} 应为 ${expect.journalState.join('/')}`,
    );
  }

  let snapReady = false;
  if (j?.snapshotId) {
    const v = await verifySnapshot(snapDir, j.snapshotId);
    snapReady = v.ok;
  }
  assert.equal(snapReady, expect.snapshotReady ?? false, `${point}: snapshot READY=${snapReady} 期望 ${expect.snapshotReady}`);

  // 真实 reconcile：保守 hooks（生产 startup 同强度）
  const store = new JournalStore({ transactionsDir: txnDir });
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'unable',
    probeExternal: async () => 'unknown',
    snapshotExists: async (id) => (id !== null ? (await verifySnapshot(snapDir, id)).ok : false),
  }, { environmentFingerprint: 'fp-crash', isLiveOwner: async () => false });

  const decisionKind = out.decisions[0]?.kind;
  if (expect.expectRecovered === true) {
    assert.equal(decisionKind, 'recovered', `${point}: 期望 recovered，实际 ${decisionKind}`);
  } else if (expect.expectRecovered === false) {
    assert.notEqual(decisionKind, 'recovered', `${point}: 绝不可静默 recovered（partial mutation）`);
    assert.ok(
      decisionKind === 'needs-attention' || decisionKind === 'rollback-recommended' || decisionKind === 'noop' || decisionKind === 'rollback-continue',
      `${point}: 保守恢复（${decisionKind}）`,
    );
  }
  return;
}

test('C1: after journal CREATED, before snapshot → 无 trusted snapshot，reconcile 保守（不 RECOVERED 掩盖部分态）', async (t) => {
  await assertRecovery(t, 'C1', { expectRecovered: false });
});

test('C2: during snapshot write, before bind → 无 trusted bound snapshot，保守', async (t) => {
  await assertRecovery(t, 'C2', { expectRecovered: false });
});

test('C3: READY snapshot 已绑定（SNAPSHOT_CREATED）但未 APPLYING → 无 destructive mutation，安全（non-RECOVERED 保守）', async (t) => {
  await assertRecovery(t, 'C3', { snapshotReady: true, expectRecovered: false });
});

test('C4: after APPLYING, before mutation → trusted snapshot bound，保守（安全）', async (t) => {
  await assertRecovery(t, 'C4', { snapshotReady: true, expectRecovered: false });
});

test('C5/C6/C7: partial/local file mutation + trusted snapshot → 绝不可静默 RECOVERED', async (t) => {
  // C6（mid-mutation 后 local file 已写）是核心：有 trusted bound snapshot 且 local 已变
  for (const point of ['C5', 'C6', 'C7']) {
    await assertRecovery(t, point, { snapshotReady: true, expectRecovered: false });
  }
});

test('C8/C9/C10: 业务成功/COMMITTED 后 → 不 rollback（journal COMMITTED 已规整，无 active 残留）', async (t) => {
  for (const point of ['C8', 'C9', 'C10']) {
    const { dataDir } = await runCrashPoint(t, point);
    const snapDir = path.join(dataDir, 'snapshots');
    const txDir = path.join(dataDir, 'transactions');
    const store = new JournalStore({ transactionsDir: txDir });
    // COMMITTED 后 journal 已规整到 completed → active 无残留 → 不需任何自动 rollback
    const active = await store.scanActive();
    assert.equal(active.length, 0, `${point}: COMMITTED 后不应有 active journal（无需回滚）`);
    // 即便 reconcile 也只会 noop/recovered（不触发 destructive rollback）
    const out = await reconcileActive(store, {
      verifyStepFingerprint: async () => 'unable',
      probeExternal: async () => 'unknown',
      snapshotExists: async (id) => (id !== null ? (await verifySnapshot(snapDir, id)).ok : false),
    }, { environmentFingerprint: 'fp-crash', isLiveOwner: async () => false });
    const kind = out.decisions[0]?.kind;
    assert.notEqual(kind, 'rollback-continue', `${point}: COMMITTED 后不得进入回滚`);
    assert.notEqual(kind, 'needs-attention', `${point}: COMMITTED 后不得 needs-attention`);
  }
});

// 明确断言「空 steps + partial mutation 绝不 RECOVERED」（F20 生产回归；对应 C5 后的磁盘态）
test('C6: local file mutation 后 + trusted snapshot → reconcile snapshotExists 正向 → 推荐回滚而非 RECOVERED', async (t) => {
  const { dataDir } = await runCrashPoint(t, 'C6');
  const snapDir = path.join(dataDir, 'snapshots');
  const txnDir = path.join(dataDir, 'transactions');
  const store = new JournalStore({ transactionsDir: txnDir });
  const j = await readJournal(dataDir);
  assert.ok(j && j.snapshotId, 'C6 后 journal 已绑定 trusted snapshot');
  const snapOk = await verifySnapshot(snapDir, j!.snapshotId!);
  assert.equal(snapOk.ok, true, 'C6 后快照完整（READY+manifest+blob）');
  // 生产 snapshotExists 正向：binding 匹配 → true
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'unable',
    probeExternal: async () => 'unknown',
    snapshotExists: async (id) => (id !== null ? (await verifySnapshot(snapDir, id)).ok : false),
  }, { environmentFingerprint: 'fp-crash', isLiveOwner: async () => false });
  const kind = out.decisions[0]?.kind;
  assert.notEqual(kind, 'recovered', 'partial mutation 绝不静默 recovered');
  assert.ok(kind === 'needs-attention' || kind === 'rollback-recommended', `应为保守/回滚推荐，实际 ${kind}`);
  assert.equal(out.safeModeRequired, true, 'partial mutation + 不可证明 → SAFE MODE');
});
