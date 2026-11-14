/**
 * 断开通道的时序守卫（./config-clear-guard.ts）。
 *
 * 真机背景（P9-5）：断开时的在途 saveConfig 取消不掉，回执晚回来会把刚清空的配置合并回来；
 * 宿主侧 save 晚于 clear 到达时配置也会回魂。这里钉住三条口径：
 *  ① 世代不等 ⇒ 回执整体丢弃（不写回任何字段）；
 *  ② 断开前先取消防抖/丢排队载荷再等在途落定，超时**拒绝断开**（prepareClear）；
 *  ③ 不再有「断开后自愈 clear」——反方实测它会把用户随后保存成功的新配置连凭据一起删掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEAR_QUIESCENT_POLL_MS, CLEAR_QUIESCENT_TIMEOUT_MS, clearedChannelFormFields,
  prepareClear, shouldDiscardSaveResult, waitForQuiescence,
} from './config-clear-guard.ts';

test('C-1 shouldDiscardSaveResult：世代不同即丢弃，相同则写回', () => {
  assert.equal(shouldDiscardSaveResult(0, 0), false);
  assert.equal(shouldDiscardSaveResult(3, 3), false);
  assert.equal(shouldDiscardSaveResult(0, 1), true);
  assert.equal(shouldDiscardSaveResult(2, 1), true);
});

test('C-2 prepareClear：先撤未发出的输入，再放行', async () => {
  let cancelled = 0;
  let busy = false;
  await prepareClear({ cancelPendingSave: () => { cancelled += 1; busy = false }, isBusy: () => busy, busyMessage: 'busy' });
  assert.equal(cancelled, 1, '必须先撤掉防抖 timer + 排队载荷（600ms 到点会把旧值发回宿主）');
});

test('C-2b prepareClear：在途保存超时 ⇒ 抛错拒绝断开（不带着在途 save 去 clear）', async () => {
  await assert.rejects(
    () => prepareClear({ cancelPendingSave: () => {}, isBusy: () => true, busyMessage: 'still-saving', timeoutMs: 30, pollMs: 5 }),
    /still-saving/,
  );
});

test('C-2c prepareClear：在途保存落地后放行', async () => {
  let busy = true;
  const wait = prepareClear({ cancelPendingSave: () => {}, isBusy: () => busy, busyMessage: 'still-saving', timeoutMs: 500, pollMs: 5 });
  setTimeout(() => { busy = false }, 20);
  await wait;
});

test('C-2d prepareClear 每轮重新问 isBusy（队列整体替换后不能读旧快照）', async () => {
  let queue = { inFlight: true, pending: null as unknown };
  const wait = prepareClear({ cancelPendingSave: () => { queue = { ...queue, pending: null } }, isBusy: () => queue.inFlight, busyMessage: 'still-saving', timeoutMs: 500, pollMs: 5 });
  setTimeout(() => { queue = { inFlight: false, pending: null } }, 20); // 模拟 saveQueueRef.current = settled.state
  await wait; // 若实现读的是入参快照，这里会超时抛错
});

test('C-3 waitForQuiescence：空闲立刻放行', async () => {
  assert.equal(await waitForQuiescence(() => false), true);
});

test('C-4 waitForQuiescence：在途请求落地后放行', async () => {
  let busy = true;
  const wait = waitForQuiescence(() => busy, { timeoutMs: 500, pollMs: 5 });
  setTimeout(() => { busy = false }, 20);
  assert.equal(await wait, true);
});

test('C-5 waitForQuiescence：超时返回 false（放行由调用方决定：prepareClear 据此拒绝断开）', async () => {
  assert.equal(await waitForQuiescence(() => true, { timeoutMs: 30, pollMs: 5 }), false);
});

test('C-6 超时/轮询常量有界（不是 0，也不会把用户卡太久）', () => {
  assert.ok(CLEAR_QUIESCENT_TIMEOUT_MS > 0 && CLEAR_QUIESCENT_TIMEOUT_MS <= 5000);
  assert.ok(CLEAR_QUIESCENT_POLL_MS > 0 && CLEAR_QUIESCENT_POLL_MS < CLEAR_QUIESCENT_TIMEOUT_MS);
});

test('C-7 clearedChannelFormFields：只清本通道的表单残留', () => {
  assert.deepEqual(clearedChannelFormFields('git'), { repoUrl: '', token: '' });
  assert.deepEqual(clearedChannelFormFields('webdav'), {
    webdavUrl: '', webdavUsername: '', webdavPassword: '',
  });
  const s3 = clearedChannelFormFields('s3');
  assert.equal(s3.s3Endpoint, '');
  assert.equal(s3.s3AccessKeyId, '');
  assert.equal(s3.s3Secret, '');
  assert.equal(s3.s3PathStyle, false);
  assert.equal(s3.s3Provider, 's3', '云端点通道断开后回落默认厂商');
  assert.equal('repoUrl' in s3, false, '不得顺带清别的通道');
  assert.deepEqual(clearedChannelFormFields('gist'), {
    gistId: '', gistApiBaseUrl: '', gistFilePrefix: '', gistToken: '',
  });
});

test('C-8 clearedChannelFormFields 返回副本：调用方改不污染映像表', () => {
  const first = clearedChannelFormFields('git');
  first.repoUrl = 'polluted';
  assert.equal(clearedChannelFormFields('git').repoUrl, '');
});
