/**
 * m-sync-flow：写基线的唯一实现（本地祖先副本 + sync-state）。
 *
 * 为什么单独成模块：这段逻辑是「祖先副本布局 + 远端指针 + 每分区 hash + 裁剪」的完整落盘决策，
 * 不需要引擎的任何其他状态（只吃快照目录、通道身份与时间）；留在 SyncEngine 里会顶穿体量棘轮。
 *
 * **两个 id 语义严格分开（P0-7），不要再混用同一个字段**：
 * - `snapshotId`：本次基线的**本地**快照对象 id，同时是本地祖先副本的目录名（写入 `ancestorId`）；
 * - `opts.remoteSnapshotId`：该基线在**远端**对应的快照 id（写入 `lastSnapshotId`）。缺省 = snapshotId
 *   （push 路径两者天然相同）；合并/应用路径**必须显式传**，否则 lastSnapshotId 会退化成「一个远端
 *   并不存在的本地 id」→ hasNewRemoteSnapshot() 恒判「远端有新生」，每轮白跑 list + download + merge。
 *   传入 `''` 表示「远端 id 未知」——宁可留空，也不要把本地 id 冒充成远端 id。
 *
 * **issue #140 / G-44（C 组更新）**：`opts.remoteSections` 是**远端观测**（远端快照自己携带的分区哈希），
 * 与传入的 `sections`（本机观测，用来算 hasLocalChanges 的基线）是两个不同来源。
 * `push()` 传入刚上传的明文分区哈希；`merge() -> applyMergePlan()` 在非加密且指针前进时也必须传入
 * 本次合并所用远端快照的 `remoteSections`（而不是由 `landed` 本机观测推导，否则既违反 G-44，缺传又会
 * 触发下方指针变更分支 `delete state.lastRemoteSections` 导致退化回 id 比较）。
 * 早先的事故正是「一参两用」：拿本机 hash 当远端现状，判定就永远自洽、永远看不出远端真的变了。
 */
import type { Platform, SectionData, SectionId } from '../schema/types.ts';
import type { MsgFunc } from '../core/messages.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import { DEFAULT_ANCESTOR_KEEP, pruneAncestors, writeAncestor, writeEncryptedAncestor } from './ancestor.ts';
import type { SnapshotFs } from './fs.ts';
import { encryptSectionsPayload } from './snapshot-crypto.ts';
import { hashSection, loadSyncState, saveSyncState } from './sync-state.ts';
import type { PendingMerge, SectionHashes } from './sync-state.ts';
import type { SyncSnapshot } from './transport.ts';

export interface RecordBaselineOptions {
  writeAncestor?: boolean;
  /** 提供即把祖先副本写成**密文**（密码仅本次内存使用；issue #107） */
  ancestorPassword?: string;
  remoteSnapshotId?: string;
  /** 保留当前祖先副本与 ancestorId（缺省 false = 既有行为逐字不变） */
  preserveAncestor?: boolean;
  /** 待裁决冲突记录：null = 清除；缺省 = 不动该字段 */
  pendingMerge?: PendingMerge | null;
  /** P1-5：本轮**实际带走**的会话单元（提供即覆盖；缺省 = 保留原记录） */
  sessionUnits?: string[];
  /** P1-5：本轮累积的删除墓碑（提供即覆盖；缺省 = 保留原记录） */
  deletedSessions?: string[];
  /**
   * issue #140：本次基线对应的**远端观测**（远端快照实际携带的分区哈希，G-44）。
   *
   * - 提供且非空 ⇒ 原样记录（只允许来自「真的看到了远端 sections」的调用点）；
   * - 提供但为空（加密快照）或未提供 ⇒ 指针若发生变化则**删除**既有观测（未知 ⇒ 判定回落 id）；
   * - 指针未变（preserveAncestor 的待裁决冲突）⇒ 保留既有观测（远端没动，观测仍成立）。
   * 绝不允许由传入的 `sections`（本机观测）推导。
   */
  remoteSections?: SectionHashes;
  /**
   * 写新祖先副本目录时使用的载荷（缺省 = `sections`）。
   * 冲突扣下只推送非冲突分区时，新远端快照带了远端版本，但本机新祖先副本仍需保留被扣/未应用
   * 分区的共同祖先内容，后续预览/三方合并才不会退化成「无祖先」。
   */
  ancestorSections?: Partial<Record<SectionId, SectionData>>;
}

/** 落盘所需的环境（引擎逐字段透传；此处不持有引擎实例）。 */
export interface RecordBaselineEnv {
  fsx: SnapshotFs;
  stateDir: string;
  localSnapshotsDir?: string;
  dshVersion: string;
  platform: Platform;
  transport: { type: string; ref: string };
  now: () => Date;
  msg: MsgFunc;
}

