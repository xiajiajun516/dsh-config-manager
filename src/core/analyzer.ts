/**
 * 三段式核心（对齐设计 §5.1/§13.5）：
 *   analyzeImport()      → ImportAnalysis（纯计算，零写入）
 *   createImportPlan()   → ImportPlan（汇总 PlanItem + 冲突决策 + 路径映射；纯计算）
 *   executeImportPlan()  → ImportResult（快照 → 分阶段 apply → 校验 → 结果/回滚）
 *
 * Dry Run 保证：analyzeImport / createImportPlan 除读取 ZIP 字节外不做任何系统修改，
 * ZIP 以内存方式解析（不进磁盘），杜绝不可信输入在分析阶段落盘。
 */
import fs from 'node:fs/promises';
import { sha256Hex } from '../utils/hashing.ts';
import { parseJsonSafe } from '../utils/json.ts';
import {
  SECTION_FILE_PREFIXES, SECTION_JSON_PATHS, isFileSection, validateSectionData,
} from '../schema/config.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../schema/manifest.ts';
import { canImport, describeVersion, isSupported } from '../schema/versions.ts';
import { isAbsolutePath, applyPrefixMappings } from '../utils/paths.ts';
import { parseZip, type ZipArchive, type ZipSafetyLimits } from '../utils/zip.ts';
import type { FilesSection, Manifest, SectionId } from '../schema/types.ts';
import { createSnapshot } from './backup.ts';
import { rollback } from './rollback.ts';
import { computeCompatibility } from './validator.ts';
import {
  ImportNotConfirmedError, type ApplyResult, type ConfigAdapter, type ExecutedItem,
  type HostContext, type ImportAnalysis, type ImportContext, type ImportDecisions,
  type ImportPlan, type ImportResult, type PathIssue, type PathMapping, type PlanItem,
  type SnapshotStore,
} from './types.ts';

/** 执行阶段顺序（设计 §5.4：副作用大的 patch/安装最后） */
const APPLY_ORDER: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'prompts', 'skills', 'agentPresets',
  'workspaces', 'pluginFiles', 'mcp', 'plugins', 'credentialsStatus',
];

/** ZIP 内可执行文件扩展名黑名单（§19.6：只警告，本插件不执行任何脚本） */
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.sh', '.ps1', '.dll', '.so', '.dylib', '.bin', '.jar']);

/** 已知外部依赖（MCP command 检测用，§15） */
const KNOWN_DEPENDENCIES = new Set([
  'npx', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pip', 'pip3',
  'uv', 'git', 'docker', 'rg', 'bash', 'zsh', 'code', 'cargo', 'go',
]);

export interface AnalyzerOptions {
  ctx: HostContext;
  adapters: ConfigAdapter[];
  snapshotStore: SnapshotStore;
  limits?: ZipSafetyLimits;
  /** 依赖存在性检查器（缺省不检查；m5/宿主可注入 which 类实现） */
  dependencyChecker?: (command: string) => Promise<boolean>;
  /** m4 可注入强化版 ZIP 安全解析 */
  parseZipOverride?: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive;
}

interface Bundle {
  archive: ZipArchive;
  manifest: Manifest;
  checksums: { ok: boolean; mismatches: string[]; missing: string[] };
  zipWarnings: string[];
}

interface AnalyzedBundle extends Bundle {
  sections: Map<SectionId, unknown>;
  adapterItems: PlanItem[];
  adapterIssues: string[];
}

export class Analyzer {
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly snapshotStore: SnapshotStore;
  private readonly limits?: ZipSafetyLimits;
  private readonly dependencyChecker?: (command: string) => Promise<boolean>;
  private readonly parseZipFn: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive;
  /** 会话内 bundle 缓存（zipPath → 解析结果），避免重复解压 */
  private readonly bundleCache = new Map<string, Bundle>();

