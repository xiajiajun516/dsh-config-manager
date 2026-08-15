/**
 * 进度阶段文案与进度追踪（规范 §29，m6-ui）。
 *
 * 纯文本层：每个阶段 id 有默认文案；未知阶段回退显示 id 本身。
 * ProgressTracker 供导出/导入控制器在调用 core 前后发出阶段事件（UI 不冻结）。
 */
import type { ProgressEvent, ProgressListener } from './types.ts';

/** 导出阶段文案（规范 §29 Export 示例） */
export const EXPORT_STAGES: readonly string[] = [
  'analyzing',           // Analyzing configuration...
  'exporting-settings',  // Exporting settings...
  'scanning-secrets',    // Scanning secrets...
  'exporting-plugins',   // Exporting plugins...
  'creating-archive',    // Creating archive...
  'calculating-checksums', // Calculating checksums...
  'done',
] as const;

/** 导入阶段文案（规范 §29 Import 示例 + 快照/回滚阶段） */
export const IMPORT_STAGES: readonly string[] = [
  'validating',          // Validating backup...
  'checking-compatibility', // Checking compatibility...
  'creating-snapshot',   // Creating safety snapshot...
  'restoring-settings',  // Restoring settings...
  'restoring-plugins',   // Restoring plugins...
  'restoring-mcp',       // Restoring MCP...
  'validating-config',   // Validating configuration...
  'rolling-back',        // Rolling back...（仅失败回滚时）
  'done',
] as const;

const STAGE_TEXTS: Record<string, string> = {
  // export
  'analyzing': 'Analyzing configuration...',
  'exporting-settings': 'Exporting settings...',
  'scanning-secrets': 'Scanning secrets...',
  'exporting-plugins': 'Exporting plugins...',
  'creating-archive': 'Creating archive...',
  'calculating-checksums': 'Calculating checksums...',
  'exporting': 'Exporting configuration...', // in-flight（请求期间不定态，不显示假百分比）
  // import
  'validating': 'Validating backup...',
  'checking-compatibility': 'Checking compatibility...',
  'creating-snapshot': 'Creating safety snapshot...',
  'restoring-settings': 'Restoring settings...',
  'restoring-plugins': 'Restoring plugins...',
  'restoring-mcp': 'Restoring MCP...',
  'validating-config': 'Validating configuration...',
  'rolling-back': 'Rolling back...',
  // common
  'done': 'Done',
};

/** 阶段 id → 用户可读文案（未知阶段回退 id） */
export function stageText(stage: string): string {
  return STAGE_TEXTS[stage] ?? stage;
}

/**
 * 进度追踪器：按给定阶段序列在回调时附带 step/total 序号。
 * 控制器调用 core 前后 emit()，UI 侧渲染进度条/阶段文字。
 */
export class ProgressTracker {
  private readonly listener: ProgressListener | undefined;
  private readonly stages: readonly string[];
  private readonly emitted: string[] = [];

  constructor(stages: readonly string[], listener?: ProgressListener) {
    this.stages = stages;
    this.listener = listener;
  }

  /** 发出某阶段事件（可携带 detail）；未在序列中的阶段 step/total 缺省 */
  emit(stage: string, detail?: string): void {
    const idx = this.stages.indexOf(stage);
    const event: ProgressEvent = {
      stage,
      detail,
      step: idx >= 0 ? idx + 1 : undefined,
      total: idx >= 0 ? this.stages.length : undefined,
    };
    this.emitted.push(stage);
    this.listener?.(event);
  }

  /** 已发出阶段的快照（测试与日志用） */
  get events(): readonly string[] {
    return [...this.emitted];
  }
}
