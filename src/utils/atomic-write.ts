/**
 * 原子写 / 原子拷贝 primitive（Phase 1：单文件一致性层）。
 *
 * 目标：任何关键配置写入，目标文件在任意时刻要么是「旧完整版」、要么是「新完整版」，
 * 绝无「半个新文件」。实现：同目录唯一 tmp → 写 + fsync → rename(tmp, target)。
 *
 * 设计要点（见 ATOMIC_WRITE_DESIGN.md v3 + ATOMIC_WRITE_DESIGN_REVIEW.md）：
 *   - 无 `.bak` 多步 fallback（Phase 1 `atomicity > forced success`）：目标被占用时
 *     有界重试后**不改写原 target、返回明确错误**；绝不暂时移走 target。
 *   - sensitive 调用先 `open('wx', 0o600)` 再写（禁 default→write→chmod）。
 *   - symlink 默认 follow（realpath 写真实目标，保留用户符号链接结构）；sensitive 用 'reject'。
 *   - tmp 名清洗（sanitizeTmpBase）+ 强制同目录，防恶意 base 路径逃逸。
 *   - Atomicity / Durability 分离：本层保证 process-crash atomicity；POSIX 额外 fsync 父目录
 *     提供 strong power-loss durability；Windows 目录 fsync 不可用（自动跳过）——不宣称绝对保证。
 *   - 通过可注入 `AtomicIo` 支持故障注入测试（不 monkey-patch 全局 fs）。
 *
 * 零 DSH 依赖（仅 node:fs / node:path / node:crypto），CLI 离线引擎可复用。
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- 常量 ----------

/** 目录 fsync 在 Windows 不被 Node 支持：打开目录会抛错 → 平台跳过 */
const WINDOWS = process.platform === 'win32';

/** 新文件默认 mode（open 时叠加进程 umask） */
const DEFAULT_FILE_MODE = 0o666;

/** tmp 名前缀（专属，用于 orphan 识别，不误删其他程序文件） */
const TMP_PREFIX = '.dshcm.';

// ---------- 类型 ----------

/** 文件句柄最小面（node fs/promises FileHandle 的子集） */
export interface AtomicHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** 可注入异步文件系统门面（默认实现包 node:fs/promises；测试注入失败点） */
export interface AtomicIo {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<void>;
  /** 目标不存在返回 null */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean } | null>;
  /** 目标不存在返回 null */
  stat(p: string): Promise<{ mode: number } | null>;
  realpath(p: string): Promise<string>;
  open(p: string, flags: string, mode?: number): Promise<AtomicHandle>;
  rename(src: string, dst: string): Promise<void>;
  unlink(p: string): Promise<void>;
  copyFile(src: string, dst: string, mode?: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  /** 父目录 fsync（POSIX strong durability）；Windows/不支持时静默 no-op */
  fsyncDir(p: string): Promise<void>;
  /** 重试退避（可注入便于测试） */
  sleep(ms: number): Promise<void>;
}

/** 同步版注入面（atomicWriteFileSync 用；仅 plugin-cli 等同步路径） */
export interface AtomicIoSync {
  mkdir(dir: string, opts: { recursive: boolean }): void;
  lstat(p: string): { isSymbolicLink(): boolean; mode: number } | null;
  realpath(p: string): string;
  open(p: string, flags: string, mode?: number): number;
  writeFd(fd: number, buf: Uint8Array): void;
  fsyncFd(fd: number): void;
  closeFd(fd: number): void;
  rename(src: string, dst: string): void;
  unlink(p: string): void;
  /** 目录 fsync（POSIX）；Windows/不支持时 no-op */
  fsyncDir(p: string): void;
}

export type SymlinkPolicy = 'follow' | 'reject';

export interface AtomicWriteOptions {
  /** 新文件权限；sensitive 调用显式 0o600 */
  mode?: number;
  /** 默认 true：目标存在则继承其 mode */
  preserveMode?: boolean;
  /** Windows / 目标被占用瞬时错误重试次数（默认 3） */
  retries?: number;
  /** 重试退避基数 ms（默认 25，翻倍递增：25→50→100） */
  retryDelayMs?: number;
  /** POSIX 是否 fsync 父目录（默认 true；Windows 自动跳过） */
  fsyncDir?: boolean;
  /** symlink 策略：默认 'follow'；sensitive 调用传 'reject' */
  symlink?: SymlinkPolicy;
  /** 测试注入的异步 io */
  io?: AtomicIo;
  /** tmp 清理失败回调（调用方接线日志，满足「清理失败留痕」要求） */
  onCleanupFailure?: (tmp: string, err: unknown) => void;
}

