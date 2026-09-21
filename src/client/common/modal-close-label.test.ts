/**
 * UI-17 守卫：弹窗关闭按钮的 `aria-label` 必须是**已翻译文本**（各字典的 `common.close`）。
 *
 * 背景：`Modal.Header` 原先硬编码关闭中文文案 —— 界面语言为英文时，屏幕阅读器仍读中文。
 * 修法是把关闭文案作为必填 prop 交给调用方（各调用点都有自己的 `t`），
 * 并用联合类型把「传了 onClose 就必须给 closeLabel」交给编译器。
 *
 * 这里再补一层**源码守卫**（本仓库 React 无组件测试框架，沿用 tests/client/*-redaction.test.ts 模式）：
 *  1. `Modal.tsx` 内不得再出现硬编码关闭文案（防止有人加回兜底默认值）；
 *  2. 每个带 `onClose` 的 `<Modal.Header>` 调用点都必须显式传 `closeLabel`。
 * 扫描前先剥掉注释：本仓库实测过「注释里的同名字符串造成假阳性」（见 AGENTS.md 的 bundle 扫描教训）。
 * 已做变异验证：删掉任一调用点的 closeLabel → 红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CLIENT_DIR = path.join(ROOT, 'src', 'client')

/** 剥掉块注释与行注释（避免注释里的示例/说明文字被当成真实调用） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** 递归收集 src/client 下的 .tsx（跳过测试文件） */
function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full)
  }
  return out
}

/** 抽取每个 `<Modal.Header … />` 的 JSX 片段 */
function modalHeaderCalls(src: string): { index: number; body: string }[] {
  const out: { index: number; body: string }[] = []
  for (const m of src.matchAll(/<Modal\.Header/g)) {
    const index = m.index ?? 0
    const end = src.indexOf('/>', index)
    out.push({ index, body: src.slice(index, end === -1 ? src.length : end + 2) })
  }
  return out
}

test('UI-17 守卫：Modal.tsx 不得再有硬编码的关闭文案', () => {
  const src = stripComments(fs.readFileSync(path.join(CLIENT_DIR, 'common', 'Modal.tsx'), 'utf8'))
  assert.doesNotMatch(src, /aria-label="关闭"|aria-label=\{'关闭'\}/, '关闭按钮 aria-label 不得硬编码中文')
  assert.match(src, /aria-label=\{closeLabel\}/, '关闭按钮 aria-label 必须来自调用方传入的已翻译文案')
})

test('UI-17 守卫：每个带 onClose 的 Modal.Header 都必须传 closeLabel', () => {
  let checked = 0
  for (const file of tsxFiles(CLIENT_DIR)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const call of modalHeaderCalls(src)) {
      if (!/onClose=/.test(call.body)) continue
      checked += 1
      assert.match(
        call.body,
        /closeLabel=\{/,
        `${path.relative(ROOT, file)} offset ${call.index}：带 onClose 的 Modal.Header 缺 closeLabel`,
      )
    }
  }
  /**
   * 阈值 = 当前调用点数（12）。2026-09 由 13 降为 12：市场通道的「条目详情」与「装回本地」
   * 两个弹窗改成**页面级向导**（P2），不再有 Modal.Header —— 少的那一处是删除而非漏接线，
   * 已逐点复核。新增弹窗时把阈值一起调上去（它只防「整片调用点被静默删掉」）。
   */
  assert.ok(checked >= 12, `应覆盖全部带关闭按钮的调用点（实际 ${checked} 处；被删请同步复核本守卫）`)
})
