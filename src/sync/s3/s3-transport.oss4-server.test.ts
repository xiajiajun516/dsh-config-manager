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
