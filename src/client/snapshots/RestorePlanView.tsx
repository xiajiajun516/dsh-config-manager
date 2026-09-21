/**
 * 恢复计划预览的 git 风格视图（渲染壳，只做装配）。
 *
 * 结构（自上而下）：
 *   ① 摘要条：将被还原 / 新增 / 删除 / 卸载插件 / 需人工处理 / 无动作 + 行数合计（+X −Y）
 *   ② 分组清单：变更 → 删除 → 插件 → 人工 → 无动作（跳过默认折叠）
 *   ③ 每个文件行可点开 → 左右双栏逐行对照（左侧=当前磁盘内容，右侧=快照内容）
 *
 * 分工（AGENTS.md UI 铁律）：分组 / 统计 / 双栏对齐等逻辑在 src/ui/restore-plan-view.ts
 * 与 src/ui/diff-view.ts（纯函数、node 单测）；本组件只负责渲染与展开交互。
 * 安全：宿主拼装的 description/detail 与文件正文一律先过 redact() 再渲染（DESIGN.md §7）。
 */
import { Fragment, useMemo, useState } from 'react'
import { redact } from '../../security/redaction.ts'
import type { RestorePlan } from '../../core/restore.ts'
import type { ChangeStatSkipReason, RestoreChangeSummary, SnapshotFileDiff, SnapshotFileDiffReason } from '../../core/snapshot-diff.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { toRestorePlanView, withLoadedStatus, type RestorePlanRow } from '../../ui/restore-plan-view.ts'
import { countSideRows, maxLineDigits, toSideBySide, type SideBySideRow } from '../../ui/diff-view.ts'
import { formatBytes } from '../../ui/report.ts'
import { Badge, Banner, Spinner } from '../common/ui.tsx'
import css from '../config-manager.module.css'

/** 单文件差异加载状态（打开行时懒加载）。 */
type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: SnapshotFileDiff }
  | { status: 'error'; message: string }

/**
 * 单文件最多渲染多少行对：diff 上限 6000 行，全量渲染会卡住弹窗。
 * 超出只显示前 N 行并给出「已截断」提示（数据仍完整，只是没画出来）。
 */
const DIFF_ROW_CAP = 400

export interface RestorePlanViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  snapshotId: string
  plan: RestorePlan
  /** 宿主附带的变更统计（旧宿主可能不返回 → 退化为只按 kind 归类） */
  changeSummary?: RestoreChangeSummary
}

/** 变更状态标签（修改 / 新增 / 删除 / 卸载插件 / 人工提示 / 无动作）。 */
function statusLabel(t: TranslateNS<'config-manager'>, status: RestorePlanRow['status']): string {
  switch (status) {
    case 'modified': return t('snapshots.plan.status.modified')
    case 'added': return t('snapshots.plan.status.added')
    case 'deleted': return t('snapshots.plan.status.deleted')
    case 'plugin': return t('snapshots.plan.status.plugin')
    case 'hint': return t('snapshots.plan.status.hint')
    default: return t('snapshots.plan.status.skip')
  }
}

/** 状态语义色彩（复用既有 kindTag 四态）。 */
function statusTagClass(status: RestorePlanRow['status']): string {
  switch (status) {
    case 'modified': return `${css.kindTag} ${css.kindTagInfo}`
    case 'added': return `${css.kindTag} ${css.kindTagOk}`
    case 'deleted': return `${css.kindTag} ${css.kindTagError}`
    case 'plugin':
    case 'hint': return `${css.kindTag} ${css.kindTagWarn}`
    default: return css.kindTag ?? ''
  }
}

/**
 * 行数统计：\`+N\` 绿 / \`−M\` 红（git 同语义；必须拆成两个 span 才能分别着色）。
 * 未统计时退回原因文案。
 */
function RowStat({ t, row }: { t: TranslateNS<'config-manager'>; row: RestorePlanRow }) {
  if (row.added === undefined && row.removed === undefined) {
    return <span className={css.restorePlanStat}>{row.statSkipped === undefined ? '' : statSkipLabel(t, row.statSkipped)}</span>
  }
  return (
    <span className={css.restorePlanStat}>
      <span className={css.diffStatAdd}>+{row.added ?? 0}</span>
      {' '}
      <span className={css.diffStatDel}>−{row.removed ?? 0}</span>
    </span>
  )
}

function statSkipLabel(t: TranslateNS<'config-manager'>, reason: ChangeStatSkipReason): string {
  switch (reason) {
    case 'too-large': return t('snapshots.plan.statSkipped.tooLarge')
    case 'binary': return t('snapshots.plan.statSkipped.binary')
    case 'budget': return t('snapshots.plan.statSkipped.budget')
    default: return t('snapshots.plan.statSkipped.unreadable')
  }
}

