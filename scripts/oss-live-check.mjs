#!/usr/bin/env node
/**
 * 阿里云 OSS 4（OSS4-HMAC-SHA256）签名自测脚本 —— issue #109 的自证工具。
 *
 * 为什么需要它：单元测试能证明「我们算的签名 = 官方金标向量」，但真机失败还有一层
 * 「整条链路发出去的请求是否被服务端接受」。本脚本跑完整同步链路（探桶 → 上传 → 列表 →
 * 下载 → 删除），用两种模式回答「到底通不通」：
 *
 *   1. 本地模式（默认，无需任何密钥 / 无需联网、不碰你的桶）
 *      起一个本地 HTTP 服务端，用**独立实现**的验签器（src/sync/s3/oss4-verify.ts，照官方
 *      Go SDK 重写）逐请求重建规范请求并校验签名；验不过就按 OSS 真实错误回 403
 *      SignatureDoesNotMatch，并打印它算出的 CanonicalRequest / StringToSign。
 *      这一模式走**真实网络栈与真实出站实现**（node:http + 本仓库 requestOnce），
 *      因此能抓到「注入 mock 看不到」的差异（头大小写、Host、被追加的头、body 编码）。
 *
 *   2. 真桶模式（--live，需要你自己的密钥）
 *      直接读写你的 OSS 桶，成功 = 阿里云服务端真的认了签名。
 *      读操作（探桶 / 列表）默认执行；写操作（上传 / 下载比对 / 删除）必须显式加 --write，
 *      且只碰 `<prefix>/<一次性 id>.json` 与索引，跑完即删。
 *
 * 用法：
 *   node scripts/oss-live-check.mjs                  # 本地模式，全链路
 *   node scripts/oss-live-check.mjs --live           # 真桶，只读探活
 *   node scripts/oss-live-check.mjs --live --write   # 真桶，含一次性上传/下载/删除
 *   node scripts/oss-live-check.mjs --help
 *
 * 真桶模式的环境变量（密钥只从环境读，绝不落盘、绝不打印）：
 *   OSS_BUCKET              桶名（必填）
 *   OSS_REGION              region，如 cn-hangzhou（必填）
 *   OSS_ACCESS_KEY_ID       AccessKey ID（必填）
 *   OSS_ACCESS_KEY_SECRET   AccessKey Secret（必填）
 *   OSS_ENDPOINT            可选，缺省 https://oss-<region>.aliyuncs.com
 *   OSS_PATH_STYLE          可选，=1 时用 path-style 寻址（缺省虚拟主机风格）
 *   OSS_PREFIX              可选，对象键前缀，缺省 dsh-config-manager
 *
 * 退出码：0 = 所有请求都被接受；1 = 有请求被拒；2 = 用法/环境变量错误。
 */
import http from 'node:http';
import process from 'node:process';

import { requestOnce } from '../src/utils/proxy.ts';
import { S3Transport } from '../src/sync/s3/s3-transport.ts';
import { makeOssVerifyServer, verifyOssV4 } from '../src/sync/s3/oss4-verify.ts';

const HELP = `阿里云 OSS4 签名自测（issue #109）

  node scripts/oss-live-check.mjs                 本地模式：内置验签服务端，跑完整链路
  node scripts/oss-live-check.mjs --live          真桶模式：只读（探桶 / 列表）
  node scripts/oss-live-check.mjs --live --write  真桶模式：含一次性上传 / 下载比对 / 删除
  node scripts/oss-live-check.mjs --help          显示本帮助

真桶模式读环境变量 OSS_BUCKET / OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
（可选 OSS_ENDPOINT / OSS_PATH_STYLE / OSS_PREFIX）。密钥只进内存，不落盘、不打印。
`;

function parseArgs(argv) {
  const out = { live: false, write: false, help: false };
  for (const arg of argv) {
    if (arg === '--live') out.live = true;
    else if (arg === '--write') out.write = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else {
      console.error('未知参数：' + arg + '（--help 查看用法）');
      process.exit(2);
    }
  }
  return out;
}

function log(line) {
  console.log(line);
}

/** 一次性快照（只含最小可比较内容，不含任何凭据） */
function sampleSnapshot(id) {
  return {
    id,
    createdAt: new Date().toISOString(),
    manifest: {
      schemaVersion: 1,
      dshVersion: '0.25.0',
      platform: process.platform,
      sectionIds: ['settings'],
      containsSecrets: false,
    },
    sections: {
      settings: {
        version: 1,
        namespaces: { general: { value: { theme: 'dark', marker: id }, revision: 1, secrets: [] } },
      },
    },
  };
}

