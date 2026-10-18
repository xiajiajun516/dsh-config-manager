/**
 * m-gist-channel：GitHub Gist 通道（SyncTransport 的 gist 实现）。
 *
 * 为什么单独一条通道：GitHub Gist 的 REST API 只靠一个 token 就能读写远端口袋仓库
 * （竞品 \`@dickpy/dsh-cloud-sync\` 的 \`type:'gist'\` 走 token + gistId 同一族），
 * 对「本机没有 git 二进制 / 只有一个 GitHub 账号」的用户是成本最低的远端。
 *
 * 远端布局（gist 是**扁平文件**命名空间，故用文件名前缀隔离）：
 *   <filePrefix>-index.json   —— 索引（SyncSnapshotMeta 数组）
 *   <filePrefix>-<id>.json    —— 单个快照的完整载荷（SyncSnapshot 序列化）
 * 缺省 filePrefix = \`dsh-sync\`（改前缀 = 同一 gist 里换一套互不干扰的同步数据）。
 *
 * 设计：
 * - list：GET /gists/{id} → 取索引文件内容（内容被 GitHub 截断时回落 raw_url）→ 按 createdAt 升序；
 * - upload：GET 当前 gist → 快照级跳过（同 id 且 sections hash 全等 → 零 PATCH）→
 *   一次 PATCH 同时写快照文件与索引（索引最后落盘：快照成功才更新索引）；
 * - download：从 gist 载荷取文件内容；\`truncated: true\` 时回落 \`raw_url\`（跨源跳转剥离 Authorization）；
 * - delete：PATCH 里把快照文件置 null（GitHub 的删除语义）+ 写回合并后的索引；
 * - 认证：\`Authorization: Bearer <token>\`（token 只从注入的 \`credentials.getToken()\` 读取，
 *   绝不进日志 / 不进错误消息 / 不落盘；raw 下载不带 token —— gh 的 raw 地址本身不可猜且跨源）。
 *
 * **不做 blob 外置**（与 S3/WebDAV 通道的差别，刻意为之）：gist 一次 GET 就把**全部文件内容**
 * 吐回来、单文件内容超限会被截断、且文件数有上限 —— 把会话逐文件外置到 gist 会同时撞上这三条；
 * 本通道定位是「配置类分区的低门槛远端」。会话这类大分区请走 git / webdav / s3 通道。
 */
import { requestOnce } from '../../utils/proxy.ts';
import type { RawResponse } from '../../utils/proxy.ts';
import { parseJsonSafe } from '../../utils/json.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import {
  classifyHttpStatus, classifyNetworkErrorText, computeSnapshotMeta, DEFAULT_SYNC_TIMEOUT_MS,
  sectionsEqual, SyncTransportError, withSyncRetry,
} from '../transport.ts';
import type {
  SyncProbeResult, SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
} from '../transport.ts';
import { gistMsg } from './messages.ts';
import { composeMsg } from '../s3/messages.ts';

/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防文件名注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 保留 id（与索引文件名冲突） */
const RESERVED_IDS = new Set(['index']);
/** 缺省 GitHub API 根 */
export const GIST_DEFAULT_API_BASE_URL = 'https://api.github.com';
/** 缺省文件前缀 */
export const GIST_DEFAULT_FILE_PREFIX = 'dsh-sync';
/** GitHub API 版本（显式固定，避免随 GitHub 默认值漂移） */
const GITHUB_API_VERSION = '2022-11-28';
/** 错误消息里截取的响应体最大长度 */
const ERR_BODY_MAX = 500;
/** 跟随的重定向上限（gist raw 地址可能 302 到 CDN 直链） */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDACTED = '[REDACTED]';

/**
 * 条件写头（cloud-sync 借鉴项 ①）：拿到**强** ETag 才发 If-Match。
 * GitHub 对 gist 返回弱 ETag（W/"…"），HTTP 禁止用它做 If-Match（GitHub 会回 400）——
 * 这里已经由 readGist 过滤掉弱 ETag，无 ETag 即返回空对象 = 退化为无条件 PATCH（既有行为不变）。
 */
