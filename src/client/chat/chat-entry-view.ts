/**
 * 每条用户消息一个「↺ 回退」入口 —— **判定层**（框架无关纯函数，node 可测）。
 *
 * 为什么需要这一层：`conversation.chat.node` 的 `user` key 是 keyed 遮蔽位（宿主注册
 * `{ name:'conversation.chat.node', key:'user' }` → `UserMessageNodeView`），**没有 children 表**，
 * framework 不提供「往每条用户消息里追加 UI」的位子。要让按钮和原文同时出现，只有一条路：
 * 用更低的 priority **接管该 key 的渲染器**，把宿主那条气泡（`UserStyleBubble`）自己复刻一遍
 * （宿主组件与它的 CSS Modules 全是 ui-chat 私有、不可导入）。
 *
 * 接管宿主渲染器 = 高风险面（我们的组件一抛错，那条消息就在用户眼前消失），所以本文件把三件
 * 最容易出错的事全部提到纯函数里、由单测钉住：
 *  ① **节点读取**：owner 给的是宿主运行时对象（`node` 形状随版本漂移）—— 宽度接收、逐字段判定，
 *     读不到就如实降级，**绝不猜**（回合号只认 `node.location.kind === 'turn' | 'step'` 那一条
 *     与宿主 turnTail 同源的读法）。
 *  ② **气泡能力面**：把 content 切成 text / image / file / rest 四类，**rest 必须有兜底渲染**
 *     （宿主是 JsonBlock，我们标记成 raw 块交给渲染层，绝不静默丢弃）。
 *  ③ **按钮状态机**：回滚点命中与否（同会话 + 同回合 + 优先 auto）→ 可点 / 一个可证明的禁用原因
 *     （字典键，zh/en 同步）。惰取一次列表、按会话缓存，避免每条消息各发一次请求。
 *  ④ **收尾竞态的有界重试**（R1）：引擎在回合**收尾之后**还要几秒才写完这个回合的点（真机 7.8 s），
 *     所以「第一次读到空列表」是**暂态**、不是结论。窗口内按固定退避再读（每轮强制刷新、绕过那 30 s
 *     列表缓存），**命中即停**；窗口没关就如实显示「正在读取」，只有窗口关且仍为空才说「没有回滚点」。
 *     T6 起窗口是**一次性**的（`ChatPointWindowController`：一个实例最多一轮、可 dispose 取消）——
 *     组件 effect 重跑不会重开窗口；「用户再次触发」靠**新实例**（重新挂载 / 会话或回合变化）。
 *
 * 纪律：本文件 **不产出任何用户可见文案**（只回字典键）；**不 import node 模块、不 import src/core**；
 * 不 import React（React 壳在 ChatEntryView.tsx，便于本文件在 node --test 下零依赖直跑）。
 */
import type { ReactNode } from 'react'
import type { RollbackPointPort, RollbackPointSummary } from '../../ui/rollback-view.ts'
import { findPointForTurn } from './rollback-entry-view.ts'

/* ------------------------------------------------------------ 槽位常量 */

/** keyed 槽位名（宿主在 ChatNodeSeat 里 renderSlot 的那一个）。 */
export const CHAT_NODE_SLOT = 'conversation.chat.node'
/** 本插件接管的 entry key（= 用户消息；steering 是**另一个** key，一律不接管）。 */
export const CHAT_NODE_USER_KEY = 'user'

/**
 * 接管优先级：**-1**（低于宿主 user 渲染器的缺省 0 ⇒ 遮蔽它）。
 *
 * 依据（ui-slots 的 SlotCore.register 文档逐字）：entries 共享一个 cell 时按 priority 升序，
 * **最低的渲染**；同一 cell 的同一 priority 再注册会抛（naming the occupant）——所以 -1 是与宿主
 * 并存的唯一合法取值，写 0 会把整个插件打挂。
 */
export const CHAT_NODE_PRIORITY = -1

/**
 * 同一个 cell（key=user）当前**会被渲染的那一条**（= priority 最小的那一条）。
 *
 * 为什么要读它（2026-10-15，跨插件冲突排查的落地）：`conversation.chat.node` 是 keyed 遮蔽位，
 * 「最低的渲染」——别的插件若也用 key=user 且 priority 比我们更低（≤ -2），它会赢而我们**静默失效**
 * （框架不报错）。所以我们在注册**之前**读一次占用：赢家比我们更低就让位并告警，不去抢。
 */
export interface ChatNodeOccupant {
  /** 该条的 priority（宿主缺省 0）。 */
  priority: number
  /** 诊断用标识（宿主用 fiber 名盖的戳）；读不到回 null，**绝不猜**。 */
  registrant: string | null
}

/** 从 `entriesOfSlot('conversation.chat.node')` 的返回值里读 user cell 的赢家（形状不符一律 null）。 */
export function chatNodeUserOccupant(entries: unknown): ChatNodeOccupant | null {
  if (!Array.isArray(entries)) return null
  let winner: ChatNodeOccupant | null = null
  for (const entry of entries) {
    const record = asRecord(entry)
    const options = asRecord(record?.['options'])
    if (options === null || options['key'] !== CHAT_NODE_USER_KEY) continue
    const raw = options['priority']
    const priority = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    const label = record?.['registrant'] ?? options['registrant']
    const registrant = typeof label === 'string' && label !== '' ? label : null
    if (winner === null || priority < winner.priority) winner = { priority, registrant }
  }
  return winner
}

/**
 * 槽位登记计划：**只在 0.2 的 keyed 形态时接管**（2026-10-12：入口只剩「每条用户消息」一种形态，
 * 旧的「整回合」档与偏好门已随 chat-entry-pref / chat-entry-mount 一起删除）。
 *
 * 跳过必须是**失败软化**（只丢这一个入口，不动本插件其余槽位、不动宿主启动）：
 *  · `slot-kind-mismatch`：0.1.x 的 ui-chat 把同一 key 声明成别的形态（对照 turnTail 的
 *    list/chain 双形态实测），按 keyed 参数（key/priority）注册会抛；
 *  · `shadowed`（2026-10-15）：user cell 已被**更低优先级**的条目占住 —— 我们注册也永远轮不到渲染
 *    （「最低的渲染」），不如让位并如实告警（不静默、也不去抢别人的格子）。
 *
 * 注意 `occupant.priority === CHAT_NODE_PRIORITY` **不算遮蔽**：同一 cell 同 priority 只可能有一条
 * （再注册会抛，由登记处的 try/catch 兜住），所以那时该试的是注册而不是让位。
 */
export type ChatNodeRegistrationPlan =
  | { kind: 'register' }
  | { kind: 'skip'; reason: 'slot-kind-mismatch'; declared: string | null }
  | { kind: 'skip'; reason: 'shadowed'; declared: string | null; occupant: ChatNodeOccupant }

