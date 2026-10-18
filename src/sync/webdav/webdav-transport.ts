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
import { composeMsg } from '../s3/messages.ts';
// t6：「英文界面零中文」——注册同步域追加目录（this.o.msg 缺省 = zhMsg，其查找链会查注册目录；
// sync.webdav.blobHashInvalid 这类新键必须能解析，绝不露裸键名）。
import '../messages.ts';
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
  SyncProbeResult, SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
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
/**
 * 幂等 MKCOL 的「已存在 / 已建好」状态码（cloud-sync 借鉴项 ③）。
 * 405 = 资源已存在（WebDAV 规范下的常见回法）；301/302/303 = 反向代理把 MKCOL 重定向到规范 URL；
 * 409 = 目标已存在（坚果云等网盘对已存在目录回 409，见 cloud-sync 的兼容注释）。
 */
const MKCOL_OK_STATUSES = new Set([200, 201, 204, 301, 302, 303, 405, 409]);
/**
 * 直连目标集合时可判为「已建好 / 已存在」的状态码（**不含 409**）。
 *
 * 为什么把 409 排除：RFC 4918 §9.3.1 规定「父目录不存在」的正确回法就是 **409 Conflict**，
 * 而部分网盘（坚果云等）对「目标已存在」也回 409 —— 首连直连时两种语义无法区分，
 * 一律当「已存在」会让「上级目录没建」这条真实故障被吞掉（紧接着的 PUT 才会失败）。
 * 因此 409 必须先走 ensureAncestors 补齐父目录再重试；只有**重试后**仍 409 才按「已存在」接受。
 */
const MKCOL_EXISTS_STATUSES = new Set([200, 201, 204, 301, 302, 303, 405]);

/**
 * 条件写头（cloud-sync 借鉴项 ①）：拿到 ETag 就要求「远端仍是我读到的那一版」（If-Match）；
 * 索引**本来就不存在**（首次推送且远端确无内容）时用 If-None-Match: * 防两个设备同时首推；
 * 其余情形（服务端不返回 ETag）返回空对象 ⇒ 退化为无条件写，绝不因为加了头把同步判成失败。
 */
function conditionalHeaders(etag: string | undefined, indexMissing: boolean): Record<string, string> {
  if (etag !== undefined) return { 'If-Match': etag };
  return indexMissing ? { 'If-None-Match': '*' } : {};
}

