/**
 * 核心引擎契约类型（对齐 Docs/design/architecture.md §13.2/§13.3/§13.5）。
 *
 * 关键解耦原则：核心引擎只依赖这里的接口，绝不 import DSH 运行时包。
 * HostContext 是 m3 定义、m5 实现的 DSH Service 门面（研究报告 §3.2 的叶子方法最小集），
 * 测试用内存 mock 即可驱动完整导出→导入往返。
 */
import type { EncryptionInfo, Manifest, SectionId, WorkspaceRecord } from '../schema/types.ts';
import type { Logger } from '../utils/logger.ts';
import { zhMsg } from './messages.ts';
import type { MsgFunc } from './messages.ts';

/* ---------------- 导出选项与分区产出 ---------------- */

export interface ExportOptions {
  /** 是否包含真实秘密（必须配合 encryption 提供者；缺省 false = 只导状态） */
  includeSecrets: boolean;
  /** 仅导出指定分区（缺省 = 全部默认包含分区） */
  only?: SectionId[];
  /** 导出文件路径（缺省自动生成 dsh-config-<date>.zip） */
  outPath?: string;
}

/** adapter.export() 的产出：数据 + 文件 + 报告计数 + 告警 */
export interface ExportSection<T = unknown> {
  sectionId: SectionId;
  data: T;
  /** 文件类分区（skills/agentPresets/pluginFiles/sessions）以真实文件形式进入 ZIP */
  files?: { relativePath: string; data: Uint8Array }[];
  counts: Record<string, number>;
  warnings: string[];
}

export interface ValidationResult {
  valid: boolean;
  issues: { path: string; message: string; severity: 'error' | 'warning' }[];
}

/* ---------------- Secret 扫描（m4 可替换实现） ---------------- */

export interface SensitiveHit { path: string; field: string; }

export interface SecretScanner {
  /** 递归扫描 + 剥离敏感字段值；返回清洗后的数据与命中清单（不泄值） */
  scanAndRedact(data: unknown): { sanitized: unknown; hits: SensitiveHit[] };
  /** 文本级扫描（文件类分区内容），供强化版使用 */
  scanText?(text: string): SensitiveHit[];
}

/* ---------------- DSH Service 门面（m5 对接真实 ctx） ---------------- */

export interface NamespaceInfo {
  value: unknown;
  base?: unknown;
  revision: number;
  applies?: string[];
  secrets: { path: string[]; set: boolean }[];
}

export interface SettingsFacade {
  /** 读某 namespace（redactSecrets 剥离密钥值）；返回含乐观锁 revision */
  describe(namespace: string, opts?: { redactSecrets?: boolean }): Promise<NamespaceInfo>;
  /** 整体替换（导入/回滚主通道）；expectedRevision 不一致时抛 SETTINGS_CONFLICT 类错误 */
  replace(namespace: string, value: unknown, expectedRevision?: number): Promise<void>;
  /** 部分更新（未来 Merge 策略用） */
  update?(namespace: string, patch: unknown, expectedRevision?: number): Promise<void>;
}

