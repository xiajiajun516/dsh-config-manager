/**
 * m-webdav-channel：WebDAV 同步通道测试（TDD：先红后绿）。
 *
 * 验证点（验收判据 m1-red-green + m1-interface）：
 * - 远端布局 <base>/snapshots/<id>.json + <base>/snapshots/index.json
 * - list：GET index.json，缺失视为空，按 createdAt 升序
 * - upload：幂等 MKCOL → 快照级跳过（同 id 且 sections hash 全等免上传）→ PUT <id>.json →
 *   合并写回 index.json（meta 最后落盘）；返回 computeSnapshotMeta
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
import { computeSnapshotMeta, sectionsEqual } from '../transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta } from '../transport.ts';
import { encryptSectionsPayload } from '../snapshot-crypto.ts';
import type { SectionData, SectionId } from '../../schema/types.ts';

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

  // 请求顺序：MKCOL snapshots → GET index（跳过判定）→ PUT <id>.json → PUT index（meta 最后落盘）
  assert.equal(calls[0]!.method, 'MKCOL', '应先创建 snapshots 集合');
  assert.equal(calls[0]!.url, 'https://dav.example.com/dav/config/snapshots/');
  assert.equal(calls[1]!.method, 'GET', '应先读 index 做快照级跳过判定');
  assert.match(calls[1]!.url, /index\.json$/);
  assert.equal(calls[2]!.method, 'PUT', '再写快照文件');
  assert.match(calls[2]!.url, /snap-001\.json$/);
  assert.equal(calls[3]!.method, 'PUT', '最后写 index（meta 最后落盘）');
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

test('upload 快照级跳过：同 id 且 sections hash 全等 → 跳过 PUT 快照文件与 index 写回，直接返回远端 meta', async () => {
  const calls = makeCalls();
  const remoteMeta = computeSnapshotMeta(sampleSnapshot());
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(200, JSON.stringify([remoteMeta]));
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const meta = await t.upload(sampleSnapshot());
  assert.deepEqual(meta, remoteMeta, '内容全等 → 应直接返回远端 meta（含其 createdAt）');
  assert.deepEqual(calls.map((c) => c.method), ['MKCOL', 'GET'], '只应发生 MKCOL + GET index');
  assert.ok(!calls.some((c) => c.method === 'PUT'), '内容全等不得发生任何 PUT');
});

test('upload 快照级跳过：加密快照（sections 为空对象，无法明文比较）→ 必须照常上传，绝不跳过', async () => {
  const base = sampleSnapshot();
  const plain: Partial<Record<SectionId, SectionData>> = {};
  for (const [id, data] of Object.entries(base.sections)) {
    plain[id as SectionId] = data as SectionData;
  }
  const enc = await encryptSectionsPayload(plain, 'pw-12345678');
  const encSnap = sampleSnapshot({ sections: enc });
  const remoteMeta = computeSnapshotMeta(encSnap);
  assert.deepEqual(remoteMeta.sections, {}, '加密快照 meta.sections 应为空对象（密文无法明文比较）');
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(200, JSON.stringify([remoteMeta]));
    if (m.method === 'PUT' && m.url.endsWith('/snap-001.json')) return res(201, '');
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) return res(201, '');
    return res(405, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const meta = await t.upload(encSnap);
  assert.equal(meta.id, 'snap-001');
  assert.ok(
    calls.some((c) => c.method === 'PUT' && /snap-001\.json$/.test(c.url)),
    '加密快照无法比较 → 应照常 PUT 快照文件',
  );
  assert.ok(calls.some((c) => c.method === 'PUT' && /index\.json$/.test(c.url)), '应照常写回 index');
});

test('upload 快照级跳过：同 id 但 sections hash 不同 → 照常上传并覆盖 index 条目（唯一）', async () => {
  const calls = makeCalls();
  // 远端同 id 条目内容不同（theme: light vs 本地 dark）
  const remoteMeta = computeSnapshotMeta(sampleSnapshot({
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
  }));
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(200, JSON.stringify([remoteMeta]));
    if (m.method === 'PUT' && m.url.endsWith('/snap-001.json')) return res(201, '');
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) {
      const idx = JSON.parse(m.body!) as Array<{ id: string }>;
      assert.equal(idx.filter((x) => x.id === 'snap-001').length, 1, '同 id 条目应唯一（覆盖）');
      return res(201, '');
    }
    return res(405, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  const meta = await t.upload(sampleSnapshot());
  assert.equal(meta.id, 'snap-001');
  assert.ok(
    calls.some((c) => c.method === 'PUT' && /snap-001\.json$/.test(c.url)),
    '内容不同 → 应 PUT 快照文件',
  );
});

test('upload meta 最后落盘：快照文件 PUT 失败 → 绝不写 index（meta 不得先于快照落盘）', async () => {
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(405, '');
    if (m.method === 'GET') return res(404, '');
    if (m.method === 'PUT' && m.url.endsWith('/snap-001.json')) return res(500, 'disk full');
    return res(201, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await assert.rejects(t.upload(sampleSnapshot()), /失败|500/);
  assert.ok(
    !calls.some((c) => c.method === 'PUT' && /index\.json$/.test(c.url)),
    '快照文件未成功 → 不得写 index（meta 最后落盘不变量）',
  );
});

/* ---------------- sectionsEqual 纯函数 ---------------- */

