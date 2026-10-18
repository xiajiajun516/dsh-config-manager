/**
 * Claude Code 用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 三个作用域（2026-10-18 审计后补齐）：
 *  ① 用户级：`<configDir>/settings.json`、CLAUDE.md、skills、commands、projects/*.jsonl（用户级
 *     `agents/` 本层刻意不采集：types 的 ClaudeCodeInput 没有对应字段，读了也无处交付）；
 *  ② 项目级：`~/.claude.json` 的 `projects` 键（Claude Code 自己写的权威清单）+ 调用方显式给出的
 *     `projectPaths`；每个项目读 `.claude/settings(.local).json`、CLAUDE(.local).md、`.claude/rules`、
 *     `.claude/skills`、`.claude/commands`、`.claude/agents`、`.mcp.json`，以及全局清单里该项目的
 *     `mcpServers`；
 *  ③ 插件：委托 `read-claude-plugins.ts`（只读元数据与技能文本，**绝不执行/复制插件代码**）。
 *
 * 配置目录可被 `CLAUDE_CONFIG_DIR` 覆盖（**非空才生效**）：命中即报 source-location-overridden，
 * 并且**只读覆盖后的目录** —— 绝不回落到默认位置（回落会把「位置已被覆盖」这件事藏起来，
 * 用户会以为读到的是 `~/.claude`）。
 *
 * 五条硬边界（与同域其它读盘层同口径）：
 *  - **绝不跟随符号链接**（技能目录是链接时跳过并报 symlink-skipped；项目内直读文件同样先 lstat）；
 *  - 单文件有字节上限，超限**不读**并如实上报，绝不截断；
 *  - 一切触顶（会话数 / 项目数 / 技能文件数）都报**稳定机器码**，绝不静默（audit-foreign F4 同族）；
 *  - 读盘层只回数据与机器码，**绝不产生用户可见字符串**；本层读到的**值**交给翻译层剥离凭据后才进包；
 *  - 项目根**只取真实存在且是目录的**（不猜「项目就是 cwd」），已删除的项目安静跳过。
 *
 * 与 read-claude-plugins.ts 的关系：本文件动态 import 它（避免两个读盘模块的静态 import 环）；
 * 它反向静态 import 本文件的 readSkillUnits —— 静态依赖是单向的。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../utils/guards.ts';
import { dirWalkSkips, resolveLimit, type DirWalkStats } from './session-read.ts';
import type {
  ClaudeCodeInput,
  ClaudeProjectInput,
  ClaudeSessionInput,
  ClaudeSkillInput,
  ForeignLimitOverrides,
  ForeignSkip,
} from './types.ts';

export interface ClaudeCodeReadOptions {
  /** 用户 home（含 .claude 目录 / .claude.json） */
  homeDir: string;
  /** 进程环境快照（只读）：只有 CLAUDE_CONFIG_DIR 参与判定，绝不读凭据类变量 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 调用方**显式**给出的项目根（优先于 ~/.claude.json 的 projects 键；缺省 = 不猜任何项目） */
  projectPaths?: readonly string[];
  /** 单文件读取上限（默认 8 MiB）；超过即不读，并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个 skill 目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 会话文件数上限（默认 500）；触顶报 source-unreadable/max-sessions-reached */
  maxSessionFiles?: number;
  /** 单个会话文件的上限（默认 32 MiB）；超限即不读并计入 unreadable，绝不截断 */
  maxSessionFileBytes?: number;
  /** 项目扫描上限（默认 50）；触顶报 source-unreadable/max-projects-reached */
  maxProjects?: number;
  /** 插件数上限（默认 50，透传给 read-claude-plugins） */
  maxPlugins?: number;
  /** 单插件文件数上限（默认 200，透传给 read-claude-plugins） */
  maxPluginFiles?: number;
  /** 可选上限覆盖（t36，装配层透传；缺省 = 上面各默认值逐字不变） */
  limits?: ForeignLimitOverrides;
}

