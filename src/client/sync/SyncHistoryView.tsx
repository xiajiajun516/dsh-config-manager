/**
 * 同步历史视图（M6，P2b）：列出 localSnapshotsDir 各快照目录的 manifest.json
 * （id + createdAt + sectionHashes）；每行显示：快照 ID、时间、分区数、关联待审数（来自 sync-review-queue.json）。
 *
 * 数据获取：通过 Host 的 IPC 端点（与 SyncSettingsView 同模式）。本组件只负责渲染；
 * 数据加载由宿主 API 提供（不在浏览器侧直接读 fs）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Card, SectionTitle, Spinner } from '../common/ui.tsx'
import type { SyncApi } from './sync-api.ts'
import { projectHistoryRows, formatDateTime } from './history-model.ts'
import type { SnapshotHistoryEntry } from './history-model.ts'

// 纯函数（项目排序、ISO 格式化）放在 ./history-model.ts（node --test 可测）。

export interface SyncHistoryViewProps {
  api: SyncApi
}

export function SyncHistoryView(props: SyncHistoryViewProps): ReactNode {
  const { api } = props;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SnapshotHistoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.history();
        if (!cancelled) {
          setEntries(data);
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
  }, [api]);

  const rows = useMemo(() => projectHistoryRows(entries), [entries]);

  if (loading) return <Spinner label="加载同步历史…" />;
  if (error) return <Card><span className="error">{error}</span></Card>;
  if (rows.length === 0) return <Card><strong>尚无同步历史</strong><p>完成首次 push/pull 后这里会显示快照记录。</p></Card>;

  return (
    <Card>
      <SectionTitle title={`同步历史（${rows.length}）`} />
      <table className="sync-history-table">
        <thead>
          <tr><th>快照 ID</th><th>时间</th><th>分区</th><th>待审</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><code>{r.id}</code></td>
              <td>{formatDateTime(r.createdAt)}</td>
              <td>{r.sectionCount}</td>
              <td>{r.reviewCount > 0 ? <strong>{r.reviewCount}</strong> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
