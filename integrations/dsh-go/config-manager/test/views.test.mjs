import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, OVERVIEW, LIBRARY, SYNC, FLOW } from '../lib/hub.js'
import { overviewView, libraryView, syncView, flowView } from '../lib/views.js'
import { makeT } from '../lib/i18n.js'

const TYPES = new Set(['stack', 'row', 'text', 'callout', 'steps', 'compare', 'metric', 'chart', 'progress',
  'image', 'list', 'keyValue', 'table', 'actions', 'options', 'confirm', 'emptyState', 'gallery'])

const caps = { protocol: 1, app: '1.0.16.0', locale: 'zh-CN', surfaces: [], components: [] }
const scope = { sessionId: 's1' }

function walk(node, depth, acc) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const item of node) walk(item, depth, acc); return }
  if (typeof node.type === 'string') {
    acc.nodes += 1
    acc.depth = Math.max(acc.depth, depth)
    assert.ok(TYPES.has(node.type), `未声明的组件类型: ${node.type}`)
    if (typeof node.text === 'string') acc.maxText = Math.max(acc.maxText, [...node.text].length)
    for (const key of ['label', 'title', 'caption']) {
      if (typeof node[key] === 'string') acc.maxLabel = Math.max(acc.maxLabel, [...node[key]].length)
    }
  }
  if (Array.isArray(node.children)) {
    acc.maxChildren = Math.max(acc.maxChildren, node.children.length)
    for (const child of node.children) walk(child, depth + 1, acc)
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'children') continue
    if (value !== null && typeof value === 'object') walk(value, depth, acc)
  }
}

function assertBudget(name, view) {
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  const acc = { nodes: 0, depth: 0, maxChildren: 0, maxText: 0, maxLabel: 0 }
  walk(view, 1, acc)
  assert.ok(view !== null && typeof view === 'object' && !Array.isArray(view), `${name}: 根必须是对象`)
  assert.ok(bytes <= 32 * 1024, `${name}: ${bytes} B 超过 32 KiB`)
  assert.ok(acc.nodes <= 120, `${name}: ${acc.nodes} 个组件超过 120`)
  assert.ok(acc.depth <= 8, `${name}: 深度 ${acc.depth} 超过 8`)
  assert.ok(acc.maxChildren <= 32, `${name}: 单容器 ${acc.maxChildren} 个孩子超过 32`)
  assert.ok(acc.maxText <= 2000, `${name}: 文本过长`)
}

const snap = (i) => ({ id: `snap-${i}`, createdAt: Date.UTC(2026, 10, 1, 12, i), entryCount: 100 + i, hostFileBackupCount: i, beforePluginCount: 3, pinned: i === 0 })
const backup = (i) => ({ name: `backup-${i}.zip`, path: `/x/backup-${i}.zip`, sizeBytes: 1024 * (i + 1), mtimeMs: Date.UTC(2026, 10, 2, 8, i), source: i % 2 === 0 ? 'auto' : 'manual', note: i === 1 ? 'note' : undefined, containerType: 'zip' })

function seeded() {
  const store = createStore()
  store.set(OVERVIEW, {
    status: { ready: true, pluginVersion: '0.9.0', dshVersion: '0.2.1-rc.2', platform: 'android', arch: 'arm64', profile: 'web', installedPluginCount: 4 },
    sync: { ok: true, configured: true, transport: 'gist', hasBaseline: true, lastSyncAt: Date.UTC(2026, 10, 3, 10), sectionCount: 7, autosync: true, credentialConfigured: true, configIssues: [] },
    snapshots: Array.from({ length: 6 }, (_, i) => snap(i)),
    backups: Array.from({ length: 6 }, (_, i) => backup(i)),
    errors: {},
    at: Date.now(),
  })
  store.set(LIBRARY, { snapshots: Array.from({ length: 6 }, (_, i) => snap(i)), backups: Array.from({ length: 6 }, (_, i) => backup(i)), unreadable: null })
  store.set(SYNC, {
    status: { ok: true, configured: true, transport: 'gist', repoUrl: 'gist:abc', hasBaseline: true, lastSyncAt: Date.UTC(2026, 10, 3, 10), sectionCount: 7, autosync: true, configIssues: [] },
    session: {
      syncSessionId: 'sess-1',
      items: Array.from({ length: 12 }, (_, i) => ({
        itemId: `i${i}`, kind: i === 3 ? 'Conflict' : i === 5 ? 'Error' : 'Update', adapter: 'settings',
        description: `item ${i}`, detail: '', severity: i === 5 ? 'error' : 'info',
        adopt: i !== 5, hasConflict: i % 4 === 3, conflictPath: i % 4 === 3 ? `path.${i}` : '', resolution: null,
      })),
    },
    applied: null,
    lastRestoreId: null,
    at: Date.now(),
  })
  return store
}

test('四个面板在空数据下都在预算内（首屏不许因缺数据崩）', () => {
  const store = createStore()
  for (const [name, fn] of [['overview', overviewView], ['library', libraryView], ['sync', syncView], ['flow', flowView]]) {
    for (const lang of ['zh-CN', 'en-US']) {
      assertBudget(`${name}-${lang}-empty`, fn(scope, caps, { store, t: makeT(lang) }))
    }
  }
})

test('四个面板在有数据 / 有错误 / 忙态下都在预算内', () => {
  const store = seeded()
  store.set(FLOW, { tab: 'import', step: 'plan', zipPath: '/x/a.zip', name: 'a.zip', sizeBytes: 2048, containerType: 'zip',
    plan: { items: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, kind: i % 5 === 0 ? 'Conflict' : 'Create', adapter: 'settings', description: `plan item ${i}`, detail: 'd', severity: i === 7 ? 'error' : 'info', conflict: i % 5 === 0 ? 'review' : null })), needsRestart: true },
    strategy: 'merge', resolutions: {}, missingSecrets: 2, job: null, progress: null, result: null, error: null, export: null, sessions: 10 })
  for (const [name, fn] of [['overview', overviewView], ['library', libraryView], ['sync', syncView], ['flow', flowView]]) {
    for (const lang of ['zh-CN', 'en-US']) {
      assertBudget(`${name}-${lang}-loaded`, fn(scope, caps, { store, t: makeT(lang) }))
    }
  }
  store.fail(OVERVIEW, { code: 'api.offline', detail: 'ECONNREFUSED' })
  store.patch(FLOW, { step: 'failed', error: { code: 'api.failed', detail: 'x'.repeat(400) } })
  assertBudget('overview-error', overviewView(scope, caps, { store, t: makeT('zh-CN') }))
  assertBudget('flow-error', flowView(scope, caps, { store, t: makeT('zh-CN') }))
})

test('长任务运行态：进度与取消入口都在预算内', () => {
  const store = seeded()
  store.set(FLOW, { tab: 'import', step: 'executing', zipPath: '/x/a.zip', name: 'a.zip', sizeBytes: 2048, plan: { items: [] },
    job: { kind: 'import', label: 'import', startedAt: Date.now() },
    progress: { runId: 'r1', section: 'settings', item: 7, itemTotal: 40, detail: 'settings.json', pendingDecision: false }, result: null, error: null })
  assertBudget('flow-executing', flowView(scope, caps, { store, t: makeT('zh-CN') }))
  store.patch(FLOW, { tab: 'export', step: 'done', job: null, export: { zipPath: '/x/e.zip', sizeBytes: 4096, phonePath: '/sdcard/Download/DSH-Go/e.zip', phoneErr: null } })
  assertBudget('flow-exported', flowView(scope, caps, { store, t: makeT('zh-CN') }))
})
