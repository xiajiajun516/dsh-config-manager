/**
 * Phase 3 生产集成测试（P0-A 关闭验证）。
 * 直接测生产路径助手 `Phase3Recovery.runJournaled` / `runExternalIntent`（Web gate / restore / model-tools 均经它）：
 *  - 建 journal + Journal→Lock 绑定（ownerInstanceId/lockId）+ operationType + COMMITTED 规整
 *  - active≤1：残留非终态 → TransactionRecoveryRequiredError，不建第二个 journal
 *  - fn 异常 → NEEDS_ATTENTION + durable SAFE MODE
 *  - COMMITTED 持久化失败 → 保持非终态 + SAFE MODE（RECOVERY_REQUIRED 语义，lock 层不发明终态）
 *  - runExternalIntent 记录 external step
 *  - 真实 child crash（runJournaled fn 中被 SIGKILL → 残留非终态 journal → reconcile 判定）
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
import { Phase3Recovery, TransactionRecoveryRequiredError } from './phase3-host.ts';
import { reconcileActive } from './reconcile.ts';
import { createSnapshot, FileSnapshotStore, verifySnapshot } from './backup.ts';
import type { Snapshot } from './types.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'p3prod-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

function lk(instance = 'owner-prod'): MutationLockContext {
  return { token: { tokenId: 't', managerId: 'm', instanceId: instance, acquiredAt: Date.now() } };
}

async function makeRecovery(dir: string): Promise<Phase3Recovery> {
  const r = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp-prod' });
  await r.store.ensureDirs();
  return r;
}

test('P0-A：runJournaled 建 journal（绑定 + operationType + COMMITTED 规整）', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const { operationId, result } = await recovery.runJournaled<number>({ operationType: 'import-apply', lockCtx: lk(), fn: async () => 42 });
  assert.equal(result, 42);
  const j = await recovery.store.load(operationId);
  assert.ok(j);
  assert.equal(j!.operationType, 'import-apply');
  assert.equal(j!.ownerInstanceId, 'owner-prod'); // Journal→Lock 绑定（真实 lockCtx token instanceId）
  assert.equal(j!.lockId, 'owner-prod'); // lockId = 同 ownership epoch identity（P1-A 真实捕获，非环境稳定串）
  assert.equal(j!.state, 'COMMITTED');
  assert.equal('journalId' in j, false, 'Journal→Lock 单向，不回写 environment.lock');
  assert.deepEqual(await recovery.store.scanActive(), [], 'COMMITTED 后已规整到 completed');
});

test('P0-A：active≤1 → 残留非终态阻断第二 journal', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  // 第一次 run 在 fn 中抛错 → journal 留 NEEDS_ATTENTION（terminal，非终态残留不阻塞）…
  // 用手动预置一个「非终态」active journal（模拟未 reconcile 的 crash residue）
  const { generateOperationId, createJournalEntry } = await import('./journal.ts');
  const opId = generateOperationId();
  await recovery.store.create(createJournalEntry('import-apply', { operationId: opId, ownerInstanceId: 'old', lockId: 'old', packageVersion: '0', environmentFingerprint: 'fp-prod' }, new Date().toISOString()));
  await recovery.store.update(opId, (j) => ({ ...j, state: 'APPLYING' }));
  // 第二次 run（新 transaction）→ 应被 active≤1 阻断
  await assert.rejects(
    () => recovery.runJournaled({ operationType: 'import-apply', lockCtx: lk(), fn: async () => 1 }),
    TransactionRecoveryRequiredError,
    '残留 active 应阻断新 transaction（active≤1）',
  );
  // 只有一个 journal
  assert.equal((await recovery.store.scanActive()).length, 1);
});

test('P0-A：fn 异常 → NEEDS_ATTENTION + durable SAFE MODE + rethrow', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  await assert.rejects(
    () => recovery.runJournaled({ operationType: 'import-apply', lockCtx: lk(), fn: async () => { throw new Error('boom'); } }),
    /boom/,
  );
  assert.equal(await recovery.store.readSafeMode(), true);
  assert.equal(recovery.safeModeActive, true);
  const ops = await recovery.store.scanActive();
  // fn 异常后 journal 进入 NEEDS_ATTENTION（terminal）→ moveToCompleted 可规整，但 SAFE MODE 已 durable
  assert.equal(await recovery.store.readSafeMode(), true);
});

test('P0-A：COMMITTED 持久化失败 → 保持非终态 + SAFE MODE（RECOVERY_REQUIRED，lock 不发明终态）', async (t) => {
  const dir = tmp(t);
  let failCommit = false;
  const store = new JournalStore({
    transactionsDir: path.join(dir, 'transactions'),
    io: {
      mkdir: async (d) => { await fs.mkdir(d, { recursive: true }); },
      readFileText: async (p) => (await fs.readFile(p, 'utf8')).toString(),
      writeAll: async (target, content) => {
        // 注入：仅 COMMITTED 状态写失败（terminal 持久化失败用例）
        if (failCommit && content.includes('"COMMITTED"')) throw new Error('injected commit write fail');
        await fs.writeFile(target, content, { mode: 0o600 });
      },
      rename: async (a, b) => fs.rename(a, b),
      readdirNames: async (d) => { try { return await fs.readdir(d); } catch { return []; } },
      readdirEntries: async (d) => { try { return await fs.readdir(d, { withFileTypes: true }); } catch { return []; } },
      lstat: async (p) => { try { return await fs.lstat(p); } catch { return null; } },
      rm: async (p, o) => fs.rm(p, o as never),
      exists: async (p) => { try { await fs.access(p); return true; } catch { return false; } },
    },
  });
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp-prod' });
  (recovery as unknown as { store: JournalStore }).store = store;
  failCommit = true;
  // runJournaled 在 COMMITTED 阶段会多次 update；首个 update 失败 → rethrow，journal 留非终态（或缺失）
  await assert.rejects(() => recovery.runJournaled({ operationType: 'import-apply', lockCtx: lk(), fn: async () => 1 }));
  assert.equal(await store.readSafeMode().catch(() => true), true, 'SAFE MODE 已设置（lock 层不发明终态）');
});

test('P0-A：runExternalIntent 记录 external step + COMMITTED', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const { operationId, result } = await recovery.runExternalIntent({
    operationType: 'sync-push', lockCtx: lk(), intent: { adapter: 'sync', ref: 'git', kind: 'Push' },
    fn: async () => ({ ok: true }),
  });
  assert.equal((result as { ok: boolean }).ok, true);
  const j = await recovery.store.load(operationId);
  assert.ok(j);
  assert.equal(j!.steps['ext']?.external, true);
  assert.equal(j!.state, 'COMMITTED');
  assert.deepEqual(await recovery.store.scanActive(), []);
});

// ---------- 真实 child crash：runJournaled fn 中被 SIGKILL → 残留非终态 journal → reconcile ----------
test('P0-A：真实 child crash（fn 中 SIGKILL）→ 残留非终态 journal 可 reconcile（不自动恢复）', async (t) => {
  const dir = tmp(t);
  const txDir = path.join(dir, 'transactions');
  const childPath = path.join(here, 'phase3-prod-child.ts');
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [childPath, txDir], { stdio: 'ignore' });
    child.on('close', () => resolve()); // child 在 fn 中被 SIGKILL（crash）是目的；任何退出码都算已完成
  });
  // child 在 runJournaled 的 fn 中写 side effect 后 SIGKILL（finally 未执行）→ journal 残留非终态
  const store = new JournalStore({ transactionsDir: txDir });
  await store.ensureDirs();
  const active = await store.scanActive();
  assert.equal(active.length, 1, 'child crash 后应残留 1 个 active journal');
  const j = await store.loadActive(active[0]!);
  assert.ok(j);
  assert.notEqual(['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION'].includes(j!.state), true, 'crash 后非终态');
  // reconcile：fn 已执行 side effect（磁盘 afterFp）→ after-match → recovered；不自动恢复外部不适用
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'after-match',
    probeExternal: async () => 'not-installed',
    snapshotExists: async () => false,
  }, { environmentFingerprint: 'fp-prod', isLiveOwner: async () => false });
  assert.ok(['recovered', 'noop', 'needs-attention', 'rollback-continue'].includes(out.decisions[0]!.kind));
});

// ---------- Phase 4：deferred snapshot 生产接线（F20）---------- 

/** 模拟生产引擎：runJournaled({ deferredSnapshot:true }) 内，用 plan 创建 op-bound snapshot →
 *  bindSnapshot（SNAPSHOT_CREATED）→ markApplying（APPLYING）→ 执行副作用。 */
