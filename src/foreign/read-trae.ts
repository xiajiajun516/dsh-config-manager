/**
 * Trae 会话读盘层 —— 档 B「VS Code 多发行版」来源（真值表见 truth-table.ts 的 trae 行）。
 *
 * 数据根（read-vault §10.1 trae 行 + chat-import discovery.mjs:80-93,140 + read-sessions-manager 第 27 行，
 * **三份逐字一致**）：VS Code User 根 × 4 个发行版名 × 三分支
 *   win32  = %APPDATA%/<name>/User
 *   darwin = <home>/Library/Application Support/<name>/User
 *   linux  = $XDG_CONFIG_HOME|<home>/.config>/<name>/User
 *   name ∈ {Trae, Trae CN, TRAE SOLO CN, TRAE SOLO}
 * 全部经 `vscodeUserDataDir(platform, …)`（内部走 roamingAppDataDir + joinFor），**绝不硬编码分隔符**。
 *
 * 存储形态：三份调研一致确认是 **SQLite `state.vscdb`**（<User>/globalStorage/state.vscdb 与
 * <User>/workspaceStorage/<hash>/state.vscdb，表 ItemTable）。⇒ **本批按 SQLite 读**（复用 sqlite.ts
 * 的只读读器；captain 表格里的「文件」标注与 chat-import §3.1 冲突，**以 chat-import 为准**并已记入汇报）。
 *
 * 诚实边界（必须说明，不得美化）：
 *  · `ItemTable` 的键确证的只有 `memento/icube-ai-agent-storage` 一条（chat-import §3.1）；
 *    另有「4 个回退键」但**四份报告都没给出键名** —— 本实现用保守的键名模式（含 icube；或含
 *    trae 且含 chat/agent/session/storage）作为候选，并把「有候选键但解析不出会话」如实报成
 *    `sessions-not-migrated`，绝不假装成功。
 *  · 会话容器的字段级 schema **未取证**：本层用**结构自证**的窄口径（必须有「消息数组 + 至少一条
 *    带 role/type 的消息」）识别会话，容器必须自带字符串 id（否则铸稳定兜底 id）；cwd 只认明文
 *    绝对路径字段，找不到就交给下游落 session-missing-cwd（**绝不猜 cwd**）。
 *
 * 2.3.x 起多了一条通道（issue #134）：会话迁到 `<User>/ModularData/ai-agent/database.db`，
 * **整库 SQLCipher 加密**。解密、临时明文、页头校验都在 trae-sqlcipher.ts（只交出中性行）；
 * 本文件只负责「读表结果 → 统一会话形态」的语义映射（role/正文/cwd 口径与旧通道**同一份代码**）。
 * 两条通道按会话 id 去重、**先加密库后旧库**（迁移后的库才是权威），并存时只计一份。
 */
import { isAbsoluteFor, joinFor, normalizePlatform, vscodeUserDataDir } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { isFile, listDirNames, statOrNull } from './session-read.ts';
import { flattenText, genericBlocksOf } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irBump, irTextBlock, isSafeIrId } from './session-ir.ts';
import { cellBytes, cellText, openSqliteIfShape, sqliteCapability } from './sqlite.ts';
// SQLite 批的**唯一**时间口径（秒/毫秒自适应 + 安全整数）在本文件的共享模块里，不再抄第二份
import { msTime } from './read-opencode.ts';
import { isRecord } from '../utils/guards.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import type { ForeignSkip } from './types.ts';
import { probeTraeEncryptedDatabase, readTraeEncryptedDatabase, traeDbPathFor, traeDbSkipOf } from './trae-sqlcipher.ts';

/** 四个发行版名（顺序 = chat-import traeUserDataDirs 的判定顺序） */
export const TRAE_PRODUCTS: readonly string[] = ['Trae', 'Trae CN', 'TRAE SOLO CN', 'TRAE SOLO'];
export const TRAE_VSCDB_NAME = 'state.vscdb';
export const TRAE_STORAGE_SUBDIRS: readonly string[] = ['globalStorage', 'workspaceStorage'];

const MAX_SESSIONS = 5000;
const MAX_NODES = 50000;
const MAX_DEPTH = 8;

