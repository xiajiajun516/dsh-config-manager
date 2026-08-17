/**
 * m-sync-flow：共同祖先快照存储助手。
 * 与 push 落盘的 localSnapshotsDir 共用目录布局；按 snapshotId 读写、按 createdAt 保留最近 N 个。
 * 纯逻辑 + 可注入 fs；不触碰真实 ~/.dsh。
 */
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import { readSnapshotFromDir, writeSnapshotToDir } from './layout.ts';
import { SNAPSHOT_MANIFEST_FILE } from './layout.ts';
import type { SyncSnapshot } from './transport.ts';

/** 默认保留的祖先快照数量（最旧超出则被裁剪）。 */
export const DEFAULT_ANCESTOR_KEEP = 10;

/** 按 snapshotId 读取祖先快照目录；不存在抛错，不静默降级。 */
export async function loadAncestor(
  localSnapshotsDir: string,
  snapshotId: string,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<SyncSnapshot> {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw new Error('loadAncestor: snapshotId 不能为空');
  }
  const dir = joinFs(localSnapshotsDir, snapshotId);
  return await readSnapshotFromDir(dir, fsx);
}

/** 把合并后的快照写入本地祖先副本目录（覆盖同名 id）。 */
export async function writeAncestor(
  localSnapshotsDir: string,
  snapshot: SyncSnapshot,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<void> {
  const dir = joinFs(localSnapshotsDir, snapshot.id);
  await writeSnapshotToDir(snapshot, dir, fsx);
}

/** 列出 localSnapshotsDir 下全部祖先快照目录的 (id, createdAt) 对，按 createdAt 升序。 */
export async function listAncestors(
  localSnapshotsDir: string,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<Array<{ id: string; createdAt: string }>> {
  if (!(await fsx.exists(localSnapshotsDir))) return [];
  const names = await fsx.readdir(localSnapshotsDir);
  const out: Array<{ id: string; createdAt: string }> = [];
  for (const name of names) {
    const dir = joinFs(localSnapshotsDir, name);
    const manifestPath = joinFs(dir, SNAPSHOT_MANIFEST_FILE);
    if (!(await fsx.exists(manifestPath))) continue;
    try {
      const raw = Buffer.from(await fsx.readFile(manifestPath)).toString('utf8');
      const parsed = JSON.parse(raw) as { id?: unknown; createdAt?: unknown };
      if (typeof parsed.id === 'string' && typeof parsed.createdAt === 'string') {
        out.push({ id: parsed.id, createdAt: parsed.createdAt });
      }
    } catch {
      // 单个快照目录损坏不影响整体列表
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return out;
}

/** 保留最近 keep 个祖先（按 createdAt 升序的最末 keep 个）；其余删除。
 * keep <= 0 视为保留全部（不做任何删除）。
 * 返回被删除的祖先 id 列表（按 createdAt 升序，即先删最旧）。 */
export async function pruneAncestors(
  localSnapshotsDir: string,
  keep: number = DEFAULT_ANCESTOR_KEEP,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<string[]> {
  const all = await listAncestors(localSnapshotsDir, fsx);
  if (keep <= 0 || all.length <= keep) return [];
  const toRemove = all.slice(0, all.length - keep);
  const removed: string[] = [];
  for (const a of toRemove) {
    await fsx.remove(joinFs(localSnapshotsDir, a.id));
    removed.push(a.id);
  }
  return removed;
}
