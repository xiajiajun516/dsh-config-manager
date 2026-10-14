/**
 * 回滚点台账**存储层**单测（issue #89）：账本 v3 = 小清单 + 单条记录文件 + 内容寻址载荷。
 *
 * 覆盖（对应交付物的 8 条required测试）：
 *  - L-01 清单不含大数组（序列化字节数与文件条目数无关）
 *  - L-02 载荷去重（同一工作区态只落一份）
 *  - L-03 引用解析逐字段相等；载荷缺失 / 哈希不符一律如实失败（绝不返回半个记录）
 *  - L-04 v2 单文件**流式**迁移 + 中断可重试且不产生重复
 *  - L-05 字节预算只淘汰最旧 auto（guard / protected 保留，evicted 计数正确）
 *  - L-06 孤儿原子写 tmp 清理（判不准就不删）
 *  - L-07 purgeLedger（删自动点 + 回收载荷与对象；拒绝路径不静默）
 *  - L-08 内存护栏（单次留点不读别人的记录文件；堆增长不随账本呈线性放大）
 *
 * 纪律：真实临时目录 + 真实读写（与 rollback-point.test.ts 同款）；不 mock 文件系统。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  isRollbackPointRecord,
  RollbackPointEngine,
  ROLLBACK_POINTS_DIR_NAME,
  summarizeRollbackPoint,
  type RollbackEngineOptions,
  type RollbackPointRecord,
  type RollbackSessionPayload,
  type RollbackTrack,
  type RollbackWorkspaceFile,
  type RollbackWorkspacePayload,
} from './rollback-point.ts'
import {
  cleanupOrphanTempFiles,
  RollbackLedger,
  ROLLBACK_DEFAULT_LEDGER_BYTES,
  ROLLBACK_LEDGER_BACKUP_NAME,
  ROLLBACK_LEDGER_SCHEMA_VERSION,
  type RollbackLedgerManifestEntry,
  type RollbackLedgerOptions,
} from './rollback-ledger.ts'
import { sha256Hex } from '../utils/hashing.ts'

/* --------------------------------------------------------------- fixture */

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  storeDir: string
  sessionsDir: string
  unitDir: string
  logFile: string
  workspaceDir: string
  cleanup: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  // realpath：Windows/macOS 的 os.tmpdir() 可能是未规范化拼写，而引擎内部一律 realpath
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-ledger-')))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const storeDir = path.join(dataDir, ROLLBACK_POINTS_DIR_NAME)
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
    root, homeDir, dataDir, storeDir, sessionsDir, unitDir, logFile, workspaceDir,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
  }
}

function makeEngine(fx: Fixture, overrides: Partial<RollbackEngineOptions> = {}): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0, ...overrides })
}

function makeLedger(storeDir: string, overrides: Partial<RollbackLedgerOptions> = {}): RollbackLedger {
  return new RollbackLedger({
    root: storeDir,
    summarize: summarizeRollbackPoint,
    isLedgerRecord: isRollbackPointRecord,
    ...overrides,
  })
}

/* --------------------------------------------------- 合成记录（纯内存） */

function makeFiles(root: string, seed: string, count: number): RollbackWorkspaceFile[] {
  const out: RollbackWorkspaceFile[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({
      path: root + path.sep + 'f' + String(i) + '-' + seed,
      chunk: root,
      bytes: 8 + (i % 97),
      sha256: sha256Hex(seed + ':' + String(i)),
      mtimeMs: 1_700_000_000_000 + i,
      object: sha256Hex('obj:' + seed + ':' + String(i)),
    })
  }
  return out
}

function makeWorkspacePayload(root: string, seed: string, count: number): RollbackWorkspacePayload {
  const files = makeFiles(root, seed, count)
  let bytes = 0
  for (const file of files) bytes += file.bytes
  return {
    chunks: [root],
    files,
    skipped: [],
    excludedDirs: [],
    unreadableDirs: [],
    unreadableFiles: [],
    skippedCount: 0,
    skippedTruncated: false,
    ignoredDirs: [],
    ignoredDirCount: 0,
    truncated: false,
    bytes,
    pathIndex: null,
  }
}

