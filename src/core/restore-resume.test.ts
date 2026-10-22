/**
 * 恢复的**自动续跑**：判定器逐条证明 + 真崩溃后接着做（不是整笔重来）。
 *
 * 事实链（源码锚点）：
 *  - 判定 = core/restore-resume.ts 的 judgeRestoreResume：状态/操作类型/回滚痕迹/快照绑定/
 *    计划与 step 一一对应/step 状态/外部副作用/before-after 指纹，任一不成立即拒绝并给机器码。
 *  - 执行 = restore.ts / route-support.ts 收到 resume.hint 后：**不重新 preRegister**（否则已完成动作的
 *    beforeFp 被覆盖成「执行后内容」，崩溃证据全丢），只跳过「盘面已等于 afterFp」的动作。
 *  - 收尾 = phase3-host.ts 的 resumeJournaled：接管 owner、不 create、不做 active≤1 门禁。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ABSENT_FINGERPRINT, JournalStore, createJournalEntry, generateOperationId } from './journal.ts';
import type { OperationJournal } from './journal.ts';
import { judgeRestoreResume, probeRestoreResume, runRestoreWithResume } from './restore-resume.ts';
import { Phase3Recovery } from './phase3-host.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { Snapshot } from './types.ts';
import type { RestoreAction } from './restore.ts';

const SNAP_ID = 'snap-resume';
const FP = 'fp-resume';
const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const childPath = path.join(here, 'restore-crash-child.ts');

const CURRENT: Record<string, string> = {
  'settings.yaml': 'CURRENT-settings',
  'cordis.patch.yml': 'CURRENT-patch',
  'extra.yaml': 'CURRENT-extra',
};
const SNAPSHOT: Record<string, string> = {
  'settings.yaml': 'SNAP-settings',
  'cordis.patch.yml': 'SNAP-patch',
  'extra.yaml': 'SNAP-extra',
};

interface Fixture {
  workDir: string;
  dataDir: string;
  homeDir: string;
  snapshotDir: string;
  transactionsDir: string;
}

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-restore-resume-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeFixture(root: string, snapshotId: string = SNAP_ID): Promise<Fixture> {
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  const snapshotDir = path.join(dataDir, 'snapshots', snapshotId);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  for (const [rel, content] of Object.entries(CURRENT)) {
    await fs.writeFile(path.join(homeDir, rel), content, 'utf8');
  }
  const snapshot: Snapshot = {
    id: snapshotId,
    createdAt: '2026-10-23T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: [
      { relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true },
      { relPath: 'cordis.patch.yml', blobPath: 'blobs/host/patch', existed: true },
      { relPath: 'extra.yaml', blobPath: 'blobs/host/extra', existed: true },
    ],
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  for (const [rel, content] of Object.entries(SNAPSHOT)) {
    const blobName = rel === 'settings.yaml' ? 'settings' : (rel === 'cordis.patch.yml' ? 'patch' : 'extra');
    await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', blobName), content, 'utf8');
  }
  return { workDir: root, dataDir, homeDir, snapshotDir, transactionsDir: path.join(dataDir, 'transactions') };
}

const restoreOptsOf = (f: Fixture) => ({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', snapshotsRoot: path.join(f.dataDir, 'snapshots') });

/** 三个 host 文件动作（与真实 planRestore 对同一夹具产出的 kind/target 一致）。 */
const ACTIONS: readonly RestoreAction[] = [
  { kind: 'hostFileRestore', target: 'settings.yaml', blobPath: 'blobs/host/settings', description: 'settings' },
  { kind: 'hostFileRestore', target: 'cordis.patch.yml', blobPath: 'blobs/host/patch', description: 'patch' },
  { kind: 'hostFileRestore', target: 'extra.yaml', blobPath: 'blobs/host/extra', description: 'extra' },
] as readonly RestoreAction[];

const fp = (s: string): string => sha256Hex(Buffer.from(s));

