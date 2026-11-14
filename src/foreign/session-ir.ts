/**
 * DSH 会话日志转码的**中间表示（IR）** —— 转码器的共享地基（t4，档 B 前置）。
 *
 * 三段式：**解析（源格式 → IR）→ 合成（IR → DSH 行）→ 编码（行 → 字节）**。
 * 本模块是中间两段的**唯一实现**，且是**纯函数层**：零 I/O、不 import 宿主服务
 * （与竞品 `lib/convert/*` 同一条纪律 —— 只允许 node 内建的纯计算模块）。
 *
 * 为什么要有这一层（不是重构洁癖）：
 *  - 现在每加一个**会话类**来源都要从零写一遍「回合/步骤/工具配对/时间兜底/seq 与 surfaceOp」，
 *    而这些规则由 DSH 的 codec 硬校验（见 claude-sessions.ts 文件头的三条硬约束）；
 *  - 竞品的做法是「每源一个纯转换器 → 唯一合成器 synthesizeSession」，我们此前没有中间层，
 *    转码器把「源解析」与「宿主行式」搅在一起，第二、第三个来源只能复制粘贴。
 *
 * 分层纪律（由 `file-budget.test.ts` 的 import 白名单机械钉住）：
 *  - 本模块**不得**出现 `node:fs` / `node:fs/promises`；
 *  - 本模块**不得** import 任何 `./read-*` 读盘层（方向是 read → convert → IR，不能反过来）；
 *  - 本模块不含任何**Dsh 行式**知识（`session/title`、`seq` 重编号、帧拼接都归合成器）。
 *    源特有的归一规则（Claude 的工具结果翻转、带内空字段等）以下面的旁路字段保留，由
 *    `synthesizeDshRows` 原样透传，从而让字节产物与重构前逐字一致。
 *
 * 立场与竞品的两处**刻意不同**（见 outputs/competitor-recon-2026-10-05/ 的 read-vault §7.2、
 * read-chat-import §4.1）：
 *  ① 竞品的 `turns[].steps[].content` 是「内容块」而工具调用单列；我们把工具调用/结果并入
 *     blocks —— 因为源侧（Claude）本来就是**内联在 message.content 里**，单列字段反而制造
 *     两套顺序语义（Claude 只有消息体一个序列）。
 *  ② IR 时间戳**只放行安全整数**（`Number.isSafeInteger`，含负数年），其余一律丢字段并计数；
 *     竞品只对 usage 做安全整数守卫，时间戳仍靠「取整」兜。DSH 的 header/row 时间字段要求
 *     安全整数，放行浮点等于把不可控输入交给宿主 codec。
 */
import { isRecord } from '../utils/guards.ts';

/** IR 里的时间统一为毫秒；只接受安全整数 */
export type IrTimeMs = number;

/* ---------------- 内容块词表 ---------------- */

/**
 * 归一后的内容块（DSH 侧可表达的最小词汇）。
 *
 * 竞品的 IR 块词汇是 text/reasoning/tool-call/image；我们**刻意不合并**工具块与文本块，
 * 因为两类块在源侧的外观与边界语义不同：
 *  - `tool_call`/`tool_result` 由源直接给出，`id` 是配对键，**允许为空串**（源缺 id 时照抄）；
 *  - `text` 是 `typeof text === 'string'` 的字面判定 —— 包括**空串**（`undefined` 则不是文本，
 *    见 read-claude-code 的「结构上算文本块」判定），这是重构前逐字节对齐的行为。
 */
export interface IrTextBlock { readonly type: 'text'; readonly text: string }
export interface IrToolCallBlock {
  readonly type: 'tool_call';
  /** 源侧调用 id；源没给就是空串（**不伪造**：伪造会让 tool_result 配对错位） */
  readonly id: string;
  readonly name: string;
  /** 工具入参（原样透传，序列化在合成期做） */
  readonly input: unknown;
}
export interface IrToolResultBlock {
  readonly type: 'tool_result';
  /** 对应调用 id；源没给就是空串 */
  readonly id: string;
  /** 结果的纯文本投影（源侧的数组/对象形态在此已拍平） */
  readonly text: string;
  readonly isError: boolean;
}
export type IrBlock = IrTextBlock | IrToolCallBlock | IrToolResultBlock;

export function irTextBlock(text: string): IrTextBlock {
  return { type: 'text', text };
}

export function irToolCallBlock(id: string, name: string, input: unknown): IrToolCallBlock {
  return { type: 'tool_call', id, name, input };
}

