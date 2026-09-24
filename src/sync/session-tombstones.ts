/**
 * m-session-tombstones：会话**删除墓碑**（P1-5）—— 让「本机删掉的对话」不会从旧快照复活。
 *
 * 问题：会话是按快照整体搬运的。机器 A 删掉对话 X 后 push，新快照里自然没有 X，B 拉最新快照
 * 也不会拿到它；但只要 B 之后**显式拉一次更旧的快照**（UI 有历史快照下拉），X 就会被打回 B，
 * 下一次 B push 又把它带回 A —— 删除等于没发生。
 *
 * 方案：把「已删除的会话单元」记成一份**累积**清单（墓碑），随每份快照的 manifest 一起走：
 *  - push 时：上一次推过的会话集合 − 本机现存会话集合 = 本次新删的（外加此前累积的）；
 *    若某条会话又在本机出现（从别处恢复/重新导入）→ **撤销**它的墓碑（有实体就等于没删）。
 *  - pull/preview/merge 时：把远端墓碑命中的会话单元从**将要导入的载荷**里剔除 ——
 *    旧快照因此无法复活已删除的对话；本机已有的那份保持不动（墓碑不删除本机数据，
 *    删除是用户的动作，见 docs 说明）。
 *
 * 边界（必须说清楚，不谎报能力）：
 *  - 墓碑只随快照传播，因此**只拉过旧快照**的机器看不到更新的墓碑（它同样看不到更新的任何东西）；
 *  - 墓碑不触发本机删除：把「对端删了」升级成「本机也删」需要一个不可回滚的破坏性动作，
 *    本次不实现（保留信息可见，不代用户删数据）。
 */
import { sha256Hex } from '../utils/hashing.ts';

/** 会话单元 id 前缀（与 SessionsAdapter.unitIdOf 同口径：`sessions:<projectKey>/<sessionId>`）。 */
export const SESSION_UNIT_PREFIX = 'sessions:';

/** 墓碑上限（FIFO 保留最新 N 条）：防止 manifest 无限膨胀（真机会话库 ~660 条，5000 足够宽裕）。 */
export const MAX_SESSION_TOMBSTONES = 5000;

/** 相对路径 → 会话单元 id（深度不足 2 段 → null；与 core/session-select 的单元口径一致）。 */
export function sessionUnitIdOfPath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.length < 2) return null;
  const project = parts[0] ?? '';
  const session = parts[1] ?? '';
  if (project === '' || session === '') return null;
  return `${SESSION_UNIT_PREFIX}${project}/${session}`;
}

/**
 * 计算下一次的墓碑集合。
 *
 * @param previousUnits 上一次推送**实际带走**的会话单元（'' / 缺省 = 无记录 → 本次检测不到删除）
 * @param localUnits    本机**现存**的会话单元（全量枚举，不是本次勾选）
 * @param previousTombstones 此前累积的墓碑
 * @returns tombstones = 新墓碑全集（去重保序、已撤销的剔除、按上限截断）；
 *          deletedNow = 本次新检测到的删除（供报告/告警）
 */
export function nextSessionTombstones(input: {
  previousUnits: readonly string[];
  localUnits: readonly string[];
  previousTombstones: readonly string[];
  cap?: number;
}): { tombstones: string[]; deletedNow: string[] } {
  const cap = input.cap ?? MAX_SESSION_TOMBSTONES;
  const local = new Set(input.localUnits);
  const deletedNow: string[] = [];
  const seen = new Set<string>();
  for (const unit of input.previousUnits) {
    if (local.has(unit)) continue;   // 本机还在 → 没删
    if (seen.has(unit)) continue;
    seen.add(unit);
    deletedNow.push(unit);
  }
  const merged: string[] = [];
  const pushed = new Set<string>();
  // 先放此前累积的（保序），再放本次新删的
  for (const unit of [...input.previousTombstones, ...deletedNow]) {
    if (unit === '' || pushed.has(unit)) continue;
    pushed.add(unit);
    merged.push(unit);
  }
  // 本机已有实体 → 撤销墓碑（会话从别处恢复/重新导入后就等于没删过）
  const kept = merged.filter((unit) => !local.has(unit));
  return { tombstones: kept.slice(Math.max(kept.length - cap, 0)), deletedNow };
}

/**
 * 把墓碑命中的会话单元从**将要导入的载荷**里剔除。
 *
 * 只认文件类分区的 `{ version: 1, files }` 形态；命中判据是 relativePath 的前两段
 * （= 会话单元），因此一个会话目录下的全部 generation 一起剔除（单元不可拆半）。
 * 没有任何命中 → 原样返回（避免无谓的对象复制）。
 */
export function stripTombstonedUnits(
  section: unknown,
  tombstones: readonly string[],
): { section: unknown; removed: string[] } {
  if (tombstones.length === 0) return { section, removed: [] };
  if (section === null || typeof section !== 'object') return { section, removed: [] };
  const obj = section as { version?: unknown; files?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.files)) return { section, removed: [] };
  const dead = new Set(tombstones);
  const removed: string[] = [];
  const files = obj.files.filter((entry) => {
    const rel = (entry as { relativePath?: unknown } | null | undefined)?.relativePath;
    if (typeof rel !== 'string') return true;
    const unit = sessionUnitIdOfPath(rel);
    if (unit === null || !dead.has(unit)) return true;
    if (!removed.includes(unit)) removed.push(unit);
    return false;
  });
  if (removed.length === 0) return { section, removed: [] };
  return { section: { version: 1, files }, removed };
}

/** 文件类分区载荷（version 1 + files）→ 其中出现的会话单元 id（去重保序）。 */
export function sessionUnitIdsOfSection(section: unknown): string[] {
  if (section === null || typeof section !== 'object') return [];
  const obj = section as { version?: unknown; files?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.files)) return [];
  const out: string[] = [];
  for (const entry of obj.files) {
    const rel = (entry as { relativePath?: unknown } | null | undefined)?.relativePath;
    if (typeof rel !== 'string') continue;
    const unit = sessionUnitIdOfPath(rel);
    if (unit !== null && !out.includes(unit)) out.push(unit);
  }
  return out;
}

/** 内容哈希（用于报告/去重；调用方需要时可对单元清单取指纹）。 */
export function unitSetFingerprint(units: readonly string[]): string {
  return sha256Hex([...units].sort().join('\n'));
}
