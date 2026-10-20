/**
 * T-ui-merge：远程合并裁决**纯函数**单测（node:test，零依赖、无 DOM）。
 *
 * 覆盖验收：决策/成因字典映射（禁止裸枚举）、冲突行投影与截断+redact、
 * 保守缺省（空草稿 = 未点名的分区引擎不应用）、批量裁决语义、裁决计数与可应用判据、结果归一化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyBulkResolution, buildMergeResolutions, decideSyncEntry, hasApplicableSections, initialResolutionDraft,
  mergeDecisionCounts, mergeDecisionKey, mergeDecisionTone, mergeKindKey, mergeReasonKey,
  mergeResultView, mergeSectionRows, mergeSummaryItems, needsNoAncestorNotice,
  normalizeDecision, setSectionAction, truncatePreview, MERGE_PREVIEW_MAX_CHARS,
} from './merge-view.ts'
import type { MergePreviewResponse, MergePreviewSection, MergeSectionDecision } from './sync-api.ts'

/** 构造一份预览（分区 id 用真实 SectionId 形态，便于与宿主口径对齐）。 */
function preview(overrides: Partial<MergePreviewResponse> = {}): MergePreviewResponse {
  return {
    ok: true,
    snapshotId: 'snap-1',
    hasAncestor: true,
    sections: [],
    summary: { auto: 0, review: 0, conflicts: 0, skipped: 0 },
    ...overrides,
  }
}

test('merge-view: normalizeDecision —— 未知值 fail-closed 归入「需裁决」，不静默当无变化', () => {
  assert.equal(normalizeDecision('useRemote'), 'useRemote')
  assert.equal(normalizeDecision('conflict'), 'conflict')
  assert.equal(normalizeDecision('brand-new-decision'), 'conflict')
  assert.equal(normalizeDecision(undefined), 'conflict')
  assert.equal(normalizeDecision(42), 'conflict')
})

test('merge-view: 决策/成因/类型一律经字典键映射（界面不出现裸枚举）', () => {
  assert.equal(mergeDecisionKey('merge'), 'merge.decision.merge')
  assert.equal(mergeDecisionKey('nope'), 'merge.decision.conflict')
  assert.equal(mergeDecisionTone('merge'), 'ok')
  assert.equal(mergeDecisionTone('conflict'), 'warn')
  assert.equal(mergeReasonKey('modify-delete'), 'merge.reason.modifyDelete')
  assert.equal(mergeReasonKey('unknown-reason'), 'merge.reason.bothModified')
  assert.equal(mergeReasonKey(undefined), 'merge.reason.bothModified')
  assert.equal(mergeKindKey('file'), 'merge.kind.file')
  assert.equal(mergeKindKey('key'), 'merge.kind.key')
  assert.equal(mergeKindKey(undefined), 'merge.kind.key')
})

test('merge-view: truncatePreview —— 渲染前再过一次 redact，且按上限截断', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345'
  const masked = truncatePreview('Authorization: ' + secret)
  assert.ok(masked.includes('REDACTED'), '密钥形状必须被掩码，实际：' + masked)
  assert.ok(!masked.includes(secret))
  assert.equal(truncatePreview(undefined), '')
  assert.equal(truncatePreview(null), '')
  assert.equal(truncatePreview(123), '123', '非字符串按 String() 展示，绝不 undefined')
  const long = 'x'.repeat(MERGE_PREVIEW_MAX_CHARS + 40)
  const cut = truncatePreview(long)
  assert.equal(cut.length, MERGE_PREVIEW_MAX_CHARS + 1, '截断到上限 + 一个省略号')
  assert.ok(cut.endsWith('…'))
})

test('merge-view: mergeSectionRows —— conflict 分区需裁决且「自动合并」不可用；merge 分区可用', () => {
  const p = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [{ path: 'foo', kind: 'key', reason: 'both-modified', localPreview: 'l', remotePreview: 'r', ancestorPreview: 'a' }] },
      { id: 'providers', decision: 'merge', autoMerged: 2, conflictCount: 0, conflicts: [] },
    ],
  })
  const rows = mergeSectionRows(p)
  assert.equal(rows.length, 2)
  const conflict = rows[0]!
  assert.equal(conflict.needsDecision, true)
  assert.equal(conflict.canUseMerged, false, 'conflict 分区没有 merged 载荷 → 采用自动合并必须禁用')
  assert.equal(conflict.resolutionId, 'settings', '裁决单 id = 分区 id（无复合 id）')
  assert.deepEqual(conflict.conflicts[0], {
    path: 'foo',
    kindKey: 'merge.kind.key',
    reasonKey: 'merge.reason.bothModified',
    localPreview: 'l',
    remotePreview: 'r',
    ancestorPreview: 'a',
  })
  const merged = rows[1]!
  assert.equal(merged.needsDecision, false)
  assert.equal(merged.canUseMerged, true)
  assert.equal(merged.autoMerged, 2)
})

