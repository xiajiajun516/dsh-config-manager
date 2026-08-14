/**
 * Client 半的类型集中出口：把对 @deepseek-ai 运行时包的类型依赖收敛到本文件，
 * 其余组件只从 `../client-types.ts` 引用，避免类型散落与误用值导入。
 *
 * p3 构建前需安装的依赖（见 CLIENT_DEPENDENCIES.md）：
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

/** settings.section 注册项的 owner props（shell 传入 close） */
export interface SettingsSectionProps {
  /** 关闭设置面板（shell 拥有 open 状态） */
  close: () => void
}

/** 本插件 Client 半的注入业务面：每个 settings.section 注册项都拿到同一个 api 实例 */
export interface ConfigManagerSectionInjected {
  api: import('./api.ts').ConfigManagerApi
}
