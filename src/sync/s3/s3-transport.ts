/**
 * m-s3-channel：S3 兼容系通道（SyncTransport 的 s3 / oss / cos / minio / kodo 实现）。
 *
 * 远端布局（单对象 JSON 快照 + 索引，与 WebDAV 通道同构，便于跨通道迁移与排障）：
 *   <prefix>/index.json          —— 索引（SyncSnapshotMeta 数组）
 *   <prefix>/<id>.json           —— 单个快照的完整载荷（SyncSnapshot 序列化）
 *   <prefix>/blobs/<sha256>      —— 内容寻址 blob（会话等大分区外置；未变内容零传输）
 *   <prefix>/blobs-index.json    —— blob 索引（哈希 → 写入时间；GC 需要「有哪些 blob」）
 *
 * 设计（与 WebDAV 通道同口径）：
 * - upload：读索引做「快照级跳过」（同 id 且 sections hash 全等 → 一个字都不传）→
 *   PUT <id>.json → 合并写回 index.json（meta 最后落盘）→ 新 blob 合并进 blobs-index；
 * - list：GET index.json，404 视为空；按 createdAt 升序；
 * - download：GET <id>.json 反序列化；不存在按契约抛 notfound；
 * - delete：DELETE <id>.json + 总索引摘除 + 回收无人引用的 blob；
 * - 二进制安全：快照走 snapshot-json（文件分区 Uint8Array → base64 标记对象）。
 *
 * 签名与凭据：
 * - 每次请求都用**手写 SigV4**签（\`sigv4.ts\`；AWS SigV4 与阿里云 OSS4 走同一实现 + 方言表，
 *   由 \`s3-providers.ts\` 的变体决定）——零第三方依赖，不引任何 SDK；
 * - AccessKey Secret 只在签名瞬间从注入的 \`credentials.getSecretAccessKey()\` 读取，
 *   **绝不进日志 / 不进错误消息**（错误文本统一走 \`mask()\` 脱敏），也绝不回传上层；
 * - AccessKey ID 不是密钥（可回显），但仍只从 options 传入，不写任何文件。
 */
import { requestOnce } from '../../utils/proxy.ts';
import type { RawResponse } from '../../utils/proxy.ts';
import { parseJsonSafe } from '../../utils/json.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import {
  BLOB_SECTIONS, gcBlobs, isBlobRefsSection, isFilesSectionLike, referencedBlobHashes,
  refsToSection, sectionToBlobRefs,
} from '../blob-store.ts';
import type { BlobRefsSection, BlobSink } from '../blob-store.ts';
import {
  classifyHttpStatus, classifyNetworkErrorText, computeSnapshotMeta, DEFAULT_SYNC_TIMEOUT_MS,
  isEncryptedSections, sectionsEqual, SyncTransportError, withSyncRetry,
} from '../transport.ts';
import type {
  SyncProbeResult, SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
} from '../transport.ts';
import { signRequest } from './sigv4.ts';
import type { SigV4DialectId } from './sigv4.ts';
import { composeMsg, s3Msg } from './messages.ts';
import { blobIndexKey, blobKey, indexKey, objectUrl, resolveS3Target, snapshotKey } from './s3-providers.ts';
import type { S3Target } from './s3-providers.ts';
import type { CloudConfigIssueCode, S3CompatProvider } from '../sync-config.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';

/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防对象键穿越与 URL 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 保留 id（与索引 / blob 索引对象键冲突） */
const RESERVED_IDS = new Set(['index', 'blobs', 'blobs-index']);
/** 错误消息里截取的响应体最大长度（防超大/二进制响应撑爆消息） */
const ERR_BODY_MAX = 500;
/** 内容哈希形状（sha256 hex）：blob 对象键只接受它，杜绝路径穿越 */
const BLOB_HASH_RE = /^[a-f0-9]{64}$/;
const REDACTED = '[REDACTED]';

/**
 * 条件写头（cloud-sync 借鉴项 ①）：有 ETag → If-Match（远端必须仍是我读到的那一版）；
 * 索引本来就不存在 → If-None-Match: *（防两设备同时首推）；服务端不给 ETag → 空（无条件写，不改既有行为）。
 */
function conditionalHeaders(etag: string | undefined, indexMissing: boolean): Record<string, string> {
  if (etag !== undefined) return { 'if-match': etag };
  return indexMissing ? { 'if-none-match': '*' } : {};
}

