/**
 * 同步记录（UI v2 §8）—— **只留操作日志**。
 *
 * v1 的 `SyncHistoryView` 是两种行混在一张表里：快照类（apply / push / pull / rollback，
 * 主标识是 UUID）与自动同步类。v2 把**远端快照**搬进了产物库（那边有新鲜度更好的列表），
 * 所以这张表只剩「发生过什么」—— 一次同步、一次自动同步、一次回滚。
 *
 * 由此得到两处简化（不是为简化而简化，是行语义变了）：
 *  - 去掉「类型」列：原来它用来区分「快照 / 自动同步」，现在只剩操作日志，列宽让给明细；
 *  - 时间列从 116px 收到 104px：没有类型列之后整表变窄，时间不再被挤。
 *
 * 渲染模型仍在 `src/ui/sync-history-model.ts`（`projectSyncHistoryEntries` /
 * `summarizeSyncHistory`）—— 本组件只装配，判定一行不改。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SyncApi, SyncHistoryEntry, AutosyncHistoryEntry } from './sync-api.ts'
import {
  formatDateTime, formatDateTimeFull, midEllipsis, projectAutosyncEntry,
  projectSyncHistoryEntries, summarizeSyncHistory,
} from './history-model.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Card, SectionTitle } from '../common/ui.tsx'
import { SkeletonTable } from '../common/Skeleton.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import css from '../config-manager.module.css'

export interface SyncLogListProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

export function SyncLogList({ api, t }: SyncLogListProps): ReactNode {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([])
  /** 重试计数（错误态点「重试」递增 → 重新加载） */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const data = await api.history()
        if (!cancelled) {
          setEntries(data.entries)
          setError(null)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [api, reloadKey])

  const rows = useMemo(() => projectSyncHistoryEntries(entries), [entries])
  const stats = useMemo(() => summarizeSyncHistory(rows), [rows])

  if (loading) return <SkeletonTable label={t('common.loading')} />
  if (error !== null) {
    return (
      <ErrorBanner
        error={error}
        onRetry={() => { setReloadKey((k) => k + 1) }}
        retrying={loading}
        t={api.t}
      />
    )
  }
  if (rows.length === 0) {
    return (
      <Card>
        <strong>{t('history.empty')}</strong>
        <p>{t('history.emptyHint')}</p>
      </Card>
    )
  }

  return (
    <Card>
      <SectionTitle title={t('history.title') + t('common.parens', { text: String(rows.length) })} />
      {/* 头部统计摘要（先扫结论）；失败/跳过仅在存在时出现，并给语义色 */}
      <div className={css.statRow} aria-label={t('history.stats.summary')}>
        <Badge kind="info">{t('history.stats.total', { count: String(stats.total) })}</Badge>
        <Badge kind="info">{t('history.stats.autosync', { count: String(stats.autosync) })}</Badge>
        {stats.failed > 0 && <Badge kind="error">{t('history.stats.failed', { count: String(stats.failed) })}</Badge>}
        {stats.skipped > 0 && <Badge kind="warn">{t('history.stats.skipped', { count: String(stats.skipped) })}</Badge>}
      </div>
      <div className={css.tableWrap}>
        <div className={css.tableScroll}>
          <table className={css.dataTable + ' ' + css.tableFixed + ' ' + css.tableCompact}>
            <thead>
              <tr>
                <th style={{ width: 104 }}>{t('history.colTime')}</th>
                <th>{t('history.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                if (r.kind === 'autosync' && r.autosync !== undefined) {
                  return <AutosyncRow key={r.id} entry={r.autosync} t={t} />
                }
                return <OperationRow key={r.id} row={r} t={t} />
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  )
}

