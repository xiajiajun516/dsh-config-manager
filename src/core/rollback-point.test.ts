/**
 * 工作区 + 会话回滚点引擎单测（t1）。
 *
 * 纪律（与本仓既有 core 测试同款）：**真实临时目录**（os.tmpdir + fs.mkdtemp）+ 真实读写，
 * 不 mock 文件系统 —— 本模块的正确性几乎全在「路径门 / 原子写 / 指纹 / 绝不删除 / 整体回滚」上，
 * 只有真盘能证明。fork 与写回是宿主注入的 seam，测试用真 seam 替身。
 *
 * 覆盖（对应验收条件）：
 *  - 两态捕获（workspace + session）且**没有 config 段**（R-01）
 *  - 按回合自动留点：turn/start + turn/end → 一个点，边界 = startSeq-1（R-02）
 *  - fork 边界 = 目标回合前的稳定边界；首回合无前置边界 → 结构化 no-boundary（R-03）
 *  - 每会话 20 / 全局 50 淘汰，只删最旧的非保护点（R-04）
 *  - 只覆盖记录在案的路径且绝不删除未记录文件（R-05）
 *  - 恢复前自动救援点（guard）（R-06）
 *  - 恢复后逐文件校验失败即整体回滚到恢复前状态（R-07）
 *  - 安全门：fail-closed 确认（R-08）、保护点（R-09）、两态不全（R-10）、
 *    记录不可成为写原语（R-11）
 *  - 会话回退 = fork 子会话、原日志只读（R-12）
 *  - 预览零写入（R-13）、mode 三选一（R-14）、存储降级（R-15）、
 *    台账损坏不崩（R-16）、删除 + 对象回收（R-17）、
 *    轮询回退（R-18）、分块不可用（R-19）
 *  - E1：nothing-to-restore 是「成功、0 变更」（R-26 / R-27）
 *    与预览逐文件行级统计（R-28 / R-29）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ROLLBACK_MAX_GUARDS_PER_SESSION,
  ROLLBACK_MAX_RECORDS,
  ROLLBACK_MAX_RECORDS_PER_SESSION,
  ROLLBACK_POINTS_DIR_NAME,
  RollbackAutoTracker,
  RollbackPointEngine,
  classifyPreviewStatFailure,
  isInsidePath,
  resolveTurnBoundary,
  rollbackSessionBindingOf,
  rollbackTrackedEventOf,
  summarizeRollbackPoint,
  turnBoundariesOf,
  type RollbackEngineOptions,
  type RollbackForkInput,
  type RollbackPointRecord,
} from './rollback-point.ts'
import { projectKeyOf } from './session-select.ts'
import { atomicWriteFile } from '../utils/atomic-write.ts'
import { sha256Hex } from '../utils/hashing.ts'

/* --------------------------------------------------------------- fixture */

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  sessionsDir: string
  unitDir: string
  logFile: string
  workspaceDir: string
  cleanup: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-point-'))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const sessionsDir = path.join(homeDir, 'sessions')
  const unitDir = path.join(sessionsDir, 'proj-key', 'session-1111')
  const workspaceDir = path.join(root, 'ws')
  const logFile = path.join(unitDir, 'session-1111.jsonl.zstd')
  await fs.mkdir(unitDir, { recursive: true })
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true })
  await fs.writeFile(logFile, 'frame-one')
  await fs.writeFile(path.join(workspaceDir, 'a.txt'), 'A1')
  await fs.writeFile(path.join(workspaceDir, 'src', 'b.txt'), 'B1')
  return {
    root, homeDir, dataDir, sessionsDir, unitDir, logFile, workspaceDir,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
  }
}

function makeEngine(fx: Fixture, overrides: Partial<RollbackEngineOptions> = {}): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0, ...overrides })
}

/** S1 形态的点：工作区快照（ws 目录）+ 会话游标（单元内日志）。 */
async function capturePoint(engine: RollbackPointEngine, fx: Fixture, extra: Record<string, unknown> = {}) {
  return await engine.capturePoint({
    chunks: [fx.workspaceDir],
    sessionId: 'session-1111',
    unitId: 'proj-key/session-1111',
    sessionLogPath: fx.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
    ...extra,
  })
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8')
}

async function objectExists(engine: RollbackPointEngine, sha: string): Promise<boolean> {
  try {
    await fs.access(path.join(engine.storeDir, 'objects', sha))
    return true
  } catch {
    return false
  }
}

function steppingClock(start: number, step: number): () => number {
  let value = start - step
  return () => { value += step; return value }
}

async function ledgerOf(engine: RollbackPointEngine): Promise<{ records: RollbackPointRecord[] }> {
  return JSON.parse(await readText(path.join(engine.storeDir, 'index.json'))) as { records: RollbackPointRecord[] }
}

/* =================================================== R-01 两态捕获 / 无 config */

test('R-01 两态捕获：workspace + session 都有载荷与指纹，且**没有 config 段**', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 10) })

  const res = await capturePoint(engine, fx)
  assert.equal(res.ok, true, res.detail ?? res.code)
  const record = res.point
  assert.ok(record !== undefined)
  assert.equal(res.point?.kind, 'auto')

  // 两态都捕上、都有指纹
  for (const track of [record.workspace, record.session]) {
    assert.equal(track.ok, true, track.kind)
    assert.equal(typeof track.fingerprint, 'string', track.kind)
    assert.ok((track.fingerprint ?? '').length >= 8, track.kind)
    assert.ok(track.capturedAt > 0, track.kind)
  }
  // 顺序：会话先于工作区（捕获顺序稳定）
  assert.ok(record.session.capturedAt <= record.workspace.capturedAt)

  // 工作区：两个文件进仓，指纹 = 内容 SHA-256
  const ws = record.workspace.payload
  assert.ok(ws !== null)
  assert.equal(ws.files.length, 2)
  const aFile = ws.files.find((f) => f.path.endsWith('a.txt'))
  assert.ok(aFile !== undefined)
  assert.equal(aFile.sha256, sha256Hex('A1'))
  assert.equal(aFile.chunk, path.resolve(fx.workspaceDir))
  assert.equal(await objectExists(engine, aFile.object), true)

  // 会话：游标 + fork 边界（回合开始前最后一个事件）
  const session = record.session.payload
  assert.ok(session !== null)
  assert.equal(session.sessionId, 'session-1111')
  assert.equal(session.logPath, fx.logFile)
  assert.equal(session.cursorBytes, 9)
  assert.equal(session.fingerprint, sha256Hex('frame-one'))
  assert.equal(session.cursorSeq, 3)
  assert.equal(session.turnSeq, 2)
  assert.equal(session.boundarySeq, 1)
  assert.equal(session.boundaryEndSeq, 6)
  assert.equal(record.sessionId, 'session-1111')
  assert.equal(record.turnSeq, 2)
  assert.equal(record.boundarySeq, 1)

  // **没有第三态**：记录 / 摘要里都不许出现 config
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'config'), false, '记录不得有 config 段')
  const summary = summarizeRollbackPoint(record)
  assert.deepEqual(summary.segments.map((s) => s.state), ['workspace', 'session'])
  assert.equal(JSON.stringify(summary).includes('"config"'), false, '摘要不得有 config 段')
  assert.equal(summary.segments[0]?.entries, 2)
  assert.equal(summary.segments[1]?.cursorBytes, 9)
  assert.equal(summary.segments[1]?.restorable, true)
  assert.equal(JSON.stringify(summary).includes('A1'), false, '摘要不得泄漏载荷')

  // 列表：新→旧
  const list = await engine.list()
  assert.equal(list.ok, true)
  assert.equal(list.points.length, 1)
  assert.equal(list.maxRecords, ROLLBACK_MAX_RECORDS)
  assert.equal(list.maxRecordsPerSession, ROLLBACK_MAX_RECORDS_PER_SESSION)
  // 库目录名 = rollback-points
  assert.equal(path.basename(engine.storeDir), ROLLBACK_POINTS_DIR_NAME)

  // 详情
  const detail = await engine.read(record.id)
  assert.equal(detail.point?.id, record.id)
  assert.equal((await engine.read('rb-nope')).point, undefined)
})

/* =================================================== R-02 按回合自动留点 */

test('R-02 按回合自动留点：turn/end 才留点，边界 = turn/start 的 seq − 1，重复事件幂等', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(2_000_000, 10) })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 'session-1111',
    unitId: 'proj-key/session-1111',
    logPath: fx.logFile,
    chunks: [fx.workspaceDir],
  })
  assert.equal(tracker.mechanismKind, 'event')

  // 回合 1 从 seq 0 开始（首回合 → 无前置边界）；回合 2 从 seq 2 开始（边界 = 1）
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 0, type: 'turn/start', data: { turn: 1 } })).captured, false)
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 1, type: 'turn/end', data: { turn: 1 } })).captured, true)
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 2, type: 'turn/start', data: { turn: 2 } })).captured, false)
  // 回合中间的事件不触发留点
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 3, type: 'user/message', data: {} })).captured, false)
  const second = await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 2 } })
  assert.equal(second.captured, true, second.detail ?? '')
  // 幂等：同一回合的重复 turn/end 不再留点
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 2 } })).captured, false)

  const list = await engine.list()
  assert.equal(list.points.length, 2, '两个回合 → 两个点（重复事件不重复留点）')
  const byTurn = new Map(list.points.map((p) => [p.turn, p]))
  assert.equal(byTurn.get(1)?.boundarySeq, null, '首回合无前置边界')
  assert.equal(byTurn.get(2)?.boundarySeq, 1, '回合 2 的边界 = turn/start 的 seq − 1')
  assert.equal(byTurn.get(2)?.sessionId, 'session-1111')
  assert.equal(byTurn.get(2)?.unitId, 'proj-key/session-1111')
  assert.ok((byTurn.get(1)?.createdAt ?? 0) < (byTurn.get(2)?.createdAt ?? 0), '新→旧')

  // 未登记会话：不抛错，结构化返回
  const unknown = await tracker.noteEvent({ sessionId: 'nope', seq: 9, type: 'turn/end', data: { turn: 9 } })
  assert.equal(unknown.captured, false)
  assert.equal(unknown.code, 'invalid-input')
  assert.equal((await engine.list()).points.length, 2)
})