test('sectionsEqual：全等 → true；键/值任一不同 → false；本地为空（加密）→ false', () => {
  const a = computeSnapshotMeta(sampleSnapshot());
  const same = computeSnapshotMeta(sampleSnapshot());
  const diff = computeSnapshotMeta(sampleSnapshot({
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
  }));
  const fewer = computeSnapshotMeta(sampleSnapshot({
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
    },
  }));
  assert.equal(sectionsEqual(a, same), true, '内容全等 → true');
  assert.equal(sectionsEqual(a, diff), false, '值不同 → false');
  assert.equal(sectionsEqual(a, fewer), false, '键集合不同 → false');
  // 本地为空对象（加密快照 meta）→ 无法比较 → false
  const empty: SyncSnapshotMeta = { ...a, sections: {} };
  assert.equal(sectionsEqual(a, empty), false, '本地为空 → false（加密快照必须上传）');
  assert.equal(sectionsEqual(empty, empty), false, '双方为空 → 仍 false（无法比较）');
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

test('回归：含文件分区（Uint8Array）的快照经 JSON 往返字节无损——PUT 存 base64、GET 还原 Uint8Array', async () => {
  const snap: SyncSnapshot = {
    ...sampleSnapshot(),
    sections: {
      ...sampleSnapshot().sections,
      skills: {
        version: 1,
        files: [
          { relativePath: 'coding.md', data: new Uint8Array(Buffer.from('# Coding\n', 'utf8')), contentHash: 'h1' },
          { relativePath: 'sub/notes.txt', data: new Uint8Array(Buffer.from('hello world', 'utf8')), contentHash: 'h2' },
        ],
      },
    },
  };
  let uploadedBody = '';
  const calls = makeCalls();
  const handler = (m: MockRequest): WebDavResponse => {
    if (m.method === 'MKCOL') return res(201, '');
    if (m.method === 'PUT' && m.url.endsWith('/snap-001.json')) {
      uploadedBody = m.body ?? '';
      return res(201, '');
    }
    if (m.method === 'PUT' && m.url.endsWith('/index.json')) return res(201, '');
    if (m.method === 'GET') return res(404, '');
    return res(405, '');
  };
  const t = new WebDavTransport(makeOptions({ request: mockReq(calls, handler) }));
  await t.upload(snap);
  // PUT 体必须是二进制安全形态：data 为 base64 标记对象而非数字索引对象
  const parsed = JSON.parse(uploadedBody) as { sections: { skills: { files: Array<{ data: unknown }> } } };
  const f0 = parsed.sections.skills.files[0]!.data as { $bin?: string };
  assert.equal(typeof f0.$bin, 'string', '文件 data 应为 { $bin: base64 }');
  assert.ok(!/\"0\"\s*:/.test(uploadedBody), '不得出现数字索引对象（Uint8Array 直序列化）');

  // download：远端返回该 body → 还原为 Uint8Array，字节无损
  const calls2 = makeCalls();
  const handler2 = (m: MockRequest): WebDavResponse => {
    if (m.method === 'GET') return res(200, uploadedBody);
    return res(405, '');
  };
  const t2 = new WebDavTransport(makeOptions({ request: mockReq(calls2, handler2) }));
  const roundtrip = await t2.download('snap-001');
  const files = (roundtrip.sections as { skills: { files: Array<{ data: Uint8Array; relativePath: string; contentHash?: string }> } }).skills.files;
  assert.ok(files[0]!.data instanceof Uint8Array, '还原后 data 必须是 Uint8Array（此前是普通对象 → Buffer.from 报错）');
  assert.equal(Buffer.from(files[0]!.data).toString('utf8'), '# Coding\n');
  assert.equal(Buffer.from(files[1]!.data).toString('utf8'), 'hello world');
  assert.equal(files[1]!.relativePath, 'sub/notes.txt');
  assert.equal(roundtrip.id, 'snap-001');
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
