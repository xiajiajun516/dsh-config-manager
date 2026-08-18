/**
 * 适配器 registry（设计 §12.1 / §3.3）：
 * 组装全部 ConfigAdapter（导出顺序参考 APPLY_ORDER：settings → ui → providers → prompts
 * → skills → agentPresets → agentInstructions → workspaces → pluginFiles → mcp → plugins → credentialsStatus）。
 *
 * 明确不实现的 adapter（研究报告 §2.2 确认 DSH 无对应概念）：keybindings / workflows / commands ——
 * manifest 中不出现这些 section，产品 UI 说明「DSH 当前无此配置」；
 * rules 概念已由 agentInstructions（~/.dsh/AGENTS.md）承接。
 */
import type { ConfigAdapter, HostContext } from '../core/types.ts';
import { SettingsAdapter, type NamespaceProvider } from './settings.ts';
import { UiAdapter } from './ui.ts';
import { ProvidersAdapter } from './providers.ts';
import { PluginsAdapter } from './plugins.ts';
import { McpAdapter } from './mcp.ts';
import { PromptsAdapter } from './prompts.ts';
import { SkillsAdapter } from './skills.ts';
import { AgentPresetsAdapter } from './agent-presets.ts';
import { AgentInstructionsAdapter } from './agent-instructions.ts';
import { WorkspacesAdapter } from './workspaces.ts';
import { CredentialsAdapter, type CredentialRefsProvider } from './credentials.ts';
import { PluginFilesAdapter } from './plugin-files.ts';
import { SessionsAdapter } from './sessions.ts';

export interface AdapterRegistryOptions {
  /** settings namespace 清单（宿主从 settings.yaml 顶层 key 解析注入；缺省 [] → settings/ui/credentials 为空） */
  namespaces?: string[] | NamespaceProvider;
  /** 凭据 ref 收集器（缺省从 settings secrets 标记 + llm apiKeyEnv 推断） */
  credentialsRefs?: CredentialRefsProvider;
  /** pluginFiles 白名单（相对 ~/.dsh 根；缺省 dsh-ssh.json + pet.json） */
  pluginFiles?: string[];
  /** 是否包含 sessions 分区（默认关，研究报告 §4.9） */
  includeSessions?: boolean;
  /** 插件自身包名：导出 plugins 分区时不列自己（避免自引用；缺省 dsh-config-manager） */
  selfPluginName?: string;
}

/** 组装默认 adapter 列表（pluginFiles/sessions 恒挂载但 defaultIncluded=false，用户勾选才导出） */
export function createAdapters(options: AdapterRegistryOptions = {}): ConfigAdapter[] {
  const namespaces = options.namespaces ?? [];
  const adapters: ConfigAdapter[] = [
    new SettingsAdapter(namespaces),
    new UiAdapter(namespaces),
    new ProvidersAdapter(),
    new PluginsAdapter(options.selfPluginName),
    new McpAdapter(),
    new PromptsAdapter(),
    new SkillsAdapter(),
    new AgentPresetsAdapter(),
    new AgentInstructionsAdapter(),
    new WorkspacesAdapter(),
    new CredentialsAdapter({ namespaces, refs: options.credentialsRefs }),
    new PluginFilesAdapter(options.pluginFiles),
  ];
  if (options.includeSessions) adapters.push(new SessionsAdapter());
  return adapters;
}

export type { NamespaceProvider } from './settings.ts';
export type { CredentialRefsProvider } from './credentials.ts';

export { SettingsAdapter } from './settings.ts';
export { UiAdapter, isUiNamespace, KNOWN_UI_NAMESPACE_PREFIXES, UI_MIGRATION_NOTES } from './ui.ts';
export { ProvidersAdapter, DEFAULT_PROVIDER_NAMESPACES, type ProviderExportEntry, type ProviderExportSection } from './providers.ts';
export { PluginsAdapter, USER_PATCH_FILE } from './plugins.ts';
export { McpAdapter, extractMcpServers, buildMcpPatchLine, type McpExportEntry, type McpExportSection } from './mcp.ts';
export { PromptsAdapter, extractPrompts, mergePromptIntoLine, buildPromptLine, type PromptExportEntry, type PromptsExportSection } from './prompts.ts';
export { SkillsAdapter } from './skills.ts';
export { AgentPresetsAdapter } from './agent-presets.ts';
export { AgentInstructionsAdapter } from './agent-instructions.ts';
export { WorkspacesAdapter } from './workspaces.ts';
export { CredentialsAdapter, defaultCredentialRefs } from './credentials.ts';
export { PluginFilesAdapter, DEFAULT_PLUGIN_FILE_WHITELIST } from './plugin-files.ts';
export { SessionsAdapter } from './sessions.ts';
export { FileCollectionAdapter } from './file-collection.ts';
