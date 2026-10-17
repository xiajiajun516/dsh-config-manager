/**
 * pluginData / pluginAssets 分区 adapter（第三方插件数据迁移）。
 *
 * 数据来源 = \`src/core/plugin-data-registry.ts\` 的来源注册表：内置已取证来源 + 已安装插件在
 * 自己 package.json 里声明的 \`dsh.dataDirs\`。每个「区域（area）」在备份里是**一个可勾选单元**，
 * 单元 id = 区域的 home 相对 POSIX 路径（如 \`.dsh-wallpaper-engine/uploads\`）——
 * 用户能在导出选择器里逐区域看到「几个文件 / 多大」，也能只带走配置、不带几百 MB 的上传壁纸。
 *
 * 为什么两个分区而不是一个：
 *  - \`pluginData\` = 配置与轻量状态；\`pluginAssets\` = 大体积用户数据（上传的壁纸、本地数据库）；
 *  - 「默认不勾选大资产」在既有 UI 选择模型里**只有分区级开关**这一条可靠通道（单元级只有
 *    「默认全选 + 稀疏排除」，没有「默认排除」的概念）—— 拆成两个分区后，「可见但默认不勾选」
 *    就是既有的 \`defaultIncluded=false\` 语义，不需要动共享选择模型，也不会与导入/市场两处选择语义打架。
 *
 * 实现：继承 FileCollectionAdapter（baseDir = ''，即 home 根；与 agentInstructions 同一形态），
 * 复用它的单元分组 / 单分区字节闸门 / 预览-导出一致性 / 幂等哈希比对；只覆写三处：
 *  ① \`listRelPaths()\` —— 清单来自来源注册表（并如实记录被环境变量覆盖而跳过的区域）；
 *  ② \`unitIdOf()\` —— 单元 = 区域（最长前缀归属）；
 *  ③ \`analyzeImport() / applyItem()\` —— **写入路径白名单**（见下）。
 *
 * 安全不变量（本分区是全仓唯一「按 home 相对路径任意写」的分区，必须自己守住）：
 *  - **导入白名单**：只有「本机内置来源的区域」与「本机已安装插件声明的区域」之下的路径才允许写。
 *    恶意/损坏的包想把 \`.credentials.yaml\` 或 \`AGENTS.md\` 塞进来，在这里被判 Error（计划里可见，
 *    执行期不写）；applyItem 再查一遍（纵深防御），内层还有基类的 control-plane namespace 拒绝。
 *  - **缓存永不收录**：role === 'cache' 的区域不属于任何分区，导出时根本不进清单。
 *  - **环境变量覆盖即跳过**：区域声明的 env 存在且解析结果与默认位置不同 → 报码跳过，绝不猜新位置。
 *  - **不产生用户可见散文**：告警与计划项文案一律走消息目录（i18n 铁律）。
 */
import { normalizePath } from '../utils/paths.ts';
import { engineMsg } from './messages.ts';
import { listFilesDetailed } from './link-report.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import {
  BUILTIN_PLUGIN_DATA_SOURCES, areaOfPath, areasForSection, isExcludedRel, normalizeHomeRel,
} from '../core/plugin-data-registry.ts';
import { declaredProfileName, scanDeclaredDataSources } from './plugin-data-declared.ts';
import type { PluginDataArea, PluginDataSource, PluginDataSection } from '../core/plugin-data-registry.ts';
import { osHomeDirOf } from '../core/backup.ts';
import { FileCollectionAdapter } from './file-collection.ts';
import type { FilesSection } from '../schema/types.ts';
import type {
  ApplyResult, ExportOptions, ExportSection, FileSystemFacade, HostContext, ImportContext, PlanItem,
  SectionPreview,
} from '../core/types.ts';

/** 区域条目（来源 + 区域），编译期与运行期唯一的区域表示 */
export type PluginDataEntry = { source: PluginDataSource; area: PluginDataArea };

/** 声明来源缓存的 TTL（毫秒）：一次导出/导入/执行里会多次解析，逐次读 15+ 个 package.json 是净开销 */
const DECLARED_TTL_MS = 5_000;

