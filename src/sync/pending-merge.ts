/**
 * 待裁决（pendingMerge）的纯状态写入 —— 2026-11-14 真机事故 P2 的落点。
 *
 * 为什么单独一层：自动同步撞冲突时**刻意不写本地**（scheduler 跳过 Phase B），那条路径需要的
 * 只是「基线纪律的纯状态写入」—— 不要 SyncApplyPlan、不构造临时 ZIP、不碰本机配置、不动祖先副本，
 * 与「没有应用任何分区」时的既有口径逐字一致。从 sync-engine 拆出（体量棘轮，只许下调）。
 */
import { loadSyncState, saveSyncState } from './sync-state.ts';
import type { PendingMerge, SyncState } from './sync-state.ts';
import type { SnapshotFs } from './fs.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { SectionId } from '../schema/types.ts';

/** 落盘依赖（与 SyncEngine 的 stateDir / fsx / msg 同源）。 */
export interface PendingMergeDeps {
  stateDir: string
  fsx: SnapshotFs
  msg: MsgFunc
}

/**
 * 组装待裁决记录：同一远端快照上的连续待裁决**保留首次时间**（界面据此讲「挂了多久」）。
 *
 * 分区取**并集**（issue #146 follow-up）：记录同时是「这轮还要扣下哪些分区」的事实源，
 * 而每轮上报的冲突只是「本轮查出来的那一部分」—— 替换语义会让上一轮的分区凭空消失
 * （连续两轮 [plugins] → [mcp] 后剩 [mcp]，plugins 下一轮就被整分区推上去）。
 * 剔除只发生在「真推上去了」（pendingMergeAfterPush / recordBaseline 的 null）。
 */
export function pendingMergeFor(
  state: SyncState,
  remoteSnapshotId: string,
  sections: SectionId[],
  nowIso: string,
): PendingMerge {
  const prev = state.pendingMerge;
  const same = prev !== undefined && prev.remoteSnapshotId === remoteSnapshotId;
  const since = same ? prev.since : nowIso;
  const merged = same ? [...new Set([...prev.sections, ...sections])] : sections;
  return { remoteSnapshotId, sections: merged, since };
}

/**
 * 基线纪律的**纯状态**写入（不写祖先副本、不碰远端）：仅在本机没有任何配置写入时使用。
 *
 * - pending 提供 → 写 pendingMerge；undefined → 清除该字段（「全部裁决完」）；
 * - advanceRemoteId 提供 → 把远端指针推进到该快照 id（缺省 = 保持不变）。
 *
 * 为什么不走 recordBaseline：那条路径会重建祖先副本并只带本次应用的分区 —— 在「没有应用任何分区」
 * 或「仍有未裁决冲突」时都会把共同基线改坏（下一轮所有分区都退化成「无祖先 → 冲突」）。
 */
export async function writeMergeBaseline(
  deps: PendingMergeDeps,
  opts: { pending?: PendingMerge; advanceRemoteId?: string },
  nowIso: string,
): Promise<void> {
  const state = await loadSyncState(deps.stateDir, deps.fsx, deps.msg);
  if (opts.pending === undefined) delete state.pendingMerge;
  else state.pendingMerge = opts.pending;
  if (opts.advanceRemoteId !== undefined) {
    state.lastSnapshotId = opts.advanceRemoteId;
    state.lastSyncAt = nowIso;
  }
  await saveSyncState(deps.stateDir, state, deps.fsx);
}

/**
 * 把本轮被冲突挡下的分区落成「待裁决」（自动同步冲突分支调用）。
 *
 * - 远端快照 id 取自最近一次 merge()；未知（null）或分区为空 → 返回 null 且**不写**：没有远端 id 的
 *   待裁决无法被后续轮次认成「同一件事」，写进去只会让 since 每轮重置，界面永远说不清「挂了多久」。
 * - since 由 pendingMergeFor 决定：同一远端快照上连续冲突保留首次时间。
 * - 清理归推送成功侧（recordBaseline 带 pendingMerge:null）：本机真推上去了 = 冲突已有结论。
 */
export async function recordPendingMerge(
  deps: PendingMergeDeps,
  remoteSnapshotId: string | null,
  sections: readonly SectionId[],
  nowIso: string,
): Promise<PendingMerge | null> {
  if (remoteSnapshotId === null || sections.length === 0) return null;
  const stateBefore = await loadSyncState(deps.stateDir, deps.fsx, deps.msg);
  const pending = pendingMergeFor(stateBefore, remoteSnapshotId, [...sections], nowIso);
  await writeMergeBaseline(deps, { pending }, nowIso);
  return pending;
}
