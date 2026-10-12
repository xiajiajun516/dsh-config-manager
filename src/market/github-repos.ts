/**
 * m-market：GitHub REST API 薄客户端 GitHubAuthRest（docs/design/2026-08-20-my-configs-design.md §4.2）。
 *
 * 职责：账户级元操作 ——
 *   getUser()                  验证 token（GET /user）并取回登录名；
 *   repoExists()               判断仓库是否存在（200 / 404）；
 *   createPublicRepo()         创建公开仓库（POST /user/repos，public + auto_init）；
 *   createRepo()               创建仓库（可指定 private；createPublicRepo 的通用形态）；
 *   listRepos()                列当前用户可见仓库（GET /user/repos，按最近更新排序）；
 *   ensureFork()               直查用户同名仓库复用已 fork / 新建 fork 并轮询就绪（fork 异步创建）；
 *   readFile()                 读仓库内文本文件（contents API，base64 解码）；
 *   getRepoStars()             读仓库 star 数（带 token；「我的配置」页用）；
 *   getRepoStarsPublic()       读仓库 star 数（**匿名，不注入 token**；市场浏览用，
 *                              守住「市场端点零凭据」安全不变式）；
 *   openPullRequest()          开 PR（POST /pulls；缺省目标 = 固定官方收录仓库）；
 *   closePullRequest()         关闭 PR（PATCH /pulls/{number}，state=closed）；
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
import { defaultFetcher } from '../utils/proxy.ts';
// 官方收录目标常量抽到零依赖模块（client 半也要用；见 upstream.ts 注释：
// 从本文件导入会把 node:https 拉进浏览器 bundle，导致插件加载失败）。
// 同时 import（本文件内部要用）与 export（保持既有导入路径的向后兼容）。
import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from './upstream.ts';
import { marketMsg } from './messages-market.ts';

export { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO };

/** GitHub REST API v3 基址 */
export const GITHUB_API_BASE = 'https://api.github.com';

/** fork 异步创建轮询缺省间隔（毫秒）：后台收录模式下放宽粒度，减少 API 调用 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** fork 异步创建轮询缺省超时（毫秒）：GitHub 首次 fork 需复制仓库内容，可能超过 60s；
 *  异步收录后不阻塞用户请求，300s 作保险兜底，超时后抛可重试错误 */
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

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

/** 仓库列表条目投影（listRepos 返回；比 GitHubRepoInfo 多两个时间戳，供排序与展示） */
export interface GitHubRepoSummary {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  /** 最近一次 push 时间（ISO 8601；GitHub 对空仓库返回 null → 空串） */
  pushedAt: string;
  /** 最近一次更新时间（ISO 8601；缺失 → 空串） */
  updatedAt: string;
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
  /** fork 就绪轮询间隔（毫秒）；缺省 5000；测试可设 0 避免真实等待 */
  pollIntervalMs?: number;
  /** fork 就绪轮询超时（毫秒）；缺省 300000（后台异步收录，不阻塞用户） */
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
    throw new GitHubApiError(marketMsg('market.github.invalidResponseShape'), 'invalid_response');
  }
  return value as Record<string, unknown>;
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') {
    throw new GitHubApiError(marketMsg('market.github.missingField', { key }), 'invalid_response');
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
    throw new GitHubApiError(marketMsg('market.github.missingField', { key }), 'invalid_response');
  }
  return v;
}

function getBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new GitHubApiError(marketMsg('market.github.missingField', { key }), 'invalid_response');
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

