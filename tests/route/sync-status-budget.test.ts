/**
 * 回归（2026-10 真机）：**只读端点也必须「有界返回」**。
 *
 * 现场：`GET /sync/status` 在真机 300 秒不返回（其余只读端点都在毫秒级），HTTP 响应永远不写出；
 * 首页把它和 4 个毫秒级请求放在同一个 allSettled 里 ⇒ 整页骨架永久停在「加载中…」。
 *
 * 这条用例钉住**服务端那一半**：取值体里最可疑的不可控依赖（DSH credentials 服务 describe）
 * 永不 resolve 时，handler 必须在预算耗尽后**回一个明确错误**（503 + 可辨识文案），而不是悬挂。
 * 计时用假时钟推进（真等 10 秒会让整条测试线慢 10 秒）。
 */
import test from 'node:test'
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'

const STATUS_PATH = '/api/dsh-config-manager/sync/status'
/** 服务端预算（src/routes/sync.ts 的 SYNC_STATUS_BUDGET_MS）；用例只按它推进假时钟。 */
const BUDGET_MS = 10_000

function fakeRequest(url = '/'): IncomingMessage {
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {},
  }
  return req as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  const state = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body) as Record<string, unknown>,
  }
}

/** 该组路由在本条用例路径上会用到的 env；credentials.describe 永不 resolve（真实挂起形态）。 */
function envFor(syncDir: string): never {
  const env = {
    syncDir,
    msg: (key: string, params?: Record<string, string>) => (params === undefined ? key : key + ':' + JSON.stringify(params)),
    credentials: {
      describe: () => new Promise(() => {}),
      set: async () => {},
      unset: async () => {},
    },
    syncSectionCatalog: [],
    syncCredentialsByChannelView: async () => ({}),
    selectionView: async () => ({}),
    selectionViewByChannel: async () => ({}),
    syncWorkDir: { inspect: async () => ({ facts: {} }), rebuild: async () => ({}) },
    withMutationGate: (_op: string, handler: unknown) => handler,
  }
  return env as never
}

/** 能顺利走完全程的 env（凭据 describe 立即回「未配置」）；inspect 的入参被记下来供断言。 */
function okEnv(syncDir: string, seen: Array<Record<string, unknown> | undefined>): never {
  const env = {
    syncDir,
    msg: (key: string) => key,
    credentials: {
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    syncSectionCatalog: [],
    syncCredentialsByChannelView: async () => ({ git: {}, webdav: {} }),
    selectionView: async () => ({ mode: 'default', sections: [] }),
    selectionViewByChannel: async () => ({ git: {}, webdav: {} }),
    syncWorkDir: {
      inspect: async (_repoUrl: string, opts?: Record<string, unknown>) => {
        seen.push(opts)
        return { facts: { path: syncDir, exists: false, origin: null, pushUrl: null, match: false, ahead: null, dirty: null, remoteSnapshots: null } }
      },
      rebuild: async () => ({}),
    },
    withMutationGate: (_op: string, handler: unknown) => handler,
  }
  return env as never
}

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p)
  assert.ok(found !== undefined, '路由缺失: ' + p)
  return found
}

test('凭据服务永不返回 → 预算耗尽即 503 + 可辨识文案（绝不让响应悬挂）', async (t) => {
  const syncDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sync-status-budget-'))
  t.after(async () => { await fs.rm(syncDir, { recursive: true, force: true }) })

  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => { mock.timers.reset() })

  const route = routeByPath(syncRoutes(envFor(syncDir)), STATUS_PATH)
  const res = fakeResponse()

  // 不 await：请求此刻正挂在 credentials.describe 上。
  const settled = route.handler(fakeRequest(), res.res)
  // 让 readFullSyncConfig / loadSyncState 的真 I/O 先落地（假时钟只管 setTimeout）。
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(res.status(), 0, '预算内不得提前写出响应')

  mock.timers.tick(BUDGET_MS)
  await settled

  assert.equal(res.status(), 503, '预算耗尽 = 暂不可用（503），不是 200 也不是悬挂')
  const body = res.json()
  assert.equal(
    body['error'],
    'host.syncStatusTimeout',
    '错误文案必须可辨识（服务端同一句既用于超时判定也用于客户端提示）',
  )
})

/**
 * 回归（2026-10-27 实测）：`/sync/status` 的 730 ms 里 585 ms 是 7 次 `git.exe` 进程启动
 * （Windows 每次约 80 ms，与仓库大小/输出无关）。只有同步页的 WorkDirCard 渲染
 * ahead / dirty / remoteSnapshots —— 首页与产物库只要「工作副本是否跟随配置地址」。
 * `?detail=0` 必须真的把选择传到工作副本自检，缺省则保持完整自检（老调用方零改动）。
 */
test('detail=0 → 工作副本自检降级；缺省仍是完整自检', async (t) => {
  const syncDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sync-status-detail-'))
  t.after(async () => { await fs.rm(syncDir, { recursive: true, force: true }) })
  await fs.writeFile(
    path.join(syncDir, 'sync-config.json'),
    JSON.stringify({ schemaVersion: 3, transport: 'git', git: { repoUrl: 'https://example.com/r.git' } }),
    'utf8',
  )

  const seen: Array<Record<string, unknown> | undefined> = []
  const route = routeByPath(syncRoutes(okEnv(syncDir, seen)), STATUS_PATH)

  const lean = fakeResponse()
  await route.handler(fakeRequest(STATUS_PATH + '?detail=0'), lean.res)
  assert.equal(lean.status(), 200, '降级只是少算三项，不得变成错误响应')
  assert.deepEqual(seen[0], { detail: false }, '?detail=0 必须显式告诉宿主跳过 ahead/dirty/remoteSnapshots')

  const full = fakeResponse()
  await route.handler(fakeRequest(STATUS_PATH), full.res)
  assert.equal(full.status(), 200)
  assert.deepEqual(seen[1], { detail: true }, '缺省仍是完整自检：同步页 WorkDirCard 依赖那三项')
})
