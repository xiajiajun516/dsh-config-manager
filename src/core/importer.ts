/**
 * Importer 门面：封装导入 14 步流程（规范 §9），委托 Analyzer 三段式。
 *
 *  1 选 ZIP → 2 校验 ZIP → 3 读 manifest → 4 完整性 → 5 schema → 6 兼容
 *  → 7 扫描 → 8 ImportPlan → 9 Preview(Dry Run) → 10 用户确认
 *  → 11 快照 → 12 执行 → 13 校验 → 14 结果（失败则回滚）
 *
 * 安全阀：executeImportPlan 必须显式 confirm，否则拒绝（ImportNotConfirmedError）。
 * Dry Run：analyzeImport / createImportPlan 零写入（ZIP 全程内存解析，不进磁盘）。
 */
import type { ZipArchive, ZipSafetyLimits } from '../utils/zip.ts';
import { Analyzer } from './analyzer.ts';
import type { PlanItemProgress } from './analyzer.ts';
import type {
  ConfigAdapter, HostContext, ImportAnalysis, ImportDecisions, ImportPlan,
  ImportResult, SnapshotStore,
} from './types.ts';

export interface ImporterOptions {
  ctx: HostContext;
  adapters: ConfigAdapter[];
  snapshotStore: SnapshotStore;
  limits?: ZipSafetyLimits;
  /** 依赖存在性检查器（缺省不检查） */
  dependencyChecker?: (command: string) => Promise<boolean>;
  /** m4 可注入强化版 ZIP 安全解析 */
  parseZipOverride?: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive;
}

export interface ExecuteOptions {
  /** 用户确认（UI 收集）；非 true 一律拒绝执行 */
  confirm: boolean;
  /** 用户补录的秘密值（仅内存） */
  secretInputs?: Record<string, string>;
  /** 加密备份解密结果（仅内存；解密必须经 m4 encryption provider） */
  decryptedCredentials?: Map<string, string>;
  /** 任一项失败立即整体回滚（默认 false：单项失败如实记录并继续其余项） */
  rollbackOnError?: boolean;
  /** m1：每完成一个计划项的进度回调（透传给 Analyzer；不传则无埋点） */
  onItem?: (info: PlanItemProgress) => void;
}

export class Importer {
  private readonly analyzer: Analyzer;

  constructor(opts: ImporterOptions) {
    this.analyzer = new Analyzer(opts);
  }

  /** 步骤 1-8 + 分析：只读，返回 ImportAnalysis（含兼容性/路径/依赖/秘密摘要） */
  analyzeImport(zipPath: string): Promise<ImportAnalysis> {
    return this.analyzer.analyzeImport(zipPath);
  }

  /** 步骤 9：Dry Run / Preview —— 合并用户冲突决策与路径映射，输出最终可执行计划（零写入） */
  createImportPlan(zipPath: string, decisions: ImportDecisions): Promise<ImportPlan> {
    return this.analyzer.createImportPlan(zipPath, decisions);
  }

  /** 步骤 10-14：确认 → 快照 → 执行 → 校验 → 结果；失败可整体回滚并如实报告 */
  executeImportPlan(zipPath: string, plan: ImportPlan, opts: ExecuteOptions): Promise<ImportResult> {
    return this.analyzer.executeImportPlan(zipPath, plan, {
      confirm: opts.confirm,
      secretInputs: opts.secretInputs,
      decryptedCredentials: opts.decryptedCredentials,
      rollbackOnError: opts.rollbackOnError,
      onItem: opts.onItem,
    });
  }
}
