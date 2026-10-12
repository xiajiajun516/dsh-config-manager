/**
 * 插件私有出站代理测试（issue #30 ②级方案）。
 *
 * 覆盖基线：
 *  - 环境变量解析（大小写、空值、`DSH_CONFIG_MANAGER_PROXY=off` 强制直连）；
 *  - `NO_PROXY` 匹配（`*` / 精确 / 后缀 / `:port` 限定 / 不匹配）；
 *  - 代理选择（https→HTTPS_PROXY 并可回退 HTTP_PROXY；http→HTTP_PROXY）；
 *  - **真实回环服务器**：http 目标经代理走 absolute-form；https 目标走 CONNECT 隧道
 *    （校验 CONNECT 行、Proxy-Authorization、以及隧道内 TLS ClientHello 的 SNI）；
 *  - **子进程 + NODE_EXTRA_CA_CERTS** 的完整 https 端到端（自签 CA，openssl 生成；无 openssl 则跳过）；
 *  - **User-Agent 兜底**（issue #86）：node 原生 http/https 不补 UA，缺省必补、显式传入不覆盖（两条通道一致）；
 *  - `NO_PROXY` 直连旁路；未配置代理时 `defaultFetcher` 原样返回全局 fetch（行为零变化）；
 *  - fetch 语义：跟随重定向、跨源剥离 authorization、303 降级 GET 丢 body、跳数上限。
 *
 * 安​全断言：`describeProxy` 绝不回显代理凭据（含用户名/密码的代理 URL）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  matchesNoProxy,
  proxyUrlFor,
  readProxyEnv,
  describeProxy,
  isProxyConfigured,
  createProxyAwareFetch,
  defaultFetcher,
  requestOnce,
  activeProxySummary,
  type ProxyEnv,
} from './proxy.ts';

const here = import.meta.dirname ?? resolve(fileURLToPath(import.meta.url), '..');
const NO_PROXY_ENV: ProxyEnv = { httpProxy: null, httpsProxy: null, noProxy: null };

/* ------------------------------------------------------------ 环境解析（纯函数） */

test('P1 readProxyEnv：大小写兼容、空值忽略、off 强制直连', () => {
  assert.deepEqual(readProxyEnv({}), NO_PROXY_ENV);
  assert.deepEqual(
    readProxyEnv({ HTTPS_PROXY: 'http://p:8080', HTTP_PROXY: 'http://q:3128', NO_PROXY: 'localhost' }),
    { httpsProxy: 'http://p:8080', httpProxy: 'http://q:3128', noProxy: 'localhost' },
  );
  // 小写形态（Linux/macOS shell 常见）
  assert.deepEqual(
    readProxyEnv({ https_proxy: 'http://p:8080', no_proxy: '127.0.0.1' }),
    { httpsProxy: 'http://p:8080', httpProxy: null, noProxy: '127.0.0.1' },
  );
  // 空串/空白 → 视为未设置（不产生空字符串代理）
  assert.deepEqual(readProxyEnv({ HTTPS_PROXY: '   ', HTTP_PROXY: '' }), NO_PROXY_ENV);
  // 强制直连开关
  for (const off of ['off', 'NONE', '0', 'false', 'disabled']) {
    assert.deepEqual(
      readProxyEnv({ HTTPS_PROXY: 'http://p:8080', DSH_CONFIG_MANAGER_PROXY: off }),
      NO_PROXY_ENV,
      `DSH_CONFIG_MANAGER_PROXY=${off} 应强制直连`,
    );
  }
  assert.equal(isProxyConfigured(readProxyEnv({ HTTP_PROXY: 'http://p:1' })), true);
  assert.equal(isProxyConfigured(NO_PROXY_ENV), false);
});

test('P2 matchesNoProxy：* / 精确 / 子域后缀 / .前缀 / 端口限定', () => {
  assert.equal(matchesNoProxy('github.com', '443', '*'), true);
  assert.equal(matchesNoProxy('github.com', '443', 'github.com'), true);
  assert.equal(matchesNoProxy('api.github.com', '443', 'github.com'), true, '裸域名应覆盖子域');
  assert.equal(matchesNoProxy('api.github.com', '443', '.github.com'), true, '点前缀应覆盖子域');
  assert.equal(matchesNoProxy('notgithub.com', '443', 'github.com'), false, '后缀必须按标签边界');
  assert.equal(matchesNoProxy('github.com', '443', 'example.com, github.com'), true, '逗号分隔 + 空格容错');
  assert.equal(matchesNoProxy('github.com', '80', 'github.com:8080'), false, '端口不匹配应放行（走代理）');
  assert.equal(matchesNoProxy('github.com', '8080', 'github.com:8080'), true);
  assert.equal(matchesNoProxy('github.com', '443', ''), false);
  assert.equal(matchesNoProxy('github.com', '443', null), false);
});

