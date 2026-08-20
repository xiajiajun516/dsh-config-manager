/**
 * m-market：MyRepoService —— 「一键上传 / 我的配置」上传编排（docs/design/2026-08-20-my-configs-design.md §4.2/§4.3/§4.4/§4.5）。
 *
 * 数据流（upload / update 共用 runPublish 状态机）：
 *   ① 登录（rest.getUser）→ login（401 → unauthorized，明确可分类）
 *   ② 读用户仓库最新 index.json（先拉最新，防覆盖；文件不存在 → 空索引）
 *   ③ 元数据全自动：itemId = name 稳定 slug（冲突自动加后缀）、version = 首次 1.0.0 /
 *      更新时旧版本 +1、author = login、updatedAt = now、sha256/sections 来自 prepare
 *   ④ prepare（8 道校验 + 秘密扫描；含密钥/禁止分区 → MarketPrepareError → 零推送）
 *   ⑤ ensure 用户仓库 <login>/dsh-configs（复用或自动创建公开仓库）
 *   ⑥ 写用户仓库：items/<id>/manifest.json + config.zip + 更新 index.json（追加/覆盖条目），commit + push
 *   ⑦ ensureFork 官方仓库 xiajiajun516/dsh-config-market（复用已 fork / 新建 + 轮询就绪）
 *   ⑧ 官方 index.json：读最新 → 更新条目（带 repo 自托管引用）→ 写 fork 分支
 *      dsh-market-sync/<id>（基于官方最新 main）→ commit → force push（--force-with-lease）
 *   ⑨ PR：查 open PR（head=<login>:<branch>）复用；无则 openPullRequest(base=官方main)
 *
 * 安全不变量（AGENTS.md / 设计 §4.7）：
 * - 目标官方仓库 xiajiajun516/dsh-config-market **固定硬编码**（导出常量），无任何配置入口；
 * - form 仅 { name, description?, categories? }；id/author/version/updatedAt/repoUrl/清单 全自动；
 * - token 仅经注入的 rest / gitWriter 使用（值不落盘、不进日志、不回传浏览器）；
 * - 所有错误/展示文本渲染前过 redact()；上传失败返回 ok:false + errorCode，不抛裸错。
 *
 * 依赖注入全部可 mock：prepare / rest / gitWriter / tokenProvider / now / workDirRoot。
 */
import { join } from 'node:path';
import os from 'node:os';

import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from './github-repos.ts';
import type {
  GitHubForkInfo, GitHubPullRequestInfo, GitHubPullRequestParams, GitHubRepoInfo, GitHubUserInfo,
} from './github-repos.ts';
import { GitHubApiError } from './github-repos.ts';
import { createGitFileWriter } from './git-file-writer.ts';
import type { GitFileWriter } from './git-file-writer.ts';
import { MarketPrepareError } from './prepare.ts';
import type { MarketPrepareInput, MarketPrepareResult } from './prepare.ts';
import { parseMarketIndex, parseMarketItemManifest } from './index-parser.ts';
import type { MarketIndex, MarketIndexItem, MarketItemManifest } from './types.ts';
import { MARKET_INDEX_SCHEMA_VERSION } from './types.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { redact } from '../security/redaction.ts';
import type { SectionId } from '../schema/types.ts';

/* ---------------------------------------------------------------- 常量（固定规则，无配置入口） */

/** 官方收录目标仓库原样复用 t1 常量（github-repos.ts）
 *  —— 与内置市场同一仓库，界面不提供任何修改入口（设计 §2.4 产品决策）。 */

/** 用户公开仓库固定名：<login>/dsh-configs（系统按规则生成，不可配置） */
export const USER_CONFIGS_REPO = 'dsh-configs';
/** 用户仓库 index.json 的名称/描述（展示用） */
export const USER_INDEX_NAME = '我的配置仓库';
/** PR 分支固定名模式：dsh-market-sync/<itemId> */
export const PR_BRANCH_PREFIX = 'dsh-market-sync';

