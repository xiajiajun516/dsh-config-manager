/**
 * Claude Code 会话（~/.claude/projects/<项目>/<uuid>.jsonl）→ **DSH 会话日志**的转码器（纯函数）。
 *
 * 为什么是转码而不是搬运（两边落盘形态完全不同）：
 *  - Claude Code：纯 JSONL 明文，一行一条记录（type = user / assistant / attachment / queue-operation / system），
 *    cwd 只写在记录字段里；
 *  - DSH：sessions/<projectKey(cwd)>/<id>/session[.vN].jsonl.zstd，是**带校验和的 zstd 帧的拼接**
 *    （首帧 = header 单行 JSON，之后每个 append 批次一帧）；DSH 启动时校验
 *    「日志位置 == projectKey(header.cwd)/id」，不一致直接报 corrupt session log。
 *
 * 三条硬约束：
 *  ① **格式版本必须来自目标机**：DSH 对非本 build 的 header.version 直接拒绝，且列表里**静默跳过**
 *     （用户看到的是「对话消失」，见本仓 G-23）。本模块不猜版本：调用方必须传入
 *     （宿主用 utils/session-format.ts 的 resolveSessionFormatVersion 解析）；本模块只实现 3。
 *  ② **行的形态按 DSH 自己的 codec 对齐，不按本模块的想象**：surfaceOp 标记（user/message、
 *     assistant/message、tool/result 必需）、可选空字段必须省略（request/header 的 tools: [] 会被拒）、
 *     header 的 isSeeded / delegationDepth 必填。这套最小事件集由真实 codec 的
 *     encode → assertV3RowAdmission → createDecoder 三条路径验证过
 *     （复核脚本：outputs/foreign-import-v1/try-dsh-events.mjs）。
 *  ③ **不认识的记录一律计数上报**，绝不静默吞掉。
 *
 * 三段式分层（t4，档 B 前置）：
 *  ① **解析**（本文件）：Claude 记录 → IR（`./session-ir.ts`）；
 *  ② **合成**（`./session-ir.ts` 的 `synthesizeDshRows`）：IR → DSH 行（**所有会话类来源共用**）；
 *  ③ **编码**（本文件）：行 → 字节（zstd 帧拼接 + 校验和）。
 *  本文件**刻意不出现在 file-budget 的 import 白名单里**：它 import 了 `node:fs` 的**类型**用于
 *  构造只读句柄的回调（`ClaudeReadHandle`，追加能力通道），这是**零运行期 I/O** 的类型依赖。
 *  守卫按运行时性质放行（见 file-budget.test.ts 的白名单说明）。
 *
 * 会话保真修复（2026-10-18，task-4；四条都在**本文件内**收口，共享合成器 session-ir.ts 一字未改）：
 *  ① **幂等时间**：墙钟回落只有一个确定性来源（`resolveWallClock`：显式 `options.now` → 记录自身
 *     最早时间戳 → `input.createdAtMs`），只有全都缺失才回落 `Date.now()` 并在
 *     `info.counts.timestampsFallback` **如实记账**。旧实现 parse 与 synthesize 各调一次
 *     `Date.now()` ⇒ 同一来源两次转码字节必然不同 ⇒ DSH 侧「同内容 → Skip」永不成立。
 *  ② **isSidechain**：真实 Claude 子代理记录（`type=user|assistant` + `isSidechain:true`）**一律
 *     不进 IR**，整类计报 `isSidechain`（旧实现零命中 → 子代理正文静默混进父对话）。
 *  ③ **sessionId 不一致**：`input.recordSessionId` 存在且 ≠ `input.id` → 非致命发现
 *     `session-id-mismatch`（会话 id 仍以文件名 stem 为准，见 `TranscodeResult.findings`）。
 *  ④ **推理块**（Claude Code 的 `thinking` / `redacted_thinking`）：共享 IR 没有 reasoning
 *     承载位（docs/spec/known-gaps.md F-01）→ 计报 `thinking`，**绝不伪装成正文**；非 Claude 原生的
 *     `{type:'reasoning',text:…}` 刻意保持既有口径（理由与切换方式见 `REASONING_BLOCK_TYPES`）。
 */
import type { Stats } from 'node:fs';

