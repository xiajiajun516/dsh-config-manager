/**
 * checkpoint 展示模型的护栏（纯函数；对应 src/ui/checkpoint-view.ts）。
 *
 * 钉住四件事：① 未知码/未知态**回落 unknown 键**（绝不裸渲染机器码）；
 * ② 用户自由文本（note）与宿主技术细节（detail）**渲染前必过 redact**；
 * ③ 「可回滚 / 可删除」的判定与引擎口径一致（protected / incomplete / 段可回滚性）；
 * ④ 预览默认勾选 = 只勾**可回滚**的段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHECKPOINT_CODE_UNKNOWN_KEY,
  CHECKPOINT_STATE_UNKNOWN_KEY,
  checkpointChunksFromText,
  checkpointCodeKey,
  checkpointDefaultSegments,
  checkpointGuidanceRows,
  checkpointOutcome,
  checkpointPreviewRows,
  checkpointRewindRows,
  checkpointRows,
  checkpointSamePoint,
  checkpointSessionCwd,
  checkpointSessionOptions,
  checkpointStateKey,
  type CheckpointListResult,
  type CheckpointPreviewResult,
  type CheckpointRewindResult,
  type CheckpointSummary,
} from './checkpoint-view.ts'

function track(over: Partial<CheckpointSummary['tracks'][number]> = {}): CheckpointSummary['tracks'][number] {
  return { state: 'workspace', ok: true, degraded: false, capturedAt: 1, reasonCode: null, entries: 3, bytes: 12, cursorBytes: null, restorable: true, ...over }
}

function summary(over: Partial<CheckpointSummary> = {}): CheckpointSummary {
  return {
    id: 'cp-1', kind: 'manual', createdAt: 1_700_000_000_000, spreadMs: 12,
    protected: false, incomplete: false, note: null,
    tracks: [track({ state: 'workspace' }), track({ state: 'session', cursorBytes: 4096 }), track({ state: 'config' })],
    ...over,
  }
}

function list(records: CheckpointSummary[]): CheckpointListResult {
  return { storage: { available: true, root: 'C:/home/.dsh/dsh-config-manager/checkpoints', guidance: [], requirements: [] }, records, maxRecords: 50 }
}

test('checkpointRows：三态徽章语义 + 可回滚/可删除判定', () => {
  const rows = checkpointRows(list([
    summary({ id: 'ok' }),
    summary({ id: 'degraded', tracks: [track({ degraded: true })] }),
    summary({ id: 'missing-track', tracks: [track({ ok: false, restorable: false, reasonCode: 'capture-failed' })] }),
    summary({ id: 'protected', protected: true }),
    summary({ id: 'incomplete', incomplete: true }),
    summary({ id: 'guard', kind: 'guard' }),
  ]))
  assert.equal(rows.length, 6)
  assert.equal(rows[0]?.tracks[0]?.badgeKind, 'ok')
  assert.equal(rows[1]?.tracks[0]?.badgeKind, 'warn', '捕获不完整 = warn')
  assert.equal(rows[2]?.tracks[0]?.badgeKind, 'error', '没捕到 = error')
  assert.equal(rows[2]?.tracks[0]?.reasonKey, 'checkpoint.code.capture-failed')
  assert.equal(rows[2]?.rewindable, false, '没有可回滚段 → 不可回滚')
  assert.equal(rows[3]?.rewindable, false, '保护点不可回滚')
  assert.equal(rows[3]?.removable, false, '保护点不可删除')
  assert.equal(rows[4]?.rewindable, false, '三态不全缺省不可回滚（引擎侧同样拒绝）')
  assert.equal(rows[4]?.removable, true)
  assert.equal(rows[5]?.kind, 'guard')
  assert.equal(rows[5]?.kindKey, 'checkpoint.kind.guard')
  assert.equal(rows[0]?.rewindable, true)
})

test('checkpointRows：note 渲染前过 redact（用户自由文本不得明文上屏）', () => {
  const rows = checkpointRows(list([summary({ note: 'before refactor password=Hunter2Secret' })]))
  assert.ok(rows[0]?.note !== null)
  assert.equal(rows[0]!.note!.includes('Hunter2Secret'), false, 'note 里的敏感值必须被掩码')
  assert.equal(checkpointRows(null).length, 0, 'null 列表 → 空数组（不抛）')
})

test('未知码 / 未知态一律回落 unknown 键（绝不裸渲染机器码）', () => {
  assert.equal(checkpointStateKey('session'), 'checkpoint.state.session')
  assert.equal(checkpointStateKey('nope'), CHECKPOINT_STATE_UNKNOWN_KEY)
  assert.equal(checkpointCodeKey('session-active'), 'checkpoint.code.session-active')
  assert.equal(checkpointCodeKey(null), CHECKPOINT_CODE_UNKNOWN_KEY)
  assert.equal(checkpointCodeKey(''), CHECKPOINT_CODE_UNKNOWN_KEY)
  const guidance = checkpointGuidanceRows([{ code: 'mountStorage' }, { code: 'probeDetail', detail: 'https://h/p?token=abc123456' }])
  assert.equal(guidance[0]?.key, 'checkpoint.guidance.mountStorage')
  assert.equal(guidance[0]?.detail, null)
  assert.equal(guidance[1]?.detail?.includes('abc123456'), false, 'guidance detail 必须脱敏')
})

test('checkpointPreviewRows + 默认勾选：只勾可回滚的段', () => {
  const preview = {
    ok: true, code: 'ok', id: 'cp-1',
    samePoint: { samePoint: false, spreadMs: 9000, toleranceMs: 5000, reason: 'spread' },
    storage: { available: true, root: 'x', guidance: [], requirements: [] },
    guidance: [], warnings: [],
    segments: [
      { state: 'workspace', available: true, reasonCode: null, detail: [], planned: 5, changed: 2, missing: 1, leftovers: ['a', 'b'], leftoversTruncated: false },
      { state: 'session', available: false, reasonCode: 'session-active', detail: [], planned: 0, changed: 0, missing: 0, leftovers: [], leftoversTruncated: false, cursorNow: 10, cursorTarget: 20, active: true },
      { state: 'config', available: true, reasonCode: null, detail: [], planned: 3, changed: 0, missing: 0, leftovers: [], leftoversTruncated: false },
    ],
  } as unknown as CheckpointPreviewResult
  const rows = checkpointPreviewRows(preview)
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.planned, 5)
  assert.equal(rows[0]?.leftovers, 2)
  assert.equal(rows[1]?.available, false)
  assert.equal(rows[1]?.reasonKey, 'checkpoint.code.session-active', '不可用的段必须给原因码')
  assert.equal(rows[1]?.active, true)
  assert.deepEqual(checkpointDefaultSegments(preview), ['workspace', 'config'], '默认只勾可回滚段')
  const verdict = checkpointSamePoint(preview)
  assert.equal(verdict?.key, 'checkpoint.samePoint.no')
  assert.equal(verdict?.ms, '9000')
  assert.equal(verdict?.reasonKey, 'checkpoint.samePoint.reason.spread', 'reason 也是枚举 → 字典键')
  assert.equal(checkpointSamePoint(null), null)
})

test('checkpointRewindRows + outcome：逐段状态与总体结论（unknown 回落）', () => {
  const result = {
    ok: false, outcome: 'partial', code: 'restore-failed', id: 'cp-1', skippedSegments: [],
    storage: { available: true, root: 'x', guidance: [], requirements: [] }, guidance: [], warnings: [],
    segments: [
      { state: 'workspace', status: 'restored', detail: ['wrote 3 files'], restored: 3, failed: 0, leftovers: [], leftoversTruncated: false },
      { state: 'config', status: 'failed', reasonCode: 'restore-failed', detail: ['EACCES on C:/x'], restored: 0, failed: 2, leftovers: ['new.json'], leftoversTruncated: false },
    ],
  } as unknown as CheckpointRewindResult
  const rows = checkpointRewindRows(result)
  assert.equal(rows[0]?.statusKey, 'checkpoint.segment.restored')
  assert.equal(rows[0]?.badgeKind, 'ok')
  assert.equal(rows[1]?.statusKey, 'checkpoint.segment.failed')
  assert.equal(rows[1]?.badgeKind, 'error')
  assert.equal(rows[1]?.failed, 2)
  assert.equal(rows[1]?.leftovers, 1)
  assert.equal(checkpointOutcome(result.outcome).key, 'checkpoint.outcome.partial')
  assert.equal(checkpointOutcome('restored').badgeKind, 'ok')
  assert.equal(checkpointOutcome('denied').badgeKind, 'error')
  assert.equal(checkpointOutcome('weird').key, 'checkpoint.outcome.unknown', '未知结论回落 unknown')
})

test('会话候选：按最近活动倒序、cwd 缺失为 null（绝不猜）', () => {
  const response = { rows: [
    { unitId: '--A--/old', sessionId: 'old', projectKey: '--A--', severity: 'ok', issues: [], mtimeMs: 100, cwd: 'C:/proj/a' },
    { unitId: '--B--/new', sessionId: 'new', projectKey: '--B--', severity: 'ok', issues: [], mtimeMs: 900 },
    { unitId: '--C--/none', sessionId: 'none', projectKey: '--C--', severity: 'ok', issues: [] },
  ] } as unknown as Parameters<typeof checkpointSessionOptions>[0]
  const options = checkpointSessionOptions(response)
  assert.deepEqual(options.map((o) => o.unitId), ['--B--/new', '--A--/old', '--C--/none'])
  assert.equal(options[0]?.cwd, null, '没有 cwd 记录 → null（不填不猜）')
  assert.equal(checkpointSessionCwd(options, '--A--/old'), 'C:/proj/a')
  assert.equal(checkpointSessionCwd(options, '--B--/new'), null)
  assert.equal(checkpointSessionCwd(options, ''), null)
})

test('checkpointChunksFromText：逐行 trim、去空行、去重（CRLF 也认）', () => {
  assert.deepEqual(
    checkpointChunksFromText('  C:/proj/a \r\n\nC:/proj/b\nC:/proj/a  \n'),
    ['C:/proj/a', 'C:/proj/b'],
  )
  assert.deepEqual(checkpointChunksFromText('   '), [])
})
