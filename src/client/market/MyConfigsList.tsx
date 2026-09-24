/**
 * 「我的配置」已上传列表 —— t49 物理拆分：从 MyConfigsView.tsx 的 renderList 段原样提取，
 * 行为/视觉不变。条目投影（徽章 / 汇总）仍由容器用 my-configs-view.ts 的纯模型装配后传入，
 * 本文件只渲染；行操作一律回调上抛（更新/装回/删除确认/刷新）。
 */
import type { TranslateNS } from '../client-types.ts'
import type { MyItemEntry } from './my-configs-api.ts'
import type { ItemStatusBadge, MyInstallState, MyItemView, MyItemsSummary } from './my-configs-view.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Banner, Button, Card, Empty, Spinner } from '../common/ui.tsx'
import css from '../config-manager.module.css'

/** 列表行（容器用 itemStatusFromHost + toMyItemView 装配） */
export interface MyConfigsListItemView {
  entry: MyItemEntry
  view: MyItemView
  badge: ItemStatusBadge
}

export interface MyConfigsListProps {
  /** 市场字典（与 MyConfigsView 同一个 t） */
  t: TranslateNS<'config-manager-market'>
  /** 已上传条目（受控；null = 尚未加载） */
  myItems: MyItemEntry[] | null
  /** 列表加载错误（已 redact；null = 无） */
  myItemsError: string | null
  /** 列表刷新中 */
  listLoading: boolean
  /** 条目投影行（含状态徽章） */
  itemViews: readonly MyConfigsListItemView[]
  /** 列表汇总（徽章计数） */
  summary: MyItemsSummary
  /** 装回本地状态（仅用于装回按钮的禁用判定） */
  install: MyInstallState | null
  /** 正在删除的条目 id（行级防重复点击） */
  deletingId: string | null
  /** 刷新列表 */
  onRefresh: () => void
  /** 请求删除确认（受控：由容器上抛 MarketPanel） */
  onChangeDeleteConfirm: (id: string | null) => void
  /** 更新条目：预填表单向导 + 打开弹窗（容器按既有顺序执行） */
  onOpenUpdate: (entry: MyItemEntry) => void
  /** 装回本地：进入向导页（容器负责免责前置） */
  onOpenInstall: (entry: MyItemEntry) => void
}

export function MyConfigsList({
  t, myItems, myItemsError, listLoading, itemViews, summary, install, deletingId,
  onRefresh, onChangeDeleteConfirm, onOpenUpdate, onOpenInstall,
}: MyConfigsListProps) {
  return (
    <Card>
      <div className={css.headRow}>
        <span className={css.groupLabel}>{t('myconfigs.list.title')}</span>
        {/* 撑开剩余空间：Badge 与刷新按钮成组贴右，刷新按钮为该行最右元素 */}
        <span className={css.statusSpacer} />
        {myItems !== null && (
          <Badge kind="info">
            {t('myconfigs.list.summary', {
              total: String(summary.total),
              listed: String(summary.listed),
              pending: String(summary.pendingPr),
              none: String(summary.notListed),
            })}
          </Badge>
        )}
        <Button disabled={listLoading} onClick={() => { onRefresh() }}>
          {listLoading ? <Spinner label={t('myconfigs.list.loading')} /> : t('myconfigs.list.refresh')}
        </Button>
      </div>
      {myItemsError !== null && <Banner kind="error">{redact(myItemsError)}</Banner>}
      {listLoading && myItems === null && <div className={css.statRow}><Spinner label={t('myconfigs.list.loading')} /></div>}
      {!listLoading && myItems !== null && myItems.length === 0 && <Empty>{t('myconfigs.list.empty')}</Empty>}
      {!listLoading && itemViews.length > 0 && (
        <div className={css.snapshotList}>
          {itemViews.map(({ entry, view, badge }) => (
            <div key={view.id} className={css.statRow} style={{ paddingTop: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={css.conflictHead}>
                  <span className={css.conflictId}>{view.name}</span>
                  {view.version !== '' && <Badge kind="info">{view.version}</Badge>}
                </div>
                <div className={css.statRow}>
                  <Badge kind={badge.kind}>{badge.text}</Badge>
                  {view.stars !== undefined && (
                    <Badge kind="info" title={t('list.starsHint')}>{t('list.stars', { count: String(view.stars) })}</Badge>
                  )}
                  {view.author !== '' && <Badge kind="info">{view.author}</Badge>}
                  {view.updatedAt !== '' && <Badge kind="info">{view.updatedAt}</Badge>}
                  {view.categories.map((c) => <Badge key={c} kind="info">{c}</Badge>)}
                </div>
              </div>
              <div className={css.rowActions}>
                <Button onClick={() => { onOpenUpdate(entry) }}>{t('myconfigs.item.update')}</Button>
                <Button
                  disabled={install !== null && install.detail === null}
                  onClick={() => { onOpenInstall(entry) }}
                >
                  {t('myconfigs.item.install')}
                </Button>
                {entry.repoUrl !== '' && <Button href={entry.repoUrl}>{t('myconfigs.list.openRepo')}</Button>}
                {badge.kind === 'warn' && badge.prUrl !== undefined && badge.prUrl !== '' && (
                  <Button href={badge.prUrl}>{t('myconfigs.item.openPr')}</Button>
                )}
                {/* 删除：danger 按钮 → 弹窗二次确认（ConfirmDialog；不可恢复，已收录自动提交下架 PR） */}
                <Button
                  variant="danger"
                  disabled={deletingId !== null}
                  onClick={() => { onChangeDeleteConfirm(view.id) }}
                >
                  {t('myconfigs.delete.run')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
