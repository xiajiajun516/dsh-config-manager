/**
 * 幽灵会话检测（F5 失效归档清理，对应 dsh-backup-sync 的 sweepArchives 设计）。
 *
 * 背景：会话日志被删除 / 恢复覆盖后，DSH 的归档列表会产生「幽灵归档」——归档 ID
 * 指向已不存在的会话日志，恢复后应识别这些失效归档。
 *
 * dsh-backup-sync 走 ctx.workspaceRegistry.archivedSessionIds + unarchiveSession；
 * 本仓库 HostContext（core/types.ts）未暴露该能力（workspace facade 只有
 * WorkspaceRecord 的 list/write/remove），故按仓库纪律降级为「本地校验」：
 * 把快照/备份记录的会话文件清单与磁盘 sessions 目录实际文件对比，找出
 * 「备份里有、磁盘上已不存在的会话」（幽灵），报告给用户人工确认清理。
 *
 * 本模块只含纯函数（零 IO、零 DSH 运行时依赖），供 restore.ts 与测试使用；
 * 磁盘扫描等副作用放在 restore.ts 内部。
 */
import type { SectionId } from '../schema/types.ts';
import type { SnapshotEntry } from './types.ts';

/** 会话文件目录键提取：把会话相对路径归一为会话目录键 <projectKey>/<sessionId>。
 * 分隔符统一为 '/'（兼容 Windows '\'）；不足两段（无法归一会话目录）返回 null。 */
export function sessionKeyOf(relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const norm = relPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (norm === '') return null;
  const segments = norm.split('/');
  if (segments.length < 2) return null;
  return `${segments[0]}/${segments[1]}`;
}

/**
 * 幽灵会话检测（纯函数）：
 * 期望存在的会话（快照/备份记录的会话条目）在磁盘 sessions 目录已无任何对应文件 → 幽灵。
 *
 * @param sessionIds 快照/备份记录的会话条目（相对 sessions 基准目录的路径，如
 *   'proj-a/s1/session.jsonl.zstd' 或目录键 'proj-a/s1'）
 * @param diskEntries 磁盘 sessions 目录扫描出的实际相对路径（同样相对 sessions 基准目录，
 *   分隔符不限 Windows/Unix）
 * @returns 失效（幽灵）会话键清单（<projectKey>/<sessionId>，去重保序）；
 *   仅磁盘有、备份没有的会话不是幽灵（属备份后新建），不返回。
 */
export function sweepGhostSessions(sessionIds: string[], diskEntries: string[]): string[] {
  const disk = new Set<string>();
  for (const d of diskEntries) {
    const key = sessionKeyOf(d);
    if (key !== null) disk.add(key);
  }
  const ghosts: string[] = [];
  const seen = new Set<string>();
  for (const id of sessionIds) {
    const key = sessionKeyOf(id);
    if (key === null) continue; // 无法归一会话目录的条目不参与判定
    if (!disk.has(key) && !seen.has(key)) {
      seen.add(key);
      ghosts.push(key);
    }
  }
  return ghosts;
}

/** 从快照条目中提取「恢复后应存在于磁盘」的会话文件相对路径（sessions 分区、existed=true）。
 * 仅参与过导入且快照时存在的会话文件才算期望项；existed=false（导入新增、恢复时删除）不算。 */
export function expectedSessionRefs(entries: SnapshotEntry[]): string[] {
  return entries
    .filter((e): e is SnapshotEntry & { kind: 'file' } =>
      e.kind === 'file' && e.adapter === ('sessions' as SectionId) && e.existed === true)
    .map((e) => e.ref);
}
