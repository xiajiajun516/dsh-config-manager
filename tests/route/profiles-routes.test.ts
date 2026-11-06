/**
 * 档案（/profiles/*）路由组回归：8 条端点的状态码 / 关键字段 / 真实副作用（磁盘目录、台账、审计）。
 *  - 读路径：列表把「台账（本插件启动、带 URL）」与「心跳（任何在跑的实例、无 URL）」合并成一份 running；
 *  - 写路径：create/copy/rename/delete 过 mutation gate，launch/stop **不过**（否则最长 20 s 的启动
 *    会把导入/恢复全挡在 423 后面）；
 *  - 护栏：当前档案不能启动/改名/删（除非 allowCurrent）；在跑的实例不能删；desktop 是 Electron 独占；
 *    profile 名先过引擎校验（穿越 / 保留名一律拒绝，不留半截目录）。
 *
 * 为什么必须钉：这组路由**物理删目录**、**起进程**、**改 package.json**。错一处守卫 = 删掉用户档案、
 * 同名多开、或把 desktop 档案改坏；错一处 running 合并 = 手动启动的实例对界面不可见（已实测过的真 bug）。
 * docs/known-issues/tech-debt.md #13 记的就是这组「零专用测试」，本文件是它的低成本范式落地。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { profileRoutes } from '../../src/routes/profiles.ts'
import { routeSpecOf } from '../../src/routes/kit.ts'
import type { WebRoute } from '../../src/routes/kit.ts'
import {
  DSH_PROFILE_TEMPLATES,
  DshProfileError,
  DshProfileManager,
  type DshProfileLaunchRecord,
  type DshProfileRuntimeRecord,
} from '../../src/profiles/index.ts'

const BASE = '/api/dsh-config-manager/profiles'

interface HistoryEntry {
  kind: string
  result: string
  sections: string[]
  source: string
  summary: string
}

interface LauncherState {
  running: DshProfileLaunchRecord[]
  launched: { name: string; shape: string }[]
  stopped: string[]
}

interface RuntimeState {
  active: DshProfileRuntimeRecord[]
  stoppedExternal: string[]
}

interface Harness {
  routes: WebRoute[]
  home: string
  profiles: DshProfileManager
  launcher: LauncherState
  runtime: RuntimeState
  history: HistoryEntry[]
  /** mutation gate 在注册期登记的操作名（顺序即声明顺序） */
  gateOps: string[]
  setCurrent: (name: string) => void
  setSessionFormatVersion: (value: number | undefined) => void
  /** 让审计写入返回错误码（模拟磁盘满） */
  setHistoryError: (code: string | undefined) => void
  /** 让启动器抛这个错误（模拟 notLaunchable / launchFailed） */
  setLaunchError: (error: Error | undefined) => void
  /** 让运行时停机抛这个错误（模拟 notRunning / currentProfile / stopFailed） */
  setStopExternalError: (error: Error | undefined) => void
  profileDir: (name: string) => string
  cleanup: () => void
}

