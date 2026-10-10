/**
 * 每条用户消息的「↺ 回退」入口 —— **接管 `conversation.chat.node` 的 `user` key 渲染器**。
 *
 * 为什么必须接管（而不是追加）：该 key 没有 children 表（宿主只对 turn-tail 声明了子位），
 * framework 没有「往用户消息里加 UI」的位子；唯一合法做法是 priority -1 遮蔽宿主的
 * `UserMessageNodeView`，然后在自己的渲染里把那条气泡**复刻**一遍（宿主组件 / CSS Modules
 * 全是 ui-chat 私有、不可导入 —— 外观靠本仓库 CSS 逼近，图片**必须**走 owner 给的
 * `renderMessageImages`）。
 *
 * 三件硬约束（本文件是它们的落点）：
 *  ① **用户消息绝不消失**：整个子树包在 `ChatEntryErrorBoundary` 里，抛错就降级成
 *     **纯文本气泡**（文本仍可见）+ ASCII `console.warn`；即使边界自己也没兜住，
 *     ui-renderer 的 per-entry 边界还会让我们的登记**abdicate**、退回宿主渲染器
 *     （SlotErrorBoundary → reportEntryError({ abdicate: true }) → outlet 重渲染到 cell 的下一个幸存者）。
 *  ② **不新造通道**：点开的是既有复核对话框 `RollbackReviewDialog`（T4/T20 的判定与写路径）。
 *  ③ 回合号只认 `node.location`（`chatNodeTurn`，与宿主 turnTail 同一条读法）；取不到 → 如实禁用。
 *
 * 组件的全部判定在 `chat-entry-view.ts`（node 可测）：本文件只做装配、订阅与渲染。
 */
import { Component, createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackPointPort } from '../../ui/rollback-view.ts'
import { Button } from '../common/ui.tsx'
import { CopyStateIcon, RefreshIcon } from '../common/Icon.tsx'
import { copyTextToClipboard } from '../common/clipboard.ts'
import { RollbackReviewDialog } from './RollbackReviewDialog.tsx'
import {
  buildChatEntrySafeRow,
  buildChatEntryView,
  chatEntryButtonState,
  chatEntryTurnPhase,
  fileSizeTextOf,
  imageRenderOwnerOf,
  lookupPointForTurn,
  rawBlockText,
  CHAT_ENTRY_WARN_PREFIX,
  type ChatEntryBubbleView,
  type ChatEntryFallbackRow,
  type ChatEntryFile,
  type ChatPointLookup,
} from './chat-entry-view.ts'
import type { ChildOpenState } from './rollback-entry-view.ts'
// 槽位契约的类型镜像（SlotMap 的 conversation.chat.node entry），见该文件头部说明。
import type {} from './chat-slots.ts'
import css from '../config-manager.module.css'

const NEWLINE = String.fromCharCode(10)

/**
 * 图片渲染位（宿主 `conversation.message.images` 的 renderSlot 绑定）。
 *
 * 为什么签名这么宽：真实 props 合并了 ui-primitives / ui-session 的类型，本仓库**没有安装**它们；
 * 我们只承诺「原样转发 `{ images, align, compact, loadImage }`」（逐字对齐宿主
 * `renderMessageImages = (owner) => renderSlot('conversation.message.images', { ...owner, loadImage })`），
 * 返回值当作不透明 ReactNode 渲染 —— 绝不自己实现图片渲染。
 */
export type MessageImagesRenderer = (owner: unknown) => ReactNode

/** 本条目经 inject 面拿到的业务能力（与回合尾入口同一个 inject 形状）。 */
export interface ChatEntryViewInjected {
  /** 回退端口（T2 的 RecoveryApi；组件**不直接 fetch**）。 */
  port: RollbackPointPort
  /** recovery 字典（rollback.* 词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** 打开 fork 出来的子会话（降级态由对话框如实呈现）。 */
  openChildSession: (childId: string) => Promise<ChildOpenState>
}