const MESSAGE_ARRAY_KEYS: readonly string[] = [
  // 后三个来自参考 convert/trae.mjs 的 SESSION_MESSAGE_KEYS（旧版 Trae 用它们装消息）
  'messages', 'conversation', 'history', 'chat', 'turns', 'dialogue', 'items', 'records',
  'chatMessages', 'messageList', 'entries',
];
const ID_KEYS: readonly string[] = [
  'id', 'sessionId', 'session_id', 'chatId', 'chat_id', 'conversationId', 'conversation_id', 'uuid', 'key',
];
/**
 * cwd 的候选字段。**刻意收紧**（与参考 convert/trae.mjs 的 SESSION_DIRECTORY_KEYS 同口径）：
 * `path` / `rootPath` 这类键在存储值里到处都是（UI 状态、工具调用、构建脚本），拿它当会话
 * cwd 会**静默**把会话归到错误的项目下。
 */
const CWD_KEYS: readonly string[] = [
  'cwd', 'workspace', 'workspacePath', 'workspace_path', 'projectPath', 'workingDirectory', 'directory',
];
/** 消息正文的候选字段（参考 convert/trae.mjs 的 MESSAGE_TEXT_KEYS；parts 是本地既有兜底） */
const MESSAGE_BODY_KEYS: readonly string[] = [
  'content', 'text', 'message', 'body', 'prompt', 'response', 'output', 'parts', 'result',
];
const TITLE_KEYS: readonly string[] = ['title', 'name', 'summary', 'topic'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'createTime', 'create_time', 'timestamp', 'startTime', 'time'];

/** 静态探测位置 = 4 个 User 目录（state.vscdb 在读取期动态枚举，探测期只 stat 目录） */
export function traeUserDataDirs(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  return TRAE_PRODUCTS.map((product) => vscodeUserDataDir(platform, opts.homeDir, opts.env, product));
}

export function traeProbePaths(opts: RootProbeOptions): string[] {
  return traeUserDataDirs(opts);
}

/** 一条已归一的会话（从 ParsedTranscript 派生 + 源侧 id） */
export interface TraeSessionFile extends ParsedTranscript { readonly id: string }

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 已确证的主存储键（chat-import §3.1） */
export const TRAE_STORAGE_KEY = 'memento/icube-ai-agent-storage';

/**
 * 已确证的**回退键**（参考 lib/sources/trae.mjs 的 TRAE_FALLBACK_KEYS）：
 * 旧版 / 变体发行版把会话放在这两个键下，只认 icube 模式会**整库漏读**（一条会话都读不出来）。
 * 后两个本身就含 icube，列出来是为了让「参考认哪些键」这件事在源码里可见。
 */
export const TRAE_FALLBACK_KEYS: readonly string[] = [
  'chat.ChatSessionStore.index',
  'ChatStore',
  'memento/icube-ai-chat-storage-7467774676505887760',
  'memento/icube-ai-ng-chat-storage-7467774676505887760',
];

/**
 * 聊天存储键的**候选**判定。
 * 判据三层：① 已确证的主键；② 已确证的回退键（大小写不敏感，与 SQLite 的按值查询同义）；
 * ③ 未确证的回退键用模式兜住（含 icube，或含 trae 且含 chat/agent/session/storage）。
 * 第③层**不把它们当成「一定正确」** —— 解析不出内容就走 sessions-not-migrated。
 */
export function isTraeChatStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === TRAE_STORAGE_KEY) return true;
  for (const fallback of TRAE_FALLBACK_KEYS) {
    if (fallback.toLowerCase() === lower) return true;
  }
  if (lower.includes('icube')) return true;
  return lower.includes('trae')
    && (lower.includes('chat') || lower.includes('agent') || lower.includes('session') || lower.includes('storage'));
}

function isAbsoluteCwd(v: unknown, platform: ForeignPlatform): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return isAbsoluteFor(platform, v) ? v : undefined;
}

