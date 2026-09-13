/**
 * `dsh-config-manager/schema` 的运行时入口（`exports["./schema"]`）。
 *
 * 定位：**零 DSH 依赖、零 `node:` 依赖**的 schema 公共面。第三方在不安装
 * 任何 `@deepseek-ai/*`、React 或 Node 内建模块的前提下，即可：
 *  - 判定 `manifest.schemaVersion` 的兼容性（`isCurrent` / `isSupported` / `needsMigration` /
 *    `isTooNew` / `canImport` / `describeVersion` / `UnsupportedSchemaError`）；
 *  - 取到 `SECTION_IDS` / `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` / `isFileSection`，
 *    据此实现自己的 importer / exporter（ZIP 内路径与文件类分区前缀的唯一权威）；
 *  - 引用 Bundle Format v1 的全部载荷类型。
 *
 * 为什么需要它：此前的 `exports["./schema"]` 指向 `./lib/schema/types.js`，而 `types.ts`
 * 是**纯类型文件**——编译产物是一个**空模块**（运行时零导出）。第三方
 * `import('dsh-config-manager/schema')` 只会拿到 `{}`，`CURRENT_SCHEMA_VERSION` 等
 * 版本工具**在包外无法导入**（它们定义在 `./versions.ts`，不在任何 exports 映射内）。
 * 本文件把 `./schema` 变成真实可用的运行时入口。
 *
 * 约束（勿破）：本文件只 import 同目录模块（`./config.ts` / `./types.ts` / `./versions.ts`）。
 * 不 import `../core/*`、不 import `node:*`、不 import 任何 UI / DSH 包——否则会破坏
 * headless 消费（见 `docs/spec/headless-consumption.md`）与 `tests/architecture-boundaries.test.ts`。
 */

/* —— 版本判定（唯一出口，业务代码零散落 `if (v === 1)`） —— */
export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaError,
  isCurrent,
  isSupported,
  needsMigration,
  isTooNew,
  canImport,
  describeVersion,
} from './versions.ts';

/* —— 分区表（第三方实现 importer/exporter 的路径权威） —— */
export {
  SECTION_IDS,
  SECTION_JSON_PATHS,
  SECTION_FILE_PREFIXES,
  isFileSection,
} from './config.ts';

/* —— 载荷类型（纯类型，运行时零开销） —— */
export type {
  Platform,
  SectionId,
  EncryptionInfo,
  Manifest,
  NamespaceRecord,
  SettingsSection,
  UiMigrationNote,
  UiSection,
  ProviderEntry,
  ProvidersSection,
  PluginEntry,
  PatchLine,
  LocalPluginTarball,
  PluginsSection,
  McpServerEntry,
  McpSection,
  PromptEntry,
  PromptsSection,
  WorkspaceRecord,
  WorkspacesSection,
  CredentialStatus,
  CredentialsSection,
  FileEntry,
  FilesSection,
  SectionData,
} from './types.ts';
