/**
 * m-market：GitHubAuthRest 单测（docs/design/2026-08-20-my-configs-design.md §4.2 / §4.8）。
 *
 * 覆盖：getUser 200/401；createPublicRepo 201/422；repoExists 200/404；
 * ensureFork 复用已 fork 与新建 + 轮询就绪（含超时）；readFile 存在/404/目录；
 * openPullRequest（缺省固定官方目标）；listOpenPullRequests（head 过滤）；
 * 错误分类（unauthorized/validation_failed/rate_limited/network_error/server_error）
 * 与 token 脱敏（错误消息绝不含 token 形态内容）。
 *
 * 全部通过注入 fetcher / now / poll 参数 mock，不碰真实网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_API_BASE, GitHubApiError, GitHubAuthRest,
  MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO,
} from './github-repos.ts';
import { REDACTED } from '../security/redaction.ts';

/* ---------------------------------------------------------------- mock 基础设施 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface InstallOptions {
  token?: string;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installRest(handler: (call: FetchCall) => Response, options: InstallOptions = {}): {
  rest: GitHubAuthRest;
  calls: FetchCall[];
  token: string;
} {
  const calls: FetchCall[] = [];
  const token = options.token ?? 'gho_abcdefghijklmnopqrstuvwxyz123456';
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const rest = new GitHubAuthRest({
    tokenProvider: async () => token,
    fetcher,
    now: options.now ?? (() => 0),
    pollIntervalMs: options.pollIntervalMs ?? 0,
    pollTimeoutMs: options.pollTimeoutMs ?? 10_000,
  });
  return { rest, calls, token };
}

function bodyOf(call: FetchCall): string {
  return typeof call.init?.body === 'string' ? call.init.body : '';
}

/* ---------------------------------------------------------------- 标准夹具 */

const USER = { login: 'xiaojun', id: 123, name: 'Xiaojun' };

const REPO = {
  full_name: 'xiaojun/dsh-configs',
  html_url: 'https://github.com/xiaojun/dsh-configs',
  clone_url: 'https://github.com/xiaojun/dsh-configs.git',
  default_branch: 'main',
  private: false,
  fork: false,
};

const FORK = {
  full_name: 'xiaojun/dsh-config-market',
  html_url: 'https://github.com/xiaojun/dsh-config-market',
  clone_url: 'https://github.com/xiaojun/dsh-config-market.git',
  default_branch: 'main',
  fork: true,
  owner: { login: 'xiaojun' },
  parent: { full_name: 'xiajiajun516/dsh-config-market' },
};

/** 同名但非本上游 fork（fork:true 但 parent 指向别的仓库） */
const FORK_WRONG_PARENT = {
  ...FORK,
  parent: { full_name: 'someone-else/dsh-config-market' },
};

/** 同名但非 fork 的仓库（用户自建同名仓） */
const REPO_SAME_NAME = {
  ...FORK,
  fork: false,
  parent: null,
};

const PR = {
  number: 12,
  html_url: 'https://github.com/xiajiajun516/dsh-config-market/pull/12',
  title: 'add my-config',
  state: 'open',
  merged: false,
  head: { ref: 'dsh-market-sync/my-config' },
};

/* ---------------------------------------------------------------- getUser */

