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
import http from 'node:http';
import https from 'node:https';
import { zhMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/messages.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import { computeSnapshotMeta, sectionsEqual } from '../transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';

/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防路径穿越与 URL 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 保留 id：与 index.json 冲突（id 'index' 会占用索引文件路径） */
const RESERVED_IDS = new Set(['index']);
/**
 * 默认单请求超时（ms）。WebDAV 上传大快照（含多个分区配置）与读写索引在慢速
 * 服务器（如坚果云限速、自建 NAS）下较慢，30s 常不够 → 提高至 120s；
 * 业务侧（makeSyncEngine）还会显式传 timeoutMs 覆盖默认值。
 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 错误消息里截取的响应体最大长度（防超大/二进制响应撑爆消息） */
const ERR_BODY_MAX = 500;
const SNAPSHOTS_SEG = 'dsh-config-manager';
const INDEX_FILE = 'index.json';
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
  /** 单请求超时 ms，默认 120000（慢速 WebDAV 上传大快照需要宽裕窗口；0 = 不超时） */
  timeoutMs?: number;
  /** 消息翻译器（缺省 zh） */
  msg?: MsgFunc;
}

export class WebDavTransportError extends Error {
  constructor(message: string) {
    super(message);
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

/** 单次裸请求（不跟随重定向）：node:http/https + 超时；响应始终带 headers */
function rawRequest(
  method: string,
  url: string,
  options: WebDavRequestOptions,
): Promise<WebDavResponse> {
  const timeoutMs = options.timeoutMs ?? 0;
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
      'User-Agent': 'DSH-Config-Manager/0.1.55 (WebDAV Client)',
      ...(options.headers ?? {}),
    };

    let payload: Buffer | undefined;
    if (options.body !== undefined) {
      payload = Buffer.from(options.body, 'utf8');
      headers['Content-Length'] = String(payload.length);
    } else {
      // 303 降级后已丢弃 body → 清除残留的 Content-Length，避免 GET 带错误长度头
      delete headers['Content-Length'];
    }

    const req = lib.request(
      url,
      {
        method,
        headers,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers as Record<string, string>,
            text: async () => bodyBuffer.toString('utf8'),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
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
    msg: MsgFunc;
  };

  constructor(options: WebDavTransportOptions) {
    this.o = {
      baseUrl: '',
      username: '',
      credentials: { getPassword: async () => '' },
      request: defaultRequest,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      msg: zhMsg,
    };
    this.validateOptions(options);
    this.o.baseUrl = options.baseUrl;
    this.o.username = options.username;
    this.o.credentials = options.credentials;
    if (options.request !== undefined) this.o.request = options.request;
    if (options.timeoutMs !== undefined) this.o.timeoutMs = options.timeoutMs;
    if (options.msg !== undefined) this.o.msg = options.msg;
  }

  /** 列出远端已有快照（按 createdAt 升序）。index.json 缺失视为空。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    const pwd = await this.passwordOnce();
    const url = this.indexUrl();
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) return []; // 缺失视为空
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('GET', url, res, pwd));
    }
    return this.parseIndex(await res.text(), url, pwd);
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
    const snapUrl = this.snapshotUrl(snapshot.id);
    const snapRes = await this.send('PUT', snapUrl, pwd, { body: serializeSnapshot(snapshot) });
    if (!snapRes.ok) {
      throw new WebDavTransportError(await this.failText('PUT', snapUrl, snapRes, pwd));
    }
    // 再写合并后的 index（保留其它 id、覆盖同 id）—— meta 最后落盘
    const idxUrl = this.indexUrl();
    const merged = idxBefore.filter((m) => m.id !== snapshot.id);
    merged.push(meta);
    merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const putIdx = await this.send('PUT', idxUrl, pwd, { body: JSON.stringify(merged) });
    if (!putIdx.ok) {
      throw new WebDavTransportError(await this.failText('PUT', idxUrl, putIdx, pwd));
    }
    return meta;
  }

  /** 下载快照完整载荷。不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    const pwd = await this.passwordOnce();
    const url = this.snapshotUrl(id);
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) {
      throw new WebDavTransportError(this.o.msg('sync.webdav.snapshotMissing', { id, url }));
    }
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('GET', url, res, pwd));
    }
    return this.parseSnapshot(await res.text(), id);
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
      throw new WebDavTransportError(await this.failText('DELETE', url, res, pwd));
    }
    // 若 index 中无该 id，则无需写回
    const remaining = idx.filter((m) => m.id !== id);
    if (remaining.length === idx.length && res.status === 404) {
      return; // 文件与 index 都不存在 → 静默成功，无写回
    }
    const putIdx = await this.send('PUT', idxUrl, pwd, { body: JSON.stringify(remaining) });
    if (!putIdx.ok) {
      throw new WebDavTransportError(await this.failText('PUT', idxUrl, putIdx, pwd));
    }
  }

  /* ---------------- 内部实现 ---------------- */

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
    throw new WebDavTransportError(await this.failText('MKCOL', url, res, pwd));
  }

  /** 读 index（缺失 → []；非法 → 抛错）。 */
  private async readIndex(pwd: string): Promise<SyncSnapshotMeta[]> {
    const url = this.indexUrl();
    const res = await this.send('GET', url, pwd);
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new WebDavTransportError(await this.failText('GET', url, res, pwd));
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
      );
    }
    if (!Array.isArray(parsed)) {
      throw new WebDavTransportError(this.o.msg('sync.webdav.indexInvalid', { url, err: 'not an array' }));
    }
    const valid = (m: unknown): m is SyncSnapshotMeta =>
      typeof m === 'object' && m !== null
      && typeof (m as SyncSnapshotMeta).id === 'string'
      && typeof (m as SyncSnapshotMeta).createdAt === 'string'
      && typeof (m as SyncSnapshotMeta).manifest === 'object' && (m as SyncSnapshotMeta).manifest !== null
      && typeof (m as SyncSnapshotMeta).sections === 'object' && (m as SyncSnapshotMeta).sections !== null;
    if (!parsed.every(valid)) {
      throw new WebDavTransportError(this.o.msg('sync.webdav.indexInvalid', { url, err: 'invalid entry' }));
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
        throw new WebDavTransportError(
          this.o.msg('sync.webdav.timeout', { method, url, timeout: String(this.o.timeoutMs) }),
        );
      }
      if (err instanceof Error && err.name === 'RedirectError') {
        // 默认 request 的重定向跳数超限（如 302 循环）→ 归一为清晰消息，避免暴露内部跳转详情
        throw new WebDavTransportError(
          this.o.msg('sync.webdav.tooManyRedirects', { method, url, n: String(MAX_REDIRECTS) }),
        );
      }
      const rawMsg = err instanceof Error
        ? (err.cause ? `${err.message} (${(err.cause as Error).message || err.cause})` : err.message)
        : String(err);
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.requestError', { method, url, err: this.mask(rawMsg, pwd) }),
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
