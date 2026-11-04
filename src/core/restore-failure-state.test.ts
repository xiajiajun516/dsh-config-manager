/**
 * task-1/D（tech-debt #4）：恢复**单步失败**的可见性与可续跑判定（只加测试，不改引擎）。
 *
 * 回归锚点（tech-debt「恢复没有整笔回滚；先补崩溃回归测试」的对偶面）：
 * 崩溃（restore-crash-injection.test.ts）验的是「进程没了之后 journal 怎么说」；
 * 这里验的是**进程活着、某一步真失败**之后三件事是否仍然诚实：
 *  1. 失败进 report.failed（不是静默吞掉），且原因非空；
 *  2. 该步在 journal 里的 WAL status = 'attention'（绝不记 done，否则 reconcile 会把半成品判成完成）；
 *  3. **后续动作继续执行**（单步失败不退化成整笔中止）：另两个文件仍收敛到快照态；
 *  4. 反悔副本（report.preRestoreDir）真实存在且可读 —— 失败现场可人工回退；
 *  5. 续跑判定 judgeRestoreResume 见 attention 步 ⇒ 拒绝（code='step-attention'），
 *     绝不把「有一步没做成」的 journal 当成可静默续跑。
 *
 * 制造「计划期通过、执行期必然失败」的失败点：目标 'blocked/x.yaml' 的中间段 `<home>/blocked`
 * 是**普通文件**。计划期目标安全闸（assertPlanTargetsSafe）只解析「最近存在祖先」的真实落点，
 * 该祖先仍在 home 内 ⇒ 通过；执行期 atomicCopyFile 的 mkdir(dirname) 撞上普通文件 ⇒ 抛错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ABSENT_FINGERPRINT, JournalStore, createJournalEntry, generateOperationId } from './journal.ts';
import { planRestore, restore } from './restore.ts';
import type { RestoreJournalPort } from './restore-wal.ts';
import { judgeRestoreResume } from './restore-resume.ts';
import type { Snapshot } from './types.ts';

const SNAP_ID = 'snap-restore-step-fail';
const FP = 'fp-restore-step-fail';

interface Fixture {
  workDir: string;
  homeDir: string;
  snapshotDir: string;
  transactionsDir: string;
}

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-restore-fail-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CURRENT: Record<string, string> = {
  'a-settings.yaml': 'CURRENT-a',
  'z-extra.yaml': 'CURRENT-z',
};
const SNAPSHOT: Record<string, string> = {
  'a-settings.yaml': 'SNAP-a',
  'blocked/x.yaml': 'SNAP-x',
  'z-extra.yaml': 'SNAP-z',
};

/** home 三样：两个正常文件 + 一个占住路径的普通文件 `blocked`；快照三个 hostFileBackups。 */
async function makeFixture(workDir: string): Promise<Fixture> {
  const homeDir = path.join(workDir, 'home');
  const snapshotDir = path.join(workDir, 'data', 'snapshots', SNAP_ID);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  for (const [rel, body] of Object.entries(CURRENT)) {
    await fs.writeFile(path.join(homeDir, rel), body, 'utf8');
  }
  // 计划期必须是干净的：这一层先建成**真目录**，`blocked/x.yaml` 只是「快照里有、本机没有」。
  // 计划期目标安全闸只解析「最近存在祖先」的真实落点，普通文件当中间段在 POSIX 上会被它直接判越界
  // （Linux 实测：assertPlanTargetsSafe 抛「路径越界: blocked/x.yaml」），那样就测不到执行期失败。
  await fs.mkdir(path.join(homeDir, 'blocked'), { recursive: true });
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-10-22T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: [
      { relPath: 'a-settings.yaml', blobPath: 'blobs/host/a', existed: true },
      { relPath: 'blocked/x.yaml', blobPath: 'blobs/host/x', existed: true },
      { relPath: 'z-extra.yaml', blobPath: 'blobs/host/z', existed: true },
    ],
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', 'a'), SNAPSHOT['a-settings.yaml']!, 'utf8');
  await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', 'x'), SNAPSHOT['blocked/x.yaml']!, 'utf8');
  await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', 'z'), SNAPSHOT['z-extra.yaml']!, 'utf8');
  return { workDir, homeDir, snapshotDir, transactionsDir: path.join(workDir, 'data', 'transactions') };
}

/** 与 phase3-host 的 JournalRunContext 同形的端口：WAL step 直接落进**真** JournalStore。 */
function makePort(store: JournalStore, opId: string): RestoreJournalPort {
  return {
    bindSnapshot: async (snapshotId) => {
      await store.update(opId, (j) => ({ ...j, snapshotId }));
    },
    markApplying: async () => undefined,
    recordStep: async (rec) => {
      await store.update(opId, (j) => {
        const plannedSteps = j.plannedSteps.includes(rec.id) ? j.plannedSteps : [...j.plannedSteps, rec.id];
        return {
          ...j,
          plannedSteps,
          steps: {
            ...j.steps,
            [rec.id]: {
              adapter: rec.adapter,
              ref: rec.ref,
              kind: rec.kind,
              external: rec.external === true,
              beforeFp: rec.beforeFp ?? null,
              afterFp: rec.afterFp ?? null,
              status: rec.status ?? 'planned',
              appliedAt: new Date().toISOString(),
              message: rec.message ?? null,
            },
          },
        };
      });
    },
  };
}

