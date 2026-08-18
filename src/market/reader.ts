/**
 * m-market：市场只读读取通道（MarketReader / GitMarketReader）。
 *
 * 与 docs/design/marketplace.md §4 对齐：
 * - 市场用「只读 git fetch」，不复用 GitTransport 的写路径（commit/push/snapshots/<id>/ 布局）；
 * - 复用点：git 命令执行层（execFile promise 封装 / 脱敏 mask / SnapshotFs）+ validateRepoUrl；
 * - 每次读取：ensureRepo() 首次 git clone --depth 1，已存在副本则 git pull --ff-only；
 * - 默认公开市场不注入凭据（repoUrl 拒绝 userinfo）；二期私有市场才走 token credential helper；
 * - itemId 必须过 assertSafeItemId（防 items/<id>/ 越界）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { createSnapshotFs, joinFs } from '../sync/fs.ts';
import type { SnapshotFs } from '../sync/fs.ts';
import { validateRepoUrl } from '../sync/sync-config.ts';
import type { GitExecResult } from '../sync/git/git-transport.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { assertSafeItemId } from './types.ts';

const execFileAsync = promisify(execFile);

/** 可注入 git 执行器（与 git-transport GitExecFn 同构；测试 mock 用） */
export type MarketGitExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<GitExecResult>;

const defaultExec: MarketGitExecFn = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
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

export class MarketReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketReaderError';
  }
}

/** 只读市场读取通道接口（§4.1） */
export interface MarketReader {
  /** 拉取市场目录（拉最新 index.json；返回原文 + 拉取时间） */
  readIndex(opts: { url: string; workDir: string }): Promise<{ text: string; fetchedAt: string }>;
  /** 拉取单条目 manifest.json（返回 raw 文本） */
  readItemManifest(opts: { url: string; workDir: string; itemId: string }): Promise<{ text: string }>;
  /** 拉取单条目 config.zip（返回 bytes） */
  readItemZip(opts: { url: string; workDir: string; itemId: string }): Promise<{ data: Uint8Array }>;
}

export interface GitMarketReaderOptions {
  /** git 可执行文件名/路径，默认 'git' */
  gitBin?: string;
  /** 单条 git 命令超时 ms，默认 60000 */
  timeoutMs?: number;
  /** 注入 exec（测试 mock 用）；缺省 = execFile 封装 */
  exec?: MarketGitExecFn;
  /** 注入 fs 门面（测试 mock 用） */
  fsx?: SnapshotFs;
  /** 消息翻译器（缺省 zh） */
  msg?: MsgFunc;
}

/** 只读 git 市场读取通道实现 */
export class GitMarketReader implements MarketReader {
  private readonly gitBin: string;
  private readonly timeoutMs: number;
  private readonly exec: MarketGitExecFn;
  private readonly fsx: SnapshotFs;
  private readonly msg: MsgFunc;

  constructor(options: GitMarketReaderOptions = {}) {
    this.gitBin = options.gitBin ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.exec = options.exec ?? defaultExec;
    this.fsx = options.fsx ?? createSnapshotFs();
    this.msg = options.msg ?? zhMsg;
  }

  /**
   * 拉取市场目录。首次 clone --depth 1 到 workDir；已存在副本则 pull --ff-only。
   * 返回 index.json 原文 + 拉取时间（ISO-8601）。
   */
  async readIndex(opts: { url: string; workDir: string }): Promise<{ text: string; fetchedAt: string }> {
    validateMarketUrl(opts.url);
    await this.ensureRepo(opts.url, opts.workDir);
    const abs = joinFs(opts.workDir, 'index.json');
    if (!(await this.fsx.exists(abs))) {
      throw new MarketReaderError(this.msg('market.missingIndex', { url: opts.url }));
    }
    const raw = Buffer.from(await this.fsx.readFile(abs)).toString('utf8');
    return { text: raw, fetchedAt: new Date().toISOString() };
  }

  /** 拉取单条目 L2 manifest.json 原文 */
  async readItemManifest(opts: { url: string; workDir: string; itemId: string }): Promise<{ text: string }> {
    assertSafeItemId(opts.itemId);
    validateMarketUrl(opts.url);
    await this.ensureRepo(opts.url, opts.workDir);
    const abs = joinFs(opts.workDir, `items/${opts.itemId}/manifest.json`);
    if (!(await this.fsx.exists(abs))) {
      throw new MarketReaderError(this.msg('market.missingManifest', { id: opts.itemId }));
    }
    const raw = Buffer.from(await this.fsx.readFile(abs)).toString('utf8');
    return { text: raw };
  }

  /** 拉取单条目 L3 config.zip 字节 */
  async readItemZip(opts: { url: string; workDir: string; itemId: string }): Promise<{ data: Uint8Array }> {
    assertSafeItemId(opts.itemId);
    validateMarketUrl(opts.url);
    await this.ensureRepo(opts.url, opts.workDir);
    const abs = joinFs(opts.workDir, `items/${opts.itemId}/config.zip`);
    if (!(await this.fsx.exists(abs))) {
      throw new MarketReaderError(this.msg('market.missingZip', { id: opts.itemId }));
    }
    return { data: await this.fsx.readFile(abs) };
  }

  /* ---------------- 内部实现 ---------------- */

  /** 确保本地工作副本就绪：首次 clone --depth 1；已有 .git 则 pull --ff-only 同步远端。 */
  private async ensureRepo(url: string, workDir: string): Promise<void> {
    const fsx = this.fsx;
    if (await fsx.exists(path.join(workDir, '.git'))) {
      const res = await this.runGit(['pull', '--ff-only'], { cwd: workDir });
      if (res.code !== 0) {
        // 无 upstream / 全新分支等 → 静默跳过（内容可能已是最新或本地有未跟踪改动）
        if (/no tracking information/i.test(res.stderr)) return;
        throw new MarketReaderError(this.msg('market.pullFailed', { err: this.mask(res.stderr, url) }));
      }
      return;
    }
    await fsx.mkdir(workDir);
    const entries = await fsx.readdir(workDir);
    if (entries.length > 0) {
      throw new MarketReaderError(this.msg('market.workDirNotRepo', { dir: workDir }));
    }
    // 只读方针：--depth 1 兜底体积；公开市场无凭据（repoUrl 已拒绝 userinfo）
    const res = await this.runGit(['clone', '--depth', '1', url, '.'], { cwd: workDir });
    if (res.code !== 0) {
      throw new MarketReaderError(this.msg('market.cloneFailed', { err: this.mask(res.stderr, url) }));
    }
  }

  private async runGit(args: string[], opts: { cwd?: string }): Promise<GitExecResult> {
    return this.exec(this.gitBin, args, { cwd: opts.cwd, timeoutMs: this.timeoutMs });
  }

  /** 错误脱敏：公开 URL 无可泄 token，但保留通用脱敏（防御 url 意外含凭据）。 */
  private mask(text: string, url: string): string {
    return text.split(url).join('[REPO_URL]');
  }
}

/** 校验市场仓库地址（复用 validateRepoUrl）；非法抛错。 */
export function validateMarketUrl(url: string): void {
  const err = validateRepoUrl(url);
  if (err !== null) throw new MarketReaderError(err);
}
