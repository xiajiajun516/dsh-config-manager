/**
 * css-token-guard — 语义 token 层的**源级执行者**（UI v3 §4.1）。
 *
 * 规则：四态与主色**只能**在 \`--cm-*\` 定义行里引用 \`--dsw-*\`；组件规则一律消费 \`--cm-*\`。
 * 为什么需要它：v2 里 140 处 \`--dsw-alias-state-*\` / \`--dsw-alias-button-info-*\` 直接散落在
 * 4957 行样式里，四态语义各写各的（Badge / Banner / StatusDot / 第二套徽章 / choiceCard 五份实现）——
 * 改一次语义要扫全文件。中间层建立后必须有人守着它不被绕过。
 *
 * 结构类 token（label / border / bg / hover / input / font）**不受约束**：它们语义稳定、直用更短。
 *
 * 2026-11（tech-debt #11）：覆盖面从 `*.module.css` 扩到 **TSX 内联样式** —— 此前把样式写进
 * `style={{ … }}` 就绕开了全部守卫（裸 `var(--dsw-*)`、越界字号、硬编码间距都写在 TSX 里）。
 * 现由 tsx-01 扫 src/client 下全部 TSX；豁免表 `TSX_STYLE_WHITELIST` 逐条登记「哪个文件、哪条规则、
 * 还剩几处、为什么留下」—— 数量只许减不许增，清干净后条目必须一起删（tsx-02 反向自检抓死条目）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8')

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 必须**只在定义行**出现的 \`--dsw-*\` 语义 token（值 = 出现次数上限 1）。 */
const GUARDED_DSW = [
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  // 2026-10-17（对齐原生）：DSH 主题**没有** --dsw-alias-state-info-primary（旧条目指了个不存在的 token，
  // 导致 --cm-info 的整条 var() 链无效、三处消费点静默退化）。--cm-info 现按同义别名接 --cm-accent。
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
]

