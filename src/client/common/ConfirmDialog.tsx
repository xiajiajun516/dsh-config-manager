/**
 * ConfirmDialog —— 确认弹窗（危险/重要操作的二次确认，DESIGN.md §8.11 / §14）。
 *
 * 背景（2026-08-20）：用户要求「删除按钮需要弹窗弹出二次确认」，替代原先的
 * 「行内两步确认」（已从 DESIGN.md §14 移除，见 t8 设计）。本项目此前无任何
 * modal / fixed / z-index 元素，本组件是首个浮动层 —— DESIGN.md §15 Anti-pattern #7
 * 已登记豁免（z-index 100；浮动层必须先设计进 DESIGN.md 的流程满足）。
 *
 * 交互约定：
 * - 受控组件：open=false 时不渲染；open=true 渲染遮罩 + 居中卡片；
 * - 关闭三途径：遮罩点击（仅 e.target === currentTarget）、Esc 键、取消按钮；
 *   （可选 backdropClose：遮罩点击 / Esc 走此回调而非 onCancel —— 用于「不再提示」类
 *   弹窗，用户点遮罩只是暂时关闭、不算表态；缺省时三途径一致走 onCancel）；
 * - busy=true（或 onConfirm 返回 Promise 的自管 busy）时禁用一切关闭途径与确认按钮，
 *   防重复提交；
 * - 初始焦点在取消按钮（危险确认不默认落破坏性按钮）；关闭后还原焦点到触发按钮
 *   （open 前的 document.activeElement）；
 * - 不做完整 focus trap（两按钮场景风险可接受，DESIGN.md §8.11 已注明）。
 *
 * 安全：message 由调用方传入（渲染前已 redact 兜底，与全站一致）；本组件不触碰任何凭据。
 * 样式：全部走 --dsw-* token（遮罩 color-mix 半透明、卡片 bg-layer-2 + border-l1），
 * 仅新增 dialogMask/dialogCard/dialogHeader/dialogBody 四个类（config-manager.module.css）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui.tsx'
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
  children?: ReactNode
}

/**
 * 确认弹窗：遮罩 + 居中卡片 + 标题/正文/按钮区。
 * 自管 busy：onConfirm 返回 Promise 时置 busy 直到 resolve（reject 仍关闭 busy，错误由调用方处理）。
 */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, danger, busy: busyProp, onConfirm, onCancel, backdropClose, children,
}: ConfirmDialogProps) {
  const [selfBusy, setSelfBusy] = useState(false)
  const busy = busyProp === true || selfBusy
  /** open 前的活动元素（关闭后还原焦点） */
  const prevFocus = useRef<Element | null>(null)
  /** 取消按钮 ref（初始焦点） */
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  /** 遮罩/Esc 关闭回调（缺省 = 取消按钮同一回调） */
  const handleBackdropClose = backdropClose ?? onCancel

  // 打开时记录触发元素 + 焦点落到取消按钮；关闭时还原焦点
  useEffect(() => {
    if (open) {
      prevFocus.current = document.activeElement
      // 下一帧聚焦取消按钮（等渲染完成）
      requestAnimationFrame(() => { cancelRef.current?.focus() })
      return
    }
    if (prevFocus.current !== null && prevFocus.current instanceof HTMLElement) {
      prevFocus.current.focus()
      prevFocus.current = null
    }
  }, [open])

  // Esc 关闭（busy 时禁用；走 backdropClose ?? onCancel）
  useEffect(() => {
    if (!open || busy) return
    const close = backdropClose ?? onCancel
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, busy, backdropClose, onCancel])

  if (!open) return null

  const handleConfirm = (): void => {
    if (busy) return
    const result = onConfirm()
    if (result instanceof Promise) {
      setSelfBusy(true)
      void result.finally(() => { setSelfBusy(false) })
    }
  }

  return (
    <div
      className={css.dialogMask}
      onMouseDown={(e) => {
        // 仅遮罩自身点击关闭（目标 === 当前遮罩，卡片内的点击不冒泡关闭）；
        // 走 backdropClose ?? onCancel（busy 时禁用）
        if (e.target === e.currentTarget && !busy) handleBackdropClose()
      }}
    >
      <div className={css.dialogCard} role="dialog" aria-modal="true" aria-label={title}>
        <div className={css.dialogHeader}>{title}</div>
        <div className={css.dialogBody}>
          {message !== undefined && message !== '' && <div>{message}</div>}
          {children}
        </div>
        <div className={css.actionRow}>
          <Button
            variant={danger === true ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => { void handleConfirm() }}
          >
            {busy ? '…' : (confirmLabel ?? '')}
          </Button>
          {/* 取消按钮用原生 button + ghostButton 类（样式与 Button ghost 一致），以便 ref 聚焦 */}
          <button
            ref={cancelRef}
            type="button"
            className={css.ghostButton}
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel ?? ''}
          </button>
        </div>
      </div>
    </div>
  )
}
