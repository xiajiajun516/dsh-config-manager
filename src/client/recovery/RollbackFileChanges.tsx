/**
 * 回退预览的文件清单 —— **一份实现，两处调用**：
 *  · 聊天里用户消息旁的回退预览（`src/client/chat/RollbackReviewDialog.tsx`）；
 *  · 设置页「环境 → 工作区 + 会话回滚」回滚卡的预览弹窗（`src/client/recovery/RollbackCard.tsx`）。
 *
 * 为什么抽成一个文件（2026-10-12 用户要求「设置页的回退预览也要一眼看清被改动的文件」）：
 * 两处必须**逐字同版式** —— 图标 | 目录（弱化）+ 基名（主色）| 右对齐统计；删除行写「删除」；
 * 行数不可信写「行数未统计」。版式散在两处就会漂移，所以渲染只有这一份。
 * 数据面与判定面照旧各自只有一份：行数据来自 `readRollbackPreviewFiles` /
 * `readRollbackPreviewRemovals`（引擎 `preview.workspace` 的同一份数据），统计口径来自
 * `rollbackPreviewScope`（只累加两侧都可信的行数）。
 *
 * 诚实边界（不假装）：
 *  · **删除行不是按钮**：这类路径不在该回滚点的记录里，引擎的 file-diff 也读不出它 ⇒ 点了也没有
 *    差异可看。「点文件名看差异」只对**能看**的行成立（调用方给了 `view` 才把路径画成按钮）。
 *  · 行数可能是 `null`（超限 / 非文本 / 内容副本读不出）⇒ 那一格写「行数未统计」，**绝不写 0**：
 *    「0 行」是一个会被证伪的具体断言，而「不知道」不是。
 *  · 形状读不出（`status` 不在取值域）⇒ 不画语义色条（宁可不画，也不按猜测上色）。
 */
import type { TranslateNS } from '../client-types.ts'
import { rollbackPreviewFileLabel, splitRollbackPath } from '../../ui/rollback-view.ts'
import { RollbackFileIcon, type RollbackFileIconRenderer } from '../chat/RollbackFileIcon.tsx'
import {
  previewFileStatusKnown,
  rollbackPreviewFileKey,
  type ChatPreviewFileRow,
} from '../chat/rollback-entry-view.ts'
import css from '../config-manager.module.css'

type RKey = Parameters<TranslateNS<'config-manager-recovery'>>[0]
const rk = (key: string): RKey => key as RKey

/** 一个文件的「查看差异」入口（调用方给的已插值文案 + 点击回调）。 */
export interface RollbackFileViewEntry {
  /** 该行的无障碍名 / 悬停提示（把 {path} 插好的完整句）。 */
  hint: (path: string) => string
  /** 忙态或还没有可写目标时禁用 —— 入口仍占位（不消失）。 */
  disabled: boolean
  onView: (path: string) => void
}

export interface RollbackFileChangesProps {
  /** 会被**改动**的文件（`readRollbackPreviewFiles(preview.workspace)` 的产物）。 */
  files: readonly ChatPreviewFileRow[]
  /** 会被整文件**删除**的路径（`readRollbackPreviewRemovals(preview.workspace)` 的产物）。 */
  removals: readonly string[]
  /** recovery 字典翻译器（±行数 / 「删除」/「行数未统计」的词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** 逐行「查看差异」；不给 = 该表面没有差异通道（那时路径只是文字，不给假入口）。 */
  view?: RollbackFileViewEntry
  /** 文件类型图标的外部来源（装了 dsh-better-sidebar 时由装配点注入）。 */
  renderFileIcon?: RollbackFileIconRenderer
  /**
   * 路径级勾选（2026-10-17 定案 A）：**给了**才在每行前面画复选框。
   * 没给的表面（聊天预览）渲染与旧版**逐字一致** —— 这是刻意的向后兼容，不是遗漏。
   */
  selection?: RollbackFileSelection
}

/** 逐文件勾选的渲染参数（判定全在 src/ui/rollback-view.ts，这里只画） */
export interface RollbackFileSelection {
  /** 已勾选的路径 */
  selected: readonly string[]
  /** 其它对话在留点之后写过的路径（行上标一句；默认不勾） */
  foreign: readonly string[]
  /** 「其它对话改过」那一句（调用点传已翻译文本） */
  foreignLabel: string
  /** 勾选框的无障碍名 / 悬停提示（调用点把路径插好的整句） */
  toggleLabel: (path: string) => string
  disabled: boolean
  onToggle: (path: string) => void
}

/**
 * 一行文件统计：`+N` / `−M`；任一侧是 null ⇒ 「行数未统计」整句替换（绝不打 0）。
 * 两侧都可信时**两个数字都给**（新增与删除是两件事，用户两个都要看）。
 *
 * 例外：**整文件删除写「删除」**，不写 `+0 −N`。判据只看引擎给的 `status === 'delete'`
 * （取值域在 src/ui/rollback-view.ts，契约里已有），**绝不**从 `added === 0` 反推删除 ——
 * 一个文件被清空成 0 行同样是 `+0 −N`，那是另一件事。
 */
