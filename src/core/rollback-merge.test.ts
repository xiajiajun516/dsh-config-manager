/**
 * 三方合并内核的单元测试（2026-10-17 跨对话安全回退）。
 *
 * 每条都用**真实文本**断言最终内容 —— 这个模块的产出会被直接写进用户的工作区文件，
 * 「函数返回了 true」不算证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeThreeWay } from './rollback-merge.ts'
import { encodeTextBytes } from './text-fidelity.ts'

test('M-1 不同区域：撤销 ours 的改动、保留 theirs 的改动', () => {
  const ours = ['function main() {', '  const a = 1', '  const b = 2', '  log(a + b)', '}'].join('\n') + '\n'
  const base = ['function main() {', '  // A 加的注释', '  const b = 2', '  log(a + b)', '}'].join('\n') + '\n'
  const theirs = ['function main() {', '  // A 加的注释', '  const b = 2', '  log(b)', '}'].join('\n') + '\n'
  // ours 撤销了 A 的那行注释（base→ours 删除），theirs 改的是最后一行（base→theirs 修改）
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.conflicts, 0)
  const lines = r.text.split('\n')
  assert.equal(lines.includes('  // A 加的注释'), false, 'A 的注释被撤销')
  assert.equal(lines.includes('  log(b)'), true, 'B 的改动被保留')
  assert.equal(lines.includes('  log(a + b)'), false)
})

test('M-2 同一行被两侧改过 ⇒ 报冲突、ok=false、文本回落 theirs', () => {
  const ours = 'a\nB-ours\nc\n'
  const base = 'a\nb\nc\n'
  const theirs = 'a\nB-theirs\nc\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'conflict')
  assert.equal(r.conflicts, 1)
  assert.equal(r.text, theirs, '冲突时绝不给出半截合并结果')
})

test('M-3 同一插入点写不同内容 ⇒ 冲突（不擅自决定顺序）', () => {
  const base = 'a\nc\n'
  const ours = 'a\nOURS\nc\n'
  const theirs = 'a\nTHEIRS\nc\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'conflict')
})

test('M-4 两侧做的是**同一件事** ⇒ 不算冲突', () => {
  const base = 'a\nb\nc\n'
  const ours = 'a\nX\nc\n'
  const theirs = 'a\nX\nc\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'a\nX\nc\n')
})

test('M-5 不同插入点：两边都保留', () => {
  const base = 'a\nb\nc\n'
  const ours = 'a\nOURS\nb\nc\n'
  const theirs = 'a\nb\nc\nTHEIRS\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.text, 'a\nOURS\nb\nc\nTHEIRS\n')
})

test('M-6 ours 删除一块、theirs 改另一块 ⇒ 干净合并', () => {
  const base = 'keep1\ndoomed\nkeep2\ntail\n'
  const ours = 'keep1\nkeep2\ntail\n'
  const theirs = 'keep1\ndoomed\nkeep2\nTAIL\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.text, 'keep1\nkeep2\nTAIL\n')
})

test('M-7 二进制任一侧 ⇒ 不合并（reason=binary）', () => {
  const base = 'a\u0000b\n'
  const r = mergeThreeWay('x\n', base, 'y\n')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'binary')
})

test('M-8 本会话没改过（ours==base）⇒ 保持对方当前内容（不是失败）', () => {
  const base = 'a\nb\n'
  const theirs = 'a\nB2\n'
  const r = mergeThreeWay(base, base, theirs)
  assert.equal(r.ok, true)
  assert.equal(r.text, theirs)
  assert.equal(r.revertedLines, 0)
})

test('M-9 对方没改过（theirs==base）⇒ 回到 ours', () => {
  const base = 'a\nb\n'
  const ours = 'a\nO\n'
  const r = mergeThreeWay(ours, base, base)
  assert.equal(r.ok, true)
  assert.equal(r.text, ours)
})

test('M-10 尾换行跟随当前磁盘的形态', () => {
  const base = 'a\nb\nc\n'
  const ours = 'a\nO1\nc\n'
  const theirsNoTail = 'a\nb\nC2'
  const r = mergeThreeWay(ours, base, theirsNoTail)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.text.endsWith('\n'), false, '磁盘没有尾换行就不擅自补')
})

test('M-11 依赖风险提示：被撤销的行里的标识符仍在结果中被引用（启发式）', () => {
  const base = ['export function helperThing() {', '  return 1', '}', 'runSomething(helperThing)'].join('\n') + '\n'
  // ours（回退目标）里没有 helperThing —— 撤销它会删掉该函数
  const ours = 'runSomething(helperThing)\n'
  // theirs 仍在调用它
  const theirs = ['export function helperThing() {', '  return 1', '}', 'runSomething(helperThing)', 'moreCode()'].join('\n') + '\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.ok(r.risks.includes('helperThing'), '必须提示这个可能仍被引用的标识符：' + JSON.stringify(r.risks))
})

test('M-12 一侧删除一块、另一侧正好在该块之后追加 ⇒ 不算冲突（真机 2026-10-17 形状）', () => {
  const base = '# T\n\nA-line\n'
  const ours = '# T\n'
  const theirs = '# T\n\nA-line\nB-line'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.text, '# T\nB-line', '撤销 A 那一行、保留 B 追加的那一行')
})

test('M-13 插入点落在被删区间**内部** ⇒ 仍然是冲突', () => {
  const base = 'a\nMID1\nMID2\nc\n'
  const ours = 'a\nc\n'
  const theirs = 'a\nMID1\nB\nMID2\nc\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'conflict')
})

/* ── 2026-10-18 文本保真缺陷（CRLF 被折断 / BOM / 非 UTF-8 写回）的回归 ── */

