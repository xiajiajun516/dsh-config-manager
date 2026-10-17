/**
 * Config Manager 基础 UI 原语 —— Workbench Design System（2026-09 Full UI Rebuild）。
 * 全部走 DSH Design System 的 --dsw-* token，不另造视觉体系；类名来自
 * config-manager.module.css，无业务逻辑。
 *
 * 本文件是重建后的原语层：在既有 API（Button/Badge/Banner/Card/Spinner/Field/
 * SectionTitle/Empty/Checkbox/Stepper）完全兼容的前提下，新增：
 *   - Button size（'sm' 密集场景）
 *   - IconButton（导航/工具栏图标动作）
 *   - StatusDot（状态栏/行内状态点）
 *   - Segmented（页内子视图分段切换）
 */
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import { ExpandChevron } from './Icon.tsx'
import { badgeTone, type BadgeKind } from '../../ui/badge-tone.ts'
import { hostTag } from './host-primitives.ts'
import css from '../config-manager.module.css'

/* ---------------- Button ---------------- */

export type ButtonVariant = 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps {
  variant?: ButtonVariant
  /** 尺寸：sm = 表格行内/密集工具栏（24px）；md = 常规（28px，缺省） */
  size?: ButtonSize
  disabled?: boolean
  /** 进行中态：自动 disabled + aria-busy + **自动前置加载图标**（children 只给普通文案） */
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
 * 带 href 时渲染同款按钮类的外链 <a>；loading=true 时自动禁用并标注 aria-busy。
 */
export function Button({ variant = 'ghost', size, disabled, loading = false, onClick, children, title, className, href, newTab = true }: ButtonProps) {
  const cls =
    variant === 'primary' ? css.primaryButton
      : variant === 'danger' ? css.dangerButton
        : css.ghostButton
  const effectiveDisabled = disabled === true || loading
  const sizeProps = size === 'sm' ? { 'data-size': 'sm' as const } : {}
  /**
   * 进行中态一律**自动**带加载图标（调用方只管文案，不必手写 <Spinner/>）。
   *
   * 为什么由原语负责：此前「有没有转圈」取决于每个调用点是否记得写 <Spinner/>，
   * 漏写的地方（任务中心的终止/确认、灾备页的撤销/重做…）只把文案换掉却没有任何进行中
   * 反馈，用户看到的是「按钮状态怪怪的」。图标走 Spinner 的 currentColor —— 主色按钮上
   * 的蓝色转圈压在蓝色底上等于看不见（本仓库实测过）。
   */
  const content = loading ? (<><Spinner />{children}</>) : children
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
        // 按钮类无 text-decoration 规则，<a> 默认下划线破坏按钮外观
        style={{ textDecoration: 'none' }}
        {...sizeProps}
      >
        {content}
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
      {...sizeProps}
    >
      {content}
    </button>
  )
}

/* ---------------- IconButton ---------------- */

export interface IconButtonProps {
  /** 图标/符号（文本符号；aria-label 必填描述用途） */
  icon: ReactNode
  /** 无障碍名称（必填：图标按钮没有可见文本） */
  label: string
  onClick?: () => void
  disabled?: boolean
  /** 高亮态（如侧滑面板打开时对应按钮 active） */
  active?: boolean
  /** 危险语义（红色；用于行内删除等破坏性动作的视觉隔离） */
  danger?: boolean
  title?: string
}

