/**
 * self 分区 adapter（插件自身配置，设计「self 分区」）：
 * 数据源 = $DSH_HOME/dsh-config-manager/ 下的插件自身配置文件（白名单收集，非递归）：
 *   - sync/sync-selection.json  同步分区选择（默认/高级模式 + 勾选分区）
 *   - sync/ui-prefs.json        插件 UI 偏好（如上次选择的同步通道；从 localStorage 迁入）
 *   - sync/backup-schedule.json 备份调度配置
 *   - market/market-config.json 配置市场配置
 *   - exports/.backup-notes.json 导出产物备注清单
 *
 * **可信边界（SEC-01）**：`sync/sync-config.json` 与 `sync/sync-autosync.json` 是「同步目标」本身，
 * 永不可由**包**决定 —— 一个把 repoUrl 指向攻击者仓库的包，导入完用户下一次同步就把家目录配置
 * 推过去。它们不在白名单里（不导出），导入侧另由 `SELF_IMPORT_BLOCKED_RELS` 显式挡下并留 warning。
 *
 * 排除项：sync/sync-history.json（执行记录，属数据非配置）、market/cache/（缓存）、
 * snapshots/（快照）、tmp/ exports/（临时/导出产物）、rollback-points/（回滚点库——磁盘体检
 * 会统计它，但它是**数据**不是配置）、checkpoints/（遗留旧检查点库，已不再读取，也不删）
 * ——只备份「配置」，不备份数据。
 *
 * 与磁盘体检（`src/core/disk-usage.ts`）的关系：那边新增统计 `rollback-points` / 遗留
 * `checkpoints` **不改变本分区的载荷**——本清单是白名单（`SELF_CONFIG_FILES`），
 * 被统计的目录一律不在其中，既不重复也不遗漏（守卫见 `self.test.ts`）。
 *
 * 实现：继承 FileCollectionAdapter 复用 analyzeImport/applyItem/validate（幂等 hash 比对、
 * 快照/回滚路径一致）；**清单来自覆写的 listRelPaths()（白名单），export() 与 preview() 都经
 * 基类 collect()**（self 目录内存在大量非配置子目录，不能像 skills/sessions 那样整体递归）。
 *
 * **例外：两个调度配置的身份字节见覆写的 comparableContent()** —— sync-autosync.json /
 * backup-schedule.json 内含每次执行收尾都被改写的运行态字段（lastRunAt / lastRunStatus /
 * lastRunHistoryId / consecutiveFailures …），整文件哈希会恒判 Conflict（每轮同步都重现，
 * 用户点「应用」还会把远端陈旧运行态倒灌回本机；issue #73）；同一批字段还会让 self 分区
 * 的 hashSection 每轮都变 —— 自动同步的「本地有改动」检测因此**永远为真**，每次远端轮询
 * （缺省 60s）都真推一个新快照（issue #127：真机 41 次/天、内容仅差一个 lastRunAt）。
 * 现在这份字节同时用于导出载荷与哈希（见基类 collect()），运行态只留在本机文件里。
 *
 * 为什么必须靠 listRelPaths() 而不是覆写 export() 来收窄（2026-10 真机报告）：
 * `preview()` / `listRelPaths()` 是后来才加进基类的。本类此前只覆写 export()，于是只读预览
 * 落到基类的目录递归 —— 把整个 $DSH_HOME/dsh-config-manager（快照、config-snapshots、
 * sync/work 的 Git 工作副本与远端快照、transactions、exports、遗留 profiles）都当成该分区的
 * 可勾选单元：实测 2460 个文件 / 11.44 MB，而真实导出只有 6 个文件 / 1936 B；界面上
 * 「插件自身配置 已选 2460/2460 11.5 MB」即由此而来。同款缺陷已在 agent-instructions.ts 踩过
 * 并修复（那边 baseDir='' 时更夸张：把整个 home 当该分区）。覆写 listRelPaths() 让两条路径
 * 共用同一份清单 —— 这正是基类 preview() 存在的意义。
 *
 * relativePath 一律是「相对 baseDir」的路径（如 sync/sync-config.json），与
 * FileCollectionAdapter 的基准目录语义一致：导入时按 path.join(baseDir, rel) 写回
 * $DSH_HOME/dsh-config-manager/<rel>；ZIP 内位于 self/<rel>。
 *
 * 安全不变量：配置文件本身不含凭据值（同步凭据走 DSH credentials 槽位引用），
 * 且文件类分区不进 SecretScanner（与 pluginFiles/skills 同语义）。
 */
