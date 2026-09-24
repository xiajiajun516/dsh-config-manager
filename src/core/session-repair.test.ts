/**
 * 离线会话修复规划单测（issue #45 Fix 3，纯函数）。
 *
 * 钉住的语义：判定口径与在线 planner 一致（同一 projectKeyOf）；不确定的一律只报告（缺 cwd /
 * 多 generation 不一致 / 加锁 / 未点名 keep 的重复 id），--map 命中才改写首帧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSessionRepair, sessionRepairNeedsAttention } from './session-repair.ts';
import type { RepairSessionInput } from './session-repair.ts';

function session(over: Partial<RepairSessionInput> = {}): RepairSessionInput {
  return { sessionId: 'session-a', fromProjectKey: '--D-Real-proj--', dir: 'D:/home/sessions/--D-Real-proj--/session-a', cwd: 'D:/Real/proj', ...over };
}

test('位置正确 → ok（不落盘）', () => {
  const plan = planSessionRepair([session()]);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.kind, 'ok');
  assert.equal(plan.actions[0]?.reason, 'already-placed');
  assert.equal(plan.actions[0]?.applies, false);
  assert.equal(sessionRepairNeedsAttention(plan), false);
});

test('位置错 → move（目标段 = projectKeyOf(header cwd)，无需映射）', () => {
  const plan = planSessionRepair([session({ fromProjectKey: '--D-Ghost-proj--' })]);
  const action = plan.actions[0]!;
  assert.equal(action.kind, 'move');
  assert.equal(action.toProjectKey, '--D-Real-proj--');
  assert.equal(action.applies, true);
  assert.equal(plan.summary.move, 1);
  assert.equal(sessionRepairNeedsAttention(plan), true);
});

test('--map 命中 → rewrite-move（先改写首帧再搬家）', () => {
  const plan = planSessionRepair(
    [session({ cwd: 'C:/Users/alice/proj', fromProjectKey: '--C-Users-alice-proj--' })],
    { mappings: [{ oldPrefix: 'C:/Users/alice', newPrefix: 'D:/Work' }] },
  );
  const action = plan.actions[0]!;
  assert.equal(action.kind, 'rewrite-move');
  assert.deepEqual(action.rewrite, { from: 'C:/Users/alice/proj', to: 'D:/Work/proj' });
  assert.equal(action.toProjectKey, '--D-Work-proj--');
  assert.equal(action.applies, true);
});

test('--map 与原值等价 → 不产生改写（只按原文判定位置）', () => {
  const plan = planSessionRepair(
    [session()],
    { mappings: [{ oldPrefix: 'D:/Real', newPrefix: 'D:/Real' }] },
  );
  assert.equal(plan.actions[0]?.kind, 'ok');
  assert.equal(plan.actions[0]?.rewrite, undefined);
});

test('缺 cwd / 多 generation 不一致 / 加锁 → 只报告（applies=false）', () => {
  const noCwd = planSessionRepair([session({ cwd: undefined })]);
  assert.equal(noCwd.actions[0]?.kind, 'skip');
  assert.equal(noCwd.actions[0]?.reason, 'no-cwd');
  const inconsistent = planSessionRepair([session({ consistent: false })]);
  assert.equal(inconsistent.actions[0]?.reason, 'inconsistent-generations');
  const locked = planSessionRepair([session({ locked: true, fromProjectKey: '--D-Ghost-proj--' })]);
  assert.equal(locked.actions[0]?.reason, 'locked');
  assert.equal(locked.actions[0]?.applies, false, '加锁目录绝不落盘');
  for (const plan of [noCwd, inconsistent, locked]) {
    assert.equal(plan.summary.skip, 1);
    assert.equal(plan.summary.move, 0);
    assert.equal(sessionRepairNeedsAttention(plan), true);
  }
});

test('重复 id：未点名 keep 只报告；点名后保留者不动、其余进隔离（只搬不删）', () => {
  const a = session({ dir: 'D:/home/sessions/--D-Real-proj--/session-a' });
  const b = session({ dir: 'D:/home/sessions/--D-Ghost-proj--/session-a' });
  const reportOnly = planSessionRepair([a, b]);
  assert.equal(reportOnly.summary.duplicates, 1);
  assert.equal(reportOnly.actions.every((x) => x.reason === 'duplicate-id' && x.applies === false), true, '没点名 keep → 一律不动');
  const withKeep = planSessionRepair([a, b], { keep: a.dir });
  assert.equal(withKeep.actions[0]?.kind, 'keep');
  assert.equal(withKeep.actions[0]?.applies, false);
  assert.equal(withKeep.actions[1]?.kind, 'quarantine');
  assert.equal(withKeep.actions[1]?.applies, true);
  assert.equal(withKeep.summary.quarantine, 1);
});

test('keep 路径大小写/分隔符不敏感（Windows 盘符大小写常不一致）', () => {
  const a = session({ dir: 'D:/home/sessions/--D-Real-proj--/session-a' });
  const b = session({ dir: 'D:/home/sessions/--D-Ghost-proj--/session-a' });
  const plan = planSessionRepair([a, b], { keep: 'd:\\home\\sessions\\--D-Real-proj--\\session-a' });
  assert.equal(plan.actions[0]?.kind, 'keep');
});
