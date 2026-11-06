#!/usr/bin/env node
/**
 * README 星标历史图生成器
 *
 * 为什么存在：README 里需要一张「累计星标 + 每日新增」的双轴图（深/浅两套），
 * 而且要能随仓库真实数据刷新，而不是贴一张会过期的截图。
 *
 * 数据来源：GitHub REST `GET /repos/{owner}/{repo}/stargazers`
 *   带上 `Accept: application/vnd.github.star+json` 才有 `starred_at`（不带则只有 login，
 *   无法还原时间轴）。匿名调用限速 60 次/小时，一个仓库翻页 3~4 次就够；有 token 走 5000 次/小时。
 *   token 解析顺序：GITHUB_TOKEN → GH_TOKEN → `gh auth token`（本机已登录时直接可用）。
 *
 * 输出：assets/star-history-dark.svg、assets/star-history-light.svg
 *   纯静态 SVG（零外部资源、零脚本），README 用 <picture> 按 prefers-color-scheme 二选一。
 *   图脚日期取「最近一颗星所在的 UTC 日」而不是运行时刻——数据没变时输出逐字节不变，
 *   定时刷新因此不会产生无意义的提交。
 *
 * 用法：node scripts/star-history.mjs [--repo owner/name] [--out assets] [--dry-run]
 * 退出码：0 = 已写入（或无需改动）；1 = 取数/写入失败（已有文件保持原样）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com'
const PER_PAGE = 100
const TIMEOUT_MS = 20000
const THEMES = ['dark', 'light']

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const DRY_RUN = argv.includes('--dry-run')
const OUT_DIR = resolve(ROOT, argOf('--out', 'assets'))

/** package.json 的 repository.url 里取 owner/repo（允许 --repo 覆盖） */
function resolveRepo() {
  const fromArg = argOf('--repo', '')
  if (fromArg) return fromArg
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || ''
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(url)
  if (!m) throw new Error(`package.json 里没有可解析的 GitHub 仓库地址（读到 "${url}"）`)
  return `${m[1]}/${m[2]}`
}

/** 有 token 就用 token；没有 `gh` 也能跑，只是匿名限速更低 */
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || ''
  } catch {
    return ''
  }
}

