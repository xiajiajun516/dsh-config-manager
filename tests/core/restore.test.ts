/**
 * M2 离线恢复引擎基础单测（criterion m2-restore-restores；正式 TDD 证据归 t5 tester）。
 * 覆盖：planRestore 动作计划（整文件还原/删除、插件撤销、file 补偿、credentials 提示、
 * 旧快照缺基线兼容）、restore 执行（blob 写回、pre-restore 双保险、诚实报告）、
 * listSnapshots 倒序扫描。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listSnapshots, planRestore, restore } from '../../src/core/restore.ts';
import type { HostFileBackup, Snapshot, SnapshotEntry } from '../../src/core/types.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-restore-m2-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface Fixture {
  tmp: string;
  homeDir: string;
  snapshotDir: string;
  snapshotId: string;
}

/** 构造快照目录：snapshot.json + blobs，返回 fixture */
async function makeFixture(
  tmp: string,
  snapshot: Snapshot,
  blobs: Record<string, string> = {},
): Promise<Fixture> {
  const homeDir = path.join(tmp, 'home');
  const snapshotDir = path.join(tmp, 'snapshots', snapshot.id);
  await fs.mkdir(path.join(snapshotDir, 'blobs'), { recursive: true });
  for (const [blobPath, content] of Object.entries(blobs)) {
    const target = path.join(snapshotDir, blobPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  return { tmp, homeDir, snapshotDir, snapshotId: snapshot.id };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-m2-1',
    createdAt: '2026-08-14T12:00:00.000Z',
    sourceZip: 'backup.zip',
    entries: [],
    status: 'done',
    beforePlugins: [{ name: 'dsh-ssh', version: '0.1.12', enabled: true }],
    hostFileBackups: [],
    ...overrides,
  };
}

const HOST_BACKUPS: HostFileBackup[] = [
  { relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true },
  { relPath: 'cordis.patch.yml', blobPath: 'blobs/host/user-patch', existed: true },
  { relPath: 'profiles/web/cordis.patch.yml', blobPath: '', existed: false },
];

const FILE_ENTRY: SnapshotEntry = {
  kind: 'file', adapter: 'skills', ref: 'coding.md',
  before: { contentHash: 'hash' }, existed: true,
  copiedTo: 'blobs/skills-coding', snapshotId: 'snap-m2-1',
};

/** 写入当前目标状态：settings.yaml 现有 + skills/coding.md 现有 + profile package.json 装了两个插件 */
async function seedCurrent(f: Fixture): Promise<void> {
  await fs.mkdir(path.join(f.homeDir, 'skills'), { recursive: true });
  await fs.writeFile(path.join(f.homeDir, 'settings.yaml'), 'CURRENT settings\n', 'utf8');
  await fs.writeFile(path.join(f.homeDir, 'skills', 'coding.md'), 'CURRENT skill\n', 'utf8');
  // profile 已装插件：dsh-ssh（基线内）+ dsh-find-plugin（导入期间新增）
  await fs.mkdir(path.join(f.homeDir, 'profiles', 'web'), { recursive: true });
  // 快照时不存在、现已出现的 profile patch（应被移除）
  await fs.writeFile(path.join(f.homeDir, 'profiles', 'web', 'cordis.patch.yml'), '- id: added-line\n', 'utf8');
  await fs.writeFile(
    path.join(f.homeDir, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dependencies: { 'dsh-ssh': '0.1.12', 'dsh-find-plugin': '1.0.0' } }, null, 2),
    'utf8',
  );
}

