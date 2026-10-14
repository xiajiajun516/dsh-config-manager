/**
 * R-7（改写版）：recovery prefix 下 rollback-points 子路径的**接口守卫**。
 *
 * 为什么必须有：引擎有 19 条单测，但接口面此前只有 outputs/ 下的人工探针 ——
 * 409 确认门 / 404 / 405 / 503 / SAFE MODE 一旦在重构中丢失，没有任何红灯。
 *
 * 纪律：
 *  - **真 http server + 真 fetch**（照 t19 的教训：涉及真实字节行为的断言不用替身）。
 *  - 起服只挂 recovery 组的 handler（与生产同一份 recoveryRoutes 产物，只经 kit 的 endpoint 包装）。
 *  - 真实临时 home/dataDir/工作区目录，真读真写：断言「未确认 → 零写入」必须落在**字节**上。
 *  - 回滚点由引擎**按回合自动留点**产生（不再有 capture 子路径）→ 本测试直接用同一个 dataDir
 *    构造引擎留点，再走 HTTP 面（与生产同一条台账）。
 *  - 本组仍是**一条** endpoint 声明（子路径靠 prefix 内部分发）→ 这里直接钉住 routes.length === 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteFile } from '../../src/utils/atomic-write.ts'
import { recoveryRoutes } from '../../src/routes/recovery.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { RollbackPointEngine } from '../../src/core/rollback-point.ts'
import { emptySessionMeta } from '../../src/core/session-meta.ts'
import { isRollbackEnabled, resetRollbackGateForTest } from '../../src/core/rollback-gate.ts'
import { sha256Hex } from '../../src/utils/hashing.ts'

const BASE = '/api/dsh-config-manager/recovery'
const PROJECT_KEY = '--p--'
const SESSION_ID = 'session-abc'
const LOG_NAME = 'session.v4.jsonl.zstd'
const UNIT_ID = PROJECT_KEY + '/' + SESSION_ID

interface HistoryEntry {
  kind?: string
  result?: string
  summary?: string
  error?: string
}

interface Harness {
  root: string
  homeDir: string
  dataDir: string
  workspaceDir: string
  logFile: string
  history: HistoryEntry[]
  safeMode: { blocked: boolean }
  forkCalls: { sessionId: string; boundarySeq: number }[]
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  // issue #69 口径：os.tmpdir() 在部分平台给的是**未规范化**的拼写 —— 夹具的根必须先 realpath，
  // 否则断言比的是「同一个目录的两种写法」（CI 上 windows/macos 必红，本机不复现）。
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-route-')))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const workspaceDir = path.join(root, 'proj')
  const logDir = path.join(homeDir, 'sessions', PROJECT_KEY, SESSION_ID)
  const logFile = path.join(logDir, LOG_NAME)
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.mkdir(logDir, { recursive: true })
  await fs.writeFile(path.join(workspaceDir, 'x.txt'), 'X1')
  await fs.writeFile(logFile, 'LOGBYTES')
  // t8 起：「对话正在运行」（会话日志 mtime 落在引擎静默窗内，缺省 30 s）会让**带工作区段**的回退
  // 在路由层被硬拒（409 session-active，零写入）。本文件测的是**其它**守卫（确认门 / 保护点 /
  // SAFE MODE / 救援点 / 存储降级），所以夹具统一代表「对话不在运行」—— 把日志 mtime 拨到静默窗外。
  // 运行中的口径由本文件末尾的 R8-9 与 src/routes/recovery.test.ts 的 t8 用例覆盖。
  const aged = new Date(Date.now() - 120_000)
  await fs.utimes(logFile, aged, aged)
  return {
    root, homeDir, dataDir, workspaceDir, logFile,
    history: [], safeMode: { blocked: false }, forkCalls: [],
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** 按回合自动留点：用同一个 dataDir 构造引擎（与路由侧共用同一份台账）。 */
async function makePoint(h: Harness, extra: Record<string, unknown> = {}): Promise<string> {
  const engine = new RollbackPointEngine({ dataDir: h.dataDir, homeDir: h.homeDir, sessionQuiescentMs: 0 })
  const result = await engine.capturePoint({
    chunks: [h.workspaceDir],
    sessionId: SESSION_ID,
    unitId: UNIT_ID,
    sessionLogPath: h.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
    ...extra,
  })
  assert.equal(result.ok, true, result.detail ?? result.code)
  return result.point?.id ?? ''
}

/** 锁端口替身：恒 ACQUIRED（锁机制本身由 env-lock 自测覆盖；这里只让写路径能走通）。 */
function lockPort(): unknown {
  return {
    acquire: async () => ({
      state: 'ACQUIRED' as const,
      token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() },
    }),
    validate: () => true,
    release: async () => {},
  }
}

function envFor(h: Harness): never {
  const env = {
    dataDir: h.dataDir,
    host: {
      homeDir: h.homeDir,
      profile: 'web',
      mutationLock: lockPort(),
      safeModeIsBlocked: () => h.safeMode.blocked,
      log: { warn: () => {} },
      // S3：宿主会话端口（真实实现是 DshSessionStoreFacade.forkSession → ctx.get('sessions').fork）
      sessions: {
        forkSession: async (sessionId: string, boundarySeq: number) => {
          h.forkCalls.push({ sessionId, boundarySeq })
          return { childSessionId: 'child-' + sessionId }
        },
      },
    },
    sessionHealth: {
      homeDir: h.homeDir,
      targetFormatVersion: () => 4,
      workspaceKeys: async () => new Set<string>(),
      knownSessionIds: async () => new Set<string>(),
      // T4+：体检行补「对话标题」（路由经它与导出选择器共用同一份会话元数据索引）；
      // 这里给空索引 = 读不到 DSH 缓存时的形态（不许在路由层编造标题）。
      sessionMeta: async () => emptySessionMeta(),
    },
    tryAppendHistory: async (raw: HistoryEntry) => { h.history.push(raw); return undefined },
    recoveryOrchestrator: {},
    makeRecoveryExecutors: () => ({}),
  }
  return env as never
}

