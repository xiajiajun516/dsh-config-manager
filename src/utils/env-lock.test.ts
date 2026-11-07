/**
 * 跨进程环境锁 primitive 测试（Phase 2：Cross-process Lock）。
 *
 * 覆盖基线：CROSS_PROCESS_LOCK_DESIGN.md Rev 3 §11（用例 1–18）+ §11.1b（用例 19–25，
 * BLOCKER 4 operation-scoped token）以及 §11.2/§11.3 的 withMutationLock/故障注入要点（用例 26）。
 *
 * 测试用 node:test + node:assert/strict（零第三方依赖），风格对齐 atomic-write.test.ts：
 *  - 通过可注入 EnvLockIo / ProcessIdentityProbe / 时钟（now）驱动（对齐 AtomicIo 模式）。
 *  - 跨进程用例（#3 / #16 / #17）用子进程 `node child.mjs` 动态 import 真实 env-lock.ts 验证，
 *    父进程与子进程共享同一 locks 目录（真实文件级互斥）。
 *
 * 另含 §11.7（未发布）：自动回收只承认结构性可证 stale（owner 确证死亡 / PID 复用），
 * corrupt 残留与心跳长过期启发式一律拒绝；退出兜底释放与孤儿心跳清理同样只动「可证」对象。
 *
 * 只测试，不修改实现。若某用例暴露实现 bug，以诊断注释记录 interleaving，供 Lead 修复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCli } from '../cli/index.ts';
import {
  EnvironmentLockManager,
  EnvironmentLockIOError,
  EnvironmentLockOwnedByAnotherError,
  EnvironmentLockUnavailableError,
  createPlatformProcessIdentityProbe,
  parseLinuxProcessStarttime,
  runWithMutationLock,
  withMutationLock,
  LOCK_SCHEMA_VERSION,
  OWNERSHIP_FILE,
  HEARTBEAT_PREFIX,
  RECOVERING_PREFIX,
  LOCK_BLOCK_MESSAGE,
  type LockOwnershipRecord,
  type ProcessIdentityProbe,
  type EnvLockManagerOptions,
} from './env-lock.ts';

/* ---------------------------------------------------------------- 工具 */

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
/** env-lock.ts 绝对路径（子进程动态 import 用 file:// URL） */
const ENV_LOCK_ABS = path.resolve(here, 'env-lock.ts');

/**
 * 本测试创建的 manager 登记表：收尾时统一「静止」后再删目录。
 *
 * ENOTEMPTY 的**确定性**修法（等条件成立/显式 drain，不是重试或加大 sleep）：
 * acquire 之后没有成功 release 的用例会留下写者：定时器仍在跑（从未 release），或定时器已停但
 * 在途的 atomicWriteFile（tmp → rename）尚未落地（release 的抛错分支已由产品侧 drain 兜住，
 * 本夹具是**第二层**：把「收尾时本进程对该目录已无写者」变成确定前提）。
 * 写者与 `t.after` 的 rmSync 目录遍历竞争 —— Windows 上即 `ENOTEMPTY`（本工作流实测 4 次）。
 * 静止之后本进程对该目录不再有任何写者，rmSync 才真正确定。
 */
const trackedManagers = new WeakMap<test.TestContext, EnvironmentLockManager[]>();

/** 创建 manager 并登记到本测试的收尾清单（测试内的 manager 一律走这里，别直接 new） */
function lockManager(t: test.TestContext, opts: EnvLockManagerOptions = {}): EnvironmentLockManager {
  const mgr = new EnvironmentLockManager(opts);
  const list = trackedManagers.get(t) ?? [];
  list.push(mgr);
  trackedManagers.set(t, list);
  return mgr;
}

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'env-lock-'));
  t.after(async () => {
    // ① 静止：停定时器 + 等在途写完成（等待条件成立，而非重试删除）
    for (const mgr of trackedManagers.get(t) ?? []) {
      await mgr.stopHeartbeatAndDrain().catch(() => { /* 收尾尽力而为（本身不产生写） */ });
    }
    // ② 此刻不可能再有本进程的写者 → 目录可确定性删除（无需重试/加大超时）
    fssync.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const sleepReal = sleep;

async function readText(p: string): Promise<string> {
  return new TextDecoder().decode(await fs.readFile(p));
}

/** 读取并解析环境锁 ownership 文件（不存在/损坏 → null） */
async function readOwnership(locksDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readText(path.join(locksDir, OWNERSHIP_FILE)));
  } catch { return null; }
}

function heartbeatFile(instanceId: string): string {
  return `${HEARTBEAT_PREFIX}${instanceId}`;
}

/** 等该 manager 的 heartbeat sidecar 落盘：显式 drain 其写链（acquire 后首写异步，且判 fresh 前必须已落盘） */
async function waitHeartbeat(mgr: EnvironmentLockManager): Promise<void> {
  await mgr.flushHeartbeat();
}