  constructor(opts: AnalyzerOptions) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.snapshotStore = opts.snapshotStore;
    this.limits = opts.limits;
    this.dependencyChecker = opts.dependencyChecker;
    this.parseZipFn = opts.parseZipOverride ?? parseZip;
  }

  /* ---------------- 第 1-6 步：ZIP 读入 → 安全解析 → manifest → 完整性 → schema ---------------- */

  private async loadBundle(zipPath: string): Promise<Bundle> {
    const cached = this.bundleCache.get(zipPath);
    if (cached) return cached;

    // 1. 选 ZIP（存在性）
    let raw: Uint8Array;
    try {
      raw = await fs.readFile(zipPath);
    } catch (err) {
      throw new Error(`无法读取备份文件 "${zipPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2. 校验 ZIP（安全解析：条目名/数量/体积上限）
    const archive = this.parseZipFn(raw, this.limits);

    // 3. manifest
    if (!archive.has(MANIFEST_FILE)) throw new Error('备份缺少 manifest.json，不是有效的 DSH Config Manager 备份');
    let manifest: Manifest;
    try {
      manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    } catch (err) {
      throw new Error(`manifest.json 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. 完整性（integrity/checksums.json 逐一 SHA-256）
    let checksums = { ok: true, mismatches: [] as string[], missing: [] as string[] };
    if (archive.has(CHECKSUMS_FILE)) {
      const table = parseJsonSafe(archive.readEntryText(CHECKSUMS_FILE)) as Record<string, string>;
      const entries = new Map<string, Uint8Array>();
      for (const name of archive.names()) {
        if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
        try {
          entries.set(name, archive.readEntry(name));
        } catch {
          entries.delete(name); // 损坏条目在完整性阶段即失败
          checksums.ok = false;
          checksums.mismatches.push(name);
        }
      }
      const result = await verifyAgainstTable(entries, table);
      checksums = result;
      if (!checksums.ok) {
        throw new Error(`备份完整性校验失败: ${[...checksums.mismatches, ...checksums.missing].map((m) => `"${m}"`).join(', ')}`);
      }
    }

    // 5. schema 版本判定（集中）
    if (!isSupported(manifest.schemaVersion)) {
      throw new Error(`备份 ${describeVersion(manifest.schemaVersion)}，无法导入（当前支持 v${1}）`);
    }

    // 6. 扫描：可执行文件条目 → 警告（不执行）
    const zipWarnings: string[] = [];
    for (const name of archive.names()) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(ext)) {
        zipWarnings.push(`备份包含可执行文件 "${name}"，本插件不会执行它`);
      }
    }

    const bundle: Bundle = { archive, manifest, checksums, zipWarnings };
    this.bundleCache.set(zipPath, bundle);
    return bundle;
  }

  /* ---------------- 第 7 步：分区内容扫描/提取 ---------------- */

  private extractSections(bundle: Bundle): Map<SectionId, unknown> {
    const { archive, manifest } = bundle;
    const sections = new Map<SectionId, unknown>();
    for (const [sectionId, enabled] of Object.entries(manifest.sections) as [SectionId, boolean][]) {
      if (!enabled) continue;
      if (isFileSection(sectionId)) {
        const prefix = SECTION_FILE_PREFIXES[sectionId]!;
        const files: FilesSection['files'] = [];
        for (const name of archive.names()) {
          if (!name.startsWith(prefix) || name === prefix) continue;
          const rel = name.slice(prefix.length);
          if (rel === '' || rel.endsWith('/')) continue;
          const data = archive.readEntry(name);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        }
        sections.set(sectionId, { version: 1, files });
        continue;
      }
      const jsonPath = SECTION_JSON_PATHS[sectionId];
      if (jsonPath === undefined) continue; // secrets 分区无 JSON 文件
      if (!archive.has(jsonPath)) continue; // 声明包含但文件缺失 → 由调用方记 missingSections
      let data: unknown;
      try {
        data = archive.readEntryJson(jsonPath);
      } catch (err) {
        throw new Error(`分区 ${sectionId} 数据解析失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      const issues = validateSectionData(sectionId, data);
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        throw new Error(`分区 ${sectionId} 数据无效: ${errors.map((e) => e.message).join('; ')}`);
      }
      sections.set(sectionId, data);
    }
    return sections;
  }

  private async analyzeBundle(bundle: Bundle): Promise<AnalyzedBundle> {
    const sections = this.extractSections(bundle);
    const { manifest } = bundle;

    const importCtx: ImportContext = {
      manifest,
      targetPlatform: this.ctx.platform,
      target: this.ctx,
      sections,
      pathMappings: [],
      resolutions: {},
      secretInputs: {},
      log: this.ctx.log,
    };

    const adapterItems: PlanItem[] = [];
    const adapterIssues: string[] = [];
    for (const adapter of this.adapters) {
      const data = sections.get(adapter.id);
      if (data === undefined) continue;
      try {
        const v = await adapter.validate(data);
        for (const issue of v.issues) {
          if (issue.severity === 'error') adapterIssues.push(`${adapter.id}: ${issue.message}`);
        }
        if (!v.valid) continue;
        const items = await adapter.analyzeImport(data, importCtx);
        adapterItems.push(...items);
      } catch (err) {
        adapterIssues.push(`${adapter.id}: 分析失败 ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { ...bundle, sections, adapterItems, adapterIssues };
  }

  /* ---------------- 第 8 步：analyzeImport ---------------- */

  async analyzeImport(zipPath: string): Promise<ImportAnalysis> {
    const bundle = await this.loadBundle(zipPath);
    const { manifest, zipWarnings } = bundle;
    const analyzed = await this.analyzeBundle(bundle);

    const errors = [...analyzed.adapterIssues];
    const warnings = [...zipWarnings];
    if (!canImport(manifest.schemaVersion)) {
      errors.push(`${describeVersion(manifest.schemaVersion)}：无法导入`);
    }

    // 兼容性（第 6 步）
    const sectionsInZip = [...analyzed.sections.keys()];
    const missingSections = (Object.entries(manifest.sections) as [SectionId, boolean][])
      .filter(([id, on]) => on && !analyzed.sections.has(id))
      .map(([id]) => id);
    if (missingSections.length > 0) {
      warnings.push(`备份声明了但缺少的分区: ${missingSections.join(', ')}`);
    }
    const compatibility = computeCompatibility({
      sourceDsh: manifest.source.dshVersion,
      targetDsh: this.ctx.dshVersion,
      sourcePlatform: manifest.source.platform,
      targetPlatform: this.ctx.platform,
      schemaVersion: manifest.schemaVersion,
      missingSections,
    });

    // 路径问题（第 12 步检测；核心只做形态判定，最终映射由 UI 确认）
    const pathIssues = detectPathIssues(
      manifest.source.platform,
      this.ctx.platform,
      analyzed.sections,
    );

    // 依赖检测（§15：缺失不阻塞，标记 Requires Attention）
    const dependencyIssues: ImportAnalysis['dependencyIssues'] = [];
    if (this.dependencyChecker) {
      const mcp = analyzed.sections.get('mcp') as { servers?: { serverName?: string; command?: string }[] } | undefined;
      for (const server of mcp?.servers ?? []) {
        const cmd = (server.command ?? '').trim();
        if (cmd === '') continue;
        const base = cmd.split(/[\\/ ]/).pop() ?? cmd;
        if (!KNOWN_DEPENDENCIES.has(base)) continue;
        try {
          const ok = await this.dependencyChecker(base);
          if (!ok) dependencyIssues.push({ item: server.serverName ?? base, dependency: base });
        } catch {
          // 检查器异常视为未知，不误报
        }
      }
    }

    // 秘密计数：普通备份中已配置（有值）但未导出的凭据数
    const creds = analyzed.sections.get('credentialsStatus') as { credentials?: { configured?: boolean; hasValue?: boolean }[] } | undefined;
    const secretCount = (creds?.credentials ?? []).filter((c) => c.configured === true && c.hasValue !== true).length;

    // 插件摘要
    const plugins = analyzed.sections.get('plugins') as { plugins?: unknown[] } | undefined;
    const toInstall = analyzed.adapterItems.filter((i) => i.kind === 'Install').length;
    const pluginSummary = {
      installed: Math.max((plugins?.plugins?.length ?? 0) - toInstall, 0),
      toInstall,
    };

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      compatibility,
      sectionsInZip,
      pluginSummary,
      pathIssues,
      secretCount,
      dependencyIssues,
    };
  }

  /* ---------------- 第 9 步：createImportPlan（Dry Run 复用） ---------------- */

  async createImportPlan(zipPath: string, decisions: ImportDecisions): Promise<ImportPlan> {
    const bundle = await this.loadBundle(zipPath);
    const analyzed = await this.analyzeBundle(bundle);
    const { manifest } = bundle;

    // 先把用户路径映射应用到各分区数据（PathMapper 先行：applyItem 拿到的已是映射后数据）
    applyMappingsToSections(analyzed.sections, decisions.pathMappings);

    const importCtx: ImportContext = {
      manifest,
      targetPlatform: this.ctx.platform,
      target: this.ctx,
      sections: analyzed.sections,
      pathMappings: decisions.pathMappings,
      resolutions: decisions.resolutions,
      secretInputs: {},
      log: this.ctx.log,
    };

    const items = analyzed.adapterItems.map((item) => applyItemResolution(item, decisions));
    const planMappings = mergePathMappings(items, decisions.pathMappings);

    // MissingSecret：兜底——credentialsStatus 分区里已配置的凭据若没有对应计划项，补占位
    ensureMissingSecrets(items, analyzed.sections);

    const missingSecrets = items
      .filter((i) => i.kind === 'MissingSecret')
      .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));

    const needsRestart = items.some((i) => i.kind === 'Install' || (i.adapter === 'mcp' && i.kind !== 'Skip' && i.kind !== 'Warning'));

    const estimatedActions = {} as ImportPlan['estimatedActions'];
    for (const item of items) {
      if (item.kind === 'Skip' || item.kind === 'Warning') continue;
      estimatedActions[item.adapter] = (estimatedActions[item.adapter] ?? 0) + 1;
    }

    return {
      items,
      globalStrategy: decisions.strategy,
      pathMappings: planMappings,
      missingSecrets,
      needsRestart,
      estimatedActions,
    };
  }

  /* ---------------- 第 11-14 步：executeImportPlan（快照 → 执行 → 校验 → 结果/回滚） ---------------- */

  async executeImportPlan(
    zipPath: string,
    plan: ImportPlan,
    opts: { confirm?: boolean; secretInputs?: Record<string, string>; decryptedCredentials?: Map<string, string>; rollbackOnError?: boolean } = {},
  ): Promise<ImportResult> {
    const bundle = await this.loadBundle(zipPath);
    const analyzed = await this.analyzeBundle(bundle);
    applyMappingsToSections(analyzed.sections, plan.pathMappings);

    // 10. 用户确认（安全阀：不确认绝不动数据）
    if (opts.confirm !== true) {
      throw new ImportNotConfirmedError();
    }

    const importCtx: ImportContext = {
      manifest: bundle.manifest,
      targetPlatform: this.ctx.platform,
      target: this.ctx,
      sections: analyzed.sections,
      pathMappings: plan.pathMappings,
      resolutions: {},
      secretInputs: opts.secretInputs ?? {},
      decryptedCredentials: opts.decryptedCredentials,
      log: this.ctx.log,
    };

    // 11. 快照（强制：导入前必须先备份将被修改的目标）
    const snapshot = await createSnapshot({
      ctx: this.ctx,
      plan,
      sourceZip: zipPath,
      store: this.snapshotStore,
      adapters: this.adapters,
    });

    const executed: ExecutedItem[] = [];
    const warnings: string[] = [...bundle.zipWarnings];
    let needsRestart = plan.needsRestart;
    let anyFailed = false;

    // 12. 分阶段执行
    const byAdapter = new Map<SectionId, PlanItem[]>();
    for (const item of plan.items) {
      const list = byAdapter.get(item.adapter) ?? [];
      list.push(item);
      byAdapter.set(item.adapter, list);
    }

    for (const adapterId of APPLY_ORDER) {
      const adapter = this.adapters.find((a) => a.id === adapterId);
      if (!adapter) continue;
      for (const item of byAdapter.get(adapterId) ?? []) {
        const outcome = await this.applyOne(adapter, item, importCtx);
        executed.push(outcome.executed);
        // 仅硬失败计入 anyFailed（warning 属非致命：目标不可达等，不触发回滚，§34.17）
        if (outcome.executed.status === 'failed') anyFailed = true;
        if (outcome.needsRestart) needsRestart = true;
        if (outcome.warning) warnings.push(outcome.warning);
        if (opts.rollbackOnError && outcome.executed.status === 'failed') break;
      }
      if (opts.rollbackOnError && anyFailed) break;
    }

    // 失败整体回滚（rollbackOnError）：逆序补偿 + 诚实报告
    if (opts.rollbackOnError && anyFailed) {
      const rollbackReport = await rollback({
        ctx: this.ctx,
        snapshot,
        store: this.snapshotStore,
        adapters: this.adapters,
      });
      this.ctx.log.warn(`导入失败，已回滚（${rollbackReport.full ? '完整' : '部分'}）`, {
        failed: executed.filter((e) => e.status === 'failed').map((e) => e.itemId),
      });
      return {
        ok: false,
        executed,
        needsRestart: false,
        missingSecrets: [],
        warnings,
        rollback: rollbackReport,
        snapshotId: snapshot.id,
      };
    }

    // 13. 校验（执行后：对最终数据再 validate；失败仅告警，不掩盖已完成项）
    for (const adapter of this.adapters) {
      const data = analyzed.sections.get(adapter.id);
      if (data === undefined) continue;
      try {
        const v = await adapter.validate(data);
        for (const issue of v.issues) {
          if (issue.severity === 'error') warnings.push(`导入后校验 ${adapter.id}: ${issue.message}`);
        }
      } catch (err) {
        warnings.push(`导入后校验 ${adapter.id} 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 14. 结果
    const missingSecrets = plan.missingSecrets
      .filter((s) => !importCtx.decryptedCredentials?.has(s.ref) && !importCtx.secretInputs[s.ref])
      .map((s) => s.ref);

    return {
      ok: true, // 单项失败已如实记录在 executed；无未捕获异常即完成
      executed,
      needsRestart,
      missingSecrets,
      warnings,
      rollback: null,
      snapshotId: snapshot.id,
    };
  }

  private async applyOne(
    adapter: ConfigAdapter,
    item: PlanItem,
    ctx: ImportContext,
  ): Promise<{ executed: ExecutedItem; needsRestart: boolean; warning?: string }> {
    if (
      item.kind === 'Skip' ||
      item.kind === 'Warning' ||
      item.kind === 'MissingDependency' ||
      (item.kind === 'Conflict' && item.conflict?.resolution !== 'useImported')
    ) {
      // Warning / MissingDependency 是信息项（依赖缺失、需人工注意），不调用 applyItem。
      return { executed: { itemId: item.id, status: 'skipped' }, needsRestart: false };
    }
    if (item.kind === 'Error') {
      return { executed: { itemId: item.id, status: 'failed', message: item.detail ?? item.description }, needsRestart: false };
    }
    if (item.kind === 'MissingSecret') {
      const ref = item.id.replace(/^secret:/, '');
      const value = ctx.decryptedCredentials?.get(ref) ?? ctx.secretInputs[ref];
      if (value === undefined || value === '') {
        return { executed: { itemId: item.id, status: 'skipped', message: '凭据未提供，需补录' }, needsRestart: false };
      }
      // 补录值只经 adapter.applyItem 写入（m5 实现），引擎不直接触碰凭据
    }
    try {
      const result: ApplyResult = await adapter.applyItem(item, ctx);
      const status = result.ok ? 'ok' : (result.warning === true ? 'warning' : 'failed');
      return {
        executed: { itemId: item.id, status, message: result.message },
        needsRestart: result.needsRestart === true,
        warning: result.warning === true ? `${item.id}: ${result.message ?? item.description}` : undefined,
      };
    } catch (err) {
      this.ctx.log.error(`应用计划项失败 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      return {
        executed: { itemId: item.id, status: 'failed', message: err instanceof Error ? err.message : String(err) },
        needsRestart: false,
      };
    }
  }
}

/* ---------------- 纯函数辅助 ---------------- */

async function verifyAgainstTable(
  entries: Map<string, Uint8Array>,
  table: Record<string, string>,
): Promise<{ ok: boolean; mismatches: string[]; missing: string[] }> {
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [relPath, expected] of Object.entries(table)) {
    const data = entries.get(relPath);
    if (data === undefined) {
      missing.push(relPath);
      continue;
    }
    if (sha256Hex(data) !== expected) mismatches.push(relPath);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/** 应用用户冲突决策 + 全局策略（纯函数，返回新数组） */
function applyItemResolution(item: PlanItem, decisions: ImportDecisions): PlanItem {
  if (item.kind !== 'Conflict') return item;
  const resolution = decisions.resolutions[item.id];
  if (resolution === 'keepCurrent') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}（用户选择保留当前）` };
  }
  if (resolution === 'useImported') {
    return { ...item, kind: 'Update', severity: 'info', conflict: { itemId: item.id, resolution } };
  }
  // review / 未决策：按全局策略兜底
  if (decisions.strategy === 'skipExisting') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}（skipExisting 策略）` };
  }
  if (decisions.strategy === 'replace') {
    return { ...item, kind: 'Update', severity: 'info', detail: `${item.detail ?? ''}（replace 策略）` };
  }
  return item; // merge + 未决策 → 保持 Conflict，由报告列明
}

