/**
 * Config Manager 基础 UI 原语（dsh-ssh 风格，全部走 DSH Design System 的 --dsw-* token，
 * 不另造视觉体系）。仅作薄封装：类名来自 config-manager.module.css，无业务逻辑。
 */
import type { ChangeEvent, ReactNode } from 'react'
import css from '../config-manager.module.css'

/* ---------------- Button ---------------- */

export type ButtonVariant = 'primary' | 'ghost' | 'danger'

export interface ButtonProps {
  variant?: ButtonVariant
  disabled?: boolean
  /** 进行中态：自动 disabled + aria-busy（children 由调用方渲染 Spinner 保持现状） */
  loading?: boolean
  onClick?: () => void
  children: ReactNode
  title?: string
  className?: string
  /** 外链 URL：存在时渲染 <a>（新窗口 + noreferrer，防 tabnabbing），否则渲染 <button> */
  href?: string
  /** 是否新窗口打开（仅 href 存在时生效；默认 true） */
  newTab?: boolean
}

/**
 * 统一按钮（primary=主操作 / ghost=次操作 / danger=危险操作）。
 * 带 href 时渲染同款按钮类的外链 <a>（target=_blank + rel=noreferrer），
 * 外观与普通按钮一致，不破坏既有 <button> 调用。
 * loading=true 时自动禁用（防重复点击）并标注 aria-busy（无障碍）；
 * 视觉 loading（Spinner）由调用方按既有模式放在 children 中。
 */
export function Button({ variant = 'ghost', disabled, loading = false, onClick, children, title, className, href, newTab = true }: ButtonProps) {
  const cls =
    variant === 'primary' ? css.primaryButton
      : variant === 'danger' ? css.dangerButton
        : css.ghostButton
  const effectiveDisabled = disabled === true || loading
  if (href !== undefined) {
    return (
      <a
        className={className !== undefined ? `${cls} ${className}` : cls}
        href={href}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noreferrer' : undefined}
        title={title}
        aria-busy={loading || undefined}
        onClick={onClick}
        // 按钮类无 text-decoration 规则，<a> 默认下划线破坏按钮外观（SyncSettingsView 外链同款极小修补）
        style={{ textDecoration: 'none' }}
      >
        {children}
      </a>
    )
  }
  return (
    <button
      type="button"
      className={className !== undefined ? `${cls} ${className}` : cls}
      disabled={effectiveDisabled}
      title={title}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* ---------------- Badge ---------------- */

export type BadgeKind = 'info' | 'ok' | 'warn' | 'error'

export interface BadgeProps {
  kind?: BadgeKind
  children: ReactNode
  /** 悬停提示（可选；如 star 徽章的「仓库级 star」说明） */
  title?: string
}

/** 状态徽章（info=业务色 / ok=成功 / warn=警告 / error=错误） */
export function Badge({ kind = 'info', children, title }: BadgeProps) {
  return <span className={`${css.badge} ${css[`badge${kind[0]!.toUpperCase()}${kind.slice(1)}`] ?? ''}`} title={title}>{children}</span>
}

/* ---------------- Banner ---------------- */

export type BannerKind = 'ok' | 'error' | 'info' | 'warn'

export interface BannerProps {
  kind?: BannerKind
  children: ReactNode
}

/** 说明横幅（ok/error/info/warn 四态） */
export function Banner({ kind = 'info', children }: BannerProps) {
  return <div className={css.banner} data-kind={kind}>{children}</div>
}

/* ---------------- Card ---------------- */

export interface CardProps {
  children: ReactNode
  className?: string
}

/** 卡片容器（bg-layer-2 + 圆角 + 细边框） */
export function Card({ children, className }: CardProps) {
  return <div className={className !== undefined ? `${css.card} ${className}` : css.card}>{children}</div>
}

/* ---------------- Spinner ---------------- */

export interface SpinnerProps {
  label?: string
}

/** 加载指示（旋转环 + 可选文案） */
export function Spinner({ label }: SpinnerProps) {
  return (
    <span className={css.spinnerWrap}>
      <span className={css.spinner} aria-hidden="true" />
      {label !== undefined && <span className={css.spinnerLabel}>{label}</span>}
    </span>
  )
}

/* ---------------- Field ---------------- */

export interface FieldProps {
  label: string
  hint?: string
  children: ReactNode
}

/** 表单字段（标签 + 控件 + 说明） */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {hint !== undefined && <span className={css.hint}>{hint}</span>}
    </label>
  )
}

/* ---------------- SectionTitle ---------------- */

export interface SectionTitleProps {
  title: string
  subtitle?: string
}

/** 区块标题（页面内二级标题 + 可选副标题） */
export function SectionTitle({ title, subtitle }: SectionTitleProps) {
  return (
    <div className={css.sectionTitleBlock}>
      <h3 className={css.sectionTitle}>{title}</h3>
      {subtitle !== undefined && <p className={css.sectionSubtitle}>{subtitle}</p>}
    </div>
  )
}

/* ---------------- Empty / Loading ---------------- */

export interface EmptyProps {
  children: ReactNode
}

/** 空状态占位 */
export function Empty({ children }: EmptyProps) {
  return <div className={css.empty}>{children}</div>
}

/* ---------------- Checkbox ---------------- */

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
}

/** 复选框行（勾选 + 标签） */
export function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
  return (
    <label className={css.checkboxRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange(event.target.checked) }}
      />
      <span>{label}</span>
    </label>
  )
}
