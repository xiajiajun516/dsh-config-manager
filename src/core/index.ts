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
export {
  computeCompatibility, describeCompatibility, describeSchemaStatus,
  validateSections,
} from './validator.ts';
export {
  ImportNotConfirmedError, ImportFailedError,
} from './types.ts';
export type * from './types.ts';

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