test('github-repos: getUser 200 → login/id/name；请求构造正确（Bearer 头 + accept）', async () => {
  const { rest, calls, token } = installRest(() => jsonResponse(200, USER));
  const user = await rest.getUser();
  assert.equal(user.login, 'xiaojun');
  assert.equal(user.id, 123);
  assert.equal(user.name, 'Xiaojun');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${GITHUB_API_BASE}/user`);
  assert.equal(calls[0]?.init?.method, 'GET');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  assert.equal(headers.get('accept'), 'application/vnd.github+json');
});

test('github-repos: getUser 401 → GitHubApiError/unauthorized（token 不进消息）', async () => {
  const { rest, token } = installRest(() => jsonResponse(401, { message: 'Bad credentials' }));
  await assert.rejects(rest.getUser(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'unauthorized');
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(token), '错误消息绝不回显 token');
    return true;
  });
});

test('github-repos: token 为空 → no_token，不发出任何请求', async () => {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return jsonResponse(200, USER);
  }) as typeof fetch;
  const rest = new GitHubAuthRest({ tokenProvider: async () => '', fetcher, now: () => 0 });
  await assert.rejects(rest.getUser(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'no_token');
    return true;
  });
  assert.equal(calls.length, 0, '空 token 必须直接拒绝，不发网络请求');
});

test('github-repos: 网络失败 → GitHubApiError/network_error，错误消息中的 token 形态被掩码', async () => {
  const { rest, token } = installRest(() => {
    throw new Error(`fetch failed: ${token}`);
  });
  await assert.rejects(rest.getUser(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'network_error');
    assert.equal(err.status, undefined, '网络层错误无 HTTP 状态');
    assert.ok(!err.message.includes(token), '错误消息绝不回显 token');
    assert.ok(err.message.includes(REDACTED), 'token 形态必须被掩码');
    return true;
  });
});

test('github-repos: 非 JSON 响应 → GitHubApiError/invalid_response', async () => {
  const { rest } = installRest(() => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(rest.getUser(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'invalid_response');
    return true;
  });
});

test('github-repos: GitHub 错误体回显 token 形态 → 消息过 redact 掩码', async () => {
  const { rest, token } = installRest(() => jsonResponse(500, { message: `bad token: ${token}` }));
  await assert.rejects(rest.getUser(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'server_error');
    assert.ok(!err.message.includes(token), '错误消息绝不回显 token');
    assert.ok(err.message.includes(REDACTED), 'token 形态必须被掩码');
    return true;
  });
});

/* ---------------------------------------------------------------- repoExists */

test('github-repos: repoExists 200 → true；404 → false（同一 client 顺序响应）', async () => {
  let n = 0;
  const { rest } = installRest(() => {
    n += 1;
    return n === 1 ? jsonResponse(200, REPO) : jsonResponse(404, { message: 'Not Found' });
  });
  assert.equal(await rest.repoExists('xiaojun', 'dsh-configs'), true);
  assert.equal(await rest.repoExists('xiaojun', 'dsh-configs'), false);
});

test('github-repos: repoExists 403 且剩余配额 0 → rate_limited', async () => {
  const { rest } = installRest(() => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  }));
  await assert.rejects(rest.repoExists('a', 'b'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.status, 403);
    return true;
  });
});

/* ---------------------------------------------------------------- createPublicRepo */

test('github-repos: createPublicRepo 201 → 请求构造（POST /user/repos，public + auto_init）并返回仓库信息', async () => {
  const { rest, calls } = installRest(() => jsonResponse(201, REPO));
  const repo = await rest.createPublicRepo('dsh-configs', '我的配置仓库');
  assert.equal(repo.fullName, 'xiaojun/dsh-configs');
  assert.equal(repo.htmlUrl, 'https://github.com/xiaojun/dsh-configs');
  assert.equal(repo.cloneUrl, 'https://github.com/xiaojun/dsh-configs.git');
  assert.equal(repo.defaultBranch, 'main');
  assert.equal(repo.private, false);
  assert.equal(repo.fork, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${GITHUB_API_BASE}/user/repos`);
  assert.equal(calls[0]?.init?.method, 'POST');
  const payload = JSON.parse(bodyOf(calls[0]!)) as Record<string, unknown>;
  assert.equal(payload['name'], 'dsh-configs');
  assert.equal(payload['private'], false, '必须创建公开仓库');
  assert.equal(payload['auto_init'], true, 'auto_init 保证初始 commit 可 clone');
  assert.equal(payload['description'], '我的配置仓库');
});

test('github-repos: createPublicRepo 422 → GitHubApiError/validation_failed（含 GitHub 消息、无 token）', async () => {
  const { rest, token } = installRest(() => jsonResponse(422, { message: 'Repository creation failed.' }));
  await assert.rejects(rest.createPublicRepo('x'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.status, 422);
    assert.match(err.message, /Repository creation failed/);
    assert.ok(!err.message.includes(token), '错误消息绝不回显 token');
    return true;
  });
});

/* ---------------------------------------------------------------- ensureFork */

