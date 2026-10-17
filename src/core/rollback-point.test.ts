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

import { RollbackWriteAttribution } from './rollback-attribution.ts'

import {
  ROLLBACK_ANCESTOR_MAX_DEPTH,
  ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES,
  ROLLBACK_DEFAULT_MAX_BYTES,
  ROLLBACK_DEFAULT_MAX_FILES,
  ROLLBACK_LEFTOVER_LIST_LIMIT,
  ROLLBACK_MAX_GUARDS,
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
  type RollbackTrack,
  type RollbackWorkspacePayload,
} from './rollback-point.ts'
import { projectKeyOf } from './session-select.ts'
import { atomicWriteFile } from '../utils/atomic-write.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { encodeZstdFrame } from '../utils/zstd-frame.ts'

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
  // issue #69 口径（与 tests/route/recovery-rollback.test.ts 同款）：os.tmpdir() 在 Windows / macOS 上
  // 可能给**未规范化**的拼写（Windows 的 8.3 短名 RUNNER~1 / macOS 的 /var → /private/var 软链），
  // 而引擎内部一律 realpath ⇒ 断言会变成比「同一个目录的两种写法」（CI 的 windows/macos 必红，本机不复现）。
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-point-')))
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

/** v3 记录文件（records/<id>.json）里工作区载荷只剩一个内容寻址哈希引用 */
interface StoredRecordFile {
  workspace: Omit<RollbackTrack<RollbackWorkspacePayload>, 'payload'> & { payload: string | null }
}

/**
 * v3 台账的**完整记录**读写助手（只给「记录被篡改」这类白盒用例用）。
 *
 * 为什么必须成对改写：v3 起完整记录在 records/<id>.json，工作区大数组在**内容寻址**的
 * payloads/<sha256>.json（清单 index.json 里只剩元数据）。篡改必须同时改载荷与记录里的哈希引用，
 * 否则读路径会先按「哈希不符」如实失败，就测不到下游那条判据了。
 */
async function readFullRecord(engine: RollbackPointEngine, id: string): Promise<RollbackPointRecord> {
  const file = path.join(engine.storeDir, 'records', id + '.json')
  const stored = JSON.parse(await readText(file)) as StoredRecordFile & Omit<RollbackPointRecord, 'workspace'>
  const hash = stored.workspace.payload
  const payload = hash === null
    ? null
    : JSON.parse(await readText(path.join(engine.storeDir, 'payloads', hash + '.json'))) as RollbackWorkspacePayload
  return { ...stored, workspace: { ...stored.workspace, payload } }
}

async function writeFullRecord(engine: RollbackPointEngine, record: RollbackPointRecord): Promise<void> {
  const file = path.join(engine.storeDir, 'records', record.id + '.json')
  const stored = JSON.parse(await readText(file)) as Record<string, unknown>
  const payload = record.workspace.payload
  let hash: string | null = null
  if (payload !== null) {
    const text = JSON.stringify(payload)
    hash = sha256Hex(text)
    await fs.writeFile(path.join(engine.storeDir, 'payloads', hash + '.json'), text)
  }
  const workspaceRaw = stored['workspace'] as Record<string, unknown>
  workspaceRaw['payload'] = hash
  await fs.writeFile(file, JSON.stringify(stored))
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
  assert.equal(list.maxGuards, ROLLBACK_MAX_GUARDS)
  // 库目录名 = rollback-points
  assert.equal(path.basename(engine.storeDir), ROLLBACK_POINTS_DIR_NAME)

  // 详情
  const detail = await engine.read(record.id)
  assert.equal(detail.point?.id, record.id)
  assert.equal((await engine.read('rb-nope')).point, undefined)
})

/* ============================== R-02b 排队发送的输入不得被切进子会话（用户 2026-10-11 反馈） */

test('R-02b 边界跳过「待消费输入」：上一回合结束后排队发的消息属于下一回合，边界落在它之前', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(3_000_000, 10) })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 's-queue',
    unitId: 'proj-key/s-queue',
    logPath: fx.logFile,
    chunks: [fx.workspaceDir],
  })

  // 回合 1：turn/start(0) … turn/end(5)
  await tracker.noteEvent({ sessionId: 's-queue', seq: 0, type: 'turn/start', data: { turn: 1 } })
  await tracker.noteEvent({ sessionId: 's-queue', seq: 5, type: 'turn/end', data: { turn: 1 } })
  // 回合 1 还在跑时用户排队发了一条：先落 user/message(append,6) + inbox 拼接(7)，**再**开回合 2
  assert.equal((await tracker.noteEvent({ sessionId: 's-queue', seq: 6, type: 'user/message', surfaceOp: 'append', data: {} })).captured, false)
  await tracker.noteEvent({ sessionId: 's-queue', seq: 7, type: 'agent/inbox/spliced', data: {} })
  await tracker.noteEvent({ sessionId: 's-queue', seq: 8, type: 'turn/start', data: { turn: 2 } })
  await tracker.noteEvent({ sessionId: 's-queue', seq: 12, type: 'turn/end', data: { turn: 2 } })

  const byTurn = new Map((await engine.list()).points.map((p) => [p.turn, p]))
  assert.equal(
    byTurn.get(2)?.boundarySeq,
    5,
    '边界必须是待消费输入的前一条（上一回合的 turn/end=5）；取 startSeq-1=7 会把排队那条消息切进子会话',
  )
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
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 0, type: 'turn/start', data: { turn: 1 } })).captured, true)
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 1, type: 'turn/end', data: { turn: 1 } })).captured, false)
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 2, type: 'turn/start', data: { turn: 2 } })).captured, true)
  // 回合中间的事件不触发留点
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 3, type: 'user/message', data: {} })).captured, false)
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 2 } })).captured, false, '回合结束不再拍点')
  // 幂等：同一回合的重复 turn/start 不再留点
  assert.equal((await tracker.noteEvent({ sessionId: 'session-1111', seq: 2, type: 'turn/start', data: { turn: 2 } })).captured, false)

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

/* ============================================ t9 fork 子会话的继承链与代际隔离 */

test('t9 活会话登记：header 的 parentSession / isSeeded 带进 binding（读不到就不带字段，绝不猜）', () => {
  const seeded = rollbackSessionBindingOf({ id: 'c1', header: { cwd: 'D:/ws', parentSession: 'p1', isSeeded: true } })
  assert.equal(seeded.ok, true)
  if (seeded.ok) {
    assert.equal(seeded.binding.parentSessionId, 'p1', '磁盘 header 名 parentSession')
    assert.equal(seeded.binding.forked, true)
  }
  const projected = rollbackSessionBindingOf({ id: 'c2', header: { cwd: 'D:/ws', parentSessionId: 'p2', seedLength: 12 } })
  if (projected.ok) {
    assert.equal(projected.binding.parentSessionId, 'p2', 'RPC 投影名 parentSessionId 也认')
    assert.equal(projected.binding.forked, true, 'seedLength 也是「播种而来」的证据')
  }
  const subagent = rollbackSessionBindingOf({ id: 'c3', header: { cwd: 'D:/ws', parentSession: 'p3', origin: 'subagent', isSeeded: false } })
  if (subagent.ok) {
    assert.equal(subagent.binding.parentSessionId, 'p3')
    assert.equal(subagent.binding.forked, undefined, '子代理会话不进继承链（它的回合号是自己的）')
  }
  const plain = rollbackSessionBindingOf({ id: 'c4', header: { cwd: 'D:/ws' } })
  if (plain.ok) {
    assert.equal(plain.binding.parentSessionId, undefined)
    assert.equal(plain.binding.forked, undefined)
  }
})

test('t9 祖先链：只上溯 + 环保护 + 深度上限（自指 / 环 / 超深链都不挂起、不误命中）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    engine.noteSessionBinding({ sessionId: 'a', parentSessionId: 'a', forked: true })
    assert.deepEqual(engine.ancestorIdsOf('a'), [], '自指不产生祖先')
    engine.noteSessionBinding({ sessionId: 'b', parentSessionId: 'c', forked: true })
    engine.noteSessionBinding({ sessionId: 'c', parentSessionId: 'b', forked: true })
    assert.deepEqual(engine.ancestorIdsOf('b'), ['c'], '环里走一步就停（不挂起、也不重复）')
    // 非 fork 关系（子代理 / 只是声明了父）不进链
    engine.noteSessionBinding({ sessionId: 'x', parentSessionId: 'y', forked: false })
    engine.noteSessionBinding({ sessionId: 'z', parentSessionId: 'y' })
    assert.deepEqual(engine.ancestorIdsOf('x'), [])
    assert.deepEqual(engine.ancestorIdsOf('z'), [])
    // 超深链：s0 → s1 → … → s20
    for (let i = 0; i < 20; i += 1) {
      engine.noteSessionBinding({ sessionId: 's' + String(i), parentSessionId: 's' + String(i + 1), forked: true })
    }
    const chain = engine.ancestorIdsOf('s0')
    assert.equal(chain.length, ROLLBACK_ANCESTOR_MAX_DEPTH, '深度上限内的祖先才算数')
    assert.equal(chain[0], 's1')
    assert.equal(chain.includes('s9'), false, '超过上限的祖先不得出现在链里（不误命中）')
  } finally {
    await fx.cleanup()
  }
})

test('t9 ancestorPointForTurn：祖先有**同回合**点才命中；没有就 null（不猜最近的一个）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    await capturePoint(engine, fx, {}) // session-1111 / turn 2
    engine.noteSessionBinding({ sessionId: 'child-2222', parentSessionId: 'session-1111', forked: true })
    const hit = await engine.ancestorPointForTurn('child-2222', 2)
    assert.equal(hit?.sessionId, 'session-1111')
    assert.equal(hit?.turn, 2)
    assert.equal(await engine.ancestorPointForTurn('child-2222', 7), null, '祖先没有这一回合的点 ⇒ null')
    assert.equal(await engine.ancestorPointForTurn('session-1111', 2), null, '自己的点不算祖先点')
  } finally {
    await fx.cleanup()
  }
})

test('t9 留点器代际隔离：继承回合不补点（无幽灵点），本会话自己的新回合必须留下自己的点', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const tracker = new RollbackAutoTracker({ engine })
    // 父会话 p1：回合 1、2 各留一个点
    tracker.registerSession({ sessionId: 'p1', chunks: [fx.workspaceDir], unitId: 'proj-key/p1' })
    await tracker.noteEvent({ sessionId: 'p1', seq: 0, type: 'turn/start', data: { turn: 1 } })
    await tracker.noteEvent({ sessionId: 'p1', seq: 3, type: 'turn/end', data: { turn: 1 } })
    await tracker.noteEvent({ sessionId: 'p1', seq: 4, type: 'turn/start', data: { turn: 2 } })
    await tracker.noteEvent({ sessionId: 'p1', seq: 8, type: 'turn/end', data: { turn: 2 } })

    // fork 子会话 c1：历史从 p1 播种而来，replay 的回合号与父逐字相同
    tracker.registerSession({ sessionId: 'c1', chunks: [fx.workspaceDir], unitId: 'proj-key/c1', parentSessionId: 'p1', forked: true })
    const replay1 = await tracker.noteEvent({ sessionId: 'c1', seq: 0, type: 'turn/start', data: { turn: 1 } })
    assert.equal(replay1.captured, false, '继承回合不得补点（补了就是把「现在」的工作区态贴到那一回合上 = 幽灵点）')
    assert.match(String(replay1.detail), /inherited-turn/)
    const replay2 = await tracker.noteEvent({ sessionId: 'c1', seq: 4, type: 'turn/start', data: { turn: 2 } })
    assert.equal(replay2.captured, false)
    assert.match(String(replay2.detail), /inherited-turn/)

    // c1 自己的新回合（父没有回合 3）⇒ 必须留下 c1 自己的点
    const own = await tracker.noteEvent({ sessionId: 'c1', seq: 9, type: 'turn/start', data: { turn: 3 } })
    assert.equal(own.captured, true, '子会话跑到的新回合必须留下本会话自己的点（不得被跨代际去重跳过）')

    const ledger = await ledgerOf(engine)
    const c1Own = ledger.records.filter((r) => r.sessionId === 'c1')
    assert.equal(c1Own.length, 1, '台账里 c1 只有自己的那一个点')
    assert.equal(c1Own[0]?.turnSeq, 3)
    assert.equal(ledger.records.some((r) => r.sessionId === 'c1' && (r.turnSeq === 1 || r.turnSeq === 2)), false, '继承回合绝不在台账里留幽灵点')
    assert.equal(ledger.records.filter((r) => r.sessionId === 'p1').length, 2, '父会话的点不受影响')
  } finally {
    await fx.cleanup()
  }
})

test('t9 继承链与继承视图：磁盘上的 fork 子会话被认出来（inheritLinks + 祖先点的继承视图，台账零写入）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const parent = await capturePoint(engine, fx, {}) // session-1111 / turn 2 / unitId proj-key/session-1111
    assert.equal(parent.ok, true)
    const parentPointId = parent.ok && parent.point !== undefined ? parent.point.id : ''
    // 磁盘上造 fork 子会话（header: parentSession + isSeeded）与子代理子会话（origin=subagent）
    const forkedDir = path.join(fx.sessionsDir, 'proj-key', 'child-2222')
    await fs.mkdir(forkedDir, { recursive: true })
    await fs.writeFile(path.join(forkedDir, 'session.jsonl.zstd'), encodeZstdFrame(Buffer.from(
      JSON.stringify({ type: 'session', version: 4, id: 'child-2222', cwd: fx.workspaceDir, parentSession: 'session-1111', isSeeded: true }) + '\n',
    )))
    const subagentDir = path.join(fx.sessionsDir, 'proj-key', 'sub-3333')
    await fs.mkdir(subagentDir, { recursive: true })
    await fs.writeFile(path.join(subagentDir, 'session.jsonl.zstd'), encodeZstdFrame(Buffer.from(
      JSON.stringify({ type: 'session', version: 4, id: 'sub-3333', cwd: fx.workspaceDir, parentSession: 'session-1111', origin: 'subagent', isSeeded: false }) + '\n',
    )))

    const list = await engine.list()
    assert.equal(list.inheritLinks?.['child-2222'], 'session-1111', 'fork 子会话必须进继承链')
    assert.equal(list.inheritLinks?.['sub-3333'], undefined, '子代理子会话不进继承链（回合号是它自己的）')
    assert.equal(list.inheritLinksComplete, true)

    const view = list.points.find((p) => p.sessionId === 'child-2222' && p.turn === 2)
    assert.ok(view !== undefined, 'fork 子会话必须拿到祖先同回合点的继承视图')
    assert.equal(view.id, parentPointId, '继承视图与祖先点同 id ⇒ preview/rewind/remove 作用在原点')
    assert.equal(view.inheritedFrom, parentPointId)
    assert.equal(view.inheritedSessionId, 'session-1111')
    assert.equal(view.unitId, 'proj-key/child-2222', '视图归到子会话的单元（同项目键）')
    assert.equal(list.inheritedViewTruncated, undefined, '未超上限就不标记')

    const ledger = await ledgerOf(engine)
    assert.equal(ledger.records.some((r) => r.sessionId === 'child-2222'), false, '继承视图绝不写进台账（零幽灵点）')
  } finally {
    await fx.cleanup()
  }
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

