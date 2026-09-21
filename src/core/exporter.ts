/**
 * Export 编排（规范 §1/§18/§21，设计 §4.4）：
 *   adapter 收集各分区 → Secret 过滤 → manifest → checksum → ZIP。
 *
 * 安全不变量：
 *  - Secret 值默认永不进入导出数据（结构化分区逐一过 SecretScanner）；
 *  - includeSecrets=true 必须注入 EncryptionProvider（m4 实现），否则拒绝导出；
 *  - 注入 EncryptionProvider 时备份标记为加密（encrypted=true）：includeSecrets=false
 *    时 secrets.enc 加密空内容占位，备份仍需要密码导入，但不含任何凭据值；
 *  - 加密密码/秘密值绝不写入 manifest 与日志。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE, EXPORTER_NAME } from '../schema/manifest.ts';
import { SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts';
import { DEFAULT_SENSITIVE_RELS, refreshVault } from '../security/vault.ts';
import { writeZip } from '../utils/zip.ts';
import { msgOf } from './messages.ts';
import { normalizeSessionLimit } from './session-select.ts';
import type { MsgFunc } from './messages.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type {
  ConfigAdapter, EncryptionProvider, ExportOptions, ExportReport,
  ExportSection, HostContext, SecretScanner, SensitiveHit,
} from './types.ts';

/** m1：每导出一个分区前的进度回调信息（Host 侧 run 状态更新用；section = adapter id） */
export interface SectionProgress {
  section: string;
  /** 当前分区序号（1 起） */
  index: number;
  /** 选中分区总数 */
  total: number;
}

export interface ExporterOptions {
  ctx: HostContext;
  adapters: ConfigAdapter[];
  /** Secret 扫描器；缺省用字段名黑名单剥离（m4 可注入强化版） */
  scanner?: SecretScanner;
  /** 加密提供者（m4 用 node:crypto 实现）；includeSecrets 时必填；提供时备份标记 encrypted=true */
  encryption?: EncryptionProvider | null;
  /** 插件自身版本（manifest.exporter.version） */
  exporterVersion?: string;
  now?: () => Date;
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
  /** m1：每导出一个分区前调用（真实进度埋点；不传则无埋点） */
  onSection?: (info: SectionProgress) => void;
  /**
   * 插件数据目录（文件级 vault 位于 <vaultDataDir>/vault，缺省 <homeDir>/dsh-config-manager）。
   * includeSecrets=false 时导出会自动刷新 vault；宿主自定义 dataDir 时应注入实际值
   * （HostContext 不携带 dataDir，故经选项注入）。
   */
  vaultDataDir?: string;
}

/** 缺省 SecretScanner：递归黑名单字段剥离（字段名大小写不敏感；二进制/Uint8Array 原样跳过） */
export function defaultSecretScanner(): SecretScanner {
  const SENSITIVE_FIELDS = [
    'password', 'passwd', 'token', 'accesstoken', 'refreshtoken', 'apikey',
    'secret', 'credential', 'authorization', 'cookie', 'privatekey', 'clientsecret',
  ];
  /** 仅存「引用名」而非值的字段（如 apiKeyEnv=DEEPSEEK_API_KEY 是环境变量名，不是秘密） */
  const REFERENCE_FIELDS = new Set([
    'apikeyenv', 'api_key_env', 'apikeyname', 'tokenenv', 'accesstokenenv',
    'refreshtokenenv', 'clientsecretenv', 'passwordenv',
  ]);
  return {
    scanAndRedact(data: unknown): { sanitized: unknown; hits: SensitiveHit[] } {
      const hits: SensitiveHit[] = [];
      const walk = (v: unknown, p: string): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (v instanceof Uint8Array) return v; // 二进制内容不按字段展开
        if (Array.isArray(v)) return v.map((item, i) => walk(item, `${p}[${i}]`));
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          const lower = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          const isRefName = REFERENCE_FIELDS.has(lower);
          const sensitive = !isRefName && SENSITIVE_FIELDS.some((f) => lower.includes(f));
          if (sensitive && typeof val === 'string' && val !== '') {
            hits.push({ path: p === '' ? k : `${p}.${k}`, field: k });
            out[k] = ''; // 值剥离为空串（保留字段名与位置，供「需补录」提示）
            continue;
          }
          out[k] = walk(val, p === '' ? k : `${p}.${k}`);
        }
        return out;
      };
      return { sanitized: walk(data, ''), hits };
    },
  };
}

