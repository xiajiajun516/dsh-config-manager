/**
 * GitHub Gist 通道：本轮借鉴项的**针对性**单测（不重复 gist-transport.test.ts 的既有契约）。
 *  - ① **不做条件写**（issue #110，2026-10 实测）：`PATCH /gists/{id}` 对任何条件请求头都回 400
 *    （`Conditional request headers are not allowed in unsafe requests unless supported by the endpoint`），
 *    与 ETag 强弱无关 ⇒ PATCH 恒不带 if-match（upload 与 delete 两条路径都要钉住）；
 *  - ② 探针：GET /user 证明令牌有效 → 读 gist → snapshotCount + 非本前缀文件数进 hint（只读，零 PATCH）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GistTransport, GistTransportError, GIST_DEFAULT_FILE_PREFIX } from './gist-transport.ts';
import type { GistRequestFn, GistResponse, GistTransportOptions } from './gist-transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import { gistMsg } from './messages.ts';

const GIST_ID = 'aa5a315d61ae9438b18d';
const TOKEN = 'ghp_ExampleTokenValueThatMustNeverLeak123456';
const API = 'https://api.github.com';
const GIST_URL = API + '/gists/' + GIST_ID;
const INDEX_FILE = GIST_DEFAULT_FILE_PREFIX + '-index.json';
/** 任何条件请求头（出现即说明破坏了 gist 端点的约束） */
const CONDITIONAL_HEADERS = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

interface GistCall { method: string; url: string; headers: Record<string, string>; body?: string }

function res(status: number, bodyText = '', headers?: Record<string, string>): GistResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(headers !== undefined ? { headers } : {}),
    async text() { return bodyText; },
  };
}

function record(calls: GistCall[], handler: (m: GistCall) => GistResponse): GistRequestFn {
  return async (method, url, opts = {}) => {
    const rec: GistCall = { method, url, headers: opts.headers ?? {}, ...(opts.body !== undefined ? { body: opts.body } : {}) };
    calls.push(rec);
    return handler(rec);
  };
}

function makeOptions(request: GistRequestFn, overrides: Partial<GistTransportOptions> = {}): GistTransportOptions {
  return {
    gistId: GIST_ID,
    credentials: { getToken: async () => TOKEN },
    request,
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
      sectionIds: ['settings'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
    },
    ...overrides,
  };
}

const patches = (calls: GistCall[]): GistCall[] => calls.filter((c) => c.method === 'PATCH');

/** 断言：本次 PATCH 一个条件头都没带（回归 issue #110） */
function assertNoConditionalHeaders(call: GistCall | undefined, hint: string): void {
  assert.ok(call !== undefined, hint + '：必须发生 PATCH');
  const present = CONDITIONAL_HEADERS.filter((h) => call.headers[h] !== undefined);
  assert.deepEqual(present, [], hint + '：gist 端点拒绝任何条件请求头，带了就会 400');
}

/* ---------------- ① 不做条件写 ---------------- */

test('不做条件写①：强 ETag 也不得注入 if-match（issue #110 回归，带条件头 GitHub 回 400）', async () => {
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files: {} }), { etag: '"strong-etag-1"' });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const patched = patches(calls);
  assert.equal(patched.length, 1, '必须发生且只发生一次 PATCH');
  assertNoConditionalHeaders(patched[0], '强 ETag');
});

test('不做条件写①：弱 ETag（W/…）同样不带 if-match，写入照常发生', async () => {
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files: {} }), { etag: 'W/"weak-etag-1"' });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const patched = patches(calls);
  assert.equal(patched.length, 1, '弱/强 ETag 都不影响写入发生');
  assertNoConditionalHeaders(patched[0], '弱 ETag');
});

test('不做条件写①（删除路径）：强 ETag 下 delete 的 PATCH 也不带 if-match', async () => {
  const snapshotFile = GIST_DEFAULT_FILE_PREFIX + '-snap-001.json';
  const meta = {
    id: 'snap-001',
    createdAt: '2026-10-18T09:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const files = { [INDEX_FILE]: { content: JSON.stringify([meta]) }, [snapshotFile]: { content: '{}' } };
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files }), { etag: '"strong-del-1"' });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.delete('snap-001');

  const patched = patches(calls);
  assert.equal(patched.length, 1);
  assertNoConditionalHeaders(patched[0], '删除路径');
});

/* ---------------- ② 探针 ---------------- */

test('② 探针：gist 里有非本前缀文件 → hint 非空且含前缀与计数；snapshotCount 正确', async () => {
  const calls: GistCall[] = [];
  const meta = {
    id: 'snap-a',
    createdAt: '2026-10-18T08:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === API + '/user') return res(200, JSON.stringify({ login: 'alice' }));
    if (m.method === 'GET' && m.url === GIST_URL) {
      return res(200, JSON.stringify({
        files: {
          [INDEX_FILE]: { content: JSON.stringify([meta]) },
          'notes.md': { content: '别人的文件' },
        },
      }));
    }
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();

  assert.equal(result.snapshotCount, 1, '索引里 1 份快照');
  assert.equal(result.message, gistMsg('sync.gist.probeOk', { count: '1' }));
  assert.ok(result.hint !== undefined && result.hint !== '', '有非本前缀文件时必须给出 hint');
  assert.equal(result.hint, gistMsg('sync.gist.probeForeignContent', { count: '1', prefix: GIST_DEFAULT_FILE_PREFIX }));
  assert.match(result.hint!, /dsh-sync/, 'hint 必须点明本插件前缀');
  assert.equal(patches(calls).length, 0, '探针只读：绝不发 PATCH');
});

test('② 探针：gist 里全是本前缀文件 → hint 省略（不误报「别人的数据」）', async () => {
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === API + '/user') return res(200, JSON.stringify({ login: 'alice' }));
    if (m.method === 'GET' && m.url === GIST_URL) {
      return res(200, JSON.stringify({ files: { [INDEX_FILE]: { content: '[]' } } }));
    }
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  const result = await t.probe();
  assert.equal(result.hint, undefined);
  assert.equal(result.snapshotCount, 0);
  assert.equal(result.message, gistMsg('sync.gist.probeOk', { count: '0' }));
});

test('② 探针：GET /user 401/403 → 抛错（kind=auth），绝不谎报令牌有效', async () => {
  for (const status of [401, 403]) {
    const calls: GistCall[] = [];
    const t = new GistTransport(makeOptions(record(calls, (m) => {
      if (m.method === 'GET' && m.url === API + '/user') return res(status, 'bad credentials');
      return res(500, 'unexpected ' + m.method + ' ' + m.url);
    })));

    await assert.rejects(
      () => t.probe(),
      (err: unknown) => {
        assert.ok(err instanceof GistTransportError);
        assert.equal(err.kind, 'auth');
        assert.equal(err.status, status);
        assert.equal(err.message.includes(TOKEN), false, 'token 绝不进错误消息');
        return true;
      },
    );
    assert.equal(calls.some((c) => c.url === GIST_URL), false, '令牌校验失败后不得继续读 gist');
  }
});
