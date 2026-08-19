/**
 * 快照恢复面板（M4）：列出快照 → 选择 → dry-run 计划预览 → 确认执行 → 诚实报告。
 *
 * 数据流：api.snapshots() 加载列表；选择快照后 api.restoreSnapshot(id, true) 拿
 * 恢复计划（零写入预览）；确认后 api.restoreSnapshot(id, false) 执行并展示报告
 * （restored / removedPlugins / manualHints（人工项高亮）/ failed / skipped）。
 * 状态组件内自持（useState），同时经 toSnapshotsStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」
 * （选中快照 / dry-run 计划 / 执行报告；快照列表本身可随时重载，不持久化）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RestorePlan, RestoreReport, SnapshotMeta } from '../../core/restore.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { runStore, toSnapshotsStoreSlice, type SnapshotsStoreSlice } from '../run-store.ts'
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
 */
function initFromStore(): PanelState {
  const s: SnapshotsStoreSlice = runStore.getSnapshot().snapshots
  return {
    ...initial,
    selectedId: s.selectedId,
    plan: s.plan,
    report: s.report,
    actionError: s.actionError,
    error: s.error,
  }
}

export function SnapshotsPanel({ api, t }: SnapshotsPanelProps) {
  const [state, setState] = useState<PanelState>(initFromStore)
  /** 最新 state 镜像（卸载 flush 时读取，避免闭包过期值） */
  const stateRef = useRef<PanelState>(state)
  useEffect(() => { stateRef.current = state }, [state])

  /** 状态镜像：任何状态变化同步进 runStore（切 tab 不丢 / 刷新恢复）。 */
  useEffect(() => {
    runStore.patch({ snapshots: toSnapshotsStoreSlice(state) })
  }, [state])

  /** 卸载时最后镜像一次（防止「最后一次改动后立即切 tab」时镜像 effect 尚未 flush）。 */
  useEffect(() => () => {
    runStore.patch({ snapshots: toSnapshotsStoreSlice(stateRef.current) })
  }, [])

  const load = (): void => {
    setState((s) => ({ ...s, status: 'loading', error: null }))
    api.snapshots().then(
      (metas) => { setState((s) => ({ ...s, status: 'ready', metas })) },
      (err) => {
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }))
      },
    )
  }

  useEffect(load, [api])

  const select = (id: string): void => {
    setState((s) => ({ ...s, selectedId: id, plan: null, report: null, actionError: null, planning: true }))
    api.restoreSnapshot(id, true).then(
      (res) => { setState((s) => ({ ...s, planning: false, plan: res.plan ?? null })) },
      (err) => {
        setState((s) => ({
          ...s,
          planning: false,
          actionError: err instanceof Error ? err.message : String(err),
        }))
      },
    )
  }

  const execute = (): void => {
    if (state.selectedId === null || state.running) return
    setState((s) => ({ ...s, running: true, report: null, actionError: null }))
    api.restoreSnapshot(state.selectedId, false).then(
      (res) => { setState((s) => ({ ...s, running: false, report: res.report ?? null })) },
      (err) => {
        setState((s) => ({
          ...s,
          running: false,
          actionError: err instanceof Error ? err.message : String(err),
        }))
      },
    )
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
                      onClick={execute}
                      title={t('snapshots.confirmRestore')}
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
    </div>
  )
}
