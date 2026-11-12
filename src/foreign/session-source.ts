/**
 * 会话类来源的**共享装配层**（档 B 24 个来源共用；纯函数，零 I/O）。
 *
 * 三段式的第三段与第二段在这里收口（第一段「源格式 → 归一记录」在各来源自己的 `<id>.ts` 里）：
 *
 *   源原文 --(各来源 parse)--> TranscriptRecord[] --(本模块)--> IR --(synthesizeDshRows)--> DSH 行
 *          --(encodeDshSessionLog)--> 字节 --(kernel.collectSessionSections)--> sessions+workspaces 分区
 *
 * 为什么必须收口：这四步里有三处**宿主硬不变量**（DSH codec 强校验 seq / surfaceOp / 工具闭合）与
 * 一处**契约硬约束**（同一 DSH 会话 id 只允许出现一次、必须连 workspaces 一起产出）。
 * 24 个来源各写一遍 = 24 个地方可能写错，且错法是「导入全绿但对话不出现」。
 *
 * 与 `claude-sessions.ts` 的关系：**字节出口只有一份实现**（本模块复用它的 `encodeDshSessionLog`
 * 与 `dshSessionLogName`），Claude 自己的解析路径**一字未改**（逐字节回归仍然钉住它）。
 */
import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName, encodeDshSessionLog, SUPPORTED_DSH_SESSION_FORMAT_VERSIONS } from './claude-sessions.ts';
import { collectSessionSections } from './kernel.ts';
import { foreignSourceLabelKey } from './source-modules.ts';
import { probeConfiguredPaths } from './session-read.ts';
import { envValue } from './platform-paths.ts';
import type { ForeignSource } from './registry.ts';
import {
  irBump,
  irEarlier,
  irFallbackMessageId,
  irMessage,
  irSafeTime,
  irTextBlock,
  irTextOfBlocks,
  irToolCallBlock,
  irToolResultBlock,
  isSafeIrId,
  synthesizeDshRows,
} from './session-ir.ts';
import type {
  DshSessionHeader,
  IrBlock,
  IrMessage,
  IrTimeMs,
  SynthesisStats,
} from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignEvidenceKind, ForeignImportResult, ForeignLimitOverrides, ForeignSectionOut, ForeignSkip, ForeignSkipCode, ForeignSourceId } from './types.ts';

/* ---------------- ① 归一记录（各来源只负责产出这个） ---------------- */

/**
 * 一条**已归一**的源记录。
 *
 * 刻意不含任何「DSH 行式」知识（turn/step/seq 全在合成器里）—— 各来源只需要回答
 * 「这条是用户还是助手、有哪些内容块、什么时间、哪个 id、哪个模型」。
 */
export interface TranscriptRecord {
  readonly role: 'user' | 'assistant';
  readonly blocks: readonly IrBlock[];
  readonly time?: IrTimeMs | undefined;
  readonly id?: string | undefined;
  readonly model?: string | undefined;
  readonly usage?: unknown;
}

/** 一次解析的结果（记账字段与竞品 `parseJsonlLines` 的 {recs,skipped,skippedLines} 同形） */
export interface ParsedTranscript {
  readonly records: readonly TranscriptRecord[];
  /** cwd（源里最权威的那个；缺失 = 调用方转成 session-missing-cwd，绝不猜） */
  readonly cwd?: string | undefined;
  readonly createdAt?: IrTimeMs | undefined;
  /** 源给的标题（空串 = 没有） */
  readonly title: string;
  /** 源记录的原始条数（含被忽略的） */
  readonly raw: number;
  /** 解析不出来的条数/坏行数 */
  readonly bad: number;
  /** 未迁移的记录类型 → 条数（**逐类计数，绝不静默**） */
  readonly ignored: Record<string, number>;
}