test('R-05c 留点在回合开始前：这一回合里被改过的文件，回退后必须回到「改之前」的内容', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(4_000_000, 10) })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 's-pre',
    unitId: 'proj-key/s-pre',
    logPath: fx.logFile,
    chunks: [fx.workspaceDir],
  })

  // 回合开始 → 留点（此刻的工作区）；随后 agent 在这一回合**改文件 + 加文件**
  await tracker.noteEvent({ sessionId: 's-pre', seq: 0, type: 'turn/start', data: { turn: 1 } })
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A-CHANGED-IN-TURN')
  await fs.writeFile(path.join(fx.workspaceDir, 'in-turn.txt'), 'NEW-IN-TURN')
  await tracker.noteEvent({ sessionId: 's-pre', seq: 9, type: 'turn/end', data: { turn: 1 } })

  const point = (await engine.list()).points.find((p) => p.turn === 1)
  assert.notEqual(point?.id, undefined, '回合开始就该有点（旧口径在回合结束才拍 ⇒ 回退时文件已经是「改之后」的样子）')
  const rewound = await engine.rewind({ id: point?.id ?? '', userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  // 首回合没有前置边界 ⇒ 会话段结构化 no-boundary（既有口径），所以只看工作区段
  const wsSegment = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(wsSegment?.status, 'restored', JSON.stringify(rewound.segments))
  assert.equal(
    await readText(path.join(fx.workspaceDir, 'a.txt')),
    'A1',
    '回合内被改过的文件必须退回「这条消息之前」的内容（这正是「工作区与该回退点一致」那个 bug）',
  )
  await assert.rejects(fs.readFile(path.join(fx.workspaceDir, 'in-turn.txt')), { code: 'ENOENT' })
})

/**
 * R-05d（用户 2026-10-12 实测的「跳过中间若干回合」）：同一对话 **6 个回合**，中间 3 个回合各新建
 * 文件，从最后一个回合**直接**退回第 2 个回合。
 *
 * 为什么相邻回退暴露不出来、非相邻才暴露 —— 判据是**这一行**：
 * 删除候选 = 「该点未记录」的路径，它随**跳过的回合数**线性增长；只要候选数越过逐条清单上限
 * （`ROLLBACK_LEFTOVER_LIST_LIMIT` = 20）或前 20 条里混进**拒删项**，旧实现的两个删除口径就分叉：
 * 预览列的是「未记录」的前 20 条（含**永不删除**的 `.git` 路径、且漏掉第 21 条之后**真的会删**的路径），
 * 执行删的是「全量 + 过安全判据」的那一份。相邻只退一轮 ⇒ 候选只有这一回合新建的几条，
 * 上限与拒删项都还挤得下 ⇒ 两个集合碰巧相等。
 *
 * 实测（修复前，同一场景）：预览列 20 条 = 3 条 `.git/*`（永不删除）+ 17 条会删；实际删 25 条
 * ⇒ 8 条「会删的」根本没被列出，用户看到的就是「预览只列几个，实际删一大堆」。
 *
 * 现状（2026-10-12 同日收敛后）：删除集只有一份规划（`planCreatedRemovals`），且清单**全量**
 * （不再切 20 条；超 `ROLLBACK_MAX_CREATED_REMOVALS` 时执行端整套拒绝 ⇒ 预览如实给空集）。
 * 界面直接把这份清单渲染成「删除」行，**不需要**任何「清单可能不完整」的说明句
 * （用户同日要求弹窗只要清单；文案克制 → DESIGN.md §7）。
 */
test('R-05d 非相邻回退：预览的「会被删除路径集合」必须与实际删除集合逐条一致（拒删项如实）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 's-6', unitId: 'proj-key/s-6', logPath: fx.logFile, chunks: [fx.workspaceDir],
  })
  const event = async (seq: number, type: string, turn: number): Promise<void> => {
    await tracker.noteEvent({ sessionId: 's-6', seq, type, data: { turn } })
  }

  // 回合 1：改 a.txt（工作区基线）
  await event(0, 'turn/start', 1)
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A-turn1')
  await event(1, 'turn/end', 1)

  // 回合 2：**回退目标**（它的工作区态 = 这一回合开始之前）
  await event(2, 'turn/start', 2)
  await event(3, 'turn/end', 2)

  // 中间 3 个回合（3/4/5）：每回合新建 8 个文件 + 在 .git 里塞一条（拒删项）
  const created: string[] = []
  for (const turn of [3, 4, 5]) {
    await event(turn * 2, 'turn/start', turn)
    for (let i = 0; i < 8; i += 1) {
      const file = path.join(fx.workspaceDir, 'mid-turn' + String(turn) + '-' + String(i) + '.txt')
      await fs.writeFile(file, 'T' + String(turn) + '-' + String(i))
      created.push(file)
    }
    await fs.mkdir(path.join(fx.workspaceDir, '.git'), { recursive: true })
    await fs.writeFile(path.join(fx.workspaceDir, '.git', 'mid' + String(turn)), 'GIT')
    await event(turn * 2 + 1, 'turn/end', turn)
  }
  // 回合 6：最后一个回合再新建一条，并**改掉**目标点记录在案的 a.txt（强制真写回 + 复核）
  await event(12, 'turn/start', 6)
  await fs.writeFile(path.join(fx.workspaceDir, 'mid-turn6.txt'), 'T6')
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A-later')
  created.push(path.join(fx.workspaceDir, 'mid-turn6.txt'))
  await event(13, 'turn/end', 6)

  const target = (await engine.list()).points.find((p) => p.turn === 2)
  assert.notEqual(target?.id, undefined, '第 2 回合必须有点（留点在 turn/start）')
  const id = target?.id ?? ''

  const preview = await engine.preview(id)
  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'restored', JSON.stringify(rewound.segments))

  // ① 中间回合新建的路径**全部**被删（25 条），拒删的 .git 路径如实进 createdSkipped
  assert.equal(created.length, 25)
  for (const file of created) {
    await assert.rejects(fs.readFile(file), { code: 'ENOENT' }, '中间回合新建的路径必须被删：' + file)
  }
  assert.equal(ws?.removed, 25, 'removed 必须等于真实删除数（detail=' + JSON.stringify(ws?.detail) + '）')
  const refused = ws?.createdSkipped ?? []
  // 2026-10-14 起 `.git` 在**捕获与回退两侧**都不进走查 ⇒ 它连候选都不是，不再是「候选后被拒删」。
  // 断言的是更强的事实：.git 子树**一个字节都没被动过**（拒删判据仍在，只是更早的一道门就挡住了）。
  assert.equal(refused.length, 0, '.git 子树不进候选（比「候选后拒删」更早一道门）')
  for (const turn of [3, 4, 5]) {
    assert.equal(await readText(path.join(fx.workspaceDir, '.git', 'mid' + String(turn))), 'GIT', '.git 内的文件绝不能被删')
  }
  assert.equal(ws?.createdSkippedCount, 0)
  assert.equal(ws?.createdRefusedReason, undefined, '捕获完整 ⇒ 不是「捕获不完整」拒删')

  // ② 目标点记录在案的路径写回并通过 SHA-256 复核
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A-turn1', 'a.txt 必须回到第 2 回合开始前的内容')
  assert.ok((ws?.detail ?? []).some((line) => line.includes('restored=1') && line.includes('verified=1')), 'detail 必须带 restored/verified：' + JSON.stringify(ws?.detail))

  // ③ **核心断言**：预览的「会被删除路径集合」与实际删除集合逐条一致（旧实现此处必红）
  const previewWs = preview.workspace
  assert.deepEqual(previewWs.removals, ws?.removedPaths, '预览说会删的 = 实际删的（逐条、同序）')
  assert.equal(previewWs.removalsCount, ws?.removed, '预览的删除总数 = 实际删除数')
  assert.equal(previewWs.removals.some((file) => file.split(path.sep).includes('.git')), false, '预览的删除清单里绝不能混进永不删除的 .git 路径')
  assert.equal(previewWs.createdSkippedCount, 0, '预览与执行同口径：.git 不进候选（所以没有拒删项）')

  // ④ 清单**全量**（不再切 20 条）：界面直接把这份清单渲染成「删除」行，不需要任何说明句
  assert.equal(previewWs.removals.length, 25, '25 条会删的必须**全部**列出来（旧实现只列前 20 条，用户看到的正是「预览只列几个」）')
  assert.equal(previewWs.removalsTruncated, false, '清单完整 ⇒ 不完整标记必须为 false')
  // 「相邻不暴露、非相邻才暴露」的那一行判据：候选数越过**旧的**逐条清单上限（20）时旧实现的两个口径才分叉
  assert.ok(
    previewWs.createdAfter > ROLLBACK_LEFTOVER_LIST_LIMIT,
    '非相邻才暴露的判据：候选数越过旧清单上限（' + String(previewWs.createdAfter) + ' > ' + String(ROLLBACK_LEFTOVER_LIST_LIMIT) + '）',
  )
})

test('R-05b 开 removeCreated：回退点之后新建的路径被真的删掉；.git 内的拒删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')

  // 点之后：改内容 + 新建一个可删的 + 在 .git 里塞一个（仓库元数据绝不能被「新建」判据删掉）
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  await fs.mkdir(path.join(fx.workspaceDir, '.git'), { recursive: true })
  await fs.writeFile(path.join(fx.workspaceDir, '.git', 'index'), 'GIT-INDEX')
  await fs.writeFile(path.join(fx.workspaceDir, 'new.txt'), 'NEW')

  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
  await assert.rejects(
    fs.readFile(path.join(fx.workspaceDir, 'new.txt')),
    { code: 'ENOENT' },
    '开了 removeCreated 就必须真的删掉「该点未记录」的新建路径',
  )
  assert.equal(await readText(path.join(fx.workspaceDir, '.git', 'index')), 'GIT-INDEX', '.git 内一律拒删')
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.removed, 1)
  assert.deepEqual(ws?.removedPaths, [path.join(fx.workspaceDir, 'new.txt')])
  assert.ok((ws?.detail ?? []).some((line) => line.includes('removed=1')), 'detail 必须带 removed=1')
})

/**
 * R-05e（用户 2026-10-12 真机第二例：工作区文件数超 `maxFiles` 时，**中间回合新建的文件一条都删不掉**）。
 *
 * 判据是**这一行**：删除候选的「证明」曾经只有 `payload.files` 一份，而捕获侧的跳过清单有**记录上限**
 * （`maxSkippedEntries`，缺省 5000）。工作区文件数 > maxFiles 时每个点都 `truncated=true`；一旦超出
 * 的条目多到名单被截断（`skippedTruncated=true`），旧判据（`payload.truncated || unreadableFiles`）
 * 整体放弃删除 ⇒ 用户点某条更早消息的「↺ 回退」时，**中间回合新建的文件全部留在工作区**。
 * 本仓库实测：工作区 88 138 个文件（`.tmp/` + `outputs/` + `.git`）⇒ 每个自动点都被截断。
 *
 * 修法（方向 A+B）：捕获侧把**走过**的全部路径写进**路径索引对象**（gzip、内容寻址）⇒
 * 「留点时刻存在哪些路径」永远可证；删除候选 = 当前存在、在 chunks 内、且**不在**
 * files ∪ skipped ∪ unreadableFiles ∪ excludedDirs ∪ 路径索引 任何一份名单里。
 * 索引缺失 / 读不出（老台账 / 对象丢失）⇒ 仍 fail-closed 一条都不删并如实报告（见 R-05f）。
 */
test('R-05e 预算截断的点：中间回合新建的路径必须被删；被预算挡下的既有文件一条都不删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 9 个既有文件 + maxFiles=4 + maxSkippedEntries=2 ⇒ 跳过名单被截断（这正是本用例的输入）
  const names = Array.from({ length: 9 }, (_, i) => 'old-' + String(i + 1) + '.txt')
  const dir = await makeSizeDir(fx, 'cap-index', Object.fromEntries(names.map((n) => [n, 3])))
  const engine = makeEngine(fx, { maxFiles: 4, maxSkippedEntries: 2 })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 's-e', unitId: 'proj-key/s-e', logPath: fx.logFile, chunks: [dir],
  })

  // 回合 1：留点（工作区 = 这 9 个既有文件）
  await tracker.noteEvent({ sessionId: 's-e', seq: 0, type: 'turn/start', data: { turn: 1 } })
  const point = (await engine.list()).points.find((p) => p.turn === 1)
  assert.notEqual(point?.id, undefined, '回合开始就该有点')
  // list() 给的是摘要（没有 payload）—— 证明名单只能从详情里读
  const payload = (await engine.read(point?.id ?? '')).point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.skippedTruncated, true, '前提：跳过名单被记录上限截断')
  const recorded = new Set(payload.files.map((f) => f.path))
  const listedSkip = new Set(payload.skipped.map((s) => s.path))
  const oldFiles = names.map((n) => path.join(dir, n))
  // 前提：存在「既没被记录、也没进逐条跳过名单」的既有文件 —— 旧判据只能全盘放弃删除
  const unprovable = oldFiles.filter((f) => !recorded.has(f) && !listedSkip.has(f))
  assert.ok(unprovable.length > 0, '前提：存在无法逐条证明的既有文件')

  // 回合 2 / 3（中间回合）：新建 a、b，并改掉一个在预算外的既有文件 C
  const createdA = path.join(dir, 'created-a.txt')
  const createdB = path.join(dir, 'created-b.txt')
  const modified = unprovable[0] ?? ''
  await fs.writeFile(createdA, 'A')
  await fs.writeFile(createdB, 'B')
  await fs.writeFile(modified, 'CHANGED-IN-LATER-TURN')
  await tracker.noteEvent({ sessionId: 's-e', seq: 4, type: 'turn/end', data: { turn: 3 } })

  // 从最后回合**直接**退回第 1 回合那个点
  const rewound = await engine.rewind({
    id: point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'restored', JSON.stringify(rewound.segments))

  // ① **本次要修的**：中间回合新建的路径必须被删（修复前这里恒为 0 —— truncated ⇒ 一条都不删）
  await assert.rejects(fs.readFile(createdA), { code: 'ENOENT' }, '中间回合新建的 a 必须被删')
  await assert.rejects(fs.readFile(createdB), { code: 'ENOENT' }, '中间回合新建的 b 必须被删')
  assert.equal(ws?.removed, 2, 'removed 必须等于真实删除数（detail=' + JSON.stringify(ws?.detail) + '）')
  assert.deepEqual([...(ws?.removedPaths ?? [])].sort(), [createdA, createdB].sort())
  // 删了 2 个文件就不是「0 变更」—— 顶层不许再说 nothing-to-restore（假尾句）
  assert.equal(rewound.code, 'ok', JSON.stringify({ outcome: rewound.outcome, code: rewound.code, segments: rewound.segments }))

  // ② 护栏（上一轮口径，不得回归）：**留点时就存在**的文件一条都不许删 —— 含被预算挡下、既没进
  //    files 也没进 skipped 的那一个；没被记录的既有文件既不能删、也不能凭空还原内容
  for (const file of oldFiles) await fs.access(file)
  assert.equal(await readText(modified), 'CHANGED-IN-LATER-TURN', '没被记录的既有文件既不能删、也不能凭空还原')

  // ③ 报告如实：这次不是「无法证明」拒删，detail 带真实删除数
  assert.equal(ws?.createdRefusedReason, undefined, JSON.stringify(ws))
  assert.ok((ws?.detail ?? []).some((line) => line.includes('removed=2')), JSON.stringify(ws?.detail))
  assert.equal(ws?.createdSkippedCount, 0, '9 个既有文件都进了证明名单 ⇒ 不该出现在拒删里')
})

