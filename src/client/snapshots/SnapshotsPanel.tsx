/**
 * 快照恢复面板（M4）：列出快照 → 选择 → dry-run 计划预览 → 确认执行 → 诚实报告。
 *
 * 数据流：api.snapshots() 加载列表；选择快照后 api.restoreSnapshot(id, true) 拿
 * 恢复计划（零写入预览）；确认后 api.restoreSnapshot(id, false) 执行并展示报告
 * （restored / removedPlugins / manualHints（人工项高亮）/ failed / skipped）。
 * 状态组件内自持（useState），同时经 toSnapshotsStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」
 * （选中快照 / dry-run 计划 / 执行报告；快照列表本身可随时重载，不持久化）。
 *
 * 视图底部附「定时全量备份」设置卡（BackupScheduleCard，m-backup-schedule）：
 * 开关 + 间隔档位（6h/12h/24h/7d）保存经 PUT /backup-schedule（host 校验 + 重排
 * 调度器）；「立即备份」经 POST /backup-schedule/run 复用 BackupScheduler.runOnce
 * （同一时刻防重）。草稿镜像 runStore.snapshots.backupDraft（未保存修改切 tab /
 * 刷新保留）。安全：定时备份恒不含 secret、不加密；本卡无敏感字段。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RestorePlan, RestoreReport, SnapshotMeta } from '../../core/restore.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, Field, SectionTitle, Spinner } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { runStore, toSnapshotsStoreSlice, type SnapshotsStoreSlice } from '../run-store.ts'
import type { BackupFileMeta } from '../../sync/backup-files.ts'
import { formatBytes } from '../../ui/report.ts'
import {
  BACKUP_INTERVAL_OPTIONS,
  backupDraftDirty,
  backupRunBadgeKind,
  validateBackupScheduleDraft,
  type BackupInterval,
  type BackupRunStatus,
  type BackupScheduleDraft,
  type BackupScheduleStatus,
} from '../../ui/backup-schedule.ts'
import css from '../config-manager.module.css'

export interface SnapshotsPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
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
  actionError: string | null
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

/** 计划动作的本地化描述前缀（kind 标签 + 引擎已生成的中文 description） */
function actionKindLabel(kind: string): string {
  switch (kind) {
    case 'hostFileRestore': return '整文件还原'
    case 'hostFileRemove': return '整文件删除'
    case 'pluginRemove': return '卸载插件'
    case 'fileRestore': return '还原文件'
    case 'fileRemove': return '删除文件'
    case 'credentialHint': return '人工提示'
    case 'skip': return '跳过'
    default: return kind
  }
}

