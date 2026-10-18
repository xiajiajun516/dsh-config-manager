/**
 * Claude Code（~/.claude）→ DSH bundle 分区的**纯**翻译层（v1；2026-10-18 补齐项目级 / 插件 / 诊断）。
 *
 * 重构后本文件只保留 Claude 特有的部分，公共口径全部走共享内核（kernel.ts）：
 *  - 路径/名字安全、SKILL.md frontmatter 校验、MCP 映射与凭据剥离、skill 装配、会话归集
 *    → 内核（Hermes 等其它来源共用同一份实现，口径不可能分叉）；
 *  - 本文件只剩：指令合并、~/.claude.json 与项目/插件三处 MCP 的装配、settings 的只读诊断、
 *    commands / agents / hooks / plugins 的如实报码、以及溯源块（origin）。
 *
 * **既有行为逐字保留**（claude-code.test.ts 的 t0..t7 一行未改）：全局 CLAUDE.md 单来源时
 * 原样落一份 AGENTS.md（不报 instructions-merged）；mcp / skills / sessions / workspaces 的
 * 装配口径不变；跳过码只增不改。
 *
 * 本层**零 fs**：项目根、插件清单、settings、rules 全都是读盘层已经读好的纯数据（见
 * read-claude-code.ts / read-claude-plugins.ts），因此全部可在单测里构造。
 *
 * 明确不搬、并**可见地**记进 skipped（绝不静默）：
 *  - settings(.local).json 的 hooks（事件名 + 条目数明细，DSH 无对等结构）
 *  - settings(.local).json 的 permissions（allow / ask / deny 只数条数，值一律不读）
 *  - settings(.local).json 其余顶层键（只记键名，值一律不读）
 *  - settings 的 env（凭据：只报名字与条数，值不读）
 *  - commands/*.md、agents/*.md（与 DSH 的 prompts / subagent 不是同一语义）
 *  - 带 frontmatter 的 .claude/rules/*.md（作用域合并会丢语义，只报告、不进合并正文）
 *  - 插件本体（hooks / commands / agents 的执行面与运行时 API，**绝不复制其代码**）
 *  - ~/.claude.json 的 projects / sessions / history 中的机器状态（与源机路径强绑定）
 */
import { defaultSecretScanner } from '../core/exporter.ts';
import { isRecord } from '../utils/guards.ts';
import { transcodeClaudeSession } from './claude-sessions.ts';
import {
  collectSessionSections,
  collectSkills,
  instructionsSection,
  mcpSectionFromEntries,
  serverEntriesOf,
  splitFrontmatter,
} from './kernel.ts';
import type {
  ClaudeCodeInput,
  ClaudeProjectInput,
  ClaudeSkillInput,
  ForeignImportResult,
  ForeignOrigin,
  ForeignSectionOut,
  ForeignSkip,
} from './types.ts';

/* 公共判据/工具**从共享内核再导出**：v1 的既有 import 路径与名字保持不变（外部只 import 这一层） */
export {
  frontmatterProblem,
  isSafeRelPath,
  isSafeUnitName,
  mcpEntryOf,
  splitFrontmatter,
  stripUserInfo,
} from './kernel.ts';

const NL = String.fromCharCode(10);
/** settings 未迁移键名在 detail 里的上限（超出只记 count，绝不把整份键名铺开） */
const MAX_SETTINGS_KEY_NAMES = 20;

/* ---------------- settings 诊断（全局与项目级共用同一套判据） ---------------- */

/**
 * 一次 settings 诊断的作用域。
 *
 * 为什么要有这个结构：项目级 settings / settingsLocal 与全局 settings 必须走**逐字同一套**
 * 判据（hooks / permissions / 其余键 / env 凭据），只在「报码标签」上区分来源 ——
 * 各写一份必然分叉，而分叉的后果正是本次要修的「settings 顶层键静默丢弃」。
 */