test('P3 proxyUrlFor：协议选路、HTTP_PROXY 回退、NO_PROXY 旁路、非法代理忽略', () => {
  const env: ProxyEnv = { httpProxy: 'http://h:3128', httpsProxy: 'http://s:8080', noProxy: null };
  assert.equal(proxyUrlFor('https://api.github.com/user', env), 'http://s:8080/');
  assert.equal(proxyUrlFor('http://example.com/', env), 'http://h:3128/');
  // 只设 HTTP_PROXY 时 https 也回退可用（对齐 undici EnvHttpProxyAgent 的直觉语义）
  assert.equal(proxyUrlFor('https://api.github.com/', { ...env, httpsProxy: null }), 'http://h:3128/');
  // NO_PROXY 命中 → 直连
  assert.equal(proxyUrlFor('https://api.github.com/', { ...env, noProxy: 'github.com' }), null);
  // 无代理配置 → 直连
  assert.equal(proxyUrlFor('https://api.github.com/', NO_PROXY_ENV), null);
  // 非法/不支持协议 → 直连（不抛错）
  assert.equal(proxyUrlFor('https://x/', { ...env, httpsProxy: 'socks5://h:1' }), null);
  assert.equal(proxyUrlFor('not a url', env), null);
  assert.equal(proxyUrlFor('ftp://x/', env), null);
});

test('P4 describeProxy / activeProxySummary：脱敏（凭据绝不外泄）', () => {
  const described = describeProxy('http://user:secret@proxy.local:8080');
  assert.equal(described, 'http://proxy.local:8080');
  assert.ok(!described.includes('secret') && !described.includes('user'), '凭据不得出现在描述中');
  const summary = activeProxySummary({ httpProxy: 'http://u:p@h:1', httpsProxy: null, noProxy: 'a, b' });
  assert.deepEqual(summary, { http: 'http://h:1', https: null, noProxyEntries: 2 });
  assert.equal(activeProxySummary(NO_PROXY_ENV), null, '未配置代理 → null（启动日志不打）');
});

test('P5 defaultFetcher：未配置代理时原样返回全局 fetch（行为零变化）', () => {
  assert.equal(defaultFetcher(NO_PROXY_ENV), globalThis.fetch, '无代理环境必须仍是原生 fetch（不改变现状）');
  const proxied = defaultFetcher({ httpProxy: 'http://127.0.0.1:1', httpsProxy: null, noProxy: null });
  assert.notEqual(proxied, globalThis.fetch, '配置代理后才切换到代理感知实现');
});

/* ------------------------------------------------------------ 真实回环服务器夹具 */

interface ProxyHit {
  kind: 'absolute' | 'connect';
  line: string;
  headers: http.IncomingHttpHeaders;
  target?: string;
  body?: string;
  tunnelBytes?: Buffer;
}

/** 极简 HTTP 代理：absolute-form 转发；CONNECT 建隧道（可截获隧道内首段字节）。 */
async function startProxy(): Promise<{ url: string; hits: ProxyHit[]; close: () => Promise<void> }> {
  const hits: ProxyHit[] = [];
  const server = http.createServer((req, res) => {
    const target = new URL(req.url ?? '/', 'http://placeholder');
    hits.push({
      kind: 'absolute',
      line: `${req.method} ${req.url}`,
      headers: req.headers,
      target: `${target.protocol}//${target.host}${target.pathname}`,
      body: '',
    });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      hits[hits.length - 1]!.body = Buffer.concat(chunks).toString('utf8');
      const upstream = http.request(
        { host: target.hostname, port: Number(target.port !== '' ? target.port : 80), path: `${target.pathname}${target.search}`, method: req.method, headers: { ...req.headers, host: target.host } },
        (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
      );
      upstream.on('error', () => { res.writeHead(502).end('upstream error'); });
      if (chunks.length > 0) upstream.write(Buffer.concat(chunks));
      upstream.end();
    });
  });
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = (req.url ?? '').split(':');
    hits.push({ kind: 'connect', line: `${req.method} ${req.url}`, headers: req.headers, tunnelBytes: Buffer.alloc(0) });
    const hit = hits[hits.length - 1]!;
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    // 截获隧道内首段字节（用于断言 TLS ClientHello 的 SNI）。
    // 注意：只观察，**不要 unshift** —— 数据已由下面的 pipe 转发，回填会造成字节重复、握手损坏。
    clientSocket.once('data', (chunk: Buffer) => {
      hit.tunnelBytes = Buffer.from(chunk);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => { r() }); }),
  };
}

