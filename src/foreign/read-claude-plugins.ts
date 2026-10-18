/**
 * Claude Code **插件**目录的读盘层（宿主侧只读；2026-10-18 补）。
 *
 * 真实布局（本机实测取证；只记录键名，绝不过问值）：
 *  - `plugins/known_marketplaces.json`：`{ "<市场名>": { source: { source, repo }, installLocation, lastUpdated } }`；
 *  - `plugins/marketplaces/<市场>/.claude-plugin/marketplace.json`：`{ name, description, owner, plugins: [...] }`；
 *  - `plugins/marketplaces/<市场>/plugins/<插件>/`（或 `external_plugins/<插件>/`）；
 *  - 插件目录：`.claude-plugin/plugin.json`、commands/、skills/、agents/、hooks/、.mcp.json
 *    （`.mcp.json` 形如 `{ "<server>": { type, url, headers } }` —— **headers 里可能是真凭据**）。
 *
 * 三条结构性纪律：
 *  ① **绝不执行、绝不读取插件里的可执行代码内容**：commands/agents/hooks 只做「文件名 / 文件数」
 *     统计；允许进包的只有技能文本与 `.mcp.json`（且 .mcp.json 原样交给翻译层，凭据剥离在
 *     kernel 的剥离器里做 —— 本层不复制、不改写凭据，只保证「不额外扩散」）；
 *  ② **不猜**：启用清单只认两个有形状可自证的位置（settings.enabledPlugins 与 plugins/config.json
 *     的可识别形状），认不出来就报 plugins-config-unknown-shape，绝不把任意 JSON 当插件清单；
 *  ③ **不静默**：市场和插件都读不到 / 找不到安装目录 / 触顶（插件数、单插件文件数）一律报稳定机器码。
 *
 * 归属规则（与 read-claude-code 一致）：能落到某个插件上的发现写进该插件的 readFindings（由翻译层
 * 原样带出）；落不到插件上的（市场清单、启用清单、找不到安装目录、插件数触顶）进顶层 skipped。
 *
 * 为什么本文件不 import `node:fs`：`src/foreign/file-budget.test.ts` 的 B 档要求 import fs 的模块
 * **恰好**等于白名单。这里复用 `session-read.ts`（共享只读内核）的原语，实现同样「只读、不跟随
 * 符号链接、有上限」的行为，而不新增一个 fs 入口。
 */
import path from 'node:path';

import { isRecord } from '../utils/guards.ts';
import { stripUserInfo } from './kernel.ts';
import { listDirSafe, readJsonSafe, statOrNull, toPosixPath, walkFiles } from './session-read.ts';
import { readSkillUnits } from './read-claude-code.ts';
import type { ClaudePluginInput, ClaudeSkillInput, ForeignSkip } from './types.ts';

/** 插件数上限触顶（count = 上限） */
export const MAX_PLUGINS_REACHED = 'max-plugins-reached';
/** 单插件文件数上限触顶（count = 上限） */
export const MAX_PLUGIN_FILES_REACHED = 'max-plugin-files-reached';
/** plugins/config.json 存在但形状认不出来（**绝不猜**） */
export const PLUGINS_CONFIG_UNKNOWN_SHAPE = 'plugins-config-unknown-shape';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PLUGINS = 50;
const DEFAULT_MAX_PLUGIN_FILES = 200;
/** 目录走盘深度（与 session-read 的 WalkOptions 缺省一致） */
const WALK_MAX_DEPTH = 8;
/** 跳过原因：符号链接（与 read-claude-code 同码同义） */
const DETAIL_SYMLINK = 'symlink-skipped';

export interface ClaudePluginReadLimits {
  /** 启用的插件数上限（默认 50） */
  readonly maxPlugins?: number;
  /** 单个插件的文件数上限（默认 200；触顶报 max-plugin-files-reached） */
  readonly maxPluginFiles?: number;
}

export interface ClaudePluginReadOptions {
  /** Claude 配置目录（`<home>/.claude` 或 CLAUDE_CONFIG_DIR 覆盖值） */
  readonly claudeDir: string;
  /** settings.json 的已解析值（enabledPlugins 的权威来源） */
  readonly settings: unknown;
  readonly limits?: ClaudePluginReadLimits;
  /** 单文件读取上限（默认 8 MiB；与同域读盘层同口径） */
  readonly maxFileBytes?: number;
}

