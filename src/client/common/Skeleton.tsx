/**
 * Skeleton —— 加载骨架原语（Workbench Design System）。
 *
 * 定位：**整块内容的首次加载**占位（列表 / 表格 / 详情）。与 Spinner 的分工是硬的：
 *   - 骨架 = 已经有布局轮廓、数据还没到 —— 给出「这里会出现什么」的预判，数据到货时不整页跳动；
 *   - Spinner = 没有轮廓可给的进行中态（按钮内联、遮罩覆盖、轮询中的小区域），转圈才是对的反馈。
 * 因此按钮里的 `Button loading` 与 `.pickerOverlay` 保持 Spinner，**不要**改成骨架。
 *
 * 无障碍：视觉块统一 aria-hidden，加载语义由外框的 `role="status"` + `aria-busy` +
 * **可见文案**（caption，与 Spinner 的 label 同义）承担 —— 只给色块不留文案，读屏用户
 * 与「看不出这是加载态」的用户都拿不到信息（此前的 Spinner 都带 label，骨架不能把这条丢掉）。
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
 * 骨架外框：加载语义（role=status + aria-busy）挂在这里，视觉块由调用方 aria-hidden。
 */
function SkeletonRoot({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={className !== undefined ? css.skeletonRoot + ' ' + className : css.skeletonRoot}
      role="status"
      aria-busy="true"
    >
      {children}
      {label !== undefined && <span className={css.skeletonCaption}>{label}</span>}
    </div>
  )
}

export interface SkeletonProps {
  /** 形态（默认 `line` 正文行） */
  shape?: SkeletonShape
  /** 重复条数（默认 1） */
  count?: number
  /** 可见文案（已翻译），同时是读屏文案 */
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
  /** 可见文案（已翻译） */
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
  /** 可见文案（已翻译） */
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
  /** 可见文案（已翻译） */
  label?: string
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