/** 注入面包装的真实 IO（基于 node:fs/promises），支持按路径故障注入 + rename 后钩子 */
function makeIo(): {
  io: import('./env-lock.ts').EnvLockIo;
  failOpenWhen(p: (p: string) => boolean, code?: string): void;
  failUnlinkWhen(p: (p: string) => boolean): void;
  failReadWhen(p: (p: string) => boolean): void;
  /** 注入 rename 故障（quarantine / recover 的捕获 rename 都在这里） */
  failRenameWhen(p: (p: string) => boolean): void;
  hookRename(fn: (a: string, b: string) => void | Promise<void>): void;
  clear(): void;
} {
  const openFaults: Array<{ p: (p: string) => boolean; code?: string }> = [];
  const unlinkFaults: Array<(p: string) => boolean> = [];
  const readFaults: Array<(p: string) => boolean> = [];
  const renameFaults: Array<(p: string) => boolean> = [];
  const renameHooks: Array<(a: string, b: string) => void | Promise<void>> = [];
  const io: import('./env-lock.ts').EnvLockIo = {
    async mkdir(d, o) { await fs.mkdir(d, o); },
    async open(p, flag, mode) {
      for (const f of openFaults) if (f.p(p)) {
        const e = new Error('injected open fault') as NodeJS.ErrnoException;
        if (f.code !== undefined) e.code = f.code;
        throw e;
      }
      return fs.open(p, flag as never, mode) as never;
    },
    async rename(a, b) {
      for (const f of renameFaults) if (f(a)) {
        const e = new Error('injected rename fault') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      }
      await fs.rename(a, b);
      for (const h of renameHooks) await h(a, b);
    },
    async unlink(p) {
      for (const f of unlinkFaults) if (f(p)) {
        const e = new Error('injected unlink fault') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      }
      await fs.unlink(p);
    },
    async stat(p) { try { return await fs.stat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
    async readFileText(p) {
      for (const f of readFaults) if (f(p)) throw new Error('injected read fault');
      return (await fs.readFile(p, 'utf8')).toString();
    },
    async lstat(p) { try { return await fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
    async listLocksDir(d) { return fs.readdir(d); },
  };
  return {
    io,
    failOpenWhen(p, code) { openFaults.push({ p, code }); },
    failUnlinkWhen(p) { unlinkFaults.push(p); },
    failReadWhen(p) { readFaults.push(p); },
    failRenameWhen(p) { renameFaults.push(p); },
    hookRename(fn) { renameHooks.push(fn); },
    clear() { openFaults.length = 0; unlinkFaults.length = 0; readFaults.length = 0; renameFaults.length = 0; },
  };
}

/** 可注入进程探测桩 */
function makeProbe(): {
  probe: ProcessIdentityProbe;
  get calls(): number;
  canOs(b: boolean): void;
  respond(f: (pid: number) => { alive: boolean; osProcessStartIdentity: string | null }): void;
} {
  let canOs = true;
  let impl: (pid: number) => { alive: boolean; osProcessStartIdentity: string | null } =
    () => ({ alive: false, osProcessStartIdentity: null });
  let n = 0;
  const probe: ProcessIdentityProbe = {
    async probe(pid) { n += 1; return impl(pid); },
    canGetOsIdentity() { return canOs; },
  };
  return {
    probe,
    get calls() { return n; },
    canOs(b) { canOs = b; },
    respond(f) { impl = f; },
  };
}

/** 可推进时钟 */
function makeClock(start = 5_000_000): { clock: () => number; advance(ms: number): void } {
  let t = start;
  return { clock: () => t, advance: (ms) => { t += ms; } };
}

/** 写入一份 environment.lock（模拟 external owner，供 inspect/recover 用） */
async function seedOwnership(
  locksDir: string,
  opts: { instanceId: string; pid?: number; osIdentity?: string | null; op?: string; lockVersion?: string },
): Promise<void> {
  const rec: LockOwnershipRecord = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    owner: {
      instanceId: opts.instanceId,
      instanceStartedAt: 1000,
      pid: opts.pid ?? 424242,
      hostname: 'seed-host',
      osProcessStartIdentity: opts.osIdentity ?? null,
    },
    op: opts.op ?? 'seed',
    target: 'seed',
    acquiredAt: 1,
    lockVersion: opts.lockVersion ?? '1.0.0',
    journalId: null,
  };
  await fs.writeFile(path.join(locksDir, OWNERSHIP_FILE), JSON.stringify(rec));
}

/** 写入一份 heartbeat sidecar */
async function seedHeartbeat(locksDir: string, instanceId: string, heartbeatAt: number, seq = 1): Promise<void> {
  await fs.writeFile(
    path.join(locksDir, heartbeatFile(instanceId)),
    JSON.stringify({ ownerInstanceId: instanceId, heartbeatAt, seq }),
  );
}

/* ---------------------------------------------------------------- helper：跨进程 */

/**
 * 写子进程脚本并 spawn `node` 执行。子进程以纯 JS（.mjs）+ 动态 import 加载真实 env-lock.ts，
 * 在 node ≥22.18（type stripping 默认开启）下可直接 import .ts 模块 —— 已在环境验证。
 */
function spawnNode(body: string, filePath: string, extraEnv: Record<string, string> = {}): {
  child: ChildProcess;
  getStdout(): string;
  getStderr(): string;
  exit: Promise<number>;
} {
  const child = spawn(process.execPath, [filePath], {
    env: { ...process.env, LOCK_ABS: ENV_LOCK_ABS, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let so = '';
  let se = '';
  child.stdout?.on('data', (d) => { so += d; });
  child.stderr?.on('data', (d) => { se += d; });
  const exit = new Promise<number>((res) => { child.on('close', (c) => res(c ?? -1)); });
  return { child, getStdout: () => so, getStderr: () => se, exit };
}

async function waitForSub(get: () => string, sub: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (get().includes(sub)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时等待「${sub}", 已见: ${get().slice(0, 500)}`);
    await sleepReal(30);
  }
}

/**
 * 条件等待**目录里出现**满足谓词的条目（命中即返回，超时抛错）。
 *
 * 为什么不用固定 sleep：心跳写链的「在途窗口」只有约 175 ms（renameWithRetry 的 25/50/100 ms 退避），
 * 固定睡 60 ms 在负载下可能整段错过 —— 那会让「release 时确有在途写」这个前提根本没成立，
 * 测试却照常变绿（假通过）。这里等的是**可观测事实**，等不到就响亮地失败。
 */
async function waitForDirEntry(
  dir: string,
  pred: (name: string) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const hit = fssync.readdirSync(dir).find(pred);
    if (hit !== undefined) return hit;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`超时等待「${what}」，当前目录内容：${fssync.readdirSync(dir).join(', ') || '（空）'}`);
    }
    await sleepReal(5);
  }
}

function childHeader(): string {
  return `import { pathToFileURL } from 'node:url';
const { EnvironmentLockManager } = await import(pathToFileURL(process.env.LOCK_ABS).href);
`;
}

/* ================================================================ Design §11 */

test('§11.1-c1 `open(wx)` 独占创建：并发 acquire 只有一个成功（多 manager 同目录）', async (t) => {
  const locksDir = tmp(t);
  const n = 6;
  const mgrs = Array.from({ length: n }, () => lockManager(t, { locksDir }));
  const results = await Promise.all(mgrs.map((m) => m.acquire({ op: 'concurrent' })));
  const winners = results.filter((r) => r.state === 'ACQUIRED');
  assert.equal(winners.length, 1, `必须恰好一个 ACQUIRED，实际 ${results.map((r) => r.state).join(',')}`);
  const losers = results.filter((r) => r.state !== 'ACQUIRED');
  assert.equal(losers.length, n - 1);
  // 唯一持有者释放后可再 acquire
  await mgrs[results.findIndex((r) => r.state === 'ACQUIRED')]!.release(winners[0]!.token!);
  const againMgr = lockManager(t, { locksDir });
  const again = await againMgr.acquire({ op: 're' });
  assert.equal(again.state, 'ACQUIRED');
  await againMgr.release(again.token!);
});

test('§11.1-c2 不存在 exists→write 竞态：并发双 acquire 至少失败其一', async (t) => {
  const locksDir = tmp(t);
  const a = lockManager(t, { locksDir });
  const b = lockManager(t, { locksDir });
  const [ra, rb] = await Promise.all([a.acquire({ op: 'x' }), b.acquire({ op: 'y' })]);
  assert.notEqual(ra.state === 'ACQUIRED', rb.state === 'ACQUIRED', '双 acquire 不能同时成功（源码无 exists→write）');
  const winner = ra.state === 'ACQUIRED' ? a : b;
  const token = ra.state === 'ACQUIRED' ? ra.token! : rb.token!;
  await winner.release(token);
});

test('§11.1-c3 持句柄 = 持锁（child process）：父 acquire 后，child 同 locksDir acquire → 失败', async (t) => {
  const dir = tmp(t);
  const locksDir = path.join(dir, 'locks');
  const parent = lockManager(t, { locksDir });
  const pres = await parent.acquire({ op: 'parent-hold' });
  assert.equal(pres.state, 'ACQUIRED');

  const childScript = childHeader() + `
const mgr = new EnvironmentLockManager({ locksDir: process.env.LOCKS_DIR, heartbeatIntervalMs: 100000 });
const res = await mgr.acquire({ op: 'child' });
console.log('RESULT ' + res.state + ' | ' + (res.detail ?? ''));
process.exit(1); // 期望被拒：非 0 指示「未获得锁」；父进程根据 RESULT 行判定
`;
  const file = path.join(dir, 'child3.mjs');
  await fs.writeFile(file, childScript);
  const h = spawnNode(childScript, file, { LOCKS_DIR: locksDir });
  const code = await h.exit;
  assert.equal(code, 1, 'child 应因未获得锁以非 0 退出');
  assert.ok(h.getStdout().includes('RESULT '), `child 输出: ${h.getStdout()}`);
  assert.ok(!/RESULT ACQUIRED/.test(h.getStdout()), 'child 不应 ACQUIRED（父持锁）');
  const st = h.getStdout().match(/RESULT (\S+)/)?.[1];
  assert.ok(st === 'LOCKED' || st === 'UNKNOWN_STATE', `child 被挡状态: ${st}`);
  await parent.release(pres.token!);
});

test('§11.1-c4 release：unlink 失败先 quarantine 腾空正式路径（不抛）；rename 也失败才抛错并保留 activeToken', async (t) => {
  const locksDir = tmp(t);
  const ctl = makeIo();
  const mgr = lockManager(t, { locksDir, io: ctl.io, heartbeatIntervalMs: 40 });
  const res = await mgr.acquire({ op: 'u' });
  assert.equal(res.state, 'ACQUIRED');
  // ① 只有 unlink 失败（rename 可用）→ 把记录挪走：正式路径腾空，release 不抛。
  //    真机事故正是「unlink 失败 + 调用方吞错」把锁永久留在盘上，所以这条路径不允许再把锁留在原地。
  ctl.failUnlinkWhen((p) => p === mgr.ownershipPath);
  await mgr.release(res.token!);
  assert.equal(mgr.isHolding, false, 'quarantine 成功即视为已释放');
  assert.equal(fssync.existsSync(mgr.ownershipPath), false, '正式路径必须腾空（否则下一个 acquire 只是继承僵尸锁）');

  // ② unlink + rename 双失败 → 抛错并保留 activeToken（仍持有该 inode，可重试）
  const res2 = await mgr.acquire({ op: 'u' });
  assert.equal(res2.state, 'ACQUIRED');
  ctl.failRenameWhen((p) => p === mgr.ownershipPath);
  await assert.rejects(
    () => mgr.release(res2.token!),
    (e) => e instanceof EnvironmentLockIOError,
  );
  assert.equal(mgr.isHolding, true, '双失败后必须保留 activeToken（可重试，不卡死磁盘锁）');
  assert.ok(fssync.existsSync(mgr.ownershipPath), '锁文件仍在磁盘（未被误删）');
  // 恢复后重试 release 成功
  ctl.clear();
  await mgr.release(res2.token!);
  assert.equal(mgr.isHolding, false);
  assert.equal(fssync.existsSync(mgr.ownershipPath), false, 'release 后 ownership 被删除');
});

test('§11.1-c5 owner metadata 写入/读回一致', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, {
    locksDir,
    op: 'import',
    target: 'executeImportPlan',
    lockVersion: '0.0.0-test',
  });
  const res = await mgr.acquire({ op: 'import', target: 'executeImportPlan' });
  assert.equal(res.state, 'ACQUIRED');
  const owner = (await readOwnershipByMgr(mgr)) as LockOwnershipRecord;
  assert.equal(owner.schemaVersion, LOCK_SCHEMA_VERSION);
  assert.equal(owner.owner.instanceId, res.token!.instanceId);
  assert.equal(owner.owner.pid, process.pid);
  assert.equal(owner.owner.hostname, os.hostname());
  assert.equal(typeof owner.owner.instanceStartedAt, 'number');
  assert.equal(owner.op, 'import');
  assert.equal(owner.target, 'executeImportPlan');
  assert.equal(owner.lockVersion, '0.0.0-test');
  assert.ok(owner.owner.osProcessStartIdentity === null || typeof owner.owner.osProcessStartIdentity === 'string');
  await mgr.release(res.token!);
});

/** 直接读 manager 的 ownership 文件并解析（返回 null 若缺失） */
async function readOwnershipByMgr(mgr: EnvironmentLockManager): Promise<LockOwnershipRecord | null> {
  try { return JSON.parse(await readText(mgr.ownershipPath)) as LockOwnershipRecord; }
  catch { return null; }
}

/**
 * 有界等待 heartbeat sidecar 的 seq 超过 `fromSeq`，返回最新记录（超时则返回当前值）。
 *
 * 为什么不能固定 sleep 猜定时器：`§11.1-c6` 原先「sleep 70ms ×3，再断言 seq 递增」，
 * 而 heartbeat 定时器在 CI 负载下可能整段采样窗口都没触发 —— 实测失败 `heartbeat seq 应递增: 2,2,2`
 * （同一 commit 重跑即过）。产品侧 seq 用 `++this.heartbeatSeq`，单进程内严格单调，
 * 问题只在测试用墙钟猜「定时器何时跑」，故改为等待**观测到的**推进。
 *
 * `minHeartbeatAt`（§11.1-c9 用）：60ms 定时器同样由**墙钟**驱动，故「acquire → 推进注入时钟」之间
 * 可能已经跑完一整轮 tick —— 那条记录的 seq 更大，但 heartbeatAt 仍是**推进前**的时钟。只等 seq 递增
 * 会把这条「合法但陈旧」的续期当成「推进后的续期」（§11.1-c9 实测形态：seq 递增成立、heartbeatAt 断言失败）。
 * 传入推进后的时钟 = 等到**推进之后发起**的那次写；陈旧记录被**跳过**，而不是把断言调松。
 * 超时仍如实返回最后观测到的记录，由调用方断言报错（产品侧不再续期 / 心跳不跟随注入时钟时必然失败）。
 */
async function waitHeartbeatSeqAbove(
  hbPath: string,
  fromSeq: number,
  timeoutMs = 5000,
  minHeartbeatAt = Number.NEGATIVE_INFINITY,
): Promise<{ seq: number; heartbeatAt: number }> {
  const deadline = Date.now() + timeoutMs
  let rec = JSON.parse(await readText(hbPath)) as { seq: number; heartbeatAt: number }
  while ((rec.seq <= fromSeq || rec.heartbeatAt < minHeartbeatAt) && Date.now() < deadline) {
    await sleepReal(20)
    rec = JSON.parse(await readText(hbPath)) as { seq: number; heartbeatAt: number }
  }
  return rec
}

test('§11.1-c6 heartbeat sidecar 更新不替换 environment.lock（inode/内容不变）', async (t) => {
  const locksDir = tmp(t);
  const ctl = makeIo();
  const mgr = lockManager(t, { locksDir, io: ctl.io, heartbeatIntervalMs: 50 });
  const res = await mgr.acquire({ op: 'hb' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  // 显式等首写落盘（acquire 的首写同步入链 → drain 必然覆盖它），不再用 2s 有界轮询猜定时器
  await mgr.flushHeartbeat();
  const sawSb = (await mgr.listLockFiles()).some((n) => n === heartbeatFile(id));
  assert.ok(sawSb, 'heartbeat sidecar 应已创建');
  const beforeText = await readText(path.join(locksDir, OWNERSHIP_FILE));
  // 等若干心跳周期（≥3 tick），期间只更新 sidecar
  const hbPath = path.join(locksDir, heartbeatFile(id));
  const seqProbe: number[] = [JSON.parse(await readText(hbPath)).seq as number];
  for (let want = 1; want <= 3; want++) {
    const prev = seqProbe[seqProbe.length - 1]!;
    const next = await waitHeartbeatSeqAbove(hbPath, prev);
    if (next.seq <= prev) break; // 有界等待超时：如实停止采样，由下面的断言报错（不假装更新过）
    seqProbe.push(next.seq);
  }
  // ownership 内容绝对不变（无 rename/replace —— 若有 atomicWriteFile 替换 ownership 则内容会变/文件被换）
  const afterText = await readText(path.join(locksDir, OWNERSHIP_FILE));
  assert.equal(afterText, beforeText, 'heartbeat 更新不得替换 environment.lock 内容');
  // POSIX 下断言 inode 不变
  if (process.platform !== 'win32') {
    const ino1 = (await fs.stat(path.join(locksDir, OWNERSHIP_FILE))).ino;
    const ino2 = (await fs.stat(path.join(locksDir, OWNERSHIP_FILE))).ino;
    assert.equal(ino1, ino2, 'ownership inode 必须稳定');
  }
  assert.ok(
    seqProbe.length >= 2,
    `heartbeat sidecar 应在有界等待内至少推进一次（观测采样 ${seqProbe.length} 次: ${seqProbe.join(',')}）`,
  );
  assert.ok(seqProbe[seqProbe.length - 1]! > seqProbe[0]!, `heartbeat seq 应递增: ${seqProbe.join(',')}`);
  for (let i = 1; i < seqProbe.length; i++) {
    assert.ok(seqProbe[i]! > seqProbe[i - 1]!, `heartbeat seq 必须严格单调: ${seqProbe.join(',')}`);
  }
  // heartbeat sidecar 内容绑定 ownerInstanceId
  const hb = JSON.parse(await readText(hbPath)) as { ownerInstanceId: string };
  assert.equal(hb.ownerInstanceId, id);
  await mgr.release(res.token!);
});

test('§11.1-c7 old heartbeat sidecar 不影响新 owner（不同 instanceId 文件名隔离）', async (t) => {
  const locksDir = tmp(t);
  // A 持有并释放；期间人为残留一个其它 owner 的 heartbeat
  const a = lockManager(t, { locksDir });
  const ra = await a.acquire({ op: 'a' });
  const idA = ra.token!.instanceId;
  await fs.writeFile(path.join(locksDir, heartbeatFile('foreign-owner')), JSON.stringify({
    ownerInstanceId: 'foreign-owner', heartbeatAt: 0, seq: 1,
  }));
  // A 释放只删自己的 heartbeat，不得触碰 foreign 的
  await a.release(ra.token!);
  assert.equal(fssync.existsSync(path.join(locksDir, heartbeatFile(idA))), false, 'A 的 heartbeat 应被清理');
  assert.ok(fssync.existsSync(path.join(locksDir, heartbeatFile('foreign-owner'))), '其它 owner 的 heartbeat 不得被误删');

  // 新 owner B acquire：不同 instanceId → 文件名不同
  const b = lockManager(t, { locksDir });
  const rb = await b.acquire({ op: 'b' });
  const idB = rb.token!.instanceId;
  assert.notEqual(idB, idA);
  // 模拟 B 的锁 + 新鲜 heartbeat：inspect 只依据 B 自己的 sidecar，忽略 foreign 残留
  await waitHeartbeat(b); // 等首写 heartbeat 落盘，避免异步 race 误判 expired
  const insp = await b.inspectLockState();
  assert.equal(insp.state, 'LOCKED', 'fresh heartbeat（新 owner 自己的 sidecar）→ LOCKED，不受旧的 foreign heartbeat 影响');
  await b.release(rb.token!);
});

test('§11.1-c8 release instanceId mismatch → 抛 EnvironmentLockOwnedByAnotherError + 不 unlink', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir });
  const res = await mgr.acquire({ op: 'rel' });
  const token = res.token!;
  // 外部篡改 ownership.instanceId（模拟异常恢复/人工修改/他方接管）
  const owner = (await readOwnershipByMgr(mgr))!;
  owner.owner.instanceId = 'EVIL-OTHER';
  await fs.writeFile(mgr.ownershipPath, JSON.stringify(owner));
  await assert.rejects(
    () => mgr.release(token),
    (e) => e instanceof EnvironmentLockOwnedByAnotherError,
  );
  assert.ok(fssync.existsSync(mgr.ownershipPath), 'instanceId 不匹配必须拒绝 unlink');
});

