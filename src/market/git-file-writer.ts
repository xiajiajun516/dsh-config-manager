/**
 * m-market：GitFileWriter —— 通用 git 文件写入器（「一键上传/我的配置」专用）。
 *
 * 背景（docs/design/2026-08-20-my-configs-design.md §4.2 / §4.3）：
 * GitTransport（src/sync/git/git-transport.ts）实现的是 SyncTransport 接口，语义是
 * **快照同步**（list/upload/download/delete，内容提交到 snapshots/ 与 snapshots-encrypted/），
 * 不是通用 git 文件写入工具。MyRepoService 需要写入自定义目录结构
 * （items/<id>/manifest.json + config.zip + index.json、PR 分支），因此本模块提供
 * 「clone 工作副本 → 写文件 → commit → push」的薄写入器，供上传/更新编排复用。
 *
 * 安全模式沿用 GitTransport（硬约束，不得破坏）：
 * - token 仅经 credentials.getToken() 读取，经 git credential helper（store --file=临时文件，
 *   权限 0600，用后即删）传给 git —— token 绝不进入 argv / repoUrl / commit message / 日志；
 * - repoUrl 必须过 validateRepoUrl（http(s)，拒绝 userinfo），url 永不携带凭据；
 * - fork 的 PR 分支基于官方最新 main（upstream fetch），force push 用 --force-with-lease；
 * - 错误消息一律 mask（repoUrl / token 原文与 URL 编码形态 → [REPO_URL] / [REDACTED]）。
 *
 * 依赖注入：credentials / exec / timeoutMs / author 可注入，测试全程 mock 不碰真实网络。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { validateRepoUrl } from '../sync/sync-config.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { quoteGitValue } from '../utils/git-quote.ts';
import { withWorkdirLock, WorkdirLockError } from '../utils/workdir-lock.ts';
import { fastForwardFetchArgs, fastForwardMergeArgs, isMissingRemoteRefError, parseCurrentBranch } from '../utils/git-fast-forward.ts';
import { marketMsg } from './messages-market.ts';
import type { GitAuthor, GitCredentialProvider, GitExecFn, GitExecResult } from '../sync/git/git-transport.ts';
import { clearDirContents, credentialHeaderEnv, isEmptyDir, isCredentialExecFailure } from '../sync/git/credential-auth.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'DSH Config Manager', email: 'publish@dsh.local' };
const DEFAULT_CREDENTIAL_USERNAME = 'oauth2';

/** 单条写入条目：仓库相对路径（正斜杠；自动建父目录）+ 内容（string → UTF-8，Uint8Array → 原样） */
export interface GitFileWriteEntry {
  path: string;
  content: string | Uint8Array;
}

/** writeFiles 调用参数 */
export interface GitFileWriteCall {
  /** 目标仓库 https 地址（token 绝不拼入；过 validateRepoUrl） */
  repoUrl: string;
  /** 本地 git 工作副本目录（不存在则 clone；已存在则快进到远端） */
  workDir: string;
  /** 要写入的文件 */
  entries: GitFileWriteEntry[];
  /** commit message */
  commitMessage: string;
  /** 目标分支：指定则 checkout -B（PR 分支场景）；缺省 = 默认分支直接提交推送 */
  branch?: string;
  /** 分支基点（如 'upstream/main'）；branch 提供且缺省 baseRef 时按 origin/main → origin/master 探测 */
  baseRef?: string;
  /** 额外远端（官方仓库）：clone fork 后 add upstream + fetch 官方 main，供 baseRef 使用 */
  upstreamUrl?: string;
  /** force push 用（PR 分支更新场景）：--force-with-lease */
  force?: boolean;
}

/** writeFiles 结果：pushed=false = 内容无变化（幂等，不产生 commit/push） */
export interface GitFileWriterResult {
  pushed: boolean;
  /** 实际推送的分支（未指定分支时 'default'） */
  branch: string;
}

