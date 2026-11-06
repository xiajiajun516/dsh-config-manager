/**
 * Client 半的类型集中出口：把对 @deepseek-ai 运行时包的类型依赖收敛到本文件，
 * 其余组件只从 `../client-types.ts` 引用，避免类型散落与误用值导入。
 *
 * p3 构建前需安装的依赖（见 docs/architecture/client-dependencies.md）：
 *   - @deepseek-ai/dsh-client-runtime（ClientContext 声明合并）
 *   - @deepseek-ai/dsh-client-locale（ctx.locale 声明合并）
 *   - @deepseek-ai/dsh-client-ui-settings（settings.section SlotMap 声明合并）
 *   - @deepseek-ai/dsh-client-ui-slots（SlotMap / LocaleNamespaceMap / TranslateNS）
 *   - @deepseek-ai/cordis（Context 基础类型）
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export type { ClientContext }
export type { TranslateNS }

/** 本插件 Client 半的注入业务面：每个 settings.section 注册项都拿到同一个 api 实例 */
export interface ConfigManagerSectionInjected {
  api: import('./api.ts').ConfigManagerApi
  /** 远程同步 API（备份与迁移页第 4 个 tab 使用，主 section 注册时注入） */
  syncApi: import('./sync/sync-api.ts').SyncApi
  /** 远程同步 locale（config-manager-sync 命名空间，主 section 注册时注入） */
  syncT: import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'config-manager-sync'>
  /** 配置市场 API（备份与迁移页第 5 个 tab 使用，主 section 注册时注入） */
  marketApi: import('./market/market-api.ts').MarketApi
  /** 「我的配置」API（MarketPanel 的「我的配置」子视图使用，主 section 注册时注入） */
  myConfigsApi: import('./market/my-configs-api.ts').MyConfigsApi
  /** 配置市场 locale（config-manager-market 命名空间，主 section 注册时注入） */
  marketT: import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'config-manager-market'>
  /** Recovery API（Phase 5：引导式恢复工作流；主 section 注册时注入） */
  recoveryApi: import('./recovery/recovery-api.ts').RecoveryApi
  /** Recovery locale（config-manager-recovery 命名空间，主 section 注册时注入） */
  recoveryT: import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'config-manager-recovery'>
  /** Migration History API（Phase 6：统一审计史；主 section 注册时注入） */
  historyApi: import('./history/history-api.ts').HistoryApi
  /** 事故恢复 API（崩溃归因 + 救援模式；主 section 注册时注入，RecoveryPanel 消费） */
  incidentApi: import('./recovery/incident-api.ts').IncidentApi
  /** Migration History locale（config-manager-history 命名空间，主 section 注册时注入） */
  historyT: import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'config-manager-history'>
  /**
   * 客户端展示层翻译器（`src/ui/i18n.ts` 的 UiT）：行内/报告类文案用它，设置页文案用 t。
   * **两本字典键域不同**，同名键（如 library.title）在两边各写一次不算重复。
   */
  uiT: import('../ui/i18n.ts').UiT
}
