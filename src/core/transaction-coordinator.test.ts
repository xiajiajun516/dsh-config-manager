/**
 * Phase 3 MutationTransactionCoordinator 单测（node:test，零依赖）。
 * 覆盖：happy COMMITTED、active≤1、step 抛错→NEEDS_ATTENTION、external attention→NEEDS_ATTENTION、
 * rollback（含 WAL entryDone）、terminal-before-release、environment.lock immutable、
 * validate 失败、RECOVERY_REQUIRED（rollback 失败）。只测 Coordinator，reconcile 另测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JournalStore, createJournalEntry, type OperationJournal } from './journal.ts';
import { MutationTransactionCoordinator, type CoordinatedOperation } from './transaction-coordinator.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'txn-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OWNER = 'owner-coord';
const LOCK_ID = 'lock-coord';
const FP = 'fp-coord';

function ctx(): MutationLockContext {
  return { token: { tokenId: 't1', managerId: 'm1', instanceId: OWNER, acquiredAt: Date.now() } };
}

interface DepsOverrides { releaseCalls?: string[]; onRelease?: (opId: string) => void; liveOwner?: (j: OperationJournal) => boolean; }

async function makeDeps(dir: string, overrides: DepsOverrides = {}) {
  const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
  const releaseCalls: string[] = overrides.releaseCalls ?? [];
  const deps = {
    store,
    lock: null as null, // 无真实锁（releaseLock/acquireLock 由测试注入）
    acquireLock: async () => ctx(),
    checkActiveClear: async (c: MutationLockContext): Promise<{ clear: true } | { clear: false; residue: string }> => {
      const ops = await store.scanActive();
      for (const op of ops) {
        const j = await store.loadActive(op);
        if (j === null) continue;
        if (overrides.liveOwner?.(j)) continue; // live 跳过
        // 非 terminal 残留 → 不创建第二个
        const ts = ['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION'] as const;
        if (!(ts as readonly string[]).includes(j.state)) {
          return { clear: false, residue: op };
        }
      }
      return { clear: true };
    },
    releaseLock: async (c: MutationLockContext, operationId: string) => {
      // terminal-before-release：release 前验证 journal 已 terminal
      const state = await store.terminalStateOf(operationId);
      const ts = ['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION'] as const;
      assert.ok(ts.includes(state as never), `release 时 journal 必须 terminal，得到 ${state}`);
      releaseCalls.push(operationId);
      overrides.onRelease?.(operationId);
    },
    lockId: LOCK_ID,
    ownerInstanceId: OWNER,
    packageVersion: '0.1.54',
    environmentFingerprint: FP,
    redactText: (s: string) => s,
  };
  return { store, deps };
}

async function seedFakeOwnershipLock(dir: string): Promise<Buffer> {
  // 模拟 environment.lock（immutable）：创建后记录字节，之后断言不变
  const lockPath = path.join(dir, 'environment.lock');
  const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, owner: { instanceId: OWNER } }));
  await fs.writeFile(lockPath, bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------- 帮助：构造 CoordinatedOperation ----------

function op(over: Partial<CoordinatedOperation> & { operationType: string }): CoordinatedOperation {
  return {
    buildSteps: () => [
      { stepId: 's1', adapter: 'settings', ref: 'web.key', kind: 'Update', external: false },
      { stepId: 's2', adapter: 'skills', ref: 'a.md', kind: 'Update', external: false },
    ],
    executeStep: async (stepId) => ({ status: 'ok', beforeFp: 'before', afterFp: `after-${stepId}` }),
    validate: async () => ({ ok: true, warnings: [] }),
    ...over,
  };
}

// happy path：COMMITTED + terminal-before-release + journal 规整 + lock immutable
test('Coordinator happy path → COMMITTED，release 在 terminal 后，environment.lock 不变', async (t) => {
  const dir = tmp(t);
  const ownLockBytes = await seedFakeOwnershipLock(dir);
  const releaseCalls: string[] = [];
  const { store, deps } = await makeDeps(dir, { releaseCalls });
  const coord = new MutationTransactionCoordinator(deps);
  const result = await coord.run(op({ operationType: 'import-apply' }));
  assert.equal(result.outcome, 'COMMITTED');
  if (result.outcome !== 'COMMITTED') return;
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0], result.operationId);
  // journal 规整到 completed，active 空
  assert.deepEqual(await store.scanActive(), []);
  assert.equal(await store.isTerminal(result.operationId), true);
  // Mandatory Test 1/2/3: environment.lock 字节不变；创建 journal 不修改 ownership；无 journalId
  const afterBytes = await fs.readFile(path.join(dir, 'environment.lock'));
  assert.deepEqual(afterBytes, ownLockBytes, 'environment.lock 字节必须全程不变（immutable）');
  const completed = await store.load(result.operationId);
  assert.ok(completed);
  assert.equal(completed!.snapshotId, null);
  assert.equal('journalId' in completed! || Object.prototype.hasOwnProperty.call(completed, 'journalId'), false, 'journal 不携 journalId');
});

test('Coordinator：active 残留 → RECOVERY_REQUIRED，不创建第二个 journal', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  // 预置一个残留 active（非 terminal）
  const residueId = '00000000-0000-4000-8000-000000000001';
  await store.create(createJournalEntry('import-apply', { operationId: residueId, ownerInstanceId: 'other', lockId: 'other', packageVersion: '0.1.54', environmentFingerprint: FP }, '2026-01-01T00:00:00.000Z'));
  const releaseCalls: string[] = [];
  const coord = new MutationTransactionCoordinator({ ...deps, releaseLock: async () => { releaseCalls.push('x'); } });
  const result = await coord.run(op({ operationType: 'import-apply' }));
  assert.equal(result.outcome, 'RECOVERY_REQUIRED');
  assert.deepEqual(releaseCalls, [], 'active 残留时不应创建新 transaction/release');
  // 只有一个 journal
  const ops = await store.scanActive();
  assert.deepEqual(ops, [residueId]);
});

test('Coordinator：step 抛错 → NEEDS_ATTENTION（无 rollback），SAFE MODE, non-terminal in active 被规整', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  const coord = new MutationTransactionCoordinator(deps);
  const result = await coord.run(op({
    operationType: 'import-apply',
    executeStep: async () => { throw new Error('boom'); },
  }));
  assert.equal(result.outcome, 'NEEDS_ATTENTION');
  if (result.outcome !== 'NEEDS_ATTENTION') return;
  assert.equal(await store.readSafeMode(), true, 'NEEDS_ATTENTION → SAFE MODE durable');
  // journal 终态 NEEDS_ATTENTION（terminal），规整到 completed
  assert.equal(await store.terminalStateOf(result.operationId), 'NEEDS_ATTENTION');
  assert.deepEqual(await store.scanActive(), []);
});

test('Coordinator：external attention step → NEEDS_ATTENTION（不自动 rollback）', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  const coord = new MutationTransactionCoordinator(deps);
  const result = await coord.run(op({
    operationType: 'import-apply',
    buildSteps: () => [{ stepId: 'p1', adapter: 'plugins', ref: 'plugin:@x', kind: 'Install', external: true }],
    executeStep: async () => ({ status: 'attention', warning: 'half-installed' }),
    rollback: async () => { throw new Error('rollback should NOT be auto-called for external'); },
  }));
  assert.equal(result.outcome, 'NEEDS_ATTENTION');
  assert.equal(await store.readSafeMode(), true);
});

test('Coordinator：step throw 不自动 rollback → NEEDS_ATTENTION（破坏性回滚需用户确认）', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  let rollbackCalled = false;
  const coord = new MutationTransactionCoordinator(deps);
  const result = await coord.run(op({
    operationType: 'import-apply',
    createSnapshot: async () => ({ snapshotId: 'snap-1' }),
    executeStep: async (stepId) => { if (stepId === 's2') throw new Error('boom'); return { status: 'ok', beforeFp: 'b', afterFp: 'a' }; },
    rollback: async () => { rollbackCalled = true; return { full: true, failed: [] }; },
  }));
  assert.equal(result.outcome, 'NEEDS_ATTENTION', '进程内异常不得自动 rollback');
  assert.equal(rollbackCalled, false, '自动 rollback 不应被调用');
  assert.equal(await store.readSafeMode(), true);
});

test('Coordinator：validate 失败 → NEEDS_ATTENTION（不 COMMITTED）', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  const coord = new MutationTransactionCoordinator(deps);
  const result = await coord.run(op({
    operationType: 'import-apply',
    validate: async () => ({ ok: false, warnings: ['bad-data'] }),
  }));
  assert.equal(result.outcome, 'NEEDS_ATTENTION');
  if (result.operationId !== null) {
    assert.notEqual(await store.terminalStateOf(result.operationId), 'COMMITTED');
  }
  assert.equal(await store.readSafeMode(), true);
});

test('Coordinator：显式 rollbackForRecovery（用户确认）→ ROLLED_BACK + rollback WAL entryDone', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  const coord = new MutationTransactionCoordinator(deps);
  const operation = op({
    operationType: 'import-apply',
    createSnapshot: async () => ({ snapshotId: 'snap-1' }),
    executeStep: async () => ({ status: 'attention', warning: 'x' }),
    rollback: async (snapshotId, c, entryDone) => { await entryDone(0); await entryDone(1); return { full: true, failed: [] }; },
  });
  // 先进 run（因 attention → NEEDS_ATTENTION 规整到 completed）——为测试 rollbackForRecovery，手动再造一个非终态 journal
  const r1 = await coord.run(operation);
  assert.equal(r1.outcome, 'NEEDS_ATTENTION');
  // 再造一个独立 op 验证显式回滚
  const opId = '00000000-0000-4000-8000-0000000000aa';
  await store.create(createJournalEntry('import-apply', { operationId: opId, ownerInstanceId: OWNER, lockId: LOCK_ID, packageVersion: '0.1.54', environmentFingerprint: FP }, '2026-01-01T00:00:00.000Z'));
  await store.update(opId, (j) => ({ ...j, snapshotId: 'snap-1', state: 'APPLYING' }));
  const ctx2 = ctx();
  const res = await coord.rollbackForRecovery({
    operationType: 'import-apply', buildSteps: () => [], executeStep: async () => ({ status: 'ok' }), validate: async () => ({ ok: true, warnings: [] }),
    rollback: async (snapshotId, c, entryDone) => { assert.equal(snapshotId, 'snap-1'); await entryDone(0); await entryDone(1); return { full: true, failed: [] }; },
  }, ctx2, opId, 'snap-1', 'cause');
  assert.equal(res.outcome, 'ROLLED_BACK');
  const j = await store.load(opId);
  assert.ok(j);
  assert.deepEqual(Object.keys(j!.rollback.entryDone).map(Number).sort(), [0, 1]);
  assert.equal(j!.rollback.full, true);
  assert.equal(await store.terminalStateOf(opId), 'ROLLED_BACK');
});

test('Coordinator：显式 rollback 失败 → RECOVERY_REQUIRED，不伪造终态', async (t) => {
  const dir = tmp(t);
  const { store, deps } = await makeDeps(dir);
  const coord = new MutationTransactionCoordinator(deps);
  const opId = '00000000-0000-4000-8000-0000000000bb';
  await store.create(createJournalEntry('import-apply', { operationId: opId, ownerInstanceId: OWNER, lockId: LOCK_ID, packageVersion: '0.1.54', environmentFingerprint: FP }, 'x'));
  const ctx2 = ctx();
  const res = await coord.rollbackForRecovery({
    operationType: 'import-apply', buildSteps: () => [], executeStep: async () => ({ status: 'ok' }), validate: async () => ({ ok: true, warnings: [] }),
    rollback: async () => { throw new Error('rollback broken'); },
  }, ctx2, opId, null, 'cause');
  assert.equal(res.outcome, 'RECOVERY_REQUIRED');
  assert.equal(await store.readSafeMode(), true);
  const state = await store.terminalStateOf(opId);
  assert.ok(!state || !['COMMITTED', 'ROLLED_BACK', 'RECOVERED'].includes(state), `不伪造 terminal，实际=${state}`);
});
