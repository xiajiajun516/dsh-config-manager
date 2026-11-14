/**
 * update-check 测试：只读探测 npm latest 的解析 / 比较 / 缓存 / 失败路径。
 * 全程注入 `fetchImpl`（**绝不真连 registry**）+ 注入时钟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NPM_LATEST_URL,
  UPDATE_CHECK_CACHE_MS,
  UPDATE_CHECK_MAX_BYTES,
  UpdateChecker,
  parseLatestVersion,
  probeLatestVersion,
  wantsForcedUpdateCheck,
} from './update-check.ts';

/** 构造一个返回固定响应的 fetch 桩 */
function stubFetch(body: string, init: { status?: number } = {}): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

test('wantsForcedUpdateCheck：只认精确的 force=1', () => {
  assert.equal(wantsForcedUpdateCheck('/api/dsh-config-manager/update-check?force=1'), true);
  assert.equal(wantsForcedUpdateCheck('/x?force=1&t=2'), true);
  assert.equal(wantsForcedUpdateCheck('/x?t=2&force=1'), true);
  assert.equal(wantsForcedUpdateCheck('/x?force=0'), false);
  assert.equal(wantsForcedUpdateCheck('/x?force=true'), false);
  assert.equal(wantsForcedUpdateCheck('/x?force='), false);
  assert.equal(wantsForcedUpdateCheck('/x?force'), false);
  assert.equal(wantsForcedUpdateCheck('/x?forced=1'), false);
  assert.equal(wantsForcedUpdateCheck('/api/dsh-config-manager/update-check'), false);
  assert.equal(wantsForcedUpdateCheck(undefined), false);
  assert.equal(wantsForcedUpdateCheck(''), false);
});

test('parseLatestVersion：只认 { version: semver }，其余一律 null（不猜）', () => {
  assert.equal(parseLatestVersion({ version: '1.2.3' }), '1.2.3');
  assert.equal(parseLatestVersion({ version: ' 0.1.68 ' }), '0.1.68');
  assert.equal(parseLatestVersion({ version: '1.2.3-rc.1' }), '1.2.3-rc.1');
  assert.equal(parseLatestVersion({ version: '1.2.3+build.9' }), '1.2.3+build.9');
  // 形态不认识 / 缺字段 / 类型错 / 结构错
  assert.equal(parseLatestVersion({ version: 'latest' }), null);
  assert.equal(parseLatestVersion({ version: '1.2' }), null);
  assert.equal(parseLatestVersion({ version: 123 }), null);
  assert.equal(parseLatestVersion({}), null);
  assert.equal(parseLatestVersion(null), null);
  assert.equal(parseLatestVersion('1.2.3'), null);
  assert.equal(parseLatestVersion([{ version: '1.2.3' }]), null);
});

test('probeLatestVersion：命中 latest 端点并回传版本号', async () => {
  const { impl, calls } = stubFetch(JSON.stringify({ version: '9.9.9' }));
  const r = await probeLatestVersion({ fetchImpl: impl });
  assert.deepEqual(r, { ok: true, version: '9.9.9' });
  assert.deepEqual(calls, [NPM_LATEST_URL], '请求的是 latest 端点（体积小、无整包 packument）');
});

test('probeLatestVersion：非 2xx / 非法 JSON / 体积超限 / 过期形态 → 结构化失败', async () => {
  const notFound = await probeLatestVersion({ fetchImpl: stubFetch('not found', { status: 404 }).impl });
  assert.equal(notFound.ok, false);
  assert.match(notFound.ok === false ? notFound.error : '', /HTTP 404/);

  const badJson = await probeLatestVersion({ fetchImpl: stubFetch('{oops').impl });
  assert.equal(badJson.ok, false);
  assert.match(badJson.ok === false ? badJson.error : '', /not valid JSON/);

  const big = await probeLatestVersion({ fetchImpl: stubFetch('x'.repeat(UPDATE_CHECK_MAX_BYTES + 1)).impl });
  assert.equal(big.ok, false);
  assert.match(big.ok === false ? big.error : '', /too large/);

  const noVersion = await probeLatestVersion({ fetchImpl: stubFetch(JSON.stringify({ name: 'x' })).impl });
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.ok === false ? noVersion.error : '', /no usable version/);
});

test('probeLatestVersion：网络抛错与超时都被收成失败（绝不抛出）', async () => {
  const throwing = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch;
  const net = await probeLatestVersion({ fetchImpl: throwing });
  assert.equal(net.ok, false);
  assert.match(net.ok === false ? net.error : '', /network error: getaddrinfo ENOTFOUND/);

  // 永不 resolve 的 fetch：只能靠超时中断
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) });
  })) as typeof fetch;
  const slow = await probeLatestVersion({ fetchImpl: hanging, timeoutMs: 20 });
  assert.equal(slow.ok, false);
  assert.match(slow.ok === false ? slow.error : '', /timed out after 20 ms/);
});