/** 由 itemId 生成 PR 分支名（固定模式，同条目复用同一分支：未合并 force push 更新、已合并基于最新 main 重开） */
export function prBranchFor(itemId: string): string {
  return `${PR_BRANCH_PREFIX}/${itemId}`;
}

/** 用户公开仓库 URL（https 形态，绝不携带凭据） */
export function userConfigsRepoUrl(login: string): string {
  return `https://github.com/${login}/${USER_CONFIGS_REPO}`;
}

/* ---------------------------------------------------------------- 领域类型（client 半引用） */

/** 条目收录状态：未收录（本地独有）｜ PR 待审核（带 PR 链接）｜ 已收录（官方市场 index 含该 id） */
export type MyItemStatus = 'not-listed' | 'pr-pending' | 'listed';

/** 上传表单：仅用户填写的描述性内容；id/author/version/updatedAt/repoUrl 全自动 */
export interface MyRepoForm {
  /** 配置名（预填 zip 文件名，可改）；id 由其派生稳定 slug */
  name: string;
  description?: string;
  categories?: string[];
}

/** upload / update 返回（ok=false 时携带已脱敏 error + errorCode） */
export interface UploadResult {
  ok: boolean;
  itemId: string;
  version: string;
  sha256: string;
  sections: SectionId[];
  /** 用户公开仓库 URL（https://github.com/<login>/dsh-configs） */
  repoUrl: string;
  prNumber: number | null;
  prUrl: string | null;
  warnings: string[];
  /** ok=false 时：可展示错误（已脱敏，无 token 形态） */
  error?: string;
  /** ok=false 时：错误分类码（unauthorized/prepare_failed/...；无则 'internal'） */
  errorCode?: string;
}

/** listItems 条目：用户仓库 index.json 条目 + 收录状态 */
export interface MyItemEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  updatedAt?: string;
  categories?: string[];
  status: MyItemStatus;
  /** status=pr-pending 时：PR 链接 */
  prUrl?: string;
  /** 用户公开仓库 URL */
  repoUrl: string;
}

/* ---------------------------------------------------------------- rest 端口（结构接口，可 mock） */

/**
 * MyRepoService 需要的 GitHub REST 子集（GitHubAuthRest 结构兼容；测试用普通对象 mock）。
 * 类型用接口而非具体类，便于 plain-object mock 注入。
 */
export interface GitHubRestLike {
  getUser(): Promise<GitHubUserInfo>;
  repoExists(owner: string, repo: string): Promise<boolean>;
  createPublicRepo(name: string, description?: string): Promise<GitHubRepoInfo>;
  ensureFork(owner: string, repo: string): Promise<GitHubForkInfo>;
  readFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
  openPullRequest(params: GitHubPullRequestParams): Promise<GitHubPullRequestInfo>;
  listOpenPullRequests(owner: string, repo: string, head?: string): Promise<GitHubPullRequestInfo[]>;
}

/* ---------------------------------------------------------------- 服务选项与错误 */

export interface MyRepoServiceOptions {
  /** 8 道校验 + 秘密扫描（复用 prepareMarketItem；测试 mock；抛 MarketPrepareError 视为校验失败） */
  prepare: (input: MarketPrepareInput) => MarketPrepareResult;
  /** GitHub REST 薄客户端（复用 GitHubAuthRest 或 mock） */
  rest: GitHubRestLike;
  /** git 文件写入器（缺省用 tokenProvider 构造真实 GitFileWriterClient；测试注入 mock） */
  gitWriter?: GitFileWriter;
  /** token 提供者（真实 gitWriter 缺省构造用；与 rest/gitWriter 的 token 同源） */
  tokenProvider: () => Promise<string>;
  /** 时钟（updatedAt 生成用）；缺省 new Date() */
  now?: () => Date;
  /** 工作副本根目录（缺省 os.tmpdir()/dsh-config-manager-my-configs）；测试注入隔离目录 */
  workDirRoot?: string;
}