export interface ClaudeCodeReadResult {
  /** 是否找到 Claude Code 的痕迹（配置目录或 ~/.claude.json） */
  found: boolean;
  input: ClaudeCodeInput;
  skipped: ForeignSkip[];
  /** 读不到 / 超限 / JSON 解析失败的**相对路径**（不含任何内容、不含机器绝对路径） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SESSION_FILES = 500;
const DEFAULT_MAX_SESSION_FILE = 32 * 1024 * 1024;
const DEFAULT_MAX_PROJECTS = 50;
/** 全局指令文件（CLAUDE.md）单独给上限：它是纯文本，正常只有几十 KB */
const MEMORY_MAX_FILE = 1024 * 1024;
/** 目录走盘的最大下钻深度（与 session-read 的 WalkOptions 缺省一致） */
const WALK_MAX_DEPTH = 8;
/** 环境变量名（唯一判据） */
const ENV_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';
/** 触顶 / 跳过的稳定机器码（进 ForeignSkip.detail，绝不进用户可见文案） */
const DETAIL_MAX_SESSIONS = 'max-sessions-reached';
const DETAIL_MAX_PROJECTS = 'max-projects-reached';
const DETAIL_SYMLINK = 'symlink-skipped';

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** lstat：**不跟随**符号链接（项目内直读文件必须先看它） */
async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** 目录条目（排序；三平台 readdir 顺序不同，排序让产物与测试确定） */
async function listDirents(dir: string): Promise<Dirent[]> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    return dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

interface JsonRead { ok: boolean; value?: unknown }

async function readTextSafe(p: string, max: number): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > max) return null;
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonSafe(p: string, max: number): Promise<JsonRead> {
  const text = await readTextSafe(p, max);
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** CLAUDE_CONFIG_DIR 的非空取值（空串 / 纯空白视为「没设置」——Claude Code 自身也是这个语义） */
function configDirOverrideOf(env: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
  if (env === undefined) return undefined;
  const raw = env[ENV_CONFIG_DIR];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** ~/.claude.json 的 lastVersionBase（来源侧版本标记；不是字符串就不猜） */
function lastVersionBaseOf(claudeJson: unknown): string | undefined {
  if (!isRecord(claudeJson)) return undefined;
  const value = claudeJson['lastVersionBase'];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

interface SkillFile { relativePath: string; data: Uint8Array }

/** 递归收集一个 skill 目录下的普通文件（不跟随符号链接；条目数与单文件字节都有上限） */
async function walkFiles(
  root: string,
  start: string,
  maxFiles: number,
  maxBytes: number,
  stats?: DirWalkStats,
): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // t36：条数触顶不再静默 —— 置标志，由调用方推 max-skill-files-reached。
      if (out.length >= maxFiles) { if (stats !== undefined) stats.truncatedFiles = true; break; }
      const full = path.join(cur, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await statOrNull(full);
      if (st === null) continue;
      if (st.size > maxBytes) {
        // t36：字节上限触顶同样不静默（统计条数，由调用方推 too-large）。
        if (stats !== undefined) stats.tooLargeCount = (stats.tooLargeCount ?? 0) + 1;
        continue;
      }
      try {
        const data = await fs.readFile(full);
        out.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), data });
      } catch {
        // 单个文件读不到就不带：该 skill 的成员数会随之少一个，用户在计数上看得见
      }
    }
  }
  return out;
}

/** 技能目录读取的可选参数（用户级 / 项目级 / 插件级共用同一份口径） */
export interface SkillDirReadOptions {
  /** 单个技能目录的文件数上限 */
  maxFiles: number;
  /** 单文件字节上限 */
  maxBytes: number;
  /** 位置标签前缀（**包内相对标签**，绝不含机器路径） */
  origin: string;
  /** 发现写这里（符号链接跳过 / 条数触顶 / 字节超限） */
  skips: ForeignSkip[];
}

