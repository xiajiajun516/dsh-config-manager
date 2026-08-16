/**
 * 进度条（规范 §29 + m3 真实进度）。
 *
 * 数据流：
 *  - 控制器（ExportFlow / ImportWizard）onProgress 发出普通 ProgressEvent
 *    （阶段文案 + step/total），走兼容路径；
 *  - m3：store 经 /runs + /progress 轮询得到的 RunState 映射为 RunProgress
 *    （额外携带 section/sectionTotal/item/itemTotal/detail），渲染为
 *    「分区徽章（settings · 3/12）+ 内部计数徽章（plugins · 6/18）+ 当前项名」。
 *
 * 所有换算逻辑在 progress-view.ts 的 computeProgressView()（纯函数，可单测）；
 * 本组件只做渲染。未知阶段回退显示 id 本身。
 */
import { computeProgressView } from './progress-view.ts'
import type { RunProgress } from './progress-view.ts'
import css from '../config-manager.module.css'

export interface ProgressBarProps {
  /** 当前进度事件（null = 未开始）；普通 ProgressEvent 亦兼容 */
  event: RunProgress | null
  /** 是否正在执行（false 时显示为完成态） */
  active: boolean
}

/**
 * 进度条：阶段文字 + 分区/内部计数徽章 + 当前项名 + 百分比。
 */
export function ProgressBar({ event, active }: ProgressBarProps) {
  const view = computeProgressView(event)

  return (
    <div className={css.progressBlock}>
      <div className={css.progressMeta}>
        <span className={css.progressLabel}>{view.label}</span>
        {view.sectionBadge !== null && (
          <span className={`${css.progressBadge} ${css.progressBadgeSection}`}>
            {view.sectionBadge.label} · {view.sectionBadge.current}/{view.sectionBadge.total}
          </span>
        )}
        {view.countBadge !== null && (
          <span className={`${css.progressBadge} ${css.progressBadgeCount}`}>
            {view.countBadge.label !== '' ? `${view.countBadge.label} · ` : ''}
            {view.countBadge.current}/{view.countBadge.total}
          </span>
        )}
        {view.detail !== null && <span className={css.progressDetail}>{view.detail}</span>}
        {view.percent !== null && <span className={css.progressPercent}>{view.percent}%</span>}
      </div>
      <div className={css.progressTrack}>
        {view.percent !== null ? (
          <div
            className={`${css.progressBar} ${active ? '' : css.progressBarDone}`}
            style={{ width: `${view.percent}%` }}
          />
        ) : (
          <div className={`${css.progressBar} ${css.progressIndeterminate}`} />
        )}
      </div>
    </div>
  )
}
