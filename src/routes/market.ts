/**
 * 路由组：配置市场（内置公开仓库：状态 / 刷新 / 浏览 / 下载）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { BUILTIN_MARKET_URL } from '../market/builtin.ts'
import { parseMarketIndex, parseMarketItemManifest } from '../market/index-parser.ts'
import { validateMarketItem } from '../market/security.ts'
import type { MarketDownloadResult, MarketIndex, MarketItemDetail, MarketListItem } from '../market/types.ts'
import { validateMarketRepoUrl } from '../market/url.ts'
import { marketItemWarnings, toMarketListItem } from '../market/view.ts'
import type { SectionId } from '../schema/types.ts'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function marketRoutes(env: RoutesEnv): WebRoute[] {
  const {
    buildMarketSummary,
    itemCached,
    makeImporter,
    makeMarketReader,
    marketBootAutoRefreshed,
    marketCacheIndex,
    marketCacheItemDir,
    marketStarCache,
    marketWorkDir,
    msg,
    pruneStagedMarketZips,
    readCachedIndexObj,
    tmpDir,
    writeItemCache,
  } = env
  return [
    // ---------------------------------------------------- market/status
    // 内置单市场（只读、不可编辑）：恒返回内置仓库摘要。无 add/remove —— 市场绑定内置仓库。
    endpoint({ path: '/api/dsh-config-manager/market/status', methods: ['GET'] }, async (req, res) => {
      try {
        const summary = await buildMarketSummary({ url: BUILTIN_MARKET_URL, addedAt: '' })
        writeJson(res, 200, {
          ok: true,
          configured: true,
          markets: [summary],
          // 首次打开市场页自动更新一次的判据：本次 dsh 启动后是否已刷新过（进程内存，重启重置）
          bootAutoRefreshed: marketBootAutoRefreshed.value,
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ---------------------------------------------------- market/refresh
    endpoint({ path: '/api/dsh-config-manager/market/refresh', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      // 内置单市场：url 可省略，缺省用 BUILTIN_MARKET_URL（保留接受 url 以兼容旧调用方与 env 覆盖）
      const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
        ? body['url']
        : BUILTIN_MARKET_URL
      try {
        const reader = makeMarketReader()
        const { text, fetchedAt } = await reader.readIndex({ url, workDir: marketWorkDir(url) })
        const parsed = parseMarketIndex(text)
        if (!parsed.ok) {
          writeJson(res, 400, { error: `market index invalid: ${parsed.errors.join('; ')}` })
          return
        }
        // 写缓存 index（供离线重复浏览）。内容始终视为不可信，读取时再结构校验。
        await fs.mkdir(dirname(marketCacheIndex(url)), { recursive: true })
        await fs.writeFile(marketCacheIndex(url), text, 'utf8')
        // 刷新成功 → 置位「本次启动已刷新」标记（手动「拉取最新」同样生效；失败不置位，下次打开可重试）
        marketBootAutoRefreshed.value = true
        const summary = await buildMarketSummary({ url, addedAt: new Date().toISOString() })
        writeJson(res, 200, { ok: true, items: parsed.index!.items, market: { ...summary, lastFetchedAt: fetchedAt } })
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ---------------------------------------------------- market/browse
    endpoint({ path: '/api/dsh-config-manager/market/browse', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      // 内置单市场：url 缺省用 BUILTIN_MARKET_URL（兼容旧调用方与 env 覆盖）
      const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
        ? body['url']
        : BUILTIN_MARKET_URL
      try {
        // 缓存 index 缺失 → 先拉取（refresh 语义）；已存在则直接用缓存。
        let index: MarketIndex | null = await readCachedIndexObj(url)
        if (index === null) {
          const reader = makeMarketReader()
          const { text } = await reader.readIndex({ url, workDir: marketWorkDir(url) })
          const parsed = parseMarketIndex(text)
          if (!parsed.ok) {
            writeJson(res, 400, { error: `market index invalid: ${parsed.errors.join('; ')}` })
            return
          }
          index = parsed.index!
          await fs.mkdir(dirname(marketCacheIndex(url)), { recursive: true })
          await fs.writeFile(marketCacheIndex(url), text, 'utf8')
        }
        const items: MarketListItem[] = []
        for (const item of index.items) {
          const cacheState = await itemCached(url, item.id) ? 'cached' : 'none'
          // P2-⑭：已缓存条目从 L2 manifest 合并 sections（供列表分区筛选）；未缓存条目
          // sections 缺省（= 未知，筛选时排除并提示需先「查看详情」下载）。
          let sections: SectionId[] | undefined
          if (cacheState === 'cached') {
            try {
              const manifestRaw = await fs.readFile(join(marketCacheItemDir(url), item.id, 'manifest.json'), 'utf8')
              const parsed = parseMarketItemManifest(manifestRaw)
              if (parsed.ok && parsed.manifest !== null) sections = parsed.manifest.sections
            } catch {
              // 缓存 manifest 读取失败：sections 保持 undefined（筛选降级为未知）
            }
          }
          items.push({ ...toMarketListItem(item, cacheState), ...(sections !== undefined ? { sections } : {}) })
        }
        // star 数据（仓库级）：收集条目来源仓库 URL（repo ?? 市场 URL）去重后批量查缓存，
        // 并入浏览列表。查询失败/非 GitHub 仓库 → 该项 stars 缺省（undefined），UI 显示「—」。
        if (items.length > 0) {
          const repoUrls = [...new Set(items.map((it) => it.repo ?? url))]
          const starsByUrl = await marketStarCache.getMany(repoUrls)
          for (const it of items) {
            const stars = starsByUrl.get(it.repo ?? url)
            if (stars !== undefined) it.stars = stars
          }
        }
        writeJson(res, 200, { ok: true, items })
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ---------------------------------------------------- market/download
    // 拉取 manifest + config.zip → 安全校验（§6）→ valid 则落受控临时区 + dry-run 分析/计划。
    // 真正落盘由用户确认后走既有 POST /execute（zipPath + plan）。零写入到确认。
    endpoint({ path: '/api/dsh-config-manager/market/download', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      // 内置单市场：url 缺省用 BUILTIN_MARKET_URL；itemId 必填；repo 可选（条目来源仓库，发布者自托管）
      const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
        ? body['url']
        : BUILTIN_MARKET_URL
      const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
      if (itemId === '') {
        writeJson(res, 400, { error: 'itemId required' })
        return
      }
      // repo 可选：条目来源仓库。非法（含 userinfo / 空白 / 非 http(s) 形态）→ 400，永不注入凭据。
      const repo = (typeof body?.['repo'] === 'string' && body['repo'] !== '') ? body['repo'] : undefined
      if (repo !== undefined) {
        const repoErr = validateMarketRepoUrl(repo)
        if (repoErr !== null) {
          writeJson(res, 400, { error: `repo invalid: ${repoErr}` })
          return
        }
      }
      try {
        const reader = makeMarketReader()
        // 条目仓库与市场仓库分离时，workDir 按来源仓库 url-hash 分目录（天然隔离）
        const sourceRepo = repo ?? url
        const workDir = marketWorkDir(sourceRepo)
        const { text: manifestRaw } = await reader.readItemManifest({ url, workDir, itemId, repo })
        const { data: zipBytes } = await reader.readItemZip({ url, workDir, itemId, repo })

        const validation = validateMarketItem(itemId, manifestRaw, zipBytes)
        const manifest = validation.manifest
        // 供应链警示恒生成（marketItemWarnings 模型层）；download 时间；来源 URL 带条目仓库
        const downloadedAt = new Date().toISOString()
        const warnings = manifest !== null
          ? marketItemWarnings(manifest, sourceRepo, downloadedAt, msg)
          : [msg('route.marketItemSupplyChainWarning', { id: itemId })]

        const base: MarketItemDetail = {
          id: itemId,
          name: manifest?.name ?? itemId,
          version: manifest?.version ?? '',
          author: manifest?.author,
          description: manifest?.description,
          updatedAt: manifest?.updatedAt,
          sections: validation.sections,
          repo: sourceRepo,
          provenance: manifest?.provenance,
          downloadedAt,
          status: validation.status,
          errors: validation.errors,
          warnings,
        }

        if (validation.status === 'invalid') {
          // 校验失败 → 返回 MarketItemDetail（status:'invalid' + errors/warnings），不进入导入预览。
          writeJson(res, 200, base)
          return
        }

        // valid：落受控临时区（tmpDir 已是 /execute 的 controlled root）
        // 先懒 GC 清理过期市场暂存 zip，避免未确认导入的暂存文件堆积
        await pruneStagedMarketZips()
        const zipPath = join(tmpDir, `market-${itemId}-${randomBytes(6).toString('hex')}.zip`)
        await fs.writeFile(zipPath, zipBytes)
        // 写条目缓存（manifest + config.zip）供离线重复查看
        await writeItemCache(url, itemId, manifestRaw, zipBytes)

        // dry-run 分析 + 计划（零写入）：复用现有 importer
        const importer = makeImporter()
        const analysis = await importer.analyzeImport(zipPath)
        const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })

        const download: MarketDownloadResult = { ...base, zipPath, analysis, plan }
        writeJson(res, 200, download)
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
