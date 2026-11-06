/**
 * issue #126：非回环请求的**宿主信任面委托**（src/routes/request-trust.ts + kit 围栏接线）。
 *
 * 为什么要这层测试：改造前围栏只有一条硬判据（remoteAddress / Host / Origin 全须回环），
 * 宿主以 --host 局域网地址起 dsh web 时，内嵌面板的 84 条路由全被 403 —— 而宿主的 /api
 * 对同一台浏览器是放行的（trustedHosts + dsh-auth cookie）。修复把「回环之外」的判断交给
 * 宿主 HostConnectionService.requestRejection，本文件钉住三条不变量：
 * ① 回环永远先放行（本机 curl / 脚本不被 cookie 需求打回 401）；
 * ② 委托缺失或抛错一律退回严格回环（失败方向更严，不是更松）；
 * ③ 401（地址认了但没登录）与 403（地址不认）必须给不同机器码 —— 两者下一步不同。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { endpoint, setRequestTrustResolver } from '../../src/routes/kit.ts';
import { createHostRequestTrust, installHostRequestTrust, type HostConnectionLike } from '../../src/routes/request-trust.ts';

interface FakeRequestOptions {
  address?: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

/** 与 route-fence.test.ts 同口径的请求桩（真 IncomingMessage 只用到 socket/headers）。 */
function fakeRequest(opts: FakeRequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? '10.0.0.10:3080' };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite;
  const req = {
    method: 'GET',
    url: '/',
    socket: { remoteAddress: opts.address ?? '10.0.0.5' },
    headers,
  };
  return req as unknown as IncomingMessage;
}

interface FakeResponse {
  res: ServerResponse;
  status: number;
  body: string;
}

function fakeResponse(): FakeResponse {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() { return state.status },
    get body() { return state.body },
  };
}

/** 局域网请求：remoteAddress 与 Host 都不是回环 —— 与 issue 复现条件一致。 */
function lanRequest(): IncomingMessage {
  return fakeRequest({ address: '10.0.0.5', host: '10.0.0.10:3080' });
}

test('委托缺失或形状不符 → 严格回环（403 loopback-only），绝不因拿不到服务而放行', () => {
  const resolver = createHostRequestTrust(() => null);
  assert.deepEqual(resolver(lanRequest()), {
    status: 403,
    message: 'forbidden: loopback-only',
    code: 'loopback-only',
  });
  const noMethod = createHostRequestTrust(() => ({}) as HostConnectionLike);
  assert.equal(noMethod(lanRequest())?.status, 403);
  assert.equal(noMethod(lanRequest())?.code, 'loopback-only');
});

test('宿主判定放行（undefined）→ 委托返回 undefined，由 endpoint 继续处理', () => {
  const resolver = createHostRequestTrust(() => ({ requestRejection: () => undefined }));
  assert.equal(resolver(lanRequest()), undefined);
});

test('宿主判定 401（地址认了但无会话）与 403（地址不认）给不同机器码', () => {
  const unauthorized = createHostRequestTrust(() => ({ requestRejection: () => 401 }));
  assert.deepEqual(unauthorized(lanRequest()), {
    status: 401,
    message: 'unauthorized: browser-session',
    code: 'browser-session',
  });
  const forbidden = createHostRequestTrust(() => ({ requestRejection: () => 403 }));
  assert.deepEqual(forbidden(lanRequest()), {
    status: 403,
    message: 'forbidden: untrusted-authority',
    code: 'untrusted-authority',
  });
});

test('宿主判定抛错 → 记一行 warn 并退回严格回环（不让异常变成 500）', () => {
  const warnings: string[] = [];
  const resolver = createHostRequestTrust(
    () => ({ requestRejection: () => { throw new Error('browserAuth unavailable') } }),
    { warn: (message) => { warnings.push(message) } },
  );
  assert.equal(resolver(lanRequest())?.code, 'loopback-only');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /requestRejection threw/);
  assert.match(warnings[0], /browserAuth unavailable/);
});

test('成员调用保留 this：宿主方法依赖自身状态（browserAuth / trustedHosts）', () => {
  const service = {
    trusted: true,
    requestRejection(this: { trusted: boolean }) { return this.trusted ? undefined : 403 },
  };
  assert.equal(createHostRequestTrust(() => service)(lanRequest()), undefined);
  service.trusted = false;
  assert.equal(createHostRequestTrust(() => service)(lanRequest())?.code, 'untrusted-authority');
});

