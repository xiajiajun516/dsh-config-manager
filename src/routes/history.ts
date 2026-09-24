/**
 * 路由组：迁移历史审计（只读查询 + 导出）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { parseHistoryQuery, queryHistory, renderExport, summarizeHistory } from '../core/migration-history.ts'

export function historyRoutes(env: RoutesEnv): WebRoute[] {
  const {
    history,
    host,
  } = env
  return [
    // ------------------------------------------------------------ history
    // Phase 6：迁移历史审计（统一历史引擎）。只读 GET：列表（过滤）+ 导出。
    // loopback fence（guard）与全仓一致——仅同源 + loopback 可访问。
    endpoint({ path: '/api/dsh-config-manager/history', methods: ['GET'] }, async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const q = parseHistoryQuery(Object.fromEntries(url.searchParams))
        const { entries, corrupted } = await history.read()
        const filtered = queryHistory(entries, q)
        const stats = summarizeHistory(filtered)
        writeJson(res, 200, { ok: true, entries: filtered, stats, corrupted })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    endpoint({ path: '/api/dsh-config-manager/history/export', methods: ['GET'] }, async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const format = url.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
        const q = parseHistoryQuery(Object.fromEntries(url.searchParams))
        const { entries } = await history.read()
        const filtered = queryHistory(entries, q)
        const text = renderExport(filtered, format, host.language)
        if (format === 'markdown') {
          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': 'attachment; filename="migration-history.md"',
          })
          res.end(text)
        } else {
          writeJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), text })
        }
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
