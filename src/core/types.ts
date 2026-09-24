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
   * 本单元**拥有的会话 id**（工作区单元专用；issue #45）。
   *
   * 用途：勾选联动 —— 勾了会话就自动勾上它所属的工作区，取消工作区就取消它的会话。
   * 取值 = 工作区记录 sessionIds 原样（`session-<uuid>` 形态，与会话单元 id 的末段目录名归一化后配对），
   * 不翻译路径（跨机时路径不可靠）。
   */
  sessionIds?: string[];
  /**
   * 本单元 **path 的 cwd 目录键**（`projectKeyOf(path)`；工作区单元专用；issue #45）。
   *
   * 为什么需要第二判据：DSH 的 `sessionIds` **只登记了一部分会话**（真机实测：一次可选择 570 条会话里
   * 只有 23 条落在 sessionIds 内），而 DSH 自己按「会话 cwd 的目录键 == 工作区 path 的目录键」把会话显示在
   * 工作区下。勾选联动必须与**显示口径**一致，否则用户在界面上看到对话挂在某工作区下、勾它却不联动。
   */
  projectKey?: string;
  /**
   * 分组名（同分区内的二级分组；如 sessions 按工作区聚合——用户要求「按工作区分类对话」）。
   *
   * 语义：**纯展示层分组**，不参与勾选/导出契约（契约只认 id）。缺省 = 该单元按现有方式
   * 平铺渲染（skills / pluginFiles 等分区行为逐像素不变）。分组名是宿主直出的原始字符串
   * （工作区标题 / 项目键），UI 渲染前同样要过 redact()。
   */
  group?: string;
  /**
   * 父对话的会话裸键（`sessionIdKey(目录名)`；**只有 `origin='subagent'` 的子代理会话才有值**）。
   *
   * 用途：导出选择器里的「父 ↔ 子会话」勾选联动（勾父自动勾上它的子代理会话；勾子自动带上父）。
   * 为什么必须由宿主下发：父子关系只存在于 DSH 的会话存储里（`SessionStoreFacade.parentRelations()`），
   * 浏览器侧无从推断 —— 不下发时联动静默失效，界面勾选与包内容就会不一致（用户实测：勾 2 条、
   * 包里 41 条）。非 sessions 分区 / 非子代理会话一律不设该字段（不猜）。
   */
  parentSessionId?: string;
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
  /**
   * 把一个**已存储在目标机**的会话登记进工作区（issue #45 会话归位）。
   *
   * 对应 DSH `workspaceRegistry` 的 `Workspace.attachSession()`：DSH 自己会读会话 header、
   * 用 realpath 校验 cwd 必须等于该工作区 path，再走 storage domain 原子写入 sessionIds
   * （自动去重，并按 cwd 剪掉不属于本工作区的候选）。因此插件**不得**旁路直写 workspace.json。
   *
   * 可选：未实现（或 registry 不可用）时，归位功能只能产出计划、不能落地。
   */
  attachSession?(workspaceId: string, sessionId: string): Promise<void>;
}



/**
 * 会话存储端口（会话归位用；宿主侧对接 `ctx.sessionPersistence`）。
 *
 * 纪律：**该端口不暴露任何字节级细节**——多帧 zstd 与「目录由 header cwd 推导」是 DSH
 * 私有存储格式，格式知识只允许存在于宿主适配器里（core 保持与 DSH 解耦）。
 */