/**
 * R-05f（同一判据的另一侧）：**证明名单不完整时一条都不删，并如实回传原因**。
 * 索引对象丢失（老台账 / 对象仓损坏）等价于「无法证明」⇒ 绝不按「未记录」猜「新建」。
 */
test('R-05f 路径索引读不出（老台账 / 对象丢失）⇒ 仍 fail-closed：一条都不删 + 如实报告原因', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const names = Array.from({ length: 9 }, (_, i) => 'old-' + String(i + 1) + '.txt')
  const dir = await makeSizeDir(fx, 'cap-index-missing', Object.fromEntries(names.map((n) => [n, 3])))
  const engine = makeEngine(fx, { maxFiles: 4, maxSkippedEntries: 2 })
  const tracker = new RollbackAutoTracker({ engine })
  tracker.registerSession({
    sessionId: 's-f', unitId: 'proj-key/s-f', logPath: fx.logFile, chunks: [dir],
  })
  await tracker.noteEvent({ sessionId: 's-f', seq: 0, type: 'turn/start', data: { turn: 1 } })
  const point = (await engine.list()).points.find((p) => p.turn === 1)
  const indexObject = (await engine.read(point?.id ?? '')).point?.workspace.payload?.pathIndex?.object ?? ''
  assert.notEqual(indexObject, '', '前提：被截断的点必须带路径索引对象')
  // 把索引对象从对象仓里拿走 —— 等价于老台账（没有这个字段）或对象仓丢了这一份
  await fs.rm(path.join(engine.storeDir, 'objects', indexObject), { force: true })

  const created = path.join(dir, 'created.txt')
  await fs.writeFile(created, 'NEW')
  const rewound = await engine.rewind({
    id: point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.status, 'restored', JSON.stringify(rewound.segments))
  // 0 变更的段走 noop 口径（removed 缺省不给数字）—— 两种都算「一条都没删」
  assert.equal(ws?.removed ?? 0, 0, '证明不了就一条都不删（绝不按「未记录」猜「新建」）')
  assert.equal(await readText(created), 'NEW')
  assert.equal(ws?.createdRefusedReason, 'capture-incomplete', '拒删原因必须如实回传')
  assert.ok((ws?.createdSkippedCount ?? 0) > 0, '候选必须如实进拒删清单')
  for (const file of names.map((n) => path.join(dir, n))) await fs.access(file)
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

  const outside = path.join(fx.root, 'outside.txt')
  await fs.writeFile(outside, 'SAFE')
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  // 篡改 1：把记录里的路径改成分块之外的文件（同时改载荷与其哈希引用，见 writeFullRecord）
  const tampered = await readFullRecord(engine, record.id)
  const hit = (tampered.workspace.payload?.files ?? []).find((f) => f.path.endsWith('a.txt'))
  assert.ok(hit !== undefined)
  hit.path = outside
  await writeFullRecord(engine, tampered)
  const rewound1 = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound1.outcome, 'failed')
  assert.ok((rewound1.segments[0]?.detail ?? []).some((line) => line.startsWith('invalid-path')))
  assert.equal(await readText(outside), 'SAFE', '越界路径绝不被写')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2', '一条不合格 → 零写入')

  // 篡改 2：路径合法但声明的内容指纹不符
  // 注：载荷**不再存** `object`（object ≡ sha256，落盘时省掉、读取时按 sha256 补回）⇒ 改 sha256
  // 等于同时改掉对象名 ⇒ 那个对象根本不存在 ⇒ 如实报 `object-missing`（仍是 fail-closed、零写入）。
  const tampered2 = await readFullRecord(engine, record.id)
  const hit2 = (tampered2.workspace.payload?.files ?? []).find((f) => f.sha256 === sha256Hex('A1'))
  assert.ok(hit2 !== undefined)
  hit2.path = path.join(fx.workspaceDir, 'a.txt')   // 路径合法（分块内），只有指纹不符
  hit2.sha256 = sha256Hex('NOT-THE-CAPTURED-CONTENT')
  await writeFullRecord(engine, tampered2)
  const rewound2 = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound2.outcome, 'failed')
  assert.ok((rewound2.segments[0]?.detail ?? []).some((line) => line.includes('object-missing')),
    '改 sha256 ⇒ 对象名随之改 ⇒ 读不到：' + JSON.stringify(rewound2.segments[0]?.detail))
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  // 篡改 2b：指纹合法、但把**对象键**指向另一份真实存在的内容 ⇒ 该走 object-hash-mismatch
  const tampered3 = await readFullRecord(engine, record.id)
  const files3 = tampered3.workspace.payload?.files ?? []
  const aTxt = path.join(fx.workspaceDir, 'a.txt')
  const hit3 = files3.find((f) => f.path === aTxt)
  assert.ok(hit3 !== undefined)
  hit3.sha256 = sha256Hex('A1')   // 指纹还原成**真的**（上一轮篡改改过它）
  const otherObject = files3.find((f) => f.path !== aTxt && f.sha256 !== hit3.sha256)?.sha256
  assert.ok(otherObject !== undefined)
  hit3.object = otherObject   // 对象存在、但它的内容哈希 ≠ 记录里的 sha256
  await writeFullRecord(engine, tampered3)
  const rewound3 = await engine.rewind({ id: record.id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound3.outcome, 'failed')
  assert.ok((rewound3.segments[0]?.detail ?? []).some((line) => line.includes('object-hash-mismatch')),
    '对象键被换 ⇒ 内容哈希对不上：' + JSON.stringify(rewound3.segments[0]?.detail))
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

  // 归位成功：只有「已 fork」一条指引，没有额外噪音（真机 2026-10-11/12）
  const placedSegment = rewound.segments.find((s) => s.state === 'session')
  assert.deepEqual((placedSegment?.guidance ?? []).map((g) => g.code), ['rollback.guidance.sessionForked'])
  assert.ok((placedSegment?.detail ?? []).some((line) => line.includes('workspaceAttached=true')))

  // fork 成功但**没能挂回工作区** → 回退仍算成功，但多一条指引如实说明（绝不静默）
  const unplaced = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-9', warning: 'workspace-attach-failed' }) })
  const unplacedResult = await unplaced.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'session' })
  const unplacedSegment = unplacedResult.segments.find((s) => s.state === 'session')
  assert.equal(unplacedSegment?.status, 'restored', '归位失败不影响回退本身的成功判定')
  assert.deepEqual(
    (unplacedSegment?.guidance ?? []).map((g) => g.code),
    ['rollback.guidance.sessionForked', 'rollback.guidance.sessionNotAttached'],
  )
  assert.ok((unplacedSegment?.detail ?? []).some((line) => line.includes('workspaceAttached=false')))
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
  // 链接是**设计内**跳过（不跟随、也不该回退它）⇒ 逐条留痕但不算「留得不完整」（R-50 口径）：
  // 否则任何含符号链接的仓库每个点都挂「回退可能不完整」，真出问题时被噪声淹没
  assert.equal(track?.degraded, false)
  assert.equal(track?.reasonCode, null)
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
  const captured = await tracker.noteEvent({ sessionId: 'session-1111', seq: 2, type: 'turn/start', data: { turn: 2 } })
  await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 2 } })
  assert.equal(captured.captured, true)
  const point = (await engine.list()).points[0]
  assert.equal(point?.incomplete, true, '会话态-only 的点必须显式 incomplete，不许静默降级')
  const wsSegment = point?.segments.find((s) => s.state === 'workspace')
  assert.equal(wsSegment?.reasonCode, 'no-chunks')
  assert.equal(wsSegment?.ok, false)
  assert.equal(point?.sessionId, 'session-1111')
})

/* ============================ R-24 guard 留存例外（t14-F3：不许无界增长） */

test('R-24 guard 留存：不被自动点的 20/50 淘汰，但受自身两道上限约束（每会话 20 → 全局 50，超出淘汰最旧 guard）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  assert.equal(ROLLBACK_MAX_GUARDS_PER_SESSION, 20)
  assert.equal(ROLLBACK_MAX_GUARDS, 50, '引擎全局救援点上限应为 50')

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

  // ③ 全局上限（缺省 50，跨会话合计）：独立 dataDir（不与上面共享台账）；3 会话 × 22 个
  //    → 每会话只留最近 20（共 60）→ 全局再留最近 50 ⇒ 淘汰最旧的 10 个
  const fxG = await makeFixture()
  t.after(fxG.cleanup)
  const global = makeEngine(fxG, { now: steppingClock(11_000_000, 10) })
  assert.equal((await global.list()).maxGuards, ROLLBACK_MAX_GUARDS, 'list 必须回传全局 guard 上限')
  const s0: string[] = []
  const s1: string[] = []
  const s2: string[] = []
  for (let s = 0; s < 3; s += 1) {
    const bucket = s === 0 ? s0 : s === 1 ? s1 : s2
    for (let i = 0; i < 22; i += 1) {
      const g = await global.capturePoint({ kind: 'guard', sessionId: 's-global-' + String(s), sessionLogPath: fxG.logFile, chunks: [fxG.workspaceDir], boundarySeq: 1, turnSeq: i })
      bucket.push(g.point?.id ?? '')
    }
  }
  const globalKept = (await ledgerOf(global)).records.map((r) => r.id)
  const keptS0 = s0.filter((id) => globalKept.includes(id))
  const keptS1 = s1.filter((id) => globalKept.includes(id))
  const keptS2 = s2.filter((id) => globalKept.includes(id))
  assert.equal(keptS0.length + keptS1.length + keptS2.length, 50, '全局 guard 上限 = 50（跨会话合计，不许无界增长）')
  assert.equal(keptS1.length, 20, '各会话自己的 20 上限不变')
  assert.equal(keptS2.length, 20, '各会话自己的 20 上限不变')
  assert.equal(keptS0.length, 10, '全局超限时继续淘汰最旧的 guard（本轮全落在最早的会话）')
  for (let i = 0; i < 12; i += 1) assert.equal(globalKept.includes(s0[i] ?? ''), false, '最旧的 guard 被淘汰（含每会话 20 已挡下的那批）')
  assert.equal(globalKept.includes(s0[12] ?? ''), true, '跨过全局线的最新 guard 保留')
  assert.equal(globalKept.includes(s2[21] ?? ''), true, '最新会话的最新 guard 保留')

  // ④ 全局上限可注入（独立台账，不牵连上面用例的 guard）：maxGuards=3 → 4 个 guard 只留最新 3 个
  const fxT = await makeFixture()
  t.after(fxT.cleanup)
  const tight = makeEngine(fxT, { maxGuards: 3, now: steppingClock(12_000_000, 10) })
  const tightAuto = await capturePoint(tight, fxT, { sessionId: 's-tight' })
  const tightIds: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const g = await tight.capturePoint({ kind: 'guard', sessionId: 's-tight', sessionLogPath: fxT.logFile, chunks: [fxT.workspaceDir], boundarySeq: 1, turnSeq: i })
    tightIds.push(g.point?.id ?? '')
  }
  const tightLedger = await ledgerOf(tight)
  const tightGuards = tightLedger.records.filter((r) => r.kind === 'guard')
  assert.equal(tightGuards.length, 3, '全局 guard 上限 = 注入的 3')
  assert.deepEqual(tightGuards.map((r) => r.id).sort(), [tightIds[1], tightIds[2], tightIds[3]].sort(), '只留最新的 3 个 guard')
  assert.equal(tightLedger.records.some((r) => r.id === (tightAuto.point?.id ?? '')), true, '自动点不被 guard 的淘汰牵连')

  // ⑤ 用户仍然删不掉 guard（自动淘汰 ≠ 用户删除）
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

/**
 * T10 台账写失败的注入（跨平台）—— 返回「还原」回调；返回 `null` 表示本机造不出来，调用方 skip。
 *
 * 为什么不能只 `chmod(index.json, 0o444)`（2026-10-13 CI ubuntu 首跑实测 R-30/R-32/R8-8 三红）：台账走
 * **原子写**（同目录 tmp → rename，见 `utils/atomic-write.ts`），而 POSIX 上 rename 覆盖只读文件是
 * **允许**的（只要目录可写）⇒「文件只读」在 Linux 挡不住写，断言实际测的是「台账写成功了」；
 * Windows 的只读属性会挡住 rename，所以本机（Windows）一直绿。也不能改成把目录设只读：
 * `capturePoint` 的第一道门是存储探针（写 `<root>/.dshcm-probe-*`），目录只读会先变成
 * `storage-unavailable`，那测的就不是台账写失败了。
 *
 * 现在：把台账**指向只读目录里的真实文件**（index.json 换成 symlink）。原子写按 `follow` 策略
 * realpath 到真实文件、tmp 落进只读目录 ⇒ 写必然失败；读路径（readFile 跟随 symlink）不受影响。
 * 探测 = 用**生产写入器**按台账同形态真写一次（内容就是原内容）：写得进去就还原并返回 `null`
 * （调用方 skip），绝不伪造结论。
 */
