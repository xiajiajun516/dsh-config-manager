/**
 * m-market：MyRepoService 单测（docs/design/2026-08-20-my-configs-design.md §4.2/§4.3/§4.4/§4.5/§4.8）。
 *
 * 覆盖（mock gitWriter/rest/prepare，不碰真实网络与 git）：
 * - 首次上传全流程（prepare 元数据、建仓、写用户仓库、fork、PR 创建）
 * - 更新 bump 版本（version 纯自动 +1、id 不变）
 * - PR 复用（未合并 → 复用 open PR）与重开（已合并 → 新建 PR）
 * - 远端 index 前进防覆盖（用户 index / 官方 index 既有条目保留）
 * - 校验失败零推送（prepare 抛错 → 无任何仓库/git 操作）
 * - 401 token 过期路径（upload 返回可分类错误；listItems 抛 unauthorized）
 * - slug 冲突自动加后缀；update 名称变化视为新条目
 * - listItems 收录状态映射（未收录 / PR 待审核 / 已收录）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GitHubApiError, MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from './github-repos.ts';
import type { GitHubForkInfo, GitHubPullRequestInfo, GitHubPullRequestParams, GitHubRepoInfo, GitHubUserInfo } from './github-repos.ts';
import type { GitHubRestLike, MyItemEntry, MyRepoForm } from './my-repo.ts';
import { MyRepoService, prBranchFor, slugifyItemId, uniqueItemId, bumpVersion } from './my-repo.ts';
import { MarketPrepareError } from './prepare.ts';
import type { MarketPrepareInput, MarketPrepareResult } from './prepare.ts';
import type { GitFileWriter, GitFileWriteCall, GitFileWriterResult } from './git-file-writer.ts';
import type { SectionId } from '../schema/types.ts';

const LOGIN = 'xiaojun';
const USER_REPO_URL = `https://github.com/${LOGIN}/dsh-configs`;
const USER_REPO_CLONE = `${USER_REPO_URL}.git`;
const FORK_CLONE = `https://github.com/${LOGIN}/dsh-config-market.git`;
const OFFICIAL_URL = 'https://github.com/xiajiajun516/dsh-config-market';

/* ---------------------------------------------------------------- 夹具数据 */

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01]);

const USER_INDEX_EMPTY = JSON.stringify({ schemaVersion: 1, name: '我的配置仓库', items: [] });

const USER_INDEX_WITH = (items: unknown[]): string =>
  JSON.stringify({ schemaVersion: 1, name: '我的配置仓库', items });

const OFFICIAL_INDEX = JSON.stringify({
  schemaVersion: 1,
  name: 'DSH 配置市场',
  items: [{ id: 'other-item', name: 'Other', version: '1.0.0' }],
});

/* ---------------------------------------------------------------- mock 基础设施 */

interface RestOverrides {
  getUser?: () => Promise<GitHubUserInfo>;
  repoExists?: (owner: string, repo: string) => Promise<boolean>;
  createPublicRepo?: (name: string, description?: string) => Promise<GitHubRepoInfo>;
  ensureFork?: (owner: string, repo: string) => Promise<GitHubForkInfo>;
  readFile?: (owner: string, repo: string, path: string, ref?: string) => Promise<string | null>;
  openPullRequest?: (params: GitHubPullRequestParams) => Promise<GitHubPullRequestInfo>;
  listOpenPullRequests?: (owner: string, repo: string, head?: string) => Promise<GitHubPullRequestInfo[]>;
}

interface Harness {
  service: MyRepoService;
  gitCalls: GitFileWriteCall[];
  prepareInputs: MarketPrepareInput[];
  openPrCalls: GitHubPullRequestParams[];
  restCalls: string[];
}

function makePrepare() {
  const prepareInputs: MarketPrepareInput[] = [];
  const prepare = (input: MarketPrepareInput): MarketPrepareResult => {
    prepareInputs.push(input);
    return {
      manifestText: JSON.stringify({
        schemaVersion: 1,
        id: input.itemId,
        name: input.name,
        version: input.version,
        author: input.author,
        updatedAt: input.now,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categories !== undefined ? { categories: input.categories } : {}),
        sections: ['settings'],
        ...(input.repoUrl !== undefined ? { provenance: { source: input.repoUrl } } : {}),
        checksums: { zip: 'sha256-abc' },
      }, null, 2),
      sha256: 'sha256-abc',
      sections: ['settings'] as SectionId[],
      warnings: ['供应链警示'],
    };
  };
  return { prepare, prepareInputs };
}

