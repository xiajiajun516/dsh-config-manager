/**
 * 单文件前后对照面板 —— DSH 右侧栏标签页与预览弹窗的降级内嵌**共用同一个**渲染。
 *
 * 数据面只有一种形状（`RollbackFileDiffResult`）：界面按「能不能逐行对照」分派四态
 * （结构原因 / 一致 / 有差异 / 读失败），**不猜、不撒谎**：
 *  · `reason` 有值 ⇒ 说「看不了」并给原因（绝不显示成「没有差异」）；
 *  · `identical` ⇒ 才说「一致」。
 * 安全：单元格正文是磁盘原文 ⇒ 展示前必过 redact()（由 DiffTable 的 sanitize 承接）。
 */
import type { TranslateNS } from '../client-types.ts'
import type { RollbackFileDiffResult } from '../../ui/rollback-view.ts'
import { rollbackFileDiffComparable, rollbackFileDiffReasonKey } from '../../ui/rollback-view.ts'
import { redact } from '../../security/redaction.ts'
import { Banner, Spinner } from '../common/ui.tsx'
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
}

export function RollbackDiffPane({ state, rt }: RollbackDiffPaneProps) {
  if (state.status === 'loading') return <Spinner label={rt('rollback.diff.loading')} />
  if (state.status === 'error') return <Banner kind="error">{state.message === null ? rt('rollback.diff.failed') : redact(state.message)}</Banner>
  const diff = state.diff
  if (diff.ok !== true) {
    // 宿主结构化拒绝（未命中记录 / 存储栈不可用 …）：给可读文案 + 真实 code（不裸渲染机器码，但也不藏）
    const code = diff.code === undefined || diff.code === '' ? '' : ' — ' + diff.code
    return <Banner kind="error">{rt('rollback.diff.failed') + code}</Banner>
  }
  if (!rollbackFileDiffComparable(diff)) {
    const key = rollbackFileDiffReasonKey(diff.reason)
    return <div className={css.hint}>{key === null ? rt('rollback.diff.reason.unknown') : rt(rk(key))}</div>
  }
  if (diff.identical) return <div className={css.hint}>{rt('rollback.diff.identical')}</div>
  return (
    <div className={css.diffPane}>
      {diff.degraded && <div className={css.hint}>{rt('rollback.diff.degraded')}</div>}
      <DiffTable
        hunks={diff.hunks}
        beforeLabel={rt('rollback.diff.before')}
        afterLabel={rt('rollback.diff.after')}
        truncatedNotice={(shown, total) => rt('rollback.diff.truncated', { shown: String(shown), total: String(total) })}
        sanitize={redact}
      />
    </div>
  )
}