/**
 * 读一个 **skills 目录**（只压平一层：`<skills>/<技能名>/**`）。
 *
 * 三条不静默（缺陷 2 修复）：技能目录本身是符号链接 → source-unreadable + symlink-skipped；
 * 条数触顶 → max-skill-files-reached；单文件超字节 → too-large。
 * 结果按技能名排序（readdir 顺序在三个平台不同）。
 */
export async function readSkillUnits(dir: string, opts: SkillDirReadOptions): Promise<ClaudeSkillInput[]> {
  const out: ClaudeSkillInput[] = [];
  for (const d of await listDirents(dir)) {
    if (d.isSymbolicLink()) {
      // 缺陷 2：此前这里直接 continue（整块技能消失且一个字都不报）
      opts.skips.push({ code: 'source-unreadable', origin: opts.origin + '/' + d.name, detail: DETAIL_SYMLINK });
      continue;
    }
    if (!d.isDirectory()) continue;
    const skillDir = path.join(dir, d.name);
    const stats: DirWalkStats = {};
    const files = await walkFiles(skillDir, skillDir, opts.maxFiles, opts.maxBytes, stats);
    opts.skips.push(...dirWalkSkips(stats, opts.origin, opts.maxFiles));
    if (files.length === 0) continue;
    out.push({ name: d.name, files });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * 取「记录自带的 sessionId」：只扫前 64 KiB（够看清头部记录，不必为它把整份日志再解析一遍）。
 * 取不到就返回 undefined —— 不猜、不伪造。
 */
const RECORD_ID_SCAN_BYTES = 64 * 1024;
function recordSessionIdOf(text: string): string | undefined {
  const head = text.length > RECORD_ID_SCAN_BYTES ? text.slice(0, RECORD_ID_SCAN_BYTES) : text;
  const m = /"sessionId"\s*:\s*"([^"]+)"/.exec(head);
  const hit = m === null ? undefined : m[1];
  return hit === undefined || hit === '' ? undefined : hit;
}

/**
 * 会话文件：只扫 `<projects>/<项目>/<uuid>.jsonl` 这一层（不递归子目录、不跟随符号链接）。
 * 读不到 / 超限的文件**不静默跳过**：进 unreadable 并变成一条 source-unreadable finding；
 * 条数触顶（缺陷 1 修复）回 truncated=true，由调用方推 max-sessions-reached。
 */
async function readSessions(
  projectsDir: string,
  maxFiles: number,
  maxBytes: number,
): Promise<{ files: ClaudeSessionInput[]; unreadable: string[]; truncated: boolean }> {
  const files: ClaudeSessionInput[] = [];
  const unreadable: string[] = [];
  let truncated = false;
  for (const pd of await listDirents(projectsDir)) {
    if (!pd.isDirectory() || pd.isSymbolicLink()) continue;
    const dir = path.join(projectsDir, pd.name);
    for (const e of await listDirents(dir)) {
      if (!e.isFile() || e.isSymbolicLink()) continue;
      if (!e.name.endsWith('.jsonl')) continue;
      // 触顶判定放在「真的还有下一个候选文件」处：恰好等于上限但目录里没有下一个 → 不报码
      if (files.length >= maxFiles) { truncated = true; break; }
      const rel = '.claude/projects/' + pd.name + '/' + e.name;
      const abs = path.join(dir, e.name);
      const text = await readTextSafe(abs, maxBytes);
      if (text === null) {
        unreadable.push(rel);
        continue;
      }
      const id = e.name.slice(0, e.name.length - '.jsonl'.length);
      // 记录自带的 sessionId（≠ 文件名 stem 时由翻译层报 session-id-mismatch，不静默）
      const recordSessionId = recordSessionIdOf(text);
      // 确定性墙钟回落 = 文件 mtime：记录自身有时间戳时它不被使用；没有时它让**同一来源两次
      // 转码字节逐字相同** ⇒ 重复导入才会被判成 Skip 而不是 Conflict（审计缺陷 4 的接线口）。
      const st = await statOrNull(abs);
      files.push({
        id,
        text,
        ...(recordSessionId !== undefined ? { recordSessionId } : {}),
        ...(st !== null ? { createdAtMs: st.mtimeMs } : {}),
      });
    }
    if (truncated) break;
  }
  return { files, unreadable, truncated };
}

