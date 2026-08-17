/**
 * m-sync-ui (P2b)：SyncHistoryView 的纯函数投影。
 */
export interface SnapshotHistoryEntry {
  id: string;
  createdAt: string;
  /** 分区数（manifest.sectionHashes 的 key 数） */
  sectionCount: number;
  /** 关联到该快照的待审项数（来自 sync-review-queue.json 中的 items） */
  reviewCount: number;
}

/** 把 entries 排序（createdAt 倒序）并组装展示字段。 */
export function projectHistoryRows(entries: readonly SnapshotHistoryEntry[]): SnapshotHistoryEntry[] {
  return [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** ISO 时间 → 本地可读字符串（短格式） */
export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
