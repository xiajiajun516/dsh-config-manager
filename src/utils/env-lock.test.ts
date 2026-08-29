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
 * 只测试，不修改实现。若某用例暴露实现 bug，以诊断注释记录 interleaving，供 Lead 修复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCli } from '../cli/index.ts';
import {
  EnvironmentLockManager,
  EnvironmentLockIOError,
  EnvironmentLockOwnedByAnotherError,
  EnvironmentLockUnavailableError,
  runWithMutationLock,
  withMutationLock,
  LOCK_SCHEMA_VERSION,
  OWNERSHIP_FILE,
  HEARTBEAT_PREFIX,
  RECOVERING_PREFIX,
  type LockOwnershipRecord,
  type ProcessIdentityProbe,
} from './env-lock.ts';

/* ---------------------------------------------------------------- 工具 */

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
/** env-lock.ts 绝对路径（子进程动态 import 用 file:// URL） */
const ENV_LOCK_ABS = path.resolve(here, 'env-lock.ts');

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'env-lock-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
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

/** 等待某 instanceId 的 heartbeat sidecar 落盘（acquire 后首写为异步，需等待才能确保 inspect 判 fresh） */
async function waitHeartbeat(locksDir: string, instanceId: string): Promise<void> {
  const p = path.join(locksDir, heartbeatFile(instanceId));
  const t0 = Date.now();
  while (!fssync.existsSync(p)) {
    if (Date.now() - t0 > 4000) throw new Error(`heartbeat sidecar 未在预期时间内落盘: ${p}`);
    await sleepReal(20);
  }
}

