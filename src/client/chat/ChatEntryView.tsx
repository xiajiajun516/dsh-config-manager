/**
 * 每条用户消息的「↺ 回退」入口 —— **接管 `conversation.chat.node` 的 `user` key 渲染器**。
 *
 * 为什么必须接管（而不是追加）：该 key 没有 children 表（宿主只对 turn-tail 声明了子位），
 * framework 没有「往用户消息里加 UI」的位子；唯一合法做法是 priority -1 遮蔽宿主的
 * `UserMessageNodeView`，然后在自己的渲染里产出那条气泡。
 *
 * 正文**谁来画**在 0.2.1-alpha.3 换过一代（issue #92）：宿主把图片位搬进
 * `conversation.chat.user.content` factory 的 children，并删掉了节点 props 上的 `renderMessageImages`。
 * 因此现在的口径是 **优先委托宿主的 content factory**（`renderFactorySlot(CHAT_USER_CONTENT_FACTORY, …)`），
 * 只有在宿主**没有**注册那条 factory 时（≤0.2.0）才回落到自绘气泡 —— 自绘气泡同时是那次调用的
 * `options.fallback`，所以三格（老宿主 / 新宿主 / 宿主中途撤掉 factory）都有确定行为，
 * 不会出现空白气泡。自绘那一格图片只能走 owner 的 `renderMessageImages`（宿主的 CSS Modules 与组件
 * 全是 ui-chat 私有、不可导入，外观靠本仓库 CSS 逼近）。
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
import { Component, Fragment, createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackPointPort } from '../../ui/rollback-view.ts'
import { CopyStateIcon, RefreshIcon } from '../common/Icon.tsx'
import { isRollbackEntryEnabled, subscribeRollbackEntryEnabled } from '../recovery/rollback-enabled.ts'
import { copyTextToClipboard } from '../common/clipboard.ts'
import { RollbackReviewDialog } from './RollbackReviewDialog.tsx'
import type { RollbackDiffOpenResult } from './rollback-diff-tab.ts'
import {
  buildChatEntrySafeRow,
  buildChatEntryView,
  chatEntryButtonState,
  projectChatEntryTextWithHost,
  chatEntryTurnPhase,
  planChatEntryAttachments,
  lookupPointForTurn,
  rawBlockText,
  CHAT_ENTRY_WARN_PREFIX,
  CHAT_USER_CONTENT_FACTORY,
  type ChatEntryBubbleView,
  type ChatEntryFallbackRow,
  type ChatEntryFile,
  type ChatPointLookup,
} from './chat-entry-view.ts'
import { ChatPointWindowController, type ChatPointWindowState } from './chat-point-window.ts'
import { hostFileTypeIcon, hostIcon, hostUserTextProjector } from '../common/host-primitives.ts'
import type { ArchiveOutcome } from './rollback-entry-view.ts'
import type { ChildOpenState } from './rollback-entry-view.ts'
import type { RollbackFileIconRenderer } from './RollbackFileIcon.tsx'
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

/**
 * 宿主 content factory 渲染位（0.2.1-alpha.3 起节点渲染器 props 上的 `renderFactorySlot`，
 * 由 ui-slots 的 `PropsRenderFactories` 挂在**每一个**渲染组件上）。
 *
 * 为什么签名这么宽：真实类型是 `RenderFactorySlot`（按 SlotFactoryMap 泛型收窄），本仓库没有
 * ui-chat 的类型；我们只承诺「按名字原样转发入参 + 收 `options.fallback`」，返回值当不透明 ReactNode。
 *
 * 注意它**在新旧宿主上都存在**（ui-renderer 的 standardKit 无条件发放）：所以「走不走委托」不能只判
 * 它是不是函数 —— 真正的判据是宿主到底注册没注册那条 factory，由 `FactoryOutlet` 在定义缺失时
 * 回落我们给的 fallback 来裁决（见 ChatEntryBody）。
 */
export type HostContentFactoryRenderer = (
  name: string,
  props: unknown,
  options?: { fallback?: ReactNode },
) => ReactNode

