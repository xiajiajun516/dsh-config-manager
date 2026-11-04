/**
 * InfoHint —— 「说明性文案」的唯一承载体（ⓘ）。
 *
 * 分层规则（DESIGN.md §7「说明性文案分层」，逐字适用、不得自行扩大或缩小）：
 *   - **MOVE → ⓘ**：纯说明性文案（机制怎么工作 / 为什么这样设计 / 补充背景 / 边界与限制 /
 *     示例 / 省事提示）与输入规则类文案 —— 收进 `<InfoHint text={t('原键')} />`，删掉原来那行可见说明；
 *   - **KEEP 常驻**：校验错误 / 失败原因、安全与不可逆操作告警、状态与等待文本、
 *     禁用原因（title=）、空态解释、防截断 title=、SectionTitle 副标题与 css.cellMeta、
 *     ConfirmDialog/Modal 内的危险操作说明 —— 一律不动（渲染与文案逐字保持）。
 *
 * 交互四通道（缺一不可）：
 *   ① 鼠标悬停打开；② 键盘聚焦打开；③ 点击固定 / 再次点击取消固定；
 *   ④ **固定态下按下任意位置（触发按钮自身除外）= 取消固定并关闭**；Esc 关闭；
 *   鼠标移出且未固定时关闭（聚焦或固定期间不因移出而关）。
 *   第 ④ 条为什么必须有（2026-10-04 用户反馈）：点开后进入固定态，只有再点一次同一颗 ⓘ 才能退出 ——
 *   用户必须知道「同一颗图标既是开也是关」，与「点别处收起」的通用浮层预期不符。
 *   ② 的判据（2026-10-04 用户反馈「一进弹窗就自动选中 ⓘ」）：**只认用户自己把焦点移过来** ——
 *   Radix 弹窗挂载时会把初始焦点派给容器内第一个可聚焦元素（FocusScope 的 focusFirst），
 *   标题行的 ⓘ 常常正是它；那次聚焦的 relatedTarget 在弹窗之外（或为空），据此忽略（见 onFocus）。
 *
 * 为什么气泡不用原生 `title`：
 *   原生 title 不可换行 / 不可定制 / 触屏与键盘体验不一致，且无法做边界处理。
 *
 * 渲染位置（两条硬约束，t7 评审 high 的修复）：
 *   ① **必须经 `createPortal` 渲进插件根容器**（`resolveModalRoot()`，与 Modal 共用同一份实现、
 *      同一条铁律：`#dsh-config-manager-root`，**绝不挂 `document.body`** —— 会被宿主 overlay
 *      z-index:1000 盖住，并连带 body `pointer-events` 失效，本仓库有过实测事故）。
 *      为什么非 portal 不可：`.dialogContentCenter` 带常驻 `transform: translate(-50%,-50%)`，
 *      按 CSS Transforms L1 它成为后代 `position: fixed` 的**包含块** —— 裸 fixed 的气泡在 Modal 内
 *      会整体偏移「卡片在视口中的位移」，并被 `.dialogBody{overflow-y:auto}` 裁剪。
 *   ② 气泡 `position: fixed` 的坐标是**视口坐标**（插件根容器自身无 transform），量测后写入内联
 *      `top/left` —— 动态坐标无法用静态类表达，是本仓库「style 只允许极小修补」的正当例外
 *      （与 Select 的 data-align 同源）。
 *
 * 夹紧基准 = **宿主画布**（插件根容器 = 气泡的 Portal 容器的可见矩形），**不是浏览器视口**：
 *   下方空间不足且上方更宽裕 → 向上翻转；左右越界 → 先右对齐再夹进画布；
 *   容器拿不到（未挂载 / 尺寸为 0）时才回落到窗口矩形（兜底）。画布矩形恒与窗口取交集，
 *   因此既不出宿主画布、也不出浏览器视口（见 DESIGN.md §7）。
 *
 * 无障碍：触发元素是 `<button type="button">`（aria-label 取字典键 `common.infoHint`；
 * 传入 `t` 时随当前语言，缺省回落源语言字典值）；说明文本用 `aria-describedby` 关联，
 * 同一组件多实例的 id 由 `useId` 保证唯一。图标复用既有 `InfoIcon`（不新增图标、不新增依赖）。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TranslateNS } from '../client-types.ts'
import { zh } from '../locales.ts'
import { InfoIcon } from './Icon.tsx'
import { resolveModalRoot } from './Modal.tsx'
import { canvasBounds, clamp, VIEWPORT_EDGE } from './floating-bounds.ts'
import css from '../config-manager.module.css'

/** 气泡与触发按钮之间的间距（px；与 .infoHintBubble 的视觉间距一致）。 */
const BUBBLE_GAP = 6
/** 边缘安全边距（px）：气泡与基准矩形边缘至少留这么多，保证不出界。 */
// VIEWPORT_EDGE 与 clamp / canvasBounds 同源（floating-bounds.ts），不再本地各写一份

