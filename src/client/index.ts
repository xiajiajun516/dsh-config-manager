/**
 * dsh-config-manager 浏览器半入口 —— 运行在 dsh web GUI 内。
 *
 * 注册：
 *  1. `config-manager` locale 字典（zh 主源 / en 镜像）；
 *  2. `settings.section` 设置页（id: config-manager, label: 备份与迁移 / Backup & Migration）。
 *
 * 挂载方式：settings.section 是官方 Slot（list/root，owner props 为 { close }），
 * 经 `ctx.slots.inject(...)` 声明感知注册 —— 与 dsh-plugin-marketplace 注册
 * `settings.plugins.tab`、ui-settings-general 注册 `settings.section` 完全同构
 * （声明未到 ledger 前不注册，声明塌缩时自动移除，重声明后自动重挂）。
 *
 * 导出纪律（dsh-ssh packages/client 规则）：/client 面只携带 cordis 装载所需 +
 * 类型；所有值导出保持内部。
 */
import type { ReactNode } from 'react'
import type { ClientContext } from './client-types.ts'
// Type-only：拉入 ctx.locale 的 Context 合并（dsh-client-locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：拉入 settings.section 的 SlotMap 合并（dsh-client-ui-settings）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：拉入 SlotMap / LocaleNamespaceMap 合并表（dsh-client-ui-slots）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ConfigManagerApi } from './api.ts'
import { ConfigManagerSection } from './ConfigManagerSection.tsx'
import { en, zh, type ConfigManagerKey } from './locales.ts'
import { makeLiveUiT, setUiLanguageSource, type UiT } from '../ui/i18n.ts'
import { SyncApi } from './sync/sync-api.ts'
import { en as syncEn, zh as syncZh, type SyncKey } from './sync/sync-locales.ts'
import { MarketApi } from './market/market-api.ts'
import { MyConfigsApi } from './market/my-configs-api.ts'
import { en as marketEn, zh as marketZh, type MarketKey } from './market/market-locales.ts'
import { RecoveryApi } from './recovery/recovery-api.ts'
import { en as recoveryEn, zh as recoveryZh, type RecoveryKey } from './recovery/recovery-locales.ts'
import { HistoryApi } from './history/history-api.ts'
import { IncidentApi } from './recovery/incident-api.ts'
import { en as historyEn, zh as historyZh, type HistoryKey } from './history/history-locales.ts'
import { en as chatEn, zh as chatZh, type ChatKey } from './chat/chat-locales.ts'
import { ChatEntryNodeView, type ChatEntryViewInjected } from './chat/ChatEntryView.tsx'
import {
  archiveParentSession,
  buildSessionNavigator,
  navigationSourcesOf,
  openChildSession,
  startFreshSession,
  type ArchiveOutcome,
  type ChildOpenState,
} from './chat/rollback-entry-view.ts'
import { CHAT_NODE_PRIORITY, CHAT_NODE_SLOT, CHAT_NODE_USER_KEY } from './chat/chat-entry-view.ts'
import { registerChatNodeEntryWhenEnabled } from './chat/chat-node-registration.ts'
import { isRollbackEntryEnabled, setRollbackEntryEnabled, subscribeRollbackEntryEnabled } from './recovery/rollback-enabled.ts'
import { rollbackEntryVisible } from '../ui/rollback-view.ts'
import { RollbackDiffTab, RollbackDiffTabTitle } from './chat/RollbackDiffTab.tsx'
import {
  asSidebarRightFace,
  asSidebarRightTabsFace,
  declaredPaneTabKind,
  openRollbackDiff,
  rollbackDiffAddress,
  rollbackDiffTabDefinition,
  ROLLBACK_DIFF_SLOT,
  ROLLBACK_DIFF_TAB_ID,
  ROLLBACK_DIFF_TITLE_SLOT,
  type RollbackDiffOpenResult,
} from './chat/rollback-diff-tab.ts'
import type {} from './chat/sidebar-slots.ts'
// 槽位契约的类型镜像（SlotMap / SessionStandardProps 声明合并）：
// 注册 `conversation.chat.node`（user cell）前必须加载。
import type {} from './chat/chat-slots.ts'

