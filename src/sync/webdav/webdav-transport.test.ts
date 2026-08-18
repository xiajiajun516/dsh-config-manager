/**
 * m-webdav-channel：WebDAV 同步通道测试（TDD：先红后绿）。
 *
 * 验证点（验收判据 m1-red-green + m1-interface）：
 * - 远端布局 <base>/snapshots/<id>.json + <base>/snapshots/index.json
 * - list：GET index.json，缺失视为空，按 createdAt 升序
 * - upload：幂等 MKCOL → PUT <id>.json → 合并写回 index.json；返回 computeSnapshotMeta
 * - download：GET <id>.json 解析成 SyncSnapshot；不存在抛错（契约）
 * - delete：DELETE <id>.json + 从 index.json 摘除；不存在视为成功
 * - 认证：HTTP Basic（username + credentials.getPassword()），可注入 request
 * - 安全：URL 拒绝 userinfo；错误脱敏（password 永不泄漏/不进日志）
 * - 超时：注入 request 抛超时 → 归一为带 timeout 的消息
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebDavTransport, WebDavTransportError } from './webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse, WebDavTransportOptions } from './webdav-transport.ts';
import { computeSnapshotMeta } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';

const TEST_PASSWORD = 'super-secret-password-9876';

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-08-16T12:00:00.000Z',
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

interface MockRequest { method: string; url: string; headers?: Record<string, string>; body?: string; }

/** 记录请求并交给 handler 返回响应 */
function mockReq(
  calls: MockRequest[],
  handler: (m: MockRequest) => WebDavResponse | Promise<WebDavResponse>,
): WebDavRequestFn {
  return async (method, url, opts = {}) => {
    const rec: MockRequest = { method, url, headers: opts.headers, body: opts.body };
    calls.push(rec);
    return handler(rec);
  };
}

function makeCalls(): MockRequest[] {
  return [];
}

function makeOptions(overrides: Partial<WebDavTransportOptions> = {}): WebDavTransportOptions {
  return {
    baseUrl: 'https://dav.example.com/dav/config',
    username: 'alice',
    credentials: { getPassword: async () => TEST_PASSWORD },
    request: mockReq(makeCalls(), () => res(404, '')), // 默认 handler 需被覆盖
    ...overrides,
  };
}

function res(status: number, bodyText: string): WebDavResponse {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

/* ---------------- 构造校验 ---------------- */

test('构造：baseUrl/username/credentials 必填；非法 URL 拒绝', () => {
  assert.throws(() => new WebDavTransport({ baseUrl: '', username: 'a', credentials: { getPassword: async () => '' } } as never), /baseUrl/);
  assert.throws(() => new WebDavTransport({ baseUrl: 'not-a-url', username: 'a', credentials: { getPassword: async () => '' } } as never), /无法解析/);
  assert.throws(
    () => new WebDavTransport({ baseUrl: 'https://dav.example.com/dav', username: '', credentials: { getPassword: async () => '' } } as never),
    /username/,
  );
  assert.throws(
    () => new WebDavTransport({ baseUrl: 'https://dav.example.com/dav', username: 'a', credentials: null } as never),
    /credentials/,
  );
});

test('构造：baseUrl 带 userinfo（username:password@）→ 拒绝（安全性）', () => {
  assert.throws(
    () => new WebDavTransport({
      baseUrl: 'https://alice:sekrit@dav.example.com/dav',
      username: 'alice',
      credentials: { getPassword: async () => '' },
    } as never),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError);
      assert.ok(!String((err as Error).message).includes('sekrit'), '错误消息不得泄漏 URL 内嵌密码');
      assert.match(String((err as Error).message), /userinfo|用户名|密码/);
      return true;
    },
  );
});

/* ---------------- list ---------------- */

test('list：index.json 缺失（404）→ 空列表', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    assert.equal(m.method, 'GET');
    assert.equal(m.url, 'https://dav.example.com/dav/config/snapshots/index.json');
    return res(404, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  assert.deepEqual(await t.list(), []);
});

test('list：带已存在 index → 返回按 createdAt 升序的 meta 列表', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    const metaB = computeSnapshotMeta(sampleSnapshot({ id: 'snap-b', createdAt: '2026-08-16T11:00:00.000Z' }));
    const metaA = computeSnapshotMeta(sampleSnapshot({ id: 'snap-a', createdAt: '2026-08-16T09:00:00.000Z' }));
    const metaC = computeSnapshotMeta(sampleSnapshot({ id: 'snap-c', createdAt: '2026-08-16T12:00:00.000Z' }));
    return res(200, JSON.stringify([metaB, metaA, metaC]));
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const listed = await t.list();
  assert.deepEqual(listed.map((x) => x.id), ['snap-a', 'snap-b', 'snap-c'], '应按 createdAt 升序');
  assert.equal(listed[0]!.createdAt, '2026-08-16T09:00:00.000Z');
});

