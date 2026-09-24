/**
 * 备份页（Backups —— Workbench Rebuild 2026-09）：快照 / 备份文件 / 恢复 三子视图。
 *
 * 视觉重建说明：全部渲染模型与状态逻辑保持不变（dry-run 计划代数守卫、store 镜像
 * commit/patch、宿主 RunRegistry 权威防重、refreshTick 重载、inspect 只读弹窗）；
 * 展示层升级为 Workbench 数据表 + 工具栏（数据表行可选中、操作收进行内 sm 按钮、
 * 子视图切换走 Segmented 分段控件）。
 *
 * 数据流：api.snapshots() 加载列表；选择快照后 api.restoreSnapshot(id, true) 拿
 * 恢复计划（零写入预览）；确认后 api.restoreSnapshot(id, false) 执行并展示报告
 * （restored / removedPlugins / manualHints（人工项高亮）/ failed / skipped）。
 * 状态组件内自持（useState），同时经 toSnapshotsStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切页不丢」，sessionStorage 白名单保证「刷新恢复」。
 *
 * 安全：恢复/删除为危险操作，恒走 danger + ConfirmDialog 二次确认；报告文本经
 * 上游 redact 链路。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { redact } from '../../security/redaction.ts'
import type { SnapshotMeta } from '../../core/restore.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import { ConsultCard } from '../consult/ConsultCard.tsx'
import { RestorePlanView } from './RestorePlanView.tsx'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { RecoveryPort } from '../../ui/types.ts'
import { RecoveryPanel } from '../recovery/RecoveryPanel.tsx'
import { Badge, Banner, Button, Card, Empty, IconButton, Segmented, Spinner } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { RefreshIcon, DownloadIcon, ImportIcon, InspectIcon, DeleteIcon, ClockIcon, PencilIcon, MessageIcon } from '../common/Icon.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { runStore, toSnapshotsStoreSlice, type SnapshotsSubTab } from '../run-store.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { BackupInspectResult } from '../api.ts'
import { inspectGroupedChanges, inspectSections, inspectSummary } from '../../ui/backup-inspect.ts'
import type { InspectGroupKey } from '../../ui/backup-inspect.ts'
import { formatBytes } from '../../ui/report.ts'
import {
  DEFAULT_RETENTION_POLICY,
  normalizeRetentionPolicy,
  type RetentionPolicy,
} from '../../ui/backup-schedule.ts'
import {
  filterBackupFiles,
  formatBackupFileTime,
  isUnreadableNote,
  midEllipsis,
  planHasExecutableActions,
  snapshotsPanelStateFromStore,
  type SnapshotsPanelState,
} from '../../ui/snapshots-view.ts'
import { BackupScheduleCard } from './BackupScheduleCard.tsx'
import { SnapshotsEmptyState } from './SnapshotsEmptyState.tsx'
import { SnapshotsListTable } from './SnapshotsListTable.tsx'
import css from '../config-manager.module.css'

export interface SnapshotsPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 恢复（Phase 5）子视图，透传给 RecoveryPanel */
  recoveryApi: RecoveryPort
  recoveryT: TranslateNS<'config-manager-recovery'>
}

/**
 * 面板状态：定义与「从 store 切片恢复」的投影都在 src/ui/snapshots-view.ts
 * （框架无关、node 可测）——本组件只持有与提交它。
 */
type PanelState = SnapshotsPanelState

/** P1-⑧：手动删除快照的确认目标（null = 无） */
interface SnapshotDeleteTarget {
  id: string
  createdAt: string
}

/**
 * 快照保留上限的回退值（m-retention）：
 * 真实值来自宿主（`/backup-schedule` 的 `retention`，用户可配置）——**不再作为展示真值**，
 * 仅在宿主未返回 retention（旧版宿主 / 请求失败）时兜底，注释保留常量以说明历史来源。
 * 与 core backup.ts SNAPSHOT_RETENTION_LIMIT / DEFAULT_RETENTION_POLICY.keepLast 一致。
 */
export const SNAPSHOT_RETENTION_LIMIT = DEFAULT_RETENTION_POLICY.keepLast



