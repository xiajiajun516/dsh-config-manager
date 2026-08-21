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

test('prepare：zip 含 sessions 分区拒绝（历史会话禁止进入市场条目）', () => {
  assert.throws(
    () => prepareMarketItem({
      itemId: 'sess', name: 'Sess', zipBytes: makeValidZip({ sections: { settings: true, sessions: true } }),
    }),
    (err: unknown) => err instanceof MarketPrepareError && /sessions|历史会话/.test(err.message),
  )
})

test('prepare：zip 含 pluginFiles 分区拒绝（任意文件直通，禁止进入市场）', () => {
  assert.throws(
    () => prepareMarketItem({
      itemId: 'pf', name: 'PF', zipBytes: makeValidZip({ sections: { settings: true, pluginFiles: true } }),
    }),
    (err: unknown) => err instanceof MarketPrepareError && /pluginFiles/.test(err.message),
  )
})

test('prepare：zip 含 self 分区拒绝（本地环境专属，禁止进入市场）', () => {
  assert.throws(
    () => prepareMarketItem({
      itemId: 'selfp', name: 'SelfP', zipBytes: makeValidZip({ sections: { settings: true, self: true } }),
    }),
    (err: unknown) => err instanceof MarketPrepareError && /self/.test(err.message),
  )
})

test('prepare：内容级秘密扫描拒绝（providers 分区含 apiKey 值，即使 containsSecrets=false）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2)
  const providersJson = JSON.stringify({ version: 1, providers: { deepseek: { apiKey: 'sk-proj-9f8e7d6c5b4a3210abcdef' } } }, null, 2)
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'ai/providers.json', data: Buffer.from(providersJson) },
  ]
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: { settings: true, providers: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) })
  const zip = Buffer.from(zipToBuffer(entries))
  // containsSecrets=false 骗过标记闸门 → 内容级扫描应兜底拒绝
  assert.throws(
    () => prepareMarketItem({ itemId: 'pv', name: 'PV', zipBytes: zip }),
    (err: unknown) => err instanceof MarketPrepareError && /敏感内容/.test(err.message),
  )
})

test('prepare：插件/MCP 配置中的占位/模板引用/示例不误报（2026-08-21 优化）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2)
  // plugins 分区：插件配置里常见的「环境变量模板引用 + 占位头」形态（真实结构为数组）
  const pluginsJson = JSON.stringify({
    version: 1,
    plugins: [
      {
        name: 'mcp-server',
        enabled: true,
        config: {
          headers: { Authorization: 'Bearer <token>' },
          apiKey: '${OPENAI_API_KEY}',
          max_tokens: 4096,
          baseUrl: 'https://api.example.com',
        },
      },
    ],
  }, null, 2)
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'plugins/plugins.json', data: Buffer.from(pluginsJson) },
  ]
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: { settings: true, plugins: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) })
  const zip = Buffer.from(zipToBuffer(entries))
  const res = prepareMarketItem({ itemId: 'mcp', name: 'MCP', zipBytes: zip, now: FIXED_NOW })
  const manifestOut = JSON.parse(res.manifestText) as { sections: string[] }
  assert.deepEqual(manifestOut.sections, ['settings', 'plugins'])
})

test('prepare：skill 文档中的示例代码/占位符不误报；真实密钥仍拦截', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2)
  // skills 分区（文件类，scanText）：示例文档 + 一个真实密钥文件
  const skillDoc = [
    '# 使用示例',
    'token: ${API_TOKEN}',
    'password: your-token-here',
    'api_key: sk-your-api-key-here',
    'Authorization: Bearer example-token-here',
  ].join('\n')
  const realDoc = 'client_secret: s3cretP@ssw0rdXyZ2024'
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'custom/skills/example.md', data: Buffer.from(skillDoc) },
    { name: 'custom/skills/real.md', data: Buffer.from(realDoc) },
  ]
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: { settings: true, skills: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) })
  const zip = Buffer.from(zipToBuffer(entries))
  // 示例文档放行，但真实密钥文件仍触发拦截（命中报告含 skills 前缀）
  assert.throws(
    () => prepareMarketItem({ itemId: 'sk', name: 'SK', zipBytes: zip }),
    (err: unknown) => err instanceof MarketPrepareError && /疑似敏感内容.*skills/.test(err.message),
  )
})

test('prepare：内容级扫描豁免 env 引用名（apiKeyEnv=DEEPSEEK_API_KEY 不误报）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2)
  const providersJson = JSON.stringify({
    version: 1,
    providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' } },
  }, null, 2)
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'ai/providers.json', data: Buffer.from(providersJson) },
  ]
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: { settings: true, providers: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) })
  const zip = Buffer.from(zipToBuffer(entries))
  const res = prepareMarketItem({ itemId: 'pv2', name: 'PV2', zipBytes: zip, now: FIXED_NOW })
  const manifestOut = JSON.parse(res.manifestText) as { sections: string[] }
  assert.deepEqual(manifestOut.sections, ['settings', 'providers'])
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
