/**
 * m-sync-ui (P2b)：SyncHistoryView 的纯函数投影。
 *
 * 现状：本地祖先快照目录（manifest.json）→ SnapshotHistoryEntry；倒序排序 + ISO 格式化。
 * 方案 A 扩展：/sync/history 现返回 { entries: SyncHistoryEntry[] }（快照 kind=apply
 * + 自动同步 kind=autosync），投影需统一处理两源，并生成自动同步跳过冲突的可读明细。
 */
import type { AutosyncHistoryEntry, SyncHistoryEntry } from './sync-api.ts'
// 跳过原因码 → 字典键的映射键类型（**type-only**：不把 zh/en 目录按值带进本条 import）
import type { SyncKey } from './sync-locales.ts'
import type { TranslateNS } from '../client-types.ts'

/** 同步命名空间翻译器（本文件的标签一律走它 —— 硬编码中文在英文界面下会原样透出）。 */
export type SyncTranslate = TranslateNS<'config-manager-sync'>;

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

/**
 * ISO 时间 → 完整本地时间字符串（含秒，用于 td 的 title 悬停提示）。
 * 非法/空输入回退 ''（不渲染 title，避免出现无意义的提示）。
 */
export function formatDateTimeFull(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/* ---------------------------------------------------------------- 自动同步记录投影 */

/**
 * 自动同步执行记录的方向可读标签。
 *
 * client-F1：文案一律走字典（history.autosyncPull/Push/Both 早已存在且英文值就绪）——
 * 此前返回硬编码中文，英文界面下这一格恒为中文。
 */
export function directionLabel(direction: AutosyncHistoryEntry['direction'], t: SyncTranslate): string {
  switch (direction) {
    case 'pull': return t('history.autosyncPull');
    case 'push': return t('history.autosyncPush');
    default: return t('history.autosyncBoth');
  }
}

/** 自动同步执行状态可读标签（client-F1：走 autosync.* 字典键）。 */
export function autosyncStatusLabel(status: AutosyncHistoryEntry['status'], t: SyncTranslate): string {
  switch (status) {
    case 'success': return t('autosync.success');
    case 'skipped': return t('autosync.skipped');
    case 'partial': return t('autosync.partial');
    default: return t('autosync.failed');
  }
}

/**
 * 跳过原因 → 可读描述（host 透传语义；未知原因回退原串）。
 *
 * client-F1（本次收口）：conflict / no-remote / not-configured / network / encrypted /
 * mutation-locked / conflict-kept-local / 未知 **八类全部**走 history.autosyncReason* 字典键 —— 此前部分码是
 * 硬编码中文（sync-locales.ts 当时不可写），英文界面下会原样透出。
 */
export function skipReasonKey(reason: string | undefined): SyncKey | null {
  switch (reason) {
    case 'conflict': return 'history.autosyncReasonConflict';
    case 'no-remote': return 'history.autosyncReasonNoRemote';
    case 'not-configured':
    // issue #79：宿主同一语义两处命名（历史写 'unconfigured'，旧口径是 'not-configured'）→ 同一文案
    case 'unconfigured': return 'history.autosyncReasonNotConfigured';
    case 'network': return 'history.autosyncReasonNetwork';
    case 'encrypted': return 'history.autosyncReasonEncrypted';
    // issue #79：状态行新增两类（无变化 / 已是最新）——此前会落到 default 渲染裸码
    case 'upToDate': return 'history.autosyncReasonUpToDate';
    case 'unchanged': return 'history.autosyncReasonUnchanged';
    // issue #31：宿主侧的分类锁判定（LOCKED/STALE/UNKNOWN）统一以 'mutation-locked' 落历史，
    // 客户端拿不到细分 reason → 文案必须同时覆盖「活锁占用」与「残留锁需回收」两种可能，
    // 并给出可操作方向（否则界面只显示裸 token，用户无从判断要不要处理）。
    case 'mutation-locked': return 'history.autosyncReasonMutationLocked';
    // 真·自动同步（conflictPolicy='local'）：冲突已按策略「保留本机并推上去」消解，
    // 远端那一版被覆盖（仍在远端历史快照里，可回滚）—— 必须与「冲突待裁决」分开说。
    case 'conflict-kept-local': return 'history.autosyncReasonConflictKeptLocal';
    // 未知原因：没有字典键（调用方决定回退策略）
    default: return null;
  }
}

/**
 * 跳过原因码 → 可读描述（历史行与自动同步状态行**共用同一份映射**）。
 *
 * 参数取「码 → 文案」的最小取词器（只要吃 SyncKey 即可），这样 UiT / 组件 t / 活目录
 * 三种取词器都能直接传入，不必为了类型对齐再造一个包装。
 */
export function describeSkipReason(reason: string | undefined, t: (key: SyncKey) => string): string {
  const key = skipReasonKey(reason);
  return key === null ? (reason ?? t('history.autosyncReasonUnknown')) : t(key);
}

/** 把一条自动同步记录投影为展示行（摘要文本 + 可展开的被跳过冲突分区明细）。 */
export interface AutosyncHistoryRow {
  id: string;
  createdAt: string;
  direction: string;
  status: string;
  /** 摘要行文本（如「下载 · 已跳过 · 冲突项被跳过」）。 */
  summary: string;
  /** 状态徽章语义色（列表类型列，见 autosyncBadgeKind）。 */
  badgeKind: 'ok' | 'warn' | 'error';
  /** 跳过原因可读文本（列表第二行小字）；无跳过原因则 undefined。 */
  skipReasonText?: string;
  /** 被跳过的冲突分区 id（展开明细用）；无则 undefined。 */
  conflictedSections?: string[];
  /** 实际应用的分区 id。 */
  appliedSections?: string[];
  error?: string;
  notifiedAt?: string;
  /** 是否有关联的跳过分区明细可展开。 */
  hasDetail: boolean;
}

/* ---------------------------------------------------------------- 展示辅助（UI 重构新增） */
/**
 * 中段省略：唯一实现在 `../../ui/mid-ellipsis.ts`（t6 去重——此前本文件自带一份与
 * `ui/snapshots-view.ts`、`HomePanel.tsx`（原 OverviewPanel）逐字相同的实现，默认 `max = 26`）。
 * 此处保留同名再导出，让既有调用点（`./SyncLogList.tsx` 与本目录单测）按原路径引用。
 */
export { midEllipsis } from '../../ui/mid-ellipsis.ts';

/**
 * 自动同步状态 → Badge 语义色。
 * success → ok（成功）/ skipped → warn（被动放弃）/ failed → error / partial → warn（未完整成功）。
 */
export function autosyncBadgeKind(status: AutosyncHistoryEntry['status']): 'ok' | 'warn' | 'error' {
  switch (status) {
    case 'success': return 'ok';
    case 'failed': return 'error';
    // skipped / partial：都不是失败，但都需要用户注意
    default: return 'warn';
  }
}

/** 同步历史统计摘要（列表头部徽章行）。 */
export interface SyncHistorySummary {
  total: number;
  snapshots: number;
  autosync: number;
  failed: number;
  skipped: number;
}

/**
 * 统计同步历史条目。基于 projectSyncHistoryEntries 的投影结果（本函数不排序）。
 * - snapshots：apply / push / pull / rollback（快照类）
 * - autosync：kind='autosync' 的条目数
 * - failed：自动同步 status='failed'（含 error）
 * - skipped：自动同步 status='skipped' 或 'partial'（部分成功也计入「需注意」）
 */
export function summarizeSyncHistory(rows: readonly SyncHistoryEntry[]): SyncHistorySummary {
  let snapshots = 0;
  let autosync = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.kind === 'autosync') {
      autosync += 1;
      const status = r.autosync?.status;
      if (status === 'failed') failed += 1;
      else if (status === 'skipped' || status === 'partial') skipped += 1;
    } else {
      snapshots += 1;
    }
  }
  return { total: rows.length, snapshots, autosync, failed, skipped };
}

/** 自动同步记录 → 展示行投影（client-F1：全部标签经 t 取字典）。 */
export function projectAutosyncEntry(entry: AutosyncHistoryEntry, t: SyncTranslate): AutosyncHistoryRow {
  const parts: string[] = [directionLabel(entry.direction, t), autosyncStatusLabel(entry.status, t)];
  if (entry.skipReason !== undefined) parts.push(describeSkipReason(entry.skipReason, t));
  return {
    id: entry.createdAt,
    createdAt: entry.createdAt,
    direction: directionLabel(entry.direction, t),
    status: autosyncStatusLabel(entry.status, t),
    summary: parts.join(' · '),
    badgeKind: autosyncBadgeKind(entry.status),
    // E：跳过原因从摘要串里拆出来，单独走第二行小字（摘要串保留以兼容既有测试/调用方）
    skipReasonText: entry.skipReason !== undefined ? describeSkipReason(entry.skipReason, t) : undefined,
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