import { projectKeyOf } from '../core/session-select.ts';
import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import {
  irBump,
  irEarlier,
  irMessage,
  irMessageIdOf,
  irNum,
  irSafeTime,
  irStr,
  irTextBlock,
  irTextOfBlocks,
  irToolCallBlock,
  irToolResultBlock,
  isSafeIrId,
  parseJsonlObjects,
  synthesizeDshRows,
} from './session-ir.ts';
import type {
  DshSessionHeader,
  DshSessionRow,
  IrBlock,
  IrMessage,
  IrParseStats,
  IrSession,
  IrTimeMs,
  SynthesisStats,
} from './session-ir.ts';
// types.ts 只被**类型**引用（lead 冻结的输入形态 + 契约码），不做任何值导入
import type { ClaudeSessionInput, ForeignSkip } from './types.ts';

export type { DshSessionHeader, DshSessionRow } from './session-ir.ts';

/**
 * 本模块已实现行式的 DSH 会话格式版本（其它版本一律拒绝，不猜）。
 *
 * **v3 与 v4 的行式是同一套**：`synthesizeDshRows` 产出的行在两代 DSH 自己的真 codec 上逐条复验过
 * （v3 档 = 本机 CLI 档案树的 dsh-session；v4 档 = 桌面端 0.2.0-rc.2，均 `equivalentToReadPath`）。
 * 所以**按目标机的版本写**：目标是 v3 就写 v3、是 v4 就写 v4。两条反向都不行 —— 一律写最高版本
 * 会让 v3 主机读不了（反向不可读）；只认 v3 则让 v4 目标整批被跳过（2026-10-08 真机事故：
 * 桌面端 v4 目标下每一条会话都被 `session-format-unsupported` 拒掉，产出的包里没有 sessions 分区）。
 */
export const SUPPORTED_DSH_SESSION_FORMAT_VERSIONS: readonly number[] = [3, 4];

/** 单帧的软上限（字节）：把多条事件行合并进一帧，避免「一行一帧」产生上千个帧 */
const FRAME_TARGET_BYTES = 64 * 1024;

/** 该会话的请求头能力声明（从重构前的内联字面量原样搬出，取值一字未改） */
const CLAUDE_PROVIDER = 'claude-code';
const CLAUDE_REASONING_EFFORT = 'medium';
const CLAUDE_MAX_TOKENS = 8192;

/**
 * 待转码的 Claude 会话文件。
 *
 * **等价于 `types.ts` 的 `ClaudeSessionInput`**（2026-10-18 起不再重复声明）：读盘层额外给的
 * `recordSessionId`（≠ 文件名 stem 时报 session-id-mismatch）与 `createdAtMs`（确定性 createdAt
 * 回落值，见 `resolveWallClock`）因此天然可达本层，而 `{ id, text }` 的老调用方一字不用改。
 */
export type ClaudeSessionFile = ClaudeSessionInput;

/**
 * **只读**的文件读取面（additive，2026-10）：**内部**用它支持「大文件只读头尾」的追加通道。
 *
 * 现状：转码器一次吃全文（`ClaudeSessionFile.text`），本接口是**给将来留的扩展位**，不是
 * 现状产物的一部分 —— 因此它**刻意不从本模块再导出**（v1 公开面是 registry/claude-code.ts
 * 到转码器的调用，不是这个内部形状）。真正需要它的是「同一会话被再次导入时只转尾段」那条路
 * （竞品 `tailSessionEvents` 的等价物），属于 t4 之后的档 B 工作。
 */
export interface ClaudeReadHandle {
  readonly id: string;
  /** 只需要文件元信息与大小（宿主侧用 `ctx.fs.stat` 即可满足，避免为了 size 读整份文件） */
  stat(): Promise<Stats>;
  /** 只读前 n 字节（可选实现；未提供时由调用方整读后再截取） */
  readHead?(bytes: number): Promise<string>;
  /** 只读后 n 字节（可选实现） */
  readTail?(bytes: number): Promise<string>;
}

export interface ClaudeSessionInfo {
  records: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  /**
   * 未迁移的记录类型 / 内容块 → 条数（attachment / queue-operation / system / isSidechain /
   * thinking / unparsable …）。**每个键在下游都会被翻成 `unsupported-session-record` 的 detail**
   * （kernel.collectSessionSections），所以这里只放「这条内容本版不迁移」这一件事。
   */
  ignored: Record<string, number>;
  /**
   * 结算类记账（**刻意不进 `ignored`**：那里的键会被翻成 `unsupported-session-record`，语义不符）。
   *
   * 目前只有 `timestampsFallback`（0/1）：记录里与 `input.createdAtMs` **都没有**可用时间戳 ⇒
   * 本次转码只能回落墙钟 `Date.now()`，**同一来源两次转码的字节可能不同**（DSH 侧「同内容 → Skip」
   * 因此不成立、重复导入会判 Conflict）。这是必须如实报出来的不确定性，不是错误。
   */
  counts: Record<string, number>;
}

