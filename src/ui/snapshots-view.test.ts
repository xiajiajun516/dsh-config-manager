/**
 * `src/ui/snapshots-view.ts` 单测（t43）：备份页面板的状态投影与展示派生。
 *
 * 覆盖重点：这些逻辑此前**全部私有在 SnapshotsPanel.tsx 的组件体内**（node 无法测试），
 * 其中「store 切片投影」「未知状态的退化分支」「custom 档时刻事实行」「文件名搜索」
 * 「备注编码损坏判定」此前零测试覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { RestoreActionKind, RestorePlan } from '../core/restore.ts'
import type { SnapshotMeta } from '../core/restore.ts'
import type { BackupFileMeta } from '../sync/backup-files.ts'
import {
  INITIAL_SNAPSHOTS_PANEL_STATE,
  backupIntervalLabelKey,
  backupRunStatusLabelKey,
  filterBackupFiles,
  formatBackupFileTime,
  formatRunTime,
  isUnreadableNote,
  midEllipsis,
  planHasExecutableActions,
  scheduleIntervalFact,
  snapshotStatusBadgeKind,
  snapshotStatusLabelKey,
  snapshotsPanelStateFromStore,
  weekdayLabelKey,
  type SnapshotsPanelStoreSlice,
} from './snapshots-view.ts'

const snapshotStatus = (v: string): SnapshotMeta['status'] => v as SnapshotMeta['status']

const fileOf = (name: string, note?: string | null): BackupFileMeta => ({
  name, path: `/exports/${name}`, sizeBytes: 1, mtimeMs: 0, source: 'manual', note,
})

const planOf = (kinds: RestoreActionKind[]): RestorePlan => ({
  snapshotId: 'snap-1',
  createdAt: '2026-09-22T00:00:00.000Z',
  sourceZip: 'dsh-config.zip',
  actions: kinds.map((kind) => ({ kind, description: kind })),
  summary: {
    hostFileRestores: 0, hostFileRemoves: 0, pluginRemoves: 0,
    fileRestores: 0, fileRemoves: 0, credentialHints: 0, skips: 0,
  },
  pluginBaselineConfirmed: false,
})

/* --------------------------------------------------- midEllipsis（文件名省略） */

test('midEllipsis：未超上限原样返回（含恰好等长）', () => {
  assert.equal(midEllipsis('short'), 'short')
  assert.equal(midEllipsis(''), '')
  assert.equal(midEllipsis('a'.repeat(26)), 'a'.repeat(26), '恰好等于默认上限（26）不得截断')
  assert.equal(midEllipsis('0123456789ABCDEFGHIJ', 20).length, 20)
})

test('midEllipsis：超限时保留头尾、中段以 … 替代，且总长恰为 max', () => {
  // 默认上限 26：head=13 / tail=12（尾部时间戳/短 id 是唯一区分信息，优先保住尾部）
  const long = 'x'.repeat(100)
  assert.equal(midEllipsis(long).length, 26)
  assert.equal(midEllipsis('0123456789ABCDEFGHIJK', 20), '0123456789…CDEFGHIJK')
  assert.equal(midEllipsis('0123456789ABCDEFGHIJ', 11), '01234…FGHIJ')
  assert.ok(midEllipsis('0123456789ABCDEFGHIJK', 20).includes('…'))
})

test('midEllipsis：max<=1 的退化输入保持历史行为（本次下沉逐字保留，未顺手改语义）', () => {
  // keep=0 → head=tail=0 → slice(-0) 等于整串；改它会变更既有渲染输出，故只钉住现状。
  assert.equal(midEllipsis('abcdef', 1), '…abcdef')
})

/* ----------------------------------------------------- 状态 → 键 / Badge 语义 */

test('snapshotStatusLabelKey：三个已知状态映射，未知/缺省落 unknown（此前无测试分支）', () => {
  assert.equal(snapshotStatusLabelKey('pending'), 'snapshots.status.pending')
  assert.equal(snapshotStatusLabelKey('done'), 'snapshots.status.done')
  assert.equal(snapshotStatusLabelKey('rolled-back'), 'snapshots.status.rolled-back')
  assert.equal(snapshotStatusLabelKey(snapshotStatus('bogus')), 'snapshots.status.unknown')
  assert.equal(snapshotStatusLabelKey(snapshotStatus(undefined as unknown as string)), 'snapshots.status.unknown')
})

