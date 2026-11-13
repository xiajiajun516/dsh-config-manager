/**
 * Claude Code 会话转码的**逐字节**回归护栏。
 *
 * 为什么需要它：IR 拆分（解析 → 中间表示 → 合成字节）是纯内部重构，单元断言（事件类型序列、
 * 路径、header 字段）**不足以**证明产物未变 —— 帧边界（64 KiB 批次切分）、JSON 键序、
 * 毫秒时间戳、messageId 兜底序都只在**字节层**可见。这里对一份固定语料逐案取 sha256 快照。
 *
 * ── 快照口径（t23 如实修订；**勿改回旧说法**）────────────────────────────────
 * 本文件原先自称「快照值是在重构前用同一实现采集的」。**该口径无法验证，已废弃**：
 * 本仓不存在任何可信的「重构前」产物 ——
 *   · `src/foreign/` 整棵树都是**未跟踪**文件（git 无历史版本可回退）；
 *   · `lib/` 是 .gitignore 忽略的构建产物，且其 claude-sessions.js **本身就
 *     `import { … synthesizeDshRows … } from './session-ir.js'`** —— 它已是 IR 拆分之后的构建，
 *     不能当作重构前基线（这一点曾被人（含 t23 的修复者）误判为「重构前」，特此记明）；
 *   · 无 `.bak`、sourcemap 未内联源码、无残留采集脚本。
 * 因此本快照记录的是**当前实现的基线**（t23 实测值），**不再声称**与任何历史版本逐字节一致。
 *
 * 该护栏今后防的是**未来的无谓字节漂移**：任何改动若动了帧切分 / JSON 键序 / 毫秒时间戳 /
 * messageId 兜底序，都会在这里红 —— 这正是「纯重构不该改产物」这条纪律的执行面。
 * **从旧值变更本快照必须写明理由**：要么是同一次改动的有意产物（在提交说明里讲清楚），
 * 要么是回归（应当修实现，而不是改快照）。绝不为「让测试变绿」而静默更新快照。
 *
 * 语料刻意覆盖：帧边界跨批（>64 KiB）、畸形行、孤儿 tool_result、空消息、无 uuid 兜底、
 * 纯 title 会话、时间戳三态（ISO / 毫秒数 / 不可解析）、工具调用缺 id，
 * 以及 5 个 skip 面（unsupported-version / unsafe-id / missing-cwd / empty-file / all-unparsable）。
 * 断言只在 bytes 层：任何一案的产物哪怕差一个字节也会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { transcodeClaudeSession } from './claude-sessions.ts';
import type { ClaudeSessionFile, TranscodeOptions } from './claude-sessions.ts';

const FIXED_NOW = 1_700_000_000_000;
const CWD = 'D:/proj/app';
const ID = '11111111-1111-4111-8111-111111111111';

interface Case {
  readonly name: string;
  readonly file: ClaudeSessionFile;
  readonly options?: TranscodeOptions;
}

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 语料构造：一行一条 JSON（或故意给一段非 JSON 文本） */
function text(records: readonly (Record<string, unknown> | string)[]): string {
  return records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
}

function userRec(n: number, ts: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'aaaaaaaa-0000-4000-8000-' + String(n).padStart(12, '0'),
    timestamp: ts,
    cwd: CWD,
    message: { role: 'user', content },
    ...extra,
  };
}

function assistantRec(n: number, ts: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: 'bbbbbbbb-0000-4000-8000-' + String(n).padStart(12, '0'),
    timestamp: ts,
    cwd: CWD,
    message: { model: 'claude-sonnet-4', content },
    ...extra,
  };
}

/** 跨帧语料：> 64 KiB 的事件体，用来钉住 FRAME_TARGET_BYTES 的批次切分 */
function bigSession(): string {
  const recs: Record<string, unknown>[] = [];
  const pad = 'x'.repeat(400);
  for (let i = 0; i < 120; i++) {
    recs.push(userRec(i * 2 + 1, '2026-10-01T10:00:00.000Z', 'q' + i + ' ' + pad));
    recs.push(assistantRec(i * 2 + 2, '2026-10-01T10:00:01.000Z', [{ type: 'text', text: 'a' + i + ' ' + pad }]));
  }
  return text(recs);
}