/** 递归统计目录下的普通文件数（不跟随符号链接；深度上限与 walk 同口径） */
async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const d of await listDirents(cur.dir)) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (cur.depth < WALK_MAX_DEPTH) stack.push({ dir: path.join(cur.dir, d.name), depth: cur.depth + 1 });
        continue;
      }
      if (d.isFile()) count += 1;
    }
  }
  return count;
}

/** `<dir>/*.md` 的「名字 + 文件名」（子代理定义只报告结构，不搬内容） */
async function readAgentNames(dir: string): Promise<{ name: string; file: string }[]> {
  const out: { name: string; file: string }[] = [];
  for (const d of await listDirents(dir)) {
    if (d.isSymbolicLink() || !d.isFile() || !d.name.endsWith('.md')) continue;
    out.push({ name: d.name.slice(0, 0 - '.md'.length), file: d.name });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/** `<dir>/*.md` 的原文（规则文件带 frontmatter 的作用域由翻译层报 unsupported-rules） */
async function readRuleFiles(
  dir: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  for (const d of await listDirents(dir)) {
    if (d.isSymbolicLink() || !d.isFile() || !d.name.endsWith('.md')) continue;
    const text = await readTextSafe(path.join(dir, d.name), maxBytes);
    if (text === null) {
      findings.push({ code: 'source-unreadable', origin: '.claude/rules/' + d.name });
      continue;
    }
    out.push({ name: d.name, text });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 直读一个项目内文件（**先 lstat**：符号链接一律不读、报码） */
async function probeProjectJson(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<unknown | undefined> {
  const st = await lstatOrNull(p);
  if (st === null) return undefined;
  if (st.isSymbolicLink()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: DETAIL_SYMLINK });
    return undefined;
  }
  if (!st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'not-a-file' });
    return undefined;
  }
  if (st.size === 0) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'empty' });
    return undefined;
  }
  if (st.size > maxBytes) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return undefined;
  }
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'json-error' });
    return undefined;
  }
}

/** 直读一个项目内文本文件（**先 lstat**：符号链接一律不读、报码） */
async function probeProjectText(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<string | undefined> {
  const st = await lstatOrNull(p);
  if (st === null) return undefined;
  if (st.isSymbolicLink()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: DETAIL_SYMLINK });
    return undefined;
  }
  if (!st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'not-a-file' });
    return undefined;
  }
  if (st.size > maxBytes) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return undefined;
  }
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return undefined;
  }
}

/** 项目候选（root 已 resolve；jsonKey = ~/.claude.json 里的原始键，用于取该项目的 mcpServers） */
interface ProjectCandidate {
  root: string;
  jsonKey?: string;
  mcp?: unknown;
}

/**
 * 收集项目根候选：**调用方显式给出的优先**，然后才是 `~/.claude.json` 的 projects 键（字典序）。
 * 只做去重与排序，**不做存在性判定**（那一步需要 fs，见 scanProjectRoots）。
 */
function collectProjectCandidates(
  claudeJson: unknown,
  explicit: readonly string[] | undefined,
): ProjectCandidate[] {
  const byRoot = new Map<string, ProjectCandidate>();
  const order: string[] = [];
  const add = (raw: string, jsonKey?: string, mcp?: unknown): void => {
    const abs = path.resolve(raw);
    const existing = byRoot.get(abs);
    if (existing !== undefined) {
      // 显式路径与清单键指向同一项目：补上清单里的 mcpServers（显式路径本身不带它）
      if (existing.jsonKey === undefined && jsonKey !== undefined) {
        existing.jsonKey = jsonKey;
        existing.mcp = mcp;
      }
      return;
    }
    const candidate: ProjectCandidate = { root: abs };
    if (jsonKey !== undefined) candidate.jsonKey = jsonKey;
    if (mcp !== undefined) candidate.mcp = mcp;
    byRoot.set(abs, candidate);
    order.push(abs);
  };
  for (const p of explicit ?? []) {
    if (typeof p === 'string' && p.trim() !== '') add(p);
  }
  if (isRecord(claudeJson)) {
    const projects = claudeJson['projects'];
    if (isRecord(projects)) {
      for (const key of Object.keys(projects).sort()) {
        const entry = projects[key];
        add(key, key, isRecord(entry) ? entry['mcpServers'] : undefined);
      }
    }
  }
  return order.map((abs) => byRoot.get(abs)).filter((c): c is ProjectCandidate => c !== undefined);
}