export interface SessionStoreFacade {
  /**
   * 让工作区注册表重新索引某个会话的 header —— 改写后**必须**调用：注册表内存里仍是旧 cwd，
   * 不刷新的话 `attachSession` 会拿旧 cwd 做 realpath 校验而失败。
   * 返回 false = 宿主无法刷新（诚实降级：需重启 DSH 后再执行一次归位）。
   */
  reindexSessionHeader?(sessionId: string): Promise<boolean>;
  /**
   * 只读：从会话日志的**字节**里取出首帧 header 的 cwd（issue #45 ④ 导入期位置校验用）。
   *
   * 为什么是字节而不是路径：导入时才刚写完文件、甚至可能处在「位置与 header 不一致」的
   * 中间态 —— 此时会话存储的 list/解析接口会**抛错**（DSH 的 `corrupt session log`），
   * 只有「拿字节自己解首帧」这条路仍然可用。zstd 知识留在宿主侧，core 不碰格式。
   * 解不出来（非日志 / 非 zstd / 首帧不完整）→ 返回 undefined（调用方按「无法判定」处理，绝不猜）。
   */
  readLogCwd?(bytes: Uint8Array): string | undefined;
  /**
   * 按**路径**把一个会话目录搬到目标 projectKey 段下（同 `moveSession` 的安全约束：
   * 同一会话根内、目标已存在不覆盖、POSIX 有 `session.lock` 不搬、搬后自检失败回滚）。
   *
   * 与 `moveSession` 的区别：这条不依赖会话存储的解析接口（导入刚写完时那里可能是坏的），
   * 只认路径。`sessionDirRel` = 相对会话根的目录（`<projectKey>/<会话目录>`）。
   */
  relocateDir?(sessionDirRel: string, targetProjectKey: string): Promise<SessionMoveResult>;
  /**
   * 按**路径**改写一个会话目录下全部 generation 的首帧 header cwd（导入期跨机路径映射用）。
   *
   * 与 rewriteCwd 的区别：这条不依赖会话存储的解析接口（导入刚写完时那里可能是坏的），只认路径。
   * sessionDirRel = 相对会话根的目录（projectKey/会话目录）。宿主契约：只替换第 1 帧、
   * 其余帧逐字节保留、发布前自检 + 原子替换，失败不发布并尽量回滚已改写的其它 generation。
   */
  rewriteLogDir?(sessionDirRel: string, newCwd: string): Promise<SessionRewriteResult>;
  /**
   * 只读：本机会话的**父子关系**（子会话 id → 父会话 id，均按日志 header 原样形态）。
   *
   * 为什么需要：DSH 工作区把子代理会话显示在父对话的树状图下面，导出父对话时必须连带它的
   * 子会话（否则目标机上那棵树是空的）；而逐个读日志首帧去反查父子关系等于把整棵会话树读一遍
   * （用户实测会话树数百 MB）。宿主用 DSH 自己的存储列举实现（解析成本在 DSH 侧已付）。
   * 缺省 = 无法连带子会话（本次导出只有「子会话带父对话」这一个方向，如实反映在报告里）。
   */
  parentRelations?(): Promise<Map<string, SessionParentRelation>>;
}

/**
 * 一条会话的父关系（宿主从 DSH 存储列举得到）。
 *
 * `subagent` = 该会话自己是不是**子代理会话**（header.origin === 'subagent'）：DSH 只把子代理会话
 * 显示在父对话之下，`origin` 非 subagent 的会话即使有 parentSession 也是顶层行 —— 连带导出必须按
 * 这个标记筛选，否则会把顶层对话也当成「树上的子节点」带进来。
 */
export interface SessionParentRelation {
  parent: string;
  subagent: boolean;
}

/** 会话日志首帧 header 改写结果（issue #45 P3）。 */
export interface SessionRewriteResult {
  ok: boolean;
  /** 实际改写的文件绝对路径（一个会话可能有多份 generation，必须一起改） */
  rewritten?: string[];
  /** ok=false 时的机器可读原因 */
  reason?: SessionRewriteReason;
}

  /** 改写失败/不可用的原因（文案由宿主适配器/CLI 输出层决定；core 不产出用户文案）。 */