const CORPUS: readonly Case[] = [
  {
    name: 'basic-with-malformed-line',
    file: {
      id: ID,
      text: text([
        userRec(1, '2026-10-01T10:00:00.000Z', '帮我看看这个 bug'),
        assistantRec(2, '2026-10-01T10:00:05.000Z', [
          { type: 'text', text: '我先看一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ], { message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, content: [{ type: 'text', text: '我先看一下' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }),
        userRec(3, '2026-10-01T10:00:06.000Z', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'entry1' }]),
        assistantRec(4, '2026-10-01T10:00:07.000Z', [{ type: 'text', text: '修好了' }]),
        { type: 'attachment', uuid: 'cccccccc-0000-4000-8000-000000000001', timestamp: '2026-10-01T10:00:08.000Z', cwd: CWD },
        '{ 这不是合法 JSON',
      ]),
    },
  },
  { name: 'frames-crossing-64k', file: { id: ID, text: bigSession() } },
  {
    name: 'orphan-empty-and-unknown',
    file: {
      id: ID,
      text: text([
        userRec(1, '2026-10-01T09:59:00.000Z', [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'no call' }]),
        assistantRec(2, '2026-10-01T09:59:01.000Z', []),
        userRec(3, '2026-10-01T09:59:02.000Z', '   '),
        { type: 'system', uuid: 'dddddddd-0000-4000-8000-000000000001', timestamp: '2026-10-01T09:59:03.000Z' },
        { type: 'queue-operation', timestamp: '2026-10-01T09:59:04.000Z' },
        { type: 'sidechain', timestamp: '2026-10-01T09:59:05.000Z' },
        userRec(4, '2026-10-01T09:59:06.000Z', 'hi'),
      ]),
    },
  },
  {
    name: 'title-only-no-events',
    file: {
      id: ID,
      text: text([
        { type: 'summary', summary: '  一段 摘要  ', cwd: CWD, timestamp: '2026-10-01T08:00:00.000Z' },
        { type: 'attachment', timestamp: '2026-10-01T08:00:01.000Z' },
      ]),
    },
  },
  {
    name: 'no-uuid-fallback-ids',
    file: {
      id: ID,
      text: text([
        { type: 'user', timestamp: '2026-10-01T07:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'first' } },
        { type: 'assistant', timestamp: '2026-10-01T07:00:01.000Z', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'user', timestamp: '2026-10-01T07:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'text', text: 'body' }, { type: 'image', source: 'x' }] }] } },
      ]),
    },
  },
  {
    name: 'timestamps-numeric-and-unparsable',
    file: {
      id: ID,
      text: text([
        userRec(1, '2026-10-01T06:00:00.000Z', 'iso', { timestamp: '2026-10-01T06:00:00.000Z' }),
        assistantRec(2, '2026-10-01T06:00:01.000Z', [{ type: 'text', text: 'a' }], { timestamp: 1_700_000_000_123 }),
        userRec(3, '2026-10-01T06:00:02.000Z', 'b', { timestamp: '不是时间' }),
        assistantRec(4, '2026-10-01T06:00:03.000Z', [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'c' }], { timestamp: Number.NaN }),
      ]),
    },
  },
  {
    name: 'unicode-and-max-id',
    file: {
      id: 'z'.repeat(128),
      text: text([
        userRec(1, '2026-10-01T05:00:00.000Z', '中文/emoji 🙂 与\t制表符 和 "引号" 与 \\\\反斜杠'),
        assistantRec(2, '2026-10-01T05:00:01.000Z', [{ type: 'text', text: '多行\n第二行\n第三行' }]),
      ]),
    },
  },
  { name: 'skip-unsupported-version', file: { id: ID, text: text([userRec(1, '2026-10-01T04:00:00.000Z', 'x')]) }, options: { formatVersion: 2 } },
  { name: 'skip-unsafe-id', file: { id: 'a/b', text: text([userRec(1, '2026-10-01T04:00:00.000Z', 'x')]) } },
  { name: 'skip-missing-cwd', file: { id: ID, text: text([{ type: 'user', uuid: 'e', message: { role: 'user', content: 'no cwd' } }]) } },
  { name: 'skip-empty-file', file: { id: ID, text: '' } },
  { name: 'skip-all-unparsable', file: { id: ID, text: 'not json\n{ still not }\n' } },
];

/**
 * **当前实现的字节基线**（键 = 用例名，值 = `'<字节数>:<sha256>'`；跳过面记 `'skip:<码>'`）。
 *
 * 采集方式：在 t23 修复时于本工作区直接跑语料、读取控制台打印的 `GOLDEN_ACTUAL` 并原样抄入。
 * 口径说明见**文件头**：这是「当前实现基线」，不声称与任何历史版本逐字节一致
 * （原「重构前快照」口径经查无法验证，已废弃）。
 *
 * 覆盖 = CORPUS 的 12 个用例：7 个真正钉住字节的用例 + `frames-crossing-64k`（跨帧切分控制项）
 * + 5 个 skip 面。**不得为了让它变绿而改写这里的数值** —— 那等于把护栏变成橡皮图章。
 */
const GOLDEN: Record<string, string> = {
  /**
   * 2026-10-07 有意更新（**理由**）：旧基线是**会被 DSH 拒读**的产物 —— 真机导入 Hermes
   * 会话时报 `session event at seq … message must have model source`。修 `synthesizeDshRows`
   * 的三处不合规形状（assistant `source.kind: 'assistant'` → `'model'`（provider/model 非空）；
   * assistant 行补 `stream: []` 与 content 里的 `tool-call` 块；tool/result 块改为
   * `tool-result`/`toolCallId`/`isError` 且 callId 非空）后，字节必然变化。
   * 复验：DSH 自己的 `adoptSessionEvent` 逐行校验 hermes 71 会话 / 29687 行 → 0 拒绝。
   *
   * 2026-10-08 有意更新（**理由**）：标题行按 DSH 的 `session/title` 硬规则重做（`assertTitleSources`：
   * `messageSeqs` 为空 **⟺** `source.kind === 'user'`，非空时每个 seq 必须**早于**本条且指向
   * `source.kind === 'user'` 的 `user/message`）。旧实现把标题停在 seq 0 且恒写 `messageSeqs: []`，
   * 于非 user 来源同时违反该规则：真 codec 的严格档两代都报 `messageSeqs must be empty exactly for
   * a user title`，且 **v3→v4 迁移直接拒收**（`finish-failed: … refuses the transformed artifact`）——
   * 后果是 v3 标记的产物在 v4 主机上整批读不出来。现在标题行插在首条人类 user/message 之后并引用它
   * （真机日志同形：`{"seq":12,"messageSeqs":[7],"source":{"kind":"fallback"}}`）。
   * **附带的行为变化**：`title-only-no-events` 从「只有标题行的会话」变成 `skip:session-empty` ——
   * 整场没有任何人类 user/message 时，非 user 来源的标题**无解**（引用不到任何人），宁可如实跳过，
   * 也不产出违反①的标题行。
   * 复验：修后同一批产物对**两代真 codec**逐条 `verifySessionLogBytes` → `verified/strong/equivalentToReadPath` 全 true
   * （v4 目标档用桌面端 app.asar 内的 catalog；v3 目标档用本机 CLI 档案树）。
   */
  'basic-with-malformed-line': '896:b2fa752b2b5d2a9f470a9c49cb40d6f0dfafe40d1ea3fd6e81afc62ac189759d',
  'frames-crossing-64k': '7518:d8be900e191b4a2c2c70819790bc0434bc8bffcbfbafbb00016b09bc04edaa8a',
  'orphan-empty-and-unknown': '339:7492bd869daacad62ee75688ad8816e23af259215a360d01de9917cdffadc727',
  'title-only-no-events': 'skip:session-empty',
  /**
   * 2026-11-14 有意更新（**理由**）：审计 P7-4 修掉了「tool_result 带未知 id 仍照发」的悬空引用。
   * 本案的 tool_use 没有 id → 合成器铸了 fallback callId，而结果的 tool_use_id 是 'toolu_x'，
   * 两者对不上：旧实现发出一条指向不存在 tool/call 的 tool/result（743 字节），
   * 现在按 orphan-tool-result 计数丢弃（666 字节，少一行 result 事件）。
   */
  'no-uuid-fallback-ids': '666:88cb76a5a087644466de41f7ace7d82e8e9a1595df271855c963d0688728112f',
  'timestamps-numeric-and-unparsable': '728:64308bcdea6fc439ed190dd56cad74354e9f53f1274821d97a57bc519f3505ce',
  'unicode-and-max-id': '729:a8a5abaca4dc7ab15c499b1c38655972283def0bedd3bb73bc87558e22ef51c7',
  'skip-unsupported-version': 'skip:session-format-unsupported',
  'skip-unsafe-id': 'skip:session-unsafe-id',
  'skip-missing-cwd': 'skip:session-missing-cwd',
  'skip-empty-file': 'skip:session-empty',
  'skip-all-unparsable': 'skip:session-empty',
};

test('字节回归：语料逐案与当前实现基线逐字一致', () => {
  const actual: Record<string, string> = {};
  for (const c of CORPUS) {
    const res = transcodeClaudeSession(c.file, c.options ?? { formatVersion: 3, now: FIXED_NOW });
    actual[c.name] = res.session === undefined
      ? 'skip:' + String(res.skip?.code)
      : res.session.data.length + ':' + sha256hex(res.session.data);
  }
  console.log('GOLDEN_ACTUAL=' + JSON.stringify(actual, null, 2));
  assert.deepEqual(actual, GOLDEN, '产物必须与当前实现基线逐字节一致（改了帧/键序/时间兜底都会在这里红）');
});
