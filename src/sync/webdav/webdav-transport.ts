/**
 * m-webdav-channel：WebDAV 通道（SyncTransport 的 webdav 实现）。
 *
 * 远端布局（单文件 JSON 快照 + 索引）：
 *   <base>/dsh-config-manager/<id>.json   —— 单个快照的完整载荷（SyncSnapshot 序列化）
 *   <base>/dsh-config-manager/index.json  —— 索引（SyncSnapshotMeta 数组，每个 id 一条）
 *
 * 设计：
 * - upload：先幂等 MKCOL snapshots 集合，再读 index 做「快照级跳过」判定
 *   （同 id 条目且 sections hash 全等 → 内容未变，跳过 PUT 直接返回远端 meta）；
 *   否则 PUT <id>.json（先快照文件）→ 合并（保留其它 id、覆盖同 id）→ PUT 写回 index
 *   （meta 最后落盘：快照文件成功后才写索引）。
 * - list：GET index.json，缺失（404）视为空；按 createdAt 升序返回。
 * - download：GET <id>.json 解析成 SyncSnapshot；不存在必须抛错（契约）。
 * - delete：DELETE <id>.json 并从 index 摘除条目（写回合并后 index）；文件不存在视为成功。
 * - 二进制安全：快照序列化经 snapshot-json（文件分区 Uint8Array → base64 标记对象），
 *   JSON 往返字节无损（否则 JSON.stringify 把 TypedArray 变成数字索引对象，拉取还原
 *   成普通对象 → Buffer.from(对象) 报错）。
 * - 认证：HTTP Basic（username 配置项 + 注入 credentials 提供者 getPassword()）。
 *   密码绝不进 URL/日志；错误消息中的响应体统一脱敏（password → [REDACTED]）。
 * - 重定向：默认 request 自动跟随 301/302/303/307/308（网盘 WebDAV 会把下载 GET 302 到
 *   带时效签名的 CDN 直链，如 123pan；不自建反代返回 301 也一样）。303 且非 GET/HEAD 时
 *   降级为 GET 并丢弃请求体；跨源跳转剥离 Authorization（CDN 直链是预签名 URL，不得把
 *   Basic 凭据转发给第三方域）；上限 5 跳，超出抛错。无 Location / Location 非法的 3xx
 *   按最终响应返回（上层如实报 HTTP 状态失败）。
 * - 可注入 request 便于测试；注入实现负责自己的重定向语义（默认实现才自动跟随）。
 */
