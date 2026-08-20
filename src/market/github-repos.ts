/**
 * m-market：GitHub REST API 薄客户端 GitHubAuthRest（docs/design/2026-08-20-my-configs-design.md §4.2）。
 *
 * 职责：账户级元操作 ——
 *   getUser()                  验证 token（GET /user）并取回登录名；
 *   repoExists()               判断仓库是否存在（200 / 404）；
 *   createPublicRepo()         创建公开仓库（POST /user/repos，public + auto_init）；
 *   ensureFork()               复用用户已 fork 的仓库 / 新建 fork 并轮询就绪（fork 异步创建）；
 *   readFile()                 读仓库内文本文件（contents API，base64 解码）；
 *   openPullRequest()          开 PR（POST /pulls；缺省目标 = 固定官方收录仓库）；
 *   listOpenPullRequests()     列 open PR（可带 head 过滤，如 `<login>:<branch>`）。
 *
 * 与 GitTransport 的分工：本模块只做 REST 元操作；内容推送（clone → 写文件 → commit →
 * push）走 GitTransport（token 经 credentials resolve，永不进 URL / 日志 / 浏览器）。
 *
 * 安全不变量（与 src/sync/github-auth.ts 同款纪律）：
 * - token 只经 Authorization 头传递，绝不进入 URL / 请求体 / 错误消息 / 返回值；
 * - 所有错误消息（含网络异常原文、GitHub 错误体回显内容）统一过 redact() 幂等脱敏，
 *   token 形态（ghp_/gho_/github_pat_/Bearer 等）必被掩码；
 * - token 缺失（空串）→ 明确错误（code='no_token'），由上层映射为「未登录」；
 * - 仓库 URL（cloneUrl / htmlUrl）为 https 形态，绝不拼接凭据。
 *
 * 依赖注入：tokenProvider 必填；fetcher / now / 轮询参数可注入，测试全程 mock 不碰真实网络。
 */
import { redact } from '../security/redaction.ts';

/** GitHub REST API v3 基址 */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * 官方收录目标仓库（产品决策 2026-08-20，docs/design/2026-08-20-my-configs-design.md §2.4）：
 * 收录 / PR 相关目标**固定**为 xiajiajun516/dsh-config-market，写死常量、界面不提供任何修改入口。
 * 与 src/market/builtin.ts 的内置市场为同一仓库（内置市场 URL 可经 env 覆盖仅用于浏览，
 * 收录目标不受 env 影响，恒为官方仓库）。
 */
export const MARKET_UPSTREAM_OWNER = 'xiajiajun516';
/** 官方收录目标仓库名（见 MARKET_UPSTREAM_OWNER） */
export const MARKET_UPSTREAM_REPO = 'dsh-config-market';

/** fork 异步创建轮询缺省间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** fork 异步创建轮询缺省超时（毫秒）：超时抛可重试错误 */
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** GET /user 的投影（只保留编排 / UI 需要的最小字段，不携带任何凭据） */
export interface GitHubUserInfo {
  login: string;
  id: number;
  name?: string;
}

/** 仓库元信息投影（cloneUrl 为 https 形态，token 绝不拼入） */
export interface GitHubRepoInfo {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
}

/** fork 就绪后的元信息（ensureFork 返回；cloneUrl 供 GitTransport 使用） */
export interface GitHubForkInfo {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

/** PR 信息投影（openPullRequest / listOpenPullRequests 返回） */
export interface GitHubPullRequestInfo {
  number: number;
  htmlUrl: string;
  title: string;
  /** PR 源分支（head.ref；跨仓库 head 过滤的 `<login>:<branch>` 拼接由调用方负责） */
  head: string;
  state: string;
  merged: boolean;
}

/** POST /pulls 入参；owner/repo 缺省指向固定官方收录仓库（MARKET_UPSTREAM_OWNER/REPO） */
export interface GitHubPullRequestParams {
  base: string;
  head: string;
  title: string;
  body?: string;
  owner?: string;
  repo?: string;
}

/** GitHubAuthRest 构造选项：tokenProvider 必填，其余全部可注入（测试 mock 用） */
export interface GitHubAuthRestOptions {
  /** 取当前 GitHub access token（宿主侧经 credentials.resolve(credentialRef(...)) 提供） */
  tokenProvider: () => Promise<string>;
  /** 可注入 fetcher（测试 mock 用）；缺省 = global fetch */
  fetcher?: typeof fetch;
  /** 可注入时钟（epoch ms；fork 轮询超时判定用）；缺省 = Date.now */
  now?: () => number;
  /** fork 就绪轮询间隔（毫秒）；缺省 2000；测试可设 0 避免真实等待 */
  pollIntervalMs?: number;
  /** fork 就绪轮询超时（毫秒）；缺省 60000 */
  pollTimeoutMs?: number;
}

/**
 * GitHub REST 可预期错误：status = HTTP 状态（网络层 / 内部错误无），code 可分类消费。
 * message 已过 redact() 脱敏，绝不内嵌 token 形态内容。
 */
export class GitHubApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
  }
}