/** 注入面包装的真实 IO（基于 node:fs/promises），支持按路径故障注入 + rename 后钩子 */
function makeIo(): {
  io: import('./env-lock.ts').EnvLockIo;
  failOpenWhen(p: (p: string) => boolean, code?: string): void;
  failUnlinkWhen(p: (p: string) => boolean): void;
  failReadWhen(p: (p: string) => boolean): void;
  hookRename(fn: (a: string, b: string) => void | Promise<void>): void;
  clear(): void;
} {
  const openFaults: Array<{ p: (p: string) => boolean; code?: string }> = [];
  const unlinkFaults: Array<(p: string) => boolean> = [];
  const readFaults: Array<(p: string) => boolean> = [];
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
    async rename(a, b) { await fs.rename(a, b); for (const h of renameHooks) await h(a, b); },
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
    hookRename(fn) { renameHooks.push(fn); },
    clear() { openFaults.length = 0; unlinkFaults.length = 0; readFaults.length = 0; },
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

function childHeader(): string {
  return `import { pathToFileURL } from 'node:url';
const { EnvironmentLockManager } = await import(pathToFileURL(process.env.LOCK_ABS).href);
`;
}

/* ================================================================ Design §11 */

test('§11.1-c1 `open(wx)` 独占创建：并发 acquire 只有一个成功（多 manager 同目录）', async (t) => {
  const locksDir = tmp(t);
  const n = 6;
  const mgrs = Array.from({ length: n }, () => new EnvironmentLockManager({ locksDir }));
  const results = await Promise.all(mgrs.map((m) => m.acquire({ op: 'concurrent' })));
  const winners = results.filter((r) => r.state === 'ACQUIRED');
  assert.equal(winners.length, 1, `必须恰好一个 ACQUIRED，实际 ${results.map((r) => r.state).join(',')}`);
  const losers = results.filter((r) => r.state !== 'ACQUIRED');
  assert.equal(losers.length, n - 1);
  // 唯一持有者释放后可再 acquire
  await mgrs[results.findIndex((r) => r.state === 'ACQUIRED')]!.release(winners[0]!.token!);
  const againMgr = new EnvironmentLockManager({ locksDir });
  const again = await againMgr.acquire({ op: 're' });
  assert.equal(again.state, 'ACQUIRED');
  await againMgr.release(again.token!);
});

test('§11.1-c2 不存在 exists→write 竞态：并发双 acquire 至少失败其一', async (t) => {
  const locksDir = tmp(t);
  const a = new EnvironmentLockManager({ locksDir });
  const b = new EnvironmentLockManager({ locksDir });
  const [ra, rb] = await Promise.all([a.acquire({ op: 'x' }), b.acquire({ op: 'y' })]);
  assert.notEqual(ra.state === 'ACQUIRED', rb.state === 'ACQUIRED', '双 acquire 不能同时成功（源码无 exists→write）');
  const winner = ra.state === 'ACQUIRED' ? a : b;
  const token = ra.state === 'ACQUIRED' ? ra.token! : rb.token!;
  await winner.release(token);
});

test('§11.1-c3 持句柄 = 持锁（child process）：父 acquire 后，child 同 locksDir acquire → 失败', async (t) => {
  const dir = tmp(t);
  const locksDir = path.join(dir, 'locks');
  const parent = new EnvironmentLockManager({ locksDir });
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

test('§11.1-c4 release：close→unlink；unlink 失败抛 EnvironmentLockIOError 且保留 activeToken（可重试）', async (t) => {
  const locksDir = tmp(t);
  const ctl = makeIo();
  const mgr = new EnvironmentLockManager({ locksDir, io: ctl.io });
  const res = await mgr.acquire({ op: 'u' });
  assert.equal(res.state, 'ACQUIRED');
  const token = res.token!;
  // 注入 unlink(environment.lock) 失败
  ctl.failUnlinkWhen((p) => p === mgr.ownershipPath);
  await assert.rejects(
    () => mgr.release(token),
    (e) => e instanceof EnvironmentLockIOError,
  );
  assert.equal(mgr.isHolding, true, 'unlink 失败后必须保留 activeToken（可重试，不卡死磁盘锁）');
  assert.ok(fssync.existsSync(mgr.ownershipPath), '锁文件仍在磁盘（未被误删）');
  // 恢复后重试 release 成功
  ctl.clear();
  await mgr.release(token);
  assert.equal(mgr.isHolding, false);
  assert.equal(fssync.existsSync(mgr.ownershipPath), false, 'release 后 ownership 被删除');
});

test('§11.1-c5 owner metadata 写入/读回一致', async (t) => {
  const locksDir = tmp(t);
  const mgr = new EnvironmentLockManager({
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

test('§11.1-c6 heartbeat sidecar 更新不替换 environment.lock（inode/内容不变）', async (t) => {
  const locksDir = tmp(t);
  const ctl = makeIo();
  const mgr = new EnvironmentLockManager({ locksDir, io: ctl.io, heartbeatIntervalMs: 50 });
  const res = await mgr.acquire({ op: 'hb' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  // 等待首个 heartbeat sidecar 落盘
  let sawSb = false;
  for (let i = 0; i < 100; i++) {
    const files = await mgr.listLockFiles();
    if (files.some((n) => n === heartbeatFile(id))) { sawSb = true; break; }
    await sleepReal(20);
  }
  assert.ok(sawSb, 'heartbeat sidecar 应已创建');
  const ownerCtl = ctl.io; // real fs
  const beforeText = await readText(path.join(locksDir, OWNERSHIP_FILE));
  // 等若干心跳周期（≥3 tick），期间只更新 sidecar
  const hbPath = path.join(locksDir, heartbeatFile(id));
  const seqProbe: number[] = [];
  for (let i = 0; i < 3; i++) {
    await sleepReal(70);
    seqProbe.push(JSON.parse(await readText(hbPath)).seq as number);
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
  assert.ok(seqProbe[seqProbe.length - 1]! > seqProbe[0]!, `heartbeat seq 应递增: ${seqProbe.join(',')}`);
  // heartbeat sidecar 内容绑定 ownerInstanceId
  const hb = JSON.parse(await readText(hbPath)) as { ownerInstanceId: string };
  assert.equal(hb.ownerInstanceId, id);
  await mgr.release(res.token!);
});

test('§11.1-c7 old heartbeat sidecar 不影响新 owner（不同 instanceId 文件名隔离）', async (t) => {
  const locksDir = tmp(t);
  // A 持有并释放；期间人为残留一个其它 owner 的 heartbeat
  const a = new EnvironmentLockManager({ locksDir });
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
  const b = new EnvironmentLockManager({ locksDir });
  const rb = await b.acquire({ op: 'b' });
  const idB = rb.token!.instanceId;
  assert.notEqual(idB, idA);
  // 模拟 B 的锁 + 新鲜 heartbeat：inspect 只依据 B 自己的 sidecar，忽略 foreign 残留
  await waitHeartbeat(locksDir, idB); // 等首写 heartbeat 落盘，避免异步 race 误判 expired
  const insp = await b.inspectLockState();
  assert.equal(insp.state, 'LOCKED', 'fresh heartbeat（新 owner 自己的 sidecar）→ LOCKED，不受旧的 foreign heartbeat 影响');
  await b.release(rb.token!);
});

test('§11.1-c8 release instanceId mismatch → 抛 EnvironmentLockOwnedByAnotherError + 不 unlink', async (t) => {
  const locksDir = tmp(t);
  const mgr = new EnvironmentLockManager({ locksDir });
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
  const mgr = new EnvironmentLockManager({ locksDir, io: ctl.io, now: clk.clock, heartbeatIntervalMs: 60 });
  const res = await mgr.acquire({ op: 'lease' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  const hbPath = path.join(locksDir, heartbeatFile(id));
  // 等待首写
  for (let i = 0; i < 100; i++) { if (fssync.existsSync(hbPath)) break; await sleepReal(20); }
  const first = JSON.parse(await readText(hbPath)) as { heartbeatAt: number; seq: number };
  assert.equal(first.heartbeatAt, clk.clock(), '首写 heartbeatAt 使用注入时钟');
  // 推进时钟 + 等待若干 tick → heartbeatAt 跟随推进后的时钟（续期）
  clk.advance(5000);
  await sleepReal(250);
  const last = JSON.parse(await readText(hbPath)) as { heartbeatAt: number; seq: number };
  assert.ok(last.seq > first.seq, '续期后 seq 递增');
  assert.ok(last.heartbeatAt >= clk.clock() - 60, '续期 heartbeatAt 反映推进后的时钟');
  await mgr.release(res.token!);
});

test('§11.1-c10 heartbeat write failure → degraded 标记 + 不中断 + 无自动删除', async (t) => {
  const locksDir = tmp(t);
  const failures: unknown[] = [];
  const ctl = makeIo();
  const mgr = new EnvironmentLockManager({
    locksDir,
    io: ctl.io,
    heartbeatIntervalMs: 300,
    onHeartbeatWriteFailure: (e) => failures.push(e),
  });
  const res = await mgr.acquire({ op: 'hb-fail' });
  assert.equal(res.state, 'ACQUIRED');
  const id = res.token!.instanceId;
  const hbPath = path.join(locksDir, heartbeatFile(id));
  // 等待首写落盘
  for (let i = 0; i < 100; i++) { if (fssync.existsSync(hbPath)) break; await sleepReal(20); }
  // 用同路径目录替换 sidecar → 下一次 atomicWriteFile 的 rename 失败（sidecar 更新失败）
  await fs.rm(hbPath, { force: true });
  await fs.mkdir(hbPath);
  const ownerBefore = await readText(path.join(locksDir, OWNERSHIP_FILE));
  await sleepReal(900); // 覆盖一个心跳周期 + atomicWriteFile 重试窗口
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
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
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
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'STALE_LOCK_DETECTED');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('dead')), { force: true });
  }
  // expired + PID 存活 + identity 不同 → STALE（PID reuse）
  {
    await seedOwnership(locksDir, { instanceId: 'reuse', pid: 3333, osIdentity: 'osOld' });
    await seedHeartbeat(locksDir, 'reuse', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => ({ alive: true, osProcessStartIdentity: 'osNew' }));
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'STALE_LOCK_DETECTED', 'PID reuse → STALE');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('reuse')), { force: true });
  }
  // expired + PID 存活 + identity 相同 → LOCKED（owner alive / heartbeat degraded）
  {
    await seedOwnership(locksDir, { instanceId: 'alive', pid: 4444, osIdentity: 'osSame' });
    await seedHeartbeat(locksDir, 'alive', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => ({ alive: true, osProcessStartIdentity: 'osSame' }));
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'LOCKED', 'alive + identity 同 → LOCKED');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('alive')), { force: true });
  }
  // probe 失败 / 无法确定 → UNKNOWN_STATE
  {
    await seedOwnership(locksDir, { instanceId: 'unk', pid: 5555, osIdentity: 'osU' });
    await seedHeartbeat(locksDir, 'unk', clk.clock() - 2000);
    const p = makeProbe(); p.respond(() => { throw new Error('probe unavailable'); });
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'UNKNOWN_STATE', 'probe 失败 → UNKNOWN_STATE');
    await fs.rm(path.join(locksDir, OWNERSHIP_FILE), { force: true });
    await fs.rm(path.join(locksDir, heartbeatFile('unk')), { force: true });
  }
  // OS identity 缺失（capability 或值缺失）且 PID 存活 → UNKNOWN_STATE（保守拒删）
  {
    await seedOwnership(locksDir, { instanceId: 'c', pid: 6666, osIdentity: null });
    await seedHeartbeat(locksDir, 'c', clk.clock() - 2000);
    const p = makeProbe(); p.canOs(false); p.respond(() => ({ alive: true, osProcessStartIdentity: null }));
    const m = new EnvironmentLockManager({ locksDir, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
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
    const m = new EnvironmentLockManager({ locksDir, io: ctl.io, now: clk.clock, probe: p.probe, staleAfterMs: 1000 });
    assert.equal((await m.inspectLockState()).state, 'UNKNOWN_STATE', 'heartbeat 读失败 → UNKNOWN_STATE');
  }
});

test('§11.1-c12 definitely stale → acquire 返回 STALE_LOCK_DETECTED（不自动删除）', async (t) => {
  const locksDir = tmp(t);
  await seedOwnership(locksDir, { instanceId: 'dead2', pid: 8888 });
  await seedHeartbeat(locksDir, 'dead2', Date.now() - 20_000);
  const p = makeProbe(); p.respond(() => ({ alive: false, osProcessStartIdentity: null }));
  const m = new EnvironmentLockManager({ locksDir, probe: p.probe, staleAfterMs: 10_000 });
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
  const a = new EnvironmentLockManager({ locksDir, probe: pA.probe, staleAfterMs: 10_000 });
  const b = new EnvironmentLockManager({ locksDir, probe: pB.probe, staleAfterMs: 10_000 });
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
  const m = new EnvironmentLockManager({ locksDir, io: ctl.io, probe: p.probe, staleAfterMs: 10_000 });
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
await new Promise(r => setTimeout(r, 300)); // 让首次（过期的）heartbeat 落盘
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
  const insp = await new EnvironmentLockManager({ locksDir, staleAfterMs: 10_000 }).inspectLockState();
  assert.equal(insp.state, 'STALE_LOCK_DETECTED');
  // 显式 recover 成功
  const rec = await new EnvironmentLockManager({ locksDir, staleAfterMs: 10_000 }).recoverStaleLock();
  assert.equal(rec.ok, true);
  assert.equal(rec.removed, true);
  // 回收后可重新 acquire
  const again = await new EnvironmentLockManager({ locksDir, staleAfterMs: 10_000 }).acquire({ op: 'post' });
  assert.equal(again.state, 'ACQUIRED');
  await new EnvironmentLockManager({ locksDir }).release(again.token!);
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
await new Promise(r => setTimeout(r, 2500));
await mgrA.release(res.token);
console.log('RELEASED');
process.exit(0);
`;
  const file = path.join(dir, 'child17.mjs');
  await fs.writeFile(file, childScript);
  const h = spawnNode(childScript, file, { LOCKS_DIR: locksDir });
  await waitForSub(() => h.getStdout(), 'HELD');
  // B（父进程同目录）acquire 被拒
  const b = new EnvironmentLockManager({ locksDir });
  const rb = await b.acquire({ op: 'B' });
  assert.notEqual(rb.state, 'ACQUIRED', 'A 持锁期间 B 不得获得锁');
  // 等 A release
  await waitForSub(() => h.getStdout(), 'RELEASED');
  assert.equal(await h.exit, 0);
  // B 再 acquire 成功
  const rb2 = await b.acquire({ op: 'B2' });
  assert.equal(rb2.state, 'ACQUIRED');
  await b.release(rb2.token!);
});

test('§11.1-c18 Windows close→unlink 语义（本机实跑：release 后无句柄占用、可再次 acquire）', async (t) => {
  const locksDir = tmp(t);
  const mgr = new EnvironmentLockManager({ locksDir });
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
  const mgr = new EnvironmentLockManager({ locksDir });
  const r1 = await mgr.acquire({ op: 'import' });
  assert.equal(r1.state, 'ACQUIRED');
  // 同一 manager、同一 instanceId，再次 acquire 必须被拒（operation-scoped，禁止 process-level reentrant）
  await waitHeartbeat(locksDir, r1.token!.instanceId); // 等首写 heartbeat 落盘，确保 EEXIST→inspect 判 fresh→LOCKED（确定性）
  const r2 = await mgr.acquire({ op: 'restore' });
  assert.notEqual(r2.state, 'ACQUIRED', '同 manager 并发 acquire 不得 reentrant 放行');
  assert.equal(r2.state, 'LOCKED', '已有活跃持有（无 parent token）→ LOCKED 被挡');
  assert.equal(mgr.isHolding, true, '首个 token 仍持有');
  await mgr.release(r1.token!);
  assert.equal(mgr.isHolding, false);
});

test('§11.1-c20 nested rollback token 传递：withMutationLock 收到有效 parentContext → 复用不 reacquire，release 不释放父 token', async (t) => {
  const locksDir = tmp(t);
  const lock = new EnvironmentLockManager({ locksDir });
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
  const a = new EnvironmentLockManager({ locksDir });
  const b = new EnvironmentLockManager({ locksDir });
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
  const lock = new EnvironmentLockManager({ locksDir });
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
  const lock = new EnvironmentLockManager({ locksDir });
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
    const m = new EnvironmentLockManager({ locksDir, io: ctl.io });
    const res = await m.acquire({ op: 'perm' });
    assert.equal(res.state, 'PERMISSION_ERROR', 'EPERM 无既有锁 → PERMISSION_ERROR，不得误报 LOCKED');
  }
  // EACCES：无既有 lock → PERMISSION_ERROR
  {
    const locksDir = tmp(t);
    const ctl = makeIo();
    ctl.failOpenWhen((p) => p.endsWith(OWNERSHIP_FILE), 'EACCES');
    const m = new EnvironmentLockManager({ locksDir, io: ctl.io });
    const res = await m.acquire({ op: 'acc' });
    assert.equal(res.state, 'PERMISSION_ERROR');
  }
  // 通用 IO 错误（无 EEXIST/EPERM）→ LOCK_IO_ERROR
  {
    const locksDir = tmp(t);
    const ctl = makeIo();
    ctl.failOpenWhen((p) => p.endsWith(OWNERSHIP_FILE)); // 无 code
    const m = new EnvironmentLockManager({ locksDir, io: ctl.io });
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
  const m = new EnvironmentLockManager({ locksDir, io: ctl.io, probe: p.probe, staleAfterMs: 10_000 });
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
    const holder = new EnvironmentLockManager({ locksDir });
    const rh = await holder.acquire({ op: 'hold' });
    const other = new EnvironmentLockManager({ locksDir });
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
