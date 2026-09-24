/**
 * 适配器 registry（设计 §12.1 / §3.3）：
 * 组装全部 ConfigAdapter（导出顺序参考 APPLY_ORDER：settings → ui → providers → prompts
 * → skills → agentPresets → agentInstructions → workspaces → pluginFiles → mcp → plugins → credentialsStatus）。
 *
 * 明确不实现的 adapter（研究报告 §2.2 确认 DSH 无对应概念）：keybindings / workflows / commands ——
 * manifest 中不出现这些 section，产品 UI 说明「DSH 当前无此配置」；
 * rules 概念已由 agentInstructions（~/.dsh/AGENTS.md）承接。
 */
import type { ConfigAdapter } from '../core/types.ts';
import { SettingsAdapter, type NamespaceProvider } from './settings.ts';
import { UiAdapter } from './ui.ts';
import { ProvidersAdapter } from './providers.ts';
import { PluginsAdapter, type LocalPluginPackHook } from './plugins.ts';
import { McpAdapter } from './mcp.ts';
import { PromptsAdapter } from './prompts.ts';
import { SkillsAdapter } from './skills.ts';
import { AgentPresetsAdapter } from './agent-presets.ts';
import { AgentInstructionsAdapter } from './agent-instructions.ts';
import { WorkspacesAdapter } from './workspaces.ts';
import { CredentialsAdapter, type CredentialRefsProvider } from './credentials.ts';
import { PluginFilesAdapter } from './plugin-files.ts';
import { SessionsAdapter } from './sessions.ts';
import { SelfAdapter } from './self.ts';

export interface AdapterRegistryOptions {
  /** settings namespace 清单（宿主从 settings.yaml 顶层 key 解析注入；缺省 [] → settings/ui/credentials 为空） */
  namespaces?: string[] | NamespaceProvider;
  /** 凭据 ref 收集器（缺省从 settings secrets 标记 + llm apiKeyEnv 推断） */
  credentialsRefs?: CredentialRefsProvider;
  /** pluginFiles 白名单（相对 ~/.dsh 根；缺省 dsh-ssh.json + pet.json） */
  pluginFiles?: string[];
  /** pluginFiles 约定的配置目录（相对 ~/.dsh 根），递归收集其下所有插件配置文件 */
  pluginFilesDir?: string;
  /** 是否包含 sessions 分区（默认关，研究报告 §4.9） */
  includeSessions?: boolean;
  /** 插件自身包名：导出 plugins 分区时不列自己（避免自引用；缺省 dsh-config-manager） */
  selfPluginName?: string;
  /**
   * T1：本地源（link:/file:）插件打包钩子。注入后，导出 plugins 分区时会为这类插件
   * 执行 `npm pack` 并把 tarball 随备份带走；不注入 = 保持改造前行为（本地插件换机丢失）。
   */
  localPluginPack?: LocalPluginPackHook;
  /**
   * self 分区：插件自身配置目录（相对 ~/.dsh 根，如 'dsh-config-manager'）。
   * 缺省 'dsh-config-manager'；传入 '' 表示不挂载（宿主自定义 dataDir 在 homeDir 外时）。
   */
  selfDir?: string;
}

/** 组装默认 adapter 列表（pluginFiles/sessions 恒挂载但 defaultIncluded=false，用户勾选才导出） */
export function createAdapters(options: AdapterRegistryOptions = {}): ConfigAdapter[] {
  const namespaces = options.namespaces ?? [];
  const adapters: ConfigAdapter[] = [
    new SettingsAdapter(namespaces),
    new UiAdapter(namespaces),
    new ProvidersAdapter(),
    new PluginsAdapter(options.selfPluginName, options.localPluginPack),
    new McpAdapter(),
    new PromptsAdapter(),
    new SkillsAdapter(),
    new AgentPresetsAdapter(),
    new AgentInstructionsAdapter(),
    new WorkspacesAdapter(),
    new CredentialsAdapter({ namespaces, refs: options.credentialsRefs }),
    new PluginFilesAdapter(options.pluginFiles, options.pluginFilesDir),
  ];
  // self 分区：插件自身配置（同步/市场/偏好），portable 默认包含；'' = 不挂载
  if (options.selfDir !== '') {
    adapters.push(new SelfAdapter(options.selfDir ?? 'dsh-config-manager'));
  }
  if (options.includeSessions) adapters.push(new SessionsAdapter());
  return adapters;
}

export type { NamespaceProvider } from './settings.ts';
export type { CredentialRefsProvider } from './credentials.ts';

export { SettingsAdapter } from './settings.ts';
export { UiAdapter, isUiNamespace, KNOWN_UI_NAMESPACE_PREFIXES, UI_MIGRATION_NOTES } from './ui.ts';
export { ProvidersAdapter, DEFAULT_PROVIDER_NAMESPACES, type ProviderExportEntry, type ProviderExportSection } from './providers.ts';
export { PluginsAdapter, USER_PATCH_FILE } from './plugins.ts';
export type { LocalPluginPackHook } from './plugins.ts';
export { McpAdapter, extractMcpServers, buildMcpPatchLine, type McpExportEntry, type McpExportSection } from './mcp.ts';
export { PromptsAdapter, extractPrompts, mergePromptIntoLine, buildPromptLine, type PromptExportEntry, type PromptsExportSection } from './prompts.ts';
export { SkillsAdapter } from './skills.ts';
export { AgentPresetsAdapter } from './agent-presets.ts';
export { AgentInstructionsAdapter } from './agent-instructions.ts';
export { WorkspacesAdapter } from './workspaces.ts';
export { CredentialsAdapter, defaultCredentialRefs } from './credentials.ts';
export { PluginFilesAdapter, DEFAULT_PLUGIN_FILE_WHITELIST } from './plugin-files.ts';
export { SessionsAdapter } from './sessions.ts';
export { SelfAdapter, SELF_CONFIG_FILES } from './self.ts';
export { FileCollectionAdapter } from './file-collection.ts';
/* JSON 分区共享校验骨架（本导出是其接入点）。收敛轨迹：
 *  · t31 抽出骨架，settings / ui / providers / plugins / mcp / prompts / credentials /
 *    pluginFiles 八个分区的样板并入；
 *  · t7 接上 workspaces.ts 与 file-collection.ts 基类的 version 守卫 + 形状检查收尾；
 *  · t11 给骨架加了可选第 6 参 `objectMessageKey`（object 错误的文案键，缺省
 *    `adapter.validate.object`），file-collection 的 object 守卫也并入并沿用文件类分区原专用键
 *    `adapter.validate.fileSection`，故 5 个文件类分区的用户可见报错文案逐字不变。
 * 现状：**9 个分区全部走共享骨架**（settings / ui / providers / plugins / mcp / prompts /
 * credentialsStatus / pluginFiles / workspaces），文件类基类（skills / agentPresets /
 * agentInstructions / sessions / self）同样走它 —— src/adapters 下不再有任何手写 validate 样板。 */
export { validateJsonSection, type SectionIssues } from './json-section.ts';