/* ---------------------------------------------------------------- 响应解析小工具 */

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubApiError('GitHub API 返回了无法识别的数据结构', 'invalid_response');
  }
  return value as Record<string, unknown>;
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') {
    throw new GitHubApiError(`GitHub API 响应缺少必要字段 ${key}`, 'invalid_response');
  }
  return v;
}

function getOptStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function getNum(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new GitHubApiError(`GitHub API 响应缺少必要字段 ${key}`, 'invalid_response');
  }
  return v;
}

function getBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new GitHubApiError(`GitHub API 响应缺少必要字段 ${key}`, 'invalid_response');
  }
  return v;
}

/** 嵌套 owner.login（owner 可能为 null —— fork 异步创建期间未就绪） */
function ownerLoginOf(obj: Record<string, unknown>): string | undefined {
  const owner = obj['owner'];
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return undefined;
  const login = (owner as Record<string, unknown>)['login'];
  return typeof login === 'string' && login !== '' ? login : undefined;
}

/** 路径片段编码（owner/repo/ref 单段） */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/** 仓库内文件路径编码（逐段编码，保留 '/' 层级；contents API 路径） */
function segPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 GitHub REST 错误响应（或任意非 2xx）归类为可消费的 code */
function classifyErrorCode(status: number, rateLimited: boolean): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return rateLimited ? 'rate_limited' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation_failed';
  if (status >= 500) return 'server_error';
  return `http_${status}`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 仓库 JSON → GitHubRepoInfo（缺 default_branch 时按 'main' 兜底；owner 嵌套对象未就绪时无碍） */
function toRepoInfo(data: unknown): GitHubRepoInfo {
  const obj = asRecord(data);
  const fullName = getStr(obj, 'full_name');
  return {
    fullName,
    htmlUrl: getStr(obj, 'html_url'),
    cloneUrl: getOptStr(obj, 'clone_url') ?? `https://github.com/${fullName}.git`,
    defaultBranch: getOptStr(obj, 'default_branch') ?? 'main',
    private: getBool(obj, 'private'),
    fork: getBool(obj, 'fork'),
  };
}

/** PR JSON → GitHubPullRequestInfo（head.ref 缺失时置空串） */
function toPullInfo(data: unknown): GitHubPullRequestInfo {
  const obj = asRecord(data);
  const headObj = obj['head'];
  let headRef = '';
  if (headObj !== null && typeof headObj === 'object' && !Array.isArray(headObj)) {
    const ref = (headObj as Record<string, unknown>)['ref'];
    if (typeof ref === 'string') headRef = ref;
  }
  return {
    number: getNum(obj, 'number'),
    htmlUrl: getStr(obj, 'html_url'),
    title: getOptStr(obj, 'title') ?? '',
    head: headRef,
    state: getOptStr(obj, 'state') ?? 'open',
    merged: getBool(obj, 'merged'),
  };
}

/* ---------------------------------------------------------------- GitHubAuthRest */

/**
 * GitHub REST 薄客户端。
 * 无状态（token 由 tokenProvider 每次现取），fetch / 时钟 / 轮询参数可注入。
 */
export class GitHubAuthRest {
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: GitHubAuthRestOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  /** 验证 token 并取回当前用户（/me/status 与 ensureFork 的前置）。401 → unauthorized。 */
  async getUser(): Promise<GitHubUserInfo> {
    const data = await this.requestJson('GET', '/user');
    const obj = asRecord(data);
    return { login: getStr(obj, 'login'), id: getNum(obj, 'id'), name: getOptStr(obj, 'name') };
  }

  /** 仓库是否存在：200 → true；404 → false；其余状态抛 GitHubApiError。 */
  async repoExists(owner: string, repo: string): Promise<boolean> {
    const response = await this.request(`/repos/${seg(owner)}/${seg(repo)}`, { method: 'GET' });
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw await this.apiError(response);
  }