async function blockLedgerWrite(file: string): Promise<(() => Promise<void>) | null> {
  const dir = path.dirname(file)
  const readOnlyDir = path.join(dir, 'ledger-readonly')
  const readOnlyFile = path.join(readOnlyDir, 'index.json')
  let original: string
  try {
    original = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  const restore = async (): Promise<void> => {
    await fs.chmod(readOnlyDir, 0o755).catch(() => {})
    await fs.chmod(readOnlyFile, 0o666).catch(() => {})
    await fs.rm(file, { force: true }).catch(() => {})
    await fs.writeFile(file, original).catch(() => {})
    await fs.rm(readOnlyDir, { recursive: true, force: true }).catch(() => {})
  }
  try {
    await fs.mkdir(readOnlyDir, { recursive: true })
    await fs.writeFile(readOnlyFile, original)
    await fs.rm(file, { force: true })
    await fs.symlink(readOnlyFile, file, 'file')
    await fs.chmod(readOnlyFile, 0o444)
    await fs.chmod(readOnlyDir, 0o555)
  } catch {
    await restore()
    return null
  }
  try {
    await atomicWriteFile(file, original)
    await restore()
    return null
  } catch {
    return restore
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
  const unblock = await blockLedgerWrite(ledgerPath)
  if (unblock === null) {
    t.skip('本机无法构造台账写失败（symlink 不可用，或只读目录挡不住原子写的 rename）')
    return
  }
  try {
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
    await unblock()
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
  const first = await tracker.noteEvent({ sessionId: 'session-1111', seq: 5, type: 'turn/start', data: { turn: 1 } })
  await tracker.noteEvent({ sessionId: 'session-1111', seq: 6, type: 'turn/end', data: { turn: 1 } })
  assert.equal(first.captured, true, first.detail ?? '')
  assert.equal(typeof first.pointId, 'string')

  const ledgerPath = path.join(engine.storeDir, 'index.json')
  const unblock = await blockLedgerWrite(ledgerPath)
  if (unblock === null) {
    t.skip('本机无法构造台账写失败（symlink 不可用，或只读目录挡不住原子写的 rename）')
    return
  }
  try {
    const second = await tracker.noteEvent({ sessionId: 'session-1111', seq: 11, type: 'turn/start', data: { turn: 2 } })
    assert.equal(second.captured, false, JSON.stringify(second))
    assert.equal(second.pointId, undefined, '写失败不得报 pointId')
    assert.equal(second.code, 'ledger-write-failed')
    assert.equal((await ledgerOf(engine)).records.length, 1, '台账里绝不能出现第二个点')
  } finally {
    await unblock()
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
  // v3：完整记录在 records/<id>.json + 内容寻址载荷；篡改必须成对改写（见 writeFullRecord）
  const tampered = await readFullRecord(engine, id)
  assert.ok(tampered.workspace.payload !== null)
  const victim = tampered.workspace.payload.files.find((f) => f.path.endsWith('a.txt'))
  assert.ok(victim !== undefined)
  victim.path = path.join(fx.workspaceDir, 'a' + String.fromCharCode(0) + '.txt')
  await writeFullRecord(engine, tampered)

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

/* ============ t2：路径身份缓存 / 忽略规则 / 容量上限（回退引擎性能与安全） ============ */

/**
 * 注入「工作区内容读取」计数器：每次真读都记一条，并（可选）记录并发驻留量。
 * 只在真读那一刻记录 —— 缓存命中时本函数根本不会被调用，这正是「零重读」的判据。
 */
function countingReader(): {
  seam: (file: string) => Promise<Uint8Array>
  reads: string[]
  reset: () => void
  peakLive: number
  peakSingle: number
} {
  const reads: string[] = []
  const state = { live: 0, peakLive: 0, peakSingle: 0 }
  return {
    reads,
    get peakLive() { return state.peakLive },
    get peakSingle() { return state.peakSingle },
    reset() { reads.length = 0; state.peakLive = 0; state.peakSingle = 0 },
    seam: async (file: string) => {
      const bytes = await fs.readFile(file)
      reads.push(file)
      state.live += bytes.byteLength
      state.peakLive = Math.max(state.peakLive, state.live)
      state.peakSingle = Math.max(state.peakSingle, bytes.byteLength)
      state.live -= bytes.byteLength
      return bytes
    },
  }
}

async function cacheFileOf(engine: RollbackPointEngine): Promise<{ version: number; entries: Record<string, { path: string; sha256: string; bytes: number }> }> {
  return JSON.parse(await readText(path.join(engine.storeDir, 'path-cache.json'))) as { version: number; entries: Record<string, { path: string; sha256: string; bytes: number }> }
}

test('T2-A 路径身份缓存：身份未变 ⇒ 第二次留点零重读；只改一个文件 ⇒ 只有该文件重读', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const reader = countingReader()

  // ① 首次留点：两个文件都必须真读（还没有任何缓存）
  const engine1 = makeEngine(fx, { readFile: reader.seam })
  const first = await capturePoint(engine1, fx)
  assert.equal(first.ok, true, first.detail ?? first.code)
  assert.deepEqual(
    [...reader.reads].sort(),
    [path.join(fx.workspaceDir, 'a.txt'), path.join(fx.workspaceDir, 'src', 'b.txt')].sort(),
    '首次留点必须真读两个文件（缓存为空）',
  )
  const firstFiles = first.point?.workspace.payload?.files ?? []
  assert.equal(firstFiles.length, 2)

  // 缓存必须落盘（只读不写的缓存等于没有）
  const cache1 = await cacheFileOf(engine1)
  assert.equal(cache1.version, 1)
  assert.equal(Object.keys(cache1.entries).length, 2, '两条身份都要进缓存')
  for (const entry of Object.values(cache1.entries)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.ok(entry.bytes > 0)
    assert.ok(entry.path.startsWith(fx.workspaceDir))
  }

  // ② 换一个**新引擎实例**（只能从盘上读缓存）再留一次点：身份未变 ⇒ 0 次读
  const engine2 = makeEngine(fx, { readFile: reader.seam })
  reader.reset()
  const second = await capturePoint(engine2, fx, { sessionId: 's-cache-2' })
  assert.equal(second.ok, true, second.detail ?? second.code)
  assert.equal(reader.reads.length, 0, '身份未变的文件必须零重读（缓存命中）：' + JSON.stringify(reader.reads))
  // 复用的 sha256 / 字节数与首次逐条一致（不是重算出来的，是缓存里的）
  const secondFiles = second.point?.workspace.payload?.files ?? []
  assert.deepEqual(
    secondFiles.map((f) => [f.path, f.bytes, f.sha256]).sort(),
    firstFiles.map((f) => [f.path, f.bytes, f.sha256]).sort(),
    '缓存命中的条目必须与首次逐条一致（复用 sha256，不重算）',
  )

  // ③ 只改一个文件 ⇒ 只有它重读（另一个仍然命中）
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2-CHANGED')
  const engine3 = makeEngine(fx, { readFile: reader.seam })
  reader.reset()
  const third = await capturePoint(engine3, fx, { sessionId: 's-cache-3' })
  assert.equal(third.ok, true, third.detail ?? third.code)
  assert.deepEqual(reader.reads, [path.join(fx.workspaceDir, 'a.txt')], '只有被改的那个文件重读')
  const aFile = (third.point?.workspace.payload?.files ?? []).find((f) => f.path.endsWith('a.txt'))
  assert.equal(aFile?.sha256, sha256Hex('A2-CHANGED'), '重读后 sha256 必须更新（缓存绝不返回旧哈希）')

  // ④ 缓存是纯优化：形状不符（版本不是 1）必须整体丢弃并回落全量读
  await fs.writeFile(path.join(engine3.storeDir, 'path-cache.json'), JSON.stringify({ version: 2, entries: {} }))
  const engine4 = makeEngine(fx, { readFile: reader.seam })
  reader.reset()
  const fourth = await capturePoint(engine4, fx, { sessionId: 's-cache-4' })
  assert.equal(fourth.ok, true)
  assert.equal(reader.reads.length, 2, '坏缓存必须整体丢弃 ⇒ 两个文件都真读')
})

test('T2-B 缓存命中与未命中两条路径下，删除候选判定（预览 removals / createdSkipped）逐条相同', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const reader = countingReader()
  const engine = makeEngine(fx, { readFile: reader.seam })
  // 留点时：既有文件若干（含 .git 拒删项）
  await fs.mkdir(path.join(fx.workspaceDir, '.git'), { recursive: true })
  await fs.writeFile(path.join(fx.workspaceDir, '.git', 'index'), 'GIT')
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')

  // 点之后：新建两条可删的 + 一条 .git 内的拒删项
  const created = [
    path.join(fx.workspaceDir, 'new-1.txt'),
    path.join(fx.workspaceDir, 'new-2.txt'),
  ]
  await fs.writeFile(created[0] ?? '', 'N1')
  await fs.writeFile(created[1] ?? '', 'N2')
  await fs.writeFile(path.join(fx.workspaceDir, '.git', 'mid'), 'GIT2')

  // ① 命中路径：缓存可用
  const hit = await engine.preview(id)
  assert.equal(hit.ok, true)
  assert.deepEqual(hit.workspace.removals, created, '两条新建路径都必须被列为会删')
  // `.git` 从两侧走查排除 ⇒ 它不进候选（口径与执行侧、与 R-05d 一致）
  assert.equal(hit.workspace.createdSkippedCount, 0, '.git 不进候选 ⇒ 无拒删项')

  // ② 未命中路径：删掉缓存文件 + 用新实例（只能全量真读）
  await fs.rm(path.join(engine.storeDir, 'path-cache.json'), { force: true })
  const miss = makeEngine(fx, { readFile: reader.seam })
  const missed = await miss.preview(id)
  assert.equal(missed.ok, true)
  assert.deepEqual(missed.workspace.removals, hit.workspace.removals, '命中 / 未命中两条路径的删除清单必须逐条相同')
  assert.deepEqual(missed.workspace.createdSkipped, hit.workspace.createdSkipped, '拒删清单也必须逐条相同')
  assert.equal(missed.workspace.createdAfter, hit.workspace.createdAfter)

  // ③ 执行端同样一致：真的删掉的就是预览列的那两条
  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.deepEqual(ws?.removedPaths, hit.workspace.removals, '预览说会删的 = 实际删的')
  for (const file of created) await assert.rejects(fs.readFile(file), { code: 'ENOENT' })
})

test('T2-C 忽略规则：整个目录被忽略 ⇒ **只拒那棵子树**的删除（分子树 fail-closed），范围外照常删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-ignore-dir', { 'keep.txt': 3, 'note.md': 3 })
  const buildDir = path.join(dir, 'build')
  await fs.mkdir(buildDir, { recursive: true })
  await fs.writeFile(path.join(buildDir, 'artifact.bin'), 'BIN')
  // 分块根的忽略规则：整个 build/ 目录被忽略
  await fs.writeFile(path.join(dir, '.dsh-rollback-ignore'), 'build/' + '\n')

  const engine = makeEngine(fx)
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-ig' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  // 被忽略目录如实留痕，并且**没有**被走查（其下文件不进 files / skipped）
  assert.equal(payload.ignoreIncomplete, true, '整目录被忽略 ⇒ 标记证明名单不完整')
  assert.equal(payload.ignoredDirCount, 1)
  assert.deepEqual((payload.ignoredDirs ?? []).map((e) => e.path), [buildDir])
  assert.equal(payload.files.some((f) => f.path.startsWith(buildDir)), false, '被忽略目录整棵不进快照')

  // 点之后：新建一条根级文件 + 一条 build 内的文件
  const createdRoot = path.join(dir, 'created-root.txt')
  const createdInBuild = path.join(buildDir, 'created-in-build.txt')
  await fs.writeFile(createdRoot, 'NEW')
  await fs.writeFile(createdInBuild, 'NEW-IN-BUILD')

  // 分子树 fail-closed：拒删只说 build/ 那棵子树，不再把整个工作区的删除一起关掉
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, null, '范围说得清 ⇒ 不是全局拒删')
  assert.deepEqual(preview.workspace.removals, [createdRoot], '范围外的候选照常删')
  // 被忽略的子树在**回退期也走查不到**（同一条忽略规则）⇒ 它里面的路径根本不进候选，
  // 既不在删除集、也不必进拒删清单；它的安全由「两端一致地看不见」保证。
  assert.deepEqual(preview.workspace.createdSkipped, [], '被忽略子树整棵不进候选')
  assert.equal(
    preview.warnings.some((w) => w.code === 'rollback.warn.createdRefused'),
    false,
    '不再「一条都不删」⇒ 不得给那句全局警告（文案诚实性）',
  )

  // 执行：范围内删 1 条、子树里的一条都不删
  const rewound = await engine.rewind({
    id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.createdRefusedReason, undefined, '分子树拒绝不是全局拒绝')
  assert.equal(ws?.removed, 1, '范围外的候选照常删')
  await assert.rejects(fs.readFile(createdRoot), { code: 'ENOENT' })
  assert.equal(await readText(createdInBuild), 'NEW-IN-BUILD', '被忽略子树里的新建路径绝不删')
  assert.equal(ws?.createdSkippedCount ?? 0, 0, '被忽略子树不进候选 ⇒ 拒删清单为空（不是「拒删了几条」）')
})

test('T2-D 忽略规则：文件级忽略仍保持证明名单完整 ⇒ 删除照常；内置 node_modules 规则不可反向取消', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-ignore-file', { 'keep.txt': 3 })
  await fs.writeFile(path.join(dir, 'old.log'), 'OLD')
  // 文件级忽略 + 一条试图反向取消内置 node_modules 的规则
  await fs.writeFile(path.join(dir, '.dsh-rollback-ignore'), '*.log' + '\n' + '!node_modules' + '\n')
  const nm = path.join(dir, 'node_modules', 'dep')
  await fs.mkdir(nm, { recursive: true })
  await fs.writeFile(path.join(nm, 'index.js'), 'DEP')

  const engine = makeEngine(fx)
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-igf' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.ignoreIncomplete ?? false, false, '文件级忽略不使证明名单不完整')
  // 文件级忽略逐条进 skipped（沿用 skipped 语义），于是它仍在证明名单里
  assert.ok(payload.skipped.some((e) => e.path.endsWith('old.log') && e.reason === 'ignored'), JSON.stringify(payload.skipped))
  // 内置规则不可反向取消：node_modules 仍然整棵忽略（走 excludedDirs）
  assert.ok(payload.excludedDirs.some((e) => e.path === path.join(dir, 'node_modules')), 'node_modules 必须仍被内置规则整棵忽略')
  assert.equal(payload.files.some((f) => f.path.startsWith(path.join(dir, 'node_modules'))), false)

  // 点之后：新建 .txt（可删）+ 新建 .log（被忽略 ⇒ 不进候选 ⇒ 不删）
  const createdTxt = path.join(dir, 'created.txt')
  const createdLog = path.join(dir, 'created.log')
  await fs.writeFile(createdTxt, 'NEW')
  await fs.writeFile(createdLog, 'NEW-LOG')
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, null, '证明名单完整 ⇒ 不拒删')
  assert.deepEqual(preview.workspace.removals, [createdTxt], '只有非忽略的新建路径进删除清单')

  const rewound = await engine.rewind({
    id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.removed, 1)
  await assert.rejects(fs.readFile(createdTxt), { code: 'ENOENT' })
  assert.equal(await readText(createdLog), 'NEW-LOG', '被忽略的路径不进候选 ⇒ 绝不删它')
})

test('T2-E 内存硬约束：同时驻留的文件内容 ≤ maxFileBytes（绝不把整仓一次读进内存）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 10 个小文件 + 1 个超单文件上限的大文件；上限 64 字节
  const sizes: Record<string, number> = {}
  for (let i = 0; i < 10; i += 1) sizes['small-' + String(i) + '.txt'] = 32
  sizes['huge.txt'] = 4096
  const dir = await makeSizeDir(fx, 'cap-mem', sizes)
  const reader = countingReader()
  const engine = makeEngine(fx, { maxFileBytes: 64, captureInFlightBytes: 64, maxBytes: 1024 * 1024, readFile: reader.seam })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-mem' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  // 超限文件必须先 stat 判大小后跳过 —— 计数器里绝不能出现它（「先 stat 再决定读不读」）
  assert.equal(reader.reads.includes(path.join(dir, 'huge.txt')), false, '超限文件绝不整份读进内存')
  assert.ok(payload.skipped.some((e) => e.path.endsWith('huge.txt') && e.reason === 'too-large'))
  assert.equal(payload.files.length, 10)
  // 两个上限是两件事：maxFileBytes = 单文件「要不要读」的判据；captureInFlightBytes = 并发内存闸门。
  // 2026-10-16 之前闸门错接到 maxFileBytes（缺省 = 总量预算 512 MiB）⇒ 桌面闪退。
  assert.ok(reader.peakSingle <= 64, '单份驻留 = ' + String(reader.peakSingle) + ' > maxFileBytes=64')
  assert.ok(
    reader.peakLive <= 64,
    '同时驻留内容 = ' + String(reader.peakLive) + ' 字节，必须 ≤ captureInFlightBytes(64)',
  )
})

