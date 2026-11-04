/**
 * 「我的配置」（/me/*）路由组回归：7 条 POST 各自的状态码 / 关键字段 / 副作用。
 *  - 状态：未登录（no_token / 401）是 200 loggedIn:false，其它故障是 500 —— 两者绝不能混；
 *  - 上传/更新：zipPath 必须落在受控暂存区内（越界一律 400，读都不读），form 只透传白名单字段；
 *  - 列表/收录/下架/删除：401 与 404（item_not_found）必须各归各位，错误文本一律脱敏。
 *
 * 为什么必须钉：这组路由把用户配置推到公开仓库。错一个状态码，界面就把「没登录」渲染成
 * 「登录状态读取失败」、把「条目不存在」渲染成 500；错一处 zipPath 守卫，就能读走任意本机文件。
 * 既有 tests/route/me-auth-mapping.test.ts 只是**源码扫描**（isGitHubAuthMissing 的归类），
 * 从不执行 handler —— 本文件补的正是 handler 的真实行为，不与之重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { meRoutes } from '../../src/routes/me.ts'
import { routeSpecOf } from '../../src/routes/kit.ts'
import type { WebRoute } from '../../src/routes/kit.ts'
import { GitHubApiError } from '../../src/market/github-repos.ts'
import { MyRepoError } from '../../src/market/my-repo.ts'

const BASE = '/api/dsh-config-manager/me'

interface MeForm {
  name: string
  id?: string
  description?: string
  categories?: string[]
  mode?: 'migrate' | 'share'
}

interface UploadCall {
  zipBytes: Buffer
  form: MeForm
}

interface ServiceLog {
  uploads: UploadCall[]
  updates: UploadCall[]
  listItems: number
  listings: string[]
  relists: string[]
  deletes: string[]
}

interface Harness {
  routes: WebRoute[]
  stageDir: string
  log: ServiceLog
  /** 登录用户（null = 未配置 token / 401 未登录；Error = 其它故障） */
  setUser: (user: { login: string } | Error) => void
  setRepoExists: (exists: boolean) => void
  /** 让下一个 meService 方法抛这个错误（undefined = 正常返回） */
  setServiceError: (error: Error | undefined) => void
  /** listingStatus 的返回值（null = 无任务且无实况） */
  setListingStatus: (status: unknown) => void
  cleanup: () => void
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-me-routes-'))
  const stageDir = path.join(dir, 'uploads')
  fs.mkdirSync(stageDir, { recursive: true })
  const log: ServiceLog = { uploads: [], updates: [], listItems: 0, listings: [], relists: [], deletes: [] }
  let user: { login: string } | Error = { login: 'alice' }
  let repoExists = true
  let serviceError: Error | undefined
  let listingStatus: unknown = { status: 'pr-pending' }

  const meGitHubRest = {
    async getUser() {
      if (user instanceof Error) throw user
      return user
    },
    async repoExists(_owner: string, _repo: string) {
      if (user instanceof Error) throw user
      return repoExists
    },
  }
  const failIfSet = (): void => { if (serviceError !== undefined) throw serviceError }
  const meService = {
    async upload(input: UploadCall) { log.uploads.push(input); failIfSet(); return { ok: true, id: 'item-1', version: 1 } },
    async update(input: UploadCall) { log.updates.push(input); failIfSet(); return { ok: true, id: 'item-1', version: 2 } },
    async listItems() { log.listItems += 1; failIfSet(); return [{ id: 'item-1', name: 'cfg' }] },
    async listingStatus(itemId: string) { log.listings.push(itemId); failIfSet(); return listingStatus },
    async relist(itemId: string) { log.relists.push(itemId); failIfSet(); return { ok: true, id: itemId } },
    async deleteItem(itemId: string) { log.deletes.push(itemId); failIfSet(); return { ok: true, id: itemId } },
  }
  const env = { meGitHubRest, meService, roots: [stageDir] } as never
  return {
    routes: meRoutes(env),
    stageDir,
    log,
    setUser: (next) => { user = next },
    setRepoExists: (next) => { repoExists = next },
    setServiceError: (next) => { serviceError = next },
    setListingStatus: (next) => { listingStatus = next },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function routeOf(h: Harness, routePath: string): WebRoute {
  const route = h.routes.find((r) => r.path === BASE + routePath && routeSpecOf(r)?.methods.includes('POST') === true)
  assert.ok(route !== undefined, '缺少 POST ' + BASE + routePath)
  return route
}

interface FakeResponse { status: number; body: string }

async function call(h: Harness, routePath: string, body?: unknown): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const req = {
    method: 'POST',
    url: BASE + routePath,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8') },
  } as unknown as IncomingMessage
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await routeOf(h, routePath).handler(req, res as unknown as ServerResponse)
  return state
}