/** 条件写失败判定：412 恒是；409 仅在**确实带了条件头**时才算（无条件的 409 另有含义，不吞）。 */
function isConcurrentWrite(status: number, headers: Record<string, string>): boolean {
  if (status === 412) return true;
  return status === 409 && Object.keys(headers).length > 0;
}

/** 请求选项：headers / body / 覆盖默认超时（ms；0 = 不超时） */
export interface S3RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 请求响应最小形状（兼容 fetch Response 的 status/ok/text()） */
export interface S3Response {
  readonly status: number;
  readonly ok: boolean;
  readonly headers?: Record<string, string>;
  text(): Promise<string>;
}

/** 可注入的请求函数（测试 mock 用）；method/url/options */
export type S3RequestFn = (
  method: string,
  url: string,
  options?: S3RequestOptions,
) => Promise<S3Response>;

/** 凭据提供者：AccessKey Secret 只从这里读取，绝不落盘/进日志/回传 */
export interface S3CredentialProvider {
  getSecretAccessKey(): Promise<string>;
}

export interface S3TransportOptions {
  /** 变体通道（s3 / oss / cos / minio / kodo） */
  provider: S3CompatProvider;
  /** 桶名 */
  bucket: string;
  /** AccessKey ID（非密钥，可回显） */
  accessKeyId: string;
  /** AccessKey Secret 提供者 */
  credentials: S3CredentialProvider;
  /** 端点（缺省取变体模板；自建网关必填） */
  endpoint?: string;
  /** region（缺省取变体默认；oss/cos/kodo 必填） */
  region?: string;
  /** 对象键前缀（缺省 dsh-config-manager） */
  prefix?: string;
  /** 寻址风格（缺省取变体默认：MinIO path-style，其余 virtual-host） */
  pathStyle?: boolean;
  /** 覆盖变体默认签名方言 */
  dialectId?: SigV4DialectId;
  /** 可注入请求（测试 mock 用）；缺省 = 经 utils/proxy 的出站请求（代理感知） */
  request?: S3RequestFn;
  /** 单请求超时 ms；缺省 = 两条既有通道共用的 DEFAULT_SYNC_TIMEOUT_MS（120000）；0 = 不超时 */
  timeoutMs?: number;
  /** 幂等读操作（list/download）的网络重试参数；写操作（upload/delete）不使用 */
  retry?: SyncRetryOptions;
  /** 签名时刻（测试注入固定值以得到确定性签名）；缺省 = 当前时间 */
  now?: () => Date;
  /** 消息翻译器（缺省 zh；见 ./messages.ts） */
  msg?: MsgFunc;
}

/** S3 通道错误：继承统一错误基类（kind / retryable / status 对上层可见）。 */
export class S3TransportError extends SyncTransportError {
  constructor(message: string, opts: SyncTransportErrorOptions = {}) {
    super(message, opts);
    this.name = 'S3TransportError';
  }
}

/** 配置错误码 → 消息键（穷举映射：新增错误码时 typecheck 直接报缺项）。 */
const S3_ISSUE_KEYS: Record<CloudConfigIssueCode, string> = {
  'cloud.providerUnknown': 'sync.s3.providerUnknown',
  'cloud.endpointRequired': 'sync.s3.endpointRequired',
  'cloud.endpointInvalid': 'sync.s3.endpointInvalid',
  'cloud.endpointUserinfo': 'sync.s3.endpointUserinfo',
  'cloud.regionRequired': 'sync.s3.regionRequired',
  'cloud.bucketRequired': 'sync.s3.bucketRequired',
  'cloud.bucketInvalid': 'sync.s3.bucketInvalid',
  'cloud.prefixInvalid': 'sync.s3.prefixInvalid',
  'cloud.accessKeyIdRequired': 'sync.s3.accessKeyIdRequired',
  // 以下码属于 Gist 通道（不适用 S3）：兜底用「未知通道」文案，绝不静默冒充成功配置
  'cloud.gistIdRequired': 'sync.s3.providerUnknown',
  'cloud.gistIdInvalid': 'sync.s3.providerUnknown',
  'cloud.apiBaseUrlInvalid': 'sync.s3.providerUnknown',
  'cloud.secretWriterRequired': 'sync.s3.credentialsRequired',
};