/** 翻页取全部星标时间；Link 头缺失即视为最后一页 */
async function fetchStargazers(repo, token) {
  const headers = { accept: 'application/vnd.github.star+json', 'user-agent': 'dsh-config-manager-star-history' }
  if (token) headers.authorization = `Bearer ${token}`
  const stamps = []
  for (let page = 1, guard = 0; page && guard < 500; guard += 1) {
    const url = `${API}/repos/${repo}/stargazers?per_page=${PER_PAGE}&page=${page}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 429 ? '（多半是限速：设置 GITHUB_TOKEN 或先 gh auth login）' : ''
      throw new Error(`${res.status} ${res.statusText} ${url}${hint}`)
    }
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const at = row && row.starred_at
      if (typeof at === 'string' && at) stamps.push(at)
    }
    const link = res.headers.get('link') || ''
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)
    page = next ? page + 1 : 0
  }
  if (stamps.length === 0) throw new Error('接口返回 0 颗星，拒绝画空图')
  return stamps.sort()
}

const DAY_MS = 86400000
const dayOf = (iso) => iso.slice(0, 10)
const dayIndex = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
const dayFromIndex = (i) => new Date(i * DAY_MS).toISOString().slice(0, 10)
const md = (day) => `${day.slice(5, 7)}/${day.slice(8, 10)}`

/** 时间戳 → 每日连续序列（缺日补 0）+ 累计值 */
function buildSeries(stamps) {
  const perDay = new Map()
  for (const at of stamps) {
    const day = dayOf(at)
    perDay.set(day, (perDay.get(day) || 0) + 1)
  }
  const first = dayIndex(dayOf(stamps[0]))
  const last = dayIndex(dayOf(stamps[stamps.length - 1]))
  const days = []
  let cumulative = 0
  for (let i = first; i <= last; i += 1) {
    const day = dayFromIndex(i)
    const added = perDay.get(day) || 0
    cumulative += added
    days.push({ day, added, cumulative })
  }
  return { days, total: stamps.length, lastDay: days[days.length - 1].day }
}

/**
 * 左轴刻度：用户口径是「每次都 +100」，不是取整家族（299 颗星会被切成 125 的刻度）。
 * 所以按整百递增，只有星数涨到画不下（>6 格）才升档到 200/500/1000，绝不出现 125 这种刻度。
 */
function totalScale(max) {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]
  for (const step of steps) {
    const top = Math.ceil(Math.max(max, step) / step) * step
    if (top / step <= 6) return { step, top }
  }
  const step = steps[steps.length - 1]
  return { step, top: Math.ceil(max / step) * step }
}

const r2 = (n) => Math.round(n * 100) / 100
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const PALETTE = {
  dark: { bg: '#0d1117', text: '#e6edf3', muted: '#8b949e', grid: '#21262d', base: '#30363d', total: '#f85149', daily: '#58a6ff', star: '#f0b429' },
  light: { bg: '#ffffff', text: '#1f2328', muted: '#59636e', grid: '#e4e8ed', base: '#d1d9e0', total: '#cf222e', daily: '#0969da', star: '#bf8700' },
}

const W = 860
const H = 470
const PAD_L = 64
const PAD_R = 68
const PAD_T = 60
const PAD_B = 56
const PLOT_W = W - PAD_L - PAD_R
const PLOT_H = H - PAD_T - PAD_B
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

function render(series, theme, repo) {
  const p = PALETTE[theme]
  const { days, total, lastDay } = series
  const n = days.length
  const { step: totalStep, top: maxTotal } = totalScale(days[n - 1].cumulative)
  const intervals = Math.round(maxTotal / totalStep)
  // 右侧留出余量：不加余量时单日爆发会把整条虚线拉到顶，图只看得到噪声、看不出趋势。
  // 步长取整到整数格，右轴标签才是整数、且与左轴共用同一条网格线。
  const dailyStep = Math.max(1, Math.ceil((Math.max(...days.map((d) => d.added)) * 1.55) / intervals))
  const maxDaily = dailyStep * intervals
  const xAt = (i) => (n === 1 ? PAD_L : PAD_L + (i / (n - 1)) * PLOT_W)
  const yTotal = (v) => PAD_T + PLOT_H - (v / maxTotal) * PLOT_H
  const yDaily = (v) => PAD_T + PLOT_H - (v / maxDaily) * PLOT_H

  const totalPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${r2(xAt(i))} ${r2(yTotal(d.cumulative))}`).join(' ')
  const areaPath = `M${r2(xAt(0))} ${r2(yTotal(0))} ` + days.map((d, i) => `L${r2(xAt(i))} ${r2(yTotal(d.cumulative))}`).join(' ') + ` L${r2(xAt(n - 1))} ${r2(yTotal(0))} Z`
  const dailyPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${r2(xAt(i))} ${r2(yDaily(d.added))}`).join(' ')

  const ticks = Array.from({ length: intervals + 1 }, (_, k) => k)
  const gridLines = ticks.map((k) => {
    const y = r2(PAD_T + (k / intervals) * PLOT_H)
    const totalLabel = maxTotal - k * totalStep
    const dailyLabel = maxDaily - k * dailyStep
    return [
      `  <line x1="${PAD_L}" y1="${y}" x2="${PAD_L + PLOT_W}" y2="${y}" stroke="${p.grid}" stroke-width="1" />`,
      `  <text x="${PAD_L - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${p.total}" opacity="0.9">${totalLabel}</text>`,
      `  <text x="${PAD_L + PLOT_W + 10}" y="${y + 4}" text-anchor="start" font-size="12" fill="${p.daily}" opacity="0.9">${dailyLabel}</text>`,
    ].join('\n')
  }).join('\n')

  const xTickCount = Math.min(6, n)
  const xTicks = Array.from({ length: xTickCount }, (_, k) => {
    const i = xTickCount === 1 ? 0 : Math.round((k / (xTickCount - 1)) * (n - 1))
    const x = r2(xAt(i))
    return [
      `  <line x1="${x}" y1="${PAD_T + PLOT_H}" x2="${x}" y2="${PAD_T + PLOT_H + 5}" stroke="${p.base}" stroke-width="1" />`,
      `  <text x="${x}" y="${PAD_T + PLOT_H + 22}" text-anchor="middle" font-size="12" fill="${p.muted}">${md(days[i].day)}</text>`,
    ].join('\n')
  }).join('\n')

  // 单日新增只标最高那一根：读者一眼看到的应该是「高峰有多高」，而不是自己数格子。
  const peakIndex = days.reduce((best, d, i) => (d.added > days[best].added ? i : best), 0)
  const peak = days[peakIndex].added
  const peakY = yDaily(peak)
  const peakX = xAt(peakIndex)
  const peakLabel = String(peak)
  const boxW = 9 + 6.8 * peakLabel.length
  const boxH = 15
  // 高峰常常正好落在红线穿过的位置，随便往上顶会被红线压住：四个候选位各试一次，
  // 取「与红线相交最少」的那个，再夹回绘图区内。
  const redYAt = (x) => {
    const t = ((x - PAD_L) / (PLOT_W || 1)) * (n - 1)
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(t)))
    const i1 = Math.min(n - 1, i0 + 1)
    return yTotal(days[i0].cumulative + (days[i1].cumulative - days[i0].cumulative) * (t - i0))
  }
  const clashes = (left, top) => {
    let hits = 0
    for (let x = left; x <= left + boxW; x += 2) {
      const y = redYAt(x)
      if (y > top - 3 && y < top + boxH + 3) hits++
    }
    return hits
  }
  const spots = [
    { left: peakX - boxW / 2, top: peakY - 11 - boxH },
    { left: peakX - boxW / 2, top: peakY + 11 },
    { left: peakX - 9 - boxW, top: peakY - boxH / 2 },
    { left: peakX + 9, top: peakY - boxH / 2 },
  ].map((s) => ({
    left: Math.min(Math.max(s.left, PAD_L + 2), PAD_L + PLOT_W - boxW - 2),
    top: Math.min(Math.max(s.top, PAD_T + 2), PAD_T + PLOT_H - boxH - 2),
  }))
  const spot = spots.reduce((best, s) => (clashes(s.left, s.top) < clashes(best.left, best.top) ? s : best), spots[0])
  const boxLeft = spot.left
  const boxTop = spot.top
  const peakText = peak > 0
    ? [
        `  <g>`,
        `    <rect x="${r2(boxLeft)}" y="${r2(boxTop)}" width="${r2(boxW)}" height="${boxH}" rx="3" fill="${p.bg}" opacity="0.92" />`,
        `    <text x="${r2(boxLeft + boxW / 2)}" y="${r2(boxTop + boxH - 3.5)}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${p.daily}">${peakLabel}</text>`,
        `  </g>`,
      ].join('\n')
    : ''

  const aria = `Star history for ${repo}: ${total} stars, series from ${days[0].day} to ${lastDay}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
  <title>${esc(aria)}</title>
  <desc>Cumulative stars (left axis) and new stars per day (right axis), generated from the GitHub stargazers API by scripts/star-history.mjs.</desc>
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.total}" stop-opacity="0.22" />
      <stop offset="100%" stop-color="${p.total}" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${p.bg}" />
  <text x="50%" y="34" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="700" fill="${p.text}"><tspan fill="${p.star}">★</tspan> Star History</text>
  <text x="${PAD_L}" y="52" font-family="${FONT}" font-size="12" font-weight="600" fill="${p.total}">Total Stars</text>
  <text x="${PAD_L + PLOT_W}" y="52" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="600" fill="${p.daily}">Daily New</text>