export type SessionRewriteReason =
  /** 运行时缺 zstd 能力或宿主未实现该能力 */
  | 'unavailable'
  /** 会话目录被其它进程持有（POSIX 的 session.lock） */
  | 'locked'
  /** 找不到会话日志文件 */
  | 'no-log'
  /** 不是 zstd 容器（魔数/帧结构损坏） */
  | 'not-zstd'
  /** 首帧不完整（撕裂日志） */
  | 'torn-frame'
  /** 首帧超出读取上限（异常文件，不猜） */
  | 'frame-too-large'
  /** files 里的 cwd 与预期不符（不擅自改别人的会话） */
  | 'cwd-mismatch'
  /** 首帧不是单行 JSON 对象，或序列化会改动其它字段 */
  | 'invalid-header'
  /** 写临时文件 / 原子替换失败 */
  | 'write-failed'
  /** 发布前自检不过 */
  | 'verify-failed';

/** 会话目录搬迁结果（moved=false 时 reason 说明为什么没搬，属正常路径而非异常）。 */
export interface SessionMoveResult {
  moved: boolean;
  from?: string;
  to?: string;
  reason?: 'no-current-log' | 'already-there' | 'conflict' | 'locked' | 'unavailable';
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
  /**
   * 绝对路径的 realpath（issue #45 会话归位用）。
   *
   * 语义与 DSH `realpathNormalize` 对齐：只接受**已存在**的目录，解析符号链接 / `..` / 结尾斜杠
   * 后返回规范化绝对路径；路径不存在或不可解析 → null（**不得**退回原字符串：那会把
   * 「不存在的源机路径」误判成可归位）。
   *
   * 可选：未实现时归位功能只产出 ungrouped 计划 + 告警，绝不猜测 cwd 与工作区是否同一目录。
   */
  realpathDir?(absPath: string): Promise<string | null>;
  /**
   * 确保绝对路径目录存在（issue #45 已知缺口：导入工作区记录前不建目录 → DSH `create()`
   * 的 realpath 直接 ENOENT，只留一句非致命警告）。
   *
   * 语义：只接受**完全限定**的绝对路径；拒绝含 `..` 的路径（即使 resolve 会折叠它，
   * 也说明来源可疑 —— 路径来自备份，属不可信输入）；已存在 → 返回空数组；
   * 否则递归创建并返回**实际新建**的目录（由外到内），供报告如实展示。
   *
   * 可选：未实现时调用方退回既有行为（不建目录 → 由 DSH 报 realpath 失败的非致命警告）。
   */
  ensureDir?(absPath: string): Promise<string[]>;
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
  /**
   * 会话存储端口（issue #45 会话归位；宿主注入对应 `ctx.sessionPersistence`）。
   *
   * 可选：缺省时归位功能整体不可用（依赖它的调用点必须报「宿主未提供会话存储」而不是静默成功）。
   */
  sessions?: SessionStoreFacade;
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
  /** 本项对应的**工作区记录拥有的会话 id**（工作区计划项专用；issue #45 勾选联动）。 */
  sessionIds?: string[];
  /** 本工作区计划项 **path 的 cwd 目录键**（`projectKeyOf(path)`；issue #45 勾选联动第二判据）。 */
  projectKey?: string;
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
  /**
   * 本次**自动**加入的基础路径重定基规则（导出机 DSH home → 本机 DSH home；issue #45）。
   *
   * 只读展示用：它已被并入 pathMappings（排在最前，用户映射随后生效）。缺省 = 两边基础路径相同
   * 或旧包没带 sourceHome（此时不做任何自动改写，行为与改造前一致）。
   */
  automaticMappings?: PathMapping[];
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
  /**
   * 用户在运行中心终止了本次导入（宿主 /runs/cancel 在**计划项边界**协作式取消）。
   * true 时 executed 只覆盖已尝试的项，且 keptPartial 表明用户如何处置已应用部分。
   */
  cancelled?: boolean;
  /**
   * 终止时用户选择「保留已应用项」（cancelled=true 时才有意义）。
   * 保留 = 在安全点停下 + 跑完分区收尾 + 未执行项在 journal 里显式标 skipped。
   * 此时快照**保持可用**（不标 done / 不标 rolled-back），用户可事后在「备份」页手动回滚。
   */
  keptPartial?: boolean;
  /**
   * keptPartial=true 时的启动自洽审计结论（缺省 = 未审计，UI 必须如实说「未验证」）。
   * 字段只增不改：旧客户端忽略它即可。
   */
  bootSafety?: {
    verdict: 'safe' | 'repaired' | 'unsafe';
    issues: { id: string; severity: 'warn' | 'error'; detail: string; fixed: boolean }[];
    prunedBundles: { name: string; reason: string }[];
    unchecked: string[];
  };
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
  /**
   * 可选：本分区是「文件集合」——相对路径本身就是身份，不是可配置内容。
   *
   * 导入时的前缀映射**绝不**套用到这类分区：`FileCollectionAdapter` 拿 `relativePath`
   * 当落盘路径，改写它等于把文件搬到 DSH 期望之外的位置。sessions 尤其致命——位置一旦
   * 与 `projectKeyOf(首帧 cwd)/id` 不一致，目标机**下次启动直接失败**
   * （`corrupt session log … header id and cwd identify …`，issue #45 ④ 实测）。
   */
  readonly fileCollection?: boolean;

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

