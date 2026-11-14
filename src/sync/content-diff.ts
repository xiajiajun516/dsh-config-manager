/**
 * issue #140：同步内容的**唯一**判定点（拉取与推送共用）。
 *
 * 为什么需要它：id 只是「哪一次推送」，与「内容是否相同」是两件事。
 *  - 拉取侧只比 id ⇒ 远端每次新 id（哪怕分区哈希逐字相同）都会被判成「有新生」，白跑
 *    download + 三方合并；合并后内容没变，下一轮又来一次。
 *  - 推送侧每次生成新 id ⇒ 内容没变也 upload、也建目录、也推进远端保留链。
 *
 * 判据（三条，缺一不可）：
 *  1. 只比**分区哈希集合**，不比 manifest（createdAt/deviceId/dshVersion 天然不同）；
 *  2. 键集也必须相等：远端有而对照侧没有的分区算「变了」（否则「多推了一个分区」会被漏判）；
 *  3. 任一观测缺失 ⇒ `unknown`，由调用方**回落**到 id 比较 —— 绝不把「读不到」猜成「没变」
 *     （加密快照的 sections 恒为空对象，就是这条的主要来源）。
 *
 * G-44（docs/known-issues/known-gaps.md）：对照侧必须是「上次记录下来的**远端**观测」
 * （sync-state.lastRemoteSections），或本次调用自己刚导出的本地载荷。
 * 绝不允许拿 sync-state.sections（本机文件 hash，可能含本机未推送的改动）当远端观测 ——
 * 一参两用会让「本机改过、远端没改」被判成「远端变过」，拉取侧每轮空转。
 */
import type { SectionData, SectionId } from '../schema/types.ts';
import type { SyncSnapshotMeta } from './transport.ts';
import { hashSection } from './sync-state.ts';
import type { SectionHashes } from './sync-state.ts';

/** 判定结论的三种取值（`unknown` 不是失败，是「没有可用观测」） */
export type ContentDiffReason = 'same-content' | 'content-changed' | 'unknown';

export interface ContentDiffResult {
  /** `unknown` 恒为 false —— 调用方必须自己决定回落策略，绝不能把它当「变了」或「没变」 */
  changed: boolean;
  reason: ContentDiffReason;
}

/** 分区导出载荷 → 分区哈希（推送上行 / 本地观测共用；与 sync-state 记的基线同口径） */
export function hashSections(sections: Partial<Record<SectionId, SectionData>>): SectionHashes {
  const out: SectionHashes = {};
  for (const [sid, data] of Object.entries(sections)) {
    if (data === undefined) continue;
    out[sid as SectionId] = hashSection(data);
  }
  return out;
}

/** 是否「有观测」（undefined / 空对象都算没有：空集合无法证伪任何内容） */
function hasObservation(hashes: SectionHashes | undefined | null): hashes is SectionHashes {
  return hashes !== undefined && hashes !== null && Object.keys(hashes).length > 0;
}

/**
 * 远端快照内容 vs 对照观测（`local` 优先，缺省用 `baseline`）。
 *
 * @param remote 远端快照元数据（transport.list() 的元素；`undefined` = 远端没有快照/列表读不到）
 * @param baseline 上次记录的**远端**分区哈希（sync-state.lastRemoteSections）
 * @param local 本次刚导出的本地分区哈希（推送路径用；拉取路径不传）
 */
export function diffSnapshotContent(
  remote: SyncSnapshotMeta | undefined | null,
  baseline: SectionHashes | undefined | null,
  local?: SectionHashes | null,
): ContentDiffResult {
  const reference = local ?? baseline;
  if (remote === undefined || remote === null) return { changed: false, reason: 'unknown' };
  const remoteHashes = remote.sections;
  // 加密快照的 sections 恒为空对象（transport.ts:53-55）→ 无从比较，回落 id。
  if (!hasObservation(remoteHashes)) return { changed: false, reason: 'unknown' };
  if (!hasObservation(reference)) return { changed: false, reason: 'unknown' };

  // 键集对称：任一侧缺键都算内容变了（新增/收窄分区的推送必须产生新快照）。
  for (const sid of Object.keys(remoteHashes) as SectionId[]) {
    const recorded = reference[sid];
    if (recorded === undefined || recorded !== remoteHashes[sid]) {
      return { changed: true, reason: 'content-changed' };
    }
  }
  for (const sid of Object.keys(reference) as SectionId[]) {
    if (remoteHashes[sid] === undefined) return { changed: true, reason: 'content-changed' };
  }
  return { changed: false, reason: 'same-content' };
}
