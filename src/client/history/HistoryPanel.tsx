/**
 * 迁移历史面板（Phase 6，Step 7）：展示统一审计史——过滤（kind/结果/时间范围/文本）+ 统计
 * + 分组列表 + 导出（JSON/Markdown）。
 *
 * 数据流：`HistoryApi.list()` 读取（经 Host 侧 sanitizeEntry 已脱敏）；纯函数渲染模型
 * `src/ui/history-model.ts`（node 可测）分组/统计/过滤；`HistoryPanel` 只做装配（渲染 + 交互）。
 * 状态组件内自持（useState）：低频面板不持久化列表（历史可随时重载）。
 *
 * 安全：所有 summary/error 文本渲染前过 redact() 兜底（存储已清洗，双保险）；
 * kind/result/sections 均为枚举常量，无 secret 承载面。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { redact } from '../../security/redaction.ts'
import { HistoryApi, type HistoryListResult, type HistoryExportFormat } from './history-api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import {
  resultBadgeKind, kindLabelKey, groupByKind, summarize,
  filterByText, applyRecent, HISTORY_KIND_OPTIONS, HISTORY_RESULT_OPTIONS,
  type HistoryFilter,
} from '../../ui/history-model.ts'
import type { StoredMigrationHistoryEntry } from '../../core/migration-history.ts'
import css from '../config-manager.module.css'

export interface HistoryPanelProps {
  historyApi: HistoryApi
  t: TranslateNS<'config-manager-history'>
}

interface PanelState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  result: HistoryListResult | null
  filter: HistoryFilter
  exporting: 'json' | 'markdown' | null
  exportNote: string | null
}

export function HistoryPanel({ historyApi, t }: HistoryPanelProps) {
  const [state, setState] = useState<PanelState>({
    status: 'loading',
    error: null,
    result: null,
    filter: { query: '' },
    exporting: null,
    exportNote: null,
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = async (): Promise<void> => {
    setState((s) => ({ ...s, status: 'loading', error: null }))
    try {
      const result = await historyApi.list()
      if (mounted.current) setState((s) => ({ ...s, status: 'ready', result }))
    } catch (error) {
      if (mounted.current) setState((s) => ({ ...s, status: 'error', error: error instanceof Error ? error.message : String(error) }))
    }
  }
  useEffect(() => { void load() }, [historyApi]) // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (patch: Partial<HistoryFilter>): void => {
    setState((s) => ({ ...s, filter: { ...s.filter, ...patch } }))
  }

  const handleExport = async (format: HistoryExportFormat): Promise<void> => {
    setState((s) => ({ ...s, exporting: format, exportNote: null }))
    try {
      await historyApi.exportReport(format, {
        kind: state.filter.kind,
        result: state.filter.result,
      })
      if (mounted.current) setState((s) => ({ ...s, exporting: null, exportNote: t('history.exported') }))
    } catch (error) {
      if (mounted.current) setState((s) => ({ ...s, exporting: null, exportNote: `${t('history.exportError')}: ${redact(error instanceof Error ? error.message : String(error))}` }))
    }
  }

  if (state.status === 'loading') {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('history.title')} subtitle={t('history.subtitle')} />
        <div className={css.statRow}><span className={css.hint}>{t('history.loading')}</span></div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('history.title')} subtitle={t('history.subtitle')} />
        <ErrorBanner error={new Error(redact(state.error ?? ''))} onRetry={() => void load()} />
      </div>
    )
  }

  const entries = state.result?.entries ?? []
  // 过滤（后端 kind/result + 客户端 recent/文本子串）
  let filtered = entries
  if (state.filter.recent !== undefined && state.filter.recent > 0) filtered = applyRecent(filtered, state.filter.recent)
  filtered = filterByText(filtered, state.filter.query)
  const summary = summarize(filtered)
  const groups = groupByKind(filtered)
  const corrupted = state.result?.corrupted ?? []

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('history.title')} subtitle={t('history.subtitle')} />

      {/* 统计徽章行 */}
      <div className={css.statRow}>
        <Badge kind="info">{t('history.stats.total')}: {summary.total}</Badge>
        <Badge kind="ok">{t('history.stats.success')}: {summary.success}</Badge>
        <Badge kind="error">{t('history.stats.failed')}: {summary.failed}</Badge>
        <Badge kind="warn">{t('history.stats.skipped')}: {summary.skipped}</Badge>
      </div>

      {/* 篡改/损坏条目警示 */}
      {corrupted.length > 0 && (
        <Banner kind="warn">
          <div>{t('history.corruptedBanner')}</div>
          <div className={css.hint}>{t('history.corruptedCount', { count: String(corrupted.length) })}</div>
        </Banner>
      )}

      {/* 过滤 + 导出操作行 */}
      <Card>
        <div className={css.groupLabel}>{t('history.filter.title')}</div>
        <div className={css.actionRow}>
          <select
            className={css.select}
            value={state.filter.kind ?? ''}
            onChange={(e) => setFilter({ kind: e.target.value === '' ? undefined : e.target.value as never })}
          >
            <option value="">{t('history.filter.kind')}: 全部</option>
            {HISTORY_KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>{t(kindLabelKey(k))}</option>
            ))}
          </select>
          <select
            className={css.select}
            value={state.filter.result ?? ''}
            onChange={(e) => setFilter({ result: e.target.value === '' ? undefined : e.target.value as never })}
          >
            <option value="">{t('history.filter.result')}: 全部</option>
            {HISTORY_RESULT_OPTIONS.map((r) => (
              <option key={r} value={r}>{t(`history.result.${r}`)}</option>
            ))}
          </select>
          <select
            className={css.select}
            value={state.filter.recent ?? 0}
            onChange={(e) => setFilter({ recent: Number(e.target.value) })}
          >
            <option value="0">{t('history.filter.recent.all')}</option>
            <option value="50">{t('history.filter.recent.50')}</option>
            <option value="200">{t('history.filter.recent.200')}</option>
          </select>
          <input
            className={css.input}
            type="search"
            placeholder={t('history.search.placeholder')}
            value={state.filter.query}
            onChange={(e) => setFilter({ query: e.target.value })}
          />
          <Button onClick={() => void load()}>{t('history.refresh')}</Button>
          <Button
            onClick={() => void handleExport('json')}
            disabled={state.exporting !== null || summary.total === 0}
          >
            {state.exporting === 'json' ? t('history.exporting') : t('history.export.json')}
          </Button>
          <Button
            onClick={() => void handleExport('markdown')}
            disabled={state.exporting !== null || summary.total === 0}
          >
            {state.exporting === 'markdown' ? t('history.exporting') : t('history.export.markdown')}
          </Button>
        </div>
        {state.exportNote !== null && <div className={css.hint}>{state.exportNote}</div>}
      </Card>

      {/* 空态 */}
      {filtered.length === 0 ? (
        <Empty>{t('history.empty')}</Empty>
      ) : (
        <HistoryList groups={groups} t={t} />
      )}
    </div>
  )
}