export interface TranscodedSession {
  id: string;
  cwd: string;
  /** 包内相对路径：<projectKey>/<id>/<日志名> */
  relativePath: string;
  data: Uint8Array;
  info: ClaudeSessionInfo;
}

export interface TranscodeOptions {
  /** 目标机 DSH 的 SESSION_FORMAT_VERSION（必填） */
  formatVersion: number;
  /**
   * 墙钟回落的**最高优先级**注入点（测试 / 调用方显式给定）。
   *
   * 缺省时按 `resolveWallClock` 的回落链取：记录自身最早时间戳 → `input.createdAtMs` →
   * `Date.now()`（最后一级会在返回值里记 `timestampsFallback`）。非法值（非安全整数）视同没给。
   */
  now?: number;
}

export interface TranscodeSkip {
  code:
    | 'session-format-unsupported'
    | 'session-missing-cwd'
    | 'session-unsafe-id'
    | 'session-empty'
    | 'session-unparsable';
  detail?: string;
}

export interface TranscodeResult {
  session?: TranscodedSession;
  skip?: TranscodeSkip;
  /**
   * **非致命**发现（会话照样产出）：目前只有 `session-id-mismatch`（记录里的 sessionId 与文件名
   * stem 不一致）。会话 id 仍以文件名 stem 为准，只有「不一致」这件事必须可见。
   *
   * 为什么放在结果上而不是 `info.ignored`：`ignored` 的键在下游一律被翻成
   * `unsupported-session-record`（码固定），而本条要用契约里冻结的 `session-id-mismatch`。
   * **调用方负责原样带出**（`skipped.push(...result.findings)`）—— 现有
   * `kernel.collectSessionSections` 尚未读本字段（不在本次改动范围）。空数组 = 没有发现。
   */
  findings: ForeignSkip[];
}

/* ---------------- ① 解析：Claude 记录 → IR ---------------- */

/** Claude 记录里可识别的块（原始形态） */
interface ParsedBlock {
  /**
   * `thinking` = 推理块（Claude Code 的 `thinking` / `redacted_thinking`）：共享 IR 的 `IrBlock`
   * **没有 reasoning 承载位**（docs/spec/known-gaps.md F-01），所以它既不进 IR 也不伪装成正文，
   * 只**逐条计数**（ignored['thinking']）。判定口径与「`reasoning` 为何不在此列」见
   * `REASONING_BLOCK_TYPES` 的注释。
   */
  readonly kind: 'text' | 'call' | 'result' | 'thinking' | 'other';
  readonly text: string;
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly isError: boolean;
}

/** `message.usage` 的一个字段（对象外一律 undefined —— 形态不符是「没这回事」，不是「0 用量」） */
function usageField(usage: unknown, key: string): unknown {
  return typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>)[key] : undefined;
}

/**
 * 推理块的类型名 = Claude Code **自己**写的两种：`thinking` 与 `redacted_thinking`。
 *
 * 为什么必须按类型名判定：`thinking` 块的正文在 **`thinking` 键**里（没有 `text` 字段），旧实现
 * 沿「对象带 text 才算文本」的兜底把它变成一个**空文本块** —— 内容静默丢失，且那个空块还会多插入
 * 一个换行。本仓其余 20+ 来源一律「推理不伪装成正文、只计数」（read-crush / read-opencode /
 * read-qwen / read-pi / read-openclaw …），这里对齐同一口径；共享 IR 无 reasoning 承载位这件事
 * 记在 docs/spec/known-gaps.md 的 F-01。
 *
 * **为什么不把 `{type:'reasoning', text:'…'}` 一并纳入**（如实记明，别当成漏掉）：
 *  ① Claude Code 不写这种块（它是别的导出器的归一命名，各来源自己的解析器已各自计报）；
 *  ② 共享 IR 的文本兜底分支（**对象带 `text` 就当文本块**）是**被逐字节回归钉住的既有行为**
 *     （见 `blocksOf` 的注释），而这个块恰好命中它 —— 一并丢掉会让
 *     `claude-sessions-bytes.test.ts` 的 `timestamps-numeric-and-unparsable` 一案从 728 字节
 *     变成 722 字节（正文少一段 'r'）。那是**用户可见**的正文变化，按本轮的硬约束（既有语料
 *     逐字一致）不由「修推理块静默丢弃」顺手引入。
 *  ③ 要一并计报，改这一个数组即可，并同步更新该案基线（现行行为已被
 *     `claude-sessions.test.ts` 的「reasoning 形状」用例显式钉住）。
 */
