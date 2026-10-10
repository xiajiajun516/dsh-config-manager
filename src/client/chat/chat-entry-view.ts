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
 *
 * 纪律：本文件 **不产出任何用户可见文案**（只回字典键）；**不 import node 模块、不 import src/core**；
 * 不 import React（React 壳在 ChatEntryView.tsx，便于本文件在 node --test 下零依赖直跑）。
 */
import type { ReactNode } from 'react'
import type { RollbackPointPort, RollbackPointSummary } from '../../ui/rollback-view.ts'
import { findPointForTurn } from './rollback-entry-view.ts'
import { readChatEntryMode, type ChatEntryMode } from './chat-entry-pref.ts'

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
 * 槽位登记计划：**只在 0.2 的 keyed 形态 + 偏好 = 每条消息时接管**。
 *
 * 两种跳过都必须是**失败软化**（只丢这一个入口，不动本插件其余槽位、不动宿主启动）：
 *  · `turn`：用户选了「整回合」，我们完全不注册 —— 宿主 UserMessageNodeView 原样渲染；
 *  · `slot-kind-mismatch`：0.1.x 的 ui-chat 把同一 key 声明成别的形态（对照 turnTail 的
 *    list/chain 双形态实测），按 keyed 参数（key/priority）注册会抛。
 */
export type ChatNodeRegistrationPlan =
  | { kind: 'register' }
  | { kind: 'skip'; reason: 'turn-mode' }
  | { kind: 'skip'; reason: 'slot-kind-mismatch'; declared: string | null }

