/**
 * S3 兼容系**变体表 + 目标解析 + 对象 URL**（一份实现覆盖五家）。
 *
 * 关键事实（竞品 \`@dickpy/dsh-cloud-sync\` v0.20.9 读码确证）：S3 / OSS / COS / MinIO / Kodo
 * 五家的差异**只有** endpoint、region、寻址风格（path-style vs virtual-host）与签名方言，
 * 协议与对象操作完全同构。于是「一份实现 + 变体表」而不是五份复制：
 *  - 变体表 → 变体默认值（\`S3_PROVIDER_VARIANTS\`）；
 *  - 每个变体可被用户显式覆盖（endpoint / region / pathStyle / dialectId）——
 *    自建网关（MinIO、Ceph、RGW、Akamai 等）都靠覆盖落到同一实现上。
 *
 * 方言依据：
 *  - AWS S3 / MinIO / COS / Kodo：AWS SigV4（\`AWS4-HMAC-SHA256\`，头名 x-amz-*）；
 *  - 阿里云 OSS：OSS4（\`OSS4-HMAC-SHA256\`，头名 x-oss-*、载荷 UNSIGNED-PAYLOAD，
 *    见阿里云《在 Header 中包含 V4 签名》+ 官方 \`OSSV4Signer\`）。
 * 说明：变体默认值是**按各方官方文档定的**，本批次未对真机端点做联网验证（写作用域与
 * 环境都不允许），因此每个默认都可被覆盖，且验证期报错会指向具体可改的配置项。
 */
import { sigV4Dialect, uriEncode } from './sigv4.ts';
import type { SigV4Dialect, SigV4DialectId } from './sigv4.ts';
import {
  S3_COMPAT_PROVIDERS, isS3CompatProvider, validateCloudBucket, validateCloudEndpoint,
  validateCloudPrefix, validateCloudRegion,
} from '../sync-config.ts';
import type { CloudConfigIssueCode, S3CompatProvider } from '../sync-config.ts';

/** 对象键默认前缀（所有通道共用；与 WebDAV 通道的集合名保持一致，便于跨通道迁移）。 */
export const S3_DEFAULT_PREFIX = 'dsh-config-manager';

/** S3 通道内的固定对象名。 */
export const S3_INDEX_FILE = 'index.json';
export const S3_BLOBS_SEG = 'blobs';
export const S3_BLOBS_INDEX_FILE = 'blobs-index.json';

export interface S3ProviderVariant {
  id: S3CompatProvider;
  /** 默认签名方言（可被 \`dialectId\` 覆盖） */
  dialectId: SigV4DialectId;
  /** SigV4 credential scope 里的服务名（s3 / oss） */
  service: string;
  /** 默认 region；缺省 = region 必填 */
  defaultRegion?: string;
  /** 端点模板（\`{region}\` 插值）；缺省 = endpoint 必填 */
  endpointTemplate?: string;
  /** 默认寻址风格：true = path-style（<endpoint>/<bucket>/<key>），false = virtual-host（<bucket>.<endpoint>/<key>） */
  defaultPathStyle: boolean;
  /**
   * 变体说明的**目录键**（自 t6 起字段是键而不是文案 —— 中文只存在于 `sync/s3/messages.ts` 的本地目录，
   * 经 `s3Msg` / `composeMsg(host, s3Msg)` 解析成当前语言；本字段本身不渲染）。
   */
  note: string;
}

/**
 * 五家变体表（\`Record<S3CompatProvider, …>\`：新增/漏写变体 typecheck 直接报错）。
 * 端点模板只是「填得省事」，任何一家都可以被 \`endpoint\` 覆盖（含端点带子路径的网关）。
 */
export const S3_PROVIDER_VARIANTS: Record<S3CompatProvider, S3ProviderVariant> = {
  s3: {
    id: 's3', dialectId: 'aws4', service: 's3', defaultRegion: 'us-east-1',
    endpointTemplate: 'https://s3.{region}.amazonaws.com', defaultPathStyle: false,
    note: 'sync.s3.providerNoteS3',
  },
  oss: {
    id: 'oss', dialectId: 'oss4', service: 'oss',
    endpointTemplate: 'https://oss-{region}.aliyuncs.com', defaultPathStyle: false,
    note: 'sync.s3.providerNoteOss',
  },
  cos: {
    id: 'cos', dialectId: 'aws4', service: 's3',
    endpointTemplate: 'https://cos.{region}.myqcloud.com', defaultPathStyle: false,
    note: 'sync.s3.providerNoteCos',
  },
  minio: {
    id: 'minio', dialectId: 'aws4', service: 's3', defaultRegion: 'us-east-1', defaultPathStyle: true,
    note: 'sync.s3.providerNoteMinio',
  },
  kodo: {
    id: 'kodo', dialectId: 'aws4', service: 's3',
    endpointTemplate: 'https://s3-{region}.qiniucs.com', defaultPathStyle: false,
    note: 'sync.s3.providerNoteKodo',
  },
};

/** 变体查表：非法通道 → undefined（调用方给 \`cloud.providerUnknown\` 码）。 */
export function s3ProviderVariant(provider: unknown): S3ProviderVariant | undefined {
  if (!isS3CompatProvider(provider)) return undefined;
  return S3_PROVIDER_VARIANTS[provider];
}

