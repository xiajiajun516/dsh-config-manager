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
  ImportContext, PlanItem, Portability, SectionPreview, ValidationResult,
} from '../core/types.ts';
import { defaultUnitId, unitAllowed, unitsFromEntries, unitsFromFiles } from './units.ts';
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

/**
 * 只读预览下文件条目的占位内容（长度 0）。
 *
 * 为什么可用空内容：预览产出的 `FilesSection` 只在内存里流转（选择器只需要 `relativePath`
 * 与体积），**绝不**进 ZIP / 快照 / 导入路径 —— 空内容一旦被误当导出产物，写出去的会是空文件。
 * 因此 `preview()` 的返回值在类型注释里明确标注「不是格式的一部分」（见 types.ts 的 SectionPreview）。
 */
const EMPTY_DATA = new Uint8Array(0);

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
    const collected = await this.collect(ctx, options, 'content');
    return {
      sectionId: this.id,
      data: { version: 1, files: collected.entries },
      counts: { files: collected.entries.length },
      warnings: collected.warnings,
    };
  }

  /**
   * 只读预览（`/export-preview`）：与 `export()` **共用同一个内核**（`collect`），
   * 只把「读文件内容 + SHA-256」换成 `ctx.fs.statSize`。
   *
   * 为什么必须共用：预览说的「会带哪些单元、各多大」就是用户勾选的依据，一旦与真实导出
   * 分叉，用户会按预览勾选却拿到不同的包（`file-collection.test.ts` 逐项断言两者相等）。
   */
  async preview(ctx: HostContext, options: ExportOptions): Promise<SectionPreview<FilesSection>> {
    const collected = await this.collect(ctx, options, 'size');
    return {
      section: {
        sectionId: this.id,
        data: { version: 1, files: collected.entries },
        counts: { files: collected.entries.length },
        warnings: collected.warnings,
      },
      sizeBytes: collected.totalBytes,
      items: unitsFromEntries(this.id, collected.sizes, (rel) => this.unitIdOf(rel)),
      // 本趟 stat 顺带取到的时间（宿主有 statInfo 时才有）：调用方据此省掉第二趟逐文件 stat。
      ...(collected.statTimes.size > 0 ? { statTimes: collected.statTimes } : {}),
    };
  }

  /**
   * 分区收集内核（`export` / `preview` 共用）。
   *
   * - `mode === 'content'`：读文件内容 + 算 SHA-256（真实导出）；
   * - `mode === 'size'`：只取字节数（`ctx.fs.statSize`），不解码、不哈希（预览）。
   *
   * 两种模式共用**同一套**单元分组、条目级白名单、单分区字节闸门与告警生成 ——
   * 因此「预览的单元 / 体积 / 告警」与「导出的单元 / 体积 / 告警」逐项相等。
   *
   * 返回值里的 `entries` **只含** `relativePath`/`data`/`contentHash` 三个字段：
   * `FilesSection` 是备份格式的一部分，多带内部字段会被序列化出去；体积走旁路 `sizes`。
   */
  private async collect(
    ctx: HostContext,
    options: ExportOptions,
    mode: 'content' | 'size',
  ): Promise<{
    entries: FilesSection['files'];
    sizes: { relativePath: string; sizeBytes: number }[];
    totalBytes: number;
    warnings: string[];
    /** size 模式 + 宿主实现 statInfo 时：本趟真正 stat 过的文件（homeDir 相对路径 → mtime） */
    statTimes: Map<string, number>;
  }> {
    const files: FilesSection['files'] = [];
    const statTimes = new Map<string, number>();
    const sizes: { relativePath: string; sizeBytes: number }[] = [];
    const warnings: string[] = [];
    const allow = options.includeItems?.[this.id];
    // issue #37：用「跟随 junction/符号链接」的遍历，并把跟随/跳过的链接写进告警——
    // 此前链接目录及其全部内容被静默排除，备份仍报成功。
    // 枚举走 listRelPaths 钩子（单文件分区覆写它，避免对 home 根整目录递归）。
    let listing: RecursiveListing = { paths: [], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };
    try {
      listing = await this.listRelPaths(ctx);
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
    const keptByRel = new Map<string, { entry: FilesSection['files'][number]; sizeBytes: number }>();
    for (const unitId of unitOrder) {
      const room = limit - usedBytes;
      const pending: { rel: string; entry: FilesSection['files'][number]; sizeBytes: number }[] = [];
      let unitBytes = 0;
      for (const member of unitEntries.get(unitId) ?? []) {
        const read = await this.readMember(ctx, member.rel, mode, statTimes);
        unitBytes += read.sizeBytes;
        if (unitBytes > room) break;
        pending.push({
          rel: member.rel,
          sizeBytes: read.sizeBytes,
          entry: { relativePath: member.relPath, data: read.data, contentHash: read.contentHash },
        });
      }
      if (unitBytes > room) {
        droppedUnits.push(unitId);
        continue;
      }
      usedBytes += unitBytes;
      for (const p of pending) keptByRel.set(p.rel, { entry: p.entry, sizeBytes: p.sizeBytes });
    }
    // ③ 按 ① 的顺序落盘（未触发闸门时与改造前的文件顺序逐项一致）
    for (const rel of considered) {
      const kept = keptByRel.get(rel);
      if (kept === undefined) continue;
      files.push(kept.entry);
      sizes.push({ relativePath: kept.entry.relativePath, sizeBytes: kept.sizeBytes });
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
    return { entries: files, sizes, totalBytes: usedBytes, warnings, statTimes };
  }

  /**
   * 分区清单枚举（`export` / `preview` 共用；两者必须走同一份清单，否则预览与导出分叉）。
   *
   * **单文件分区必须覆写它**：`AgentInstructionsAdapter` 的 `baseDir` 是 ''（AGENTS.md 就放在
   * `$DSH_HOME` 根），走缺省实现会递归**整个 home** —— 实测 4016 个文件 / 242 MB / 4.8 s，而且
   * 选择器会把 `profiles/`、`sessions/`、`attachments/` 这些无关目录当成该分区的「单元」。
   */
  protected async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    return listFilesDetailed(ctx.fs, this.baseDir);
  }

  /**
   * 读一个成员文件。
   *
   * - `content`：读内容并按需算 SHA-256（真实导出）；
   * - `size`：优先 `ctx.fs.statSize`（只 stat，不读内容）；门面未实现或返回 null（文件消失 /
   *   读不到）时**退回 readFile** —— 与改造前把「读不到」暴露成同一个错误，绝不把未知体积
   *   当成 0（0 会让字节闸门少算，把本该剔除的单元放进预览，预览与导出就分叉了）。
   *
   * 受保护而非私有（issue #71）：`SkillsAdapter` 的成员有一部分**不在磁盘上**
   * （来自 `ctx.skills` 技能服务的技能被重建成 `<name>/SKILL.md` 虚拟路径），
   * 需要在这里按路径分流 —— 覆写后基类的单元分组 / 字节闸门 / 告警 / 预览-导出一致性全部照旧。
   */
  protected async readMember(
    ctx: HostContext,
    rel: string,
    mode: 'content' | 'size',
    statTimes?: Map<string, number>,
  ): Promise<{ data: Uint8Array; sizeBytes: number; contentHash: string }> {
    if (mode === 'size') {
      // 优先 statInfo：一次 stat 同时拿体积与 mtime（sessions 的排序时间顺带就有了，
      // 省掉 unitActivityTimes 的第二趟逐文件 stat —— 实测会话树 983 个文件）。
      if (ctx.fs.statInfo !== undefined) {
        const info = await ctx.fs.statInfo(rel);
        if (info !== null) {
          statTimes?.set(rel, info.mtimeMs);
          return { data: EMPTY_DATA, sizeBytes: info.size, contentHash: '' };
        }
      }
      const size = (await ctx.fs.statSize?.(rel)) ?? null;
      if (size !== null) return { data: EMPTY_DATA, sizeBytes: size, contentHash: '' };
    }
    const data = await ctx.fs.readFile(rel);
    return { data, sizeBytes: data.byteLength, contentHash: mode === 'content' ? sha256Hex(data) : '' };
  }

  /** 单元清单（零 I/O：直接由 export 产物归并）。 */
  listUnits(section: ExportSection<FilesSection>): ExportUnit[] {
    // files 可能缺省（空分区 / 手写 section）：按空表处理，不抛错 —— 选择器对任何分区都会调 listUnits
    return unitsFromFiles(this.id, section.data.files ?? [], (rel) => this.unitIdOf(rel));
  }

  /**
   * 幂等比对用的内容（相对 baseDir 路径 + 盘上/包内字节 → 参与哈希比对的字节）。
   *
   * 缺省 = **原字节**：对文件类分区来说「相对路径 + 内容哈希」就是身份语义，不得改动。
   * 覆写者只应用于剔除**不属于「配置身份」的易变字段**（见 SelfAdapter 的两个调度配置：
   * 运行态每轮都被改写，整文件哈希会恒判 Conflict —— issue #73）。两条契约：
   *   1. **必须收敛**：applyItem 写盘后再分析一次必须判 Skip，否则同步永不收敛；
   *   2. **未改写时返回同一引用** —— 调用方据此复用导入侧已算好的 contentHash，
   *      不给 sessions 这类大分区白算一遍哈希。
   * 判不出可比形态（解析失败等）时必须**原样返回**：绝不把「判不出来」当成「相同」或「不同」。
   */
  protected comparableContent(_relativePath: string, data: Uint8Array): Uint8Array {
    return data;
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
      } else {
        // 幂等判定统一走 comparableContent（缺省 = 原字节）；包内文件未被改写时复用已算好的
        // contentHash，不给 sessions 这类大分区白算一遍哈希（盘上文件本来就要现算）。
        const importedComparable = this.comparableContent(file.relativePath, file.data);
        const importedHash = importedComparable === file.data ? file.contentHash : sha256Hex(importedComparable);
        if (sha256Hex(this.comparableContent(file.relativePath, current)) === importedHash) {
          items.push({ id, unitId, kind: 'Skip', adapter: this.id, description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
        } else {
          items.push({
            id, unitId, kind: 'Conflict', adapter: this.id,
            description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
            target: { adapter: this.id, ref: file.relativePath },
          });
        }
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