/**
 * 完整 props：owner/keyProps 面（`PropsRuntime` 从 SlotMap 推导出 node / renderMessageImages 等）
 * + session 标准 props + 本插件字典（`t`）+ inject 面。
 *
 * 注意 `props.node` 的静态类型是 `unknown`（镜像里刻意不写死宿主节点形状）；真正读它的地方全在
 * `chat-entry-view.ts` 的宽度接收纯函数里。
 */
export type ChatEntryViewProps = PropsRuntime<'conversation.chat.node', 'user'> & PropsLocale<'config-manager-chat'> & ChatEntryViewInjected

/** 文件卡：文件名 + 扩展名徽标 + 体积（扩展名徽标 = 类型图标的诚实兜底，见能力对照表）。 */
function FileCard({ file, size }: { file: ChatEntryFile; size: string | null }) {
  return (
    <span className={css.chatFileCard} title={file.name !== '' ? file.name : undefined}>
      {file.ext !== null && <span className={css.chatFileExt}>{file.ext}</span>}
      <span className={css.chatFileName}>{file.name !== '' ? file.name : '?'}</span>
      {size !== null && <span className={css.chatFileMeta}>{size}</span>}
    </span>
  )
}

/** 未知块：宿主用 JsonBlock，这里用原生 `<details>` + 预格式化 JSON（零新增依赖、零新增通道）。 */
function RawBlock({ payload, label, truncatedLabel }: { payload: unknown; label: string; truncatedLabel: (total: number) => string }) {
  const text = rawBlockText(payload)
  const max = 4000
  const shown = text.length > max ? text.slice(0, max) + NEWLINE + truncatedLabel(text.length) : text
  return (
    <details className={css.chatRawBlock}>
      <summary className={css.chatRawSummary}>{label}</summary>
      <pre className={`${css.chatRawPre} ${css.mono}`}>{shown}</pre>
    </details>
  )
}

/** 复制动作按钮（成功才切「已复制」；失败不给假信号 —— 与 common/CopyButton 同语义）。 */
function ChatEntryCopyAction({ text, t }: { text: string; t: TranslateNS<'config-manager-chat'> }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, 1000)
    return () => { clearTimeout(timer) }
  }, [copied])
  const onCopy = useCallback(() => {
    if (copied) return
    void copyTextToClipboard(text).then((ok) => { if (ok) setCopied(true) })
  }, [copied, text])
  return (
    <button
      type="button"
      className={css.chatActionBtn}
      aria-label={copied ? t('chat.entry.copied') : t('chat.entry.copy')}
      title={copied ? t('chat.entry.copied') : t('chat.entry.copy')}
      onClick={onCopy}
    >
      <CopyStateIcon done={copied} size={13} />
    </button>
  )
}

interface ChatEntryBodyProps extends ChatEntryViewInjected {
  node: unknown
  sessionId: string
  /** 宿主图片渲染位（SlotMap 的 keyProps 把返回值声明成 unknown ⇒ 用它当 `MessageImagesRenderer` 必须过一层窄化）。 */
  renderMessageImages?: unknown
  t: TranslateNS<'config-manager-chat'>
}

/**
 * 一条用户消息的行主体：气泡（文本/图片/文件卡/时间/复制）+ 我们那颗「回退」按钮。
 *
 * 与宿主 UserStyleBubble 的逐条对照见任务 output 的能力对照表；三条**差距**在这里重复一次：
 *  · 引用/技能 chip：宿主把 referenceLabels / skillNames 交给 ui-primitives 的 projectUserText
 *    在正文内部渲染（包私有、不可导入）⇒ 我们**不接线**、也不另起一段文字（不编造内容）；
 *  · 文件类型图标：宿主用 ui-primitives 的 FileTypeIcon（包私有）⇒ 我们用**扩展名徽标**兜底；
 *  · 气泡底色：宿主直接用 `--dsw-specific-bubble`，本仓库 token 层没有这一档 ⇒ 用 `--cm-surface-2`
 *    （亮/暗主题下都是「比底更强的面」），不改 DESIGN 体系、不新增 token。
 */