test('list：index.json 结构非法 → 抛错（清晰消息）', async () => {
  const handler = (): WebDavResponse => res(200, '{"not":"an array"}');
  const t = new WebDavTransport(makeOptions({ request: mockReq(makeCalls(), handler) }));
  await assert.rejects(t.list(), /index/i);
});

/* ---------------- upload ---------------- */

test('upload：幂等 MKCOL → PUT <id>.json → 合并写回 index.json，返回 computeSnapshotMeta', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'GET') return res(404, ''); // index 不存在
    if (m.method === 'PUT' && m.url.endsWith('/snap-001.json')) {
      assert.ok(m.body, '快照体应存在');
      assert.deepEqual(JSON.parse(m.body!), sampleSnapshot(), 'PUT 体应为完整快照');
      return res(201, '');
    }
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) {
      const idx = JSON.parse(m.body!);
      assert.ok(Array.isArray(idx), 'index 应为数组');
      assert.equal(idx.length, 1);
      assert.equal(idx[0]!.id, 'snap-001');
      return res(201, '');
    }
    return res(405, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const meta = await t.upload(sampleSnapshot());
  assert.deepEqual(meta, computeSnapshotMeta(sampleSnapshot()));

  // 请求顺序：MKCOL snapshots → PUT <id>.json → GET index → PUT index
  assert.equal(calls[0]!.method, 'MKCOL', '应先创建 snapshots 集合');
  assert.equal(calls[0]!.url, 'https://dav.example.com/dav/config/snapshots/');
  assert.equal(calls[1]!.method, 'PUT', '先写快照文件');
  assert.match(calls[1]!.url, /snap-001\.json$/);
  assert.equal(calls[2]!.method, 'GET', '读现有 index 以合并');
  assert.equal(calls[3]!.method, 'PUT');
  assert.match(calls[3]!.url, /index\.json$/);
});

test('upload：MKCOL 405（已存在集合）→ 幂等成功', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(404, '');
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const meta = await t.upload(sampleSnapshot());
  assert.equal(meta.id, 'snap-001');
});

test('upload：同 id 再上传 → index 合并（保留其他 id，替换同 id 条目）', async () => {
  const calls = makeCalls();
  const existing = [computeSnapshotMeta(sampleSnapshot({ id: 'snap-old', createdAt: '2026-08-16T01:00:00.000Z' }))];
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(200, JSON.stringify(existing));
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) {
      const idx = JSON.parse(m.body!) as Array<{ id: string }>;
      const ids = idx.map((x) => x.id);
      assert.ok(ids.includes('snap-old'), '应保留旧条目');
      assert.ok(ids.includes('snap-001'), '应加入/覆盖新条目');
      assert.equal(idx.filter((x) => x.id === 'snap-001').length, 1, '同 id 不得重复');
      return res(201, '');
    }
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.upload(sampleSnapshot());
  await t.upload(sampleSnapshot({ createdAt: '2026-08-16T13:00:00.000Z' }));
});

/* ---------------- download ---------------- */

test('download：GET <id>.json 解析成 SyncSnapshot（roundtrip 一致）', async () => {
  const calls = makeCalls();
  const snap = sampleSnapshot();
  const handler = (m: MockRequest): WebDavResponse => {
    assert.equal(m.method, 'GET');
    assert.equal(m.url, 'https://dav.example.com/dav/config/snapshots/snap-001.json');
    return res(200, JSON.stringify(snap));
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  assert.deepEqual(await t.download('snap-001'), snap);
});

test('download：不存在的 id（404）→ 抛错（契约），消息含 id', async () => {
  const handler = (): WebDavResponse => res(404, '');
  const t = new WebDavTransport(makeOptions({ request: mockReq(makeCalls(), handler) }));
  await assert.rejects(
    t.download('missing-001'),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError);
      assert.match(err.message, /missing-001/);
      assert.match(err.message, /不存在/);
      return true;
    },
  );
});

/* ---------------- delete ---------------- */

test('delete：DELETE <id>.json + 摘除 index 条目并写回', async () => {
  const calls = makeCalls();
  const existing = [
    computeSnapshotMeta(sampleSnapshot({ id: 'snap-keep', createdAt: '2026-08-16T01:00:00.000Z' })),
    computeSnapshotMeta(sampleSnapshot({ id: 'snap-del', createdAt: '2026-08-16T02:00:00.000Z' })),
  ];
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'DELETE') {
      assert.equal(m.url, 'https://dav.example.com/dav/config/snapshots/snap-del.json');
      return res(204, '');
    }
    if (m.method === 'GET') return res(200, JSON.stringify(existing));
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) {
      const idx = JSON.parse(m.body!) as Array<{ id: string }>;
      assert.deepEqual(idx.map((x) => x.id), ['snap-keep'], '应从 index 摘除被删条目');
      return res(201, '');
    }
    return res(204, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.delete('snap-del');
});

