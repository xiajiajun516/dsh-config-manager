/**
 * 聊天内回退入口形态的**偏好**（每条用户消息 / 整回合）。
 *
 * 两档只有一份判据（`isChatEntryMode`），读写都在这里：
 *  · `per-message`（**缺省**）：接管 `conversation.chat.node` 的 `user` key，每条用户消息一颗按钮；
 *  · `turn`：**完全不注册**我们的 user 渲染器 —— 宿主 UserMessageNodeView 原样渲染，入口退回
 *    既有的回合尾 list 位（`conversation.chat.turnTail`）。
 *
 * 存储位置 = 浏览器 localStorage（与 `market/disclaimer.ts`、`sync/sync-view.ts` 同一做法：
 * 跨会话偏好、不进导出包、不落宿主盘）。storage 由 `globalThis.localStorage` 惰取，
 * node 单测/隐私模式（取不到）一律**静默降级**为缺省值 —— 缺省值是「每条消息」，
 * 所以降级方向永远是「功能在」而不是「功能没了」。
 *
 * 为什么一档一档都是显式字符串：值会在用户的浏览器里长期存活，任何未知值（旧版本写下的、
 * 手改的）都必须落到**缺省档**而不是抛错或半开。
 */
/**
 * 本模块需要的**最小 storage 面**（结构子集）。
 *
 * 为什么不用 DOM 的 \`Storage\` 全局类型：本文件在 node 单测里被直接 import，注入的是内存 mock；
 * 只列真的用到的两个方法，浏览器 \`localStorage\` 天然满足（结构类型，无需 cast）。
 */
interface ChatEntryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 两档形态。 */
export type ChatEntryMode = 'per-message' | 'turn'

/** localStorage key（带插件前缀，避免与宿主/其它插件撞键）。 */
export const CHAT_ENTRY_MODE_KEY = 'dcm.chat-entry-mode'

/** 缺省档 = 每条用户消息（产品要求：缺省就是「每条消息」）。 */
export const CHAT_ENTRY_MODE_DEFAULT: ChatEntryMode = 'per-message'

/** 两档的合法取值（守卫用；顺序即界面展示顺序）。 */
export const CHAT_ENTRY_MODES: readonly ChatEntryMode[] = ['per-message', 'turn']

/** 一个值是否是合法档位（**唯一**判据）。 */
export function isChatEntryMode(value: unknown): value is ChatEntryMode {
  return value === 'per-message' || value === 'turn'
}

/** 浏览器 localStorage；非浏览器环境（node 单测）→ null。 */
function browserStorage(): ChatEntryStorage | null {
  try {
    const holder = globalThis as { localStorage?: ChatEntryStorage | null }
    return holder.localStorage ?? null
  } catch {
    // 某些隐私模式访问 localStorage 本身会抛：一律当「没有 storage」
    return null
  }
}

/**
 * 读当前形态。**默认「每条消息」**：storage 不可用 / 键不存在 / 值非法一律回缺省。
 * 每次调用都重读一次（不缓存在模块里）：用户改了开关，下一次注册/渲染即生效，
 * 不存在「模块级快照把语言/偏好钉死在加载期」那类漂移。
 */
export function readChatEntryMode(): ChatEntryMode {
  const storage = browserStorage()
  if (storage === null) return CHAT_ENTRY_MODE_DEFAULT
  try {
    const raw = storage.getItem(CHAT_ENTRY_MODE_KEY)
    return isChatEntryMode(raw) ? raw : CHAT_ENTRY_MODE_DEFAULT
  } catch {
    return CHAT_ENTRY_MODE_DEFAULT
  }
}

/**
 * 形态变化的**进程内**订阅面（热切换用）。
 *
 * 为什么需要它：槽位登记是**装配期**行为（`ctx.slots.inject` 的回调只在声明到位时跑一次），
 * 偏好若只被读一次，用户在面板上把「每条消息」切到「整回合」就会**没有任何反应**（要刷新页面）。
 * 这里的订阅让 `mountChatNodeEntry` 能在开关变化时重新评估「注册 / 不注册」。
 *
 * 边界（如实）：只有走 `writeChatEntryMode` 的写入才会通知进程 —— 面板（T2）**必须**用这个函数
 * 写；若外部直接改 localStorage，则仍是「下次加载生效」（跨标签页的 storage 事件不在本次范围）。
 */
const modeListeners = new Set<(mode: ChatEntryMode) => void>()

/** 订阅形态变化；返回退订函数。 */
export function subscribeChatEntryMode(listener: (mode: ChatEntryMode) => void): () => void {
  modeListeners.add(listener)
  return () => { modeListeners.delete(listener) }
}

/**
 * 写当前形态。storage 写失败（隐私模式 / 配额）**不抛**，返回 false 让调用方如实降级
 * （界面提示「本次生效、但没有记住」由面板侧决定，T2 scope）。
 *
 * 写成功且**值真的变了**才通知订阅者：面板重放同一个值时不会引发一次多余的重新登记。
 */
export function writeChatEntryMode(mode: ChatEntryMode): boolean {
  const previous = readChatEntryMode()
  const storage = browserStorage()
  if (storage === null) return false
  try {
    storage.setItem(CHAT_ENTRY_MODE_KEY, mode)
  } catch {
    return false
  }
  if (previous !== mode) for (const listener of [...modeListeners]) listener(mode)
  return true
}
