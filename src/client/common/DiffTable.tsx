/**
 * 双栏差异表（共享渲染原语）——「快照恢复计划」与「回滚点 · 查看」共用同一副骨架。
 *
 * 为什么是共享原语（AGENTS.md Reuse Before Creating）：两处要画的是**同一件事**
 * （hunks → 左右对照：左 = before / 当前，右 = after / 目标），差别只在列头、文件头与截断文案；
 * 复制第二份渲染代码必然从视觉与截断口径开始漂移。
 *
 * 观感（2026-10-14 按用户参考图改成编辑器式双栏）：
 *  · **可选文件头**（`.diffFileHead`）= 路径 + `+A` / `−R`：只在调用方**没在别处写过路径**时传 title；
 *  · **每一栏各自一块头**（`@@ -a,b +c,d @@`，两栏同一段文本，与单文件 diff 编辑器的观感一致）；
 *  · **行号栏按语义着色**（删侧红 / 增侧绿）并带一条 3px 实心色条（`.diffNoDel` / `.diffNoAdd` 的内阴影），
 *    色条落在**该栏自己的左缘**（左栏 = 整表左缘，右栏 = 两栏分界处）；
 *  · 内容栏只在增删行上着色（`.diffCellAdd` / `.diffCellDel`，12% 混色），上下文行不上色；
 *  · 两栏之间一条竖分割线（块头与正文都要有）。
 *
 * 规模：**全部画出来，不截断**（2026-10-15 用户：「为什么最多只能加载 400 行？我需要能完整的加载」）。
 * 到这里的 hunks 已经是宿主给的**全部**内容（单文件字节上限在宿主侧：回滚预览 1 MiB、恢复计划 maxSideBytes），
 * 渲染层再砍一刀只会让同一份数据在界面上少半截，而用户没有任何办法看到剩下的
 *（2026-10-14 起那道「最多 400 行对」的上限已删除，连文案一起去掉）。
 *
 * 分工：行对对齐 / 块头 / 行号列宽 / 行数统计全来自 `src/ui/diff-view.ts`（纯函数、node 单测）；本组件只画。
 * 安全：单元格文本是磁盘 / 宿主原文 ⇒ 展示前**必须**过调用方传进来的 sanitize（本该是 redact）。
 */
import { Fragment } from 'react'
import { redact } from '../../security/redaction.ts'
import { diffLineCounts, maxLineDigits, toSideBySide, type SideBySideRow } from '../../ui/diff-view.ts'
import type { DiffHunk } from '../../utils/line-diff.ts'
import css from '../config-manager.module.css'

export interface DiffTableProps {
  hunks: readonly DiffHunk[]
  /** 左侧列头（before = 当前） */
  beforeLabel: string
  /** 右侧列头（after = 目标 / 快照） */
  afterLabel: string
  /**
   * 文件头（可选）：给了就在差异上方画一行「路径 + +A/−R」。
   * 调用方**已在别处写过这份路径**（恢复计划行、聊天预览的路径行）时**不要传** —— 同一路径不画两遍。
   */
  title?: string
  /** 单元格文本安全化（**缺省就是 redact**：调用方只能换成别的脱敏器，换不成不脱敏） */
  sanitize?: (text: string) => string
}

/** 左侧单元格：成对修改 / 纯删除 → 红底；上下文 → 中性。 */
function leftCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'del' ? css.diffCell + ' ' + css.diffCellDel : css.diffCell ?? ''
}

/** 右侧单元格：成对修改 / 纯新增 → 绿底；上下文 → 中性。 */
function rightCellClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'add' ? css.diffCell + ' ' + css.diffCellAdd : css.diffCell ?? ''
}

/** 左行号：成对修改 / 纯删除 → 红号 + 红条（色条在左行号栏的左缘 = 该行左缘）。 */
function leftNoClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'del' ? css.diffNo + ' ' + css.diffNoDel : css.diffNo ?? ''
}

/** 右行号：成对修改 / 纯新增 → 绿号 + 绿条（色条在右行号栏的左缘 = 两栏分界处）。 */
function rightNoClass(kind: SideBySideRow['kind']): string {
  return kind === 'change' || kind === 'add' ? css.diffNo + ' ' + css.diffNoAdd : css.diffNo ?? ''
}

/** 左右双栏逐行对照（文件头 + 表头 + 块头 + 行号 + 单元格）。 */
export function DiffTable({ hunks, beforeLabel, afterLabel, title, sanitize }: DiffTableProps) {
  const cell = sanitize ?? ((text: string): string => redact(text))
  const groups = toSideBySide(hunks)
  const counts = diffLineCounts(hunks)
  // 行号列宽 = 实际出现的最大行号位数（1–3/4/5/6+ 位四档 ch），内容列平分剩余空间
  const digits = maxLineDigits(hunks)
  const noColClass = digits <= 3 ? css.diffNoColW3 : digits === 4 ? css.diffNoColW4 : digits === 5 ? css.diffNoColW5 : css.diffNoColW6
  return (
    <>
      {title !== undefined && (
        <div className={css.diffFileHead}>
          <span className={css.diffFilePath + ' ' + css.mono} title={title}>{title}</span>
          <span className={css.diffFileStat}>
            <span className={css.diffStatAdd}>+{counts.added}</span>
            {' '}
            <span className={css.diffStatDel}>−{counts.removed}</span>
          </span>
        </div>
      )}
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
            {groups.map((group) => (
              <Fragment key={group.header}>
                  {/* 块头：两栏各一格、同一段文本（编辑器式单文件 diff 的观感），中间那条竖线由 CSS 补 */}
                  <tr className={css.diffHunkRow}>
                    <td colSpan={2}>{group.header}</td>
                    <td colSpan={2}>{group.header}</td>
                  </tr>
                  {group.rows.map((row, index) => (
                    <tr key={group.header + '-' + String(index)}>
                      <td className={leftNoClass(row.kind)}>{row.left?.oldNo ?? ''}</td>
                      <td className={leftCellClass(row.kind)}>{row.left === null ? '' : cell(row.left.text)}</td>
                      <td className={rightNoClass(row.kind)}>{row.right?.newNo ?? ''}</td>
                      <td className={rightCellClass(row.kind)}>{row.right === null ? '' : cell(row.right.text)}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