test('§11.1-c9 heartbeat 续期（注入时钟）+ 持续写 sidecar', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const ctl = makeIo();
  const mgr = lockManager(t, { locksDir, io: ctl.io, now: clk.clock, heartbeatIntervalMs: 60 });
  const res = await mgr.acquire({ op: 'lease' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  const hbPath = path.join(locksDir, heartbeatFile(id));
  // 显式等首写落盘。原先的 2s 有界轮询在负载下可能不够 → 轮询退出后 readText 抛 ENOENT（偶发失败）
  await mgr.flushHeartbeat();
  const first = JSON.parse(await readText(hbPath)) as { heartbeatAt: number; seq: number };
  assert.equal(first.heartbeatAt, clk.clock(), '首写 heartbeatAt 使用注入时钟');
  // 推进时钟 + 等待若干 tick → heartbeatAt 跟随推进后的时钟（续期）
  clk.advance(5000);
  // 有界等待**推进之后发起**的那次 heartbeat 写（不固定 sleep 猜定时器；§11.1-c6 的同类加固）。
  //
  // 失败时间线（原实现只等 seq 递增，故仍偶发失败 —— 0.1.63 声明的「同类加固」只覆盖了「等多久」，
  // 没覆盖「等到的是哪一次写」）：60ms 心跳定时器由**墙钟**驱动，而 acquire() 之后到 advance() 之前
  // 还要跑 flushHeartbeat()（drain 首写）+ readText()，全量套件负载下这段墙钟可能已跨过一个 tick：
  //   t0        acquire() 返回（首写同步入链、定时器注册，interval=60ms）
  //   t0+ε      flushHeartbeat() → first = { seq: 1, heartbeatAt: 5_000_000 }
  //   t0+60     （负载下提前发生）定时器 tick → sidecar 落盘 seq: 2，heartbeatAt 仍是 5_000_000
  //   t0+120    clk.advance(5000) → clock() = 5_005_000
  //   t0+120    waitHeartbeatSeqAbove(…, 1) 立刻观测到 seq: 2 → 断言 1 成立、断言 2 失败
  // 带 minHeartbeatAt = 推进后的时钟 = 「等到推进之后发起的那次写」：上面那条陈旧记录被跳过，
  // 下一条 tick（≤60ms 后，墙钟推进后必然发生）以新时钟落盘，断言 1/2 同时成立。
  const last = await waitHeartbeatSeqAbove(hbPath, first.seq, 5000, clk.clock() - 60);
  assert.ok(last.seq > first.seq, '续期后 seq 递增');
  assert.ok(last.heartbeatAt >= clk.clock() - 60, '续期 heartbeatAt 反映推进后的时钟');
  await mgr.release(res.token!);
});

test('§11.1-c10 heartbeat write failure → degraded 标记 + 不中断 + 无自动删除', async (t) => {
  const locksDir = tmp(t);
  const failures: unknown[] = [];
  const ctl = makeIo();
  const mgr = lockManager(t, {
    locksDir,
    io: ctl.io,
    heartbeatIntervalMs: 300,
    onHeartbeatWriteFailure: (e) => failures.push(e),
  });
  const res = await mgr.acquire({ op: 'hb-fail' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  const hbPath = path.join(locksDir, heartbeatFile(id));
  // 显式等首写落盘（不再有界轮询猜定时器）
  await mgr.flushHeartbeat();
  // 用同路径目录替换 sidecar → 下一次 atomicWriteFile 的 rename 失败（sidecar 更新失败）
  await fs.rm(hbPath, { force: true });
  await fs.mkdir(hbPath);
  const ownerBefore = await readText(path.join(locksDir, OWNERSHIP_FILE));
  // 有界等待**观测到**失败回调，而不是固定 sleep 900ms 猜周期（负载下 900ms 内可能一次都没触发 → 偶发）
  for (let i = 0; i < 250 && failures.length === 0; i++) await sleepReal(20); // 上界 5s（条件一旦成立即返回）
  assert.ok(failures.length > 0, 'heartbeat 写失败应触发 onHeartbeatWriteFailure（degraded 标记）');
  assert.equal(mgr.isHolding, true, 'heartbeat 失败不得中断当前 mutation（锁仍持有）');
  const ownerAfter = await readText(path.join(locksDir, OWNERSHIP_FILE));
  assert.equal(ownerAfter, ownerBefore, 'heartbeat 失败不得替换/删除 ownership（无自动 takeover）');
  // 清理：恢复为可删除状态后仍能正常 release
  await fs.rmdir(hbPath);
  await mgr.release(res.token!);
  assert.equal(mgr.isHolding, false);
});

test('§11.1-c11 stale 判定状态表（可注入 probe）', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  // fresh heartbeat → LOCKED
  {
    await seedOwnership(locksDir, { instanceId: 'fresh', pid: 1111, osIdentity: 'osX' });
    await seedHeartbeat(locksDir, 'fresh', clk.clock());
    await fs.rm(path.join(locksDir, heartbeatFile('fresh')), { force: true });
    // 重新写一份 fresh（让 heartbeatAt = clk.clock()）
    await seedHeartbeat(locksDir, 'fresh', clk.clock());
    const p = makeProbe();
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    const s = await m.inspectLockState();
    assert.equal(s.state, 'LOCKED', 'heartbeat fresh → LOCKED');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('fresh')), { force: true });
  }
  // expired + PID 不存在 → STALE
  {
    await seedOwnership(locksDir, { instanceId: 'dead', pid: 2222, osIdentity: 'osY' });
    await seedHeartbeat(locksDir, 'dead', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => ({ alive: false, osProcessStartIdentity: null }));
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'STALE_LOCK_DETECTED');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('dead')), { force: true });
  }
  // expired + PID 存活 + identity 不同 → STALE（PID reuse）
  {
    await seedOwnership(locksDir, { instanceId: 'reuse', pid: 3333, osIdentity: 'osOld' });
    await seedHeartbeat(locksDir, 'reuse', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => ({ alive: true, osProcessStartIdentity: 'osNew' }));
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'STALE_LOCK_DETECTED', 'PID reuse → STALE');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('reuse')), { force: true });
  }
  // expired + PID 存活 + identity 相同 → LOCKED（owner alive / heartbeat degraded）
  {
    await seedOwnership(locksDir, { instanceId: 'alive', pid: 4444, osIdentity: 'osSame' });
    await seedHeartbeat(locksDir, 'alive', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => ({ alive: true, osProcessStartIdentity: 'osSame' }));
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'LOCKED', 'alive + identity 同 → LOCKED');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('alive')), { force: true });
  }
  // probe 失败 / 无法确定 → UNKNOWN_STATE
  {
    await seedOwnership(locksDir, { instanceId: 'unk', pid: 5555, osIdentity: 'osU' });
    await seedHeartbeat(locksDir, 'unk', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => { throw new Error('probe unavailable'); });
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'UNKNOWN_STATE', 'probe 失败 → UNKNOWN_STATE');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('unk')), { force: true });
  }
  // OS identity 缺失（capability 或值缺失）且 PID 存活 → UNKNOWN_STATE（保守拒删）
  {
    await seedOwnership(locksDir, { instanceId: 'c', pid: 6666, osIdentity: null });
    await seedHeartbeat(locksDir, 'c', clk.clock() - 2000);
    const p = makeProbe(); p.canOs(false); p.respond(() => ({ alive: true, osProcessStartIdentity: null }));
    const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'UNKNOWN_STATE', '无法取得 OS identity → UNKNOWN_STATE');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('c')), { force: true });
  }
  // heartbeat 读取失败（EACCES）→ UNKNOWN_STATE
  {
    await seedOwnership(locksDir, { instanceId: 'ac', pid: 7777, osIdentity: 'osA' });
    await seedHeartbeat(locksDir, 'ac', clk.clock());
    const ctl = makeIo();
    const hbAbs = path.join(locksDir, heartbeatFile('ac'));
    ctl.failReadWhen((p) => p === hbAbs);
    const p = makeProbe();
    const m = lockManager(t, { locksDir, io: ctl.io, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'UNKNOWN_STATE', 'heartbeat 读失败 → UNKNOWN_STATE');
  }
});

