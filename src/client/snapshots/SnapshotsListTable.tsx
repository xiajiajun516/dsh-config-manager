/**
 * 快照列表数据表（t43 从 SnapshotsPanel.tsx 物理拆出）：
 *  - 保留策略提示（分母由调用方按宿主权威策略算好传入，本文件不读 store）；
 *  - 数据表：行可选中（listbox 语义 + 选中淡底，与 aria-selected 同步）、行内 pin/delete。
 * 纯展示组件：选中/置顶/删除经 props 注入（删除的二次确认仍在面板层）；文案全部来自既有字典键。
 */
import type { SnapshotMeta } from '../../core/restore.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button } from '../common/ui.tsx'
import { snapshotStatusBadgeKind, snapshotStatusLabelKey } from '../../ui/snapshots-view.ts'
import css from '../config-manager.module.css'

export function SnapshotsListTable({ t, metas, selectedId, managing, retentionLimit, onSelect, onTogglePin, onRequestDelete }: {
  t: TranslateNS<'config-manager'>
  metas: SnapshotMeta[]
  selectedId: string | null
  /** 删除/置顶请求进行中（行内按钮禁用，防重复提交） */
  managing: boolean
  /** m-retention：宿主真实保留策略的 keepLast（提示文案的分母） */
  retentionLimit: number
  onSelect: (id: string) => void
  onTogglePin: (meta: SnapshotMeta) => void
  onRequestDelete: (meta: SnapshotMeta) => void
}) {
  return (
    <>
          <div className={css.hint} style={{ marginBottom: 8 }}>
            {/* m-retention：分母取宿主真实策略（可配置）；宿主未返回时回退缺省常量 */}
            {t('snapshots.retentionHint', {
              count: String(retentionLimit),
            })}
          </div>
          <div className={css.tableWrap}>
            <div className={css.tableScroll}>
              <table className={`${css.dataTable} ${css.tableFixed}`}>
                <thead>
                  <tr>
                    <th style={{ width: 118 }}>{t('snapshots.createdAt')}</th>
                    <th>{t('snapshots.sourceZip')}</th>
                    <th style={{ width: 68 }}>{t('snapshots.status')}</th>
                    <th className={css.num} style={{ width: 46 }}>{t('snapshots.entries')}</th>
                    <th className={css.num} style={{ width: 46 }}>{t('snapshots.plugins')}</th>
                    <th className={css.cellActions} style={{ width: 120 }}>{t('snapshots.actions')}</th>
                  </tr>
                </thead>
                <tbody role="listbox" aria-label={t('snapshots.selectHint')}>
                  {metas.map((meta) => {
                    const selected = meta.id === selectedId
                    return (
                      <tr
                        key={meta.id}
                        role="option"
                        aria-selected={selected}
                        /* 选中淡底：DESIGN.md 数据表 pattern（.dataTable tbody tr[data-selected]），
                           须与 aria-selected 同步给出，否则 listbox 选中态只剩语义没有视觉反馈 */
                        data-selected={selected ? '' : undefined}
                        style={{ cursor: 'pointer' }}
                        tabIndex={0}
                        onClick={() => { onSelect(meta.id) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onSelect(meta.id)
                          }
                        }}
                      >
                        <td>
                          <span title={meta.id}>
                            {meta.pinned === true && '📌 '}{new Date(meta.createdAt).toLocaleString()}
                          </span>
                        </td>
                        <td className={css.dim}>
                          <span className={css.mono} title={meta.sourceZip} style={{ fontSize: '11px' }}>{meta.sourceZip}</span>
                        </td>
                        <td><Badge kind={snapshotStatusBadgeKind(meta.status)}>{t(snapshotStatusLabelKey(meta.status))}</Badge></td>
                        <td className={css.num}>{meta.entryCount}</td>
                        <td className={css.num}>{meta.beforePluginCount}</td>
                        <td className={css.cellActions}>
                          <span className={css.rowActions}>
                            <Button size="sm" disabled={managing} onClick={() => { onTogglePin(meta) }}>
                              {meta.pinned === true ? t('snapshots.unpin') : t('snapshots.pin')}
                            </Button>
                            <Button size="sm" variant="danger" disabled={managing} onClick={() => { onRequestDelete(meta) }}>
                              {t('snapshots.delete')}
                            </Button>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
    </>
  )
}
