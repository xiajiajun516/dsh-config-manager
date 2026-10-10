/**
 * 回归：issue #79 —— git 工作副本的自检（GET /sync/status 的 workDir 字段）与显式重建
 * （POST /sync/workdir/reset）。
 *
 * 四条钉住：
 *  ① 状态接口把自检结果**如实**回传（facts）；自检读不出来时回 `{ error }` 而**不是**伪装成
 *     「工作副本不存在」，且状态接口整体仍 200（一块可选信息不该让整页 500）；
 *  ② relink / reclone 两种模式的校验：非法 mode、reclone 缺 confirm、未配置 repoUrl
 *     一律 400 **且绝不调用重建**（挡在写动作之前）；
 *  ③ 重建只把 (repoUrl, mode) 交给宿主端口 —— 路由自己不拼 git 命令、不碰路径；
 *  ④ 它挂 mutation gate（写动作），用直通包壳记录「被包过」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { SYNC_CONFIG_FILE } from '../../src/sync/sync-config.ts'

const REPO_URL = 'ssh://git@nas.local:2222/owner/repo.git'
const STATUS_PATH = '/api/dsh-config-manager/sync/status'
const RESET_PATH = '/api/dsh-config-manager/sync/workdir/reset'

const FACTS = {
  path: '/tmp/dsh-cm/sync/work',
  exists: true,
  origin: 'ssh://git@old.example:2222/owner/repo.git',
  pushUrl: null,
  match: false,
  ahead: null,
  dirty: null,
}

interface Probes {
  gated: string[]
  inspected: number
  rebuilt: Array<{ repoUrl: string; mode: string }>
  /** 自检返回：facts / error */
  inspect: { facts: typeof FACTS } | { error: string }
}

async function makeSyncDir(t: test.TestContext, withGitConfig = true): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-workdir-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  if (withGitConfig) {
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({ schemaVersion: 2, transport: 'git', git: { repoUrl: REPO_URL } }), 'utf8')
  }
  return dir
}

/** 本组路由需要的 env（其余成员在本次调用路径上不被读取）。 */
function envFor(syncDir: string, p: Probes): never {
  const env = {
    syncDir,
    msg: (key: string, params?: Record<string, string>) => (params === undefined ? key : key + ':' + JSON.stringify(params)),
    credentials: { describe: async () => ({ configured: false }), set: async () => {}, unset: async () => {} },
    syncSectionCatalog: [],
    syncCredentialsByChannelView: async () => ({}),
    selectionView: async () => ({}),
    selectionViewByChannel: async () => ({}),
    syncWorkDir: {
      inspect: async (repoUrl: string) => { p.inspected += 1; assert.equal(repoUrl, REPO_URL); return p.inspect },
      rebuild: async (repoUrl: string, mode: string) => { p.rebuilt.push({ repoUrl, mode }); return FACTS },
    },
    withMutationGate: (op: string, handler: unknown) => { p.gated.push(op); return handler },
  }
  return env as never
}

function probes(inspect: Probes['inspect'] = { facts: FACTS }): Probes {
  return { gated: [], inspected: 0, rebuilt: [], inspect }
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

test('issue #79：GET /sync/status 回传工作副本自检 facts（只读，不阻断状态接口）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t), p)), STATUS_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200)
  assert.deepEqual(res.json()['workDir'], { facts: FACTS })
  assert.equal(p.inspected, 1, '自检只跑一次')
})

test('issue #79：自检读不出来 → 如实回 { error }，状态接口仍 200（不伪装成「不存在」）', async (t) => {
  const p = probes({ error: 'git 不可用' })
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t), p)), STATUS_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200, '一块可选信息不该让整页 500')
  assert.deepEqual(res.json()['workDir'], { error: 'git 不可用' })
})

test('issue #79：POST /sync/workdir/reset —— relink 默认、reclone 需 confirm，且经 mutation gate', async (t) => {
  const syncDir = await makeSyncDir(t)

  const p1 = probes()
  const route = routeByPath(syncRoutes(envFor(syncDir, p1)), RESET_PATH)
  assert.ok(p1.gated.includes('sync-workdir-reset'), '写动作必须经 withMutationGate')
  const r1 = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{}' }), r1.res)
  assert.equal(r1.status(), 200)
  assert.deepEqual(r1.json(), { ok: true, mode: 'relink', workDir: { facts: FACTS } })
  assert.deepEqual(p1.rebuilt, [{ repoUrl: REPO_URL, mode: 'relink' }], '缺省 = 非破坏性的重指向')

  const p2 = probes()
  const route2 = routeByPath(syncRoutes(envFor(syncDir, p2)), RESET_PATH)
  const r2 = fakeResponse()
  await route2.handler(fakeRequest({ method: 'POST', body: '{"mode":"reclone","confirm":true}' }), r2.res)
  assert.equal(r2.status(), 200)
  assert.equal(r2.json()['mode'], 'reclone')
  assert.deepEqual(p2.rebuilt, [{ repoUrl: REPO_URL, mode: 'reclone' }])
})

test('issue #79：非法 mode / reclone 缺 confirm / 未配置地址 → 400，且绝不调用重建', async (t) => {
  const configured = await makeSyncDir(t)
  const unconfigured = await makeSyncDir(t, false)
  const cases: Array<{ dir: string; body: string; why: string }> = [
    { dir: configured, body: '{"mode":"nuke"}', why: '非法 mode' },
    { dir: configured, body: '{"mode":"reclone"}', why: 'reclone 未显式确认' },
    { dir: configured, body: '{"mode":"reclone","confirm":false}', why: 'reclone confirm=false' },
    { dir: unconfigured, body: '{"mode":"relink"}', why: '未配置仓库地址' },
  ]
  for (const c of cases) {
    const p = probes()
    const route = routeByPath(syncRoutes(envFor(c.dir, p)), RESET_PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', body: c.body }), res.res)
    assert.equal(res.status(), 400, '必须挡在写动作之前: ' + c.why)
    assert.deepEqual(p.rebuilt, [], '不得调用重建: ' + c.why)
  }
})