/** 缺省请求实现：经 utils/proxy 的出站请求（代理感知，零全局副作用）。
 * 单次请求不跟随重定向（S3 兼容端点不应 3xx；真 3xx 由上层如实报 HTTP 状态）。 */
const defaultRequest: S3RequestFn = async (method, url, options = {}) => {
  const headers: Record<string, string> = {
    'User-Agent': 'DSH-Config-Manager (S3 Client)',
    ...(options.headers ?? {}),
  };
  if (options.body === undefined) {
    delete headers['Content-Length'];
    delete headers['content-length'];
  }
  const timeoutMs = options.timeoutMs ?? 0;
  let res: RawResponse;
  try {
    res = await requestOnce({
      method,
      url,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });
  } catch (err) {
    if (err instanceof Error && /timed out/i.test(err.message) && err.name !== 'TimeoutError') {
      const timeoutError = new Error(err.message);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw err;
  }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => { responseHeaders[key] = value });
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: responseHeaders,
    text: async () => res.body.toString('utf8'),
  };
};

/** 实现 SyncTransport 的 S3 兼容系通道（五家共用同一实现，差异见 s3-providers 的变体表）。 */
export class S3Transport implements SyncTransport {
  /** 通道类型 = 变体 id（s3 / oss / cos / minio / kodo），供同步历史与状态如实标注来源 */
  readonly type: string;

  private readonly target: S3Target;
  private readonly o: {
    accessKeyId: string;
    credentials: S3CredentialProvider;
    request: S3RequestFn;
    timeoutMs: number;
    retry: SyncRetryOptions;
    now: () => Date;
    msg: MsgFunc;
  };

