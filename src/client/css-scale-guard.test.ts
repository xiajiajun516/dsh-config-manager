/**
 * css-scale-guard — 视觉 scale 的**源级执行者**（UI v3 §4.2/§4.3、§12）。
 *
 * 为什么需要它：`DESIGN.md` 从 v1 起就写着「唯一允许的 scale」，但实测文件里同时存在
 * 10 档字号 / 11 档圆角 / 5 档行高 / 10 档 gap（见 docs/design/2026-10-05-ui-redesign-v3.md §0）——
 * 散文规范拦不住新增值。本守卫把 scale 变成红灯：越界值直接失败。
 *
 * 覆盖：font-size / border-radius / line-height / z-index / padding / margin / gap。
 * 不覆盖：宽高、定位、媒体查询断点（布局尺寸，不属节奏 scale）。
 * 豁免：见 SPACING_EXEMPT —— 每条例外都带「为什么」与「最多几处」，防止例外无声增长。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8')

/** 去注释但保留行结构（`/* *\/` 内的非换行字符替换为空格）。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

const ALLOWED_FONT_SIZE = new Set(['11px', '12px', '12.5px', '13px'])
const ALLOWED_RADIUS = new Set(['0', '4px', '6px', '8px', '999px', '50%'])
const ALLOWED_LINE_HEIGHT = new Set(['1.25', '1.5'])
/** 间距节奏档（--cm-sp-1..9）；1px 是发丝线/描边，单列。 */
const ALLOWED_SPACING = new Set(['0', '1', '2', '4', '6', '8', '10', '12', '14', '16', '24'])
const SPACING_EXEMPT: { value: string; max: number; why: string }[] = [
  { value: '38px', max: 2, why: '恢复计划/差异行的深层缩进（布局偏移，非节奏间距）' },
  { value: '22px', max: 1, why: '同类深层缩进（布局偏移）' },
  { value: '-4px', max: 1, why: '图标与文字的负外边距对齐（布局偏移）' },
]
const SPACING_PROPS = /^(padding|margin(-top|-bottom|-left|-right)?|gap|row-gap|column-gap)$/

/** 收集全部声明：同一行可含多条（单行规则 `.x { a: 1; b: 2; }`）。 */
function declarations(css: string): { prop: string; value: string; line: number }[] {
  const out: { prop: string; value: string; line: number }[] = []
  css.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      const prop = m[1]
      const value = m[2]
      if (prop !== undefined && value !== undefined) out.push({ prop, value: value.trim(), line: i + 1 })
    }
  })
  return out
}

const STRIPPED = stripComments(CSS)

/**
 * **全局 token 块**（文件里第一个 `body { … }`）。
 *
 * 为什么 scale 档位只看这里：`--cm-fs-*` / `--cm-r-*` 是全局 scale，定义在 body 上；
 * 而文件里还存在**局部作用域**的同名重定义（如 §16 聊天卡「镜像宿主活值」块把
 * `--cm-r-2/3` 钉成宿主的 6/8px）——那是宿主逐值镜像，不是我们的 scale 档位，
 * 不参与本守卫的原生派生断言（否则会把镜像当成越界）。
 */
const GLOBAL_TOKENS = (() => {
  const at = STRIPPED.indexOf('body {')
  if (at < 0) return ''
  const end = STRIPPED.indexOf('}', at)
  return end < 0 ? STRIPPED.slice(at) : STRIPPED.slice(at, end)
})()
const DECLS = declarations(STRIPPED)

function collect(prop: string, pick: (value: string) => string[]): Map<string, number[]> {
  const seen = new Map<string, number[]>()
  for (const d of DECLS) {
    if (d.prop !== prop) continue
    for (const v of pick(d.value)) {
      const arr = seen.get(v) ?? []
      arr.push(d.line)
      seen.set(v, arr)
    }
  }
  return seen
}

/**
 * 2026-10-17（对齐 DSH 原生）：字号不再允许散落字面量，**一律走 `--cm-fs-*`**，
 * 而每个 `--cm-fs-*` 都必须**取自 DSH 原生字体 token**（`--dsw-font-*` 的某一档）——
 * 档位身份从此由原生 scale 定义，将来原生调档本插件跟着动。
 *
 * 例外必须登记（`FONT_TOKEN_EXCEPTIONS`，逐条写理由）：**当前只有面板密集基准档**，
 * 它是全站正文的锚点、改了等于全站字号地震（chat-entry-view.test.ts ③ 也钉着它）。
 */
