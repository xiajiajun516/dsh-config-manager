/**
 * 回归：POST /sync/rollback 的诚实性（2026-10）。
 *
 * 一键同步回滚此前只回 `{ ok: true, full }`，把 `report.failed` / `manualHint` 丢了 ——
 * 用户看到「已回滚」，而「目标机原本已有该凭据值、DSH 不可回读」这类项其实一项都没恢复
 * （core/rollback.ts 只产 reason + manualHint 且 full=false）。这里钉住两条：
 *  ① full=false 时未回滚项（含人工提示）必须随响应回传，供界面逐条列出；
 *  ② 真正回滚干净时 full=true 且 failed 为空（诚实性不能反向失真）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { createSnapshot, FileSnapshotStore } from '../../src/core/backup.ts'
import type { ImportPlan, Snapshot } from '../../src/core/types.ts'
import type { SectionId } from '../../src/schema/types.ts'
import { makeContext, type MockHostContext } from '../../src/adapters/test-helpers.ts'

const PATH = '/api/dsh-config-manager/sync/rollback'

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p)
  assert.ok(found !== undefined, '路由缺失: ' + p)
  return found
}

/** 最小可代理请求：只喂 body（围栏由 kit 在注册点包装，这里直接调 handler）。 */
function fakeRequest(body: string): IncomingMessage {
  const req = {
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> { yield Buffer.from(body, 'utf8') },
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

/** 指向 credentialsStatus 的计划项：目标机已有该凭据 → 快照 existed=true → 回滚必然失败。 */
function credentialPlan(ref: string): ImportPlan {
  return {
    items: [{
      id: `secret:${ref}`,
      kind: 'MissingSecret',
      adapter: 'credentialsStatus',
      description: `补录凭据 ${ref}`,
      severity: 'warning',
      target: { adapter: 'credentialsStatus', ref },
    }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: {} as unknown as Record<SectionId, number>,
  }
}

/** 在 syncDir/snapshots 下落一份真实快照（FileSnapshotStore 与路由读的目录一致）。 */
async function seedSnapshot(dir: string, ctx: MockHostContext, ref: string): Promise<Snapshot> {
  const store = new FileSnapshotStore({ dir: path.join(dir, 'snapshots') })
  return await createSnapshot({ ctx, plan: credentialPlan(ref), sourceZip: 'C:/tmp/apply.zip', store, adapters: [] })
}

function envFor(dir: string, ctx: MockHostContext): never {
  const env = {
    syncDir: dir,
    host: ctx,
    adapters: [],
    msg: (key: string) => key,
    tryAppendHistory: async () => undefined,
    withMutationGate: (_op: string, handler: unknown) => handler,
  }
  return env as never
}

test('rollback: full=false 时未回滚项（含 manualHint）必须随响应回传（不得只回 ok/full）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-rollback-partial-'))
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice')
    ctx.credentials.values.set('KEEP', 'old-secret') // 目标机原本已配置 → 快照 existed=true
    const snap = await seedSnapshot(dir, ctx, 'KEEP')
    const route = routeByPath(syncRoutes(envFor(dir, ctx)), PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest(JSON.stringify({ restoreId: snap.id })), res.res)
    assert.equal(res.status(), 200)
    const body = res.json()
    assert.equal(body['ok'], true)
    assert.equal(body['full'], false, '有未回滚项 ⇒ full:false，绝不谎报完整回滚')
    const failed = body['failed'] as Array<Record<string, unknown>> | undefined
    assert.equal(Array.isArray(failed), true, 'failed 必须回传（旧实现整个字段丢失）')
    assert.equal(failed!.length, 1)
    assert.equal(failed![0]?.['item'], 'credentialsStatus:KEEP')
    assert.equal(typeof failed![0]?.['reason'], 'string')
    assert.equal(typeof failed![0]?.['manualHint'], 'string', '人工提示必须给出（用户据此补录）')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('rollback: 回滚干净 → full=true 且 failed 为空（诚实性不反向失真）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-rollback-full-'))
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice')
    const snap = await seedSnapshot(dir, ctx, 'ABSENT') // 目标机没有该凭据 → existed=false → unset 成功
    const route = routeByPath(syncRoutes(envFor(dir, ctx)), PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest(JSON.stringify({ restoreId: snap.id })), res.res)
    assert.equal(res.status(), 200)
    const body = res.json()
    assert.equal(body['full'], true)
    assert.deepEqual(body['failed'], [], '没有未回滚项时 failed 为空数组')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})