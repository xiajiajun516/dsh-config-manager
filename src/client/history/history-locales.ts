/**
 * Migration History 区块（config-manager-history）表面文案：zh 为源语言，en 镜像每个键。
 * 独立命名空间、独立文件：不触碰共享的 locales.ts，零冲突。
 * 键集合经 `HistoryKey` 类型在 client/index.ts 注册处做编译期校验。
 */
import type { MigrationKind, MigrationResult } from '../../core/migration-history.ts';

type KindKey = `history.kind.${MigrationKind}`;
type ResultKey = `history.result.${MigrationResult}`;
type CommonKey =
  | 'view.history'
  | 'history.title'
  | 'history.subtitle'
  | 'history.empty'
  | 'history.loading'
  | 'history.corruptedBanner'
  | 'history.corruptedCount'
  | 'history.stats.total'
  | 'history.stats.success'
  | 'history.stats.failed'
  | 'history.stats.skipped'
  | 'history.filter.kind'
  | 'history.filter.result'
  | 'history.filter.recent'
  | 'history.filter.recent.all'
  | 'history.filter.recent.50'
  | 'history.filter.recent.200'
  | 'history.filter.sections'
  | 'history.filter.title'
  | 'history.search.placeholder'
  | 'history.export.json'
  | 'history.export.markdown'
  | 'history.exported'
  | 'history.exporting'
  | 'history.exportError'
  | 'history.loadError'
  | 'history.reload'
  | 'history.table.time'
  | 'history.table.kind'
  | 'history.table.result'
  | 'history.table.sections'
  | 'history.table.summary'
  | 'history.updatedAt'
  | 'history.refresh';

export type HistoryKey = KindKey | ResultKey | CommonKey;

export const zh = {
  'view.history': '迁移历史',
  'history.title': '迁移与审计历史',
  'history.subtitle': '统一记录全部破坏性/迁移操作（导入/恢复/回滚/档案/同步/定时备份/快照操作），只可追加、不可修改或删除，跨重启持久，可查询可导出。',
  'history.empty': '暂无迁移记录。执行导入、恢复、档案切换、同步应用或定时备份后，这里会出现审计记录。',
  'history.loading': '加载迁移历史…',
  'history.corruptedBanner': '检测到无法读取/可能被篡改的历史条目',
  'history.corruptedCount': '{count} 条已被跳过（不计入导出）',
  'history.stats.total': '总数',
  'history.stats.success': '成功',
  'history.stats.failed': '失败',
  'history.stats.skipped': '跳过',
  'history.filter.kind': '操作类型',
  'history.filter.result': '结果',
  'history.filter.recent': '时间范围',
  'history.filter.recent.all': '全部',
  'history.filter.recent.50': '最近 50 条',
  'history.filter.recent.200': '最近 200 条',
  'history.filter.sections': '涉及分区',
  'history.filter.title': '筛选与导出',
  'history.search.placeholder': '搜索摘要 / 错误 / 分区…',
  'history.export.json': '导出 JSON',
  'history.export.markdown': '导出 Markdown',
  'history.exported': '已导出',
  'history.exporting': '导出中…',
  'history.exportError': '导出失败',
  'history.loadError': '加载迁移历史失败',
  'history.reload': '重新加载',
  'history.table.time': '时间',
  'history.table.kind': '操作',
  'history.table.result': '结果',
  'history.table.sections': '涉及分区',
  'history.table.summary': '摘要',
  'history.updatedAt': '更新于',
  'history.refresh': '刷新',
  'history.kind.import': '导入',
  'history.kind.restore': '快照恢复',
  'history.kind.rollback': '回滚',
  'history.kind.profile-switch': '档案切换',
  'history.kind.profile-delete': '档案删除',
  'history.kind.profile-rename': '档案重命名',
  'history.kind.profile-save': '档案保存',
  'history.kind.profile-import': '档案导入',
  'history.kind.sync-apply': '一键同步应用',
  'history.kind.autosync': '自动同步',
  'history.kind.recovery': '恢复/回滚编排',
  'history.kind.backup': '定时备份',
  'history.kind.snapshot-delete': '快照删除',
  'history.kind.snapshot-prune': '快照保留清理',
  'history.result.success': '成功',
  'history.result.failed': '失败',
  'history.result.skipped': '跳过',
} as const satisfies Record<HistoryKey, string>;

export const en = {
  'view.history': 'Migration History',
  'history.title': 'Migration & Audit History',
  'history.subtitle': 'Unified append-only audit trail of all destructive/migration operations (import/restore/rollback/profile/sync/backup/snapshot), durable across restarts, queryable and exportable.',
  'history.empty': 'No migration records yet. Executing an import, restore, profile switch, sync apply, or scheduled backup will create audit entries here.',
  'history.loading': 'Loading migration history…',
  'history.corruptedBanner': 'Detected unreadable or possibly tampered history entries',
  'history.corruptedCount': '{count} entry(s) were skipped (excluded from export)',
  'history.stats.total': 'Total',
  'history.stats.success': 'Success',
  'history.stats.failed': 'Failed',
  'history.stats.skipped': 'Skipped',
  'history.filter.kind': 'Operation',
  'history.filter.result': 'Result',
  'history.filter.recent': 'Time range',
  'history.filter.recent.all': 'All',
  'history.filter.recent.50': 'Latest 50',
  'history.filter.recent.200': 'Latest 200',
  'history.filter.sections': 'Sections',
  'history.filter.title': 'Filter & export',
  'history.search.placeholder': 'Search summary / error / section…',
  'history.export.json': 'Export JSON',
  'history.export.markdown': 'Export Markdown',
  'history.exported': 'Exported',
  'history.exporting': 'Exporting…',
  'history.exportError': 'Export failed',
  'history.loadError': 'Failed to load migration history',
  'history.reload': 'Reload',
  'history.table.time': 'Time',
  'history.table.kind': 'Operation',
  'history.table.result': 'Result',
  'history.table.sections': 'Sections',
  'history.table.summary': 'Summary',
  'history.updatedAt': 'Updated',
  'history.refresh': 'Refresh',
  'history.kind.import': 'Import',
  'history.kind.restore': 'Snapshot restore',
  'history.kind.rollback': 'Rollback',
  'history.kind.profile-switch': 'Profile switch',
  'history.kind.profile-delete': 'Profile delete',
  'history.kind.profile-rename': 'Profile rename',
  'history.kind.profile-save': 'Profile save',
  'history.kind.profile-import': 'Profile import',
  'history.kind.sync-apply': 'Sync apply',
  'history.kind.autosync': 'Autosync',
  'history.kind.recovery': 'Recovery/rollback',
  'history.kind.backup': 'Scheduled backup',
  'history.kind.snapshot-delete': 'Snapshot delete',
  'history.kind.snapshot-prune': 'Snapshot retention',
  'history.result.success': 'Success',
  'history.result.failed': 'Failed',
  'history.result.skipped': 'Skipped',
} as const satisfies Record<HistoryKey, string>;

/** history 纯函数的 kind 展示映射（供 UI 层直接使用）。 */
export const HISTORY_KIND_LABELS: Record<MigrationKind, string> = {
  import: '导入',
  restore: '快照恢复',
  rollback: '回滚',
  'profile-switch': '档案切换',
  'profile-delete': '档案删除',
  'profile-rename': '档案重命名',
  'profile-save': '档案保存',
  'profile-import': '档案导入',
  'sync-apply': '一键同步应用',
  autosync: '自动同步',
  recovery: '恢复/回滚编排',
  backup: '定时备份',
  'snapshot-delete': '快照删除',
  'snapshot-prune': '快照保留清理',
};
