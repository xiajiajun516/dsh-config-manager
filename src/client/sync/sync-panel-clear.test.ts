/**
 * SyncPanel 断开流程的源码守卫（反方复核后加的护栏；本仓无 DOM 测试环境，见 runs-center-guard.test.ts 同款做法）。
 *
 * 钉住四件被反方证伪过的错法，任何一件回来都算回归：
 *  G-1 断开前必须走 prepareClear（取消防抖 + 丢排队载荷 + 等在途落定，超时抛错），
 *      不能退回「只等 inFlight」——防抖未到点时它立即放行，600ms 后旧值写回宿主；
 *  G-2 不许恢复「断开后自愈 clear」（会把用户随后保存成功的新配置连凭据一起删掉）；
 *  G-3 回执作废时不许改写保存队列（那属于新保存，改 inFlight 会让防重入失效）；
 *  G-4 关闭配置弹窗必须复位脏标记（否则非法输入永久屏蔽宿主真值）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('./SyncPanel.tsx', import.meta.url), 'utf8');
const guard = readFileSync(new URL('./config-clear-guard.ts', import.meta.url), 'utf8');

test('G-1 断开走 prepareClear（取消防抖 + 丢载荷 + 等在途落定）', () => {
  assert.ok(panel.includes('beforeClear={() => prepareClear({'), '断开前必须用 prepareClear');
  assert.ok(panel.includes('cancelPendingSave: () => dropPendingSave(true)'), '必须撤防抖 + 丢排队载荷（且保留 inFlight 供等待）');
  assert.ok(panel.includes("isBusy: () => saveQueueRef.current.inFlight, busyMessage: t('channel.clearBusy')"), '必须用 getter 探活，超时带文案抛错');
  assert.ok(panel.includes('clearTimeout(saveTimer.current)'), '防抖 timer 必须真的 clearTimeout');
  const from = panel.indexOf('beforeClear={() => prepareClear(');
  assert.ok(from > 0, '找不到 beforeClear 装配点');
  assert.equal(panel.slice(from, from + 220).includes('waitForQuiescence'), false, '不许绕过 prepareClear 直接等 inFlight');
});

test('G-2 不自愈 clear（自愈会删掉用户随后保存成功的新配置）', () => {
  assert.equal(panel.includes('shouldSelfHealClear'), false, 'SyncPanel 不得再引用自愈判定');
  assert.equal(guard.includes('shouldSelfHealClear'), false, '守卫模块不得再提供自愈判定');
  assert.equal(panel.includes('healRef'), false, 'healRef 已删');
});

test('G-3 回执作废时不改写保存队列', () => {
  assert.equal(panel.includes('saveQueueOnSettled(stale ?'), false, '作废分支不得强行清 inFlight/pending');
  assert.ok(panel.includes('if (!stale) {'), '补发只能在非作废分支里做');
  assert.ok(panel.includes('const settled = saveQueueOnSettled(saveQueueRef.current)'), 'settled 必须基于当前队列');
});

test('G-4 关闭配置弹窗复位脏标记', () => {
  const from = panel.indexOf('const closeChannelDialog');
  assert.ok(from > 0, '找不到 closeChannelDialog');
  assert.ok(panel.slice(from, from + 800).includes('dirtyRef.current = resetDirty(); setChannelOpen(false)'), '关闭=放弃未落盘输入，脏标记必须复位');
});
