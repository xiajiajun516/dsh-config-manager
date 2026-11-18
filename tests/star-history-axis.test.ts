import { test } from 'node:test'
import assert from 'node:assert/strict'

/*
 * 星标图轴口径的钉子：README 里那张图的上限由 scripts/star-history.mjs 现算，
 * 这两条规则是用户明确要求的，改动时不许悄悄漂移。
 *
 * scripts/*.mjs 没有 .d.ts（typecheck 只覆盖 src/ 与 tests/ 的 .ts），按运行时形状取函数；
 * 脚本末尾有主程序守卫，import 不会去请求 GitHub。
 */
// @ts-expect-error -- scripts/star-history.mjs 无类型声明文件
const axis = await import('../scripts/star-history.mjs')

const totalScale = axis.totalScale as (total: number) => { step: number; top: number }
const dailyScale = axis.dailyScale as (peak: number, intervals: number) => { step: number; top: number }

test('左轴上限：362 颗星 → 500（用户举的例子）', () => {
  assert.deepEqual(totalScale(362), { step: 100, top: 500 })
})

test('左轴上限永远是 100 的倍数，且至少高出当前星数 100', () => {
  for (let total = 0; total <= 20000; total += 7) {
    const { step, top } = totalScale(total)
    const base = total + 100
    assert.equal(top % 100, 0, `total=${total} 的 top=${top} 不是 100 的倍数`)
    assert.ok(top >= base, `total=${total} 的 top=${top} 没留出 100 的余量（需要 >= ${base}）`)
    assert.equal(top % step, 0, `total=${total} 的刻度间隔 ${step} 除不尽 top=${top}`)
    assert.ok(top / step <= 6, `total=${total} 的刻度格数 ${top / step} 超过 6 格`)
    assert.ok(top - step < base, `total=${total} 的 top=${top} 多留了一整格（${step}）`)
  }
})

test('右轴：峰值最多占 62.5% 图高，且刻度是整数、与左轴共用格数', () => {
  for (let intervals = 3; intervals <= 6; intervals += 1) {
    for (let peak = 0; peak <= 500; peak += 1) {
      const { step, top } = dailyScale(peak, intervals)
      assert.ok(Number.isInteger(step) && step >= 1, `peak=${peak} intervals=${intervals} 的步长不是正整数：${step}`)
      assert.equal(top, step * intervals)
      assert.ok(top >= peak * 1.6 - 1e-9, `peak=${peak} intervals=${intervals} 的右轴上限 ${top} 没留出 60% 余量`)
      if (peak > 0) assert.ok(peak / top <= 0.625 + 1e-9, `peak=${peak} 占了图高 ${(peak / top) * 100}%`)
    }
  }
})

test('右轴：没有新增时（peak=0）也不出现 0 步长', () => {
  assert.deepEqual(dailyScale(0, 5), { step: 1, top: 5 })
})