/** 与 s3-transport.ts 的 defaultRequest 同口径（经 utils/proxy 的出站实现，代理感知）。 */
async function wireRequest(method, url, options = {}) {
  const headers = { 'User-Agent': 'DSH-Config-Manager (S3 Client / oss-live-check)', ...(options.headers ?? {}) };
  if (options.body === undefined) {
    delete headers['Content-Length'];
    delete headers['content-length'];
  }
  const res = await requestOnce({
    method,
    url,
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
  });
  const responseHeaders = {};
  res.headers.forEach((value, key) => { responseHeaders[key] = value; });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: responseHeaders, text: async () => res.body.toString('utf8') };
}

/** 记录每个出站请求（不回显任何头/密钥） */
function traced(request, trace) {
  return async (method, url, options = {}) => {
    const started = Date.now();
    try {
      const res = await request(method, url, options);
      trace.push({ method, url, status: res.status, ms: Date.now() - started });
      return res;
    } catch (err) {
      trace.push({ method, url, status: 0, ms: Date.now() - started, error: String(err && err.message ? err.message : err) });
      throw err;
    }
  };
}

async function runSteps(transport, { write, id }) {
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const value = await fn();
      log('  ✓ ' + name + '（' + (Date.now() - t0) + 'ms）');
      return value;
    } catch (err) {
      log('  ✗ ' + name + '：' + String(err && err.message ? err.message : err));
      throw err;
    }
  };

  await step('探桶（HEAD 桶 + GET 索引）', async () => {
    const probe = await transport.probe();
    log('      远端现有快照：' + probe.snapshotCount + ' 个');
  });
  await step('列表', async () => {
    const list = await transport.list();
    log('      列表返回：' + list.length + ' 条');
  });
  if (!write) {
    log('  · 写操作已跳过（加 --write 才会真的上传 / 删除）');
    return;
  }
  await step('上传快照 ' + id, async () => {
    await transport.upload(sampleSnapshot(id));
  });
  await step('上传后列表必须含该快照', async () => {
    const list = await transport.list();
    if (!list.some((m) => m.id === id)) {
      throw new Error('列表里找不到刚上传的 ' + id + '，实得 [' + list.map((m) => m.id).join(', ') + ']');
    }
  });
  await step('下载并逐值比对', async () => {
    const snap = await transport.download(id);
    const got = snap && snap.sections && snap.sections.settings && snap.sections.settings.namespaces
      ? snap.sections.settings.namespaces.general.value : undefined;
    const want = sampleSnapshot(id).sections.settings.namespaces.general.value;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error('下载内容与上传不一致：' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
    }
  });
  await step('删除快照 ' + id, async () => {
    await transport.delete(id);
  });
  await step('删除后列表不得再含该快照', async () => {
    const list = await transport.list();
    if (list.some((m) => m.id === id)) throw new Error('删除后 ' + id + ' 仍在列表里');
  });
}

async function runLocal() {
  // 本地验签服务端在 127.0.0.1 上：强制直连，别把本地请求塞进代理
  process.env['DSH_CONFIG_MANAGER_PROXY'] = 'off';
  const cfg = {
    bucket: 'demo-bucket',
    region: 'cn-hangzhou',
    accessKeyId: 'LTAI5tOssLiveCheckLocalOnly',
    secretAccessKey: 'OssLiveCheck/Local+Secret00',
  };
  const mem = makeOssVerifyServer(cfg);
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v === undefined ? '' : v);
    }
    const url = 'http://127.0.0.1:' + port + (req.url || '/');
    // 服务端视角：只吃「收到的请求」；这里额外留一份规范串，失败时原样打印
    const verdict = verifyOssV4({ method: req.method || 'GET', url, headers, ...(body === '' ? {} : { body }) }, cfg);
    const out = await mem.request(req.method || 'GET', url, { headers, body });
    const text = await out.text();
    if (!verdict.ok) {
      log('    服务端拒绝：' + verdict.reason);
      log('    CanonicalRequest:');
      for (const line of verdict.canonicalRequest.split('\n')) log('      ' + line);
      log('    StringToSign:');
      for (const line of verdict.stringToSign.split('\n')) log('      ' + line);
    }
    res.writeHead(out.status, out.headers || {});
    res.end(text);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;

  const trace = [];
  const transport = new S3Transport({
    provider: 'oss',
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    credentials: { getSecretAccessKey: async () => cfg.secretAccessKey },
    endpoint: 'http://127.0.0.1:' + port,
    region: cfg.region,
    // 本地服务在 127.0.0.1，无法用 <bucket>.127.0.0.1 这种虚拟主机名 → path-style。
    // 现场真正失败的那条（虚拟主机风格）由 s3-transport.oss4-server.test.ts 覆盖。
    pathStyle: true,
    now: () => new Date(),
    request: traced(wireRequest, trace),
  });

  log('本地模式：内置验签服务端 http://127.0.0.1:' + port + '（无需密钥、无需联网、不碰任何桶）');
  const id = 'oss-live-check-local-' + Date.now();
  try {
    await runSteps(transport, { write: true, id });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return { trace, failed: mem.failed };
}

