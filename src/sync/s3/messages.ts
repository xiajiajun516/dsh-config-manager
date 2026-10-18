/**
 * S3 兼容系通道（批次3 Q2）的**模块内双语消息目录**（zh 源 / en 镜像）。
 *
 * 为什么不写进 \`src/core/messages.ts\`：批次3 的写作用域只含 \`src/sync/s3|gist|sync-config.ts\`，
 * 而 \`src/core/*\` 属他人 in-flight 工作区。本目录与 core 的同名目录**同形同纪律**
 * （zh 为源、en 为 \`Record<keyof typeof zh, string>\` —— 缺键/多键即编译错误、{param} 插值、
 * 未知键回退 zh 再回退键名），因此后续把键并入 \`src/core/messages.ts\` 是逐行搬迁，无需改写调用点。
 *
 * 纪律：**任何用户可见字符串都不得写在通道实现里**（含错误消息）；密钥值永不进消息
 * （脱敏由通道层在拼消息前完成）。
 */
import type { MsgFunc, MsgParams } from '../../core/msg-types.ts';

export const s3Zh = {
  'sync.s3.providerUnknown': '未知的 S3 兼容通道: {provider}',
  'sync.s3.endpointRequired': '对象存储 endpoint 必须是非空字符串（自建网关请填完整 http(s) 地址）',
  'sync.s3.endpointInvalid': '无法解析对象存储 endpoint（必须是合法 http(s) URL）: {url}',
  'sync.s3.endpointUserinfo': '请勿在 endpoint 中包含用户名/密码（AccessKey 走凭据字段，不会拼入地址）',
  'sync.s3.regionRequired': '通道 {provider} 必须提供 region（V4 签名的作用域需要它）',
  'sync.s3.bucketRequired': 'bucket 必须是非空字符串',
  'sync.s3.bucketInvalid': '桶名不合法: {bucket}（3-63 位小写字母/数字/点/连字符，首尾必须是字母或数字）',
  'sync.s3.prefixInvalid': '对象键前缀不合法: {prefix}（不得以 / 开头，不得含 .. 或反斜杠）',
  'sync.s3.accessKeyIdRequired': 'accessKeyId 必须是非空字符串',
  'sync.s3.credentialsRequired': 'credentials 必须提供 getSecretAccessKey()',
  'sync.s3.invalidSnapshotId': '非法快照 id: {id}（仅允许字母数字开头，字符限 . _ -）',
  'sync.s3.snapshotMissing': '快照 {id} 不存在（{url}）',
  'sync.s3.requestFailed': '{method} {url} 失败 (HTTP {status}): {err}',
  'sync.s3.requestError': '{method} {url} 请求出错: {err}',
  'sync.s3.timeout': '{method} {url} 请求超时（{timeout}ms）',
  'sync.s3.indexInvalid': '{url} 解析失败或结构非法: {err}',
  'sync.s3.snapshotInvalid': '快照 {id} 解析失败或结构非法: {err}',
  'sync.s3.indexMissingWithContent': '远端已有内容但索引 {url} 缺失（HTTP 404）：拒绝以空集合覆盖权威索引，本次上传已中止（零写入）',
  // ---- t6（英文界面零中文）：变体说明（供 UI/文档用 msg() 解析；本字段自 t6 起是**目录键**而非文案）、
  // 方言兜底与 blob 仓哈希形状守卫。键落本地目录 ⇒ composeMsg(host, s3Msg) 与「不传 msg」两条路径都不露裸键名。
  'sync.s3.providerNoteS3': 'AWS S3（默认 us-east-1；AWS 中国区/自建网关请覆盖 endpoint）',
  'sync.s3.providerNoteOss': '阿里云 OSS（region 必填，如 cn-hangzhou；签名方言 OSS4，头名 x-oss-*）',
  'sync.s3.providerNoteCos': '腾讯云 COS（region 必填，如 ap-guangzhou；2024 年后新建桶只支持 virtual-host 寻址）',
  'sync.s3.providerNoteMinio': 'MinIO / 自建网关（endpoint 必填；默认 path-style，配了域名才用 virtual-host）',
  'sync.s3.providerNoteKodo': '七牛 Kodo S3 兼容（region 必填，如 cn-east-1；endpoint 可覆盖）',
  'sync.s3.unknownSignatureDialect': '未知签名方言: {id}',
  'sync.s3.blobHashInvalid': '内容哈希形状非法，拒绝写入 blob 仓: {hash}',
  // ---- cloud-sync 借鉴项 ①②：条件写并发保护 + 连通性探针 ----
  'sync.s3.concurrentWrite': '远端索引已被其它设备更新（HTTP {status}）：本次写入已中止，请重新同步后再试',
  'sync.s3.probeOk': '连接正常（远端 {count} 份快照）',
  'sync.s3.probeRegionRedirect': '端点把请求重定向到区域 {region}：请把 region 改成该值后重试',
  'sync.s3.probeRedirectNoRegion': '端点返回了重定向（HTTP {status}）但没有给出区域：请核对 endpoint 与 region',
  'sync.s3.probeBucketMissing': '桶不存在或无权访问（HTTP 404）：请核对 bucket 名与 endpoint',
  'sync.s3.probeAccessDenied': '访问被拒绝（HTTP 403）：请核对 AccessKey、密钥与桶权限',
} as const;

