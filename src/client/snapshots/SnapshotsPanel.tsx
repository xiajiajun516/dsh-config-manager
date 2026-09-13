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
import type { RestorePlan, RestoreReport, SnapshotMeta } from '../../core/restore.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import { ConsultCard } from '../consult/ConsultCard.tsx'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import type { RecoveryPort } from '../../ui/types.ts'
import { RecoveryPanel } from '../recovery/RecoveryPanel.tsx'
import { Badge, Banner, Button, Card, Checkbox, Empty, IconButton, Segmented, Spinner, StatusDot } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { SnapshotIcon, RefreshIcon, DownloadIcon, ImportIcon, InspectIcon, DeleteIcon, ClockIcon, PencilIcon, MessageIcon } from '../common/Icon.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { runStore, toSnapshotsStoreSlice, type SnapshotsStoreSlice, type SnapshotsSubTab } from '../run-store.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import type { BackupInspectResult } from '../api.ts'
import { inspectGroupedChanges, inspectSections, inspectSummary } from '../../ui/backup-inspect.ts'
import type { InspectGroupKey } from '../../ui/backup-inspect.ts'
import { formatBytes } from '../../ui/report.ts'
import {
  BACKUP_INTERVAL_OPTIONS,
  DEFAULT_RETENTION_POLICY,
  RETENTION_FIELDS,
  RETENTION_FIELD_LIMITS,
  WEEKDAY_OPTIONS,
  backupDraftDirty,
  backupRunBadgeKind,
  hasRetentionTiers,
  normalizeRetentionPolicy,
  validateBackupScheduleDraft,
  type BackupInterval,
  type BackupRunStatus,
  type BackupScheduleDraft,
  type BackupScheduleStatus,
  type BackupWeeklySchedule,
  type RetentionPolicy,
} from '../../ui/backup-schedule.ts'
import css from '../config-manager.module.css'

export interface SnapshotsPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 恢复（Phase 5）子视图，透传给 RecoveryPanel */
  recoveryApi: RecoveryPort
  recoveryT: TranslateNS<'config-manager-recovery'>
}

interface PanelState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  metas: SnapshotMeta[]
  selectedId: string | null
  planning: boolean
  plan: RestorePlan | null
  running: boolean
  report: RestoreReport | null
  /** 仅承载「恢复计划（dry-run）加载失败」——渲染点在计划预览弹窗内。
   *  其余动作失败（执行恢复/置顶/删除）走全局 Toast，绝不写这里：
   *  那些动作发生时弹窗已关闭，写进来等于没有任何渲染点（曾经就是这样静默丢失的）。 */
  actionError: string | null
}

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

/** 中段省略（文件名：保留头尾，中段 …——尾部时间戳是唯一区分信息，不可被截掉）。 */
function midEllipsis(s: string, max = 26): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

const initial: PanelState = {
  status: 'loading',
  error: null,
  metas: [],
  selectedId: null,
  planning: false,
  plan: null,
  running: false,
  report: null,
  actionError: null,
}

function statusLabel(t: TranslateNS<'config-manager'>, status: SnapshotMeta['status']): string {
  switch (status) {
    case 'pending': return t('snapshots.status.pending')
    case 'done': return t('snapshots.status.done')
    case 'rolled-back': return t('snapshots.status.rolled-back')
    default: return t('snapshots.status.unknown')
  }
}

function statusBadgeKind(status: SnapshotMeta['status']): 'info' | 'ok' | 'warn' | 'error' {
  switch (status) {
    case 'pending': return 'info'
    case 'done': return 'ok'
    case 'rolled-back': return 'warn'
    default: return 'error'
  }
}