/** 本条目经 inject 面拿到的业务能力（与回合尾入口同一个 inject 形状）。 */
export interface ChatEntryViewInjected {
  /** 回退端口（T2 的 RecoveryApi；组件**不直接 fetch**）。 */
  port: RollbackPointPort
  /** recovery 字典（rollback.* 词汇单一所有）。 */
  rt: TranslateNS<'config-manager-recovery'>
  /** 打开 fork 出来的子会话（降级态由对话框如实呈现）。 */
  openChildSession: (childId: string) => Promise<ChildOpenState>
  /** A（无感替换）：回退后把原会话收进「已归档」；失败一律结构化返回，由对话框如实呈现。 */
  archiveParentSession: (sessionId: string) => Promise<ArchiveOutcome>
  /** 第一条消息之前没有可 fork 的边界：开一条全新会话（uiWorkspace.startSession 同一条路）。 */
  startFreshSession: () => Promise<{ ok: true } | { ok: false; code: string }>
  /**
   * 「查看」：把该文件的差异开进 DSH 右侧栏（装配点注入）。侧栏不可用时返回 no-sidebar，
   * 由预览对话框如实降级为弹窗内展示 —— 绝不给一个点了没反应的入口。
   */
  openDiff: (pointId: string, filePath: string) => RollbackDiffOpenResult
  /**
   * 文件类型图标的外部来源（可选）：装了 dsh-better-sidebar 时用它的 `betterSidebar.fileIcon`，
   * 否则对话框回落到 DSH 自带的 `FileTypeIcon`（第 7 条，详见 RollbackFileIcon.tsx）。
   */
  fileIcon?: RollbackFileIconRenderer
}

/**
 * 完整 props：owner/keyProps 面（`PropsRuntime` 从 SlotMap 推导出 node / renderMessageImages 等）
 * + session 标准 props + 本插件字典（`t`）+ inject 面。
 *
 * 注意 `props.node` 的静态类型是 `unknown`（镜像里刻意不写死宿主节点形状）；真正读它的地方全在
 * `chat-entry-view.ts` 的宽度接收纯函数里。
 */
export type ChatEntryViewProps = PropsRuntime<'conversation.chat.node', 'user'> & PropsLocale<'config-manager-chat'> & ChatEntryViewInjected

/**
 * 文件卡：类型图标 + 文件名 + 体积。
 *
 * 类型图标**优先用宿主自己的** `FileTypeIcon`（ui-primitives，帧内惰取 —— 见 common/host-primitives.ts）；
 * 拿不到（老宿主）才回落我们自己的**扩展名徽标**（口径与宿主 fileExtension 一致，见 fileExtensionOf）。
 * 2026-10-15：此前一律走徽标，是因为「ui-primitives 包私有不可导入」只对**构建期 import** 成立 ——
 * 运行期 require 是生态通行做法（dsh-reedit / dsh-better-sidebar / 本仓 RollbackFileIcon 都这么做）。
 */