function makeHarness(overrides: RestOverrides = {}): Harness {
  const gitCalls: GitFileWriteCall[] = [];
  const gitWriter: GitFileWriter = {
    writeFiles: async (call): Promise<GitFileWriterResult> => { gitCalls.push(call); return { pushed: true, branch: 'default' }; },
  };
  const openPrCalls: GitHubPullRequestParams[] = [];
  const restCalls: string[] = [];
  const rest: GitHubRestLike = {
    getUser: async () => { restCalls.push('getUser'); return { login: LOGIN, id: 1 }; },
    repoExists: async () => { restCalls.push('repoExists'); return false; },
    createPublicRepo: async (name, description) => {
      restCalls.push('createPublicRepo');
      return {
        fullName: `${LOGIN}/${name}`, htmlUrl: `https://github.com/${LOGIN}/${name}`,
        cloneUrl: `https://github.com/${LOGIN}/${name}.git`, defaultBranch: 'main',
        private: false, fork: false,
      };
    },
    ensureFork: async () => {
      restCalls.push('ensureFork');
      return {
        fullName: `${LOGIN}/dsh-config-market`, htmlUrl: `${OFFICIAL_URL}`,
        cloneUrl: FORK_CLONE, defaultBranch: 'main',
      };
    },
    readFile: async (owner, repo, p) => {
      restCalls.push(`readFile:${owner}/${repo}/${p}`);
      if (owner === LOGIN) return USER_INDEX_EMPTY; // 用户仓库 index
      return OFFICIAL_INDEX; // 官方市场 index
    },
    openPullRequest: async (params) => {
      restCalls.push('openPullRequest');
      openPrCalls.push(params);
      return {
        number: 42,
        htmlUrl: `${OFFICIAL_URL}/pull/42`,
        title: params.title,
        head: params.head,
        state: 'open',
        merged: false,
      };
    },
    listOpenPullRequests: async () => { restCalls.push('listOpenPullRequests'); return []; },
    ...overrides,
  };
  const { prepare, prepareInputs } = makePrepare();
  const service = new MyRepoService({
    prepare,
    rest,
    gitWriter,
    tokenProvider: async () => 'gho_test_token',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    workDirRoot: 'C:\\tmp\\my-configs-test',
  });
  return { service, gitCalls, prepareInputs, openPrCalls, restCalls };
}

function form(partial: Partial<MyRepoForm> = {}): MyRepoForm {
  return { name: 'My Config', ...partial };
}

function indexJsonOf(call: GitFileWriteCall): { schemaVersion: number; items: Array<Record<string, unknown>> } {
  const entry = call.entries.find((e) => e.path === 'index.json');
  assert.ok(entry, 'writeFiles 必须包含 index.json');
  return JSON.parse(entry.content as string) as { schemaVersion: number; items: Array<Record<string, unknown>> };
}

/* ---------------------------------------------------------------- 首次上传全流程 */

