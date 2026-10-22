/**
 * SigV4 签名单测：确定性（同输入两次逐字一致）+ 关键字段存在 + 官方测试向量。
 *
 * 官方向量 = AWS SigV4 test-suite 的 \`get-vanilla\`（GET / + host + x-amz-date，空体）：
 * 期望签名 5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31。
 * 该向量要求规范化请求、待签字符串与逐层派生密钥**全部**正确（签名是它们的函数），
 * 因此它是本实现最强的外部锚点（2026-10 用本机 node:crypto 手工逐层复核通过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

import {
  AWS_SIG_V4, OSS_SIG_V4, canonicalQueryString, canonicalUri, deriveSigningKey, formatAmzDate,
  hmacSha256, sha256Hex, sigV4Dialect, signRequest, uriEncode, UNSIGNED_PAYLOAD,
} from './sigv4.ts';

const NOW = new Date('2026-10-05T01:49:10.000Z');

function awsInput(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    url: 'https://s3.us-east-1.amazonaws.com/demo-bucket/dsh-config-manager/index.json',
    headers: { 'content-type': 'application/json' },
    body: '',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    dialect: AWS_SIG_V4,
    now: NOW,
    ...overrides,
  } as Parameters<typeof signRequest>[0];
}

test('确定性：同一输入两次签名逐字一致（含全部头与中间串）', () => {
  const a = signRequest(awsInput());
  const b = signRequest(awsInput());
  assert.deepEqual(a.headers, b.headers);
  assert.equal(a.authorization, b.authorization);
  assert.equal(a.canonicalRequest, b.canonicalRequest);
  assert.equal(a.stringToSign, b.stringToSign);
  assert.equal(a.signature, b.signature);
  assert.match(a.signature, /^[a-f0-9]{64}$/);
});

test('关键字段存在：x-amz-date / x-amz-content-sha256 / authorization 三段齐全', () => {
  const out = signRequest(awsInput());
  assert.equal(out.headers['x-amz-date'], '20261005T014910Z');
  assert.equal(out.headers['x-amz-content-sha256'], sha256Hex(''));
  assert.equal(out.headers['host'], 's3.us-east-1.amazonaws.com');
  assert.match(out.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261005\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.equal(out.credentialScope, '20261005/us-east-1/s3/aws4_request');
  // 待签字符串四行结构与授权头签名段一致
  assert.equal(out.stringToSign.split('\n')[0], 'AWS4-HMAC-SHA256');
  assert.equal(out.stringToSign.split('\n')[2], out.credentialScope);
  assert.equal(out.stringToSign.split('\n')[3], sha256Hex(out.canonicalRequest));
  assert.ok(out.authorization.endsWith('Signature=' + out.signature));
});

/** 官方 get-vanilla 向量（该请求只带 host + x-amz-date，故关掉 content-sha 头）。 */
test('官方向量 get-vanilla：签名与 AWS SigV4 test-suite 逐字一致', () => {
  const out = signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: {},
    body: '',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    dialect: AWS_SIG_V4,
    now: new Date('2015-08-30T12:36:00.000Z'),
    includeContentShaHeader: false,
  });
  assert.equal(out.headers['x-amz-date'], '20150830T123600Z');
  assert.equal(
    out.signature,
    '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    '官方向量不匹配 → 规范化请求 / 派生密钥链有偏差',
  );
  assert.equal(out.signedHeaders, 'host;x-amz-date');
  assert.equal(
    out.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('载荷哈希：非空 body 取真实 SHA-256 十六进制（PUT 场景）', () => {
  const body = '{"hello":"世界"}';
  const out = signRequest(awsInput({ method: 'PUT', body }));
  assert.equal(out.headers['x-amz-content-sha256'], sha256Hex(body));
  assert.ok(out.canonicalRequest.endsWith('\n' + sha256Hex(body)));
  // 空体与「缺省 body」等价（绝不当成 undefined 拼进规范化请求）
  assert.equal(signRequest(awsInput({ body: undefined })).payloadHash, sha256Hex(''));
});

test('规范化请求字节布局：逐字等于按 AWS 规范手写的期望（含 content-sha 与自定义头）', () => {
  const body = '{"a":1}';
  const out = signRequest(awsInput({ method: 'PUT', body, headers: { 'content-type': 'application/json', 'x-amz-meta-note': 'a  b' } }));
  const emptyHash = sha256Hex(body);
  const expected = [
    'PUT',
    '/demo-bucket/dsh-config-manager/index.json',
    '',
    'content-type:application/json',
    'host:s3.us-east-1.amazonaws.com',
    'x-amz-content-sha256:' + emptyHash,
    'x-amz-date:20261005T014910Z',
    'x-amz-meta-note:a b',
    '',
    'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-note',
    emptyHash,
  ].join('\n');
  assert.equal(out.canonicalRequest, expected, '规范化请求必须逐字一致（头排序、头值折叠空白、末尾空行）');
  // 同一期望串独立算一遍签名（不依赖 signRequest 的内部拼装）
  const key = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', 'AWS4' + 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY').update('20261005').digest()).update('us-east-1').digest()).update('s3').digest()).update('aws4_request').digest();
  const stringToSign = ['AWS4-HMAC-SHA256', '20261005T014910Z', '20261005/us-east-1/s3/aws4_request', sha256Hex(expected)].join('\n');
  const expectedSig = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  assert.equal(out.signature, expectedSig);
});

