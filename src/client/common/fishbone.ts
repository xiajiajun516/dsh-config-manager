/**
 * 鱼骨加载动画的几何（纯数据 + 纯函数；不 import React，也不碰 DOM）——
 * 组件 `Spinner` 与 node 单测共用同一份定义，改形状只改这里。
 *
 * 形状：一条**脊柱**（水平主线）+ 四对**肋骨**（从脊柱向上下张开、朝尾部倾斜，
 * 越靠近头部越长）+**尾鳍**（尾部两根短线）+**头骨**（右端圆环与眼点）。
 * 之所以是鱼骨而不是圆环：用户 2026-10-21 要求「统一所有页面的加载动画替换成鱼骨架」，
 * 骨架形状本身就表达「内容正在被搭起来」，也顺带解决了 2026-09 那条真机反馈
 * （13px 的圆环栅格化后只剩一条亮弧、形状读不出来）。
 *
 * 动画由 CSS 承担（config-manager.module.css §3）：脊柱走 `stroke-dashoffset`
 * 让骨节持续向头部游动，肋骨按 `delay` 从尾向头依次亮起，两处相位一致。
 */
export interface FishboneRib {
  /** 肋骨根部在脊柱上的 x 坐标 */
  x: number
  /** 肋骨向外张开时的水平偏移（负向 = 朝尾部倾斜） */
  dx: number
  /** 肋骨半长（脊柱到端点），越靠近头部越长 */
  dy: number
  /** 动画延迟（ms）：从尾向头依次点亮 */
  delay: number
}

/** 脊柱：从尾柄（x1）一直连到头骨内缘（x2），y 居中。末端落在颅骨圆环内缘上，
 *  不再向圆环中心探 —— 探进去会让 14px 下的头骨看起来像被一根线穿爆。 */
export const FISHBONE_SPINE = { x1: 4.4, x2: 17.9, y: 12 } as const

/** 四对肋骨（尾 → 头），长度与动画延迟都单调递增。 */
export const FISHBONE_RIBS: readonly FishboneRib[] = [
  { x: 7.2, dx: 1.7, dy: 3.6, delay: 0 },
  { x: 10.6, dx: 1.7, dy: 5.0, delay: 80 },
  { x: 14.0, dx: 1.7, dy: 6.3, delay: 160 },
  { x: 17.0, dx: 1.7, dy: 7.4, delay: 240 },
]

/** 头骨：右端圆环（无肉的颅骨轮廓）+ 眼点。 */
export const FISHBONE_SKULL = { cx: 20.2, cy: 12, r: 2.5 } as const
export const FISHBONE_EYE = { cx: 20.9, cy: 11.2, r: 0.75 } as const

/** 尾鳍：从尾柄向上下各张开一根短线（张开得足够大，14px 下才读得出「尾巴」）。 */
export const FISHBONE_TAIL = { dx: -3.2, dy: 3.2 } as const

/** 肋骨路径：`side` = 1 指向上、-1 指向下（两端关于脊柱对称）。 */
export function fishboneRibPath(rib: FishboneRib, side: 1 | -1): string {
  return 'M' + rib.x + ' ' + FISHBONE_SPINE.y + ' L' + (rib.x - rib.dx) + ' ' + (FISHBONE_SPINE.y + side * rib.dy)
}

/** 尾鳍路径（两根，向上/向下）。 */
export function fishboneTailPaths(): string[] {
  const x = FISHBONE_SPINE.x1
  const y = FISHBONE_SPINE.y
  return [1, -1].map((side) => 'M' + x + ' ' + y + ' L' + (x + FISHBONE_TAIL.dx) + ' ' + (y + side * FISHBONE_TAIL.dy))
}

/** 头骨圆环路径（两段弧，避免描边被 viewBox 裁切时形状走样）。 */
export function fishboneSkullPath(): string {
  const { cx, cy, r } = FISHBONE_SKULL
  return 'M' + cx + ' ' + (cy - r) + ' a' + r + ' ' + r + ' 0 1 1 0 ' + r * 2 + ' a' + r + ' ' + r + ' 0 1 1 0 ' + -r * 2
}