function HistoryList({ groups, t }: { groups: ReturnType<typeof groupByKind>; t: TranslateNS<'config-manager-history'> }) {
  return (
    <Card>
      {groups.map((g) => (
        <div key={g.kind} className={css.historyGroup}>
          <div className={css.statRow}>
            <Badge kind="info">{t(g.kindLabelKey)}</Badge>
            <Badge kind="info">{g.count}</Badge>
          </div>
          <div className={css.historyScroll}>
            {g.entries.map((e) => (
              <HistoryRow key={e.at + e.kind} entry={e} t={t} />
            ))}
          </div>
        </div>
      ))}
    </Card>
  )
}

function HistoryRow({ entry, t }: { entry: StoredMigrationHistoryEntry; t: TranslateNS<'config-manager-history'> }) {
  const result = <Badge kind={resultBadgeKind(entry.result)}>{t(`history.result.${entry.result}`)}</Badge>
  const summary = redact(entry.summary + (entry.error !== undefined ? ` — ${entry.error}` : ''))
  return (
    <div className={css.historyRow}>
      <div className={css.historyRowMain}>
        <span className={css.historyTime}>{entry.at}</span>
        {result}
        <span className={css.historySections}>{redact(entry.sections.join(', '))}</span>
        <span className={css.historySummary}>{summary}</span>
      </div>
    </div>
  )
}
