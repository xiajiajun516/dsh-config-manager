/**
 * badge-tone 单测：四态 → 原生 Tag tone 的映射必须稳定（React 壳只装配，语义在这一层可测）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BADGE_TONE, badgeTone, type BadgeKind } from './badge-tone.ts'

test('badge-tone：四态各自映射到原生 Tag 的 tone', () => {
  assert.equal(badgeTone('ok'), 'success')
  assert.equal(badgeTone('warn'), 'warning')
  assert.equal(badgeTone('error'), 'danger')
  assert.equal(badgeTone('info'), 'info')
})

test('badge-tone：映射表覆盖全部四态且 tone 都是原生调色板里的值', () => {
  const kinds: BadgeKind[] = ['info', 'ok', 'warn', 'error']
  const palette = new Set(['outline', 'solid', 'neutral', 'quiet', 'success', 'info', 'warning', 'danger'])
  for (const k of kinds) {
    assert.ok(BADGE_TONE[k] !== undefined, k + ' 缺少映射')
    assert.ok(palette.has(BADGE_TONE[k]), BADGE_TONE[k] + ' 不在原生 Tag 调色板内')
  }
  assert.equal(Object.keys(BADGE_TONE).length, kinds.length)
})
