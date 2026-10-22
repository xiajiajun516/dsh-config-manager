/**
 * S3 兼容系通道测试（TDD 验收判据）：
 * - 远端布局 <prefix>/index.json + <prefix>/<id>.json + <prefix>/blobs/<hash> + blobs-index.json
 * - list / upload / download / delete 契约（同 id 覆盖、不存在必抛、删除不存在视为成功）
 * - 五家变体共用同一实现（只差 endpoint / region / 寻址风格 / 签名方言）
 * - 每次请求都带 SigV4 头，且密钥**不进错误消息**（脱敏）
 * - 内容寻址 blob：命中即零传输、缺 blob 硬失败、GC 只删无人引用且超保护窗的
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport, S3TransportError } from './s3-transport.ts';
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts';
import { S3_PROVIDER_VARIANTS, resolveS3Target, objectUrl, normalizeObjectPrefix, s3ProviderList } from './s3-providers.ts';
import { S3_COMPAT_PROVIDERS } from '../sync-config.ts';
import type { S3CompatProvider } from '../sync-config.ts';
import { computeSnapshotMeta, sectionsEqual, SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import type { SectionData, SectionId } from '../../schema/types.ts';
import { sha256Hex } from '../../utils/hashing.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const BUCKET = 'demo-bucket';

/**
 * 窄化到明文 sections：`SyncSnapshot['sections']` 是 `EncryptedSections | Partial<Record<...>>` 联合，
 * 测试夹具从不构造加密载荷，统一经这里取分区（避免在联合类型上直接访问 .settings/.sessions）。
 */
function plain(snapshot: SyncSnapshot): Partial<Record<SectionId, SectionData>> {
  return snapshot.sections as Partial<Record<SectionId, SectionData>>;
}

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-10-05T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers', 'sessions'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
      sessions: {
        version: 1,
        files: [{
          relativePath: 'proj/a.jsonl',
          data: new Uint8Array([1, 2, 3, 4]),
          contentHash: sha256Hex(new Uint8Array([1, 2, 3, 4])),
        }],
      },
    },
    ...overrides,
  };
}

interface RecordedCall {
  method: string;
  url: string;
  key: string;
  headers: Record<string, string>;
  body?: string;
}

/** 内存对象存储 mock：按寻址风格从 URL 还原对象键，记录每次调用 */
function makeStore(mode: 'path' | 'virtual') {
  const objects = new Map<string, string>();
  const calls: RecordedCall[] = [];
  const keyOf = (url: string): string => {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return mode === 'path' ? path.split('/').slice(1).join('/') : path;
  };
  const request: S3RequestFn = async (method, url, opts = {}) => {
    const key = keyOf(url);
    const headers = opts.headers ?? {};
    calls.push({ method, url, key, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) });
    if (method === 'GET') {
      const value = objects.get(key);
      return value === undefined ? res(404, '') : res(200, value);
    }
    if (method === 'PUT') {
      objects.set(key, opts.body ?? '');
      return res(200, '');
    }
    if (method === 'DELETE') {
      const existed = objects.delete(key);
      return res(existed ? 204 : 404, '');
    }
    return res(405, '');
  };
  return { objects, calls, request, keyOf };
}

