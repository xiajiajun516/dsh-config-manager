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

/**
 * P9-6（时序）守卫：轮询重叠 + 决策框自己弹回来。
 * 断言一律钉在**调用表达式**上：删掉实现（或把调用挪走）必红，改注释不会误绿。
 */
test('S-01 轮询必须有请求序号守卫（旧响应不得覆盖新数据）', () => {
  assert.ok(source.includes('const seq = seqRef.current + 1'), '每次 refresh 必须领一个新的请求序号');
  assert.ok(source.includes("from './runs-center-view.ts'"), '判定必须来自纯函数模块（可单测）');
  assert.ok(
    (source.match(/if \(!isStaleResponse\(runsSeqRef\.current, seq\)\) \{/g) ?? []).length >= 2,
    'runs 通道的成功/失败两条落地路径都必须先判陈旧（否则旧进度会写回去）',
  );
  assert.ok(
    (source.match(/if \(!isStaleResponse\(lockSeqRef\.current, seq\)\) \{/g) ?? []).length >= 2,
    'lock 通道同样要判（否则旧锁状态会盖掉新的）',
  );
  assert.equal(
    (source.match(/if \(isStaleResponse\(\w+SeqRef\.current, seq\)\) return/g) ?? []).length, 0,
    '判陈旧不得 return：下一个请求（锁状态）与 runs 是两条独立通道，连带跳过会让锁刷新跟着停摆',
  );
});

test('S-05 提交决策后必须同样登记「已忽略」，否则框会用陈旧快照把已结案的 run 重新弹开', () => {
  assert.ok(
    source.includes('dismissedRef.current.add(dialogKeyOf(run))'),
    '确认出口在 setDialogRun(null) 之前必须登记 key（此刻 refresh 还没回来，runs 里那条 run 仍在等决定）',
  );
});

test('S-06 框里那条 run 结案后必须自动关闭（否则一个过时的提问会挡住后面所有等待）', () => {
  assert.ok(source.includes('isDialogStillWaiting(dialogRun, runs)'), '必须用纯函数判定「还在等吗」');
  assert.ok(
    /if \(dialogRun !== null\) \{[\s\S]{0,400}?isDialogStillWaiting\(dialogRun, runs\)\) setDialogRun\(null\)/.test(source),
    '判定为已结案时必须真的关框，而不是只判不用',
  );
});

test('S-02 关闭决策框必须登记「已忽略」，否则 1.5s 后同一个等待事件又弹回来', () => {
  assert.ok(source.includes('dismissedRef.current.add(dialogKeyOf(dialogRun))'), 'onCancel 必须按稳定 key 记住这次忽略');
  assert.ok(source.includes('onCancel={dismissDialog}'), '对话框的取消出口必须走登记函数');
  assert.ok(
    !source.includes('onCancel={() => { setDialogRun(null) }}'),
    '旧的「只清 dialogRun」写法必须拆掉 —— 它就是框自己弹回来的原因',
  );
});

test('S-03 自动弹框必须走 pickWaitingRun，且每轮裁剪忽略集合（有界）', () => {
  assert.ok(source.includes('pickWaitingRun(runs, dismissedRef.current)'), '选择逻辑必须在纯函数里，且真的把忽略集合传进去');
  assert.ok(
    source.includes('dismissedRef.current = pruneDismissed(dismissedRef.current, runs)'),
    '每轮必须裁剪已不在等待的键，否则集合无界增长',
  );
  assert.ok(source.includes('const waiting = pickWaitingRun('), '弹框条件不得内联回 effect（内联即绕过忽略集合）');
});

test('S-04 忽略集合必须是每实例状态，不得是模块级单例', () => {
  assert.ok(source.includes('useRef<Set<DialogKey>>(new Set())'), '必须是组件内 useRef（多实例各一份）');
  const moduleLevel = /^(?:export\s+)?(?:const|let|var)\s+\w*[Dd]ismissed\w*\s*(?::[^=\n]*)?=/m;
  assert.equal(moduleLevel.test(source), false, '模块级 dismissed 单例会让多个面板/页面互相串味');
});
