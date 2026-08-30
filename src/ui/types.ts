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
import type {
  CompatibilityScore, ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  ItemResolution, PathIssue, PlanItem, Portability, RollbackReport,
} from '../core/types.ts';

/* ---------------- 导出（规范 §1 / §21） ---------------- */

export type ExportMode = 'quick' | 'custom';

/** Custom Export 分组（规范 §1 分类；automation 组在 DSH 中无对应分区，UI 标注说明） */
export type ExportGroup =
  | 'general' | 'ai' | 'extensions' | 'mcp' | 'customization'
  | 'automation' | 'workspace' | 'ui' | 'optional';

/** 分类树节点（与 adapters 的 displayName/defaultIncluded/portability 对齐；宿主可注入覆盖） */
export interface ExportCategory {
  id: SectionId;
  label: string;
  description: string;
  defaultIncluded: boolean;
  portability: Portability;
  group: ExportGroup;
  /** 涉及秘密状态（如 credentialsStatus）：UI 需展示安全提示但绝不显示值 */
  sensitive?: boolean;
}

export interface ExportGroupDef {
  id: ExportGroup;
  label: string;
  /** automation 组在 DSH 无对应配置时的说明 */
  note?: string;
}

/** Custom Export 分组目录（规范 §1；automation 组 DSH 无对应分区，仅说明） */
export const EXPORT_GROUPS: readonly ExportGroupDef[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'mcp', label: 'MCP / Tools' },
  { id: 'customization', label: 'Customization' },
  { id: 'automation', label: 'Automation', note: 'DSH 当前无 Workflows / Commands 配置文件（运行时注册），无迁移内容' },
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

/* ---------------- 兼容性（规范 §30） ---------------- */

export interface CompatibilityView {
  score: CompatibilityScore;
  sourceDsh: string;
  targetDsh: string;
  description: string;
}

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

export interface RollbackView {
  report: RollbackReport | null;
  /** 是否有可展示的人工恢复清单（partial 回滚时） */
  hasManualRecovery: boolean;
}

/* ---------------- 控制器公共依赖注入 ---------------- */

/** UI 层与 core 的导入端口（宿主注入真实 Importer；测试注入内存 mock） */
export interface ImportPort {
  analyzeImport(zipPath: string): Promise<ImportAnalysis>;
  createImportPlan(zipPath: string, decisions: ImportDecisions): Promise<ImportPlan>;
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
    },
  ): Promise<ImportResult>;
}

/** 选项构造辅助：从 PlanItem 提取稳定决策键（与 core analyzer.applyItemResolution 的 id 语义一致） */
export function itemDecisionKey(item: PlanItem): string {
  return item.id;
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

/** GET /recovery/status 响应。 */
export interface RecoveryStatus {
  incidents: RecoveryIncident[];
  running: { runId: string; status: string }[];
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
}
