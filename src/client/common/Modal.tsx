/**
 * Modal —— 基于 @radix-ui/react-dialog 的统一弹窗原语（Workbench Design System）。
 *
 * 取代项目里散落的两套弹窗实现：
 *   1. ConfirmDialog（手写 focus trap / Esc / 焦点还原）；
 *   2. 各页内联 dialogMask+dialogCard（无 focus trap、Esc 行为不一致）。
 * 统一后获得 Radix 成熟的无障碍能力：
 *   - 自动 focus trap（Tab 循环限制在弹窗内，disabled/隐藏元素跳过）；
 *   - Esc 关闭（可禁用）、遮罩点击关闭（可禁用）、初始焦点与关闭后焦点还原；
 *   - aria-modal / role=dialog、body 滚动锁定、Portal 渲染到 document.body（脱离宿主
 *     settings 弹窗的层叠上下文，z-index 由 Radix 内容层统一管理）。
 *
 * 视觉沿用既有 --dsw-* token 类（dialogMask/dialogCard/dialogHeader/dialogBody/...），
 * 不引入第二套视觉体系；仅把「行为/a11y」交给 Radix，外观仍由 config-manager.module.css 控制。
 *
 * 用法：
 *   <Modal open={open} onClose={close} title="标题" wide>
 *     <Modal.Header onClose={close} />   // 可选：带关闭按钮的标题行
 *     <Modal.Body scroll>…内容…</Modal.Body>
 *     <Modal.Footer>…按钮…</Modal.Footer>
 *   </Modal>
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CloseIcon } from './Icon.tsx'
import css from '../config-manager.module.css'

/**
 * 插件根节点 id（渲染在 `ConfigManagerSection` 的最外层 div 上），同时是 Radix Portal 的挂载容器。
 *
 * 为什么不能挂 `document.body`（Radix 默认）：宿主设置弹窗的 overlay 是
 * `position: fixed; z-index: 1000`，插件弹窗若挂到 body 就成了它的**兄弟**，
 * 自身 z-index 100/101 远低于 1000 → 弹窗被整个盖住、肉眼完全不可见；
 * 而 Radix 在 modal 打开时已经把 `document.body` 置为 `pointer-events: none`，
 * 于是表现为「打开备份与迁移后整页点不动，必须先在屏幕上点一下才行」——
 * 那一下点击正是关掉这个"透明弹窗"的 outside-pointerdown。
 *
 * 把 Portal 容器指回插件根节点，弹窗就重新落在宿主弹窗自己的层叠上下文内
 * （与 Radix 迁移前内联渲染 `dialogMask` 的层级语义一致），遮罩与卡片正常可见可点。
 */
export const MODAL_ROOT_ID = 'dsh-config-manager-root'

export interface ModalProps {
  /** 是否打开（受控） */
  open: boolean
  /** 关闭回调（Esc / 遮罩点击 / 关闭按钮触发） */
  onClose: () => void
  /** 弹窗 accessible name（aria-label） */
  title?: string
  /** 宽变体（480px，用于计划预览/差异查看等密集内容） */
  wide?: boolean
  /** busy 时禁用一切关闭途径（防执行中误关） */
  busy?: boolean
  /** Radix 打开时的初始焦点重定向（如 ConfirmDialog 把焦点派发到取消按钮）。
   *  Radix 传入的是可 preventDefault 的 DOM Event。 */
  onOpenAutoFocus?: (e: Event) => void
  /** 卡片额外内联样式（如 ReleaseNotes 的自定义宽度/最大高度）；常规布局仍走 CSS 类 */
  cardStyle?: CSSProperties
  children?: ReactNode
}

/**
 * 统一弹窗容器（Radix Dialog）。busy 时禁用 Esc 与遮罩关闭。
 */
