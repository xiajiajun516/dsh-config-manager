/**
 * 删除墓碑（tombstone）机制（F4）：记录用户明确删除的条目，
 * 导入/恢复时据此过滤，防止「旧备份复活已删条目」。
 *
 * 设计（借鉴 uagent-sync workspace-state-codec）：墓碑按 kind+id 去重，
 * 过滤时把恢复数据里的条目映射为 {kind, id} 键，命中墓碑的条目剔除。
 *
 * 持久化：<dataDir>/tombstones.json（self 分区数据目录 $DSH_HOME/dsh-config-manager/ 下）。
 * 本模块零依赖（不 import node 模块 / 核心层类型），fs 由调用方注入，
 * 纯逻辑可独立测试；dataDir 与文件名形态由调用方保持一致。
 *
 * 安全语义：墓碑文件缺失/损坏一律安全降级为空列表（尽力而为的过滤，
 * 绝不因墓碑文件问题阻塞导入主流程）。
 */

/** 墓碑条目类型：插件 / 技能（skills 分区文件）/ 整个分区 / 其他文件（agentPresets 等文件类分区） */
export type TombstoneKind = 'plugin' | 'skill' | 'section' | 'file';

export interface Tombstone {
  kind: TombstoneKind;
  /** 该类型内的标识：插件 → 包名；技能/文件 → 相对路径；分区 → SectionId */
  id: string;
  /** 删除时间（ISO-8601 UTC） */
  deletedAt: string;
  /** 删除原因（用户可读，可选） */
  reason?: string;
}

/** 墓碑持久化文件名（位于 <dataDir>/ 下） */
export const TOMBSTONES_FILE = 'tombstones.json';

/** 墓碑持久化所需的最小 fs 门面（结构化兼容 HostContext.fs / 测试内存实现） */
export interface TombstoneFs {
  readFile(relPath: string): Promise<Uint8Array>;
  writeFile(relPath: string, data: Uint8Array): Promise<void>;
}

/** 注册墓碑：按 kind+id 去重（同键已存在 → 用新条目替换，保留最新 deletedAt/reason）；返回新数组 */
export function addTombstone(list: Tombstone[], entry: Tombstone): Tombstone[] {
  const idx = list.findIndex((t) => t.kind === entry.kind && t.id === entry.id);
  if (idx === -1) return [...list, entry];
  const next = [...list];
  next[idx] = entry;
  return next;
}

/** 某条目（kind+id）是否已被墓碑覆盖 */
export function isTombstoned(kind: TombstoneKind, id: string, tombstones: readonly Tombstone[]): boolean {
  return tombstones.some((t) => t.kind === kind && t.id === id);
}

/** 过滤 {kind,id} 形态数组：剔除墓碑命中的条目，保留其余（返回新数组，不改原数组）。
 *  非 TombstoneKind 的 kind（如导入计划项的 Install/Update 等）永远不会误命中。 */
export function filterTombstoned<T extends { kind: string; id: string }>(
  items: readonly T[],
  tombstones: readonly Tombstone[],
): T[] {
  if (tombstones.length === 0) return [...items];
  return items.filter((item) => !isTombstoned(item.kind as TombstoneKind, item.id, tombstones));
}

/** 读取 <dataDir>/tombstones.json；文件不存在 / 解析失败 / 结构非法 → []（安全降级，不抛错） */
export async function loadTombstones(fs: TombstoneFs, dataDir: string): Promise<Tombstone[]> {
  try {
    const raw = await fs.readFile(`${dataDir}/${TOMBSTONES_FILE}`);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTombstone);
  } catch {
    return [];
  }
}

/** 写入 <dataDir>/tombstones.json（覆盖写；dataDir 目录由调用方保证可写） */
export async function saveTombstones(fs: TombstoneFs, dataDir: string, list: Tombstone[]): Promise<void> {
  const payload = JSON.stringify(list, null, 2);
  await fs.writeFile(`${dataDir}/${TOMBSTONES_FILE}`, new TextEncoder().encode(payload));
}

/** 形状校验：逐条过滤非法条目（容忍部分损坏，保留合法项） */
function isTombstone(v: unknown): v is Tombstone {
  if (v === null || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    (t['kind'] === 'plugin' || t['kind'] === 'skill' || t['kind'] === 'section' || t['kind'] === 'file')
    && typeof t['id'] === 'string' && t['id'] !== ''
    && typeof t['deletedAt'] === 'string'
  );
}