interface SettingsScope {
  /** 报码的 origin（项目级给 project:<n>/settings(.local).json；全局不给 = 保持既有形状） */
  origin?: string;
  /** detail 前缀（项目级给 project:<n>，让「这条来自哪个项目」在明细里可见） */
  detailPrefix?: string;
  /** 凭据引用名前缀（全局 settings.env / 项目级 project:<n>:settings.env） */
  refPrefix: string;
}

/** settings 诊断的计数（hooks 条目数 / permissions 规则条数） */
interface SettingsTally {
  hooks: number;
  permissions: number;
}

/** hooks 明细：事件名 + **该事件的条目数**（只看数组长度，绝不读值） */
function hookDetailOf(hooks: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [event, value] of Object.entries(hooks)) {
    parts.push(event + '=' + String(Array.isArray(value) ? value.length : 0));
  }
  return parts.join(',');
}

/** hooks 条目总数（数组长度之和；非数组按 0，不猜） */
function hookEntriesOf(hooks: Record<string, unknown>): number {
  let total = 0;
  for (const value of Object.values(hooks)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

/** permissions 明细：只数 allow / ask / deny 的条数，值一律不读 */
function permissionDetailOf(permissions: Record<string, unknown>): string {
  const countOf = (key: string): number => {
    const value = permissions[key];
    return Array.isArray(value) ? value.length : 0;
  };
  return 'allow=' + String(countOf('allow')) + ',ask=' + String(countOf('ask')) + ',deny=' + String(countOf('deny'));
}

/** permissions 规则总条数（allow + ask + deny） */
function permissionEntriesOf(permissions: Record<string, unknown>): number {
  let total = 0;
  for (const key of ['allow', 'ask', 'deny']) {
    const value = permissions[key];
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

/**
 * settings.json / settings.local.json 的只读诊断。
 *
 * 只报码、绝不静默，也**绝不读值**：
 *  - hooks → unsupported-hooks（detail = 事件名=条目数，count = 事件数）
 *  - permissions 对象存在 → unsupported-permissions（detail = allow/ask/deny 条数）
 *  - 其余顶层键 → unsupported-settings-keys（detail = 键名逗号拼接，上限 20；超出记 count）
 *  - env 里的凭据名 → credentials-not-migrated（只记名，值不读）
 */
function collectSettingsFindings(
  settings: unknown,
  scope: SettingsScope,
  skipped: ForeignSkip[],
  refs: string[],
  tally: SettingsTally,
): void {
  if (!isRecord(settings)) return;
  const tag = (skip: ForeignSkip): ForeignSkip => {
    const out: ForeignSkip = { code: skip.code };
    if (skip.origin !== undefined) out.origin = skip.origin;
    if (skip.detail !== undefined) out.detail = skip.detail;
    if (skip.count !== undefined) out.count = skip.count;
    if (scope.origin !== undefined) out.origin = scope.origin;
    if (scope.detailPrefix !== undefined && out.detail !== undefined) {
      out.detail = scope.detailPrefix + ' ' + out.detail;
    }
    return out;
  };

  const hooks = settings['hooks'];
  if (isRecord(hooks) && Object.keys(hooks).length > 0) {
    tally.hooks += hookEntriesOf(hooks);
    skipped.push(tag({ code: 'unsupported-hooks', detail: hookDetailOf(hooks), count: Object.keys(hooks).length }));
  }

  const permissions = settings['permissions'];
  if (isRecord(permissions)) {
    tally.permissions += permissionEntriesOf(permissions);
    skipped.push(tag({ code: 'unsupported-permissions', detail: permissionDetailOf(permissions) }));
  }

  const env = settings['env'];
  if (isRecord(env) && Object.keys(env).length > 0) {
    // 只问「哪些名字像凭据」——值一律不读、不落盘、不回传
    const { hits } = defaultSecretScanner().scanAndRedact(env);
    if (hits.length > 0) {
      skipped.push(tag({ code: 'credentials-not-migrated', count: hits.length }));
      for (const hit of hits) refs.push(scope.refPrefix + ':' + hit.field);
    }
  }

  const otherKeys = Object.keys(settings).filter((key) => key !== 'hooks' && key !== 'env' && key !== 'permissions');
  if (otherKeys.length > 0) {
    const names = otherKeys.slice(0, MAX_SETTINGS_KEY_NAMES).join(',');
    skipped.push(tag(
      otherKeys.length > MAX_SETTINGS_KEY_NAMES
        ? { code: 'unsupported-settings-keys', detail: names, count: otherKeys.length }
        : { code: 'unsupported-settings-keys', detail: names },
    ));
  }
}

/* ---------------- MCP 取值（三处载体形态各不相同，取值只有这一份实现） ---------------- */

/** 「名字 → 定义」映射的条目（非映射 → 空清单）；项目级 projectMcp 本身就是这个映射 */
function mappingEntries(value: unknown): [string, unknown][] {
  if (!isRecord(value)) return [];
  return Object.entries(value);
}

/**
 * `.mcp.json` 的条目：Claude Code 标准形态是 `{ mcpServers: {…} }`；
 * 插件目录里也见过裸映射 `{ "<server>": {…} }`（read-claude-plugins 的实测布局）。
 * 有 mcpServers 键就**只认它**（即使为空），否则才按裸映射读 —— 绝不把 "mcpServers" 当成 server 名。
 */
function mcpFileEntries(value: unknown): [string, unknown][] {
  if (!isRecord(value)) return [];
  if (Object.prototype.hasOwnProperty.call(value, 'mcpServers')) return serverEntriesOf(value, 'mcpServers');
  return Object.entries(value);
}

/* ---------------- 指令合并（DSH 只读一个全局指令文件） ---------------- */

interface InstructionSource {
  /** 来源标签（进 instructions-merged 的 detail，如 claude-md / project:1） */
  label: string;
  text: string;
}

/**
 * 指令来源按**固定顺序**收集：全局 CLAUDE.md → 每个项目的 CLAUDE.md / CLAUDE.local.md →
 * 该项目不带 frontmatter 的 rules/*.md。带 frontmatter 的 rule **不进正文**，只报
 * unsupported-rules（它的作用域语义在 DSH 没有承载位，合并进去等于悄悄扩大生效范围）。
 */
function instructionSourcesOf(
  input: ClaudeCodeInput,
  projects: readonly ClaudeProjectInput[],
  skipped: ForeignSkip[],
): InstructionSource[] {
  const out: InstructionSource[] = [];
  if (typeof input.memory === 'string' && input.memory.trim() !== '') {
    out.push({ label: 'claude-md', text: input.memory });
  }
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (project === undefined) continue;
    const n = i + 1;
    if (typeof project.memory === 'string' && project.memory.trim() !== '') {
      out.push({ label: 'project:' + String(n), text: project.memory });
    }
    if (typeof project.memoryLocal === 'string' && project.memoryLocal.trim() !== '') {
      out.push({ label: 'project-local:' + String(n), text: project.memoryLocal });
    }
    for (const rule of project.rules ?? []) {
      if (splitFrontmatter(rule.text) !== null) {
        skipped.push({ code: 'unsupported-rules', origin: rule.name });
        continue;
      }
      if (rule.text.trim() !== '') {
        out.push({ label: 'rule:' + String(n) + ':' + rule.name, text: rule.text });
      }
    }
  }
  return out;
}

/**
 * 单一来源 → 原文逐字返回（既有行为），**不报码**；多来源 → 合并并报
 * instructions-merged（detail = 来源标签串，如 "claude-md+project:1"）。
 */
function mergeInstructions(sources: readonly InstructionSource[], skipped: ForeignSkip[]): string | null {
  const first = sources[0];
  if (first === undefined) return null;
  if (sources.length === 1) return first.text;
  skipped.push({ code: 'instructions-merged', detail: sources.map((s) => s.label).join('+') });
  return sources.map((s) => s.text.trimEnd()).join(NL + NL) + NL;
}

/* ---------------- 溯源块（进 bundle 的 manifest.foreign） ---------------- */

/**
 * 全局位置的标签前缀：位置被 CLAUDE_CONFIG_DIR 覆盖时用真实配置目录（绝对路径）——
 * 它是「用户自己机器的来源位置」，只进溯源元数据，**绝不进任何分区载荷**；未覆盖时用 .claude。
 */
function globalLocationBase(input: ClaudeCodeInput): string {
  if (input.configDirOverridden === true && typeof input.configDir === 'string' && input.configDir.trim() !== '') {
    return input.configDir;
  }
  return '.claude';
}

/** skipped → {code, count} 聚合（按首次出现顺序；同码的 count 相加） */
function aggregateSkipped(skipped: readonly ForeignSkip[]): { code: string; count: number }[] {
  const byCode = new Map<string, number>();
  for (const skip of skipped) {
    byCode.set(skip.code, (byCode.get(skip.code) ?? 0) + (skip.count ?? 1));
  }
  return [...byCode.entries()].map(([code, count]) => ({ code, count }));
}

/**
 * 装配溯源块。三条纪律：只放标识与计数；绝对路径只允许出现在 projects[]（配置目录覆盖时
 * 的 locations 也是用户自己机器的来源位置）；输入没给的字段**省略**（缺字段 = 不知道）。
 * 一个信号都没有时返回 undefined（旧行为：不写 origin）。
 */
function buildOrigin(
  input: ClaudeCodeInput,
  projects: readonly ClaudeProjectInput[],
  plugins: readonly NonNullable<ClaudeCodeInput['plugins']>[number][],
  skipped: readonly ForeignSkip[],
  credentialRefs: readonly string[],
): ForeignOrigin | undefined {
  const locations: string[] = [];
  if (input.claudeJson !== undefined) locations.push('.claude.json');
  const base = globalLocationBase(input);
  const globalBits: string[] = [];
  if (input.settings !== undefined) globalBits.push(base + '/settings.json');
  if (typeof input.memory === 'string' && input.memory.trim() !== '') globalBits.push(base + '/CLAUDE.md');
  if ((input.skills?.length ?? 0) > 0) globalBits.push(base + '/skills');
  if ((input.commandCount ?? 0) > 0) globalBits.push(base + '/commands');
  if ((input.sessions?.length ?? 0) > 0) globalBits.push(base + '/projects');
  if ((input.marketplaces?.length ?? 0) > 0) globalBits.push(base + '/plugins/known_marketplaces.json');
  if (plugins.length > 0) globalBits.push(base + '/plugins');
  if (globalBits.length > 0) {
    locations.push(base);
    locations.push(...globalBits);
  }

  const roots: string[] = [];
  for (const project of projects) {
    if (project.root.trim() !== '') roots.push(project.root);
  }

  const pluginMetas: NonNullable<ForeignOrigin['plugins']> = [];
  for (const plugin of plugins) {
    const meta: NonNullable<ForeignOrigin['plugins']>[number] = { name: plugin.name };
    if (plugin.version !== undefined) meta.version = plugin.version;
    if (plugin.marketplace !== undefined) meta.marketplace = plugin.marketplace;
    if (plugin.repo !== undefined) meta.repo = plugin.repo;
    if (plugin.ref !== undefined) meta.ref = plugin.ref;
    if (plugin.components.length > 0) meta.components = [...plugin.components];
    pluginMetas.push(meta);
  }

  const skipSummary = aggregateSkipped(skipped);
  const hasSignal = locations.length > 0
    || roots.length > 0
    || pluginMetas.length > 0
    || (input.sourceVersion !== undefined && input.sourceVersion !== '')
    || skipSummary.length > 0
    || credentialRefs.length > 0;
  if (!hasSignal) return undefined;

  const origin: ForeignOrigin = {
    source: 'claude-code',
    locations,
    skipped: skipSummary,
    credentialRefs: [...credentialRefs],
  };
  if (input.sourceVersion !== undefined && input.sourceVersion !== '') origin.sourceVersion = input.sourceVersion;
  if (roots.length > 0) origin.projects = roots;
  if (pluginMetas.length > 0) origin.plugins = pluginMetas;
  return origin;
}

/* ---------------- 入口 ---------------- */

export function convertClaudeCode(input: ClaudeCodeInput): ForeignImportResult {
  const skipped: ForeignSkip[] = [];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};
  const projects = input.projects ?? [];
  const plugins = input.plugins ?? [];
  const tally: SettingsTally = { hooks: 0, permissions: 0 };

  /* ---- MCP：全局 ~/.claude.json ∪ 项目 .mcp.json ∪ 项目 projectMcp ∪ 插件 .mcp.json ---- */
  // 同名先到先得：第一条定义进包，其余只报 mcp-server-id-conflict（origin = server 名）
  const mcpEntries: [string, unknown][] = [];
  const seenMcp = new Set<string>();
  const addMcpEntries = (entries: readonly (readonly [string, unknown])[]): void => {
    for (const entry of entries) {
      if (seenMcp.has(entry[0])) {
        skipped.push({ code: 'mcp-server-id-conflict', origin: entry[0] });
        continue;
      }
      seenMcp.add(entry[0]);
      mcpEntries.push([entry[0], entry[1]]);
    }
  };
  addMcpEntries(serverEntriesOf(input.claudeJson, 'mcpServers'));
  for (const project of projects) {
    addMcpEntries(mcpFileEntries(project.mcpJson));
    addMcpEntries(mappingEntries(project.projectMcp));
  }
  for (const plugin of plugins) addMcpEntries(mcpFileEntries(plugin.mcpJson));
  const mcp = mcpSectionFromEntries(mcpEntries, credentialRefs, skipped);
  if (mcp !== null) {
    sections.push({ sectionId: 'mcp', data: mcp });
    counts['mcp.servers'] = mcp.servers.length;
  }

  /* ---- skills：全局 ∪ 项目级 ∪ 插件（压平一层；同名先到先得由内核统一判） ---- */
  const skillUnits: ClaudeSkillInput[] = [
    ...(input.skills ?? []),
    ...projects.flatMap((project) => project.skills ?? []),
    ...plugins.flatMap((plugin) => plugin.skills ?? []),
  ];
  const skillFiles: { relativePath: string; data: Uint8Array }[] = [];
  collectSkills(skillUnits, skillFiles, skipped);
  if (skillFiles.length > 0) {
    sections.push({ sectionId: 'skills', files: skillFiles });
    counts['skills.files'] = skillFiles.length;
  }

  /* ---- 指令合并：全局 + 项目 memory/memoryLocal + 无 frontmatter 的 rules ---- */
  const instructionSources = instructionSourcesOf(input, projects, skipped);
  const mergedInstructions = mergeInstructions(instructionSources, skipped);
  if (mergedInstructions !== null) {
    const instructions = instructionsSection(mergedInstructions);
    if (instructions !== null) {
      sections.push(instructions);
      counts['agentInstructions.files'] = 1;
    }
  }

  // 内核在 formatVersion === undefined 时**一条都不转**并整批报码；这里的 -1 是不可达分支的兜底
  // （转码器会把它判成 session-format-unsupported），刻意不写 0/3 之类的"最近版本"，避免猜。
  const formatVersion = input.targetSessionFormatVersion ?? -1;
  collectSessionSections({
    files: input.sessions ?? [],
    targetFormatVersion: input.targetSessionFormatVersion,
    // TranscodeResult.findings 是**逐会话**的如实报码（session-id-mismatch 等）。
    // 内核只读 result.skip 与 session.info.ignored，**不读 findings** ⇒ 必须在这里并入，
    // 否则这条码永远到不了用户面前（审计：findings 是一个「写好了但没接线」的字段）。
    transcode: (file) => {
      const result = transcodeClaudeSession(file, { formatVersion });
      for (const finding of result.findings) skipped.push(finding);
      return result;
    },
    workspaceIdPrefix: 'claude-code',
    sections,
    skipped,
    counts,
  });

  /* ---- settings 诊断：全局 + 项目级（settings / settingsLocal）同一套判据 ---- */
  collectSettingsFindings(input.settings, { refPrefix: 'settings.env' }, skipped, credentialRefs, tally);
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (project === undefined) continue;
    const n = String(i + 1);
    collectSettingsFindings(
      project.settings,
      { origin: 'project:' + n + '/settings.json', detailPrefix: 'project:' + n, refPrefix: 'project:' + n + ':settings.env' },
      skipped,
      credentialRefs,
      tally,
    );
    collectSettingsFindings(
      project.settingsLocal,
      { origin: 'project:' + n + '/settings.local.json', detailPrefix: 'project:' + n, refPrefix: 'project:' + n + ':settings.local.env' },
      skipped,
      credentialRefs,
      tally,
    );
    const projectCommands = project.commandCount ?? 0;
    if (projectCommands > 0) skipped.push({ code: 'unsupported-commands', origin: 'project:' + n, count: projectCommands });
    for (const agent of project.agents ?? []) skipped.push({ code: 'unsupported-agents', origin: agent.name });
    for (const finding of project.readFindings ?? []) skipped.push(finding);
  }

  /* ---- 插件：本体不迁移（一条一码 + 组件明细），能从插件无损复用的只有 skills 与 .mcp.json ---- */
  for (const plugin of plugins) {
    skipped.push({ code: 'unsupported-plugins', origin: plugin.name, detail: plugin.components.join(',') });
    const pluginCommands = plugin.commandCount ?? 0;
    if (pluginCommands > 0) skipped.push({ code: 'unsupported-commands', origin: plugin.name, count: pluginCommands });
    const pluginHooks = plugin.hookFiles ?? 0;
    if (pluginHooks > 0) skipped.push({ code: 'unsupported-hooks', origin: plugin.name, count: pluginHooks });
    for (const agent of plugin.agents ?? []) skipped.push({ code: 'unsupported-agents', origin: agent });
    for (const finding of plugin.readFindings ?? []) skipped.push(finding);
  }

  const commandCount = input.commandCount ?? 0;
  if (commandCount > 0) skipped.push({ code: 'unsupported-commands', count: commandCount });

  /* ---- counts：既有键逐字保留；新键只在真的有内容时出现（0 不占位） ---- */
  const agentCount = projects.reduce((total, project) => total + (project.agents?.length ?? 0), 0)
    + plugins.reduce((total, plugin) => total + (plugin.agents?.length ?? 0), 0);
  const allCommands = commandCount
    + projects.reduce((total, project) => total + (project.commandCount ?? 0), 0)
    + plugins.reduce((total, plugin) => total + (plugin.commandCount ?? 0), 0);
  const allHooks = tally.hooks + plugins.reduce((total, plugin) => total + (plugin.hookFiles ?? 0), 0);
  if (projects.length > 0) counts['projects'] = projects.length;
  if (plugins.length > 0) counts['plugins'] = plugins.length;
  if (agentCount > 0) counts['agents'] = agentCount;
  if (allCommands > 0) counts['commands'] = allCommands;
  if (allHooks > 0) counts['hooks'] = allHooks;
  if (tally.permissions > 0) counts['permissions'] = tally.permissions;

  const origin = buildOrigin(input, projects, plugins, skipped, credentialRefs);
  return origin === undefined
    ? { source: 'claude-code', sections, skipped, credentialRefs, counts }
    : { source: 'claude-code', sections, skipped, credentialRefs, counts, origin };
}