function makeSessionPayload(sessionId: string, turnSeq: number): RollbackSessionPayload {
  return {
    sessionId,
    logPath: null,
    cursorSeq: turnSeq * 3,
    cursorBytes: 64,
    mtimeMs: 1_700_000_000_000,
    fingerprintKind: 'cursor',
    fingerprint: 'fp-' + String(turnSeq),
    object: null,
    bytes: 64,
    turnSeq,
    boundarySeq: turnSeq * 3 - 1,
    boundaryEndSeq: turnSeq * 3 + 2,
  }
}

interface RecordOptions {
  id: string
  createdAt: number
  root: string
  kind?: 'auto' | 'guard'
  protected?: boolean
  files?: number
  seed?: string
  sessionId?: string | null
  turnSeq?: number
  workspaceOk?: boolean
}

function makeRecord(opts: RecordOptions): RollbackPointRecord {
  const seed = opts.seed ?? opts.id
  const sessionId = opts.sessionId === undefined ? 'session-1' : opts.sessionId
  const turnSeq = opts.turnSeq ?? 1
  const payload = opts.workspaceOk === false ? null : makeWorkspacePayload(opts.root, seed, opts.files ?? 2)
  const sessionPayload = sessionId === null ? null : makeSessionPayload(sessionId, turnSeq)
  const workspace: RollbackTrack<RollbackWorkspacePayload> = {
    kind: 'workspace',
    capturedAt: opts.createdAt,
    ok: payload !== null,
    degraded: false,
    fingerprint: payload === null ? null : sha256Hex(seed),
    reasonCode: payload === null ? 'capture-failed' : null,
    reasonDetail: null,
    payload,
  }
  const session: RollbackTrack<RollbackSessionPayload> = {
    kind: 'session',
    capturedAt: opts.createdAt + 5,
    ok: sessionPayload !== null,
    degraded: false,
    fingerprint: sessionPayload === null ? null : sessionPayload.fingerprint,
    reasonCode: sessionPayload === null ? 'session-missing' : null,
    reasonDetail: null,
    payload: sessionPayload,
  }
  return {
    schemaVersion: 2,
    id: opts.id,
    kind: opts.kind ?? 'auto',
    createdAt: opts.createdAt,
    spreadMs: 5,
    protected: opts.protected === true,
    incomplete: !(workspace.ok && session.ok),
    note: null,
    sessionId,
    unitId: sessionId === null ? null : 'proj-key/' + sessionId,
    turnSeq: sessionPayload === null ? null : sessionPayload.turnSeq,
    boundarySeq: sessionPayload === null ? null : sessionPayload.boundarySeq,
    workspace,
    session,
  }
}

/** 按真实写入路径落一条记录并推进清单（与引擎 appendRecord 的核心两步一致） */
async function writeRecord(ledger: RollbackLedger, record: RollbackPointRecord, entries: RollbackLedgerManifestEntry[]): Promise<RollbackLedgerManifestEntry> {
  const prepared = ledger.prepareRecord(record)
  await ledger.writePrepared(prepared)
  entries.push(prepared.entry)
  await ledger.writeManifest(entries)
  return prepared.entry
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}

/* ============================================================ L-01 */