/** token 定义行：\`--cm-xxx: var(--dsw-...)\`。 */
const DEF_LINE = /^\s*--cm-[\w-]+\s*:\s*var\(--dsw-/

/** \`--cm-*\` 层必须存在的语义 token（删掉任何一个都说明层被拆了）。 */
const REQUIRED_CM = [
  '--cm-accent', '--cm-accent-hover', '--cm-ok', '--cm-info', '--cm-warn', '--cm-error',
  '--cm-fs-meta', '--cm-fs-table', '--cm-fs-base', '--cm-fs-title',
  '--cm-r-1', '--cm-r-2', '--cm-r-3',
  '--cm-z-task', '--cm-z-modal', '--cm-z-pop', '--cm-z-toast',
]

const STRIPPED = stripComments(CSS)

test('token-01 四态/主色 token 只能出现在 --cm-* 定义行里', () => {
  const violations: string[] = []
  STRIPPED.split('\n').forEach((line, i) => {
    for (const tok of GUARDED_DSW) {
      if (!line.includes(tok)) continue
      if (!DEF_LINE.test(line)) violations.push('L' + String(i + 1) + ' 裸用 ' + tok + '：' + line.trim().slice(0, 90))
    }
  })
  assert.deepEqual(violations, [], '这些行必须改为消费 --cm-*（或把新 token 加进 §1 TOKENS）：\n' + violations.join('\n'))
})

test('token-02 每个受约束的 --dsw-* 语义 token 仍被定义且只出现在定义行（不漂移、不失效）', () => {
  for (const tok of GUARDED_DSW) {
    // 判定口径（2026-10-17 对齐原生时放宽「恰好一次」）：既要 ≥1 次
    // —— token 被悄悄删掉会让整条 --cm-* 链解析成无效值（--cm-info 曾经就是这样），
    // 也要每次都在定义行（裸用由 token-01 报错）。允许两个语义名指向同一个原生 token。
    const lines = STRIPPED.split(String.fromCharCode(10)).filter((line) => line.includes(tok))
    assert.ok(lines.length >= 1, tok + ' 在本文件里已不存在（删掉它时忘了同步本表？）')
    const offDef = lines.filter((line) => !DEF_LINE.test(line))
    assert.deepEqual(offDef, [], tok + ' 出现在非定义行：' + JSON.stringify(offDef))
  }
})

test('token-03 --cm-* 层必须完整（语义 + 字号 + 圆角 + 层级）', () => {
  for (const tok of REQUIRED_CM) {
    assert.ok(new RegExp('\\s' + tok.replace(/[-]/g, '\\-') + '\\s*:').test(STRIPPED), tok + ' 定义缺失')
  }
})

test('token-04 四态 token 必须真被消费（定义而不接线 = 死 token）', () => {
  const body = STRIPPED.replace(/^\s*--cm-[\w-]+\s*:.*$/gm, '')
  for (const tok of ['--cm-accent', '--cm-ok', '--cm-info', '--cm-warn', '--cm-error']) {
    assert.ok(body.includes('var(' + tok + ')'), tok + ' 在规则里没有任何消费点')
  }
})

test('token-05 反自检：定义行之外的裸用必须被抓到', () => {
  const mutated = STRIPPED.replace('.section {', '.section {\n  color: var(--dsw-alias-state-error-primary);')
  const hit = mutated.split('\n').some((line) => line.includes('--dsw-alias-state-error-primary') && !DEF_LINE.test(line))
  assert.ok(hit, '注入的裸用必须被 token-01 的判据命中')
})

/* ================================================================
 * TSX 内联样式扫描（tech-debt #11）
 *
 * 为什么必须扫 TSX：本文件的 token-01/02 与 css-scale-guard 的 scale-01/05 都只读
 * `config-manager.module.css` —— 把同一条违规写进 React 的 `style={{ … }}` 就完全看不见。
 * 真机后果不比 CSS 里轻：`var(--dsw-alias-state-warn-primary)` 直接把四态语义钉进组件，
 * 换主题/改语义时 CSS 侧已收敛、TSX 侧照旧。
 *
 * 只认「可判定」的四类形状，不试图解析 JSX：
 *   ① `var(--dsw-…)`            —— 组件层必须消费 `--cm-*`（结构色走定义行）
 *   ② `fontSize: '<n>px'`       —— 字号只有 4 档（DESIGN.md §4）
 *   ③ `color/background: '#…'/rgb(…)` —— 零硬编码颜色（DESIGN.md §3）
 *   ④ `padding/margin/gap: '…px'`      —— 间距只有 9 档（DESIGN.md §5）
 * ================================================================ */

const CLIENT_DIR = path.join(ROOT, 'src/client')

/** 递归收集 src/client 下全部 TSX，跳过 `*.test.tsx`（测试夹具里允许写字面量）。 */
function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectTsx(full, out)
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/**
 * 去掉注释但保留行结构（替换为等长空白）。
 * 理由：注释里常**引用**违规写法当反例（「不要写 `gap: '5px'`」），那是文档不是代码。
 */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    // `//` 前一个字符是冒号时是 URL（https://、file://），不当作注释
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
}

interface TsxRule { id: string; why: string; re: RegExp }

