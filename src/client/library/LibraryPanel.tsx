/**
 * 产物库（UI v2 §6）—— 四源合并成一张混合平铺列表。
 *
 * 用户找「我上周那份」时不该先想它落在哪个源里（§1.3），所以**来源只是筛选维度**，不是分组。
 * 行结构与动作分派全在 `ui/artifact-view.ts`（纯函数、node 可测）与 `ArtifactRow.tsx`；
 * 本组件只管：拉四份清单、把行接上真实动作、渲染五种态。
 *
 * 容器判据（§1）：本页的动作大多是**单次决策 + 报告**（恢复计划预览、查看与对比、迁移前咨询）
 * —— 走 Modal；只有多阶段流程（导入向导、逛市场）才进 Task 面板。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  countByKind, filterArtifacts, toArtifactRows,
  type ArtifactCapability, type ArtifactRow,
} from '../../ui/artifact-view.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { SyncApi, SyncSnapshotLite } from '../sync/sync-api.ts'
import type { MarketApi } from '../market/market-api.ts'
import type { TranslateNS } from '../client-types.ts'
import { formatDateTimeFull } from '../sync/history-model.ts'
import { deviceLabelsById } from '../sync/remote-device-view.ts'
import { runStore, type LibraryStoreSlice } from '../run-store.ts'
import { Badge, Button, Card, Empty } from '../common/ui.tsx'
import { SkeletonRows } from '../common/Skeleton.tsx'
import { redact } from '../../security/redaction.ts'
import { InfoHint } from '../common/InfoHint.tsx'
import { ArtifactRowView } from './ArtifactRow.tsx'
import css from '../config-manager.module.css'

export interface LibraryPanelProps {
  api: ConfigManagerApi
  syncApi: SyncApi
  marketApi: MarketApi
  t: TranslateNS<'config-manager'>
  uiT: UiT
  /**
   * 把一个行内动作**冒泡给壳层**（§6.5）。
   * 面板自己不执行动作 —— 动作会开 Modal，而 Modal 必须在 task 面板**之外**渲染，
   * 否则定位基准会变成侧滑面板（详见 LibraryActions 的文件头）。
   */
  onAction: (capability: ArtifactCapability, row: ArtifactRow) => void
  /** 从产物库发起一次流程（导入 / 逛市场）—— Task 面板由壳层统一渲染。
   *  marketId 由行内「安装」冒泡（见 LibraryActions），其余入口不带。 */
  onOpenTask: (kind: 'import' | 'market', marketId?: string) => void
  /** 「手动导出」也是流程，但它属于首页的快捷动作；这里直接开面板即可 */
  onOpenExport: () => void
  /** 「发布到市场」：市场退出导航后（v3 §3.1），这里是它的常驻入口之一（另一条是 ⌘K 命令） */
  onOpenPublish: () => void
  /** 外部刷新信号（动作完成 / 恢复 / 删除后递增）→ 重拉四份清单 */
  refreshTick: number
}

type SourceStatus = 'loading' | 'ready' | 'error'

interface SourceState<T> {
  status: SourceStatus
  items: T[]
  error: string | null
}

function initialSource<T>(): SourceState<T> { return { status: 'loading', items: [], error: null } }

