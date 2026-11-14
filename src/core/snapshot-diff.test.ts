/**
 * 快照改动预览引擎单测（真 fs + 临时目录）：
 * 变更状态 / 行数统计 / 越界拒绝 / blob 缺失 / 二进制 / 超限降级 / 零写入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SNAPSHOT_DIFF_LIMITS, readSide, snapshotFileDiff, summarizeRestoreChanges } from './snapshot-diff.ts';
import type { SideReadIo } from './snapshot-diff.ts';
import type { RestorePlan } from './restore.ts';

interface Fixture {
  root: string;
  homeDir: string;
  snapshotDir: string;
  write(rel: string, content: string): Promise<void>;
  writeBlob(rel: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-snapdiff-'));
  const homeDir = path.join(root, 'home');
  const snapshotDir = path.join(root, 'snap');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(path.join(snapshotDir, 'blobs'), { recursive: true });
  return {
    root,
    homeDir,
    snapshotDir,
    async write(rel, content) {
      const abs = path.join(homeDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    },
    async writeBlob(rel, content) {
      const abs = path.join(snapshotDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function planWith(actions: RestorePlan['actions']): RestorePlan {
  return {
    snapshotId: 'snap-1',
    createdAt: '2026-09-21T00:00:00.000Z',
    sourceZip: 'x.zip',
    pluginBaselineConfirmed: true,
    summary: { hostFileRestores: 0, hostFileRemoves: 0, pluginRemoves: 0, pluginInstalls: 0, fileRestores: 0, fileRemoves: 0, credentialHints: 0, skips: 0 },
    actions,
  };
}

test('S-01 修改：两侧存在 → status=modified + 逐行 hunks + 行数统计', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('settings.yaml', 'a: 1\nb: 2\nc: 3\n');
    await fx.writeBlob('blobs/s1', 'a: 1\nb: 20\nc: 3\n');
    const plan = planWith([{ kind: 'hostFileRestore', description: '还原 settings.yaml', target: 'settings.yaml', blobPath: 'blobs/s1' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries.length, 1);
    assert.equal(summary.entries[0]?.status, 'modified');
    assert.equal(summary.entries[0]?.beforeExists, true);
    assert.equal(summary.entries[0]?.afterExists, true);
    assert.equal(summary.entries[0]?.added, 1);
    assert.equal(summary.entries[0]?.removed, 1);
    assert.equal(summary.computed, 1);
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'hostFileRestore', target: 'settings.yaml', blobPath: 'blobs/s1' });
    assert.equal(diff.status, 'modified');
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.hunks.length, 1);
    assert.equal(diff.before.lines, 3);
    assert.equal(diff.after.lines, 3);
    assert.equal(diff.reason, undefined);
  } finally {
    await fx.cleanup();
  }
});

test('S-02 新增：磁盘没有、快照有 → status=added，统计只加不减', async () => {
  const fx = await makeFixture();
  try {
    await fx.writeBlob('blobs/new', 'l1\nl2\n');
    const plan = planWith([{ kind: 'hostFileRestore', description: '写回新文件', target: 'new.yaml', blobPath: 'blobs/new' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.status, 'added');
    assert.equal(summary.entries[0]?.beforeExists, false);
    assert.equal(summary.entries[0]?.added, 2);
    assert.equal(summary.entries[0]?.removed, 0);
  } finally {
    await fx.cleanup();
  }
});

test('S-03 删除：hostFileRemove → status=deleted，删除行数 = 原文件行数', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('addedByImport.yaml', 'x\ny\nz\n');
    const plan = planWith([{ kind: 'hostFileRemove', description: '删除导入期新增文件', target: 'addedByImport.yaml' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.status, 'deleted');
    assert.equal(summary.entries[0]?.removed, 3);
    assert.equal(summary.entries[0]?.added, 0);
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'hostFileRemove', target: 'addedByImport.yaml' });
    assert.equal(diff.status, 'deleted');
    assert.equal(diff.removed, 3);
    assert.equal(diff.after.exists, false);
  } finally {
    await fx.cleanup();
  }
});

test('S-04 越界拒绝：target 逃出 $DSH_HOME → status=skip / reason=path-escape（不读磁盘）', async () => {
  const fx = await makeFixture();
  try {
    await fx.writeBlob('blobs/x', 'data\n');
    const plan = planWith([{ kind: 'fileRestore', description: '越界', target: '../outside.txt', blobPath: 'blobs/x' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.status, 'skip');
    assert.equal(summary.entries[0]?.statSkipped, 'unreadable');
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'fileRestore', target: '../outside.txt', blobPath: 'blobs/x' });
    assert.equal(diff.reason, 'path-escape');
    assert.deepEqual(diff.hunks, []);
  } finally {
    await fx.cleanup();
  }
});

test('S-05 blob 缺失：reason=missing-blob（快照损坏不静默当成新增）', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('settings.yaml', 'a\n');
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'hostFileRestore', target: 'settings.yaml', blobPath: 'blobs/gone' });
    assert.equal(diff.reason, 'missing-blob');
    const plan = planWith([{ kind: 'hostFileRestore', description: '还原', target: 'settings.yaml', blobPath: 'blobs/gone' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.status, 'skip');
  } finally {
    await fx.cleanup();
  }
});

test('S-06 二进制：NUL 字节 → reason=binary，统计标记 binary（不逐行对比）', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('blob.bin', 'abc\u0000def');
    await fx.writeBlob('blobs/b', 'xyz\u0000uvw');
    const plan = planWith([{ kind: 'fileRestore', description: '二进制文件', target: 'blob.bin', blobPath: 'blobs/b' }]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.statSkipped, 'binary');
    assert.equal(summary.entries[0]?.added, undefined);
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'fileRestore', target: 'blob.bin', blobPath: 'blobs/b' });
    assert.equal(diff.reason, 'binary');
    assert.equal(diff.before.binary, true);
  } finally {
    await fx.cleanup();
  }
});

test('S-07 超限：列表统计上限内不逐行（too-large），超出完整 diff 上限时同样只报体积', async () => {
  const fx = await makeFixture();
  try {
    const big = 'x'.repeat(SNAPSHOT_DIFF_LIMITS.maxStatSideBytes + 1024);
    const huge = 'y'.repeat(SNAPSHOT_DIFF_LIMITS.maxSideBytes + 1024);
    await fx.write('big.txt', big);
    await fx.writeBlob('blobs/big', big);
    await fx.write('huge.txt', huge);
    await fx.writeBlob('blobs/huge', huge);
    const plan = planWith([
      { kind: 'fileRestore', description: '大文件', target: 'big.txt', blobPath: 'blobs/big' },
      { kind: 'fileRestore', description: '超大文件', target: 'huge.txt', blobPath: 'blobs/huge' },
    ]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.equal(summary.entries[0]?.statSkipped, 'too-large');
    assert.equal(summary.entries[0]?.beforeBytes, big.length);
    const bigDiff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'fileRestore', target: 'big.txt', blobPath: 'blobs/big' });
    assert.equal(bigDiff.reason, undefined, '300KB 仍可完整对比');
    const hugeDiff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'fileRestore', target: 'huge.txt', blobPath: 'blobs/huge' });
    assert.equal(hugeDiff.reason, 'too-large');
    assert.equal(hugeDiff.before.oversized, true);
  } finally {
    await fx.cleanup();
  }
});

test('S-08 非文件类动作：插件/人工提示/跳过只做归类，不读磁盘', async () => {
  const fx = await makeFixture();
  try {
    const plan = planWith([
      { kind: 'pluginRemove', description: '卸载 foo', target: 'foo', pluginName: 'foo' },
      { kind: 'credentialHint', description: '补录凭据' },
      { kind: 'skip', description: '无需动作' },
    ]);
    const summary = await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    assert.deepEqual(summary.entries.map((e) => e.status), ['plugin', 'hint', 'skip']);
    assert.equal(summary.computed, 0);
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'pluginRemove', target: 'foo' });
    assert.equal(diff.reason, 'not-diffable');
    const noTarget = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'hostFileRestore' });
    assert.equal(noTarget.reason, 'no-target');
  } finally {
    await fx.cleanup();
  }
});

test('S-09 零写入：统计与 diff 不修改任何文件（mtime + 内容不变）', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('settings.yaml', 'a: 1\n');
    await fx.writeBlob('blobs/s1', 'a: 2\n');
    const before = await fs.stat(path.join(fx.homeDir, 'settings.yaml'));
    const plan = planWith([{ kind: 'hostFileRestore', description: '还原', target: 'settings.yaml', blobPath: 'blobs/s1' }]);
    await summarizeRestoreChanges({ plan, snapshotDir: fx.snapshotDir, homeDir: fx.homeDir });
    await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'hostFileRestore', target: 'settings.yaml', blobPath: 'blobs/s1' });
    const after = await fs.stat(path.join(fx.homeDir, 'settings.yaml'));
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await fs.readFile(path.join(fx.homeDir, 'settings.yaml'), 'utf8'), 'a: 1\n');
    assert.deepEqual(await fs.readdir(fx.homeDir), ['settings.yaml'], '不产生 pre-restore 等额外文件');
  } finally {
    await fx.cleanup();
  }
});

test('S-10 目录当文件：unreadable（不抛错、不递归）', async () => {
  const fx = await makeFixture();
  try {
    await fs.mkdir(path.join(fx.homeDir, 'adir'), { recursive: true });
    await fx.writeBlob('blobs/d', 'content\n');
    const diff = await snapshotFileDiff({ snapshotDir: fx.snapshotDir, homeDir: fx.homeDir, kind: 'fileRestore', target: 'adir', blobPath: 'blobs/d' });
    assert.equal(diff.reason, 'unreadable');
  } finally {
    await fx.cleanup();
  }
});

/* ---------------- P2-6：「存在但读不出」不得被判成不存在（审计回归） ---------------- */

