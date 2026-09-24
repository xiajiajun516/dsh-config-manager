/**
 * 核心引擎公共出口：m5（适配器）、m6（UI）、m7（测试）与宿主插件统一从这里引用。
 */
export {
  Exporter, defaultSecretScanner, EXPORTER_INFO,
  type ExporterOptions,
} from './exporter.ts';
export {
  Importer, type ImporterOptions, type ExecuteOptions,
} from './importer.ts';
export {
  Analyzer, type AnalyzerOptions,
} from './analyzer.ts';
export {
  createSnapshot, FileSnapshotStore, resolveFileTarget, verifySnapshot,
  type CreateSnapshotOptions, type FileSnapshotStoreOptions, type SnapshotVerifyResult,
} from './backup.ts';
export { rollback, type RollbackOptions } from './rollback.ts';
export {
  planRestore, restore, listSnapshots,
  type RestoreAction, type RestoreActionKind, type RestoreOptions,
  type RestorePlan, type RestoreReport, type SnapshotMeta,
} from './restore.ts';
/* —— 快照恢复的 git 风格改动预览（只读：变更状态 / 行数统计 / 逐行 hunks） —— */
export {
  snapshotFileDiff, summarizeRestoreChanges, SNAPSHOT_DIFF_LIMITS,
  type RestoreChangeSummary, type SnapshotChangeEntry, type SnapshotChangeStatus,
  type SnapshotFileDiff, type SnapshotFileDiffReason, type SnapshotFileDiffSide,
} from './snapshot-diff.ts';
export {
  computeCompatibility, describeCompatibility, describeSchemaStatus,
  validateSections,
} from './validator.ts';
export {
  ImportNotConfirmedError, ImportFailedError,
} from './types.ts';
export type * from './types.ts';

/* —— 会话路径映射（issue #45：一条映射同时作用于 workspace.path 与会话首帧 cwd） —— */
export { applyPathMapping, type PathMappingRule } from './path-mapping.ts';

export {
  planSessionRepair, sessionRepairNeedsAttention,
  type SessionRepairAction, type SessionRepairActionKind, type SessionRepairOptions,
  type SessionRepairPlan, type SessionRepairReason, type SessionRepairSummary,
  type RepairSessionInput,
} from './session-repair.ts';

/* —— 迁移历史引擎（Phase 6） —— */
export {
  MigrationStore, sanitizeEntry, queryHistory, summarizeHistory, renderExport,
  parseHistoryQuery, isValidMigrationKind, redactHistoryText,
  makeHistoryFilename, isHistoryBasename, MIGRATION_HISTORY_DIR,
  DEFAULT_MIGRATION_RETENTION, MIGRATION_HISTORY_SCHEMA_VERSION,
  type MigrationKind, type MigrationResult, type MigrationHistoryEntry,
  type StoredMigrationHistoryEntry, type MigrationQuery, type MigrationHistoryStats,
  type ExportFormat, type ReadMigrationResult, type AppendResult, type MigrationIo,
  type MigrationStoreOptions, type MigrationSource,
} from './migration-history.ts';

/* —— 类型与工具的便捷重导出 —— */
export type {
  ExportOptions, ExportSection, ValidationResult, HostContext,
  SettingsFacade, CredentialsFacade, PluginsFacade, WorkspaceFacade,
  PatchFileFacade, FileSystemFacade, NamespaceInfo, PluginInfo,
  ConfigAdapter, Portability, SecretScanner, SensitiveHit, EncryptionProvider,
  PlanItem, PlanItemKind, ItemResolution, GlobalConflictStrategy,
  ImportAnalysis, ImportDecisions, ImportPlan, ImportResult, ExecutedItem,
  ImportContext, SnapshotTarget, SnapshotEntry, Snapshot, SnapshotStore,
  RollbackReport, PathMapping, PathIssue, CompatibilityInput,
  CompatibilityScore, ExportReport, ApplyResult, ConflictDecision,
} from './types.ts';