/** MyRepoService 可预期错误（错误码供上层分类） */
export class MyRepoError extends Error {
  readonly code: string;
  constructor(message: string, code = 'my_repo') {
    super(message);
    this.name = 'MyRepoError';
    this.code = code;
  }
}

/* ---------------------------------------------------------------- 纯函数（node 可单测） */

/** name → 稳定安全 itemId：小写、非字母数字折叠为 -、字母数字开头、去头尾分隔符；空 → config-<hash> */
export function slugifyItemId(name: string): string {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fallback = `config-${sha256Hex(name).slice(0, 8)}`;
  const candidate = base.length > 0 ? base : fallback;
  const prefixed = /^[a-z0-9]/.test(candidate) ? candidate : `config-${candidate}`;
  return prefixed.slice(0, 128).replace(/[._-]+$/, '');
}

/** 冲突自动加后缀（设计：id=name 稳定 slug，同名已存在 → my-config-2 / -3 ...） */
export function uniqueItemId(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** 版本纯自动 +1：最后一个数字段 +1；非数字尾 → 追加 .1 */
export function bumpVersion(version: string): string {
  const parts = version.trim().split('.');
  const last = parts[parts.length - 1] ?? '';
  const n = parseInt(last, 10);
  if (!Number.isInteger(n) || String(n) !== last) return `${version.trim()}.1`;
  parts[parts.length - 1] = String(n + 1);
  return parts.join('.');
}

/** 空用户索引（首次上传时创建） */
function emptyIndex(): MarketIndex {
  return { schemaVersion: MARKET_INDEX_SCHEMA_VERSION, name: USER_INDEX_NAME, items: [] };
}

/** upsert 条目：同 id 覆盖（保持原位置），否则追加 */
function upsertIndexItem(index: MarketIndex, item: MarketIndexItem): MarketIndex {
  const idx = index.items.findIndex((it) => it.id === item.id);
  const items = [...index.items];
  if (idx >= 0) items[idx] = item;
  else items.push(item);
  return { ...index, items };
}

/** manifest → 用户仓库 index 条目（不含 repo：条目即在本仓库） */
function toUserIndexItem(m: MarketItemManifest): MarketIndexItem {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.author !== undefined ? { author: m.author } : {}),
    ...(m.updatedAt !== undefined ? { updatedAt: m.updatedAt } : {}),
    ...(m.categories !== undefined && m.categories.length > 0 ? { categories: m.categories } : {}),
  };
}

/** manifest → 官方市场 index 条目（带 repo 自托管引用，指向用户公开仓库） */
function toOfficialIndexItem(m: MarketItemManifest, repoUrl: string): MarketIndexItem {
  return { ...toUserIndexItem(m), repo: repoUrl };
}

/** 错误分类：GitHubApiError / MyRepoError / MarketPrepareError 取其 code；其余 'internal' */
function classifyError(err: unknown): string {
  if (err instanceof GitHubApiError || err instanceof MyRepoError) return err.code;
  if (err instanceof MarketPrepareError) return 'prepare_failed';
  return 'internal';
}

/** 失败 result 构造（消息过 redact 脱敏，绝不带 token/凭据形态） */
function failureResult(itemId: string, version: string, err: unknown): UploadResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    itemId,
    version,
    sha256: '',
    sections: [],
    repoUrl: '',
    prNumber: null,
    prUrl: null,
    warnings: [],
    error: redact(msg),
    errorCode: classifyError(err),
  };
}

/* ---------------------------------------------------------------- MyRepoService */

export class MyRepoService {
  private readonly prepare: (input: MarketPrepareInput) => MarketPrepareResult;
  private readonly rest: GitHubRestLike;
  private readonly gitWriter: GitFileWriter;
  private readonly tokenProvider: () => Promise<string>;
  private readonly now: () => Date;
  private readonly workDirRoot: string;

