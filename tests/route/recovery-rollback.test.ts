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

import { recoveryRoutes } from '../../src/routes/recovery.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { RollbackPointEngine } from '../../src/core/rollback-point.ts'
import { emptySessionMeta } from '../../src/core/session-meta.ts'

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
    const ledger = JSON.parse(await readText(path.join(h.dataDir, 'rollback-points', 'index.json'))) as { records: { id: string }[] }
    assert.ok(ledger.records.some((r) => r.id === newGuardId), JSON.stringify(ledger.records.map((r) => r.id)))

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

    // ⑥ 真失败仍 500：台账被篡改成不可能满足的指纹 → 零写入 + restore-failed
    const ledgerPath = path.join(h.dataDir, 'rollback-points', 'index.json')
    interface TamperableRecord {
      id: string
      workspace: { payload: { files: { path: string; sha256: string }[] } | null }
    }
    const ledger = JSON.parse(await readText(ledgerPath)) as { records: TamperableRecord[] }
    const target = ledger.records.find((r) => r.id === id2)
    assert.ok(target !== undefined && target.workspace.payload !== null)
    for (const file of target.workspace.payload?.files ?? []) file.sha256 = '0'.repeat(64)
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
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

/** 只读台账探针（同引擎单测）：挡不住写就跳过，绝不伪造结论。 */
async function ledgerWritable(file: string): Promise<boolean> {
  try {
    await fs.appendFile(file, '')
    return true
  } catch {
    return false
  }
}

test('R8-8 T10：台账只读 ⇒ rewind(require) 500 guard-failed（零写入、无幽灵 guardPointId）；delete 500 ledger-write-failed', async (t) => {
  const h = await makeHarness()
  const server = await startServer(h)
  const ledgerPath = path.join(h.dataDir, 'rollback-points', 'index.json')
  try {
    const id = await makePoint(h)
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')

    await fs.chmod(ledgerPath, 0o444)
    if (await ledgerWritable(ledgerPath)) {
      t.skip('本机 chmod 后台账仍可写，无法构造台账写失败')
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
      await fs.chmod(ledgerPath, 0o666)
    }
    // 只读期间零写入：记录还在
    assert.equal(arr(obj((await server.call('/rollback-points')).json)['points']).length, 1, '被拒的删除不得动台账')
  } finally {
    await server.close()
    await h.cleanup()
  }
})
