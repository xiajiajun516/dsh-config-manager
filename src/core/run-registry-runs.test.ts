/**
 * RunRegistry 的运行中心扩展（2026-09）单测：pendingDecision + listRecent。
 *
 * 为什么单独立文件：这两项服务的都是「用户能看见/能终止正在跑的 run」这条链路 ——
 *  - pendingDecision：终止请求已到达、run 停在安全点等人选择（UI 据此弹决策框）；
 *  - listRecent：运行中心一次拿全 running + 刚结束的 run（终态受 retentionMs 约束）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RunRegistry } from './run-registry.ts';

test('pendingDecision：登记后可见，终态 run 上的晚到写入被忽略', () => {
  const runs = new RunRegistry({ now: () => 1000 });
  const run = runs.register('import');
  assert.equal(run.pendingDecision, null, '登记时必须是 null（不是 undefined）');
  assert.equal(runs.setPendingDecision(run.runId, 'cancel')?.pendingDecision, 'cancel');
  assert.equal(runs.get(run.runId)?.pendingDecision, 'cancel');
  assert.equal(runs.setPendingDecision(run.runId, null)?.pendingDecision, null, '决策完成后必须能清掉');
  runs.finish(run.runId, { ok: true });
  assert.equal(runs.setPendingDecision(run.runId, 'cancel')?.pendingDecision, null, '终态后不得再挂起决策');
});

test('pendingDecision：未知 runId 返回 undefined（不伪造状态）', () => {
  const runs = new RunRegistry();
  assert.equal(runs.setPendingDecision('deadbeef', 'cancel'), undefined);
});

test('pendingDecision 不进入 update 的白名单（进度更新不得清掉待决策态）', () => {
  const runs = new RunRegistry();
  const run = runs.register('import');
  runs.setPendingDecision(run.runId, 'cancel');
  runs.update(run.runId, { detail: '正在等待选择' });
  assert.equal(runs.get(run.runId)?.pendingDecision, 'cancel');
});

test('listRecent：含 running 与终态，按 updatedAt 倒序，支持 limit', () => {
  let now = 100;
  const runs = new RunRegistry({ now: () => now });
  const a = runs.register('export');
  now = 200;
  const b = runs.register('import');
  now = 300;
  runs.finish(a.runId, { zipPath: 'x' });
  const recent = runs.listRecent();
  assert.deepEqual(recent.map((r) => r.runId), [a.runId, b.runId], '最新更新在前');
  assert.equal(runs.listRecent(1).length, 1);
  assert.equal(runs.listActive().length, 1, 'listActive 仍只回 running（语义未变）');
});

test('listRecent：终态超过保留期后被清理（不是持久审计）', () => {
  let now = 0;
  const runs = new RunRegistry({ now: () => now, retentionMs: 1000 });
  const run = runs.register('import');
  runs.finish(run.runId, {});
  assert.equal(runs.listRecent().length, 1);
  now = 5000;
  assert.equal(runs.listRecent().length, 0, '超过 retentionMs 的终态 run 必须被惰性清理');
});
test('requestCancel：记录首个请求时刻（重复请求不刷新，界面显示的是真实等待时长）', () => {
  let now = 1_000;
  const runs = new RunRegistry({ now: () => now });
  const run = runs.register('import');
  assert.equal(run.cancelRequestedAt, null, '登记时必须显式 null（不是 undefined）');
  assert.equal(runs.requestCancel(run.runId)?.cancelRequestedAt, 1_000);
  now = 9_000;
  assert.equal(runs.requestCancel(run.runId)?.cancelRequestedAt, 1_000, '重复请求不得把等待计时清零');
  runs.finish(run.runId, {});
  assert.equal(runs.requestCancel(run.runId)?.cancelRequestedAt, 1_000, '终态后的晚到请求被忽略');
  assert.equal(runs.requestCancel('nope'), undefined, '未知 runId 返回 undefined（不伪造状态）');
});
