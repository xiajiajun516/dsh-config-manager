/**
 * 离线救急台页面 —— **服务端直出 HTML**（阶段 1，只读）。
 *
 * 为什么不用客户端框架：救急台的场景是「DSH 都起不来了」，页面依赖越少越好 —— 因此这里直出
 * HTML：**零脚本、零外部资源、零构建产物**，配合 http.ts 里收紧的 CSP。
 * 样式内联在 <style> 里（独立于插件 UI 的 CSS Modules；该新 pattern 已登记进 DESIGN.md）。
 * 这套样式表**有一份外部出处**（亮色 IBM Carbon / 暗色 Raycast 阶梯）与逐条对照表：
 * docs/design/2026-10-04-cli-rescue-console-carbon.md —— 改 STYLE 前先读它，改完跑 web.test.ts 的 R3-02。
 *
 * 呈现纪律：每个数字都要能回答「你怎么知道的」—— 离线拿不到的（结构化分区/凭据/同步令牌）
 * 一律显式列出并说明原因，绝不显示为 0 或留空。
 */
import { DEFAULT_BACKUP_SECTIONS, OFFLINE_UNAVAILABLE_SECTIONS } from '../../core/backup-plan.ts'
import type { BackupVerifyResult } from '../../core/backup-verify.ts'
import { DISK_USAGE_AREAS, type DiskUsageAreaReport, type DiskUsageReport } from '../../core/disk-usage.ts'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { SessionHealthScanResult } from '../../utils/session-health-scan.ts'
import { createHash } from 'node:crypto'
import { redact } from '../../security/redaction.ts'
import { CONSOLE_SCRIPT } from './client-script.ts'
import type {
  LockReport, ProfilesOutcome, RepairOutcome, RescuePaths, RescueStatus, RestorePlanView,
  RunningInstance, SafeModeReport,
} from '../actions.ts'

export interface PageChrome {
  version: string
  paths: RescuePaths
  active: 'home' | 'disk' | 'sessions' | 'profiles' | 'unlock' | 'restore' | 'export' | 'reinstall'
}

const STYLE = [
  // ---- 设计 token：IBM Carbon（亮色语义四色）+ Raycast（暗色 surface 阶梯）----
  // 映射表、取的章节与全部偏离记录：docs/design/2026-10-04-cli-rescue-console-carbon.md
  // 文字色一律取「能读」的那一档：Carbon 的 #24a148 / #f1c21b 只做填充，正文用 #198038 / #8e6a00
  // （AA 对比度由 web.test.ts 的 R3-02 逐对钉住，改色先过那条测试）。
':root{color-scheme:light dark;--font:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--fg:#161616;--muted:#525252;--bg:#f4f4f4;--card:#fff;--surface:#f4f4f4;--line:#e0e0e0;--accent:#0f62fe;--accent-hover:#0043ce;--on-accent:#fff;--ok:#198038;--warn:#8e6a00;--bad:#da1e28;--scrim:rgba(22,22,22,.45)}',
'@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--fg:#f4f4f6;--muted:#9c9c9d;--bg:#07080a;--card:#0d0d0d;--surface:#121212;--line:#242728;--accent:#57c1ff;--accent-hover:#8ad3ff;--on-accent:#0a0a0a;--ok:#59d499;--warn:#ffc533;--bad:#ff6161;--scrim:rgba(0,0,0,.6)}}',
  // 强制暗色：系统是浅色也照做。**必须与上面的媒体查询块逐字相同**（R3-02 断言两者相等，防漂移）。
':root[data-theme="dark"]{--fg:#f4f4f6;--muted:#9c9c9d;--bg:#07080a;--card:#0d0d0d;--surface:#121212;--line:#242728;--accent:#57c1ff;--accent-hover:#8ad3ff;--on-accent:#0a0a0a;--ok:#59d499;--warn:#ffc533;--bad:#ff6161;--scrim:rgba(0,0,0,.6)}',
  // color-scheme 要跟着主题走，否则系统是暗色时强制浅色的表单控件/滚动条仍然是暗的。
':root[data-theme="dark"]{color-scheme:dark}',
':root[data-theme="light"]{color-scheme:light}',
'*{box-sizing:border-box}',
'body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:14px;line-height:1.6;letter-spacing:.16px}',
  // 焦点可见（Carbon 的 2px 强调描边）：键盘用户必须看得见自己在哪 —— 旧版没有任何 focus 样式。
':focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
'header.top{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:12px 24px}',
'.brand{font-size:18px;font-weight:600} .brand .ver{font-size:12px;color:var(--muted);font-weight:400;margin-left:8px;letter-spacing:.32px}',
  // 配色开关：三方按钮（自动 / 浅色 / 深色）。无脚本时整组隐藏 —— 页面回落到跟随系统，而不是给个点不动的控件。
'.brandRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
'.themeSwitch{display:none;align-items:center;gap:8px;font-size:12px;color:var(--muted)}',
':root[data-dcm-js="1"] .themeSwitch{display:inline-flex}',
'.themeBtn{font:inherit;font-size:12px;height:28px;padding:0 10px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer}',
'.themeBtn+.themeBtn{border-left:0}',
'.themeBtn:hover{color:var(--fg)}',
'.themeBtn[aria-pressed="true"]{background:var(--surface);color:var(--fg);font-weight:600}',
'nav{margin-top:8px;display:flex;gap:4px 20px;flex-wrap:wrap}',
'nav a{color:var(--muted);text-decoration:none;font-weight:500;padding-bottom:3px;border-bottom:2px solid transparent}',
'nav a:hover{color:var(--fg)} nav a.active{color:var(--fg);border-bottom-color:var(--accent)}',
'.sub{color:var(--muted);font-size:12px;margin-top:8px;word-break:break-all}',
'main{padding:24px;max-width:1180px;margin:0 auto}',
'h2{font-size:16px;font-weight:600;margin:24px 0 12px}',
  // 层级一律用「surface 变化 + 1px hairline」，不用阴影（Carbon）。
'section.card{background:var(--card);border:1px solid var(--line);padding:16px;margin-bottom:24px}',
'table{border-collapse:collapse;width:100%;font-size:14px}',
'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}',
'th{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.32px;white-space:nowrap} tr:last-child td{border-bottom:none}',
'td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
'code{font-family:var(--mono);font-size:.9em}',
'.muted{color:var(--muted)}',
'.banner{border:1px solid;padding:12px 16px;margin-bottom:24px}',
'.banner.ok{border-color:color-mix(in srgb,var(--ok) 45%,var(--line));background:color-mix(in srgb,var(--ok) 8%,var(--card))}',
'.banner.info{border-color:color-mix(in srgb,var(--accent) 40%,var(--line));background:color-mix(in srgb,var(--accent) 8%,var(--card))}',
'.banner.warn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line));background:color-mix(in srgb,var(--warn) 10%,var(--card))}',
'.banner.bad{border-color:color-mix(in srgb,var(--bad) 50%,var(--line));background:color-mix(in srgb,var(--bad) 10%,var(--card))}',
'.banner b{display:block;margin-bottom:4px}',
'.chip{display:inline-block;padding:2px 8px;background:var(--surface);font-size:12px;margin-right:6px}',
'.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px 24px}',
'.kv{display:flex;gap:8px;font-size:12px} .kv .k{color:var(--muted);min-width:104px;flex:none}',
'.kv .v{word-break:break-all}',
'footer{border-top:1px solid var(--line);color:var(--muted);font-size:12px;padding:16px 24px 48px;max-width:1180px;margin:0 auto}',
'footer ul{margin:8px 0 0;padding-left:18px} footer li{margin:4px 0}',
'a{color:var(--accent)} a:hover{color:var(--accent-hover)}',
'.sev{font-weight:600} .sev.blocksStartup{color:var(--bad)} .sev.unloadable{color:var(--bad)}',
'.sev.nextRequestFails{color:var(--warn)} .sev.invisible{color:var(--warn)} .sev.ok{color:var(--ok)}',
'.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}',
'.actionCard{border:1px solid var(--line);padding:12px 16px;background:var(--card)}',
'.actionCard p{margin:8px 0 0;font-size:12px}',
'.actionLink{font-weight:600;text-decoration:none} .actionLink:hover{text-decoration:underline}',
'.confirmForm{margin-top:8px}',
'.checkList{display:flex;flex-direction:column;gap:8px;margin:8px 0}',
'.checkRow{display:flex;gap:12px;align-items:flex-start;font-size:14px}',
'.checkRow input{margin-top:3px}',
'.consequence{background:var(--surface);padding:12px 16px;margin:12px 0;font-size:14px}',
  // 按钮 = Carbon 的处方角 + 40px 高（md）。危险动作刻意不用 Carbon 的实心红：见设计文档的偏离记录。
'.btnPrimary,.btnDanger,.btnPlain{font:inherit;font-weight:600;height:40px;padding:0 16px;cursor:pointer}',
'.btnPrimary{border:1px solid var(--accent);background:var(--accent);color:var(--on-accent)}',
'.btnPrimary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}',
'.btnDanger{border:1px solid var(--bad);background:transparent;color:var(--bad)}',
'.btnDanger:hover{background:color-mix(in srgb,var(--bad) 12%,transparent)}',
'.btnPlain{border:1px solid var(--line);background:transparent;color:var(--fg)}',
'.btnPlain:hover{background:var(--surface)}',
'.resultList{margin:0;padding-left:18px} .resultList li{margin:4px 0;word-break:break-all}',
'.gapTable{margin-top:12px}',
  // 表单 = Carbon 的 text-input：无框 + surface 填充 + 1px 底线，聚焦时内嵌 2px 强调描边。
'.inputText,.repairForm select{font:inherit;height:40px;padding:0 12px;border:0;border-bottom:1px solid var(--muted);background:var(--surface);color:var(--fg)}',
'.inputText{min-width:240px} .repairForm select{max-width:420px}',
'.inputText:focus-visible,.repairForm select:focus-visible{outline-offset:-2px}',
'.repairForm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}',
'.confirmWrap{margin-top:8px}',
'.confirmWrap>summary{cursor:pointer;display:inline-block;list-style:none}',
'.confirmWrap>summary::-webkit-details-marker{display:none}',
'.confirmTitle{font-size:14px;margin:0 0 8px}',
'.confirmBody{margin-top:12px}',
'dialog.dcmDialog{border:1px solid var(--line);padding:16px 24px;background:var(--card);color:var(--fg);width:min(680px,92vw);max-height:86vh;overflow:auto}',
  // 遮罩走 --scrim：旧版用 --fg 45%，暗色下变成「白纱」（越糊越白）—— 顺手修掉。
'dialog.dcmDialog::backdrop{background:var(--scrim)}',
'.dialogFooter{display:flex;gap:12px;margin-top:16px}',
'.backRow{margin-top:8px}',
'.gateCard{border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));background:color-mix(in srgb,var(--warn) 8%,var(--card));padding:12px 16px;margin:12px 0}',
'.gateCard b{display:block;margin-bottom:8px}',
'.gateCard ul{margin:8px 0 0;padding-left:18px} .gateCard li{margin:4px 0;word-break:break-all}',
'.gatePath{font-size:12px;color:var(--muted)}',
'.cov{display:inline-block;padding:2px 8px;background:var(--surface);font-size:12px;margin-left:6px}',
'.cov.warn{background:color-mix(in srgb,var(--warn) 18%,var(--surface))}',
  // ---- 过渡动画与骨架屏（零依赖、纯 CSS；全部吃 prefers-reduced-motion） ----
'@keyframes dcmFadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
'@keyframes dcmShimmer{from{background-position:-320px 0}to{background-position:320px 0}}',
'main>*{animation:dcmFadeUp .22s ease-out both}',
'main>*:nth-child(2){animation-delay:.03s} main>*:nth-child(3){animation-delay:.06s}',
'main>*:nth-child(4){animation-delay:.09s} main>*:nth-child(n+5){animation-delay:.12s}',
'nav a{transition:color .15s ease,border-color .15s ease}',
'a.actionLink,.actionCard,td a{transition:color .15s ease,background-color .15s ease}',
'.actionCard{transition:border-color .15s ease}',
'.actionCard:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}',
'.btnPrimary,.btnDanger,.btnPlain{transition:background-color .15s ease,border-color .15s ease}',
'.confirmWrap>summary{transition:background-color .15s ease}',
'dialog.dcmDialog{animation:dcmFadeUp .18s ease-out both}',
'dialog.dcmDialog::backdrop{animation:dcmFadeUp .18s ease-out both}',
  // 顶部进度条：导航一开始就出现，新页面 load 后自然被替换掉（不需要 JS）
'body::before{content:"";position:fixed;top:0;left:0;height:2px;width:100%;z-index:9;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:dcmSweep 1.1s linear infinite}',
'@keyframes dcmSweep{from{opacity:.25;transform:translateX(-40%)}to{opacity:.85;transform:translateX(40%)}}',
  // 骨架屏：加载期可见的占位（动画结束即隐藏，纯 CSS，禁用 JS 也成立）
'.skeleton{position:fixed;inset:0;z-index:8;background:var(--bg);padding:24px;animation:dcmSkeletonOut 0s linear 2.4s forwards}',
'.skeletonBar{height:14px;margin-bottom:12px;background:linear-gradient(90deg,var(--surface) 0%,color-mix(in srgb,var(--surface) 45%,var(--card)) 50%,var(--surface) 100%);background-size:320px 100%;animation:dcmShimmer 1.2s linear infinite}',
'.skeletonCard{height:96px;border:1px solid var(--line);background:var(--card);margin-bottom:16px;overflow:hidden}',
'@keyframes dcmSkeletonOut{to{opacity:0;visibility:hidden}}',
'@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}}',
].join('\n')