${gridLines}
  <path d="${areaPath}" fill="url(#fill)" />
  <path d="${dailyPath}" fill="none" stroke="${p.daily}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linejoin="round" opacity="0.85" />
${peakText}
  <path d="${totalPath}" fill="none" stroke="${p.total}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
  <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}" stroke="${p.total}" stroke-width="1.5" opacity="0.8" />
  <line x1="${PAD_L + PLOT_W}" y1="${PAD_T}" x2="${PAD_L + PLOT_W}" y2="${PAD_T + PLOT_H}" stroke="${p.daily}" stroke-width="1.5" opacity="0.8" />
  <line x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${PAD_L + PLOT_W}" y2="${PAD_T + PLOT_H}" stroke="${p.base}" stroke-width="1" />
${xTicks}
  <text x="${PAD_L + PLOT_W}" y="${H - 14}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${p.muted}">${total} stars · ${lastDay}</text>
</svg>
`
}

async function main() {
  const repo = resolveRepo()
  const token = resolveToken()
  const stamps = await fetchStargazers(repo, token)
  const series = buildSeries(stamps)
  mkdirSync(OUT_DIR, { recursive: true })
  const written = []
  for (const theme of THEMES) {
    const file = join(OUT_DIR, `star-history-${theme}.svg`)
    const svg = render(series, theme, repo)
    const changed = !existsSync(file) || readFileSync(file, 'utf8') !== svg
    if (!DRY_RUN) writeFileSync(file, svg)
    written.push({ file, changed })
  }
  const span = `${series.days[0].day} → ${series.lastDay}`
  console.log(`星标图：${repo} 共 ${series.total} 颗星（${span}，${series.days.length} 天）${token ? '' : '（匿名取数）'}`)
  for (const w of written) console.log(`  ${w.changed ? (DRY_RUN ? '会更新' : '已更新') : '无变化'}: ${w.file}`)
}

main().catch((err) => {
  console.error(`生成星标图失败：${err && err.message ? err.message : err}`)
  console.error('已有 SVG 未被修改。')
  process.exitCode = 1
})
