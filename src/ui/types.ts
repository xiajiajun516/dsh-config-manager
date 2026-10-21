/**
 * UI 层共享类型（m6-ui，框架无关）。
 *
 * 设计原则（对齐 Docs/design/architecture.md §12.2 与规范 §28/§29）：
 *  - 本模块为纯 TypeScript 逻辑层，不引入 React / 打包器 / 任何运行时依赖；
 *  - 未来 React 客户端（src/client/）直接消费本层的控制器输出（渲染文本 / 状态快照）；
 *  - UI 层不直接 import core 的类实现，只依赖 core/types.ts 的纯类型 + 注入的「端口」
 *    （ExportPort / ImportPort，宿主在 settings.section 挂载时把真实 Exporter/Importer 接入）。
 */
import type { SectionId } from '../schema/types.ts';
import type { DiskUsageReport } from '../core/disk-usage.ts';
import type {
  SessionHealthResponse,
  SessionRepairResult,
  SessionRepairRollbackResult,
} from './session-inventory-view.ts';
import type {
  ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  ItemResolution, PathIssue, PlanItem, Portability, SessionFormatDisposition,
} from '../core/types.ts';
import type { SelfUpdateFailureCode } from '../utils/shared-constants.ts';
// 只导入**类型**：文案键在这里出现，文案本身由渲染层用 UiT 解析（静态目录不再放中文/英文句子）。
import type { UiTextKey } from './i18n.ts';

/* ---------------- 导出（规范 §1 / §21） ---------------- */

/** Custom Export 分组（规范 §1 分类；automation 组在 DSH 中无对应分区，UI 标注说明） */
export type ExportGroup =
  | 'general' | 'ai' | 'extensions' | 'mcp' | 'customization'
  | 'automation' | 'workspace' | 'ui' | 'optional';

/** 分类树节点（与 adapters 的 displayName/defaultIncluded/portability 对齐；宿主可注入覆盖） */
export interface ExportCategory {
  id: SectionId;
  label: string;
  /**
   * 描述文案的**字典键**（英文界面零中文：静态目录只留键，渲染层 t(descriptionKey) 取词）。
   * 此前这里是硬编码中文字符串，英文界面下会原样透出。
   */
  descriptionKey: UiTextKey;
  defaultIncluded: boolean;
  portability: Portability;
  group: ExportGroup;
  /** 涉及秘密状态（如 credentialsStatus）：UI 需展示安全提示但绝不显示值 */
  sensitive?: boolean;
}

export interface ExportGroupDef {
  id: ExportGroup;
  label: string;
  /** automation 组在 DSH 无对应配置时的说明（**字典键**：由渲染层用 UiT 解析） */
  noteKey?: UiTextKey;
}

/** Custom Export 分组目录（规范 §1；automation 组 DSH 无对应分区，仅说明） */
export const EXPORT_GROUPS: readonly ExportGroupDef[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'mcp', label: 'MCP / Tools' },
  { id: 'customization', label: 'Customization' },
  { id: 'automation', label: 'Automation', noteKey: 'export.group.automationNote' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'ui', label: 'UI' },
  { id: 'optional', label: 'Optional Data' },
] as const;

/** Quick Export 推荐项 = defaultIncluded 且非 deviceSpecific（设计 §11.1） */
export function isQuickRecommended(c: ExportCategory): boolean {
  return c.defaultIncluded && c.portability !== 'deviceSpecific';
}

/* ---------------- 进度事件（规范 §29） ---------------- */

