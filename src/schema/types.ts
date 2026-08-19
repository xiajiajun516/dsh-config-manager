/**
 * 核心领域类型（Export Schema v1 的纯类型定义）。
 *
 * 对齐 Docs/design/architecture.md §13.1 —— m3/m5 的共同契约。
 * 本文件只含与 DSH 运行时无关的纯数据形状；DSH Service 门面类型见 src/core/types.ts。
 */

/** 运行平台（等价 NodeJS.Platform，但保持类型自包含，可在浏览器侧引用） */
export type Platform =
  | 'win32' | 'darwin' | 'linux' | 'freebsd' | 'openbsd' | 'aix' | 'sunos'
  | 'android' | 'cygwin' | 'haiku' | 'netbsd' | 'other';

/**
 * 分区标识，与 ZIP 目录结构、manifest.sections 键一一对应。
 * 明确不实现的分区（keybindings/workflows/commands）不在此列；
 * rules 已由 agentInstructions（~/.dsh/AGENTS.md，dsh-agent-instructions 全局指令）承接。
 */
export type SectionId =
  | 'settings' | 'ui' | 'providers' | 'plugins' | 'mcp' | 'prompts'
  | 'skills' | 'agentPresets' | 'agentInstructions' | 'workspaces' | 'pluginFiles'
  | 'credentialsStatus' | 'secrets' | 'sessions' | 'self';

/** 加密备份的算法参数（非秘密：salt/iv/authTag 仅用于解密与完整性校验） */
export interface EncryptionInfo {
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; keyLength: number };
  salt: string;   // base64
  iv: string;     // base64
  authTag: string;// base64（GCM 认证标签）
  version: number;
}

/** 每个导出 ZIP 根部的 manifest.json */
export interface Manifest {
  schemaVersion: number;
  exporter: { name: string; version: string };
  source: { dshVersion: string; platform: Platform; arch: string };
  exportedAt: string; // ISO-8601 UTC
  sections: Record<SectionId, boolean>;
  security: {
    containsSecrets: boolean;
    encrypted: boolean;
    encryption: EncryptionInfo | null;
  };
}

/* —— settings / ui 分区 —— */

/** settings.yaml 中单个 namespace 的导出记录（redacted 值 + 乐观锁 revision） */
export interface NamespaceRecord {
  value: unknown;
  base?: unknown;
  revision: number;
  applies?: string[];
  /** DSH describe({redactSecrets:true}) 报告的 secrets 位置（只含路径标记，不含值） */
  secrets: { path: string[]; set: boolean }[];
}

export interface SettingsSection { version: 1; namespaces: Record<string, NamespaceRecord>; }

export interface UiMigrationNote {
  plugin: string;
  storage: string;
  key: string;
  migratable: false;
  reason: string;
}

export interface UiSection {
  version: 1;
  namespaces: Record<string, NamespaceRecord>;
  /** localStorage 等 Host 不可迁移项的说明（纯说明，不含任何值） */
  uiMigrationNotes: UiMigrationNote[];
}

/* —— providers 分区 —— */

export interface ProviderEntry {
  route: string;
  apiKeyEnv?: string; // 只记环境变量名，值在 credentials
  displayName?: string;
  baseURL?: string;
  models?: unknown[];
  modelOverrides?: unknown;
  reasoning?: unknown;
  transport?: unknown;
  retryPolicy?: unknown;
}

export interface ProvidersSection { version: 1; providers: Record<string, ProviderEntry>; }

/* —— plugins 分区 —— */

export interface PluginEntry {
  name: string;     // 包名
  version: string;
  /**
   * 声明依赖 spec（profile package.json dependencies 原样），如 ^0.3.6、
   * github:csyangwen/dsh-memory-evolve、file:/link: 等。
   * 导入时非 registry 来源（github:/git+/file:/link:/workspace: 等）按此 spec 安装，
   * 否则按裸包名走 npm 最新版（官方机制）。
   */
  spec?: string;
  isBundle: boolean;
  inBundles: string[];
  enabled: boolean;
  fiberPhase?: string;
}

export interface PatchLine { file: string; lineId: string; raw: unknown; }

export interface PluginsSection {
  version: 1;
  plugins: PluginEntry[];
  patch: PatchLine[];
  /**
   * profile 的 pnpm-workspace.yaml 原文（allowBuilds / minimumReleaseAgeExclude /
   * nodeLinker 等）。随插件分区迁移，保证目标 profile 的 pnpm 能按来源配置安装
   * （git 插件构建脚本白名单、新发布版本冷静期等）。缺省/无文件为 null。
   */
  pnpmWorkspace?: string | null;
}

/* —— mcp 分区 —— */

export interface McpServerEntry {
  serverName: string;
  type: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpSection { version: 1; servers: McpServerEntry[]; }

/* —— prompts 分区 —— */

export interface PromptEntry {
  id: string;
  name: string;
  kind: 'systemPrompt' | 'planMode';
  text: string;
  sourceLineId?: string;
}

export interface PromptsSection { version: 1; prompts: PromptEntry[]; }

/* —— workspaces 分区（绝对路径 → 跨设备必须路径映射） —— */

export interface WorkspaceRecord {
  id: string;
  path: string;
  title?: string;
  sessionIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspacesSection { version: 1; workspaces: WorkspaceRecord[]; }

/* —— credentials 状态分区（永不含值） —— */

export interface CredentialStatus {
  ref: string;
  required: boolean;
  configured: boolean;
  source?: 'env' | 'file' | 'projectEnv' | 'other';
  hasValue: boolean; // 普通备份恒 false（值未导出）
}

export interface CredentialsSection { version: 1; credentials: CredentialStatus[]; }

/* —— 文件类分区（skills/agentPresets/agentInstructions/pluginFiles/sessions） ——
 * 这些分区以真实文件形式进入 ZIP（custom/skills/… 等），
 * 内存中统一表示为 FilesSection（ZIP 内不落此 JSON，见 exporter）。 */

export interface FileEntry {
  relativePath: string;
  data: Uint8Array;
  contentHash: string; // SHA-256 hex
}

export interface FilesSection { version: 1; files: FileEntry[]; }

/** 分区 JSON 文件的统一载荷（schema 校验用） */
export type SectionData =
  | SettingsSection | UiSection | ProvidersSection | PluginsSection
  | McpSection | PromptsSection | WorkspacesSection | CredentialsSection
  | FilesSection;
