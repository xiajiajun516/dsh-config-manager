/**
 * 自定义下拉（Select）—— 替换原生 <select> 的唯一出口。
 *
 * 为什么自绘：原生 <select> 的外观由**浏览器**渲染（appearance: none 只能改触发器，
 * 展开后的弹层仍是系统控件），在深色主题下是亮底系统菜单，与工作台其余控件不属于同一套
 * 视觉语言；且它无法使用 --dsw-* token（DESIGN.md §3 硬约束：颜色/字体/阴影必走 token）。
 * 因此这里用 button + div 自绘，并自己承担原生控件原本免费提供的：
 *   - 键盘语义（↑/↓ 移动、Home/End、Enter/Space 提交、Esc 关闭、Tab 关闭）；
 *   - 无障碍角色（combobox + listbox + option，aria-expanded / aria-activedescendant /
 *     aria-selected / aria-disabled）；
 *   - 点击外部关闭、禁用项跳过、值失效时的显示回退。
 *
 * 可测的那部分在 src/ui/：高亮项推导与移动 = select-model.ts，弹层放置（上下翻转 / 左右夹紧 /
 * 限高）= menu-placement.ts（均有 node 单测）—— 本文件**只做量测与装配**
 * （与仓库「逻辑在 src/ui、React 壳只装配」的分层铁律一致）。
 *
 * 弹层位置（2026-10-04 用户两轮反馈「被裁掉一截」→「位置偏移 / 选项点不动」后定稿）：
 *   ① **portal 进弹层容器**：弹窗内 → 弹窗卡片（Modal.tsx 的 data-cm-dialog）；否则 → 插件根容器
 *      （resolveModalRoot()）。为什么弹窗内**必须**进卡片（radix 源码实证，见下 resolveMenuHost）：
 *      卡片外的菜单会继承 body 的 pointer-events: none（点不动）、被 radix 当成「点了弹窗外」
 *      （弹窗直接关掉）、且滚不动（RemoveScroll 只放行内容子树）；
 *   ② **absolute + 容器相对坐标**：菜单就挂在容器里绝对定位，坐标 = 触发器矩形 − 容器矩形
 *      （含 clientLeft/clientTop，1px 描边不会变成偏移）。容器自带 overflow 的场合（插件画布
 *      .section）靠 placement 夹紧保证不越界 —— 所以既不裁剪、也不“飘”；
 *   ③ **先量后置**：打开后在同一帧的 layout effect 里解析容器、量触发器与菜单，写入最终坐标
 *      （下方放不下且上方更宽裕 → 向上翻转；左右越界 → 右对齐后夹紧；空间不足 → 限高内滚）；
 *      量测完成前靠 [data-ready] 不绘制，因此第一帧就在最终位置，不会「先闪一下再跳」。
 *      打开期间跟随滚动 / 缩放重新放置（夹紧基准与 Modal 的浮层同源）。
 *
 * 两条实现约束：
 *   ① 高亮滚动**只动菜单自身**（禁止 scrollIntoView）—— 见下方 effect 的说明；
 *   ② Esc 必须 stopPropagation —— 它可能位于 Radix 弹窗 / 侧滑面板内，冒泡出去会连带
 *      关掉整个弹窗或面板。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { resolveModalRoot } from './Modal.tsx'
import { canvasBounds } from './floating-bounds.ts'
import {
  edgeActiveIndex, initialActiveIndex, selectDisplayLabel, stepActiveIndex,
  type SelectOption,
} from '../../ui/select-model.ts'
import { MENU_GAP, MENU_MAX_HEIGHT, placeMenu, type MenuPlacement } from '../../ui/menu-placement.ts'
import { ChevronDownIcon } from './Icon.tsx'
import css from '../config-manager.module.css'

export type { SelectOption }

/** 触发器 / 菜单矩形的快照（只留放置需要的字段，避免把 DOMRect 放进 state）。 */
interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function boxOf(rect: DOMRect): Box {
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
  }
}