export interface ProgressEvent {
  /** 阶段 id（见 progress.ts 的 STAGE_TEXTS） */
  stage: string;
  detail?: string;
  /** 阶段序号（从 1 起，供 UI 显示 n/m） */
  step?: number;
  /** 阶段总数 */
  total?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

/* ---------------- 导入向导（规范 §9 / §10 / §28） ---------------- */

export type ImportStep =
  | 'select'          // 选 ZIP
  | 'analyzing'       // Analyzing...
  | 'compatibility'   // Compatibility
  | 'preview'         // Import Preview（Dry Run 摘要）
  | 'conflicts'       // Resolve Conflicts（§11）
  | 'path-mapping'    // Path Mapping（§12）
  | 'secrets'         // Secrets 补录（§7）
  | 'importing'       // Importing（含快照/回滚阶段）
  | 'result';         // Result（§22）

/** Preview 摘要（规范 §10 示例的数值化版本） */
export interface ImportPreviewSummary {
  /** 将更新的配置项数（Create+Update+Install 合计） */
  willChange: number;
  /** 已存在且一致的项（Skip） */
  unchanged: number;
  settingsUpdates: number;
  pluginsInstalled: number;
  pluginsToInstall: number;
  mcpAdds: number;
  prompts: number;
  pathMappingsNeeded: number;
  secretsNeeded: number;
  conflicts: number;
  needsRestart: boolean;
}

/** 向导状态快照（React 客户端可直接绑定渲染） */
export interface WizardSnapshot {
  step: ImportStep;
  zipPath: string | null;
  analysis: ImportAnalysis | null;
  plan: ImportPlan | null;
  result: ImportResult | null;
  /** 导入执行的回滚策略（场景 E：默认 true 整体回滚） */
  rollbackOnError: boolean;
  errors: string[];
}

/* ---------------- 冲突视图（规范 §11） ---------------- */

/** 单个冲突项的视图数据：当前值 vs 导入值摘要 + 用户决策 */
export interface ConflictViewItem {
  item: PlanItem;
  currentSummary?: string;
  importedSummary?: string;
  resolution: ItemResolution | null;
}

/* ---------------- 路径映射（规范 §12） ---------------- */

/** 路径映射编辑器的单条记录（旧前缀 → 新前缀；未解析时 newPrefix 为空串） */
export interface PathMappingDraft {
  /** 关联的原始路径问题值（一条 issue 一条 draft；批量映射用 oldPrefix 聚合） */
  oldPrefix: string;
  newPrefix: string;
  issue?: PathIssue;
  /** 应用范围（缺省 [] = 全部相关分区，与 core applyMappingsToSections 语义一致） */
  appliesTo: PathMappingAppliesTo[];
}

/** 与 core PathMapping.appliesTo 对齐的取值（留空数组 = 全应用） */
export type PathMappingAppliesTo = 'workspaces' | 'mcp' | 'pluginConfig' | 'skills';

/* ---------------- 报告（规范 §21 / §22 / §17） ---------------- */

/** 导入结果按分区的统计（report.ts 用） */
export interface ImportSectionStat {
  section: SectionId;
  ok: number;
  skipped: number;
  warned: number;
  failed: number;
  items: { itemId: string; status: 'ok' | 'skipped' | 'warning' | 'failed'; message?: string }[];
}

export type ImportResultAction = 'fixIssues' | 'viewDetails' | 'done';

/* ---------------- 控制器公共依赖注入 ---------------- */

/** UI 层与 core 的导入端口（宿主注入真实 Importer；测试注入内存 mock） */
export interface ImportPort {
  /**
   * 零写入分析。`opts.decryptPassword`（仅内存，可选）：提供即让宿主解开 secrets.enc，
   * 把 `analysis.credentials`（仅 ref 名，issue #39 Feature 2）一并回传。
   */
  analyzeImport(zipPath: string, opts?: { decryptPassword?: string }): Promise<ImportAnalysis>;
  /**
   * 生成导入计划（Dry Run，零写入）。`opts.decryptPassword`（仅内存，可选）：加密备份必须传，
   * 宿主据此解开 secrets.enc 让**归档里带值的凭据**都进计划——否则这些值永远不会被写回
   * （真机反馈：导入密钥没生效）。不传 = 只按 credentialsStatus 的 ref 名判定。
   */
  createImportPlan(
    zipPath: string,
    decisions: ImportDecisions,
    opts?: {
      decryptPassword?: string;
      /**
       * 会话格式处置（T1；缺省 = 宿主按插件配置项，再缺省 `abort`）：
       * `abort` 时若包内有本机读不了的会话，宿主**在计划阶段**返回带 code 的拒绝（零写入）。
       */
      sessionFormatDisposition?: SessionFormatDisposition;
    },
  ): Promise<ImportPlan>;
  /**
   * 解锁整体加密备份（只读，零写入）：用备份密码解密上传的加密容器，得到明文 ZIP
   * 写入受控临时目录并返回新的 zipPath，供 analyze/plan/execute 引用。
   * 顺带返回解密覆盖的凭据 ref 名（非值）——导出时容器密码与内部 secrets.enc
   * 密码同源，解锁即完成凭据解密验证，无需第二次密码校验。
   * 密码仅内存，绝不落盘/落日志；解密后的明文 ZIP 亦为临时文件，导入结束后清理。
   */
  decryptArchive(zipPath: string, password: string): Promise<{ zipPath: string; refs: string[] }>;
  executeImportPlan(
    zipPath: string,
    plan: ImportPlan,
    opts: {
      /** 用户确认（安全阀，非 true 拒绝执行） */
      confirm: boolean;
      secretInputs?: Record<string, string>;
      /** 显式回滚策略：true=任一项失败整体回滚（场景 E）；false=单项失败继续（§34.17） */
      rollbackOnError: boolean;
      /** 加密备份的解密密码（仅内存；core 拒绝加密备份无密码执行） */
      decryptPassword?: string;
      /** 会话格式处置（T1；`abort` 时计划含读不了的会话即拒绝执行，仍是零写入） */
      sessionFormatDisposition?: SessionFormatDisposition;
    },
  ): Promise<ImportResult>;
}

/* ---------------- 插件版本更新检查（关于 tab；只读探测 npm latest） ---------------- */

/**
 * GET /update-check 的结果。
 *
 * 成功与失败都用 HTTP 200：离线 / registry 不可达**不是插件故障**，界面据 `ok` 决定显示
 * 「已是最新 / 有新版本 / 检查失败（可重试）」，而不是弹错误横幅。
 */
export type PluginUpdateCheckResult =
  | {
      ok: true;
      /** 当前运行的插件版本 */
      current: string;
      /** npm 上的 latest */
      latest: string;
      /** latest > current（严格更新才算；本地跑预发布版时不提示降级） */
      updateAvailable: boolean;
      /** 本次结论时间戳（ms；缓存命中时为首查时间） */
      checkedAt: number;
      /** 是否来自进程内缓存 */
      cached: boolean;
    }
  | {
      ok: false;
      current: string;
      /** 失败原因（网络 / 超时 / 响应畸形；可读、可重试、无敏感信息） */
      error: string;
    };

/**
 * POST /update-apply 的结果（关于页「立即更新」）。
 *
 * 语义：用户**显式点击**后，宿主经官方 `dsh plugin` 通道把本插件安装为**钉住的精确版本**；
 * 成功只表示文件已换新，必须重启 DSH 才生效（needsRestart）。
 * 失败码与宿主共用同一份字面量（utils/shared-constants.ts），界面据码映射本地化文案，
 * 只有未知码才回落到宿主返回的原始错误文本。
 */
export type PluginUpdateApplyResult =
  | { ok: true; version: string; command: string; needsRestart: true }
  | { ok: false; code: SelfUpdateFailureCode; error: string };

/* ---------------- 磁盘占用（快照 tab 的只读体检 + 手动清理） ---------------- */

/** 手动清理可点选的动作：可重建区（tmp + 市场缓存/工作副本）/ 已到期的导出产物。 */
export type DiskUsageCleanCategory = 'tmp' | 'expired-exports';

/** POST /disk-usage/cleanup 的回执（回执里带刷新后的报告，避免界面再发一次 GET）。 */
export interface DiskUsageCleanupResult {
  ok: boolean;
  /** 本次请求实际覆盖的动作 */
  requested: DiskUsageCleanCategory[];
  /** 被排除的动作（只请求了 tmp 时 = ['expired-exports']）——界面据此如实说明，不假装清过 */
  excluded: DiskUsageCleanCategory[];
  /** 删除条目数（文件 + 目录） */
  removed: number;
  /** 释放字节数（含目录递归，按清理前后子区体积差计） */
  freedBytes: number;
  /** 分区级释放量（子区 id → 字节；只含本次实际清理过的子区） */
  freedByArea: Partial<Record<string, number>>;
  /** 单项失败数（不影响其余清理） */
  errors: number;
  /** 逐条删除记录（相对 dataDir 的描述 + 字节数） */
  detail: string[];
  /** 清理后重新体检的报告 */
  report: DiskUsageReport;
}

/* ---------------- Recovery（Phase 5：引导式恢复工作流） ---------------- */

/** recovery 决策（§5.2）：rollback-recommended=恢复到 trusted snapshot；rollback-continue=续跑中断回滚；needs-attention=需人工调查。 */
export type RecoveryDecision = 'rollback-recommended' | 'rollback-continue' | 'needs-attention';

/** post-recovery verification verdict（§6.3）。 */
export type RecoveryVerdict = 'MATCH' | 'PARTIAL_MATCH' | 'MISMATCH' | 'VERIFICATION_ERROR';

/** GET /recovery/status 的单个 incident（未解决 operation）。 */
export interface RecoveryIncident {
  operationId: string;
  operationType: string;
  state: string;
  decision: RecoveryDecision;
  snapshotId: string | null;
  /** 已 redact 的原因文本。 */
  reason: string;
  createdAt: string;
}

/**
 * 正在**正常执行中**的操作（GET /recovery/status 的 `live`，加法字段）。
 *
 * 与 `incidents` 互斥：同一条 active journal 要么是「正在跑」（GLOBAL 锁由它持有、
 * 且 journal.ownerInstanceId 与锁持有者一致），要么是「一次未正常完成的操作」。
 * 判别只发生在宿主侧（single source = recovery-orchestrator 的 isLiveInFlight），
 * 客户端只负责如实展示。
 *
 * 旧宿主不返回 → undefined（面板按「无进行中操作」处理）。
 */
export interface RecoveryActiveOperation {
  operationId: string;
  operationType: string;
  state: string;
  startedAt: string;
}

/** GET /recovery/status 响应。 */
export interface RecoveryStatus {
  incidents: RecoveryIncident[];
  running: { runId: string; status: string }[];
  /**
   * 正在正常执行的操作（不是 incident）。用途：面板要能解释「为什么现在什么都点不动」——
   * 此前这类操作被误报成事故，「执行恢复」永久灰、放弃恢复一直 423，用户拿不到任何原因。
   */
  live?: RecoveryActiveOperation[];
  /**
   * 环境锁状态摘要（issue #31）。纯残留锁**不是** journal：进程在 op 期间被杀时
   * `journalId: null`、`transactions/active/` 为空，incidents 恒为 []，而 423 文案却
   * 让用户去「事故恢复」处理 → 面板恒空、GUI 无出路。本字段让面板能显示可执行的锁事项。
   * 旧宿主不返回 → undefined（面板按「无锁事项」处理，不误报）。
   */
  lock?: RecoveryLockStatus;
  /**
   * SAFE MODE 阻断态（issue #56）。此前 status 完全没有这个信息 ⇒ 「durable 标记还在、
   * active/ 却已空」时面板显示「暂无需要处理的恢复事项」，而所有写操作持续 423 —— 用户
   * 看不到任何线索，也没有任何出口。
   *
   * 旧宿主不返回 → undefined（面板按「未阻断」处理，不误报保护）。
   */
  safeMode?: RecoverySafeModeStatus;
  /**
   * 中断的档案复制残留（cross-F3 / t54）：目标目录带 `.dcm-copy-in-progress.json` 标记、
   * 却没有 package.json 的半截副本。它们既不在档案列表里、删除又报 notFound ——
   * 用户此前在「事故恢复」里既看不到、也没有任何处置入口。
   * 旧宿主不返回 → undefined（按「无残留」处理，不误报）。
   */
  incompleteCopies?: RecoveryIncompleteCopy[];
  /**
   * t89：残留**枚举失败**（读 profiles 目录失败）时为 true —— 与「确实没有残留」
   * （字段缺省）区分开：此前两者在响应里完全同形（都是 `incompleteCopies: []`），
   * 界面便把「读不到」渲染成「暂无残留」。
   * 旧宿主不返回 → undefined（按「读到了」处理，绝不误报失败）。
   */
  incompleteCopiesUnreadable?: boolean;
}

/**
 * 中断的档案复制残留（cross-F3 / t54）：**只允许删除**。
 * 形态恒为 generic ⇒ 不可启动（没有 package.json，spawn 出去只会得到一个起不来的实例）。
 */
export interface RecoveryIncompleteCopy {
  /** 目标档案名（= 目录名） */
  name: string;
  /** 目标目录绝对路径（界面渲染前过 `redact()`） */
  dir: string;
  /** 来源档案名（标记不可解析时为 null —— 界面不臆造） */
  sourceName: string | null;
  /** 复制开始时刻（ISO；标记不可解析时为 null） */
  startedAt: string | null;
}

/** SAFE MODE 阻断态摘要（只暴露结论与是否可解除）。 */
export interface RecoverySafeModeStatus {
  /** durable 标记当前是否在阻断写操作（与 mutation gate 的 isBlocked 同源）。 */
  blocked: boolean;
  /**
   * 是否「没有未解决 incident，可安全解除」——即「结案但保护仍开着」。
   * 面板仅在 blocked && clearable 时渲染「解除安全模式」入口；还有 NEEDS_ATTENTION
   * 事务时必须先处理它（宿主侧也会拒绝，界面不给假按钮）。
   */
  clearable: boolean;
}

/** 环境锁状态摘要：**只暴露分类**（owner pid/op/hostname 属内部诊断，不进 UI/响应体）。 */
export interface RecoveryLockStatus {
  /** LockState：STALE_LOCK_DETECTED / UNKNOWN_STATE / LOCKED / FREE / LOCK_IO_ERROR / PERMISSION_ERROR */
  state: string;
  /** 是否需用户显式处理（残留锁/无法判定）。LOCKED 活锁为 false —— 它会自行释放，不该催用户回收。 */
  attention: boolean;
}

/** POST /recovery/lock/recover 响应（显式回收 stale 残留锁；拒绝时 ok=false）。 */
export interface RecoveryLockRecoverResult {
  ok: boolean;
  removed: boolean;
  state: string;
}

/**
 * POST /recovery/safe-mode/clear 响应（issue #56：显式解除 SAFE MODE）。
 * - 已解除 → `ok:true, cleared:true`；
 * - 本来就没阻断 → `ok:true, cleared:false, reason:'not-blocked'`（幂等，不是错误）；
 * - 还有未解决 incident → `ok:false, cleared:false, reason:'unresolved-incidents', unresolved:N`。
 */
export interface RecoverySafeModeClearResult {
  ok: boolean;
  cleared: boolean;
  reason?: string;
  unresolved?: number;
}

/** GET /recovery/:operationId/preview 响应（只读，零写入）。 */
export interface RecoveryPreview {
  operationId: string;
  operationType: string;
  state: string;
  decision: RecoveryDecision;
  snapshotId: string | null;
  snapshotVerdict: string | null;
  snapshotMeta: { id: string; createdAt: string; operationType?: string } | null;
  environmentFingerprint: string;
  environmentCompatible: boolean;
  reason: string;
  createdAt: string;
}

/** POST /recovery/:operationId/verify 响应。 */
export interface RecoveryVerifyResult {
  ok: boolean;
  operationId: string;
  verdict: RecoveryVerdict;
  terminal: string;
  /** 每项检查结果（已 redact）。 */
  details: string[];
  /** 需人工处理项（已 redact）。 */
  manualHints: string[];
}

/** POST /recovery/:operationId/execute|retry 响应。 */
export interface RecoveryExecuteResult {
  ok: boolean;
  operationId: string;
  decision: RecoveryDecision;
  state: string;
  runId: string;
}

/** POST /recovery/:operationId/confirm 响应。 */
export interface RecoveryConfirmResult {
  ok: boolean;
  operationId: string;
  snapshotId: string;
  verdict: string;
}

/** POST /recovery/:operationId/dismiss 响应。 */
export interface RecoveryDismissResult {
  ok: boolean;
  operationId: string;
  dismissed: boolean;
}

/**
 * Recovery 端口契约（§10.3）：recovery 无现有 port（ExportPort/ImportPort 只服务控制器）。
 * `recovery-api.ts` 实现之；`recovery-view.ts` 是纯渲染模型（非控制器），消费本端口返回的渲染数据。
 * 安全：所有 destructive 动作（confirm/execute/retry/dismiss）必须显式传 userConfirmed=true，
 * 由 Host 侧双重校验（请求体 + journal 状态机）。
 */
export interface RecoveryPort {
  status(): Promise<RecoveryStatus>;
  preview(operationId: string): Promise<RecoveryPreview>;
  confirm(operationId: string, userConfirmed: boolean): Promise<RecoveryConfirmResult>;
  execute(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult>;
  verify(operationId: string): Promise<RecoveryVerifyResult>;
  retry(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult>;
  dismiss(operationId: string, userConfirmed: boolean): Promise<RecoveryDismissResult>;
  /**
   * POST /recovery/lock/recover（issue #31）：显式回收 stale 残留配置锁。
   * 不带 operationId（残留锁没有 journal）；宿主侧会重新证明确属 stale 才回收，
   * 无法证明（活锁/判定不确定/二次验证失败）→ 返回 ok=false 且不做任何改动。
   */
  recoverStaleLock(userConfirmed: boolean): Promise<RecoveryLockRecoverResult>;
  /**
   * POST /recovery/safe-mode/clear（issue #56）：显式解除仍然生效的 SAFE MODE 保护。
   * 不带 operationId（该状态下往往已无 active journal）；宿主侧会重新判定
   * 「是否还有未解决的恢复事项」，有则拒绝（ok=false），绝不无条件清标记。
   */
  clearSafeMode(userConfirmed: boolean): Promise<RecoverySafeModeClearResult>;
  /**
   * GET /recovery/sessions（T5，**只读**）：本机存量会话的体检（损坏分类 + 可见性）。
   *
   * 为什么挂在 RecoveryPort 而不是新开一个端口：它与「我的对话去哪了」是同一件事，
   * 且宿主把它挂在既有 recovery prefix 路由下（不新增注册路由条目）。
   * `limit` 只影响回传浏览器的行数（摘要里的 total 仍是全量口径）。
   */
  sessions(limit?: number): Promise<SessionHealthResponse>;
  /**
   * POST /recovery/sessions/repair（T8）：应用内修复一份会话日志。
   *
   * apply=false 只预览（零写入）；apply=true 时**必须**回传预览给出的 expect 指纹 ——
   * 宿主用它做 TOCTOU 判定（预览之后文件被改过就拒绝，绝不按旧计划写入）。
   * 执行器自带完整安全序列（写前校验 → 时间戳备份 → 原子换入 → 写后复验）。
   */
  repairSession(unitId: string, apply: boolean, expect?: { size: number; mtimeMs: number }, allowLossy?: boolean): Promise<SessionRepairResult>;
  /** POST /recovery/sessions/rollback（T8）：按台账里的 repairId 回滚一次修复（客户端不传路径）。 */
  rollbackSessionRepair(repairId: string): Promise<SessionRepairRollbackResult>;
}
