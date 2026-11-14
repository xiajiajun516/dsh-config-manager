/**
 * audit-sync sync-P6-1 / sync-P6-4（P3）的回归钉子（S3 兼容通道，与 WebDAV 同型同口径）：
 *
 * P6-1：delete 必须先条件写索引、后删对象。旧顺序在索引 PUT 冲突时留下「索引指向已删对象」的条目，
 *       list 不校验存在性 ⇒ 别的设备 pull 到该 id 即 notfound 硬失败。最坏情况改为「孤儿对象」：
 *       索引里不存在、list 看不到、pull 不会命中，重跑 delete 可补删。
 *
 * P6-4：blob 索引的「读失败」与「确实没有索引」必须分开（404 才是空）；读失败一律中止，
 *       绝不用一次整体 PUT 把已登记条目覆盖掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { S3Transport, S3TransportError } from './s3-transport.ts'
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts'
import type { SyncSnapshot } from '../transport.ts'
import { s3Msg } from './messages.ts'

const ENDPOINT = 'https://minio.example.com:9000'
const BUCKET = 'demo-bucket'
const PREFIX = 'dsh-config-manager'
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
const BASE_OBJECT = ENDPOINT + '/' + BUCKET + '/' + PREFIX
const BLOBS_PREFIX = BASE_OBJECT + '/blobs/'
const INDEX_URL = BASE_OBJECT + '/index.json'
const BLOBS_INDEX_URL = BASE_OBJECT + '/blobs-index.json'
const SNAPSHOT_URL = BASE_OBJECT + '/snap-001.json'
const OLD_HASH = 'a'.repeat(64)
const NEW_HASH = 'b'.repeat(64)

interface S3Call { method: string; url: string; headers: Record<string, string>; body?: string }

function res(status: number, bodyText = '', headers?: Record<string, string>): S3Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(headers !== undefined ? { headers } : {}),
    async text() { return bodyText; },
  };
}

function record(calls: S3Call[], handler: (m: S3Call) => S3Response): S3RequestFn {
  return async (method, url, opts = {}) => {
    const rec: S3Call = { method, url, headers: opts.headers ?? {}, ...(opts.body !== undefined ? { body: opts.body } : {}) };
    calls.push(rec);
    return handler(rec);
  };
}

function makeOptions(request: S3RequestFn): S3TransportOptions {
  return {
    provider: 'minio',
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    pathStyle: true,
    request,
    now: () => new Date('2026-10-18T10:00:00.000Z'),
  };
}

const META = {
  id: 'snap-001',
  createdAt: '2026-10-18T09:00:00.000Z',
  sections: {},
  manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
}

function sessionsSnapshot(): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-10-18T10:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['sessions'],
      containsSecrets: false,
    },
    sections: {
      sessions: {
        version: 1,
        files: [
          { relativePath: 's1.jsonl', data: new TextEncoder().encode('one'), contentHash: OLD_HASH },
          { relativePath: 's2.jsonl', data: new TextEncoder().encode('two'), contentHash: NEW_HASH },
        ],
      },
    },
  } as unknown as SyncSnapshot;
}

const callsOf = (calls: S3Call[], method: string, url: string): S3Call[] =>
  calls.filter((c) => c.method === method && c.url === url);

/* ---------------- P6-1：删除顺序 ---------------- */

test('P6-1（删除路径）：索引写回 412 → 快照对象零 DELETE（绝不留「索引指向已删对象」）', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([META]), { etag: '"v1-del"' });
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(412, 'precondition failed');
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.delete('snap-001'),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'conflict');
      assert.equal(err.message, s3Msg('sync.s3.concurrentWrite', { status: '412', url: INDEX_URL }));
      return true;
    },
  );
  assert.equal(callsOf(calls, 'DELETE', SNAPSHOT_URL).length, 0, '索引没写成功就绝不许删对象');
});

test('P6-1（删除路径）：成功路径顺序 = 先条件写索引（if-match），后 DELETE 快照对象', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([META]), { etag: '"v1-del"' });
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.delete('snap-001');

  const puts = callsOf(calls, 'PUT', INDEX_URL);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.headers['if-match'], '"v1-del"', '索引写回仍是条件写');
  assert.equal(puts[0]!.body, '[]');
  const putAt = calls.findIndex((c) => c.method === 'PUT' && c.url === INDEX_URL);
  const delAt = calls.findIndex((c) => c.method === 'DELETE' && c.url === SNAPSHOT_URL);
  assert.ok(putAt >= 0 && delAt >= 0);
  assert.ok(putAt < delAt, '索引必须先落盘，再删对象（P6-1）');
});

test('P6-1（删除路径）：索引无该 id 且对象存在 → 只删对象，不写回索引', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1-del"' });
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.delete('snap-001');

  assert.equal(callsOf(calls, 'PUT', INDEX_URL).length, 0, '索引无变化就不写回（N1③ 口径）');
  assert.equal(callsOf(calls, 'DELETE', SNAPSHOT_URL).length, 1, '孤儿对象仍按用户意图删掉');
});

/* ---------------- P6-4：blob 索引三态读 ---------------- */

test('P6-4：blob 索引 GET 500 → 上传可重试失败，快照与 blobs-index 零写入', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1"' });
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(503, 'backend down');
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sessionsSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'server');
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(callsOf(calls, 'PUT', SNAPSHOT_URL).length, 0, '读不出来就零写入');
  assert.equal(callsOf(calls, 'PUT', BLOBS_INDEX_URL).length, 0, '绝不整体覆盖');
});

test('P6-4：blob 索引 200 + 坏 JSON → protocol 错误，绝不覆盖成只有本次条目', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1"' });
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(200, '{not-json');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sessionsSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'protocol');
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(callsOf(calls, 'PUT', BLOBS_INDEX_URL).length, 0);
});

test('P6-4：写回前再读 blobs-index 失败 → 绝不 PUT（已登记条目不得被覆盖掉）', async () => {
  const calls: S3Call[] = [];
  let blobIdxReads = 0;
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1"' });
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) {
      blobIdxReads += 1;
      return blobIdxReads === 1 ? res(200, JSON.stringify({ [OLD_HASH]: 1 })) : res(500, 'flaky');
    }
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    if (m.method === 'PUT' && m.url.startsWith(BLOBS_PREFIX)) return res(200, '');
    if (m.method === 'PUT' && m.url === BLOBS_INDEX_URL) return res(200, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sessionsSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'server');
      return true;
    },
  );
  assert.equal(blobIdxReads, 2, '跳过判定一次 + 合并写回一次');
  assert.equal(callsOf(calls, 'PUT', BLOBS_INDEX_URL).length, 0, '读失败时绝不整体 PUT（P6-4 的核心）');
  assert.equal(callsOf(calls, 'PUT', SNAPSHOT_URL).length, 1, '快照已落盘：本次 blob 漏登记只占空间，不误删');
});

test('P6-4：blob 索引 404（确实没有索引）→ 照常上传并新建索引', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1"' });
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === BLOBS_INDEX_URL) return res(200, '');
    if (m.method === 'PUT' && m.url.startsWith(BLOBS_PREFIX)) return res(200, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sessionsSnapshot());

  const puts = callsOf(calls, 'PUT', BLOBS_INDEX_URL);
  assert.equal(puts.length, 1, '缺资源 = 空是安全的，必须照常建索引');
  const written = JSON.parse(puts[0]!.body ?? '{}') as Record<string, number>;
  assert.deepEqual(Object.keys(written).sort(), [OLD_HASH, NEW_HASH].sort());
});
