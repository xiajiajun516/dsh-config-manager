/**
 * M4 客户端 API 方法测试（criterion m4-gui-works；正式 TDD 证据归 t5 tester）。
 * 用全局 fetch mock 验证 ConfigManagerApi.snapshots() / restoreSnapshot() 的
 * 请求路径/方法/请求体与响应解析（含 4xx 错误映射）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApi, CONFIG_MANAGER_API, ConfigManagerApiError } from '../../src/client/api.ts';
import type { SnapshotMeta } from '../../src/core/restore.ts';

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

test('C-01 api.snapshots()：GET 到 /snapshots，解析 { snapshots }', async () => {
  const metas: SnapshotMeta[] = [{
    id: 'snap-1', createdAt: '2026-08-14T12:00:00.000Z', sourceZip: 'a.zip',
    status: 'done', entryCount: 2, hostFileBackupCount: 1, beforePluginCount: 1,
  }];
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, { snapshots: metas });
  });

  const api = new ConfigManagerApi();
  const result = await api.snapshots();
  assert.deepEqual(result, metas);
  assert.equal(called?.url, CONFIG_MANAGER_API.snapshots);
  assert.equal(called?.init?.method, undefined, 'GET 不设 method');
});

test('C-02 api.restoreSnapshot()：POST /restore，dryRun=true/false 请求体正确', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { dryRun: true, plan: { snapshotId: 'snap-1', actions: [] } });
  });

  const api = new ConfigManagerApi();
  const result = await api.restoreSnapshot('snap-1', true);
  assert.equal(result.dryRun, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CONFIG_MANAGER_API.restore);
  assert.equal(calls[0]?.init?.method, 'POST');
  const body = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as { snapshotId: string; dryRun: boolean };
  assert.deepEqual(body, { snapshotId: 'snap-1', dryRun: true });
});

test('C-03 api.restoreSnapshot()：dryRun=false 透传并解析 report', async () => {
  installFetchMock(() => jsonResponse(200, {
    dryRun: false,
    report: { snapshotId: 'snap-1', restored: ['settings.yaml'], removedPlugins: [], manualHints: [], failed: [], skipped: [] },
  }));
  const api = new ConfigManagerApi();
  const result = await api.restoreSnapshot('snap-1', false);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.report?.restored, ['settings.yaml']);
});

test('C-04 错误映射：4xx 携带 error 消息 → ConfigManagerApiError', async () => {
  installFetchMock(() => jsonResponse(400, { error: 'snapshotId is required' }));
  const api = new ConfigManagerApi();
  await assert.rejects(api.restoreSnapshot('', false), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /snapshotId is required/);
    return true;
  });
});