/**
 * 读一个项目根。
 *
 * 纪律：`.claude` 不存在 → **只留 root 与 hasClaudeDir:false**（绝不产出空 finding：那是
 * 「这个项目没用过 Claude Code」，不是错误）；项目根不存在 / 不是目录 → 安静跳过（已删除的项目）。
 */
async function scanProjectRoot(
  candidate: ProjectCandidate,
  maxFileBytes: number,
  maxSkillFiles: number,
): Promise<ClaudeProjectInput> {
  const findings: ForeignSkip[] = [];
  const out: ClaudeProjectInput = { root: candidate.root };
  const claudeDir = path.join(candidate.root, '.claude');
  const dirStat = await statOrNull(claudeDir);
  const hasClaudeDir = dirStat !== null && dirStat.isDirectory();
  out.hasClaudeDir = hasClaudeDir;
  // 没有 .claude 的项目**只留 root + hasClaudeDir:false**（连 claude.json 里的 mcpServers 也不带：
  // 那会把「这个项目没有 Claude 配置目录」与「它有项目级配置」混成同一种形态）
  if (!hasClaudeDir) return out;
  if (candidate.mcp !== undefined) out.projectMcp = candidate.mcp;

  const settings = await probeProjectJson(path.join(claudeDir, 'settings.json'), '.claude/settings.json', maxFileBytes, findings);
  if (settings !== undefined) out.settings = settings;
  const settingsLocal = await probeProjectJson(path.join(claudeDir, 'settings.local.json'), '.claude/settings.local.json', maxFileBytes, findings);
  if (settingsLocal !== undefined) out.settingsLocal = settingsLocal;

  const memory = await probeProjectText(path.join(candidate.root, 'CLAUDE.md'), 'CLAUDE.md', MEMORY_MAX_FILE, findings);
  if (memory !== undefined) out.memory = memory;
  const memoryLocal = await probeProjectText(path.join(candidate.root, 'CLAUDE.local.md'), 'CLAUDE.local.md', MEMORY_MAX_FILE, findings);
  if (memoryLocal !== undefined) out.memoryLocal = memoryLocal;

  const rules = await readRuleFiles(path.join(claudeDir, 'rules'), maxFileBytes, findings);
  if (rules.length > 0) out.rules = rules;

  const skills = await readSkillUnits(path.join(claudeDir, 'skills'), {
    maxFiles: maxSkillFiles,
    maxBytes: maxFileBytes,
    origin: '.claude/skills',
    skips: findings,
  });
  if (skills.length > 0) out.skills = skills;

  const commandCount = await countFilesRecursive(path.join(claudeDir, 'commands'));
  if (commandCount > 0) out.commandCount = commandCount;

  const agents = await readAgentNames(path.join(claudeDir, 'agents'));
  if (agents.length > 0) out.agents = agents;

  const mcpJson = await probeProjectJson(path.join(candidate.root, '.mcp.json'), '.mcp.json', maxFileBytes, findings);
  if (mcpJson !== undefined) out.mcpJson = mcpJson;

  if (findings.length > 0) out.readFindings = findings;
  return out;
}

/**
 * 扫项目根：**只收真实存在且是目录的**（按候选顺序，显式优先 + 清单字典序）；
 * 触顶（maxProjects）**必须报码**（origin='projects'，count=上限），绝不静默少扫。
 */
