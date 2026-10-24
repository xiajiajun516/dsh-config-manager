/**
 * 导航条溢出的「更多 ▾」菜单（UI v2 §5.6）。
 *
 * 由 `src/ui/nav-model.ts` 的 `navLayout` 判定「哪几个页签放不下」，壳层把那些项交给本组件。
 * **调用方负责判断**：`items.length === 0` 时不要渲染本组件（放得下就没有「更多」按钮）。
 *
 * 五条实现契约照抄 `common/Select.tsx`（同一种自绘弹层，不能有两套行为）：
 *   ① 弹层 absolute 留在原地、**不 portal** —— 本插件的 Radix 弹窗已经挂在
 *      #dsh-config-manager-root 内，再 portal 一次会引入第二套层叠上下文；
 *   ② **Esc 必须 stopPropagation** —— 它可能位于 Radix 弹窗 / 侧滑面板内，冒泡会把它们一起关掉；
 *   ③ 点击外部关闭监听 mousedown（比 click 早，且覆盖右键与拖拽结束）；
 *   ④ 高亮移动复用 `ui/select-model.ts`（已有 node 单测），本文件只装配；
 *   ⑤ **高亮项滚动只动菜单自身**（禁止 `scrollIntoView`）—— 与 Select 同一条教训（2026-10-03 真机
 *      「选快照时整页跳走」）：它会连带滚动所有可滚动祖先（`overflow: hidden` 的 .section 与窗口）。
 *
 * 与 Select 的两点差异：
 *   - 语义是菜单不是下拉：`aria-haspopup="menu"` + `role="menu"` + `role="menuitemradio"` + `aria-checked`；
 *   - 按钮外观与 `.navTab` 完全一致（见 CSS 的规则分组），并且**当前页在被隐藏的项里时按钮高亮**
 *     —— 否则用户看不出「我现在在哪一页」。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  edgeActiveIndex, initialActiveIndex, stepActiveIndex,
  type SelectOption,
} from '../../ui/select-model.ts'
import { ChevronDownIcon } from './Icon.tsx'
import { menuAlign } from './menu-align.ts'
import css from '../config-manager.module.css'

export interface MoreMenuItem {
  /** 页面 id（与 PanelId 一致） */
  id: string
  /** 已本地化的文案 */
  label: string
}

export interface MoreMenuProps {
  /** 被移出导航条的项（**至少一项**；为空时本组件不该被渲染） */
  items: MoreMenuItem[]
  /** 当前页 id：命中时按钮高亮，菜单里对应项标选中 */
  activeId: string
  onSelect: (id: string) => void
  /** 按钮与菜单的无障碍名（如「更多页面」） */
  label: string
  /**
   * 禁用整个入口（产物库行内动作进行中时，其余动作一律不可点 —— DESIGN §8.11）。
   * 禁用只拦行为、不换外观：行内的「在忙」提示由调用方另行渲染（那里换的是转圈 + 动作名），
   * 这里只负责「点不开、键盘也打不开」。
   */
  disabled?: boolean
}

export function MoreMenu({ items, activeId, onSelect, label, disabled = false }: MoreMenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [align, setAlign] = useState<'start' | 'end'>('start')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  const options: SelectOption[] = items.map((item) => ({ value: item.id, label: item.label }))
  /** 当前页在「更多」里：按钮必须高亮，否则导航条上找不到「我在哪」。 */
  const activeInOverflow = items.some((item) => item.id === activeId)

  const close = (refocus: boolean): void => {
    setOpen(false)
    setActive(-1)
    if (refocus) rootRef.current?.querySelector('button')?.focus()
  }

  const openMenu = (): void => {
    if (disabled) return
    setActive(initialActiveIndex(options, activeId))
    setAlign(menuAlign(rootRef.current))
    setOpen(true)
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    onSelect(option.value)
    close(true)
  }

  // 打开期间变为禁用（如同行另一个动作开始跑）：菜单必须收起，否则它悬空在禁用按钮上方
  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open])

  // 点击外部关闭：mousedown 比 click 早，且能覆盖右键与拖拽结束
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  // 键盘 / 悬停移动高亮后，把高亮项滚进**菜单自身**的可视区（页签多时菜单会超出一屏）。
  // 与 Select 逐字同源：**禁止 scrollIntoView**（它会连带滚走 .section 与窗口），只改菜单自己的 scrollTop。
  useEffect(() => {
    if (!open || active < 0) return
    const list = listRef.current
    const node = list?.querySelector<HTMLElement>('[data-active]')
    if (list === null || node === null || node === undefined) return
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [open, active])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    // 禁用态整块不响应键盘（按钮本身已 disabled，这是对「打开中突变为禁用」的兜底）
    if (disabled) return
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        if (!open) {
          setActive(initialActiveIndex(options, activeId))
          setAlign(menuAlign(rootRef.current))
          setOpen(true)
          return
        }
        setActive((current) => stepActiveIndex(options, current, delta))
        return
      }
      case 'Home':
      case 'End': {
        if (!open) return
        event.preventDefault()
        setActive(edgeActiveIndex(options, event.key === 'Home' ? 'first' : 'last'))
        return
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        if (!open) openMenu()
        else commit(active)
        return
      }
      case 'Escape': {
        if (!open) return
        // 必须吞掉：外层可能是 Radix 弹窗 / 侧滑面板，冒泡会把它们一起关掉
        event.stopPropagation()
        event.preventDefault()
        close(true)
        return
      }
      case 'Tab': {
        if (open) close(false)
        return
      }
      default:
        return
    }
  }

  return (
    <div
      ref={rootRef}
      // navMoreRoot 只做一件事：在 .navStrip 里 flex: none（.selectRoot 是可收缩的）
      className={`${css.selectRoot} ${css.navMoreRoot}`}
      data-open={open ? '' : undefined}
      data-align={align}
    >
      <button
        type="button"
        className={css.navMore}
        // 当前页被藏进「更多」时按钮高亮：与 .navTab[data-active] 同一套视觉
        data-active={activeInOverflow ? '' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => { if (disabled) return; if (open) close(false); else openMenu() }}
        onKeyDown={onKeyDown}
      >
        {label}
        <ChevronDownIcon size={12} className={css.selectChevron} />
      </button>
      {open && (
        <div ref={listRef} id={menuId} className={css.selectMenu} role="menu" aria-label={label}>
          {options.map((option, index) => (
            <div
              key={option.value}
              className={css.selectOption}
              role="menuitemradio"
              aria-checked={option.value === activeId}
              data-active={index === active ? '' : undefined}
              title={option.label}
              onMouseEnter={() => { setActive(index) }}
              // mousedown 先于 blur：阻止默认行为，避免触发器的焦点在提交前丢失
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { commit(index) }}
            >
              <span className={css.selectOptionLabel}>{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
