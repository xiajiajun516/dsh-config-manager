/**
 * m-market：star-cache.ts（StarCache）单测。
 * 覆盖：成功缓存 + TTL；TTL 内零重复查询；过期重查；去重（同 URL 并发只查一次）；
 * 失败降级（单仓失败返回 undefined 且不缓存，下轮重试）；仓库不存在（null）不缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StarCache } from './star-cache.ts';

/** 可控时钟（测试注入） */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('star-cache: 查询成功 → 返回并缓存，TTL 内零重复查询', async () => {
  const clock = makeClock();
  let calls = 0;
  const cache = new StarCache({
    query: async (url) => { calls += 1; return url === 'https://github.com/a/r' ? 42 : null; },
    now: clock.now,
    ttlMs: 60_000,
  });
  assert.equal(await cache.get('https://github.com/a/r'), 42);
  assert.equal(await cache.get('https://github.com/a/r'), 42, 'TTL 内命中缓存');
  assert.equal(calls, 1, 'TTL 内不得重复查询');
});

test('star-cache: 超过 TTL → 重新查询', async () => {
  const clock = makeClock();
  let value = 1;
  const cache = new StarCache({
    query: async () => value,
    now: clock.now,
    ttlMs: 60_000,
  });
  assert.equal(await cache.get('u'), 1);
  clock.advance(60_001);
  value = 2;
  assert.equal(await cache.get('u'), 2, 'TTL 过期后应重新查询');
});

test('star-cache: 查询抛错 → undefined 且不缓存（下轮重试）', async () => {
  const clock = makeClock();
  let fail = true;
  const cache = new StarCache({
    query: async () => { if (fail) throw new Error('boom'); return 7; },
    now: clock.now,
    ttlMs: 60_000,
  });
  assert.equal(await cache.get('u'), undefined, '查询失败 → undefined');
  clock.advance(1);
  fail = false;
  assert.equal(await cache.get('u'), 7, '失败不缓存 → 下轮重试成功');
});

test('star-cache: 仓库不存在（null）→ undefined 且不缓存（下轮重试）', async () => {
  const clock = makeClock();
  let exists = false;
  const cache = new StarCache({
    query: async () => (exists ? 5 : null),
    now: clock.now,
    ttlMs: 60_000,
  });
  assert.equal(await cache.get('u'), undefined);
  clock.advance(1);
  exists = true;
  assert.equal(await cache.get('u'), 5, 'null 不缓存 → 下轮可查到');
});

test('star-cache: getMany 逐项查询，单项失败不影响其他', async () => {
  const cache = new StarCache({
    query: async (url) => {
      if (url === 'bad') throw new Error('boom');
      return url === 'a' ? 10 : 20;
    },
    ttlMs: 60_000,
  });
  const map = await cache.getMany(['a', 'bad', 'b']);
  assert.equal(map.get('a'), 10);
  assert.equal(map.get('bad'), undefined, '失败项 → undefined');
  assert.equal(map.get('b'), 20);
});

test('star-cache: 并发同 URL 只查一次（in-flight 去重）', async () => {
  let calls = 0;
  let resolveQuery!: (v: number | null) => void;
  const cache = new StarCache({
    query: async () => {
      calls += 1;
      return new Promise<number | null>((resolve) => { resolveQuery = resolve; });
    },
    ttlMs: 60_000,
  });
  const p1 = cache.get('u');
  const p2 = cache.get('u');
  resolveQuery(3);
  assert.equal(await p1, 3);
  assert.equal(await p2, 3);
  assert.equal(calls, 1, '并发同 URL 必须只发一次查询');
});