/** 位置没变就不写 state（跟随滚动时每帧都会量一次，避免无谓重渲染）。 */
function sameBox(a: Box, b: Box): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
    && a.width === b.width && a.height === b.height
}

/**
 * 弹层容器：**弹窗内 = 我们自己的弹窗卡片**（`data-cm-dialog`，见 Modal.tsx），
 * 否则 = 插件根容器（`.section`）。
 *
 * 为什么弹窗内必须进卡片（2026-10-04 用户反馈「选项点不动」+「位置偏移」，radix 源码实证）：
 *   ① **指针事件**：@radix-ui/react-dismissable-layer 在弹窗打开时执行
 *      `body.style.pointerEvents = "none"`，只给自己那一层（Dialog.Content）写回 `auto` ——
 *      挂在卡片外的菜单会继承 none，**整个弹层收不到任何指针事件**（点不动、无 hover 高亮）；
 *   ② **外部交互**：卡片外的元素在 radix 眼里就是「点到了弹窗外」，会顺手把弹窗关掉；
 *   ③ **滚动锁**：radix 的 RemoveScroll 只放行内容子树（shards=[contentRef]）——
 *      卡片外的菜单连自己的长清单都滚不动；
 *   ④ **坐标基准**：卡片是 `position: fixed` 且相对**浏览器窗口**居中，而插件画布（`.section`）
 *      在宿主设置弹窗里靠右；若把「画布」当夹紧基准，卡片左半边的菜单会被整块推进画布 ——
 *      用户截图的「偏移」正是这个（触发器在 x≈18，菜单被推到画布左缘 + 8 ≈ 185）。
 * 进卡片后菜单的包含块就是卡片（包含块链不经过 `.section` ⇒ 不会被画布的 overflow 裁剪），
 * 夹紧基准相应改用**视口**。
 */
function resolveMenuHost(trigger: HTMLElement): { el: HTMLElement; dialog: boolean } | null {
  const dialog = trigger.closest('[data-cm-dialog]')
  if (dialog instanceof HTMLElement) return { el: dialog, dialog: true }
  const root = resolveModalRoot()
  return root === null ? null : { el: root, dialog: false }
}

/** 视口矩形（弹窗内菜单的夹紧基准：卡片没有 overflow，菜单越出卡片是正常浮层行为）。 */
function viewportBounds(): { left: number; top: number; right: number; bottom: number } {
  const el = document.documentElement
  return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight }
}

export interface SelectProps {
  /** 当前值（字符串；数字枚举在调用点转换） */
  value: string
  options: SelectOption[]
  /** 选择变化（仅在实际变化时触发；重复选择同值不回调） */
  onChange: (value: string) => void
  /** 无障碍名（无可见 label 挂在本控件上时必填） */
  ariaLabel?: string
  disabled?: boolean
  /**
   * 当前值不在 options 里时触发器显示的文案（如「手动填写地址」）。
   *
   * 不传时保持既有语义：显示原值本身。传了空串同样走原值 —— 显式区分「没给占位」与「占位是空」，
   * 免得调用方想表达「什么都没有」却拿到一个看起来没选中的控件。
   */
  placeholder?: string
  title?: string
  className?: string
  style?: CSSProperties
  /**
   * 展开时回调。原生 select 靠 onFocus/onMouseDown/onClick 触发惰性加载的地方
   * （同步页「选择历史快照」），改为在这里触发 —— 一次展开只拉一次，语义更准。
   */
  onOpen?: () => void
}


