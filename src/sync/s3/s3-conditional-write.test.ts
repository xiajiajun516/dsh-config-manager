/**
 * S3 兼容系通道：本轮借鉴项的**针对性**单测（不重复 s3-transport.test.ts 的既有契约）。
 *  - ① 条件写：索引 ETag → if-match；索引缺失且远端无内容 → if-none-match: *；
 *    索引 PUT 412 → conflict；409 **带条件头** → conflict；
 *    409 **不带条件头** → 绝不走并发写冲突那条路径（isConcurrentWrite 只认带条件头的 409）；
 *  - ② 探针：HEAD 回 301/307/308 + x-amz-bucket-region → 抛错且文案里带可执行的 region；
 *    404 / 403 各自文案；HEAD 200 时读索引回报快照数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport, S3TransportError } from './s3-transport.ts';
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts';
import { SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import { s3Msg } from './messages.ts';

const ENDPOINT = 'https://minio.example.com:9000';
const BUCKET = 'demo-bucket';
const PREFIX = 'dsh-config-manager';
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const BASE_OBJECT = ENDPOINT + '/' + BUCKET + '/' + PREFIX;
const INDEX_URL = BASE_OBJECT + '/index.json';
const BLOBS_INDEX_URL = BASE_OBJECT + '/blobs-index.json';
const SNAPSHOT_URL = BASE_OBJECT + '/snap-001.json';

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

function makeOptions(request: S3RequestFn, overrides: Partial<S3TransportOptions> = {}): S3TransportOptions {
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
    ...overrides,
  };
}

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-10-18T10:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
    ...overrides,
  };
}

const putIndexCalls = (calls: S3Call[]): S3Call[] => calls.filter((c) => c.method === 'PUT' && c.url === INDEX_URL);

/* ---------------- ① 条件写 ---------------- */

test('条件写①：索引 GET 回 ETag → 索引 PUT 带 if-match（小写头）钉住该 ETag', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1-s3"' });
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const puts = putIndexCalls(calls);
  assert.equal(puts.length, 1, '索引只 PUT 一次');
  assert.equal(puts[0]!.headers['if-match'], '"v1-s3"', '有 ETag 时必须用 if-match');
  assert.equal(puts[0]!.headers['if-none-match'], undefined);
});

test('条件写①：索引 404 且远端无内容（blobs-index 404）→ 索引 PUT 带 if-none-match: *', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(404, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const puts = putIndexCalls(calls);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.headers['if-none-match'], '*', '首推（远端无内容）必须用 if-none-match: * 防两设备同时首推');
  assert.equal(puts[0]!.headers['if-match'], undefined);
});

test('条件写①：索引 PUT 回 412（带条件头）→ 抛 conflict，文案来自 sync.s3.concurrentWrite', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1-s3"' });
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(412, 'PreconditionFailed');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.ok(err instanceof SyncTransportError, '统一错误基类（上层按 kind 分流）');
      assert.equal(err.kind, 'conflict');
      assert.equal(err.retryable, false);
      assert.equal(err.status, 412);
      assert.equal(err.message, s3Msg('sync.s3.concurrentWrite', { status: '412', url: INDEX_URL }));
      return true;
    },
  );
});

test('条件写①：索引 PUT 回 409 且**带了条件头** → 仍判 conflict（S3 兼容端点的并发写语义）', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: '"v1-s3"' });
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(409, 'Conflict');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'conflict');
      assert.equal(err.status, 409);
      assert.equal(err.message, s3Msg('sync.s3.concurrentWrite', { status: '409', url: INDEX_URL }));
      return true;
    },
  );
});

test('回归：索引 PUT 回 409 但**没带条件头** → 不得被当成并发写冲突（SSE/无条件写场景）', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    // 服务端不返回 ETag、索引又存在（非 404）⇒ 条件头为空 ⇒ 无条件写
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]');
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(200, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(409, 'Conflict');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.status, 409);
      const put = putIndexCalls(calls)[0]!;
      assert.equal(Object.keys(put.headers).filter((k) => k === 'if-match' || k === 'if-none-match').length, 0,
        '本用例前提：这一 PUT 确实没带条件头');
      assert.notEqual(
        err.message,
        s3Msg('sync.s3.concurrentWrite', { status: '409', url: INDEX_URL }),
        '无条件的 409 另有含义，绝不能套用「远端被其它设备改过」的并发写文案',
      );
      assert.equal(
        err.message,
        s3Msg('sync.s3.requestFailed', { method: 'PUT', url: INDEX_URL, status: '409', err: 'Conflict' }),
        '应走通用请求失败文案（isConcurrentWrite 只认带条件头的 409）',
      );
      return true;
    },
  );
});

