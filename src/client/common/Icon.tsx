/**
 * 图标原语 —— 基于 lucide-react 的统一图标层（Workbench Design System）。
 *
 * 取代散落的文本符号图标（▣ ⇥ ⇤ ⇅ ⟳ ◷ ⓘ ⭳ ⌕ ✕ ⧉ →），解决跨平台字形宽度/基线
 * 漂移与视觉重量不一致问题。所有图标统一：
 *   - 尺寸由 `size` 控制（默认 14px，对齐正文行高）；
 *   - 描边 strokeWidth 统一 1.75（克制、精致，匹配高密度开发者工具观感）；
 *   - 颜色继承 currentColor（跟随父级文字色 / data-danger / hover 等语义）；
 *   - vertical-align 居中，与相邻文字基线对齐。
 *
 * 用法：<Icon name="download" /> 或具名导出 <DownloadIcon />。
 * 不引入第二套视觉体系：颜色走 currentColor → 父级 --dsw-* token。
 *
 * 本文件同时是**形变层**的落点（`ExpandChevron`）：分支决策见 DESIGN.md §6，
 * 数据来源与版本纪律见 common/morph-icons.ts。静态 `Icon` 与形变 `ExpandChevron`
 * 是两套**互补**的出口，不是替代关系 —— 静态图标不要改成形变。
 */
import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
// 体积纪律：从各图标独立模块路径导入（非 `lucide-react` 桶导出），保证 rolldown 在 cjs
// 单文件打包下精确 tree-shake——只打入用到的 ~18 个图标，避免整库 1500+ 全量进 client.js。
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right.mjs'
import CheckCircle from 'lucide-react/dist/esm/icons/check-circle.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs'
import Clock from 'lucide-react/dist/esm/icons/clock.mjs'
import CircleAlert from 'lucide-react/dist/esm/icons/circle-alert.mjs'
import Copy from 'lucide-react/dist/esm/icons/copy.mjs'
import DatabaseBackup from 'lucide-react/dist/esm/icons/database-backup.mjs'
import Download from 'lucide-react/dist/esm/icons/download.mjs'
import Eye from 'lucide-react/dist/esm/icons/eye.mjs'
import File from 'lucide-react/dist/esm/icons/file.mjs'
import FolderInput from 'lucide-react/dist/esm/icons/folder-input.mjs'
import HardDriveDownload from 'lucide-react/dist/esm/icons/hard-drive-download.mjs'
import History from 'lucide-react/dist/esm/icons/history.mjs'
import Info from 'lucide-react/dist/esm/icons/info.mjs'
import Lock from 'lucide-react/dist/esm/icons/lock.mjs'
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.mjs'
import PackageCheck from 'lucide-react/dist/esm/icons/package-check.mjs'
import Pencil from 'lucide-react/dist/esm/icons/pencil.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import RotateCw from 'lucide-react/dist/esm/icons/rotate-cw.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2.mjs'
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert.mjs'
import Upload from 'lucide-react/dist/esm/icons/upload.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'
// 形变层：数据来自 vanilla `lucide`（Icon.tsx 的组件包给不出 IconNode），运行时来自 morphicons。
import type { IconNode } from 'morphicons'
import { MorphIcon } from 'morphicons/react'
import { MORPH_ICONS, MORPH_SPRING } from './morph-icons.ts'

/** 语义图标名 → Lucide 组件映射（单一事实来源）。 */
const ICONS = {
  backup: HardDriveDownload,
  export: Upload,
  import: FolderInput,
  sync: RefreshCw,
  refresh: RotateCw,
  activity: Clock,
  clock: Clock,
  history: History,
  about: Info,
  info: Info,
  lock: Lock,
  message: MessageSquare,
  pencil: Pencil,
  close: X,
  delete: Trash2,
  file: File,
  download: Download,
  inspect: Search,
  view: Eye,
  copy: Copy,
  arrowRight: ArrowRight,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  preview: Eye,
  snapshot: DatabaseBackup,
  ok: PackageCheck,
  check: CheckCircle,
  warn: TriangleAlert,
  error: CircleAlert,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export interface IconProps {
  name: IconName
  /** 像素尺寸（默认 14，对齐 12.5px 正文行高） */
  size?: number
  /** 描边粗细（默认 1.75） */
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  /** 无障碍：装饰性图标默认 aria-hidden；需语义时由父级 aria-label 承担 */
  decorative?: boolean
}

/**
 * 统一图标（lucide-react）。颜色继承 currentColor，尺寸/描边集中控制。
 */
export function Icon({ name, size = 14, strokeWidth = 1.75, className, style, decorative = true }: IconProps) {
  const Cmp = ICONS[name]
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={{ verticalAlign: 'middle', flex: 'none', ...style }}
      aria-hidden={decorative || undefined}
      focusable={false}
    />
  )
}

/* —— 形变层 —— */