/**
 * 加载骨架：**纯 HTML + CSS 的"瞬态层"**，不依赖任何脚本。
 *
 * 为什么这样做而不是用 JS 显隐：救急台的渐进增强承诺是「禁用 JS 时功能与今天完全一致」。
 * 这一层在 HTML 解析到它时就已经在屏幕上了（浏览器还没渲染完后续内容 = 真正在加载），
 * 用 `animation-delay` 在 2.4s 后自动淡出并 `visibility:hidden`；它 `position:fixed` 覆盖视口、
 * `pointer-events` 不拦交互（z-index 低于顶部进度条）。页面加载完成那一刻其实早已不可见，
 * 所以不存在「卡住不消失」的风险 —— 这是无脚本约束下唯一诚实的做法。
 */
const SKELETON = '<div class="skeleton" aria-hidden="true">'
  + '<div class="skeletonBar" style="width:34%"></div>'
  + '<div class="skeletonBar" style="width:58%;height:11px"></div>'
  + '<div class="skeletonCard"></div><div class="skeletonCard" style="height:132px"></div>'
  + '<div class="skeletonCard" style="height:72px"></div>'
  + '</div>'

/* ------------------------------------------------------------ 小工具 */

/**
 * HTML 转义 + **脱敏**（唯一出口）。
 *
 * 两件事必须一起做，且顺序固定：先 `redact()` 再转义 —— 救急台会把磁盘上的路径、日志尾部、
 * 失败原因直接渲染出来，里面可能夹带形如 `"apiKey": "…"` / `?token=…` 的内容（§7 纪律：
 * 展示文本渲染前一律过 `redact()`，插件 UI 与 CLI 都遵守，这里不能例外）。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function esc(value: string): string {
  return escapeHtml(redact(value))
}

/**
 * **只转义、不脱敏**的展示出口：唯一用途是救急台**有意**回传给终端用户的「能力 URL」
 * （启动器从子进程日志抓到的带 token 的认证 URL）。
 *
 * 为什么必须与 esc() 分开（cli-F1）：esc() 先过安全侧 redact()，而 redact 的 URL_QUERY_RE
 * 会把 `?token=…` 的值抹成 ***REDACTED*** —— 那正是认证 URL 的形态，于是页面给出一条必然
 * 401 的死链（/profiles 的「打开实例」入口 + 启动结果页）。这些 URL 与终端里打印的 bootstrap
 * URL 同一性质：只给拿到会话 cookie 的人，本来就该原样可见。
 * 纪律：**只允许**用于本层自己签发/抓取的能力 URL；其余一切文本仍走 esc()。
 */
export function escCapability(value: string): string {
  return escapeHtml(value)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MiB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB'
}

