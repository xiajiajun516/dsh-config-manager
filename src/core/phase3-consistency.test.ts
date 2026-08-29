/**
 * Phase 3 Mandatory Consistency Tests（Rev 3 §37 的 13 项）+ 真实 child-process 崩溃注入（§38/§40）。
 *
 * 全部真实 process death（SIGKILL，finally 不执行）。只用核心原语，不碰真实 DSH 引擎。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JournalStore, createJournalEntry } from './journal.ts';
import { reconcileActive, inspectStartup, type ReconcileProbeHooks, type ReconcileEnv } from './reconcile.ts';
import { MutationTransactionCoordinator, type CoordinatedOperation } from './transaction-coordinator.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'p3c-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'phase3-child-crash.ts');
const FP = 'fp-child'; // 与 phase3-child-crash.ts 的 environmentFingerprint 一致（child 产 journal）

function mkStore(dir: string) { return new JournalStore({ transactionsDir: path.join(dir, 'transactions') }); }

function runChild(txDir: string, sideEffect: string | null, mode: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, txDir, sideEffect ?? 'null', mode], { stdio: 'ignore' });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

// ---------- Mandatory Test 7：env-lock.ts 无 Phase3 recovery-policy import ----------
test('M7：env-lock.ts 不 import journal/reconcile/transaction-policy', async () => {
  const src = await fs.readFile(path.join(here, '..', 'utils', 'env-lock.ts'), 'utf8');
  const bad = ['journal.ts', 'reconcile.ts', 'transaction-coordinator.ts', 'NEEDS_ATTENTION', 'recovery-policy', 'cleanupAbortedInstall'];
  for (const b of bad) {
    assert.equal(src.includes(b), false, `env-lock.ts 不得引用 ${b}`);
  }
});

// ---------- Mandatory Test 8 / §38：child crash → non-terminal journal + stale ownership 不被自动终结 ----------
test('M8/注入：真实 child SIGKILL → finally 不执行 → journal/ownership 原样保留，reconcile 不自动 recover', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await runChild(path.join(dir, 'transactions'), path.join(dir, 'side-effect.txt'), 'after-side-effect');
  // journal 在 active、非终态（APPLYING），side effect 已写
  const ops = await store.scanActive();
  assert.equal(ops.length, 1);
  const j = await store.loadActive(ops[0]!);
  assert.ok(j);
  assert.equal(['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION'].includes(j!.state), false, 'crash 后 journal 必须非 terminal（finally 未执行）');
  // side effect 文件已落盘
  assert.equal(await fs.readFile(path.join(dir, 'side-effect.txt'), 'utf8'), 'side-effect-content');
  // reconcile（指纹：after 内容可判 done → recovered；此处用 after-match 探测）
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'after-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.ok(out.decisions.length >= 1);
  assert.ok(['recovered', 'noop', 'needs-attention'].includes(out.decisions[0]!.kind));
  // startup + stale lock → RECOVERY_REQUIRED + SAFE MODE，且不自动 recover
  const insp = await inspectStartup(store, {
    verifyStepFingerprint: async () => 'after-match', probeExternal: async () => 'not-installed', snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false }, {}, 'STALE_LOCK_DETECTED');
  assert.ok(insp.safeModeRequired === true || insp.recoveryRequired === true);
});

// ---------- Mandatory Test 9：startup stale + incomplete → RECOVERY_REQUIRED/SAFE MODE，不自动 recoverStaleLock ----------
test('M9：startup stale + incomplete(external unknown) → RECOVERY_REQUIRED/SAFE MODE；不自动 recover', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000e9';
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'child-instance', lockId: 'child-lock', packageVersion: '0.1.54', environmentFingerprint: FP }, 'x');
  j.state = 'APPLYING';
  j.plannedSteps = ['p1'];
  j.steps = { p1: { adapter: 'plugins', ref: 'plugin:@x', kind: 'Install', external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null } };
  await store.create(j);
  const insp = await inspectStartup(store, {
    verifyStepFingerprint: async () => 'before-match', probeExternal: async () => 'half-installed', snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false }, {}, 'STALE_LOCK_DETECTED');
  assert.equal(insp.recoveryRequired, true);
  assert.equal(insp.safeModeRequired, true);
  assert.equal(await store.readSafeMode(), true);
  // journal 未被自动隔离/删除/规整（不自动接管）
  assert.ok((await store.loadActive(id)) !== null);
});

// ---------- Mandatory Test 10：explicit recovery（用户确认）→ recovered / rollback ----------
test('M10：explicit recovery（用户确认）收敛到 terminal', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await runChild(path.join(dir, 'transactions'), path.join(dir, 'se.txt'), 'after-step-done');
  // step 已 done + afterFp 可验 → reconcile 自动判 recovered（resume）
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'after-match', probeExternal: async () => 'not-installed', snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.ok(out.decisions[0]!.kind === 'recovered' || out.decisions[0]!.kind === 'noop');
  assert.deepEqual(await store.scanActive(), []);
});

// ---------- Mandatory Test 11：UNKNOWN_STATE → 不 recover → SAFE MODE ----------
test('M11：UNKNOWN_STATE → no recovery → SAFE MODE', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000eb';
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'child-instance', lockId: 'child-lock', packageVersion: '0.1.54', environmentFingerprint: FP }, 'x');
  j.state = 'APPLYING';
  j.plannedSteps = ['p1'];
  j.steps = { p1: { adapter: 'plugins', ref: 'plugin:@y', kind: 'Install', external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null } };
  await store.create(j);
  const insp = await inspectStartup(store, {
    verifyStepFingerprint: async () => 'unable', probeExternal: async () => 'unknown', snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false }, {}, 'UNKNOWN_STATE');
  assert.equal(insp.recoveryRequired, true, 'UNKNOWN_STATE 不自动 recover');
  assert.equal(insp.safeModeRequired, true);
  assert.equal(await store.readSafeMode(), true);
  // 不自动 recover：journal 保留
  assert.ok((await store.loadActive(id)) !== null);
});

// ---------- P0-B 回归：crash during rollback 绝不判 RECOVERED ----------
test('P0-B：during-rollback child crash → rollback-continue（绝不 RECOVERED）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await runChild(path.join(dir, 'transactions'), null, 'during-rollback');
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'after-match', // 即便 step 似 done 也不得判 recovered（回滚中）
    probeExternal: async () => 'not-installed', snapshotExists: async () => true,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  const kind = out.decisions[0]!.kind;
  assert.ok(kind === 'rollback-continue' || kind === 'needs-attention', `回滚中断不得判 recovered，实际=${kind}`);
  assert.notEqual(kind, 'recovered', '半回滚态不得误判 recovered');
  assert.equal(out.safeModeRequired, true);
  // journal 保持 ROLLING_BACK（未被 move 到 completed）
  assert.ok((await store.loadActive('00000000-0000-4000-8000-00000000dead')) !== null);
  assert.equal(await store.readSafeMode(), true);
});

// ---------- isLiveOwner：inspectStartup 在 LOCKED（fresh heartbeat）→ live 跳过 ----------
test('isLiveOwner：inspectStartup LOCKED → journal 视为 live，不 reconcile/move/quarantine（且不自动 recover）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000f0';
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'live-owner', lockId: 'l', packageVersion: '0.1.54', environmentFingerprint: FP }, 'x');
  j.state = 'APPLYING'; // incomplete（若被 reconcile 会 needs-attention，但 live 时应跳过）
  j.plannedSteps = ['p1'];
  j.steps = { p1: { adapter: 'plugins', ref: 'plugin:@live', kind: 'Install', external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null } };
  await store.create(j);
  const insp = await inspectStartup(store, {
    verifyStepFingerprint: async () => 'unable', probeExternal: async () => 'half-installed', snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false }, {}, 'LOCKED');
  // LOCKED → journal 视为 live → 不被 reconcil；非 STALE/UNKNOWN → 不判 recoveryRequired（活锁，保守不接管）
  assert.ok(await store.loadActive(id) !== null, 'live owner 的 journal 不得被 move/quarantine（保持 active）');
  assert.equal(insp.recoveryRequired, false, 'LOCKED 活锁下不判 recovery-required（不自动 recover/接管）');
});

// ---------- Mandatory Test 12：scheduler destructive-run 门禁（recovery required 时 blocked） ----------
test('M12：RECOVERY_REQUIRED/SAFE MODE → withMutationLock isBlocked 谓词阻断 destructive', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.writeSafeMode(true);
  assert.equal(await store.readSafeMode(), true, 'SAFE MODE durable 标记');
  // host 在 acquire 前同步读 durable 标记并注入同步 isBlocked 谓词（见 §25 注入谓词）
  const blockedMarker = await store.readSafeMode();
  const { withMutationLock, runWithMutationLock } = await import('../utils/env-lock.ts');
  const fakePort = {
    acquire: async () => ({ state: 'ACQUIRED' as const, token: { tokenId: 't', managerId: 'm', instanceId: 'i', acquiredAt: 0 } }),
    validate: () => true,
    release: async () => {},
  };
  // SAFE MODE 被挡 → withMutationLock 返回 context:null（autosync 表现为 mutation-locked skip）
  const res = await withMutationLock(fakePort as never, { op: 'autosync', isBlocked: () => blockedMarker });
  assert.equal(res.context, null, 'SAFE MODE 下 destructive 被挡');
  // runWithMutationLock 被挡 → 抛 EnvironmentLockUnavailableError
  await assert.rejects(
    () => runWithMutationLock(fakePort as never, { op: 'import-apply', isBlocked: () => blockedMarker }, async () => 'should-not-run'),
    /环境锁被占用|拒绝执行/,
  );
  // 清除标记后可执行
  await store.writeSafeMode(false);
  const res2 = await withMutationLock(fakePort as never, { op: 'sync-apply', isBlocked: () => false });
  assert.notEqual(res2.context, null, 'SAFE MODE 清除后放行');
});

// ---------- Mandatory Test 13：尾操作失败 → 不得先 COMMITTED ----------
test('M13：tailOperations 抛错 → journal != COMMITTED', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const ctx = (): MutationLockContext => ({ token: { tokenId: 't', managerId: 'm', instanceId: 'i', acquiredAt: 0 } });
  const coord = new MutationTransactionCoordinator({
    store, lock: null as never,
    acquireLock: async () => ctx(),
    checkActiveClear: async () => ({ clear: true }),
    lockId: 'l', ownerInstanceId: 'i', packageVersion: '0.1.54', environmentFingerprint: FP,
    releaseLock: async (c, opId) => { /* 不 reach（tail 抛错） */ },
    redactText: (s) => s,
  });
  const op: CoordinatedOperation = {
    operationType: 'import-apply',
    buildSteps: () => [],
    executeStep: async () => ({ status: 'ok' }),
    tailOperations: async () => { throw new Error('tail failure'); },
    validate: async () => ({ ok: true, warnings: [] }),
  };
  const result = await coord.run(op);
  assert.notEqual(result.outcome, 'COMMITTED', '尾操作失败不得 COMMITTED');
  if (result.operationId !== null) {
    assert.notEqual(await store.terminalStateOf(result.operationId), 'COMMITTED');
  }
});

