/**
 * W4 客户端请求封装单测：**唯一实现** `src/client/common/http.ts`。
 *
 * 覆盖三件事（对应验收：7 份 readJson/5 份 postJson 收敛、**所有请求都有超时与取消**、
 * 错误映射统一）：
 *  1. `readJson` 的统一错误映射（{message} → {error} → 404「未挂载」→ HTTP 状态）；
 *  2. `getJson` / `postJson` 的超时（AbortController）与取消（调用方 signal）语义；
 *  3. `openStream` 的 headers 超时 / 正文空闲超时 / 暂停 / 关闭（流式下载与附件导出）。
 *
 * 全部用全局 fetch mock，无需真人宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigManagerApiError,
  getJson,
  openStream,
  postJson,
  readJson,
  REQUEST_TIMEOUT_MS,
  timeoutMessage,
} from './http.ts';
import { zhUiT } from '../../ui/i18n.ts';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 安装 fetch mock：记录每次调用的 url/init，并返回 mock 的调用记录。 */
function installFetch(handler: (call: FetchCall) => Promise<Response> | Response): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  test.after(() => { globalThis.fetch = original; });
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 永不返回的响应：只有 abort 事件能让它 reject（模拟宿主卡死）。 */
function hangingFetch(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    call.init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ------------------------------------------------------------ readJson 统一映射 */

test('http-01 readJson：2xx 原样解析 JSON', async () => {
  const body = await readJson<{ ok: boolean; n: number }>(jsonResponse(200, { ok: true, n: 7 }), zhUiT);
  assert.equal(body.ok, true);
  assert.equal(body.n, 7);
});

test('http-02 readJson：非 2xx 带 { error } → ConfigManagerApiError（沿用既有口径）', async () => {
  await assert.rejects(readJson(jsonResponse(400, { error: 'bad plan' }), zhUiT), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.equal((err as Error).message, 'bad plan');
    return true;
  });
});

test('http-03 readJson：{ message } 优先于 { error }（lifecycle 兼容口径成为唯一口径）', async () => {
  await assert.rejects(
    readJson(jsonResponse(503, { message: 'feature disabled', error: 'legacy' }), zhUiT),
    (err: unknown) => {
      assert.ok(err instanceof ConfigManagerApiError);
      assert.equal((err as Error).message, 'feature disabled', '{message} 是收敛后的统一口径（严格超集）');
      return true;
    },
  );
});

test('http-04 readJson：404 且响应体不是 JSON → 「插件未挂载」', async () => {
  await assert.rejects(readJson(new Response('Not Found', { status: 404 }), zhUiT), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match((err as Error).message, /未挂载/);
    return true;
  });
});

test('http-05 readJson：非 404 且响应体不是 JSON → error.httpInvalidJson', async () => {
  await assert.rejects(readJson(new Response('<html>boom</html>', { status: 500 }), zhUiT), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.equal((err as Error).message, zhUiT('error.httpInvalidJson', { status: '500' }));
    return true;
  });
});

/* ------------------------------------------------------- getJson / postJson 行为 */

test('http-06 getJson：不设 method（保持既有 GET 语义），带 signal，返回解析后的 body', async () => {
  const calls = installFetch(() => jsonResponse(200, { ready: true }));
  const body = await getJson<{ ready: boolean }>('/api/x', zhUiT);
  assert.equal(body.ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/x');
  assert.equal(calls[0]?.init?.method, undefined, 'GET 不显式设 method（既有断言依赖）');
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal, '请求必须挂 AbortSignal（超时/取消能力）');
});

test('http-07 postJson：POST + JSON content-type + JSON.stringify(body)', async () => {
  const calls = installFetch(() => jsonResponse(200, { ok: true }));
  await postJson('/api/y', { a: 1, b: 'x' }, zhUiT);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { a: 1, b: 'x' });
});

/* ------------------------------------------------------------------ 超时与取消 */

test('http-08 超时：宿主不返回 → 抛出统一超时错误，且 fetch 的 signal 被 abort', async () => {
  const calls = installFetch(hangingFetch);
  await assert.rejects(getJson('/api/hang', zhUiT, { timeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError, '超时必须映射为 ConfigManagerApiError');
    // 无 timeoutKey 时走**默认的语境中立通用超时键**（error.requestTimeout）——不套请求族文案，避免误导诊断（见 http.ts 头注释）
    assert.equal((err as Error).message, zhUiT('error.requestTimeout', { seconds: '1' }));
    return true;
  });
  assert.equal(calls[0]?.init?.signal?.aborted, true);
});

