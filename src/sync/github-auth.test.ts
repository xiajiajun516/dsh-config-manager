/**
 * m-github-oauth：GitHub OAuth device flow 认证模块测试（TDD：先红后绿）。
 *
 * 覆盖：
 * - startDeviceFlow：请求构造（URL/method/表单/scope）与响应解析；GitHub 错误 → GitHubAuthError
 * - exchangeDeviceCode：单次 token 交换（成功 / 错误码 / 非 JSON / 网络失败）
 * - pollForToken：pending/slow_down/denied/expired/未知错误 → 类型化轮询结果
 * - DeviceFlowStore：内存登记/过期清理/删除（device_code 只存宿主侧，不回浏览器）
 *
 * 全部通过注入 fetcher mock，不碰真实网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL, GITHUB_DEVICE_FLOW_SCOPE,
  DeviceFlowStore, GitHubAuthClient, GitHubAuthError,
} from './github-auth.ts';
import type { DeviceFlowEntry } from './github-auth.ts';

/* ---------------------------------------------------------------- mock 基础设施 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetcher(handler: (call: FetchCall) => Response): GitHubAuthClient {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return handler({ url: String(input), init });
  }) as typeof fetch;
  return new GitHubAuthClient({ fetcher });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(call: FetchCall): string {
  return typeof call.init?.body === 'string' ? call.init.body : '';
}

/** 标准 device/code 成功响应体 */
function deviceCodeBody(): Record<string, unknown> {
  return {
    device_code: 'device-abc-123',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  };
}

/* ---------------------------------------------------------------- startDeviceFlow */

test('github-auth: startDeviceFlow 成功 → 请求构造正确（URL/POST/表单/scope）并解析响应', async () => {
  const calls: FetchCall[] = [];
  const client = installFetcher((call) => {
    calls.push(call);
    return jsonResponse(200, deviceCodeBody());
  });

  const result = await client.startDeviceFlow('client-123');
  assert.equal(result.deviceCode, 'device-abc-123');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://github.com/login/device');
  assert.equal(result.expiresIn, 900);
  assert.equal(result.interval, 5);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, GITHUB_DEVICE_CODE_URL);
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('accept'), 'application/json');
  const body = bodyOf(calls[0]!);
  assert.ok(body.includes('client_id=client-123'), '表单必须携带 client_id');
  assert.ok(body.includes(`scope=${GITHUB_DEVICE_FLOW_SCOPE}`), `缺省 scope 必须为 ${GITHUB_DEVICE_FLOW_SCOPE}`);
});

test('github-auth: startDeviceFlow 自定义 scope 覆盖缺省', async () => {
  const calls: FetchCall[] = [];
  const client = installFetcher((call) => {
    calls.push(call);
    return jsonResponse(200, deviceCodeBody());
  });

  await client.startDeviceFlow('client-123', 'repo gist');
  assert.ok(bodyOf(calls[0]!).includes('scope=repo%20gist') || bodyOf(calls[0]!).includes('scope=repo+gist'),
    '表单必须携带自定义 scope（URL 编码空格）');
});

test('github-auth: startDeviceFlow GitHub 错误 JSON → GitHubAuthError（含 code 与描述，不含任何秘密）', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'incorrect_client_credentials', error_description: 'The client_id is invalid' }));
  await assert.rejects(client.startDeviceFlow('bad-client'), (err: unknown) => {
    assert.ok(err instanceof GitHubAuthError, '必须是 GitHubAuthError');
    assert.equal(err.code, 'incorrect_client_credentials');
    assert.match(err.message, /client_id/);
    assert.ok(!err.message.includes('bad-client'), '错误消息不泄露 client_id');
    return true;
  });
});

