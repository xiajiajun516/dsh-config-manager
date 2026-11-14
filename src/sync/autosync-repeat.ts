/**
 * 自动同步「同一状态连续轮询」的历史去重签名（P1，2026-11-14 真机事故）。
 *
 * 事故现场：远端出现一份比本地基线新的快照后，60s 远端轮询每轮都得出同一结论
 * （skipReason='conflict' + 同样的 conflictedSections + 同样的「远端已推进」原文），
 * 于是 sync-history 被同一条结论刷满（200 条上限里 196 条完全一样，间隔精确 60s），
 * 首页「最近活动」同步变成每 1 分钟一条的噪音，而真正的冲突分区没有任何新信息。
 *
 * 去重口径（只压「同一件事的重复播报」，不压状态变化）：
 *  - status 'success' / 'failed' 一律**不去重**：upToDate 逐轮记一条是文档化的既有行为
 *    （见 core/migration-history.ts 的 isAutosyncIdleRound 注释），失败必须逐条可见；
 *  - 带 pushedSnapshotId / pulledSnapshotId 的轮次**不去重**：真的推进了远端或本地 = 进度，
 *    每一轮都是不同的事件；
 *  - 其余（skipped / partial）按 channel + status + direction + skipReason + 排序后的
 *    conflictedSections/appliedSections + error 取签名：签名相同 = 同一状态的第 N 轮。
 *
 * 被压掉的轮次仍然会刷新 autosync-config 的 lastRunAt / lastRunStatus / 跳过计数
 * （见 autosync-scheduler.writeFinalConfig），所以界面「上次运行」不会停在旧时间。
 */
import type { AutosyncHistoryEntry } from './sync-history.ts';

/** 参与签名的字段子集（AutosyncHistoryEntry 的只读投影）。 */
export type RepeatSignatureEntry = Pick<
  AutosyncHistoryEntry,
  | 'status'
  | 'direction'
  | 'skipReason'
  | 'conflictedSections'
  | 'appliedSections'
  | 'pushedSnapshotId'
  | 'pulledSnapshotId'
  | 'error'
>;

function sortedList(ids: readonly string[] | undefined): string {
  return ids === undefined ? '' : [...ids].sort().join(',');
}

/**
 * 返回本轮历史签名；null = 本轮必须照常记录（见文件头的不去重清单）。
 * 签名只用于进程内比较，永不落盘，故用 \u0000 分隔以避免字段拼接歧义。
 */
export function repeatHistorySignature(channel: string, entry: RepeatSignatureEntry): string | null {
  if (entry.status === 'success' || entry.status === 'failed') return null;
  if (entry.pushedSnapshotId !== undefined || entry.pulledSnapshotId !== undefined) return null;
  return [
    channel,
    entry.status,
    entry.direction,
    entry.skipReason ?? '',
    sortedList(entry.conflictedSections),
    sortedList(entry.appliedSections),
    entry.error ?? '',
  ].join('\u0000');
}