test('R-01 planRestore：整文件还原 + 新增插件卸载 + file 补偿 + 凭据提示 + 越界防护', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      entries: [
        FILE_ENTRY,
        { kind: 'credential', adapter: 'credentialsStatus', ref: 'DEEPSEEK_API_KEY', before: null, existed: true },
      ],
      hostFileBackups: HOST_BACKUPS,
    });
    const f = await makeFixture(tmp, snapshot, {
      'blobs/host/settings': 'SNAPSHOT settings\n',
      'blobs/host/user-patch': '- id: snapshot-line\n',
      'blobs/skills-coding': 'SNAPSHOT skill\n',
    });
    await seedCurrent(f);

    const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

    assert.equal(plan.snapshotId, 'snap-m2-1');
    assert.equal(plan.pluginBaselineConfirmed, true);

    const byKind = (kind: string) => plan.actions.filter((a) => a.kind === kind);
    // 整文件还原
    const hostRestores = byKind('hostFileRestore');
    assert.deepEqual(
      hostRestores.map((a) => a.target).sort(),
      ['cordis.patch.yml', 'settings.yaml'],
      'settings.yaml 与用户层 patch 应整文件还原',
    );
    const settingsAction = hostRestores.find((a) => a.target === 'settings.yaml');
    assert.equal(settingsAction?.isSettings, true, 'settings.yaml 动作应标注 isSettings');
    // 快照时不存在、现已出现的 profile patch → 删除
    const removes = byKind('hostFileRemove');
    assert.deepEqual(removes.map((a) => a.target), ['profiles/web/cordis.patch.yml']);
    // 插件撤销：仅新增的 dsh-find-plugin
    assert.deepEqual(byKind('pluginRemove').map((a) => a.pluginName), ['dsh-find-plugin']);
    // file 补偿
    assert.deepEqual(byKind('fileRestore').map((a) => a.target), ['skills/coding.md']);
    // 凭据提示
    const hints = byKind('credentialHint');
    assert.equal(hints.length, 1);
    assert.match(hints[0]!.manualHint ?? '', /DEEPSEEK_API_KEY/);
    // 汇总
    assert.equal(plan.summary.hostFileRestores, 2);
    assert.equal(plan.summary.hostFileRemoves, 1);
    assert.equal(plan.summary.pluginRemoves, 1);
    assert.equal(plan.summary.fileRestores, 1);
    assert.equal(plan.summary.credentialHints, 1);
  });
});

test('R-02 旧快照（无 beforePlugins/hostFileBackups）兼容：不计划插件卸载，只提示', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      beforePlugins: undefined,
      hostFileBackups: undefined,
      entries: [
        FILE_ENTRY,
        { kind: 'settingsNamespace', adapter: 'settings', ref: 'general', before: { theme: 'dark' }, revision: 3, existed: true },
      ],
    });
    const f = await makeFixture(tmp, snapshot, { 'blobs/skills-coding': 'SNAPSHOT skill\n' });
    await seedCurrent(f);

    const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

    assert.equal(plan.pluginBaselineConfirmed, false);
    assert.ok(!plan.actions.some((a) => a.kind === 'pluginRemove'), '无基线 → 不得计划插件卸载');
    const notes = plan.actions.filter((a) => a.kind === 'skip');
    assert.ok(notes.some((a) => a.description.includes('beforePlugins 基线')), '应提示缺基线');
    assert.ok(notes.some((a) => a.description.includes('settings namespace')), '应提示 namespace 需在线回滚');
    // file 条目仍可离线补偿（与基线无关）
    assert.ok(plan.actions.some((a) => a.kind === 'fileRestore' && a.target === 'skills/coding.md'));
  });
});

test('R-03 restore 执行：blob 写回 + pre-restore 双保险 + 插件卸载 + 诚实报告', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      entries: [FILE_ENTRY],
      hostFileBackups: HOST_BACKUPS,
    });
    const f = await makeFixture(tmp, snapshot, {
      'blobs/host/settings': 'SNAPSHOT settings\n',
      'blobs/host/user-patch': '- id: snapshot-line\n',
      'blobs/skills-coding': 'SNAPSHOT skill\n',
    });
    await seedCurrent(f);

    const uninstalled: string[] = [];
    const report = await restore({
      snapshotDir: f.snapshotDir,
      homeDir: f.homeDir,
      profile: 'web',
      pluginUninstaller: async (name) => { uninstalled.push(name); return { ok: true }; },
    });

    assert.equal(report.snapshotId, 'snap-m2-1');
    assert.equal(await fs.readFile(path.join(f.homeDir, 'settings.yaml'), 'utf8'), 'SNAPSHOT settings\n', 'settings.yaml 整文件还原');
    assert.equal(await fs.readFile(path.join(f.homeDir, 'skills', 'coding.md'), 'utf8'), 'SNAPSHOT skill\n', 'file 条目 blob 还原');
    assert.equal(
      await fs.readFile(path.join(f.homeDir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').then(() => 'exists').catch(() => 'gone'),
      'gone',
      '快照时不存在、现已出现的 profile patch 应被删除',
    );
    assert.deepEqual(uninstalled, ['dsh-find-plugin'], '插件卸载走注入卸载器');
    assert.deepEqual(report.removedPlugins, ['dsh-find-plugin']);
    assert.ok(report.restored.includes('settings.yaml'));
    assert.ok(report.restored.includes('skills/coding.md'));
    assert.ok(report.restored.includes('profiles/web/cordis.patch.yml'), '删除项也计入 restored（已回到快照状态）');

    // pre-restore 双保险：3 个当前文件（settings.yaml / coding.md / profile patch）各有副本
    const pre = path.join(f.snapshotDir, 'pre-restore');
    const names = await fs.readdir(pre);
    assert.equal(names.length, 3, `pre-restore 应有 3 份副本，实际: ${names.join(',')}`);
    const settingsPre = names.find((n) => n.endsWith('settings.yaml'));
    assert.ok(settingsPre, 'pre-restore 含 settings.yaml 副本');
    assert.equal(await fs.readFile(path.join(pre, settingsPre!), 'utf8'), 'CURRENT settings\n', '副本是还原前的当前内容');
  });
});

