/**
 * 计划句柄与指纹的单测（D2/D5/D6 的判定基元）：
 * - ModelPlanStore：TTL 过期、容量驱逐、同指纹幂等覆盖、delete 后不可重放
 * - syncMergeFingerprint：绝不把三侧预览文本算进指纹（否则同一裁决清单会因展示文本抖动而「计划已变」）
 * - importPlanFingerprint：只看会改变执行结果的结构字段，description/detail 抖动不影响
 * - stableStringify：对象键序无关
 * - restorePlanFingerprint：只吃 kind/target/blobPath
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_PLAN_MAX, MODEL_PLAN_TTL_MS, ModelPlanStore, importPlanFingerprint, stableStringify, syncMergeFingerprint,
} from './model-tool-plans.ts'
import { restorePlanFingerprint } from './restore-plan-fingerprint.ts'
import type { ImportDecisions, ImportPlan } from './types.ts'
import type { MergePreview } from '../sync/sync-engine.ts'

test('ModelPlanStore：同指纹重复登记 → 同一 id（幂等覆盖），不占额外槽位', () => {
  const store = new ModelPlanStore()
  const a = store.set('restore', 'fp-1', { snapshotId: 's1' })
  const b = store.set('restore', 'fp-1', { snapshotId: 's1' })
  assert.equal(a, 'fp-1')
  assert.equal(b, 'fp-1')
  assert.equal(store.size, 1)
})

test('ModelPlanStore：超过上限驱逐最旧；TTL 过期即失效（不可重放）', async () => {
  const store = new ModelPlanStore()
  for (let i = 0; i < MODEL_PLAN_MAX + 2; i += 1) store.set('import', 'fp-' + i, { zipPath: '/z' })
  assert.equal(store.size, MODEL_PLAN_MAX, '容量上限生效')
  assert.equal(store.get('fp-0'), undefined, '最旧的被驱逐')
  assert.notEqual(store.get('fp-' + (MODEL_PLAN_MAX + 1)), undefined, '最新的保留')

  // 可控时钟：不靠 sleep，直接跨过 TTL。
  const clock = { t: 1_000_000 }
  const shortLived = new ModelPlanStore(() => clock.t)
  shortLived.set('import', 'fp-x', { zipPath: '/z' })
  assert.ok(shortLived.get('fp-x') !== undefined, 'TTL 内可读')
  clock.t += MODEL_PLAN_TTL_MS + 1
  assert.equal(shortLived.get('fp-x'), undefined, '过期记录读不到')
  assert.equal(shortLived.size, 0, '读到过期即清')
  assert.equal(MODEL_PLAN_TTL_MS, 30 * 60 * 1000)
})

test('ModelPlanStore：delete 后同一 id 不可重放', () => {
  const store = new ModelPlanStore()
  store.set('restore', 'fp', { snapshotId: 's1' })
  store.delete('fp')
  assert.equal(store.get('fp'), undefined)
})

test('stableStringify：对象键序不影响结果', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }))
})

test('syncMergeFingerprint：只看裁决清单，三侧预览文本与展示字段不参与', () => {
  const base = {
    ok: true, snapshotId: 'snap', hasAncestor: true,
    sections: [{ id: 'settings', decision: 'review', conflictCount: 1, conflicts: [{ path: 'x', kind: 'key' }] }],
    summary: { auto: 0, review: 1, conflicts: 1, skipped: 0 },
  } as unknown as MergePreview
  const noisy = JSON.parse(JSON.stringify(base)) as MergePreview
  ;(noisy.sections[0]!.conflicts[0] as unknown as Record<string, string>).localPreview = '本地文本 A'
  ;(noisy.sections[0]!.conflicts[0] as unknown as Record<string, string>).remotePreview = '远端文本 B'
  assert.equal(syncMergeFingerprint(base), syncMergeFingerprint(noisy), '展示文本抖动不该让计划失效')

  const changed = JSON.parse(JSON.stringify(base)) as MergePreview
  ;(changed.sections[0] as unknown as Record<string, string>).decision = 'auto'
  assert.notEqual(syncMergeFingerprint(base), syncMergeFingerprint(changed), '裁决变化必须改变指纹')
})

function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    items: [{ id: 'settings:general', kind: 'Skip', adapter: 'settings', description: '描述', severity: 'info' }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: {},
    ...overrides,
  } as ImportPlan
}

const decisions: ImportDecisions = { strategy: 'merge', resolutions: {}, pathMappings: [] }

test('importPlanFingerprint：description/detail 抖动不影响，item kind 或决策变化必须变', () => {
  const plan = makePlan()
  const relabeled = makePlan({
    items: [{ id: 'settings:general', kind: 'Skip', adapter: 'settings', description: '换个说明', severity: 'info' }],
  })
  assert.equal(importPlanFingerprint(plan, decisions), importPlanFingerprint(relabeled, decisions))

  const retyped = makePlan({
    items: [{ id: 'settings:general', kind: 'Update', adapter: 'settings', description: '描述', severity: 'info' }],
  })
  assert.notEqual(importPlanFingerprint(plan, decisions), importPlanFingerprint(retyped, decisions))

  const replaceFirst = { ...decisions, strategy: 'replace' as const }
  assert.notEqual(importPlanFingerprint(plan, decisions), importPlanFingerprint(plan, replaceFirst))
})

test('restorePlanFingerprint：只吃 kind/target/blobPath', () => {
  const a = { actions: [{ kind: 'fileRestore', description: '恢复 a', target: '/a' }] }
  const b = { actions: [{ kind: 'fileRestore', description: '换个说法', target: '/a' }] }
  const c = { actions: [{ kind: 'fileRestore', description: '恢复 a', target: '/b' }] }
  assert.equal(restorePlanFingerprint(a as never), restorePlanFingerprint(b as never))
  assert.notEqual(restorePlanFingerprint(a as never), restorePlanFingerprint(c as never))
})

