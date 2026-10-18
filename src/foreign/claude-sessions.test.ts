/**
 * Claude Code 会话 → DSH 会话日志的转码护栏。
 *
 * 三层：
 *  ① 形态（路径 / header / 事件序列）；
 *  ② 拒绝面（不认识的格式版本、缺 cwd、非法 id 一律跳过并报码，不产出半成品）；
 *  ③ **用 DSH 自己的 codec 验证产物**（encode 已按 v3 规则对齐，这里再把产物解码回逻辑事件）。
 *     ③ 需要本机装有 DSH（codec 在 profiles 的 node_modules 里）；找不到就 skip，不伪装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSessionLogShapeFromBytes } from '../utils/session-log.ts';
import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName, transcodeClaudeSession } from './claude-sessions.ts';

const NL = String.fromCharCode(10);
const ID = '11111111-1111-4111-8111-111111111111';
const CWD = 'D:/proj/app';

function line(o: unknown): string {
  return JSON.stringify(o);
}

function sessionText(): string {
  return [
    line({ type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: '帮我看看这个 bug' } }),
    line({
      type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000002', timestamp: '2026-10-01T10:00:05.000Z', cwd: CWD,
      message: {
        model: 'claude-sonnet-4',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        content: [
          { type: 'text', text: '我先看一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    line({
      type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000003', timestamp: '2026-10-01T10:00:06.000Z', cwd: CWD,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'entry1' }] },
    }),
    line({ type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000004', timestamp: '2026-10-01T10:00:07.000Z', cwd: CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: '修好了' }] } }),
    line({ type: 'attachment', uuid: 'aaaaaaaa-0000-4000-8000-000000000005', timestamp: '2026-10-01T10:00:08.000Z', cwd: CWD }),
    '{ 这不是合法 JSON',
  ].join(NL) + NL;
}

test('t1 形态：路径 / header / 事件序列', () => {
  const result = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3, now: 1_700_000_000_000 });
  assert.ok(result.session, '应转码成功');
  const s = result.session;
  assert.equal(s.id, ID);
  assert.equal(s.cwd, CWD);
  assert.equal(s.relativePath, projectKeyOf(CWD) + '/' + ID + '/' + dshSessionLogName(3));
  assert.equal(s.relativePath, '--D-proj-app--/' + ID + '/session.v3.jsonl.zstd');

  const shape = readSessionLogShapeFromBytes(s.data);
  assert.equal(shape.ok, true, '产物必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return;
  const header = shape.headerValue as Record<string, unknown>;
  assert.equal(header['type'], 'session');
  assert.equal(header['version'], 3);
  assert.equal(header['id'], ID);
  assert.equal(header['cwd'], CWD);
  assert.equal(header['isSeeded'], false);
  assert.equal(header['delegationDepth'], 0);
  assert.equal(header['createdAt'], Date.parse('2026-10-01T10:00:00.000Z'));

  const types = shape.rows.map((r) => (r === null ? 'null' : (r as Record<string, unknown>)['type']));
  // 标题行**跟在首条人类 user/message 之后**（见 synthesizeDshRows 的标题行注释：非 user 来源的标题
  // 必须引用一条**更早**的人类消息，停在 seq 0 就无解 —— DSH 的 assertTitleSources 会拒读）
  assert.deepEqual(types, [
    'user/message', 'session/title', 'turn/start', 'request/header', 'step/start',
    'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ]);

  // 标题行必须满足 DSH 的 assertTitleSources：非 user 来源 → messageSeqs 非空且引用更早的人类消息
  const titleIndex = shape.rows.findIndex((r) => (r as Record<string, unknown> | null)?.['type'] === 'session/title');
  assert.equal(titleIndex, 1);
  const titleRow = shape.rows[titleIndex] as Record<string, unknown>;
  const titleData = titleRow['data'] as Record<string, unknown>;
  assert.deepEqual(titleData['messageSeqs'], [0], '必须引用首条人类 user/message 的 seq');
  assert.deepEqual(titleData['source'], { kind: 'fallback' });
  assert.ok((titleRow['seq'] as number) > 0, '被引用的 seq 必须早于标题行本身');

  // seq 必须从 0 连续递增（DSH 按位置校验引用）
  const seqs = shape.rows.map((r) => (r as Record<string, unknown>)['seq']);
  assert.deepEqual(seqs, seqs.map((_, i) => i));

  const toolCall = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'tool/call') as Record<string, unknown>;
  const callData = toolCall['data'] as Record<string, unknown>;
  assert.equal(callData['name'], 'Bash');
  assert.equal(callData['callId'], 'toolu_1');
  assert.equal(callData['arguments'], '{"command":"ls"}');

  const userRow = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'user/message') as Record<string, unknown>;
  assert.equal(userRow['surfaceOp'], 'append', 'user/message 也必须有 surfaceOp 标记');

  const assistant = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'assistant/message') as Record<string, unknown>;
  assert.equal(assistant['surfaceOp'], 'append', '消息类事件必须带 surfaceOp 标记');
  const usage = (assistant['data'] as Record<string, unknown>)['usage'] as Record<string, unknown>;
  assert.equal(usage['inputTokens'], 10);
  assert.equal(usage['totalTokens'], 15);
  assert.equal(usage['cacheReadTokens'], 2);

  assert.equal(s.info.toolCalls, 1);
  assert.equal(s.info.toolResults, 1);
  assert.equal(s.info.ignored['attachment'], 1);
  assert.equal(s.info.ignored['unparsable'], 1);
});

test('t1b v4 目标：按目标版本写出（header/文件名同步，不是一律写最高版本）', () => {
  const result = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 4, now: 1_700_000_000_000 });
  assert.ok(result.session, 'v4 目标必须能转码（2026-10-08 桌面端 v4 整批被跳过的回归护栏）');
  const s = result.session;
  assert.equal(s.relativePath, projectKeyOf(CWD) + '/' + ID + '/session.v4.jsonl.zstd');
  assert.equal(s.relativePath, '--D-proj-app--/' + ID + '/session.v4.jsonl.zstd');
  const shape = readSessionLogShapeFromBytes(s.data);
  assert.equal(shape.ok, true, 'v4 产物同样必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return;
  assert.equal((shape.headerValue as Record<string, unknown>)['version'], 4, 'header.version 必须等于目标版本');
});

test('t2 拒绝面：不认识的格式版本 / 缺 cwd / 非法 id 一律跳过并报码', () => {
  const base = { id: ID, text: sessionText() };
  assert.equal(transcodeClaudeSession(base, { formatVersion: 2 }).skip?.code, 'session-format-unsupported');
  // 比本模块已实现的最高版本更高（未来格式）同样**如实跳过**，绝不按最高版本硬写
  assert.equal(transcodeClaudeSession(base, { formatVersion: 5 }).skip?.code, 'session-format-unsupported');
  assert.equal(transcodeClaudeSession({ ...base, id: 'a/b' }, { formatVersion: 3 }).skip?.code, 'session-unsafe-id');
  const noCwd = [line({ type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } })].join(NL);
  assert.equal(transcodeClaudeSession({ id: ID, text: noCwd }, { formatVersion: 3 }).skip?.code, 'session-missing-cwd');
  assert.equal(transcodeClaudeSession({ id: ID, text: '' }, { formatVersion: 3 }).skip?.code, 'session-empty');
});

test('t3 产物可被 DSH 自己的 codec 解码回逻辑事件（本机无 codec 则 skip）', async (t) => {
  const dirs = [
    process.env['DSH_SESSION_CODEC_DIR'],
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
  ].filter((d): d is string => typeof d === 'string' && d !== '');
  let codecMod: unknown;
  let formatMod: unknown;
  for (const dir of dirs) {
    try {
      codecMod = await import(pathToFileURL(path.join(dir, 'dsh-session-format-v2-to-v3', 'lib', 'index.js')).href);
      formatMod = await import(pathToFileURL(path.join(dir, 'dsh-session-format', 'lib', 'index.js')).href);
      break;
    } catch {
      codecMod = undefined;
    }
  }
  if (codecMod === undefined || formatMod === undefined) {
    t.skip('未找到 DSH 会话 codec（仅本机安装 DSH 时可用）');
    return;
  }
  const codec = (codecMod as Record<string, any>)['releasedV3SessionFormatCodec'];
  const Collector = (formatMod as Record<string, any>)['SessionFormatEventCollector'];
  const result = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3 });
  assert.ok(result.session);
  const shape = readSessionLogShapeFromBytes(result.session.data);
  assert.equal(shape.ok, true);
  if (!shape.ok) return;

  const header = codec.decodeHeader(shape.headerValue);
  assert.equal(header.id, ID);
  const collector = new Collector();
  const decoder = codec.createDecoder(shape.headerValue, collector);
  for (const row of shape.rows) decoder.decodeRow(row, collector);
  assert.equal(decoder.finish(collector), 0);
  const types = collector.values.map((e: Record<string, unknown>) => e['type']);
  assert.ok(types.includes('user/message'));
  assert.ok(types.includes('assistant/message'));
  assert.ok(types.includes('tool/call'));
  assert.ok(types.includes('tool/result'));
  assert.ok(types.includes('turn/end'));
});
/* ---------------- 会话保真（2026-10-18，task-4）---------------- */

