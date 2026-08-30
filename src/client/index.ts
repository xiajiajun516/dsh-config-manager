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
import { makeUiT, type UiT } from '../ui/i18n.ts'
import { SyncApi } from './sync/sync-api.ts'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { en as syncEn, zh as syncZh, type SyncKey } from './sync/sync-locales.ts'
import { MarketApi } from './market/market-api.ts'
import { MyConfigsApi } from './market/my-configs-api.ts'
import { MarketPanel } from './market/MarketPanel.tsx'
import { en as marketEn, zh as marketZh, type MarketKey } from './market/market-locales.ts'
import { RecoveryApi } from './recovery/recovery-api.ts'
import { en as recoveryEn, zh as recoveryZh, type RecoveryKey } from './recovery/recovery-locales.ts'
import { HistoryApi } from './history/history-api.ts'
import { en as historyEn, zh as historyZh, type HistoryKey } from './history/history-locales.ts'

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
  }
}

/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
export const inject = ['slots', 'locale']

/** 类型面（导出纪律：除插件契约外无值导出）。 */
export type { ConfigManagerSectionProps } from './ConfigManagerSection.tsx'
export type { ExportViewProps } from './export/ExportView.tsx'
export type { ImportWizardViewProps } from './import/ImportWizardView.tsx'
export type { SyncSettingsViewProps } from './sync/SyncSettingsView.tsx'
export type { MarketPanelProps } from './market/MarketPanel.tsx'
export type { AboutPanelProps } from './about/AboutPanel.tsx'
export type { ConfigManagerApiError, DownloadResult, ServiceStatus, UploadResponse } from './api.ts'
export type { ConfigManagerKey } from './locales.ts'
export type { SyncKey } from './sync/sync-locales.ts'
export type { MarketKey } from './market/market-locales.ts'
export type { RecoveryKey } from './recovery/recovery-locales.ts'
export type { HistoryKey } from './history/history-locales.ts'

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

  const t = ctx.locale.bind(NS)
  // 客户端展示层（报告/错误/进度/sync-view/market-view）翻译器：locale active 为 'en' 时用 en 目录。
  const uiT: UiT = makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')
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

  // 单一 settings.section：备份与迁移页（内部 Export/Import/Snapshots/Sync/Market/About 六 tab）。
  // 远程同步、配置市场与关于页不注册独立设置页 —— 并入主 section 的 inject 面
  // （syncApi/syncT、marketApi/marketT、myConfigsApi），由 ConfigManagerSection 渲染第 4/5/6 个 tab。
  // 避免第二个 settings.section 注册在目标 DSH 渲染 section 列表时抛错导致整页空白。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-manager',
    order: 60,
    label: () => t('section.label'),
    locale: NS,
    inject: () => ({ api, syncApi, syncT, marketApi, marketT, myConfigsApi, recoveryApi, recoveryT, historyApi, historyT }),
  }, ConfigManagerSection))
}
