/**
 * D4：restore 的**目标侧**路径逃逸（symlink / junction）——按修好后的真实行为断言。
 *
 * 修复前后的对照（源码事实）：
 *  - 计划期原有围栏只有**字符串前缀**：isWithinHome/homeAbs（src/core/restore.ts:191-201），
 *    对 relPath 的 .. 越界抛错，planRestore 捕获后降级为 kind='skip'（B-1 仍钉住这层）。
 *  - 目标侧的**目录链接**（Windows junction / POSIX 目录 symlink）字符串前缀永远成立，
 *    落盘会写到 homeDir 之外；目标**文件本身是 symlink** 时 atomicCopyFile 缺省
 *    symlink:'follow'（src/utils/atomic-write.ts:305）解析真实路径后改写 home 外的文件。
 *  - D4 补的第二层：createTargetSafetyChecker + assertPlanTargetsSafe（restore.ts
 *    「目标侧真实路径围栏」段）在**计划期**对每个 hostFileRestore/hostFileRemove/
 *    fileRestore/fileRemove 目标做 realpath 判定；任一目标不安全 ⇒ **整笔计划抛错**
 *    （restore() 先计划后执行 ⇒ 零写入）。
 *  - 判据三条：目标自身是 symlink → 拒绝；父目录向上第一个存在祖先的 realpath 必须仍在
 *    realpath(home) 之内；任何一步 realpath 失败 → 保守拒绝。
 *
 * B-1 = 既有字符串围栏（保留）；B-2/B-3/B-3b = 修复后必须**整笔拒绝**且零写入；
 * B-4 = home 自身在链接祖先下（macOS /var → /private/var、Windows junction 档案）必须正常恢复，
 * 防止「加固后把正常场景误拒」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { planRestore, restore } from './restore.ts';
import type { RestoreAction } from './restore.ts';
import type { Snapshot } from './types.ts';

const SNAP_ID = 'snap-restore-symlink';

interface Fixture {
  workDir: string;
  homeDir: string;
  outsideDir: string;
  snapshotDir: string;
}

function workdir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-restore-symlink-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 快照目录：给定 hostFileBackups 与同名 blob 内容（blob 名由下标归一）。 */
async function makeSnapshot(
  root: string,
  backups: { relPath: string; content?: string }[],
): Promise<Fixture> {
  const homeDir = path.join(root, 'home');
  const outsideDir = path.join(root, 'outside');
  const snapshotDir = path.join(root, 'data', 'snapshots', SNAP_ID);
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  const blobs = backups.map((b, i) => ({
    relPath: b.relPath,
    blobPath: 'blobs/host/b' + String(i),
    blobName: 'b' + String(i),
    content: b.content ?? ('SNAP-' + b.relPath),
  }));
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-10-22T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: blobs.map((b) => ({ relPath: b.relPath, blobPath: b.blobPath, existed: true })),
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  for (const b of blobs) {
    await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', b.blobName), b.content, 'utf8');
  }
  return { workDir: root, homeDir, outsideDir, snapshotDir };
}

/** 目标必须是目录：Windows 用 junction（无需特权），POSIX 用目录 symlink。失败返回 false。 */
async function linkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** 目标必须是文件：Windows 上非管理员/未开开发者模式会 EPERM。失败返回 false。 */
async function linkFile(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

const OPTS = (f: Fixture, homeDir = f.homeDir) => ({ snapshotDir: f.snapshotDir, homeDir, profile: 'desktop' });

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 拒绝口径：整笔计划抛「路径越界」（restore.pathEscape），信息点名目标路径。 */
function assertRefused(err: unknown, relPath: string): void {
  assert.ok(err instanceof Error, '应抛出 Error（整笔拒绝）');
  const text = err.name + ': ' + err.message;
  assert.match(text, /路径越界/, '拒绝原因应为既有 pathEscape 语义，实际: ' + text);
  assert.ok(err.message.includes(relPath), '错误信息应点名目标路径 ' + relPath + '，实际: ' + err.message);
}

test('B-1 快照 relPath 用 .. 越界：计划降级为 skip，恢复后 home 外零写入（既有字符串围栏）', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: '../../outside/escape.yaml', content: 'SNAP-escape' }]);

  const plan = await planRestore(OPTS(f));
  const escapes = plan.actions.filter((a: RestoreAction) => a.target === '../../outside/escape.yaml');
  assert.equal(escapes.length, 1, '越界条目应产出恰好 1 条动作');
  assert.equal(escapes[0]!.kind, 'skip', '字符串前缀围栏拦下 ⇒ skip（restore.ts:191-201）');

  const report = await restore(OPTS(f));
  assert.ok(!report.restored.includes('../../outside/escape.yaml'));
  assert.deepEqual(await fs.readdir(f.outsideDir), [], 'home 外不得出现任何文件');
  assert.equal(await exists(path.join(f.workDir, 'outside', 'escape.yaml')), false);
  assert.equal(await exists(path.join(f.workDir, '..', 'outside', 'escape.yaml')), false);
});