/** 目标 → 执行前内容的指纹（显式映射：别拿文件名去拼字符串，cordis.patch.yml 拼不出 CURRENT-patch）。 */
const BEFORE_FP: Record<string, string> = {
  'settings.yaml': fp(CURRENT['settings.yaml']!),
  'cordis.patch.yml': fp(CURRENT['cordis.patch.yml']!),
  'extra.yaml': fp(CURRENT['extra.yaml']!),
};
const beforeFp = (target: string | undefined): string | null => BEFORE_FP[target ?? ''] ?? null;

/** 造一条 active journal（直接写 store，模拟崩溃现场）。 */
async function makeJournal(f: Fixture, opts: { state?: string; snapshotId?: string | null } = {}): Promise<{ store: JournalStore; opId: string; journal: OperationJournal }> {
  const store = new JournalStore({ transactionsDir: f.transactionsDir });
  await store.ensureDirs();
  const opId = generateOperationId();
  await store.create(createJournalEntry('cli-restore', {
    operationId: opId,
    ownerInstanceId: 'crashed-owner',
    lockId: 'crashed-owner',
    packageVersion: '0.1.81',
    environmentFingerprint: FP,
  }, new Date().toISOString()));
  const state = opts.state ?? 'APPLYING';
  if (state !== 'CREATED') await store.transition(opId, 'APPLYING');
  if (state === 'NEEDS_ATTENTION') await store.transition(opId, 'NEEDS_ATTENTION');
  if (opts.snapshotId !== null && opts.snapshotId !== undefined) {
    await store.update(opId, (j) => ({ ...j, snapshotId: opts.snapshotId as string }));
  }
  const journal = await store.loadActive(opId);
  assert.ok(journal);
  return { store, opId, journal: journal! };
}

/** 写一条 restore 口径的 step（adapter='restore'）。 */
async function putStep(
  store: JournalStore, opId: string, id: string,
  step: { ref: string; kind?: string; beforeFp: string | null; afterFp: string | null; status?: string; external?: boolean },
): Promise<void> {
  await store.update(opId, (j) => ({
    ...j,
    plannedSteps: j.plannedSteps.includes(id) ? j.plannedSteps : [...j.plannedSteps, id],
    steps: {
      ...j.steps,
      [id]: {
        adapter: 'restore',
        ref: step.ref,
        kind: step.kind ?? 'hostFileRestore',
        external: step.external === true,
        beforeFp: step.beforeFp,
        afterFp: step.afterFp,
        status: (step.status ?? 'planned') as 'planned',
        appliedAt: new Date().toISOString(),
        message: null,
      },
    },
  }));
}

test('T-01 CREATED 且零 step（上次连第一个写都没发生）⇒ 可续跑，todo = 动作数、skip 为空', async (t) => {
  const f = await makeFixture(workdir(t));
  const { journal } = await makeJournal(f, { state: 'CREATED' });
  const judged = await judgeRestoreResume({ journal, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(judged.ok, true);
  if (!judged.ok) return;
  assert.equal(judged.resume.done, 0);
  assert.equal(judged.resume.todo, 3);
  assert.equal(judged.resume.hint.skipStepIds.size, 0);
});

test('T-02 APPLYING：已完成的动作按 afterFp 命中被跳过，未做的按 beforeFp 命中留下', async (t) => {
  const f = await makeFixture(workdir(t));
  const { store, opId, journal } = await makeJournal(f, { snapshotId: SNAP_ID });
  // 崩在第 2 个动作之前：第 1 个已写成快照内容，另两个仍是当前内容
  await fs.writeFile(path.join(f.homeDir, 'settings.yaml'), 'SNAP-settings', 'utf8');
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'settings.yaml'), {
    ref: path.join(f.homeDir, 'settings.yaml'), beforeFp: fp('CURRENT-settings'), afterFp: fp('SNAP-settings'), status: 'done',
  });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'cordis.patch.yml'), {
    ref: path.join(f.homeDir, 'cordis.patch.yml'), beforeFp: fp('CURRENT-patch'), afterFp: null,
  });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'extra.yaml'), {
    ref: path.join(f.homeDir, 'extra.yaml'), beforeFp: fp('CURRENT-extra'), afterFp: null,
  });
  const reloaded = await store.loadActive(opId);
  assert.ok(reloaded);
  const judged = await judgeRestoreResume({ journal: reloaded!, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(judged.ok, true);
  if (!judged.ok) return;
  assert.equal(judged.resume.done, 1);
  assert.equal(judged.resume.todo, 2);
  assert.deepEqual([...judged.resume.hint.skipStepIds], ['restore:hostFileRestore:' + path.join(f.homeDir, 'settings.yaml')]);
  assert.equal(Object.keys(judged.resume.hint.steps).length, 3, '句柄复原要拿到全部三个 step');
  void journal;
});

