/**
 * m-market-ui：MarketApi（/api/dsh-config-manager/market/*）请求契约测试。
 * 用全局 fetch mock 验证 status/add/remove/refresh/browse/download 的路径/方法/请求体
 * 与响应解析（含错误映射 + 无 secret 不变式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApiError } from '../api.ts';
import { MARKET_API, MarketApi } from './market-api.ts';

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

test('M-01 api.status()：GET 到 /market/status，解析已添加市场列表（无凭据字段）', async () => {
  const body = {
    ok: true,
    configured: true,
    markets: [{ url: 'https://github.com/u/m', addedAt: '2026-08-16T00:00:00.000Z', itemCount: 3 }],
    // 启动后首次打开市场页自动更新的判据（Host 进程内存标记；dsh 重启后重置）
    bootAutoRefreshed: false,
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  // 经读取函数解除闭包赋值导致的 CFA 窄化
  const lastCall = (): FetchCall | null => called;

  const api = new MarketApi();
  const result = await api.status();
  assert.equal(result.configured, true);
  assert.equal(result.markets.length, 1);
  assert.equal(result.markets[0]?.url, 'https://github.com/u/m');
  assert.equal(result.bootAutoRefreshed, false, 'status 契约透传 bootAutoRefreshed（首次打开自动更新判据）');
  assert.equal('token' in result, false, 'status 契约不得携带 token');
  assert.equal(lastCall()?.url, MARKET_API.status);
  assert.equal(lastCall()?.init?.method, undefined, 'GET 不设 method');
});

test('M-02 内置单市场：无 add/remove API（市场绑定内置仓库，不可编辑；见 builtin.ts）', () => {
  const api = new MarketApi();
  assert.equal(typeof (api as { add?: unknown }).add, 'undefined', 'MarketApi 不应再有 add 方法');
  assert.equal(typeof (api as { remove?: unknown }).remove, 'undefined', 'MarketApi 不应再有 remove 方法');
  assert.equal('add' in MARKET_API, false, '端点常量不含 /market/add');
  assert.equal('remove' in MARKET_API, false, '端点常量不含 /market/remove');
});

test('M-04 api.refresh()：POST /market/refresh，解析 L1 目录条目 + 市场缓存摘要', async () => {
  const body = {
    ok: true,
    market: { url: 'https://github.com/u/m', addedAt: '2026-08-16T00:00:00.000Z', itemCount: 2 },
    items: [
      { id: 'a', name: '插件包', author: 'alice', categories: ['插件'] },
      { id: 'b', name: '代理' },
    ],
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new MarketApi();
  const result = await api.refresh();
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.name, '插件包');
  assert.equal(result.market.itemCount, 2);
  assert.equal('cacheState' in result.items[0]!, false, 'refresh 返回 L1 目录条目，无 cacheState');
  assert.equal(calls[0]?.url, MARKET_API.refresh);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent), [], '内置单市场：refresh 请求体为空，不携带 url/token');
});

test('M-05 api.browse()：POST /market/browse（不重拉，合并 index + 缓存）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, {
      ok: true,
      market: { url: 'https://github.com/u/m', addedAt: '2026-08-16T00:00:00.000Z' },
      items: [{ id: 'a', name: 'x', cacheState: 'none' }],
    });
  });
  const api = new MarketApi();
  const result = await api.browse();
  assert.equal(result.items.length, 1);
  assert.equal(calls[0]?.url, MARKET_API.browse);
});

test('M-06 api.download()：POST /market/download 携带 itemId；内置单市场不传 url；响应含校验详情/zipPath/plan/警示（供应链恒展示）', async () => {
  const body = {
    ok: true,
    id: 'a',
    name: '插件包',
    version: '1.0',
    sections: ['settings', 'plugins'],
    downloadedAt: '2026-08-16T10:30:00.000Z',
    status: 'valid',
    warnings: ['非官方审核'],
    zipPath: '/tmp/controlled/a.zip',
    analysis: { compatible: true },
    plan: { items: [] },
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new MarketApi();
  const result = await api.download('a');
  assert.equal(result.status, 'valid');
  assert.equal(result.zipPath, '/tmp/controlled/a.zip');
  assert.deepEqual(result.sections, ['settings', 'plugins']);
  assert.ok(result.warnings.length > 0, '供应链警示恒存在（不允许默认信任）');
  assert.equal(calls[0]?.url, MARKET_API.download);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent), ['itemId'], '内置单市场：download 请求体只有 itemId（无 url / token）');
  assert.equal(sent['itemId'], 'a');
});

test('M-06b api.download()：自托管条目（repo 来源）→ 请求体携带 repo（装回本地 / 浏览第三方条目场景）', async () => {
  const body = {
    ok: true,
    id: 'a',
    name: '自托管条目',
    version: '1.0',
    sections: ['settings'],
    downloadedAt: '2026-08-16T10:30:00.000Z',
    status: 'valid',
    warnings: ['第三方来源'],
    zipPath: '/tmp/controlled/a.zip',
    analysis: { compatible: true },
    plan: { items: [] },
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new MarketApi();
  const result = await api.download('a', 'https://github.com/xiaojun/dsh-configs');
  assert.equal(result.status, 'valid');
  assert.equal(calls[0]?.url, MARKET_API.download);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent), ['itemId', 'repo'], '自托管条目必须携带 repo 来源（否则从官方仓库拉取会缺文件）');
  assert.equal(sent['itemId'], 'a');
  assert.equal(sent['repo'], 'https://github.com/xiaojun/dsh-configs');
});

test('M-07 错误映射：4xx 携带 error → ConfigManagerApiError', async () => {
  installFetchMock(() => jsonResponse(400, { error: 'market index invalid: unknown field' }));
  const api = new MarketApi();
  await assert.rejects(api.browse(), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /market index invalid/);
    return true;
  });
});

test('M-08 服务未挂载：404（非 JSON 体）→ ConfigManagerApiError 提示插件未加载', async () => {
  installFetchMock(() => new Response('Not Found', { status: 404 }));
  const api = new MarketApi();
  await assert.rejects(api.status(), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /未挂载/);
    return true;
  });
});
