/**
 * Import 向导状态机（规范 §9/§10/§28，m6-ui）。
 *
 * 步骤：Select ZIP → Analyzing → Compatibility → Import Preview → Resolve Conflicts
 *       → Path Mapping → Secrets → Importing → Result。
 *
 * 关键安全/正确性约束：
 *  - analyzeImport / createImportPlan 零写入（Dry Run 复用，规范 §10）；
 *  - executeImportPlan 必须 confirm=true（core 安全阀），UI 在用户点「确认导入」后传入；
 *  - **显式传 rollbackOnError**：场景 E（§36）要求导入中途失败整体回滚，
 *    本向导默认 rollbackOnError=true，UI 可在执行前让用户选择（true=整体回滚 / false=单项失败继续 §34.17）；
 *  - 秘密补录值仅内存（secretInputs），绝不落日志/落盘。
 */
import type {
  GlobalConflictStrategy, ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  PathMapping, PlanItem,
} from '../core/types.ts';
import type { ImportPort, ImportPreviewSummary, ImportStep, ProgressListener, WizardSnapshot } from './types.ts';
import { EXECUTING_STAGE, IMPORT_STAGES, ProgressTracker } from './progress.ts';
import { formatActionableError, toActionableError } from './errors.ts';
import { nextFlowPhase, type FlowPhase } from './flow.ts';

export interface ImportWizardOptions {
  port: ImportPort;
  onProgress?: ProgressListener;
  /** 默认回滚策略（场景 E：true=整体回滚；UI 可在执行前覆盖） */
  defaultRollbackOnError?: boolean;
}

/**
 * 凭据补录：把**单个 ref 的输入**合并进当前提交集合（UI-06）。
 *
 * 为什么必须是「在最新集合上合并」而不是「以组件本地 state 整体替换」：补录页是可以
 * 来回切换的中间步骤（「上一步」→「下一步」），组件会随阶段切换卸载重挂。若以组件本地
 * state 为准会出现两种错误行为 —— ① 回到该页时输入框全空，但上一次的值仍在提交集合里
 * （看到的值 ≠ 提交的值）；② 在空表上编辑任一字段会把其它 ref 已填的值从提交集合里丢掉。
 * 统一以「最新的提交集合」为唯一事实：**看到什么就提交什么**。
 */
export function mergeSecretInput(
  current: Record<string, string>,
  ref: string,
  value: string,
): Record<string, string> {
  return { ...current, [ref]: value }
}

/* ---------------- 流程与派生（t45：从 src/client/import/ImportWizardView.tsx 迁出，node 可测） ---------------- */

/** 导入适用阶段判定输入（全部来自 Dry Run 产物与仅内存的容器状态；不含任何 React 状态） */
export interface ImportFlowInputs {
  /** 上传的是整体加密容器（DCA1）—— 未解锁前不得分析/继续 */
  containerEncrypted: boolean
  /** 容器已解锁（仅内存；刷新后需重输密码） */
  archiveUnlocked: boolean
  hasConflicts: boolean
  hasPathIssues: boolean
  hasSecrets: boolean
}

/**
 * 仍需用户补录的凭据：剔除「解密已覆盖」的 ref（加密备份解锁时顺带恢复了这些凭据）。
 * secrets 阶段的数据与「是否存在 secrets 阶段」的判定共用本函数（此前组件里各写一遍 filter）。
 */
export function pendingSecretRequests(
  plan: Pick<ImportPlan, 'missingSecrets'> | null,
  decryptRefs: readonly string[],
): { ref: string; required: boolean }[] {
  return (plan?.missingSecrets ?? []).filter((s) => !decryptRefs.includes(s.ref))
}

/**
 * 从 Dry Run 原始产物派生三个「是否有该阶段」标志。
 * 语义：基于原始 analysis/plan，**不因用户已解决而重算**（见 flow.ts 的只前进导航）。
 */
export function importFlowFlags(args: {
  plan: Pick<ImportPlan, 'items' | 'missingSecrets'> | null
  analysis: Pick<ImportAnalysis, 'pathIssues'> | null
  decryptRefs: readonly string[]
}): { hasConflicts: boolean; hasPathIssues: boolean; hasSecrets: boolean } {
  return {
    hasConflicts: (args.plan?.items ?? []).some((i) => i.kind === 'Conflict'),
    hasPathIssues: (args.analysis?.pathIssues.length ?? 0) > 0,
    hasSecrets: pendingSecretRequests(args.plan, args.decryptRefs).length > 0,
  }
}