/** 一条待转码的会话草稿（IR 之上的「源侧元数据」） */
export interface SessionDraft {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly createdAt: IrTimeMs | undefined;
  readonly title: string;
  readonly messages: readonly IrMessage[];
  /** 源侧记录的原始条数（含被忽略的） */
  readonly records: number;
  readonly provider: string;
  /** 未迁移类型 → 条数（转成 unsupported-session-record 逐条报码） */
  readonly ignored?: Readonly<Record<string, number>> | undefined;
  /** 解析不出来的行数（进 ignored.unparsable） */
  readonly unparsable?: number | undefined;
  /** 「本轮内容块全空」的取值（Claude 取 []，其余来源同样取 []） */
  readonly emptyBlocks?: readonly IrBlock[] | undefined;
}

/** 归一记录 → SessionDraft（各来源统一走这一处，不自己拼 IrMessage） */
export function draftFromTranscript(
  id: string,
  parsed: ParsedTranscript,
  provider: string,
): SessionDraft {
  const messages: IrMessage[] = [];
  let index = 0;
  for (const rec of parsed.records) {
    const passthrough: Record<string, unknown> = {};
    if (rec.time !== undefined) passthrough['time'] = rec.time;
    if (rec.usage !== undefined) passthrough['usage'] = rec.usage;
    if (rec.role === 'assistant') passthrough['source'] = { model: rec.model ?? '' };
    const messageId = rec.id !== undefined && isSafeIrId(rec.id) ? rec.id : irFallbackMessageId(index);
    messages.push(irMessage(messageId, rec.role, rec.blocks, passthrough));
    index += 1;
  }
  return {
    id,
    cwd: parsed.cwd,
    createdAt: parsed.createdAt,
    title: parsed.title,
    messages,
    records: parsed.raw,
    provider,
    ignored: parsed.ignored,
    unparsable: parsed.bad,
  };
}

/* ---------------- ② 草稿 → 字节（唯一转码出口） ---------------- */

export interface DraftTranscodeOptions {
  /** 目标机 DSH 的 SESSION_FORMAT_VERSION（必填；不支持即 session-format-unsupported，绝不猜） */
  readonly formatVersion: number;
  /** 时间兜底（源里没有可解析时间时用） */
  readonly now?: number | undefined;
}

export interface DraftTranscodeResult {
  readonly session?: {
    readonly id: string;
    readonly cwd: string;
    readonly relativePath: string;
    readonly data: Uint8Array;
    readonly info: { readonly ignored: Record<string, number> };
  };
  readonly skip?: { readonly code: ForeignSkipCode; readonly detail?: string };
}

/**
 * 骨架的三段判定 + 合成 + 编码（**所有会话类来源的唯一出口**）。
 *
 * 判定顺序与 `transcodeClaudeSession` 逐条对齐（版本 → id → 空 → 缺 cwd → 解析不出 → 合成空）：
 * 顺序变了，用户看到的 skip 码就会变（同一个坏文件从 session-missing-cwd 变成 session-empty）。
 */
export function transcodeSessionDraft(draft: SessionDraft, options: DraftTranscodeOptions): DraftTranscodeResult {
  if (!SUPPORTED_DSH_SESSION_FORMAT_VERSIONS.includes(options.formatVersion)) {
    return { skip: { code: 'session-format-unsupported', detail: String(options.formatVersion) } };
  }
  if (!isSafeIrId(draft.id)) return { skip: { code: 'session-unsafe-id', detail: draft.id } };
  if (draft.records === 0) return { skip: { code: 'session-empty' } };
  if (draft.cwd === undefined || draft.cwd === '') return { skip: { code: 'session-missing-cwd', detail: draft.id } };
  if (draft.messages.length === 0 && (draft.unparsable ?? 0) > 0) {
    return { skip: { code: 'session-unparsable', detail: draft.id } };
  }

  const now = options.now ?? Date.now();
  const stats: SynthesisStats = { ignored: {}, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 };
  if ((draft.unparsable ?? 0) > 0) irBump(stats.ignored, 'unparsable', draft.unparsable ?? 0);
  for (const [kind, count] of Object.entries(draft.ignored ?? {})) {
    if (count > 0) irBump(stats.ignored, kind, count);
  }

  const createdAt = draft.createdAt ?? now;
  const rows = synthesizeDshRows(
    { id: draft.id, cwd: draft.cwd, createdAt, records: draft.records, messages: draft.messages },
    {
      title: draft.title,
      titleSource: { kind: 'fallback' },
      emptyBlocks: draft.emptyBlocks ?? [],
      provider: draft.provider,
      reasoningEffort: 'medium',
      maxTokens: 8192,
    },
    stats,
    now,
  );
  if (rows.length === 0) return { skip: { code: 'session-empty' } };

  const header: DshSessionHeader = {
    type: 'session',
    version: options.formatVersion,
    id: draft.id,
    createdAt,
    cwd: draft.cwd,
    isSeeded: false,
    delegationDepth: 0,
  };
  return {
    session: {
      id: draft.id,
      cwd: draft.cwd,
      relativePath: projectKeyOf(draft.cwd) + '/' + draft.id + '/' + dshSessionLogName(options.formatVersion),
      data: encodeDshSessionLog(header, rows),
      info: { ignored: stats.ignored },
    },
  };
}

