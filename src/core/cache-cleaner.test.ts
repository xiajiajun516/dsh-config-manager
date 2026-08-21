/**
 * cache-cleaner 测试：缓存自动清理的保留期 / 白名单边界 / 容错。
 * 使用真实临时目录（node:os tmpdir）+ node:fs 真实读写（与 plugin-cli.fs.test.ts 同模式）。
 * 覆盖：
 *   - tmp：过期 .zip 删、新 .zip 留、非 zip 文件留、dsh-sync-pull-* 目录超期删
 *   - exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留
 *   - market/cache：过期 index.json / items 条目删；新条目留；删空后回收 items/hash 目录
 *   - market/work：过期 git 副本删、新副本留
 *   - 保留期边界（恰好等于保留期 → 不删）、目录不存在 → 不抛错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupCaches,
  TMP_RETENTION_DEFAULT_MS,
  EXPORTS_RETENTION_DEFAULT_MS,
  MARKET_RETENTION_DEFAULT_MS,
} from './cache-cleaner.ts';

/** 建独立临时数据目录，返回 { root, tmpDir, exportsDir, marketCacheRoot, marketWorkRoot, cleanup } */
async function makeDataDir(): Promise<{
  root: string;
  tmpDir: string;
  exportsDir: string;
  marketCacheRoot: string;
  marketWorkRoot: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cache-'));
  const tmpDir = path.join(root, 'tmp');
  const exportsDir = path.join(root, 'exports');
  const marketCacheRoot = path.join(root, 'market', 'cache');
  const marketWorkRoot = path.join(root, 'market', 'work');
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.mkdir(marketCacheRoot, { recursive: true });
  await fs.mkdir(marketWorkRoot, { recursive: true });
  return {
    root,
    tmpDir,
    exportsDir,
    marketCacheRoot,
    marketWorkRoot,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** 把目标 mtime 拨到指定毫秒（Windows 精度足够，测试用秒级偏移） */
async function touch(p: string, mtimeMs: number): Promise<void> {
  const st = await fs.stat(p);
  await fs.utimes(p, st.atimeMs ? new Date(st.atimeMs) : new Date(), new Date(mtimeMs));
}

test('tmp：过期 .zip 删、新 .zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldZip = path.join(d.tmpDir, 'upload-old.zip');
    const newZip = path.join(d.tmpDir, 'upload-new.zip');
    const txt = path.join(d.tmpDir, 'notes.txt');
    await fs.writeFile(oldZip, Buffer.alloc(10));
    await fs.writeFile(newZip, Buffer.alloc(20));
    await fs.writeFile(txt, 'keep me');
    await touch(oldZip, now - TMP_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newZip, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 zip');
    assert.equal(report.freedBytes, 10, '释放字节 = 被删文件 size');
    assert.equal(await fs.readFile(newZip).then((b) => b.length), 20, '新 zip 保留');
    assert.equal(await fs.readFile(txt, 'utf8'), 'keep me', '非 zip 文件保留');
    await assert.rejects(() => fs.stat(oldZip), '超期 zip 已删');
    assert.ok(report.detail.some((s) => s.includes('upload-old.zip')), 'detail 含删除记录');
  } finally {
    await d.cleanup();
  }
});

test('tmp：dsh-sync-pull-* 临时目录超期删、新目录留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldDir = path.join(d.tmpDir, 'dsh-sync-pull-abc');
    const newDir = path.join(d.tmpDir, 'dsh-sync-pull-def');
    const otherDir = path.join(d.tmpDir, 'keep-dir');
    await fs.mkdir(path.join(oldDir, 'inner'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'inner'), { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'inner', 'snapshot.zip'), Buffer.alloc(5));
    await touch(oldDir, now - TMP_RETENTION_DEFAULT_MS - 5000);
    await touch(newDir, now - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 sync 临时目录');
    await assert.rejects(() => fs.stat(oldDir), '超期 sync 目录整棵已删');
    assert.ok(await fs.stat(newDir), '新 sync 目录保留');
    assert.ok(await fs.stat(otherDir), '无关目录保留');
  } finally {
    await d.cleanup();
  }
});