/** 极简 JSONL 构造器（与文件顶部同形：一行一条 JSON） */
function jsonl(records: readonly Record<string, unknown>[]): string {
  return records.map((r) => line(r)).join(NL) + NL;
}

/** 稳定的消息 uuid（避免各用例手写一长串） */
function uuidOf(n: number): string {
  return 'aaaaaaaa-0000-4000-8000-' + String(n).padStart(12, '0');
}

/** 产物的 header（形态运用文件头的 readSessionLogShapeFromBytes：失败就断言失败，不伪装） */
function headerOf(bytes: Uint8Array): Record<string, unknown> {
  const shape = readSessionLogShapeFromBytes(bytes);
  assert.equal(shape.ok, true, '产物必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return {};
  return shape.headerValue as Record<string, unknown>;
}

/** 产物的逻辑事件行（null 行用空对象占位，方便后续断言） */
function rowsOf(bytes: Uint8Array): Record<string, unknown>[] {
  const shape = readSessionLogShapeFromBytes(bytes);
  assert.equal(shape.ok, true, '产物必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return [];
  return shape.rows.map((r) => (r === null ? {} : (r as Record<string, unknown>)));
}

/** 某条助手消息的 content 块（第一条） */
function assistantContentOf(bytes: Uint8Array): Record<string, unknown>[] {
  const assistant = rowsOf(bytes).find((r) => r['type'] === 'assistant/message');
  assert.ok(assistant !== undefined, '语料里应有助手消息');
  return (assistant?.['data'] as { message: { content: Record<string, unknown>[] } }).message.content;
}

const FIXED = 1_700_000_000_000;
const CREATED = Date.parse('2026-09-09T09:09:09.000Z');

test('保真 t4：isSidechain 记录不进 IR（子代理正文绝不混进父对话），整类计报 isSidechain', () => {
  const text = jsonl([
    { type: 'user', uuid: uuidOf(1), timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'parent question' } },
    { type: 'assistant', uuid: uuidOf(2), timestamp: '2026-10-01T10:00:01.000Z', cwd: CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: 'parent answer' }] } },
    { type: 'user', uuid: uuidOf(3), timestamp: '2026-10-01T10:00:02.000Z', cwd: CWD, isSidechain: true, message: { role: 'user', content: 'SIDECHAIN_DO_NOT_LEAK' } },
    { type: 'assistant', uuid: uuidOf(4), timestamp: '2026-10-01T10:00:03.000Z', cwd: CWD, isSidechain: true, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: 'SIDECHAIN_DO_NOT_LEAK' }] } },
  ]);
  const result = transcodeClaudeSession({ id: ID, text }, { formatVersion: 3, now: FIXED });
  assert.ok(result.session, '父对话本身必须照常转码');
  const s = result.session;
  assert.equal(s.info.records, 4, 'records 是源记录原始条数（含被忽略的）');
  assert.equal(s.info.userMessages, 1, '子代理记录不算父对话的用户消息');
  assert.equal(s.info.assistantMessages, 1);
  assert.equal(s.info.ignored['isSidechain'], 2, '子代理记录必须整类计报（下游 detail = isSidechain）');
  const rows = rowsOf(s.data);
  assert.equal(JSON.stringify(rows).includes('SIDECHAIN_DO_NOT_LEAK'), false, '子代理正文绝不得进产物');
  assert.equal(rows.filter((r) => r['type'] === 'user/message').length, 1, '只有父对话那一条用户消息');
  assert.equal(JSON.stringify(rows).includes('parent answer'), true, '父对话正文不受影响');
});

