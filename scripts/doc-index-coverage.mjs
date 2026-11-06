// 「活跃文档是否被索引收录」的纯判定逻辑（零依赖）。
// 单独成模块只为可测：脚本与 tests/doc-index-coverage.test.ts 共用这一份实现，测试不复制正则。
// 两跳模型（2026-11-06 文档重建）：docs/index.md → 分区 README → 分区内每份文档。
//   - collectIndexCoverage：每个分区的 README.md 是否在 docs/index.md 里以「条目行」出现；
//   - collectPartitionCoverage：分区内每份 md 的文件名（裸名）是否在该分区 README.md 的条目行出现。
// 不收进检查的范围：docs/overview.md（单份参考材料，由 index.md 直连）、docs/archive/（只读冻结，正文不许再改）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/** 八个分区（顺序即 docs/index.md 分区表顺序）。 */
export const PARTITIONS = [
  'docs/architecture',
  'docs/contracts',
  'docs/adr',
  'docs/known-issues',
  'docs/evidence',
  'docs/contributing',
  'docs/archive',
  'docs/agents',
]

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
 * 是否以「索引条目」形式收录：needle 出现在 **表格行或列表项** 上。
 * needle 可以是完整仓库相对路径（index.md 用），也可以是裸文件名（分区 README 用）。
 * 只写正文提到（如「详见 …」）不算收录。
 */
export function isIndexed(indexText, needle) {
  const needles = ['`' + needle + '`', '](' + needle + ')', '](<' + needle + '>)']
  return String(indexText)
    .split(/\r?\n/)
    .some((line) => {
      const isEntry = /^\s*\|/.test(line) || /^\s*[-*]\s/.test(line)
      return isEntry && needles.some((n) => line.includes(n))
    })
}

const relOf = (base, file) => file.slice(base.length + 1).split(sep).join('/')

/** 每个分区的 README.md 是否在 indexText（docs/index.md）里以条目行出现。root 需为绝对路径。 */
export function collectIndexCoverage({ root, indexText, partitions = PARTITIONS }) {
  const base = String(root).replace(/[\\/]+$/, '')
  const living = []
  const unlisted = []
  for (const dir of partitions) {
    const file = join(base, dir, 'README.md')
    if (!existsSync(file)) continue
    const rel = relOf(base, file)
    living.push(rel)
    if (!isIndexed(indexText, rel)) unlisted.push(rel)
  }
  return { living, unlisted }
}

/** 分区内每份 md（除 README.md）是否在该分区 README.md 里以条目行出现。root 需为绝对路径。 */
export function collectPartitionCoverage({ root, partitions = PARTITIONS }) {
  const base = String(root).replace(/[\\/]+$/, '')
  const living = []
  const unlisted = []
  const missingIndex = []
  for (const dir of partitions) {
    const indexFile = join(base, dir, 'README.md')
    if (!existsSync(indexFile)) {
      missingIndex.push(dir + '/README.md')
      continue
    }
    const indexText = readFileSync(indexFile, 'utf8')
    for (const file of walkMarkdown(join(base, dir))) {
      const rel = relOf(base, file)
      if (rel.endsWith('/README.md')) continue
      living.push(rel)
      if (!isIndexed(indexText, rel.slice(rel.lastIndexOf('/') + 1))) unlisted.push(rel)
    }
  }
  return { living, unlisted, missingIndex }
}
