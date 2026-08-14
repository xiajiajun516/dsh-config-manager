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
import { IMPORT_STAGES, ProgressTracker } from './progress.ts';
import { formatActionableError, toActionableError } from './errors.ts';

export interface ImportWizardOptions {
  port: ImportPort;
  onProgress?: ProgressListener;
  /** 默认回滚策略（场景 E：true=整体回滚；UI 可在执行前覆盖） */
  defaultRollbackOnError?: boolean;
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

  /** 步骤 1-2：选 ZIP → Analyzing → Compatibility（analyzeImport 零写入） */
  async selectZip(path: string): Promise<ImportAnalysis> {
    this.zipPath = path;
    this.step = 'analyzing';
    this.tracker.emit('validating');
    this.errors = [];
    try {
      this.analysis = await this.port.analyzeImport(path);
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

  /** 步骤 3→4：用户确认兼容性后进入 Preview（Dry Run：用当前决策生成计划摘要，零写入） */
  async confirmCompatibility(): Promise<ImportPlan> {
    if (this.analysis === null || this.zipPath === null) {
      throw new Error('尚未完成分析，请先选择备份文件');
    }
    this.plan = await this.port.createImportPlan(this.zipPath, this.decisions);
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
  async execute(opts: { confirm: boolean; rollbackOnError?: boolean }): Promise<ImportResult> {
    if (this.zipPath === null || this.analysis === null) {
      throw new Error('尚未完成分析，请先选择备份文件');
    }
    if (opts.confirm !== true) {
      throw new Error('导入未确认：必须确认后才允许修改任何数据');
    }
    const rollbackOnError = opts.rollbackOnError ?? this.rollbackOnError;
    this.step = 'importing';
    this.tracker.emit('creating-snapshot');

    try {
      // 用最终决策重建计划（与预览逻辑一致，保证 Dry Run 与真实导入一致）
      this.plan = await this.port.createImportPlan(this.zipPath, this.decisions);
      this.tracker.emit('restoring-settings');
      this.tracker.emit('restoring-plugins');
      this.tracker.emit('restoring-mcp');
      this.tracker.emit('validating-config');
      this.result = await this.port.executeImportPlan(this.zipPath, this.plan, {
        confirm: true,
        secretInputs: this.secretInputs,
        rollbackOnError,
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
  }
}