function formatIso(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

type Cell = string | { html: string }

function cellHtml(value: Cell): string {
  return typeof value === 'string' ? esc(value) : value.html
}

function renderTable(headers: readonly string[], rows: readonly Cell[][]): string {
  if (rows.length === 0) return '<p class="muted">（无）</p>'
  const head = headers.map((h) => '<th>' + esc(h) + '</th>').join('')
  const body = rows
    .map((row) => '<tr>' + row.map((c) => '<td>' + cellHtml(c) + '</td>').join('') + '</tr>')
    .join('')
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
}

function banner(kind: 'ok' | 'info' | 'warn' | 'bad', title: string, text: string): string {
  return '<div class="banner ' + kind + '"><b>' + esc(title) + '</b>' + esc(text) + '</div>'
}

function kv(pairs: ReadonlyArray<[string, string]>): string {
  return '<div class="grid">' + pairs
    .map(([k, v]) => '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v"><code>' + esc(v) + '</code></span></div>')
    .join('') + '</div>'
}

function section(title: string, body: string): string {
  return '<h2>' + esc(title) + '</h2><section class="card">' + body + '</section>'
}

/* ------------------------------------------------------------ 布局 */

/**
 * 救急台是**多页**的（首页 / 会话 / 恢复 / 磁盘 …），所以「本页」这个词必须能落地：
 * 要么指向**本页内真实存在**的入口，要么**点名到页**（C1d 口径，captain 裁决）。
 * 页面名在这里只定义一次，导航与跨页指引共用，免得两处说法漂移。
 */
const RESTORE_PAGE_LABEL = '恢复'

/**
 * 救急台的**页面导航表（唯一事实源）**：头部导航与 404 / 405 / 错误页的「可用页面」清单
 * 全部由它派生 —— 此前那三处各写一份、且与现实不一致（把 JSON 自述的 `/healthz` 说成页面，
 * 又漏掉 `/restore` / `/export`）。`/healthz` 是 JSON 自述、不是页面，故不在表内。
 */
export const CONSOLE_PAGE_NAV: ReadonlyArray<{ key: PageChrome['active']; href: string; label: string }> = [
  { key: 'home', href: '/', label: '首页' },
  { key: 'disk', href: '/disk', label: '磁盘占用' },
  { key: 'sessions', href: '/sessions', label: '会话体检' },
  { key: 'profiles', href: '/profiles', label: '档案与实例' },
  { key: 'restore', href: '/restore', label: RESTORE_PAGE_LABEL },
  { key: 'export', href: '/export', label: '导出' },
  { key: 'unlock', href: '/unlock', label: '解锁' },
  { key: 'reinstall', href: '/reinstall', label: '重装' },
]

/** 「可用页面」提示行（404 / 405 / 错误页共用这一份派生结果，不再各写一份）。 */
export function consolePagesHint(): string {
  return '可用页面：' + CONSOLE_PAGE_NAV.map((item) => item.href + '（' + item.label + '）').join('、')
}

function renderHeader(chrome: PageChrome, subtitle: string): string {
  const links = CONSOLE_PAGE_NAV
    .map((item) => '<a href="' + item.href + '"' + (chrome.active === item.key ? ' class="active"' : '') + '>' + esc(item.label) + '</a>')
    .join('')
  const themeSwitch = '<div class="themeSwitch" role="group" aria-label="配色"><span>配色</span>'
    + [['auto', '自动'], ['light', '浅色'], ['dark', '深色']]
      .map(([mode, label]) => '<button type="button" class="themeBtn" data-dcm-theme="' + mode + '" aria-pressed="false">' + label + '</button>')
      .join('')
    + '</div>'
  return '<header class="top"><div class="brandRow"><div class="brand">DCM 离线救急台'
    + '<span class="ver">v' + esc(chrome.version) + ' · 默认只读 / 写动作需确认</span></div>'
    + themeSwitch + '</div>'
    + '<nav>' + links + '</nav>'
    + '<div class="sub">' + esc(subtitle) + '</div></header>'
}

function renderFooter(): string {
  const lines: Array<[string, string]> = [
    ['dsh-config-manager snapshots', '列出快照'],
    ['dsh-config-manager verify --json', '备份只读自检（本页的「校验」用的是同一实现）'],
    ['dsh-config-manager backup --dry-run', '离线备份计划预览'],
    ['dsh-config-manager sessions doctor', '会话体检'],
    ['dsh-config-manager restore --dry-run', '恢复计划预览'],
    ['dsh-config-manager sessions repair --apply', '会话布局归位（本页按同一实现执行）'],
    ['dsh-config-manager recover-stale-lock', '回收残留环境锁（本页按同一实现执行）'],
  ]
  return '<footer><div>本页默认<strong>只读</strong>；写动作（会话归位 / 清理缓存 / 回收残留锁）只在你点开对应页面并显式提交时才执行，执行前会先给计划与副作用说明。</div><ul>'
    + lines.map(([cmd, desc]) => '<li><code>' + esc(cmd) + '</code> — ' + esc(desc) + '</li>').join('')
    + '</ul></footer>'
}

export function renderLayout(chrome: PageChrome, body: string, subtitle = ''): string {
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>DCM 离线救急台</title>\n<style>' + STYLE + '</style>\n'
    // 脚本放 <head>：主题要在**首帧之前**落到 <html> 上（放 body 末尾会先闪一下强制主题）。
    // 脚本自己的 DOM 操作全部等在 DOMContentLoaded，所以放 head 不会读到半个 DOM。
    + '<script>' + CONSOLE_SCRIPT + '</script>\n</head>\n<body>\n'
    + renderHeader(chrome, subtitle) + '\n' + SKELETON + '\n<main>\n' + body + '\n</main>\n' + renderFooter()
    + '\n</body>\n</html>\n'
}

/** 独立极简页（403/404 用；不依赖任何目录事实，避免在错误路径上再读盘）。 */
export function renderMessagePage(title: string, message: string, hint = ''): string {
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + esc(title) + '</title>\n<style>' + STYLE + '</style>\n</head>\n<body>\n<main>\n'
    + '<h2>' + esc(title) + '</h2><section class="card"><p>' + esc(message) + '</p>'
    + (hint === '' ? '' : '<p class="muted">' + esc(hint) + '</p>')
    + '</section>\n</main>\n</body>\n</html>\n'
}

/* ------------------------------------------------------------ 首页 */

export interface HomePageInput { status: RescueStatus; version: string; actions?: readonly ActionCard[] }

export function renderHomePage(input: HomePageInput): string {
  const s = input.status
  const chrome: PageChrome = { version: input.version, paths: s.paths, active: 'home' }
  const parts: string[] = []
  for (const error of s.errors) {
    parts.push(banner('bad', '有一项读不出来', error + ' —— 下面的列表可能不完整，请先处理这条。'))
  }
  parts.push(safeModeBanner(s.safeMode))
  parts.push(section('路径与口径', pathsBody(s.paths, s.generatedAt)))
  parts.push(section('运行中的 DSH 实例（心跳）', instancesBody(s.instances)))
  parts.push(section('环境锁', lockBody(s.lock)))
  const unreadableList = new Set(s.errors)
  parts.push(section('快照（导入前备份）',
    snapshotsBody(s.snapshots, [...unreadableList].some((e) => e.includes('快照目录读不出来')))))
  parts.push(section('备份产物（导出目录）',
    backupsBody(s.backups, [...unreadableList].some((e) => e.includes('导出目录读不出来')))))
  parts.push(section('可以在这里做的事（写动作需显式确认）', actionCards(input.actions ?? [])))
  parts.push(section('能力边界（先说清楚，免得白找）', capabilityBody()))
  parts.push(section('离线看不到什么', offlineBody()))
  const subtitle = s.paths.homeDir + ' · profile ' + s.paths.profile + ' · 生成于 ' + s.generatedAt
  return renderLayout(chrome, parts.join('\n'), subtitle)
}

/**
 * 能力矩阵：**能**做什么 / **不能**做什么，各一行说清。
 *
 * 为什么放在首页：救急台最容易制造的错误期待是「它应该能修好一切」——
 * 用户找不到某个按钮时会以为是坏了，而不是「这台机器离线做不到」。把边界写在最上面最省事。
 */
function capabilityBody(): string {
  // 两段文案都经 rows() 的 esc(note) 渲染（HTML 转义）：这里写 <strong> 会被转义成字面标签、
  // 写 ** 会显示成字面星号 —— 两种都不行，所以这些说明里不放任何强调标记（C1d）。
  const can: ReadonlyArray<[string, string]> = [
    ['看', '实例心跳 / SAFE MODE / 残留锁 / 快照 / 备份产物 / 磁盘占用 / 会话体检 / 档案'],
    ['自检备份', '每个导出产物一键做结构与完整性校验（与命令行 verify 同一实现）'],
    ['解锁加密备份', '输入密码在内存里解出明文并列出条目清单（不落盘、不回传内容）'],
    ['恢复快照', '先看逐项恢复计划（零写入），确认后按计划还原/删除文件并卸载导入期新增插件'],
    ['离线导出', '把离线可读的文件类分区（skills / agentPresets / agentInstructions / self）打成与 GUI 同结构的 ZIP'],
    ['修会话布局', '位置与 header cwd 不一致的会话按计划归位（要求 DSH 已停止）'],
    ['清磁盘', '可重建缓存与过期导出产物（导入前快照与同步数据永不在候选集内）'],
    ['回收残留锁', '仅当持有进程被确证不存在时（活锁一律拒绝）'],
    ['启停实例', '把某个档案作为独立实例启动，或停止它（含手动启动的外部实例）'],
    ['重装 DSH', '卸载并重装全局 DSH —— 需要终端里打印的 6 位确认码，页面里看不到它'],
  ]
  const cannot: ReadonlyArray<[string, string]> = [
    ['导入配置（把包写回本机）', '结构化分区的值必须经 DSH 服务门面写入 —— 用 GUI（本页能做导出与恢复，不做导入）'],
    ['看运行中 DSH 的配置值', '离线读不到 settings / plugins / mcp 等结构化分区的值；但加密备份解锁后能看到包内文件清单'],
    ['同步通道（git / WebDAV）', '通道密码与令牌存在 DSH credentials 里，离线取不到'],
    ['凭据值', '凭据不可回读，任何时候都不显示'],
  ]
  const rows = (items: ReadonlyArray<[string, string]>, mark: string): string =>
    items.map(([what, note]) => '<tr><td>' + mark + ' ' + esc(what) + '</td><td class="muted">' + esc(note) + '</td></tr>').join('')
  return '<table><thead><tr><th>能</th><th>说明</th></tr></thead><tbody>'
    + rows(can, '✓') + '</tbody></table>'
    + '<table class="gapTable"><thead><tr><th>不能（去哪儿做）</th><th>说明</th></tr></thead><tbody>'
    + rows(cannot, '✗') + '</tbody></table>'
}

function pathsBody(paths: RescuePaths, generatedAt: string): string {
  return kv([
    ['DSH home', paths.homeDir],
    ['插件数据根', paths.dataDir],
    ['快照目录', paths.snapshotsDir],
    ['导出目录', paths.exportsDir],
    ['锁目录', paths.locksDir],
    ['profile', paths.profile],
    ['生成时间', generatedAt],
  ])
}

function safeModeBanner(reports: readonly SafeModeReport[]): string {
  const blocked = reports.filter((r) => r.state === 'blocked')
  const unknown = reports.filter((r) => r.state === 'unknown')
  if (blocked.length > 0) {
    return banner('bad', 'SAFE MODE 已激活：破坏性操作会被拒绝',
      '存在未结案的配置 transaction。标记文件：' + blocked.map((r) => r.marker).join('；')
      + '。解除入口在 GUI 的「事故恢复」（需要 DSH 在跑）；本页只做如实展示，不会替你清标记。')
  }
  if (unknown.length > 0) {
    return banner('warn', 'SAFE MODE 状态无法判定（按最保守口径处理）',
      '读不到或无法判定标记文件：' + unknown.map((r) => r.marker).join('；'))
  }
  // 「没建过数据目录」不等于「检查过、没问题」——只在确实存在的控制面根上给绿灯
  const established = reports.filter((r) => r.established)
  if (established.length === 0) {
    return banner('info', 'SAFE MODE：未发现控制面目录',
      '候选根下还没有插件数据目录（' + reports.map((r) => r.root).join('；')
      + '），因此没有标记可读。这不是「已检查且正常」，只是这里还没建过东西。')
  }
  return banner('ok', 'SAFE MODE 未激活（已核对 ' + String(established.length) + ' 个控制面根）',
    '已存在的控制面目录里都没有未结案的 transaction：' + established.map((r) => r.root).join('；'))
}

function instancesBody(instances: readonly RunningInstance[]): string {
  if (instances.length === 0) {
    return '<p class="muted">没有检测到运行中的实例（心跳 running/&lt;profile&gt;.json 里没有存活且未过期的记录）。</p>'
  }
  return renderTable(['档案', 'PID', '端口', '启动时间', '心跳时间'], instances.map((i) => [
    i.name,
    String(i.pid),
    i.port === null ? '—' : String(i.port),
    formatIso(i.startedAt),
    formatIso(i.updatedAt),
  ]))
}

function lockBody(lock: LockReport): string {
  if (!lock.present) {
    return '<p class="muted">没有残留的环境锁（' + esc(lock.locksDir) + ' 下没有 ownership 文件）。</p>'
  }
  const detail = lock.detail === undefined ? '' : '<p class="muted">' + esc(lock.detail) + '</p>'
  const hint = lock.state === 'STALE_LOCK_DETECTED'
    ? '<p>这是可回收的残留锁：<code>dsh-config-manager recover-stale-lock</code></p>'
    : '<p class="muted">非 stale（活锁或无法判定）时绝不自动回收；回收只发生在显式命令里。</p>'
  return '<p>状态：<span class="chip">' + esc(lock.state) + '</span></p>' + detail + hint
}

function snapshotsBody(snapshots: readonly SnapshotMeta[], unreadable = false): string {
  if (unreadable) {
    // 目录读不出来 ≠ 没有快照（验收 F2）：这一格也不能说「没有」，否则横幅与卡片互相矛盾
    return '<p class="muted">快照目录读不出来，无法列出（见页面顶部的告警）。这不是「没有快照」。</p>'
  }
  if (snapshots.length === 0) {
    return '<p class="muted">没有快照。快照是导入前自动留下的「撤回点」。</p>'
  }
  const rows: Cell[][] = snapshots.map((s) => [
    { html: '<code>' + esc(s.id) + '</code>' },
    s.createdAt,
    s.sourceZip,
    s.status ?? 'unknown',
    String(s.entryCount),
  ])
  return renderTable(['ID', '创建时间', '来源备份', '状态', '条目数'], rows)
    // C1d 口径：救急台是多页的 ⇒ 这里必须**点名到页**，不能再用空泛的「本页不提供」
    // 抹掉用户在本工具里已经能做的事（恢复写入口在 「恢复」页，POST /restore/run）。
    + '<p class="muted">恢复（restore）是写动作，本页（首页）不提供；请在「' + RESTORE_PAGE_LABEL
    + '」页执行（先看逐项计划，确认后才落盘）。命令行侧可用 <code>dsh-config-manager restore --dry-run</code> 先看计划。</p>'
}

/**
 * 备份名 → 不透明校验 id（sha256 前 16 位 hex）。
 *
 * 为什么不直接用文件名做查询参数：文件名可能**夹带密钥**（实测 `leak-apiKey=SECRET123.zip`），
 * 而 `?file=<原样编码>` 会把明文重新写回页面（redact 只作用于显示文本，改不了 href 里的参数）。
 * 摘要既能正确定位到列表里那一项，又不泄漏任何名字内容（验收 F7）。
 */
export function verifyIdOf(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)
}