import type { ApplyResult, HostContext, ImportContext, PlanItem } from '../core/types.ts';
import type { FilesSection } from '../schema/types.ts';
import type { AutosyncConfig } from '../sync/autosync-config.ts';
import type { BackupScheduleConfig } from '../sync/backup-schedule-config.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { FileCollectionAdapter } from './file-collection.ts';

/**
 * self 分区白名单文件（相对 baseDir，即 $DSH_HOME/dsh-config-manager/）。
 *
 * `sync/sync-config.json` 与 `sync/sync-autosync.json` **不在其中**（SEC-01）：同步目标与自动同步开关
 * 属于「目标机自己的决定」，跨机搬运等于让包决定把本机配置推到哪里。白名单只管导出侧；
 * 导入侧的包内容不受白名单约束，所以另有 `SELF_IMPORT_BLOCKED_RELS` 显式挡下。
 */
export const SELF_CONFIG_FILES: readonly string[] = [
  'sync/sync-selection.json',
  'sync/ui-prefs.json',
  'sync/backup-schedule.json',
  'market/market-config.json',
  // P0-④：导出产物备注清单（exports/.backup-notes.json）——随 self 分区迁移，
  // 换机器后备份列表仍能看到手动导出时填写的备注
  'exports/.backup-notes.json',
];

/**
 * 导入侧**一律不写盘**的 rel（SEC-01）。
 *
 * 与白名单的关系：白名单管「导出带什么」，本清单管「包里有也绝不落地」。两者故意不共用一份
 * 数组 —— 白名单将来若因别的理由重新收进某个文件，也不该连带解除导入侧的保护。
 */
export const SELF_IMPORT_BLOCKED_RELS: readonly string[] = [
  'sync/sync-config.json',
  'sync/sync-autosync.json',
];

/**
 * 分档案作用域（`sync-profiles/<profile>/`）里**同一类**文件：SEC-01 必须按模式挡。
 *
 * 档案名是运行时集合（用户随时能建新档案），无法列举成数组；而这些文件与 `sync/` 下那两份
 * 语义完全相同 —— 都是「同步目标 / 自动同步开关」，导入一个指向攻击者仓库的包后，用户下次
 * 同步就会把该档案的配置推过去。`SELF_CONFIG_FILES` 白名单本就不含 `sync-profiles/`（导出侧
 * 从不搬别人的档案作用域），这里补的是导入侧的纵深防御。
 */
const SELF_IMPORT_BLOCKED_PATTERNS: readonly RegExp[] = [
  /^sync-profiles\/[A-Za-z0-9][A-Za-z0-9._-]*\/sync-config\.json$/,
  /^sync-profiles\/[A-Za-z0-9][A-Za-z0-9._-]*\/sync-autosync\.json$/,
];

/** SEC-01 判据（单一入口）：精确 rel 或分档案作用域里的同语义文件，一律不落地。 */
export function isSelfImportBlocked(rel: string): boolean {
  return SELF_IMPORT_BLOCKED_RELS.includes(rel) || SELF_IMPORT_BLOCKED_PATTERNS.some((pattern) => pattern.test(rel))
}

/**
 * 拦截报告项里的**稳定机器码**前缀（`self-import-blocked:<rel>`）。
 *
 * 为什么要有码而不是只给文案：文案随语言/措辞变，调用方（报告、日志、将来的自动判定）需要
 * 一个能逐字比对的判据。
 */
export const SELF_IMPORT_BLOCKED_CODE = "self-import-blocked";

/**
 * 调度配置里「运行态字段」的**命名口径**：调度器每轮收尾都会改写的字段名形状
 * （`lastRun*` 一族 + `consecutiveFailures`）。剔除表必须覆盖两个调度配置的并集，
 * 少一个都会让 self 分区的 hashSection 每轮翻新（issue #119）。
 */
type RunStateKeyOf<T> = {
  [K in keyof T]-?: K extends 'consecutiveFailures' | `lastRun${string}` ? K : never;
}[keyof T];

type SchedulerRunStateKey = RunStateKeyOf<AutosyncConfig> | RunStateKeyOf<BackupScheduleConfig>;