/** 通用 git 文件写入器契约（MyRepoService 依赖注入点；测试 mock 用） */
export interface GitFileWriter {
  writeFiles(call: GitFileWriteCall): Promise<GitFileWriterResult>;
}

/** createGitFileWriter 选项 */
export interface CreateGitFileWriterOptions {
  /** token 提供者（必填；http(s) 远端经 credential helper 注入） */
  credentials: GitCredentialProvider;
  /** 注入 exec（测试 mock 用）；缺省 = execFile 封装 */
  exec?: GitExecFn;
  /** 单条 git 命令超时 ms，默认 60000 */
  timeoutMs?: number;
  /** 提交作者（写入远端历史） */
  author?: GitAuthor;
}

export class GitFileWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitFileWriterError';
  }
}

const defaultExec: GitExecFn = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      // issue #120：credential helper 走不了 shell 时改用 env 注入认证头重试（追加在继承的 process.env 上）
      env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? (err instanceof Error ? err.message : String(err))),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

/** 错误/日志脱敏：repoUrl（原文）与 token（原文与 URL 编码形态）一律替换 */
function makeMask(repoUrl: string, token: string): (text: string) => string {
  return (text: string): string => {
    let out = text.split(repoUrl).join('[REPO_URL]');
    if (token && token.length >= 4) {
      out = out.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]');
    }
    return out;
  };
}

/** 校验仓库地址：http(s)（validateRepoUrl 拒绝 userinfo/空白）；非法抛 GitFileWriterError */
function validateAndNormalizeRepoUrl(repoUrl: string): string {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    throw new GitFileWriterError(marketMsg('market.gitWriter.repoUrlEmpty'));
  }
  const err = validateRepoUrl(repoUrl);
  if (err !== null) throw new GitFileWriterError(marketMsg('market.gitWriter.repoUrlInvalid', { reason: err }));
  if (!/^https?:\/\//i.test(repoUrl.trim())) {
    throw new GitFileWriterError(marketMsg('market.gitWriter.repoUrlScheme'));
  }
  return repoUrl.trim();
}

/** 实现 GitFileWriter 的真实 git 写入器（安全模式与 GitTransport 一致）。 */
export class GitFileWriterClient implements GitFileWriter {
  private readonly credentials: GitCredentialProvider;
  private readonly gitBin: string;
  private readonly timeoutMs: number;
  private readonly exec: GitExecFn;
  private readonly author: GitAuthor;
  private readonly credentialUsername: string;

