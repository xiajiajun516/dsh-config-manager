/**
 * 文件类型图标 —— 「DSH 侧边栏怎么画，就怎么画」（用户 2026-10-12 第 7 条）。
 *
 * 两级来源，优先级从高到低：
 *  ① **dsh-better-sidebar**（装了才用）：它把文件图标注册表作为 cordis 服务 `betterSidebar` 发布
 *     （`ctx.betterSidebar.fileIcon(path, size)`；v0.19.0 起还有 `registerFileIcon` / `fileIcons`），
 *     并且它自己的缺省档**就是** DSH 的 `FileTypeIcon` 画法 —— 装了它就等于同时拿到用户的扩展图标。
 *     装配点在 src/client/index.ts 的 `fileIconFor`（惰取 + bind，形态不符返回 null）；
 *  ② **DSH 自带**：`@deepseek-ai/dsh-client-ui-primitives` 的 `FileTypeIcon` —— 这正是 DSH 左侧文件树
 *     （`dsh-client-ui-sidebar-files` 的 FilesBody）逐字使用的那颗组件（同一份按类型着色的画集）。
 *
 * ## 为什么这里是「惰取 + try/catch」而不是顶层 import（**关键**）
 * 该包由 DSH shell 的模块表作为 **static module seed** 预置（`dsh-web-frontend` 的 `staticModules`
 * 里就有它），插件 bundle 的 `require` 能直接命中 —— 第三方插件 dsh-better-sidebar 走的就是这条路。
 * 但那是**较新宿主**才有的模块表：老宿主加载本插件时 `require` 会抛（missed the module table）。
 * 顶层 `import` 会被打包器改写成**模块体顶层**的 `require`，那一刻抛错会让**整个浏览器半加载失败**
 * （设置页一起没）—— 为了「一颗图标」赔掉整插件，绝不。所以这里：
 *  · 只在**真要画 icon 时**才 require（帧内），
 *  · 拿不到 / 形态不符 / 抛错一律回落一颗**极简的本地 SVG 文件图标**（`fallbackFileGlyph`），
 *    既不打挂任何东西，也不空着。
 * 该包因此不进 bundle：源码里只有 `require` 调用（bundle 白名单在 src/utils/bundle-scan.ts 登记）。
 */
import type { ComponentType, ReactNode } from 'react'
import { Icon } from '../common/Icon.tsx'

/** 装配点注入的「外部图标来源」（dsh-better-sidebar 的 `fileIcon`）；返回 null = 它不认这一条。 */
export type RollbackFileIconRenderer = (path: string) => ReactNode | null

/** `FileTypeIcon` 我们真的用到的入参面（只声明消费的字段，不复制第三方类型）。 */
interface DshFileTypeIconProps {
  path: string
  size?: number
  className?: string
}

/** 惰取结果的三态缓存（undefined = 还没试过；null = 试过了，这台宿主没有）。 */
let cachedDshFileTypeIcon: ComponentType<DshFileTypeIconProps> | null | undefined

/**
 * 惰取 DSH 自带的 `FileTypeIcon`（**每次进程只试一次**，失败就记 null 不再重试）。
 *
 * 为什么不用 `import()`：动态 import 在 cjs 产物里同样要走模块表，且会把整个包拖进 chunk；
 * 这里的 `require` 是 DSH loader 交给插件工厂的那一个（banner 里 `factory: (require) => {...}`）。
 */
function dshFileTypeIcon(): ComponentType<DshFileTypeIconProps> | null {
  if (cachedDshFileTypeIcon !== undefined) return cachedDshFileTypeIcon
  cachedDshFileTypeIcon = null
  try {
    const loaded = (typeof require === 'function' ? require('@deepseek-ai/dsh-client-ui-primitives') : null) as
      | { FileTypeIcon?: unknown }
      | null
    const icon = loaded?.FileTypeIcon
    if (typeof icon === 'function' || typeof icon === 'object') {
      cachedDshFileTypeIcon = icon as ComponentType<DshFileTypeIconProps>
    }
  } catch {
    cachedDshFileTypeIcon = null
  }
  return cachedDshFileTypeIcon
}

/**
 * 最后的兜底：共享图标原语的通用「文件」图标（`common/Icon.tsx` 的 `name="file"`）。
 * 只有「没有 better-sidebar + 宿主模块表里没有 ui-primitives」两条同时成立时才会出现 ——
 * 那时宁可用一颗通用文件图标，也不空着、更不打挂这一行。
 * 走共享原语而不是就地写 `<svg>`：DESIGN.md §「图标」把 `common/Icon.tsx` 定为唯一出口。
 */
function fallbackFileGlyph(size: number): ReactNode {
  return <Icon name="file" size={size} />
}

export interface RollbackFileIconProps {
  /** 文件绝对路径（图标按扩展名/文件名分类；路径越完整越准）。 */
  path: string
  /** 边长（px）；缺省 14 = DSH 文件树行内图标尺寸。 */
  size?: number
  /** 外部来源（可选）：返回 null / 抛错都回落 DSH 自带画法。 */
  render?: RollbackFileIconRenderer
}

/** 一颗装饰性文件类型图标（可访问名由调用方负责：行内文件名的文字就是它的名字）。 */
export function RollbackFileIcon({ path, size = 14, render }: RollbackFileIconProps) {
  if (render !== undefined) {
    let node: ReactNode | null = null
    try {
      node = render(path)
    } catch {
      node = null
    }
    // null / undefined / false = 这一条外部来源接不住 ⇒ 回落 DSH 自带画法（不猜、不空着）
    if (node !== null && node !== undefined && node !== false) return <>{node}</>
  }
  const Dsh = dshFileTypeIcon()
  if (Dsh !== null) return <Dsh path={path} size={size} />
  return fallbackFileGlyph(size)
}
