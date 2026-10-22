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
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../schema/manifest.ts';
import {
  CURRENT_SCHEMA_VERSION, canImport, describeVersion, isSupported, isTooNew, needsMigration,
} from '../schema/versions.ts';
import { parseZip, type ZipArchive, type ZipSafetyLimits } from '../utils/zip.ts';
import type { BootSafetyReport } from './boot-safety.ts';
import type { FilesSection, Manifest, SectionId } from '../schema/types.ts';
import { loadTombstones } from '../schema/tombstones.ts';
import { DEFAULT_SENSITIVE_RELS, restoreVaultFiles } from '../security/vault.ts';
import { createSnapshot, fsForSection, planItemWritesTarget, resolveFileTarget, resolveFileTargetRel } from './backup.ts';
import { isCredentialConfigured } from './credential-status.ts';
import { rollback } from './rollback.ts';
import { compatibilityReasons, computeCompatibility } from './validator.ts';
import { msgOf } from './messages.ts';
import { applyItemResolution } from './conflict-decisions.ts';
import type { MsgFunc } from './messages.ts';
import {
  ImportNotConfirmedError, ImportUserSkippedError, type ApplyResult, type ConfigAdapter,
  type ExecutedItem, type HostContext, type ImportAnalysis, type ImportContext,
  type ImportDecisions, type ImportPlan, type ImportResult,
  type FileSystemFacade, type PlanItem, type SessionFormatProbeResult, type TransactionSnapshotContext,
  type Snapshot, type SnapshotStore,
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

/** 文件分区「ZIP 前缀 → 分区 id」（t14 / core-F3 反向核对用；长前缀优先，避免前缀重叠误判）。 */
const FILE_SECTION_PREFIX_ENTRIES: readonly (readonly [SectionId, string])[] = (
  Object.entries(SECTION_FILE_PREFIXES) as [SectionId, string][]
).slice().sort((a, b) => b[1].length - a[1].length);

/**
 * JSON 分区「ZIP 内路径 → 分区 id」（t41 / R1 反向核对用；只取确有 JSON 载荷的分区）。
 *
 * 与 FILE_SECTION_PREFIX_ENTRIES 是**两个互不相交的命名空间**：文件分区走前缀匹配
 * （custom/skills/…），JSON 分区走**整条路径精确命中**（config/settings.json、custom/prompts.json…），
 * 因此扩核不会把文件条目误判成 JSON 载荷（t16 的 check-prefix-overlap.mjs 已静态证实零重叠）。
 */
const JSON_SECTION_PATH_ENTRIES: readonly (readonly [SectionId, string])[] = Object.entries(
  SECTION_JSON_PATHS as Record<string, string | undefined>,
)
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
  .map(([id, jsonPath]) => [id as SectionId, jsonPath] as const);

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
  /**
   * 会话格式探针（宿主注入；**core 不解析 DSH 存储格式**，只消费探针结果）。
   *
   * 缺省 = 不做会话格式体检（旧调用方零改动）。
   */
  sessionFormatProbe?: (files: readonly { relativePath: string; data: Uint8Array }[]) => SessionFormatProbeResult;
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

/** 会话格式体检的「已落定」结果（探针 + 本机支持版本；不可判定时整体缺省）。 */
interface ResolvedSessionFormats {
  target: number;
  unreadable: { unitId: string; version: number }[];
  /** 本次体检真正看过的会话条数（解出 header 的 + 解不出的） */
  examined: number;
  /** 因抽样上限未检查的会话条数 */
  skipped: number;
}

interface AnalyzedBundle extends Bundle {
  sections: Map<SectionId, unknown>;
  unsupportedSections: string[];
  unsupportedVersions: { section: SectionId; version: number }[];
  sectionWarnings: string[];
  /** 只算一次：分析、计划项标记、ImportAnalysis 三方共用同一份结果 */
  sessionFormats: ResolvedSessionFormats | null;
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

/**
 * 已验证归档的**进程内**缓存（跨请求共享）。
 *
 * 为什么必须跨请求：宿主每次请求都新建 Importer/Analyzer（`makeImporter()`，见 src/index.ts
 * 与 src/routes/*.ts），于是实例级 `bundleCache` 在两个请求之间永远命中不了 —— 一次导入向导
 * （analyze → plan → execute，且每改一次决策还会再 plan）会把同一个 ZIP 完整读入 + 全量解压
 * + 逐条 SHA-256 校验 3~4 次（实测单次全量解压 108 ms / 29 MiB 归档，全程阻塞事件循环）。
 *
 * 安全边界（不许放宽）：
 *  - 缓存键 = **绝对路径 + 文件大小 + mtimeMs**；文件被改写（大小或时间变了）→ 自动重新校验；
 *  - **只有只读入口**（`analyzeImport` / `createImportPlan`）会**读**它；`executeImportPlan`
 *    （真正写盘的那一步）一律 `refresh`：每次执行前重新读盘 + 重新校验，关掉「校验通过之后、
 *    写盘之前文件被换掉」的 TOCTOU 窗口；
 *  - 只缓存 ≤ 64 MiB 的归档：Bundle 持有整个 ZIP 缓冲，不能让进程为两个大包常驻几百 MB。
 */
const verifiedBundles = new Map<string, { stamp: string; bundle: Bundle; at: number }>();
const VERIFIED_CACHE_MAX_ENTRIES = 2;
const VERIFIED_CACHE_TTL_MS = 120_000;
const VERIFIED_CACHE_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** 清空已验证归档缓存（测试用；宿主在「归档被本插件自己改写」等场景也可调用）。 */
export function clearVerifiedBundleCache(): void {
  verifiedBundles.clear();
}

/** 归档身份（大小 + mtime）；stat 失败 → null = 本次不参与缓存（绝不凭路径猜）。 */
async function archiveStamp(zipPath: string): Promise<{ stamp: string; size: number } | null> {
  try {
    const st = await fs.stat(zipPath);
    return { stamp: `${st.size}|${st.mtimeMs}`, size: st.size };
  } catch {
    return null;
  }
}

/** 过期即删；超过条目上限时淘汰最旧的（按写入时刻）。 */
function pruneVerifiedBundles(): void {
  const now = Date.now();
  for (const [key, entry] of verifiedBundles) {
    if (now - entry.at > VERIFIED_CACHE_TTL_MS) verifiedBundles.delete(key);
  }
  while (verifiedBundles.size > VERIFIED_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of verifiedBundles) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    verifiedBundles.delete(oldestKey);
  }
}

export class Analyzer {
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly snapshotStore: SnapshotStore;
  private readonly limits?: ZipSafetyLimits;
  private readonly dependencyChecker?: (command: string) => Promise<boolean>;
  private readonly parseZipFn: (buf: Uint8Array, limits?: ZipSafetyLimits) => ZipArchive;
  private readonly msg: MsgFunc;
  private readonly sessionFormatProbe?: (files: readonly { relativePath: string; data: Uint8Array }[]) => SessionFormatProbeResult;
  /**
   * 会话内 bundle 缓存（zipPath → { 身份, 解析结果 }）。
   *
   * t14 / core-F1 修：与跨请求 `verifiedBundles` **共用同一套硬边界** ——
   *  - `refresh`（写盘入口）一律不看它；
   *  - `reuse` 命中也必须身份（大小 + mtimeMs）一致；stat 读不到就不命中（宁可多读）。
   * 修前它只按路径命中且位于身份判定之前，于是**同一个 Importer 实例**上 plan → execute
   * （sync-engine.applyMergePlan 的生产形态）会拿陈旧结果去改用户数据，refresh 语义在门面上不成立。
   */
  private readonly bundleCache = new Map<string, { stamp: string; bundle: Bundle }>();

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
    this.sessionFormatProbe = opts.sessionFormatProbe;
  }

  /* ---------------- 第 1-6 步：ZIP 读入 → 安全解析 → manifest → 完整性 → schema ---------------- */

  /**
   * 读入 + 校验归档。
   *
   * @param mode `reuse` = 只读入口（analyze / plan）：同一份归档（路径 + 大小 + mtime 全同）
   *   可以复用**已校验**的结果；`refresh` = 写盘入口（execute）：一律重新读盘 + 重新校验，
   *   不给「校验后文件被换掉」留窗口。
   */
  private async loadBundle(zipPath: string, mode: 'reuse' | 'refresh'): Promise<Bundle> {
    // 身份判定先行：实例缓存与跨请求缓存**共用同一把钥匙**（路径 + 大小 + mtimeMs）。
    const identity = await archiveStamp(zipPath);
    // t14 / core-F1：写盘入口（refresh）一律不看任何缓存 —— 同实例 plan → execute
    // （sync-engine.applyMergePlan）也必须关掉「校验后被换包」的窗口。
    // 只读入口（reuse）命中也必须身份一致；stat 读不到（被删/不可读）不命中任何缓存，
    // 让下面的 fs.readFile 给出它自己的精确错误。
    if (mode === 'reuse' && identity !== null) {
      const cached = this.bundleCache.get(zipPath);
      if (cached !== undefined && cached.stamp === identity.stamp) return cached.bundle;
      const hit = verifiedBundles.get(zipPath);
      if (hit !== undefined && hit.stamp === identity.stamp && Date.now() - hit.at <= VERIFIED_CACHE_TTL_MS) {
        this.bundleCache.set(zipPath, { stamp: identity.stamp, bundle: hit.bundle });
        return hit.bundle;
      }
    }

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
          // 异步解压：这是全仓**唯一**逐条解压全部条目的地方，`inflateRawSync` 会整段阻塞
          // 事件循环（实测 29 MiB 归档 108 ms，大备份就是几秒的界面冻结）。判据与同步版逐字相同。
          entries.set(name, await archive.readEntryAsync(name));
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
    // 身份读得到才入实例缓存（与跨请求缓存同一判据：不拿未知身份签结果）。
    if (identity !== null) this.bundleCache.set(zipPath, { stamp: identity.stamp, bundle });
    // 写入跨请求缓存：execute（refresh）也写 —— 它刚做过完整校验，这份结果对后续只读入口同样有效。
    if (identity !== null && identity.size <= VERIFIED_CACHE_MAX_ARCHIVE_BYTES) {
      verifiedBundles.set(zipPath, { stamp: identity.stamp, bundle, at: Date.now() });
      pruneVerifiedBundles();
    }
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
    // t14 / core-F3：反向核对 —— 包内**实际带着**某个文件分区的条目、而 manifest.sections 没把它
    // 声明为包含时，这些条目会被整段忽略。修前只按清单迭代，「包里有内容却没人说」= 静默忽略，
    // 用户以为备份内容都导进去了。与 extraEntries（未登记进校验表）同风格：告警可见、不阻断导入。
    const declaredFileSections = new Set<string>();
    const declaredJsonSections = new Set<string>();
    for (const [sectionId, on] of Object.entries(manifest.sections) as [string, boolean][]) {
      if (!on) continue;
      if (SECTION_FILE_PREFIXES[sectionId as SectionId] !== undefined) declaredFileSections.add(sectionId);
      if (SECTION_JSON_PATHS[sectionId as SectionId] !== undefined) declaredJsonSections.add(sectionId);
    }
    const undeclaredContent = new Map<SectionId, string[]>();
    for (const name of archive.names()) {
      if (name === '' || name.endsWith('/')) continue; // 目录标记条目不算内容
      const hit = FILE_SECTION_PREFIX_ENTRIES.find(
        ([id, prefix]) => !declaredFileSections.has(id) && name.startsWith(prefix),
      );
      if (hit === undefined) continue;
      const sample = undeclaredContent.get(hit[0]) ?? [];
      if (sample.length < 3) sample.push(name); // 每条分区最多列 3 个示例条目，避免超长告警
      undeclaredContent.set(hit[0], sample);
    }
    // t41 / R1：**JSON 载荷**方向同样要反向核对。修前只闭了「文件分区」半边，于是
    // custom/prompts.json（prompts=false）、config/settings.json（settings=false）这类包
    // 既不导入也零告警 —— 与文件条目同一条「包里有内容却没人说」的静默忽略路径。
    // JSON 路径按**整条命中**判定（archive.has），与文件前缀匹配互不干扰。
    for (const [sectionId, jsonPath] of JSON_SECTION_PATH_ENTRIES) {
      if (declaredJsonSections.has(sectionId)) continue; // 已声明 → 不冤枉
      if (!archive.has(jsonPath)) continue; // 包内没有该载荷 → 不误报
      const sample = undeclaredContent.get(sectionId) ?? [];
      if (sample.length < 3) sample.push(jsonPath);
      undeclaredContent.set(sectionId, sample);
    }
    if (undeclaredContent.size > 0) {
      const ids = [...undeclaredContent.keys()];
      warnings.push(this.msg('import.undeclaredSectionContent', {
        sections: ids.join(', '),
        entries: ids.flatMap((id) => undeclaredContent.get(id) ?? []).map((name) => '"' + name + '"').join(', '),
      }));
    }
    // 未知分区汇总告警（放在版本告警之后：一条消息列出全部被跳过的未知分区）
    if (unsupportedSections.length > 0) {
      warnings.push(this.msg('import.unsupportedSections', { sections: unsupportedSections.join(', ') }));
    }
    return { sections, unsupportedSections, unsupportedVersions, warnings };
  }

  /**
   * 会话格式体检（宿主探针 + 本机支持的版本）—— **每份归档只跑一次**，结果供三方共用：
   * 分析告警、计划项标记（`formatUnsupported`）、ImportAnalysis 摘要。
   *
   * 为什么必须在导入前说：DSH 读会话时对**非本 build 的格式版本直接拒绝**，而会话列表
   * （`listArtifacts()`）对这种会话是**静默 continue** 的 —— 不报错、不显示，用户只会看到
   * 「对话没了」。高版本能读低版本（DSH 自带 V0→V4 迁移链），反向不可读，所以只对
   * 「包里的版本 > 本机支持的版本」告警；本机版本解析不到时**不猜**（宁可不报，也不谎报兼容）。
   *
   * 不可判定（无探针 / 无 sessions / 本机版本解析不到 / 探针抛错）一律返回 null。
   */
  private resolveSessionFormats(sections: Map<SectionId, unknown>): ResolvedSessionFormats | null {
    const probe = this.sessionFormatProbe;
    if (probe === undefined || !sections.has('sessions')) return null;
    const target = this.ctx.sessionFormatVersion;
    if (target === undefined) return null;
    const rows = (sections.get('sessions') as { files?: unknown } | undefined)?.files;
    if (!Array.isArray(rows)) return null;
    const files: { relativePath: string; data: Uint8Array }[] = [];
    for (const row of rows) {
      const item = row as { relativePath?: unknown; data?: unknown };
      if (typeof item.relativePath === 'string' && item.data instanceof Uint8Array) {
        files.push({ relativePath: item.relativePath, data: item.data });
      }
    }
    try {
      const probed = probe(files);
      // 只有明确「版本更高」才算读不了；units 缺省（旧探针实现）时退化为空数组（不猜单元）。
      return {
        target,
        unreadable: (probed.units ?? []).filter((unit) => unit.version > target),
        examined: probed.sampled + probed.unreadable,
        skipped: probed.skipped,
      };
    } catch {
      // 体检失败绝不拖垮分析，也绝不因此宣称兼容（本条静默，另有导出报告可核对）。
      return null;
    }
  }

  private sessionFormatWarnings(result: ResolvedSessionFormats | null): string[] {
    if (result === null) return [];
    const target = result.target;
    const newer = result.unreadable.map((unit) => unit.version);
    if (newer.length === 0) return [];
    const warnings = [this.msg('import.sessionsFormatUnsupported', {
      count: String(newer.length),
      newer: String(Math.max(...newer)),
      target: String(target),
    })];
    if (result.skipped > 0) {
      warnings.push(this.msg('import.sessionsFormatSampled', {
        sampled: String(result.examined),
        skipped: String(result.skipped),
      }));
    }
    return warnings;
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

    // 会话格式体检只跑一次：告警、计划项标记、ImportAnalysis 摘要共用（探针要解首帧，别重复跑）。
    const sessionFormats = this.resolveSessionFormats(sections);

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
        ...this.sessionFormatWarnings(sessionFormats),
      ],
      sessionFormats,
      adapterItems,
      adapterIssues,
    };
  }

  /**
   * e2e-F1 的第二道门（**不得放宽**）：归档声明携带凭据值（`containsSecrets=true` —— 导出侧只在
   * 凭据原文非空时才置位，见 exporter.ts:449）却一条 ref 都解不出来时，必须显式告警：
   * 「读不到 ≠ 没有凭据」。没给密码的情形由安全阀拒绝（`import.encryptedPasswordRequired`），不重复告警。
   */
  private secretsPayloadWarnings(manifest: Manifest, decrypted: Map<string, string> | undefined): string[] {
    if (manifest.security.containsSecrets !== true) return [];
    if (decrypted === undefined || decrypted.size > 0) return [];
    return [this.msg('import.secretsPayloadEmpty')];
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
    const bundle = await this.loadBundle(zipPath, 'reuse');
    const { manifest, zipWarnings } = bundle;
    const analyzed = await this.analyzeBundle(bundle);

    const errors = [...analyzed.adapterIssues];
    const warnings = [...zipWarnings, ...bundle.migrationWarnings, ...analyzed.sectionWarnings];
    warnings.push(...this.secretsPayloadWarnings(manifest, opts.decryptedCredentials));
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
    // 评分与「为什么是这个评分」出自同一份输入：compatibility 由 compatibilityReasons 派生
    // （见 validator.computeCompatibility），这里把两侧都回传，界面据此解释而不是猜。
    const compatibilityInput = {
      sourceDsh: manifest.source.dshVersion,
      targetDsh: this.ctx.dshVersion,
      sourcePlatform: manifest.source.platform,
      targetPlatform: this.ctx.platform,
      schemaVersion: manifest.schemaVersion,
      missingSections,
    };
    const compatibility = computeCompatibility(compatibilityInput);
    const compatReasons = compatibilityReasons(compatibilityInput);

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
      compatibilityReasons: compatReasons,
      source: {
        dshVersion: manifest.source.dshVersion,
        platform: manifest.source.platform,
        schemaVersion: manifest.schemaVersion,
      },
      target: { dshVersion: this.ctx.dshVersion, platform: this.ctx.platform },
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
      // 会话格式体检摘要（不可判定时缺省，UI 不得据此宣称兼容）。
      ...(analyzed.sessionFormats !== null
        ? {
            sessionFormats: {
              target: analyzed.sessionFormats.target,
              unreadable: analyzed.sessionFormats.unreadable,
              sampled: analyzed.sessionFormats.examined,
              skipped: analyzed.sessionFormats.skipped,
            },
          }
        : {}),
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
    const bundle = await this.loadBundle(zipPath, 'reuse');
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

    // 会话格式处置的落点：把「本机读不了」标到**具体计划项**上（unitId = projectKey/会话目录）。
    // 标记是纯附加字段：不拦执行、不改变 kind/conflict —— 决策权交给 UI（中止 / 跳过 / 引导升级）。
    const formats = analyzed.sessionFormats;
    if (formats !== null && formats.unreadable.length > 0) {
      const byUnit = new Map(formats.unreadable.map((unit) => [unit.unitId, unit.version]));
      for (const item of planItems) {
        // 键空间对齐的两个形态：探针的单元键来自分区内的相对路径（`projectKey/会话目录`），
        // 而计划项（file-collection）的 unitId 带适配器前缀（`sessions:projectKey/会话目录`）。
        // 只用其中一种会**静默失配**（真机：探针报 v4、计划项一条都不带标记），两种都试。
        const version = sessionUnitVersion(byUnit, item.unitId ?? item.id);
        if (version !== undefined) {
          item.formatUnsupported = { version, target: formats.target };
          // severity 只是展示语义（写盘项标 warning；Skip/Warning 等诊断项保持原样），
          // 让同步确认页/报告把它显式标成「这条会被 DSH 跳过」，而不是与普通项混在一起。
          if (item.kind === 'Create' || item.kind === 'Update' || item.kind === 'Conflict') item.severity = 'warning';
        }
      }
    }

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
    // 写盘入口一律 refresh：**不复用**跨请求缓存，绝不能拿「几分钟前校验过」的结果去改用户数据
    // （校验通过之后、真正写盘之前归档被换掉，是这条路径必须自己关掉的窗口）。
    const bundle = await this.loadBundle(zipPath, 'refresh');
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
          beforeFp = await this.fileFp(importCtx, item);
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
    warnings.push(...this.secretsPayloadWarnings(bundle.manifest, opts.decryptedCredentials));
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
            afterFp = await this.fileFp(importCtx, item);
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
          // 分区收尾也能宣布「需要重启」（会话写入即属此类：DSH 的会话列表在启动期读取，
          // 不重启就看不到新导入的对话）。此前该字段只在逐项结果里被消费，收尾结果里的
          // needsRestart 会被静默丢掉 —— 用户拿不到这条必需提示。
          if (result.needsRestart === true) needsRestart = true;
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
    // t14 / core-F2：与计划期、执行期共用同一个「值可用」判据（非空字符串）。修前用 Map.has()
    // 会把「值为空串」算成已满足：没写进去的凭据既不报缺失，还被计入「从归档恢复」条数。
    const missingSecrets = plan.missingSecrets
      .filter((s) => !usableSecretValue(importCtx.decryptedCredentials, importCtx.secretInputs, s.ref))
      .map((s) => s.ref);
    // issue #39：从**加密归档内**解出并回填的条数（用户手工补录不计入）。只回传条数。
    const credentialsRestored = plan.missingSecrets
      .filter((s) => usableSecretValue(importCtx.decryptedCredentials, undefined, s.ref))
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

    // issue #56 第二条线：把「未生效项」（status='warning'）从 warnings 里**结构化**出来。
    // warning 是刻意的非致命语义（不触发回滚、不让 ok 变 false），但上层必须能说清
    // 「这次哪些步骤没生效」——真机：插件安装失败（warning）排在凭据写入之前且中断了它，
    // 用户看到的却是「同步完成」。
    const ineffective = executed
      .filter((e) => e.status === 'warning')
      .map((e) => ({
        itemId: e.itemId,
        adapter: e.itemId.split(':')[0] ?? e.itemId,
        ...(e.message === undefined ? {} : { message: e.message }),
      }));

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
      // 字段只增不改：没有未生效项时**不出现**（旧行为逐字节不变）
      ...(ineffective.length > 0 ? { ineffective } : {}),
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

  /** 文件类且可指纹 → 返回「根相对路径」（journal 的 ref 身份）；否则 null（不可指纹外部项）。
   *  profile 必须传入：plugins 分区的 pnpm-workspace.yaml / patch 文件位于
   *  `profiles/<profile>/` 下，缺了它算出的相对路径不存在 → 指纹恒 null（issue #35）。 */
  private static fileRelFor(item: PlanItem, profile?: string): string | null {
    if (!isFileSection(item.adapter)) return null;
    const ref = item.target?.ref;
    if (ref === undefined || ref === '') return null;
    return resolveFileTargetRel(item.adapter, ref, profile);
  }

  /**
   * 文件类且可指纹 → 返回「该分区自己的门面 + 绝对路径」。
   *
   * 为什么不能只拿 home-relative 路径去读：`pluginData` / `pluginAssets` 的根是**系统 home**
   * （见 `core/backup.ts` 的 `fsForSection`），用 `ctx.fs` 读会落到 $DSH_HOME 下的错误位置
   * 或被越界守卫拦下 —— 指纹会静默变成「读不到」，reconcile 因此永远判不出是否已应用。
   * 宿主未提供该门面 / 路径不可解析 → null（保守：不可证明）。
   */
  private static fileTargetFor(
    ctx: ImportContext, item: PlanItem,
  ): { fs: FileSystemFacade; abs: string } | null {
    if (!isFileSection(item.adapter)) return null;
    const ref = item.target?.ref;
    if (ref === undefined || ref === '') return null;
    try {
      return { fs: fsForSection(ctx.target, item.adapter), abs: resolveFileTarget(ctx.target, item.adapter, ref) };
    } catch {
      return null;
    }
  }

  /** 读目标文件算 sha256（经该分区自己的门面，测试 mock 可注入）。失败返回 null。 */
  private async fileFp(ctx: ImportContext, item: PlanItem): Promise<string | null> {
    const target = Analyzer.fileTargetFor(ctx, item);
    if (target === null) return null;
    try {
      return sha256Hex(await target.fs.readFile(target.abs));
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
      secretValueAvailable: (ref) => usableSecretValue(ctx.decryptedCredentials, ctx.secretInputs, ref),
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

/* ---------------- 计划期纯函数（P4 拆分，已外提到 ./import-planning.ts） ---------------- */
// analyzer 只保留三段式引擎本体；路径重定基/映射、schema 迁移校验、逐路径 issue、凭据计划项、
// 墓碑过滤、journal 上报这些**纯计算**都搬去 `./import-planning.ts`（本文件 1824 → 约 1490 行）。
// 依赖方向单行：analyzer → import-planning，后者绝不 import 本文件（避免第二个入口环）。
import {
  applyMappingsToSections, applyTombstoneFilter, buildCredentialPlanItems, detectPathIssues,
  mergePathMappings, rebaseMapping, reportRollbackToJournal, runSchemaMigration, sessionUnitVersion,
  usableSecretValue, verifyAgainstTable,
} from './import-planning.ts';

// 对外导入面保持不变（core/index.ts 与既有测试按 './analyzer.ts' 取这三个名字）。
export { applyMappingsToSections, rebaseMapping, runSchemaMigration } from './import-planning.ts';