function recoveryRoute(h: Harness): WebRoute {
  const routes = recoveryRoutes(envFor(h))
  assert.equal(routes.length, 1, 'recovery 组必须仍只有一条 endpoint 声明（路由计数不变）')
  const found = routes.find((r) => routeSpecOf(r)?.path === BASE)
  assert.ok(found !== undefined, 'recovery prefix 路由缺失')
  assert.equal(routeSpecOf(found)?.kind, 'prefix')
  return found
}

interface Server {
  base: string
  call: (sub: string, init?: { method?: string; body?: unknown; raw?: string }) => Promise<{ status: number; json: unknown }>
  close: () => Promise<void>
}

async function startServer(h: Harness): Promise<Server> {
  const route = recoveryRoute(h)
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'server 必须拿到端口')
  const base = 'http://127.0.0.1:' + String(address.port) + BASE
  return {
    base,
    call: async (sub, init) => {
      const request: { method: string; headers?: Record<string, string>; body?: string } = { method: init?.method ?? 'GET' }
      if (init?.body !== undefined || init?.raw !== undefined) {
        request.headers = { 'content-type': 'application/json' }
        request.body = init.raw ?? JSON.stringify(init.body)
      }
      const res = await fetch(base + sub, request)
      let json: unknown = null
      try { json = await res.json() } catch { /* 无体 */ }
      return { status: res.status, json }
    },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()) }) },
  }
}

/* ------------------------------------------------------------- 取值助手 */

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function segmentsOf(json: unknown): { state: string; status: string; reasonCode?: string }[] {
  return arr(obj(json)['segments']).map((item) => {
    const s = obj(item)
    return { state: String(s['state']), status: String(s['status']), ...(s['reasonCode'] !== undefined ? { reasonCode: String(s['reasonCode']) } : {}) }
  })
}
async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8')
}
async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true } catch { return false }
}

/* ============================================================ R8-1 主链 */

