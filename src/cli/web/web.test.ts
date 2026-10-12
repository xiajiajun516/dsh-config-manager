/**
 * 离线救急台（`dsh-config-manager web`，阶段 1）的端到端单测。
 *
 * 钉住的语义（这些是安全边界，不是实现细节）：
 *  - **一次性 token**：不带 token 的请求一律 403；token 只能换一次会话 cookie；
 *  - **cookie 不可猜**：换到 cookie 后可以正常访问页面，伪造 cookie 仍然 403；
 *  - **页面只读、写动作显式**：页面只用 GET 渲染；写动作是独立的 POST 表单（一次性 action token
 *    + 安全门），任何不在声明内的方法一律 405 —— 且必须渲染成 HTML 错误页而不是裸 JSON（cli-F4）；
 *  - **只在本机**：非回环来源一律 403（kit 的围栏）；
 *  - **不写盘**：打开首页/磁盘/会话页不产生任何文件（零写入）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startConsoleServer, CONSOLE_SESSION_COOKIE, type ConsoleServerHandle } from './server.ts'
import {
  renderDiskPage,
  renderExportPage,
  renderHomePage,
  renderLockPage,
  renderMessagePage,
  renderProfilesPage,
  renderReinstallPage,
  renderRestorePage,
  renderResultPage,
  renderSessionsPage,
  renderUnlockPage,
  renderVerifyPage,
  type InlineRepairView,
} from './page.ts'
import type { LockReport, RescuePaths, RescueStatus, RestorePlanView } from '../actions.ts'
import type { SessionHealthScanResult } from '../../utils/session-health-scan.ts'
import { DISK_USAGE_AREAS, type DiskUsageReport } from '../../core/disk-usage.ts'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'

const silentIo = { log: () => undefined, error: () => undefined }

async function withConsole<T>(fn: (handle: ConsoleServerHandle, paths: RescuePaths) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-console-'))
  const dataDir = path.join(home, 'dsh-config-manager')
  const paths: RescuePaths = {
    homeDir: home,
    dataDir,
    snapshotsDir: path.join(dataDir, 'snapshots'),
    exportsDir: path.join(dataDir, 'exports'),
    locksDir: path.join(dataDir, 'locks'),
    controlRoots: [dataDir],
    profile: 'web',
  }
  const handle = await startConsoleServer({
    paths,
    version: '0.0.0-test',
    port: 0,
    openBrowser: false,
    idleTimeoutMs: 0,
    io: silentIo,
    handleSignals: false,
  })
  try {
    return await fn(handle, paths)
  } finally {
    await handle.close()
    await fs.rm(home, { recursive: true, force: true })
  }
}

/** 带 token 打开一次，返回 Location 与 set-cookie（不跟随重定向）。 */
async function bootstrap(handle: ConsoleServerHandle): Promise<{ status: number; cookie: string | undefined }> {
  const res = await fetch(handle.bootstrapUrl, { redirect: 'manual' })
  const raw = res.headers.get('set-cookie')
  return { status: res.status, cookie: raw === null ? undefined : raw.split(';')[0] }
}

test('W-01 没有 token 的请求一律 403（token 是这一层的唯一边界）', async () => {
  await withConsole(async (handle) => {
    const res = await fetch(handle.url)
    assert.equal(res.status, 403)
    const body = await res.text()
    assert.match(body, /需要从终端打印的链接进入/)
    assert.equal(res.headers.get('set-cookie'), null, '未认证的请求不得拿到 cookie')
  })
})

test('W-02 错误 token 403；正确 token 换 cookie 且只能换一次', async () => {
  await withConsole(async (handle) => {
    const bad = await fetch(handle.url + '?token=deadbeef', { redirect: 'manual' })
    assert.equal(bad.status, 403)

    const first = await bootstrap(handle)
    assert.equal(first.status, 302)
    assert.ok(first.cookie !== undefined && first.cookie.startsWith(CONSOLE_SESSION_COOKIE + '='), '必须下发会话 cookie')

    // 同一个 token 再用一次 → 已经作废
    const second = await fetch(handle.bootstrapUrl, { redirect: 'manual' })
    assert.equal(second.status, 403)
  })
})

test('W-03 用 cookie 可以读到首页，伪造 cookie 仍然 403', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const ok = await fetch(handle.url, { headers: { cookie: cookie! } })
    assert.equal(ok.status, 200)
    const html = await ok.text()
    assert.match(html, /DCM 离线救急台/)
    assert.match(html, /SAFE MODE/)
    assert.match(html, /专门|只读/)

    const forged = await fetch(handle.url, { headers: { cookie: CONSOLE_SESSION_COOKIE + '=whatever' } })
    assert.equal(forged.status, 403)
  })
})

test('W-04 只读页面零写入；未声明的写路径不存在（不误开写入口）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 未声明的路径：POST 必须落到 404（kit 只在已声明端点上做方法判定）
    const res = await fetch(handle.url.replace(/\/$/, '') + '/nope', { method: 'POST', headers: { cookie: cookie! } })
    assert.equal(res.status, 404)
    // 已声明的只读端点收到写方法 → 405（kit 方法白名单）
    const wrongMethod = await fetch(handle.url.replace(/\/$/, '') + '/healthz', { method: 'POST', headers: { cookie: cookie! } })
    assert.equal(wrongMethod.status, 405)

    // 打开全部页面也不得产生任何文件（零写入：连目录都不建）
    const pages = ['/', '/disk', '/sessions', '/healthz']
    for (const page of pages) {
      const pageRes = await fetch(handle.url.replace(/\/$/, '') + page, { headers: { cookie: cookie! } })
      assert.equal(pageRes.status, 200, page + ' 必须可用')
      await pageRes.text()
    }
    let existing = true
    try {
      await fs.stat(paths.dataDir)
    } catch {
      existing = false
    }
    assert.equal(existing, false, '只读页面不得创建任何目录/文件')
  })
})

test('W-05 /healthz 回只读标记；未知路径 404', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const health = await fetch(handle.url.replace(/\/$/, '') + '/healthz', { headers: { cookie: cookie! } })
    assert.equal(health.status, 200)
    const payload = await health.json() as { ok: boolean; readOnly: boolean; service: string; writes: string[] }
    assert.equal(payload.ok, true)
    assert.equal(payload.readOnly, false, '阶段 2 起服务含显式写动作（每个都要 token + 安全门）')
    assert.equal(payload.service, 'dcm-rescue-console')
    assert.deepEqual(payload.writes, ['sessions-repair', 'disk-cleanup', 'recover-stale-lock'])

    const missing = await fetch(handle.url.replace(/\/$/, '') + '/nope', { headers: { cookie: cookie! } })
    assert.equal(missing.status, 404)
  })
})

test('W-06 浏览器跨站 → 403；Host 非回环 → 403（kit 的 loopback + 同源围栏）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    // 跨站请求：浏览器会带上 sec-fetch-site / Origin，围栏必须拒绝
    const crossSite = await fetch(handle.url, {
      headers: { cookie: cookie!, origin: 'http://evil.example.com', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)

    // Host 头不是回环：用未受管制的原生 http 请求（fetch 会忽略自定义 host）
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path: '/', method: 'GET', headers: { host: 'evil.example.com', cookie: cookie! } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0) },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  })
})

test('W-07 备份自检页：导出目录里的产物可校验，目录外的名字被拒（404，不做路径拼接）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.mkdir(paths.exportsDir, { recursive: true })
    // 造一个**不是**合法 ZIP 的文件：自检页必须如实给出非 OK 判定，而不是假装通过
    await fs.writeFile(path.join(paths.exportsDir, 'broken.zip'), Buffer.from('not a zip at all'))

    const { verifyIdOf } = await import('./page.ts')
    const ok = await fetch(handle.url.replace(/\/$/, '') + '/verify?id=' + verifyIdOf('broken.zip'), { headers: { cookie: cookie! } })
    assert.equal(ok.status, 200)
    const html = await ok.text()
    assert.match(html, /自检未通过/)

    const outside = await fetch(handle.url.replace(/\/$/, '') + '/verify?file=..%2F..%2Fetc%2Fpasswd', { headers: { cookie: cookie! } })
    assert.equal(outside.status, 404)
    assert.match(await outside.text(), /backup not found/)
  })
})

/* ------------------------------------------------------------ 写路由（阶段 2） */

/** 从确认页 HTML 里抠出一次性 action token（页面没有脚本，token 就是 form 里的 hidden input）。 */
function actionTokenOf(html: string): string {
  const match = /name="token" value="([0-9a-fA-F-]{36})"/.exec(html)
  assert.ok(match !== null, '确认页必须带一次性 action token')
  return match[1]!
}

async function getPage(handle: ConsoleServerHandle, cookie: string, path: string): Promise<string> {
  const res = await fetch(handle.url.replace(/\/$/, '') + path, { headers: { cookie } })
  assert.equal(res.status, 200, path + ' 应可访问')
  return await res.text()
}

/**
 * 抠出某一节卡片的 HTML（`<h2>标题…</h2><section class="card">…</section>`）。
 *
 * 为什么必须按卡片切：页脚（renderFooter）**每一页**都印着
 * `dsh-config-manager sessions repair --apply — 会话布局归位（本页按同一实现执行）`，
 * 所以整页级断言分不清「修复二段把 sessions repair 说成等价通道」与「页脚那条成立的布局归位命令」
 * —— 旧断言正是在这一点上是**假阴性**（C1b 实测）。
 */