export function Select(props: SelectProps) {
  const { value, options, onChange, ariaLabel, disabled = false, placeholder, title, className, style, onOpen } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  /** 弹层容器（解析见 resolveMenuHost）；null = 未解析 / 不可用 → 不渲染菜单。 */
  const [host, setHost] = useState<{ el: HTMLElement; dialog: boolean } | null>(null)
  /** 触发器矩形（**容器相对坐标**）：菜单的锚点，也是 min-width / 预排位置的来源。 */
  const [anchor, setAnchor] = useState<Box | null>(null)
  /** 放置结果（同样是容器相对坐标）；null = 菜单尺寸还没量到（此时靠 [data-ready] 不绘制）。 */
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const label = selectDisplayLabel(options, value, placeholder ?? '')

  const close = (refocus: boolean): void => {
    setOpen(false)
    setActive(-1)
    if (refocus) rootRef.current?.querySelector('button')?.focus()
  }

  const openMenu = (): void => {
    if (disabled || open) return
    setActive(initialActiveIndex(options, value))
    setOpen(true)
    onOpen?.()
  }

  /** 高亮项提交：禁用项与越界索引都不动，其余写回并关闭。 */
  const commit = (index: number): void => {
    const option = options[index]
    if (option === undefined || option.disabled === true) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  /**
   * 量测 + 放置（打开后、绘制前调用；打开期间跟随滚动 / 缩放也走它）。
   * 菜单还没挂载时只解析容器 + 记锚点 —— 菜单挂载后的那次调用再量尺寸并落位
   * （两帧都在绘制之前完成，所以不会看到中间态）。
   */
  const reposition = useCallback((): void => {
    const trigger = rootRef.current
    if (trigger === null) return
    const nextHost = resolveMenuHost(trigger)
    if (nextHost === null) { setHost(null); setAnchor(null); setPlacement(null); return }
    setHost((prev) => (prev !== null && prev.el === nextHost.el && prev.dialog === nextHost.dialog ? prev : nextHost))
    // 绝对定位的包含块是容器的**内边距框**：算上描边，1px 卡片边框才不会变成偏移。
    const rect = nextHost.el.getBoundingClientRect()
    const originX = rect.left + nextHost.el.clientLeft
    const originY = rect.top + nextHost.el.clientTop
    const next = boxOf(trigger.getBoundingClientRect())
    const anchor: Box = {
      left: next.left - originX, top: next.top - originY,
      right: next.right - originX, bottom: next.bottom - originY,
      width: next.width, height: next.height,
    }
    setAnchor((prev) => (prev !== null && sameBox(prev, anchor) ? prev : anchor))
    const menu = listRef.current
    if (menu === null) { setPlacement(null); return }
    const size = boxOf(menu.getBoundingClientRect())
    const bounds = nextHost.dialog ? viewportBounds() : canvasBounds()
    const placed = placeMenu(anchor, {
      left: bounds.left - originX, top: bounds.top - originY,
      right: bounds.right - originX, bottom: bounds.bottom - originY,
    }, { width: size.width, height: size.height })
    setPlacement((prev) => (prev !== null && prev.top === placed.top && prev.left === placed.left
      && prev.side === placed.side && prev.maxHeight === placed.maxHeight ? prev : placed))
  }, [])

  // 打开：先解析容器 + 记锚点（这一帧菜单还没挂载）；关闭：清空，下次打开重新量
  useLayoutEffect(() => {
    if (!open) { setHost(null); setAnchor(null); setPlacement(null); return }
    reposition()
  }, [open, reposition, options.length])

  // 菜单挂载后（同一帧、绘制之前）量尺寸并落位：第一帧就是最终位置，不出现「先闪一下再跳」
  useLayoutEffect(() => {
    if (!open || anchor === null || placement !== null) return
    reposition()
  }, [open, anchor, placement, reposition])

  // 点击外部关闭：监听 mousedown（比 click 早，且能覆盖右键/拖拽结束）。
  // **菜单自身必须放行**：弹层是 portal 出去的，不在 rootRef 的 DOM 子树里 ——
  // 少这一条会在 mousedown 时就把菜单卸掉，随后的 click 落不到选项上（选了没反应）。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current
      const menu = listRef.current
      if (!(event.target instanceof Node)) return
      if (root !== null && root.contains(event.target)) return
      if (menu !== null && menu.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  // 打开期间跟随滚动 / 缩放重新放置：fixed / 绝对定位的浮层都不随内容滚动，必须自己跟
  useEffect(() => {
    if (!open) return
    const onMove = (): void => { reposition() }
    window.addEventListener('resize', onMove)
    // 捕获阶段：插件在宿主设置弹窗内，滚动往往发生在外层容器而不是 window
    document.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      document.removeEventListener('scroll', onMove, true)
    }
  }, [open, reposition])

  // 键盘 / 悬停移动高亮后，把高亮项滚进**菜单自身**的可视区（长清单：24 小时 / 快照列表）。
  //
  // **禁止 scrollIntoView**：它会连带滚动元素的所有可滚动祖先。菜单虽然 portal 到弹层容器，
  // 但插件画布（.section）的 overflow: hidden **同样是可滚动盒**，它之上还有宿主的滚动容器与
  // 浏览器窗口 —— headless Chromium 实测：对一个靠下的选项调用 scrollIntoView 会同时把插件根容器
  // 与窗口滚走（真机表现：「选历史快照时整页跳走」）。这里只改菜单自己的 scrollTop，绝不触碰任何祖先。
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
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        if (!open) {
          setActive(initialActiveIndex(options, value))
          setOpen(true)
          onOpen?.()
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
        // 必须吞掉：外层可能是 radix 弹窗 / 侧滑面板，冒泡会把它们一起关掉
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
      className={className === undefined ? css.selectRoot : css.selectRoot + ' ' + className}
      style={style}
      data-open={open ? '' : undefined}
    >
      <button
        type="button"
        className={css.selectTrigger}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? listId + '-opt-' + active : undefined}
        aria-label={ariaLabel}
        title={title ?? (label !== '' ? label : undefined)}
        disabled={disabled}
        onClick={() => { if (open) close(false); else openMenu() }}
        onKeyDown={onKeyDown}
      >
        <span className={css.selectLabel}>{label}</span>
        <ChevronDownIcon size={13} className={css.selectChevron} />
      </button>
      {/* 弹层 portal 到 resolveMenuHost() 给的容器（弹窗内 = 弹窗卡片，否则 = 插件根容器）：
          容器内绝对定位 ⇒ 不被 .dialogBody / .section 裁剪，也不违背 radix 的指针事件与滚动锁。
          量到尺寸前 [data-ready] 缺省 → CSS 里 visibility: hidden，不会画出未定位的那一帧。 */}
      {open && host !== null && anchor !== null && createPortal(
        <div
          ref={listRef}
          id={listId}
          className={css.selectMenu + ' ' + css.selectMenuPortal}
          role="listbox"
          aria-label={ariaLabel}
          data-ready={placement === null ? undefined : ''}
          // px 必写：React 不给 top/left 补单位，浏览器会丢弃无单位的声明。
          style={{
            left: (placement === null ? anchor.left : placement.left) + 'px',
            top: (placement === null ? anchor.bottom + MENU_GAP : placement.top) + 'px',
            minWidth: anchor.width + 'px',
            maxHeight: (placement === null ? MENU_MAX_HEIGHT : placement.maxHeight) + 'px',
          }}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={listId + '-opt-' + index}
              className={css.selectOption}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled === true ? true : undefined}
              data-active={index === active ? '' : undefined}
              data-disabled={option.disabled === true ? '' : undefined}
              title={option.label}
              onMouseEnter={() => { if (option.disabled !== true) setActive(index) }}
              // mousedown 先于 blur：阻止默认行为，避免触发器的焦点在提交前丢失
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { commit(index) }}
            >
              <span className={css.selectOptionLabel}>{option.label}</span>
            </div>
          ))}
        </div>,
        host.el,
      )}
    </div>
  )
}