/** 路径映射合并：只保留「已解析」（newPrefix 非空）的映射用于执行期数据改写；
 * 未解决项（newPrefix 空）保留在 plan.items 里供 UI 提示，但不参与数据映射。 */
function mergePathMappings(items: PlanItem[], userMappings: PathMapping[]): PathMapping[] {
  const merged = new Map<string, PathMapping>();
  for (const m of userMappings) {
    if (m.newPrefix !== '') merged.set(m.oldPrefix, m);
  }
  return [...merged.values()];
}

/** 把映射应用到分区数据（PathMapper 先行：只替换匹配前缀的字符串叶值） */
function applyMappingsToSections(sections: Map<SectionId, unknown>, mappings: PathMapping[]): void {
  if (mappings.length === 0) return;
  for (const [sectionId, data] of sections) {
    const appliesTo: PathMapping['appliesTo'] =
      sectionId === 'workspaces' ? ['workspaces']
        : sectionId === 'mcp' ? ['mcp']
          : sectionId === 'skills' ? ['skills']
            : sectionId === 'pluginFiles' ? ['pluginConfig']
              : [];
    const relevant = mappings.filter((m) => m.appliesTo.some((a) => appliesTo.includes(a as never)) || m.appliesTo.length === 0);
    if (relevant.length === 0) continue;
    sections.set(sectionId, applyPrefixMappings(data, relevant));
  }
}

