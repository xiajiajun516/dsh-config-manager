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
import { computeProgressView, progressBarMode } from './progress-view.ts'
import type { RunProgress } from './progress-view.ts'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface ProgressBarProps {
  /** 当前进度事件（null = 未开始）；普通 ProgressEvent 亦兼容 */
  event: RunProgress | null
  /** 是否正在执行（false 时显示为结束态；无百分比时**不再渲染无限动画**） */
  active: boolean
  /** 已结束且结论为失败：结束态不得渲染成「成功绿」（导出页不传，行为不变） */
  failed?: boolean
}

/**
 * 进度条：阶段文字 + 分区/内部计数徽章 + 当前项名 + 百分比。
 *
 * 轨道形态由 `progressBarMode`（纯函数，可单测）决定：有百分比 → 定长；
 * 无百分比且在跑 → 不定态动画；**无百分比且已结束 → 静止条**（这条是 bugfix：
 * 此前「已完成」的任务因为没有百分比也走不定态分支，动画永不停 → 看起来一直在加载）。
 */
export function ProgressBar({ event, active, failed }: ProgressBarProps) {
  const view = computeProgressView(event)
  const mode = progressBarMode(view, active)
  const fillClass = active
    ? css.progressBar
    : failed === true ? `${css.progressBar} ${css.progressBarFailed}` : `${css.progressBar} ${css.progressBarDone}`

  return (
    <div className={css.progressBlock}>
      {/* G-03：进度里的阶段文案 / 分区名 / 当前项名都是**宿主经 /progress 下发的文本**
          （当前来源是计划项 id 与常量消息，但规则统一：展示前一律 redact —— 不留例外，
          否则以后换了数据源就成了静默缺口）。 */}
      <div className={css.progressMeta}>
        <span className={css.progressLabel}>{redact(view.label)}</span>
        {view.sectionBadge !== null && (
          <span className={`${css.progressBadge} ${css.progressBadgeSection}`}>
            {redact(view.sectionBadge.label)} · {view.sectionBadge.current}/{view.sectionBadge.total}
          </span>
        )}
        {view.countBadge !== null && (
          <span className={`${css.progressBadge} ${css.progressBadgeCount}`}>
            {view.countBadge.label !== '' ? `${redact(view.countBadge.label)} · ` : ''}
            {view.countBadge.current}/{view.countBadge.total}
          </span>
        )}
        {view.detail !== null && <span className={css.progressDetail}>{redact(view.detail)}</span>}
        {view.percent !== null && <span className={css.progressPercent}>{view.percent}%</span>}
      </div>
      <div className={css.progressTrack}>
        {mode === 'indeterminate' ? (
          <div className={`${css.progressBar} ${css.progressIndeterminate}`} />
        ) : (
          // settled（已结束但宿主没上报过计数）：画一条**满格的静止条**，语义交给状态徽章；
          // 绝不画成 0% 空条 —— 那读起来像「还没开始」，而这些都是已经结束的任务。
          <div className={fillClass} style={{ width: `${mode === 'settled' ? 100 : view.percent}%` }} />
        )}
      </div>
    </div>
  )
}