export interface ClaudePluginReadResult {
  /** 读到的插件（只含有安装目录、能自证的最小元数据与组件） */
  plugins: ClaudePluginInput[];
  /** 已登记的市场（name + 来源仓库；URL 的 userinfo 已剥离） */
  marketplaces: { name: string; repo?: string }[];
  /** 落不到具体插件上的发现（市场清单 / 启用清单 / 找不到安装目录 / 插件数触顶） */
  skipped: ForeignSkip[];
  /** 计数（marketplaces / enabledPlugins / plugins / pluginSkills / pluginCommands / pluginAgents / pluginHooks） */
  counts: Record<string, number>;
}

interface MarketplaceRecord {
  name: string;
  repo?: string;
  /** 市场安装位置（绝对路径；**只用于定位插件目录**，绝不进返回值） */
  installLocation?: string;
}

/** 有上限的整数解析：只用安全正整数（脏值一律回落缺省） */
function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** source.repo 或 source.url（两者都可能带 userinfo；剥离在调用处统一做） */
function repoOfSource(source: Record<string, unknown>): string | undefined {
  const repo = source['repo'];
  if (typeof repo === 'string' && repo.trim() !== '') return repo.trim();
  const url = source['url'];
  if (typeof url === 'string' && url.trim() !== '') return url.trim();
  return undefined;
}

/**
 * 读 `plugins/known_marketplaces.json`。
 * 文件不存在 = 没有登记任何市场（正常状态，不报码）；存在但读不出来 / 形状不对 = source-unreadable。
 */
async function readKnownMarketplaces(
  pluginsDir: string,
  maxFileBytes: number,
  skipped: ForeignSkip[],
): Promise<MarketplaceRecord[]> {
  const file = path.join(pluginsDir, 'known_marketplaces.json');
  const jr = await readJsonSafe(file, maxFileBytes);
  if (!jr.ok) {
    if (jr.problem !== 'missing') {
      skipped.push({ code: 'source-unreadable', origin: 'plugins/known_marketplaces.json', detail: jr.problem });
    }
    return [];
  }
  if (!isRecord(jr.value)) {
    skipped.push({
      code: 'source-unreadable',
      origin: 'plugins/known_marketplaces.json',
      detail: 'not-mapping',
    });
    return [];
  }
  const out: MarketplaceRecord[] = [];
  for (const name of Object.keys(jr.value).sort()) {
    const raw = jr.value[name];
    const record: MarketplaceRecord = { name };
    if (isRecord(raw)) {
      const source = raw['source'];
      if (isRecord(source)) {
        const repo = repoOfSource(source);
        // **userinfo 绝不进包**：https://user:token@host/x.git → https://host/x.git
        if (repo !== undefined) record.repo = stripUserInfo(repo).url;
      }
      const installLocation = raw['installLocation'];
      if (typeof installLocation === 'string' && installLocation.trim() !== '') {
        record.installLocation = path.resolve(installLocation.trim());
      }
    }
    out.push(record);
  }
  return out;
}

/** settings.enabledPlugins 的启用键（**真值才算启用**；非对象 = 没有这份清单） */
function enabledSpecsFromSettings(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const enabled = settings['enabledPlugins'];
  if (!isRecord(enabled)) return [];
  return Object.keys(enabled)
    .filter((key) => Boolean(enabled[key]))
    .sort();
}

/**
 * 按**形状自证**识别 plugins/config.json（认不出来返回 null，绝不猜）：
 *  - `{ plugins: string[] }`：插件名清单；
 *  - `{ plugins: { [name@market]: boolean } }`：启用表；
 *  - `{ enabledPlugins: { ... } }`：与 settings 同形的启用表；
 *  - 顶层直接就是 `{ "name@market": true }`（键必须都带 @）。
 */
function recognizePluginsConfig(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const plugins = value['plugins'];
  if (Array.isArray(plugins)) {
    if (plugins.length === 0) return [];
    if (!plugins.every((item) => typeof item === 'string' && item.trim() !== '')) return null;
    return [...new Set(plugins.map((item) => (item as string).trim()))].sort();
  }
  if (isRecord(plugins)) {
    if (!Object.values(plugins).every((item) => typeof item === 'boolean')) return null;
    return Object.keys(plugins).filter((key) => plugins[key] === true).sort();
  }
  const enabled = value['enabledPlugins'];
  if (isRecord(enabled)) {
    if (!Object.values(enabled).every((item) => typeof item === 'boolean')) return null;
    return Object.keys(enabled).filter((key) => enabled[key] === true).sort();
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => key.includes('@')) && keys.every((key) => typeof value[key] === 'boolean')) {
    return keys.filter((key) => value[key] === true).sort();
  }
  return null;
}