export function planChatNodeRegistration(
  declaredKind: string | null,
  occupant: ChatNodeOccupant | null = null,
): ChatNodeRegistrationPlan {
  if (declaredKind !== 'keyed') return { kind: 'skip', reason: 'slot-kind-mismatch', declared: declaredKind }
  if (occupant !== null && occupant.priority < CHAT_NODE_PRIORITY) {
    return { kind: 'skip', reason: 'shadowed', declared: declaredKind, occupant }
  }
  return { kind: 'register' }
}

/* ------------------------------------------------------------ 节点 / owner 读取 */

/**
 * 宿主交给本 slot 的 owner props 的**结构子集**（只列我们真的读的字段）。
 *
 * 为什么用 `unknown` 承接 `node`：`ChatConversationViewNode` 属于 dsh-client-runtime 的
 * conversation 契约，**本仓库没有安装** ui-chat / ui-session 的类型（见 chat-slots.ts 头注释的
 * 版本差异说明）；写死一个我们无法核实的形状比「宽度接收 + 逐字段判定」更容易在升级时静默错用。
 */
export interface ChatNodeOwnerProps {
  /** 宿主运行时节点（形状漂移面）。 */
  node?: unknown
  /** 图片渲染位（**必须**用它渲染图片；ui-chat 私有实现不可导入）。返回值是不透明 ReactNode。 */
  renderMessageImages?: (owner: unknown) => ReactNode
  /** 文件打开器（宿主把 references 交给气泡；我们只做类型兜底，不接线）。 */
  openFile?: unknown
  /** skill 打开器。 */
  openSkill?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 该节点的 kind（`user` / `steering` / …）；读不到回 null。 */
export function chatNodeKind(node: unknown): string | null {
  const kind = asRecord(node)?.['kind']
  return typeof kind === 'string' ? kind : null
}

/** 一个回合的可核实坐标（宿主 `TurnLocation` 的结构子集）。 */
export interface ChatNodeTurn {
  /** 1-based 回合号（宿主 turnTail 用的同一个字段）。 */
  turn: number
  /** `open` / `closed` / `unknown`；读不到回 null（→ 按「不能证明已收尾」处理）。 */
  status: string | null
}

/**
 * 从节点读回合坐标 —— 与宿主 ChatNodeSeat / AssistantNodeView **同一条读法**：
 * `location.kind === 'turn' | 'step' ? location.turn.turn : undefined`（反编译证据：
 * ui-chat client.js 的 `turnOf()`）。读不到回 null ⇒ 调用点**如实禁用**，禁止猜。
 */
export function chatNodeTurn(node: unknown): ChatNodeTurn | null {
  const location = asRecord(asRecord(node)?.['location'])
  if (location === null) return null
  const kind = location['kind']
  if (kind !== 'turn' && kind !== 'step') return null
  const turn = asRecord(location['turn'])
  const number = turn?.['turn']
  if (typeof number !== 'number' || !Number.isFinite(number)) return null
  const status = turn?.['status']
  return { turn: number, status: typeof status === 'string' ? status : null }
}

/* ------------------------------------------------------------ 气泡视图模型 */

/** 一张图片的载荷（逐字转发给 `renderMessageImages`，见 HostImageRenderOwner）。 */
export interface ChatEntryImage {
  attachment?: unknown
  preview?: unknown
}

/** 文件卡的展示事实（宿主是 FileTypeIcon + 文件名 + 扩展名 + 体积；我们做前三项的样子见渲染层）。 */
export interface ChatEntryFile {
  name: string
  /** 扩展名（大写，≤8 字符；无扩展名回 null）。 */
  ext: string | null
  /** 字节数；宿主没给回 null（不是 0）。 */
  bytes: number | null
}

/** 我们无法理解、必须原样兜底渲染的块（宿主是 JsonBlock）。 */
export interface ChatEntryRawBlock {
  id: string
  payload: unknown
}

/**
 * 一个附件（**有序**，按 content 里出现的次序）：宿主 `UserStyleBubble` 就是
 * `attachments.map((attachment, index) => …)` —— 图片与文件卡共用**同一条序列**、各占一个位置。
 */
export type ChatEntryAttachment =
  | { kind: 'image'; image: ChatEntryImage }
  | { kind: 'file'; file: ChatEntryFile }

/* ------------------------------------------------------------ 宿主 content factory（0.2.1+ 委托路径） */

/**
 * 宿主 `conversation.chat.user.content`（Factory 位）的名字。
 *
 * 0.2.1-alpha.3 起用户气泡的正文/附件/引用**整体换轨**到这条 factory：图片位
 * `conversation.chat.user.images` 是它的 children（single/session），旧的 `conversation.message.images`
 * 与节点 props 上的 `renderMessageImages` 同时删除（本机解包 0.2.1-rc.2 实测：后者 0 次出现）。
 * 因此「接管 user 之后自己复刻气泡」这条路在 0.2.1 上拿不到图片位（issue #92）——正确做法是把正文
 * **委托回宿主自己的 content factory**，图片由 ui-attachment 在该 factory 的渲染上下文里 renderSlot。
 *
 * 老宿主（≤0.2.0）没有这条 factory：`FactoryOutlet` 在定义缺失时回落调用方给的 `options.fallback`
 * ⇒ 渲染层把**自绘气泡**当 fallback 传进去，0.1.x/0.2.0 的路径逐字不变（一个版本双栈兼容）。
 */
export const CHAT_USER_CONTENT_FACTORY = 'conversation.chat.user.content'

/**
 * 宿主 content factory 的附件项（逐字保留宿主 content 里的原始 attachment 载荷）。
 *
 * 形状逐字取自宿主 `contentParts`：`{ type:'image', image:{ attachment } }` /
 * `{ type:'file', file: block.attachment }` —— `file` 那一支是我们的 ChatEntryFile **拼不回来**的
 * `FileAttachmentRef`，所以必须原样留一份。
 */
export type HostUserContentAttachment =
  | { type: 'image'; image: { attachment: unknown } }
  | { type: 'file'; file: unknown }

/** 传给宿主 content factory 的正文载荷（= 宿主 UserStyleBubble 的 `prepared`）。 */
export interface HostUserContentData {
  /** 拼接后的**原文**（未投影；宿主 content factory 内部自己投影会话引用/技能 chip）。 */
  text: string
  attachments: HostUserContentAttachment[]
  /** 未知 / rest 块（宿主交给 JsonBlock，**必须**原样带过去）。 */
  extraBlocks: unknown[]
  /** 仅当节点 data 真的带了该字段时出现（宿主用「字段是否存在」区分「没带」与「空」）。 */
  referenceLabels?: string[]
}

/** 传给宿主 content factory 的文本投影事实（= 宿主 UserStyleBubble 的 `facts`）。 */
export interface HostUserContentFacts {
  sessionLabels?: string[]
  skillNames?: string[]
}

/** 一次 `renderFactorySlot(CHAT_USER_CONTENT_FACTORY, …)` 的入参（`loadImage`/`interactive` 由渲染层补）。 */
export interface HostUserContentInput {
  content: HostUserContentData
  facts: HostUserContentFacts
}

export interface ChatEntryBubbleView {
  /** 文本块拼接结果（宿主 `texts.join('')`，逐字保留换行与空白；会话引用的线格式已投影成 label）。 */
  text: string
  /**
   * **未投影**的文本拼接（会话线格式原样保留）—— 只给宿主 `projectUserText` 用：
   * 它自己认 `@[label](dsh-session:…)` 并把引用/技能渲染成 chip；我们自己的 `text` 是它的兜底。
   */
  rawText: string
  /** **有序附件列表**：渲染层必须按这个顺序输出（宿主不区分「先图片后文件」）。 */
  attachments: ChatEntryAttachment[]
  /**
   * **宿主形状**的有序附件列表（0.2.1+ 委托路径专用）：与 `attachments` 同一趟走查、同一顺序，
   * 但保留宿主 content 里的**原始 attachment 载荷**（我们的 ChatEntryFile 只留了三个展示字段，
   * 拼不回宿主 `FileAttachmentRef`）。逐字对齐宿主 `contentParts` 的 `attachments.push`。
   */
  hostAttachments: HostUserContentAttachment[]
  /** 图片附件（= `attachments` 里的 image 项，顺序一致；用于计数与「无渲染位」提示）。 */
  images: ChatEntryImage[]
  /** 文件附件（= `attachments` 里的 file 项，顺序一致）。 */
  files: ChatEntryFile[]
  /** rest / 未知块：**必须上屏**（渲染层用 JsonBlock 同款 JSON 视图），不得静默丢弃。 */
  raw: ChatEntryRawBlock[]
  /** 是否画气泡框（宿主：text 非空或 rest 非空）。 */
  showBubble: boolean
}

/** 图片渲染位的 owner 载荷（与宿主 `renderMessageImages({ images, align, compact })` 逐字同形）。 */
export interface HostImageRenderOwner {
  images: readonly ChatEntryImage[]
  align: 'end'
  compact: boolean
}

/**
 * 节点 data 的结构子集（`content` / `referenceLabels` / `skillNames` 是宿主 UserMessageNodeView 读的三个字段；
 * `time` 是宿主交给 MessageIconActions 的那一个时间戳）。 */
export interface ChatEntryNodeDataView {
  content: unknown
  referenceLabels: string[] | null
  skillNames: string[] | null
  /** 消息时间戳（宿主 `data.time`，交给 MessageIconActions 的同一个值）；读不到回 null。 */
  time: number | null
}

export const CHAT_ENTRY_ALIGN = 'end' as const
/**
 * 宿主：`const compactImages = attachments.length > 1` —— 这里的 `attachments` 是
 * **全部附件**（图片 + 文件，= contentParts 吐出的那个数组），**不是「图片数」**。
 * 阈值 1 = 「附件多于一个」。
 */
export const CHAT_ENTRY_COMPACT_THRESHOLD = 1

/** 宿主 `compactImages` 的同一口径：**附件总数**（图片 + 文件）> 1。 */
export function chatEntryCompactOf(view: ChatEntryBubbleView): boolean {
  return view.attachments.length > CHAT_ENTRY_COMPACT_THRESHOLD
}

/** 读节点 data 的三个字段（读不到一律回安全值）。 */
export function readChatEntryNodeData(node: unknown): ChatEntryNodeDataView {
  const data = asRecord(asRecord(node)?.['data'])
  const strings = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null
    return value.filter((item): item is string => typeof item === 'string')
  }
  const time = data?.['time']
  return {
    content: data?.['content'] ?? null,
    referenceLabels: strings(data?.['referenceLabels']),
    skillNames: strings(data?.['skillNames']),
    // 只认数字毫秒（宿主 TurnErrorItem 就是 new Date(node.data.time)）；ISO 串等其它形状一律不猜
    time: typeof time === 'number' && Number.isFinite(time) ? time : null,
  }
}