export function planChatNodeRegistration(declaredKind: string | null, mode: ChatEntryMode = readChatEntryMode()): ChatNodeRegistrationPlan {
  if (mode !== 'per-message') return { kind: 'skip', reason: 'turn-mode' }
  if (declaredKind !== 'keyed') return { kind: 'skip', reason: 'slot-kind-mismatch', declared: declaredKind }
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

export interface ChatEntryBubbleView {
  /** 文本块拼接结果（宿主 `texts.join('')`，逐字保留换行与空白）。 */
  text: string
  images: ChatEntryImage[]
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
/** 宿主：`compactImages = attachments.length > 1`。 */
export const CHAT_ENTRY_COMPACT_THRESHOLD = 1

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

/**
 * 时间戳 → 动作行里显示的时钟文本（宿主 `formatMessageClock(time, t, day)` 的同位置替代）。
 *
 * 为什么用 `toLocaleTimeString` 而不是自己拼 HH:MM：宿主按语言/时区/日历（含 12 小时制与
 * 非公历日历）格式化，浏览器 Intl 是同一套数据源；我们只用它取**时刻**，
 * 日期归属（今天 / 昨天）由宿主那条路径负责 —— 我们**不复制**那套日历逻辑（少一处漂移）。
 * 读不到时间就回 null（动作行不渲染时间，**不编造当前时刻**）。
 */
export function formatChatEntryClock(time: number | null): string | null {
  if (time === null || !Number.isFinite(time)) return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  try {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

/** 扩展名：取最后一个 `.` 之后的部分（大写、≤8 字符）；无扩展名 / 隐藏文件回 null。 */
export function fileExtensionOf(name: string): string | null {
  // 路径分隔符同时认 / 与 \（宿主给的是用户文件路径，可能来自 Windows）
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = name.slice(lastSlash + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  const ext = base.slice(dot + 1).toUpperCase()
  return ext.length > 8 ? ext.slice(0, 8) : ext
}

/**
 * 字节数 → 展示字符串（宿主 fileSizeText 的结构同形：B/KB/MB/GB，一位小数）。
 * 读不到字节数回 null（渲染层据此整段不显示，**不编造 0 B**）。
 */
export function fileSizeTextOf(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return value.toFixed(1) + ' ' + (units[index] ?? 'KB')
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
    return { text: content, images: [], files: [], raw: [], showBubble: content !== '' }
  }
  if (!Array.isArray(content)) {
    return { text: '', images: [], files: [], raw: content === null || content === undefined ? [] : [{ id: '0', payload: content }], showBubble: content !== null && content !== undefined }
  }
  const texts: string[] = []
  const images: ChatEntryImage[] = []
  const files: ChatEntryFile[] = []
  const raw: ChatEntryRawBlock[] = []
  content.forEach((block, index) => {
    const record = asRecord(block)
    const type = record?.['type']
    if (type === 'text' && typeof record?.['text'] === 'string') {
      texts.push(record['text'] as string)
      return
    }
    if (type === 'image' && record?.['attachment'] !== undefined) {
      images.push({ attachment: record['attachment'] })
      return
    }
    if (type === 'file' && record?.['attachment'] !== undefined) {
      const attachment = asRecord(record['attachment'])
      const name = attachment?.['name']
      const bytes = attachment?.['bytes']
      files.push({
        name: typeof name === 'string' && name !== '' ? name : '',
        ext: typeof name === 'string' ? fileExtensionOf(name) : null,
        bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null,
      })
      return
    }
    raw.push({ id: String(index), payload: block })
  })
  const text = texts.join('')
  return { text, images, files, raw, showBubble: text !== '' || raw.length > 0 }
}

/**
 * 图片渲染位载荷：**每张图一次调用**（宿主 `UserStyleBubble` 就是
 * `attachments.map((attachment, index) => renderMessageImages({ images: [attachment.image], align: 'end', compact }))`，
 * 每次调用 = 一个独立的 `conversation.message.images` slot 出现点，渲染器可能是**单图**语义）。
 * 把整组塞进一次调用会改变渲染器的行为 —— 所以这里逐张、逐字复刻宿主。
 */
export function imageRenderOwnersOf(view: ChatEntryBubbleView): HostImageRenderOwner[] {
  const compact = view.images.length > CHAT_ENTRY_COMPACT_THRESHOLD
  return view.images.map((image) => ({ images: [image], align: CHAT_ENTRY_ALIGN, compact }))
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
 *  · `pointsPending`  —— 惰取一次回滚点列表还没回来（**不假装没有**）；
 *  · `noPoint`        —— 列表已读到、没有「同会话 + 同回合」的点（已证实）；
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
 *     · 惰取在途 → `pointsPending`；
 *     · 惰取**失败**（读不出来）→ **乐观可点**（点开走宿主错误路径，界面不撒谎说「没有点」）；
 *  ⑥ 已读到列表：命中 → enabled；没命中 → `noPoint`。
 */
export function chatEntryButtonState(options: {
  node: unknown
  sessionId: string | null | undefined
  lookup: ChatPointLookup | null | undefined
  pending: boolean
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
    if (options.pending) return { kind: 'disabled', code: 'pointsPending', key: CHAT_ENTRY_DISABLED_KEYS.pointsPending }
    return { kind: 'enabled', turn: turn.turn }
  }
  if (lookup.point === null) return { kind: 'disabled', code: 'noPoint', key: CHAT_ENTRY_DISABLED_KEYS.noPoint }
  return { kind: 'enabled', turn: turn.turn }
}

/* ------------------------------------------------------------ 整视图模型 + 错误边界 */

export interface ChatEntryView {
  /** 取到的回合号（渲染/打开对话框都只用它；null = 未识别宿主版本）。 */
  turnNumber: number | null
  turnStatus: string | null
  bubble: ChatEntryBubbleView
  /** 动作行的时间文本（null = 节点没给可用的时间戳）。 */
  clock: string | null
  /** 宿主 data 的另外两个字段（我们**不**接线到 ui-primitives，渲染层如实记成差距）。 */
  referenceLabels: string[]
  skillNames: string[]
}

/** 节点 → 整视图模型（读不到一律回安全值；本函数不抛）。 */
export function buildChatEntryView(node: unknown): ChatEntryView {
  const data = readChatEntryNodeData(node)
  const turn = chatNodeTurn(node)
  return {
    turnNumber: turn?.turn ?? null,
    turnStatus: turn?.status ?? null,
    bubble: buildChatEntryBubble(data.content),
    clock: formatChatEntryClock(data.time),
    referenceLabels: data.referenceLabels ?? [],
    skillNames: data.skillNames ?? [],
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
    if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
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

/* ------------------------------------------------------------ 回滚点惰取（按会话缓存 + 在途去重） */

/** 缓存 TTL：同一会话里的所有按钮共用一次列表读取；跨分钟自然过期（列表变化由宿主写，非热点）。 */
export const CHAT_POINT_CACHE_MS = 30_000

interface ChatPointListCacheEntry {
  at: number
  points: readonly RollbackPointSummary[]
}

/** **按会话**缓存整份列表（不是按回合）：一条长对话里 N 条用户消息只发 1 次请求。 */
const pointListCache = new Map<string, ChatPointListCacheEntry>()
const pointListInflight = new Map<string, Promise<readonly RollbackPointSummary[] | null>>()

/** 清空缓存（单测用；生产代码不调用）。 */
export function resetChatPointCache(): void {
  pointListCache.clear()
  pointListInflight.clear()
}

/**
 * 读该会话的回滚点列表 → 匹配（**复用** `findPointForTurn`：同会话 + 同回合 + 优先 auto，单一实现）。
 *
 * 三条为什么：
 *  · **按会话缓存列表**：每条用户消息各挂一颗按钮，若按回合发请求，一条 50 轮的对话首屏就是 50 次
 *    列表读取；这里整份列表按会话缓存 + 在途去重，N 条消息 → 1 次请求；
 *  · **失败不缓存**（下次重试）：读不出来是**判据未知**，不是「确知没有点」—— 如实回 `resolved:false`，
 *    调用点据此保持乐观可点，让用户在对话框里看到宿主的真实错误，而不是一句假的「没有回滚点」；
 *  · 匹配**不在本层做缓存**（列表缓存了，匹配是纯函数、代价可忽略），所以列表一更新就立刻生效。
 */
export async function lookupPointForTurn(options: {
  port: RollbackPointPort
  sessionId: string
  turn: number
  now?: number
  cacheMs?: number
}): Promise<ChatPointLookup> {
  const now = options.now ?? Date.now()
  const ttl = options.cacheMs ?? CHAT_POINT_CACHE_MS
  const cached = pointListCache.get(options.sessionId)
  if (cached !== undefined && now - cached.at < ttl) {
    return { point: findPointForTurn(cached.points, options.sessionId, options.turn), resolved: true }
  }
  let inflight = pointListInflight.get(options.sessionId)
  if (inflight === undefined) {
    inflight = (async (): Promise<readonly RollbackPointSummary[] | null> => {
      try {
        const list = await options.port.rollbackPoints()
        const points: readonly RollbackPointSummary[] = Array.isArray(list.points) ? list.points : []
        pointListCache.set(options.sessionId, { at: Date.now(), points })
        return points
      } catch {
        return null
      } finally {
        pointListInflight.delete(options.sessionId)
      }
    })()
    pointListInflight.set(options.sessionId, inflight)
  }
  const points = await inflight
  if (points === null) return { point: null, resolved: false }
  return { point: findPointForTurn(points, options.sessionId, options.turn), resolved: true }
}