test('派生密钥链：与独立逐层 HMAC 重算一致（AWS 前缀 AWS4 / OSS 前缀 aliyun_v4）', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const aws = deriveSigningKey({ secretAccessKey: secret, dateStamp: '20261005', region: 'us-east-1', service: 's3', dialect: AWS_SIG_V4 });
  const kDate = createHmac('sha256', 'AWS4' + secret).update('20261005').digest();
  const kRegion = createHmac('sha256', kDate).update('us-east-1').digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const expected = createHmac('sha256', kService).update('aws4_request').digest();
  assert.deepEqual(aws, expected);

  const oss = deriveSigningKey({ secretAccessKey: secret, dateStamp: '20261005', region: 'cn-hangzhou', service: 'oss', dialect: OSS_SIG_V4 });
  const oDate = createHmac('sha256', 'aliyun_v4' + secret).update('20261005').digest();
  const oRegion = createHmac('sha256', oDate).update('cn-hangzhou').digest();
  const oService = createHmac('sha256', oRegion).update('oss').digest();
  const oExpected = createHmac('sha256', oService).update('aliyun_v4_request').digest();
  assert.deepEqual(oss, oExpected);
  assert.ok(!aws.equals(oss), '两种方言的派生密钥必须不同');
});

test('OSS4 方言：algorithm/头名/UNSIGNED-PAYLOAD/AdditionalHeaders/scope 终止符全部按阿里云 V4', () => {
  const out = signRequest({
    method: 'PUT',
    url: 'https://examplebucket.oss-cn-hangzhou.aliyuncs.com/dsh-config-manager/snap-001.json',
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}',
    accessKeyId: 'LTAIEXAMPLE',
    secretAccessKey: 'yourAccessKeySecret',
    region: 'cn-hangzhou',
    service: 'oss',
    dialect: OSS_SIG_V4,
    now: NOW,
  });
  assert.equal(out.headers['x-oss-date'], '20261005T014910Z');
  assert.equal(out.headers['x-oss-content-sha256'], UNSIGNED_PAYLOAD, 'OSS4 只支持 UNSIGNED-PAYLOAD');
  assert.equal(out.headers['x-amz-date'], undefined, 'OSS4 不得出现 AWS 头名');
  assert.equal(out.credentialScope, '20261005/cn-hangzhou/oss/aliyun_v4_request');
  // 官方 Go/PHP SDK 的格式：逗号后无空格，AdditionalHeaders 为空时整段省略（issue #109）
  assert.match(out.authorization, /^OSS4-HMAC-SHA256 Credential=LTAIEXAMPLE\/20261005\/cn-hangzhou\/oss\/aliyun_v4_request,Signature=[a-f0-9]{64}$/);
  assert.equal(out.authorization.includes(', '), false, 'OSS4 授权头不得有逗号后的空格');
  assert.equal(out.authorization.includes('AdditionalHeaders='), false, '没有附加头时不得写空的 AdditionalHeaders=');
  assert.equal(out.stringToSign.split('\n')[0], 'OSS4-HMAC-SHA256');
  // 规范化头只含 content-type 与 x-oss-*（host 默认不参与）
  assert.equal(out.canonicalRequest.split('\n')[3], 'content-type:application/json');
  assert.equal(out.canonicalRequest.split('\n')[4], 'x-oss-content-sha256:UNSIGNED-PAYLOAD');
  assert.ok(!out.canonicalRequest.includes('host:'), 'OSS4 默认不把 host 拉进规范化头');
  assert.equal(out.signedHeaders, '');
});

