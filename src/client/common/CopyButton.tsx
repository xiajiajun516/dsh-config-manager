/**
 * 复制按钮（含「空闲 → 已复制」形变反馈）。
 *
 * 为什么抽成原语
 * -------------
 * 原先 `HomePanel` 与 `EnvironmentPanel`（当时叫 OverviewPanel / ProfilesPanel）各有一份**逐字重复**的 `copyText`（剪贴板 +
 * Toast 反馈），复制图标本身没有任何就地反馈 —— 用户只能看到一条飘过的 Toast，而按钮本身
 * 始终是「复制」图标。统一到这里之后：剪贴板调用、失败分支、计时复位、形变图标各只有一份。
 *
 * 交互与无障碍
 * ------------
 * - 成功才切「已复制」：失败分支（无 `navigator.clipboard` / 写入被拒）只出 Toast，图标不动 ——
 *   绝不给"看起来成功了"的假信号。
 * - **Toast 保留**：图标形变对读屏软件是不可见的（`aria-hidden`），Toast 才是那条可被播报的
 *   反馈；两者不是重复，是分别服务视觉与辅助技术。
 * - 可访问名恒为 `label`（不随复制态改变）：中途改可访问名会让读屏用户听到一个"新按钮"。
 * - 计时器用 `useRef` + 卸载清理（跟随 `market/MyConfigsView.tsx` 的既有写法）；连点会
 *   **重置**而不是叠加计时器，所以连点后不会提前复位。
 */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { toast } from './toast-store.ts'
import { CopyStateIcon } from './Icon.tsx'
import { hostIcon } from './host-primitives.ts'
import { copyTextToClipboard } from './clipboard.ts'
import css from '../config-manager.module.css'

/** 「已复制」对勾的停留时长（毫秒）。够读到一个对勾，又不至于让按钮长期停留在错误语义上。 */
export const COPY_FEEDBACK_MS = 1600

export interface CopyButtonProps {
  /** 要写入剪贴板的文本。 */
  text: string
  /** 可访问名（同时作 title）；图标按钮必须有它（DESIGN.md §9 #4）。 */
  label: string
  t: TranslateNS<'config-manager'>
}

export function CopyButton({ text, label, t }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载清理：计时器不能在组件消失后 setState
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  /** 切到「已复制」并在 COPY_FEEDBACK_MS 后复位；连点重置计时（不叠加）。 */
  const markCopied = (): void => {
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setCopied(false) }, COPY_FEEDBACK_MS)
  }

  const onClick = (): void => {
    // 剪贴板调用只在 common/clipboard.ts 里有一份实现（成功才切形变，失败只出 Toast）
    void copyTextToClipboard(text).then((ok) => {
      if (ok) {
        toast.ok(t('toast.copied'))
        markCopied()
      } else {
        toast.warn(t('toast.copyFailed'))
      }
    })
  }

  /**
   * 图标 = **对话（聊天）回退条用的那两颗宿主原生图**（2026-10-28 用户要求「复制图标统一替换成
   * 对话回退的复制 icon」）：`IconCopyOutlineRegular → IconCheckOutlineRegular` 的**瞬时换图**，
   * 与宿主 MessageIconActions / ChatEntryCopyAction 同一对、同一字形与描边重量。
   * 拿不到宿主图标的老宿主回落 morphicons 的 `CopyStateIcon`（绝不能变成空白按钮）。
   */
  const HostCopyIcon = hostIcon('IconCopyOutlineRegular')
  const HostCheckIcon = hostIcon('IconCheckOutlineRegular')

  return (
    <button
      type="button"
      className={css.copyBtn}
      aria-label={label}
      title={label}
      onClick={onClick}
      data-copy-state={copied ? 'copied' : 'idle'}
    >
      {HostCopyIcon !== null && HostCheckIcon !== null
        ? (copied ? <HostCheckIcon size={12} /> : <HostCopyIcon size={12} />)
        : <CopyStateIcon done={copied} size={12} />}
    </button>
  )
}