/** 两位补零（宿主 `pad2`）。 */
function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value)
}

/**
 * 时间戳 → 动作行里显示的时钟文本 —— 宿主 `formatMessageClock` 的**逐字复刻**（只取时刻那一半）：
 *
 *   const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;   // **固定 24 小时制、补零**
 *
 * 为什么不用浏览器 Intl 的小时/分钟格式化：它随语言变成 12 小时制（en-US 下 '05:04 PM'），
 * 与宿主那一列的时间**在同一屏里就不一致**（t4 复核 D4）。时区仍走本地（与宿主同一把尺子）。
 *
 * 已追认差距（G-39，登记归 t11）：**非当天不加日期**（宿主会补 `clock.md`/`clock.ymd` 前缀）。
 * 读不到时间就回 null（动作行不渲染时间，**不编造当前时刻**）。
 */
export function formatChatEntryClock(time: number | null): string | null {
  if (time === null || !Number.isFinite(time)) return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/* ------------------------------------------------------------ 会话语义引用（线格式 → label） */

/**
 * 会话引用的**线格式**：`@[label](dsh-session:<id>)` —— 逐字取自宿主 ui-primitives 的
 * `SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu`（同一个正则、同一个捕获组语义：
 * `wire[1]` 是给人看的 label）。
 */
export const CHAT_SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/**
 * 正文的**最小文本投影**（宿主投影不可用时的兜底）：把会话引用线格式换成它的人类可读 label。
 *
 * 2026-10-15 起：气泡正文**优先走宿主自己的** `projectUserText`（见 `projectChatEntryTextWithHost`
 * —— 它能把会话引用与技能渲染成 chip，并在给了打开器时可点开）；本函数是**兜底与纯文本路径**
 * （复制按钮、错误边界降级、老宿主没有原语包时）的唯一实现：任何情况下都**不把线格式原样打给用户看**
 * （那是机器的编码，正常人读不了 —— t4 复核 D5，medium）。
 * 与宿主一致的边界：只认 `dsh-session:` 的括号形式；`g` flag 下逐处替换，正则自身 lastIndex 置零。
 */
export function projectChatEntryText(text: string): string {
  if (text.indexOf('@[') < 0) return text
  CHAT_SESSION_WIRE_RE.lastIndex = 0
  return text.replace(CHAT_SESSION_WIRE_RE, '$1')
}

/**
 * 宿主 `projectUserText` 的**可注入面**（宽类型：本仓库不引用 ui-primitives 的类型，也不 import 它）。
 * 返回值是不透明 ReactNode（chip 节点等）；缺省 null = 这台宿主没有该能力。
 */
export type ChatEntryTextProjector = (
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[],
  slashKind: string,
  references?: { openFile?: unknown; openSkill?: unknown },
) => ReactNode

/** 宿主投影的入参（全部来自节点 data 与 owner props；缺省即空）。 */
export interface ChatEntryHostTextOptions {
  /** `data.referenceLabels`（引用会话的 label 列表）。 */
  sessionLabels?: readonly string[]
  /** `data.skillNames`（宿主把它们渲染成 chip —— 我们此前一个元素都不产出）。 */
  skillNames?: readonly string[]
  /** 宿主给的文件 / 技能打开器（给了才能点开 chip；没有就只显示 chip 外观）。 */
  openFile?: unknown
  openSkill?: unknown
}

/**
 * 用**宿主自己**的 `projectUserText` 投影正文（2026-10-15：按生态既有做法补齐 G-39 差距①）。
 *
 * 实证（为什么这条现在成立）：ui-primitives 由 DSH shell 的模块表作为 static module seed 预置，
 * 插件 bundle 的 `require` 能命中 —— 第三方插件 dsh-reedit 就是这么拿 `projectUserText` 的，
 * 本仓的 `RollbackFileIcon` 也早就这样拿 `FileTypeIcon`。**只能帧内惰取**（顶层 import 在老宿主
 * 会打挂整个浏览器半加载），入口在 `common/host-primitives.ts`。
 *
 * 四条判据缺一不可（本函数**绝不抛**，任一条不满足就回 null ⇒ 调用方回落 `projectChatEntryText`）：
 *  ① 有投影器（老宿主没有原语包 → null）；② 原文非空；
 *  ③ 投影不抛错；④ 投影返回**非空节点**（null/undefined/false = 宿主拒绝了这段文本）。
 *
 * 为什么投影要当参数传进来：纯层与单测都不认识模块表 —— 抽成参数后，上面四条判据能逐条覆盖。
 */
export function projectChatEntryTextWithHost(
  projector: ChatEntryTextProjector | null | undefined,
  rawText: string,
  options: ChatEntryHostTextOptions = {},
): ReactNode | null {
  if (typeof projector !== 'function') return null
  if (rawText === '') return null
  try {
    const node = projector(rawText, options.sessionLabels ?? [], options.skillNames ?? [], 'skill', {
      openFile: options.openFile,
      openSkill: options.openSkill,
    })
    return node === null || node === undefined || node === false ? null : node
  } catch {
    return null
  }
}

/**
 * 扩展名 → 文件卡上的短徽标：宿主 `fileExtension` + 宿主那行 meta 的同一截断
 * （`fileExtension(name).toUpperCase().slice(0, 8)`）；后缀为空（无点 / 点在末尾）回 null。
 *
 * 与宿主的两点对齐说明：① **前导点算后缀**（`.gitignore` → `gitignore` → 徽标 `GITIGNOR`）；
 * ② 上限 8 字符是宿主**显示层**的截断，不是我们自己加的花样。 */
export function fileExtensionOf(name: string): string | null {
  // 路径分隔符同时认 / 与 \（宿主给的是用户文件路径，可能来自 Windows）
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = name.slice(lastSlash + 1)
  const dot = base.lastIndexOf('.')
  // 宿主 fileExtension：`dot < 0 ? "" : name.slice(dot + 1)` —— **前导点也算后缀**（'.gitignore' → 'gitignore'），
  // 末尾点是空串（宿主那边 filter(Boolean) 后不显示徽标）。这里同样只在空串时回 null。
  const ext = dot < 0 ? '' : base.slice(dot + 1)
  if (ext === '') return null
  const upper = ext.toUpperCase()
  return upper.length > 8 ? upper.slice(0, 8) : upper
}

/**
 * 字节数 → 展示字符串 —— 宿主 `fileSizeText` 的**逐字复刻**：
 *
 *   bytes < 1024        → `${bytes}B`                       （**无空格**）
 *   kb < 1024           → `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`   （≥10 取整：'20KB'）
 *   mb < 1024           → 同规则 MB
 *   否则                → 同规则 GB
 *
 * 三条注意：① 阈值判的是**单位值**（kb/mb/gb）是否 < 10，不是字节数；② 单位与数字之间**没有空格**；
 * ③ 读不到 / 负数一律回 null（渲染层整段不显示，**不编造 0B**）—— 宿主对负数会打出 "-5B"，
 *    那条路径在消息附件里不可达（bytes 来自宿主自己的附件元数据），我们选择如实留空。
 */
export function fileSizeTextOf(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return String(bytes) + 'B'
  const kb = bytes / 1024
  if (kb < 1024) return String(kb < 10 ? kb.toFixed(1) : Math.round(kb)) + 'KB'
  const mb = kb / 1024
  if (mb < 1024) return String(mb < 10 ? mb.toFixed(1) : Math.round(mb)) + 'MB'
  const gb = mb / 1024
  return String(gb < 10 ? gb.toFixed(1) : Math.round(gb)) + 'GB'
}

/**
 * content → 气泡视图模型（宿主 `contentParts` 的**逐条对齐**实现）：
 *  · `type === 'text' && typeof text === 'string'` → texts（join('') 保留换行/空白）；
 *  · `type === 'image' && attachment !== undefined` → 图片位 `{ attachment }`；
 *  · `type === 'file' && attachment !== undefined` → 文件卡（文件名 + 扩展名 + 体积）；
 *  · **其余全部进 rest**（宿主原样交给 JsonBlock；我们绝不静默丢）。
 * content 不是数组（宿主给了怪形状）时：字符串按纯文本块处理，其余进 rest —— 保证「用户消息绝不消失」。
 */
export function buildChatEntryBubble(content: unknown): ChatEntryBubbleView {
  if (typeof content === 'string') {
    const text = projectChatEntryText(content)
    return { text, rawText: content, attachments: [], hostAttachments: [], images: [], files: [], raw: [], showBubble: text !== '' }
  }
  if (!Array.isArray(content)) {
    return { text: '', rawText: '', attachments: [], hostAttachments: [], images: [], files: [], raw: content === null || content === undefined ? [] : [{ id: '0', payload: content }], showBubble: content !== null && content !== undefined }
  }
  const texts: string[] = []
  const rawTexts: string[] = []
  const attachments: ChatEntryAttachment[] = []
  const hostAttachments: HostUserContentAttachment[] = []
  const raw: ChatEntryRawBlock[] = []
  content.forEach((block, index) => {
    const record = asRecord(block)
    const type = record?.['type']
    if (type === 'text' && typeof record?.['text'] === 'string') {
      // 宿主把这条文本交给 projectUserText（会话引用渲染成 chip）；我们做**最小文本投影**：线格式 → label
      // （rawTexts 同时留一份未投影原文，宿主投影可用时优先用它 —— 见 ChatEntryBubbleView.rawText）
      rawTexts.push(record['text'] as string)
      texts.push(projectChatEntryText(record['text'] as string))
      return
    }
    if (type === 'image' && record?.['attachment'] !== undefined) {
      attachments.push({ kind: 'image', image: { attachment: record['attachment'] } })
      // 同一趟走查里并出宿主形状的那一份（同一顺序、原始载荷）—— 见 HostUserContentAttachment
      hostAttachments.push({ type: 'image', image: { attachment: record['attachment'] } })
      return
    }
    if (type === 'file' && record?.['attachment'] !== undefined) {
      const attachment = asRecord(record['attachment'])
      const name = attachment?.['name']
      const bytes = attachment?.['bytes']
      attachments.push({
        kind: 'file',
        file: {
          name: typeof name === 'string' && name !== '' ? name : '',
          ext: typeof name === 'string' ? fileExtensionOf(name) : null,
          bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null,
        },
      })
      hostAttachments.push({ type: 'file', file: record['attachment'] })
      return
    }
    raw.push({ id: String(index), payload: block })
  })
  const text = texts.join('')
  const rawText = rawTexts.join('')
  // images / files 是 attachments 的**派生视图**（不独立积累，避免两处真相与顺序漂移）
  const images = attachments.flatMap((item) => (item.kind === 'image' ? [item.image] : []))
  const files = attachments.flatMap((item) => (item.kind === 'file' ? [item.file] : []))
  return { text, rawText, attachments, hostAttachments, images, files, raw, showBubble: text !== '' || raw.length > 0 }
}

/**
 * 节点 data + 气泡视图 → 宿主 content factory 的入参（0.2.1+ 委托路径的**唯一**组装点）。
 *
 * 逐字对齐宿主 `UserStyleBubble` 的 `prepared` / `facts` 两段 useMemo：
 *  · `content.text` = 未投影的文本拼接（宿主 factory 自己把它交给 `conversation.user.text` 投影成 chip）；
 *  · `content.attachments` = 宿主形状的有序附件（同一趟走查产出）；
 *  · `content.extraBlocks` = rest 块原样；
 *  · `referenceLabels` / `sessionLabels` / `skillNames` **只在节点真的带了该字段时出现** ——
 *    宿主用「字段是否存在」区分「没带」与「空数组」，我们传 `[]` 会改变它的分支。
 *
 * 本函数不抛（读不到就按「没带」处理），与 buildChatEntryBubble 同一条纪律。
 */
export function buildHostUserContentInput(data: ChatEntryNodeDataView, bubble: ChatEntryBubbleView): HostUserContentInput {
  const content: HostUserContentData = {
    text: bubble.rawText,
    attachments: bubble.hostAttachments,
    extraBlocks: bubble.raw.map((block) => block.payload),
  }
  const facts: HostUserContentFacts = {}
  if (data.referenceLabels !== null) {
    content.referenceLabels = data.referenceLabels
    facts.sessionLabels = data.referenceLabels
  }
  if (data.skillNames !== null) facts.skillNames = data.skillNames
  return { content, facts }
}

/** 渲染计划的一项：图片带 owner 载荷，文件带名称/扩展名/体积文本。 */
export type ChatEntryAttachmentPlan =
  | { kind: 'image'; index: number; owner: HostImageRenderOwner }
  | { kind: 'file'; index: number; file: ChatEntryFile; size: string | null }

/**
 * 有序附件 → 渲染计划（宿主 `attachments.map` 的逐字同构）：
 *  · **顺序 = content 原始顺序**（绝不重排成「先图片后文件」）；
 *  · 图片**每张一次** `renderMessageImages({ images: [image], align: 'end', compact })`
 *    —— 每次调用 = 一个独立的 `conversation.message.images` slot 出现点，渲染器按**单图**语义工作，
 *    所以不能把整组塞进一次调用；
 *  · `compact` 按**附件总数**算（见 `chatEntryCompactOf`）。
 */
export function planChatEntryAttachments(view: ChatEntryBubbleView): ChatEntryAttachmentPlan[] {
  const compact = chatEntryCompactOf(view)
  return view.attachments.map((attachment, index) => attachment.kind === 'image'
    ? { kind: 'image', index, owner: { images: [attachment.image], align: CHAT_ENTRY_ALIGN, compact } }
    : { kind: 'file', index, file: attachment.file, size: fileSizeTextOf(attachment.file.bytes) })
}

/* ------------------------------------------------------------ 按钮状态机 */

/** 一条用户消息上那颗「回退」按钮的状态。 */
export type ChatEntryButton =
  | { kind: 'enabled'; turn: number }
  | { kind: 'disabled'; code: ChatEntryDisabledCode; key: string }

/**
 * 禁用原因（**每个码只说自己能证明的那件事**；键在 chat 字典里，zh/en 同步）：
 *  · `noTurn`         —— 节点里取不到可核实的回合号（未识别宿主版本 / 未来形状漂移）；
 *  · `turnOpen`       —— `node.location.turn.status === 'open'`：回合**确实**没结束，留点还没发生；
 *  · `noSession`      —— 没有 sessionId，无法按「同会话」匹配；
 *  · `pointsPending`  —— 惰取还没回来，或**收尾后的有界重试窗口还没关**（窗口内列表读到空只是暂态，
 *                         所以如实说「正在读取」；**不假装没有**）；
 *  · `noPoint`        —— 列表已读到、没有「同会话 + 同回合」的点，**且重试窗口已关**（已证实）；
 *  · `turnUnknown`    —— `status` 不是 `'closed'` 也不是 `'open'`（unknown / 读不到）：
 *                         不能证明回合已收尾，也不能证明没结束，如实说「收尾状态未知」。
 */
export type ChatEntryDisabledCode = 'noTurn' | 'turnOpen' | 'noSession' | 'pointsPending' | 'noPoint' | 'turnUnknown'

/** 每个禁用码各自的字典键（**六个原因各有自己的话**：合成一句就会有一半在撒谎）。 */
export const CHAT_ENTRY_DISABLED_KEYS: Record<ChatEntryDisabledCode, string> = {
  noTurn: 'chat.entry.disabled.noTurn',
  turnOpen: 'chat.entry.disabled.turnOpen',
  noSession: 'chat.entry.disabled.noSession',
  pointsPending: 'chat.entry.disabled.pointsPending',
  noPoint: 'chat.entry.disabled.noPoint',
  turnUnknown: 'chat.entry.disabled.turnUnknown',
}

/** 回滚点列表的惰取结果（`null` = 缓存未命中，调用点负责去读）。 */
export interface ChatPointLookup {
  /** 该（会话 + 回合）命中的回滚点；未读到时 null。 */
  point: RollbackPointSummary | null
  /** 列表是否已经读到（false = 还没读 / 读失败 ⇒ 不得断言「没有」）。 */
  resolved: boolean
}

/** 该回合的收尾状态判定（只认这三个取值，其余一律 unknown）。 */
export type ChatEntryTurnPhase = 'closed' | 'open' | 'unknown'

export function chatEntryTurnPhase(turn: ChatNodeTurn | null): ChatEntryTurnPhase {
  if (turn === null) return 'unknown'
  if (turn.status === 'closed') return 'closed'
  if (turn.status === 'open') return 'open'
  return 'unknown'
}

/**
 * 按钮状态机（**唯一判定点**）：
 *  ① 没有可核实的回合号 → `noTurn`（禁止猜）；
 *  ② 回合明确 open → `turnOpen`（还没收尾 ⇒ 还没有这个回合的点）；
 *  ③ 没有 sessionId → `noSession`；
 *  ④ 收尾状态 unknown → `turnUnknown`（不假装已收尾）；
 *  ⑤ 列表还没读回来：
 *     · 惰取在途（`pending`）或**重试窗口还开着**（`retrying`）→ `pointsPending`；
 *     · 惰取**失败**（读不出来）且窗口已关 → **乐观可点**（点开走宿主错误路径，界面不撒谎说「没有点」）；
 *  ⑥ 已读到列表：命中 → enabled；没命中 → 重试窗口内 `pointsPending`、窗口关后 `noPoint`
 *     （R1：引擎在收尾之后还要几秒才写完点，窗口内的空列表是暂态；把暂态说成「没有」就是不诚实）。
 *
 * `pending` 与 `retrying` 的关系：前者是「这一次读在途」，后者是「窗口还开着」（含首读在途、含读到空
 * 还会再读、含读失败还会再读）。两个都表示**还没结论**，所以两个都归 `pointsPending`；
 * 调用点通常只需给 `retrying`（窗口状态机是唯一真相），`pending` 留给不接状态机的旧调用点。
 */
export function chatEntryButtonState(options: {
  node: unknown
  sessionId: string | null | undefined
  lookup: ChatPointLookup | null | undefined
  pending: boolean
  /**
   * 收尾后的有界重试窗口还开着（R1/R9）：**还没拿到结论**（首读在途 / 读到空还会再读 / 读失败还会再读）
   * ⇒ `pointsPending`。缺省 false = 旧调用点的行为逐字不变。
   */
  retrying?: boolean
}): ChatEntryButton {
  const turn = chatNodeTurn(options.node)
  if (turn === null) return { kind: 'disabled', code: 'noTurn', key: CHAT_ENTRY_DISABLED_KEYS.noTurn }
  const phase = chatEntryTurnPhase(turn)
  if (phase === 'open') return { kind: 'disabled', code: 'turnOpen', key: CHAT_ENTRY_DISABLED_KEYS.turnOpen }
  if (typeof options.sessionId !== 'string' || options.sessionId === '') {
    return { kind: 'disabled', code: 'noSession', key: CHAT_ENTRY_DISABLED_KEYS.noSession }
  }
  if (phase === 'unknown') return { kind: 'disabled', code: 'turnUnknown', key: CHAT_ENTRY_DISABLED_KEYS.turnUnknown }
  const lookup = options.lookup
  if (lookup === null || lookup === undefined || lookup.resolved !== true) {
    // 「这一次读在途」与「窗口还开着」都是「还没结论」—— 都不许说成「没有回滚点」，也都不该乐观放行
    if (options.pending || options.retrying === true) {
      return { kind: 'disabled', code: 'pointsPending', key: CHAT_ENTRY_DISABLED_KEYS.pointsPending }
    }
    return { kind: 'enabled', turn: turn.turn }
  }
  if (lookup.point === null) {
    if (options.retrying === true) return { kind: 'disabled', code: 'pointsPending', key: CHAT_ENTRY_DISABLED_KEYS.pointsPending }
    return { kind: 'disabled', code: 'noPoint', key: CHAT_ENTRY_DISABLED_KEYS.noPoint }
  }
  return { kind: 'enabled', turn: turn.turn }
}

/* ------------------------------------------------------------ 收尾竞态：有界重试（R1） */

/**
 * 重试窗口长度：**30 s**（毫秒）。判据是「从挂载/收尾那一刻起累计的墙上时间」，不是尝试次数。
 *
 * 为什么是 30 s：真机实测引擎在**回合收尾之后 7.8 s** 才写完这个回合的点
 * （turn/end 20:03:38.658Z → 点 createdAt 20:03:46.434Z）。30 s 给足「慢机器 / 大盘 355 文件」的余量，
 * 同时是一个**有界**的等待：用户最多等 30 s 就能拿到一个诚实的结论（命中，或「没有回滚点」），
 * 而不是被一次空结果永久禁用。窗口内最多 6 次列表读取（1 次首读 + 5 次重试），**不是轮询**。
 */
export const CHAT_POINT_LOOKUP_WINDOW_MS = 30_000

/**
 * 固定退避表（毫秒）—— 每次「没命中」之后等这么久再读下一轮，**表走完就停**。
 *
 * 0.5 / 1.5 / 3 / 6 / 12 s ⇒ 累计 23 s（< 30 s 窗口），覆盖真机 7.8 s 的落点，晚到的写回也抓得住。
 * 选固定表而不是纯指数：间隔可被单测逐项断言 —— 「有界重试」的判据必须是可核对的数字。
 */
export const CHAT_POINT_RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 3_000, 6_000, 12_000]