/** 本插件拥有的 locale namespace。 */
const NS = 'config-manager'
/** 远程同步设置区块的独立 locale namespace（独立字典文件，不与共享 locales.ts 冲突）。 */
const SYNC_NS = 'config-manager-sync'
/** 配置市场区块的独立 locale namespace（m-market-ui）。 */
const MARKET_NS = 'config-manager-market'
/** Recovery 区块的独立 locale namespace（Phase 5）。 */
const RECOVERY_NS = 'config-manager-recovery'
/** Migration History 区块的独立 locale namespace（Phase 6）。 */
const HISTORY_NS = 'config-manager-history'
/** 聊天内「↺ 回退」入口的独立 locale namespace（T4；回退词汇仍复用 recovery 字典）。 */
const CHAT_NS = 'config-manager-chat'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Config Manager 表面文案。 */
    'config-manager': ConfigManagerKey
    /** 远程同步设置区块文案（m-sync-ui）。 */
    'config-manager-sync': SyncKey
    /** 配置市场区块文案（m-market-ui）。 */
    'config-manager-market': MarketKey
    /** Recovery 区块文案（Phase 5）。 */
    'config-manager-recovery': RecoveryKey
    /** Migration History 区块文案（Phase 6）。 */
    'config-manager-history': HistoryKey
    /** 聊天内「↺ 回退」入口文案（T4；只放聊天入口独有的话）。 */
    'config-manager-chat': ChatKey
  }
}

/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
export const inject = ['slots', 'locale']

/** 类型面（导出纪律：除插件契约外无值导出）。 */
export type { ConfigManagerSectionProps } from './ConfigManagerSection.tsx'
export type { ExportViewProps } from './export/ExportView.tsx'
export type { ImportWizardViewProps } from './import/ImportWizardView.tsx'
export type { SyncPanelProps } from './sync/SyncPanel.tsx'
export type { MarketPanelProps } from './market/MarketPanel.tsx'
export type { AboutPanelProps } from './about/AboutPanel.tsx'
export type { ConfigManagerApiError, DownloadResult, ServiceStatus, UploadResponse } from './api.ts'
export type { ConfigManagerKey } from './locales.ts'
export type { SyncKey } from './sync/sync-locales.ts'
export type { MarketKey } from './market/market-locales.ts'
export type { RecoveryKey } from './recovery/recovery-locales.ts'
export type { HistoryKey } from './history/history-locales.ts'
export type { ChatKey } from './chat/chat-locales.ts'