async function runLive({ write }) {
  const env = process.env;
  const missing = ['OSS_BUCKET', 'OSS_REGION', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error('真桶模式缺少环境变量：' + missing.join(', ') + '（--help 查看全部变量）');
    console.error('提示：只想本地自测就别加 --live，直接运行本脚本即可。');
    process.exit(2);
  }
  const bucket = env['OSS_BUCKET'];
  const region = env['OSS_REGION'];
  const accessKeyId = env['OSS_ACCESS_KEY_ID'];
  const secretAccessKey = env['OSS_ACCESS_KEY_SECRET'];
  const endpoint = env['OSS_ENDPOINT'] || 'https://oss-' + region + '.aliyuncs.com';
  const pathStyle = env['OSS_PATH_STYLE'] === '1';
  const prefix = env['OSS_PREFIX'] || 'dsh-config-manager';
  const trace = [];
  const transport = new S3Transport({
    provider: 'oss',
    bucket,
    accessKeyId,
    credentials: { getSecretAccessKey: async () => secretAccessKey },
    endpoint,
    region,
    prefix,
    ...(pathStyle ? { pathStyle: true } : {}),
    now: () => new Date(),
    request: traced(wireRequest, trace),
  });
  log('真桶模式：桶 ' + bucket + ' / region ' + region + ' / endpoint ' + endpoint
    + ' / ' + (pathStyle ? 'path-style' : '虚拟主机风格') + ' / 前缀 ' + prefix);
  const id = 'oss-live-check-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await runSteps(transport, { write, id });
  } catch (err) {
    log('');
    log('失败排查建议：');
    log('  ① 密钥是否属于这个桶所在的账号，且这个 RAM 用户对该桶有读（写需要写）权限；');
    log('  ② 桶名 / region / endpoint 三者要配同一区域（例如 cn-hangzhou 对应 oss-cn-hangzhou.aliyuncs.com）；');
    log('  ③ 报 403 时服务端响应体自带它算的 CanonicalRequest / StringToSign（本脚本会脱敏后打印）；');
    log('  ④ 勾过 path-style 就加 OSS_PATH_STYLE=1 再跑一次：勾与不勾是两条不同的规范路径。');
    throw err;
  }
  return { trace, failed: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(HELP);
    return 0;
  }
  const started = Date.now();
  log('');
  log('=== 阿里云 OSS4 签名自测（issue #109）===');
  const result = args.live ? await runLive({ write: args.write }) : await runLocal();
  const trace = result.trace;
  // 判定口径：签名失败 / 网络失败 / 401·403（鉴权被拒）/ 5xx（服务端错）才算不通；
  // 404 与 412 是协议内的正常答复（索引还不存在、条件写未命中），不构成失败。
  const blocking = trace.filter((t) => t.status === 0 || t.status === 401 || t.status === 403 || t.status >= 500);
  const ok = result.failed.length === 0 && blocking.length === 0;
  log('');
  log('请求流水（' + trace.length + ' 个）：');
  for (const t of trace) {
    const mark = t.status === 0 || t.status === 401 || t.status === 403 || t.status >= 500
      ? '✗'
      : t.status === 404 || t.status === 412 ? '·' : '✓';
    log('  ' + mark + ' ' + t.method + ' ' + t.url.replace(/\?.*$/, '') + ' → ' + (t.status || t.error));
  }
  if (trace.some((t) => t.status === 404)) {
    log('  （· = 协议内的「不存在」，例如远端还没有索引 / blob 索引，属正常）');
  }
  if (result.failed.length > 0) {
    log('');
    log('服务端验签失败 ' + result.failed.length + ' 次：' + result.failed.join(' | '));
  }
  log('');
  log(ok ? '结论：全部 ' + trace.length + ' 个请求被接受（签名有效）。' : '结论：有请求被拒，见上方流水。');
  log('耗时 ' + (Date.now() - started) + 'ms');
  return ok ? 0 : 1;
}

process.exitCode = await main();