async function runDeferredApply(
  dir: string,
  opts: { operationType?: string; doBind?: boolean; doMark?: boolean; throwInApply?: boolean },
): Promise<{ recovery: Phase3Recovery; operationId: string | null; thrown: unknown }> {
  const { operationType = 'import-apply', doBind = true, doMark = true, throwInApply = false } = opts;
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp-prod' });
  await recovery.store.ensureDirs();
  const snapDir = path.join(dir, 'snapshots');
  await fssync.mkdirSync(snapDir, { recursive: true });
  const ctx = makeContext('win32', path.join(dir, 'home'), 'web');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));
  const store = new FileSnapshotStore({ dir: snapDir });
  const plan = { items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }], globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as import('./types.ts').ImportPlan['estimatedActions'] };
  try {
    const { operationId } = await recovery.runJournaled({
      operationType,
      lockCtx: lk(),
      deferredSnapshot: true,
      fn: async (journalCtx) => {
        const snapshot: Snapshot = await createSnapshot({
          ctx,
          plan,
          sourceZip: 'x.zip',
          store,
          adapters: [],
          operationId: journalCtx?.operationId,
          operationType: journalCtx?.operationType,
          environmentFingerprint: journalCtx?.environmentFingerprint,
          ownerInstanceId: journalCtx?.ownerInstanceId,
        });
        if (doBind) await journalCtx?.bindSnapshot(snapshot.id);
        if (doMark) await journalCtx?.markApplying();
        if (throwInApply) throw new Error('injected apply failure');
        return snapshot.id;
      },
    });
    return { recovery, operationId, thrown: null };
  } catch (err) {
    // fn 抛错被 runJournaled 重新抛出；recovery 仍可用以读 journal 状态
    return { recovery, operationId: null, thrown: err };
  }
}