function cwdOf(node: Record<string, unknown>, platform: ForeignPlatform): string | undefined {
  for (const key of CWD_KEYS) {
    const found = isAbsoluteCwd(node[key], platform);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstOf(node: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = str(node[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Trae 的时间值 → 毫秒（参考 lib/sources/trae.mjs 的 timeValue）。
 *
 * 与 `irSafeTime` 的差异**两条**：① state.vscdb 里秒 / 毫秒两种时间戳都有（< 1e11 按秒换算，
 * 直接当毫秒会落到 1970）；② 「数字字符串」（`"1700000000"`）也是常见形态，`Date.parse`
 * 对它得 NaN（于是 createdAt 退化成导入当天）。换算复用 `read-opencode.ts` 的 `msTime`，
 * 这里只额外剥一层数字串。
 */
export function traeTimeValue(v: unknown): IrTimeMs | undefined {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return msTime(n);
    }
  }
  return msTime(v);
}

function timeOf(node: Record<string, unknown>): number | undefined {
  for (const key of TIME_KEYS) {
    const t = traeTimeValue(node[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 取值集合：数组原样；**对象取其值**（参考 convert/trae.mjs 的 valuesOf）。
 *
 * 为什么必须同时认对象：部分回退存储把会话**按 id 键成对象映射**而不是数组；
 * 只认数组会让整个库看起来「没有会话」。
 */
function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return [];
}

/** 结构自证：集合里**至少一条**带角色字段的记录，才把它当消息集合（挡住任意字符串数组/UI 状态） */
function messageArrayOf(node: Record<string, unknown>): unknown[] | undefined {
  for (const key of MESSAGE_ARRAY_KEYS) {
    const candidate = valuesOf(node[key]);
    if (candidate.length === 0) continue;
    for (const item of candidate) {
      if (!isRecord(item)) continue;
      if (str(item['role']) !== undefined || str(item['type']) !== undefined
        || str(item['sender']) !== undefined || item['author'] !== undefined) return candidate;
    }
  }
  return undefined;
}

function roleOfItem(item: Record<string, unknown>, ignored: Record<string, number>): 'user' | 'assistant' | undefined {
  const author = item['author'];
  const rawRole = str(item['role'])
    ?? (isRecord(author) ? str(author['role']) : undefined)
    ?? str(item['sender'])
    ?? str(item['type']);
  if (rawRole === undefined) {
    irBump(ignored, 'trae:no-role');
    return undefined;
  }
  const lower = rawRole.toLowerCase();
  if (lower === 'user' || lower === 'human' || lower === 'user_message' || lower === 'ask') return 'user';
  // `agent` 是 Trae 自己的助手角色名（参考 convert/trae.mjs 的 normalizeRole）
  if (lower === 'assistant' || lower === 'ai' || lower === 'model' || lower === 'bot' || lower === 'say'
    || lower === 'agent') return 'assistant';
  irBump(ignored, 'trae:role-' + lower);
  return undefined;
}

interface RawSession {
  readonly id: string;
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly createdAt?: number | undefined;
  readonly records: readonly TranscriptRecord[];
  readonly raw: number;
  readonly ignored: Readonly<Record<string, number>>;
}

/** 计划字段的文本投影（参考 formatPlanValue：先取正文，取不到再 JSON 序列化对象） */
function planValueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = flattenText(value);
  if (text.trim() !== '') return text;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/** 单条计划项 → 文本（参考 planItemText：thought / tool / arguments / result 带标签） */
function planItemText(item: unknown): string {
  if (!isRecord(item)) return typeof item === 'string' ? item.trim() : '';
  const thought = planValueText(item['thought']);
  const toolName = str(item['toolName']) ?? str(item['tool']) ?? str(item['name']);
  const params = planValueText(item['params'] ?? item['arguments'] ?? item['input']);
  const result = planValueText(item['result'] ?? item['finish']);
  const content = planValueText(item['content'] ?? item['text']);
  const lines: string[] = [];
  if (thought !== '') lines.push('[thought] ' + thought);
  if (toolName !== undefined) lines.push('[tool] ' + toolName);
  if (params !== '') lines.push('[arguments] ' + params);
  if (result !== '') lines.push('[result] ' + result);
  if (thought === '' && toolName === undefined && params === '' && result === '' && content !== '') lines.push(content);
  return lines.join(String.fromCharCode(10)).trim();
}

/**
 * agentTaskContent.guideline.planItems（回退 content.guideline）→ 正文文本。
 * 参考 convert/trae.mjs 的 agentPlanText：Agent 模式的 Trae 把正文放在计划项里，
 * content/text 是空的 —— 不回退就会把整段助手回复读成「无内容」。
 */
function agentPlanText(item: Record<string, unknown>): string {
  for (const source of [item['agentTaskContent'], item['content']]) {
    if (!isRecord(source)) continue;
    const guideline = source['guideline'];
    const raw = isRecord(guideline) ? guideline['planItems'] : undefined;
    const items = valuesOf(raw);
    const text = items.map(planItemText).filter((t) => t !== '').join(String.fromCharCode(10, 10)).trim();
    if (text !== '') return text;
  }
  return '';
}

/** 正文：按候选键取**第一个有实质内容**的（空串/空对象继续往下试），最后回退计划项 */
function bodyBlocksOf(item: Record<string, unknown>, ignored: Record<string, number>): IrBlock[] {
  for (const key of MESSAGE_BODY_KEYS) {
    const raw = item[key];
    if (raw === undefined || raw === null) continue;
    const blocks = genericBlocksOf(raw, ignored, 'trae-block');
    if (blocks.some((b) => b.type !== 'text' || b.text.trim() !== '')) return blocks;
  }
  const plan = agentPlanText(item);
  return plan === '' ? [] : [irTextBlock(plan)];
}

function recordsOf(items: readonly unknown[], ignored: Record<string, number>): { records: TranscriptRecord[]; raw: number } {
  const records: TranscriptRecord[] = [];
  let raw = 0;
  for (const item of items) {
    raw += 1;
    if (!isRecord(item)) { irBump(ignored, 'trae:non-object-item'); continue; }
    const role = roleOfItem(item, ignored);
    if (role === undefined) continue;
    const blocks = bodyBlocksOf(item, ignored);
    if (blocks.length === 0) { irBump(ignored, 'trae:no-content'); continue; }
    const time = timeOf(item);
    const id = firstOf(item, ['id', 'messageId', 'message_id']);
    records.push({
      role,
      blocks,
      ...(time !== undefined ? { time } : {}),
      ...(id !== undefined ? { id } : {}),
    });
  }
  return { records, raw };
}

/** 键名 → 安全 id 片段（兜底铸 id 用；非白名单字符一律换成 '-'） */
function safeFragment(key: string): string {
  let out = '';
  for (const ch of key) out += /[A-Za-z0-9._-]/.test(ch) ? ch : '-';
  return out.length > 64 ? out.slice(0, 64) : out;
}

/**
 * 从一个 ItemTable 值里**结构自证**地抽出会话容器。
 *
 * 判据（全部满足才认）：① 是对象；② 有消息数组且至少一条带角色字段；③ 有字符串 id（否则铸稳定兜底 id）。
 * 不满足的节点只**继续下钻**（不计数 —— 存储值里绝大多数是 UI 状态）；满足的节点不再下钻（避免重复计数）。
 */
export function traeSessionsOfValue(
  value: unknown,
  storageKey: string,
  platform: ForeignPlatform,
  findings?: ForeignSkip[],
  maxNodes: number = MAX_NODES,
): RawSession[] {
  const out: RawSession[] = [];
  const seenIds = new Set<string>();
  let nodes = 0;
  let truncatedNodes = false;
  const visit = (node: unknown, depth: number, fallbackId: string): void => {
    // 节点触顶绝不静默（audit-foreign F4 的 trae 面）：置标志后由外层推一条 source-unreadable。
    if (nodes > maxNodes) { truncatedNodes = true; return; }
    if (depth > MAX_DEPTH || !isRecord(node)) return;
    nodes += 1;
    const messages = messageArrayOf(node);
    if (messages !== undefined) {
      const ignored: Record<string, number> = {};
      const rawId = firstOf(node, ID_KEYS);
      const id = rawId !== undefined && isSafeIrId(rawId) ? rawId : fallbackId;
      const parsed = recordsOf(messages, ignored);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        out.push({
          id,
          cwd: cwdOf(node, platform),
          title: firstOf(node, TITLE_KEYS)?.slice(0, 200) ?? '',
          createdAt: timeOf(node),
          records: parsed.records,
          raw: parsed.raw,
          ignored,
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        let index = 0;
        for (const item of child) {
          if (isRecord(item)) visit(item, depth + 1, safeFragment(storageKey) + '-' + String(index));
          index += 1;
        }
        continue;
      }
      if (isRecord(child)) visit(child, depth + 1, safeFragment(storageKey) + '-' + safeFragment(key));
    }
  };
  visit(value, 0, safeFragment(storageKey));
  if (truncatedNodes && findings !== undefined) {
    findings.push({ code: 'source-unreadable', origin: storageKey, detail: 'max-nodes-reached', count: maxNodes });
  }
  return out;
}

/** 一个 User 根下的 state.vscdb 位置（globalStorage 一个 + workspaceStorage/<hash> 各一个） */
export async function traeVscdbPaths(userDir: string, platform: ForeignPlatform): Promise<string[]> {
  const out: string[] = [];
  for (const sub of TRAE_STORAGE_SUBDIRS) {
    const base = joinFor(platform, userDir, sub);
    const st = await statOrNull(base);
    if (st === null || !st.isDirectory()) continue;
    if (sub === 'globalStorage') {
      const db = joinFor(platform, base, TRAE_VSCDB_NAME);
      if (await isFile(db)) out.push(db);
      continue;
    }
    for (const hashDir of await listDirNames(base)) {
      const db = joinFor(platform, base, hashDir, TRAE_VSCDB_NAME);
      if (await isFile(db)) out.push(db);
    }
  }
  return out;
}

/**
 * 读 Trae 会话。
 *
 * SQLite 能力缺失时**不再尝试**（如实报 source-unreadable 的 detail=sqlite-module-unavailable），
 * 而不是静默返回空 —— 那会与「未安装 Trae」混淆（t5 明文要求两者可区分）。
 */
export async function readTrae(
  opts: RootProbeOptions & { readonly maxFiles?: number; readonly maxEncryptedDbBytes?: number },
): Promise<SessionReadOutcome<TraeSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const findings: ForeignSkip[] = [];
  const files: TraeSessionFile[] = [];
  const seen = new Set<string>();
  const maxFiles = opts.maxFiles ?? MAX_SESSIONS;

  const capability = await sqliteCapability();
  if (!capability.available) {
    return {
      files: [],
      readFindings: [{ code: 'source-unreadable', origin: 'trae', detail: 'sqlite-' + String(capability.reason) }],
      extraCounts: { 'trae.vscdb': 0 },
    };
  }

  const extraSkips: ForeignSkip[] = [];
  let truncated = false;

  // ① 加密库通道（2.3.x）：先读 —— 迁移后的库才是权威，同 id 冲突以它为准
  const encryptedDbs: string[] = [];
  for (const userDir of traeUserDataDirs(opts)) {
    const dbPath = traeDbPathFor(userDir, platform);
    if (await isFile(dbPath)) encryptedDbs.push(dbPath);
  }
  let encryptedSessions = 0;
  for (const dbPath of encryptedDbs) {
    const outcome = await readTraeEncryptedDatabase(dbPath, {
      env: opts.env,
      platform,
      ...(opts.maxEncryptedDbBytes !== undefined ? { maxBytes: opts.maxEncryptedDbBytes } : {}),
      maxSessions: maxFiles,
    });
    // 密钥错/超限/截断/表结构不符 ⇒ 稳定码（绝不静默 0 会话）；旧库有货时继续走旧库
    if (outcome.problem !== undefined) {
      extraSkips.push(traeDbSkipOf(outcome.problem));
      continue;
    }
    if (outcome.dropped !== undefined && outcome.dropped > 0) {
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'encrypted-row-json-error', count: outcome.dropped });
    }
    if (outcome.skipped !== undefined && outcome.skipped > 0) {
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'encrypted-session-without-id', count: outcome.skipped });
    }
    if (outcome.truncated === true) truncated = true;
    for (const session of outcome.sessions) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const id = isSafeIrId(session.id) ? session.id : safeFragment('trae-db-' + session.id);
      if (seen.has(id)) continue;
      const ignored: Record<string, number> = {};
      const parsed = recordsOf(session.items, ignored);
      seen.add(id);
      files.push({
        id,
        cwd: session.cwd,
        createdAt: session.createdAt,
        title: session.title ?? '',
        records: parsed.records,
        raw: parsed.raw,
        bad: 0,
        ignored,
      });
      encryptedSessions += 1;
    }
  }

  // ② 旧 state.vscdb 通道（保留）：同 id 已被加密库计入的不再重复
  const dbs: string[] = [];
  for (const userDir of traeUserDataDirs(opts)) {
    dbs.push(...await traeVscdbPaths(userDir, platform));
  }
  let candidateKeys = 0;
  for (const dbPath of dbs) {
    if (files.length >= maxFiles) { truncated = true; break; }
    const db = await openSqliteIfShape(dbPath, { ItemTable: ['key'] });
    if (db === null) {
      // 打开失败与「库形状不对」都必须可见（detail 用于区分；绝不静默当成空）
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'itemtable-open-or-shape-failed' });
      continue;
    }
    const rows = db.all('SELECT key, value FROM ItemTable');
    if (rows === null) {
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'itemtable-read-failed' });
      db.close();
      continue;
    }
    for (const row of rows) {
      const key = cellText(row, 'key');
      if (key === undefined || !isTraeChatStorageKey(key)) continue;
      candidateKeys += 1;
      const bytes = cellBytes(row, 'value');
      if (bytes === undefined) {
        findings.push({ code: 'source-unreadable', origin: key, detail: 'item-value-not-bytes' });
        continue;
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        findings.push({ code: 'source-unreadable', origin: key, detail: 'item-json-error' });
        continue;
      }
      for (const raw of traeSessionsOfValue(parsedValue, key, platform, findings)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        files.push({
          id: raw.id,
          cwd: raw.cwd,
          createdAt: raw.createdAt,
          title: raw.title,
          records: raw.records,
          raw: raw.raw,
          bad: 0,
          ignored: raw.ignored,
        });
      }
    }
    db.close();
    if (truncated) break;
  }
  // 加密库存在时，「旧库没有候选键」不是用户需要的解释（真因已由 trae-db-* 说明）
  if (files.length === 0 && candidateKeys === 0 && dbs.length > 0 && encryptedDbs.length === 0) {
    extraSkips.push({ code: 'sessions-not-migrated', origin: 'trae', detail: 'chat-storage-key-not-found' });
  } else if (files.length === 0 && candidateKeys > 0) {
    extraSkips.push({ code: 'sessions-not-migrated', origin: 'trae', detail: 'no-session-container', count: candidateKeys });
  }
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'max-sessions-reached', count: maxFiles });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    files,
    readFindings: findings,
    extraSkips,
    extraCounts: {
      'trae.vscdb': dbs.length,
      'trae.chatStorageKeys': candidateKeys,
      'trae.encryptedDb': encryptedDbs.length,
      'trae.encryptedSessions': encryptedSessions,
    },
  };
}