test('merge-view: mergeSectionRows —— 缺字段时用冲突数组长度兜底，不显示 undefined', () => {
  const p = preview({
    sections: [{ id: 'mcp', decision: 'conflict', conflictCount: undefined as unknown as number, conflicts: [{ path: 'a', kind: 'key', localPreview: '', remotePreview: '', ancestorPreview: '' }] }],
  })
  const rows = mergeSectionRows(p)
  assert.equal(rows[0]!.conflictCount, 1)
  assert.equal(rows[0]!.autoMerged, null)
})

test('merge-view: initialResolutionDraft —— 空草稿（未点名的分区引擎不应用，界面不再预置 skip）', () => {
  const p = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 2, conflicts: [] },
      { id: 'providers', decision: 'useRemote', conflictCount: 0, conflicts: [] },
    ],
  })
  assert.deepEqual(initialResolutionDraft(p), {}, '空草稿：请求体里不出现任何分区')
  assert.deepEqual(initialResolutionDraft(null), {})
  assert.deepEqual(buildMergeResolutions({}), [], '空草稿 = 空请求体')
})

test('merge-view: 批量裁决 —— 本地/远端覆盖全部分区；自动合并只碰 merge 分区；留到下次 = 清空待裁决', () => {
  const p = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [] },
      { id: 'mcp', decision: 'conflict', conflictCount: 1, conflicts: [] },
      { id: 'providers', decision: 'merge', autoMerged: 1, conflictCount: 0, conflicts: [] },
    ],
  })
  const base = initialResolutionDraft(p)
  assert.deepEqual(applyBulkResolution(p, base, 'useRemote'), { settings: 'useRemote', mcp: 'useRemote', providers: 'useRemote' })
  assert.deepEqual(applyBulkResolution(p, base, 'keepLocal'), { settings: 'keepLocal', mcp: 'keepLocal', providers: 'keepLocal' })
  assert.deepEqual(
    applyBulkResolution(p, base, 'useMerged'),
    { providers: 'useMerged' },
    'conflict 分区不因批量操作被静默改成别的动作，只有有 merged 载荷的分区可写 useMerged',
  )
  assert.deepEqual(applyBulkResolution(p, base, 'leavePending'), {}, '冲突留到下次 = 把待裁决分区移出草稿')
  // 已裁决的分区被「留到下次」清掉，未裁决分区本来就不在草稿里
  assert.deepEqual(applyBulkResolution(p, setSectionAction(base, 'settings', 'useRemote'), 'leavePending'), {})
})

test('merge-view: 单分区裁决 + 请求体排序稳定', () => {
  const p = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [] },
      { id: 'mcp', decision: 'conflict', conflictCount: 1, conflicts: [] },
    ],
  })
  const d = setSectionAction(initialResolutionDraft(p), 'mcp', 'useRemote')
  assert.deepEqual(buildMergeResolutions(d), [{ id: 'mcp', action: 'useRemote' }])
  assert.deepEqual(buildMergeResolutions(setSectionAction({}, 'settings', 'keepLocal')), [{ id: 'settings', action: 'keepLocal' }])
})

test('merge-view: hasApplicableSections —— 只要存在「有变化且不需裁决」的分区就可执行（与草稿无关）', () => {
  const onlySkip = preview({ sections: [{ id: 'settings', decision: 'skip', conflictCount: 0, conflicts: [] }] })
  assert.equal(hasApplicableSections(onlySkip), false, '全部无变化 → 执行合并必须禁用')
  assert.equal(hasApplicableSections(null), false)
  const withAuto = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [] },
      { id: 'providers', decision: 'useRemote', conflictCount: 0, conflicts: [] },
    ],
  })
  assert.equal(hasApplicableSections(withAuto), true, '只有冲突 + 一个可应用分区 → 可执行（冲突留待下次）')
  const onlyConflict = preview({ sections: [{ id: 'settings', decision: 'conflict', conflictCount: 1, conflicts: [] }] })
  assert.equal(hasApplicableSections(onlyConflict), false, '只有待裁决分区 → 没有可应用内容')
})