const REASONING_BLOCK_TYPES: readonly string[] = ['thinking', 'redacted_thinking'];

/** 推理块的占位（字段一律空：它不进 IR，只需被识别出来计数） */
function reasoningBlock(): ParsedBlock {
  return { kind: 'thinking', text: '', id: '', name: '', input: undefined, isError: false };
}

function blockOf(raw: unknown): ParsedBlock {
  const rec = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (rec === undefined) {
    return { kind: 'other', text: '', id: '', name: '', input: undefined, isError: false };
  }
  const rawType = irStr(rec['type']) ?? '';
  if (REASONING_BLOCK_TYPES.includes(rawType)) return reasoningBlock();
  const id = irStr(rec['id']) ?? '';
  const name = irStr(rec['name']);
  const isText = rawType === 'text' || typeof rec['text'] === 'string';
  if (isText) {
    return {
      kind: 'text',
      text: typeof rec['text'] === 'string' ? rec['text'] : '',
      id, name: '', input: undefined, isError: false,
    };
  }
  if (rawType === 'tool_use' && name !== undefined) {
    return { kind: 'call', text: '', id, name, input: rec['input'], isError: false };
  }
  // 工具结果的配对键是 Claude 的 `tool_use_id`（不是块 id）；**空串照抄**（源没给就保持空，
  // 不伪造 —— 伪造会让 tool_result 与 tool/call 的 callId 对不上）
  if (rawType === 'tool_result') {
    const key = irStr(rec['tool_use_id']);
    if (key !== undefined) {
      return { kind: 'result', text: '', id: key, name: '', input: undefined, isError: rec['is_error'] === true };
    }
  }
  return { kind: 'other', text: '', id, name: '', input: undefined, isError: false };
}

/**
 * 内容块抽取：字符串正文 / 数组正文 / 对象正文（含 `text` 字段）。
 *
 * 注意第三条分支（数组里的**对象**且带 text）会被当作文本块 —— 这是重构前的**既有行为**，
 * 逐字节回归钉住了它；改它会改变产物（用户在会话里看到多余/缺失的文本块）。
 */
function blocksOf(message: unknown): ParsedBlock[] {
  const msg = typeof message === 'object' && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
  if (msg === undefined) return [];
  const content = msg['content'];
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content, id: '', name: '', input: undefined, isError: false }];
  }
  // 唯一口径：**每个元素都走同一个块解析器**（重构前对数组元素逐个判 type，与 blockOf 的
  // 「类文本 / tool_use / tool_result」三分支同解；逐字节回归钉住这一等价性）
  if (!Array.isArray(content)) return [];
  const out: ParsedBlock[] = [];
  for (const raw of content) out.push(blockOf(raw));
  return out;
}

/** 块 → IR（工具结果在此拍平成文本；其它块保持文本投影） */
function irBlockOf(block: ParsedBlock): IrBlock {
  if (block.kind === 'call') return irToolCallBlock(block.id, block.name, block.input);
  if (block.kind === 'result') return irToolResultBlock(block.id, block.text, block.isError);
  return irTextBlock(block.text);
}

/** 一条 Claude 记录 → IR 消息；`undefined` = 该记录不产出消息（未迁移的类型） */
function irMessageOf(
  rec: Record<string, unknown>,
  parsed: readonly ParsedBlock[],
  index: number,
): IrMessage | undefined {
  const type = irStr(rec['type']) ?? 'unknown';
  const uuid = rec['uuid'];
  if (type === 'assistant') {
    const msg = typeof rec['message'] === 'object' && rec['message'] !== null
      ? (rec['message'] as Record<string, unknown>)
      : undefined;
    const usage = msg === undefined ? undefined : msg['usage'];
    return irMessage(irMessageIdOf(uuid, index), 'assistant', parsed.map(irBlockOf), {
      source: { model: irStr(msg?.['model']) ?? '' },
      usage: {
        inputTokens: irNum(usageField(usage, 'input_tokens')),
        outputTokens: irNum(usageField(usage, 'output_tokens')),
        cacheReadTokens: irNum(usageField(usage, 'cache_read_input_tokens')),
      },
      time: irSafeTime(rec['timestamp']),
    });
  }
  if (type === 'user') {
    return irMessage(irMessageIdOf(uuid, index), 'user', parsed.map(irBlockOf), {
      time: irSafeTime(rec['timestamp']),
    });
  }
  return undefined;
}

