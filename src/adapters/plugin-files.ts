/**
 * pluginFiles 分区 adapter（可选，设计 §3.3/§1.2）：
 * 数据源 = 插件自有配置文件（相对 ~/.dsh 根）：
 *   1. 白名单固定文件（dsh-ssh.json、pet.json 等，避免扫描整个主目录）；
 *   2. 约定的插件配置目录（collectDir，如 plugin-config/）递归收集其下所有文件。
 * relativePath 一律是「相对 ~/.dsh 根」的完整路径（与白名单文件一致），
 * 导入时按同一相对路径写回原位置。默认关闭（defaultIncluded=false，用户显式勾选才导出）。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import { engineMsg } from './messages.ts';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { isPathSafe, isReservedInternalRel } from '../utils/paths.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { unitAllowed, unitsFromFiles } from './units.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';

export const DEFAULT_PLUGIN_FILE_WHITELIST: readonly string[] = ['dsh-ssh.json', 'pet.json'];

export class PluginFilesAdapter implements ConfigAdapter<FilesSection> {
  readonly id = 'pluginFiles' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('pluginFiles').displayName;
  readonly defaultIncluded = sectionMeta('pluginFiles').defaultIncluded;
  readonly portability = sectionMeta('pluginFiles').portability;
  private readonly whitelist: string[];
  /** 约定配置目录（相对 ~/.dsh 根，如 'plugin-config'）；递归收集其下所有文件。undefined = 不收集。 */
  private readonly collectDir?: string;

  constructor(whitelist: string[] = [...DEFAULT_PLUGIN_FILE_WHITELIST], collectDir?: string) {
    this.whitelist = whitelist;
    if (collectDir !== undefined && collectDir !== '' && !isPathSafe(collectDir)) {
      throw new Error(engineMsg('adapter.pluginFilesCollectDirInvalid', { dir: collectDir }));
    }
    this.collectDir = collectDir === '' ? undefined : collectDir;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const seen = new Set<string>();
    // Phase 1 条目级选择：**逐文件单元** —— 每个插件配置文件彼此独立，
    // 不像技能/会话那样构成 bundle（collectDir 下每个文件可单独带走）。
    const allow = options.includeItems?.[this.id];
    // 1) 白名单固定文件（不存在则跳过，dsh-ssh.json 等为按需创建）
    for (const rel of this.whitelist) {
      if (!unitAllowed(allow, `${this.id}:${rel}`)) continue;
      try {
        const data = await ctx.fs.readFile(rel);
        files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        seen.add(rel);
      } catch (err) {
        // ui-F2：白名单文件**不存在**是正常形态（按需创建 → 跳过）；**读不到**（权限/竞态/断链）
        // 绝不能静默丢内容 —— 与文件集合基类同一语义：整分区显式失败，导出报告可见。
        if (await this.absentOnDisk(ctx, rel)) continue;
        throw err;
      }
    }
    // 2) 约定配置目录递归收集（相对 ~/.dsh 根的完整路径；与白名单文件去重）
    // issue #37：与 skills 等同一条遍历（跟随 junction/符号链接 + 跳过留痕）
    let listing: RecursiveListing = { paths: [], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };
    if (this.collectDir !== undefined) {
      try {
        listing = await listFilesDetailed(ctx.fs, this.collectDir);
      } catch {
        // 目录不存在视为空
      }
      const rels = listing.paths;
      for (const rel of rels) {
        if (seen.has(rel)) continue;
        if (!unitAllowed(allow, `${this.id}:${rel}`)) continue;
        try {
          const data = await ctx.fs.readFile(rel);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        } catch (err) {
          // ui-F2：同上 —— 目录遍历刚点到的文件却读不到，是真实的读取失败，不是「不存在」。
          if (await this.absentOnDisk(ctx, rel)) continue;
          throw err;
        }
      }
    }
    return {
      sectionId: 'pluginFiles',
      data: { version: 1, files },
      counts: { files: files.length },
      warnings: linkWarnings(msgOf(ctx), this.displayName, listing),
    };
  }

  /**
   * 读失败之后判定「这个路径本来就不存在」还是「存在但读不到」（ui-F2）。
   *
   * 为什么不用错误码：门面错误的形状并不统一（内存 mock 与各平台 EACCES 文案不同），
   * 而 `exists()` 是 FileSystemFacade 契约里唯一稳定的存在性判据。`exists()` 自己也失败时
   * 按「存在」处理（保守：宁可让这次导出显式失败，也不静默丢一个文件）。
   */
  private async absentOnDisk(ctx: HostContext, rel: string): Promise<boolean> {
    try {
      return (await ctx.fs.exists(rel)) === false;
    } catch {
      return false;
    }
  }

  /** 单元清单（零 I/O）：逐文件单元，id 与导入侧 `pluginFiles:<relPath>` 一致。 */
  listUnits(section: ExportSection<FilesSection>): ExportUnit[] {
    // files 可能缺省（空分区 / 手写 section）：按空表处理，不抛错 —— 选择器对任何分区都会调 listUnits
    return unitsFromFiles(this.id, section.data.files ?? [], (rel) => rel);
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `pluginFile:${file.relativePath}`;
      // F23 修复：不可信 import 不得写内部 control-plane namespace（snapshots/transactions/locks/safe-mode）
      if (isReservedInternalRel(file.relativePath)) {
        items.push({
          id, kind: 'Error', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileReserved', { path: file.relativePath }), severity: 'error',
        });
        continue;
      }
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(file.relativePath);
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, kind: 'Create', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileCreate', { path: file.relativePath }), severity: 'info',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: 'pluginFiles', description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'pluginFiles',
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    // F23 修复：apply 前拒绝写内部 control-plane namespace（纵深防御，analyzeImport 已标 Error）
    if (isReservedInternalRel(ref)) {
      return { ok: false, message: ctx.msg('adapter.pluginFileReserved', { path: ref }) };
    }
    const data = ctx.sections.get('pluginFiles') as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: ctx.msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(ref, file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<FilesSection>('pluginFiles', data, msg, (section, issues) => {
      if (!Array.isArray(section.files)) {
        issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
        return;
      }
      // ui-F3：条目级形状校验必须与 analyzeImport 的假设对齐（它直接读 file.relativePath）。
      // 只校验「是数组」会放过 files:[null] / relativePath:42 这类畸形，analyzeImport 抛内部
      // TypeError → ImportAnalysis.valid=false → 整包被拦下，用户看到的是内部异常文本。
      for (const [i, f] of section.files.entries()) {
        const entry = f as unknown;
        if (entry === null || typeof entry !== 'object' || typeof (entry as { relativePath?: unknown }).relativePath !== 'string' || (entry as { relativePath: string }).relativePath === '') {
          issues.push({ path: `files[${i}]`, message: msg('adapter.validate.fileRelativePath'), severity: 'error' });
        }
      }
    });
  }
}