test('exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldExport = path.join(d.exportsDir, 'dsh-config-old.zip');
    const newExport = path.join(d.exportsDir, 'dsh-config-new.zip');
    const readme = path.join(d.exportsDir, 'readme.txt');
    await fs.writeFile(oldExport, Buffer.alloc(15));
    await fs.writeFile(newExport, Buffer.alloc(25));
    await fs.writeFile(readme, 'keep');
    await touch(oldExport, now - EXPORTS_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newExport, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期导出 zip');
    assert.equal(report.freedBytes, 15, '释放字节 = 被删文件 size');
    await assert.rejects(() => fs.stat(oldExport), '超期导出 zip 已删');
    assert.ok(await fs.stat(newExport), '新导出 zip 保留');
    assert.equal(await fs.readFile(readme, 'utf8'), 'keep', '非 zip 文件保留');
    assert.ok(report.detail.some((s) => s.includes('exports/')), 'detail 含 exports 删除记录');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：全过期 → 条目、items 目录、hash 目录依次回收', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash1');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    const index = path.join(hashDir, 'index.json');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.writeFile(path.join(oldItem, 'config.zip'), Buffer.alloc(7));
    await fs.writeFile(index, '{}');
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);
    await touch(index, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    // 删除：index.json + 条目 + 空 items 目录 + 空 hash 目录
    assert.equal(report.removed, 4, 'index、条目、items 目录、hash 目录依次回收');
    await assert.rejects(() => fs.stat(oldItem), '过期条目已删');
    await assert.rejects(() => fs.stat(index), '过期 index.json 已删');
    await assert.rejects(() => fs.stat(itemsDir), 'items 目录删空后已回收');
    await assert.rejects(() => fs.stat(hashDir), 'hash 目录删空后已回收');
    assert.ok(await fs.stat(d.marketCacheRoot), 'market/cache 根保留');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：有过期条目但 index.json 保留（未过期）时 hash 目录不被回收', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash2');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.writeFile(path.join(hashDir, 'index.json'), '{}');
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 2, '条目 + 空 items 目录被回收');
    assert.ok(await fs.stat(hashDir), 'index.json 未过期 → hash 目录保留');
    assert.ok(await fs.stat(path.join(hashDir, 'index.json')), 'index.json 保留');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：有新条目时 items/hash 目录不被回收，新条目保留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash3');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    const newItem = path.join(itemsDir, 'new-item');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.mkdir(newItem, { recursive: true });
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删过期条目，items/hash 目录因新条目保留');
    await assert.rejects(() => fs.stat(oldItem), '过期条目已删');
    assert.ok(await fs.stat(newItem), '新条目保留');
    assert.ok(await fs.stat(itemsDir), 'items 目录保留（仍有新条目）');
    assert.ok(await fs.stat(hashDir), 'hash 目录保留');
  } finally {
    await d.cleanup();
  }
});

test('market/work：过期 git 副本删、新副本留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldWork = path.join(d.marketWorkRoot, 'oldhash');
    const newWork = path.join(d.marketWorkRoot, 'newhash');
    await fs.mkdir(path.join(oldWork, '.git'), { recursive: true });
    await fs.mkdir(path.join(newWork, '.git'), { recursive: true });
    await touch(oldWork, now - MARKET_RETENTION_DEFAULT_MS - 1000);
    await touch(newWork, now - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删过期 git 副本');
    await assert.rejects(() => fs.stat(oldWork), '过期副本整棵已删');
    assert.ok(await fs.stat(newWork), '新副本保留');
  } finally {
    await d.cleanup();
  }
});

test('保留期边界：恰好等于保留期 → 不删（超期判定为严格大于）', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const zip = path.join(d.tmpDir, 'upload-boundary.zip');
    await fs.writeFile(zip, Buffer.alloc(3));
    await touch(zip, now - TMP_RETENTION_DEFAULT_MS); // 恰好 = 保留期

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 0, '边界文件不删');
    assert.ok(await fs.stat(zip), '边界 zip 保留');
  } finally {
    await d.cleanup();
  }
});

test('容错：目录不存在 → 不抛错、removed=0', async () => {
  const d = await makeDataDir();
  try {
    const report = await cleanupCaches({
      tmpDir: path.join(d.root, 'no-such-tmp'),
      exportsDir: path.join(d.root, 'no-such-exports'),
      marketCacheRoot: path.join(d.root, 'no-such-cache'),
      marketWorkRoot: path.join(d.root, 'no-such-work'),
    });
    assert.equal(report.removed, 0);
    assert.equal(report.errors, 4, '四个缺失目录各记一次尽力而为跳过');
  } finally {
    await d.cleanup();
  }
});

test('自定义保留期生效（market 保留期缩短 → 较早条目被删）', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash3');
    const itemDir = path.join(hashDir, 'items', 'x');
    await fs.mkdir(itemDir, { recursive: true });
    await touch(itemDir, now - 2 * 60 * 1000); // 2 分钟前

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      marketRetentionMs: 60 * 1000, // 1 分钟保留期
      now: () => now,
    });

    assert.equal(report.removed, 3, '条目 + items + hash 目录全部回收');
    await assert.rejects(() => fs.stat(hashDir));
  } finally {
    await d.cleanup();
  }
});
