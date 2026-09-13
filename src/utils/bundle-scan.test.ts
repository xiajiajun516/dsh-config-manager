/**
 * bundle-scan 单测：注释剥离 + require 抽取 + 白名单判定。
 *
 * 核心回归点：**注释里的 `require("lucide-react")` 不得被判成违规**（历史假阳性坑），
 * 而真实的字面量 require 必须被抓出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIENT_BUNDLE_RUNTIME_WHITELIST,
  extractRequireHits,
  scanBundleRequires,
  stripJsComments,
} from './bundle-scan.ts'

test('stripJsComments: 行注释被剥离且保留换行（行号不漂移）', () => {
  const src = ['// require("lucide-react")', 'const a = 1', 'require("react")'].join('\n')
  const out = stripJsComments(src)
  assert.ok(!out.includes('lucide-react'), '行注释内容应被剥离')
  assert.equal(out.split('\n').length, 3, '换行必须保留')
  assert.ok(out.includes('require("react")'))
})

test('stripJsComments: 块注释被剥离但保留内部换行', () => {
  const src = '/* require("lucide-react")\n   more */\nrequire("react-dom")'
  const out = stripJsComments(src)
  assert.ok(!out.includes('lucide-react'))
  assert.equal(out.split('\n').length, 3)
  assert.ok(out.includes('require("react-dom")'))
})

test('stripJsComments: 字符串里的注释标记不被误剥离', () => {
  const src = 'const a = "// not a comment"; const b = "/* nope */";'
  const out = stripJsComments(src)
  assert.equal(out, src, '字符串内容必须原样保留')
})

test('stripJsComments: 转义引号不会提前结束字符串', () => {
  const src = String.raw`const a = "he said \"hi\" // still string"; require("react")`
  const out = stripJsComments(src)
  assert.ok(out.includes('require("react")'))
  assert.ok(out.includes('still string'), '字符串未被吃掉')
})

test('stripJsComments: 模板字面量内插值中的注释标记按内容处理', () => {
  const src = 'const t = `a // b`; require("react")'
  const out = stripJsComments(src)
  assert.ok(out.includes('a // b'), '模板字面量内容保留')
  assert.ok(out.includes('require("react")'))
})

test('stripJsComments: 模板插值闭合后回到模板态（真实回归）', () => {
  // 真实回归：`${a}` 的 `}` 未回到模板态 → state 永久停在 code → 后续注释里的反引号
  // 被当成模板字面量开头，注释内容被当作代码保留，`require("node:https")` 假阳性。
  const src = [
    'const a = `${x}`;',
    'const b = `plain // text`;',
    '/** doc mentioning `require("node:https")` inline */',
    'var c = require("react");',
  ].join('\n')
  const out = stripJsComments(src)
  assert.ok(!out.includes('node:https'), '模板插值后的块注释仍必须被剥离')
  assert.ok(out.includes('plain // text'), '模板字面量内容保留')
  assert.ok(out.includes('require("react")'))
})

test('stripJsComments: 插值内的对象字面量不会提前关闭插值', () => {
  const src = 'const a = `${f({ k: 1 })}`; /* require("lucide-react") */ var b = 1;'
  const out = stripJsComments(src)
  assert.ok(out.includes('${f({ k: 1 })}'), '嵌套花括号必须原样保留')
  assert.ok(!out.includes('lucide-react'), '插值后的块注释被剥离')
})

test('stripJsComments: 嵌套模板字面量', () => {
  const src = 'const a = `x${`y${z}`}w`; /* require("lucide-react") */ var b = 1;'
  const out = stripJsComments(src)
  assert.ok(!out.includes('lucide-react'))
  assert.ok(out.includes('`x${`y${z}`}w`'), '嵌套模板原样保留')
})

test('stripJsComments: opaque 模式把反引号当普通文本', () => {
  const src = 'const a = `tpl`; /* require("lucide-react") */ var b = 1;'
  const out = stripJsComments(src, false)
  assert.ok(!out.includes('lucide-react'), 'opaque 模式下块注释仍被剥离')
  assert.ok(out.includes('`tpl`'), '反引号原样保留')
})

