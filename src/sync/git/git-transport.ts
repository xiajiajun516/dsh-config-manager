/**
 * m-git-channel：Git 私有仓库通道（SyncTransport 的 git 实现）。
 *
 * 设计：
 * - 快照以「散文件目录」提交到 git 仓库：工作副本 <workDir>/snapshots/<id>/ 即 t2 layout 布局
 *   （manifest.json + 平铺 JSON 分区 + 文件类分区目录），每次 sync 一次 commit + push。
 * - 命令执行走 node:child_process execFile（promise 封装，数组参数无 shell 注入），
 *   默认 gitBin='git'，可注入 exec 便于测试。
 * - 认证：token 仅从注入的 credentials provider 读取（每次网络操作时 getToken()），
 *   经 git credential helper（store --file=<临时文件>）传给 git —— token 不进入 argv、
 *   不进入 repoUrl、不写入任何同步内容/commit message/日志；临时凭据文件用后即删。
 * - 私有仓库判定：checkIsPrivate() 先匿名 ls-remote（成功=公开），失败再用凭据探测
 *   （成功=私有），isPrivateHint 缓存最近结果供 UI 提示（私有仓库为推荐使用场景）。
 * - 契约：同 id 重复 upload = 覆盖（幂等友好：内容无变化时不产生 commit）；download 不存在抛错；
 *   delete 不存在视为成功。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createSnapshotFs, joinFs } from '../fs.ts';
import type { SnapshotFs } from '../fs.ts';
import { readSnapshotFromDir, SNAPSHOT_MANIFEST_FILE, writeSnapshotToDir } from '../layout.ts';
import type { SnapshotDirManifest } from '../layout.ts';
import { computeSnapshotMeta } from '../transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';

const execFileAsync = promisify(execFile);

/** git 命令执行结果（code ≠ 0 = git 命令失败/退出非零） */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 可注入的 git 执行器（测试 mock 用）；默认实现 = child_process.execFile promise 封装 */
export type GitExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<GitExecResult>;

/** 凭据提供者：token 只从这里读取，绝不在任何地方持久化 */
export interface GitCredentialProvider {
  getToken(): Promise<string>;
}

export interface GitAuthor { name: string; email: string; }

export interface GitTransportOptions {
  /** 远端私有仓库地址（https/ssh/本地路径）；token 绝不拼入此 URL */
  repoUrl: string;
  /** 本地 git 工作副本目录（不存在则创建；已 clone 则复用） */
  workDir: string;
  /** token 提供者（http(s) 远端必填；本地/ssh 远端不会被调用） */
  credentials: GitCredentialProvider;
  /** git 可执行文件名/路径，默认 'git' */
  gitBin?: string;
  /** 单条 git 命令超时 ms，默认 60000 */
  timeoutMs?: number;
  /** 注入 exec（测试 mock 用）；缺省 = execFile 封装 */
  exec?: GitExecFn;
  /** 提交作者（写入远端历史），默认 DSH Config Sync <sync@dsh.local> */
  author?: GitAuthor;
  /** credential 用户名（GitHub PAT 用 oauth2），默认 'oauth2' */
  credentialUsername?: string;
}

export class GitTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTransportError';
  }
}