test('R-04 restore 失败项如实报告（卸载失败不拖垮其余）', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true }],
    });
    const f = await makeFixture(tmp, snapshot, { 'blobs/host/settings': 'SNAPSHOT settings\n' });
    await seedCurrent(f);

    const report = await restore({
      snapshotDir: f.snapshotDir,
      homeDir: f.homeDir,
      profile: 'web',
      pluginUninstaller: async () => ({ ok: false, message: '模拟 pnpm 卸载失败' }),
    });

    assert.ok(report.restored.includes('settings.yaml'), '整文件还原仍成功');
    assert.ok(report.failed.some((x) => x.item === 'plugin:dsh-find-plugin' && x.reason.includes('模拟 pnpm 卸载失败')), '卸载失败如实记录');
    assert.deepEqual(report.removedPlugins, []);
  });
});

test('R-05 listSnapshots：按 createdAt 倒序 + 损坏目录跳过 + 缺失目录空列表', async () => {
  await withTmp(async (tmp) => {
    const snapshotsDir = path.join(tmp, 'snapshots');
    await fs.mkdir(snapshotsDir, { recursive: true });
    const mk = async (id: string, createdAt: string, status?: string) => {
      const dir = path.join(snapshotsDir, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({
        id, createdAt, sourceZip: `${id}.zip`, status,
        entries: [{ kind: 'file', adapter: 'skills', ref: 'a.md' }],
        hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'x', existed: true }],
        beforePlugins: [{ name: 'p1', version: '1', enabled: true }],
      }), 'utf8');
    };
    await mk('old', '2026-01-01T00:00:00.000Z', 'done');
    await mk('new', '2026-08-14T12:00:00.000Z', 'pending');
    // 损坏目录（无 snapshot.json / 非法 JSON）应跳过
    await fs.mkdir(path.join(snapshotsDir, 'broken'), { recursive: true });
    await fs.writeFile(path.join(snapshotsDir, 'broken', 'snapshot.json'), 'not json{{{', 'utf8');
    await fs.mkdir(path.join(snapshotsDir, 'empty'));

    const metas = await listSnapshots(snapshotsDir);
    assert.deepEqual(metas.map((m) => m.id), ['new', 'old'], '按 createdAt 倒序');
    const newest = metas[0]!;
    assert.equal(newest.status, 'pending');
    assert.equal(newest.entryCount, 1);
    assert.equal(newest.hostFileBackupCount, 1);
    assert.equal(newest.beforePluginCount, 1);
    assert.equal(newest.sourceZip, 'new.zip');

    assert.deepEqual(await listSnapshots(path.join(tmp, 'no-such-dir')), [], '目录缺失 → 空列表');
  });
});

test('R-06 planRestore 零写入：预览不还原文件、不删除文件、不建 pre-restore', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      entries: [FILE_ENTRY],
      hostFileBackups: HOST_BACKUPS,
    });
    const f = await makeFixture(tmp, snapshot, {
      'blobs/host/settings': 'SNAPSHOT settings\n',
      'blobs/host/user-patch': '- id: snapshot-line\n',
      'blobs/skills-coding': 'SNAPSHOT skill\n',
    });
    await seedCurrent(f);

    const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
    assert.equal(plan.actions.length, 5, '计划应含 5 项动作（2 还原 + 1 删除 + 1 卸载 + 1 提示）');

    // 预览后当前文件必须原封不动
    assert.equal(await fs.readFile(path.join(f.homeDir, 'settings.yaml'), 'utf8'), 'CURRENT settings\n', 'settings.yaml 未被还原');
    assert.equal(await fs.readFile(path.join(f.homeDir, 'skills', 'coding.md'), 'utf8'), 'CURRENT skill\n', 'skills 文件未被还原');
    assert.equal(
      await fs.readFile(path.join(f.homeDir, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').then(() => 'exists').catch(() => 'gone'),
      'exists',
      '快照时不存在、现已出现的文件在预览后仍存在（未删除）',
    );
    await assert.rejects(fs.readdir(path.join(f.snapshotDir, 'pre-restore')), undefined, '预览不得创建 pre-restore 目录');
  });
});