/** URL 路径段编码：已百分号编码的段原样保留（先 decode 成功才 re-encode），失败则直接编码。 */
function encodeSegmentSafe(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}
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

  /**
   * 最近一次 list() 里读不出来的远端快照（issue #59；index.json 损坏时带上原因）。
   *
   * WebDAV 是「index.json 单点描述所有快照」的形态，坏一条就是坏整份索引 —— 这里如实
   * 暴露原因，让「列表为空/不完整」与「远端确实没有」能被区分开。
   */
  private readErrors: { file: string; reason: string }[] = [];

  /** 最近一次列表里读不出来的远端快照（含原因）；供上层如实呈现，绝不静默 */
  get unreadableSnapshots(): readonly { file: string; reason: string }[] {
    return this.readErrors;
  }

  /** 列出远端已有快照（按 createdAt 升序）。index.json 缺失视为空。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    this.readErrors = [];
    // 幂等读：仅 GET index.json，无本地/远端写副作用 → 瞬时网络故障走有限指数退避重试
    return await withSyncRetry(async () => {
      const pwd = await this.passwordOnce();
      const url = this.indexUrl();
      const res = await this.send('GET', url, pwd);
      if (res.status === 404) return []; // 缺失视为空
      if (!res.ok) {
        throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
      }
      const raw = await res.text();
      const parsed = this.parseIndex(raw, url, pwd);
      // index.json 体积/结构完好但**逐条**不可信时 parseIndex 会抛错；能到这里即整份索引可读
      return parsed;
    }, this.o.retry).catch((err: unknown) => {
      // issue #59：整份索引读不出来（体积超限 / JSON 损坏 / 结构非法）时必须留痕 ——
      // 此前这里直接上抛成通道错误，而 /sync/snapshots-list 的调用方把它当「列表为空」呈现。
      this.readErrors.push({ file: INDEX_FILE, reason: String((err as Error)?.message ?? err) });
      throw err;
    });
  }

  /** 上传快照：幂等 MKCOL → 快照级跳过判定（同 id 且内容全等则免上传）→ PUT <id>.json
   *  → 合并写回 index.json；返回远端 meta（跳过时）或 computeSnapshotMeta。
   *  序列化经 snapshot-json：文件类分区字节以 base64 传输（JSON 无法直传 Uint8Array）。
   *
   * **写路径三态（audit-sync sync-N1 / t66）**：索引 404 只是「缺信息」—— 远端已有历史内容时
   * 一律**中止本次上传（零写入）**，绝不按空集合做读改写（见下方实现处注释）。 */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    const pwd = await this.passwordOnce();
    await this.ensureCollection(pwd);
    // 快照级跳过（增量优化）：先读远端 index，同 id 条目与本地内容全等（sections hash 全等）
    // → 内容未变，直接返回远端 meta，跳过 PUT 快照文件与 index 写回（幂等契约不变）。
    // 加密快照（computeSnapshotMeta.sections 为空对象）经 sectionsEqual 判定为「无法比较」
    // → 必须照常上传，绝不跳过。
    const meta = computeSnapshotMeta(snapshot);
    // audit-sync sync-N1 覆盖面补全（t66，来自 t22 的 C7）：upload 也是写路径，**不接受 404 = 空集合**。
    const { entries: idxBefore, missing: indexMissing, etag: idxEtag } = await this.readIndexDetailed(pwd);
    if (indexMissing && await this.remoteHasPriorContent(pwd)) {
      // 索引 404 只是**缺信息**（不是「远端没有快照」）：远端已有历史内容时，按空索引做读改写会把
      // 权威 index.json PUT 成只有本条目 → 其余快照从列表整体消失，随后 delete + GC 会回收**仍被
      // 现存快照文件引用**的 blob（不可恢复）。这里**在写任何字节之前**显式中止（零写入）。
      // 唯一放行的 404 情形 = 索引与 blob 仓索引都不存在（全新远端）→ 首次推送的既有行为逐字不变。
      const url = this.indexUrl();
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.requestFailed', {
          method: 'GET',
          url,
          status: 404,
          err: 'index.json missing while remote already has content',
        }),
        { kind: 'protocol', retryable: false },
      );
    }
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
    const putIdx = await this.send('PUT', idxUrl, pwd, {
      body: JSON.stringify(merged),
      headers: conditionalHeaders(idxEtag, indexMissing),
    });
    if (putIdx.status === 412) throw this.concurrentWrite(idxUrl, putIdx.status);
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
    // 先读现有 index（不存在 → 空），以便摘除条目。
    // audit-sync sync-F1（P0）：**读不出来 ≠ 远端没有快照** —— 按空索引继续会把 index.json
    // 覆盖成 []（其余快照从列表整体消失、hasNewRemoteSnapshot 恒 false），并让随后的
    // gcBlobStore 以空引用集回收，删掉仍被其它快照引用的会话 blob（不可恢复）。
    // 索引不可读时一律中止本次删除：宁可让它显式失败，也不制造不可恢复的远端状态。
    // audit-sync sync-N1（P0）：写路径**不接受 404 = 空集合** —— 索引真缺失（404）时「远端一条快照都没有」
    // 是**缺信息**而非事实，沿用空索引继续会把 index.json 覆盖成 []（其余快照从列表整体消失）并让
    // gcBlobStore 以空引用集回收，删掉仍被现存快照文件引用的会话 blob（不可恢复）。
    // 与 F1 同口径：宁可显式失败，也不制造不可恢复的远端状态。list() 仍保留「404 = 空集合」语义。
    const { entries: idx, missing: indexMissing, etag: idxEtag } = await this.readIndexDetailed(pwd);
    // delete 快照文件：404 = 不存在，视为成功
    const url = this.snapshotUrl(id);
    const res = await this.send('DELETE', url, pwd);
    if (!res.ok && res.status !== 404) {
      throw new WebDavTransportError(await this.failText('DELETE', url, res, pwd), classifyHttpStatus(res.status));
    }
    // audit-sync sync-N1（P0）：索引真缺失（404）= **缺信息**而不是「集合为空」。此时「哪些 blob
    // 无人引用」无从证明 —— 一律**不写回 index.json、不触发 blob GC**，其余快照与其引用的 blob
    // 原样保留（宁可留垃圾，不可删在用的）。目标快照文件已按用户意图删除（404 视为成功）。
    if (indexMissing) return;
    // 若 index 中无该 id，则无需写回
    const remaining = idx.filter((m) => m.id !== id);
    if (remaining.length === idx.length && res.status === 404) {
      return; // 文件与 index 都不存在 → 静默成功，无写回
    }
    const putIdx = await this.send('PUT', idxUrl, pwd, {
      body: JSON.stringify(remaining),
      headers: conditionalHeaders(idxEtag, false),
    });
    if (putIdx.status === 412) throw this.concurrentWrite(idxUrl, putIdx.status);
    if (!putIdx.ok) {
      throw new WebDavTransportError(await this.failText('PUT', idxUrl, putIdx, pwd), classifyHttpStatus(putIdx.status));
    }
    // P1-4：快照被裁掉后回收无人引用的 blob（best-effort，失败不影响删除结果）
    await this.gcBlobStore(pwd, remaining).catch(() => undefined);
  }

  /* ---------------- 内部实现 ---------------- */

  /* ---------------- P1-4：内容寻址 blob 仓 ---------------- */

  // audit-sync sync-F3（P1）：一律以 snapshotsBase()（**无尾斜杠**）为基准拼 blob 路径。
  // snapshotsColUrl() 自带尾斜杠，再拼一层会产生空路径段（…/dsh-config-manager//blobs/…），
  // 与 docs/spec/sync-channel-v1.md §3 的 <col>/blobs/<sha256> 及其它通道（git/s3）不一致；
  // 不归并空路径段的 WebDAV 服务端会直接拒绝 MKCOL/PUT，使 sessions 外置整体不可用。
  private blobsColUrl(): string {
    return `${this.snapshotsBase()}/${BLOBS_SEG}`;
  }

  private blobUrl(hash: string): string {
    return `${this.blobsColUrl()}/${hash}`;
  }

  private blobsIndexUrl(): string {
    return `${this.snapshotsBase()}/${BLOBS_INDEX_FILE}`;
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

  /**
   * 远端是否已存在历史内容（t66）。判据 = **blob 仓索引文件存在**：它是本通道在远端唯一的、
   * 无需目录列举就能读到的「这里以前写过」证据（WebDAV 的 PROPFIND 在本客户端未实现，见 BLOBS_SEG 注释）。
   *
   * 失败安全：读不出来（网络 / 5xx / 非法 JSON）一律当作**有内容** —— 宁可让这次上传显式失败，
   * 也不冒「把权威索引写成只有本条目」的风险（与「宁可留垃圾，不可删在用的」同口径）。
   *
   * 已知残余（如实登记）：远端只有**未外置**的历史快照、索引又缺失时，本判据看不出内容（无列举
   * 能力 ⇒ 无法自证），此时仍走读改写路径。C7 的伤害面（blob 被回收）恰由本判据覆盖。
   */
  private async remoteHasPriorContent(pwd: string): Promise<boolean> {
    const url = this.blobsIndexUrl();
    let res: WebDavResponse;
    try {
      res = await this.send('GET', url, pwd);
    } catch {
      return true; // 网络层读不出来 → 按有内容（失败安全）
    }
    // 明确「这个资源不存在 / 不允许」的状态 = 没有证据；其余非 2xx（5xx 等）判不出来 → 按有内容（失败安全）。
    // 405/403/501 归入「没有证据」：部分 WebDAV 服务端对缺失资源回 405 而不是 404（既有用例就是这种服务端）。
    if (res.status === 404 || res.status === 405 || res.status === 403 || res.status === 501) return false;
    if (!res.ok) return true;
    try {
      const parsed = parseJsonSafe(await res.text());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      // 证据 = **至少一条合法 blob 记录**（哈希形状）；空对象 / 非 blob-index 的 200 响应都不算「写过了」。
      return Object.keys(parsed as Record<string, unknown>).some((k) => BLOB_HASH_RE.test(k));
    } catch {
      return true; // 体读不出来 ⇒ 判不了 ⇒ 按有内容
    }
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
          throw new WebDavTransportError(this.o.msg('sync.webdav.blobHashInvalid', { hash }));
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
      // 索引有条目但快照文件 404 ⇒ 该文件不存在，不可能引用任何 blob（安全跳过）。
      // 其它失败 ⇒ **读不出来 ≠ 没引用**，本轮直接放弃（与「宁可留垃圾，不可删在用的」同口径；sync-N1 同族）。
      if (res.status === 404) continue;
      if (!res.ok) return;
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
    // t79：宿主 msg 若缺某个键（其目录不含该键），回退 core zh 文案 —— 绝不把裸键名露给用户。
    const msg = options.msg === undefined ? zhMsg : composeMsg(options.msg, zhMsg);
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

  /** 幂等创建 snapshots 集合：MKCOL；已存在（2xx/3xx/405/409）视为成功。
   *
   * cloud-sync 借鉴项 ③（首连自建）：目标目录的**上级**不存在时（新账号，或用户填了一个还没建的
   * 目录），按 WebDAV 规范 MKCOL 缺父目录回 409 —— 此前用户必须先去网盘里手工建好目录，否则
   * 首次同步必然失败。现在：直连 409 时逐级补齐 baseUrl 路径上的每一层，再重试一次。
   * 返回**本次真正新建**的层级 URL（已存在的层级不进结果，探针据此如实回报，普通上传忽略返回值）。 */
  private async ensureCollection(pwd: string): Promise<string[]> {
    const url = this.snapshotsColUrl();
    const first = await this.send('MKCOL', url, pwd);
    // 首连只认「确定已存在 / 已建好」的状态；**409 不算**（二义：缺父目录 or 已存在）
    if (MKCOL_EXISTS_STATUSES.has(first.status)) return [];
    if (first.status !== 409) {
      // 401/403/5xx/… 不是「目录缺失」，绝不吞掉：如实报错
      throw new WebDavTransportError(await this.failText('MKCOL', url, first, pwd), classifyHttpStatus(first.status));
    }
    // 409：先逐级补齐 baseUrl 每一层（幂等；已存在的层回 405/3xx/409 都按已存在继续），再重试目标集合。
    const created = await this.ensureAncestors(pwd);
    const retry = await this.send('MKCOL', url, pwd);
    // 重试真建出目标集合（201/200/204）也要如实回报 —— 否则界面会**低报**本次实际创建的目录
    // （用户可见文案「已在远端自动创建目录」，少报一条等于说错）。
    if (retry.status === 200 || retry.status === 201 || retry.status === 204) created.push(url);
    // 上级已确保存在：重试仍是 409 ⇒ 按「已存在」接受（部分网盘行为）；真正的权限/路径错误由随后的 PUT 显式报出。
    if (MKCOL_OK_STATUSES.has(retry.status)) return created;
    throw new WebDavTransportError(await this.failText('MKCOL', url, retry, pwd), classifyHttpStatus(retry.status));
  }

  /** 逐级 MKCOL 补齐 baseUrl 的每一层目录（只有缺父目录时才会走到这里）。 */
  private async ensureAncestors(pwd: string): Promise<string[]> {
    const base = new URL(this.o.baseUrl);
    const segments = base.pathname.split('/').filter((seg) => seg !== '');
    const created: string[] = [];
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).map((seg) => encodeSegmentSafe(seg)).join('/');
      const url = `${base.origin}/${path}/`;
      const res = await this.send('MKCOL', url, pwd);
      // 201/200/204 = 这次真的建出来了；405/409/3xx = 早就存在 → 不写进结果（不谎报「已创建」）
      if (res.status === 200 || res.status === 201 || res.status === 204) created.push(url);
      else if (MKCOL_OK_STATUSES.has(res.status)) continue;
      else {
        throw new WebDavTransportError(
          this.o.msg('sync.webdav.collectionCreateFailed', { path: url, status: String(res.status) }),
          classifyHttpStatus(res.status),
        );
      }
    }
    return created;
  }

  /** 条件写失败（HTTP 412）：远端在本次读取之后被别人改过 —— 中止写入，让用户重跑（cloud-sync 借鉴项 ①）。 */
  private concurrentWrite(url: string, status: number): WebDavTransportError {
    return new WebDavTransportError(
      this.o.msg('sync.webdav.concurrentWrite', { status: String(status), url }),
      { kind: 'conflict', retryable: false, status },
    );
  }

  /**
   * 连通性探针（cloud-sync 借鉴项 ②）：补齐目标目录 → 证明这真的是一个可读的 WebDAV 集合
   * → 读一次索引回报快照数。只读；唯一写副作用是幂等 MKCOL 补目录（那正是它要修的故障）。
   */
  async probe(): Promise<SyncProbeResult> {
    const pwd = await this.passwordOnce();
    const created = await this.ensureCollection(pwd);
    const url = this.snapshotsColUrl();
    const res = await this.send('PROPFIND', url, pwd, { headers: { Depth: '0' } });
    // 2xx（含 207 Multi-Status）= 真的是 WebDAV 集合；405/501 = 服务端不支持 PROPFIND → 退回「读索引」当证据。
    if (!res.ok && res.status !== 405 && res.status !== 501) {
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.probeUnreachable', { status: String(res.status), url }),
        classifyHttpStatus(res.status),
      );
    }
    const { entries, missing } = await this.readIndexDetailed(pwd);
    const count = missing ? 0 : entries.length;
    return {
      message: this.o.msg('sync.webdav.probeOk', { count: String(count) }),
      snapshotCount: count,
      ...(created.length > 0 ? { createdCollections: created } : {}),
    };
  }

  /**
   * 读 index。**三态语义**（audit-sync sync-N1 / t66）：
   *  - 200 + 合法数组 → 返回条目（list 用）；
   *  - 404 → 缺索引：`missing = true`（**缺信息**，不是「集合为空」）；
   *    写路径（**upload / delete**）一律不得据此做读改写 —— upload 在「远端已有内容」时显式中止，
   *    delete 直接返回（不写索引、不触发 GC）；list 仍保留「404 = 空集合」语义；
   *  - 其它非 2xx / 非法 JSON / 逐条非法 → 抛错（F1/F2 语义，绝不回落成空）。
   */
  /**
   * 读 index 的**带缺失标志**版本（audit-sync sync-N1）：
   *  - 404 → `missing = true`（**缺信息**，不是事实）；
   *  - 其它非 2xx / 非法 JSON / 逐条非法 → 抛错（F1/F2 语义，绝不回落成空）。
   * 写路径（**upload / delete**）必须用本方法：`missing` 时既不写回索引、也不触发 GC
   * （upload 另加「远端已有内容 ⇒ 显式中止」的判据，见 upload() 注释）。
   */
  private async readIndexDetailed(pwd: string): Promise<{ entries: SyncSnapshotMeta[]; missing: boolean; etag?: string }> {
    const url = this.indexUrl();
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) return { entries: [], missing: true };
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('GET', url, res, pwd), classifyHttpStatus(res.status));
    }
    // ETag 是写路径**条件写**的前置条件（cloud-sync 借鉴项 ①）：服务端给了就记下来，没给就退化成无条件写
    // （绝不因为「服务端不返回 ETag」把同步判成失败）。
    const etag = res.headers?.['etag'];
    return {
      entries: this.parseIndex(await res.text(), url, pwd),
      missing: false,
      ...(typeof etag === 'string' && etag !== '' ? { etag } : {}),
    };
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
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<WebDavResponse> {
    const auth = 'Basic ' + Buffer.from(`${this.o.username}:${pwd}`, 'utf8').toString('base64');
    const headers: Record<string, string> = {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'DSH-Config-Manager/0.1.55 (WebDAV Client)',
      // 条件写头（If-Match / If-None-Match）与探针的 Depth 头从这里注入（cloud-sync 借鉴项 ①②）
      ...(opts.headers ?? {}),
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