function cardOf(html: string, titlePrefix: string): string {
  const start = html.indexOf('<h2>' + titlePrefix)
  assert.notEqual(start, -1, '页面上找不到卡片：' + titlePrefix)
  const end = html.indexOf('</section>', start)
  assert.notEqual(end, -1, '卡片未闭合：' + titlePrefix)
  return html.slice(start, end)
}

async function postForm(
  handle: ConsoleServerHandle,
  cookie: string,
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(handle.url.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: handle.url.replace(/\/$/, '') },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
  return { status: res.status, body: await res.text() }
}

test('W2-01 写路由：没有 token / token 伪造 / token 重复使用 → 一律拒绝，且不产生任何写入', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)

    const missing = await postForm(handle, cookie!, '/disk/cleanup', { caches: 'on' })
    assert.equal(missing.status, 400)
    assert.match(missing.body, /动作确认已失效|stale action token/)

    const forged = await postForm(handle, cookie!, '/disk/cleanup', { token: 'not-a-real-token', caches: 'on' })
    assert.equal(forged.status, 400)

    // 真 token：第一次成功（或如实失败），第二次必须被拒（一次性）
    const diskHtml = await getPage(handle, cookie!, '/disk')
    const token = actionTokenOf(diskHtml)
    const first = await postForm(handle, cookie!, '/disk/cleanup', { token, caches: 'on' })
    assert.ok(first.status === 200 || first.status === 409, '第一次必须是正常结果页')
    const second = await postForm(handle, cookie!, '/disk/cleanup', { token, caches: 'on' })
    assert.equal(second.status, 400, '同一个 token 不能提交两次')

    // 未登录（无 cookie）连 token 都换不到：写路由同样 403
    const anonymous = await fetch(handle.url.replace(/\/$/, '') + '/disk/cleanup', { method: 'POST' })
    assert.equal(anonymous.status, 403)
    // 清理只碰缓存区：不得创建 transactions（SAFE MODE 控制面目录）等配置类结构
    const stray: string[] = await fs.readdir(paths.dataDir).catch(() => [] as string[])
    assert.equal(stray.includes('transactions'), false, '清理不得创建控制面目录: ' + stray.join(','))
  })
})

test('W2-02 写路由：DSH 在跑 → 会话修复被安全门拒绝（409），且不改任何会话目录', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 造一条错位会话 + 一条活心跳
    const { encodeZstdFrame } = await import('../../utils/zstd-frame.ts')
    const dir = path.join(paths.homeDir, 'sessions', '--D-Ghost-proj--', 'session-x')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
      encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-x', cwd: 'D:/Real/proj' }) + '\n', 'utf8')),
      encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
    ]))
    const runningDir = path.join(paths.controlRoots[0]!, 'running')
    await fs.mkdir(runningDir, { recursive: true })
    await fs.writeFile(path.join(runningDir, 'web.json'), JSON.stringify({
      schemaVersion: 1, name: 'web', pid: process.pid, port: null,
      startedAt: new Date().toISOString(), updatedAt: Date.now(),
    }))

    const html = await getPage(handle, cookie!, '/sessions')
    assert.match(html, /修复一：会话布局归位/)
    // 计划里必须能看到这条错位会话（与 CLI 同一实现），并给出可执行步骤
    assert.match(html, /session-x/)
    const token = actionTokenOf(html)
    const res = await postForm(handle, cookie!, '/sessions/repair', { token })
    assert.equal(res.status, 409, res.body.slice(0, 400))
    assert.match(res.body, /安全门拒绝/)
    assert.match(res.body, /DSH 正在运行/)
    assert.deepEqual(await fs.readdir(dir), ['session.v3.jsonl.zstd'], '被拒绝时一个字节都不许动')
  })
})

test('W2-03 写路由：SAFE MODE 激活 → 会话修复被拒（fail-closed）；清理缓存不受该门影响', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.mkdir(path.join(paths.controlRoots[0]!, 'transactions'), { recursive: true })
    await fs.writeFile(path.join(paths.controlRoots[0]!, 'transactions', 'safe-mode'), 'blocked')

    // SAFE MODE 下即使有计划也不该给出可点的修复表单（点了必被门拒绝只是浪费一次往返）；
    // 这里没有可修复会话 → 本就没有表单，直接验证「用任意 token 的 POST 一定被门拦住」
    const html = await getPage(handle, cookie!, '/sessions')
    assert.match(html, /修复一：会话布局归位/)
    const res = await postForm(handle, cookie!, '/sessions/repair', { token: 'whatever-token' })
    // token 校验优先于安全门：伪造 token 一律 400（先证明调用者拿到了本页确认）
    assert.equal(res.status, 400, res.body.slice(0, 300))

    const diskHtml = await getPage(handle, cookie!, '/disk')
    const diskToken = actionTokenOf(diskHtml)
    const cleanup = await postForm(handle, cookie!, '/disk/cleanup', { token: diskToken, caches: 'on' })
    assert.equal(cleanup.status, 200, '清理缓存不写配置、不碰会话字节：不该被 SAFE MODE 挡住')
  })
})

test('W2-04 写路由：残留锁页展示状态，无锁时回收被如实拒绝（不谎报成功）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/lock')
    assert.match(html, /没有残留锁|锁状态/)
    const token = actionTokenOf(html)
    const res = await postForm(handle, cookie!, '/lock/recover', { token })
    assert.equal(res.status, 409, '没有锁时必须如实失败')
    assert.match(res.body, /未回收/)
  })
})

test('W2-05 写路由：跨站 POST（伪造 Origin）被围栏拒绝', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url.replace(/\/$/, '') + '/disk/cleanup', {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example.com' },
      body: 'token=x&caches=on',
    })
    assert.equal(res.status, 403)
  })
})

/* ------------------------------------------------------------ 档案与实例（阶段 3） */

/** 在临时 home 下造一个档案目录（shape 由 bundles 决定）。 */
async function seedProfile(home: string, name: string, bundles: string[]): Promise<void> {
  const dir = path.join(home, 'profiles', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    version: '0.0.0',
    dependencies: {},
    dsh: { profile: { bundles } },
  }))
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), '[]\n')
}

test('W3-01 档案页：列出本机档案与形态；非 web 形态与 desktop 一律不可启动且写明原因', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await seedProfile(paths.homeDir, 'cmweb', ['@deepseek-ai/dsh-web-app'])
    await seedProfile(paths.homeDir, 'cmbase', [])
    await seedProfile(paths.homeDir, 'desktop', ['@deepseek-ai/dsh-web-app'])

    const html = await getPage(handle, cookie!, '/profiles')
    assert.match(html, /本机档案（3）/)
    assert.match(html, /cmweb/)
    assert.match(html, /cmbase/)
    // desktop 是 Electron 独占：必须写明，且不给启动按钮
    assert.match(html, /桌面端（Electron）独占管理/)
    assert.match(html, /不是 web 形态/)
  })
})

test('W3-02 档案页写入口：token 一次性；缺 token 一律 400（不执行任何进程操作）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await seedProfile(paths.homeDir, 'cmweb', ['@deepseek-ai/dsh-web-app'])
    const html = await getPage(handle, cookie!, '/profiles')
    const token = actionTokenOf(html)

    const missing = await postForm(handle, cookie!, '/profiles/launch', { name: 'cmweb' })
    assert.equal(missing.status, 400)
    const okShape = await postForm(handle, cookie!, '/profiles/launch', { token, name: 'cmweb' })
    assert.ok(okShape.status === 200 || okShape.status === 409, '第一次必须是结果页')
    const again = await postForm(handle, cookie!, '/profiles/launch', { token, name: 'cmweb' })
    assert.equal(again.status, 400, '同一 token 不能复用')
  })
})

test('W3-03 停止：没有心跳也没有台账 → 如实 notRunning（绝不谎报已停止）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 造一个「台账里记录着、但 pid 已死」的实例：停止必须如实报 notRunning，而不是假装停掉了什么
    await seedProfile(paths.homeDir, 'cmweb', ['@deepseek-ai/dsh-web-app'])
    await fs.mkdir(paths.dataDir, { recursive: true })
    await fs.writeFile(path.join(paths.dataDir, 'launches.json'), JSON.stringify([
      { name: 'cmweb', port: 3999, pid: 999999999, url: null, logFile: '', startedAt: new Date().toISOString() },
    ]))
    const html = await getPage(handle, cookie!, '/profiles')
    // 死 pid 不算「在跑」：页面不给停止按钮，也不给启动（由 launchable 判定为 true → 给启动按钮）
    assert.match(html, /cmweb/)
    const token = actionTokenOf(html)
    // 第一次：台账记录被清掉、进程早已不在 → already-stopped（终态，算成功且如实写清）
    const first = await postForm(handle, cookie!, '/profiles/stop', { token, name: 'cmweb' })
    assert.equal(first.status, 200)
    assert.match(first.body, /already-stopped/)
    // 第二次：什么都没有了 → 如实 notRunning（绝不谎报又停了一次）
    const html2 = await getPage(handle, cookie!, '/profiles')
    const token2 = actionTokenOf(html2)
    const second = await postForm(handle, cookie!, '/profiles/stop', { token: token2, name: 'cmweb' })
    assert.equal(second.status, 409)
    assert.match(second.body, /notRunning/)
  })
})