test('B-2 目标侧目录是链接（junction/symlink→home 外）：计划期整笔拒绝，home 外零写入', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: 'sub/notes.yaml', content: 'SNAP-notes' }]);
  const outsideFile = path.join(f.outsideDir, 'notes.yaml');
  await fs.writeFile(outsideFile, 'EXTERNAL-notes', 'utf8');
  if (!(await linkDir(f.outsideDir, path.join(f.homeDir, 'sub')))) {
    t.skip('本机无法创建目录链接（junction/symlink），跳过目标侧目录链接用例');
    return;
  }

  // 计划期就拒绝：dry-run 预览拿不到「看起来可行」的计划，执行路径更不会落盘
  await assert.rejects(planRestore(OPTS(f)), (err: unknown) => {
    assertRefused(err, 'sub/notes.yaml');
    return true;
  }, '目录链接让真实落点逃出 home ⇒ 计划必须整笔拒绝');
  await assert.rejects(restore(OPTS(f)), (err: unknown) => {
    assertRefused(err, 'sub/notes.yaml');
    return true;
  }, 'restore() 先规划后执行 ⇒ 同样抛错，绝不部分执行');

  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'EXTERNAL-notes', 'home 外的真实文件字节未变');
  // 反向信息流也断了：没有「反悔副本」，home 外内容没被复制进快照目录
  await assert.rejects(fs.readdir(path.join(f.snapshotDir, 'pre-restore')), '拒绝时不得建 pre-restore 目录');
});

test('B-3 目标文件本身是 symlink（指向 home 外）：计划期整笔拒绝，链接目标字节未变', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: 'linked.yaml', content: 'SNAP-linked' }]);
  const secretFile = path.join(f.outsideDir, 'secret.yaml');
  await fs.writeFile(secretFile, 'EXTERNAL-secret', 'utf8');
  const linkPath = path.join(f.homeDir, 'linked.yaml');
  if (!(await linkFile(secretFile, linkPath))) {
    t.skip('本机无法创建文件 symlink（Windows 需开发者模式/管理员），跳过目标侧文件链接用例');
    return;
  }

  await assert.rejects(planRestore(OPTS(f)), (err: unknown) => {
    assertRefused(err, 'linked.yaml');
    return true;
  }, '目标自身是 symlink ⇒ atomicCopyFile 会 follow 写穿 ⇒ 必须拒绝');
  await assert.rejects(restore(OPTS(f)), (err: unknown) => {
    assertRefused(err, 'linked.yaml');
    return true;
  });

  assert.equal(await fs.readFile(secretFile, 'utf8'), 'EXTERNAL-secret', '链接目标的字节未被改写');
  assert.ok(fssync.lstatSync(linkPath).isSymbolicLink(), '链接本身仍在（没被删/替换）');
  await assert.rejects(fs.readdir(path.join(f.snapshotDir, 'pre-restore')), '拒绝时不得建 pre-restore 目录');
});

test('B-3b 目标 symlink 指向 home 内另一份文件：同样整笔拒绝（写它 = 改写另一份文件）', async (t) => {
  const f = await makeSnapshot(workdir(t), [
    { relPath: 'alias.yaml', content: 'SNAP-alias' },
    { relPath: 'real.yaml', content: 'SNAP-real' },
  ]);
  await fs.writeFile(path.join(f.homeDir, 'real.yaml'), 'CURRENT-real', 'utf8');
  const linkPath = path.join(f.homeDir, 'alias.yaml');
  if (!(await linkFile(path.join(f.homeDir, 'real.yaml'), linkPath))) {
    t.skip('本机无法创建文件 symlink，跳过 home 内链接用例');
    return;
  }

  await assert.rejects(planRestore(OPTS(f)), (err: unknown) => {
    assertRefused(err, 'alias.yaml');
    return true;
  });
  assert.equal(await fs.readFile(path.join(f.homeDir, 'real.yaml'), 'utf8'), 'CURRENT-real', '被链接的文件未被改写');
});

test('B-4 home 自身位于链接祖先之下（macOS /var、Windows junction 档案）：正常恢复不得误拒', async (t) => {
  const workRoot = workdir(t);
  const realHome = path.join(workRoot, 'real-home');
  const linkedHome = path.join(workRoot, 'linked-home');
  await fs.mkdir(realHome, { recursive: true });
  const snapshotDir = path.join(workRoot, 'data', 'snapshots', SNAP_ID);
  await fs.mkdir(path.join(snapshotDir, 'blobs', 'host'), { recursive: true });
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-10-22T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/host/settings', existed: true }],
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', 'settings'), 'SNAP-settings', 'utf8');
  await fs.writeFile(path.join(realHome, 'settings.yaml'), 'CURRENT-settings', 'utf8');
  if (!(await linkDir(realHome, linkedHome))) {
    t.skip('本机无法创建目录链接（junction/symlink），跳过「home 在链接祖先下」用例');
    return;
  }

  const plan = await planRestore({ snapshotDir, homeDir: linkedHome, profile: 'desktop' });
  const act = plan.actions.find((a: RestoreAction) => a.target === 'settings.yaml');
  assert.equal(act?.kind, 'hostFileRestore', 'home 内部路径 ⇒ 计划照常放行');

  const report = await restore({ snapshotDir, homeDir: linkedHome, profile: 'desktop' });
  assert.deepEqual(report.failed, []);
  assert.equal(await fs.readFile(path.join(realHome, 'settings.yaml'), 'utf8'), 'SNAP-settings', '经链接写回 home 自身是正常路径');
  assert.ok(report.preRestoreDir !== undefined, '有文件被覆盖 ⇒ 必须产出反悔副本目录');
  assert.equal(
    await fs.readFile(path.join(report.preRestoreDir!, '0001-settings.yaml'), 'utf8'),
    'CURRENT-settings',
  );
});
