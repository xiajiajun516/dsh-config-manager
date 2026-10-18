/**
 * 会话合成行 ↔ DSH 读盘管线**硬不变量**的回归护栏（2026-10-07）。
 *
 * 为什么需要（真机事故）：导入 Hermes 历史会话后 DSH 报
 *   `stored session "…" is corrupt: … session event at seq 5 message must have model source`
 * 根因是 `synthesizeDshRows` 产出的行不满足 DSH 的 `assertMessageEventShape`
 * （`dsh-session/lib/index.js:946-955`，由 `adoptSessionEvent` 在装入时逐行执行）：
 *   · `assistant/message` 的 `message.source` 必须是 `{kind:'model', provider, model}` 且 provider/model **非空**；
 *   · `tool/result` 的 `source.callId` 必须**非空**，且与 `content[0].toolCallId` 逐字相同；
 *     块类型是 `tool-result`（连字符）—— `tool_result`/`tool_use_id`/`is_error` 这套命名会被**直接拒读**；
 *   · 真实 DSH 日志里 `assistant/message` 还带 `stream`（数组，语义不透明）与 content 里的 `tool-call` 块
 *     （`deriveEventMessage` 对空 content 返回 null，DSH 的 interrupted-turn 修复也按它记录未决调用）。
 *
 * 本测试**不依赖 DSH 在场**（CI 里没有它），只钉上面这几条形状；同一批产物已用 DSH 自己的
 * `adoptSessionEvent` 在真机逐行复验过（hermes 71 会话 / 29687 行 → 0 拒绝）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  irFallbackMessageId,
  irMessage,
  irTextBlock,
  irToolCallBlock,
  irToolResultBlock,
  synthesizeDshRows,
} from './session-ir.ts';
import type { DshSessionRow, IrMessage, SynthesisStats } from './session-ir.ts';

const NOW = 1700000000000;

function stats(): SynthesisStats {
  return { ignored: {}, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 };
}

/** 一份覆盖三个关键点的小会话：有 id 的调用/结果、缺 id 的调用/结果、无主结果。 */
function synth(): { rows: DshSessionRow[]; stats: SynthesisStats } {
  const s = stats();
  const rows = synthesizeDshRows(
    {
      id: 's1',
      cwd: 'D:/proj',
      createdAt: NOW,
      records: 6,
      messages: [
        irMessage(irFallbackMessageId(0), 'user', [irTextBlock('你好')], { time: NOW }),
        irMessage(irFallbackMessageId(1), 'assistant', [
          irTextBlock('看一下'),
          irToolCallBlock('c1', 'terminal', { command: 'ls' }),
        ], { time: NOW + 1, source: { model: 'hermes-model' } }),
        irMessage(irFallbackMessageId(2), 'user', [irToolResultBlock('c1', 'file.txt', false)], { time: NOW + 2 }),
        // 缺 id 的调用 → 合成器必须铸稳定 id，且结果按 FIFO 回填同一个 id
        irMessage(irFallbackMessageId(3), 'assistant', [irToolCallBlock('', 'read', { path: 'a' })], { time: NOW + 3 }),
        irMessage(irFallbackMessageId(4), 'user', [irToolResultBlock('', 'body', true)], { time: NOW + 4 }),
        // 无主结果（一个未决调用都没有）→ 计数后丢弃，绝不产出空 callId
        irMessage(irFallbackMessageId(5), 'user', [irToolResultBlock('', 'orphan', false)], { time: NOW + 5 }),
      ],
    },
    {
      title: 't',
      titleSource: { kind: 'fallback' },
      emptyBlocks: [],
      provider: 'hermes',
      reasoningEffort: 'medium',
      maxTokens: 8192,
    },
    s,
    NOW,
  );
  return { rows, stats: s };
}

const LEGACY_BLOCK_KEYS = ['tool_use_id', 'is_error', 'tool_result'];

test('合成行：assistant/message 的 source 必须是 kind=model 且 provider/model 非空', () => {
  const { rows } = synth();
  const assistants = rows.filter((r) => r.type === 'assistant/message');
  assert.ok(assistants.length >= 2, '语料里应有助手消息');
  for (const row of assistants) {
    const data = row.data as { message: { source: Record<string, unknown> }; stream?: unknown };
    assert.equal(data.message.source['kind'], 'model', 'DSH 拒读 kind!=="model" 的 assistant 行');
    assert.equal(typeof data.message.source['provider'], 'string');
    assert.notEqual(data.message.source['provider'], '', 'provider 必须非空');
    assert.equal(typeof data.message.source['model'], 'string');
    assert.notEqual(data.message.source['model'], '', 'model 必须非空（缺省兜底 unknown）');
    assert.ok(Array.isArray(data.stream), 'assistant/message 必须带 stream 数组（装入边界要求）');
  }
});

