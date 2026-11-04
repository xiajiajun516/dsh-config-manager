/**
 * 迁移历史导出（GET /api/dsh-config-manager/history/export）路由回归：
 *  - 缺省 JSON 导出 = 全量（**不受 ?limit= 窗口影响**）+ { ok, generatedAt, text }，text 内 { title, stats, entries }；
 *  - ?kind= / ?result= 等过滤参数复用 queryHistory 口径，过滤后的 entries 与 stats 同源；
 *  - ?format=markdown = 附件下载（Content-Type + Content-Disposition），正文是标题 + total + 五行表格；
 *  - 空历史两种格式都不产出空表格；导出文本一律过 redact（敏感值不得明文出现）。
 *
 * 为什么必须钉：这条路由是用户把审计记录带走（贴 issue / 存档 / 对账）的唯一出口。
 * 一是「导出被列表窗口截断」会让审计缺条；二是导出文本绕过脱敏 = 秘密原文离开本机。
 *
 * 同一 path 的其它 GET（/history、/history/retention）由 history-retention-route.test.ts 覆盖，此处不重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { historyRoutes } from '../../src/routes/history.ts'
import { routeSpecOf } from '../../src/routes/kit.ts'
import type { WebRoute } from '../../src/routes/kit.ts'
import { MigrationStore } from '../../src/core/migration-history.ts'
import type { MigrationKind, MigrationResult } from '../../src/core/migration-history.ts'

const EXPORT = '/api/dsh-config-manager/history/export'

interface Harness {
  route: WebRoute
  history: MigrationStore
  /** 界面语言（导出标题/表头随语言切换；断言只比「两种语言不同」，不钉具体文案）。 */
  setLanguage: (language: 'zh' | 'en') => void
  cleanup: () => void
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-history-export-'))
  const history = new MigrationStore({ dir: path.join(dir, 'migration-history') })
  const host = { language: 'zh' as 'zh' | 'en', log: { info: () => undefined, warn: () => undefined } }
  const env = {
    history,
    host,
    syncDir: path.join(dir, 'sync'),
    msg: (key: string) => key,
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
  const route = historyRoutes(env).find((r) => r.path === EXPORT && routeSpecOf(r)?.methods.includes('GET') === true)
  assert.ok(route !== undefined, '缺少 GET ' + EXPORT)
  return {
    route,
    history,
    setLanguage: (language) => { host.language = language },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

interface FakeResponse {
  status: number
  body: string
  headers: Record<string, string>
}

async function call(route: WebRoute, url: string): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '', headers: {} }
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  } as unknown as IncomingMessage
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers ?? {}
      this.headersSent = true
      return this
    },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return state
}

async function seed(h: Harness, entry: { at: string; kind: MigrationKind; result: MigrationResult; sections?: string[]; summary?: string }): Promise<void> {
  const result = await h.history.append({
    at: entry.at,
    kind: entry.kind,
    result: entry.result,
    sections: entry.sections ?? ['settings'],
    source: 'cli',
    summary: entry.summary ?? `${entry.kind}-${entry.result}`,
  })
  assert.equal(result.ok, true, '种子写入失败: ' + String(result.error))
}

async function seedThree(h: Harness): Promise<void> {
  await seed(h, { at: '2026-08-30T12:00:00.000Z', kind: 'import', result: 'success' })
  await seed(h, { at: '2026-08-30T12:01:00.000Z', kind: 'import', result: 'failed', sections: ['plugins'] })
  await seed(h, { at: '2026-08-30T12:02:00.000Z', kind: 'sync-apply', result: 'success', sections: ['sessions'] })
}

