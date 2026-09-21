/**
 * 文件类分区共享 adapter 基类（skills / agentPresets / sessions 复用；
 * agentInstructions 因位于 homeDir 根、只能白名单收集，覆写 export 后复用本类其余逻辑）。
 * 基准目录与 core/backup.ts 的 FILE_BASES 保持一致（skills→'skills'、agentPresets→'.agent-presets'、sessions→'sessions'），
 * 保证引擎通用快照/回滚（resolveFileTarget）与 applyItem 的写入路径完全一致。
 *
 * 文件内容以真实文件进入 ZIP（custom/skills/… 等前缀由 exporter 按 SECTION_FILE_PREFIXES 处理）。
 * 幂等：相对路径 + 内容 SHA-256 hash 比对（重复导入 → Skip）。
 */
import path from 'node:path';
import { sha256Hex } from '../utils/hashing.ts';
import { isReservedInternalRel, normalizePath } from '../utils/paths.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import type { FilesSection, SectionId } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, Portability, ValidationResult,
} from '../core/types.ts';
import { defaultUnitId, unitAllowed, unitsFromFiles } from './units.ts';

export abstract class FileCollectionAdapter implements ConfigAdapter<FilesSection> {
  abstract readonly id: SectionId;
  abstract readonly displayName: string;
  abstract readonly defaultIncluded: boolean;
  abstract readonly portability: Portability;
  /** 相对 homeDir 的基准目录（与 core/backup.ts FILE_BASES 一致） */
  abstract readonly baseDir: string;

  /**
   * 最小可拆单元的 id（相对 baseDir 的路径）。
   *
   * 缺省 = **首个路径段** —— 目录 bundle 整体成一个单元，这是技能/会话/预设的正确粒度
   * （拆开即失效）。平铺文件即自身。pluginFiles / self 覆写为「整条相对路径」：
   * 它们的白名单文件彼此独立，不构成 bundle。
   */
  protected unitIdOf(relativePath: string): string {
    return defaultUnitId(relativePath);
  }

  /** 清单里的路径 → 相对 baseDir 的路径（baseDir 为空表示整目录即根）。 */
  protected relPathOf(rel: string): string {
    if (this.baseDir === '') return rel;
    const prefix = this.baseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return rel.replace(new RegExp('^' + prefix + '[\\\\/]'), '');
  }

  /**
   * 条目级选择（Phase 1）：只导出白名单命中的单元。
   *
   * 过滤发生在 readFile **之前** —— 未勾选的文件不读盘，大分区（sessions）取消勾选后
   * 导出耗时应显著下降。allow === undefined（键缺省）= 全量，与改造前完全一致。
   */
  /**
   * 单元级预筛选钩子（缺省 null = 不筛选）。
   *
   * 子类可据 `options` 与清单计算「允许导出的单元」子集（如 sessions 的「最新 N 个」，
   * 见 core/session-select.ts）；`keep: null` = 本次不施加单元级筛选（但仍可带告警）。
   * 在 readFile **之前**执行：未入选的文件不读盘。
   */
  protected async restrictUnits(
    _ctx: HostContext,
    _rels: readonly string[],
    _options: ExportOptions,
  ): Promise<{ keep: Set<string> | null; warnings: string[] } | null> {
    return null;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const warnings: string[] = [];
    const allow = options.includeItems?.[this.id];
    // issue #37：用「跟随 junction/符号链接」的遍历，并把跟随/跳过的链接写进告警——
    // 此前链接目录及其全部内容被静默排除，备份仍报成功。
    let listing: RecursiveListing = { paths: [], skippedLinks: [], followedLinks: 0, unreadableDirs: [] };
    try {
      listing = await listFilesDetailed(ctx.fs, this.baseDir);
    } catch {
      // 目录不存在视为空
    }
    const rels = listing.paths;
    // 单元级预筛选（issue #39 Feature 1：sessions 的「最新 N 个」）
    const restricted = await this.restrictUnits(ctx, rels, options);
    if (restricted !== null) warnings.push(...restricted.warnings);
    const keep = restricted?.keep ?? null;
    for (const rel of rels) {
      const relPath = this.relPathOf(rel);
      const unitId = this.unitIdOf(relPath);
      if (keep !== null && !keep.has(unitId)) continue;
      if (!unitAllowed(allow, `${this.id}:${unitId}`)) continue;
      const data = await ctx.fs.readFile(rel);
      files.push({ relativePath: relPath, data, contentHash: sha256Hex(data) });
    }
    if (rels.length === 0) warnings.push(msgOf(ctx)('adapter.dirEmpty', { type: this.displayName }));
    warnings.push(...linkWarnings(msgOf(ctx), this.displayName, listing));
    return {
      sectionId: this.id,
      data: { version: 1, files },
      counts: { files: files.length },
      warnings,
    };
  }

  /** 单元清单（零 I/O：直接由 export 产物归并）。 */
  listUnits(section: ExportSection<FilesSection>): ExportUnit[] {
    return unitsFromFiles(this.id, section.data.files, (rel) => this.unitIdOf(rel));
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `${this.id}:${file.relativePath}`;
      // Phase 2：声明最小可拆单元（与 listUnits 同一套 unitIdOf 规则）。
      // 计划项是逐文件的，但选择器要按「一个技能 bundle / 一次会话」勾选，两端因此对齐。
      const unitId = `${this.id}:${this.unitIdOf(file.relativePath)}`;
      // F23 修复：不可信 import 不得写内部 control-plane namespace。
      // 检查 baseDir+ref 解析后的 homeDir 相对路径（self 适配器 baseDir='dsh-config-manager' 是主投毒向量）。
      const resolvedRel = normalizePath(path.join(this.baseDir, file.relativePath));
      if (isReservedInternalRel(resolvedRel)) {
        items.push({
          id, unitId, kind: 'Error', adapter: this.id,
          description: msg('adapter.fileReserved', { path: file.relativePath }), severity: 'error',
        });
        continue;
      }
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(path.join(this.baseDir, file.relativePath));
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, unitId, kind: 'Create', adapter: this.id,
          description: msg('adapter.fileCreate', { type: this.displayName, path: file.relativePath }), severity: 'info',
          target: { adapter: this.id, ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, unitId, kind: 'Skip', adapter: this.id, description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, unitId, kind: 'Conflict', adapter: this.id,
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: this.id, ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    // F23 修复：apply 前拒绝写内部 control-plane namespace（纵深防御，analyzeImport 已标 Error）
    const resolvedRel = normalizePath(path.join(this.baseDir, ref));
    if (isReservedInternalRel(resolvedRel)) {
      return { ok: false, message: msg('adapter.fileReserved', { path: ref }) };
    }
    const data = ctx.sections.get(this.id) as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(path.join(this.baseDir, ref), file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.fileSection'), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.files)) {
      issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
    } else {
      for (const f of data.files) {
        if (f === null || typeof f !== 'object' || typeof f.relativePath !== 'string' || f.relativePath === '') {
          issues.push({ path: 'files[]', message: msg('adapter.validate.fileRelativePath'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}

