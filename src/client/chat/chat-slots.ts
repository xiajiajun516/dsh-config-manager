/**
 * ui-chat 聊天槽位在本仓库的**类型镜像**（SlotMap / SessionStandardProps 声明合并）。
 *
 * 为什么需要这个文件：`conversation.chat.turnTail` 与 session 标准 props 的真实声明属于
 * `@deepseek-ai/dsh-client-ui-chat`（+ `dsh-client-ui-session`），而本仓库的依赖里**没有**它们
 * （package.json 的 @deepseek-ai 只有 cordis / client-runtime / client-locale / ui-settings / ui-slots）。
 * 不镜像就类型不过：ui-slots 的 `SlotMap` 只是个空合并点，`ctx.slots.register({ name })` 的 K
 * 必须落在 SlotMap 里。
 *
 * 镜像来源（**逐条核过，不是猜的**，DSH 自带 slot 目录 =
 * `packages/client/ui-chat/src/client/contract/slots.ts`）：
 *
 *   key: 'conversation.chat.turnTail'
 *   kind: 'list' · scope: 'session'
 *   summary: "Ordered feature contributions before a completed Turn's action row."
 *   doc:     "Each entry receives the Turn, closing sequence, and file opener.
 *             A fresh id adds an entry; entries without content return null."
 *   ownerProps: { turn: TurnLocation; seq: number; openFile: (path: string) => void }
 *   registerOptions: id(必填) / order(可选) / label(可选)
 *   standardProps（session scope）含 `sessionId: SessionId`（由 ui-session 注入）
 *   replaceRisk: 'none'（list 位：新 id 只会**追加**一个条目，不遮蔽任何 shipped UI）
 *
 * 已知的既有占用者（DSH 自身的插件，供对照）：ui-deliverables 的 DeliverablesTail、
 * ui-plan 的 PlanCards、ui-schedule 的 ScheduleTurnCard —— 三者都用各自的 id 追加。
 *
 * 风险与出路：若将来本仓库安装了 ui-chat / ui-session 的类型，同一键若形状不同会以
 * **TS2717（重复声明类型不一致）**报错 —— 那是响亮失败而不是静默错用；届时删掉本文件里
 * 对应的那一条即可（组件 props 的推导全部走 SlotMap，无需改组件）。
 *
 * 为什么**不**去接管 `conversation.chat.node` 的 `user` key（priority -1，把按钮做进每条用户消息）：
 *  · 那个槽位是 keyed 位，priority -1 会**遮蔽 shipped 的 UserMessageNodeView** —— 想让按钮和原文
 *    同时出现，就必须把宿主那条消息渲染器（markdown / 图片 / 文件提及 / hover 动作，含它自己的
 *    CSS Modules）整段复制进本仓库；这是把上游 UI 抄一份的维护债，且必然与既有观感分叉。
 *  · 语义也不对：本功能的留点单位是**回合**（S1「每个回合结束留一个点」），回合尾才是它的位置。
 *  因此选型结果 = 回合尾 list 位（整回合一个入口），这条选择与后果写进 T4 的 output。
 *
 * ## 版本差异（T9-F2 的真机证据；登记处据此做形态探测）
 *
 * 同一个 key 在两个版本的契约**不是一个形态**（实测两份安装树）：
 *  · DSH 0.2.0-rc.2（本机 app.asar）：`kind: 'list'`，ownerProps `{turn, seq, openFile}`，
 *    registerOptions `id` 必填 + `order`，replaceRisk `none`；
 *  · DSH 0.1.5-rc.2（隔离实例 `~/.dsh/profiles/node_modules`）：
 *    `lib/types/client/contract/slots.d.ts:181-185` = `{ kind: 'chain'; scope: 'session'; owner: TurnTailOwnerProps }`
 *    —— chain 缺 `select` 会抛，按 list 形态（id/order）注册就会抛。
 *  本文件镜像的是 **0.2 的 list 契约**（组件 props 推导全走 SlotMap）；面向 0.1.x 的兼容靠
 *  `src/client/chat/rollback-entry-view.ts` 的 `planChatEntryRegistration`：探测到非 list 声明就**跳过注册**
 *  （失败软化，不拿本插件其余槽位与宿主启动去赌），并在 0.1.x 上如实地不提供聊天入口。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnLocation } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * ui-session 在真实程序里合并的 session 标准 props；本仓库未安装该包，这里只镜像组件真正用到的
   * 那一个席位（会话 id）。`SessionIdOf` 因此解析为 `string`（与运行时一致：会话 id 是字符串）。
   */
  interface SessionStandardProps {
    /** 当前槽位所属会话（session scope 的标准 seat）。 */
    sessionId: string
  }

  interface SlotMap {
    /**
     * 回合尾追加位（list / session）：在回合收尾正文之后、动作行之前渲染。
     * 条目拿到的 owner props 与 ui-chat 的
     * `renderSlot('conversation.chat.turnTail', { turn, seq, openFile })` 逐字对齐。
     */
    'conversation.chat.turnTail': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** 该条回合尾所属的回合（`status === 'closed'` 才算收尾）。 */
        turn: TurnLocation
        /** 收尾节点的序号。 */
        seq: number
        /** 宿主提供的文件打开器（本插件不消费，保持契约完整）。 */
        openFile: (path: string) => void
      }
    }
  }
}