test('L-01 清单不含大数组：index.json 字节数与文件条目数无关（3 条 × 2000 文件 < 64 KiB）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const ledger = makeLedger(fx.storeDir)
  const entries: RollbackLedgerManifestEntry[] = []
  for (let i = 0; i < 3; i += 1) {
    await writeRecord(ledger, makeRecord({ id: 'rb-big-' + String(i), createdAt: 1000 + i, root: fx.workspaceDir, files: 2000 }), entries)
  }
  const manifestPath = path.join(fx.storeDir, 'index.json')
  const text = await fs.readFile(manifestPath, 'utf8')
  const size = Buffer.byteLength(text, 'utf8')
  assert.ok(size < 64 * 1024, 'index.json 必须 < 64 KiB，实测 ' + String(size) + ' 字节')
  assert.equal(text.includes('"files"'), false, '清单里绝不含 workspace.files 这类大数组')
  const parsed = await readJson(manifestPath) as { schemaVersion: number; records: unknown[] }
  assert.equal(parsed.schemaVersion, ROLLBACK_LEDGER_SCHEMA_VERSION)
  assert.equal(parsed.records.length, 3)
  // 大数组只是**搬到**内容寻址载荷里，不是丢掉了
  assert.deepEqual(await listNames(path.join(fx.storeDir, 'payloads')), entries.map((e) => e.workspace.payload + '.json').sort())

  // 对照：条目数 2000 -> 20 时清单几乎不变（字节数与文件数**无关**）
  const fx2 = await makeFixture()
  t.after(fx2.cleanup)
  const ledger2 = makeLedger(fx2.storeDir)
  const entries2: RollbackLedgerManifestEntry[] = []
  for (let i = 0; i < 3; i += 1) {
    await writeRecord(ledger2, makeRecord({ id: 'rb-small-' + String(i), createdAt: 1000 + i, root: fx2.workspaceDir, files: 20 }), entries2)
  }
  const size2 = Buffer.byteLength(await fs.readFile(path.join(fx2.storeDir, 'index.json'), 'utf8'), 'utf8')
  assert.ok(size - size2 < 1024, '清单字节数必须与文件条目数无关（差 ' + String(size - size2) + ' 字节）')
})

/* ============================================================ L-02 */

test('L-02 载荷去重：同一 workspace 载荷写两次 -> payloads/ 只有一个文件', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const ledger = makeLedger(fx.storeDir)
  const entries: RollbackLedgerManifestEntry[] = []
  const first = makeRecord({ id: 'rb-dedupe-a', createdAt: 1000, root: fx.workspaceDir, files: 50, seed: 'same' })
  const second = makeRecord({ id: 'rb-dedupe-b', createdAt: 2000, root: fx.workspaceDir, files: 50, seed: 'same' })
  assert.deepEqual(first.workspace.payload, second.workspace.payload, '前提：两条记录的工作区态逐字段相同')
  await writeRecord(ledger, first, entries)
  const payloadsDir = path.join(fx.storeDir, 'payloads')
  assert.equal((await listNames(payloadsDir)).length, 1)
  await writeRecord(ledger, second, entries)
  assert.equal((await listNames(payloadsDir)).length, 1, '同一工作区态只落一份载荷')
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).length, 2, '记录文件是两条（元数据各一份）')

  // 引擎级：连续两个回合工作区未变 ⇒ 载荷目录零新增（零额外字节）
  const fx3 = await makeFixture()
  t.after(fx3.cleanup)
  const engine = makeEngine(fx3)
  const capture = async (): Promise<void> => {
    const res = await engine.capturePoint({
      chunks: [fx3.workspaceDir],
      sessionId: 'session-1111',
      unitId: 'proj-key/session-1111',
      sessionLogPath: fx3.logFile,
      cursorSeq: 3,
      turnSeq: 2,
      boundarySeq: 1,
      boundaryEndSeq: 6,
    })
    assert.equal(res.ok, true, String(res.detail ?? ''))
  }
  await capture()
  const enginePayloads = path.join(fx3.storeDir, 'payloads')
  const before = await listNames(enginePayloads)
  await capture()
  assert.ok(before.length >= 1)
  assert.deepEqual(await listNames(enginePayloads), before, '工作区未变时第二个回合必须零新增载荷')
})

/* ============================================================ L-03 */

