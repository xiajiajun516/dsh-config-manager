/**
 * 手写 SigV4 签名（AWS SigV4 / 阿里云 OSS4），零第三方依赖（node:crypto 足够）。
 *
 * 为什么手写：竞品 \`@dickpy/dsh-cloud-sync\` v0.20.9（零依赖、lib 2610 行）证明五家 S3 兼容
 * 对象存储共用同一套「派生密钥 → 规范化请求 → 待签字符串 → HMAC」流程，差异只在**方言参数**：
 *  - AWS S3 / MinIO / 腾讯云 COS / 七牛 Kodo：\`AWS4-HMAC-SHA256\` + \`x-amz-date\` +
 *    \`x-amz-content-sha256\`（载荷 SHA-256 十六进制）+ scope 终止符 \`aws4_request\`，
 *    授权头里用 \`SignedHeaders=host;x-amz-date;...\`（**全部**已发头参与规范化）；
 *  - 阿里云 OSS：\`OSS4-HMAC-SHA256\` + \`x-oss-date\` + \`x-oss-content-sha256: UNSIGNED-PAYLOAD\`
 *    + 派生密钥前缀 \`aliyun_v4\` + 终止符 \`aliyun_v4_request\`，授权头里用
 *    \`AdditionalHeaders=<可选头>\`，且**只有** \`content-type\`/\`content-md5\`/\`x-oss-*\` 参与规范化头
 *    （\`host\` 默认不参与）。依据 = 阿里云《在 Header 中包含 V4 签名》+ 官方 SDK
 *    \`aliyun-oss-java-sdk\` 的 \`OSSV4Signer\`（2026-10 读码确证）。
 *  因此本文件把「同一实现 + 方言参数表」落成 \`SigV4Dialect\`：新增同类厂商只加一行参数。
 *
 * 纪律：
 *  - 纯函数 + 可注入时间（\`now\`），同一输入两次签名**逐字相同**（单测钉住）；
 *  - secretAccessKey 只在内存里参与 HMAC，绝不写入返回值之外的任何地方，也绝不进日志；
 *  - 不做任何 I/O：请求头的注入与发送由通道层（s3-transport）负责。
 */
import { createHash, createHmac } from 'node:crypto';

import { s3Msg } from './messages.ts';

/** 签名方言：AWS SigV4 与阿里云 OSS4 共用一套流程，差异全部收敛在这里。 */
export type SigV4DialectId = 'aws4' | 'oss4';

/** 「不校验载荷」的载荷哈希字面量（OSS4 目前只支持该取值）。 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** 规范化头集合的选择口径。 */
export type SigV4HeaderSelection =
  /** 全部将发送的头都参与规范化（AWS SigV4） */
  | 'all'
  /** 只有 content-type/content-md5 与 x-oss-* 前缀头（+ 显式附加头）参与（阿里云 OSS4） */
  | 'oss-default';

export interface SigV4Dialect {
  id: SigV4DialectId;
  /** 待签字符串第一行 / 授权头前缀，如 AWS4-HMAC-SHA256 */
  algorithm: string;
  /** 携带签名时刻的头名（x-amz-date / x-oss-date） */
  dateHeader: string;
  /** 携带载荷哈希的头名（x-amz-content-sha256 / x-oss-content-sha256） */
  contentShaHeader: string;
  /** 派生密钥第一层的密钥前缀（AWS4 / aliyun_v4） */
  secretKeyPrefix: string;
  /** scope 末段与派生密钥最后一层的字面量（aws4_request / aliyun_v4_request） */
  terminator: string;
  headerSelection: SigV4HeaderSelection;
  /** 载荷哈希形态：sha256 = 真实 SHA-256 十六进制；unsigned = UNSIGNED-PAYLOAD */
  payloadHash: 'sha256' | 'unsigned';
  /** 授权头里头清单的字段名（SignedHeaders / AdditionalHeaders） */
  headerListLabel: 'SignedHeaders' | 'AdditionalHeaders';
}

