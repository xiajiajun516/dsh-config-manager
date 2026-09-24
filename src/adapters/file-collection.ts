/**
 * 文件类分区共享 adapter 基类（skills / agentPresets / sessions 复用；
 * agentInstructions 因位于 homeDir 根、只能白名单收集，覆写 export 后复用本类其余逻辑）。
 * 基准目录与 core/backup.ts 的 FILE_BASES 保持一致（skills→'skills'、agentPresets→'.agent-presets'、sessions→'sessions'），
 * 保证引擎通用快照/回滚（resolveFileTarget）与 applyItem 的写入路径完全一致。
 *
 * 文件内容以真实文件进入 ZIP（custom/skills/… 等前缀由 exporter 按 SECTION_FILE_PREFIXES 处理）。
 * 幂等：相对路径 + 内容 SHA-256 hash 比对（重复导入 → Skip）。
 *
 * 导出的**单分区字节闸门**（审计 core-flow F-12 / sync#F-12）：累计到 MAX_FILE_SECTION_BYTES 后，
 * 放不下的单元**整块**剔除并写进告警（见 export()）。覆盖 skills / agentPresets / sessions；
 * agentInstructions（单文件 AGENTS.md）与 self（白名单配置小文件）各自覆写 export，不在本闸门射程内。
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
import { validateJsonSection } from './json-section.ts';

/**
 * 文件类分区导出的**单分区累计字节闸门**：分区内文件内容合计放不下的单元整块剔除（见 export()）。
 *
 * 取值依据（不是随手拍的数）：
 *  1) **对称性** —— 导入侧对上传的备份包有硬上限 256 MiB（MAX_UPLOAD_BYTES，src/index.ts 与
 *     src/routes/kit.ts 的上传路径）；导出侧此前**没有任何体积约束**，于是会出现「导出成功、
 *     传不回来」（审计 core-flow F-12 / sync#F-12）。取同一个 256 MiB 作**单分区**上限：
 *     任何单个分区都落在导入侧上传路径能收的范围内。
 *  2) **内存峰值** —— 导出时文件内容以完整 Uint8Array 驻留内存（ZIP 组装前全量在内存里），同步通道
 *     还要再写一份。闸门把「单分区常驻」钳在 256 MiB 以内（峰值 ≈ 上限 + 正在读的那个单元），
 *     不再是「会话附件多大就多吃多少」。
 *  3) **与既有同类上限同量级** —— MAX_MARKET_ZIP_BYTES = 64 MiB、DEFAULT_MAX_JSON_BYTES = 64 MiB、
 *     MAX_LOCAL_TARBALL_BYTES = 100 MiB、MAX_PATCH_FILE_BYTES = 2 MiB。文件类分区装的是**用户真实
 *     文件**，所以取「导入侧能收」的 256 MiB，而不是为省内存随意调小（那会平白少带用户数据）。
 *  4) **为什么按分区而不是按整包** —— 整包体积由用户勾选跨分区决定；闸门要能给出「哪些分区、哪些
 *     单元没进去」的可执行信息，落在分区/单元层才可解释。
 *
 * 超限时**绝不静默**：被整块剔除的单元清单进 ExportSection.warnings（导出报告可见）。
 */
export const MAX_FILE_SECTION_BYTES = 256 * 1024 * 1024;

/** 字节闸门告警里最多列出的单元数（其余折叠成 "(+ N)"，避免大分区把报告撑爆；与 link-report 同口径） */
const MAX_UNITS_PER_GATE_WARNING = 5;