function ChatEntryBody({ node, sessionId, renderMessageImages, t, rt, port, openChildSession }: ChatEntryBodyProps) {
  const view = useMemo(() => buildChatEntryView(node), [node])
  const [lookup, setLookup] = useState<ChatPointLookup | null>(null)
  const [pending, setPending] = useState(false)
  const [dialogTurn, setDialogTurn] = useState<number | null>(null)
  const button = chatEntryButtonState({ node, sessionId, lookup, pending })
  const turn = view.turnNumber
  const phase = chatEntryTurnPhase(turn === null ? null : { turn, status: view.turnStatus })

  /**
   * 惰取一次回滚点列表（按会话 + 回合缓存、失败不缓存、在途去重）。
   *
   * 为什么在**挂载后**异步读而不是渲染期读：渲染期发请求会随每次重渲染放大；这里一次挂载一次，
   * 读到之前按钮如实标 `pointsPending`（**不假装没有**）。只在「回合已收尾」时才读 ——
   * 收尾未知/未结束的回合注定没有点，不浪费这次请求（按钮此时已经如实禁用了）。
   */
  const canLookup = turn !== null && phase === 'closed' && sessionId !== ''
  useEffect(() => {
    if (!canLookup || turn === null || lookup !== null) return undefined
    let alive = true
    setPending(true)
    void lookupPointForTurn({ port, sessionId, turn }).then((result) => {
      if (!alive) return
      setPending(false)
      setLookup(result)
    })
    return () => { alive = false }
  }, [canLookup, turn, lookup, port, sessionId])

  const openDialog = useCallback(() => {
    if (button.kind !== 'enabled') return
    setDialogTurn(button.turn)
  }, [button])

  const bubble: ChatEntryBubbleView = view.bubble
  const files = bubble.files.map((file, index) => (
    <FileCard key={'file-' + String(index)} file={file} size={fileSizeTextOf(file.bytes)} />
  ))
  const images = bubble.images.length === 0 || typeof renderMessageImages !== 'function'
    ? null
    : (renderMessageImages as MessageImagesRenderer)(imageRenderOwnerOf(bubble))
  const reasonKey = button.kind === 'disabled' ? button.key : null

  return (
    <div className={css.chatEntryScope}>
      <div className={css.chatEntryRow}>
        <div className={css.chatEntryStack}>
          {(files.length > 0 || images !== null) && (
            <div className={css.chatAttachmentRow} data-message-attachments="">
              {images}
              {files}
            </div>
          )}
          {bubble.showBubble && (
            <div className={css.chatBubble}>
              {bubble.text !== '' && <span className={css.chatBubbleText}>{bubble.text}</span>}
              {bubble.raw.map((block) => (
                <RawBlock
                  key={'raw-' + block.id}
                  payload={block.payload}
                  label={t('chat.entry.extraBlock')}
                  truncatedLabel={(total) => t('chat.entry.truncated', { total })}
                />
              ))}
            </div>
          )}
          {typeof renderMessageImages !== 'function' && bubble.images.length > 0 && (
            <div className={css.chatEntryNotice}>{t('chat.entry.noImageRenderer')}</div>
          )}
        </div>
        <div className={css.chatEntryActions}>
          {/* 时间在动作行**最前**（宿主把 MessageIconActions 的 clock 设为 "start"，与它同构） */}
          {view.clock !== null && <span className={css.chatEntryTime}>{view.clock}</span>}
          <ChatEntryCopyAction text={bubble.text} t={t} />
          {button.kind === 'enabled' ? (
            <Button variant="ghost" size="sm" title={t('chat.entry.label')} onClick={openDialog}>
              <RefreshIcon size={12} /> {t('chat.entry.label')}
            </Button>
          ) : (
            // 禁用原因走原生 title（InfoHint 的 Portal 钉在插件设置页根节点，聊天区不存在）；
            // 外层 span 承接 hover —— disabled 元素不派发 title 提示。
            <span className={css.chatEntryDisabledWrap} title={reasonKey === null ? undefined : t(reasonKey as 'chat.entry.disabled.noTurn')}>
              <Button variant="ghost" size="sm" disabled title={reasonKey === null ? undefined : t(reasonKey as 'chat.entry.disabled.noTurn')}>
                <RefreshIcon size={12} /> {t('chat.entry.label')}
              </Button>
            </span>
          )}
        </div>
      </div>
      {dialogTurn !== null && (
        <RollbackReviewDialog
          sessionId={sessionId}
          turn={dialogTurn}
          port={port}
          rt={rt}
          t={t}
          openChildSession={openChildSession}
          onClose={() => { setDialogTurn(null) }}
        />
      )}
    </div>
  )
}