test('merge-view: mergeDecisionCounts —— 待裁决覆盖 + 本次可应用分区数分别可数', () => {
  const p = preview({
    sections: [
      { id: 'settings', decision: 'conflict', conflictCount: 2, conflicts: [] },
      { id: 'mcp', decision: 'conflict', conflictCount: 1, conflicts: [] },
      { id: 'providers', decision: 'merge', autoMerged: 1, conflictCount: 0, conflicts: [] },
      { id: 'skills', decision: 'skip', conflictCount: 0, conflicts: [] },
    ],
  })
  const empty = mergeDecisionCounts(p, {})
  assert.deepEqual(empty, { needsDecision: 2, decided: 0, undecided: 2, conflictItems: 3, applicable: 1 })
  assert.deepEqual(
    mergeDecisionCounts(p, setSectionAction({}, 'settings', 'useRemote')),
    { needsDecision: 2, decided: 1, undecided: 1, conflictItems: 3, applicable: 1 },
  )
  assert.deepEqual(
    mergeDecisionCounts(p, setSectionAction(setSectionAction({}, 'settings', 'useRemote'), 'mcp', 'keepLocal')),
    { needsDecision: 2, decided: 2, undecided: 0, conflictItems: 3, applicable: 1 },
  )
})

test('merge-view: mergeSummaryItems —— 缺字段按 0，绝不 undefined', () => {
  assert.deepEqual(mergeSummaryItems(null), [
    { labelKey: 'merge.summary.auto', value: 0, tone: 'ok' },
    { labelKey: 'merge.summary.review', value: 0, tone: 'warn' },
    { labelKey: 'merge.summary.conflicts', value: 0, tone: 'warn' },
    { labelKey: 'merge.summary.skipped', value: 0, tone: 'info' },
  ])
  assert.equal(mergeSummaryItems(preview({ summary: { auto: 1, review: 2, conflicts: 3, skipped: 4 } }))[2]!.value, 3)
})

test('merge-view: mergeResultView —— pendingConflicts 必须暴露出来（跳过 ≠ 已解决）', () => {
  assert.equal(mergeResultView(null), null)
  const v = mergeResultView({
    ok: false,
    applied: ['settings'],
    skipped: ['mcp'],
    warnings: ['w'],
    restoreId: '',
    rolledBack: true,
    pendingConflicts: ['mcp'],
    failed: [{ itemId: 'x' }],
    ineffective: [{ itemId: 'y', adapter: 'z' }],
  })!
  assert.equal(v.restoreId, null, '空串 restoreId 不当作可回滚')
  assert.equal(v.rollbackFull, null, '旧宿主缺 rollbackFull 不得当成「完整」')
  assert.equal(v.hasPendingConflicts, true)
  assert.deepEqual(v.pendingConflicts, ['mcp'])
  assert.equal(v.failedCount, 1)
  assert.equal(v.ineffectiveCount, 1)
  assert.equal(v.rolledBack, true)
})

test('merge-view: decideSyncEntry —— 无基准/预览失败一律回退老路径（fail-safe），全 skip 视为已最新', () => {
  const sec = (decision: MergeSectionDecision): MergePreviewSection => ({ id: 'settings', decision, conflictCount: 0, conflicts: [] })
  const ok = (sections: MergePreviewSection[]): Pick<MergePreviewResponse, 'ok' | 'sections'> => ({ ok: true, sections })
  assert.equal(decideSyncEntry(undefined, null), 'fallback', '缺省（旧宿主）= 未知 → 老路径')
  assert.equal(decideSyncEntry(false, null), 'fallback')
  assert.equal(decideSyncEntry('true', null), 'fallback', '非布尔 true 一律回退')
  assert.equal(decideSyncEntry(true, null), 'fallback', '预览缺失 → 老路径')
  assert.equal(decideSyncEntry(true, { ok: false, sections: [] }), 'fallback', '宿主明确未产出 → 老路径')
  assert.equal(decideSyncEntry(true, ok([])), 'upToDate', '无分区 = 无差异')
  assert.equal(decideSyncEntry(true, ok([sec('skip'), sec('skip')])), 'upToDate', '全 skip = 已是最新')
  assert.equal(decideSyncEntry(true, ok([sec('skip'), sec('conflict')])), 'merge')
  assert.equal(decideSyncEntry(true, ok([sec('merge')])), 'merge')
  // 宿主未来版本可能回传新决策值：类型上不可能，运行时必须 fail-closed（用 cast 模拟线上数据）
  assert.equal(decideSyncEntry(true, ok([sec('brand-new' as MergeSectionDecision)])), 'merge', '未知决策 fail-closed 归入需裁决')
})

test('merge-view: needsNoAncestorNotice —— hasAncestor=false 才提示，null 预览不提示', () => {
  assert.equal(needsNoAncestorNotice(null), false)
  assert.equal(needsNoAncestorNotice(preview({ hasAncestor: true })), false)
  assert.equal(needsNoAncestorNotice(preview({ hasAncestor: false })), true)
})