/** 解析 JSON 导出正文（{ ok, generatedAt, text }）并取出 text 内的 { title, stats, entries }。 */
function parseJsonExport(response: FakeResponse): {
  generatedAt: string
  text: string
  parsed: { title: string; stats: { total: number; byKind: Record<string, number>; byResult: Record<string, number> }; entries: { kind: string; result: string; at: string }[] }
} {
  assert.equal(response.status, 200, 'body=' + response.body)
  const outer = JSON.parse(response.body) as { ok: boolean; generatedAt: string; text: string }
  assert.equal(outer.ok, true)
  assert.equal(typeof outer.generatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(outer.generatedAt)), 'generatedAt 必须是可解析时刻: ' + outer.generatedAt)
  assert.equal(typeof outer.text, 'string')
  return { generatedAt: outer.generatedAt, text: outer.text, parsed: JSON.parse(outer.text) }
}

test('X-01 JSON 导出：全量 entries + 统计，与落盘条目一一对应', async () => {
  const h = harness()
  try {
    await seedThree(h)
    const { parsed, text } = parseJsonExport(await call(h.route, EXPORT))
    assert.equal(parsed.entries.length, 3)
    assert.deepEqual(parsed.entries.map((e) => e.kind), ['import', 'import', 'sync-apply'])
    assert.deepEqual(parsed.entries.map((e) => e.result), ['success', 'failed', 'success'])
    assert.equal(parsed.stats.total, 3)
    assert.deepEqual(parsed.stats.byKind, { import: 2, 'sync-apply': 1 })
    assert.deepEqual(parsed.stats.byResult, { success: 2, failed: 1 })
    assert.equal(typeof parsed.title, 'string')
    assert.ok(parsed.title.length > 0)
    assert.ok(text.split('\n').length > 3, 'JSON 导出应带缩进（可读文本，不是单行）')
  } finally {
    h.cleanup()
  }
})

test('X-02 导出是全量：?limit= 不影响条数（与列表窗口分离）', async () => {
  const h = harness()
  try {
    await seedThree(h)
    const limited = parseJsonExport(await call(h.route, EXPORT + '?limit=1'))
    assert.equal(limited.parsed.entries.length, 3, '导出不得被列表 limit 截断')
    assert.equal(limited.parsed.stats.total, 3)
  } finally {
    h.cleanup()
  }
})

test('X-03 过滤参数：kind / result 让 entries 与 stats 同步收窄', async () => {
  const h = harness()
  try {
    await seedThree(h)
    const onlyImport = parseJsonExport(await call(h.route, EXPORT + '?kind=import'))
    assert.equal(onlyImport.parsed.entries.length, 2)
    assert.deepEqual(onlyImport.parsed.stats.byKind, { import: 2 })
    assert.deepEqual(onlyImport.parsed.entries.map((e) => e.result), ['success', 'failed'], '过滤后就地保序，不重排')

    const onlyFailed = parseJsonExport(await call(h.route, EXPORT + '?result=failed'))
    assert.deepEqual(onlyFailed.parsed.entries.map((e) => e.result), ['failed'])
    assert.deepEqual(onlyFailed.parsed.stats.byResult, { failed: 1 })

    const bySections = parseJsonExport(await call(h.route, EXPORT + '?sections=sessions'))
    assert.deepEqual(bySections.parsed.entries.map((e) => e.kind), ['sync-apply'])

    // 非法过滤值 = 不放行任何条目之外的东西：非法的 kind 被丢弃（回退成不过滤），不能把整个导出清空
    const bogus = parseJsonExport(await call(h.route, EXPORT + '?kind=not-a-kind'))
    assert.equal(bogus.parsed.entries.length, 3)
  } finally {
    h.cleanup()
  }
})

