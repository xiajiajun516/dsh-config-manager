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
    assert.deepEqual(report.ghostSessions, [], '无 sessions 分区条目 → 无幽灵会话');

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

test('R-07 F5 幽灵会话：恢复后校验快照会话 vs 磁盘实际文件，报告失效归档（混合场景）', async () => {
  await withTmp(async (tmp) => {
    // s1 blob 齐全 → 还原落盘；s2 blob 缺失 → 跳过（磁盘无文件 → 幽灵）；s3 快照时不存在 → 不参与判定
    const snapshot = makeSnapshot({
      beforePlugins: [],
      hostFileBackups: [],
      entries: [
        { kind: 'file', adapter: 'sessions', ref: 'proj-a/s1/session.jsonl.zstd', before: { contentHash: 'h1' }, existed: true, copiedTo: 'blobs/sess-s1', snapshotId: 'snap-m2-1' },
        { kind: 'file', adapter: 'sessions', ref: 'proj-b/s2/session.jsonl.zstd', before: { contentHash: 'h2' }, existed: true, copiedTo: 'blobs/sess-s2', snapshotId: 'snap-m2-1' },
        { kind: 'file', adapter: 'sessions', ref: 'proj-c/s3/session.jsonl.zstd', before: null, existed: false },
      ],
    });
    const f = await makeFixture(tmp, snapshot, { 'blobs/sess-s1': 'SESSION S1\n' });

    const report = await restore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

    // s1 还原落盘
    assert.equal(
      await fs.readFile(path.join(f.homeDir, 'sessions', 'proj-a', 's1', 'session.jsonl.zstd'), 'utf8'),
      'SESSION S1\n',
      's1 blob 写回磁盘',
    );
    // s2 blob 缺失 → 不落盘 → 幽灵；s3 existed=false 不参与
    assert.deepEqual(report.ghostSessions, ['proj-b/s2'], '仅磁盘缺失的会话算幽灵');
    assert.ok(report.skipped.some((s) => s.includes('proj-b/s2')), '幽灵会话汇总进入 skipped 供报告展示');
    // 磁盘事实核对：s2 目录不存在
    await assert.rejects(fs.access(path.join(f.homeDir, 'sessions', 'proj-b', 's2')), 's2 目录不存在');
  });
});

test('R-08 F5 幽灵会话：全部 blob 齐全 → 无幽灵', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      beforePlugins: [],
      hostFileBackups: [],
      entries: [
        { kind: 'file', adapter: 'sessions', ref: 'proj-a/s1/session.jsonl.zstd', before: { contentHash: 'h1' }, existed: true, copiedTo: 'blobs/sess-s1', snapshotId: 'snap-m2-1' },
      ],
    });
    const f = await makeFixture(tmp, snapshot, { 'blobs/sess-s1': 'SESSION S1\n' });

    const report = await restore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

    assert.deepEqual(report.ghostSessions, [], '磁盘存在全部期望会话 → 无幽灵');
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
    await assert.rejects(fs.readdir(path.join(f.snapshotDir, 'pre-restore')), '预览不得创建 pre-restore 目录');
  });
});

/* ------------- F-4：快照记录来源 DSH 版本 + 恢复时的可见版本告警（不阻断） ------------- */

/** 版本告警行 = 描述里同时出现两个版本串的 skip 动作（不依赖具体文案语言）。 */
function versionWarningOf(plan: Awaited<ReturnType<typeof planRestore>>, snapshotV: string, currentV: string) {
  return plan.actions.find((a) => a.kind === 'skip' && a.description.includes(snapshotV) && a.description.includes(currentV));
}

test('F-4 planRestore：两侧版本都已知且不同 → 末尾追加可见告警，恢复照常可执行', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({ dshVersion: '0.1.5-rc.1' });
    const f = await makeFixture(tmp, snapshot);

    const plan = await planRestore({
      snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', currentDshVersion: '0.2.0-rc.2',
    });

    assert.equal(plan.snapshotDshVersion, '0.1.5-rc.1', '计划必须回传快照记录的来源版本')
    assert.equal(plan.currentDshVersion, '0.2.0-rc.2', '计划必须回传本机当前版本')
    const warning = versionWarningOf(plan, '0.1.5-rc.1', '0.2.0-rc.2');
    assert.ok(warning !== undefined, '版本不同必须有一条**可见**告警动作（绝不静默）')
    assert.equal(warning?.kind, 'skip', '告警必须是零写入的信息行（不产生任何写动作）')
    assert.equal(plan.actions.at(-1), warning, '追加在末尾：既有动作下标不位移（snapshot-diff 按下标关联）')
    assert.equal(plan.summary.skips >= 1, true, '告警计入 skips（旧调用方的汇总口径不变）')
  });
});

test('F-4 planRestore：两侧版本相同 → 不产生任何版本告警', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({ dshVersion: '0.1.5-rc.1' });
    const f = await makeFixture(tmp, snapshot);
    const plan = await planRestore({
      snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', currentDshVersion: '0.1.5-rc.1',
    });
    assert.equal(versionWarningOf(plan, '0.1.5-rc.1', '0.1.5-rc.1'), undefined)
    assert.equal(plan.snapshotDshVersion, '0.1.5-rc.1')
    assert.equal(plan.currentDshVersion, '0.1.5-rc.1')
  });
});

