/**
 * 概览「最近活动」kind 文案守卫（issue #43：手动备份 vs 定时备份必须可区分）。
 *
 * 背景：overview-view.ts 把已知 kind 归一为 `overview.kind.<kind>`；该 key 是**普通字符串**，
 * 编译器不会像 history 字典（Record<MigrationKind,string>）那样强制补文案——漏配就会在
 * 「最近活动」里显示裸 key。此守卫钉住本次新增的 backup-manual 及其它已登记键的齐备性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { zh, en } from '../locales.ts'
import { overviewKindKey } from '../../ui/overview-view.ts'

/** 概览活动行会直接渲染的 kind 文案键（新增 kind 时在此登记并补 zh/en）。 */
const GUARDED_KEYS = [
  'overview.kind.backup',
  'overview.kind.backup-manual',
  'overview.kind.profile-create',
  'overview.kind.profile-select',
  'overview.kind.other',
] as const

test('overview.kind.*：概览活动文案键在 zh/en 两套字典齐备（不显示裸 key）', () => {
  for (const key of GUARDED_KEYS) {
    assert.ok(key in zh, `zh 缺少概览文案：${key}`)
    assert.ok(key in en, `en 缺少概览文案：${key}`)
    assert.notEqual(zh[key], '', `zh 文案不得为空：${key}`)
    assert.notEqual(en[key], '', `en 文案不得为空：${key}`)
  }
})

test('overviewKindKey：已知 kind 直映、未知 kind 归一为 other', () => {
  assert.equal(overviewKindKey('backup'), 'overview.kind.backup')
  assert.equal(overviewKindKey('backup-manual'), 'overview.kind.backup-manual')
  assert.equal(overviewKindKey('nonsense'), 'overview.kind.other')
})

test('概览活动里手动/定时备份可区分（中文标签已定稿）', () => {
  assert.notEqual(overviewKindKey('backup'), overviewKindKey('backup-manual'))
  assert.equal(zh['overview.kind.backup'], '定时备份')
  assert.equal(zh['overview.kind.backup-manual'], '手动备份')
  assert.equal(en['overview.kind.backup'], 'Scheduled backup')
  assert.equal(en['overview.kind.backup-manual'], 'Manual backup')
})
