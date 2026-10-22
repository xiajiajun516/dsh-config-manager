/**
 * task-2/A：restore 中途崩溃（真实子进程 SIGKILL）——journal 语义与「半写文件不被当成已完成」。
 *
 * 回归锚点：按**真实行为**断言，行号以符号名为锚。核心事实链（源码）：
 *  - src/cli/index.ts 把 restore() 包进 runJournaled({operationType:'cli-restore'})，非 deferred、
 *    无 snapshotProvider ⇒ src/core/phase3-host.ts 在 fn 之前把 journal 写成 APPLYING。
 *  - restore() 自本轮起通过 src/core/restore-wal.ts 上报**逐动作 WAL**：首个写之前预登记全部动盘
 *    动作（planned + beforeFp），每个动作结束更新 done/attention（+ afterFp）。崩溃后 journal 因此
 *    带着真实进度（A-1 断言「1 done + 2 planned」），而不是以前的「零 step 全不透明」。
 *  - src/core/reconcile.ts 消费这些 step：全部 done 且 afterFp 可验 ⇒ recovered（A-4）；
 *    仍有 planned/不可证 ⇒ needs-attention + SAFE MODE（A-1），绝不谎报完成。
 *  - D5（task-9 已修）：反悔副本按「本次执行」分目录（pre-restore/<stamp>[-n]/），seq 只在该目录内
 *    重数 ⇒ 崩溃后重跑不再覆盖第一份副本（修复前文件名只由 seq+relPath 决定，见 A-3）。
 *  - D4（task-9 已修，用例在 restore-target-symlink.test.ts）：计划期对目标侧 symlink/junction 做真实
 *    路径围栏，任一目标不安全 ⇒ 整笔抛错、零写入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { JournalStore, createJournalEntry, generateOperationId } from './journal.ts';
import { Phase3Recovery } from './phase3-host.ts';
import { reconcileActive } from './reconcile.ts';
import { restore } from './restore.ts';
import type { RestoreJournalPort } from './restore-wal.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { Snapshot } from './types.ts';

const SNAP_ID = 'snap-restore-crash';
const FP = 'fp-restore-crash';
const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const childPath = path.join(here, 'restore-crash-child.ts');

interface Fixture {
  workDir: string;
  dataDir: string;
  homeDir: string;
  snapshotDir: string;
  transactionsDir: string;
}

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-restore-crash-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

/** 构造磁盘夹具：home 三份「当前文件」+ 快照目录（snapshot.json + 三份 blob）。父进程建好再 spawn 子进程。 */
async function makeFixture(workDir: string): Promise<Fixture> {
  const dataDir = path.join(workDir, 'data');
  const homeDir = path.join(workDir, 'home');
  const snapshotDir = path.join(dataDir, 'snapshots', SNAP_ID);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  for (const [rel, content] of Object.entries(CURRENT)) {
    await fs.writeFile(path.join(homeDir, rel), content, 'utf8');
  }
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-10-22T00:00:00.000Z',
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
  return { workDir, dataDir, homeDir, snapshotDir, transactionsDir: path.join(dataDir, 'transactions') };
}

/** spawn 子进程：crash = 在第 2 个动作前 SIGKILL；rerun = 同 dataDir 再跑一次 CLI 同款 runJournaled */
function spawnChild(f: Fixture, mode: 'crash' | 'rerun', crashAt = 0): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, f.workDir, mode, String(crashAt)], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  });
}

/** Windows 上 process.kill(pid,'SIGKILL') 以 exit code 1（无 signal 标记）收尾；POSIX 是 null+signal。 */
function assertKilled(code: number | null): void {
  assert.ok(
    code === null || (process.platform === 'win32' && code === 1),
    `子进程应被 SIGKILL 终止，实际 exit=${String(code)}`,
  );
}

async function readActiveJournal(f: Fixture) {
  const store = new JournalStore({ transactionsDir: f.transactionsDir });
  await store.ensureDirs();
  const active = await store.scanActive();
  assert.equal(active.length, 1, '应恰有 1 条 active journal（崩溃不清理）');
  const journal = await store.loadActive(active[0]!);
  assert.ok(journal, 'active journal 应可读');
  return { store, active, journal: journal! };
}