/**
 * Claude 会话原文 → IR（**纯函数，不读盘**）。
 *
 * 反应：坏行不抛、计数上报（`stats.unparsable`）；缺 cwd 时**不产出会话**（由调用方转成 skip 码），
 * 因为 DSH 会按 cwd 的目录键归位，猜一个 cwd 等于把会话放到错误的项目里。
 */
export function parseClaudeSession(
  file: ClaudeSessionFile,
  options: TranscodeOptions,
  stats?: IrParseStats,
): IrSession | undefined {
  const parsed = parseClaudeSessionText(file, options);
  if (stats !== undefined) {
    stats.records = parsed.records.length;
    stats.unparsable = parsed.unparsable;
  }
  return parsed.records.length === 0 ? undefined : parsed.session;
}

function typeOf(rec: Record<string, unknown>): string {
  return irStr(rec['type']) ?? 'unknown';
}

/**
 * 一次解析出的全部记账（供转码入口判定 skip 面与合成所需的源侧提示）。
 *
 * `messages` 的长度与 `records.length` **刻意可以不等**：只有 user/assistant 记录进 IR，
 * 其余类型由合成期按「未迁移记录类型」计数（与重构前逐字一致）。
 */
interface ParsedClaudeSession {
  readonly session: IrSession;
  readonly records: readonly Record<string, unknown>[];
  readonly cwd: string | undefined;
  readonly unparsable: number;
  readonly title: string;
  /** `isSidechain === true` 的**记录条数**（子代理记录：不进 IR，由转码入口整类计报） */
  readonly sidechain: number;
  /** 内容块里的推理块条数（IR 无承载位：不进 IR，由转码入口整类计报） */
  readonly thinking: number;
  /** 本次解析**唯一**算出的墙钟回落值；转码入口必须复用它，绝不再调一次 Date.now() */
  readonly now: number;
  /** `now` 是否来自墙钟回落（记录与 `input.createdAtMs` 都没有可用时间戳） */
  readonly wallClockFallback: boolean;
}

/**
 * 墙钟回落的**唯一**来源（缺陷 1 的修复）。
 *
 * 为什么必须只有一处：会话产物的字节里带 createdAt / 各行各列的时间；只要有一次 `Date.now()`
 * 参与，同一来源两次转码的字节就必然不同 ⇒ DSH 侧「同内容 → Skip」永不成立、重复导入恒判
 * Conflict。旧实现 parse 与 synthesize **各调一次** `Date.now()`（返回值还可能是两个不同的毫秒）。
 *
 * 回落链（前三级都是确定性的：同一输入 → 同一产物）：
 *  ① `options.now`（调用方/测试显式给定；**保持最高优先级**，既有字节回归靠它稳定）；
 *  ② 记录自身的最早可解析时间戳（会话文件里最权威的确定性来源）；
 *  ③ `input.createdAtMs`（读盘层给的回落值：最早可解析记录时间，没有就给文件 mtime）；
 *  ④ 都没有 → `Date.now()`，并**如实记账**（`timestampsFallback`）。
 *
 * 非法值（非安全整数 / 非有限数）一律当「没给」：DSH 对时间字段要求安全整数，宁可继续回落也
 * 不写出一条会被拒读的行。
 */
function resolveWallClock(
  file: ClaudeSessionFile,
  options: TranscodeOptions,
  earliest: IrTimeMs | undefined,
): { readonly now: number; readonly fallback: boolean } {
  const explicit = irSafeTime(options.now);
  if (explicit !== undefined) return { now: explicit, fallback: false };
  if (earliest !== undefined) return { now: earliest, fallback: false };
  const given = irSafeTime(file.createdAtMs);
  if (given !== undefined) return { now: given, fallback: false };
  return { now: Date.now(), fallback: true };
}

