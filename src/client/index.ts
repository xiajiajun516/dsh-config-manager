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
import { SyncApi } from './sync/sync-api.ts'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { en as syncEn, zh as syncZh, type SyncKey } from './sync/sync-locales.ts'

/** 本插件拥有的 locale namespace。 */
const NS = 'config-manager'
/** 远程同步设置区块的独立 locale namespace（独立字典文件，不与共享 locales.ts 冲突）。 */
const SYNC_NS = 'config-manager-sync'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Config Manager 表面文案。 */
    'config-manager': ConfigManagerKey
    /** 远程同步设置区块文案（m-sync-ui）。 */
    'config-manager-sync': SyncKey
  }
}

/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
export const inject = ['slots', 'locale']

/** 类型面（导出纪律：除插件契约外无值导出）。 */
export type { ConfigManagerSectionProps } from './ConfigManagerSection.tsx'
export type { ExportViewProps } from './export/ExportView.tsx'
export type { ImportWizardViewProps } from './import/ImportWizardView.tsx'
export type { SyncSettingsViewProps } from './sync/SyncSettingsView.tsx'
export type { ConfigManagerApiError, DownloadResult, ServiceStatus, UploadResponse } from './api.ts'
export type { ConfigManagerKey } from './locales.ts'
export type { SyncKey } from './sync/sync-locales.ts'

/**
 * 注册 Config Manager 设置页。
 * @param ctx - client root context（slots + locale 服务）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'config-manager: dictionaries')
  ctx.effect(() => ctx.locale.register(SYNC_NS, { zh: syncZh, en: syncEn }), 'config-manager: sync dictionaries')

  const t = ctx.locale.bind(NS)
  const api = new ConfigManagerApi()
  const syncT = ctx.locale.bind(SYNC_NS)
  const syncApi = new SyncApi()

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-manager',
    order: 60,
    label: () => t('section.label'),
    locale: NS,
    inject: () => ({ api }),
  }, ConfigManagerSection))

  // m-sync-ui：远程同步独立设置页（不触碰 ConfigManagerSection 的 tab 容器）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-manager-sync',
    order: 70,
    label: () => syncT('section.label'),
    locale: SYNC_NS,
    inject: () => ({ api: syncApi }),
  }, SyncSettingsView))
}