/**
 * 这一轮读完之后**还该不该再读**（纯判定，**不看时钟**，只吃结果）。
 *
 * 命中 → 立即 false（命中即停：不再排重试、不再发请求，避免无谓 churn）；
 * 未命中（读到空列表 = 暂态，或读失败 = 判据未知）→ true，由调用点按退避表排下一轮。
 * 这里刻意**不**把「已读到空列表」当成长期真值 —— 那正是 R1 要修的那个 bug 的根。
 */
export function shouldRetryChatPoint(lookup: ChatPointLookup | null | undefined): boolean {
  if (lookup === null || lookup === undefined) return true
  return lookup.point === null
}

/* 重试循环（`retryChatPointUntilHit`，含取消钩子）与「一个挂载只跑一轮窗口」的状态机
   （`ChatPointWindowController`）都住在 `chat-point-window.ts`（T6 起）：那里是**一次性实例**语义
   （start 幂等），所以 effect 重跑不会再开第二轮窗口。这里全额 re-export，调用点与单测的 import 面不变。 */
export { retryChatPointUntilHit, ChatPointWindowController, type ChatPointWindowState } from './chat-point-window.ts'

/* ------------------------------------------------------------ 整视图模型 + 错误边界 */

export interface ChatEntryView {
  /** 取到的回合号（渲染/打开对话框都只用它；null = 未识别宿主版本）。 */
  turnNumber: number | null
  turnStatus: string | null
  bubble: ChatEntryBubbleView
  /** 动作行的时间文本（null = 节点没给可用的时间戳）。 */
  clock: string | null
  /**
   * 宿主 data 的另外两个字段：`referenceLabels` 进引用汇总行；两者都作为 `projectUserText`
   * 的入参传给**宿主的**正文投影（2026-10-15 起 —— 此前它们只是「如实记下的差距」）。
   */
  referenceLabels: string[]
  skillNames: string[]
  /**
   * 宿主 content factory 的入参（0.2.1+ 委托路径）。**始终**算好：新宿主用它委托，老宿主把它
   * 闲置（那条 factory 不存在 ⇒ 渲染层走自绘气泡 fallback），两条路径都不需要再读一次节点。
   */
  hostContent: HostUserContentInput
}

