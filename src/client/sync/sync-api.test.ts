/**
 * m-sync-ui：SyncApi（/api/dsh-config-manager/sync/*）请求契约测试。
 * 用全局 fetch mock 验证 status/push/pull 的路径/方法/请求体与响应解析（含 4xx 错误映射）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApiError } from '../api.ts';
import { SYNC_API, SYNC_WEBDAV_CREDENTIAL_REF, SyncApi } from './sync-api.ts';

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

test('S-02 api.push()：POST /sync/push，请求体携带 repoUrl/token', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-1', sections: ['settings'], warnings: [] });
  });

  const api = new SyncApi();
  const result = await api.push({ repoUrl: 'https://github.com/u/r.git', token: 'ghp_secret' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshotId, 'sync-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.push);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal(sent['token'], 'ghp_secret');
  assert.equal(sent['gitBin'], undefined);
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

/* ------------------------------------------------ 一键同步（方案 A）端点契约 */

test('S-10 api.snapshotsList()：POST /sync/snapshots-list，解析倒序快照列表 + currentSnapshotId', async () => {
  const body = {
    ok: true,
    snapshots: [
      { id: 'sync-2', createdAt: '2026-08-17T10:00:00.000Z', sectionCount: 3, platform: 'darwin', dshVersion: '1.0.0' },
      { id: 'sync-1', createdAt: '2026-08-16T10:00:00.000Z', sectionCount: 2, platform: 'darwin', dshVersion: '1.0.0' },
    ],
    currentSnapshotId: 'sync-1',
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new SyncApi();
  const result = await api.snapshotsList({ repoUrl: 'https://github.com/u/r.git' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.snapshots[0]?.id, 'sync-2');
  assert.equal(result.currentSnapshotId, 'sync-1');
  assert.equal(calls[0]?.url, SYNC_API.snapshotsList);
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('S-11 api.sync()：POST /sync/sync，请求体携带 snapshotId；响应含 items/needsReview/compatibility', async () => {
  const body = {
    ok: true,
    syncSessionId: 'sess-1',
    snapshotId: 'sync-3',
    items: [{ itemId: 'settings:a', adapter: 'settings', kind: 'Update', description: '更新', severity: 'info', defaultAdopt: true, adopt: true }],
    needsReview: false,
    compatibility: 'good',
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new SyncApi();
  const result = await api.sync({ repoUrl: 'https://github.com/u/r.git', snapshotId: 'sync-3' });
  assert.equal(result.syncSessionId, 'sess-1');
  assert.equal(result.items.length, 1);
  assert.equal(result.compatibility, 'good');
  assert.equal(calls[0]?.url, SYNC_API.sync);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['snapshotId'], 'sync-3');
});

test('S-12 api.applyItems()：POST /sync/apply-items，携带 adoptions（含 Conflict resolution）', async () => {
  const body = {
    ok: true, applied: ['settings'], skipped: ['plugin:x'], needsRestart: false,
    warnings: [], restoreId: 'rest-1', rolledBack: false, failed: [], result: {},
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new SyncApi();
  const result = await api.applyItems({
    syncSessionId: 'sess-1',
    adoptions: [
      { itemId: 'settings:a', adopt: true },
      { itemId: 'plugin:x', adopt: true, resolution: 'useRemote' },
    ],
  });
  assert.equal(result.applied[0], 'settings');
  assert.equal(result.restoreId, 'rest-1');
  assert.equal(calls[0]?.url, SYNC_API.applyItems);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['syncSessionId'], 'sess-1');
  const adoptions = sent['adoptions'] as Array<Record<string, unknown>>;
  assert.equal(adoptions[1]?.['resolution'], 'useRemote');
});

test('S-13 api.cancel()：POST /sync/cancel 携带 syncSessionId', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true });
  });
  const api = new SyncApi();
  const result = await api.cancel('sess-1');
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, SYNC_API.cancel);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['syncSessionId'], 'sess-1');
});

/* ------------------------------------------------ 自动同步端点契约 */

test('S-14 api.autosyncStatus()：GET /sync/autosync，解析 enabled/interval/elapsedMs', async () => {
  const body = {
    enabled: true, interval: '30m', lastRunAt: '2026-08-17T10:00:00.000Z',
    lastRunStatus: 'success', consecutiveFailures: 0, elapsedMs: 60000,
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  const lastCall = (): FetchCall | null => called;
  const api = new SyncApi();
  const result = await api.autosyncStatus();
  assert.equal(result.enabled, true);
  assert.equal(result.interval, '30m');
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.elapsedMs, 60000);
  assert.equal(lastCall()?.url, SYNC_API.autosync);
});

