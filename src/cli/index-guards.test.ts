/**
 * CLI 守卫单测（本轮修复的四条纪律，全部是「不能悄悄放过」的行为）：
 *  ① 参数白名单：verify 不再悄悄接受 --dry-run / --profile / --settings；
 *  ② snapshots / restore 的「快照目录读不出来」必须区别于「没有快照」（非 0 退出 + stderr）；
 *  ③ restore 的第三道写入门：本机有 DSH 在跑 → 拒绝（且 dry-run 不受影响）；
 *  ④ web 的四个目录从**同一个 root** 派生（--data-dir 尾段命中 snapshots/exports 时上溯一层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCli, resolveWebPaths, runCli, type CliIo } from './index.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cli-guards-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function captureIo(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const io: CliIo = { log: (s) => out.push(s), error: (s) => out.push(s) };
  return { io, out };
}

/* ---------------------------------------------------------------- ① 参数白名单 */

test('G-01 verify 必须拒绝 --dry-run / --profile / --settings（不得悄悄接受并忽略）', () => {
  for (const args of [
    ['verify', '--dry-run'],
    ['verify', '--profile', 'dev'],
    ['verify', '--settings', '/s/settings.yaml'],
  ]) {
    assert.equal(parseCli(args).ok, false, '应拒绝: ' + args.join(' '));
  }
  // --id 是 verify 位置参数的等价写法（见 help 的 verify 段），必须继续可用。
  const byId = parseCli(['verify', '--id', 'backup.zip']);
  assert.ok(byId.ok);
  assert.equal(byId.options.id, 'backup.zip');
});

test('G-02 其它命令也按「真正用到才放行」拒绝 restore 系参数', () => {
  assert.equal(parseCli(['snapshots', '--profile', 'dev']).ok, false, 'snapshots 不用 --profile');
  assert.equal(parseCli(['snapshots', '--settings', '/s']).ok, false, 'snapshots 不用 --settings');
  assert.equal(parseCli(['snapshots', '--dry-run']).ok, false, 'snapshots 不用 --dry-run');
  // 反向：真正用到这些参数的命令必须继续放行（不能为了「统一拒绝」把它们一起打死）。
  assert.ok(parseCli(['reinstall', '--dry-run']).ok, 'reinstall 真的用 --dry-run');
  assert.ok(parseCli(['backup', '--dry-run']).ok, 'backup 真的用 --dry-run');
  assert.ok(parseCli(['import', '--from', 'claude-code', '--dry-run']).ok, 'import 真的用 --dry-run');
  const web = parseCli(['web', '--profile', 'dev']);
  assert.ok(web.ok, 'web 真的用 --profile（救急台「恢复」页的目标档案）');
  assert.equal(web.options.profile, 'dev');
  assert.ok(parseCli(['restore', '--id', 'x', '--dry-run', '--profile', 'dev', '--settings', '/s']).ok, 'restore 全都要');
});

/* ---------------------------------------------------------------- ② 读不到 ≠ 没有 */

test('G-03 snapshots：快照目录读不出来 → stderr 说明 + 非 0 退出（绝不显示成「无快照」）', async () => {
  await withTmp(async (tmp) => {
    // 用一个**普通文件**占住快照目录路径：readdir 必失败（ENOTDIR），且不是「目录不存在」。
    const dataDir = path.join(tmp, 'snapshots-as-file');
    await fs.writeFile(dataDir, 'not a directory', 'utf8');
    const { io, out } = captureIo();
    const code = await runCli(['snapshots', '--data-dir', dataDir], io, { DSH_HOME: path.join(tmp, 'home') });
    assert.equal(code, 1, '读不出来必须非 0 退出');
    const text = out.join('\n');
    assert.match(text, /快照目录读不出来/, '必须把事实打到 stderr');
    assert.doesNotMatch(text, /无快照/, '不得显示成「没有快照」');
  });
});

test('G-04 restore：默认挑快照时目录读不出来 → 如实打印 + 非 0 退出', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'snapshots-as-file');
    await fs.writeFile(dataDir, 'not a directory', 'utf8');
    const { io, out } = captureIo();
    const code = await runCli(['restore', '--data-dir', dataDir], io, { DSH_HOME: path.join(tmp, 'home') });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /快照目录读不出来/);
  });
});

test('G-05 没有快照（目录不存在）仍照旧：snapshots 返回 0 并打印「无快照」', async () => {
  await withTmp(async (tmp) => {
    const { io, out } = captureIo();
    const code = await runCli(['snapshots', '--data-dir', path.join(tmp, 'missing')], io, { DSH_HOME: path.join(tmp, 'home') });
    assert.equal(code, 0, '目录不存在 ≠ 读不出来（core 的 listSnapshots 只有 ENOENT 才算没有）');
    assert.match(out.join('\n'), /无快照/);
  });
});

/* ---------------------------------------------------------------- ③ restore 的第三道门 */

