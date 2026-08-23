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
import path from 'node:path';
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
import { loadTombstones, isTombstoned } from '../schema/tombstones.ts';
import type { Tombstone, TombstoneKind } from '../schema/tombstones.ts';
import { DEFAULT_SENSITIVE_RELS, restoreVaultFiles } from '../security/vault.ts';
import { createSnapshot } from './backup.ts';
import { rollback } from './rollback.ts';
import { computeCompatibility } from './validator.ts';
import { msgOf } from './messages.ts';
import type { MsgFunc } from './messages.ts';
import {
  ImportNotConfirmedError, ImportUserSkippedError, type ApplyResult, type ConfigAdapter,
  type ExecutedItem, type HostContext, type ImportAnalysis, type ImportContext,
  type ImportDecisions, type ImportPlan, type ImportResult, type PathIssue,
  type PathMapping, type PlanItem, type SkippedTombstone, type SnapshotStore,
} from './types.ts';

/** 执行阶段顺序（设计 §5.4：副作用大的 patch/安装最后） */
const APPLY_ORDER: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'prompts', 'skills', 'agentPresets',
  'agentInstructions', 'workspaces', 'pluginFiles', 'mcp', 'plugins', 'credentialsStatus',
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
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
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

/** m1：每完成一个计划项的进度回调信息（Host 侧 run 状态更新用） */
export interface PlanItemProgress {
  adapter: SectionId;
  /** 已处理计划项序号（1 起，含 skip/warning 信息项） */
  index: number;
  /** 将实际执行的计划项总数（APPLY_ORDER 内各项合计） */
  total: number;
  /** 该项最终状态（ok/skipped/warning/failed） */
  status?: ExecutedItem['status'];
  /** 当前计划项 id（非敏感） */
  detail?: string;
}

export class Analyzer {
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly snapshotStore: SnapshotStore;
  private readonly limits?: ZipSafetyLimits;
  private readonly dependencyChecker?: (command: string) => Promise<boolean>;
  private readonly parseZipFn: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive;
  private readonly msg: MsgFunc;
  /** 会话内 bundle 缓存（zipPath → 解析结果），避免重复解压 */
  private readonly bundleCache = new Map<string, Bundle>();

