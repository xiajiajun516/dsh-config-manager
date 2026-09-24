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
  SECTION_FILE_PREFIXES, SECTION_IDS, SECTION_JSON_PATHS, isFileSection, validateSectionData,
} from '../schema/config.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest, validateManifest } from '../schema/manifest.ts';
import {
  CURRENT_SCHEMA_VERSION, canImport, describeVersion, isSupported, isTooNew, needsMigration,
} from '../schema/versions.ts';
import { migrateToCurrent } from '../migrations/index.ts';
import { isAbsolutePath, applyPrefixMappings } from '../utils/paths.ts';
import { parseZip, type ZipArchive, type ZipSafetyLimits } from '../utils/zip.ts';
import type { BootSafetyReport } from './boot-safety.ts';
import type { FilesSection, Manifest, SectionId } from '../schema/types.ts';
import { loadTombstones, isTombstoned } from '../schema/tombstones.ts';
import type { Tombstone, TombstoneKind } from '../schema/tombstones.ts';
import { DEFAULT_SENSITIVE_RELS, restoreVaultFiles } from '../security/vault.ts';
import { createSnapshot, planItemWritesTarget, resolveFileTarget, resolveFileTargetRel } from './backup.ts';
import { isCredentialConfigured } from './credential-status.ts';
import { rollback } from './rollback.ts';
import { computeCompatibility } from './validator.ts';
import { msgOf } from './messages.ts';
import type { MsgFunc } from './messages.ts';
import {
  ImportNotConfirmedError, ImportUserSkippedError, type ApplyResult, type ConfigAdapter,
  type ExecutedItem, type HostContext, type ImportAnalysis, type ImportContext,
  type ImportDecisions, type ImportPlan, type ImportResult, type PathIssue,
  type PathMapping, type PlanItem, type SkippedTombstone, type Snapshot, type SnapshotStore,
  type TransactionSnapshotContext,
} from './types.ts';

/**
 * 导入执行**相位**（策略，不是分区清单）：只表达「谁必须排在后面」——
 *  - 1：MCP 配置（改完需重启才生效）；
 *  - 2：插件安装 / patch 行写入（副作用最大，历史上排在 MCP 之后）；
 *  - 3：尾段 —— 凭据状态、插件自身配置（低风险配置文件，设计 §5.4 的收尾）。
 * 未列出的分区一律相位 0（常规配置写入）。**新增分区无需改本表**。
 */
const APPLY_PHASE: Partial<Record<SectionId, 0 | 1 | 2 | 3>> = {
  mcp: 1,
  plugins: 2,
  credentialsStatus: 3,
  self: 3, // P1-1：self（插件自身配置）曾在手抄清单里漏掉 → 导入时被静默丢弃，现由派生兜住
};

/**
 * 执行阶段顺序（设计 §5.4：副作用大的 patch/安装最后）。导出供宿主生命周期等复用同一顺序。
 *
 * t30：分区全集来自注册表 `SECTION_IDS`（已按 applyOrder 升序），本数组只做**稳定排序**按相位分层 ——
 * 原先手抄的 13 项清单已删除，因此不再可能「漏抄一个分区 → 它的计划项被静默跳过」。
 * 与历史顺序的逐项等价由 core/backup-plan.test.ts 钉住（相位内保持注册表顺序 ⇒ 真实分区相对次序不变）。
 */
export const APPLY_ORDER: readonly SectionId[] = [...SECTION_IDS].sort(
  (a, b) => (APPLY_PHASE[a] ?? 0) - (APPLY_PHASE[b] ?? 0),
);

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
  /** G-06：schema 迁移链实际执行的步骤告警（`import.migrated`；CURRENT=MIN=1 时恒为空） */
  migrationWarnings: string[];
}

/** 分区提取产出：数据 + 被跳过分区的原因分类（G-01/G-02/G-03/G-05） */
interface SectionExtraction {
  sections: Map<SectionId, unknown>;
  /** manifest 声明启用但本版本不认识的 id（不在 SECTION_IDS）→ 独立告警，不计入 missingSections */
  unsupportedSections: string[];
  /** 已知分区、但数据 version 高于本版本支持的 1 → 已跳过该分区（warning，不阻断） */
  unsupportedVersions: { section: SectionId; version: number }[];
  /** 提取期产生的分区级告警（未知分区汇总 + 版本过高被跳过） */
  warnings: string[];
}

interface AnalyzedBundle extends Bundle {
  sections: Map<SectionId, unknown>;
  unsupportedSections: string[];
  unsupportedVersions: { section: SectionId; version: number }[];
  sectionWarnings: string[];
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
    // 默认回落 = core parseZip：**它本身就是最严解析器**（条目名/重复条目名/symlink/
    // 本地文件头越界/条目数与体积限额）。注入点只用于特殊限额或测试替身，
    // 不再是「默认弱解析 + 宿主注入强化版」的分工。
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
    const zipWarnings: string[] = [];
    let checksums = { ok: true, mismatches: [] as string[], missing: [] as string[] };
    // 4a. H2：校验表**缺失**或**为空**时，全部条目都处于「未登记 ⇒ 未被校验」状态。
    //     此前整段完整性逻辑（含下面的反向检查）都嵌在 `if (archive.has(CHECKSUMS_FILE))` 内，
    //     于是「剥掉 checksums.json」或「把它置为 {}」= 一个条目都不校验，却 valid=true / 零告警。
    //     两种形态对用户是同一件事（没有任何条目被校验），故共用同一条告警，不制造近重复文案。
    const table = archive.has(CHECKSUMS_FILE)
      ? (parseJsonSafe(archive.readEntryText(CHECKSUMS_FILE)) as Record<string, string>)
      : null;
    if (table === null || Object.keys(table).length === 0) {
      zipWarnings.push(this.msg('import.checksumsMissing'));
    }
    if (table !== null && Object.keys(table).length > 0) {
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
      // 4b. G-04：反向完整性——ZIP 内**不在**校验表里的条目（未登记 ⇒ 未被校验）。
      //     verifyAgainstTable 只遍历表里的键，所以 ZIP 里多出的条目此前既不校验也不告知；
      //     这里把它变成显式 warning（不阻断：未知 ZIP 条目不参与校验是格式 v1 的既定语义）。
      //     排除 manifest.json / checksums.json 自身与目录条目（以 "/" 结尾）。
      const tableKeys = new Set(Object.keys(table));
      const extraEntries = archive.names().filter(
        (name) => name !== MANIFEST_FILE && name !== CHECKSUMS_FILE
          && !name.endsWith('/') && !tableKeys.has(name),
      );
      if (extraEntries.length > 0) {
        zipWarnings.push(this.msg('import.extraEntries', {
          entries: extraEntries.map((e) => `"${e}"`).join(', '),
        }));
      }
    }