/** 变体清单（顺序 = 枚举顺序；供 UI 下拉/文档生成，避免再抄一遍五家名字）。 */
export function s3ProviderList(): readonly S3ProviderVariant[] {
  return S3_COMPAT_PROVIDERS.map((p) => S3_PROVIDER_VARIANTS[p]);
}

/** 对象键前缀归一：去首尾斜杠；空/缺省 → 默认前缀。 */
export function normalizeObjectPrefix(prefix?: string): string {
  if (prefix === undefined) return S3_DEFAULT_PREFIX;
  const cleaned = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned === '' ? S3_DEFAULT_PREFIX : cleaned;
}

/** 解析后的 S3 目标（签名与对象 URL 所需的全部事实）。 */
export interface S3Target {
  provider: S3CompatProvider;
  /** 端点（无尾斜杠；可能带子路径，如 https://gateway.example.com/s3） */
  endpoint: URL;
  region: string;
  service: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  dialect: SigV4Dialect;
}

export interface S3TargetInput {
  provider: S3CompatProvider;
  bucket: string;
  endpoint?: string;
  region?: string;
  prefix?: string;
  pathStyle?: boolean;
  /** 覆盖变体默认方言（自建网关用 AWS SigV4 对接阿里云兼容层时有用） */
  dialectId?: SigV4DialectId;
}

export type S3TargetResult =
  | { ok: true; target: S3Target }
  | { ok: false; code: CloudConfigIssueCode };

/** 用 region 填端点模板（\`{region}\`）；模板缺失 → undefined。 */
function fillEndpointTemplate(template: string | undefined, region: string): string | undefined {
  if (template === undefined) return undefined;
  return template.replace('{region}', region);
}

/**
 * 解析 S3 目标：校验 + 变体默认填充 + 端点归一。
 * 校验失败返回**稳定错误码**（无用户文案），由通道层/路由层映射成字典键。
 */
export function resolveS3Target(input: S3TargetInput): S3TargetResult {
  const variant = s3ProviderVariant(input.provider);
  if (variant === undefined) return { ok: false, code: 'cloud.providerUnknown' };

  const region = (input.region ?? variant.defaultRegion ?? '').trim();
  const endpointRaw = (input.endpoint ?? '').trim();
  const endpointCandidate = endpointRaw !== ''
    ? endpointRaw
    : (fillEndpointTemplate(variant.endpointTemplate, region) ?? '');
  if (endpointCandidate === '') return { ok: false, code: 'cloud.endpointRequired' };
  const endpointIssue = validateCloudEndpoint(endpointCandidate);
  if (endpointIssue !== null) return { ok: false, code: endpointIssue };

  const regionIssue = validateCloudRegion(region);
  if (regionIssue !== null) return { ok: false, code: regionIssue };

  const bucketIssue = validateCloudBucket(input.bucket);
  if (bucketIssue !== null) return { ok: false, code: bucketIssue };

  const prefix = normalizeObjectPrefix(input.prefix);
  const prefixIssue = validateCloudPrefix(prefix);
  if (prefixIssue !== null) return { ok: false, code: prefixIssue };

  const parsed = new URL(endpointCandidate);
  // 端点路径去尾斜杠（保留子路径），query/hash 已在 validateCloudEndpoint 拒绝
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const endpoint = new URL(parsed.origin + normalizedPath);

  return {
    ok: true,
    target: {
      provider: input.provider,
      endpoint,
      region,
      service: variant.service,
      bucket: input.bucket.trim(),
      prefix,
      pathStyle: input.pathStyle ?? variant.defaultPathStyle,
      dialect: sigV4Dialect(input.dialectId ?? variant.dialectId),
    },
  };
}

/** 某 key 的对象访问地址（path-style 或 virtual-host）。 */
export function objectUrl(target: S3Target, key: string): string {
  // audit-sync sync-F7：逐段编码必须与 SigV4 的规范化口径（sigv4.uriEncode：RFC 3986
  // 未保留字符集 A-Za-z0-9-_.~ 之外一律 %XX）**逐字一致**，否则 ! ' ( ) * 这类
  // encodeURIComponent 不编码的字符会让「实际发出的 path」与「签名的 canonicalURI」分叉
  // （签名被服务端判为不匹配），也会让同一 key 在不同实现下指向不同对象。
  const encodedKey = key.split('/').map((seg) => uriEncode(seg, true)).join('/');
  const basePath = target.endpoint.pathname.replace(/\/+$/, '');
  const origin = target.endpoint.origin;
  if (target.pathStyle) return origin + basePath + '/' + target.bucket + '/' + encodedKey;
  // virtual-host：桶名做主机名首段（桶名已校验为合法 DNS 标签组合）
  const host = target.bucket + '.' + target.endpoint.host;
  return target.endpoint.protocol + '//' + host + basePath + '/' + encodedKey;
}

/** 快照对象键。 */
export function snapshotKey(prefix: string, id: string): string {
  return prefix + '/' + id + '.json';
}

/** 索引对象键。 */
export function indexKey(prefix: string): string {
  return prefix + '/' + S3_INDEX_FILE;
}

/** blob 对象键（内容寻址）。 */
export function blobKey(prefix: string, hash: string): string {
  return prefix + '/' + S3_BLOBS_SEG + '/' + hash;
}

/** blob 索引对象键。 */
export function blobIndexKey(prefix: string): string {
  return prefix + '/' + S3_BLOBS_INDEX_FILE;
}