test('kit 围栏：委托放行 → 局域网请求进入 handler（issue #126 的修复面）', async () => {
  let called = 0;
  setRequestTrustResolver(createHostRequestTrust(() => ({ requestRejection: () => undefined })));
  try {
    const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ });
    const res = fakeResponse();
    await route.handler(lanRequest(), res.res);
    assert.equal(called, 1, '宿主信任的局域网请求必须能进 handler');
    assert.notEqual(res.status, 403);
  } finally {
    setRequestTrustResolver(undefined);
  }
});

test('kit 围栏：委托拒绝 → 状态码/机器码透传到响应体，handler 不执行', async () => {
  setRequestTrustResolver(createHostRequestTrust(() => ({ requestRejection: () => 401 })));
  try {
    let called = 0;
    const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ });
    const res = fakeResponse();
    await route.handler(lanRequest(), res.res);
    assert.equal(res.status, 401);
    assert.match(res.body, /browser-session/);
    assert.equal(called, 0);
  } finally {
    setRequestTrustResolver(undefined);
  }
});

test('kit 围栏：回环永远先放行 —— 即使宿主判定会拒（本机 curl / 脚本行为不变）', async () => {
  setRequestTrustResolver(createHostRequestTrust(() => ({ requestRejection: () => 401 })));
  try {
    let called = 0;
    const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ });
    const res = fakeResponse();
    await route.handler(fakeRequest({ address: '127.0.0.1', host: '127.0.0.1:3080' }), res.res);
    assert.equal(called, 1);
    assert.notEqual(res.status, 401);
  } finally {
    setRequestTrustResolver(undefined);
  }
});

test('kit 围栏：无委托时局域网请求仍是 403 loopback-only（老宿主 / 独立 CLI 行为不变）', async () => {
  let called = 0;
  const route = endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ });
  const res = fakeResponse();
  await route.handler(lanRequest(), res.res);
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden: loopback-only/);
  assert.match(res.body, /"code":"loopback-only"/);
  assert.equal(called, 0);
});

test('读服务抛错 → 记 warn 并退回严格回环（围栏抛错会绕过 endpoint 的 try/catch 变成空体 400）', () => {
  const warnings: string[] = [];
  const resolver = createHostRequestTrust(
    () => { throw new Error('context disposed') },
    { warn: (message) => { warnings.push(message) } },
  );
  assert.equal(resolver(lanRequest())?.code, 'loopback-only');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reading the connection service threw/);
  assert.match(warnings[0], /context disposed/);
});

test('安装器：ctx.effect 装上委托，清理函数把围栏卸回严格回环', async () => {
  let dispose: (() => void) | undefined;
  const ctx = {
    effect(callback: () => () => void) {
      dispose = callback();
      return {};
    },
    get(name: string) {
      assert.equal(name, 'connection', '安装器只读 connection 服务');
      return { requestRejection: () => undefined };
    },
  };
  installHostRequestTrust(ctx);
  try {
    let called = 0;
    const res = fakeResponse();
    await endpoint({ path: '/x', methods: ['GET'] }, async () => { called++ }).handler(lanRequest(), res.res);
    assert.equal(called, 1, '安装后局域网请求应被宿主信任面放行');
  } finally {
    dispose?.();
  }
  const after = fakeResponse();
  await endpoint({ path: '/y', methods: ['GET'] }, async () => {}).handler(lanRequest(), after.res);
  assert.equal(after.status, 403);
  assert.match(after.body, /"code":"loopback-only"/);
});

test('安装器：旧实例清理不抹掉新实例的委托（插件重载 / bundle + 隔离 profile 共存）', async () => {
  const disposers: (() => void)[] = [];
  const fakeCtx = (verdict: number | undefined) => ({
    effect(callback: () => () => void) {
      disposers.push(callback());
      return {};
    },
    get() { return { requestRejection: () => verdict } },
  });
  installHostRequestTrust(fakeCtx(undefined)); // 旧实例：放行
  installHostRequestTrust(fakeCtx(403)); // 新实例：拒绝
  disposers[0]!(); // 旧实例卸载
  const res = fakeResponse();
  await endpoint({ path: '/z', methods: ['GET'] }, async () => {}).handler(lanRequest(), res.res);
  assert.equal(res.status, 403);
  assert.match(res.body, /untrusted-authority/, '应仍是新实例的判定，而不是被旧实例清理抹回 loopback-only');
  disposers[1]!();
});
