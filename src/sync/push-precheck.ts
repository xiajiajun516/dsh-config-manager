/**
 * push 前置：远端是否已被别的设备推进，以及「是本机自己推的」时收养基线（0.4.1）。
 *
 * 为什么单独成模块：这段判据是「推不推得上去」的唯一闸门，逻辑上只有三条出口
 * （放行 / 告警放行 / 冲突拒绝），却要在 push 里挤掉二十多行 —— 抽出来后
 * `sync-engine.push` 只剩「问一次闸门，拿到基线或冲突文案」。
 *
 * 事故形态（0.3.0 真机）：transport.upload 已成功、recordBaseline 未执行 ⇒ 远端最新快照
 * 就是本机自己那份，而基线还停在旧 id ⇒ 之后每轮都被判「远端被别的设备推进」永久拒绝，
 * 每 60 s 一条失败，用户只能手改 sync-state。判据见 baseline-heal.ts：只有 deviceId 对得上
 * 本机才收养，别的设备（或没有 deviceId 的旧快照）一律照旧拒绝。
 */
import os from 'node:os';
import { adoptOwnRemoteHead } from './baseline-heal.ts';
import type { SnapshotFs } from './fs.ts';
import type { RemoteSnapshotIndex } from './session-tombstones.ts';
import { loadSyncState } from './sync-state.ts';
import type { SyncTransport } from './transport.ts';
import type { MsgFunc } from '../core/messages.ts';

export interface PushBaseOptions {
  stateDir: string;
  fsx: SnapshotFs;
  localSnapshotsDir?: string;
  /** SYN-02：本轮已列过的远端 index（推进检测与墓碑继承共用同一份）。 */
  index: RemoteSnapshotIndex;
  transport: Pick<SyncTransport, 'type'> & { ref: string };
  hostname?: string;
  msg: MsgFunc;
  warnings: string[];
}

export type PushBaseOutcome =
  | { ok: true; base: string; adopted?: string }
  | { ok: false; message: string };

/**
 * 判定本机能否继续推送，返回可用的基线。
 *
 * - 首次同步（没有基线）→ 放行；远端为空 → 放行（没有可比对的快照）。
 * - 读不到远端列表 → **告警放行**（上传本身会再暴露通道问题），绝不把「读不到」当「没变」。
 * - 远端最新快照就是当前基线 → 放行。
 * - 远端最新快照是本机自己推的 → 收养为基线后放行（`adopted` 回传，调用方写进报告）。
 * - 其余（别的设备的改动 / 没有 deviceId 的旧快照）→ 冲突拒绝，给 force 出口。
 */
export async function resolvePushBase(opts: PushBaseOptions): Promise<PushBaseOutcome> {
  const state = await loadSyncState(opts.stateDir, opts.fsx, opts.msg);
  const base = state.lastSnapshotId;
  if (base === '') return { ok: true, base };
  if (opts.index.reason !== undefined) {
    opts.warnings.push(opts.msg('sync.pushAdvanceCheckFailed', { reason: opts.index.reason }));
    return { ok: true, base };
  }
  const metas = opts.index.metas;
  if (metas.length === 0) return { ok: true, base };
  const latest = metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新在末
  if (latest === base) return { ok: true, base };
  const adopted = await adoptOwnRemoteHead({
    stateDir: opts.stateDir,
    fsx: opts.fsx,
    localSnapshotsDir: opts.localSnapshotsDir,
    metas,
    remoteId: latest,
    base,
    transport: opts.transport,
    hostname: opts.hostname ?? os.hostname(),
    msg: opts.msg,
    warnings: opts.warnings,
  });
  if (adopted === null) {
    // 无法安全断言「远端没变」时的保守拒绝：不 upload、不记基线、不改 sync-state。
    return { ok: false, message: opts.msg('sync.pushRemoteAdvanced', { remote: latest, base }) };
  }
  return { ok: true, base: adopted, adopted };
}