  constructor(options: MyRepoServiceOptions) {
    if (options.prepare === null || typeof options.prepare !== 'function') {
      throw new MyRepoError('prepare 必填');
    }
    if (options.rest === null || typeof options.rest !== 'object') {
      throw new MyRepoError('rest 必填');
    }
    this.prepare = options.prepare;
    this.rest = options.rest;
    this.tokenProvider = options.tokenProvider;
    this.now = options.now ?? (() => new Date());
    this.workDirRoot = options.workDirRoot ?? join(os.tmpdir(), 'dsh-config-manager-my-configs');
    this.gitWriter = options.gitWriter ?? createGitFileWriter({ credentials: { getToken: options.tokenProvider } });
  }

  /** 一键上传：新条目（version 1.0.0；同名冲突自动加后缀）。 */
  async upload(params: { zipBytes: Uint8Array; form: MyRepoForm }): Promise<UploadResult> {
    return this.runPublish({ ...params, mode: 'upload' });
  }

  /** 一键更新：id 保持不变、version 纯自动 +1、updatedAt 刷新；名称变化视为新条目。 */
  async update(params: { zipBytes: Uint8Array; form: MyRepoForm }): Promise<UploadResult> {
    return this.runPublish({ ...params, mode: 'update' });
  }

  /** 列出已上传条目（读用户仓库 index.json）+ 收录状态（官方 index / open PR）。 */
  async listItems(): Promise<MyItemEntry[]> {
    const user = await this.rest.getUser(); // 401 → GitHubApiError(unauthorized)，由上层映射「请重新登录」
    const login = user.login;
    const repoUrl = userConfigsRepoUrl(login);
    const indexText = await this.rest.readFile(login, USER_CONFIGS_REPO, 'index.json');
    if (indexText === null) return []; // 从未上传
    const parsed = parseMarketIndex(indexText);
    if (!parsed.ok || parsed.index === null) {
      throw new MyRepoError('用户仓库 index.json 无法解析（可能被外部修改）', 'index_invalid');
    }
    // 收录状态：官方 index 含该 id → listed；否则按设计 §4.5 以 head=<login>:<branch>
    // 过滤 open PR（避免跨用户同名分支误报）→ pr-pending；否则 not-listed
    const officialText = await this.rest.readFile(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO, 'index.json');
    const officialIds = new Set<string>();
    if (officialText !== null) {
      const op = parseMarketIndex(officialText);
      if (op.ok && op.index !== null) {
        for (const it of op.index.items) officialIds.add(it.id);
      }
    }
    const entries: MyItemEntry[] = [];
    for (const it of parsed.index.items) {
      if (officialIds.has(it.id)) {
        entries.push({ ...it, status: 'listed' as const, repoUrl });
        continue;
      }
      const openPrs = await this.rest.listOpenPullRequests(
        MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO, `${login}:${prBranchFor(it.id)}`,
      );
      if (openPrs.length > 0) {
        const pr = openPrs[0]!;
        entries.push({ ...it, status: 'pr-pending' as const, prUrl: pr.htmlUrl, repoUrl });
      } else {
        entries.push({ ...it, status: 'not-listed' as const, repoUrl });
      }
    }
    return entries;
  }

  /* ---------------- 上传/更新共享状态机 ---------------- */

