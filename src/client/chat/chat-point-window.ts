/**
 * 回滚点「收尾竞态窗口」的**状态机**（框架无关纯模块，node 可测）—— R1 的重试逻辑落点。
 *
 * ## 为什么单独一个模块（T6 的根因）
 *
 * T1 把重试循环与窗口状态都放在 React 组件的 effect 里，于是出现两个只能靠推理、无法断言的缺陷：
 *  · **F1（周期性重开）**：effect 依赖里含 `lookup`，而「窗口关且仍为空」时那次 `setLookup`
 *    写的是**新对象** ⇒ effect 重跑 ⇒ 守卫（只挡「已命中」）再次放行 ⇒ 又开一整轮窗口。
 *    挂载态下每 ~23 s 重读一遍，永久周期性打宿主。
 *  · **F2（无取消通道）**：cleanup 只 `clearTimeout`，循环里那个 `await` 永不 settle ⇒
 *    promise 悬空、pending 永不收敛（即便实测卸载后没有再打宿主）。
 *
 * 把状态机提到这里以后：窗口是**一次性的**（每个实例最多开一轮）、循环是可取消的，
 * 两条都能在 node 下用**可执行断言**钉住（见 chat-entry-view.test.ts 的 F1/F2 用例）；
 * 组件只负责「建实例 → 订阅状态 → dispose」，不再自己维护窗口标志。
 *
 * ## 三条不变量
 *
 *  ① **一个实例只跑一轮**：`start()` 幂等 —— 窗口关掉（命中或预算用尽）之后再调也什么都不做。
 *     「用户再次触发」= 重新挂载 / 会话或回合变化 ⇒ **新实例**（旧实例 dispose），所以不会永久锁死。
 *  ② **可取消**：`dispose()` 之后循环在下一次机会（读之前 / 等定时器时）立即 settle，
 *     不再发任何请求，也不再有悬挂的 await。
 *  ③ **诚实**：窗口开着时状态是 `open: true`（界面据此显示「正在读取」），
 *     窗口关且仍为空才 `open: false`（界面才可以说「没有回滚点」）。
 */
import { CHAT_POINT_LOOKUP_WINDOW_MS, CHAT_POINT_RETRY_DELAYS_MS, shouldRetryChatPoint } from './chat-entry-view.ts'
import type { ChatPointLookup } from './chat-entry-view.ts'

/**
 * 有界重试循环（**可取消**）。
 *
 * 读一次 → 没命中就按退避表等下一档（每一轮都让调用点 `force` 强制刷新，绕过那 30 s 列表缓存）
 * → 命中 / 退避表走完 / 窗口到期 / **被取消** 四者任一即停。没有第五种出口（不无限轮询）。
 *
 * `isCancelled` 在**每次读之前**与**每个定时器醒来时**各查一次：所以取消之后宿主读取次数不再增加、
 * 循环立即 settle（F2 的断言钉的就是这两件事）。
 *
 * @returns 末次结果 + 实际读取次数（首读算 1；有界：最多 `delays.length + 1` 次）
 */
export async function retryChatPointUntilHit(options: {
  /** 读一次（`force` = 跳过缓存读）。 */
  attempt: (force: boolean) => Promise<ChatPointLookup>
  /** 排下一次读取（缺省 `setTimeout`）；单测注入确定性队列。 */
  retry?: (fn: () => void, delayMs: number) => void
  /** 取当前时刻（缺省 `Date.now`）；单测注入假时钟。 */
  now?: () => number
  /** 取消钩子（T6/F2）：返回 true 时循环会在下一次机会立即结束。 */
  isCancelled?: () => boolean
  /** 退避表（缺省 {@link CHAT_POINT_RETRY_DELAYS_MS}）。 */
  delays?: readonly number[]
  /** 窗口长度（缺省 {@link CHAT_POINT_LOOKUP_WINDOW_MS}）。 */
  windowMs?: number
}): Promise<{ result: ChatPointLookup; reads: number }> {
  const schedule = options.retry ?? ((fn: () => void, delayMs: number) => { setTimeout(fn, delayMs) })
  const now = options.now ?? ((): number => Date.now())
  const cancelled = options.isCancelled ?? ((): boolean => false)
  const delays = options.delays ?? CHAT_POINT_RETRY_DELAYS_MS
  // 窗口至少留 1 ms：0 / 负数窗口在语义上是「一次都不重试」，不是「永远重试」
  const windowMs = Math.max(options.windowMs ?? CHAT_POINT_LOOKUP_WINDOW_MS, 1)
  const startedAt = now()
  let result: ChatPointLookup = { point: null, resolved: false }
  let reads = 0
  for (let i = 0; i <= delays.length; i += 1) {
    if (cancelled()) return { result, reads } // F2：取消后一次请求都不再发
    reads += 1
    // 首读 = 普通读（命中缓存就白读一次）；每一轮重试都强制刷新（跳过那 30 s 缓存）
    result = await options.attempt(i > 0)
    // 读在途期间被取消 ⇒ 立刻收尾：既不排下一次读、也不进下一轮（F2 的最早生效点）
    if (cancelled()) return { result, reads }
    if (!shouldRetryChatPoint(result)) return { result, reads } // 命中即停
    const delay = delays[i]
    if (delay === undefined) return { result, reads } // 退避表走完 ⇒ 有界结束
    if (now() - startedAt + delay >= windowMs) return { result, reads } // 窗口到期 ⇒ 有界结束
    const before = now()
    await new Promise<void>((resolve) => { schedule(resolve, delay) })
    // 排程器没让时间前进（时钟坏掉 / 站在原地的替身）⇒ 停下来，绝不落进无限重试
    if (now() <= before) return { result, reads }
    // 等定时器期间被取消 ⇒ 立即收尾（不再进下一轮读）
    if (cancelled()) return { result, reads }
  }
  return { result, reads }
}

