/**
 * 路由组：迁移历史审计（只读查询 + 导出）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import {
  DEFAULT_MIGRATION_RETENTION,
  HISTORY_RETENTION_MAX,
  HISTORY_RETENTION_MIN,
  isValidHistoryRetention,
  parseHistoryQuery,
  queryHistory,
  renderExport,
  resolveHistoryRetention,
  summarizeHistory,
} from '../core/migration-history.ts'
import { readUiPrefs, updateUiPrefs } from '../sync/ui-prefs.ts'

/** 列表接口的 limit 上限：防「?limit=99999999」把只读端点的读放大成拒绝服务面。 */
const HISTORY_LIST_LIMIT_MAX = 5000

/**
 * 解析列表请求的 limit：缺省 / 非法 / 负数 = 0（= 全量，老口径不变）；超上限按上限截断。
 * 只接受十进制整数字面量（parseInt 会把 '12abc' 读成 12，故先用正则判形）。
 */
function parseListLimit(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return 0
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, HISTORY_LIST_LIMIT_MAX)
}

export function historyRoutes(env: RoutesEnv): WebRoute[] {
  const {
    history,
    host,
    msg,
    syncDir,
    withMutationGate,
  } = env
  return [
    // ------------------------------------------------------------ history
    // Phase 6：迁移历史审计（统一历史引擎）。只读 GET：列表（过滤）+ 导出。
    // loopback fence（guard）与全仓一致——仅同源 + loopback 可访问。
    // ?limit=N：只读最近 N 条（文件名尾部窗口）。首页只要最近几十条活动，全量读 + 全量回传
    // 会把首屏骨架拖到秒级（真机 2360 条：纯 IO/解析 650 ms，冷启动含回传 9.7 s）。
    // 响应始终带 total（目录合法文件总数）与 scanned（本次实际读取条数），避免 UI 把窗口当全量。
    endpoint({ path: '/api/dsh-config-manager/history', methods: ['GET'] }, async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const q = parseHistoryQuery(Object.fromEntries(url.searchParams))
        const limit = parseListLimit(url.searchParams.get('limit'))
        const { entries, corrupted, total } = await history.read({ limit })
        const filtered = queryHistory(entries, q)
        const stats = summarizeHistory(filtered)
        writeJson(res, 200, { ok: true, entries: filtered, stats, corrupted, total: total ?? entries.length, scanned: entries.length, limit })
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
    // ------------------------------------------------------ history/retention
    // 迁移历史自动清理（issue：历史目录只增不减，真机已 2360 条 / 0.67 MB）。
    // 策略存 ui-prefs.json 的 historyRetentionMaxEntries（0 = 不限制，缺省 1000）；
    // 宿主在每次写入历史后按该值节流清理最旧条目（调度与取舍 → src/core/history-prune.ts）。
    // GET → 当前策略 + 目录现状；POST → 改策略并立即清理一次（同一道写入门）。
    // 一条 exact 路由 + 方法内部分发：webserver 对重复 (kind, path) 直接抛错。
    endpoint({ path: '/api/dsh-config-manager/history/retention', methods: ['GET', 'POST'] }, async (req, res) => {
      if (req.method === 'GET') {
        try {
          const [prefs, total] = await Promise.all([readUiPrefs(syncDir), history.count()])
          writeJson(res, 200, {
            ok: true,
            maxEntries: resolveHistoryRetention(prefs.historyRetentionMaxEntries),
            total,
            defaultMaxEntries: DEFAULT_MIGRATION_RETENTION,
            allowedMin: HISTORY_RETENTION_MIN,
            allowedMax: HISTORY_RETENTION_MAX,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // 写分支：删历史属破坏性操作，与其它写路径同一道门（不写审计条目 → 见 history-prune 头注释）。
      await withMutationGate('history-retention', async (gatedReq, gatedRes) => {
        const body = await requireJsonObject(gatedReq)
        const next = body['maxEntries']
        if (!isValidHistoryRetention(next)) {
          writeJson(gatedRes, 400, {
            ok: false,
            code: 'invalid-retention',
            error: msg('route.historyRetentionInvalid', { min: HISTORY_RETENTION_MIN, max: HISTORY_RETENTION_MAX }),
          })
          return
        }
        // 先落策略再清理：清理失败也要让新策略生效（下一次写入会重试），否则用户改完不生效。
        await updateUiPrefs(syncDir, { historyRetentionMaxEntries: next })
        const removed = next > 0 ? await history.retention(next) : []
        const total = await history.count()
        if (removed.length > 0) {
          host.log.info('迁移历史自动清理', { maxEntries: next, removed: removed.length, total })
        }
        writeJson(gatedRes, 200, { ok: true, maxEntries: next, removed: removed.length, total })
      }, { journaled: false })(req, res)
    }),
  ]
}
