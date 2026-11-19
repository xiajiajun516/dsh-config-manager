/**
 * Item J：自动同步指数退避与短暂环境锁阻塞重试纯函数单元测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AUTOSYNC_BACKOFF_MS,
  MAX_LOCK_RETRY_DELAY_MS,
  computeFailureBackoffMs,
  computeLockRetryDelayMs,
  computeNextRetryIso,
  effectiveTimerDelayMs,
  isScheduledTriggerDuringBackoff,
  isTransientLockSkipReason,
} from './autosync-backoff.ts';

test('computeFailureBackoffMs：失败次数指数退避、1h 封顶且不缩水超长 interval', () => {
  const base5m = 5 * 60 * 1000;
  assert.equal(computeFailureBackoffMs(base5m, 0), base5m);
  assert.equal(computeFailureBackoffMs(base5m, 1), 10 * 60 * 1000);
  assert.equal(computeFailureBackoffMs(base5m, 2), 20 * 60 * 1000);
  assert.equal(computeFailureBackoffMs(base5m, 3), 40 * 60 * 1000);
  assert.equal(computeFailureBackoffMs(base5m, 4), MAX_AUTOSYNC_BACKOFF_MS);
  assert.equal(computeFailureBackoffMs(base5m, 20), MAX_AUTOSYNC_BACKOFF_MS);

  const day24h = 24 * 60 * 60 * 1000;
  assert.equal(computeFailureBackoffMs(day24h, 1), day24h, '24h 周期不得被 1h 上限缩水');
});

test('effectiveTimerDelayMs & computeNextRetryIso：剩余退避未到期拉长定时器，到期或清空恢复基准周期', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const nextIso = computeNextRetryIso(now, 5 * 60_000, 2);
  assert.equal(nextIso, '2026-11-18T12:20:00.000Z');
  assert.equal(computeNextRetryIso(now, 5 * 60_000, 0), undefined);

  assert.equal(effectiveTimerDelayMs(5 * 60_000, nextIso, now), 20 * 60_000);
  assert.equal(effectiveTimerDelayMs(5 * 60_000, nextIso, now + 18 * 60_000), 5 * 60_000, '剩余不足 baseMs 时按 baseMs 排期');
  assert.equal(effectiveTimerDelayMs(5 * 60_000, undefined, now), 5 * 60_000);
  assert.equal(effectiveTimerDelayMs(5 * 60_000, 'not-a-date', now), 5 * 60_000);
});

test('computeLockRetryDelayMs & isTransientLockSkipReason：区分可自愈活跃锁与需人工处理的残留锁/SAFE MODE', () => {
  assert.equal(computeLockRetryDelayMs(15_000, 1), 15_000);
  assert.equal(computeLockRetryDelayMs(15_000, 2), 30_000);
  assert.equal(computeLockRetryDelayMs(15_000, 3), MAX_LOCK_RETRY_DELAY_MS);
  assert.equal(computeLockRetryDelayMs(15_000, 10), MAX_LOCK_RETRY_DELAY_MS);

  assert.equal(isTransientLockSkipReason('mutation-locked'), true);
  assert.equal(isTransientLockSkipReason('mutation-lock-unavailable'), false);
  assert.equal(isTransientLockSkipReason('mutation-lock-stale'), false);
  assert.equal(isTransientLockSkipReason('mutation-safe-mode'), false);
});

test('isScheduledTriggerDuringBackoff：只拦截窗口内后台轮询，不挡手工与本地保存触发', () => {
  const retryAt = Date.parse('2026-11-18T12:20:00.000Z');
  const during = Date.parse('2026-11-18T12:10:00.000Z');
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, during, 'remote-poll'), true);
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, during, 'interval'), true);
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, during, 'local-change'), false);
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, during, 'manual'), false);
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, during, 'startup'), false);
  assert.equal(isScheduledTriggerDuringBackoff(retryAt, retryAt, 'remote-poll'), false);
});
