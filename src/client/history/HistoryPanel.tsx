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
import { redact } from '../../security/redaction.ts'
import { HistoryApi, type HistoryListResult, type HistoryExportFormat } from './history-api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { toast } from '../common/toast-store.ts'
import {
  resultBadgeKind, kindLabelKey, groupByKind, summarize,
  filterByText, applyRecent, filterByKindResult,
  collectHistoryKinds, collectHistoryResults, formatHistorySections,
  type HistoryFilter,
} from '../../ui/history-model.ts'
// 复用同步历史的时间格式化（本地紧凑时间 + 完整时间悬停）：两个历史视图的时间观感必须一致
import { formatDateTime, formatDateTimeFull } from '../sync/history-model.ts'
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
  /** 导出中的格式（瞬态；结果反馈走全局 Toast，不再占页内一行灰字） */
  exporting: 'json' | 'markdown' | null
}

export function HistoryPanel({ historyApi, t }: HistoryPanelProps) {
  const [state, setState] = useState<PanelState>({
    status: 'loading',
    error: null,
    result: null,
    filter: { query: '' },
    exporting: null,
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
    setState((s) => ({ ...s, exporting: format }))
    try {
      await historyApi.exportReport(format, {
        kind: state.filter.kind,
        result: state.filter.result,
      })
      // 成功/失败分 kind 走 Toast：原先两者共用同一行灰色 hint，失败与成功视觉上无法区分
      toast.ok(t('history.exported'))
    } catch (error) {
      toast.error(`${t('history.exportError')}: ${redact(error instanceof Error ? error.message : String(error))}`)
    } finally {
      if (mounted.current) setState((s) => ({ ...s, exporting: null }))
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
        {/* F-02：t 必传 —— 否则英文界面下错误标题/建议动作恒中文 */}
        <ErrorBanner error={new Error(redact(state.error ?? ''))} onRetry={() => void load()} t={historyApi.t} />
      </div>
    )
  }

  const entries = state.result?.entries ?? []
  // 过滤链（顺序刻意如此：kind/result → recent → 文本）
  // ① kind/result：前端收敛（后端 list 一次性全量返回；filterToQuery 描述的 query 契约保留可用）
  // ② recent：按时间倒序截断，必须发生在文本过滤之前，否则「最近 N 条」语义会被文本命中数影响
  // ③ 文本：summary/error/kind/sections 子串
  let filtered = filterByKindResult(entries, state.filter.kind, state.filter.result)
  if (state.filter.recent !== undefined && state.filter.recent > 0) filtered = applyRecent(filtered, state.filter.recent)
  filtered = filterByText(filtered, state.filter.query)
  const summary = summarize(filtered)
  const groups = groupByKind(filtered)
  const corrupted = state.result?.corrupted ?? []
  // 下拉选项：只列当前数据里真实存在的 kind/result（全量 14 类里多数永远不会出现），
  // 并强制并入当前选中值 —— 否则会出现「选中了却在下拉里找不到该项」的怪状态。
  const kindOptions = collectHistoryKinds(entries, state.filter.kind)
  const resultOptions = collectHistoryResults(entries, state.filter.result)

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
            {kindOptions.map((k) => (
              <option key={k} value={k}>{t(kindLabelKey(k))}</option>
            ))}
          </select>
          <select
            className={css.select}
            value={state.filter.result ?? ''}
            onChange={(e) => setFilter({ result: e.target.value === '' ? undefined : e.target.value as never })}
          >
            <option value="">{t('history.filter.result')}: 全部</option>
            {resultOptions.map((r) => (
              <option key={r} value={r}>{t(`history.result.${r}`)}</option>
            ))}
          </select>
          <select
            className={css.select}
            value={state.filter.recent ?? 0}
            onChange={(e) => setFilter({ recent: Number(e.target.value) })}
          >
            {/* 与前两个下拉同构（「<维度>: 全部」），否则窄抽屉里三个「全部」含义不明 */}
            <option value="0">{t('history.filter.recent')}: {t('history.filter.recent.all')}</option>
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
  // 时间：本地紧凑时间（悬停给完整本地时间）。原样渲染 ISO（含 T/Z/毫秒）在 409px 抽屉里既占宽又难扫读。
  const time = formatDateTime(entry.at)
  const timeTitle = formatDateTimeFull(entry.at)
  const sections = formatHistorySections(entry.sections)
  const summary = redact(entry.summary + (entry.error !== undefined ? ` — ${entry.error}` : ''))
  // 两行结构：元信息（时间 · 结果 · 分区）+ 摘要独占一行 —— 摘要与元信息抢同一行时会被挤成碎片
  return (
    <div className={css.historyRow}>
      <div className={css.historyRowMain}>
        <div className={css.historyMeta}>
          <span className={css.historyTime} title={timeTitle !== '' ? timeTitle : undefined}>{time}</span>
          {result}
          {sections !== null && <span className={css.historySections}>{redact(sections)}</span>}
        </div>
        <span className={css.historySummary}>{summary}</span>
      </div>
    </div>
  )
}
