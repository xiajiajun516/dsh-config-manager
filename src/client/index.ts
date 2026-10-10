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
import { RollbackTurnEntry, type RollbackTurnEntryInjected } from './chat/RollbackTurnEntry.tsx'
import { ChatEntryNodeView, type ChatEntryViewInjected } from './chat/ChatEntryView.tsx'
import {
  buildSessionNavigator,
  CHAT_ENTRY_ID,
  CHAT_ENTRY_ORDER,
  CHAT_ENTRY_SLOT,
  navigationSourcesOf,
  openChildSession,
  registerChatEntry,
  type ChildOpenState,
} from './chat/rollback-entry-view.ts'
import { CHAT_NODE_PRIORITY, CHAT_NODE_SLOT, CHAT_NODE_USER_KEY } from './chat/chat-entry-view.ts'
import { mountChatNodeEntry } from './chat/chat-node-registration.ts'
// 槽位契约的类型镜像（SlotMap / SessionStandardProps 声明合并）：
// 注册 `conversation.chat.node`（user cell）与 `conversation.chat.turnTail` 前都必须加载。
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
   * 两个聊天入口共用的**同一份注入面**（端口 + 回退词汇 + 子会话导航）。
   *
   * 端口 = T2 的 RecoveryApi（组件绝不直接 fetch）；`rt` = recovery 字典（rollback.* 词汇单点）；
   * 子会话导航**可选**：`ctx.sessions` 缺失时入口仍可回退，只是不能自动打开子会话并如实降级。
   */
  const chatEntryInjected = (_sessionId: string): ChatEntryViewInjected & RollbackTurnEntryInjected => ({
    port: recoveryApi,
    rt: recoveryT,
    openChildSession: openChild,
  })

  /**
   * **主入口**（T1）：接管 `conversation.chat.node` 的 `user` key —— 每条用户消息一颗「回退」按钮。
   *
   * 为什么只能接管：该 key **没有 children 表**（宿主只对 turn-tail 声明了子位），framework 没有
   * 「往用户消息里追加 UI」的位子。priority **-1** 遮蔽宿主的 UserMessageNodeView（同 key 同 priority
   * 会抛，所以 -1 是与宿主并存的唯一合法取值），气泡外观由本仓库复刻（宿主组件与 CSS Modules 都
   * 是 ui-chat 私有、不可导入）。完整证据见 `src/client/chat/chat-slots.ts` 头部注释。
   *
   * **偏好门**：偏好 = 「整回合」时 `registerChatNodeEntry` **一次都不注册**（宿主渲染器原样工作，
   * 入口退回下面的回合尾 list 位）；形态探测失败（0.1.x 契约不同）同样只跳过这一个入口。
   */
  ctx.slots.inject(CHAT_NODE_SLOT, () => mountChatNodeEntry({
    probe: { spec: (key) => ctx.slots.spec(key as typeof CHAT_NODE_SLOT) },
    register: () => ctx.slots.register({
      name: CHAT_NODE_SLOT,
      key: CHAT_NODE_USER_KEY,
      priority: CHAT_NODE_PRIORITY,
      locale: CHAT_NS,
      inject: chatEntryInjected,
    }, ChatEntryNodeView),
  }))

  /**
   * **兜底入口**（T4，保留不动）：ui-chat 的回合尾 list 位（`conversation.chat.turnTail`）。
   *
   * 与主入口的分工：偏好为「整回合」时，这里就是唯一的入口（整回合一个）；偏好为「每条消息」时
   * 两个入口同时在 —— 回合尾那颗的语义没变（回退这个回合），两条路径打开的是**同一个**复核对话框。
   *
   * 选型 = 追加一个 list 条目（**新 id**，replaceRisk: none，不遮蔽任何 shipped UI）。
   */
  ctx.slots.inject(CHAT_ENTRY_SLOT, () => registerChatEntry({
    // 声明形态探测（T9-F2）：0.1.x 把同一 key 声明成 chain（select 必填），按 list 形态（id/order）注册会抛。
    probe: { spec: (key) => ctx.slots.spec(key) },
    register: () => ctx.slots.register({
      name: CHAT_ENTRY_SLOT,
      id: CHAT_ENTRY_ID,
      order: CHAT_ENTRY_ORDER,
      locale: CHAT_NS,
      inject: chatEntryInjected,
    }, RollbackTurnEntry),
  }))
}
