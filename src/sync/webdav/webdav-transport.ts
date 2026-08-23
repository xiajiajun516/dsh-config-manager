/**
 * m-webdav-channel：WebDAV 通道（SyncTransport 的 webdav 实现）。
 *
 * 远端布局（单文件 JSON 快照 + 索引）：
 *   <base>/snapshots/<id>.json   —— 单个快照的完整载荷（SyncSnapshot 序列化）
 *   <base>/snapshots/index.json  —— 索引（SyncSnapshotMeta 数组，每个 id 一条）
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
 * - 可注入 request 便于测试；缺省用全局 fetch（AbortController 超时）。
 */
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
const SNAPSHOTS_SEG = 'snapshots';
const INDEX_FILE = 'index.json';
const REDACTED = '[REDACTED]';

/** 请求选项：headers / body / 覆盖默认超时（ms；0 = 不超时） */
export interface WebDavRequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 请求响应最小形状（兼容 fetch Response 的 status/ok/text()） */
export interface WebDavResponse {
  readonly status: number;
  readonly ok: boolean;
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

/** 默认请求实现：全局 fetch + AbortController 超时 */
const defaultRequest: WebDavRequestFn = async (method, url, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 0;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok, text: () => response.text() };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/** 实现 SyncTransport 的 WebDAV 通道。所有网络操作经 request 注入（缺省 fetch）。 */
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
      throw new WebDavTransportError(
        this.o.msg('sync.webdav.requestError', { method, url, err: this.mask(String((err as Error)?.message ?? ''), pwd) }),
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