export interface ExpandChevronProps {
  /** 展开态：true → chevron-down，false → chevron-right；变化时形变过渡。 */
  open: boolean
  /** 像素尺寸（默认 14，与 `Icon` 一致） */
  size?: number
  /** 描边粗细（默认 1.75，与 `Icon` 一致） */
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

/* —— 形变公共底座：两条硬约定只在这里出现一次 —— */

interface MorphBaseProps {
  icon: IconNode
  size: number
  strokeWidth: number
  className?: string
  style?: CSSProperties
}

/**
 * 形变层的公共底座。**两条硬约定只写在这里** —— 语义出口（ExpandChevron / CopyStateIcon）
 * 不得各自再写一遍，否则迟早有一处漂移。
 *
 *   1. `reducedMotion="user"`：morphicons 缺省 `"never"`，即**无视**系统「减弱动效」设置。
 *      显式覆盖后，系统开启该选项时降级为瞬时切换（无动画，状态仍正确）。
 *   2. `spring={MORPH_SPRING}`：临界阻尼、无过冲（ζ=1.0），刚度 k=420（≈1.6 倍于 smooth）；
 *      不依赖库缺省，避免升级时观感漂移。参数与理由见 `morph-icons.ts`。
 *
 * 无障碍与着色与 `Icon` 同口径：装饰性 → `aria-hidden`（可访问名由外层 `aria-label` 的
 * 图标按钮承担）；颜色继承 `currentColor`（MorphIcon 缺省 `color="currentColor"`、`fill="none"`，
 * 与 lucide-react 一致）。
 */
function MorphBase({ icon, size, strokeWidth, className, style }: MorphBaseProps) {
  return (
    <MorphIcon
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      spring={MORPH_SPRING}
      reducedMotion="user"
      className={className}
      style={{ verticalAlign: 'middle', flex: 'none', ...style }}
      aria-hidden
      focusable={false}
    />
  )
}

/**
 * 参与形变的「展开/收起」chevron（折叠控件的唯一展开控件，当前 4 处：ContentPicker 两行 +
 * RestorePlanView 分组头/行内）。
 *
 * 与静态 `Icon` 的分工：`Icon` 承担**不变**的语义图标；这里只用在**状态切换本身携带
 * 信息**的位置 —— 形变让「已经变了」这件事可见。chevron-right → chevron-down 天然是 90° 旋转，
 * 由 morphicons 的 Procrustes 自行推出，无需手写旋转（实测 θ 恒为 90°、lnSigma = 0）。
 */
export function ExpandChevron({ open, size = 14, strokeWidth = 1.75, className, style }: ExpandChevronProps) {
  return (
    <MorphBase
      icon={open ? MORPH_ICONS.chevronDown : MORPH_ICONS.chevronRight}
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
    />
  )
}

/* —— 「复制 → 已复制」 —— */

export interface CopyStateIconProps {
  /** true = 已复制（对勾），false = 空闲（复制图标）；变化时形变过渡。 */
  done: boolean
  /** 像素尺寸（默认 14，与 `Icon` 一致） */
  size?: number
  /** 描边粗细（默认 1.75，与 `Icon` 一致） */
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

/**
 * 复制按钮的「空闲 ↔ 已复制」形变。
 *
 * 这一对的几何是**特制**的：空闲态用的是 lucide `copy-check` 的结构 + 一个退化的
 * 「隐藏对勾」（实测依据见 `morph-icons.ts` 的 `HIDDEN_CHECK_D`）。**别**把它换成朴素的
 * `copy` / `copy-check` 一对 —— 拓扑不匹配（2↔3）会让矩形缩到 0.2 倍并旋转 −159°，
 * 中途是一团乱线（实测 `lnSigma = −1.62`、`res = 0.66`）。
 *
 * 「复制」按钮的完整交互（剪贴板调用 + 计时复位 + Toast）在 `common/CopyButton.tsx`，
 * 本组件只管图标。
 */
export function CopyStateIcon({ done, size = 14, strokeWidth = 1.75, className, style }: CopyStateIconProps) {
  return (
    <MorphBase
      icon={done ? MORPH_ICONS.copyDone : MORPH_ICONS.copy}
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
    />
  )
}

/* —— 具名导出（调用处可读性优先） —— */
export const BackupIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="backup" {...p} />
export const ExportIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="export" {...p} />
export const ImportIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="import" {...p} />
export const SyncIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="sync" {...p} />
export const RefreshIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="refresh" {...p} />
export const ActivityIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="activity" {...p} />
export const ClockIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="clock" {...p} />
export const HistoryIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="history" {...p} />
export const AboutIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="about" {...p} />
export const MessageIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="message" {...p} />
export const PencilIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="pencil" {...p} />
export const CloseIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="close" {...p} />
export const DeleteIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="delete" {...p} />
export const DownloadIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="download" {...p} />
export const InspectIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="inspect" {...p} />
export const ArrowRightIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="arrowRight" {...p} />
export const ChevronDownIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="chevronDown" {...p} />
export const PreviewIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="preview" {...p} />
export const SnapshotIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="snapshot" {...p} />
export const CheckIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="check" {...p} />
export const WarnIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="warn" {...p} />
export const ErrorIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="error" {...p} />
export const InfoIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="info" {...p} />
/** 加密容器标注（issue #55：备份列表里区分「整包加密」的产物）。 */
export const LockIcon = (p: Omit<IconProps, 'name'>): JSX.Element => <Icon name="lock" {...p} />
