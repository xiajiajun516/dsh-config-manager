import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostLifecycle } from './lifecycle-hooks.ts';

interface Recorder {
  calls: string[]
  effects: Array<{ label: string; dispose: () => void }>
}

function harness(overrides: Partial<{ releaseLockThrows: boolean }> = {}): {
  rec: Recorder
  lifecycle: ReturnType<typeof createHostLifecycle>
  /** 注入的退出释放函数（判定 'exit' 监听有无用它做身份比对，别用进程级计数）。 */
  release: () => void
  /** 卸载全部已注册的 effect（测试收尾：别把 exit 监听留给下一个用例）。 */
  disposeAll: () => void
} {
  const rec: Recorder = { calls: [], effects: [] };
  const release = (): void => {
    if (overrides.releaseLockThrows === true) throw new Error('release failed');
    rec.calls.push('lock.release');
  };
  const lifecycle = createHostLifecycle({
    scheduler: { start: () => { rec.calls.push('autosync.start'); }, stop: () => { rec.calls.push('autosync.stop'); } },
    backupScheduler: { start: () => { rec.calls.push('backup.start'); }, stop: () => { rec.calls.push('backup.stop'); } },
    releaseLockOnExit: release,
    profileRuntime: {
      startHeartbeat: () => { rec.calls.push('heartbeat.start'); return () => { rec.calls.push('heartbeat.stop'); }; },
      withdraw: () => { rec.calls.push('heartbeat.withdraw'); },
    },
    effect: (label, setup) => { rec.effects.push({ label, dispose: setup() }); },
  });
  return { rec, lifecycle, release, disposeAll: () => { for (const e of rec.effects) e.dispose(); } };
}

test('HL-1 分类 NORMAL 且已 arm → 两个调度器都启动，顺序固定', () => {
  const { rec, lifecycle } = harness();
  lifecycle.arm();
  lifecycle.onStartupClassified('NORMAL');
  assert.deepEqual(rec.calls, ['autosync.start', 'backup.start']);
  assert.equal(lifecycle.started(), true);
});

test('HL-2 先分类后 arm（apply 同步晚一步的竞态）→ 同样启动', () => {
  const { rec, lifecycle } = harness();
  lifecycle.onStartupClassified('NORMAL');
  assert.deepEqual(rec.calls, []);
  lifecycle.arm();
  assert.deepEqual(rec.calls, ['autosync.start', 'backup.start']);
});

test('HL-3 结论 BLOCKED → 永不启动；后续再给 NORMAL 也不启动（分类结论只有一次）', () => {
  const { rec, lifecycle } = harness();
  lifecycle.arm();
  lifecycle.onStartupClassified('BLOCKED');
  lifecycle.onStartupClassified('NORMAL');
  assert.deepEqual(rec.calls, []);
  assert.equal(lifecycle.started(), false);
});

test('HL-4 只启动一次：arm 与分类重复调用都不重复 start', () => {
  const { rec, lifecycle } = harness();
  lifecycle.arm();
  lifecycle.arm();
  lifecycle.onStartupClassified('NORMAL');
  lifecycle.onStartupClassified('NORMAL');
  lifecycle.arm();
  assert.deepEqual(rec.calls, ['autosync.start', 'backup.start']);
});

test('HL-5 mount 注册四条卸载清理；重复 mount 不重复注册', () => {
  const { rec, lifecycle, disposeAll } = harness();
  lifecycle.mount();
  lifecycle.mount();
  assert.deepEqual(rec.effects.map((e) => e.label), [
    'config-manager: backup scheduler',
    'config-manager: autosync scheduler',
    'config-manager: environment lock exit release',
    'config-manager: profile runtime heartbeat',
  ]);
  disposeAll();
});

test('HL-6 卸载：先停调度器，再摘 exit 监听并释放锁，最后撤回心跳', () => {
  const { rec, lifecycle, release, disposeAll } = harness();
  lifecycle.mount();
  assert.ok(process.listeners('exit').includes(release), 'mount 后必须有退出监听');
  // ctx.effect 语义：setup 立即执行（心跳此刻起报），dispose 时才跑返回的清理
  assert.deepEqual(rec.calls, ['heartbeat.start']);
  disposeAll();
  assert.deepEqual(rec.calls, [
    'heartbeat.start',
    'backup.stop',
    'autosync.stop',
    'lock.release',
    'heartbeat.stop',
    'heartbeat.withdraw',
  ]);
  assert.equal(process.listeners('exit').includes(release), false, 'exit 监听必须被移除（不留孤儿）');
});

test('HL-7 释放抛错不影响卸载链的其余步骤', () => {
  const { rec, lifecycle, release } = harness({ releaseLockThrows: true });
  lifecycle.mount();
  const exitEffect = rec.effects[2];
  assert.ok(exitEffect !== undefined);
  assert.throws(() => { exitEffect.dispose(); }, /release failed/);
  assert.equal(process.listeners('exit').includes(release), false, '抛错前必须先摘监听');
  // 收尾：心跳 effect 还在，手动卸掉
  for (const e of rec.effects) { if (e !== exitEffect) e.dispose(); }
});
