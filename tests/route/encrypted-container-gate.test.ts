/**
 * 未解锁加密容器：/analyze、/plan、/execute 三道闸门的回归测试（P2-T3-1）。
 *
 * 背景（审计报告 §6.2 T3）：三处闸门此前**零测试** —— 全仓 0 处引用
 * ENCRYPTED_CONTAINER_CODE 或 'encrypted-container'（引擎侧 ENC-01/02 只覆盖
 * conformance 的加解密往返，不覆盖路由闸门）。若有人在重构中删掉其中一处，
 * 用户会看到 ZIP 解析器的「缺少中央目录结束记录」，被引向「备份坏了」的错误方向。
 *
 * 分工：
 *  - /execute 在 src/routes/import.ts，可在路由层实测（真 handler + 真临时目录）；
 *  - /analyze 与 /plan 内联在 src/index.ts 的 makeRoutes 里（与真宿主强耦合、无法
 *    在单测里构造），因此用本仓既有的「宿主接线守卫」手法做源码窗口断言；
 *  - 三种入口判据必须同源：读 src/security/container-kind.ts 的 readContainerKind +
 *    utils/shared-constants.ts 的 ENCRYPTED_CONTAINER_CODE + 400。
 *
 * 断言口径：错误码可判别 + **零写入**（目录清单与哨兵文件 mtime 不变）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { importRoutes } from '../../src/routes/import.ts'
import { encryptArchive } from '../../src/security/encryption.ts'
import { ENCRYPTED_CONTAINER_CODE } from '../../src/utils/shared-constants.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const EXECUTE_PATH = '/api/dsh-config-manager/execute'
const MSSG = 'import.encryptedContainerNeedsUnlock'

interface Harness {
  root: string
  exportsDir: string
  tmpDir: string
  homeDir: string
  /** 未解锁的加密容器（DCM 头部 magic 已由 encryptArchive 写入） */
  containerPath: string
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-enc-gate-')))
  const exportsDir = path.join(root, 'exports')
  const tmpDir = path.join(root, 'tmp')
  const homeDir = path.join(root, 'home')
  await fs.mkdir(exportsDir, { recursive: true })
  await fs.mkdir(tmpDir, { recursive: true })
  await fs.mkdir(homeDir, { recursive: true })
  // 一个「看起来像 ZIP」的明文载荷 + 加密 = 未解锁容器（与真备份同形态）
  const { blob } = await encryptArchive(Buffer.from('PK\u0003\u0004 fake zip payload', 'binary'), 'pw-under-test')
  const containerPath = path.join(exportsDir, 'backup-enc.dcm')
  await fs.writeFile(containerPath, blob)
  return { root, exportsDir, tmpDir, homeDir, containerPath, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

/** /execute 的 handler 真正读到的依赖（其余不会被执行到）。 */
function stubEnv(h: Harness): never {
  return {
    roots: [h.exportsDir, h.tmpDir],
    tmpDir: h.tmpDir,
    syncDir: path.join(h.homeDir, 'dsh-config-manager', 'sync'),
    host: { homeDir: h.homeDir, profile: 'web', log: { warn: () => undefined, error: () => undefined } },
    msg: (key: string) => key,
    runs: {
      register: () => ({ runId: 'run-1', kind: 'import', status: 'running', log: [] }),
      update: () => undefined, finish: () => undefined, fail: () => undefined,
      appendLog: () => undefined, setPendingDecision: () => undefined,
    },
    runAbortControllers: new Map(),
    runCancels: new Map(),
    withMutationGate: (_op: string, handler: unknown) => handler,
    makeImporter: () => ({ executeImportPlan: async () => ({ ok: true, executed: [], removedPlugins: [], manualHints: [], failed: [], skipped: [] }) }),
    tryAppendHistory: async () => undefined,
    bootSafetyAudit: async () => undefined,
    cancelDecisionTimeoutMs: 1000,
  } as never
}

function executeRoute(h: Harness): WebRoute {
  const route = importRoutes(stubEnv(h)).find((r) => r.path === EXECUTE_PATH)
  assert.ok(route !== undefined, '缺少 ' + EXECUTE_PATH)
  return route
}

function fakeRequest(body: unknown): IncomingMessage {
  return {
    method: 'POST', url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  } as unknown as IncomingMessage
}

interface FakeResponse { status: number; body: string }

async function call(route: WebRoute, body: unknown): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(fakeRequest(body), res as unknown as ServerResponse)
  return state
}