test('core-F1 单步失败：report.failed 可见、该步 WAL=attention、后续动作继续执行、反悔副本可读、续跑判定拒绝', async (t) => {
  const f = await makeFixture(workdir(t));
  const store = new JournalStore({ transactionsDir: f.transactionsDir });
  await store.ensureDirs();
  const opId = generateOperationId();
  await store.create(createJournalEntry('cli-restore', {
    operationId: opId,
    ownerInstanceId: 'restore-step-fail-owner',
    lockId: 'restore-step-fail-owner',
    packageVersion: '0.1.79',
    environmentFingerprint: FP,
  }, new Date().toISOString()));
  await store.transition(opId, 'APPLYING');

  // 续跑判定要的是「本次重新规划的动作」，所以先自己规划一份留下（计划期已过目标安全闸）。
  const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
  const failAbs = path.join(f.homeDir, 'blocked', 'x.yaml');
  assert.deepEqual(
    plan.actions.filter((a) => a.kind !== 'skip').map((a) => a.kind),
    ['hostFileRestore', 'hostFileRestore', 'hostFileRestore'],
    '夹具里三个动盘动作都应是整文件还原（含那个必然失败的）',
  );

  // 计划已过闸，此刻把该动作的**源 blob** 换成目录：目标侧路径依旧合法（计划期与执行期的目标安全闸都不受
  // 影响），但执行期 atomicCopyFile 的 copyFile(源=目录, 临时文件) 必然抛错（POSIX EISDIR / Windows EPERM）。
  // 早先的写法是「目标父路径换成普通文件」，在 POSIX 上会被计划期目标安全闸先判越界（lstat 目标抛 ENOTDIR ⇒
  // target-unreadable），于是测到的是计划期拒绝而不是执行期失败 —— 那是平台相关的假失败。
  const brokenBlob = path.join(f.snapshotDir, 'blobs', 'host', 'x');
  await fs.rm(brokenBlob, { force: true });
  await fs.mkdir(brokenBlob, { recursive: true });

  const report = await restore({
    snapshotDir: f.snapshotDir,
    homeDir: f.homeDir,
    profile: 'web',
    journal: makePort(store, opId),
  });

  // ① 失败可见：item 是被写的目标，reason 非空（绝不静默吞）
  assert.equal(report.failed.length, 1, '应恰有 1 个失败项');
  assert.equal(report.failed[0]!.item, 'blocked/x.yaml');
  assert.ok(report.failed[0]!.reason.length > 0, '失败原因不得为空串');

  // ③ 单步失败不退化成整笔中止：先后两个文件都收敛到快照态
  assert.deepEqual(report.restored.slice().sort(), ['a-settings.yaml', 'z-extra.yaml']);
  assert.equal(await fs.readFile(path.join(f.homeDir, 'a-settings.yaml'), 'utf8'), 'SNAP-a');
  assert.equal(await fs.readFile(path.join(f.homeDir, 'z-extra.yaml'), 'utf8'), 'SNAP-z');
  // 失败目标一个字节都没写（父目录仍在、仍是空目录，未被清掉或替换）
  assert.ok((await fs.stat(path.join(f.homeDir, 'blocked'))).isDirectory(), '父目录不该被替换');
  assert.deepEqual(await fs.readdir(path.join(f.homeDir, 'blocked')), [], '失败目标不应留下任何产物');
  await assert.rejects(fs.access(failAbs), '失败目标不应被创建');

  // ② journal 逐动作终态：attention 而不是 done（否则 reconcile 会把半成品判成完成）
  const active = await store.scanActive();
  assert.equal(active.length, 1);
  const journal = await store.loadActive(active[0]!);
  assert.ok(journal, 'active journal 应可读');
  assert.equal(journal.state, 'APPLYING', '恢复不写终态（终态由 runJournaled 尾操作写）');
  assert.equal(Object.keys(journal.steps).length, 3, '三个动盘动作全部预登记（不是只登记已执行的）');
  const byRef = new Map(Object.entries(journal.steps).map(([id, step]) => [step.ref, { id, step }]));
  const failedStep = byRef.get(failAbs);
  assert.ok(failedStep, '失败目标应有对应 WAL step');
  assert.equal(failedStep!.step.status, 'attention', '失败步必须记 attention');
  assert.ok((failedStep!.step.message ?? '').length > 0, 'attention 步要带原因');
  assert.equal(failedStep!.step.afterFp, ABSENT_FINGERPRINT, '写入失败后目标仍是「可证明不存在」');
  for (const rel of ['a-settings.yaml', 'z-extra.yaml']) {
    const ok = byRef.get(path.join(f.homeDir, rel));
    assert.equal(ok?.step.status, 'done', rel + ' 应记 done');
    assert.notEqual(ok?.step.afterFp, null, rel + ' 的 done 步应带 afterFp（可被 reconcile 证明）');
  }

  // ④ 反悔副本真实存在且可读：失败现场能人工回退
  assert.ok(report.preRestoreDir !== undefined, '有文件被覆盖 ⇒ 必须产出 attempt 目录');
  const preFiles = (await fs.readdir(report.preRestoreDir!)).sort();
  assert.deepEqual(preFiles, ['0001-a-settings.yaml', '0002-z-extra.yaml'], '只备份真正被覆盖的两份');
  assert.equal(await fs.readFile(path.join(report.preRestoreDir!, '0001-a-settings.yaml'), 'utf8'), 'CURRENT-a');
  assert.equal(await fs.readFile(path.join(report.preRestoreDir!, '0002-z-extra.yaml'), 'utf8'), 'CURRENT-z');

  // ⑤ 有 attention 步 ⇒ 续跑判定拒绝（在指纹校验之前就拒，绝不静默续跑）
  const verdict = await judgeRestoreResume({
    journal: journal!,
    actions: plan.actions,
    snapshotId: SNAP_ID,
    homeDir: f.homeDir,
  });
  assert.equal(verdict.ok, false, '含 attention 步的 journal 不得被判为可续跑');
  assert.equal(verdict.ok === false ? verdict.code : '', 'step-attention');
});
