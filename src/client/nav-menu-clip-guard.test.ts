/**
 * nav-menu-clip-guard — 导航条「更多 ▾」的弹层不得被祖先裁剪（2026-11-14 真机 bug）。
 *
 * 为什么需要它：MoreMenu 的弹层是**留在原地的 absolute**（契约见 common/MoreMenu.tsx ①，
 * 不 portal），祖先链 `.navStrip → .shellNav → .section` 任何一级写 `overflow`（或 `contain: paint`、
 * `clip-path`）都会把它切掉。真机表现：小视口下页签挤进「更多 ▾」，点开**什么都不显示** ——
 * 菜单只剩分隔条下沿那一条，正是 `.navStrip` 早先那条「防极端情况」的 `overflow: hidden` 干的。
 *
 * 这条不变量没法被 typecheck / build 发现，所以按源码级断言钉住（与 css-scale-guard 同一套做法）：
 *   - `.navStrip` / `.shellNav` 不得出现任何裁剪声明；
 *   - 兜底必须存在：`.section` 仍是 `overflow: hidden`（画布边界兜住宿主布局，
 *     量测失败时的横向溢出也由它裁在插件画布内）。
 * 去注释后再断言：注释里会写「不写 overflow: hidden」，不能把它当成违规。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** 取某个**单选择器**规则体（`.x {` 开头，到第一个 `}` 行结束）。 */
function ruleBody(selector: string): string {
  const head = '\n' + selector + ' {'
  const at = CSS.indexOf(head)
  assert.ok(at >= 0, `CSS 里找不到 ${selector} 的规则块`)
  const end = CSS.indexOf('\n}', at)
  assert.ok(end > at, `${selector} 的规则块没有闭合`)
  return CSS.slice(at, end)
}

/** 会裁剪后代的声明：overflow 家族 + 两种等价手段。 */
const CLIPPING = /^\s*(overflow(-[xy])?|contain|clip-path)\s*:/m

for (const selector of ['.navStrip', '.shellNav']) {
  test(`${selector}: 不得裁剪「更多 ▾」弹层`, () => {
    assert.doesNotMatch(
      ruleBody(selector), CLIPPING,
      `${selector} 一旦裁剪，「更多 ▾」的 absolute 弹层会被切成一条（见本文件头）。` +
      '需要兜住溢出时改由 .section 承担。',
    )
  })
}

test('.section: 仍是唯一的溢出兜底', () => {
  assert.match(
    ruleBody('.section'), /^\s*overflow\s*:\s*hidden\s*;/m,
    '.section 的 overflow: hidden 是「量测失败时横向溢出不外泄」的唯一兜底，别删。',
  )
})