test('OSS4 方言：显式声明 host 时才把 host 拉进签名（与 SDK 的 additionalSignedHeaders 同口径）', () => {
  const base = {
    method: 'GET',
    url: 'https://oss-cn-hangzhou.aliyuncs.com/examplebucket/x',
    headers: { 'content-type': 'application/json' },
    body: '',
    accessKeyId: 'LTAIEXAMPLE',
    secretAccessKey: 'yourAccessKeySecret',
    region: 'cn-hangzhou',
    service: 'oss',
    dialect: OSS_SIG_V4,
    now: NOW,
  } as const;
  const withHost = signRequest({ ...base, additionalSignedHeaders: ['host'] });
  assert.equal(withHost.signedHeaders, 'host');
  assert.ok(withHost.canonicalRequest.includes('host:oss-cn-hangzhou.aliyuncs.com'));
  const withoutHost = signRequest({ ...base });
  assert.notEqual(withHost.signature, withoutHost.signature, '头集合变化必须改变签名');
});

test('时间格式：formatAmzDate / formatDateStamp 为 UTC 紧致格式', () => {
  assert.equal(formatAmzDate(new Date('2026-01-02T03:04:05.999Z')), '20260102T030405Z');
  assert.equal(formatAmzDate(new Date('2026-12-31T23:59:59.000Z')), '20261231T235959Z');
});

test('uriEncode / canonicalUri：RFC3986 编码、保留路径分隔符、非 ASCII 走 UTF-8 字节', () => {
  assert.equal(uriEncode('a b/c~d-e_f.g', false), 'a%20b/c~d-e_f.g');
  assert.equal(uriEncode('a b/c', true), 'a%20b%2Fc');
  assert.equal(uriEncode("!'()*", true), '%21%27%28%29%2A');
  assert.equal(uriEncode('中文', true), '%E4%B8%AD%E6%96%87');
  assert.equal(canonicalUri('/dsh-config-manager/snap 1.json'), '/dsh-config-manager/snap%201.json');
  assert.equal(canonicalUri(''), '/');
  assert.equal(canonicalUri('/%E4%B8%AD%E6%96%87'), '/%E4%B8%AD%E6%96%87', '已编码路径不得二次编码');
});

test('canonicalQueryString：按编码后的键值字典序排序，空值写成 key=', () => {
  assert.equal(canonicalQueryString(new URLSearchParams('b=2&a=1')), 'a=1&b=2');
  assert.equal(canonicalQueryString(new URLSearchParams('prefix=z&max-keys=1&list-type=2')), 'list-type=2&max-keys=1&prefix=z');
  assert.equal(canonicalQueryString(new URLSearchParams('empty=&x=%2F')), 'empty=&x=%2F');
  assert.equal(canonicalQueryString(new URLSearchParams('')), '');
});

test('方言查表：aws4 / oss4 各归其位，未知 id 抛错（不静默回落）', () => {
  assert.equal(sigV4Dialect('aws4').algorithm, 'AWS4-HMAC-SHA256');
  assert.equal(sigV4Dialect('oss4').algorithm, 'OSS4-HMAC-SHA256');
  assert.throws(() => sigV4Dialect('nope' as never), /未知签名方言/);
});

test('hmacSha256：与 node:crypto 的等价性（派生链的地基）', () => {
  assert.equal(hmacSha256('key', 'data').toString('hex'), createHmac('sha256', 'key').update('data', 'utf8').digest('hex'));
  assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});