function harness(): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-profiles-routes-'))
  let current = 'web'
  let sessionFormatVersion: number | undefined = 3
  let historyError: string | undefined
  let launchError: Error | undefined
  let stopExternalError: Error | undefined
  const launcher: LauncherState = { running: [], launched: [], stopped: [] }
  const runtime: RuntimeState = { active: [], stoppedExternal: [] }
  const history: HistoryEntry[] = []
  const gateOps: string[] = []

  const profiles = new DshProfileManager({ homeDir: home, currentProfile: () => current })
  const env = {
    // host.profile 是惰性读取：同一个 harness 里可以模拟「当前档案换了一个」
    host: {
      get profile() { return current },
      get sessionFormatVersion() { return sessionFormatVersion },
      log: { info: () => undefined, warn: () => undefined },
    },
    profiles,
    profileRuntime: {
      listActive: () => runtime.active,
      async stopExternal(name: string) {
        if (stopExternalError !== undefined) throw stopExternalError
        runtime.stoppedExternal.push(name)
        return { name, result: 'killed' as const, port: 5005 }
      },
    },
    profileLauncher: {
      listRunning: () => launcher.running,
      async launch(input: { name: string; shape: string }) {
        if (launchError !== undefined) throw launchError
        launcher.launched.push({ name: input.name, shape: input.shape })
        const record: DshProfileLaunchRecord = {
          name: input.name,
          port: 4567,
          pid: 4321,
          url: 'http://127.0.0.1:4567/?token=abc',
          logFile: path.join(home, 'logs', input.name + '.log'),
          startedAt: '2026-11-04T10:00:00.000Z',
        }
        launcher.running.push(record)
        return { name: input.name, mode: 'web' as const, port: record.port, url: record.url, pid: record.pid, logFile: record.logFile, ready: true, warnings: [] }
      },
      async stop(name: string) {
        launcher.stopped.push(name)
        return { name, result: 'graceful' as const, port: 4567 }
      },
    },
    async tryAppendHistory(entry: HistoryEntry) {
      if (historyError !== undefined) return historyError
      history.push(entry)
      return undefined
    },
    withMutationGate(op: string, handler: unknown) {
      gateOps.push(op)
      return handler
    },
  } as never

  return {
    routes: profileRoutes(env),
    home,
    profiles,
    launcher,
    runtime,
    history,
    gateOps,
    setCurrent: (name) => { current = name },
    setSessionFormatVersion: (value) => { sessionFormatVersion = value },
    setHistoryError: (code) => { historyError = code },
    setLaunchError: (error) => { launchError = error },
    setStopExternalError: (error) => { stopExternalError = error },
    profileDir: (name) => path.join(home, 'profiles', name),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
}

function routeOf(h: Harness, routePath: string, method: 'GET' | 'POST'): WebRoute {
  const route = h.routes.find((r) => r.path === BASE + routePath && routeSpecOf(r)?.methods.includes(method) === true)
  assert.ok(route !== undefined, '缺少 ' + method + ' ' + BASE + routePath)
  return route
}

interface FakeResponse { status: number; body: string }

async function call(h: Harness, routePath: string, init: { method?: 'GET' | 'POST'; body?: unknown; query?: string } = {}): Promise<FakeResponse> {
  const method = init.method ?? 'POST'
  const state: FakeResponse = { status: 0, body: '' }
  const req = {
    method,
    url: BASE + routePath + (init.query ?? ''),
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(init.body ?? {}), 'utf8') },
  } as unknown as IncomingMessage
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await routeOf(h, routePath, method).handler(req, res as unknown as ServerResponse)
  return state
}

function json(response: FakeResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

function readManifest(h: Harness, name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(h.profileDir(name), 'package.json'), 'utf8')) as Record<string, unknown>
}

/* ---------------------------------------------------------------- 注册期契约 */