async function scanProjectRoots(
  candidates: readonly ProjectCandidate[],
  maxProjects: number,
  maxFileBytes: number,
  maxSkillFiles: number,
): Promise<{ projects: ClaudeProjectInput[]; skipped: ForeignSkip[] }> {
  const roots: ProjectCandidate[] = [];
  let truncated = false;
  for (const candidate of candidates) {
    const st = await statOrNull(candidate.root);
    if (st === null || !st.isDirectory()) continue;
    if (roots.length >= maxProjects) { truncated = true; break; }
    roots.push(candidate);
  }
  const projects: ClaudeProjectInput[] = [];
  for (const root of roots) projects.push(await scanProjectRoot(root, maxFileBytes, maxSkillFiles));
  const skipped: ForeignSkip[] = [];
  if (truncated) {
    skipped.push({ code: 'source-unreadable', origin: 'projects', detail: DETAIL_MAX_PROJECTS, count: maxProjects });
  }
  return { projects, skipped };
}

export async function readClaudeCode(opts: ClaudeCodeReadOptions): Promise<ClaudeCodeReadResult> {
  const home = opts.homeDir;
  const maxFileBytes = resolveLimit(opts.limits?.maxFileBytes, opts.maxFileBytes, DEFAULT_MAX_FILE);
  const maxSkillFiles = resolveLimit(opts.limits?.maxSkillFiles, opts.maxSkillFiles, DEFAULT_MAX_SKILL_FILES);
  const maxSessionFiles = resolveLimit(opts.limits?.maxSessionFiles, opts.maxSessionFiles, DEFAULT_MAX_SESSION_FILES);
  const maxSessionFileBytes = resolveLimit(undefined, opts.maxSessionFileBytes, DEFAULT_MAX_SESSION_FILE);
  const maxProjects = resolveLimit(undefined, opts.maxProjects, DEFAULT_MAX_PROJECTS);
  const skipped: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: ClaudeCodeInput = {};

  /* ---------------- A. 配置目录（CLAUDE_CONFIG_DIR 覆盖） ---------------- */
  const override = configDirOverrideOf(opts.env);
  const claudeDir = override !== undefined ? path.resolve(override) : path.join(home, '.claude');
  input.configDir = claudeDir;
  if (override !== undefined) {
    input.configDirOverridden = true;
    skipped.push({ code: 'source-location-overridden', origin: 'settings' });
  }

  /**
   * ~/.claude.json 的位置：未覆盖时只有 home 一处；覆盖时先看配置目录内（Claude Code 把全局
   * 配置文件也放在配置目录里），再看 home —— 两处都只是**存在性**判定，绝不猜内容。
   */
  const legacyCandidates = override !== undefined
    ? [path.join(claudeDir, '.claude.json'), path.join(home, '.claude.json')]
    : [path.join(home, '.claude.json')];
  let legacyPath: string | undefined;
  for (const candidate of legacyCandidates) {
    if ((await statOrNull(candidate)) !== null) { legacyPath = candidate; break; }
  }
  const dirStat = await statOrNull(claudeDir);
  const hasDir = dirStat !== null && dirStat.isDirectory();
  /** 显式给出的项目根也算「可能的痕迹」：用户级什么都没装、只有项目级 .claude 的情况真实存在 */
  const hasExplicitProjects = (opts.projectPaths ?? []).some((p) => typeof p === 'string' && p.trim() !== '');
  if (!hasDir && legacyPath === undefined && !hasExplicitProjects) {
    return { found: false, input, skipped, unreadable };
  }

  if (legacyPath !== undefined) {
    const jr = await readJsonSafe(legacyPath, maxFileBytes);
    if (jr.ok) {
      input.claudeJson = jr.value;
      const version = lastVersionBaseOf(jr.value);
      if (version !== undefined) input.sourceVersion = version;
    } else {
      unreadable.push('.claude.json');
      skipped.push({ code: 'source-unreadable', origin: '.claude.json' });
    }
  }

  /* ---------------- 用户级 ---------------- */
  const settingsPath = path.join(claudeDir, 'settings.json');
  const sr = await readJsonSafe(settingsPath, maxFileBytes);
  if (sr.ok) input.settings = sr.value;
  else if ((await statOrNull(settingsPath)) !== null) {
    unreadable.push('.claude/settings.json');
    skipped.push({ code: 'source-unreadable', origin: '.claude/settings.json' });
  }

  const memoryPath = path.join(claudeDir, 'CLAUDE.md');
  const memory = await readTextSafe(memoryPath, MEMORY_MAX_FILE);
  if (memory !== null) input.memory = memory;
  else if ((await statOrNull(memoryPath)) !== null) {
    unreadable.push('.claude/CLAUDE.md');
    skipped.push({ code: 'source-unreadable', origin: '.claude/CLAUDE.md' });
  }

  const skills = await readSkillUnits(path.join(claudeDir, 'skills'), {
    maxFiles: maxSkillFiles,
    maxBytes: maxFileBytes,
    origin: 'skills',
    skips: skipped,
  });
  if (skills.length > 0) input.skills = skills;

  const commandCount = await countFilesRecursive(path.join(claudeDir, 'commands'));
  if (commandCount > 0) input.commandCount = commandCount;

  /**
   * 用户级 `agents/` 刻意**不采集**：types 的 ClaudeCodeInput 没有对应字段（契约冻结），
   * 读出来也无处交付 —— 采集了却只能丢掉，等于制造「读到了但包外看不见」的假象。
   * 项目级 agents 有字段（ClaudeProjectInput.agents）且任务要求，故只做项目级。
   */

  const sessions = await readSessions(path.join(claudeDir, 'projects'), maxSessionFiles, maxSessionFileBytes);
  if (sessions.files.length > 0) input.sessions = sessions.files;
  for (const rel of sessions.unreadable) {
    unreadable.push(rel);
    skipped.push({ code: 'source-unreadable', origin: rel });
  }
  if (sessions.truncated) {
    // 缺陷 1：此前直接 break，条数触顶在包外完全不可见
    skipped.push({ code: 'source-unreadable', origin: 'sessions', detail: DETAIL_MAX_SESSIONS, count: maxSessionFiles });
  }

  /* ---------------- B. 项目级 ---------------- */
  const candidates = collectProjectCandidates(input.claudeJson, opts.projectPaths);
  if (candidates.length > 0) {
    const scanned = await scanProjectRoots(candidates, maxProjects, maxFileBytes, maxSkillFiles);
    if (scanned.projects.length > 0) input.projects = scanned.projects;
    skipped.push(...scanned.skipped);
  }

  /* ---------------- C. 插件（委托独立读盘模块，避免静态 import 环） ---------------- */
  if (hasDir) {
    const { readClaudePlugins } = await import('./read-claude-plugins.ts');
    const pluginRead = await readClaudePlugins({
      claudeDir,
      settings: input.settings,
      maxFileBytes,
      limits: {
        ...(opts.maxPlugins !== undefined ? { maxPlugins: opts.maxPlugins } : {}),
        ...(opts.maxPluginFiles !== undefined ? { maxPluginFiles: opts.maxPluginFiles } : {}),
      },
    });
    if (pluginRead.plugins.length > 0) input.plugins = pluginRead.plugins;
    if (pluginRead.marketplaces.length > 0) input.marketplaces = pluginRead.marketplaces;
    // 只有**没有归属单元**的发现走顶层 skipped（插件自身的发现挂在 plugin.readFindings 上）
    skipped.push(...pluginRead.skipped);
  }

  /* 只有「项目级 .claude 存在」时才把 found 判成 true；否则如实说「没有痕迹」（绝不假装找到了） */
  const projectsFound = (input.projects ?? []).some((project) => project.hasClaudeDir === true);
  if (!hasDir && legacyPath === undefined && !projectsFound) {
    return { found: false, input, skipped, unreadable };
  }
  return { found: true, input, skipped, unreadable };
}
