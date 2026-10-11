/**
 * 双栏差异表（共享渲染原语）——「快照恢复计划」与「回滚点 · 查看」共用同一副骨架。
 *
 * 为什么是共享原语（AGENTS.md Reuse Before Creating）：两处要画的是**同一件事**
 * （hunks → 左右对照：左 = before / 当前，右 = after / 目标），差别只在列头与截断文案；
 * 复制第二份渲染代码必然从视觉与截断口径开始漂移。
 *
 * 分工：行对对齐 / 块头 / 行号列宽全部来自 `src/ui/diff-view.ts`（纯函数、node 单测）；本组件只画。
 * 安全：单元格文本是磁盘 / 宿主原文 ⇒ 展示前**必须**过调用方传进来的 sanitize（本该是 redact）。
 */
import { Fragment } from 'react'
import { countSideRows, maxLineDigits, toSideBySide, type SideBySideRow } from '../../ui/diff-view.ts'
import type { DiffHunk } from '../../utils/line-diff.ts'
import css from '../config-manager.module.css'

/** 单文件最多渲染多少行对：diff 上限 6000 行，全量渲染会卡住弹窗（数据完整，只是没画出来）。 */
export const DIFF_ROW_CAP = 400

export interface DiffTableProps {
  hunks: readonly DiffHunk[]
  /** 左侧列头（before = 当前） */
  beforeLabel: string
  /** 右侧列头（after = 目标 / 快照） */
  afterLabel: string
  /** 被渲染上限截断时的说明文案（由调用方按自己的字典出话；缺省 = 不提示） */
  truncatedNotice?: (shown: number, total: number) => string
  /** 单元格文本安全化（**应当**传 redact；缺省原样只为类型完整，不用于用户可见正文） */
  sanitize?: (text: string) => string
  /** 渲染上限（缺省 DIFF_ROW_CAP） */
  rowCap?: number
}

/** 左侧单元格：成对修改 / 纯删除 → 红底；上下文 → 中性。 */
function leftCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'del' ? css.diffCell + ' ' + css.diffCellDel : css.diffCell ?? ''
}

/** 右侧单元格：成对修改 / 纯新增 → 绿底；上下文 → 中性。 */
function rightCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'add' ? css.diffCell + ' ' + css.diffCellAdd : css.diffCell ?? ''
}

/** 左右双栏逐行对照（表头 + 块头 + 行号 + 单元格）。 */
export function DiffTable({ hunks, beforeLabel, afterLabel, truncatedNotice, sanitize, rowCap = DIFF_ROW_CAP }: DiffTableProps) {
  const cell = sanitize ?? ((text: string): string => text)
  const groups = toSideBySide(hunks)
  const total = countSideRows(groups)
  // 行号列宽 = 实际出现的最大行号位数（1–3/4/5/6+ 位四档 ch），内容列平分剩余空间
  const digits = maxLineDigits(hunks)
  const noColClass = digits <= 3 ? css.diffNoColW3 : digits === 4 ? css.diffNoColW4 : digits === 5 ? css.diffNoColW5 : css.diffNoColW6
  let rendered = 0
  const capped = total > rowCap
  const notice = capped && truncatedNotice !== undefined ? truncatedNotice(rowCap, total) : null
  return (
    <>
      {notice !== null && <div className={css.hint}>{notice}</div>}
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
              <th className={css.diffNoHead} colSpan={2}>{beforeLabel}</th>
              <th className={css.diffNoHead} colSpan={2}>{afterLabel}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const rows = capped ? group.rows.slice(0, Math.max(0, rowCap - rendered)) : group.rows
              rendered += rows.length
              return (
                <Fragment key={group.header}>
                  <tr className={css.diffHunkRow}>
                    <td colSpan={4}>{group.header}</td>
                  </tr>
                  {rows.map((row, index) => (
                    <tr key={group.header + '-' + String(index)}>
                      <td className={css.diffNo}>{row.left?.oldNo ?? ''}</td>
                      <td className={leftCellClass(row.kind)}>{row.left === null ? '' : cell(row.left.text)}</td>
                      <td className={css.diffNo}>{row.right?.newNo ?? ''}</td>
                      <td className={rightCellClass(row.kind)}>{row.right === null ? '' : cell(row.right.text)}</td>
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