  constructor(opts: AnalyzerOptions) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.snapshotStore = opts.snapshotStore;
    this.limits = opts.limits;
    this.dependencyChecker = opts.dependencyChecker;
    this.parseZipFn = opts.parseZipOverride ?? parseZip;
    this.msg = opts.msg ?? msgOf(opts.ctx);
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
      throw new Error(this.msg('import.readFailed', { zip: zipPath, reason: err instanceof Error ? err.message : String(err) }));
    }
    // 2. 校验 ZIP（安全解析：条目名/数量/体积上限）
    const archive = this.parseZipFn(raw, this.limits);

    // 3. manifest
    if (!archive.has(MANIFEST_FILE)) throw new Error(this.msg('import.noManifest'));
    let manifest: Manifest;
    try {
      manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    } catch (err) {
      throw new Error(this.msg('import.manifestParseFailed', { reason: err instanceof Error ? err.message : String(err) }));
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
        throw new Error(this.msg('import.integrityFailed', {
          entries: [...checksums.mismatches, ...checksums.missing].map((m) => `"${m}"`).join(', '),
        }));
      }
    }

    // 5. schema 版本判定（集中）
    if (!isSupported(manifest.schemaVersion)) {
      throw new Error(this.msg('import.schemaUnsupported', { version: describeVersion(manifest.schemaVersion) }));
    }

    // 6. 扫描：可执行文件条目 → 警告（不执行）
    const zipWarnings: string[] = [];
    for (const name of archive.names()) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(ext)) {
        zipWarnings.push(this.msg('import.executableWarning', { name }));
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
        throw new Error(this.msg('import.sectionParseFailed', { section: sectionId, reason: err instanceof Error ? err.message : String(err) }));
      }
      const issues = validateSectionData(sectionId, data);
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        throw new Error(this.msg('import.sectionInvalid', { section: sectionId, issues: errors.map((e) => e.message).join('; ') }));
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
      msg: this.msg,
    };

    const adapterItems: PlanItem[] = [];
    const adapterIssues: string[] = [];
    for (const adapter of this.adapters) {
      const data = sections.get(adapter.id);
      if (data === undefined) continue;
      try {
        const v = await adapter.validate(data, this.msg);
        for (const issue of v.issues) {
          if (issue.severity === 'error') adapterIssues.push(this.msg('import.adapterValidationIssue', { adapter: adapter.id, message: issue.message }));
        }
        if (!v.valid) continue;
        const items = await adapter.analyzeImport(data, importCtx);
        adapterItems.push(...items);
      } catch (err) {
        adapterIssues.push(this.msg('import.adapterAnalyzeFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
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
      errors.push(this.msg('import.versionUnsupported', { version: describeVersion(manifest.schemaVersion) }));
    }

    // 兼容性（第 6 步）
    const sectionsInZip = [...analyzed.sections.keys()];
    const missingSections = (Object.entries(manifest.sections) as [SectionId, boolean][])
      .filter(([id, on]) => on && !analyzed.sections.has(id))
      .map(([id]) => id);
    if (missingSections.length > 0) {
      warnings.push(this.msg('import.missingSections', { sections: missingSections.join(', ') }));
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
      encrypted: manifest.security.encrypted,
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
      msg: this.msg,
    };

    const items = analyzed.adapterItems.map((item) => applyItemResolution(item, decisions, this.msg));
    const planMappings = mergePathMappings(items, decisions.pathMappings);

    // F4 删除墓碑过滤：读取本地删除墓碑（<dataDir>/tombstones.json；缺失/损坏 → 空列表安全降级），
    // 剔除命中墓碑的计划项（插件 / 技能 / 文件类条目 + 分区级墓碑整分区跳过）。
    // 过滤是纯函数（applyTombstoneFilter），此处只负责加载数据并调用。
    const tombstones = await loadTombstones(this.ctx.fs, path.join(this.ctx.homeDir, 'dsh-config-manager'));
    const { items: planItems, skipped: skippedTombstoned } = applyTombstoneFilter(items, tombstones);

    // MissingSecret：兜底——credentialsStatus 分区里已配置的凭据若没有对应计划项，补占位
    ensureMissingSecrets(planItems, analyzed.sections, this.msg);

    const missingSecrets = planItems
      .filter((i) => i.kind === 'MissingSecret')
      .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));

    const needsRestart = planItems.some((i) => i.kind === 'Install' || (i.adapter === 'mcp' && i.kind !== 'Skip' && i.kind !== 'Warning'));

    const estimatedActions = {} as ImportPlan['estimatedActions'];
    for (const item of planItems) {
      if (item.kind === 'Skip' || item.kind === 'Warning') continue;
      estimatedActions[item.adapter] = (estimatedActions[item.adapter] ?? 0) + 1;
    }

    return {
      items: planItems,
      globalStrategy: decisions.strategy,
      pathMappings: planMappings,
      missingSecrets,
      needsRestart,
      estimatedActions,
      skippedTombstoned,
    };
  }

  /* ---------------- 第 11-14 步：executeImportPlan（快照 → 执行 → 校验 → 结果/回滚） ---------------- */

  async executeImportPlan(
    zipPath: string,
    plan: ImportPlan,
    opts: {
      confirm?: boolean;
      secretInputs?: Record<string, string>;
      decryptedCredentials?: Map<string, string>;
      rollbackOnError?: boolean;
      /** m1：每完成一个计划项调用（真实进度埋点；不传则无埋点） */
      onItem?: (info: PlanItemProgress) => void;
      /** m1：每开始一个计划项调用（供 UI 显示「正在执行项 X」/ 判定跳过按钮；不传则无埋点） */
      onItemStart?: (info: { adapter: SectionId; index: number; total: number; detail: string }) => void;
      /** 执行日志回调（逐计划项操作 + 子进程命令行；注入 ImportContext 供适配器调用；不传则无日志） */
      onLog?: (line: string) => void;
    } = {},
  ): Promise<ImportResult> {
    const bundle = await this.loadBundle(zipPath);
    const analyzed = await this.analyzeBundle(bundle);
    applyMappingsToSections(analyzed.sections, plan.pathMappings);

    // 10. 用户确认（安全阀：不确认绝不动数据）
    if (opts.confirm !== true) {
      throw new ImportNotConfirmedError(this.msg);
    }

    // 10b. 加密不变量：加密备份必须已成功解密（decryptedCredentials 由宿主用备份密码
    // 解开 security/secrets.enc 后注入）。未解密（undefined）一律拒绝执行——
    // 不允许把加密凭据静默降级为「缺凭据照常导入」，否则加密备份与普通备份无区别。
    if (bundle.manifest.security.encrypted && opts.decryptedCredentials === undefined) {
      throw new Error(this.msg('import.encryptedPasswordRequired'));
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
      msg: this.msg,
      onLog: opts.onLog,
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
    const totalItems = APPLY_ORDER.reduce((sum, id) => sum + (byAdapter.get(id)?.length ?? 0), 0);
    let itemIndex = 0;

    for (const adapterId of APPLY_ORDER) {
      const adapter = this.adapters.find((a) => a.id === adapterId);
      if (!adapter) continue;
      for (const item of byAdapter.get(adapterId) ?? []) {
        // 每项一个 AbortController：宿主可 abort「当前项」（用户跳过当前插件）→
        // 该项子进程被杀、标记为 user-skipped；不影响后续项执行。
        const controller = new AbortController();
        importCtx.signal = controller.signal;
        // m1 埋点：每开始一个计划项上报（UI 显示「正在执行项 X」/ 判定跳过按钮）
        const startIndex = itemIndex + 1;
        try {
          opts.onItemStart?.({ adapter: item.adapter, index: startIndex, total: totalItems, detail: item.id });
        } catch {
          // 埋点回调失败不影响导入执行
        }
        const outcome = await this.applyOne(adapter, item, importCtx);
        importCtx.signal = undefined;
        // m1 埋点：每完成一个计划项上报（真实进度；onItem 抛错不得中断导入）
        itemIndex += 1;
        try {
          opts.onItem?.({
            adapter: item.adapter,
            index: itemIndex,
            total: totalItems,
            status: outcome.executed.status,
            detail: item.id,
          });
        } catch {
          // 埋点回调失败不影响导入执行（进度是尽力而为）
        }
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
      // M1：回滚完成 → 快照标记 rolled-back（元数据写失败只告警，不影响回滚结论）
      await this.markSnapshotStatus(snapshot.id, 'rolled-back');
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
        skippedTombstoned: plan.skippedTombstoned ?? [],
      };
    }

    // 13. 校验（执行后：对最终数据再 validate；失败仅告警，不掩盖已完成项）
    for (const adapter of this.adapters) {
      const data = analyzed.sections.get(adapter.id);
      if (data === undefined) continue;
      try {
        const v = await adapter.validate(data, this.msg);
        for (const issue of v.issues) {
          if (issue.severity === 'error') warnings.push(this.msg('import.postValidationIssue', { adapter: adapter.id, message: issue.message }));
        }
      } catch (err) {
        warnings.push(this.msg('import.postValidationFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
      }
    }

    // 14. 结果
    const missingSecrets = plan.missingSecrets
      .filter((s) => !importCtx.decryptedCredentials?.has(s.ref) && !importCtx.secretInputs[s.ref])
      .map((s) => s.ref);

    // M1：导入成功 → 快照标记 done（元数据写失败只告警，不改变导入结论）
    await this.markSnapshotStatus(snapshot.id, 'done');

    // F1 vault 回填：导出时敏感文件（.credentials.yaml 等）明文未进备份（includeSecrets=false
    // 时镜像到 <dataDir>/vault），导入成功后从本机 vault 回填 $DSH_HOME；vault 缺失
    // （跨机恢复 / 从未镜像过）记入警告提示用户重填。尽力而为：失败仅警告，不影响导入结论。
    try {
      const vaultDataDir = path.join(this.ctx.homeDir, 'dsh-config-manager');
      const vault = await restoreVaultFiles(this.ctx.fs, vaultDataDir, this.ctx.homeDir, DEFAULT_SENSITIVE_RELS);
      for (const rel of vault.restored) warnings.push(this.msg('import.vaultRestored', { rel }));
      for (const rel of vault.missing) warnings.push(this.msg('import.vaultMissing', { rel }));
      for (const s of vault.skipped) {
        // targetExists = 目标已有更新的凭据，属预期跳过，不打扰用户
        if (s.reason !== 'targetExists') warnings.push(this.msg('import.vaultBackfillFailed', { rel: s.rel, reason: s.reason }));
      }
    } catch (err) {
      warnings.push(this.msg('import.vaultBackfillFailed', { rel: DEFAULT_SENSITIVE_RELS.join(', '), reason: err instanceof Error ? err.message : String(err) }));
    }

    return {
      ok: true, // 单项失败已如实记录在 executed；无未捕获异常即完成
      executed,
      needsRestart,
      missingSecrets,
      warnings,
      rollback: null,
      snapshotId: snapshot.id,
      skippedTombstoned: plan.skippedTombstoned ?? [],
    };
  }

  /** 快照状态标记（M1）：成功→done / 失败回滚→rolled-back。元数据写失败只告警不抛错。 */
  private async markSnapshotStatus(id: string, status: 'done' | 'rolled-back'): Promise<void> {
    try {
      await this.snapshotStore.updateStatus(id, status);
    } catch (err) {
      this.ctx.log.warn(`快照 ${id} 状态标记 ${status} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyOne(
    adapter: ConfigAdapter,
    item: PlanItem,
    ctx: ImportContext,
  ): Promise<{ executed: ExecutedItem; needsRestart: boolean; warning?: string }> {
    // 执行日志（导入面板展示）：仅非敏感文本（项 id / 命令），绝不写密钥/密码/补录值
    const onLog = ctx.onLog;
    if (
      item.kind === 'Skip' ||
      item.kind === 'Warning' ||
      item.kind === 'MissingDependency' ||
      (item.kind === 'Conflict' && item.conflict?.resolution !== 'useImported')
    ) {
      // Warning / MissingDependency 是信息项（依赖缺失、需人工注意），不调用 applyItem。
      onLog?.(`– ${item.id}`);
      return { executed: { itemId: item.id, status: 'skipped' }, needsRestart: false };
    }
    if (item.kind === 'Error') {
      onLog?.(`✗ ${item.id}`);
      return { executed: { itemId: item.id, status: 'failed', message: item.detail ?? item.description }, needsRestart: false };
    }
    if (item.kind === 'MissingSecret') {
      const ref = item.id.replace(/^secret:/, '');
      const value = ctx.decryptedCredentials?.get(ref) ?? ctx.secretInputs[ref];
      if (value === undefined || value === '') {
        onLog?.(`– ${item.id}`);
        return { executed: { itemId: item.id, status: 'skipped', message: this.msg('import.secretNotProvided') }, needsRestart: false };
      }
      // 补录值只经 adapter.applyItem 写入（m5 实现），引擎不直接触碰凭据
    }
    onLog?.(`▶ ${item.id}`);
    try {
      const result: ApplyResult = await adapter.applyItem(item, ctx);
      const status = result.ok ? 'ok' : (result.warning === true ? 'warning' : 'failed');
      onLog?.(`${status === 'ok' ? '✓' : status === 'warning' ? '⚠' : '✗'} ${item.id}`);
      return {
        executed: { itemId: item.id, status, message: result.message },
        needsRestart: result.needsRestart === true,
        warning: result.warning === true ? `${item.id}: ${result.message ?? item.description}` : undefined,
      };
    } catch (err) {
      // 用户跳过（宿主 install 中止子进程）：记为 skipped + skippedByUser，非失败，不触发回滚
      if (err instanceof ImportUserSkippedError) {
        onLog?.(`⏭ ${item.id}`);
        return {
          executed: {
            itemId: item.id,
            status: 'skipped',
            skippedByUser: true,
            message: this.msg('import.userSkipped'),
          },
          needsRestart: false,
        };
      }
      this.ctx.log.error(`应用计划项失败 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      onLog?.(`✗ ${item.id}`);
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
function applyItemResolution(item: PlanItem, decisions: ImportDecisions, msg: MsgFunc): PlanItem {
  if (item.kind !== 'Conflict') return item;
  const resolution = decisions.resolutions[item.id];
  if (resolution === 'keepCurrent') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictKeepCurrent')}` };
  }
  if (resolution === 'useImported') {
    return { ...item, kind: 'Update', severity: 'info', conflict: { itemId: item.id, resolution } };
  }
  // review / 未决策：按全局策略兜底
  if (decisions.strategy === 'skipExisting') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictSkipExisting')}` };
  }
  if (decisions.strategy === 'replace') {
    return { ...item, kind: 'Update', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictReplace')}` };
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
function ensureMissingSecrets(items: PlanItem[], sections: Map<SectionId, unknown>, msg: MsgFunc): void {
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
      description: msg('import.secretMissingDesc', { ref: c.ref }),
      severity: 'warning',
      target: { adapter: 'credentialsStatus', ref: c.ref },
    });
    existing.add(id);
  }
}

/* ---------------- F4 删除墓碑过滤（纯函数，可独立测试） ---------------- */

/**
 * 按删除墓碑过滤计划项（F4）：
 *  - 条目级：插件（Install/Update/Conflict）、技能（skills 文件）、文件类条目（agentPresets 等）命中墓碑 → 剔除；
 *  - 分区级：墓碑 kind='section' 且 id=分区 id → 整分区跳过（仅记一条 skipped）。
 * 返回过滤后的 items 与被跳过清单（纯函数：不读文件、不改入参）。
 */
function applyTombstoneFilter(
  items: PlanItem[],
  tombstones: Tombstone[],
): { items: PlanItem[]; skipped: SkippedTombstone[] } {
  if (tombstones.length === 0) return { items, skipped: [] };

  const tombstonedSections = new Set(tombstones.filter((t) => t.kind === 'section').map((t) => t.id));
  const skipped: SkippedTombstone[] = [];
  const out: PlanItem[] = [];
  const reportedSections = new Set<SectionId>();

  for (const item of items) {
    // 分区级墓碑优先：整个分区不出现（含 Skip 等非写入项，UI 提示「该分区已删除」）
    if (tombstonedSections.has(item.adapter)) {
      if (!reportedSections.has(item.adapter)) {
        skipped.push({ kind: 'section', id: item.adapter, adapter: item.adapter });
        reportedSections.add(item.adapter);
      }
      continue;
    }
    const key = tombstoneKeyForItem(item);
    if (key !== null && isTombstoned(key.kind, key.id, tombstones)) {
      skipped.push({ kind: key.kind, id: key.id, adapter: item.adapter });
      continue;
    }
    out.push(item);
  }
  return { items: out, skipped };
}

/** PlanItem → 墓碑键（{kind,id}）映射；非「将写入」的条目（Skip 等）与配置类项返回 null 不过滤 */
function tombstoneKeyForItem(item: PlanItem): { kind: TombstoneKind; id: string } | null {
  // 插件本体（plugin:<pkg>）：Install / Update / Conflict 均视为「将写入该插件」→ 命中墓碑剔除；
  // patch: 行与 plugins:pnpm-workspace 是配置类项，不按插件墓碑过滤（分区级墓碑可覆盖）。
  if (item.adapter === 'plugins' && item.id.startsWith('plugin:')) {
    if (item.kind !== 'Install' && item.kind !== 'Update' && item.kind !== 'Conflict') return null;
    return { kind: 'plugin', id: item.id.slice('plugin:'.length) };
  }
  // 文件类分区条目（id = <分区>:<相对路径>）：skills → skill 墓碑；其余文件类（agentPresets/
  // agentInstructions/pluginFiles/sessions/self）→ 通用 file 墓碑（id 为相对路径）。
  if (item.kind === 'Create' || item.kind === 'Update' || item.kind === 'Conflict') {
    const prefix = `${item.adapter}:`;
    if (item.adapter === 'skills') return { kind: 'skill', id: item.id.slice(prefix.length) };
    if (isFileSection(item.adapter)) return { kind: 'file', id: item.id.slice(prefix.length) };
  }
  return null;
}