/** 计划动作的本地化描述前缀（kind 标签 → 字典；未知名回退 unknown，不透出英文原文） */
function actionKindLabel(t: TranslateNS<'config-manager'>, kind: string): string {
  switch (kind) {
    case 'hostFileRestore': return t('snapshots.kind.hostFileRestore')
    case 'hostFileRemove': return t('snapshots.kind.hostFileRemove')
    case 'pluginRemove': return t('snapshots.kind.pluginRemove')
    case 'fileRestore': return t('snapshots.kind.fileRestore')
    case 'fileRemove': return t('snapshots.kind.fileRemove')
    case 'credentialHint': return t('snapshots.kind.credentialHint')
    case 'skip': return t('snapshots.kind.skip')
    default: return t('snapshots.kind.unknown')
  }
}

/**
 * 从 runStore 恢复上次的快照面板状态（切页回 / 刷新后挂载）。
 * 无敏感字段；plan/report 为纯数据，可安全序列化恢复。
 * running 来自 store 镜像（刷新后经 runStore.resume() 以宿主 /runs 为权威重新置位）。
 */
function initFromStore(): PanelState {
  const s: SnapshotsStoreSlice = runStore.getSnapshot().snapshots
  return {
    ...initial,
    selectedId: s.selectedId,
    running: s.running,
    plan: s.plan,
    report: s.report,
    actionError: s.actionError,
    error: s.error,
  }
}