test('T-03 盘面既不等于执行前也不等于执行后 ⇒ fingerprint-drift（不猜）', async (t) => {
  const f = await makeFixture(workdir(t));
  const { store, opId } = await makeJournal(f, { snapshotId: SNAP_ID });
  await fs.writeFile(path.join(f.homeDir, 'settings.yaml'), 'USER-EDITED-AFTER-CRASH', 'utf8');
  for (const a of ACTIONS) {
    await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, a.target ?? ''), {
      ref: path.join(f.homeDir, a.target ?? ''), beforeFp: beforeFp(a.target), afterFp: null,
    });
  }
  const journal = await store.loadActive(opId);
  assert.ok(journal);
  const judged = await judgeRestoreResume({ journal: journal!, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(judged.ok, false);
  if (judged.ok) return;
  assert.equal(judged.code, 'fingerprint-drift');
});

test('T-04 计划与 journal step 不一一对应（少一条）⇒ plan-drift', async (t) => {
  const f = await makeFixture(workdir(t));
  const { store, opId } = await makeJournal(f, { snapshotId: SNAP_ID });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'settings.yaml'), {
    ref: path.join(f.homeDir, 'settings.yaml'), beforeFp: fp('CURRENT-settings'), afterFp: null,
  });
  const journal = await store.loadActive(opId);
  assert.ok(journal);
  const judged = await judgeRestoreResume({ journal: journal!, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(judged.ok, false);
  if (judged.ok) return;
  assert.equal(judged.code, 'plan-drift');
});

test('T-05 插件卸载属外部副作用 ⇒ external-unproven（永不自动续跑）', async (t) => {
  const f = await makeFixture(workdir(t));
  const { store, opId } = await makeJournal(f, { snapshotId: SNAP_ID });
  const actions = [...ACTIONS, { kind: 'pluginRemove', pluginName: 'pkg-a', description: 'remove pkg-a' }] as readonly RestoreAction[];
  for (const a of ACTIONS) {
    await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, a.target ?? ''), {
      ref: path.join(f.homeDir, a.target ?? ''), beforeFp: beforeFp(a.target), afterFp: null,
    });
  }
  await putStep(store, opId, 'restore:pluginRemove:pkg-a', {
    ref: '', kind: 'pluginRemove', beforeFp: null, afterFp: null, external: true,
  });
  const journal = await store.loadActive(opId);
  assert.ok(journal);
  const judged = await judgeRestoreResume({ journal: journal!, actions, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(judged.ok, false);
  if (judged.ok) return;
  assert.equal(judged.code, 'external-unproven');
});

