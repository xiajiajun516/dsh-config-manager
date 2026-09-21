/**
 * 「档案」页视图模型单测（纯函数，无 IO）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bundleLines, dependencyLines, formatBytes, formatProfileTime, issueLabelKey, profileRowFacts, restartCommand,
  selectionState, shapeLabelKey, sortProfilesForDisplay, summarizeProfiles, validateProfileNameInput,
} from './dsh-profiles-view.ts'
import type { DshProfileMeta } from '../profiles/dsh-profile-shared.ts'

function meta(name: string, over: Partial<DshProfileMeta> = {}): DshProfileMeta {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: {},
    shape: 'generic',
    patchReload: 'live',
    hasNodeModules: false,
    patchEntryCount: 0,
    patchBytes: 0,
    isCurrent: false,
    issues: [],
    updatedAtMs: null,
    ...over,
  }
}

test('validateProfileNameInput：空 / 过长 / 非法字符 / 保留名 / 合法', () => {
  assert.equal(validateProfileNameInput(''), 'required')
  assert.equal(validateProfileNameInput('   '), 'required')
  assert.equal(validateProfileNameInput('x'.repeat(65)), 'tooLong')
  assert.equal(validateProfileNameInput('../x'), 'illegal')
  assert.equal(validateProfileNameInput('a/b'), 'illegal')
  assert.equal(validateProfileNameInput('a\\b'), 'illegal')
  assert.equal(validateProfileNameInput('..'), 'illegal')
  assert.equal(validateProfileNameInput('node_modules'), 'illegal')
  assert.equal(validateProfileNameInput('web'), 'reserved')
  assert.equal(validateProfileNameInput('desktop'), 'reserved')
  assert.equal(validateProfileNameInput('work'), null)
  assert.equal(validateProfileNameInput('  work  '), null)
})

test('selectionState：none / missing / current / pending', () => {
  assert.equal(selectionState(null), 'none')
  assert.equal(selectionState({ name: 'a', exists: false, isCurrent: false }), 'missing')
  assert.equal(selectionState({ name: 'a', exists: true, isCurrent: true }), 'current')
  assert.equal(selectionState({ name: 'a', exists: true, isCurrent: false }), 'pending')
})

test('sortProfilesForDisplay：当前置顶 → 待切换 → 其余按名', () => {
  const list = [meta('zeta'), meta('alpha'), meta('work'), meta('beta')]
  const sorted = sortProfilesForDisplay(list, { currentName: 'work', selectionName: 'beta' })
  assert.deepEqual(sorted.map((p) => p.name), ['work', 'beta', 'alpha', 'zeta'])
  assert.deepEqual(sortProfilesForDisplay(list).map((p) => p.name), ['alpha', 'beta', 'work', 'zeta'])
})

test('summarizeProfiles：形态 / 损坏 / node_modules / patch 条目统计', () => {
  const summary = summarizeProfiles([
    meta('web1', { shape: 'web', hasNodeModules: true, patchEntryCount: 2 }),
    meta('h1', { shape: 'headless' }),
    meta('g1', { shape: 'generic', patchEntryCount: 1 }),
    meta('broken', { issues: ['manifestInvalid'] }),
  ])
  assert.deepEqual(summary, { total: 4, web: 1, headless: 1, generic: 2, broken: 1, withNodeModules: 1, patchEntries: 3 })
  assert.deepEqual(summarizeProfiles([]), { total: 0, web: 0, headless: 0, generic: 0, broken: 0, withNodeModules: 0, patchEntries: 0 })
})

test('profileRowFacts：行内只给计数（不铺开包名清单）', () => {
  const facts = profileRowFacts(meta('web', {
    bundles: ['a', 'b', 'c'],
    dependencies: { x: '^1.0.0', y: '^2.0.0' },
    patchEntryCount: 4,
    hasNodeModules: true,
  }))
  assert.deepEqual(facts, { bundles: 3, patchEntries: 4, deps: 2, hasNodeModules: true })
})

test('bundleLines：保持声明顺序（= patch 应用顺序，不可排序）', () => {
  assert.deepEqual(bundleLines(meta('p', { bundles: ['zeta', 'alpha', 'dsh-base'] })), ['zeta', 'alpha', 'dsh-base'])
  assert.deepEqual(bundleLines(meta('empty', { bundles: [] })), [])
})

test('dependencyLines：按包名排序；spec 为空只给包名', () => {
  assert.deepEqual(
    dependencyLines(meta('p', { dependencies: { zeta: '^3.0.0', alpha: '^1.0.0', bare: '' } })),
    ['alpha ^1.0.0', 'bare', 'zeta ^3.0.0'],
  )
  assert.deepEqual(dependencyLines(meta('none')), [])
})

test('restartCommand / shapeLabelKey / issueLabelKey', () => {
  assert.equal(restartCommand('work'), 'dsh --profile work')
  assert.equal(shapeLabelKey('web'), 'profiles.shape.web')
  assert.equal(shapeLabelKey('headless'), 'profiles.shape.headless')
  assert.equal(shapeLabelKey('generic'), 'profiles.shape.generic')
  assert.equal(issueLabelKey('manifestInvalid'), 'profiles.issue.manifestInvalid')
  assert.equal(issueLabelKey('patchTooLarge'), 'profiles.issue.patchTooLarge')
})

test('formatProfileTime：合法时间戳本地格式 / null 与非法值空串', () => {
  const ms = new Date(2026, 0, 2, 3, 4).getTime()
  assert.equal(formatProfileTime(ms), '2026-01-02 03:04')
  assert.equal(formatProfileTime(null), '')
  assert.equal(formatProfileTime(Number.NaN), '')
})

test('formatBytes：B / KB / MB 与非法输入', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})