/** 造一个只带 errno code 的错误（真机上只有 EACCES 一类能触发该分支，Windows 无 ACL 夹具可造） */
function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

test('P2-6: stat 成功但 readFile 抛 EACCES ⇒ 存在但读不出（与目录分支同形态，绝不判成不存在）', async () => {
  const fx = await makeFixture();
  try {
    await fx.write('locked.yaml', 'a: 1\n');
    const lockedAbs = path.join(fx.homeDir, 'locked.yaml');
    const maxBytes = SNAPSHOT_DIFF_LIMITS.maxStatSideBytes;

    const readable = await readSide(lockedAbs, maxBytes);
    assert.equal(readable.exists, true);
    assert.equal(readable.unreadable, false);
    assert.equal(readable.text, 'a: 1\n');

    // 既有形态：路径是目录（同函数非普通文件分支）——「读不出」必须与它逐字段一致
    await fs.mkdir(path.join(fx.homeDir, 'adir'), { recursive: true });
    const asDir = await readSide(path.join(fx.homeDir, 'adir'), maxBytes);

    const deniedIo: SideReadIo = {
      stat: async () => ({ isFile: () => true, size: 6 }),
      readFile: async () => { throw errnoError('EACCES'); },
    };
    const denied = await readSide(lockedAbs, maxBytes, deniedIo);
    // bytes 是各来源自己的 stat 体积（目录 vs 6 字节文件），形态比的是 exists/unreadable/text 这些标志
    assert.deepEqual(
      { ...denied, bytes: 0 }, { ...asDir, bytes: 0 },
      '「存在但读不出」必须沿用既有不可读形态（exists:true + unreadable:true + text:null）',
    );
    assert.equal(denied.exists, true, '判成不存在会让恢复预览把只读文件显示成「新增」');
  } finally {
    await fx.cleanup();
  }
});