  private async runPublish(
    params: { zipBytes: Uint8Array; form: MyRepoForm; mode: 'upload' | 'update' },
  ): Promise<UploadResult> {
    const form = params.form;
    const baseId = slugifyItemId(form.name);
    try {
      // ① 登录（校验 token）→ login
      const user = await this.rest.getUser();
      const login = user.login;
      const repoUrl = userConfigsRepoUrl(login);

      // ② 读用户仓库最新 index（先拉最新，防覆盖；文件不存在 → 空索引）
      const userIndex = await this.readUserIndex(login);
      const ids = userIndex.index.items.map((it) => it.id);

      // ③ 元数据全自动：itemId / version
      let itemId: string;
      let version: string;
      const warnings: string[] = [];
      if (params.mode === 'update') {
        const existing = userIndex.index.items.find((it) => it.id === baseId);
        if (existing !== undefined) {
          itemId = existing.id; // id 保持不变
          version = bumpVersion(existing.version ?? '0.0.0');
        } else {
          itemId = uniqueItemId(baseId, ids); // 名称变化 → 作为新条目
          version = '1.0.0';
          warnings.push('未找到同名已上传条目，名称变化将作为新条目发布');
        }
      } else {
        itemId = uniqueItemId(baseId, ids);
        version = '1.0.0';
      }

      // ④ prepare（8 道校验 + 秘密扫描；含密钥/禁止分区 → 抛 MarketPrepareError → 零推送）
      const prepared = this.prepare({
        itemId,
        name: form.name.trim(),
        version,
        ...(form.description !== undefined && form.description.trim() !== '' ? { description: form.description.trim() } : {}),
        author: login,
        ...(form.categories !== undefined && form.categories.length > 0 ? { categories: form.categories } : {}),
        repoUrl,
        zipBytes: params.zipBytes,
        now: this.now().toISOString(),
      });
      const manifest = this.parsePreparedManifest(prepared.manifestText);

      // ⑤ ensure 用户仓库 <login>/dsh-configs（复用或自动创建公开仓库）
      const repo = await this.ensureUserRepo(login);

      // ⑥ 写用户仓库：items/<id>/manifest.json + config.zip + 更新 index.json，commit + push
      const updatedUserIndex = upsertIndexItem(userIndex.index, toUserIndexItem(manifest));
      await this.gitWriterManifestSync(login, repo, prepared, params.zipBytes, updatedUserIndex, itemId, version, params.mode);

      // ⑦ ensureFork 官方仓库（复用已 fork / 新建 + 轮询就绪）
      const fork = await this.rest.ensureFork(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO);

      // ⑧ 官方 index：读最新 → 更新条目（带 repo 自托管引用）→ 写 fork 分支 + force push
      const officialIndex = await this.readOfficialIndex();
      const updatedOfficial = upsertIndexItem(officialIndex.index, toOfficialIndexItem(manifest, repoUrl));
      const branch = prBranchFor(itemId);
      await this.gitWriter.writeFiles({
        repoUrl: fork.cloneUrl,
        workDir: this.forkWorkDir(login),
        upstreamUrl: `https://github.com/${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}.git`,
        branch,
        baseRef: 'upstream/main',
        force: true,
        entries: [{ path: 'index.json', content: stringifyJsonSafe(updatedOfficial, { space: 2 }) }],
        commitMessage: `market: ${params.mode === 'update' ? 'update' : 'add'} ${itemId} v${version}`,
      });

      // ⑨ PR：查 open PR（head=<login>:<branch>）复用；无则创建
      const pr = await this.ensurePullRequest(login, branch, itemId, version);

      return {
        ok: true,
        itemId,
        version,
        sha256: prepared.sha256,
        sections: prepared.sections,
        repoUrl,
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
        warnings: [...prepared.warnings, ...warnings],
      };
    } catch (err) {
      return failureResult(baseId, '1.0.0', err);
    }
  }

  /** ⑥ 写用户仓库工作副本（隔离方法，便于单测断言 gitWriter 调用） */
  private async gitWriterManifestSync(
    login: string,
    repo: GitHubRepoInfo,
    prepared: MarketPrepareResult,
    zipBytes: Uint8Array,
    updatedIndex: MarketIndex,
    itemId: string,
    version: string,
    mode: 'upload' | 'update',
  ): Promise<void> {
    await this.gitWriter.writeFiles({
      repoUrl: repo.cloneUrl,
      workDir: this.userWorkDir(login),
      entries: [
        { path: `items/${itemId}/manifest.json`, content: prepared.manifestText },
        { path: `items/${itemId}/config.zip`, content: zipBytes },
        { path: 'index.json', content: stringifyJsonSafe(updatedIndex, { space: 2 }) },
      ],
      commitMessage: `publish: ${mode === 'update' ? 'update' : 'add'} ${itemId} v${version}`,
    });
  }

