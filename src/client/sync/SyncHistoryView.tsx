/**
 * 同步历史视图（方案 A）：列出本地祖先快照目录（kind=apply）+ 自动同步执行记录
 * （kind=autosync）。自动同步行显示时间/方向/状态/跳过冲突/应用分区，点开可看被跳过
 * 冲突分区明细。
 *
 * 数据获取：GET /sync/history → { entries: SyncHistoryEntry[] }（按 createdAt 倒序合并）。
 * 纯函数投影在 ./history-model.ts（node --test 可测），本组件只做装配。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Badge, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import type { SyncApi, SyncHistoryEntry, AutosyncHistoryEntry } from './sync-api.ts'
import {
  describeSkipReason, directionLabel, formatDateTime, projectAutosyncEntry,
  projectSyncHistoryEntries,
} from './history-model.ts'
import type { SnapshotHistoryEntry } from './history-model.ts'
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

/** 通道徽章：git → GitHub，webdav → WebDAV；未知/缺失不渲染。 */
function ChannelBadge({ transport, t }: { transport?: string; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  if (transport === 'git') return <Badge kind="info">{t('history.channelGit')}</Badge>
  if (transport === 'webdav') return <Badge kind="info">{t('history.channelWebdav')}</Badge>
  return null
}

export interface SyncHistoryViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

export function SyncHistoryView(props: SyncHistoryViewProps): ReactNode {
  const { api, t } = props;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  /** 重试计数（错误态点「重试」递增 → 重新加载） */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await api.history();
        if (!cancelled) {
          setEntries(data.entries);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, reloadKey]);

  const rows = useMemo(() => projectSyncHistoryEntries(entries), [entries]);
  // 快照类条目（兼容旧投影；仅统计展示）
  const snapshotRows = useMemo<SnapshotHistoryEntry[]>(
    () => rows
      .filter((r) => r.kind === 'apply' || r.kind === 'push' || r.kind === 'pull' || r.kind === 'rollback')
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        sectionCount: r.sectionCount ?? 0,
        reviewCount: r.reviewCount ?? 0,
      })),
    [rows],
  );

  if (loading) return <Spinner label={t('common.loading')} />;
  if (error) {
    return (
      <ErrorBanner
        error={error}
        onRetry={() => { setReloadKey((k) => k + 1) }}
        retrying={loading}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <strong>{t('history.empty')}</strong>
        <p>{t('history.emptyHint')}</p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle title={`${t('history.title')}（${rows.length}）`} />
      <table className="sync-history-table">
        <thead>
          <tr><th>{t('history.colTime')}</th><th>{t('history.colKind')}</th><th>{t('history.colDetail')}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.kind === 'autosync' && r.autosync !== undefined) {
              return <AutosyncRow key={r.id} entry={r.autosync} t={t} />;
            }
            const snap = snapshotRows.find((s) => s.id === r.id);
            return (
              <tr key={r.id}>
                <td>{formatDateTime(r.createdAt)}</td>
                <td><Badge kind="info">{t('history.kindSnapshot')}</Badge></td>
                <td>
                  <ChannelBadge transport={r.transport} t={t} />
                  <code>{r.id}</code>
                  {snap !== undefined && <> · {snap.sectionCount} {t('history.sectionCount')}</>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/* ---------------------------------------------------------------- 自动同步行 */

interface AutosyncRowProps {
  entry: AutosyncHistoryEntry
  t: TranslateNS<'config-manager-sync'>
}

function AutosyncRow({ entry, t }: AutosyncRowProps): ReactNode {
  const row = projectAutosyncEntry(entry);
  return (
    <tr>
      <td>{formatDateTime(row.createdAt)}</td>
      <td><Badge kind="info">{t('history.kindAutosync')}</Badge></td>
      <td>
        <div>
          <ChannelBadge transport={entry.transport} t={t} />
          {row.summary}
          {entry.pushedSnapshotId !== undefined && <> · {t('history.autosyncPush')} {entry.pushedSnapshotId}</>}
          {entry.pulledSnapshotId !== undefined && <> · {t('history.autosyncPull')} {entry.pulledSnapshotId}</>}
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
              {row.error !== undefined && (
                <div><span className={css.fieldLabel}>{t('history.autosyncError', { error: '' })}</span>{row.error}</div>
              )}
            </div>
          </details>
        )}
      </td>
    </tr>
  );
}