export interface PluginDataAdapterOptions {
  /** 内置来源（缺省 = BUILTIN_PLUGIN_DATA_SOURCES；测试注入假来源） */
  readonly sources?: readonly PluginDataSource[];
  /** 自述声明缓存 TTL；测试可传 0 关闭缓存 */
  readonly declaredTtlMs?: number;
  /**
   * 环境变量快照（缺省 process.env）。
   *
   * 为什么走构造参数而不是 HostContext：HostContext 上没有 env（它是宿主门面的集合），
   * 而「区域被环境变量搬走」这件事必须在**同一次调用**里可判定、可注入测试值 ——
   * 直接读 process.env 会让单测无法造「被覆盖」的场景（本机若恰好设了该变量，测试还会 flaky）。
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class PluginDataAdapter extends FileCollectionAdapter {
  readonly id: PluginDataSection;
  readonly displayName: string;
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  /** home 根（相对路径 = home 相对路径，与 agentInstructions 同形） */
  readonly baseDir = '';

  private readonly builtin: readonly PluginDataSource[];
  private readonly declaredTtlMs: number;
  private readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * 自述声明缓存。**必须带 ctx 键**（homeDir + profile）：这台机器装了某插件，不代表另一台装了 ——
   * 缓存若按实例共享，导入到「没装该插件」的目标机时会拿源机的声明去放行写入，
   * 白名单就变成了「谁先导入谁说了算」。
   */
  private declaredMemo: { key: string; at: number; sources: PluginDataSource[] } | undefined;
  /** 本轮清单（listRelPaths 写入；unitIdOf 是同步纯函数，只能从这里拿区域表） */
  private active: readonly PluginDataEntry[] | undefined;
  /** 本轮告警（环境变量覆盖跳过等；export/preview 收尾合并进返回的 warnings） */
  private pendingWarnings: string[] = [];

  constructor(section: PluginDataSection, options: PluginDataAdapterOptions = {}) {
    super();
    this.id = section;
    this.displayName = sectionMeta(section).displayName;
    this.builtin = options.sources ?? BUILTIN_PLUGIN_DATA_SOURCES;
    this.declaredTtlMs = options.declaredTtlMs ?? DECLARED_TTL_MS;
    this.env = options.env ?? process.env;
  }

  /** 本分区可收集区域（内置 + 自述声明） */
  private async allowedEntries(ctx: HostContext): Promise<readonly PluginDataEntry[]> {
    const sources = await this.allSources(ctx);
    return areasForSection(sources, this.id);
  }

  private async allSources(ctx: HostContext): Promise<readonly PluginDataSource[]> {
    const declared = await this.declaredSources(ctx);
    return [...this.builtin, ...declared];
  }

  /**
   * 已安装插件的自述声明（dsh.dataDirs）—— 本方法只做**缓存**，扫描实现见 plugin-data-declared.ts。
   *
   * 为什么缓存必须带 ctx 键（homeDir + profile）：DSH 的插件装在 \`profiles/<profile>/node_modules\`
   * 下（pnpm 隔离布局），而「这台机器装了某插件」不代表另一台装了 —— 缓存若按实例共享，
   * 导入到「没装该插件」的目标机时会拿源机的声明去放行写入，白名单就变成「谁先导入谁说了算」。
   */
  private async declaredSources(ctx: HostContext): Promise<PluginDataSource[]> {
    const now = Date.now();
    const memoKey = ctx.homeDir + '|' + declaredProfileName(ctx.profile);
    if (
      this.declaredMemo !== undefined
      && this.declaredMemo.key === memoKey
      && now - this.declaredMemo.at < this.declaredTtlMs
    ) {
      return this.declaredMemo.sources;
    }
    const out = await scanDeclaredDataSources(ctx);
    this.declaredMemo = { key: memoKey, at: now, sources: out };
    return out;
  }