/** 路径形态判定：跨平台盘符/UNIX 冲突 → platformMismatch；其余绝对路径 → missing（需映射） */
function detectPathIssues(
  sourcePlatform: string,
  targetPlatform: string,
  sections: Map<SectionId, unknown>,
): PathIssue[] {
  const issues: PathIssue[] = [];
  const workspaces = sections.get('workspaces') as { workspaces?: { path?: string }[] } | undefined;
  for (const w of workspaces?.workspaces ?? []) {
    const p = w.path;
    if (p && isAbsolutePath(p)) issues.push(judgePath(p, sourcePlatform, targetPlatform));
  }
  const mcp = sections.get('mcp') as { servers?: { serverName?: string; command?: string; cwd?: string }[] } | undefined;
  for (const s of mcp?.servers ?? []) {
    for (const p of [s.cwd, s.command]) {
      if (p && isAbsolutePath(p)) issues.push(judgePath(p, sourcePlatform, targetPlatform));
    }
  }
  // 去重
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.kind}:${i.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function judgePath(p: string, sourcePlatform: string, targetPlatform: string): PathIssue {
  const isWinStyle = /^[a-zA-Z]:[\\/]/.test(p);
  const isUnixStyle = p.startsWith('/');
  if (sourcePlatform !== targetPlatform && ((isWinStyle && targetPlatform !== 'win32') || (isUnixStyle && targetPlatform === 'win32'))) {
    return { kind: 'platformMismatch', value: p };
  }
  return { kind: 'missing', value: p };
}

/** MissingSecret 兜底：credentialsStatus 分区已配置凭据若无对应计划项，补占位 */
function ensureMissingSecrets(items: PlanItem[], sections: Map<SectionId, unknown>): void {
  const creds = sections.get('credentialsStatus') as { credentials?: { ref?: string; configured?: boolean }[] } | undefined;
  if (!creds?.credentials) return;
  const existing = new Set(items.filter((i) => i.kind === 'MissingSecret').map((i) => i.id));
  for (const c of creds.credentials) {
    if (!c.ref || c.configured !== true) continue;
    const id = `secret:${c.ref}`;
    if (existing.has(id)) continue;
    items.push({
      id,
      kind: 'MissingSecret',
      adapter: 'credentialsStatus',
      description: `凭据 ${c.ref} 需要补录`,
      severity: 'warning',
      target: { adapter: 'credentialsStatus', ref: c.ref },
    });
    existing.add(id);
  }
}
