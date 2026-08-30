/**
 * P2-B（Phase 8）：逐计划项 before/after 指纹 + reconcile 判精度测试。
 *
 * 验证：
 *  - Phase3Recovery.recoveryHooks.verifyStepFingerprint 对本地文件 step 做真实磁盘指纹判定
 *    （after-match / before-match / before-match(缺失) / none / unable）；
 *  - runJournaled 的 journalCtx.recordStep 把文件/外部 step 持久化进 journal；
 *  - reconcile：全部文件项 done + afterFp 可验 → recovered（降低「已应用误判 needs-attention」保守率）
 *  - reconcile：任一外部/不可指纹 step → needs-attention（安全边界不放宽）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JournalStore, createJournalEntry, generateOperationId } from './journal.ts';
import { Phase3Recovery } from './phase3-host.ts';
import { reconcileActive } from './reconcile.ts';
import type { ReconcileEnv } from './reconcile.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'p2bfp-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lk(instance = 'owner-p2b'): MutationLockContext {
  return { token: { tokenId: 't', managerId: 'm', instanceId: instance, acquiredAt: Date.now() } };
}

async function makeRecovery(dir: string): Promise<Phase3Recovery> {
  const r = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.54', environmentFingerprint: 'fp-p2b' });
  await r.store.ensureDirs();
  return r;
}

// ---------- 1. verifyStepFingerprint 指纹判定 ----------

test('verifyStepFingerprint：本地文件 step 真实磁盘指纹判定', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const fx = path.join(dir, 'target.yaml');
  await fssync.writeFileSync(fx, 'content-A');
  const fpA = sha256Hex(Buffer.from('content-A'));
  await fssync.writeFileSync(fx, 'content-B');
  const fpB = sha256Hex(Buffer.from('content-B'));

  const hooks = recovery.recoveryHooks;
  const local = (ref: string, beforeFp: string | null, afterFp: string | null, status: import('./journal.ts').JournalStep['status'] = 'done') => ({
    adapter: 'skills', ref, kind: 'Update', external: false, beforeFp, afterFp, status, appliedAt: null,
  });

  // after 匹配 → 已应用
  assert.equal(await hooks.verifyStepFingerprint(local(fx, fpA, fpB)), 'after-match');
  // 磁盘 == beforeFp 且无 afterFp → before-match（未应用）
  assert.equal(await hooks.verifyStepFingerprint(local(fx, fpB, null)), 'before-match');
  // 内容与 before/after 均不符 → none
  assert.equal(await hooks.verifyStepFingerprint(local(fx, fpA, sha256Hex(Buffer.from('other')))), 'none');
  // 文件缺失 + 仅有 afterFp（期望存在）→ 视作未应用
  const missing = path.join(dir, 'nope.yaml');
  assert.equal(await hooks.verifyStepFingerprint(local(missing, null, fpB)), 'before-match');
  // 无指纹 → unable（不可判定）
  assert.equal(await hooks.verifyStepFingerprint(local(fx, null, null)), 'unable');
  // external step → unable（reconcile 走 probeExternal 保守）
  assert.equal(await hooks.verifyStepFingerprint({ adapter: 'plugins', ref: 'plugin:@x', kind: 'Install', external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null }), 'unable');
});

// ---------- 2. recordStep 持久化 ----------

test('runJournaled journalCtx.recordStep：文件/外部 step 落 journal', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const { operationId } = await recovery.runJournaled({
    operationType: 'import-apply', lockCtx: lk(), deferredSnapshot: true,
    fn: async (ctx) => {
      await ctx?.recordStep({ id: 'skills:a.md', adapter: 'skills', kind: 'Update', ref: '/abs/skills/a.md', external: false, status: 'done', beforeFp: null, afterFp: 'fp-after' });
      await ctx?.recordStep({ id: 'plugins:pkg', adapter: 'plugins', kind: 'Install', ref: '', external: true, status: 'attention' });
      return 1;
    },
  });
  const j = await recovery.store.load(operationId!);
  assert.ok(j);
  assert.equal(j!.steps['skills:a.md']?.afterFp, 'fp-after');
  assert.equal(j!.steps['skills:a.md']?.external, false);
  assert.equal(j!.steps['plugins:pkg']?.external, true);
  assert.ok(j!.plannedSteps.includes('skills:a.md'));
  assert.ok(j!.plannedSteps.includes('plugins:pkg'));
});

// ---------- 3. reconcile 集成 ----------

/** 预置一个 APPLYING 的 active journal（模拟 crash 残留），带指定 steps。 */
async function seedJournal(store: JournalStore, steps: import('./journal.ts').JournalStep[], opts: { state?: import('./journal.ts').JournalState; ownerInstanceId?: string } = {}): Promise<string> {
  const opId = generateOperationId();
  const owner = opts.ownerInstanceId ?? 'owner-p2b';
  await store.create(createJournalEntry('import-apply',
    { operationId: opId, ownerInstanceId: owner, lockId: owner, packageVersion: '0.1.54', environmentFingerprint: 'fp-p2b' },
    new Date().toISOString()));
  await store.update(opId, (j) => {
    const ids = steps.map((_, i) => `s${i}`);
    const stepsObj: Record<string, import('./journal.ts').JournalStep> = {};
    ids.forEach((id, i) => { stepsObj[id] = steps[i]!; });
    return { ...j, state: opts.state ?? 'APPLYING', plannedSteps: ids, steps: stepsObj };
  });
  return opId;
}