test('github-repos: ensureFork 直查用户同名仓库命中已 fork（fork:true + parent 匹配）→ 复用，零创建', async () => {
  let n = 0;
  const { rest, calls } = installRest(() => {
    n += 1;
    return n === 1 ? jsonResponse(200, USER) : jsonResponse(200, FORK);
  });
  const info = await rest.ensureFork(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO);
  assert.equal(info.fullName, 'xiaojun/dsh-config-market');
  assert.equal(info.htmlUrl, 'https://github.com/xiaojun/dsh-config-market');
  assert.equal(info.cloneUrl, 'https://github.com/xiaojun/dsh-config-market.git');
  assert.equal(info.defaultBranch, 'main');

  assert.equal(calls.length, 2, '复用路径只发 getUser + 直查用户仓库两个请求');
  assert.match(calls[1]?.url ?? '', /\/repos\/xiaojun\/dsh-config-market$/);
  assert.ok(!calls.some((c) => c.init?.method === 'POST'), '复用路径不得创建 fork');
});

test('github-repos: ensureFork 直查 404 → 创建（POST /forks 202）+ 轮询直到就绪', async () => {
  let n = 0;
  const { rest, calls } = installRest(() => {
    n += 1;
    if (n === 1) return jsonResponse(200, USER);
    if (n === 2) return jsonResponse(404, { message: 'Not Found' }); // 直查：无 fork
    if (n === 3) return new Response('', { status: 202 }); // 创建返回 202（异步）
    if (n === 4) return jsonResponse(404, { message: 'Not Found' }); // 未就绪
    return jsonResponse(200, FORK); // 就绪（owner + fork:true + parent 匹配）
  });
  const info = await rest.ensureFork('xiajiajun516', 'dsh-config-market');
  assert.equal(info.cloneUrl, 'https://github.com/xiaojun/dsh-config-market.git');
  assert.equal(info.defaultBranch, 'main');

  assert.equal(calls[2]?.init?.method, 'POST', '创建 fork 必须走 POST');
  assert.match(calls[2]?.url ?? '', /\/repos\/xiajiajun516\/dsh-config-market\/forks$/);
  assert.ok(calls.length >= 5, '必须经历轮询（404 → 200 就绪）');
  assert.match(calls[4]?.url ?? '', /\/repos\/xiaojun\/dsh-config-market$/);
});

test('github-repos: ensureFork 同名仓库 fork:false（非 fork）→ fork_name_conflict', async () => {
  let n = 0;
  const { rest, calls } = installRest(() => {
    n += 1;
    return n === 1 ? jsonResponse(200, USER) : jsonResponse(200, REPO_SAME_NAME);
  });
  await assert.rejects(rest.ensureFork('xiajiajun516', 'dsh-config-market'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'fork_name_conflict');
    assert.match(err.message, /同名仓库已存在/);
    return true;
  });
  assert.ok(!calls.some((c) => c.init?.method === 'POST'), '冲突场景不得尝试创建 fork');
});

test('github-repos: ensureFork 同名仓库 fork:true 但 parent 不匹配 → fork_name_conflict', async () => {
  let n = 0;
  const { rest } = installRest(() => {
    n += 1;
    return n === 1 ? jsonResponse(200, USER) : jsonResponse(200, FORK_WRONG_PARENT);
  });
  await assert.rejects(rest.ensureFork('xiajiajun516', 'dsh-config-market'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'fork_name_conflict');
    assert.match(err.message, /同名仓库已存在/);
    return true;
  });
});

test('github-repos: ensureFork 轮询超时（fork 一直未就绪）→ GitHubApiError/fork_timeout', async () => {
  let now = 0;
  let n = 0;
  const { rest, calls } = installRest(() => {
    n += 1;
    if (n === 1) return jsonResponse(200, USER); // getUser 必须成功才能进入轮询
    if (n === 2) return jsonResponse(404, { message: 'Not Found' }); // 直查：无 fork
    if (n === 3) return new Response('', { status: 202 }); // 创建接受
    now += 40; // 之后每次轮询推进时钟（超过 pollTimeoutMs=100 即超时）
    return jsonResponse(404, { message: 'Not Found' });
  }, { now: () => now, pollTimeoutMs: 100 });
  await assert.rejects(rest.ensureFork('xiajiajun516', 'dsh-config-market'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'fork_timeout');
    assert.equal(err.status, undefined, '超时为内部错误，无 HTTP 状态');
    assert.match(err.message, /超时/);
    return true;
  });
  assert.ok(calls.length >= 6, '必须经历多轮轮询后才超时');
});