test('W3-04 档案动作不过 SAFE MODE / DSH 在跑 两道门（它是「起不来」时的出口）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await seedProfile(paths.homeDir, 'cmweb', ['@deepseek-ai/dsh-web-app'])
    // 制造 SAFE MODE + 活心跳：会话修复会被挡，但启动动作不受影响（失败也必须是因为别的真实原因）
    await fs.mkdir(path.join(paths.controlRoots[0]!, 'transactions'), { recursive: true })
    await fs.writeFile(path.join(paths.controlRoots[0]!, 'transactions', 'safe-mode'), 'blocked')
    const html = await getPage(handle, cookie!, '/profiles')
    const token = actionTokenOf(html)
    const res = await postForm(handle, cookie!, '/profiles/launch', { token, name: 'cmweb' })
    // 沙箱/CI 里通常定位不到 dsh CLI → launcherUnavailable；关键是**不是** SAFE MODE 拒绝
    assert.ok(res.status === 200 || res.status === 409)
    assert.doesNotMatch(res.body, /SAFE MODE/)
  })
})

test('W3-05 展示文本一律脱敏：URL 里的 token 不得原样进入页面', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 造一个「导出目录里存在、但内容不是 ZIP」的备份 → 自检页会渲染失败原因
    await fs.mkdir(paths.exportsDir, { recursive: true })
    await fs.writeFile(path.join(paths.exportsDir, 'leaky.zip'), Buffer.from('not a zip'))
    // 页面链接用不透明 id（文件名可能夹带密钥，不能写回 URL）
    const { verifyIdOf } = await import('./page.ts')
    const html = await getPage(handle, cookie!, '/verify?id=' + verifyIdOf('leaky.zip'))
    assert.match(html, /自检未通过/)
    // 页面自身不应出现任何裸 token 形态（渲染前过 redact）
    assert.doesNotMatch(html, /[?&]token=[0-9a-f]{16,}/i)
  })
})

/* ------------------------------------------------------------ 验收修复的回归钉 */

test('V-F1 写门：存在残留锁时写动作被拒（文档与防线一致）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 造一条错位会话（页面因此渲染出可执行的修复表单，才有 token 可取）
    const { encodeZstdFrame } = await import('../../utils/zstd-frame.ts')
    const dir = path.join(paths.homeDir, 'sessions', '--D-Ghost-proj--', 'session-lock')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
      encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-lock', cwd: 'D:/Real/proj' }) + '\n', 'utf8')),
      encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
    ]))
    // 造一个 stale 锁：ownership 记录指向一个不存在的 pid，且无心跳
    await fs.mkdir(paths.locksDir, { recursive: true })
    await fs.writeFile(path.join(paths.locksDir, 'environment.lock'), JSON.stringify({
      schemaVersion: 1, op: 'test-op', target: 'x', lockVersion: '0.1.0',
      owner: { instanceId: 'dead-instance', instanceStartedAt: Date.now() - 600_000, pid: 999_999_999, hostname: 'h' },
      createdAt: Date.now() - 600_000,
    }))
    const html = await getPage(handle, cookie!, '/sessions')
    const token = actionTokenOf(html)
    const res = await postForm(handle, cookie!, '/sessions/repair', { token })
    assert.equal(res.status, 409, res.body.slice(0, 300))
    assert.match(res.body, /安全门拒绝/)
    assert.match(res.body, /残留的环境锁|环境锁/)
  })
})

test('V-F2 读不到 ≠ 没有：快照/导出目录不可读时首页给出横幅，而不是「没有」', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    // 把 snapshots 与 exports 建成普通文件（ENOTDIR）——不是「不存在」
    await fs.mkdir(paths.dataDir, { recursive: true })
    await fs.writeFile(paths.snapshotsDir, 'not a directory')
    await fs.writeFile(paths.exportsDir, 'not a directory')
    const html = await getPage(handle, cookie!, '/')
    assert.match(html, /有一项读不出来/, '必须显式告警')
    assert.match(html, /快照目录读不出来/)
    assert.match(html, /导出目录读不出来/)
    assert.doesNotMatch(html, /没有快照。快照是导入前/, '不得谎报成「没有快照」')
  })
})

test('V-F3 控制台错误一律渲染 HTML（不吐裸 JSON）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url.replace(/\/$/, '') + '/verify?file=..%2f..%2fetc%2fpasswd', { headers: { cookie: cookie! } })
    assert.equal(res.status, 404)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const body = await res.text()
    assert.match(body, /<!doctype html>/)
    assert.doesNotMatch(body, /^\{/)
  })
})

test('V-F3b 会话根不是目录 → /sessions 仍是 HTML 且如实报告', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.writeFile(path.join(paths.homeDir, 'sessions'), 'not a directory')
    const res = await fetch(handle.url.replace(/\/$/, '') + '/sessions', { headers: { cookie: cookie! } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const body = await res.text()
    assert.match(body, /<!doctype html>/)
  })
})

test('V-F7 备份名夹带密钥时：页面与链接都不得出现明文（href 用不透明摘要）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.mkdir(paths.exportsDir, { recursive: true })
    await fs.writeFile(path.join(paths.exportsDir, 'leak-apiKey=SECRET123.zip'), 'not a zip')
    const html = await getPage(handle, cookie!, '/')
    assert.doesNotMatch(html, /SECRET123/, '文件名里的密钥不得原样出现在页面（含 href）')
    assert.match(html, /\/verify\?id=[0-9a-f]{16}/, '链接必须用不透明摘要')
  })
})

/* ------------------------------------------------------------ 阶段 4：解锁 / 恢复 / 导出 / 重装 */

test('W4-01 新页面可达，且都要求 cookie（未认证一律 403）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    for (const page of ['/unlock', '/restore', '/export', '/reinstall']) {
      const anon = await fetch(handle.url.replace(/\/$/, '') + page)
      assert.equal(anon.status, 403, page + ' 未认证必须 403')
      const ok = await fetch(handle.url.replace(/\/$/, '') + page, { headers: { cookie: cookie! } })
      assert.equal(ok.status, 200, page + ' 带 cookie 应 200')
      assert.match(ok.headers.get('content-type') ?? '', /text\/html/)
    }
  })
})

test('W4-02 解锁：缺 token 400；非加密容器/错误密码如实失败（不谎报解锁成功）', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.mkdir(paths.exportsDir, { recursive: true })
    await fs.writeFile(path.join(paths.exportsDir, 'plain.zip'), 'not a zip at all')
    const html = await getPage(handle, cookie!, '/unlock')
    // 明文 ZIP 不该出现在「加密容器」列表里
    assert.doesNotMatch(html, /plain\.zip/)
    assert.match(html, /没有加密容器/)

    const missing = await postForm(handle, cookie!, '/unlock/run', { password: 'x' })
    assert.equal(missing.status, 400)

    // 造一个「看起来像加密容器但实际不是」的文件名由服务端按 id 解析：这里直接用真实存在的明文 ZIP
    const { verifyIdOf } = await import('./page.ts')
    const html2 = await getPage(handle, cookie!, '/unlock')
    const token = /name="token" value="([0-9a-fA-F-]{36})"/.exec(html2)?.[1] ?? ''
    const res = await postForm(handle, cookie!, '/unlock/run', {
      ...(token === '' ? {} : { token }),
      id: verifyIdOf('plain.zip'),
      password: 'whatever',
    })
    // 没有可解锁项时拿不到 token → 400（token 校验优先）；有 token 时会走到真实解锁并如实失败
    assert.ok(res.status === 400 || res.status === 409, String(res.status))
    assert.doesNotMatch(res.body, /解锁成功/)
  })
})

test('W4-03 恢复：没有快照时页面如实说没有；非法快照 id 的计划生成失败但不崩', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/restore')
    assert.match(html, /没有快照/)
    assert.match(html, /恢复是危险动作/)
    const bad = await getPage(handle, cookie!, '/restore?id=does-not-exist')
    assert.match(bad, /无法生成恢复计划/)
  })
})

test('W4-04 导出：列出离线可读分区与不可读分区；缺 token 400', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/export')
    assert.match(html, /只导出离线能读到的分区/)
    assert.match(html, /离线不可收集/)
    assert.match(html, /skills/)
    const missing = await postForm(handle, cookie!, '/export/run', {})
    assert.equal(missing.status, 400)
  })
})

test('W4-05 重装：页面绝不含终端确认码；确认码错误一律 409 且不执行', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/reinstall')
    assert.match(html, /这是本页最危险的动作/)
    // 关键安全断言：页面里绝不能出现确认码本身（它只在终端打印）
    const phrase = /终端确认码[^0-9A-F]*([0-9A-F]{6})/.exec(html)
    assert.equal(phrase, null, '确认码不得渲染进页面')

    const missing = await postForm(handle, cookie!, '/reinstall/run', {})
    assert.equal(missing.status, 400, '缺 token 先 400')

    const html2 = await getPage(handle, cookie!, '/reinstall')
    const wrong = await postForm(handle, cookie!, '/reinstall/run', { token: actionTokenOf(html2), phrase: 'ZZZZZZ' })
    assert.equal(wrong.status, 409)
    assert.match(wrong.body, /终端确认码不正确/)
  })
})

/* ------------------------------------------------------------ R1 状态持久化 + R2 就地弹窗 */