test('L-03 引用解析：readRecord 逐字段还原；载荷缺失 / 哈希不符一律明确失败', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const ledger = makeLedger(fx.storeDir)
  const record = makeRecord({ id: 'rb-ref-1', createdAt: 1000, root: fx.workspaceDir, files: 30 })
  const prepared = ledger.prepareRecord(record)
  await ledger.writePrepared(prepared)
  await ledger.writeManifest([prepared.entry])

  const resolved = await ledger.readRecord(record.id)
  assert.equal(resolved.error, undefined, String(resolved.error ?? ''))
  assert.deepEqual(resolved.record, record, '读回来必须与写入时**逐字段相等**')

  // 载荷被删 ⇒ 明确失败（绝不返回半个记录）
  const payloadFile = path.join(fx.storeDir, 'payloads', String(prepared.payloadHash) + '.json')
  await fs.rm(payloadFile)
  const missing = await ledger.readRecord(record.id)
  assert.equal(missing.record, undefined, '载荷缺失时绝不能返回一个 workspace.payload=null 的半个记录')
  assert.ok((missing.error ?? '').startsWith('record-incomplete'), String(missing.error ?? ''))

  // 载荷被改（哈希不符）⇒ 同样明确失败
  await fs.writeFile(payloadFile, '{"chunks":[],"files":[]}')
  const mismatched = await ledger.readRecord(record.id)
  assert.equal(mismatched.record, undefined)
  assert.ok((mismatched.error ?? '').includes('hash mismatch'), String(mismatched.error ?? ''))

  // 引擎侧同样如实失败：preview / rewind 报 record-incomplete，且零写入
  const fx2 = await makeFixture()
  t.after(fx2.cleanup)
  const engine = makeEngine(fx2)
  const captured = await engine.capturePoint({ chunks: [fx2.workspaceDir], sessionId: 'session-1111', sessionLogPath: fx2.logFile, turnSeq: 2, boundarySeq: 1 })
  const id = captured.point?.id ?? ''
  await fs.writeFile(path.join(fx2.workspaceDir, 'a.txt'), 'A2')
  const meta = JSON.parse(await fs.readFile(path.join(fx2.storeDir, 'records', id + '.json'), 'utf8')) as { workspace: { payload: string } }
  await fs.rm(path.join(fx2.storeDir, 'payloads', meta.workspace.payload + '.json'))
  const preview = await engine.preview(id)
  assert.equal(preview.ok, false)
  assert.equal(preview.code, 'record-incomplete')
  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off' })
  assert.equal(rewound.outcome, 'failed')
  assert.equal(rewound.code, 'record-incomplete')
  assert.equal(await fs.readFile(path.join(fx2.workspaceDir, 'a.txt'), 'utf8'), 'A2', '记录读不全 ⇒ 零写入')
})

/* ============================================================ L-04 */

/** 造一个 v2 单文件台账（schemaVersion 2 + records 数组） */
async function writeV2Ledger(storeDir: string, records: RollbackPointRecord[]): Promise<string> {
  const manifestPath = path.join(storeDir, 'index.json')
  await fs.mkdir(storeDir, { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, records }, null, 2))
  return manifestPath
}

test('L-04 v2 单文件流式迁移：list 逐条一致、旧文件改名保留；中断可重试且不产生重复', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const records = [
    makeRecord({ id: 'rb-v2-a', createdAt: 1000, root: fx.workspaceDir, files: 3, turnSeq: 1 }),
    makeRecord({ id: 'rb-v2-big', createdAt: 2000, root: fx.workspaceDir, files: 3000, turnSeq: 2 }),
    makeRecord({ id: 'rb-v2-c', createdAt: 3000, root: fx.workspaceDir, files: 5, kind: 'guard', turnSeq: 3 }),
  ]
  const manifestPath = await writeV2Ledger(fx.storeDir, records)
  const v2Bytes = await fs.readFile(manifestPath)

  // ① 注入写失败（第 3 次写开始全失败）⇒ 迁移中断、原文件**一动不动**
  let writes = 0
  const failing = makeLedger(fx.storeDir, {
    writeFile: async (target, bytes) => {
      writes += 1
      if (writes >= 3) throw new Error('injected write failure')
      await fs.writeFile(target, bytes)
    },
  })
  const failed = await failing.migrateIfNeeded()
  assert.notEqual(failed.error, undefined, '注入写失败后必须如实回报错误')
  assert.deepEqual(await fs.readFile(manifestPath), v2Bytes, '迁移失败 ⇒ 原文件一个字节都不许动')
  assert.deepEqual(await listNames(path.join(fx.storeDir, ROLLBACK_LEDGER_BACKUP_NAME)).catch(() => []), [], '失败时不留备份名')

  // ② 重启（新引擎 / 新存储层）⇒ 重试成功，且不产生重复
  const engine = makeEngine(fx)
  const listed = await engine.list()
  assert.equal(listed.error, undefined, String(listed.error ?? ''))
  assert.equal(listed.points.length, records.length, '迁移后条数不变')
  const expected = records
    .map((record) => summarizeRollbackPoint(record))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const actual = listed.points.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
  assert.deepEqual(actual, expected, '迁移后 list 的每条摘要必须与 v2 记录逐字段一致')
  assert.equal(new Set(listed.points.map((p) => p.id)).size, records.length, '绝不产生重复 id')

  // ③ 旧文件改名保留 + 清单变 v3（且不含大数组）
  assert.deepEqual(await fs.readFile(path.join(fx.storeDir, ROLLBACK_LEDGER_BACKUP_NAME)), v2Bytes, '旧 v2 文件逐字节保留')
  const manifestText = await fs.readFile(manifestPath, 'utf8')
  assert.equal(manifestText.includes('"files"'), false, '迁移后的清单里绝不含大数组')
  assert.ok(Buffer.byteLength(manifestText, 'utf8') < 64 * 1024)
  const manifest = JSON.parse(manifestText) as { schemaVersion: number; records: unknown[] }
  assert.equal(manifest.schemaVersion, ROLLBACK_LEDGER_SCHEMA_VERSION)
  assert.equal(manifest.records.length, records.length)
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).length, records.length)

  // ④ 幂等：再建一个引擎（又一次启动）不会重复迁移
  const again = makeEngine(fx)
  const second = await again.list()
  assert.equal(second.points.length, records.length)
  assert.equal(second.error, undefined)
})