test('T-06 六类拒绝码：终态/别的操作类型/回滚痕迹/别的快照/失败动作/无法信任的 step', async (t) => {
  const f = await makeFixture(workdir(t));
  const base = await makeJournal(f, { snapshotId: SNAP_ID });

  // 终态
  const needs = await judgeRestoreResume({
    journal: { ...base.journal, state: 'NEEDS_ATTENTION' }, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir,
  });
  assert.equal(needs.ok === false && needs.code, 'terminal');

  // 别的操作类型
  const wrong = await judgeRestoreResume({
    journal: { ...base.journal, operationType: 'model-restore' }, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir,
    allowedOperationTypes: ['cli-restore'],
  });
  assert.equal(wrong.ok === false && wrong.code, 'wrong-operation');

  // 已有回滚痕迹
  const rolled = await judgeRestoreResume({
    journal: { ...base.journal, rollback: { ...base.journal.rollback, entryDone: { 0: true } } },
    actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir,
  });
  assert.equal(rolled.ok === false && rolled.code, 'rollback-in-flight');

  // 绑定的是另一份快照
  const otherSnap = await judgeRestoreResume({
    journal: { ...base.journal, snapshotId: 'snap-other' }, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir,
  });
  assert.equal(otherSnap.ok === false && otherSnap.code, 'no-snapshot');

  // 上次失败的动作
  const { store, opId } = await makeJournal(f, { snapshotId: SNAP_ID });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'settings.yaml'), {
    ref: path.join(f.homeDir, 'settings.yaml'), beforeFp: fp('CURRENT-settings'), afterFp: null, status: 'attention',
  });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'cordis.patch.yml'), {
    ref: path.join(f.homeDir, 'cordis.patch.yml'), beforeFp: fp('CURRENT-patch'), afterFp: null,
  });
  await putStep(store, opId, 'restore:hostFileRestore:' + path.join(f.homeDir, 'extra.yaml'), {
    ref: path.join(f.homeDir, 'extra.yaml'), beforeFp: fp('CURRENT-extra'), afterFp: null,
  });
  const attentionJournal = await store.loadActive(opId);
  assert.ok(attentionJournal);
  const attention = await judgeRestoreResume({ journal: attentionJournal!, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(attention.ok === false && attention.code, 'step-attention');

  // beforeFp 缺失 ⇒ 无法判定盘面属于哪一侧
  const { store: store2, opId: opId2 } = await makeJournal(f, { snapshotId: SNAP_ID });
  for (const a of ACTIONS) {
    await putStep(store2, opId2, 'restore:hostFileRestore:' + path.join(f.homeDir, a.target ?? ''), {
      ref: path.join(f.homeDir, a.target ?? ''), beforeFp: a.target === 'settings.yaml' ? null : fp('CURRENT-x'), afterFp: null,
    });
  }
  const noBefore = await store2.loadActive(opId2);
  assert.ok(noBefore);
  const untrusted = await judgeRestoreResume({ journal: noBefore!, actions: ACTIONS, snapshotId: SNAP_ID, homeDir: f.homeDir });
  assert.equal(untrusted.ok === false && untrusted.code, 'untrusted-step');
});