/**
 * 注册 Config Manager 设置页。
 * @param ctx - client root context（slots + locale 服务）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'config-manager: dictionaries')
  ctx.effect(() => ctx.locale.register(SYNC_NS, { zh: syncZh, en: syncEn }), 'config-manager: sync dictionaries')
  ctx.effect(() => ctx.locale.register(MARKET_NS, { zh: marketZh, en: marketEn }), 'config-manager: market dictionaries')
  ctx.effect(() => ctx.locale.register(RECOVERY_NS, { zh: recoveryZh, en: recoveryEn }), 'config-manager: recovery dictionaries')
  ctx.effect(() => ctx.locale.register(HISTORY_NS, { zh: historyZh, en: historyEn }), 'config-manager: history dictionaries')
  ctx.effect(() => ctx.locale.register(CHAT_NS, { zh: chatZh, en: chatEn }), 'config-manager: chat dictionaries')

  const t = ctx.locale.bind(NS)
  // 客户端展示层（报告/错误/进度/sync-view/market-view）翻译器：**每次取文案时**读当前 DSH locale。
  // 此前用的是加载期快照构造器 makeUiT（把语言钉死在 apply() 那一刻）—— 用户切到 English 后文案恒为中文；
  // 非 'zh' 的语言一律回落 en（英文界面不得回落中文）。
  const readLanguage = (): string => ctx.locale.getLocale().active
  // 模块级单例（runStore 等）用同一个活源：它们没有调用方可以传 UiT。
  setUiLanguageSource(readLanguage)
  const uiT: UiT = makeLiveUiT(readLanguage)
  const api = new ConfigManagerApi(uiT)
  const syncT = ctx.locale.bind(SYNC_NS)
  const syncApi = new SyncApi(uiT)
  const marketT = ctx.locale.bind(MARKET_NS)
  const marketApi = new MarketApi(uiT)
  const myConfigsApi = new MyConfigsApi(uiT)
  const recoveryT = ctx.locale.bind(RECOVERY_NS)
  const recoveryApi = new RecoveryApi(uiT)
  const historyT = ctx.locale.bind(HISTORY_NS)
  const historyApi = new HistoryApi(uiT)
  // 事故恢复（崩溃归因 / 救援模式）：沿用主字典的错误文案，不新增 locale namespace。
  const incidentApi = new IncidentApi(uiT)

  /**
   * issue #88：回合自动留点（回滚点）开关 → 聊天入口可见性。
   *
   * **必须在这里拉，不能等用户打开「环境 → 维护与诊断」**：入口是遮蔽 `conversation.chat.node`
   * 的 user key 注册的（无常），而绝大多数用户一辈子不会点进那个面板 —— 等那时再拉，
   * 功能开着却没有入口。这里挂载即拉一次（只读、无副作用），失败**不改信号**（保持缺省关闭），
   * 并留一条 warn 级日志便于排障。
   *
   * 判据读的是 storage 响应（`rollbackEntryVisible`：老宿主没有该字段 ⇒ 按「默认开」，与那一版语义一致）。
   *
   * 2026-10-17 起这条信号还决定**要不要接管用户消息气泡**（不再只是按钮可见性）：信号为假时
   * `registerChatNodeEntryWhenEnabled` 一次都不登记，那条 cell 由宿主 `UserMessageNodeView` 原生渲染
   * —— 与「关掉功能后连查询都不发」同一条口径：关掉 = 整条入口链路不存在。
   */
  void recoveryApi.rollbackPointStorage?.().then(
    (status) => { setRollbackEntryEnabled(rollbackEntryVisible(status)) },
    (err: unknown) => {
      // 只记日志、不打扰用户：这是纯可见性探测，读失败不该在设置页弹错误
      ctx.logger?.warn?.('rollback entry visibility probe failed: ' + (err instanceof Error ? err.message : String(err)))
    },
  )

  // 单一 settings.section：备份与迁移页（UI v3：4 个一级页面 home/library/sync/environment + Task 流程面板）。
  // 远程同步、配置市场与关于页不注册独立设置页 —— 并入主 section 的 inject 面
  // （syncApi/syncT、marketApi/marketT、myConfigsApi），由 ConfigManagerSection 渲染第 4/5/6 个 tab。
  // 避免第二个 settings.section 注册在目标 DSH 渲染 section 列表时抛错导致整页空白。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-manager',
    order: 60,
    label: () => t('section.label'),
    locale: NS,
    inject: () => ({ api, syncApi, syncT, marketApi, marketT, myConfigsApi, recoveryApi, recoveryT, historyApi, historyT, incidentApi, uiT }),
  }, ConfigManagerSection))

  // 会话导航面惰取（**不用** `ctx.<svc>` 属性访问：未在 inject 里声明的服务做属性访问会抛，见 AGENTS.md 的 DI 纪律）：
  //   真机 0.2 = `ctx.uiWorkspace.openSession(childId)`（ui-chat 自己的 fork 流程同款，证据见 T20 output §F1）；
  //   旧版兼容 = `ctx.sessions.open`（**存在才用** —— 0.2 的 sessions 面没有 open，绝不能包一个必然抛的包装）；
  //   列表/刷新 = `ctx.sessions.list/refresh`（两种版本都有那一半）。
  // 类型上必须过一层 unknown：宿主包与客户端包都往 cordis 的 Context 上合并过同名服务，
  // `get()` 解析到的可能是宿主那份；NavigationSources 只按用到的成员收窄（缺失 = 少一份能力）。
  // **取用时机 = 用户真的点「打开子会话」的那一刻**：服务可能比本插件晚挂载，装配期快照会把还没挂载的
  // uiWorkspace 记成「本客户端没有导航入口」（假降级）。每次调用重读一次（只读 get，代价可忽略）。
  const openChild = (childId: string): Promise<ChildOpenState> =>
    openChildSession(buildSessionNavigator(navigationSourcesOf(ctx)), childId)

  /**
   * A（无感替换）最后一步：把**原会话**收进「已归档」——列表里只剩「退回去的那条对话」。
   * 与 openChild 同一条纪律：调用那一刻惰取服务（服务可能比本插件晚挂载），缺能力如实降级。
   */
  const archiveParent = (sessionId: string): Promise<ArchiveOutcome> =>
    archiveParentSession(navigationSourcesOf(ctx).workspaces, sessionId)

  /**
   * 两个聊天入口共用的**同一份注入面**（端口 + 回退词汇 + 子会话导航）。
   *
   * 端口 = T2 的 RecoveryApi（组件绝不直接 fetch）；`rt` = recovery 字典（rollback.* 词汇单点）；
   * 子会话导航**可选**：`ctx.sessions` 缺失时入口仍可回退，只是不能自动打开子会话并如实降级。
   */
  /**
   * 惰取一个可选客户端服务（**绝不做属性访问**：未在 inject 里声明的服务属性访问会抛，见 AGENTS.md 的 DI 纪律）。
   */
  const readService = (key: string): unknown => {
    try {
      const get = (ctx as unknown as { get?: (k: string) => unknown }).get
      return typeof get === 'function' ? get.call(ctx, key) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 「查看」的打开动作：**每次调用重读服务**（服务可能比本插件晚挂载；装配期快照会把还没挂载的
   * 侧栏记成「本客户端没有侧栏」——那是假降级，真机教训见 AGENTS.md 的惰取纪律）。
   */
  const openDiffFile = (pointId: string, filePath: string): RollbackDiffOpenResult =>
    openRollbackDiff(asSidebarRightFace(readService('sidebarRight')), rollbackDiffAddress(pointId, filePath))

  /**
   * 文件类型图标（用户 2026-10-12 第 7 条）：**装了 dsh-better-sidebar 就用它的注册表**
   * （它把文件图标当 cordis 服务 `betterSidebar` 发布，`fileIcon(path, size)`；它自己的缺省档就是
   * DSH 的 FileTypeIcon 画法，所以用户的扩展图标也一起生效）。
   *
   * 与 `openDiffFile` 同一条惰取纪律：**每次渲染重读一次服务**（服务可能比本插件晚挂载），
   * 形态不符（没有该服务 / 没有 `fileIcon` 方法）一律返回 null ⇒ 对话框回落 DSH 自带的 FileTypeIcon。
   * **方法必须 bind 回服务对象**：抽出来的方法丢 receiver 会抛（uiWorkspace.openSession 真机事故，
   * 见 AGENTS.md 的惰取/bind 纪律）。
   */
  const fileIconFor = (filePath: string): ReactNode | null => {
    const service = readService('betterSidebar')
    if (typeof service !== 'object' || service === null) return null
    const icon = (service as { fileIcon?: unknown }).fileIcon
    if (typeof icon !== 'function') return null
    try {
      const node = (icon as (path: string, size: number) => ReactNode).call(service, filePath, 14)
      return node ?? null
    } catch {
      return null
    }
  }

  const chatEntryInjected = (_sessionId: string): ChatEntryViewInjected => ({
    port: recoveryApi,
    openDiff: openDiffFile,
    fileIcon: fileIconFor,
    rt: recoveryT,
    openChildSession: openChild,
    archiveParentSession: archiveParent,
    startFreshSession: () => startFreshSession(navigationSourcesOf(ctx).workspace),
  })

  /**
   * 聊天内「↺ 回退」入口 = **每条用户消息气泡里的那一颗**（2026-10-12 用户要求：入口只有这一种形态，
   * 旧的「整回合」档、偏好模块与回合尾入口 `conversation.chat.turnTail` 已整体删除）。
   *
   * 为什么只能**接管** `conversation.chat.node` 的 `user` key（而不是追加）：该 key **没有 children 表**
   * （宿主只对 turn-tail 声明了子位），framework 没有「往用户消息里加 UI」的位子 —— priority -1 遮蔽
   * 宿主 UserMessageNodeView 是唯一合法做法，那条气泡由我们自复刻。依据（含 -1 为何是唯一合法优先级）
   * → `src/client/chat/chat-slots.ts` 头部注释。
   *
   * **开关关着就完全不接管**（2026-10-17 用户要求）：登记由 `registerChatNodeEntryWhenEnabled` 驱动 ——
   * 关掉回合自动留点后让出 user cell，那条消息回到宿主原生气泡（旧实现是「登记常驻、只收起按钮」，
   * 气泡仍由我们代画，用户看到的就是「关掉了还在接管」）。开关重新打开时登记当场补上，不需要重载插件。
   *
   * 形态探测 + 失败软化在 `registerChatNodeEntry`：0.1.x 的 ui-chat 契约不同（非 keyed）或注册抛错，
   * 都只丢这一个入口，绝不打挂本插件其余槽位与宿主启动。
   */
  ctx.slots.inject(CHAT_NODE_SLOT, () => registerChatNodeEntryWhenEnabled({
    // 探测面两条都是只读：spec（形态）+ entriesOfSlot（user cell 当前赢家；老宿主可能没有该方法）。
    // 必须写成**成员调用**（obj.method?.()）：把方法抽出来单独调会丢 receiver —— 宿主实现里那句
    // this._core.entriesOfSlot(...) 会直接抛（同类真机事故：uiWorkspace.openSession 丢 receiver，见 AGENTS.md）。
    probe: {
      spec: (key) => ctx.slots.spec(key as typeof CHAT_NODE_SLOT),
      entriesOfSlot: (key) => (ctx.slots as unknown as { entriesOfSlot?: (slotKey: string) => unknown }).entriesOfSlot?.(key),
    },
    register: () => ctx.slots.register({
      name: CHAT_NODE_SLOT,
      key: CHAT_NODE_USER_KEY,
      priority: CHAT_NODE_PRIORITY,
      locale: CHAT_NS,
      inject: chatEntryInjected,
    }, ChatEntryNodeView),
    // 信号 = `rollbackEnabled` 的进程内投影（挂载时读一次；设置页改开关时再写一次）。
    // 订阅先建后读：登记只发生在真正需要它的那一刻，关掉即撤销（见 chat-node-registration.ts）。
    isEnabled: isRollbackEntryEnabled,
    subscribe: subscribeRollbackEntryEnabled,
  }))

  /**
   * ── 「查看」→ DSH 右侧栏「回滚差异」标签页（**只读**）──────────────────────────────
   *
   * 两件事彼此独立、各自可缺：
   *  ① **类型注册**（`ctx.sidebarRightTabs.register`）—— 侧栏才知道谁能认领我们的资源地址；
   *  ② **正文注册**（槽位 `sidebar.right.pane.tab` 的 keyed 位，key = 类型实现 id）。
   * 任何一件拿不到（旧版没有侧栏服务 / 槽位形态不符 / 注册抛错）都只丢「侧栏查看」这一个能力：
   * 预览对话框会据此**降级为弹窗内展示同一份差异**，并如实说明为什么（绝不假装打开过）。
   */
  let rollbackDiffTabRegistered = false
  const registerRollbackDiffTabType = (): void => {
    if (rollbackDiffTabRegistered) return
    const tabs = asSidebarRightTabsFace(readService('sidebarRightTabs'))
    if (tabs === undefined) return
    rollbackDiffTabRegistered = true
    ctx.effect(() => {
      const dispose = tabs.register(rollbackDiffTabDefinition())
      return typeof dispose === 'function' ? (dispose as () => void) : (): void => {}
    }, 'config-manager: rollback diff tab type')
  }
  registerRollbackDiffTabType()
  // 服务可能晚于本插件挂载：服务一到再试一次（自身做幂等，重复注册会抛，所以只认第一次成功）
  const injectServices = (ctx as unknown as { inject?: (deps: string[], cb: () => void) => unknown }).inject
  if (typeof injectServices === 'function') {
    try {
      injectServices.call(ctx, ['sidebarRightTabs'], () => { registerRollbackDiffTabType() })
    } catch {
      /* 该版本没有这个注入形态：只影响「服务晚挂载」这一种时序，装配期结果仍然有效 */
    }
  }

  ctx.slots.inject(ROLLBACK_DIFF_SLOT, () => {
    // 形态探测：只有 keyed 位才按 key 注册（0.1.x 没有这个槽位 ⇒ 不注册，只丢这一个能力）
    const kind = declaredPaneTabKind({ spec: (name) => ctx.slots.spec(name as 'sidebar.right.pane.tab') })
    if (kind !== 'keyed') return (): void => {}
    return ctx.slots.register({
      name: ROLLBACK_DIFF_SLOT,
      key: ROLLBACK_DIFF_TAB_ID,
      locale: RECOVERY_NS,
      inject: () => ({ port: recoveryApi, rt: recoveryT }),
    }, RollbackDiffTab)
  })

  /**
   * 芯片（标签条上的那颗标签）的内容位。
   *
   * 为什么单独注册：宿主的 tab 类型定义**没有 icon 字段**（芯片只由 title 文字画出来），
   * 「文件名前面那颗文件类型图标」只能由这个位子自己画；用户 2026-10-14 明确要求芯片上有图标。
   * 与正文位同一套纪律：形态探测不过 / 宿主没有这个位子 ⇒ 不注册（芯片退回宿主画的标题文字），
   * 只丢这一颗图标，不打挂插件其余槽位。
   */
  try {
    ctx.slots.inject(ROLLBACK_DIFF_TITLE_SLOT, () => {
      const kind = declaredPaneTabKind(
        { spec: (name) => ctx.slots.spec(name as 'sidebar.right.pane.tab.title') },
        ROLLBACK_DIFF_TITLE_SLOT,
      )
      if (kind !== 'keyed') return (): void => {}
      return ctx.slots.register({
        name: ROLLBACK_DIFF_TITLE_SLOT,
        key: ROLLBACK_DIFF_TAB_ID,
        inject: () => ({ fileIcon: fileIconFor }),
      }, RollbackDiffTabTitle)
    })
  } catch {
    /* 这台宿主的 slots 认不出芯片位（旧版 / 改名）：只丢这一颗图标，绝不连累其余槽位与插件装配 */
  }
}