export interface CredentialsFacade {
  /** 只返回状态，永不返回值 */
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

export interface PluginInfo {
  name: string;
  version: string;
  enabled: boolean;
  isBundle?: boolean;
  inBundles?: string[];
  /** 声明依赖 spec（profile package.json dependencies 原样）；文件视图来自 readInstalled */
  spec?: string;
}

export interface PluginsFacade {
  listInstalled(): Promise<PluginInfo[]>;
  /** 安装/更新插件；spec 为来源记录的声明依赖 spec（如 github:user/repo），缺省按裸包名装 npm 最新版。
   * signal 可选：中止时宿主应 kill 子进程并清理半装状态（恢复 package.json + 删 node_modules/<pkg>）。 */
  install(pkg: string, spec?: string, signal?: AbortSignal): Promise<{ needsRestart: boolean }>;
}

export interface WorkspaceFacade {
  listRecords(): Promise<WorkspaceRecord[]>;
  writeRecord(record: WorkspaceRecord): Promise<void>;
  removeRecord?(id: string): Promise<void>;
}

export interface PatchChange { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove'; }

export interface PatchFileFacade {
  readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]>;
  applyPatchChanges(file: string, changes: PatchChange[]): Promise<void>;
}

export interface FileSystemFacade {
  readFile(relPath: string): Promise<Uint8Array>;
  writeFile(relPath: string, data: Uint8Array): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  remove(relPath: string): Promise<void>;
  listRecursive(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
}

/** DSH 运行时门面：m3 只依赖此接口；m5 用真实 ctx.settings/credentials/… 实现 */
export interface HostContext {
  platform: string;
  arch: string;
  homeDir: string;
  dshVersion: string;
  log: Logger;
  settings: SettingsFacade;
  credentials: CredentialsFacade;
  plugins: PluginsFacade;
  workspace: WorkspaceFacade;
  patchFile: PatchFileFacade;
  fs: FileSystemFacade;
  /** 当前管理的 DSH profile 名（如 web）；引擎用它定位 profiles/<profile>/cordis.patch.yml。宿主不暴露时缺省 */
  profile?: string;
  /**
   * 消息翻译器（zh/en 目录，见 messages.ts）。由宿主按 DSH 应用语言注入；
   * 缺省 zh（改造前行为）。引擎与适配器用它生成所有用户可见动态文案。
   */
  msg?: MsgFunc;
}

/* ---------------- 导入计划（§13.3 十类 + 决策） ---------------- */

export type PlanItemKind =
  | 'Create' | 'Update' | 'Skip' | 'Conflict' | 'Install'
  | 'MissingSecret' | 'MissingDependency' | 'PathMapping' | 'Warning' | 'Error';

export type ItemResolution = 'keepCurrent' | 'useImported' | 'review';
export type GlobalConflictStrategy = 'merge' | 'replace' | 'skipExisting';

export interface ConflictDecision { itemId: string; resolution: ItemResolution; }

export interface PathMapping {
  oldPrefix: string;
  newPrefix: string;
  appliesTo: ('workspaces' | 'mcp' | 'pluginConfig' | 'skills')[];
}

export interface PathIssue {
  kind: 'missing' | 'platformMismatch' | 'homeMismatch';
  value: string;
  mappedTo?: string;
}

export interface SnapshotTarget { adapter: SectionId; ref: string; }

export interface PlanItem {
  id: string;                 // 稳定项 id（plugin:pkg / prompt:name / workspace:<id> …）
  kind: PlanItemKind;
  adapter: SectionId;
  description: string;
  detail?: string;
  severity: 'info' | 'warning' | 'error';
  conflict?: ConflictDecision;
  pathMapping?: PathMapping;
  missingDependency?: string;
  target?: SnapshotTarget;    // 该项将修改的目标（快照登记用）
}

/** applyItem 结果。warning=true 表示“未应用但属非致命”（如目标路径不可达/需人工映射），
 * 引擎记为警告、不触发失败回滚（§34.17 单项失败不拖垮整体）。 */
export interface ApplyResult { ok: boolean; message?: string; needsRestart?: boolean; warning?: boolean; }

/* ---------------- 三段式输入输出 ---------------- */

export interface ImportAnalysis {
  valid: boolean;
  errors: string[];
  warnings: string[];
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  sectionsInZip: SectionId[];
  pluginSummary: { installed: number; toInstall: number };
  pathIssues: PathIssue[];
  secretCount: number;
  dependencyIssues: { item: string; dependency: string }[];
  /** 备份是否加密（manifest.security.encrypted）：加密备份的凭据必须用解密密码恢复 */
  encrypted: boolean;
}

export interface ImportDecisions {
  strategy: GlobalConflictStrategy;
  resolutions: Record<string, ItemResolution>;
  pathMappings: PathMapping[];
}

export interface ImportPlan {
  items: PlanItem[];
  globalStrategy: GlobalConflictStrategy;
  pathMappings: PathMapping[];
  missingSecrets: { ref: string; required: boolean }[];
  needsRestart: boolean;
  estimatedActions: Record<SectionId, number>;
}

export interface ExecutedItem {
  itemId: string;
  /** warning = 未应用但非致命（目标不可达等），不计入失败、不触发回滚 */
  status: 'ok' | 'skipped' | 'warning' | 'failed';
  message?: string;
  /** 用户主动跳过（导入中点击「跳过当前插件」）：status 为 skipped 且此标记为 true。
   * 结果页据此区分「用户跳过」与「引擎跳过」，并提供重试入口。 */
  skippedByUser?: boolean;
}

export interface ImportResult {
  ok: boolean;
  executed: ExecutedItem[];
  needsRestart: boolean;
  missingSecrets: string[];
  warnings: string[];
  rollback: RollbackReport | null;
  snapshotId: string | null;
}

/* ---------------- 导入上下文（传给 adapter.analyzeImport / applyItem） ---------------- */

export interface ImportContext {
  manifest: Manifest;
  targetPlatform: string;
  /** 目标 DSH 门面（adapter 比较目标状态 / 写入 / 读取数据用） */
  target: HostContext;
  /** 已由 PathMapper 处理后的各分区最终数据（adapter.applyItem 从这取写入内容） */
  sections: Map<SectionId, unknown>;
  pathMappings: PathMapping[];
  resolutions: Record<string, ItemResolution>;
  /** 用户补录的秘密值（仅内存，永不落盘/日志） */
  secretInputs: Record<string, string>;
  decryptedCredentials?: Map<string, string>;
  log: Logger;
  /** 消息翻译器（analyzer 注入；适配器用它生成计划项描述/校验/结果消息） */
  msg: MsgFunc;
  /**
   * 执行日志回调（executeImportPlan 注入；适配器在发出子进程命令等动作时调用）。
   * 行文本只允许非敏感内容（命令/操作摘要），绝不写入密钥/密码/补录值；
   * Dry Run / 分析阶段未注入（undefined），调用方可空调用。
   */
  onLog?: (line: string) => void;
  /**
   * 当前计划项的中止信号（executeImportPlan 注入；适配器在启动子进程时传给宿主 install）。
   * 用户点击「跳过当前插件」时宿主 abort 该信号 → 子进程被 kill → 该项标记为 user-skipped。
   * 非插件项 / Dry Run 阶段为 undefined。
   */
  signal?: AbortSignal;
}

/* ---------------- Snapshot / Rollback（§8） ---------------- */

export type SnapshotEntryKind = 'settingsNamespace' | 'credential' | 'patchLine' | 'file' | 'workspaceRecord';

export interface SnapshotEntry {
  kind: SnapshotEntryKind;
  adapter: SectionId;
  ref: string;
  /** 原值（credential 条目不含值，仅 existed 标志） */
  before: unknown;
  revision?: number;
  /** file 条目：原文件副本在快照存储中的位置 */
  copiedTo?: string;
  /** credential/file 条目：原目标是否存在 */
  existed?: boolean;
  /** 所属快照 id（file 条目回滚读取 blob 时使用） */
  snapshotId?: string;
}

/** 快照生命周期状态（M1 增强；旧快照无此字段，视为未知/兼容） */
export type SnapshotStatus = 'pending' | 'done' | 'rolled-back';

/** 宿主整文件备份登记（M1）：导入前对 $DSH_HOME 关键文件的整文件快照。
 * relPath 相对 $DSH_HOME（如 settings.yaml / cordis.patch.yml / profiles/<p>/cordis.patch.yml），
 * blobPath 为快照内 blob 路径（existed=false 时为空串，表示该文件当时不存在）。 */
export interface HostFileBackup {
  relPath: string;
  blobPath: string;
  existed: boolean;
}

export interface Snapshot {
  id: string;
  createdAt: string;
  sourceZip: string;
  entries: SnapshotEntry[];
  /** 生命周期状态：pending（已生成，导入未完成）/ done（导入成功）/ rolled-back（失败已回滚）。旧快照缺省 */
  status?: SnapshotStatus;
  /** 导入前已安装插件清单（M2 restore 撤销插件时与当前已装对比）。旧快照缺省 */
  beforePlugins?: PluginInfo[];
  /** 宿主整文件备份（settings.yaml / settings.json / cordis.patch.yml / profiles/<p>/cordis.patch.yml）。旧快照缺省 */
  hostFileBackups?: HostFileBackup[];
}

/** 快照存储（默认文件实现见 core/backup.ts；测试可用内存实现） */
export interface SnapshotStore {
  save(snapshot: Snapshot, blobs?: Map<string, Uint8Array>): Promise<string>;
  load(id: string): Promise<Snapshot>;
  readBlob(id: string, blobPath: string): Promise<Uint8Array>;
  /** 标记快照生命周期状态（导入成功→done；失败回滚→rolled-back；持久化由实现负责） */
  updateStatus(id: string, status: SnapshotStatus): Promise<void>;
}

export interface RollbackReport {
  full: boolean;
  restored: string[];
  failed: { item: string; reason: string; manualHint?: string }[];
}

/* ---------------- 兼容性（§13.3 注释规则） ---------------- */

export interface CompatibilityInput {
  sourceDsh: string;
  targetDsh: string;
  sourcePlatform: string;
  targetPlatform: string;
  schemaVersion: number;
  missingSections: SectionId[];
}

export type CompatibilityScore = 'excellent' | 'good' | 'partial' | 'unsupported';

/* ---------------- 导出报告（规范 §21） ---------------- */

export interface ExportReport {
  included: { section: SectionId; counts: Record<string, number> }[];
  excluded: SectionId[];
  security: {
    secretsExcluded: boolean;
    containsSecrets: boolean;
    encrypted: boolean;
    redactedHits: number;
  };
  file: { name: string; sizeBytes: number };
  warnings: string[];
}

/* ---------------- ConfigAdapter 契约（m5 实现；§13.2） ---------------- */

export type Portability = 'portable' | 'deviceSpecific' | 'platformSpecific';

export interface ConfigAdapter<TSection = unknown> {
  readonly id: SectionId;
  readonly displayName: string;
  readonly defaultIncluded: boolean;
  readonly portability: Portability;