test('P2-6: 只有 ENOENT 才算不存在（stat 侧 EACCES = 读不出；stat 后 read 报 ENOENT = 真的没了）', async () => {
  const fx = await makeFixture();
  try {
    const abs = path.join(fx.homeDir, 'gone.yaml');
    const maxBytes = SNAPSHOT_DIFF_LIMITS.maxStatSideBytes;

    // 真·不存在
    const missing = await readSide(abs, maxBytes);
    assert.equal(missing.exists, false);

    // stat 拿不到状态（EACCES）= 路径在、只是读不了
    const statDenied: SideReadIo = {
      stat: async () => { throw errnoError('EACCES'); },
      readFile: async () => Buffer.from('x'),
    };
    const fromStatDenied = await readSide(abs, maxBytes, statDenied);
    assert.equal(fromStatDenied.exists, true);
    assert.equal(fromStatDenied.unreadable, true);

    // stat 与 read 之间被删掉（read 报 ENOENT）= 当时确实不存在
    const vanished: SideReadIo = {
      stat: async () => ({ isFile: () => true, size: 10 }),
      readFile: async () => { throw errnoError('ENOENT'); },
    };
    const fromVanished = await readSide(abs, maxBytes, vanished);
    assert.equal(fromVanished.exists, false);
    assert.equal(fromVanished.unreadable, false);
  } finally {
    await fx.cleanup();
  }
});