/** AWS SigV4（S3 / MinIO / COS / Kodo 共用）。 */
export const AWS_SIG_V4: SigV4Dialect = {
  id: 'aws4',
  algorithm: 'AWS4-HMAC-SHA256',
  dateHeader: 'x-amz-date',
  contentShaHeader: 'x-amz-content-sha256',
  secretKeyPrefix: 'AWS4',
  terminator: 'aws4_request',
  headerSelection: 'all',
  payloadHash: 'sha256',
  headerListLabel: 'SignedHeaders',
};

/** 阿里云 OSS4（OSS 原生 V4；与 AWS 同构但头名/前缀/终止符/载荷形态不同）。 */
export const OSS_SIG_V4: SigV4Dialect = {
  id: 'oss4',
  algorithm: 'OSS4-HMAC-SHA256',
  dateHeader: 'x-oss-date',
  contentShaHeader: 'x-oss-content-sha256',
  secretKeyPrefix: 'aliyun_v4',
  terminator: 'aliyun_v4_request',
  headerSelection: 'oss-default',
  payloadHash: 'unsigned',
  headerListLabel: 'AdditionalHeaders',
};

/** 方言查表（非法 id 抛错：绝不静默回落成 AWS，否则 OSS 会以「签名不对」的形式失败）。 */
export function sigV4Dialect(id: SigV4DialectId): SigV4Dialect {
  if (id === 'aws4') return AWS_SIG_V4;
  if (id === 'oss4') return OSS_SIG_V4;
  throw new Error(s3Msg('sync.s3.unknownSignatureDialect', { id: String(id) }));
}

/** SHA-256 十六进制小写。 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** HMAC-SHA256（返回 Buffer，供逐层派生密钥）。 */
export function hmacSha256(key: string | Uint8Array, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * 逐层派生签名密钥：prefix+secret → date → region → service → terminator（RFC/厂商文档同构）。
 * AWS：AWS4+SK → dateStamp → region → service → aws4_request；
 * OSS：aliyun_v4+SK → dateStamp → region → oss → aliyun_v4_request。
 */
export function deriveSigningKey(params: {
  secretAccessKey: string;
  dateStamp: string;
  region: string;
  service: string;
  dialect: SigV4Dialect;
}): Buffer {
  const kDate = hmacSha256(params.dialect.secretKeyPrefix + params.secretAccessKey, params.dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  return hmacSha256(kService, params.dialect.terminator);
}

/** 签名时刻格式 \`YYYYMMDDTHHMMSSZ\`（UTC）。 */
export function formatAmzDate(date: Date): string {
  const iso = date.toISOString(); // 2026-10-05T01:49:10.000Z
  const datePart = iso.slice(0, 10).split('-').join('');
  const timePart = iso.slice(11, 19).split(':').join('');
  return datePart + 'T' + timePart + 'Z';
}

/** 签名日期段 \`YYYYMMDD\`（UTC）。 */
export function formatDateStamp(amzDate: string): string {
  return amzDate.slice(0, 8);
}

/**
 * URI 编码（RFC 3986 未保留字符集 A-Za-z0-9-_.~ 之外一律 %XX 大写）。
 * \`encodeSlash=false\` 时保留路径分隔符（规范化 URI 用），其余场景（查询串）编码它。
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    const unreserved = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || ch === '-' || ch === '_' || ch === '.' || ch === '~';
    if (unreserved) out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** 安全百分号解码（非法转义原样返回，绝不抛错）。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 规范化 URI：先解码再逐段编码（避免 URL 归一化后的二次编码），保留分隔符。 */
export function canonicalUri(pathname: string): string {
  const path = pathname === '' ? '/' : pathname;
  return path.split('/').map((seg) => uriEncode(safeDecode(seg), true)).join('/');
}

/** 规范化查询串：按「编码后的键、编码后的值」字典序排序，空值写成 \`key=\`。 */
export function canonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const [rawKey, rawValue] of searchParams) {
    pairs.push({ key: uriEncode(rawKey, true), value: uriEncode(rawValue, true) });
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)));
  return pairs.map((p) => p.key + '=' + p.value).join('&');
}

/** 头值归一：去首尾空白 + 内部连续空白折叠成单空格（SigV4 要求）。 */
function trimHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 该头是否按方言参与规范化头集合。 */
function participates(name: string, dialect: SigV4Dialect, additional: readonly string[]): boolean {
  if (dialect.headerSelection === 'all') return true;
  // OSS4：content-type / content-md5 / x-oss-* 默认参与；其余必须是显式附加头
  return name === 'content-type' || name === 'content-md5' || name.startsWith('x-oss-') || additional.includes(name);
}