/* ============================================================ L-05 */

test('L-05 字节预算：只淘汰最旧 auto，guard / protected 保留，evicted 计数正确', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { ledgerBytesBudget: 1, maxRecords: 50, maxRecordsPerSession: 50 })
  const capture = async (extra: Record<string, unknown>): Promise<string> => {
    const res = await engine.capturePoint({ chunks: [fx.workspaceDir], sessionId: 's-budget', sessionLogPath: fx.logFile, ...extra })
    assert.equal(res.ok, true, String(res.detail ?? ''))
    return res.point?.id ?? ''
  }
  const auto1 = await capture({ turnSeq: 1, seed: 'a1' } as Record<string, unknown>)
  const guard1 = await capture({ kind: 'guard', turnSeq: 2 })
  const protected1 = await capture({ protect: true, turnSeq: 3 })
  const auto2 = await capture({ turnSeq: 4 })
  const auto3 = await capture({ turnSeq: 5 })

  const listed = await engine.list()
  const ids = listed.points.map((p) => p.id)
  assert.equal(ids.includes(auto1), false, '最旧的 auto 必须被字节预算淘汰')
  assert.equal(ids.includes(auto2), false, '次旧的 auto 也会被淘汰（预算极小）')
  assert.equal(ids.includes(auto3), true, '最新 auto 保留（本次写入的那一条不参与本轮淘汰）')
  assert.equal(ids.includes(guard1), true, 'guard 不受字节预算淘汰')
  assert.equal(ids.includes(protected1), true, 'protected 永不淘汰')

  const status = await engine.storageStatus()
  assert.equal(status.available, true)
  assert.equal(status.ledger?.budgetBytes, 1)
  assert.equal(status.ledger?.evicted, 2, 'evicted 必须精确等于被预算淘汰的自动点数')
  assert.equal(status.ledger?.records, 3)

  // 淘汰的记录文件与无人引用的载荷必须真的从磁盘消失
  const recordNames = await listNames(path.join(fx.storeDir, 'records'))
  assert.equal(recordNames.includes(auto1 + '.json'), false)
  assert.equal(recordNames.includes(auto2 + '.json'), false)
  assert.equal(recordNames.includes(auto3 + '.json'), true)
  assert.equal(recordNames.includes(guard1 + '.json'), true)

  // 缺省预算就是导出的常量（不注入时生效）
  const def = makeEngine(fx, { maxRecords: 1 })
  assert.equal(ROLLBACK_DEFAULT_LEDGER_BYTES, 256 * 1024 * 1024)
  assert.equal((await def.storageStatus()).ledger?.budgetBytes, ROLLBACK_DEFAULT_LEDGER_BYTES)
})

/* ============================================================ L-09 */