  /** 创建公开仓库（POST /user/repos；private:false + auto_init:true 保证有初始 commit 可 clone）。 */
  async createPublicRepo(name: string, description?: string): Promise<GitHubRepoInfo> {
    const body: Record<string, unknown> = { name, private: false, auto_init: true };
    if (description !== undefined && description !== '') body['description'] = description;
    const data = await this.requestJson('POST', '/user/repos', body);
    return toRepoInfo(data);
  }

  /**
   * 确保存在「当前用户 fork 的 <owner>/<repo>」：
   * 1. 优先复用：列出上游仓库 forks，命中 owner.login === 当前登录名的 fork → 直接返回；
   * 2. 否则创建 fork（POST /forks，异步）并轮询 GET /repos/<login>/<repo> 直到就绪
   *    （owner.login 匹配 + fork:true）；超时抛可重试错误（fork_timeout）。
   */
  async ensureFork(owner: string, repo: string): Promise<GitHubForkInfo> {
    const me = await this.getUser();
    const existing = await this.findUserFork(owner, repo, me.login);
    if (existing !== null) return existing;
    await this.createFork(owner, repo);
    return this.waitForkReady(me.login, repo);
  }

  /**
   * 读仓库内文本文件（contents API，base64 解码为 UTF-8）。
   * 404（文件不存在）→ null；路径是目录 / 非文件 → not_a_file；其余错误抛 GitHubApiError。
   */
  async readFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const query = ref !== undefined && ref !== '' ? `?ref=${encodeURIComponent(ref)}` : '';
    const response = await this.request(
      `/repos/${seg(owner)}/${seg(repo)}/contents/${segPath(path)}${query}`,
      { method: 'GET' },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await this.apiError(response);
    const data = await safeParseJson(response);
    const obj = asRecord(data);
    if (obj['type'] !== 'file') {
      throw new GitHubApiError('GitHub contents 路径不是文件（目录 / 子模块不可作为文本读取）', 'not_a_file');
    }
    const content = obj['content'];
    const encoding = obj['encoding'];
    // 允许空串（0 字节空文件 GitHub 返回 content:""）；缺失/非 string 才是异常
    if (typeof content !== 'string') {
      throw new GitHubApiError('GitHub contents 响应缺少文件内容', 'invalid_response');
    }
    if (typeof encoding === 'string' && encoding !== '' && encoding !== 'base64') {
      throw new GitHubApiError(`不支持的 contents 编码：${encoding}`, 'invalid_response');
    }
    return Buffer.from(content, 'base64').toString('utf8');
  }

  /** 开 PR（POST /pulls）；owner/repo 缺省 = 固定官方收录仓库。 */
  async openPullRequest(params: GitHubPullRequestParams): Promise<GitHubPullRequestInfo> {
    const owner = params.owner ?? MARKET_UPSTREAM_OWNER;
    const repo = params.repo ?? MARKET_UPSTREAM_REPO;
    const body: Record<string, unknown> = { title: params.title, head: params.head, base: params.base };
    if (params.body !== undefined && params.body !== '') body['body'] = params.body;
    const data = await this.requestJson('POST', `/repos/${seg(owner)}/${seg(repo)}/pulls`, body);
    return toPullInfo(data);
  }

  /** 列 open PR（GET /pulls?state=open）；head 可选（跨仓库形态 `<login>:<branch>`，URL 编码传入）。 */
  async listOpenPullRequests(owner: string, repo: string, head?: string): Promise<GitHubPullRequestInfo[]> {
    const query = new URLSearchParams();
    query.set('state', 'open');
    query.set('per_page', '100');
    if (head !== undefined && head !== '') query.set('head', head);
    const data = await this.requestJson('GET', `/repos/${seg(owner)}/${seg(repo)}/pulls?${query.toString()}`);
    if (!Array.isArray(data)) {
      throw new GitHubApiError('GitHub pulls 响应不是数组', 'invalid_response');
    }
    return data.map((item) => toPullInfo(item));
  }

  /* ---------------------------------------------------------------- 内部实现 */

  /** 上游仓库 forks 列表命中当前用户 → 返回 fork 信息；否则 null。 */
  private async findUserFork(owner: string, repo: string, login: string): Promise<GitHubForkInfo | null> {
    const data = await this.requestJson('GET', `/repos/${seg(owner)}/${seg(repo)}/forks?per_page=100&sort=newest`);
    if (!Array.isArray(data)) {
      throw new GitHubApiError('GitHub forks 响应不是数组', 'invalid_response');
    }
    for (const item of data) {
      const obj = asRecord(item);
      if (ownerLoginOf(obj) === login) {
        const fullName = getStr(obj, 'full_name');
        return {
          fullName,
          htmlUrl: getStr(obj, 'html_url'),
          cloneUrl: getOptStr(obj, 'clone_url') ?? `https://github.com/${fullName}.git`,
          defaultBranch: getOptStr(obj, 'default_branch') ?? 'main',
        };
      }
    }
    return null;
  }

