/**
 * 恢复报告「退出入口」守卫（本仓库 React 无组件测试框架，沿用 src/client/common/*.test.ts 的源码守卫模式）。
 *
 * 背景：快照恢复执行完成后，面板把结果渲染成「恢复报告」，但报告只有标题、
 * 没有任何按钮 —— 页面就停在报告上，用户找不到返回入口；且 report 随 runStore 切片
 * 落 sessionStorage，切页签/刷新后还会「复活」，等于把用户永久留在报告上。
 *
 * 因此钉住两条不变量：
 *  1. 报告头部必须渲染一个显式退出按钮（onClick=dismissReport）；
 *  2. dismissReport 必须经 patch()（= commit → runStore.patch）清空 report，
 *     只改本地 state 会让报告在切页签/刷新后重新出现；
 *  3. 按钮文案必须来自字典（zh/en 键集合相等，禁止硬编码用户可见字符串）。
 *
 * 已做变异验证：删掉按钮或把 dismissReport 改成 setState → 红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PANEL = path.join(ROOT, 'src', 'client', 'snapshots', 'SnapshotsPanel.tsx')
const LOCALES = path.join(ROOT, 'src', 'client', 'locales.ts')

/** 剥掉块注释与行注释（注释里的同名文字会造成假阳性，见 AGENTS.md 的 bundle 扫描教训）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const panelSrc = stripComments(fs.readFileSync(PANEL, 'utf8'))

test('恢复报告：报告块内必须提供显式退出按钮（onClick=dismissReport）', () => {
  const start = panelSrc.indexOf('state.report !== null')
  assert.ok(start > 0, '找不到恢复报告渲染块（state.report !== null）')
  const end = panelSrc.indexOf("t('snapshots.restored')", start)
  assert.ok(end > start, '找不到报告块结束锚点（snapshots.restored）')
  const block = panelSrc.slice(start, end)
  assert.match(block, /<Button[\s\S]{0,200}onClick=\{dismissReport\}/, '报告块内必须有 onClick={dismissReport} 的按钮')
  assert.match(block, /t\('snapshots\.reportDone'\)/, '退出按钮文案必须来自字典 snapshots.reportDone')
})

test('恢复报告：dismissReport 必须经 patch() 清空 report（否则切页签/刷新后复活）', () => {
  assert.match(
    panelSrc,
    /const dismissReport = \(\): void => \{\s*patch\(\{ report: null \}\)/,
    'dismissReport 必须调用 patch({ report: null })（commit → runStore.patch）',
  )
})

test('恢复报告：snapshots.reportDone 在 zh / en 两套字典中都必须存在', () => {
  const locales = fs.readFileSync(LOCALES, 'utf8')
  const hits = [...locales.matchAll(/'snapshots\.reportDone':/g)]
  assert.equal(hits.length, 2, `snapshots.reportDone 必须 zh/en 各一条（实际 ${hits.length} 条）`)
})