test('条件写①（删除路径）：delete 读 index 拿 ETag → 写回剩余索引的 PUT 带 if-match；412 → conflict', async () => {
  const meta = {
    id: 'snap-001',
    createdAt: '2026-10-18T09:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const make = (putStatus: number) => new S3Transport(makeOptions(record([], (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([meta]), { etag: '"v1-del"' });
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(putStatus, putStatus === 412 ? 'PreconditionFailed' : '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([meta]), { etag: '"v1-del"' });
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(200, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));
  await t.delete('snap-001');
  const put = putIndexCalls(calls)[0]!;
  assert.equal(put.headers['if-match'], '"v1-del"', '删除路径的索引写回同样是条件写');
  assert.equal(put.body, '[]');

  await assert.rejects(
    () => make(412).delete('snap-001'),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.kind, 'conflict');
      assert.equal(err.status, 412);
      assert.equal(err.message, s3Msg('sync.s3.concurrentWrite', { status: '412', url: INDEX_URL }));
      return true;
    },
  );
});

/* ---------------- ② 探针 ---------------- */

test('② 探针：HEAD 回 301 + x-amz-bucket-region: cn-hangzhou → 抛错且文案含该 region', async () => {
  const calls: S3Call[] = [];
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'HEAD') return res(301, '', { 'x-amz-bucket-region': 'cn-hangzhou' });
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.probe(),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.equal(err.status, 301);
      assert.equal(err.kind, 'client');
      assert.equal(err.message, s3Msg('sync.s3.probeRegionRedirect', { region: 'cn-hangzhou' }));
      assert.match(err.message, /cn-hangzhou/, '文案必须给出可执行的 region 提示');
      return true;
    },
  );
  assert.equal(calls.length, 1, '301 应立即抛错，不再读索引');
});

test('② 探针：region 头缺失 / 大写形态 → 分别走「无 region 提示」与正常解析', async () => {
  const callsA: S3Call[] = [];
  const tA = new S3Transport(makeOptions(record(callsA, (m) => (m.method === 'HEAD' ? res(307, '') : res(500, '')))));
  await assert.rejects(
    () => tA.probe(),
    (err: unknown) => {
      assert.equal((err as S3TransportError).message, s3Msg('sync.s3.probeRedirectNoRegion', { status: '307' }));
      assert.equal((err as S3TransportError).status, 307);
      return true;
    },
  );

  const callsB: S3Call[] = [];
  const tB = new S3Transport(makeOptions(record(callsB, (m) => {
    if (m.method === 'HEAD') return res(308, '', { 'X-Amz-Bucket-Region': 'ap-guangzhou' });
    return res(500, '');
  })));
  await assert.rejects(
    () => tB.probe(),
    (err: unknown) => {
      assert.equal((err as S3TransportError).message, s3Msg('sync.s3.probeRegionRedirect', { region: 'ap-guangzhou' }));
      return true;
    },
  );
});

test('② 探针：HEAD 404 → 桶不存在文案（kind=notfound）；HEAD 403 → 权限文案（kind=auth）', async () => {
  const mk = (status: number): S3Transport => new S3Transport(makeOptions(record([], (m) => {
    if (m.method === 'HEAD') return res(status, '');
    return res(500, '');
  })));

  await assert.rejects(
    () => mk(404).probe(),
    (err: unknown) => {
      assert.equal((err as S3TransportError).message, s3Msg('sync.s3.probeBucketMissing'));
      assert.equal((err as S3TransportError).kind, 'notfound');
      assert.equal((err as S3TransportError).status, 404);
      return true;
    },
  );
  await assert.rejects(
    () => mk(403).probe(),
    (err: unknown) => {
      assert.equal((err as S3TransportError).message, s3Msg('sync.s3.probeAccessDenied'));
      assert.equal((err as S3TransportError).kind, 'auth');
      assert.equal((err as S3TransportError).status, 403);
      return true;
    },
  );
});

test('② 探针：HEAD 200 + index 有 1 条 → snapshotCount=1、message 带计数、零写入', async () => {
  const calls: S3Call[] = [];
  const meta = {
    id: 'snap-a',
    createdAt: '2026-10-18T08:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const t = new S3Transport(makeOptions(record(calls, (m) => {
    if (m.method === 'HEAD') return res(200, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([meta]));
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();
  assert.equal(result.snapshotCount, 1);
  assert.equal(result.message, s3Msg('sync.s3.probeOk', { count: '1' }));
  assert.equal(calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE').length, 0, '探针零写入');
});
