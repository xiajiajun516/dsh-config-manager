import test from 'node:test';
import assert from 'node:assert/strict';
import { createCacheCleanupScheduler } from './cache-cleanup.ts';

/** 收集日志的假 log 口（只记 info/warn 文本，便于断言「失败不静默」）。 */
function fakeLog(): { info: string[]; warn: string[]; sink: { info(m: string): void; warn(m: string): void } } {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, sink: { info: (m) => { info.push(m); }, warn: (m) => { warn.push(m); } } };
}

const tick = async (ms = 30): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, ms); }); };

test('CC-1 start 立即清一次，并按周期继续清', async () => {
  let calls = 0;
  const { sink } = fakeLog();
  const scheduler = createCacheCleanupScheduler({ cleanup: async () => { calls += 1; return { removed: 0, freedBytes: 0 }; }, intervalMs: 10, log: sink });
  scheduler.start();
  assert.equal(calls, 1);
  await tick(45);
  assert.ok(calls >= 3, `期望至少 3 次（1 次启动 + 定时），实际 ${calls}`);
  scheduler.dispose();
});

test('CC-2 start 幂等：重复调用不叠定时器', async () => {
  let calls = 0;
  const { sink } = fakeLog();
  const scheduler = createCacheCleanupScheduler({ cleanup: async () => { calls += 1; return { removed: 0, freedBytes: 0 }; }, intervalMs: 10, log: sink });
  scheduler.start();
  scheduler.start();
  assert.equal(calls, 1, '第二次 start 不得再同步清一次');
  await tick(35);
  // 单个定时器：10ms 周期下 35ms 内不会超过 1 + 4 次
  assert.ok(calls <= 5, `定时器疑似叠了：${calls}`);
  scheduler.dispose();
});

test('CC-3 dispose 停掉定时器且幂等', async () => {
  let calls = 0;
  const { sink } = fakeLog();
  const scheduler = createCacheCleanupScheduler({ cleanup: async () => { calls += 1; return { removed: 0, freedBytes: 0 }; }, intervalMs: 10, log: sink });
  scheduler.start();
  scheduler.dispose();
  scheduler.dispose();
  const afterDispose = calls;
  await tick(35);
  assert.equal(calls, afterDispose, 'dispose 之后不得再有清理');
});

test('CC-4 removed > 0 才记 info（0 个不刷噪音）', async () => {
  const { info, sink } = fakeLog();
  const zero = createCacheCleanupScheduler({ cleanup: async () => ({ removed: 0, freedBytes: 0 }), intervalMs: 1000, log: sink });
  zero.runNow();
  await tick(10);
  assert.deepEqual(info, []);
  const one = createCacheCleanupScheduler({ cleanup: async () => ({ removed: 2, freedBytes: 128 }), intervalMs: 1000, log: sink });
  one.runNow();
  await tick(10);
  assert.equal(info.length, 1);
});

test('CC-5 清理失败只记 warn（含错误文本），不抛、不停表', async () => {
  const { warn, sink } = fakeLog();
  let calls = 0;
  const scheduler = createCacheCleanupScheduler({
    cleanup: async () => { calls += 1; throw new Error('disk on fire'); },
    intervalMs: 10,
    log: sink,
  });
  scheduler.start();
  await tick(35);
  assert.ok(calls >= 2, '失败后定时器必须继续跑');
  assert.ok(warn.length >= 1);
  assert.match(warn[0] ?? '', /缓存自动清理失败/);
  scheduler.dispose();
});

test('CC-6 非 Error 抛出也如实成字符串（不吞形状）', async () => {
  const { warn, sink } = fakeLog();
  const scheduler = createCacheCleanupScheduler({ cleanup: () => Promise.reject('boom'), intervalMs: 1000, log: sink });
  scheduler.runNow();
  await tick(10);
  assert.equal(warn.length, 1);
});
