/**
 * UI 层测试辅助（m6-ui）：mock core 调用与样本数据。
 * 仅供 src/ui/*.test.ts 使用，不参与生产构建语义。
 */
import type { Manifest } from '../schema/types.ts';
import type {
  ExportReport, ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  PlanItem, RollbackReport,
} from '../core/types.ts';
import type { ExportPort } from './export-flow.ts';
import type { ImportPort } from './types.ts';

/** 样本 manifest（UI 测试不关心真实字段，仅类型占位） */
export function makeManifest(): Manifest {
  return {
    schemaVersion: 1,
    exporter: { name: 'dsh-config-manager-test', version: '0.0.0' },
    source: { dshVersion: '0.1.0-rc.6', platform: 'win32', arch: 'x64' },
    exportedAt: '2026-08-14T12:00:00.000Z',
    sections: {
      settings: true, ui: false, providers: false, plugins: false, mcp: false, prompts: false,
      skills: false, agentPresets: false, agentInstructions: false, workspaces: false, pluginFiles: false,
      credentialsStatus: false, secrets: false, sessions: false,
    },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
}

export function makeExportReport(overrides: Partial<ExportReport> = {}): ExportReport {
  return {
    included: [
      { section: 'settings', counts: { namespaces: 3 } },
      { section: 'plugins', counts: { plugins: 8 } },
    ],
    excluded: ['sessions', 'pluginFiles'],
    security: { secretsExcluded: true, containsSecrets: false, encrypted: false, redactedHits: 2 },
    file: { name: 'dsh-config-2026-08-14.zip', sizeBytes: 20480 },
    warnings: [],
    ...overrides,
  };
}

/** 内存 ExportPort mock：记录调用参数，返回固定结果 */
export class MockExportPort implements ExportPort {
  calls: { includeSecrets: boolean; only?: string[] }[] = [];
  result: { zipPath: string; manifest: Manifest; report: ExportReport };
  constructor(report: ExportReport = makeExportReport()) {
    this.result = {
      zipPath: report.file.name,
      manifest: makeManifest(),
      report,
    };
  }
  async export(opts: { includeSecrets: boolean; only?: string[] }): Promise<{ zipPath: string; manifest: Manifest; report: ExportReport }> {
    this.calls.push({ includeSecrets: opts.includeSecrets, only: opts.only });
    return this.result;
  }
}

/* ---------------- Import mock ---------------- */

export function makeAnalysis(overrides: Partial<ImportAnalysis> = {}): ImportAnalysis {
  return {
    valid: true,
    errors: [],
    warnings: [],
    compatibility: 'good',
    sectionsInZip: ['settings', 'plugins', 'mcp', 'prompts'],
    pluginSummary: { installed: 6, toInstall: 2 },
    pathIssues: [],
    secretCount: 3,
    dependencyIssues: [],
    encrypted: false,
    ...overrides,
  } as ImportAnalysis;
}

export function makePlanItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'settings:general',
    kind: 'Create',
    adapter: 'settings',
    description: '创建设置 general',
    severity: 'info',
    ...overrides,
  };
}

export function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    items: [
      makePlanItem({ id: 'settings:a', kind: 'Update', description: '更新设置 a' }),
      makePlanItem({ id: 'settings:b', kind: 'Create', description: '创建设置 b' }),
      makePlanItem({ id: 'plugin:x', kind: 'Install', adapter: 'plugins', description: '安装插件 x' }),
      makePlanItem({ id: 'plugin:y', kind: 'Skip', adapter: 'plugins', description: '插件 y 已一致' }),
      makePlanItem({ id: 'prompt:p', kind: 'Create', adapter: 'prompts', description: '创建提示 p' }),
      makePlanItem({ id: 'mcp:m', kind: 'Create', adapter: 'mcp', description: '创建 MCP m' }),
      makePlanItem({ id: 'secret:K1', kind: 'MissingSecret', adapter: 'credentialsStatus', description: '凭据 K1 需要补录' }),
    ],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [{ ref: 'K1', required: true }],
    needsRestart: true,
    estimatedActions: {
      settings: 2, ui: 0, providers: 0, plugins: 1, mcp: 1, prompts: 1,
      skills: 0, agentPresets: 0, agentInstructions: 0, workspaces: 0, pluginFiles: 0,
      credentialsStatus: 0, secrets: 0, sessions: 0,
    },
    ...overrides,
  };
}

export function makeRollbackReport(overrides: Partial<RollbackReport> = {}): RollbackReport {
  return {
    full: false,
    restored: ['settings:a'],
    failed: [{ item: 'plugin:x', reason: '安装失败', manualHint: '请手动安装' }],
    ...overrides,
  };
}

export function makeImportResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    ok: true,
    executed: [
      { itemId: 'settings:a', status: 'ok' },
      { itemId: 'settings:b', status: 'ok' },
      { itemId: 'plugin:x', status: 'ok', message: '需要重启生效' },
      { itemId: 'plugin:y', status: 'skipped' },
      { itemId: 'prompt:p', status: 'ok' },
      { itemId: 'mcp:m', status: 'ok' },
      { itemId: 'secret:K1', status: 'skipped', message: '凭据未提供' },
    ],
    needsRestart: true,
    missingSecrets: ['K1'],
    warnings: [],
    rollback: null,
    snapshotId: 'snap-1',
    ...overrides,
  };
}

/** 内存 ImportPort mock：可编排各阶段返回与调用记录 */
export class MockImportPort implements ImportPort {
  analysis: ImportAnalysis;
  plan: ImportPlan;
  result: ImportResult;
  analyzeCalls = 0;
  planCalls: ImportDecisions[] = [];
  executeCalls: { confirm: boolean; secretInputs?: Record<string, string>; rollbackOnError: boolean; decryptPassword?: string }[] = [];

  constructor(opts: {
    analysis?: ImportAnalysis;
    plan?: ImportPlan;
    result?: ImportResult;
  } = {}) {
    this.analysis = opts.analysis ?? makeAnalysis();
    this.plan = opts.plan ?? makePlan();
    this.result = opts.result ?? makeImportResult();
  }

  async analyzeImport(): Promise<ImportAnalysis> {
    this.analyzeCalls += 1;
    return this.analysis;
  }
  async createImportPlan(_zip: string, decisions: ImportDecisions): Promise<ImportPlan> {
    this.planCalls.push(decisions);
    return this.plan;
  }
  async decryptArchive(zipPath: string): Promise<{ zipPath: string }> {
    // 测试用：把传入路径视为已解锁的明文 ZIP（不真正解密）
    return { zipPath };
  }
  async executeImportPlan(
    _zip: string,
    _plan: ImportPlan,
    opts: { confirm: boolean; secretInputs?: Record<string, string>; rollbackOnError: boolean; decryptPassword?: string },
  ): Promise<ImportResult> {
    this.executeCalls.push(opts);
    return this.result;
  }
}