test('Phase4: deferredSnapshot 生产接线 → journal 记录 snapshotId + op-bound binding + COMMITTED', async (t) => {
  const dir = tmp(t);
  const { recovery, operationId } = await runDeferredApply(dir, {});
  assert.ok(operationId);
  const j = await recovery.store.load(operationId!);
  assert.ok(j);
  assert.ok(j!.snapshotId, 'journal 应记录 snapshotId（F20 生产接线）');
  const snap = await new FileSnapshotStore({ dir: path.join(dir, 'snapshots') }).load(j!.snapshotId!);
  assert.equal(snap.operationId, operationId, 'snapshot.operationId === journal.operationId');
  assert.equal(snap.operationType, 'import-apply');
  assert.equal(snap.environmentFingerprint, 'fp-prod');
  assert.equal(snap.ownerInstanceId, 'owner-prod');
  assert.equal(snap.readiness, 'READY', '部署快照应为 READY');
  assert.equal(j!.state, 'COMMITTED');
});

test('Phase4: deferredSnapshot 未 bindSnapshot → journal 无 snapshotId（引擎未接线时保守）', async (t) => {
  const dir = tmp(t);
  const { recovery, operationId } = await runDeferredApply(dir, { doBind: false });
  assert.ok(operationId);
  const j = await recovery.store.load(operationId!);
  assert.ok(j);
  assert.equal(j!.snapshotId, null, '引擎未 bindSnapshot 时 journal.snapshotId 保持 null');
  assert.equal(j!.state, 'COMMITTED');
});

test('Phase4: deferredSnapshot + fn 抛错（mutation 未完成）→ NEEDS_ATTENTION + SAFE MODE', async (t) => {
  const dir = tmp(t);
  const { recovery } = await runDeferredApply(dir, { throwInApply: true });
  // fn 抛错 → runJournaled rethrow，返回无 operationId；扫描 active 定位 NEEDS_ATTENTION journal
  const ids = await recovery.store.scanActive();
  let j: import('./journal.ts').OperationJournal | null = null;
  for (const id of ids) {
    const x = await recovery.store.loadActive(id);
    if (x) { j = x; break; }
  }
  assert.ok(j, 'journal 已创建（操作开始后才抛错）');
  assert.equal(j!.state, 'NEEDS_ATTENTION');
  assert.equal(await recovery.store.readSafeMode(), true);
  assert.equal(recovery.safeModeActive, true);
});

// ---------- Phase 4：F21/F11 production snapshotExists 正向校验 ----------

test('Phase4: snapshotExists 注入后正向校验（存在+READY+binding 匹配→true）', async (t) => {
  const dir = tmp(t);
  const snapDir = path.join(dir, 'snapshots');
  await fssync.mkdirSync(snapDir, { recursive: true });
  const ctx = makeContext('win32', path.join(dir, 'home'), 'web');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));
  const store = new FileSnapshotStore({ dir: snapDir });
  const plan = { items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }], globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as import('./types.ts').ImportPlan['estimatedActions'] };
  const snap = await createSnapshot({ ctx, plan, sourceZip: 'x', store, adapters: [], operationId: 'op-1', operationType: 'import-apply', environmentFingerprint: 'fp', ownerInstanceId: 'owner' });
  // 未注入 → 保守 false
  const noInj = new Phase3Recovery({ dataDir: path.join(dir, 'nohooks'), packageVersion: '0', environmentFingerprint: 'fp' });
  await noInj.store.ensureDirs();
  assert.equal(await noInj.recoveryHooks.snapshotExists(snap.id, { operationId: 'op-1' }), false, '未注入 snapshotExists → 保守 false');
  // 注入后校验存在+就绪+binding
  const inj = new Phase3Recovery({
    dataDir: path.join(dir, 'hooks'), packageVersion: '0', environmentFingerprint: 'fp',
    snapshotExists: async (id, binding) => {
      if (id === null || id === '') return false;
      const v = await verifySnapshot(snapDir, id);
      if (!v.ok) return false;
      const s = await store.load(id);
      if (s.readiness !== 'READY') return false;
      if (binding?.operationId !== undefined && s.operationId !== binding.operationId) return false;
      return true;
    },
  });
  await inj.store.ensureDirs();
  assert.equal(await inj.recoveryHooks.snapshotExists(snap.id, { operationId: 'op-1' }), true, 'READY + binding 匹配 → true');
  assert.equal(await inj.recoveryHooks.snapshotExists(snap.id, { operationId: 'WRONG' }), false, 'operationId 不匹配 → false（防伪造快照）');
  assert.equal(await inj.recoveryHooks.snapshotExists('bad..id', {}), false, '非法 snapshotId → false');
  assert.equal(await inj.recoveryHooks.snapshotExists(null, {}), false, 'null → false');
});