function backupsBody(backups: readonly BackupFileMeta[], unreadable = false): string {
  if (unreadable) {
    return '<p class="muted">导出目录读不出来，无法列出（见页面顶部的告警）。这不是「没有备份产物」。</p>'
  }
  if (backups.length === 0) return '<p class="muted">导出目录里没有备份产物。</p>'
  const rows: Cell[][] = backups.map((b) => [
    { html: '<code>' + esc(b.name) + '</code>' },
    formatBytes(b.sizeBytes),
    formatIso(b.mtimeMs),
    b.source === 'auto' ? '定时备份' : '手动导出',
    b.containerType === 'encrypted' ? '加密容器（导入前需解锁）' : '明文 ZIP',
    // 链接参数用**不透明摘要**而不是文件名本身（文件名可能夹带密钥，见下）
    { html: '<a href="/verify?id=' + verifyIdOf(b.name) + '">校验</a>' },
  ])
  return renderTable(['文件', '大小', '修改时间', '来源', '容器形态', '操作'], rows)
}

function offlineBody(): string {
  const available = DEFAULT_BACKUP_SECTIONS.map((id) => '<code>' + esc(id) + '</code>').join('、')
  const unavailable = OFFLINE_UNAVAILABLE_SECTIONS.map((id) => '<code>' + esc(id) + '</code>').join('、')
  return '<p>离线（DSH 没在跑）时，下面这些分区的<strong>值</strong>必须经 DSH 服务读取，因此本页不显示它们，'
    + '只显示磁盘事实。</p>'
    + '<p>离线不可读：' + unavailable + '</p>'
    + '<p>离线可读（文件类，与 <code>backup</code> 同一份清单）：' + available + '</p>'
    + '<p class="muted">本页刻意不显示：凭据值（不可回读）、同步通道的密码与令牌（存在 DSH credentials）、'
    + '导入后的工作区登记（必须经 workspace registry）——「看不到」不等于「没有」。</p>'
}

/* ------------------------------------------------------------ 磁盘占用 */

/** 磁盘清理卡的标题：保留期说明要按名字指向它 —— 同一事实只有一处措辞（C1d）。 */
const DISK_CLEANUP_SECTION_TITLE = '清理磁盘（写动作）'

export function renderDiskPage(
  report: DiskUsageReport,
  version: string,
  paths: RescuePaths,
  actionToken: string,
  done: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'disk' }
  const rows: Cell[][] = DISK_USAGE_AREAS.map((area) => {
    const a: DiskUsageAreaReport = report.areas[area]
    return [
      area,
      a.unreadable ? '未统计（读不到）' : formatBytes(a.sizeBytes),
      a.unreadable ? '—' : String(a.fileCount),
      policyLabel(a.policy),
      a.expiredBytes === undefined || a.expiredBytes === 0 ? '—' : formatBytes(a.expiredBytes),
    ]
  })
  const unreadableAreas = DISK_USAGE_AREAS.filter((area) => report.areas[area].unreadable)
  const summary = '<p>合计 <strong>' + esc(formatBytes(report.totalBytes)) + '</strong> ／ '
    + String(report.totalFiles) + ' 个文件；可立即清理 <strong>' + esc(formatBytes(report.reclaimableBytes))
    + '</strong>；已超保留期 ' + esc(formatBytes(report.expiredBytes)) + '。</p>'
    + (unreadableAreas.length === 0
      ? '<p class="muted">全部子区都已统计。</p>'
      // 「未统计」必须写进合计旁边：只写 0 会让用户以为这些区域是空的（验收 F4）
      : '<p class="muted">有 ' + String(unreadableAreas.length) + ' 个子区未统计（不是 0）：'
        + unreadableAreas.map((area) => '<code>' + esc(area) + '</code>').join('、') + '。</p>')
  const retention = '<p class="muted">定时备份保留最近 ' + String(report.backupRetention.keepLast)
    + ' 个（最新一份 ' + esc(formatBytes(report.backupRetention.latestBackupBytes)) + '，'
    // C1d：清理的写入口**就在本页下一张卡**（/disk/cleanup，见 :DISK_CLEANUP_SECTION_TITLE），
    // 旧文案「本页不提供」与它自相矛盾。按裁决 (a) 指向本页真实存在的入口。
    + esc(formatIso(report.backupRetention.latestBackupAt)) + '）。清理是写动作，就在本页下方「'
    + DISK_CLEANUP_SECTION_TITLE + '」卡里执行（需显式确认）。</p>'
  const parts = [section('磁盘占用（只读体检）', summary + renderTable(
    ['子区', '体积', '文件数', '回收策略', '已超期'], rows) + retention)]
  if (done === 'cleaned') parts.unshift(banner('ok', '清理已完成', '结果见下方逐条明细（本次操作的回执）。'))
  const cleanable = report.reclaimableBytes + report.expiredBytes
  parts.push(section(DISK_CLEANUP_SECTION_TITLE, renderConfirmForm({
    action: '/disk/cleanup',
    token: actionToken,
    title: '清理缓存与过期导出产物',
    // 本行经 renderConfirmForm 的 esc()：不能写 markup（会被转义），也不能写 **（会显示字面星号）⇒ 去标记
    consequence: '可重建区（tmp / 市场缓存 / 市场工作副本）按勾选整块清理；导出产物只在勾选时、且只按保留期回收。'
      + '导入前快照与同步数据永远不在候选集内。当前可回收约 ' + formatBytes(report.reclaimableBytes)
      + '，已超保留期约 ' + formatBytes(report.expiredBytes) + '。',
    submitLabel: '按勾选执行清理',
    danger: false,
    checklist: [
      { name: 'caches', label: '清理可重建缓存', description: 'tmp / 市场缓存 / 市场工作副本（忽略保留期整块清；这些内容可随时重建）', checked: cleanable > 0 },
      { name: 'expired-exports', label: '回收已超保留期的导出产物', description: '只删超过保留期的备份 ZIP；定时备份产物由保留策略管理，不在此列', checked: false },
    ],
    note: '等价命令：dsh-config-manager web 的磁盘页；命令行侧可用 dsh-config-manager verify 逐个核对备份。',
  })))
  return renderLayout(chrome, parts.join('\n'), paths.dataDir + ' · 写动作需显式确认')
}