  /**
   * 区域是否被环境变量覆盖（覆盖 → 返回变量名；未覆盖 / 未声明 → null）。
   *
   * 判定口径：变量**存在且解析结果与默认位置不同**才算覆盖 —— 仅仅 \`DSH_WE_DATA_DIR=~/.dsh-wallpaper-engine\`
   * 这种「设成同一个值」的写法不该让区域凭空消失（那会让用户以为「没有数据」）。
   * 解析只做 \`~\` 展开与分隔符归一（不做 realpath：不读盘、不猜）。
   */
  private envOverrideOf(ctx: HostContext, area: PluginDataArea): string | null {
    for (const name of area.envOverrides ?? []) {
      const raw = this.env[name];
      if (raw === undefined || raw.trim() === '') continue;
      const normalized = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      // 默认位置以**系统 home** 为根（本分区的根；见 core/backup.ts 的 OS_HOME_FILE_SECTIONS）
      const home = osHomeDirOf(ctx).replace(/\\/g, '/').replace(/\/+$/, '');
      const expanded = normalized.startsWith('~/') ? home + normalized.slice(1) : normalized;
      const defaultAbs = home + '/' + area.relPath;
      if (expanded !== defaultAbs) return name;
    }
    return null;
  }

  /**
   * 区域是否是**普通文件**（而不是目录 / 不存在）。
   *
   * 判据顺序为什么是这样：`statSize` 对「非普通文件」与「不存在」都返回 null，无法单独区分
   * 目录与缺失；所以先判「是文件」，其余一律按目录走遍历 —— 目录不存在时遍历返回空，
   * 结果同样是「没有内容」，不会把缺失误报成文件，也不会把目录误读成空内容而静默丢数据。
   * 门面未实现 statSize（旧宿主）时退回读一次内容：读得出来就是文件。
   */
  private async isRegularFile(fsFacade: FileSystemFacade, rel: string): Promise<boolean> {
    if (fsFacade.statSize !== undefined) {
      try {
        return (await fsFacade.statSize(rel)) !== null;
      } catch {
        return false;
      }
    }
    try {
      await fsFacade.readFile(rel);
      return true;
    } catch {
      return false;
    }
  }

  private static emptyListing(): RecursiveListing {
    return { paths: [], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };
  }

