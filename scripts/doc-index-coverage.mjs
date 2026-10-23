// 「活跃文档是否被 docs/index.md 收录」的纯判定逻辑（零依赖）。
// 单独成模块只为可测：脚本与 tests/doc-index-coverage.test.ts 共用这一份实现，测试不复制正则。
// 边界（2026-10-23 批准）：只覆盖正式长期维护的五目录；lessons（裸文件名收录）、design/handoff/seo、
// docs/known-pitfalls.md 都不在范围内。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

export const INDEX_COVERAGE_DIRS = ['docs/spec', 'docs/modules', 'docs/maintenance', 'docs/decisions', 'docs/components']

/** 路径 -> 理由。加条目 = 公开承认这份文档故意不进索引；当前为空。 */
export const INDEX_COVERAGE_EXEMPT = new Map()

/** 递归收集 markdown 文件（不动 node_modules / .git）。 */
export function walkMarkdown(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMarkdown(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * 是否以「索引条目」形式收录：反引号路径或相对链接，且该路径出现在 **表格行或列表项**上。
 * 只写正文提到路径（如「详见 `docs/spec/x.md`」）不算收录。
 */
export function isIndexed(indexText, rel) {
  const needles = ['`' + rel + '`', '](' + rel + ')', '](<' + rel + '>)']
  return String(indexText)
    .split(/\r?\n/)
    .some((line) => {
      const isEntry = /^\s*\|/.test(line) || /^\s*[-*]\s/.test(line)
      return isEntry && needles.some((n) => line.includes(n))
    })
}

/** 统计五目录下每份 md 是否被索引收录。root 需为绝对路径。 */
export function collectIndexCoverage({ root, indexText, docDirs = INDEX_COVERAGE_DIRS, exempt = INDEX_COVERAGE_EXEMPT }) {
  const base = String(root).replace(/[\\/]+$/, '') // 容忍结尾分隔符（fileURLToPath 会带）
  const living = []
  const unlisted = []
  const exempted = []
  for (const dir of docDirs) {
    for (const file of walkMarkdown(join(base, dir))) {
      const rel = file.slice(base.length + 1).split(sep).join('/')
      living.push(rel)
      if (exempt.has(rel)) {
        exempted.push(rel)
        continue
      }
      if (!isIndexed(indexText, rel)) unlisted.push(rel)
    }
  }
  return { living, unlisted, exempted }
}