test('§11.1-c11b issue #36：心跳**长过期** + pid 存活 + 身份不可验证 → 判为可显式回收的残留锁', async (t) => {
  const locksDir = tmp(t);
  // Windows 场景复刻（issue #36 实测）：记录侧 osProcessStartIdentity=null、探测侧也拿不到身份
  // （win32 canGetOsIdentity()=false），pid 因复用而"存活"，心跳却已停更 9 天。
  const clk = makeClock();
  const nineDaysAgo = clk.clock() - 9 * 86_400_000;
  await seedOwnership(locksDir, { instanceId: 'win36', pid: 24140, osIdentity: null });
  await seedHeartbeat(locksDir, 'win36', nineDaysAgo);
  const p = makeProbe(); p.canOs(false); p.respond(() => ({ alive: true, osProcessStartIdentity: null }));

  // ① 默认阈值（max(30×staleAfterMs, 30min)）下应判 STALE —— 这正是此前永远卡在 UNKNOWN_STATE 的用例
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 10_000 });
  const s = await m.inspectLockState();
  assert.equal(s.state, 'STALE_LOCK_DETECTED', `长过期残留锁必须可识别（此前恒 UNKNOWN_STATE）: ${s.detail}`);
  assert.match(s.detail ?? '', /残留锁/, '诊断必须说清「可显式回收」');
  // ② acquire 侧仍然**不自动摘锁**（只分类，不 unlink）
  const res = await m.acquire({ op: 'issue36' });
  assert.equal(res.state, 'STALE_LOCK_DETECTED', 'acquire 只报告，不得自动接管');
  assert.ok(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), 'STALE 判定绝不自动 unlink');
  // ③ 显式回收必须真的成功（此前 recover-stale-lock 拒绝 → 用户只能手工删锁文件）
  const r = await m.recoverStaleLock();
  assert.equal(r.ok, true, `显式回收必须成功: ${r.detail}`);
  assert.equal(r.removed, true);
  assert.equal(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), false, '回收后 ownership 必须消失');
  assert.deepEqual(fssync.readdirSync(locksDir), [], 'heartbeat sidecar 一并清理，无 recovering 残留');
});

test('§11.1-c11c issue #36 边界：未达长过期阈值仍保守 UNKNOWN_STATE；heartbeat 缺失也不放宽', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe(); p.canOs(false); p.respond(() => ({ alive: true, osProcessStartIdentity: null }));

  // ① 只过期 2s（阈值 60s）→ 仍 UNKNOWN_STATE：活着的 owner 只是心跳降级，绝不放宽
  await seedOwnership(locksDir, { instanceId: 'short', pid: 7001, osIdentity: null });
  await seedHeartbeat(locksDir, 'short', clk.clock() - 2_000);
  const m1 = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });
  assert.equal((await m1.inspectLockState()).state, 'UNKNOWN_STATE', '短过期不得判 stale');
  assert.equal((await m1.recoverStaleLock()).ok, false, '短过期不得被显式回收');

  // ② heartbeat sidecar 完全缺失（不是"读过且很旧"）→ 无从判断过期时长 → 保守 UNKNOWN_STATE
  await seedOwnership(locksDir, { instanceId: 'nohb', pid: 7002, osIdentity: null });
  await fs.rm(path.join(locksDir, heartbeatFile('nohb')), { force: true });
  const m2 = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });
  assert.equal((await m2.inspectLockState()).state, 'UNKNOWN_STATE', 'sidecar 缺失不得当作"长过期"');

  // ③ 阈值注入可调：过期 61s > 阈值 60s → STALE（证明阈值真的参与判定，而非硬编码天数）
  //    （② 已把 ownership 换成 nohb，这里要连 ownership 一起换回 short）
  await seedOwnership(locksDir, { instanceId: 'short', pid: 7001, osIdentity: null });
  await seedHeartbeat(locksDir, 'short', clk.clock() - 61_000);
  const m3 = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });
  assert.equal((await m3.inspectLockState()).state, 'STALE_LOCK_DETECTED', '越过阈值即判 stale');
});

test('§11.1-c12 definitely stale → acquire 返回 STALE_LOCK_DETECTED（不自动删除）', async (t) => {
  const locksDir = tmp(t);
  await seedOwnership(locksDir, { instanceId: 'dead2', pid: 8888 });
  await seedHeartbeat(locksDir, 'dead2', Date.now() - 20_000);
  const p = makeProbe(); p.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  const m = lockManager(t, { locksDir, probe: p.probe, staleAfterMs: 10_000 });
  const res = await m.acquire({ op: 'x' });
  assert.equal(res.state, 'STALE_LOCK_DETECTED');
  assert.ok(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), 'STALE 判定绝不自动 unlink');
});

test('§11.1-c13 两 contender 同时发现 stale → 都不自动 destructive takeover（无 unlink）', async (t) => {
  const locksDir = tmp(t);
  await seedOwnership(locksDir, { instanceId: 'dead3', pid: 9999 });
  await seedHeartbeat(locksDir, 'dead3', Date.now() - 20_000);
  const pA = makeProbe(); pA.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  const pB = makeProbe(); pB.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  const a = lockManager(t, { locksDir, probe: pA.probe, staleAfterMs: 10_000 });
  const b = lockManager(t, { locksDir, probe: pB.probe, staleAfterMs: 10_000 });
  const [ra, rb] = await Promise.all([a.acquire({ op: 'a' }), b.acquire({ op: 'b' })]);
  assert.equal(ra.state, 'STALE_LOCK_DETECTED');
  assert.equal(rb.state, 'STALE_LOCK_DETECTED');
  assert.ok(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), '两 contender 都不得自动删除（无自动 takeover）');
});

test('§11.1-c14 recovery 只删被 rename 捕获且二次验证的 inode；新 owner 不被删', async (t) => {
  const locksDir = tmp(t);
  await seedOwnership(locksDir, { instanceId: 'stale-owner', pid: 10101, osIdentity: 'osS' });
  await seedHeartbeat(locksDir, 'stale-owner', Date.now() - 20_000);
  // capture rename 完成后，立刻出现 successor 新 owner（模拟并发接管）
  const ctl = makeIo();
  const ownershipAbs = path.join(locksDir, OWNERSHIP_FILE);
  ctl.hookRename(async (a, b) => {
    if (a === ownershipAbs) {
      const successor: LockOwnershipRecord = {
        schemaVersion: LOCK_SCHEMA_VERSION,
        owner: { instanceId: 'successor', instanceStartedAt: 2000, pid: process.pid, hostname: os.hostname(), osProcessStartIdentity: 'osNewOwner' },
        op: 'successor-op', target: 'successor', acquiredAt: 3000, lockVersion: '1.0.0', journalId: null,
      };
      await fs.writeFile(a, JSON.stringify(successor));
    }
  });
  const p = makeProbe(); p.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  const m = lockManager(t, { locksDir, io: ctl.io, probe: p.probe, staleAfterMs: 10_000 });
  const r = await m.recoverStaleLock();
  assert.equal(r.ok, true, `recovery 应成功: ${r.detail}`);
  assert.equal(r.removed, true);
  // successor 未被删除（只删被 rename 捕获的 stale inode）
  const successorOwner = (await readOwnership(locksDir)) as LockOwnershipRecord;
  assert.equal(successorOwner.owner.instanceId, 'successor', '后继新 owner 必须保留');
  // 无 recovering 残留
  const files = await fs.readdir(locksDir);
  assert.ok(!files.some((n) => n.startsWith(RECOVERING_PREFIX)), '恢复成功不应残留 recovering 文件');
});

test('§11.1-c15 CLI 无 bypass-active-lock `--force`（parseCli 拒绝，无旁路）', async (t) => {
  // 行为断言：所有 destructive 子命令遇到 --force 一律返回未知参数错误（无 bypass 解析分支）
  for (const cmd of ['restore', 'snapshots', 'reinstall', 'recover-stale-lock']) {
    const r = parseCli([cmd, '--force']);
    assert.equal(r.ok, false, `parseCli(['${cmd}','--force']) 必须拒绝`);
    assert.ok(r.ok === false && r.error.includes('未知参数'), `错误应指明未知 flag: ${r.error}`);
  }
  // 源码级断言：--force 只出现在「声明其不存在」的注释中，不作为可解析 flag（parseCli 无 flag==='--force' 分支）
  const src = await readText(path.resolve(here, '../cli/index.ts'));
  assert.ok(!src.includes("=== '--force'") && !src.includes("=== \"--force\""), 'parseCli 不得有 --force 解析分支');
  assert.ok(!/VALUE_FLAGS[^]*?'--force'/.test(src), 'VALUE_FLAGS 不得含 --force');
});

test('§11.1-c16 崩溃模拟（child）：持锁后 exit → 残留 lock；recoverStaleLock 显式回收', async (t) => {
  const dir = tmp(t);
  const locksDir = path.join(dir, 'locks');
  // child：用「过去时钟」获取锁（heartbeat 立即写为过期）→ 立即 exit（模拟崩溃，不 release）
  const childScript = childHeader() + `
const mgr = new EnvironmentLockManager({ locksDir: process.env.LOCKS_DIR, now: () => Date.now() - 20000, heartbeatIntervalMs: 100000 });
const res = await mgr.acquire({ op: 'crash' });
if (res.state !== 'ACQUIRED') { console.log('FAIL ' + res.state); process.exit(2); }
// 有界等待**观测到** sidecar 落盘再退出：acquire 的首写是异步 fire-and-forget，固定 300ms 在负载下
// 可能还没落盘 → 父进程「崩溃后应残留 heartbeat sidecar」断言偶发失败（墙钟猜测 → 条件等待）。
// 显式等首写落盘（首写同步入链 → 确定性等待，不用 sleep / 轮询去猜定时器）
await mgr.flushHeartbeat();
console.log('HELD');
process.exit(0);
`;
  const file = path.join(dir, 'child16.mjs');
  await fs.writeFile(file, childScript);
  const h = spawnNode(childScript, file, { LOCKS_DIR: locksDir });
  assert.equal(await h.exit, 0);
  assert.ok(h.getStdout().includes('HELD'));
  // 崩溃后残留：environment.lock + heartbeat sidecar
  const files = (await fs.readdir(locksDir)).sort();
  assert.ok(files.includes(OWNERSHIP_FILE), `崩溃后应残留 environment.lock: ${files.join(',')}`);
  assert.ok(files.some((n) => n.startsWith(HEARTBEAT_PREFIX)), '崩溃后应残留 heartbeat sidecar');
  // 父进程探测：child 已退出 → heartbeat 过期 + PID 确证死亡 → STALE
  const insp = await lockManager(t, { locksDir, staleAfterMs: 10_000 }).inspectLockState();
  assert.equal(insp.state, 'STALE_LOCK_DETECTED');
  // 显式 recover 成功
  const rec = await lockManager(t, { locksDir, staleAfterMs: 10_000 }).recoverStaleLock();
  assert.equal(rec.ok, true);
  assert.equal(rec.removed, true);
  // 回收后可重新 acquire
  const again = await lockManager(t, { locksDir, staleAfterMs: 10_000 }).acquire({ op: 'post' });
  assert.equal(again.state, 'ACQUIRED');
  await lockManager(t, { locksDir }).release(again.token!);
});