interface ChatEntryBoundaryProps {
  node: unknown
  t: TranslateNS<'config-manager-chat'>
  /** 被保护的子树（`createElement` 的第三参给进来，故这里可选）。 */
  children?: ReactNode
}

interface ChatEntryBoundaryState {
  failed: boolean
  row: ChatEntryFallbackRow | null
}

/**
 * 错误边界：**用户消息绝不消失**。
 *
 * 为什么必须是 class 而不是函数组件：React 18 只有 class 能声明 `getDerivedStateFromError` /
 * `componentDidCatch`（本仓库「函数组件 + hooks，无 class」规范的**唯一例外**，且例外点只有这一个）。
 *
 * 三件事：
 *  ① `getDerivedStateFromError` 先切失败态；真正的内容在 `componentDidCatch` 里由
 *     `buildChatEntrySafeRow` 现算 —— 它自己**不抛**（内部 try/catch + 只认文本与 JSON 短表示），
 *     所以降级气泡一定有内容；连节点都读不出文本时给空字符串（仍然渲染出一条气泡行，不是「整条消失」）。
 *  ② `componentDidCatch` 打 ASCII `console.warn`（诊断用，绝不当作界面文案）。
 *  ③ 节点换了（重挂 / 分页）就清掉失败态（`componentDidUpdate`），不让一次崩溃永久钉死这条消息。
 *
 * 与宿主 ui-renderer 的 per-entry 边界的关系：那一层会在我们崩溃时把我们的登记 **abdicate**，
 * 让 outlet 退回宿主渲染器（消息也能活）；但它会先渲染一个 `<div data-slot-error>` 空壳，
 * 所以本边界是「消息不消失」的第一道，宿主边界是最后一道。
 */
export class ChatEntryErrorBoundary extends Component<ChatEntryBoundaryProps, ChatEntryBoundaryState> {
  override state: ChatEntryBoundaryState = { failed: false, row: null }

  static getDerivedStateFromError(): ChatEntryBoundaryState {
    return { failed: true, row: null }
  }

  override componentDidCatch(error: unknown): void {
    const row = buildChatEntrySafeRow({ node: this.props.node, project: buildChatEntryView })
    console.warn(CHAT_ENTRY_WARN_PREFIX + (error instanceof Error ? error.message : String(error)))
    this.setState({ row })
  }

  override componentDidUpdate(previous: ChatEntryBoundaryProps): void {
    if (previous.node !== this.props.node && this.state.failed) this.setState({ failed: false, row: null })
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const text = this.state.row === null ? '' : this.state.row.text
    const names = this.state.row === null ? [] : this.state.row.fileNames
    return (
      <div
        className={`${css.chatEntryScope} ${css.chatEntryRow} ${css.chatBubble} ${css.chatFallbackBubble}`}
        data-chat-entry-fallback=""
      >
        <span className={css.chatBubbleText}>{text}</span>
        {names.length > 0 && <span className={css.chatFileMeta}>{names.join(' / ')}</span>}
      </div>
    )
  }
}

/**
 * 注册到 `conversation.chat.node` 的 `user` cell（priority -1，遮蔽宿主渲染器）。
 *
 * 已核实：**steering 是另一个 key**（宿主对 user 与 steering 各注册了一次同一个 UserMessageNodeView，
 * 但那是两条独立的 keyed cell）；本入口只注册 `user`，steering 一律保持宿主的渲染器。
 */
export function ChatEntryNodeView(props: ChatEntryViewProps) {
  return createElement(ChatEntryErrorBoundary, { node: props.node, t: props.t }, createElement(ChatEntryBody, props))
}