const FONT_TOKEN_EXCEPTIONS: Readonly<Record<string, string>> = {
  '--cm-fs-base': '面板密集基准 12.5px：原生最小正文档是 13px，而插件画布 564×720 需要更密半档；改它 = 全站字号地震',
}

test('scale-01 字号只走 --cm-fs-*，且 token 必须取自原生字体 token', () => {
  const seen = collect('font-size', (v) => (/^[\d.]+px$/.test(v) ? [v] : v.startsWith('var(--cm-fs-') ? [] : [v]))
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_FONT_SIZE.has(v))
  assert.deepEqual(bad, [], 'font-size 越界值（新档位必须先改本文档与 DESIGN.md §4）：' + JSON.stringify(bad))
  const defs = [...GLOBAL_TOKENS.matchAll(/^\s*(--cm-fs-[a-z-]+)\s*:\s*([^;]+);/gm)]
  assert.ok(defs.length >= 4, '字号档位数量异常，疑似扫描失效：' + JSON.stringify(defs.map((m) => m[1])))
  const notNative = defs.filter((m) => !/^var\(--dsw-font-/.test((m[2] ?? '').trim()) && FONT_TOKEN_EXCEPTIONS[m[1] ?? ''] === undefined)
  assert.deepEqual(notNative.map((m) => m[1]), [], '这些字号 token 没有取自 DSH 原生字体 token（--dsw-font-*），也不在例外表里')
  // 反向自检：例外表只许登记真实存在的 token，防止表里堆死条目
  for (const name of Object.keys(FONT_TOKEN_EXCEPTIONS)) {
    assert.ok(defs.some((m) => m[1] === name), '例外表里的 ' + name + ' 在 §1 已经不存在（死条目应当删除）')
  }
})