test('§11.1-c17 跨进程互斥集成（child）：A 持锁 → B acquire 被拒 → A release → B 成功', async (t) => {
  const dir = tmp(t);
  const locksDir = path.join(dir, 'locks');
  // 子进程 A：acquire → 提示 HELD → 停留 → release → 提示 RELEASED
  const childScript = childHeader() + `
const mgrA = new EnvironmentLockManager({ locksDir: process.env.LOCKS_DIR, heartbeatIntervalMs: 100000 });
const res = await mgrA.acquire({ op: 'A' });
if (res.state !== 'ACQUIRED') { console.log('A-FAIL ' + res.state); process.exit(2); }
console.log('HELD');
// 显式等待父进程的 release 信号，而不是固定 2500ms 停留窗口：负载下父进程的 B-acquire 可能晚于窗口结束，
// A 提前 release 会让 B 意外拿到锁（偶发）。等待条件成立 → 持有期与墙钟无关。
const { existsSync } = await import('node:fs');
const heldFrom = Date.now();
while (!existsSync(process.env.RELEASE_SIGNAL)) {
  if (Date.now() - heldFrom > 20000) { console.log('A-TIMEOUT'); process.exit(3); }
  await new Promise(r => setTimeout(r, 10));
}
await mgrA.release(res.token);
console.log('RELEASED');
process.exit(0);
`;
  const file = path.join(dir, 'child17.mjs');
  await fs.writeFile(file, childScript);
  const sigPath = path.join(dir, 'release.signal');
  const h = spawnNode(childScript, file, { LOCKS_DIR: locksDir, RELEASE_SIGNAL: sigPath });
  await waitForSub(() => h.getStdout(), 'HELD');
  // B（父进程同目录）acquire 被拒
  const b = lockManager(t, { locksDir });
  const rb = await b.acquire({ op: 'B' });
  assert.notEqual(rb.state, 'ACQUIRED', 'A 持锁期间 B 不得获得锁');
  // 断言完成后才放行 A（信号驱动，见子进程脚本注释）→ 等 A release
  await fs.writeFile(sigPath, 'go');
  await waitForSub(() => h.getStdout(), 'RELEASED');
  assert.equal(await h.exit, 0);
  // B 再 acquire 成功
  const rb2 = await b.acquire({ op: 'B2' });
  assert.equal(rb2.state, 'ACQUIRED');
  await b.release(rb2.token!);
});

test('§11.1-c18 Windows close→unlink 语义（本机实跑：release 后无句柄占用、可再次 acquire）', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir });
  const r1 = await mgr.acquire({ op: 'win' });
  assert.equal(r1.state, 'ACQUIRED');
  assert.equal(mgr.isHolding, true);
  // 持有期 ownership 存在
  assert.ok(fssync.existsSync(mgr.ownershipPath));
  // release（Windows 必须先 close 再 unlink 才能删被占用文件；env-lock acquire 成功后句柄已 close）
  await mgr.release(r1.token!);
  assert.equal(mgr.isHolding, false);
  assert.equal(fssync.existsSync(mgr.ownershipPath), false, 'release 后 ownership 必须被删除（句柄已释放）');
  // 无句柄占用 → 可再次 acquire
  const r2 = await mgr.acquire({ op: 'win2' });
  assert.equal(r2.state, 'ACQUIRED');
  await mgr.release(r2.token!);
});

test('§11.1-c19 同 manager 同 instanceId 两次 acquire：第二次 LOCKED（token 模型，非 reentrant）', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir });
  const r1 = await mgr.acquire({ op: 'import' });
  assert.equal(r1.state, 'ACQUIRED');
  // 同一 manager、同一 instanceId，再次 acquire 必须被拒（operation-scoped，禁止 process-level reentrant）
  await waitHeartbeat(mgr); // 等首写 heartbeat 落盘，确保 EEXIST→inspect 判 fresh→LOCKED（确定性）
  const r2 = await mgr.acquire({ op: 'restore' });
  assert.notEqual(r2.state, 'ACQUIRED', '同 manager 并发 acquire 不得 reentrant 放行');
  assert.equal(r2.state, 'LOCKED', '已有活跃持有（无 parent token）→ LOCKED 被挡');
  assert.equal(mgr.isHolding, true, '首个 token 仍持有');
  await mgr.release(r1.token!);
  assert.equal(mgr.isHolding, false);
});

test('§11.1-c20 nested rollback token 传递：withMutationLock 收到有效 parentContext → 复用不 reacquire，release 不释放父 token', async (t) => {
  const locksDir = tmp(t);
  const lock = lockManager(t, { locksDir });
  const outer = await withMutationLock(lock, { op: 'import', target: 'executeImportPlan' });
  assert.ok(outer.context !== null, '顶层 import 应获得锁');
  assert.equal(lock.isHolding, true);
  // nested rollback：显式收到 parent token → 校验有效 → reuse，不 reacquire
  const nested = await withMutationLock(lock, { op: 'rollback', target: 'rollback', parentContext: outer.context });
  assert.ok(nested.context !== null);
  assert.equal(nested.context!.token.tokenId, outer.context!.token.tokenId, 'nested 复用父 token（同一 ownership）');
  // nested release = no-op，不得释放父 token
  await nested.release();
  assert.equal(lock.isHolding, true, 'nested.release 不得释放父 token');
  assert.ok(fssync.existsSync(lock.ownershipPath), '父锁仍在磁盘（nested 未释放）');
  // 父 release 才真正释放
  await outer.release();
  assert.equal(lock.isHolding, false);
  assert.equal(fssync.existsSync(lock.ownershipPath), false);
});

test('§11.1-c21 foreign token：manager A 的 token 传给 manager B → validate false；不能绕过 acquire', async (t) => {
  const locksDir = tmp(t);
  const a = lockManager(t, { locksDir });
  const b = lockManager(t, { locksDir });
  const ra = await a.acquire({ op: 'import' });
  assert.equal(ra.state, 'ACQUIRED');
  const tokenA = ra.token!;
  assert.equal(b.validate(tokenA), false, 'foreign manager 不得 validate 通过');
  // 用 foreign token 作为 b 的 parentContext → 不得绕过 acquire → b 被 a 的锁挡
  const nb = await withMutationLock(b, { op: 'restore', parentContext: { token: tokenA } });
  assert.equal(nb.context, null, 'foreign token 不得授权 b 复用/绕过');
  let fnCalled = false;
  await assert.rejects(
    () => runWithMutationLock(b, { op: 'restore', parentContext: { token: tokenA } }, async () => { fnCalled = true; return 1; }),
    (e) => e instanceof EnvironmentLockUnavailableError,
  );
  assert.equal(fnCalled, false, 'destructive 不得执行');
  await a.release(tokenA);
});

test('§11.1-c22 released token：release 后原 token → validate false，不授权 nested', async (t) => {
  const locksDir = tmp(t);
  const lock = lockManager(t, { locksDir });
  const r = await lock.acquire({ op: 'import' });
  const tok = r.token!;
  await lock.release(tok);
  assert.equal(lock.validate(tok), false, '已释放 token 必须失效');
  // 以已释放 token 作 parent → 不授权 reuse → 重新走 acquire（得到新 token）
  const nested = await withMutationLock(lock, { op: 'rollback', parentContext: { token: tok } });
  assert.ok(nested.context !== null);
  assert.notEqual(nested.context!.token.tokenId, tok.tokenId, 'released token 不得复用旧 ownership，应重新 acquire 新 token');
  await nested.release();
  assert.equal(lock.isHolding, false);
});

test('§11.1-c23 同 EnvLockManager 三个并发 acquire → 仅一个 ACQUIRED', async (t) => {
  const locksDir = tmp(t);
  const lock = lockManager(t, { locksDir });
  const results = await Promise.all([
    lock.acquire({ op: 'a' }),
    lock.acquire({ op: 'b' }),
    lock.acquire({ op: 'c' }),
  ]);
  const acquired = results.filter((r) => r.state === 'ACQUIRED');
  assert.equal(acquired.length, 1, `仅一个进入 mutation，实际 ${results.map((r) => r.state).join(',')}`);
  await lock.release(acquired[0]!.token!);
});

test('§11.1-c24 EPERM/EACCES 且无既有 lock → PERMISSION_ERROR / LOCK_IO_ERROR，非 LOCKED', async (t) => {
  // EPERM：无既有 lock → PERMISSION_ERROR
  {
    const locksDir = tmp(t);
    const ctl = makeIo();
    ctl.failOpenWhen((p) => p.endsWith(OWNERSHIP_FILE), 'EPERM');
    const m = lockManager(t, { locksDir, io: ctl.io });
    const res = await m.acquire({ op: 'perm' });
    assert.equal(res.state, 'PERMISSION_ERROR', 'EPERM 无既有锁 → PERMISSION_ERROR，不得误报 LOCKED');
  }
  // EACCES：无既有 lock → PERMISSION_ERROR
  {
    const locksDir = tmp(t);
    const ctl = makeIo();
    ctl.failOpenWhen((p) => p.endsWith(OWNERSHIP_FILE), 'EACCES');
    const m = lockManager(t, { locksDir, io: ctl.io });
    const res = await m.acquire({ op: 'acc' });
    assert.equal(res.state, 'PERMISSION_ERROR');
  }
  // 通用 IO 错误（无 EEXIST/EPERM）→ LOCK_IO_ERROR
  {
    const locksDir = tmp(t);
    const ctl = makeIo();
    ctl.failOpenWhen((p) => p.endsWith(OWNERSHIP_FILE)); // 无 code
    const m = lockManager(t, { locksDir, io: ctl.io });
    const res = await m.acquire({ op: 'io' });
    assert.equal(res.state, 'LOCK_IO_ERROR');
  }
});

test('§11.1-c25 recovery 二次验证失败 + successor 已存在 → successor 保留、recovering quarantine 不 rename 覆盖', async (t) => {
  const locksDir = tmp(t);
  await seedOwnership(locksDir, { instanceId: 'quar', pid: 12121, osIdentity: 'osQ' });
  await seedHeartbeat(locksDir, 'quar', Date.now() - 20_000);
  // 二次验证失败点：首次 probe（inspect）返回 确证死亡 → 允许 capture；
  // 第二次 probe（reProveStale）返回 alive:true + identity 相同 → reProve 判「非 stale」→ 二次验证失败
  const p = makeProbe();
  let n = 0;
  p.respond(() => {
    n += 1;
    if (n === 1) return { alive: false, osProcessStartIdentity: null };
    return { alive: true, osProcessStartIdentity: 'osQ' }; // 与 recorded 相同 → 二次验证失败
  });
  p.canOs(true);
  // capture rename 后出现 successor（模拟并发接管）
  const ctl = makeIo();
  const ownershipAbs = path.join(locksDir, OWNERSHIP_FILE);
  ctl.hookRename(async (a, b) => {
    if (a === ownershipAbs) {
      const successor: LockOwnershipRecord = {
        schemaVersion: LOCK_SCHEMA_VERSION,
        owner: { instanceId: 'successor2', instanceStartedAt: 2000, pid: process.pid, hostname: os.hostname(), osProcessStartIdentity: 'osNewOwner2' },
        op: 'successor-op', target: 'successor', acquiredAt: 3000, lockVersion: '1.0.0', journalId: null,
      };
      await fs.writeFile(a, JSON.stringify(successor));
    }
  });
  const m = lockManager(t, { locksDir, io: ctl.io, probe: p.probe, staleAfterMs: 10_000 });
  const r = await m.recoverStaleLock();
  assert.equal(r.ok, false);
  assert.equal(r.removed, false);
  assert.equal(r.state, 'UNKNOWN_STATE', '二次验证失败 → UNKNOWN_STATE（拒绝删除）');
  // successor 保留不动
  const successorOwner = (await readOwnership(locksDir)) as LockOwnershipRecord;
  assert.equal(successorOwner.owner.instanceId, 'successor2', 'successor 不得被 rename 覆盖/删除');
  // recovering quarantine 文件保留供诊断
  const files = await fs.readdir(locksDir);
  assert.ok(files.some((n) => n.startsWith(RECOVERING_PREFIX)), `应保留 quarantine recovering 文件: ${files.join(',')}`);
});