function res(status: number, bodyText: string): S3Response {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

const FIXED_NOW = new Date('2026-10-05T01:49:10.000Z');

function makeOptions(store: ReturnType<typeof makeStore>, overrides: Partial<S3TransportOptions> = {}): S3TransportOptions {
  return {
    provider: 'minio',
    endpoint: 'https://minio.example.com:9000',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    pathStyle: true,
    request: store.request,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

/* ---------------- 构造校验 / 变体表 ---------------- */

test('构造：credentials / accessKeyId / bucket / region / endpoint 逐项校验（稳定错误码 → 字典键）', () => {
  const store = makeStore('path');
  assert.throws(
    () => new S3Transport(makeOptions(store, { credentials: null as never })),
    (err: unknown) => {
      assert.ok(err instanceof S3TransportError);
      assert.match(String((err as Error).message), /getSecretAccessKey/);
      return true;
    },
  );
  assert.throws(() => new S3Transport(makeOptions(store, { accessKeyId: '' })), /accessKeyId/);
  assert.throws(() => new S3Transport(makeOptions(store, { bucket: 'Bad_Bucket' })), /桶名|bucket/i);
  assert.throws(() => new S3Transport(makeOptions(store, { provider: 'oss' as S3CompatProvider, region: '', endpoint: '' })), /region/);
  assert.throws(() => new S3Transport(makeOptions(store, { endpoint: 'ftp://x.example.com' })), /endpoint/);
  assert.throws(() => new S3Transport(makeOptions(store, { prefix: '../evil' })), /前缀/);
});

test('五种变体共用同一实现：type / 方言 / 寻址风格 / 服务名全部由变体表决定', () => {
  const store = makeStore('path');
  assert.deepEqual([...S3_COMPAT_PROVIDERS], ['s3', 'oss', 'cos', 'minio', 'kodo']);
  assert.equal(s3ProviderList().length, 5);
  for (const provider of S3_COMPAT_PROVIDERS) {
    const variant = S3_PROVIDER_VARIANTS[provider];
    const t = new S3Transport(makeOptions(store, {
      provider,
      pathStyle: undefined,
      ...(provider === 'minio' ? { endpoint: 'https://minio.example.com:9000' } : { endpoint: undefined, region: undefined }),
      ...(provider === 'oss' ? { region: 'cn-hangzhou' } : {}),
      ...(provider === 'cos' ? { region: 'ap-guangzhou' } : {}),
      ...(provider === 'kodo' ? { region: 'cn-east-1' } : {}),
    }));
    assert.equal(t.type, provider, '通道类型必须如实标注变体 id');
    assert.equal(t.resolvedTarget.dialect.id, variant.dialectId, '方言必须取变体默认: ' + provider);
    assert.equal(t.resolvedTarget.pathStyle, variant.defaultPathStyle);
    assert.equal(t.resolvedTarget.service, variant.service);
    // 同一实现：五家的 list 都走 GET <prefix>/index.json（只有主机/路径风格不同）
    assert.ok(t instanceof S3Transport);
  }
});

test('端点与寻址风格：virtual-host（s3/oss/cos/kodo）与 path-style（minio）各自成形', () => {
  const virtual = resolveS3Target({ provider: 's3', bucket: BUCKET, region: 'us-east-1', prefix: 'dsh-config-manager' });
  assert.ok(virtual.ok);
  assert.equal(objectUrl(virtual.target, 'dsh-config-manager/index.json'),
    'https://demo-bucket.s3.us-east-1.amazonaws.com/dsh-config-manager/index.json');

  const oss = resolveS3Target({ provider: 'oss', bucket: BUCKET, region: 'cn-hangzhou' });
  assert.ok(oss.ok);
  assert.equal(objectUrl(oss.target, 'dsh-config-manager/index.json'),
    'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/dsh-config-manager/index.json');

  const cos = resolveS3Target({ provider: 'cos', bucket: BUCKET, region: 'ap-guangzhou' });
  assert.ok(cos.ok);
  assert.equal(cos.target.endpoint.host, 'cos.ap-guangzhou.myqcloud.com');
  assert.equal(cos.target.pathStyle, false, 'COS 2024 后新建桶只支持 virtual-host');

  const minio = resolveS3Target({ provider: 'minio', bucket: BUCKET, endpoint: 'https://minio.example.com:9000/s3' });
  assert.ok(minio.ok);
  assert.equal(objectUrl(minio.target, 'a/b.json'), 'https://minio.example.com:9000/s3/demo-bucket/a/b.json');

  // 自建网关：覆盖 endpoint + 强制 AWS 方言（同一份实现）
  const custom = resolveS3Target({ provider: 'oss', bucket: BUCKET, region: 'cn-hangzhou', endpoint: 'https://s3-gw.corp.local', dialectId: 'aws4', pathStyle: true });
  assert.ok(custom.ok);
  assert.equal(custom.target.dialect.id, 'aws4');
  assert.equal(custom.target.pathStyle, true);
});

test('前缀归一：缺省 / 去斜杠 / 空值回落默认', () => {
  assert.equal(normalizeObjectPrefix(undefined), 'dsh-config-manager');
  assert.equal(normalizeObjectPrefix('/a/b/'), 'a/b');
  assert.equal(normalizeObjectPrefix('   '), 'dsh-config-manager');
});

/* ---------------- list / upload / download / delete ---------------- */

test('list：index.json 缺失（404）→ 空列表；存在 → 按 createdAt 升序', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  assert.deepEqual(await t.list(), []);

  const metaB = computeSnapshotMeta(sampleSnapshot({ id: 'snap-b', createdAt: '2026-10-05T01:00:00.000Z' }));
  const metaA = computeSnapshotMeta(sampleSnapshot({ id: 'snap-a', createdAt: '2026-10-05T00:00:00.000Z' }));
  store.objects.set('dsh-config-manager/index.json', JSON.stringify([metaB, metaA]));
  const list = await t.list();
  assert.deepEqual(list.map((m) => m.id), ['snap-a', 'snap-b']);
});

test('upload → list → download 全链路：文件分区字节往返无损（base64 标记）', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  const snap = sampleSnapshot();
  const meta = await t.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  assert.equal(store.objects.has('dsh-config-manager/snap-001.json'), true);

  const listed = await t.list();
  assert.equal(listed.length, 1);
  assert.equal(sectionsEqual(listed[0]!, meta), true);

  const back = await t.download('snap-001');
  assert.deepEqual(plain(back).settings, plain(snap).settings);
  const sessions = plain(back).sessions as unknown as { version: 1; files: { relativePath: string; data: Uint8Array }[] };
  assert.equal(sessions.files[0]!.relativePath, 'proj/a.jsonl');
  assert.deepEqual(Array.from(sessions.files[0]!.data), [1, 2, 3, 4], '文件字节必须原样还原');
});

test('upload 幂等：同 id 且内容全等 → 零 PUT（只有一次读索引）', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  const snap = sampleSnapshot();
  await t.upload(snap);
  const before = store.calls.length;
  const again = await t.upload(snap);
  const after = store.calls.slice(before);
  assert.deepEqual(again, computeSnapshotMeta(snap));
  assert.equal(after.every((c) => c.method === 'GET'), true, '内容未变不得产生任何写请求: ' + JSON.stringify(after.map((c) => c.method + ' ' + c.key)));
  assert.equal(after.filter((c) => c.key.endsWith('index.json')).length, 1);
});

