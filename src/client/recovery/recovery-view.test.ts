/**
 * Recovery 纯渲染模型测试（§10.3）：recovery-view.ts 的纯函数。
 * 覆盖：状态分类（NORMAL / RECOVERY_REQUIRED / ROLLBACK_RECOMMENDED / ROLLBACK_CONTINUE /
 * RECOVERING / NEEDS_ATTENTION）、incident 渲染模型（actionable / isContinue）、
 * preview 渲染模型、verdict 映射（MATCH/PARTIAL_MATCH/MISMATCH/VERIFICATION_ERROR）、
 * snapshot 可信判定、排序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSnapshotTrusted, isVerdictAttention, isVerdictSuccess, recoveryBlockReason, sortIncidentsByNewest,
  toRecoveryPreviewView, toRecoveryView, verdictToUiState,
} from './recovery-view.ts';
import type { RecoveryStatus } from '../../ui/types.ts';

function mkStatus(overrides: Partial<RecoveryStatus> = {}): RecoveryStatus {
  return {
    incidents: [],
    running: [],
    ...overrides,
  };
}

test('toRecoveryView：无 incident → NORMAL + recoveryRequired=false', () => {
  const v = toRecoveryView(mkStatus());
  assert.equal(v.state, 'NORMAL');
  assert.equal(v.recoveryRequired, false);
  assert.deepEqual(v.incidents, []);
  assert.equal(v.lock, null);
  assert.equal(v.safeModeStuck, false, '未阻断时不渲染解除入口');
  assert.equal(v.safeModeBlocked, false);
});

/* --------------- issue #56：SAFE MODE 仍在阻断时必须可见且可解除 --------------- */

test('issue#56：结案但保护仍开着（blocked + clearable）→ safeModeStuck + recoveryRequired', () => {
  const v = toRecoveryView(mkStatus({ safeMode: { blocked: true, clearable: true } }));
  assert.equal(v.safeModeBlocked, true);
  assert.equal(
    v.safeModeStuck,
    true,
    '「面板空空、写操作却 423」的这一态必须给出可执行的解除入口',
  );
  // 与残留锁同一口径：阻断写操作 ⇒ 必须算「需要处理」，否则横幅与总览入口都不出现
  assert.equal(v.recoveryRequired, true, 'SAFE MODE 阻断同样要让界面提示');
  assert.deepEqual(v.incidents, [], '该态下确实没有 incident（这正是问题所在）');
  assert.equal(v.lock, null);
});

test('issue#56：还有未解决 incident 时不给解除入口（clearable=false）', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: 'op', operationType: 'import-apply', state: 'NEEDS_ATTENTION',
      decision: 'needs-attention', snapshotId: null, reason: '', createdAt: '2026-01-01T00:00:00.000Z',
    }],
    safeMode: { blocked: true, clearable: false },
  }));
  assert.equal(v.safeModeBlocked, true, '保护确实开着');
  assert.equal(v.safeModeStuck, false, '有事项可处理 ⇒ 不该出现「解除」按钮（宿主也会拒绝）');
  assert.equal(v.recoveryRequired, true, '由 incident 驱动');
});

test('issue#56：旧宿主不返回 safeMode → 按未阻断处理（绝不误报保护）', () => {
  const v = toRecoveryView(mkStatus());
  assert.equal(v.safeModeBlocked, false);
  assert.equal(v.safeModeStuck, false);
  assert.equal(v.recoveryRequired, false);
});

// ---------- issue #31：残留锁（非 journal）必须可见且可执行 ----------

test('toRecoveryView：纯残留锁（无 incident）→ lock 非空 + recoveryRequired=true', () => {
  const v = toRecoveryView(mkStatus({ lock: { state: 'STALE_LOCK_DETECTED', attention: true } }));
  assert.deepEqual(v.lock, { state: 'STALE_LOCK_DETECTED' });
  // 残留锁同样阻断所有 mutation（423）→ 必须算「需要处理」，否则横幅/总览入口都不出现
  assert.equal(v.recoveryRequired, true);
  assert.deepEqual(v.incidents, [], 'incidents 仍为空（锁不是 journal）');
});