    // 5. schema 版本判定（集中）：过新（isTooNew）或过旧（低于 MIN_SUPPORTED）→ 一律硬失败（行为不变）
    if (isTooNew(manifest.schemaVersion) || !isSupported(manifest.schemaVersion)) {
      throw new Error(this.msg('import.schemaUnsupported', { version: describeVersion(manifest.schemaVersion) }));
    }

    // 5b. G-06：把「可迁移的旧 schema」真正沿迁移链升级——此前 `migrateToCurrent` 在 src/ 内零引用，
    //     迁移链有定义、有单测、却从未执行。迁移结果 doc 成为后续 manifest，并重新校验其合法性。
    //     注：当前 MIN_SUPPORTED = CURRENT = 1 ⇒ needsMigration 恒假 ⇒ 此处零迁移（旧 v1 行为不变）；
    //     一旦 CURRENT > MIN，旧备份会在这里被真实迁移，而不是「判定可迁移却按新格式直接用」。
    const migrationWarnings: string[] = [];
    if (needsMigration(manifest.schemaVersion)) {
      const migrated = runSchemaMigration(manifest, manifest.schemaVersion, CURRENT_SCHEMA_VERSION, this.msg);
      manifest = migrated.manifest;
      migrationWarnings.push(...migrated.warnings);
    }

