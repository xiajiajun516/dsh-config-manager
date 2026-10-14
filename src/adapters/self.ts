/**
 * self 分区 adapter（插件自身配置，设计「self 分区」）：
 * 数据源 = $DSH_HOME/dsh-config-manager/ 下的插件自身配置文件（白名单收集，非递归）：
 *   - sync/sync-config.json     同步通道配置（git repoUrl / webdav url+username；凭据值走 credentials 槽位，不含 secret）
 *   - sync/sync-autosync.json   自动同步调度配置
 *   - sync/sync-selection.json  同步分区选择（默认/高级模式 + 勾选分区）
 *   - sync/ui-prefs.json        插件 UI 偏好（如上次选择的同步通道；从 localStorage 迁入）
 *   - market/market-config.json 配置市场配置
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
 * **例外：两个调度配置的比对口径见覆写的 comparableContent()** —— sync-autosync.json /
 * backup-schedule.json 内含每次执行收尾都被改写的运行态字段，整文件哈希会恒判 Conflict
 * （每轮同步都重现，用户点「应用」还会把远端陈旧运行态倒灌回本机；issue #73）。
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
import type { HostContext } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { FileCollectionAdapter } from './file-collection.ts';

/** self 分区白名单文件（相对 baseDir，即 $DSH_HOME/dsh-config-manager/）。 */
export const SELF_CONFIG_FILES: readonly string[] = [
  'sync/sync-config.json',
  'sync/sync-autosync.json',
  'sync/sync-selection.json',
  'sync/ui-prefs.json',
  'sync/backup-schedule.json',
  'market/market-config.json',
  // P0-④：导出产物备注清单（exports/.backup-notes.json）——随 self 分区迁移，
  // 换机器后备份列表仍能看到手动导出时填写的备注
  'exports/.backup-notes.json',
];

/**
 * 调度配置里的**运行态字段**：每次执行收尾都会被调度器改写，不属于「配置身份」。
 * 仅比对时剔除（见 comparableContent）；写盘仍写完整文件。
 */
const VOLATILE_RUN_STATE_KEYS: ReadonlySet<string> = new Set([
  'lastRunAt', 'lastRunStatus', 'lastRunMessage', 'lastRunHistoryId', 'consecutiveFailures',
]);

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
}