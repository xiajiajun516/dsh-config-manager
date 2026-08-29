/**
 * Phase 3 Security 单测（§28/§29）：
 *  - 高熵 secret 出现在 error → journal 不含原值（redactJournalText）。
 *  - journal 路径 symlink → loadActive 拒绝（不写穿透）。
 *  - operationId 路径穿越 → 拒绝。
 *  - 恶意 journal（伪造 fingerprint / snapshot 指向）→ 不自动恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JournalStore, createJournalEntry, redactJournalText, isValidOperationId } from './journal.ts';
import { MutationTransactionCoordinator, type CoordinatedOperation } from './transaction-coordinator.ts';
import { reconcileActive } from './reconcile.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'p3s-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Security：高熵 secret 出现在 thrown error → journal 不含原值（redactJournalText）', async (t) => {
  const dir = tmp(t);
  const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
  const secret = 'ab31f9c2d84e7a6059b3c1d8e2f4a6b7c9d0e' + 'f1a2b3c4d5e6f71890a1b2c3d4e5f607'; // 随机高熵
  const ctx = (): MutationLockContext => ({ token: { tokenId: 't', managerId: 'm', instanceId: 'i', acquiredAt: 0 } });
  const coord = new MutationTransactionCoordinator({
    store, lock: null as never, acquireLock: async () => ctx(), checkActiveClear: async () => ({ clear: true }),
    lockId: 'l', ownerInstanceId: 'i', packageVersion: '0.1.54', environmentFingerprint: 'fp',
    releaseLock: async () => {}, // 不传 redactText → 用默认 redactJournalText
  });
  const op: CoordinatedOperation = {
    operationType: 'import-apply', buildSteps: () => [{ stepId: 's1', adapter: 'settings', ref: 'x', kind: 'Update', external: false }],
    executeStep: async () => { throw new Error(`connection failed token=${secret}`); },
    validate: async () => ({ ok: true, warnings: [] }),
  };
  const r = await coord.run(op);
  assert.equal(r.outcome, 'NEEDS_ATTENTION');
  if (r.operationId === null) { assert.fail('operationId 应为非空'); return; }
  const journal = await store.load(r.operationId);
  assert.ok(journal);
  const serialized = JSON.stringify(journal);
  assert.equal(serialized.includes(secret), false, 'journal 不得含高熵 secret 原值（硬性）');
  assert.ok(serialized.includes('REDACTED'), '应含脱敏标记');
  // redactJournalText 单测
  const red = redactJournalText(`err token=${secret}`);
  assert.equal(red.includes(secret), false);
  assert.ok(red.includes('REDACTED'));
});

test('Security：journal 路径 symlink → loadActive 拒绝（不写穿透）', async (t) => {
  const dir = tmp(t);
  const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
  await store.ensureDirs();
  const id = '00000000-0000-4000-8000-0000000000f1';
  // 真实 journal
  await store.create(createJournalEntry('x', { operationId: id, ownerInstanceId: 'o', lockId: 'l', packageVersion: '0', environmentFingerprint: 'f' }, 'x'));
  // 用 symlink 替换（模拟被替换 → 读应拒绝/返回 null）
  const activeFile = path.join(dir, 'transactions', 'active', `${id}.json`);
  const victim = path.join(dir, 'victim.txt');
  await fs.writeFile(victim, 'attacker-controlled');
  if (process.platform !== 'win32') {
    await fs.unlink(activeFile);
    await fs.symlink(victim, activeFile);
    assert.equal(await store.loadActive(id), null, 'symlink journal 应被拒绝');
  }
});

test('Security：operationId 路径穿越 → 拒绝', () => {
  assert.equal(isValidOperationId('../../etc/passwd'), false);
  assert.equal(isValidOperationId('..\\..\\x'), false);
  assert.equal(isValidOperationId('00000000-0000-4000-8000-000000000000'), true);
});

test('Security：恶意 journal 指向伪造 snapshot → 不自动恢复（快照缺失 → needs-attention）', async (t) => {
  const dir = tmp(t);
  const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
  const id = '00000000-0000-4000-8000-0000000000f2';
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'o', lockId: 'l', packageVersion: '0', environmentFingerprint: 'fp' }, 'x');
  j.state = 'APPLYING';
  j.plannedSteps = ['s1'];
  j.steps = { s1: { adapter: 'settings', ref: 'ns', kind: 'Update', external: false, beforeFp: 'b', afterFp: null, status: 'planned', appliedAt: null } };
  j.snapshotId = 'forged-ancient-snapshot';
  await store.create(j);
  // snapshotExists=false（伪造的快照不存在）→ needs-attention，绝不自动回滚
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'after-match', probeExternal: async () => 'not-installed', snapshotExists: async () => false,
  }, { environmentFingerprint: 'fp', isLiveOwner: async () => false });
  assert.equal(out.decisions[0]!.kind, 'needs-attention');
  assert.equal(out.safeModeRequired, true);
  assert.ok((await store.loadActive(id)) !== null, '快照伪造 → 不自动恢复，保留待用户');
});
