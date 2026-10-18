/**
 * WebDAV 通道：本轮借鉴项的**针对性**单测（不重复 webdav-transport.test.ts 的既有契约）。
 *  - ① 条件写：索引 ETag → If-Match；索引缺失且远端无内容 → If-None-Match: *；
 *    索引 404 但远端已有内容 → 零写入中止（既有行为的回归钉子）；
 *  - ① 索引 PUT 回 412 → SyncTransportError(kind='conflict')，文案来自字典键 sync.webdav.concurrentWrite；
 *  - ③ 首连逐级 MKCOL：直连 409 → 对 baseUrl 每一层发 MKCOL → 重试目标集合；
 *    probe() 的 createdCollections **只含本次真建出来的层级**；
 *  - ② 探针：PROPFIND 401/403 必须抛错，绝不谎报连接正常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebDavTransport, WebDavTransportError } from './webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse, WebDavTransportOptions } from './webdav-transport.ts';
import { SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import { zhMsg } from '../../core/messages.ts';

const BASE = 'https://dav.example.com/dav/config';
const COL = BASE + '/dsh-config-manager';
const COL_URL = COL + '/';
const INDEX_URL = COL + '/index.json';
const BLOBS_INDEX_URL = COL + '/blobs-index.json';
const SNAPSHOT_URL = COL + '/snap-001.json';
const TEST_PASSWORD = 'super-secret-password-9876';

interface MockCall { method: string; url: string; headers?: Record<string, string>; body?: string }

function res(status: number, bodyText = '', headers?: Record<string, string>): WebDavResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(headers !== undefined ? { headers } : {}),
    async text() { return bodyText; },
  };
}

function makeOptions(request: WebDavRequestFn, overrides: Partial<WebDavTransportOptions> = {}): WebDavTransportOptions {
  return {
    baseUrl: BASE,
    username: 'alice',
    credentials: { getPassword: async () => TEST_PASSWORD },
    request,
    ...overrides,
  };
}

/** 记录每次请求的 mock 包装（请求头一并记录，条件写断言依赖它） */
function recorder(calls: MockCall[], handler: (m: MockCall) => WebDavResponse): WebDavRequestFn {
  return async (method, url, opts = {}) => {
    const rec: MockCall = { method, url, headers: opts.headers, body: opts.body };
    calls.push(rec);
    return handler(rec);
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

const putIndexCalls = (calls: MockCall[]): MockCall[] => calls.filter((c) => c.method === 'PUT' && c.url === INDEX_URL);
const mkcolUrls = (calls: MockCall[]): string[] => calls.filter((c) => c.method === 'MKCOL').map((c) => c.url);

/* ---------------- ① 条件写 ---------------- */

test('条件写①：GET index 回 ETag → 随后的索引 PUT 带 If-Match 钉住该 ETag', async () => {
  const calls: MockCall[] = [];
  const ETAG = '"v1-abc123"';
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: ETAG });
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(201, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(201, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const puts = putIndexCalls(calls);
  assert.equal(puts.length, 1, '索引必须只 PUT 一次');
  assert.equal(puts[0]!.headers?.['If-Match'], ETAG, '有 ETag 时必须用 If-Match 钉住读到的那一版');
  assert.equal(puts[0]!.headers?.['If-None-Match'], undefined, '有 ETag 时不得同时发 If-None-Match');
});

test('条件写①：索引 404 且远端确无内容（blobs-index 也 404）→ PUT 带 If-None-Match: *', async () => {
  const calls: MockCall[] = [];
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(404, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(201, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(201, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const puts = putIndexCalls(calls);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.headers?.['If-None-Match'], '*', '首推（远端无内容）必须用 If-None-Match: * 防两设备同时首推');
  assert.equal(puts[0]!.headers?.['If-Match'], undefined);
});

test('回归：索引 404 但远端已有内容（blobs-index 有记录）→ 任何字节都不写就中止', async () => {
  const calls: MockCall[] = [];
  const blobHash = 'a'.repeat(64);
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(404, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(200, JSON.stringify({ [blobHash]: 1 }));
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError, '必须是 WebDavTransportError');
      assert.equal(err.kind, 'protocol', '缺信息而不是事实 → protocol（不可重试）');
      assert.equal(err.retryable, false);
      return true;
    },
  );
  const writes = calls.filter((c) => c.method !== 'MKCOL' && c.method !== 'GET');
  assert.deepEqual(writes.map((c) => c.method), [], '零写入：索引 404 + 远端有内容时不得有任何 PUT/DELETE');
});

test('条件写①：索引 PUT 回 412 → 抛 conflict，文案来自字典键 sync.webdav.concurrentWrite', async () => {
  const calls: MockCall[] = [];
  const ETAG = '"v1-abc123"';
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]', { etag: ETAG });
    if (m.method === 'PUT' && m.url === SNAPSHOT_URL) return res(201, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(412, 'precondition failed');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError);
      assert.ok(err instanceof SyncTransportError, '必须是统一错误基类（上层按 kind 分流）');
      assert.equal(err.kind, 'conflict');
      assert.equal(err.retryable, false, '并发冲突需人工重跑，绝不自动重试');
      assert.equal(err.status, 412);
      assert.equal(
        err.message,
        zhMsg('sync.webdav.concurrentWrite', { status: '412', url: INDEX_URL }),
        '文案必须来自字典键（不是硬编码）',
      );
      assert.match(err.message, /412/);
      return true;
    },
  );
});

