/**
 * fishbone — 鱼骨加载动画的几何契约（纯数据 + 纯函数，组件与测试共用）。
 *
 * 为什么值得单测：形状由**数值**决定（对称、长度递增、延迟递增、留在 24×24 的 viewBox 内），
 * 改一个 dy 就可能让肋骨戳出画布被裁掉、或让「从尾向头依次点亮」的相位反过来 —— 这些
 * 在 13px 的按钮里肉眼很难发现，但会让动画读不出「骨架在游动」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FISHBONE_EYE,
  FISHBONE_RIBS,
  FISHBONE_SKULL,
  FISHBONE_SPINE,
  FISHBONE_TAIL,
  fishboneRibPath,
  fishboneSkullPath,
  fishboneTailPaths,
} from './fishbone.ts'

/** 动画周期：肋骨 delay 必须落在周期内，否则后半程永远轮不到它亮。 */
const CYCLE_MS = 1050
const VIEW = 24

/** 把 'M8 12 L5.6 14.6' 解析成坐标对。 */
function points(d: string): Array<[number, number]> {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  assert.equal(nums.length % 2, 0, '路径坐标必须是成对的数字: ' + d)
  const out: Array<[number, number]> = []
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i] as number, nums[i + 1] as number])
  return out
}

test('鱼骨：四根肋骨，x / 长度 / 延迟都从尾向头单调递增', () => {
  assert.equal(FISHBONE_RIBS.length, 4)
  for (let i = 1; i < FISHBONE_RIBS.length; i++) {
    const prev = FISHBONE_RIBS[i - 1] as { x: number; dy: number; delay: number }
    const cur = FISHBONE_RIBS[i] as { x: number; dy: number; delay: number }
    assert.ok(cur.x > prev.x, '肋骨 x 必须递增（尾 → 头）')
    assert.ok(cur.dy > prev.dy, '靠近头部的肋骨必须更长')
    assert.ok(cur.delay > prev.delay, '动画延迟必须递增（尾先亮、头后亮）')
  }
})

test('鱼骨：延迟落在动画周期内（每根都轮得到亮）', () => {
  for (const rib of FISHBONE_RIBS) {
    assert.ok(rib.delay >= 0 && rib.delay < CYCLE_MS, '肋骨延迟越界: ' + rib.delay)
  }
})

test('鱼骨：每根肋骨上下严格对称（关于脊柱线镜像）', () => {
  for (const rib of FISHBONE_RIBS) {
    const up = points(fishboneRibPath(rib, 1))
    const down = points(fishboneRibPath(rib, -1))
    const upStart = up[0] as [number, number]
    const downStart = down[0] as [number, number]
    const upEnd = up[1] as [number, number]
    const downEnd = down[1] as [number, number]
    assert.deepEqual(upStart, [rib.x, FISHBONE_SPINE.y], '肋骨必须从脊柱出发')
    assert.deepEqual(downStart, upStart)
    assert.equal(upEnd[0], downEnd[0], '上下端点的水平偏移必须一致')
    assert.equal(upEnd[1] + downEnd[1], FISHBONE_SPINE.y * 2, '上下端点必须关于脊柱线镜像')
  }
})

test('鱼骨：所有几何点留在 24×24 的 viewBox 内（不被裁切）', () => {
  const all: Array<[number, number]> = [
    [FISHBONE_SPINE.x1, FISHBONE_SPINE.y],
    [FISHBONE_SPINE.x2, FISHBONE_SPINE.y],
    [FISHBONE_SKULL.cx - FISHBONE_SKULL.r, FISHBONE_SKULL.cy - FISHBONE_SKULL.r],
    [FISHBONE_SKULL.cx + FISHBONE_SKULL.r, FISHBONE_SKULL.cy + FISHBONE_SKULL.r],
    [FISHBONE_EYE.cx, FISHBONE_EYE.cy],
  ]
  for (const rib of FISHBONE_RIBS) {
    all.push(...points(fishboneRibPath(rib, 1)), ...points(fishboneRibPath(rib, -1)))
  }
  for (const d of fishboneTailPaths()) all.push(...points(d))
  for (const [x, y] of all) {
    assert.ok(x >= 0 && x <= VIEW, 'x 越界: ' + x)
    assert.ok(y >= 0 && y <= VIEW, 'y 越界: ' + y)
  }
})

test('鱼骨：尾鳍两根，关于脊柱线对称且朝尾后张开', () => {
  const tails = fishboneTailPaths()
  assert.equal(tails.length, 2, '尾鳍必须是上下两根')
  const up = points(tails[0] as string)
  const down = points(tails[1] as string)
  const upStart = up[0] as [number, number]
  const downStart = down[0] as [number, number]
  const upEnd = up[1] as [number, number]
  const downEnd = down[1] as [number, number]
  assert.deepEqual(upStart, [FISHBONE_SPINE.x1, FISHBONE_SPINE.y], '尾鳍必须从脊柱尾端出发')
  assert.deepEqual(downStart, upStart)
  assert.equal(upEnd[0], downEnd[0], '上下尾鳍的水平端必须一致')
  assert.equal(upEnd[1] + downEnd[1], FISHBONE_SPINE.y * 2, '上下尾鳍必须镜像')
  assert.ok(upEnd[0] < FISHBONE_SPINE.x1, '尾鳍必须向后（左）张开')
  assert.equal(upEnd[0], FISHBONE_SPINE.x1 + FISHBONE_TAIL.dx)
  assert.equal(upEnd[1], FISHBONE_SPINE.y + FISHBONE_TAIL.dy)
})

test('鱼骨：头骨是闭合圆环，眼点落在颅骨内，脊柱与头骨相接', () => {
  const d = fishboneSkullPath()
  assert.ok(d.startsWith('M'), '头骨路径必须以 M 起笔: ' + d)
  const pts = points(d)
  assert.ok(pts.length >= 3, '头骨至少需要起笔 + 两段弧的落点')
  const r = FISHBONE_SKULL.r
  assert.ok(r > 0)
  const dist = Math.hypot(FISHBONE_EYE.cx - FISHBONE_SKULL.cx, FISHBONE_EYE.cy - FISHBONE_SKULL.cy)
  assert.ok(dist + FISHBONE_EYE.r <= r, '眼点必须整体落在颅骨圆环内')
  assert.ok(FISHBONE_SPINE.x2 >= FISHBONE_SKULL.cx - r, '脊柱必须连到头骨内缘（不许断开）')
  assert.ok(FISHBONE_SPINE.x2 <= FISHBONE_SKULL.cx, '脊柱不得越过头骨中心')
})