/* =================================================== R-03 fork 边界 / no-boundary */

test('R-03 fork 边界 = 目标回合前的稳定边界；首回合无前置边界 → 结构化 no-boundary', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 纯函数层：只认 turn/start 与 turn/end 的 seq
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'turn/end', data: { turn: 1 } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'turn/end', data: { turn: 2 } },
  ]
  const boundaries = turnBoundariesOf(events)
  assert.deepEqual(boundaries.map((b) => [b.turn, b.startSeq, b.endSeq, b.boundarySeq]), [
    [1, 0, 1, null],
    [2, 2, 5, 1],
  ])
  assert.deepEqual(resolveTurnBoundary(events, 2), { ok: true, boundarySeq: 1, endSeq: 5 })
  const noBoundary = resolveTurnBoundary(events, 1)
  assert.equal(noBoundary.ok, false)
  assert.equal(noBoundary.code, 'no-boundary')

  // 引擎层：边界为 null 的点在预览里结构化 no-boundary；会话段回退失败（不猜边界）
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx, { turnSeq: 1, boundarySeq: null, boundaryEndSeq: 1 })
  const record = captured.point
  assert.ok(record !== undefined)
  const preview = await engine.preview(record.id)
  assert.equal(preview.ok, true)
  assert.equal(preview.session.from, null)
  assert.equal(preview.session.reasonCode, 'no-boundary')
  assert.equal(preview.session.restorable, false)
  // 工作区态仍可回退（回滚点本身有效），但会话不能
  assert.equal(preview.workspace.available, true)

  const forked: RollbackForkInput[] = []
  const engine2 = makeEngine(fx, {
    fork: async (input) => { forked.push(input); return { ok: true, childSessionId: 'child-x' } },
  })
  const rewound = await engine2.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  const sessionSegment = rewound.segments.find((s) => s.state === 'session')
  assert.equal(sessionSegment?.status, 'failed')
  assert.equal(sessionSegment?.reasonCode, 'no-boundary')
  assert.deepEqual(forked, [], '无边界时绝不调用 fork')
})

/* =================================================== R-04 留存（20 / 50） */

test('R-04 留存：每会话 20、全局 50，淘汰只删最旧的非保护点', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  assert.equal(ROLLBACK_MAX_RECORDS, 50)
  assert.equal(ROLLBACK_MAX_RECORDS_PER_SESSION, 20)

  // ① 每会话上限：25 个自动点 → 只留最新 20 个
  const engine = makeEngine(fx, { now: steppingClock(5_000_000, 10) })
  const ids: string[] = []
  for (let i = 0; i < 25; i += 1) {
    const res = await capturePoint(engine, fx, { sessionId: 's-a', note: 'n' + String(i) })
    assert.equal(res.ok, true)
    ids.push(res.point?.id ?? '')
  }
  const ledger = await ledgerOf(engine)
  assert.equal(ledger.records.length, 20, '每会话最多 20 个自动点')
  const kept = new Set(ledger.records.map((r) => r.id))
  for (let i = 0; i < 5; i += 1) assert.equal(kept.has(ids[i] ?? ''), false, '最旧的 5 个必须被淘汰')
  for (let i = 5; i < 25; i += 1) assert.equal(kept.has(ids[i] ?? ''), true, '较新的必须保留')

  // ② 保护点 / guard 点不被淘汰，也不占自动点预算
  const engine2 = makeEngine(fx, { now: steppingClock(6_000_000, 10), maxRecords: 1, maxRecordsPerSession: 1 })
  const protectedPoint = await capturePoint(engine2, fx, { sessionId: 's-b', protect: true })
  const guard = await engine2.capturePoint({
    kind: 'guard', sessionId: 's-b', sessionLogPath: fx.logFile, chunks: [fx.workspaceDir],
  })
  assert.equal(guard.ok, true)
  const auto1 = await capturePoint(engine2, fx, { sessionId: 's-b', note: 'auto-1' })
  const auto2 = await capturePoint(engine2, fx, { sessionId: 's-b', note: 'auto-2' })
  const records = (await ledgerOf(engine2)).records
  const ids2 = records.map((r) => r.id)
  assert.ok(ids2.includes(protectedPoint.point?.id ?? ''), '保护点必须还在')
  assert.ok(ids2.includes(guard.point?.id ?? ''), 'guard 点必须还在')
  assert.ok(ids2.includes(auto2.point?.id ?? ''), '最新的自动点保留')
  assert.equal(ids2.includes(auto1.point?.id ?? ''), false, '最旧的自动点被淘汰')

  // ③ 全局上限：5 个不同会话的自动点，maxRecords=3 → 只留最新 3 个（独立 dataDir，避免与上面共享台账）
  const fx3 = await makeFixture()
  t.after(fx3.cleanup)
  const engine3 = makeEngine(fx3, { now: steppingClock(7_000_000, 10), maxRecords: 3, maxRecordsPerSession: 20 })
  const ids3: string[] = []
  for (let i = 0; i < 5; i += 1) {
    const res = await capturePoint(engine3, fx3, { sessionId: 's-' + String(i) })
    ids3.push(res.point?.id ?? '')
  }
  const kept3 = new Set((await ledgerOf(engine3)).records.map((r) => r.id))
  assert.equal(kept3.size, 3)
  assert.equal(kept3.has(ids3[0] ?? ''), false)
  assert.equal(kept3.has(ids3[4] ?? ''), true)
})

/* =================================================== R-05 只覆盖不删除 */

test('R-05 工作区恢复：只覆盖记录在案的路径，回滚点之后新建的文件绝不删除', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')

  // 回滚点之后：改内容、加新文件
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  await fs.writeFile(path.join(fx.workspaceDir, 'src', 'b.txt'), 'B2')
  await fs.writeFile(path.join(fx.workspaceDir, 'new.txt'), 'NEW')

  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  assert.equal(rewound.ok, true)
  assert.equal(rewound.code, 'ok')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
  assert.equal(await readText(path.join(fx.workspaceDir, 'src', 'b.txt')), 'B1')
  // 绝不删除：未记录 / 之后新建的文件仍在，并被如实报告
  assert.equal(await readText(path.join(fx.workspaceDir, 'new.txt')), 'NEW')
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'restored')
  assert.equal(ws?.restored, 2)
  assert.deepEqual(ws?.leftovers, [path.join(fx.workspaceDir, 'new.txt')])
  assert.ok((ws?.detail ?? []).some((line) => line.includes('verified=2')))
})

/* =================================================== R-06 恢复前救援点 */

test('R-06 恢复前自动留救援点（guard）：默认 warn 档必留，且 guard 点不可删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  const rewound = await engine.rewind({ id, userConfirmed: true })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  const guardId = rewound.guardPointId
  assert.ok(guardId !== undefined, '恢复前必须自动留救援点')
  const list = await engine.list()
  const guard = list.points.find((p) => p.id === guardId)
  assert.equal(guard?.kind, 'guard')
  // guard 点由 kind 保护（不可删、不被清理），不是用户的 protected 标记
  assert.equal((await engine.preview(guardId ?? '')).canRemove, false)

  const removed = await engine.remove(guardId ?? '')
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'protected-point')
  assert.equal((await engine.list()).points.some((p) => p.id === guardId), true, 'guard 点必须还在')

  // preRewindGuard='off' → 不留救援点
  const captured2 = await capturePoint(engine, fx, { sessionId: 's-2' })
  const off = await engine.rewind({ id: captured2.point?.id ?? '', userConfirmed: true, guardPolicy: 'off' })
  assert.equal(off.guardPointId, undefined)
})

/* =================================================== R-07 校验失败整体回滚 */

test('R-07 恢复后逐文件校验失败 → 整体回滚到恢复前状态（绝不留下半恢复）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const target = path.join(fx.workspaceDir, 'a.txt')
  let corrupted = false
  const engine = makeEngine(fx, {
    // 注入写回 seam：第一次写 a.txt 时故意写坏 → 复核必然失败 → 触发整体回滚
    writeFile: async (file, bytes) => {
      if (!corrupted && file === target) {
        corrupted = true
        await atomicWriteFile(file, Buffer.from('CORRUPTED-BY-SEAM'))
        return
      }
      await atomicWriteFile(file, bytes, { symlink: 'reject' })
    },
  })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(target, 'A2')
  await fs.writeFile(path.join(fx.workspaceDir, 'src', 'b.txt'), 'B2')

  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'failed')
  assert.equal(ws?.reasonCode, 'verify-failed')
  assert.equal(ws?.restored, 0, '失败不允许把已写条数当成功')
  assert.ok((ws?.detail ?? []).some((line) => line.startsWith('verify-mismatch')), JSON.stringify(ws?.detail))
  assert.ok((ws?.detail ?? []).some((line) => line.includes('rolledBack=')))
  // **整体回滚到恢复前状态**：两个被触碰文件都回到恢复前
  assert.equal(await readText(target), 'A2', '被写坏的文件必须回滚到恢复前内容')
  assert.equal(await readText(path.join(fx.workspaceDir, 'src', 'b.txt')), 'B2', '同一批的其它文件也必须一起回滚')
  assert.equal(rewound.outcome, 'failed')
  assert.equal(rewound.code, 'restore-failed')
})

/* =================================================== R-08 确认门 */

