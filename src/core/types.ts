/**
 * 核心引擎契约类型（对齐 Docs/design/architecture.md §13.2/§13.3/§13.5）。
 *
 * 关键解耦原则：核心引擎只依赖这里的接口，绝不 import DSH 运行时包。
 * HostContext 是 m3 定义、m5 实现的 DSH Service 门面（研究报告 §3.2 的叶子方法最小集），
 * 测试用内存 mock 即可驱动完整导出→导入往返。
 */
import type { EncryptionInfo, Manifest, SectionId, WorkspaceRecord } from '../schema/types.ts';
import type { TombstoneKind } from '../schema/tombstones.ts';
import type { MutationLockPort } from '../utils/env-lock.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import type { Logger } from '../utils/logger.ts';
import { zhMsg } from './messages.ts';
import type { MsgFunc } from './messages.ts';

/* ---------------- 导出选项与分区产出 ---------------- */

export interface ExportOptions {
  /** 是否包含真实秘密（必须配合 encryption 提供者；缺省 false = 只导状态） */
  includeSecrets: boolean;
  /** 仅导出指定分区（缺省 = 全部默认包含分区） */
  only?: SectionId[];
  /**
   * 条目级选择（Phase 1）：分区 → 允许导出的「最小可拆单元」id 白名单。
   *
   * 语义（三分，必须严格区分）：
   *  - 键**缺省** → 该分区全量导出（向后兼容：旧调用方零改动，行为与改造前完全一致）；
   *  - 键存在且为**空数组** → 该分区整体不导出（等价于未勾选该分区；Exporter 在选定阶段即剔除，
   *    不会产出空载荷分区，manifest.sections 相应为 false）；
   *  - 键存在且非空 → 只导出白名单内的单元，其余单元被剔除。
   *
   * 单元 id 由 ConfigAdapter.listUnits() 声明（规则见 adapters/units.ts）——
   * 未实现 listUnits 的分区不可细分，传入白名单一律忽略（保持全量）。
   */
  includeItems?: Partial<Record<SectionId, string[]>>;
  /**
   * 会话分区按数量筛选（issue #39 Feature 1；**键缺省 = 现有行为**，旧调用方零改动）。
   *
   * 语义（档位与宿主界面一致）：
   *  - 键存在且 `limit` 缺省 / 非整数 → 显式选中 sessions 分区，但不施加数量限制（全带）；
   *  - `limit === 0` → 整个 sessions 分区不带（等价于未勾选）；
   *  - `limit < 0` → 全带（并显式选中该分区）；
   *  - `limit > 0` → 只带「最新 N 个会话」。
   *
   * 「最新」= 该会话目录下**会话日志文件**的最新 mtime（不用目录 mtime：增量写入时不可靠）。
   * 单位是**会话目录**（`<projectKey>/<sessionId>`）——同一会话的新旧日志必须一起走；
   * 文件名判据与排序见 `core/session-select.ts`（不写死文件名）。
   */
  sessions?: { limit?: number };
  /** 导出文件路径（缺省自动生成 dsh-config-<date>.zip） */
  outPath?: string;
  /** 导出备注（P0-④：host 写入 exports/.backup-notes.json，随 self 分区迁移；非敏感） */
  note?: string;
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

/**
 * 分区内「可单独勾选的最小单元」（Phase 1 条目级导出选择）。
 *
 * 单元是**语义整体、不可再拆**：一个技能目录 bundle、一个会话目录、一个插件包。
 * 由 ConfigAdapter.listUnits() 声明；id 命名空间与导入侧 PlanItem.id 一致，
 * 保证「导出时勾选的单元」将来能直接映射到「导入时排除的条目」。
 */
export interface ExportUnit {
  /** 全局唯一 id（`<section>:<单元路径>` / `plugin:<包名>` / `workspace:<id>` …） */
  id: string;
  /** 展示名（包名 / 目录名 / 工作区标题） */
  label: string;
  /** 副标题补充（版本 / 绝对路径等自行格式化的信息；**不要放 UI 文案模板**，文案由 i18n 负责） */
  detail?: string;
  /** 成员文件数（文件类单元用；UI 据此渲染「N 个文件」） */
  fileCount?: number;
  /** 单元体积（字节；文件类 = 成员文件合计） */
  sizeBytes: number;
  /** 原子组：必须与本单元同进同出的其它单元 id（如 pnpm-workspace.yaml ↔ patch 文件） */
  lockedWith?: string[];
  /**
   * 分组名（同分区内的二级分组；如 sessions 按工作区聚合——用户要求「按工作区分类对话」）。
   *
   * 语义：**纯展示层分组**，不参与勾选/导出契约（契约只认 id）。缺省 = 该单元按现有方式
   * 平铺渲染（skills / pluginFiles 等分区行为逐像素不变）。分组名是宿主直出的原始字符串
   * （工作区标题 / 项目键），UI 渲染前同样要过 redact()。
   */
  group?: string;
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
  /**
   * 与 listRecursive 相同的遍历，但**跟随**目录 junction / 符号链接，并附带被跳过的链接清单
   * （issue #37）。可选：未实现时调用方回退到 listRecursive（行为与旧版一致）。
   */
  listRecursiveDetailed?(dir: string): Promise<RecursiveListing>;
  /**
   * 文件最后修改时间（毫秒时间戳；文件不存在 / 读不到 → null）。
   *
   * 可选：未实现时，依赖它的能力（sessions 的「最新 N 个」）必须**退回安全行为**
   * （全量导出 + 告警），绝不假定 0——把未知当成「最旧」会静默丢掉最近的会话。
   */
  mtimeMs?(relPath: string): Promise<number | null>;
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
  /**
   * 跨进程环境锁契约（Phase 2，可选注入）。宿主在构造时注入 GLOBAL EXCLUSIVE MUTATION LOCK
   * 的 port；核心 destructive 入口用 runWithMutationLock(ctx.mutationLock, …) 包住 ——
   * 无有效父 token → acquire（被别的进程/操作持有则抛 EnvironmentLockUnavailableError），
   * 有有效父 token（nested rollback 等）→ reuse，不 reacquire。
   * 测试 mock 缺省不注入 → 无锁环境（不锁定、不抛）。绝不用进程级 reentrancy 判断嵌套。
   */
  mutationLock?: MutationLockPort;
  /**
   * Phase 3 SAFE MODE：同步谓词（读内存标志），供 runWithMutationLock/withMutationLock 的
   * isBlocked 注入（env-lock 不识 policy）。true → 阻断 destructive。
   */
  safeModeIsBlocked?: () => boolean;
  /** Phase 3 恢复/事务（JournalStore + reconcile + runJournaled/runExternalIntent）。宿主注入。 */
  phase3Recovery?: import('./phase3-host.ts').Phase3Recovery;
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
  /**
   * 「最小可拆单元」id（Phase 2 条目级导入选择，可选）。
   *
   * 为什么需要它：导入选择器不能按裸计划项勾选 —— skills/sessions 的计划项是**逐文件**的
   * （`skills:bar/SKILL.md`、`skills:bar/ref.md`），而用户心智里是一个技能/一次会话。
   * 由适配器用与导出侧 `listUnits()` **同一套** unitIdOf 规则声明单元 id，两端因此自动对齐
   * （排除 `skills:bar` 即排除其全部成员项），UI 无需猜前缀。
   *
   * 缺省 = 本项自身即一个单元（插件包、工作区记录、patch 行等）。
   */
  unitId?: string;
  /**
   * 单元的**展示名**（可选；宿主在计划生成后填充，如 sessions 的「会话标题」）。
   *
   * 为什么由宿主填：会话标题在 DSH 自己的存储里（`$DSH_HOME/storages/session_projcache.json`），
   * 引擎看不到也不该猜。缺省 = UI 退回用单元 id（会话目录名）显示 —— 用户实测「导入页只显示
   * 文件名」就是这个缺省态。纯展示字段：不参与勾选/执行契约。
   */
  label?: string;
  /** 单元的**二级分组名**（可选，同 `/export-preview` 的 `ExportUnit.group` 语义；纯展示）。 */
  group?: string;
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
  /**
   * 备份 manifest 声明启用、但**本版本不认识**的分区 id（不在 `SECTION_IDS` 中）。
   *
   * 语义（G-01/G-02/G-03）：这些分区的数据被跳过、未导入，且**绝不**计入
   * `missingSections` —— 它们并非「备份声明了但文件缺失」，而是「本插件不认识」。
   *
   * 当前用户可见路径是 `warnings` 里的文案键 `import.unsupportedSections`
   * （`ImportWizardView` 直接渲染 `analysis.warnings`）；本字段供第三方实现者与
   * 后续 UI 做结构化展示（例如把「未知分区」与「版本过高」分列）。**尚无 UI 消费点。**
   */
  unsupportedSections: string[];
  /**
   * 已知分区、但其数据 `version` **高于**本版本支持的 1 → 该分区已被跳过（G-05）。
   *
   * 与 `unsupportedSections` 的区别：那个是「本插件不认识这个分区」，这个是
   * 「认识这个分区，但它来自更新的格式」。两者都只告警、不阻断整个 bundle。
   *
   * 当前用户可见路径是 `warnings` 里的文案键 `import.unsupportedSectionVersion`；
   * 本字段供第三方实现者与后续 UI 与 `unsupportedSections` 分列展示。**尚无 UI 消费点。**
   */
  unsupportedVersions: { section: SectionId; version: number }[];
  pluginSummary: { installed: number; toInstall: number };
  pathIssues: PathIssue[];
  secretCount: number;
  dependencyIssues: { item: string; dependency: string }[];
  /** 备份是否加密（manifest.security.encrypted）：加密备份的凭据必须用解密密码恢复 */
  encrypted: boolean;
  /**
   * 凭据可恢复性摘要（issue #39 Feature 2；**可选字段**，旧调用方零改动）。
   *
   * 目的：让宿主不必自己解开 `security/secrets.enc` 再解析 `.credentials.yaml` 才能
   * 判断「包里的凭据能不能自动回填」（那等于把 `.credentials.yaml` 的布局知识复制到
   * 每个宿主，正是 issue #39 的坑）。**只回传 ref 名，永远不回传任何值。**
   *
   *  - `inArchive`：归档声明携带真实凭据值（`manifest.security.containsSecrets`）；
   *  - `refs`：本次分析**实际解出**的凭据 ref 名（宿主未提供解密结果时为 `[]`；
   *    即「包含密码」这一前提不具备时，只能给出 `inArchive=true` 而不能给出名字）；
   *  - `satisfied`：`refs` 中**本机已配置**的子集（无需回填、也无需人工补录）。
   */
  credentials?: { inArchive: boolean; refs: string[]; satisfied: string[] };
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
  /** F4：被删除墓碑（tombstone）过滤掉的计划项（缺省/空数组 = 无过滤；UI 据此提示用户） */
  skippedTombstoned?: SkippedTombstone[];
}

/** F4：被墓碑过滤的计划项记录（条目级：kind+id；分区级：kind='section'，id=分区 id） */
export interface SkippedTombstone {
  kind: TombstoneKind;
  id: string;
  adapter: SectionId;
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
  /** F4：本次导入被删除墓碑过滤掉的条目（缺省/空 = 无过滤；UI 据此提示用户） */
  skippedTombstoned?: SkippedTombstone[];
  /**
   * issue #39：本次导入**从加密归档内解出并回填本机**的凭据条数（字段只增不改）。
   * 缺省 = 未经归档恢复（普通备份 / 用户手工补录），此时不出现该字段。
   * 只回传条数，绝不回传 ref 名或值——结果会进 run 账并回传浏览器。
   */
  credentialsRestored?: number;
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

/** 快照 readiness（Phase 4）：CREATING = 未完成不可用；READY = 已验证可恢复。旧快照无此字段 → LEGACY。 */
export type SnapshotReadiness = 'CREATING' | 'READY';

/** 快照完整性 manifest（Phase 4，F1）：blob hashes + 破坏性内容 hash。 */
export interface SnapshotManifest {
  schemaVersion: number;
  snapshotId: string;
  entryCount: number;
  /** blobPath → sha256（blob 完整性） */
  blobHashes: Record<string, string>;
  /** 破坏性内容（entries + hostFileBackups + beforePlugins）的 sha256；稳定（不含 readiness/status） */
  metadataHash: string;
}

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
  /** 置顶标记（P1-⑧）：置顶快照在保留清理（自动删最旧）中豁免，需用户手动删除 */
  pinned?: boolean;
  // ---- Phase 4 新增（F1：operation-bound + integrity + readiness）----
  /** 绑定 upgrade operation（journal.operationId ↔ snapshot.operationId） */
  operationId?: string;
  /** 来源操作类型（import/profile-switch/sync-apply/reinstall） */
  operationType?: string;
  /** 环境绑定（journal.environmentFingerprint ↔ snapshot.environmentFingerprint） */
  environmentFingerprint?: string;
  /** ownership epoch（journal.ownerInstanceId ↔ snapshot.ownerInstanceId） */
  ownerInstanceId?: string;
  /** readiness：CREATING = 未完成不可用；READY = 已验证可恢复。旧快照缺省 → LEGACY */
  readiness?: SnapshotReadiness;
  /** 完整性 manifest（blob hashes + 破坏性内容 hash） */
  manifest?: SnapshotManifest;
}

/** 快照存储（默认文件实现见 core/backup.ts；测试可用内存实现） */
export interface SnapshotStore {
  save(snapshot: Snapshot, blobs?: Map<string, Uint8Array>): Promise<string>;
  load(id: string): Promise<Snapshot>;
  readBlob(id: string, blobPath: string): Promise<Uint8Array>;
  /** 标记快照生命周期状态（导入成功→done；失败回滚→rolled-back；持久化由实现负责） */
  updateStatus(id: string, status: SnapshotStatus): Promise<void>;
}

/**
 * Phase 4 生产 journal↔snapshot 绑定 context（由宿主注入引擎，引擎在首 destructive side effect 前调用）。
 * 保证「快照 durable+verified 且 journal 已知」先于任何写。结构上兼容 phase3-host 的 JournalRunContext；
 * 这里用最小接口避免 core 引擎依赖 phase3 宿主实现（显式 ctx，无 process-global）。
 */
/** 逐计划项 WAL step 记录（P2-B，Phase 8）：供 reconcile 判精度。 */
export interface JournalStepRecord {
  /** 稳定 step id（= plan item id；跨进程稳定）。 */
  id: string;
  adapter: string;
  kind: string;
  /** 目标引用（文件类项 = 绝对目标路径，供 reconcile 指纹判定；非文件项可为空串）。 */
  ref: string;
  /** 外部副作用（非文件项，如 settings/plugins/patchLine）→ reconcile 一律保守。 */
  external: boolean;
  status?: 'planned' | 'done' | 'failed' | 'skipped' | 'attention';
  /** side effect 前目标内容指纹（null = 不可指纹）。 */
  beforeFp?: string | null;
  /** side effect 后重读磁盘指纹（null = 不可指纹）。 */
  afterFp?: string | null;
  /** 该项的结论文案（issue #35：安装失败与「用户跳过」必须可区分）。 */
  message?: string | null;
}

export interface TransactionSnapshotContext {
  operationId: string;
  operationType: string;
  environmentFingerprint: string;
  ownerInstanceId: string;
  /** 记录 journal.snapshotId 并推进 SNAPSHOT_CREATED（快照已 durable+verified 后调用）。 */
  bindSnapshot: (snapshotId: string) => Promise<void>;
  /** 首个 destructive side effect 前调用：SNAPSHOT_CREATED→APPLYING。 */
  markApplying: () => Promise<void>;
  /**
   * 逐计划项 WAL（P2-B，可选）：记录一个将执行/已执行的 step。
   * 文件类项带 beforeFp/afterFp（可证明）；非文件项 external=true（reconcile 维持保守）。
   * 不实现/不传 = 无逐项 journal（opaque intent，保持 Phase 3 行为）。
   */
  recordStep?: (step: JournalStepRecord) => Promise<void>;
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
    /** 本次导出镜像到本机 vault 的敏感文件数（文件级 vault；0 或缺失 = 未镜像） */
    vaultRefreshed?: number;
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

  /** 读取当前 DSH 该类别配置 → 导出数据（无秘密值）。
   *  实现方应尊重 `options.includeItems?.[this.id]`（条目级选择，见 adapters/units.ts）。 */
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<TSection>>;

  /**
   * 可选（Phase 1）：把本分区的导出产物拆成「可单独勾选的最小单元」清单。
   *
   * 契约：
   *  - **纯函数、零 I/O** —— 输入即 export() 已产出的 ExportSection，因此预览端点可以
   *    零额外读盘地枚举（不需要第二次遍历目录/读文件）；
   *  - 与 export(includeItems) **自洽**：本方法产出的 id 就是 includeItems 接受的 id；
   *  - 未实现 = 本分区不可细分（UI 只给整体开关，传入白名单一律忽略）。
   */
  listUnits?(section: ExportSection<TSection>): ExportUnit[];

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