/**
 * 写入门卡片：把「为什么现在不能写」讲成可操作的三步，而不是丢一句 reason。
 *
 * 为什么必须有：`dsh-running` 是救急台最常撞到的一道门（本机实测：桌面端 + web 实例同时在跑），
 * 用户点「执行修复」只会看到 409 + 一句「请先关闭 DSH」。这里把**是谁在跑**、**怎么关**、
 * **关完怎么回来**三件事一次说清，并给一个「重新检查」——它走**同一个只读入口**，
 * 只是为了刷新门状态，绝不代关任何进程（关进程是用户的决定，页面不越界）。
 */
function gateCard(gate: GateView | null, actionToken: string): string {
  if (gate === null || gate.ok) return ''
  const instances = gate.instances ?? []
  const rows = instances.map((i) => '<li><code>' + esc(i.name) + '</code> pid=' + String(i.pid)
    + (i.port === null ? '' : ' · 端口 ' + String(i.port)) + '</li>').join('')
  const cmds = (gate.commands ?? []).map((c) => '<li><code>' + esc(c) + '</code></li>').join('')
  return '<div class="gateCard" data-dcm-gate="' + esc(gate.code) + '">'
    + '<b>现在还不能写：' + esc(gate.reason) + '</b>'
    + (rows === '' ? '' : '<div>正在运行的实例：</div><ul>' + rows + '</ul>')
    + (cmds === '' ? '' : '<div>解除步骤：</div><ul>' + cmds + '</ul>')
    + '<p class="muted">改写会话字节必须在 DSH 停止后进行（两个写入者会互相覆盖成重放族）。'
    + '本页不会替你关掉任何进程 —— 那是你的决定。</p>'
    + '<form class="repairForm" method="get" action="/sessions"><button class="btnPlain" type="submit">重新检查门状态</button></form>'
    + '</div>'
}

/** 修复区块：先给只读计划（与 CLI 同源），再给确认表单。 */
function repairBody(plan: RepairOutcome | null, actionToken: string): string {
  if (plan === null) {
    return '<p class="muted">无法生成修复计划（会话根读不出来）：先解决上一张卡片里的错误。</p>'
  }
  const stepRows: Cell[][] = plan.steps.map((s) => [
    s.kind,
    { html: '<code>' + esc(s.sessionId) + '</code>' },
    s.fromProjectKey + (s.toProjectKey === undefined ? '' : ' → ' + s.toProjectKey),
    s.prefixRewrite === undefined ? '—' : s.prefixRewrite.from + ' → ' + s.prefixRewrite.to,
    s.reason,
  ])
  const summary = '<p>扫描 ' + String(plan.scanned) + ' 条：待处理 <strong>' + String(plan.steps.length)
    + '</strong>，跳过 ' + String(plan.skipped) + '，重复 id ' + String(plan.duplicates) + '。</p>'
  const table = stepRows.length === 0
    ? '<p class="muted">没有需要归位的会话（本页的写入口仍保留，供修复条件出现后使用）。</p>'
    : renderTable(['动作', '会话', '位置', '首帧 cwd 改写', '原因'], stepRows)
  const canRun = plan.steps.some((s) => s.applies)
  const form = plan.dryRun && canRun
    ? renderConfirmForm({
      action: '/sessions/repair',
      token: actionToken,
      title: '执行会话布局归位',
      consequence: '会把位置与 header cwd 不一致的会话目录搬到正确位置；命中前缀映射的会话先改写首帧 cwd'
        + '（其余帧逐字节保留），搬不动就回滚改写。移动后 DSH 启动校验才通得过。',
      submitLabel: '执行修复（' + String(plan.steps.filter((s) => s.applies).length) + ' 项）',
      danger: true,
      note: '前置条件：SAFE MODE 未激活、无残留锁、DSH 已停止。等价命令：dsh-config-manager sessions repair --apply',
    })
    : '<p class="muted">当前没有可执行的步骤（或计划不可用）。重复 id 请用命令行 --keep 指定保留哪一份。</p>'
  return summary + table + form
}

/**
 * 修复二（重放族）：**只在这里给出零损失可修项**，并把「其余类别为什么不在这修」写清楚。
 *
 * 能力边界（不得放宽）：应用内/页面侧只做「字节相同 + seq 相同的重放重复行」这一零损失类；
 * 合成 closer / seq 空洞 / 不可解析行 / 容器非法 / header 不可读 / 子代理缺父 一律只报告，
 * 出路是本页的就地修复入口（可零损失修项会给出按钮）或**保留原样**。这条界线来自设计稿 §10.3/§10.4，
 * 页面必须照实呈现。
 *
 * 说法纪律（C1b，与 src/cli/actions.ts 的 C1 修复同源）：`sessions repair [--fix]` **不改写会话字节**
 * （只做会话布局归位与重复 id 隔离），因此本段**绝不**能把它写成「重放去重」的等价命令 —— 那是把两件
 * 不同的事说成一条通道，用户会以为「修不了重放重复行是因为命令没敲对」。反过来，
 * 「修复一：会话布局归位」卡里的等价命令是**成立**的（本页与 CLI 走同一实现），**刻意保留**，
 * 别在收尾时一刀切删掉。
 *
 * C1c：会话页顶部的 fixHint 此前写着「本页不提供」，与这一段、「修复一」卡（:591「本页按同一实现执行」）
 * **自相矛盾** —— 同一事实两处说法必然漂移。这里把「本页提供哪些写入口」也收成单一事实源
 * （PAGE_SESSION_WRITE_ENTRIES），fixHint 只渲染它；同时把本段里当强调用的字面 `**` 改成真 <strong>。
 */

/**
 * 会话页写入口的**单一事实源**（C1c）。
 *
 * 只允许这一处说「本页提供/不提供哪些写动作」；任何页面文案要提这件事，都必须引用本常量。
 */
const PAGE_SESSION_WRITE_ENTRIES = '修复是写动作，须先把 DSH 停掉。本页<strong>提供</strong>两个写入口：'
  + '「修复一：会话布局归位」（布局归位与重复 id 隔离，与本机 CLI 的 <code>sessions repair --apply</code> 同一实现）与'
  + '「修复二：重放重复行」（字节级零损失就地修复，发现可修项时才给出按钮）；'
  + '两者都要过与 CLI 同源的写入门（SAFE MODE / 残留锁 / DSH 已停止）。'
  + '其余类别（合成 closer / seq 空洞 / 子代理缺父 …）本页只报告，原因见「修复二」段的职责边界。'

/**
 * `sessions repair [--fix]` 的**职责边界**（C1b 立的说法，C1c 抽成常量以便多处引用而只有一处措辞）。
 *
 * 渲染逐字不变（R1-02b 断言 /职责边界/、/sessions repair \[--fix\]/、/不改写会话字节/、/dcm web/、
 * /修复选中的会话（零损失）/）。
 */
const SESSIONS_REPAIR_BOUNDARY = '<code>sessions repair [--fix]</code> 只做会话'
  + '<strong>布局归位</strong>与<strong>重复 id 隔离</strong>，<strong>不改写会话字节</strong>，'
  + '所以修不了重放重复行；离线<strong>字节级</strong>通道就是本救急台（<code>dcm web</code> 打开的这一页）：'
  + '发现可零损失修项时，本段会列出清单并给出「修复选中的会话（零损失）」按钮，无需任何命令行动作。'

function inlineRepairBody(view: InlineRepairView | null, gate: GateView | null, actionToken: string): string {
  if (view === null) {
    return '<p class="muted">未探测（本次体检没有跑到可修项扫描）。</p>'
  }
  const head = '<p class="muted">探测了 <strong>' + String(view.probed) + '</strong> 条存在深档问题的会话：'
    + '其中 <strong>' + String(view.fixable.length) + '</strong> 条存在<strong>零损失</strong>可修项'
    + '（重放重复行 —— 字节相同且 seq 相同的副本，丢弃即恢复）。</p>'
  // 本段的出口只指向**本救急台自己**的就地修复入口：sessions repair 不改写会话字节，不能当等价通道。
  // 文案取自单一事实源（C1c）——别在这里另写一套说法。
  const boundary = '<p class="muted">职责边界：' + SESSIONS_REPAIR_BOUNDARY + '</p>'
  if (view.fixable.length === 0) {
    const why = view.blocked.length === 0 ? ''
      : '<p class="muted">其余不可修的原因分布：'
        + view.blocked.map((b) => '<code>' + esc(b.reason) + '</code> × ' + String(b.count)).join('、')
        + '。这些类别按设计<strong>只报告</strong>，不解压改写会话字节。</p>'
    return head + '<p class="muted">本次没有发现可零损失修复的会话。</p>' + why + boundary
  }
  const gateNote = gate !== null && !gate.ok
    ? '<p class="muted">注意：写入门当前是关闭状态（见上方「写入门状态」），提交会被如实拒绝。</p>'
    : ''
  return head
    + renderTable(['会话单元', '将丢弃的重复行'], view.fixable.map((f) => [
      { html: '<code>' + esc(f.unitId) + '</code>' }, String(f.droppedRows),
    ]))
    + renderConfirmForm({
      action: '/sessions/inline-repair',
      token: actionToken,
      title: '就地修复重放重复行',
      // 本段走 renderConfirmForm 的 esc()：consequence 里写 markup 会被转义、写 ** 会渲染成字面星号
      // （C1c 修的就是这个），所以这里不带任何强调标记，事实措辞不变。
      consequence: '对选中的那一条会话：丢弃字节相同且 seq 相同的重放重复事件，写前重跑连续性/引用完整性校验'
        + '（不过就拒绝），时间戳备份就地保留，临时文件 + rename 原子换入，写后复验。'
        + '合成 closer / seq 空洞 / 子代理缺父不在本入口的修复范围内（只报告）。',
      submitLabel: '修复选中的会话（零损失）',
      danger: false,
      checklist: view.fixable.map((f, i) => ({
        name: 'unit:' + f.unitId,
        label: f.unitId,
        description: '丢弃 ' + String(f.droppedRows) + ' 行重放重复事件' + (i === 0 ? '（默认勾选第一条）' : ''),
        checked: i === 0,
      })),
      note: '前置条件：SAFE MODE 未激活、无残留锁、DSH 已停止、会话目录无 session.lock、日志不在最近 30s 内被写过。',
    })
    + boundary
    + gateNote
}