/** 造一个「可恢复」的最小快照 + 当前 home 文件。 */
async function seedRestorableSnapshot(tmp: string): Promise<{ homeDir: string; dataDir: string; id: string }> {
  const homeDir = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'snapshots');
  const id = 'snap-guard-1';
  const dir = path.join(dataDir, id);
  await fs.mkdir(path.join(dir, 'blobs', 'host'), { recursive: true });
  await fs.writeFile(path.join(dir, 'blobs', 'host', 'settings'), 'SNAPSHOT settings\n', 'utf8');
  await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({
    id, createdAt: '2026-08-14T12:00:00.000Z', sourceZip: 'backup.zip', status: 'done',
    entries: [],
    hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true }],
    beforePlugins: [],
  }), 'utf8');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(path.join(homeDir, 'settings.yaml'), 'CURRENT settings\n', 'utf8');
  // 心跳落在候选控制根之一（--data-dir 本身）下：pid 用本进程 → 判定为「正在跑」
  await fs.mkdir(path.join(dataDir, 'running'), { recursive: true });
  return { homeDir, dataDir, id };
}

test('G-06 restore：本机有 DSH 在跑 → 拒绝执行（与救急台 checkWriteGates 同源）', async () => {
  await withTmp(async (tmp) => {
    const { homeDir, dataDir, id } = await seedRestorableSnapshot(tmp);
    await fs.writeFile(path.join(dataDir, 'running', 'web.json'), JSON.stringify({
      schemaVersion: 1, name: 'web', pid: process.pid, port: 3099,
      startedAt: new Date().toISOString(), updatedAt: Date.now(),
    }), 'utf8');

    const { io, out } = captureIo();
    const code = await runCli(['restore', '--id', id, '--data-dir', dataDir], io, { DSH_HOME: homeDir });
    assert.equal(code, 1, 'DSH 在跑时恢复必须被拒绝');
    const text = out.join('\n');
    assert.match(text, /检测到 DSH 正在运行/);
    assert.match(text, /dcm web/, '必须给出「起不来时」的出口');
    assert.equal(
      await fs.readFile(path.join(homeDir, 'settings.yaml'), 'utf8'),
      'CURRENT settings\n',
      '被拒绝时一个字节都不许改',
    );
  });
});

test('G-07 restore --dry-run：DSH 在跑也照旧只打印计划（门只在真实执行前）', async () => {
  await withTmp(async (tmp) => {
    const { homeDir, dataDir, id } = await seedRestorableSnapshot(tmp);
    await fs.writeFile(path.join(dataDir, 'running', 'web.json'), JSON.stringify({
      schemaVersion: 1, name: 'web', pid: process.pid, port: 3099,
      startedAt: new Date().toISOString(), updatedAt: Date.now(),
    }), 'utf8');

    const { io, out } = captureIo();
    const code = await runCli(['restore', '--dry-run', '--id', id, '--data-dir', dataDir], io, { DSH_HOME: homeDir });
    assert.equal(code, 0, 'dry-run 零写入，不受写入门影响');
    assert.match(out.join('\n'), /动作计划/);
    assert.equal(await fs.readFile(path.join(homeDir, 'settings.yaml'), 'utf8'), 'CURRENT settings\n');
  });
});

/* ---------------------------------------------------------------- ④ web 目录派生 */

test('G-08 resolveWebPaths：快照/导出/锁/数据根四处必须同源（--data-dir 只上溯一次）', () => {
  // 统一先 resolve：Windows 下 '\\root' 是「当前盘符根」，函数内部也会 resolve，避免断言口径不一致。
  const homeDsh = path.resolve(path.sep, 'home', 'dsh');
  const root = path.resolve(path.sep, 'root');
  const env = { DSH_HOME: homeDsh } as Record<string, string | undefined>;

  // 尾段命中 snapshots：上溯一层当作 root，四个目录都挂在它下面。
  const fromSnapshots = resolveWebPaths({ dataDir: path.join(root, 'snapshots') }, env);
  assert.equal(fromSnapshots.root, root);
  assert.equal(fromSnapshots.dataDir, root);
  assert.equal(fromSnapshots.snapshotsDir, path.join(root, 'snapshots'));
  assert.equal(fromSnapshots.exportsDir, path.join(root, 'exports'), '导出目录也必须上溯（不再挂到 leaf 下）');
  assert.equal(fromSnapshots.locksDir, path.join(root, 'locks'));

  // exports 同理
  const fromExports = resolveWebPaths({ dataDir: path.join(root, 'exports') }, env);
  assert.equal(fromExports.snapshotsDir, path.join(root, 'snapshots'));
  assert.equal(fromExports.exportsDir, path.join(root, 'exports'));

  // 直接给数据根
  const fromRoot = resolveWebPaths({ dataDir: root }, env);
  assert.equal(fromRoot.snapshotsDir, path.join(root, 'snapshots'));
  assert.equal(fromRoot.exportsDir, path.join(root, 'exports'));

  // --data-root 恒为准（即使同时给了 leaf 形态的 --data-dir）
  const other = path.resolve(path.sep, 'other');
  const explicitRoot = resolveWebPaths({ dataRoot: other, dataDir: path.join(root, 'snapshots') }, env);
  assert.equal(explicitRoot.root, other);
  assert.equal(explicitRoot.snapshotsDir, path.join(other, 'snapshots'));

  // 都没给：缺省根 = $DSH_HOME/dsh-config-manager
  const defaults = resolveWebPaths({}, env);
  assert.equal(defaults.root, path.join(homeDsh, 'dsh-config-manager'));
});