/**
 * 解析入口：**只走一遍 JSON.parse**，把「记录 / cwd / 最早时间 / IR 消息 / 标题」一次算齐。
 *
 * 为什么必须只走一遍：文本解析是这里唯一的热点（长会话可达数 MB），重构前也只解析一次；
 * 分成「解析 IR」+「再解析原始记录取标题」两遍会让大文件成本翻倍。
 */
function parseClaudeSessionText(file: ClaudeSessionFile, options: TranscodeOptions): ParsedClaudeSession {
  const stats: IrParseStats = { records: 0, unparsable: 0, issues: [] };
  const records = parseJsonlObjects(file.text, stats);

  let cwd: string | undefined;
  let createdAt: number | undefined;
  let sidechain = 0;
  for (const r of records) {
    // 子代理记录（真实 Claude 的子代理对话就是 type=user/assistant + isSidechain:true）：
    // 它们**不是父对话的回合**，混进来会静默改写父对话正文（设计文档 2026-10-04-foreign-import-v1.md:89
    // 「不迁移 isSidechain 的子代理会话」，而旧实现连计数都没有）。
    // 它们仍参与 cwd / 最早时间：子代理与父对话同属一份日志文件，cwd 与时间线是**文件级**事实。
    if (r['isSidechain'] === true) sidechain++;
    if (cwd === undefined) cwd = irStr(r['cwd']);
    createdAt = irEarlier(createdAt, irSafeTime(r['timestamp']));
  }
  // 墙钟回落**只在这里解析一次**，转码入口复用 `now`（同一输入一次调用内不可能出现两个 Date.now()）
  const wall = resolveWallClock(file, options, createdAt);

  const messages: IrMessage[] = [];
  let messageIndex = 0;
  let thinking = 0;
  let firstUserText = '';
  for (const rec of records) {
    const type = typeOf(rec);
    if (type !== 'user' && type !== 'assistant') continue;
    if (rec['isSidechain'] === true) continue;
    const blocks = blocksOf(rec['message']);
    // 推理块：先逐条计数，再**整块丢掉**（既不进 IR，也不留空文本块 —— 空块还会污染正文的换行串联）
    thinking += blocks.filter((b) => b.kind === 'thinking').length;
    const carried = blocks.filter((b) => b.kind !== 'thinking');
    const message = irMessageOf(rec, carried, messageIndex);
    if (message === undefined) continue;
    messages.push(message);
    // 消息 id 的兜底序 = 「第几条已知消息」（重构前的序号语义，逐字节回归钉住）
    messageIndex++;
    if (type === 'user' && firstUserText === '') {
      const text = irTextOfBlocks(carried.map(irBlockOf));
      if (text.trim() !== '') firstUserText = text;
    }
  }

  return {
    session: {
      id: file.id,
      cwd: cwd ?? '',
      createdAt: createdAt ?? wall.now,
      records: records.length,
      messages,
    },
    records,
    cwd,
    unparsable: stats.unparsable,
    title: titleOf(records, firstUserText),
    sidechain,
    thinking,
    now: wall.now,
    wallClockFallback: wall.fallback,
  };
}

/* ---------------- ② ③ 合成 + 编码 ---------------- */