/** 目录清单（相对路径 + size + mtime）——用来证明「零写入」。 */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name
      const abs = path.join(current, entry.name)
      const st = await fs.lstat(abs)
      out.push(rel + '|' + String(st.size) + '|' + String(st.mtimeMs))
      if (entry.isDirectory()) await walk(abs, rel + '/')
    }
  }
  await walk(dir, '')
  return out
}

test('P2-T3-1: 错误码常量与客户端消费点同源（encrypted-container）', async () => {
  assert.equal(ENCRYPTED_CONTAINER_CODE, 'encrypted-container', '机器码必须稳定：客户端按它分派解锁引导')
  const shared = await readSource('src/utils/shared-constants.ts')
  assert.ok(shared.includes("ENCRYPTED_CONTAINER_CODE = 'encrypted-container'"), '常量必须只在这一处定义')
  const containerKind = await readSource('src/security/container-kind.ts')
  assert.ok(containerKind.includes('ENCRYPTED_CONTAINER_CODE'), '形态判定模块必须 re-export 同一常量（禁止第二份字面量）')
  const client = await readSource('src/client/import/use-import-wizard-controller.ts')
  assert.ok(client.includes('ENCRYPTED_CONTAINER_CODE'), '客户端必须按同一常量分派（禁止硬编码字符串）')
})

test('P2-T3-1: /execute 遇到未解锁容器 → 400 + encrypted-container，且零写入', async () => {
  const h = await makeHarness()
  try {
    const route = executeRoute(h)
    const before = { exports: await listing(h.exportsDir), home: await listing(h.homeDir), tmp: await listing(h.tmpDir) }
    const res = await call(route, {
      zipPath: h.containerPath,
      plan: { items: [], globalStrategy: 'replace', pathMappings: [], missingSecrets: [], needsRestart: false },
      opts: {},
    })
    assert.equal(res.status, 400, '必须是可判别的 400，而不是 ZIP 解析器的 400 文本')
    const json = JSON.parse(res.body) as { error?: string; code?: string }
    assert.equal(json.code, ENCRYPTED_CONTAINER_CODE, '必须带机器码（客户端据此进解锁阶段）')
    assert.equal(json.error, MSSG, '文案必须来自字典键，而不是「缺少中央目录结束记录」')
    const after = { exports: await listing(h.exportsDir), home: await listing(h.homeDir), tmp: await listing(h.tmpDir) }
    assert.deepEqual(after, before, '闸门必须在任何写入之前返回（目录清单/mtime 逐字节不变）')
  } finally {
    await h.cleanup()
  }
})

test('P2-T3-1: /analyze 与 /plan 的闸门在源码窗口里必须与 /execute 同源（三处缺一即红）', async () => {
  const source = await readSource('src/index.ts')
  for (const [label, marker] of [['/analyze', 'path: API.analyze'], ['/plan', 'path: API.plan']] as const) {
    const start = source.indexOf(marker)
    assert.ok(start > 0, '未找到 ' + label + ' 路由声明')
    const window = source.slice(start, start + 2600)
    const gate = "(await readContainerKind(zipPath)) === 'encrypted'"
    assert.ok(window.includes(gate), label + ' 必须先判容器形态（否则解析器会误报备份损坏）')
    assert.ok(window.includes('ENCRYPTED_CONTAINER_CODE'), label + ' 必须回传同一机器码')
    assert.ok(window.includes('writeJson(res, 400'), label + ' 必须是 400')
    assert.ok(window.includes('import.encryptedContainerNeedsUnlock'), label + ' 必须用解锁引导文案')
    // 闸门必须在真正解析 ZIP 之前（防「先解析再判断」的顺序回归）
    const gateAt = window.indexOf(gate)
    const parseAt = Math.max(window.indexOf('analyzeImport('), window.indexOf('createImportPlan('))
    if (parseAt > 0) assert.ok(gateAt < parseAt, label + ' 的闸门必须在 ZIP 解析/计划生成之前')
  }
})

async function readSource(rel: string): Promise<string> {
  // EOL 折 LF 以免 CRLF 假红（本仓 .gitattributes 钉 LF，但工作区可能被改写）
  const text = await fs.readFile(path.join(ROOT, rel), 'utf8')
  return text.replace(/\r\n/g, '\n')
}
