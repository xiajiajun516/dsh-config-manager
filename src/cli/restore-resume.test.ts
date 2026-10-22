/**
 * CLI 入口的自动续跑薄封装：锁前探测 → 锁内续跑 → 按同一判据解除 SAFE MODE。
 *
 * 这里只钉「CLI 口子」的三件事（判定与执行都在 core，见 core/restore-resume.ts）：
 *  1. 没有事故时探测必须 resumable=false 且 reason=null（不是「拒绝」，不许吓用户）；
 *  2. 真崩溃后探测必须报出 done/todo；
 *  3. 续跑成功后才调 clearSafeMode（有别的未解决 incident 时必须保持）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { Phase3Recovery } from '../core/phase3-host.ts';
import { probeCliRestoreResume, runCliRestore } from './restore-resume.ts';
import type { RestoreOptions } from '../core/restore.ts';

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const childPath = path.join(here, '..', 'core', 'restore-crash-child.ts');
const SNAP_ID = 'snap-restore-crash';

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

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-cli-resume-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 与 restore-crash-child.ts 期望的布局一致（<work>/data/snapshots/snap-restore-crash + <work>/home）。 */
async function makeFixture(root: string): Promise<{ dataDir: string; homeDir: string; snapshotDir: string; opts: RestoreOptions }> {
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  const snapshotDir = path.join(dataDir, 'snapshots', SNAP_ID);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  for (const [rel, text] of Object.entries(CURRENT)) await fs.writeFile(path.join(homeDir, rel), text, 'utf8');
  const snapshot = {
    id: SNAP_ID,
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
  for (const [rel, text] of Object.entries(SNAPSHOT)) {
    const blobName = rel === 'settings.yaml' ? 'settings' : (rel === 'cordis.patch.yml' ? 'patch' : 'extra');
    await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', blobName), text, 'utf8');
  }
  const opts: RestoreOptions = {
    snapshotDir,
    homeDir,
    profile: 'web',
    snapshotsRoot: path.join(dataDir, 'snapshots'),
  };
  return { dataDir, homeDir, snapshotDir, opts };
}

const makeRecovery = (dataDir: string): Phase3Recovery =>
  new Phase3Recovery({ dataDir, packageVersion: '0.1.79', environmentFingerprint: 'fp-restore-crash' });

const lockCtx = (): { token: { tokenId: string; managerId: string; instanceId: string; acquiredAt: number } } => ({
  token: { tokenId: 't-cli', managerId: 'm-cli', instanceId: 'cli-resume-test', acquiredAt: Date.now() },
});

test('C-01 没有事故：探测 resumable=false 且 reason=null（不是拒绝，也不吓用户）', async (t) => {
  const f = await makeFixture(workdir(t));
  const probe = await probeCliRestoreResume(makeRecovery(f.dataDir), f.opts);
  assert.deepEqual(probe, { resumable: false, reason: null, done: 0, todo: 0 });
});

test('C-02 真崩溃后续跑：探测给出 done/todo，续跑只做剩下的动作并解除 SAFE MODE', async (t) => {
  const f = await makeFixture(workdir(t));
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [childPath, path.dirname(f.dataDir), 'crash', '2'], { stdio: 'ignore' });
    child.on('close', (c) => resolve(c));
  });
  assert.ok(code === null || (process.platform === 'win32' && code === 1), `子进程应被杀（实际 exit ${String(code)}）`);

  const recovery = makeRecovery(f.dataDir);
  // 模拟崩溃后宿主把 SAFE MODE 落盘的现场（标记存在 + 有 active journal）
  await recovery.store.writeSafeMode(true);

  const probe = await probeCliRestoreResume(recovery, f.opts);
  assert.equal(probe.resumable, true, probe.reason ?? '');
  assert.equal(probe.done, 1);
  assert.equal(probe.todo, 2);

  const out = await runCliRestore(recovery, f.opts, lockCtx() as never);
  assert.ok(out.resumed !== null, '必须走续跑路径');
  assert.equal(out.resumed.done, 1);
  assert.equal(out.resumed.todo, 2);
  assert.deepEqual([...out.report.restored].sort(), ['cordis.patch.yml', 'extra.yaml']);
  assert.equal(out.safeModeCleared, true, '续跑成功后应解除 SAFE MODE');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'transactions', 'safe-mode'), 'utf8').catch(() => 'absent'), 'absent');

  for (const [rel, text] of Object.entries(SNAPSHOT)) {
    assert.equal(await fs.readFile(path.join(f.homeDir, rel), 'utf8'), text, rel);
  }
  assert.deepEqual(await recovery.store.scanActive(), []);
  void f.snapshotDir;
});