test('R1-01 页面内联状态恢复脚本；零外链；CSP 只按 sha256 放行这一段（不用 unsafe-inline）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url, { headers: { cookie: cookie! } })
    assert.equal(res.status, 200)
    const html = await res.text()
    const { CONSOLE_SCRIPT, consoleScriptCspHash } = await import('./client-script.ts')

    // 主页面必须内联恢复脚本，且脚本与 CSP 同源（同一常量算出的 hash）
    assert.ok(html.includes('<script>' + CONSOLE_SCRIPT + '</script>'), '页面必须内联状态恢复脚本')

    // 载体纪律：sessionStorage + dcm: 前缀；绝不使用 localStorage
    assert.match(CONSOLE_SCRIPT, /window\.sessionStorage/)
    assert.match(CONSOLE_SCRIPT, /'dcm:'/)
    assert.doesNotMatch(CONSOLE_SCRIPT, /localStorage/)

    // 跳过逻辑必须是**显式黑名单**（type 与 name 两条）
    assert.match(CONSOLE_SCRIPT, /BLOCKED_TYPES = \{ password: 1, hidden: 1, file: 1, submit: 1, button: 1, reset: 1, image: 1 \}/)
    assert.match(CONSOLE_SCRIPT, /BLOCKED_NAMES = \/\(token\|password\|passwd\|secret\|credential\|phrase\|cookie\|apikey\|authorization\)\/i/)

    // 零外链：没有指向任何外部资源的 script/link/img
    assert.doesNotMatch(html, /https?:\/\//)
    assert.doesNotMatch(html, /<script[^>]+src=/)
    assert.doesNotMatch(html, /<link\b/)

    // CSP：script-src 只有这一个 hash-source；不放 unsafe-inline
    const csp = res.headers.get('content-security-policy') ?? ''
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1]?.trim() ?? ''
    assert.equal(scriptSrc, consoleScriptCspHash(), 'CSP 的 script-src 必须等于该脚本的 sha256 hash')
    assert.doesNotMatch(scriptSrc, /unsafe-inline/)
    assert.match(csp, /default-src 'none'/)
  })
})

test('R1-02 无 JS 降级是纯 HTML：确认表单在 <details open> 里原样可提交（服务端不渲染 <dialog>）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/disk')

    // 弹窗是客户端增强：服务端 HTML 里根本没有 <dialog>，禁用 JS 时不存在这一步
    assert.doesNotMatch(html, /<dialog/)
    // 默认展开 → 表单在禁用 JS 时与改造前一样直接可见
    assert.match(html, /<details class="confirmWrap" data-dcm-confirm open>/)

    const formAt = html.indexOf('<form class="confirmForm" method="post" action="/disk/cleanup">')
    assert.ok(formAt > 0, '表单必须原样提交到同一 action')
    const tail = html.slice(formAt)
    // 一次性 token 与提交按钮都在表单里（无脚本也能完成这一次写动作）
    assert.match(tail, /<input type="hidden" name="token" value="[0-9a-fA-F-]{36}">/)
    assert.match(tail, /<button class="btnPrimary" type="submit">按勾选执行清理<\/button>/)
    // 勾选项是纯 HTML checkbox（没有任何脚本/JS 依赖）
    assert.match(tail, /<input type="checkbox" name="caches"/)
    assert.match(tail, /<input type="checkbox" name="expired-exports">/)
  })
})

test('R1-03 password 字段无 value 属性；且被显式黑名单排除在持久化之外', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)
    await fs.mkdir(paths.exportsDir, { recursive: true })
    // 前 4 字节 = DCA1 → 形态判定为加密容器；页面只有这时才渲染密码输入框
    await fs.writeFile(path.join(paths.exportsDir, 'locked.zip'), Buffer.concat([Buffer.from('DCA1', 'ascii'), Buffer.alloc(32, 7)]))

    const html = await getPage(handle, cookie!, '/unlock')
    const tag = /<input[^>]*type="password"[^>]*>/.exec(html)
    assert.ok(tag !== null, '加密容器必须给出密码输入框')
    assert.doesNotMatch(tag![0], /value=/, 'password 字段不得带任何 value 属性（值只能在 POST 那一刻从浏览器取）')
    assert.match(tag![0], /name="password"/)

    const { CONSOLE_SCRIPT } = await import('./client-script.ts')
    // 显式黑名单同时覆盖「密码类型」与「密码字段名」两条路径
    assert.match(CONSOLE_SCRIPT, /password: 1/)
    assert.match(CONSOLE_SCRIPT, /password\|passwd/)
  })
})

test('R2-01 弹窗只是展示层：token 语义不变；结果页给出「返回上一页并恢复原位置」', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const diskHtml = await getPage(handle, cookie!, '/disk')
    assert.match(diskHtml, /data-dcm-confirm/)
    // 一次性 token 仍在 form 内、仍绑定同一 action（服务端校验顺序未动）
    const token = actionTokenOf(diskHtml)

    const res = await postForm(handle, cookie!, '/disk/cleanup', { token, caches: 'on' })
    assert.ok(res.status === 200 || res.status === 409)
    // 结果页：返回上一页入口（有 JS 走 history.back()，无 JS 回落到列表页）
    assert.match(res.body, /data-dcm-back/)
    assert.match(res.body, /返回上一页并恢复原位置/)
    assert.match(res.body, /href="\/disk"/)
    // 结果页同样带恢复脚本：返回列表页时靠它恢复滚动与勾选
    const { CONSOLE_SCRIPT } = await import('./client-script.ts')
    assert.ok(res.body.includes('<script>' + CONSOLE_SCRIPT + '</script>'))

    // token 仍然一次性：同一个 token 再提交一次必须被拒
    const again = await postForm(handle, cookie!, '/disk/cleanup', { token, caches: 'on' })
    assert.equal(again.status, 400)
  })
})

test('R2-03 写动作必须在真实浏览器里可达：HTML 的 referrer-policy 不能抹掉 Origin', async () => {
  // 既有缺陷（本仓实测，2026-10）：Chromium 把表单 POST 的 Origin 头与 referrer 策略绑定 ——
  // 响应头写 no-referrer 时，同源 <form method="post"> 会带 `Origin: null`，被 kit 的围栏
  // （new URL(origin).host === host）判成非法来源，救急台所有写动作 403。这里钉住两件事：
  // ① HTML 响应一律 same-origin（跨源仍然零 Referer）；② 带一次性 token 的 302 那一步保持 no-referrer。
  await withConsole(async (handle) => {
    // 一次性 token 只用一次：这里自己取 cookie（不能用 bootstrap() 两次）
    const boot = await fetch(handle.bootstrapUrl, { redirect: 'manual' })
    assert.equal(boot.status, 302)
    assert.equal(boot.headers.get('referrer-policy'), 'no-referrer', '带 token 的那一步保持零 Referer')
    const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    assert.ok(cookie.startsWith(CONSOLE_SESSION_COOKIE + '='))

    // 模拟 Chromium 在 no-referrer 下的真实请求：Origin: null 必须被围栏拒绝（围栏本身不能放宽）
    const html = await getPage(handle, cookie, '/disk')
    const token = actionTokenOf(html)
    const nullOrigin = await fetch(handle.url.replace(/\/$/, '') + '/disk/cleanup', {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({ token, caches: 'on' }).toString(),
      redirect: 'manual',
    })
    assert.equal(nullOrigin.status, 403, 'Origin: null 必须被围栏拒绝（不得为了修浏览器而放宽围栏）')

    // 正常浏览器（same-origin 策略）下带真 Origin 的同一次 POST 是通的
    const okOrigin = await fetch(handle.url.replace(/\/$/, '') + '/disk/cleanup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: handle.url.replace(/\/$/, '') },
      body: new URLSearchParams({ token, caches: 'on' }).toString(),
      redirect: 'manual',
    })
    assert.ok(okOrigin.status === 200 || okOrigin.status === 409, '带真 Origin 的 POST 必须正常执行')
  })
})

test('R3-01 页面过渡/骨架是无脚本的纯 CSS：禁用 JS 也成立，且不外链任何资源', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/disk')
    // 骨架层是 HTML 元素（不是 JS 注入）：禁用 JS 时它同样存在，并在 2.4s 后由 CSS 自己隐藏
    assert.match(html, /<div class="skeleton" aria-hidden="true">/)
    assert.match(html, /class="skeletonBar"/)
    assert.match(html, /class="skeletonCard"/)
    // 过渡/骨架全部来自内联 STYLE，没有任何外链或第三方
    assert.match(html, /@keyframes dcmFadeUp/)
    assert.match(html, /@keyframes dcmShimmer/)
    assert.match(html, /@keyframes dcmSkeletonOut/)
    assert.match(html, /prefers-reduced-motion:reduce/)
    assert.doesNotMatch(html, /https?:\/\//)
    assert.doesNotMatch(html, /<link\b/)
  })
})