/** 无法逐行对照的原因文案。 */
function reasonLabel(t: TranslateNS<'config-manager'>, reason: SnapshotFileDiffReason, diff: SnapshotFileDiff): string {
  switch (reason) {
    case 'binary': return t('snapshots.plan.diffBinary')
    case 'too-large': return t('snapshots.plan.diffTooLarge', { size: formatBytes(Math.max(diff.before.bytes, diff.after.bytes)) })
    case 'unreadable': return t('snapshots.plan.diffUnreadable')
    case 'missing-blob': return t('snapshots.plan.diffMissingBlob')
    case 'path-escape': return t('snapshots.plan.diffEscape')
    default: return t('snapshots.plan.diffNotApplicable')
  }
}

/** 单元格文本：文件正文属「宿主/磁盘原文」→ 展示前必过 redact()（安全闸门）。 */
function cellText(text: string | undefined): string {
  return text === undefined ? '' : redact(text)
}

/** 左侧单元格：成对修改 / 纯删除 → 红底；上下文 → 中性。 */
function leftCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'del' ? `${css.diffCell} ${css.diffCellDel}` : css.diffCell ?? ''
}

/** 右侧单元格：成对修改 / 纯新增 → 绿底；上下文 → 中性。 */
function rightCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'add' ? `${css.diffCell} ${css.diffCellAdd}` : css.diffCell ?? ''
}