test('download：不存在的 id → notfound（契约），且错误分类可被上层分流', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  await assert.rejects(t.download('nope'), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.equal((err as SyncTransportError).kind, 'notfound');
    assert.equal((err as SyncTransportError).retryable, false);
    return true;
  });
});

test('delete：删对象 + 摘索引；对象与索引都没有 → 静默成功且不发写请求', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  await t.upload(sampleSnapshot());
  await t.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-10-05T02:00:00.000Z' }));
  await t.delete('snap-001');
  assert.equal(store.objects.has('dsh-config-manager/snap-001.json'), false);
  const list = await t.list();
  assert.deepEqual(list.map((m) => m.id), ['snap-002']);

  const before = store.calls.length;
  await t.delete('never-existed');
  const tail = store.calls.slice(before);
  assert.deepEqual(tail.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.key), ['DELETE dsh-config-manager/never-existed.json'], '只允许一次删除尝试');
  assert.equal(tail.some((c) => c.method === 'PUT'), false, '索引里本就没有该 id → 不得再写索引');
});

/* ---------------- SigV4 注入 / 密钥纪律 ---------------- */

test('每次请求都注入 SigV4 头；同一固定的签名时刻 → 签名可复现', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  await t.list();
  const call = store.calls[0]!;
  assert.equal(call.headers['x-amz-date'], '20261005T014910Z');
  assert.equal(call.headers['x-amz-content-sha256'], sha256Hex(''));
  assert.match(call.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261005\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);

  const store2 = makeStore('path');
  const t2 = new S3Transport(makeOptions(store2));
  await t2.list();
  assert.equal(store2.calls[0]!.headers['authorization'], call.headers['authorization'], '同一输入两次签名必须逐字一致');
});