test('R-08 确认门 fail-closed：userConfirmed 不恰好为 true 一律拒绝且零写入', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  const badInputs: unknown[] = [undefined, null, false, 'true', 1, 0]
  for (const bad of badInputs) {
    const rewound = await engine.rewind({ id, userConfirmed: bad as boolean, guardPolicy: 'off' })
    assert.equal(rewound.outcome, 'denied', String(bad))
    assert.equal(rewound.code, 'confirmation-required', String(bad))
    assert.equal(rewound.segments.length, 0, String(bad))
  }
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')
  assert.equal((await engine.list()).points.length, 1, '拒绝路径不得留下 guard 点（零写入）')

  // 删除也要确认（未确认 → confirmation-required，记录仍在）
  const remove = await engine.remove(id)
  assert.equal(remove.ok, true)
  assert.equal(remove.code, 'deleted')
})

/* =================================================== R-09 保护点 */

test('R-09 保护点：不可回退、不可删除、不被自动清理', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { maxRecords: 1, maxRecordsPerSession: 1 })
  const captured = await capturePoint(engine, fx, { protect: true })
  const record = captured.point
  assert.ok(record !== undefined)
  assert.equal(record.protected, true)

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const rewound = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound.outcome, 'denied')
  assert.equal(rewound.code, 'protected-point')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  const preview = await engine.preview(record.id)
  assert.equal(preview.canRestore, false)
  assert.equal(preview.canRemove, false)

  const removed = await engine.remove(record.id)
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'protected-point')

  // 自动清理绝不淘汰保护点
  await capturePoint(engine, fx, { sessionId: 's-1', note: 'p1' })
  await capturePoint(engine, fx, { sessionId: 's-2', note: 'p2' })
  const ids = (await engine.list()).points.map((p) => p.id)
  assert.ok(ids.includes(record.id), '保护点必须还在')
  assert.equal(ids.length, 2)
})

/* =================================================== R-10 两态不全 */

test('R-10 两态不全（缺会话输入）→ 缺省拒绝回退；allowPartial 才放行', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await engine.capturePoint({ chunks: [fx.workspaceDir] })
  const record = captured.point
  assert.ok(record !== undefined)
  assert.equal(record.incomplete, true)
  assert.equal(record.session.ok, false)
  assert.equal(record.session.reasonCode, 'session-missing')
  assert.equal(record.sessionId, null)

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const denied = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(denied.outcome, 'denied')
  assert.equal(denied.code, 'record-incomplete')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  const partial = await engine.rewind({
    id: record.id, userConfirmed: true, allowPartial: true, segments: ['workspace'], guardPolicy: 'off',
  })
  assert.equal(partial.outcome, 'restored')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
})

/* =================================================== R-11 记录不可成为写原语 */

test('R-11 记录被篡改不能变成写原语：路径越界 / 指纹不符一律零写入', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const record = captured.point
  assert.ok(record !== undefined)
  const ledgerPath = path.join(engine.storeDir, 'index.json')

  const outside = path.join(fx.root, 'outside.txt')
  await fs.writeFile(outside, 'SAFE')
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  // 篡改 1：把记录里的路径改成分块之外的文件
  const tampered = await ledgerOf(engine) as unknown as { records: RollbackPointRecord[] }
  const wsFiles = tampered.records[0]?.workspace.payload?.files ?? []
  const hit = wsFiles.find((f) => f.path.endsWith('a.txt'))
  assert.ok(hit !== undefined)
  hit.path = outside
  await fs.writeFile(ledgerPath, JSON.stringify(tampered, null, 2))
  const rewound1 = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound1.outcome, 'failed')
  assert.ok((rewound1.segments[0]?.detail ?? []).some((line) => line.startsWith('invalid-path')))
  assert.equal(await readText(outside), 'SAFE', '越界路径绝不被写')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2', '一条不合格 → 零写入')

  // 篡改 2：路径合法但声明的内容指纹不符
  const tampered2 = await ledgerOf(engine) as unknown as { records: RollbackPointRecord[] }
  const hit2 = (tampered2.records[0]?.workspace.payload?.files ?? []).find((f) => f.sha256 === sha256Hex('A1'))
  assert.ok(hit2 !== undefined)
  hit2.path = path.join(fx.workspaceDir, 'a.txt')   // 路径合法（分块内），只有指纹不符
  hit2.sha256 = sha256Hex('NOT-THE-CAPTURED-CONTENT')
  await fs.writeFile(ledgerPath, JSON.stringify(tampered2, null, 2))
  const rewound2 = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound2.outcome, 'failed')
  assert.ok((rewound2.segments[0]?.detail ?? []).some((line) => line.includes('object-hash-mismatch')))
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')
})

/* =================================================== R-12 会话回退 = fork */

test('R-12 会话回退 = 在稳定边界 fork 子会话；原会话日志只读（逐字节未变）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const calls: RollbackForkInput[] = []
  const engine = makeEngine(fx, {
    fork: async (input) => { calls.push(input); return { ok: true, childSessionId: 'child-1' } },
  })
  const captured = await capturePoint(engine, fx, { boundarySeq: 1, turnSeq: 2 })
  const id = captured.point?.id ?? ''
  const before = await readText(fx.logFile)

  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  assert.equal(rewound.childSessionId, 'child-1')
  const segment = rewound.segments.find((s) => s.state === 'session')
  assert.equal(segment?.status, 'restored')
  assert.equal(segment?.childSessionId, 'child-1')
  assert.deepEqual(calls, [{ sessionId: 'session-1111', boundarySeq: 1 }], 'fork 边界必须是该回合开始前最后一个事件 seq')
  assert.ok((segment?.detail ?? []).some((line) => line.includes('logUnchanged=true')))
  assert.equal(await readText(fx.logFile), before, '原会话日志必须逐字节未变')

  // mode='session' 时只动会话段
  const captured2 = await capturePoint(engine, fx, { sessionId: 'session-1111' })
  const onlySession = await engine.rewind({ id: captured2.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  assert.deepEqual(onlySession.segments.map((s) => s.state), ['session'])
  assert.deepEqual(onlySession.skippedSegments, ['workspace'])

  // 没有注入 fork seam → 结构化降级（不静默、不假装成功）
  const bare = makeEngine(fx)
  const degraded = await bare.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  const bareSegment = degraded.segments.find((s) => s.state === 'session')
  assert.equal(bareSegment?.status, 'failed')
  assert.equal(bareSegment?.reasonCode, 'session-fork-unavailable')

  // fork 拒绝 → 沿用 fork 的错误码
  const refusing = makeEngine(fx, { fork: async () => ({ ok: false, code: 'no-boundary', detail: 'OPEN_TURN' }) })
  const refused = await refusing.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  assert.equal(refused.segments.find((s) => s.state === 'session')?.reasonCode, 'no-boundary')

  // fork 抛错 → 不冒泡，结构化 fork-failed
  const throwing = makeEngine(fx, { fork: async () => { throw new Error('boom') } })
  const thrown = await throwing.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  assert.equal(thrown.segments.find((s) => s.state === 'session')?.reasonCode, 'fork-failed')
})

/* =================================================== R-13 预览零写入 */

test('R-13 preview 零写入：只读影响面（overwrite / different / missing / createdAfter）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2-A-LONGER-CONTENT')
  await fs.writeFile(path.join(fx.workspaceDir, 'new.txt'), 'NEW')
  await fs.rm(path.join(fx.workspaceDir, 'src', 'b.txt'))

  const preview = await engine.preview(id)
  assert.equal(preview.ok, true)
  assert.equal(preview.code, 'ok')
  assert.equal(preview.canRestore, true)
  assert.equal(preview.canRemove, true)
  assert.equal(preview.workspace.overwrite, 2)
  assert.equal(preview.workspace.different, 1)
  assert.equal(preview.workspace.missing, 1)
  assert.equal(preview.workspace.createdAfter, 1)
  assert.ok(preview.workspace.leftovers.some((p) => p.endsWith('new.txt')))
  assert.equal(preview.session.from, 1)
  assert.equal(preview.session.to, 6)
  assert.equal(preview.session.turns, 2)
  assert.equal(preview.session.restorable, true)
  assert.equal(preview.point?.segments.length, 2)

  // 零写入
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2-A-LONGER-CONTENT')
  assert.equal(await readText(fx.logFile), 'frame-one')
  assert.equal((await engine.list()).points.length, 1, '预览不得留点')

  // 坏 id
  const missing = await engine.preview('rb-nope')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'record-not-found')

  // 已知但两态不全 → canRestore=false
  const incomplete = await engine.capturePoint({ chunks: [fx.workspaceDir] })
  assert.equal((await engine.preview(incomplete.point?.id ?? '')).canRestore, false)
})

/* =================================================== R-14 mode 三选一 */

test('R-14 mode 三选一：files+session / files / session；显式 segments 收窄', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  const files = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'files' })
  assert.deepEqual(files.segments.map((s) => s.state), ['workspace'])
  assert.deepEqual(files.skippedSegments, ['session'])
  assert.equal(files.outcome, 'restored')

  const session = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  assert.deepEqual(session.segments.map((s) => s.state), ['session'])
  assert.equal(session.childSessionId, 'child-1')

  const both = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.deepEqual(both.segments.map((s) => s.state), ['workspace', 'session'])
  assert.equal(both.outcome, 'restored')

  // segments 显式给空数组 = 非法输入（不静默回落到 mode）
  const invalid = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', segments: [] })
  assert.equal(invalid.outcome, 'denied')
  assert.equal(invalid.code, 'invalid-input')
})

/* =================================================== R-15 存储降级 */

