/**
 * m-git-channel：Git 私有仓库通道（SyncTransport 的 git 实现）。
 *
 * 设计：
 * - 明文快照以「散文件目录」提交到 git 仓库：工作副本 <workDir>/snapshots/<id>/ 即 t2 layout 布局
 *   （manifest.json + 平铺 JSON 分区 + 文件类分区目录），每次 sync 一次 commit + push；
 * - 加密快照（EncryptedSections 密文载荷，无法平铺为明文 JSON 分区）走「密文单文件」布局：
 *   整个快照 JSON 提交到 <workDir>/snapshots-encrypted/<id>.json（远端已存密文；
 *   本地工作副本即远端镜像，不产生额外明文审计副本）。
 * - 命令执行走 node:child_process execFile（promise 封装，数组参数无 shell 注入），
 *   始终使用系统 PATH 中的 git（固定命令 'git'），可注入 exec 便于测试。
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
import { readSnapshotFromDir, SNAPSHOT_BLOB_REFS_SUFFIX, SNAPSHOT_KEEP_CONTENT, SNAPSHOT_KEEP_FILE, SNAPSHOT_MANIFEST_FILE, writeSnapshotToDir } from '../layout.ts';
import type { SnapshotDirManifest } from '../layout.ts';
import { BLOB_SECTIONS, gcBlobs, referencedBlobHashes } from '../blob-store.ts';
import type { BlobSink } from '../blob-store.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import {
  classifyNetworkErrorText, computeSnapshotMeta, DEFAULT_SYNC_TIMEOUT_MS, isEncryptedSections,
  SyncTransportError, withSyncRetry,
} from '../transport.ts';
import type {
  SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
} from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';
import { atomicWriteFile } from '../../utils/atomic-write.ts';
import { SECTION_FILE_PREFIXES } from '../../schema/config.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';
import { zhMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/messages.ts';

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
  /** 单条 git 命令超时 ms；缺省 = 两条通道共用的 DEFAULT_SYNC_TIMEOUT_MS（120000，只放宽不收紧） */
  timeoutMs?: number;
  /** 幂等读操作（list/download 的 clone/pull）的网络重试参数；缺省 attempts=3、250ms 起指数退避 */
  retry?: SyncRetryOptions;
  /** 注入 exec（测试 mock 用）；缺省 = execFile 封装 */
  exec?: GitExecFn;
  /** 提交作者（写入远端历史），默认 DSH Config Sync <sync@dsh.local> */
  author?: GitAuthor;
  /** credential 用户名（GitHub PAT 用 oauth2），默认 'oauth2' */
  credentialUsername?: string;
  /** 消息翻译器（缺省 zh） */
  msg?: MsgFunc;
}

/**
 * git 通道错误：继承统一错误基类（kind / retryable / status 分类对上层可见）。
 * 分类口径见 transport.ts 的 classifyNetworkErrorText / classifyHttpStatus。
 */
export class GitTransportError extends SyncTransportError {
  constructor(message: string, opts: SyncTransportErrorOptions = {}) {
    super(message, opts);
    this.name = 'GitTransportError';
  }
}

const SNAPSHOTS_REL = 'snapshots';
/** 加密快照的「密文单文件」目录：整个快照 JSON（含密文载荷）以 <id>.json 提交。
 *  加密快照不写散文件目录（密文无法平铺为明文 JSON 分区；远端已存密文）。 */
const SNAPSHOTS_ENCRYPTED_REL = 'snapshots-encrypted';
/**
 * 内容寻址 blob 仓在仓库内的相对目录（P1-4）。
 *
 * 为什么即使是 git 通道也要显式共享目录：git 本身按 blob 去重**存储**，但每个快照 commit
 * 仍要重写工作树里的整份会话文件（数十 MB × N）。把字节放进跨快照共享的 blobs/ 后，
 * 内容没变 = 文件路径已存在 = 一个字都不写、也不进本次 diff。
 */
