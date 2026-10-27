/**
 * 回归（issue #116）：POST /sync/sync 在预览失败时必须把**结构化原因** reason 透传给客户端。
 *
 * 为什么钉这个：客户端（src/client/sync/preview-failure.ts）靠 reason='remote-empty' 才知道
 * 「远端一个快照都没有」是首次同步的正常起点、该给「先推送」引导，而不是报红色「同步失败」。
 * 判定若只挂 message 文案，改一句措辞就会悄悄退回成故障（文案会随语言/措辞变，字段不会）。
 *
 * 同时钉住「没有原因就不许凭空造一个」：宿主没给 reason 时响应体里**不出现**该键。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const SYNC_PATH = '/api/dsh-config-manager/sync/sync'

/** 本组路由在 /sync/sync 失败路径上真正读到的成员（其余为 undefined，不进这条路径）。 */
function envFor(preview: Record<string, unknown>): never {
  return {
    msg: (key: string) => key,
    credentials: { describe: async () => ({ configured: false }), set: async () => {}, unset: async () => {} },
    prepareSync: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://example.invalid/owner/repo.git' } }),
    makeSyncEngine: () => ({ preview: async () => preview }),
    selectionOptInSections: () => [],
    resolveSyncPassword: async () => undefined,
    syncSessions: { set: () => {}, get: () => undefined, delete: () => false },
    syncSectionCatalog: [],
    // 注册期就要用的包壳：直通（写动作的 gating 语义不在本用例范围）
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

function syncRoute(preview: Record<string, unknown>): WebRoute {
  const route = syncRoutes(envFor(preview)).find((r) => r.path === SYNC_PATH)
  assert.ok(route !== undefined, '缺少 ' + SYNC_PATH)
  return route
}

function fakeRequest(body: unknown): IncomingMessage {
  return {
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  } as unknown as IncomingMessage
}

interface FakeResponse { status: number; body: string }

async function callSyncRoute(route: WebRoute, body: unknown): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(fakeRequest(body), res as unknown as ServerResponse)
  return state
}

test('issue #116：预览回 remote-empty → 响应体带同名 reason（客户端据此给引导而不是报失败）', async () => {
  const route = syncRoute({ ok: false, zipPath: '', plan: null, analysis: null, snapshotId: '', message: '远端无快照', reason: 'remote-empty' })
  const r = await callSyncRoute(route, { transport: 'git', repoUrl: 'https://example.invalid/owner/repo.git' })
  assert.equal(r.status, 200, r.body)
  const parsed = JSON.parse(r.body) as Record<string, unknown>
  assert.equal(parsed['ok'], false)
  assert.equal(parsed['reason'], 'remote-empty', '结构化成因必须透传：' + r.body)
  assert.equal(parsed['message'], '远端无快照', '原始 message 仍保留（日志/兜底文案要用）')
})

test('issue #116：预览失败但宿主没给 reason → 响应体不出现该键（不凭空造原因）', async () => {
  const route = syncRoute({ ok: false, zipPath: '', plan: null, analysis: null, snapshotId: '', message: 'stub' })
  const r = await callSyncRoute(route, { transport: 'git', repoUrl: 'https://example.invalid/owner/repo.git' })
  assert.equal(r.status, 200, r.body)
  const parsed = JSON.parse(r.body) as Record<string, unknown>
  assert.equal(parsed['ok'], false)
  assert.ok(!('reason' in parsed), '没有原因就不许编一个：' + r.body)
})