test('条件写①（删除路径）：delete 读 index 拿 ETag → 写回剩余索引的 PUT 带 If-Match', async () => {
  const calls: MockCall[] = [];
  const ETAG = '"v1-del"';
  const meta = {
    id: 'snap-001',
    createdAt: '2026-10-18T09:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([meta]), { etag: ETAG });
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(201, '');
    if (m.method === 'GET' && m.url === BLOBS_INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.delete('snap-001');

  const puts = putIndexCalls(calls);
  assert.equal(puts.length, 1, '删除后必须写回一次索引');
  assert.equal(puts[0]!.headers?.['If-Match'], ETAG, '删除路径的索引写回同样是条件写');
  assert.equal(puts[0]!.headers?.['If-None-Match'], undefined);
  assert.equal(puts[0]!.body, '[]', '剩余索引确实摘掉了目标条目');
});

test('条件写①（删除路径）：索引写回回 412 → conflict（绝不静默吞掉并发冲突）', async () => {
  const calls: MockCall[] = [];
  const meta = {
    id: 'snap-001',
    createdAt: '2026-10-18T09:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify([meta]), { etag: '"v1-del"' });
    if (m.method === 'DELETE' && m.url === SNAPSHOT_URL) return res(204, '');
    if (m.method === 'PUT' && m.url === INDEX_URL) return res(412, 'precondition failed');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.delete('snap-001'),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError);
      assert.equal(err.kind, 'conflict');
      assert.equal(err.status, 412);
      assert.equal(err.message, zhMsg('sync.webdav.concurrentWrite', { status: '412', url: INDEX_URL }));
      return true;
    },
  );
});

/* ---------------- ③ 首连逐级 MKCOL ---------------- */

test('③ 首连自建：MKCOL 首次 409 → 逐层补齐 baseUrl → 重试目标集合；probe 只回报本次真建的层级', async () => {
  const calls: MockCall[] = [];
  const DAV_URL = 'https://dav.example.com/dav/';
  const CONFIG_URL = 'https://dav.example.com/dav/config/';
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL' && m.url === COL_URL) {
      // 首连 = 缺父目录（409）；重试 = 建成功（201）
      const prior = calls.filter((c) => c.method === 'MKCOL' && c.url === COL_URL).length;
      return prior === 1 ? res(409, 'Conflict') : res(201, '');
    }
    if (m.method === 'MKCOL' && m.url === DAV_URL) return res(201, '');       // 本次真建
    if (m.method === 'MKCOL' && m.url === CONFIG_URL) return res(405, '');    // 早就存在 → 不回报
    if (m.method === 'PROPFIND') return res(207, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();

  assert.deepEqual(mkcolUrls(calls), [COL_URL, DAV_URL, CONFIG_URL, COL_URL],
    'MKCOL 顺序 = 首连目标集合(409) → baseUrl 每一层(top-down) → 重试目标集合');
  assert.deepEqual(result.createdCollections, [DAV_URL, COL_URL],
    'createdCollections = 本次所有真建出来的目录（含重试建出的目标集合；405 的 config/ 不进）');
  assert.equal(result.snapshotCount, 0, '索引 404（全新远端）= 0 份快照');
  assert.equal(result.message, zhMsg('sync.webdav.probeOk', { count: '0' }));
});