test('my-repo: 首次上传全流程 → prepare 元数据自动生成 + 建仓 + 写用户仓库 + fork + 建 PR', async () => {
  const h = makeHarness();
  const result = await h.service.upload({ zipBytes: ZIP_BYTES, form: form() });

  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'my-config');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.sha256, 'sha256-abc');
  assert.deepEqual(result.sections, ['settings']);
  assert.equal(result.repoUrl, USER_REPO_URL);
  assert.equal(result.prNumber, 42);
  assert.equal(result.prUrl, `${OFFICIAL_URL}/pull/42`);
  assert.ok(result.warnings.length >= 1);

  // prepare 输入：author=login、version=1.0.0、repoUrl=用户仓库
  assert.equal(h.prepareInputs.length, 1);
  const pi = h.prepareInputs[0]!;
  assert.equal(pi.itemId, 'my-config');
  assert.equal(pi.author, LOGIN);
  assert.equal(pi.version, '1.0.0');
  assert.equal(pi.repoUrl, USER_REPO_URL);
  assert.equal(pi.now, '2026-08-20T00:00:00.000Z');

  // 仓库操作序：getUser → 读用户 index → repoExists → createPublicRepo → 写用户仓库 → ensureFork → 读官方 index → 写 fork 分支 → listOpenPullRequests → openPullRequest
  assert.ok(h.restCalls.includes('createPublicRepo'), '首次上传必须自动创建公开仓库');
  assert.ok(h.restCalls.includes('ensureFork'), '必须 ensureFork 官方仓库');
  assert.ok(h.restCalls.some((c) => c.startsWith('readFile:xiajiajun516/dsh-config-market/index.json')), '必须读官方最新 index');

  // gitWriter 两次调用：用户仓库 + fork 分支
  assert.equal(h.gitCalls.length, 2);
  const [userCall, forkCall] = h.gitCalls as [GitFileWriteCall, GitFileWriteCall];
  assert.equal(userCall.repoUrl, USER_REPO_CLONE);
  assert.deepEqual(userCall.entries.map((e) => e.path), [
    'items/my-config/manifest.json', 'items/my-config/config.zip', 'index.json',
  ]);
  assert.equal(userCall.entries[1]!.content, ZIP_BYTES, 'config.zip 字节原样写入');
  // 用户 index：条目自动从 manifest 提取
  const userIndex = indexJsonOf(userCall);
  assert.equal(userIndex.schemaVersion, 1);
  assert.equal(userIndex.items.length, 1);
  assert.equal(userIndex.items[0]!.id, 'my-config');
  assert.equal(userIndex.items[0]!.version, '1.0.0');
  assert.equal(userIndex.items[0]!.author, LOGIN);

  // fork 分支：基于官方最新 main + force push + 仅 index.json + repo 自托管引用
  assert.equal(forkCall.repoUrl, FORK_CLONE);
  assert.equal(forkCall.branch, 'dsh-market-sync/my-config');
  assert.equal(forkCall.baseRef, 'upstream/main');
  assert.equal(forkCall.upstreamUrl, `${OFFICIAL_URL}.git`);
  assert.equal(forkCall.force, true);
  assert.deepEqual(forkCall.entries.map((e) => e.path), ['index.json']);
  const officialIndex = indexJsonOf(forkCall);
  assert.equal(officialIndex.items.length, 2, '官方 index 保留既有条目 + 新增条目');
  const entry = officialIndex.items.find((it) => it.id === 'my-config')!;
  assert.equal(entry.repo, USER_REPO_URL, '官方条目必须带 repo 自托管引用');
  assert.equal(entry.version, '1.0.0');

  // PR：head=<login>:<branch>，base=main
  assert.equal(h.openPrCalls.length, 1);
  assert.equal(h.openPrCalls[0]!.head, `${LOGIN}:dsh-market-sync/my-config`);
  assert.equal(h.openPrCalls[0]!.base, 'main');
});

/* ---------------------------------------------------------------- 更新 bump 版本 */

test('my-repo: 更新 → id 不变、version 纯自动 +1、updatedAt 刷新', async () => {
  const existing = USER_INDEX_WITH([{ id: 'my-config', name: 'My Config', version: '1.0.1', author: LOGIN }]);
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? existing : OFFICIAL_INDEX),
  });
  const result = await h.service.update({ zipBytes: ZIP_BYTES, form: form() });

  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'my-config', 'id 必须保持不变');
  assert.equal(result.version, '1.0.2', 'version 必须自动 +1');

  const pi = h.prepareInputs[0]!;
  assert.equal(pi.version, '1.0.2');
  assert.equal(pi.itemId, 'my-config');
  assert.equal(pi.now, '2026-08-20T00:00:00.000Z', 'updatedAt 自动刷新为 now');

  const userIndex = indexJsonOf(h.gitCalls[0]!);
  const entry = userIndex.items.find((it) => it.id === 'my-config')!;
  assert.equal(entry.version, '1.0.2');
  // PR 分支同样同步新版本
  const forkIndex = indexJsonOf(h.gitCalls[1]!);
  assert.equal(forkIndex.items.find((it) => it.id === 'my-config')!.version, '1.0.2');
});