/**
 * 调度配置里的**运行态字段**：每次执行收尾都会被调度器改写，不属于「配置身份」。
 * 仅比对时剔除（见 comparableContent）；写盘仍写完整文件。
 *
 * 逐项列全而不是靠前缀过滤：前缀过滤会把**将来**新增的运行态字段静默吞掉（看不见的假 Skip），
 * 漏列则让 hash 每轮翻新（issue #119）。所以列全 + 下面的穷尽断言，让编译器守住漂移。
 */
const VOLATILE_RUN_STATE_KEY_LIST = [
  'lastRunAt',
  'lastRunStatus',
  'lastRunMessage',
  'lastRunHistoryId',
  'consecutiveFailures',
  // issue #119：跳过码每轮在「写入 / 清空」之间翻转，与 lastRunAt 同性质，漏剔即每轮真推快照
  'lastRunSkipReason',
  'lastRunSkipCount',
] as const satisfies readonly SchedulerRunStateKey[];

const VOLATILE_RUN_STATE_KEYS: ReadonlySet<string> = new Set(VOLATILE_RUN_STATE_KEY_LIST);

/**
 * 编译期穷尽断言（零运行时开销）：`AutosyncConfig` / `BackupScheduleConfig` 将来新增任何
 * `lastRun*` 字段而没进上表时，`Exclude` 不再是 `never`，**这一行 typecheck 报错**。
 * 只写 `satisfies keyof T` 挡不住「新增字段忘了加」——那正是 issue #119 的失效模式。
 */
type AssertExhaustive<T extends never> = T;

/** 见 AssertExhaustive 的注释；导出只为让断言参与类型检查（无需被引用）。 */
export type SchedulerRunStateKeysExhaustive = AssertExhaustive<
  Exclude<SchedulerRunStateKey, (typeof VOLATILE_RUN_STATE_KEY_LIST)[number]>
>;

/** 含运行态字段的调度配置（相对 baseDir）。 */
const SCHEDULER_CONFIG_RELS: ReadonlySet<string> = new Set([
  'sync/sync-autosync.json',
  'sync/backup-schedule.json',
]);

/** 递归剔除运行态键（sync-autosync v2 的 channels.git / channels.webdav 是嵌套对象）。 */
function stripRunState(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripRunState);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (VOLATILE_RUN_STATE_KEYS.has(key)) continue;
    out[key] = stripRunState(value);
  }
  return out;
}