test('③ 首连自建：重试仍回 409（网盘「已存在」语义）→ 按成功接受，不谎报已创建', async () => {
  const calls: MockCall[] = [];
  const DAV_URL = 'https://dav.example.com/dav/';
  const CONFIG_URL = 'https://dav.example.com/dav/config/';
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL' && m.url === COL_URL) return res(409, 'Conflict'); // 首连与重试都 409
    if (m.method === 'MKCOL' && m.url === DAV_URL) return res(405, '');          // 上级已存在
    if (m.method === 'MKCOL' && m.url === CONFIG_URL) return res(409, '');       // 上级已存在（网盘回 409）
    if (m.method === 'PROPFIND') return res(207, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(404, '');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();
  assert.deepEqual(mkcolUrls(calls), [COL_URL, DAV_URL, CONFIG_URL, COL_URL],
    '重试确实发生（不是首连 409 就直接放弃）');
  assert.equal(result.createdCollections, undefined,
    '没有任何一层真返回 201/200/204 → 省略 createdCollections（不谎报「已创建」）');
  assert.equal(result.snapshotCount, 0);
});

test('③ 首连失败（非 409）：401/403/5xx 必须立即抛错，不进入逐级自建', async () => {
  for (const status of [401, 403, 500]) {
    const calls: MockCall[] = [];
    const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
      if (m.method === 'MKCOL') return res(status, 'nope');
      return res(500, 'unexpected ' + m.method + ' ' + m.url);
    })));

    await assert.rejects(
      () => t.probe(),
      (err: unknown) => {
        assert.ok(err instanceof WebDavTransportError);
        assert.equal(err.status, status);
        assert.equal(err.kind, status >= 500 ? 'server' : 'auth');
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.method === 'MKCOL').length, 1,
      '非 409 的首连失败不得触发逐级 MKCOL（更不得吞成成功）');
  }
});

/* ---------------- ② 探针 ---------------- */

for (const status of [401, 403]) {
  test('② 探针：PROPFIND ' + status + ' → 抛错（kind=auth），绝不谎报连接正常', async () => {
    const calls: MockCall[] = [];
    const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
      if (m.method === 'MKCOL') return res(201, '');
      if (m.method === 'PROPFIND') return res(status, 'denied');
      return res(500, 'unexpected ' + m.method + ' ' + m.url);
    })));

    await assert.rejects(
      () => t.probe(),
      (err: unknown) => {
        assert.ok(err instanceof WebDavTransportError);
        assert.equal(err.kind, 'auth');
        assert.equal(err.retryable, false);
        assert.equal(err.status, status);
        assert.equal(err.message, zhMsg('sync.webdav.probeUnreachable', { status: String(status), url: COL_URL }));
        return true;
      },
    );
    assert.equal(calls.some((c) => c.method === 'GET'), false,
      'PROPFIND 鉴权失败后不得继续读索引（更不得回报连接正常）');
  });
}

test('② 探针：服务端不支持 PROPFIND（405）→ 退回索引作证据，不算失败', async () => {
  const calls: MockCall[] = [];
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'PROPFIND') return res(405, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, '[]');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();
  assert.equal(result.snapshotCount, 0);
  assert.equal(result.createdCollections, undefined, '本次没有新建层级 → 省略该字段');
});

test('② 探针：PROPFIND 207 + index 有 2 条 → snapshotCount=2、message 带计数', async () => {
  const calls: MockCall[] = [];
  const mkMeta = (id: string, createdAt: string): Record<string, unknown> => ({
    id,
    createdAt,
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  });
  const metas = [mkMeta('snap-a', '2026-10-18T08:00:00.000Z'), mkMeta('snap-b', '2026-10-18T09:00:00.000Z')];
  const t = new WebDavTransport(makeOptions(recorder(calls, (m) => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'PROPFIND') return res(207, '');
    if (m.method === 'GET' && m.url === INDEX_URL) return res(200, JSON.stringify(metas));
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();
  assert.equal(result.snapshotCount, 2);
  assert.equal(result.message, zhMsg('sync.webdav.probeOk', { count: '2' }));
  assert.equal(calls.filter((c) => c.method === 'PROPFIND').length, 1);
  assert.equal(calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE').length, 0,
    '探针零写入（索引与快照都不写）');
});