import { requestOnce, type RawResponse } from '../../utils/proxy.ts';
import { zhMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/messages.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import { BLOB_SECTIONS, gcBlobs, isBlobRefsSection, isFilesSectionLike, referencedBlobHashes, refsToSection, sectionToBlobRefs } from '../blob-store.ts';
import type { BlobRefsSection, BlobSink } from '../blob-store.ts';
import {
  classifyHttpStatus, classifyNetworkErrorText, computeSnapshotMeta, DEFAULT_SYNC_TIMEOUT_MS,
  isEncryptedSections, sectionsEqual, SyncTransportError, withSyncRetry,
} from '../transport.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';
import type {
  SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
} from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';

/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防路径穿越与 URL 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 保留 id：与 index.json 冲突（id 'index' 会占用索引文件路径） */
const RESERVED_IDS = new Set(['index', 'blobs', 'blobs-index']);
/**
 * 单请求超时缺省值 = 两条同步通道**共用**的 DEFAULT_SYNC_TIMEOUT_MS（120000）。
 * WebDAV 上传大快照（含多个分区配置）与读写索引在慢速服务器（如坚果云限速、自建 NAS）
 * 下较慢，30s 常不够 → 该共用值取原两条通道里的较大者；业务侧（makeSyncEngine）
 * 仍可显式传 timeoutMs 覆盖。不再在本文件里另留一个通道私有常量。
 */
/** 错误消息里截取的响应体最大长度（防超大/二进制响应撑爆消息） */
const ERR_BODY_MAX = 500;
const SNAPSHOTS_SEG = 'dsh-config-manager';
const INDEX_FILE = 'index.json';
/**
 * 内容寻址 blob 仓（P1-4）：与快照同集合下的 `blobs/` 子集合 + `blobs-index.json`
 * （哈希 → 写入时间；GC 需要「有哪些 blob」而 WebDAV 的 PROPFIND 在本客户端未实现，
 * 用一份索引文件代替。索引**失败安全**：漏记 → 该 blob 永不被 GC 删（只占空间）；
 * 多记 → 对已不存在的 blob 发 DELETE，幂等无害）。
 */
const BLOBS_SEG = 'blobs';
const BLOBS_INDEX_FILE = 'blobs-index.json';
/** 内容哈希形状（sha256 hex）：blob 路径只接受它，杜绝路径穿越 */
const BLOB_HASH_RE = /^[a-f0-9]{64}$/;
const REDACTED = '[REDACTED]';
/** 自动跟随的重定向状态码（RFC 7231/9110） */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 重定向最大跳数（RFC 7231 建议 ≤5；防 302 循环拖死请求） */
const MAX_REDIRECTS = 5;

/** 请求选项：headers / body / 覆盖默认超时（ms；0 = 不超时） */
export interface WebDavRequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 请求响应最小形状（兼容 fetch Response 的 status/ok/text()；headers 供重定向读 Location） */
export interface WebDavResponse {
  readonly status: number;
  readonly ok: boolean;
  /** 响应头（可选：注入的 mock 可省略，默认 request 总会带上，重定向跟随需要 location） */
  readonly headers?: Record<string, string>;
  text(): Promise<string>;
}

/** 可注入的请求函数（测试 mock 用）；method/url/options */
export type WebDavRequestFn = (
  method: string,
  url: string,
  options?: WebDavRequestOptions,
) => Promise<WebDavResponse>;

/** 凭据提供者：password 只从这里读取，绝不落盘/进日志 */
export interface WebDavCredentialProvider {
  getPassword(): Promise<string>;
}

export interface WebDavTransportOptions {
  /** WebDAV 远端根 URL（http/https），如 https://dav.example.com/dav/config */
  baseUrl: string;
  /** HTTP Basic 认证用户名 */
  username: string;
  /** 密码提供者（HTTP Basic 密码） */
  credentials: WebDavCredentialProvider;
  /** 可注入 request（测试 mock 用）；缺省 = 全局 fetch + AbortController 超时 */
  request?: WebDavRequestFn;
  /** 单请求超时 ms；缺省 = 两条通道共用的 DEFAULT_SYNC_TIMEOUT_MS（120000）；0 = 不超时 */
  timeoutMs?: number;
  /** 幂等读操作（list/download）的网络重试参数；缺省 attempts=3、250ms 起指数退避。
   *  写操作（upload/delete）**不使用**该参数（PUT 快照与 PUT index 之间失败会留孤儿文件）。 */
  retry?: SyncRetryOptions;
  /** 消息翻译器（缺省 zh） */
  msg?: MsgFunc;
}

/**
 * WebDAV 通道错误：继承统一错误基类（kind / retryable / status 分类对上层可见）。
 * 分类口径：HTTP 状态走 classifyHttpStatus，请求层异常走 classifyNetworkErrorText。
 */
export class WebDavTransportError extends SyncTransportError {
  constructor(message: string, opts: SyncTransportErrorOptions = {}) {
    super(message, opts);
    this.name = 'WebDavTransportError';
  }
}

/** 默认请求实现：node:https/http 原生流式请求（支持全部 WebDAV 方法、准确 Content-Length 与 User-Agent）。
 * 自动跟随 301/302/303/307/308 重定向（网盘 WebDAV 的 GET/PUT 会 302 到 CDN 预签名直链）：
 * - 301/302/307/308 保持原方法与请求体；303 且非 GET/HEAD 降级为 GET 并丢弃请求体；
 * - 相对 Location 用当前 URL 解析；跨源跳转剥离 Authorization（预签名 URL 不应收到 Basic 凭据）；
 * - 上限 MAX_REDIRECTS 跳，超出抛错；无 Location / Location 非法的 3xx 按最终响应返回。 */
const defaultRequest: WebDavRequestFn = async (method, url, options = {}) => {
  let currentMethod = method;
  let currentUrl = url;
  let currentHeaders = { ...(options.headers ?? {}) };
  let currentBody = options.body;

  for (let redirects = 0; ; ) {
    const res = await rawRequest(currentMethod, currentUrl, {
      ...options,
      headers: currentHeaders,
      body: currentBody,
    });

    const status = res.status;
    if (!REDIRECT_STATUSES.has(status)) return res;

    // 3xx 但没有 Location（或 Location 非法）→ 无法跟随，作为最终响应返回（上层如实报 HTTP 状态）
    const rawLocation = res.headers?.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    if (!location) return res;
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      return res;
    }

    if (redirects >= MAX_REDIRECTS) {
      const err = new Error(`Too many redirects (${MAX_REDIRECTS} max) for ${url}`);
      err.name = 'RedirectError';
      throw err;
    }
    redirects += 1;

    // 303：非 GET/HEAD 降级 GET 并丢弃请求体（303 See Other 语义）
    let nextMethod = currentMethod;
    let nextHeaders = currentHeaders;
    let nextBody = currentBody;
    if (status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
      nextMethod = 'GET';
      nextBody = undefined;
    }
    // 跨源：剥离 Authorization（同源保留，服务器可能按 Basic 认证续用）
    if (!sameOrigin(currentUrl, nextUrl)) {
      nextHeaders = { ...currentHeaders };
      delete nextHeaders.Authorization;
    }

    currentMethod = nextMethod;
    currentUrl = nextUrl;
    currentHeaders = nextHeaders;
    currentBody = nextBody;
  }
};

