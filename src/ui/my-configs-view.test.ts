/**
 * src/ui/my-configs-view.ts 单测（t44：从 MyConfigsView.tsx 下沉的纯逻辑）。
 *
 * 覆盖此前**无任何测试**的分支：GitHub device flow 状态迁移与轮询延时、收录轮询的三条分支
 * （请求抛错继续 / 远端明确无任务收尾 / failed 告警）、PR 链接来源优先级、仓库 URL 兜底、
 * 装回本地勾选的陈旧回落、免责取消是否重置向导。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INITIAL_MY_GITHUB_FLOW, MY_LISTING_POLL_INTERVAL_MS, MY_LISTING_POLL_MAX_TICKS,
  myEntryRepoUrl, myGithubFlowAfterCancel, myGithubFlowAfterFailure, myGithubFlowAfterPoll,
  myGithubFlowFromStart, myGithubFlowPolling, myGithubFlowStarting, myGithubPollDelayMs,
  myGithubPollOutcome, myGithubStartDelayMs, myListingPollStep, myPickerSelection, myPrLinkSource,
  myShouldResetWizardOnDisclaimerCancel,
} from './my-configs-view.ts';
import type { MyGithubFlowState } from './my-configs-view.ts';
import type { ImportPlan } from '../core/types.ts';

/* ---------------- GitHub device flow 状态机 ---------------- */

test('t44：device flow 初始态 + starting/polling 迁移（仅改 phase，清错误）', () => {
  assert.deepEqual(INITIAL_MY_GITHUB_FLOW, {
    phase: 'idle', flowId: '', userCode: '', verificationUri: '', interval: 5, error: null,
  });
  const afterStart = myGithubFlowStarting({ ...INITIAL_MY_GITHUB_FLOW, error: '上一次失败', userCode: 'OLD' });
  assert.equal(afterStart.phase, 'starting');
  assert.equal(afterStart.error, null, 'starting 必须清掉上一次错误');
  assert.equal(afterStart.userCode, 'OLD', 'starting 不改其它字段');
  assert.equal(myGithubFlowPolling(afterStart).phase, 'polling');
});