  /**
   * 可选：单元级「最近活跃时间」（毫秒），键 = **会话裸键**（`sessionIdKey(目录名)`）。
   *
   * 用途：导出选择器的排序时间源（`/export-preview` 在枚举单元后调用）。为什么不能只靠
   * `storages/session_projcache.json` 的 lastPromptAt：那份缓存只覆盖一部分会话（真机实测：同一项目
   * 731 个会话目录里 347 个不在缓存内），缺时间的会话会退化成按 uuid 排序、全部堆在组尾。
   * 目前只有 sessions 分区实现（数据源 = 会话日志文件 mtime）；未实现 / 时间未知 → 空 Map，
   * 调用方按「时间未知」处理，绝不猜成 0。
   */
  unitActivityTimes?(ctx: HostContext, section: ExportSection<TSection>): Promise<Map<string, number>>;

  /**
   * 可选：枚举本机**全部**单元 id（不是本次勾选的那部分）。
   *
   * 用途：会话删除墓碑（P1-5）——「上次推过、本机已不存在」才是「用户删了它」；只看本次
   * 勾选集合会把「这次没勾」误判成删除，把还在的对话打成墓碑。未实现 / 枚举失败 → 调用方
   * 跳过删除检测（保守方向：宁可漏报删除，绝不误标）。
   */
  listAllUnitIds?(ctx: HostContext): Promise<string[]>;

  /** 分析导入数据与目标 DSH 的差异 → 计划项（纯计算，零写入） */
  analyzeImport(data: TSection, ctx: ImportContext): Promise<PlanItem[]>;

  /**
   * 可选：本分区**全部计划项写完之后**的分区级收尾（issue #45 ④）。
   *
   * 为什么需要这一层：有些判定必须等整个分区写完才有意义 —— 一个会话目录含多份 generation，
   * 若在单文件 `applyItem` 里边写边搬，后续文件会被写回旧路径。返回逐条结果（ok / warning / failed），
   * 引擎按现有规则记入 `executed`：warning 非致命、failed 按 `rollbackOnError` 决定是否回滚。
   */
  finalizeApply?(ctx: ImportContext): Promise<ApplyResult[]>;

  /**
   * 可选：**全部**分区收尾完成之后的最后一次收尾（issue #45）。
   *
   * 与 finalizeApply 的区别：finalizeApply 只保证「本分区写完」，而「把会话登记进工作区」要求
   * 会话文件已写盘**且**首帧 cwd 已按映射改写/归位 —— 工作区分区在 APPLY_ORDER 里排在会话之前，
   * 所以这件事必须等所有分区收尾后再做，否则 attachSession 拿旧 cwd 校验必然失败。
   */
  finalizeImport?(ctx: ImportContext): Promise<ApplyResult[]>;

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