// clamp / canvasBounds 抽到 `floating-bounds.ts` —— Select 菜单需要**同一份**夹紧基准
// （两处各写一份必然分叉：Select 那次跑偏正是因为直接用了视口坐标）。

export interface InfoHintProps {
  /** 说明文本：自动折行（多行），显式换行符同样保留；**不用原生 title 承载**。 */
  text: string
  /**
   * 主字典翻译器（config-manager namespace）。传入时 aria-label 取当前语言的
   * `common.infoHint`；缺省回落源语言字典值（调用方手上有 t 时**应当**传入）。
   */
  t?: TranslateNS<'config-manager'>
  /** 覆盖可访问名（默认取字典键 common.infoHint）。 */
  label?: string
}

interface BubblePlacement {
  top: number
  left: number
  /** 实际放置方向：'bottom' = 按钮下方；'top' = 上下空间不足时向上翻转。 */
  side: 'top' | 'bottom'
}

export function InfoHint({ text, t, label }: InfoHintProps) {
  const reactId = useId()
  // React 的 useId 形如 ':r0:'，冒号在 IDREF 里合法但可读性差 —— 归一化成字母数字/下划线/连字符
  const bubbleId = 'cm-info-hint-' + reactId.replace(/[^a-zA-Z0-9_-]/g, '')
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  /** 悬停 / 聚焦各自记账：两条通道都可能独立成立（点击固定后再移出鼠标不得关闭）。 */
  const hoverRef = useRef(false)
  const focusRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [placement, setPlacement] = useState<BubblePlacement | null>(null)
  /**
   * Portal 容器（与 Modal 同一条铁律）：`#dsh-config-manager-root`，**绝不 `document.body`**。
   * 渲染期惰性取一次（按钮必然已在根节点内），再以 layout effect 兜底同一次 commit 的极端情况；
   * 容器未知时**不渲染气泡**（宁可晚一帧，也绝不裸 fixed 渲进 Modal children 子树 / 挂 body）。
   */
  const [container, setContainer] = useState<HTMLElement | null>(resolveModalRoot)
  useLayoutEffect(() => { setContainer(resolveModalRoot()) }, [])

  const ariaLabel = label ?? (t !== undefined ? t('common.infoHint') : zh['common.infoHint'])

  /** Esc：关闭并取消固定（键盘用户与鼠标用户同一出口）。 */
  const close = useCallback((): void => {
    setOpen(false)
    setPinned(false)
  }, [])

  /**
   * 量测并定位气泡（渲染后调用）。
   * 夹紧矩形 = `canvasBounds()`（宿主画布 ∩ 窗口，**不是窗口**）**∪ 锚点矩形**（只放宽、不收紧）——
   * 为什么并锚点：弹窗卡片是 position:fixed（相对浏览器窗口居中），会伸出画布左缘，见下方注释。
   * 水平：与按钮左缘对齐，右侧放不下改右对齐；垂直：下方优先，放不下且上方更宽裕则向上翻转。
   * 两端都夹进夹紧矩形，因此气泡既贴得住锚点、也不越出画布（见 DESIGN.md §7「气泡边界 = 宿主画布 ∪ 锚点」）。
   */
  const reposition = useCallback((): void => {
    const btn = btnRef.current
    const bubble = bubbleRef.current
    if (btn === null || bubble === null) return
    const anchor = btn.getBoundingClientRect()
    const box = bubble.getBoundingClientRect()
    const bounds = canvasBounds()
    // 夹紧矩形 = 画布 ∪ 锚点（**只放宽、不收紧**）：弹窗卡片是 position:fixed（相对浏览器窗口居中），
    // 而画布 = 插件根容器（在宿主设置弹窗里靠右，左边还有宿主导航），因此弹窗左半边的 ⓘ
    // 会比画布左缘更靠左；若仍严格夹进画布，气泡会被整体推进画布、与自己的 ⓘ 脱开
    // （2026-10-04 用户反馈「提示文字位置有偏移」）。并入锚点后气泡贴得住锚点，
    // 右侧 / 下方仍以画布为界（气泡不会因此跑出画布右缘或浏览器视口）。
    const clampBox = {
      left: Math.min(bounds.left, anchor.left),
      right: Math.max(bounds.right, anchor.right),
      top: Math.min(bounds.top, anchor.top),
      bottom: Math.max(bounds.bottom, anchor.bottom),
    }
    const minLeft = clampBox.left + VIEWPORT_EDGE
    const maxLeft = clampBox.right - VIEWPORT_EDGE - box.width
    const minTop = clampBox.top + VIEWPORT_EDGE
    const maxTop = clampBox.bottom - VIEWPORT_EDGE - box.height
    // 水平：与按钮左缘对齐；右侧放不下改右对齐，最后夹进夹紧矩形
    let left = anchor.left
    if (left + box.width > clampBox.right - VIEWPORT_EDGE) left = anchor.right - box.width
    left = clamp(left, minLeft, maxLeft)
    // 垂直：优先下方；下方不够且上方更宽裕 → 向上翻转；两端都夹紧
    const below = clampBox.bottom - anchor.bottom - BUBBLE_GAP
    const above = anchor.top - clampBox.top - BUBBLE_GAP
    const side: BubblePlacement['side'] = box.height > below && above > below ? 'top' : 'bottom'
    const rawTop = side === 'bottom' ? anchor.bottom + BUBBLE_GAP : anchor.top - BUBBLE_GAP - box.height
    const top = clamp(rawTop, minTop, maxTop)
    setPlacement({ top, left, side })
  }, [])

  // 打开后、绘制前量测（layout effect）：第一帧就落在正确位置，不出现「先闪一下再跳」
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    reposition()
  }, [open, reposition, text, container])

  // 打开期间跟随滚动 / 缩放重新定位（fixed 元素不会随内容滚动，必须自己跟）
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

  // Esc 关闭（悬停打开时焦点不在按钮上，仍须响应）；捕获 + stopPropagation 避免连带关掉外层 Modal / 侧滑面板
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, close])

  /**
   * 固定态下按下任意位置 = 取消固定并关闭（第 ④ 条通道；见文件头「交互四通道」）。
   * 为什么用 `mousedown`：与 Select 同源 —— 比 click 早，且右键 / 拖拽结束也算一次「点了别处」；
   * 为什么用**捕获阶段**：ⓘ 常位于 Radix 弹窗 / 侧滑面板内，捕获保证在局部 handler 吞掉事件之前处理，
   * 且这里**不** stopPropagation（外层该关的弹窗照常关）。
   * 触发按钮自身必须放行：它的 onClick 负责第 ③ 条「再次点击取消固定」，若在这里抢先关闭，
   * 按钮的第二次按下会先关再开 —— 固定态反而无法用点击退出。
   * 气泡自身不需要排除：`.infoHintBubble{pointer-events:none}`，它根本不接收指针事件。
   */
  useEffect(() => {
    if (!pinned) return
    const onMouseDown = (event: MouseEvent): void => {
      const btn = btnRef.current
      if (btn !== null && event.target instanceof Node && btn.contains(event.target)) return
      close()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => { document.removeEventListener('mousedown', onMouseDown, true) }
  }, [pinned, close])

  const onMouseEnter = (): void => { hoverRef.current = true; setOpen(true) }
  const onMouseLeave = (): void => {
    hoverRef.current = false
    if (!pinned && !focusRef.current) setOpen(false)
  }
  /**
   * 聚焦通道（第 ② 条）：**只认用户自己把焦点移过来**（2026-10-04 用户反馈）。
   * 为什么：Radix 的 FocusScope 在弹窗挂载时执行 focusFirst(...)，把初始焦点派给容器内第一个
   * 可聚焦元素；本插件的 ⓘ 常常正是标题行里的那一个 —— 于是「一进弹窗就自动弹出 ⓘ 气泡」。
   * 判据 = relatedTarget（聚焦前拿着焦点的元素）是否**在同一弹窗内**：
   *   · 弹窗初始焦点：relatedTarget 是弹窗外的触发器 / body / null → 忽略（**连焦点记账都不记**）；
   *   · 用户在弹窗内用 Tab 导航到 ⓘ：relatedTarget 必在同一 [role=dialog] 内 → 打开。
   * 非弹窗场景（没有 dialog 祖先）不做限制，行为与改动前一致。
   * 为什么程序化初始焦点连 focusRef 也不记：一旦记账，鼠标移出就不满足「未固定且未聚焦」，
   * 悬停一次后气泡会永久挂在屏幕上（只能靠 Esc / 点别处关）—— 这正是同一张截图里的观感。
   */
  const onFocus = (event: ReactFocusEvent<HTMLButtonElement>): void => {
    const dialog = event.currentTarget.closest('[role="dialog"]')
    if (dialog !== null) {
      const from = event.relatedTarget
      if (!(from instanceof Node) || !dialog.contains(from)) return
    }
    focusRef.current = true
    setOpen(true)
  }
  const onBlur = (): void => {
    focusRef.current = false
    if (!pinned && !hoverRef.current) setOpen(false)
  }
  /**
   * 点击 = 固定 / 取消固定；取消固定后仍悬停或仍聚焦则保持可见（悬停/聚焦通道本身仍成立）。
   *
   * **必须先 `preventDefault()`**（2026-11-04 用户反馈：悬停/点击选择框会连带作用到 ⓘ）：
   * ⓘ 常被放在 `<label>`（或 Checkbox 的 label 区）里，而「点击 label 区域 → 激活它包裹的表单
   * 控件」是**点击事件的默认行为**。不掐断它，点一下 ⓘ 就会顺手切掉一个勾选框 / 打开一个下拉。
   * `preventDefault()` 只取消这条默认行为，不影响本组件自己的固定态逻辑，也不影响捕获阶段的
   * 外部按下关闭（那是 mousedown，与此处无关）。
   */
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (pinned) {
      setPinned(false)
      setOpen(hoverRef.current || focusRef.current)
    } else {
      setPinned(true)
      setOpen(true)
    }
  }

  return (
    <span className={css.infoHint}>
      <button
        ref={btnRef}
        type="button"
        className={css.infoHintBtn}
        aria-label={ariaLabel}
        aria-describedby={open && container !== null ? bubbleId : undefined}
        data-open={open ? '' : undefined}
        data-pinned={pinned ? '' : undefined}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={onClick}
      >
        <InfoIcon size={13} />
      </button>
      {/* 气泡**必须**走 portal 渲到插件根容器（脱离 Modal 卡片的 transform 包含块与正文裁剪）：
          它不在本组件的 DOM 子树内，只经 id/aria-describedby 关联；容器未知时不渲染 */}
      {open && container !== null && createPortal(
        <span
          ref={bubbleRef}
          id={bubbleId}
          role="tooltip"
          className={css.infoHintBubble}
          data-side={placement === null ? undefined : placement.side}
          data-ready={placement === null ? undefined : ''}
          style={placement === null ? undefined : { top: placement.top + 'px', left: placement.left + 'px' }}
        >
          {text}
        </span>,
        container,
      )}
    </span>
  )
}
