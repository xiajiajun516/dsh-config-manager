/**
 * task-2/A：restore 中途崩溃（真实子进程 SIGKILL）——journal 语义与「半写文件不被当成已完成」。
 *
 * 只读审计产物：不改 src 任何实现，按**真实行为**断言。核心事实链（源码）：
 *  - src/cli/index.ts:1130 把 restore() 包进 runJournaled({operationType:'cli-restore'})，非 deferred、
 *    无 snapshotProvider ⇒ src/core/phase3-host.ts:352-353 在 fn 之前把 journal 写成 APPLYING。
 *  - restore()（src/core/restore.ts:695-803）**全程不调用** recordStep/bindSnapshot/markApplying
 *    ⇒ 崩溃后 journal 是「APPLYING + 零 step + snapshotId=null」。
 *  - src/core/reconcile.ts:365-373（空 steps + APPLYING + 无 trusted snapshot）⇒ needs-attention + SAFE MODE，
 *    绝不 recovered ⇒ 「半写状态不会被当成已完成」由 journal 判定兜住。
 *  - 缺口（本文件以 TODO 标注、不改 src）：pre-restore/ 备份名=seq+relPath，seq 每次 restore() 从 0 重数
 *    （restore.ts:713/723）⇒ 崩溃后重跑会**覆盖**第一次的「反悔副本」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { JournalStore } from './journal.ts';
import { reconcileActive } from './reconcile.ts';
import { restore } from './restore.ts';
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

test('A-1 restore 中途进程被 SIGKILL：journal 停在 APPLYING、零 step 登记，绝无「完成」标记', async (t) => {
  const f = await makeFixture(workdir(t));
  assertKilled(await spawnChild(f, 'crash', 2));

  const { journal } = await readActiveJournal(f);
  // 真实 journal 语义：非 deferred 无 provider ⇒ fn 前已 APPLYING；restore 不登记任何 step
  assert.equal(journal.state, 'APPLYING', 'journal 应停在 APPLYING');
  assert.equal(journal.operationType, 'cli-restore');
  assert.ok(journal.snapshotId == null, 'CLI restore 路径不绑定 snapshotId（无可信回滚快照）');
  assert.deepEqual(Object.keys(journal.steps), [], 'restore 不写 step ⇒ 崩溃后零进度登记');

  // 磁盘半恢复态真实存在：第 1 个动作已写，第 2/3 个未动
  assert.equal(await readFile(f.homeDir, 'settings.yaml'), 'SNAP-settings');
  assert.equal(await readFile(f.homeDir, 'cordis.patch.yml'), 'CURRENT-patch');
  assert.equal(await readFile(f.homeDir, 'extra.yaml'), 'CURRENT-extra');

  // 反悔副本：只有第 1 个动作的 pre-restore 备份
  const preDir = path.join(f.snapshotDir, 'pre-restore');
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

test('A-3 崩溃后直接重跑 restore 引擎可收敛到快照态，但 pre-restore 反悔副本被覆盖（当前行为/TODO）', async (t) => {
  const f = await makeFixture(workdir(t));
  assertKilled(await spawnChild(f, 'crash', 2));
  const preDir = path.join(f.snapshotDir, 'pre-restore');
  assert.equal(await fs.readFile(path.join(preDir, '0001-settings.yaml'), 'utf8'), 'CURRENT-settings');

  // 引擎本身幂等：以快照为唯一事实源重跑一次即可收敛（CLI 侧需先结掉残留 journal，见 A-2）
  const report = await restore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
  assert.deepEqual(report.failed, [], '重跑不应有失败动作');
  assert.deepEqual(report.restored.sort(), ['cordis.patch.yml', 'extra.yaml', 'settings.yaml']);
  for (const [rel, content] of Object.entries(SNAPSHOT)) {
    assert.equal(await readFile(f.homeDir, rel), content, `${rel} 应收敛到快照内容`);
  }

  // TODO(缺陷，未改 src)：seq 每次 restore() 从 0 重数（src/core/restore.ts:713/723），
  // pre-restore 文件名只由 seq+relPath 决定（copyToPreRestore 234-238）⇒ 第二次运行把
  // 0001-settings.yaml（真正的「恢复前原文」）覆盖成「第一次恢复后的内容」= 反悔副本静默丢失。
  // 若修复（例如按运行时间戳/唯一目录分桶），本断言应改为 === 'CURRENT-settings'。
  assert.equal(
    await fs.readFile(path.join(preDir, '0001-settings.yaml'), 'utf8'),
    'SNAP-settings',
    '当前行为：重跑覆盖了第一次的反悔副本',
  );
  // 未被第一次触碰的目标，其反悔副本仍是原文
  assert.equal(await fs.readFile(path.join(preDir, '0002-cordis.patch.yml'), 'utf8'), 'CURRENT-patch');
  assert.deepEqual((await fs.readdir(preDir)).sort(), [
    '0001-settings.yaml', '0002-cordis.patch.yml', '0003-extra.yaml',
  ]);

  const all = await listAll(f.workDir);
  assert.deepEqual(all.filter((p) => p.includes('.dshcm.')), [], '重跑不应留下 tmp 残留');
});
