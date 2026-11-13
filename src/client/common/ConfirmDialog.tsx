/**
 * ConfirmDialog —— 确认弹窗（危险/重要操作的二次确认，DESIGN.md §8.11 / §14）。
 *
 * 2026-09 升级：底层改用 Radix Dialog（见 common/Modal.tsx），获得成熟的 focus trap、
 * Esc 关闭、初始焦点与关闭后焦点还原、body 滚动锁定、Portal 渲染——替代原先手写的
 * ~80 行 a11y 逻辑。对外 props 契约完全保持兼容（open/title/message/confirmLabel/
 * cancelLabel/danger/busy/onConfirm/onCancel/backdropClose/children），调用方零改动。
 *
 * 交互约定（由 Radix + Modal 承载，语义不变）：
 * - 受控组件：open=false 时不渲染；open=true 渲染遮罩 + 居中卡片；
 * - 关闭三途径：遮罩点击、Esc 键、取消按钮（busy 时全部禁用）；
 *   backdropClose 缺省 = onCancel；用于「不再提示」类弹窗让遮罩/Esc 只是暂时关闭、
 *   不算表态（Radix onOpenChange(false) → 走 handleBackdropClose）；
 * - busy=true（或 onConfirm 返回 Promise 的自管 busy）时禁用一切关闭途径与确认按钮；
 * - 初始焦点在取消按钮（危险确认不默认落破坏性按钮）；关闭后 Radix 自动还原焦点到触发元素。
 *
 * 安全：message 由调用方传入（渲染前已 redact 兜底）；本组件不触碰任何凭据。
 */
import { useId, useRef, useState } from 'react'
import { Button } from './ui.tsx'
import { Modal } from './Modal.tsx'
import css from '../config-manager.module.css'

export interface ConfirmDialogProps {
  /** 是否打开（受控）；false 时不渲染 */
  open: boolean
  /** 标题（如「删除条目」） */
  title: string
  /** 正文说明（可选；限高 240px 内滚，长文本安全） */
  message?: string
  /** 确认按钮文案（缺省「确认」由调用方传，不设默认避免硬编码） */
  confirmLabel?: string
  /** 取消按钮文案（缺省同 confirmLabel 场景由调用方传；不设默认） */
  cancelLabel?: string
  /**
   * 右上角 ✕ 的可访问名（缺省复用 cancelLabel —— 它与 ✕ 是同一个「不改动就退出」语义）。
   * 本组件没有 `t`（字典按调用点注入），因此不设硬编码兜底：两者都没传时不渲染 ✕（旧行为）。
   */
  closeLabel?: string
  /** 危险语义：确认按钮用 danger 样式（删除等不可恢复操作）；缺省 primary */
  danger?: boolean
  /** 外部控制 busy（进行中禁闭）；onConfirm 返回 Promise 时组件自管 */
  busy?: boolean
  /** 确认回调（返回 Promise 时组件自管 busy 直到完成/失败） */
  onConfirm: () => void | Promise<void>
  /** 取消/关闭回调 */
  onCancel: () => void
  /** 遮罩点击 / Esc 关闭时的回调（缺省 = onCancel）；用于「不再提示」类弹窗
   *  让遮罩/Esc 只是暂时关闭、不记「不再提示」表态 */
  backdropClose?: () => void
  /** 额外内容（可选；渲染在 message 之后、按钮区之前） */
  children?: React.ReactNode
}

/**
 * 确认弹窗：遮罩 + 居中卡片 + 标题/正文/按钮区（Radix Dialog 承载 a11y）。
 * 自管 busy：onConfirm 返回 Promise 时置 busy 直到 resolve（reject 仍关闭 busy，错误由调用方处理）。
 */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, closeLabel, danger, busy: busyProp, onConfirm, onCancel, backdropClose, children,
}: ConfirmDialogProps) {
  const [selfBusy, setSelfBusy] = useState(false)
  const busy = busyProp === true || selfBusy
  /** 遮罩/Esc 关闭回调（缺省 = 取消按钮同一回调） */
  const handleBackdropClose = backdropClose ?? onCancel
  /** 取消按钮 ref：Radix 打开时把初始焦点重定向到此（危险确认不默认落破坏性的确认按钮） */
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  /** 正文说明的 DOM id：交由 Modal 设 aria-describedby。
   *  只设 aria-label 时读屏只会播报标题（如「删除档案」），而**后果说明**不会在打开时被读出。 */
  const messageId = useId()
  const hasMessage = message !== undefined && message !== ''
  /** ✕ 的可访问名：调用点没单独给就用取消按钮的文案（同一「退出不改动」语义，不硬编码） */
  const closeText = closeLabel ?? cancelLabel

  const handleConfirm = (): void => {
    if (busy) return
    const result = onConfirm()
    if (result instanceof Promise) {
      setSelfBusy(true)
      void result.finally(() => { setSelfBusy(false) })
    }
  }

  /** Radix 打开时默认聚焦首个可聚焦元素（确认按钮）；改派发到取消按钮。 */
  const onOpenAutoFocus = (e: Event): void => {
    e.preventDefault()
    cancelRef.current?.focus()
  }

  return (
    <Modal open={open} onClose={handleBackdropClose} title={title} busy={busy} onOpenAutoFocus={onOpenAutoFocus} describedById={hasMessage ? messageId : undefined}>
      {/* C-11（2026-11-14）：此前只有遮罩/Esc/取消三条关闭途径，鼠标用户找不到右上角的出口。
          busy 时 ✕ 仍在但禁用（与取消按钮同一口径），不做「操作中弹窗突变换高」的那种跳动。 */}
      {closeText === undefined
        ? <Modal.Header title={title} />
        : <Modal.Header title={title} onClose={handleBackdropClose} closeLabel={closeText} closeDisabled={busy} />}
      <Modal.Body scroll>
        {/* pre-line：调用点用 \n\n 分段（D-19「删除当前档案」两段后果说明），裸 div 会把两段压成一行 */}
        {hasMessage && <div id={messageId} className={css.confirmMessage}>{message}</div>}
        {children}
      </Modal.Body>
      {/* 按钮次序（2026-11-13 统一）：**取消在左、主操作在右**。
          此前这里是「确认在左、取消在右」，与自绘 Footer（LibraryActions / SyncPanel /
          ReleaseNotesDialog 的「取消 … 主操作」）相反 —— 同一产品里两套次序，用户在不同
          弹窗里会点错。统一后 danger 确认仍在最右（拇指落点），但**初始焦点仍派给取消**
          （见下方 cancelRef / onOpenAutoFocus）：次序变了，误触保护不变。 */}
      <Modal.Footer>
        <button
          ref={cancelRef}
          type="button"
          className={css.ghostButton}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onCancel}
        >
          {cancelLabel ?? ''}
        </button>
        <Button
          variant={danger === true ? 'danger' : 'primary'}
          disabled={busy}
          loading={busy}
          onClick={() => { void handleConfirm() }}
        >
          {/* 加载图标由 Button 原语按 loading 自动渲染（此处只给文案） */}
          {confirmLabel ?? ''}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