const TSX_RULES: TsxRule[] = [
  { id: 'dsw-var', why: '组件层直接引用 --dsw-* token（应消费 --cm-*）', re: /var\(\s*--dsw-/g },
  // 到「同一 style 条目」为止（不在逗号处越界），这样三元/拼接里的 px 也算：
  // fontSize: lv === 1 ? '15px' : '13px' 是字面量，不能因为没紧跟引号就漏掉。
  { id: 'font-px', why: 'fontSize 字面量 px（字号只有 4 档，走 var(--cm-fs-*)）', re: /fontSize\s*:[^,}\n]*?\d(?:\.\d+)?px/g },
  { id: 'color-literal', why: '硬编码颜色（#hex / rgb()）', re: /(?:color|background(?:Color)?)\s*:\s*['"`]\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/g },
  { id: 'space-px', why: 'padding/margin/gap 字面量 px（间距只有 9 档）', re: /(?:padding|margin|gap)(?:Top|Right|Bottom|Left|Inline|InlineStart|InlineEnd|Block|BlockStart|BlockEnd)?\s*:\s*['"`][^'"`]*\d(?:\.\d+)?px/g },
]

/**
 * 豁免表：每条 = 「这个文件的这条规则还剩几处、为什么留下」。
 *
 * 判据（照抄 css-scale-guard 的 SPACING_EXEMPT 惯例）：`max` 是**上限**，只许减不许增；
 * 一处都不剩时条目必须删除（tsx-02 抓死条目）。
 */
const TSX_STYLE_WHITELIST: { file: string; rule: string; max: number; why: string }[] = [
  {
    file: 'src/client/about/ReleaseBody.tsx',
    rule: 'font-px',
    max: 1,
    why: 'Markdown 标题三级要 15/14/13px 区分；14/15px 不在 DESIGN.md §4 四档内，写进 CSS 会让 scale-01 直接变红。',
  },
]

interface TsxHit { file: string; rule: string; line: number; text: string }

const TSX_FILES = collectTsx(CLIENT_DIR)
const TSX_HITS: TsxHit[] = []
for (const full of TSX_FILES) {
  const rel = path.relative(ROOT, full).split(path.sep).join('/')
  const lines = stripTsComments(fs.readFileSync(full, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    for (const rule of TSX_RULES) {
      rule.re.lastIndex = 0
      if (rule.re.test(line)) TSX_HITS.push({ file: rel, rule: rule.id, line: i + 1, text: line.trim().slice(0, 100) })
    }
  })
}

test('tsx-01 TSX 内联样式不得绕过 token 层与 scale（var(--dsw-) / 字号·颜色·间距字面量）', () => {
  const violations: string[] = []
  for (const hit of TSX_HITS) {
    const allow = TSX_STYLE_WHITELIST.find((a) => a.file === hit.file && a.rule === hit.rule)
    if (allow === undefined) {
      const rule = TSX_RULES.find((r) => r.id === hit.rule)
      violations.push(hit.file + ':' + String(hit.line) + ' [' + hit.rule + '] ' + (rule?.why ?? '') + ' — ' + hit.text)
    }
  }
  assert.deepEqual(violations, [], '这些内联样式必须迁进 config-manager.module.css（或复用已有类）：\n' + violations.join('\n'))
})

test('tsx-02 豁免表的每一条都必须仍然命中（删干净后条目要一起删）', () => {
  const counts = new Map<string, number>()
  for (const hit of TSX_HITS) {
    const key = hit.file + '|' + hit.rule
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dead: string[] = []
  const grown: string[] = []
  for (const allow of TSX_STYLE_WHITELIST) {
    const n = counts.get(allow.file + '|' + allow.rule) ?? 0
    if (n === 0) dead.push(allow.file + ' [' + allow.rule + ']')
    else if (n > allow.max) grown.push(allow.file + ' [' + allow.rule + '] 现有 ' + String(n) + ' 处 > 登记上限 ' + String(allow.max))
  }
  assert.deepEqual(dead, [], '这些豁免已经没有对应违规（已迁干净 ⇒ 请删除条目）：' + JSON.stringify(dead))
  assert.deepEqual(grown, [], '豁免数量增长（新写的内联样式必须迁走）：' + JSON.stringify(grown))
})

test('tsx-03 反自检：四类形状必须真的被抓到（防止正则失效后永远绿灯）', () => {
  const sample = [
    '<li style={{ color: warn ? \'var(--dsw-alias-state-warn-primary)\' : undefined }} />',
    "<span style={{ fontSize: '11px' }} />",
    "<div style={{ color: '#ff0000', background: 'rgb(1,2,3)' }} />",
    "<div style={{ padding: '4px', marginTop: '8px', gap: '6px' }} />",
  ].join('\n')
  const caught = new Set<string>()
  for (const rule of TSX_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(sample)) caught.add(rule.id)
  }
  assert.deepEqual(TSX_RULES.map((r) => r.id).filter((id) => !caught.has(id)), [], '注入的违规形状必须被对应规则命中')
  // 注释里的示例不是违规（否则没人敢在注释里写反例）
  const commented = stripTsComments("// 反例：style={{ gap: '5px' }}\nconst x = 1")
  for (const rule of TSX_RULES) {
    rule.re.lastIndex = 0
    assert.equal(rule.re.test(commented), false, '注释内容不得被扫描（会逼人删掉注释里的反例）')
  }
})