/** 节点 → 整视图模型（读不到一律回安全值；本函数不抛）。 */
export function buildChatEntryView(node: unknown): ChatEntryView {
  const data = readChatEntryNodeData(node)
  const turn = chatNodeTurn(node)
  const bubble = buildChatEntryBubble(data.content)
  return {
    turnNumber: turn?.turn ?? null,
    turnStatus: turn?.status ?? null,
    bubble,
    clock: formatChatEntryClock(data.time),
    referenceLabels: data.referenceLabels ?? [],
    skillNames: data.skillNames ?? [],
    hostContent: buildHostUserContentInput(data, bubble),
  }
}

/** 错误边界降级后**仍然可见**的那点东西（用户消息绝不消失）。 */
export interface ChatEntryFallbackRow {
  text: string
  fileNames: string[]
}

/**
 * 构造错误边界的降级输入（纯函数，可单测）。
 *
 * 为什么参数里要 `project` 而不是直接吃节点：错误边界要做的事就是「让任意一段子渲染（包括
 * 我们自己的 normalizer）抛错时也不整条消失」，所以这里把「投影」抽成可注入的一步 ——
 * 单测直接传一个必然抛错的投影就复现了真实崩溃路径。
 */
export function buildChatEntrySafeRow(options: {
  node: unknown
  project: (node: unknown) => ChatEntryView
}): ChatEntryFallbackRow {
  try {
    const view = options.project(options.node)
    return {
      text: view.bubble.text !== '' ? view.bubble.text : view.bubble.raw.map((block) => rawBlockText(block.payload)).join('\n'),
      fileNames: view.bubble.files.map((file) => file.name).filter((name) => name !== ''),
    }
  } catch {
    const data = readChatEntryNodeData(options.node)
    return { text: plainTextOf(data.content), fileNames: [] }
  }
}