  /**
   * 清单枚举 = 来源注册表的区域（覆写基类的目录递归；baseDir='' 时基类实现会递归**整个 home**）。
   *
   * **必须覆写**：home 根上递归会遍历 profiles/ sessions/ attachments/ 等全部内容（本机实测
   * 4000+ 文件 / 数百 MB），既慢又会把无关目录当成该分区的「可勾选单元」。
   */
  protected override async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    // 本分区的根是**系统 home**（~/.dsh-wallpaper-engine、~/.mnemon …），不是 $DSH_HOME ——
    // 内容 I/O 一律走 homeFs；宿主没提供就什么都不收集，并如实报码（绝不退回 $DSH_HOME 去读错位置）。
    const homeFs = ctx.homeFs;
    if (homeFs === undefined) {
      this.active = [];
      this.pendingWarnings = [engineMsg('adapter.pluginDataNoOsHome')];
      return PluginDataAdapter.emptyListing();
    }
    const entries = await this.allowedEntries(ctx);
    this.active = entries;
    const warnings: string[] = [];
    const paths: string[] = [];
    const listing = PluginDataAdapter.emptyListing();
    for (const entry of entries) {
      const rel = entry.area.relPath;
      const env = this.envOverrideOf(ctx, entry.area);
      if (env !== null) {
        warnings.push(engineMsg('adapter.pluginDataEnvOverridden', { path: rel, env }));
        continue;
      }
      if (await this.isRegularFile(homeFs, rel)) {
        paths.push(rel);
        continue;
      }
      let sub: RecursiveListing;
      try {
        sub = await listFilesDetailed(homeFs, rel);
      } catch {
        // 目录不存在 / 读不到 → 视为无内容（存在的空目录与缺失在这里同义：都没有文件可带）
        continue;
      }
      listing.skippedLinks.push(...sub.skippedLinks);
      listing.skippedDepDirs.push(...sub.skippedDepDirs);
      listing.unreadableDirs.push(...sub.unreadableDirs);
      listing.followedLinks += sub.followedLinks;
      for (const p of sub.paths) {
        if (isExcludedRel(entry.area, p)) continue;
        paths.push(p);
      }
    }
    listing.paths = paths;
    this.pendingWarnings = warnings;
    return listing;
  }

  /**
   * 单元 = 区域（最长前缀归属）。
   *
   * 用「本轮清单写入的区域表」而不是重新解析：listRelPaths 与本函数在同一次 collect 里成对调用，
   * 重算会让两次解析结果不一致时出现「单元 id 不在清单里」（选择器勾不上）。测试/异常路径下
   * \`active\` 可能是 undefined（例如直接调 listUnits），此时退回**内置来源**的最长前缀 —— 与清单口径同源。
   */
  protected override unitIdOf(relativePath: string): string {
    const entries = this.active ?? areasForSection(this.builtin, this.id);
    const hit = areaOfPath(entries, normalizePath(relativePath));
    return hit === null ? normalizePath(relativePath) : hit.area.relPath;
  }

  /**
   * 读一个成员文件：**换根到系统 home 门面**（基类的其余逻辑 —— 体积、哈希、字节闸门 —— 一字不动）。
   *
   * 能走到这里说明 listRelPaths 产出过条目（缺门面时它不产出任何路径），因此缺门面即**抛错**，
   * 不再造一个「空文件」出来（那会把缺通道伪装成空内容）。
   */
  protected override async readMember(
    ctx: HostContext, rel: string, mode: 'content' | 'size', statTimes?: Map<string, number>,
  ): Promise<{ data: Uint8Array; sizeBytes: number; contentHash: string }> {
    const homeFs = ctx.homeFs;
    if (homeFs === undefined) throw new Error(engineMsg('adapter.pluginDataNoOsHome'));
    return super.readMember({ ...ctx, fs: homeFs }, rel, mode, statTimes);
  }

  override async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<FilesSection>> {
    this.pendingWarnings = [];
    const out = await super.export(ctx, options);
    return { ...out, warnings: [...out.warnings, ...this.pendingWarnings] };
  }

  override async preview(ctx: HostContext, options: ExportOptions): Promise<SectionPreview<FilesSection>> {
    this.pendingWarnings = [];
    const out = await super.preview(ctx, options);
    return {
      ...out,
      section: { ...out.section, warnings: [...out.section.warnings, ...this.pendingWarnings] },
    };
  }

  /**
   * 导入分析 + **写入路径白名单**（本分区唯一的越界防线）。
   *
   * 判据：路径必须是本机可解析的某个区域（内置来源，或已安装插件的自述声明）之下，且未被该区域
   * 的 excludeRel 排除。不满足 → Error（计划里可见、执行期不写），绝不「尽力而为」地写出去。
   */
  override async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    // 宿主没有系统 home 门面（旧宿主）→ 白名单为空 + 目标读也换不了根：**全部拒绝**并说明原因。
    // 绝不退回 $DSH_HOME 的 ctx.fs 去比对/写入（那会落到错误位置）。
    const homeFs = ctx.target.homeFs;
    const entries = homeFs === undefined ? [] : await this.allowedEntries(ctx.target);
    const items = await super.analyzeImport(
      data,
      homeFs === undefined ? ctx : { ...ctx, target: { ...ctx.target, fs: homeFs } },
    );
    return items.map((item) => {
      const ref = item.target?.ref;
      if (ref === undefined) return item;
      const rel = normalizeHomeRel(ref);
      if (rel !== null && areaOfPath(entries, rel) !== null) return item;
      return {
        id: item.id,
        ...(item.unitId !== undefined ? { unitId: item.unitId } : {}),
        kind: 'Error',
        adapter: this.id,
        description: engineMsg(
          homeFs === undefined ? 'adapter.pluginDataNoOsHome' : 'adapter.pluginDataPathNotAllowed',
          { path: ref },
        ),
        severity: 'error',
      };
    });
  }

  /** 应用前再查一遍白名单（纵深防御：plan 可能来自消费者手工构造/缓存反序列化） */
  override async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const homeFs = ctx.target.homeFs;
    if (homeFs === undefined) {
      return { ok: false, message: engineMsg('adapter.pluginDataNoOsHome') };
    }
    const ref = item.target?.ref;
    if (ref !== undefined) {
      const rel = normalizeHomeRel(ref);
      const entries = await this.allowedEntries(ctx.target);
      if (rel === null || areaOfPath(entries, rel) === null) {
        return { ok: false, message: engineMsg('adapter.pluginDataPathNotAllowed', { path: ref }) };
      }
    }
    return super.applyItem(item, { ...ctx, target: { ...ctx.target, fs: homeFs } });
  }
}
