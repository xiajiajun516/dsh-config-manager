/**
 * G-02 守卫：导出侧「合计」在两个展示位置必须是**同一口径**。
 *
 * 背景：同一个数据（"将导出 N 个分区 · M 个条目 · 约 X"）出现在两处 ——
 *  1. 导出页页尾的「本次将导出」卡片（`ExportView`）；
 *  2. 内容选择器弹窗 footer（`ContentPicker`）。
 * 页面卡片在 F-03 后会在「存在未读取分区」时改用 `export.compositionPartial`
 * （「…（含未读取分区，实际不少于该值）」），但选择器 footer 当时仍是无条件 `picker.summary`
 * → 同屏两处口径不一致（评审 G-02）。
 *
 * 本守卫锁死三件事：
 *  1. 两处**共用同一个字典键** `export.compositionPartial`（不新增同义键，避免日后文案漂移）；
 *  2. 选择器 footer 的判定输入来自 `pendingSections` + `failedSections`（"未读到清单"的两态）；
 *  3. 该键在 zh/en 字典里都存在且文案一致（键集合相等由 `Record<keyof typeof zh, string>` 强制）。
 *
 * 本仓库 React 无组件测试框架，故沿用源码级守卫（见 plan-text-redaction.test.ts 的同款模式）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { en, zh } from '../locales.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const picker = fs.readFileSync(path.join(ROOT, 'src/client/common/ContentPicker.tsx'), 'utf8')
const view = fs.readFileSync(path.join(ROOT, 'src/client/export/ExportView.tsx'), 'utf8')

test('G-02 守卫：选择器 footer 与导出页卡片共用 export.compositionPartial（同一口径）', () => {
  // 两处都必须引用同一个键
  assert.match(view, /t\('export\.compositionPartial'/, '导出页卡片必须使用 export.compositionPartial')
  assert.match(picker, /'export\.compositionPartial'/, '选择器 footer 必须复用同一个键（不得新增同义键）')
  // 选择器侧不得再自造一个「部分合计」键
  assert.doesNotMatch(picker, /'picker\.summaryPartial'/, '不得新增同义键 picker.summaryPartial')
})

test('G-02 守卫：选择器 footer 的未读取判定来自 pending + failed（两态去重）', () => {
  assert.match(
    picker,
    /const unreadSections = new Set\(\[\.\.\.pendingSections, \.\.\.failedSections\]\)\.size/,
    'unreadSections 必须由 pendingSections 与 failedSections 合并去重得出',
  )
  assert.match(
    picker,
    /unreadSections > 0 \? 'export\.compositionPartial' : 'picker\.summary'/,
    'footer 必须在 unreadSections > 0 时切到部分合计口径',
  )
})

test('G-02 守卫：export.compositionPartial 文案在 zh/en 都存在且带同一组占位符', () => {
  const zhText = (zh as Record<string, string>)['export.compositionPartial']
  const enText = (en as Record<string, string>)['export.compositionPartial']
  assert.ok(typeof zhText === 'string' && zhText !== '', 'zh 文案必须存在')
  assert.ok(typeof enText === 'string' && enText !== '', 'en 文案必须存在')
  for (const ph of ['{sections}', '{units}', '{size}']) {
    assert.ok(zhText.includes(ph), `zh 文案缺少占位符 ${ph}`)
    assert.ok(enText.includes(ph), `en 文案缺少占位符 ${ph}`)
  }
  // 「不少于该值」这句语义必须在（这是与普通合计的唯一区别）
  assert.match(zhText, /不少于/, 'zh 文案必须说明实际不少于该值')
  assert.match(enText, /no less/i, 'en 文案必须说明实际不少于该值')
})