test('UpdateChecker：updateAvailable 只在严格更新时为真（同版/更旧/预发布都不提示）', async () => {
  const newer = new UpdateChecker('0.1.68', { fetchImpl: stubFetch(JSON.stringify({ version: '0.1.69' })).impl });
  const a = await newer.check();
  assert.equal(a.ok, true);
  assert.equal(a.ok === true ? a.info.updateAvailable : null, true);

  const same = new UpdateChecker('0.1.68', { fetchImpl: stubFetch(JSON.stringify({ version: '0.1.68' })).impl });
  const b = await same.check();
  assert.equal(b.ok === true ? b.info.updateAvailable : null, false, '同版本不算有新版本');

  const older = new UpdateChecker('0.2.0', { fetchImpl: stubFetch(JSON.stringify({ version: '0.1.68' })).impl });
  const c = await older.check();
  assert.equal(c.ok === true ? c.info.updateAvailable : null, false, 'registry 更旧（本地跑的是预发布/超前版）不提示降级');

  // 1.10.0 vs 1.9.0：数字比较而不是字符串比较（1.9.0 是旧版）
  const numeric = new UpdateChecker('1.9.0', { fetchImpl: stubFetch(JSON.stringify({ version: '1.10.0' })).impl });
  const d = await numeric.check();
  assert.equal(d.ok === true ? d.info.updateAvailable : null, true, '1.10.0 > 1.9.0（按段比较）');
});

test('UpdateChecker：缓存命中不重复请求；force 绕过缓存', async () => {
  const now = 1_000_000;
  const { impl, calls } = stubFetch(JSON.stringify({ version: '1.0.0' }));
  const checker = new UpdateChecker('0.9.0', { fetchImpl: impl, now: () => now, cacheMs: UPDATE_CHECK_CACHE_MS });

  const first = await checker.check();
  assert.equal(first.ok === true ? first.cached : null, false);
  const second = await checker.check();
  assert.equal(second.ok === true ? second.cached : null, true, '缓存窗口内直接回缓存');
  assert.equal(calls.length, 1, '不得把 registry 当轮询端点');

  const forced = await checker.check({ force: true });
  assert.equal(forced.ok === true ? forced.cached : null, false);
  assert.equal(calls.length, 2, 'force 必须真的重新探测');
});

test('UpdateChecker：失败不写缓存（下次仍会重试），且失败结果带当前版本与原因', async () => {
  let mode = 'fail';
  const impl = (async () => (mode === 'fail'
    ? new Response('boom', { status: 500 })
    : new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }))) as unknown as typeof fetch;
  const checker = new UpdateChecker('1.0.0', { fetchImpl: impl });

  const bad = await checker.check();
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false ? bad.current : null, '1.0.0');
  assert.match(bad.ok === false ? bad.error : '', /HTTP 500/);

  mode = 'ok';
  const good = await checker.check();
  assert.equal(good.ok, true, '失败不进缓存 → 下一次恢复后可以直接成功');
  assert.equal(good.ok === true ? good.info.latest : null, '2.0.0');
});

/* ---------------- 审计 P11-6：体积上限必须按字节，且不把大响应读进内存 ---------------- */

test('P11-6 回归：上限按**字节**判定 —— CJK 120KB 响应不得因 text.length 只有 40K 被放行', async () => {
  // 一个 CJK 字符占 3 个 UTF-8 字节：旧实现用 text.length（UTF-16 代码单元）判上限 ⇒ 120KB 的中文
  // 响应只数到 40K，上限形同虚设。这里同时钉住两个事实：字节超限、代码单元不超限。
  const cjk = JSON.stringify({ version: '9.9.9', description: '中'.repeat(40_000) });
  assert.ok(cjk.length <= UPDATE_CHECK_MAX_BYTES, '前提：代码单元没超限（旧口径会放行）');
  assert.ok(new TextEncoder().encode(cjk).byteLength > UPDATE_CHECK_MAX_BYTES, '前提：字节数超限');
  const r = await probeLatestVersion({ fetchImpl: stubFetch(cjk).impl });
  assert.deepEqual(r, { ok: false, error: 'registry response too large' });
});

test('P11-6：Content-Length 声明超限时直接拒绝（一个字节都不读）', async () => {
  // 不用真 Response：undici 的 Response 构造期就会 pull 一次流（实测），用它证不了「没读」。
  // 这里用 getter 记账：只要实现碰了 body / arrayBuffer 就会抛错并计数。
  let bodyReads = 0;
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(UPDATE_CHECK_MAX_BYTES + 1) }),
    get body(): ReadableStream<Uint8Array> | null {
      bodyReads += 1;
      throw new Error('body must not be read');
    },
    arrayBuffer: async () => {
      bodyReads += 1;
      throw new Error('body must not be read');
    },
  })) as unknown as typeof fetch;
  const r = await probeLatestVersion({ fetchImpl: impl });
  assert.deepEqual(r, { ok: false, error: 'registry response too large' });
  assert.equal(bodyReads, 0, '有 Content-Length 就先拒，不把大响应读进内存');
});

test('P11-6：小体量 CJK 响应照常解析（字节口径不误伤）', async () => {
  const body = JSON.stringify({ version: '9.9.9', description: '中文说明'.repeat(100) });
  const r = await probeLatestVersion({ fetchImpl: stubFetch(body).impl });
  assert.deepEqual(r, { ok: true, version: '9.9.9' });
});