function policyLabel(policy: DiskUsageAreaReport['policy']): string {
  if (policy === 'regenerable') return '可随时重建'
  if (policy === 'retained') return '按保留期回收'
  return '用户数据（只报告）'
}

/* ------------------------------------------------------------ 会话体检 */

export function renderSessionsPage(
  result: SessionHealthScanResult | null,
  error: string | undefined,
  version: string,
  paths: RescuePaths,
  plan: RepairOutcome | null,
  actionToken: string,
  done: string,
  /** 写入门现状（只读投影）；缺省 = 未探测，页面不显示门卡片 */
  gate: GateView | null = null,
  /** 就地修复（重放族）的就绪情况；缺省 = 未探测 */
  inline: InlineRepairView | null = null,
): string {
  const chrome: PageChrome = { version, paths, active: 'sessions' }
  if (result === null) {
    return renderLayout(chrome, banner('bad', '会话体检失败', error ?? '未知原因'), paths.homeDir + ' · 只读')
  }
  const parts: string[] = []
  if (!result.sessionsDirExists) {
    parts.push(banner('warn', '这台机器上没有会话数据', '会话根不存在：' + result.sessionsDir))
  }
  const by = result.summary.bySeverity
  const counts = '<p>共 ' + String(result.summary.total) + ' 条会话：'
    + '阻断启动 <strong>' + String(by.blocksStartup) + '</strong>，'
    + '不可加载 <strong>' + String(by.unloadable) + '</strong>，'
    + '下次请求会失败 ' + String(by.nextRequestFails) + '，'
    + '不可见 ' + String(by.invisible) + '，正常 ' + String(by.ok) + '。</p>'
  // 覆盖度必须写清「深查的是哪些」：行档最贵，所以有限额；限额按**最近写入优先**取，
  // 不写出来的话「某些会话有时报深档问题、有时不报」会被读成随机故障（本机实测踩过）。
  const coverage = '<p class="muted">深度校验 ' + String(result.summary.deepVerified)
    + ' 条（<strong>按最近写入优先</strong>：只覆盖最贵的行档限额，最新写过的会话优先被查）'
    + '，未做深度校验 ' + String(result.summary.deepUnverified) + ' 条'
    + (result.untested > 0 ? '；另有 ' + String(result.untested) + ' 条超出扫描上限未体检' : '')
    + (result.unreadableEntries > 0 ? '；读取失败 ' + String(result.unreadableEntries) + ' 项' : '')
    + '。未体检 ≠ 没问题。</p>'
  parts.push(section('会话根 / sessions root', '<p><code>' + esc(result.sessionsDir) + '</code></p>' + counts + coverage))
  const problems = result.rows.filter((row) => row.severity !== 'ok')
  const rows: Cell[][] = problems.map((row) => [
    { html: '<span class="sev ' + esc(row.severity) + '">' + esc(row.severity) + '</span>' },
    { html: '<code>' + esc(row.unitId) + '</code>' },
    row.version === undefined ? '—' : 'v' + String(row.version),
    row.sizeBytes === undefined ? '—' : formatBytes(row.sizeBytes),
    row.issues.map((i) => i.code + (i.detail === undefined ? '' : '(' + i.detail + ')')).join(' '),
  ])
  // C1c：旧文案说「本页不提供」，与同页「修复一」卡（本页确实提供该写动作）自相矛盾 —— 改为单一事实源。
  const fixHint = problems.length > 0
    ? '<p class="muted">' + PAGE_SESSION_WRITE_ENTRIES + '</p>'
    : ''
  parts.push(section('需要处理的会话（' + String(problems.length) + '）',
    renderTable(['严重级', '会话单元', '格式版本', '体积', '问题'], rows) + fixHint))
  if (done === 'repaired') parts.unshift(banner('ok', '修复已完成', '逐条结果见修复回执页。'))
  if (done === 'inline-repaired') parts.unshift(banner('ok', '就地修复已完成', '逐条结果见修复回执页（含备份文件名，回滚入口在 GUI 的事故恢复）。'))
  // 写入门：把「为什么现在写不了」讲成可操作的三步（而不是只在提交后给 409）
  const gateHtml = gateCard(gate, actionToken)
  if (gateHtml !== '') parts.push(section('写入门状态（只读）', gateHtml))
  parts.push(section('修复一：会话布局归位（写动作）', repairBody(plan, actionToken)))
  parts.push(section('修复二：重放重复行（零损失，可就地执行）', inlineRepairBody(inline, gate, actionToken)))
  return renderLayout(chrome, parts.join('\n'), paths.homeDir + ' · 写动作需显式确认')
}

/* ------------------------------------------------------------ 写动作（阶段 2） */

/** 首页/磁盘页上的写动作卡（禁用时必须给出原因，绝不静默消失）。 */
/**
 * 就地修复（重放族）视图：来自 actions.repairSessionLogInline 的**只读预览**。
 *
 * 呈现纪律：这里只显示「哪几条会话存在零损失可修项（重放重复行）」以及「其余类别为什么
 * 不在这里修」。合成 closer / seq 空洞 / 子代理缺父 属于**只报告**类（设计稿 §10.3/§10.4 的
 * G-23 界限）——页面必须把这条边界写出来，而不是让用户以为「点一下就能全修好」。
 */
export interface InlineRepairView {
  /** 预览发现的、可零损失修复的会话（unitId + 将丢弃的重复行数） */
  fixable: Array<{ unitId: string; droppedRows: number }>
  /** 预览探测过的单元数（让「没发现」有分母，不是拍胸脯） */
  probed: number
  /** 预览里被判为不可修的原因分布（只报告类的证据） */
  blocked: Array<{ reason: string; count: number }>
}

/** 写入门视图（actions.checkWriteGates 的结构化投影；页面只渲染，不重写判定）。 */
export interface GateView {
  ok: boolean
  code: string
  reason: string
  instances?: Array<{ name: string; pid: number; port: number | null }>
  commands?: string[]
}

export interface ActionCard {
  id: string
  title: string
  description: string
  href: string
  disabled: boolean
  disabledReason?: string
}

function actionCards(cards: readonly ActionCard[]): string {
  if (cards.length === 0) return ''
  return '<div class="actions">' + cards.map((c) => {
    const link = '<a class="actionLink" href="' + esc(c.href) + '">' + esc(c.title) + ' →</a>'
    return '<div class="actionCard">'
      + (c.disabled ? link + '<p class="muted">' + esc(c.disabledReason ?? '当前不可用。') + '</p>'
        : link + '<p class="muted">' + esc(c.description) + '</p>')
      + '</div>'
  }).join('') + '</div>'
}

/**
 * 「确认后执行」表单：放宽的是**展示层**，不是提交语义。
 *
 * 服务端直出的是 `<details open>` + 原始 `<form method="post">`（一次性 token、副作用说明、勾选项
 * 全都在表单里）：禁用 JS 时它就是今天那份可直接提交的纯 HTML。有 JS 且浏览器支持 showModal 时，
 * 客户端脚本才把 details 升级成原生 `<dialog>` —— 提交仍然 POST 到同一个 action、带同一个 token，
 * token 校验顺序（token → 安全门）在服务端一字未改。客户端校验/弹窗只算 UX，不构成任何边界。
 */