test('extractRequireHits: 抽取字面量并给出行号', () => {
  const code = ['var x = 1', 'require("react")', 'require("react-dom")'].join('\n')
  const hits = extractRequireHits(code)
  assert.deepEqual(hits.map((h) => h.specifier), ['react', 'react-dom'])
  assert.deepEqual(hits.map((h) => h.line), [2, 3])
  assert.ok(hits.every((h) => !h.dynamic))
})

test('extractRequireHits: 动态 require 被标记为 dynamic', () => {
  const hits = extractRequireHits('require(name)')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.dynamic, true)
})

test('scanBundleRequires: 注释中的 lucide-react 不算违规（假阳性回归）', () => {
  const src = [
    '/* bundled deps: require("lucide-react"), require("@radix-ui/react-dialog") */',
    '// require("lucide-react")',
    'var a = require("react");',
  ].join('\n')
  const result = scanBundleRequires(src)
  assert.deepEqual(result.specifiers, ['react'])
  assert.deepEqual(result.violations, [])
})

test('scanBundleRequires: 真实的外部 require 会被判违规', () => {
  const src = 'var a = require("react"); var b = require("lucide-react");'
  const result = scanBundleRequires(src)
  assert.deepEqual(result.specifiers, ['lucide-react', 'react'])
  assert.deepEqual(result.violations, ['lucide-react'])
})

test('scanBundleRequires: 白名单覆盖四个运行时依赖', () => {
  assert.deepEqual(
    [...CLIENT_BUNDLE_RUNTIME_WHITELIST].sort(),
    ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  )
})

test('scanBundleRequires: 报告动态 require 且不把它当作字面量违规', () => {
  const src = 'require("react"); require(moduleName);'
  const result = scanBundleRequires(src)
  assert.deepEqual(result.violations, [])
  assert.equal(result.dynamicHits.length, 1)
})

test('scanBundleRequires: node:* 内置说明符放行但单独上报', () => {
  const src = 'require("react"); require("node:https");'
  const result = scanBundleRequires(src)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.nodeBuiltins, ['node:https'])
})

test('scanBundleRequires: 双模式结果一致时 passesAgree=true', () => {
  const src = 'var a = require("react"); /* require("lucide-react") */'
  const result = scanBundleRequires(src)
  assert.equal(result.passesAgree, true)
  assert.deepEqual(result.specifiers, ['react'])
})

test('scanBundleRequires: 默认四趟并集且对良构输入一致', () => {
  // 四趟的用途是「任一趟失衡也不漏报」（取并集）。对良构输入，四趟必然一致——
  // 真实 bundle 上的一致性由 src/client/bundle-selfcontained.test.ts 断言。
  const src = [
    'var t = `a ${x} b`;',
    '/* require("lucide-react") */',
    'var c = require("react");',
  ].join('\n')
  const result = scanBundleRequires(src)
  assert.deepEqual(
    result.passes.map((p) => p.id),
    ['tpl+str', 'opaque-tpl', 'opaque-str', 'opaque-both'],
  )
  assert.equal(result.passesAgree, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.specifiers, ['react'])
})

test('scanBundleRequires: 默认配置为四趟并集', () => {
  const src = 'var a = require("react");'
  const result = scanBundleRequires(src)
  assert.deepEqual(
    result.passes.map((p) => p.id),
    ['tpl+str', 'opaque-tpl', 'opaque-str', 'opaque-both'],
  )
  assert.deepEqual(result.violations, [])
})

test('scanBundleRequires: 各趟都判定为注释的内容不算违规', () => {
  const src = [
    '/* require("lucide-react") */',
    '// require("@radix-ui/react-dialog")',
    'var a = require("react");',
  ].join('\n')
  const result = scanBundleRequires(src)
  assert.equal(result.passesAgree, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.specifiers, ['react'])
  assert.equal(result.passes.length, 4, '多趟扫描配置应全部执行')
})