test('合成行：assistant content 必须携带 tool-call 块，且 id 与 tool/call 事件逐字一致', () => {
  const { rows } = synth();
  const callEvents = rows.filter((r) => r.type === 'tool/call');
  const callIds = callEvents.map((r) => (r.data as { callId: string }).callId);
  assert.equal(callIds.length, 2);
  for (const id of callIds) assert.ok(id !== '', 'tool/call 的 callId 必须非空');
  const blocks = rows
    .filter((r) => r.type === 'assistant/message')
    .flatMap((r) => (r.data as { message: { content: { type: string; id?: string }[] } }).message.content)
    .filter((b) => b.type === 'tool-call');
  assert.deepEqual(blocks.map((b) => b.id), callIds, 'content 里的 tool-call 块必须与 tool/call 事件同 id、同序');
});

test('合成行：tool/result 用 DSH 的 tool-result / toolCallId / isError 形状，callId 非空且与调用配对', () => {
  const { rows } = synth();
  const callIds = new Set(rows.filter((r) => r.type === 'tool/call').map((r) => (r.data as { callId: string }).callId));
  const results = rows.filter((r) => r.type === 'tool/result');
  assert.equal(results.length, 2, '有 id 的 + 缺 id 回填的 → 恰好两条；无主结果必须被丢弃');
  for (const row of results) {
    const data = row.data as { message: { source: { kind: string; callId: string }; content: Record<string, unknown>[] } };
    assert.equal(data.message.source['kind'], 'tool');
    const callId = data.message.source['callId'];
    assert.ok(typeof callId === 'string' && callId !== '', 'source.callId 必须非空（空串会被 DSH 拒读）');
    assert.ok(callIds.has(callId), 'callId 必须指向一条真实发出过的 tool/call');
    assert.equal(data.message.content.length, 1, 'tool/result 必须恰好一个内容块');
    const block = data.message.content[0] as Record<string, unknown>;
    assert.equal(block['type'], 'tool-result', '块类型必须是 tool-result（连字符）');
    assert.equal(block['toolCallId'], callId, '块的 toolCallId 必须与 source.callId 逐字相同');
    assert.equal(typeof block['isError'], 'boolean');
    assert.ok(Array.isArray(block['content']), '块内容必须是数组');
    for (const legacy of LEGACY_BLOCK_KEYS) {
      assert.equal(legacy in block, false, '不得使用会被 DSH 拒读的旧键：' + legacy);
    }
  }
});

test('合成行：无主结果不产出空 callId，按 orphan-tool-result 计数', () => {
  const { rows, stats: s } = synth();
  for (const row of rows) {
    const data = row.data as { message?: { source?: Record<string, unknown> } };
    const source = data.message?.source;
    if (source === undefined) continue;
    assert.notEqual(source['kind'], 'assistant', 'source.kind="assistant" 是本次真机事故的根因，绝不回归');
    if (source['kind'] === 'tool') assert.notEqual(source['callId'], '');
  }
  assert.equal(s.ignored['orphan-tool-result'], 1, '无主结果必须计数可见');
});

/* ---------------- 标题行（DSH 的 assertTitleSources 是硬校验，v3/v4 同款） ---------------- */

/**
 * 标题行规则的最小语料。
 *
 * 为什么单列一组用例（2026-10-08 真机事故）：旧实现把标题停在 seq 0 且恒写 `messageSeqs: []`，
 * 而 DSH 的规则是「`messageSeqs` 为空 **⟺** `source.kind === 'user'`，非空时每个 seq 必须**早于**
 * 本条事件且指向 `source.kind === 'user'` 的 `user/message`」。真 codec 的严格档两代都报这条，
 * 且 **v3→v4 迁移直接拒收整份产物**（`finish-failed: … refuses the transformed artifact`）。
 */
function synthTitle(titleSource: unknown, messages: readonly IrMessage[]): DshSessionRow[] {
  return synthesizeDshRows(
    { id: 's1', cwd: 'D:/proj', createdAt: NOW, records: messages.length, messages },
    { title: '标题', titleSource, emptyBlocks: [], provider: 'hermes', reasoningEffort: 'medium', maxTokens: 8192 },
    stats(),
    NOW,
  );
}

test('标题行：非 user 来源必须引用**更早**的人类 user/message（且 seq 仍连续）', () => {
  const rows = synthTitle({ kind: 'fallback' }, [
    irMessage(irFallbackMessageId(0), 'user', [irTextBlock('你好')], { time: NOW }),
    irMessage(irFallbackMessageId(1), 'assistant', [irTextBlock('在')], { time: NOW + 1 }),
  ]);
  const title = rows.find((r) => r.type === 'session/title');
  assert.ok(title !== undefined, '有标题就必须产标题行');
  const data = title.data as { messageSeqs: number[]; source: { kind: string } };
  assert.equal(data.source.kind, 'fallback');
  assert.deepEqual(data.messageSeqs, [0], '必须引用首条人类 user/message 的 seq');
  assert.ok(title.seq > data.messageSeqs[0]!, '被引用的 seq 必须**早于**标题行本身');
  const cited = rows.find((r) => r.seq === data.messageSeqs[0]);
  assert.equal(cited?.type, 'user/message', '只能引用 user/message（DSH 按位置与类型双重校验）');
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i), 'seq 必须仍从 0 连续递增');
});

