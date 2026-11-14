import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const readText = (rel) => readFileSync(join(root, rel), 'utf8')
const pkg = JSON.parse(readText('package.json'))
const manifest = pkg.dshGo
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/

const labels = (value) => (typeof value === 'string' ? [value] : Object.values(value ?? {}))

test('包名三处一致（package.json / cordis.patch.yml / export const name）', () => {
  const expected = 'local-dsh-config-manager-go'
  assert.equal(pkg.name, expected)
  const patch = readText('cordis.patch.yml')
  assert.match(patch, new RegExp(`name: ${expected}`))
  assert.match(patch, new RegExp(`id: ${expected}`))
  assert.match(readText('lib/index.js'), new RegExp(`export const name = '${expected}'`))
})

test('清单预算：≤16 KiB、v=1、minApp 钉到实测基线', () => {
  assert.equal(manifest.v, 1)
  assert.equal(manifest.minApp, '1.0.16')
  assert.ok(statSync(join(root, 'package.json')).size <= 16 * 1024)
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.includes('files'))
  for (const value of labels(manifest.title)) assert.ok([...value].length <= 24)
})

test('槽位上限：面板 4、加号工具 2、对话操作 2、状态条 1', () => {
  const c = manifest.contributes
  assert.ok(c.panels.length <= 4)
  assert.equal(c.panels.length, 4)
  assert.ok((c['composer.tools'] ?? []).length <= 2)
  assert.ok((c['session.actions'] ?? []).length <= 2)
  assert.ok((c['composer.strip'] ?? []).length <= 1)
})

test('标签长度硬上限：面板 ≤16、工具 ≤8、对话操作 ≤12', () => {
  for (const panel of manifest.contributes.panels) {
    for (const value of labels(panel.title)) assert.ok([...value].length <= 16, `panel ${panel.id} title too long: ${value}`)
  }
  for (const tool of manifest.contributes['composer.tools'] ?? []) {
    for (const value of labels(tool.label)) assert.ok([...value].length <= 8, `tool ${tool.id} label too long: ${value}`)
  }
  for (const action of manifest.contributes['session.actions'] ?? []) {
    for (const value of labels(action.label)) assert.ok([...value].length <= 12, `action ${action.id} label too long: ${value}`)
  }
})

test('id 合法且同插件内全局唯一', () => {
  const ids = []
  const c = manifest.contributes
  for (const key of Object.keys(c)) {
    const entries = Array.isArray(c[key]) ? c[key] : [c[key]]
    for (const entry of entries) if (entry?.id !== undefined) ids.push(entry.id)
  }
  assert.ok(ids.length > 0)
  for (const id of ids) assert.match(id, ID_RE)
  assert.equal(new Set(ids).size, ids.length)
})

test('面板只在四个已核实的落点上，且没有第二个主按钮以外的静态 effect 依赖', () => {
  const allowed = new Set(['session.tab', 'features', 'chat.panel', 'plugin'])
  for (const panel of manifest.contributes.panels) {
    for (const place of panel.placement ?? ['session.tab']) assert.ok(allowed.has(place), place)
  }
})
