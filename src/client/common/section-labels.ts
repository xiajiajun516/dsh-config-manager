/**
 * 分区（SectionId）显示名的**单一映射** —— SectionId → config-manager 字典键（UI-08）。
 *
 * 为什么必须有这一层：同一个分区在同一个画布上曾经有三种叫法 ——
 *   1. 导出选择器用 export-flow 的英文 label（`Settings` / `Plugins` / `Credentials Status`），
 *      与中文界面的其余部分不一致（英文 label 属于纯逻辑层，见 `src/ui/export-flow.ts`）；
 *   2. 导入向导选择器根本没传 `sectionLabel`，退化为原样显示适配器 id（`pluginFiles`）；
 *   3. 兼容性页「备份包含的分区」网格同样是裸 id。
 * 「同屏术语漂移（同一概念多个名字）」是 `DESIGN.md` §9 anti-pattern 8 明令禁止的状态。
 *
 * 纪律：**用户可见的分区名只经本映射**。`ExportCategory.label`（export-flow）保留给
 * 报告文本 / 日志等非 UI 场合，不再作为界面显示名。
 *
 * `Record<SectionId, …>` 全量覆盖 ⇒ 新增分区忘记配文案会**编译失败**（不是运行时显示裸 id）。
 */
import type { SectionId } from '../../schema/types.ts'
import type { ConfigManagerKey } from '../locales.ts'
import type { TranslateNS } from '../client-types.ts'

/** SectionId → 字典键。 */
export const SECTION_LABEL_KEY: Record<SectionId, ConfigManagerKey> = {
  settings: 'section.settings',
  ui: 'section.ui',
  providers: 'section.providers',
  plugins: 'section.plugins',
  mcp: 'section.mcp',
  prompts: 'section.prompts',
  skills: 'section.skills',
  agentPresets: 'section.agentPresets',
  agentInstructions: 'section.agentInstructions',
  workspaces: 'section.workspaces',
  pluginFiles: 'section.pluginFiles',
  credentialsStatus: 'section.credentialsStatus',
  secrets: 'section.secrets',
  sessions: 'section.sessions',
  self: 'section.self',
}

/** 单个分区的显示名（缺键回退到裸 id，避免渲染出 undefined）。 */
export function sectionLabel(id: SectionId, t: TranslateNS<'config-manager'>): string {
  const key = SECTION_LABEL_KEY[id] as ConfigManagerKey | undefined
  return key === undefined ? id : t(key)
}

/**
 * `(id) => 显示名` 的装配器 —— 供 `ContentPicker.sectionLabel` /
 * `SectionComposition.sectionLabel` 这类回调 prop 直接使用（两个调用点同一个函数）。
 */
export function sectionLabeler(t: TranslateNS<'config-manager'>): (id: SectionId) => string {
  return (id) => sectionLabel(id, t)
}