  /** 创建 fork（POST /forks）。GitHub 异步执行，返回 202/200 即视为已接受，就绪状态由轮询确认。 */
  private async createFork(owner: string, repo: string): Promise<void> {
    const response = await this.request(`/repos/${seg(owner)}/${seg(repo)}/forks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw await this.apiError(response);
  }

  /** 轮询 GET /repos/<login>/<repo> 直到 fork 就绪（owner.login 匹配 + fork:true + 有默认分支）。 */
  private async waitForkReady(login: string, repo: string): Promise<GitHubForkInfo> {
    const deadline = this.now() + this.pollTimeoutMs;
    for (;;) {
      const response = await this.request(`/repos/${seg(login)}/${seg(repo)}`, { method: 'GET' });
      if (response.ok) {
        const info = await this.tryReadForkInfo(response);
        if (info !== null) return info;
      } else if (response.status !== 404) {
        throw await this.apiError(response);
      }
      if (this.now() >= deadline) {
        throw new GitHubApiError('fork 创建超时（GitHub 异步创建，请稍后重试）', 'fork_timeout');
      }
      await delay(this.pollIntervalMs);
    }
  }

  /** 解析一次轮询响应；未就绪（结构不完整 / owner 未出现）→ null 继续等。 */
  private async tryReadForkInfo(response: Response): Promise<GitHubForkInfo | null> {
    try {
      const data = await safeParseJson(response);
      const obj = asRecord(data);
      const login = ownerLoginOf(obj);
      const fullName = getStr(obj, 'full_name');
      if (login === undefined || getBool(obj, 'fork') !== true) return null;
      return {
        fullName,
        htmlUrl: getStr(obj, 'html_url'),
        cloneUrl: getOptStr(obj, 'clone_url') ?? `https://github.com/${fullName}.git`,
        defaultBranch: getOptStr(obj, 'default_branch') ?? 'main',
      };
    } catch {
      return null; // 未就绪 / 结构异常 → 按未就绪继续轮询
    }
  }

  /** 统一请求管道：注入 token（Bearer 头）、Accept、API 版本；网络异常 → network_error（消息脱敏）。 */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.tokenProvider();
    if (typeof token !== 'string' || token === '') {
      throw new GitHubApiError('GitHub token 未配置（请先登录）', 'no_token');
    }
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-github-api-version', '2022-11-28');
    let response: Response;
    try {
      response = await this.fetcher(GITHUB_API_BASE + path, { ...init, headers });
    } catch (err) {
      throw new GitHubApiError(
        `GitHub API 请求失败：${redact(err instanceof Error ? err.message : String(err))}`,
        'network_error',
      );
    }
    return response;
  }

  /** 请求 + 2xx 校验 + JSON 解析（空体 → undefined）。非 2xx → apiError。 */
  private async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method };
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    const response = await this.request(path, { ...init, headers });
    if (!response.ok) throw await this.apiError(response);
    return safeParseJson(response);
  }

  /** 非 2xx → 分类 GitHubApiError：提取 GitHub message + 脱敏（token 形态必被掩码）。 */
  private async apiError(response: Response): Promise<GitHubApiError> {
    const status = response.status;
    const bodyText = await safeResponseText(response);
    let ghMessage = '';
    if (bodyText !== '') {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const m = (parsed as Record<string, unknown>)['message'];
          if (typeof m === 'string' && m !== '') ghMessage = m;
        }
      } catch {
        // 非 JSON 错误体：只保留状态码
      }
    }
    const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
    const code = classifyErrorCode(status, rateLimited);
    const detail = ghMessage !== '' ? `：${ghMessage}` : '';
    return new GitHubApiError(redact(`GitHub API 错误（HTTP ${status}）${detail}`), code, status);
  }
}

/** 解析 JSON 响应体；空体 → undefined；非法 JSON → invalid_response。 */
async function safeParseJson(response: Response): Promise<unknown> {
  const text = await safeResponseText(response);
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubApiError('GitHub API 返回了无法解析的响应，请稍后重试', 'invalid_response', response.status);
  }
}