  constructor(options: CreateGitFileWriterOptions) {
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getToken !== 'function') {
      throw new GitFileWriterError(marketMsg('market.gitWriter.credentialsRequired'));
    }
    this.credentials = options.credentials;
    this.gitBin = 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = options.exec ?? defaultExec;
    this.author = options.author ?? DEFAULT_AUTHOR;
    this.credentialUsername = DEFAULT_CREDENTIAL_USERNAME;
  }

  /**
   * 写文件并推送：
   * 0. 整段写入（判 .git → clone / 拉取 → checkout → 写文件 → add → commit → push）都在**工作副本锁**内：
   *    并发驱动同一个工作副本会撞 index.lock、让 FETCH_HEAD 写坏导致 pull 自己 fatal
   *    （真机 incident 2026-10-23 同款），锁也可防同进程两个上传互相踩；
   * 1. ensureRepo：工作副本不存在 → clone（带凭据）；存在 → 快进远端（显式 refspec fetch +
   *    merge --ff-only，不读 FETCH_HEAD；无 upstream / 远端无同名分支静默跳过）；
   * 2. upstreamUrl → ensureUpstream（add upstream + fetch 官方 main，公开仓库匿名只读）；
   * 3. branch 指定 → checkout -B <branch> <baseRef ?? 远端默认分支探测>；
   * 4. 写文件（自动建目录）→ add → diff --cached --quiet（无变化 → 返回 pushed:false 幂等）→ commit → push；
   * 5. push：branch → push -u origin <branch> [--force-with-lease]；否则 push -u origin HEAD。
   */
  async writeFiles(call: GitFileWriteCall): Promise<GitFileWriterResult> {
    const repoUrl = validateAndNormalizeRepoUrl(call.repoUrl);
    if (typeof call.workDir !== 'string' || call.workDir === '') {
      throw new GitFileWriterError(marketMsg('market.gitWriter.workDirEmpty'));
    }
    if (!Array.isArray(call.entries) || call.entries.length === 0) {
      throw new GitFileWriterError(marketMsg('market.gitWriter.entriesEmpty'));
    }
    const token = await this.credentials.getToken();
    const mask = makeMask(repoUrl, token);

    try {
      return await withWorkdirLock(call.workDir, () => this.writeFilesLocked(call, repoUrl, token, mask));
    } catch (err) {
      // 等锁超时不是「上传失败」而是「另一个上传任务还没结束」→ 换成可操作的提示
      if (err instanceof WorkdirLockError) {
        throw new GitFileWriterError(marketMsg('market.gitWriter.workdirBusy', { dir: call.workDir }));
      }
      throw err;
    }
  }

  /** writeFiles 的临界区（调用方已持工作副本锁）。 */
  private async writeFilesLocked(
    call: GitFileWriteCall, repoUrl: string, token: string, mask: (text: string) => string,
  ): Promise<GitFileWriterResult> {
    await this.ensureRepo(repoUrl, call.workDir, token, mask);
    if (call.upstreamUrl !== undefined && call.upstreamUrl !== '') {
      const upstream = validateAndNormalizeRepoUrl(call.upstreamUrl);
      await this.ensureUpstream(call.workDir, upstream, mask);
    }
    const branch = call.branch ?? '';
    if (branch !== '') {
      const base = call.baseRef && call.baseRef !== '' ? call.baseRef : await this.detectDefaultBase(call.workDir, token, mask);
      const co = await this.runGit(['checkout', '-B', branch, base], { cwd: call.workDir, token, mask });
      if (co.code !== 0) {
        throw new GitFileWriterError(mask(marketMsg('market.gitWriter.checkoutFailed', { stderr: co.stderr })));
      }
    }
    for (const entry of call.entries) {
      const abs = path.join(call.workDir, entry.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : Buffer.from(entry.content));
    }
    const add = await this.runGit(['add', '-A', '--', '.'], { cwd: call.workDir, token, mask });
    if (add.code !== 0) {
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.addFailed', { stderr: add.stderr })));
    }
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { cwd: call.workDir, allowNonZero: true, token, mask });
    if (diff.code === 0) {
      return { pushed: false, branch: branch !== '' ? branch : 'default' };
    }
    const commit = await this.runGit(['commit', '-m', call.commitMessage], { cwd: call.workDir, token, mask });
    if (commit.code !== 0) {
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.commitFailed', { stderr: commit.stderr })));
    }
    const pushArgs = branch !== ''
      ? ['push', '-u', 'origin', branch, ...(call.force === true ? ['--force-with-lease'] : [])]
      : ['push', '-u', 'origin', 'HEAD'];
    const push = await this.runGit(pushArgs, { cwd: call.workDir, withCredential: true, token, mask, repoUrl: call.repoUrl });
    if (push.code !== 0) {
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.pushFailed', { stderr: push.stderr })));
    }
    return { pushed: true, branch: branch !== '' ? branch : 'default' };
  }

  /* ---------------- 内部实现（安全模式与 GitTransport 一致） ---------------- */

  /**
   * 执行 git 命令；withCredential=true 时注入 credential helper store（token 不进 argv），
   * 失败时错误消息经 mask 脱敏。
   */
  private async runGit(
    args: string[],
    opts: {
      cwd?: string; withCredential?: boolean; allowNonZero?: boolean; token: string;
      mask: (text: string) => string; repoUrl?: string;
    },
  ): Promise<GitExecResult> {
    const cwd = opts.cwd ?? '';
    let extra: string[] = [];
    let cleanup: (() => Promise<void>) | null = null;
    if (opts.withCredential) {
      const cred = await this.buildCredentialArgs(opts.token);
      extra = cred.extraArgs;
      cleanup = cred.cleanup;
    }
    // issue #120：只有「命令开跑前目录是空的」才敢在重试前清空 —— 绝不删用户文件。
    const cloneTargetWasEmpty = args[0] === 'clone' ? await isEmptyDir(cwd) : false;
    try {
      let result = await this.exec(this.gitBin, [...extra, ...args], { cwd, timeoutMs: this.timeoutMs });
      // issue #120：同 GitTransport —— credential helper 必须经 shell 执行，Android 上 git 的 shell 路径
      // 不存在（askpass 又要 exec 权限）→ 改用 env 注入 HTTP 认证头重试一次（不需要 shell）。
      if (result.code !== 0 && opts.withCredential === true && opts.token !== ''
        && isCredentialExecFailure(result.stderr + ' ' + result.stdout)) {
        const headerEnv = credentialHeaderEnv(opts.repoUrl ?? '', this.credentialUsername, opts.token);
        if (Object.keys(headerEnv).length > 0 && (args[0] !== 'clone' || cloneTargetWasEmpty)) {
          if (args[0] === 'clone') await clearDirContents(cwd);
          result = await this.exec(this.gitBin, args, { cwd, timeoutMs: this.timeoutMs, env: headerEnv });
        }
      }
      if (result.code !== 0 && !opts.allowNonZero) {
        throw new GitFileWriterError(opts.mask(marketMsg('market.gitWriter.commandFailed', { args: args.join(' '), stderr: result.stderr })));
      }
      return result;
    } finally {
      if (cleanup) await cleanup();
    }
  }

  /**
   * 为网络命令构造 credential helper 参数：token 写入 os.tmpdir() 下临时 store 文件
   * （权限 0600），命令后立即删除 —— 永不落工作副本/远端/日志。
   */
  private async buildCredentialArgs(token: string): Promise<{ extraArgs: string[]; cleanup: () => Promise<void> }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-cred-'));
    const credFile = path.join(tmpDir, 'credential');
    const fileArg = quoteGitValue(credFile.replace(/\\/g, '/'));
    await atomicWriteFile(credFile, `https://${this.credentialUsername}:${token}@github.com\n`, { mode: 0o600, symlink: 'reject' });
    return {
      // issue #103：同 git-transport.buildCredentialArgs —— store 用 username 作查找键，
      // 不钉住就会被全局 `.gitconfig` 的 `credential.<url>.username` 顶掉而查不到口令。
      extraArgs: [
        '-c', 'credential.helper=',
        '-c', `credential.helper=store --file=${fileArg}`,
        '-c', `credential.username=${this.credentialUsername}`,
      ],
      cleanup: async () => { await fs.rm(tmpDir, { recursive: true, force: true }); },
    };
  }

  /**
   * 确保工作副本就绪：克隆（带凭据）或快进到远端（不读 FETCH_HEAD）。
   * **调用方已持工作副本锁**（writeFiles）—— 这里不得再次取锁，否则同进程自锁。
   */
  private async ensureRepo(
    repoUrl: string, workDir: string, token: string, mask: (text: string) => string,
  ): Promise<void> {
    await fs.mkdir(workDir, { recursive: true });
    const gitDir = path.join(workDir, '.git');
    let isRepo = false;
    try {
      await fs.stat(gitDir);
      isRepo = true;
    } catch {
      isRepo = false;
    }
    if (!isRepo) {
      const entries = await fs.readdir(workDir).catch(() => [] as string[]);
      if (entries.length > 0) {
        throw new GitFileWriterError(marketMsg('market.gitWriter.workDirNotEmpty', { workDir }));
      }
      const clone = await this.runGit(['clone', repoUrl, '.'], { cwd: workDir, withCredential: true, token, mask, repoUrl });
      if (clone.code !== 0) {
        throw new GitFileWriterError(mask(marketMsg('market.gitWriter.cloneFailed', { stderr: clone.stderr })));
      }
      const cfgName = await this.runGit(['config', 'user.name', this.author.name], { cwd: workDir, token, mask });
      if (cfgName.code !== 0) {
        throw new GitFileWriterError(mask(marketMsg('market.gitWriter.identityFailed', { stderr: cfgName.stderr })));
      }
      const cfgMail = await this.runGit(['config', 'user.email', this.author.email], { cwd: workDir, token, mask });
      if (cfgMail.code !== 0) {
        throw new GitFileWriterError(mask(marketMsg('market.gitWriter.identityFailed', { stderr: cfgMail.stderr })));
      }
      return;
    }
    // 已存在：有本地提交才快进（全新仓库无 HEAD / detached HEAD → 跳过）
    const head = await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: workDir, allowNonZero: true, token, mask });
    if (head.code !== 0) return;
    const branchRes = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir, allowNonZero: true, token, mask });
    const branch = branchRes.code === 0 ? parseCurrentBranch(branchRes.stdout) : '';
    if (branch === '') return;
    // 不再用 git pull --ff-only：并发下 FETCH_HEAD 会被写成多行 for-merge、pull 自己 fatal；
    // 显式 refspec fetch + 显式远端跟踪分支 merge 完全不读 FETCH_HEAD（参数见 utils/git-fast-forward.ts）。
    const fetched = await this.runGit(fastForwardFetchArgs(branch), { cwd: workDir, withCredential: true, allowNonZero: true, token, mask, repoUrl });
    if (fetched.code !== 0) {
      const combined = fetched.stderr + ' ' + fetched.stdout;
      // 无 upstream / 远端还没有这个分支 → 静默跳过（内容可能已是最新）
      if (isMissingRemoteRefError(combined) || /no tracking information/i.test(combined)) return;
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.pullFailed', { stderr: fetched.stderr })));
    }
    const merged = await this.runGit(fastForwardMergeArgs(branch), { cwd: workDir, allowNonZero: true, token, mask });
    if (merged.code !== 0) {
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.pullFailed', { stderr: merged.stderr })));
    }
  }

  /** 添加 upstream（官方仓库）并 fetch 官方 main（公开仓库匿名只读，零凭据）。 */
  private async ensureUpstream(workDir: string, upstreamUrl: string, mask: (text: string) => string): Promise<void> {
    const token = await this.credentials.getToken();
    const getUrl = await this.runGit(['remote', 'get-url', 'upstream'], { cwd: workDir, allowNonZero: true, token, mask });
    if (getUrl.code !== 0) {
      const add = await this.runGit(['remote', 'add', 'upstream', upstreamUrl], { cwd: workDir, token, mask });
      if (add.code !== 0) {
        throw new GitFileWriterError(mask(marketMsg('market.gitWriter.upstreamAddFailed', { stderr: add.stderr })));
      }
    }
    const fetch = await this.runGit(['fetch', 'upstream'], { cwd: workDir, allowNonZero: true, token, mask });
    if (fetch.code !== 0) {
      throw new GitFileWriterError(mask(marketMsg('market.gitWriter.upstreamFetchFailed', { stderr: fetch.stderr })));
    }
  }

  /** 探测远端默认分支（origin/main → origin/master）；找不到抛错。 */
  private async detectDefaultBase(workDir: string, token: string, mask: (text: string) => string): Promise<string> {
    for (const ref of ['origin/main', 'origin/master']) {
      const res = await this.runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: workDir, allowNonZero: true, token, mask });
      if (res.code === 0) return ref;
    }
    throw new GitFileWriterError(marketMsg('market.gitWriter.defaultBranchUnknown'));
  }
}

/** createGitFileWriter 工厂（MyRepoService 缺省 gitWriter 与路由层装配用） */
export function createGitFileWriter(options: CreateGitFileWriterOptions): GitFileWriter {
  return new GitFileWriterClient(options);
}