test('R1-01 写入门讲成可操作步骤：DSH 在跑时给出实例/解除命令/「重新检查」，但页面绝不代关进程', async () => {
  await withConsole(async (handle, paths) => {
    // 造一条活心跳（pid 用当前进程，保证判活）→ 门必然是 dsh-running
    await fs.mkdir(path.join(paths.controlRoots[0]!, 'running'), { recursive: true })
    await fs.writeFile(path.join(paths.controlRoots[0]!, 'running', 'web.json'), JSON.stringify({
      schemaVersion: 1, name: 'web', pid: process.pid, port: 3081,
      startedAt: new Date().toISOString(), updatedAt: Date.now(),
    }))
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/sessions')
    assert.match(html, /data-dcm-gate="dsh-running"/)
    assert.match(html, /正在运行的实例/)
    assert.match(html, /解除步骤/)
    assert.match(html, /dsh-config-manager stop web/)
    assert.match(html, /重新检查门状态/)
    // 边界：页面只给指引，绝不自己关进程
    assert.match(html, /本页不会替你关掉任何进程/)
    assert.doesNotMatch(html, /stopProfile\(/)

    // 覆盖度必须写清「深查的是哪些」（限额按最近写入优先，不写会被读成随机故障）
    assert.match(html, /按最近写入优先/)

    // 门开着时不出门卡片，且给出正向结论
    await fs.rm(path.join(paths.controlRoots[0]!, 'running', 'web.json'), { force: true })
    const open = await getPage(handle, cookie!, '/sessions')
    assert.doesNotMatch(open, /data-dcm-gate="dsh-running"/)
  })
})

test('R1-02 就地修复入口：能力边界如实呈现（只做重放重复行，其余注明只报告）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/sessions')
    assert.match(html, /修复二：重放重复行/)
    assert.match(html, /零损失/)
    // 分母必须给出来（「没发现」不能是拍胸脯）
    assert.match(html, /探测了 <strong>0<\/strong> 条/)
    assert.match(html, /本次没有发现可零损失修复的会话/)
  })
})

/**
 * C1b：救急台「修复二」段不得再把 `sessions repair --apply` 说成等价通道（它不碰字节），
 * 同时「修复一：会话布局归位」卡里**成立**的等价命令**必须还在** —— 防以后一刀切删掉那一处。
 */
test('R1-02b 「修复二」段不把 sessions repair 说成等价通道；「修复一」布局归位卡的等价命令仍在', async () => {
  await withConsole(async (handle, paths) => {
    const { cookie } = await bootstrap(handle)

    // ① 空盘（没有可零损失修项）：这一段最容易把「布局归位」说成「重放去重」的等价通道
    const empty = await getPage(handle, cookie!, '/sessions')
    const emptyInline = cardOf(empty, '修复二：重放重复行')
    assert.doesNotMatch(emptyInline, /等价命令/, '修复二段不得再出现「等价命令」表述')
    assert.doesNotMatch(emptyInline, /sessions repair --apply/, '修复二段不得把 sessions repair --apply 当成出口')
    // 新表述：指向本救急台自己的就地操作 + 写明 sessions repair 的职责边界
    assert.match(emptyInline, /职责边界/)
    assert.match(emptyInline, /sessions repair \[--fix\]/)
    assert.match(emptyInline, /不改写会话字节/)
    assert.match(emptyInline, /dcm web/)
    assert.match(emptyInline, /修复选中的会话（零损失）/) 

    // ② 造一条错位会话 → 出现可执行的布局归位表单：那里的等价命令是**成立**的，必须保留
    const { encodeZstdFrame } = await import('../../utils/zstd-frame.ts')
    const dir = path.join(paths.homeDir, 'sessions', '--D-Ghost-proj--', 'session-layout')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
      encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-layout', cwd: 'D:/Real/proj' }) + '\n', 'utf8')),
      encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
    ]))

    const page = await getPage(handle, cookie!, '/sessions')
    const layout = cardOf(page, '修复一：会话布局归位')
    assert.match(layout, /等价命令：dsh-config-manager sessions repair --apply/, '布局归位卡的等价命令是成立的，不得被一刀切删掉')
    const inline = cardOf(page, '修复二：重放重复行')
    assert.doesNotMatch(inline, /等价命令/, '修复二段（有可修项时）同样不得出现等价命令表述')
    assert.match(inline, /职责边界/)
  })
})

/**
 * C1c：会话页的「写入口」事实必须唯一且真实，且卡片段里不得再把 `**` 当强调符号输出成字面星号。
 *
 * 这里**直接渲染** renderSessionsPage（页面是服务端直出 HTML，渲染结果就是用户看到的字节）：
 * 「修复二」段有两条分支（无零损失可修项 → 只报告分布段；有可修项 → 确认表单），
 * 两条分支过去各有一处 `**`，走 HTTP + 造会话夹具只能覆盖其中一条。
 */
test('C1c 会话页写入口表述真实（不说「本页不提供」）+ 修复二段无字面 **', () => {
  const paths: RescuePaths = {
    homeDir: 'D:/home',
    dataDir: 'D:/home/dsh-config-manager',
    snapshotsDir: 'D:/home/dsh-config-manager/snapshots',
    exportsDir: 'D:/home/dsh-config-manager/exports',
    locksDir: 'D:/home/dsh-config-manager/locks',
    controlRoots: ['D:/home/dsh-config-manager'],
    profile: 'web',
  }
  const result: SessionHealthScanResult = {
    rows: [{
      unitId: '--D--/a',
      sessionId: 'a',
      projectKey: '--D--',
      severity: 'nextRequestFails',
      issues: [{ code: 'seq-gap', severity: 'nextRequestFails' }],
    }],
    summary: {
      total: 1,
      bySeverity: { blocksStartup: 0, unloadable: 0, nextRequestFails: 1, invisible: 0, ok: 0 },
      structurallyChecked: 1,
      deepVerified: 1,
      deepUnverified: 0,
    },
    untested: 0,
    unreadableEntries: 0,
    sessionsDir: 'D:/home/sessions',
    sessionsDirExists: true,
  }
  const blockedInline: InlineRepairView = { fixable: [], probed: 3, blocked: [{ reason: 'seq-gap', count: 2 }] }
  const blocked = renderSessionsPage(result, undefined, '0.0.0-test', paths, null, 'tok', '', null, blockedInline)

  // ① fixHint（有「需要处理」的行才渲染）：不得再声称「本页不提供」——同页「修复一」卡就是本页提供的写动作
  const problems = cardOf(blocked, '需要处理的会话（')
  assert.doesNotMatch(problems, /本页不提供/, 'fixHint 不得再声称本页不提供该写动作（自相矛盾）')
  assert.match(problems, /本页<strong>提供<\/strong>两个写入口/, '必须正向写清本页提供哪些写入口')
  assert.match(problems, /sessions repair --apply/, '「修复一」的等价命令是成立的，仍要如实给出')

  // ② 无零损失可修项 + 有「只报告」原因分布 → 该分支确实渲染，且强调是真 <strong> 而不是字面 **
  assert.match(blockedInlineCard(blocked), /只报告/, '该分支必须真的渲染「只报告」文案（否则下面的断言是假阴性）')
  assert.match(blockedInlineCard(blocked), /<strong>只报告<\/strong>/, '强调必须是真 <strong>')
  assert.doesNotMatch(blockedInlineCard(blocked), /\*\*/, '卡片段里不得再出现字面 **')

  // ③ 有零损失可修项 → 确认表单分支（consequence 里也曾有字面 **）
  const fixable = renderSessionsPage(result, undefined, '0.0.0-test', paths, null, 'tok', '', null,
    { fixable: [{ unitId: '--D--/a', droppedRows: 3 }], probed: 1, blocked: [] })
  const fixableCard = cardOf(fixable, '修复二：重放重复行')
  assert.match(fixableCard, /修复选中的会话（零损失）/, '该分支必须真的渲染确认表单')
  assert.doesNotMatch(fixableCard, /\*\*/, '确认表单段同样不得出现字面 **')

  // ④ 不误伤：页脚速查表照旧；「修复一」卡里那处**成立**的等价命令仍在源码里（渲染路径见 R1-02b 的真实磁盘用例）
  assert.match(fixable, /会话布局归位（本页按同一实现执行）/, '页脚速查表不得被误改')

  // ⑤ 源码级：fixHint 那一小段里不得再有「本页不提供」（页面另外两处是别的写动作，别误伤）
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.ts'), 'utf8')
  const at = source.indexOf('const fixHint =')
  assert.notEqual(at, -1, '源码里找不到 fixHint')
  const snippet = source.slice(at, source.indexOf('parts.push(section(', at))
  assert.doesNotMatch(snippet, /本页不提供/, 'fixHint 源码段不得再出现「本页不提供」')
  assert.match(snippet, /PAGE_SESSION_WRITE_ENTRIES/, 'fixHint 只能渲染单一事实源常量')
  // 「修复一」布局归位卡的等价命令是**成立**的（本页与 CLI 同实现），不得被这轮收尾一刀切删掉
  assert.ok(source.includes('等价命令：dsh-config-manager sessions repair --apply'), '布局归位卡的等价命令必须仍在')
})

/** 取「修复二」段卡片（C1c 用例内部用，避免页脚命中造成假阴性）。 */
function blockedInlineCard(html: string): string {
  return cardOf(html, '修复二：重放重复行')
}

/**
 * 取页面**正文**（`<body>` … `<footer>`）。
 *
 * 为什么要切片：页脚（renderFooter）**每一页**都印同一份速查表，整页 match 会把它命中成假阴性
 * （C1b 实测过），`<head>` 里的样式/脚本也不是用户看到的正文。
 */
function bodyOf(html: string): string {
  const start = html.indexOf('<body>')
  assert.notEqual(start, -1, '页面没有 <body>')
  const end = html.indexOf('<footer>', start)
  assert.notEqual(end, -1, '页面没有 <footer>（速查表页脚是每页都渲染的）')
  return html.slice(start, end)
}

