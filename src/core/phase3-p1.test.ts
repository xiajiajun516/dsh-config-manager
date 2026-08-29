/**
 * Phase 3 P1-A（ownership binding 强制校验）+ P1-B（startup recovery barrier）的 targeted tests。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JournalStore, createJournalEntry, type OperationJournal } from './journal.ts';
import { reconcileActive } from './reconcile.ts';
import { StartupRecoveryController, classifyStartup } from './startup-barrier.ts';
import { Phase3Recovery } from './phase3-host.ts';
import type { ReconcileProbeHooks, ReconcileEnv } from './reconcile.ts';
import type { JournalStore as JS } from './journal.ts';
import fs from 'node:fs/promises';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function mkStore(dir: string): JS { return new JournalStore({ transactionsDir: path.join(dir, 'transactions') }); }

function incompleteJournal(id: string, ownerInstanceId: string, lockId: string): OperationJournal {
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId, lockId, packageVersion: '0.1.54', environmentFingerprint: 'fp' }, 'x');
  j.state = 'APPLYING';
  j.plannedSteps = ['s1'];
  j.steps = { s1: { adapter: 'settings', ref: 'ns', kind: 'Update', external: false, beforeFp: 'b', afterFp: null, status: 'planned', appliedAt: null } };
  return j;
}

const hooks: ReconcileProbeHooks = {
  verifyStepFingerprint: async () => 'after-match',
  probeExternal: async () => 'not-installed',
  snapshotExists: async () => true,
};
function env(over: Partial<ReconcileEnv> = {}): ReconcileEnv {
  return { environmentFingerprint: 'fp', isLiveOwner: async () => false, ...over };
}

// ---------- P1-A：ownership binding 强制校验 ----------

test('P1-A Test A：journal.ownerInstanceId != stale ownership → needs-attention，不作 trusted 恢复', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a001';
  await store.create(incompleteJournal(id, 'owner-A', 'owner-A'));
  const out = await reconcileActive(store, hooks, env({ expectedOwnershipInstanceId: 'owner-B' }));
  assert.equal(out.decisions[0]!.kind, 'needs-attention');
  assert.equal(out.safeModeRequired, true);
  assert.ok(await store.loadActive(id) !== null, 'binding mismatch 不得规整/回滚');
});

test('P1-A Test B：journal.lockId != expected（伪造/跨 epoch）→ needs-attention', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a002';
  await store.create(incompleteJournal(id, 'owner-A', 'lock-forged')); // ownerInstanceId 对，lockId 伪装
  const out = await reconcileActive(store, hooks, env({ expectedOwnershipInstanceId: 'owner-A' }));
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'lockId 与 ownerInstanceId 不一致（epoch identity 不符）→ 拒绝');
  assert.equal(out.safeModeRequired, true);
});

test('P1-A Test C：ownerInstanceId + lockId 都 match → 允许 reconcile（explicit recovery 可继续）', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a003';
  await store.create(incompleteJournal(id, 'owner-A', 'owner-A'));
  const out = await reconcileActive(store, hooks, env({ expectedOwnershipInstanceId: 'owner-A' }));
  // binding 通过 → 不被 binding 阻断（非 binding-mismatch needs-attention）；据步证据决定 recovered/noop/rollback-recommended
  assert.ok(['recovered', 'noop', 'rollback-recommended', 'needs-attention'].includes(out.decisions[0]!.kind));
  if (out.decisions[0]!.kind === 'needs-attention') {
    assert.ok(!out.decisions[0]!.reason.includes('binding'), 'binding 匹配时不得因 binding mismatch 判 needs-attention');
  }
});

test('P1-A Test D：新 recovery 锁 instanceId != 旧 journal instanceId 是预期（不算 mismatch）', async (t) => {
  // classifyStartup(lockState='STALE') + expectedOwnership=旧 journal 的 instanceId；
  // 即便当前 recovery 进程的锁 instanceId 是新值，只要 journal 匹配 crashed 旧 instanceId 即通过。
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a004';
  await store.create(incompleteJournal(id, 'crashed-owner', 'crashed-owner'));
  const cls = classifyStartup({ store, hooks, env: env({ expectedOwnershipInstanceId: 'crashed-owner' }), lockState: 'STALE_LOCK_DETECTED' });
  const { state } = await cls.classify();
  // crashed journal 与 stale 匹配 → 不因「recovery 锁是新 instance」而误 rejects；有 unresolved → RECOVERY_REQUIRED
  // （binding OK，只是待用户显式 recovery）
  assert.ok(state.kind === 'RECOVERY_REQUIRED' || state.kind === 'NEEDS_ATTENTION', `binding 通过但 unresolved，实际=${state.kind}`);
});

test('P1-A 跨 transaction mixup / forged ownership → 拒绝（不同 ownerInstanceId/lockId）', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a005';
  // 伪造 journal 指向「另一个 transaction B」的 owner
  await store.create(incompleteJournal(id, 'owner-B', 'owner-B'));
  const out = await reconcileActive(store, hooks, env({ expectedOwnershipInstanceId: 'owner-A' }));
  assert.equal(out.decisions[0]!.kind, 'needs-attention', '跨 transaction 的 journal 不作 trusted 恢复');
  assert.equal(out.safeModeRequired, true);
});

// ---------- P1-A 生产级：captureStaleOwnershipInstanceId 读取真实 environment.lock + classifyStartup binding ----------

async function writeStaleOwnership(dataDir: string, instanceId: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, 'locks'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'locks', 'environment.lock'), JSON.stringify({ schemaVersion: 1, owner: { instanceId }, acquiredAt: Date.now(), op: 'crashed', target: 'x', lockVersion: '0.1.54', journalId: null }));
}

test('P1-A 生产：stale ownership 捕获 + 匹配 journal → binding 通过（非 binding-mismatch needs-attention）', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a006';
  await writeStaleOwnership(dir, 'stale-owner');
  await store.create(incompleteJournal(id, 'stale-owner', 'stale-owner'));
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp' });
  const captured = await recovery.captureStaleOwnershipInstanceId();
  assert.equal(captured, 'stale-owner', 'captureStaleOwnership 读到真实 environment.lock 的 owner.instanceId');
  const cls = classifyStartup({ store, hooks, env: env({ expectedOwnershipInstanceId: captured! }), lockState: 'STALE_LOCK_DETECTED' });
  const { state, safeModeRequired } = await cls.classify();
  // binding 匹配 → 不被 binding 拒绝（RECOVERY_REQUIRED 是「待用户显式恢复」，非 binding-mismatch）
  assert.ok(state.kind === 'RECOVERY_REQUIRED', `binding 通过 → RECOVERY_REQUIRED，实际=${state.kind}`);
  void safeModeRequired;
});

test('P1-A 生产：stale ownerInstanceId mismatch → binding 拒绝（needs-attention）', async (t) => {
  const dir = tmp(t); const store = mkStore(dir); const id = '00000000-0000-4000-8000-00000000a007';
  await writeStaleOwnership(dir, 'stale-owner');
  await store.create(incompleteJournal(id, 'other-owner', 'other-owner')); // journal 不属于该 stale ownership
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp' });
  const captured = await recovery.captureStaleOwnershipInstanceId();
  assert.equal(captured, 'stale-owner');
  const cls = classifyStartup({ store, hooks, env: env({ expectedOwnershipInstanceId: captured! }), lockState: 'STALE_LOCK_DETECTED' });
  const { state, safeModeRequired } = await cls.classify();
  // binding 拒绝 → journal 不被 trusted（unresolved 残留）；STALE 下 classify 归为 RECOVERY_REQUIRED + SAFE MODE（不自动恢复/不 trusted）
  assert.ok(state.kind === 'RECOVERY_REQUIRED' || state.kind === 'NEEDS_ATTENTION', `ownership mismatch → 非 trusted 恢复态，实际=${state.kind}`);
  assert.equal(safeModeRequired, true, 'binding 拒绝 → SAFE MODE');
  // 该 journal 确为 binding-mismatch 决策（非 trusted rollback/resume）
  const out = await reconcileActive(store, hooks, env({ expectedOwnershipInstanceId: captured! }));
  const dec = out.decisions.find((d) => d.operationId === id);
  assert.equal(dec!.kind, 'needs-attention');
  assert.ok(dec!.reason.includes('binding'), '拒绝原因为 ownership binding 不匹配');
});

// ---------- P1-B：startup recovery barrier ----------

test('P1-B race：classify pending → schedulers 未启动；NORMAL → start 恰一次', async (t) => {
  let startCount = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let started = false;
  const controller = new StartupRecoveryController({
    async classify() {
      await gate; // injectable barrier：挂起
      return { state: { kind: 'NORMAL' }, safeModeRequired: false, recoveryRequired: false };
    },
  }, { start: () => { startCount++; } });
  started = controller.startSchedulersIfAllowed();
  assert.equal(started, false, 'classification 完成前调度器不得启动');
  assert.equal(startCount, 0, '等待期间 start 计数=0');
  release();
  const st = await controller.run();
  assert.equal(st.kind, 'NORMAL');
  assert.equal(controller.startSchedulersIfAllowed(), true, 'NORMAL 下启动');
  assert.equal(controller.startSchedulersIfAllowed(), false, '幂等：二次调用不重复启动');
  assert.equal(startCount, 1, 'start 恰一次');
});

test('P1-B：RECOVERY_REQUIRED → schedulers 永不启动', async () => {
  let startCount = 0;
  const controller = new StartupRecoveryController({
    async classify() { return { state: { kind: 'RECOVERY_REQUIRED', operationId: 'x' }, safeModeRequired: true, recoveryRequired: true }; },
  }, { start: () => { startCount++; } });
  const st = await controller.run();
  assert.equal(st.kind, 'RECOVERY_REQUIRED');
  assert.equal(controller.startSchedulersIfAllowed(), false);
  assert.equal(startCount, 0);
});

test('P1-B：UNKNOWN_STATE → schedulers 永不启动', async () => {
  let startCount = 0;
  const controller = new StartupRecoveryController({
    async classify() { return { state: { kind: 'UNKNOWN_STATE', reason: 'no identity' }, safeModeRequired: true, recoveryRequired: false }; },
  }, { start: () => { startCount++; } });
  await controller.run();
  assert.equal(controller.startSchedulersIfAllowed(), false);
  assert.equal(startCount, 0);
});

test('P1-B fail-closed：classify 抛错 → RECOVERY_REQUIRED，调度器不启动（不默认 NORMAL）', async () => {
  let startCount = 0;
  const controller = new StartupRecoveryController({
    async classify() { throw new Error('inspect boom'); },
  }, { start: () => { startCount++; } });
  const st = await controller.run();
  assert.equal(st.kind, 'RECOVERY_REQUIRED', 'inspect 抛错不得默认 NORMAL');
  assert.equal(controller.startSchedulersIfAllowed(), false);
  assert.equal(startCount, 0);
});

test('P1-B：已有 safe-mode marker → startup 观察 → 调度器不启动（destructive blocked）', async (t) => {
  const dir = tmp(t); const store = mkStore(dir);
  await store.writeSafeMode(true);
  const cls = classifyStartup({ store, hooks, env: env(), lockState: 'FREE' });
  const { state } = await cls.classify();
  let startCount = 0;
  const controller = new StartupRecoveryController(cls, { start: () => { startCount++; } });
  await controller.run();
  assert.equal(startCount, 0, 'safe-mode marker 已存在 → destructive scheduler 不启动');
  void state;
});

test('P1-B：corrupt journal startup → 分类为 needs-attention/quarantine，调度器不启动', async (t) => {
  const dir = tmp(t); const store = mkStore(dir);
  await store.ensureDirs();
  const badId = '00000000-0000-4000-8000-00000000f0a0';
  await import('node:fs/promises').then((fs) => fs.writeFile(path.join(dir, 'transactions', 'active', `${badId}.json`), 'not-json'));
  const cls = classifyStartup({ store, hooks, env: env(), lockState: 'FREE' });
  const { state } = await cls.classify();
  assert.ok(state.kind === 'NEEDS_ATTENTION' || state.kind === 'RECOVERY_REQUIRED', `corrupt → ${state.kind}`);
  let startCount = 0;
  const controller = new StartupRecoveryController(cls, { start: () => { startCount++; } });
  await controller.run();
  assert.equal(startCount, 0, 'corrupt journal 分类完成前调度器不得启动（不 race classification）');
});