  /* ---------------- 内部辅助 ---------------- */

  /** 读用户仓库最新 index.json；文件不存在（未上传过）→ 空索引；无法解析 → 中止（防覆盖写坏） */
  private async readUserIndex(login: string): Promise<{ index: MarketIndex; exists: boolean }> {
    const text = await this.rest.readFile(login, USER_CONFIGS_REPO, 'index.json');
    if (text === null) return { index: emptyIndex(), exists: false };
    const parsed = parseMarketIndex(text);
    if (!parsed.ok || parsed.index === null) {
      throw new MyRepoError('用户仓库 index.json 无法解析（可能被外部修改），已中止，请检查后重试', 'index_invalid');
    }
    return { index: parsed.index, exists: true };
  }

  /** 读官方市场 index.json（公开仓库 contents API）；缺失/无法解析 → 中止 */
  private async readOfficialIndex(): Promise<{ index: MarketIndex }> {
    const text = await this.rest.readFile(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO, 'index.json');
    if (text === null) {
      throw new MyRepoError('官方市场 index.json 不存在', 'official_index_missing');
    }
    const parsed = parseMarketIndex(text);
    if (!parsed.ok || parsed.index === null) {
      throw new MyRepoError('官方市场 index.json 无法解析', 'official_index_invalid');
    }
    return { index: parsed.index };
  }

  /** prepare 生成的 manifestText 解析回对象（受控字段）；异常 → 内部错误 */
  private parsePreparedManifest(manifestText: string): MarketItemManifest {
    const parsed = parseMarketItemManifest(manifestText);
    if (!parsed.ok || parsed.manifest === null) {
      throw new MyRepoError('prepare 生成的 manifest 无效', 'internal');
    }
    return parsed.manifest;
  }

  /** ⑤ ensure 用户仓库：存在 → 返回已知信息；不存在 → createPublicRepo（公开，系统命名） */
  private async ensureUserRepo(login: string): Promise<GitHubRepoInfo> {
    const exists = await this.rest.repoExists(login, USER_CONFIGS_REPO);
    if (exists) {
      return {
        fullName: `${login}/${USER_CONFIGS_REPO}`,
        htmlUrl: userConfigsRepoUrl(login),
        cloneUrl: `${userConfigsRepoUrl(login)}.git`,
        defaultBranch: 'main',
        private: false,
        fork: false,
      };
    }
    return this.rest.createPublicRepo(USER_CONFIGS_REPO, '我的配置仓库（dsh-config-manager 自动发布）');
  }

  /** ⑨ ensure PR：open PR（head=<login>:<branch>）存在 → 复用；否则 openPullRequest(base=main) */
  private async ensurePullRequest(login: string, branch: string, itemId: string, version: string): Promise<GitHubPullRequestInfo> {
    const head = `${login}:${branch}`;
    const open = await this.rest.listOpenPullRequests(MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO, head);
    if (open.length > 0) return open[0]!;
    return this.rest.openPullRequest({
      head,
      base: 'main',
      title: `市场收录：${itemId} v${version}`,
      body: [
        `由 dsh-config-manager「一键上传」自动提交。`,
        '',
        `- 条目：${itemId} v${version}`,
        `- 内容托管：用户公开仓库（见 index.json 条目 repo 字段）`,
        `- 校验：dsh-config-market CI（validate.yml）将自动执行 8 道校验与秘密扫描`,
      ].join('\n'),
    });
  }

  private userWorkDir(login: string): string {
    return join(this.workDirRoot, `user-${login}`);
  }

  private forkWorkDir(login: string): string {
    return join(this.workDirRoot, `fork-${login}`);
  }
}