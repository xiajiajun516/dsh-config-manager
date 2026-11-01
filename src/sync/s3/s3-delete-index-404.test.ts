/**
 * 回归护栏（audit-sync **sync-N1**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104；t42 返工）。
 *
 * sync-N1（P0 类）：`GET index.json` 返回 **404（真缺失）**时，delete() 此前按「远端一条快照都没有」
 * 继续执行 —— PUT index.json=[] 并让 gcBlobStore 以**空引用集**回收，删掉仍被现存快照文件引用的
 * 会话 blob（不可恢复），而快照文件还在。S3 与 WebDAV 同型（本文件钉 S3）。
 *
 * 本文件逐条钉住**delete 侧**的三态语义与 GC 的同族口径（**upload 侧**见 s3-upload-index-404.test.ts，t66 补齐）：
 *   ① index 404 真缺失  → **「显式失败」只落在两件事上：不 PUT index.json、不回收任何 blob**；
 *      目标快照文件**仍按用户意图 DELETE**（DELETE 拿到 404 = 本来就不存在 = 成功，与另两个通道同口径）；
 *   ② index 读操作抛错  → 显式失败（F2 语义，绝不回落成空索引）；
 *   ③ index = 200 + []  → 索引权威地声明集合为空，保持既有语义（既有用例
 *      「blob GC：删除最后一份快照后回收超保护窗的无人引用 blob」钉住该路径）；
 *   ④ GC 遇到「索引有条目但快照文件读不出来（非 404）」→ 本轮放弃（读不出来 ≠ 没引用）；
 *   ⑤ SYN-04（P1）：与 WebDAV 同型 —— **404 也放弃本轮**（孤儿条目 / 假 404 拿不到内容就无法证明
 *      「没人引用」），本轮 0 删除并记下放弃码（`lastGcSkip`，机器可判定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport } from './s3-transport.ts';
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const BUCKET = 'demo-bucket';
const PREFIX = 'dsh-config-manager';
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000; // 早于 10 分钟 GC 保护窗
const BLOB_HASH = 'a'.repeat(64);

function res(status: number, bodyText: string): S3Response {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

interface Call { method: string; key: string; body?: string }

/**
 * 远端 mock：`index` 为 null = index.json **真缺失（GET 404）**；`indexGetStatus` 非 0 = 该次 GET 返回该状态
 * （模拟读操作抛错）；`failSnapshotGet` 精确到某个快照文件的 GET 状态。
 */
function makeRemote(opts: {
  index: string | null;
  indexGetStatus?: number;
  snapshotFiles: Record<string, string>;
  failSnapshotGet?: Record<string, number>;
}) {
  const objects = new Map<string, string>();
  const calls: Call[] = [];
  if (opts.index !== null) objects.set(PREFIX + '/index.json', opts.index);
  for (const [id, body] of Object.entries(opts.snapshotFiles)) objects.set(PREFIX + '/' + id + '.json', body);
  objects.set(PREFIX + '/blobs-index.json', JSON.stringify({ [BLOB_HASH]: OLD_BLOB_MS }));
  objects.set(PREFIX + '/blobs/' + BLOB_HASH, 'AAAA');
  const deletedBlobs: string[] = [];
  const request: S3RequestFn = async (method, url, o = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')).split('/').slice(1).join('/');
    calls.push({ method, key, ...(o.body !== undefined ? { body: o.body } : {}) });
    if (method === 'GET') {
      if (key === PREFIX + '/index.json' && (opts.indexGetStatus ?? 0) !== 0) return res(opts.indexGetStatus as number, '?');
      if (key === PREFIX + '/index.json' && opts.index === null) return res(404, '');
      const fail = opts.failSnapshotGet?.[key] ?? 0;
      if (fail !== 0) return res(fail, 'boom');
      const v = objects.get(key);
      return v === undefined ? res(404, '') : res(200, v);
    }
    if (method === 'PUT') { objects.set(key, o.body ?? ''); return res(200, ''); }
    if (method === 'DELETE') {
      const had = objects.delete(key);
      if (had && key.startsWith(PREFIX + '/blobs/')) deletedBlobs.push(key.slice((PREFIX + '/blobs/').length));
      return res(had ? 204 : 404, '');
    }
    return res(405, '');
  };
  return { objects, calls, request, deletedBlobs };
}