export interface SigV4RequestInput {
  method: string;
  /** 完整请求 URL（含 query；不带凭据） */
  url: string;
  /** 除 host/date/content-sha/authorization 之外要发送的头（键大小写不敏感） */
  headers?: Record<string, string>;
  /** 请求体（缺省 = 空体） */
  body?: string | Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  dialect: SigV4Dialect;
  /** 签名时刻（缺省 = 当前时间；测试注入固定值即可得到确定性签名） */
  now?: Date;
  /** 额外声明参与签名的头名（小写；OSS4 用于把 host/content-length 等显式拉进签名） */
  additionalSignedHeaders?: readonly string[];
  /**
   * 是否注入并签名 \`<contentShaHeader>\`（缺省 true = S3 系必需）。
   *
   * 为什么留一个开关：SigV4 规范里该头对**非** S3 的 AWS 服务并非必需（AWS 官方
   * sig-v4-test-suite 的 get-vanilla 请求就只带 host + x-amz-date），而少数自建 S3 网关/前置
   * 代理会对不认识的 x-amz-* 头直接 400 —— 关掉它即可用同一份实现对接这类端点。
   */
  includeContentShaHeader?: boolean;
}

export interface SigV4RequestOutput {
  /** 需要注入请求的全部头（含 host / date / content-sha / authorization） */
  headers: Record<string, string>;
  authorization: string;
  canonicalRequest: string;
  stringToSign: string;
  credentialScope: string;
  signature: string;
  /** 参与签名的头名（小写、字典序、分号分隔） */
  signedHeaders: string;
  /** 载荷哈希头取值（sha256 十六进制 或 UNSIGNED-PAYLOAD） */
  payloadHash: string;
}

/**
 * 计算一次请求的 SigV4 签名并返回待注入的头。
 * 幂等且无副作用：同一输入（含同一 now）两次调用逐字相同。
 */
export function signRequest(input: SigV4RequestInput): SigV4RequestOutput {
  const dialect = input.dialect;
  const url = new URL(input.url);
  const amzDate = formatAmzDate(input.now ?? new Date());
  const dateStamp = formatDateStamp(amzDate);
  const payloadHash = dialect.payloadHash === 'unsigned'
    ? UNSIGNED_PAYLOAD
    : sha256Hex(input.body ?? new Uint8Array(0));

  const additional = (input.additionalSignedHeaders ?? []).map((h) => h.toLowerCase());
  const all: Record<string, string> = { host: url.host };
  for (const [key, value] of Object.entries(input.headers ?? {})) all[key.toLowerCase()] = value;
  all[dialect.dateHeader] = amzDate;
  if (input.includeContentShaHeader !== false) all[dialect.contentShaHeader] = payloadHash;

  const names = Object.keys(all).filter((n) => participates(n, dialect, additional)).sort();
  const canonicalHeaderBlock = names.map((n) => n + ':' + trimHeaderValue(all[n] ?? '') + '\n').join('');
  // AWS：SignedHeaders = 参与规范化的全部头；OSS4：AdditionalHeaders = 仅显式附加的可选头
  const headerList = dialect.headerSelection === 'all'
    ? names.join(';')
    : additional.filter((n) => names.includes(n)).sort().join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaderBlock,
    headerList,
    payloadHash,
  ].join('\n');

  const credentialScope = [dateStamp, input.region, input.service, dialect.terminator].join('/');
  const stringToSign = [dialect.algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey({
    secretAccessKey: input.secretAccessKey,
    dateStamp,
    region: input.region,
    service: input.service,
    dialect,
  });
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = dialect.algorithm + ' Credential=' + input.accessKeyId + '/' + credentialScope
    + ', ' + dialect.headerListLabel + '=' + headerList + ', Signature=' + signature;

  return {
    headers: { ...all, authorization },
    authorization,
    canonicalRequest,
    stringToSign,
    credentialScope,
    signature,
    signedHeaders: headerList,
    payloadHash,
  };
}