/* ---------------- ③ 装配：草稿 → ForeignImportResult ---------------- */

export interface SessionSourceOptions<TFile> {
  /** 待转码的会话（已读盘 / 已解析成草稿的输入形态） */
  readonly files: readonly TFile[];
  /** 目标机格式版本（缺省 = 一条都不转，整批报 session-format-version-unknown） */
  readonly targetFormatVersion: number | undefined;
  /** workspaces 记录 id 的前缀（契约 §8.3：<sourceId>:<projectKey>） */
  readonly workspaceIdPrefix: string;
  /** 单个文件 → 草稿（或一个 skip 码） */
  readonly draftOf: (file: TFile) => SessionDraft | { readonly skip: { readonly code: ForeignSkipCode; readonly detail?: string } };
  /** 读盘层的发现（原样带出，调用方无需二次合并） */
  readonly readFindings?: readonly ForeignSkip[] | undefined;
  /** 额外的计数（如「发现 N 个会话目录」） */
  readonly extraCounts?: Readonly<Record<string, number>> | undefined;
  /** 额外的未迁移项（如「旧版 JSONL 刻意不读」） */
  readonly extraSkips?: readonly ForeignSkip[] | undefined;
}

/**
 * 会话类来源的**统一出口**：草稿 → sessions + workspaces 分区 → ForeignImportResult。
 *
 * 走 `kernel.collectSessionSections`（与 Claude 同一份实现）而不是自己拼，理由有三：
 *  ① 冲突语义（同 DSH 会话 id 只允许出现一次）只有一处实现；
 *  ② workspaces 必须与会话同源产出（只给会话不给工作区 = 目标机上一条对话都看不见）；
 *  ③ 「未迁移记录逐类计数」只有一处实现。
 */
export function buildSessionSourceResult<TFile extends { id: string }>(
  source: ForeignSourceId,
  opts: SessionSourceOptions<TFile>,
): ForeignImportResult {
  const sections: ForeignSectionOut[] = [];
  const skipped: ForeignSkip[] = [...(opts.readFindings ?? []), ...(opts.extraSkips ?? [])];
  const counts: Record<string, number> = { ...(opts.extraCounts ?? {}) };
  const formatVersion = opts.targetFormatVersion ?? -1;
  collectSessionSections<TFile>({
    files: opts.files,
    targetFormatVersion: opts.targetFormatVersion,
    transcode: (file) => {
      const draft = opts.draftOf(file);
      if ('skip' in draft) return { skip: draft.skip };
      return transcodeSessionDraft(draft, { formatVersion });
    },
    workspaceIdPrefix: opts.workspaceIdPrefix,
    sections,
    skipped,
    counts,
  });
  return { source, sections, skipped, credentialRefs: [], counts };
}

/* ---------------- ④ 通用内容块 / 记录映射（各来源共用的兜底口径） ---------------- */

