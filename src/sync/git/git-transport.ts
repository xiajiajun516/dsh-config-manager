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
  SyncProbeResult, SyncRetryOptions, SyncSnapshot, SyncSnapshotMeta, SyncTransport, SyncTransportErrorOptions,
} from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';
import { atomicWriteFile } from '../../utils/atomic-write.ts';
import { quoteGitValue } from '../../utils/git-quote.ts';
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

/** 工作副本自检事实（issue #79）：origin 是否已跟随配置地址、有无未上行的本地提交。 */
export interface GitWorkDirFacts {
  /** 工作副本路径（本地路径，可回显） */
  path: string;
  /** `.git` 是否存在（false = 尚未 clone，或该目录不是 git 仓库） */
  exists: boolean;
  /** 当前 origin（读不出 → null） */
  origin: string | null;
  /** 单独配置的 push URL（未单独配置 → null） */
  pushUrl: string | null;
  /** fetch / push 地址是否都已跟随 repoUrl（读不出 origin → false） */
  match: boolean;
  /** 领先全部远端跟踪引用的本地提交数（读不出 → null） */
  ahead: number | null;
  /** 工作树是否有未提交改动（读不出 → null） */
  dirty: boolean | null;
  /**
   * 远端跟踪分支上的快照数（issue #104 建议 3）：`snapshots/` 与 `snapshots-encrypted/`
   * 下的直接子项数（目录，或加密通道的 <id>.json 文件）。它和 `ahead` 一起回答
   * 「本地领先 N 个提交、可远端从来没收到过快照吗」—— 那正是 issue #104 里
   * 远端两周一个字节都没收到、用户却以为在正常备份的现场。
   * 只有 detail 自检时给出；无远端跟踪分支 / 读不出 → null。
   */
  remoteSnapshots: number | null;
}

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
/**
 * 同步仓库（git 通道）顶层**只可能出现**这三个条目。issue #104 的 `adopt` 模式拿它当安全判据：
 * 远端分支的顶层出现别的名字 = 这不是本插件的同步仓库，合并它等于把别人的仓库内容搬进工作副本。
 */
const ADOPT_ROOT_ALLOW = new Set<string>([SNAPSHOTS_REL, SNAPSHOTS_ENCRYPTED_REL, BLOBS_REL]);
const DEFAULT_AUTHOR: GitAuthor = { name: 'DSH Config Sync', email: 'sync@dsh.local' };
const DEFAULT_CREDENTIAL_USERNAME = 'oauth2';
/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防路径穿越与 commit message 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * SSH 主机密钥校验失败（issue #79）：git 只回一句 `Host key verification failed`，
 * 用户拿不到任何可操作信息（要不要信任？怎么写 known_hosts？）。识别后换成可操作文案。
 */
const SSH_HOST_KEY_RE = /host key verification failed|remote host identification has changed|no matching host key/i;
/**
 * 工作副本与远端不是同一条历史（issue #79）：改成一个「另一个仓库」的地址后，
 * `pull --ff-only` 会以 refusing to merge unrelated histories / Not possible to fast-forward 失败。
 * 这类失败与网络无关，必须给「改回地址或重建工作副本」的出口，而不是只丢一句原始 stderr。
 */
