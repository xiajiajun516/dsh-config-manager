/**
 * routes 域（src/routes/**）的追加消息目录（zh 源 / en 镜像），归 t6 作用域。
 *
 * 为什么不在 \`src/core/messages.ts\` 追加：该文件不在本作用域的 inScope 内，且既有 372 键有冻结指纹。
 * 本模块经 \`registerMessageCatalog\` 注册**追加目录**：engineMsg / makeMsg 的查找顺序是
 * 「既有目录 → en 下回退既有 zh → 注册目录 → 键名」，所以本域新键只在既有目录未命中时生效，
 * 不可能遮蔽 core 的既有 import.* / host.* 键。
 *
 * 纪律：zh 值 = 改动前的既有中文文案**逐字原样**（迁移历史 summary 的拼接顺序/空格/全角标点不变）；
 * en 为 \`Record<keyof typeof zh, string>\`（缺键即编译错）。
 * **导入 \`./kit.ts\` 即完成注册**（kit.ts import 本模块）：全部路由组都经 kit.ts 声明路由。
 */
import { engineMsg as engineMsgOf, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgFunc } from '../core/msg-types.ts';

export const zh = {
  // ---------- 注册点安全不变量 ----------
  'route.kitUnregistered': '路由 {path} 未经 route kit 声明（endpoint()）——禁止裸 handler（安全不变量：围栏必须在注册点统一包装）',
  // ---------- 市场 ----------
  'route.marketItemSupplyChainWarning': '条目 {id} 来自公共网络市场，未经官方审核（供应链警示）',
  // ---------- 导入 ----------
  'route.decryptAuthFailed': '解密认证失败',
  'route.importNoSections': '无分区',
  'route.importHistorySummary': '导入完成：{sections}（执行 {count} 项）',
  'route.importIncomplete': '导入未完全成功',
  // ---------- 档案 ----------
  'route.profileLaunchSummary': '启动档案 {name}（独立实例 :{port}）',
  'route.profileCreateSummary': '新建档案 {name}（模板 {template}）',
  'route.profileCopySummary': '复制档案 {from} → {to}{suffix}',
  'route.profileCopyNoNodeModules': '（未含 node_modules）',
  'route.profileRenameSummary': '重命名档案 {from} → {to}',
  'route.profileDeleteSummary': '删除档案 {name}（物理删除目录）',
  'route.profileStopSummary': '停止档案 {name}（{kind}{port}）',
  'route.profileStopOwned': '本插件启动的独立实例',
  'route.profileStopExternal': '其他实例',
  // ---------- 快照 ----------
  'route.snapshotRestoreSummary': '恢复快照 {id}：还原 {count} 项{suffix}',
  'route.snapshotRestoreRemovedPluginsSuffix': '，卸载插件 {count}',
  'route.snapshotDeleteSummary': '删除快照 {id}',
  // ---------- 一键同步 ----------
  'route.syncPreviewFailed': '同步预览失败',
  'route.syncSessionExpired': '同步会话不存在或已过期，请重新拉取预览',
  'route.syncConflictResolutionRequired': '冲突项 {id} 必须提供 resolution（useRemote/keepLocal/skip）',
  'route.syncApplySummary': '一键同步应用：{count} 项{status}{ineffective}',
  'route.syncRollbackIncomplete': '（回滚未完成）',
  'route.syncRolledBack': '（已回滚）',
  'route.syncIneffectiveSuffix': '（{count} 项未生效）',
  'route.syncApplyPartial': '同步应用部分成功：有项未生效（见告警明细）',
  'route.syncApplyFailed': '同步应用未完全成功',
  'route.syncRollbackSummary': '一键同步回滚（{id}）',
  // ---------- 事故恢复 ----------
  'route.recoverySessionRepairRollback': '会话修复回滚',
  'route.recoverySessionRepairDropped': '会话修复（丢弃重放重复行 {count} 行）',
  'route.recoverySessionRepairRejected': '会话修复被拒绝：{reason}',
  'route.recoverySessionLayoutApplied': '会话布局归位（搬运/隔离 {count} 条）',
  'route.recoverySessionLayoutPartial': '会话布局归位未全部完成（成功 {applied}，失败 {failed}，跳过 {skipped}）',
  'route.rollbackPointRewind': '回滚到回滚点：{outcome}',
  'route.rollbackPointDelete': '删除回滚点 {id}',
  'route.rollbackPointCleanup': '清理回滚点台账：删除 {records} 个点',
  'route.recoveryOperationSummary': '恢复操作 {action}',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'route.kitUnregistered': 'Route {path} was not declared through the route kit (endpoint()) — bare handlers are forbidden (safety invariant: the fence must be wrapped at the registration point)',
  'route.marketItemSupplyChainWarning': 'Item {id} comes from a public community marketplace and is not officially reviewed (supply-chain warning)',
  'route.decryptAuthFailed': 'Decryption authentication failed',
  'route.importNoSections': 'no sections',
  'route.importHistorySummary': 'Import finished: {sections} ({count} item(s) executed)',
  'route.importIncomplete': 'Import did not fully succeed',
  'route.profileLaunchSummary': 'Launched profile {name} (separate instance :{port})',
  'route.profileCreateSummary': 'Created profile {name} (template {template})',
  'route.profileCopySummary': 'Copied profile {from} → {to}{suffix}',
  'route.profileCopyNoNodeModules': ' (node_modules excluded)',
  'route.profileRenameSummary': 'Renamed profile {from} → {to}',
  'route.profileDeleteSummary': 'Deleted profile {name} (directory physically removed)',
  'route.profileStopSummary': 'Stopped profile {name} ({kind}{port})',
  'route.profileStopOwned': 'separate instance launched by this plugin',
  'route.profileStopExternal': 'other instance',
  'route.snapshotRestoreSummary': 'Restored snapshot {id}: {count} item(s) restored{suffix}',
  'route.snapshotRestoreRemovedPluginsSuffix': ', {count} plugin(s) uninstalled',
  'route.snapshotDeleteSummary': 'Deleted snapshot {id}',
  'route.syncPreviewFailed': 'Sync preview failed',
  'route.syncSessionExpired': 'The sync session does not exist or has expired; pull a fresh preview',
  'route.syncConflictResolutionRequired': 'Conflict item {id} must provide a resolution (useRemote/keepLocal/skip)',
  'route.syncApplySummary': 'One-click sync apply: {count} item(s){status}{ineffective}',
  'route.syncRollbackIncomplete': ' (rollback incomplete)',
  'route.syncRolledBack': ' (rolled back)',
  'route.syncIneffectiveSuffix': ' ({count} item(s) had no effect)',
  'route.syncApplyPartial': 'Sync apply partially succeeded: some items had no effect (see the warning details)',
  'route.syncApplyFailed': 'Sync apply did not fully succeed',
  'route.syncRollbackSummary': 'One-click sync rollback ({id})',
  'route.recoverySessionRepairRollback': 'Session repair rollback',
  'route.recoverySessionRepairDropped': 'Session repair (dropped {count} replayed duplicate row(s))',
  'route.recoverySessionRepairRejected': 'Session repair was rejected: {reason}',
  'route.recoverySessionLayoutApplied': 'Session layout relocation ({count} item(s) moved/quarantined)',
  'route.recoverySessionLayoutPartial': 'Session layout relocation did not fully complete ({applied} succeeded, {failed} failed, {skipped} skipped)',
  'route.rollbackPointRewind': 'Rewind to rollback point: {outcome}',
  'route.rollbackPointDelete': 'Deleted rollback point {id}',
  'route.rollbackPointCleanup': 'Cleaned up rollback-point ledger: {records} point(s) deleted',
  'route.recoveryOperationSummary': 'Recovery operation {action}',
};

registerMessageCatalog({ id: 'routes-domain', zh, en });

/** 本域活翻译器（与 core 的 engineMsg 同一实现；导入本模块即完成目录注册）。 */
export const engineMsg: MsgFunc = engineMsgOf;