/**
 * C1d：救急台是**多页**的，所以每一页正文里都不许出现
 *  ① 字面 `**`（强调符号被当正文输出，用户看到星号）；
 *  ② 空泛的「本页不提供」（captain 裁决：要么指向**本页内真实存在**的入口，要么**点名到页**）。
 *
 * **覆盖口径**：枚举来源 = `page.ts` 导出的全部 `render*Page(`（= 整页渲染入口），并用集合相等断言钉住 ——
 * 新增一个页面而不登记进 `pages` 会直接红（此前只渲染 7 页却宣称「各页正文」，t11 抓到）。
 * 断言落在**正文切片**上（页脚不计入，避免 C1b 遇到过的假阴性）；每页先跑一条**非空证明**，
 * 证明该分支确实渲染了，否则「不存在」类断言会退化成空态假阴性。
 */
test('C1d 各页正文无字面 ** 且无空泛「本页不提供」（枚举 = page.ts 全部 render*Page）', () => {
  const paths: RescuePaths = {
    homeDir: 'D:/home',
    dataDir: 'D:/home/dsh-config-manager',
    snapshotsDir: 'D:/home/dsh-config-manager/snapshots',
    exportsDir: 'D:/home/dsh-config-manager/exports',
    locksDir: 'D:/home/dsh-config-manager/locks',
    controlRoots: ['D:/home/dsh-config-manager'],
    profile: 'web',
  }
  const version = '0.0.0-test'
  const snapshot: SnapshotMeta = {
    id: 'snap-1',
    createdAt: '2026-10-07T00:00:00.000Z',
    sourceZip: 'dsh-config.zip',
    entryCount: 3,
    hostFileBackupCount: 0,
    beforePluginCount: 0,
  }
  // 选中某快照后的恢复计划：只有带危险动作，页面才会渲染 POST /restore/run 的确认表单
  const restorePlan: RestorePlanView = {
    ok: true,
    code: 'ok',
    message: '',
    snapshotId: 'snap-1',
    pluginBaselineConfirmed: false,
    actions: [{ kind: 'hostFileRestore', description: '还原 settings', target: 'D:/home/settings.yaml', dangerous: true }],
    summary: { hostFileRestores: 1 },
  }
  const lock: LockReport = { locksDir: paths.locksDir, present: true, state: 'LOCKED' }
  const homeLock: LockReport = { locksDir: paths.locksDir, present: false, state: 'NONE' }
  const status: RescueStatus = {
    generatedAt: '2026-10-07T00:00:00.000Z',
    paths,
    safeMode: [],
    lock: homeLock,
    instances: [],
    snapshots: [snapshot],
    backups: [],
    errors: [],
  }
  const areas = Object.fromEntries(DISK_USAGE_AREAS.map((area) => [area, {
    sizeBytes: 0,
    fileCount: 0,
    policy: 'regenerable' as const,
    unreadable: false,
  }])) as DiskUsageReport['areas']
  const diskReport: DiskUsageReport = {
    dataDir: paths.dataDir,
    totalBytes: 0,
    totalFiles: 0,
    reclaimableBytes: 0,
    expiredBytes: 0,
    areas,
    backupRetention: { keepLast: 10, latestBackupBytes: 0, latestBackupAt: null },
  }
  const encrypted: BackupFileMeta[] = [{
    name: 'dsh-config-enc.zip',
    path: 'D:/home/dsh-config-manager/exports/dsh-config-enc.zip',
    sizeBytes: 2048,
    mtimeMs: 1_700_000_000_000,
    source: 'manual',
  }]

  const home = renderHomePage({ status, version })
  const sessions = renderSessionsPage(
    {
      rows: [{
        unitId: '--D--/a', sessionId: 'a', projectKey: '--D--', severity: 'nextRequestFails',
        issues: [{ code: 'seq-gap', severity: 'nextRequestFails' }],
      }],
      summary: {
        total: 1, bySeverity: { blocksStartup: 0, unloadable: 0, nextRequestFails: 1, invisible: 0, ok: 0 },
        structurallyChecked: 1, deepVerified: 1, deepUnverified: 0,
      },
      untested: 0, unreadableEntries: 0, sessionsDir: 'D:/home/sessions', sessionsDirExists: true,
    },
    undefined, version, paths, null, 'tok', '', null,
    { fixable: [], probed: 1, blocked: [{ reason: 'seq-gap', count: 1 }] },
  )
  const restore = renderRestorePage([snapshot], restorePlan, version, paths, 'tok')
  const disk = renderDiskPage(diskReport, version, paths, 'tok', '')
  const lockPage = renderLockPage(lock, version, paths, 'tok', '')
  const unlock = renderUnlockPage(encrypted, version, paths, 'tok', '')
  const reinstall = renderReinstallPage(
    [{ id: 'plugins', label: '插件', desc: '清空 ~/.dsh 的插件目录', destructive: true, defaultOn: false }],
    version, paths, 'tok',
  )

  // 导出页（本轮纳入 sweep 的那一页；banner 正文曾出现字面 **）
  const exportPage = renderExportPage(['settings', 'providers'], ['mcp'], version, paths, 'tok')
  const verify = renderVerifyPage({
    file: 'D:/home/dsh-config-manager/exports/dsh-config.zip', verdict: 'OK',
    sizeBytes: 2048, entryCount: 3, sections: ['settings'], errors: [], warnings: [],
  }, version, paths)
  const result = renderResultPage('就地修复完成（零损失）', ['✔ --D--/a：已丢弃 2 行重放重复事件'], version, paths, 'ok', '/sessions')
  const profiles = renderProfilesPage({
    ok: true, profilesDir: 'D:/home/profiles', errors: [],
    rows: [{
      name: 'web', shape: 'web', bundles: 3, dependencies: 12, hasNodeModules: true,
      patchEntryCount: 2, updatedAtMs: 1_700_000_000_000, dshVersion: '0.2.0', sessionFormatVersion: 4,
      launchable: true, owned: false, running: false, port: null, url: null, pid: null,
    }],
  }, version, paths, 'tok', '', '')
  const message = renderMessagePage('403 需要访问链接', '请回到终端，用打印出来的带 token 链接打开本页。', '链接用过即废。')

  // 枚举来源：page.ts 里**全部** `export function render*Page(`（每个 = 一个整页渲染入口；
  // `renderLayout` 是外壳、`renderConfirmForm` 是片段，不在此列）。
  // 下面这条集合相等断言保证「新增页面不登记进 sweep」会红 —— 本轮之前 C1d 只渲染 7 页却宣称「各页正文」，
  // 正是缺这条（t11 抓到）。
  const declared = [...readFileSync(new URL('./page.ts', import.meta.url), 'utf8')
    .matchAll(/export function (render\w*Page)\s*\(/g)].map((m) => m[1] ?? '').sort()

  const pages: Array<{ fn: string; name: string; html: string; slice?: (html: string) => string }> = [
    { fn: 'renderHomePage', name: '首页', html: home },
    { fn: 'renderSessionsPage', name: '会话', html: sessions },
    { fn: 'renderRestorePage', name: '恢复', html: restore },
    { fn: 'renderDiskPage', name: '磁盘', html: disk },
    { fn: 'renderLockPage', name: '残留锁', html: lockPage },
    { fn: 'renderUnlockPage', name: '解锁', html: unlock },
    { fn: 'renderReinstallPage', name: '重装', html: reinstall },
    { fn: 'renderVerifyPage', name: '备份自检', html: verify },
    { fn: 'renderExportPage', name: '导出', html: exportPage },
    { fn: 'renderProfilesPage', name: '档案', html: profiles },
    { fn: 'renderResultPage', name: '写动作结果', html: result },
    // 403/404 极简页**没有 <footer>**（刻意不依赖任何目录事实），所以不走 bodyOf 的切片，取 <body> 起的整段。
    { fn: 'renderMessagePage', name: '错误极简页', html: message, slice: (h) => h.slice(h.indexOf('<body>')) },
  ]
  assert.deepEqual(
    pages.map((p) => p.fn).sort(),
    declared,
    'sweep 必须穷尽 page.ts 的全部 render*Page（枚举来源 = 该模块的 export function render*Page）',
  )

  // 非空证明表（每页一条）：先证明「该段确实渲染了」，否则上面的「不得出现 **」会退化成空态假阴性
  const proofs: Record<string, RegExp> = {
    renderHomePage: /需要终端里打印的 6 位确认码/,
    renderSessionsPage: /需要处理的会话/,
    renderRestorePage: /恢复计划（/,
    renderDiskPage: /导出产物只在勾选时、且只按保留期回收/,
    renderLockPage: /不会自动回收/,
    renderUnlockPage: /会在内存中解出明文 ZIP/,
    renderReinstallPage: /只在终端里打印的 6 位确认码/,
    renderExportPage: /settings \/ providers \/ mcp 等结构化分区的值必须经 DSH 服务读取/,
    renderVerifyPage: /自检通过/,
    renderProfilesPage: /档案 = DSH 的 profile/,
    renderResultPage: /逐条结果/,
    renderMessagePage: /403/,
  }
  for (const page of pages) {
    const body = page.slice !== undefined ? page.slice(page.html) : bodyOf(page.html)
    const proof = proofs[page.fn]
    assert.ok(proof !== undefined, page.name + '：sweep 里每页都必须有非空证明（否则可能空态假阴性）')
    assert.match(body, proof, page.name + '：该段确实渲染（非空证明，避免空态假阴性）')
    assert.doesNotMatch(body, /\*\*/, page.name + '：正文不得出现字面 **（强调符号被当正文输出）')
    assert.doesNotMatch(body, /本页不提供/, page.name + '：正文不得出现空泛的「本页不提供」（要么指向本页入口，要么点名到页）')
  }

  // 交叉证明（原有用例，保留）：被点名的页 / 入口确实存在
  const homeBody = bodyOf(home)
  assert.match(homeBody, /请在「恢复」页执行/, '首页快照卡必须点名到「恢复」页')
  assert.match(homeBody, /本页（首页）不提供/, '「本页」必须限定为首页，不留空泛说法')
  const diskBody = bodyOf(disk)
  assert.match(diskBody, /清理是写动作，就在本页下方「清理磁盘（写动作）」卡里执行/, '磁盘保留期说明必须指向本页的清理入口')
  assert.match(diskBody, /action="\/disk\/cleanup"/, '被指向的入口在本页真实存在（裁决 (a) 成立）')
  assert.match(bodyOf(restore), /action="\/restore\/run"/, '点名到的「恢复」页确实提供该写动作（裁决 (b) 成立）')
})

test('R1-03 就地修复写路由：token 一次性；没 token 一律 400（不写任何字节）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const missing = await postForm(handle, cookie!, '/sessions/inline-repair', { 'unit:x': 'on' })
    assert.equal(missing.status, 400, '缺 token 先 400（与既有写路由同序：token → 门）')
    const forged = await postForm(handle, cookie!, '/sessions/inline-repair', { token: 'nope' })
    assert.equal(forged.status, 400)
  })
})