/**
 * 启用插件清单：settings.enabledPlugins 优先（有内容就用它），否则按形状读 plugins/config.json。
 * 两者都没有 → 空数组、不报码（诚实：没有启用的插件）。
 */
async function enabledPluginSpecs(
  pluginsDir: string,
  settings: unknown,
  maxFileBytes: number,
  skipped: ForeignSkip[],
): Promise<string[]> {
  const fromSettings = enabledSpecsFromSettings(settings);
  if (fromSettings.length > 0) return fromSettings;
  const configPath = path.join(pluginsDir, 'config.json');
  const jr = await readJsonSafe(configPath, maxFileBytes);
  if (!jr.ok) {
    if (jr.problem !== 'missing') {
      skipped.push({ code: 'source-unreadable', origin: 'plugins/config.json', detail: jr.problem });
    }
    return [];
  }
  const recognized = recognizePluginsConfig(jr.value);
  if (recognized === null) {
    skipped.push({ code: 'source-unreadable', origin: 'plugins/config.json', detail: PLUGINS_CONFIG_UNKNOWN_SHAPE });
    return [];
  }
  return recognized;
}

/** `name@marketplace` → { name, marketplace }；没有 @ 或 @ 在边界上 = 只有名字 */
function splitPluginSpec(spec: string): { name: string; marketplace?: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) return { name: spec };
  return { name: spec.slice(0, at), marketplace: spec.slice(at + 1) };
}

