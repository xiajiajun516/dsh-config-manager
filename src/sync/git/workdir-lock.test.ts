/**
 * 工作副本锁单测（src/sync/git/workdir-lock.ts）。
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
  resetWorkdirLockChainsForTest,
  withWorkdirLock,
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
  // 模拟另一个进程正在持有锁（文件已存在、mtime 新鲜 → 不会被当成陈旧锁回收）
  await fs.writeFile(workdirLockPath(dir), JSON.stringify({ pid: 999999, token: 'other-process' }));
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

test('陈旧锁回收：holder 崩溃留下的锁（超过 stale 阈值）→ 自动接管', async (t) => {
  const dir = await makeDir(t);
  const lockPath = workdirLockPath(dir);
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, token: 'dead' }));
  const stale = new Date(Date.now() - DEFAULT_WORKDIR_LOCK_STALE_MS - 60_000);
  await fs.utimes(lockPath, stale, stale);
  assert.equal(await withWorkdirLock(dir, async () => 'ok'), 'ok');
  await assert.rejects(fs.access(lockPath), '释放后锁文件必须消失');
});

test('异常也释放锁：fn 抛错后下一次仍能拿到锁（不会把后续同步永久卡死）', async (t) => {
  const dir = await makeDir(t);
  await assert.rejects(withWorkdirLock(dir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withWorkdirLock(dir, async () => 'ok'), 'ok');
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