function makeOptions(store: { request: S3RequestFn }, overrides: Partial<S3TransportOptions> = {}): S3TransportOptions {
  return {
    provider: 'minio',
    endpoint: 'https://minio.example.com:9000',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    pathStyle: true,
    request: store.request,
    ...overrides,
  };
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

test('N1①：index 真缺失（404）→ 绝不 PUT index.json、绝不回收 blob（其余快照与其引用的 blob 原样保留）', async () => {
  const remote = makeRemote({
    index: null,
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = new S3Transport(makeOptions(remote));
  // 索引缺失 → 仍按用户意图删掉目标快照文件，但**绝不写回索引、绝不触发 blob GC**
  await t.delete('sync-aaa-111');
  assert.equal(remote.calls.some((c) => c.method === 'PUT' && c.key === PREFIX + '/index.json'), false, '不得 PUT index.json（base 上会写 ["[]"]）');
  assert.equal(remote.deletedBlobs.length, 0, '不得删除任何 blob（base 上会删掉仍被 sync-ccc-333 引用的 blob）');
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true, '仍被现存快照引用的 blob 必须完好');
  assert.equal(remote.objects.has(PREFIX + '/sync-ccc-333.json'), true, '其余快照文件必须完好');
  assert.equal(remote.objects.has(PREFIX + '/sync-aaa-111.json'), false, '目标快照文件按用户意图删除（404 视为成功）');
});

test('N1②：index 读操作抛错（500）→ 同样显式失败（F2 语义不回退）', async () => {
  const remote = makeRemote({
    index: null,
    indexGetStatus: 500,
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = new S3Transport(makeOptions(remote));
  await assert.rejects(t.delete('sync-aaa-111'), /500|GET/i);
  assert.equal(remote.calls.some((c) => c.method === 'PUT' && c.key === PREFIX + '/index.json'), false);
  assert.equal(remote.deletedBlobs.length, 0);
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true);
});

test('N1③：index = 200 + []（真空集合）且目标对象不存在 → 静默成功，不 PUT、不触发 GC', async () => {
  const remote = makeRemote({ index: '[]', snapshotFiles: { 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) } });
  const t = new S3Transport(makeOptions(remote));
  await t.delete('sync-aaa-111'); // 文件与索引都没有 → 视为成功（既有语义）
  assert.equal(remote.calls.some((c) => c.method === 'PUT' && c.key === PREFIX + '/index.json'), false, '无变更不写回索引');
  assert.equal(remote.deletedBlobs.length, 0, '不得删除 blob');
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true, '索引之外的快照文件引用的 blob 也不得被删（真空集合不等于无引用证据）');
});

test('N1④：索引可读且剩余快照仍引用该 blob → 在用 blob 绝不被删（回归 F1/F3 口径）', async () => {
  const remote = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
  });
  const t = new S3Transport(makeOptions(remote));
  await t.delete('sync-aaa-111');
  const idxPut = remote.calls.filter((c) => c.method === 'PUT' && c.key === PREFIX + '/index.json');
  assert.deepEqual(JSON.parse(idxPut[idxPut.length - 1]!.body ?? 'null'), [meta('sync-ccc-333', '3')], '索引摘除目标条目');
  assert.equal(remote.deletedBlobs.length, 0, '仍被 sync-ccc-333 引用的 blob 不得删除');
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true);
});

test('N1⑤：索引有条目但该快照文件读不出来（非 404）→ 本轮放弃 GC（读不出来 ≠ 没引用）', async () => {
  const remote = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': snapOf('sync-ccc-333', WITH_BLOB_REF) },
    failSnapshotGet: { [PREFIX + '/sync-ccc-333.json']: 500 },
  });
  const t = new S3Transport(makeOptions(remote));
  await t.delete('sync-aaa-111');
  assert.equal(remote.deletedBlobs.length, 0, '读不出 sync-ccc-333 就无法证明它没引用 blob → 本轮不得删任何 blob');
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true);
});

test('N1⑥（SYN-04）：索引有条目但该快照文件真 404 → 本轮放弃 GC（404 也证明不了「没引用」）+ 记放弃码', async () => {
  const remote = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN) },
  });
  const t = new S3Transport(makeOptions(remote));
  await t.delete('sync-aaa-111');
  assert.equal(remote.deletedBlobs.length, 0, '404 与「读不出来」同属「无法证明没有引用」→ 本轮 0 删除');
  assert.equal(remote.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true, '没有被证明无引用的 blob 必须保留');
  assert.equal(t.lastGcSkip, 'gc-skip-reference-missing', '必须记下本轮放弃码（机器可判定，文案由上层按码翻译）');
});

test('N1⑦（SYN-04）：引用者 200 但内容坏掉 → 本轮放弃，放弃码 = snapshot-unparsable', async () => {
  const remote = makeRemote({
    index: JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-ccc-333', '3')]),
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', PLAIN), 'sync-ccc-333': 'not-json' },
  });
  const t = new S3Transport(makeOptions(remote));
  await t.delete('sync-aaa-111');
  assert.equal(remote.deletedBlobs.length, 0, '解析不了 ⇒ 引用集不完整 ⇒ 本轮不得删任何 blob');
  assert.equal(t.lastGcSkip, 'gc-skip-snapshot-unparsable');
});