test('my-repo: update 显式 form.id → 按 id 定位（name→slug 失配时不再误为新建）', async () => {
  // 模拟中文名条目：id=config-abc12345（name slug 折叠为空 → hash 兜底），更新时 name 可随意改
  const existing = USER_INDEX_WITH([
    { id: 'config-abc12345', name: '我的配置', version: '2.1.0', author: LOGIN },
  ]);
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? existing : OFFICIAL_INDEX),
  });
  // form.id 显式指向条目 id；name 被用户改了也不影响定位
  const result = await h.service.update({ zipBytes: ZIP_BYTES, form: form({ id: 'config-abc12345', name: '我的配置 v2' }) });

  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'config-abc12345', '必须按显式 id 更新');
  assert.equal(result.version, '2.1.1', 'version 基于显式 id 条目的旧版本 +1');

  const userIndex = indexJsonOf(h.gitCalls[0]!);
  assert.ok(userIndex.items.some((it) => it.id === 'config-abc12345' && it.version === '2.1.1'), '显式 id 条目被更新');
  assert.equal(userIndex.items.filter((it) => it.id === 'config-abc12345').length, 1, '不得新增重复条目');
});

test('my-repo: update 显式 form.id 但条目不存在 → 明确报错（不静默新建）', async () => {
  const existing = USER_INDEX_WITH([{ id: 'other-item', name: 'Other', version: '1.0.0', author: LOGIN }]);
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? existing : OFFICIAL_INDEX),
  });
  const result = await h.service.update({ zipBytes: ZIP_BYTES, form: form({ id: 'gone-item', name: 'Gone' }) });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'item_not_found');
  assert.equal(h.gitCalls.length, 0, '未找到条目必须零推送');
});

/* ---------------------------------------------------------------- PR 复用与重开 */

test('my-repo: PR 复用（open PR 未合并）→ 不重复创建', async () => {
  const openPrs = [{ number: 7, htmlUrl: `${OFFICIAL_URL}/pull/7`, title: 't', head: prBranchFor('my-config'), state: 'open', merged: false }];
  const h = makeHarness({
    listOpenPullRequests: async (owner, repo, head) => {
      assert.equal(head, `${LOGIN}:${prBranchFor('my-config')}`, '必须带 head 过滤查询');
      return openPrs;
    },
  });
  const result = await h.service.upload({ zipBytes: ZIP_BYTES, form: form() });

  assert.equal(result.prNumber, 7);
  assert.equal(result.prUrl, `${OFFICIAL_URL}/pull/7`);
  assert.equal(h.openPrCalls.length, 0, '已有 open PR 必须复用，不重复创建');
});

test('my-repo: PR 重开（无 open PR / 已合并）→ 新建 PR', async () => {
  const h = makeHarness(); // listOpenPullRequests 默认返回 []
  const result = await h.service.upload({ zipBytes: ZIP_BYTES, form: form() });
  assert.equal(result.prNumber, 42);
  assert.equal(h.openPrCalls.length, 1, '无 open PR 必须新建');
});

/* ---------------------------------------------------------------- 防覆盖 */

test('my-repo: 远端 index 前进防覆盖 → 用户/官方既有条目全部保留', async () => {
  const userIndexText = USER_INDEX_WITH([
    { id: 'old-item', name: 'Old', version: '2.0.0' },
    { id: 'my-config', name: 'My Config', version: '0.9.0' },
  ]);
  const officialText = JSON.stringify({
    schemaVersion: 1,
    name: 'DSH 配置市场',
    items: [
      { id: 'keep-me', name: 'Keep', version: '3.0.0' },
      { id: 'my-config', name: 'My Config', version: '0.9.0', repo: USER_REPO_URL },
    ],
  });
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? userIndexText : officialText),
  });

  // update 同名：旧条目已在，直接 bump 而非新建
  const result = await h.service.update({ zipBytes: ZIP_BYTES, form: form() });
  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'my-config');
  assert.equal(result.version, '0.9.1');

  // 用户 index：old-item 保留 + my-config 更新到 0.9.1
  const userIndex = indexJsonOf(h.gitCalls[0]!);
  assert.deepEqual(userIndex.items.map((it) => it.id), ['old-item', 'my-config'], '既有条目顺序与内容保留');
  assert.equal(userIndex.items.find((it) => it.id === 'old-item')!.version, '2.0.0');
  assert.equal(userIndex.items.find((it) => it.id === 'my-config')!.version, '0.9.1');

  // 官方 index：keep-me 保留 + my-config 更新
  const forkIndex = indexJsonOf(h.gitCalls[1]!);
  assert.deepEqual(forkIndex.items.map((it) => it.id), ['keep-me', 'my-config']);
  assert.equal(forkIndex.items.find((it) => it.id === 'my-config')!.version, '0.9.1');
});