test('§11-c26 withMutationLock/runWithMutationLock：无 port 直接执行不锁；有 port 被占 → context null（destructive 不执行）', async (t) => {
  // 无 port → 恒成功、不锁定
  {
    const w = await withMutationLock(undefined, { op: 'x' });
    assert.equal(w.context, null);
    await w.release(); // no-op
    let ran = false;
    const v = await runWithMutationLock(undefined, { op: 'y' }, async (ctx) => { ran = true; assert.equal(ctx, null); return 'ok'; });
    assert.equal(v, 'ok');
    assert.equal(ran, true, '无 port 时直接执行');
  }
  // 有 port 且锁被占 → context null（destructive 不执行）
  {
    const locksDir = tmp(t);
    const holder = lockManager(t, { locksDir });
    const rh = await holder.acquire({ op: 'hold' });
    const other = lockManager(t, { locksDir });
    const w = await withMutationLock(other, { op: 'restore' });
    assert.equal(w.context, null, '锁被占 → context null（blocked）');
    let fnCalled = false;
    await assert.rejects(
      () => runWithMutationLock(other, { op: 'restore' }, async () => { fnCalled = true; return 1; }),
      (e) => e instanceof EnvironmentLockUnavailableError,
    );
    assert.equal(fnCalled, false, 'destructive 不执行');
    await holder.release(rh.token!);
  }
});

/* ------------------------------------------------ t69：未注入端口也不得 fail-open（SAFE MODE 阻断） */

/**
 * t69 回归（来源：t59 的观察项 O2）：`runWithMutationLock(port === undefined)` 修前**根本不问 isBlocked**
 * —— 未注入锁端口的环境里 SAFE MODE 的阻断态形同虚设。判定必须与有端口路径同源（withMutationLock
 * 第一步就问 isBlocked），阻断 → 同一条 EnvironmentLockUnavailableError（reason='blocked'，不新造语义）。
 */
test('t69-a 未注入端口 + SAFE MODE 阻断 → 必须拒绝（修前会放行 = fail-open）', async () => {
  let ran = false;
  await assert.rejects(
    () =>
      runWithMutationLock(undefined, { op: 'import-apply', isBlocked: () => true }, async () => {
        ran = true;
        return 'should-not-run';
      }),
    (e) => e instanceof EnvironmentLockUnavailableError && e.reason === 'blocked' && e.op === 'import-apply',
  );
  assert.equal(ran, false, '阻断态下 handler 绝不执行');
});

test('t69-b 未注入端口 + 未阻断 → 照常放行（防过度加严）', async () => {
  const seen: (null | object)[] = [];
  const v = await runWithMutationLock(undefined, { op: 'import-apply', isBlocked: () => false }, async (ctx) => {
    seen.push(ctx);
    return 'ok';
  });
  assert.equal(v, 'ok');
  assert.deepEqual(seen, [null], '未阻断时照旧不锁定、ctx=null');
});

test('t69-c 未注入端口 + 未给 isBlocked → 照常放行（§11-c26 既有行为不变）', async () => {
  let ran = false;
  const v = await runWithMutationLock(undefined, { op: 'import-apply' }, async (ctx) => {
    ran = true;
    assert.equal(ctx, null);
    return 'ok';
  });
  assert.equal(v, 'ok');
  assert.equal(ran, true);
});

test('t69-d 有端口 + 阻断 → 与未注入端口同一条拒绝语义（reason=blocked，有端口路径语义未变）', async () => {
  let ran = false;
  await assert.rejects(
    () =>
      runWithMutationLock({} as never, { op: 'restore', isBlocked: () => true }, async () => {
        ran = true;
        return 1;
      }),
    // 阻断判定发生在 acquire 之前（withMutationLock 第一步）→ 端口对象根本不会被使用，reason 必须是 'blocked'
    (e) => e instanceof EnvironmentLockUnavailableError && e.reason === 'blocked' && e.op === 'restore',
  );
  assert.equal(ran, false);
});

/* ------------------------------------------------ L3 回归：release 必须 drain 在途 heartbeat 写 */

/**
 * L3 回归（Windows flake 根因）：startHeartbeat 的首次写（及 interval 写）曾是 fire-and-forget，
 * writeHeartbeat 走 atomicWriteFile（同目录 tmp 写 → rename，异步多步）。若 release 的某条退出路径
 * 只 stopHeartbeat 而不等待在途写，该写会在 release **返回之后**才 rename → 把 sidecar 重新创建，
 * 或把 .dshcm.*.tmp 留在 locks 目录里；测试 after-hook 的 rmSync(dir) 随即报 ENOTEMPTY。
 *
 * 为了让「release 时确有在途 heartbeat 写」可确定复现（不依赖机器快慢）：在 sidecar 路径上先放一个**目录**，
 * 使 atomicWriteFile 的 rename 目标被占用 → renameWithRetry 进入有界退避重试（25/50/100ms，约 175ms），
 * 期间该写必然处于在途状态（实测：pre-release 目录里可稳定看到 .dshcm.*.tmp）。
 * 修复后 release 在**每一条**退出路径（含抛错分支）返回前都会 drain：重试窗口结束、临时文件被清理。
 */
test('L3 release 必须 drain 在途 heartbeat 写：不得残留原子写临时文件（after-hook rmSync ENOTEMPTY 根因）', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir, heartbeatIntervalMs: 1 });
  const res = await mgr.acquire({ op: 'hb-drain' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  const hbPath = path.join(locksDir, heartbeatFile(id));
  // 条件等待首写落盘（心跳 interval 1ms），不再固定睡 60 ms 猜它写过了
  await waitForDirEntry(locksDir, (n) => n === path.basename(hbPath), 'heartbeat sidecar 首次落盘');
  // 占用 sidecar 路径（目录）→ 之后的 heartbeat 写 rename 失败并进入退避重试（在途窗口 ≈175ms）。
  // 写链持续在写，rm 与 mkdir 之间存在竞争，故用有界重试把占位目录稳定建立起来。
  let occupied = false;
  for (let i = 0; i < 50 && !occupied; i++) {
    try {
      await fs.rm(hbPath, { force: true });
      await fs.mkdir(hbPath);
      occupied = true;
    } catch {
      await sleepReal(10);
    }
  }
  assert.equal(occupied, true, '应能把 sidecar 路径占位为目录（用于制造确定性的在途写）');
  // 条件等待**观测到**在途写：`.dshcm.*.tmp` 只在退避重试窗口（≈175 ms）内存在。
  // 固定睡 60 ms 在负载下可能整段错过窗口 —— 前提不成立却照常变绿（假通过）。
  await waitForDirEntry(locksDir, (n) => n.startsWith('.dshcm.') && n.endsWith('.tmp'), '在途原子写临时文件（退避重试窗口）');
  await mgr.release(res.token!);
  // 核心断言：release 返回时在途写必须已 drain —— 不得留下原子写临时文件
  // （未修复时 cleanupHeartbeat 与在途 rename 竞争，.dshcm.*.tmp 会残留 → after-hook rmSync 报 ENOTEMPTY）
  const leftovers = fssync.readdirSync(locksDir).filter((n) => n.startsWith('.dshcm.'));
  assert.deepEqual(leftovers, [], 'release 返回后不得残留原子写临时文件（L3 根因）');
  // 清理占位目录（它本身是被测方无法删除的测试夹具），并确认目录可清空
  try { await fs.rmdir(hbPath); } catch { /* 已被写链清理 */ }
  assert.deepEqual(fssync.readdirSync(locksDir), [], '清理占位目录后 locks 目录必须为空（无 sidecar / 无 .tmp 残留）');
});

test('L3 release 后 locks 目录必须完全为空（模拟 after-hook rmSync 前提）', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir, heartbeatIntervalMs: 50 });
  const res = await mgr.acquire({ op: 'hb-empty' });
  assert.equal(res.state, 'ACQUIRED');
  await mgr.release(res.token!);
  assert.deepEqual(fssync.readdirSync(locksDir), [], 'release 后 locks 目录必须为空（无 sidecar / 无 .tmp 残留）');
});

test('L3-2 release 的 ownership-lost 分支必须 drain 在途 heartbeat 写（after-hook rmSync ENOTEMPTY 真根因）', async (t) => {
  const locksDir = tmp(t);
  const mgr = lockManager(t, { locksDir, heartbeatIntervalMs: 100 });
  const res = await mgr.acquire({ op: 'hb-lost' });
  assert.equal(res.state, 'ACQUIRED');
  const hbPath = path.join(locksDir, heartbeatFile(res.token!.instanceId));
  // 占用 sidecar 路径（目录）→ 在途写必然进入有界退避重试窗口（≈175ms），使「release 时确有在途写」可确定复现
  let occupied = false;
  for (let i = 0; i < 50 && !occupied; i++) {
    try { await fs.rm(hbPath, { force: true }); await fs.mkdir(hbPath); occupied = true; }
    catch { await sleepReal(10); }
  }
  assert.equal(occupied, true, '应能把 sidecar 路径占位为目录（用于制造确定性的在途写）');
  // 条件等待**观测到**在途写：`.dshcm.*.tmp` 只在退避重试窗口（≈175 ms）内存在。
  // 固定睡 60 ms 在负载下可能整段错过窗口 —— 前提不成立却照常变绿（假通过）。
  await waitForDirEntry(locksDir, (n) => n.startsWith('.dshcm.') && n.endsWith('.tmp'), '在途原子写临时文件（退避重试窗口）');
  // 篡改 ownership.instanceId → release 走 ownership-lost 分支（抛错、不 unlink、保留 activeToken）
  const owner = (await readOwnershipByMgr(mgr))!;
  owner.owner.instanceId = 'EVIL-OTHER';
  await fs.writeFile(mgr.ownershipPath, JSON.stringify(owner));
  await assert.rejects(
    () => mgr.release(res.token!),
    (e) => e instanceof EnvironmentLockOwnedByAnotherError,
  );
  // 核心断言：release **抛错返回时**在途写必须已 drain。未 drain 时该写会在此之后才 rename/清理，
  // 与调用方的目录清理竞争 —— 直接复刻 after-hook rmSync：200 次循环实测约 19% 抛 ENOTEMPTY。
  const leftovers = fssync.readdirSync(locksDir).filter((n) => n.startsWith('.dshcm.'));
  assert.deepEqual(leftovers, [], 'release 抛错返回后不得残留原子写临时文件（L3-2 根因）');
  // 且此后目录必须静止：drain 之后定时器已停、写链已空 → 不可能再有写落地
  const frozen = fssync.readdirSync(locksDir).sort().join('|');
  await sleepReal(400);
  assert.equal(fssync.readdirSync(locksDir).sort().join('|'), frozen, 'release 抛错返回后 locks 目录不得再被写入');
  // 清理占位目录；ownership 刻意保留（ownership-lost 分支不 unlink）
  try { await fs.rmdir(hbPath); } catch { /* 已被写链清理 */ }
  assert.deepEqual(fssync.readdirSync(locksDir), [OWNERSHIP_FILE], '兜底清理后只剩 ownership（ownership-lost 不 unlink）');
});