test('S-15 api.autosyncUpdate()：POST /sync/autosync，请求体携带 enabled/interval', async () => {
  const body = {
    enabled: true, interval: '60m', consecutiveFailures: 0, elapsedMs: -1,
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });
  const api = new SyncApi();
  const result = await api.autosyncUpdate({ enabled: true, interval: '60m' });
  assert.equal(result.enabled, true);
  assert.equal(result.interval, '60m');
  assert.equal(calls[0]?.url, SYNC_API.autosync);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['enabled'], true);
  assert.equal(sent['interval'], '60m');
});

test('S-16 api.history()：GET /sync/history，解析 { entries }（含 autosync 记录）', async () => {
  const body = {
    entries: [
      { id: 'sync-1', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
      {
        id: '2026-08-17T09:00:00.000Z', createdAt: '2026-08-17T09:00:00.000Z', kind: 'autosync',
        autosync: {
          direction: 'both', status: 'skipped', skipReason: 'conflict',
          conflictedSections: ['settings'], failureCountAtRun: 0, createdAt: '2026-08-17T09:00:00.000Z',
        },
      },
    ],
  };
  installFetchMock(() => jsonResponse(200, body));
  const api = new SyncApi();
  const result = await api.history();
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]?.kind, 'apply');
  assert.equal(result.entries[1]?.kind, 'autosync');
  assert.deepEqual(result.entries[1]?.autosync?.conflictedSections, ['settings']);
});

/* ------------------------------------------------ WebDAV 通道契约 */

test('S-17 WebDAV 密码凭据引用名常量存在', () => {
  assert.equal(SYNC_WEBDAV_CREDENTIAL_REF, 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD');
});

test('S-18 api.status()：webdav 通道 → 解析 webdav 配置状态（url/username/usernameConfigured/passwordConfigured，无 secret 值）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: false, credentialWritable: true,
    webdav: {
      url: 'https://dav.example.com/dav/config', username: 'alice', usernameConfigured: true, passwordConfigured: true,
    },
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 2,
    transport: { type: 'webdav', ref: 'https://dav.example.com/dav/config' },
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  const lastCall = (): FetchCall | null => called;
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.webdav?.url, 'https://dav.example.com/dav/config');
  assert.equal(result.webdav?.username, 'alice', 'status 可回传 username 值（非敏感，供表单回填）');
  assert.equal(result.webdav?.usernameConfigured, true);
  assert.equal(result.webdav?.passwordConfigured, true);
  assert.equal('password' in (result.webdav ?? {}), false, 'status 契约不得携带 webdav 密码值');
  assert.equal(lastCall()?.url, SYNC_API.status);
});

test('S-19 api.push()：transport=webdav → 请求体携带顶层扁平 url/username/password（不携带 git 字段）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-w1', sections: [], warnings: [] });
  });
  const api = new SyncApi();
  const result = await api.push({
    transport: 'webdav',
    url: 'https://dav.example.com/dav/config', username: 'alice', password: 'secret-pass',
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.push);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], 'webdav');
  assert.equal(sent['url'], 'https://dav.example.com/dav/config', 'webdav url 应处于请求体顶层（flat）');
  assert.equal(sent['username'], 'alice', 'webdav username 应处于请求体顶层（flat）');
  assert.equal(sent['password'], 'secret-pass', 'webdav password 应处于请求体顶层（flat）');
  assert.equal(sent['webdav'], undefined, '不应再嵌套 webdav 对象');
  assert.equal(sent['repoUrl'], undefined, 'webdav 通道不应携带 git repoUrl');
});

test('S-20 api.pull()：transport=webdav 请求体透传扁平 webdav 配置', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-w1', changes: [], needsReview: false });
  });
  const api = new SyncApi();
  await api.pull({ transport: 'webdav', url: 'https://dav.example.com/dav/config', username: 'alice', password: 'secret-pass' });
  assert.equal(calls[0]?.url, SYNC_API.pull);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], 'webdav');
  assert.equal(sent['url'], 'https://dav.example.com/dav/config');
  assert.equal(sent['webdav'], undefined, '不应再嵌套 webdav 对象');
});

