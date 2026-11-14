import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { dictKeys, makeT } from '../lib/i18n.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const libDir = join(root, 'lib')
const sources = readdirSync(libDir).filter((f) => f.endsWith('.js'))

test('zh 与 en 键集合完全一致（en 逐键补齐）', () => {
  const zh = dictKeys('zh').sort()
  const en = dictKeys('en').sort()
  assert.deepEqual(zh, en)
})

test('源码里用到的每个键都在字典里', () => {
  const known = new Set(dictKeys('zh'))
  const missing = []
  // i18n.js 自己既是字典又含 replace 回调里的 `'key'` 片段，不参与「用到的键」扫描。
  for (const file of sources.filter((f) => f !== 'i18n.js')) {
    const text = readFileSync(join(libDir, file), 'utf8')
    for (const m of text.matchAll(/\b(?:t0?|words)\(\s*'([a-zA-Z][\w.-]*)'/g)) {
      if (!known.has(m[1])) missing.push(`${file}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('字典里没有死键（每个键至少在源码里被引用一次）', () => {
  const corpus = sources
    .filter((file) => file !== 'i18n.js')
    .map((file) => readFileSync(join(libDir, file), 'utf8'))
    .join('\n')
  // 键可能以字面量出现在别处（如 hub.js 的错误键），不只出现在 t() 的第一个参数里。
  const dead = dictKeys('zh').filter((key) => !corpus.includes(`'${key}'`) && !key.startsWith('err.'))
  assert.deepEqual(dead, [])
})

/** 去掉注释（按引号状态判定），用于「界面文案不许硬编码中文」的静态守卫。 */
function stripComments(text) {
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

test('界面代码里不硬编码中文（文案全在 i18n.js）', () => {
  const offenders = []
  // redact.js 是宿主 src/security/redaction.ts 的同语义副本（注释随原文），不是界面代码。
  const SKIP = new Set(['i18n.js', 'redact.js'])
  for (const file of sources) {
    if (SKIP.has(file)) continue
    const code = stripComments(readFileSync(join(libDir, file), 'utf8'))
    if (/[\u4e00-\u9fff]/.test(code)) offenders.push(file)
  }
  assert.deepEqual(offenders, [])
})

test('缺键回退到 zh，占位符按名替换', () => {
  const t = makeT('en-US')
  assert.equal(t('flow.done', { ok: 3, skip: 1, fail: 0 }), 'Import finished: 3 written, 1 skipped, 0 failed.')
  assert.equal(t('does.not.exist'), 'does.not.exist')
  assert.equal(makeT('zh-CN')('flow.done', { ok: 1, skip: 0, fail: 2 }), '导入完成：写入 1 项，跳过 0 项，失败 2 项。')
})
