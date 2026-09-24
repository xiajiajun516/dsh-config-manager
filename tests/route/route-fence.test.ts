/**
 * W1（host-entry#F-02 / F-05）：路由 kit 的**结构不变量 + 行为**守卫。
 *
 * 为什么需要它：改造前「每条路由首行 guard（loopback + 同源 + 方法）」只写在注释里，
 * 全仓零测试覆盖（新增一条忘写围栏的路由，CI 全绿）；5 条路由连 try/catch 都没有，
 * 抛错会被 webserver 兜底成**空体 400**（客户端误报「响应不是合法 JSON」并丢掉真实原因）。
 *
 * 现在：endpoint() 是唯一入口（围栏 + 方法白名单 + 顶层 try/catch），注册点 registerRoutes()
 * 兜底断言每条路由都出自 kit。本文件同时钉住结构与行为两侧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { endpoint, registerRoutes, requireJsonObject, RouteError, routeSpecOf, type WebRoute } from '../../src/routes/kit.ts';

const root = path.resolve(import.meta.dirname, '../..');

/** 宿主路由源：src/index.ts（保留的 8 条）+ src/routes/*.ts（拆出去的 59 条）。 */
function routeSources(): Array<{ file: string; text: string }> {
  const out = [{ file: 'src/index.ts', text: fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8') }];
  const dir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push({ file: 'src/routes/' + entry, text: fs.readFileSync(path.join(dir, entry), 'utf8') });
  }
  return out;
}

/**
 * 构造路由表用的桩 env：组文件在构建期只做「解构 + endpoint(...) 声明 + withMutationGate 包裹」，
 * 其余依赖只在 handler 执行时才被读到 → 用代理即可驱动 buildRoutes（无需拖入真宿主依赖树）。
 */
function stubEnv(): never {
  return new Proxy({}, {
    get: (_target, prop) => (prop === 'withMutationGate' ? (_op: string, handler: unknown) => handler : {}),
    has: () => true,
  }) as never;
}

interface FakeRequestOptions {
  address?: string;
  host?: string;
  method?: string;
  origin?: string;
  secFetchSite?: string;
  body?: string;
  url?: string;
}

function fakeRequest(opts: FakeRequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? '127.0.0.1:3080' };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite;
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    socket: { remoteAddress: opts.address ?? '127.0.0.1' },
    headers,
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

interface FakeResponse {
  res: ServerResponse;
  status: number;
  contentType: string | undefined;
  body: string;
  ended: boolean;
}

function fakeResponse(): FakeResponse {
  const state = { status: 0, contentType: undefined as string | undefined, body: '', ended: false };
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.status = status;
      const ct = headers?.['content-type'];
      state.contentType = typeof ct === 'string' ? ct : undefined;
      this.headersSent = true;
      return this;
    },
    end(payload?: string) {
      state.body = payload ?? '';
      state.ended = true;
      return this;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() { return state.status },
    get contentType() { return state.contentType },
    get body() { return state.body },
    get ended() { return state.ended },
  };
}

test('kit 围栏：非 loopback / 跨站来源一律 403，且 handler 绝不执行', async () => {
  let called = 0;
  const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ });
  for (const opts of [{ address: '10.0.0.5' }, { host: 'evil.example' }, { secFetchSite: 'cross-site' }, { origin: 'http://evil.example' }]) {
    const res = fakeResponse();
    await route.handler(fakeRequest(opts), res.res);
    assert.equal(res.status, 403, 'fence 必须先于 handler：' + JSON.stringify(opts));
    assert.match(res.body, /forbidden: loopback-only/);
  }
  assert.equal(called, 0, '被围栏拒绝的请求不得进入 handler');
});

test('kit 方法白名单：不在白名单 → 405（与旧 guard 文案一致）', async () => {
  const route = endpoint({ path: '/x', methods: ['POST'] }, async () => { throw new Error('不应执行') });
  const res = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), res.res);
  assert.equal(res.status, 405);
  assert.match(res.body, /method not allowed: GET/);
});

test('kit 顶层 try/catch：裸异常 → 500 JSON（不再落到 webserver 的空体 400）', async () => {
  const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { throw new Error('boom') });
  const res = fakeResponse();
  await route.handler(fakeRequest(), res.res);
  assert.equal(res.ended, true, '必须发出响应（旧行为：无 catch → 空体 400，客户端只能看到「不是合法 JSON」）');
  assert.equal(res.status, 500);
  assert.equal(res.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), { error: 'boom' });
});

test('kit 错误映射：RouteError 的 status/code 保真，其余 500', async () => {
  const bad = endpoint({ path: '/x', methods: ['POST'] }, async () => { throw new RouteError('bad zipPath', 400, 'bad-zip-path') });
  const res1 = fakeResponse();
  await bad.handler(fakeRequest({ method: 'POST' }), res1.res);
  assert.equal(res1.status, 400);
  assert.deepEqual(JSON.parse(res1.body), { error: 'bad zipPath', code: 'bad-zip-path' });

  const sync = endpoint({ path: '/y', methods: ['POST'] }, async () => { throw new RouteError('url is required for webdav', 400) });
  const res2 = fakeResponse();
  await sync.handler(fakeRequest({ method: 'POST' }), res2.res);
  assert.equal(res2.status, 400);
  assert.deepEqual(JSON.parse(res2.body), { error: 'url is required for webdav' });
});

