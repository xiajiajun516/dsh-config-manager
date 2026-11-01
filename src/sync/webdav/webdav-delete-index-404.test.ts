/**
 * 回归护栏（audit-sync **sync-N1**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104；t42 返工）。
 *
 * sync-N1（P0 类）：`GET index.json` 返回 **404（真缺失）**时，delete() 此前按「远端一条快照都没有」
 * 继续执行 —— PUT index.json=[] 并让 gcBlobStore 以**空引用集**回收，删掉仍被现存快照文件引用的
 * 会话 blob（不可恢复），而快照文件还在。WebDAV 与 S3 同型（本文件钉 WebDAV）。
 *
 * 三态语义（**delete 侧**本文件逐条钉住；**upload 侧**见 webdav-upload-index-404.test.ts，t66 补齐）：
 *   ① index 404 真缺失  → **「显式失败」只落在两件事上：不 PUT index.json、不回收任何 blob**；
 *      目标快照文件**仍按用户意图 DELETE**（DELETE 拿到 404 = 本来就不存在 = 成功，与另两个通道同口径）；
 *   ② index 读操作抛错  → 显式失败（F1 语义，绝不回落成空索引）；
 *   ③ index = 200 + []  → 索引权威地声明集合为空，保持既有语义；
 *   ④ GC 遇到「索引有条目但快照文件读不出来（非 404）」→ 本轮放弃（读不出来 ≠ 没引用）；
 *   ⑤ SYN-04（P1）：**404 同样放弃本轮** —— 索引有条目但快照文件 404（孤儿条目 / 假 404）时，旧实现
 *      走 continue 把该快照当「引用集为空」，仍被它使用的 blob 就被判无人引用而删除（不可恢复）。
 *      现在与「读不出来」同口径：本轮 0 删除，并记下放弃码（`lastGcSkip`，机器可判定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebDavTransport } from './webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse } from './webdav-transport.ts';

const COL = 'https://dav.example.com/dav/dsh-config-manager';
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000; // 早于 10 分钟 GC 保护窗
const BLOB_HASH = 'a'.repeat(64);

function mkRes(status: number, text = ''): WebDavResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
}

function meta(id: string, day: string) {
  return {
    id,
    createdAt: '2026-10-0' + day + 'T00:00:00.000Z',
    sections: { settings: 'h' + id },
    manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
  };
}

function snapOf(id: string, sections: unknown): string {
  return JSON.stringify({
    id,
    createdAt: '2026-10-03T00:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
    sections,
  });
}

const PLAIN = { settings: { version: 1, namespaces: {} } };
/** 外置引用形态（BlobRefsSection）：引用 BLOB_HASH */
const WITH_BLOB_REF = { sessions: { version: 1, blobRefs: [{ relativePath: 'p/1.jsonl', blobHash: BLOB_HASH, sizeBytes: 4 }] } };

/**
 * 远端 mock。`index` 为 null = index.json **真缺失（404）**；`indexGetStatus` 非 0 = GET index 返回该状态
 * （读操作抛错）；`failSnapshotGet` 精确到某个快照文件的 GET 状态。
 */
function makeRemote(opts: {
  index: string | null;
  indexGetStatus?: number;
  snapshotFiles: Record<string, string>;
  failSnapshotGet?: Record<string, number>;
}) {
  // 键统一带 .json：与 GET/DELETE 的查表口径一致（否则夹具永远 404，测不到引用收集）
  const files = new Map<string, string>(Object.entries(opts.snapshotFiles).map(([id, body]) => [id + '.json', body]));
  const blobsIndex: Record<string, number> = { [BLOB_HASH]: OLD_BLOB_MS };
  const blobs = new Set<string>([BLOB_HASH]);
  const seen = { putIndex: [] as string[], deletedBlobs: [] as string[], deletes: [] as string[], all: [] as string[] };

  const request: WebDavRequestFn = async (method, url, options) => {
    seen.all.push(method + ' ' + url);
    if (url === COL + '/index.json') {
      if (method === 'GET') {
        if ((opts.indexGetStatus ?? 0) !== 0) return mkRes(opts.indexGetStatus as number, 'boom');
        if (opts.index === null) return mkRes(404);
        return mkRes(200, opts.index);
      }
      if (method === 'PUT') { seen.putIndex.push(options?.body ?? ''); return mkRes(201); }
      return mkRes(405);
    }
    if (url === COL + '/blobs-index.json') {
      if (method === 'GET') return mkRes(200, JSON.stringify(blobsIndex));
      if (method === 'PUT') { const next = JSON.parse(options?.body ?? '{}') as Record<string, number>; for (const k of Object.keys(blobsIndex)) delete blobsIndex[k]; Object.assign(blobsIndex, next); return mkRes(201); }
      return mkRes(405);
    }
    if (url.startsWith(COL + '/blobs/')) {
      const hash = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'GET') return blobs.has(hash) ? mkRes(200, 'AAAA') : mkRes(404);
      if (method === 'DELETE') { seen.deletedBlobs.push(hash); blobs.delete(hash); return mkRes(204); }
      return mkRes(405);
    }
    const m = /^https:\/\/dav\.example\.com\/dav\/dsh-config-manager\/([^/]+)\.json$/.exec(url);
    if (m !== null) {
      const id = m[1] as string;
      if (method === 'GET') {
        const fail = opts.failSnapshotGet?.[id] ?? 0;
        if (fail !== 0) return mkRes(fail, 'boom');
        const body = files.get(id + '.json');
        return body === undefined ? mkRes(404) : mkRes(200, body);
      }
      if (method === 'DELETE') {
        seen.deletes.push(id);
        const had = files.delete(id + '.json');
        return mkRes(had ? 204 : 404);
      }
    }
    if (method === 'MKCOL') return mkRes(201);
    return mkRes(404);
  };
  return { files, blobsIndex, blobs, seen, request };
}

