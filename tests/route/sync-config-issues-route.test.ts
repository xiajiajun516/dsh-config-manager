/**
 * SEC-03 读侧可见性：**已存但被拒**的 git repoUrl 不能伪装成「未配置」。
 *
 * 背景（审计 SEC-01/02/03/12 + 本轮 task-18）：写入侧与读取侧都已用同一份
 * `validateRepoUrl` 白名单（sync-config.ts），被拒的地址会让 `readFullSyncConfig` 把
 * git 命名空间整块丢掉 —— 这本身是对的（绝不把可疑地址交给凭据注入与 git 子进程），
 * 但丢掉之后如果什么都不说，界面看到的就是「你还没配置」，用户永远查不出为什么保存过的
 * 地址不见了。所以三处读配置的地方都必须把 issues 收上来结构化回传：
 *
 *  ① GET /sync/status → `configIssues`（默认空数组，合法配置不产生幻影告警）；
 *  ② POST /sync/workdir/reset → 400 时带 `configIssues`，且错误**不是**「尚未配置」
 *     而是地址被拒的真实原因（挡在任何重建动作之前）；
 *  ③ POST /sync/config → 同样带 `configIssues`（写完即为空，字段恒在，供客户端统一读取）。
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

const STATUS_PATH = '/api/dsh-config-manager/sync/status'
const RESET_PATH = '/api/dsh-config-manager/sync/workdir/reset'
const CONFIG_PATH = '/api/dsh-config-manager/sync/config'

/** 私网字面量：白名单（SEC-03）拒绝的典型形态。 */
const REJECTED_URL = 'https://192.168.1.10/owner/repo.git'
const VALID_URL = 'https://github.com/owner/repo.git'

const FACTS = {
  path: '/tmp/dsh-cm/sync/work',
  exists: true,
  origin: VALID_URL,
  pushUrl: null,
  match: true,
  ahead: null,
  dirty: null,
}

interface Probes {
  gated: string[]
  inspected: string[]
  rebuilt: Array<{ repoUrl: string; mode: string }>
}

function probes(): Probes {
  return { gated: [], inspected: [], rebuilt: [] }
}

/** 建一个只含 sync-config.json 的临时同步目录（schemaVersion=2 git 命名空间）。 */
async function makeSyncDir(t: test.TestContext, repoUrl: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-config-issues-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  if (repoUrl !== null) {
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({ schemaVersion: 2, transport: 'git', git: { repoUrl } }), 'utf8')
  }
  return dir
}

function envFor(syncDir: string, p: Probes): never {
  const env = {
    syncDir,
    msg: (key: string, params?: Record<string, string>) => (params === undefined ? key : key + ':' + JSON.stringify(params)),
    credentials: { describe: async () => ({ configured: false }), set: async () => {}, unset: async () => {} },
    syncSectionCatalog: [],
    syncCredentialsByChannelView: async () => ({}),
    selectionView: async () => ({}),
    selectionViewByChannel: async () => ({}),
    // 状态里的 workDir 自检：记录被问到的地址（被拒的地址必须**根本没被问到**）
    syncWorkDir: {
      inspect: async (repoUrl: string) => { p.inspected.push(repoUrl); return { facts: FACTS } },
      rebuild: async (repoUrl: string, mode: string) => { p.rebuilt.push({ repoUrl, mode }); return FACTS },
    },
    withMutationGate: (op: string, handler: unknown) => { p.gated.push(op); return handler },
    prepareSync: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: VALID_URL } }),
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

interface IssueRow { code: string; channel: string; message: string }

function issuesOf(body: Record<string, unknown>): IssueRow[] {
  const raw = body['configIssues']
  assert.ok(Array.isArray(raw), 'configIssues 必须是数组（字段恒在），实际: ' + JSON.stringify(raw))
  return raw as IssueRow[]
}

test('SEC-03：已存 repoUrl 被白名单拒绝 → status 回 configIssues（不是静默「未配置」）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, REJECTED_URL), p)), STATUS_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200, '一块配置成因不该让状态接口 500')
  const body = res.json()
  assert.equal(body['configured'], false, '被拒的 git 通道确实视为未配置（不把可疑地址交下去）')
  assert.equal(body['repoUrl'], undefined, '被拒地址绝不回填给表单')
  const issues = issuesOf(body)
  assert.equal(issues.length, 1, '必须如实说明「为什么没配」，实际: ' + JSON.stringify(issues))
  assert.equal(issues[0]!.code, 'repo-url-invalid')
  assert.equal(issues[0]!.channel, 'git')
  assert.ok(issues[0]!.message.includes('192.168.1.10'), '成因要带上地址，否则用户无从查起: ' + issues[0]!.message)
  assert.deepEqual(p.inspected, [], '被拒地址绝不进 workDir 自检（不 spawn git）')
})

test('SEC-03：合法 https repoUrl → configIssues 恒为空数组（无幻影告警）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, VALID_URL), p)), STATUS_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200)
  const body = res.json()
  assert.equal(body['repoUrl'], VALID_URL)
  assert.deepEqual(issuesOf(body), [], '合法配置不得产生任何 issue')
  assert.deepEqual(p.inspected, [VALID_URL], '合法地址照旧自检')
})

test('SEC-03：未配置任何通道 → configIssues 仍是空数组（字段恒在，客户端无需判空）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, null), p)), STATUS_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200)
  assert.equal(res.json()['configured'], false)
  assert.deepEqual(issuesOf(res.json()), [])
})

test('SEC-03：workdir/reset 遇被拒地址 → 400 带真实成因（不是「尚未配置」），且绝不重建', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, REJECTED_URL), p)), RESET_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{"mode":"relink"}' }), res.res)
  assert.equal(res.status(), 400)
  const body = res.json()
  assert.deepEqual(p.rebuilt, [], '挡在任何重建动作之前')
  const err = String(body['error'])
  assert.notEqual(err, 'sync.workdirNotConfigured', '不能把「地址被拒」说成「尚未配置」')
  assert.ok(err.includes('192.168.1.10'), '错误文案要带真实成因: ' + err)
  const issues = issuesOf(body)
  assert.equal(issues.length, 1, '同样要结构化回传 issues')
  assert.equal(issues[0]!.code, 'repo-url-invalid')
})

test('SEC-03：workdir/reset 未配置任何通道 → 仍是原来的「尚未配置」（不冒充被拒）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, null), p)), RESET_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{"mode":"relink"}' }), res.res)
  assert.equal(res.status(), 400)
  assert.equal(String(res.json()['error']), 'sync.workdirNotConfigured')
  assert.deepEqual(issuesOf(res.json()), [])
})

test('SEC-03：POST /sync/config 响应也带 configIssues（写完为空，字段恒在）', async (t) => {
  const p = probes()
  const route = routeByPath(syncRoutes(envFor(await makeSyncDir(t, null), p)), CONFIG_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{"transport":"git","repoUrl":"' + VALID_URL + '"}' }), res.res)
  assert.equal(res.status(), 200)
  assert.equal(res.json()['configured'], true)
  assert.deepEqual(issuesOf(res.json()), [])
})