/**
 * 适用阶段的有序列表（仅含需要用户处理的阶段 + 确认页）。
 * 整体加密容器未解锁时恒先插入 decrypt-archive：不解锁不得分析/继续导入。
 */
export function importApplicablePhases(inputs: ImportFlowInputs): FlowPhase[] {
  const list: FlowPhase[] = []
  if (inputs.containerEncrypted && !inputs.archiveUnlocked) list.push('decrypt-archive')
  if (inputs.hasConflicts) list.push('conflicts')
  if (inputs.hasPathIssues) list.push('path-mapping')
  if (inputs.hasSecrets) list.push('secrets')
  list.push('confirm')
  return list
}

/** 阶段推进（只前进）：在适用阶段列表里取 from 的下一项（from 不在列表 → 取第一项） */
export function nextImportPhase(inputs: ImportFlowInputs, from: FlowPhase): FlowPhase {
  return nextFlowPhase(importApplicablePhases(inputs), from)
}

/** 兼容性等级（与 ImportAnalysis.compatibility 同域；运行时出现未知值 → 按历史行为落到 'excellent'） */
export type CompatibilityLevel = 'unsupported' | 'partial' | 'good' | 'excellent'

export function compatibilityLevel(compatibility: ImportAnalysis['compatibility'] | string): CompatibilityLevel {
  return compatibility === 'unsupported' || compatibility === 'partial' || compatibility === 'good'
    ? compatibility
    : 'excellent'
}

/** 兼容性徽章语义（Badge kind）；未支持=error、部分=warn、其余=ok */
export function compatibilityBadgeKind(level: CompatibilityLevel): 'error' | 'warn' | 'ok' {
  return level === 'unsupported' ? 'error' : level === 'partial' ? 'warn' : 'ok'
}

/** 预览步的两页：迁移前咨询（只读结论）/ 选择要导入的内容 */
export type ImportPreviewStage = 'consult' | 'select'

/**
 * 预览步状态转移：换备份/重走流程 → 回咨询页（不让上一份备份的选择残留）；
 * 点「下一步」→ 内容选择页（已在该页时保持）。
 */
export function importPreviewStageAfter(
  event: 'new-zip' | 'next',
  current: ImportPreviewStage,
): ImportPreviewStage {
  if (event === 'new-zip') return 'consult'
  return current === 'consult' ? 'select' : current
}

/**
 * 导入中是否可「跳过当前项」：仅当**正在安装插件**（/progress 的 detail 是正在执行项 id，
 * 插件安装项带 `plugin:` 前缀）且尚未请求过跳过。其余项（配置写入等）不可跳过。
 */
export function isSkippablePluginInstall(
  detail: string | undefined,
  running: boolean,
  skipRequested: boolean,
): boolean {
  return running && (detail ?? '').startsWith('plugin:') && !skipRequested
}

export class ImportWizard {
  private readonly port: ImportPort;
  private readonly onProgress: ProgressListener | undefined;
  private readonly tracker: ProgressTracker;
  private step: ImportStep = 'select';
  private zipPath: string | null = null;
  private analysis: ImportAnalysis | null = null;
  private plan: ImportPlan | null = null;
  private result: ImportResult | null = null;
  private rollbackOnError: boolean;
  private errors: string[] = [];
  private decisions: ImportDecisions = {
    strategy: 'merge',
    resolutions: {},
    pathMappings: [],
  };
  private secretInputs: Record<string, string> = {};
  /** 加密备份的解密密码（仅内存，绝不持久化；刷新后要求重输） */
  private decryptPassword = '';
  /** 整体加密备份容器是否已解锁（upload 探测到 encrypted 容器后为 false；unlockArchive 成功后为 true） */
  private archiveUnlocked = false;
  /**
   * 解锁后的明文 ZIP 路径（仅内存，绝不持久化；指向受控临时目录）。
   * decryptArchive 端点解出明文 ZIP 并返回新 zipPath，后续 analyze/plan/execute 都基于它。
   */
  private unlockedZipPath: string | null = null;

  constructor(opts: ImportWizardOptions) {
    this.port = opts.port;
    this.onProgress = opts.onProgress;
    this.tracker = new ProgressTracker(IMPORT_STAGES, this.onProgress);
    this.rollbackOnError = opts.defaultRollbackOnError ?? true;
  }

  /** 当前状态快照（React 绑定 / 测试断言用） */
  snapshot(): WizardSnapshot {
    return {
      step: this.step,
      zipPath: this.zipPath,
      analysis: this.analysis,
      plan: this.plan,
      result: this.result,
      rollbackOnError: this.rollbackOnError,
      errors: [...this.errors],
    };
  }

