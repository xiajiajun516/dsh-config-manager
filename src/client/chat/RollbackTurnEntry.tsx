/**
 * 聊天回合尾的回退入口 —— `conversation.chat.turnTail`（ui-chat 的 list 位）的一个条目。
 *
 * 两个入口的**互斥**分工（同一份偏好驱动，`chat-entry-pref.ts` 是唯一真相）：
 *  · **每条用户消息档（缺省）** = 只注册 `conversation.chat.node` 的 `user` key（priority -1，
 *    每条用户消息一颗 **icon** 入口），本组件**一次都不注册** —— 见
 *    `rollback-entry-view.ts` 的 `planChatEntryRegistrationForMode`（2026-10-10 用户第二条要求：
 *    「回退按钮只有一个 icon 而不是一个按钮」；旧行为是两处同时注册 ⇒ 同屏两颗入口）。
 *  · **整回合档** = 完全不接管 user（宿主 UserMessageNodeView 原样渲染），入口只有本组件这一颗。
 *
 * 外观：**只画图标，没有文字标签、没有边框**（复用 `css.chatActionBtn`，与复制图标同一个观感与
 * 同一个 24px 触达区）。可见文案退到 `aria-label` / `title`（无障碍与悬浮提示都要能读到
 * 「回退到第 N 回合之前」），屏幕上不出现任何文字按钮。
 *
 * 两条路径打开的是**同一个**预览对话框（`RollbackReviewDialog.tsx`），判定层共用
 * `rollback-entry-view.ts`；组件的全部判定都在那里（node 可测）。
 *
 * 图标：规格里的「↺」是这条入口的视觉代号，但本仓库 DESIGN.md §9 反模式 #9 与 AGENTS.md
 * 明令**不得拿手写文本符号当图标**（字体宽度/基线跨平台漂移），图标只有一个出口
 * `common/Icon.tsx`；故这里用既有语义图标 `refresh`（lucide rotate-cw）承载同一「回到之前」
 * 语义。`icon-layer-guard.test.ts` 也据此为绿。
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackPointPort } from '../../ui/rollback-view.ts'
import { RefreshIcon } from '../common/Icon.tsx'
import { RollbackReviewDialog } from './RollbackReviewDialog.tsx'
import type { RollbackDiffOpenResult } from './rollback-diff-tab.ts'
import { entryVisibleForTurn, type ArchiveOutcome, type ChildOpenState } from './rollback-entry-view.ts'
// 槽位契约的类型镜像（SlotMap / SessionStandardProps 声明合并），见该文件头部说明。
import type {} from './chat-slots.ts'
import css from '../config-manager.module.css'

/** 本条目经 inject 面拿到的业务能力（端口 + 回退词汇翻译器 + 子会话导航）。 */
export interface RollbackTurnEntryInjected {
  /** 回退端口（RecoveryApi 实现；组件**不直接 fetch**）。 */
  port: RollbackPointPort
  /** recovery 字典（rollback.* 词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** 打开 fork 出来的子会话；返回 opened/degraded/unavailable，降级必须如实呈现。 */
  openChildSession: (childId: string) => Promise<ChildOpenState>
  /** A（无感替换）：回退后把原会话收进「已归档」（失败结构化返回，绝不抛）。 */
  archiveParentSession: (sessionId: string) => Promise<ArchiveOutcome>
  /** 第一条消息之前没有可 fork 的边界：开一条全新会话（uiWorkspace.startSession 同一条路）。 */
  startFreshSession: () => Promise<{ ok: true } | { ok: false; code: string }>
  /**
   * 「查看」：把该文件的差异开进 DSH 右侧栏（装配点注入）。侧栏不可用时返回 no-sidebar，
   * 由预览对话框如实降级为弹窗内展示 —— 绝不给一个点了没反应的入口。
   */
  openDiff: (pointId: string, filePath: string) => RollbackDiffOpenResult
}

/** 完整 props：owner props（turn/seq/openFile）+ session 标准 props + 本插件字典 + inject 面。 */
export type RollbackTurnEntryProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'config-manager-chat'> & RollbackTurnEntryInjected

/**
 * 一个回合尾的 icon 入口 + 它点开的预览对话框。
 * 只在**已收尾**的回合出现（`entryVisibleForTurn`）：正在跑的回合还没有回滚点。
 */
export function RollbackTurnEntry({ turn, sessionId, t, port, rt, openChildSession, archiveParentSession, startFreshSession, openDiff }: RollbackTurnEntryProps) {
  const [open, setOpen] = useState(false)
  if (!entryVisibleForTurn(turn)) return null
  return (
    <>
      <button
        type="button"
        className={css.chatActionBtn}
        aria-label={rt('rollback.preview.turns', { n: turn.turn })}
        title={rt('rollback.preview.turns', { n: turn.turn })}
        onClick={() => { setOpen(true) }}
      >
        <RefreshIcon size={13} />
      </button>
      {open && (
        <RollbackReviewDialog
          sessionId={sessionId}
          turn={turn.turn}
          port={port}
          rt={rt}
          t={t}
          openChildSession={openChildSession}
          archiveParentSession={archiveParentSession}
          startFreshSession={startFreshSession}
          openDiff={openDiff}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}