    // 6. 扫描：可执行文件条目 → 警告（不执行）
    for (const name of archive.names()) {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(ext)) {
        zipWarnings.push(this.msg('import.executableWarning', { name }));
      }
    }

    const bundle: Bundle = { archive, manifest, checksums, zipWarnings, migrationWarnings };
    this.bundleCache.set(zipPath, bundle);
    return bundle;
  }

  /* ---------------- 第 7 步：分区内容扫描/提取 ---------------- */

  private extractSections(bundle: Bundle): SectionExtraction {
    const { archive, manifest } = bundle;
    const sections = new Map<SectionId, unknown>();
    const unsupportedSections: string[] = [];
    const unsupportedVersions: { section: SectionId; version: number }[] = [];
    const warnings: string[] = [];
    const knownIds = new Set<string>(SECTION_IDS);
    for (const [sectionId, enabled] of Object.entries(manifest.sections) as [string, boolean][]) {
      if (!enabled) continue;
      // G-01/G-02/G-03：manifest.sections 的键可能来自更新的 DSH（本版本不认识的分区）。
      // 未知分区单独收集 → 由本函数产出独立告警；**绝不**再落进 missingSections
      // （此前会被误报成「备份声明了但缺少的分区: X」——而文件其实就在 ZIP 里）。
      if (!knownIds.has(sectionId)) {
        unsupportedSections.push(sectionId);
        continue;
      }
      const id = sectionId as SectionId;
      if (isFileSection(id)) {
        const prefix = SECTION_FILE_PREFIXES[id]!;
        const files: FilesSection['files'] = [];
        for (const name of archive.names()) {
          if (!name.startsWith(prefix) || name === prefix) continue;
          const rel = name.slice(prefix.length);
          if (rel === '' || rel.endsWith('/')) continue;
          const data = archive.readEntry(name);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        }
        sections.set(id, { version: 1, files });
        continue;
      }
      const jsonPath = SECTION_JSON_PATHS[id];
      if (jsonPath === undefined) continue; // secrets 分区无 JSON 文件
      if (!archive.has(jsonPath)) continue; // 声明包含但文件缺失 → 由调用方记 missingSections
      let data: unknown;
      try {
        data = archive.readEntryJson(jsonPath);
      } catch (err) {
        throw new Error(this.msg('import.sectionParseFailed', { section: id, reason: err instanceof Error ? err.message : String(err) }));
      }
      // G-05：分区数据 version 高于本版本支持的 1 → 跳过该分区（warning，不阻断整个 bundle）。
      // 判定前置在此（不改 schema/config.ts 的校验语义）：只有「数字且 > 1」才跳过；
      // version < 1、非数字或缺失仍交由 validateSectionData 记硬错误（数据损坏语义不变）。
      const rawVersion = (data !== null && typeof data === 'object')
        ? (data as Record<string, unknown>)['version']
        : undefined;
      if (typeof rawVersion === 'number' && rawVersion > 1) {
        unsupportedVersions.push({ section: id, version: rawVersion });
        warnings.push(this.msg('import.unsupportedSectionVersion', { section: id, version: String(rawVersion) }));
        continue;
      }
      const issues = validateSectionData(id, data);
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        throw new Error(this.msg('import.sectionInvalid', { section: id, issues: errors.map((e) => e.message).join('; ') }));
      }
      sections.set(id, data);
    }
    // 未知分区汇总告警（放在版本告警之后：一条消息列出全部被跳过的未知分区）
    if (unsupportedSections.length > 0) {
      warnings.push(this.msg('import.unsupportedSections', { sections: unsupportedSections.join(', ') }));
    }
    return { sections, unsupportedSections, unsupportedVersions, warnings };
  }

  private async analyzeBundle(bundle: Bundle): Promise<AnalyzedBundle> {
    const extraction = this.extractSections(bundle);
    const { sections } = extraction;
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

    return {
      ...bundle,
      sections,
      unsupportedSections: extraction.unsupportedSections,
      unsupportedVersions: extraction.unsupportedVersions,
      // issue #45 加固：包含会话却**完全没有工作区数据**的包（旧版插件导出的历史包就是这样）——会话能不能
      // 显示完全取决于有没有工作区指向它的 cwd，导入前就必须让用户看见这条风险，而不是导入完发现「对话没了」。
      sectionWarnings: [
        ...extraction.warnings,
        ...(sections.has('sessions') && !sections.has('workspaces') ? [this.msg('import.sessionsWithoutWorkspaces')] : []),
      ],
      adapterItems,
      adapterIssues,
    };
  }

  /* ---------------- 第 8 步：analyzeImport ---------------- */

  /**
   * @param opts.decryptedCredentials 宿主用备份密码解开 `security/secrets.enc` 后的
   *   `ref → 值` Map（仅内存；issue #39 Feature 2）。**只用于统计 ref 名与「本机是否已配置」**，
   *   绝不写回、绝不进任何返回值/日志。缺省（密码不存在/备份未加密）→ refs 为空数组。
   */
  async analyzeImport(
    zipPath: string,
    opts: { decryptedCredentials?: Map<string, string> } = {},
  ): Promise<ImportAnalysis> {
    const bundle = await this.loadBundle(zipPath);
    const { manifest, zipWarnings } = bundle;
    const analyzed = await this.analyzeBundle(bundle);

    const errors = [...analyzed.adapterIssues];
    const warnings = [...zipWarnings, ...bundle.migrationWarnings, ...analyzed.sectionWarnings];
    if (!canImport(manifest.schemaVersion)) {
      errors.push(this.msg('import.versionUnsupported', { version: describeVersion(manifest.schemaVersion) }));
    }

    // 兼容性（第 6 步）
    const sectionsInZip = [...analyzed.sections.keys()];
    // G-01/G-02/G-03/G-05：被「跳过」的分区（本版本不认识的未知分区 / 数据版本过高）**不是缺失**，
    // 必须从 missingSections 剔除；missingSections 只统计「已知分区但 ZIP 内文件缺失」。
    const unsupportedSections = analyzed.unsupportedSections;
    const skippedSections = new Set<string>([
      ...unsupportedSections,
      ...analyzed.unsupportedVersions.map((u) => u.section),
    ]);
    const missingSections = (Object.entries(manifest.sections) as [SectionId, boolean][])
      .filter(([id, on]) => on && !skippedSections.has(id) && !analyzed.sections.has(id))
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

    // issue #39 Feature 2：凭据可恢复性摘要。宿主不必自己解 secrets.enc 解析 YAML
    // （那等于把 .credentials.yaml 的布局知识复制到每个宿主，正是 issue #39 的坑）。
    // **只回传 ref 名**：值永不出现，连长度都不出现。
    const refs = opts.decryptedCredentials === undefined
      ? []
      : [...opts.decryptedCredentials.keys()].sort();
    const satisfied: string[] = [];
    for (const ref of refs) {
      try {
        const status = await this.ctx.credentials.describe(ref);
        if (status.configured === true) satisfied.push(ref);
      } catch {
        // 凭据服务不可用 / ref 不合法 → 保守判为「未满足」，不声称已就绪
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      compatibility,
      sectionsInZip,
      unsupportedSections,
      unsupportedVersions: analyzed.unsupportedVersions,
      pluginSummary,
      pathIssues,
      secretCount,
      dependencyIssues,
      encrypted: manifest.security.encrypted,
      credentials: {
        inArchive: manifest.security.containsSecrets === true,
        refs,
        satisfied,
      },
    };
  }

  /** 文件集合分区 id：这些分区的相对路径必须逐字保留（见 ConfigAdapter.fileCollection）。 */
  private fileCollectionIds(): ReadonlySet<string> {
    return new Set(this.adapters.filter((a) => a.fileCollection === true).map((a) => a.id));
  }

  /* ---------------- 第 9 步：createImportPlan（Dry Run 复用） ---------------- */

  /**
   * @param opts.decryptedCredentials 宿主用备份密码解开 `security/secrets.enc` 得到的 ref→值
   *   （仅内存）。**必须**传进来：它决定「归档里到底有哪些凭据值」——加密备份可能携带
   *   未被任何 settings namespace 引用的 ref（凭据文件是原文加密，不止 credentialsStatus 那几个），
   *   这些值若不在计划里出现就永远不会被写回（真机反馈：导入密钥没生效）。
   */
  async createImportPlan(
    zipPath: string,
    decisions: ImportDecisions,
    opts: { decryptedCredentials?: Map<string, string> } = {},
  ): Promise<ImportPlan> {
    const bundle = await this.loadBundle(zipPath);
    const analyzed = await this.analyzeBundle(bundle);
    const { manifest } = bundle;

    // 跨机基础路径自动重定基（issue #45 用户补充）：导出机 DSH home ≠ 本机时，备份里位于导出机
    // 基础路径之下的绝对路径（会话首帧 cwd / 工作区 path / mcp cwd…）一律改成「本机基础路径 +
    // 同一后缀」。基础路径是机器身份、本机可精确得知，比让用户手填自由前缀映射更安全可控；
    // 用户映射排在其后依次生效（可覆盖本规则），因此这是「默认更安全 + 仍可人工微调」。
    // 只作用于结构化分区的路径叶值；文件集合分区（sessions 的 relativePath）永不被改写（见 applyMappingsToSections）。
    const rebase = rebaseMapping(manifest.sourceHome, this.ctx.homeDir);
    const effectiveMappings = rebase === undefined ? decisions.pathMappings : [rebase, ...decisions.pathMappings];
    // 先应用映射（PathMapper 先行：applyItem 拿到的已是映射后数据）
    applyMappingsToSections(analyzed.sections, effectiveMappings, this.fileCollectionIds());

    const items = analyzed.adapterItems.map((item) => applyItemResolution(item, decisions, this.msg));
    const planMappings = mergePathMappings(items, effectiveMappings);

    // F4 删除墓碑过滤：读取本地删除墓碑（<dataDir>/tombstones.json；缺失/损坏 → 空列表安全降级），
    // 剔除命中墓碑的计划项（插件 / 技能 / 文件类条目 + 分区级墓碑整分区跳过）。
    // 过滤是纯函数（applyTombstoneFilter），此处只负责加载数据并调用。
    const tombstones = await loadTombstones(this.ctx.fs, path.join(this.ctx.homeDir, 'dsh-config-manager'));
    const { items: planItems, skipped: skippedTombstoned } = applyTombstoneFilter(items, tombstones);

    // 凭据计划项（MissingSecret / Skip）的唯一生成点 —— 规则见 buildCredentialPlanItems 文档。
    await buildCredentialPlanItems(
      planItems, analyzed.sections, opts.decryptedCredentials, this.msg,
      (ref) => isCredentialConfigured(this.ctx, ref),
    );

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
      ...(rebase !== undefined ? { automaticMappings: [rebase] } : {}),
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
      /**
       * Phase 4 生产 journal↔snapshot 绑定（deferred 模式）。
       * 宿主经 runJournaled({ deferredSnapshot:true }) 的 ctx 注入；引擎在快照创建/首 mutation 时绑定，
       * 保证快照 durable+verified 且 journal 已知先于任何写。不传 = 无 journal 绑定（非生产 journaled 路径）。
       */
      snapshotBinding?: TransactionSnapshotContext;
      /**
       * 用户终止信号（宿主 /runs/cancel 触发）。**只在计划项边界检查** ——
       * 绝不在项中途 abort：那是 ImportContext.signal（「跳过当前项」）的语义。
       * 与 rollbackOnError 无关：终止是独立于「失败策略」的用户动作。
       */
      cancelSignal?: AbortSignal;
      /**
       * 在安全点询问用户如何处置已应用部分。缺省 / 抛错 / 超时一律按 **rollback**（安全侧）。
       * 宿主实现：把 run 置为「待决策」并阻塞等 /runs/cancel/decision。
       */
      onCancelDecision?: () => Promise<'rollback' | 'keep'>;
      /**
       * 「保留已应用项」分支的启动自洽审计（宿主注入；缺省 = 未审计，结果里如实标注）。
       * 引擎在**所有分区收尾之后**调用 —— 审计必须看到最终盘面。实现不得抛错
       * （调用方正在正常返回路径上，抛错会把已知结论换成异常并触发 journal SAFE MODE）。
       */
      bootSafetyAudit?: () => Promise<BootSafetyReport>;
    } = {},
  ): Promise<ImportResult> {
    const bundle = await this.loadBundle(zipPath);
    const analyzed = await this.analyzeBundle(bundle);
    applyMappingsToSections(analyzed.sections, plan.pathMappings, this.fileCollectionIds());

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

    // 11. 快照（强制：导入前必须先备份将被修改的目标）。
    //     Phase 4：宿主注入 snapshotBinding 时，把 op-bound 元数据写入快照，并立即绑定 journal
    //     （SNAPSHOT_CREATED），保证「快照 durable+verified 且 journal 已知」先于首个 mutation。
    const snapshot = await createSnapshot({
      ctx: this.ctx,
      plan,
      sourceZip: zipPath,
      store: this.snapshotStore,
      adapters: this.adapters,
      operationId: opts.snapshotBinding?.operationId,
      operationType: opts.snapshotBinding?.operationType,
      environmentFingerprint: opts.snapshotBinding?.environmentFingerprint,
      ownerInstanceId: opts.snapshotBinding?.ownerInstanceId,
    });
    if (opts.snapshotBinding !== undefined) {
      await opts.snapshotBinding.bindSnapshot(snapshot.id);
      // 首个 destructive side effect 前：SNAPSHOT_CREATED→APPLYING（在首个 applyOne 之前调 markApplying）
      await opts.snapshotBinding.markApplying();
    }

    // P2-B（Phase 8）：逐计划项 WAL 预登记。将产生真实 side effect 的项在 apply 之前
    // 记为 planned（文件类带 beforeFp），使 crash 中途可按「仍 planned ⇒ 未应用」保守判定；
    // 非文件项 external=true（不可证明 → reconcile 恒 needs-attention，安全边界不放宽）。
    const sb = opts.snapshotBinding;
    const beforeFpByItem = new Map<string, string | null>();
    if (sb?.recordStep !== undefined) {
      for (const item of plan.items) {
        if (!this.shouldJournalStep(item)) continue;
        let rel: string | null = null;
        let beforeFp: string | null = null;
        if (Analyzer.fileRelFor(item, importCtx.target.profile) !== null) {
          rel = Analyzer.fileRelFor(item, importCtx.target.profile) as string;
          beforeFp = await this.fileFp(importCtx, rel);
        }
        beforeFpByItem.set(item.id, beforeFp);
        await sb.recordStep({
          id: item.id,
          adapter: item.adapter,
          kind: item.kind,
          ref: rel !== null ? resolveFileTarget(importCtx.target, item.adapter, item.target?.ref ?? '') : '',
          external: rel === null,
          status: 'planned',
          beforeFp,
          afterFp: null,
        });
      }
    }

    const executed: ExecutedItem[] = [];
    const warnings: string[] = [...bundle.zipWarnings, ...bundle.migrationWarnings, ...analyzed.sectionWarnings];
    let needsRestart = plan.needsRestart;
    let anyFailed = false;
    /** 用户终止已在**安全点**生效（项边界；当前项已完整结束）。 */
    let cancelled = false;
    /** 终止后用户的处置选择（null = 尚未询问）。 */
    let cancelDecision: 'rollback' | 'keep' | null = null;
    /** 保留分支已标记（决定快照状态与结果字段）。 */
    let keptPartial = false;
    let bootSafety: BootSafetyReport | null = null;

    /**
     * 安全点取消：只在**计划项边界**调用（当前项已完整 applyOne 结束）。
     * 绝不中途 abort 单项 —— 那会把「半装插件 / 半写文件」留在盘上，正是本功能要避免的。
     * 决策通道失败 / 抛错 → 一律按 rollback（安全侧），绝不把「已知结论」换成异常。
     */
    const requestCancel = async (): Promise<void> => {
      cancelled = true;
      try {
        opts.onLog?.(this.msg('import.cancelRequested'));
      } catch { /* 日志埋点失败不影响终止 */ }
      let decision: 'rollback' | 'keep' = 'rollback';
      try {
        decision = (await opts.onCancelDecision?.()) ?? 'rollback';
      } catch (err) {
        this.ctx.log.warn(`终止决策通道失败，按安全侧默认回滚: ${err instanceof Error ? err.message : String(err)}`);
        decision = 'rollback';
      }
      cancelDecision = decision === 'keep' ? 'keep' : 'rollback';
    };

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
      // 终止已在上一分区的边界生效：不再开新分区（已跑到这里的分区仍会做下方收尾）
      if (cancelled) break;
      for (const item of byAdapter.get(adapterId) ?? []) {
        // 安全点：每项**开始之前**检查终止信号 —— 当前项要么完整跑完、要么根本没开始，
        // 绝不留下半截项（半装插件 / 半写文件）。
        if (!cancelled && opts.cancelSignal?.aborted === true) await requestCancel();
        if (cancelled) break;
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
        // P2-B（Phase 8）：逐项更新 journal step。文件类成功 → done + afterFp（reconcile 可判
        // recovered）；失败/warning/跳过 → 无不可靠 afterFp（attention/skipped → 保守 needs-attention）。
        if (sb?.recordStep !== undefined && beforeFpByItem.has(item.id)) {
          const rel = Analyzer.fileRelFor(item, importCtx.target.profile);
          let afterFp: string | null = null;
          if (rel !== null && outcome.executed.status === 'ok') {
            afterFp = await this.fileFp(importCtx, rel);
          }
          await sb.recordStep({
            id: item.id,
            adapter: item.adapter,
            kind: item.kind,
            ref: rel !== null ? resolveFileTarget(importCtx.target, item.adapter, item.target?.ref ?? '') : '',
            external: rel === null,
            // issue #35：'warning'（如插件安装失败但非致命 §34.17）此前被记为 'skipped'，
            // 与「用户主动跳过」在持久层不可区分 —— 事后审计会得出「用户跳过了这些插件」的错误结论。
            // 失败/警告都是**不可证明已应用** → 一律 attention；'skipped' 只留给真正的跳过。
            status:
              outcome.executed.status === 'ok'
                ? 'done'
                : outcome.executed.status === 'skipped'
                  ? 'skipped'
                  : 'attention',
            beforeFp: beforeFpByItem.get(item.id) ?? null,
            afterFp,
            message: outcome.executed.message ?? null,
          });
        }
        // 仅硬失败计入 anyFailed（warning 属非致命：目标不可达等，不触发回滚，§34.17）
        if (outcome.executed.status === 'failed') anyFailed = true;
        if (outcome.needsRestart) needsRestart = true;
        if (outcome.warning) warnings.push(outcome.warning);
        if (opts.rollbackOnError && outcome.executed.status === 'failed') break;
      }
      // 分区收尾（issue #45 ④）：会话位置护栏等必须等本分区全部写完才做的动作。
      // 「终止 + 回滚」例外：整笔马上要被回滚，再跑收尾纯属浪费且可能中途失败。
      if (adapter.finalizeApply !== undefined && !(opts.rollbackOnError && anyFailed) && !(cancelled && cancelDecision === 'rollback')) {
        let finalized: ApplyResult[] = [];
        try {
          finalized = await adapter.finalizeApply(importCtx);
        } catch (error) {
          // 收尾自身抛错 → 记非致命告警（绝不静默；也不把一个护栏失败升级成整体导入失败）
          finalized = [{
            ok: false,
            warning: true,
            message: `finalize ${adapterId}: ${error instanceof Error ? error.message : String(error)}`,
          }];
        }
        for (const result of finalized) {
          const status: ExecutedItem['status'] = result.ok ? 'ok' : result.warning === true ? 'warning' : 'failed';
          executed.push({
            itemId: `${adapterId}:finalize`,
            status,
            ...(result.message !== undefined ? { message: result.message } : {}),
          });
          if (status === 'failed') anyFailed = true;
          if (status !== 'ok' && result.message !== undefined) warnings.push(result.message);
        }
      }
      if ((cancelled && cancelDecision === 'rollback') || (opts.rollbackOnError && anyFailed)) break;
    }

    // 全部分区收尾之后的一次性收尾（issue #45）：把会话登记进工作区要求会话文件已写盘且首帧已按
    // 映射改写/归位，而 workspaces 在 APPLY_ORDER 里排在 sessions 之前 —— 只能在所有分区收尾后再做。
    // 「保留」分支**必须跑**这一段：有会话数据却没登记进工作区 = 用户看不到对话（issue #45 真机事故）。
    if (!(opts.rollbackOnError && anyFailed) && !(cancelled && cancelDecision === 'rollback')) {
      for (const adapterId of APPLY_ORDER) {
        const adapter = this.adapters.find((a) => a.id === adapterId);
        if (adapter?.finalizeImport === undefined) continue;
        if ((byAdapter.get(adapterId)?.length ?? 0) === 0) continue;
        let finalized: ApplyResult[] = [];
        try {
          finalized = await adapter.finalizeImport(importCtx);
        } catch (error) {
          finalized = [{
            ok: false,
            warning: true,
            message: 'finalizeImport ' + adapterId + ': ' + (error instanceof Error ? error.message : String(error)),
          }];
        }
        for (const result of finalized) {
          const status: ExecutedItem['status'] = result.ok ? 'ok' : result.warning === true ? 'warning' : 'failed';
          executed.push({
            itemId: adapterId + ':finalizeImport',
            status,
            ...(result.message !== undefined ? { message: result.message } : {}),
          });
          if (status === 'failed') anyFailed = true;
          if (status !== 'ok' && result.message !== undefined) warnings.push(result.message);
        }
      }
    }

    // 用户终止 + 选择「回滚」：与「失败整体回滚」复用同一条补偿路径（绝不新造第二份回滚）
    if (cancelled && cancelDecision === 'rollback') {
      const rolledBack = await this.rollbackApplied(snapshot, executed, warnings, plan, opts.snapshotBinding, 'cancelled')
      return { ...rolledBack, cancelled: true, keptPartial: false }
    }

    /**
     * 用户终止 + 选择「保留已应用项」：在安全点停下之后必须补齐三件事，否则「保留」就退化成
     * 「把半成品丢给用户、DSH 起不来再让用户自己猜」：
     *  ① 分区收尾（上方 finalizeApply / finalizeImport 已按条件跑完）；
     *  ② journal 收敛：未执行项从 planned 显式改成 skipped —— journal 正常返回会被判
     *     COMMITTED 并移出 active/（所以不会触发下次启动 SAFE MODE），但留着 planned 会让
     *     事后审计读到「已提交」而盘面只应用了一部分，与审计 P0-3 是同一类「journal 与盘面不符」。
     *     语义上沿用本仓库已钉死的 skipped = 「用户主动跳过」（issue #35），此处是用户主动放弃剩余项；
     *  ③ 启动自洽审计：profile 插件清单里解析不到的包会让 DSH 下次启动直接失败。
     *
     * 快照**保持可用**（不标 done / 不标 rolled-back）——这是「保留」的可撤销承诺：
     * 用户随时可以在「备份」页用这笔导入前快照手动回滚。
     * 本分支**绝不允许抛错**：调用方处于正常返回路径上，抛错会把「已知结论：部分保留」换成
     * 异常 → runJournaled 记 NEEDS_ATTENTION + SAFE MODE，正好是本功能要避免的结局。
     */
    if (cancelled && cancelDecision === 'keep') {
      keptPartial = true;
      const executedIds = new Set(executed.map((e) => e.itemId));
      let abandoned = 0;
      if (sb?.recordStep !== undefined) {
        for (const item of plan.items) {
          if (!beforeFpByItem.has(item.id) || executedIds.has(item.id)) continue;
          abandoned += 1;
          try {
            const rel = Analyzer.fileRelFor(item, importCtx.target.profile);
            await sb.recordStep({
              id: item.id,
              adapter: item.adapter,
              kind: item.kind,
              ref: rel !== null ? resolveFileTarget(importCtx.target, item.adapter, item.target?.ref ?? '') : '',
              external: rel === null,
              status: 'skipped',
              beforeFp: beforeFpByItem.get(item.id) ?? null,
              afterFp: null,
              message: this.msg('import.cancelKeptSkippedItem'),
            });
          } catch (err) {
            warnings.push(this.msg('import.cancelKeptJournalFailed', {
              id: item.id,
              reason: err instanceof Error ? err.message : String(err),
            }));
          }
        }
      }
      try {
        opts.onLog?.(this.msg('import.cancelKept', { applied: String(executedIds.size), skipped: String(abandoned) }));
      } catch { /* 日志埋点失败不影响终止结论 */ }
      if (opts.bootSafetyAudit === undefined) {
        warnings.push(this.msg('import.cancelKeptNoAudit', { reason: 'audit-not-injected' }));
      } else {
        try {
          bootSafety = await opts.bootSafetyAudit();
          for (const issue of bootSafety.issues) warnings.push(issue.detail);
          if (bootSafety.unchecked.length > 0) {
            warnings.push(this.msg('import.cancelKeptUnchecked', { items: bootSafety.unchecked.join(', ') }));
          }
        } catch (err) {
          bootSafety = null;
          warnings.push(this.msg('import.cancelKeptNoAudit', { reason: err instanceof Error ? err.message : String(err) }));
        }
      }
    }

    // 失败整体回滚（rollbackOnError）：逆序补偿 + 诚实报告
    if (opts.rollbackOnError && anyFailed) {
      return await this.rollbackApplied(snapshot, executed, warnings, plan, opts.snapshotBinding, 'failed')
    }

    // 13. 校验（执行后：对最终数据再 validate；失败仅告警，不掩盖已完成项）
    // 保留分支跳过：analyzed.sections 是整个包的数据，而盘上只有一部分，校验结论会系统性偏负
    // （「该分区数据不完整」类告警）——那属于噪声，不是真问题。改由启动自洽审计报真实风险。
    for (const adapter of keptPartial ? [] : this.adapters) {
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
    // issue #39：从**加密归档内**解出并回填的条数（用户手工补录不计入）。只回传条数。
    const credentialsRestored = plan.missingSecrets
      .filter((s) => importCtx.decryptedCredentials?.has(s.ref) === true)
      .length;

    // M1：导入成功 → 快照标记 done（元数据写失败只告警，不改变导入结论）。
    // 保留分支**不标** done：这笔导入并没有完成，快照必须保持可用 —— 它是「保留」的可撤销承诺
    // （用户可事后在「备份」页用它手动回滚）；标 done 会让它看起来像一笔正常完成的导入。
    if (keptPartial) {
      warnings.push(this.msg('import.cancelKeptSnapshotKept', { snapshotId: snapshot.id }));
    } else {
      await this.markSnapshotStatus(snapshot.id, 'done');
    }

    // F1 vault 回填：导出时敏感文件（.credentials.yaml 等）明文未进备份（includeSecrets=false
    // 时镜像到 <dataDir>/vault），导入成功后从本机 vault 回填 $DSH_HOME；vault 缺失
    // （跨机恢复 / 从未镜像过）记入警告提示用户重填。尽力而为：失败仅警告，不影响导入结论。
    try {
      const vaultDataDir = path.join(this.ctx.homeDir, 'dsh-config-manager');
      const vault = await restoreVaultFiles(this.ctx.fs, vaultDataDir, this.ctx.homeDir, DEFAULT_SENSITIVE_RELS);
      for (const rel of vault.restored) warnings.push(this.msg('import.vaultRestored', { rel }));
      // issue #39：includeSecrets=true 时凭据走包内密文、**不**镜像明文 vault（见 exporter 4b），
      // 目标机 vault 必然为空。值已随包回填（plan 里全部 ref 被 decryptedCredentials 满足）时
      // 再提示「跨机恢复需人工重填」纯属误导 —— 换成如实说明。只有确实还缺 ref 时才保留原提示。
      const satisfiedByArchive = credentialsRestored > 0 && missingSecrets.length === 0;
      if (satisfiedByArchive && vault.missing.length > 0) {
        warnings.push(this.msg('import.vaultCredentialsFromArchive', {
          count: String(credentialsRestored),
          rel: vault.missing.join(', '),
        }));
      } else {
        for (const rel of vault.missing) warnings.push(this.msg('import.vaultMissing', { rel }));
      }
      for (const s of vault.skipped) {
        // targetExists = 目标已有更新的凭据，属预期跳过，不打扰用户
        if (s.reason !== 'targetExists') warnings.push(this.msg('import.vaultBackfillFailed', { rel: s.rel, reason: s.reason }));
      }
    } catch (err) {
      warnings.push(this.msg('import.vaultBackfillFailed', { rel: DEFAULT_SENSITIVE_RELS.join(', '), reason: err instanceof Error ? err.message : String(err) }));
    }

    return {
      // 单项失败已如实记录在 executed；无未捕获异常即完成。
      // 保留分支恒 ok:false —— 这笔导入**没有完成**，只是用户选择了留下已应用部分。
      ok: !keptPartial,
      executed,
      needsRestart,
      missingSecrets,
      warnings,
      rollback: null,
      snapshotId: snapshot.id,
      skippedTombstoned: plan.skippedTombstoned ?? [],
      // issue #39 Feature 3：字段只增不改；未经归档恢复时省略（旧行为逐字节不变）
      ...(credentialsRestored > 0 ? { credentialsRestored } : {}),
      // 终止语义（字段只增不改）：保留分支额外带上启动自洽审计结论；未审计时**不出现**该字段
      ...(keptPartial ? { cancelled: true, keptPartial: true } : {}),
      ...(keptPartial && bootSafety !== null ? { bootSafety } : {}),
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

  /**
   * 逆序补偿 + 诚实报告（两条触发路径共用：导入失败整体回滚 / 用户终止并选择回滚）。
   *
   * 审计 P0-3：必须把「已就地回滚」的结论上报给 journal 宿主（runJournaled）——
   * 没有这条上报，宿主只能凭「fn 是否返回」推断成功，而这里是「回滚完成 + 正常返回
   * ok:false」，于是整笔 operation 被误记成 COMMITTED 终态（回滚点失去 prune 豁免、
   * 事后审计读到与盘面相反的结论）。可选调用：非 journaled 路径不传 snapshotBinding。
   */
  private async rollbackApplied(
    snapshot: Snapshot,
    executed: ExecutedItem[],
    warnings: string[],
    plan: ImportPlan,
    binding: TransactionSnapshotContext | undefined,
    cause: 'failed' | 'cancelled',
  ): Promise<ImportResult> {
    const rollbackReport = await rollback({
      ctx: this.ctx,
      snapshot,
      store: this.snapshotStore,
      adapters: this.adapters,
    });
    await reportRollbackToJournal(binding, {
      full: rollbackReport.full,
      failed: rollbackReport.failed.map((f) => f.item),
    });
    // M1：回滚完成 → 快照标记 rolled-back（元数据写失败只告警，不影响回滚结论）
    await this.markSnapshotStatus(snapshot.id, 'rolled-back');
    this.ctx.log.warn(
      cause === 'cancelled'
        ? `导入被用户终止，已回滚（${rollbackReport.full ? '完整' : '部分'}）`
        : `导入失败，已回滚（${rollbackReport.full ? '完整' : '部分'}）`,
      { failed: executed.filter((e) => e.status === 'failed').map((e) => e.itemId) },
    );
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

  /* -------------------------------------------------- P2-B 逐计划项指纹（Phase 8） */

  /**
   * 该计划项是否会产生真实 side effect（需 journal step 追踪）。
   * 与「会写目标」同一谓词（backup.planItemWritesTarget 单点）——信息/跳过/错误项与
   * 未采用其导入内容的 Conflict 都不写目标，记录只会保守化 reconcile 而无收益。
   */
  private shouldJournalStep(item: PlanItem): boolean {
    return planItemWritesTarget(item);
  }

  /** 文件类且可指纹 → 返回 home-relative 目标路径（posix）；否则 null（不可指纹外部项）。
   *  profile 必须传入：plugins 分区的 pnpm-workspace.yaml / patch 文件位于
   *  `profiles/<profile>/` 下，缺了它算出的相对路径不存在 → 指纹恒 null（issue #35）。 */
  private static fileRelFor(item: PlanItem, profile?: string): string | null {
    if (!isFileSection(item.adapter)) return null;
    const ref = item.target?.ref;
    if (ref === undefined || ref === '') return null;
    return resolveFileTargetRel(item.adapter, ref, profile);
  }

  /** 读目标文件算 sha256（home-relative；经 HostContext.fs 使测试 mock 可注入）。失败返回 null。 */
  private async fileFp(ctx: ImportContext, rel: string): Promise<string | null> {
    try {
      const data = await ctx.target.fs.readFile(rel);
      return sha256Hex(data);
    } catch {
      return null;
    }
  }

  private async applyOne(
    adapter: ConfigAdapter,
    item: PlanItem,
    ctx: ImportContext,
  ): Promise<{ executed: ExecutedItem; needsRestart: boolean; warning?: string }> {
    // 执行日志（导入面板展示）：仅非敏感文本（项 id / 命令），绝不写密钥/密码/补录值
    const onLog = ctx.onLog;
    if (item.kind === 'Error') {
      // 硬失败项：如实记 failed，不调用 applyItem（也不写目标）
      onLog?.(`✗ ${item.id}`);
      return { executed: { itemId: item.id, status: 'failed', message: item.detail ?? item.description }, needsRestart: false };
    }
    // 会不会写目标由 backup.planItemWritesTarget 单点决定（与快照范围同源，见该函数文档）：
    // Skip / Warning / MissingDependency 是信息项；未采纳（keepCurrent / review / 未决策）的
    // Conflict 不写；MissingSecret 无值时不写 —— 三类一律不调用 applyItem。
    // 补录值只经 adapter.applyItem 写入（m5 实现），引擎不直接触碰凭据。
    const secretRef = item.kind === 'MissingSecret' ? item.id.replace(/^secret:/, '') : null;
    const writesTarget = planItemWritesTarget(item, {
      secretValueAvailable: (ref) => {
        const value = ctx.decryptedCredentials?.get(ref) ?? ctx.secretInputs[ref];
        return value !== undefined && value !== '';
      },
    });
    if (!writesTarget) {
      onLog?.(`– ${item.id}`);
      return {
        executed: {
          itemId: item.id,
          status: 'skipped',
          ...(secretRef !== null ? { message: this.msg('import.secretNotProvided') } : {}),
        },
        needsRestart: false,
      };
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

/* ---------------- journal 结果上报（引擎 → 宿主） ---------------- */

/**
 * 引擎向 journal 宿主上报「已就地回滚」的最小面。
 *
 * 刻意在本文件内声明结构等价的最小类型，而不给 `core/types.ts` 的 TransactionSnapshotContext
 * 增字段：该契约文件属并行会话的改动范围（t16 的 out of scope），且这只是**可选**上报 ——
 * 非 journaled 调用方（CLI/测试）不传 snapshotBinding，行为逐字节不变。
 * 实现侧见 `core/phase3-host.ts` 的 JournalRunContext.recordRollback（绝不抛错）。
 */
type RollbackReportingBinding = TransactionSnapshotContext & {
  recordRollback?: (report: { full: boolean; failed: readonly string[] }) => Promise<void>;
};

async function reportRollbackToJournal(
  binding: TransactionSnapshotContext | undefined,
  report: { full: boolean; failed: readonly string[] },
): Promise<void> {
  const reporter = binding as RollbackReportingBinding | undefined;
  await reporter?.recordRollback?.(report);
}

/* ---------------- 纯函数辅助 ---------------- */

/**
 * G-06：执行 schema 迁移链并把迁移结果重新校验为合法 manifest。
 *
 * `migrateToCurrent` 此前在 `src/` 内零引用（迁移链有定义、有单测、从不执行）；
 * `loadBundle` 只用 isSupported 做判定就直接把旧文档当新格式使用。本函数是迁移链的
 * **真实接线点**：沿链迁移 → 重新校验结果是合法 manifest（不合法则抛明确错误，
 * 绝不把半迁移文档当合法 manifest 继续）→ 每个已应用步骤翻译成用户可见告警。
 *
 * 显式传入 from/target 使「链式迁移真的被执行」可被直接单测：当前
 * `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，`needsMigration` 恒假，
 * 因此该分支在真实导入中结构上不可达（loadBundle 仍按 needsMigration 调用本函数）。
 */
export function runSchemaMigration(
  doc: unknown,
  fromVersion: number,
  targetVersion: number,
  msg: MsgFunc,
): { manifest: Manifest; warnings: string[] } {
  const result = migrateToCurrent(doc, fromVersion, targetVersion);
  const issues = validateManifest(result.doc).filter((i) => i.severity === 'error');
  if (issues.length > 0) {
    throw new Error(msg('import.migrateInvalidManifest', { issues: issues.map((i) => i.message).join('; ') }));
  }
  return {
    manifest: result.doc as Manifest,
    warnings: result.applied.map((step) => msg('import.migrated', { from: String(step.from), to: String(step.to) })),
  };
}

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

/**
 * 基础路径重定基规则：导出机 DSH home → 本机 DSH home（issue #45 用户补充）。
 *
 * 只在「两边的规范化路径都是绝对路径、且不相同」时生成；两侧都去掉尾部分隔符后比较，
 * 避免 /opt/.dsh/ 与 /opt/.dsh 被判成不同而白跑一次全量替换。前缀匹配仍由 applyPrefixMappings
 * 负责（必须落在段边界），所以 /opt/.dsh 不会误伤 /opt/.dsh-extra。
 *
 * @returns 映射规则；不需要重定基（缺 sourceHome / 相同 / 相对路径）→ undefined
 */
export function rebaseMapping(sourceHome: string | undefined, localHome: string): PathMapping | undefined {
  if (sourceHome === undefined || sourceHome === '') return undefined;
  const strip = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const from = strip(sourceHome);
  const to = strip(localHome ?? '');
  if (from === '' || to === '' || from === to) return undefined;
  const isAbsolute = (value: string): boolean => value.startsWith('/') || /^[a-zA-Z]:[\/]/.test(value);
  if (!isAbsolute(from) || !isAbsolute(to)) return undefined;
  return { oldPrefix: from, newPrefix: to, appliesTo: [] };
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

/**
 * 把映射应用到分区数据（PathMapper 先行：只替换匹配前缀的字符串叶值）。
 *
 * `fileCollectionIds` 里的分区一律跳过：`FileCollectionAdapter` 把 `relativePath` 当落盘路径用，
 * 它必须逐字保留（issue #45 ④：改写会话文件的相对路径会让目标机下次启动直接报
 * `corrupt session log`；pluginFiles/skills 等同理——丢位置等于丢归属）。
 * 映射在这些分区上**没有任何合法作用**：文件内容存的是字节（`Uint8Array` 叶子），不会被改。
 */
export function applyMappingsToSections(
  sections: Map<SectionId, unknown>,
  mappings: PathMapping[],
  fileCollectionIds: ReadonlySet<string> = new Set(),
): void {
  if (mappings.length === 0) return;
  for (const [sectionId, data] of sections) {
    if (fileCollectionIds.has(sectionId)) continue;
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

/**
 * 凭据计划项（MissingSecret / Skip）在**导入路径**上的唯一生成点。
 *
 * ref 来源取**并集**：① credentialsStatus 里 configured=true 的 ref（源机声明「有」，
 * 但普通备份不带值）；② 宿主解密出的归档 ref（`opts.decryptedCredentials`）——
 * 加密备份携带的是 `.credentials.yaml` **原文**，可能含未被任何 settings namespace 引用的 ref
 * （如其它插件自用的 key），只认 ① 会让这些值静默丢掉（真机反馈：导入密钥没生效）。
 *
 * 规则（与同步侧 sync-engine.appendCredentialPlanItems 同口径：**值的有无**优先于本机状态）：
 *  - **有值** → MissingSecret「随加密备份恢复」：用户显式勾了「导出密钥」，导入即写回；
 *    **不因本机已有而跳过**（跳过 = 用户以为密钥导入了、其实没写）。
 *  - **无值**（只有 ref 名）→ 本机已配置 → Skip（保留本机值、不再索要补录，用户报告
 *    「已有的重复密钥也会提示」）；本机没有 → MissingSecret「需要补录」。
 *
 * 凭据值不可回读，因此无值分支一律不覆盖本机已有值。
 *
 * @param decrypted 归档里解出的 ref→值（仅内存；undefined = 未提供密码/无凭据载荷）
 * @param isConfiguredLocally 目标机是否已配置该 ref（读不到 → false，保守按需补录处理）
 */
async function buildCredentialPlanItems(
  items: PlanItem[],
  sections: Map<SectionId, unknown>,
  decrypted: Map<string, string> | undefined,
  msg: MsgFunc,
  isConfiguredLocally: (ref: string) => Promise<boolean>,
): Promise<void> {
  const creds = sections.get('credentialsStatus') as { credentials?: { ref?: string; configured?: boolean }[] } | undefined;
  const declared: string[] = [];
  for (const c of creds?.credentials ?? []) {
    if (typeof c.ref === 'string' && c.ref !== '' && c.configured === true) declared.push(c.ref);
  }
  const refs = [...new Set([...declared, ...(decrypted?.keys() ?? [])])];
  const existing = new Set(items.map((i) => i.id));
  for (const ref of refs) {
    const id = `secret:${ref}`;
    if (existing.has(id)) continue;
    existing.add(id);
    const target = { adapter: 'credentialsStatus' as const, ref };
    if (decrypted?.has(ref) === true) {
      items.push({
        id,
        kind: 'MissingSecret',
        adapter: 'credentialsStatus',
        description: msg('import.secretFromArchive', { ref }),
        severity: 'warning',
        target,
      });
      continue;
    }
    if (await isConfiguredLocally(ref)) {
      items.push({
        id,
        kind: 'Skip',
        adapter: 'credentialsStatus',
        description: msg('import.secretAlreadyConfigured', { ref }),
        severity: 'info',
        target,
      });
      continue;
    }
    items.push({
      id,
      kind: 'MissingSecret',
      adapter: 'credentialsStatus',
      description: msg('import.secretMissingDesc', { ref }),
      severity: 'warning',
      target,
    });
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