function json(response: FakeResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

function writeStaged(h: Harness, name = 'cfg.zip'): string {
  const file = path.join(h.stageDir, name)
  fs.writeFileSync(file, Buffer.from('PK\u0003\u0004fake-zip-bytes', 'utf8'))
  return file
}

/* ---------------------------------------------------------------- me/status */

test('Y-01 me/status 已登录：loggedIn + login + repoUrl + repoExists', async () => {
  const h = harness()
  try {
    const response = await call(h, '/status')
    assert.equal(response.status, 200)
    assert.deepEqual(json(response), {
      loggedIn: true,
      login: 'alice',
      repoUrl: 'https://github.com/alice/dsh-configs',
      repoExists: true,
    })
    h.setRepoExists(false)
    assert.equal(json(await call(h, '/status')).repoExists, false, '仓库不存在必须如实回 false')
  } finally {
    h.cleanup()
  }
})

test('Y-02 me/status 未登录：no_token 与 401 同一条分支（200 loggedIn:false，且不探仓库）', async () => {
  const h = harness()
  try {
    for (const error of [new GitHubApiError('no token configured', 'no_token'), new GitHubApiError('Bad credentials', 'unauthorized', 401)]) {
      h.setUser(error)
      const response = await call(h, '/status')
      assert.equal(response.status, 200, error.code + ' 不是故障，不能报 500')
      const body = json(response)
      assert.equal(body['loggedIn'], false)
      assert.equal(body['repoExists'], false)
      assert.equal('login' in body, false, '未登录不得回传登录名')
      assert.equal('repoUrl' in body, false, '未登录不得回传仓库地址')
      assert.deepEqual(Object.keys(body).sort(), ['loggedIn', 'repoExists'])
    }
  } finally {
    h.cleanup()
  }
})

test('Y-03 me/status 其它故障：500 + 脱敏错误，绝不伪装成「未登录」', async () => {
  const h = harness()
  try {
    h.setUser(new GitHubApiError('connect ETIMEDOUT token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'network_error'))
    const response = await call(h, '/status')
    assert.equal(response.status, 500, '网络/限流/服务端故障仍是故障')
    const body = json(response)
    assert.equal('loggedIn' in body, false, '故障不得被折成 loggedIn:false')
    assert.equal(typeof body['error'], 'string')
    assert.ok(!response.body.includes('ghp_A1b2C3d4'), '错误文本必须脱敏: ' + response.body)
  } finally {
    h.cleanup()
  }
})

test('Y-04 me/status 是只读查询：连续两次结果一致（不缓存、不写状态）', async () => {
  const h = harness()
  try {
    const first = await call(h, '/status')
    const second = await call(h, '/status')
    assert.equal(second.status, first.status)
    assert.deepEqual(json(second), json(first))
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- me/upload + me/update */

test('Y-05 me/upload 成功：受控暂存文件被读入，form 只透传白名单字段', async () => {
  const h = harness()
  try {
    const zipPath = writeStaged(h)
    const response = await call(h, '/upload', {
      zipPath,
      form: { name: '  我的配置  ', description: '  desc  ', categories: ['a', '  ', 'b'], mode: 'share', token: 'ghp_should_not_pass' },
    })
    assert.equal(response.status, 200, response.body)
    assert.equal(json(response)['ok'], true)
    assert.equal(h.log.uploads.length, 1)
    const sent = h.log.uploads[0]
    assert.ok(sent !== undefined, '上传通道必须收到一次调用')
    assert.equal(sent.zipBytes.toString('utf8'), 'PK\u0003\u0004fake-zip-bytes', '上传的必须是那个暂存文件的字节')
    assert.deepEqual(sent.form, { name: '我的配置', description: 'desc', categories: ['a', 'b'], mode: 'share' })
    assert.equal('token' in sent.form, false, '未知 form 字段不得透传给 service')
  } finally {
    h.cleanup()
  }
})

test('Y-06 me/upload 守卫：zipPath 越界 / 缺 form.name 一律 400，且 service 一次都不被调用', async () => {
  const h = harness()
  try {
    const outside = path.join(os.tmpdir(), 'dcm-me-outside-' + process.pid + '.zip')
    fs.writeFileSync(outside, Buffer.from('PK', 'utf8'))
    const cases: { body: unknown; hint: string }[] = [
      { body: {}, hint: '缺 zipPath' },
      { body: { zipPath: '' }, hint: '空 zipPath' },
      { body: { zipPath: outside }, hint: '暂存区外的绝对路径' },
      { body: { zipPath: '../escape.zip' }, hint: '相对穿越路径' },
      { body: { zipPath: path.join(h.stageDir, 'cfg.zip') }, hint: '缺 form（文件不存在也不许先读）' },
      { body: { zipPath: path.join(h.stageDir, 'cfg.zip'), form: { name: '   ' } }, hint: 'form.name 只有空白' },
      { body: { zipPath: path.join(h.stageDir, 'cfg.zip'), form: 'name=cfg' }, hint: 'form 不是对象' },
    ]
    for (const item of cases) {
      const response = await call(h, '/upload', item.body)
      assert.equal(response.status, 400, item.hint + ' → ' + response.body)
      assert.equal(typeof json(response)['error'], 'string')
    }
    assert.equal(h.log.uploads.length, 0, '守卫命中时不得触碰 service')
    fs.rmSync(outside, { force: true })
  } finally {
    h.cleanup()
  }
})

test('Y-07 me/upload 故障：service 抛错 → 500 + 脱敏错误', async () => {
  const h = harness()
  try {
    const zipPath = writeStaged(h)
    h.setServiceError(new Error('push rejected for token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'))
    const response = await call(h, '/upload', { zipPath, form: { name: 'cfg' } })
    assert.equal(response.status, 500)
    assert.ok(!response.body.includes('ghp_A1b2C3d4'), '错误文本必须脱敏: ' + response.body)
    assert.equal(h.log.uploads.length, 1, '失败也要能被观测到确实调用了 service')
  } finally {
    h.cleanup()
  }
})

test('Y-08 me/update 成功：走 update 分支（带显式 id），与 upload 不是同一条通道', async () => {
  const h = harness()
  try {
    const zipPath = writeStaged(h, 'update.zip')
    const response = await call(h, '/update', { zipPath, form: { name: 'cfg', id: ' item-9 ', mode: 'migrate' } })
    assert.equal(response.status, 200, response.body)
    assert.equal(json(response)['version'], 2, '回执必须是 service 的真实返回值')
    assert.equal(h.log.uploads.length, 0, 'update 不得落进 upload 通道')
    assert.deepEqual(h.log.updates.map((u) => u.form), [{ name: 'cfg', id: 'item-9', mode: 'migrate' }])
  } finally {
    h.cleanup()
  }
})

test('Y-09 me/update 校验与 upload 同口径（越界 zipPath / 缺 form.name = 400）', async () => {
  const h = harness()
  try {
    const outside = path.join(os.tmpdir(), 'dcm-me-outside-upd-' + process.pid + '.zip')
    fs.writeFileSync(outside, Buffer.from('PK', 'utf8'))
    for (const body of [{ zipPath: outside, form: { name: 'cfg' } }, { zipPath: writeStaged(h, 'u.zip') }, { zipPath: '', form: { name: 'cfg' } }]) {
      const response = await call(h, '/update', body)
      assert.equal(response.status, 400, JSON.stringify(body) + ' → ' + response.body)
    }
    assert.equal(h.log.updates.length, 0)
    fs.rmSync(outside, { force: true })
  } finally {
    h.cleanup()
  }
})

test('Y-10 me/update 故障：service 抛错 → 500 + 脱敏错误', async () => {
  const h = harness()
  try {
    h.setServiceError(new Error('boom ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'))
    const response = await call(h, '/update', { zipPath: writeStaged(h), form: { name: 'cfg' } })
    assert.equal(response.status, 500)
    assert.ok(!response.body.includes('ghp_A1b2C3d4'), response.body)
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- me/items */

test('Y-11 me/items：成功 200 {items}；未登录 401；其它故障 500', async () => {
  const h = harness()
  try {
    const ok = await call(h, '/items')
    assert.equal(ok.status, 200)
    assert.deepEqual(json(ok)['items'], [{ id: 'item-1', name: 'cfg' }])

    h.setServiceError(new GitHubApiError('Bad credentials', 'unauthorized', 401))
    assert.equal((await call(h, '/items')).status, 401, 'token 过期要 401（界面据此引导重新登录）')

    h.setServiceError(new GitHubApiError('server error', 'server_error', 502))
    const failure = await call(h, '/items')
    assert.equal(failure.status, 500)
    assert.equal(typeof json(failure)['error'], 'string')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- me/listing */

test('Y-12 me/listing：状态原样回传（含 null）、缺 itemId 400、401 与 500 分派', async () => {
  const h = harness()
  try {
    const ok = await call(h, '/listing', { itemId: 'item-1' })
    assert.equal(ok.status, 200)
    assert.deepEqual(json(ok), { status: 'pr-pending' })
    assert.deepEqual(h.log.listings, ['item-1'])

    h.setListingStatus(null)
    const none = await call(h, '/listing', { itemId: 'item-1' })
    assert.equal(none.status, 200, '没有任务也没有实况 = 200 null，不是 404')
    assert.equal(none.body, 'null', '必须原样回 null，界面据此显示「未收录」')

    assert.equal((await call(h, '/listing', {})).status, 400)
    assert.equal((await call(h, '/listing', { itemId: '' })).status, 400)
    assert.equal((await call(h, '/listing', { itemId: 42 })).status, 400, '非字符串 itemId 不猜')

    h.setServiceError(new GitHubApiError('no token configured', 'no_token'))
    assert.equal((await call(h, '/listing', { itemId: 'item-1' })).status, 401)

    h.setServiceError(new Error('unexpected'))
    const failure = await call(h, '/listing', { itemId: 'item-1' })
    assert.equal(failure.status, 500)
    assert.equal(typeof json(failure)['error'], 'string')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- me/relist + me/delete */

test('Y-13 me/relist：成功 200；缺 itemId 400；item_not_found 404；401/500 分派', async () => {
  const h = harness()
  try {
    const ok = await call(h, '/relist', { itemId: 'item-1' })
    assert.equal(ok.status, 200)
    assert.deepEqual(h.log.relists, ['item-1'], '重试必须直达 service（幂等由 service 保证）')

    assert.equal((await call(h, '/relist', {})).status, 400)

    h.setServiceError(new MyRepoError('item not found', 'item_not_found'))
    assert.equal((await call(h, '/relist', { itemId: 'gone' })).status, 404)

    h.setServiceError(new GitHubApiError('Bad credentials', 'unauthorized', 401))
    assert.equal((await call(h, '/relist', { itemId: 'item-1' })).status, 401)

    h.setServiceError(new MyRepoError('index write failed', 'index_write'))
    assert.equal((await call(h, '/relist', { itemId: 'item-1' })).status, 500, '其它 MyRepoError 不得折成 404')
  } finally {
    h.cleanup()
  }
})

test('Y-14 me/delete：成功 200；缺 itemId 400；item_not_found 404；no_token 401', async () => {
  const h = harness()
  try {
    const ok = await call(h, '/delete', { itemId: 'item-1' })
    assert.equal(ok.status, 200)
    assert.deepEqual(h.log.deletes, ['item-1'])

    assert.equal((await call(h, '/delete', {})).status, 400)

    h.setServiceError(new MyRepoError('item not found', 'item_not_found'))
    assert.equal((await call(h, '/delete', { itemId: 'gone' })).status, 404)

    h.setServiceError(new GitHubApiError('no token configured', 'no_token'))
    assert.equal((await call(h, '/delete', { itemId: 'item-1' })).status, 401)
  } finally {
    h.cleanup()
  }
})