/** dirent 的最小形状（刻意不 import node:fs：B 档白名单要求 import fs 的模块恰好等于白名单） */
interface DirEntryLike {
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

/** 某个父目录下名为 name 的条目（**不跟链接**：dirent 自带 isSymbolicLink） */
async function direntOf(target: string): Promise<DirEntryLike | null> {
  const parent = path.dirname(target);
  const base = path.basename(target);
  for (const entry of await listDirSafe(parent)) {
    if (entry.name === base) return entry;
  }
  return null;
}

type Located =
  | { kind: 'dir'; dir: string }
  | { kind: 'symlink' }
  | { kind: 'missing' };

/**
 * 定位插件安装目录（顺序：市场下 plugins/ → external_plugins/ → 市场 installLocation 的同名目录及其
 * 两种标准子目录）。命中符号链接 → symlink（不跟随）；都不在 → missing（由调用方报码）。
 */
async function locatePluginDir(
  pluginsDir: string,
  name: string,
  marketplace: string | undefined,
  market: MarketplaceRecord | undefined,
): Promise<Located> {
  const candidates: string[] = [];
  if (marketplace !== undefined) {
    const marketDir = path.join(pluginsDir, 'marketplaces', marketplace);
    candidates.push(path.join(marketDir, 'plugins', name));
    candidates.push(path.join(marketDir, 'external_plugins', name));
  } else {
    candidates.push(path.join(pluginsDir, name));
  }
  if (market?.installLocation !== undefined) {
    candidates.push(path.join(market.installLocation, name));
    candidates.push(path.join(market.installLocation, 'plugins', name));
    candidates.push(path.join(market.installLocation, 'external_plugins', name));
  }
  let symlinkHit = false;
  for (const candidate of candidates) {
    const entry = await direntOf(candidate);
    if (entry === null) continue;
    if (entry.isSymbolicLink()) { symlinkHit = true; continue; }
    if (entry.isDirectory()) return { kind: 'dir', dir: candidate };
  }
  return symlinkHit ? { kind: 'symlink' } : { kind: 'missing' };
}

/** 插件自述（.claude-plugin/plugin.json）：解析失败用目录名并报码，绝不猜 */
async function readPluginManifest(
  pluginDir: string,
  fallbackName: string,
  maxFileBytes: number,
  findings: ForeignSkip[],
): Promise<{ name: string; version?: string }> {
  const out: { name: string; version?: string } = { name: fallbackName };
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const jr = await readJsonSafe(manifestPath, maxFileBytes);
  if (!jr.ok) {
    if (jr.problem !== 'missing') {
      findings.push({ code: 'source-unreadable', origin: 'plugin:' + fallbackName + '/plugin.json', detail: jr.problem });
    }
    return out;
  }
  if (!isRecord(jr.value)) {
    findings.push({ code: 'source-unreadable', origin: 'plugin:' + fallbackName + '/plugin.json', detail: 'not-mapping' });
    return out;
  }
  const name = jr.value['name'];
  if (typeof name === 'string' && name.trim() !== '') out.name = name.trim();
  const version = jr.value['version'];
  if (typeof version === 'string' && version.trim() !== '') out.version = version.trim();
  return out;
}

/**
 * 读一个已定位的插件目录。**只读元数据与组件清单**：
 *  - skills：技能文本（唯一允许进包的文件内容，凭据扫描在翻译层）；
 *  - .mcp.json：原样交翻译层（凭据剥离在 kernel）；
 *  - commands / agents / hooks：**只数文件 / 只取文件名**，内容一个字节都不读。
 */
async function readPluginAt(
  pluginDir: string,
  specName: string,
  marketplace: string | undefined,
  market: MarketplaceRecord | undefined,
  options: { maxPluginFiles: number; maxFileBytes: number; installRel?: string },
): Promise<ClaudePluginInput> {
  const findings: ForeignSkip[] = [];
  const manifest = await readPluginManifest(pluginDir, specName, options.maxFileBytes, findings);
  const plugin: ClaudePluginInput = { name: manifest.name, components: [] };
  if (manifest.version !== undefined) plugin.version = manifest.version;
  if (options.installRel !== undefined) plugin.installRel = options.installRel;
  if (marketplace !== undefined) plugin.marketplace = marketplace;
  if (market?.repo !== undefined) plugin.repo = market.repo;

  /* skills（有总量上限：跨技能累计，触顶报 max-plugin-files-reached） */
  const skills: ClaudeSkillInput[] = [];
  let filesUsed = 0;
  let filesTruncated = false;
  const units = await readSkillUnits(path.join(pluginDir, 'skills'), {
    maxFiles: options.maxPluginFiles,
    maxBytes: options.maxFileBytes,
    origin: 'plugin:' + specName + '/skills',
    skips: findings,
  });
  for (const unit of units) {
    if (filesUsed >= options.maxPluginFiles) { filesTruncated = true; break; }
    const room = options.maxPluginFiles - filesUsed;
    const files = unit.files.slice(0, room);
    if (files.length < unit.files.length) filesTruncated = true;
    if (files.length === 0) continue;
    skills.push({ name: unit.name, files });
    filesUsed += files.length;
  }
  if (skills.length > 0) {
    plugin.skills = skills;
    plugin.components.push('skills');
  }

  /* .mcp.json：原始 JSON 交给翻译层（本层不读 headers 的值语义，也不改写） */
  const mcp = await readJsonSafe(path.join(pluginDir, '.mcp.json'), options.maxFileBytes);
  if (mcp.ok) {
    plugin.mcpJson = mcp.value;
    plugin.components.push('mcp');
  } else if (mcp.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: 'plugin:' + specName + '/.mcp.json', detail: mcp.problem });
  }

  /* commands/**：递归计数（只数，不读内容） */
  const commandFiles = await walkFiles(path.join(pluginDir, 'commands'), {
    maxDepth: WALK_MAX_DEPTH,
    maxFiles: options.maxPluginFiles,
  });
  if (commandFiles.length > 0) {
    plugin.commandCount = commandFiles.length;
    plugin.components.push('commands');
  }
  if (commandFiles.length >= options.maxPluginFiles) filesTruncated = true;

  /* agents/*.md：只取文件名（不读内容） */
  const agentFiles = await walkFiles(path.join(pluginDir, 'agents'), {
    maxDepth: 0,
    maxFiles: options.maxPluginFiles,
    match: (name) => name.endsWith('.md'),
  });
  if (agentFiles.length > 0) {
    plugin.agents = agentFiles.map((file) => file.name).sort();
    plugin.components.push('agents');
  }
  if (agentFiles.length >= options.maxPluginFiles) filesTruncated = true;

  /* hooks/ 与 hooks.json：**只数文件数**（hooks 是执行面，内容一律不读） */
  const hookFiles = await walkFiles(path.join(pluginDir, 'hooks'), {
    maxDepth: WALK_MAX_DEPTH,
    maxFiles: options.maxPluginFiles,
  });
  let hookCount = hookFiles.length;
  if (hookCount >= options.maxPluginFiles) filesTruncated = true;
  const hooksJson = await statOrNull(path.join(pluginDir, 'hooks.json'));
  if (hooksJson !== null && hooksJson.isFile()) hookCount += 1;
  if (hookCount > 0) {
    plugin.hookFiles = hookCount;
    plugin.components.push('hooks');
  }

  if (filesTruncated) {
    findings.push({
      code: 'source-unreadable',
      origin: 'plugin:' + specName,
      detail: MAX_PLUGIN_FILES_REACHED,
      count: options.maxPluginFiles,
    });
  }
  if (findings.length > 0) plugin.readFindings = findings;
  return plugin;
}

