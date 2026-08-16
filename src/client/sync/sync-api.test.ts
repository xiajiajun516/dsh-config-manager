/**
 * m-sync-ui：SyncApi（/api/dsh-config-manager/sync/*）请求契约测试。
 * 用全局 fetch mock 验证 status/push/pull 的路径/方法/请求体与响应解析（含 4xx 错误映射）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApiError } from '../api.ts';
import { SYNC_API, SyncApi } from './sync-api.ts';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchMock(handler: (call: FetchCall) => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return handler({ url: String(input), init });
  }) as typeof fetch;
  test.after(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('S-01 api.status()：GET 到 /sync/status，解析配置/凭据/上次同步', async () => {
  const body = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: true, credentialWritable: true,
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 3,
    transport: { type: 'git', ref: 'main' },
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  // 经读取函数解除闭包赋值导致的 CFA 窄化（called 在回调内赋值，外部保持 null 窄化）
  const lastCall = (): FetchCall | null => called;

  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.configured, true);
  assert.equal(result.repoUrl, 'https://github.com/u/r.git');
  assert.equal(result.credentialConfigured, true);
  assert.equal(lastCall()?.url, SYNC_API.status);
  assert.equal(lastCall()?.init?.method, undefined, 'GET 不设 method');
});

test('S-02 api.push()：POST /sync/push，请求体携带 repoUrl/token/gitBin', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-1', sections: ['settings'], warnings: [] });
  });

  const api = new SyncApi();
  const result = await api.push({ repoUrl: 'https://github.com/u/r.git', token: 'ghp_secret', gitBin: 'git' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshotId, 'sync-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.push);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal(sent['token'], 'ghp_secret');
  assert.equal(sent['gitBin'], 'git');
});

test('S-03 api.pull()：POST /sync/pull，strategy 缺省透传 merge，响应含差异摘要', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, {
      ok: true, snapshotId: 'sync-9',
      changes: [{ id: 'a', adapter: 'settings', kind: 'Conflict', description: '冲突', severity: 'warning' }],
      needsReview: true,
    });
  });

  const api = new SyncApi();
  const result = await api.pull({ repoUrl: 'https://github.com/u/r.git', strategy: 'merge' });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.kind, 'Conflict');
  assert.equal(result.needsReview, true);
  assert.equal(calls[0]?.url, SYNC_API.pull);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['strategy'], 'merge');
});

test('S-04 错误映射：4xx 携带 error → ConfigManagerApiError', async () => {
  installFetchMock(() => jsonResponse(400, { error: 'repoUrl is required' }));
  const api = new SyncApi();
  await assert.rejects(api.push({ repoUrl: '' }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /repoUrl is required/);
    return true;
  });
});

test('S-05 服务未挂载：404（非 JSON 体）→ ConfigManagerApiError 提示插件未加载', async () => {
  // 路由不存在时宿主返回 404 但无 JSON error → readJson 兜底为「插件未挂载」提示
  installFetchMock(() => new Response('Not Found', { status: 404 }));
  const api = new SyncApi();
  await assert.rejects(api.status(), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /未挂载/);
    return true;
  });
});

/* ------------------------------------------------ GitHub OAuth device flow 契约 */

test('S-06 api.githubStart()：POST /sync/github/start，解析 flowId/userCode/授权页', async () => {
  const body = {
    flowId: 'flow-1', userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5,
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });

  const api = new SyncApi();
  const result = await api.githubStart();
  assert.equal(result.flowId, 'flow-1');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://github.com/login/device');
  assert.equal(calls[0]?.url, SYNC_API.githubStart);
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('S-07 api.githubPoll()：POST /sync/github/poll 携带 flowId；pending 透传 pollDelayMs', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { status: 'pending', pollDelayMs: 5000 });
  });

  const api = new SyncApi();
  const result = await api.githubPoll('flow-1');
  assert.equal(result.status, 'pending');
  assert.equal(result.pollDelayMs, 5000);
  assert.equal(calls[0]?.url, SYNC_API.githubPoll);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['flowId'], 'flow-1');
});

test('S-08 api.githubPoll() 成功 → 响应只含状态，token 永不回传', async () => {
  installFetchMock(() => jsonResponse(200, { status: 'success', credentialConfigured: true }));
  const api = new SyncApi();
  const result = await api.githubPoll('flow-1');
  assert.equal(result.status, 'success');
  assert.equal(result.credentialConfigured, true);
  assert.equal('accessToken' in result, false, '响应契约不得携带 access token 字段');
  assert.equal('token' in result, false);
});

test('S-09 api.githubCancel()：POST /sync/github/cancel 携带 flowId', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true });
  });
  const api = new SyncApi();
  const result = await api.githubCancel('flow-1');
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, SYNC_API.githubCancel);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['flowId'], 'flow-1');
});