function env(): ReconcileEnv {
  // 不传 expectedOwnershipInstanceId → 跳过 P1-A binding（本测试聚焦指纹行为）
  return { environmentFingerprint: 'fp-p2b', isLiveOwner: async () => false };
}

test('reconcile：全部文件项 done + afterFp 可验 → recovered（降低误判 needs-attention）', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  // 两个已应用文件（磁盘 == afterFp）
  const f1 = path.join(dir, 'f1.yaml'); await fssync.writeFileSync(f1, 'one');
  const f2 = path.join(dir, 'f2.md'); await fssync.writeFileSync(f2, 'two');
  const step = (ref: string, afterFp: string): import('./journal.ts').JournalStep => ({
    adapter: 'skills', ref, kind: 'Update', external: false,
    beforeFp: null, afterFp, status: 'done', appliedAt: new Date().toISOString(),
  });
  const opId = await seedJournal(recovery.store, [
    step(f1, sha256Hex(Buffer.from('one'))),
    step(f2, sha256Hex(Buffer.from('two'))),
  ]);
  const out = await reconcileActive(recovery.store, recovery.recoveryHooks, env());
  // 只处理该 journal
  const dec = out.decisions.find((d) => d.operationId === opId);
  assert.ok(dec, 'decision 存在');
  assert.equal(dec!.kind, 'recovered', `全文件项可验应判 recovered，实际=${dec!.kind}`);
  assert.equal(out.safeModeRequired, false);
  // 已规整出 active
  assert.ok(!(await recovery.store.scanActive()).includes(opId));
});

test('reconcile：任一外部/不可指纹 step → needs-attention（安全边界不放宽）', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const f1 = path.join(dir, 'f1.yaml'); await fssync.writeFileSync(f1, 'one');
  const fileStep: import('./journal.ts').JournalStep = {
    adapter: 'skills', ref: f1, kind: 'Update', external: false,
    beforeFp: null, afterFp: sha256Hex(Buffer.from('one')), status: 'done', appliedAt: new Date().toISOString(),
  };
  const extStep: import('./journal.ts').JournalStep = {
    adapter: 'plugins', ref: 'plugin:@x', kind: 'Install', external: true,
    beforeFp: null, afterFp: null, status: 'attention', appliedAt: null,
  };
  const opId = await seedJournal(recovery.store, [fileStep, extStep]);
  const out = await reconcileActive(recovery.store, recovery.recoveryHooks, env());
  const dec = out.decisions.find((d) => d.operationId === opId);
  assert.ok(dec, 'decision 存在');
  assert.equal(dec!.kind, 'needs-attention', `外部步骤不得判 recovered（安全边界），实际=${dec!.kind}`);
  assert.equal(out.safeModeRequired, true);
});

test('reconcile：部分文件项 applied（其余 planned 未应用）→ 不判 recovered（保守）', async (t) => {
  const dir = tmp(t);
  const recovery = await makeRecovery(dir);
  const f1 = path.join(dir, 'f1.yaml'); await fssync.writeFileSync(f1, 'one');
  // f2 未写（planned，beforeFp=null，afterFp=null → unable → 不可证 → needs-attention 保守）
  const f2 = path.join(dir, 'f2.md');
  const doneStep: import('./journal.ts').JournalStep = {
    adapter: 'skills', ref: f1, kind: 'Update', external: false,
    beforeFp: null, afterFp: sha256Hex(Buffer.from('one')), status: 'done', appliedAt: new Date().toISOString(),
  };
  const plannedStep: import('./journal.ts').JournalStep = {
    adapter: 'skills', ref: f2, kind: 'Update', external: false,
    beforeFp: null, afterFp: null, status: 'planned', appliedAt: null,
  };
  const opId = await seedJournal(recovery.store, [doneStep, plannedStep]);
  const out = await reconcileActive(recovery.store, recovery.recoveryHooks, env());
  const dec = out.decisions.find((d) => d.operationId === opId);
  assert.ok(dec, 'decision 存在');
  assert.notEqual(dec!.kind, 'recovered', '部分未应用（planned 不可证）不得判 recovered');
  assert.equal(dec!.kind, 'needs-attention');
});
