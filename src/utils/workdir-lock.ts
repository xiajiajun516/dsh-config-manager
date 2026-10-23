/**
 * 工作副本级互斥锁（git 通道；sync 工作副本与 market 仓库工作副本共用）。
 *
 * 为什么必须串行化同一个工作副本：
 * 一个工作副本会被**多个互不知情的消费者**同时驱动 —— 同一进程里自动同步持着
 * withMutationLock 跑 engine.push，而 GUI 的只读路由（/sync/snapshots-list、
 * /sync/download、/sync/pull…）各自 makeSyncEngine 后直接 transport.list()，
 * 根本不参与那把锁；多开 DSH 实例（desktop + web）共用同一 sync/work 时更是跨进程。
 * market 侧同理：市场读取（GitMarketReader.ensureRepo）与市场上传（GitFileWriter.writeFiles）
 * 都会驱动同一个 market 工作副本，两者互不知情。
 *
 * git 的 `pull --ff-only` 是「fetch 写 FETCH_HEAD + 读 FETCH_HEAD 合并」的两步动作。
 * 两个 pull 并发时 FETCH_HEAD 会留下多行 for-merge 记录，随后**每个** pull 都以
 * `fatal: Cannot fast-forward to multiple branches.`（exit 128）结束（本机实测 5 并发 → 5 个全败），
 * 该错误经 runExternalIntent 被判为「不可证明」⇒ 落盘 durable SAFE MODE，用户所有改配置的操作被阻断。
 * 并发 add/commit 还会撞 `index.lock`，同样是同一类「莫名其妙的失败 → 安全模式」。
 *
 * 实现要点：
 *  - 锁文件放 `os.tmpdir()`（按工作目录绝对路径哈希命名），**不写进工作副本**：
 *    工作副本还没 clone 出来也能先锁住，且绝不让 `git status` 看到脏文件；
 *  - 跨进程独占用 `open(path,'wx')`（O_EXCL，原子）；等待方轮询，超时抛 WorkdirLockError；
 *  - holder 崩溃留下的陈旧锁按 mtime 回收（超过 staleMs 才回收，避免误抢仍在跑的长时间任务）；
 *  - 进程内再串一条 Promise 链：同进程两个 GitTransport 实例（autosync / 路由）共用同一条链，
 *    不依赖文件锁的轮询延迟。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 默认最长等待时间：正常一次 git 往返十几秒，留足余量后仍失败说明真的被卡住了 */
export const DEFAULT_WORKDIR_LOCK_TIMEOUT_MS = 300_000;
/** 陈旧锁判定阈值：超过它仍未释放才视为 holder 已崩溃（绝不轻易抢走长时间任务的锁） */
export const DEFAULT_WORKDIR_LOCK_STALE_MS = 900_000;
const POLL_INTERVAL_MS = 100;

/** 等锁超时（不是「同步失败」，而是「别人正在同步」）：调用方应换成可操作的提示文案 */
export class WorkdirLockError extends Error {
  readonly code = 'workdir-busy';
  readonly workDir: string;
  constructor(workDir: string, waitedMs: number) {
    super(`workdir lock timeout after ${String(waitedMs)}ms: ${workDir}`);
    this.name = 'WorkdirLockError';
    this.workDir = workDir;
  }
}

export interface WorkdirLockOptions {
  /** 最长等待毫秒数（缺省 DEFAULT_WORKDIR_LOCK_TIMEOUT_MS） */
  timeoutMs?: number;
  /** 陈旧锁阈值毫秒数（缺省 DEFAULT_WORKDIR_LOCK_STALE_MS） */
  staleMs?: number;
  /** 注入等待实现（测试用，缺省 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（测试用） */
  now?: () => number;
}

/** 进程内串行链：key = 归一化后的工作目录 */
const chains = new Map<string, Promise<void>>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 工作目录归一化键：Windows 大小写不敏感，必须折成小写，否则 D:\a 与 d:\a 会拿到两把不同的锁 */
export function workdirLockKey(workDir: string): string {
  const abs = path.resolve(workDir);
  return createHash('sha256').update(process.platform === 'win32' ? abs.toLowerCase() : abs).digest('hex').slice(0, 32);
}

/** 锁文件路径（导出仅为测试与诊断；不要手工删一把可能被人持有的锁） */
export function workdirLockPath(workDir: string): string {
  return path.join(os.tmpdir(), `dshcm-workdir-${workdirLockKey(workDir)}.lock`);
}

async function tryAcquire(lockPath: string, workDir: string, staleMs: number, now: () => number): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  try {
    const handle = await fs.open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, workDir, at: new Date(now()).toISOString(), token }));
    } catch {
      // 写不进内容不影响互斥语义（O_EXCL 已经拿到独占），照常返回释放器
    }
    await handle.close();
    return async () => {
      // 只删自己的锁：万一陈旧回收把锁抢给过别人，绝不能删别人正在用的锁文件
      try {
        const raw = await fs.readFile(lockPath, 'utf8');
        if (!raw.includes(token)) return;
        await fs.unlink(lockPath);
      } catch {
        // 已被别人回收/删除：无事可做
      }
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'EEXIST') throw err;
    // 陈旧锁回收：holder 崩溃/被杀后留下的文件不能让同步永久卡死
    try {
      const st = await fs.stat(lockPath);
      if (now() - st.mtimeMs > staleMs) await fs.unlink(lockPath);
    } catch {
      // stat/unlink 竞态（别人刚好释放）：下一轮重试即可
    }
    return null;
  }
}

/**
 * 在指定工作副本上串行执行 fn（同一目录的调用排队，跨进程同理）。
 *
 * 只包**会碰工作副本的 git 操作**（clone/fetch/merge/add/commit/push/reset）。
 * 不要在里面再调用会等这把锁的其他工作副本操作 —— 可重入请由调用方用自己的 depth 计数处理。
 */
export async function withWorkdirLock<T>(
  workDir: string,
  fn: () => Promise<T>,
  options: WorkdirLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKDIR_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_WORKDIR_LOCK_STALE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const key = workdirLockKey(workDir);
  const lockPath = workdirLockPath(workDir);

  const run = async (): Promise<T> => {
    const started = now();
    // 先同步做一次尝试，再进入轮询：无竞争的常见情形零额外延迟
    let release = await tryAcquire(lockPath, workDir, staleMs, now);
    while (release === null) {
      const waited = now() - started;
      if (waited >= timeoutMs) throw new WorkdirLockError(workDir, waited);
      await sleep(POLL_INTERVAL_MS);
      release = await tryAcquire(lockPath, workDir, staleMs, now);
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const prev = chains.get(key) ?? Promise.resolve();
  const current = prev.then(run, run);
  // 链里只保留「尾巴」的完成状态，异常不向下游传染
  const tail = current.then(() => undefined, () => undefined);
  chains.set(key, tail);
  try {
    return await current;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** 仅供测试：清空进程内串行链（不影响磁盘上的锁文件） */
export function resetWorkdirLockChainsForTest(): void {
  chains.clear();
}