test('R8-1 全部子路径可达：列表 / storage / 详情 / 预览 / 回退 / 删除 + 未确认零写入 + 历史留痕', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    // ① GET /rollback-points/storage
    const storage = await server.call('/rollback-points/storage')
    assert.equal(storage.status, 200, JSON.stringify(storage.json))
    assert.equal(obj(storage.json)['available'], true)
    assert.equal(obj(storage.json)['ok'], true)

    // ② GET /rollback-points（空列表）
    const empty = await server.call('/rollback-points')
    assert.equal(empty.status, 200)
    assert.deepEqual(obj(empty.json)['points'], [])
    assert.equal(obj(obj(empty.json)['storage'])['available'], true)
    assert.equal(obj(empty.json)['maxRecords'], 50)
    assert.equal(obj(empty.json)['maxRecordsPerSession'], 20)

    // ③ 按回合自动留点（引擎侧；没有 capture 子路径）
    const id = await makePoint(h)
    assert.notEqual(id, '')
    // 新库目录名 = rollback-points
    assert.equal(await exists(path.join(h.dataDir, 'rollback-points', 'index.json')), true)
    assert.equal(await exists(path.join(h.dataDir, 'checkpoints')), false, '旧库目录名不得再出现')

    // ④ GET /rollback-points/<id>（详情：两态 + 无 config 段）
    const detail = await server.call('/rollback-points/' + id)
    assert.equal(detail.status, 200)
    assert.equal(obj(detail.json)['ok'], true)
    const point = obj(obj(detail.json)['point'])
    assert.equal(point['id'], id)
    assert.equal(Object.prototype.hasOwnProperty.call(point, 'config'), false, '记录不得有 config 段')
    assert.equal(obj(point['session'])['ok'], true)
    assert.equal(obj(point['workspace'])['ok'], true)
    assert.equal(obj(detail.json)['samePoint'], undefined, '同点判定已随 S2 下线')

    // 破坏工作区 + 之后新建文件
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')
    await fs.writeFile(path.join(h.workspaceDir, 'later.txt'), 'LATER')

    // ⑤ GET /rollback-points/<id>/preview（零写入）
    const preview = await server.call('/rollback-points/' + id + '/preview')
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    const wsPreview = obj(obj(preview.json)['workspace'])
    assert.equal(wsPreview['overwrite'], 1)
    assert.equal(wsPreview['different'], 1)
    assert.equal(wsPreview['missing'], 0)
    assert.equal(wsPreview['createdAfter'], 1)
    assert.equal(obj(preview.json)['canRestore'], true)
    assert.equal(obj(preview.json)['canRemove'], true)
    const sessionPreview = obj(obj(preview.json)['session'])
    assert.equal(sessionPreview['from'], 1)
    assert.equal(sessionPreview['to'], 6)
    assert.equal(sessionPreview['turns'], 2)
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN', '预览必须零写入')

    // ⑥ POST rewind —— 未确认：409 denied 且零写入
    const denied = await server.call('/rollback-points/' + id + '/rewind', { method: 'POST', body: { userConfirmed: false } })
    assert.equal(denied.status, 409, JSON.stringify(denied.json))
    assert.equal(obj(denied.json)['outcome'], 'denied')
    assert.equal(obj(denied.json)['code'], 'confirmation-required')
    assert.deepEqual(obj(denied.json)['segments'], [], '拒绝路径不得执行任何段')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN')
    const afterDenied = await server.call('/rollback-points')
    assert.equal(arr(obj(afterDenied.json)['points']).length, 1, '拒绝路径不得留下 guard 点（零写入）')

    // ⑦ POST rewind —— 确认：工作区覆盖恢复 + 会话 fork 回退
    const rewound = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off' },
    })
    assert.equal(rewound.status, 200, JSON.stringify(rewound.json).slice(0, 700))
    assert.equal(obj(rewound.json)['outcome'], 'restored', JSON.stringify(segmentsOf(rewound.json)))
    const byState = new Map(segmentsOf(rewound.json).map((s) => [s.state, s]))
    assert.equal(byState.get('workspace')?.status, 'restored')
    assert.equal(byState.get('session')?.status, 'restored')
    assert.equal(obj(rewound.json)['childSessionId'], 'child-' + SESSION_ID)
    assert.deepEqual(h.forkCalls, [{ sessionId: SESSION_ID, boundarySeq: 1 }], 'fork 边界必须来自回滚点')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1')
    // 2026-10-11 定案 A：回退默认删除「该点未记录」的路径 —— later.txt 正是这种，必须真的被删掉；
    // leftovers 仍然如实列出它（那是删除前的盘点口径，两者不矛盾）。
    await assert.rejects(fs.readFile(path.join(h.workspaceDir, 'later.txt')), { code: 'ENOENT' })
    const wsSegmentRaw = arr(obj(rewound.json)['segments']).map(obj).find((s) => s['state'] === 'workspace')
    assert.deepEqual(wsSegmentRaw?.['leftovers'], [path.join(h.workspaceDir, 'later.txt')])
    assert.equal(wsSegmentRaw?.['removed'], 1)

    // ⑧ POST delete（确认后删普通回滚点）
    const delNoConfirm = await server.call('/rollback-points/' + id + '/delete', { method: 'POST', body: {} })
    assert.equal(delNoConfirm.status, 409)
    assert.equal(obj(delNoConfirm.json)['code'], 'confirmation-required')
    const deleted = await server.call('/rollback-points/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
    assert.equal(obj(deleted.json)['ok'], true)
    assert.equal(obj(deleted.json)['code'], 'deleted')
    assert.equal(obj(deleted.json)['id'], id)
    assert.deepEqual(arr(obj((await server.call('/rollback-points')).json)['points']), [])

    // ⑨ 历史留痕（回退 / 删除各一条；字典键改名后仍是中文源文案）
    assert.ok(h.history.some((entry) => String(entry.summary ?? '').includes('回滚到回滚点')), JSON.stringify(h.history))
    assert.ok(h.history.some((entry) => String(entry.summary ?? '').includes('删除回滚点')), JSON.stringify(h.history))
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R8-2 404 / 405 / 400 */

test('R8-2 语义：坏 id → 404；未知子路径 → 404；方法不符 → 405；坏请求体 → 400', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    // 坏 id（详情 / 预览 / 回退 / 删除四条都必须是 404，而不是 500 或 200）
    const detail404 = await server.call('/rollback-points/rb-nope')
    assert.equal(detail404.status, 404)
    assert.equal(obj(detail404.json)['code'], 'record-not-found')
    assert.equal((await server.call('/rollback-points/rb-nope/preview')).status, 404)
    const rewindMissing = await server.call('/rollback-points/rb-nope/rewind', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(rewindMissing.status, 404)
    assert.equal(obj(rewindMissing.json)['code'], 'record-not-found')
    const deleteMissing = await server.call('/rollback-points/rb-nope/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(deleteMissing.status, 404)
    assert.equal(obj(deleteMissing.json)['code'], 'record-not-found')

    // 未知子路径
    assert.equal((await server.call('/rollback-points/rb-nope/nope')).status, 404)
    assert.equal((await server.call('/rollback-points/nope/deep/deeper')).status, 404)
    // 旧族已下线（checkpoints 不再分发）
    assert.equal((await server.call('/checkpoints')).status, 404)
    assert.equal((await server.call('/checkpoints/cp-1/rewind')).status, 404)
    // 注：2 段的非 UUID 子路径（如 /checkpoints/storage）走 recovery 既有的 operationId 分支 → 400，
    // 那是「非法 operationId」的既有语义，不是本族的退化。

    // 方法不符（kit 的方法白名单放行 GET/POST，具体子路径各自再判一次）
    assert.equal((await server.call('/rollback-points', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/rollback-points/storage', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/rollback-points/rb-nope', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/rollback-points/rb-nope/preview', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/rollback-points/rb-nope/rewind')).status, 405)
    assert.equal((await server.call('/rollback-points/rb-nope/delete')).status, 405)

    // 请求体非法 JSON → 400（不是 500）
    const raw = await server.call('/rollback-points/rb-nope/rewind', { method: 'POST', raw: '{not-json' })
    assert.equal(raw.status, 400)
    assert.equal(obj(raw.json)['code'], 'invalid-input')
    // 没有 capture 子路径（S1：手动拍点已下线）——GET 只会被当成一个不存在的 id（404 record-not-found），
    // POST 落到单段 id 分支的方法门（405）。两种情况都不会写任何字节。
    const captureGet = await server.call('/rollback-points/capture')
    assert.equal(captureGet.status, 404)
    assert.equal(obj(captureGet.json)['code'], 'record-not-found')
    assert.equal((await server.call('/rollback-points/capture', { method: 'POST', body: {} })).status, 405)
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ========================================================= R8-3 存储不可用 */

test('R8-3 存储栈不可用：列表/状态/详情/预览/回退/删除都 503 + 结构化 guidance（不抛错、不崩）', async () => {
  const h = await makeHarness()
  // 让回滚点库根路径被一个**普通文件**占住 → 引擎的缺省探针（mkdir + 写探针）必然失败
  await fs.mkdir(h.dataDir, { recursive: true })
  await fs.writeFile(path.join(h.dataDir, 'rollback-points'), 'not-a-dir')
  const server = await startServer(h)
  try {
    const list = await server.call('/rollback-points')
    assert.equal(list.status, 503, JSON.stringify(list.json))
    assert.equal(obj(list.json)['ok'], false)
    const listStorage = obj(obj(list.json)['storage'])
    assert.equal(listStorage['available'], false)
    const codes = arr(listStorage['guidance']).map((g) => String(obj(g)['code']))
    assert.ok(codes.includes('rollback.guidance.mountStorage'), JSON.stringify(codes))
    assert.ok(codes.includes('rollback.guidance.fixDataDir'))
    assert.ok(arr(listStorage['requirements']).map(String).includes('@deepseek-ai/dsh-storage'))
    assert.deepEqual(obj(list.json)['points'], [])

    const storage = await server.call('/rollback-points/storage')
    assert.equal(storage.status, 503)
    assert.equal(obj(storage.json)['available'], false)
    assert.equal(typeof obj(storage.json)['detail'], 'string')

    assert.equal((await server.call('/rollback-points/rb-any')).status, 503)
    assert.equal((await server.call('/rollback-points/rb-any/preview')).status, 503)
    assert.equal((await server.call('/rollback-points/rb-any/rewind', { method: 'POST', body: { userConfirmed: true } })).status, 503)
    assert.equal((await server.call('/rollback-points/rb-any/delete', { method: 'POST', body: { userConfirmed: true } })).status, 503)
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '存储不可用时绝不写工作区')

    // 服务没崩：后面还能正常回答（503 是结论，不是崩溃）
    assert.equal((await server.call('/rollback-points')).status, 503)
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R8-4 保护点（传输层） */

test('R8-4 保护点：即使确认了也不可回退（409 protected-point）、不可删除（409）', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const id = await makePoint(h, { protect: true })
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')

    const rewind = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off' },
    })
    assert.equal(rewind.status, 409, JSON.stringify(rewind.json))
    assert.equal(obj(rewind.json)['outcome'], 'denied')
    assert.equal(obj(rewind.json)['code'], 'protected-point')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN', '保护点绝不写任何字节')

    const del = await server.call('/rollback-points/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(del.status, 409)
    assert.equal(obj(del.json)['code'], 'protected-point')
    assert.equal(arr(obj((await server.call('/rollback-points')).json)['points']).length, 1, '保护点必须还在')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R8-5 SAFE MODE（写路径同口径） */

test('R8-5 SAFE MODE：回退/删除被 423 拒绝；只读的列表与预览不受影响', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const id = await makePoint(h)
    h.safeMode.blocked = true
    const rewind = await server.call('/rollback-points/' + id + '/rewind', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(rewind.status, 423, JSON.stringify(rewind.json))
    assert.equal(obj(rewind.json)['code'], 'mutation-locked')
    assert.equal((await server.call('/rollback-points/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })).status, 423)
    assert.equal((await server.call('/rollback-points')).status, 200, '只读列表不受 SAFE MODE 影响')
    assert.equal((await server.call('/rollback-points/' + id + '/preview')).status, 200, '只读预览不受 SAFE MODE 影响')
    assert.deepEqual(h.forkCalls, [], 'SAFE MODE 下连 fork 都不许发生')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ============================ R8-6 救援点（guard）可回退不可删（t22 口径，route 级） */

test('R8-6 救援点：preview canRestore=true/canRemove=false，POST rewind → 200 restored（不是 denied）；删除仍 409', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const id = await makePoint(h, { kind: 'guard' })

    // ① 只读预览的口径：可回退、不可删（这就是 t22 修掉的那处矛盾）
    const preview = await server.call('/rollback-points/' + id + '/preview')
    assert.equal(preview.status, 200, JSON.stringify(preview.json).slice(0, 400))
    assert.equal(obj(obj(preview.json)['point'])['kind'], 'guard')
    assert.equal(obj(preview.json)['canRestore'], true, '救援点必须可作回退目标（回到回退前那一刻）')
    assert.equal(obj(preview.json)['canRemove'], false, '救援点不可被用户删除')

    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')

    // ② 确认门不因 guard 放宽：未确认仍 409 + 零写入
    const denied = await server.call('/rollback-points/' + id + '/rewind', { method: 'POST', body: { userConfirmed: false } })
    assert.equal(denied.status, 409)
    assert.equal(obj(denied.json)['code'], 'confirmation-required')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN')

    // ③ preview 说能恢复 ⇒ 真能成功（200 + restored，不是 denied）
    const rewound = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, mode: 'files' },
    })
    assert.equal(rewound.status, 200, JSON.stringify(rewound.json).slice(0, 500))
    assert.equal(obj(rewound.json)['outcome'], 'restored')
    assert.equal(obj(rewound.json)['code'], 'ok')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '救援点 = 回退前那一刻的完整快照')

    // ④ S5 不变：回退前**仍然必须先留**一个新的救援点，且真的落进台账
    const newGuardId = obj(rewound.json)['guardPointId']
    assert.equal(typeof newGuardId, 'string')
    assert.notEqual(newGuardId, id)
    // v3（issue #89）：index.json 是**小清单**（落盘字段仍是 `records`，但每条只剩元数据 + 载荷引用），
    // 完整记录在 records/<id>.json、工作区大数组在 payloads/<sha256>.json。
    const manifest = JSON.parse(await readText(path.join(h.dataDir, 'rollback-points', 'index.json'))) as { records: { id: string }[] }
    assert.ok(manifest.records.some((r) => r.id === newGuardId), JSON.stringify(manifest.records.map((r) => r.id)))

    // ⑤ 用户依旧删不掉救援点（删除门与回退门互相独立）
    const del = await server.call('/rollback-points/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(del.status, 409)
    assert.equal(obj(del.json)['code'], 'protected-point')
    assert.equal(arr(obj((await server.call('/rollback-points')).json)['points']).some((p) => obj(p)['id'] === id), true, '救援点必须还在')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ======== R8-7 E1：nothing-to-restore 是 200（不是 500）+ 预览逐文件行级统计 ======== */

test('R8-7 E1：无事可做 → 200（outcome=restored + code=nothing-to-restore）；0 文件变更但会话可回退 → 200 且真的 fork', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const emptyDir = path.join(h.root, 'empty-ws')
    await fs.mkdir(emptyDir, { recursive: true })

    // ① 工作区 0 文件 + 会话可回退：工作区段「成功、0 变更」，会话段照常 fork
    const id = await makePoint(h, { chunks: [emptyDir] })
    const emptyPreview = await server.call('/rollback-points/' + id + '/preview')
    assert.equal(emptyPreview.status, 200, JSON.stringify(emptyPreview.json))
    assert.deepEqual(obj(obj(emptyPreview.json)['workspace'])['files'], [], '没有会被改动的文件 ⇒ 空数组')

    const rewound = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off' },
    })
    assert.equal(rewound.status, 200, JSON.stringify(rewound.json).slice(0, 500))
    assert.equal(obj(rewound.json)['outcome'], 'restored')
    assert.equal(obj(rewound.json)['code'], 'ok', '工作区 0 变更不该把整体拖成失败 / 部分')
    assert.equal(obj(rewound.json)['childSessionId'], 'child-' + SESSION_ID, '会话必须真的 fork 了')
    assert.deepEqual(h.forkCalls, [{ sessionId: SESSION_ID, boundarySeq: 1 }])
    const wsSegment = arr(obj(rewound.json)['segments']).map(obj).find((s) => s['state'] === 'workspace')
    assert.equal(wsSegment?.['status'], 'restored')
    assert.equal(wsSegment?.['restored'], 0)
    // T10：「没记录任何文件」有自己的码（与「有记录但全部一致」分开）
    assert.equal(wsSegment?.['reasonCode'], 'no-recorded-files')
    assert.deepEqual(obj(rewound.json)['skippedSegments'], [], '「执行过、0 变更」不同于「没执行」')

    // ② 所有被请求的段都无事可做：**200** + outcome=restored + code=nothing-to-restore（旧版这里是 500）
    const onlyFiles = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off', mode: 'files' },
    })
    assert.equal(onlyFiles.status, 200, JSON.stringify(onlyFiles.json).slice(0, 500))
    assert.equal(obj(onlyFiles.json)['outcome'], 'restored')
    assert.equal(obj(onlyFiles.json)['code'], 'nothing-to-restore')
    assert.equal(obj(onlyFiles.json)['ok'], true)

    // ③ 预览逐文件行级统计：完全一致 ⇒ 空数组；改一个文件 ⇒ 该文件带 added/removed
    const id2 = await makePoint(h)
    const clean = await server.call('/rollback-points/' + id2 + '/preview')
    assert.equal(clean.status, 200)
    const cleanWs = obj(obj(clean.json)['workspace'])
    assert.equal(cleanWs['overwrite'], 1)
    assert.equal(cleanWs['different'], 0)
    assert.deepEqual(cleanWs['files'], [], '内容一致 ⇒ 空数组，而不是逐条列出')
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X1\nX2\nX3')
    const changed = await server.call('/rollback-points/' + id2 + '/preview')
    assert.equal(changed.status, 200)
    const changedWs = obj(obj(changed.json)['workspace'])
    assert.equal(changedWs['different'], 1)
    assert.deepEqual(arr(changedWs['files']).map(obj), [{
      path: path.join(h.workspaceDir, 'x.txt'),
      status: 'overwrite',
      added: 0,
      removed: 2,
      truncated: false,
    }], '快照 1 行 vs 当前 3 行 ⇒ 覆盖回退删掉 2 行')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1\nX2\nX3', '预览必须零写入')
    // 反向：当前被清空 ⇒ 覆盖回退补回快照的那 1 行
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), '')
    const grown = await server.call('/rollback-points/' + id2 + '/preview')
    assert.deepEqual(arr(obj(obj(grown.json)['workspace'])['files']).map(obj), [{
      path: path.join(h.workspaceDir, 'x.txt'),
      status: 'overwrite',
      added: 1,
      removed: 0,
      truncated: false,
    }])
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X1\nX2\nX3')

    // ④ 真的回退一次（覆盖回快照）→ 200 restored/ok
    const first = await server.call('/rollback-points/' + id2 + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off', mode: 'files' },
    })
    assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 400))
    assert.equal(obj(first.json)['outcome'], 'restored')
    assert.equal(obj(first.json)['code'], 'ok')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1')

    // ⑤ 工作区已与该点一致时再回退 ⇒ 「成功、0 变更」= 200 + nothing-to-restore（截图 1 那一幕）
    const second = await server.call('/rollback-points/' + id2 + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off', mode: 'files' },
    })
    assert.equal(second.status, 200, JSON.stringify(second.json).slice(0, 500))
    assert.equal(obj(second.json)['outcome'], 'restored')
    assert.equal(obj(second.json)['code'], 'nothing-to-restore')
    assert.equal(arr(obj(second.json)['segments']).map(obj)[0]?.['restored'], 0)
    assert.equal(
      arr(obj(second.json)['segments']).map(obj)[0]?.['reasonCode'],
      'nothing-to-restore',
      '「有记录但全部一致」必须是另一个码（不是 no-recorded-files）',
    )
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '无事可做也绝不改写内容')

    // ⑥ 真失败仍 500：把该点的**工作区载荷**篡改成不可能满足的指纹 → 零写入 + restore-failed
    //
    // v3（issue #89）起完整记录在 records/<id>.json，工作区大数组在**内容寻址**的
    // payloads/<sha256>.json（清单 index.json 里只剩元数据）。所以篡改必须**成对**：
    // 改载荷里的 sha256 + 把记录里的载荷哈希引用改到新文件的哈希 —— 否则读路径会先按
    // 「哈希不符」如实失败，就测不到下游那条判据了（与 core 的 R-xx 白盒用例同一手法）。
    const storeDir = path.join(h.dataDir, 'rollback-points')
    const recordFile = path.join(storeDir, 'records', id2 + '.json')
    const storedRecord = JSON.parse(await readText(recordFile)) as { workspace: { payload: string | null } }
    const payloadHash = storedRecord.workspace.payload
    assert.equal(typeof payloadHash, 'string', '该点必须有内容寻址载荷')
    const payloadFile = path.join(storeDir, 'payloads', String(payloadHash) + '.json')
    interface TamperablePayload { files: { path: string; sha256: string }[] }
    const payload = JSON.parse(await readText(payloadFile)) as TamperablePayload
    for (const file of payload.files) file.sha256 = '0'.repeat(64)
    const tamperedText = JSON.stringify(payload)
    const tamperedHash = sha256Hex(tamperedText)
    await fs.writeFile(path.join(storeDir, 'payloads', tamperedHash + '.json'), tamperedText)
    storedRecord.workspace.payload = tamperedHash
    await fs.writeFile(recordFile, JSON.stringify(storedRecord))
    const tampered = await server.call('/rollback-points/' + id2 + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off', mode: 'files' },
    })
    assert.equal(tampered.status, 500, JSON.stringify(tampered.json).slice(0, 400))
    assert.equal(obj(tampered.json)['outcome'], 'failed')
    assert.equal(obj(tampered.json)['code'], 'restore-failed')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ========== R8-8 T10：台账只读 ⇒ 没有幽灵 guardPointId；ledger-write-failed 真可达 ========== */

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