/**
 * detect 期的**轻量预告**（issue #134 的第二半）：让 `/foreign-sources` 在用户点导入前就把
 * 「为什么这里没有会话」摆出来，而不是等 build 的 400 才闪一下。
 *
 * 代价（刻意接受）：只读**页头**与 **ItemTable 的 key 列**，绝不读正文、绝不枚举会话 ——
 * 4 个发行版的加密库最多各解密 1 页，旧库只是 `SELECT key`。因此 detect 仍是有界的只读探测。
 */
export async function traeDetectSkips(
  opts: RootProbeOptions & { readonly maxEncryptedDbBytes?: number },
): Promise<ForeignSkip[]> {
  const platform = normalizePlatform(opts.platform);
  const skips: ForeignSkip[] = [];
  let encryptedFound = 0;
  for (const userDir of traeUserDataDirs(opts)) {
    const dbPath = traeDbPathFor(userDir, platform);
    if (!await isFile(dbPath)) continue;
    encryptedFound += 1;
    const problem = await probeTraeEncryptedDatabase(dbPath, {
      env: opts.env,
      ...(opts.maxEncryptedDbBytes !== undefined ? { maxBytes: opts.maxEncryptedDbBytes } : {}),
    });
    if (problem !== null) skips.push(traeDbSkipOf(problem));
  }
  // 加密库在场时不再猜旧库：迁移后旧库多半只是残留，混进「没有候选键」会误导用户
  if (encryptedFound > 0) return skips;

  const capability = await sqliteCapability();
  if (!capability.available) return skips;
  const dbs: string[] = [];
  for (const userDir of traeUserDataDirs(opts)) {
    dbs.push(...await traeVscdbPaths(userDir, platform));
  }
  if (dbs.length === 0) return skips;
  let candidateKeys = 0;
  for (const dbPath of dbs) {
    const db = await openSqliteIfShape(dbPath, { ItemTable: ['key'] });
    if (db === null) continue;
    const rows = db.all('SELECT key FROM ItemTable');
    db.close();
    if (rows === null) continue;
    for (const row of rows) {
      const key = cellText(row, 'key');
      if (key !== undefined && isTraeChatStorageKey(key)) candidateKeys += 1;
    }
  }
  if (candidateKeys === 0) {
    skips.push({ code: 'sessions-not-migrated', origin: 'trae', detail: 'chat-storage-key-not-found' });
  }
  return skips;
}
