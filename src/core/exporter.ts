/**
 * Export 编排（规范 §1/§18/§21，设计 §4.4）：
 *   adapter 收集各分区 → Secret 过滤 → manifest → checksum → ZIP。
 *
 * 安全不变量：
 *  - Secret 值默认永不进入导出数据（结构化分区逐一过 SecretScanner）；
 *  - includeSecrets=true 必须注入 EncryptionProvider（m4 实现），否则拒绝导出；
 *  - 加密密码/秘密值绝不写入 manifest 与日志。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE, EXPORTER_NAME } from '../schema/manifest.ts';
import { SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts';
import { writeZip } from '../utils/zip.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type {
  ConfigAdapter, EncryptionProvider, ExportOptions, ExportReport,
  ExportSection, HostContext, SecretScanner, SensitiveHit,
} from './types.ts';

export interface ExporterOptions {
  ctx: HostContext;
  adapters: ConfigAdapter[];
  /** Secret 扫描器；缺省用字段名黑名单剥离（m4 可注入强化版） */
  scanner?: SecretScanner;
  /** 加密提供者（m4 用 node:crypto 实现）；includeSecrets 时必填 */
  encryption?: EncryptionProvider | null;
  /** 插件自身版本（manifest.exporter.version） */
  exporterVersion?: string;
  now?: () => Date;
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

export class Exporter {
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly scanner: SecretScanner;
  private readonly encryption: EncryptionProvider | null;
  private readonly exporterVersion: string;
  private readonly now: () => Date;

  constructor(opts: ExporterOptions) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.scanner = opts.scanner ?? defaultSecretScanner();
    this.encryption = opts.encryption ?? null;
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * 导出：收集 → 过滤 → checksum → manifest → ZIP。
   * 返回 zipPath（含文件名）、manifest、报告。
   */
  async export(options: ExportOptions): Promise<{ zipPath: string; manifest: Manifest; report: ExportReport }> {
    const { includeSecrets, only } = options;
    if (includeSecrets && !this.encryption) {
      throw new Error('导出包含秘密需要注入 EncryptionProvider（m4 实现），拒绝明文导出秘密');
    }

    // 1. 选定分区（only 过滤 + 默认包含）
    const selected = this.adapters
      .filter((a) => (only === undefined ? a.defaultIncluded : only.includes(a.id)))
      .map((a) => a.id);

    // 2. 逐 adapter 收集（导出数据）
    const sections: ExportSection[] = [];
    const warnings: string[] = [];
    const redactedHits: SensitiveHit[] = [];
    const included: ExportReport['included'] = [];
    const excluded: SectionId[] = this.adapters.filter((a) => !selected.includes(a.id)).map((a) => a.id);

    for (const adapter of this.adapters) {
      if (!selected.includes(adapter.id)) continue;
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, options);
      } catch (err) {
        // 单个分区失败不拖垮整体（§34.17）；如实告警并跳过
        warnings.push(`分区 ${adapter.id} 导出失败: ${err instanceof Error ? err.message : String(err)}`);
        excluded.push(adapter.id);
        continue;
      }
      // 3. Secret 过滤：结构化数据逐一过 scanner；
      //    文件类分区（skills 等）内容为自由文本，扫描语义由 m4 强化，此处不动
      let sanitized = section.data;
      if (!isFileSection(adapter.id)) {
        const scanned = this.scanner.scanAndRedact(section.data);
        redactedHits.push(...scanned.hits);
        sanitized = scanned.sanitized;
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

    // secrets.enc：仅加密备份
    if (includeSecrets && this.encryption) {
      const credentialsFile = path.join(this.ctx.homeDir, '.credentials.yaml');
      let plaintext: string;
      try {
        const raw = await this.ctx.fs.readFile(credentialsFile);
        plaintext = Buffer.from(raw).toString('utf8');
      } catch (err) {
        warnings.push(`读取凭据文件失败，跳过秘密导出: ${err instanceof Error ? err.message : String(err)}`);
        plaintext = '';
      }
      if (plaintext !== '') {
        const result = await this.encryption.encrypt(plaintext);
        entries.push({ name: 'security/secrets.enc', data: result.blob });
        encryption = result.info;
        containsSecrets = true;
        encrypted = true;
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
    });

    const report: ExportReport = {
      included,
      excluded,
      security: {
        secretsExcluded: !includeSecrets,
        containsSecrets,
        encrypted,
        redactedHits: redactedHits.length,
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