/**
 * 最朴素的纯文本投影（**不抛**）：只认 `type === 'text'` 与裸字符串，
 * 其余块用 JSON 短表示 —— 用于「我们的投影自己崩了」时的最后一道兜底（绝不整条消失）。
 */
export function plainTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === null || content === undefined ? '' : rawBlockText(content)
  return content.map((block) => {
    const record = asRecord(block)
    if (record === null) return rawBlockText(block)
    if (record['type'] === 'text' && typeof record['text'] === 'string') return projectChatEntryText(record['text'])
    // 文件块：降级气泡里至少要看见**文件名**（比一串 JSON 有用得多）
    if (record['type'] === 'file') {
      const name = asRecord(record['attachment'])?.['name']
      if (typeof name === 'string' && name !== '') return name
    }
    // 图片块：没有可供纯文本使用的信息（附件 id 对人无意义），用块类型占位而不是倒 JSON
    if (record['type'] === 'image') return record['type'] as string
    return rawBlockText(block)
  }).join('\n')
}

/** 兜底块 → 文本（JSON 序列化失败时回 String()；**不抛**）。 */
export function rawBlockText(payload: unknown): string {
  try {
    const text = JSON.stringify(payload)
    return text === undefined ? String(payload) : text
  } catch {
    return String(payload)
  }
}