test('保真 t4：记录 sessionId 与文件名 stem 不一致 → findings 报 session-id-mismatch（id 仍用 stem）', () => {
  const base = { id: ID, text: sessionText() };
  const mismatch = transcodeClaudeSession({ ...base, recordSessionId: 'ffffffff-2222-4222-8222-222222222222' }, { formatVersion: 3, now: FIXED });
  assert.ok(mismatch.session, '不一致不是跳过理由：会话照样产出');
  assert.equal(mismatch.session.id, ID, '会话 id 仍以文件名 stem 为准（DSH 按目录/文件名定位）');
  assert.deepEqual(mismatch.findings, [{ code: 'session-id-mismatch', origin: ID }]);
  assert.deepEqual(transcodeClaudeSession({ ...base, recordSessionId: ID }, { formatVersion: 3, now: FIXED }).findings, [], '一致就不报');
  assert.deepEqual(transcodeClaudeSession(base, { formatVersion: 3, now: FIXED }).findings, [], '读盘层没给就不猜');
  assert.deepEqual(transcodeClaudeSession({ ...base, recordSessionId: '' }, { formatVersion: 3, now: FIXED }).findings, [], '空串视同没给');
  const skipped = transcodeClaudeSession({ id: 'a/b', text: sessionText(), recordSessionId: 'x' }, { formatVersion: 3, now: FIXED });
  assert.equal(skipped.skip?.code, 'session-unsafe-id');
  assert.equal(skipped.findings.length, 1, '不一致是文件级事实：跳过面也要带上 findings');
});

