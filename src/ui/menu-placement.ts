/**
 * 浮层（下拉菜单）的**纯放置模型** —— src/client/common/Select.tsx 只做量测与装配。
 *
 * 为什么要有它（2026-10-04 用户反馈「所有弹窗里的下拉都被裁掉一截」）：
 * 菜单的裁剪边界不是窗口，而是**宿主画布**（插件根容器 .section，它自带 overflow: hidden），
 * 触发器一旦靠近画布下缘 / 右缘，按「一律贴触发器左下」写坐标的菜单就必然被切。
 * 正确做法是量出尺寸后按可用空间决定：下方放不下且上方更宽裕 → 向上翻转；
 * 左右越界 → 先右对齐再夹进画布；空间不足 → 限高内滚（而不是溢出被裁）。
 *
 * 分层铁律：本文件零依赖（不 import react / 浏览器 API），client 与 node 单测都能用 ——
 * 浏览器那一侧只负责把 getBoundingClientRect 的结果喂进来（见 common/floating-bounds.ts）。
 */

/** 与触发器之间的间距（px）；与 .selectMenu 的视觉间距一致。 */
export const MENU_GAP = 4
/** 弹层最大高度（px）；与 CSS .selectMenu 的 `max-height` 对齐，两者必须同值。 */
export const MENU_MAX_HEIGHT = 220
/** 距夹紧矩形边缘的最小留白（px）；与 common/floating-bounds.ts 的 VIEWPORT_EDGE 同值（浮层贴边的统一气口）。 */
export const MENU_EDGE = 8
/**
 * 可读下限（px）：上下都挤不下时也**不把菜单压成一条缝** —— 约两行选项。
 * 此时宁可轻微越出夹紧矩形（fixed 元素只受视口裁剪，仍看得见），也不给用户一个点不中的控件。
 */
export const MENU_MIN_HEIGHT = 56

/** 视口坐标的矩形（DOMRect 的最小投影）。 */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 浮层尺寸。 */
export interface Size {
  width: number
  height: number
}

/** 放置结果：直接写进弹层的内联 top / left / max-height。 */
export interface MenuPlacement {
  top: number
  left: number
  /** 实际放置方向：'bottom' = 触发器下方；上下空间不足时向上翻转。 */
  side: 'top' | 'bottom'
  /** 高度上限（可用空间 < 天然高度时内滚，绝不溢出被裁）。 */
  maxHeight: number
}

/** 夹紧（max < min 时取 min —— 基准矩形比浮层还窄的退化情形仍返回可用值）。 */
function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min
  return value < min ? min : value > max ? max : value
}

/**
 * 计算弹层的最终位置（触发器下方优先、放不下向上翻转；水平左右夹紧；限高内滚）。
 *
 * 参数只要求**同一套坐标**（本函数只做减法与比较，不关心原点在哪）：
 * anchor = 触发器矩形，bounds = 夹紧矩形，menu = 菜单**量测后的**尺寸
 * （渲染后、绘制前量，见 Select 的 layout effect）。
 * 调用方给什么界就是什么界 —— 弹窗内的菜单传**视口**（菜单在卡片内绝对定位、卡片没有 overflow，
 * 越出卡片是正常浮层行为）；画布内的普通下拉传 common/floating-bounds.ts 的 canvasBounds()
 * （= 画布 ∩ 窗口；画布自带 overflow: hidden，必须夹紧才不会被裁）。
 * Select 把两者都换算成「容器相对坐标」后再写进 style。
 */
export function placeMenu(anchor: Rect, bounds: Rect, menu: Size): MenuPlacement {
  // 水平：与触发器左缘对齐；右侧放不下改右对齐；两端都夹进 bounds。
  const minLeft = bounds.left + MENU_EDGE
  const maxLeft = bounds.right - MENU_EDGE - menu.width
  let left = anchor.left
  if (left + menu.width > bounds.right - MENU_EDGE) left = anchor.right - menu.width
  left = clampNumber(left, minLeft, maxLeft)

  // 垂直：下方优先；下方放不下且上方更宽裕 → 向上翻转（与 Select 菜单同一判据）。
  const below = bounds.bottom - anchor.bottom - MENU_GAP - MENU_EDGE
  const above = anchor.top - bounds.top - MENU_GAP - MENU_EDGE
  const side: MenuPlacement['side'] = menu.height > below && above > below ? 'top' : 'bottom'
  const available = side === 'bottom' ? below : above
  const rawTop = side === 'bottom' ? anchor.bottom + MENU_GAP : anchor.top - MENU_GAP - menu.height
  const top = clampNumber(rawTop, bounds.top + MENU_EDGE, bounds.bottom - MENU_EDGE - menu.height)

  return {
    top,
    left,
    side,
    maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, available)),
  }
}