  /** 读取当前 DSH 该类别配置 → 导出数据（无秘密值） */
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<TSection>>;

  /** 分析导入数据与目标 DSH 的差异 → 计划项（纯计算，零写入） */
  analyzeImport(data: TSection, ctx: ImportContext): Promise<PlanItem[]>;

  /** 执行单个计划项（Importer 引擎按阶段调度） */
  applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult>;

  /** 结构校验 */
  validate(data: TSection, msg?: MsgFunc): Promise<ValidationResult>;

  /** 可选：导入前快照（缺省用引擎通用快照） */
  snapshot?(targets: SnapshotTarget[], ctx: HostContext): Promise<SnapshotEntry[]>;

  /** 可选：针对本 adapter 的补偿动作 */
  rollback?(entries: SnapshotEntry[], ctx: HostContext): Promise<void>;
}

/* ---------------- 加密提供者（m4 用 node:crypto 实现） ---------------- */

export interface EncryptionProvider {
  encrypt(plaintext: string): Promise<{ blob: Uint8Array; info: EncryptionInfo }>;
  /** authTag 校验失败必须抛错 */
  decrypt(blob: Uint8Array, info: EncryptionInfo, password: string): Promise<string>;
}

/* ---------------- 错误类型 ---------------- */

/** 导入被确认前拒绝执行（安全阀） */
export class ImportNotConfirmedError extends Error {
  constructor(msg?: MsgFunc) {
    super((msg ?? zhMsg)('import.notConfirmed'));
    this.name = 'ImportNotConfirmedError';
  }
}

/** 导入失败：触发回滚后抛出，携带结果供 UI 展示 */
export class ImportFailedError extends Error {
  readonly result: ImportResult;
  constructor(message: string, result: ImportResult) {
    super(message);
    this.name = 'ImportFailedError';
    this.result = result;
  }
}

/** 当前计划项被用户跳过（导入中点击「跳过当前插件」中止子进程）。
 * 宿主 install 中止时抛出；引擎在 applyOne 捕获并记为 skipped + skippedByUser。 */
export class ImportUserSkippedError extends Error {
  constructor(msg?: MsgFunc) {
    super((msg ?? zhMsg)('import.userSkipped'));
    this.name = 'ImportUserSkippedError';
  }
}