test('R8-8 T10：台账只读 ⇒ rewind(require) 500 guard-failed（零写入、无幽灵 guardPointId）；delete 500 ledger-write-failed', async (t) => {
  const h = await makeHarness()
  const server = await startServer(h)
  const ledgerPath = path.join(h.dataDir, 'rollback-points', 'index.json')
  try {
    const id = await makePoint(h)
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')

    const unblock = await blockLedgerWrite(ledgerPath)
    if (unblock === null) {
      t.skip('本机无法构造台账写失败（symlink 不可用，或只读目录挡不住原子写的 rename）')
      return
    }
    try {
      // ① require 档：留不下救援点 = S5 硬门 ⇒ 整体中止（旧版这里是 200 + 一个查不到的 guardPointId）
      const required = await server.call('/rollback-points/' + id + '/rewind', {
        method: 'POST',
        body: { userConfirmed: true, preRewindGuard: 'require' },
      })
      assert.equal(required.status, 500, JSON.stringify(required.json).slice(0, 400))
      assert.equal(obj(required.json)['outcome'], 'failed')
      assert.equal(obj(required.json)['code'], 'guard-failed')
      assert.equal(obj(required.json)['guardPointId'], undefined, '留不下救援点就绝不能报 guardPointId')
      assert.equal(obj(required.json)['childSessionId'], undefined, '中止 ⇒ 不 fork')
      assert.deepEqual(arr(obj(required.json)['segments']), [], '中止 ⇒ 一段都不执行')
      assert.deepEqual(h.forkCalls, [], '中止 ⇒ 连 fork 都不许发生')
      assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN', '零写入')

      // ② 缺省 warn 档：告警后继续，但同样不报 guardPointId（旧版会报幽灵点）
      const warned = await server.call('/rollback-points/' + id + '/rewind', {
        method: 'POST',
        body: { userConfirmed: true, segments: ['workspace'] },
      })
      assert.equal(warned.status, 200, JSON.stringify(warned.json).slice(0, 400))
      assert.equal(obj(warned.json)['outcome'], 'restored')
      assert.equal(obj(warned.json)['guardPointId'], undefined)
      assert.equal(
        arr(obj(warned.json)['warnings']).map((w) => String(obj(w)['code'])).includes('rollback.warn.guardFailed'),
        true,
        JSON.stringify(obj(warned.json)['warnings']),
      )
      assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', 'warn 档照常回退工作区')

      // ③ ledger-write-failed 在路由上的可达点 = delete（引擎 remove 直接回它）⇒ 500，且零写入
      const del = await server.call('/rollback-points/' + id + '/delete', {
        method: 'POST',
        body: { userConfirmed: true },
      })
      assert.equal(del.status, 500, JSON.stringify(del.json).slice(0, 400))
      assert.equal(obj(del.json)['code'], 'ledger-write-failed', 'delete 路径必须让这个码真的可达')
      assert.equal(obj(del.json)['ok'], false)
    } finally {
      await unblock()
    }
    // 只读期间零写入：记录还在
    assert.equal(arr(obj((await server.call('/rollback-points')).json)['points']).length, 1, '被拒的删除不得动台账')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ============================================================ R8-9 t8 运行中的对话 */

/**
 * t8：这条对话**正在运行**（会话日志 mtime 落在引擎静默窗内）时，**带工作区段**的回退在路由层被硬拒
 * （409 `session-active`、零写入）—— 运行中的工具可能正在写盘，不能和它抢文件；
 * 而「只回溯消息」（`mode=session`）不碰工作区，照常 fork。
 *
 * 上面 R8-1/4/5/6/7/8 的夹具把日志 mtime 拨到静默窗**外**（代表「对话不在运行」）——
 * 它们测的是别的守卫，不该被这条新口径染色；运行中的口径由本用例与
 * `src/routes/recovery.test.ts` 的 t8 用例共同覆盖。
 */
test('R8-9 t8：运行中带文件段 ⇒ 409 session-active 且零写入；只回溯消息照常 fork', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const id = await makePoint(h)
    // 把日志 mtime 拨回「刚刚被写过」= 引擎判「这条对话正在运行」（静默窗缺省 30 s）
    const now = new Date()
    await fs.utimes(h.logFile, now, now)
    const ledgerPath = path.join(h.dataDir, 'rollback-points', 'index.json')
    const ledgerBefore = arr(obj(JSON.parse(await readText(ledgerPath)) as unknown)['records']).length

    // ① 显式 mode=files+session ⇒ 409 + 机器码 + 一段都没动
    const blocked = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, mode: 'files+session' },
    })
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json).slice(0, 400))
    assert.equal(obj(blocked.json)['code'], 'session-active')
    assert.equal(obj(blocked.json)['outcome'], 'denied')
    assert.deepEqual(segmentsOf(blocked.json), [], '一段都没动（segments 恒空）')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '工作区逐字节未变')
    assert.equal(h.forkCalls.length, 0, '没有 fork（整次请求零写入）')
    assert.equal(arr(obj(JSON.parse(await readText(ledgerPath)) as unknown)['records']).length, ledgerBefore, '台账不变（连救援点都没留）')

    // ② 缺省档（不带 mode ⇒ 引擎缺省 files+session）同样被挡 —— UI 默认档不能例外
    const byDefault = await server.call('/rollback-points/' + id + '/rewind', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(byDefault.status, 409, JSON.stringify(byDefault.json).slice(0, 300))
    assert.equal(obj(byDefault.json)['code'], 'session-active')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1')

    // ③ 只回溯消息（mode=session）⇒ 照常 200 + 真 fork（运行中不受影响）
    const sessionOnly = await server.call('/rollback-points/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, mode: 'session' },
    })
    assert.equal(sessionOnly.status, 200, JSON.stringify(sessionOnly.json).slice(0, 400))
    assert.equal(obj(sessionOnly.json)['outcome'], 'restored')
    assert.equal(h.forkCalls.length, 1, '会话段照常 fork')
    assert.equal(h.forkCalls[0]?.sessionId, SESSION_ID)
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '只回溯消息不动工作区')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ========================================= R8-11 issue #88：留点总开关路由面 */