test('阿里云 OSS 变体：请求头走 OSS4（x-oss-date / x-oss-content-sha256:UNSIGNED-PAYLOAD）', async () => {
  const store = makeStore('virtual');
  const t = new S3Transport(makeOptions(store, { provider: 'oss', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', pathStyle: undefined }));
  await t.list();
  const call = store.calls[0]!;
  assert.equal(call.url, 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/dsh-config-manager/index.json');
  assert.equal(call.headers['x-oss-date'], '20261005T014910Z');
  assert.equal(call.headers['x-oss-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.equal(call.headers['x-amz-date'], undefined);
  // 官方 SDK 格式：无空格、空 AdditionalHeaders 省略（issue #109：写成 ", AdditionalHeaders=, Signature=" 会被 OSS 拒绝）
  assert.match(call.headers['authorization'] ?? '', /^OSS4-HMAC-SHA256 Credential=.*\/cn-hangzhou\/oss\/aliyun_v4_request,Signature=[a-f0-9]{64}$/);
});

test('密钥纪律：错误消息里的响应体被脱敏（密钥绝不出现），且目标对象不含任何密钥', async () => {
  const leaked = 'secret=' + SECRET + '&also=' + encodeURIComponent(SECRET);
  const request: S3RequestFn = async () => res(500, leaked);
  const t = new S3Transport(makeOptions(makeStore('path'), { request }));
  await assert.rejects(t.list(), (err: unknown) => {
    const message = String((err as Error).message);
    assert.equal(message.includes(SECRET), false, '密钥绝不能出现在错误消息里');
    assert.equal(message.includes(encodeURIComponent(SECRET)), false);
    assert.match(message, /\[REDACTED\]/);
    assert.equal((err as SyncTransportError).kind, 'server');
    assert.equal((err as SyncTransportError).retryable, true);
    return true;
  });
  const target = t.resolvedTarget;
  assert.equal(JSON.stringify(target).includes(SECRET), false, '解析后的目标里不得有任何密钥');
  assert.equal(JSON.stringify(target).includes(ACCESS_KEY_ID), false, 'AccessKey ID 也不进目标对象（只在签名时用）');
});

test('网络错误/超时归一：注入超时 → kind=timeout 可重试', async () => {
  const store = makeStore('path');
  const timeoutRequest: S3RequestFn = async () => {
    const err = new Error('Request timed out after 100ms');
    err.name = 'TimeoutError';
    throw err;
  };
  const t = new S3Transport(makeOptions(store, { request: timeoutRequest, retry: { attempts: 1 } }));
  await assert.rejects(t.list(), (err: unknown) => {
    assert.equal((err as SyncTransportError).kind, 'timeout');
    assert.equal((err as SyncTransportError).retryable, true);
    return true;
  });
});

/* ---------------- 内容寻址 blob ---------------- */

test('blob 外置：会话分区落 <prefix>/blobs/<sha256>，快照里只留引用；download 还原字节', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  const snap = sampleSnapshot();
  await t.upload(snap);
  const sessions = plain(snap).sessions as unknown as { files: { data: Uint8Array }[] };
  const hash = sha256Hex(sessions.files[0]!.data);
  assert.equal(store.objects.has('dsh-config-manager/blobs/' + hash), true);
  assert.equal(store.objects.get('dsh-config-manager/blobs/' + hash), Buffer.from([1, 2, 3, 4]).toString('base64'));
  const storedSnapshot = store.objects.get('dsh-config-manager/snap-001.json') ?? '';
  assert.ok(storedSnapshot.includes('blobRefs'), '快照里必须是引用形态');
  assert.equal(storedSnapshot.includes('AQIDBA=='), false, '会话字节不得内联进快照');

  const back = await t.download('snap-001');
  const files = (plain(back).sessions as unknown as { files: { data: Uint8Array; contentHash: string }[] }).files;
  assert.deepEqual(Array.from(files[0]!.data), [1, 2, 3, 4]);
  assert.equal(files[0]!.contentHash, hash);
});

test('blob 去重：新快照带同一会话内容 → 不再 PUT blob（零传输）', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  await t.upload(sampleSnapshot());
  const sessions = (plain(sampleSnapshot()).sessions as unknown as { files: { data: Uint8Array }[] });
  const hash = sha256Hex(sessions.files[0]!.data);
  const before = store.calls.length;
  await t.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-10-05T03:00:00.000Z' }));
  const puts = store.calls.slice(before).filter((c) => c.method === 'PUT').map((c) => c.key).sort();
  assert.deepEqual(puts, ['dsh-config-manager/index.json', 'dsh-config-manager/snap-002.json'], '只写快照与索引，blob 已存在不再传');
  assert.equal(puts.some((k) => k === 'dsh-config-manager/blobs/' + hash), false);
});

test('blob 缺失 → 下载硬失败（绝不降级成空分区）', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  await t.upload(sampleSnapshot());
  for (const key of [...store.objects.keys()]) {
    if (key.startsWith('dsh-config-manager/blobs/')) store.objects.delete(key);
  }
  await assert.rejects(t.download('snap-001'), /blob 缺失|拒绝降级/);
});

test('blob GC：删除最后一份快照后回收超保护窗的无人引用 blob，并在用的一并保留', async () => {
  const store = makeStore('path');
  const t = new S3Transport(makeOptions(store));
  const data = new Uint8Array([9, 9, 9]);
  const hash = sha256Hex(data);
  const old = Date.now() - 11 * 60 * 1000;
  const meta = computeSnapshotMeta(sampleSnapshot({ id: 'old-snap' }));
  store.objects.set('dsh-config-manager/index.json', JSON.stringify([meta]));
  store.objects.set('dsh-config-manager/old-snap.json', JSON.stringify({
    id: 'old-snap',
    createdAt: '2026-10-05T00:00:00.000Z',
    manifest: meta.manifest,
    sections: { sessions: { version: 1, blobRefs: [{ relativePath: 'a.jsonl', blobHash: hash, sizeBytes: 3 }] } },
  }));
  store.objects.set('dsh-config-manager/blobs/' + hash, Buffer.from(data).toString('base64'));
  store.objects.set('dsh-config-manager/blobs-index.json', JSON.stringify({ [hash]: old }));

  await t.delete('old-snap');
  assert.equal(store.objects.has('dsh-config-manager/blobs/' + hash), false, '无人引用的旧 blob 必须被回收');
  assert.deepEqual(JSON.parse(store.objects.get('dsh-config-manager/blobs-index.json') ?? '{}'), {});
});