export const s3En: Record<keyof typeof s3Zh, string> = {
  'sync.s3.providerUnknown': 'Unknown S3-compatible channel: {provider}',
  'sync.s3.endpointRequired': 'Object storage endpoint must be a non-empty string (use the full http(s) URL for self-hosted gateways)',
  'sync.s3.endpointInvalid': 'Cannot parse the object storage endpoint (must be a valid http(s) URL): {url}',
  'sync.s3.endpointUserinfo': 'Do not include a username/password in the endpoint (the AccessKey goes into the credential field, never the URL)',
  'sync.s3.regionRequired': 'Channel {provider} requires a region (the V4 credential scope needs it)',
  'sync.s3.bucketRequired': 'bucket must be a non-empty string',
  'sync.s3.bucketInvalid': 'Invalid bucket name: {bucket} (3-63 lowercase letters/digits/dots/hyphens, must start and end with a letter or digit)',
  'sync.s3.prefixInvalid': 'Invalid object key prefix: {prefix} (must not start with / and must not contain .. or backslashes)',
  'sync.s3.accessKeyIdRequired': 'accessKeyId must be a non-empty string',
  'sync.s3.credentialsRequired': 'credentials must provide getSecretAccessKey()',
  'sync.s3.invalidSnapshotId': 'Invalid snapshot id: {id} (must start alphanumeric; only . _ - allowed)',
  'sync.s3.snapshotMissing': 'Snapshot {id} does not exist ({url})',
  'sync.s3.requestFailed': '{method} {url} failed (HTTP {status}): {err}',
  'sync.s3.requestError': '{method} {url} request error: {err}',
  'sync.s3.timeout': '{method} {url} request timed out ({timeout}ms)',
  'sync.s3.indexInvalid': '{url} failed to parse or is structurally invalid: {err}',
  'sync.s3.snapshotInvalid': 'Snapshot {id} failed to parse or is structurally invalid: {err}',
  'sync.s3.indexMissingWithContent': 'The remote already has content but index {url} is missing (HTTP 404): refusing to overwrite the authoritative index with an empty set; this upload was aborted (zero writes)',
  'sync.s3.providerNoteS3': 'AWS S3 (defaults to us-east-1; override endpoint for AWS China or self-hosted gateways)',
  'sync.s3.providerNoteOss': 'Alibaba Cloud OSS (region required, e.g. cn-hangzhou; OSS4 signature dialect with x-oss-* headers)',
  'sync.s3.providerNoteCos': 'Tencent Cloud COS (region required, e.g. ap-guangzhou; buckets created after 2024 only support virtual-host addressing)',
  'sync.s3.providerNoteMinio': 'MinIO / self-hosted gateway (endpoint required; path-style by default, virtual-host only when a domain is configured)',
  'sync.s3.providerNoteKodo': 'Qiniu Kodo S3-compatible (region required, e.g. cn-east-1; endpoint can be overridden)',
  'sync.s3.unknownSignatureDialect': 'Unknown signature dialect: {id}',
  'sync.s3.blobHashInvalid': 'Malformed content hash; refusing to write to the blob store: {hash}',
  'sync.s3.concurrentWrite': 'The remote index was updated by another device (HTTP {status}): this write was aborted, please sync again',
  'sync.s3.probeOk': 'Connection OK ({count} remote snapshots)',
  'sync.s3.probeRegionRedirect': 'The endpoint redirects to region {region}: set region to that value and retry',
  'sync.s3.probeRedirectNoRegion': 'The endpoint returned a redirect (HTTP {status}) without a region: check endpoint and region',
  'sync.s3.probeBucketMissing': 'Bucket not found or not accessible (HTTP 404): check the bucket name and endpoint',
  'sync.s3.probeAccessDenied': 'Access denied (HTTP 403): check the AccessKey, secret, and bucket permissions',
};

/** 插值：{param} → 形参值；缺参原样保留（与 core/messages.ts 同口径）。 */
function interpolate(template: string, params?: MsgParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * 构造「目录驱动」的 MsgFunc（s3 与 gist 两个新通道共用这一份）。
 * en → en 目录（缺键回退 zh）；其余 → zh；未知键回退键名（绝不抛错）。
 */
export function makeCatalogMsg(
  zh: Record<string, string>,
  en: Record<string, string>,
  lang?: string,
): MsgFunc {
  const useEn = lang === 'en';
  return (key, params) => {
    const template = (useEn ? en[key] ?? zh[key] : zh[key]) ?? key;
    return interpolate(template, params);
  };
}

/** 缺省（zh）S3 通道翻译器。 */
export const s3Msg: MsgFunc = makeCatalogMsg(s3Zh, s3En, 'zh');

/**
 * 把「宿主传入的翻译器」与本地目录**合并**（t79）：
 *  - **宿主优先**：宿主（`ConfigManagerHostContext.this.msg = makeMsg(language)`，见 src/index.ts:1500）
 *    掌握 core 全量键与当前语言，它认得就照它；
 *  - **本地兜底**：`sync.s3.*` 这类键**只存在于本模块**（core 目录里一个都没有），宿主必然查不到
 *    —— 直接用它会出现「界面显示裸键名」（makeMsg 的未知键回退就是键名本身）。回退本地目录即可拿到文案；
 *  - 两边都没有 ⇒ 仍回退键名（保持 makeMsg 的既有边界，绝不抛错）。
 *
 * 同一个 helper 也供 WebDAV 侧使用（`composeMsg(options.msg, zhMsg)`：宿主缺键时回退 core zh，而不是裸键名）。
 * 已知取舍：宿主语言为 en 时，本地目录的键仍出 zh 文案（本地目录缺语言上下文）—— 比裸键名好，
 * 但不等同于完整 en 本地化；要彻底解决得把语言传进传输层（越界，登记为观察）。
 */
export function composeMsg(host: MsgFunc | undefined, local: MsgFunc): MsgFunc {
  if (host === undefined) return local;
  return (key, params) => {
    const fromHost = host(key, params);
    return fromHost === key ? local(key, params) : fromHost;
  };
}
