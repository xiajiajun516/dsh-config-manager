/**
 * Skeleton —— 加载骨架原语（Workbench Design System）。
 *
 * 定位：**整块内容的首次加载**占位（列表 / 表格 / 详情）。与 Spinner 的分工是硬的：
 *   - 骨架 = 已经有布局轮廓、数据还没到 —— 给出「这里会出现什么」的预判，数据到货时不整页跳动；
 *   - Spinner = 没有轮廓可给的进行中态（按钮内联、遮罩覆盖、轮询中的小区域），转圈才是对的反馈。
 * 因此按钮里的 `Button loading` 与 `.pickerOverlay` 保持 Spinner，**不要**改成骨架。
 *
 * 无障碍：视觉块统一 aria-hidden，加载语义由外框的 `role="status"` + `aria-busy` +
 * `aria-label` 承担 —— **骨架不渲染任何加载文案**（2026-11-04 用户要求「骨架屏只保留骨架」：
 * 色块下面那行「加载中…」在数据到达时消失、又与 Spinner 的措辞重复；读屏仍有 status 名）。
 *
 * 动画：shimmer 与递进延迟见 config-manager.module.css §3；
 * `prefers-reduced-motion: reduce` 下退化为静态占位块（§15）。
 */
import type { ReactNode } from 'react'
import css from '../config-manager.module.css'

/** 骨架形态：区块标题 / 正文行 / 区块 / 行条目。 */
export type SkeletonShape = 'title' | 'line' | 'block' | 'row'

/** 形态 → CSS 类。CSS Modules 的类名是静态属性，不能运行时拼字符串。 */
const SHAPE_CLASS: Record<SkeletonShape, string> = {
  title: css.skeletonTitle ?? '',
  line: css.skeletonLine ?? '',
  block: css.skeletonBlock ?? '',
  row: css.skeletonRow ?? '',
}