test('R2-02 403/404 极简页保持无脚本（renderMessagePage 不内联任何东西）', async () => {
  await withConsole(async (handle) => {
    const anon = await fetch(handle.url)
    assert.equal(anon.status, 403)
    const anonBody = await anon.text()
    assert.match(anonBody, /需要从终端打印的链接进入/)
    assert.doesNotMatch(anonBody, /<script/)

    const { cookie } = await bootstrap(handle)
    const notFound = await fetch(handle.url.replace(/\/$/, '') + '/nope', { headers: { cookie: cookie! } })
    assert.equal(notFound.status, 404)
    const notFoundBody = await notFound.text()
    assert.match(notFoundBody, /<!doctype html>/)
    assert.doesNotMatch(notFoundBody, /<script/)

    // 未认证页面（config 之外的 403）同样保持无脚本
    const noCookie = await fetch(handle.url.replace(/\/$/, '') + '/disk')
    assert.equal(noCookie.status, 403)
    assert.doesNotMatch(await noCookie.text(), /<script/)
  })
})

test('R3-02 设计 system token 契约：亮色全集/暗色覆盖颜色、var() 无悬空、文字对比度 AA', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/disk')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]
    assert.ok(style, '页面必须自带内联 <style>')

    // 零外链的第二道守卫（CSP default-src 'none' 是第一道）：字体/图标/外部样式一律不许出现
    assert.doesNotMatch(style!, /@import/)
    assert.doesNotMatch(style!, /@font-face/)
    assert.doesNotMatch(style!, /url\(\s*['"]?https?:/)

    const parse = (blockText: string | undefined): Map<string, string> => {
      assert.ok(blockText, '缺少 :root 定义')
      const out = new Map<string, string>()
      for (const m of blockText!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)) out.set(m[1]!, m[2]!.trim())
      return out
    }
    const light = parse(/:root\{([^}]*)\}/.exec(style!)?.[1])
    // 暗色 token 刻意写两次：媒体查询 = 自动跟随系统；属性选择器 = 手动强制暗色。两者必须逐字相同。
    const darkMedia = /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{([^}]*)\}\}/.exec(style!)?.[1]
    const darkForced = /:root\[data-theme="dark"\]\{([^}]*)\}/.exec(style!)?.[1]
    assert.equal(darkForced, darkMedia, '强制暗色与「跟随系统」的暗色 token 必须逐字相同（防漂移）')
    const dark = parse(darkForced)

    // 1) 亮色是 token 全集，暗色只覆盖颜色（字体栈两套共用，刻意不在暗色块里重复）：
    //    暗色出现而亮色没有的 token = 亮色下静默拿不到值；颜色 token 漏覆盖 = 暗色沿用亮色值（瞎眼）。
    assert.deepEqual([...dark.keys()].filter((k) => !light.has(k)), [], '暗色不得定义亮色没有的 token')
    const colorTokens = ['fg', 'muted', 'bg', 'card', 'surface', 'line', 'accent', 'accent-hover', 'on-accent', 'ok', 'warn', 'bad', 'scrim']
    assert.deepEqual(colorTokens.filter((k) => !dark.has(k)), [], '暗色必须逐个覆盖全部颜色 token')

    // 2) 每个 var(--x) 都必须有定义，否则整条声明失效、静默回落
    const used = new Set([...style!.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!))
    assert.deepEqual([...used].filter((k) => !light.has(k)), [], 'var(--x) 不能悬空')

    // 3) 文字色对必须过 AA（4.5:1）—— 「不许把 Carbon 的填充档 #24a148 / #f1c21b 当文字色」的机器守卫
    const rgb = (v: string): [number, number, number] | null => {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
      if (hex) {
        const full = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!
        return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
      }
      const fn = /^rgba?\(([^)]+)\)$/.exec(v)
      if (!fn) return null
      const parts = fn[1]!.split(',').map((s) => Number.parseFloat(s.trim()))
      return [parts[0]!, parts[1]!, parts[2]!]
    }
    const lum = (c: [number, number, number]): number => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const contrast = (a: string, b: string): number => {
      const ca = rgb(a)
      const cb = rgb(b)
      assert.ok(ca && cb, '对比度只支持 #rrggbb / rgb()：' + a + ' / ' + b)
      const [hi, lo] = [lum(ca!), lum(cb!)].sort((x, y) => y - x)
      return (hi! + 0.05) / (lo! + 0.05)
    }
    for (const [scheme, tokens] of [['亮色', light], ['暗色', dark]] as const) {
      const base = tokens.get('card')!
      for (const key of ['fg', 'muted', 'accent', 'ok', 'warn', 'bad']) {
        const ratio = contrast(tokens.get(key)!, base)
        assert.ok(ratio >= 4.5, scheme + ' --' + key + ' 对 --card 只有 ' + ratio.toFixed(2) + ':1（< 4.5 AA）')
      }
      for (const key of ['accent', 'accent-hover']) {
        const ratio = contrast(tokens.get('on-accent')!, tokens.get(key)!)
        assert.ok(ratio >= 4.5, scheme + ' --on-accent 对 --' + key + ' 只有 ' + ratio.toFixed(2) + ':1（< 4.5 AA）')
      }
    }
  })
})

test('R3-03 三态主题：cookie 驱动、首帧前生效、无脚本时隐藏并回落系统自动', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const html = await getPage(handle, cookie!, '/')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
    const { CONSOLE_SCRIPT } = await import('./client-script.ts')

    // 开关是服务端直出的三方按钮（无脚本时整组隐藏，而不是给一个点不动的控件）
    assert.match(html, /<div class="themeSwitch" role="group" aria-label="配色">/)
    for (const mode of ['auto', 'light', 'dark']) {
      assert.ok(html.includes('<button type="button" class="themeBtn" data-dcm-theme="' + mode + '" aria-pressed="false">'), mode + ' 按钮必须直出且 type=button（不提交任何表单）')
    }
    assert.match(style, /\.themeSwitch\{display:none;/)
    assert.match(style, /:root\[data-dcm-js="1"\] \.themeSwitch\{display:inline-flex\}/)

    // 主题必须在**首帧之前**落地：脚本在 <head>、排在 <body> 之前
    const scriptAt = html.indexOf('<script>' + CONSOLE_SCRIPT + '</script>')
    assert.ok(scriptAt >= 0, '页面必须内联脚本')
    assert.ok(scriptAt < html.indexOf('<body>'), '脚本必须在 <head> 里（放 body 末尾会让强制主题先闪一下）')

    // 载体 = cookie（不区分端口 → 换端口重启也记得住）；不进任何 storage（R1-01 已禁 localStorage）
    assert.match(CONSOLE_SCRIPT, /var THEME_KEY = 'dcm-theme'/)
    assert.match(CONSOLE_SCRIPT, /document\.cookie/)
    assert.match(CONSOLE_SCRIPT, /max-age=31536000; SameSite=Lax/)
    assert.doesNotMatch(CONSOLE_SCRIPT, /localStorage/)

    // 强制浅色要压过「系统是暗色」，强制暗色要压过「系统是浅色」；原生控件配色跟着走
    assert.match(style, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{/)
    assert.match(style, /:root\[data-theme="dark"\]\{color-scheme:dark\}/)
    assert.match(style, /:root\[data-theme="light"\]\{color-scheme:light\}/)

    // 未认证的极简页（403）保持无脚本、也没有开关
    const anon = await fetch(handle.url)
    assert.equal(anon.status, 403)
    const anonBody = await anon.text()
    assert.doesNotMatch(anonBody, /<div class="themeSwitch"|<script/)
    assert.doesNotMatch(anonBody, /data-dcm-theme=/)
  })
})

/**
 * 在最小 fake DOM 上执行那段内联脚本：只喂它初始化真正会碰的东西。
 * 为什么要跑真脚本而不是匹配字符串：cookie 解析、模式合法性、首帧落地、点击委托都是**逻辑**，
 * 字符串断言挡不住「解析写错但看着像对」。
 */
