/**
 * Phase 3 子进程 crash 注入 harness（真实 process death 模拟；由 phase3-consistency.test.ts spawn）。
 *
 * 用法：node phase3-child-crash.ts <transactionsDir> <sideEffectFile|null> <mode>
 * mode：after-lock / after-journal-create / after-snapshot / before-step / after-side-effect /
 *       after-step-done / before-commit / after-commit / during-rollback
 * kill 用 SIGKILL，finally 不执行，真实模拟 crash。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { JournalStore, createJournalEntry } from './journal.ts';
import { sha256Hex } from '../utils/hashing.ts';

const [txDirRaw, sideEffectRaw, modeRaw] = process.argv.slice(2);
const txDir = txDirRaw!;
const sideEffectFile = sideEffectRaw === 'null' || sideEffectRaw === undefined ? null : sideEffectRaw;
const modeName = modeRaw ?? '';

const OP_ID = '00000000-0000-4000-8000-00000000dead';
const OWNER = 'child-instance';
const FP = 'fp-child';

async function main(): Promise<void> {
  const store = new JournalStore({ transactionsDir: txDir });
  await store.ensureDirs();
  const base = {
    operationId: OP_ID, ownerInstanceId: OWNER, lockId: 'child-lock', packageVersion: '0.1.54', environmentFingerprint: FP,
  };

  if (modeName === 'after-lock') {
    await fs.writeFile(path.join(txDir, '..', 'environment.lock'), JSON.stringify({ owner: { instanceId: OWNER }, op: 'import-apply' }));
    process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'after-journal-create') {
    await store.create(createJournalEntry('import-apply', base, new Date().toISOString()));
    process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'after-snapshot') {
    const j = createJournalEntry('import-apply', base, new Date().toISOString());
    j.snapshotId = 'snap-child';
    await store.persist(OP_ID, j);
    process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'before-step' || modeName === 'after-side-effect' || modeName === 'after-step-done') {
    const j = createJournalEntry('import-apply', base, new Date().toISOString());
    j.plannedSteps = ['s1'];
    j.steps = {
      s1: { adapter: 'skills', ref: 'child.md', kind: 'Update', external: false, beforeFp: 'before-child', afterFp: null, status: 'planned', appliedAt: null },
    };
    j.state = 'APPLYING';
    await store.persist(OP_ID, j);
    if (modeName === 'before-step') process.kill(process.pid, 'SIGKILL');
    if (sideEffectFile !== null) {
      await fs.writeFile(sideEffectFile, 'side-effect-content');
    }
    if (modeName === 'after-side-effect') process.kill(process.pid, 'SIGKILL');
    j.steps.s1!.afterFp = sha256Hex(new TextEncoder().encode('side-effect-content'));
    j.steps.s1!.status = 'done';
    j.steps.s1!.appliedAt = new Date().toISOString();
    await store.persist(OP_ID, j);
    if (modeName === 'after-step-done') process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'before-commit') {
    const j = createJournalEntry('import-apply', base, new Date().toISOString());
    j.state = 'VALIDATING';
    j.plannedSteps = ['s1'];
    j.steps = { s1: { adapter: 'skills', ref: 'c.md', kind: 'Update', external: false, beforeFp: 'b', afterFp: 'a', status: 'done', appliedAt: null } };
    await store.persist(OP_ID, j);
    process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'after-commit') {
    const j = createJournalEntry('import-apply', base, new Date().toISOString());
    j.state = 'COMMITTED';
    j.commit = { at: new Date().toISOString(), validated: true, validationWarnings: [] };
    await store.persist(OP_ID, j);
    process.kill(process.pid, 'SIGKILL');
  }

  if (modeName === 'during-rollback') {
    const j = createJournalEntry('import-apply', base, new Date().toISOString());
    j.state = 'ROLLING_BACK';
    j.rollback = { attemptedAt: new Date().toISOString(), full: false, failed: [], entryDone: { 0: true } };
    await store.persist(OP_ID, j);
    process.kill(process.pid, 'SIGKILL');
  }

  process.exit(0);
}

main().catch((err) => { process.stderr.write(String(err)); process.exit(2); });
