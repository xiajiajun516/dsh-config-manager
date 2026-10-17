/**
 * 宿主共享原语（ui-primitives）的**帧内惰取门 —— 全仓唯一出口**。
 *
 * 为什么是「惰取 + try/catch」而不是顶层 import（真机教训 + 第三方实证）：
 *  · `@deepseek-ai/dsh-client-ui-primitives` 由 DSH shell 的模块表作为 static module seed 预置，
 *    插件 bundle 的 `require` 能直接命中（第三方插件 dsh-better-sidebar / dsh-agent-teams /
 *    dsh-mnemon / dsh-reedit 全都这么做；本仓的 RollbackFileIcon 自 2026-10-12 起也这么做）；
 *  · 但**老宿主**没有那份模块表 —— 那一刻 `require` 抛错。顶层 `import` 会被打包器改写成
 *    模块体顶层的 `require`，抛错会让**整个浏览器半加载失败**（设置页一起没）。
 *    所以：只在**真要画 / 真要投影的那一刻**取，拿不到就回落本地实现。
 *
 * 该包因此不进 bundle：源码里只有 `require` 调用，白名单登记在 `src/utils/bundle-scan.ts`。
 *
 * 当前消费面（三样，全部「拿不到就回落本地实现」）：
 *  ① `FileTypeIcon` —— 文件类型图标；② `projectUserText` —— 用户正文投影；
 *  ③ `Tag` —— 只读状态标签（2026-10-17 对齐原生：四态徽章直接吃原生调色板）。
 * 三态缓存：undefined = 还没试过；null = 试过了，这台宿主没有；对象 = 拿到了。
 */
import type { ComponentType, ReactNode } from 'react'

/** `FileTypeIcon` 我们真的用到的入参面（只声明消费的字段，不复制第三方类型）。 */
export interface DshFileTypeIconProps {
  /** 文件路径（按扩展名/文件名分类；路径越完整越准）。 */
  path: string
  /** 边长（px）。 */
  size?: number
  /** 追加类名（宿主组件自己的类名照旧生效）。 */
  className?: string
}

/**
 * 宿主 `projectUserText` 的入参面（与 ui-primitives 逐字同形，只声明我们传的那几个）：
 * 会话线格式与斜杠名在正文里渲染成 chip；`references` 给了打开器才可点开。
 */
export type DshUserTextProjector = (
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[],
  slashKind: string,
  references?: { openFile?: unknown; openSkill?: unknown },
) => ReactNode

/**
 * 宿主 `Tag` 的入参面（只声明我们传的字段）：tone 选调色板，children 是已翻译文案。
 * 与 ui-primitives 的 Tag.d.ts 逐字同形；className 也透传（我们一般不用）。
 */
export interface DshTagProps {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  className?: string
  children?: ReactNode
}

/**
 * 宿主图标组件的入参面（只声明我们传的字段）：
 * ui-primitives 的图标都是 `(props) => svg` 的普通组件，`size` 缺省 16、`strokeWidth` 由
 * Artwork 决定（`…OutlineRegular` = 1px 描边），颜色走 `currentColor`。
 */
export interface DshIconProps {
  /** 边长（px；宿主缺省 16）。 */
  size?: number
  /** 追加类名（宿主组件自己的类名照旧生效）。 */
  className?: string
  /** 描边宽度（我们一般不动，留给宿主 Artwork 的档位）。 */
  strokeWidth?: number
}

/**
 * 我们真的用到的宿主图标 —— **闭集**：名字逐字对齐 ui-primitives 的导出，
 * 只列这三个（复制 / 已复制 / 回退），别把整张 328 个图标的表搬进来。
 */
export type DshIconName = 'IconCopyOutlineRegular' | 'IconCheckOutlineRegular' | 'IconRefreshOutlineRegular'

/** 宿主原语包里我们消费的那几个导出（其余一律不碰）。 */
interface HostPrimitivesFace {
  FileTypeIcon?: unknown
  projectUserText?: unknown
  Tag?: unknown
  /** 图标（闭集，见 {@link DshIconName}）。 */
  IconCopyOutlineRegular?: unknown
  IconCheckOutlineRegular?: unknown
  IconRefreshOutlineRegular?: unknown
}

let cached: HostPrimitivesFace | null | undefined

/** 取一次宿主原语包（**每个进程只试一次**，失败记 null 不再重试）。 */
function hostPrimitives(): HostPrimitivesFace | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    const loaded = (typeof require === 'function' ? require('@deepseek-ai/dsh-client-ui-primitives') : null) as
      | HostPrimitivesFace
      | null
    if (loaded !== null && typeof loaded === 'object') cached = loaded
  } catch {
    cached = null
  }
  return cached
}

/** DSH 自带的文件类型图标（拿不到回 null，调用方回落自己的画法）。 */
export function hostFileTypeIcon(): ComponentType<DshFileTypeIconProps> | null {
  const icon = hostPrimitives()?.FileTypeIcon
  if (typeof icon === 'function' || typeof icon === 'object') return icon as ComponentType<DshFileTypeIconProps>
  return null
}

/**
 * DSH 自带的只读标签（徽章）：与宿主同一颗组件、同一套调色板，拿不到回 null
 * （调用方回落本仓库的 `.badge[data-kind]` 样式）。
 */
export function hostTag(): ComponentType<DshTagProps> | null {
  const tag = hostPrimitives()?.Tag
  if (typeof tag === 'function' || typeof tag === 'object') return tag as ComponentType<DshTagProps>
  return null
}

/**
 * DSH 自带的图标组件（按导出名取；拿不到回 null ⇒ 调用方回落本仓库的图标）。
 *
 * 为什么按名字取而不是顶层 import：与 FileTypeIcon / projectUserText 同一条纪律（老宿主没有
 * 这份模块表，顶层 import 会把整个浏览器半打挂）；**为什么要用宿主图标**（2026-10-17 用户要求）：
 * 复制按钮在 DSH 里是 `IconCopyOutlineRegular → IconCheckOutlineRegular` 的**瞬时切换**（无形变动画），
 * 回退用 `IconRefreshOutlineRegular` —— 与动作行同框时字形、描边、视觉重量才与原生一致。
 */
export function hostIcon(name: DshIconName): ComponentType<DshIconProps> | null {
  const icon = hostPrimitives()?.[name]
  if (typeof icon === 'function' || typeof icon === 'object') return icon as ComponentType<DshIconProps>
  return null
}

/** DSH 自带的用户正文投影（把会话引用/斜杠名渲染成 chip；拿不到回 null）。 */
export function hostUserTextProjector(): DshUserTextProjector | null {
  const project = hostPrimitives()?.projectUserText
  return typeof project === 'function' ? (project as DshUserTextProjector) : null
}

/** 诊断 / 单测用：清掉缓存（生产路径不需要 —— 缓存就是为了「只试一次」）。 */
export function resetHostPrimitivesCache(): void {
  cached = undefined
}