/** 记录收到的请求的源站。 */
async function startOrigin(): Promise<{ url: string; seen: { path: string; headers: http.IncomingHttpHeaders; body: string; method: string }[]; close: () => Promise<void> }> {
  const seen: { path: string; headers: http.IncomingHttpHeaders; body: string; method: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), method: req.method ?? '' });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' }).end();
        return;
      }
      if (req.url === '/see-other') {
        res.writeHead(303, { location: '/final' }).end();
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => { r() }); }),
  };
}

/* ------------------------------------------------------------ http 目标经代理 */

test('P6 http 目标经代理：请求交到代理（absolute-form），响应原样回传', async (t) => {
  const prx = await startProxy();
  const origin = await startOrigin();
  t.after(async () => { await prx.close(); await origin.close(); });

  const res = await requestOnce({
    url: `${origin.url}/via-proxy`,
    headers: { 'x-test': 'yes' },
    env: { httpsProxy: null, httpProxy: prx.url, noProxy: null },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { ok: true, path: '/via-proxy' });
  const hit = prx.hits.find((h) => h.kind === 'absolute');
  assert.ok(hit !== undefined, '代理必须收到该请求');
  assert.match(hit!.line, /^GET http:\/\/127\.0\.0\.1:\d+\/via-proxy/, 'http 目标应使用 absolute-form');
  assert.equal(hit!.headers['x-test'], 'yes', '自定义头应透传到代理');
  assert.equal(origin.seen.length, 1, '源站只应经代理收到一次');
});

test('P7 NO_PROXY 命中 → 完全绕过代理（直连源站）', async (t) => {
  const prx = await startProxy();
  const origin = await startOrigin();
  t.after(async () => { await prx.close(); await origin.close(); });

  const res = await requestOnce({
    url: `${origin.url}/direct`,
    env: { httpsProxy: null, httpProxy: prx.url, noProxy: '127.0.0.1' },
  });

  assert.equal(res.status, 200);
  assert.equal(prx.hits.length, 0, 'NO_PROXY 命中时代理不得收到任何请求');
  assert.equal(origin.seen.length, 1);
});

test('P13 请求头兜底 User-Agent（issue #86）：缺省必补、显式传入不覆盖、直连与经代理一致', async (t) => {
  const prx = await startProxy();
  const origin = await startOrigin();
  t.after(async () => { await prx.close(); await origin.close(); });
  const viaProxy: ProxyEnv = { httpsProxy: null, httpProxy: prx.url, noProxy: null };

  // 1) 经代理：缺省 → 补默认 UA（GitHub 前置层就是靠它放行无 token 的请求）
  await requestOnce({ url: `${origin.url}/ua-default`, env: viaProxy });
  assert.equal(prx.hits[0]?.headers['user-agent'], 'DSH-Config-Manager', '经代理时缺省必须补 User-Agent');
  assert.equal(origin.seen[0]?.headers['user-agent'], 'DSH-Config-Manager', 'UA 必须原样到达源站');

  // 2) 经代理：调用方显式传入（大小写混写）→ 绝不覆盖
  await requestOnce({
    url: `${origin.url}/ua-explicit`,
    headers: { 'User-Agent': 'custom-agent/1.0' },
    env: viaProxy,
  });
  assert.equal(origin.seen[1]?.headers['user-agent'], 'custom-agent/1.0', '显式 UA 不得被默认值覆盖');

  // 3) 直连（无代理）：同一份请求语义 —— 不再出现「配了代理反而坏」这种反直觉差异
  await requestOnce({ url: `${origin.url}/ua-direct`, env: NO_PROXY_ENV });
  assert.equal(origin.seen[2]?.headers['user-agent'], 'DSH-Config-Manager', '直连同样必须有 UA');
});

/**
 * 在子进程里跑脚本并回收输出（**必须异步 spawn**）。
 *
 * 关键教训：本用例的代理与源站都跑在**当前进程**里，`spawnSync` 会阻塞当前进程的事件循环 →
 * 子进程等代理响应、父进程等子进程退出，直接死锁（实测挂满超时被杀）。故一律用异步 spawn。
 */
function runChild(script: string, env: Record<string, string>): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') });
    const killer = setTimeout(() => { child.kill('SIGKILL') }, 20_000);
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolveChild({ status, signal, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------ https 目标经代理 */

test('P8 https 目标经代理：先 CONNECT（含 Basic 凭据），隧道内 TLS ClientHello 的 SNI 为目标主机', async (t) => {
  // 隧道另一端不需要真 TLS：CONNECT 后只读取客户端首段字节即可断言隧道与 SNI。
  const server = http.createServer();
  const received: { connectLine: string; auth?: string; bytes: Buffer }[] = [];
  server.on('connect', (req, socket) => {
    const rec = { connectLine: `${req.method} ${req.url}`, auth: req.headers['proxy-authorization'] as string | undefined, bytes: Buffer.alloc(0) };
    received.push(rec);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (chunk: Buffer) => {
      rec.bytes = Buffer.from(chunk);
      socket.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  t.after(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => { r() }); }) });

  await assert.rejects(
    () => requestOnce({
      url: 'https://example-tunnel.test/secret',
      env: { httpsProxy: `http://alice:s3cr3t@127.0.0.1:${port}`, httpProxy: null, noProxy: null },
      timeoutMs: 5000,
    }),
    // 隧道对端不是真 TLS 服务，握手必然失败 —— 这里只关心「隧道已建立 + 已发起 TLS」
  );

  assert.equal(received.length, 1, '应发起一次 CONNECT');
  assert.equal(received[0]!.connectLine, 'CONNECT example-tunnel.test:443');
  assert.equal(
    received[0]!.auth,
    `Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`,
    '代理凭据应通过 Proxy-Authorization 传递',
  );
  const hello = received[0]!.bytes;
  assert.equal(hello[0], 0x16, '隧道内应为 TLS handshake 记录');
  assert.ok(hello.includes(Buffer.from('example-tunnel.test', 'ascii')), 'ClientHello 应携带目标主机名（SNI）');
});

/** 定位 openssl（PATH 优先，其次 Git for Windows 常见路径；供自签证书用） */
function findOpenssl(): string | null {
  const candidates = [
    'openssl',
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // 试下一个
    }
  }
  return null
}

/** openssl 生成的临时 CA + 服务器证书（CN/SAN=localhost）；无 openssl → null（该项跳过） */
function makeTestCertificates(): { ca: string; cert: string; key: string } | null {
  const openssl = findOpenssl();
  if (openssl === null) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-proxy-cert-'));
  try {
    const f = (name: string): string => join(dir, name);
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-days', '1', '-subj', '/CN=DSH CM Test CA'], { stdio: 'ignore' });
    execFileSync(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('srv.key'), '-out', f('srv.csr'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:localhost\n', 'utf8');
    execFileSync(openssl, ['x509', '-req', '-in', f('srv.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('srv.crt'), '-days', '1', '-extfile', f('ext.cnf')], { stdio: 'ignore' });
    return {
      ca: readFileSync(f('ca.crt'), 'utf8'),
      cert: readFileSync(f('srv.crt'), 'utf8'),
      key: readFileSync(f('srv.key'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P9 https 端到端（子进程 + NODE_EXTRA_CA_CERTS）：CONNECT 隧道内完成真实 TLS 请求', async (t) => {
  const certs = makeTestCertificates();
  if (certs === null) {
    t.skip('未找到 openssl，跳过自签证书端到端用例');
    return;
  }

  // 目标源站（TLS，自签）
  const origin = https.createServer({ cert: certs.cert, key: certs.key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hello: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = (origin.address() as net.AddressInfo).port;

  // CONNECT 代理
  const prx = await startProxy();
  t.after(async () => {
    await new Promise<void>((r) => { origin.closeAllConnections(); origin.close(() => { r() }) });
    await prx.close();
  });

  const script = `
    try {
      const { requestOnce } = await import(${JSON.stringify(pathToFileURL(resolve(here, 'proxy.ts')).href)});
      const res = await requestOnce({
        url: process.env.T_URL,
        env: { httpProxy: null, httpsProxy: process.env.T_PROXY, noProxy: null },
        timeoutMs: 10000,
      });
      process.stdout.write(JSON.stringify({ status: res.status, body: res.body.toString('utf8'), server: res.headers.get('content-type') }));
    } catch (err) {
      process.stderr.write('CHILD_ERROR: ' + (err && err.stack ? err.stack : String(err)));
      process.exit(2);
    }
    // keep-alive socket 会让事件循环保持存活；本用例只关心请求结果，显式退出。
    process.exit(0);
  `;
  const caFile = join(tmpdir(), `dsh-cm-ca-${Date.now()}.crt`);
  writeFileSync(caFile, certs.ca, 'utf8');
  const child = await runChild(script, {
    T_URL: `https://localhost:${originPort}/through-tunnel`,
    T_PROXY: prx.url,
    // 让子进程信任测试 CA（当前进程组装的信任链不生效：Node 启动时读取该变量）
    NODE_EXTRA_CA_CERTS: caFile,
  });

  assert.equal(child.status, 0, `子进程应成功（status=${String(child.status)} signal=${String(child.signal)} stderr: ${child.stderr}）`);
  const payload = JSON.parse(child.stdout) as { status: number; body: string; server: string };
  assert.equal(payload.status, 200);
  assert.deepEqual(JSON.parse(payload.body), { hello: '/through-tunnel' });
  assert.match(payload.server, /application\/json/, 'TLS 隧道的响应头应完整透传');
  assert.equal(prx.hits.filter((h) => h.kind === 'connect').length, 1, '应经代理 CONNECT 建立隧道（而非直连）');
});

/* ------------------------------------------------------------ fetch 语义 */

test('P10 createProxyAwareFetch：跟随 302、返回真实 Response（status/headers/json）', async (t) => {
  const origin = await startOrigin();
  t.after(async () => { await origin.close(); });

  const f = createProxyAwareFetch(NO_PROXY_ENV);
  const res = await f(`${origin.url}/redirect`);
  assert.equal(res.status, 200, '302 应被自动跟随（与浏览器 fetch 一致）');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { ok: true, path: '/final' });
  assert.deepEqual(origin.seen.map((s) => s.path), ['/redirect', '/final']);
});

test('P11 createProxyAwareFetch：跨源跳转剥离 authorization（token 不转发第三方）', async (t) => {
  const b = await startOrigin();
  // 独立源（不同端口）只做一件事：302 到 b
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { location: `${b.url}/landing` }).end();
  });
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
  const redirectorUrl = `http://127.0.0.1:${(redirector.address() as net.AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((r) => { redirector.closeAllConnections(); redirector.close(() => { r() }) });
    await b.close();
  });

  const f = createProxyAwareFetch(NO_PROXY_ENV);
  const res = await f(`${redirectorUrl}/start`, { headers: { authorization: 'Bearer sekret' } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { ok: true, path: '/landing' });
  assert.equal(b.seen.length, 1, '应跟随到跨源目标');
  assert.equal(b.seen[0]!.headers['authorization'], undefined, '跨源跳转必须剥离 authorization');
});

test('P11b 同源跳转保留 authorization（不能顺手把凭据丢了）', async (t) => {
  const origin = await startOrigin();
  t.after(async () => { await origin.close(); });

  const f = createProxyAwareFetch(NO_PROXY_ENV);
  const res = await f(`${origin.url}/redirect`, { headers: { authorization: 'Bearer keepme' } });
  assert.equal(res.status, 200);
  assert.deepEqual(origin.seen.map((s) => s.path), ['/redirect', '/final']);
  assert.equal(origin.seen[0]!.headers['authorization'], 'Bearer keepme');
  assert.equal(origin.seen[1]!.headers['authorization'], 'Bearer keepme', '同源跳转应保留 authorization');
});

test('P12 createProxyAwareFetch：303 降级 GET 并丢弃 body；跳数上限报错', async (t) => {
  const origin = await startOrigin();
  t.after(async () => { await origin.close(); });

  const f = createProxyAwareFetch(NO_PROXY_ENV);
  const res = await f(`${origin.url}/see-other`, { method: 'POST', body: 'payload' });
  assert.equal(res.status, 200);
  assert.deepEqual(origin.seen.map((s) => s.method), ['POST', 'GET'], '303 后应降级为 GET');
  assert.equal(origin.seen[1]!.body, '', '303 后必须丢弃请求体');

  await assert.rejects(() => f(`${origin.url}/loop`), /too many redirects/, '重定向循环应报错而不是无限跟随');
});