test('scale-02 圆角只走 --cm-r-*（+ 药丸/50%/0 豁免），且 token 必须派生自原生 radius scale', () => {
  const seen = collect('border-radius', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_RADIUS.has(v) && !v.startsWith('var(--cm-r-'))
  assert.deepEqual(bad, [], 'border-radius 越界值：' + JSON.stringify(bad))
  const defs = [...GLOBAL_TOKENS.matchAll(/^\s*(--cm-r-[a-z0-9-]+)\s*:\s*([^;]+);/gm)]
  assert.ok(defs.length >= 4, '圆角档位数量异常：' + JSON.stringify(defs.map((m) => m[1])))
  const notNative = defs.filter((m) => m[1] !== '--cm-r-pill' && !/^var\(--dsw-radius-/.test((m[2] ?? '').trim()))
  assert.deepEqual(notNative.map((m) => m[1]), [], '这些圆角 token 没有派生自原生 --dsw-radius-* scale')
})

test('scale-03 行高只有 2 档（1.25 标题 / 1.5 正文）', () => {
  const seen = collect('line-height', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_LINE_HEIGHT.has(v) && !v.startsWith('var('))
  assert.deepEqual(bad, [], 'line-height 越界值：' + JSON.stringify(bad))
})

test('scale-04 z-index 一律走 --cm-z-* 语义 token（不得写字面量）', () => {
  const seen = collect('z-index', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !/^var\(--cm-z-(raise|sticky|task|mask|modal|pop|toast)\)$/.test(v))
  assert.deepEqual(bad, [], 'z-index 必须用 --cm-z-* token：' + JSON.stringify(bad))
  assert.ok(seen.size >= 6, 'z-index 层级数量异常（应 ≥6 档）')
})

test('scale-05 间距（padding/margin/gap）只用 9 档 + 显式豁免，且豁免数量不得增长', () => {
  const exemptCount = new Map<string, number>()
  const bad: string[] = []
  for (const d of DECLS) {
    if (!SPACING_PROPS.test(d.prop)) continue
    for (const m of d.value.matchAll(/(-?[\d.]+)px/g)) {
      const v = m[1] + 'px'
      if (ALLOWED_SPACING.has(m[1]!)) continue
      const ex = SPACING_EXEMPT.find((e) => e.value === v)
      if (ex !== undefined) {
        exemptCount.set(v, (exemptCount.get(v) ?? 0) + 1)
        continue
      }
      bad.push('L' + String(d.line) + ' ' + d.prop + ': ' + d.value)
    }
  }
  assert.deepEqual(bad, [], '间距越界值（改到 9 档，或把例外登记进 SPACING_EXEMPT 并说明理由）：' + JSON.stringify(bad))
  for (const ex of SPACING_EXEMPT) {
    const n = exemptCount.get(ex.value) ?? 0
    assert.ok(n <= ex.max, '豁免 ' + ex.value + ' 出现 ' + String(n) + ' 次，超过登记上限 ' + String(ex.max) + '（' + ex.why + '）')
  }
})

/** 本表里出现的每一个 `var(--cm-motion-*)` 令牌名（引用侧）。 */
function motionRefs(css: string): string[] {
  return [...new Set([...css.matchAll(/var\((--cm-motion-[a-z-]+)\)/g)].map((m) => m[1] as string))].sort()
}

/** 定义侧（`--cm-motion-xxx: …;` 的声明）。 */
function motionDefs(css: string): string[] {
  return [...new Set([...css.matchAll(/^\s*(--cm-motion-[a-z-]+)\s*:/gm)].map((m) => m[1] as string))].sort()
}

/**
 * scale-07：**动效令牌必须有定义**（2026-10-12 新增）。
 *
 * 真机证据：`--cm-motion-fast/base/slow/ease-out/ease-in-out` 在 token 作用域从 `.section`/`:root` 迁到 `body`
 * 时被整段丢掉 —— 全仓只剩 `var(--cm-motion-*)` 的**引用**。自定义属性替换失败会让整条 `animation`/
 * `transition-duration` 在 computed-value 阶段失效：弹窗入场、页面入场、折叠、通知**全部静默退化成瞬变**，
 * 而 typecheck / build / 字号·间距·z-index 守卫全都看不出。这条把「引用必须有定义」变成红灯。
 */
test('scale-07 动效令牌必须有定义（引用侧的每个 var(--cm-motion-*) 都要能落地）', () => {
  const refs = motionRefs(STRIPPED)
  const defs = motionDefs(STRIPPED)
  assert.ok(refs.length >= 5, '至少应引用 5 个动效令牌（fast/base/slow/ease-out/ease-in-out），实际：' + JSON.stringify(refs))
  const missing = refs.filter((name) => !defs.includes(name))
  assert.deepEqual(missing, [], '这些动效令牌只有引用、没有定义（animation/transition 会静默失效）：' + missing.join(', '))
  // 反向自检：注入一条**未定义**的引用，本判据必须抓到（否则这条守卫只是「文本存在」式的假绿）
  const mutated = STRIPPED.replace('animation: dialogIn', 'animation-duration: var(--cm-motion-nonexistent);\n  animation: dialogIn')
  assert.notEqual(mutated, STRIPPED, '注入必须真的改到文本（锚点失效会让自检变成假绿）')
  const caught = motionRefs(mutated).filter((name) => !motionDefs(mutated).includes(name))
  assert.ok(caught.includes('--cm-motion-nonexistent'), '注入的未定义令牌必须被抓到：' + JSON.stringify(caught))
})
test('scale-06 反自检：注入越界值必须被抓到（防止守卫因解析失效而永远绿灯）', () => {
  const mutated = STRIPPED.replace('.section {', '.section {\n  font-size: 10.5px;\n  gap: 5px;\n  z-index: 9000;')
  const decls = declarations(mutated)
  const fs10 = decls.filter((d) => d.prop === 'font-size' && !ALLOWED_FONT_SIZE.has(d.value))
  const gap5 = decls.filter((d) => d.prop === 'gap' && !ALLOWED_SPACING.has(d.value.replace('px', '')))
  const zLit = decls.filter((d) => d.prop === 'z-index' && !d.value.startsWith('var(--cm-z-'))
  assert.ok(fs10.length > 0 && gap5.length > 0 && zLit.length > 0, '注入的越界值必须被三个检查分别命中')
})
