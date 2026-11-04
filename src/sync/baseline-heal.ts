/**
 * m-sync-flow：推送基线自愈（0.4.1）。
 *
 * 为什么单独成模块：这段逻辑是「事故形态 → 判据 → 只写 sync-state」的完整决策，
 * 塞在 SyncEngine.push 里会让本就偏大的引擎再涨几十行（体量棘轮），而它本身不需要引擎的
 * 任何其他状态 —— 只吃 (sync-state 目录, 快照元信息, 本机身份)。
 *
 * 事故形态（0.3.0 真机）：push 在「transport.upload 成功」与「recordBaseline 写 sync-state」
 * 之间被打断（退出/崩溃/断电/进程被杀）。远端已经前进、本机基线仍停在上一版，于是后续每一轮
 * 前置推进检测都判定「远端被别的设备推进了」并拒绝推送 —— 用户被**自己推上去的快照**永久锁死，
 * 只能手改 sync-state.json 才能解开。
 *
 * 判据只有一条：远端最新那份快照的 manifest.deviceId == 本机 deviceId。别的设备推进过、
 * 或旧快照没记 deviceId（可能是任何机器）一律不收养，调用方仍按冲突返回 —— 绝不越过别人的改动。
 */
import type { SectionId } from '../schema/types.ts';
import type { MsgFunc } from '../core/messages.ts';
import { joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import { loadSyncState, resolveDeviceIdentity, saveSyncState } from './sync-state.ts';
import type { SyncSnapshotMeta } from './transport.ts';

export interface AdoptOwnRemoteHeadOptions {
  /** sync-state.json 所在目录。 */
  stateDir: string;
  fsx: SnapshotFs;
  /** 本地快照副本目录（祖先来源）；缺省 = 本机没有副本可指。 */
  localSnapshotsDir?: string;
  /** 远端快照列表（已按 createdAt 升序）。 */
  metas: readonly SyncSnapshotMeta[];
  /** 判定为「比基线新」的那份远端快照 id。 */
  remoteId: string;
  /** 本机当前基线（仅用于告警文案）。 */
  base: string;
  /** 本次通道身份（写回 sync-state.transport）。 */
  transport: { type: string; ref: string };
  hostname: string;
  msg: MsgFunc;
  /** 出参：收养说明追加到这里（调用方原样带给用户）。 */
  warnings: string[];
}

/**
 * 把「本机自己推上去、但基线没跟上」的远端最新快照收养为基线。
 *
 * 只写 sync-state：lastSnapshotId / 每分区 hash（取**被收养快照自己**的 sectionHashes，
 * 不是本次导出结果）/ 祖先目录名（本机真有该副本才指过去，没有就保持原祖先 —— 三方合并仍成立，
 * 也不会被写成一个不存在的目录名）。
 *
 * @returns 被收养的快照 id；null = 不满足收养条件（调用方按冲突返回）
 */
export async function adoptOwnRemoteHead(opts: AdoptOwnRemoteHeadOptions): Promise<string | null> {
  const meta = opts.metas.find((m) => m.id === opts.remoteId);
  if (meta === undefined) return null;
  const device = await resolveDeviceIdentity(opts.stateDir, opts.hostname, opts.fsx, opts.msg);
  const remoteDevice = meta.manifest.deviceId;
  if (typeof remoteDevice !== 'string' || remoteDevice === '' || remoteDevice !== device.id) return null;
  const ancestorKnown = opts.localSnapshotsDir !== undefined
    && await opts.fsx.isDir(joinFs(opts.localSnapshotsDir, opts.remoteId));
  const state = await loadSyncState(opts.stateDir, opts.fsx, opts.msg);
  state.lastSnapshotId = opts.remoteId;
  if (ancestorKnown) state.ancestorId = opts.remoteId;
  for (const [sid, hash] of Object.entries(meta.sections)) {
    if (typeof hash !== 'string' || hash === '') continue;
    state.sections[sid as SectionId] = { hash, updatedAt: meta.createdAt };
  }
  state.transport = opts.transport;
  await saveSyncState(opts.stateDir, state, opts.fsx);
  opts.warnings.push(opts.msg(ancestorKnown ? 'sync.pushBaselineAdopted' : 'sync.pushBaselineAdoptedNoAncestor', {
    remote: opts.remoteId,
    base: opts.base,
  }));
  return opts.remoteId;
}