/** 标题：Claude 的 summary 记录优先，否则首条用户文本前 80 字（折叠空白） */
function titleOf(records: readonly Record<string, unknown>[], firstUserText: string): string {
  for (const r of records) {
    if (irStr(r['type']) === 'summary') {
      const s = irStr(r['summary']);
      if (s !== undefined) return s.slice(0, 200);
    }
  }
  return firstUserText.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 日志文件名（与 DSH 的 generation 命名一致：v0 无后缀，vN 带 .vN） */
export function dshSessionLogName(version: number): string {
  return version === 0 ? 'session.jsonl.zstd' : 'session.v' + version + '.jsonl.zstd';
}

export function transcodeClaudeSession(file: ClaudeSessionFile, options: TranscodeOptions): TranscodeResult {
  /**
   * 非致命发现（会话照样产出）：记录里的 sessionId 与文件名 stem 不一致时**如实报码**，
   * 但会话 id 仍以文件名 stem 为准（DSH 按「目录名 / 文件名」定位会话）。读盘层没给
   * `recordSessionId`（老调用方）就什么都不报 —— 不猜。
   */
  const findings: ForeignSkip[] = [];
  const recordSessionId = irStr(file.recordSessionId);
  if (recordSessionId !== undefined && recordSessionId !== file.id) {
    findings.push({ code: 'session-id-mismatch', origin: file.id });
  }

  if (!SUPPORTED_DSH_SESSION_FORMAT_VERSIONS.includes(options.formatVersion)) {
    return { skip: { code: 'session-format-unsupported', detail: String(options.formatVersion) }, findings };
  }
  if (!isSafeIrId(file.id)) return { skip: { code: 'session-unsafe-id', detail: file.id }, findings };

  const parsed = parseClaudeSessionText(file, options);
  if (parsed.records.length === 0) return { skip: { code: 'session-empty' }, findings };
  if (parsed.cwd === undefined) return { skip: { code: 'session-missing-cwd', detail: file.id }, findings };
  // 有内容但一行都解析不出来：如实区分「空文件」与「解析不了」（诊断更准，不新增码 —— 两者
  // 在下游都是「这条会话没有产出」，区别只在忽略计数里可见）
  if (parsed.session.messages.length === 0 && parsed.unparsable > 0) {
    return { skip: { code: 'session-unparsable', detail: file.id }, findings };
  }

  // 时间兜底**只有一处**（parseClaudeSessionText 里解析过一次）：这里绝不再调 Date.now()
  const now = parsed.now;
  const stats: SynthesisStats = {
    ignored: {},
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
  };
  if (parsed.unparsable > 0) irBump(stats.ignored, 'unparsable', parsed.unparsable);
  // 推理块：共享 IR 没有承载位 → 计报，绝不伪装成正文（与其余 20+ 来源同口径）
  if (parsed.thinking > 0) irBump(stats.ignored, 'thinking', parsed.thinking);
  // 子代理记录：不进 IR → 整类计报（detail 固定为 isSidechain）
  if (parsed.sidechain > 0) irBump(stats.ignored, 'isSidechain', parsed.sidechain);

  // 未迁移的记录类型**逐类计数**（attachment / queue-operation / system …）——
  // IR 只承载 user/assistant 消息，所以这里按原始记录把其余类型补进忽略计数。
  // isSidechain 记录已整类记账（上一步），不在这里重复计数。
  for (const rec of parsed.records) {
    if (rec['isSidechain'] === true) continue;
    const type = typeOf(rec);
    if (type === 'user' || type === 'assistant') continue;
    irBump(stats.ignored, type);
  }

  const rows = synthesizeDshRows(parsed.session, {
    title: parsed.title,
    titleSource: { kind: 'fallback' },
    emptyBlocks: [],
    provider: CLAUDE_PROVIDER,
    reasoningEffort: CLAUDE_REASONING_EFFORT,
    maxTokens: CLAUDE_MAX_TOKENS,
  }, stats, now);

  if (rows.length === 0) return { skip: { code: 'session-empty' }, findings };

  const header: DshSessionHeader = {
    type: 'session',
    version: options.formatVersion,
    id: file.id,
    createdAt: parsed.session.createdAt,
    cwd: parsed.cwd,
    isSeeded: false,
    delegationDepth: 0,
  };
  const data = encodeDshSessionLog(header, rows);
  // 结算类记账（与 ignored 分开放：ignored 的键会被下游翻成 unsupported-session-record 码）。
  // 0 也写出来：调用方一眼能看出「这次转码是否确定性」，不需要靠键的有无去猜。
  const counts: Record<string, number> = {
    timestampsFallback: parsed.wallClockFallback ? 1 : 0,
  };
  return {
    session: {
      id: file.id,
      cwd: parsed.cwd,
      relativePath: projectKeyOf(parsed.cwd) + '/' + file.id + '/' + dshSessionLogName(options.formatVersion),
      data,
      info: {
        records: parsed.records.length,
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        ignored: stats.ignored,
        counts,
      },
    },
    findings,
  };
}

/** 帧拼接：首帧 = header 单行 JSON，之后每批事件一帧（与 DSH 的物理编码一致，帧带内容校验和） */
export function encodeDshSessionLog(header: DshSessionHeader, rows: readonly DshSessionRow[]): Uint8Array {
  const encoder = new TextEncoder();
  const frames: Uint8Array[] = [encodeZstdFrame(encoder.encode(JSON.stringify(header) + '\n'))];
  let batch: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    frames.push(encodeZstdFrame(encoder.encode(batch.join('\n') + '\n')));
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const line = JSON.stringify(row);
    batch.push(line);
    bytes += line.length + 1;
    if (bytes >= FRAME_TARGET_BYTES) flush();
  }
  flush();
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