test('保真 t4：推理块计报 thinking 且不进正文；非 Claude 的 reasoning 形状保持既有口径', () => {
  const text = jsonl([
    { type: 'user', uuid: uuidOf(1), timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'q' } },
    { type: 'assistant', uuid: uuidOf(2), timestamp: '2026-10-01T10:00:01.000Z', cwd: CWD, message: { model: 'claude-sonnet-4', content: [
      { type: 'thinking', thinking: 'THINKING_DO_NOT_LEAK', signature: 'sig' },
      { type: 'text', text: 'answer' },
      { type: 'redacted_thinking', data: 'REDACTED_DO_NOT_LEAK' },
    ] } },
  ]);
  const result = transcodeClaudeSession({ id: ID, text }, { formatVersion: 3, now: FIXED });
  assert.ok(result.session);
  assert.equal(result.session.info.ignored['thinking'], 2, 'thinking / redacted_thinking 逐条计报');
  const rows = rowsOf(result.session.data);
  assert.equal(JSON.stringify(rows).includes('DO_NOT_LEAK'), false, '推理正文绝不得进产物');
  assert.deepEqual(
    assistantContentOf(result.session.data),
    [{ type: 'text', text: 'answer' }],
    '推理块既不进 IR、也不留空文本块（空块会污染串联后的正文换行）',
  );

  // 非 Claude 原生的 `{type:'reasoning', text:'…'}`（别的导出器的命名）刻意保持既有口径：
  // 它命中共享 IR “对象带 text 就算文本块”的兼底分支（该分支被逐字节回归钉住），
  // 所以本次计报口径**不含它**。谁要一并丢弃/计报，改 REASONING_BLOCK_TYPES 一个数组即可，
  // 并同步更新 claude-sessions-bytes.test.ts 的对应基线（该案 728 → 722 字节）。
  const legacy = transcodeClaudeSession({
    id: ID,
    text: jsonl([
      { type: 'user', uuid: uuidOf(1), timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'q' } },
      { type: 'assistant', uuid: uuidOf(2), timestamp: '2026-10-01T10:00:01.000Z', cwd: CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'c' }] } },
    ]),
  }, { formatVersion: 3, now: FIXED });
  assert.ok(legacy.session);
  assert.equal(legacy.session.info.ignored['thinking'], undefined, 'reasoning 形状不在本次计报口径内（见注释）');
  assert.deepEqual(assistantContentOf(legacy.session.data), [{ type: 'text', text: 'r' + NL + 'c' }], '既有文本兜底分支原样保留');
});

