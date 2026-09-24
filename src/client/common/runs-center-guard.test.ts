/**
 * 运行中心「环境锁」接线的源码级守卫。
 *
 * 为什么需要：用户报告的现场是「导入终止不了 → 锁一直被占据」，而残留锁在运行中心此前**完全看不见**
 * （它只出现在「备份 → 事故恢复」面板里）。这条链路一旦断（少拉一次 status、少一个回收按钮），
 * 用户能做的就只有一遍遍点终止。四个必须成立的点：
 *  ① 必须真的读锁状态（`recoveryApi.status()`），且**读失败不得静默**（要落成 lockError 显示出来）；
 *  ② 必须提供回收动作（`recoverStaleLock(true)`，userConfirmed 由用户点击表达）；
 *  ③ FREE 不得显示卡片（空闲是常态，不能天天摆一张卡）；
 *  ④ **活锁不得给回收按钮** —— 宿主按设计拒绝回收活锁（防并发写），给按钮只会制造「点了没用」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fsSync.readFileSync(path.join(root, 'src/client/common/RunsCenter.tsx'), 'utf8');

test('L-01 运行中心必须轮询环境锁状态，且读失败要如实显示（不静默）', () => {
  assert.ok(source.includes('recoveryApi.status()'), '必须读 /recovery/status 的 lock 字段');
  assert.ok(source.includes('setLockError('), '读不到锁状态必须落成可见提示，不得吞掉');
  assert.ok(source.includes("t('runs.lock.readFailed'"), '必须有对应的用户可读文案');
});

test('L-02 必须提供「回收残留锁」动作（userConfirmed 由用户点击表达）', () => {
  assert.ok(source.includes('recoveryApi.recoverStaleLock(true)'), '回收必须显式 userConfirmed=true');
  assert.ok(source.includes("t('runs.lock.recoverOk')"), '成功要有反馈');
  assert.ok(source.includes("t('runs.lock.recoverRefused'"), '被拒绝（活锁/无法判定）必须如实说明，不得报成功');
});

test('L-03 三种锁态语义分离：FREE 不显示、活锁不给回收按钮', () => {
  assert.ok(source.includes("if (state === 'FREE') return 'free'"), 'FREE 必须单独分类');
  assert.ok(source.includes("if (state === 'LOCKED') return 'held'"), '活锁必须单独分类');
  assert.ok(source.includes("lockKind(lock.state) !== 'free'"), 'FREE 不得渲染卡片');
  assert.ok(source.includes('{attention && ('), '回收按钮只对需要处理的状态渲染');
});

test('L-04 终止等待状态必须在卡片上可见（等多久 + 超阈值给出路）', () => {
  assert.ok(source.includes('card.cancelWait !== null'), '必须渲染等待态');
  assert.ok(source.includes("t('runs.cancelStuck')"), '超过阈值必须给出「先跳过 / 否则重启」的出路文案');
  assert.ok(source.includes('runs.cancelWaiting'), '必须显示已等待时长');
});