test('kit body 解析：非法 JSON → 400 且 error 文案为 invalid JSON body；合法 → 交给 handler', async () => {
  const route = endpoint({ path: '/x', methods: ['POST'] }, async (req, res) => {
    const body = await requireJsonObject(req);
    res.writeHead(200);
    res.end(JSON.stringify(body));
  });
  const bad = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: '{oops' }), bad.res);
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(bad.body), { error: 'invalid JSON body' });

  const ok = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: '{"a":1}' }), ok.res);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { a: 1 });
});

test('注册点兜底：未经 endpoint() 的裸路由直接抛错（fail-fast，不静默少一道围栏）', () => {
  const bare: WebRoute = { kind: 'exact', path: '/bare', handler: () => {} };
  assert.equal(routeSpecOf(bare), undefined, '裸路由不得被认作出自 kit');
  const registered: string[] = [];
  assert.throws(
    () => registerRoutes({ register: (r) => { registered.push(r.path); return () => {} } }, [bare]),
    /未经 route kit 声明/,
  );
  const ok = registerRoutes({ register: (r) => { registered.push(r.path); return () => {} } }, [endpoint({ path: '/ok', methods: ['GET'] }, () => {})]);
  assert.equal(ok.length, 1);
  assert.deepEqual(registered, ['/ok'], 'kit 路由必须照常注册');
});


test('buildRoutes：59 条拆出的路由全部产出、全部经 kit、路径不重复（运行期）', async () => {
  const { buildRoutes } = await import('../../src/routes/index.ts');
  // 只构造路由表：组文件在构建期只解构 env，并调用 withMutationGate 包裹 handler（其余依赖都在 handler 内）
  // → 用一个「withMutationGate 恒等包裹、其余成员为空对象」的代理即可，不需要真宿主依赖树。
  const routes = buildRoutes(stubEnv());
  assert.equal(routes.length, 59, '拆出的路由数应为 59（其余 8 条留在 index.ts，见 parity 快照）');
  for (const route of routes) {
    assert.notEqual(routeSpecOf(route), undefined, '未经 kit 的路由: ' + route.path);
  }
  const paths = new Set(routes.map((r) => r.path));
  assert.equal(paths.size, 59, '路径不得重复（webServer.register 对重复 (kind,path) 直接抛错）');
});

test('W1 修复证据：原先无 try/catch 的路由，异常现在被 kit 兜成 500 JSON（旧行为=webserver 空体 400）', async () => {
  const { buildRoutes } = await import('../../src/routes/index.ts');
  const routes = buildRoutes(stubEnv());
  // 审计点名的 5 条里，status 留在 index.ts（由上面的结构不变量覆盖），其余 4 条在此逐条验证行为
  const targets: Array<{ path: string; method: string; url?: string; body?: string }> = [
    { path: '/api/dsh-config-manager/progress', method: 'GET', url: '/?runId=r1' },
    { path: '/api/dsh-config-manager/runs', method: 'GET' },
    { path: '/api/dsh-config-manager/execute/skip', method: 'POST', body: '{"runId":"r1","itemId":"i1"}' },
    { path: '/api/dsh-config-manager/sync/github/cancel', method: 'POST', body: '{"flowId":"f1"}' },
  ];
  for (const { path: routePath, method, url, body } of targets) {
    const route = routes.find((r) => r.path === routePath);
    assert.ok(route !== undefined, '缺少路由: ' + routePath);
    const res = fakeResponse();
    // 空代理 env → handler 内部必然抛（例如 runs.listActive 不是函数）→ 正是改造前「空体 400」的场景
    await route.handler(fakeRequest({ method, host: '127.0.0.1:3080', ...(url !== undefined ? { url } : {}), ...(body !== undefined ? { body } : {}) }), res.res);
    assert.equal(res.ended, true, routePath + ' 必须发出响应（旧行为：无 catch → 空体 400）');
    assert.equal(res.status, 500, routePath + ' 应当由 kit 映射成 500');
    assert.equal(res.contentType, 'application/json; charset=utf-8');
    assert.equal(typeof (JSON.parse(res.body) as { error?: unknown }).error, 'string', routePath + ' 响应体应为 {error}');
  }
});

test('结构不变量：67 条路由全部经 endpoint() 声明，且围栏只有 kit 一份实现', () => {
  const sources = routeSources();
  let declarations = 0;
  let bareHandlers = 0;
  for (const { text } of sources) {
    // 只数**真实声明**：spec 必须含带值的 path 与 methods（文档注释里的示例文本不算）
    for (const m of text.matchAll(/endpoint\(\{([^{}]*)\}\s*,/g)) {
      const spec = m[1] as string;
      if (!/path:\s*(?:'[^']*'|API\.\w+)/.test(spec) || !/methods:\s*\[/.test(spec)) continue;
      declarations++;
    }
    // 旧的逐路由样板形态（handler: async (req, res) => { + 首行 guard）不得再出现
    bareHandlers += (text.match(/handler:\s*async \(req, res\)/g) ?? []).length;
  }
  assert.equal(declarations, 67, `路由声明应为 67 条（实际 ${declarations}）——少一条即静默少一道围栏`);
  assert.equal(bareHandlers, 0, '不得残留裸 handler 形态（必须经 endpoint() 包装）');
  const fenceOwners = sources.filter(({ text }) => /isLoopbackRequest\(/.test(text)).map((s) => s.file);
  assert.deepEqual(fenceOwners, ['src/routes/kit.ts'], 'loopback 围栏只允许在 kit 里实现一次，实际：' + fenceOwners.join(', '));
});