  constructor(options: S3TransportOptions) {
    // t79：宿主传进来的 msg（core 目录）**不包含** sync.s3.* 键，直接用会显示裸键名 —— 合并本地目录。
    const msg = composeMsg(options.msg, s3Msg);
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getSecretAccessKey !== 'function') {
      throw new S3TransportError(msg('sync.s3.credentialsRequired'));
    }
    if (typeof options.accessKeyId !== 'string' || options.accessKeyId.trim() === '') {
      throw new S3TransportError(msg('sync.s3.accessKeyIdRequired'));
    }
    const resolved = resolveS3Target({
      provider: options.provider,
      bucket: options.bucket,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.region !== undefined ? { region: options.region } : {}),
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      ...(options.pathStyle !== undefined ? { pathStyle: options.pathStyle } : {}),
      ...(options.dialectId !== undefined ? { dialectId: options.dialectId } : {}),
    });
    if (!resolved.ok) {
      throw new S3TransportError(msg(S3_ISSUE_KEYS[resolved.code], { provider: String(options.provider) }));
    }
    this.target = resolved.target;
    this.type = resolved.target.provider;
    this.o = {
      accessKeyId: options.accessKeyId.trim(),
      credentials: options.credentials,
      request: options.request ?? defaultRequest,
      timeoutMs: options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
      retry: options.retry ?? {},
      now: options.now ?? (() => new Date()),
      msg,
    };
  }

  /** 解析后的目标（只读；端点/region/寻址风格/方言；**不含任何密钥**）。 */
  get resolvedTarget(): S3Target {
    return this.target;
  }

  /** 列出远端已有快照（按 createdAt 升序）；index.json 缺失视为空。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    return await withSyncRetry(async () => {
      const secret = await this.secretOnce();
      const sent = await this.send('GET', indexKey(this.target.prefix), { secret });
      if (sent.res.status === 404) return [];
      if (!sent.res.ok) {
        throw new S3TransportError(await this.failText('GET', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
      }
      return this.parseIndex(await sent.res.text(), sent.url, secret);
    }, this.o.retry);
  }

  /** 上传快照（同 id 覆盖，幂等友好）；内容未变时零传输直接返回远端 meta。
   *
   * **写路径三态（audit-sync sync-N1 / t66）**：索引 404 只是「缺信息」—— 远端已有历史内容时
   * 一律**中止本次上传（零写入）**，绝不按空集合做读改写（与 delete() 同口径）。 */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    const secret = await this.secretOnce();
    const meta = computeSnapshotMeta(snapshot);
    // audit-sync sync-N1 覆盖面补全（t66，来自 t22 的 C7）：upload 也是写路径，**不接受 404 = 空集合**。
    const { entries: idxBefore, missing: indexMissing, etag: idxEtag } = await this.readIndexDetailed(secret);
    if (indexMissing && await this.remoteHasPriorContent(secret)) {
      // 索引 404 只是**缺信息**：远端已有历史内容时按空索引读改写，会把权威索引 PUT 成只有本条目
      // → 其余快照从列表整体消失，随后 delete + GC 会回收仍被现存快照文件引用的 blob（不可恢复）。
      // 这里在写任何字节之前显式中止；放行的 404 只限「索引与 blob 仓索引都不存在」（全新远端）。
      throw new S3TransportError(
        this.o.msg('sync.s3.indexMissingWithContent', { url: indexKey(this.target.prefix) }),
        { kind: 'protocol', retryable: false },
      );
    }
    const existing = idxBefore.find((m) => m.id === snapshot.id);
    if (existing !== undefined && sectionsEqual(existing, meta)) return existing;

    // P1-4：会话等大分区先外置到内容寻址 blob（未变内容零传输），快照里只留引用
    const freshBlobs = new Map<string, number>();
    const stored = await this.externalize(snapshot, secret, freshBlobs);
    const put = await this.send('PUT', snapshotKey(this.target.prefix, snapshot.id), { body: serializeSnapshot(stored), secret });
    if (!put.res.ok) {
      throw new S3TransportError(await this.failText('PUT', put.url, put.res, secret), classifyHttpStatus(put.res.status));
    }
    const merged = idxBefore.filter((m) => m.id !== snapshot.id);
    merged.push(meta);
    merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const condHeaders = conditionalHeaders(idxEtag, indexMissing);
    const putIdx = await this.send('PUT', indexKey(this.target.prefix), {
      body: JSON.stringify(merged),
      secret,
      headers: condHeaders,
    });
    if (isConcurrentWrite(putIdx.res.status, condHeaders)) throw this.concurrentWrite(putIdx.url, putIdx.res.status);
    if (!putIdx.res.ok) {
      throw new S3TransportError(await this.failText('PUT', putIdx.url, putIdx.res, secret), classifyHttpStatus(putIdx.res.status));
    }
    // blob 索引最后落盘（漏记只占空间、不会误删）
    if (freshBlobs.size > 0) await this.appendBlobIndex(freshBlobs, secret);
    return meta;
  }

  /** 下载快照完整载荷；不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    return await withSyncRetry(async () => {
      const secret = await this.secretOnce();
      const sent = await this.send('GET', snapshotKey(this.target.prefix, id), { secret });
      if (sent.res.status === 404) {
        throw new S3TransportError(
          this.o.msg('sync.s3.snapshotMissing', { id, url: sent.url }),
          { kind: 'notfound', retryable: false, status: 404 },
        );
      }
      if (!sent.res.ok) {
        throw new S3TransportError(await this.failText('GET', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
      }
      const snap = this.parseSnapshot(await sent.res.text(), id);
      return await this.rehydrate(snap, secret);
    }, this.o.retry);
  }

  /** 删除远端快照（不存在视为成功）；一并摘除索引条目并回收无人引用的 blob。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    const secret = await this.secretOnce();
    // audit-sync sync-F2（P0）：读不出来 ≠ 远端没有快照（与 WebDAV 同型）。按空索引继续会把
    // index.json 覆盖成 []（其余快照从列表消失）并让 blob GC 删掉仍被引用的会话 blob —— 一律中止。
    // audit-sync sync-N1（P0）：与 WebDAV 同型 —— 写路径**不接受 404 = 空集合**。索引真缺失时
    // 「远端一条快照都没有」是缺信息而非事实，沿用空索引会覆盖 index.json 并用空引用集回收 blob。
    const { entries: idx, missing: indexMissing, etag: idxEtag } = await this.readIndexDetailed(secret);
    const del = await this.send('DELETE', snapshotKey(this.target.prefix, id), { secret });
    if (!del.res.ok && del.res.status !== 404) {
      throw new S3TransportError(await this.failText('DELETE', del.url, del.res, secret), classifyHttpStatus(del.res.status));
    }
    // audit-sync sync-N1（P0）：索引真缺失（404）= 缺信息而非「集合为空」→ **不写回索引、不触发 GC**，
    // 其余快照与其引用的 blob 原样保留（与 WebDAV 同型）。目标快照文件已按用户意图删除。
    if (indexMissing) return;
    const remaining = idx.filter((m) => m.id !== id);
    if (remaining.length === idx.length && del.res.status === 404) return; // 对象与索引都没有 → 静默成功
    const condHeaders = conditionalHeaders(idxEtag, false);
    const putIdx = await this.send('PUT', indexKey(this.target.prefix), {
      body: JSON.stringify(remaining),
      secret,
      headers: condHeaders,
    });
    if (isConcurrentWrite(putIdx.res.status, condHeaders)) throw this.concurrentWrite(putIdx.url, putIdx.res.status);
    if (!putIdx.res.ok) {
      throw new S3TransportError(await this.failText('PUT', putIdx.url, putIdx.res, secret), classifyHttpStatus(putIdx.res.status));
    }
    await this.gcBlobStore(secret, remaining).catch(() => undefined);
  }

  /* ---------------- 内部实现 ---------------- */

  /** 条件写失败：远端索引在本次读取之后被别人改过 —— 中止写入让用户重跑（cloud-sync 借鉴项 ①）。 */
  private concurrentWrite(url: string, status: number): S3TransportError {
    return new S3TransportError(
      this.o.msg('sync.s3.concurrentWrite', { status: String(status), url }),
      { kind: 'conflict', retryable: false, status },
    );
  }

  /**
   * 连通性探针（cloud-sync 借鉴项 ②）：HEAD 桶证明端点/凭据/桶可达，再读一次索引回报快照数。
   * 重定向（301/307/308）时读 x-amz-bucket-region 直接把「region 该填什么」告诉用户 ——
   * 这是 S3 兼容端点最常见的失败原因（AWS/OSS/COS/Kodo 各自的 region 值不同）。
   */
  async probe(): Promise<SyncProbeResult> {
    const secret = await this.secretOnce();
    const bucket = await this.send('HEAD', '', { secret });
    const status = bucket.res.status;
    if (status === 301 || status === 307 || status === 308) {
      const region = bucket.res.headers?.['x-amz-bucket-region'] ?? bucket.res.headers?.['X-Amz-Bucket-Region'];
      throw new S3TransportError(
        region !== undefined && region !== ''
          ? this.o.msg('sync.s3.probeRegionRedirect', { region })
          : this.o.msg('sync.s3.probeRedirectNoRegion', { status: String(status) }),
        { kind: 'client', retryable: false, status },
      );
    }
    if (status === 404) {
      throw new S3TransportError(this.o.msg('sync.s3.probeBucketMissing'), { kind: 'notfound', retryable: false, status });
    }
    if (status === 403) {
      throw new S3TransportError(this.o.msg('sync.s3.probeAccessDenied'), { kind: 'auth', retryable: false, status });
    }
    if (!bucket.res.ok) {
      throw new S3TransportError(await this.failText('HEAD', bucket.url, bucket.res, secret), classifyHttpStatus(status));
    }
    const { entries, missing } = await this.readIndexDetailed(secret);
    const count = missing ? 0 : entries.length;
    return { message: this.o.msg('sync.s3.probeOk', { count: String(count) }), snapshotCount: count };
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id) || RESERVED_IDS.has(id)) {
      throw new S3TransportError(this.o.msg('sync.s3.invalidSnapshotId', { id: JSON.stringify(id) }));
    }
  }

  /** 读取一次 AccessKey Secret（失败 → 空串，让请求按「无凭据」失败并把原因如实带回） */
  private async secretOnce(): Promise<string> {
    try {
      return await this.o.credentials.getSecretAccessKey();
    } catch {
      return '';
    }
  }

  /** 发送一次已签名请求；网络错误/超时归一为带分类的通道错误 */
  private async send(
    method: string,
    key: string,
    opts: { body?: string; secret: string; headers?: Record<string, string> },
  ): Promise<{ res: S3Response; url: string }> {
    const url = objectUrl(this.target, key);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 条件写头（if-match / if-none-match）从这里注入（cloud-sync 借鉴项 ①）；
      // 签名在注入之后计算，因此条件头也进 SignedHeaders。
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body, 'utf8'));
    const signed = signRequest({
      method,
      url,
      headers,
      body: opts.body ?? '',
      accessKeyId: this.o.accessKeyId,
      secretAccessKey: opts.secret,
      region: this.target.region,
      service: this.target.service,
      dialect: this.target.dialect,
      now: this.o.now(),
    });
    try {
      const res = await this.o.request(method, url, {
        headers: signed.headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        timeoutMs: this.o.timeoutMs,
      });
      return { res, url };
    } catch (err) {
      if (this.isTimeout(err)) {
        throw new S3TransportError(
          this.o.msg('sync.s3.timeout', { method, url, timeout: String(this.o.timeoutMs) }),
          { kind: 'timeout', retryable: true, cause: err },
        );
      }
      const rawMsg = err instanceof Error
        ? (err.cause ? err.message + ' (' + String((err.cause as Error).message ?? err.cause) + ')' : err.message)
        : String(err);
      throw new S3TransportError(
        this.o.msg('sync.s3.requestError', { method, url, err: this.mask(rawMsg, opts.secret) }),
        { ...classifyNetworkErrorText(rawMsg), cause: err },
      );
    }
  }

  /** 构造 HTTP 非 2xx 失败消息：附上脱敏后的响应体片段（截断） */
  private async failText(method: string, url: string, res: S3Response, secret: string): Promise<string> {
    let body = '';
    try {
      body = (await res.text()).slice(0, ERR_BODY_MAX);
    } catch {
      body = '';
    }
    return this.o.msg('sync.s3.requestFailed', {
      method,
      url,
      status: String(res.status),
      err: this.mask(body, secret),
    });
  }

  /** 识别超时错误（AbortError / TimeoutError） */
  private isTimeout(err: unknown): boolean {
    const name = (err as Error | undefined)?.name ?? '';
    if (name === 'TimeoutError') return true;
    if (name === 'AbortError') return true;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && name === 'AbortError') return true;
    return false;
  }

  /** 错误消息脱敏：AccessKey Secret（原文与 URL 编码形态）一律替换 */
  private mask(text: string, secret: string): string {
    if (!secret) return text;
    let out = text.split(secret).join(REDACTED);
    out = out.split(encodeURIComponent(secret)).join(REDACTED);
    return out;
  }

  /**
   * 读索引。**三态语义**（audit-sync sync-N1 / t66，与 WebDAV 同型）：
   *  - 200 + 合法数组 → 条目；404 → 缺索引（**缺信息**，不是「集合为空」）；
   *    写路径（**upload / delete**）不得据此做读改写 —— upload 在「远端已有内容」时显式中止，
   *    delete 直接返回；其它非 2xx / 非法 → 抛错（F2 语义）。
   */
  /**
   * 读索引的**带缺失标志**版本（audit-sync sync-N1，与 WebDAV 同型）：
   * 404 → `missing = true`（缺信息，不是事实）；其它非 2xx / 非法 → 抛错（F2 语义）。
   */
  private async readIndexDetailed(secret: string): Promise<{ entries: SyncSnapshotMeta[]; missing: boolean; etag?: string }> {
    const sent = await this.send('GET', indexKey(this.target.prefix), { secret });
    if (sent.res.status === 404) return { entries: [], missing: true };
    if (!sent.res.ok) {
      throw new S3TransportError(await this.failText('GET', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
    }
    // ETag 是条件写的前置条件（cloud-sync 借鉴项 ①）；服务端没给就退化为无条件写，绝不判成失败。
    const etag = sent.res.headers?.['etag'];
    return {
      entries: this.parseIndex(await sent.res.text(), sent.url, secret),
      missing: false,
      ...(typeof etag === 'string' && etag !== '' ? { etag } : {}),
    };
  }

  private parseIndex(raw: string, url: string, secret: string): SyncSnapshotMeta[] {
    let parsed: unknown;
    try {
      parsed = parseJsonSafe(raw);
    } catch (err) {
      throw new S3TransportError(
        this.o.msg('sync.s3.indexInvalid', { url, err: this.mask(String((err as Error)?.message ?? ''), secret) }),
        { kind: 'protocol', retryable: false },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new S3TransportError(
        this.o.msg('sync.s3.indexInvalid', { url, err: 'not an array' }),
        { kind: 'protocol', retryable: false },
      );
    }
    const valid = (m: unknown): m is SyncSnapshotMeta =>
      typeof m === 'object' && m !== null
      && typeof (m as SyncSnapshotMeta).id === 'string'
      && typeof (m as SyncSnapshotMeta).createdAt === 'string'
      && typeof (m as SyncSnapshotMeta).manifest === 'object' && (m as SyncSnapshotMeta).manifest !== null
      && typeof (m as SyncSnapshotMeta).sections === 'object' && (m as SyncSnapshotMeta).sections !== null;
    if (!parsed.every(valid)) {
      throw new S3TransportError(
        this.o.msg('sync.s3.indexInvalid', { url, err: 'invalid entry' }),
        { kind: 'protocol', retryable: false },
      );
    }
    const metas = parsed as SyncSnapshotMeta[];
    metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return metas;
  }

  private parseSnapshot(raw: string, id: string): SyncSnapshot {
    try {
      return deserializeSnapshot(raw);
    } catch (err) {
      throw new S3TransportError(
        this.o.msg('sync.s3.snapshotInvalid', { id, err: this.mask(String((err as Error)?.message ?? ''), '') }),
        { kind: 'protocol', retryable: false },
      );
    }
  }

  /* ---------------- P1-4：内容寻址 blob 仓 ---------------- */

  /** 读取 blob 索引（哈希 → 写入时间 ms）；缺失/损坏 → 空（GC 只会「少删」，不会误删） */
  /**
   * 远端是否已存在历史内容（t66）。判据 = **blob 仓索引对象存在**：它是本通道唯一的、
   * 无需列举整个桶就能读到的「这里以前写过」证据（本实现未用 ListObjects）。
   *
   * 失败安全：读不出来（网络 / 5xx）一律当作**有内容** —— 宁可让这次上传显式失败，也不冒
   * 「把权威索引写成只有本条目」的风险（与「宁可留垃圾，不可删在用的」同口径）。
   * 已知残余（如实登记）：远端只有**未外置**的历史快照、索引又缺失时本判据看不出内容（无列举能力）。
   */
  private async remoteHasPriorContent(secret: string): Promise<boolean> {
    let sent: { res: S3Response };
    try {
      sent = await this.send('GET', blobIndexKey(this.target.prefix), { secret });
    } catch {
      return true; // 网络层读不出来 → 按有内容（失败安全）
    }
    const status = sent.res.status;
    // 明确「对象不存在 / 不允许」= 没有证据；其余非 2xx（5xx 等）判不出来 → 按有内容（失败安全）。
    if (status === 404 || status === 405 || status === 403 || status === 501) return false;
    if (status < 200 || status >= 300) return true;
    try {
      const parsed = parseJsonSafe(await sent.res.text());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      return Object.keys(parsed as Record<string, unknown>).some((k) => BLOB_HASH_RE.test(k));
    } catch {
      return true;
    }
  }

  private async readBlobIndex(secret: string): Promise<Record<string, number>> {
    const sent = await this.send('GET', blobIndexKey(this.target.prefix), { secret });
    if (sent.res.status === 404) return {};
    if (!sent.res.ok) return {};
    try {
      const parsed = parseJsonSafe(await sent.res.text());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, number> = {};
      for (const [hash, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (BLOB_HASH_RE.test(hash) && typeof at === 'number' && Number.isFinite(at)) out[hash] = at;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeBlobIndex(secret: string, index: Record<string, number>): Promise<void> {
    const sent = await this.send('PUT', blobIndexKey(this.target.prefix), { body: JSON.stringify(index), secret });
    if (!sent.res.ok) {
      throw new S3TransportError(await this.failText('PUT', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
    }
  }

  private async appendBlobIndex(fresh: Map<string, number>, secret: string): Promise<void> {
    const index = await this.readBlobIndex(secret);
    for (const [hash, at] of fresh) index[hash] = at;
    await this.writeBlobIndex(secret, index);
  }

  /** blob 仓端口：命中索引 = 零传输；失败安全取舍与 WebDAV 通道一致 */
  private blobSink(secret: string, index: Record<string, number>, fresh: Map<string, number>): BlobSink {
    return {
      put: async (hash, bytes) => {
        if (!BLOB_HASH_RE.test(hash)) {
          throw new S3TransportError(this.o.msg('sync.s3.blobHashInvalid', { hash }));
        }
        if (index[hash] !== undefined) return; // 内容未变 → 一个字都不传
        const sent = await this.send('PUT', blobKey(this.target.prefix, hash), {
          body: Buffer.from(bytes).toString('base64'),
          secret,
        });
        if (!sent.res.ok) {
          throw new S3TransportError(await this.failText('PUT', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
        }
        const at = Date.now();
        index[hash] = at;
        fresh.set(hash, at);
      },
      get: async (hash) => {
        if (!BLOB_HASH_RE.test(hash)) return null;
        const sent = await this.send('GET', blobKey(this.target.prefix, hash), { secret });
        if (sent.res.status === 404) return null;
        if (!sent.res.ok) {
          throw new S3TransportError(await this.failText('GET', sent.url, sent.res, secret), classifyHttpStatus(sent.res.status));
        }
        return new Uint8Array(Buffer.from((await sent.res.text()).trim(), 'base64'));
      },
      delete: async (hash) => {
        if (!BLOB_HASH_RE.test(hash)) return;
        await this.send('DELETE', blobKey(this.target.prefix, hash), { secret }); // 不存在视为成功
        delete index[hash];
      },
      list: async () => Object.entries(index).map(([hash, mtimeMs]) => ({ hash, mtimeMs })),
    };
  }

  /** 上传前把外置分区换成引用形态（加密快照整体密文，永不外置） */
  private async externalize(snapshot: SyncSnapshot, secret: string, fresh: Map<string, number>): Promise<SyncSnapshot> {
    if (isEncryptedSections(snapshot.sections)) return snapshot;
    const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
    const targets = BLOB_SECTIONS.filter((sid) => isFilesSectionLike(plain[sid]));
    if (targets.length === 0) return snapshot;
    const index = await this.readBlobIndex(secret);
    const sink = this.blobSink(secret, index, fresh);
    const next: Partial<Record<SectionId, SectionData>> = { ...plain };
    for (const sid of targets) {
      const refs = await sectionToBlobRefs(plain[sid] as FilesSection, sink);
      next[sid] = refs as unknown as SectionData;
    }
    return { ...snapshot, sections: next };
  }

  /** 下载后把引用形态还原成文件分区（缺 blob → 硬失败，绝不降级为空分区） */
  private async rehydrate(snapshot: SyncSnapshot, secret: string): Promise<SyncSnapshot> {
    if (isEncryptedSections(snapshot.sections)) return snapshot;
    const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
    const targets = BLOB_SECTIONS.filter((sid) => isBlobRefsSection(plain[sid]));
    if (targets.length === 0) return snapshot;
    const sink = this.blobSink(secret, {}, new Map());
    const next: Partial<Record<SectionId, SectionData>> = { ...plain };
    for (const sid of targets) {
      const files = await refsToSection(plain[sid] as unknown as BlobRefsSection, sink);
      next[sid] = files as unknown as SectionData;
    }
    return { ...snapshot, sections: next };
  }

  /** blob 仓 GC：逐份读仍存在的快照收集引用，删除无人引用且超保护窗的 blob；
   *  读坏任一份快照 → 本轮直接放弃（宁可留垃圾，不可删在用的） */
  private async gcBlobStore(secret: string, remaining: SyncSnapshotMeta[]): Promise<void> {
    const index = await this.readBlobIndex(secret);
    if (Object.keys(index).length === 0) return;
    const referenced = new Set<string>();
    for (const meta of remaining) {
      const sent = await this.send('GET', snapshotKey(this.target.prefix, meta.id), { secret });
      // 条目在但文件 404 ⇒ 不可能引用 blob（安全跳过）；其它失败 ⇒ 读不出来 ≠ 没引用，本轮放弃。
      if (sent.res.status === 404) continue;
      if (!sent.res.ok) return;
      let snap: SyncSnapshot;
      try {
        snap = deserializeSnapshot(await sent.res.text());
      } catch {
        return;
      }
      const plain = snap.sections as Partial<Record<SectionId, unknown>>;
      for (const sid of BLOB_SECTIONS) {
        for (const hash of referencedBlobHashes(plain[sid])) referenced.add(hash);
      }
    }
    const deleted = await gcBlobs({ sink: this.blobSink(secret, index, new Map()), referenced, nowMs: Date.now() });
    if (deleted.length === 0) return;
    await this.writeBlobIndex(secret, index);
  }
}
