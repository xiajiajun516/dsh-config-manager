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
  onClick?: () => void
  children: ReactNode
  title?: string
  className?: string
}

/** 统一按钮（primary=主操作 / ghost=次操作 / danger=危险操作） */
export function Button({ variant = 'ghost', disabled, onClick, children, title, className }: ButtonProps) {
  const cls =
    variant === 'primary' ? css.primaryButton
      : variant === 'danger' ? css.dangerButton
        : css.ghostButton
  return (
    <button
      type="button"
      className={className !== undefined ? `${cls} ${className}` : cls}
      disabled={disabled}
      title={title}
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
}

/** 状态徽章（info=业务色 / ok=成功 / warn=警告 / error=错误） */
export function Badge({ kind = 'info', children }: BadgeProps) {
  return <span className={`${css.badge} ${css[`badge${kind[0]!.toUpperCase()}${kind.slice(1)}`] ?? ''}`}>{children}</span>
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
