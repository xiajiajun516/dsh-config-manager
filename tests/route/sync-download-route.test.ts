/**
 * 回归：POST /sync/download 落地的 ZIP 必须在**受控暂存根**内。
 *
 * 真机 bug（产物库 → 远端快照「拉取」→ 导入页）：该路由把 ZIP 落在 `<dataDir>/sync/incoming`，
 * 而 /analyze、/plan、/execute 一律用 `isControlledPath(zipPath, roots=[exportsDir, tmpDir])` 校验，
 * 于是导入向导第一步就被 400 挡回：`zipPath is required and must reference a staged backup`。
 *
 * 本用例把整条链钉住：真实 handler → 真实落盘 → 用**导入侧同一份判据**（isControlledPath）复核。
 * 只要有人把落盘目录改回 syncDir（或任何非受控根），这里立刻变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { isControlledPath } from '../../src/index.ts'

interface Harness {
  root: string
  exportsDir: string
  tmpDir: string
  syncDir: string
  cleanup: () => Promise<void>
}

/** 真实临时目录（受控根 = [exportsDir, tmpDir]，与 src/index.ts 的 roots 同形）。 */
async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sync-download-'))
  const exportsDir = path.join(root, 'exports')
  const tmpDir = path.join(root, 'tmp')
  const syncDir = path.join(root, 'sync')
  for (const dir of [exportsDir, tmpDir, syncDir]) await fs.mkdir(dir, { recursive: true })
  return { root, exportsDir, tmpDir, syncDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

/**
 * 本组路由需要的 env（其余成员在本次调用路径上不被读取）。
 * 假引擎**按真实语义落盘**：写进调用方给的 dir 并把该路径回传 —— 这样「路由传了哪个 dir」
 * 会被真实文件位置暴露出来，而不是只回一个字符串骗过断言。
 */
function envFor(h: Harness, names: string[] = []): never {
  const env = {
    tmpDir: h.tmpDir,
    syncDir: h.syncDir,
    msg: (key: string) => key,
    prepareSync: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://example.com/repo.git' } }),
    makeSyncEngine: () => ({
      downloadSnapshot: async (opts: { dir: string; snapshotId?: string; name?: string }) => {
        // 把「路由传了哪个 name」变成**磁盘上的真实文件名**：断言文件名即可证明透传，
        // 而不是只信一个字符串回显。缺省名保持既有行为（snap-1.zip）。
        names.push(opts.name ?? '')
        await fs.mkdir(opts.dir, { recursive: true })
        const file = path.join(opts.dir, opts.name ?? 'snap-1.zip')
        await fs.writeFile(file, Buffer.from('PK\u0003\u0004'))
        return { path: file, snapshotId: opts.snapshotId ?? 'snap-1' }
      },
    }),
    resolveSyncPassword: async () => undefined,
    // issue #78：放行集合（本用例不涉及可选分区 → 空集）
    selectionOptInSections: () => [],
    // 与生产同语义的「直通」包壳（本组多条写路由在**构造期**就会调它包 handler）
    withMutationGate: (_op: string, handler: unknown) => handler,
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

test('POST /sync/download：落地的 zipPath 必须通过导入侧同一份 isControlledPath 判据', async () => {
  const h = await makeHarness()
  try {
    const route = routeByPath(syncRoutes(envFor(h)), '/api/dsh-config-manager/sync/download')
    const res = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', body: '{"transport":"git"}' }), res.res)
    assert.equal(res.status(), 200)
    const body = res.json() as { ok: boolean; zipPath: string; snapshotId: string }
    assert.equal(body.ok, true)
    assert.ok((await fs.stat(body.zipPath)).isFile(), 'ZIP 必须真的落在磁盘上：' + body.zipPath)
    // 判据与导入侧（/analyze、/plan、/execute）逐字同源：受控根 = [exportsDir, tmpDir]
    assert.ok(
      isControlledPath(body.zipPath, [h.exportsDir, h.tmpDir]),
      'zipPath 必须落在受控暂存根内，否则导入向导第一步直接 400：' + body.zipPath,
    )
    assert.ok(
      !body.zipPath.startsWith(path.join(h.syncDir, 'incoming')),
      '不得落回 syncDir/incoming（那里不是受控根）：' + body.zipPath,
    )
  } finally {
    await h.cleanup()
  }
})

test('POST /sync/download：可选 name 透传引擎（落盘就用它）；不安全的名字直接 400', async () => {
  const h = await makeHarness()
  try {
    const names: string[] = []
    const route = routeByPath(syncRoutes(envFor(h, names)), '/api/dsh-config-manager/sync/download')

    // ① 合法名（产物库按快照时间生成的那个形态）→ 引擎收到，磁盘上的文件名就是它
    const ok = fakeResponse()
    await route.handler(
      fakeRequest({ method: 'POST', body: '{"transport":"git","snapshotId":"r-9","name":"dsh-config-remote-20261002-013330.zip"}' }),
      ok.res,
    )
    assert.equal(ok.status(), 200)
    const body = ok.json() as { zipPath: string; snapshotId: string }
    assert.deepEqual(names, ['dsh-config-remote-20261002-013330.zip'], 'name 必须逐字透传')
    assert.equal(path.basename(body.zipPath), 'dsh-config-remote-20261002-013330.zip')
    assert.ok((await fs.stat(body.zipPath)).isFile(), 'ZIP 必须真的落在磁盘上：' + body.zipPath)
    assert.ok(isControlledPath(body.zipPath, [h.exportsDir, h.tmpDir]), '换名后仍必须落在受控暂存根内')

    // ② 带路径分隔符 / 非 .zip 的名字 → 400，绝不进 path.join（那是路径穿越的入口）
    for (const bad of ['"../evil.zip"', '"a/b.zip"', '"not-a-zip.txt"', '""']) {
      const rejected = fakeResponse()
      await route.handler(fakeRequest({ method: 'POST', body: '{"transport":"git","name":' + bad + '}' }), rejected.res)
      assert.equal(rejected.status(), 400, '非法 name 必须被挡回：' + bad)
    }
    assert.deepEqual(names, ['dsh-config-remote-20261002-013330.zip'], '非法名字不得传给引擎')
  } finally {
    await h.cleanup()
  }
})