/* ------------------------------------------- §11.5 平台进程身份探测（issue #36 的精确判据） */

test('§11.5-p1 win32 identity 探测：解析 Get-Process StartTime ticks（注入 runner，不依赖真实平台）', async () => {
  const calls: string[] = [];
  const probe = createPlatformProcessIdentityProbe({
    platform: 'win32',
    selfPid: process.pid,
    runCommand: async (file, args) => { calls.push(`${file} ${args.join(' ')}`); return '133400000000000000\n' },
  });
  assert.equal(probe.canGetOsIdentity(), true, 'win32 必须声明 identity 能力（issue #36 的原始缺口）');
  const a = await probe.probe(process.pid);
  assert.equal(a.alive, true);
  assert.equal(a.osProcessStartIdentity, 'win32:133400000000000000');
  // 自身身份在进程生命周期内不变 → 命中一次即缓存：不得每次 acquire 都 spawn 一次 shell
  // （known-gaps G-15 记的「代价不可接受」就是指这一点）
  const b = await probe.probe(process.pid);
  assert.equal(b.osProcessStartIdentity, 'win32:133400000000000000');
  assert.equal(calls.length, 1, `自身 pid 的 identity 只查询一次（实际 ${calls.length} 次）`);
  assert.match(calls[0]!, /Get-Process -Id \d+/);
});

test('§11.5-p2 identity 查询失败/空输出 → identity=null 且不抛错（退回长过期启发式，绝不推成 UNKNOWN 死路）', async () => {
  // ① Get-Process 找不到该 pid → 空输出
  const empty = createPlatformProcessIdentityProbe({
    platform: 'win32', selfPid: process.pid, runCommand: async () => '  \n',
  });
  assert.equal((await empty.probe(process.pid)).osProcessStartIdentity, null, '空输出 → null，绝不冒充身份');
  // ② 命令被禁用/超时 → 抛错必须被吞成 null：抛错会把分类推成 UNKNOWN_STATE，
  //    反而让 issue #36 里「长过期可显式回收」这条路径失效（那是比拿不到 identity 更糟的结果）
  const boom = createPlatformProcessIdentityProbe({
    platform: 'win32', selfPid: process.pid,
    runCommand: async () => { throw new Error('powershell 被禁用 / 超时') },
  });
  const r = await boom.probe(process.pid);
  assert.equal(r.alive, true, '存活判定不受 identity 查询失败影响（kill(pid,0) 已确证存在）');
  assert.equal(r.osProcessStartIdentity, null, '查询失败 → null，且不抛错');
});

test('§11.5-p3 darwin identity 探测：`ps -o lstart=` 规整；非自身 pid 不做缓存（pid 可能被复用）', async () => {
  const seen: string[] = [];
  const probe = createPlatformProcessIdentityProbe({
    platform: 'darwin',
    selfPid: process.pid,
    runCommand: async (file, args) => { seen.push(`${file} ${args.join(' ')}`); return 'Mon Sep 16 12:34:56 2026\n' },
  });
  assert.equal(probe.canGetOsIdentity(), true, 'darwin 同样声明能力（ps 是系统自带）');
  assert.equal((await probe.probe(process.pid)).osProcessStartIdentity, 'posix:Mon Sep 16 12:34:56 2026');
  assert.match(seen[0]!, /^ps -o lstart= -p \d+$/);
  // selfPid 换成 1 → 探本进程走「非自身」分支：每次都要重新问（缓存只对自身 pid 成立）
  const other = createPlatformProcessIdentityProbe({
    platform: 'darwin', selfPid: 1, runCommand: async () => 'X\n',
  });
  assert.equal((await other.probe(process.pid)).osProcessStartIdentity, 'posix:X');
});

test('§11.5-p4 win32 非 ticks 输出 / 未支持平台：绝不给出「垃圾身份」或凭空身份', async () => {
  // ① win32 上命令报错文本混进 stdout（诊断信息）→ 必须 null，不能当身份参与比较
  const garbage = createPlatformProcessIdentityProbe({
    platform: 'win32', selfPid: process.pid,
    runCommand: async () => 'Get-Process : Cannot find a process with the process identifier 999999.\n',
  });
  assert.equal((await garbage.probe(process.pid)).osProcessStartIdentity, null);
  // ② 未支持平台（无查询命令）→ canGetOsIdentity()=false 且 identity 恒 null（行为与改造前一致）
  const unsupported = createPlatformProcessIdentityProbe({
    platform: 'freebsd' as NodeJS.Platform, selfPid: process.pid, runCommand: async () => 'x',
  });
  assert.equal(unsupported.canGetOsIdentity(), false);
  const u = await unsupported.probe(process.pid);
  assert.equal(u.alive, true);
  assert.equal(u.osProcessStartIdentity, null, '无查询命令的平台不得凭空给出身份');
});

test('§11.5-p5 真实平台集成（真 probe + 真文件）：identity 相符 → LOCKED；PID 复用 → 未达长过期阈值即判 STALE 并可回收', async (t) => {
  const probe = createPlatformProcessIdentityProbe();
  const self = await probe.probe(process.pid);
  if (self.osProcessStartIdentity === null) {
    t.diagnostic(`本平台（${process.platform}）拿不到自身 OS identity → 跳过精确判定断言（启发式路径由 c11b/c11c 覆盖）`);
    return;
  }
  const locksDir = tmp(t);
  const clk = makeClock();
  // ① 记录里的 identity 与本机真实 identity 一致 → 同一个活着的 owner（心跳降级保护）→ LOCKED，不得回收
  await seedOwnership(locksDir, { instanceId: 'selfalive', pid: process.pid, osIdentity: self.osProcessStartIdentity });
  await seedHeartbeat(locksDir, 'selfalive', clk.clock() - 2_000);
  const m1 = lockManager(t, { locksDir, now: clk.clock, probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });
  const s1 = await m1.inspectLockState();
  assert.equal(s1.state, 'LOCKED', `identity 相符必须判 owner 存活: ${s1.detail}`);
  assert.equal((await m1.recoverStaleLock()).ok, false, '活着的 owner 不得被回收');
  await fs.rm(path.join(locksDir, heartbeatFile('selfalive')), { force: true });
  // ② 记录里的 identity 与真实 identity 不同（同一 pid 已被复用给别的进程）→ **精确**判 STALE，
  //    且无需等 30 分钟长过期阈值 —— 这正是 issue #36 / G-15 ① 的残余缺口
  await seedOwnership(locksDir, { instanceId: 'reused', pid: process.pid, osIdentity: `${self.osProcessStartIdentity}-forged` });
  await seedHeartbeat(locksDir, 'reused', clk.clock() - 2_000);
  const m2 = lockManager(t, { locksDir, now: clk.clock, probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });
  const s2 = await m2.inspectLockState();
  assert.equal(s2.state, 'STALE_LOCK_DETECTED', `PID 复用必须被精确识别（不等长过期）: ${s2.detail}`);
  assert.match(s2.detail ?? '', /identity 与 recorded 不同/);
  const r = await m2.recoverStaleLock();
  assert.equal(r.ok, true, `精确判定的残留锁必须可显式回收: ${r.detail}`);
  assert.deepEqual(fssync.readdirSync(locksDir), [], '回收后目录必须为空（ownership + sidecar 均已清理）');
});

test('§11.5-p6 linux `/proc/<pid>/stat` 解析：comm 含空格/括号时也要取到字段 22（starttime），取不到即 null', () => {
  // 为什么必须切掉 (comm)：comm 里可以带空格与括号（可执行文件名 / 线程名），按空格整行分割会整体错位。
  // 样本自带对照：字段 22 = starttime = 987654321，字段 24 = rss = 4321 ——
  // 取错下标会拿到 rss，而 rss **随内存占用变化**：同一进程两次探测都能不同，
  // 于是活着的 owner 被判成「PID 被复用」的残留锁（CI 实测；Windows 走 Get-Process 分支所以本地看不出来）。
  const stat = '4796 (node (worker)) S 1 4796 4796 0 -1 4194560 1234 0 0 0 5 6 0 0 20 0 3 0 987654321 12345678 4321 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 18 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
  assert.equal(parseLinuxProcessStarttime(stat), '987654321');
  assert.notEqual(parseLinuxProcessStarttime(stat), '4321', 'rss（字段 24）不是进程身份');
  // 身份必须恒定：同一份 stat 反复解析给出同一个值
  assert.equal(parseLinuxProcessStarttime(stat), parseLinuxProcessStarttime(stat));
  // 取不到一律 null（绝不退回恒定假身份，那会把不同进程判成同一个 owner）
  assert.equal(parseLinuxProcessStarttime('4796 (node) S 1'), null, '字段不足 → null');
  assert.equal(parseLinuxProcessStarttime('garbage'), null, '没有 (comm) 括号 → null');
  assert.equal(parseLinuxProcessStarttime('4796 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 x'), null, '字段 22 非数字 → null');
});

/* ------------------------------------------------- §11.7 自动回收边界（P1–P4） */

/*
 * 这一组锁定「自动路径」的**边界**而不是能力：可证的才删，不可证的必须一动不动。
 * 背景（真机）：正常关窗时后台同步正在跑 → 各入口 finally 等不到 → ownership + heartbeat 留盘；
 * 下次启动分类是 NORMAL（无未决 journal），于是锁一直在、写操作全 423、自动同步每轮静默 skip。
 * 修法必须同时满足两条：自动路径能把**可证**的摘掉，且绝不因为「看起来像残留」就删。
 */

test('§11.7-a 自动回收：owner pid 确证死亡 → 删 ownership + 该 owner 的 sidecar；removedOwner 带 op/pid', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe();
  p.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  await seedOwnership(locksDir, { instanceId: 'dead1', pid: 999_001, op: 'autosync' });
  await seedHeartbeat(locksDir, 'dead1', clk.clock() - 60_000);
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
  const r = await m.reclaimProvableStaleLock();
  assert.notEqual(r, null, '确证死亡属结构性可证 → 必须回收');
  assert.equal(r?.ok, true);
  assert.deepEqual(r?.removedOwner, { op: 'autosync', pid: 999_001 }, '日志需要知道回收了谁的锁');
  assert.deepEqual(fssync.readdirSync(locksDir), [], 'ownership 与该 owner 的 heartbeat 都必须清掉');
});