/** 错误边界的 ASCII 诊断前缀（console.* 实参不触发 i18n 守卫；界面文案一律在字典里）。 */
export const CHAT_ENTRY_WARN_PREFIX = '[config-manager] chat user node renderer degraded to plain text: '

/**
 * 让位告警的 ASCII 前缀（诊断用，绝不当作界面文案）—— 见 `planChatNodeRegistration` 的 `shadowed`：
 * 别的插件用更低优先级占住了 key=user 时，我们**不注册**（注册也永远轮不到渲染），只留这条日志。
 */
export const CHAT_NODE_YIELD_WARN_PREFIX = '[config-manager] chat user node entry yielded: another renderer owns key "user" at a lower priority: '

/* ------------------------------------------------------------ 回滚点惰取（按会话缓存 + 在途去重） */

/** 缓存 TTL：同一会话里的所有按钮共用一次列表读取；跨分钟自然过期（列表变化由宿主写，非热点）。 */
export const CHAT_POINT_CACHE_MS = 30_000

/**
 * 宿主列表载荷里本模块真正用到的三件事（**宽度接收**：多出的字段逐字段判定，读不到就按「没带」处理）。
 *
 * 为什么要宽度接收 `inheritLinks`：它是 t9 新增的**继承链**（fork 子会话 id → 父会话 id），
 * 由引擎 `list()` 回传；`src/ui/rollback-view.ts` 的 `RollbackListResult` 类型不在 t9 scope，
 * 所以这里不 import 一个还不存在的字段，而是像读宿主 node 形状那样**逐字段判定**：
 * 没带（旧宿主）⇒ 行为与今天逐字一致，绝不猜。
 */
interface ChatPointListFacts {
  points: readonly RollbackPointSummary[]
  /** fork 子会话 id → 父会话 id；undefined = 载荷没带这张表（旧宿主） */
  links: Record<string, string> | undefined
  /** 链是否完整；undefined = 未声明（按「完整」处理） */
  linksComplete: boolean | undefined
}

interface ChatPointListCacheEntry {
  at: number
  facts: ChatPointListFacts
}

/**
 * 继承链上溯的**深度上限**（与宿主侧 `ANCESTOR_LOOKUP_MAX_DEPTH` 同口径取 8：DSH 的子代理/分叉树
 * 实际深度是个位数）。只上溯 + 环保护 + 上限三道一起，保证异常数据（自指 / 环 / 超深链）
 * 既不挂起、也不误命中。
 */
export const CHAT_POINT_ANCESTOR_MAX_DEPTH = 8