test('T2-F 容量缺省：maxFiles 20000 / maxBytes 512 MiB，且超单文件上限继续跳过并逐条留痕', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  assert.equal(ROLLBACK_DEFAULT_MAX_FILES, 20000)
  assert.equal(ROLLBACK_DEFAULT_MAX_BYTES, 512 * 1024 * 1024)

  // 行为面：2100 个文件（超过**旧**缺省 2000）在缺省引擎下必须全部收进快照、且不截断
  const dir = await makeSizeDir(fx, 'cap-default', {})
  const names = Array.from({ length: 2100 }, (_, i) => 'f-' + String(i).padStart(5, '0') + '.txt')
  for (const name of names) await fs.writeFile(path.join(dir, name), 'y')
  const engine = makeEngine(fx)
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-cap' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.files.length, 2100, '缺省 20000 ⇒ 2100 个文件全部入快照（旧缺省 2000 会截断）')
  assert.equal(payload.truncated, false)
  // 超单文件上限的条目仍逐条留痕（行为不变）
  const big = path.join(dir, 'big.bin')
  await fs.writeFile(big, 'z'.repeat(200))
  const engine2 = makeEngine(fx, { maxFileBytes: 64 })
  const captured2 = await engine2.capturePoint({ chunks: [dir], sessionId: 's-cap-2' })
  const payload2 = captured2.point?.workspace.payload
  assert.ok(payload2 !== null && payload2 !== undefined)
  assert.ok(payload2.skipped.some((e) => e.path === big && e.reason === 'too-large'), '超单文件上限必须逐条留痕')
  assert.equal(payload2.files.some((f) => f.path === big), false)
})

/**
 * t12 回归（F-1）：文件级忽略命中的路径也必须进 walked（路径索引来源）。
 * 否则 skipped 被记录上限截断后，「留点时已存在但被忽略」的文件会被当成新建删掉。
 * 复现：maxSkippedEntries=2 + 10 个被忽略的既有 *.log + 捕获后删掉规则文件。
 */
test('t12 文件级忽略 + 记录上限：既有文件绝不因忽略规则变更被当成新建删掉', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-ignore-trunc', { 'keep.txt': 1 })
  const oldLogs: string[] = []
  for (let i = 0; i < 10; i += 1) {
    const p = path.join(dir, 'old-' + String(i) + '.log')
    await fs.writeFile(p, 'LOG' + String(i))
    oldLogs.push(p)
  }
  const rules = path.join(dir, '.dsh-rollback-ignore')
  await fs.writeFile(rules, '*.log\n')
  const engine = makeEngine(fx, { maxSkippedEntries: 2 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-ig-trunc' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.skippedTruncated, true, '10 个被忽略文件打满 2 条记录上限 ⇒ 名单被截断')
  // 关键：路径索引必须覆盖被忽略的既有文件（F-1 修复点）
  assert.ok((payload.pathIndex?.count ?? 0) >= 12, '路径索引必须含 10 个被忽略文件 + 规则文件 + keep.txt，实际 ' + String(payload.pathIndex?.count))
  // 用户随后不再忽略 *.log（删规则）——这 10 个文件在留点时刻确实存在
  await fs.rm(rules, { force: true })
  const created = path.join(dir, 'brand-new.txt')
  await fs.writeFile(created, 'NEW')
  const rewound = await engine.rewind({ id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  const deletedOld = (ws?.removedPaths ?? []).filter((f) => f.endsWith('.log'))
  assert.deepEqual(deletedOld, [], '留点时已存在的 .log 一条都不许删（实际删了 ' + String(deletedOld.length) + ' 条）')
  for (const p of oldLogs) assert.equal(await readText(p) !== '', true, '既有 .log 必须原样保留：' + p)
  assert.ok((ws?.removedPaths ?? []).includes(created), '留点后新建的 brand-new.txt 仍必须被删（不过度拒绝）')
})

/**
 * t14 回归（F-6）：两个桶受记录上限截断时，**计数必须取恒增计数器**（绝不等于被截断的列表长度）；
 * 且 maxSkippedEntries=0 时 ignoreIncomplete 仍必须为 true —— 否则删除集的 fail-closed 会静默失效。
 */
test('t14 忽略目录计数取恒增计数器：列表可截断、计数与 ignoreIncomplete 仍如实', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-ignore-count', { 'keep.txt': 1 })
  const buildDirs = ['build-a', 'build-b', 'build-c']
  for (const name of buildDirs) {
    const full = path.join(dir, name)
    await fs.mkdir(full, { recursive: true })
    await fs.writeFile(path.join(full, 'artifact.bin'), 'BIN')
  }
  await fs.writeFile(path.join(dir, '.dsh-rollback-ignore'), buildDirs.map((n) => n + '/').join('\n') + '\n')

  // ① 记录上限 1：逐条列表被截断，计数与 ignoreIncomplete 仍如实
  const engine = makeEngine(fx, { maxSkippedEntries: 1 })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-f6' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.ignoredDirs.length, 1, '逐条列表受记录上限约束（只留 1 条）')
  assert.equal(payload.ignoredDirCount, 3, '计数必须是真实总数（恒增计数器），不是被截断的列表长度')
  assert.equal(payload.ignoreIncomplete, true, '有目录被忽略 ⇒ 证明名单不完整 ⇒ 删除整体拒绝')

  // ② 记录上限 0：列表为空但 ignoreIncomplete 绝不静默变 false（fail-closed）
  const engine0 = makeEngine(fx, { maxSkippedEntries: 0 })
  const captured0 = await engine0.capturePoint({ chunks: [dir], sessionId: 's-f6b' })
  const payload0 = captured0.point?.workspace.payload
  assert.ok(payload0 !== null && payload0 !== undefined)
  assert.equal(payload0.ignoredDirs.length, 0, '上限 0 ⇒ 一条列表都不留')
  assert.equal(payload0.ignoredDirCount, 3, '计数仍必须是 3')
  assert.equal(payload0.ignoreIncomplete, true, 'maxSkippedEntries=0 时 fail-closed 不得静默失效')
  // ③ 删除仍整体拒绝（不看列表长度）
  await fs.rm(path.join(dir, '.dsh-rollback-ignore'), { force: true })
  await fs.writeFile(path.join(dir, 'brand-new.txt'), 'NEW')
  const preview = await engine0.preview(captured0.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, 'capture-incomplete', '上限 0 也必须拒删')
  assert.deepEqual(preview.workspace.removals, [], '拒删 ⇒ 删除清单为空')
})

test('T2-G 路径身份缓存随 gc 回收：删除回滚点后，缓存里不再留它的条目', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const first = await capturePoint(engine, fx, { sessionId: 's-gc-1' })
  const cacheAfterFirst = await cacheFileOf(engine)
  assert.equal(Object.keys(cacheAfterFirst.entries).length, 2)

  // 第二个点（换会话，避免被每会话 20 条上限裁掉）
  const second = await capturePoint(engine, fx, { sessionId: 's-gc-2' })
  assert.equal(Object.keys((await cacheFileOf(engine)).entries).length, 2, '同一批路径的身份键复用同两条')

  // 删掉第一个点：它引用的路径不再被台账引用 ⇒ 缓存条目随之回收
  const removed = await engine.remove(first.point?.id ?? '')
  assert.equal(removed.ok, true)
  const cacheAfterRemove = await cacheFileOf(engine)
  assert.equal(Object.keys(cacheAfterRemove.entries).length, 2, '第二个点仍引用同一批路径 ⇒ 条目保留')
  assert.equal((await engine.list()).points.some((pt) => pt.id === second.point?.id), true)

  // 删掉最后一个点：台账里没有任何引用 ⇒ 缓存清空（不无界增长）
  assert.equal((await engine.remove(second.point?.id ?? '')).ok, true)
  assert.equal(Object.keys((await cacheFileOf(engine)).entries).length, 0, '没有引用者 ⇒ 缓存条目必须被回收')
})

/* ========================== R-30..R-35（2026-10-14 三款竞品对照后的修复） */

test('R-30 子代理会话不参与自动留点：origin=subagent 给显式机器码；读不到 origin 照常', () => {
  const sub = rollbackSessionBindingOf({ id: 'session-9', header: { cwd: '/ws', origin: 'subagent' } })
  assert.equal(sub.ok, false)
  assert.equal(sub.ok === false ? sub.code : 'ok', 'subagent-session')
  // 老宿主 / 形状不符：**不加判定** —— 绝不因为读不到 origin 就少留点
  assert.equal(rollbackSessionBindingOf({ id: 'session-9', header: { cwd: '/ws' } }).ok, true)
  // origin 存在但不是 subagent（父会话 / 用户会话）：照常
  assert.equal(rollbackSessionBindingOf({ id: 'session-9', header: { cwd: '/ws', origin: 'user' } }).ok, true)
})

test('R-31 采集时间预算：超预算留**部分点**并如实标 truncated（不是失败、不静默）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 时钟每次读 +1ms、预算 1ms ⇒ 第一个判定点就超时（确定性的，不依赖真机速度）
  const engine = makeEngine(fx, { captureBudgetMs: 1, now: steppingClock(1_000, 1) })
  const captured = await capturePoint(engine, fx)
  assert.equal(captured.ok, true, '超预算不是失败：已收条目照常成点')
  const track = captured.point?.workspace
  assert.equal(track?.degraded, true)
  assert.equal(track?.reasonCode, 'capture-truncated')
  assert.equal(track?.payload?.truncated, true)
  assert.ok(
    (track?.payload?.skipped ?? []).some((s) => s.reason === 'budget-time'),
    '超时必须逐条留痕 budget-time（不是静默截断）',
  )
  assert.equal(track?.payload?.walkIncomplete, true, '走查中断必须标记 ⇒ 删除集随之 fail-closed')
})

/**
 * 测试专用的时序注入：把「预算**何时**越界」钉成确定性的（不靠真机速度）。
 *
 * `now` 恒定返回同一个基线时刻，直到 state 被置位才推过 deadline：
 *  · `walkDone` 由 {@link timeOutAfterWalk} 在 listChunkFiles 返回后置位 ⇒ 越界发生在**读文件阶段**；
 *  · `armed` 由 {@link timeOutAtStop} 在第 N 次停止判据内置位 ⇒ 越界发生在**走查之中**。
 */
function makeArmedClock(budgetMs: number): { now: () => number; state: { armed: boolean } } {
  const base = 1_000_000
  const state = { armed: false }
  // 未 armed ⇒ 恒定基线时刻（永不越界）；armed ⇒ 直接推过 deadline
  const now = (): number => (state.armed ? base + budgetMs + 60_000 : base)
  return { now, state }
}

/** 包一层私有的 listChunkFiles：把第 `at` 次停止判据变成「越界」（栈里还剩没进去的子树）。 */
function timeOutAtStop(engine: RollbackPointEngine, state: { armed: boolean }, at: number): void {
  const self = engine as unknown as { listChunkFiles: (...args: unknown[]) => Promise<unknown> }
  const original = self.listChunkFiles.bind(engine)
  // 计数跨分块累计（每个分块各调一次 listChunkFiles，停止判据是按次判定的）
  let calls = 0
  self.listChunkFiles = async (...args: unknown[]) => {
    const stop = args[5]
    if (typeof stop === 'function') {
      const stopFn = stop as () => boolean
      args[5] = () => {
        calls += 1
        if (calls >= at) state.armed = true
        return stopFn()
      }
    }
    return await original(...args)
  }
}

test('R-43 预算落在**走查之后**：不误报 walk-incomplete，被中断的条目逐条留痕（删除照常）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-after-walk', { 'k1.txt': 3, 'k2.txt': 3, 'k3.txt': 3 })
  const clock = makeArmedClock(50)
  const engine = makeEngine(fx, {
    captureBudgetMs: 50,
    now: clock.now,
    captureConcurrency: 1,
    // 确定性地把「超时」钉在**第一个文件读完之后**（不靠真机速度）：并发为 1 ⇒ 只此一份入点
    readFile: async (file: string) => {
      const bytes = await fs.readFile(file)
      clock.state.armed = true
      return bytes
    },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-after-walk' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  // 读文件阶段被打断 ⇒ 截断仍如实标注（诚实不降级）
  assert.equal(payload.truncated, true, '读到一半停下必须如实标截断')
  assert.equal(captured.point?.workspace.reasonCode, 'capture-truncated')
  assert.deepEqual(payload.files.map((f) => path.basename(f.path)), ['k1.txt'], JSON.stringify(payload.files))
  // 被中断的两条**逐条留痕**（不静默）—— 名单因此保持完整，不需要路径索引兜底
  assert.deepEqual(
    payload.skipped.filter((s) => s.reason === 'budget-time').map((s) => path.basename(s.path)),
    ['k2.txt', 'k3.txt'],
    JSON.stringify(payload.skipped),
  )
  // 核心：走查已走完 ⇒ **不得**标记「走查不完整」（旧实现在这里误报，删除集整片失效）
  assert.equal(payload.walkIncomplete ?? false, false, '走查已完成 ⇒ 不许标记 walkIncomplete（误报回归）')
  assert.equal(payload.pathIndex ?? null, null, '每条都逐条留痕 ⇒ 覆盖自检认为名单完整，无需索引')

  // 点之后新建一条：证明名单完整 ⇒ 预览与执行都照常删
  const created = path.join(dir, 'created-after.txt')
  await fs.writeFile(created, 'NEW')
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, null, '证明名单完整 ⇒ 不拒删')
  assert.deepEqual(preview.workspace.removals, [created])
  assert.equal(preview.warnings.some((w) => w.code === 'rollback.warn.createdRefused'), false, JSON.stringify(preview.warnings))

  const rewound = await engine.rewind({
    id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.removed, 1, '证明名单完整 ⇒ 新建文件照常删')
  await assert.rejects(fs.readFile(created), { code: 'ENOENT' })
  assert.equal(await readText(path.join(dir, 'k3.txt')), 'xxx', '没读到的老文件绝不能被当成「新建」删掉')
})

