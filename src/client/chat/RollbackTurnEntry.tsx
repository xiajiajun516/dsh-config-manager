/**
 * 聊天回合尾的「↺ 回退」入口 —— `conversation.chat.turnTail`（ui-chat 的 list 位）的一个条目。
 *
 * 两个入口的分工（两档由 T2 的面板开关切换；偏好读写见 `chat-entry-pref.ts`）：
 *  · **主入口（T1 已上线）**= 接管 `conversation.chat.node` 的 `user` key（priority -1，按钮内嵌到
 *    **每一条**用户消息），实现在 `ChatEntryView.tsx` + `chat-entry-view.ts`。这条路**是可行的**：
 *    keyed 位按 priority 升序取最低者渲染，宿主缺省 0 ⇒ 我们的 -1 遮蔽它（**同 key 同 priority 会抛**，
 *    所以 -1 是唯一合法并存值）；代价是那条气泡要自己复刻（宿主 UserStyleBubble / MessageIconActions /
 *    文件卡 / CSS Modules 全是 ui-chat 私有、不可导入），能力面对照表与三处已知差距见 T1 output §3。
 *    槽位声明、真机证据与版本差异详见 `chat-slots.ts` 的头部注释。
 *  · **本组件** = 偏好为「整回合」时的入口，同时也是主入口的**兜底路径**（偏好为「每条消息」时两个入口
 *    并存）：在 `conversation.chat.turnTail` 追加一个新 id（replaceRisk: 'none'，不遮蔽任何 shipped UI）。
 *    本功能的留点单位是**回合**（S1），回合尾这颗按钮的语义没变（回退这个回合）。
 *
 * 两条路径打开的是**同一个**复核对话框（`RollbackReviewDialog.tsx`），判定层共用
 * `rollback-entry-view.ts`。
 *
 * 组件的全部判定都在 `rollback-entry-view.ts`（node 可测）；这里只做装配与开关状态。
 *
 * 图标：规格里的「↺」是这条入口的视觉代号，但本仓库 DESIGN.md §9 反模式 #9 与 AGENTS.md
 * 明令**不得拿手写文本符号当图标**（字体宽度/基线跨平台漂移），图标只有一个出口
 * `common/Icon.tsx`；故这里用既有语义图标 `refresh`（lucide rotate-cw）承载同一「回到之前」
 * 语义，可见文案仍是字典里的「回退」。`icon-layer-guard.test.ts` 也据此为绿。
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackPointPort } from '../../ui/rollback-view.ts'
import { Button } from '../common/ui.tsx'
import { RefreshIcon } from '../common/Icon.tsx'
import { RollbackReviewDialog } from './RollbackReviewDialog.tsx'
import { entryVisibleForTurn, type ChildOpenState } from './rollback-entry-view.ts'
// 槽位契约的类型镜像（SlotMap / SessionStandardProps 声明合并），见该文件头部说明。
import type {} from './chat-slots.ts'

/** 本条目经 inject 面拿到的业务能力（端口 + 回退词汇翻译器 + 子会话导航）。 */
export interface RollbackTurnEntryInjected {
  /** 回退端口（T2 的 RecoveryApi 实现；组件**不直接 fetch**）。 */
  port: RollbackPointPort
  /** recovery 字典（rollback.* 词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** 打开 fork 出来的子会话；返回 opened/degraded/unavailable，降级必须如实呈现。 */
  openChildSession: (childId: string) => Promise<ChildOpenState>
}

/** 完整 props：owner props（turn/seq/openFile）+ session 标准 props + 本插件字典 + inject 面。 */
export type RollbackTurnEntryProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'config-manager-chat'> & RollbackTurnEntryInjected

/**
 * 一个回合尾按钮 + 它点开的复核对话框。
 * 只在**已收尾**的回合出现（`entryVisibleForTurn`）：正在跑的回合还没有回滚点。
 */
export function RollbackTurnEntry({ turn, sessionId, t, port, rt, openChildSession }: RollbackTurnEntryProps) {
  const [open, setOpen] = useState(false)
  if (!entryVisibleForTurn(turn)) return null
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        title={rt('rollback.preview.turns', { n: turn.turn })}
        onClick={() => { setOpen(true) }}
      >
        <RefreshIcon size={12} /> {t('chat.entry.label')}
      </Button>
      {open && (
        <RollbackReviewDialog
          sessionId={sessionId}
          turn={turn.turn}
          port={port}
          rt={rt}
          t={t}
          openChildSession={openChildSession}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}