export function renderConfirmForm(options: {
  action: string
  token: string
  title: string
  consequence: string
  submitLabel: string
  danger: boolean
  checklist?: ReadonlyArray<{ name: string; label: string; description: string; checked: boolean }>
  /** 固定随表单提交的隐藏字段（如档案名）—— 表单是唯一参数载体，不依赖客户端脚本 */
  hidden?: Record<string, string>
  /** 需要密码输入时给出字段名（值只随本次 POST 传递，不进 URL、不落盘、不回显） */
  passwordField?: string
  /** 需要版本号输入时给出字段名（如重装的 --version） */
  versionField?: string
  note?: string
}): string {
  const boxes = (options.checklist ?? []).map((item) =>
    '<label class="checkRow"><input type="checkbox" name="' + esc(item.name) + '"' + (item.checked ? ' checked' : '') + '>'
    + '<span><b>' + esc(item.label) + '</b><br><span class="muted">' + esc(item.description) + '</span></span></label>',
  ).join('')
  const form = '<form class="confirmForm" method="post" action="' + esc(options.action) + '">'
    + '<input type="hidden" name="token" value="' + esc(options.token) + '">'
    + Object.entries(options.hidden ?? {}).map(([k, v]) => '<input type="hidden" name="' + esc(k) + '" value="' + esc(v) + '">').join('')
    + (options.passwordField === undefined ? ''
      : '<div class="checkRow"><label for="pw"><b>密码</b></label>'
        + '<input id="pw" class="inputText" type="password" name="' + esc(options.passwordField) + '" autocomplete="off" required></div>')
    + (options.versionField === undefined ? ''
      : '<div class="checkRow"><label for="ver"><b>目标版本</b>（缺省 latest）</label>'
        + '<input id="ver" class="inputText" type="text" name="' + esc(options.versionField) + '" value="latest" autocomplete="off"></div>')
    + (boxes === '' ? '' : '<div class="checkList">' + boxes + '</div>')
    + '<p class="consequence">' + esc(options.consequence) + '</p>'
    + (options.note === undefined ? '' : '<p class="muted">' + esc(options.note) + '</p>')
    + '<button class="' + (options.danger ? 'btnDanger' : 'btnPrimary') + '" type="submit">' + esc(options.submitLabel) + '</button>'
    + '</form>'
  return '<details class="confirmWrap" data-dcm-confirm open>'
    + '<summary class="' + (options.danger ? 'btnDanger' : 'btnPrimary') + '">' + esc(options.submitLabel) + '</summary>'
    + '<div class="confirmBody"><h3 class="confirmTitle">' + esc(options.title) + '</h3>' + form + '</div>'
    + '</details>'
}

/** 写动作结果页（完成 / 失败共用；结果如实逐条列）。 */
export function renderResultPage(
  title: string,
  /** 逐条结果：默认过 esc()（脱敏+转义）；`{ html }` 仅用于已自行转义的能力 URL 行 */
  lines: readonly Cell[],
  version: string,
  paths: RescuePaths,
  kind: 'ok' | 'bad' | 'warn' | string,
  /** 「返回上一页」在禁用 JS 时的落点（有 JS 时走 history.back()，回到列表页并由状态恢复脚本定位） */
  backHref = '/',
): string {
  const chrome: PageChrome = { version, paths, active: 'home' }
  const tone = kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'warn'
  const body = banner(tone, title, lines.length === 0 ? '（无更多信息）' : '')
    + section('逐条结果', '<ul class="resultList">' + lines.map((l) => '<li>' + cellHtml(l) + '</li>').join('') + '</ul>')
    + '<p class="backRow"><a href="' + esc(backHref) + '" data-dcm-back>← 返回上一页并恢复原位置</a>'
    + ' · <a href="/">返回首页</a> · <a href="/sessions">会话体检</a> · <a href="/disk">磁盘占用</a></p>'
  return renderLayout(chrome, body, paths.homeDir + ' · 写动作结果')
}

/** 残留锁页：展示锁状态 + 显式回收表单（活锁一律不给可点的回收理由）。 */
export function renderLockPage(
  lock: LockReport,
  version: string,
  paths: RescuePaths,
  actionToken: string,
  done: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'home' }
  const parts: string[] = []
  if (done === 'recovered') parts.push(banner('ok', '残留锁已回收', '现在可以重新尝试之前被拒绝的操作。'))
  if (!lock.present) {
    parts.push(banner('info', '当前没有残留锁', '锁目录里没有 ownership 文件：' + lock.locksDir))
    // 仍然渲染回收表单：没有锁时它**如实失败**（不谎报成功），也让界面上永远有可复制的等价命令
    parts.push(section('回收残留锁（当前没有锁，执行会被如实拒绝）', renderConfirmForm({
      action: '/lock/recover',
      token: actionToken,
      title: '回收残留的环境锁',
      consequence: '会删除残留的 ownership 文件（仅当持有者被确证不存在）。',
      submitLabel: '仍要尝试（会被拒绝）',
      danger: true,
      note: '等价命令：dsh-config-manager recover-stale-lock',
    })))
    parts.push('<p><a href="/">返回首页</a></p>')
    return renderLayout(chrome, parts.join('\n'), paths.locksDir + ' · 当前无锁')
  }
  const stale = lock.state === 'STALE_LOCK_DETECTED'
  parts.push(banner(stale ? 'warn' : 'info', '锁状态：' + lock.state,
    stale
      ? '持有进程已被确证不存在（或 ownership 是崩溃残留）：可以显式回收。'
      // banner() 的 text 走 esc() ⇒ 不放强调标记（写 markup 会被转义、写 ** 会显示星号，C1d）
      : '非残留（活锁或无法判定）：不会自动回收。'))
  parts.push(section('明细', kv([
    ['锁目录', lock.locksDir],
    ['状态', lock.state],
    ['详情', lock.detail ?? '（无）'],
  ])))
  parts.push(section('回收残留锁', renderConfirmForm({
    action: '/lock/recover',
    token: actionToken,
    title: '回收残留的环境锁',
    consequence: '会删除残留的 ownership 文件（仅当持有者被确证不存在）。UIEngine 会二次验证，验证不过就原样保留。',
    submitLabel: stale ? '回收残留锁' : '仍要尝试回收（会被拒绝）',
    danger: true,
    note: '等价命令：dsh-config-manager recover-stale-lock',
  })))
  return renderLayout(chrome, parts.join('\n'), paths.locksDir + ' · 写动作需显式确认')
}


/* ------------------------------------------------------------ 解锁 / 恢复 / 导出 / 重装（阶段 4） */

/** 解锁加密备份：只列加密容器；含「解锁并查看清单」表单。 */
export function renderUnlockPage(
  encrypted: readonly BackupFileMeta[],
  version: string,
  paths: RescuePaths,
  actionToken: string,
  done: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'unlock' }
  const parts: string[] = []
  if (done === 'ok') parts.push(banner('ok', '解锁成功', '清单已在上一步给出；明文只在内存里解出，没有落盘。'))
  parts.push(section('什么是加密容器',
    '<p>勾了「加密」导出的备份，整份 ZIP 被密码包住（DCA1 容器，文件名仍是 .zip）。'
    + '本页可以<strong>只解锁并查看内容清单</strong>：明文只在服务进程内存里解出、用完即弃，绝不写盘、也不回传文件内容。</p>'))
  if (encrypted.length === 0) {
    parts.push(banner('info', '导出目录里没有加密容器', '所有备份都是明文 ZIP，不需要解锁。'))
  }
  const rows2: Cell[][] = encrypted.map((b) => [
    { html: '<code>' + esc(b.name) + '</code>' },
    formatBytes(b.sizeBytes),
    formatIso(b.mtimeMs),
    { html: '<a href="#unlock-' + esc(verifyIdOf(b.name)) + '">解锁</a>' },
  ])
  if (rows2.length > 0) parts.push(section('加密备份（' + String(rows2.length) + '）', renderTable(['文件', '大小', '修改时间', ''], rows2)))
  for (const b of encrypted) {
    parts.push(section('解锁 ' + b.name, renderConfirmForm({
      action: '/unlock/run',
      token: actionToken,
      title: '解锁加密备份',
      // 本行经 renderConfirmForm 的 esc()：去标记（C1d，理由同上）
      consequence: '会在内存中解出明文 ZIP 并列出条目清单；不写盘、不回传内容、不自动导入。密码区分大小写，忘记无法找回。',
      submitLabel: '解锁并列出清单',
      danger: false,
      hidden: { id: verifyIdOf(b.name) },
      passwordField: 'password',
      note: '等价命令：先在 GUI 的导入向导里走「解锁加密备份」；命令行暂无解锁子命令。',
    })))
  }
  return renderLayout(chrome, parts.join('\n'), paths.exportsDir + ' · 密码只走本次请求')
}

/** 恢复：列快照；选定某快照后展示计划（零写入）与执行表单。 */
export function renderRestorePage(
  snapshots: readonly SnapshotMeta[],
  plan: RestorePlanView | null,
  version: string,
  paths: RescuePaths,
  actionToken: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'restore' }
  const parts: string[] = []
  parts.push(banner('warn', '恢复是危险动作',
    '它会覆盖 $DSH_HOME 下的文件、删除导入后新增的文件、并卸载插件。执行前三道门必须通过（SAFE MODE 未激活 / 无残留锁 / DSH 已停止）；每次覆盖前 core 会把当前文件复制到 <快照>/pre-restore/，可人工反悔。'))
  const rows2: Cell[][] = snapshots.map((s) => [
    { html: '<code>' + esc(s.id) + '</code>' },
    s.createdAt,
    s.status ?? 'unknown',
    String(s.entryCount),
    { html: '<a href="/restore?id=' + encodeURIComponent(s.id) + '">看计划</a>' },
  ])
  parts.push(section('快照（' + String(snapshots.length) + '）',
    snapshots.length === 0
      ? '<p class="muted">没有快照。快照是导入前自动留下的「撤回点」。</p>'
      : renderTable(['ID', '创建时间', '状态', '条目数', ''], rows2)))
  if (plan !== null) {
    if (!plan.ok) {
      parts.push(banner('bad', '无法生成恢复计划', plan.message))
    } else {
      const dangerous = (plan.actions ?? []).filter((action) => action.dangerous)
      const summary = plan.summary ?? {}
      const baselineLabel = plan.pluginBaselineConfirmed === true
        ? '已确认（会卸载导入期新增的插件）'
        : '缺失（不计划插件卸载）'
      const planRows: Cell[][] = (plan.actions ?? []).map((action) => [
        action.dangerous ? '⚠ ' + action.kind : action.kind,
        action.target ?? action.manualHint ?? '—',
        action.detail ?? '',
      ])
      parts.push(section('恢复计划（' + plan.snapshotId + '，尚未改动任何文件）',
        '<p>整文件还原 ' + String(summary['hostFileRestores'] ?? 0)
        + ' · 整文件删除 ' + String(summary['hostFileRemoves'] ?? 0)
        + ' · 插件卸载 ' + String(summary['pluginRemoves'] ?? 0)
        + ' · 文件还原 ' + String(summary['fileRestores'] ?? 0)
        + ' · 文件删除 ' + String(summary['fileRemoves'] ?? 0)
        + ' · 凭据提示 ' + String(summary['credentialHints'] ?? 0)
        + ' · 跳过 ' + String(summary['skips'] ?? 0) + '</p>'
        + '<p class="muted">插件基线：' + baselineLabel + '</p>'
        + renderTable(['动作', '目标', '说明'], planRows)))
      if (dangerous.length === 0) {
        parts.push(banner('info', '这份计划没有会改动磁盘的动作', '无需执行。'))
      } else {
        parts.push(section('执行恢复（会改动 ' + String(dangerous.length) + ' 项）', renderConfirmForm({
          action: '/restore/run',
          token: actionToken,
          title: '执行快照恢复',
          consequence: '按上面的计划覆盖/删除文件并卸载插件；覆盖前会把当前文件复制到 <快照>/pre-restore/。DSH 未停止或有残留锁/SAFE MODE 时会被拒绝（不会执行一半）。',
          submitLabel: '执行恢复（' + String(dangerous.length) + ' 项）',
          danger: true,
          hidden: { id: plan.snapshotId ?? '' },
          note: '等价命令：dsh-config-manager restore --id <快照 id>',
        })))
      }
    }
  }
  return renderLayout(chrome, parts.join('\n'), paths.snapshotsDir + ' · 计划零写入')
}