function conditionalPatchHeaders(etag: string | undefined): Record<string, string> {
  return etag === undefined ? {} : { 'if-match': etag };
}

/** 请求选项：headers / body / 覆盖默认超时（ms；0 = 不超时） */
export interface GistRequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 请求响应最小形状（兼容 fetch Response 的 status/ok/text()；headers 供重定向读 location） */
export interface GistResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers?: Record<string, string>;
  text(): Promise<string>;
}

/** 可注入的请求函数（测试 mock 用）；method/url/options */
export type GistRequestFn = (
  method: string,
  url: string,
  options?: GistRequestOptions,
) => Promise<GistResponse>;

/** 凭据提供者：token 只从这里读取，绝不落盘/进日志/回传 */
export interface GistCredentialProvider {
  getToken(): Promise<string>;
}

export interface GistTransportOptions {
  /** 目标 gist id（十六进制串；由用户在 GitHub 上新建一个（私密）gist 后填入） */
  gistId: string;
  /** token 提供者（GitHub PAT / OAuth token，需 gist scope） */
  credentials: GistCredentialProvider;
  /** GitHub API 根；缺省 https://api.github.com（GitHub Enterprise 可改） */
  apiBaseUrl?: string;
  /** gist 内文件名前缀；缺省 dsh-sync */
  filePrefix?: string;
  /** 可注入请求（测试 mock 用）；缺省 = 经 utils/proxy 的出站请求（代理感知） */
  request?: GistRequestFn;
  /** 单请求超时 ms；缺省 = 两条既有通道共用的 DEFAULT_SYNC_TIMEOUT_MS（120000）；0 = 不超时 */
  timeoutMs?: number;
  /** 幂等读操作（list/download）的网络重试参数；写操作（upload/delete）不使用 */
  retry?: SyncRetryOptions;
  /** 消息翻译器（缺省 zh；见 ./messages.ts） */
  msg?: MsgFunc;
}

/** Gist 通道错误：继承统一错误基类（kind / retryable / status 对上层可见）。 */
export class GistTransportError extends SyncTransportError {
  constructor(message: string, opts: SyncTransportErrorOptions = {}) {
    super(message, opts);
    this.name = 'GistTransportError';
  }
}

/** GitHub gist 载荷里的单文件条目 */
interface GistFileEntry {
  filename?: string;
  raw_url?: string;
  size?: number;
  truncated?: boolean;
  content?: string;
}

