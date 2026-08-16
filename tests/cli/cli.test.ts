/**
 * M3 CLI 基础单测（criterion m3-cli-works；正式 TDD 证据归 t5 tester）。
 * 覆盖：参数解析纯函数（parseCli）、数据目录/home 解析（resolveDataDir/resolveDshHome）、
 * 缺省快照选择（pickDefaultSnapshotId）、id 校验，以及 runCli 端到端冒烟
 * （snapshots 列表 / restore --dry-run 计划 / restore 执行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseCli, pickDefaultSnapshotId, resolveDataDir, resolveDshHome,
  runCli, validateSnapshotId, type CliIo,
} from '../../src/cli/index.ts';
import type { Snapshot } from '../../src/core/types.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cli-m3-'));
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

test('C-01 parseCli：子命令/help/未知命令/缺值/未知参数/子命令限定', () => {
  assert.equal(parseCli([]).ok, false, '无参数 → 错误');
  for (const args of [['--help'], ['-h'], ['help']]) {
    const r = parseCli(args);
    assert.equal(r.ok && r.options.command, 'help');
  }
  assert.equal(parseCli(['frobnicate']).ok, false, '未知子命令 → 错误');

  const snap = parseCli(['snapshots']);
  assert.ok(snap.ok);
  assert.equal(snap.options.command, 'snapshots');
  assert.equal(snap.options.dryRun, false);
  assert.equal(snap.options.profile, 'web');
  const snapDir = parseCli(['snapshots', '--data-dir', '/tmp/snaps']);
  assert.ok(snapDir.ok);
  assert.equal(snapDir.options.dataDir, '/tmp/snaps');
  assert.equal(parseCli(['snapshots', '--id', 'x']).ok, false, 'snapshots 不允许 --id');
  assert.equal(parseCli(['snapshots', '--dry-run']).ok, false, 'snapshots 不允许 --dry-run');

  const rest = parseCli(['restore', '--dry-run', '--id', 'abc-123', '--profile', 'dev', '--settings', '/s/settings.yaml']);
  assert.ok(rest.ok);
  assert.equal(rest.options.command, 'restore');
  assert.equal(rest.options.dryRun, true);
  assert.equal(rest.options.id, 'abc-123');
  assert.equal(rest.options.profile, 'dev');
  assert.equal(rest.options.settings, '/s/settings.yaml');
  assert.equal(parseCli(['restore', '--data-dir']).ok, false, '缺值 → 错误');
  assert.equal(parseCli(['restore', '--bogus']).ok, false, '未知参数 → 错误');
});

test('C-02 resolveDataDir/resolveDshHome：DSH_HOME 环境变量与缺省 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/home' }), '/custom/home');
  assert.equal(resolveDshHome({ DSH_HOME: '' }), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
  assert.equal(
    resolveDataDir(undefined, { DSH_HOME: '/custom/home' }),
    path.join('/custom/home', 'dsh-config-manager', 'snapshots'),
  );
  assert.equal(resolveDataDir('/flag/dir', { DSH_HOME: '/custom/home' }), '/flag/dir', '--data-dir 覆盖');
});

test('C-03 pickDefaultSnapshotId：取最近非 rolled-back；全回滚/空 → null', () => {
  const mk = (id: string, status?: Snapshot['status']) => ({
    id, createdAt: '2026-01-01T00:00:00.000Z', sourceZip: 'x.zip', status,
    entryCount: 0, hostFileBackupCount: 0, beforePluginCount: 0,
  });
  assert.equal(pickDefaultSnapshotId([mk('r', 'rolled-back'), mk('d', 'done'), mk('old')]), 'd', '跳过 rolled-back 取最近非回滚');
  assert.equal(pickDefaultSnapshotId([mk('r1', 'rolled-back'), mk('r2', 'rolled-back')]), null, '全部回滚 → null');
  assert.equal(pickDefaultSnapshotId([]), null, '空列表 → null');
  assert.equal(pickDefaultSnapshotId([mk('p', 'pending')]), 'p', 'pending 可用');
});

test('C-04 validateSnapshotId：拒绝路径分隔符与保留名', () => {
  assert.equal(validateSnapshotId('3f2b1c0e-1234-5678-9abc-def012345678'), '3f2b1c0e-1234-5678-9abc-def012345678');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
    assert.throws(() => validateSnapshotId(bad), undefined, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('C-05 runCli snapshots：列出快照表格', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'snapshots');
    const id = 'snap-cli-1';
    const dir = path.join(dataDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({
      id, createdAt: '2026-08-14T12:00:00.000Z', sourceZip: 'backup.zip', status: 'done',
      entries: [], hostFileBackups: [], beforePlugins: [],
    }), 'utf8');

    const { io, out } = captureIo();
    const code = await runCli(['snapshots', '--data-dir', dataDir], io, {});
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.ok(text.includes('ID'), '表头含 ID');
    assert.ok(text.includes('snap-cli-1'), '列出快照 id');
    assert.ok(text.includes('backup.zip'), '列出来源备份');
  });
});

test('C-06 runCli restore --dry-run：打印计划；缺省 --id 自动选择', async () => {
  await withTmp(async (tmp) => {
    const homeDir = path.join(tmp, 'home');
    const dataDir = path.join(tmp, 'snapshots');
    const id = 'snap-cli-2';
    const dir = path.join(dataDir, id);
    await fs.mkdir(path.join(dir, 'blobs', 'host'), { recursive: true });
    await fs.writeFile(path.join(dir, 'blobs', 'host', 'settings'), 'SNAPSHOT settings\n', 'utf8');
    await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({
      id, createdAt: '2026-08-14T12:00:00.000Z', sourceZip: 'backup.zip', status: 'done',
      entries: [],
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true }],
      beforePlugins: [{ name: 'dsh-ssh', version: '0.1.12', enabled: true }],
    }), 'utf8');
    // 当前 settings.yaml 存在（可还原）
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, 'settings.yaml'), 'CURRENT settings\n', 'utf8');

    const { io, out } = captureIo();
    // 不传 --id：应自动选中该快照
    const code = await runCli(['restore', '--dry-run', '--data-dir', dataDir, '--profile', 'web'], io, { DSH_HOME: homeDir });
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.ok(text.includes('动作计划'), 'dry-run 打印计划');
    assert.ok(text.includes('整文件还原 settings.yaml'), '计划含整文件还原动作');
    assert.ok(text.includes('无导入期间新增插件'), '基线内无新增插件 → 提示');
  });
});

test('C-07 runCli restore 执行：整文件还原 + 诚实报告 + 退出码', async () => {
  await withTmp(async (tmp) => {
    const homeDir = path.join(tmp, 'home');
    const dataDir = path.join(tmp, 'snapshots');
    const id = 'snap-cli-3';
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

    const { io, out } = captureIo();
    const code = await runCli(['restore', '--id', id, '--data-dir', dataDir, '--profile', 'web'], io, { DSH_HOME: homeDir });
    assert.equal(code, 0, '无失败项 → exit 0');
    const text = out.join('\n');
    assert.ok(text.includes('恢复完成'), '输出恢复报告');
    assert.ok(text.includes('settings.yaml'), '报告含已还原文件');
    assert.equal(await fs.readFile(path.join(homeDir, 'settings.yaml'), 'utf8'), 'SNAPSHOT settings\n', 'settings.yaml 已还原为快照内容');
    // pre-restore 双保险
    const pre = path.join(dir, 'pre-restore');
    const names = await fs.readdir(pre);
    assert.equal(names.length, 1, 'pre-restore 应有 1 份当前文件副本');
    assert.equal(await fs.readFile(path.join(pre, names[0]!), 'utf8'), 'CURRENT settings\n');
  });
});

test('C-08 runCli：无可用快照 / 非法 id / 未知命令 → 非零退出', async () => {
  await withTmp(async (tmp) => {
    const emptyDir = path.join(tmp, 'empty-snapshots');
    await fs.mkdir(emptyDir, { recursive: true });
    const { io, out } = captureIo();
    const code1 = await runCli(['restore', '--data-dir', emptyDir], io, { DSH_HOME: path.join(tmp, 'home') });
    assert.equal(code1, 1, '无可用快照 → exit 1');
    assert.ok(out.join('\n').includes('没有可用快照'));

    const code2 = await runCli(['restore', '--id', '../evil', '--data-dir', emptyDir], io, { DSH_HOME: path.join(tmp, 'home') });
    assert.equal(code2, 1, '非法 id → exit 1');

    const code3 = await runCli(['frobnicate'], io, {});
    assert.equal(code3, 1, '未知子命令 → exit 1');
  });
});

test('C-09 runCli restore --dry-run：零写入（不还原文件、不建 pre-restore）', async () => {
  await withTmp(async (tmp) => {
    const homeDir = path.join(tmp, 'home');
    const dataDir = path.join(tmp, 'snapshots');
    const id = 'snap-cli-9';
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

    const { io, out } = captureIo();
    const code = await runCli(['restore', '--dry-run', '--id', id, '--data-dir', dataDir, '--profile', 'web'], io, { DSH_HOME: homeDir });
    assert.equal(code, 0, 'dry-run 正常退出 0');
    assert.equal(
      await fs.readFile(path.join(homeDir, 'settings.yaml'), 'utf8'),
      'CURRENT settings\n',
      'dry-run 不得写入 settings.yaml',
    );
    assert.ok(!out.join('\n').includes('恢复完成'), 'dry-run 不打印执行报告');
    await assert.rejects(
      fs.readdir(path.join(dir, 'pre-restore')),
      undefined,
      'dry-run 不得创建 pre-restore 副本目录',
    );
  });
});