export function irToolResultBlock(id: string, text: string, isError: boolean): IrToolResultBlock {
  return { type: 'tool_result', id, text, isError };
}

/* ---------------- 用量 ---------------- */

/** provider 回报的用量（缺失一律记 0，绝不猜） */
export interface IrUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
}

export const IR_ZERO_USAGE: IrUsage = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
};

/* ---------------- 消息（原样透传的源侧数据） ---------------- */

/**
 * 一条 IR 消息 = 消息 id、内容块、以及**源侧数据原样透传槽**。
 *
 * `passthrough` 的存在理由：合成期的 DSH 行式有若干「源侧字段照抄」的位置（Claude 的
 * `usage` 键名与 `source.provider/model`），若在这里归一成我们的词汇，合成期就得把这些
 * 映射表再搬回来 —— 那是把「源知识」泄漏进宿主层。透传槽让 IR 保持**源无关**：只有源适配器
 * 知道自己要放什么进去。
 */
export interface IrMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly blocks: readonly IrBlock[];
  /** 供合成期原样写出的源侧字段（结构由源与合成器的契约约定；本层不解释） */
  readonly passthrough?: Readonly<Record<string, unknown>>;
}

export function irMessage(id: string, role: IrMessage['role'], blocks: readonly IrBlock[], passthrough?: Readonly<Record<string, unknown>>): IrMessage {
  return passthrough === undefined ? { id, role, blocks } : { id, role, blocks, passthrough };
}

/* ---------------- 会话 ---------------- */

export interface IrSession {
  /** 会话 id = DSH 侧目录名（由调用方在解析前自证安全） */
  readonly id: string;
  /** 工作目录（DSH 按它的目录键归位；缺失时**根本没有会话**，不猜） */
  readonly cwd: string;
  /** 会话创建时间（源里最早的可解析时间；缺省 = 调用方给的时间兜底） */
  readonly createdAt: IrTimeMs;
  /** 源记录的**原始条数**（含被忽略的） */
  readonly records: number;
  /** 逐条归一后的记录，**保持源顺序** */
  readonly messages: readonly IrMessage[];
}

/* ---------------- 逐条解析的记账（四元组，绝不静默） ---------------- */

export interface IrParseIssue {
  readonly kind: string;
  readonly detail?: string;
}

/**
 * 逐行解析的记账（与竞品 `parseJsonlLines` 的 `{recs, skipped, skippedLines, secrets}` 同形）。
 *
 * 与竞品的两处刻意不同：
 *  ① **明细计数不设 200 上限**：上限会让「第 201 条坏行」静默消失，与本仓「绝不静默」冲突；
 *     真正需要截断时应由**渲染层**决定（本仓已有长列表限高内滚的做法）。
 *  ② 竞品在这条通道里顺带上报疑似密钥位置；我们的凭据策略是**结构性剥离**（见
 *     claude-code.ts 的 collectSettingsFindings），会话文本本身就是用户对话内容，不参与剥离 ——
 *     这条差异是**产品决策**，不是遗漏：把会话正文里的 sk- 当成凭据上报会误导用户以为已经剥离。
 */
export interface IrParseStats {
  /** 解析成功且是对象的记录数（累加器，由 `parseJsonlObjects` 写入） */
  records: number;
  /** 解析失败的**行数**（空行不计；累加器） */
  unparsable: number;
  /** 明细（失败了哪些行、为什么是零会话；累加器） */
  issues: IrParseIssue[];
}

/** 逐行 JSON 解析（坏行不抛，只记账） */
export function parseJsonlObjects(text: string, stats: IrParseStats): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
      else {
        stats.unparsable++;
        stats.issues.push({ kind: 'unparsable', detail: 'not-an-object@line' + String(lineNo) });
      }
    } catch {
      stats.unparsable++;
      stats.issues.push({ kind: 'unparsable', detail: 'bad-json@line' + String(lineNo) });
    }
  }
  return out;
}

/* ---------------- 取值口径（IR 层唯一事实源） ---------------- */

/** 非空字符串 */
export function irStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * 有限数（**不限安全整数**）—— 只用于「比较 / 累加」类字段（如 usage 的 token 数）。
 * 时间戳请用 `irSafeTime`：DSH 对时间字段要安全整数。
 */