test('R-44 走查被打断：只拒「没走查到的那棵子树」（分子树 fail-closed），范围外照常删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 分块 1 整棵走完（其中的文件照常入点）；分块 2 的走查在弹出 sub/ **之前**被预算打断 ⇒ sub/ 从未进门
  const dir1 = await makeSizeDir(fx, 'cap-walk-ok', { 'n1.txt': 3 })
  const dir2 = await makeSizeDir(fx, 'cap-walk-abort', { 'm1.txt': 3 })
  const sub = path.join(dir2, 'sub')
  await fs.mkdir(sub, { recursive: true })
  await fs.writeFile(path.join(sub, 'm2.txt'), 'OLD-IN-SUB')
  const clock = makeArmedClock(50)
  const engine = makeEngine(fx, { captureBudgetMs: 50, now: clock.now, captureConcurrency: 1 })
  // 停止判据调用序：dir1 排空(#1) → dir2 弹出(#2，仍在预算内) → dir2/sub 弹出(#3，越界 ⇒ sub/ 从未进门)
  timeOutAtStop(engine, clock.state, 3)

  const captured = await engine.capturePoint({ chunks: [dir1, dir2], sessionId: 's-walk-abort' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(payload.truncated, true)
  assert.equal(payload.walkIncomplete, true, '子树从未进门 ⇒ 安全判据必须生效')
  assert.deepEqual(payload.unwalkedDirs, [sub], '精确范围必须带出来（分子树 fail-closed 的依据）')
  assert.deepEqual(payload.files.map((f) => path.basename(f.path)), ['n1.txt'], '打断前读完的分块照常入点')
  assert.equal(payload.files.some((f) => f.path.startsWith(sub)), false, 'sub/ 从未被走查')
  assert.ok(
    payload.skipped.some((s) => s.path.endsWith('m1.txt') && s.reason === 'budget-time'),
    JSON.stringify(payload.skipped),
  )

  const createdElsewhere = path.join(dir1, 'created-in-walked-chunk.txt')
  const createdRoot = path.join(dir2, 'created-root.txt')
  const createdInSub = path.join(sub, 'created-in-sub.txt')
  await fs.writeFile(createdElsewhere, 'NEW')
  await fs.writeFile(createdRoot, 'NEW')
  await fs.writeFile(createdInSub, 'NEW-IN-SUB')
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, null, '范围说得清 ⇒ 不是全局拒删')
  assert.deepEqual(
    [...preview.workspace.removals].sort(),
    [createdElsewhere, createdRoot].sort(),
    '没走查到的子树之外，候选照常删',
  )
  // 没走查到的子树里，**所有**当前存在且无记录的路径都进拒删清单（新建的 + 本来就在的 m2.txt）
  assert.deepEqual(
    [...preview.workspace.createdSkipped].sort(),
    [createdInSub, path.join(sub, 'm2.txt')].sort(),
    '子树里的候选如实进拒删清单',
  )
  assert.equal(
    preview.warnings.some((w) => w.code === 'rollback.warn.createdRefused'),
    false,
    '分子树拒绝不得套用那句「一条都不删」的全局警告',
  )

  const rewound = await engine.rewind({
    id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.createdRefusedReason, undefined, '分子树拒绝不是全局拒绝')
  assert.equal(ws?.removed, 2, '没走查到的子树之外照常删')
  await assert.rejects(fs.readFile(createdElsewhere), { code: 'ENOENT' })
  await assert.rejects(fs.readFile(createdRoot), { code: 'ENOENT' })
  assert.equal(await readText(createdInSub), 'NEW-IN-SUB')
  assert.equal(await readText(path.join(sub, 'm2.txt')), 'OLD-IN-SUB', '从未走查的文件绝不能被删')
  assert.equal(await readText(path.join(dir1, 'n1.txt')), 'xxx')
  assert.ok((ws?.createdSkippedCount ?? 0) > 0, '候选必须如实进拒删清单')
})

test('R-45 捕获并发：读 + 写并发跑（真机大头），但在飞内容字节 ≤ captureInFlightBytes', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const sizes: Record<string, number> = {}
  for (let i = 0; i < 24; i += 1) sizes['p-' + String(i).padStart(2, '0') + '.txt'] = 64
  const dir = await makeSizeDir(fx, 'cap-parallel', sizes)
  let live = 0
  let peak = 0
  let inFlight = 0
  let maxInFlight = 0
  const engine = makeEngine(fx, {
    // 闸门 = captureInFlightBytes（并发内存上界），与 maxFileBytes（单文件判据）分开：
    // 同时最多 4 份 64 B 的内容在飞。
    captureInFlightBytes: 256,
    readFile: async (file: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const bytes = await fs.readFile(file)
      live += bytes.byteLength
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 2)) // 让并发真的重叠
      live -= bytes.byteLength
      inFlight -= 1
      return bytes
    },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-par' })
  const payload = captured.point?.workspace.payload
  assert.equal(payload?.files.length, 24, JSON.stringify(payload?.skipped))
  assert.ok(maxInFlight > 1, '必须真的并发（否则 34k 文件永远扫不完）：实测 ' + String(maxInFlight))
  assert.ok(peak <= 256, '在飞内容字节必须 ≤ captureInFlightBytes，实测 ' + String(peak))
})

test('R-45b 缺省闸门：maxFileBytes 缺省 = 总量预算，绝不能当成在飞内容上限（0.1.74 闪退根因）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const sizes: Record<string, number> = {}
  for (let i = 0; i < 24; i += 1) sizes['g-' + String(i).padStart(2, '0') + '.txt'] = 64
  const dir = await makeSizeDir(fx, 'cap-inflight-default', sizes)
  let live = 0
  let peak = 0
  // maxFileBytes 给一个**远大于闸门**的值：旧实现（闸门 = maxFileBytes）会放行 24×64 = 1536 B 在飞。
  const engine = makeEngine(fx, {
    maxFileBytes: 4096,
    captureInFlightBytes: 128,
    readFile: async (file: string) => {
      const bytes = await fs.readFile(file)
      live += bytes.byteLength
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 2))
      live -= bytes.byteLength
      return bytes
    },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-inflight' })
  assert.equal(captured.point?.workspace.payload?.files.length, 24)
  assert.ok(peak <= 128, '在飞内容必须被 captureInFlightBytes 钉死（不是 maxFileBytes），实测 ' + String(peak))
  // 缺省闸门本身必须远小于总量预算 —— 它才是并发的内存上界
  assert.equal(ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES, 32 * 1024 * 1024)
  assert.ok(
    ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES < ROLLBACK_DEFAULT_MAX_BYTES / 8,
    '缺省在飞闸门必须比总量预算小一个数量级以上',
  )
})

test('T2-H .asar 路径绝不交给 fs：宿主里那是原生容器解析，畸形夹具能带走整个宿主', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-asar', {})
  await fs.writeFile(path.join(dir, 'normal.txt'), 'N')
  await fs.writeFile(path.join(dir, 'broken.asar'), Buffer.alloc(64, 0xff))
  await fs.mkdir(path.join(dir, 'bundle.asar'), { recursive: true })
  await fs.writeFile(path.join(dir, 'bundle.asar', 'inner.txt'), 'I')
  const reads: string[] = []
  const engine = makeEngine(fx, {
    readFile: async (file: string) => {
      reads.push(file)
      return await fs.readFile(file)
    },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-asar' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(reads.some((f) => f.endsWith('.asar')), false, '任何 .asar 路径都不得被读')
  assert.equal(reads.some((f) => f.includes('.asar' + path.sep)), false, '含 .asar 段的路径一律不碰')
  assert.ok(
    payload.skipped.some((e) => e.path.endsWith('broken.asar') && e.reason === 'asar-container'),
    '畸形 .asar 必须留痕为 asar-container: ' + JSON.stringify(payload.skipped.map((e) => [e.path, e.reason])),
  )
  assert.ok(
    payload.skipped.some((e) => e.path.endsWith('bundle.asar') && e.reason === 'asar-container'),
    '名字含 .asar 段的目录同样不碰',
  )
  assert.ok(payload.files.some((f) => f.path.endsWith('normal.txt')), '普通文件照常入点')
})

test('R-46 缺口优先：预算被限死时覆盖率随回合**单调收敛**到 100%', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-converge', {})
  const names = Array.from({ length: 60 }, (_, i) => 'c-' + String(i).padStart(3, '0') + '.txt')
  for (const name of names) await fs.writeFile(path.join(dir, name), 'x')
  // 每回合只放行 3 次读：等价于「预算只够扫一小部分」的确定性版本
  let allowance = 3
  const engine = makeEngine(fx, {
    captureConcurrency: 1,
    now: () => (allowance <= 0 ? 2_000_000 + 60_000 : 2_000_000),
    readFile: async (file: string) => {
      const bytes = await fs.readFile(file)
      allowance -= 1
      return bytes
    },
  })
  const seen = new Set<string>()
  const covered: number[] = []
  for (let round = 0; round < 25; round += 1) {
    allowance = 3
    const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-converge' })
    for (const file of captured.point?.workspace.payload?.files ?? []) seen.add(file.path)
    covered.push(seen.size)
  }
  for (let i = 1; i < covered.length; i += 1) {
    assert.ok(covered[i]! >= covered[i - 1]!, '覆盖率不得回退：' + covered.join(','))
  }
  assert.equal(covered[covered.length - 1], 60, '足够多回合后必须覆盖 100%：' + covered.join(','))
})

test('R-47 自适应预算：被截断 ⇒ 下次翻倍；提前收工 ⇒ 下次减半（区间内）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-adapt', { 'a.txt': 3, 'b.txt': 3 })
  let stepped = true
  let tick = 0
  const engine = makeEngine(fx, {
    captureBudgetMs: 1_000,
    captureBudgetMinMs: 500,
    captureBudgetMaxMs: 4_000,
    now: () => (stepped ? (tick += 1_000) : Date.now()),
  })
  const budgetOf = (): number => (engine as unknown as { captureBudgetMs: number }).captureBudgetMs
  assert.equal(budgetOf(), 1_000, '初值 = 选项值')
  // ① 步进时钟 ⇒ 一次次判定就撞满预算 ⇒ 截断 ⇒ 下次翻倍
  const truncated = await engine.capturePoint({ chunks: [dir], sessionId: 's-adapt' })
  assert.equal(truncated.point?.workspace.payload?.truncated, true)
  assert.equal(budgetOf(), 2_000, '被截断 ⇒ 翻倍')
  // ② 真实时钟 ⇒ 两个小文件毫秒级跑完（用不到 1/4）⇒ 下次减半；继续跑到下界为止
  stepped = false
  await engine.capturePoint({ chunks: [dir], sessionId: 's-adapt' })
  assert.equal(budgetOf(), 1_000, '提前收工 ⇒ 减半')
  await engine.capturePoint({ chunks: [dir], sessionId: 's-adapt' })
  await engine.capturePoint({ chunks: [dir], sessionId: 's-adapt' })
  assert.equal(budgetOf(), 500, '减到下界即停（回到 captureBudgetMinMs 下界）')
})

test('R-48 捕获竞态：读到一半被改写的文件不当前像，但进证明名单（绝不被当成新建删掉）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-race', { 'r1.txt': 3, 'r2.txt': 3 })
  const target = path.join(dir, 'r1.txt')
  let mutated = false
  const engine = makeEngine(fx, {
    captureConcurrency: 1,
    readFile: async (file: string) => {
      const bytes = await fs.readFile(file)
      if (file === target && !mutated) {
        mutated = true
        await fs.writeFile(file, 'XYZ') // 同长度原地改写：身份（mtimeNs/ctimeNs）必变
      }
      return bytes
    },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-race' })
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  assert.equal(mutated, true)
  assert.equal(payload.files.some((f) => f.path === target), false, '竞态中的文件不得当作前像')
  assert.ok(
    payload.unreadableFiles.some((f) => f.path === target && f.reason === 'changed-during-read'),
    JSON.stringify(payload.unreadableFiles),
  )
  const created = path.join(dir, 'created.txt')
  await fs.writeFile(created, 'NEW')
  const preview = await engine.preview(captured.point?.id ?? '')
  assert.equal(preview.workspace.createdRefusedReason, null, '证明名单仍完整（unreadableFiles 也是证明）')
  assert.deepEqual(preview.workspace.removals, [created])
  const rewound = await engine.rewind({
    id: captured.point?.id ?? '', userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true,
  })
  assert.equal(rewound.ok, true)
  assert.equal(await readText(target), 'XYZ', '竞态文件绝不能被当成新建删掉')
  assert.equal(await readText(path.join(dir, 'r2.txt')), 'xxx')
})

test('R-49 记录与读预算解耦：已知内容不占读槽位 ⇒ 大仓库从第二个点起记录全量', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-entries', {})
  const names = Array.from({ length: 12 }, (_, i) => 'e-' + String(i).padStart(2, '0') + '.txt')
  for (const name of names) await fs.writeFile(path.join(dir, name), 'x')
  // 每回合只允许读 5 条**新内容**（maxFiles 约束的是读，不是「记录多少条」）
  const engine = makeEngine(fx, { maxFiles: 5 })
  const first = await engine.capturePoint({ chunks: [dir], sessionId: 's-entries' })
  const p1 = first.point?.workspace.payload
  assert.equal(p1?.files.length, 5, '第一点：只有 5 条新内容被读进来')
  assert.equal(p1?.truncated, true, '还有新内容没读 ⇒ 如实标截断')
  const second = await engine.capturePoint({ chunks: [dir], sessionId: 's-entries' })
  const p2 = second.point?.workspace.payload
  assert.equal(p2?.files.length, 10, '已知的 5 条不占槽位、一律进记录：' + JSON.stringify(p2?.files.map((f) => path.basename(f.path))))
  const third = await engine.capturePoint({ chunks: [dir], sessionId: 's-entries' })
  const p3 = third.point?.workspace.payload
  assert.equal(p3?.files.length, 12, '全部已知 ⇒ 记录必须是全量（这是「任何大小都收敛」的判据）')
  assert.equal(p3?.truncated, false, '没有新内容要读 ⇒ 不该再标截断')
  assert.deepEqual(p3?.files.map((f) => path.basename(f.path)), names, '记录顺序仍按路径有序')
})

test('R-50 降级口径：设计内跳过（符号链接 / 文件级忽略）不构成「留得不完整」；缺内容才算', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 分块根：一个正常文件 + 一个被文件级忽略规则跳过的文件（等价于「符号链接被跳过」那类设计内跳过）
  const dir = await makeSizeDir(fx, 'cap-degraded', { 'keep.txt': 3 })
  await fs.writeFile(path.join(dir, 'old.log'), 'OLD')
  await fs.writeFile(path.join(dir, '.dsh-rollback-ignore'), '*.log' + '\n')
  const engine = makeEngine(fx)
  const first = await engine.capturePoint({ chunks: [dir], sessionId: 's-degraded' })
  const p1 = first.point?.workspace.payload
  assert.ok(p1 !== null && p1 !== undefined)
  assert.ok(p1.skippedCount > 0, '文件级忽略必须逐条留痕：' + JSON.stringify(p1.skipped))
  assert.equal(p1.skipped.some((e) => e.reason === 'ignored'), true)
  assert.equal(p1.truncated, false)
  assert.equal(first.point?.workspace.degraded, false, '设计内跳过 ⇒ 不得报「留得不完整」')
  assert.equal(first.point?.workspace.reasonCode, null)
  const seg = (await engine.list()).points[0]?.segments.find((s) => s.state === 'workspace')
  assert.equal(seg?.degraded, false, '列表摘要同样不得降级')
  assert.equal(seg?.reasonCode, null)

  // 对照：真的缺内容（超单文件上限被跳过）⇒ 必须降级且如实给码
  const dir2 = await makeSizeDir(fx, 'cap-degraded-real', { 'big.bin': 200 })
  const engine2 = makeEngine(fx, { maxFileBytes: 64 })
  const second = await engine2.capturePoint({ chunks: [dir2], sessionId: 's-degraded2' })
  assert.equal(second.point?.workspace.degraded, true)
  assert.equal(second.point?.workspace.reasonCode, 'capture-truncated')
  assert.ok(second.point?.workspace.payload?.skipped.some((e) => e.reason === 'too-large'))
})