/**
 * L-09（issue #89 可观测性）：预算淘汰累计数**必须持久化**。
 *
 * 为什么：宿主每个 HTTP 请求都新建一个引擎（路由侧），只记在实例上的话这个数字永远是 0 ——
 * 界面就永远看不到「已经因为预算淘汰过 N 个」。判据 = 换一个全新实例读同一个 storeDir，
 * 计数必须仍在，而且**只增不减**（读清单不得把计数抹回去）。
 */
test('L-09 预算淘汰累计数持久化：新实例仍读得到，且只增不减', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { ledgerBytesBudget: 1, maxRecords: 50, maxRecordsPerSession: 50 })
  const capture = async (turn: number): Promise<void> => {
    const res = await engine.capturePoint({
      chunks: [fx.workspaceDir], sessionId: 's-persist', sessionLogPath: fx.logFile, turnSeq: turn,
    })
    assert.equal(res.ok, true, String(res.detail ?? ''))
  }
  await capture(1)
  await capture(2)
  await capture(3)

  const first = await engine.storageStatus()
  const evicted = first.ledger?.evicted ?? 0
  assert.ok(evicted > 0, '本用例必须先真的发生淘汰（否则测不到东西）')

  // 全新实例（= 路由每请求新建引擎的场景）：计数必须还在
  const fresh = makeEngine(fx, { ledgerBytesBudget: 1 })
  assert.equal((await fresh.storageStatus()).ledger?.evicted, evicted, '计数必须随清单落盘，跨实例可见')
  // 只增不减：再读一次不得回退
  assert.equal((await fresh.storageStatus()).ledger?.evicted, evicted)
})


/* ============================================================ L-06 */

test('L-06 孤儿 tmp 清理：只删形状可自证的崩溃残留，返回字节数正确', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  await fs.mkdir(fx.storeDir, { recursive: true })
  // ① 真形态（atomic-write.ts tmpPath()：.dshcm.<base>.<pid>.<16hex>.tmp）+ 一个几乎不可能存在的 pid
  const orphan = path.join(fx.storeDir, '.dshcm.index.json.2147483646.0123456789abcdef.tmp')
  await fs.writeFile(orphan, 'x'.repeat(1234))
  // ② 形态合法但 pid 是本进程 ⇒ 可能正在写，绝不删
  const own = path.join(fx.storeDir, '.dshcm.index.json.' + String(process.pid) + '.fedcba9876543210.tmp')
  await fs.writeFile(own, 'y'.repeat(10))
  // ③ 名字不符合规则（不是 16 位 hex）⇒ 连候选都不算
  const bogus = path.join(fx.storeDir, '.dshcm.index.json.4242.zzzz.tmp')
  await fs.writeFile(bogus, 'zz')
  // ④ 普通文件绝不能被误伤
  const keeper = path.join(fx.storeDir, 'index.json')
  await fs.writeFile(keeper, '{"schemaVersion":3,"records":[]}')

  const result = await cleanupOrphanTempFiles(fx.storeDir)
  assert.equal(result.removed, 1)
  assert.equal(result.bytes, 1234)
  assert.equal(result.skipped, 1, '形似但判据不足（本进程 pid）的必须计入 skipped 且不删')
  await assert.rejects(fs.stat(orphan), { code: 'ENOENT' })
  assert.equal((await fs.stat(own)).size, 10, '本进程的 tmp 绝不删')
  assert.equal((await fs.stat(bogus)).size, 2, '名字不合规则的一律不删')
  assert.equal(await fs.readFile(keeper, 'utf8'), '{"schemaVersion":3,"records":[]}')

  // 启动期（引擎惰性初始化）会真的调用它 —— 残留必须在第一次用到引擎时消失
  const fx2 = await makeFixture()
  t.after(fx2.cleanup)
  await fs.mkdir(fx2.storeDir, { recursive: true })
  const residue = path.join(fx2.storeDir, '.dshcm.index.json.2147483645.aaaaaaaaaaaaaaaa.tmp')
  await fs.writeFile(residue, 'r'.repeat(64))
  const engine = makeEngine(fx2)
  await engine.storageStatus()
  await assert.rejects(fs.stat(residue), { code: 'ENOENT' })
})

