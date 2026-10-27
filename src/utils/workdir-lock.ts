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
 *  - holder 崩溃留下的陈旧锁：先问 holder pid 是否还存在（ESRCH ⇒ 已被杀，立即回收），
 *    读不出 pid 或进程仍存活时才按 mtime 超过 staleMs 回收（避免误抢仍在跑的长时间任务）；
 *  - 等待方是**有界**的：等文件锁与进程内链上排队共用同一个 timeoutMs 上限，超时即抛，
 *    绝不在界面早已放弃之后仍去驱动工作副本；
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

/**
 * holder 进程是否还活着（三态：true = 存活、false = 确定已死、null = 判不了）。
 *
 * 为什么必须问：holder 被强杀时（DSH 重启 / 崩溃 / 任务管理器结束进程）`finally` 不会执行，
 * 锁文件就留在 tmpdir 里；只按 mtime 判定要等满 staleMs（15 分钟）才接管。这段窗口里**所有**
 * 同步与只读自检都排在锁上 —— 真机 2026-10-27：DSH 重启踩在一次 push 中间，pid 28888 的锁留在
 * %TEMP%，之后每次打开同步页 `GET /sync/status` 都要等满 10 s 预算再 503。
 *
 * 误差方向：只有 `ESRCH`（pid 完全不存在）才判死；`EPERM`（进程存在但无权发信号，如 Linux 跨用户）
 * 判活；pid 复用也会把「别人的锁」判成活 —— 两种误判都偏向保守（最多退化成 mtime 规则），
 * 绝不会把仍在跑的 holder 的锁抢走。
 */
export function workdirLockHolderAlive(pid: unknown): boolean | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

/** 读锁文件里记录的 holder（读不出 / 半写入 / 不是对象 ⇒ null，一律退回 mtime 规则） */
async function readLockHolder(lockPath: string): Promise<{ pid: unknown; workDir: unknown } | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const holder = parsed as { pid?: unknown; workDir?: unknown };
    return { pid: holder.pid, workDir: holder.workDir };
  } catch {
    return null;
  }
}

const LOCK_FILE_PREFIX = 'dshcm-workdir-';
let pruneScheduled = false;

/**
 * 一次性清扫本机所有「holder 已死」的工作副本锁（每进程只跑一次）。
 *
 * 为什么需要：pid 回收只在**自己被这把锁挡住时**生效，而残留锁可能属于早已不再使用的工作目录
 * （换过仓库、换过数据目录、临时实例）—— 它们永远不会再被查询，却一直躺在 %TEMP%（真机 2026-10-27
 * 见到 8 个，最久 3.4 天）。只删 pid 确定不存在的锁：读不出 holder 的不动（保守，宁可留下）。
 */
export async function pruneDeadWorkdirLocksOnce(): Promise<void> {
  if (pruneScheduled) return;
  pruneScheduled = true;
  const dir = os.tmpdir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const remove = async (lockPath: string): Promise<void> => {
    try {
      await fs.unlink(lockPath);
    } catch {
      // 别人同时也在清扫 / 已被释放：无事可做
    }
  };
  await Promise.all(names
    .filter((name) => name.startsWith(LOCK_FILE_PREFIX) && name.endsWith('.lock'))
    .map(async (name) => {
      const lockPath = path.join(dir, name);
      const holder = await readLockHolder(lockPath);
      if (holder === null) return; // 读不出 holder：保守留下
      const alive = workdirLockHolderAlive(holder.pid);
      if (alive === false) return await remove(lockPath); // holder 确定已死
      if (alive !== true) return; // 判不了：留下
      // pid 复用陷阱：holder pid 此刻可能属于一个毫不相干的进程（本机实测 2026-10-27：一条测试残留锁的
      // pid 9704 已被 `NoiseCancelingEngine.exe` 复用）。只有「它声明的工作目录确实不存在 + 锁已过
      // staleMs」才清 —— 那说明 holder 早就不在这把锁上了，而不是正在干活。
      const st = await fs.stat(lockPath).catch(() => null);
      if (st === null || Date.now() - st.mtimeMs <= DEFAULT_WORKDIR_LOCK_STALE_MS) return;
      const workDir = typeof holder.workDir === 'string' ? holder.workDir : '';
      if (workDir === '') return;
      if (await fs.stat(workDir).then(() => true, () => false)) return;
      await remove(lockPath);
    }));
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
    // ① holder pid 已经不存在 ⇒ 这把锁必然陈旧，立即回收，不等 staleMs（重启/崩溃后的现场）
    const holder = await readLockHolder(lockPath);
    if (workdirLockHolderAlive(holder?.pid) === false) {
      try {
        await fs.unlink(lockPath);
      } catch {
        // 别人刚好也判定并回收、或 holder 的 finally 刚好跑到：下一轮重试即可
      }
      return null;
    }
    // ② 读不出 holder / holder 仍存活 ⇒ 只有超过 staleMs 才视为崩溃残留（绝不抢正在跑的长任务）
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

  // 顺带清扫本机别的死 holder 残留（每进程一次，失败不影响本次取锁）
  void pruneDeadWorkdirLocksOnce().catch(() => undefined);

  // 计时必须在进入串行链**之前**取：链上排队同样属于「在等这把锁」。否则一个只读调用排在
  // 上一个 300 s 的同步后面时，计时从轮到它那一刻才清零，超时上限形同失效（2026-10-27 现场）。
  const started = now();

  const run = async (): Promise<T> => {
    // 排队期间调用方已超时放弃：轮到它时直接失败，**不执行 fn**，免得被遗弃的请求稍后仍去驱动工作副本
    if (now() - started >= timeoutMs) throw new WorkdirLockError(workDir, now() - started);
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

  // 硬上界：timeoutMs 是「拿到锁」的上限，不是「开始计时后」的上限。只用 run 内的计时不够 ——
  // 排在长任务后面的调用永远轮不到自己计时，界面就被历史任务拖着走。这里直接对链头 race，
  // 超时 reject；被放弃的 run 之后还会被链唤醒，但入口的过期检查让它立刻抛（不碰工作副本）。
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { rejectDeadline?.(new WorkdirLockError(workDir, timeoutMs)); }, timeoutMs);
  // unref：这个计时器不该拖住进程退出（缺省 300 s）
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await Promise.race([current, deadline]);
  } finally {
    clearTimeout(timer);
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** 仅供测试：清空进程内串行链与一次性清扫标记（不影响磁盘上的锁文件） */
export function resetWorkdirLockChainsForTest(): void {
  chains.clear();
  pruneScheduled = false;
}