/** 单次裸请求（不跟随重定向）。
 *
 * 实现已统一到 `utils/proxy.requestOnce`（issue #30 ②级方案）：同一份实现同时服务 WebDAV 与
 * GitHub 出站，并在此处获得**插件私有**的代理能力（HTTP 代理 absolute-form / HTTPS 代理 CONNECT
 * 隧道 + TLS），且不改动任何全局状态。未配置代理时行为与原先的 node:http 直连完全一致。
 */
async function rawRequest(
  method: string,
  url: string,
  options: WebDavRequestOptions,
): Promise<WebDavResponse> {
  const timeoutMs = options.timeoutMs ?? 0;
  const headers: Record<string, string> = {
    'User-Agent': 'DSH-Config-Manager/0.1.55 (WebDAV Client)',
    ...(options.headers ?? {}),
  };
  if (options.body === undefined) {
    // 303 降级后已丢弃 body → 清除残留的 Content-Length，避免 GET 带错误长度头
    delete headers['Content-Length'];
    delete headers['content-length'];
  }

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
    // 超时错误名保持 'TimeoutError'（上层 isTimeout 依赖它做文案归一）
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
}

/** 同源判断（协议 + host，host 含端口；子域名不同视为跨源） */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/** 实现 SyncTransport 的 WebDAV 通道。所有网络操作经 request 注入（缺省 defaultRequest，自动跟随重定向）。 */
export class WebDavTransport implements SyncTransport {
  readonly type = 'webdav';

  private readonly o: {
    baseUrl: string;
    username: string;
    credentials: WebDavCredentialProvider;
    request: WebDavRequestFn;
    timeoutMs: number;
    retry: SyncRetryOptions;
    msg: MsgFunc;
  };

  constructor(options: WebDavTransportOptions) {
    this.o = {
      baseUrl: '',
      username: '',
      credentials: { getPassword: async () => '' },
      request: defaultRequest,
      timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
      retry: {},
      msg: zhMsg,
    };
    this.validateOptions(options);
    this.o.baseUrl = options.baseUrl;
    this.o.username = options.username;
    this.o.credentials = options.credentials;
    if (options.request !== undefined) this.o.request = options.request;
    if (options.timeoutMs !== undefined) this.o.timeoutMs = options.timeoutMs;
    if (options.msg !== undefined) this.o.msg = options.msg;
    if (options.retry !== undefined) this.o.retry = options.retry;
  }