function runConsoleScript(cookie: string): {
  attrs: Record<string, string>
  pressed: () => Record<string, string>
  click: (mode: string) => void
  cookieNow: () => string
} {
  const attrs: Record<string, string> = {}
  const state: Record<string, string> = { auto: 'false', light: 'false', dark: 'false' }
  const buttons = ['auto', 'light', 'dark'].map((mode) => ({
    parentNode: null,
    hasAttribute: (k: string) => k === 'data-dcm-theme',
    getAttribute: (k: string) => (k === 'data-dcm-theme' ? mode : state[mode]),
    setAttribute: (k: string, v: string) => { if (k === 'aria-pressed') state[mode] = v },
  }))
  const clicks: Array<(event: { target: unknown }) => void> = []
  const doc = {
    cookie,
    documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v } },
    // 只回答主题开关那一个选择器；其余查询一律空（本测试只驱动主题逻辑，不重跑状态恢复）
    createElement: () => ({}),
    querySelectorAll: (sel: string) => (sel === '[data-dcm-theme]' ? buttons : []),
    addEventListener: (type: string, fn: (event: { target: unknown }) => void) => { if (type === 'click') clicks.push(fn) },
  }
  // issue #70：源码字面量守卫必须与检出 EOL 无关（Windows core.autocrlf=true ⇒ CRLF 工作区）。
  // 仓库既有 11 处同款先例（readFileSync 后折 LF），这三处此前漏了。
  const script = readFileSync(new URL('./client-script.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = /export const CONSOLE_SCRIPT = `([\s\S]*?)`\n/.exec(script)?.[1]
  assert.ok(body, 'client-script.ts 必须导出 CONSOLE_SCRIPT 模板字符串')
  // 只喂脚本真正会碰的浏览器 API（显式列出，不用 Proxy 兜底 —— 缺哪个就报错，别让假 DOM 悄悄骗过测试）
  const win = {
    addEventListener: () => undefined,
    history: { length: 1 },
    location: { pathname: '/', search: '' },
    requestAnimationFrame: () => 0,
    sessionStorage: undefined,
  }
  // pageKey() 用的是裸 location（不是 window.location），所以单独作为参数喂进去
  new Function('document', 'window', 'location', body!)(doc, win, win.location)
  return {
    attrs,
    pressed: () => state,
    click: (mode) => { for (const fn of clicks) fn({ target: buttons.find((b) => b.getAttribute('data-dcm-theme') === mode) }) },
    cookieNow: () => doc.cookie,
  }
}

test('R3-04 主题脚本的真行为：cookie 解析 / 非法值回落自动 / 首帧落地 / 点击写回', () => {
  // 1) 没有 cookie → 自动（不写 data-theme=auto 之外的任何东西）
  const fresh = runConsoleScript('')
  assert.equal(fresh.attrs['data-theme'], 'auto')
  assert.equal(fresh.attrs['data-dcm-js'], '1')

  // 2) cookie 里的值生效（分号分隔、前后还有别的 cookie 也要认得）
  assert.equal(runConsoleScript('x=1; dcm-theme=dark; y=2').attrs['data-theme'], 'dark')
  assert.equal(runConsoleScript('dcm-theme=light').attrs['data-theme'], 'light')

  // 3) 非法值 / 被截断的值一律回落自动（绝不把未知字符串塞进 data-theme）
  assert.equal(runConsoleScript('dcm-theme=bogus').attrs['data-theme'], 'auto')
  assert.equal(runConsoleScript('dcm-theme=Dark').attrs['data-theme'], 'auto')
  assert.equal(runConsoleScript('dcm-theme=').attrs['data-theme'], 'auto')

  // 4) 点击写回：data-theme 立刻改、开关选中态跟着走、cookie 落盘（非敏感偏好）
  const clicky = runConsoleScript('')
  clicky.click('dark')
  assert.equal(clicky.attrs['data-theme'], 'dark')
  assert.equal(clicky.pressed()['dark'], 'true')
  assert.equal(clicky.pressed()['auto'], 'false')
  assert.match(clicky.cookieNow(), /(^|; )dcm-theme=dark/)
  assert.match(clicky.cookieNow(), /max-age=31536000; SameSite=Lax/)
  clicky.click('auto')
  assert.equal(clicky.attrs['data-theme'], 'auto')
  assert.match(clicky.cookieNow(), /dcm-theme=auto/)
})
/* ------------------------------------------------ t26 新增回归（cli-F1/F3/F4/F6/F7） */

/** 造一条「本插件启动的实例」台账（pid = 当前进程，isProcessAlive 必然为真）。 */
async function seedLaunchedInstance(paths: RescuePaths, name: string, url: string): Promise<void> {
  const profileDir = path.join(paths.homeDir, 'profiles', name)
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name, version: '0.0.0', dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  }))
  await fs.mkdir(paths.dataDir, { recursive: true })
  await fs.writeFile(path.join(paths.dataDir, 'launches.json'), JSON.stringify({
    version: 1,
    launches: [{
      name, port: 3099, pid: process.pid, url,
      logFile: path.join(paths.dataDir, 'launch.log'), startedAt: new Date().toISOString(),
    }],
  }))
}

test('cli-F1 救急台回传的授权 URL 不得被脱敏抹掉（入口链接逐字节等于台账 URL）', async () => {
  await withConsole(async (handle, paths) => {
    const authUrl = 'http://127.0.0.1:3099/?token=probe-token-abc123'
    await seedLaunchedInstance(paths, 'probe-demo', authUrl)
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url.replace(/\/$/, '') + '/profiles', { headers: { cookie: cookie! } })
    assert.equal(res.status, 200)
    const html = await res.text()
    // 修复前：redact() 的 URL_QUERY_RE 把 token 值换成 ***REDACTED***，点开必然 401
    assert.ok(html.includes('<a href="' + authUrl + '">打开实例</a>'), '入口链接必须带真实 token')
    assert.doesNotMatch(html, /token=\*\*\*REDACTED\*\*\*/)
  })
})

test('cli-F3 页面必须禁止被 iframe 嵌入（frame-ancestors + X-Frame-Options）', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url, { headers: { cookie: cookie! } })
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.match(csp, /frame-ancestors 'none'/, 'default-src 不覆盖 frame-ancestors，必须显式声明')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    // 403 极简页走同一个写出点，也必须带上
    const anon = await fetch(handle.url)
    assert.equal(anon.status, 403)
    assert.match(anon.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(anon.headers.get('x-frame-options'), 'DENY')
  })
})

test('cli-F4 方法不被允许时必须是 HTML 错误页，不得吐插件 API 形状的裸 JSON', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url, { method: 'POST', headers: { cookie: cookie! } })
    assert.equal(res.status, 405)
    const body = await res.text()
    assert.match(body, /<html lang="zh-CN">/, '405 必须渲染成页面')
    assert.ok(!body.startsWith('{"error"'), '不得是 kit 的 JSON 出口')
    // 方法判定不得改变「路由未命中」语义
    const nope = await fetch(handle.url.replace(/\/$/, '') + '/nope', { method: 'POST', headers: { cookie: cookie! } })
    assert.equal(nope.status, 404)
  })
})

test('cli-F6 /healthz 的写路由自述必须与真实声明同源且完整', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    const res = await fetch(handle.url.replace(/\/$/, '') + '/healthz', { headers: { cookie: cookie! } })
    const payload = await res.json() as { writes: string[]; writeRoutes?: string[] }
    assert.deepEqual(payload.writes, ['sessions-repair', 'disk-cleanup', 'recover-stale-lock'], '既有 writes 契约不变')
    assert.ok(Array.isArray(payload.writeRoutes), '/healthz 必须自述全部写路由')
    const declared = payload.writeRoutes as string[]
    for (const line of [
      'POST /sessions/repair', 'POST /sessions/inline-repair', 'POST /disk/cleanup', 'POST /lock/recover',
      'POST /profiles/launch', 'POST /profiles/stop', 'POST /unlock/run', 'POST /restore/run',
      'POST /export/run', 'POST /reinstall/plan', 'POST /reinstall/run',
    ]) {
      assert.ok(declared.includes(line), '缺写路由自述: ' + line + ' → ' + declared.join(','))
    }
    assert.ok(!declared.some((line) => line.startsWith('GET ')), 'GET 路由不得混进写自述')
  })
})

test('cli-F7 //x 形态的请求目标不得被解析成首页', async () => {
  await withConsole(async (handle) => {
    const { cookie } = await bootstrap(handle)
    // 协议相对目标：修复前 new URL('//evil') 得到 authority=evil / pathname='/' → 冒充首页
    const evil = await fetch(handle.url.replace(/\/$/, '') + '//evil', { headers: { cookie: cookie! } })
    assert.equal(evil.status, 404, '//evil 不是合法页面，不得返回首页')
    // //disk 折叠成 /disk：必须是**磁盘页**（有该页专属的 section 标题），不是首页
    const disk = await fetch(handle.url.replace(/\/$/, '') + '//disk', { headers: { cookie: cookie! } })
    assert.equal(disk.status, 200)
    assert.match(await disk.text(), /磁盘占用（只读体检）/, '//disk 必须落到磁盘页而不是首页')
    const home = await fetch(handle.url, { headers: { cookie: cookie! } })
    assert.equal(home.status, 200)
  })
})

