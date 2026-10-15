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
 * ## 惰取门在 `common/host-primitives.ts`（2026-10-15 抽出）
 * 那颗「帧内惰取 + try/catch + 三态缓存」的门改为全仓唯一出口（同一份门现在也供聊天气泡的
 * 正文投影使用）——本文件只保留**两级回落**：外部来源（better-sidebar）→ 宿主 FileTypeIcon
 * → 本地极简 SVG。为什么不能顶层 import、为什么必须帧内取，见那个文件的头注释。
 */
import type { ReactNode } from 'react'
import { Icon } from '../common/Icon.tsx'
import { hostFileTypeIcon } from '../common/host-primitives.ts'

/** 装配点注入的「外部图标来源」（dsh-better-sidebar 的 `fileIcon`）；返回 null = 它不认这一条。 */
export type RollbackFileIconRenderer = (path: string) => ReactNode | null

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
  const Dsh = hostFileTypeIcon()
  if (Dsh !== null) return <Dsh path={path} size={size} />
  return fallbackFileGlyph(size)
}
