/**
 * task-2/B：restore 的**目标侧**路径逃逸（symlink / junction）——只按真实行为断言。
 *
 * 源码事实：
 *  - 计划期只有**字符串前缀**围栏：homeAbs()/isWithinHome()（src/core/restore.ts:191-201）
 *    对 relPath 的 .. 越界会抛错，planRestore 捕获后降级为 kind='skip'（restore.ts:424-434）。
 *  - 目标侧**目录链接**（Windows junction / POSIX 目录 symlink）不在围栏内：字符串前缀永远成立，
 *    落盘经链接写到 homeDir 之外（本文件 B-2 断言此逃逸）。
 *  - 快照侧 symlink 有校验（validateSnapshotForRestore，restore.ts:308-379），目标侧没有。
 *  - 写回原语 atomicCopyFile 缺省 symlink:'follow'（src/utils/atomic-write.ts:305，
 *    resolveTarget 见 :200-206）⇒ 目标文件本身是 symlink 时**解析真实路径后写真实文件**
 *    （本文件 B-3 断言 follow 语义：写穿到链接目标，链接本身保留）。
 *
 * 结论口径：B-1 = 已有防护（skip 且零写入）；B-2/B-3 = 当前行为（写穿到 home 外），标注 TODO，
 * **不在本任务修改 src**。
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

/** 快照目录：给定 hostFileBackups 与同名 blob 内容（blob 名由 relPath 归一）。 */
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
  const hostFileBackups = backups.map((b, i) => {
    const blobName = `b${String(i)}`;
    return { relPath: b.relPath, blobPath: `blobs/host/${blobName}`, existed: true, _content: b.content ?? `SNAP-${b.relPath}`, _blobName: blobName };
  });
  const snapshot: Snapshot = {
    id: SNAP_ID,
    createdAt: '2026-10-22T00:00:00.000Z',
    sourceZip: 'audit.zip',
    entries: [],
    status: 'done',
    beforePlugins: [],
    hostFileBackups: hostFileBackups.map(({ _content, _blobName, ...rest }) => rest),
  };
  await fs.writeFile(path.join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  for (const b of hostFileBackups) {
    await fs.writeFile(path.join(snapshotDir, 'blobs', 'host', b._blobName), b._content, 'utf8');
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

const OPTS = (f: Fixture) => ({ snapshotDir: f.snapshotDir, homeDir: f.homeDir, profile: 'desktop' });

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

test('B-1 快照 relPath 用 .. 越界：计划降级为 skip，恢复后 home 外零写入（已有防护）', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: '../../outside/escape.yaml', content: 'SNAP-escape' }]);

  const plan = await planRestore(OPTS(f));
  const escapes = plan.actions.filter((a: RestoreAction) => a.target === '../../outside/escape.yaml');
  assert.equal(escapes.length, 1, '越界条目应产出恰好 1 条动作');
  assert.equal(escapes[0]!.kind, 'skip', '字符串前缀围栏拦下 ⇒ skip（restore.ts:191-201 / 424-434）');

  const report = await restore(OPTS(f));
  assert.ok(!report.restored.includes('../../outside/escape.yaml'));
  assert.deepEqual(await fs.readdir(f.outsideDir), [], 'home 外不得出现任何文件');
  assert.equal(await exists(path.join(f.workDir, 'outside', 'escape.yaml')), false);
  assert.equal(await exists(path.join(f.workDir, '..', 'outside', 'escape.yaml')), false);
});

test('B-2 目标侧目录链接（junction/symlink 指向 home 外）：plan 放行并写穿到 home 外（当前行为，TODO）', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: 'sub/notes.yaml', content: 'SNAP-notes' }]);
  const outsideFile = path.join(f.outsideDir, 'notes.yaml');
  await fs.writeFile(outsideFile, 'EXTERNAL-notes', 'utf8');
  if (!(await linkDir(f.outsideDir, path.join(f.homeDir, 'sub')))) {
    t.skip('本机无法创建目录链接（junction/symlink），跳过目标侧目录链接用例');
    return;
  }

  const plan = await planRestore(OPTS(f));
  const act = plan.actions.find((a: RestoreAction) => a.target === 'sub/notes.yaml');
  assert.equal(act?.kind, 'hostFileRestore', '字符串前缀成立 ⇒ 计划放行（无 realpath 围栏）');

  const report = await restore(OPTS(f));
  assert.ok(report.restored.includes('sub/notes.yaml'));
  // TODO(安全)：目标侧目录链接未被围栏识别，写入落到了 homeDir 之外
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'SNAP-notes', '当前行为：内容写穿到 home 外的真实文件');
  // 反向信息流：pre-restore「反悔副本」把 home 外内容复制进了快照目录
  const preDir = path.join(f.snapshotDir, 'pre-restore');
  assert.deepEqual(await fs.readdir(preDir), ['0001-sub_notes.yaml'], '外部内容被当成本机文件备份进快照');
  assert.equal(await fs.readFile(path.join(preDir, '0001-sub_notes.yaml'), 'utf8'), 'EXTERNAL-notes');
});

test('B-3 目标文件本身是 symlink 指向 home 外：atomicCopyFile follow 语义写穿（当前行为，TODO）', async (t) => {
  const f = await makeSnapshot(workdir(t), [{ relPath: 'linked.yaml', content: 'SNAP-linked' }]);
  const secretFile = path.join(f.outsideDir, 'secret.yaml');
  await fs.writeFile(secretFile, 'EXTERNAL-secret', 'utf8');
  const linkPath = path.join(f.homeDir, 'linked.yaml');
  if (!(await linkFile(secretFile, linkPath))) {
    t.skip('本机无法创建文件 symlink（Windows 需开发者模式/管理员），跳过目标侧文件链接用例');
    return;
  }

  const report = await restore(OPTS(f));
  assert.ok(report.restored.includes('linked.yaml'));
  assert.ok(fssync.lstatSync(linkPath).isSymbolicLink(), '链接本身被保留（follow 不改链接结构）');
  // TODO(安全)：follow 策略把快照内容写进链接目标 = home 外的真实文件
  assert.equal(await fs.readFile(secretFile, 'utf8'), 'SNAP-linked', '当前行为：写穿到链接目标（home 外）');
});