/* ---------------- G-09：文件类分区文本级扫描（只报告，绝不改写） ---------------- */

/**
 * 单文件扫描字节上限（1 MiB）。超大文件只扫描前 1 MiB：
 * 凭据通常出现在配置/脚本的头部；超过上限的剩余部分放弃扫描，避免单个巨型文件拖垮导出。
 */
export const FILE_SECTION_SCAN_MAX_BYTES = 1024 * 1024;

/** 一次导出中所有文件类分区的累计扫描字节上限（16 MiB），防「成千上万小文件」拖慢导出 */
export const FILE_SECTION_SCAN_TOTAL_BUDGET_BYTES = 16 * 1024 * 1024;

/** 每个分区最多告警的**不同文件**数（不是 hit 条数）；命中仍全量计入 redactedHits（报告统计通道），超出部分由一条汇总告警兜底，避免「真有凭据的文件被静默淹没」或「截断即静默丢失」 */
export const MAX_FILE_SECTION_WARNINGS_PER_SECTION = 5;

/** 二进制探测窗口（前 4 KiB 出现 NUL 即视为二进制，不按文本扫描） */
const BINARY_SNIFF_BYTES = 4096;

/** 是否为二进制内容（含 NUL 字节 → 不是 UTF-8 文本；避免对二进制做无意义的文本扫描/误报） */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * 文件类分区内容扫描（G-09）：
 *  - 走注入 scanner 的 `scanText`（只报告不改写；`scanAndRedact` 会剥离值，**不得**用于用户文件）；
 *  - 扫描档位与 `src/market/prepare.ts` 的导出侧扫描保持一致：默认保守档 +
 *    值形状启发式（`valuePatterns` 默认开），**不启用** `highEntropy`（默认关，误报率高）；
 *  - 二进制文件（含 NUL）跳过：文本扫描对它无意义且必然误报；
 *  - 单文件上限 `FILE_SECTION_SCAN_MAX_BYTES`、累计上限 `FILE_SECTION_SCAN_TOTAL_BUDGET_BYTES`：
 *    超限即停止扫描（不是停止导出），被跳过的部分不产生命中也不产生告警；
 *  - scanner 未实现 `scanText`（如 core 内置的字段名黑名单 defaultSecretScanner）→ 返回空，
 *    行为与修复前一致（生产路径注入的是含 scanText 的强化扫描器）。
 *
 * 返回命中清单，`path` 为「分区内文件相对路径」，`field` 为 `line:N`（值永不外泄）。
 */
function scanFileSectionText(scanner: SecretScanner, data: unknown): SensitiveHit[] {
  const scanText = scanner.scanText;
  if (typeof scanText !== 'function') return [];
  const files = extractFileEntries(data);
  if (files === null) return [];

  const hits: SensitiveHit[] = [];
  let budget = FILE_SECTION_SCAN_TOTAL_BUDGET_BYTES;
  for (const file of files) {
    if (budget <= 0) break;
    const bytes = file.data;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) continue;
    const window = bytes.subarray(0, Math.min(bytes.length, FILE_SECTION_SCAN_MAX_BYTES, budget));
    budget -= window.length;
    if (looksBinary(window)) continue;
    let text: string;
    try {
      text = new TextDecoder('utf-8').decode(window);
    } catch {
      continue;
    }
    for (const hit of scanText(text)) {
      hits.push({ path: file.relativePath, field: hit.path });
    }
  }
  return hits;
}