test('S-21 git 通道缺省：不带 transport → 请求体仍只含 git 字段（向后兼容）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-1', sections: [], warnings: [] });
  });
  const api = new SyncApi();
  await api.push({ repoUrl: 'https://github.com/u/r.git', token: 't' });
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], undefined, '缺省不声明 transport（Host 视为 git）');
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal(sent['webdav'], undefined);
});

test('S-22 api.push()：高级（自定义导出）模式 → 请求体携带 sections；缺省不携带', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-sel', sections: ['settings'], warnings: [] });
  });
  const api = new SyncApi();
  // 高级模式：传勾选分区
  await api.push({ repoUrl: 'https://github.com/u/r.git', sections: ['settings', 'skills'] });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.deepEqual(sent['sections'], ['settings', 'skills'], '高级模式应携带 sections');

  // 默认模式：不传 sections（undefined → 全量推荐分区）
  const calls2: FetchCall[] = [];
  installFetchMock((call) => {
    calls2.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-def', sections: ['settings'], warnings: [] });
  });
  await api.push({ repoUrl: 'https://github.com/u/r.git' });
  const sent2 = JSON.parse(String(calls2[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent2['sections'], undefined, '默认模式不应携带 sections');
});

test('S-23 api.status()：解析 syncSections（可同步分区目录，无 secret 值）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: true, credentialWritable: true, sectionCount: 4,
    syncSections: [
      { id: 'settings', displayName: 'Settings', portability: 'portable', defaultIncluded: true },
      { id: 'skills', displayName: 'Skills', portability: 'portable', defaultIncluded: true },
    ],
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  const lastCall = (): FetchCall | null => called;
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.syncSections?.length, 2);
  assert.equal(result.syncSections?.[0]?.id, 'settings');
  assert.equal(result.syncSections?.[1]?.portability, 'portable');
  assert.equal(lastCall()?.url, SYNC_API.status);
});

test('S-24 api.status()：解析 syncSelection（持久化分区选择，UI 回填用）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: true, credentialWritable: true, sectionCount: 2,
    syncSelection: { mode: 'advanced', sections: ['settings', 'skills'] },
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  const lastCall = (): FetchCall | null => called;
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.syncSelection?.mode, 'advanced');
  assert.deepEqual(result.syncSelection?.sections, ['settings', 'skills']);
  assert.equal(lastCall()?.url, SYNC_API.status);
});

test('S-25 api.saveSelection()：POST /sync/selection 携带 mode + sections（持久化到 Host）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, mode: 'advanced', sections: ['settings', 'skills'] });
  });
  const api = new SyncApi();
  const result = await api.saveSelection({ mode: 'advanced', sections: ['settings', 'skills'] });
  assert.equal(result.mode, 'advanced');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.selection);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['mode'], 'advanced');
  assert.deepEqual(sent['sections'], ['settings', 'skills']);
});

test('S-26 api.push()：加密快照 → 请求体携带 encrypt/encryptPassword/includeSecrets', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-enc', sections: ['settings'], warnings: [] });
  });
  const api = new SyncApi();
  await api.push({
    repoUrl: 'https://github.com/u/r.git',
    encrypt: true,
    encryptPassword: 'pw-12345678',
    includeSecrets: true,
  });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['encrypt'], true);
  assert.equal(sent['encryptPassword'], 'pw-12345678');
  assert.equal(sent['includeSecrets'], true);
});

test('S-27 api.pull()：拉取加密快照 → 请求体携带 decryptPassword（仅内存传输）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-enc', changes: [], needsReview: false });
  });
  const api = new SyncApi();
  await api.pull({ repoUrl: 'https://github.com/u/r.git', decryptPassword: 'pw-12345678' });
  assert.equal(calls[0]?.url, SYNC_API.pull);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['decryptPassword'], 'pw-12345678');
});

test('S-28 api.status()：syncSelection 含 encrypt/includeSecrets 开关（UI 回填）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: true, credentialWritable: true, sectionCount: 2,
    syncSelection: { mode: 'advanced', sections: ['settings'], encrypt: true, includeSecrets: true },
  };
  installFetchMock(() => jsonResponse(200, body));
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.syncSelection?.encrypt, true);
  assert.equal(result.syncSelection?.includeSecrets, true);
});