export function SnapshotsPanel({ api, t, recoveryApi, recoveryT }: SnapshotsPanelProps) {
  const [state, setState] = useState<PanelState>(initFromStore)
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
    patch({ selectedId: id, plan: null, report: null, actionError: null, planning: true })
    // 计划预览在弹窗内展示：点击行即打开弹窗，loading/结果/错误都在弹窗内呈现
    setPlanOpen(true)
    api.restoreSnapshot(id, true).then(
      (res) => {
        if (generation !== planGeneration.current) return
        patch({ planning: false, plan: res.plan ?? null })
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

  const summary = (): string => {
    const s = state.plan?.summary
    if (s === undefined) return ''
    return t('snapshots.summary', {
      hostFileRestores: String(s.hostFileRestores),
      hostFileRemoves: String(s.hostFileRemoves),
      pluginRemoves: String(s.pluginRemoves),
      fileRestores: String(s.fileRestores),
      fileRemoves: String(s.fileRemoves),
      credentialHints: String(s.credentialHints),
      skips: String(s.skips),
    })
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
            /* 空态页：垂直居中 + 图形 + 双 CTA（立即备份 / 查看备份文件） */
            <div className={css.emptyHero}>
              <span className={css.emptyHeroSymbol} aria-hidden="true"><SnapshotIcon size={28} /></span>
              <span className={css.emptyHeroTitle}>{t('snapshots.empty.title')}</span>
              <span className={css.emptyHeroBody}>{t('snapshots.empty.body')}</span>
              <div className={css.toolRow} style={{ justifyContent: 'center', marginBottom: 0 }}>
                <Button size="sm" onClick={() => { switchSubTab('files') }}>{t('snapshots.empty.viewFiles')}</Button>
                <Button size="sm" variant="primary" onClick={() => {
                  api.runBackupNow().then(() => { setBackupFilesTick((n) => n + 1) }, () => {})
                }}>
                  {t('snapshots.empty.runBackup')}
                </Button>
              </div>
            </div>
          )}

          {state.status === 'ready' && state.metas.length > 0 && (
            <>
              <div className={css.hint} style={{ marginBottom: 8 }}>
                {/* m-retention：分母取宿主真实策略（可配置）；宿主未返回时回退缺省常量 */}
                {t('snapshots.retentionHint', {
                  count: String((retentionPolicy ?? DEFAULT_RETENTION_POLICY).keepLast),
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
                      {state.metas.map((meta) => {
                        const selected = meta.id === state.selectedId
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
                            onClick={() => { select(meta.id) }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                select(meta.id)
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
                            <td><Badge kind={statusBadgeKind(meta.status)}>{statusLabel(t, meta.status)}</Badge></td>
                            <td className={css.num}>{meta.entryCount}</td>
                            <td className={css.num}>{meta.beforePluginCount}</td>
                            <td className={css.cellActions}>
                              <span className={css.rowActions}>
                                <Button size="sm" disabled={managing} onClick={() => { togglePin(meta) }}>
                                  {meta.pinned === true ? t('snapshots.unpin') : t('snapshots.pin')}
                                </Button>
                                <Button size="sm" variant="danger" disabled={managing} onClick={() => { setDeleteTarget({ id: meta.id, createdAt: meta.createdAt }) }}>
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

              {state.report !== null && (
                <>
                  <div className={css.groupHeader}>
                    <span className={css.groupLabel}>{t('snapshots.reportTitle')}</span>
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
              onClose={() => { setPlanOpen(false) }}
              closeDisabled={state.running}
            />
            <Modal.Body scroll>
              <div className={css.hint}>{t('snapshots.selectHint')}</div>
              {state.planning && <Spinner label={t('common.loading')} />}
              {state.plan !== null && summary() !== '' && <div className={css.hint}>{summary()}</div>}
              {state.plan !== null && state.plan.actions.length === 0 && (
                <Empty>{t('snapshots.noActions')}</Empty>
              )}
              {state.plan !== null && state.plan.actions.length > 0 && (
                <div className={css.planScroll}>
                  <ul className={css.reportList}>
                    {state.plan.actions.map((action, i) => (
                      <li key={`plan-${i}`}>
                        <span className={css.kindTag}>{actionKindLabel(t, action.kind)}</span>
                        {' '}{action.description}
                        {action.detail !== undefined && <span className={css.hint}>（{action.detail}）</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Phase 7 迁移前咨询卡（只读健康评分 + 建议） */}
              {consultLoading && <Spinner label={api.t('consult.loading')} />}
              {consultReport !== null && <ConsultCard report={consultReport} t={api.t} />}
              {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}
            </Modal.Body>
            <Modal.Footer>
              <Button disabled={state.running} onClick={() => { setPlanOpen(false) }}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={state.running || state.plan === null || state.plan.actions.every((a) => a.kind === 'skip')}
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

/* ------------------------------------------------- 定时全量备份设置卡 */

/** 间隔档位 → 字典键（t 的类型是字面量联合，switch 保持类型安全）。 */
function intervalLabel(t: TranslateNS<'config-manager'>, interval: BackupInterval): string {
  switch (interval) {
    case '6h': return t('backupSchedule.interval.6h')
    case '12h': return t('backupSchedule.interval.12h')
    case '24h': return t('backupSchedule.interval.24h')
    case '7d': return t('backupSchedule.interval.7d')
    case 'custom': return t('backupSchedule.interval.custom')
  }
}

/** 星期序号 → 字典键（0-6；switch 保持类型安全）。 */
function weekdayLabel(t: TranslateNS<'config-manager'>, dayOfWeek: number): string {
  switch (dayOfWeek) {
    case 0: return t('backupSchedule.weekday.sunday')
    case 1: return t('backupSchedule.weekday.monday')
    case 2: return t('backupSchedule.weekday.tuesday')
    case 3: return t('backupSchedule.weekday.wednesday')
    case 4: return t('backupSchedule.weekday.thursday')
    case 5: return t('backupSchedule.weekday.friday')
    case 6: return t('backupSchedule.weekday.saturday')
    default: return String(dayOfWeek)
  }
}

/** 上次运行状态 → 字典键。 */
function runStatusLabel(t: TranslateNS<'config-manager'>, status: BackupRunStatus | undefined): string {
  switch (status) {
    case 'success': return t('backupSchedule.status.success')
    case 'skipped': return t('backupSchedule.status.skipped')
    case 'failed': return t('backupSchedule.status.failed')
    default: return '—'
  }
}

function formatRunTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * 定时全量备份设置卡：总开关 + 间隔档位 + 上次运行状态 + 保存 / 立即备份。
 * 状态自持；草稿镜像 runStore.snapshots.backupDraft（未保存修改切页/刷新保留），
 * 保存成功清草稿（宿主配置为权威）。
 */
function BackupScheduleCard({ api, t, onBackupDone }: {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 「立即备份」成功完成后回调（父组件据此刷新备份文件列表） */
  onBackupDone?: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BackupScheduleDraft>({ enabled: false, interval: '24h' })
  const [saved, setSaved] = useState<BackupScheduleStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<BackupRunStatus | undefined>(undefined)
  const [lastRunDetail, setLastRunDetail] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  /** m-retention：保留策略草稿（三层；与 interval/customSchedule 同属草稿，随保存一起提交） */
  const [retentionDraft, setRetentionDraft] = useState<RetentionPolicy>(DEFAULT_RETENTION_POLICY)
  /** 挂载守卫：切页卸载后异步回调只更新 store（草稿），不再 setState */
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    api.backupSchedule().then(
      (schedule) => {
        if (!mountedRef.current) return
        setSaved(schedule)
        // 有未保存草稿（切页回来）则保留，否则以宿主配置为权威
        setDraft(runStore.getSnapshot().snapshots.backupDraft ?? {
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        // m-retention：未保存草稿里的策略优先（切页回来不丢），否则取宿主真值（缺省补齐）
        setRetentionDraft(
          normalizeRetentionPolicy(runStore.getSnapshot().snapshots.backupDraft?.retention ?? schedule.retention),
        )
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
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

  const updateDraft = (next: BackupScheduleDraft): void => {
    setDraft(next)
    runStore.patch({ snapshots: { backupDraft: next } })
  }

  /** m-retention：更新保留策略草稿（随 enabled/interval 一起提交；同时镜像 runStore 防切页丢失） */
  const updateRetention = (next: RetentionPolicy): void => {
    setRetentionDraft(next)
    updateDraft({ ...draft, retention: next })
  }

  const save = (): void => {
    if (saving || running) return
    // m-retention：策略草稿合并进提交体（单入口校验：非法整数/超范围在此被拦下）
    const parsed = validateBackupScheduleDraft({ ...draft, retention: retentionDraft })
    if (!parsed.ok) {
      // 表单内联校验：位置有语义（紧邻被校验的控件），保留就地提示而非 Toast
      setDraftError(parsed.error)
      return
    }
    setSaving(true)
    setDraftError(null)
    api.saveBackupSchedule(parsed.value).then(
      (schedule) => {
        // 宿主已保存：无论面板是否仍挂载都清 store 草稿（否则切回会显示陈旧未保存态）
        runStore.patch({ snapshots: { backupDraft: null } })
        if (!mountedRef.current) return
        setSaved(schedule)
        setDraft({
          enabled: schedule.enabled,
          interval: schedule.interval,
          ...(schedule.customSchedule !== undefined ? { customSchedule: schedule.customSchedule } : {}),
          retention: normalizeRetentionPolicy(schedule.retention),
        })
        // 以宿主回传为权威回填策略草稿（宿主持久化后的真值）
        setRetentionDraft(normalizeRetentionPolicy(schedule.retention))
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
        setSaving(false)
        toast.ok(t('backupSchedule.saved'))
      },
      (err) => {
        if (!mountedRef.current) return
        setSaving(false)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const runNow = (): void => {
    if (running || saving) return
    setRunning(true)
    setDraftError(null)
    api.runBackupNow().then(
      (res) => {
        if (mountedRef.current) {
          setSaved(res.schedule)
          // 运行结果不回写策略草稿（用户可能正在编辑；宿主配置已是权威，保存时以草稿为准）
          setLastRun(res.run.status)
          setLastRunDetail(res.run.zip !== undefined && res.run.zip !== ''
            ? res.run.zip
            : (res.run.skipReason !== undefined ? res.run.skipReason : formatRunTime(res.schedule.lastRunAt)))
          setRunning(false)
        }
        // 无论面板是否仍挂载都通知父组件刷新备份文件列表（新 ZIP 已落盘）
        onBackupDone?.()
      },
      (err) => {
        if (!mountedRef.current) return
        setRunning(false)
        toast.error(err instanceof Error ? err.message : String(err))
      },
    )
  }

  // m-retention：脏判定同时看策略草稿（策略改动也要让「保存设置」可点）
  const dirty = backupDraftDirty({ ...draft, retention: retentionDraft }, saved)
  const busy = saving || running
  /**
   * 事实行「备份间隔」文案：整行事实统一取宿主权威值 saved（与事实行语义一致，
   * 也与 SyncSettingsView 的状态事实行同源——草稿编辑只在下方设置行体现，
   * 未保存前不改写事实行，避免把未生效的档位显示成已生效）。
   * custom 档在窄格内显示具体时刻（如「周一 03:00」），其余档位用档位文案；
   * 均由既有 locale 键拼出，不新增文案键。
   */
  const intervalFact = saved === null || !saved.enabled
    ? '—'
    : saved.interval === 'custom'
      ? `${weekdayLabel(t, saved.customSchedule?.dayOfWeek ?? 1)} ${String(saved.customSchedule?.hour ?? 3).padStart(2, '0')}:${String(saved.customSchedule?.minute ?? 0).padStart(2, '0')}`
      : intervalLabel(t, saved.interval)

  return (
    <Card>
      {/* 头部：标题 + 上次运行结果徽章 + 右侧动作（时间已下移到事实行，头部不再重复） */}
      <div className={css.groupHeader}>
        <span className={css.groupLabel}>{t('backupSchedule.title')}</span>
        {lastRun !== undefined && (
          <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusLabel(t, lastRun)}</Badge>
        )}
        <span className={css.statusSpacer} />
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !dirty}
          onClick={save}
          title={dirty ? undefined : t('backupSchedule.saved')}
        >
          {saving ? <Spinner /> : t('backupSchedule.save')}
        </Button>
        <Button size="sm" disabled={busy || !(saved?.enabled ?? false)} onClick={runNow}>
          {running ? <Spinner /> : t('backupSchedule.runNow')}
        </Button>
      </div>

      {status === 'loading' && <Spinner label={t('backupSchedule.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {t('backupSchedule.error')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && (
        <>
          {/* 事实行：开关状态 / 备份间隔（各占半行）+ 上次运行（独占整行）。
              整行统一取宿主权威值 saved（未保存的草稿编辑不改写事实行，避免把未生效的
              档位显示成已生效）；时间已从头部移到这里，头部不再重复展示。
              .factGrid 是 4 列网格，前两格各 span 2 → 上半行两等分、无空列留白。 */}
          <div className={css.factGrid} style={{ marginTop: 8 }}>
            <div className={css.factCell} style={{ gridColumn: 'span 2' }}>
              <span className={css.factLabel}>{t('snapshots.status')}</span>
              <span className={css.factValue}>
                {/* 复用既有 .infoValue（inline-flex + 居中 + gap，且不覆盖字号/颜色）做图标文字对齐 */}
                <span className={css.infoValue}>
                  <StatusDot kind={(saved?.enabled ?? false) ? 'ok' : 'idle'} />
                  {(saved?.enabled ?? false) ? t('overview.state.on') : t('overview.state.off')}
                </span>
              </span>
            </div>
            <div className={css.factCell} style={{ gridColumn: 'span 2' }}>
              <span className={css.factLabel}>{t('backupSchedule.interval')}</span>
              <span className={css.factValue}>{intervalFact}</span>
            </div>
            {/* 上次运行独占整行（grid-column:1/-1）：lastRunDetail 在「立即备份」成功后
                是 ZIP 相对路径（可较长），四列窄格会被 text-overflow 截断成「…」。 */}
            <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
              <span className={css.factLabel}>{t('backupSchedule.lastRun')}</span>
              <span className={css.factValue}>
                {lastRun === undefined
                  /* 从未运行：只给一句事实，不补「—」占位（避免「从未运行 —」的双重否定感） */
                  ? <span className={css.hint}>{t('backupSchedule.never')}</span>
                  : (
                    <span className={css.infoValue}>
                      <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusLabel(t, lastRun)}</Badge>
                      <span className={css.mono}>
                        {lastRunDetail !== null && lastRunDetail !== '' ? lastRunDetail : '—'}
                      </span>
                    </span>
                  )}
              </span>
            </div>
          </div>
          {/* 卡片级说明（小字）：保留在事实行下方、设置行上方 —— 信息分层依次是
              头部（标题/徽章/动作）→ 事实行 → 说明 → 设置 */}
          <div className={css.hint} style={{ marginTop: 8 }}>{t('backupSchedule.hint')}</div>

          {/* 设置行：开关（短标签）+（已开启时）间隔 / 周几 / 时刻 */}
          <div className={css.actionRow} style={{ marginTop: 10, marginBottom: 0 }}>
            <Checkbox
              checked={draft.enabled}
              onChange={(checked) => { updateDraft({ ...draft, enabled: checked }) }}
              label={t('backupSchedule.enabled')}
              disabled={busy}
            />
            {draft.enabled && (
              <select
                className={css.select}
                value={draft.interval}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => { updateDraft({ ...draft, interval: event.target.value as BackupInterval }) }}
              >
                {BACKUP_INTERVAL_OPTIONS.map((interval) => (
                  <option key={interval} value={interval}>{intervalLabel(t, interval)}</option>
                ))}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.dayOfWeek ?? 1}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: Number(event.target.value),
                      hour: draft.customSchedule?.hour ?? 3,
                      minute: draft.customSchedule?.minute ?? 0,
                    },
                  })
                }}
              >
                {WEEKDAY_OPTIONS.map((w) => (
                  <option key={w.value} value={w.value}>{weekdayLabel(t, w.value)}</option>
                ))}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.hour ?? 3}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1,
                      hour: Number(event.target.value),
                      minute: draft.customSchedule?.minute ?? 0,
                    },
                  })
                }}
              >
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            )}
            {draft.enabled && draft.interval === 'custom' && (
              <select
                className={css.select}
                value={draft.customSchedule?.minute ?? 0}
                disabled={busy}
                style={{ width: 'auto' }}
                onChange={(event) => {
                  updateDraft({
                    ...draft,
                    customSchedule: {
                      dayOfWeek: draft.customSchedule?.dayOfWeek ?? 1,
                      hour: draft.customSchedule?.hour ?? 3,
                      minute: Number(event.target.value),
                    },
                  })
                }}
              >
                {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
              </select>
            )}
          </div>
          {/* 设置行说明：勾选启用后启动即执行一次（行为说明；卡片级 hint 只讲「备什么」，
              此处讲「何时跑」，两者语义不重复，故仅在已开启时出现，避免未开启时的说明噪音） */}
          {draft.enabled && <div className={css.hint} style={{ marginTop: 6 }}>{t('backupSchedule.enabledHint')}</div>}
          {/* custom 档专属说明：仅在已开启且选中自定义档时出现，紧贴上面的三个时刻下拉 */}
          {draft.enabled && draft.interval === 'custom' && <div className={css.hint} style={{ marginTop: 6 }}>{t('backupSchedule.customHint')}</div>}

          {/* m-retention：保留策略（GFS 分层；快照 + 定时备份共用）——无常量硬编码，值全来自本卡片状态 */}
          <div className={css.groupHeader} style={{ marginTop: 12 }}>
            <span className={css.groupLabel}>{t('retention.title')}</span>
            <span className={css.statusSpacer} />
            <span className={css.hint}>
              {!hasRetentionTiers(retentionDraft) && t('retention.tiersOff')}
            </span>
          </div>
          <div className={css.hint} style={{ marginBottom: 8 }}>{t('retention.hint')}</div>
          <div className={css.actionRow} style={{ marginBottom: 0 }}>
            {RETENTION_FIELDS.map((field) => {
              const limits = RETENTION_FIELD_LIMITS[field]
              const unit = field === 'keepLast'
                ? t('retention.unit')
                : field === 'keepMonthly' ? t('retention.months') : t('retention.years')
              return (
                <label key={field} className={css.field} style={{ margin: 0 }}>
                  <span className={css.fieldLabel}>
                    {field === 'keepLast'
                      ? t('retention.keepLast')
                      : field === 'keepMonthly' ? t('retention.keepMonthly') : t('retention.keepYearly')}
                  </span>
                  <input
                    className={css.input}
                    type="number"
                    min={limits.min}
                    max={limits.max}
                    step={1}
                    value={retentionDraft[field]}
                    disabled={busy}
                    style={{ width: 88 }}
                    aria-label={t('retention.title')}
                    onChange={(event) => {
                      // 空输入/非法文本 → 视为 0（受控 input 不吞掉用户输入，保存时再由校验层把关）
                      const raw = event.target.value
                      const parsed = raw === '' ? 0 : Number(raw)
                      updateRetention({
                        ...retentionDraft,
                        [field]: Number.isFinite(parsed) ? parsed : 0,
                      })
                    }}
                  />
                  <span className={css.hint}>{unit}</span>
                </label>
              )
            })}
          </div>
          {/* 三层字段各自的行为说明（紧贴对应输入；仅在有分层时才需要，未启用时是噪音） */}
          {hasRetentionTiers(retentionDraft) && (
            <div className={css.hint} style={{ marginTop: 6 }}>
              {t('retention.keepLastHint')} · {t('retention.keepMonthlyHint')} · {t('retention.keepYearlyHint')}
            </div>
          )}
          <div className={css.hint} style={{ marginTop: 6 }}>{t('retention.appliesTo')}</div>
          {/* P1-⑨：连续失败主动标红（≥1 次失败即在设置卡内醒目提示，恒在卡片底部、成块不被拆散） */}
          {(saved?.consecutiveFailures ?? 0) > 0 && (
            <div style={{ marginTop: 8 }}>
              <Banner kind="error" >
                {t('backupSchedule.consecutiveFailures', { count: String(saved!.consecutiveFailures) })}
              </Banner>
            </div>
          )}
        </>
      )}

      {draftError !== null && <Banner kind="error">{draftError}</Banner>}
    </Card>
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

  /** 搜索过滤（P0-④）：文件名 + 备注子串匹配（大小写不敏感）；空查询不过滤 */
  const visibleFiles = search.trim() === ''
    ? files
    : files.filter((f) => {
      const q = search.trim().toLowerCase()
      return f.name.toLowerCase().includes(q) || (f.note ?? '').toLowerCase().includes(q)
    })

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

  /** 修改时间（等宽 YYYY-MM-DD HH:mm；完整本地时间在 title）。 */
  const fullTime = (ms: number): string => {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /** 备注展示：全问号/控制符（编码损坏）→ 可读文案，其余原样。 */
  const noteText = (note: string): string =>
    /^[?\s]+$/.test(note) ? t('backupFiles.noteUnreadable') : note

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
                            <span className={css.cellMetaNote} title={file.note}><MessageIcon size={11} /><span className={css.cellMetaNoteText}>{noteText(file.note)}</span></span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className={css.num}>{formatBytes(file.sizeBytes)}</td>
                    <td className={css.dim} title={new Date(file.mtimeMs).toLocaleString()}>
                      <span className={css.mono} style={{ fontSize: '11px' }}>{fullTime(file.mtimeMs)}</span>
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
                      {' '}{item.adapter}: {item.description}
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