const DIVERGED_HISTORY_RE = /refusing to merge unrelated histories|unrelated histories|not possible to fast-forward/i;

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
  /**
   * 最近一次 list() 里**读不出/解析失败**的密文快照文件与原因（issue #59）。
   *
   * 为什么不能只 console 或只吞掉：这份「跳过」正是用户看到的「推送成功但远端列表为空」
   * 的唯一线索。列表接口把它如实回传，让状态自洽（绝不静默失败）。
   */
  private readErrors: { file: string; reason: string }[] = [];
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

  /** 最近一次列表里读不出来的远端快照（含原因）；供上层如实呈现，绝不静默 */
  get unreadableSnapshots(): readonly { file: string; reason: string }[] {
    return this.readErrors;
  }

  /** 列出远端已有快照（按 createdAt 升序）。读取工作副本 snapshots/（明文散文件）
   *  与 snapshots-encrypted/（密文单文件）两个目录（先 pull 同步远端）。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    await this.ensureRepo();
    // 幂等读：网络故障（连接重置/超时/DNS）允许一次有限重试；工作副本无写副作用
    await this.pullFromRemote({ retryable: true });
    const fsx = createSnapshotFs();
    this.readErrors = [];
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
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true, requirePushToken: true });
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
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true, requirePushToken: true });
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

  /**
   * 连通性探针（cloud-sync 借鉴项 ②）：只读自检「远端可达 + 凭据可用」。
   *
   * 为什么复用 ls-remote：它不需要工作副本、不写任何本地状态，而且正是 clone/fetch 之前的那一步 ——
   * 远端不可达 / 令牌失效 / SSH 主机密钥不信任都会在这里显式失败（checkIsPrivate 抛可操作文案），
   * 因此结论与随后真正同步时的成败**同源**。
   * 刻意**不**统计远端快照数：那要先 fetch 工作副本（对本地有写入），超出「只读自检」的范围 ——
   * 宁可不报，也不报一个会误导的 0。
   */
  async probe(): Promise<SyncProbeResult> {
    await this.checkIsPrivate();
    return { message: this.msg('sync.git.probeOk') };
  }

  /* ---------------- 内部实现 ---------------- */

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    const fsx = createSnapshotFs();
    await fsx.mkdir(this.o.workDir); // 不存在则创建
    if (await fsx.exists(path.join(this.o.workDir, '.git'))) {
      // issue #79：已有工作副本时**也必须**让 origin 跟随 repoUrl。
      // 此前这里直接 `repoReady = true; return`，repoUrl 只在首次 clone 时被使用 ——
      // 于是「改仓库地址」对已存在的工作副本完全无效：pull/push 全走旧 origin，
      // 而失败面表现为旧地址的网络超时（真机：局域网地址 → Tailscale 地址后同步长期失败），
      // 用户会误判成网络/凭据问题。
      await this.reconcileOrigin();
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
   * 让工作副本的 origin 与配置的 repoUrl 保持一致（issue #79）。
   *
   * 幂等：地址已一致时**一条写命令都不发**（只读 get-url）。三条边界：
   *  - 读不出 origin（无该 remote）→ `remote add origin`，否则 `push -u origin` 永远失败；
   *  - 读得出但为空串 → 视为「读不到」，**不改写**（不拿不确定的读取结果去覆盖用户的仓库配置）；
   *  - push URL 可被单独配置（`git remote set-url --push`）→ 不一致时一并跟随，否则推送仍走旧地址。
   */
  private async reconcileOrigin(): Promise<void> {
    const current = await this.runGit(['remote', 'get-url', 'origin'], { allowNonZero: true });
    const origin = current.code === 0 ? current.stdout.trim() : '';
    if (current.code !== 0) {
      await this.runGit(['remote', 'add', 'origin', this.o.repoUrl]);
    } else if (origin !== '' && origin !== this.o.repoUrl) {
      await this.runGit(['remote', 'set-url', 'origin', this.o.repoUrl]);
    }
    const push = await this.runGit(['remote', 'get-url', '--push', 'origin'], { allowNonZero: true });
    const pushUrl = push.code === 0 ? push.stdout.trim() : '';
    if (pushUrl !== '' && pushUrl !== this.o.repoUrl) {
      await this.runGit(['remote', 'set-url', '--push', 'origin', this.o.repoUrl]);
    }
  }

  /**
   * ssh 远端的主机提示（issue #79 主机密钥错误文案用）；非 ssh 或解析不出 → 空串。
   * 只回传 host[:port]（不含用户名与仓库路径），地址由调用方经 mask() 处理。
   */
  private sshHostHint(): string {
    const url = this.o.repoUrl;
    if (/^ssh:\/\//i.test(url)) {
      try {
        const u = new URL(url);
        return u.port === '' ? u.hostname : `${u.hostname}:${u.port}`;
      } catch {
        return '';
      }
    }
    // scp 形态：git@host:path（可带端口需用 ssh:// 形态，这里只取主机）
    const scp = /^[^@/]+@([^:/]+)(?::(\d+))?:/.exec(url);
    if (scp === null) return '';
    const host = scp[1] ?? '';
    const port = scp[2];
    return port === undefined ? host : `${host}:${port}`;
  }

  /**
   * 工作副本自检（issue #79，只读）：origin / push URL 是否已跟随 repoUrl。
   *
   * **默认只做 2 条本地只读命令**（get-url ×2，毫秒级）——它挂在 `GET /sync/status` 上，
   * 每次打开面板都会跑；`rev-list`/`status` 在大工作副本（会话 blob 上千文件）上会明显变慢，
   * 因此放进 `detail: true`（供「重建工作副本」前评估数据量等场景显式索取）。
   */
  async inspectWorkDir(opts: { detail?: boolean } = {}): Promise<GitWorkDirFacts> {
    const fsx = createSnapshotFs();
    if (!(await fsx.exists(path.join(this.o.workDir, '.git')))) {
      return { path: this.o.workDir, exists: false, origin: null, pushUrl: null, match: false, ahead: null, dirty: null, remoteSnapshots: null };
    }
    const originRes = await this.runGit(['remote', 'get-url', 'origin'], { allowNonZero: true });
    const origin = originRes.code === 0 ? originRes.stdout.trim() : '';
    const pushRes = await this.runGit(['remote', 'get-url', '--push', 'origin'], { allowNonZero: true });
    const pushRaw = pushRes.code === 0 ? pushRes.stdout.trim() : '';
    let ahead: number | null = null;
    let dirty: boolean | null = null;
    let remoteSnapshots: number | null = null;
    if (opts.detail === true) {
      // 未上行的本地提交：HEAD 可达、但任何远端跟踪引用都不可达的提交数（无 upstream 也能算）
      const aheadRes = await this.runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { allowNonZero: true });
      const parsed = aheadRes.code === 0 ? Number.parseInt(aheadRes.stdout.trim(), 10) : Number.NaN;
      ahead = Number.isFinite(parsed) ? parsed : null;
      const statusRes = await this.runGit(['status', '--porcelain'], { allowNonZero: true });
      dirty = statusRes.code === 0 ? statusRes.stdout.trim() !== '' : null;
      // issue #104 建议 3：远端分支上到底有几个快照。只读 refs/remotes/origin/<branch>
      // （上次 fetch / push 的结果），不发网络请求 —— 两条本地只读命令。
      // 注意不能写 `ls-tree origin/<branch> -- snapshots`：带 pathspec 时它只回显目录条目
      // 本身（`snapshots`），数出来永远是 1。必须用 `<ref>:<dir>` 取该树的直接子项。
      const branchRes = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { allowNonZero: true });
      const branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';
      if (branch !== '' && branch !== 'HEAD') {
        const countTree = async (treeish: string): Promise<number | null> => {
          const treeRes = await this.runGit(['ls-tree', '--name-only', treeish], { allowNonZero: true });
          if (treeRes.code !== 0) return null;
          return treeRes.stdout
            .split('\n')
            .map((line) => line.trim())
            // 每个快照是一级子项；`.gitkeep` 只是占位，不是快照
            .filter((line) => line !== '' && !line.endsWith(SNAPSHOT_KEEP_FILE)).length;
        };
        const plain = await countTree(`origin/${branch}:${SNAPSHOTS_REL}`);
        const encrypted = await countTree(`origin/${branch}:${SNAPSHOTS_ENCRYPTED_REL}`);
        // 两个目录都不存在 = 远端分支根本没有快照布局（0）；分支/引用读不出 = null（不猜）
        remoteSnapshots = plain === null && encrypted === null ? 0 : (plain ?? 0) + (encrypted ?? 0);
      }
    }
    return {
      path: this.o.workDir,
      exists: true,
      origin: origin === '' ? null : origin,
      pushUrl: pushRaw === '' ? null : pushRaw,
      // 读不出 origin（null）→ 不算 match（状态接口据此提示「工作副本地址未知」）
      match: origin === this.o.repoUrl && (pushRaw === '' || pushRaw === this.o.repoUrl),
      ahead,
      dirty,
      remoteSnapshots,
    };
  }

  /**
   * 重建工作副本（issue #79 / #104 的自救入口）：
   *  - `relink`：只把 origin / push URL 重新指向 repoUrl（**非破坏性**：不碰工作树与本地提交）；
   *  - `adopt`：把远端分支**合并进**现有工作副本（issue #104：换成另一个仓库、或远端历史被重写后，
   *    两条历史不相交，`pull --ff-only` 永远失败；这里合并后本地提交一条都不丢，可 revert）；
   *  - `reclone`：删除工作副本目录后重新 clone（**丢弃未上行的本地提交**；调用方必须先让用户确认）。
   *
   * 安全边界：`reclone` 只在目录**确实是 git 工作副本**（有 .git）时才删；目录非空且无 .git
   * 一律拒绝（与 ensureRepo 同一句 workDirNotRepo）—— 绝不删来路不明的目录。
   */
  async rebuildWorkDir(mode: 'relink' | 'adopt' | 'reclone'): Promise<void> {
    this.repoReady = false;
    if (mode === 'relink') {
      await this.ensureRepo(); // .git 存在 → reconcileOrigin
      return;
    }
    const fsx = createSnapshotFs();
    await fsx.mkdir(this.o.workDir);
    if (!(await fsx.exists(path.join(this.o.workDir, '.git')))) {
      const entries = await fsx.readdir(this.o.workDir);
      if (entries.length > 0) {
        throw new GitTransportError(
          this.msg('sync.git.workDirNotRepo', { dir: this.o.workDir }),
          { kind: 'protocol', retryable: false },
        );
      }
      await this.ensureRepo(); // 空目录 → 直接 clone
      return;
    }
    if (mode === 'adopt') {
      // 已有工作副本但历史与远端不相交：合并远端历史，不删任何本地提交
      await this.adoptRemoteHistory();
      return;
    }
    await fs.rm(this.o.workDir, { recursive: true, force: true });
    await this.ensureRepo();
  }

  /**
   * 采纳远端历史（issue #104）：把远端分支合并进现有工作副本，解开「换了仓库 / 远端历史被重写」
   * 之后 `pull --ff-only` 的死结（真机形态：`+ 8e87c0c...dc69fc7 main (forced update)` 后
   * `fatal: Not possible to fast-forward, aborting.`）。
   *
   * 为什么 merge 而不是 issue 里建议的 `rebase --root --onto`：
   *  - rebase 会**改写本地提交**（sha 全变），出问题时无法 revert，中途失败还留下 detached HEAD
   *    与 .git/rebase-merge 目录，状态比失败前更难收拾；
   *  - merge 只多一个 merge commit，`git revert -m 1` 可原路退回，冲突时 `merge --abort`
   *    能干净回到起点（真机裸仓验证：冲突 abort 后无 MERGE_HEAD、工作树零改动）。
   *
   * 三条安全边界（宁可不做，也不把别人的仓库合进来）：
   *  ① 工作树必须干净 —— 有未提交改动时合并会把用户改动卡在冲突里；
   *  ② 远端分支顶层只允许快照布局（snapshots / snapshots-encrypted / blobs）—— 否则这是个
   *     「另有用途的仓库」，合并等于把它整个搬进工作副本；
   *  ③ 远端必须存在同名分支 —— 远端是空仓库（没有任何分支）时视为没什么可采纳，正常返回
   *     （后续 push 会自己建分支）；有分支但名字对不上则拒绝猜，把远端分支名列出来。
   */
  private async adoptRemoteHistory(): Promise<void> {
    // ① 未提交改动：不替用户丢改动
    const statusRes = await this.runGit(['status', '--porcelain'], { allowNonZero: true });
    if (statusRes.code !== 0) {
      throw new GitTransportError(
        this.msg('sync.git.cmdFailed', {
          args: 'status --porcelain',
          code: String(statusRes.code),
          err: this.mask(statusRes.stderr, await this.readTokenOnce()),
        }),
        { kind: 'unknown', retryable: true },
      );
    }
    if (statusRes.stdout.trim() !== '') {
      throw new GitTransportError(
        this.msg('sync.git.adoptDirty', { dir: this.o.workDir }),
        { kind: 'protocol', retryable: false },
      );
    }
    await this.reconcileOrigin();
    const branchRes = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { allowNonZero: true });
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';
    if (branch === '' || branch === 'HEAD') {
      // detached HEAD：没有分支可挂比 upstream，合并也不会被 push 走 → 拒绝并说明
      throw new GitTransportError(
        this.msg('sync.git.adoptDetached', { dir: this.o.workDir }),
        { kind: 'protocol', retryable: false },
      );
    }
    // fetch 是网络操作（幂等读）→ 允许有限指数退避重试
    await withSyncRetry(async () => {
      await this.runGit(['fetch', 'origin'], { withCredential: true });
    }, this.o.retry);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const refRes = await this.runGit(['rev-parse', '--verify', '--quiet', remoteRef], { allowNonZero: true });
    if (refRes.code !== 0) {
      // 远端没有同名分支：用 ls-remote 区分「远端是空仓库」与「分支名不同」
      const headsRes = await this.runGit(['ls-remote', '--heads', 'origin'], { withCredential: true, allowNonZero: true });
      const heads = (headsRes.code === 0 ? headsRes.stdout : '')
        .split('\n')
        .map((line) => line.trim().split('\t')[1] ?? '')
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length));
      if (heads.length === 0) {
        this.repoReady = true; // 空仓库：没有可采纳的历史，后续 push 会建分支
        return;
      }
      throw new GitTransportError(
        this.msg('sync.git.adoptNoRemoteBranch', { branch, heads: heads.slice(0, 3).join(', ') }),
        { kind: 'protocol', retryable: false },
      );
    }
    // ② 远端顶层只能是快照布局
    const treeRes = await this.runGit(['ls-tree', '--name-only', `origin/${branch}`], { allowNonZero: true });
    if (treeRes.code !== 0) {
      throw new GitTransportError(
        this.msg('sync.git.cmdFailed', {
          args: `ls-tree --name-only origin/${branch}`,
          code: String(treeRes.code),
          err: this.mask(treeRes.stderr, await this.readTokenOnce()),
        }),
        { kind: 'unknown', retryable: true },
      );
    }
    const unknownEntries = treeRes.stdout
      .split('\n')
      .map((name) => name.trim().replace(/\/$/, ''))
      .filter((name) => name !== '' && !ADOPT_ROOT_ALLOW.has(name));
    if (unknownEntries.length > 0) {
      throw new GitTransportError(
        this.msg('sync.git.adoptNotSyncRepo', { entries: unknownEntries.slice(0, 3).join(', ') }),
        { kind: 'protocol', retryable: false },
      );
    }
    // ③ 合并（不改写任何本地提交）；冲突则 abort 回起点再报错
    const mergeRes = await this.runGit(['merge', '--allow-unrelated-histories', '--no-edit', `origin/${branch}`], { allowNonZero: true });
    if (mergeRes.code !== 0) {
      await this.runGit(['merge', '--abort'], { allowNonZero: true });
      throw new GitTransportError(
        this.msg('sync.git.adoptMergeConflict', { branch }),
        { kind: 'conflict', retryable: false },
      );
    }
    // 让后续 pull --ff-only 有 upstream 可用（忽略失败：分支可能已被删/重命名）
    await this.runGit(['branch', '--set-upstream-to', `origin/${branch}`, branch], { allowNonZero: true });
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
      const combined = res.stderr + ' ' + res.stdout;
      // issue #79：这两类失败与网络无关，必须给「改回地址 / 重建工作副本」的出口
      if (SSH_HOST_KEY_RE.test(combined)) {
        throw new GitTransportError(this.hostKeyMessage(), { kind: 'auth', retryable: false });
      }
      if (DIVERGED_HISTORY_RE.test(combined)) {
        throw new GitTransportError(this.msg('sync.git.historyDiverged', { dir: this.o.workDir }), { kind: 'conflict', retryable: false });
      }
      throw new GitTransportError(
        this.msg('sync.git.pullFailed', { err: this.mask(res.stderr, await this.readTokenOnce()) }),
        classifyNetworkErrorText(combined),
      );
    };
    if (opts.retryable === true) await withSyncRetry(attempt, this.o.retry);
    else await attempt();
  }

  /**
   * 执行 git 命令；withCredential=true 时注入 credential helper（token 不进 argv），失败时错误消息脱敏。
   *
   * opts.requirePushToken：这条命令是**推送**，http(s) 远端必须有令牌 —— 在发起 git 之前就给出可操作错误。
   * 为什么必须预检（真机）：公开仓库的 fetch 可以匿名完成（**拉取成功**），而 push 必须认证 —— 没配令牌时
   * 用户拿到的是 git 的 exit 128「Invalid username or token」，既分不清「没配令牌」还是「令牌失效」，
   * 还会在本地留下一个已提交却推不上去的快照。
   */
  private async runGit(
    args: string[],
    opts: { cwd?: string; withCredential?: boolean; allowNonZero?: boolean; requirePushToken?: boolean } = {},
  ): Promise<GitExecResult> {
    const cwd = opts.cwd === undefined ? this.o.workDir : opts.cwd;
    let extra: string[] = [];
    let token: string | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    if (opts.withCredential === true || opts.requirePushToken === true) {
      const cred = await this.buildCredentialArgs();
      extra = cred.extraArgs;
      token = cred.token;
      cleanup = cred.cleanup;
    }
    // 推送预检：http(s) 远端 + 空令牌 = 注定失败的 push（拉取仍可匿名进行）
    if (opts.requirePushToken === true && /^https?:\/\//i.test(this.o.repoUrl) && (token ?? '') === '') {
      if (cleanup) await cleanup();
      throw new GitTransportError(this.msg('sync.git.pushTokenRequired'), { kind: 'auth', retryable: false });
    }
    try {
      const result = await this.o.exec(this.o.gitBin, [...extra, ...args], { cwd, timeoutMs: this.o.timeoutMs });
      if (result.code !== 0 && !opts.allowNonZero) {
        const combined = result.stderr + ' ' + result.stdout;
        // 统一分类（超时 / 网络 / 鉴权 / 5xx…）：上层可据 kind / retryable 分流，不必解析 message
        const classified = classifyNetworkErrorText(combined);
        // issue #79：SSH 主机密钥校验失败 → 换成「怎么信任该主机」的可操作说明（绝不自动信任）
        if (SSH_HOST_KEY_RE.test(combined)) {
          throw new GitTransportError(this.hostKeyMessage(), { kind: 'auth', retryable: false });
        }
        // 推送 + 鉴权失败：git 原文只说「认证失败」——换成能照做的说明（令牌失效 / 无写权限 / 远端禁用了密码推送）
        const message = opts.requirePushToken === true && classified.kind === 'auth'
          ? this.msg('sync.git.pushAuthFailed', { err: this.mask(result.stderr, token) })
          : this.msg('sync.git.cmdFailed', { args: args.join(' '), code: String(result.code), err: this.mask(result.stderr, token) });
        throw new GitTransportError(message, classified);
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
    // 空令牌绝不写进 credential 文件（真机形态）：`https://oauth2:@host` 会被 git 当作「有凭据、口令为空」
    // 提交，远端回的是「Invalid username or token / Password authentication is not supported」——
    // 这条消息指向「令牌不对」，而真实原因是「本机根本没配令牌」。空令牌一律退回匿名（公开仓库照常可读）。
    if (token === '') return { extraArgs: [], token, cleanup: async () => {} };
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-cred-'));
    const credFile = path.join(tmpDir, 'credential');
    const host = this.repoHost();
    const fileArg = quoteGitValue(credFile.replace(/\\/g, '/'));
    await atomicWriteFile(credFile, `https://${this.o.credentialUsername}:${token}@${host}\n`, { mode: 0o600, symlink: 'reject' });
    return {
      // issue #103：**必须**把用户名也钉进 git 参数。git credential store 用 URL 里的 username
      // 作为查找键；store 文件写的是本插件自己的用户名（默认 oauth2），但 git 会先读全局
      // `.gitconfig` 里的 `credential.<url>.username`（Git Credential Manager / gh CLI 都会写这一行），
      // 用那个用户名去查 store —— 键对不上就查不到口令，无 tty 时退化成
      // `fatal: could not read Password for 'https://<全局用户名>@host'`。
      // 钉住 username 后查找键与 store 文件里的值同源（都来自 credentialUsername）。
      extraArgs: [
        '-c', 'credential.helper=',
        '-c', `credential.helper=store --file=${fileArg}`,
        '-c', `credential.username=${this.o.credentialUsername}`,
      ],
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

  /**
   * SSH 主机密钥失败的**可操作**文案（issue #79）。有 host 提示时带上 host[:port]；
   * 解析不出主机（异常地址）走无主机变体，绝不把解析失败的地址硬塞进文案。
   */
  private hostKeyMessage(): string {
    const host = this.sshHostHint();
    return host === ''
      ? this.msg('sync.git.hostKeyUnverifiedNoHost')
      : this.msg('sync.git.hostKeyUnverified', { host });
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

  /**
   * 读密文单文件快照（解析失败 → null，调用方跳过，不静默失败整体 list）。
   *
   * issue #59：解析失败**必须留下原因**。此前 catch 把一切吞掉，`list()` 再静默 `continue`，
   * 于是「push 报成功 + 远端列表为空 + download 报损坏」这种自相矛盾状态用户无从自查。
   * 现在把原因记进 `readErrors`，由路由层回传（列表里同时给出 currentSnapshotId 的语境）。
   */
  private async readEncryptedSnapshotFile(file: string): Promise<SyncSnapshot | null> {
    try {
      const raw = Buffer.from(await createSnapshotFs().readFile(file)).toString('utf8');
      return deserializeSnapshot(raw);
    } catch (err) {
      this.readErrors.push({ file, reason: this.mask(String((err as Error)?.message ?? err), null) });
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
