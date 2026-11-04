import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKET_TMP_RETENTION_MS,
  createMarketCacheLayout,
  marketItemCached,
  pruneStagedMarketZips,
  readMarketCacheIndexText,
  writeMarketItemCache,
} from './market-cache.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dcm-market-cache-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('MC-1 布局：同 URL 稳定、不同 URL 分离、32 hex 目录名', () => {
  const layout = createMarketCacheLayout(join('root', 'market'));
  const a = layout.cacheIndex('https://example.com/market.git');
  const b = layout.cacheIndex('https://example.com/market.git');
  const c = layout.cacheIndex('https://example.com/other.git');
  assert.equal(a, b);
  assert.notEqual(a, c);
  const hash = a.slice(layout.cacheRoot.length + 1).split(/[\\/]/)[0] ?? '';
  assert.match(hash, /^[0-9a-f]{32}$/);
  const itemDir = layout.itemDir('https://example.com/market.git');
  assert.equal(itemDir, join(layout.cacheRoot, hash, 'items'), '条目缓存与 index 共用同一 url 目录');
  assert.equal(layout.workDir('https://example.com/market.git'), join(layout.workRoot, hash));
});

test('MC-2 条目完整性：两个文件都在才 true', async () => {
  await withTmp(async (dir) => {
    const layout = createMarketCacheLayout(dir);
    const url = 'https://example.com/m.git';
    assert.equal(await marketItemCached(layout, url, 'item-1'), false);
    await mkdir(join(layout.itemDir(url), 'item-1'), { recursive: true });
    await writeFile(join(layout.itemDir(url), 'item-1', 'config.zip'), new Uint8Array([1]));
    assert.equal(await marketItemCached(layout, url, 'item-1'), false, '缺 manifest 不算缓存完整');
    await writeMarketItemCache(layout, url, 'item-1', '{"name":"x"}', new Uint8Array([2, 3]));
    assert.equal(await marketItemCached(layout, url, 'item-1'), true);
  });
});

test('MC-3 读 index 文本：缺文件返回 null，有文件返回原文', async () => {
  await withTmp(async (dir) => {
    const layout = createMarketCacheLayout(dir);
    const url = 'https://example.com/m.git';
    assert.equal(await readMarketCacheIndexText(layout, url), null);
    await mkdir(join(layout.cacheRoot, layout.cacheIndex(url).slice(layout.cacheRoot.length + 1).split(/[\\/]/)[0] ?? ''), { recursive: true });
    await writeFile(layout.cacheIndex(url), '{"items":[]}', 'utf8');
    assert.equal(await readMarketCacheIndexText(layout, url), '{"items":[]}');
  });
});

test('MC-4 暂存 GC：只删超期的 market-*/publish-*.zip，保留新文件与无关文件', async () => {
  await withTmp(async (dir) => {
    const old = new Date(Date.now() - MARKET_TMP_RETENTION_MS - 60_000);
    const files = ['market-old.zip', 'publish-old.zip', 'market-fresh.zip', 'notes.txt', 'unrelated.zip'];
    for (const name of files) await writeFile(join(dir, name), 'x');
    for (const name of ['market-old.zip', 'publish-old.zip', 'unrelated.zip']) {
      await utimes(join(dir, name), old, old);
    }
    const removed = await pruneStagedMarketZips(dir);
    assert.deepEqual(removed.sort(), ['market-old.zip', 'publish-old.zip']);
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ['market-fresh.zip', 'notes.txt', 'unrelated.zip']);
  });
});

test('MC-5 暂存 GC：保留期边界内不删（严格大于才删）', async () => {
  await withTmp(async (dir) => {
    const now = Date.now();
    const p = join(dir, 'market-edge.zip');
    await writeFile(p, 'x');
    const at = new Date(now - MARKET_TMP_RETENTION_MS);
    await utimes(p, at, at);
    const removed = await pruneStagedMarketZips(dir, MARKET_TMP_RETENTION_MS, now);
    assert.deepEqual(removed, []);
    assert.ok((await stat(p)).size >= 0);
  });
});

test('MC-6 暂存 GC：tmpDir 不存在 → 返回空且不抛', async () => {
  const removed = await pruneStagedMarketZips(join(tmpdir(), 'dcm-market-cache-missing-dir-' + String(Date.now())));
  assert.deepEqual(removed, []);
});
