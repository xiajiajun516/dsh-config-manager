/**
 * cross-F3（t50）客户端守卫：中断的档案复制残留必须以**独立形态**呈现，且只给删除。
 *
 * 本仓库 React 侧无组件测试框架，沿用 `src/client/common/*.test.ts` 的**源码守卫**模式
 * （与 report-dismiss.test.ts / info-hint-guard.test.ts 同风格）：
 *  1. 行内形态徽章必须走 `profileShapeLabelKey(profile)`（残留行 = 「未完成的副本」，不是 generic）；
 *  2. 动作行里启动/停止、复制、改名三处必须由 `profileRowCapabilities` 的判据把守，**删除不得被把守**（它是残留行的唯一动作）；
 *  3. 残留行必须给出 dir（经 `redact()`）、来源与开始时间；
 *  4. 新增文案必须在 zh/en 两套字典里都存在且键集相等（禁止硬编码用户可见字符串）。
 *
 * 纯函数行为断言在 `src/ui/dsh-profiles-view.test.ts`（cross-F3 段）；这里只钉「组件确实消费了那些判据」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { en, zh } from '../locales.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PANEL = path.join(ROOT, 'src', 'client', 'environment', 'EnvironmentPanel.tsx')

/** 剥掉块注释与行注释（注释里的同名文字会造成假阳性，见 AGENTS.md 的 bundle 扫描教训）。 */
function stripComments(src: string): string {
  return src.replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const panelSrc = stripComments(fs.readFileSync(PANEL, 'utf8'))

/** 档案行的动作行区块（从 data-inline 的 span 到它闭合）。 */
function actionRowBlock(): string {
  const start = panelSrc.indexOf('<span className={css.actionRow} data-inline>')
  assert.ok(start > 0, '找不到档案行动作行（<span className={css.actionRow} data-inline>）')
  const rest = panelSrc.slice(start)
  const end = rest.indexOf('</span>')
  assert.ok(end > 0, '动作行没有闭合')
  return rest.slice(0, end)
}

test('cross-F3 UI：残留行的形态徽章走 profileShapeLabelKey（不是裸 shapeLabelKey）', () => {
  assert.match(panelSrc, /<Badge kind=\{incomplete \? 'warn' : 'info'\}>\{t\(profileShapeLabelKey\(profile\)\)\}<\/Badge>/,
    '行内形态徽章必须由 profileShapeLabelKey 决定，且残留行用 warn 语义')
  assert.ok(!/\{t\(shapeLabelKey\(profile\.shape\)\)\}/.test(panelSrc),
    '行内不得再用裸 shapeLabelKey(profile.shape)（那样残留行会伪装成「自定义」档案）')
})

test('cross-F3 UI：动作行三处把守 + 删除不被把守', () => {
  const block = actionRowBlock()
  assert.match(block, /caps\.launchOrStop && rowAction === 'launch'/, '启动按钮必须由 caps.launchOrStop 把守')
  assert.match(block, /caps\.launchOrStop && rowAction === 'stop'/, '停止按钮必须由 caps.launchOrStop 把守')
  assert.match(block, /caps\.duplicate &&/, '复制按钮必须由 caps.duplicate 把守')
  assert.match(block, /caps\.rename &&/, '改名按钮必须由 caps.rename 把守')
  // 删除是残留行的唯一动作：它必须出现在改名把守闭合之后，本身不带任何 caps 条件。
  // 2026-11-04：删除从文字按钮收成图标按钮（<IconButton danger>，行密度改造），控件形态变了、
  // 判据不变 —— 仍是「紧跟最后一个把守闭合 + 自身不带 caps 条件」。
  // rename 把守闭合之后紧跟着的必须是无条件的删除控件（危险语义）。
  // 不按 lastIndexOf 取尾巴：`label={t('profiles.delete')}` 自身就以 `)}` 结尾。
  assert.match(block, /caps\.rename &&[\s\S]*?\n\s*\)\}\s*<IconButton[\s\S]*?label=\{t\('profiles\.delete'\)\}[\s\S]*?\bdanger\b/,
    '删除控件必须紧跟最后一个把守闭合、自身不带条件（残留行也要能点删除），且是危险语义')
  const deleteStart = block.lastIndexOf('<IconButton', block.indexOf("profiles.delete'"))
  assert.ok(deleteStart > 0 && !/caps\./.test(block.slice(deleteStart)), '删除控件内部不得再夹 caps 条件')
})

test('cross-F3 UI：残留行展示来源 / 开始时间 / 目录（目录经 redact）', () => {
  assert.match(panelSrc, /const incomplete = isIncompleteProfileCopy\(profile\)/, '行内判据来自纯函数层')
  assert.match(panelSrc, /const caps = profileRowCapabilities\(profile\)/, '动作能力来自纯函数层')
  assert.match(panelSrc, /t\('profiles\.incomplete\.from', \{ name: copyFacts\.copiedFrom \}\)/, '必须显示来源档案')
  assert.match(panelSrc, /t\('profiles\.incomplete\.startedAt', \{ time: copyStartedText \}\)/, '必须显示开始时间')
  assert.match(panelSrc, /t\('profiles\.incomplete\.dir', \{ path: redact\(copyFacts\.dir\) \}\)/, '目录必须脱敏后展示')
  assert.match(panelSrc, /t\(incomplete \? 'profiles\.incomplete\.hint' : 'profiles\.list\.hint'\)/, '残留行要给一段解释（tooltip）')
})

test('cross-F3 UI：删除确认对残留行给专属文案', () => {
  assert.match(panelSrc, /isIncompleteProfileCopy\(deleteTarget\) \? t\('profiles\.delete\.incompleteMessage'/, '删除残留行必须讲清删的是什么')
})

test('cross-F3 i18n：新增文案在 zh/en 两套字典里都存在且键集相等', () => {
  const keys = [
    'profiles.shape.incomplete',
    'profiles.incomplete.from',
    'profiles.incomplete.startedAt',
    'profiles.incomplete.dir',
    'profiles.incomplete.hint',
    'profiles.list.incompleteCount',
    'profiles.delete.incompleteMessage',
  ] as const
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须相等')
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'zh 缺键：' + key)
    assert.equal(typeof en[key], 'string', 'en 缺键：' + key)
    assert.ok(zh[key].trim() !== '', 'zh 文案不得为空：' + key)
    assert.ok(en[key].trim() !== '', 'en 文案不得为空：' + key)
  }
  assert.equal(zh['profiles.shape.incomplete'], '未完成的副本')
  assert.equal(en['profiles.shape.incomplete'], 'Incomplete copy')
  assert.match(zh['profiles.incomplete.dir'], /\{path\}/, '目录文案必须带 {path} 占位符')
  assert.match(en['profiles.incomplete.dir'], /\{path\}/, 'en 目录文案必须带 {path} 占位符')
  assert.match(zh['profiles.incomplete.from'], /\{name\}/)
  assert.match(en['profiles.incomplete.from'], /\{name\}/)
  assert.match(zh['profiles.incomplete.startedAt'], /\{time\}/)
  assert.match(en['profiles.incomplete.startedAt'], /\{time\}/)
})