test('github-auth: startDeviceFlow 非 2xx HTTP → GitHubAuthError', async () => {
  const client = installFetcher(() => jsonResponse(500, { error: 'boom' }));
  await assert.rejects(client.startDeviceFlow('client-123'), (err: unknown) => {
    assert.ok(err instanceof GitHubAuthError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('github-auth: startDeviceFlow 非 JSON 响应 → GitHubAuthError', async () => {
  const client = installFetcher(() => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(client.startDeviceFlow('client-123'), (err: unknown) => {
    assert.ok(err instanceof GitHubAuthError);
    return true;
  });
});

test('github-auth: startDeviceFlow 网络失败 → GitHubAuthError（原始错误消息保留）', async () => {
  const client = installFetcher(() => {
    throw new Error('ECONNREFUSED github.com');
  });
  await assert.rejects(client.startDeviceFlow('client-123'), (err: unknown) => {
    assert.ok(err instanceof GitHubAuthError);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

/* ---------------------------------------------------------------- exchangeDeviceCode */

test('github-auth: exchangeDeviceCode 成功 → 返回 access token，请求构造正确（含 grant_type）', async () => {
  const calls: FetchCall[] = [];
  const client = installFetcher((call) => {
    calls.push(call);
    return jsonResponse(200, { access_token: 'gho_secret_123', token_type: 'bearer', scope: 'repo' });
  });

  const result = await client.exchangeDeviceCode({
    clientId: 'client-123', deviceCode: 'device-abc-123',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, 'gho_secret_123');

  assert.equal(calls[0]?.url, GITHUB_ACCESS_TOKEN_URL);
  assert.equal(calls[0]?.init?.method, 'POST');
  const body = bodyOf(calls[0]!);
  assert.ok(body.includes('client_id=client-123'));
  assert.ok(body.includes('device_code=device-abc-123'));
  assert.ok(body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'));
  assert.ok(!body.includes('client_secret'), '未提供 client_secret 时表单不得携带该字段');
});

test('github-auth: exchangeDeviceCode 携带 client_secret（confidential app）', async () => {
  const calls: FetchCall[] = [];
  const client = installFetcher((call) => {
    calls.push(call);
    return jsonResponse(200, { access_token: 'gho_secret_123' });
  });

  const result = await client.exchangeDeviceCode({
    clientId: 'client-123', deviceCode: 'device-abc-123', clientSecret: 'super-secret',
  });
  assert.equal(result.ok, true);
  assert.ok(bodyOf(calls[0]!).includes('client_secret=super-secret'), '提供 client_secret 时必须随表单发送');
});

test('github-auth: exchangeDeviceCode GitHub 错误码（authorization_pending）→ ok:false 原样返回', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'authorization_pending', error_description: 'user has not yet approved' }));
  const result = await client.exchangeDeviceCode({ clientId: 'c', deviceCode: 'd' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, 'authorization_pending');
    assert.match(result.errorDescription ?? '', /approved/);
  }
});

test('github-auth: exchangeDeviceCode 非 JSON → GitHubAuthError（token 不进错误消息）', async () => {
  const client = installFetcher(() => new Response('gateway timeout', { status: 502 }));
  await assert.rejects(client.exchangeDeviceCode({ clientId: 'c', deviceCode: 'd' }), (err: unknown) => {
    assert.ok(err instanceof GitHubAuthError);
    assert.ok(!err.message.includes('gho_'), '错误消息不得含 token 形态内容');
    return true;
  });
});

/* ---------------------------------------------------------------- pollForToken */

test('github-auth: pollForToken 成功 → status success + access token', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { access_token: 'gho_ok_token', token_type: 'bearer', scope: 'repo' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd' });
  assert.equal(result.status, 'success');
  assert.equal(result.accessToken, 'gho_ok_token');
});

test('github-auth: pollForToken authorization_pending → pending + 按 interval 计算下次轮询延迟', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'authorization_pending', error_description: 'not yet' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd', interval: 5 });
  assert.equal(result.status, 'pending');
  assert.equal(result.pollDelayMs, 5000);
});

test('github-auth: pollForToken slow_down → pending + 延迟在 interval 基础上加 5 秒（RFC 8628）', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'slow_down', error_description: 'too frequent' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd', interval: 5 });
  assert.equal(result.status, 'pending');
  assert.equal(result.pollDelayMs, 10_000);
});

test('github-auth: pollForToken expired_token → status expired', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'expired_token', error_description: 'device code expired' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd' });
  assert.equal(result.status, 'expired');
});

test('github-auth: pollForToken access_denied → status denied', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'access_denied', error_description: 'user denied' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd' });
  assert.equal(result.status, 'denied');
});

test('github-auth: pollForToken 未知错误 → status error + errorCode + 可展示描述', async () => {
  const client = installFetcher(() =>
    jsonResponse(200, { error: 'incorrect_device_code', error_description: 'device code mismatch' }));
  const result = await client.pollForToken({ clientId: 'c', deviceCode: 'd' });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'incorrect_device_code');
  assert.match(result.message ?? '', /mismatch/);
  assert.equal(result.accessToken, undefined, '失败结果绝不携带 access token');
});

/* ---------------------------------------------------------------- DeviceFlowStore */

function entry(overrides: Partial<DeviceFlowEntry> = {}): DeviceFlowEntry {
  return {
    deviceCode: 'device-abc-123',
    clientId: 'client-123',
    interval: 5,
    expiresAt: 1_000_000,
    ...overrides,
  };
}

test('github-auth: DeviceFlowStore set/get 往返；缺失 flowId → undefined', () => {
  const store = new DeviceFlowStore(() => 0);
  store.set('flow-1', entry());
  const got = store.get('flow-1');
  assert.equal(got?.deviceCode, 'device-abc-123');
  assert.equal(store.get('missing'), undefined);
});

test('github-auth: DeviceFlowStore 过期条目 → get 返回 undefined 并清理（不残留）', () => {
  let now = 0;
  const store = new DeviceFlowStore(() => now);
  store.set('flow-1', entry({ expiresAt: 100 }));
  now = 200; // 超过 expiresAt
  assert.equal(store.get('flow-1'), undefined);
  assert.equal(store.size, 0, '过期条目必须被清除');
});

test('github-auth: DeviceFlowStore delete 移除条目；未过期条目可正常取出', () => {
  const store = new DeviceFlowStore(() => 0);
  store.set('flow-1', entry({ expiresAt: 1000 }));
  store.delete('flow-1');
  assert.equal(store.get('flow-1'), undefined);
  assert.equal(store.size, 0);
  store.set('flow-2', entry({ expiresAt: 1000 }));
  assert.equal(store.get('flow-2')?.clientId, 'client-123');
});