export interface AtomicWriteSyncOptions extends Omit<AtomicWriteOptions, 'io'> {
  syncIo?: AtomicIoSync;
}

/** 异步 io 默认实现 */
const defaultIo: AtomicIo = {
  async mkdir(d, o) { await fs.mkdir(d, o); },
  async lstat(p) {
    try { return await fs.lstat(p); } catch (e) { if (isENOENT(e)) return null; throw e; }
  },
  async stat(p) {
    try { return await fs.stat(p); } catch (e) { if (isENOENT(e)) return null; throw e; }
  },
  async realpath(p) { return fs.realpath(p); },
  async open(p, f, m) { return fs.open(p, f as 'wx', m); },
  async rename(a, b) { return fs.rename(a, b); },
  async unlink(p) { return fs.unlink(p); },
  async copyFile(a, b) { return fs.copyFile(a, b); },
  async chmod(p, mode) { return fs.chmod(p, mode); },
  async fsyncDir(p) { await fsyncDirAsync(p); },
  async sleep(ms) { await new Promise((r) => setTimeout(r, ms)); },
};

/** 同步 io 默认实现 */
const defaultSyncIo: AtomicIoSync = {
  mkdir(d, o) { fssync.mkdirSync(d, o); },
  lstat(p) {
    try { return fssync.lstatSync(p); } catch (e) { if (isENOENT(e)) return null; throw e; }
  },
  realpath(p) { return fssync.realpathSync(p); },
  open(p, f, m) { return fssync.openSync(p, f as 'wx', m); },
  writeFd(fd, buf) { fssync.writeSync(fd, buf, 0, buf.byteLength, 0); },
  fsyncFd(fd) { fssync.fsyncSync(fd); },
  closeFd(fd) { fssync.closeSync(fd); },
  rename(a, b) { fssync.renameSync(a, b); },
  unlink(p) { fssync.unlinkSync(p); },
  fsyncDir(p) { fsyncDirSyncSafe(p); },
};

/** POSIX：fs.open(dir,'r') + sync（Windows 不可用 → 静默跳过） */
async function fsyncDirAsync(p: string): Promise<void> {
  if (WINDOWS) return;
  let h: AtomicHandle | null = null;
  try {
    h = await fs.open(p, 'r');
    await h.sync();
  } catch {
    // 目录 fsync 是 best-effort：某些平台/文件系统不支持，忽略（不抛致命）
  } finally {
    if (h) try { await h.close(); } catch { /* ignore */ }
  }
}

function fsyncDirSyncSafe(p: string): void {
  if (WINDOWS) return;
  let fd: number | null = null;
  try {
    fd = fssync.openSync(p, 'r');
    fssync.fsyncSync(fd);
  } catch {
    // best-effort
  } finally {
    if (fd !== null) try { fssync.closeSync(fd); } catch { /* ignore */ }
  }
}

function isENOENT(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

function isRetryableLockCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EEXIST' || code === 'ENOTEMPTY';
}

function randomHex(nBytes: number): string {
  return crypto.randomBytes(nBytes).toString('hex');
}

/** 错误上下文（透传原始 code，便于上层识别占用/权限等） */
function withContext(e: unknown, target: string, op: string): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  (err as Error & { atomicTarget?: string; atomicOp?: string }).atomicTarget = target;
  (err as Error & { atomicTarget?: string; atomicOp?: string }).atomicOp = op;
  return err;
}

/**
 * tmp 名中 base 片段清洗：拒绝含 路径分隔符 / .. / 反斜杠 / 控制字符 / Windows 非法字符 的
 * 目标 basename，防止恶意 base 把 tmp 引出目标目录。返回安全 base。
 */