/** 离线导出：分区勾选（只列离线可读的文件类分区）+ 不可收集分区如实列出。 */
export function renderExportPage(
  sections: readonly string[],
  unavailable: readonly string[],
  version: string,
  paths: RescuePaths,
  actionToken: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'export' }
  const checklist = sections.map((id) => ({
    name: 'section:' + id,
    label: id,
    description: '该分区的文件类内容（凭据类文件永不进备份）',
    checked: true,
  }))
  // C1d：banner 的 text 走 esc() —— 写 markup 会被转义成字面标签、写 ** 会渲染成字面星号，
  // 所以这两种强调标记都不能用，只能去标记（与 :544 / :685 / :918 同一口径）。
  const body = banner('info', '只导出离线能读到的分区',
    'DSH 没在跑时，settings / providers / mcp 等结构化分区的值必须经 DSH 服务读取，因此不在归档里。'
    + '宁可如实少导，也不给一个「声称含设置、实际为空」的假备份。')
    + '<p class="muted">离线不可收集：' + unavailable.map((id) => '<code>' + esc(id) + '</code>').join('、') + '</p>'
    + renderConfirmForm({
      action: '/export/run',
      token: actionToken,
      title: '生成离线备份',
      consequence: '在导出目录里生成与 GUI 同结构的 ZIP（manifest + checksums + 分区目录），落盘后立即自检；命名自动去重，绝不覆盖既有文件。',
      submitLabel: '导出并自检',
      danger: false,
      checklist,
      note: '等价命令：dsh-config-manager backup --sections <a,b,c>',
    })
  return renderLayout(chrome, section('离线导出', body), paths.exportsDir)
}

/** 重装：计划 + 终端确认码。 */
export function renderReinstallPage(
  items: ReadonlyArray<{ id: string; label: string; desc: string; destructive: boolean; defaultOn: boolean }>,
  version: string,
  paths: RescuePaths,
  actionToken: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'reinstall' }
  const checklist = items.map((it) => ({
    name: 'item:' + it.id,
    label: it.label,
    description: it.desc,
    checked: it.defaultOn,
  }))
  const body = banner('bad', '这是本页最危险的动作',
    '它会卸载全局 @deepseek-ai/dsh 再重装（程序步），勾选数据类还会清空 ~/.dsh 的设置 / 插件 / 会话与凭据。'
    // banner() 的 text 走 esc() ⇒ 去标记（C1d）
    + '执行需要输入只在终端里打印的 6 位确认码 —— 页面里看不到它。')
    + renderConfirmForm({
      action: '/reinstall/plan',
      token: actionToken,
      title: '第一步：生成计划（零执行）',
      consequence: '先看会跑哪些命令、目标版本、当前已装版本；这一步不执行任何东西。',
      submitLabel: '生成计划',
      danger: false,
      checklist,
      versionField: 'version',
      note: '等价命令：dsh-config-manager reinstall --dry-run',
    })
  return renderLayout(chrome, section('重装 DSH', body), paths.homeDir + ' · 需终端确认码')
}
/* ------------------------------------------------------------ 备份自检 */

export function renderVerifyPage(
  result: BackupVerifyResult,
  version: string,
  paths: RescuePaths,
): string {
  const chrome: PageChrome = { version, paths, active: 'home' }
  const ok = result.verdict === 'OK'
  const parts: string[] = []
  parts.push(ok
    ? banner('ok', '自检通过', result.file)
    : banner('bad', '自检未通过：' + result.verdict, result.file + ' —— 不要用它做恢复。'))
  parts.push(section('结果', kv([
    ['文件', result.file],
    ['判定', result.verdict],
    ['体积', result.sizeBytes === undefined ? '—' : formatBytes(result.sizeBytes)],
    ['条目数', result.entryCount === undefined ? '—' : String(result.entryCount)],
  ])
    + (result.errors.length === 0 ? '' : '<h2>错误</h2><ul>' + result.errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>')
    + (result.warnings.length === 0 ? '' : '<h2>告警</h2><ul>' + result.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>')))
  parts.push('<p><a href="/">返回首页</a></p>')
  return renderLayout(chrome, parts.join('\n'), paths.exportsDir + ' · 只读')
}

/* ------------------------------------------------------------ 档案与实例（阶段 3） */

/** 档案页：列表 + 启停表单（每个可启动档案一张卡；不可启动的写明原因）。 */
export function renderProfilesPage(
  outcome: ProfilesOutcome,
  version: string,
  paths: RescuePaths,
  actionToken: string,
  done: string,
  result: string,
): string {
  const chrome: PageChrome = { version, paths, active: 'profiles' }
  const parts: string[] = []
  if (done === 'started' || done === 'stopped') {
    parts.push(banner(result.startsWith('ok:') ? 'ok' : 'bad',
      done === 'started' ? '启动结果' : '停止结果', result.replace(/^(ok|bad):/, '')))
  }
  for (const error of outcome.errors) parts.push(banner('bad', '有一项读不出来', error))
  parts.push(section('档案目录', '<p><code>' + esc(outcome.profilesDir) + '</code></p>'
    + '<p class="muted">档案 = DSH 的 profile（dsh --profile 名）。启动会在后台拉起一个独立实例并在就绪后给出带 token 的 URL；'
    + '停止会先请它自己退出，超时才强杀。桌面端独占的 desktop 档案一律不可启动。</p>'))
  const rows: Cell[][] = outcome.rows.map((row) => [
    { html: '<code>' + esc(row.name) + '</code>' },
    row.shape,
    String(row.bundles) + ' 层 / ' + String(row.dependencies) + ' 依赖',
    row.hasNodeModules ? '已装' : '未装',
    row.running
      ? (row.owned ? '运行中（本插件启动）' : '运行中（外部实例）') + (row.port === null ? '' : ' · :' + String(row.port))
      : '未运行',
    // 能力 URL：必须原样（含 token）—— 过 esc() 会被 redact 抹掉，链接点开必然 401（cli-F1）
    { html: row.url === null ? '—' : '<a href="' + escCapability(row.url) + '">打开实例</a>' },
  ])
  parts.push(section('本机档案（' + String(outcome.rows.length) + '）',
    renderTable(['档案', '形态', '构成', '依赖', '实例状态', '入口'], rows)))
  if (outcome.rows.length === 0) {
    parts.push(banner('info', '本机还没有任何档案', 'DSH 首次启动时会按模板建一个；这里没什么可启停的。'))
  }
  for (const row of outcome.rows) {
    if (row.launchable) {
      parts.push(section('启动 ' + row.name, renderConfirmForm({
        action: '/profiles/launch',
        token: actionToken,
        title: '启动档案 ' + row.name,
        consequence: '会在后台拉起一个独立的 DSH 实例（自动挑空闲端口），就绪后给出带 token 的认证 URL。它独立于当前任何实例；要关掉它请回本页点「停止」。',
        submitLabel: '启动实例',
        danger: false,
        hidden: { name: row.name },
        note: '等价命令：dsh --profile ' + row.name,
      })))
    } else if (row.running) {
      parts.push(section('停止 ' + row.name, renderConfirmForm({
        action: '/profiles/stop',
        token: actionToken,
        title: '停止档案 ' + row.name + ' 的实例',
        consequence: '会先请该实例自己退出，超时后强制结束进程树；它未保存的会话可能丢失。',
        submitLabel: '停止实例',
        danger: true,
        hidden: { name: row.name },
        note: row.owned ? '该实例由本插件启动（台账可查）。' : '该实例不是本插件启动的（手动或别的实例管理），按心跳 pid 停止。',
      })))
    } else {
      parts.push(section('启动 ' + row.name + '（不可用）',
        '<p class="muted">' + esc(row.launchBlockedReason ?? '当前不可启动。') + '</p>'))
    }
  }
  return renderLayout(chrome, parts.join('\n'), paths.homeDir + ' · 写动作需显式确认')
}