export function SnapshotsPanel({ api, t, recoveryApi, recoveryT }: SnapshotsPanelProps) {
  const [state, setState] = useState<PanelState>(() => snapshotsPanelStateFromStore(runStore.getSnapshot().snapshots))
  /** 最新 state 镜像（commit/卸载 flush 读取，避免闭包过期值） */
  const stateRef = useRef<PanelState>(state)
  /** 挂载守卫：卸载后不再 setState（store 镜像仍执行，异步结果照常落库） */
  const mountedRef = useRef(true)
  /** dry-run 计划请求代数：快速切换快照时作废在途旧请求（防晚到响应覆盖新选择） */
  const planGeneration = useRef(0)
  /** 执行恢复的二次确认弹窗开关（危险操作） */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** P1-⑧：手动删除快照确认目标（null = 无） */
  const [deleteTarget, setDeleteTarget] = useState<SnapshotDeleteTarget | null>(null)
  /** P1-⑧：删除/置顶请求进行中（防重复提交） */
  const [managing, setManaging] = useState(false)
  /** 恢复计划预览弹窗开关（瞬态 UI；plan 仍镜像 runStore，切页/刷新恢复后可再次打开） */
  const [planOpen, setPlanOpen] = useState(false)
  /** Phase 7 迁移前咨询：恢复计划弹窗内的咨询报告（本地 state，非敏感） */
  const [consultReport, setConsultReport] = useState<ConsultReport | null>(null)
  const [consultLoading, setConsultLoading] = useState(false)
  /** 备份文件列表刷新信号：BackupScheduleCard「立即备份」完成后递增触发重载 */
  const [backupFilesTick, setBackupFilesTick] = useState(0)
  /**
   * m-retention：宿主真实保留策略（用户可配置；快照子视图的提示文案用它而非本地常量）。
   * 失败/旧版宿主未返回 → null，展示层回退 DEFAULT_RETENTION_POLICY（见 SNAPSHOT_RETENTION_LIMIT）。
   */
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy | null>(null)
  /** 二级子视图（快照 / 备份文件 / 恢复）：初始从 store 恢复，切换镜像 runStore */
  const [subTab, setSubTab] = useState<SnapshotsSubTab>(() => runStore.getSnapshot().snapshots.subTab ?? 'restore')
  const switchSubTab = (next: SnapshotsSubTab): void => {
    setSubTab(next)
    runStore.patch({ snapshots: { subTab: next } })
  }

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（dry-run 计划/执行恢复）完成回调
   * 在组件已卸载（切走页面）时也能把结果（plan/report）写进 store，切回恢复。
   */
  const commit = (next: PanelState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    const store = runStore.getSnapshot().snapshots
    // 合并 store 中非 PanelState 字段（backupDraft / importBackup / subTab），避免镜像时覆盖
    runStore.patch({ snapshots: toSnapshotsStoreSlice({ ...next, backupDraft: store.backupDraft, importBackup: store.importBackup, subTab: store.subTab }) })
  }
  const patch = (p: Partial<PanelState>): void => commit({ ...stateRef.current, ...p })

  /** 卸载时置挂载守卫 + 最后镜像一次（防止「最后一次改动后立即切页」时丢状态）。 */
  useEffect(() => () => {
    mountedRef.current = false
    const store = runStore.getSnapshot().snapshots
    runStore.patch({ snapshots: toSnapshotsStoreSlice({ ...stateRef.current, backupDraft: store.backupDraft, importBackup: store.importBackup, subTab: store.subTab }) })
  }, [])

  const load = (): void => {
    patch({ status: 'loading', error: null })
    api.snapshots().then(
      (metas) => { patch({ status: 'ready', metas }) },
      (err) => {
        patch({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  useEffect(load, [api])

  /**
   * m-retention：读取宿主保留策略（只读；用于「最多自动保留 N 个」提示文案的**真实分母**）。
   * 失败静默（回退缺省值展示），不打扰用户——策略编辑入口在定时备份设置卡内。
   */
  useEffect(() => {
    let cancelled = false
    api.backupSchedule().then(
      (schedule) => { if (!cancelled) setRetentionPolicy(normalizeRetentionPolicy(schedule.retention)) },
      () => { if (!cancelled) setRetentionPolicy(null) },
    )
    return () => { cancelled = true }
  }, [api, backupFilesTick])

  /** Phase 7 迁移前咨询：恢复计划弹窗打开时对选中快照生成咨询报告（只读，零写入）。 */
  useEffect(() => {
    if (!planOpen || state.selectedId === null) return
    let cancelled = false
    setConsultLoading(true)
    api.consult({ type: 'local-snapshot', id: state.selectedId, snapshotId: state.selectedId })
      .then((report) => { if (!cancelled) setConsultReport(report) })
      .catch(() => { if (!cancelled) setConsultReport(null) })
      .finally(() => { if (!cancelled) setConsultLoading(false) })
    return () => { cancelled = true }
  }, [planOpen, state.selectedId, api])

  const select = (id: string): void => {
    // 每次选择递增代数：用户快速切换快照时，旧 dry-run 请求晚到直接丢弃
    const generation = planGeneration.current + 1
    planGeneration.current = generation
    // 点击同一快照且计划已就绪：直接打开预览弹窗，不重复请求
    if (id === state.selectedId && state.plan !== null) {
      setPlanOpen(true)
      return
    }
    patch({ selectedId: id, plan: null, changeSummary: null, report: null, actionError: null, planning: true })
    // 计划预览在弹窗内展示：点击行即打开弹窗，loading/结果/错误都在弹窗内呈现
    setPlanOpen(true)
    api.restoreSnapshot(id, true).then(
      (res) => {
        if (generation !== planGeneration.current) return
        patch({ planning: false, plan: res.plan ?? null, changeSummary: res.changeSummary ?? null })
      },
      (err) => {
        if (generation !== planGeneration.current) return
        patch({
          planning: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  const execute = (): void => {
    if (state.selectedId === null || state.running) return
    patch({ running: true, report: null, actionError: null })
    setConfirmOpen(false)
    // 宿主侧权威防重（/restore 经 RunRegistry 登记，同 kind running → 409）；
    // 前端 running 只是 UX 镜像。watchRunning 轮询宿主 /runs + /progress。
    runStore.watchRunning('restore', 500)
    api.restoreSnapshot(state.selectedId, false).then(
      (res) => { patch({ running: false, report: res.report ?? null }) },
      (err) => {
        // 此时预览/确认弹窗都已关闭 → 用 Toast 送达（写入 panel state 将无任何渲染点）
        patch({ running: false })
        toast.error(err instanceof Error ? err.message : String(err))
      },
    ).finally(() => { runStore.stopRunWatch('restore') })
  }

  /** 从预览弹窗点「执行恢复」：关闭预览弹窗 + 打开二次确认弹窗（危险操作）。 */
  const requestExecute = (): void => {
    if (state.running || state.plan === null) return
    setPlanOpen(false)
    setConfirmOpen(true)
  }

  /** P1-⑧：置顶/取消置顶（豁免自动保留清理；操作成功后刷新列表）。 */
  const togglePin = (meta: SnapshotMeta): void => {
    if (managing) return
    setManaging(true)
    api.setSnapshotPinned(meta.id, !meta.pinned).then(
      () => {
        setManaging(false)
        load()
      },
      (err) => {
        setManaging(false)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  /** P1-⑧：确认删除单个快照（危险操作：该回滚点不可恢复）。 */
  const doDeleteSnapshot = (): void => {
    const target = deleteTarget
    if (target === null || managing) return
    setManaging(true)
    api.deleteSnapshot(target.id).then(
      (res) => {
        setManaging(false)
        setDeleteTarget(null)
        // 删除的是当前选中快照 → 清空选中与计划；无论如何都刷新列表
        if (state.selectedId === target.id) patch({ selectedId: null, plan: null, report: null })
        // 不可恢复操作：明确回执
        toast.ok(t('snapshots.deleted'))
        load()
        void res
      },
      (err) => {
        setManaging(false)
        setDeleteTarget(null)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  /**
   * 关闭恢复报告回执：只清报告本身（快照选中态/列表保持不动，用户可继续操作）。
   * 必须走 patch（commit → runStore.patch）：报告随切片落 sessionStorage，
   * 只清本地 state 会让它在切换页签/刷新后「复活」。
   */
  const dismissReport = (): void => {
    patch({ report: null })
  }

  const reportLine = (title: string, items: string[], warn: boolean): ReactNode => {
    if (items.length === 0) return null
    return (
      <div className={css.inspectGroup}>
        <div className={css.groupHeader}>
          <strong className={warn ? css.warnText : undefined}>{title}（{items.length}）</strong>
        </div>
        <div className={css.reportScroll}>
          <ul className={css.reportList}>
            {items.map((item, i) => <li key={`${title}-${i}`}>{item}</li>)}
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div className={css.viewBody}>
      {/* 二级子视图切换（Segmented 分段控件 + 刷新；subTab 镜像 runStore） */}
      <div className={css.actionRow}>
        <Segmented
          items={[
            { id: 'restore', label: t('snapshots.subTab.restore') },
            { id: 'files', label: t('snapshots.subTab.files') },
            { id: 'schedule', label: t('snapshots.subTab.schedule') },
            { id: 'recovery', label: t('snapshots.subTab.recovery') },
          ]}
          active={subTab}
          onChange={(id) => { switchSubTab(id as SnapshotsSubTab) }}
          ariaLabel={t('snapshots.title')}
        />
        <span className={css.statusSpacer} />
        <IconButton
          icon={<RefreshIcon size={14} />}
          label={t('overview.refresh')}
          onClick={() => {
            // 手动刷新是显式动作：给回执（自动/挂载加载不打字提示，避免噪音）
            load()
            setBackupFilesTick((n) => n + 1)
            toast.ok(t('toast.refreshed'))
          }}
        />
      </div>

      {subTab === 'recovery' ? (
        /* 事故恢复（Phase 5）：完全复用 RecoveryPanel（自身独立切片 + 确认/执行/验证流程） */
        <RecoveryPanel recoveryApi={recoveryApi} t={recoveryT} />
      ) : subTab === 'files' ? (
        <BackupFilesCard api={api} t={t} refreshTick={backupFilesTick} />
      ) : subTab === 'schedule' ? (
        <BackupScheduleCard
          api={api}
          t={t}
          onBackupDone={() => { setBackupFilesTick((n) => n + 1) }}
        />
      ) : (
        <>
          {/* —— 快照恢复：导入前回滚点列表 → 选择 → dry-run 计划 → 执行 → 报告 —— */}

          {state.status === 'loading' && <Spinner label={t('snapshots.loading')} />}

          {state.status === 'error' && (
            <Banner kind="error">
              {state.error ?? t('common.unknownError')}
              <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
            </Banner>
          )}

          {state.status === 'ready' && state.metas.length === 0 && (
            <SnapshotsEmptyState
              t={t}
              onViewFiles={() => { switchSubTab('files') }}
              onRunBackup={() => { api.runBackupNow().then(() => { setBackupFilesTick((n) => n + 1) }, () => {}) }}
            />
          )}

          {state.status === 'ready' && state.metas.length > 0 && (
            <>
              <SnapshotsListTable
                t={t}
                metas={state.metas}
                selectedId={state.selectedId}
                managing={managing}
                retentionLimit={(retentionPolicy ?? DEFAULT_RETENTION_POLICY).keepLast}
                onSelect={select}
                onTogglePin={togglePin}
                onRequestDelete={(meta) => { setDeleteTarget({ id: meta.id, createdAt: meta.createdAt }) }}
              />

              {state.report !== null && (
                <>
                  {/* 报告是「一次性回执」：必须在报告里给出显式退出入口。
                      此前只有标题行，没有任何按钮 —— 执行恢复后页面就停在报告上，
                      用户找不到「返回」（报告还会随 sessionStorage 一直留在面板里）。
                      标题 + 右侧动作用 .headRow（非 baseline 对齐，按钮居中）。 */}
                  <div className={css.headRow}>
                    <span className={css.groupLabel}>{t('snapshots.reportTitle')}</span>
                    <span className={css.statusSpacer} />
                    <Button size="sm" variant="primary" onClick={dismissReport}>
                      {t('snapshots.reportDone')}
                    </Button>
                  </div>
                  {reportLine(t('snapshots.restored'), state.report.restored, false)}
                  {reportLine(t('snapshots.removedPlugins'), state.report.removedPlugins, false)}
                  {reportLine(t('snapshots.manualHints'), state.report.manualHints, true)}
                  {reportLine(t('snapshots.failed'), state.report.failed.map((f) => `${f.item}: ${f.reason}`), true)}
                  {reportLine(t('snapshots.skipped'), state.report.skipped, false)}
                </>
              )}
            </>
          )}

          {/* 恢复计划预览弹窗：点击行即打开，loading/结果/错误都在弹窗内呈现（Radix Modal 统一 a11y） */}
          <Modal
            open={planOpen}
            onClose={() => { setPlanOpen(false) }}
            title={t('snapshots.planTitle')}
            wide
            busy={state.running}
          >
            <Modal.Header
              title={t('snapshots.planTitle')}
              closeLabel={t('common.close')}
              onClose={() => { setPlanOpen(false) }}
              closeDisabled={state.running}
            />
            <Modal.Body scroll>
              {/* Phase 7 迁移前咨询卡（只读健康评分 + 建议）：用户要求排在计划预览之前，
                  两部分之间用分割线隔开（无咨询报告时不画线，避免开头一条孤立横线）。 */}
              {consultLoading && <Spinner label={api.t('consult.loading')} />}
              {consultReport !== null && <ConsultCard report={consultReport} t={api.t} />}
              {(consultLoading || consultReport !== null) && <div className={css.sectionDivider} role="separator" />}
              <div className={css.hint}>{t('snapshots.selectHint')}</div>
              {state.planning && <Spinner label={t('common.loading')} />}
              {state.plan !== null && state.plan.actions.length === 0 && (
                <Empty>{t('snapshots.noActions')}</Empty>
              )}
              {state.plan !== null && state.plan.actions.length > 0 && (
                /* git 风格视图：摘要条 + 状态分组 + 点开文件看左右双栏逐行对照。
                   渲染模型在 src/ui/restore-plan-view.ts 与 src/ui/diff-view.ts（纯函数），
                   本组件只装配；key 用快照 id → 换快照时展开态与已加载 diff 全部重置。 */
                <RestorePlanView
                  key={state.selectedId ?? 'none'}
                  api={api}
                  t={t}
                  snapshotId={state.selectedId ?? ''}
                  plan={state.plan}
                  changeSummary={state.changeSummary ?? undefined}
                />
              )}
              {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}
            </Modal.Body>
            <Modal.Footer>
              <Button disabled={state.running} onClick={() => { setPlanOpen(false) }}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={state.running || !planHasExecutableActions(state.plan)}
                onClick={requestExecute}
              >
                {state.running ? t('snapshots.executing') : t('snapshots.execute')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 执行恢复二次确认（破坏性操作；busy 防重复提交） */}
          <ConfirmDialog
            open={confirmOpen}
            title={t('snapshots.confirmTitle')}
            message={t('snapshots.confirmRestore')}
            confirmLabel={t('snapshots.execute')}
            cancelLabel={t('common.cancel')}
            danger
            busy={state.running}
            onConfirm={execute}
            onCancel={() => { setConfirmOpen(false) }}
          />

          {/* P1-⑧：手动删除快照二次确认（危险操作：该回滚点不可恢复） */}
          <ConfirmDialog
            open={deleteTarget !== null}
            title={t('snapshots.deleteConfirmTitle')}
            message={deleteTarget !== null
              ? t('snapshots.deleteConfirm', { time: new Date(deleteTarget.createdAt).toLocaleString() })
              : undefined}
            confirmLabel={t('snapshots.delete')}
            cancelLabel={t('common.cancel')}
            danger
            busy={managing}
            onConfirm={doDeleteSnapshot}
            onCancel={() => { setDeleteTarget(null) }}
          />
        </>
      )}
    </div>
  )
}


/* ------------------------------------------------- 备份文件管理卡 */

/**
 * 备份文件管理卡（m-backup-files）：列出 exports/ 下的导出 ZIP（手动导出 + 定时备份），
 * 提供下载（复用 /download）/ 一键导入（切 Import 页 + 注入 zipPath，向导直接分析）/
 * 查看与当前配置的差异（只读）/ 删除（危险操作二次确认）。
 * 展示升级：搜索框进工具栏行，列表改数据表（名称主列 + 来源/大小/时间/备注内联元数据）。
 */
function BackupFilesCard({ api, t, refreshTick }: {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 外部刷新信号（「立即备份」完成后递增；首帧跳过，挂载由 load 处理） */
  refreshTick: number
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<BackupFileMeta[]>([])
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<BackupFileMeta | null>(null)
  /** P0-④：备份文件名搜索（client 过滤；仅文件名 + 备注匹配） */
  const [search, setSearch] = useState('')
  /** P1-⑦/P2-⑬：查看/对比弹窗状态（非空时渲染；zipPath 为受控 exports 路径） */
  const [inspect, setInspect] = useState<{
    name: string
    loading: boolean
    error: string | null
    result: BackupInspectResult | null
  } | null>(null)
  const mountedRef = useRef(true)
  const initialTick = useRef(refreshTick)

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    api.listBackupFiles().then(
      (list) => {
        if (!mountedRef.current) return
        setFiles(list)
        setStatus('ready')
      },
      (err) => {
        if (!mountedRef.current) return
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  useEffect(load, [api])

  // 「立即备份」完成等外部事件（refreshTick 递增）→ 重载列表；首帧跳过（挂载已 load）
  useEffect(() => {
    if (refreshTick === initialTick.current) return
    load()
  }, [refreshTick])

  /** 搜索过滤（P0-④）：纯函数在 ../../ui/snapshots-view.ts（node 可测）；空查询不过滤。 */
  const visibleFiles = filterBackupFiles(files, search)

  const download = (file: BackupFileMeta): void => {
    void api.download(file.path, { saveDialog: true }).catch((err) => {
      if (!mountedRef.current) return
      toast.error(err instanceof Error ? err.message : String(err))
    })
  }

  /** 一键导入：把备份文件 zipPath 交给现有导入向导（切 Import 页；向导挂载即分析） */
  const importBackup = (file: BackupFileMeta): void => {
    runStore.patch({
      view: 'import',
      panel: 'import',
      snapshots: { importBackup: { zipPath: file.path, name: file.name } },
    })
  }

  /** P1-⑦/P2-⑬：查看备份内容 + 与此备份的差异（只读，零写入）。 */
  const inspectBackup = (file: BackupFileMeta): void => {
    setInspect({ name: file.name, loading: true, error: null, result: null })
    api.inspectBackup(file.path).then(
      (result) => {
        if (!mountedRef.current) return
        setInspect({ name: file.name, loading: false, error: null, result })
      },
      (err) => {
        if (!mountedRef.current) return
        setInspect({ name: file.name, loading: false, error: err instanceof Error ? err.message : String(err), result: null })
      },
    )
  }

  const doDelete = (): void => {
    const file = confirmDelete
    if (file === null || deleting) return
    setDeleting(true)
    api.deleteBackupFile(file.name).then(
      () => {
        setDeleting(false)
        setConfirmDelete(null)
        // 不可恢复操作：明确回执
        toast.ok(t('backupFiles.deleted', { name: file.name }))
        load()
      },
      (err) => {
        setDeleting(false)
        setConfirmDelete(null)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }


  return (
    <Card className={`${css.activityCard} ${css.fillCard}`}>
      <div className={css.groupHeader}>
        <span className={css.groupLabel}>{t('backupFiles.title')}</span>
        <span className={css.badge}>{files.length}</span>
        <span className={css.statusSpacer} />
        {status === 'ready' && files.length > 0 && (
          <input
            type="search"
            className={css.input}
            placeholder={t('backupFiles.searchPlaceholder')}
            value={search}
            style={{ width: 170, height: 24 }}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setSearch(e.target.value) }}
          />
        )}
      </div>
      <div className={css.hint} style={{ marginBottom: 8, flex: 'none' }}>{t('backupFiles.hint')}</div>

      {status === 'loading' && <Spinner label={t('backupFiles.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {error ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && files.length === 0 && <Empty>{t('backupFiles.empty')}</Empty>}

      {status === 'ready' && files.length > 0 && (
        <div className={`${css.tableWrap} ${css.fillViewport}`}>
          <div className={css.tableScroll}>
            <table className={`${css.dataTable} ${css.tableFixed} ${css.tableCompact}`} role="list" aria-label={t('backupFiles.title')}>
              <thead>
                <tr>
                  <th>{t('backupFiles.name')}</th>
                  <th className={css.num} style={{ width: 64 }}>{t('backupFiles.size')}</th>
                  <th style={{ width: 130 }}>{t('backupFiles.time')}</th>
                  <th className={css.cellActions} style={{ width: 152 }}>{t('snapshots.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleFiles.map((file) => (
                  <tr key={file.name}>
                    <td>
                      <div className={css.cellMain}>
                        <span className={`${css.cellTitle} ${css.mono}`} title={file.name}>{midEllipsis(file.name, 20)}</span>
                        <span className={css.cellMeta}>
                          <Badge kind={file.source === 'auto' ? 'info' : 'ok'} title={file.source === 'auto' ? t('backupFiles.source.auto') : t('backupFiles.source.manual')}>
                            {file.source === 'auto' ? <ClockIcon size={11} /> : <PencilIcon size={11} />}
                            {file.source === 'auto' ? t('backupFiles.source.auto') : t('backupFiles.source.manual')}
                          </Badge>
                          {file.note !== null && file.note !== undefined && file.note !== '' && (
                            <span className={css.cellMetaNote} title={file.note}><MessageIcon size={11} /><span className={css.cellMetaNoteText}>{isUnreadableNote(file.note) ? t('backupFiles.noteUnreadable') : file.note}</span></span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className={css.num}>{formatBytes(file.sizeBytes)}</td>
                    <td className={css.dim} title={new Date(file.mtimeMs).toLocaleString()}>
                      <span className={css.mono} style={{ fontSize: '11px' }}>{formatBackupFileTime(file.mtimeMs)}</span>
                    </td>
                    <td className={css.cellActions}>
                      <span className={css.rowActions}>
                        <IconButton icon={<DownloadIcon size={14} />} label={t('backupFiles.download')} disabled={deleting} onClick={() => { download(file) }} />
                        <IconButton icon={<ImportIcon size={14} />} label={t('backupFiles.import')} disabled={deleting} onClick={() => { importBackup(file) }} />
                        <IconButton icon={<InspectIcon size={14} />} label={t('backupFiles.inspect')} disabled={deleting} onClick={() => { inspectBackup(file) }} />
                        <span className={css.rowDivider} aria-hidden="true" />
                        <IconButton icon={<DeleteIcon size={14} />} label={t('backupFiles.delete')} danger disabled={deleting} onClick={() => { setConfirmDelete(file) }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleFiles.length === 0 && <Empty>{t('backupFiles.searchEmpty')}</Empty>}
        </div>
      )}

      {/* 删除二次确认（危险操作：备份文件不可恢复） */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('backupFiles.deleteConfirmTitle')}
        message={confirmDelete !== null ? t('backupFiles.deleteConfirm', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('backupFiles.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => { setConfirmDelete(null) }}
      />

      {/* P1-⑦/P2-⑬：备份内容查看 / 与此备份的差异（只读弹窗，零写入；Radix Modal 统一 a11y） */}
      <Modal
        open={inspect !== null}
        onClose={() => { setInspect(null) }}
        title={t('backupFiles.inspect')}
        wide
      >
        <Modal.Header
          title={t('backupFiles.inspect')}
          closeLabel={t('common.close')}
          onClose={() => { setInspect(null) }}
        />
        <Modal.Body scroll>
          {inspect !== null && <div className={css.hint} data-testid="inspect-backup-name">{inspect.name}</div>}
          {inspect?.loading === true && <Spinner label={t('backupFiles.inspectLoading')} />}
          {inspect?.error !== null && inspect?.error !== undefined && <Banner kind="error">{inspect.error}</Banner>}
          {inspect !== null && !inspect.loading && inspect.result === null && inspect.error === null && (
            <Empty>{t('backupFiles.inspectEmpty')}</Empty>
          )}
          {inspect?.result !== null && inspect?.result !== undefined && (
            <BackupInspectView result={inspect.result} t={t} />
          )}
        </Modal.Body>
      </Modal>
    </Card>
  )
}

/* ------------------------------------------------- P1-⑦/P2-⑬ 备份查看 / 差异视图 */

/**
 * 备份内容查看 + 「与此备份 diff」只读视图（P1-⑦ / P2-⑬，绑 src/ui/backup-inspect.ts 纯函数）：
 * 分区清单 + 差异摘要徽章 + 逐项变更列表（限高内滚）。只读，不提供任何执行入口。
 */
function BackupInspectView({ result, t }: {
  result: BackupInspectResult
  t: TranslateNS<'config-manager'>
}) {
  const sections = inspectSections(result.analysis, result.plan)
  const summary = inspectSummary(result.analysis, result.plan)
  // 分组标题字典键（冲突/变更/路径映射/一致跳过/其他 —— 与 InspectGroupKey 一一对应）
  const groupLabelKey = (key: InspectGroupKey): 'backupFiles.inspectGroup.conflicts' | 'backupFiles.inspectGroup.changes' | 'backupFiles.inspectGroup.paths' | 'backupFiles.inspectGroup.skipped' | 'backupFiles.inspectGroup.others' => {
    switch (key) {
      case 'conflicts': return 'backupFiles.inspectGroup.conflicts'
      case 'changes': return 'backupFiles.inspectGroup.changes'
      case 'paths': return 'backupFiles.inspectGroup.paths'
      case 'skipped': return 'backupFiles.inspectGroup.skipped'
      case 'others': return 'backupFiles.inspectGroup.others'
    }
  }
  // kindTag 颜色变体（kind → CSS 类；颜色语义见 backup-inspect.ts InspectChangeGroup.kind）
  const kindTagClass = (kind: 'error' | 'info' | 'warn' | 'ok'): string => {
    switch (kind) {
      case 'error': return css.kindTagError ?? ''
      case 'warn': return css.kindTagWarn ?? ''
      case 'ok': return css.kindTagOk ?? ''
      case 'info': return css.kindTagInfo ?? ''
    }
  }
  const groups = inspectGroupedChanges(summary)
  return (
    <div>
      {/* 分区清单（条目计数徽章） */}
      <div className={css.inspectGroup}>
        <div className={css.groupLabel}>{t('backupFiles.inspectSections')}</div>
        <div className={css.statRow}>
          {sections.map((s) => (
            <Badge key={s.section} kind="info">{s.section}: {s.count}</Badge>
          ))}
        </div>
      </div>

      {/* 差异摘要（导这个备份会动你什么） */}
      <div className={css.inspectGroup}>
        <div className={css.groupLabel}>{t('backupFiles.inspectDiff')}</div>
        <div className={css.statRow}>
          {summary.willChange > 0 && <Badge kind="info">{t('import.preview.willChange', { count: String(summary.willChange) })}</Badge>}
          {summary.unchanged > 0 && <Badge kind="ok">{t('import.preview.unchanged', { count: String(summary.unchanged) })}</Badge>}
          {summary.conflicts > 0 && <Badge kind="error">{t('import.preview.conflicts', { count: String(summary.conflicts) })}</Badge>}
          {summary.secretsNeeded > 0 && <Badge kind="warn">{t('import.preview.secrets', { count: String(summary.secretsNeeded) })}</Badge>}
          {summary.pathMappingsNeeded > 0 && <Badge kind="warn">{t('import.preview.paths', { count: String(summary.pathMappingsNeeded) })}</Badge>}
          {summary.needsRestart && <Badge kind="warn">{t('report.needsRestart')}</Badge>}
        </div>
      </div>

      {/* 变更明细：按优先级分组（冲突 → 变更 → 路径映射 → 一致跳过 → 其他） */}
      {groups.length > 0 && (
        <div className={css.inspectGroup}>
          <div className={css.groupLabel}>{t('backupFiles.inspectItems')}</div>
          {groups.map((group) => (
            <div key={group.key} className={css.inspectGroup}>
              <div className={css.groupHeader}>
                <span className={css.groupLabel}>{t(groupLabelKey(group.key))}</span>
                <Badge kind={group.kind}>{String(group.items.length)}</Badge>
              </div>
              <div className={css.reportScroll}>
                <ul className={css.reportList}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <span className={`${css.kindTag} ${kindTagClass(group.kind)}`}>{item.kind}</span>
                      {/* 差异查看的计划项文本由宿主拼装 → 渲染前过 redact（安全自查） */}
                      {' '}{item.adapter}: {redact(item.description)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
