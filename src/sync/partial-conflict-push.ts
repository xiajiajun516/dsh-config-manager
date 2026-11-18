/**
 * G 项：冲突扣下（skipSections + pendingMerge 已评估远端快照）时的部分推送拼装（纯逻辑）。
 *
 * 设计意图：当远端最新快照 `latest` 已被本机 merge() 评估过（`stateBefore.pendingMerge.remoteSnapshotId === latest`），
 * 仅冲突/扣下分区在 wait-for-user，而其余本地分区有干净改动时：
 *  - 不能因为 `latest !== lastSnapshotId` 整轮拒绝推送（否则非冲突分区永不上传）；
 *  - 也不能直接上传缺分区的快照（否则远端最新快照丢掉被扣分区或覆盖另一台机器未合并分区）；
 *  - 因此把远端最新快照里「被扣下」与「仅远端修改而本机未动」的分区原样带进新快照，仅以本机值写入
 *    真正推动的干净分区，并同步保留共同祖先内容给 `ancestorSections`，使后续三方合并与预览完全无损。
 */
import type { SectionData, SectionId } from '../schema/types.ts';
import { hashSection, type SyncState } from './sync-state.ts';
import { isEncryptedSections, type SyncSnapshot } from './transport.ts';

/** 检查候选非冲突导出中是否至少有一个分区相对本机基线确有变化。 */
export function hasLocalDirtyTarget(
  plainSections: Readonly<Partial<Record<SectionId, SectionData>>>,
  baseline: Readonly<Partial<Record<SectionId, { hash: string }>>>,
): boolean {
  for (const [sid, data] of Object.entries(plainSections)) {
    if (data === undefined) continue;
    const prevHash = baseline[sid as SectionId]?.hash;
    if (prevHash === undefined || hashSection(data) !== prevHash) return true;
  }
  return false;
}

export type PartialConflictPushPlan =
  | { ok: false }
  | {
    ok: true;
    /** 本次真正用本地内容写进远端且要更新 state.sections 的分区 */
    pushedSections: Partial<Record<SectionId, SectionData>>;
    /** 上传到远端的新快照完整 sections（本地推送 ∪ 沿用远端） */
    snapshotSections: Partial<Record<SectionId, SectionData>>;
    /** 写进本地新祖先副本目录的 sections（保留被扣分区的原共同祖先内容） */
    ancestorSections: Partial<Record<SectionId, SectionData>>;
  };

/**
 * 在已评估远端快照 `remoteSnap` 的前提下，构造不冲突分区的部分推送快照。
 * - 若远端快照加密、或出现未扣下分区的双侧并发修改，保守返回 `{ ok: false }`（交由 precheck 拒绝）。
 */
export function buildConflictIsolatedSnapshot(input: {
  held: readonly SectionId[];
  plainSections: Readonly<Partial<Record<SectionId, SectionData>>>;
  stateBefore: SyncState;
  remoteSnap: SyncSnapshot;
  prevAncestor?: SyncSnapshot;
}): PartialConflictPushPlan {
  const { held, plainSections, stateBefore, remoteSnap, prevAncestor } = input;
  if (remoteSnap.manifest.encrypted === true || isEncryptedSections(remoteSnap.sections)) {
    return { ok: false };
  }
  const heldSet = new Set<SectionId>(held);
  const pushedSections: Partial<Record<SectionId, SectionData>> = { ...plainSections };
  const snapshotSections: Partial<Record<SectionId, SectionData>> = {};

  for (const [rawId, remoteData] of Object.entries(remoteSnap.sections)) {
    if (remoteData === undefined) continue;
    const sid = rawId as SectionId;
    const remoteHash = hashSection(remoteData as SectionData);
    const knownRemoteHash = stateBefore.lastRemoteSections?.[sid] ?? stateBefore.sections[sid]?.hash;
    const remoteChanged = knownRemoteHash === undefined ? true : remoteHash !== knownRemoteHash;
    const localData = plainSections[sid];

    if (heldSet.has(sid) || localData === undefined) {
      snapshotSections[sid] = remoteData as SectionData;
      delete pushedSections[sid];
      continue;
    }

    const baseHash = stateBefore.sections[sid]?.hash;
    const localChanged = baseHash === undefined || hashSection(localData) !== baseHash;
    if (remoteChanged) {
      // 非扣下分区在远端也变了：若本地亦改动则属未裁决双侧冲突 → 拒绝绕过；若本地未动则保留远端新版、不动本机基线
      if (localChanged) return { ok: false };
      snapshotSections[sid] = remoteData as SectionData;
      delete pushedSections[sid];
    }
  }

  for (const [rawId, localData] of Object.entries(pushedSections)) {
    if (localData === undefined) continue;
    snapshotSections[rawId as SectionId] = localData;
  }

  // 若过滤「仅远端变更」后已没有任何本地真推送的分区，不再上传空推快照
  if (!hasLocalDirtyTarget(pushedSections, stateBefore.sections)) {
    return { ok: false };
  }

  const prevAncestorSections = prevAncestor !== undefined && !isEncryptedSections(prevAncestor.sections)
    ? (prevAncestor.sections as Partial<Record<SectionId, SectionData>>)
    : {};
  const ancestorSections: Partial<Record<SectionId, SectionData>> = { ...pushedSections };
  for (const [rawId, ancData] of Object.entries(prevAncestorSections)) {
    const sid = rawId as SectionId;
    if (ancestorSections[sid] === undefined && ancData !== undefined) {
      ancestorSections[sid] = ancData;
    }
  }

  return { ok: true, pushedSections, snapshotSections, ancestorSections };
}