  get currentStep(): ImportStep {
    return this.step;
  }

  /**
   * 解析「当前应传给 analyze/plan/execute 的 ZIP 路径」：
   * - 已解锁的整体加密容器 → 用解密后的明文 ZIP 路径；
   * - 否则 → 直接上传/传入的路径。
   */
  private resolvedZipPath(): string {
    return this.archiveUnlocked && this.unlockedZipPath !== null ? this.unlockedZipPath : this.zipPath!;
  }

  /**
   * 设置整体加密备份容器是否为 encrypted（upload 探测结果；仅内存）。
   * 调用方先在解密阶段展示密码输入，成功后调用 unlockArchive。
   * 传入 zipPath 时同步记录容器路径（供 unlockArchive/selectZip 引用，
   * 避免 syncWizard 把 store 中已 patch 的 zipPath 覆盖回 null）。
   */
  setArchiveEncrypted(encrypted: boolean, zipPath?: string): void {
    this.archiveUnlocked = !encrypted;
    if (encrypted && zipPath !== undefined) this.zipPath = zipPath;
    this.unlockedZipPath = null;
  }

  /**
   * 解锁整体加密备份容器（只读，零写入）：用备份密码解密上传的容器 → 明文 ZIP。
   * 成功后 archiveUnlocked=true；之后 analyze/plan/execute 基于解密后的 ZIP 路径。
   * 返回明文 ZIP 路径与解密覆盖的凭据 ref 名（导出时容器密码与 secrets.enc 密码
   * 同源，解锁即完成凭据解密验证）——导入全程只需输入这一次密码。
   */
  async unlockArchive(encryptedPath: string, password: string): Promise<{ zipPath: string; refs: string[] }> {
    this.zipPath = encryptedPath;
    const { zipPath, refs } = await this.port.decryptArchive(encryptedPath, password);
    this.unlockedZipPath = zipPath;
    this.archiveUnlocked = true;
    return { zipPath, refs };
  }

  /** 步骤 1-2：选 ZIP → Analyzing → Compatibility（analyzeImport 零写入） */
  async selectZip(path: string): Promise<ImportAnalysis> {
    this.zipPath = path;
    this.step = 'analyzing';
    this.tracker.emit('validating');
    this.errors = [];
    try {
      this.analysis = await this.port.analyzeImport(this.resolvedZipPath());
      this.tracker.emit('checking-compatibility');
      if (!this.analysis.valid) {
        // 分析失败（完整性/schema/兼容性）：错误进 errors，UI 停在失败态
        this.errors.push(...this.analysis.errors.map((e) => formatActionableError(toActionableError(new Error(e)))));
        throw new Error(this.analysis.errors.join('; ') || '备份分析失败');
      }
      this.step = 'compatibility';
      return this.analysis;
    } catch (err) {
      // 仅当尚未记录分析错误时才追加（避免重复）
      if (this.errors.length === 0) {
        this.errors.push(formatActionableError(toActionableError(err)));
      }
      throw err;
    }
  }

  /**
   * 计划期共用参数：解密密码（仅内存）。加密备份的计划生成也必须能看到归档里的凭据，
   * 否则「随加密备份恢复」的凭据不会进计划、导入时静默丢掉（execute 侧同源传参）。
   */
  private planOpts(): { decryptPassword?: string } {
    return this.decryptPassword === '' ? {} : { decryptPassword: this.decryptPassword };
  }

  /** 步骤 3→4：用户确认兼容性后进入 Preview（Dry Run：用当前决策生成计划摘要，零写入） */
  async confirmCompatibility(): Promise<ImportPlan> {
    if (this.analysis === null || this.zipPath === null) {
      throw new Error('尚未完成分析，请先选择备份文件');
    }
    this.plan = await this.port.createImportPlan(this.resolvedZipPath(), this.decisions, this.planOpts());
    this.step = 'preview';
    return this.plan;
  }

  /** 更新全局冲突策略（merge/replace/skipExisting，规范 §11） */
  setStrategy(strategy: GlobalConflictStrategy): void {
    this.decisions = { ...this.decisions, strategy };
  }

  /** 设置逐项冲突决策（keepCurrent/useImported/review） */
  setResolutions(resolutions: Record<string, 'keepCurrent' | 'useImported' | 'review'>): void {
    this.decisions = { ...this.decisions, resolutions };
  }

  /** 设置路径映射（§12） */
  setPathMappings(mappings: PathMapping[]): void {
    this.decisions = { ...this.decisions, pathMappings: mappings };
  }

