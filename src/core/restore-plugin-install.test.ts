/**
 * issue #132 undo 面：跟远端删掉插件的**反向补偿** —— 快照里记录过 pluginRemovals 的包，
 * 恢复时若本机已缺就装回（复现被删的那一版），本机已存在则跳过。
 *
 * 为什么只认快照里记录过的名字、不按 beforePlugins 反推「缺了就是被删了」：
 * 手动卸载 / 换包也会让基线里的名字消失，按差集重装等于替用户改主意（判据见 planRestore 的 2') 段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { planRestore, restore } from './restore.ts';
import type { Snapshot } from './types.ts';

const SNAP_ID = 'snap-132-plugin-install';
const PKG = '@deepseek-ai/dsh-ssh';
const VERSION = '1.0.0';
const TARGET = `${PKG}@${VERSION}`;

interface Fixture {
  homeDir: string;
  snapshotDir: string;
  profileDir: string;
}

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-132-install-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 快照目录：无 entries / 无 hostFileBackups、基线为空（→ 不会产出 pluginRemove），只有 pluginRemovals。 */
async function makeFixture(workDir: string): Promise<Fixture> {
  const homeDir = path.join(workDir, 'home');
  const profileDir = path.join(homeDir, 'profiles', 'web');
  const snapshotDir = path.join(workDir, 'data', 'snapshots', SNAP_ID);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-11-10T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: [],
    pluginRemovals: [{ name: PKG, version: VERSION, target: TARGET }],
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  return { homeDir, snapshotDir, profileDir };
}

async function writeInstalledProfile(profileDir: string, deps: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', dependencies: deps }, null, 2)}\n`,
    'utf8',
  );
}

test('132-R1 记录过跟删的包在本机缺失 → 计划出 pluginInstall（target=name、pluginTarget=name@version）', async (t) => {
  const f = await makeFixture(workdir(t));
  const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

  const installs = plan.actions.filter((a) => a.kind === 'pluginInstall');
  assert.equal(installs.length, 1, '应恰好规划一条重装动作');
  assert.equal(installs[0]!.target, PKG);
  assert.equal(installs[0]!.pluginName, PKG);
  assert.equal(installs[0]!.pluginTarget, TARGET, '重装目标必须钉住被删时的版本');
  assert.equal(plan.summary.pluginInstalls, 1);
  assert.equal(plan.summary.pluginRemoves, 0, '基线为空且本机无任何已装 ⇒ 不应产出卸载');
});

test('132-R2 本机已装回（profile dependencies 里有该包）→ 计划转成 skip，不重复装', async (t) => {
  const f = await makeFixture(workdir(t));
  await writeInstalledProfile(f.profileDir, { [PKG]: '^1.0.0' });

  const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
  assert.equal(plan.actions.filter((a) => a.kind === 'pluginInstall').length, 0);
  assert.equal(plan.summary.pluginInstalls, 0);
  assert.ok(
    plan.actions.some((a) => a.kind === 'skip' && a.description.includes(PKG)),
    '已装应留下一条带包名的 skip 说明',
  );
});

test('132-R3 执行面：重装成功进 report.installedPlugins，失败进 report.failed 且不静默', async (t) => {
  const f = await makeFixture(workdir(t));
  const seen: string[] = [];
  const okReport = await restore({
    snapshotDir: f.snapshotDir,
    homeDir: f.homeDir,
    profile: 'web',
    pluginInstaller: async (name, target) => {
      seen.push(`${name}=>${target}`);
      return { ok: true };
    },
  });
  assert.deepEqual(seen, [`${PKG}=>${TARGET}`], '重装器必须收到包名与被删版本组成的 target');
  assert.deepEqual(okReport.installedPlugins, [TARGET]);
  assert.deepEqual(okReport.failed, []);

  const failReport = await restore({
    snapshotDir: f.snapshotDir,
    homeDir: f.homeDir,
    profile: 'web',
    pluginInstaller: async () => ({ ok: false, message: 'dsh plugin add 失败：registry 不可达' }),
  });
  assert.deepEqual(failReport.installedPlugins, []);
  assert.equal(failReport.failed.length, 1);
  assert.equal(failReport.failed[0]!.item, `plugin:${PKG}`);
  assert.match(failReport.failed[0]!.reason, /registry 不可达/);
});
