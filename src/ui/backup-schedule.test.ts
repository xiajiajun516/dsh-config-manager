/**
 * backup-schedule 纯函数测试：草稿校验 / 状态映射 / 脏判定 / 运行摘要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backupDraftDirty,
  backupRunBadgeKind,
  backupRunSummary,
  validateBackupScheduleDraft,
  type BackupScheduleStatus,
} from './backup-schedule.ts'

test('validateBackupScheduleDraft：合法草稿通过（4 档位全过）', () => {
  for (const interval of ['6h', '12h', '24h', '7d'] as const) {
    const r = validateBackupScheduleDraft({ enabled: true, interval })
    assert.deepEqual(r, { ok: true, value: { enabled: true, interval } })
  }
})

test('validateBackupScheduleDraft：custom 档要求合法 customSchedule（P0-⑤）', () => {
  const ok = validateBackupScheduleDraft({
    enabled: true, interval: 'custom',
    customSchedule: { dayOfWeek: 1, hour: 3, minute: 30 },
  })
  assert.deepEqual(ok, {
    ok: true,
    value: { enabled: true, interval: 'custom', customSchedule: { dayOfWeek: 1, hour: 3, minute: 30 } },
  })
  // 缺 customSchedule → 拒绝
  const missing = validateBackupScheduleDraft({ enabled: true, interval: 'custom' })
  assert.equal(missing.ok, false)
  // 非法值域（hour 25 / dayOfWeek 7 / minute -1）→ 拒绝
  for (const bad of [
    { dayOfWeek: 1, hour: 25, minute: 0 },
    { dayOfWeek: 7, hour: 3, minute: 0 },
    { dayOfWeek: 0, hour: 3, minute: -1 },
  ]) {
    const r = validateBackupScheduleDraft({ enabled: true, interval: 'custom', customSchedule: bad })
    assert.equal(r.ok, false, `应拒绝非法 customSchedule: ${JSON.stringify(bad)}`)
  }
})

test('backupDraftDirty：custom 档按周档字段比对（P0-⑤）', () => {
  const saved: BackupScheduleStatus = {
    enabled: true, interval: 'custom',
    customSchedule: { dayOfWeek: 1, hour: 3, minute: 30 },
    startupMinIntervalMs: 3600000, consecutiveFailures: 0,
  }
  assert.equal(
    backupDraftDirty({ enabled: true, interval: 'custom', customSchedule: { dayOfWeek: 1, hour: 3, minute: 30 } }, saved),
    false,
  )
  assert.equal(
    backupDraftDirty({ enabled: true, interval: 'custom', customSchedule: { dayOfWeek: 2, hour: 3, minute: 30 } }, saved),
    true,
    '周几不同 = 有修改',
  )
  assert.equal(
    backupDraftDirty({ enabled: true, interval: 'custom', customSchedule: { dayOfWeek: 1, hour: 4, minute: 0 } }, saved),
    true,
    '时刻不同 = 有修改',
  )
  // saved 无 customSchedule（旧配置）而草稿有 → 有修改
  const legacy: BackupScheduleStatus = { enabled: true, interval: 'custom', startupMinIntervalMs: 3600000, consecutiveFailures: 0 }
  assert.equal(
    backupDraftDirty({ enabled: true, interval: 'custom', customSchedule: { dayOfWeek: 1, hour: 3, minute: 30 } }, legacy),
    true,
  )
})

test('validateBackupScheduleDraft：非法 interval 拒绝', () => {
  const r = validateBackupScheduleDraft({ enabled: true, interval: '1h' as never })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /interval/)
})

test('backupRunBadgeKind：状态 → 语义 kind', () => {
  assert.equal(backupRunBadgeKind('success'), 'ok')
  assert.equal(backupRunBadgeKind('failed'), 'error')
  assert.equal(backupRunBadgeKind('skipped'), 'info')
  assert.equal(backupRunBadgeKind(undefined), 'info')
})

test('backupDraftDirty：与已保存配置比对（未保存修改判定）', () => {
  const saved: BackupScheduleStatus = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 }
  assert.equal(backupDraftDirty({ enabled: true, interval: '24h' }, saved), false)
  assert.equal(backupDraftDirty({ enabled: false, interval: '24h' }, saved), true)
  assert.equal(backupDraftDirty({ enabled: true, interval: '6h' }, saved), true)
  // 尚未加载配置（null）时视为有修改（按钮可点但保存会先拒绝？——由组件层决定，这里仅语义）
  assert.equal(backupDraftDirty({ enabled: true, interval: '24h' }, null), true)
})

test('backupRunSummary：成功摘要（zip/大小保留，无错误）', () => {
  const s = backupRunSummary({ status: 'success', zip: 'dsh-config-20260823-120000-abc.zip', sizeBytes: 1024, consecutiveFailures: 0 })
  assert.deepEqual(s, { status: 'success', zip: 'dsh-config-20260823-120000-abc.zip', sizeBytes: 1024, skipReason: null, error: null })
})

test('backupRunSummary：跳过/失败摘要（reason/error 透传）', () => {
  const skipped = backupRunSummary({ status: 'skipped', skipReason: 'running', consecutiveFailures: 0 })
  assert.deepEqual(skipped, { status: 'skipped', zip: null, sizeBytes: null, skipReason: 'running', error: null })
  const failed = backupRunSummary({ status: 'failed', error: 'boom', consecutiveFailures: 2 })
  assert.deepEqual(failed, { status: 'failed', zip: null, sizeBytes: null, skipReason: null, error: 'boom' })
})
