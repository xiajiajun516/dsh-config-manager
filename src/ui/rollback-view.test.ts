/**
 * rollback 展示模型的护栏（纯函数；对应 src/ui/rollback-view.ts）。
 *
 * 钉住六件事：
 *  ① 未知码 / 未知态 / 未知来源**回落 unknown 键**（绝不裸渲染机器码）；
 *  ② 用户自由文本（note）与宿主技术细节（detail / guidance.detail / 路径清单）**渲染前必过 redact**；
 *  ③ 「可回退 / 可删除」的判定（受保护 / 两态不全 / 段可回退性 / 至少一段可用）；
 *  ④ mode 三选一映射（files+session / files / session）+ 未知回落；
 *  ⑤ 预览计数文案（overwrite / different / missing / createdAfter；清单按长度算）；
 *  ⑥ **只出现 workspace + session 两态**（源码级：第三态 config 已绝迹）；
 *  ⑦ 按会话分组的时间线（组内保序 / 组间按最新时间倒序 / 未知会话排最后）+ 时间线行事实
 *     （文件数 / 是否有会话游标）+ 预览的字节游标（t3 面板要用的三样）。
 *
 * 字段口径与 T1 宿主侧 src/core/rollback-point.ts 逐字段对齐（2026-10-10 双人确认）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ROLLBACK_CODE_UNKNOWN_KEY,
  ROLLBACK_CODES,
  ROLLBACK_GUIDANCE_UNKNOWN_KEY,
  ROLLBACK_KIND_UNKNOWN_KEY,
  ROLLBACK_MAX_POINTS_PER_SESSION,
  ROLLBACK_MAX_POINTS_TOTAL,
  ROLLBACK_MODES,
  ROLLBACK_MODE_UNKNOWN_KEY,
  ROLLBACK_STATES,
  ROLLBACK_STATE_UNKNOWN_KEY,
  ROLLBACK_WARN_CODES,
  ROLLBACK_WARN_UNKNOWN_KEY,
  isRollbackMode,
  isRollbackState,
  rollbackChildSession,
  rollbackCodeKey,
  ROLLBACK_NOTICE_SKIPPED_KEY,
  ROLLBACK_NOTICE_TRUNCATED_KEY,
  ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY,
  ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY,
  ROLLBACK_PREVIEW_REASON_GUARD_KEY,
  ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY,
  ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY,
  rollbackGuidanceRows,
  rollbackModeFromSegments,
  rollbackPointGroups,
  rollbackRowFileCount,
  rollbackRowHasSessionCursor,
  rollbackModeKey,
  rollbackModeSegments,
  rollbackOutcome,
  rollbackPointRows,
  rollbackPreviewGuidance,
  rollbackPreviewRows,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  rollbackRewindCounts,
  rollbackRewindRows,
  rollbackSkippedSegments,
  rollbackStateKey,
  type RollbackListResult,
  type RollbackPointSummary,
  type RollbackPreviewResult,
  type RollbackRewindResult,
  type RollbackSegmentSummary,
} from './rollback-view.ts'

const SOURCE_PATH = fileURLToPath(new URL('./rollback-view.ts', import.meta.url))

function segment(over: Partial<RollbackSegmentSummary> = {}): RollbackSegmentSummary {
  return { state: 'workspace', ok: true, degraded: false, reasonCode: null, entries: 3, bytes: 12, cursorBytes: null, restorable: true, ...over }
}

function point(over: Partial<RollbackPointSummary> = {}): RollbackPointSummary {
  return {
    id: 'rp-1', createdAt: 1_700_000_000_000, sessionId: 'sess-1', turn: 7, kind: 'auto',
    protected: false, incomplete: false, note: null, spreadMs: 12,
    segments: [segment({ state: 'workspace' }), segment({ state: 'session', entries: 1, cursorBytes: 4096 })],
    ...over,
  }
}

function list(points: RollbackPointSummary[]): RollbackListResult {
  return {
    ok: true, points,
    storage: { available: true, root: 'C:/home/.dsh/dsh-config-manager/rollback-points', guidance: [], requirements: [] },
    maxRecords: 50, maxRecordsPerSession: 20,
  }
}

test('两态：只有 workspace + session，第三态 config 一律回落 unknown', () => {
  assert.deepEqual([...ROLLBACK_STATES], ['workspace', 'session'])
  assert.equal(rollbackStateKey('workspace'), 'rollback.state.workspace')
  assert.equal(rollbackStateKey('session'), 'rollback.state.session')
  assert.equal(rollbackStateKey('config'), ROLLBACK_STATE_UNKNOWN_KEY, '已删除的第三态必须回落 unknown')
  assert.equal(rollbackStateKey('something-new'), ROLLBACK_STATE_UNKNOWN_KEY)
  assert.equal(rollbackStateKey(null), ROLLBACK_STATE_UNKNOWN_KEY)
  assert.equal(isRollbackState('config'), false)
  assert.equal(isRollbackState('session'), true)
  for (const mode of ROLLBACK_MODES) {
    for (const state of rollbackModeSegments(mode)) assert.ok(ROLLBACK_STATES.includes(state), mode + ' 产出了非两态的段：' + state)
  }
  // 源码级：去掉注释后，代码里不得再出现第三态字面量
  const code = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(code.includes("'config'"), false, 'rollback-view.ts 代码里不得再出现第三态 config')
  assert.equal(code.includes('rollback.state.config'), false)
  // 列表行也只渲染两态标签
  const rows = rollbackPointRows(list([point()]))
  assert.deepEqual(rows[0]?.segments.map((s) => s.labelKey), ['rollback.state.workspace', 'rollback.state.session'])
})

test('未知 code 回落 unknown（白名单外的机器码绝不裸渲染）', () => {
  assert.equal(rollbackCodeKey('confirmation-required'), 'rollback.code.confirmation-required')
  assert.equal(rollbackCodeKey('no-boundary'), 'rollback.code.no-boundary')
  assert.equal(rollbackCodeKey('mutation-locked'), 'rollback.code.mutation-locked')
  assert.equal(rollbackCodeKey('deleted'), 'rollback.code.deleted')
  assert.equal(rollbackCodeKey('ok'), 'rollback.code.ok')
  assert.equal(rollbackCodeKey('record-incomplete'), 'rollback.code.record-incomplete')
  assert.equal(rollbackCodeKey('torn-frame'), ROLLBACK_CODE_UNKNOWN_KEY, '宿主内部分级码不在白名单 → unknown')
  assert.equal(rollbackCodeKey('session-log-missing'), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(''), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(null), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(undefined), ROLLBACK_CODE_UNKNOWN_KEY)
  for (const code of ROLLBACK_CODES) assert.equal(rollbackCodeKey(code), 'rollback.code.' + code)
  // 指引码两种形态都认：裸后缀（旧检查点引擎）与完整字典键（T1 引擎）
  const [known] = rollbackGuidanceRows([{ code: 'workspaceRolledBack', detail: 'C:/ws' }])
  assert.equal(known?.key, 'rollback.guidance.workspaceRolledBack')
  const [qualified] = rollbackGuidanceRows([{ code: 'rollback.guidance.forkUnavailable', detail: 'sess-1' }])
  assert.equal(qualified?.key, 'rollback.guidance.forkUnavailable', 'T1 回传完整字典键时必须原样认，不得回落 unknown')
  const [unknown] = rollbackGuidanceRows([{ code: 'some-new-code' }])
  assert.equal(unknown?.key, ROLLBACK_GUIDANCE_UNKNOWN_KEY)
  const [unknownQualified] = rollbackGuidanceRows([{ code: 'rollback.guidance.some-new-code' }])
  assert.equal(unknownQualified?.key, ROLLBACK_GUIDANCE_UNKNOWN_KEY, '完整键里的未知后缀同样回落 unknown')
  // 告警一族（T1 的 warnings 回传 rollback.warn.* 完整键）：不认这族会让真实告警显示成「未识别的指引」
  const [warn] = rollbackGuidanceRows([{ code: 'rollback.warn.trackMissing' }])
  assert.equal(warn?.key, 'rollback.warn.trackMissing')
  for (const code of ROLLBACK_WARN_CODES) {
    const [row] = rollbackGuidanceRows([{ code: 'rollback.warn.' + code }])
    assert.equal(row?.key, 'rollback.warn.' + code)
  }
  const [warnUnknown] = rollbackGuidanceRows([{ code: 'rollback.warn.some-new-code' }])
  assert.equal(warnUnknown?.key, ROLLBACK_WARN_UNKNOWN_KEY, '未知告警回落 rollback.warn.unknown（不是指引 unknown）')
  assert.deepEqual(rollbackGuidanceRows(undefined), [])
})

test('note / detail / guidance.detail / 路径清单 渲染前必过 redact', () => {
  const rows = rollbackPointRows(list([point({ note: 'before refactor password=Hunter2Secret' })]))
  assert.ok(rows[0]?.note !== null)
  assert.equal(rows[0]!.note!.includes('Hunter2Secret'), false, 'note 里的敏感值必须被掩码')

  const rewind: RollbackRewindResult = {
    ok: true, outcome: 'partial', code: 'ok',
    segments: [
      { state: 'workspace', status: 'restored', restored: 2, failed: 1, detail: ['write failed token=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'], leftovers: ['C:/ws/token-ghp_ZzYyXxWwVvUuTtSsRrQqPpOo.txt'] },
      { state: 'session', status: 'failed', detail: ['fork failed apiKey: sk-live-abcdefghijklmnop'], guidance: [{ code: 'rollback.guidance.forkUnavailable', detail: 'secret=SuperSecret12345' }] },
    ],
  }
  const view = rollbackRewindRows(rewind)
  assert.equal(view.length, 2)
  for (const line of view[0]!.detail) assert.equal(line.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), false, 'detail 行必须脱敏')
  for (const line of view[1]!.detail) assert.equal(line.includes('sk-live-abcdefghijklmnop'), false, 'detail 行必须脱敏')
  for (const line of view[0]!.leftovers) assert.equal(line.includes('ghp_ZzYyXxWwVvUuTtSsRrQqPpOo'), false, '路径清单也要脱敏')
  const guidance = view[1]!.guidance[0]
  assert.equal(guidance?.key, 'rollback.guidance.forkUnavailable')
  assert.ok(guidance?.detail !== null)
  assert.equal(guidance!.detail!.includes('SuperSecret12345'), false, 'guidance.detail 必须脱敏')

  const preview = rollbackPreviewRows({
    ok: true, id: 'rp-1', storage: { available: true },
    workspace: { leftovers: ['C:/ws/new-secret=PlainSecret99.txt'] },
  })
  assert.equal(preview[0]?.leftovers[0]?.includes('PlainSecret99'), false, '预览的 leftovers 清单必须脱敏')
})

test('rollbackPointRows：来源徽章 + 可回退 / 可删除判定 + 回合与留存', () => {
  const rows = rollbackPointRows(list([
    point({ id: 'ok' }),
    point({ id: 'degraded', segments: [segment({ degraded: true }), segment({ state: 'session', restorable: false, ok: false, reasonCode: 'no-boundary' })] }),
    point({ id: 'protected', protected: true }),
    point({ id: 'incomplete', incomplete: true }),
    point({ id: 'guard', kind: 'guard', turn: null }),
    point({ id: 'nothing', segments: [segment({ restorable: false })] }),
    point({ id: 'weird-kind', kind: 'legacy' }),
  ]))
  assert.equal(rows.length, 7)
  assert.equal(rows[0]?.rewindable, true)
  assert.equal(rows[0]?.removable, true)
  assert.equal(rows[0]?.kindKey, 'rollback.kind.auto')
  assert.equal(rows[0]?.turn, 7)
  assert.equal(rows[0]?.sessionId, 'sess-1')
  assert.equal(rows[0]?.segments[0]?.badgeKind, 'ok')
  assert.equal(rows[1]?.segments[0]?.badgeKind, 'warn', '捕获不完整 = warn')
  assert.equal(rows[1]?.segments[1]?.badgeKind, 'error', '没捕到 = error')
  assert.equal(rows[1]?.segments[1]?.reasonKey, 'rollback.code.no-boundary')
  assert.equal(rows[2]?.rewindable, false, '保护点不可回退')
  assert.equal(rows[2]?.removable, false, '保护点不可删除')
  assert.equal(rows[3]?.rewindable, false, '两态不全缺省不可回退')
  assert.equal(rows[3]?.removable, true)
  assert.equal(rows[3]?.badgeKind, 'warn')
  assert.equal(rows[4]?.kindKey, 'rollback.kind.guard', 'guard = 回退前救援点')
  assert.equal(rows[4]?.turn, null, '回合未知 → null（界面渲染 turnUnknown，不编造）')
  assert.equal(rows[5]?.rewindable, false, '没有可回退段 → 不可回退')
  assert.equal(rows[6]?.kindKey, ROLLBACK_KIND_UNKNOWN_KEY, '未知来源回落 unknown')
  assert.deepEqual(rollbackPointRows(null), [], 'null 列表 → 空数组（不抛）')
  assert.equal(rollbackPointRows({ ok: true, points: [], storage: { available: true } }).length, 0)
})

test('mode 三选一映射（files+session / files / session）+ 未知回落', () => {
  assert.deepEqual([...ROLLBACK_MODES], ['files+session', 'files', 'session'])
  assert.equal(rollbackModeKey('files+session'), 'rollback.mode.filesAndSession')
  assert.equal(rollbackModeKey('files'), 'rollback.mode.filesOnly')
  assert.equal(rollbackModeKey('session'), 'rollback.mode.sessionOnly')
  assert.equal(rollbackModeKey('config'), ROLLBACK_MODE_UNKNOWN_KEY)
  assert.equal(rollbackModeKey(null), ROLLBACK_MODE_UNKNOWN_KEY)
  assert.equal(isRollbackMode('files'), true)
  assert.equal(isRollbackMode('files+config'), false)
  assert.deepEqual(rollbackModeSegments('files+session'), ['workspace', 'session'])
  assert.deepEqual(rollbackModeSegments('files'), ['workspace'])
  assert.deepEqual(rollbackModeSegments('session'), ['session'])
  assert.deepEqual(rollbackModeSegments('nope'), [], '未知 mode 不猜段')
  assert.equal(rollbackModeFromSegments(['workspace']), 'files')
  assert.equal(rollbackModeFromSegments(['session']), 'session')
  assert.equal(rollbackModeFromSegments(['workspace', 'session']), 'files+session')
  assert.equal(rollbackModeFromSegments([]), 'files+session')
})

test('预览计数文案：工作区四类计数 + 会话边界/回合号', () => {
  const preview: RollbackPreviewResult = {
    ok: true, id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: { overwrite: 5, different: 2, missing: 1, createdAfter: 3, leftovers: ['a', 'b', 'c'], leftoversTruncated: false },
    session: { from: 9000, to: 4096, turns: 3, restorable: true, active: false },
  }
  const rows = rollbackPreviewRows(preview)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.state, 'workspace')
  assert.equal(rows[0]?.labelKey, 'rollback.state.workspace')
  assert.deepEqual(rows[0]?.counts, [
    { key: 'rollback.preview.overwrite', n: 5 },
    { key: 'rollback.preview.different', n: 2 },
    { key: 'rollback.preview.missing', n: 1 },
    { key: 'rollback.preview.createdAfter', n: 3 },
  ])
  assert.deepEqual(rows[0]?.leftovers, ['a', 'b', 'c'])
  assert.equal(rows[1]?.state, 'session')
  assert.deepEqual(rows[1]?.cursor, { from: 9000, to: 4096 })
  assert.equal(rows[1]?.turns, 3)
  assert.equal(rows[1]?.active, false)
  assert.deepEqual(rows[1]?.counts, [], '会话段没有覆盖计数（它不是文件覆盖）')
  // 只给清单不给计数时，计数按清单长度算
  const listed = rollbackPreviewRows({ ok: true, id: 'rp-3', storage: { available: true }, workspace: { leftovers: ['x', 'y'] } })
  assert.equal(listed[0]?.counts.find((c) => c.key === 'rollback.preview.createdAfter')?.n, 2)
  // 缺字段一律回落安全值（0 / null），不抛
  const sparse = rollbackPreviewRows({ ok: true, id: 'rp-2', storage: { available: true }, workspace: {}, session: {} })
  assert.deepEqual(sparse[0]?.counts.map((c) => c.n), [0, 0, 0, 0])
  assert.deepEqual(sparse[1]?.cursor, { from: null, to: null })
  assert.equal(sparse[1]?.turns, null)
  assert.deepEqual(rollbackPreviewRows(null), [])
})

test('预览判定：可回退 / 可删除 + 不可回退时的原因键 + mode 默认值', () => {
  const base: RollbackPreviewResult = {
    ok: true, id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: {}, session: { restorable: true },
  }
  const verdict = rollbackPreviewVerdict(base)
  assert.equal(verdict.canRestore, true)
  assert.equal(verdict.canRemove, true)
  assert.equal(verdict.reasonKey, null)
  assert.equal(verdict.mode, 'files+session')
  assert.deepEqual(verdict.segments, ['workspace', 'session'])

  const protectedPoint = rollbackPreviewVerdict({ ...base, canRestore: false, canRemove: false, code: 'protected-point' })
  assert.equal(protectedPoint.canRestore, false)
  assert.equal(protectedPoint.canRemove, false)
  assert.equal(protectedPoint.reasonKey, 'rollback.code.protected-point')

  const noSegments = rollbackPreviewVerdict({ ...base, canRestore: false, workspace: null, session: null })
  assert.equal(noSegments.canRestore, false)
  assert.equal(noSegments.reasonKey, 'rollback.preview.none')

  // 会话无稳定边界（restorable:false + no-boundary）→ 只剩工作区段
  const filesOnly = rollbackPreviewVerdict({ ...base, session: { restorable: false, reasonCode: 'no-boundary' } })
  assert.equal(filesOnly.mode, 'files')
  assert.deepEqual(filesOnly.segments, ['workspace'])

  // 工作区段显式不可用 → 只剩会话段（session 模式）
  const sessionOnly = rollbackPreviewVerdict({ ...base, workspace: { available: false, reasonCode: 'no-boundary' } })
  assert.equal(sessionOnly.mode, 'session')
  assert.deepEqual(sessionOnly.segments, ['session'])

  // 一段都不可回退时，原因取段的 reasonCode（不裸渲染机器码）
  const nothing = rollbackPreviewVerdict({ ...base, canRestore: false, workspace: { available: false }, session: { restorable: false, reasonCode: 'no-boundary' } })
  assert.equal(nothing.reasonKey, 'rollback.code.no-boundary')

  assert.equal(rollbackPreviewVerdict(null).canRestore, false, '没有预览 → 不可回退（不猜）')
  assert.equal(rollbackPreviewVerdict(null).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY)
})

test('回退结果：结论徽章 / 段状态 / 计数 / 未执行段 / fork 子会话（S3）', () => {
  const restored: RollbackRewindResult = {
    ok: true, outcome: 'restored', code: 'ok', childSessionId: 'child-9', guardPointId: 'guard-2',
    segments: [
      { state: 'workspace', status: 'restored', restored: 3, failed: 0, leftovers: ['a.txt', 'b.txt'] },
      { state: 'session', status: 'restored', restored: 1, failed: 0, leftovers: [], childSessionId: 'child-9' },
    ],
    skippedSegments: [],
  }
  assert.deepEqual(rollbackOutcome(restored.outcome), { key: 'rollback.outcome.restored', badgeKind: 'ok' })
  assert.deepEqual(rollbackOutcome('partial'), { key: 'rollback.outcome.partial', badgeKind: 'warn' })
  assert.deepEqual(rollbackOutcome('failed'), { key: 'rollback.outcome.failed', badgeKind: 'error' })
  assert.deepEqual(rollbackOutcome('denied'), { key: 'rollback.outcome.denied', badgeKind: 'error' })
  assert.deepEqual(rollbackOutcome('weird'), { key: 'rollback.outcome.unknown', badgeKind: 'error' })
  const rows = rollbackRewindRows(restored)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.statusKey, 'rollback.segment.restored')
  assert.equal(rows[0]?.badgeKind, 'ok')
  assert.equal(rows[0]?.leftoversCount, 2, '该点未记录的内容只报告不删（引擎 scanLeftovers 语义）')
  assert.deepEqual(rows[0]?.leftovers, ['a.txt', 'b.txt'])
  assert.equal(rows[1]?.childSessionId, 'child-9')
  assert.deepEqual(rollbackRewindCounts(restored), { restored: 4, failed: 0, leftovers: 2 })
  assert.deepEqual(rollbackChildSession(restored), { key: 'rollback.rewind.result.child', id: 'child-9' })
  assert.deepEqual(rollbackSkippedSegments(restored), [])

  const partial: RollbackRewindResult = { ok: false, outcome: 'partial', code: 'restore-failed', segments: [
    { state: 'workspace', status: 'restored', restored: 1 },
    { state: 'session', status: 'skipped', leftovers: ['x'] },
    { state: 'workspace', status: 'something-new' },
  ], skippedSegments: ['session', 'nope'] }
  const view = rollbackRewindRows(partial)
  assert.equal(view[1]?.statusKey, 'rollback.segment.skipped')
  assert.equal(view[1]?.badgeKind, 'warn')
  assert.equal(view[2]?.statusKey, 'rollback.segment.unknown', '未知段状态回落 unknown（绝不裸渲染）')
  assert.equal(view[2]?.badgeKind, 'error')
  assert.deepEqual(rollbackSkippedSegments(partial), [
    { state: 'session', key: 'rollback.state.session' },
    { state: 'nope', key: ROLLBACK_STATE_UNKNOWN_KEY },
  ])
  assert.deepEqual(rollbackRewindRows(null), [])
  assert.equal(rollbackChildSession({ ok: true, outcome: 'restored', code: 'ok' }), null, '没有会话回退就不编造子会话 id')
  assert.equal(rollbackChildSession(null), null)
})

test('按会话分组的时间线：组内保序、组间按最新时间倒序、未知会话排最后', () => {
  const groups = rollbackPointGroups(list([
    point({ id: 'a1', sessionId: 'sess-A', createdAt: 300, turn: 3 }),
    point({ id: 'b1', sessionId: 'sess-B', createdAt: 500, turn: 1 }),
    point({ id: 'a2', sessionId: 'sess-A', createdAt: 100, turn: 1 }),
    point({ id: 'u1', sessionId: null, createdAt: 900, turn: null }),
  ]))
  assert.equal(groups.length, 3)
  assert.equal(groups[0]?.sessionId, 'sess-B', '组间按各组最新时间倒序（B=500 最新）')
  assert.equal(groups[1]?.sessionId, 'sess-A')
  assert.deepEqual(groups[1]?.rows.map((row) => row.id), ['a1', 'a2'], '组内保持台账顺序（时间倒序），不重排')
  assert.equal(groups[1]?.latestAtMs, 300)
  assert.equal(groups[2]?.sessionId, null, '缺 sessionId 的记录归入未知会话组并排在最后（绝不猜归属）')
  assert.deepEqual(rollbackPointGroups(null), [])
  assert.deepEqual(rollbackPointGroups({ ok: true, points: [], storage: { available: true } }), [])
})

test('时间线行事实：文件数（工作区段条目数）与是否有会话游标', () => {
  const withCursor = rollbackPointRows(list([point()]))[0]
  assert.ok(withCursor !== undefined)
  assert.equal(rollbackRowFileCount(withCursor), 3, '文件数 = 工作区段 entries')
  assert.equal(rollbackRowHasSessionCursor(withCursor), true)

  const withoutCursor = rollbackPointRows(list([point({
    id: 'no-cursor',
    segments: [segment({ state: 'workspace', entries: 7 }), segment({ state: 'session', entries: 1, cursorBytes: null, restorable: false })],
  })]))[0]
  assert.ok(withoutCursor !== undefined)
  assert.equal(rollbackRowFileCount(withoutCursor), 7)
  assert.equal(rollbackRowHasSessionCursor(withoutCursor), false, '没有会话游标 = 只能回退工作区（界面必须如实说）')
})

test('预览的会话段：字节游标 now→target（宿主给得出才有）', () => {
  const rows = rollbackPreviewRows({
    ok: true, id: 'rp-1', storage: { available: true },
    session: { from: 9000, to: 4096, turns: 3, cursorSeq: 4096, cursorNowBytes: 9000, cursorTargetBytes: 4096, restorable: true, active: false },
  })
  assert.deepEqual(rows[0]?.cursor, { from: 9000, to: 4096 })
  assert.deepEqual(rows[0]?.cursorBytes, { now: 9000, target: 4096 })
  const sparse = rollbackPreviewRows({ ok: true, id: 'rp-2', storage: { available: true }, session: {} })
  assert.deepEqual(sparse[0]?.cursorBytes, { now: null, target: null })
})

test('T18-F2：可删判定与宿主一致 —— auto 可删 / guard 与 protected 不可删', () => {
  // 宿主真值（src/core/rollback-point.ts:1512 canRemove = !protected && kind!=='guard'；
  // :1839-1840 remove() 对 protected 与 guard 一律回 protected-point）
  const rows = rollbackPointRows(list([
    point({ id: 'auto-1', kind: 'auto' }),
    point({ id: 'guard-1', kind: 'guard' }),
    point({ id: 'prot-1', protected: true }),
  ]))
  assert.equal(rows[0]?.removable, true, 'auto 点可删（宿主允许）')
  assert.equal(rows[1]?.removable, false, 'guard 点不可删（宿主 remove 必回 protected-point）')
  assert.equal(rows[2]?.removable, false, 'protected 点不可删')
  // 两门互相独立（t22）：guard 可回退（rewindable=true）但不可删（removable=false）
  assert.equal(rows[1]?.rewindable, true, 'guard 行可回退（t22：回退门不排除 guard）')
  assert.equal(rows[1]?.removable, false, '同一行不可删 —— 两门独立，界面不得把「不可删」当「不可回退」')
})

test('T18-F3：不可回退的原因按宿主真实形状分派（code:ok + canRestore:false），绝不回落 unknown', () => {
  // 宿主真实形状：引擎 preview 恒回 code:'ok'，拒绝只体现在 canRestore/canRemove
  //（t22 定稿：rollback-point.ts:1530-1531 —— canRemove = !protected && kind!=='guard' 与
  //  canRestore = !protected && !incomplete && (ws||session 可恢复) 两门**互相独立**）
  const real = (over: Partial<RollbackPreviewResult>): RollbackPreviewResult => ({
    ok: true, code: 'ok', id: 'rp-1', storage: { available: true },
    canRestore: false, canRemove: false,
    workspace: {}, session: { restorable: true },
    ...over,
  })
  const prot = rollbackPreviewVerdict(real({ point: point({ protected: true }) }))
  assert.equal(prot.canRestore, false)
  assert.equal(prot.reasonKey, 'rollback.code.protected-point', '受保护点（真实形状）必须给 protected-point')
  // t22 新真值（本轮 t23 翻正）：救援点**可以**回退 —— canRestore=true 且 canRemove=false；
  // 引擎依据 rollback-point.ts:1531（canRestore 不含 kind!=='guard'）与 :1582（rewind 门 2 只拒 protected）
  const guard = rollbackPreviewVerdict(real({ canRestore: true, point: point({ kind: 'guard' }) }))
  assert.equal(guard.canRestore, true, '救援点必须可回退（t22：回退门不排除 guard）')
  assert.equal(guard.reasonKey, null, '可回退就不给原因键')
  assert.equal(guard.canRemove, false, '同一时刻救援点仍不可删（两门独立）')
  // 救援点专属原因键只在**宿主真的拒绝了一个看起来可恢复的救援点**时使用（不是「救援点一律不可回退」）
  const guardRefused = rollbackPreviewVerdict(real({ point: point({ kind: 'guard' }) }))
  assert.equal(guardRefused.canRestore, false)
  assert.equal(guardRefused.reasonKey, ROLLBACK_PREVIEW_REASON_GUARD_KEY, '宿主拒绝救援点时给救援点专属原因键')
  const incomplete = rollbackPreviewVerdict(real({ point: point({ incomplete: true }) }))
  assert.equal(incomplete.reasonKey, ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY, '两态不全（真实形状）必须给 incomplete 原因键')
  const hostRefused = rollbackPreviewVerdict(real({}))
  assert.equal(hostRefused.reasonKey, ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY, '兜底必须是可证明的「宿主拒绝」键')
  const noSegment = rollbackPreviewVerdict(real({ workspace: { available: false }, session: { restorable: false, reasonCode: 'no-boundary' } }))
  assert.equal(noSegment.reasonKey, 'rollback.code.no-boundary', '一段都不可回退时取段自己的 reasonCode')
  for (const verdict of [prot, guardRefused, incomplete, hostRefused, noSegment]) {
    assert.notEqual(verdict.reasonKey, ROLLBACK_CODE_UNKNOWN_KEY, '真实形状下绝不回落 rollback.code.unknown')
  }
  // 补充（不是唯一覆盖）：伪造 code:'protected-point' 的老形状仍要能给出 protected-point（上面 :264 那条）
  assert.equal(rollbackPreviewVerdict({ ok: true, code: 'protected-point', id: 'x', storage: { available: true }, canRestore: false, canRemove: false, workspace: {}, session: {} }).reasonKey, 'rollback.code.protected-point')
})

test('T18-F1：跳过 / 截断事实在行级与预览级都可见（宿主已如实回传，界面不得静默）', () => {
  const degradedPoint = point({
    id: 'truncated',
    segments: [
      segment({ state: 'workspace', degraded: true, reasonCode: 'capture-truncated', entries: 2, skippedCount: 3, truncated: true }),
      segment({ state: 'session', entries: 1, cursorBytes: 4096 }),
    ],
  })
  const row = rollbackPointRows(list([degradedPoint]))[0]!
  const ws = row.segments[0]!
  assert.equal(ws.skippedCount, 3, '行级必须带跳过计数（S4 可见性）')
  assert.equal(ws.truncated, true, '行级必须带截断事实')
  assert.deepEqual(ws.noticeKeys, [ROLLBACK_NOTICE_SKIPPED_KEY, ROLLBACK_NOTICE_TRUNCATED_KEY], '截断点的行必须给可见告警键')
  assert.equal(row.segments[1]?.noticeKeys.length, 0, '没有跳过/截断的段不产生噪声告警')
  assert.equal(ws.badgeKind, 'warn', 'degraded 段仍是 warn 徽章（与告警键并存）')

  const preview: RollbackPreviewResult = {
    ok: true, code: 'ok', id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: { overwrite: 2, different: 1, missing: 0, createdAfter: 3, skippedCount: 3, truncated: true },
    session: { restorable: true },
    warnings: [
      { code: 'rollback.warn.trackDegraded', detail: 'workspace capture-truncated' },
      { code: 'rollback.warn.some-new-code', detail: 'x' },
    ],
    guidance: [{ code: 'rollback.guidance.workspaceRolledBack' }],
  }
  const previewRows = rollbackPreviewRows(preview)
  assert.equal(previewRows[0]?.skippedCount, 3, '预览行必须带跳过计数')
  assert.equal(previewRows[0]?.truncated, true)
  assert.deepEqual(previewRows[0]?.noticeKeys, [ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY, ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY])
  assert.equal(previewRows[0]?.counts.find((c) => c.key === 'rollback.preview.createdAfter')?.n, 3)
  // 点级告警：走 rollback.warn.* 映射，未知码回落 unknown；两行都带同一份（引擎不给段键，绝不猜归属）
  assert.deepEqual(rollbackPreviewWarnings(preview).map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(previewRows[0]?.warnings.map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(previewRows[1]?.warnings.map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(rollbackPreviewGuidance(preview).map((g) => g.key), ['rollback.guidance.workspaceRolledBack'])
  // 告警不改变「可回退」：规格允许部分覆盖，S4 只要求看得见
  assert.equal(rollbackPreviewVerdict(preview).canRestore, true, '有告警不等于禁止回退（绝不因告警禁用恢复）')
  assert.deepEqual(rollbackPreviewWarnings(null), [])
  assert.deepEqual(rollbackPreviewGuidance(null), [])
})

test('留存口径（S6）：每会话 20 / 全局 50 由本模块单点声明', () => {
  assert.equal(ROLLBACK_MAX_POINTS_PER_SESSION, 20)
  assert.equal(ROLLBACK_MAX_POINTS_TOTAL, 50)
})
