/**
 * 运行中心模型单测：卡片可终止性 / 待决策态 / 日志聚合 / 决策框默认值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelDialogModel, relativeTimeLabel, runCards, runSummary, RUN_CARD_LOG_TAIL } from './runs-view.ts';
import type { RunState } from '../core/run-registry.ts';

function run(partial: Partial<RunState> & { runId: string }): RunState {
  return {
    kind: 'import',
    status: 'running',
    section: null,
    sectionTotal: null,
    item: null,
    itemTotal: null,
    detail: null,
    log: [],
    pendingDecision: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

test('runCards：按 updatedAt 倒序，且不修改入参数组', () => {
  const list = [run({ runId: 'a', updatedAt: 100 }), run({ runId: 'b', updatedAt: 300 })];
  const cards = runCards(list);
  assert.deepEqual(cards.map((c) => c.runId), ['b', 'a']);
  assert.deepEqual(list.map((r) => r.runId), ['a', 'b'], '入参数组顺序不得被就地改写');
});

test('runCards：只有「导入 + running」可终止（其余 run 类型没有安全点，绝不放假按钮）', () => {
  const cards = runCards([
    run({ runId: 'imp', kind: 'import' }),
    run({ runId: 'sync', kind: 'sync-apply' }),
    run({ runId: 'done', status: 'done' }),
    run({ runId: 'auto', kind: 'autosync' }),
  ]);
  assert.deepEqual(cards.filter((c) => c.canCancel).map((c) => c.runId), ['imp']);
});

test('runCards：待决策态优先（在等人 ≠ 卡住）：awaitingDecision 为真时不得同时给出终止按钮', () => {
  const cards = runCards([run({ runId: 'waiting', pendingDecision: 'cancel' })]);
  assert.equal(cards[0]?.awaitingDecision, true);
  assert.equal(cards[0]?.canCancel, false, '已在等决策时再点终止没有意义');
  assert.equal(cards[0]?.canSkip, false, '等待决策期间不得再发跳过');
});

test('runCards：跳过当前插件的判据复用 isSkippablePluginInstall（detail 带 plugin: 前缀）', () => {
  const cards = runCards([
    run({ runId: 'installing', section: 'plugins', detail: 'plugin:@linxin666/dsh-ssh' }),
    run({ runId: 'patching', section: 'plugins', detail: 'plugins:pnpm-workspace.yaml' }),
    run({ runId: 'settings', section: 'settings', detail: 'settings:general' }),
  ]);
  assert.deepEqual(cards.filter((c) => c.canSkip).map((c) => c.runId), ['installing'], '只有正在安装的插件项可跳过');
});

test('runCards：日志聚合出计数与问题数，尾部行按上限截断', () => {
  const log = [
    '▶ plugin:a',
    '✓ plugin:a',
    '▶ plugin:b',
    '⚠ plugin:b',
    '▶ plugin:c',
    '✗ plugin:c',
  ];
  const cards = runCards([run({ runId: 'x', log, item: 2, itemTotal: 5 })]);
  const card = cards[0];
  assert.equal(card?.counts?.ok, 1);
  assert.equal(card?.counts?.warn, 1);
  assert.equal(card?.counts?.fail, 1);
  assert.equal(card?.problems, 2, '问题数 = 警告 + 失败');
  assert.equal(card?.progress.percent, 40);
  const many = Array.from({ length: 30 }, (_v, i) => `line-${i}`);
  assert.equal(runCards([run({ runId: 'y', log: many })])[0]?.logTail.length, RUN_CARD_LOG_TAIL);
  assert.equal(runCards([run({ runId: 'y', log: many })])[0]?.logTail.at(-1), 'line-29');
});

test('runCards：无 item/itemTotal → percent=null（不编造 0% 或 100%）', () => {
  const card = runCards([run({ runId: 'n', item: null, itemTotal: null })])[0];
  assert.equal(card?.progress.percent, null);
  assert.equal(card?.counts, null, '无日志时不产出空计数对象');
});

test('runSummary：只统计 running，awaiting 是其中待决策的那部分', () => {
  const summary = runSummary([
    run({ runId: 'a' }),
    run({ runId: 'b', pendingDecision: 'cancel' }),
    run({ runId: 'c', status: 'done' }),
  ]);
  assert.deepEqual(summary, { running: 2, awaiting: 1, total: 3 });
});

test('cancelDialogModel：默认选项跟随用户既有的「失败不回滚」偏好', () => {
  const conservative = cancelDialogModel(run({ runId: 'a', item: 1, itemTotal: 4 }), { defaultRollbackOnError: true });
  assert.equal(conservative.defaultDecision, 'rollback');
  const keepPreferred = cancelDialogModel(run({ runId: 'a', item: 1, itemTotal: 4 }), { defaultRollbackOnError: false });
  assert.equal(keepPreferred.defaultDecision, 'keep');
  assert.deepEqual(keepPreferred.options.map((o) => o.id), ['rollback', 'keep']);
});

test('cancelDialogModel：代价数字可算则算、算不出给 null（绝不编造）', () => {
  const known = cancelDialogModel(run({ runId: 'a', item: 3, itemTotal: 10 }), { defaultRollbackOnError: true });
  assert.equal(known.appliedCount, 3);
  assert.equal(known.pendingCount, 7);
  const unknown = cancelDialogModel(run({ runId: 'a' }), { defaultRollbackOnError: true });
  assert.equal(unknown.appliedCount, null);
  assert.equal(unknown.pendingCount, null);
  assert.equal(unknown.totalCount, null);
});
test('relativeTimeLabel：刚刚 / 分钟 / 小时 / 天（时钟漂移不得产出负数）', () => {
  const now = 10_000_000_000
  assert.deepEqual(relativeTimeLabel(now - 5_000, now), { key: 'overview.time.now' })
  assert.deepEqual(relativeTimeLabel(now - 3 * 60_000, now), { key: 'overview.time.min', params: { n: '3' } })
  assert.deepEqual(relativeTimeLabel(now - 5 * 3_600_000, now), { key: 'overview.time.hour', params: { n: '5' } })
  assert.deepEqual(relativeTimeLabel(now - 50 * 3_600_000, now), { key: 'overview.time.day', params: { n: '2' } })
  assert.deepEqual(relativeTimeLabel(now + 60_000, now), { key: 'overview.time.now' })
});

test('runCards：每张卡片带相对时间（没有它「正在跑」和「几小时前就结束」看起来一样）', () => {
  const now = 10_000_000_000
  const cards = runCards([
    run({ runId: 'old', status: 'done', updatedAt: now - 2 * 3_600_000 }),
    run({ runId: 'fresh', updatedAt: now - 10_000 }),
  ], { now })
  assert.deepEqual(cards.find((c) => c.runId === 'old')?.time, { key: 'overview.time.hour', params: { n: '2' } })
  assert.deepEqual(cards.find((c) => c.runId === 'fresh')?.time, { key: 'overview.time.now' })
});
/**
 * 用户报告的场景：点了「终止」以后界面只说「完成当前任务后终止」，然后就没了 ——
 * 等多久、是不是卡住、还能做什么，全都没有。这三条用例钉住「等待可见 + 超阈值给出路」。
 */