async function readFile(homeDir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(homeDir, rel), 'utf8');
}

/** 递归列出 workDir 下所有路径（断言「零 tmp 残留」用） */
async function listAll(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
    out.push(rel);
    if (ent.isDirectory()) out.push(...await listAll(root, rel));
  }
  return out;
}

test('A-1 restore 中途进程被 SIGKILL：journal 停在 APPLYING，WAL 记录「1 done + 2 planned」，绝无「完成」标记', async (t) => {
  const f = await makeFixture(workdir(t));
  assertKilled(await spawnChild(f, 'crash', 2));

  const { journal } = await readActiveJournal(f);
  // 真实 journal 语义：非 deferred 无 provider ⇒ fn 前已 APPLYING；WAL 在首个写之前预登记全部动盘动作
  assert.equal(journal.state, 'APPLYING', 'journal 应停在 APPLYING');
  assert.equal(journal.operationType, 'cli-restore');
  assert.equal(journal.snapshotId, SNAP_ID, 'WAL 在首个写之前绑定本次可信快照');
  assert.equal(Object.keys(journal.steps).length, 3, '三个 host 文件动作全部预登记（不是只登记已执行的）');
  const steps = Object.values(journal.steps);
  assert.deepEqual(steps.map((s) => s.status), ['done', 'planned', 'planned'], '崩在第 2 步 ⇒ 1 个 done + 2 个 planned');
  assert.deepEqual(steps.map((s) => s.ref), [
    path.join(f.homeDir, 'settings.yaml'),
    path.join(f.homeDir, 'cordis.patch.yml'),
    path.join(f.homeDir, 'extra.yaml'),
  ]);
  // done 项的 afterFp = 快照内容指纹；planned 项只有 beforeFp（= 当前内容），afterFp 仍为 null
  assert.equal(steps[0]!.afterFp, sha256Hex(Buffer.from('SNAP-settings')));
  assert.equal(steps[0]!.beforeFp, sha256Hex(Buffer.from('CURRENT-settings')));
  assert.equal(steps[1]!.beforeFp, sha256Hex(Buffer.from('CURRENT-patch')));
  assert.equal(steps[1]!.afterFp, null);
  assert.equal(steps[2]!.status, 'planned');
  assert.equal(steps[2]!.afterFp, null);

  // 磁盘半恢复态真实存在：第 1 个动作已写，第 2/3 个未动
  assert.equal(await readFile(f.homeDir, 'settings.yaml'), 'SNAP-settings');
  assert.equal(await readFile(f.homeDir, 'cordis.patch.yml'), 'CURRENT-patch');
  assert.equal(await readFile(f.homeDir, 'extra.yaml'), 'CURRENT-extra');

  // 反悔副本：D5 起按「本次执行」分目录（pre-restore/<attemptDir>/），只有第 1 个动作的备份
  const preRoot = path.join(f.snapshotDir, 'pre-restore');
  const attempts = await fs.readdir(preRoot);
  assert.equal(attempts.length, 1, '崩溃前只有一次执行 ⇒ 恰一个 attempt 目录');
  const preDir = path.join(preRoot, attempts[0]!);
  assert.deepEqual(await fs.readdir(preDir), ['0001-settings.yaml']);
  assert.equal(await fs.readFile(path.join(preDir, '0001-settings.yaml'), 'utf8'), 'CURRENT-settings');

  // 「不被当成已完成」：快照目录无完成标记；snapshot.json 的 status='done' 只描述备份阶段
  assert.deepEqual((await fs.readdir(f.snapshotDir)).sort(), ['blobs', 'pre-restore', 'snapshot.json']);
  const snapJson = JSON.parse(await fs.readFile(path.join(f.snapshotDir, 'snapshot.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(snapJson.status, 'done', 'status=done 是备份阶段结论，与 restore 进度无关');
  assert.equal(snapJson.restoredAt, undefined, '不得出现「已恢复」标记');

  // 重启侧的 fail-closed 判定：needs-attention + SAFE MODE，绝不 recovered
  const store = new JournalStore({ transactionsDir: f.transactionsDir });
  const out = await reconcileActive(store, {
    verifyStepFingerprint: async () => 'unable',
    probeExternal: async () => 'unknown',
    snapshotExists: async () => false,
  }, { environmentFingerprint: FP, isLiveOwner: async () => false });
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0]!.kind, 'needs-attention', '半恢复态必须 needs-attention');
  assert.equal(out.safeModeRequired, true, '必须要求 SAFE MODE');
  assert.equal(out.unresolved.length, 1, 'unresolved 是未决 op id 列表，恰好 1 条');
  assert.equal(out.unresolved[0], journal.operationId, '未决项就是崩溃的这次 restore');

  // 零残留：崩溃瞬间正好在动作边界，不应留下 .dshcm.* tmp
  const all = await listAll(f.workDir);
  assert.deepEqual(all.filter((p) => p.includes('.dshcm.')), [], '不应有原子写 tmp 残留');
});

test('A-2 崩溃后重启走同一 CLI 路径：被残留 journal 阻断（TransactionRecoveryRequiredError），不建第二个 journal', async (t) => {
  const f = await makeFixture(workdir(t));
  assertKilled(await spawnChild(f, 'crash', 2));

  const before = await readActiveJournal(f);
  assert.equal(await spawnChild(f, 'rerun'), 0, 'rerun 子进程应正常退出（错误被捕获后写 JSON）');
  const result = JSON.parse(await fs.readFile(path.join(f.workDir, 'rerun.json'), 'utf8')) as {
    ok: boolean; name?: string; message?: string;
  };
  assert.equal(result.ok, false, '重启后不得静默续跑');
  assert.equal(result.name, 'TransactionRecoveryRequiredError', '应由 active≤1 门阻断');
  assert.match(result.message ?? '', /transaction/i);

  // 原 journal 未被替换、文件未被二次触碰
  const after = await readActiveJournal(f);
  assert.equal(after.active[0], before.active[0], '不得创建第二个 journal');
  assert.equal(after.journal.state, 'APPLYING');
  assert.equal(await readFile(f.homeDir, 'cordis.patch.yml'), 'CURRENT-patch');
  assert.equal(await readFile(f.homeDir, 'extra.yaml'), 'CURRENT-extra');
});

test('A-3 崩溃后直接重跑 restore 引擎可收敛到快照态，且第一份反悔副本不再被覆盖（D5 按 attempt 目录分桶）', async (t) => {
  const f = await makeFixture(workdir(t));
  assertKilled(await spawnChild(f, 'crash', 2));
  const preRoot = path.join(f.snapshotDir, 'pre-restore');
  const before = await fs.readdir(preRoot);
  assert.equal(before.length, 1, '崩溃前只有一次执行 => 恰一个 attempt 目录');
  const crashDir = path.join(preRoot, before[0]!);
  assert.equal(await fs.readFile(path.join(crashDir, '0001-settings.yaml'), 'utf8'), 'CURRENT-settings');

  // 引擎本身幂等：以快照为唯一事实源重跑一次即可收敛（CLI 侧需先结掉残留 journal，见 A-2）
  const report = await restore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
  assert.deepEqual(report.failed, [], '重跑不应有失败动作');
  assert.deepEqual(report.restored.sort(), ['cordis.patch.yml', 'extra.yaml', 'settings.yaml']);
  for (const [rel, content] of Object.entries(SNAPSHOT)) {
    assert.equal(await readFile(f.homeDir, rel), content, rel + ' 应收敛到快照内容');
  }

  // D5 修复点：反悔副本落在「本次执行」的独立 attempt 目录里，第二次运行不再覆盖第一次的
  // 0001-settings.yaml（修复前该文件名只由 seq+relPath 决定，seq 每次从 0 重数）。
  assert.ok(report.preRestoreDir !== undefined, '重跑有文件被覆盖 => 必须产出 attempt 目录');
  const secondDir = report.preRestoreDir!;
  assert.notEqual(secondDir, crashDir, '两次执行必须是不同目录');
  assert.deepEqual(
    (await fs.readdir(preRoot)).sort(),
    [path.basename(crashDir), path.basename(secondDir)].sort(),
    '应恰有两份 attempt 目录',
  );
  assert.equal(
    await fs.readFile(path.join(crashDir, '0001-settings.yaml'), 'utf8'),
    'CURRENT-settings',
    '第一份反悔副本逐字节保留（修复前会被覆盖成 SNAP-settings）',
  );
  assert.deepEqual((await fs.readdir(crashDir)).sort(), ['0001-settings.yaml'], '第一份目录不得被追加文件');
  // 第二份 = 崩溃后 home 的真实状态（settings 已是 SNAP，另两份仍是 CURRENT）
  assert.deepEqual((await fs.readdir(secondDir)).sort(), [
    '0001-settings.yaml', '0002-cordis.patch.yml', '0003-extra.yaml',
  ]);
  assert.equal(await fs.readFile(path.join(secondDir, '0001-settings.yaml'), 'utf8'), 'SNAP-settings');
  assert.equal(await fs.readFile(path.join(secondDir, '0002-cordis.patch.yml'), 'utf8'), 'CURRENT-patch');
  assert.equal(await fs.readFile(path.join(secondDir, '0003-extra.yaml'), 'utf8'), 'CURRENT-extra');

  const all = await listAll(f.workDir);
  assert.deepEqual(all.filter((p) => p.includes('.dshcm.')), [], '重跑不应留下 tmp 残留');
});

test('A-4 恢复全程写完但终态未落盘（宿主被杀在尾操作前）：reconcile 用真实 hooks 判 recovered', async (t) => {
  const f = await makeFixture(workdir(t));
  const store = new JournalStore({ transactionsDir: f.transactionsDir });
  await store.ensureDirs();
  const opId = generateOperationId();
  await store.create(createJournalEntry('cli-restore', {
    operationId: opId,
    ownerInstanceId: 'restore-crash-owner',
    lockId: 'restore-crash-owner',
    packageVersion: '0.1.79',
    environmentFingerprint: FP,
  }, new Date().toISOString()));
  await store.transition(opId, 'APPLYING');
  // journal 端口（与 phase3-host 的 JournalRunContext 同形）：把 WAL step 直接落进**真** store，
  // 但不写终态 —— 模拟「恢复全跑完、COMMITTED 之前被 SIGKILL」。
  const port: RestoreJournalPort = {
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
  const report = await restore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', journal: port });
  assert.deepEqual(report.failed, [], '恢复本身不应失败');
  for (const [rel, content] of Object.entries(SNAPSHOT)) {
    assert.equal(await readFile(f.homeDir, rel), content, rel + ' 应已还原');
  }

  const { journal } = await readActiveJournal(f);
  assert.equal(journal.state, 'APPLYING', '恢复不写终态（终态由 runJournaled 尾操作写）');
  assert.equal(journal.snapshotId, SNAP_ID);
  const steps = Object.values(journal.steps);
  assert.deepEqual(steps.map((s) => s.status), ['done', 'done', 'done'], '每个动作都登记 done');

  // 真实 hooks：afterFp 与盘面一致 ⇒ 全部可证明 ⇒ recovered（不是空 steps 的 needs-attention）
  const recovery = new Phase3Recovery({ dataDir: f.dataDir, packageVersion: '0.1.79', environmentFingerprint: FP });
  const out = await reconcileActive(recovery.store, recovery.recoveryHooks, {
    environmentFingerprint: FP,
    isLiveOwner: async () => false,
  });
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0]!.kind, 'recovered', '全部 step 可证明 ⇒ 判 recovered');
  assert.equal(out.safeModeRequired, false, '可证明完成时不得再要 SAFE MODE');
  assert.equal(out.unresolved.length, 0);
});
