/**
 * 救急台路由表 ↔ 硬编码快照的**双向** parity 守卫，外加「页面导航表 ↔ 路由集合」一致性。
 *
 * 为什么必须有：404 / 405 / 错误页里的「可用页面」清单曾经三处各写一份、且与真实路由不符
 * （把 JSON 自述的 `/healthz` 当页面、又漏掉 `/restore` 与 `/export`）。单靠人眼维持不现实 ——
 * 新增或删除一条路由时，下面这张快照、page.ts 的导航表与派生提示必须一起动，否则这里直接红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { routeSpecOf } from '../../routes/kit.ts'
import { CONSOLE_PAGE_NAV, consolePagesHint } from './page.ts'
import { buildConsoleRoutes, type ConsoleContext } from './routes.ts'
import type { RescuePaths } from '../actions.ts'

const PATHS: RescuePaths = {
  homeDir: 'H', dataDir: 'D', snapshotsDir: 'S', exportsDir: 'E', locksDir: 'L',
  controlRoots: ['R'], profile: 'web',
}

function makeContext(): ConsoleContext {
  return {
    paths: PATHS,
    version: '0.0.0-test',
    startedAt: '2026-01-01T00:00:00.000Z',
    actionTokens: new Set<string>(),
    dangerPhrase: 'ABC123',
  }
}

/** 全部 `<METHOD> <path>` 组合（排序后的稳定形态；一条路由的多方法各算一项）。 */
function routePairs(): string[] {
  return buildConsoleRoutes(makeContext())
    .flatMap((route) => {
      const spec = routeSpecOf(route)
      assert.ok(spec !== undefined, '每条救急台路由都必须经 kit 的 endpoint() 声明')
      return spec.methods.map((method) => method + ' ' + spec.path)
    })
    .sort()
}

/**
 * 硬编码快照：**多一条 / 少一条都红**。改动路由时同步改这里（并在 page.ts 的 CONSOLE_PAGE_NAV
 * 里决定新页面是否进导航 —— 第二条测试会强制你做这个决定）。
 */
const ROUTE_SNAPSHOT: readonly string[] = [
  'GET /',
  'GET /disk',
  'GET /export',
  'GET /favicon.ico',
  'GET /healthz',
  'GET /lock',
  'GET /profiles',
  'GET /reinstall',
  'GET /restore',
  'GET /sessions',
  'GET /unlock',
  'GET /verify',
  'POST /disk/cleanup',
  'POST /export/run',
  'POST /lock/recover',
  'POST /profiles/launch',
  'POST /profiles/stop',
  'POST /reinstall/plan',
  'POST /reinstall/run',
  'POST /restore/run',
  'POST /sessions/inline-repair',
  'POST /sessions/repair',
  'POST /unlock/run',
]

test('救急台路由表与硬编码快照双向一致（多一条 / 少一条都红）', () => {
  assert.deepEqual(routePairs(), [...ROUTE_SNAPSHOT].sort())
})

test('page.ts 的导航表与路由集合一致（双向）', () => {
  const getPaths = new Set(
    routePairs().filter((pair) => pair.startsWith('GET ')).map((pair) => pair.slice('GET '.length)),
  )
  // 正向：导航项必须有对应的 GET 路由（否则点进去 404）。
  for (const item of CONSOLE_PAGE_NAV) {
    assert.ok(getPaths.has(item.href), '导航项没有对应的 GET 路由: ' + item.href + '（' + item.label + '）')
  }
  // 反向：每个 GET 路由要么进了导航表，要么在这张显式名单里说明「它不是导航页」。
  //   /healthz      = JSON 自述（不是页面）
  //   /favicon.ico  = 空 204（不是页面）
  //   /verify /lock = 真页面，但入口在首页动作卡里，刻意不进头部导航
  const nonNavPages = new Set(['/healthz', '/favicon.ico', '/verify', '/lock'])
  for (const path of getPaths) {
    if (nonNavPages.has(path)) continue
    assert.ok(
      CONSOLE_PAGE_NAV.some((item) => item.href === path),
      'GET 路由不在导航表里也不在显式排除名单里: ' + path
      + '（新增页面必须同时更新 page.ts 的 CONSOLE_PAGE_NAV，或在此说明它不是导航页）',
    )
  }
})

test('「可用页面」提示由导航表派生（/healthz 不得被当成页面）', () => {
  const hint = consolePagesHint()
  for (const item of CONSOLE_PAGE_NAV) {
    assert.ok(hint.includes(item.href + '（' + item.label + '）'), '提示缺页面: ' + item.href)
  }
  assert.ok(!hint.includes('/healthz'), '/healthz 是 JSON 自述，不是页面，不得出现在「可用页面」里')
  assert.ok(!hint.includes('/favicon.ico'), 'favicon 不是页面')
})

test('404 / 405 / 错误页三处都引用同一份派生（不得再各写一份清单）', () => {
  for (const file of ['server.ts', 'routes.ts']) {
    const src = readFileSync(new URL('./' + file, import.meta.url), 'utf8').split('\r\n').join('\n')
    assert.doesNotMatch(src, /可用页面：\//, file + ' 不得再硬编码「可用页面」清单')
    assert.match(src, /consolePagesHint\(\)/, file + ' 必须复用 page.ts 的 consolePagesHint()')
  }
})