test('delete：文件不存在（404）→ 视为成功，仍写回聚合 index', async () => {
  const calls = makeCalls();
  const existing = [computeSnapshotMeta(sampleSnapshot({ id: 'snap-del', createdAt: '2026-08-16T02:00:00.000Z' }))];
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'DELETE') return res(404, '');
    if (m.method === 'GET') return res(200, JSON.stringify(existing));
    if (m.method === 'PUT') return res(201, '');
    return res(404, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.delete('snap-del'); // 不抛错
  assert.ok(calls.some((c) => c.method === 'PUT' && /index\.json$/.test(c.url)), '应写回 index');
});

test('delete：快照与 index 都不存在 → 静默成功（无 PUT 写回）', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'GET') return res(404, '');
    if (m.method === 'DELETE') return res(404, '');
    return res(404, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.delete('never-existed');
  assert.ok(!calls.some((c) => c.method === 'PUT'), '无 index 变更时不应写回');
});

/* ---------------- 认证 ---------------- */

test('认证：请求带 Authorization: Basic base64(username:password)', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'GET') return res(404, '');
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.list();
  const req = calls[0]!;
  const expected = 'Basic ' + Buffer.from(`alice:${TEST_PASSWORD}`).toString('base64');
  assert.equal(req.headers?.['Authorization'], expected);
  // Authorization 值本身不含明文 password
  assert.ok(!String(req.headers?.['Authorization']).includes(TEST_PASSWORD));
});

/* ---------------- 安全性：错误脱敏 / 密码不泄漏 ---------------- */

test('安全：错误消息脱敏——服务器错误文本含 password → 抛出消息替换为 [REDACTED]', async () => {
  const calls = makeCalls();
  const handler = (): WebDavResponse => res(401, `auth failed with ${TEST_PASSWORD} in body`);
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await assert.rejects(
    t.list(),
    (err: unknown) => {
      const msg = String((err as Error).message);
      assert.ok(!msg.includes(TEST_PASSWORD), `错误消息泄漏 password: ${msg}`);
      assert.match(msg, /\[REDACTED\]/);
      return true;
    },
  );
});

test('安全：password 永不进入 URL/错误——要求头为 base64 Basic，明文 password 不出现于任何请求 URL 或抛错消息', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'GET') return res(404, '');
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.list();
  const header = String(calls[0]!.headers?.['Authorization']);
  // 要求头为标准 Basic base64（user:password），且 header 值本身不含明文 password
  assert.match(header, /^Basic [A-Za-z0-9+/=]+$/);
  assert.ok(!header.includes(TEST_PASSWORD), 'header 不应含明文 password');
  // 任何请求 URL 都不含明文 password
  for (const c of calls) assert.ok(!c.url.includes(TEST_PASSWORD), `URL 泄漏 password: ${c.url}`);
});

/* ---------------- 超时 ---------------- */

test('超时：注入 request 抛超时 → 归一为带 method/url/timeout 的消息', async () => {
  const t = new WebDavTransport(makeOptions({
    baseUrl: 'https://dav.example.com/dav/config',
    username: 'alice',
    credentials: { getPassword: async () => TEST_PASSWORD },
    request: async (method, url) => {
      const e = new Error(`fetch timed out after 5000ms`);
      (e as Error & { name: string }).name = 'TimeoutError';
      throw e;
    },
  }));
  await assert.rejects(
    t.list(),
    (err: unknown) => {
      assert.ok(err instanceof WebDavTransportError);
      assert.match(err.message, /超时|timeout/i);
      assert.ok(err.message.includes('GET'));
      return true;
    },
  );
});

/* ---------------- 快照 id 安全 ---------------- */

test('快照 id 安全：非法 id（路径穿越/特殊字符）→ upload/download/delete 均拒绝', async () => {
  const t = new WebDavTransport(makeOptions({ request: mockReq(makeCalls(), () => res(404, '')) }));
  for (const bad of ['../evil', 'a/b', 'a\\b', '.', '..', 'snap\ninject', 'index']) {
    await assert.rejects(t.upload(sampleSnapshot({ id: bad })), /非法快照 id/);
    await assert.rejects(t.download(bad), /非法快照 id/);
    await assert.rejects(t.delete(bad), /非法快照 id/);
  }
});