function DiffPane({ state, t }: { state: DiffState; t: TranslateNS<'config-manager'> }) {
  if (state.status === 'loading') return <Spinner label={t('snapshots.plan.loadingDiff')} />
  if (state.status === 'error') return <Banner kind="error">{redact(state.message)}</Banner>
  const diff = state.diff
  if (diff.reason !== undefined) return <div className={css.hint}>{reasonLabel(t, diff.reason, diff)}</div>
  if (diff.identical) return <div className={css.hint}>{t('snapshots.plan.diffIdentical')}</div>
  const groups = toSideBySide(diff.hunks)
  const total = countSideRows(groups)
  // 行号列宽 = 实际出现的最大行号位数（1–3/4/5/6+ 位四档 ch），内容列平分剩余空间
  const digits = maxLineDigits(diff.hunks)
  const noColClass = digits <= 3 ? css.diffNoColW3 : digits === 4 ? css.diffNoColW4 : digits === 5 ? css.diffNoColW5 : css.diffNoColW6
  let rendered = 0
  const capped = total > DIFF_ROW_CAP
  return (
    <div className={css.diffPane}>
      {diff.degraded && <div className={css.hint}>{t('snapshots.plan.diffDegraded')}</div>}
      {capped && <div className={css.hint}>{t('snapshots.plan.diffTruncated', { shown: String(DIFF_ROW_CAP), total: String(total) })}</div>}
      <div className={css.diffScroll}>
        <table className={css.diffTable}>
          <colgroup>
            <col className={noColClass} />
            <col />
            <col className={noColClass} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className={css.diffNoHead} colSpan={2}>{t('snapshots.plan.beforeLabel')}</th>
              <th className={css.diffNoHead} colSpan={2}>{t('snapshots.plan.afterLabel')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const rows = capped ? group.rows.slice(0, Math.max(0, DIFF_ROW_CAP - rendered)) : group.rows
              rendered += rows.length
              return (
                <Fragment key={group.header}>
                  <tr className={css.diffHunkRow}>
                    <td colSpan={4}>{group.header}</td>
                  </tr>
                  {rows.map((row, index) => (
                    <tr key={`${group.header}-${String(index)}`}>
                      <td className={css.diffNo}>{row.left?.oldNo ?? ''}</td>
                      <td className={leftCellClass(row.kind)}>{cellText(row.left?.text)}</td>
                      <td className={css.diffNo}>{row.right?.newNo ?? ''}</td>
                      <td className={rightCellClass(row.kind)}>{cellText(row.right?.text)}</td>
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function RestorePlanView({ api, t, snapshotId, plan, changeSummary }: RestorePlanViewProps) {
  /** 已展开的行（按 plan.actions 下标） */
  const [openRows, setOpenRows] = useState<readonly number[]>([])
  /** 每个已展开文件的差异加载结果 */
  const [diffs, setDiffs] = useState<Record<number, DiffState>>({})
  /** 无动作（跳过）分组：默认折叠 —— 否则几十条「跳过」会把真实变更淹没 */
  const [skipsOpen, setSkipsOpen] = useState(false)

  const view = useMemo(() => {
    let current = toRestorePlanView(plan, changeSummary)
    for (const [key, state] of Object.entries(diffs)) {
      if (state.status !== 'ready') continue
      current = withLoadedStatus(current, Number(key), state.diff.status, state.diff.added, state.diff.removed)
    }
    return current
  }, [plan, changeSummary, diffs])

  const toggle = (row: RestorePlanRow): void => {
    if (!row.diffable) return
    const isOpen = openRows.includes(row.index)
    if (isOpen) {
      setOpenRows(openRows.filter((index) => index !== row.index))
      return
    }
    setOpenRows([...openRows, row.index])
    if (diffs[row.index] !== undefined) return
    setDiffs((previous) => ({ ...previous, [row.index]: { status: 'loading' } }))
    api.snapshotFileDiff({ snapshotId, kind: row.kind, target: row.target, blobPath: row.blobPath }).then(
      (diff) => { setDiffs((previous) => ({ ...previous, [row.index]: { status: 'ready', diff } })) },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setDiffs((previous) => ({ ...previous, [row.index]: { status: 'error', message } }))
      },
    )
  }

  const stats = view.stats
  return (
    <div className={css.restorePlan}>
      <div className={css.statRow}>
        {stats.changed > 0 && <Badge kind="info">{t('snapshots.plan.changed', { count: String(stats.changed) })}</Badge>}
        {stats.added > 0 && <Badge kind="ok">{t('snapshots.plan.added', { count: String(stats.added) })}</Badge>}
        {stats.deleted > 0 && <Badge kind="error">{t('snapshots.plan.deleted', { count: String(stats.deleted) })}</Badge>}
        {stats.plugins > 0 && <Badge kind="warn">{t('snapshots.plan.plugins', { count: String(stats.plugins) })}</Badge>}
        {stats.hints > 0 && <Badge kind="warn">{t('snapshots.plan.hints', { count: String(stats.hints) })}</Badge>}
        {stats.skips > 0 && <Badge kind="info">{t('snapshots.plan.skips', { count: String(stats.skips) })}</Badge>}
        {(stats.addedLines > 0 || stats.removedLines > 0) && (
          <span className={css.diffStatTotal}>
            <span className={css.diffStatAdd}>+{stats.addedLines}</span>
            {' '}
            <span className={css.diffStatDel}>−{stats.removedLines}</span>
          </span>
        )}
        {!view.summarized && <span className={css.hint}>{t('snapshots.plan.noStats')}</span>}
        {view.budgetExhausted && <span className={css.hint}>{t('snapshots.plan.statsTruncated')}</span>}
      </div>

      {view.groups.map((group) => {
        const collapsible = group.key === 'skips'
        const collapsed = collapsible && !skipsOpen
        const groupLabelKey = ((): 'snapshots.plan.group.changes' | 'snapshots.plan.group.deletes' | 'snapshots.plan.group.plugins' | 'snapshots.plan.group.hints' | 'snapshots.plan.group.skips' => {
          switch (group.key) {
            case 'changes': return 'snapshots.plan.group.changes'
            case 'deletes': return 'snapshots.plan.group.deletes'
            case 'plugins': return 'snapshots.plan.group.plugins'
            case 'hints': return 'snapshots.plan.group.hints'
            default: return 'snapshots.plan.group.skips'
          }
        })()
        return (
          <div key={group.key} className={css.inspectGroup}>
            <div className={css.restorePlanGroupHead}>
              {collapsible ? (
                <button type="button" className={css.diffGroupToggle} aria-expanded={skipsOpen} onClick={() => { setSkipsOpen(!skipsOpen) }}>
                  {collapsed ? '▸' : '▾'} {t(groupLabelKey)}
                </button>
              ) : (
                <span className={css.groupLabel}>{t(groupLabelKey)}</span>
              )}
              <Badge kind="info">{String(group.rows.length)}</Badge>
              {group.counted > 0 && (
                <span className={css.diffStatTotal}>
                  <span className={css.diffStatAdd}>+{group.added}</span>
                  {' '}
                  <span className={css.diffStatDel}>−{group.removed}</span>
                </span>
              )}
            </div>
            {!collapsed && (
              <ul className={css.restorePlanList}>
                {group.rows.map((row) => {
                  const open = openRows.includes(row.index)
                  const state = diffs[row.index]
                  // 宿主文本（描述与路径）先整体脱敏再渲染：先脱敏、后拼接，顺序不可反
                  const safeDescription = redact(row.description)
                  const safeTarget = row.target === undefined ? null : redact(row.target)
                  /** 行头（可展开行是 button，纯信息行是 div —— 不让屏幕阅读器把内容吞进 disabled 按钮） */
                  const head = (
                    <>
                      <span className={statusTagClass(row.status)}>{statusLabel(t, row.status)}</span>
                      <span className={css.restorePlanPath} title={safeTarget ?? ''}>
                        {safeTarget ?? safeDescription}
                      </span>
                      <RowStat t={t} row={row} />
                      {row.diffable && <span className={css.restorePlanChevron} aria-hidden="true">{open ? '▾' : '▸'}</span>}
                    </>
                  )
                  return (
                    <li key={`row-${String(row.index)}`}>
                      {row.diffable ? (
                        <button type="button" className={css.restorePlanRow} aria-expanded={open} onClick={() => { toggle(row) }}>
                          {head}
                        </button>
                      ) : (
                        <div className={css.restorePlanRowStatic}>{head}</div>
                      )}
                      {safeTarget !== null && (
                        <div className={css.restorePlanNote}>
                          {safeDescription}
                          {row.detail !== undefined && <span className={css.hint}>（{redact(row.detail)}）</span>}
                        </div>
                      )}
                      {open && state !== undefined && <DiffPane state={state} t={t} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