export function irNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 毫秒时间：数字（含负数年）必须安全整数，字符串走 Date.parse；其余一律 undefined（绝不 Date.now() 伪造） */
export function irSafeTime(v: unknown): IrTimeMs | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** 会话 id 作为路径段必须自证安全（本层不实现 DSH 的单射转义规则，宁可不转） */
const SAFE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';

export function isSafeIrId(id: string): boolean {
  if (id === '' || id.length > 128) return false;
  if (id === '.' || id === '..') return false;
  if (id.endsWith('.')) return false;
  for (const ch of id) {
    if (SAFE_ID_CHARS.indexOf(ch) < 0) return false;
  }
  return true;
}

/** 类型/种类名的**唯一**计数口径（各处自己写 +1 必然漂移） */
export function irBump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** 取「最早时间」的**唯一**口径（未定义时取候选；候选更早时替换） */
export function irEarlier(a: IrTimeMs | undefined, b: IrTimeMs | undefined): IrTimeMs | undefined {
  if (b === undefined) return a;
  if (a === undefined) return b;
  return b < a ? b : a;
}

/** 消息 id 兜底序：源没给合法 id 时用**会话内序号**铸稳定伪 uuid（与重构前同形） */
export function irFallbackMessageId(index: number): string {
  return '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
}

/* ---------------- DSH 行式（外部形态，供合成器与调用方共用） ---------------- */

/**
 * 一行 DSH 会话事件。
 *
 * 放在 IR 层的理由：`encodeDshSessionLog` 的公开签名**逐字不变**（v1 公开面），而它被
 * IR 层之外的调用方使用；类型留在 IR 层可以让「行式」只有一处定义。
 * **本层不生成行**——行是由 `synthesizeDshRows` 合成的（IR 层不含任何 DSH 语义）。
 */
export interface DshSessionRow {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  /** 表层追加标记：user/message、assistant/message、tool/result 必需（codec 强校验） */
  surfaceOp?: 'append';
}

export interface DshSessionHeader {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
  cwd: string;
  isSeeded: boolean;
  delegationDepth: number;
}

/* ---------------- 合成器 ---------------- */

/**
 * 合成器需要的、**只能由源给出**的额外信息（IR 保持源无关的代价就在这个接口上）：
 *  - `title`：源给的会话标题，或源侧的文本提取（**空标题不产标题行**）
 *  - `titleSource`：标题来源标记（DSH 的 `session/title` 要它）
 *  - `emptyBlocks`：把「本轮内容块全空」时的取值交给源判定 —— Claude 的 user/message 恒为
 *    `[{type:'text',text}]`（允许空串），assistant/message 在文本被 trim 后为空时给 `[]`；
 *    这是**源侧行为**，写进 IR 层就等于把 Claude 的怪癖固化给所有来源
 *  - `provider`：`request/header` 与 `source` 里的 provider 名（源侧才有这个概念）
 *  - `reasoningEffort` / `maxTokens`：请求头的能力声明（同样只在源侧有意义）
 */
export interface IrSynthesisHints {
  readonly title: string;
  readonly titleSource: unknown;
  readonly emptyBlocks: readonly IrBlock[];
  readonly provider: string;
  readonly reasoningEffort: string;
  readonly maxTokens: number;
}

export interface SynthesisStats {
  /** 计数键 → 条数（未迁移的源记录类型、源侧空消息、孤儿结果、坏行都记在这里；累加器） */
  readonly ignored: Record<string, number>;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
}

/**
 * IR → DSH 行（**唯一合成器**，所有会话类来源共用）。
 *
 * 三条硬约束（DSH codec 强校验，违反 = 目标机把会话判为损坏）：
 *  ① `seq` 从 0 连续递增（按位置校验引用）；
 *  ② `user/message`/`assistant/message`/`tool/result` 必须带 `surfaceOp: 'append'`；
 *  ③ 工具生命周期闭合：`tool/call` 开 step，其结果收进**同一个 step**。
 *
 * 与竞品 `synthesizeSession` 的**刻意差异**（不是能力缺失，是宿主不同）：竞品产出的是
 * 「供 DSH 官方 API 导入的事件流」，所以要做 protected head（首个 surface 事件必须是头）、
 * 环境注入、压缩检查点、三层预算；我们产出的是**要写进会话日志文件的行**，宿主 codec
 * 对这条流的硬不变量就是上面三条。补头/注入/压缩属于**待办能力**（见 t4 汇报的
 * 「合成器可扩展位」），不在本次重构里顺手改字节产物 —— 那会让逐字节回归失去意义。
 */
