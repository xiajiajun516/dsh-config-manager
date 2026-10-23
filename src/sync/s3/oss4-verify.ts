/**
 * 阿里云 OSS4 的**服务端视角验签器**（测试 / 联调用，不参与生产链路）。
 *
 * 为什么需要：`sigv4.ts` 只证明「我们算的签名 = 官方金标向量」，但真机失败还有另一半 ——
 * **发出去的请求，服务端会怎么重建规范请求**：bucket 在 Host 还是路径里、哪些头参与规范化、
 * 查询串空值怎么写、条件写头算不算进签名。这里照官方 Go SDK（`oss/conn.go` 的
 * `getResourceV4`、`oss/auth.go` 的 `getSubResource` / `getSignedStrV4`）**独立重写**一遍，
 * 只吃「收到的 HTTP 请求」（method / url / 头 / body），绝不复用客户端的签名中间量。
 *
 * 用法：`s3-transport.oss4-server.test.ts`（内存对象存储，逐请求验签）与
 * `scripts/oss-live-check.mjs`（真桶联调）。它证明的是「与本仓库对官方算法的独立复现一致」，
 * 不等于官方服务端盖章 —— 真桶连通性要靠带真实密钥跑一次脚本。
 */
import { createHash, createHmac } from 'node:crypto';

import type { S3RequestFn, S3Response } from './s3-transport.ts';

export interface Oss4VerifyConfig {
  bucket: string;
  region: string;
  /** AccessKeyId（非密钥；服务端要核对 Credential 里的这一串） */
  accessKeyId: string;
  /** AccessKey Secret（仅用于重算签名，绝不回显/入日志） */
  secretAccessKey: string;
}

export interface Oss4VerifyResult {
  ok: boolean;
  /** 失败原因（人类可读；成功时为空串） */
  reason: string;
  /** 服务端重建的规范请求（失败时回给客户端，模拟 OSS 回显 StringToSign） */
  canonicalRequest: string;
  stringToSign: string;
  /** 服务端算出的签名 */
  signature: string;
  /** 解码后的对象键（不含前导斜杠；桶级请求为空串） */
  objectKey: string;
  /** 是否桶级请求（无对象键） */
  bucketLevel: boolean;
}

/** 服务端口径的百分号编码：与 Go `url.QueryEscape` 对齐（只留 A-Za-z0-9-_.~），空格 %20。 */
export function ossEncode(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 服务端验签：重建规范请求 → 重算签名 → 与 Authorization 里的 Signature 逐字比较。 */
export function verifyOssV4(
  init: { method: string; url: string; headers: Record<string, string>; body?: string },
  cfg: Oss4VerifyConfig,
): Oss4VerifyResult {
  const headers = lower(init.headers);
  const fail = (reason: string, extra: Partial<Oss4VerifyResult> = {}): Oss4VerifyResult => ({
    ok: false, reason, canonicalRequest: '', stringToSign: '', signature: '', objectKey: '', bucketLevel: false, ...extra,
  });
  const auth = headers['authorization'] ?? '';
  const parsed = /^OSS4-HMAC-SHA256 Credential=([^,]+),(?:AdditionalHeaders=([^,]*),)?Signature=([0-9a-f]{64})$/.exec(auth);
  if (parsed === null) return fail('malformed Authorization header: ' + JSON.stringify(auth));
  const credential = parsed[1] as string;
  const additionalRaw = parsed[2];
  const givenSignature = parsed[3] as string;
  const slash = credential.indexOf('/');
  if (slash <= 0) return fail('Credential is missing its scope: ' + credential);
  const ak = credential.slice(0, slash);
  const scope = credential.slice(slash + 1);
  if (ak !== cfg.accessKeyId) return fail('AccessKeyId mismatch: ' + ak);

  const url = new URL(init.url);
  const host = headers['host'] ?? url.host;
  const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  // 寻址风格由服务端自己判：path-style 的首段就是 bucket；否则 bucket 在 Host 里（虚拟主机风格），
  // 路径只剩对象键 —— 两种情况下服务端算出的规范资源都是 /<bucket>/<key>。
  const pathStyle = segments[0] === cfg.bucket && !host.startsWith(`${cfg.bucket}.`);
  const objectSegments = pathStyle ? segments.slice(1) : segments;
  const objectKey = objectSegments.join('/');
  const bucketLevel = objectSegments.length === 0;
  const resource = '/' + cfg.bucket + '/' + objectSegments.map(ossEncode).join('/');

  const params: Array<{ key: string; value: string; empty: boolean }> = [];
  for (const [k, v] of url.searchParams) {
    params.push({ key: ossEncode(k), value: ossEncode(v), empty: v === '' });
  }
  params.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)));
  const subResource = params.map((p) => (p.empty ? p.key : `${p.key}=${p.value}`)).join('&');

  const additional = (additionalRaw ?? '').split(';').filter((s) => s !== '').map((s) => s.toLowerCase());
  const participates = (name: string): boolean =>
    name === 'content-type' || name === 'content-md5' || name.startsWith('x-oss-') || additional.includes(name);
  const names = Object.keys(headers)
    .filter((n) => n !== 'authorization' && n !== 'content-length' && participates(n))
    .sort();
  const headerBlock = names.map((n) => n + ':' + (headers[n] ?? '').trim().replace(/\s+/g, ' ') + '\n').join('');
  const additionalList = additional.slice().sort().join(';');

  const dateHeader = headers['x-oss-date'] ?? '';
  const payloadHash = headers['x-oss-content-sha256'] ?? (init.body === undefined ? '' : sha256(init.body));
  const canonicalRequest = [
    init.method.toUpperCase(),
    resource,
    subResource,
    headerBlock,
    additionalList,
    payloadHash,
  ].join('\n');
  const [dateStamp, scopeRegion, scopeService, terminator] = scope.split('/');
  if (dateStamp === undefined || scopeRegion !== cfg.region || scopeService !== 'oss' || terminator !== 'aliyun_v4_request') {
    return fail('scope mismatch: ' + scope, { canonicalRequest, objectKey, bucketLevel });
  }
  if (dateStamp !== dateHeader.slice(0, 8)) {
    return fail('x-oss-date does not match the scope date segment: ' + dateHeader + ' vs ' + scope, { canonicalRequest, objectKey, bucketLevel });
  }
  const stringToSign = ['OSS4-HMAC-SHA256', dateHeader, scope, sha256(canonicalRequest)].join('\n');
  const kDate = createHmac('sha256', 'aliyun_v4' + cfg.secretAccessKey).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(cfg.region, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update('oss', 'utf8').digest();
  const kSigning = createHmac('sha256', kService).update('aliyun_v4_request', 'utf8').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  if (signature !== givenSignature) {
    return fail('signature mismatch', { canonicalRequest, stringToSign, signature, objectKey, bucketLevel });
  }
  return { ok: true, reason: '', canonicalRequest, stringToSign, signature, objectKey, bucketLevel };
}