export function sanitizeTmpBase(base: string): string {
  if (base === '' || base === '.' || base === '..') throw new Error(`原子写：非法目标文件名「${base}」`);
  if (/[\\/:*?"<>|]/.test(base)) throw new Error(`原子写：目标文件名含非法字符「${base}」`);
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw new Error(`原子写：目标文件名含控制字符「${base}」`);
  }
  return base;
}

/** 解析最终写入目标：symlink 'follow' → realpath；'reject' → 拒绝 */
async function resolveTarget(i: AtomicIo, target: string, symlink: SymlinkPolicy): Promise<string> {
  const l = await i.lstat(target);
  if (l && l.isSymbolicLink()) {
    if (symlink === 'reject') {
      throw new Error(`原子写：目标为符号链接且策略为 reject，拒绝写入「${target}」`);
    }
    // follow：解析真实路径写真实文件（保留用户符号链接结构）
    return i.realpath(target);
  }
  return target;
}

async function resolveModeAsync(i: AtomicIo, existing: { mode: number } | null, opts: AtomicWriteOptions): Promise<number> {
  if (opts.mode !== undefined) return opts.mode;
  if (opts.preserveMode !== false && existing) return existing.mode;
  return DEFAULT_FILE_MODE;
}

function tmpPath(dir: string, base: string): string {
  return path.join(dir, `${TMP_PREFIX}${base}.${process.pid}.${randomHex(8)}.tmp`);
}

async function cleanupTmp(i: AtomicIo, tmp: string, opts: AtomicWriteOptions): Promise<void> {
  try {
    await i.unlink(tmp);
  } catch (e) {
    opts.onCleanupFailure?.(tmp, e);
  }
}

/** 有界重试 rename：瞬时占用（杀软/句柄）退避重试；仍失败不改写 target，尽力清理 tmp，抛错。
 *  绝不 rm(target) 或移走 target。 */
async function renameWithRetry(
  i: AtomicIo, tmp: string, target: string,
  rc: { retries: number; retryDelayMs: number },
  cleanupOnFail?: () => Promise<void>,
): Promise<void> {
  let delay = rc.retryDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      await i.rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as { code?: unknown }).code as string | undefined;
      if (isRetryableLockCode(code) && attempt < rc.retries) {
        await i.sleep(delay);
        delay *= 2;
        continue;
      }
      if (cleanupOnFail) await cleanupOnFail();
      throw withContext(e, target, 'rename');
    }
  }
}

/**
 * 原子写文件：同目录唯一 tmp → 写完整内容 → fsync(tmp) → rename(tmp, target)。
 * 失败时不改写原 target（目标要么旧完整、要么新完整）。
 */