export function Modal({ open, onClose, title, wide, busy, onOpenAutoFocus, cardStyle, children }: ModalProps) {
  // Portal 容器在挂载后再解析一次：Modal 与根节点可能在同一次 commit 中渲染，
  // 首次求值时根节点尚未进 DOM（届时回退 Radix 的 document.body）。
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setContainer(document.getElementById(MODAL_ROOT_ID))
  }, [])

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // busy 时拒绝关闭（Radix 通过 onOpenChange(false) 表达 Esc/遮罩关闭意图）
        if (!next && busy === true) return
        if (!next) onClose()
      }}
    >
      <Dialog.Portal container={container ?? undefined}>
        <Dialog.Overlay className={css.dialogMask} />
        <Dialog.Content
          className={`${css.dialogContentCenter} ${css.dialogCard}${wide === true ? ` ${css.dialogWide}` : ''}`}
          style={cardStyle}
          aria-label={title}
          onOpenAutoFocus={onOpenAutoFocus}
          // busy 时阻止 Radix 默认的 Esc/外部指针关闭（双保险，配合 onOpenChange 守卫）
          onEscapeKeyDown={(e) => { if (busy === true) e.preventDefault() }}
          onPointerDownOutside={(e) => { if (busy === true) e.preventDefault() }}
          onInteractOutside={(e) => { if (busy === true) e.preventDefault() }}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------------- 子部件（纯样式装配，无逻辑） ---------------- */

/** 标题行公共属性 */
interface ModalHeaderCommon {
  /** 标题文本（同时作为可视标题） */
  title: string
  /** 关闭按钮 disabled（如 busy） */
  closeDisabled?: boolean
  /** 标题行右侧额外内容（如徽章/合计） */
  trailing?: ReactNode
}

/**
 * 弹窗标题行属性。
 *
 * `closeLabel`（关闭按钮的 aria-label）在传了 `onClose` 时**必填**，且必须是已翻译文本
 * （各自字典的 `common.close`）：UI-17 —— 原先硬编码 `aria-label="关闭"`，界面语言为英文时
 * 屏幕阅读器仍读中文。这条约束交给**编译器**（联合类型）而不是靠人记得。
 */
export type ModalHeaderProps = ModalHeaderCommon & (
  | { /** 关闭按钮回调 */ onClose: () => void; /** 已翻译的关闭文案（各字典 common.close） */ closeLabel: string }
  | { onClose?: undefined; closeLabel?: string }
)

/** 弹窗标题行（可选关闭按钮 + 右侧 trailing）。 */
function ModalHeader({ title, onClose, closeLabel, closeDisabled, trailing }: ModalHeaderProps) {
  if (onClose === undefined && trailing === undefined) {
    return <div className={css.dialogHeader}>{title}</div>
  }
  return (
    <div className={css.dialogHeaderRow}>
      <span className={css.dialogHeader}>{title}</span>
      {trailing}
      {onClose !== undefined && (
        <Dialog.Close asChild>
          <button
            type="button"
            className={`${css.iconBtn} ${css.dialogClose}`}
            // 关闭文案由调用方传入已翻译文本（各字典 common.close）；此处**不得**再硬编码（UI-17）
            aria-label={closeLabel}
            disabled={closeDisabled === true}
          >
            <CloseIcon size={14} />
          </button>
        </Dialog.Close>
      )}
    </div>
  )
}

export interface ModalBodyProps {
  children?: ReactNode
  /** 限高内滚变体（长内容安全） */
  scroll?: boolean
  /** 正文容器 ref（如 ReleaseNotes 无限滚动需要监听滚动位置） */
  innerRef?: Ref<HTMLDivElement>
  /** 滚动回调（配合 innerRef 实现无限加载等） */
  onScroll?: () => void
  /** 正文额外内联样式（如自定义 maxHeight/gap）；常规布局仍走 CSS 类 */
  style?: CSSProperties
}

/** 弹窗正文区。 */
function ModalBody({ children, scroll, innerRef, onScroll, style }: ModalBodyProps) {
  return (
    <div
      ref={innerRef}
      className={scroll === true ? `${css.dialogBody} ${css.dialogBodyScroll}` : css.dialogBody}
      onScroll={onScroll}
      style={style}
    >
      {children}
    </div>
  )
}

/** 弹窗底部按钮区（actionRow 右对齐）。 */
function ModalFooter({ children }: { children?: ReactNode }) {
  return <div className={`${css.actionRow} ${css.dialogFooter}`}>{children}</div>
}

Modal.Header = ModalHeader
Modal.Body = ModalBody
Modal.Footer = ModalFooter