test('R-15 存储栈缺失：不抛错、结构化组合指引、各接口都能给结论', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { storage: async () => ({ ok: false, detail: 'EACCES: permission denied' }) })

  const status = await engine.storageStatus()
  assert.equal(status.available, false)
  assert.equal(status.detail, 'EACCES: permission denied')
  assert.ok(status.requirements.includes('@deepseek-ai/dsh-storage'))
  const codes = status.guidance.map((g) => g.code)
  assert.ok(codes.includes('rollback.guidance.mountStorage'))
  assert.ok(codes.includes('rollback.guidance.fixDataDir'))
  assert.ok(codes.includes('rollback.guidance.readOnlyFallback'))

  const captured = await capturePoint(engine, fx)
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'storage-unavailable')
  assert.ok(captured.guidance.length > 0)

  const rewound = await engine.rewind({ id: 'rb-x', userConfirmed: true })
  assert.equal(rewound.outcome, 'failed')
  assert.equal(rewound.code, 'storage-unavailable')

  const list = await engine.list()
  assert.equal(list.ok, false)
  assert.equal(list.storage.available, false)
  assert.deepEqual(list.points, [])

  const preview = await engine.preview('rb-x')
  assert.equal(preview.ok, false)
  assert.equal(preview.code, 'storage-unavailable')
  assert.equal(preview.storage.available, false)

  const removed = await engine.remove('rb-x')
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'storage-unavailable')

  // 探针自己抛异常也不能把调用方炸掉
  const throwing = makeEngine(fx, { storage: async () => { throw new Error('probe exploded') } })
  const thrown = await throwing.storageStatus()
  assert.equal(thrown.available, false)
  assert.equal(thrown.detail, 'probe exploded')
})

/* =================================================== R-16 台账损坏 */

test('R-16 台账损坏：list 如实报错、留点仍可继续（不崩、不静默）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  await fs.mkdir(engine.storeDir, { recursive: true })
  await fs.writeFile(path.join(engine.storeDir, 'index.json'), '{ broken-json')

  const list = await engine.list()
  assert.equal(list.ok, true)
  assert.equal(list.points.length, 0)
  assert.ok((list.error ?? '').includes('ledger unreadable'))

  const captured = await capturePoint(engine, fx)
  assert.equal(captured.ok, true)
  const after = await engine.list()
  assert.equal(after.points.length, 1)
  assert.equal(after.error, undefined)
})

/* =================================================== R-17 删除 + 对象回收 */

test('R-17 删除普通回滚点（对象回收）；坏 id 结构化 404 语义', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  await fs.writeFile(path.join(fx.workspaceDir, 'uniq.txt'), 'UNIQ-DOOMED')
  const uniqSha = sha256Hex('UNIQ-DOOMED')
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.equal(await objectExists(engine, uniqSha), true)

  const removed = await engine.remove(id)
  assert.equal(removed.ok, true)
  assert.equal(removed.code, 'deleted')
  assert.equal(removed.id, id)
  assert.equal((await engine.list()).points.length, 0)
  assert.equal(await objectExists(engine, uniqSha), false, '无人引用的对象被回收')

  const missing = await engine.remove('rb-does-not-exist')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'record-not-found')
})

/* =================================================== R-18 轮询回退 */

test('R-18 轮询回退：日志 size/mtime 变了才留点，且**无回合边界**（结构化 no-boundary）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const tracker = new RollbackAutoTracker({ engine, pollIntervalMs: 1 })
  tracker.registerSession({ sessionId: 'session-1111', logPath: fx.logFile, chunks: [fx.workspaceDir] })

  // 首次只记基线
  assert.deepEqual(await tracker.pollOnce(), [])
  // 没变 → 不留
  assert.deepEqual(await tracker.pollOnce(), [])
  // 变了 → 留一个点（无边界）
  await fs.appendFile(fx.logFile, '+MORE')
  const result = await tracker.pollOnce()
  assert.equal(result.length, 1)
  assert.equal(result[0]?.captured, true)

  const points = (await engine.list()).points
  assert.equal(points.length, 1)
  assert.equal(points[0]?.turn, null)
  assert.equal(points[0]?.boundarySeq, null)
  const preview = await engine.preview(points[0]?.id ?? '')
  assert.equal(preview.session.reasonCode, 'no-boundary')
  assert.equal(preview.workspace.available, true)

  // start/stop 幂等，且机制标记为 poll
  tracker.start()
  assert.equal(tracker.mechanismKind, 'poll')
  tracker.start()
  tracker.stop()
  tracker.stop()
})

/* =================================================== R-19 分块 / 会话不可用 */

test('R-19 分块不可用 / 非绝对路径 / 会话越界：该态结构化失败，其余态照常', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)

  const missingChunk = await engine.capturePoint({ chunks: [path.join(fx.root, 'nope')], sessionId: 'session-1111' })
  assert.equal(missingChunk.point?.workspace.ok, false)
  assert.equal(missingChunk.point?.workspace.reasonCode, 'chunk-not-found')
  assert.equal(missingChunk.point?.incomplete, true)
  assert.equal(missingChunk.ok, true, '留点动作本身成功（记录不完整由 incomplete 表达）')

  const relative = await engine.capturePoint({ chunks: ['relative/path'] })
  assert.equal(relative.point?.workspace.reasonCode, 'chunk-not-absolute')

  const noChunks = await engine.capturePoint({ sessionId: 'session-1111' })
  assert.equal(noChunks.point?.workspace.reasonCode, 'no-chunks')

  // 会话日志在会话根之外 → 拒绝（越界不猜）
  const outsideFile = path.join(fx.root, 'outside-log.jsonl.zstd')
  await fs.writeFile(outsideFile, 'x')
  const outOfRoot = await engine.capturePoint({ chunks: [fx.workspaceDir], sessionId: 'session-1111', sessionLogPath: outsideFile })
  assert.equal(outOfRoot.point?.session.ok, false)
  assert.equal(outOfRoot.point?.session.reasonCode, 'session-out-of-root')

  // 日志不存在 → 降级但**不失败**（fork 只要 sessionId + 边界）
  const gone = await engine.capturePoint({
    chunks: [fx.workspaceDir], sessionId: 'session-1111',
    sessionLogPath: path.join(fx.unitDir, 'nope.jsonl.zstd'), boundarySeq: 1,
  })
  assert.equal(gone.point?.session.ok, true)
  assert.equal(gone.point?.session.degraded, true)
  assert.equal(gone.point?.session.reasonCode, 'capture-degraded')
  assert.equal(gone.point?.session.payload?.boundarySeq, 1)

  // 超大日志 → 只记弱指纹（对象仓不进副本）
  const tiny = makeEngine(fx, { sessionMaxBytes: 2 })
  const capped = await capturePoint(tiny, fx)
  assert.equal(capped.point?.session.reasonCode, 'session-too-large')
  assert.equal(capped.point?.session.payload?.fingerprintKind, 'size')
  assert.equal(capped.point?.session.payload?.object, null)

  // 降级不静默：链接跳过留痕
  const junction = path.join(fx.workspaceDir, 'link-in')
  try {
    await fs.symlink(path.join(fx.workspaceDir, 'src'), junction, 'junction')
  } catch {
    t.diagnostic('本机不支持创建 junction：跳过链接留痕断言')
    return
  }
  const linked = await capturePoint(engine, fx)
  const track = linked.point?.workspace
  assert.equal(track?.ok, true)
  assert.equal(track?.degraded, true)
  assert.ok((track?.payload?.skipped ?? []).some((s) => s.reason === 'link' && s.path === junction))
  assert.equal((track?.payload?.files ?? []).some((f) => isInsidePath(f.path, junction)), false)
})

/* ============================================= R-20 忽略目录（node_modules） */

test('R-20 忽略规则：运行时依赖目录整棵不进快照、留痕、不算降级', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const depDir = path.join(fx.workspaceDir, 'node_modules', 'pkg')
  await fs.mkdir(depDir, { recursive: true })
  await fs.writeFile(path.join(depDir, 'index.js'), 'module.exports = 1')
  const engine = makeEngine(fx)

  const captured = await capturePoint(engine, fx)
  const track = captured.point?.workspace
  assert.equal(track?.ok, true)
  // 预期内的忽略 → 不算降级（否则每个 JS 工程的每个回滚点都是 degraded）
  assert.equal(track?.degraded, false)
  assert.equal((track?.payload?.files ?? []).some((f) => f.path.includes('node_modules')), false)
  assert.ok((track?.payload?.excludedDirs ?? []).some((s) => s.reason === 'dep-dir' && s.path.includes('node_modules')),
    JSON.stringify(track?.payload?.excludedDirs))

  // 预览的 createdAfter 也不把 node_modules 里的文件算成「之后新建」
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdAfter, 0)

  // 回退也不碰它（没有记录在案的路径）
  const rewound = await engine.rewind({ id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files' })
  assert.equal(rewound.outcome, 'restored')
  assert.equal(await readText(path.join(depDir, 'index.js')), 'module.exports = 1')
})

/* ================================ R-21 捕获边界（t13：单文件上限 / 预算耗尽 / 截断留痕） */

/** 在 ws 下单独开一个子目录放固定大小的文件（只把这个目录当分块，断言才不被夹具自带文件干扰）。 */
async function makeSizeDir(fx: Fixture, name: string, files: Record<string, number>): Promise<string> {
  const dir = path.join(fx.workspaceDir, name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, size] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), 'x'.repeat(size))
  }
  return dir
}

test('R-21① 单文件上限：**首个**文件超限也先 stat 后跳过（不进对象仓、不整份读进内存）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const big = 'x'.repeat(400)
  const dir = await makeSizeDir(fx, 'cap-single', { 'a-big.txt': 400, 'b-small.txt': 5 })
  // 单文件上限 64：a-big.txt 先被 stat 判定超限 → 跳过；b-small.txt 正常入仓
  const engine = makeEngine(fx, { maxFileBytes: 64, maxBytes: 1_000_000 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 'session-1111' })
  assert.equal(captured.ok, true)
  const track = captured.point?.workspace
  const payload = track?.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.deepEqual(payload.files.map((f) => path.basename(f.path)), ['b-small.txt'])
  const skipped = payload.skipped.find((s) => s.path.endsWith('a-big.txt'))
  assert.equal(skipped?.reason, 'too-large', JSON.stringify(payload.skipped))
  assert.equal(payload.truncated, true)
  assert.equal(track?.reasonCode, 'capture-truncated')
  assert.equal(payload.skippedCount, 1)
  // 「先 stat 判大小、绝不整份读进内存」的硬证据：它的内容从未进对象仓（没被读/没被哈希）
  assert.equal(await objectExists(engine, sha256Hex(big)), false, '超限文件不得被读入并落对象仓')
})