test('R-51 预览快路径：身份命中时不再真读工作区文件（大仓库预览的 13 s 就在这一步）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-preview', { 'a.txt': 5, 'b.txt': 5, 'c.txt': 5 })
  const reader = countingReader()
  const engine = makeEngine(fx, { readFile: reader.seam })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-preview' })
  const id = captured.point?.id ?? ''
  reader.reset()
  const first = await engine.preview(id)
  assert.equal(first.workspace.different, 0, '三条全都一致')
  assert.equal(reader.reads.length, 0, '身份命中 ⇒ 预览一次都不读内容：' + JSON.stringify(reader.reads))
  // 改一条：**只有它**需要被真读（其余仍走快路径）
  await fs.writeFile(path.join(dir, 'b.txt'), 'ZZZZZ')
  reader.reset()
  const second = await engine.preview(id)
  assert.equal(second.workspace.different, 1)
  assert.deepEqual(reader.reads, [path.join(dir, 'b.txt')], '只真读被改的那一条：' + JSON.stringify(reader.reads))
})

test('R-52 回退快路径：已一致的条目不读对象、不写盘；用不到的对象坏掉不再中止整次回退', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = await makeSizeDir(fx, 'cap-rewind-fast', { 'k1.txt': 5, 'k2.txt': 5 })
  const reader = countingReader()
  const engine = makeEngine(fx, {
    readFile: reader.seam,
    writeFile: async () => { throw new Error('不该写任何文件') },
  })
  const captured = await engine.capturePoint({ chunks: [dir], sessionId: 's-rewind-fast' })
  const id = captured.point?.id ?? ''
  reader.reset()
  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true })
  const ws = rewound.segments.find((s) => s.state === 'workspace')
  assert.equal(rewound.outcome, 'restored', JSON.stringify(ws))
  assert.equal(ws?.reasonCode, 'nothing-to-restore', '全部已一致 ⇒ 0 变更')
  assert.equal(reader.reads.length, 0, '身份命中 ⇒ 阶段 2/3 一次都不读：' + JSON.stringify(reader.reads))

  // 新语义：**用不到的对象**坏掉不该中止整次回退（真要用它时仍会 object-missing 硬失败）
  const payload = (await engine.read(id)).point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  await fs.rm(path.join(engine.storeDir, 'objects', payload.files[0]?.object ?? ''))
  const second = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', mode: 'files', removeCreated: true })
  const ws2 = second.segments.find((s) => s.state === 'workspace')
  assert.equal(second.outcome, 'restored', '用不到的对象坏掉仍应成功：' + JSON.stringify(ws2?.detail))
  assert.equal(ws2?.reasonCode, 'nothing-to-restore')
})

test('R-53 清单增量化：第二点只落「相对第一点的增量」，读回来是同一份完整清单', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = path.join(fx.workspaceDir, 'cap-delta')
  await fs.mkdir(dir, { recursive: true })
  for (let i = 0; i < 40; i += 1) {
    await fs.writeFile(path.join(dir, 'f' + String(i).padStart(2, '0') + '.txt'), 'V' + String(i))
  }
  const engine = makeEngine(fx)
  const first = await engine.capturePoint({ chunks: [dir], sessionId: 's-delta' })
  const firstFull = first.point?.workspace.payload
  assert.ok(firstFull !== null && firstFull !== undefined)
  assert.equal(firstFull.fileCount, 40)
  const manifest = JSON.parse(await fs.readFile(path.join(engine.storeDir, 'index.json'), 'utf8')) as {
    records: { id: string; workspace: { payload: string | null; payloadChain?: string[] } }[]
  }
  void manifest
  // 每次现读清单（第二点会再写一次清单）
  const hashOf = async (id: string): Promise<string> => {
    const fresh = JSON.parse(await fs.readFile(path.join(engine.storeDir, 'index.json'), 'utf8')) as {
      records: { id: string; workspace: { payload: string | null; payloadChain?: string[] } }[]
    }
    return fresh.records.find((r) => r.id === id)?.workspace.payload ?? ''
  }
  const payloadPath = (hash: string): string => path.join(engine.storeDir, 'payloads', hash + '.json')
  const firstHash = await hashOf(first.point?.id ?? '')
  const firstBytes = (await fs.stat(payloadPath(firstHash))).size
  t.diagnostic('首点载荷 ' + String(firstBytes) + ' 字节')
  // 第二点：改 1 个文件 + 新增 1 个 ⇒ 增量应远小于全量
  await fs.writeFile(path.join(dir, 'f00.txt'), 'CHANGED')
  await fs.writeFile(path.join(dir, 'new.txt'), 'NEW')
  const second = await engine.capturePoint({ chunks: [dir], sessionId: 's-delta' })
  const secondFull = second.point?.workspace.payload
  assert.ok(secondFull !== null && secondFull !== undefined)
  assert.equal(secondFull.fileCount, 41, '摘要里的条数必须是全量条数，不是增量条数')
  const payloadsDir = path.join(engine.storeDir, 'payloads')
  const names = await fs.readdir(payloadsDir)
  assert.equal(names.length, 2, '首点全量 + 第二点增量（内容不同 ⇒ 两份载荷）')
  const secondHash = await hashOf(second.point?.id ?? '')
  assert.notEqual(secondHash, firstHash)
  const secondBytes = (await fs.stat(payloadPath(secondHash))).size
  const secondStored = JSON.parse(await fs.readFile(payloadPath(secondHash), 'utf8')) as { delta?: { base?: string } }
  assert.equal(secondStored.delta?.base, firstHash, '第二点必须是相对首点的增量视图（而不是又一份全量）')
  assert.ok(secondBytes < firstBytes / 2, '增量载荷必须明显更小：' + String(secondBytes) + ' vs ' + String(firstBytes))
  // 读回来必须与「全量捕获」逐条一致（路径序 / sha / bytes / 对象键）
  const back = await engine.read(second.point?.id ?? '')
  const rebuilt = back.point?.workspace.payload
  assert.ok(rebuilt !== null && rebuilt !== undefined)
  assert.equal(rebuilt.delta, undefined, '读回来必须是物化后的完整清单')
  const sorted = [...(secondFull.files ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  assert.deepEqual(
    rebuilt.files.map((f) => [f.path, f.sha256, f.bytes, f.object]),
    sorted.map((f) => [f.path, f.sha256, f.bytes, f.object]),
    '增量重建的清单必须与全量逐条一致（含补回的 object）',
  )
  assert.equal(rebuilt.pathIndex?.object ?? null, secondFull.pathIndex?.object ?? null)
  // 预览与全量点同一口径：内容一致 ⇒ 零改动
  const preview = await engine.preview(second.point?.id ?? '')
  assert.equal(preview.workspace.different, 0)
  assert.equal(preview.workspace.overwrite, 41, '全量条数（不是增量条数）')
})

test('R-54 增量链：基准载荷缺失 ⇒ 该点如实失败（绝不返回半份清单）；prune 不删被链引用的载荷', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const dir = path.join(fx.workspaceDir, 'cap-delta-chain')
  await fs.mkdir(dir, { recursive: true })
  for (let i = 0; i < 20; i += 1) await fs.writeFile(path.join(dir, 'g' + String(i) + '.txt'), 'C' + String(i))
  const engine = makeEngine(fx)
  const a = await engine.capturePoint({ chunks: [dir], sessionId: 's-chain' })
  await fs.writeFile(path.join(dir, 'g0.txt'), 'CHANGED')
  const b = await engine.capturePoint({ chunks: [dir], sessionId: 's-chain' })
  assert.ok(a.point !== undefined && b.point !== undefined)
  // 第二点必须是增量（载荷哈希 ≠ 第一点；且它的载荷里有 delta 标记）
  const payloadsDir = path.join(engine.storeDir, 'payloads')
  const names = await fs.readdir(payloadsDir)
  assert.equal(names.length, 2)
  const manifest = JSON.parse(await fs.readFile(path.join(engine.storeDir, 'index.json'), 'utf8')) as {
    records: { id: string; workspace: { payload: string | null; payloadChain?: string[] } }[]
  }
  const entryOf = (id: string) => manifest.records.find((r) => r.id === id)
  const payloadPath = (hash: string): string => path.join(payloadsDir, hash + '.json')
  const bHash = entryOf(b.point.id)?.workspace.payload ?? ''
  assert.ok(Array.isArray(entryOf(b.point.id)?.workspace.payloadChain), '清单条目必须带上解析所需的链')
  const bFile = JSON.parse(await fs.readFile(payloadPath(bHash), 'utf8')) as {
    files?: unknown
    delta?: { base?: string; added?: unknown; removed?: unknown }
  }
  assert.ok(bFile.delta !== undefined && bFile.delta.base !== undefined, '第二点必须落成增量视图')
  const delta0 = bFile.delta as { base: string; added?: unknown }
  // 增量视图**故意**让 files 不是数组：不认识 delta 的旧读取器会因形状不符拒绝这个点（fail-closed），
  // 而不是把「增量那几条」当完整清单去规划删除
  assert.equal(bFile.files, null, '增量视图的 files 必须为 null')
  assert.ok(Array.isArray(delta0.added))
  // 删掉基准载荷：**读第二点必须如实失败**（半份清单会被拿去规划删除，等于删掉其它全部文件）
  await fs.rm(payloadPath(delta0.base))
  const broken = await engine.read(b.point.id)
  assert.equal(broken.point, undefined)
  assert.ok((broken.error ?? '').includes('record-incomplete'), '如实失败：' + String(broken.error))
})

test('R-32 取消信号：已中止 ⇒ 在文件边界停下（部分点 + budget-time 留痕，绝不整份跑完）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const controller = new AbortController()
  controller.abort()
  const captured = await capturePoint(engine, fx, { signal: controller.signal })
  assert.equal(captured.ok, true, '取消 = 部分点，不是失败')
  const track = captured.point?.workspace
  assert.equal(track?.payload?.truncated, true)
  assert.ok((track?.payload?.skipped ?? []).some((s) => s.reason === 'budget-time'))
})

test('R-33 预算兜不住单条点：如实标 overBudget（记录仍保留，绝不悄悄丢用户刚留的点）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 预算 1 字节：任何一条记录都超，且候选里没有可淘汰的旧点
  const engine = makeEngine(fx, { ledgerBytesBudget: 1 })
  assert.equal((await capturePoint(engine, fx)).ok, true)
  const status = await engine.storageStatus()
  assert.equal(status.ledger?.records, 1, '超预算不删刚留的点')
  assert.equal(status.ledger?.overBudget, true, '预算兜不住时必须如实上报，不能显示成「一切正常」')
})

test('R-34 回退前像落盘：成功后 undo 目录零残留', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const rewind = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewind.ok, true)
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1', '前像落盘不影响「写回原内容」')
  const undoRoot = path.join(engine.storeDir, 'undo')
  assert.deepEqual(await fs.readdir(undoRoot).catch(() => []), [], '前像目录用完即清（不留无人认领的字节）')
})

test('R-34b 前像暂存建不出来 ⇒ 零写入失败（回退没有安全网就不该开始）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  // 用一个**文件**占住 undo 路径 ⇒ mkdir 必然失败（ENOTDIR/EEXIST）
  await fs.writeFile(path.join(engine.storeDir, 'undo'), 'block')
  const rewind = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewind.ok, false)
  assert.equal(rewind.outcome, 'failed')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2', '零写入：文件保持回退前的内容')
})

test('R-35 崩溃残留的回退前像目录：死 pid 整目录清掉、活 pid 一律不碰', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  await engine.storageStatus()
  const undoRoot = path.join(engine.storeDir, 'undo')
  const dead = path.join(undoRoot, '999999-abc-01234567')
  const live = path.join(undoRoot, String(process.pid) + '-abc-01234567')
  await fs.mkdir(dead, { recursive: true })
  await fs.writeFile(path.join(dead, '0.bin'), 'x'.repeat(64))
  await fs.mkdir(live, { recursive: true })
  const { cleanupOrphanTempFiles } = await import('./rollback-ledger.ts')
  const result = await cleanupOrphanTempFiles(engine.storeDir)
  assert.equal(result.removed, 1)
  assert.ok(result.bytes >= 64)
  await assert.rejects(fs.access(dead), '死 pid 的残留目录必须被清掉')
  await fs.access(live)
})

test('R-36 走查被中断的点：删除集整体拒绝（未走查的子树不得被当成「留点后新建」删掉）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  // 白盒：造出 R-31 现场的那个状态（时间预算中断 ⇒ 剩余子树一条都没进任何名单）
  const record = await readFullRecord(engine, id)
  assert.notEqual(record.workspace.payload, null)
  if (record.workspace.payload !== null) record.workspace.payload.walkIncomplete = true
  await writeFullRecord(engine, record)

  // 留点之后新建的文件：它在留点时刻**是否存在**已无从证明
  const created = path.join(fx.workspaceDir, 'created-after.txt')
  await fs.writeFile(created, 'NEW')

  const preview = await engine.preview(id)
  assert.equal(preview.workspace.createdRefusedReason, 'capture-incomplete', '预览必须拒绝删除并说明原因')
  assert.deepEqual(preview.workspace.removals, [], '预览不得列出任何待删路径')

  const rewind = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  assert.equal(rewind.ok, true)
  assert.equal(await readText(created), 'NEW', '证明名单不完整 ⇒ 一条都不删（绝不误删未走查子树里的文件）')
})


test('R-42 .git 不进捕获面：整棵进 excludedDirs 留痕，且不进 files', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  await fs.mkdir(path.join(fx.workspaceDir, '.git'), { recursive: true })
  await fs.writeFile(path.join(fx.workspaceDir, '.git', 'index'), 'GIT')
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const payload = captured.point?.workspace.payload
  assert.ok(payload)
  assert.equal(
    (payload?.files ?? []).some((f) => f.path.split(path.sep).includes('.git')),
    false,
    '.git 下的文件不得进快照（回退写回 .git 会让 git 状态错乱，且 .git 会挤掉 maxBytes 预算）',
  )
  assert.ok(
    (payload?.excludedDirs ?? []).some((e) => e.path.endsWith('.git') && e.reason === 'git-dir'),
    '.git 必须如实进 excludedDirs（留痕，不静默）',
  )
  assert.equal(payload?.files.length, 2, '工作区里的两个正常文件照常进快照')
})

test('R-37 清单损坏时**从 records/ 重建**：旧点不丢（而不是拿空清单覆盖掉它们）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const first = await capturePoint(engine, fx)
  assert.equal(first.ok, true)
  const firstId = first.point?.id ?? ''
  const manifestPath = path.join(engine.storeDir, 'index.json')
  // 把清单弄成**读不出来**：readManifest 返回 { entries: [], error }
  await fs.writeFile(manifestPath, '{"schemaVersion": 3, "records": "not-an-array"}')
  const second = await capturePoint(engine, fx, { sessionId: 's-other' })
  assert.equal(second.ok, true, '清单损坏不该阻塞留点（R-16 的既有口径）')
  const after = await engine.list()
  assert.equal(after.error, undefined)
  assert.equal(after.points.length, 2, '旧点必须从 records/ 重建回来，绝不能被空清单覆盖丢掉')
  assert.ok(after.points.some((pt) => pt.id === firstId), '而且就是原来那一条（同 id）')
})