/** 缺省请求实现：经 utils/proxy 的出站请求（代理感知，零全局副作用），**不跟随重定向**。 */
const defaultRequest: GistRequestFn = async (method, url, options = {}) => {
  const headers: Record<string, string> = {
    'User-Agent': 'DSH-Config-Manager (Gist Client)',
    ...(options.headers ?? {}),
  };
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

/** Gist id 形状（GitHub 为十六进制串） */
const GIST_ID_RE = /^[0-9a-f]{5,64}$/i;

/** 实现 SyncTransport 的 GitHub Gist 通道。 */
export class GistTransport implements SyncTransport {
  readonly type = 'gist';

  private readonly o: {
    gistId: string;
    credentials: GistCredentialProvider;
    apiBaseUrl: string;
    filePrefix: string;
    request: GistRequestFn;
    timeoutMs: number;
    retry: SyncRetryOptions;
    msg: MsgFunc;
  };

  constructor(options: GistTransportOptions) {
    // t90（同 t79 口径）：宿主 msg 是 **core 目录**的翻译器，`sync.gist.*` 键只在本地目录里
    //（core 命中 0）⇒ 直接用会显示裸键名。composeMsg = 宿主优先 → 本地目录兜底 → 两边都没有才回退键名。
    const msg = composeMsg(options.msg, gistMsg);
    const gistId = typeof options.gistId === 'string' ? options.gistId.trim() : '';
    if (gistId === '') throw new GistTransportError(msg('sync.gist.gistIdRequired'));
    if (!GIST_ID_RE.test(gistId)) throw new GistTransportError(msg('sync.gist.gistIdInvalid', { id: gistId }));
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getToken !== 'function') {
      throw new GistTransportError(msg('sync.gist.tokenRequired'));
    }
    const apiBaseUrl = (options.apiBaseUrl ?? GIST_DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
    let parsedBase: URL;
    try {
      parsedBase = new URL(apiBaseUrl);
    } catch {
      throw new GistTransportError(msg('sync.gist.apiBaseUrlInvalid', { url: apiBaseUrl }));
    }
    if ((parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:')
      || parsedBase.username !== '' || parsedBase.password !== '') {
      throw new GistTransportError(msg('sync.gist.apiBaseUrlInvalid', { url: apiBaseUrl }));
    }
    const filePrefix = (options.filePrefix ?? GIST_DEFAULT_FILE_PREFIX).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (filePrefix === '' || filePrefix.includes('/') || filePrefix.includes('..')) {
      throw new GistTransportError(msg('sync.gist.filePrefixInvalid', { prefix: filePrefix }));
    }
    this.o = {
      gistId,
      credentials: options.credentials,
      apiBaseUrl,
      filePrefix,
      request: options.request ?? defaultRequest,
      timeoutMs: options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
      retry: options.retry ?? {},
      msg,
    };
  }

  /** gist 里的文件名（非密；供 UI/排障显示） */
  get indexFileName(): string {
    return this.o.filePrefix + '-index.json';
  }

  /** 列出远端已有快照（按 createdAt 升序）；索引文件缺失视为空 gist。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    return await withSyncRetry(async () => {
      const token = await this.tokenOnce();
      const files = await this.readGistFiles(token);
      const raw = await this.readFileText(files, this.indexFileName, token);
      if (raw === null) return [];
      return this.parseIndex(raw, this.gistUrl(), token);
    }, this.o.retry);
  }

  /** 上传快照（同 id 覆盖，幂等友好）；内容未变时零 PATCH 直接返回远端 meta。 */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    const token = await this.tokenOnce();
    const meta = computeSnapshotMeta(snapshot);
    const { files, etag } = await this.readGist(token);
    const idxRaw = await this.readFileText(files, this.indexFileName, token);
    const idxBefore = idxRaw === null ? [] : this.parseIndex(idxRaw, this.gistUrl(), token);
    const existing = idxBefore.find((m) => m.id === snapshot.id);
    if (existing !== undefined && sectionsEqual(existing, meta)) return existing;

    const merged = idxBefore.filter((m) => m.id !== snapshot.id);
    merged.push(meta);
    merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    // 一次 PATCH 写两个文件：快照先、索引后（索引是「有哪些快照」的权威视图）
    const body = JSON.stringify({
      files: {
        [this.snapshotFileName(snapshot.id)]: { content: serializeSnapshot(snapshot) },
        [this.indexFileName]: { content: JSON.stringify(merged) },
      },
    });
    const res = await this.send('PATCH', this.gistUrl(), token, { body, headers: conditionalPatchHeaders(etag) });
    if (res.status === 412) throw this.concurrentWrite(res.status);
    if (!res.ok) {
      throw new GistTransportError(
        await this.failText('PATCH', this.gistUrl(), res, token),
        this.classify(res.status, await this.safeText(res)),
      );
    }
    return meta;
  }

  /** 下载快照完整载荷；不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    return await withSyncRetry(async () => {
      const token = await this.tokenOnce();
      const files = await this.readGistFiles(token);
      const fileName = this.snapshotFileName(id);
      const entry = files[fileName];
      if (entry === undefined) {
        throw new GistTransportError(
          this.o.msg('sync.gist.fileMissing', { file: fileName }),
          { kind: 'notfound', retryable: false, status: 404 },
        );
      }
      const raw = await this.readFileText(files, fileName, token);
      if (raw === null) {
        throw new GistTransportError(
          this.o.msg('sync.gist.fileMissing', { file: fileName }),
          { kind: 'notfound', retryable: false, status: 404 },
        );
      }
      return this.parseSnapshot(raw, id);
    }, this.o.retry);
  }

  /** 删除远端快照（不存在视为成功）：PATCH 置 null + 写回摘除后的索引。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    const token = await this.tokenOnce();
    const { files, etag } = await this.readGist(token);
    const idxRaw = await this.readFileText(files, this.indexFileName, token);
    const idx = idxRaw === null ? [] : this.parseIndex(idxRaw, this.gistUrl(), token);
    const fileName = this.snapshotFileName(id);
    const existed = files[fileName] !== undefined;
    const remaining = idx.filter((m) => m.id !== id);
    if (!existed && remaining.length === idx.length) return; // 文件与索引都没有 → 静默成功，不发 PATCH
    const body = JSON.stringify({
      files: {
        [fileName]: null,
        [this.indexFileName]: { content: JSON.stringify(remaining) },
      },
    });
    const res = await this.send('PATCH', this.gistUrl(), token, { body, headers: conditionalPatchHeaders(etag) });
    if (res.status === 412) throw this.concurrentWrite(res.status);
    if (!res.ok) {
      throw new GistTransportError(
        await this.failText('PATCH', this.gistUrl(), res, token),
        this.classify(res.status, await this.safeText(res)),
      );
    }
  }

  /* ---------------- 内部实现 ---------------- */

  /** 条件写失败（HTTP 412）：远端 gist 在本次读取之后被别人改过 —— 中止写入让用户重跑。 */
  private concurrentWrite(status: number): GistTransportError {
    return new GistTransportError(
      this.o.msg('sync.gist.concurrentWrite', { status: String(status) }),
      { kind: 'conflict', retryable: false, status },
    );
  }

  /**
   * 连通性探针（cloud-sync 借鉴项 ②③）：令牌有效性（GET /user）→ gist 可读 → 快照数 →
   * 归属提示（gist 里已有不属于本前缀的文件时给出 warning 级 hint，绝不自动删别人的文件）。
   * 只读：不打任何 PATCH。
   */
  async probe(): Promise<SyncProbeResult> {
    const token = await this.tokenOnce();
    const userUrl = this.o.apiBaseUrl + '/user';
    const me = await this.send('GET', userUrl, token);
    if (me.status === 401 || me.status === 403) {
      const body = await this.safeText(me);
      throw new GistTransportError(await this.failText('GET', userUrl, me, token, body), this.classify(me.status, body));
    }
    if (!me.ok) {
      const body = await this.safeText(me);
      throw new GistTransportError(await this.failText('GET', userUrl, me, token, body), this.classify(me.status, body));
    }
    const { files } = await this.readGist(token);
    const idxRaw = await this.readFileText(files, this.indexFileName, token);
    const count = idxRaw === null ? 0 : this.parseIndex(idxRaw, this.gistUrl(), token).length;
    const prefix = this.o.filePrefix + '-';
    const foreign = Object.keys(files).filter((name) => !name.startsWith(prefix)).length;
    return {
      message: this.o.msg('sync.gist.probeOk', { count: String(count) }),
      snapshotCount: count,
      ...(foreign > 0
        ? { hint: this.o.msg('sync.gist.probeForeignContent', { count: String(foreign), prefix: this.o.filePrefix }) }
        : {}),
    };
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id) || RESERVED_IDS.has(id)) {
      throw new GistTransportError(this.o.msg('sync.gist.invalidSnapshotId', { id: JSON.stringify(id) }));
    }
  }

  private gistUrl(): string {
    return this.o.apiBaseUrl + '/gists/' + this.o.gistId;
  }

  private snapshotFileName(id: string): string {
    return this.o.filePrefix + '-' + id + '.json';
  }

  /** 读取一次 token（失败 → 空串：请求按未认证失败，原因如实带回） */
  private async tokenOnce(): Promise<string> {
    try {
      return await this.o.credentials.getToken();
    } catch {
      return '';
    }
  }

  /** 发送一次请求（注入 GitHub 认证头）；网络错误/超时归一 */
  private async send(
    method: string,
    url: string,
    token: string,
    opts: { body?: string; raw?: boolean; headers?: Record<string, string> } = {},
  ): Promise<GistResponse> {
    const headers: Record<string, string> = opts.raw === true
      ? { accept: 'application/vnd.github.raw', 'User-Agent': 'DSH-Config-Manager (Gist Client)' }
      : {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...(token !== '' ? { authorization: 'Bearer ' + token } : {}),
        // 条件写的 if-match 从这里注入（cloud-sync 借鉴项 ①）
        ...(opts.headers ?? {}),
      };
    try {
      return await this.o.request(method, url, {
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        timeoutMs: this.o.timeoutMs,
      });
    } catch (err) {
      if (this.isTimeout(err)) {
        throw new GistTransportError(
          this.o.msg('sync.gist.timeout', { method, url, timeout: String(this.o.timeoutMs) }),
          { kind: 'timeout', retryable: true, cause: err },
        );
      }
      const rawMsg = err instanceof Error
        ? (err.cause ? err.message + ' (' + String((err.cause as Error).message ?? err.cause) + ')' : err.message)
        : String(err);
      throw new GistTransportError(
        this.o.msg('sync.gist.requestError', { method, url, err: this.mask(rawMsg, token) }),
        { ...classifyNetworkErrorText(rawMsg), cause: err },
      );
    }
  }

  /** 读 gist（含全部文件条目）；404 → 明确「gist 不存在或无权访问」 */
  private async readGistFiles(token: string): Promise<Record<string, GistFileEntry>> {
    return (await this.readGist(token)).files;
  }

  /**
   * 读 gist 全量文件 + 响应 ETag（ETag 供**条件写**用，cloud-sync 借鉴项 ①）。
   * GitHub 对 gist 返回的是**弱 ETag**（W/"…"）—— HTTP 禁止用它做 If-Match（GitHub 会回 400），
   * 因此弱 ETag 一律不采用（返回 undefined = 退化为无条件写），由 conditionalPatchHeaders 统一判定。
   */
  private async readGist(token: string): Promise<{ files: Record<string, GistFileEntry>; etag?: string }> {
    const url = this.gistUrl();
    const res = await this.send('GET', url, token);
    if (res.status === 404) {
      throw new GistTransportError(
        this.o.msg('sync.gist.gistMissing', { id: this.o.gistId, status: '404' }),
        { kind: 'notfound', retryable: false, status: 404 },
      );
    }
    if (!res.ok) {
      const body = await this.safeText(res);
      throw new GistTransportError(await this.failText('GET', url, res, token, body), this.classify(res.status, body));
    }
    let parsed: unknown;
    try {
      parsed = parseJsonSafe(await res.text());
    } catch (err) {
      throw new GistTransportError(
        this.o.msg('sync.gist.indexInvalid', { url, err: this.mask(String((err as Error)?.message ?? ''), token) }),
        { kind: 'protocol', retryable: false },
      );
    }
    const files = (parsed as { files?: unknown } | null)?.files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
      throw new GistTransportError(
        this.o.msg('sync.gist.indexInvalid', { url, err: 'files missing' }),
        { kind: 'protocol', retryable: false },
      );
    }
    const rawEtag = res.headers?.['etag'];
    const etag = typeof rawEtag === 'string' && rawEtag !== '' && !rawEtag.startsWith('W/') ? rawEtag : undefined;
    return {
      files: files as Record<string, GistFileEntry>,
      ...(etag !== undefined ? { etag } : {}),
    };
  }

  /**
   * 取某个文件的内容：gist 载荷里直接有就用它；被 GitHub 截断（\`truncated\`）或内容缺失时
   * 回落 \`raw_url\` 重新下载（跨源跳转剥离 Authorization —— gh 的 raw 地址本身不可猜）。
   * 文件不存在 → null（调用方按各自语义处理）。
   */
  private async readFileText(
    files: Record<string, GistFileEntry>,
    fileName: string,
    token: string,
  ): Promise<string | null> {
    const entry = files[fileName];
    if (entry === undefined) return null;
    if (entry.truncated !== true && typeof entry.content === 'string') return entry.content;
    const rawUrl = typeof entry.raw_url === 'string' && entry.raw_url !== '' ? entry.raw_url : '';
    if (rawUrl === '') {
      throw new GistTransportError(
        this.o.msg('sync.gist.contentTruncated', { file: fileName, err: 'raw_url missing' }),
        { kind: 'protocol', retryable: false },
      );
    }
    return await this.fetchRaw(rawUrl, fileName, token);
  }

  /** 下载 raw 内容（最多跟随 MAX_REDIRECTS 跳；raw 请求不带 token） */
  private async fetchRaw(rawUrl: string, fileName: string, token: string): Promise<string> {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await this.send('GET', url, '', { raw: true });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers?.['location'];
        if (typeof location === 'string' && location !== '') {
          try {
            url = new URL(location, url).toString();
            continue;
          } catch {
            /* Location 非法 → 当作最终响应处理 */
          }
        }
      }
      if (!res.ok) {
        throw new GistTransportError(
          this.o.msg('sync.gist.rawFetchFailed', { url, status: String(res.status) }),
          { ...classifyHttpStatus(res.status), status: res.status },
        );
      }
      return await res.text();
    }
    throw new GistTransportError(
      this.o.msg('sync.gist.tooManyRedirects', { url: rawUrl, n: String(MAX_REDIRECTS) }),
      { kind: 'protocol', retryable: false },
    );
  }

  private parseIndex(raw: string, url: string, token: string): SyncSnapshotMeta[] {
    let parsed: unknown;
    try {
      parsed = parseJsonSafe(raw);
    } catch (err) {
      throw new GistTransportError(
        this.o.msg('sync.gist.indexInvalid', { url, err: this.mask(String((err as Error)?.message ?? ''), token) }),
        { kind: 'protocol', retryable: false },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new GistTransportError(
        this.o.msg('sync.gist.indexInvalid', { url, err: 'not an array' }),
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
      throw new GistTransportError(
        this.o.msg('sync.gist.indexInvalid', { url, err: 'invalid entry' }),
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
      throw new GistTransportError(
        this.o.msg('sync.gist.snapshotInvalid', { id, err: this.mask(String((err as Error)?.message ?? ''), '') }),
        { kind: 'protocol', retryable: false },
      );
    }
  }

  /** HTTP 状态 + 响应体 → 错误分类（GitHub 的限流是 403 + rate limit 文案 → 当可重试的 server 故障） */
  private classify(status: number, body: string): SyncTransportErrorOptions {
    if (status === 403 && /rate limit|secondary rate/i.test(body)) {
      return { kind: 'server', retryable: true, status };
    }
    return classifyHttpStatus(status);
  }

  /** 读响应体（失败 → 空串；不因读体失败而丢掉真正的 HTTP 状态原因） */
  private async safeText(res: GistResponse): Promise<string> {
    try {
      return (await res.text()).slice(0, ERR_BODY_MAX);
    } catch {
      return '';
    }
  }

  private async failText(
    method: string,
    url: string,
    res: GistResponse,
    token: string,
    prefetched?: string,
  ): Promise<string> {
    const body = prefetched ?? await this.safeText(res);
    return this.o.msg('sync.gist.requestFailed', {
      method,
      url,
      status: String(res.status),
      err: this.mask(body, token),
    });
  }

  private isTimeout(err: unknown): boolean {
    const name = (err as Error | undefined)?.name ?? '';
    if (name === 'TimeoutError') return true;
    if (name === 'AbortError') return true;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && name === 'AbortError') return true;
    return false;
  }

  /** 错误消息脱敏：token（原文与 URL 编码形态）一律替换 */
  private mask(text: string, token: string): string {
    if (!token) return text;
    let out = text.split(token).join(REDACTED);
    out = out.split(encodeURIComponent(token)).join(REDACTED);
    return out;
  }
}