/** 键排序的稳定序列化：两边键序不同（手改过的文件）时不应凭空判 Conflict。 */
function stableStringify(node: unknown): string {
  if (Array.isArray(node)) return '[' + node.map(stableStringify).join(',') + ']';
  if (node === null || typeof node !== 'object') return JSON.stringify(node) ?? 'null';
  const entries = Object.entries(node as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

/**
 * 剔除运行态后的规范化 JSON 字节；解析不出 JSON（或顶层不是对象）→ null。
 * **null = 「判不出可比形态」**，调用方回落原字节按整文件哈希处理 —— 不猜。
 */
function canonicalizeWithoutRunState(raw: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return new TextEncoder().encode(stableStringify(stripRunState(parsed)));
}

export class SelfAdapter extends FileCollectionAdapter {
  readonly id = 'self' as const;
  readonly displayName = sectionMeta('self').displayName;
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 插件自身配置目录（相对 homeDir；宿主按 dataDir 解析注入，缺省 dsh-config-manager） */
  readonly baseDir: string;

  constructor(baseDir = 'dsh-config-manager') {
    super();
    this.baseDir = baseDir;
  }

  /** self 的白名单文件彼此独立（同步配置 / 市场配置 / UI 偏好…），不构成 bundle
   *  → 覆写为「逐文件单元」，用户可以只带走其中几项。 */
  protected override unitIdOf(relativePath: string): string {
    return relativePath;
  }

  /**
   * 清单枚举 = **白名单文件**（覆写基类的目录递归）。
   *
   * 为什么必须覆写：self 目录下并存着插件自身的数据（snapshots/、config-snapshots/、
   * sync/work/ 的 Git 工作副本与远端快照、transactions/、exports/、遗留 profiles/），
   * 整目录递归会把它们全部当成「可勾选单元」（实测本机 2460 个文件 / 11.44 MB）。
   * 覆写后 export()（基类 collect，content 模式）与 preview()（size 模式）拿到**同一份清单**，
   * 选择器显示的条目/体积与真实导出逐项一致。
   *
   * 存在性判定优先 statSize（只 stat；白名单最多 7 个文件）；旧宿主未实现时退回读一次文件
   * （单文件代价可忽略，且 collect 之后还要读它）。读不到 / 未创建 → 跳过，
   * 与「文件不存在 = 非白名单命中」同语义（如从未配置市场/同步）。
   *
   * 路径一律用 POSIX 分隔符拼：relativePath 是**备份格式的一部分**（ZIP 内为 self/<rel>），
   * 同时是单元 id（self:<rel>）与 includeItems 的比对键 —— 不能随平台漂移成反斜杠。
   */
  protected override async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    const empty: RecursiveListing = { paths: [], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };
    const found: string[] = [];
    for (const rel of SELF_CONFIG_FILES) {
      const full = `${this.baseDir}/${rel}`;
      try {
        if (ctx.fs.statSize !== undefined) {
          if ((await ctx.fs.statSize(full)) === null) continue;
        } else {
          await ctx.fs.readFile(full);
        }
        found.push(full);
      } catch {
        // 未创建过的配置文件跳过
      }
    }
    return { ...empty, paths: found };
  }

  /**
   * 幂等比对口径：两个调度配置剔除**运行态字段**后比对，其余白名单文件保持整文件哈希。
   *
   * 为什么必要（issue #73）：sync-autosync.json 由调度器在每次执行收尾改写
   * lastRunAt / lastRunStatus / lastRunMessage / lastRunHistoryId / consecutiveFailures
   * （src/sync/autosync-scheduler.ts），backup-schedule.json 同理（backup-scheduler）。
   * 整文件 SHA-256 因此永远与远端不同 → 每轮同步都重现一条 self 分区的 Conflict，
   * 且用户点「应用」会把远端的陈旧运行态倒灌回本机。
   * 剔除后：**仅运行态不同 → Skip**（什么都不写，本机运行态保留）；
   * 配置本体（enabled / interval / startupMinIntervalMs / customSchedule / retention …）不同 → 仍是 Conflict。
   *
   * 其余白名单文件（sync-config / sync-selection / ui-prefs / market-config / .backup-notes）
   * 已核实不含易变字段，保持内容寻址的整文件哈希。
   * 解析不出 JSON 时原样返回 —— 「判不出来」按整文件哈希处理，绝不猜。
   */
  protected override comparableContent(relativePath: string, data: Uint8Array): Uint8Array {
    if (!SCHEDULER_CONFIG_RELS.has(relativePath)) return data;
    // 回落原引用（解析失败 / 非对象）：走整文件哈希，且不额外重算包内哈希
    return canonicalizeWithoutRunState(data) ?? data;
  }

  /**
   * 导入侧拦截（SEC-01）：包里带 `sync/sync-config.json` / `sync/sync-autosync.json` → 改判 Warning。
   *
   * 为什么必须在**计划阶段**改判而不是只在 applyItem 里拒绝：这两份文件是「同步目标」本身，
   * 一个把 repoUrl 指向攻击者仓库的包，导入完用户下一次同步就会把本机配置推过去 —— 而用户
   * 从来没被问过「要不要换同步目标」。去掉 `target` 后引擎不会为它登记快照、也不会调 applyItem；
   * 同时留下一项 report 级 warning（带稳定码 `self-import-blocked:<rel>`），让用户看得见
   * 「包里有这个文件、我没写」，绝不静默。
   */
  override async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items = await super.analyzeImport(data, ctx);
    return items.map((item) => {
      const rel = item.target?.ref;
      if (rel === undefined || !isSelfImportBlocked(rel)) return item;
      const blocked: PlanItem = {
        id: item.id,
        kind: 'Warning',
        adapter: this.id,
        description: ctx.msg('adapter.selfImportBlocked', { path: rel }),
        detail: `${SELF_IMPORT_BLOCKED_CODE}:${rel}`,
        severity: 'warning',
      };
      if (item.unitId !== undefined) blocked.unitId = item.unitId;
      return blocked;
    });
  }

  /**
   * 纵深防御（SEC-01）：即使有人绕过引擎直接把被拦项喂进 applyItem，也一字节都不写。
   * 报 warning=true（非致命、不触发整体回滚），与计划阶段的判定同源。
   */
  override async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (ref !== undefined && isSelfImportBlocked(ref)) {
      return { ok: false, message: ctx.msg('adapter.selfImportBlocked', { path: ref }), warning: true };
    }
    return super.applyItem(item, ctx);
  }
}