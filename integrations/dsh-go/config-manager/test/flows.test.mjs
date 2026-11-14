import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../lib/hub.js'
import {
  EMPTY_FLOW, executeImport, restoreRun, syncApply, syncBulk, cancelRun, resolveAll, LocalError,
} from '../lib/flows.js'

/** 守卫必须在触网前就拒（手机端不许靠宿主兜底），所以 ctx 故意不给可用 webServer。 */
const offlineCtx = { get: () => null }

function storeWith(flowPatch, syncData) {
  const store = createStore()
  store.set('flow', { ...EMPTY_FLOW, ...flowPatch })
  if (syncData !== undefined) store.set('sync', syncData)
  return store
}

const rejectsWith = (fn, code, detail) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LocalError, `应抛 LocalError，实际 ${error?.name}`)
    assert.equal(error.code, code)
    if (detail !== undefined) assert.equal(error.detail, detail)
    return true
  })
}

test('导入：没有试运行计划不许执行', () => {
  const store = storeWith({ step: null, plan: null })
  rejectsWith(() => executeImport(offlineCtx, store), 'rejected', 'no-plan')
})

test('导入：有未裁决冲突不许执行', () => {
  const store = storeWith({
    step: 'plan',
    zipPath: '/x/a.zip',
    plan: { items: [{ id: 'a', severity: 'info', conflict: 'review' }, { id: 'b', severity: 'info', conflict: null }] },
    resolutions: {},
  })
  rejectsWith(() => executeImport(offlineCtx, store), 'rejected', 'unresolved-conflicts')
})

test('导入：跑着的时候不接受第二个写操作', () => {
  const store = storeWith({ step: 'plan', plan: { items: [] }, job: { kind: 'import', label: 'import', startedAt: 1 } })
  rejectsWith(() => executeImport(offlineCtx, store), 'busy', 'import')
})

test('批量裁决只覆盖可裁决项，Error 项必须留给用户', async () => {
  const store = storeWith({
    step: 'plan',
    zipPath: '/x/a.zip',
    plan: {
      items: [
        { id: 'ok1', severity: 'info', conflict: 'review' },
        { id: 'err1', severity: 'error', conflict: 'review' },
        { id: 'plain', severity: 'info', conflict: null },
      ],
    },
    resolutions: {},
  })
  // replan 会触网失败；这里只关心「哪些项被写进 resolutions」。
  await resolveAll(offlineCtx, store, 'keepCurrent').catch(() => {})
  assert.deepEqual(store.get('flow').resolutions, { ok1: 'keepCurrent' })
})

test('恢复：没有 dry-run 预览不许执行', () => {
  const store = storeWith({ step: null, plan: null })
  rejectsWith(() => restoreRun(offlineCtx, store), 'rejected', 'no-preview')
})

test('恢复：预览里没有 snapshotId 也不许执行', () => {
  const store = storeWith({ step: 'plan', plan: { kind: 'restore' } })
  rejectsWith(() => restoreRun(offlineCtx, store), 'rejected', 'no-preview')
})

test('同步：没有拉取会话不许应用', () => {
  const store = storeWith({ step: null }, { status: null, session: null })
  rejectsWith(() => syncApply(offlineCtx, store), 'rejected', 'no-session')
})

test('同步：冲突项未给 resolution 且要采用远端时不许应用', () => {
  const store = storeWith({ step: null }, {
    status: null,
    session: { syncSessionId: 's', items: [{ itemId: 'a', kind: 'Conflict', adopt: true, hasConflict: true, resolution: null }] },
  })
  rejectsWith(() => syncApply(offlineCtx, store), 'rejected', 'unresolved-conflicts')
})

test('同步批量：只排除 Error，其余按方向覆盖（与 web 版 isBulkDecidable 同口径）', () => {
  const store = storeWith({ step: null }, {
    status: null,
    session: {
      syncSessionId: 's',
      items: [
        { itemId: 'u', kind: 'Update', adopt: false, hasConflict: false, resolution: null },
        { itemId: 'c', kind: 'Conflict', adopt: false, hasConflict: true, resolution: null },
        { itemId: 'e', kind: 'Error', adopt: false, hasConflict: false, resolution: null },
      ],
    },
  })
  syncBulk(store, 'use')
  const items = store.get('sync').session.items
  assert.deepEqual(items.map((i) => [i.itemId, i.adopt, i.resolution]), [['u', true, null], ['c', true, 'useRemote'], ['e', false, null]])
  syncBulk(store, 'keep')
  const kept = store.get('sync').session.items
  assert.deepEqual(kept.map((i) => [i.itemId, i.adopt, i.resolution]), [['u', false, null], ['c', false, 'keepLocal'], ['e', false, null]])
})

test('取消任务：没有 runId 时明确拒绝而不是静默', () => {
  const store = storeWith({ step: 'executing', progress: null })
  assert.rejects(() => cancelRun(offlineCtx, store), (error) => error instanceof LocalError && error.code === 'rejected' && error.detail === 'no-run')
})
