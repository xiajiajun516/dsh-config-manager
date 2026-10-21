/**
 * 单文件前后对照面板 —— DSH 右侧栏标签页与预览弹窗的降级内嵌**共用同一个**渲染。
 *
 * 数据面只有一种形状（`RollbackFileDiffResult`）：界面按「能不能逐行对照」分派四态
 * （结构原因 / 一致 / 有差异 / 读失败），**不猜、不撒谎**：
 *  · `reason` 有值 ⇒ 说「看不了」并给原因（绝不显示成「没有差异」）；
 *  · `identical` ⇒ 才说「一致」。
 * 安全：单元格正文是磁盘原文 ⇒ 展示前必过 redact()（由 DiffTable 的 sanitize 承接）。
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackFileDiffResult } from '../../ui/rollback-view.ts'
import { rollbackFileDiffComparable, rollbackFileDiffReasonKey } from '../../ui/rollback-view.ts'
import { redact } from '../../security/redaction.ts'
import { Banner } from '../common/ui.tsx'
import { SkeletonTable } from '../common/Skeleton.tsx'
import { DiffTable } from '../common/DiffTable.tsx'
import css from '../config-manager.module.css'

type RKey = Parameters<TranslateNS<'config-manager-recovery'>>[0]
const rk = (key: string): RKey => key as RKey

/** 面板状态（加载 / 就绪 / 读失败）。 */
export type RollbackDiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: RollbackFileDiffResult }
  | { status: 'error'; message: string | null }

export interface RollbackDiffPaneProps {
  state: RollbackDiffState
  rt: TranslateNS<'config-manager-recovery'>
  /**
   * 文件头（可选）= 该文件路径：给了就在差异上方画一行「路径 + +A/−R」（编辑器式）。
   * 调用方**已在别处写过这份路径**（聊天预览/设置页的就地展示原本各画一行）时**不要传** —— 同一路径不画两遍。
   */
  title?: string
  /**
   * 撑满宿主给的高度（**只有侧栏标签页该给**）：正文是那一屏的唯一内容时，
   * 表格自己吃掉剩余高度、滚动只发生在表格里；弹窗 / 计划列表里的就地差异不给（那些容器有别的约束）。
   */
  fill?: boolean
}

export function RollbackDiffPane({ state, rt, title, fill }: RollbackDiffPaneProps) {
  /**
   * 撑满档（只给侧栏标签页）下**每一个状态都套同一个整块容器**：只让「就绪且有差异」撑满时，
   * 加载 / 一致 / 看不了 / 读失败会突然缩成一行 —— 那同样是「预览高度不跟侧栏走」，
   * 而且一屏高度在四种状态间来回跳。非撑满（弹窗内的降级通道）保持原样：不留白、不加外边距。
   */
  const shell = (body: ReactNode): ReactNode =>
    fill === true ? <div className={css.diffPane + ' ' + css.diffPaneFill}>{body}</div> : body
  if (state.status === 'loading') return shell(<SkeletonTable rows={8} label={rt('rollback.diff.loading')} />)
  if (state.status === 'error') return shell(<Banner kind="error">{state.message === null ? rt('rollback.diff.failed') : redact(state.message)}</Banner>)
  const diff = state.diff
  if (diff.ok !== true) {
    // 宿主结构化拒绝（未命中记录 / 存储栈不可用 …）：给可读文案 + 真实 code（不裸渲染机器码，但也不藏）
    const code = diff.code === undefined || diff.code === '' ? '' : ' — ' + diff.code
    return shell(<Banner kind="error">{rt('rollback.diff.failed') + code}</Banner>)
  }
  if (!rollbackFileDiffComparable(diff)) {
    const key = rollbackFileDiffReasonKey(diff.reason)
    return shell(<div className={css.hint}>{key === null ? rt('rollback.diff.reason.unknown') : rt(rk(key))}</div>)
  }
  // 「不会改动」与「一致」是两件事：前者说明**这次回退有意不动它**（冲突 / 无法安全合并），
  // 后者只是「两侧碰巧一样」。有原因时先说原因，别让用户以为「碰巧一样」。
  if (diff.mergeSkipped === true) return shell(<div className={css.hint}>{rt(rk('rollback.diff.skipped'))}</div>)
  if (diff.identical) return shell(<div className={css.hint}>{rt('rollback.diff.identical')}</div>)
  return (
    <div className={fill === true ? css.diffPane + ' ' + css.diffPaneFill : css.diffPane}>
      {/* 「回退后」这一侧到底是什么，必须说清（引擎的 merged 标记证明它）：合并结果不是记录里的原文 */}
      {diff.merged === true && <div className={css.hint}>{rt(rk('rollback.diff.merged'))}</div>}
      {diff.degraded && <div className={css.hint}>{rt('rollback.diff.degraded')}</div>}
      <DiffTable
        hunks={diff.hunks}
        title={title}
        beforeLabel={rt('rollback.diff.before')}
        afterLabel={rt('rollback.diff.after')}
        sanitize={redact}
      />
    </div>
  )
}