/** [0, count) 的稳定键序列（骨架块没有业务标识，用序号做 key）。 */
function indices(count: number): number[] {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * 骨架外框：加载语义（role=status + aria-busy + aria-label）挂在这里，视觉块由调用方 aria-hidden。
 * `label` 只做无障碍名（读屏播报），**不渲染成可见文案**。
 */
function SkeletonRoot({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={className !== undefined ? css.skeletonRoot + ' ' + className : css.skeletonRoot}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </div>
  )
}

export interface SkeletonProps {
  /** 形态（默认 `line` 正文行） */
  shape?: SkeletonShape
  /** 重复条数（默认 1） */
  count?: number
  /** 读屏文案（已翻译）：只做 `aria-label`，**不渲染**成可见文案 */
  label?: string
  /** 额外类（尺寸微调等；常规布局仍走 CSS 类） */
  className?: string
}

/** 基础骨架块：按形态重复 count 次。 */
export function Skeleton({ shape = 'line', count = 1, label, className }: SkeletonProps) {
  return (
    <SkeletonRoot label={label} className={className}>
      <div className={css.skeletonBars} aria-hidden="true">
        {indices(count).map((key) => (
          <div key={key} className={css.skeletonBar + ' ' + SHAPE_CLASS[shape]} />
        ))}
      </div>
    </SkeletonRoot>
  )
}

export interface SkeletonListProps {
  /** 条目数（默认 3） */
  count?: number
  /** 读屏文案（已翻译）：只做 `aria-label`，不渲染成可见文本 */
  label?: string
}

/**
 * 条目列表骨架：每个条目 = 标题 + 两行说明，表面与 `.card` 同款
 * （备份快照 / 档案 / 市场条目 / 运行卡片 / 备份文件这类卡片列表复用同一个）。
 */
export function SkeletonList({ count = 3, label }: SkeletonListProps) {
  return (
    <SkeletonRoot label={label}>
      <div className={css.skeletonCards} aria-hidden="true">
        {indices(count).map((key) => (
          <div key={key} className={css.skeletonCard}>
            <div className={css.skeletonBar + ' ' + css.skeletonTitle} />
            <div className={css.skeletonBar + ' ' + css.skeletonLine} />
            <div className={css.skeletonBar + ' ' + css.skeletonLine} />
          </div>
        ))}
      </div>
    </SkeletonRoot>
  )
}

export interface SkeletonTableProps {
  /** 行数（默认 5） */
  rows?: number
  /** 读屏文案（已翻译）：只做 `aria-label`，不渲染成可见文本 */
  label?: string
}

/**
 * 数据表骨架：三列（名称 / 说明 / 时间，宽度由 CSS 分配），
 * 用于「活动记录」「同步历史」这类表格视图的首次加载。
 */
export function SkeletonTable({ rows = 5, label }: SkeletonTableProps) {
  return (
    <SkeletonRoot label={label}>
      <div className={css.skeletonTable} aria-hidden="true">
        {indices(rows).map((key) => (
          <div key={key} className={css.skeletonTableRow}>
            <span className={css.skeletonBar + ' ' + css.skeletonTableCell} />
            <span className={css.skeletonBar + ' ' + css.skeletonTableCell} />
            <span className={css.skeletonBar + ' ' + css.skeletonTableCell} />
          </div>
        ))}
      </div>
    </SkeletonRoot>
  )
}

export interface SkeletonRowsProps {
  /** 行数（默认 6） */
  count?: number
  /** 读屏文案（已翻译）：只做 `aria-label`，不渲染成可见文本 */
  label?: string
}

export interface SkeletonActivityRowsProps {
  /** 行数（默认 5，与首页一次展示的条数一致） */
  count?: number
  /** 读屏文案（已翻译）：**只做无障碍名**，本组件不渲染任何可见文案 */
  label?: string
}

/**
 * 「最近活动」表骨架：**逐列照抄真实表的几何**（2026-11-04 用户要求「占位条宽高与真实内容
 * 一致、原位替换、布局不跳」）。
 *
 * 为什么不复用 `SkeletonRows`：那个形态是「20px 图标 + 两行文字 + 动作位」的 52px 行，而
 * 最近活动真实态是 4 列日志表（时间 72px / 事件 96px / 弹性详情列 / 结果列，行高 38.5px，
 * 上面还有一行静态列头）。两套几何并存 ⇒ 数据到达时高度、列位、滚动条槽一起跳。
 *
 * 两点刻意偏离 `SkeletonRoot`：
 * ① 外框不带 `.skeletonRoot`（flex column + gap 8 + margin-top 8）—— 骨架行必须与真实行
 *    同处一个滚动容器、行与行之间没有额外间距，否则几何又对不上；
 * ② 不渲染任何可见文案（与其余骨架同一口径）：加载语义由 `role="status"` + `aria-busy`
 *    与 `aria-label` 承担，读屏不丢信息。
 */
export function SkeletonActivityRows({ count = 5, label }: SkeletonActivityRowsProps) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {indices(count).map((key) => (
        <div key={key} className={css.activitySkeletonRow} aria-hidden="true">
          <span className={css.skeletonBar + ' ' + css.activitySkeletonTime} />
          <span className={css.skeletonBar + ' ' + css.activitySkeletonKind} />
          <span className={css.skeletonBar + ' ' + css.activitySkeletonSummary} />
          <span className={css.skeletonBar + ' ' + css.activitySkeletonResult} />
        </div>
      ))}
    </div>
  )
}

/**
 * 紧凑行骨架：行高与 `.artifactRowHead` 对齐（52px = 20px 图标位 + 标题/说明两行 + 8/10 内边距），
 * 右侧留一个动作位 —— 用于「产物库」「最近活动」这类**一行一条、有分割线**的列表。
 * 为什么单列一种形态：卡片骨架套在这种列表上会把行距撑大（每卡 12px 内边距），
 * 数据到货时整块往下跳；行的形状只能靠行骨架给。
 */
export function SkeletonRows({ count = 6, label }: SkeletonRowsProps) {
  return (
    <SkeletonRoot label={label}>
      <div className={css.skeletonRows} aria-hidden="true">
        {indices(count).map((key) => (
          <div key={key} className={css.skeletonRowItem}>
            <span className={css.skeletonBar + ' ' + css.skeletonRowIcon} />
            <span className={css.skeletonRowBody}>
              <span className={css.skeletonBar + ' ' + css.skeletonRowTitle} />
              <span className={css.skeletonBar + ' ' + css.skeletonRowMeta} />
            </span>
            <span className={css.skeletonBar + ' ' + css.skeletonRowAction} />
          </div>
        ))}
      </div>
    </SkeletonRoot>
  )
}
