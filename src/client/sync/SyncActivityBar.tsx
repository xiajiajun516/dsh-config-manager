/**
 * 一键同步的在途活动条（阶段文案 + 不定态进度）。
 *
 * 单独成文件的理由：主文件有行数棘轮（t42），而这 8 行是**纯展示**——没有状态、没有调用，
 * 抽出去既守住棘轮，也让「在途反馈」这件事只有一个实现。
 *
 * 为什么按钮上的 Spinner 不够：一键同步最慢的一步是拉远端快照做只读合并预览，
 * Spinner 只在按钮内部、且按钮在卡片右侧；整卡可见的活动条才能让用户确认「点了、在动」。
 * 不定态进度是**状态**而非装饰：prefers-reduced-motion 下仍保留（DESIGN §5）。
 */
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

export interface SyncActivityBarProps {
  /** 'preview' = 正在拉远端快照做合并预览（最慢）；'sync' = 正在导入/同步。 */
  phase: 'preview' | 'sync'
  t: TranslateNS<'config-manager-sync'>
}

export function SyncActivityBar({ phase, t }: SyncActivityBarProps) {
  return (
    <div className={css.syncActivity} role="status" aria-live="polite">
      <span className={`${css.progressTrack} ${css.syncActivityTrack}`}>
        <span className={`${css.progressBar} ${css.progressIndeterminate}`} />
      </span>
      <span className={css.syncActivityLabel}>
        {phase === 'preview' ? t('syncflow.checkingRemote') : t('syncflow.syncing')}
      </span>
    </div>
  )
}