test('R-21② 字节预算耗尽：其后**每一条**都进 skipped（budget-bytes），不再 break 静默丢弃', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-bytes', {
    'f1.txt': 10, 'f2.txt': 10, 'f3.txt': 10, 'f4.txt': 10,
  })
  // 预算 25：f1(10) + f2(10) 进；f3/f4 都会超预算 → 逐条记 budget-bytes
  const engine = makeEngine(fx, { maxBytes: 25, maxFileBytes: 1000 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 'session-1111' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.deepEqual(payload.files.map((f) => path.basename(f.path)), ['f1.txt', 'f2.txt'])
  const skippedNames = payload.skipped.map((s) => path.basename(s.path))
  assert.deepEqual(skippedNames, ['f3.txt', 'f4.txt'], JSON.stringify(payload.skipped))
  assert.deepEqual(payload.skipped.map((s) => s.reason), ['budget-bytes', 'budget-bytes'])
  assert.equal(payload.truncated, true)
  assert.equal(payload.skippedCount, 2)
  assert.equal(captured.point?.workspace.reasonCode, 'capture-truncated')
})

test('R-21③ maxFiles 截断：超预算文件（含遍历器溢出）逐条进 skipped', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-files', { 'g1.txt': 3, 'g2.txt': 3, 'g3.txt': 3 })
  const engine = makeEngine(fx, { maxFiles: 1 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 'session-1111' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.files.length, 1)
  assert.equal(payload.files[0]?.path, path.join(dir, 'g1.txt'))
  assert.deepEqual(payload.skipped.map((s) => path.basename(s.path)), ['g2.txt', 'g3.txt'], JSON.stringify(payload.skipped))
  assert.deepEqual(payload.skipped.map((s) => s.reason), ['budget-files', 'budget-files'])
  assert.equal(payload.truncated, true)
  assert.equal(payload.skippedCount, 2)
})

test('R-21④ 截断标记与跳过计数在列表 / 详情 / 预览三处如实回传', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-surface', { 'h1.txt': 10, 'h2.txt': 10, 'h3.txt': 10 })
  const engine = makeEngine(fx, { maxBytes: 15, maxFileBytes: 1000 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 'session-1111' })
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')

  // 列表：摘要段带 skippedCount / truncated / capture-truncated
  const list = await engine.list()
  const wsSummary = list.points[0]?.segments.find((s) => s.state === 'workspace')
  assert.equal(wsSummary?.skippedCount, 2, JSON.stringify(wsSummary))
  assert.equal(wsSummary?.truncated, true)
  assert.equal(wsSummary?.reasonCode, 'capture-truncated')
  // 会话段恒 0 / false（不该把工作区的截断算到会话头上）
  const sessionSummary = list.points[0]?.segments.find((s) => s.state === 'session')
  assert.equal(sessionSummary?.skippedCount, 0)
  assert.equal(sessionSummary?.truncated, false)

  // 详情：完整记录里逐条可见 + 计数一致
  const detail = await engine.read(id)
  const wsPayload = detail.point?.workspace.payload
  assert.ok(wsPayload !== null && wsPayload !== undefined)
  assert.equal(wsPayload.skippedCount, 2)
  assert.deepEqual(wsPayload.skipped.map((s) => path.basename(s.path)), ['h2.txt', 'h3.txt'])
  assert.equal(wsPayload.skippedTruncated, false)

  // 预览：同一口径（零写入）
  const preview = await engine.preview(id)
  assert.equal(preview.workspace.skippedCount, 2)
  assert.equal(preview.workspace.truncated, true)
  assert.equal(preview.workspace.overwrite, 1)
  assert.equal(await readText(path.join(dir, 'h2.txt')), 'xxxxxxxxxx', '预览必须零写入')
})

test('R-21⑤ 逐条记录有上限，但计数与截断标记绝不静默（skippedCount 仍为真实总数）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-skiplist', { 'k1.txt': 3, 'k2.txt': 3, 'k3.txt': 3, 'k4.txt': 3 })
  // 只允许记 1 条：剩下 3 条只计数
  const engine = makeEngine(fx, { maxFiles: 1, maxSkippedEntries: 1 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 'session-1111' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.files.length, 1)
  assert.equal(payload.skipped.length, 1, '逐条列表按上限只记 1 条')
  assert.equal(payload.skippedCount, 3, '计数必须仍是真实总数（不静默）')
  assert.equal(payload.skippedTruncated, true, '列表被截断必须显式置位')
  assert.equal(payload.truncated, true)
  assert.equal(captured.point?.workspace.degraded, true)
  assert.ok((captured.point?.workspace.reasonDetail ?? '').includes('skipped=3(list-capped)'), String(captured.point?.workspace.reasonDetail))
})

/* ============================ R-22 台账单写者（t14-F1：并发 capture/remove/rewind ≥20 轮） */

test('R-22 并发：两个引擎实例（tracker 与路由）交错 capture / remove / rewind，无丢失更新、无复活', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 生产形状：宿主自动留点器持一个引擎，路由**每个请求新建**一个引擎 —— 两个实例写同一份 index.json
  const tracker = makeEngine(fx)
  const route = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-r' }) })
  const ROUNDS = 20
  const problems: string[] = []

  for (let i = 0; i < ROUNDS; i += 1) {
    const session = 's-race-' + String(i)
    const base = { sessionId: session, sessionLogPath: fx.logFile, boundarySeq: 1 }
    const ids: string[] = []
    for (let k = 0; k < 3; k += 1) {
      const p = await tracker.capturePoint({ chunks: [fx.workspaceDir], unitId: session, ...base, turnSeq: k })
      assert.equal(p.ok, true, p.detail ?? p.code)
      ids.push(p.point?.id ?? '')
    }
    const victim = ids[1] ?? ''
    const victim2 = ids[2] ?? ''
    await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A-r' + String(i))

    // 三条并发写：自动留点 + 删除 + 回退（回退内部要留 guard 救援点）
    const [captured, removed, rewound] = await Promise.all([
      tracker.capturePoint({ chunks: [fx.workspaceDir], unitId: session, ...base, turnSeq: 99 }),
      route.remove(victim),
      route.rewind({ id: victim2, userConfirmed: true, mode: 'files' }),
    ])

    // 每轮**立刻**读台账（不等后续轮次，避免跨轮淘汰干扰判据）
    const records = (await ledgerOf(tracker)).records
    const kept = records.map((r) => r.id)
    assert.equal(new Set(kept).size, kept.length, '台账不得出现重复 id（丢更新的典型症状）')
    if (removed.ok && kept.includes(victim)) problems.push('#' + String(i) + ' 删除成功却又复活')
    const newId = captured.point?.id ?? ''
    if (captured.ok && newId !== '' && !kept.includes(newId)) problems.push('#' + String(i) + ' 留点返回 ok 但台账里没有')
    if (rewound.guardPointId !== undefined && !kept.includes(rewound.guardPointId)) {
      problems.push('#' + String(i) + ' 响应回了 guardPointId 但台账里已不存在')
    }
  }

  assert.deepEqual(problems, [], JSON.stringify(problems))
  assert.equal(ROUNDS >= 20, true)
})

/* ============================ R-23 窄化函数（t14-F2：形状不符走显式机器码） */

test('R-23 事件窄化：非对象 / 缺 seq（非有限数）/ 缺 type → 显式 invalid-input；data 原样透传', () => {
  const SID = 'session-abc'
  // 形状不符（历史实现返回 null = 静默什么都不做）
  for (const bad of [undefined, null, 1, 'x', [], true]) {
    const r = rollbackTrackedEventOf(SID, bad)
    assert.equal(r.ok, false, String(bad))
    if (!r.ok) assert.equal(r.code, 'invalid-input')
  }
  const seqCases: [string, unknown][] = [
    ['缺 seq', { type: 'turn/end', data: { turn: 1 } }],
    ['seq 是字符串', { seq: '3', type: 'turn/end' }],
    ['seq=NaN', { seq: Number.NaN, type: 'turn/end' }],
    ['seq=Infinity', { seq: Number.POSITIVE_INFINITY, type: 'turn/end' }],
  ]
  for (const [label, ev] of seqCases) {
    const r = rollbackTrackedEventOf(SID, ev)
    assert.equal(r.ok, false, label)
    if (!r.ok) assert.deepEqual({ code: r.code, detail: r.detail }, { code: 'invalid-input', detail: 'event-seq-missing' }, label)
  }
  for (const badType of [{ seq: 1 }, { seq: 1, type: '' }, { seq: 1, type: 7 }]) {
    const r = rollbackTrackedEventOf(SID, badType)
    assert.equal(r.ok, false, JSON.stringify(badType))
    if (!r.ok) assert.equal(r.detail, 'event-type-missing')
  }
  const noSession = rollbackTrackedEventOf('', { seq: 0, type: 'turn/start' })
  assert.equal(noSession.ok, false)
  if (!noSession.ok) assert.equal(noSession.detail, 'session-id-missing')

  // 合法事件：data 原样透传（turn/end 的 data.turn 必须到得了留点器）
  const ok = rollbackTrackedEventOf(SID, { seq: 7, type: 'turn/end', data: { turn: 3, reason: 'success' } })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.event.seq, 7)
    assert.equal(ok.event.type, 'turn/end')
    assert.equal(ok.event.sessionId, SID)
    assert.deepEqual(ok.event.data, { turn: 3, reason: 'success' })
  }
  const noData = rollbackTrackedEventOf(SID, { seq: 1, type: 'turn/start' })
  assert.equal(noData.ok, true)
  if (noData.ok) assert.equal('data' in noData.event, false, '没有 data 时不得造一个假的')
})