/** 嵌套 parent.full_name（非 fork 仓库 parent 为 null；fork 的 parent 是直接上游） */
function parentFullNameOf(obj: Record<string, unknown>): string | undefined {
  const parent = obj['parent'];
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
  const fullName = (parent as Record<string, unknown>)['full_name'];
  return typeof fullName === 'string' && fullName !== '' ? fullName : undefined;
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

/** 非 JSON 错误体带进提示时的截断上限（避免把整页 HTML 灌进 UI） */
const MAX_ERROR_BODY_CHARS = 200;

/**
 * 非 JSON 错误体 → 单行提示文本（GitHub 前置层拒绝无 User-Agent 的请求时就是**纯文本** 403，
 * 只给状态码等于把唯一线索丢掉；issue #86）。压缩空白 + 截断，调用方仍会整体过 redact()。
 */
function plainErrorText(bodyText: string): string {
  const collapsed = bodyText.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ERROR_BODY_CHARS
    ? `${collapsed.slice(0, MAX_ERROR_BODY_CHARS)}…`
    : collapsed;
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

/** 仓库 JSON → GitHubRepoSummary（时间戳缺失 / null 时置空串，UI 按「未知」处理） */
function toRepoSummary(data: unknown): GitHubRepoSummary {
  const obj = asRecord(data);
  const fullName = getStr(obj, 'full_name');
  return {
    fullName,
    htmlUrl: getStr(obj, 'html_url'),
    cloneUrl: getOptStr(obj, 'clone_url') ?? `https://github.com/${fullName}.git`,
    defaultBranch: getOptStr(obj, 'default_branch') ?? 'main',
    private: getBool(obj, 'private'),
    fork: getBool(obj, 'fork'),
    pushedAt: getOptStr(obj, 'pushed_at') ?? '',
    updatedAt: getOptStr(obj, 'updated_at') ?? '',
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
    this.fetcher = options.fetcher ?? defaultFetcher();
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
    return this.createRepo(name, description !== undefined ? { description } : {});
  }

  /**
   * 创建仓库（POST /user/repos）。private 缺省 false（保持既有语义）；auto_init:true 保证有初始
   * commit，clone 后立即有 HEAD 可提交（同步通道 push 的前置条件）。
   * createPublicRepo 是本方法的公开仓库特例（保留原签名以兼容既有调用方）。
   */
  async createRepo(
    name: string,
    options: { private?: boolean; description?: string } = {},
  ): Promise<GitHubRepoInfo> {
    const body: Record<string, unknown> = { name, private: options.private === true, auto_init: true };
    const description = options.description;
    if (description !== undefined && description !== '') body['description'] = description;
    const data = await this.requestJson('POST', '/user/repos', body);
    return toRepoInfo(data);
  }

  /**
   * 列当前用户可见的仓库（GET /user/repos，含私有；需要 token）。
   * 固定 sort=updated + per_page=100（REST 单页上限）：同步通道只需要「最近还在用的仓库」，
   * 翻页会带来额外请求与列表 UI 复杂度，因此只取第一页并按 limit 显式截断。
   */
  async listRepos(limit: number = 100): Promise<GitHubRepoSummary[]> {
    const query = new URLSearchParams();
    query.set('sort', 'updated');
    query.set('per_page', '100');
    const data = await this.requestJson('GET', `/user/repos?${query.toString()}`);
    if (!Array.isArray(data)) {
      throw new GitHubApiError(marketMsg('market.github.reposNotArray'), 'invalid_response');
    }
    const cap = Math.min(Math.max(limit, 1), 100);
    return data.slice(0, cap).map((item) => toRepoSummary(item));
  }

  /**
   * 确保存在「当前用户 fork 的 <owner>/<repo>」：
   * 1. 优先复用：直查 GET /repos/<login>/<repo>，校验 fork:true + parent.full_name 匹配
   *    （不翻上游 forks 分页列表，避免 per_page=100 上限下旧 fork 被挤出首页而漏检）→ 直接返回；
   * 2. 否则创建 fork（POST /forks，异步）并轮询 GET /repos/<login>/<repo> 直到就绪
   *    （owner.login 匹配 + fork:true + parent 匹配）；超时抛可重试错误（fork_timeout）。
   */
  async ensureFork(owner: string, repo: string): Promise<GitHubForkInfo> {
    const me = await this.getUser();
    const existing = await this.findOwnFork(owner, repo, me.login);
    if (existing !== null) return existing;
    await this.createFork(owner, repo);
    return this.waitForkReady(me.login, repo, owner);
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
      throw new GitHubApiError(marketMsg('market.github.notAFile'), 'not_a_file');
    }
    const content = obj['content'];
    const encoding = obj['encoding'];
    // 允许空串（0 字节空文件 GitHub 返回 content:""）；缺失/非 string 才是异常
    if (typeof content !== 'string') {
      throw new GitHubApiError(marketMsg('market.github.missingFileContent'), 'invalid_response');
    }
    if (typeof encoding === 'string' && encoding !== '' && encoding !== 'base64') {
      throw new GitHubApiError(marketMsg('market.github.unsupportedEncoding', { encoding }), 'invalid_response');
    }
    return Buffer.from(content, 'base64').toString('utf8');
  }

  /**
   * 读仓库 star 数（stargazers_count）。带 token 通道（「我的配置」页用，登录态 5000 次/小时）。
   * 404（仓库不存在）→ null；其余错误抛 GitHubApiError。
   */
  async getRepoStars(owner: string, repo: string): Promise<number | null> {
    const response = await this.request(`/repos/${seg(owner)}/${seg(repo)}`, { method: 'GET' });
    return this.parseStars(response);
  }

  /**
   * 读仓库 star 数（stargazers_count）。**匿名通道（不注入 token）** —— 市场浏览页专用：
   * `/market/browse` 不触碰任何凭据（安全不变式：市场端点无 token），star 属公开数据，
   * 匿名 REST 限额（60 次/小时）配合 StarCache 去重 + TTL 足够。404 → null。
   */
  async getRepoStarsPublic(owner: string, repo: string): Promise<number | null> {
    const response = await this.requestPublic(`/repos/${seg(owner)}/${seg(repo)}`, { method: 'GET' });
    return this.parseStars(response);
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

  /** 关闭 PR（PATCH /pulls/{number}，state=closed）；返回关闭后的 PR 信息。 */
  async closePullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequestInfo> {
    const data = await this.requestJson('PATCH', `/repos/${seg(owner)}/${seg(repo)}/pulls/${number}`, { state: 'closed' });
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
      throw new GitHubApiError(marketMsg('market.github.pullsNotArray'), 'invalid_response');
    }
    return data.map((item) => toPullInfo(item));
  }

  /* ---------------------------------------------------------------- 内部实现 */

  /**
   * 直查用户自己的同名仓库（GET /repos/<login>/<repo>）判断是否已是本上游的 fork：
   * - 404 → null（无 fork，需创建）；
   * - 200 + fork:true + parent.full_name 匹配 → 返回 fork 信息（复用）；
   * - 200 + fork:false 或 parent 不匹配（同名但非本上游 fork）→ 抛 fork_name_conflict
   *   （此时既不能复用也不能再 fork——同名仓库已存在，GitHub 会以同名冲突拒绝）。
   */
  private async findOwnFork(owner: string, repo: string, login: string): Promise<GitHubForkInfo | null> {
    const response = await this.request(`/repos/${seg(login)}/${seg(repo)}`, { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.apiError(response);
    return this.tryReadOwnFork(response, owner, repo);
  }

  /** 解析直查响应并校验「是本上游的 fork」；不满足 → fork_name_conflict。 */
  private async tryReadOwnFork(response: Response, owner: string, repo: string): Promise<GitHubForkInfo> {
    const data = await safeParseJson(response);
    const obj = asRecord(data);
    const isFork = getBool(obj, 'fork');
    const parentName = parentFullNameOf(obj);
    if (isFork !== true || parentName !== `${owner}/${repo}`) {
      throw new GitHubApiError(
        marketMsg('market.github.forkNameConflict'),
        'fork_name_conflict',
      );
    }
    const fullName = getStr(obj, 'full_name');
    return {
      fullName,
      htmlUrl: getStr(obj, 'html_url'),
      cloneUrl: getOptStr(obj, 'clone_url') ?? `https://github.com/${fullName}.git`,
      defaultBranch: getOptStr(obj, 'default_branch') ?? 'main',
    };
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

  /** 轮询 GET /repos/<login>/<repo> 直到 fork 就绪（owner.login 匹配 + fork:true + parent 匹配）。 */
  private async waitForkReady(login: string, repo: string, owner: string): Promise<GitHubForkInfo> {
    const deadline = this.now() + this.pollTimeoutMs;
    for (;;) {
      const response = await this.request(`/repos/${seg(login)}/${seg(repo)}`, { method: 'GET' });
      if (response.ok) {
        const info = await this.tryReadForkInfo(response, owner, repo);
        if (info !== null) return info;
      } else if (response.status !== 404) {
        throw await this.apiError(response);
      }
      if (this.now() >= deadline) {
        throw new GitHubApiError(marketMsg('market.github.forkTimeout'), 'fork_timeout');
      }
      await delay(this.pollIntervalMs);
    }
  }

  /** 解析一次轮询响应；未就绪（结构不完整 / owner 未出现 / parent 未匹配）→ null 继续等。 */
  private async tryReadForkInfo(response: Response, owner: string, repo: string): Promise<GitHubForkInfo | null> {
    try {
      const data = await safeParseJson(response);
      const obj = asRecord(data);
      const login = ownerLoginOf(obj);
      const fullName = getStr(obj, 'full_name');
      const parentName = parentFullNameOf(obj);
      if (login === undefined || getBool(obj, 'fork') !== true || parentName !== `${owner}/${repo}`) return null;
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
      throw new GitHubApiError(marketMsg('market.github.noToken'), 'no_token');
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
        marketMsg('market.github.requestFailed', { reason: redact(err instanceof Error ? err.message : String(err)) }),
        'network_error',
      );
    }
    return response;
  }

  /**
   * 匿名请求管道（**不注入 token / authorization 头**）：仅用于读取公开数据
   * （仓库 star 数等），守住「市场端点零凭据」安全不变式。网络异常 → network_error（消息脱敏）。
   */
  private async requestPublic(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('x-github-api-version', '2022-11-28');
    let response: Response;
    try {
      response = await this.fetcher(GITHUB_API_BASE + path, { ...init, headers });
    } catch (err) {
      throw new GitHubApiError(
        marketMsg('market.github.requestFailed', { reason: redact(err instanceof Error ? err.message : String(err)) }),
        'network_error',
      );
    }
    return response;
  }

  /** 解析仓库响应 → stargazers_count（非负有限数）；404 → null；缺失/非法 → invalid_response。 */
  private async parseStars(response: Response): Promise<number | null> {
    if (response.status === 404) return null;
    if (!response.ok) throw await this.apiError(response);
    const data = await safeParseJson(response);
    const obj = asRecord(data);
    const stars = obj['stargazers_count'];
    if (typeof stars !== 'number' || !Number.isFinite(stars) || stars < 0) {
      throw new GitHubApiError(marketMsg('market.github.invalidStars'), 'invalid_response');
    }
    return stars;
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
        // 非 JSON 错误体：GitHub 的「缺 User-Agent」403 就是纯文本，正文比状态码可定位得多
        ghMessage = plainErrorText(bodyText);
      }
    }
    const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
    const code = classifyErrorCode(status, rateLimited);
    const text = ghMessage !== ''
      ? marketMsg('market.github.apiErrorWithMessage', { status, message: ghMessage })
      : marketMsg('market.github.apiError', { status });
    return new GitHubApiError(redact(text), code, status);
  }
}

/** 解析 JSON 响应体；空体 → undefined；非法 JSON → invalid_response。 */
async function safeParseJson(response: Response): Promise<unknown> {
  const text = await safeResponseText(response);
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubApiError(marketMsg('market.github.unparsableResponse'), 'invalid_response', response.status);
  }
}
