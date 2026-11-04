/**
 * 迁移历史自动清理（history/retention）路由回归：
 *  - GET 读策略 + 目录现状（缺省 1000、0 = 不限制）；
 *  - POST 改策略并**立即**清理一次（先落 ui-prefs，再删旧条目），非法值 400 带机器可读码；
 *  - GET /history?limit=N 只读尾部窗口，但 total 仍报目录全量。
 *
 * 为什么必须钉：历史目录此前只增不减（真机 2360 条 / 0.67 MB），且首页首屏等过一次全量读取（冷 9.7 s）。
 * 这两条都是「用户看得见的坏」，改回全量读或把清理改成「0 = 清空」必须红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { historyRoutes } from '../../src/routes/history.ts'
import { routeSpecOf } from '../../src/routes/kit.ts'
import type { WebRoute } from '../../src/routes/kit.ts'
import { MigrationStore } from '../../src/core/migration-history.ts'
import { readUiPrefs } from '../../src/sync/ui-prefs.ts'

const BASE = '/api/dsh-config-manager/history'
const RETENTION = '/api/dsh-config-manager/history/retention'

interface Harness {
  routes: WebRoute[]
  history: MigrationStore
  syncDir: string
  dir: string
  cleanup: () => void
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-history-retention-'))
  const syncDir = path.join(dir, 'sync')
  fs.mkdirSync(syncDir, { recursive: true })
  const history = new MigrationStore({ dir: path.join(dir, 'migration-history') })
  const env = {
    history,
    syncDir,
    host: { language: 'zh', log: { info: () => undefined, warn: () => undefined } },
    msg: (key: string) => key,
    // 门内逻辑（策略读写 + 清理）是本组要测的部分；门本身由 kit 单测覆盖。
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
  return {
    routes: historyRoutes(env),
    history,
    syncDir,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

// 同一 path 的 GET/POST 是两条 route（方法白名单在 endpoint() 包装里判定），必须按 routeSpecOf 的方法挑。
function routeOf(h: Harness, routePath: string, method: 'GET' | 'POST' = 'GET'): WebRoute {
  const route = h.routes.find((r) => r.path === routePath && routeSpecOf(r)?.methods.includes(method) === true)
  assert.ok(route !== undefined, '缺少 ' + method + ' ' + routePath)
  return route
}

interface FakeResponse { status: number; body: string }

async function call(route: WebRoute, init: { url?: string; body?: unknown; method?: 'GET' | 'POST' } = {}): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const req = {
    // WebRoute 只暴露 kind/path/handler（方法白名单在 kit 的注册包装里判定），故方法由调用方显式给出。
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(init.body ?? {}), 'utf8') },
  } as unknown as IncomingMessage
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return state
}

async function seed(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await h.history.append({
      at: `2026-08-30T12:0${i}:00.000Z`,
      kind: 'import',
      result: 'success',
      sections: ['plugins'],
      source: 'api',
      summary: `第 ${i} 条`,
    })
  }
}

test('GET /history/retention：缺省策略 = 1000，total 报目录条数，回带合法区间', async () => {
  const h = harness()
  try {
    await seed(h, 3)
    const r = await call(routeOf(h, RETENTION))
    assert.equal(r.status, 200, r.body)
    const body = JSON.parse(r.body) as Record<string, number | boolean>
    assert.equal(body.ok, true)
    assert.equal(body.maxEntries, 1000, '未配置时回落 DEFAULT_MIGRATION_RETENTION')
    assert.equal(body.total, 3)
    assert.equal(body.defaultMaxEntries, 1000)
    assert.equal(body.allowedMin, 0)
    assert.equal(body.allowedMax, 100_000)
  } finally { h.cleanup() }
})

test('POST /history/retention：落策略 + 立即清理最旧条目（0 = 不限制，绝不清空）', async () => {
  const h = harness()
  try {
    await seed(h, 5)
    const shrink = await call(routeOf(h, RETENTION, 'POST'), { method: 'POST', body: { maxEntries: 2 } })
    assert.equal(shrink.status, 200, shrink.body)
    const shrunk = JSON.parse(shrink.body) as Record<string, number | boolean>
    assert.equal(shrunk.ok, true)
    assert.equal(shrunk.maxEntries, 2)
    assert.equal(shrunk.removed, 3, '5 条降到上限 2 应删 3 条最旧')
    assert.equal(shrunk.total, 2)
    // 策略真的落盘（下一次写入/重启后仍生效）
    assert.equal((await readUiPrefs(h.syncDir)).historyRetentionMaxEntries, 2)

    // 0 = 不限制：不删任何条目，且策略本身要能存成 0（不是「没配置」）
    const unlimited = await call(routeOf(h, RETENTION, 'POST'), { method: 'POST', body: { maxEntries: 0 } })
    assert.equal(unlimited.status, 200, unlimited.body)
    const body0 = JSON.parse(unlimited.body) as Record<string, number | boolean>
    assert.equal(body0.removed, 0, '0 绝不能被当成「保留 0 条」批量删')
    assert.equal(body0.total, 2)
    assert.equal((await readUiPrefs(h.syncDir)).historyRetentionMaxEntries, 0)
    // 读回也是 0（不是回落 1000）
    const readBack = JSON.parse((await call(routeOf(h, RETENTION))).body) as Record<string, number | boolean>
    assert.equal(readBack.maxEntries, 0)
  } finally { h.cleanup() }
})

test('POST /history/retention：非法上限 → 400 + invalid-retention，零写入', async () => {
  const h = harness()
  try {
    await seed(h, 3)
    for (const bad of [-1, 1.5, 100_001, '1000', null]) {
      const r = await call(routeOf(h, RETENTION, 'POST'), { method: 'POST', body: { maxEntries: bad } })
      assert.equal(r.status, 400, `maxEntries=${String(bad)} 应为 400：${r.body}`)
      const body = JSON.parse(r.body) as { code?: unknown; error?: unknown }
      assert.equal(body.code, 'invalid-retention')
      assert.equal(typeof body.error, 'string')
    }
    // 零写入：策略没落盘、条目没被删
    assert.equal((await readUiPrefs(h.syncDir)).historyRetentionMaxEntries, undefined)
    assert.equal(await h.history.count(), 3)
  } finally { h.cleanup() }
})

test('GET /history?limit=N：只读尾部窗口，entries 是窗口、total 是全量', async () => {
  const h = harness()
  try {
    await seed(h, 6)
    const r = await call(routeOf(h, BASE), { url: BASE + '?limit=2' })
    assert.equal(r.status, 200, r.body)
    const body = JSON.parse(r.body) as { entries: Array<{ summary: string }>; total: number; scanned: number; limit: number }
    assert.equal(body.entries.length, 2)
    assert.deepEqual(body.entries.map((e) => e.summary).sort(), ['第 4 条', '第 5 条'])
    assert.equal(body.total, 6, '窗口之外的旧条目仍要能被报出规模')
    assert.equal(body.scanned, 2)
    assert.equal(body.limit, 2)

    // 不带 limit = 老口径全量（导出 / 历史页仍依赖它）
    const all = JSON.parse((await call(routeOf(h, BASE))).body) as { entries: unknown[]; total: number }
    assert.equal(all.entries.length, 6)
    assert.equal(all.total, 6)
  } finally { h.cleanup() }
})