test('R-23b 会话登记窄化：cwd 缺失 / 非绝对 → 不留 chunks 且给机器码；绝对 cwd → chunks+unitId', () => {
  for (const bad of [undefined, null, 1, 'x', true]) {
    const r = rollbackSessionBindingOf(bad)
    assert.equal(r.ok, false, String(bad))
    if (!r.ok) assert.deepEqual({ code: r.code, detail: r.detail }, { code: 'invalid-input', detail: 'session-not-object' })
  }
  // 数组是 object 但没有 id → 更精确的 session-id-missing（同样是显式机器码，不静默）
  for (const bad of [{}, { id: '' }, { id: 7 }, []]) {
    const r = rollbackSessionBindingOf(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    if (!r.ok) assert.equal(r.detail, 'session-id-missing')
  }
  const noCwd = rollbackSessionBindingOf({ id: 's1', header: {} })
  assert.equal(noCwd.ok, true)
  if (noCwd.ok) {
    assert.equal(noCwd.chunkless, 'cwd-missing')
    assert.equal(noCwd.binding.sessionId, 's1')
    assert.equal('chunks' in noCwd.binding, false, 'cwd 缺失 → 绝不留 chunks')
  }
  const noHeader = rollbackSessionBindingOf({ id: 's1' })
  assert.equal(noHeader.ok, true)
  if (noHeader.ok) assert.equal(noHeader.chunkless, 'cwd-missing')
  const relative = rollbackSessionBindingOf({ id: 's1', header: { cwd: path.join('relative', 'ws') } })
  assert.equal(relative.ok, true)
  if (relative.ok) {
    assert.equal(relative.chunkless, 'cwd-not-absolute')
    assert.equal('chunks' in relative.binding, false)
  }
  const cwd = path.resolve('.')
  const ok = rollbackSessionBindingOf({ id: 's1', header: { cwd } })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.chunkless, null)
    assert.deepEqual(ok.binding.chunks, [cwd])
    assert.equal(ok.binding.unitId, projectKeyOf(cwd) + '/s1')
  }
})

test('R-23c 集成：chunkless 会话留点 → 该点 incomplete=true 且 workspace.reasonCode=no-chunks（显式可断言）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const tracker = new RollbackAutoTracker({ engine })
  // cwd 非绝对 → 登记里没有 chunks
  const bindingResult = rollbackSessionBindingOf({ id: 'session-1111', header: { cwd: 'relative/path' } })
  assert.equal(bindingResult.ok, true)
  if (!bindingResult.ok) return
  assert.equal(bindingResult.chunkless, 'cwd-not-absolute')
  tracker.registerSession(bindingResult.binding)
  await tracker.noteEvent({ sessionId: 'session-1111', seq: 2, type: 'turn/start', data: { turn: 2 } })
  const captured = await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 2 } })
  assert.equal(captured.captured, true)
  const point = (await engine.list()).points[0]
  assert.equal(point?.incomplete, true, '会话态-only 的点必须显式 incomplete，不许静默降级')
  const wsSegment = point?.segments.find((s) => s.state === 'workspace')
  assert.equal(wsSegment?.reasonCode, 'no-chunks')
  assert.equal(wsSegment?.ok, false)
  assert.equal(point?.sessionId, 'session-1111')
})

/* ============================ R-24 guard 留存例外（t14-F3：不许无界增长） */

test('R-24 guard 留存：不被自动点的 20/50 淘汰，但受自身上限约束（超出淘汰最旧 guard）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  assert.equal(ROLLBACK_MAX_GUARDS_PER_SESSION, 20)

  // ① guard 不占自动点预算：maxRecords=1 / maxRecordsPerSession=1 时 3 个自动点只留最新 1 个，3 个 guard 全留
  const engine = makeEngine(fx, { maxRecords: 1, maxRecordsPerSession: 1, now: steppingClock(9_000_000, 10) })
  const guardIds: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const g = await engine.capturePoint({ kind: 'guard', sessionId: 's-g', sessionLogPath: fx.logFile, chunks: [fx.workspaceDir], boundarySeq: 1, turnSeq: i })
    guardIds.push(g.point?.id ?? '')
  }
  const autoIds: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const a = await capturePoint(engine, fx, { sessionId: 's-g' })
    autoIds.push(a.point?.id ?? '')
  }
  let kept = (await ledgerOf(engine)).records.map((r) => r.id)
  for (const id of guardIds) assert.ok(kept.includes(id), 'guard 不许被自动点的 20/50 淘汰')
  assert.equal(kept.includes(autoIds[0] ?? ''), false, '最旧的自动点仍按 20/50 淘汰')
  assert.equal(kept.includes(autoIds[2] ?? ''), true)

  // ② guard 有自己的上限：每会话 25 个 → 只留最近 20 个（淘汰最旧 5 个）
  const capped = makeEngine(fx, { now: steppingClock(10_000_000, 10) })
  const ids: string[] = []
  for (let i = 0; i < 25; i += 1) {
    const g = await capped.capturePoint({ kind: 'guard', sessionId: 's-cap', sessionLogPath: fx.logFile, chunks: [fx.workspaceDir], boundarySeq: 1, turnSeq: i })
    ids.push(g.point?.id ?? '')
  }
  kept = (await ledgerOf(capped)).records.map((r) => r.id)
  const guardsOfCap = kept.filter((id) => ids.includes(id))
  assert.equal(guardsOfCap.length, 20, '每会话 guard 上限 = 20（不许无界增长）')
  for (let i = 0; i < 5; i += 1) assert.equal(kept.includes(ids[i] ?? ''), false, '最旧的 guard 被淘汰')
  assert.equal(kept.includes(ids[24] ?? ''), true, '最新的 guard 保留')

  // ③ 用户仍然删不掉 guard（自动淘汰 ≠ 用户删除）
  const removed = await capped.remove(ids[24] ?? '')
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'protected-point')
})

/* ============ R-25 canRestore 与 canRemove 解耦（t22：救援点可作回退目标） */

test('R-25 preview 准入：guard 可回退不可删、protected 两者皆否、incomplete 不可回退（逐条钉住）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })

  // ① guard（救援点）：canRestore=true、canRemove=false —— 这正是本次修复的矛盾点
  const guard = await engine.capturePoint({
    kind: 'guard', chunks: [fx.workspaceDir], sessionId: 'session-1111',
    sessionLogPath: fx.logFile, boundarySeq: 1, turnSeq: 2, boundaryEndSeq: 6,
  })
  const guardId = guard.point?.id ?? ''
  const guardPreview = await engine.preview(guardId)
  assert.equal(guardPreview.ok, true)
  assert.equal(guardPreview.canRestore, true, '救援点必须可作回退目标（回到回退前那一刻）')
  assert.equal(guardPreview.canRemove, false, '救援点仍不可被用户删除')
  assert.equal(guardPreview.point?.kind, 'guard')
  assert.equal(guard.point?.protected, false, 'guard 的 protected 标记恒 false（保护靠 kind）')

  // ② protected（用户显式保护）：两者皆否
  const prot = await capturePoint(engine, fx, { sessionId: 's-prot', protect: true })
  const protPreview = await engine.preview(prot.point?.id ?? '')
  assert.equal(protPreview.canRestore, false)
  assert.equal(protPreview.canRemove, false)

  // ③ incomplete（没有会话态）：不可回退（缺省口径；allowPartial 是 rewind 的显式放行，不在 preview 里）
  const incomplete = await engine.capturePoint({ chunks: [fx.workspaceDir] })
  const incompletePreview = await engine.preview(incomplete.point?.id ?? '')
  assert.equal(incompletePreview.point?.incomplete, true)
  assert.equal(incompletePreview.canRestore, false)
  assert.equal(incompletePreview.canRemove, true, '两态不全不影响「可删除」')

  // ④ preview 说能恢复 ⇒ rewind 必须真能成功（一份口径，不是两套判定）
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A-BROKEN')
  const rewound = await engine.rewind({ id: guardId, userConfirmed: true })
  assert.equal(rewound.outcome, 'restored', JSON.stringify({ o: rewound.outcome, c: rewound.code, seg: rewound.segments.map((s) => [s.state, s.status]) }))
  assert.equal(rewound.code, 'ok')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1', '救援点确实是「回退前那一刻」的完整快照')
  // S5 不变：回退前仍必须先留一个新的救援点
  assert.ok(rewound.guardPointId !== undefined && rewound.guardPointId !== guardId, '回退前必须再留一个救援点')
  const ledger = await ledgerOf(engine)
  assert.ok(ledger.records.some((r) => r.id === rewound.guardPointId), '新救援点必须真的落进台账')
  // 而用户依旧删不掉它
  const removed = await engine.remove(guardId)
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'protected-point')
})

/* ================================== E1 nothing-to-restore 不再是失败 */

test('R-26 E1：工作区段无可恢复内容（files=0）不再中止整体 —— 会话照常 fork 出子会话', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const emptyDir = path.join(fx.root, 'empty-ws')
  await fs.mkdir(emptyDir, { recursive: true })
  const calls: RollbackForkInput[] = []
  const engine = makeEngine(fx, {
    fork: async (input) => { calls.push(input); return { ok: true, childSessionId: 'child-empty' } },
  })
  const captured = await engine.capturePoint({
    chunks: [emptyDir],
    sessionId: 'session-1111',
    unitId: 'proj-key/session-1111',
    sessionLogPath: fx.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
  })
  const record = captured.point
  assert.ok(record !== undefined)
  assert.equal(record.workspace.ok, true)
  assert.equal(record.workspace.payload?.files.length, 0, '夹具必须真的记录 0 个文件')
  assert.equal(record.incomplete, false, '两态都在，记录不算不全')

  const rewound = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  // 工作区段 = 「成功、0 变更」：不是失败、也不进 skippedSegments（它**执行过**）
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'restored', JSON.stringify(ws))
  assert.equal(ws?.restored, 0)
  // T10：该点**没有记录任何文件** ⇒ 独立码（与「有记录但全部一致」分开，界面要说两句不同的话）
  assert.equal(ws?.reasonCode, 'no-recorded-files')
  assert.deepEqual(rewound.skippedSegments, [], '「执行过、0 变更」不同于「没执行」')
  // 会话段照常执行：子会话真的 fork 了，整体仍是成功（不是 500）
  assert.deepEqual(calls, [{ sessionId: 'session-1111', boundarySeq: 1 }], '会话段必须继续执行')
  assert.equal(rewound.segments.find((s) => s.state === 'session')?.status, 'restored')
  assert.equal(rewound.childSessionId, 'child-empty')
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  assert.equal(rewound.code, 'ok')
  assert.equal(rewound.ok, true)
})

