/**
 * Overview 纯渲染模型测试（node:test，零依赖）：指标卡 / 健康判定 / 建议 /
 * 最近活动 / 相对时间 / 空态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOverviewMetrics,
  isoToMs,
  latestBackup,
  latestSnapshot,
  overviewActivity,
  overviewBackupFeedback,
  overviewEmptyState,
  overviewHealth,
  overviewSuggestions,
  relTime,
  type OverviewInputs,
} from './overview-view.ts'

const NOW = Date.parse('2026-09-10T12:00:00Z')

function baseInputs(over: Partial<OverviewInputs> = {}): OverviewInputs {
  return {
    now: NOW,
    backups: null,
    snapshots: null,
    schedule: null,
    sync: null,
    history: null,
    recoveryRequired: false,
    runningCount: 0,
    ...over,
  }
}

/* ---------------- 立即备份反馈 ---------------- */

test('overviewBackupFeedback: success / skipped / failed 按真实结果分流', () => {
  assert.deepEqual(
    overviewBackupFeedback({ status: 'success', consecutiveFailures: 0 }),
    { kind: 'ok', messageKey: 'overview.quick.backupDone' },
  )
  for (const [skipReason, reasonKey] of [
    ['disabled', 'overview.quick.backupSkip.disabled'],
    ['running', 'overview.quick.backupSkip.running'],
    ['conflict', 'overview.quick.backupSkip.conflict'],
    ['mutation-locked', 'overview.quick.backupSkip.mutationLocked'],
  ] as const) {
    assert.deepEqual(
      overviewBackupFeedback({ status: 'skipped', skipReason, consecutiveFailures: 0 }),
      { kind: 'info', messageKey: 'overview.quick.backupSkipped', reasonKey },
    )
  }
  assert.deepEqual(
    overviewBackupFeedback({ status: 'skipped', skipReason: 'future-reason', consecutiveFailures: 0 }),
    {
      kind: 'info',
      messageKey: 'overview.quick.backupSkipped',
      reasonKey: 'overview.quick.backupSkip.unknown',
    },
  )
  assert.deepEqual(
    overviewBackupFeedback({ status: 'failed', error: 'disk full', consecutiveFailures: 1 }),
    { kind: 'error', messageKey: 'overview.quick.backupFailed', error: 'disk full' },
  )
  assert.deepEqual(
    overviewBackupFeedback({ status: 'failed', error: '', consecutiveFailures: 1 }),
    { kind: 'error', messageKey: 'overview.quick.backupFailed', error: null },
  )
})

/* ---------------- relTime / isoToMs ---------------- */

test('relTime: 分钟/小时/天/刚刚与超界', () => {
  assert.deepEqual(relTime(NOW, NOW - 30_000), { unit: 'now', n: 0 })
  assert.deepEqual(relTime(NOW, NOW - 5 * 60_000), { unit: 'min', n: 5 })
  assert.deepEqual(relTime(NOW, NOW - 3 * 3_600_000), { unit: 'hour', n: 3 })
  assert.deepEqual(relTime(NOW, NOW - 2 * 86_400_000), { unit: 'day', n: 2 })
  assert.equal(relTime(NOW, NOW - 8 * 86_400_000), null, '超过 7 天 → null（显示绝对日期）')
  assert.equal(relTime(NOW, NOW + 1000), null, '未来时间无效 → null')
})

test('isoToMs: 合法 ISO / 空串 / 非法串', () => {
  assert.equal(isoToMs('2026-09-10T12:00:00Z'), Date.parse('2026-09-10T12:00:00Z'))
  assert.equal(isoToMs(''), null)
  assert.equal(isoToMs('not-a-date'), null)
  assert.equal(isoToMs(undefined), null)
})

/* ---------------- latestBackup / latestSnapshot ---------------- */

test('latestBackup: 取 mtime 最大者；空/未加载 → null', () => {
  const backups = [
    { name: 'a.zip', sizeBytes: 1, mtimeMs: 100, source: 'manual' as const },
    { name: 'b.zip', sizeBytes: 2, mtimeMs: 300, source: 'auto' as const },
    { name: 'c.zip', sizeBytes: 3, mtimeMs: 200, source: 'manual' as const },
  ]
  assert.equal(latestBackup(backups)?.name, 'b.zip')
  assert.equal(latestBackup([]), null)
  assert.equal(latestBackup(null), null)
})

test('latestSnapshot: 取 createdAt 最大者（ISO 比较）', () => {
  const snapshots = [
    { createdAt: '2026-09-01T00:00:00Z', entryCount: 1 },
    { createdAt: '2026-09-09T00:00:00Z', entryCount: 2 },
    { createdAt: '2026-09-05T00:00:00Z', entryCount: 3 },
  ]
  assert.equal(latestSnapshot(snapshots)?.createdAt, '2026-09-09T00:00:00Z')
  assert.equal(latestSnapshot(null), null)
})

/* ---------------- 指标卡 ---------------- */

test('buildOverviewMetrics: 未加载 → 占位 —（不猜数字）', () => {
  const metrics = buildOverviewMetrics(baseInputs())
  assert.equal(metrics.length, 4)
  for (const m of metrics) {
    if (m.kind === 'count') assert.equal(m.value, '—')
    else assert.equal(m.metaKey, null)
  }
})