test('P-01 account：只有 create/copy/rename/delete 过 mutation gate，launch/stop 不过', () => {
  const h = harness()
  try {
    assert.deepEqual(h.gateOps, ['profile-create', 'profile-copy', 'profile-rename', 'profile-delete'])
    assert.equal(h.routes.length, 8, '档案组共 8 条端点')
    for (const [routePath, method] of [['', 'GET'], ['/launch', 'POST'], ['/detail', 'GET'], ['/create', 'POST'], ['/copy', 'POST'], ['/rename', 'POST'], ['/delete', 'POST'], ['/stop', 'POST']] as const) {
      assert.ok(routeOf(h, routePath, method) !== undefined)
    }
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- GET /profiles */

test('P-02 GET /profiles：空 home 返回空列表 + 模板 + 版本基准', async () => {
  const h = harness()
  try {
    const response = await call(h, '', { method: 'GET' })
    assert.equal(response.status, 200)
    const body = json(response)
    assert.equal(body['ok'], true)
    assert.deepEqual(body['profiles'], [])
    assert.deepEqual(body['running'], [])
    assert.equal(body['current'], 'web')
    assert.equal(body['currentSessionFormatVersion'], 3)
    assert.deepEqual((body['templates'] as { id: string }[]).map((t) => t.id), DSH_PROFILE_TEMPLATES.map((t) => t.id))

    h.setSessionFormatVersion(undefined)
    assert.equal(json(await call(h, '', { method: 'GET' }))['currentSessionFormatVersion'], null, '解析不到 = null，不编造版本')
  } finally {
    h.cleanup()
  }
})

test('P-03 GET /profiles：running 合并台账 ∪ 心跳（owned/url 各不相同），current 只标自己', async () => {
  const h = harness()
  try {
    h.profiles.create('alpha', 'web')
    h.profiles.create('beta', 'base')
    h.setCurrent('beta')
    // 心跳：手动 dsh 起的实例（没有 URL，不是本插件启动的）
    h.runtime.active.push({ schemaVersion: 1, name: 'alpha', pid: 777, port: null, startedAt: '2026-11-04T09:00:00.000Z', updatedAt: 1 })
    // 台账：本插件启动的实例（带认证 URL）
    h.launcher.running.push({ name: 'beta', port: 4567, pid: 4321, url: 'http://127.0.0.1:4567/?token=abc', logFile: '/tmp/beta.log', startedAt: '2026-11-04T09:30:00.000Z' })

    const body = json(await call(h, '', { method: 'GET' }))
    assert.deepEqual((body['profiles'] as { name: string }[]).map((p) => p.name), ['alpha', 'beta'])
    assert.equal(body['current'], 'beta')
    const running = body['running'] as { name: string; pid: number; port: number | null; url: string | null; owned: boolean; current: boolean }[]
    assert.deepEqual(running.map((r) => r.name), ['alpha', 'beta'], 'running 按名字排序')
    assert.deepEqual(running[0], {
      name: 'alpha', pid: 777, port: null, url: null, startedAt: '2026-11-04T09:00:00.000Z', owned: false, current: false,
    }, '心跳行：不是本插件启动的（owned:false），绝不带别人的 token URL')
    assert.deepEqual(running[1], {
      name: 'beta', pid: 4321, port: 4567, url: 'http://127.0.0.1:4567/?token=abc', startedAt: '2026-11-04T09:30:00.000Z', owned: true, current: true,
    }, '台账行：owned + 带认证 URL + 标出当前实例')
    // 台账更权威：同名同时在两处时以台账为准
    h.runtime.active.push({ schemaVersion: 1, name: 'beta', pid: 999, port: null, startedAt: '2026-11-04T08:00:00.000Z', updatedAt: 1 })
    const merged = json(await call(h, '', { method: 'GET' }))
    const beta = (merged['running'] as { name: string; pid: number }[]).find((r) => r.name === 'beta')
    assert.equal(beta?.pid, 4321, '同名以台账为准（更权威：有 url/日志）')
    assert.equal((merged['running'] as unknown[]).length, 2, '同名只能出现一行')
  } finally {
    h.cleanup()
  }
})

test('P-04 GET /profiles 失败：500 + 错误文本（不伪装成空列表）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-profiles-list-fail-'))
  try {
    const env = {
      host: { profile: 'web', sessionFormatVersion: 3 },
      profiles: { list() { throw new Error('profiles root unreadable') } },
      profileRuntime: { listActive: () => [] },
      profileLauncher: { listRunning: () => [], launch: async () => ({}), stop: async () => ({}) },
      tryAppendHistory: async () => undefined,
      withMutationGate: (_op: string, handler: unknown) => handler,
    } as never
    const route = profileRoutes(env).find((r) => r.path === BASE && routeSpecOf(r)?.methods.includes('GET') === true)
    assert.ok(route !== undefined)
    const state: FakeResponse = { status: 0, body: '' }
    const req = { method: 'GET', url: BASE, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage
    const res = { headersSent: false, writeHead(status: number) { state.status = status; return this }, end(payload?: string) { state.body = payload ?? ''; return this } }
    await route.handler(req, res as unknown as ServerResponse)
    assert.equal(state.status, 500)
    assert.equal(json(state)['error'], 'profiles root unreadable')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------- launch */

test('P-05 launch 成功：按档案真实 shape 起动 + 回执带 running + 落审计', async () => {
  const h = harness()
  try {
    h.profiles.create('gamma', 'web')
    const response = await call(h, '/launch', { body: { name: ' gamma ' } })
    assert.equal(response.status, 200, response.body)
    const body = json(response)
    assert.equal(body['ok'], true)
    assert.deepEqual(h.launcher.launched, [{ name: 'gamma', shape: 'web' }], 'shape 必须取自档案自身（不是硬编码 web）')
    assert.equal((body['launch'] as { ready: boolean }).ready, true)
    assert.deepEqual((body['running'] as { name: string; owned: boolean }[]).map((r) => [r.name, r.owned]), [['gamma', true]], '回执必须立刻带 running，界面据此把按钮换成「停止」')
    assert.deepEqual(h.history.map((e) => [e.kind, e.result, e.sections.join(',')]), [['profile-switch', 'success', 'gamma']])
  } finally {
    h.cleanup()
  }
})

test('P-06 launch 守卫：缺 name/同名多开/档案不存在/形态不可启动 各自 400·404', async () => {
  const h = harness()
  try {
    assert.equal((await call(h, '/launch', { body: {} })).status, 400)
    assert.equal((await call(h, '/launch', { body: { name: '   ' } })).status, 400)

    // 在本档案里启动自己 = 同名多开
    const self = await call(h, '/launch', { body: { name: 'web' } })
    assert.equal(self.status, 400)
    assert.equal(json(self)['code'], 'currentProfile')
    assert.equal(h.launcher.launched.length, 0)

    const missing = await call(h, '/launch', { body: { name: 'nope' } })
    assert.equal(missing.status, 404)
    assert.equal(json(missing)['code'], 'notFound')

    h.profiles.create('plain', 'base')
    h.setLaunchError(new DshProfileError('notLaunchable'))
    const notLaunchable = await call(h, '/launch', { body: { name: 'plain' } })
    assert.equal(notLaunchable.status, 400, '只有 web 形态能起浏览器 GUI')
    assert.equal(json(notLaunchable)['code'], 'notLaunchable')
    assert.equal(h.history.length, 0, '失败不得写「成功」审计')
  } finally {
    h.cleanup()
  }
})

test('P-07 launch 审计写失败：仍 200 + historyWriteError（审计降级不回滚启动）', async () => {
  const h = harness()
  try {
    h.profiles.create('delta', 'web')
    h.setHistoryError('disk-full')
    const response = await call(h, '/launch', { body: { name: 'delta' } })
    assert.equal(response.status, 200)
    assert.equal(json(response)['historyWriteError'], 'disk-full')
    assert.equal((json(response)['running'] as unknown[]).length, 1, '启动是既成事实，必须如实回传')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- detail */

test('P-08 GET detail：返回 manifest/patch 原文；越界名与不存在分别 400·404', async () => {
  const h = harness()
  try {
    h.profiles.create('eps', 'web')
    const ok = await call(h, '/detail', { method: 'GET', query: '?name=eps' })
    assert.equal(ok.status, 200, ok.body)
    const detail = json(ok)['profile'] as Record<string, unknown>
    assert.equal(detail['name'], 'eps')
    assert.equal(typeof detail['manifest'], 'string')
    assert.equal(typeof detail['patch'], 'string')
    assert.ok((detail['bundles'] as string[]).includes('@deepseek-ai/dsh-web-app'))
    assert.equal(detail['shape'], 'web')

    const noName = await call(h, '/detail', { method: 'GET' })
    assert.equal(noName.status, 400)
    assert.equal(json(noName)['error'], 'name is required')
    assert.equal((await call(h, '/detail', { method: 'GET', query: '?name=' })).status, 400)

    const missing = await call(h, '/detail', { method: 'GET', query: '?name=ghost' })
    assert.equal(missing.status, 404)
    assert.equal(json(missing)['code'], 'notFound')

    const traversal = await call(h, '/detail', { method: 'GET', query: '?name=' + encodeURIComponent('../../etc') })
    assert.equal(traversal.status, 400, '路径穿越必须在引擎里就被拒')
    assert.equal(json(traversal)['code'], 'invalidName')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- create */

test('P-09 create 成功：三个脚手架文件真的落到磁盘 + 落审计', async () => {
  const h = harness()
  try {
    const response = await call(h, '/create', { body: { name: ' zeta ', template: 'web' } })
    assert.equal(response.status, 200, response.body)
    const profile = json(response)['profile'] as Record<string, unknown>
    assert.equal(profile['name'], 'zeta', '名字必须 trim')
    const dir = h.profileDir('zeta')
    assert.ok(fs.existsSync(path.join(dir, 'package.json')))
    assert.ok(fs.existsSync(path.join(dir, 'cordis.patch.yml')))
    assert.ok(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')))
    const manifest = readManifest(h, 'zeta')
    assert.equal(manifest['name'], 'dsh-profile-zeta')
    assert.deepEqual((manifest['dsh'] as { profile: { bundles: string[] } }).profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.deepEqual(h.history.map((e) => [e.kind, e.sections.join(',')]), [['profile-create', 'zeta']])
  } finally {
    h.cleanup()
  }
})

test('P-10 create 守卫：保留名/已存在/未知模板/非法名 各自独立状态码，失败不留目录', async () => {
  const h = harness()
  try {
    h.profiles.create('exists', 'base')

    const reserved = await call(h, '/create', { body: { name: 'headless' } })
    assert.equal(reserved.status, 400)
    assert.equal(json(reserved)['code'], 'reservedName')

    const duplicate = await call(h, '/create', { body: { name: 'exists' } })
    assert.equal(duplicate.status, 409)
    assert.equal(json(duplicate)['code'], 'exists')

    const unknownTemplate = await call(h, '/create', { body: { name: 'fresh', template: 'nope' } })
    assert.equal(unknownTemplate.status, 400)
    assert.equal(json(unknownTemplate)['code'], 'unknownTemplate')

    for (const name of ['', '   ', 'a/b', '..', 'node_modules']) {
      const response = await call(h, '/create', { body: { name } })
      assert.equal(response.status, 400, JSON.stringify(name) + ' 必须被拒: ' + response.body)
      assert.equal(json(response)['code'], 'invalidNameInput')
    }
    assert.equal(fs.existsSync(h.profileDir('fresh')), false, '未知模板不得留下半截目录')
    assert.equal(h.history.length, 0, '失败不得写审计')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- copy */

test('P-11 copy 成功：目录级等价副本（package.json 改名）+ 不拷 node_modules 时如实告警', async () => {
  const h = harness()
  try {
    h.profiles.create('src', 'web')
    // 给源档案加一个依赖与 node_modules（模拟树外插件已装）
    const manifest = readManifest(h, 'src')
    manifest['dependencies'] = { 'some-plugin': '1.0.0' }
    fs.writeFileSync(path.join(h.profileDir('src'), 'package.json'), JSON.stringify(manifest, null, 2))
    fs.mkdirSync(path.join(h.profileDir('src'), 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(h.profileDir('src'), 'node_modules', 'marker.txt'), 'x')

    const response = await call(h, '/copy', { body: { name: 'src', newName: 'dst', includeNodeModules: false } })
    assert.equal(response.status, 200, response.body)
    const copy = json(response)['copy'] as Record<string, unknown>
    assert.equal(copy['name'], 'dst')
    assert.equal(copy['sourceName'], 'src')
    assert.equal(copy['includeNodeModules'], false)
    assert.deepEqual(copy['warnings'], ['depsNotInstalled'], '没拷依赖却声明了依赖必须显式告警')
    assert.equal(typeof copy['durationMs'], 'number')
    assert.equal(readManifest(h, 'dst')['name'], 'dsh-profile-dst', '副本的 package.json name 必须跟随改写')
    assert.equal(fs.existsSync(path.join(h.profileDir('dst'), 'node_modules')), false)
    assert.deepEqual(h.history.map((e) => [e.kind, e.sections.join(',')]), [['profile-create', 'dst']])

    // 默认（缺省 true）连 node_modules 一起拷
    const withModules = await call(h, '/copy', { body: { name: 'src', newName: 'dst2' } })
    assert.equal(withModules.status, 200, withModules.body)
    assert.equal((json(withModules)['copy'] as { includeNodeModules: boolean }).includeNodeModules, true)
    assert.ok(fs.existsSync(path.join(h.profileDir('dst2'), 'node_modules', 'marker.txt')))
  } finally {
    h.cleanup()
  }
})

test('P-12 copy 守卫：缺 newName/源不存在/目标已存在/非法新名', async () => {
  const h = harness()
  try {
    h.profiles.create('one', 'base')
    h.profiles.create('two', 'base')

    assert.equal((await call(h, '/copy', { body: { name: 'one' } })).status, 400)
    assert.equal((await call(h, '/copy', { body: { newName: 'x' } })).status, 400)

    const missingSource = await call(h, '/copy', { body: { name: 'ghost', newName: 'x' } })
    assert.equal(missingSource.status, 404)
    assert.equal(json(missingSource)['code'], 'notFound')

    const duplicate = await call(h, '/copy', { body: { name: 'one', newName: 'two' } })
    assert.equal(duplicate.status, 409)
    assert.equal(json(duplicate)['code'], 'exists')

    const reserved = await call(h, '/copy', { body: { name: 'one', newName: 'sdk' } })
    assert.equal(reserved.status, 400)
    assert.equal(json(reserved)['code'], 'reservedName')
    assert.equal(h.history.length, 0)
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- rename */

test('P-13 rename 成功：目录搬走 + package.json 改名 + 审计用旧名', async () => {
  const h = harness()
  try {
    h.profiles.create('old', 'base')
    const response = await call(h, '/rename', { body: { name: 'old', newName: ' new ' } })
    assert.equal(response.status, 200, response.body)
    assert.equal((json(response)['profile'] as { name: string }).name, 'new')
    assert.equal(fs.existsSync(h.profileDir('old')), false, '旧目录必须已经不在')
    assert.equal(fs.existsSync(h.profileDir('new')), true)
    assert.equal(readManifest(h, 'new')['name'], 'dsh-profile-new')
    assert.deepEqual(h.history.map((e) => [e.kind, e.sections.join(',')]), [['profile-rename', 'old']], '审计记的是被改的旧名')
  } finally {
    h.cleanup()
  }
})

test('P-14 rename 守卫：desktop/目标已存在/当前档案/源不存在/保留新名', async () => {
  const h = harness()
  try {
    h.profiles.create('work', 'base')
    h.profiles.create('other', 'base')
    h.setCurrent('work')

    const managed = await call(h, '/rename', { body: { name: 'desktop', newName: 'desktop2' } })
    assert.equal(managed.status, 400, 'desktop 是 Electron 独占档案')
    assert.equal(json(managed)['code'], 'managedProfile')

    const duplicate = await call(h, '/rename', { body: { name: 'other', newName: 'work' } })
    assert.equal(duplicate.status, 409)
    assert.equal(json(duplicate)['code'], 'exists')

    const currentName = await call(h, '/rename', { body: { name: 'work', newName: 'work2' } })
    assert.equal(currentName.status, 400, '改名正在跑的档案会让 patch 监视指向旧路径')
    assert.equal(json(currentName)['code'], 'currentProfile')

    const missing = await call(h, '/rename', { body: { name: 'ghost', newName: 'ghost2' } })
    assert.equal(missing.status, 404)
    assert.equal(json(missing)['code'], 'notFound')

    const reserved = await call(h, '/rename', { body: { name: 'other', newName: 'web' } })
    assert.equal(reserved.status, 400)
    assert.equal(json(reserved)['code'], 'reservedName')

    assert.equal((await call(h, '/rename', { body: {} })).status, 400, '空名由引擎校验拒绝，不静默成功')
    assert.equal(h.history.length, 0)
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- delete */

test('P-15 delete 成功：目录物理删除 + 审计', async () => {
  const h = harness()
  try {
    h.profiles.create('gone', 'base')
    const response = await call(h, '/delete', { body: { name: 'gone' } })
    assert.equal(response.status, 200, response.body)
    assert.deepEqual(json(response), { ok: true })
    assert.equal(fs.existsSync(h.profileDir('gone')), false, '必须是物理删除')
    assert.deepEqual(h.history.map((e) => [e.kind, e.sections.join(',')]), [['profile-delete', 'gone']])
  } finally {
    h.cleanup()
  }
})

test('P-16 delete 守卫：在跑的实例（台账与心跳都算）/desktop/当前档案/不存在', async () => {
  const h = harness()
  try {
    h.profiles.create('busy', 'base')
    h.profiles.create('hb', 'base')
    h.profiles.create('work', 'base')
    h.setCurrent('work')

    h.launcher.running.push({ name: 'busy', port: 4567, pid: 1, url: null, logFile: '/tmp/busy.log', startedAt: '2026-11-04T09:00:00.000Z' })
    const owned = await call(h, '/delete', { body: { name: 'busy' } })
    assert.equal(owned.status, 400, '删掉目录会让那个实例当场失去自己的文件')
    assert.equal(json(owned)['code'], 'instanceRunning')
    assert.ok(fs.existsSync(h.profileDir('busy')))

    // 只有心跳（手动 dsh 起的实例）同样挡住删除
    h.runtime.active.push({ schemaVersion: 1, name: 'hb', pid: 2, port: null, startedAt: '2026-11-04T09:00:00.000Z', updatedAt: 1 })
    assert.equal(json(await call(h, '/delete', { body: { name: 'hb' } }))['code'], 'instanceRunning')

    const managed = await call(h, '/delete', { body: { name: 'desktop' } })
    assert.equal(managed.status, 400)
    assert.equal(json(managed)['code'], 'managedProfile')

    const currentProfile = await call(h, '/delete', { body: { name: 'work' } })
    assert.equal(currentProfile.status, 400)
    assert.equal(json(currentProfile)['code'], 'currentProfile')

    const forced = await call(h, '/delete', { body: { name: 'work', allowCurrent: true } })
    assert.equal(forced.status, 200, '显式 allowCurrent 必须放行: ' + forced.body)
    assert.equal(fs.existsSync(h.profileDir('work')), false)

    const missing = await call(h, '/delete', { body: { name: 'ghost' } })
    assert.equal(missing.status, 404)
    assert.equal(json(missing)['code'], 'notFound')
  } finally {
    h.cleanup()
  }
})

/* ---------------------------------------------------------------- stop */

test('P-17 stop 台账：走启动器（owned），回执带 stopped + running', async () => {
  const h = harness()
  try {
    h.profiles.create('beta', 'web')
    h.launcher.running.push({ name: 'beta', port: 4567, pid: 4321, url: 'http://127.0.0.1:4567/?token=abc', logFile: '/tmp/b.log', startedAt: '2026-11-04T09:00:00.000Z' })
    const response = await call(h, '/stop', { body: { name: 'beta' } })
    assert.equal(response.status, 200, response.body)
    assert.deepEqual(h.launcher.stopped, ['beta'])
    assert.deepEqual(h.runtime.stoppedExternal, [])
    assert.deepEqual(json(response)['stopped'], { name: 'beta', result: 'graceful', port: 4567 })
    // 台账记录被清掉后 running 必须立刻反映出来（界面据此换回「启动」）
    h.launcher.running.length = 0
    assert.equal((json(response)['running'] as unknown[]).length, 1, '回执用的是停止**前**那一刻的 running 快照')
    assert.deepEqual(h.history.map((e) => [e.kind, e.sections.join(',')]), [['profile-switch', 'beta']])
  } finally {
    h.cleanup()
  }
})

test('P-18 stop 非台账（心跳）：走运行时停外部实例，不碰启动器', async () => {
  const h = harness()
  try {
    h.runtime.active.push({ schemaVersion: 1, name: 'ext', pid: 888, port: 5005, startedAt: '2026-11-04T09:00:00.000Z', updatedAt: 1 })
    const response = await call(h, '/stop', { body: { name: 'ext' } })
    assert.equal(response.status, 200, response.body)
    assert.deepEqual(h.runtime.stoppedExternal, ['ext'])
    assert.deepEqual(h.launcher.stopped, [], '手动启动的实例不在台账里')
    assert.deepEqual(json(response)['stopped'], { name: 'ext', result: 'killed', port: 5005 })
  } finally {
    h.cleanup()
  }
})

test('P-19 stop 守卫：缺 name/没在跑/停自己/停不掉 各自状态码', async () => {
  const h = harness()
  try {
    assert.equal((await call(h, '/stop', { body: {} })).status, 400)

    h.setStopExternalError(new DshProfileError('notRunning'))
    const notRunning = await call(h, '/stop', { body: { name: 'nope' } })
    // 「档案存在但没在跑」不是 404（只有档案本身不存在才是），错误码才是界面分支依据
    assert.equal(notRunning.status, 400)
    assert.equal(json(notRunning)['code'], 'notRunning')

    h.setStopExternalError(new DshProfileError('currentProfile'))
    const self = await call(h, '/stop', { body: { name: 'web' } })
    assert.equal(self.status, 400, '停自己会死在响应途中')
    assert.equal(json(self)['code'], 'currentProfile')

    h.setStopExternalError(new DshProfileError('stopFailed', 'pid 999 still alive'))
    const failed = await call(h, '/stop', { body: { name: 'stuck' } })
    assert.equal(failed.status, 400)
    assert.equal(json(failed)['code'], 'stopFailed')
    assert.equal(h.history.length, 0, '停不掉绝不写「成功」审计')
  } finally {
    h.cleanup()
  }
})