const BLOBS_REL = 'blobs';
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
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const detail = String(e.stderr ?? '') !== '' ? String(e.stderr) : (err instanceof Error ? err.message : String(err));
    // 超时（execFile 到点 kill）在 git 的 stderr 里常常是空的：补一句可判定的文字，
    // 让 transport.ts 的统一分类器把它识别成 timeout（瞬时、可重试），而不是 unknown。
    const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    const stderr = timedOut && !/timed out|timeout/i.test(detail)
      ? `git command timed out after ${String(opts.timeoutMs ?? 0)}ms: ${detail}`
      : detail;
    return {
      stdout: String(e.stdout ?? ''),
      stderr,
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
    retry: SyncRetryOptions;
    author: GitAuthor;
    credentialUsername: string;
    exec: GitExecFn;
  };
  private repoReady = false;
  private privateHint: boolean | null = null;
  private readonly msg: MsgFunc;

  constructor(options: GitTransportOptions) {
    if (typeof options.repoUrl !== 'string' || options.repoUrl.length === 0) {
      throw new GitTransportError(zhMsg('sync.git.repoUrlRequired'));
    }
    if (typeof options.workDir !== 'string' || options.workDir.length === 0) {
      throw new GitTransportError(zhMsg('sync.git.workDirRequired'));
    }
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getToken !== 'function') {
      throw new GitTransportError(zhMsg('sync.git.credentialsRequired'));
    }
    this.msg = options.msg ?? zhMsg;
    this.o = {
      repoUrl: options.repoUrl,
      workDir: options.workDir,
      credentials: options.credentials,
      gitBin: 'git',
      timeoutMs: options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
      retry: options.retry ?? {},
      exec: options.exec ?? defaultExec,
      author: options.author ?? DEFAULT_AUTHOR,
      credentialUsername: options.credentialUsername ?? DEFAULT_CREDENTIAL_USERNAME,
    };
  }

  /** 最近一次 checkIsPrivate() 的结果；null = 尚未检查 */
  get isPrivateHint(): boolean | null {
    return this.privateHint;
  }

  /** 列出远端已有快照（按 createdAt 升序）。读取工作副本 snapshots/（明文散文件）
   *  与 snapshots-encrypted/（密文单文件）两个目录（先 pull 同步远端）。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    await this.ensureRepo();
    // 幂等读：网络故障（连接重置/超时/DNS）允许一次有限重试；工作副本无写副作用
    await this.pullFromRemote({ retryable: true });
    const fsx = createSnapshotFs();
    const metas: SyncSnapshotMeta[] = [];
    // 明文散文件目录
    const snapsAbs = this.snapshotsDir();
    const names = await fsx.readdir(snapsAbs);
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
    // 密文单文件目录（snapshots-encrypted/<id>.json）：整体 JSON 快照
    const encAbs = this.encryptedSnapshotsDir();
    const encNames = await fsx.readdir(encAbs);
    for (const name of encNames) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) continue;
      const snap = await this.readEncryptedSnapshotFile(joinFs(encAbs, name));
      if (snap === null) continue; // 损坏/解析失败 → 跳过
      metas.push({ id: snap.id, createdAt: snap.createdAt, sections: {}, manifest: snap.manifest });
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return metas;
  }

  /**
   * 上传快照：写散文件目录（明文）或密文单文件（加密）→ add → commit → push；
   * 同 id 覆盖；内容无变化时幂等（不产生 commit）。
   * 双形态互斥：同 id 从一种形态切到另一种时先清掉旧形态残留，保证工作副本/远端布局自洽。
   */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const encrypted = isEncryptedSections(snapshot.sections);
    // 覆盖判定：任一种旧形态（散文件目录 / 密文单文件）已存在 → update
    const existed = await fsx.exists(this.snapshotDir(snapshot.id))
      || await fsx.exists(this.encryptedSnapshotFile(snapshot.id));
    let rel: string;
    if (encrypted) {
      // 密文单文件：整个快照 JSON（sections 为 EncryptedSections，纯字符串 JSON 安全）
      const file = this.encryptedSnapshotFile(snapshot.id);
      await fsx.remove(file); // 覆盖语义：先删旧文件
      await fsx.mkdir(this.encryptedSnapshotsDir());
      await fsx.writeFile(file, new TextEncoder().encode(serializeSnapshot(snapshot)));
      // 同 id 旧散文件目录残留 → 一并清理（形态切换不残留）
      await fsx.remove(this.snapshotDir(snapshot.id));
      rel = `${SNAPSHOTS_ENCRYPTED_REL}/${snapshot.id}.json`;
    } else {
      const dir = this.snapshotDir(snapshot.id);
      if (await fsx.exists(dir)) await fsx.remove(dir); // 覆盖语义：先清旧目录，避免残留旧文件
      // P1-4：会话等大分区改为内容寻址外置（写进共享 blobs/，快照只留引用）
      await writeSnapshotToDir(snapshot, dir, fsx, { blobs: this.blobSink(fsx), sections: BLOB_SECTIONS });
      // git 不跟踪空目录：为空文件类分区目录写占位文件，保证远端保留目录。
      // 占位文件不参与 manifest.sectionHashes（基于传入数据计算）；读回时按名+内容过滤。
      // 否则空分区（如未安装 skills）上传后目录在远端丢失，B 机全新 clone 下载即失败。
      const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
      const blobSections = new Set<string>(BLOB_SECTIONS);
      for (const [sid, prefix] of Object.entries(SECTION_FILE_PREFIXES)) {
        // 外置分区不写 <prefix>/ 目录（引用文件已在 writeSnapshotToDir 里写好），无需占位文件
        if (blobSections.has(sid)) continue;
        const data = plain[sid as SectionId] as FilesSection | undefined;
        if (data === undefined || data.files.length > 0) continue;
        // joinFs 只接受两个参数，占位路径拼进 prefix 一起传
        await fsx.writeFile(joinFs(dir, `${prefix}${SNAPSHOT_KEEP_FILE}`), new TextEncoder().encode(SNAPSHOT_KEEP_CONTENT));
      }
      // 同 id 旧密文单文件残留 → 一并清理（形态切换不残留）
      await fsx.remove(this.encryptedSnapshotFile(snapshot.id));
      rel = `${SNAPSHOTS_REL}/${snapshot.id}`;
    }
    // blob 仓与快照同一次提交：引用文件与它引用的字节绝不跨 commit 分离
    const hasBlobs = await fsx.exists(this.blobsDir());
    await this.runGit(hasBlobs ? ['add', '--', rel, BLOBS_REL] : ['add', '--', rel]);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      const verb = existed ? 'update' : 'add';
      await this.runGit(['commit', '-m', `sync: ${verb} snapshot ${snapshot.id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
    return computeSnapshotMeta(snapshot);
  }

  /** 下载快照完整载荷。明文 → 读回散文件目录；加密 → 读回密文单文件。不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    await this.ensureRepo();
    // 幂等读：网络故障允许一次有限重试（只读远端/工作副本，无写副作用）
    await this.pullFromRemote({ retryable: true });
    const fsx = createSnapshotFs();
    // 优先散文件目录（明文布局）；其次密文单文件（加密布局）
    // missingFileDir='empty'：git 不跟踪空目录 → 目录缺失 = 空文件分区（非损坏；
    // 提交原子性保证非空目录不会缺失），兼容旧版插件上传的无占位快照
    if (await fsx.isDir(this.snapshotDir(id))) {
      return readSnapshotFromDir(this.snapshotDir(id), fsx, {
        missingFileDir: 'empty',
        // P1-4：外置分区从 blobs/ 取回字节（缺 blob → 硬失败，绝不降级成空分区）
        blobs: this.blobSink(fsx),
      });
    }
    const encFile = this.encryptedSnapshotFile(id);
    if (await fsx.exists(encFile)) {
      const raw = Buffer.from(await fsx.readFile(encFile)).toString('utf8');
      try {
        return deserializeSnapshot(raw);
      } catch (err) {
        throw new GitTransportError(this.msg('sync.git.snapshotCorrupt', {
          id, dir: encFile, err: this.mask(String((err as Error)?.message ?? ''), null),
        }));
      }
    }
    throw new GitTransportError(this.msg('sync.git.snapshotMissing', { id, dir: this.snapshotDir(id) }));
  }

  /** 删除远端快照（明文散文件目录或密文单文件；不存在视为成功，契约）。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const plainDir = this.snapshotDir(id);
    const encFile = this.encryptedSnapshotFile(id);
    const plainExists = await fsx.exists(plainDir);
    const encExists = await fsx.exists(encFile);
    if (!plainExists && !encExists) return; // 不存在视为成功
    let rel: string;
    if (plainExists) {
      await fsx.remove(plainDir);
      rel = `${SNAPSHOTS_REL}/${id}`;
    } else {
      await fsx.remove(encFile);
      rel = `${SNAPSHOTS_ENCRYPTED_REL}/${id}.json`;
    }
    await this.runGit(['add', '-A', '--', rel]);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      await this.runGit(['commit', '-m', `sync: delete snapshot ${id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
    // P1-4：快照被裁掉后回收无人引用的 blob（best-effort，失败不影响删除结果）
    await this.gcBlobStore(fsx).catch(() => undefined);
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
    throw new GitTransportError(this.msg('sync.git.repoUnreachable', { url: this.mask(this.o.repoUrl, null) }));
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
    const gitDir = path.join(this.o.workDir, '.git');
    const entries = await fsx.readdir(this.o.workDir);
    if (entries.length > 0) {
      throw new GitTransportError(
        this.msg('sync.git.workDirNotRepo', { dir: this.o.workDir }),
        { kind: 'protocol', retryable: false },
      );
    }
    // 首次 clone 也是网络操作，且失败时工作副本仍为空（幂等）→ 允许有限指数退避重试；
    // 每次尝试前重查 .git：上一次尝试其实建出了仓库就视为成功，避免「目录非空」误判。
    await withSyncRetry(async () => {
      if (await fsx.exists(gitDir)) return;
      await this.runGit(['clone', this.o.repoUrl, '.'], { cwd: this.o.workDir, withCredential: true });
    }, this.o.retry);
    // 仓库级提交身份（写入远端历史，可经 author 选项覆盖；不改全局配置）
    await this.runGit(['config', 'user.name', this.o.author.name]);
    await this.runGit(['config', 'user.email', this.o.author.email]);
    this.repoReady = true;
  }

  /**
   * pull --ff-only 同步远端；无本地提交（全新仓库）或无 upstream 时静默跳过。
   * opts.retryable=true（仅 list / download 等**幂等读**路径传）：瞬时网络故障走有限指数退避重试。
   * 写路径（upload / delete）不传 → 一次即止（push 有远端副作用，重试可能造成重复写入）。
   */
  private async pullFromRemote(opts: { retryable?: boolean } = {}): Promise<void> {
    const head = await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowNonZero: true });
    if (head.code !== 0) return; // 无本地提交 → 无可 pull
    const attempt = async (): Promise<void> => {
      const res = await this.runGit(['pull', '--ff-only'], { withCredential: true, allowNonZero: true });
      if (res.code === 0) return;
      if (/no tracking information/i.test(res.stderr)) return; // 无 upstream（初始状态）→ 跳过
      throw new GitTransportError(
        this.msg('sync.git.pullFailed', { err: this.mask(res.stderr, await this.readTokenOnce()) }),
        classifyNetworkErrorText(res.stderr),
      );
    };
    if (opts.retryable === true) await withSyncRetry(attempt, this.o.retry);
    else await attempt();
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
        // 统一分类（超时 / 网络 / 鉴权 / 5xx…）：上层可据 kind / retryable 分流，不必解析 message
        throw new GitTransportError(
          this.msg('sync.git.cmdFailed', { args: args.join(' '), code: String(result.code), err: this.mask(result.stderr, token) }),
          classifyNetworkErrorText(result.stderr + ' ' + result.stdout),
        );
      }
      return result;
    } catch (err) {
      if (err instanceof GitTransportError) throw err;
      // 注入的 exec 实现可能直接抛错（默认实现只返回非零 code）——同样归一为带分类的传输层错误
      const detail = err instanceof Error ? err.message : String(err);
      throw new GitTransportError(
        this.msg('sync.git.cmdFailed', { args: args.join(' '), code: 'exec', err: this.mask(detail, token) }),
        { ...classifyNetworkErrorText(detail), cause: err },
      );
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
    await atomicWriteFile(credFile, `https://${this.o.credentialUsername}:${token}@${host}\n`, { mode: 0o600, symlink: 'reject' });
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
      throw new GitTransportError(this.msg('sync.git.repoUrlInvalid', { url: this.o.repoUrl }));
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

  private blobsDir(): string {
    return path.join(this.o.workDir, BLOBS_REL);
  }

  /**
   * git 通道的 blob 仓实现：工作树内 `blobs/<sha256>`（跨快照共享、按内容寻址）。
   * put 幂等（已存在即跳过）—— 这正是「未变会话不再重传/重写」的落点。
   */
  private blobSink(fsx: SnapshotFs): BlobSink {
    const base = this.blobsDir();
    return {
      put: async (hash, bytes) => {
        const abs = joinFs(base, hash);
        if (await fsx.exists(abs)) return;
        await fsx.mkdir(base);
        await fsx.writeFile(abs, bytes);
      },
      get: async (hash) => {
        const abs = joinFs(base, hash);
        if (!(await fsx.exists(abs))) return null;
        return fsx.readFile(abs);
      },
      delete: async (hash) => {
        await fsx.remove(joinFs(base, hash));
      },
      list: async () => {
        const names = await fsx.readdir(base);
        const out: { hash: string; mtimeMs: number }[] = [];
        for (const name of names) {
          if (name === '' || name === '.' || name === '..') continue;
          const abs = joinFs(base, name);
          if (await fsx.isDir(abs)) continue;
          try {
            out.push({ hash: name, mtimeMs: (await fs.stat(abs)).mtimeMs });
          } catch {
            /* 列不到时间 → 视为「刚写入」（保守不删） */
            out.push({ hash: name, mtimeMs: Date.now() });
          }
        }
        return out;
      },
    };
  }

  /**
   * blob 仓 GC（P1-4）：扫描**仍存在**的快照目录里的 <section>.blobs.json，删除无人引用且
   * 超过保护窗口的 blob。任何引用文件读不出来 → **本轮直接放弃**（宁可留垃圾，不可删在用的）。
   * best-effort：失败不影响调用方（删除快照本身已成功）。
   */
  private async gcBlobStore(fsx: SnapshotFs): Promise<void> {
    if (!(await fsx.exists(this.blobsDir()))) return;
    const referenced = new Set<string>();
    let readable = true;
    for (const name of await fsx.readdir(this.snapshotsDir())) {
      const dir = joinFs(this.snapshotsDir(), name);
      if (!(await fsx.isDir(dir))) continue;
      for (const file of await fsx.readdir(dir)) {
        if (!file.endsWith(SNAPSHOT_BLOB_REFS_SUFFIX)) continue;
        try {
          const parsed = parseJsonSafe(Buffer.from(await fsx.readFile(joinFs(dir, file))).toString('utf8'));
          for (const hash of referencedBlobHashes(parsed)) referenced.add(hash);
        } catch {
          readable = false;
        }
      }
    }
    if (!readable) return;
    const deleted = await gcBlobs({ sink: this.blobSink(fsx), referenced, nowMs: Date.now() });
    if (deleted.length === 0) return;
    await this.runGit(['add', '-A', '--', BLOBS_REL]);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code === 0) return;
    await this.runGit(['commit', '-m', `sync: gc ${deleted.length} blob(s)`]);
    await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
      throw new GitTransportError(this.msg('sync.git.invalidSnapshotId', { id: JSON.stringify(id) }));
    }
  }

  private snapshotDir(id: string): string {
    return joinFs(this.snapshotsDir(), id);
  }

  private snapshotsDir(): string {
    return joinFs(this.o.workDir, SNAPSHOTS_REL);
  }

  /** 加密快照密文单文件目录（<workDir>/snapshots-encrypted/） */
  private encryptedSnapshotsDir(): string {
    return joinFs(this.o.workDir, SNAPSHOTS_ENCRYPTED_REL);
  }

  /** 加密快照密文单文件路径（<id>.json） */
  private encryptedSnapshotFile(id: string): string {
    return joinFs(this.encryptedSnapshotsDir(), `${id}.json`);
  }

  /** 读密文单文件快照（解析失败 → null，调用方跳过，不静默失败整体 list）。 */
  private async readEncryptedSnapshotFile(file: string): Promise<SyncSnapshot | null> {
    try {
      const raw = Buffer.from(await createSnapshotFs().readFile(file)).toString('utf8');
      return deserializeSnapshot(raw);
    } catch {
      return null;
    }
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