test('M-14 CRLF 文件：撤销本会话改动后**行尾仍是 CRLF**（旧实现会把整份文件折成 LF）', () => {
  const base = 'a\r\nKEEP\r\nDOOMED\r\nx\r\n'
  const ours = 'a\r\nKEEP\r\nx\r\n' // 本会话删掉了 DOOMED
  const theirs = 'a\r\nKEEP\r\nDOOMED\r\nX2\r\n' // 别人改了尾行
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(r.shape, { eol: '\r\n', bom: false })
  assert.equal(r.text, 'a\r\nKEEP\r\nX2\r\n')
  assert.equal(r.eolMixed, false)
  assert.equal(r.eolRewritten, false)
  // 旧实现产出 'a\nKEEP\nX2\n'：这里直接查「前面不是 CR 的 LF」——那正是被折过的证据
  assert.equal(/[^\r]\n/.test(r.text), false, '不得出现被折成 LF 的行尾')
  assert.equal(r.revertedLines, 1)
})

test('M-15 CRLF 且磁盘没有尾换行 ⇒ 输出同样不补尾换行（尾换行跟随 theirs）', () => {
  const base = 'a\r\nb\r\nc\r\n'
  const ours = 'a\r\nO1\r\nc\r\n'
  const theirs = 'a\r\nb\r\nC2'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(r.shape, { eol: '\r\n', bom: false })
  assert.equal(r.text, 'a\r\nO1\r\nC2')
  assert.equal(r.text.endsWith('\n'), false, '磁盘没有尾换行就不擅自补')
})

test('M-16 显式 shape 优先（判据 3）：CRLF 输入也能按 LF 输出，并如实标注行尾被改写', () => {
  const base = 'a\r\nb\r\n'
  const ours = 'a\r\nO\r\n'
  const theirs = 'a\r\nb\r\nT\r\n'
  const r = mergeThreeWay(ours, base, theirs, { shape: { eol: '\n', bom: false } })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.shape.eol, '\n')
  assert.equal(r.eolRewritten, true, '与输入风格不同 ⇒ 必须如实标注')
  assert.equal(r.text, 'a\nO\nT\n')
})

test('M-17 混合行尾：按 theirs 的主导 EOL 输出，并如实标注 eolMixed（判据 5）', () => {
  const base = 'a\r\nb\r\nc\r\n'
  const ours = 'a\r\nO\r\nc\r\n'
  const theirs = 'a\r\nb\r\nT\r\nU\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.shape.eol, '\r\n', '2 个 CRLF 对 1 个 LF ⇒ 主导 CRLF')
  assert.equal(r.eolMixed, true, '输入里出现两种行尾 ⇒ 必须标注')
  assert.equal(r.eolRewritten, true)
  assert.equal(r.text, 'a\r\nO\r\nT\r\nU\r\n')
})