test('T-07 真崩溃（SIGKILL）后接着做：只重做剩下的动作，journal 收敛到 COMMITTED，已完成动作不再被覆盖', async (t) => {
  // 子进程 harness 的快照目录名/环境指纹/包版本是写死的（restore-crash-child.ts），必须对齐
  const f = await makeFixture(workdir(t), 'snap-restore-crash');
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [childPath, f.workDir, 'crash', '2'], { stdio: 'ignore' });
    child.on('close', (c) => resolve(c));
  });
  assert.ok(code === null || (process.platform === 'win32' && code === 1), `子进程应被杀（实际 exit ${String(code)}）`);
  assert.equal(await fs.readFile(path.join(f.homeDir, 'settings.yaml'), 'utf8'), 'SNAP-settings', '第 1 个动作已完成');
  assert.equal(await fs.readFile(path.join(f.homeDir, 'cordis.patch.yml'), 'utf8'), 'CURRENT-patch', '第 2 个动作还没开始');

  const recovery = new Phase3Recovery({
    dataDir: f.dataDir, packageVersion: '0.1.79', environmentFingerprint: 'fp-restore-crash',
  });
  // 锁前探测：应当可续跑（同一快照 + 计划与 step 一一对应 + 指纹可证）
  const probe = await probeRestoreResume({ store: recovery.store, restoreOpts: restoreOptsOf(f), allowedOperationTypes: ['cli-restore'] });
  assert.equal(probe.ok, true, probe.ok === false ? `${probe.code}: ${probe.detail}` : '');
  if (!probe.ok) return;
  assert.equal(probe.resume.done, 1);
  assert.equal(probe.resume.todo, 2);

  const lockCtx = {
    token: { tokenId: 't-1', managerId: 'm-1', instanceId: 'i-1', acquiredAt: Date.now() },
  };
  const out = await runRestoreWithResume<{ restored: string[]; failed: { item: string }[]; preRestoreDir?: string }>({
    store: recovery.store,
    restoreOpts: restoreOptsOf(f),
    operationType: 'cli-restore',
    allowedOperationTypes: ['cli-restore'],
    lockCtx,
    phase3: recovery,
  });
  assert.ok(out.resumed !== null, '必须走续跑路径');
  assert.deepEqual(out.resumed, { operationId: probe.resume.operationId, done: 1, todo: 2 });
  assert.deepEqual(out.report.failed, []);
  assert.deepEqual([...out.report.restored].sort(), ['cordis.patch.yml', 'extra.yaml'], 'settings.yaml 已在上次写成快照态，不得重做');

  // 三个文件都到快照态
  for (const [rel, content] of Object.entries(SNAPSHOT)) {
    assert.equal(await fs.readFile(path.join(f.homeDir, rel), 'utf8'), content, rel);
  }
  // journal 收尾：续跑成功 = COMMITTED + moveToCompleted（不再有 active）
  assert.deepEqual(await recovery.store.scanActive(), [], '续跑成功后不应再有 active journal');

  // 反悔副本：崩溃那次的目录原样保留；续跑只给「这次真正覆盖的 2 个文件」留副本
  const attempts = (await fs.readdir(path.join(f.snapshotDir, 'pre-restore'))).sort();
  assert.equal(attempts.length, 2, '两次执行各一个 attempt 目录');
  assert.deepEqual((await fs.readdir(path.join(f.snapshotDir, 'pre-restore', attempts[0]!))).sort(), ['0001-settings.yaml']);
  assert.deepEqual(
    (await fs.readdir(path.join(f.snapshotDir, 'pre-restore', attempts[1]!))).sort(),
    ['0001-cordis.patch.yml', '0002-extra.yaml'],
    '被跳过的动作不留副本（它没有被再次覆盖）',
  );
});

test('T-08 resumeJournaled 的拒绝：没有记录 / 已终态 / 操作类型不符，都不写盘', async (t) => {
  const f = await makeFixture(workdir(t));
  const recovery = new Phase3Recovery({ dataDir: f.dataDir, packageVersion: '0.1.81', environmentFingerprint: FP });
  const lockCtx = { token: { tokenId: 't-2', managerId: 'm-2', instanceId: 'i-2', acquiredAt: Date.now() } };
  const call = (operationId: string, operationType = 'cli-restore') => recovery.resumeJournaled({
    operationId, operationType, lockCtx, fn: async () => undefined,
  });

  await assert.rejects(() => call(generateOperationId()), /resume|续跑/i);

  const { store, opId } = await makeJournal(f, { snapshotId: SNAP_ID });
  await assert.rejects(() => call(opId, 'restore'), /resume|续跑/i, '操作类型不符必须拒绝');

  // 终态记录（已 COMMITTED）应被拒
  await store.transition(opId, 'VALIDATING');
  await store.transition(opId, 'COMMITTED');
  await assert.rejects(() => call(opId), /resume|续跑/i, '终态不可续跑');

  // 全程无写盘副作用
  assert.equal(ABSENT_FINGERPRINT, 'absent', '哨兵常量仍是「文件不存在」的唯一表达');
});