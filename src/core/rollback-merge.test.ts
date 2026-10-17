/**
 * 三方合并内核的单元测试（2026-10-17 跨对话安全回退）。
 *
 * 每条都用**真实文本**断言最终内容 —— 这个模块的产出会被直接写进用户的工作区文件，
 * 「函数返回了 true」不算证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeThreeWay } from './rollback-merge.ts'

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