test('snapshotStatusBadgeKind：pending=info / done=ok / rolled-back=warn / 未知=error', () => {
  assert.equal(snapshotStatusBadgeKind('pending'), 'info')
  assert.equal(snapshotStatusBadgeKind('done'), 'ok')
  assert.equal(snapshotStatusBadgeKind('rolled-back'), 'warn')
  assert.equal(snapshotStatusBadgeKind(snapshotStatus('bogus')), 'error', '未知状态必须显眼（error）而非静默 info')
})

test('backupIntervalLabelKey：五个档位穷尽映射', () => {
  assert.equal(backupIntervalLabelKey('6h'), 'backupSchedule.interval.6h')
  assert.equal(backupIntervalLabelKey('12h'), 'backupSchedule.interval.12h')
  assert.equal(backupIntervalLabelKey('24h'), 'backupSchedule.interval.24h')
  assert.equal(backupIntervalLabelKey('7d'), 'backupSchedule.interval.7d')
  assert.equal(backupIntervalLabelKey('custom'), 'backupSchedule.interval.custom')
})

test('weekdayLabelKey：0-6 映射，值域外返回 null（调用方回退 String(day)）', () => {
  assert.equal(weekdayLabelKey(0), 'backupSchedule.weekday.sunday')
  assert.equal(weekdayLabelKey(6), 'backupSchedule.weekday.saturday')
  assert.equal(weekdayLabelKey(-1), null)
  assert.equal(weekdayLabelKey(7), null)
  assert.equal(weekdayLabelKey(1.5), null)
})

test('backupRunStatusLabelKey：已知状态映射，未运行/未知 → null（壳渲染 —）', () => {
  assert.equal(backupRunStatusLabelKey('success'), 'backupSchedule.status.success')
  assert.equal(backupRunStatusLabelKey('skipped'), 'backupSchedule.status.skipped')
  assert.equal(backupRunStatusLabelKey('failed'), 'backupSchedule.status.failed')
  assert.equal(backupRunStatusLabelKey(undefined), null)
  assert.equal(backupRunStatusLabelKey('bogus' as never), null)
})

test('formatRunTime：空值空串、不可解析原样返回、可解析走本地格式', () => {
  assert.equal(formatRunTime(undefined), '')
  assert.equal(formatRunTime(''), '')
  assert.equal(formatRunTime('not-a-date'), 'not-a-date', '不可解析时绝不吞掉宿主原始值')
  const iso = new Date(2026, 8, 22, 7, 5).toISOString()
  assert.equal(formatRunTime(iso), new Date(iso).toLocaleString())
})

test('scheduleIntervalFact：未启用/无配置 → none；普通档 → interval；custom → 结构化时刻', () => {
  assert.deepEqual(scheduleIntervalFact(null), { kind: 'none' })
  assert.deepEqual(
    scheduleIntervalFact({ enabled: false, interval: '24h', startupMinIntervalMs: 0, consecutiveFailures: 0 }),
    { kind: 'none' },
    '未启用时事实行不得显示档位（否则把未生效配置显示成已生效）',
  )
  assert.deepEqual(
    scheduleIntervalFact({ enabled: true, interval: '7d', startupMinIntervalMs: 0, consecutiveFailures: 0 }),
    { kind: 'interval', interval: '7d' },
  )
  assert.deepEqual(
    scheduleIntervalFact({
      enabled: true, interval: 'custom', startupMinIntervalMs: 0, consecutiveFailures: 0,
      customSchedule: { dayOfWeek: 0, hour: 23, minute: 45 },
    }),
    { kind: 'time', dayOfWeek: 0, hour: 23, minute: 45 },
  )
})

test('scheduleIntervalFact：custom 缺少 customSchedule/字段时补缺省（周一 03:00）', () => {
  assert.deepEqual(
    scheduleIntervalFact({ enabled: true, interval: 'custom', startupMinIntervalMs: 0, consecutiveFailures: 0 }),
    { kind: 'time', dayOfWeek: 1, hour: 3, minute: 0 },
  )
  assert.deepEqual(
    scheduleIntervalFact({
      enabled: true, interval: 'custom', startupMinIntervalMs: 0, consecutiveFailures: 0,
      customSchedule: { dayOfWeek: 5, hour: 9, minute: 0 },
    }),
    { kind: 'time', dayOfWeek: 5, hour: 9, minute: 0 },
  )
})

