/**
 * 回归：POST /sync/snapshot-delete —— 产物库「远端快照 → 删除」的宿主出口。
 *
 * 三条钉住：
 *  ① snapshotId 原样（trim 后）交给引擎的 deleteSnapshot，路由自己**不写任何本机文件**；
 *  ② 空 / 缺 snapshotId → 400，且**绝不调用引擎**（挡在写动作之前，而不是让引擎去猜）；
 *  ③ 它挂 mutation gate（与 /snapshots/delete、/backup-files/delete 同类）——
 *     用直通包壳记录「被包过」，防止将来有人把 gate 摘掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'

interface Probes {
  gated: string[]
  deleted: string[]
}

/** 本组路由需要的 env（其余成员在本次调用路径上不被读取）。 */
function envFor(p: Probes): never {
  const env = {
    syncDir: '/tmp/dsh-cm-sync-delete',
    msg: (key: string) => key,
    prepareSync: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://example.com/repo.git' } }),
    makeSyncEngine: () => ({
      // 真引擎返回 DeleteSnapshotResult（RV1-F3：删除时放弃远端回收要能看见）。
      deleteSnapshot: async (id: string) => { p.deleted.push(id); return { warnings: ['gc skipped: reference-missing'] } },
    }),
    withMutationGate: (op: string, handler: unknown) => { p.gated.push(op); return handler },
  }
  return env as never
}

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p)
  assert.ok(found !== undefined, '路由缺失: ' + p)
  return found
}

function fakeRequest(opts: { method?: string; body?: string } = {}): IncomingMessage {
  const req = {
    method: opts.method ?? 'GET',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8')
    },
  }
  return req as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body) as unknown,
  }
}

const PATH = '/api/dsh-config-manager/sync/snapshot-delete'

test('POST /sync/snapshot-delete：把 snapshotId 交给引擎 deleteSnapshot（只动远端）', async () => {
  const probes: Probes = { gated: [], deleted: [] }
  const route = routeByPath(syncRoutes(envFor(probes)), PATH)
  assert.ok(probes.gated.includes('sync-snapshot-delete'), '必须经 withMutationGate 包壳（破坏性写动作）')

  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{"transport":"git","snapshotId":" snap-7 "}' }), res.res)
  assert.equal(res.status(), 200)
  assert.deepEqual(res.json(), { ok: true, snapshotId: 'snap-7', warnings: ['gc skipped: reference-missing'] })
  assert.deepEqual(probes.deleted, ['snap-7'], 'id 必须 trim 后原样透传（不做任何猜测/改写）')
})

test('POST /sync/snapshot-delete：缺 / 空 snapshotId → 400，且绝不调用引擎', async () => {
  for (const body of ['{"transport":"git"}', '{"transport":"git","snapshotId":""}', '{"transport":"git","snapshotId":"   "}']) {
    const probes: Probes = { gated: [], deleted: [] }
    const route = routeByPath(syncRoutes(envFor(probes)), PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', body }), res.res)
    assert.equal(res.status(), 400, '必须挡在写动作之前：' + body)
    assert.deepEqual(probes.deleted, [], '不得把空 id 交给引擎：' + body)
  }
})