  /** 设置秘密补录值（仅内存，绝不持久化） */
  setSecretInputs(inputs: Record<string, string>): void {
    this.secretInputs = inputs;
  }

  /** 设置加密备份的解密密码（仅内存，绝不持久化；导出密码不可复用，无明文存储） */
  setDecryptPassword(password: string): void {
    this.decryptPassword = password;
  }

  /** Preview 摘要（规范 §10 数值化；基于当前 plan 与 analysis） */
  previewSummary(): ImportPreviewSummary {
    const items = this.plan?.items ?? [];
    const analysis = this.analysis;
    const count = (kinds: PlanItem['kind'][]): number =>
      items.filter((i) => kinds.includes(i.kind)).length;
    return {
      willChange: count(['Create', 'Update', 'Install', 'Conflict']),
      unchanged: count(['Skip']),
      settingsUpdates: count(['Create', 'Update']),
      pluginsInstalled: analysis?.pluginSummary.installed ?? 0,
      pluginsToInstall: count(['Install']),
      mcpAdds: items.filter((i) => i.adapter === 'mcp' && i.kind === 'Create').length,
      prompts: items.filter((i) => i.adapter === 'prompts' && i.kind !== 'Skip').length,
      pathMappingsNeeded: analysis?.pathIssues.length ?? 0,
      secretsNeeded: this.plan?.missingSecrets.length ?? analysis?.secretCount ?? 0,
      conflicts: count(['Conflict']),
      needsRestart: this.plan?.needsRestart ?? false,
    };
  }

  /** 冲突项（供 ConflictCollector 使用） */
  conflictItems(): PlanItem[] {
    return (this.plan?.items ?? []).filter((i) => i.kind === 'Conflict');
  }

  /** 设置回滚策略（场景 E 选择；执行前调用） */
  setRollbackOnError(enable: boolean): void {
    this.rollbackOnError = enable;
  }

  /**
   * 步骤 10-14：确认导入 → 快照 → 执行 → 校验 → 结果。
   * 用最终决策重建计划（与预览一致），显式传 rollbackOnError。
   */
  async execute(opts: {
    confirm: boolean;
    rollbackOnError?: boolean;
    /**
     * 计划裁剪钩子（Phase 2 内容选择）：在 createImportPlan 之后、执行之前套用。
     * 用钩子而不是让向导依赖选择模型 —— 向导保持「不认识 UI 选择语义」，且
     * **Dry Run 与真实执行走同一套裁剪**（两边不一致是最容易出鬼故事的地方）。
     */
    planFilter?: (plan: ImportPlan) => ImportPlan;
  }): Promise<ImportResult> {
    if (this.zipPath === null || this.analysis === null) {
      throw new Error('尚未完成分析，请先选择备份文件');
    }
    if (opts.confirm !== true) {
      throw new Error('导入未确认：必须确认后才允许修改任何数据');
    }
    const rollbackOnError = opts.rollbackOnError ?? this.rollbackOnError;
    // P0-8：记住执行前的步骤 —— 执行抛错时回到该步骤（确认页/结果页）。
    // 不回退就会永久停在 'importing'：视图按 step 分支渲染，只剩错误横幅、
    // 没有任何可重试的出口，用户只能刷新页面（刷新走 resume 的兜底复位）。
    const previousStep = this.step;
    this.step = 'importing';
    // 快照由 Host 端在 executeImportPlan 内部第一步创建；此处只发开始阶段。
    this.tracker.emit('creating-snapshot');

    try {
      // 用最终决策重建计划（与预览逻辑一致，保证 Dry Run 与真实导入一致）
      this.plan = await this.port.createImportPlan(this.resolvedZipPath(), this.decisions, this.planOpts());
      if (opts.planFilter !== undefined) this.plan = opts.planFilter(this.plan);
      // executeImportPlan 是一个单次 HTTP 请求：Host 端串行跑完全部计划项
      // （插件安装为 npm 串行，耗时最长）。请求期间没有任何中间进度事件可
      // 回传——旧实现把 restoring-settings / restoring-plugins /
      // restoring-mcp / validating-config 在请求前全部预发，进度条瞬间跳到
      // 78% 后长时间不动，看起来像卡死。现在统一改为 EXECUTING_STAGE
      // 不定态（无 step/total → 动画），让用户明确知道「仍在执行」。
      // 真实各分区结果在返回后的报告里逐项展示。
      this.tracker.emit(EXECUTING_STAGE);
      this.result = await this.port.executeImportPlan(this.resolvedZipPath(), this.plan, {
        confirm: true,
        secretInputs: this.secretInputs,
        rollbackOnError,
        // 未设置解密密码（普通备份/未解锁）→ 不携带该字段
        decryptPassword: this.decryptPassword === '' ? undefined : this.decryptPassword,
      });
      // 失败且已整体回滚（场景 E）→ 报告回滚阶段
      if (!this.result.ok && this.result.rollback) {
        this.tracker.emit('rolling-back');
      }
      this.tracker.emit('done');
      this.step = 'result';
      return this.result;
    } catch (err) {
      this.errors.push(formatActionableError(toActionableError(err)));
      // P0-8：失败回退到执行前步骤（正常是 'preview' = 确认页，那里有重试按钮）；
      // 计划与错误都已保留，用户可直接再次确认执行。
      this.step = previousStep;
      throw err;
    }
  }