/** 文本投影：字符串原样；数组逐项拼；对象取 text/content/message；其余 → ''（绝不 JSON.stringify 进正文） */
export function flattenText(value: unknown, unknown?: Record<string, number>, key = 'block'): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(flattenText(item, unknown, key));
    return parts.join(String.fromCharCode(10));
  }
  if (isRecord(value)) {
    for (const candidate of ['text', 'content', 'message']) {
      if (value[candidate] !== undefined) return flattenText(value[candidate], unknown, key);
    }
    if (unknown !== undefined) irBump(unknown, key + ':unmapped');
    return '';
  }
  return '';
}

const TOOL_CALL_TYPES = ['tool_use', 'tool_call', 'function_call', 'tool-call', 'tool-invocation'];
const TOOL_RESULT_TYPES = ['tool_result', 'tool_response', 'function_call_output', 'tool-result'];
const TEXT_TYPES = ['text', 'input_text', 'output_text', 'message'];

function firstString(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** 工具入参：字符串若是 JSON 就解析（源侧两种形态并存），否则原样字符串 */
function toolInputOf(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

/**
 * 通用内容块映射（绝大多数来源的 `content` / `parts` 都能被它覆盖）。
 *
 * 覆盖四种形态：字符串、块数组（text / tool_use / tool_result）、单块对象、
 * 以及把整段对话描述成 `{type:'text',text}` 的形态。**不认识的块逐类计数**（绝不静默丢）。
 */
export function genericBlocksOf(content: unknown, unknown?: Record<string, number>, key = 'block'): IrBlock[] {
  if (typeof content === 'string') return [irTextBlock(content)];
  if (Array.isArray(content)) {
    const out: IrBlock[] = [];
    for (const item of content) out.push(...genericBlocksOf(item, unknown, key));
    return out;
  }
  if (!isRecord(content)) return [];
  const type = typeof content['type'] === 'string' ? (content['type'] as string) : '';
  const lower = type.toLowerCase();
  if (TOOL_CALL_TYPES.includes(lower)) {
    const name = firstString(content, ['name', 'tool', 'toolName', 'tool_name']) ?? '';
    const id = firstString(content, ['id', 'tool_call_id', 'callId', 'call_id']) ?? '';
    const input = content['input'] ?? content['arguments'] ?? content['args'] ?? content['parameters'];
    return [irToolCallBlock(id, name, toolInputOf(input))];
  }
  if (TOOL_RESULT_TYPES.includes(lower)) {
    const id = firstString(content, ['tool_use_id', 'tool_call_id', 'call_id', 'id']) ?? '';
    const body = content['content'] ?? content['output'] ?? content['result'] ?? content['text'];
    const text = flattenText(body, unknown, key);
    const isError = content['is_error'] === true || content['isError'] === true || content['error'] === true;
    return [irToolResultBlock(id, text, isError)];
  }
  if (lower === '' || TEXT_TYPES.includes(lower)) {
    const text = content['text'] !== undefined ? content['text'] : content['content'];
    if (typeof text === 'string') return [irTextBlock(text)];
    if (Array.isArray(text)) return genericBlocksOf(text, unknown, key);
    if (typeof content['content'] === 'string') return [irTextBlock(content['content'] as string)];
  }
  if (unknown !== undefined) irBump(unknown, key + ':' + (lower === '' ? 'unmapped' : lower));
  return [];
}

/** 通用 JSONL 形态的字段真值（各来源可覆盖其中任意几项） */
export interface TranscriptShape {
  /** 角色字段候选（按序取第一个非空字符串） */
  readonly roleKeys: readonly string[];
  /** 内容字段候选；命中的值可以是字符串 / 数组 / 对象 */
  readonly contentKeys: readonly string[];
  /** 记录类型字段（用于「未迁移类型」计数） */
  readonly typeKey: string;
  /** 角色取值（大小写不敏感）→ user */
  readonly userValues: readonly string[];
  /** 角色取值 → assistant */
  readonly assistantValues: readonly string[];
  readonly timeKeys: readonly string[];
  readonly idKeys: readonly string[];
  readonly cwdKeys: readonly string[];
  readonly titleKeys: readonly string[];
  readonly modelKeys: readonly string[];
  /** 额外的「整条记录就是一段文本」字段（如 {type:'summary',summary:'…'} 不当消息） */
  readonly textKeys: readonly string[];
}

/** 主形态（Claude / Codex / 多数 JSONL 工具的共同结构：{type|role, message|content,…}） */
export const GENERIC_TRANSCRIPT_SHAPE: TranscriptShape = {
  roleKeys: ['role', 'type', 'kind', 'sender'],
  contentKeys: ['message', 'content', 'parts', 'text', 'data'],
  typeKey: 'type',
  userValues: ['user', 'human', 'user_message', 'user-message', 'prompt'],
  assistantValues: ['assistant', 'ai', 'model', 'gemini', 'assistant_message', 'assistant-message', 'completion'],
  timeKeys: ['timestamp', 'time', 'createdAt', 'created_at', 'ts', 'date'],
  idKeys: ['id', 'uuid', 'messageId', 'message_id'],
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory'],
  titleKeys: ['title', 'summary', 'name'],
  modelKeys: ['model', 'modelId', 'model_id'],
  textKeys: [],
};

/** 取第一条可用的内容字段值（message 是对象时下钻一层到它的 content） */
function contentOf(rec: Record<string, unknown>, shape: TranscriptShape): unknown {
  for (const key of shape.contentKeys) {
    const raw = rec[key];
    if (raw === undefined || raw === null) continue;
    if (isRecord(raw)) {
      for (const inner of ['content', 'text', 'parts', 'blocks']) {
        if (raw[inner] !== undefined) return raw[inner];
      }
      return raw;
    }
    return raw;
  }
  return undefined;
}

/** 在**一个**记录里按 roleKeys 找角色（找不到返回 undefined） */
function roleIn(rec: Record<string, unknown>, shape: TranscriptShape): string | undefined {
  for (const key of shape.roleKeys) {
    const raw = rec[key];
    if (typeof raw !== 'string' || raw === '') continue;
    const lower = raw.toLowerCase();
    if (shape.userValues.includes(lower)) return 'user';
    if (shape.assistantValues.includes(lower)) return 'assistant';
    return 'unsupported:' + lower;
  }
  return undefined;
}

/**
 * 角色归一：命中 userValues → user，命中 assistantValues → assistant，其余 undefined（调用方计数）。
 *
 * **一层包装的回退**（2026-10-06）：事件流形态的源把角色放在 `{type:'message', message:{role,…}}` 的
 * 内层对象里（Pi / OpenClaw 等）。顶层**完全取不到**角色时才下钻一层 —— 顶层能取到就照旧，
 * 既有 24 个来源的判定因此逐字不变（回归由各自单测钉住）。
 */
function roleOf(rec: Record<string, unknown>, shape: TranscriptShape): string | undefined {
  const direct = roleIn(rec, shape);
  if (direct !== undefined) return direct;
  const inner = rec['message'];
  if (isRecord(inner)) return roleIn(inner, shape);
  return undefined;
}

/**
 * 通用 JSONL 解析：**一行一条 JSON 对象**，按 shape 映射成归一记录。
 *
 * 三条纪律（与竞品 `parseJsonlLines` 的记账口径同源，但**明细不设 200 上限**）：
 *  ① 坏行不抛，只计入 `bad`；② 未迁移记录类型逐类计入 `ignored`；③ cwd 取**第一个**有值的记录。
 */
export function parseGenericJsonl(text: string, shape: TranscriptShape = GENERIC_TRANSCRIPT_SHAPE): ParsedTranscript {
  const records: TranscriptRecord[] = [];
  const ignored: Record<string, number> = {};
  let raw = 0;
  let bad = 0;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let title = '';
  for (const line of text.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      bad += 1;
      continue;
    }
    raw += 1;
    if (cwd === undefined) cwd = firstString(parsed, shape.cwdKeys);
    const typeValue = parsed[shape.typeKey];
    const typeName = typeof typeValue === 'string' && typeValue !== '' ? typeValue : 'unknown';
    if (title === '') {
      const candidate = firstString(parsed, shape.titleKeys);
      if (candidate !== undefined && shape.titleKeys.indexOf(shape.typeKey) < 0) title = candidate;
    }
    const time = firstTime(parsed, shape.timeKeys);
    createdAt = irEarlier(createdAt, time);
    const role = roleOf(parsed, shape);
    if (role === undefined || role.startsWith('unsupported:')) {
      irBump(ignored, role === undefined ? typeName : role.slice('unsupported:'.length));
      continue;
    }
    if (shape.textKeys.length > 0) {
      let handled = false;
      for (const key of shape.textKeys) {
        const v = parsed[key];
        if (typeof v === 'string' && v !== '') {
          records.push({ role: role as 'user' | 'assistant', blocks: [irTextBlock(v)], time });
          handled = true;
          break;
        }
      }
      if (handled) continue;
    }
    const blocks = genericBlocksOf(contentOf(parsed, shape), ignored);
    if (blocks.length === 0) {
      irBump(ignored, typeName + ':no-content');
      continue;
    }
    records.push({
      role: role as 'user' | 'assistant',
      blocks,
      time,
      id: firstString(parsed, shape.idKeys),
      model: firstString(parsed, shape.modelKeys),
      usage: isRecord(parsed['usage']) ? parsed['usage'] : undefined,
    });
  }
  if (title === '') title = firstUserText(records);
  return { records, cwd, createdAt, title, raw, bad, ignored };
}

function firstTime(rec: Record<string, unknown>, keys: readonly string[]): IrTimeMs | undefined {
  for (const key of keys) {
    const t = irSafeTime(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** 首条用户文本前 80 字（折叠空白）——标题兜底口径与 Claude 一致 */
export function firstUserText(records: readonly TranscriptRecord[]): string {
  for (const rec of records) {
    if (rec.role !== 'user') continue;
    const text = irTextOfBlocks(rec.blocks);
    if (text.trim() !== '') return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return '';
}

/** 取源给的会话标题字段（空串表示没有） */
export function titleFromRecord(rec: unknown, keys: readonly string[]): string {
  if (!isRecord(rec)) return '';
  const v = firstString(rec, keys);
  return v === undefined ? '' : v.slice(0, 200);
}

/** 归一记录的 id 兜底（源没给合法 id 时用会话内序号铸稳定伪 uuid） */
export function recordIdOf(raw: string | undefined, index: number): string {
  return raw !== undefined && isSafeIrId(raw) ? raw : irFallbackMessageId(index);
}

/* ---------------- ⑤ 来源装配（detect/build/probePaths 只写一遍） ---------------- */

/** 探测上下文（纯函数：homeDir / env / platform，**不读盘**） */
export interface RootProbeOptions {
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  /** 显式项目目录（crush 的每项目一库 / chatgpt 的显式导出文件都靠它，缺省不猜） */
  readonly projectDir?: string | undefined;
  /**
   * 可选上限覆盖（t36）：宿主路由 / CLI 将来放开上限时的通道。
   * 缺省 = 各读器自己的选项与默认值**逐字不变**；读器用 resolveLimit(覆盖, 显式, 默认) 取值。
   */
  readonly limits?: ForeignLimitOverrides | undefined;
}

/** 读盘上下文（read-*.ts 的唯一入口形状） */
export interface SessionSourceHostOptions extends RootProbeOptions {
  readonly targetFormatVersion?: number | undefined;
}

/** 一次读盘的结果（**不含**任何分区装配语义 —— 那是 buildSessionSourceResult 的事） */
export interface SessionReadOutcome<TFile extends { id: string }> {
  readonly files: readonly TFile[];
  /** 读盘层的发现（0 字节 / 超限 / 只读打开失败 …） */
  readonly readFindings?: readonly ForeignSkip[] | undefined;
  /** 结构性提示（如「旧式 JSONL 刻意不读」「本版不迁移」） */
  readonly extraSkips?: readonly ForeignSkip[] | undefined;
  readonly extraCounts?: Readonly<Record<string, number>> | undefined;
}

/** 会话类来源的装配输入 */
export interface SessionSourceWiring<TFile extends { id: string }> {
  readonly id: ForeignSourceId;
  readonly evidence: ForeignEvidenceKind;
  /** 目标平台下的**静态探测位置**（真值表；运行时再在它下面动态枚举） */
  readonly probePaths: (opts: RootProbeOptions) => readonly string[];
  /** 命中即报 source-location-overridden 的环境变量（只报键名，绝不报值） */
  readonly probeEnvKeys?: readonly string[] | undefined;
  /**
   * 探测期的附加提示（如 chatgpt 的「无自动根」）。
   *
   * 允许返回 Promise：少数来源需要**有界**地读一点内容才能给出可判定的预告（trae 的加密库
   * 只解密第 1 页、旧库只读 key 列）。这类探测必须自证「有界、只读、不枚举会话」，
   * 否则 detect 会被 30 个来源拖慢。
   */
  readonly probeSkips?:
    | ((opts: RootProbeOptions, probed: readonly string[]) => readonly ForeignSkip[] | Promise<readonly ForeignSkip[]>)
    | undefined;
  readonly read: (opts: SessionSourceHostOptions) => Promise<SessionReadOutcome<TFile>>;
  readonly draftOf: (file: TFile) => SessionDraft | { readonly skip: { readonly code: ForeignSkipCode; readonly detail?: string } };
  readonly workspaceIdPrefix?: string | undefined;
}

/**
 * 把一个会话来源装配成 `ForeignSource`。
 *
 * **detect 默认只 stat 真值表里的位置**（绝不读内容、绝不枚举会话）—— 界面对 30 个来源各调一次
 * detect，任何一处读全文都会把面板拖慢；真正的枚举发生在 build。唯一例外是来源在 `probeSkips`
 * 里显式声明的**有界轻量探测**（trae：加密库只解密第 1 页、旧库只读 key 列），因为它们要回答的
 * 正是「为什么这里没有会话」，而这件事只有看内容才知道。
 *
 * platform 的兜底只在**这一处**：`ctx.platform ?? process.platform`（装配层碰运行平台是允许的，
 * 真值表函数本身一律显式收参）。
 */
export function sessionSourceOf<TFile extends { id: string }>(
  wiring: SessionSourceWiring<TFile>,
): ForeignSource {
  return {
    id: wiring.id,
    labelKey: foreignSourceLabelKey(wiring.id),
    evidence: wiring.evidence,
    probePaths: wiring.probePaths,
    async detect(ctx) {
      const opts: RootProbeOptions = {
        homeDir: ctx.homeDir,
        env: ctx.env,
        platform: ctx.platform ?? process.platform,
        ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
      };
      const probed = await probeConfiguredPaths(wiring.probePaths(opts), ctx.homeDir);
      const skipped: ForeignSkip[] = [...probed.skipped];
      for (const key of wiring.probeEnvKeys ?? []) {
        if (envValue(ctx.env, key) !== undefined) skipped.push({ code: 'source-location-overridden', origin: key });
      }
      skipped.push(...((await wiring.probeSkips?.(opts, probed.paths)) ?? []));
      return { found: probed.paths.length > 0, paths: [...probed.paths], skipped };
    },
    async build(ctx) {
      const read = await wiring.read({
        homeDir: ctx.homeDir,
        env: ctx.env,
        platform: ctx.platform ?? process.platform,
        ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
        targetFormatVersion: ctx.targetSessionFormatVersion,
        // t36：上下文里的可选上限**原样**透传（不再固定只传 5 个字段）；不给就一个键都不加
        ...(ctx.limits !== undefined ? { limits: ctx.limits } : {}),
      });
      return buildSessionSourceResult<TFile>(wiring.id, {
        files: read.files,
        targetFormatVersion: ctx.targetSessionFormatVersion,
        workspaceIdPrefix: wiring.workspaceIdPrefix ?? wiring.id,
        draftOf: wiring.draftOf,
        readFindings: read.readFindings,
        extraSkips: read.extraSkips,
        extraCounts: read.extraCounts,
      });
    },
  };
}