export function LibraryPanel({ api, syncApi, marketApi, t, uiT, onAction, onOpenTask, onOpenExport, onOpenPublish, refreshTick }: LibraryPanelProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const lib = state.library

  const [snapshots, setSnapshots] = useState<SourceState<SnapshotMeta>>(initialSource)
  const [files, setFiles] = useState<SourceState<BackupFileMeta>>(initialSource)
  const [remote, setRemote] = useState<SourceState<SyncSnapshotLite>>(initialSource)
  const [market, setMarket] = useState<SourceState<{ id: string; name: string; author?: string; version?: string; updatedAt?: string }>>(initialSource)
  /** 快照目录读不出来的事实（宿主 out.unreadable；null = 正常） */
  const [snapshotsUnreadable, setSnapshotsUnreadable] = useState<string | null>(null)
  const [currentRemoteId, setCurrentRemoteId] = useState<string | null>(null)
  const [remoteChannel, setRemoteChannel] = useState<'git' | 'webdav' | null>(null)
  /** 面板内部的刷新信号（失败源卡片里的「重试」）；外部的走 props.refreshTick */
  const [localTick, setLocalTick] = useState(0)

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  /**
   * 四个来源**各自**加载、各自失败：一路读不到不该拖垮整页（§6.7）。
   *
   * **刷新时保持已有行**（stale-while-revalidate）：删除/恢复后 `refreshTick` 变化会重跑本 effect，
   * 若此时把源置回 loading 并清空 items，列表会被卸载 ── 滚动位置归零、整页"闪一下"，
   * 用户看到的就是「删一个文件整个页面刷新了，滚动条跳回开头」。
   * 只有**首次加载**（还没有数据）才进 loading 态；已有数据就原地等新数据。
   */
  useEffect(() => {
    const put = <T,>(setter: (next: SourceState<T> | ((prev: SourceState<T>) => SourceState<T>)) => void, promise: Promise<T[]>): void => {
      // 函数式更新：有数据就**原样保持**（不闪回 loading、不清空），否则进首次加载态
      setter((prev) => (prev.status === 'ready' && prev.items.length > 0
        ? prev
        : { status: 'loading', items: [], error: null }))
      promise.then(
        (items) => { if (mounted.current) setter({ status: 'ready', items, error: null }) },
        (err: unknown) => { if (mounted.current) setter({ status: 'error', items: [], error: String(err instanceof Error ? err.message : err) }) },
      )
    }
    // 走 detailed 版本：把「读不出来」与「没有快照」分开（此前路由丢了这个信号）
    put(setSnapshots, api.snapshotsDetailed().then((res) => {
      if (mounted.current) setSnapshotsUnreadable(res.unreadable)
      return res.snapshots
    }))
    put(setFiles, api.listBackupFiles())
    // 远端快照：payload 必须带通道与地址 —— 宿主 prepareSync 需要 repoUrl/url，
    // 只传 {} 会被 400 `repoUrl is required` 挡回（此前该源恒失败，页面显示「1 个来源读取失败」）。
    // 先取 /sync/status 拿到通道与地址，再据此发请求；两处都不可用时该源如实标失败，绝不空手请求。
    put(setRemote, syncApi.status().then((status) => {
      if (!mounted.current) return [] as SyncSnapshotLite[]
      setRemoteChannel(status.lastSyncChannel === 'webdav' ? 'webdav' : status.lastSyncChannel === 'git' ? 'git' : null)
      const configured = status.configured === true
      const webdavUrl = status.webdav?.url ?? ''
      const repoUrl = status.repoUrl ?? ''
      const payload = status.lastSyncChannel === 'webdav'
        ? (webdavUrl.trim() !== '' ? { transport: 'webdav' as const, url: webdavUrl.trim() } : null)
        : (repoUrl.trim() !== '' ? { transport: 'git' as const, repoUrl: repoUrl.trim() } : null)
      if (!configured || payload === null) return [] as SyncSnapshotLite[]
      return syncApi.snapshotsList(payload).then((res) => {
        if (mounted.current) setCurrentRemoteId(res.currentSnapshotId ?? null)
        return res.snapshots
      })
    }))
    put(setMarket, marketApi.browse().then((res) => res.items))
    // 通道类型与远端地址都从 /sync/status 取（已并入上面的远端源加载，避免同一接口打两次）
  }, [api, syncApi, marketApi, localTick, refreshTick])

  const rows: ArtifactRow[] = useMemo(() => toArtifactRows({
    snapshots: snapshots.status === 'ready' ? snapshots.items : [],
    backupFiles: files.status === 'ready' ? files.items : [],
    remoteSnapshots: remote.status === 'ready' ? remote.items : [],
    remoteCurrentId: currentRemoteId,
    remoteChannel,
    marketItems: market.status === 'ready' ? market.items : [],
  }, uiT), [snapshots, files, remote, market, currentRemoteId, remoteChannel, uiT])

  const filtered = useMemo(
    () => filterArtifacts(rows, { kind: lib.sourceFilter, text: lib.query, sort: lib.sort }),
    [rows, lib.sourceFilter, lib.query, lib.sort],
  )

  /**
   * cloud-sync 借鉴项 ⑥：远端快照 id → 「由 <设备名> 推送」文案。
   * **只有**快照 manifest 真的带 deviceName 的行才进表：旧快照没有该字段，界面就不显示设备行
   * （绝不渲染空串占位，也绝不把 undefined 变成文案）。
   */
  const deviceLabelOf = useMemo(
    () => deviceLabelsById(
      remote.status === 'ready' ? remote.items : [],
      (device) => t('library.remoteDevice', { device }),
    ),
    [remote, t],
  )
  const counts = countByKind(rows)
  const failedSources = [snapshots, files, remote, market].filter((s) => s.status === 'error').length

  const formatTime = (iso: string): string => formatDateTimeFull(iso)

  /** 行内动作分派。**只有壳层能做这些事**（跳页 / 开面板 / 起流程）。 */
  type SourceFilter = LibraryStoreSlice['sourceFilter']
  const setSource = (kind: SourceFilter): void => { runStore.patch({ library: { sourceFilter: kind } }) }
  const sourceOptions: Array<{ id: SourceFilter; label: string; count: number | null }> = [
    { id: null, label: t('library.source.all'), count: rows.length },
    { id: 'snapshot', label: t('library.kind.snapshot'), count: snapshots.status === 'ready' ? counts['snapshot'] : null },
    { id: 'backup-file', label: t('library.kind.backupFile'), count: files.status === 'ready' ? counts['backup-file'] : null },
    { id: 'remote-snapshot', label: t('library.kind.remote'), count: remote.status === 'ready' ? counts['remote-snapshot'] : null },
    { id: 'market', label: t('library.kind.market'), count: market.status === 'ready' ? counts['market'] : null },
  ]

  /** 加密项计数：只数**当前筛选后**的行（底部徽章必须与眼前列表一致，见 footer 注释） */
  const encryptedCount = useMemo(() => filtered.filter((row) => row.badges.includes('encrypted')).length, [filtered])

  /** 首屏「本机两个源已就绪但为空」时仍需等其余来源：远端要串行打 /sync/status + /sync/snapshots、
   *  市场要走网络，通常慢于本机两源。若只按本机两源判空，页面会先写「暂无备份文件」，
   *  几百毫秒后远端/市场行才冒出来 —— 中间那段窗口用户会以为产物库是空的。
   *  注意这里**只影响空态**：已有行时照旧原地渲染（stale-while-revalidate 不被破坏）。 */
  const anySourcePending = snapshots.status === 'loading' || files.status === 'loading'
    || remote.status === 'loading' || market.status === 'loading'
  const loading = snapshots.status === 'loading' || files.status === 'loading'

  return (
    <div className={css.viewBody}>
      {/* 页首标题行已移除（2026-10-04 用户要求）：标题与页签重复、手刷按钮与壳层 refreshTick 重复；
          原挂在标题行的「保留期说明」也一并移除（用户不要这条说明）。 */}

      {/* 来源筛选：计数**只在对应来源加载成功后**显示 —— 加载中或失败时只显示来源名，绝不显示 0（§6.6） */}
      <div className={css.libraryFilters}>
        {sourceOptions.map((option) => (
          <button
            key={option.id ?? 'all'}
            type="button"
            className={css.libraryFilter}
            data-active={lib.sourceFilter === option.id ? '' : undefined}
            onClick={() => { setSource(option.id) }}
          >
            {option.label}
            {option.count !== null && <span className={css.libraryFilterCount}>{option.count}</span>}
          </button>
        ))}
      </div>

      <input
        className={css.librarySearch}
        type="search"
        value={lib.query}
        placeholder={t('library.searchPlaceholder')}
        aria-label={t('library.searchPlaceholder')}
        onChange={(event) => { runStore.patch({ library: { query: event.target.value } }) }}
      />

      {/* 快照目录读不出来（不是「没有快照」）：与来源失败同一层级地如实说明 */}
      {snapshotsUnreadable !== null && (
        <div className={css.hint}>{t('library.snapshotsUnreadable')}{t('common.labelSeparator')}{redact(snapshotsUnreadable)}</div>
      )}

      {/* 某个来源读不到：一条 warn + 重试，既不静默跳过，也不整页报错（§6.7） */}
      {failedSources > 0 && (
        <Card>
          <div className={css.actionRow}>
            <span>{t('library.sourceFailed', { count: failedSources })}</span>
            <Button size="sm" onClick={() => { setLocalTick((n) => n + 1) }}>{t('library.retry')}</Button>
          </div>
        </Card>
      )}

      {/* 加载态 / 空态与列表**同一条高度契约**（.libraryListState）：三者都吃掉剩余高度，
          底栏因此恒贴底（只在有数据时才需要列表本身，空态不该让页面塌成半截）。 */}
      {/* 还有来源在路上（本机两源已就绪但为空）时也走加载态：绝不先给「暂无产物」的结论。
          与空态共用同一个 .libraryListState 契约（守卫要求恰好两处：加载态 + 空态）。 */}
      {(loading || (anySourcePending && filtered.length === 0)) && (
        <div className={css.libraryListState + ' ' + css.librarySkeletonRegion}>
          {/* 骨架：行数按一屏可见行给（8 行 ≈ 564×720 画布的列表区），行高与 .artifactRowHead 对齐，
              数据到货时列表从同一位置长出来，不再「空页面 + 居中转圈」整块跳变。 */}
          <SkeletonRows count={8} label={t('common.loading')} />
        </div>
      )}

      {!loading && !anySourcePending && filtered.length === 0 && (
        <div className={css.libraryListState}>
          <Empty>
            {lib.query.trim() !== '' || lib.sourceFilter !== null
              ? t('library.emptyFiltered')
              // 全空时的解释复用备份文件那条（四源里只有它是「你可以自己去产生一个」的产物）
              : t('backupFiles.empty')}
          </Empty>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <ul className={css.artifactList} data-scroll-region="artifact">
          {filtered.map((row) => (
            <ArtifactRowView
              key={row.key}
              row={row}
              t={t}
              uiT={uiT}
              formatTime={formatTime}
              expanded={lib.expandedKey === row.key}
              onToggle={() => {
                runStore.patch({ library: { expandedKey: lib.expandedKey === row.key ? null : row.key } })
              }}
              onAction={onAction}
              deviceLabel={row.kind === 'remote-snapshot' ? deviceLabelOf.get(row.ref.remoteId ?? '') : undefined}
            />
          ))}
        </ul>
      )}

      {/* 计数条：**不显示合计体积** —— 四源里只有备份文件有体积，求和会把「未知」混进「合计」（§6.8 ①） */}
      <div className={css.libraryFooter}>
        <span className={css.libraryCount}>{t('library.summary.count', { count: filtered.length })}</span>
        {/* 加密计数只统计**当前筛选后**的行：此前用 rows（全部来源）⇒ 切到「本机快照」等
            没有加密项的类别时底部仍显示「1 个加密」，与眼前看到的列表不符（真机反馈）。 */}
        {encryptedCount > 0 && (
          <Badge kind="warn">{uiT('library.summary.encrypted', { count: encryptedCount })}</Badge>
        )}
        <InfoHint text={t('backupFiles.hint')} label={t('common.infoHint')} />
        <span className={css.statusSpacer} />
        <Button size="sm" onClick={onOpenExport}>{t('library.new.export')}</Button>
        <Button size="sm" onClick={() => { onOpenTask('import') }}>{t('library.new.import')}</Button>
        <Button size="sm" onClick={() => { onOpenTask('market') }}>{t('library.new.market')}</Button>
        <Button size="sm" onClick={onOpenPublish}>{t('task.title.publish')}</Button>
      </div>
    </div>
  )
}

/** 供筛选条复用：来源 id → 文案键（'all' 不是来源，单独处理） */
