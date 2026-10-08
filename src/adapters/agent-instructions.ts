/**
 * agentInstructions 分区 adapter（设计 §3.3 / dsh-agent-instructions 插件）：
 * 数据源 = ~/.dsh/AGENTS.md（用户全局指令文件，dsh-agent-instructions 固定读取 $DSH_HOME/AGENTS.md，
 * 注入每个会话的基线指令）。
 *
 * 与 skills/agentPresets 的差异：AGENTS.md 位于 $DSH_HOME 根目录，**不能对 homeDir 整目录递归枚举**，
 * 因此覆写 `listRelPaths()` 返回单文件白名单（而不是目录扫描）。
 * 仅迁移全局文件；项目级 AGENTS.md / CLAUDE.md 属于各项目仓库，默认不迁（研究报告 §2.2 同策略）。
 * baseDir = ''（homeDir 根），与 core/backup.ts FILE_BASES 的 '' 基准一致，保证通用快照/回滚路径正确。
 *
 * 2026-09 修复（真机报告「总览/导出页变慢」）：本类此前只覆写了 `export()`（单文件），
 * 却让 v0.1.68 新增的 `preview()` 走了基类的 `collect()` → 对 `baseDir=''` 递归**整个 $DSH_HOME**
 * （实测 4.8 s / 4016 个文件 / 242 MB，且选择器冒出 21 个假单元：profiles、sessions、attachments…）。
 * 现在 `export()` 与 `preview()` 都经 `collect()`，但清单来自同一个 `listRelPaths()` 白名单
 * —— 既快，又保证「预览说的」与「导出做的」逐项一致（这正是基类 preview() 的存在意义）。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import type { HostContext } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { sectionMeta } from '../schema/section-registry.ts';

export class AgentInstructionsAdapter extends FileCollectionAdapter {
  readonly id = 'agentInstructions' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('agentInstructions').displayName;
  readonly defaultIncluded = sectionMeta('agentInstructions').defaultIncluded;
  readonly portability = sectionMeta('agentInstructions').portability;
  readonly baseDir = '';

  /** 用户全局指令文件（相对 homeDir；同时是 schema 端该分区唯一的文件） */
  static readonly FILE = 'AGENTS.md';

  /**
   * 清单枚举 = **单文件白名单**（覆写基类的目录递归）。
   *
   * 为什么必须覆写：`baseDir` 是 ''（AGENTS.md 在 `$DSH_HOME` 根），基类会对整个 home 递归
   * —— 4.8 s、4016 个文件，并把 `profiles/`/`sessions/` 等无关目录当成该分区的单元。
   *
   * 存在性判定优先走 `statSize`（只 stat）；门面未实现（旧宿主 / 测试 mock）时退回读一次文件
   * （单文件代价可忽略，且 `collect` 之后还要读它）。读不到 → 空清单（与「文件不存在 = 空分区」同语义）。
   */
  protected override async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    const empty: RecursiveListing = { paths: [], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };
    const rel = AgentInstructionsAdapter.FILE;
    try {
      if (ctx.fs.statSize !== undefined) {
        return (await ctx.fs.statSize(rel)) === null ? empty : { ...empty, paths: [rel] };
      }
      await ctx.fs.readFile(rel);
      return { ...empty, paths: [rel] };
    } catch {
      return empty;
    }
  }
}
