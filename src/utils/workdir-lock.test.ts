/**
 * 工作副本锁单测（src/utils/workdir-lock.ts；sync 与 market 共用）。
 *
 * 背景（真机 incident 2026-10-23）：自动同步与 GUI 只读路由（/sync/snapshots-list 等）
 * 各自驱动同一个 sync/work，两个 `git pull --ff-only` 并发把 FETCH_HEAD 写成多行 for-merge，
 * pull 自己 fatal → intent journal 判「不可证明」→ durable SAFE MODE。
 * 这组测试锁住互斥、跨「进程」（用预先存在的锁文件模拟另一个持有者）、陈旧回收与异常释放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_WORKDIR_LOCK_STALE_MS,
  WorkdirLockError,
  pruneDeadWorkdirLocksOnce,
  resetWorkdirLockChainsForTest,
  withWorkdirLock,
  workdirLockHolderAlive,
  workdirLockPath,
} from './workdir-lock.ts';

async function makeDir(t: test.TestContext): Promise<string> {
  resetWorkdirLockChainsForTest();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-wlock-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(workdirLockPath(dir), { force: true });
  });
  return dir;
}

const fastSleep = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 1)); };

test('同一工作副本：并发调用串行执行（永不重叠）', async (t) => {
  const dir = await makeDir(t);
  let active = 0;
  let maxActive = 0;
  const run = (): Promise<string> => withWorkdirLock(dir, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return 'ok';
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.equal(maxActive, 1, '同一工作副本的临界区绝不能并发');
});

test('不同工作副本：互不阻塞（锁按目录隔离）', async (t) => {
  const a = await makeDir(t);
  const b = await makeDir(t);
  let active = 0;
  let maxActive = 0;
  const run = (dir: string): Promise<void> => withWorkdirLock(dir, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
  });
  await Promise.all([run(a), run(b)]);
  assert.equal(maxActive, 2, '不同工作副本必须能并行');
});

test('等锁超时：别人持有锁且未过期 → 抛 WorkdirLockError（而不是无限等待）', async (t) => {
  const dir = await makeDir(t);
  // 模拟另一个**仍然存活**的进程持有锁（mtime 新鲜、pid 存在 ⇒ 两条回收路径都不该触发）。
  // 必须用真实存活 pid：死 pid 的锁现在会立即回收（见下一条用例），不再进入等待。
  await fs.writeFile(workdirLockPath(dir), JSON.stringify({ pid: process.pid, token: 'other-process' }));
  await assert.rejects(
    withWorkdirLock(dir, async () => 'never', { timeoutMs: 30, sleep: fastSleep }),
    (err: unknown) => {
      assert.ok(err instanceof WorkdirLockError, '必须是可识别的等锁超时');
      assert.equal(err.workDir, dir);
      return true;
    },
  );
  // 别人的锁不得被等待方删掉
  await fs.access(workdirLockPath(dir));
});

test('holder pid 已死：立即回收锁，不等 staleMs（DSH 重启/崩溃现场，2026-10-27）', async (t) => {
  const dir = await makeDir(t);
  const lockPath = workdirLockPath(dir);
  // 取一个必然不存在的 pid，并先证明判定本身是对的，免得把环境差异伪装成通过
  const deadPid = 4_000_000;
  assert.equal(workdirLockHolderAlive(deadPid), false, '前提：该 pid 必须不存在（否则本用例无意义）');
  await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, token: 'dead-holder' }));
  const t0 = Date.now();
  assert.equal(await withWorkdirLock(dir, async () => 'ok'), 'ok');
  assert.ok(Date.now() - t0 < 500, '死 holder 的锁必须立即回收，绝不能等到 staleMs（15 分钟）');
  await assert.rejects(fs.access(lockPath), '释放后锁文件必须消失');
});

test('陈旧锁回收：holder 仍存活但锁文件超过 stale 阈值 → 自动接管', async (t) => {
  const dir = await makeDir(t);
  const lockPath = workdirLockPath(dir);
  // pid 存活 ⇒ pid 路径不回收，只能走 mtime 兜底（覆盖 holder 卡死、永远不释放 finally 的情形）
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'hung-holder' }));
  const stale = new Date(Date.now() - DEFAULT_WORKDIR_LOCK_STALE_MS - 60_000);
  await fs.utimes(lockPath, stale, stale);
  assert.equal(await withWorkdirLock(dir, async () => 'ok'), 'ok');
  await assert.rejects(fs.access(lockPath), '释放后锁文件必须消失');
});

test('读不出的 holder 一律退回 mtime 规则：新鲜锁仍须等待，不得盲抢', async (t) => {
  const dir = await makeDir(t);
  const lockPath = workdirLockPath(dir);
  await fs.writeFile(lockPath, 'not-json'); // 半写入/旧格式：判不了 holder 是否存活
  await assert.rejects(
    withWorkdirLock(dir, async () => 'never', { timeoutMs: 30, sleep: fastSleep }),
    (err: unknown) => err instanceof WorkdirLockError,
  );
  await fs.access(lockPath);
});

test('链上排队也计入超时：排在长任务后面的调用按时失败，且绝不执行 fn', async (t) => {
  const dir = await makeDir(t);
  const slow = withWorkdirLock(dir, async () => {
    await new Promise((r) => setTimeout(r, 400));
    return 'slow';
  });
  let quickRan = false;
  const t0 = Date.now();
  await assert.rejects(
    withWorkdirLock(dir, async () => { quickRan = true; return 'quick'; }, { timeoutMs: 60 }),
    (err: unknown) => err instanceof WorkdirLockError,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 350, '排队到上限就必须失败，不能等前一个长任务跑完（实测 ' + String(elapsed) + 'ms）');
  assert.equal(quickRan, false, '已超时放弃的调用绝不允许随后仍去驱动工作副本');
  assert.equal(await slow, 'slow');
});

test('异常也释放锁：fn 抛错后下一次仍能拿到锁（不会把后续同步永久卡死）', async (t) => {
  const dir = await makeDir(t);
  await assert.rejects(withWorkdirLock(dir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withWorkdirLock(dir, async () => 'ok'), 'ok');
});

test('一次性清扫：holder 已死的残留锁被删，活锁与读不出的锁一律保留', async (t) => {
  const dir = await makeDir(t); // 顺便重置一次性清扫标记
  const suffix = String(Date.now()) + String(Math.random()).slice(2, 8);
  const deadPath = path.join(os.tmpdir(), 'dshcm-workdir-' + suffix + 'a.lock');
  const alivePath = path.join(os.tmpdir(), 'dshcm-workdir-' + suffix + 'b.lock');
  const opaquePath = path.join(os.tmpdir(), 'dshcm-workdir-' + suffix + 'c.lock');
  // pid 复用陷阱：pid 现在还活着，但它声明的工作目录早已不存在、锁也过了 staleMs
  const reusedPath = path.join(os.tmpdir(), 'dshcm-workdir-' + suffix + 'd.lock');
  const goneDir = path.join(os.tmpdir(), 'dshcm-gone-' + suffix);
  await fs.writeFile(deadPath, JSON.stringify({ pid: 4_000_000, token: 'dead', workDir: dir }));
  await fs.writeFile(alivePath, JSON.stringify({ pid: process.pid, token: 'alive', workDir: dir }));
  await fs.writeFile(opaquePath, 'not-json');
  await fs.writeFile(reusedPath, JSON.stringify({ pid: process.pid, token: 'reused', workDir: goneDir }));
  const old = new Date(Date.now() - DEFAULT_WORKDIR_LOCK_STALE_MS - 60_000);
  await fs.utimes(reusedPath, old, old);
  t.after(async () => {
    await Promise.all([deadPath, alivePath, opaquePath, reusedPath].map((f) => fs.rm(f, { force: true })));
  });

  await pruneDeadWorkdirLocksOnce();

  await assert.rejects(fs.access(deadPath), 'holder 已死的残留锁必须被清掉');
  await fs.access(alivePath); // 活锁 + 工作目录还在 ⇒ 动不得
  await fs.access(opaquePath); // 读不出 holder ⇒ 保守保留
  await assert.rejects(fs.access(reusedPath), '工作目录已消失且过了 staleMs ⇒ pid 复用造成的僵尸锁应清掉');
});

test('锁按绝对路径归一：同一目录的不同写法共享一把锁', async (t) => {
  const dir = await makeDir(t);
  let active = 0;
  let maxActive = 0;
  const run = (workDir: string): Promise<void> => withWorkdirLock(workDir, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  });
  const dotted = path.join(dir, '.', 'nested', '..');
  await Promise.all([run(dir), run(dotted)]);
  assert.equal(maxActive, 1, 'path.resolve 后同一目录必须共用一把锁');
});