test('toRecoveryView：LOCKED 活锁（attention=false）→ 不催用户回收', () => {
  const v = toRecoveryView(mkStatus({ lock: { state: 'LOCKED', attention: false } }));
  assert.equal(v.lock, null, '活跃持有的锁会自行释放，不渲染回收区块');
  assert.equal(v.recoveryRequired, false);
});

test('toRecoveryView：旧宿主不返回 lock 字段 → 视为无锁事项（不误报）', () => {
  const v = toRecoveryView({ incidents: [], running: [] });
  assert.equal(v.lock, null);
  assert.equal(v.recoveryRequired, false);
});

test('toRecoveryView：rollback-recommended incident → ROLLBACK_RECOMMENDED + actionable', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: '00000000-0000-4000-8000-0000000000aa',
      operationType: 'import-apply',
      state: 'NEEDS_ATTENTION',
      decision: 'rollback-recommended',
      snapshotId: 'snap-1',
      reason: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.state, 'ROLLBACK_RECOMMENDED');
  assert.equal(v.recoveryRequired, true);
  assert.equal(v.incidents[0]!.actionable, true);
  assert.equal(v.incidents[0]!.isContinue, false);
});

test('toRecoveryView：rollback-continue incident → ROLLBACK_CONTINUE + isContinue', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: '00000000-0000-4000-8000-0000000000aa',
      operationType: 'import-apply',
      state: 'NEEDS_ATTENTION',
      decision: 'rollback-continue',
      snapshotId: 'snap-1',
      reason: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.state, 'ROLLBACK_CONTINUE');
  assert.equal(v.incidents[0]!.isContinue, true);
});

test('toRecoveryView：RECOVERING incident → RECOVERING（优先于 decision）', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: '00000000-0000-4000-8000-0000000000aa',
      operationType: 'import-apply',
      state: 'RECOVERING',
      decision: 'needs-attention',
      snapshotId: 'snap-1',
      reason: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.state, 'RECOVERING');
});

test('toRecoveryView：needs-attention incident → NEEDS_ATTENTION + 不可执行', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: '00000000-0000-4000-8000-0000000000aa',
      operationType: 'import-apply',
      state: 'NEEDS_ATTENTION',
      decision: 'needs-attention',
      snapshotId: null,
      reason: '无 trusted snapshot',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.state, 'NEEDS_ATTENTION');
  assert.equal(v.incidents[0]!.actionable, false, 'needs-attention 不可执行');
});