test('t44：宿主返回设备码 → waiting（携带 flowId/用户码/授权页/间隔），错误恒 null', () => {
  const s = myGithubFlowFromStart({ flowId: 'f1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 });
  assert.deepEqual(s, {
    phase: 'waiting', flowId: 'f1', userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device', interval: 5, error: null,
  });
});

test('t44：轮询延时——首次按 interval 秒换算并钳到 >=1s（0/负数/NaN 不空转）', () => {
  assert.equal(myGithubStartDelayMs(5), 5000);
  assert.equal(myGithubStartDelayMs(2.9), 2000, '向下取整');
  assert.equal(myGithubStartDelayMs(0), 1000, '0 秒 → 1s 下限');
  assert.equal(myGithubStartDelayMs(-3), 1000, '负数 → 1s 下限');
  assert.equal(myGithubStartDelayMs(Number.NaN), 1000, 'NaN → 1s 下限');
});

test('t44：后续轮询延时——宿主 pollDelayMs 优先，非法/缺失回落到 interval', () => {
  assert.equal(myGithubPollDelayMs(5, 1500), 1500);
  assert.equal(myGithubPollDelayMs(5, 1500.7), 1500, '向下取整');
  assert.equal(myGithubPollDelayMs(5, null), 5000, 'null → 回落 interval');
  assert.equal(myGithubPollDelayMs(5, undefined), 5000, '缺省 → 回落 interval');
  assert.equal(myGithubPollDelayMs(5, 0), 5000, '0 非法（会空转）→ 回落 interval');
  assert.equal(myGithubPollDelayMs(5, -100), 5000, '负数非法 → 回落 interval');
  assert.equal(myGithubPollDelayMs(5, Number.NaN), 5000, 'NaN 非法 → 回落 interval');
});

test('t44：轮询结果三分——只认 pending/success，其余（error/expired/denied/未知）一律 failed', () => {
  assert.equal(myGithubPollOutcome('pending'), 'pending');
  assert.equal(myGithubPollOutcome('success'), 'success');
  for (const s of ['error', 'expired', 'denied', 'slow_down', '', 'whatever']) {
    assert.equal(myGithubPollOutcome(s), 'failed', '非 pending/success 一律 failed: ' + s);
  }
});

test('t44：一次轮询后的迁移——pending 回到 waiting 并给下次延时', () => {
  const prev: MyGithubFlowState = { ...INITIAL_MY_GITHUB_FLOW, phase: 'polling', flowId: 'f1', interval: 5 };
  const withOverride = myGithubFlowAfterPoll(prev, { status: 'pending', pollDelayMs: 2000 }, '');
  assert.equal(withOverride.outcome, 'pending');
  assert.equal(withOverride.next.phase, 'waiting');
  assert.equal(withOverride.next.flowId, 'f1', 'pending 保留 flowId/用户码');
  assert.equal(withOverride.delayMs, 2000, '宿主 pollDelayMs 优先');
  const noOverride = myGithubFlowAfterPoll(prev, { status: 'pending' }, '');
  assert.equal(noOverride.delayMs, 5000, '缺省回落到 interval');
});

test('t44：一次轮询后的迁移——success 回到初始态（清设备码），无下次延时', () => {
  const prev: MyGithubFlowState = { ...INITIAL_MY_GITHUB_FLOW, phase: 'polling', flowId: 'f1', userCode: 'CODE', interval: 5 };
  const step = myGithubFlowAfterPoll(prev, { status: 'success' }, '');
  assert.equal(step.outcome, 'success');
  assert.deepEqual(step.next, INITIAL_MY_GITHUB_FLOW, 'success 必须回到初始态（旧实现是 setGithub(initialGithubFlow)）');
  assert.equal(step.delayMs, null);
});

test('t44：一次轮询后的迁移——failed（expired 等）进入 error 并记录已脱敏原因', () => {
  const prev: MyGithubFlowState = { ...INITIAL_MY_GITHUB_FLOW, phase: 'polling', flowId: 'f1', userCode: 'CODE' };
  const step = myGithubFlowAfterPoll(prev, { status: 'expired' }, '设备码已过期');
  assert.equal(step.outcome, 'failed');
  assert.equal(step.next.phase, 'error');
  assert.equal(step.next.error, '设备码已过期');
  assert.equal(step.next.userCode, 'CODE', '失败态保留设备码供用户重试阅读');
  assert.equal(step.delayMs, null, '失败不再排轮询');
});

test('t44：启动/轮询抛错 → error 态；取消 → 回初始态并交出 flowId', () => {
  const failed = myGithubFlowAfterFailure({ ...INITIAL_MY_GITHUB_FLOW, phase: 'starting' }, '网络不可达');
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error, '网络不可达');
  const cancelled = myGithubFlowAfterCancel({ ...INITIAL_MY_GITHUB_FLOW, phase: 'waiting', flowId: 'f9', userCode: 'CODE' });
  assert.equal(cancelled.flowId, 'f9', '取消需要把 flowId 交给宿主撤销');
  assert.deepEqual(cancelled.next, INITIAL_MY_GITHUB_FLOW);
  assert.equal(myGithubFlowAfterCancel(INITIAL_MY_GITHUB_FLOW).flowId, '', '未开始的取消无需通知宿主');
});

/* ---------------- 收录/下架任务轮询步进 ---------------- */

type Listing = { listing: string; itemId: string; prNumber: number | null; prUrl: string | null; error?: string };
const DONE: Listing = { listing: 'done', itemId: 'cfg-a', prNumber: null, prUrl: null };

test('t44：轮询常量（3s × 40 ≈ 2 分钟，改动需同步本测试）', () => {
  assert.equal(MY_LISTING_POLL_INTERVAL_MS, 3000);
  assert.equal(MY_LISTING_POLL_MAX_TICKS, 40);
});

test('t44：轮询步进——pending 继续（计数递增、不告警）', () => {
  const s: Listing = { listing: 'pending', itemId: 'cfg-a', prNumber: null, prUrl: null };
  const step = myListingPollStep({ response: s, count: 0, doneFallback: DONE });
  assert.equal(step.status, s, 'pending 如实展示远端状态');
  assert.equal(step.stop, false, 'pending 不停止');
  assert.equal(step.count, 1);
  assert.equal(step.notifyFailure, false);
});

test('t44：轮询步进——达到上限必须停（第 40 轮），且 pending 不误报失败', () => {
  const s: Listing = { listing: 'pending', itemId: 'cfg-a', prNumber: null, prUrl: null };
  const step = myListingPollStep({ response: s, count: MY_LISTING_POLL_MAX_TICKS - 1, doneFallback: DONE });
  assert.equal(step.stop, true, '超时停止（用户可手动刷新/重新收录）');
  assert.equal(step.count, MY_LISTING_POLL_MAX_TICKS);
  assert.equal(step.notifyFailure, false, '超时不是失败告警');
});

test('t44：轮询步进——failed 停止且要求常驻告警；done 停止但不告警', () => {
  const failed: Listing = { listing: 'failed', itemId: 'cfg-a', prNumber: null, prUrl: null, error: 'fork 失败' };
  const step = myListingPollStep({ response: failed, count: 0, doneFallback: DONE });
  assert.equal(step.status, failed);
  assert.equal(step.stop, true);
  assert.equal(step.notifyFailure, true, 'failed 必须告警（R-16 常驻 Toast）');
  const done: Listing = { listing: 'done', itemId: 'cfg-a', prNumber: 3, prUrl: 'https://github.com/x/pr/3' };
  const step2 = myListingPollStep({ response: done, count: 0, doneFallback: DONE });
  assert.equal(step2.stop, true);
  assert.equal(step2.notifyFailure, false);
});

test('t44：轮询步进——远端明确回答 null（任务丢失）→ 用 doneFallback 收尾并停止', () => {
  const step = myListingPollStep({ response: null, count: 3, doneFallback: DONE });
  assert.equal(step.status, DONE, 'null 不是失败：任务表未命中且实况也无 → 按 done 收尾');
  assert.equal(step.stop, true);
  assert.equal(step.notifyFailure, false);
});

test('t44：轮询步进——请求抛错必须**继续**轮询（与「远端回答 null」语义不同）', () => {
  const step = myListingPollStep({ response: null, networkFailed: true, count: 0, doneFallback: DONE });
  assert.equal(step.status, null, '抛错时不改展示状态');
  assert.equal(step.stop, false, '网络抖动不得当成任务结束');
  assert.equal(step.count, 1);
  assert.equal(step.notifyFailure, false);
  const exhausted = myListingPollStep({ response: null, networkFailed: true, count: MY_LISTING_POLL_MAX_TICKS - 1, doneFallback: DONE });
  assert.equal(exhausted.stop, true, '连错到上限也要停（不能永久轮询）');
});

/* ---------------- 展示派生 ---------------- */

test('t44：PR 链接来源——实时任务状态优先，其次向导结果；两者皆空 → 不渲染', () => {
  assert.equal(myPrLinkSource(null, undefined), null);
  assert.equal(myPrLinkSource(null, { prUrl: null, prNumber: null }), null);
  assert.equal(myPrLinkSource({ prUrl: '', prNumber: 1 }, { prUrl: '' }), null, '空串 URL 视为无链接');
  assert.deepEqual(
    myPrLinkSource({ prUrl: 'https://live/pr/9', prNumber: 9 }, { prUrl: 'https://result/pr/1', prNumber: 1 }),
    { url: 'https://live/pr/9', number: 9 },
    '有实时状态时以它为准（含编号）',
  );
  assert.deepEqual(
    myPrLinkSource(null, { prUrl: 'https://result/pr/1', prNumber: 1 }),
    { url: 'https://result/pr/1', number: 1 },
    '无实时状态时取向导结果',
  );
  assert.deepEqual(
    myPrLinkSource({ prUrl: 'https://live/pr/9', prNumber: null }, { prUrl: 'https://result/pr/1', prNumber: 7 }),
    { url: 'https://live/pr/9', number: 7 },
    'URL 取实时、编号回落向导结果（与原实现逐字一致）',
  );
  assert.deepEqual(myPrLinkSource({ prUrl: 'https://live/pr/9' }, null), { url: 'https://live/pr/9', number: null });
});

test('t44：条目仓库 URL——取条目自己的 repoUrl，缺失/空串回落到默认仓库', () => {
  const entries = [{ id: 'cfg-a', repoUrl: 'https://github.com/u/a' }, { id: 'cfg-b', repoUrl: '' }, { id: 'cfg-c' }];
  assert.equal(myEntryRepoUrl(entries, 'cfg-a', 'https://default'), 'https://github.com/u/a');
  assert.equal(myEntryRepoUrl(entries, 'cfg-b', 'https://default'), 'https://default', '空串回落到默认');
  assert.equal(myEntryRepoUrl(entries, 'cfg-c', 'https://default'), 'https://default', '缺字段回落到默认');
  assert.equal(myEntryRepoUrl(entries, 'missing', 'https://default'), 'https://default', '未命中条目回落到默认');
});

const plan: ImportPlan = {
  items: [{ id: 'settings:general', kind: 'Update', adapter: 'settings', description: 'x', severity: 'info', target: { adapter: 'settings', ref: 'general' } }],
  globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {},
} as unknown as ImportPlan;

test('t44：装回本地勾选——detail 未就绪 → null；就绪 → 生效选择（陈旧自动回落默认全选）', () => {
  assert.equal(myPickerSelection(null), null);
  assert.equal(myPickerSelection(undefined), null);
  assert.equal(myPickerSelection({ detail: null, selectionState: null }), null);
  const fresh = myPickerSelection({ detail: { plan, zipPath: 'zip-1' }, selectionState: null });
  assert.ok(fresh !== null && fresh.sections.includes('settings'), '未选择 → 默认全选该计划的分区');
  const chosen = { sections: [], excluded: ['settings:general'] };
  assert.deepEqual(
    myPickerSelection({ detail: { plan, zipPath: 'zip-1' }, selectionState: { zipPath: 'zip-1', selection: chosen } }),
    chosen,
    'zipPath 一致 → 沿用用户勾选',
  );
  const stale = myPickerSelection({ detail: { plan, zipPath: 'zip-2' }, selectionState: { zipPath: 'zip-1', selection: chosen } });
  assert.ok(stale !== null && stale.sections.includes('settings'), '换条目（zipPath 变化）→ 陈旧选择回落默认全选');
  assert.notDeepEqual(stale, chosen);
});

test('t44：免责取消是否重置向导——只有「上传入口 + update 残留态」才重置', () => {
  assert.equal(myShouldResetWizardOnDisclaimerCancel('upload', 'update'), true);
  assert.equal(myShouldResetWizardOnDisclaimerCancel('upload', 'upload'), false, '本就是上传初始态无需重置');
  assert.equal(myShouldResetWizardOnDisclaimerCancel('install', 'update'), false, '装回本地入口不得清掉向导');
  assert.equal(myShouldResetWizardOnDisclaimerCancel(null, 'update'), false);
});