test('cancelWait：已请求终止但未到安全点 → 显示已等待分钟数；超过阈值升级为 stuck', () => {
  const now = 10_000_000
  const fresh = runCards([run({ runId: 'a', cancelRequestedAt: now - 30_000 })], { now })[0]
  assert.deepEqual(fresh?.cancelWait, { minutes: 0, stuck: false }, '刚请求：不显示分钟，也不算卡住');
  const waiting = runCards([run({ runId: 'b', cancelRequestedAt: now - 3 * 60_000 })], { now })[0]
  assert.deepEqual(waiting?.cancelWait, { minutes: 3, stuck: true }, '超过阈值必须标记 stuck（界面要给「先跳过/否则重启」的出路）');
  assert.equal(waiting?.canCancel, false, '已请求过就不再给终止按钮（再点没有任何新效果）');
});

test('cancelWait：未请求终止 → null；已到安全点（待决策）→ 由 awaitingDecision 接管，不再显示等待', () => {
  const now = 10_000_000
  const idle = runCards([run({ runId: 'a' })], { now })[0]
  assert.equal(idle?.cancelWait, null)
  assert.equal(idle?.canCancel, true, '没请求过终止 → 可以终止');
  const atSafePoint = runCards([run({ runId: 'b', cancelRequestedAt: now - 60_000, pendingDecision: 'cancel' })], { now })[0]
  assert.equal(atSafePoint?.cancelWait, null, '已到安全点：界面切到决策框，不再显示「等待」')
  assert.equal(atSafePoint?.awaitingDecision, true)
});
