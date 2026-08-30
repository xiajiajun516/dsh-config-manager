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
  isSnapshotTrusted, isVerdictAttention, isVerdictSuccess, sortIncidentsByNewest,
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