/** 一个（会话 + 回合）当前已解析到的结果（`null` = 还没读到过任何东西）。 */
export interface ChatPointWindowState {
  /** 最近一次读的结果；`null` = 首读还没回来。 */
  lookup: ChatPointLookup | null
  /** 窗口是否还开着（开着 ⇒ 界面显示「正在读取」；关掉且仍为空 ⇒ 才可以说「没有回滚点」）。 */
  open: boolean
}

/**
 * **一次性**窗口状态机（F1 的修法：窗口状态不再由 React 状态派生、也不会被 effect 重跑重置）。
 *
 * 生命周期：`new` → `start()`（幂等，一次）→ 状态回调若干次（开窗 / 关窗）→ `dispose()`（取消，永久停手）。
 * 每个实例最多读 `CHAT_POINT_RETRY_DELAYS_MS.length + 1` = 6 次；窗口关掉**或** dispose 之后再 `start()` 都是 no-op。
 *
 * 调用方必须遵守的两条约定：
 *  · **一次 effect 调用 = 一个新实例**（组件在 effect 体内 `new`，而不是放在 memo 里跨调用复用）：
 *    React StrictMode 会走 `effect → cleanup → effect` 双调用。若实例复用，第二次 `start()` 会因
 *    `started` 已是 true 而变成 no-op，而被 dispose 的那个循环又永不回调 ⇒ 窗口**永久停在「正在读取」**
 *    （RR2-A）。每次 effect 各自建实例，这条死路就不存在。
 *  · 「用户再次触发」（重新挂载 / 会话或回合变化）= **新实例**，所以「一个实例只跑一轮」不会变成永久锁死（F1）。
 */
export interface ChatPointWindowOptions {
  /** 读一次（`force` = 跳过缓存读）—— 调用点绑好 port/sessionId/turn。 */
  attempt: (force: boolean) => Promise<ChatPointLookup>
  /** 每次状态变化都回调（`start()` 时先回调一次「窗口开着、还没结果」，收尾时再回调一次）。 */
  onState: (state: ChatPointWindowState) => void
  retry?: (fn: () => void, delayMs: number) => void
  now?: () => number
  delays?: readonly number[]
  windowMs?: number
}

export class ChatPointWindowController {
  private readonly options: ChatPointWindowOptions
  private readonly schedule: (fn: () => void, delayMs: number) => void
  private current: ChatPointWindowState = { lookup: null, open: false }
  private started = false
  private cancelled = false
  /** 默认排程器留下的待触发定时器（≤12 s）；dispose 清掉，避免悬空 timer 与晚到的回调 */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ChatPointWindowOptions) {
    // 参数属性（`constructor(private readonly x)`）会产出运行期语法，erasableSyntaxOnly 下不允许 —— 显式赋值
    this.options = options
    // 默认排程器把句柄留下来，dispose 时清掉（注入的 retry 由调用方自理）
    this.schedule = options.retry ?? ((fn: () => void, delayMs: number) => {
      this.pendingTimer = setTimeout(() => { this.pendingTimer = null; fn() }, delayMs)
    })
  }

  /** 当前状态（与最后一次 onState 回调同形）。 */
  state(): ChatPointWindowState {
    return this.current
  }

  /**
   * 取消并**永久停手**（F2 的取消通道）：循环在下一次机会（读之前 / 读回来时 / 定时器醒来时）立即 settle，
   * 此后一次请求都不再发；`cancelled` 守卫也让之后的 `start()` 永远是 no-op。
   *
   * **RR2-B：这里不回调 `onState`**，只把内部状态记为「关窗」（`open: false`，`lookup` 保留最后一次值）。
   * 理由：dispose 的调用点是**组件卸载 / 换会话 / StrictMode 的 cleanup** —— 此刻回调只会在卸载后
   * `setState`（本任务的硬约束之一）。需要终值的调用方直接读 `state()`。
   */
  dispose(): void {
    this.cancelled = true
    // 取消后**不再需要任何晚到的回调**：默认排程器的定时器一并清掉（注入的 retry 由调用方负责）
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.current = { lookup: this.current.lookup, open: false }
  }

  /**
   * 开这一轮窗口（**幂等**）：已经开过（started）或已 dispose 时什么都不做 ——
   * 这正是 F1 的修法：effect 重跑 / 状态回调重入都不会再开第二轮。
   */
  start(): void {
    if (this.started || this.cancelled) return
    this.started = true
    this.current = { lookup: null, open: true }
    this.options.onState(this.current)
    void this.run()
  }

  private async run(): Promise<void> {
    const { result: lookup } = await retryChatPointUntilHit({
      attempt: this.options.attempt,
      retry: this.schedule,
      now: this.options.now,
      // 取消钩子与 dispose 同源：没有第二个取消标志，也就没有第二处真相
      isCancelled: () => this.cancelled,
      delays: this.options.delays,
      windowMs: this.options.windowMs,
    })
    if (this.cancelled) return // 卸载路径：组件已不再需要任何状态回调
    this.current = { lookup, open: false }
    this.options.onState(this.current)
  }
}