test('R-27 E1：所有段都无可恢复内容 → outcome=restored + code=nothing-to-restore（不是 failed）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const emptyDir = path.join(fx.root, 'empty-ws')
  await fs.mkdir(emptyDir, { recursive: true })
  const engine = makeEngine(fx)
  // 只录工作区（无会话输入）⇒ 会话段没有可用捕获（skipped），工作区段文件数 = 0
  const captured = await engine.capturePoint({ chunks: [emptyDir] })
  const record = captured.point
  assert.ok(record !== undefined)
  assert.equal(record.incomplete, true)

  // ① 只请求工作区段：该段「执行过、0 变更」⇒ 整体成功、0 变更
  const onlyWorkspace = await engine.rewind({
    id: record.id, userConfirmed: true, allowPartial: true, segments: ['workspace'], guardPolicy: 'off',
  })
  assert.equal(onlyWorkspace.outcome, 'restored', JSON.stringify(onlyWorkspace.segments))
  assert.equal(onlyWorkspace.code, 'nothing-to-restore')
  assert.equal(onlyWorkspace.ok, true)
  assert.equal(onlyWorkspace.segments[0]?.reasonCode, 'no-recorded-files')

  // ② 两段都无事可做（工作区 0 文件 + 会话没有可用捕获）⇒ 同样是成功、0 变更
  const both = await engine.rewind({ id: record.id, userConfirmed: true, allowPartial: true, guardPolicy: 'off' })
  assert.equal(both.outcome, 'restored', JSON.stringify(both.segments))
  assert.equal(both.code, 'nothing-to-restore')
  assert.equal(both.ok, true)
  assert.equal(both.segments.length, 2)
})

/* ================================== E1 预览：逐文件行级统计 */

test('R-28 E1：预览只列会被改动的文件，added/removed 来自「快照对象 vs 当前内容」的行级 diff', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  await fs.writeFile(path.join(fx.workspaceDir, 'empty.txt'), '')
  await fs.writeFile(path.join(fx.workspaceDir, 'multi.txt'), 'L1\nL2\nL3\n')
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.equal(captured.point?.workspace.payload?.files.length, 4)

  // ① 完全一致（截图里「要盖 353 项 / 其中 0 项内容不同」那一幕）⇒ **空数组**，而不是逐条列出
  const untouched = await engine.preview(id)
  assert.equal(untouched.workspace.overwrite, 4, '既有计数字段保持向后兼容')
  assert.equal(untouched.workspace.different, 0)
  assert.equal(untouched.workspace.missing, 0)
  assert.equal(untouched.workspace.createdAfter, 0)
  assert.deepEqual(untouched.workspace.files, [])
  assert.equal(untouched.canRestore, true)

  // ② 三种真实改动：行增减 / 清空（回退要补行）/ 删文件（回退会重建）
  await fs.writeFile(path.join(fx.workspaceDir, 'multi.txt'), 'L1\nL3\nL4\n')
  await fs.writeFile(path.join(fx.workspaceDir, 'empty.txt'), 'X\nY\n')
  await fs.rm(path.join(fx.workspaceDir, 'src', 'b.txt'))

  const preview = await engine.preview(id)
  assert.equal(preview.workspace.different, 2)
  assert.equal(preview.workspace.missing, 1)
  assert.equal(preview.workspace.createdAfter, 0)
  const files = preview.workspace.files
  assert.deepEqual(files.map((f) => path.basename(f.path)), ['empty.txt', 'multi.txt', 'b.txt'], '只列会被改动的文件（a.txt 一致 ⇒ 不列）')
  const byName = new Map(files.map((f) => [path.basename(f.path), f]))
  assert.deepEqual(
    byName.get('multi.txt'),
    { path: path.join(fx.workspaceDir, 'multi.txt'), status: 'overwrite', added: 1, removed: 1, truncated: false },
    'L1/L3/L4 → L1/L2/L3：新增 1 行（L2）、删除 1 行（L4）',
  )
  assert.deepEqual(
    byName.get('empty.txt'),
    { path: path.join(fx.workspaceDir, 'empty.txt'), status: 'overwrite', added: 0, removed: 2, truncated: false },
    '快照是空文件（0 行）⇒ 覆盖回退会删掉当前的 2 行',
  )
  assert.deepEqual(
    byName.get('b.txt'),
    { path: path.join(fx.workspaceDir, 'src', 'b.txt'), status: 'create', added: 1, removed: 0, truncated: false },
    '当前已不存在 ⇒ create，新增 = 快照行数',
  )
  for (const f of files) {
    assert.ok(f.status === 'overwrite' || f.status === 'create', '回退绝不删除文件 ⇒ 列表里不会出现 delete')
  }
  // 预览零写入：内容与统计都来自只读
  assert.equal(await readText(path.join(fx.workspaceDir, 'multi.txt')), 'L1\nL3\nL4\n')
})

test('R-29 E1：空文件边界 + 超限保护（status 照给，added/removed 置 null 且 truncated=true，绝不谎报）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  await fs.writeFile(path.join(fx.workspaceDir, 'empty.txt'), '')
  await fs.writeFile(path.join(fx.workspaceDir, 'multi.txt'), 'L1\nL2\nL3\n')
  await fs.writeFile(path.join(fx.workspaceDir, 'swap.txt'), 'S1\nS2\nS3\n')
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''

  // ① 空文件边界（快照 0 字节）→ 当前 2 行：覆盖回退会删掉这 2 行（不是「没变化」）
  await fs.writeFile(path.join(fx.workspaceDir, 'empty.txt'), 'X\nY\n')
  // ② 反向边界（快照 3 行）→ 当前被清空：覆盖回退会补回 3 行
  await fs.writeFile(path.join(fx.workspaceDir, 'multi.txt'), '')
  // ③ 当前多出的行 → removed；④ 纯换序（行集合相同、顺序不同）→ 真 diff 仍报 1/1
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A1\nEXTRA1\nEXTRA2\n')
  await fs.writeFile(path.join(fx.workspaceDir, 'swap.txt'), 'S1\nS3\nS2\n')

  const boundary = await engine.preview(id)
  const pick = (name: string) => boundary.workspace.files.find((f) => f.path.endsWith(name))
  assert.deepEqual([pick('empty.txt')?.added, pick('empty.txt')?.removed], [0, 2])
  assert.deepEqual([pick('multi.txt')?.added, pick('multi.txt')?.removed], [3, 0])
  assert.deepEqual([pick('a.txt')?.added, pick('a.txt')?.removed], [0, 2])
  assert.deepEqual([pick('swap.txt')?.added, pick('swap.txt')?.removed], [1, 1], '行级 diff 不是「集合差」：换序也算 1 增 1 删')
  for (const f of boundary.workspace.files) assert.equal(f.truncated, false)

  // ⑤ 单文件超限：status 照给、数字不给（不谎报）
  const tiny = makeEngine(fx, { previewDiffMaxFileBytes: 4 })
  const capped = (await tiny.preview(id)).workspace.files.find((f) => f.path.endsWith('swap.txt'))
  assert.equal(capped?.status, 'overwrite', '超限也必须照给 status')
  assert.equal(capped?.added, null)
  assert.equal(capped?.removed, null)
  assert.equal(capped?.truncated, true)

  // ⑥ 单张预览累计字节超限：其后每一条都只给 status
  const totalPreview = await makeEngine(fx, { previewDiffMaxTotalBytes: 1 }).preview(id)
  assert.ok(totalPreview.workspace.files.length > 0)
  assert.ok(totalPreview.workspace.files.every((f) => f.truncated && f.added === null && f.removed === null))

  // ⑦ 行级比对步数超限：需要真比对的条目放弃（null + truncated），但「一侧为空」的边界步数为 0，仍给数字
  const noWork = await makeEngine(fx, { previewDiffMaxWork: 0 }).preview(id)
  const noWorkSwap = noWork.workspace.files.find((f) => f.path.endsWith('swap.txt'))
  assert.equal(noWorkSwap?.truncated, true)
  assert.equal(noWorkSwap?.added, null)
  const noWorkMulti = noWork.workspace.files.find((f) => f.path.endsWith('multi.txt'))
  assert.deepEqual([noWorkMulti?.added, noWorkMulti?.removed], [3, 0])

  // ⑧ 非文本内容不做行统计（编不出来的行数 ⇒ null + truncated，而不是猜一个数）
  const binary = Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x01, 0x02])
  await fs.writeFile(path.join(fx.workspaceDir, 'bin.dat'), binary)
  const engine2 = makeEngine(fx)
  const recaptured = await capturePoint(engine2, fx)
  await fs.writeFile(path.join(fx.workspaceDir, 'bin.dat'), Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x09, 0x08]))
  const bin = (await engine2.preview(recaptured.point?.id ?? '')).workspace.files.find((f) => f.path.endsWith('bin.dat'))
  assert.equal(bin?.status, 'overwrite')
  assert.equal(bin?.truncated, true)
  assert.equal(bin?.added, null)
  assert.equal(bin?.removed, null)
})

/* ==================== T10：安全链（幽灵 guardPointId）与 stat 失败语义 ==================== */

/** 只读台账探针：真写一次（空追加）判断本机 chmod 是否真的挡住了写（挡不住就跳过，不伪造结论）。 */
async function ledgerWritable(file: string): Promise<boolean> {
  try {
    await fs.appendFile(file, '')
    return true
  } catch {
    return false
  }
}

