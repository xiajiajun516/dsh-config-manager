/**
 * 浮层定位守卫：**写进 style 的 top/left 一律带 px 单位**。
 *
 * 为什么需要它（2026-10-03 真机事故）：Select 弹层改 portal 后写的是
 * `style={{ top: menuPos.top, left: menuPos.left }}` —— React **不会**给无单位数值补单位，
 * 浏览器把这两条声明当无效丢弃，弹层于是退回 CSS 默认位置：**恒贴在页面最右边**。
 * 同族另一处浮层（已删的 InfoHint 气泡）一直写着 `top + 'px'`，所以它没事 —— 两处不同形正是漏网的原因。
 *
 * 教训：React 的「数值自动补 px」只对**部分属性**成立（width/height/margin/padding…），
 * `top / left / right / bottom` **不在其列**，必须显式写单位。
 *
 * 扫描范围只限 **JSX 的 style={{ … }} 块** —— 类型声明（`top: number`）与内部状态对象
 * 同样是 `top:` 形态，宽匹配会产出假阳性（本守卫第一版就栽在这里）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** 所有会写视口/画布坐标的浮层实现（新增浮层请加进来）。 */
const FLOATING_FILES = [
  'src/client/common/Select.tsx',
]

/** 剥掉注释：注释里的示例同样含 top/left 字样，会造成假阳性。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

/** 取出所有 style={{ … }} 的块体（括号配平，能跨行）。 */
function styleBlocks(code: string): string[] {
  const blocks: string[] = []
  const re = /style=\{\{/g
  let m
  while ((m = re.exec(code)) !== null) {
    let depth = 2
    let i = m.index + m[0].length
    const start = i
    while (i < code.length && depth > 0) {
      const c = code[i]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      i += 1
    }
    blocks.push(code.slice(start, i - 1))
  }
  return blocks
}

test('浮层定位：写进 style 的 top / left 必须带 px 单位（React 不给这两个属性补单位）', () => {
  const violations = []
  for (const rel of FLOATING_FILES) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    for (const block of styleBlocks(code)) {
      for (const m of block.matchAll(/\b(top|left|right|bottom)\s*:\s*([^,}\n]+)/g)) {
        const prop = m[1]
        const value = (m[2] || '').trim()
        // 允许：字符串字面量 / 显式带 px 的拼接 / 三元里的 undefined / CSS 变量 / calc()
        const ok = /['"`]/.test(value)
          || /\+\s*['"`]px['"`]/.test(value)
          || value === 'undefined' || value === 'null'
          || /var\(/.test(value)
        if (!ok) violations.push(rel + ' → ' + prop + ': ' + value)
      }
    }
  }
  assert.deepEqual(violations, [], '以下 style 里的 top/left 没有单位（浏览器会丢弃该声明）：\n' + violations.join('\n'))
})