test('github-repos: ensureFork 轮询就绪但 parent 不匹配 → 继续轮询直到超时', async () => {
  let now = 0;
  let n = 0;
  const { rest } = installRest(() => {
    n += 1;
    if (n === 1) return jsonResponse(200, USER);
    if (n === 2) return jsonResponse(404, { message: 'Not Found' });
    if (n === 3) return new Response('', { status: 202 });
    now += 40;
    return jsonResponse(200, FORK_WRONG_PARENT); // 就绪但 parent 不匹配 → 不算就绪
  }, { now: () => now, pollTimeoutMs: 100 });
  await assert.rejects(rest.ensureFork('xiajiajun516', 'dsh-config-market'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'fork_timeout');
    return true;
  });
});

/* ---------------------------------------------------------------- readFile */

test('github-repos: readFile 存在 → base64 解码返回 UTF-8 文本', async () => {
  const content = Buffer.from('{"schemaVersion":1,"items":[]}', 'utf8').toString('base64');
  const { rest, calls } = installRest(() =>
    jsonResponse(200, { type: 'file', encoding: 'base64', content }));
  const text = await rest.readFile('xiaojun', 'dsh-configs', 'index.json');
  assert.equal(text, '{"schemaVersion":1,"items":[]}');
  assert.match(calls[0]?.url ?? '', /\/contents\/index\.json$/);
});

test('github-repos: readFile 带 ref → url 携带 ref 查询参数', async () => {
  const { rest, calls } = installRest(() =>
    jsonResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from('{}').toString('base64') }));
  await rest.readFile('xiaojun', 'dsh-configs', 'items/my-config/manifest.json', 'main');
  assert.match(calls[0]?.url ?? '', /\/contents\/items\/my-config\/manifest\.json\?ref=main$/);
});

test('github-repos: readFile 404 → null（index.json 尚未创建场景）', async () => {
  const { rest } = installRest(() => jsonResponse(404, { message: 'Not Found' }));
  assert.equal(await rest.readFile('xiaojun', 'dsh-configs', 'index.json'), null);
});

test('github-repos: readFile 目录路径 → GitHubApiError/not_a_file', async () => {
  const { rest } = installRest(() => jsonResponse(200, { type: 'dir' }));
  await assert.rejects(rest.readFile('xiaojun', 'dsh-configs', 'items'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'not_a_file');
    return true;
  });
});

test('github-repos: readFile 0 字节空文件 → 返回空串（contents API 的 content:"" 合法）', async () => {
  const { rest } = installRest(() => jsonResponse(200, { type: 'file', encoding: 'base64', content: '' }));
  assert.equal(await rest.readFile('xiaojun', 'dsh-configs', 'empty.txt'), '');
});

/* ---------------------------------------------------------------- openPullRequest */

