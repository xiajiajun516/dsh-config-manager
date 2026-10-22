/**
 * m-sync-flow：共同祖先快照存储助手。
 * 与 push 落盘的 localSnapshotsDir 共用目录布局；按 snapshotId 读写、按 createdAt 保留最近 N 个。
 * 纯逻辑 + 可注入 fs；不触碰真实 ~/.dsh。
 */
import { createSnapshotFs, joinFs } from './fs.ts';
import { engineMsg } from './messages.ts';
import type { SnapshotFs } from './fs.ts';
import { readSnapshotFromDir, writeSnapshotToDir } from './layout.ts';
import { SNAPSHOT_MANIFEST_FILE } from './layout.ts';
import { isEncryptedSections } from './transport.ts';
import type { SyncSnapshot } from './transport.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

/** 默认保留的祖先快照数量（最旧超出则被裁剪）。 */
export const DEFAULT_ANCESTOR_KEEP = 10;

/** 按 snapshotId 读取祖先快照目录；不存在抛错，不静默降级。 */
export async function loadAncestor(
  localSnapshotsDir: string,
  snapshotId: string,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<SyncSnapshot> {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw new Error(engineMsg('sync.ancestorSnapshotIdRequired'));
  }
  const dir = joinFs(localSnapshotsDir, snapshotId);
  return await readAncestorSnapshot(dir, fsx);
}

/**
 * 同 loadAncestor，但「目录不存在 / 不可读 / 损坏」→ undefined（P0-7 的降级路径，供三方合并用）。
 *
 * 为什么需要它：祖先副本是**可缺失**的 —— 加密快照 push 不落明文副本、副本会被
 * pruneAncestors 裁剪、跨机/手工清理也可能删掉它。此时三方合并应退化为「无祖先」的两方合并
 * （merge.ts：local ≠ remote → 整分区 conflict，交用户在同步 UI 里裁决），而不是把整轮自动同步
 * 打成 failed 并每轮复现（旧实现把祖先目录名存进 lastSnapshotId，加密 push 后下一轮 merge 直接抛
 * 「快照目录缺少 manifest.json」）。具体失败原因不再上报：落到合并结果里就是「分区级 conflict」，
 * 用户可见且可裁决。loadAncestor 的「不存在即抛」契约保持不变（显式读取祖先仍应大声失败）。
 */
export async function tryLoadAncestor(
  localSnapshotsDir: string,
  snapshotId: string,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<SyncSnapshot | undefined> {
  if (typeof snapshotId !== 'string' || snapshotId === '') return undefined;
  try {
    return await readAncestorSnapshot(joinFs(localSnapshotsDir, snapshotId), fsx);
  } catch {
    return undefined;
  }
}

/**
 * 加密祖先副本的密文载荷文件名（issue #107）。
 * 加密快照无法平铺成明文 JSON 分区，因此加密祖先目录 = manifest.json + 这一个密文载荷文件。
 */
export const ENCRYPTED_ANCESTOR_FILE = 'sections.encrypted.json';

/**
 * 读祖先副本目录：manifest.encrypted=true → 读密文单载荷；否则按散文件布局读回明文。
 *
 * 为什么要在这里分派（而不是改 layout.readSnapshotFromDir）：散文件布局对加密快照是**结构性拒绝**
 * （layoutEncryptedDirUnsupported，git 通道的密文单文件布局依赖它）；祖先副本是本地缓存目录，
 * 允许有自己的加密形态，且不该让「本地缓存」把明文布局的契约搞松。
 * 读不出 / 形态不符一律抛错 —— 是否降级为 undefined 由 tryLoadAncestor 决定。
 */
export async function readAncestorSnapshot(
  dir: string,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<SyncSnapshot> {
  const manifestAbs = joinFs(dir, SNAPSHOT_MANIFEST_FILE);
  if (!(await fsx.exists(manifestAbs))) {
    throw new Error(engineMsg('sync.layoutManifestMissing', { file: SNAPSHOT_MANIFEST_FILE, dir }));
  }
  const parsed = parseJsonSafe(Buffer.from(await fsx.readFile(manifestAbs)).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(engineMsg('sync.layoutManifestNotObject'));
  }
  const m = parsed as Record<string, unknown>;
  const manifest = m['manifest'];
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
    && (manifest as Record<string, unknown>)['encrypted'] === true) {
    const payloadAbs = joinFs(dir, ENCRYPTED_ANCESTOR_FILE);
    if (!(await fsx.exists(payloadAbs))) {
      throw new Error(engineMsg('sync.layoutManifestMissing', { file: ENCRYPTED_ANCESTOR_FILE, dir }));
    }
    const payload = parseJsonSafe(Buffer.from(await fsx.readFile(payloadAbs)).toString('utf8'));
    if (!isEncryptedSections(payload)) {
      throw new Error(engineMsg('sync.layoutManifestMissingFields'));
    }
    return {
      id: typeof m['id'] === 'string' ? m['id'] : '',
      createdAt: typeof m['createdAt'] === 'string' ? m['createdAt'] : '',
      manifest: manifest as SyncSnapshot['manifest'],
      sections: payload,
    };
  }
  return await readSnapshotFromDir(dir, fsx);
}

/**
 * 把**加密**祖先副本写入本地目录（issue #107）。
 *
 * 磁盘上只有 manifest.json（manifest.encrypted=true，sectionHashes 为空）+ 单个 AES-GCM 密文载荷；
 * 密码绝不落盘（载荷里只有 salt/iv/authTag 与密文，与远端加密快照同口径）。
 * 目录里有 manifest.json ⇒ 仍被 listAncestors / pruneAncestors 当成普通祖先副本，保留策略不变。
 */
export async function writeEncryptedAncestor(
  localSnapshotsDir: string,
  snapshot: SyncSnapshot,
  fsx: SnapshotFs = createSnapshotFs(),
): Promise<void> {
  if (!isEncryptedSections(snapshot.sections)) {
    // 结构性断言：明文快照必须走 writeAncestor（散文件布局），不得落进密文单载荷形态
    throw new Error(engineMsg('sync.layoutEncryptedDirUnsupported'));
  }
  const dir = joinFs(localSnapshotsDir, snapshot.id);
  await fsx.mkdir(dir);
  const manifest = { id: snapshot.id, createdAt: snapshot.createdAt, manifest: snapshot.manifest, sectionHashes: {} };
  const enc = new TextEncoder();
  await fsx.writeFile(joinFs(dir, SNAPSHOT_MANIFEST_FILE), enc.encode(stringifyJsonSafe(manifest, { space: 2 })));
  await fsx.writeFile(joinFs(dir, ENCRYPTED_ANCESTOR_FILE), enc.encode(stringifyJsonSafe(snapshot.sections, { space: 2 })));
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
