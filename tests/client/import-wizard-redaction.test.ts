/**
 * B1 源码守卫：ImportWizardView.tsx 渲染 `analysis.warnings` 时必须逐项过 `redact()`。
 *
 * 背景（本轮新引入的暴露面）：analyzer 新增的告警文案插值**包内 / 攻击者可控字符串**——
 *   - `import.extraEntries`              ← ZIP 条目名
 *   - `import.unsupportedSections`       ← `manifest.sections` 的键
 *   - `import.unsupportedSectionVersion` ← `manifest.sections` 的键
 * 独立审计实测：条目名 `rogue/sk-A1b2C3d4E5f6G7h8I9j0K1l2.txt` 会被原样显示；
 * 过 `redact()` 后应变成 `rogue/***REDACTED***.txt`。
 * 同文件的 logLine 渲染（约 :175）本来就是 `{redact(line)}`，本守卫锁死 warnings 渲染点同档。
 *
 * 本仓库 React **无组件测试框架**（AGENTS.md：逻辑提炼到 `src/ui/` 保证可测），
 * 因此不渲染组件，沿用既有「源码级守卫」模式
 * （参考 tests/architecture-boundaries.test.ts 与 tests/core/exporter.test.ts 的 G-08 守卫）。
 * 本守卫已做变异验证：把 `redact(w)` 改回 `w` → 红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 被测源码（相对本测试文件：tests/client/ → 仓库根 → src/client/import/） */
const FILE = new URL('../../src/client/import/ImportWizardView.tsx', import.meta.url)

/** 单个告警渲染回调体：从 `.map(...)` 的 `=>` 起，到首个 `)}` 止（本文件渲染点均为单行 JSX）。 */
interface WarningRenderWindow {
  /** 源码偏移（便于报错定位） */
  index: number
  /** map 回调的条目参数名（通常是 `w`） */
  param: string
  /** 回调体源码片段（含被渲染的 JSX 表达式） */
  body: string
}

/** 抽取全部 `analysis.warnings.map(...)` 渲染点（一个都没有 → 返回空数组，由调用方断言）。 */
function warningRenderWindows(src: string): WarningRenderWindow[] {
  const re = /analysis\.warnings\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\)\s*=>/g
  const windows: WarningRenderWindow[] = []
  for (const m of src.matchAll(re)) {
    const index = m.index ?? 0
    const start = index + m[0].length
    const end = src.indexOf(')}', start)
    windows.push({
      index,
      param: m[1] as string,
      body: src.slice(start, end === -1 ? src.length : end + 2),
    })
  }
  return windows
}

test('B1 源码守卫：ImportWizardView.tsx 渲染 analysis.warnings 必须逐项过 redact()', () => {
  const src = fs.readFileSync(FILE, 'utf8')

  // 1) 前提：该文件确实从 redaction 模块导入 redact（import 被删/改名 → 立即失败）
  assert.match(
    src,
    /import\s*\{\s*redact\s*\}\s*from\s*'\.\.\/\.\.\/security\/redaction\.ts'/,
    "必须 import redact（from '../../security/redaction.ts'）",
  )

  // 2) 定位渲染点：至少存在一处 analysis.warnings.map(...)（渲染点被整体删除 → 需同步复核本守卫）
  const windows = warningRenderWindows(src)
  assert.ok(
    windows.length >= 1,
    '应存在 analysis.warnings 的渲染点（若确实移除了该渲染点，请同步复核并更新本守卫）',
  )

  // 3) 每个渲染点都必须对映射项调用 redact(...)，且不得裸渲染
  for (const w of windows) {
    const where = `offset ${w.index}`
    assert.ok(
      w.body.includes(`redact(${w.param})`),
      `analysis.warnings 渲染点（${where}）必须写 redact(${w.param})：` +
        '告警文案插值 ZIP 条目名 / manifest 分区键等可控输入，未脱敏即原样进 UI。' +
        `实际渲染体: ${w.body.trim()}`,
    )
    assert.doesNotMatch(
      w.body,
      /\{\s*[A-Za-z_$][\w$]*\s*\}\s*<\/div>/,
      `analysis.warnings 渲染点（${where}）不得裸渲染告警项（必须先 redact）。实际渲染体: ${w.body.trim()}`,
    )
  }

  // 4) 全文兜底：不存在任何 `{w}</div>` 式裸渲染（含将来新增的渲染点）
  assert.doesNotMatch(src, /\{w\}<\/div>/, '不得出现裸 {w} 渲染（必须先过 redact）')
})