test('R-30 T10：台账写失败 ⇒ 没有幽灵 guardPointId（require 档整体中止、零写入、不 fork）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  const ledgerPath = path.join(engine.storeDir, 'index.json')
  const before = await readText(ledgerPath)
  await fs.chmod(ledgerPath, 0o444)
  try {
    if (await ledgerWritable(ledgerPath)) {
      t.skip('本机 chmod 后 index.json 仍可写，无法构造台账写失败')
      return
    }
    // 前置事实：写台账失败时 capturePoint **不再**回传内存 record
    // （旧实现回传它，消费方拿 point.id 当「留点成功」⇒ 幽灵 id）
    const blocked = await capturePoint(engine, fx)
    assert.equal(blocked.ok, false, JSON.stringify(blocked))
    assert.equal(blocked.code, 'ledger-write-failed')
    assert.equal(blocked.point, undefined, '写失败不得回传一个可被误当成功的 record')

    // S5 硬门：留不下救援点 ⇒ 整体中止
    const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'require' })
    assert.equal(rewound.outcome, 'failed', JSON.stringify(rewound))
    assert.equal(rewound.code, 'guard-failed', String(rewound.detail ?? ''))
    assert.equal(rewound.guardPointId, undefined, '留不下救援点就绝不能报 guardPointId')
    assert.equal(rewound.childSessionId, undefined, '中止 ⇒ 不 fork')
    assert.deepEqual(rewound.segments, [], '中止 ⇒ 一段都不执行（零写入）')
    assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2', '零写入')

    // warn 档：按既有策略只要告警继续，但同样**不报** guardPointId
    const warned = await engine.rewind({ id, userConfirmed: true, segments: ['workspace'] })
    assert.equal(warned.outcome, 'restored', JSON.stringify(warned))
    assert.equal(warned.guardPointId, undefined, 'warn 档也不得报幽灵救援点')
    assert.ok(warned.warnings.some((w) => w.code === 'rollback.warn.guardFailed'), JSON.stringify(warned.warnings))
    assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1', 'warn 档照常回退工作区')
  } finally {
    await fs.chmod(ledgerPath, 0o666)
  }
  assert.equal(await readText(ledgerPath), before, '整个过程台账一个字节都没被写')
})

test('R-31 T10：留点成功时 guardPointId 必然可 read（台账里真有它）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  // 缺省 warn 档也要求「真的留下救援点」
  const rewound = await engine.rewind({ id, userConfirmed: true })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound))
  const guardId = rewound.guardPointId
  assert.equal(typeof guardId, 'string', JSON.stringify(rewound))
  assert.notEqual(guardId, '')
  const readBack = await engine.read(guardId ?? '')
  assert.equal(readBack.error, undefined, String(readBack.error ?? ''))
  assert.equal(readBack.point?.id, guardId, 'guardPointId 必须能在台账里查到')
  assert.equal(readBack.point?.kind, 'guard')
  assert.ok((await ledgerOf(engine)).records.some((r) => r.id === guardId))

  // 再回退一次：报出来的每个 id 都要查得到（不是同一个，也不是幽灵）
  const again = await engine.rewind({ id, userConfirmed: true, segments: ['workspace'] })
  assert.notEqual(again.guardPointId, guardId)
  assert.equal((await engine.read(again.guardPointId ?? '')).point?.id, again.guardPointId)
})

test('R-32 T10：台账写失败时 tracker 不得报 captured=true（不能记住幽灵 pointId）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 'session-1111',
    unitId: 'proj-key/session-1111',
    logPath: fx.logFile,
    chunks: [fx.workspaceDir],
  })
  const first = await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 1 } })
  assert.equal(first.captured, true, first.detail ?? '')
  assert.equal(typeof first.pointId, 'string')

  const ledgerPath = path.join(engine.storeDir, 'index.json')
  await fs.chmod(ledgerPath, 0o444)
  try {
    if (await ledgerWritable(ledgerPath)) {
      t.skip('本机 chmod 后 index.json 仍可写，无法构造台账写失败')
      return
    }
    const second = await tracker.noteEvent({ sessionId: 'session-1111', seq: 12, type: 'turn/end', data: { turn: 2 } })
    assert.equal(second.captured, false, JSON.stringify(second))
    assert.equal(second.pointId, undefined, '写失败不得报 pointId')
    assert.equal(second.code, 'ledger-write-failed')
    assert.equal((await ledgerOf(engine)).records.length, 1, '台账里绝不能出现第二个点')
  } finally {
    await fs.chmod(ledgerPath, 0o666)
  }
})

test('R-33 T10：preview 的 stat 失败语义 —— 只有 ENOENT 才算「当前不存在」', async (t) => {
  // ① 纯函数口径（本机无法确定性构造 EACCES，故把判定函数本身钉死）
  assert.equal(classifyPreviewStatFailure({ code: 'ENOENT' }), 'missing')
  assert.equal(
    classifyPreviewStatFailure(new Error('ENOENT: no such file or directory, stat x')),
    'unavailable',
    '只看 errno code，不看 message',
  )
  for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EBUSY', 'ERR_INVALID_ARG_VALUE', 'UNKNOWN']) {
    assert.equal(classifyPreviewStatFailure({ code }), 'unavailable', code)
  }
  assert.equal(classifyPreviewStatFailure(null), 'unavailable')
  assert.equal(classifyPreviewStatFailure('ENOENT'), 'unavailable')
  assert.equal(classifyPreviewStatFailure({ code: 2 }), 'unavailable')

  // ② 真 fs.stat 的**非 ENOENT** 失败贯穿整条预览：含 NUL 的非法路径 → ERR_INVALID_ARG_VALUE
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  const ledgerPath = path.join(engine.storeDir, 'index.json')
  interface TamperableRecord { id: string; workspace: { payload: { files: { path: string }[] } | null } }
  const ledger = JSON.parse(await readText(ledgerPath)) as { records: TamperableRecord[] }
  const record = ledger.records.find((r) => r.id === id)
  assert.ok(record !== undefined && record.workspace.payload !== null)
  const victim = record.workspace.payload?.files.find((f) => f.path.endsWith('a.txt'))
  assert.ok(victim !== undefined)
  victim.path = path.join(fx.workspaceDir, 'a' + String.fromCharCode(0) + '.txt')
  await fs.writeFile(ledgerPath, JSON.stringify(ledger))

  const preview = await engine.preview(id)
  assert.equal(preview.workspace.missing, 0, '非 ENOENT 的 stat 失败**不是**「当前不存在」')
  assert.equal(preview.workspace.different, 1)
  assert.equal(preview.workspace.files.length, 1)
  const entry = preview.workspace.files[0]
  assert.equal(entry?.status, 'overwrite', '存在性未知 ⇒ 绝不报成 create')
  assert.equal(entry?.added, null)
  assert.equal(entry?.removed, null)
  assert.equal(entry?.truncated, true)

  // ③ 对照：真的不存在（ENOENT）仍然是 create + 快照行数
  const fresh = await makeFixture()
  t.after(fresh.cleanup)
  const engine2 = makeEngine(fresh)
  const captured2 = await capturePoint(engine2, fresh)
  await fs.rm(path.join(fresh.workspaceDir, 'a.txt'))
  const preview2 = await engine2.preview(captured2.point?.id ?? '')
  assert.equal(preview2.workspace.missing, 1)
  const gone = preview2.workspace.files.find((f) => f.path.endsWith('a.txt'))
  assert.equal(gone?.status, 'create')
  assert.equal(gone?.added, 1)
  assert.equal(gone?.removed, 0)
  assert.equal(gone?.truncated, false)
})

test('R-34 T10：工作区段「没记录文件」与「记录但全部一致」必须给不同的 reasonCode', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)

  // ① 记录在案的条目数 = 0（空分块）→ no-recorded-files
  const emptyDir = path.join(fx.root, 'empty-ws')
  await fs.mkdir(emptyDir, { recursive: true })
  const engine = makeEngine(fx)
  const empty = await engine.capturePoint({ chunks: [emptyDir] })
  assert.equal(empty.point?.workspace.payload?.files.length, 0)
  const noFiles = await engine.rewind({
    id: empty.point?.id ?? '', userConfirmed: true, allowPartial: true, segments: ['workspace'], guardPolicy: 'off',
  })
  const noFilesSegment = noFiles.segments.find((s) => s.state === 'workspace')
  assert.equal(noFilesSegment?.reasonCode, 'no-recorded-files', JSON.stringify(noFilesSegment))
  assert.equal(noFilesSegment?.status, 'restored')
  assert.equal(noFilesSegment?.restored, 0)
  assert.equal(noFiles.outcome, 'restored')
  assert.equal(noFiles.code, 'nothing-to-restore', '整体码不变（「没有可恢复的内容」）')

  // ② 有记录、但全部已与快照一致 → nothing-to-restore（**不是**同一个码）
  const sameDir = path.join(fx.root, 'same-ws')
  await fs.mkdir(sameDir, { recursive: true })
  await fs.writeFile(path.join(sameDir, 'x.txt'), 'X1\n')
  const engine2 = makeEngine(fx)
  const same = await engine2.capturePoint({ chunks: [sameDir] })
  assert.equal(same.point?.workspace.payload?.files.length, 1)
  const unchanged = await engine2.rewind({
    id: same.point?.id ?? '', userConfirmed: true, allowPartial: true, segments: ['workspace'], guardPolicy: 'off',
  })
  const unchangedSegment = unchanged.segments.find((s) => s.state === 'workspace')
  assert.equal(unchangedSegment?.reasonCode, 'nothing-to-restore', JSON.stringify(unchangedSegment))
  assert.equal(unchangedSegment?.restored, 0)
  assert.notEqual(
    unchangedSegment?.reasonCode,
    noFilesSegment?.reasonCode,
    '两条路径必须是不同的码（界面据此说两句不同的话，不靠 detail 分派）',
  )
})
