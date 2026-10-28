#!/usr/bin/env node
/**
 * 文档路径守卫（P1，2026-10-22 审计后新增）
 *
 * 为什么存在：审计发现活文档里存在指向已删除文件的「反引号路径」，读者与 agent 按图索骥会失败。
 * 只校验**活文档**；历史归档与证据库故意不校验：
 *   - 排除：docs/design（历史设计稿）、docs/lessons（证据可能引用已删文件）、
 *           docs/lessons/known-pitfalls.md（冻结存档）、CHANGELOG.md（历史记录）
 *
 * 契约：
 *   - 校验对象 = 反引号内的仓库相对路径 + 相对 Markdown 链接
 *   - 路径相对**仓库根**解析（本仓库文档约定），不是相对文档所在目录
 *   - 允许 path:12 / path:12-34 行号后缀、#anchor、./ 前缀
 *   - 无法判定为路径的片段（含空格/通配符/URL/<占位符>/纯标识符）一律跳过，避免误报
 *   - 退出码：0 = 全部存在；1 = 有失效路径（逐条打印 file:line 与目标）
 *
 * 二、活跃文档索引收录（2026-10-23 批准新增）
 * 为什么存在：新增 md 忘记回 docs/index.md 加行，导致文档事实上不可达；此前只靠人工。
 * 覆盖面**只**是正式长期维护的五目录（docs/spec、docs/modules、docs/maintenance、docs/decisions、docs/components），
 * 不扩大到 lessons（用裸文件名收录）、docs/design（历史区）与 docs/lessons/known-pitfalls.md（冻结存档）。
 * 收录判定 = **索引条目行**（表格行 / 列表项）出现该文件的全路径（反引号或相对链接）；正文顺带提到不算。
 * 判定逻辑抽在 scripts/doc-index-coverage.mjs（单测 tests/doc-index-coverage.test.ts），脚本不重复实现。
 * 豁免表 INDEX_COVERAGE_EXEMPT 当前为空；加条目必须写理由（= 公开承认这份文档故意不进索引）。
 *
 * 用法：node scripts/check-doc-paths.mjs [--report]
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { INDEX_COVERAGE_DIRS, collectIndexCoverage } from './doc-index-coverage.mjs'

const ROOT = process.cwd()
const ROOT_FILES = ['AGENTS.md', 'DESIGN.md', 'DEVELOPERS.md', 'README.md', 'README.zh-CN.md', 'SECURITY.md']
const DOC_DIRS = INDEX_COVERAGE_DIRS // 单份清单，见 scripts/doc-index-coverage.mjs
const DOC_FILES = ['docs/index.md', 'docs/modules/architecture.md']
const PATH_ROOTS = ['src/', 'tests/', 'scripts/', 'docs/', 'locale/', '.github/', '.dsh/']
// 代码类引用（组件/测试/样式）允许写成相对某源码目录的简写；
// 其余扩展名必须带仓库根前缀，避免把 bundle 内产物路径（config/settings.json）误判为仓库文件。
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|css)$/i
// bundle / 运行时数据命名空间：这些是**产物内路径**，不是仓库路径
const ARTIFACT_PREFIXES = ['config/', 'integrity/', 'custom/', 'workspaces/', 'ai/', 'plugins/', 'mcp/', 'security/',
  'keybindings/', 'storages/', 'sync/', 'skills/', 'blobs', 'node_modules/', 'lib/', 'dist/']
const FILE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|yml|yaml|toml|ps1|sh|py|zip|svg|png|txt|html)$/i

// 文档里大量路径是「相对某个源码目录的简写」（如 `run-store.ts` 指 src/client/run-store.ts）。
// 逐个 base 试解析：命中任一即算存在。这是**文档卫生**守卫，不追求证明链接语义正确。
const BASES = ['', 'src', 'src/client', 'src/client/common', 'src/core', 'src/routes', 'src/sync',
  'src/ui', 'src/utils', 'src/security', 'src/adapters', 'src/cli', 'tests', 'scripts',
  '.github', '.github/workflows', 'docs']

function walkMd(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMd(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

// 仓库文件索引：文档里常见「相对某源码目录的简写」（run-store.ts、common/ui.tsx）。
// 判定 = 根相对精确命中，或仓库内存在**同尾路径**；已删除文件不会命中，这正是要抓的漂移。
const REPO_FILES = []
function walkRepo(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    // outputs/ 与 .tmp/ 是本地夹具与暂存（未进 git）：纳入索引会让守卫在本地假绿、CI 真红。
    if (name === 'node_modules' || name === '.git' || name === '.tmp' || name === 'outputs' || name === 'lib' || name === 'dist') continue
    const full = join(dir, name)
    const st = lstatSync(full) // 可能有断链符号链接，不能跟随
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walkRepo(full)
    else REPO_FILES.push(full.slice(ROOT.length + 1).split(sep).join('/'))
  }
}
walkRepo(ROOT)
const FILE_SET = new Set(REPO_FILES)
function existsRepo(p) {
  if (p.endsWith('/')) return existsSync(join(ROOT, p)) // 目录引用（docs/spec/ 之类）
  if (FILE_SET.has(p)) return true
  const needle = '/' + p
  return REPO_FILES.some((it) => it.endsWith(needle))
}

const targets = []
for (const f of ROOT_FILES) if (existsSync(join(ROOT, f))) targets.push(f)
for (const f of DOC_FILES) if (existsSync(join(ROOT, f))) targets.push(f)
for (const d of DOC_DIRS) {
  for (const f of walkMd(join(ROOT, d))) targets.push(f.slice(ROOT.length + 1).split(sep).join('/'))
}

/** 把片段归一成候选仓库路径；不像路径就返回 null。 */
function candidate(raw) {
  let p = raw.trim().replace(/^<|>$/g, '')
  if (!p || /^(https?:|mailto:|tel:|#)/i.test(p)) return null
  if (/^(~|@|\.\.\.|…)/.test(p)) return null
  if (/[\s*?|<>$\x60{}\\]/.test(p)) return null
  p = p.replace(/#.*$/, '').replace(/^(\.\/)+/, '').replace(/:\d[\d,]*(?:-\d+)?\+?$/, '')
  if (!p || p.startsWith('/') || p.startsWith('..')) return null
  if (p.startsWith('.') || /^\.[a-z]+$/i.test(p)) return null // 隐藏文件 / 裸扩展名（如 .ts）不是路径引用
  if (ARTIFACT_PREFIXES.some((a) => p.startsWith(a))) return null
  if (p.includes('/lib/') || p.includes('/node_modules/')) return null // 宿主/构建产物内部路径
  // 裸 .js 文件名通常是 bundle 产物（client.js），不是仓库源码引用
  if (!p.includes('/') && /\.(js|mjs|cjs)$/i.test(p)) return null
  const underRoot = PATH_ROOTS.some((r) => p.startsWith(r))
  if (!underRoot && !CODE_EXT.test(p)) return null
  return p
}

function collect(line) {
  const found = []
  for (const m of line.matchAll(/\x60([^\x60\n]+)\x60/g)) found.push(m[1])
  for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) found.push(m[1])
  return found
}

// docs/maintenance/known-gaps.md 是**历史缺陷台账**（记录各版本基线下的代码形状），
// 与 CHANGELOG 同类：引用当时存在的文件是职责，不是失修。故不校验。
const living = targets.filter((rel) => rel !== 'docs/maintenance/known-gaps.md')
const misses = []
let checked = 0
for (const rel of living) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('doc-path-ignore')) continue // 反例/示意路径按需豁免（行内标记）
    const docDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    for (const raw of collect(lines[i])) {
      const p = candidate(raw)
      if (p === null) continue
      checked += 1
      const hit = existsSync(join(ROOT, docDir, p)) || existsRepo(p)
      if (!hit) misses.push({ file: rel, line: i + 1, path: p })
    }
  }
}

const reportOnly = process.argv.includes('--report')
console.log('[doc-paths] scanned=' + living.length + ' refs=' + checked + ' missing=' + misses.length)
for (const m of misses) console.log('  x ' + m.file + ':' + m.line + '  ->  ' + m.path)

// ---------------- 活跃文档索引收录 ----------------
// 只查正式长期维护的五目录；见文件头「二」的边界说明。
const indexMd = readFileSync(join(ROOT, 'docs/index.md'), 'utf8')
const coverage = collectIndexCoverage({ root: ROOT, indexText: indexMd })
const unlisted = coverage.unlisted
console.log('[doc-index] living=' + coverage.living.length + ' unlisted=' + unlisted.length)
for (const p of unlisted) console.log('  x 未在 docs/index.md 收录: ' + p)

if ((misses.length > 0 || unlisted.length > 0) && !reportOnly) {
  if (misses.length > 0) {
    console.error('[doc-paths] FAIL: 修正上述路径，或把纯历史文档移出校验范围（见脚本头注释）。')
  }
  if (unlisted.length > 0) {
    console.error('[doc-index] FAIL: 给每份活跃文档在 docs/index.md 加一行明确路径（或用豁免表并写理由）。')
  }
  process.exit(1)
}