  /** 可重试项计数：执行失败（failed）或用户跳过（skippedByUser）的项。 */
  retryableCount(): number {
    return (this.result?.executed ?? []).filter((e) => e.status === 'failed' || e.skippedByUser === true).length;
  }

  /** 可重试项 id 集合（与 result.executed 对齐；供 executeRetry 过滤计划）。 */
  private retryableIds(): Set<string> {
    return new Set(
      (this.result?.executed ?? [])
        .filter((e) => e.status === 'failed' || e.skippedByUser === true)
        .map((e) => e.itemId),
    );
  }

  /**
   * 步骤 10-14（重试版）：只重跑「失败 + 用户跳过」的子集计划（结果页「重试」按钮）。
   * - 复用已解析的最终计划（this.plan，含冲突决策/路径映射），过滤出可重试项；
   * - 仍走 executeImportPlan 全流程：快照 → 子集 apply → 校验 → 结果（幂等）；
   * - 已成功的项不重跑，不重建整体导入；secret 补录值仍沿用仅内存的 secretInputs。
   */
  async executeRetry(opts: { rollbackOnError?: boolean }): Promise<ImportResult> {
    if (this.plan === null || this.result === null) {
      throw new Error('没有可重试的导入结果');
    }
    const retryable = this.retryableIds();
    const subset = this.plan.items.filter((i) => retryable.has(i.id));
    if (subset.length === 0) {
      throw new Error('没有失败或跳过的项需要重试');
    }
    const rollbackOnError = opts.rollbackOnError ?? this.rollbackOnError;
    // P0-8：同 execute() —— 重试失败也回退到执行前步骤（结果页），
    // 否则「重试」按钮点下去失败后会停在 importing，页面再无出口。
    const previousStep = this.step;
    this.step = 'importing';
    this.tracker.emit('creating-snapshot');
    try {
      this.tracker.emit(EXECUTING_STAGE);
      this.result = await this.port.executeImportPlan(this.resolvedZipPath(), { ...this.plan, items: subset }, {
        confirm: true,
        secretInputs: this.secretInputs,
        rollbackOnError,
        decryptPassword: this.decryptPassword === '' ? undefined : this.decryptPassword,
      });
      if (!this.result.ok && this.result.rollback) {
        this.tracker.emit('rolling-back');
      }
      this.tracker.emit('done');
      this.step = 'result';
      return this.result;
    } catch (err) {
      this.errors.push(formatActionableError(toActionableError(err)));
      this.step = previousStep;
      throw err;
    }
  }

  /** 重置向导（可复用实例开始新导入） */
  reset(): void {
    this.step = 'select';
    this.zipPath = null;
    this.analysis = null;
    this.plan = null;
    this.result = null;
    this.errors = [];
    this.decisions = { strategy: 'merge', resolutions: {}, pathMappings: [] };
    this.secretInputs = {};
    this.decryptPassword = '';
    this.archiveUnlocked = false;
    this.unlockedZipPath = null;
  }
}

/**
 * 导入计划 → 「已自动重定基」提示行（issue #45：跨机基础路径不同，见 ImportPlan.automaticMappings）。
 *
 * 形态用结构化参数（只读 oldPrefix/newPrefix 两个字段）：宿主/引擎只需给出这两项，
 * 本模块不必依赖 core 的具体类型，也不猜别的字段。
 */
export function importBasePathNotices(
  plan: { automaticMappings?: readonly { oldPrefix: string; newPrefix: string }[] } | null,
): { from: string; to: string }[] {
  if (plan === null) return []
  return (plan.automaticMappings ?? []).map((rule) => ({ from: rule.oldPrefix, to: rule.newPrefix }))
}