  /** 列出远端已有快照（按 createdAt 升序）。index.json 缺失视为空。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    // 幂等读：仅 GET index.json，无本地/远端写副作用 → 瞬时网络故障走有限指数退避重试
    return await withSyncRetry(async () => {
      const pwd = await this.passwordOnce();
      const url = this.indexUrl();
      const res = await this.send('GET', url, pwd);
      if (res.status === 404) return []; // 缺失视为空
      if (!res.ok) {
        throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
      }
      return this.parseIndex(await res.text(), url, pwd);
    }, this.o.retry);
  }

  /** 上传快照：幂等 MKCOL → 快照级跳过判定（同 id 且内容全等则免上传）→ PUT <id>.json
   *  → 合并写回 index.json；返回远端 meta（跳过时）或 computeSnapshotMeta。
   *  序列化经 snapshot-json：文件类分区字节以 base64 传输（JSON 无法直传 Uint8Array）。 */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    const pwd = await this.passwordOnce();
    await this.ensureCollection(pwd);
    // 快照级跳过（增量优化）：先读远端 index，同 id 条目与本地内容全等（sections hash 全等）
    // → 内容未变，直接返回远端 meta，跳过 PUT 快照文件与 index 写回（幂等契约不变）。
    // 加密快照（computeSnapshotMeta.sections 为空对象）经 sectionsEqual 判定为「无法比较」
    // → 必须照常上传，绝不跳过。
    const meta = computeSnapshotMeta(snapshot);
    const idxBefore = await this.readIndex(pwd);
    const existing = idxBefore.find((m) => m.id === snapshot.id);
    if (existing !== undefined && sectionsEqual(existing, meta)) {
      return existing;
    }
    // 先写快照文件（JSON 序列化：文件字节 base64 编码，往返无损）
    // P1-4：会话等大分区先外置到内容寻址仓（未变内容零传输），快照里只留引用
    const freshBlobs = new Map<string, number>();
    const stored = await this.externalize(snapshot, pwd, freshBlobs);
    const snapUrl = this.snapshotUrl(snapshot.id);
    const snapRes = await this.send('PUT', snapUrl, pwd, { body: serializeSnapshot(stored) });
    if (!snapRes.ok) {
      throw new WebDavTransportError(await this.failText('PUT', snapUrl, snapRes, pwd), classifyHttpStatus(snapRes.status));
    }
    // 再写合并后的 index（保留其它 id、覆盖同 id）—— meta 最后落盘
    const idxUrl = this.indexUrl();
    const merged = idxBefore.filter((m) => m.id !== snapshot.id);
    merged.push(meta);
    merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const putIdx = await this.send('PUT', idxUrl, pwd, { body: JSON.stringify(merged) });
    if (!putIdx.ok) {
      throw new WebDavTransportError(await this.failText('PUT', idxUrl, putIdx, pwd), classifyHttpStatus(putIdx.status));
    }
    // blob 索引最后落盘（漏记只占空间、不会误删，见 BLOBS_SEG 注释）
    if (freshBlobs.size > 0) await this.appendBlobIndex(freshBlobs, pwd);
    return meta;
  }

  /** 下载快照完整载荷。不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    // 幂等读：仅 GET 快照文件，重试不会产生任何写副作用
    return await withSyncRetry(async () => {
      const pwd = await this.passwordOnce();
      const url = this.snapshotUrl(id);
      const res = await this.send('GET', url, pwd);
    if (res.status === 404) {
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.snapshotMissing', { id, url }),
        { kind: 'notfound', retryable: false, status: 404 },
      );
    }
      if (!res.ok) {
        throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
      }
      const snap = this.parseSnapshot(await res.text(), id);
      // P1-4：外置分区从 blob 仓取回字节（缺 blob → 硬失败，绝不降级成空分区）
      return await this.rehydrate(snap, pwd);
    }, this.o.retry);
  }

  /** 删除远端快照并从 index 摘除（写回合并后的 index）；文件不存在视为成功。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    const pwd = await this.passwordOnce();
    const idxUrl = this.indexUrl();
    // 先读现有 index（不存在 → 空），以便摘除条目
    let idx: SyncSnapshotMeta[] = [];
    try {
      idx = await this.readIndex(pwd);
    } catch {
      idx = []; // index 缺失/损坏时按无条目处理（不阻塞删除）
    }
    // delete 快照文件：404 = 不存在，视为成功
    const url = this.snapshotUrl(id);
    const res = await this.send('DELETE', url, pwd);
    if (!res.ok && res.status !== 404) {
      throw new WebDavTransportError(await this.failText('DELETE', url, res, pwd), classifyHttpStatus(res.status));
    }
    // 若 index 中无该 id，则无需写回
    const remaining = idx.filter((m) => m.id !== id);
    if (remaining.length === idx.length && res.status === 404) {
      return; // 文件与 index 都不存在 → 静默成功，无写回
    }
    const putIdx = await this.send('PUT', idxUrl, pwd, { body: JSON.stringify(remaining) });
    if (!putIdx.ok) {
      throw new WebDavTransportError(await this.failText('PUT', idxUrl, putIdx, pwd), classifyHttpStatus(putIdx.status));
    }
    // P1-4：快照被裁掉后回收无人引用的 blob（best-effort，失败不影响删除结果）
    await this.gcBlobStore(pwd, remaining).catch(() => undefined);
  }

  /* ---------------- 内部实现 ---------------- */

  /* ---------------- P1-4：内容寻址 blob 仓 ---------------- */

  private blobsColUrl(): string {
    return `${this.snapshotsColUrl()}/${BLOBS_SEG}`;
  }

  private blobUrl(hash: string): string {
    return `${this.blobsColUrl()}/${hash}`;
  }

  private blobsIndexUrl(): string {
    return `${this.snapshotsColUrl()}/${BLOBS_INDEX_FILE}`;
  }

  /** 幂等创建 blobs 集合（405/301 等「已存在」语义一律视为成功，与 ensureCollection 同口径）。 */
  private async ensureBlobsCollection(pwd: string): Promise<void> {
    const url = this.blobsColUrl();
    const res = await this.send('MKCOL', url, pwd);
    const okStatuses = new Set([200, 201, 204, 301, 302, 303, 405]);
    if (!okStatuses.has(res.status)) {
      throw new WebDavTransportError(await this.failText('MKCOL', url, res, pwd), classifyHttpStatus(res.status));
    }
  }

  /** 把本次新写入的 blob 合并进远端索引（写失败 → 抛错，调用方看到的是上传失败而非静默漏记）。 */
  private async appendBlobIndex(fresh: Map<string, number>, pwd: string): Promise<void> {
    const index = await this.readBlobIndex(pwd);
    for (const [hash, at] of fresh) index[hash] = at;
    await this.writeBlobIndex(pwd, index);
  }

  /** 读取 blob 索引（哈希 → 写入时间 ms）；缺失/损坏 → 空（GC 只会「少删」，不会误删）。 */
  private async readBlobIndex(pwd: string): Promise<Record<string, number>> {
    const url = this.blobsIndexUrl();
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) return {};
    if (!res.ok) return {};
    try {
      const parsed = parseJsonSafe(await res.text());
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

  private async writeBlobIndex(pwd: string, index: Record<string, number>): Promise<void> {
    const url = this.blobsIndexUrl();
    const res = await this.send('PUT', url, pwd, { body: JSON.stringify(index) });
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('PUT', url, res, pwd), classifyHttpStatus(res.status));
    }
  }

  /**
   * blob 仓端口。`index` 是「仓里有哪些 blob」的权威视图（GC 与跳过判定同源）：
   * 命中索引 = 零传输；失败安全的取舍见 BLOBS_SEG 注释。
   */
  private blobSink(pwd: string, index: Record<string, number>, fresh: Map<string, number>): BlobSink {
    return {
      put: async (hash, bytes) => {
        if (!BLOB_HASH_RE.test(hash)) {
          throw new WebDavTransportError(`内容哈希形状非法，拒绝写入 blob 仓: ${hash}`);
        }
        if (index[hash] !== undefined) return; // 内容未变 → 一个字都不传（P1-4 的核心收益）
        const url = this.blobUrl(hash);
        const res = await this.send('PUT', url, pwd, { body: Buffer.from(bytes).toString('base64') });
        if (!res.ok) {
          throw new WebDavTransportError(await this.failText('PUT', url, res, pwd), classifyHttpStatus(res.status));
        }
        const at = Date.now();
        index[hash] = at;
        fresh.set(hash, at);
      },
      get: async (hash) => {
        if (!BLOB_HASH_RE.test(hash)) return null;
        const url = this.blobUrl(hash);
        const res = await this.send('GET', url, pwd);
        if (res.status === 404) return null;
        if (!res.ok) {
          throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
        }
        return new Uint8Array(Buffer.from((await res.text()).trim(), 'base64'));
      },
      delete: async (hash) => {
        if (!BLOB_HASH_RE.test(hash)) return;
        await this.send('DELETE', this.blobUrl(hash), pwd); // 不存在视为成功
        delete index[hash];
      },
      list: async () => Object.entries(index).map(([hash, mtimeMs]) => ({ hash, mtimeMs })),
    };
  }

  /** 上传前把外置分区换成引用形态（加密快照整体密文，永不外置）。 */
  private async externalize(
    snapshot: SyncSnapshot,
    pwd: string,
    fresh: Map<string, number>,
  ): Promise<SyncSnapshot> {
    if (isEncryptedSections(snapshot.sections)) return snapshot;
    const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
    const targets = BLOB_SECTIONS.filter((sid) => isFilesSectionLike(plain[sid]));
    if (targets.length === 0) return snapshot;
    await this.ensureBlobsCollection(pwd);
    const index = await this.readBlobIndex(pwd);
    const sink = this.blobSink(pwd, index, fresh);
    const next: Partial<Record<SectionId, SectionData>> = { ...plain };
    for (const sid of targets) {
      // ContentHash 已在适配器侧算好（FilesSection.files[].contentHash），这里只是落仓 + 建引用
      const refs = await sectionToBlobRefs(plain[sid] as FilesSection, sink);
      next[sid] = refs as unknown as SectionData;
    }
    return { ...snapshot, sections: next };
  }

  /** 下载后把引用形态还原成文件分区（缺 blob → 硬失败）。 */
  private async rehydrate(snapshot: SyncSnapshot, pwd: string): Promise<SyncSnapshot> {
    if (isEncryptedSections(snapshot.sections)) return snapshot;
    const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
    const targets = BLOB_SECTIONS.filter((sid) => isBlobRefsSection(plain[sid]));
    if (targets.length === 0) return snapshot;
    const sink = this.blobSink(pwd, {}, new Map());
    const next: Partial<Record<SectionId, SectionData>> = { ...plain };
    for (const sid of targets) {
      const files = await refsToSection(plain[sid] as unknown as BlobRefsSection, sink);
      next[sid] = files as unknown as SectionData;
    }
    return { ...snapshot, sections: next };
  }

  /**
   * blob 仓 GC（P1-4）：逐份读取**仍存在**的快照 JSON，收集被引用的哈希，删除无人引用且
   * 超过保护窗口的 blob。读坏任一份快照 → 本轮直接放弃（宁可留垃圾，不可删在用的）。
   */
  private async gcBlobStore(pwd: string, remaining: SyncSnapshotMeta[]): Promise<void> {
    const index = await this.readBlobIndex(pwd);
    if (Object.keys(index).length === 0) return;
    const referenced = new Set<string>();
    for (const meta of remaining) {
      const res = await this.send('GET', this.snapshotUrl(meta.id), pwd);
      if (!res.ok) continue;
      let snap: SyncSnapshot;
      try {
        snap = deserializeSnapshot(await res.text());
      } catch {
        return;
      }
      const plain = snap.sections as Partial<Record<SectionId, unknown>>;
      for (const sid of BLOB_SECTIONS) {
        for (const hash of referencedBlobHashes(plain[sid])) referenced.add(hash);
      }
    }
    const deleted = await gcBlobs({ sink: this.blobSink(pwd, index, new Map()), referenced, nowMs: Date.now() });
    if (deleted.length === 0) return;
    await this.writeBlobIndex(pwd, index);
  }

  private validateOptions(options: WebDavTransportOptions): void {
    const msg = options.msg ?? zhMsg;
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
      throw new WebDavTransportError(msg('sync.webdav.baseUrlRequired'));
    }
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new WebDavTransportError(msg('sync.webdav.baseUrlInvalid', { url: options.baseUrl }));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebDavTransportError(msg('sync.webdav.baseUrlInvalid', { url: options.baseUrl }));
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new WebDavTransportError(msg('sync.webdav.baseUrlUserinfo'));
    }
    if (typeof options.username !== 'string' || options.username === '') {
      throw new WebDavTransportError(msg('sync.webdav.usernameRequired'));
    }
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getPassword !== 'function') {
      throw new WebDavTransportError(msg('sync.webdav.credentialsRequired'));
    }
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id) || RESERVED_IDS.has(id)) {
      throw new WebDavTransportError(this.o.msg('sync.webdav.invalidSnapshotId', { id: JSON.stringify(id) }));
    }
  }

  private snapshotsBase(): string {
    return `${this.o.baseUrl.replace(/\/+$/, '')}/${SNAPSHOTS_SEG}`;
  }

  private snapshotsColUrl(): string {
    return `${this.snapshotsBase()}/`;
  }

  private snapshotUrl(id: string): string {
    return `${this.snapshotsBase()}/${id}.json`;
  }

  private indexUrl(): string {
    return `${this.snapshotsBase()}/${INDEX_FILE}`;
  }

  /** 读取一次 password（错误脱敏用） */
  private async passwordOnce(): Promise<string> {
    try {
      return await this.o.credentials.getPassword();
    } catch {
      return '';
    }
  }

  /** 幂等创建 snapshots 集合：MKCOL；已存在（405/2xx/3xx）视为成功。 */
  private async ensureCollection(pwd: string): Promise<void> {
    const url = this.snapshotsColUrl();
    const res = await this.send('MKCOL', url, pwd);
    const okStatuses = new Set([200, 201, 204, 301, 302, 303, 405]);
    if (okStatuses.has(res.status)) return;
    throw new WebDavTransportError(await this.failText('MKCOL', url, res, pwd), classifyHttpStatus(res.status));
  }

  /** 读 index（缺失 → []；非法 → 抛错）。 */
  private async readIndex(pwd: string): Promise<SyncSnapshotMeta[]> {
    const url = this.indexUrl();
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
    }
    return this.parseIndex(await res.text(), url, pwd);
  }

  private parseIndex(raw: string, url: string, pwd: string): SyncSnapshotMeta[] {
    let parsed: unknown;
    try {
      parsed = parseJsonSafe(raw);
    } catch (err) {
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.indexInvalid', { url, err: this.mask(String((err as Error)?.message ?? ''), pwd) }),
        { kind: 'protocol', retryable: false },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.indexInvalid', { url, err: 'not an array' }),
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
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.indexInvalid', { url, err: 'invalid entry' }),
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
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.snapshotInvalid', { id, err: this.mask(String((err as Error)?.message ?? ''), '') }),
        { kind: 'protocol', retryable: false },
      );
    }
  }

  /** 发送请求：注入 Basic 认证头 + 调用 request；网络错误/超时归一 */
  private async send(
    method: string,
    url: string,
    pwd: string,
    opts: { body?: string } = {},
  ): Promise<WebDavResponse> {
    const auth = 'Basic ' + Buffer.from(`${this.o.username}:${pwd}`, 'utf8').toString('base64');
    const headers: Record<string, string> = {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'DSH-Config-Manager/0.1.55 (WebDAV Client)',
    };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body, 'utf8'));
    try {
      return await this.o.request(method, url, { headers, body: opts.body, timeoutMs: this.o.timeoutMs });
    } catch (err) {
      if (this.isTimeout(err)) {
        // 超时 = 瞬时故障（可重试）：分类随错误上抛，上层不必解析 message
        throw new WebDavTransportError(
          this.o.msg('sync.webdav.timeout', { method, url, timeout: String(this.o.timeoutMs) }),
          { kind: 'timeout', retryable: true, cause: err },
        );
      }
      if (err instanceof Error && err.name === 'RedirectError') {
        // 默认 request 的重定向跳数超限（如 302 循环）→ 归一为清晰消息，避免暴露内部跳转详情
        throw new WebDavTransportError(
          this.o.msg('sync.webdav.tooManyRedirects', { method, url, n: String(MAX_REDIRECTS) }),
          { kind: 'protocol', retryable: false, cause: err },
        );
      }
      const rawMsg = err instanceof Error
        ? (err.cause ? `${err.message} (${(err.cause as Error).message || err.cause})` : err.message)
        : String(err);
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.requestError', { method, url, err: this.mask(rawMsg, pwd) }),
        { ...classifyNetworkErrorText(rawMsg), cause: err },
      );
    }
  }

  /** 构造 HTTP 非 2xx 失败消息：附上脱敏后的响应体片段（截断） */
  private async failText(method: string, url: string, res: WebDavResponse, pwd: string): Promise<string> {
    let body = '';
    try {
      body = (await res.text()).slice(0, ERR_BODY_MAX);
    } catch {
      body = '';
    }
    return this.o.msg('sync.webdav.requestFailed', {
      method,
      url,
      status: String(res.status),
      err: this.mask(body, pwd),
    });
  }

  /** 识别超时错误（AbortController 抛出的 AbortError / DOMException timeout / TimeoutError） */
  private isTimeout(err: unknown): boolean {
    const e = err as Error | undefined;
    const name = e?.name ?? '';
    if (name === 'TimeoutError') return true;
    if (name === 'AbortError') return true;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && name === 'AbortError') return true;
    return false;
  }

  /** 错误消息脱敏：password（原文与 URL 编码形态）一律替换 */
  private mask(text: string, pwd: string): string {
    if (!pwd) return text;
    let out = text.split(pwd).join(REDACTED);
    out = out.split(encodeURIComponent(pwd)).join(REDACTED);
    return out;
  }
}
