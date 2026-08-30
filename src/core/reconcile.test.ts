/**
 * Phase 3 Reconciler 单测（node:test，零依赖）。
 * 覆盖：corrupt→quarantine、env 不匹配、terminal 遗留→organized、all-done→recovered、
 * no-apply→noop、external half-install→needs-attention、live owner 跳过、startup
 * stale→RECOVERY_REQUIRED(不自动 recover)、executeRecovery 无确认无副作用、幂等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JournalStore, createJournalEntry, type OperationJournal, type JournalStep } from './journal.ts';
import {
  reconcileActive, executeRecovery, inspectStartup, recomputeRecoveryDecision,
  type ReconcileProbeHooks, type ReconcileEnv,
} from './reconcile.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FP = 'fp-rec';
function mkStore(dir: string) { return new JournalStore({ transactionsDir: path.join(dir, 'transactions') }); }

function op(id: string, state?: OperationJournal['state']): OperationJournal {
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.54', environmentFingerprint: FP }, '2026-01-01T00:00:00.000Z');
  if (state !== undefined) j.state = state;
  return j;
}

function fileStep(status: JournalStep['status']): JournalStep {
  return { adapter: 'skills', ref: 'a.md', kind: 'Update', external: false, beforeFp: 'before', afterFp: 'after-a.md', status, appliedAt: null };
}
function extStep(status: JournalStep['status']): JournalStep {
  return { adapter: 'plugins', ref: 'plugin:@x', kind: 'Install', external: true, beforeFp: null, afterFp: null, status, appliedAt: null };
}

function hooks(over: Partial<ReconcileProbeHooks> = {}): ReconcileProbeHooks {
  return {
    verifyStepFingerprint: async (s) => (s.status === 'done' ? 'after-match' : 'before-match'),
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => true,
    ...over,
  };
}
const env: ReconcileEnv = { environmentFingerprint: FP, isLiveOwner: async () => false };

// ---------- 决策测试 ----------

test('corrupt journal → quarantine + SAFE MODE', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.ensureDirs();
  const badId = '00000000-0000-4000-8000-0000000000c1';
  await fs.writeFile(path.join(dir, 'transactions', 'active', `${badId}.json`), 'not-json{{{');
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'corrupt');
  assert.equal(out.safeModeRequired, true);
  assert.equal(await store.readSafeMode(), true);
  // 已隔离
  assert.ok((await fs.readdir(path.join(dir, 'transactions', 'quarantine'))).length > 0);
  assert.deepEqual(await store.scanActive(), []);
});

test('environment 不匹配 → env-mismatch / SAFE MODE（不恢复）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c2';
  await store.create({ ...op(id, 'APPLYING'), environmentFingerprint: 'OTHER-MACHINE' });
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'env-mismatch');
  assert.equal(out.safeModeRequired, true);
});

test('terminal 遗留 active → organized（move 到 completed，无实质 recovery）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c3';
  await store.create(op(id, 'CREATED'));
  await store.update(id, (j) => ({ ...j, state: 'COMMITTED' }));
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'organized');
  assert.equal(out.safeModeRequired, false);
  assert.deepEqual(await store.scanActive(), []);
});

test('所有 step 已 done（afterFp 确认）→ recovered（resume 不重做）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c4';
  const j = op(id, 'APPLYING');
  j.plannedSteps = ['s1'];
  j.steps = { s1: fileStep('done') };
  await store.create(j);
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'recovered');
  assert.equal((await store.load(id))?.state, 'RECOVERED');
  assert.deepEqual(await store.scanActive(), []);
});

test('外部 half-installed → needs-attention / SAFE MODE（绝不自动 cleanup）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c5';
  const j = op(id, 'APPLYING');
  j.plannedSteps = ['p1'];
  j.steps = { p1: extStep('planned') };
  await store.create(j);
  const out = await reconcileActive(store, { verifyStepFingerprint: async () => 'before-match', probeExternal: async () => 'half-installed', snapshotExists: async () => true }, env);
  assert.equal(out.decisions[0]!.kind, 'needs-attention');
  assert.equal(out.safeModeRequired, true);
});

test('no step applied（全 beforeFp）→ noop（安全丢弃）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c6';
  const j = op(id, 'APPLYING');
  j.plannedSteps = ['s1'];
  j.steps = { s1: fileStep('planned') }; // verifyStepFingerprint 默认 before-match
  await store.create(j);
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'noop');
  assert.equal(out.safeModeRequired, false);
});

test('live owner → live 跳过（不 reconcile/quarantine/move）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c7';
  const j = op(id, 'APPLYING');
  await store.create(j);
  const out = await reconcileActive(store, hooks(), { environmentFingerprint: FP, isLiveOwner: async (j2) => j2.operationId === id });
  assert.equal(out.decisions[0]!.kind, 'live');
  assert.equal(out.safeModeRequired, false);
  assert.ok((await store.loadActive(id)) !== null, 'live journal 不被 move/隔离');
});

test('startup：stale lock + incomplete → RECOVERY_REQUIRED / SAFE MODE，不自动 recover', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c8';
  const j = op(id, 'APPLYING');
  j.steps = { s1: extStep('planned') };
  await store.create(j);
  const insp = await inspectStartup(store, { verifyStepFingerprint: async () => 'before-match', probeExternal: async () => 'half-installed', snapshotExists: async () => true }, env, {}, 'STALE_LOCK_DETECTED');
  assert.equal(insp.recoveryRequired, true);
  assert.equal(insp.safeModeRequired, true);
  assert.equal(await store.readSafeMode(), true);
  // 不能自动 recoverStaleLock：断言 active journal 仍原样（未被删除/隔离/规整）
  assert.ok((await store.loadActive(id)) !== null);
});

test('executeRecovery：rollback 无用户确认 → needs-confirmation（零副作用）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000c9';
  const j = op(id, 'APPLYING'); j.snapshotId = 'snap-1'; await store.create(j);
  let rollbackRan = false;
  const r = await executeRecovery(store, { operationId: id, action: 'rollback', snapshotId: 'snap-1', performRollback: async () => { rollbackRan = true; return { full: true, failed: [] }; } }, false);
  assert.equal(r, 'needs-confirmation');
  assert.equal(rollbackRan, false, '无确认不得执行破坏性回滚');
});

test('executeRecovery：有确认 → RECOVERING（终态由 verify 原子完成，不自行 ROLLED_BACK）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000ca';
  const j = op(id, 'NEEDS_ATTENTION'); j.snapshotId = 'snap-1'; await store.create(j);
  let rollbackRan = false;
  const r = await executeRecovery(store, { operationId: id, action: 'rollback', snapshotId: 'snap-1', performRollback: async () => { rollbackRan = true; return { full: true, failed: [] }; } }, true);
  assert.equal(r, 'done');
  assert.equal(rollbackRan, true);
  // §7.1：recovery 全程保持 RECOVERING（不引入 ROLLING_BACK）；终态迁移 + verification 写入
  // 由 verify 路由以单次原子 journal update 完成。此处绝不自行转 ROLLED_BACK。
  assert.equal((await store.load(id))?.state, 'RECOVERING');
  assert.ok((await store.loadActive(id)) !== null, 'RECOVERING journal 仍 active（待 verify）');
});

// ---------- 幂等 ----------

test('reconcile 幂等：重复运行稳定，不重复副作用', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000cb';
  const j = op(id, 'APPLYING');
  j.plannedSteps = ['s1']; j.steps = { s1: fileStep('done') };
  await store.create(j);
  await reconcileActive(store, hooks(), env);
  await reconcileActive(store, hooks(), env);
  await reconcileActive(store, hooks(), env);
  // recovered 后已规整；再跑无 active
  assert.deepEqual(await store.scanActive(), []);
  assert.equal((await store.load(id))?.state, 'RECOVERED');
});

// ---------- F20：空 steps（opaque intent journal）不得判 RECOVERED ----------

test('F20：APPLYING + 空 steps + 无 snapshot → NEEDS_ATTENTION（非 RECOVERED）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000cc';
  const j = op(id, 'APPLYING'); // 默认 plannedSteps=[] steps={} snapshotId=null
  await store.create(j);
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'needs-attention', '空 steps + APPLYING 不得判 recovered/noop');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await store.load(id))?.state, 'NEEDS_ATTENTION');
});

test('F20：APPLYING + 空 steps + trusted snapshot → rollback-recommended', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000cd';
  const j = op(id, 'APPLYING'); j.snapshotId = 'snap-1';
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.equal(out.decisions[0]!.kind, 'rollback-recommended', '有 trusted snapshot 应推荐回滚');
  assert.equal(out.safeModeRequired, true);
});

test('F20：CREATED + 空 steps → noop（mutation 未开始，安全）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000ce';
  const j = op(id, 'CREATED'); // 默认空 steps
  await store.create(j);
  const out = await reconcileActive(store, hooks(), env);
  assert.equal(out.decisions[0]!.kind, 'noop', 'CREATED + 空 steps 无 mutation，安全 noop');
  assert.equal(out.safeModeRequired, false);
  assert.equal((await store.load(id))?.state, 'RECOVERED');
});

// ---------- §6.5 recovery hard gate ----------

test('§6.5：RECOVERING + 无 recoveryVerification → needs-attention（绝不自动 RECOVERED）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d1';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'RECOVERING + 待验证绝不自动 RECOVERED');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await store.load(id))?.state, 'NEEDS_ATTENTION');
});

test('§6.5：RECOVERING + MISMATCH verification → needs-attention（不 COMMITTED）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d2';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  j.recoveryVerification = { verdict: 'MISMATCH', details: ['host file 残留'], manualHints: [], at: '2026-01-01T00:00:00.000Z' };
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'verdict 非 MATCH/PARTIAL_MATCH → needs-attention');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await store.load(id))?.state, 'NEEDS_ATTENTION');
});

test('§6.5：RECOVERING + MATCH verification → 不触发门控（可 proceed）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d3';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  j.recoveryVerification = { verdict: 'MATCH', details: ['all match'], manualHints: [], at: '2026-01-01T00:00:00.000Z' };
  j.plannedSteps = ['s1']; j.steps = { s1: fileStep('done') };
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.notEqual(out.decisions[0]!.kind, 'needs-attention', 'MATCH verification 不触发硬门控');
  assert.equal(out.decisions[0]!.kind, 'recovered', '已验证 RECOVERING 可 proceed 到 terminal');
});

test('§6.5：RECOVERING + PARTIAL_MATCH verification → 不触发门控（可 proceed）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d9';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  j.recoveryVerification = { verdict: 'PARTIAL_MATCH', details: ['核心匹配，凭据不可验证'], manualHints: ['凭据需人工确认'], at: '2026-01-01T00:00:00.000Z' };
  j.plannedSteps = ['s1']; j.steps = { s1: fileStep('done') };
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.notEqual(out.decisions[0]!.kind, 'needs-attention', 'PARTIAL_MATCH verification 不触发硬门控');
  assert.equal(out.decisions[0]!.kind, 'recovered', 'PARTIAL_MATCH 已验证可 proceed 到 terminal');
});

test('§6.5：RECOVERING + VERIFICATION_ERROR verification → needs-attention（不 COMMITTED）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000da';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  j.recoveryVerification = { verdict: 'VERIFICATION_ERROR', details: ['快照重验失败'], manualHints: [], at: '2026-01-01T00:00:00.000Z' };
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.equal(out.decisions[0]!.kind, 'needs-attention', 'VERIFICATION_ERROR → needs-attention（绝不自动 RECOVERED）');
  assert.equal(out.safeModeRequired, true);
  assert.equal((await store.load(id))?.state, 'NEEDS_ATTENTION');
});

test('§6.5：RECOVERING + entryDone 非空 → rollback-continue（门控之前，续跑中断回滚）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d4';
  const j = op(id, 'RECOVERING'); j.snapshotId = 'snap-1';
  j.rollback.entryDone = { 0: true };
  await store.create(j);
  const out = await reconcileActive(store, hooks({ snapshotExists: async () => true }), env);
  assert.equal(out.decisions[0]!.kind, 'rollback-continue', 'entryDone 非空 → 续跑中断回滚（不违反 VERIFIED）');
});

// ---------- recomputeRecoveryDecision（§5.4） ----------

test('recomputeRecoveryDecision：entryDone 非空 → rollback-continue', async (t) => {
  const j = op('00000000-0000-4000-8000-0000000000d5', 'NEEDS_ATTENTION');
  j.rollback.entryDone = { 0: true };
  const d = await recomputeRecoveryDecision(j, { snapshotExists: async () => true });
  assert.equal(d, 'rollback-continue');
});

test('recomputeRecoveryDecision：snapshotId 合法且存在 → rollback-recommended', async (t) => {
  const j = op('00000000-0000-4000-8000-0000000000d6', 'NEEDS_ATTENTION');
  j.snapshotId = 'snap-1';
  const d = await recomputeRecoveryDecision(j, { snapshotExists: async () => true });
  assert.equal(d, 'rollback-recommended');
});

test('recomputeRecoveryDecision：无 entryDone / 快照缺失 → needs-attention', async (t) => {
  const j = op('00000000-0000-4000-8000-0000000000d7', 'NEEDS_ATTENTION');
  j.snapshotId = 'snap-1';
  const d = await recomputeRecoveryDecision(j, { snapshotExists: async () => false });
  assert.equal(d, 'needs-attention');
});

test('recomputeRecoveryDecision：只读，不修改 journal / 不写 SAFE MODE', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d8';
  const j = op(id, 'NEEDS_ATTENTION'); j.snapshotId = 'snap-1';
  await store.create(j);
  const before = await store.load(id);
  await recomputeRecoveryDecision(before!, { snapshotExists: async () => true });
  const after = await store.load(id);
  assert.deepEqual(after, before, 'recomputeRecoveryDecision 不得修改 journal');
  assert.equal(await store.readSafeMode(), false, '不得写 SAFE MODE');
});

// ---------- executeRecovery 引擎路由（§5.2） ----------

test('executeRecovery：rollback-recommended → 调 restore executor（不调 rollback executor）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000d9';
  const j = op(id, 'NEEDS_ATTENTION'); j.snapshotId = 'snap-1'; await store.create(j);
  let restoreRan = false; let rollbackRan = false;
  const r = await executeRecovery(store, {
    operationId: id, action: 'rollback', snapshotId: 'snap-1', decision: 'rollback-recommended',
    performRestore: async () => { restoreRan = true; return { full: true, failed: [] }; },
    performRollback: async () => { rollbackRan = true; return { full: true, failed: [] }; },
  }, true);
  assert.equal(r, 'done');
  assert.equal(restoreRan, true, 'rollback-recommended 应调 restore executor');
  assert.equal(rollbackRan, false, '不得混用 rollback executor');
  assert.equal((await store.load(id))?.state, 'RECOVERING', 'NEEDS_ATTENTION → RECOVERING');
});

test('executeRecovery：rollback-continue（缺省）→ 调 rollback executor', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000da';
  const j = op(id, 'NEEDS_ATTENTION'); j.snapshotId = 'snap-1'; await store.create(j);
  let rollbackRan = false;
  const r = await executeRecovery(store, {
    operationId: id, action: 'rollback', snapshotId: 'snap-1',
    performRollback: async () => { rollbackRan = true; return { full: true, failed: [] }; },
  }, true);
  assert.equal(r, 'done');
  assert.equal(rollbackRan, true, '缺省 decision 走 rollback executor');
  assert.equal((await store.load(id))?.state, 'RECOVERING');
});

test('executeRecovery：rollback 无 executor → failed（不执行）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const id = '00000000-0000-4000-8000-0000000000db';
  const j = op(id, 'NEEDS_ATTENTION'); j.snapshotId = 'snap-1'; await store.create(j);
  const r = await executeRecovery(store, { operationId: id, action: 'rollback', snapshotId: 'snap-1' }, true);
  assert.equal(r, 'failed');
  assert.equal((await store.load(id))?.state, 'NEEDS_ATTENTION', '无 executor 不得迁移状态');
});