/** 一次人为操作（push / pull / apply / rollback）：时间 + 通道 + 分区数 + 操作 id。 */
function OperationRow({ row, t }: { row: SyncHistoryEntry; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  return (
    <tr>
      {/* 等宽 11px + 固定列宽 → 单行不换行；title 给完整本地时间（含秒） */}
      <td className={css.dim} title={formatDateTimeFull(row.createdAt)}>
        <span className={css.mono} style={{ fontSize: '11px' }}>{formatDateTime(row.createdAt)}</span>
      </td>
      <td>
        <div className={css.cellMain}>
          {/* UUID 中段省略（保留头尾，尾部才是区分信息），title 保留全文 */}
          <span className={css.cellTitle + ' ' + css.mono} title={row.id}>{midEllipsis(row.id)}</span>
          <span className={css.cellMeta}>
            <ChannelBadge transport={row.transport} t={t} />
            {row.sectionCount !== undefined && <>{row.sectionCount} {t('history.sectionCount')}</>}
          </span>
        </div>
      </td>
    </tr>
  )
}

/**
 * 自动同步行：引擎自己跑的同步（push / pull 成对），与人为操作区分开。
 * 全部取值来自 `projectAutosyncEntry` 的投影 —— 本组件不自己拼文案。
 */
function AutosyncRow({ entry, t }: { entry: AutosyncHistoryEntry; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  const row = projectAutosyncEntry(entry, t)
  return (
    <tr>
      {/* 与人为操作行一致的时间呈现（等宽 11px 单行 + title 完整本地时间） */}
      <td className={css.dim} title={formatDateTimeFull(row.createdAt)}>
        <span className={css.mono} style={{ fontSize: '11px' }}>{formatDateTime(row.createdAt)}</span>
      </td>
      <td>
        <div className={css.cellMain}>
          <span className={css.cellTitle}>
            <ChannelBadge transport={entry.transport} t={t} />
            {' '}
            <Badge kind={row.badgeKind}>{t('history.kindAutosync')}</Badge>
            {' '}
            <Badge kind="info">{row.direction}</Badge>
            {' '}
            <Badge kind={row.badgeKind}>{row.status}</Badge>
            {entry.pushedSnapshotId !== undefined && <>{' · '}{t('history.autosyncPush')} <span className={css.mono} title={entry.pushedSnapshotId}>{midEllipsis(entry.pushedSnapshotId)}</span></>}
            {entry.pulledSnapshotId !== undefined && <>{' · '}{t('history.autosyncPull')} <span className={css.mono} title={entry.pulledSnapshotId}>{midEllipsis(entry.pulledSnapshotId)}</span></>}
          </span>
          {/* 第二行小字：跳过原因 / 错误（信息保留，但不挤在主行里） */}
          {row.skipReasonText !== undefined && <span className={css.hint}>{row.skipReasonText}</span>}
          {row.error !== undefined && <span className={css.hint} title={row.error}>{t('history.autosyncError', { error: '' })}{row.error}</span>}
        </div>
        {row.hasDetail && (
          <details>
            <summary>{t('history.detail')}</summary>
            <div className={css.reportList}>
              {row.conflictedSections !== undefined && row.conflictedSections.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('history.autosyncConflicted', { sections: '' })}</span>
                  <div className={css.statRow}>
                    {row.conflictedSections.map((sid) => <Badge key={sid} kind="warn">{sid}</Badge>)}
                  </div>
                </div>
              )}
              {row.appliedSections !== undefined && row.appliedSections.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('history.autosyncApplied', { sections: '' })}</span>
                  <div className={css.statRow}>
                    {row.appliedSections.map((sid) => <Badge key={sid} kind="ok">{sid}</Badge>)}
                  </div>
                </div>
              )}
            </div>
          </details>
        )}
      </td>
    </tr>
  )
}

/** 通道徽章：git → GitHub，webdav → WebDAV；未知/缺失不渲染（不猜）。 */
function ChannelBadge({ transport, t }: { transport?: string; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  if (transport === 'git') return <Badge kind="info">{t('history.channelGit')}</Badge>
  if (transport === 'webdav') return <Badge kind="info">{t('history.channelWebdav')}</Badge>
  return null
}
