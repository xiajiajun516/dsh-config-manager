/**
 * 顶部页签条的溢出可发现性（UI-19）。
 *
 * 背景：`.navStrip` 是 `overflow-x: auto` 但**滚动条被隐藏**（`scrollbar-width: none`）的
 * 分段条。中文界面（单/双字页签）放得下，英文界面（Overview / Backups / Export / Import /
 * Sync / Market / Profiles + 右侧两个文字动作按钮）在 564px 画布下会溢出 —— 此时没有任何
 * 提示，用户看不出「右边还有页签」。本模块把「是否需要提示、提示哪一侧」变成纯函数，
 * 由壳层（ConfigManagerSection）在滚动/尺寸变化时重算，并把结果写进
 * `data-overflow="none|start|end|both"`，由 CSS 在对应一侧画渐隐遮罩。
 *
 * 为什么不用 `::after` 覆盖层：覆盖层若落在滚动容器内，会随内容一起滚走；
 * `mask-image` 作用在元素自身的绘制盒上，滚动后依然贴在边缘。
 */

/** 页签条的度量输入（取 DOM 上的 scrollLeft / scrollWidth / clientWidth）。 */
export interface NavOverflowMetrics {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export interface NavOverflowState {
  /** 内容宽于容器（滚动条虽隐藏，但确实还有内容在视口外） */
  overflowing: boolean
  /** 左端还有被卷起来的内容 */
  atStart: boolean
  /** 右端还有被卷起来的内容 */
  atEnd: boolean
}

/** 像素级容差：亚像素布局（缩放/字体度量）不应被当成"还能滚 0.4px"。 */
export const NAV_OVERFLOW_EPSILON = 1

/** 计算页签条溢出状态（纯函数，node 可测）。 */
export function navOverflowState(
  metrics: NavOverflowMetrics,
  epsilon: number = NAV_OVERFLOW_EPSILON,
): NavOverflowState {
  const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  const overflowing = maxScroll > epsilon
  const left = Math.max(0, Math.min(metrics.scrollLeft, maxScroll))
  return {
    overflowing,
    atStart: left <= epsilon,
    atEnd: maxScroll - left <= epsilon,
  }
}

/**
 * 溢出状态 → `data-overflow` 取值（CSS 选择器直接可用的单一出口）。
 * 不溢出 = `none`（不画任何遮罩，避免给放得下的界面凭添渐隐）。 */
export function navOverflowAttr(state: NavOverflowState): 'none' | 'start' | 'end' | 'both' {
  if (!state.overflowing) return 'none'
  if (state.atStart && state.atEnd) return 'none'
  if (state.atStart) return 'end'
  if (state.atEnd) return 'start'
  return 'both'
}