// 折大小写只在 Windows 生效（win32Fold）：Linux 上 `.GIT` 与 `.git` 是两个不同目录，
// 本用例断言的是「不区分大小写的文件系统」下的保护行为，故非 Windows 一律跳过。
test(
  'R-40 拒删判据折大小写：.GIT 子树同样受保护（Windows 文件系统不区分大小写）',
  { skip: process.platform === 'win32' ? false : '折大小写只在 Windows 生效（win32Fold）；Linux 上 .GIT 与 .git 是不同目录' },
  async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  const dir = path.join(fx.workspaceDir, '.GIT')
  await fs.mkdir(dir, { recursive: true })
  const inner = path.join(dir, 'x.txt')
  await fs.writeFile(inner, 'PROTECTED')
  const rewind = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  assert.equal(rewind.ok, true)
  assert.equal(await readText(inner), 'PROTECTED', '.GIT 子树不得被当成「留点后新建」删除')
})

test('R-41 回退期走查也有时间预算：中断只让候选变少（安全方向）并如实标 truncated', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { fork: async () => ({ ok: true, childSessionId: 'child-1' }) })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id ?? ''
  const created = path.join(fx.workspaceDir, 'created-after.txt')
  await fs.writeFile(created, 'NEW')
  // 同一个台账、另一套预算：回退阶段第一个判定点就超时（步进时钟 + 1ms 预算，确定性）
  const fast = makeEngine(fx, {
    captureBudgetMs: 1,
    now: steppingClock(5_000_000, 1),
    fork: async () => ({ ok: true, childSessionId: 'child-1' }),
  })
  const rewind = await fast.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true })
  assert.equal(rewind.ok, true, '走查中断不是失败')
  assert.equal(await readText(created), 'NEW', '中断时宁可少删（绝不因为没走完就当成「可以删」）')
  const ws = rewind.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.createdSkippedTruncated, true, '中断必须如实标 truncated，不谎报「已完整走查」')
})



/* ------------------------------------------------------------------ A+B（2026-10-17）：路径级选择性恢复 + 写入归属隔离 */

test('A-1 路径级选择性恢复：只恢复点名的文件，其余原样保留并如实计数', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id
  assert.ok(id !== undefined)
  const a = path.join(fx.workspaceDir, 'a.txt')
  const b = path.join(fx.workspaceDir, 'src', 'b.txt')
  await fs.writeFile(a, 'A2')
  await fs.writeFile(b, 'B2')
  const result = await engine.rewind({ id, userConfirmed: true, mode: 'files', onlyPaths: [a] })
  assert.equal(result.outcome, 'restored')
  assert.equal(await readText(a), 'A1', '点名的文件被恢复')
  assert.equal(await readText(b), 'B2', '没点名的文件一个字节都不动')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.selectionSkipped, 1, '跳过的条目数必须如实回传')
})

test('A-2 点名一个「既未记录、也不在删除候选」的路径 ⇒ fail-closed 零写入', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id
  assert.ok(id !== undefined)
  const a = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(a, 'A2')
  const result = await engine.rewind({ id, userConfirmed: true, mode: 'files', onlyPaths: [path.join(fx.workspaceDir, 'nope.txt'), a] })
  assert.equal(result.outcome, 'failed')
  // 顶层 code 是既有口径（工作区段失败恒 restore-failed）—— 具体原因逐字在段里，可查
  assert.equal(result.segments[0]?.reasonCode, 'invalid-input')
  assert.equal(result.segments[0]?.detail.some((line) => line.includes('selection-unknown-path')), true)
  assert.equal(result.segments[0]?.restored, 0)
  assert.equal(await readText(a), 'A2', '拒绝时零写入（连点名的那条也不写）')
})

test('B-1 归属隔离：留点后被**别的会话**写过的文件，回退不动它（并如实计数）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id
  assert.ok(id !== undefined)
  const a = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(a, 'A2')
  attr.noteToolCall('session-OTHER', { name: 'write', callId: 'c1', arguments: JSON.stringify({ file_path: a }) })
  const result = await engine.rewind({ id, userConfirmed: true, mode: 'files' })
  assert.equal(result.outcome, 'restored')
  assert.equal(await readText(a), 'A2', '别的会话的改动不被这次回退撤销')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.foreignSkipped, 1)
})

test('B-2 归属是**本会话** / 未判定 ⇒ 照常恢复（未判定绝不当作别的会话写的）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id
  assert.ok(id !== undefined)
  const a = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(a, 'A2')
  // 本会话写的 ⇒ 归属有、但不是「别的会话」⇒ 照常恢复
  attr.noteToolCall('session-1111', { name: 'write', callId: 'c2', arguments: JSON.stringify({ file_path: a }) })
  const result = await engine.rewind({ id, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(a), 'A1')
  assert.equal(result.segments.find((s) => s.state === 'workspace')?.foreignSkipped, undefined)
})

test('B-3 显式点名压过归属隔离：用户明确要它，归属不再拦', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr })
  const captured = await capturePoint(engine, fx)
  const id = captured.point?.id
  assert.ok(id !== undefined)
  const a = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(a, 'A2')
  attr.noteToolCall('session-OTHER', { name: 'write', callId: 'c3', arguments: JSON.stringify({ file_path: a }) })
  const result = await engine.rewind({ id, userConfirmed: true, mode: 'files', onlyPaths: [a] })
  assert.equal(await readText(a), 'A1', '显式点名 = 用户要它，归属隔离不再生效')
  assert.equal(result.segments.find((s) => s.state === 'workspace')?.foreignSkipped, undefined)
})

/* ------------------------------------------------------------------ 跨对话三方合并（2026-10-17） */

const V0_TEXT = 'line1\nline2\nline3\nline4\nline5\n'

test('C-1 A、B 改同一文件的不同区域 ⇒ 撤销 A、保留 B（按最终内容断言）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  // 引擎时钟每次 +1ms ⇒ 三个时刻严格递增（同毫秒会让「目标点之后最早的点」找不到）
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  // A 改第 1 行 ⇒ V1
  const v1 = 'A-changed\nline2\nline3\nline4\nline5\n'
  await fs.writeFile(file, v1)
  // B 的回合开始 ⇒ 它的点内容 = V1（三方合并的 base）
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  // B 改第 5 行 ⇒ V2
  await fs.writeFile(file, 'A-changed\nline2\nline3\nline4\nB-changed\n')
  attr.noteToolCall('session-B', { name: 'write', callId: 'c1', arguments: JSON.stringify({ file_path: file }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), 'line1\nline2\nline3\nline4\nB-changed\n', 'A 的第 1 行被撤销、B 的第 5 行被保留')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.mergedCount, 1)
  assert.equal(segment?.conflictCount, undefined)
})

test('C-2 A、B 改同一行 ⇒ 报冲突、文件保持 B 的版本（绝不自动选边）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'line1\nline2\nA-same\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  const v2 = 'line1\nline2\nB-same\nline4\nline5\n'
  await fs.writeFile(file, v2)
  attr.noteToolCall('session-B', { name: 'write', callId: 'c2', arguments: JSON.stringify({ file_path: file }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), v2, '冲突时一个字节都不写')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.conflictCount, 1)
  assert.deepEqual(segment?.conflictPaths, [file])
})

test('C-3 B 在留点后删除了文件 ⇒ 不重建（theirs-missing，如实报告）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-changed\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.rm(file)
  attr.noteToolCall('session-B', { name: 'write', callId: 'c3', arguments: JSON.stringify({ file_path: file }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  await assert.rejects(fs.stat(file), '别人删掉的文件不得被这次回退悄悄重建')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.unavailableCount, 1)
  assert.equal(segment?.mergedCount, undefined)
})

test('C-4 删除集保护：留点后由别的会话新建/写入的路径不被删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  const created = path.join(fx.workspaceDir, 'other.txt')
  await fs.writeFile(created, 'by B')
  attr.noteToolCall('session-B', { name: 'write', callId: 'c4', arguments: JSON.stringify({ file_path: created }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', removeCreated: true })
  assert.equal(await readText(created), 'by B', '别的会话新建的文件不得被删')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal((segment?.createdSkipped ?? []).includes(created), true)
})

test('C-5 合并之后、写入之前文件又被改过 ⇒ 放弃写入（并发保护）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-changed\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'A-changed\nline2\nline3\nline4\nB-changed\n')
  attr.noteToolCall('session-B', { name: 'write', callId: 'c5', arguments: JSON.stringify({ file_path: file }) })
  // 在「前像暂存」这一步模拟外部再改一次（它紧跟在合并与 needed 判定之后、真正写入之前）
  const self = engine as unknown as { openUndoStager: () => Promise<unknown> }
  const original = self.openUndoStager.bind(engine)
  self.openUndoStager = async () => {
    await fs.writeFile(file, 'EXTERNAL-TOUCH\n')
    return await original()
  }
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), 'EXTERNAL-TOUCH\n', '比我们更新的内容绝不被覆盖')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.concurrentCount, 1)
})

test('C-6 没有中间版本 ⇒ 不写、如实报告（no-base）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  const later = 'line1\nline2\nline3\nline4\nSOMEONE-ELSE\n'
  await fs.writeFile(file, later)
  attr.noteToolCall('session-B', { name: 'write', callId: 'c6', arguments: JSON.stringify({ file_path: file }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), later, '拿不到共同祖先就不动它')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.unavailableCount, 1)
})

test('C-7 对方没改过（theirs==base）⇒ 照常恢复本会话的目标版本', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = new RollbackWriteAttribution({ file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'), flushDelayMs: 0 })
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  const v1 = 'A-changed\nline2\nline3\nline4\nline5\n'
  await fs.writeFile(file, v1)
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  // 归属表明「别的会话碰过它」，但内容其实没变（= base）⇒ 合并结果 = ours ⇒ 照常回退
  attr.noteToolCall('session-B', { name: 'write', callId: 'c7', arguments: JSON.stringify({ file_path: file }) })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), V0_TEXT, '对方没动过 ⇒ 回到目标版本')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.mergedCount, 1)
})

test('C-8 **无归属也要合并**：归属缺失不得退回整文件覆盖（真机 2026-10-17 回归）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 刻意**不传 attribution**：归属可能因为工具白名单 / 跨进程整体覆盖 / 采集时机而整条缺失
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nB-line\n')
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), 'line1\nline2\nline3\nline4\nB-line\n',
    '没有归属证据时也必须三方合并：撤销 A、保留 B，绝不整文件覆盖')
  assert.equal(result.segments[0]?.mergedCount, 1)
  assert.equal(result.segments[0]?.conflictCount, undefined)
})

test('C-9 只有本会话的点 ⇒ 保持旧语义（整文件覆盖回目标版本）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A1\nline2\nline3\nline4\nline5\n')
  // 同一个会话的第二个回合点：它**不是**别人的共同祖先，不得拿来当 base
  await capturePoint(engine, fx, { sessionId: 'session-A' })
  await fs.writeFile(file, 'A1\nline2\nline3\nline4\nA2\n')
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), V0_TEXT, '纯本会话回退仍是整文件回到目标版本')
  assert.equal(result.segments[0]?.mergedCount, undefined)
})

test('C-10 删除保护不依赖归属：别的会话点里记录过的路径不删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  const created = path.join(fx.workspaceDir, 'other.txt')
  await fs.writeFile(created, 'by B')
  // B 的回合点记到了这个文件（= 它确实在留点之后被别人的回合捕获过）
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', removeCreated: true })
  assert.equal(await readText(created), 'by B', '别人碰过的文件不得被删（不依赖归属台账）')
  assert.equal((result.segments[0]?.createdSkipped ?? []).includes(created), true)
})

test('C-11 预览与执行同口径：别人的那行不得算成「会被删」', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nB-line\n')
  const preview = await engine.preview(idA)
  const row = (preview.workspace?.files ?? []).find((item) => item.path === file)
  assert.ok(row !== undefined, '该文件必须出现在「会被改动」清单里')
  assert.equal(row?.skipped, undefined, '能合并且确实要写 ⇒ 不是「不会改动」')
  // 只涉及 A 的那一行：写回 line1（+1）、删掉 A-line（−1）；B 的 B-line 一个字都不算
  assert.equal(row?.added, 1)
  assert.equal(row?.removed, 1)
})

test('C-12 预览标注「不会改动」：冲突文件的差异不给数字（不谎报会被改）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'line1\nline2\nA-same\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'line1\nline2\nB-same\nline4\nline5\n')
  const preview = await engine.preview(idA)
  const row = (preview.workspace?.files ?? []).find((item) => item.path === file)
  assert.equal(row?.skipped, true, '冲突 ⇒ 预览必须标「不会改动」')
  assert.equal(row?.added, null, '「不改动」不是「0 行变化」')
  assert.equal(row?.removed, null)
  assert.equal(typeof row?.mergeReason, 'string')
})

test('D-1 单文件差异与执行同口径：「回退后」一侧是合并结果，不是记录原文', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nB-line\n')
  const diff = await engine.fileDiff(idA, file)
  assert.equal(diff.ok, true)
  assert.equal(diff.merged, true, '「回退后」必须标成合并结果')
  assert.equal(diff.mergeSkipped, undefined)
  assert.equal(diff.added, 1, '只涉及 A 那一行')
  assert.equal(diff.removed, 1)
  assert.equal(diff.after.lines, 5, '合并结果仍是 5 行（B 那一行还在）')
})

test('D-2 冲突时单文件差异说「不会改动」：两侧相同、不给假的覆盖差异', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'line1\nline2\nA-same\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'line1\nline2\nB-same\nline4\nline5\n')
  const diff = await engine.fileDiff(idA, file)
  assert.equal(diff.mergeSkipped, true, '冲突 ⇒ 必须说「不会改动」')
  assert.equal(diff.merged, undefined)
  assert.equal(diff.identical, true, '「回退后」= 现状 ⇒ 两侧一致（不是「覆盖成记录原文」）')
  assert.equal(typeof diff.mergeReason, 'string')
})

test('E-1 合并结论若等于现状 ⇒ 报「无法安全撤销」，绝不静默当成「无需改动」', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.workspaceDir, 'a.txt')
  // V0（目标点）→ A 改动 → B 改动 → 之后又出现「两改动都在」的更晚快照（别的会话）
  await fs.writeFile(file, V0_TEXT)
  const pa = await capturePoint(engine, fx, { sessionId: 'session-A' })
  const idA = pa.point?.id
  assert.ok(idA !== undefined)
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nline5\n')
  await capturePoint(engine, fx, { sessionId: 'session-B' })
  await fs.writeFile(file, 'A-line\nline2\nline3\nline4\nB-line\n')
  // 目标点之后、别的会话的一份**更晚**快照，其内容把两个改动都包含进去（真机里的 base 来源）
  await capturePoint(engine, fx, { sessionId: 'session-C' })
  // 现在磁盘上只剩 B 的改动（模拟「A 已被回退」之后的状态）
  const theirs = 'line1\nline2\nline3\nline4\nB-line\n'
  await fs.writeFile(file, theirs)
  const preview = await engine.preview(idA)
  const row = (preview.workspace?.files ?? []).find((item) => item.path === file)
  assert.equal(row?.skipped, true, '必须如实标「不会改动」，而不是显示成 0 个文件')
  assert.equal(row?.mergeReason, 'ambiguous')
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files' })
  assert.equal(await readText(file), theirs, '无法安全撤销 ⇒ 一个字节都不写')
  const segment = result.segments.find((s) => s.state === 'workspace')
  assert.equal(segment?.unavailableCount, 1)
})
