/**
 * UI-08 守卫：分区显示名走**同一个** `SectionId → i18n key` 映射。
 *
 * 背景（审计 UI-08「同屏术语漂移」）：同一个分区在同一个画布上曾经有三种叫法 ——
 * 导出选择器用 export-flow 的英文 label（`Settings`）、导入向导选择器退化为裸适配器 id
 * （`pluginFiles`）、兼容性页的分区网格同样是裸 id。`DESIGN.md` §9 anti-pattern 8 明令禁止。
 *
 * 本仓库 React **无组件测试框架**（AGENTS.md：逻辑提炼到 `src/ui/` 保证可测），
 * 因此这里用两层证据：
 *  1) 映射本身：`Record<SectionId, ConfigManagerKey>` 全量覆盖 + 每个 key 在 zh/en 字典里
 *     都有非空文案（漏配文案 = 界面显示键名，这是「显示裸 id」的同类缺陷）；
 *  2) 源码级守卫：`<ContentPicker>` 的**每个**调用点都必须传 `sectionLabel`
 *     （沿用 tests/client/import-wizard-redaction.test.ts 的既有模式，已做变异验证：
 *     删掉任一调用点的 `sectionLabel` → 红灯）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { SECTION_LABEL_KEY, sectionLabel } from './section-labels.ts'
import { en, zh } from '../locales.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'

/** 与 src/schema/types.ts 的 SectionId 保持一致（新增分区时这里也要加，否则第 1 条断言失败）。 */
const ALL_SECTIONS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills',
  'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles',
  'credentialsStatus', 'secrets', 'sessions', 'self',
]

test('UI-08 分区显示名：每个 SectionId 都有 zh/en 文案，且不复用同一个键', () => {
  const seen = new Map<string, SectionId>()
  for (const id of ALL_SECTIONS) {
    const key = SECTION_LABEL_KEY[id]
    assert.ok(key !== undefined, `${id} 缺少显示名映射`)
    const zhText = (zh as Record<string, string>)[key]
    const enText = (en as Record<string, string>)[key]
    assert.ok(typeof zhText === 'string' && zhText !== '', `${id} → ${key} 缺 zh 文案`)
    assert.ok(typeof enText === 'string' && enText !== '', `${id} → ${key} 缺 en 文案`)
    assert.notEqual(zhText, key, `${id} 的 zh 文案退化成键名（等于界面显示 ${key}）`)
    assert.notEqual(enText, key, `${id} 的 en 文案退化成键名（等于界面显示 ${key}）`)
    // 两个分区共用一个键 = 同屏术语漂移的另一种形态（复制粘贴漏改）
    const prev = seen.get(key)
    assert.equal(prev, undefined, `${id} 与 ${prev ?? ''} 共用显示名键 ${key}`)
    seen.set(key, id)
  }
  // 映射不得多出「已不在 SectionId 里」的键（防删分区后留孤儿键）
  assert.equal(Object.keys(SECTION_LABEL_KEY).length, ALL_SECTIONS.length)
})

test('UI-08 分区显示名：sectionLabel 经翻译器返回字典文案（缺键回退裸 id）', () => {
  const fake = ((key: string) => `<${key}>`) as unknown as TranslateNS<'config-manager'>
  assert.equal(sectionLabel('pluginFiles', fake), '<section.pluginFiles>')
  // 运行时未知 id（宿主回传了本版本不认识的分区）：回退裸 id，绝不渲染 undefined
  assert.equal(sectionLabel('nope' as SectionId, fake), 'nope')
})

/* ------------------------------------------------- 源码级守卫：调用点必须接线 */

/**
 * 被测调用点（相对本测试文件：src/client/common/ → 仓库根 → src/client/）。
 * 市场通道（2026-09）也走同一个 ContentPicker：浏览条目详情与我的配置→装回本地**共用**
 * `MarketImportReview` 这一个组件，所以只需登记它（两处调用点不再各写一棵树）。
 */
const CALLERS = [
  new URL('../export/ExportView.tsx', import.meta.url),
  new URL('../import/ImportWizardView.tsx', import.meta.url),
  new URL('../market/MarketImportReview.tsx', import.meta.url),
]

/** 抽取每个 `<ContentPicker` 的 JSX 片段（到 `/>` 或 `</ContentPicker>` 止）。 */
function contentPickerCalls(src: string): { index: number; body: string }[] {
  const out: { index: number; body: string }[] = []
  const re = /<ContentPicker[\s>/]/g
  for (const m of src.matchAll(re)) {
    const index = m.index ?? 0
    const start = index
    const selfClose = src.indexOf('/>', start)
    const closing = src.indexOf('</ContentPicker>', start)
    const end = selfClose === -1
      ? closing
      : (closing === -1 ? selfClose : Math.min(selfClose, closing))
    out.push({ index, body: src.slice(start, end === -1 ? src.length : end + 2) })
  }
  return out
}

test('UI-08 源码守卫：每个 ContentPicker 调用点都传 sectionLabel={sectionLabeler(<translator>)}', () => {
  for (const file of CALLERS) {
    const src = fs.readFileSync(file, 'utf8')
    const calls = contentPickerCalls(src)
    assert.ok(calls.length >= 1, `${file.pathname} 应至少有一处 <ContentPicker>（接线被删请同步复核本守卫）`)
    for (const c of calls) {
      // 翻译器标识符不固定（导入/导出页叫 t，市场面板的 config-manager 字典叫 cmT，
      // 且被提升为局部 labelOf）—— 守卫要锁的是「必须由 sectionLabeler(...) 装配」，
      // 不是变量名。裸传 `sectionLabel={(id) => id}` 或删掉该 prop 仍会红灯。
      assert.match(
        c.body,
        /sectionLabel=\{sectionLabeler\(\w+\)\}|sectionLabel=\{labelOf\}/,
        `${file.pathname} offset ${c.index} 的 <ContentPicker> 未传 sectionLabel={sectionLabeler(...)}（会退化为裸适配器 id）`,
      )
    }
  }
})

test('UI-08 源码守卫：不再用 export-flow 的英文 label 作为界面显示名', () => {
  const src = fs.readFileSync(CALLERS[0]!, 'utf8')
  assert.doesNotMatch(
    src,
    /sectionLabel=\{\(id\)\s*=>\s*flow\.categories/,
    '导出选择器不得再用 flow.categories[].label（英文硬编码）当显示名',
  )
})
