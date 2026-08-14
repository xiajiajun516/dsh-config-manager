/**
 * 进度条（规范 §29，绑 src/ui/progress.ts）。
 *
 * 控制器（ExportFlow / ImportWizard）在调用 core 前后发出 ProgressEvent，
 * 本组件按 stage 文案 + step/total 渲染进度条；未知阶段回退显示 id 本身。
 */
import { stageText } from '../../ui/progress.ts'
import type { ProgressEvent } from '../../ui/types.ts'
import css from '../config-manager.module.css'

export interface ProgressBarProps {
  /** 当前阶段事件（null = 未开始） */
  event: ProgressEvent | null
  /** 是否正在执行（false 时显示为完成态） */
  active: boolean
}

/**
 * 进度条：阶段文字 + 百分比（有 step/total 时计算，否则不定态动画）。
 */
export function ProgressBar({ event, active }: ProgressBarProps) {
  const percent =
    event !== null && event.step !== undefined && event.total !== undefined && event.total > 0
      ? Math.round((event.step / event.total) * 100)
      : null
  const label = event !== null ? stageText(event.stage) : ''

  return (
    <div className={css.progressBlock}>
      <div className={css.progressMeta}>
        <span className={css.progressLabel}>{label}</span>
        {event?.detail !== undefined && event.detail !== '' && (
          <span className={css.progressDetail}>{event.detail}</span>
        )}
        {percent !== null && <span className={css.progressPercent}>{percent}%</span>}
      </div>
      <div className={css.progressTrack}>
        {percent !== null ? (
          <div
            className={`${css.progressBar} ${active ? '' : css.progressBarDone}`}
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className={`${css.progressBar} ${css.progressIndeterminate}`} />
        )}
      </div>
    </div>
  )
}