/** 从分区数据里取出文件条目（非文件类/结构异常 → null；只看 files 数组，不展开其他字段） */
function extractFileEntries(data: unknown): { relativePath: string; data: Uint8Array }[] | null {
  if (data === null || typeof data !== 'object') return null;
  const files = (data as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  return files.filter((f): f is { relativePath: string; data: Uint8Array } => (
    f !== null && typeof f === 'object'
    && typeof (f as { relativePath?: unknown }).relativePath === 'string'
    && (f as { data?: unknown }).data instanceof Uint8Array
  ));
}

export class Exporter {
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly scanner: SecretScanner;
  private readonly encryption: EncryptionProvider | null;
  private readonly exporterVersion: string;
  private readonly now: () => Date;
  private readonly msg: MsgFunc;
  private readonly onSection: ((info: SectionProgress) => void) | undefined;
  private readonly vaultDataDir: string;

  constructor(opts: ExporterOptions) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.scanner = opts.scanner ?? defaultSecretScanner();
    this.encryption = opts.encryption ?? null;
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.now = opts.now ?? (() => new Date());
    this.msg = opts.msg ?? msgOf(opts.ctx);
    this.onSection = opts.onSection;
    this.vaultDataDir = opts.vaultDataDir ?? path.join(opts.ctx.homeDir, 'dsh-config-manager');
  }

  /**
   * 导出：收集 → 过滤 → checksum → manifest → ZIP。
   * 返回 zipPath（含文件名）、manifest、报告。
   */
  async export(options: ExportOptions): Promise<{ zipPath: string; manifest: Manifest; report: ExportReport }> {
    const { includeSecrets, only } = options;
    if (includeSecrets && !this.encryption) {
      throw new Error(this.msg('export.encryptionRequired'));
    }

    // 1. 选定分区（only 过滤 + 默认包含）
    //    条目级选择（Phase 1）：includeItems[s] === [] 表示用户把该分区整个取消了 ——
    //    与「未勾选该分区」等价，在选定阶段即剔除，不产出空载荷分区，
    //    manifest.sections / report.excluded 如实反映（绝不静默变成「导出成功但内容为空」）。
    //    纵深防御：宿主已保证不下发空白名单，此处覆盖 CLI / 第三方直接调用 core 的情况。
    // issue #39 Feature 1：`sessions: { limit }` 是**显式分区选择 + 数量筛选**。
    // sessions 的 defaultIncluded=false（Quick Export 不带会话），所以键存在必须自己把该分区
    // 选上；limit=0 反之把该分区整体剔除（等价于未勾选，不产出空载荷分区）。
    const sessionsLimit = options.sessions === undefined
      ? undefined
      : normalizeSessionLimit(options.sessions.limit);
    const sessionsRequested = options.sessions !== undefined && sessionsLimit !== 0;
    const selected = this.adapters
      .filter((a) => {
        if (a.id === 'sessions') {
          if (sessionsLimit === 0) return false;
          if (sessionsRequested) return true;
        }
        return only === undefined ? a.defaultIncluded : only.includes(a.id);
      })
      .filter((a) => (options.includeItems?.[a.id]?.length ?? 1) > 0)
      .map((a) => a.id);

    // 2. 逐 adapter 收集（导出数据）
    const sections: ExportSection[] = [];
    const warnings: string[] = [];
    const redactedHits: SensitiveHit[] = [];
    const included: ExportReport['included'] = [];
    const excluded: SectionId[] = this.adapters.filter((a) => !selected.includes(a.id)).map((a) => a.id);

    // m1 埋点：每导出一个分区前上报真实进度（onSection 抛错不得中断导出）
    let sectionIndex = 0;
    for (const adapter of this.adapters) {
      if (!selected.includes(adapter.id)) continue;
      sectionIndex += 1;
      try {
        this.onSection?.({ section: adapter.id, index: sectionIndex, total: selected.length });
      } catch {
        // 埋点回调失败不影响导出本身（进度是尽力而为）
      }
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, options);
      } catch (err) {
        // 单个分区失败不拖垮整体（§34.17）；如实告警并跳过
        warnings.push(this.msg('export.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        excluded.push(adapter.id);
        continue;
      }
      // 3. Secret 过滤：结构化数据逐一过 scanner（剥离值）；
      //    文件类分区（skills/agentPresets/agentInstructions/pluginFiles/sessions/self）是用户的真实文件，
      //    只做**文本级扫描 + 告警**，绝不改写/剥离内容（见 scanFileSectionText）。
      let sanitized = section.data;
      if (!isFileSection(adapter.id)) {
        const scanned = this.scanner.scanAndRedact(section.data);
        redactedHits.push(...scanned.hits);
        sanitized = scanned.sanitized;
      } else {
        const fileHits = scanFileSectionText(this.scanner, section.data);
        if (fileHits.length > 0) {
          // redactedHits 是**报告统计**通道（非告警通道）：仍计入全量命中（含同一文件的多行/多形态命中）。
          redactedHits.push(...fileHits);
          // 告警按**文件**去重（G-09/H1）：同一路径只告警一次。
          // 修复前按 hit 计数，同一行同时命中「字段名」与「值形状」会产出两条同路径告警，
          // 使少数文件就吃满上限，导致含真实明文凭据的其它文件被静默淹没（实测 redactedHits=8 而 5 条告警全属一个文件）。
          const hitPaths: string[] = [];
          const seenPaths = new Set<string>();
          for (const hit of fileHits) {
            if (seenPaths.has(hit.path)) continue;
            seenPaths.add(hit.path);
            hitPaths.push(hit.path);
          }
          // 上限语义 = 不同**文件**数 ≤ MAX_FILE_SECTION_WARNINGS_PER_SECTION（避免大分区刷屏）
          const warnedPaths = hitPaths.slice(0, MAX_FILE_SECTION_WARNINGS_PER_SECTION);
          for (const hitPath of warnedPaths) {
            warnings.push(this.msg('export.fileSectionSecrets', { section: adapter.id, path: hitPath }));
          }
          // 被截断的文件数必须**显式**汇总告警，否则截断本身又变成静默丢失。
          // 说明：此处未新增消息键（如 export.fileSectionSecretsTruncated）是为避免与并行任务冲突
          // （src/core/messages.ts 属他人改动范围）；故复用 export.fileSectionSecrets，仅 path 传汇总文案。
          const truncatedCount = hitPaths.length - warnedPaths.length;
          if (truncatedCount > 0) {
            warnings.push(this.msg('export.fileSectionSecrets', { section: adapter.id, path: `（另有 ${truncatedCount} 个文件命中，详见报告）` }));
          }
        }
      }
      sections.push({ ...section, data: sanitized });
      included.push({ section: adapter.id, counts: section.counts });
      warnings.push(...section.warnings);
    }

    // 4. 组装 ZIP 条目（JSON 分区 + 文件类分区 + secrets.enc + checksums + manifest）
    const entries: { name: string; data: Uint8Array }[] = [];
    const sectionFlags = buildSectionFlags(sections);
    let containsSecrets = false;
    let encrypted = false;
    let encryption: Manifest['security']['encryption'] = null;

    for (const section of sections) {
      if (isFileSection(section.sectionId)) {
        const prefix = SECTION_FILE_PREFIXES[section.sectionId]!;
        const files = (section.data as { files?: { relativePath: string; data: Uint8Array }[] }).files ?? [];
        for (const file of files) {
          entries.push({ name: `${prefix}${file.relativePath}`, data: file.data });
        }
        continue;
      }
      const jsonPath = SECTION_JSON_PATHS[section.sectionId];
      if (jsonPath === undefined) continue;
      entries.push({
        name: jsonPath,
        data: Buffer.from(stringifyJsonSafe(section.data, { space: 2 }), 'utf8'),
      });
    }

    // secrets.enc：有加密提供者即生成。includeSecrets=true 时加密真实的凭据原文；
    // 只勾选加密（不导出密钥）时加密空内容占位，备份仍标记 encrypted（导入需密码），
    // 但绝不把凭据值放进去（containsSecrets 保持 false；安全不变量不破）。
    if (this.encryption) {
      const credentialsFile = path.join(this.ctx.homeDir, '.credentials.yaml');
      let plaintext: string;
      if (includeSecrets) {
        try {
          const raw = await this.ctx.fs.readFile(credentialsFile);
          plaintext = Buffer.from(raw).toString('utf8');
        } catch (err) {
          warnings.push(this.msg('export.credentialsReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
          plaintext = '';
        }
      } else {
        plaintext = '';
      }
      const result = await this.encryption.encrypt(plaintext);
      entries.push({ name: 'security/secrets.enc', data: result.blob });
      encryption = result.info;
      containsSecrets = includeSecrets && plaintext !== '';
      encrypted = true;
    }

    // 4b. 文件级 vault（includeSecrets=false：敏感文件明文不进归档 → 镜像到本机 vault）。
    //     尽力而为：任何失败仅记警告，不中断导出。includeSecrets=true 时秘密已加密进归档，
    //     无需镜像（vault 只服务于「明文不进备份」的本机留存场景）。
    let vaultRefreshed = 0;
    if (!includeSecrets) {
      try {
        const vault = await refreshVault(this.ctx.fs, this.vaultDataDir, this.ctx.homeDir, DEFAULT_SENSITIVE_RELS);
        vaultRefreshed = vault.mirrored.length;
        if (vault.mirrored.length > 0) {
          warnings.push(this.msg('export.vaultRefreshed', { count: vault.mirrored.length }));
        }
        for (const s of vault.skipped) {
          warnings.push(this.msg('export.vaultRefreshSkipped', { rel: s.rel, reason: s.reason }));
        }
      } catch (err) {
        warnings.push(this.msg('export.vaultRefreshFailed', { reason: err instanceof Error ? err.message : String(err) }));
      }
    }

    // 5. checksums（覆盖除 manifest/checksums 外的全部条目）
    const checksums = buildChecksums(entries);
    entries.push({ name: CHECKSUMS_FILE, data: Buffer.from(stringifyJsonSafe(checksums, { space: 2 }), 'utf8') });

    // 6. manifest（最后写：需要完整分区与安全信息）
    const manifest = buildManifest({
      exporterVersion: this.exporterVersion,
      dshVersion: this.ctx.dshVersion,
      platform: this.ctx.platform as Manifest['source']['platform'],
      arch: this.ctx.arch,
      sections: sectionFlags,
      containsSecrets,
      encrypted,
      encryption,
      exportedAt: this.now().toISOString(),
    });
    entries.push({ name: MANIFEST_FILE, data: Buffer.from(stringifyJsonSafe(manifest, { space: 2 }), 'utf8') });

    // 7. 落盘
    const outPath = options.outPath ?? defaultOutPath(this.now());
    await writeZip(outPath, entries);
    const stat = await fs.stat(outPath);

    // 日志不泄值：只记分区与命中数量
    this.ctx.log.info('导出完成', {
      file: path.basename(outPath),
      sizeBytes: stat.size,
      sections: Object.keys(sectionFlags).filter((k) => sectionFlags[k as SectionId]),
      redactedFields: redactedHits.length,
      containsSecrets,
      encrypted,
      vaultRefreshed,
    });

    const report: ExportReport = {
      included,
      excluded,
      security: {
        secretsExcluded: !includeSecrets,
        containsSecrets,
        encrypted,
        redactedHits: redactedHits.length,
        vaultRefreshed,
      },
      file: { name: path.basename(outPath), sizeBytes: stat.size },
      warnings,
    };
    return { zipPath: outPath, manifest, report };
  }
}

/** 构建 manifest.sections 布尔表（只含实际导出分区） */
function buildSectionFlags(sections: ExportSection[]): Manifest['sections'] {
  const flags = {} as Manifest['sections'];
  for (const id of Object.keys(SECTION_JSON_PATHS) as SectionId[]) flags[id] = false;
  for (const id of Object.keys(SECTION_FILE_PREFIXES) as SectionId[]) flags[id] = false;
  flags['secrets'] = false;
  for (const section of sections) flags[section.sectionId] = true;
  return flags;
}

function defaultOutPath(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `dsh-config-${y}-${m}-${d}.zip`;
}

/** 供报告使用：导出器身份（避免与 manifest 常量重复维护） */
export const EXPORTER_INFO = { name: EXPORTER_NAME };