test('buildOverviewMetrics: 备份/快照计数 + 最近时间 meta', () => {
  const metrics = buildOverviewMetrics(baseInputs({
    backups: [{ name: 'a.zip', sizeBytes: 1, mtimeMs: NOW - 5 * 60_000, source: 'manual' }],
    snapshots: [{ createdAt: '2026-09-10T11:00:00Z', entryCount: 9 }],
  }))
  assert.equal(metrics[0]!.value, '1')
  assert.equal(metrics[0]!.metaKey, 'meta.lastBackup')
  assert.equal(metrics[1]!.value, '1')
  assert.equal(metrics[1]!.metaKey, 'meta.lastBackup')
})

test('buildOverviewMetrics: 备份/快照为空 → noBackup meta', () => {
  const metrics = buildOverviewMetrics(baseInputs({ backups: [], snapshots: [] }))
  assert.equal(metrics[0]!.metaKey, 'meta.noBackup')
  assert.equal(metrics[1]!.metaKey, 'meta.noBackup')
})

test('buildOverviewMetrics: 定时备份 开/关 + 失败 warn', () => {
  const on = buildOverviewMetrics(baseInputs({
    schedule: { enabled: true, lastRunAt: '2026-09-10T10:00:00Z', lastRunStatus: 'success' },
  }))[2]!
  assert.equal(on.kind, 'state')
  assert.equal(on.valueKey, 'state.on')
  assert.equal(on.metaKey, 'meta.scheduleOn')
  assert.equal(on.metaTone, 'neutral')

  const failed = buildOverviewMetrics(baseInputs({
    schedule: { enabled: true, lastRunAt: '2026-09-10T10:00:00Z', lastRunStatus: 'failed' },
  }))[2]!
  assert.equal(failed.metaKey, 'meta.scheduleFail')
  assert.equal(failed.metaTone, 'warn')

  const off = buildOverviewMetrics(baseInputs({ schedule: { enabled: false } }))[2]!
  assert.equal(off.valueKey, 'state.off')
  assert.equal(off.metaKey, 'meta.scheduleOff')
})

test('buildOverviewMetrics: 同步 配置状态', () => {
  const on = buildOverviewMetrics(baseInputs({
    sync: { configured: true, lastSyncAt: '2026-09-10T10:00:00Z' },
  }))[3]!
  assert.equal(on.valueKey, 'state.on')
  assert.equal(on.metaKey, 'meta.syncOn')

  const off = buildOverviewMetrics(baseInputs({ sync: { configured: false } }))[3]!
  assert.equal(off.valueKey, 'state.off')
  assert.equal(off.metaKey, 'meta.syncOff')
})

/* ---------------- 健康判定 ---------------- */

test('overviewHealth: SAFE MODE 优先 error；全空 warn；正常 ok', () => {
  assert.equal(
    overviewHealth(baseInputs({ recoveryRequired: true })).kind,
    'error',
    '恢复事项最高优先',
  )
  const empty = overviewHealth(baseInputs({ backups: [], snapshots: [] }))
  assert.equal(empty.kind, 'warn')
  assert.equal(empty.textKey, 'health.noBackup')

  const scheduleFail = overviewHealth(baseInputs({
    backups: [{ name: 'a.zip', sizeBytes: 1, mtimeMs: NOW, source: 'manual' }],
    snapshots: [{ createdAt: '2026-09-10T00:00:00Z', entryCount: 1 }],
    schedule: { enabled: true, lastRunStatus: 'failed' },
  }))
  assert.equal(scheduleFail.kind, 'warn')
  assert.equal(scheduleFail.textKey, 'health.scheduleFailed')

  assert.equal(overviewHealth(baseInputs()).kind, 'ok', '数据未加载不降级')
})

/* ---------------- 建议 ---------------- */

test('overviewSuggestions: 未开启定时备份/未配置同步 → 两条建议；已配置则不提示；SAFE MODE 清空', () => {
  const both = overviewSuggestions(baseInputs({ schedule: { enabled: false }, sync: { configured: false } }))
  assert.deepEqual(both.map((s) => s.id), ['schedule', 'sync'])

  const none = overviewSuggestions(baseInputs({ schedule: { enabled: true }, sync: { configured: true } }))
  assert.equal(none.length, 0)

  const blocked = overviewSuggestions(baseInputs({
    recoveryRequired: true,
    schedule: { enabled: false },
    sync: { configured: false },
  }))
  assert.equal(blocked.length, 0, 'SAFE MODE 时不叠加建议')
})

/* ---------------- 最近活动 ---------------- */

test('overviewActivity: 倒序 + limit + 徽章语义 + kind key 归一', () => {
  const items = overviewActivity([
    { at: '2026-09-01T00:00:00Z', kind: 'backup', result: 'success', summary: '备份完成' },
    { at: '2026-09-10T00:00:00Z', kind: 'import', result: 'failed', summary: '导入失败' },
    { at: '2026-09-05T00:00:00Z', kind: 'unknown-kind', result: 'skipped', summary: '跳过' },
  ], 2)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.badge, 'error')
  assert.equal(items[0]!.kindKey, 'overview.kind.import')
  assert.equal(items[1]!.kindKey, 'overview.kind.other', '未知 kind 归一为 other')
  assert.equal(overviewActivity(null).length, 0)
  assert.equal(overviewActivity([]).length, 0)
})

/* ---------------- 空态 ---------------- */

test('overviewEmptyState: 备份与快照均加载且为空 → true', () => {
  assert.equal(overviewEmptyState(baseInputs({ backups: [], snapshots: [] })), true)
  assert.equal(overviewEmptyState(baseInputs({ backups: [], snapshots: [{ createdAt: '2026-09-10T00:00:00Z', entryCount: 1 }] })), false)
  assert.equal(overviewEmptyState(baseInputs()), false, '未加载不算空态')
})