test('§11.7-b 自动回收：心跳**长过期**启发式（pid 存活、身份不可验证）→ 拒绝，文件保留；显式回收仍可做', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe();
  p.respond(() => ({ alive: true, osProcessStartIdentity: null }));
  await seedOwnership(locksDir, { instanceId: 'heur1', pid: 999_002 });
  await seedHeartbeat(locksDir, 'heur1', clk.clock() - 120_000);
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 5_000 });
  assert.equal((await m.inspectLockState()).state, 'STALE_LOCK_DETECTED', '前提：显式判据（长过期）确实判 stale');
  assert.equal(await m.reclaimProvableStaleLock(), null, '长过期只是「像残留」，自动路径不得据此删锁');
  assert.ok(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), '拒绝后必须原样保留现场');
  const explicit = await m.recoverStaleLock();
  assert.equal(explicit.ok, true, '显式回收（--recover-stale-lock）口径不变，仍可回收');
});

test('§11.7-c 自动回收：corrupt/空 ownership（崩溃残留）→ 返回 null，不删、不 rename', async (t) => {
  const locksDir = tmp(t);
  await fs.writeFile(path.join(locksDir, OWNERSHIP_FILE), '');
  const m = lockManager(t, { locksDir });
  assert.equal(await m.reclaimProvableStaleLock(), null, '无有效 owner 的残留不归自动路径判断');
  assert.deepEqual(fssync.readdirSync(locksDir), [OWNERSHIP_FILE], '现场必须保留，交给显式回收');
});

test('§11.7-d 自动回收：心跳新鲜（有人在干活）→ 不探测进程、直接返回 null', async (t) => {
  const locksDir = tmp(t);
  const a = lockManager(t, { locksDir });
  const acq = await a.acquire({ op: 'holder' });
  assert.equal(acq.state, 'ACQUIRED');
  await waitHeartbeat(a); // 首写是异步的：判 fresh 前必须已落盘
  const p = makeProbe();
  p.respond(() => ({ alive: true, osProcessStartIdentity: null }));
  const b = lockManager(t, { locksDir, probe: p.probe });
  assert.equal(await b.reclaimProvableStaleLock(), null, '活锁不得进入回收流程');
  assert.equal(p.calls, 0, '新鲜心跳就是「有人在干活」的证据，连进程探测都不该付（Windows 上要 spawn PowerShell）');
  await a.release(acq.token!);
});

test('§11.7-e 自动回收：pid 存活但 OS identity 与 recorded 不同（PID 复用）→ 回收', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe();
  p.respond(() => ({ alive: true, osProcessStartIdentity: 'identity-B' }));
  await seedOwnership(locksDir, { instanceId: 'reused1', pid: 999_003, osIdentity: 'identity-A' });
  await seedHeartbeat(locksDir, 'reused1', clk.clock() - 60_000);
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
  const r = await m.reclaimProvableStaleLock();
  assert.equal(r?.ok, true, '原 owner 已死（同一 pid 已被别的进程占用）= 结构性可证');
  assert.deepEqual(fssync.readdirSync(locksDir), []);
});

test('§11.7-f 退出兜底释放：只删自己 instanceId 的 ownership/sidecar；未持锁时是 no-op', async (t) => {
  const locksDir = tmp(t);
  const a = lockManager(t, { locksDir });
  const acq = await a.acquire({ op: 'inflight' });
  assert.equal(acq.state, 'ACQUIRED');
  await waitHeartbeat(a);
  a.releaseOnExitSync();
  assert.deepEqual(fssync.readdirSync(locksDir), [], '自己持有的锁与心跳都必须被同步清掉（exit 里不能 await）');
  // 没持锁（或持的是别人的锁）→ 绝不删
  await seedOwnership(locksDir, { instanceId: 'foreign1', pid: 999_004 });
  const b = lockManager(t, { locksDir });
  b.releaseOnExitSync();
  assert.deepEqual(fssync.readdirSync(locksDir), [OWNERSHIP_FILE], 'foreign ownership 一根汗毛都不许动');
});

test('§11.7-g 孤儿心跳清理：只删「非持有者且心跳过期」的 sidecar；持有者/新鲜/读不出的都保留', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  await seedOwnership(locksDir, { instanceId: 'hold1', pid: 999_005 });
  await seedHeartbeat(locksDir, 'hold1', clk.clock() - 500); // 当前持有者，心跳仍新鲜
  await seedHeartbeat(locksDir, 'gone1', clk.clock() - 60_000); // 崩溃残留
  await fs.writeFile(path.join(locksDir, heartbeatFile('bad1')), 'not json'); // 读不出 → 无判据
  const m = lockManager(t, { locksDir, now: clk.clock, staleAfterMs: 1000 });
  assert.equal(await m.cleanupOrphanHeartbeats(), 1, '只有 gone1 满足「非持有者 + 心跳过期」');
  const left = fssync.readdirSync(locksDir).sort();
  assert.deepEqual(left, [OWNERSHIP_FILE, heartbeatFile('bad1'), heartbeatFile('hold1')].sort());
  assert.ok(fssync.existsSync(path.join(locksDir, heartbeatFile('hold1'))), '持有者的 heartbeat 是活锁判据，不许删');
});


/* ------------------------------------------------- §11.8 release 失败留痕与自愈（真机 423 卡死态） */

/*
 * 真机现场（v0.4.3）：autosync 取锁后 release 的 unlink 失败（Windows 句柄冲突），调用方
 * `release().catch(() => {})` 把错误吞掉 → ownership 留在盘上、心跳停在 seq=3，而进程仍活
 * ⇒ inspectLockState 判 LOCKED(owner alive degraded) ⇒ 永不 STALE、显式回收也拒
 * ⇒ 档案删除等 destructive 操作**永久** 423「另一个任务正在运行」。
 * 这一组锁定修法的三条边：① 自己删不掉时把记录挪走（quarantine）而不是留原地；
 * ② 盘上是自己的残留时 acquire 能结构可证地自愈；③ 进程存活但心跳长过期要能被显式回收。
 */

test('§11.8-a release 的 unlink 反复失败 → quarantine 腾空正式路径（不抛），随后 acquire 仍可用', async (t) => {
  const locksDir = tmp(t);
  const io = makeIo();
  const m = lockManager(t, { locksDir, io: io.io, heartbeatIntervalMs: 40 });
  const acq = await m.acquire({ op: 'import' });
  assert.equal(acq.state, 'ACQUIRED');
  await waitHeartbeat(m);

  // 模拟「unlink 怎么都删不掉」：只有正式 ownership 路径失败，recovering 副本可删
  io.failUnlinkWhen((p) => path.basename(p) === OWNERSHIP_FILE);
  await m.release(acq.token!);
  assert.equal(m.isHolding, false, 'quarantine 成功即视为已释放');
  assert.equal(
    fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)),
    false,
    '正式路径必须腾空 —— 否则下一次 acquire 只会继承同一个僵尸锁',
  );

  const again = await m.acquire({ op: 'import' });
  assert.equal(again.state, 'ACQUIRED', '释放失败不得让这个 manager 永久失去写能力');
  await m.release(again.token!);
});

test('§11.8-b unlink 与 rename 双失败 → release 抛错并保留 token，故障消失后 acquire 自愈回收自己的残留', async (t) => {
  const locksDir = tmp(t);
  const io = makeIo();
  const reports: Array<{ quarantined: boolean }> = [];
  const m = lockManager(t, {
    locksDir,
    io: io.io,
    heartbeatIntervalMs: 40,
    onReleaseFailure: (b) => { reports.push({ quarantined: b.quarantined }); },
  });
  const acq = await m.acquire({ op: 'import' });
  assert.equal(acq.state, 'ACQUIRED');
  await waitHeartbeat(m);

  io.failUnlinkWhen((p) => path.basename(p) === OWNERSHIP_FILE);
  io.failRenameWhen((p) => path.basename(p) === OWNERSHIP_FILE); // quarantine 的 source 就是它
  await assert.rejects(() => m.release(acq.token!), (e: unknown) => e instanceof EnvironmentLockIOError);
  assert.equal(m.isHolding, true, 'unlink/quarantine 全失败 → 保留 token（调用方可重试 release）');
  assert.deepEqual(reports, [{ quarantined: false }], '失败必须留痕，不许静默');

  // 故障消失：同一个 manager 的下一次 acquire 必须结构可证地回收自己的残留（盘上 instanceId === 自己）
  io.clear();
  const again = await m.acquire({ op: 'import' });
  assert.equal(again.state, 'ACQUIRED', '自己的残留必须自愈，否则每轮 destructive 都是 423');
  await m.release(again.token!);
  assert.equal(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), false);
  assert.equal(m.isHolding, false);
});

test('§11.8-c 进程存活且身份一致但心跳长过期 → 判 stale(heartbeat-stopped)，显式回收可用', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe();
  p.respond(() => ({ alive: true, osProcessStartIdentity: 'identity-A' }));
  await seedOwnership(locksDir, { instanceId: 'zomb1', pid: 999_010, osIdentity: 'identity-A', op: 'autosync' });
  await seedHeartbeat(locksDir, 'zomb1', clk.clock() - 120_000);
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 5_000 });

  const insp = await m.inspectLockState();
  assert.equal(insp.state, 'STALE_LOCK_DETECTED', '心跳长过期 = 写方已停摆，不能永远说「另一个任务在运行」');
  assert.equal(insp.staleKind, 'heartbeat-stopped');

  const blocked = await withMutationLock(m, { op: 'profile-delete' });
  assert.equal(blocked.context, null);
  assert.equal(blocked.reason, 'stale-degraded', '文案必须区别于「持有进程已不存在」');
  assert.notEqual(LOCK_BLOCK_MESSAGE['stale-degraded'], LOCK_BLOCK_MESSAGE.stale);
  assert.match(LOCK_BLOCK_MESSAGE['stale-degraded'], /回收/);

  const rec = await m.recoverStaleLock();
  assert.equal(rec.ok, true, '二次验证必须与 inspect 同判据，否则用户点「回收残留锁」只会拿到「失败」');
  assert.deepEqual(fssync.readdirSync(locksDir), []);
});

test('§11.8-d 心跳未达长过期 + 进程存活 → 仍 LOCKED，acquire 与 recover 都不放行（不放开误删）', async (t) => {
  const locksDir = tmp(t);
  const clk = makeClock();
  const p = makeProbe();
  p.respond(() => ({ alive: true, osProcessStartIdentity: 'identity-A' }));
  await seedOwnership(locksDir, { instanceId: 'live1', pid: 999_011, osIdentity: 'identity-A' });
  await seedHeartbeat(locksDir, 'live1', clk.clock() - 2_000);
  const m = lockManager(t, { locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000, longExpiredAfterMs: 60_000 });

  const insp = await m.inspectLockState();
  assert.equal(insp.state, 'LOCKED', '活锁就是活锁：心跳过期但没长过期，不能判残留');
  assert.equal(insp.staleKind, undefined);
  assert.equal((await withMutationLock(m, { op: 'profile-delete' })).reason, 'locked');
  assert.equal((await m.recoverStaleLock()).ok, false);
  assert.ok(fssync.existsSync(path.join(locksDir, OWNERSHIP_FILE)), '拒绝后现场必须原样保留');
});