test('github-repos: openPullRequest 缺省 owner/repo → 固定官方仓库；请求体含 title/head/base', async () => {
  const { rest, calls } = installRest(() => jsonResponse(201, PR));
  const info = await rest.openPullRequest({
    title: 'add my-config',
    head: 'xiaojun:dsh-market-sync/my-config',
    base: 'main',
    body: '自动提交（dsh-config-manager）',
  });
  assert.equal(info.number, 12);
  assert.equal(info.htmlUrl, 'https://github.com/xiajiajun516/dsh-config-market/pull/12');
  assert.equal(info.head, 'dsh-market-sync/my-config');
  assert.equal(info.state, 'open');
  assert.equal(info.merged, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${GITHUB_API_BASE}/repos/${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}/pulls`);
  assert.equal(calls[0]?.init?.method, 'POST');
  const payload = JSON.parse(bodyOf(calls[0]!)) as Record<string, unknown>;
  assert.equal(payload['title'], 'add my-config');
  assert.equal(payload['head'], 'xiaojun:dsh-market-sync/my-config');
  assert.equal(payload['base'], 'main');
  assert.equal(payload['body'], '自动提交（dsh-config-manager）');
});

test('github-repos: openPullRequest 显式 owner/repo 覆盖缺省（headers 含 content-type）', async () => {
  const { rest, calls } = installRest(() => jsonResponse(201, PR));
  await rest.openPullRequest({ title: 't', head: 'h', base: 'b', owner: 'other', repo: 'other-repo' });
  assert.equal(calls[0]?.url, `${GITHUB_API_BASE}/repos/other/other-repo/pulls`);
  const headers = new Headers(calls[0]?.init?.headers);
  assert.ok((headers.get('content-type') ?? '').includes('application/json'), '带 body 的请求必须声明 JSON');
});

/* ---------------------------------------------------------------- listOpenPullRequests */

test('github-repos: listOpenPullRequests 带 head → 只列 open PR 并投影（head URL 编码）', async () => {
  const prs = [
    PR,
    { ...PR, number: 13, head: { ref: 'other-branch' }, html_url: 'https://github.com/x/pull/13' },
  ];
  const { rest, calls } = installRest(() => jsonResponse(200, prs));
  const list = await rest.listOpenPullRequests(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO, 'xiaojun:dsh-market-sync/my-config');
  assert.equal(list.length, 2);
  assert.equal(list[0]?.number, 12);
  assert.equal(list[0]?.head, 'dsh-market-sync/my-config');
  assert.equal(list[1]?.head, 'other-branch');
  assert.equal(list[0]?.state, 'open');

  assert.match(calls[0]?.url ?? '', /\/pulls\?state=open/);
  assert.ok((calls[0]?.url ?? '').includes(encodeURIComponent('xiaojun:dsh-market-sync/my-config')),
    'head 过滤必须 URL 编码');
});

test('github-repos: listOpenPullRequests 无 head 过滤 → 不携带 head 参数', async () => {
  const { rest, calls } = installRest(() => jsonResponse(200, [PR]));
  const list = await rest.listOpenPullRequests('x', 'y');
  assert.equal(list.length, 1);
  assert.ok(!(calls[0]?.url ?? '').includes('head='), '未传 head 时请求不得携带 head 参数');
});

test('github-repos: listOpenPullRequests 响应非数组 → GitHubApiError/invalid_response', async () => {
  const { rest } = installRest(() => jsonResponse(200, { items: [] }));
  await assert.rejects(rest.listOpenPullRequests('x', 'y'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'invalid_response');
    return true;
  });
});

/* ---------------------------------------------------------------- closePullRequest */

test('github-repos: closePullRequest → PATCH /pulls/{number} + body state closed + 返回 PR 信息', async () => {
  const closedPr = { ...PR, state: 'closed' };
  const { rest, calls } = installRest(() => jsonResponse(200, closedPr));
  const info = await rest.closePullRequest('xiajiajun516', 'dsh-config-market', 12);
  assert.equal(info.number, 12);
  assert.equal(info.state, 'closed');
  assert.equal(info.htmlUrl, 'https://github.com/xiajiajun516/dsh-config-market/pull/12');
  assert.equal(info.merged, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${GITHUB_API_BASE}/repos/xiajiajun516/dsh-config-market/pulls/12`);
  assert.equal(calls[0]?.init?.method, 'PATCH');
  const payload = JSON.parse(bodyOf(calls[0]!)) as Record<string, unknown>;
  assert.equal(payload['state'], 'closed');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.ok((headers.get('content-type') ?? '').includes('application/json'), '带 body 的请求必须声明 JSON');
});

test('github-repos: closePullRequest 404（PR 不存在/无权限）→ GitHubApiError/not_found', async () => {
  const { rest } = installRest(() => jsonResponse(404, { message: 'Not Found' }));
  await assert.rejects(rest.closePullRequest('xiajiajun516', 'dsh-config-market', 999), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'not_found');
    assert.equal(err.status, 404);
    return true;
  });
});