test('M-18 BOM：前导 U+FEFF 归 shape 承载（正文不残留），encode 后逐字节复原', () => {
  const base = '\uFEFFa\nb\n'
  const ours = '\uFEFFa\nO\n'
  const theirs = '\uFEFFa\nb\nT\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.shape.bom, true, '不得静默丢 BOM')
  assert.equal(r.text.startsWith('\uFEFF'), false, '正文里不残留 BOM 字符（否则 encode 会写出双 BOM）')
  assert.equal(r.text, 'a\nO\nT\n')
  assert.deepEqual(
    [...encodeTextBytes(r.text, r.shape)],
    [...new TextEncoder().encode('\uFEFFa\nO\nT\n')],
    '带 shape 落盘必须逐字节复原（含 BOM）',
  )
})

test('M-19 孤立代理项（无法 UTF-8 无损编码）⇒ reason=non-utf8、ok=false、回落 theirs', () => {
  const r = mergeThreeWay('a\n\uD83D\n', 'a\nb\n', 'a\nb\nT\n')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'non-utf8')
  assert.equal(r.text, 'a\nb\nT\n', 'ok:false 时 text 一律是 theirs 原文（供比较，绝不写入）')
})

test('M-20 孤立 CR（TextShape 表示不了）⇒ reason=non-utf8，绝不悄悄改成 LF', () => {
  const ours = 'a\rO\r'
  const r = mergeThreeWay(ours, 'a\rb\r', 'a\rb\rT\r')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'non-utf8')
  assert.equal(r.text, 'a\rb\rT\r')
})

test('M-21 每个分支都带 shape / eolMixed / eolRewritten（调用方无需猜）', () => {
  const binary = mergeThreeWay('x\n', 'a\u0000b\n', 'y\n')
  assert.equal(binary.reason, 'binary')
  assert.deepEqual(binary.shape, { eol: '\n', bom: false })
  const conflict = mergeThreeWay('a\nB-o\nc\n', 'a\nb\nc\n', 'a\nB-t\nc\n')
  assert.equal(conflict.reason, 'conflict')
  assert.deepEqual(conflict.shape, { eol: '\n', bom: false })
  assert.equal(conflict.text, 'a\nB-t\nc\n')
  const clean = mergeThreeWay('a\nb\n', 'a\nb\n', 'a\nb\nT\n')
  assert.equal(clean.reason, 'clean')
  assert.deepEqual(clean.shape, { eol: '\n', bom: false })
  assert.equal(clean.eolMixed, false)
  assert.equal(clean.eolRewritten, false)
})

test('M-22 未传 shape ⇒ 从 theirs 探测形态（不是拿 base / ours 猜）', () => {
  const base = 'a\nb\n'
  const ours = 'a\nO\n'
  const theirs = 'a\r\nb\r\nT\r\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(r.shape, { eol: '\r\n', bom: false })
  assert.equal(r.eolMixed, true, 'base/ours 是 LF、theirs 是 CRLF ⇒ 如实标注风格不一致')
  assert.equal(r.text, 'a\r\nO\r\nT\r\n')
})

test('M-23 空文件 / 空 theirs：不凭空行、不补尾换行、不失败', () => {
  const both = mergeThreeWay('', 'a\n', '')
  assert.equal(both.ok, true)
  assert.equal(both.text, '')
  assert.equal(mergeThreeWay('a\r\nb\r\n', 'a\r\nb\r\n', '').text, '', 'theirs 为空 ⇒ 结果也为空')
  assert.equal(mergeThreeWay('a\nb', 'a\nb\n', 'a\nb\nT\n').ok, true)
})

test('M-24 BOM + CRLF + 中文 端到端：合并结果 encode 后逐字节符合原形态', () => {
  const base = '\uFEFF第一行\r\n第二行\r\n尾行\r\n'
  const ours = '\uFEFF第一行\r\n尾行\r\n'
  const theirs = '\uFEFF第一行\r\n第二行\r\n尾行2\r\n'
  const r = mergeThreeWay(ours, base, theirs)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(r.shape, { eol: '\r\n', bom: true })
  assert.deepEqual(
    [...encodeTextBytes(r.text, r.shape)],
    [...new TextEncoder().encode('\uFEFF第一行\r\n尾行2\r\n')],
  )
})