/** 载荷 → 本模块用到的三件事（形状不符一律降级为「没带」，绝不抛）。 */
function readChatPointListFacts(raw: unknown): ChatPointListFacts {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null
  const rawPoints = record?.['points']
  const points = Array.isArray(rawPoints) ? rawPoints as readonly RollbackPointSummary[] : []
  const rawLinks = record?.['inheritLinks']
  let links: Record<string, string> | undefined
  if (typeof rawLinks === 'object' && rawLinks !== null && !Array.isArray(rawLinks)) {
    const out: Record<string, string> = {}
    for (const [child, parent] of Object.entries(rawLinks as Record<string, unknown>)) {
      if (child !== '' && typeof parent === 'string' && parent !== '') out[child] = parent
    }
    links = out
  }
  const rawComplete = record?.['inheritLinksComplete']
  return { points, links, linksComplete: typeof rawComplete === 'boolean' ? rawComplete : undefined }
}

/**
 * 本会话/本回合未命中时，沿 `parentSession` 链**只上溯**找祖先的同回合点（t9）。
 *
 * 语义（与引擎侧逐条对齐）：
 *  · 只对「历史被继承」的 fork 子会话建链（引擎只登记这种），子代理会话不在链里
 *    —— 它们的回合号是**自己的**，按同回合上溯会误命中；
 *  · 命中即返回**祖先自己的点**（`sessionId` 是祖先）：回退动作仍在原会话上做 fork，
 *    与今天的语义逐字相同（`boundarySeq` 也来自祖先点）；
 *  · 环 / 超深链 / 链被截断 ⇒ `proven:false`（判据**未知**），调用点据此报 `resolved:false`
 *    —— 不得把「看不完」说成「确知没有」。
 */
function findPointThroughAncestors(
  facts: ChatPointListFacts,
  sessionId: string,
  turn: number,
): { point: RollbackPointSummary | null; proven: boolean } {
  const links = facts.links
  // 旧宿主（载荷没有继承链）：与今天逐字一致 —— 未命中就是确知没有
  if (links === undefined) return { point: null, proven: true }
  const seen = new Set<string>([sessionId])
  let current = sessionId
  for (let depth = 1; depth <= CHAT_POINT_ANCESTOR_MAX_DEPTH; depth += 1) {
    const parent = links[current]
    // 走到链顶：只有「链完整」时才算证明了「确实没有」（截断的链可能缺环）
    if (parent === undefined) return { point: null, proven: facts.linksComplete !== false }
    // 自指 / 环：数据不可信 ⇒ 判据未知（绝不挂起）
    if (seen.has(parent)) return { point: null, proven: false }
    seen.add(parent)
    const hit = findPointForTurn(facts.points, parent, turn)
    if (hit !== null) return { point: hit, proven: true }
    current = parent
  }
  // 超过深度上限：看不完 ⇒ 不可证明（不误命中、也不挂起）
  return { point: null, proven: false }
}

/** 载荷 → 一次查询结论（自己的点优先；未命中才上溯）。 */
function lookupPointInFacts(facts: ChatPointListFacts, sessionId: string, turn: number): ChatPointLookup {
  const own = findPointForTurn(facts.points, sessionId, turn)
  if (own !== null) return { point: own, resolved: true }
  const ancestor = findPointThroughAncestors(facts, sessionId, turn)
  if (ancestor.point !== null) return { point: ancestor.point, resolved: true }
  return { point: null, resolved: ancestor.proven }
}

/** **按会话**缓存整份列表（不是按回合）：一条长对话里 N 条用户消息只发 1 次请求。 */
const pointListCache = new Map<string, ChatPointListCacheEntry>()
const pointListInflight = new Map<string, Promise<ChatPointListFacts | null>>()

/** 清空缓存（单测用；生产代码不调用）。 */
export function resetChatPointCache(): void {
  pointListCache.clear()
  pointListInflight.clear()
}

/**
 * 读该会话的回滚点列表 → 匹配（**复用** `findPointForTurn`：同会话 + 同回合 + 优先 auto，单一实现）。
 *
 * 四条为什么：
 *  · **按会话缓存列表**：每条用户消息各挂一颗按钮，若按回合发请求，一条 50 轮的对话首屏就是 50 次
 *    列表读取；这里整份列表按会话缓存 + 在途去重，N 条消息 → 1 次请求；
 *  · **失败不缓存**（下次重试）：读不出来是**判据未知**，不是「确知没有点」—— 如实回 `resolved:false`，
 *    调用点据此保持乐观可点，让用户在对话框里看到宿主的真实错误，而不是一句假的「没有回滚点」；
 *  · **匹配不在本层做缓存**（列表缓存了，匹配是纯函数、代价可忽略），所以列表一更新就立刻生效；
 *  · `force`（R1 新增）= **空结果不锁死**的唯一通道：跳过那次缓存读，去宿主再读一遍并**写回**新结果。
 *    重试轮必须用它 —— 否则那 30 s TTL 会把「收尾时读到的一次空列表」锁成这 30 s 的**假事实**，
 *    而点其实在几秒后就被引擎写出来了。注意 force **不**破坏在途去重：同会话已有读取在途时仍复用它
 *    （那是同一次真读，不是缓存），所以 N 条消息一起重试时仍然只发 1 个请求。
 */
export async function lookupPointForTurn(options: {
  port: RollbackPointPort
  sessionId: string
  turn: number
  now?: number
  cacheMs?: number
  /** true = 跳过缓存读（重试轮用）；读回来的结果照常写回缓存。 */
  force?: boolean
}): Promise<ChatPointLookup> {
  const now = options.now ?? Date.now()
  const ttl = options.cacheMs ?? CHAT_POINT_CACHE_MS
  const cached = options.force === true ? undefined : pointListCache.get(options.sessionId)
  if (cached !== undefined && now - cached.at < ttl) {
    return lookupPointInFacts(cached.facts, options.sessionId, options.turn)
  }
  let inflight = pointListInflight.get(options.sessionId)
  if (inflight === undefined) {
    inflight = (async (): Promise<ChatPointListFacts | null> => {
      try {
        const list = await options.port.rollbackPoints()
        // 宽度接收：points 之外的继承链字段由 readChatPointListFacts 逐字段判定（读不到 = 没带）
        const facts = readChatPointListFacts(list as unknown)
        pointListCache.set(options.sessionId, { at: Date.now(), facts })
        return facts
      } catch {
        return null
      } finally {
        pointListInflight.delete(options.sessionId)
      }
    })()
    pointListInflight.set(options.sessionId, inflight)
  }
  const facts = await inflight
  if (facts === null) return { point: null, resolved: false }
  return lookupPointInFacts(facts, options.sessionId, options.turn)
}
