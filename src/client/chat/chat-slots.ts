/**
 * ui-chat 聊天槽位在本仓库的**类型镜像**（SlotMap / SessionStandardProps 声明合并）。
 *
 * 为什么需要这个文件：`conversation.chat.node` 与 session 标准 props 的真实声明属于
 * `@deepseek-ai/dsh-client-ui-chat`（+ `dsh-client-ui-session`），而本仓库的依赖里**没有**它们
 * （package.json 的 @deepseek-ai 只有 cordis / client-runtime / client-locale / ui-settings / ui-slots）。
 * 不镜像就类型不过：ui-slots 的 `SlotMap` 只是个空合并点，`ctx.slots.register({ name })` 的 K 必须落在
 * SlotMap 里。
 *
 * ## 镜像来源（**逐条核过真机 app.asar，不是猜的**）
 *
 * 槽位声明 = `packages/client/ui-chat/src/client/contract/slots.ts`（整包只声明 8 个槽位：
 * conversation.chat.node / conversation.message.images / conversation.chat.commandview /
 * conversation.chat.turnTail / conversation.chat.assistant-actions / conversation.view /
 * conversation.composer.dock / conversation.approval.detail）。
 *
 * ### `conversation.chat.node`（本插件**接管**其 `user` key）
 *
 *   kind: 'keyed' · scope: 'session'
 *   ownerProps（ui-chat 0.2.1 起）: { groupPart?, cwd, openFile, openSkill, inspectCall, forkAt,
 *                 loadImage, fileMentions, turnProcess, node }
 *   ownerProps（≤ 0.2.0，本插件最初对齐的那一版）: 同上但带 `renderMessageImages`、无 `loadImage`
 *   registerOptions: key(必填) / priority(可选，= cell 遮蔽秩，升序、最低者渲染)
 *   replaceRisk: **有**（这是 keyed 遮蔽位：priority -1 会顶掉 shipped 的 UserMessageNodeView）
 *
 * ### 两个版本的正文契约（决定了 ChatEntryView.tsx 的两条渲染路径）
 *
 *  · **0.2.1 起**：owner 不再给 `renderMessageImages`（那是 `conversation.message.images` 的绑定），
 *    图片改由 ui-attachment 注册的 `conversation.chat.user.images` 位渲染；正文则通过框架标准 kit
 *    给每个 entry 的 `renderFactorySlot` 交给宿主自己的 `conversation.chat.user.content` 工厂
 *    （ui-chat `UserContent`，声明 `scope:'session'` + 子位 `conversation.chat.user.images`）。
 *    ⇒ 本插件**委托**这条工厂，只保留动作行（时间 / 复制 / 回退）；`options.fallback` 给老宿主用。
 *  · **≤ 0.2.0**：该工厂不存在（`renderFactorySlot` 的 outlet 回落到 `options.fallback`），
 *    由本插件的自绘气泡承担正文，图片走 owner 的 `renderMessageImages`。
 *  · 有工厂但没有 `loadImage` 且消息里有图：回到自绘气泡（图片仍走 `renderMessageImages`）。
 *  · 既没有工厂、也没有图片渲染位、消息里还有图：自绘气泡 + 如实提示（判据见 `planChatEntryContentMode`）。
 *
 * 关键事实（决定了本功能只能走这条路，见 T1 output 的证据段）：
 *  · 宿主对 `{ name:'conversation.chat.node', key:'user' }` **没有声明 children 表**
 *    （对比 turn-tail 节点声明了 turnTail + assistant-actions 两个 list 子位）
 *    ⇒ framework 没有「往每条用户消息里追加 UI」的位子；
 *  · 宿主把节点渲染成 `renderSlot('conversation.chat.node', routedOwner, { entryKey: kind, hookContext, fallback })`，
 *    `routedOwner` **没有 turn/seq** —— 回合号要从 `node.location` 取（宿主自己的 turnTail 就是
 *    `node.location.kind === 'turn' | 'step' ? node.location.turn : undefined`）。
 *
 * `keyProps.user` 只列我们真的读的字段（`renderMessageImages` / `node`）；这些字段在我们**接管**之后
 * 由我们自己消费（宿主的 UserMessageNodeView 用同一份）。其余 key（`steering` 等）不在 `keyProps` 里
 * ⇒ 它们的 props 是普通 owner 面 —— 本插件**不注册**它们，宿主的渲染器原样工作。
 *
 * ### `conversation.chat.turnTail`（本插件**不再注册**）
 *
 * 2026-10-12（用户要求「聊天内回退入口只有每条用户消息」）：回合尾那一颗入口连同它的「整回合」偏好档
 * 一起删除 —— 本文件因此**不再镜像**该槽位（没有人再对它 `register`，也没有组件 props 需要推导）。
 * 历史证据（0.1.5-rc.2 的 `chain` 形态 vs 0.2 的 `list` 形态）保留在
 * `docs/lessons/recovery-console.md`，不再需要面向它的形态探测。
 *
 * ## 版本差异（T9-F2 的真机证据；登记处据此做形态探测）
 *
 * `conversation.chat.node` 在旧版 ui-chat 上可能不是 keyed 形态；登记处（`chat-node-registration.ts`）
 * 因此**先探测后注册**，形态不符就跳过（只丢这一个入口，不拿本插件其余槽位与宿主启动去赌）。
 *
 * 风险与出路：若将来本仓库安装了 ui-chat / ui-session 的类型，同一键若形状不同会以
 * **TS2717（重复声明类型不一致）**报错 —— 那是响亮失败而不是静默错用；届时删掉本文件里
 * 对应的那一条即可（组件 props 的推导全部走 SlotMap，无需改组件）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatEntryHostContentInput } from './chat-entry-view.ts'

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
     * 每条渲染单元一个 cell 的 keyed 位（**遮蔽语义**）：宿主 ui-chat 在这里注册了
     * 15 个 key（user / steering / context / turn-trigger / assistant-step / turn-tail / …）。
     *
     * 本插件只注册 `user`（priority -1）来把「回退」按钮做进每条用户消息；steering 是**另一个**
     * key，一律保持宿主渲染器。注意 owner props 与宿主 `ChatNodeSeat` 的 `routedOwner`
     * **逐字对齐**（含 `node`），因为接管之后那条气泡的渲染责任在我们身上（正文可再委托回宿主，
     * 见 `/ 两个版本的正文契约` 一节）。
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      keyProps: {
        /** 用户消息（我们从宿主手里接管的那一个 cell）。 */
        user: {
          /**
           * 宿主运行时节点（`ChatConversationViewNode` 的形状**故意不写死**：本仓库没有安装
           * ui-chat / ui-session 的类型，写死一个无法核实的形状比「宽度接收 + 逐字段判定」
           * 更容易在升级时静默错用；读取与判定全在 `chat-entry-view.ts` 的纯函数里）。
           */
          node: unknown
          /**
           * 图片加载器（ui-chat ≥ 0.2.1 的 owner 面；图片槽位与正文工厂都用它取图）。
           * 老宿主没有这个字段 —— 组件按 `typeof loadImage === 'function'` 判形态。
           */
          loadImage?: (entry: unknown) => unknown
          /**
           * 图片渲染位（≤ 0.2.0 宿主 `conversation.message.images` 的 renderSlot 绑定）。
           * **0.2.1 起宿主已删除**：图片改由正文工厂内部的 `conversation.chat.user.images` 位渲染，
           * 所以这里必须是可选的，组件的自绘路径按 `typeof renderMessageImages === 'function'` 判形态。
           */
          renderMessageImages?: (owner: unknown) => unknown
          /** 宿主提供的文件打开器（本插件不消费，保持契约完整）。 */
          openFile: (path: string) => void
          /** 宿主提供的 skill 打开器（同上）。 */
          openSkill: (name: string) => void
        }
      }
      owner: {
        /** 分组片段（宿主对同 key 的推理/回答分组用；我们不读）。 */
        groupPart?: string
        /** 工作目录（我们不读，保持契约完整）。 */
        cwd?: string
        /** 节点（宿主 `ChatNodeSeat` 把 routedNode 摊进 owner 的最后一个字段）。 */
        node?: unknown
      }
    }
  }

  /**
   * 可复用正文工厂（ui-chat ≥ 0.2.1 的 `conversation.chat.user.content`）。
   *
   * 调用点（`ChatEntryView.tsx`）只关心**入参**与 `options.fallback`；`children` 与 `locale`
   * 是宿主的注册面，调用侧不需要，故不镜像（`FactoryChildrenOf` 对缺省值解析成空表，不影响调用）。
   */
  interface SlotFactoryMap {
    'conversation.chat.user.content': {
      scope: 'session'
      props: ChatEntryHostContentInput
    }
  }
}