/* ============================================================ L-07 */

test('L-07 purgeLedger：删自动点并回收载荷与对象，guard / protected 保留；拒绝路径不静默', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { maxRecords: 50, maxRecordsPerSession: 50 })
  const capture = async (extra: Record<string, unknown>): Promise<string> => {
    const res = await engine.capturePoint({ chunks: [fx.workspaceDir], sessionId: 's-purge', sessionLogPath: fx.logFile, ...extra })
    assert.equal(res.ok, true, String(res.detail ?? ''))
    return res.point?.id ?? ''
  }
  // 让每个点的工作区态**互不相同** ⇒ 载荷文件各一份，才能验证「无人引用的载荷真的被回收」
  const guard1 = await capture({ kind: 'guard', turnSeq: 1 })
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const auto1 = await capture({ turnSeq: 2 })
  await fs.writeFile(path.join(fx.workspaceDir, 'src', 'b.txt'), 'B2')
  const auto2 = await capture({ turnSeq: 3 })
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A3')
  const protected1 = await capture({ protect: true, turnSeq: 4 })

  const objectsDir = path.join(fx.storeDir, 'objects')
  assert.ok((await listNames(objectsDir)).length > 0)
  assert.equal((await listNames(path.join(fx.storeDir, 'payloads'))).length, 4, '四个不同的工作区态 ⇒ 四份载荷')

  const purged = await engine.purgeLedger()
  assert.equal(purged.removedRecords, 2, '两个自动点被删')
  assert.ok(purged.bytes > 0, '必须如实回报释放字节')
  assert.equal(purged.removedPayloads, 2, '只被删掉的自动点引用的载荷文件必须回收')
  assert.equal((await listNames(path.join(fx.storeDir, 'payloads'))).length, 2, '仍被 guard/protected 引用的载荷绝不能被删')
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).includes(auto1 + '.json'), false, 'auto1 记录文件必须消失')
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).includes(auto2 + '.json'), false, 'auto2 记录文件必须消失')
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).includes(guard1 + '.json'), true)

  const afterFirst = await engine.list()
  const ids = afterFirst.points.map((p) => p.id)
  assert.deepEqual(ids.slice().sort(), [guard1, protected1].sort(), 'guard 与 protected 必须保留')
  // guard 的载荷还有引用 ⇒ 不能删；auto 的载荷没人引用 ⇒ 必须删
  const payloadNames = await listNames(path.join(fx.storeDir, 'payloads'))
  assert.equal(payloadNames.length, afterFirst.points.length, '载荷文件数必须等于仍被引用的记录数')

  // includeGuards=true ⇒ 连 guard 一起删，但 protected 永不删
  const purged2 = await engine.purgeLedger({ includeGuards: true })
  assert.equal(purged2.removedRecords, 1)
  const afterSecond = await engine.list()
  assert.deepEqual(afterSecond.points.map((p) => p.id), [protected1])
  assert.equal((await listNames(path.join(fx.storeDir, 'records'))).length, 1)

  // 拒绝路径：清单读不出来 ⇒ 抛带 code 的错误，一个字节都不动
  const fx2 = await makeFixture()
  t.after(fx2.cleanup)
  const engine2 = makeEngine(fx2)
  await engine2.capturePoint({ chunks: [fx2.workspaceDir], sessionId: 'session-1111', sessionLogPath: fx2.logFile })
  const broken = path.join(fx2.storeDir, 'index.json')
  await fs.writeFile(broken, '{ broken-json')
  const recordsBefore = await listNames(path.join(fx2.storeDir, 'records'))
  await assert.rejects(
    engine2.purgeLedger(),
    (error: unknown) => (error as { code?: string }).code === 'ledger-unreadable',
  )
  assert.deepEqual(await listNames(path.join(fx2.storeDir, 'records')), recordsBefore, '拒绝路径必须零写入')
  assert.equal(await fs.readFile(broken, 'utf8'), '{ broken-json')
})

/* ============================================================ L-08 */