test('标题行：user 来源 → messageSeqs 必须为空（空 ⟺ user），可停在 seq 0', () => {
  const rows = synthTitle({ kind: 'user' }, [
    irMessage(irFallbackMessageId(0), 'user', [irTextBlock('你好')], { time: NOW }),
  ]);
  const title = rows[0];
  assert.equal(title?.type, 'session/title');
  assert.equal(title?.seq, 0);
  assert.deepEqual((title?.data as { messageSeqs: unknown }).messageSeqs, [], 'user 标题不引用任何 seq');
});

test('标题行：非 user 来源且整场没有人类 user/message → 不产标题行（不编指不到人的引用）', () => {
  const rows = synthTitle({ kind: 'fallback' }, [
    irMessage(irFallbackMessageId(0), 'assistant', [irTextBlock('只有助手')], { time: NOW }),
  ]);
  assert.equal(rows.some((r) => r.type === 'session/title'), false);
  assert.ok(rows.length > 0, '助手消息本身仍要产出（标题只是装饰）');
});
/* ---------------- 未闭合的工具调用（DSH 的 interrupted-turn 修复，形状前提） ---------------- */

/**
 * 形状护栏（2026-10-18，task-4）：**tool/call 没有 tool/result 时不得伪造任何结算行**。
 *
 * 为什么必须钉住：DSH 自己的修复逻辑（interrupted-turn）只认两样东西 —— ① assistant/message
 * 的 message.content 里有 tool-call 块（它据此知道「这个调用被广告过」）、② 这段流里
 * **没有**对应的 tool/result。若为了「看起来完整」补一条空 result，DSH 会认为调用已结算，
 * 中断状态反而丢失；若 content 里没有 tool-call 块，DSH 连「这里有未决调用」都看不到
 * （deriveEventMessage 对空 content 返回 null）。
 *
 * 本用例刻意**只断言形状**（不引入 DSH 在场依赖）：产物必须保持可读、seq 连续、后续事件照常。
 */
test('未闭合工具调用：不伪造 result、callId 非空、后续事件与 seq 仍合法（中断由 DSH 修复）', () => {
  const s = stats();
  const rows = synthesizeDshRows(
    {
      id: 's2',
      cwd: 'D:/proj',
      createdAt: NOW,
      records: 3,
      messages: [
        irMessage(irFallbackMessageId(0), 'user', [irTextBlock('开始')], { time: NOW }),
        // 只有工具调用、没有正文：content 仍必须携带 tool-call 块（否则整条助手消息会消失）
        irMessage(irFallbackMessageId(1), 'assistant', [irToolCallBlock('c9', 'terminal', { command: 'sleep 100' })], {
          time: NOW + 1,
          source: { model: 'claude-sonnet-4' },
        }),
        // 中断之后用户继续说话：后续事件不得因为未闭合调用而错乱
        irMessage(irFallbackMessageId(2), 'user', [irTextBlock('中断后我打字')], { time: NOW + 2 }),
      ],
    },
    { title: 't', titleSource: { kind: 'fallback' }, emptyBlocks: [], provider: 'claude-code', reasoningEffort: 'medium', maxTokens: 8192 },
    s,
    NOW + 3,
  );

  assert.deepEqual(
    rows.map((r) => r.type),
    [
      'user/message', 'session/title', 'turn/start', 'request/header', 'step/start',
      'assistant/message', 'tool/call', 'step/end', 'turn/end', 'user/message',
    ],
    '未闭合调用不改变事件序列形状：只在 step 里留下一条 tool/call，随后照常收尾并继续下一轮',
  );

  const calls = rows.filter((r) => r.type === 'tool/call');
  assert.equal(calls.length, 1);
  const callId = (calls[0]?.data as { callId: string }).callId;
  assert.ok(typeof callId === 'string' && callId !== '', 'callId 必须非空（空 callId 会被 DSH 前台拒读）');
  assert.equal(rows.some((r) => r.type === 'tool/result'), false, '绝不伪造空 result：伪造等于替 DSH 结掉这笔中断');
  assert.equal(s.toolResults, 0, 'toolResults 计数保持 0（没有结果就是没有）');
  assert.equal(s.toolCalls, 1);

  // DSH interrupted-turn 修复的**唯一依据**：content 里的 tool-call 块必须与事件逐字同 id
  const assistant = rows.find((r) => r.type === 'assistant/message');
  const content = (assistant?.data as { message: { content: { type: string; id?: string }[] } }).message.content;
  assert.deepEqual(content.map((b) => b.type), ['tool-call'], '没有正文的助手消息也必须携带 tool-call 块');
  assert.equal(content[0]?.id, callId, 'content 块 id 与 tool/call 的 callId 必须逐字相同');

  // 日志本身仍合法：seq 从 0 连续递增，中断之后的用户消息照常产出
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i), 'seq 必须仍连续递增');
  assert.equal(rows.filter((r) => r.type === 'user/message').length, 2, '中断之后的消息不得被吞掉');
  assert.equal(rows[rows.length - 1]?.type, 'user/message');
});