/**
 * 开关是「用户能不能让这个功能停下来」的唯一入口，四条判据都要落在**字节**上：
 *  ① 缺省 = 关闭（磁盘与进程 gate 都是 false）；
 *  ② POST true：写盘 + 切进程 gate（写盘成功才切，见路由实现）；
 *  ③ 非法体（非布尔）→ 400 且**什么都不改**；方法白名单 → 405；
 *  ④ 列表与 storage 两条只读响应都带上开关（界面读一个响应就能画开关 + 决定聊天入口是否收起）；
 *  ⑤ SAFE MODE 拦着时 → 423，且绝不落盘（它改的是「宿主会不会每回合写盘」的行为语义）。
 */
test('R8-11 issue #88：prefs 开关 —— 缺省关闭 / 开启落盘并切 gate / 非法体 400 / SAFE MODE 423 零写入', async () => {
  resetRollbackGateForTest()
  const h = await makeHarness()
  const server = await startServer(h)
  const prefsFile = path.join(h.dataDir, 'sync', 'ui-prefs.json')
  try {
    // ① 缺省：没有文件、没有订阅
    const before = await server.call('/rollback-points/prefs')
    assert.equal(before.status, 200, JSON.stringify(before.json))
    assert.equal(obj(before.json)['rollbackEnabled'], false, '缺省必须是关闭（fail-closed）')
    assert.equal(obj(before.json)['rollbackActive'], false)
    assert.equal(isRollbackEnabled(), false)
    assert.equal(await exists(prefsFile), false, '只读探测不得写任何文件')

    // ② 开：落盘 + 进程 gate
    const on = await server.call('/rollback-points/prefs', { method: 'POST', body: { rollbackEnabled: true } })
    assert.equal(on.status, 200, JSON.stringify(on.json))
    assert.equal(obj(on.json)['rollbackEnabled'], true)
    assert.equal(obj(on.json)['rollbackActive'], true)
    assert.equal(isRollbackEnabled(), true, '写盘成功后进程 gate 必须跟着开')
    assert.equal(JSON.parse(await readText(prefsFile))['rollbackEnabled'], true)

    // ④ 两条只读响应都带开关
    const storage = await server.call('/rollback-points/storage')
    assert.equal(obj(storage.json)['rollbackEnabled'], true, 'storage 响应必须带开关')
    assert.equal(obj(storage.json)['rollbackActive'], true)
    const list = await server.call('/rollback-points')
    assert.equal(obj(obj(list.json)['storage'])['rollbackEnabled'], true, '列表响应的 storage 也要带开关')

    // ③ 非法体：非布尔 → 400，且状态一个字节都不动
    const bad = await server.call('/rollback-points/prefs', { method: 'POST', body: { rollbackEnabled: 'yes' } })
    assert.equal(bad.status, 400)
    assert.equal(isRollbackEnabled(), true, '非法请求不得改进程 gate')
    assert.equal(JSON.parse(await readText(prefsFile))['rollbackEnabled'], true, '非法请求不得改磁盘')

    // ③ 方法白名单：PUT → 405
    const put = await server.call('/rollback-points/prefs', { method: 'PUT', body: { rollbackEnabled: true } })
    assert.equal(put.status, 405)

    // ⑤ SAFE MODE 拦着 → 423，零写入（磁盘保持 true）
    h.safeMode.blocked = true
    const blocked = await server.call('/rollback-points/prefs', { method: 'POST', body: { rollbackEnabled: false } })
    assert.equal(blocked.status, 423, JSON.stringify(blocked.json))
    assert.equal(obj(blocked.json)['code'], 'mutation-locked')
    assert.equal(isRollbackEnabled(), true, '被门挡住不得改 gate')
    assert.equal(JSON.parse(await readText(prefsFile))['rollbackEnabled'], true, '被门挡住不得落盘')
    h.safeMode.blocked = false

    // 关：字段消失（缺省即关），gate 跟着关
    const off = await server.call('/rollback-points/prefs', { method: 'POST', body: { rollbackEnabled: false } })
    assert.equal(off.status, 200)
    assert.equal(isRollbackEnabled(), false)
    assert.equal(JSON.parse(await readText(prefsFile))['rollbackEnabled'], undefined, '关闭 = 字段消失（缺省即关）')
  } finally {
    await server.close()
    await h.cleanup()
    resetRollbackGateForTest()
  }
})

