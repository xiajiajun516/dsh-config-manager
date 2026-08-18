/**
 * m-sync-ui (P2b)：SyncHistoryView 的纯函数投影。
 *
 * 现状：本地祖先快照目录（manifest.json）→ SnapshotHistoryEntry；倒序排序 + ISO 格式化。
 * 方案 A 扩展：/sync/history 现返回 { entries: SyncHistoryEntry[] }（快照 kind=apply
 * + 自动同步 kind=autosync），投影需统一处理两源，并生成自动同步跳过冲突的可读明细。
 */
import type { AutosyncHistoryEntry, SyncHistoryEntry } from './sync-api.ts';

/** 兼容旧快照条目（manifest.json 投影）。 */
export interface SnapshotHistoryEntry {
  id: string;
  createdAt: string;
  /** 分区数（manifest.sectionHashes 的 key 数） */
  sectionCount: number;
  /** 关联到该快照的待审项数（来自 sync-review-queue.json 中的 items） */
  reviewCount: number;
}

/** 把快照 entries 排序（createdAt 倒序）并组装展示字段。 */
export function projectHistoryRows(entries: readonly SnapshotHistoryEntry[]): SnapshotHistoryEntry[] {
  return [...entries].sort(byCreatedAtDesc);
}

/** 统一历史条目（快照 + 自动同步）按 createdAt 倒序排序。 */
export function projectSyncHistoryEntries(entries: readonly SyncHistoryEntry[]): SyncHistoryEntry[] {
  return [...entries].sort(byCreatedAtDesc);
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** ISO 时间 → 本地可读字符串（短格式） */
export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------------------------------------------------------- 自动同步记录投影 */

/** 自动同步执行记录的方向可读标签。 */
export function directionLabel(direction: AutosyncHistoryEntry['direction']): string {
  switch (direction) {
    case 'pull': return '下载';
    case 'push': return '上传';
    default: return '双向';
  }
}

/** 自动同步执行状态可读标签。 */
export function autosyncStatusLabel(status: AutosyncHistoryEntry['status']): string {
  switch (status) {
    case 'success': return '成功';
    case 'skipped': return '已跳过';
    case 'partial': return '部分成功';
    default: return '失败';
  }
}

/** 跳过原因 → 可读描述（host 透传语义；未知原因回退原串）。 */
export function describeSkipReason(reason: string | undefined): string {
  switch (reason) {
    case 'conflict': return '冲突项被跳过';
    case 'no-remote': return '远端无快照';
    case 'not-configured': return '未配置仓库';
    case 'network': return '网络问题';
    case 'encrypted': return '远端快照已加密，自动同步跳过（请手动同步）';
    default: return reason ?? '未知';
  }
}

/** 把一条自动同步记录投影为展示行（摘要文本 + 可展开的被跳过冲突分区明细）。 */
export interface AutosyncHistoryRow {
  id: string;
  createdAt: string;
  direction: string;
  status: string;
  /** 摘要行文本（如「下载 · 已跳过 · 冲突项被跳过」）。 */
  summary: string;
  /** 被跳过的冲突分区 id（展开明细用）；无则 undefined。 */
  conflictedSections?: string[];
  /** 实际应用的分区 id。 */
  appliedSections?: string[];
  error?: string;
  notifiedAt?: string;
  /** 是否有关联的跳过分区明细可展开。 */
  hasDetail: boolean;
}

/** 自动同步记录 → 展示行投影。 */
export function projectAutosyncEntry(entry: AutosyncHistoryEntry): AutosyncHistoryRow {
  const parts: string[] = [directionLabel(entry.direction), autosyncStatusLabel(entry.status)];
  if (entry.skipReason !== undefined) parts.push(describeSkipReason(entry.skipReason));
  return {
    id: entry.createdAt,
    createdAt: entry.createdAt,
    direction: directionLabel(entry.direction),
    status: autosyncStatusLabel(entry.status),
    summary: parts.join(' · '),
    conflictedSections: entry.conflictedSections,
    appliedSections: entry.appliedSections,
    error: entry.error,
    notifiedAt: entry.notifiedAt,
    hasDetail:
      (entry.conflictedSections !== undefined && entry.conflictedSections.length > 0) ||
      (entry.appliedSections !== undefined && entry.appliedSections.length > 0) ||
      entry.error !== undefined,
  };
}