test('http-09 超时：可用 timeoutKey 沿用请求族专属文案（分钟插值走该键的模板）', async () => {
  installFetch(hangingFetch);
  // 用 50ms 触发（避免真等 5 分钟）：导出族模板按分钟插值，故这里应得到「1 分钟」。
  await assert.rejects(
    postJson('/api/export', {}, zhUiT, { timeoutMs: 50, timeoutKey: 'error.exportTimeout' }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigManagerApiError);
      assert.equal((err as Error).message, zhUiT('error.exportTimeout', { minutes: '1' }));
      return true;
    },
  );
});

test('http-10 取消：调用方 signal 中止 → 原样抛 AbortError（不伪装成超时）', async () => {
  installFetch(hangingFetch);
  const ac = new AbortController();
  const pending = getJson('/api/hang', zhUiT, { timeoutMs: 30_000, signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, (err: unknown) => {
    assert.equal(err instanceof ConfigManagerApiError, false, '调用方主动取消不是超时');
    assert.equal((err as { name?: string }).name, 'AbortError');
    return true;
  });
});

test('http-11 超时计时器在响应返回后被清除（不会事后 abort 已完成的请求）', async () => {
  const calls = installFetch(() => jsonResponse(200, { ok: true }));
  await getJson('/api/fast', zhUiT, { timeoutMs: 30 });
  await sleep(120);
  assert.equal(calls[0]?.init?.signal?.aborted, false, '完成后的请求不得被残留定时器 abort');
});

test('http-12 timeoutMessage：缺省走语境中立的通用超时键（{seconds} 插值）、请求族键按分钟插值', () => {
  assert.equal(timeoutMessage(zhUiT, REQUEST_TIMEOUT_MS), zhUiT('error.requestTimeout', { seconds: '30' }), '缺省 30s → 通用超时键');
  assert.equal(
    timeoutMessage(zhUiT, REQUEST_TIMEOUT_MS, 'error.fallback'),
    zhUiT('error.fallback'),
    'error.fallback 仍是合法键（显式指定时原样使用，覆盖不丢）',
  );
  assert.equal(timeoutMessage(zhUiT, 5 * 60 * 1000, 'error.syncTimeout'), zhUiT('error.syncTimeout', { minutes: '5' }));
  assert.equal(timeoutMessage(zhUiT, 5 * 60 * 1000, 'error.exportTimeout'), zhUiT('error.exportTimeout', { minutes: '5' }));
  assert.equal(timeoutMessage(zhUiT, 5 * 60 * 1000, 'error.recoveryTimeout'), zhUiT('error.recoveryTimeout', { minutes: '5' }));
  assert.equal(timeoutMessage(zhUiT, 5 * 60 * 1000, 'error.lifecycleTimeout'), zhUiT('error.lifecycleTimeout', { minutes: '5' }));
});

/* ---------------------------------------------------------------- openStream 流式 */

test('http-13 openStream：headers 阶段超时 → 统一超时错误', async () => {
  installFetch(hangingFetch);
  await assert.rejects(openStream('/api/download', zhUiT, { timeoutMs: 50 }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.equal((err as Error).message, zhUiT('error.requestTimeout', { seconds: '1' }));
    return true;
  });
});

test('http-14 openStream：pause() 期间不计时；resume() 后按空闲超时触发（timedOut 可供调用方映射）', async () => {
  installFetch(() => jsonResponse(200, { ok: true }));
  const stream = await openStream('/api/download', zhUiT, { timeoutMs: 30_000, idleTimeoutMs: 40 });
  try {
    stream.pause();
    await sleep(120);
    assert.equal(stream.timedOut, false, '暂停期间（用户选保存位置）不得超时');
    stream.resume();
    await sleep(120);
    assert.equal(stream.timedOut, true, '恢复后空闲超时必须生效');
    const mapped = stream.mapTimeout(new Error('boom'));
    assert.ok(mapped instanceof ConfigManagerApiError);
  } finally {
    stream.close();
  }
});

test('http-15 openStream：close() 清除计时器（关闭后不会再触发超时）', async () => {
  installFetch(() => jsonResponse(200, { ok: true }));
  const stream = await openStream('/api/download', zhUiT, { timeoutMs: 30_000, idleTimeoutMs: 30 });
  stream.close();
  await sleep(100);
  assert.equal(stream.timedOut, false);
});

test('http-16 openStream：未超时时 mapTimeout 原样返回错误（不能把真错误吃成超时）', async () => {
  installFetch(() => jsonResponse(200, { ok: true }));
  const stream = await openStream('/api/download', zhUiT, { timeoutMs: 30_000, idleTimeoutMs: 30_000 });
  try {
    const original = new Error('network down');
    assert.equal(stream.mapTimeout(original), original);
  } finally {
    stream.close();
  }
});
