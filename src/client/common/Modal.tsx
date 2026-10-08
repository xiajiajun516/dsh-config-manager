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
import { useLayoutEffect, useState } from 'react'
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

/**
 * 插件根节点查询（Portal 容器）：渲染期与 layout effect 共用同一份实现。
 *
 * **导出的原因**：InfoHint（ⓘ 气泡）也要把它的气泡 Portal 到这里 —— 两个 Portal 的容器必须是
 * 同一个 `#dsh-config-manager-root`（同一条铁律：绝不能挂 `document.body`，见上）。
 * 而且气泡**必须**脱离 `.dialogContentCenter` 的常驻 `transform: translate(-50%,-50%)`：
 * 按 CSS Transforms L1，带 transform 的祖先会成为后代 `position: fixed` 的包含块 ——
 * 裸 fixed 的气泡在 Modal 内会整体偏移卡片位移，并被 `.dialogBody{overflow-y:auto}` 裁剪。
 */
export function resolveModalRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(MODAL_ROOT_ID)
}

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
  /** 说明文本节点的 id（Radix Content 据此设 aria-describedby）：
   *  确认框的「后果说明」必须被屏幕阅读器读到 —— 只设 aria-label 时打开弹窗只播报标题。
   *  传 id 而不是文本，是为了让可见正文本身就是被描述的那一段（不重复渲染、不动视觉）。 */
  describedById?: string
  /** 卡片额外内联样式（如 ReleaseNotes 的自定义宽度/最大高度）；常规布局仍走 CSS 类 */
  cardStyle?: CSSProperties
  children?: ReactNode
}

/**
 * 统一弹窗容器（Radix Dialog）。busy 时禁用 Esc 与遮罩关闭。
 */
export function Modal({ open, onClose, title, wide, busy, onOpenAutoFocus, cardStyle, describedById, children }: ModalProps) {
  /**
   * Portal 容器解析 —— 三条纪律（顺序即重要性，别改回 useEffect）：
   *
   * ① **渲染期同步取一次**（惰性 useState）：Modal 绝大多数时候与插件根节点**不在**同一次
   *    commit 里挂载（弹窗随面板重挂、切页签回来才挂），此时根节点已在 DOM 中，一次命中。
   * ② 用 layout effect 兜底：真正「Modal 与根节点同一次 commit」的极端情况下重解析，
   *    它发生在**首次绘制之前**，因此看不到任何中间态。
   * ③ 容器未知时**不渲染 Portal**（见下方 JSX 的 container !== null 判断）：Radix 的 Portal
   *    在 container 为空时会回退到 document.body，而这个回退判定发生在 layout effect（绘制前）——
   *    一旦走到那条回退路径，弹窗会**先在 body 里画一帧**（position:fixed 此时相对视口居中，
   *    而不是相对插件根节点所在的宿主面板），随后才被搬进 #dsh-config-manager-root：
   *    用户看到的就是「弹窗先闪现在别处、再跳到页面中心」（档案详情弹窗实测反馈）。
   *    **以前为什么会踩到**：useEffect 在**绘制之后**才跑，而「刷新后详情目标保留」
   *    （run-store 的持久化白名单）与「切页签回来面板重挂」都会让弹窗**带着 open=true 一起挂载**，
   *    正好命中这条路径。
   */
  const [container, setContainer] = useState<HTMLElement | null>(resolveModalRoot)
  useLayoutEffect(() => { setContainer(resolveModalRoot()) }, [])

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // busy 时拒绝关闭（Radix 通过 onOpenChange(false) 表达 Esc/遮罩关闭意图）
        if (!next && busy === true) return
        if (!next) onClose()
      }}
    >
      {/* 容器未知（仅限「Modal 与根节点同一次 commit」的瞬间，layout effect 会在绘制前补上）
          → 什么都不渲染；**绝不**用 Radix 的 document.body 回退（那会先画一帧错位再跳回来）。 */}
      {container !== null && (
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={css.dialogMask} />
        <Dialog.Content
          className={`${css.dialogContentCenter} ${css.dialogCard}${wide === true ? ` ${css.dialogWide}` : ''}`}
          style={cardStyle}
          aria-label={title}
          // 说明文本（危险确认的后果）必须进无障碍树：Radix 只在存在 Dialog.Description 时
          // 自动接 aria-describedby，而我们的正文由调用方自渲染 —— 因此显式传 id（视觉零变化）。
          aria-describedby={describedById}
          // 「这是我们自己的弹窗卡片」标记：Select 的弹层据此决定挂载点 —— 弹层**必须**进弹窗内容子树，
          // 否则会被 radix 的 body{pointer-events:none}、外部交互判定与 RemoveScroll 滚动锁挡死
          // （2026-10-04 用户反馈「选项点不动」；见 common/Select.tsx 的 resolveMenuHost）。
          data-cm-dialog=""
          onOpenAutoFocus={onOpenAutoFocus}
          // busy 时阻止 Radix 默认的 Esc/外部指针关闭（双保险，配合 onOpenChange 守卫）
          onEscapeKeyDown={(e) => { if (busy === true) e.preventDefault() }}
          onPointerDownOutside={(e) => { if (busy === true) e.preventDefault() }}
          onInteractOutside={(e) => { if (busy === true) e.preventDefault() }}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
      )}
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