export async function readClaudePlugins(opts: ClaudePluginReadOptions): Promise<ClaudePluginReadResult> {
  const skipped: ForeignSkip[] = [];
  const plugins: ClaudePluginInput[] = [];
  const counts: Record<string, number> = {};
  const maxFileBytes = positiveLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxPlugins = positiveLimit(opts.limits?.maxPlugins, DEFAULT_MAX_PLUGINS);
  const maxPluginFiles = positiveLimit(opts.limits?.maxPluginFiles, DEFAULT_MAX_PLUGIN_FILES);
  const pluginsDir = path.join(opts.claudeDir, 'plugins');

  const markets = await readKnownMarketplaces(pluginsDir, maxFileBytes, skipped);
  const marketByName = new Map(markets.map((market) => [market.name, market]));
  const specs = await enabledPluginSpecs(pluginsDir, opts.settings, maxFileBytes, skipped);

  counts['marketplaces'] = markets.length;
  // 「启用条数」：值为真值的键（含找不到安装目录的那些，它们会在 skipped 里各留一条）
  counts['enabledPlugins'] = specs.length;

  const limited = specs.slice(0, maxPlugins);
  if (specs.length > maxPlugins) {
    skipped.push({ code: 'source-unreadable', origin: 'plugins', detail: MAX_PLUGINS_REACHED, count: maxPlugins });
  }

  let pluginSkills = 0;
  let pluginCommands = 0;
  let pluginAgents = 0;
  let pluginHooks = 0;
  for (const spec of limited) {
    const { name, marketplace } = splitPluginSpec(spec);
    const market = marketplace !== undefined ? marketByName.get(marketplace) : undefined;
    const located = await locatePluginDir(pluginsDir, name, marketplace, market);
    if (located.kind === 'missing') {
      // 有启用记录但找不到安装目录：如实报码（不产出半成品条目）
      skipped.push({ code: 'source-unreadable', origin: 'plugin:' + name });
      continue;
    }
    if (located.kind === 'symlink') {
      skipped.push({ code: 'source-unreadable', origin: 'plugin:' + name, detail: DETAIL_SYMLINK });
      continue;
    }
    // 安装位置只进溯源元数据（相对 plugins 目录的 POSIX 路径；逃出该目录时**省略**而不是回传机器路径）
    const rel = toPosixPath(path.relative(pluginsDir, located.dir));
    const installRel = rel !== '' && !rel.startsWith('..') ? rel : undefined;
    const plugin = await readPluginAt(located.dir, name, marketplace, market, {
      maxPluginFiles,
      maxFileBytes,
      ...(installRel !== undefined ? { installRel } : {}),
    });
    plugins.push(plugin);
    pluginSkills += plugin.skills?.length ?? 0;
    pluginCommands += plugin.commandCount ?? 0;
    pluginAgents += plugin.agents?.length ?? 0;
    pluginHooks += plugin.hookFiles ?? 0;
  }

  counts['plugins'] = plugins.length;
  counts['pluginSkills'] = pluginSkills;
  counts['pluginCommands'] = pluginCommands;
  counts['pluginAgents'] = pluginAgents;
  counts['pluginHooks'] = pluginHooks;

  return { plugins, marketplaces: markets.map((market) => (market.repo !== undefined ? { name: market.name, repo: market.repo } : { name: market.name })), skipped, counts };
}