export async function atomicWriteFile(target: string, data: string | Uint8Array, rawOpts: AtomicWriteOptions = {}): Promise<void> {
  const opts: Required<Pick<AtomicWriteOptions, 'retries' | 'retryDelayMs' | 'fsyncDir' | 'preserveMode' | 'symlink'>>
    & Omit<AtomicWriteOptions, 'retries' | 'retryDelayMs' | 'fsyncDir' | 'preserveMode' | 'symlink'> = {
    retries: rawOpts.retries ?? 3,
    retryDelayMs: rawOpts.retryDelayMs ?? 25,
    fsyncDir: rawOpts.fsyncDir ?? true,
    preserveMode: rawOpts.preserveMode ?? true,
    symlink: rawOpts.symlink ?? 'follow',
    ...rawOpts,
  };
  const bytes: Uint8Array = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const i = opts.io ?? defaultIo;
  const dst = await resolveTarget(i, target, opts.symlink);
  const dir = path.dirname(dst);
  const safeBase = sanitizeTmpBase(path.basename(dst));
  await i.mkdir(dir, { recursive: true });

  // —— 1. tmp 完整落盘 + fsync（失败点：mkdir/write/sync） —
  const existing = await i.stat(dst); // 跟随 symlink 已 resolve；存在则继承 mode
  const mode = await resolveModeAsync(i, existing, opts);
  const tmp = tmpPath(dir, safeBase);
  let handle: AtomicHandle | null = null;
  try {
    handle = await i.open(tmp, 'wx', mode); // 独占创建，先定权限再写（sensitive 传 0o600）
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (e) {
    if (handle) try { await handle.close(); } catch { /* ignore */ }
    await cleanupTmp(i, tmp, opts);
    throw withContext(e, dst, 'atomicWriteFile');
  }

  // —— 2. rename（失败点：rename；不改写原 target；失败尽力清理 tmp） —
  await renameWithRetry(i, tmp, dst, { retries: opts.retries, retryDelayMs: opts.retryDelayMs }, () => cleanupTmp(i, tmp, opts));

  // —— 3. 父目录 fsync（POSIX strong durability；Windows 跳过；失败不致命） —
  if (opts.fsyncDir && !WINDOWS) {
    try { await i.fsyncDir(dir); } catch { /* best-effort */ }
  }
}

/**
 * 原子拷贝：copyFile(src→tmp) + fsync(tmp) + rename(tmp, dst)。
 * 不整文件读内存（大 snapshot/session 避免双内存）。失败不改写 dst。
 */
export async function atomicCopyFile(src: string, dst: string, rawOpts: AtomicWriteOptions = {}): Promise<void> {
  const opts = { retries: 3, retryDelayMs: 25, fsyncDir: true, preserveMode: true, symlink: 'follow' as SymlinkPolicy, ...rawOpts };
  const i = opts.io ?? defaultIo;
  const resolved = await resolveTarget(i, dst, opts.symlink);
  const dir = path.dirname(resolved);
  const safeBase = sanitizeTmpBase(path.basename(resolved));
  await i.mkdir(dir, { recursive: true });

  const srcStat = await i.stat(src);
  const dstStat = await i.stat(resolved);
  let mode: number | undefined = opts.mode;
  if (mode === undefined) {
    // 存在→继承 dst mode；否则继承 src mode；否则默认
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    mode = dstStat ? dstStat.mode : (srcStat ? srcStat.mode : DEFAULT_FILE_MODE);
  }

  const tmp = tmpPath(dir, safeBase);
  try {
    // node fs.copyFile 的第三参是 COPYFILE_* 标志位，不是权限位 → 先 copy 再 chmod 设置权限
    await i.copyFile(src, tmp);
    if (mode !== undefined) await i.chmod(tmp, mode);
    // 用 'a'（append）打开后 fsync：'r' 只读句柄在 Windows 上 fsync 报 EPERM
    const h = await i.open(tmp, 'a');
    try { await h.sync(); } finally { await h.close(); }
  } catch (e) {
    await cleanupTmp(i, tmp, opts);
    throw withContext(e, resolved, 'atomicCopyFile');
  }

  await renameWithRetry(i, tmp, resolved, { retries: opts.retries, retryDelayMs: opts.retryDelayMs }, () => cleanupTmp(i, tmp, opts));

  if (opts.fsyncDir && !WINDOWS) {
    try { await i.fsyncDir(dir); } catch { /* best-effort */ }
  }
}

/** 同步版原子写（plugin-cli 等同步路径）。语义与 atomicWriteFile 一致。 */
export function atomicWriteFileSync(target: string, data: string | Uint8Array, rawOpts: AtomicWriteSyncOptions = {}): void {
  const opts: Required<Pick<AtomicWriteSyncOptions, 'retries' | 'retryDelayMs' | 'fsyncDir' | 'preserveMode' | 'symlink'>>
    & Omit<AtomicWriteSyncOptions, 'retries' | 'retryDelayMs' | 'fsyncDir' | 'preserveMode' | 'symlink'> = {
    retries: rawOpts.retries ?? 3,
    retryDelayMs: rawOpts.retryDelayMs ?? 25,
    fsyncDir: rawOpts.fsyncDir ?? true,
    preserveMode: rawOpts.preserveMode ?? true,
    symlink: rawOpts.symlink ?? 'follow',
    ...rawOpts,
  };
  const i = opts.syncIo ?? defaultSyncIo;

  const resolveTargetSync = (): string => {
    const l = i.lstat(target);
    if (l && l.isSymbolicLink()) {
      if (opts.symlink === 'reject') throw new Error(`原子写（同步）：目标为符号链接且策略为 reject，拒绝写入「${target}」`);
      return i.realpath(target);
    }
    return target;
  };
  const dst = resolveTargetSync();
  const dir = path.dirname(dst);
  const safeBase = sanitizeTmpBase(path.basename(dst));
  i.mkdir(dir, { recursive: true });

  const existing = statSyncSafe(i.lstat(dst));
  let mode = opts.mode;
  if (mode === undefined) {
    if (opts.preserveMode !== false && existing !== null) mode = existing;
    else mode = DEFAULT_FILE_MODE;
  }
  const tmp = tmpPath(dir, safeBase);
  let fd: number | null = null;
  try {
    fd = i.open(tmp, 'wx', mode);
    i.writeFd(fd, typeof data === 'string' ? new TextEncoder().encode(data) : data);
    i.fsyncFd(fd);
    i.closeFd(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) try { i.closeFd(fd); } catch { /* ignore */ }
    try { i.unlink(tmp); } catch { rawOpts.onCleanupFailure?.(tmp, e); }
    throw withContext(e, dst, 'atomicWriteFileSync');
  }

  let delay = opts.retryDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      i.rename(tmp, dst);
      break;
    } catch (e) {
      const code = (e as { code?: unknown }).code as string | undefined;
      if (isRetryableLockCode(code) && attempt < opts.retries) {
        // 同步版退避：用 Atomics.wait 避免占用事件循环太久的自旋；小退避足够
        busyWait(delay);
        delay *= 2;
        continue;
      }
      try { i.unlink(tmp); } catch { rawOpts.onCleanupFailure?.(tmp, e); }
      throw withContext(e, dst, 'rename');
    }
  }
  if (opts.fsyncDir && !WINDOWS) i.fsyncDir(dir);
}

function statSyncSafe(l: { isSymbolicLink(): boolean; mode: number } | null): number | null {
  return l ? l.mode : null;
}

function busyWait(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  try {
    Atomics.wait(ia, 0, 0, ms);
  } catch {
    /* SharedArrayBuffer 不可用时退化为无退避（少见） */
  }
}
