/**
 * 命令面板（UI v2 §5.3）—— 壳层的第二入口，`⌘/Ctrl+K` 打开。
 *
 * 为什么需要它：v2 把一级导航从「功能目录」降级为「最常去的地方」，其余靠这里直达。
 * 于是**增一个功能 = 在 `src/ui/commands.ts` 注册一条命令**，而不是再挤一个页签进 564px 的导航条
 * —— 导航条溢出问题因此从根上消失，而不是被「更多 ▾」缓解。
 *
 * 分层：过滤/排序/可用性判定**全部**在 `src/ui/commands.ts`（node 单测覆盖），本文件只装配。
 * 键盘高亮复用 `ui/select-model.ts` 的 step/edge（跳过 disabled + 环绕），与 Select 同一套行为。
 *
 * 弹窗容器走 `common/Modal.tsx`（Radix Dialog）：自动获得 focus trap、Esc、遮罩点击关闭，
 * 以及 **Portal 指回 #dsh-config-manager-root** 这条硬约束（挂 document.body 会被宿主
 * overlay(z-index:1000) 盖成隐形弹窗）。所以这里一行弹窗管道都不用自己写。
 */
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  COMMAND_GROUP_ORDER, filterCommands,
  type CommandContext, type CommandGroup, type CommandItem, type CommandMatch,
} from '../../ui/commands.ts'
import { edgeActiveIndex, stepActiveIndex, type SelectOption } from '../../ui/select-model.ts'
import { Modal } from './Modal.tsx'
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: readonly CommandItem[]
  /** 可用性上下文（由壳层从 runStore 现算） */
  ctx: CommandContext
  /** 执行一条命令（壳层负责它到底做什么，本组件不碰 store） */
  onRun: (id: string) => void
  t: TranslateNS<'config-manager'>
}

export function CommandPalette({ open, onClose, commands, ctx, onRun, t }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)

  const titleOf = (key: Parameters<typeof t>[0]): string => t(key)
  const matches: CommandMatch[] = filterCommands(commands, query, titleOf, ctx)
  const grouped = query.trim() === ''

  /**
   * 渲染顺序 = 高亮顺序，两者必须是同一个数组，否则方向键会跳得莫名其妙。
   * 空查询按分组重排（声明顺序不保证已经按组聚集）；有查询时保持相关度排序的平铺结果。
   */
  const ordered: CommandMatch[] = grouped
    ? COMMAND_GROUP_ORDER.flatMap((group) => matches.filter((m) => m.item.group === group))
    : matches

  const options: SelectOption[] = ordered.map((m) => ({ value: m.item.id, label: titleOf(m.item.titleKey), disabled: m.disabled }))
  const safeActive = ordered.length === 0 ? -1 : Math.max(0, Math.min(active, ordered.length - 1))

  /**
   * 每次打开都回到干净状态。面板组件是**常驻**的（只有 Radix 的内容层随开关卸载），
   * 所以 query / 高亮会从上次开面板带过来 —— 用户重开时看到的是上次的过滤结果，
   * 会以为「选项不见了」。这里显式复位（关闭时不动，避免关到一半闪烁）。
   */
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
  }, [open])

  /**
   * 高亮必须**滚进可视区**：列表限高 280px（约 10 行），命令条数多于这个窗口时，
   * 光靠 ↑↓ 会把高亮移到看不见的位置 —— 对用户来说与「键盘坏了」没有区别。
   */
  useEffect(() => {
    if (!open || safeActive < 0) return
    document.getElementById(`${listId}-opt-${safeActive}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, safeActive, listId])

  const runAt = (index: number): void => {
    const hit = ordered[index]
    if (hit === undefined || hit.disabled) return
    onRun(hit.item.id)
    onClose()
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        // options 可能全 disabled；stepActiveIndex 会返回 -1，此时保持原高亮
        const next = stepActiveIndex(options, safeActive, event.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0) setActive(next)
        return
      }
      case 'Home':
      case 'End': {
        event.preventDefault()
        const next = edgeActiveIndex(options, event.key === 'Home' ? 'first' : 'last')
        if (next >= 0) setActive(next)
        return
      }
      case 'Enter': {
        event.preventDefault()
        runAt(safeActive)
        return
      }
      default:
        return
    }
  }

  const groupLabel = (group: CommandGroup): string => t(`palette.group.${group}`)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('palette.label')}
      wide
      cardStyle={{ maxHeight: 460 }}
      onOpenAutoFocus={(e) => {
        // 显式把初始焦点给输入框（Radix 默认落在第一个可聚焦元素上，这里指定更稳）
        e.preventDefault()
        inputRef.current?.focus()
      }}
    >
      <Modal.Body>
        <input
          ref={inputRef}
          className={css.paletteInput}
          type="text"
          value={query}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={safeActive >= 0 ? `${listId}-opt-${safeActive}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); setActive(0) }}
          onKeyDown={onInputKeyDown}
        />
        <div id={listId} className={css.paletteList} role="listbox" aria-label={t('palette.label')}>
          {ordered.length === 0 && <div className={css.paletteEmpty}>{t('palette.empty')}</div>}
          {ordered.map((hit, index) => (
            <Fragment key={hit.item.id}>
              {grouped && (index === 0 || ordered[index - 1]?.item.group !== hit.item.group) && (
                <div className={css.paletteGroup} role="presentation" data-first={index === 0 ? '' : undefined}>{groupLabel(hit.item.group)}</div>
              )}
              <div
                id={`${listId}-opt-${index}`}
                className={css.paletteItem}
                role="option"
                aria-selected={index === safeActive}
                aria-disabled={hit.disabled ? true : undefined}
                data-active={index === safeActive ? '' : undefined}
                data-disabled={hit.disabled ? '' : undefined}
                onMouseEnter={() => { setActive(index) }}
                onClick={() => { runAt(index) }}
              >
                <span className={css.paletteItemLabel}>{titleOf(hit.item.titleKey)}</span>
                {!grouped && <span className={css.paletteItemGroup}>{groupLabel(hit.item.group)}</span>}
              </div>
            </Fragment>
          ))}
        </div>
        <div className={css.paletteHint}>{t('palette.hint')}</div>
      </Modal.Body>
    </Modal>
  )
}