function FileStat({ status, added, removed, unknown, deleted, skipped, rt }: {
  status: string
  added: number | null
  removed: number | null
  unknown: string
  /** 「删除」这一句（调用点传已翻译文本，本组件不碰字典键）。 */
  deleted: string
  /** true = 这次回退**不会改动**它（冲突 / 无法安全合并）——与「0 行变化」是两件事 */
  skipped?: boolean
  rt: TranslateNS<'config-manager-recovery'>
}) {
  // 「不会改动」必须说在前面：行级统计对它是 null，落到下面的「行数未统计」会把用户引向
  // 「它还是会被写、只是没算出行数」的错误理解。
  if (skipped === true) return <span className={css.hint}>{rt(rk('rollback.preview.file.skipped'))}</span>
  if (status === 'delete') return <span className={css.rollbackDeleted}>{deleted}</span>
  if (added === null || removed === null) return <span className={css.hint}>{unknown}</span>
  return (
    <>
      <span className={css.rollbackAdded}>{rt(rk('rollback.preview.file.added'), { n: String(added) })}</span>
      <span className={css.rollbackRemoved}>{rt(rk('rollback.preview.file.removed'), { n: String(removed) })}</span>
    </>
  )
}

/** 文件清单（改动行 + 删除行）。两处调用共用这一份渲染。 */
export function RollbackFileChanges({ files, removals, rt, view, renderFileIcon, selection }: RollbackFileChangesProps) {
  // 勾选与归属都用集合查（清单可达几百条，逐条 includes 是 O(n²)）
  const selectedSet = selection === undefined ? null : new Set(selection.selected)
  const foreignSet = selection === undefined ? null : new Set(selection.foreign)
  return (
    <div className={css.rollbackFileList} role="list">
      {files.map((file, index) => {
        // 目录弱化 + 基名主色：只画基名时 `.git/index` 读不出「在哪」。
        const { dir, base } = splitRollbackPath(file.path)
        const label = (
          <>
            {dir !== '' && <span className={css.rollbackFileDir}>{dir}</span>}
            {base}
          </>
        )
        return (
          <div
            key={rollbackPreviewFileKey(file.path, file.added, file.removed, index)}
            className={css.rollbackFileRow}
            role="listitem"
            data-kind={previewFileStatusKnown(file.status) ? file.status : undefined}
          >
            {/* 路径级勾选（A）：只有调用点给了 selection 才画。用原生 input 而不是 Checkbox 原语 ——
                原语是「复选框**行**」（label 会渲染成可见文本），而这里的可访问名就是文件名本身。 */}
            {selection !== undefined && selectedSet !== null && (
              <input
                type="checkbox"
                checked={selectedSet.has(file.path)}
                disabled={selection.disabled}
                title={selection.toggleLabel(file.path)}
                aria-label={selection.toggleLabel(file.path)}
                onChange={() => { selection.onToggle(file.path) }}
              />
            )}
            {/* 文件类型图标（DSH 文件树同一颗）。装饰性：行内文件名就是它的可访问名。 */}
            <span className={css.rollbackFileIcon} aria-hidden="true">
              <RollbackFileIcon path={file.path} size={14} render={renderFileIcon} />
            </span>
            {/* 主标签 = 目录（弱化）+ 文件名（主色）。给了 `view` 时**它本身就是那颗按钮**
                （2026-10-12 用户要求：不要尾部的独立「查看」按钮，点文件名直接跳）。
                为什么按钮不是整行：整行做热区会把右侧 `+N −M` 也变成可点区域，鼠标停在统计上
                像是要点它；这里只有名字/目录可点，统计永远点不到。完整路径仍在 title 里。 */}
            {view === undefined ? (
              <span className={`${css.rollbackFilePath} ${css.mono}`} title={file.path}>{label}</span>
            ) : (
              <button
                type="button"
                className={`${css.rollbackFilePath} ${css.mono}`}
                title={file.path}
                aria-label={view.hint(file.path)}
                disabled={view.disabled}
                onClick={() => { view.onView(file.path) }}
              >
                {label}
              </button>
            )}
            {/* 归属提示（B）：这一行在留点之后是**别的对话**写的 —— 默认没勾它，勾上就会覆盖对方的改动。 */}
            {selection !== undefined && foreignSet !== null && foreignSet.has(file.path) && (
              <span className={css.hint} data-foreign="true">{selection.foreignLabel}</span>
            )}
            {/* ±行数紧跟文件名（统计列右对齐、列宽固定）：三种取值的右缘对齐成一条竖线。 */}
            <span className={css.rollbackFileStat}>
              <FileStat
                status={file.status}
                added={file.added}
                removed={file.removed}
                unknown={rt('rollback.preview.file.unknown')}
                deleted={rt(rk('rollback.preview.file.deleted'))}
                skipped={file.skipped === true}
                rt={rt}
              />
            </span>
          </div>
        )
      })}
      {removals.map((path, index) => {
        const { dir, base } = splitRollbackPath(path)
        return (
          <div
            key={'remove:' + rollbackPreviewFileKey(path, null, null, index)}
            className={css.rollbackFileRow}
            role="listitem"
            data-kind="delete"
          >
            <span className={css.rollbackFileIcon} aria-hidden="true">
              <RollbackFileIcon path={path} size={14} render={renderFileIcon} />
            </span>
            {/* 删除行**不是按钮**（纯文本）：见文件头「诚实边界」第 1 条。 */}
            <span className={`${css.rollbackFilePath} ${css.mono}`} title={path}>
              {dir !== '' && <span className={css.rollbackFileDir}>{dir}</span>}
              {base || rollbackPreviewFileLabel(path)}
            </span>
            <span className={css.rollbackFileStat}>
              <span className={css.rollbackDeleted}>{rt(rk('rollback.preview.file.deleted'))}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