/* ------------------------------------------------------------ 备份文件列表 */

test('filterBackupFiles：空查询/纯空白不过滤，且返回副本（不暴露内部数组）', () => {
  const files = [fileOf('a.zip'), fileOf('b.zip')]
  const all = filterBackupFiles(files, '')
  assert.deepEqual(all, files)
  assert.notEqual(all, files, '必须返回新数组（组件 setState 依赖引用变化）')
  assert.equal(filterBackupFiles(files, '   ').length, 2)
})

test('filterBackupFiles：文件名子串匹配且大小写不敏感', () => {
  const files = [fileOf('dsh-config-auto-2026.zip'), fileOf('manual.zip')]
  assert.deepEqual(filterBackupFiles(files, 'AUTO').map((f) => f.name), ['dsh-config-auto-2026.zip'])
  assert.deepEqual(filterBackupFiles(files, 'manual').map((f) => f.name), ['manual.zip'])
  assert.deepEqual(filterBackupFiles(files, 'nope'), [])
})

test('filterBackupFiles：备注命中（含 note=null / undefined 不炸）', () => {
  const files = [fileOf('a.zip', '迁移前备份'), fileOf('b.zip', null), fileOf('c.zip')]
  assert.deepEqual(filterBackupFiles(files, '迁移').map((f) => f.name), ['a.zip'])
  assert.deepEqual(filterBackupFiles(files, 'b.zip').map((f) => f.name), ['b.zip'])
  assert.equal(filterBackupFiles(files, 'empty-query-keeps-all').length, 0)
})

test('formatBackupFileTime：等宽本地时间；NaN → 空串', () => {
  const ms = new Date(2026, 8, 22, 7, 5, 0).getTime()
  assert.equal(formatBackupFileTime(ms), '2026-09-22 07:05')
  assert.equal(formatBackupFileTime(Number.NaN), '')
})

test('isUnreadableNote：全问号/控制符/空白 → true；含可读字符 → false', () => {
  assert.equal(isUnreadableNote('???'), true)
  assert.equal(isUnreadableNote('? ?'), true)
  assert.equal(isUnreadableNote('   '), true)
  assert.equal(isUnreadableNote('a?b'), false)
  assert.equal(isUnreadableNote('迁移前'), false)
  assert.equal(isUnreadableNote(''), false, '空备注按「无备注」处理（组件另有 note!=="" 判断）')
})

/* ------------------------------------------------------------ 恢复计划判据 */

test('planHasExecutableActions：null / 空计划 / 全 skip → false；含真实动作 → true', () => {
  assert.equal(planHasExecutableActions(null), false)
  assert.equal(planHasExecutableActions(planOf([])), false)
  assert.equal(planHasExecutableActions(planOf(['skip', 'skip'])), false, '全 skip 计划不得允许执行')
  assert.equal(planHasExecutableActions(planOf(['skip', 'hostFileRestore'])), true)
  assert.equal(planHasExecutableActions(planOf(['pluginRemove'])), true)
})

/* ----------------------------------------------------------- store 切片投影 */

test('snapshotsPanelStateFromStore：恢复 store 镜像字段，transient 字段回落初始值', () => {
  const plan = planOf(['fileRestore'])
  const slice: SnapshotsPanelStoreSlice = {
    selectedId: 'snap-1',
    running: true,
    plan,
    changeSummary: null,
    report: null,
    actionError: '计划加载失败',
    error: 'e',
  }
  const state = snapshotsPanelStateFromStore(slice)
  assert.equal(state.selectedId, 'snap-1')
  assert.equal(state.running, true)
  assert.equal(state.plan, plan)
  assert.equal(state.actionError, '计划加载失败')
  assert.equal(state.error, 'e')
  assert.equal(state.status, 'loading', '列表权威在宿主：恢复后仍以 loading 起步，由 load() 拉取')
  assert.deepEqual(state.metas, [])
  assert.equal(state.planning, false)
  assert.equal(INITIAL_SNAPSHOTS_PANEL_STATE.report, null)
})