test('保真 t4：幂等 —— 同一来源两次转码逐字节相同（墙钟回落只有一个确定性来源）', () => {
  // ① 记录自带时间戳：确定性来自记录本身（**不注入 now**）
  const a = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3 });
  const b = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3 });
  assert.ok(a.session !== undefined && b.session !== undefined);
  assert.deepEqual(a.session.data, b.session.data, '同一输入两次转码必须逐字节相同（否则 DSH 侧“同内容 → Skip”永不成立）');
  assert.equal(a.session.info.counts['timestampsFallback'], 0);
  assert.equal(headerOf(a.session.data)['createdAt'], Date.parse('2026-10-01T10:00:00.000Z'), 'createdAt 取记录自身最早时间戳');

  // ② 记录没有时间戳：回落 input.createdAtMs（读盘层给的确定性值）
  const noTs = jsonl([
    { type: 'user', uuid: uuidOf(1), cwd: CWD, message: { role: 'user', content: 'q' } },
    { type: 'assistant', uuid: uuidOf(2), cwd: CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: 'a' }] } },
  ]);
  const c = transcodeClaudeSession({ id: ID, text: noTs, createdAtMs: CREATED }, { formatVersion: 3 });
  const d = transcodeClaudeSession({ id: ID, text: noTs, createdAtMs: CREATED }, { formatVersion: 3 });
  assert.ok(c.session !== undefined && d.session !== undefined);
  assert.deepEqual(c.session.data, d.session.data, 'createdAtMs 回落同样必须幂等');
  assert.equal(c.session.info.counts['timestampsFallback'], 0, '有确定性回落值就不应记 timestampsFallback');
  assert.equal(headerOf(c.session.data)['createdAt'], CREATED);
  // **全程只有一个墙钟来源**：所有事件的 time 都必须等于 createdAtMs
  // （旧实现 parse 与 synthesize 各调一次 Date.now()，两处可能落在不同毫秒）
  for (const row of rowsOf(c.session.data)) assert.equal(row['time'], CREATED);

  // ③ 两者都没有：只能墙钟回落，并如实记账
  const e = transcodeClaudeSession({ id: ID, text: noTs }, { formatVersion: 3 });
  assert.ok(e.session);
  assert.equal(e.session.info.counts['timestampsFallback'], 1, '没有确定性时间来源必须如实记账');
  // 非安全整数视同“没给”（DSH 对时间字段要求安全整数），绝不把坏值写进行里
  const f = transcodeClaudeSession({ id: ID, text: noTs, createdAtMs: Number.NaN }, { formatVersion: 3 });
  assert.ok(f.session);
  assert.equal(f.session.info.counts['timestampsFallback'], 1, '非法 createdAtMs 不得当成确定性值');
});