function FileCard({ file, size }: { file: ChatEntryFile; size: string | null }) {
  const DshIcon = hostFileTypeIcon()
  /**
   * 元信息 = 宿主 `.fileMeta` 的**同一组合**：大写的扩展名（≤8 字符）+ 体积文本，空格连接。
   * 宿主那行是「EXT SIZE」一行的次级小字（不是我们此前那个「文件名旁边挂一个体积」的排法）。
   */
  const meta = [file.ext === null ? '' : file.ext.toUpperCase().slice(0, 8), size ?? '']
    .filter((part) => part !== '')
    .join(' ')
  return (
    <span className={css.chatFileCard} title={file.name !== '' ? file.name : undefined}>
      {DshIcon !== null && file.name !== ''
        ? <DshIcon path={file.name} size={28} className={css.chatFileIcon} />
        : file.ext !== null && <span className={css.chatFileExt}>{file.ext}</span>}
      <span className={css.chatFileContent}>
        <span className={css.chatFileName}>{file.name !== '' ? file.name : '?'}</span>
        {meta !== '' && <span className={css.chatFileMeta}>{meta}</span>}
      </span>
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
  /**
   * 图标 = **DSH 原生那两颗**（2026-10-17 用户要求「复制 icon 与动画都用 DSH 原生的」）：
   * 宿主 MessageIconActions 的复制反馈就是 `IconCopyOutlineRegular → IconCheckOutlineRegular` 的
   * **瞬时切换**（宿主 `.action svg` 没有任何 transition/animation —— 它的「动画」就是这一次换图）。
   * 本仓库的 `CopyStateIcon`（morphicons 形变）只在**拿不到宿主图标的老宿主**上兜底。
   */
  const HostCopyIcon = hostIcon('IconCopyOutlineRegular')
  const HostCheckIcon = hostIcon('IconCheckOutlineRegular')
  return (
    <button
      type="button"
      className={css.chatActionBtn}
      aria-label={copied ? t('chat.entry.copied') : t('chat.entry.copy')}
      title={copied ? t('chat.entry.copied') : t('chat.entry.copy')}
      onClick={onCopy}
      data-copy-state={copied ? 'copied' : 'idle'}
    >
      {HostCopyIcon !== null && HostCheckIcon !== null
        ? (copied ? <HostCheckIcon size={15} /> : <HostCopyIcon size={15} />)
        : <CopyStateIcon done={copied} size={15} />}
    </button>
  )
}

interface ChatEntryBodyProps extends ChatEntryViewInjected {
  node: unknown
  sessionId: string
  /** 宿主的文件 / 技能打开器（给宿主正文投影的 chip 用；形态不符时投影自己会当没有）。 */
  openFile?: unknown
  openSkill?: unknown
  /** 宿主图片渲染位（SlotMap 的 keyProps 把返回值声明成 unknown ⇒ 用它当 `MessageImagesRenderer` 必须过一层窄化）。 */
  renderMessageImages?: unknown
  /** 宿主授权过的图片加载器（0.2.1+ 节点渲染器 props；原样转发给 content factory）。 */
  loadImage?: unknown
  /** 宿主 content factory 渲染位（0.2.1+；老宿主拿不到 ⇒ 直接走自绘气泡。见 HostContentFactoryRenderer）。 */
  renderFactorySlot?: unknown
  t: TranslateNS<'config-manager-chat'>
}

/**
 * 一条用户消息的行主体：气泡（文本/图片/文件卡/时间/复制）+ 我们那颗「回退」按钮。
 *
 * 与宿主 UserStyleBubble 的逐条对照见任务 output 的能力对照表。**下面按现状分别写**（t12 修正：
 * 旧注释把「引用」与「技能」并成同一句结论，已与本文件下方的渲染不符 —— 前者已复刻、后者仍未做）：
 *  · **引用（会话引用）**：**已复刻**——线格式 `@[label](dsh-session:…)` 在纯投影层换成 label 文本
 *    （`projectChatEntryText`），且 `data.referenceLabels` 非空时渲染**宿主的引用汇总行**
 *    （见下方 `css.chatEntryReference` + `t('chat.entry.referenceSummary')` 那段，文案与宿主
 *    `引用会话 · {labels}` 逐字同义）。**仍有的差距**只有 chip 的**外观与可点开**（已追认）。
 *  · **技能（skillNames）与引用 chip**：2026-10-15 起正文**优先交给宿主自己的** `projectUserText`
 *    （ui-primitives 帧内惰取，见 common/host-primitives.ts）——技能与引用渲染成 chip，`openFile` /
 *    `openSkill` 可用时还能点开；拿不到原语（老宿主）就回落我们的纯文本投影，**不编造内容、不留空白**。
 *  · 文件类型图标：同样优先宿主的 `FileTypeIcon`，拿不到才回落到**扩展名徽标**兜底；
 *  · 气泡底色：`--cm-chat-bubble`（= 宿主 `--dsw-specific-bubble`，2026-10-15 之前误用 `--cm-surface-2`
 *    ⇒ 浅色主题下与页面同色、气泡看不见；详见 DESIGN.md §15b 与 css 里那两条定义行的注释）。
 */
/**
 * 订阅入口可见性信号（issue #88）。
 *
 * 为什么要在组件里订阅而不是把开关当 prop 往下传：入口是**遮蔽宿主渲染器**注册的（无常），
 * 开关变化时没有任何父级会重渲染它 —— 状态只能靠这条信号推。订阅开销 = 一个 Set 里的回调。
 *
 * 2026-10-17 起登记本身随开关撤销（关闭 ⇒ 让出 user cell、本组件直接卸载，宿主原生气泡接管回来），
 * 所以这里是**兜底**：万一信号已翻转而本组件还活着，也绝不画出那颗按钮。
 */
function useRollbackEntryEnabled(): boolean {
  const [value, setValue] = useState(() => isRollbackEntryEnabled())
  useEffect(() => subscribeRollbackEntryEnabled(() => { setValue(isRollbackEntryEnabled()) }), [])
  return value
}

function ChatEntryBody({ node, sessionId, openFile, openSkill, renderMessageImages, loadImage, renderFactorySlot, t, rt, port, openChildSession, archiveParentSession, startFreshSession, openDiff, fileIcon }: ChatEntryBodyProps) {
  const view = useMemo(() => buildChatEntryView(node), [node])
  const [lookup, setLookup] = useState<ChatPointLookup | null>(null)
  /** 有界重试窗口是否还开着（**状态诚实**的唯一开关，R1）—— 由状态机的 `onState` 驱动。 */
  const [windowOpen, setWindowOpen] = useState(false)
  const [dialogTurn, setDialogTurn] = useState<number | null>(null)
  const turn = view.turnNumber
  const phase = chatEntryTurnPhase(turn === null ? null : { turn, status: view.turnStatus })
  /**
   * 「还没拿到结论」⇒ 按钮如实显示「正在读取回滚点…」（**不许**说成「没有回滚点」）：
   *  · 窗口开着（首读在途 / 读到空还会再读 / 读失败还会再读）→ `pointsPending`；
   *  · 窗口关掉且仍为空 → `noPoint`（此时才是「已证实没有」）。
   * 判据只用状态机给的两个事实（`windowOpen` + `lookup`），没有第三个需要手工同步的标志。
   */
  const retrying = windowOpen && (lookup === null || lookup.point === null)
  const button = chatEntryButtonState({ node, sessionId, lookup, pending: false, retrying })

  /**
   * 读回滚点列表：**收尾之后的有界重试**（R1），不是一次性的惰取。
   *
   * 为什么必须重试：引擎在回合**收尾之后**才写点 —— 真机实测 turn/end 之后 **7.8 s**
   * （session-e3a7953c…：turn/end 20:03:38.658Z → 该回合的点 createdAt 20:03:46.434Z）。
   * 旧实现的 effect 条件是「读到过就永不重查」，于是首读撞上那个空窗就**永久禁用**；
   * 现在按 `CHAT_POINT_RETRY_DELAYS_MS`（0.5/1.5/3/6/12 s）在 `CHAT_POINT_LOOKUP_WINDOW_MS`
   * 窗口内再读，**命中即停**（命中后一个请求都不再发）。
   *
   * **一次 effect 调用 = 一个新实例**（T9 / RR2-A）：React StrictMode 会走
   * `effect → cleanup → effect` 双调用。实例若跨调用复用（此前放在 `useMemo` 里），第二次 `start()`
   * 会因为 `started` 已置位而变成 no-op，而被 dispose 的那个循环又永不回调 ⇒ 窗口**永久**停在
   * `open: true`、按钮永久停在「正在读取回滚点…」禁用（与原始症状同一类）。每次 effect 各建实例即无此路径。
   *
   * 又因为依赖里**没有任何 React 状态**（只有 `canLookup` / `port` / `sessionId` / `turn`），
   * 状态回调不会把 effect 再跑一遍 ⇒ 同时满足 F1「一个挂载只跑一轮窗口」（不周期性重开）。
   *
   * 只在「回合已收尾」时才读 —— 收尾未知/未结束的回合注定没有点，不浪费这次请求（按钮此时已如实禁用）。
   * 「用户再次触发」= 重新挂载（切档 / 重进会话）或会话/回合变化 ⇒ 新实例；不需要刷新页面。
   */
  // issue #88：功能关闭时连**查询都不发**（不只是不画按钮）—— 入口收起 = 这一整个入口链路停摆。
  // 关掉功能后登记会被撤销（本组件随之卸载），这两道门因此是兜底而非唯一机制。
  const entryEnabled = useRollbackEntryEnabled()
  const canLookup = entryEnabled && turn !== null && phase === 'closed' && sessionId !== ''
  useEffect(() => {
    if (!canLookup || turn === null) return undefined
    const controller = new ChatPointWindowController({
      attempt: (force) => lookupPointForTurn({ port, sessionId, turn, force }),
      onState: (state: ChatPointWindowState) => {
        setLookup(state.lookup)
        setWindowOpen(state.open)
      },
    })
    controller.start()
    // F2：取消通道（循环立即 settle）。dispose **不回调** onState —— 这里正是卸载/换会话，
    // 回调只会在卸载后 setState（RR2-B：语义与注释对齐，见 chat-point-window.ts 的 dispose 文档）。
    return () => { controller.dispose() }
  }, [canLookup, port, sessionId, turn])

  const openDialog = useCallback(() => {
    if (button.kind !== 'enabled') return
    setDialogTurn(button.turn)
  }, [button])

  const bubble: ChatEntryBubbleView = view.bubble
  /** 回退图标同样走宿主（`IconRefreshOutlineRegular`）：与复制图标同一套字形/描边；拿不到回落 RefreshIcon。 */
  const HostRefreshIcon = hostIcon('IconRefreshOutlineRegular')
  /**
   * 附件按**content 原始顺序**输出（宿主 `attachments.map` 同构）：图片走 owner 的
   * `renderMessageImages`（每张一次调用），文件走文件卡 —— 两类**共用同一条序列**，
   * 绝不重排成「先图片后文件」（t4 复核 D2）。
   *
   * 这条自绘路径**只在宿主没有 content factory 时**才会上屏（见下面的 `content`）：
   * 0.2.1 起 `renderMessageImages` 已不存在，此时图片位置如实显示提示文本 —— 但那一格
   * 正常情况下走的是宿主自己的 factory，根本到不了这里。
   */
  const canRenderImages = typeof renderMessageImages === 'function'
  const attachmentNodes = planChatEntryAttachments(bubble).map((item) => item.kind === 'image'
    ? (canRenderImages
        ? (
          <Fragment key={'image:' + String(item.index)}>
            {(renderMessageImages as MessageImagesRenderer)(item.owner)}
          </Fragment>
          )
        : null)
    : <FileCard key={'file:' + String(item.index)} file={item.file} size={item.size} />)
  const hasAttachments = attachmentNodes.some((node) => node !== null)
  /**
   * 正文：**优先宿主自己的** `projectUserText`（会话引用 / 技能渲染成 chip，给了打开器就能点开），
   * 拿不到就回落我们自己的纯文本投影（`bubble.text`，线格式也已换成 label）。
   * 四条回落判据在纯层（`projectChatEntryTextWithHost`）；投影器**帧内惰取**（老宿主没有原语包 → null）。
   */
  const hostText = projectChatEntryTextWithHost(hostUserTextProjector(), bubble.rawText, {
    sessionLabels: view.referenceLabels,
    skillNames: view.skillNames,
    openFile,
    openSkill,
  })
  const reasonKey = button.kind === 'disabled' ? button.key : null

  /**
   * **自绘气泡**（= 0.2.1 之前那条路径，style 与宿主 .userStack/.bubble 逐条对齐见本文件头注释）。
   *
   * 两个身份：① 老宿主（≤0.2.0）没有 `conversation.chat.user.content` 这条 factory，正文由它承担；
   * ② 新宿主上它是那次 factory 调用的 **fallback** —— 定义缺失（或宿主中途撤掉）时由
   * `FactoryOutlet` 回落，用户消息因此**永远不会**变成空白。
   *
   * 图片：这条路径只能走 owner 的 `renderMessageImages`（0.2.1 起已不存在）⇒ 那一格如实显示提示文本，
   * 而不是静默消失；新宿主正常情况下根本不会渲染到这里（走的是宿主自己的 content factory）。
   */
  const ownContent = (
    <div className={css.chatEntryStack}>
      {hasAttachments && (
        <div className={css.chatAttachmentRow} data-message-attachments="">
          {attachmentNodes}
        </div>
      )}
      {bubble.showBubble && (
        <div className={css.chatBubble}>
          {bubble.text !== '' && (
            <span className={css.chatBubbleText}>{hostText === null ? bubble.text : hostText}</span>
          )}
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
      {!canRenderImages && bubble.images.length > 0 && (
        <div className={css.chatEntryNotice}>{t('chat.entry.noImageRenderer')}</div>
      )}
      {/* 引用会话汇总行：宿主在气泡下方渲染 referenceSummary（`引用会话 · {labels}`）。
          我们复刻这一行（文案在 chat 字典里，**不依赖 ui-primitives**）；`data-ref-chip` 供探针定位。 */}
      {view.referenceLabels.length > 0 && (
        <div className={css.chatEntryReference} data-ref-chip="">
          {t('chat.entry.referenceSummary', {
            labels: view.referenceLabels.join(t('chat.entry.referenceSeparator')),
          })}
        </div>
      )}
    </div>
  )

  /**
   * 正文 / 附件 / 引用（issue #92）：**优先委托宿主自己的 content factory**。
   *
   * 为什么不能再自绘：0.2.1-alpha.3 起宿主把图片位搬进 `conversation.chat.user.content` 的 children
   * （`conversation.chat.user.images`），并在节点 props 上删掉了 `renderMessageImages` —— 自己复刻气泡
   * 就必然拿不到图片位。委托之后，图片由 ui-attachment 在该 factory 的渲染上下文里 renderSlot，
   * 正文/文件卡/引用/未知块也全部回到宿主实现 ⇒ 与宿主原生气泡**同构**，且以后宿主再改图片实现也不用跟。
   *
   * 入参逐字对齐宿主 `UserStyleBubble`（`content` / `loadImage` / `facts` / `interactive: true`），
   * 组装全在纯层 `buildHostUserContentInput`。**判据不是 `typeof renderFactorySlot === 'function'`** ——
   * 该席位在新旧宿主上都存在（ui-renderer 的 standardKit 无条件发放），真正的裁决点是这条 factory
   * 注册没注册：`FactoryOutlet` 在读不到定义时渲染我们给的 `fallback`（= 上面的自绘气泡）——
   * 于是「老宿主 ≤0.2.0」「新宿主 ≥0.2.1」「宿主中途撤掉 factory」三格都有确定行为，不必开两条发布线。
   * 调用本身不吃任何副作用，返回不透明 ReactNode（React 元素），空定义时是 fallback 的元素包装。
   */
  const content = typeof renderFactorySlot === 'function'
    ? (renderFactorySlot as HostContentFactoryRenderer)(
      CHAT_USER_CONTENT_FACTORY,
      {
        content: view.hostContent.content,
        loadImage,
        facts: view.hostContent.facts,
        interactive: true,
      },
      { fallback: ownContent },
    )
    : ownContent

  return (
    <div className={css.chatEntryScope}>
      <div className={css.chatEntryRow}>
        {content}
        <div className={css.chatEntryActions}>
          {/* 时间在动作行**最前**（宿主把 MessageIconActions 的 clock 设为 "start"，与它同构） */}
          {view.clock !== null && <span className={css.chatEntryTime}>{view.clock}</span>}
          <ChatEntryCopyAction text={bubble.text} t={t} />
          {/* 回退入口：**只有图标**（无文字标签、无边框按钮样式），与时间戳/复制图标同一行同观感 ——
              2026-10-10 用户第二条要求「回退按钮只有一个 icon 而不是一个按钮」。可见文案退到
              aria-label/title；禁用原因是原生 title 里的一句话（InfoHint 的 Portal 钉在插件设置页
              根节点，聊天区不存在）。按钮始终留在原地（禁用而不是消失）：入口可见性不随判据漂移。 */}
          {/* 开关**关闭时整颗收起**（issue #88 明确要求「入口收起」，不是置灰；2026-10-17 起连登记
              都会被撤销，整条气泡交回宿主原生渲染，这里只是兜底的那一层）。
              与上面那条「入口可见性不随判据漂移」不冲突：那说的是**暂时读不到点**这类判据，
              而这里是「用户把这个功能关了」——此时入口本身就不该存在。 */}
          {entryEnabled && (
          <button
            type="button"
            className={css.chatActionBtn}
            disabled={button.kind !== 'enabled'}
            aria-label={t('chat.entry.label')}
            title={reasonKey === null ? t('chat.entry.label') : t(reasonKey as 'chat.entry.disabled.noTurn')}
            onClick={openDialog}
            /* 只读判据（零样式、零文案）：重试窗口开着时置位 —— 排障时一眼看出「正在读取」是暂态还是终态 */
            data-chat-entry-window-open={windowOpen ? '' : undefined}
            data-chat-entry-window-closed={windowOpen ? undefined : ''}
          >
            {HostRefreshIcon === null ? <RefreshIcon size={15} /> : <HostRefreshIcon size={15} />}
          </button>
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
          archiveParentSession={archiveParentSession}
          startFreshSession={startFreshSession}
          openDiff={openDiff}
          renderFileIcon={fileIcon}
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
