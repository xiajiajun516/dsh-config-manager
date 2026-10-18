/**
 * 方案 A 入口编排单测（node:test，零依赖）：只发**一次**预览请求 + fail-safe 回退。
 * 重点不是「happy path」，而是三条**绝不挡老路径**的判据：无基准、请求抛错、宿主 ok=false。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSmartSync } from './sync-entry.ts'
import type { MergePreviewResponse, SyncApi } from './sync-api.ts'

/** 假 api：只记录 mergePreview 的调用次数（其余成员本测试用不到）。 */
function fakeApi(result: MergePreviewResponse | Error): { api: SyncApi; calls: () => number } {
  let calls = 0
  const api = {
    mergePreview: async (): Promise<MergePreviewResponse> => {
      calls += 1
      if (result instanceof Error) throw result
      return result
    },
  } as unknown as SyncApi
  return { api, calls: () => calls }
}

function preview(overrides: Partial<MergePreviewResponse> = {}): MergePreviewResponse {
  return {
    ok: true,
    snapshotId: 'snap-1',
    hasAncestor: true,
    sections: [{ id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [] }],
    summary: { auto: 0, review: 1, conflicts: 1, skipped: 0 },
    ...overrides,
  }
}

const deps = (api: SyncApi, hasBaseline: unknown, decryptPassword?: string) => ({
  api,
  hasBaseline,
  channelPayload: () => ({}),
  ...(decryptPassword === undefined ? {} : { decryptPassword }),
})

test('sync-entry: 无基准（含未知/缺省）→ fallback，且**零请求**（行为与方案 A 之前逐字一致）', async () => {
  for (const hasBaseline of [undefined, false, null, 'true', 1]) {
    const { api, calls } = fakeApi(preview())
    const out = await resolveSmartSync(deps(api, hasBaseline))
    assert.deepEqual(out, { kind: 'fallback' }, 'hasBaseline=' + String(hasBaseline))
    assert.equal(calls(), 0, '无基准时不得发预览请求')
  }
})

test('sync-entry: 有基准 + 有变更 → merge，且**只请求一次**并原样复用该 preview', async () => {
  const seeded = preview()
  const { api, calls } = fakeApi(seeded)
  const out = await resolveSmartSync(deps(api, true))
  assert.equal(out.kind, 'merge')
  assert.equal(calls(), 1, '预览只取一次（视图不得二次请求）')
  assert.equal(out.kind === 'merge' ? out.preview : null, seeded, '复用同一次结果（同一引用）')
})

test('sync-entry: 有基准 + 全 skip → upToDate（提示已是最新，不写任何东西）', async () => {
  const { api, calls } = fakeApi(preview({ sections: [{ id: 'settings', decision: 'skip', conflictCount: 0, conflicts: [] }] }))
  assert.deepEqual(await resolveSmartSync(deps(api, true)), { kind: 'upToDate' })
  assert.equal(calls(), 1)
})

test('sync-entry: 预览请求抛错 → fallback + 错误文本（新入口绝不挡住老路径）', async () => {
  const { api, calls } = fakeApi(new Error('network down'))
  const out = await resolveSmartSync(deps(api, true))
  assert.equal(out.kind, 'fallback')
  assert.equal(out.kind === 'fallback' ? out.error : null, 'network down')
  assert.equal(calls(), 1)
})

test('sync-entry: 宿主 ok=false → fallback + 宿主 message（如实带出原因，不回退成静默）', async () => {
  const { api } = fakeApi(preview({ ok: false, sections: [], message: '远端没有快照' }))
  const out = await resolveSmartSync(deps(api, true))
  assert.deepEqual(out, { kind: 'fallback', error: '远端没有快照' })
})