const SNAPSHOTS_REL = 'snapshots';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'DSH Config Sync', email: 'sync@dsh.local' };
const DEFAULT_CREDENTIAL_USERNAME = 'oauth2';
/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防路径穿越与 commit message 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const defaultExec: GitExecFn = async (cmd, args, opts) => {
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

/** git config 值里的路径转义：含空白/引号时用引号包裹（Windows 路径转正斜杠） */
function quoteGitValue(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 实现 SyncTransport 的 git 通道。所有操作前 ensureRepo() 保证工作副本就绪，网络命令带凭据。 */
export class GitTransport implements SyncTransport {
  readonly type = 'git';

  private readonly o: GitTransportOptions & {
    gitBin: string;
    timeoutMs: number;
    author: GitAuthor;
    credentialUsername: string;
    exec: GitExecFn;
  };
  private repoReady = false;
  private privateHint: boolean | null = null;

  constructor(options: GitTransportOptions) {
    if (typeof options.repoUrl !== 'string' || options.repoUrl.length === 0) {
      throw new GitTransportError('repoUrl 必须是非空字符串');
    }
    if (typeof options.workDir !== 'string' || options.workDir.length === 0) {
      throw new GitTransportError('workDir 必须是非空字符串');
    }
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getToken !== 'function') {
      throw new GitTransportError('credentials 必须提供 getToken()');
    }
    this.o = {
      repoUrl: options.repoUrl,
      workDir: options.workDir,
      credentials: options.credentials,
      gitBin: options.gitBin ?? 'git',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      exec: options.exec ?? defaultExec,
      author: options.author ?? DEFAULT_AUTHOR,
      credentialUsername: options.credentialUsername ?? DEFAULT_CREDENTIAL_USERNAME,
    };
  }

  /** 最近一次 checkIsPrivate() 的结果；null = 尚未检查 */
  get isPrivateHint(): boolean | null {
    return this.privateHint;
  }

  /** 列出远端已有快照（按 createdAt 升序）。读取工作副本 snapshots/ 目录（先 pull 同步远端）。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const snapsAbs = this.snapshotsDir();
    const names = await fsx.readdir(snapsAbs);
    const metas: SyncSnapshotMeta[] = [];
    for (const name of names) {
      if (name === '' || name === '.' || name === '..') continue;
      const dirAbs = joinFs(snapsAbs, name);
      if (!(await fsx.isDir(dirAbs))) continue;
      const m = await this.readDirManifest(dirAbs);
      if (m === null) continue; // 损坏/不完整 → 跳过（防御工作副本污染，不静默失败整体 list）
      metas.push({
        id: m.id,
        createdAt: m.createdAt,
        sections: m.sectionHashes,
        manifest: m.manifest,
      });
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return metas;
  }

  /** 上传快照：写散文件目录 → add → commit → push；同 id 覆盖；内容无变化时幂等（不产生 commit）。 */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const dir = this.snapshotDir(snapshot.id);
    const existed = await fsx.exists(dir);
    if (existed) await fsx.remove(dir); // 覆盖语义：先清旧目录，避免残留旧文件
    await writeSnapshotToDir(snapshot, dir, fsx);
    const rel = `${SNAPSHOTS_REL}/${snapshot.id}`;
    await this.runGit(['add', '--', rel]);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      const verb = existed ? 'update' : 'add';
      await this.runGit(['commit', '-m', `sync: ${verb} snapshot ${snapshot.id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
    return computeSnapshotMeta(snapshot);
  }

  /** 下载快照完整载荷（读回散文件目录）。不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const dir = this.snapshotDir(id);
    if (!(await createSnapshotFs().isDir(dir))) {
      throw new GitTransportError(`快照 ${id} 不存在（本地工作副本 ${dir}）`);
    }
    return readSnapshotFromDir(dir);
  }

  /** 删除远端快照（不存在视为成功，契约）。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const dir = this.snapshotDir(id);
    if (!(await fsx.exists(dir))) return; // 不存在视为成功
    await fsx.remove(dir);
    const rel = `${SNAPSHOTS_REL}/${id}`;
    await this.runGit(['add', '-A', '--', rel]);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      await this.runGit(['commit', '-m', `sync: delete snapshot ${id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
  }

  /**
   * 私有仓库可见性探测（结果缓存于 isPrivateHint）：
   * 匿名 ls-remote 成功 → 公开；匿名失败 + 凭据探测成功 → 私有；两者都失败 → 抛错。
   * UI 层可用 isPrivateHint 提示「私有仓库推荐」；公开仓库也可用（内容需自行评估）。
   */
  async checkIsPrivate(): Promise<boolean> {
    if (this.privateHint !== null) return this.privateHint;
    const anon = await this.runGit(['ls-remote', this.o.repoUrl], { allowNonZero: true, cwd: undefined });
    if (anon.code === 0) {
      this.privateHint = false;
      return false;
    }
    const authed = await this.runGit(['ls-remote', this.o.repoUrl], { allowNonZero: true, cwd: undefined, withCredential: true });
    if (authed.code === 0) {
      this.privateHint = true;
      return true;
    }
    throw new GitTransportError(`仓库不可达或认证失败: ${this.mask(this.o.repoUrl, null)}`);
  }

  /* ---------------- 内部实现 ---------------- */

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    const fsx = createSnapshotFs();
    await fsx.mkdir(this.o.workDir); // 不存在则创建
    if (await fsx.exists(path.join(this.o.workDir, '.git'))) {
      this.repoReady = true;
      return;
    }
    const entries = await fsx.readdir(this.o.workDir);
    if (entries.length > 0) {
      throw new GitTransportError(`workDir 不是 git 仓库（缺少 .git）且目录非空，无法 clone: ${this.o.workDir}`);
    }
    await this.runGit(['clone', this.o.repoUrl, '.'], { cwd: this.o.workDir, withCredential: true });
    // 仓库级提交身份（写入远端历史，可经 author 选项覆盖；不改全局配置）
    await this.runGit(['config', 'user.name', this.o.author.name]);
    await this.runGit(['config', 'user.email', this.o.author.email]);
    this.repoReady = true;
  }

  /** pull --ff-only 同步远端；无本地提交（全新仓库）或无 upstream 时静默跳过 */
  private async pullFromRemote(): Promise<void> {
    const head = await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowNonZero: true });
    if (head.code !== 0) return; // 无本地提交 → 无可 pull
    const res = await this.runGit(['pull', '--ff-only'], { withCredential: true, allowNonZero: true });
    if (res.code === 0) return;
    if (/no tracking information/i.test(res.stderr)) return; // 无 upstream（初始状态）→ 跳过
    throw new GitTransportError(`git pull 失败: ${this.mask(res.stderr, await this.readTokenOnce())}`);
  }

  /** 执行 git 命令；withCredential=true 时注入 credential helper（token 不进 argv），失败时错误消息脱敏 */
  private async runGit(
    args: string[],
    opts: { cwd?: string; withCredential?: boolean; allowNonZero?: boolean } = {},
  ): Promise<GitExecResult> {
    const cwd = opts.cwd === undefined ? this.o.workDir : opts.cwd;
    let extra: string[] = [];
    let token: string | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    if (opts.withCredential) {
      const cred = await this.buildCredentialArgs();
      extra = cred.extraArgs;
      token = cred.token;
      cleanup = cred.cleanup;
    }
    try {
      const result = await this.o.exec(this.o.gitBin, [...extra, ...args], { cwd, timeoutMs: this.o.timeoutMs });
      if (result.code !== 0 && !opts.allowNonZero) {
        throw new GitTransportError(
          this.mask(`git ${args.join(' ')} 失败 (exit ${result.code}): ${result.stderr}`, token),
        );
      }
      return result;
    } finally {
      if (cleanup) await cleanup();
    }
  }

  /**
   * 为网络命令构造 credential helper 参数：
   * 仅 http(s) 远端需要 token；本地路径 / ssh 走 git 原生认证（密钥），不调用 provider。
   * token 写入 os.tmpdir() 下临时 store 文件（权限 0600），命令后立即删除 —— 永不落工作副本/远端。
   */
  private async buildCredentialArgs(): Promise<{ extraArgs: string[]; token: string; cleanup: () => Promise<void> }> {
    if (!/^https?:\/\//i.test(this.o.repoUrl)) {
      return { extraArgs: [], token: '', cleanup: async () => {} };
    }
    const token = await this.o.credentials.getToken();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-cred-'));
    const credFile = path.join(tmpDir, 'credential');
    const host = this.repoHost();
    const fileArg = quoteGitValue(credFile.replace(/\\/g, '/'));
    await fs.writeFile(credFile, `https://${this.o.credentialUsername}:${token}@${host}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
      extraArgs: ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${fileArg}`],
      token,
      cleanup: async () => { await fs.rm(tmpDir, { recursive: true, force: true }); },
    };
  }

  /** 从 repoUrl 提取 credential 匹配用的 host[:port] */
  private repoHost(): string {
    try {
      const u = new URL(this.o.repoUrl);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      throw new GitTransportError(`无法解析 repoUrl（http(s) 仓库必须为合法 URL）: ${this.o.repoUrl}`);
    }
  }

  /** 读取一次 token（错误消息脱敏用）；非 http(s) 场景返回空 */
  private async readTokenOnce(): Promise<string | null> {
    if (!/^https?:\/\//i.test(this.o.repoUrl)) return null;
    try { return await this.o.credentials.getToken(); } catch { return null; }
  }

  /** 错误/日志脱敏：token（原文与 URL 编码两种形态）与 repoUrl 一律替换 */
  private mask(text: string, token: string | null): string {
    let out = text.split(this.o.repoUrl).join('[REPO_URL]');
    if (token && token.length >= 4) {
      out = out.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]');
    }
    return out;
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
      throw new GitTransportError(`非法快照 id: ${JSON.stringify(id)}（仅允许字母数字开头，字符限 . _ -）`);
    }
  }

  private snapshotDir(id: string): string {
    return joinFs(this.snapshotsDir(), id);
  }

  private snapshotsDir(): string {
    return joinFs(this.o.workDir, SNAPSHOTS_REL);
  }

  /** 读快照目录 manifest.json（结构不合法 → null，调用方跳过） */
  private async readDirManifest(dir: string): Promise<SnapshotDirManifest | null> {
    const fsx: SnapshotFs = createSnapshotFs();
    try {
      const abs = joinFs(dir, SNAPSHOT_MANIFEST_FILE);
      if (!(await fsx.exists(abs))) return null;
      const raw = Buffer.from(await fsx.readFile(abs)).toString('utf8');
      const parsed = parseJsonSafe(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const m = parsed as Record<string, unknown>;
      if (typeof m['id'] !== 'string' || typeof m['createdAt'] !== 'string'
        || m['manifest'] === null || typeof m['manifest'] !== 'object'
        || m['sectionHashes'] === null || typeof m['sectionHashes'] !== 'object') {
        return null;
      }
      return parsed as SnapshotDirManifest;
    } catch {
      return null;
    }
  }
}