test('F-4 planRestore：旧快照缺 dshVersion → 不告警，恢复路径一字不变', async () => {
  await withTmp(async (tmp) => {
    // 旧快照（没有该字段）—— 这是常态，必须仍可恢复、且不产生任何版本相关噪声
    const snapshot = makeSnapshot({ hostFileBackups: HOST_BACKUPS });
    const f = await makeFixture(tmp, snapshot, {
      'blobs/host/settings': 'SNAPSHOT settings\n',
      'blobs/host/user-patch': '- id: snapshot-line\n',
    });
    await seedCurrent(f);

    const plan = await planRestore({
      snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', currentDshVersion: '0.2.0-rc.2',
    });
    assert.equal(plan.snapshotDshVersion, undefined, '旧快照没记录版本 → 保持 undefined（不猜）')
    assert.equal(plan.currentDshVersion, '0.2.0-rc.2')
    assert.equal(
      plan.actions.some((a) => a.description.includes('0.2.0-rc.2')), false,
      '来源版本未知时绝不产出「版本不同」告警（那会是假阳性）',
    )
    assert.equal(plan.actions.some((a) => a.kind === 'hostFileRestore'), true, '旧快照的还原动作照常计划')
    // 零写入：预览不建 pre-restore
    await assert.rejects(fs.readdir(path.join(f.snapshotDir, 'pre-restore')));
  });
});

test('F-4 planRestore：宿主未注入版本 → 按 profile 依赖树 best-effort 探测（读不到则不告警）', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({ dshVersion: '0.1.5-rc.1' });
    const f = await makeFixture(tmp, snapshot);

    // (a) profile 依赖树里落盘的 DSH 版本 = 0.9.9 → 用它与本机快照版本比对
    await fs.mkdir(path.join(f.homeDir, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    await fs.writeFile(
      path.join(f.homeDir, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ version: '0.9.9' }), 'utf8',
    )
    const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
    assert.equal(plan.currentDshVersion, '0.9.9', '不传 currentDshVersion 时按磁盘依赖树探测')
    assert.ok(versionWarningOf(plan, '0.1.5-rc.1', '0.9.9') !== undefined, '探测到的版本不同 → 仍有可见告警')

    // (b) 依赖树里没有 DSH（离线/极简 home）→ 版本未知 → 不猜、不告警
    await fs.rm(path.join(f.homeDir, 'profiles'), { recursive: true, force: true });
    const plan2 = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });
    assert.equal(plan2.currentDshVersion, undefined, '读不到就不猜（绝不写占位版本）')
    assert.equal(plan2.actions.some((a) => a.description.includes('0.1.5-rc.1')), false, '版本未知 → 无告警')
  });
});

test('F-4 restore：版本不同不阻断执行 —— 告警进报告、无失败项', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      dshVersion: '0.1.5-rc.1',
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true }],
    });
    const f = await makeFixture(tmp, snapshot, { 'blobs/host/settings': 'SNAPSHOT settings\n' });
    await fs.mkdir(f.homeDir, { recursive: true });
    await fs.writeFile(path.join(f.homeDir, 'settings.yaml'), 'CURRENT settings\n', 'utf8');

    const report = await restore({
      snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web', currentDshVersion: '0.2.0-rc.2',
    });

    assert.deepEqual(report.failed, [], '版本不同绝不导致恢复失败（只告警，不阻断）')
    assert.equal(
      report.skipped.some((s) => s.includes('0.1.5-rc.1') && s.includes('0.2.0-rc.2')), true,
      '告警必须出现在恢复报告里（可见、可审计）',
    )
    assert.equal(await fs.readFile(path.join(f.homeDir, 'settings.yaml'), 'utf8'), 'SNAPSHOT settings\n', '还原照常执行')
  });
});

/* ---------------- 数据安全：存在但读不出来的宿主文件绝不产生删除动作 ---------------- */

test('R-host-unreadable: 快照里 existed=true + unreadable 的宿主文件 → 只跳过并说明，绝不 hostFileRemove', async () => {
  await withTmp(async (tmp) => {
    const snapshot = makeSnapshot({
      // 拍快照时 settings.yaml 存在、但读不出来（占用/权限）：existed=true + unreadable + 无 blob
      hostFileBackups: [{ relPath: 'settings.yaml', blobPath: '', existed: true, unreadable: true }],
    });
    const f = await makeFixture(tmp, snapshot);
    await seedCurrent(f); // 目标机上 settings.yaml 真实存在 —— 正是最危险的情形

    const plan = await planRestore({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'web' });

    assert.deepEqual(
      plan.actions.filter((a) => a.kind === 'hostFileRemove'),
      [],
      '「读不到」绝不能被当成「当时不存在」，否则恢复会删掉用户真实的文件',
    );
    const skips = plan.actions.filter((a) => a.kind === 'skip' && a.target === 'settings.yaml');
    assert.equal(skips.length, 1, '存在但读不出来的条目必须只跳过');
    assert.match(skips[0]!.description, /读不出来/, '说明必须点出「拍快照时读不出来」，而不是含糊的「缺少 blob 副本」');
  });
});