interface StoredObject {
  body: string;
  etag: string;
}

/**
 * 内存 OSS（验签通过才落盘/回读）：返回可直接注入 S3Transport 的 `request`，
 * 以及验签成功/失败流水，供测试与联调脚本断言。
 */
export function makeOssVerifyServer(cfg: Oss4VerifyConfig): {
  request: S3RequestFn;
  objects: Map<string, StoredObject>;
  verified: string[];
  failed: string[];
} {
  const objects = new Map<string, StoredObject>();
  const verified: string[] = [];
  const failed: string[] = [];
  const request: S3RequestFn = async (method, url, opts = {}) => {
    const headers = opts.headers ?? {};
    const v = verifyOssV4({ method, url, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) }, cfg);
    const respond = (status: number, body: string, extra: Record<string, string> = {}): S3Response => ({
      status,
      ok: status >= 200 && status < 300,
      headers: extra,
      text: async () => body,
    });
    if (!v.ok) {
      failed.push(v.reason);
      const xml = '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not '
        + 'match the signature you provided.</Message><StringToSign>' + v.stringToSign + '</StringToSign>'
        + '<CanonicalRequest>' + v.canonicalRequest + '</CanonicalRequest></Error>';
      return respond(403, xml);
    }
    verified.push(method + ' ' + url);
    if (v.bucketLevel) return respond(200, '');
    const key = v.objectKey;
    const h = lower(headers);
    const existing = objects.get(key);
    if (method === 'PUT') {
      const ifMatch = h['if-match'];
      const ifNoneMatch = h['if-none-match'];
      if (ifMatch !== undefined && existing !== undefined && ifMatch.replace(/"/g, '') !== existing.etag) {
        return respond(412, '<Error><Code>PreconditionFailed</Code></Error>');
      }
      if (ifNoneMatch === '*' && existing !== undefined) {
        return respond(412, '<Error><Code>PreconditionFailed</Code></Error>');
      }
      const body = opts.body ?? '';
      const etag = sha256(body).slice(0, 32);
      objects.set(key, { body, etag });
      return respond(200, '', { etag: '"' + etag + '"' });
    }
    if (method === 'HEAD') {
      return existing === undefined ? respond(404, '') : respond(200, '', { etag: '"' + existing.etag + '"' });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return respond(204, '');
    }
    if (existing === undefined) return respond(404, '<Error><Code>NoSuchKey</Code></Error>');
    return respond(200, existing.body, { etag: '"' + existing.etag + '"' });
  };
  return { request, objects, verified, failed };
}