/** 告警文案里的体积（人类可读；纯数值格式化，不含用户可见散文） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export abstract class FileCollectionAdapter implements ConfigAdapter<FilesSection> {
  /** 文件集合：`relativePath` 是身份而非配置 → 永不被导入时的前缀映射改写（见 ConfigAdapter.fileCollection） */
  readonly fileCollection = true;
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
   * 单分区累计字节上限（缺省 MAX_FILE_SECTION_BYTES = 256 MiB，见该常量注释）。
   *
   * 生产代码不覆写；留成受保护方法只为让测试能构造「超限」场景（真实阈值 256 MiB 无法在单测里
   * 造出来而不吃掉 256 MiB 内存）。若要给用户配置入口，应走 ExportOptions（src/core/types.ts），
   * 而不是在子类里飘一个隐式默认值。
   */
  protected sectionByteLimit(): number {
    return MAX_FILE_SECTION_BYTES;
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
    // ① 先按「单元」分组（零 I/O：只看路径）。单元的成员文件**不保证**在遍历结果里连续，
    //    必须整组一起判定，否则同一单元会被拦腰劈开（半个技能目录 / 半个会话目录）。
    //    `considered` 保序记录，收尾按它还原改造前的文件顺序（未触发闸门时逐项一致）。
    const considered: string[] = [];
    const unitOrder: string[] = [];
    const unitEntries = new Map<string, { rel: string; relPath: string }[]>();
    for (const rel of rels) {
      const relPath = this.relPathOf(rel);
      const unitId = this.unitIdOf(relPath);
      if (keep !== null && !keep.has(unitId)) continue;
      if (!unitAllowed(allow, `${this.id}:${unitId}`)) continue;
      let members = unitEntries.get(unitId);
      if (members === undefined) {
        members = [];
        unitEntries.set(unitId, members);
        unitOrder.push(unitId);
      }
      members.push({ rel, relPath });
      considered.push(rel);
    }

    // ② 逐单元读取 + 累计字节闸门（审计 core-flow F-12 / sync#F-12）。超出 sectionByteLimit() 的
    //    单元**整块**不进备份（仓库语义：单元不可拆分 —— 宁可少带，不可半带）；一旦判定该单元放不下，
    //    它的剩余文件不再读盘（省 I/O，也不为「统计精确」多吃内存）。放不下的单元跳过后**继续尝试
    //    后面的单元**：一个巨型会话不该把它之后的所有内容一起带走（后面的小单元仍可能入选）。
    const limit = this.sectionByteLimit();
    let usedBytes = 0;
    const droppedUnits: string[] = [];
    const keptByRel = new Map<string, FilesSection['files'][number]>();
    for (const unitId of unitOrder) {
      const room = limit - usedBytes;
      const pending: { rel: string; file: FilesSection['files'][number] }[] = [];
      let unitBytes = 0;
      for (const member of unitEntries.get(unitId) ?? []) {
        const data = await ctx.fs.readFile(member.rel);
        unitBytes += data.byteLength;
        if (unitBytes > room) break;
        pending.push({ rel: member.rel, file: { relativePath: member.relPath, data, contentHash: sha256Hex(data) } });
      }
      if (unitBytes > room) {
        droppedUnits.push(unitId);
        continue;
      }
      usedBytes += unitBytes;
      for (const p of pending) keptByRel.set(p.rel, p.file);
    }
    // ③ 按 ① 的顺序落盘（未触发闸门时与改造前的文件顺序逐项一致）
    for (const rel of considered) {
      const file = keptByRel.get(rel);
      if (file !== undefined) files.push(file);
    }
    // 绝不静默：被整块剔除的单元写进告警（导出报告可见），并给出上限与实际保留量
    if (droppedUnits.length > 0) {
      const shown = droppedUnits.slice(0, MAX_UNITS_PER_GATE_WARNING);
      const rest = droppedUnits.length - shown.length;
      warnings.push(msgOf(ctx)('adapter.fileSectionByteLimit', {
        type: this.displayName,
        limit: formatBytes(limit),
        kept: formatBytes(usedBytes),
        count: String(droppedUnits.length),
        detail: (rest > 0 ? [...shown, `(+ ${rest})`] : shown).join(', '),
      }));
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

  /**
   * 结构校验（5 个文件类分区共用：skills / agentPresets / agentInstructions / sessions / self）。
   *
   * **整段样板都接入共享骨架 `validateJsonSection`** —— t7 接入 version 守卫与形状检查收尾，t11 接入
   * object 守卫；dataVersion 由注册表按 `this.id` 派生，等价于此前的字面量 `!== 1`
   * （SECTION_DATA_VERSION = 1）。本类里已无手写样板。
   *
   * object 守卫的**文案**为什么还要参数：文件类分区历史上用的是**专用消息键**
   * `adapter.validate.fileSection`（'文件分区数据必须是对象'，不含 `{subject}` 占位符），与骨架缺省的
   * `adapter.validate.object` + `{subject}` 是**键**级差异 —— 第 5 参 subject 补不了它。t11 给骨架加了
   * 可选第 6 参 `objectMessageKey`，这里传专用键：5 个分区的用户可见报错文案与改造前**逐字相同**，
   * 同时不放任何手写样板。等价由 src/adapters/file-collection.test.ts 与 outputs/t7-equiv/ 的差分脚本钉住。
   */
  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    // 第 5 参 subject 传 this.id 即骨架缺省语义（专用键不含 {subject}，取值不影响输出）
    return validateJsonSection<FilesSection>(this.id, data, msg, (section, issues) => {
      if (!Array.isArray(section.files)) {
        issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
      } else {
        for (const f of section.files) {
          if (f === null || typeof f !== 'object' || typeof f.relativePath !== 'string' || f.relativePath === '') {
            issues.push({ path: 'files[]', message: msg('adapter.validate.fileRelativePath'), severity: 'error' });
          }
        }
      }
    }, this.id, 'adapter.validate.fileSection');
  }
}