export function synthesizeDshRows(
  session: IrSession,
  hints: IrSynthesisHints,
  stats: SynthesisStats,
  now: number,
): DshSessionRow[] {
  const rows: DshSessionRow[] = [];
  let seq = 0;
  const push = (type: string, time: number, data: Record<string, unknown>, surfaceOp?: 'append'): void => {
    rows.push(surfaceOp === undefined ? { type, seq: seq++, time, data } : { type, seq: seq++, time, data, surfaceOp });
  };

  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let stepOpen = false;
  let model = 'unknown';
  let messageIndex = 0;
  /** 已发出、尚未收到结果的 callId（FIFO）：源侧结果缺 id 时按它回填，绝不产出空 callId */
  const openCallIds: string[] = [];

  const closeStep = (): void => {
    if (stepOpen) {
      push('step/end', now, { turn, step });
      stepOpen = false;
    }
  };
  const closeTurn = (): void => {
    closeStep();
    /**
     * 回合闭合后再到的结果**不许**回填到本回合的调用上：`openCallIds` 是跨 step 共享的 FIFO，
     * 若不在回合边界清空，下一回合缺 id 的 tool_result 会消费到上一回合已结束的 callId
     * （结果落在 turn N+1、却引用 turn N 的调用，DSH 侧配对不上）。
     */
    openCallIds.length = 0;
    if (turnOpen) {
      push('turn/end', now, { turn, reason: { kind: 'completed' } });
      turnOpen = false;
    }
  };
  const openTurn = (time: number): void => {
    turn++;
    push('turn/start', time, { turn });
    push('request/header', time, {
      header: { config: { provider: hints.provider, model, reasoningEffort: hints.reasoningEffort, maxTokens: hints.maxTokens } },
      reason: 'initial',
    });
    turnOpen = true;
  };
  /** 发一条**人类** user/message（唯一形状出口：两条路径共用，避免字段漂移） */
  const emitUserMessage = (text: string, at: number, id: string): void => {
    push(
      'user/message',
      at,
      {
        content: [irTextBlock(text)],
        source: { kind: 'user' },
        role: 'user',
        id,
      },
      'append',
    );
    stats.userMessages++;
  };

  for (const message of session.messages) {
    // time 缺省（源没给可解析时间）→ 用调用方的时间兜底；安全整数校验在 IR 层已完成
    const time = message.passthrough?.['time'];
    const at = typeof time === 'number' && Number.isSafeInteger(time) ? time : now;
    const blocks = message.blocks;

    if (message.role === 'assistant') {
      const text = irTextOfBlocks(blocks);
      const calls = blocks.filter((b): b is IrToolCallBlock => b.type === 'tool_call');
      /**
       * 助手记录里携带的 tool_result：本分支只消费 text/tool_call，这类结果**无处归位**
       * （opencode 等来源把 call 与 result 写进同一条记录，由 `splitToolResults` 先拆开；
       * 没拆到这里的不能静默消失）。计数后丢弃 —— 绝不产出悬空引用，也绝不无声丢内容。
       */
      const assistantResults = blocks.filter((b): b is IrToolResultBlock => b.type === 'tool_result');
      if (assistantResults.length > 0) {
        irBump(stats.ignored, 'assistant-tool-result', assistantResults.length);
      }
      const source = message.passthrough?.['source'];
      const m = irStr((source as Record<string, unknown> | undefined)?.['model']);
      if (m !== undefined) model = m;
      // DSH 要求 provider/model 都是**非空**字符串（hasProviderModel），空串一律兜底，绝不产出会被拒读的行
      const providerName = hints.provider === '' ? 'foreign' : hints.provider;
      const modelName = model === '' ? 'unknown' : model;
      if (text.trim() === '' && calls.length === 0) {
        // 只有 tool_result 的助手记录已按 assistant-tool-result 计数，不再重复记 assistant-empty
        if (assistantResults.length === 0) irBump(stats.ignored, 'assistant-empty');
        continue;
      }
      if (!turnOpen) openTurn(at);
      closeStep();
      step++;
      push('step/start', at, { turn, step });
      stepOpen = true;
      const usage = message.passthrough?.['usage'];
      /**
       * assistant/message 的 `message.content` **必须携带 tool-call 块**（与 DSH 自己写的日志同形）：
       * ① `deriveEventMessage` 对空 content 返回 null —— 只有工具调用、没有正文的助手消息会整条消失；
       * ② DSH 的 interrupted-turn 修复逻辑按 `content[].type === 'tool-call'` 记录未决调用。
       * 块里的 id 与随后 `tool/call` 事件的 callId **共用同一份 callIds**，不可能对不上。
       */
      const content: Record<string, unknown>[] = [];
      if (text.trim() === '') {
        for (const b of hints.emptyBlocks) content.push({ ...b });
      } else {
        content.push({ ...irTextBlock(text) });
      }
      const callIds: string[] = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        if (call === undefined) continue;
        const callId = call.id === '' ? 'call-' + String(messageIndex) + '-' + String(i) : call.id;
        callIds.push(callId);
        content.push({
          type: 'tool-call',
          id: callId,
          name: call.name === '' ? 'unknown' : call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      push(
        'assistant/message',
        at,
        {
          turn,
          step,
          message: {
            role: 'assistant',
            content,
            /**
             * DSH 的 `assertMessageEventShape` 对 assistant/message 的硬要求：
             * `source.kind === 'model'` **且** `hasProviderModel(source)`（provider 与 model 都是非空字符串）。
             * 写 `kind: 'assistant'` 或空的 provider/model 会被**直接拒读**（真机表现为「历史加载失败：… message must have model source」）。
             */
            source: { kind: 'model', provider: providerName, model: modelName },
            id: message.id,
          },
          usage: irUsageOf(usage),
          /**
           * 真实 DSH 日志的 assistant/message 一定带 `stream`（模型增量标记，语义不透明）。
           * 消息正文走 `message.content`（`deriveEventMessage` 只读它），所以空数组是安全的；
           * 但**不能省**：装入/种子边界要求它是数组（`assertAssistantSettlementShape`）。
           */
          stream: [],
        },
        'append',
      );
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const callId = callIds[i];
        if (call === undefined || callId === undefined) continue;
        stats.toolCalls++;
        openCallIds.push(callId);
        push('tool/call', at, {
          turn,
          step,
          callId,
          name: call.name === '' ? 'unknown' : call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      stats.assistantMessages++;
      messageIndex++;
      continue;
    }

    const results = blocks.filter((b): b is IrToolResultBlock => b.type === 'tool_result');
    if (results.length > 0) {
      if (!turnOpen) {
        // 孤儿结果：没有「被广告的 step」可归位 → 丢弃并计数（绝不塞进别的回合）
        irBump(stats.ignored, 'orphan-tool-result');
        messageIndex++;
        continue;
      }
      if (!stepOpen) {
        step++;
        push('step/start', at, { turn, step });
        stepOpen = true;
      }
      for (const r of results) {
        /**
         * 配对键**必须非空**：DSH 的 `assertMessageEventShape` 要求 tool/result 的
         * `source.callId` 是非空字符串，且与 `content[0].toolCallId` 逐字相同，块类型是 `tool-result`
         * （连字符；`tool_result`/`tool_use_id`/`is_error` 这套 Anthropic 命名会被直接拒读）。
         * 源没给 id 时按「最早尚未收到结果的调用」FIFO 回填；一个未决调用都没有 → 这条结果无处归位，
         * 计数后丢弃（**不发明悬空引用**）。
         */
        let callId = r.id;
        if (callId === '') {
          const next = openCallIds.shift();
          callId = next === undefined ? '' : next;
        } else {
          const idx = openCallIds.indexOf(callId);
          if (idx >= 0) {
            openCallIds.splice(idx, 1);
          } else {
            /**
             * 非空 id 但不在未决表里 = 悬空引用（调用已在上一回合闭合，或源侧 id 与真正发出的
             * callId 不同）。与「缺 id 且无未决调用」同口径：计数后丢弃，绝不发指向不存在
             * tool/call 的结果（DSH 侧会按损坏流拒读整条会话）。
             */
            irBump(stats.ignored, 'orphan-tool-result');
            continue;
          }
        }
        if (callId === '') {
          irBump(stats.ignored, 'orphan-tool-result');
          continue;
        }
        stats.toolResults++;
        push(
          'tool/result',
          at,
          {
            turn,
            step,
            message: {
              id: message.id,
              role: 'user',
              source: { kind: 'tool', callId },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: callId,
                  isError: r.isError,
                  content: [{ type: 'text', text: r.text }],
                },
              ],
            },
          },
          'append',
        );
      }
      /**
       * 同一条 user 记录里既有 tool_result 又有 text（Anthropic 形状里很常见：结果块后跟人类补充）：
       * 结果先收进当前 step，文本必须**再发一条真正的 user/message** —— 否则这段用户输入
       * 既到不了目标机、也不进 ignored，属于静默丢失。
       */
      const trailing = irTextOfBlocks(blocks);
      if (trailing.trim() !== '') {
        closeTurn();
        emitUserMessage(trailing, at, message.id);
      }
      messageIndex++;
      continue;
    }

    const text = irTextOfBlocks(blocks);
    if (text.trim() === '') {
      irBump(stats.ignored, 'user-empty');
      messageIndex++;
      continue;
    }
    closeTurn();
    emitUserMessage(text, at, message.id);
    messageIndex++;
  }
  closeTurn();

  /**
   * 标题行：位置与 `messageSeqs` 必须满足 DSH 的 `session/title` 硬规则（`assertTitleSources`；
   * **v3 与 v4 是同一份校验**，真机实测两代在严格档报同一条）：
   *  ① `messageSeqs` 为空 **⟺** `source.kind === 'user'`（用户消息标题不引用，其它来源必须引用）；
   *  ② 非空时每个 seq 必须**早于本条事件**、且指向 `source.kind === 'user'` 的 `user/message`，互不重复。
   *
   * 所以标题行**不能**停在 seq 0：非 user 来源（本仓两处调用方都给 `{kind:'fallback'}`）在 seq 0
   * 没有任何「更早的人类消息」可引用，只写 `messageSeqs: []` 会同时违反①。真机日志同形 ——
   * 实测 `{"type":"session/title","seq":12,"messageSeqs":[7],"source":{"kind":"fallback"}}`（7 是首条人类消息）。
   * 因此把标题行插在**首条人类 user/message 之后**，再按行序统一重编 seq（仍是连续递增）。
   *
   * 来源是 fallback 而整场又没有人类 user/message 时**不产标题行**：标题是装饰性的，
   * 宁可让这条会话按 `session-empty` 如实跳过，也不编一条指不到人的引用（那是会被拒读的行）。
   */
  const titleSource = hints.titleSource;
  const titleSourceKind = typeof titleSource === 'object' && titleSource !== null
    ? (titleSource as { kind?: unknown }).kind
    : undefined;
  if (hints.title !== '') {
    if (titleSourceKind === 'user') {
      rows.unshift({
        type: 'session/title',
        seq: 0,
        time: session.createdAt,
        data: { title: hints.title, messageSeqs: [], source: hints.titleSource },
      });
    } else {
      const at = rows.findIndex((row) => {
        if (row.type !== 'user/message') return false;
        const source = row.data['source'];
        return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user';
      });
      if (at >= 0) {
        rows.splice(at + 1, 0, {
          type: 'session/title',
          seq: 0,
          // at 是「插入前」首条人类消息的 seq（未插入时行序即 seq），引用它必然早于本行
          data: { title: hints.title, messageSeqs: [at], source: hints.titleSource },
          time: session.createdAt,
        });
      }
    }
    rows.forEach((row, index) => {
      row.seq = index;
    });
  }

  return rows;
}

/** 内容块的文本投影（唯一口径：顺序拼接，块之间一个换行） */
export function irTextOfBlocks(blocks: readonly IrBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * 消息 id：优先源自己的 id（**必须自证是安全 id**，否则兜底伪 uuid）。
 * 兜底序 index 由合成器按消息次序给出。
 */
export function irMessageIdOf(raw: unknown, index: number): string {
  const v = irStr(raw);
  return v !== undefined && isSafeIrId(v) ? v : irFallbackMessageId(index);
}

/** 用量归一：非安全整数/负数/缺字段一律 0（DSH 对 usage 要求安全整数） */
export function irUsageOf(raw: unknown): IrUsage {
  const u = isRecord(raw) ? raw : undefined;
  const inputTokens = irTokenCount(u?.['inputTokens']);
  const outputTokens = irTokenCount(u?.['outputTokens']);
  return {
    inputTokens,
    outputTokens,
    // total 是**派生量**（input + output），源侧单独给的 total 一律不采信 —— 与重构前同口径
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: irTokenCount(u?.['cacheReadTokens']),
    // 源侧没有 reasoning 用量（当前来源如此）；一旦某个来源提供，改这里一处即可
    reasoningTokens: irTokenCount(u?.['reasoningTokens']),
  };
}

function irTokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}