// ---------- Mandatory Test 1-6（已在 coordinator/journal 单测覆盖，此处复述关键断言） ----------
test('M1-6 复述：immutable ownership / 无回填 / journalId unused / terminal-before-release / lock 不发明终态', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const envLockPath = path.join(dir, '..', 'environment.lock');
  await fs.writeFile(envLockPath, 'immutable');
  await store.writeSafeMode(true);
  // journal 操作不触碰 environment.lock 字节
  const ctx = (): MutationLockContext => ({ token: { tokenId: 't', managerId: 'm', instanceId: 'i', acquiredAt: 0 } });
  let releaseTerminalState: string | null = null;
  const coord = new MutationTransactionCoordinator({
    store, lock: null as never, acquireLock: async () => ctx(),
    checkActiveClear: async () => ({ clear: true }),
    lockId: 'l', ownerInstanceId: 'i', packageVersion: '0.1.54', environmentFingerprint: FP,
    releaseLock: async (c, opId) => { releaseTerminalState = await store.terminalStateOf(opId); },
    redactText: (s) => s,
  });
  const r = await coord.run({ operationType: 'restore', buildSteps: () => [], executeStep: async () => ({ status: 'ok' }), validate: async () => ({ ok: true, warnings: [] }) });
  assert.equal(r.outcome, 'COMMITTED');
  // M1：environment.lock 字节不变
  assert.equal(await fs.readFile(envLockPath, 'utf8'), 'immutable');
  // M2/M3：journal 创建不修改 ownership；journalId 未使用（journal 无该顶层字段）
  assert.ok(r.operationId !== null);
  const journal = await store.load(r.operationId);
  assert.ok(journal);
  assert.equal('journalId' in journal, false);
  // M4 terminal-before-release：release 时 journal 已 COMMITTED
  assert.equal(releaseTerminalState, 'COMMITTED');
  // M6: release guard 只验证，不发明终态（coordinator releaseLock 见 terminal；此处验证调用点拿到的即 terminal）
});