/* ==================================== R8-12 issue #89：台账清理（cleanup） */

/**
 * 清理入口是「把已经涨上去的占用收回来」的唯一显式通道，判据四条：
 *  ① 未确认 → 409 且零写入（与单条 delete 同一条 fail-closed 确认门）；
 *  ② 确认后**默认只删自动点**，救援点保留；
 *  ③ `includeGuards: true` 才连救援点一起删；
 *  ④ 回传的删除计数与真实台账一致（界面按它出文案，不许我们自己推算）。
 */
test('R8-12 issue #89：cleanup —— 未确认 409 零写入 / 默认只删自动点 / includeGuards 才删救援点', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const autoA = await makePoint(h, { turnSeq: 1 })
    const autoB = await makePoint(h, { turnSeq: 2 })
    const guardId = await makePoint(h, { kind: 'guard', turnSeq: 3 })
    const ids = async (): Promise<string[]> =>
      arr(obj((await server.call('/rollback-points')).json)['points']).map((p) => String(obj(p)['id'])).sort()
    assert.deepEqual(await ids(), [autoA, autoB, guardId].sort(), '三个点都在台账里')

    // ① 未确认 → 409，零写入（点一个都不许少）
    const denied = await server.call('/rollback-points/cleanup', { method: 'POST', body: {} })
    assert.equal(denied.status, 409, JSON.stringify(denied.json))
    assert.equal(obj(denied.json)['code'], 'confirmation-required')
    assert.deepEqual(await ids(), [autoA, autoB, guardId].sort(), '未确认 = 零写入')

    // ② 确认（默认 includeGuards=false）→ 只删自动点
    const done = await server.call('/rollback-points/cleanup', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(done.status, 200, JSON.stringify(done.json).slice(0, 300))
    assert.equal(obj(done.json)['removedRecords'], 2, '两条自动点被删')
    assert.deepEqual(await ids(), [guardId], '救援点必须保留')

    // ③ includeGuards: true → 连救援点一起删
    const withGuards = await server.call('/rollback-points/cleanup', { method: 'POST', body: { userConfirmed: true, includeGuards: true } })
    assert.equal(withGuards.status, 200, JSON.stringify(withGuards.json).slice(0, 300))
    assert.equal(obj(withGuards.json)['removedRecords'], 1)
    assert.deepEqual(await ids(), [], '救援点也被删')

    // ④ 空台账再清一次 = 0（幂等，不是失败）
    const again = await server.call('/rollback-points/cleanup', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(again.status, 200)
    assert.equal(obj(again.json)['removedRecords'], 0)

    // 方法白名单
    const put = await server.call('/rollback-points/cleanup', { method: 'PUT', body: { userConfirmed: true } })
    assert.equal(put.status, 405)

    // ⑤ 台账读不出来时**如实拒绝**（带机器码，不回落成泛化 500、更不假装「删了 0 个」）
    await fs.writeFile(path.join(h.dataDir, 'rollback-points', 'index.json'), '{ broken-manifest', 'utf8')
    const refused = await server.call('/rollback-points/cleanup', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(refused.status, 500, JSON.stringify(refused.json).slice(0, 200))
    assert.equal(obj(refused.json)['code'], 'ledger-unreadable', '拒绝必须带机器码')
  } finally {
    await server.close()
    await h.cleanup()
  }
})


