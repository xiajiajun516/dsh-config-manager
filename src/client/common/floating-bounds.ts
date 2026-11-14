/**
 * 浮层夹紧基准（UI v2）—— Select 菜单与其它自绘浮层**共用这一份实现**。
 *
 * 为什么必须有它：本插件的弹层（气泡 / 下拉 / 菜单）**都要 portal 进插件根容器**
 * `#dsh-config-manager-root`（见 Modal.tsx 的 MODAL_ROOT_ID 说明 —— 挂 body 会被宿主
 * overlay z-index:1000 遮成「隐形弹层」）。而该容器位于 `.dialogContentCenter` 之内，
 * 后者带**常驻** `transform: translate(-50%,-50%)`：按 CSS Transforms L1，它成为后代
 * `position: fixed` 的**包含块**，于是「视口坐标」写进 top/left 会被整体再平移一次
 * （实测两种表现：浮层跑到屏幕最右边 / 被整体平移出画布）。
 *
 * 结论：**位置一律用画布相对坐标**，而画布边界就是这个函数给的矩形。
 * 拿不到容器（未挂载 / 尺寸为 0 / 画布几乎整体在视口外）时回落到窗口矩形（兜底）；
 * 画布矩形恒与窗口取交集，画布被宿主弹窗部分移出视口时也不会画到浏览器视口外。
 */
import { resolveModalRoot } from './Modal.tsx'

/** 距边缘的最小留白（px）：浮层贴边时仍留一点气口。 */
export const VIEWPORT_EDGE = 8

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return value < min ? min : value > max ? max : value
}

/** 夹紧基准 = 宿主画布（插件根容器）的可见矩形，不是浏览器视口。 */
export function canvasBounds(): Bounds {
  const win: Bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const root = resolveModalRoot()
  if (root === null) return win
  const rect = root.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return win
  const bounded: Bounds = {
    left: Math.max(rect.left, win.left),
    top: Math.max(rect.top, win.top),
    right: Math.min(rect.right, win.right),
    bottom: Math.min(rect.bottom, win.bottom),
  }
  // 交集退化（画布几乎整体在视口外）→ 退回窗口，保证仍有可夹紧的区间
  if (bounded.right - bounded.left < 2 * VIEWPORT_EDGE || bounded.bottom - bounded.top < 2 * VIEWPORT_EDGE) return win
  return bounded
}