export interface RecordBaselineInput {
  snapshotId: string;
  /** 基线**恒为明文**（加密快照的基线 hash 也用明文算，供 hasLocalChanges 比较）。 */
  sections: Partial<Record<SectionId, SectionData>>;
  nowIso?: string;
  opts?: RecordBaselineOptions;
  env: RecordBaselineEnv;
}

export async function recordBaseline(input: RecordBaselineInput): Promise<void> {
  const { snapshotId, sections, env } = input;
  const opts = input.opts ?? {};
  const ts = input.nowIso ?? env.now().toISOString();
  const preserveAncestor = opts.preserveAncestor === true;
  const ancestorPassword = opts.ancestorPassword;
  const encryptedAncestor = ancestorPassword !== undefined && ancestorPassword !== '';
  const writesAncestorCopy = !preserveAncestor && env.localSnapshotsDir !== undefined && opts.writeAncestor !== false;

  // 1) 写本地祖先副本（如有 localSnapshotsDir）。
  //    ancestorPassword 提供 → 落**密文**祖先副本（issue #107：加密通道也能做三方合并）；
  //    否则落明文散文件布局（既有行为逐字不变）。
  if (writesAncestorCopy && env.localSnapshotsDir !== undefined) {
    const manifest: SyncSnapshot['manifest'] = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dshVersion: env.dshVersion,
      platform: env.platform,
      sectionIds: Object.keys(sections) as SectionId[],
      containsSecrets: false,
      // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
      transport: env.transport.type,
      ...(encryptedAncestor ? { encrypted: true } : {}),
    };
    if (encryptedAncestor) {
      const encryptedSections = await encryptSectionsPayload(opts.ancestorSections ?? sections, ancestorPassword);
      await writeEncryptedAncestor(env.localSnapshotsDir, { id: snapshotId, createdAt: ts, manifest, sections: encryptedSections }, env.fsx);
    } else {
      await writeAncestor(env.localSnapshotsDir, { id: snapshotId, createdAt: ts, manifest, sections: opts.ancestorSections ?? sections }, env.fsx);
    }
  }

  // 2) 更新 sync-state：远端指针 + 本地祖先目录名 + 每分区 hash/updatedAt + lastSyncAt + transport
  const state = await loadSyncState(env.stateDir, env.fsx, env.msg);
  const previousPointer = state.lastSnapshotId;
  state.lastSnapshotId = opts.remoteSnapshotId ?? snapshotId;
  // issue #140（G-44）：远端观测只认调用方显式给出的「远端快照 sections」。
  // 指针变了却拿不到观测 ⇒ 删除（下一轮判定回落 id 比较），绝不沿用上一份观测冒充现状。
  if (opts.remoteSections !== undefined) {
    if (Object.keys(opts.remoteSections).length > 0) state.lastRemoteSections = { ...opts.remoteSections };
    else delete state.lastRemoteSections;
  } else if (state.lastSnapshotId !== previousPointer) {
    delete state.lastRemoteSections;
  }
  // preserveAncestor：祖先目录名一并保持不动（既不是 snapshotId，也不是 ''）
  if (!preserveAncestor) state.ancestorId = writesAncestorCopy ? snapshotId : '';
  state.lastSyncAt = ts;
  state.transport = { type: env.transport.type, ref: env.transport.ref };
  // 基线纪律：null = 清除（全部裁决完）；undefined = 不动该字段（既有调用方零感知）
  if (opts.pendingMerge === null) delete state.pendingMerge;
  else if (opts.pendingMerge !== undefined) state.pendingMerge = opts.pendingMerge;
  // P1-5：只在调用方明确提供时覆盖（否则保留既有记录，绝不因某条路径不跟踪而清空）
  if (opts.sessionUnits !== undefined) state.sessionUnits = [...opts.sessionUnits];
  if (opts.deletedSessions !== undefined) state.deletedSessions = [...opts.deletedSessions];
  for (const [sid, data] of Object.entries(sections)) {
    state.sections[sid as SectionId] = { hash: hashSection(data as SectionData), updatedAt: ts };
  }
  await saveSyncState(env.stateDir, state, env.fsx);

  // 3) 裁剪祖先副本（最近 N 个）；preserveAncestor 时本轮没有新副本，不参与裁剪
  if (!preserveAncestor && env.localSnapshotsDir !== undefined) {
    await pruneAncestors(env.localSnapshotsDir, DEFAULT_ANCESTOR_KEEP, env.fsx);
  }
}
