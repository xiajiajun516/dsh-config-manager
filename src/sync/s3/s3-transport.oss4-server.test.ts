/**
 * 阿里云 OSS **服务端视角**的签名校验测试（issue #109 第三道证据）。
 *
 * 已有的 sigv4.test.ts 证明「我们算出的签名 = 官方金标向量」，但那只覆盖签名函数本身；
 * 真机上失败的还有另一半：**我们发出去的请求，服务端会怎么重建规范请求**（寻址风格决定
 * bucket 在 Host 还是路径里、哪些头参与、查询串怎么拼、条件写头算不算签名）。
 * 这里用一个**独立实现**的服务端验签器（`oss4-verify.ts`，照官方 Go SDK 重写），
 * 把 S3Transport 的真实出站请求逐个验签：验不过就按 OSS 真实错误返回 403
 * SignatureDoesNotMatch，测试随即失败。
 *
 * 覆盖：虚拟主机风格（默认，不勾 path-style）下的 HEAD 桶 / GET 索引(404) / PUT 索引与快照 /
 * GET 快照 / DELETE —— 即「探测 → 上传 → 列表 → 下载 → 删除」整条同步链路。
 * 注意：这证明的是「与本仓库对官方算法的独立复现一致」；真桶连通性仍需带真实密钥跑一次
 * （见 scripts/oss-live-check.mjs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport } from './s3-transport.ts';
import type { S3RequestFn } from './s3-transport.ts';
import { makeOssVerifyServer } from './oss4-verify.ts';
import type { SyncSnapshot } from '../transport.ts';

const ACCESS_KEY_ID = 'LTAI5tExampleAccessKeyId';
const SECRET = 'ExampleSecretWith+Slash/AndMixedCase00';
const BUCKET = 'demo-bucket';
const REGION = 'cn-hangzhou';
const ENDPOINT = 'https://oss-cn-hangzhou.aliyuncs.com';
const NOW = new Date('2026-10-23T12:00:00.000Z'); // → 20261023T120000Z

const CFG = { bucket: BUCKET, region: REGION, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET };

function makeServer() {
  return makeOssVerifyServer(CFG);
}

function makeTransport(request: S3RequestFn): S3Transport {
  return new S3Transport({
    provider: 'oss',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    endpoint: ENDPOINT,
    region: REGION,
    // 刻意不设 pathStyle：现场就是「不勾 path-style」时才报 SignatureDoesNotMatch（issue #109）
    now: () => NOW,
    request,
  });
}

function sampleSnapshot(): SyncSnapshot {
  return {
    id: 'snap-oss-001',
    createdAt: '2026-10-23T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '0.25.0',
      platform: 'win32',
      sectionIds: ['settings'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
    },
  };
}

test('OSS 服务端视角验签：整条同步链路（探桶 / 索引 / 快照 / 删除）每个请求都签名有效', async () => {
  const server = makeServer();
  const transport = makeTransport(server.request);

  const probe = await transport.probe();
  assert.equal(probe.snapshotCount, 0, '全新远端 → 0 个快照');
  assert.deepEqual(server.failed, [], '探测阶段所有请求都必须通过服务端验签');

  await transport.upload(sampleSnapshot());
  assert.deepEqual(server.failed, [], '上传阶段所有请求都必须通过服务端验签（含条件写头）');
  assert.ok(server.objects.has('dsh-config-manager/snap-oss-001.json'), '快照对象落在 <prefix>/<id>.json');
  assert.ok(server.objects.has('dsh-config-manager/index.json'), '索引对象落在 <prefix>/index.json');

  const listed = await transport.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, 'snap-oss-001');

  const downloaded = await transport.download('snap-oss-001');
  const settings = (downloaded.sections as { settings: { namespaces: Record<string, { value: unknown }> } }).settings;
  assert.deepEqual(settings.namespaces['general']?.value, { theme: 'dark' }, '下载内容与上传逐值相同');

  await transport.delete('snap-oss-001');
  assert.deepEqual(await transport.list(), [], '删除后索引为空');

  assert.deepEqual(server.failed, [], '全链路零验签失败');
  assert.ok(server.verified.length >= 8, '至少要覆盖探测/索引读写/快照读写/删除，实际 ' + server.verified.length + ' 次');
});

test('OSS 服务端视角验签：Authorization 逐字形状（逗号后无空格、无附加头时省略 AdditionalHeaders）', async () => {
  const server = makeServer();
  const auths: string[] = [];
  const wrapped: S3RequestFn = async (method, url, opts = {}) => {
    const auth = (opts.headers ?? {})['authorization'];
    if (auth !== undefined) auths.push(auth);
    return await server.request(method, url, opts);
  };
  const transport = makeTransport(wrapped);
  await transport.probe();
  assert.ok(auths.length > 0);
  for (const auth of auths) {
    assert.match(
      auth,
      /^OSS4-HMAC-SHA256 Credential=[^,]+,Signature=[0-9a-f]{64}$/,
      '本链路无附加头 → 不得出现 AdditionalHeaders 段',
    );
    assert.ok(!auth.includes(', '), 'OSS 授权头逗号后不带空格（v0.1.80 的修复点）');
    assert.ok(!auth.includes(SECRET), '密钥绝不进授权头');
  }
  assert.deepEqual(server.failed, []);
});
test('OSS 服务端视角：首推全程不发 If-*（真机会回 400 0017-00000245），改用 x-oss-forbid-overwrite', async () => {
  const server = makeServer();
  const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  const wrapped: S3RequestFn = async (method, url, opts = {}) => {
    seen.push({ method, url, headers: { ...(opts.headers ?? {}) } });
    return await server.request(method, url, opts);
  };
  const transport = makeTransport(wrapped);

  await transport.probe();
  await transport.upload(sampleSnapshot());

  for (const req of seen) {
    assert.equal(req.headers['if-none-match'], undefined, '绝不发 If-None-Match：' + req.method + ' ' + req.url);
    assert.equal(req.headers['if-match'], undefined, '绝不发 If-Match：' + req.method + ' ' + req.url);
  }
  const indexPut = seen.find((r) => r.method === 'PUT' && r.url.endsWith('/index.json'));
  assert.ok(indexPut, '必须有一次索引 PUT');
  assert.equal(indexPut.headers['x-oss-forbid-overwrite'], 'true', 'OSS 只能靠 forbid-overwrite 防并发首推');
  assert.deepEqual(server.failed, [], '换头之后仍必须逐请求验签通过');
});

test('OSS 服务端视角：验签器照真机拒 If-*（自证盲点回归）', async () => {
  // 这条用例保护的**不是**我们的代码，而是测试替身本身：如果验签器又「自己实现了 if-none-match」，
  // 那 §issue #109 的「14 个请求零失败」就会重演 —— 本地全绿、真机 400。所以这里刻意注入一个
  // If-None-Match（该头不进 OSS4 签名，故签名依旧有效），断言服务端按真机语义拒绝。
  const server = makeServer();
  const wrapped: S3RequestFn = async (method, url, opts = {}) => {
    if (method === 'PUT' && url.endsWith('/index.json')) {
      return await server.request(method, url, { ...opts, headers: { ...(opts.headers ?? {}), 'if-none-match': '*' } });
    }
    return await server.request(method, url, opts);
  };
  const transport = makeTransport(wrapped);

  await assert.rejects(
    () => transport.upload(sampleSnapshot()),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /implies functionality that is not implemented/, '真机报文原文');
      assert.match(message, /If-None-Match/, 'OSS 会回显被拒的头名');
      assert.match(message, /0017-00000245/, '错误码同现场反馈');
      return true;
    },
  );
  assert.deepEqual(server.failed, [], '签名本身仍然有效 —— 拒的是 API 语义，不是签名');
  assert.ok(!server.objects.has('dsh-config-manager/index.json'), '被拒的索引 PUT 不得落对象');
});