/** 图标按钮（导航条/工具栏图标动作；26px 触达区）。 */
export function IconButton({ icon, label, onClick, disabled, active, danger, title }: IconButtonProps) {
  return (
    <button
      type="button"
      className={css.iconBtn}
      aria-label={label}
      title={title ?? label}
      data-active={active === true ? '' : undefined}
      data-danger={danger === true ? '' : undefined}
      disabled={disabled === true}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/* ---------------- FoldToggle ---------------- */

export interface FoldToggleProps {
  /** 展开态（同时决定 aria-expanded 与 chevron 朝向） */
  open: boolean
  /** 折叠体 id（aria-controls）。折叠体必须始终存在 —— 见 common/Motion.tsx 的 Collapse */
  controls: string
  onToggle: () => void
  /** 可访问名（展开 / 收起两个方向各一份，调用方给已翻译文案） */
  expandLabel: string
  collapseLabel: string
}

/**
 * 卡头行尾的折叠开关（图标按钮 + chevron 形变）。
 *
 * 形态与 ContentPicker 的分区行、同步页的通道卡**完全一致**：原生 button + aria-expanded +
 * aria-controls，图标走 ExpandChevron 形变（折叠展开是它的合法用途，见 DESIGN.md §6）。
 * 折叠体由调用方用 Collapse 包住 —— 本原语只管开关，不管内容。
 */
export function FoldToggle({ open, controls, onToggle, expandLabel, collapseLabel }: FoldToggleProps) {
  const label = open ? collapseLabel : expandLabel
  return (
    <button
      type="button"
      className={css.iconBtn}
      data-size="sm"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <ExpandChevron open={open} size={14} />
    </button>
  )
}

/* ---------------- StatusDot ---------------- */

export type StatusDotKind = 'idle' | 'ok' | 'info' | 'warn' | 'error'

export interface StatusDotProps {
  kind?: StatusDotKind
  /** 进行中脉冲动画 */
  pulse?: boolean
}

/** 状态点（状态栏/行内状态指示）。 */
export function StatusDot({ kind = 'idle', pulse }: StatusDotProps) {
  return (
    <span
      className={css.statusDot}
      data-kind={kind === 'idle' ? undefined : kind}
      data-pulse={pulse === true ? '' : undefined}
      aria-hidden="true"
    />
  )
}

/* ---------------- Badge ---------------- */

export type { BadgeKind }

export interface BadgeProps {
  kind?: BadgeKind
  children: ReactNode
  /** 悬停提示（可选） */
  title?: string
}

/**
 * 状态徽章（info=业务色 / ok=成功 / warn=警告 / error=错误）。
 *
 * **优先复用宿主的 `Tag`**（DSH 原生只读标签，与设置页/插件清单里那枚同源）：四态映射到
 * 原生调色板的 success / info / warning / danger（映射表在 `src/ui/badge-tone.ts`，可单测）。
 * 拿不到原生包（老宿主）时回落本仓库的 `.badge[data-kind]` —— 两条路径的语义由**同一张表**给出。
 * 原生 Tag 没有 title 入参：需要悬停提示时套一层 inline-flex 的 wrapper，不改变布局。
 */
export function Badge({ kind = 'info', children, title }: BadgeProps) {
  const DshTag = hostTag()
  if (DshTag !== null) {
    const tag = <DshTag tone={badgeTone(kind)}>{children}</DshTag>
    return title === undefined ? tag : <span className={css.badgeHost} title={title}>{tag}</span>
  }
  return <span className={css.badge} data-kind={kind} title={title}>{children}</span>
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
  /** 少量布局微调（flex 填充等）；常规布局仍走 CSS 类 */
  style?: CSSProperties
}

/** 卡片容器（bg-layer-2 + 细边框） */
export function Card({ children, className, style }: CardProps) {
  return <div className={className !== undefined ? `${css.card} ${className}` : css.card} style={style}>{children}</div>
}

/* ---------------- Spinner ---------------- */

export interface SpinnerProps {
  label?: string
}

/**
 * 加载指示（旋转环 + 可选文案）。
 *
 * 为什么用 **SVG 圆**而不是「border + border-radius: 50%」的经典 CSS 转圈
 * ---------------------------------------------------------------
 * 2026-09 用户反馈「加载的 icon 不是圆形」。实测（对截图做像素几何测量）：形状**本来就是**
 * 近圆（外缘 20×19），真正的问题是观感 —— 13px 的盒子上压 2px 边框（占直径 15%），
 * 且只有 `border-top` 是实色、其余三边仅 25% 不透明度，栅格化后视觉上只剩左上一条亮弧，
 * 「圆」读不出来，看着像圆角方块的一个角。
 * 改用两个 `<circle>`：几何由路径保证（与分辨率/DPR 无关），描边细一档（≈1.63px），
 * 底环有足够对比度 → 形状一眼可辨。
 *
 * 颜色仍走 `currentColor`（与 lucide 图标同一约定），在主色/危险/幽灵任意底色上都取该处
 * 语义前景色；此前写死 business-primary 蓝会在**主色按钮**（蓝底）上变成蓝画蓝、转圈完全看不见。
 * 动画仍是同一个 `@keyframes spin`，且**刻意不在 prefers-reduced-motion 下停掉**（CSS §15）：
 * 它承载「正在进行」这个状态本身，停掉会让用户以为界面卡死。
 */
/** 圆的半径（24 网格内）；圆心固定 12,12。 */
const SPINNER_R = 9
/** 可见扫掠段占整圈的比例（与旧实现的 border-top = 1/4 圈一致）。 */
const SPINNER_ARC_RATIO = 0.25
/** 弧长按 2πr 现算 —— 改 `SPINNER_R` 时 `stroke-dasharray` 自动跟随，
 *  不会像手写常量那样与半径悄悄漂移（此前是 CSS 里手写的 `14.14 42.41`）。 */
const SPINNER_ARC_LENGTH = 2 * Math.PI * SPINNER_R * SPINNER_ARC_RATIO
const SPINNER_GAP_LENGTH = 2 * Math.PI * SPINNER_R - SPINNER_ARC_LENGTH

export function Spinner({ label }: SpinnerProps) {
  return (
    <span className={css.spinnerWrap}>
      <svg className={css.spinner} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle className={css.spinnerTrack} cx="12" cy="12" r={SPINNER_R} />
        <circle
          className={css.spinnerArc}
          cx="12"
          cy="12"
          r={SPINNER_R}
          strokeDasharray={SPINNER_ARC_LENGTH.toFixed(2) + ' ' + SPINNER_GAP_LENGTH.toFixed(2)}
        />
      </svg>
      {label !== undefined && <span className={css.spinnerLabel}>{label}</span>}
    </span>
  )
}

/* ---------------- Field ---------------- */

export interface FieldProps {
  label: string
  /**
   * 常驻说明：只留给**动态/元数据**文案（校验失败重申、当前值、计数）。纯说明性文案走 `info`。
   */
  hint?: string
  /** 说明性文案的 ⓘ（调用点传 `<InfoHint text={t('原键')} label={t('common.infoHint')} />`），贴在字段标签右侧 */
  info?: ReactNode
  children: ReactNode
}

/** 表单字段（标签 + 控件 + 说明 / ⓘ） */
export function Field({ label, hint, info, children }: FieldProps) {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}{info !== undefined ? <> {info}</> : null}</span>
      {children}
      {hint !== undefined && <span className={css.hint}>{hint}</span>}
    </label>
  )
}