/**
 * 从 runStore 恢复上次的快照面板状态（切 tab 回 / 刷新后挂载）。
 * 无敏感字段；plan/report 为纯数据，可安全序列化恢复。
 * running 来自 store 镜像（刷新后经 runStore.resume() 以宿主 /runs 为权威重新置位——
 * 持久化白名单恒为 false，绝不把浏览器陈旧状态当成恢复执行中的依据）。
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

export function SnapshotsPanel({ api, t }: SnapshotsPanelProps) {
  const [state, setState] = useState<PanelState>(initFromStore)
  /** 最新 state 镜像（commit/卸载 flush 读取，避免闭包过期值） */
  const stateRef = useRef<PanelState>(state)
  /** 挂载守卫：卸载后不再 setState（store 镜像仍执行，异步结果照常落库） */
  const mountedRef = useRef(true)
  /** dry-run 计划请求代数：快速切换快照时作废在途旧请求（防晚到响应覆盖新选择） */
  const planGeneration = useRef(0)
  /** 执行恢复的二次确认弹窗开关（危险操作，DESIGN.md §8.11 场景） */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 备份文件列表刷新信号：BackupScheduleCard「立即备份」完成后递增触发重载 */
  const [backupFilesTick, setBackupFilesTick] = useState(0)

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（dry-run 计划/执行恢复）完成回调
   * 在组件已卸载（切走 tab）时也能把结果（plan/report）写进 store，切回恢复。
   * backupDraft 由 BackupScheduleCard 独立管理，此处从 store 读回原值避免覆盖。
   */
  const commit = (next: PanelState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    const store = runStore.getSnapshot().snapshots
    // 合并 store 中非 PanelState 字段（backupDraft / importBackup），避免镜像时覆盖
    runStore.patch({ snapshots: toSnapshotsStoreSlice({ ...next, backupDraft: store.backupDraft, importBackup: store.importBackup }) })
  }
  const patch = (p: Partial<PanelState>): void => commit({ ...stateRef.current, ...p })

  /** 卸载时置挂载守卫 + 最后镜像一次（防止「最后一次改动后立即切 tab」时丢状态）。 */
  useEffect(() => () => {
    mountedRef.current = false
    const store = runStore.getSnapshot().snapshots
    runStore.patch({ snapshots: toSnapshotsStoreSlice({ ...stateRef.current, backupDraft: store.backupDraft, importBackup: store.importBackup }) })
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

  const select = (id: string): void => {
    // 每次选择递增代数：用户快速切换快照时，旧 dry-run 请求晚到直接丢弃
    // （防止「选了 B 却显示 A 的计划」的状态串扰）。
    const generation = planGeneration.current + 1
    planGeneration.current = generation
    patch({ selectedId: id, plan: null, report: null, actionError: null, planning: true })
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
    // m3/P1-1：宿主侧权威防重（/restore 经 RunRegistry 登记，同 kind running → 409）；
    // 前端 running 只是 UX 镜像。watchRunning 轮询宿主 /runs + /progress——
    // 切 tab（卸载）后轮询继续，完成/失败经 applySettled 写入 store，切回 initFromStore 恢复。
    runStore.watchRunning('restore', 500)
    api.restoreSnapshot(state.selectedId, false).then(
      (res) => { patch({ running: false, report: res.report ?? null }) },
      (err) => {
        patch({
          running: false,
          actionError: err instanceof Error ? err.message : String(err),
        })
      },
    ).finally(() => { runStore.stopRunWatch('restore') })
  }

  const summary = (): string => {
    const s = state.plan?.summary
    if (s === undefined) return ''
    return `整文件还原 ${s.hostFileRestores} · 整文件删除 ${s.hostFileRemoves} · 插件卸载 ${s.pluginRemoves}`
      + ` · 文件还原 ${s.fileRestores} · 文件删除 ${s.fileRemoves} · 凭据提示 ${s.credentialHints} · 跳过 ${s.skips}`
  }

  const reportLine = (title: string, items: string[], warn: boolean): ReactNode => {
    if (items.length === 0) return null
    return (
      <Card className={css.card}>
        <strong className={warn ? css.warnText : undefined}>{title}（{items.length}）</strong>
        <div className={css.reportScroll}>
          <ul className={css.reportList}>
            {items.map((item, i) => <li key={`${title}-${i}`}>{item}</li>)}
          </ul>
        </div>
      </Card>
    )
  }

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('snapshots.title')} subtitle={t('snapshots.hint')} />

      {state.status === 'loading' && <Spinner label={t('snapshots.loading')} />}

      {state.status === 'error' && (
        <Banner kind="error">
          {state.error ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {state.status === 'ready' && state.metas.length === 0 && (
        <Empty>{t('snapshots.empty')}</Empty>
      )}

      {state.status === 'ready' && state.metas.length > 0 && (
        <>
          <div className={css.snapshotList} role="listbox" aria-label={t('snapshots.selectHint')}>
            <div className={css.snapshotRowHeader}>
              <span>{t('snapshots.createdAt')}</span>
              <span>{t('snapshots.sourceZip')}</span>
              <span>{t('snapshots.status')}</span>
              <span>{t('snapshots.entries')}</span>
              <span>{t('snapshots.plugins')}</span>
            </div>
            {state.metas.map((meta) => {
              const selected = meta.id === state.selectedId
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-active={selected ? '' : undefined}
                  className={css.snapshotRow}
                  disabled={state.planning || state.running}
                  onClick={() => { select(meta.id) }}
                >
                  <span title={meta.id}>{new Date(meta.createdAt).toLocaleString()}</span>
                  <span title={meta.sourceZip}>{meta.sourceZip}</span>
                  <span><Badge kind={statusBadgeKind(meta.status)}>{statusLabel(t, meta.status)}</Badge></span>
                  <span>{meta.entryCount}</span>
                  <span>{meta.beforePluginCount}</span>
                </button>
              )
            })}
          </div>

          {state.selectedId !== null && (
            <>
              {state.planning && <Spinner label={t('common.loading')} />}
              {state.plan !== null && (
                <Card>
                  <SectionTitle title={t('snapshots.planTitle')} subtitle={summary()} />
                  {state.plan.actions.length === 0 && <Empty>{t('snapshots.noActions')}</Empty>}
                  {state.plan.actions.length > 0 && (
                    <div className={css.planScroll}>
                      <ul className={css.reportList}>
                        {state.plan.actions.map((action, i) => (
                          <li key={`plan-${i}`}>
                            <span className={css.kindTag}>{actionKindLabel(action.kind)}</span>
                            {' '}{action.description}
                            {action.detail !== undefined && <span className={css.hint}>（{action.detail}）</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className={css.rowActions}>
                    <Button
                      variant="danger"
                      disabled={state.running || state.plan.actions.every((a) => a.kind === 'skip')}
                      onClick={() => { setConfirmOpen(true) }}
                    >
                      {state.running ? t('snapshots.executing') : t('snapshots.execute')}
                    </Button>
                  </div>
                  {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}
                </Card>
              )}
            </>
          )}

          {state.report !== null && (
            <>
              <SectionTitle title={t('snapshots.reportTitle')} />
              {reportLine(t('snapshots.restored'), state.report.restored, false)}
              {reportLine(t('snapshots.removedPlugins'), state.report.removedPlugins, false)}
              {reportLine(t('snapshots.manualHints'), state.report.manualHints, true)}
              {reportLine(t('snapshots.failed'), state.report.failed.map((f) => `${f.item}: ${f.reason}`), true)}
              {reportLine(t('snapshots.skipped'), state.report.skipped, false)}
            </>
          )}
        </>
      )}

      {/* 备份文件管理（exports 导出产物：手动导出 + 定时备份；下载/导入/删除） */}
      <BackupFilesCard api={api} t={t} refreshTick={backupFilesTick} />

      {/* 定时全量备份设置（独立于快照列表状态，始终展示；完成后刷新上方备份文件列表） */}
      <BackupScheduleCard
        api={api}
        t={t}
        onBackupDone={() => { setBackupFilesTick((n) => n + 1) }}
      />

      {/* 执行恢复二次确认（破坏性操作：整文件还原/删除 + 卸载插件；busy 防重复提交） */}
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
 * 状态自持；草稿镜像 runStore.snapshots.backupDraft（未保存修改切 tab/刷新保留），
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
  const [flash, setFlash] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 挂载守卫：切 tab 卸载后异步回调只更新 store（草稿），不再 setState（React 18 无告警但浪费） */
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    api.backupSchedule().then(
      (schedule) => {
        if (!mountedRef.current) return
        setSaved(schedule)
        // 有未保存草稿（切 tab 回来）则保留，否则以宿主配置为权威
        setDraft(runStore.getSnapshot().snapshots.backupDraft ?? { enabled: schedule.enabled, interval: schedule.interval })
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

  const save = (): void => {
    if (saving || running) return
    const parsed = validateBackupScheduleDraft(draft)
    if (!parsed.ok) {
      setActionError(parsed.error)
      return
    }
    setSaving(true)
    setFlash(null)
    setActionError(null)
    api.saveBackupSchedule(parsed.value).then(
      (schedule) => {
        // 宿主已保存：无论面板是否仍挂载都清 store 草稿（否则切回会显示陈旧未保存态）
        runStore.patch({ snapshots: { backupDraft: null } })
        if (!mountedRef.current) return
        setSaved(schedule)
        setDraft({ enabled: schedule.enabled, interval: schedule.interval })
        setLastRun(schedule.lastRunStatus)
        setLastRunDetail(formatRunTime(schedule.lastRunAt))
        setSaving(false)
        setFlash(t('backupSchedule.saved'))
      },
      (err) => {
        if (!mountedRef.current) return
        setSaving(false)
        setActionError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const runNow = (): void => {
    if (running || saving) return
    setRunning(true)
    setFlash(null)
    setActionError(null)
    api.runBackupNow().then(
      (res) => {
        if (mountedRef.current) {
          setSaved(res.schedule)
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
        setActionError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const dirty = backupDraftDirty(draft, saved)
  const busy = saving || running

  return (
    <Card className={css.card}>
      <div className={css.groupLabel}>{t('backupSchedule.title')}</div>
      <div className={css.hint}>{t('backupSchedule.hint')}</div>

      {status === 'loading' && <Spinner label={t('backupSchedule.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {t('backupSchedule.error')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && (
        <>
          <Field label={t('backupSchedule.enabled')}>
            <Checkbox
              checked={draft.enabled}
              onChange={(checked) => { updateDraft({ ...draft, enabled: checked }) }}
              label={t('backupSchedule.enabledHint')}
              disabled={busy}
            />
          </Field>
          <Field label={t('backupSchedule.interval')}>
            <select
              className={css.select}
              value={draft.interval}
              disabled={busy}
              onChange={(event) => { updateDraft({ ...draft, interval: event.target.value as BackupInterval }) }}
            >
              {BACKUP_INTERVAL_OPTIONS.map((interval) => (
                <option key={interval} value={interval}>{intervalLabel(t, interval)}</option>
              ))}
            </select>
          </Field>
          {lastRun !== undefined && (
            <div className={css.statRow}>
              <span className={css.hint}>{t('backupSchedule.lastRun')}</span>
              <Badge kind={backupRunBadgeKind(lastRun)}>{runStatusLabel(t, lastRun)}</Badge>
              {lastRunDetail !== null && lastRunDetail !== '' && <span className={css.hint}>{lastRunDetail}</span>}
            </div>
          )}
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={busy || !dirty}
              onClick={save}
              title={dirty ? undefined : t('backupSchedule.saved')}
            >
              {saving ? <Spinner label={t('backupSchedule.save')} /> : t('backupSchedule.save')}
            </Button>
            <Button disabled={busy || !(saved?.enabled ?? false)} onClick={runNow}>
              {running ? <Spinner label={t('backupSchedule.running')} /> : t('backupSchedule.runNow')}
            </Button>
          </div>
        </>
      )}

      {flash !== null && <Banner kind="ok">{flash}</Banner>}
      {actionError !== null && <Banner kind="error">{actionError}</Banner>}
    </Card>
  )
}

/* ------------------------------------------------- 备份文件管理卡 */

/**
 * 备份文件管理卡（m-backup-files）：列出 exports/ 下的导出 ZIP（手动导出 + 定时备份），
 * 提供下载（复用 /download）/ 一键导入（切 Import tab + 注入 zipPath，向导直接分析）/
 * 删除（危险操作二次确认）。
 *
 * 状态组件自持（列表可随时重载，不持久化；与快照列表同级）。refreshTick 由父组件在
 * 「立即备份」完成后递增触发重载。安全：文件路径来自宿主受控 exports 目录；删除按钮
 * 恒走 ConfirmDialog（danger）；导入 = 把 zipPath 交给现有导入向导（analyze 零写入，
 * 不经过上传）。
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
  const [actionError, setActionError] = useState<string | null>(null)
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

  const download = (file: BackupFileMeta): void => {
    setActionError(null)
    void api.download(file.path, { saveDialog: true }).catch((err) => {
      if (!mountedRef.current) return
      setActionError(err instanceof Error ? err.message : String(err))
    })
  }

  /** 一键导入：把备份文件 zipPath 交给现有导入向导（切 Import tab；向导挂载即分析） */
  const importBackup = (file: BackupFileMeta): void => {
    runStore.patch({
      view: 'import',
      panel: null,
      snapshots: { importBackup: { zipPath: file.path, name: file.name } },
    })
  }

  const doDelete = (): void => {
    const file = confirmDelete
    if (file === null || deleting) return
    setDeleting(true)
    setActionError(null)
    api.deleteBackupFile(file.name).then(
      () => {
        setDeleting(false)
        setConfirmDelete(null)
        load()
      },
      (err) => {
        setDeleting(false)
        setConfirmDelete(null)
        setActionError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <Card className={css.card}>
      <div className={css.groupLabel}>{t('backupFiles.title')}</div>
      <div className={css.hint}>{t('backupFiles.hint')}</div>

      {status === 'loading' && <Spinner label={t('backupFiles.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {error ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}

      {status === 'ready' && files.length === 0 && <Empty>{t('backupFiles.empty')}</Empty>}

      {status === 'ready' && files.length > 0 && (
        <div className={css.backupFileList} role="list" aria-label={t('backupFiles.title')}>
          {files.map((file) => (
            <div key={file.name} className={css.backupFileRow} role="listitem">
              <span className={css.backupFileName} title={file.name}>{file.name}</span>
              <Badge kind="info">
                {file.source === 'auto' ? t('backupFiles.source.auto') : t('backupFiles.source.manual')}
              </Badge>
              <span className={css.backupFileMeta}>{formatBytes(file.sizeBytes)}</span>
              <span className={css.backupFileMeta}>{new Date(file.mtimeMs).toLocaleString()}</span>
              <span className={css.actionRow}>
                <Button disabled={deleting} onClick={() => { download(file) }}>{t('backupFiles.download')}</Button>
                <Button disabled={deleting} onClick={() => { importBackup(file) }}>{t('backupFiles.import')}</Button>
                <Button variant="danger" disabled={deleting} onClick={() => { setConfirmDelete(file) }}>
                  {t('backupFiles.delete')}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {actionError !== null && <Banner kind="error">{actionError}</Banner>}

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
    </Card>
  )
}