/* ---------------------------------------------------------------- 校验失败零推送 */

test('my-repo: 校验失败（prepare 抛错）→ 零推送、零仓库操作', async () => {
  const prepareInputs: MarketPrepareInput[] = [];
  const failingPrepare = (input: MarketPrepareInput): MarketPrepareResult => {
    prepareInputs.push(input);
    throw new MarketPrepareError('检测到疑似敏感内容（config/settings.json: token），市场条目禁止携带凭据');
  };
  const gitCalls: GitFileWriteCall[] = [];
  const gitWriter: GitFileWriter = {
    writeFiles: async (call): Promise<GitFileWriterResult> => { gitCalls.push(call); return { pushed: true, branch: 'default' }; },
  };
  const restCalls: string[] = [];
  const rest: GitHubRestLike = {
    getUser: async () => { restCalls.push('getUser'); return { login: LOGIN, id: 1 }; },
    repoExists: async () => { restCalls.push('repoExists'); return false; },
    createPublicRepo: async () => { restCalls.push('createPublicRepo'); throw new Error('不应调用'); },
    ensureFork: async () => { restCalls.push('ensureFork'); throw new Error('不应调用'); },
    readFile: async () => { restCalls.push('readFile'); return null; },
    openPullRequest: async () => { restCalls.push('openPullRequest'); throw new Error('不应调用'); },
    listOpenPullRequests: async () => { restCalls.push('listOpenPullRequests'); return []; },
  };
  const service = new MyRepoService({
    prepare: failingPrepare,
    rest,
    gitWriter,
    tokenProvider: async () => 'gho_test_token',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });

  const result = await service.upload({ zipBytes: ZIP_BYTES, form: form() });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'prepare_failed');
  assert.ok(result.error?.includes('检测到疑似敏感内容'));
  assert.equal(gitCalls.length, 0, '校验失败必须零 git 推送');
  assert.ok(!restCalls.includes('createPublicRepo'), '校验失败不得建仓');
  assert.ok(!restCalls.includes('ensureFork'), '校验失败不得 fork');
  assert.ok(!restCalls.includes('openPullRequest'), '校验失败不得开 PR');
  assert.ok(restCalls.includes('getUser'), '仅允许登录校验');
});

/* ---------------------------------------------------------------- 401 token 过期 */

test('my-repo: 401 token 过期 → upload 返回可分类错误；listItems 抛 unauthorized', async () => {
  const unauthorized = new GitHubApiError('Bad credentials', 'unauthorized', 401);
  const h = makeHarness({
    getUser: async () => { throw unauthorized; },
  });

  const result = await h.service.upload({ zipBytes: ZIP_BYTES, form: form() });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unauthorized');
  assert.ok(result.error?.includes('unauthorized') || result.error?.includes('Bad credentials'));
  assert.equal(h.gitCalls.length, 0, '401 必须零推送');

  await assert.rejects(h.service.listItems(), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.code, 'unauthorized');
    return true;
  });
});

/* ---------------------------------------------------------------- slug 冲突与 update 名称变化 */

test('my-repo: upload 同名已存在 → id 自动加后缀（my-config-2）', async () => {
  const existing = USER_INDEX_WITH([{ id: 'my-config', name: 'My Config', version: '1.0.0' }]);
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? existing : OFFICIAL_INDEX),
  });
  const result = await h.service.upload({ zipBytes: ZIP_BYTES, form: form() });
  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'my-config-2');
  assert.equal(result.version, '1.0.0');
  assert.equal(h.prepareInputs[0]!.itemId, 'my-config-2');
});

test('my-repo: update 名称变化 → 作为新条目（警告提示）', async () => {
  const existing = USER_INDEX_WITH([{ id: 'my-config', name: 'My Config', version: '1.0.0' }]);
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? existing : OFFICIAL_INDEX),
  });
  const result = await h.service.update({ zipBytes: ZIP_BYTES, form: form({ name: 'Other Name' }) });
  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'other-name');
  assert.equal(result.version, '1.0.0', '新条目从 1.0.0 开始');
  assert.ok(result.warnings.some((w) => w.includes('新条目')), '必须提示按新条目发布');
});