test('X-04 markdown 导出：附件头 + 标题/total/表格行，每条一行', async () => {
  const h = harness()
  try {
    await seedThree(h)
    const response = await call(h.route, EXPORT + '?format=markdown')
    assert.equal(response.status, 200)
    assert.equal(response.headers['Content-Type'], 'text/markdown; charset=utf-8')
    const disposition = response.headers['Content-Disposition'] ?? ''
    assert.ok(disposition.startsWith('attachment;'), 'markdown 是下载而不是内联: ' + disposition)
    assert.ok(disposition.includes('migration-history.md'), '下载文件名必须可预期: ' + disposition)

    const lines = response.body.split('\n')
    assert.equal(lines[0]?.startsWith('# '), true, '首行必须是标题: ' + lines[0])
    assert.ok(response.body.includes('> ') && response.body.includes('3'), '必须声明总条数 3')
    // 表格：表头一行 + 分隔行 + 每条一行；断言「三条 seed 的时刻各出现一次」（不钉本地化文案）
    for (const at of ['2026-08-30T12:00:00.000Z', '2026-08-30T12:01:00.000Z', '2026-08-30T12:02:00.000Z']) {
      const hits = lines.filter((line) => line.startsWith('| ') && line.includes(at))
      assert.equal(hits.length, 1, `表格里必须恰好出现一行 ${at}`)
      assert.equal((hits[0] ?? '').split('|').length - 2, 5, '每行必须是 5 个单元格: ' + hits[0])
    }
    const dataRows = lines.filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    assert.equal(dataRows.length, 4, '表头 + 3 条数据')
    assert.ok(lines.some((line) => line.startsWith('| ---')), '必须是 markdown 表格分隔行')
  } finally {
    h.cleanup()
  }
})

test('X-05 空历史：markdown 不产出空表格，JSON entries 为空且 stats 归零', async () => {
  const h = harness()
  try {
    const markdown = await call(h.route, EXPORT + '?format=markdown')
    assert.equal(markdown.status, 200)
    assert.ok(!markdown.body.includes('|'), '空历史不得出现表格骨架: ' + markdown.body)
    assert.ok(markdown.body.startsWith('# '))
    assert.ok(markdown.body.trim().split('\n').length >= 2, '空历史也要有一句「没有记录」提示')

    const json = parseJsonExport(await call(h.route, EXPORT))
    assert.deepEqual(json.parsed.entries, [])
    assert.equal(json.parsed.stats.total, 0)
    assert.deepEqual(json.parsed.stats.byKind, {})
  } finally {
    h.cleanup()
  }
})

test('X-06 语言切换只改文案，不丢条目；导出文本过 redact（敏感值不离开本机）', async () => {
  const h = harness()
  try {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    await seed(h, { at: '2026-08-30T13:00:00.000Z', kind: 'import', result: 'failed', summary: 'push failed with token ' + token })
    const zh = parseJsonExport(await call(h.route, EXPORT))
    h.setLanguage('en')
    const en = parseJsonExport(await call(h.route, EXPORT))
    assert.equal(zh.parsed.entries.length, 1)
    assert.equal(en.parsed.entries.length, 1)
    assert.notEqual(zh.parsed.title, en.parsed.title, '标题必须跟随界面语言')
    assert.ok(!zh.text.includes(token), 'JSON 导出不得含明文 token')
    assert.ok(!en.text.includes(token), 'JSON 导出不得含明文 token（en）')

    const markdown = await call(h.route, EXPORT + '?format=markdown')
    assert.equal(markdown.status, 200)
    assert.ok(!markdown.body.includes(token), 'markdown 导出不得含明文 token')
    assert.ok(markdown.body.includes('2026-08-30T13:00:00.000Z'), '脱敏不得吃掉时间列')
  } finally {
    h.cleanup()
  }
})

test('X-07 读历史失败：500 + 错误文本，绝不当成「空历史」成功返回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-history-export-fail-'))
  try {
    const env = {
      history: { read: async () => { throw new Error('history dir unreadable') } },
      host: { language: 'zh' },
      syncDir: path.join(dir, 'sync'),
      msg: (key: string) => key,
      withMutationGate: (_op: string, handler: unknown) => handler,
    } as never
    const route = historyRoutes(env).find((r) => r.path === EXPORT && routeSpecOf(r)?.methods.includes('GET') === true)
    assert.ok(route !== undefined)
    for (const url of [EXPORT, EXPORT + '?format=markdown']) {
      const response = await call(route, url)
      assert.equal(response.status, 500, '读取失败必须报错: ' + url)
      const body = JSON.parse(response.body) as { error?: string }
      assert.equal(typeof body.error, 'string')
      assert.ok(body.error !== '')
      assert.ok(!response.body.includes('"ok":true'), '不得伪装成成功导出')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