test('toRecoveryView：needs-attention 但 snapshot 存在 → 仍不可执行（decision 权威）', () => {
  const v = toRecoveryView(mkStatus({
    incidents: [{
      operationId: '00000000-0000-4000-8000-0000000000aa',
      operationType: 'import-apply',
      state: 'NEEDS_ATTENTION',
      decision: 'needs-attention',
      snapshotId: 'snap-1',
      reason: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.incidents[0]!.actionable, false, 'decision=needs-attention 即使有 snapshot 也不可执行');
});

test('toRecoveryPreviewView：映射 + actionable 判定', () => {
  const pv = toRecoveryPreviewView({
    operationId: '00000000-0000-4000-8000-0000000000aa',
    operationType: 'import-apply',
    state: 'NEEDS_ATTENTION',
    decision: 'rollback-recommended',
    snapshotId: 'snap-1',
    snapshotVerdict: 'TRUSTED_OPERATION_SNAPSHOT',
    snapshotMeta: { id: 'snap-1', createdAt: '2026-01-01T00:00:00.000Z', operationType: 'import-apply' },
    environmentFingerprint: 'fp',
    environmentCompatible: true,
    reason: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(pv.actionable, true);
  assert.equal(pv.environmentCompatible, true);
});

test('verdictToUiState：四 verdict 映射', () => {
  assert.equal(verdictToUiState('MATCH'), 'MATCH');
  assert.equal(verdictToUiState('PARTIAL_MATCH'), 'PARTIAL_MATCH');
  assert.equal(verdictToUiState('MISMATCH'), 'MISMATCH');
  assert.equal(verdictToUiState('VERIFICATION_ERROR'), 'VERIFICATION_ERROR');
});

test('isVerdictSuccess / isVerdictAttention：MATCH/PARTIAL_MATCH 成功，MISMATCH/ERROR 需人工', () => {
  assert.equal(isVerdictSuccess('MATCH'), true);
  assert.equal(isVerdictSuccess('PARTIAL_MATCH'), true);
  assert.equal(isVerdictSuccess('MISMATCH'), false);
  assert.equal(isVerdictSuccess('VERIFICATION_ERROR'), false);
  assert.equal(isVerdictAttention('MISMATCH'), true);
  assert.equal(isVerdictAttention('VERIFICATION_ERROR'), true);
  assert.equal(isVerdictAttention('MATCH'), false);
});

test('isSnapshotTrusted：仅 TRUSTED_OPERATION_SNAPSHOT 可信', () => {
  assert.equal(isSnapshotTrusted('TRUSTED_OPERATION_SNAPSHOT'), true);
  assert.equal(isSnapshotTrusted('TRUSTED_MANUAL_LOCAL'), false);
  assert.equal(isSnapshotTrusted('LEGACY_REQUIRES_CONFIRMATION'), false);
  assert.equal(isSnapshotTrusted('CORRUPT'), false);
  assert.equal(isSnapshotTrusted(null), false);
});

test('sortIncidentsByNewest：按 createdAt 倒序', () => {
  const a = { operationId: 'a', operationType: 'x', state: 'NEEDS_ATTENTION', decision: 'needs-attention' as const, snapshotId: null, reason: '', createdAt: '2026-01-01T00:00:00.000Z' };
  const b = { operationId: 'b', operationType: 'x', state: 'NEEDS_ATTENTION', decision: 'needs-attention' as const, snapshotId: null, reason: '', createdAt: '2026-01-02T00:00:00.000Z' };
  const sorted = sortIncidentsByNewest([a, b]);
  assert.equal(sorted[0]!.operationId, 'b');
  assert.equal(sorted[1]!.operationId, 'a');
});

// ---------- 正在正常执行的操作（本轮修复：不再当成「未完成的恢复事项」） ----------

test('toRecoveryView：live[] 映射为 activeOperations，且不改变 state / recoveryRequired', () => {
  const v = toRecoveryView(mkStatus({
    live: [{
      operationId: '00000000-0000-4000-8000-0000000000bb',
      operationType: 'autosync-push',
      state: 'APPLYING',
      startedAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  assert.equal(v.activeOperations.length, 1);
  assert.equal(v.activeOperations[0]!.operationType, 'autosync-push');
  assert.equal(v.activeOperations[0]!.state, 'APPLYING');
  // 正在跑不是问题：既不进 incidents，也不触发「需要恢复」的横幅
  assert.deepEqual(v.incidents, []);
  assert.equal(v.recoveryRequired, false);
  assert.equal(v.state, 'NORMAL');
});

test('toRecoveryView：旧宿主不返回 live 字段 → activeOperations 为空数组（不误报正在跑）', () => {
  const v = toRecoveryView({ incidents: [], running: [] });
  assert.deepEqual(v.activeOperations, []);
});

test('recoveryBlockReason：与 actionable 严格互补（面板据此解释「为什么灰」）', () => {
  // needs-attention 优先：即使有快照，阻塞原因是「需人工处理」而不是「没快照」
  assert.equal(recoveryBlockReason({ decision: 'needs-attention', snapshotId: 'snap-1' }), 'needsAttention');
  assert.equal(recoveryBlockReason({ decision: 'needs-attention', snapshotId: null }), 'needsAttention');
  // 能恢复的决策但没有可信快照 → 无快照可回滚
  assert.equal(recoveryBlockReason({ decision: 'rollback-recommended', snapshotId: null }), 'noSnapshot');
  // 判据必须与 actionable 逐字同口径（:108 只认 null / ''），所以这里也只断言这两种形态
  assert.equal(recoveryBlockReason({ decision: 'rollback-recommended', snapshotId: '' }), 'noSnapshot');
  // 可执行 → 无阻塞原因
  assert.equal(recoveryBlockReason({ decision: 'rollback-recommended', snapshotId: 'snap-1' }), null);
  assert.equal(recoveryBlockReason({ decision: 'rollback-continue', snapshotId: 'snap-1' }), null);
});
