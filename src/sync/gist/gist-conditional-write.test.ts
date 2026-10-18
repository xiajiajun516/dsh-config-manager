/**
 * GitHub Gist 通道：本轮借鉴项的**针对性**单测（不重复 gist-transport.test.ts 的既有契约）。
 *  - ① 条件写：**强** ETag → PATCH 带 if-match；**弱** ETag（W/…）→ PATCH 不带 if-match（仍要写）；
 *    PATCH 回 412 → conflict；
 *  - ② 探针：GET /user 证明令牌有效 → 读 gist → snapshotCount + 非本前缀文件数进 hint（只读，零 PATCH）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GistTransport, GistTransportError, GIST_DEFAULT_FILE_PREFIX } from './gist-transport.ts';
import type { GistRequestFn, GistResponse, GistTransportOptions } from './gist-transport.ts';
import { SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import { gistMsg } from './messages.ts';

const GIST_ID = 'aa5a315d61ae9438b18d';
const TOKEN = 'ghp_ExampleTokenValueThatMustNeverLeak123456';
const API = 'https://api.github.com';
const GIST_URL = API + '/gists/' + GIST_ID;
const INDEX_FILE = GIST_DEFAULT_FILE_PREFIX + '-index.json';

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

/* ---------------- ① 条件写 ---------------- */

test('条件写①：强 ETag → PATCH 带 if-match 钉住读到的那一版', async () => {
  const calls: GistCall[] = [];
  const STRONG = '"strong-etag-1"';
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files: {} }), { etag: STRONG });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const patched = patches(calls);
  assert.equal(patched.length, 1, '必须发生且只发生一次 PATCH');
  assert.equal(patched[0]!.headers['if-match'], STRONG, '强 ETag 必须用于 if-match');
});

test('条件写①：弱 ETag（W/…）→ PATCH **不带** if-match，但写入照常发生', async () => {
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files: {} }), { etag: 'W/"weak-etag-1"' });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await t.upload(sampleSnapshot());

  const patched = patches(calls);
  assert.equal(patched.length, 1, '弱 ETag 不得让写入被跳过');
  assert.equal(patched[0]!.headers['if-match'], undefined,
    'HTTP 禁止用弱 ETag 做 If-Match（GitHub 会回 400）⇒ 必须退化为无条件写');
});

test('条件写①：PATCH 回 412 → 抛 conflict，文案来自字典键 sync.gist.concurrentWrite', async () => {
  const calls: GistCall[] = [];
  const t = new GistTransport(makeOptions(record(calls, (m) => {
    if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files: {} }), { etag: '"strong-etag-1"' });
    if (m.method === 'PATCH' && m.url === GIST_URL) return res(412, 'precondition failed');
    return res(500, 'unexpected ' + m.method + ' ' + m.url);
  })));

  await assert.rejects(
    () => t.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof GistTransportError);
      assert.ok(err instanceof SyncTransportError);
      assert.equal(err.kind, 'conflict');
      assert.equal(err.retryable, false);
      assert.equal(err.status, 412);
      assert.equal(err.message, gistMsg('sync.gist.concurrentWrite', { status: '412' }));
      return true;
    },
  );
});

test('条件写①（删除路径）：强 ETag → delete 的 PATCH 带 if-match；弱 ETag → 不带', async () => {
  const snapshotFile = GIST_DEFAULT_FILE_PREFIX + '-snap-001.json';
  const meta = {
    id: 'snap-001',
    createdAt: '2026-10-18T09:00:00.000Z',
    sections: {},
    manifest: { schemaVersion: 1, dshVersion: '1', platform: 'win32', sectionIds: [], containsSecrets: false },
  };
  const files = { [INDEX_FILE]: { content: JSON.stringify([meta]) }, [snapshotFile]: { content: '{}' } };

  const run = async (etag: string): Promise<GistCall> => {
    const calls: GistCall[] = [];
    const t = new GistTransport(makeOptions(record(calls, (m) => {
      if (m.method === 'GET' && m.url === GIST_URL) return res(200, JSON.stringify({ files }), { etag });
      if (m.method === 'PATCH' && m.url === GIST_URL) return res(200, '{}');
      return res(500, 'unexpected ' + m.method + ' ' + m.url);
    })));
    await t.delete('snap-001');
    const patched = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patched.length, 1);
    return patched[0]!;
  };

  assert.equal((await run('"strong-del-1"')).headers['if-match'], '"strong-del-1"', '删除路径的 PATCH 同样是条件写');
  assert.equal((await run('W/"weak-del-1"')).headers['if-match'], undefined, '弱 ETag 不得用于 if-match');

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
