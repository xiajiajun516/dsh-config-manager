/**
 * 各分区数据结构：ZIP 内 JSON 分区文件 → 解析/校验，以及分区文件路径表。
 * 类型本体在 types.ts；本文件是「分区数据如何落盘/读回」的唯一出口。
 */
import { parseJsonSafe } from '../utils/json.ts';
import type {
  CredentialsSection, FilesSection, McpSection, PluginsSection,
  PromptsSection, ProvidersSection, SectionData, SectionId,
  SettingsSection, UiSection, WorkspacesSection,
} from './types.ts';

/** 全部分区 id（manifest 校验与 adapter registry 共用） */
export const SECTION_IDS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts',
  'skills', 'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles',
  'credentialsStatus', 'secrets', 'sessions', 'self',
];

/** JSON 分区在 ZIP 内的相对路径；文件类分区（skills 等）走目录前缀，不在此表 */
export const SECTION_JSON_PATHS: Partial<Record<SectionId, string>> = {
  settings: 'config/settings.json',
  ui: 'config/ui.json',
  providers: 'ai/providers.json',
  plugins: 'plugins/plugins.json',
  mcp: 'mcp/servers.json',
  prompts: 'custom/prompts.json',
  workspaces: 'workspaces/workspaces.json',
  credentialsStatus: 'security/credentials.json',
};

/** 文件类分区在 ZIP 内的目录前缀 */
export const SECTION_FILE_PREFIXES: Partial<Record<SectionId, string>> = {
  skills: 'custom/skills/',
  agentPresets: 'agents/presets/',
  agentInstructions: 'custom/agent-instructions/',
  pluginFiles: 'plugin-files/',
  sessions: 'sessions/',
  self: 'self/',
};

/** 该分区是否是「文件类」分区（ZIP 内以真实文件存放而非 JSON） */
export function isFileSection(sectionId: SectionId): boolean {
  return sectionId in SECTION_FILE_PREFIXES;
}

/** 从 ZIP 内 JSON 解析分区数据（深度保护 + 结构校验） */
export function parseSectionJson<T extends SectionData>(sectionId: SectionId, raw: string): T {
  const parsed = parseJsonSafe(raw) as T;
  const issues = validateSectionData(sectionId, parsed);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`分区 ${sectionId} 数据无效: ${errors.map((e) => e.message).join('; ')}`);
  }
  return parsed;
}

export interface SectionIssue { path: string; message: string; severity: 'error' | 'warning'; }

/** 分区数据结构基础校验（version 字段 + 顶层形状） */
export function validateSectionData(sectionId: SectionId, data: unknown): SectionIssue[] {
  const issues: SectionIssue[] = [];
  if (data === null || typeof data !== 'object') {
    return [{ path: '$', message: `分区 ${sectionId} 数据必须是对象`, severity: 'error' }];
  }
  const obj = data as Record<string, unknown>;
  if (obj['version'] !== 1) {
    issues.push({ path: 'version', message: `分区 ${sectionId} 的 version 必须为 1（收到 ${String(obj['version'])}）`, severity: 'error' });
    return issues;
  }
  switch (sectionId) {
    case 'settings':
    case 'ui': {
      const ns = obj['namespaces'];
      if (ns === null || typeof ns !== 'object') {
        issues.push({ path: 'namespaces', message: `分区 ${sectionId} 缺少 namespaces 对象`, severity: 'error' });
      } else {
        for (const [name, rec] of Object.entries(ns as Record<string, unknown>)) {
          if (rec === null || typeof rec !== 'object') {
            issues.push({ path: `namespaces.${name}`, message: 'namespace 记录必须是对象', severity: 'error' });
            continue;
          }
          const r = rec as Record<string, unknown>;
          if (typeof r['revision'] !== 'number') issues.push({ path: `namespaces.${name}.revision`, message: 'revision 必须是数字', severity: 'error' });
          if (!('value' in r)) issues.push({ path: `namespaces.${name}.value`, message: '缺少 value', severity: 'error' });
          const secrets = r['secrets'];
          if (secrets !== undefined && !Array.isArray(secrets)) issues.push({ path: `namespaces.${name}.secrets`, message: 'secrets 必须是数组', severity: 'error' });
        }
      }
      break;
    }
    case 'providers': {
      const p = obj['providers'];
      if (p === null || typeof p !== 'object') issues.push({ path: 'providers', message: '缺少 providers 对象', severity: 'error' });
      break;
    }
    case 'plugins': {
      if (!Array.isArray(obj['plugins'])) issues.push({ path: 'plugins', message: 'plugins 必须是数组', severity: 'error' });
      if (obj['patch'] !== undefined && !Array.isArray(obj['patch'])) issues.push({ path: 'patch', message: 'patch 必须是数组', severity: 'error' });
      break;
    }
    case 'mcp': {
      if (!Array.isArray(obj['servers'])) issues.push({ path: 'servers', message: 'servers 必须是数组', severity: 'error' });
      break;
    }
    case 'prompts': {
      if (!Array.isArray(obj['prompts'])) issues.push({ path: 'prompts', message: 'prompts 必须是数组', severity: 'error' });
      break;
    }
    case 'workspaces': {
      if (!Array.isArray(obj['workspaces'])) issues.push({ path: 'workspaces', message: 'workspaces 必须是数组', severity: 'error' });
      break;
    }
    case 'credentialsStatus': {
      if (!Array.isArray(obj['credentials'])) issues.push({ path: 'credentials', message: 'credentials 必须是数组', severity: 'error' });
      break;
    }
    case 'skills':
    case 'agentPresets':
    case 'agentInstructions':
    case 'pluginFiles':
    case 'sessions':
    case 'self': {
      if (!Array.isArray(obj['files'])) issues.push({ path: 'files', message: 'files 必须是数组', severity: 'error' });
      break;
    }
    default:
      issues.push({ path: '$', message: `未知分区 ${sectionId}`, severity: 'error' });
  }
  return issues;
}

/** 分区 JSON 载荷的类型收窄（供 adapter / analyzer 使用） */
export function asSettingsSection(data: unknown): SettingsSection { return data as SettingsSection; }
export function asUiSection(data: unknown): UiSection { return data as UiSection; }
export function asProvidersSection(data: unknown): ProvidersSection { return data as ProvidersSection; }
export function asPluginsSection(data: unknown): PluginsSection { return data as PluginsSection; }
export function asMcpSection(data: unknown): McpSection { return data as McpSection; }
export function asPromptsSection(data: unknown): PromptsSection { return data as PromptsSection; }
export function asWorkspacesSection(data: unknown): WorkspacesSection { return data as WorkspacesSection; }
export function asCredentialsSection(data: unknown): CredentialsSection { return data as CredentialsSection; }
export function asFilesSection(data: unknown): FilesSection { return data as FilesSection; }
