
/**
 * client-F6 回归：拼接类中文标点不得硬编码。
 *
 * 背景（t2 审计 client-F6）：英文界面下会出现「…（3）」「A、B」这类全角标点 —— 因为拼接符
 * 写在代码里而不是字典里。修法 = 标点进字典（locales.ts 的 common.parens / common.listSeparator），
 * 组件用 t() 取。本守卫按渲染点钉住：删掉字典键或改回硬编码标点 → 红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('F6：locales/common.ts 必须提供 common.parens / common.listSeparator（zh+en 各一条）', () => {
  // tech-debt #22：字典按域拆分后 common.* 落在 locales/common.ts（聚合器只做展开）
  const src = read('src/client/locales/common.ts')
  for (const key of ['common.parens', 'common.listSeparator']) {
    const hits = [...src.matchAll(new RegExp("'" + key.replace('.', '\\.') + "':", 'g'))]
    assert.equal(hits.length, 2, key + ' 必须在 zh/en 字典里各有一条（实际 ' + hits.length + '）')
  }
  assert.match(src, /'common\.parens': '（\{text\}）'/, 'zh 侧必须带占位符（拼接点进字典）')
  assert.match(src, /'common\.parens': '\(\{text\}\)'/, 'en 侧必须用半角括号')
})

interface Site {
  id: string
  file: string
  forbidden: RegExp
  required: RegExp
  why: string
}

const SITES: Site[] = [
  {
    id: 'restore-plan-detail',
    file: 'src/client/library/RestorePlanView.tsx',
    forbidden: /（\{redact\(row\.detail\)\}）/,
    required: /t\('common\.parens', \{ text: redact\(row\.detail\) \}\)/,
    why: '恢复计划行明细括号',
  },
  {
    id: 'library-report-line',
    file: 'src/client/library/LibraryActions.tsx',
    forbidden: /\{title}（\{items\.length\}）/,
    required: /t\('common\.parens', \{ text: String\(items\.length\) \}\)/,
    why: '报告分组标题的计数括号',
  },
  {
    id: 'profiles-patch-entries',
    file: 'src/client/environment/EnvironmentPanel.tsx',
    forbidden: /（\{formatBytes\(detail\.patchBytes\)\}）/,
    required: /t\('common\.parens', \{ text: formatBytes\(detail\.patchBytes\) \}\)/,
    why: '档案 patch 条目的字节数括号',
  },
  {
    id: 'export-device-list',
    file: 'src/client/export/ExportView.tsx',
    forbidden: /\.join\('、'\)/,
    required: /\.join\(t\('common\.listSeparator'\)\)/,
    why: '设备相关分区名单的分隔符（顿号）',
  },
]

test('F6：已登记的拼接点必须走字典，不得再出现硬编码全角标点', () => {
  for (const s of SITES) {
    const src = read(s.file)
    assert.doesNotMatch(src, s.forbidden, '[' + s.id + '] ' + s.file + ' 仍存在硬编码标点（' + s.why + '）')
    assert.match(src, s.required, '[' + s.id + '] ' + s.file + ' 必须用字典键取标点')
  }
})