test('L-08 内存护栏：单次留点不读别人的记录文件；堆增长不随账本线性放大', async (t) => {
  // ① 确定性证据：一次 append 只读清单（index.json），**绝不**读任何记录文件或载荷文件
  const fx = await makeFixture()
  t.after(fx.cleanup)
  let reads: string[] = []
  const isLedgerBodyRead = (file: string): boolean => file.includes(path.sep + 'records' + path.sep) || file.includes(path.sep + 'payloads' + path.sep)
  const engines = makeEngine(fx, { maxRecords: 1000, maxRecordsPerSession: 1000, ledgerReadFile: (file) => reads.push(file) })
  for (let i = 0; i < 12; i += 1) {
    reads = []
    const res = await engines.capturePoint({
      chunks: [fx.workspaceDir], sessionId: 's-read', sessionLogPath: fx.logFile, turnSeq: i + 1, boundarySeq: i,
    })
    assert.equal(res.ok, true, String(res.detail ?? ''))
    // 一次留点只读**清单**：读任何记录文件/载荷文件都是 issue #89 要消灭的那条路
    assert.deepEqual(reads.filter(isLedgerBodyRead), [], '一次留点读了记录/载荷文件：' + reads.join(','))
  }
  reads = []
  await engines.list()
  assert.deepEqual(reads.filter((file) => file.includes(path.sep + 'records' + path.sep)), [], 'list 必须只读清单（一个记录文件都不读）')
  reads = []
  await engines.storageStatus()
  assert.deepEqual(reads.filter(isLedgerBodyRead), [], 'storageStatus 也不许读记录/载荷')

  // ② 近似护栏（真正防回归的是上面那条确定性断言）：**同一次 append** 的堆增量与账本规模无关。
  //    为什么这样判：旧实现每个回合都要把整份台账 JSON 读进内存再 parse ⇒ 单次 append 的堆增量
  //    ∝ 账本总字节（本机 50 条 = 473 MB 时直接 OOM）。新实现单次 append 只驻留「这一条载荷 + 清单」，
  //    所以 200 条账本里的那次 append 应当与 5 条账本里的那次同量级。
  //    阈值取 4 倍 + 8 MiB（宽松）：V8 的垃圾回收时机不可控，用 3 次取最小来抵消抖动；
  //    而「线性放大」在这里是 40 倍（200/5），4 倍阈值足以区分二者，又不会因抖动假红。
  const small = await measureAppendHeap(5, 2000)
  const big = await measureAppendHeap(200, 2000)
  assert.equal(big.entries, 203, '大账本场景必须真的攒下 200 条（否则测的不是大账本）')
  // small.min 可能是负数（这一次 append 期间 V8 顺手回收了垃圾）：负增量按 0 处理，避免把阈值算成负数
  const smallFloor = Math.max(small.min, 0)
  assert.ok(
    big.min <= smallFloor * 4 + 8 * 1024 * 1024,
    '单次 append 的堆增量随账本线性放大：small=' + String(small.min) + ' big=' + String(big.min),
  )
  assert.ok(big.min < 32 * 1024 * 1024, '单次 append 的堆增量必须保持在几十 MB 以内（旧实现 = 整份账本），实测 ' + String(big.min))
})

/** 造 count 条记录（每条 files 个文件条目）后，量 3 次 append 的堆增量并取最小值 */
async function measureAppendHeap(count: number, files: number): Promise<{ min: number; entries: number }> {
  const fx = await makeFixture()
  try {
    const ledger = makeLedger(fx.storeDir, { bytesBudget: 1024 * 1024 * 1024 })
    const entries: RollbackLedgerManifestEntry[] = []
    for (let i = 0; i < count; i += 1) {
      await writeRecord(ledger, makeRecord({ id: 'rb-heap-' + String(i), createdAt: 1000 + i, root: fx.workspaceDir, files, seed: 'heap-' + String(i) }), entries)
    }
    let min = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i += 1) {
      const before = process.memoryUsage().heapUsed
      await writeRecord(ledger, makeRecord({ id: 'rb-probe-' + String(i), createdAt: 9000 + i, root: fx.workspaceDir, files, seed: 'probe-' + String(i) }), entries)
      const delta = process.memoryUsage().heapUsed - before
      if (delta < min) min = delta
    }
    return { min, entries: entries.length }
  } finally {
    await fx.cleanup()
  }
}