/* ---------------- SectionTitle ---------------- */

export interface SectionTitleProps {
  title: string
  /**
   * 常驻副标题：只留给**动态/元数据**文案（当前项名、计数、状态说明、必须看到的下一步指引）。
   * 纯说明性文案（机制 / 边界 / 背景 / 输入规则）一律走 `info`。
   */
  subtitle?: string
  /**
   * 说明性文案的 ⓘ（调用点传 `<InfoHint text={t('原键')} label={t('common.infoHint')} />`）。
   * 渲在标题**同一行**右侧（DESIGN.md §7「摆放」形态①）；与它互斥的旧写法是把同一句话
   * 常驻成 `subtitle` —— 那就把页面又撑长了一行。
   */
  info?: ReactNode
}

/** 区块标题（页面内二级标题 + 可选副标题 / ⓘ 说明） */
export function SectionTitle({ title, subtitle, info }: SectionTitleProps) {
  return (
    <div className={css.sectionTitleBlock}>
      <div className={css.sectionTitleRow}>
        <h3 className={css.sectionTitle}>{title}</h3>
        {info}
      </div>
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

/* ---------------- Segmented ---------------- */

export interface SegmentedItem {
  id: string
  label: string
  /** 计数徽标（可选；如市场分区筛选计数） */
  count?: number
}

export interface SegmentedProps {
  items: SegmentedItem[]
  active: string
  onChange: (id: string) => void
  ariaLabel?: string
}

/**
 * 分段控件（页内子视图切换 / 筛选；受控）。
 *
 * ARIA 口径：这是**按钮组**（role=group + aria-pressed），不是 tabs —— 两个调用点
 * （环境页子视图、市场筛选）都没有 tabpanel 容器，用 role=tab 会让读屏用户听到
 * 「标签页 2/2」却找不到对应面板（全仓 grep 无 role="tabpanel"）。要升级成真 tabs，
 * 必须先给内容容器补 role=tabpanel + id 配对（导航条已按此实现）。
 */
export function Segmented({ items, active, onChange, ariaLabel }: SegmentedProps) {
  return (
    <div className={css.segGroup} role="group" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === active}
          data-active={item.id === active ? '' : undefined}
          className={css.segItem}
          onClick={() => { onChange(item.id) }}
        >
          {item.label}
          {item.count !== undefined && <span aria-hidden="true">·{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Stepper ---------------- */

export type StepperStepState = 'done' | 'current' | 'todo'

export interface StepperStep {
  /** 步骤唯一 key（React list key）。 */
  key: string
  label: string
  state: StepperStepState
}

export interface StepperProps {
  steps: StepperStep[]
  /** 可访问性说明（如「第 2 步，共 6 步」）；存在时容器带 role=group + aria-label */
  ariaLabel?: string
}

/**
 * 向导步骤条（只读指示器，非导航）：紧凑圆点（序号/✓）+ 连接线 + 标签。
 * state 由调用方的纯函数模型给出；组件不做任何状态推断。
 */
export function Stepper({ steps, ariaLabel }: StepperProps) {
  return (
    <div className={css.stepper} role={ariaLabel !== undefined ? 'group' : 'list'} aria-label={ariaLabel}>
      {steps.map((step, i) => (
        <span key={step.key} role="listitem" className={css.stepperStep} data-state={step.state}>
          <span className={css.stepperDot} data-state={step.state} aria-hidden="true">
            {step.state === 'done' ? '✓' : i + 1}
          </span>
          <span className={css.stepperLabel}>{step.label}</span>
          {i < steps.length - 1 && <span className={css.stepperConnector} aria-hidden="true" />}
        </span>
      ))}
    </div>
  )
}
