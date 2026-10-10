/**
 * 聊天回合尾的「↺ 回退」入口 —— `conversation.chat.turnTail`（ui-chat 的 list 位）的一个条目。
 *
 * 选型依据（详见 chat-slots.ts 的头部注释；这里只留结论）：
 *  · 首选方案是接管 `conversation.chat.node` 的 `user` key（priority -1，按钮做进每条用户消息），
 *    实探结论 = **不可行**：那是 keyed 位的「遮蔽」语义（同 key 同 priority 直接抛，priority -1 会
 *    顶掉 shipped 的 UserMessageNodeView），要让按钮与原文同时出现就必须把宿主那条消息渲染器
 *    （markdown / 图片 / 文件提及 / hover 动作 + 它自己的 CSS Modules）整段复制进本仓库 ——
 *    上游 UI 抄一份的维护债，且必然与既有观感分叉。
 *  · 本功能的留点单位本来就是**回合**（S1），回合尾才是它的位置 → 退到
 *    `conversation.chat.turnTail`（整回合一个入口，追加新 id，replaceRisk: 'none'，不遮蔽任何 shipped UI）。
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