/* ---------------------------------------------------------------- listItems 收录状态 */

test('my-repo: listItems 收录状态映射（已收录 / PR 待审核 / 未收录）', async () => {
  const userIndexText = USER_INDEX_WITH([
    { id: 'listed-item', name: 'A', version: '1.0.0' },
    { id: 'pending-item', name: 'B', version: '1.0.0' },
    { id: 'fresh-item', name: 'C', version: '1.0.0' },
  ]);
  const officialText = JSON.stringify({
    schemaVersion: 1,
    name: 'DSH 配置市场',
    items: [{ id: 'listed-item', name: 'A', version: '1.0.0', repo: USER_REPO_URL }],
  });
  const openPrs = [
    { number: 9, htmlUrl: `${OFFICIAL_URL}/pull/9`, title: 't', head: prBranchFor('pending-item'), state: 'open', merged: false },
  ];
  const queriedHeads: string[] = [];
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? userIndexText : officialText),
    listOpenPullRequests: async (owner, repo, head) => {
      assert.equal(owner, MARKET_UPSTREAM_OWNER);
      assert.equal(repo, MARKET_UPSTREAM_REPO);
      queriedHeads.push(head ?? '');
      // 按设计 §4.5：head=<login>:<branch> 过滤（避免跨用户同名分支误报）
      return openPrs.filter((p) => head === `${LOGIN}:${p.head}`);
    },
  });

  const items: MyItemEntry[] = await h.service.listItems();
  assert.equal(items.length, 3);
  assert.equal(items[0]!.id, 'listed-item');
  assert.equal(items[0]!.status, 'listed');
  assert.equal(items[0]!.repoUrl, USER_REPO_URL);
  // listed-item 已收录 → 不查询 PR（含它也无所谓，但不应误标 PR 状态）
  assert.equal(items[1]!.id, 'pending-item');
  assert.equal(items[1]!.status, 'pr-pending');
  assert.equal(items[1]!.prUrl, `${OFFICIAL_URL}/pull/9`);
  assert.equal(items[2]!.id, 'fresh-item');
  assert.equal(items[2]!.status, 'not-listed');
  assert.equal(items[2]!.prUrl, undefined);
  // head 过滤查询必须携带 login 前缀（跨用户隔离）
  assert.ok(queriedHeads.includes(`${LOGIN}:${prBranchFor('pending-item')}`), 'PR 查询必须带 head=<login>:<branch>');
  assert.ok(queriedHeads.includes(`${LOGIN}:${prBranchFor('fresh-item')}`), '未收录条目也必须按 head 过滤查询');
});

test('my-repo: listItems 从未上传（用户仓库无 index）→ 空数组', async () => {
  const h = makeHarness({
    readFile: async (owner, repo, p) => (owner === LOGIN ? null : OFFICIAL_INDEX),
  });
  const items = await h.service.listItems();
  assert.deepEqual(items, []);
});

/* ---------------------------------------------------------------- 纯函数 */

test('my-repo: slugifyItemId 稳定 slug（中文/符号折叠、字母数字开头、长度上限）', () => {
  assert.equal(slugifyItemId('My Config'), 'my-config');
  assert.match(slugifyItemId('我的配置'), /^config-[a-f0-9]{8}$/, '纯中文回退 config-<hash>');
  assert.equal(slugifyItemId('我的配置'), slugifyItemId('我的配置'), '同一输入稳定输出');
  assert.equal(slugifyItemId('a.b_c-d'), 'a.b_c-d');
  assert.equal(slugifyItemId(''), slugifyItemId(''), '空名回退稳定 hash');
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slugifyItemId('x'.repeat(200))), '长度截断到 128 且过安全正则');
});

test('my-repo: uniqueItemId 冲突加后缀；bumpVersion 纯自动 +1', () => {
  assert.equal(uniqueItemId('a', []), 'a');
  assert.equal(uniqueItemId('a', ['a']), 'a-2');
  assert.equal(uniqueItemId('a', ['a', 'a-2', 'a-3']), 'a-4');
  assert.equal(bumpVersion('1.0.0'), '1.0.1');
  assert.equal(bumpVersion('2'), '3');
  assert.equal(bumpVersion('v1.0'), 'v1.1');
  assert.equal(bumpVersion('beta'), 'beta.1', '非数字尾追加 .1');
});