function transportWith(request: WebDavRequestFn): WebDavTransport {
  return new WebDavTransport({
    baseUrl: 'https://dav.example.com/dav',
    username: 'alice',
    credentials: { getPassword: async () => 'pw' },
    request,
  });
}

test('N1①：index 真缺失（404）→ 绝不 PUT index.json、绝不回收 blob（其余快照与其引用的 blob 原样保留）', async () => {
  const r = makeRemote({
    index: null,
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = transportWith(r.request);
  // 索引缺失 → 仍按用户意图删掉目标快照文件，但**绝不写回索引、绝不触发 blob GC**
  await t.delete('sync-aaa-111');
  assert.deepEqual(r.seen.putIndex, [], '不得 PUT index.json（base 上会写 ["[]"]，其余快照从列表整体消失）');
  assert.deepEqual(r.seen.deletedBlobs, [], '不得删除任何 blob（base 上会删掉仍被 sync-ccc-333 引用的 blob）');
  assert.equal(r.blobs.has(BLOB_HASH), true, '仍被现存快照引用的 blob 必须完好');
  assert.equal(r.files.has('sync-ccc-333.json'), true, '其余快照文件必须完好');
  assert.equal(r.files.has('sync-aaa-111.json'), false, '目标快照文件按用户意图删除（404 视为成功）');
});

test('N1②：index 读操作抛错（500）→ 同样显式失败（F1 语义不回退）', async () => {
  const r = makeRemote({
    index: null,
    indexGetStatus: 500,
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = transportWith(r.request);
  await assert.rejects(() => t.delete('sync-aaa-111'), /500|index\.json/i);
  assert.deepEqual(r.seen.putIndex, []);
  assert.deepEqual(r.seen.deletedBlobs, []);
  assert.equal(r.blobs.has(BLOB_HASH), true);
});

test('N1③：index = 200 + []（真空集合）且目标文件不存在 → 静默成功，不 PUT、不触发 GC', async () => {
  const r = makeRemote({ index: '[]', snapshotFiles: { 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) } });
  const t = transportWith(r.request);
  await t.delete('sync-aaa-111');
  assert.deepEqual(r.seen.putIndex, [], '无变更不写回索引');
  assert.deepEqual(r.seen.deletedBlobs, [], '不得删除 blob');
  assert.equal(r.blobs.has(BLOB_HASH), true, '索引之外的快照文件引用的 blob 也不得被删');
});

test('N1④：索引可读且剩余快照仍引用该 blob → 在用 blob 绝不被删', async () => {
  const r = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = transportWith(r.request);
  await t.delete('sync-aaa-111');
  assert.deepEqual(JSON.parse(r.seen.putIndex[r.seen.putIndex.length - 1] ?? 'null'), [meta('sync-ccc-333', '3')], '索引摘除目标条目');
  assert.deepEqual(r.seen.deletedBlobs, [], '仍被 sync-ccc-333 引用的 blob 不得删除');
  assert.equal(r.blobs.has(BLOB_HASH), true);
});

test('N1⑤：索引有条目但该快照文件读不出来（非 404）→ 本轮放弃 GC（读不出来 ≠ 没引用）', async () => {
  const r = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
    failSnapshotGet: { 'sync-ccc-333': 500 },
  });
  const t = transportWith(r.request);
  await t.delete('sync-aaa-111');
  assert.deepEqual(r.seen.deletedBlobs, [], '读不出 sync-ccc-333 就无法证明它没引用 blob → 本轮不得删任何 blob');
  assert.equal(r.blobs.has(BLOB_HASH), true);
});

test('N1⑥（SYN-04）：索引有条目但该快照文件真 404 → 本轮放弃 GC（404 也证明不了「没引用」）+ 记放弃码', async () => {
  // 孤儿条目 / 假 404：索引还列着 sync-ccc-333，文件却不在远端 —— 拿不到内容 ⇒ 无法证明它没引用 blob。
  // base 上 404 走 continue，引用集只剩「读得出来的那几份」，于是在用的 BLOB_HASH 被判无人引用而删除。
  const r = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN) },
  });
  const t = transportWith(r.request);
  await t.delete('sync-aaa-111');
  assert.deepEqual(r.seen.deletedBlobs, [], '404 与「读不出来」同属「无法证明没有引用」→ 本轮 0 删除');
  assert.equal(r.blobs.has(BLOB_HASH), true, '没有被证明无引用的 blob 必须保留');
  assert.equal(t.lastGcSkip, 'gc-skip-reference-missing', '必须记下本轮放弃码（机器可判定，文案由上层按码翻译）');
});

test('N1⑦（SYN-04）：引用者 200 但内容坏掉 → 本轮放弃，放弃码 = snapshot-unparsable', async () => {
  const r = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': 'not-json' },
  });
  const t = transportWith(r.request);
  await t.delete('sync-aaa-111');
  assert.deepEqual(r.seen.deletedBlobs, [], '解析不了 ⇒ 引用集不完整 ⇒ 本轮不得删任何 blob');
  assert.equal(t.lastGcSkip, 'gc-skip-snapshot-unparsable');
});
