/**
 * m-market：prepareMarketItem 纯函数单测（发布向导核心，docs/design/2026-08-19-market-publish-design.md §3.4）。
 * 覆盖：合法生成（manifest/checksums/sections/provenance）、secrets 拒绝、id/repoUrl 校验、
 * zip 结构拒绝、空分区拒绝、可选字段缺省。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { zipToBuffer, type ZipWriteEntry } from '../utils/zip.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { prepareMarketItem, MarketPrepareError } from './prepare.ts'

/** 构造合法 Export config.zip（settings 分区），返回字节。 */
function makeValidZip(overrides: { containsSecrets?: boolean; sections?: Record<string, boolean> } = {}): Uint8Array {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2)
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
  ]
  const checksums = { 'config/settings.json': sha256Hex(Buffer.from(settingsJson)) }
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums)) })
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: overrides.sections ?? { settings: true },
    security: { containsSecrets: overrides.containsSecrets ?? false, encrypted: false, encryption: null },
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) })
  return Buffer.from(zipToBuffer(entries))
}

const FIXED_NOW = '2026-08-19T00:00:00.000Z'

test('prepare：合法 zip → manifest 字段齐全，checksums/sections/provenance 正确', () => {
  const zip = makeValidZip()
  const res = prepareMarketItem({
    itemId: 'my-settings',
    name: '我的设置包',
    version: '2.1.0',
    description: '示例描述',
    author: 'xiaojun',
    categories: ['settings', 'basic'],
    repoUrl: 'https://github.com/xiaojun/items.git',
    zipBytes: zip,
    now: FIXED_NOW,
  })
  const manifest = JSON.parse(res.manifestText) as Record<string, unknown>
  assert.equal(manifest['schemaVersion'], 1)
  assert.equal(manifest['id'], 'my-settings')
  assert.equal(manifest['name'], '我的设置包')
  assert.equal(manifest['version'], '2.1.0')
  assert.equal(manifest['updatedAt'], FIXED_NOW)
  assert.deepEqual(manifest['sections'], ['settings'])
  assert.deepEqual(manifest['categories'], ['settings', 'basic'])
  const checksums = manifest['checksums'] as { zip: string }
  assert.equal(checksums.zip, res.sha256, 'manifest.checksums.zip 与返回 sha256 一致')
  assert.equal(checksums.zip, sha256Hex(zip), 'sha256 为 config.zip 实算值')
  const provenance = manifest['provenance'] as { source: string }
  assert.equal(provenance.source, 'https://github.com/xiaojun/items.git')
  assert.deepEqual(res.sections, ['settings'])
  assert.ok(res.warnings.length >= 1, '供应链警示恒生成')
})

test('prepare：repoUrl 省略 → 无 provenance；version 缺省 1.0.0', () => {
  const res = prepareMarketItem({
    itemId: 'plain',
    name: 'Plain',
    zipBytes: makeValidZip(),
    now: FIXED_NOW,
  })
  const manifest = JSON.parse(res.manifestText) as Record<string, unknown>
  assert.equal(manifest['version'], '1.0.0')
  assert.equal('provenance' in manifest, false)
  assert.equal('categories' in manifest, false)
})

test('prepare：containsSecrets=true 拒绝（市场通道永不携带秘密）', () => {
  assert.throws(
    () => prepareMarketItem({ itemId: 'sec', name: 'Sec', zipBytes: makeValidZip({ containsSecrets: true }) }),
    (err: unknown) => err instanceof MarketPrepareError && /containsSecrets/.test(err.message),
  )
})

test('prepare：非法 id（路径穿越）拒绝', () => {
  assert.throws(
    () => prepareMarketItem({ itemId: '../evil', name: 'Evil', zipBytes: makeValidZip() }),
    (err: unknown) => err instanceof Error && /非法市场条目 id/.test(err.message),
  )
})

test('prepare：非法 repoUrl（含 userinfo）拒绝', () => {
  assert.throws(
    () => prepareMarketItem({
      itemId: 'a', name: 'A', repoUrl: 'https://user:token@github.com/x', zipBytes: makeValidZip(),
    }),
    (err: unknown) => err instanceof MarketPrepareError && /repoUrl 非法/.test(err.message),
  )
})

test('prepare：非法 repoUrl（git@/ssh 形态）拒绝', () => {
  assert.throws(
    () => prepareMarketItem({
      itemId: 'a', name: 'A', repoUrl: 'git@github.com:xiaojun/items.git', zipBytes: makeValidZip(),
    }),
    (err: unknown) => err instanceof MarketPrepareError && /repoUrl 非法/.test(err.message),
  )
})

test('prepare：zip 缺内部 manifest 拒绝', () => {
  const entries: ZipWriteEntry[] = [{ name: 'config/settings.json', data: Buffer.from('{}') }]
  assert.throws(
    () => prepareMarketItem({ itemId: 'a', name: 'A', zipBytes: Buffer.from(zipToBuffer(entries)) }),
    (err: unknown) => err instanceof MarketPrepareError && /缺少内部 manifest/.test(err.message),
  )
})

test('prepare：zip 无启用分区 → 无可发布内容', () => {
  const zip = makeValidZip({ sections: { settings: false } })
  assert.throws(
    () => prepareMarketItem({ itemId: 'a', name: 'A', zipBytes: zip }),
    (err: unknown) => err instanceof MarketPrepareError && /无可发布内容/.test(err.message),
  )
})

test('prepare：name 空拒绝', () => {
  assert.throws(
    () => prepareMarketItem({ itemId: 'a', name: '   ', zipBytes: makeValidZip() }),
    (err: unknown) => err instanceof MarketPrepareError && /name 必填/.test(err.message),
  )
})
